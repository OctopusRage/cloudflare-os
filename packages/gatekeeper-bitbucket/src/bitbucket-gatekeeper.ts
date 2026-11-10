// The per-binding gatekeeper Durable Object: one instance per binding of a Bitbucket connection,
// to a repository or to one pull request in it. It pins the repository by the UUIDs Bitbucket
// never reassigns at the binding's first use — the link's `workspace/repo` slugs can be renamed,
// or a deleted repository's slug reused — and the user the connection belongs to. It mints the
// capabilities gadgets hold (bitbucket-sessions.ts), serves `gitPull` over smart-HTTP protocol v2
// through the kit's transport, and answers observer checks. Every Bitbucket request runs through
// the account's credential source.
//
// Phase 1 submits no actions: `applyAction` and `rejectAction` have nothing to resolve.

import { DurableObject, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUserVerifier, GitCache, GitOid, GitPullHints, GitPullTransfer,
  ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { KvTtlCache } from "@gadgets/gatekeeper-kit/cache";
import { startGitPull } from "@gadgets/gatekeeper-kit/git-pull-transfer";
import { observerAccessVerifier } from "@gadgets/gatekeeper-kit/observers";
import { BitbucketApi, seg } from "./bitbucket-api";
import {
  accountSource, accountStub, parseSubresource, subresourceId, type BitbucketVerifierApi, type Identity,
  type RepositoryKey,
} from "./bitbucket-credentials";
import { repositoryUrl, type BitbucketGatekeeperImplProps, type Env } from "./bitbucket-env";
import { pullRequestUrl, type WireRepository } from "./bitbucket-normalize";
import {
  BitbucketPullRequestImpl, BitbucketRepositoryImpl, SessionContext, type SessionHost,
} from "./bitbucket-sessions";
import type { BitbucketPullRequest, BitbucketRepository } from "./types";
import TYPES_CODE from "./types.txt";

/** How long the connected identity is trusted in memory before the account is asked again. */
const IDENTITY_MEMO_MS = 60 * 1000;
/** How long the repository's current name and main branch are reused. */
const REPOSITORY_TTL_MS = 60 * 1000;

const PINNED_KEY = "pinned";

/** The repository and user a binding is pinned to at its first use. */
type Pinned = RepositoryKey & { userUuid: string };

type BitbucketSession = BitbucketRepository | BitbucketPullRequest;

/** The repository's API path, by UUID. */
const basePath = (key: RepositoryKey): string => `/repositories/${seg(key.workspaceUuid)}/${seg(key.repoUuid)}`;

@validateRpc()
export class BitbucketGatekeeperImpl extends DurableObject<Env, BitbucketGatekeeperImplProps>
  implements Gatekeeper<BitbucketSession> {
  readonly #creds = accountSource(this.ctx.exports, this.ctx.props.userObjectId);
  readonly #cache = KvTtlCache.partitionedBy(this.ctx.storage.kv, this.#creds, { name: "bitbucket" });
  #identity?: { value: Identity; at: number };
  #repository?: { value: WireRepository; at: number };

  // Every read reports the pinned repository, and each observer's own connection answers for it.
  readonly #verifyAccess = observerAccessVerifier<BitbucketVerifierApi>({
    hasCollectionAccess: (verifier, ids) => verifier.checkSubresourceAccess([...ids]),
  });

  readonly #sessionHost: SessionHost = {
    repository: async () => {
      const pinned = await this.#pinned();
      return { wire: await this.#currentRepository(pinned), subresource: subresourceId(pinned) };
    },
    read: async op => {
      const pinned = await this.#pinned();
      return await this.#creds.run(creds => op(new BitbucketApi(creds.accessToken), basePath(pinned)), { replayable: true });
    },
    cached: (key, ttlMs, load) => this.#cache.cached(key, ttlMs, load),
  };

  async describe(): Promise<ResourceDescription> {
    const props = this.ctx.props;
    const fullName = `${props.workspace}/${props.repoSlug}`;
    // Descriptions are visible outside observation authorization, so they name the link only.
    return props.resourceKind === "repository"
      ? {
        url: repositoryUrl(fullName), title: fullName, snippet: "Bitbucket repository",
        suggestedBindingName: "BITBUCKET_REPO", tsType: "BitbucketRepository",
      }
      : {
        url: pullRequestUrl(fullName, props.pullRequestId), title: `${fullName} #${props.pullRequestId}`,
        snippet: "Bitbucket pull request", suggestedBindingName: "BITBUCKET_PR", tsType: "BitbucketPullRequest",
      };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<BitbucketSession> {
    // Refuses a binding whose connection or repository no longer matches before anything is read.
    await this.#pinned();
    const ctx = new SessionContext(this.#sessionHost, approvalQueue.dup());
    const props = this.ctx.props;
    return props.resourceKind === "repository"
      ? new BitbucketRepositoryImpl(ctx)
      : new BitbucketPullRequestImpl(ctx, props.pullRequestId);
  }

  /**
   * Serves the commits this gatekeeper advertised. The repository is addressed for git by its
   * current `workspace/repo` name, read again by UUID just before, so a rename is followed and a
   * reused slug is never fetched from.
   */
  async gitPull(oids: GitOid[], options: GitPullHints): Promise<GitPullTransfer> {
    const pinned = await this.#pinned();
    const fullName = (await this.#currentRepository(pinned, { fresh: true })).full_name;
    return await this.#creds.run(creds => startGitPull(
      body => new BitbucketApi(creds.accessToken).fetchGitUploadPack(fullName, body), oids, options));
  }

  async applyAction(_actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    throw new Error("The Bitbucket gatekeeper submits no actions yet.");
  }

  async rejectAction(_actionId: number): Promise<void> {}

  async revertAction(_actionId: number): Promise<{ message: string; canRetry: boolean }> {
    return { message: "Bitbucket changes can't be undone automatically.", canRetry: false };
  }

  /** A new gatekeeper: no read was ever made without reporting its subresources. */
  async getHistoricalSubresources(): Promise<string[]> {
    return [];
  }

  /**
   * Allows an observer only if their own connection can read the repository (see
   * `UserAccount.checkSubresourceAccess`). Fails the whole call for an ID naming any repository
   * but the pinned one, which no read through this binding reports.
   */
  async verifyObserverAccess(
      observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
      subresources: string[]): Promise<{ allowedObserverIds: string[] }> {
    const pinned = this.ctx.storage.kv.get<Pinned>(PINNED_KEY);
    if (pinned === undefined) throw new Error("This Bitbucket binding has not read anything yet.");
    for (const id of subresources) {
      const key = parseSubresource(id);
      if (key.workspaceUuid !== pinned.workspaceUuid || key.repoUuid !== pinned.repoUuid) {
        throw new Error("This subresource ID names another Bitbucket repository than this binding's.");
      }
    }
    return await this.#verifyAccess(observers, subresources);
  }

  /** Compatibility only: observers are authorized per read, in verifyObserverAccess(). */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  /** Compatibility only: there is no observer state to remove. */
  async removeObserver(_id: string): Promise<void> {}

  async #me(): Promise<Identity> {
    const now = Date.now();
    if (this.#identity && now - this.#identity.at < IDENTITY_MEMO_MS) return this.#identity.value;
    const identity = await accountStub(this.ctx.exports, this.ctx.props.userObjectId).getIdentity();
    this.#identity = { value: identity, at: now };
    return identity;
  }

  /**
   * The repository and user the binding is pinned to. At the first use, the link's slugs are
   * resolved to UUIDs as the connected user; after that the binding refuses to follow a
   * connection that now belongs to someone else.
   */
  async #pinned(): Promise<Pinned> {
    const me = await this.#me();
    const kv = this.ctx.storage.kv;
    const pinned = kv.get<Pinned>(PINNED_KEY);
    if (pinned !== undefined) {
      if (pinned.userUuid !== me.userUuid) {
        throw new Error("This binding was made for a different Bitbucket user than its connection now uses. " +
          "Remove it and bind the Bitbucket resource again.");
      }
      return pinned;
    }
    const { workspace, repoSlug } = this.ctx.props;
    const repo = await this.#creds.run(creds =>
      new BitbucketApi(creds.accessToken).find<WireRepository>(`/repositories/${seg(workspace)}/${seg(repoSlug)}`),
      { replayable: true });
    if (!repo) {
      throw new Error(`The Bitbucket repository ${workspace}/${repoSlug} does not exist, or this connection can't read it.`);
    }
    const fresh: Pinned = { workspaceUuid: repo.workspace.uuid, repoUuid: repo.uuid, userUuid: me.userUuid };
    kv.put<Pinned>(PINNED_KEY, fresh);
    this.#repository = { value: repo, at: Date.now() };
    return fresh;
  }

  /** The pinned repository as Bitbucket describes it now, by UUID. */
  async #currentRepository(pinned: RepositoryKey, options?: { fresh?: boolean }): Promise<WireRepository> {
    const now = Date.now();
    if (!options?.fresh && this.#repository && now - this.#repository.at < REPOSITORY_TTL_MS) {
      return this.#repository.value;
    }
    const repo = await this.#creds.run(creds =>
      new BitbucketApi(creds.accessToken).find<WireRepository>(basePath(pinned)), { replayable: true });
    if (!repo || repo.uuid !== pinned.repoUuid) {
      throw new Error("The pinned Bitbucket repository was deleted, or this connection can no longer read it.");
    }
    this.#repository = { value: repo, at: now };
    return repo;
  }
}
