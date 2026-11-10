// The Bitbucket resource configurators' capability: what the browser frame searches to fill in a
// repository or pull request. Nothing here is an agent observation: these reads serve the
// owner's own picker, as the owner's own connection.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { CredentialSource } from "@gadgets/gatekeeper-kit/credentials";
import { BitbucketApi, isNotFound, seg } from "./bitbucket-api";
import type { PublicGrant } from "./bitbucket-credentials";
import { parseResourceUrl } from "./bitbucket-env";
import type { WirePullRequest, WireRepository } from "./bitbucket-normalize";
import type { BitbucketConfiguratorRpc, ConfiguratorOption } from "./configurator/bitbucket-configurator-types";

const OPTION_LIMIT = 30;
const MAX_QUERY_LENGTH = 200;
const MAX_WORKSPACES = 10;
const FULL_NAME = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

/** BBQL string literal: quotes and backslashes escaped. */
const literal = (value: string): string => `"${value.replace(/[\\"]/g, ch => `\\${ch}`)}"`;

function repositoryOption(repo: WireRepository): ConfiguratorOption {
  return {
    value: repo.full_name,
    title: repo.full_name,
    ...(repo.description ? { subtitle: repo.description } : {}),
    meta: repo.is_private ? "private" : "public",
  };
}

function pullRequestOption(pr: WirePullRequest): ConfiguratorOption {
  return {
    value: String(pr.id),
    title: `#${pr.id} ${pr.title}`,
    subtitle: `${pr.source.branch.name} → ${pr.destination.branch.name}`,
    meta: pr.state.toLowerCase(),
  };
}

/** The `workspace/repo` a query names exactly (a link or a full name), or null for a search term. */
function exactFullName(query: string): [string, string] | null {
  const trimmed = query.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const link = parseResourceUrl(trimmed);
    return link ? [link.workspace, link.repoSlug] : null;
  }
  const match = FULL_NAME.exec(trimmed.replace(/\.git$/, ""));
  return match ? [match[1]!, match[2]!] : null;
}

@validateRpc()
export class BitbucketConfiguratorUI extends RpcTarget implements BitbucketConfiguratorRpc {
  readonly #creds: CredentialSource<PublicGrant>;

  constructor(creds: CredentialSource<PublicGrant>) {
    super();
    this.#creds = creds;
  }

  #read<T>(op: (api: BitbucketApi) => Promise<T>): Promise<T> {
    return this.#creds.run(creds => op(new BitbucketApi(creds.accessToken)), { replayable: true });
  }

  async listRepositories(query: string): Promise<ConfiguratorOption[]> {
    if (query.length > MAX_QUERY_LENGTH) throw new Error("That search is too long.");
    const exact = exactFullName(query);
    if (exact) {
      const repo = await this.#read(api => api.find<WireRepository>(`/repositories/${seg(exact[0])}/${seg(exact[1])}`));
      return repo ? [repositoryOption(repo)] : [];
    }
    return await this.#read(async api => {
      const { values: access } = await api.page<{ workspace: { slug: string } }>(
        "/user/workspaces", { pagelen: MAX_WORKSPACES });
      const term = query.trim();
      const pages = await Promise.all(access.map(({ workspace }) =>
        api.page<WireRepository>(`/repositories/${seg(workspace.slug)}`, {
          pagelen: OPTION_LIMIT,
          sort: "-updated_on",
          ...(term ? { q: `name ~ ${literal(term)}` } : {}),
        }).catch(error => {
          // A workspace the user lost access to since listing is skipped, not fatal.
          if (isNotFound(error)) return { values: [] as WireRepository[] };
          throw error;
        })));
      return pages.flatMap(page => page.values)
        .sort((a, b) => b.updated_on.localeCompare(a.updated_on))
        .slice(0, OPTION_LIMIT)
        .map(repositoryOption);
    });
  }

  async listPullRequests(fullName: string, query: string): Promise<ConfiguratorOption[]> {
    const match = FULL_NAME.exec(fullName);
    if (!match) return [];
    if (query.length > MAX_QUERY_LENGTH) throw new Error("That search is too long.");
    const path = `/repositories/${seg(match[1]!)}/${seg(match[2]!)}/pullrequests`;
    const term = query.trim().replace(/^#/, "");
    return await this.#read(async api => {
      if (/^\d+$/.test(term)) {
        const pr = await api.find<WirePullRequest>(`${path}/${term}`);
        return pr ? [pullRequestOption(pr)] : [];
      }
      const { values } = await api.page<WirePullRequest>(path, {
        pagelen: OPTION_LIMIT,
        state: ["OPEN", "MERGED", "DECLINED"],
        ...(term ? { q: `title ~ ${literal(term)}` } : {}),
      });
      return values.map(pullRequestOption);
    });
  }
}
