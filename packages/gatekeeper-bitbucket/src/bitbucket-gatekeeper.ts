// The per-binding gatekeeper Durable Object: one instance per binding of a Bitbucket connection,
// to a repository or to one pull request in it. It pins the repository by the UUIDs Bitbucket
// never reassigns at the binding's first use — the link's `workspace/repo` slugs can be renamed,
// or a deleted repository's slug reused — and the user the connection belongs to. It mints the
// capabilities gadgets hold (bitbucket-sessions.ts), serves `gitPull` over smart-HTTP protocol v2
// through the kit's transport, and answers observer checks. Every Bitbucket request runs through
// the account's credential source.
//
// Writes are staged in this object's action journal and applied once approved (see
// bitbucket-actions.ts). Whether a push targets a gated branch is read live here, both when the
// push is submitted and again when an auto-approvable one is applied.

import { DurableObject, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUserVerifier, GitCache, GitOid, GitPullHints, GitPullTransfer,
  ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import { KvTtlCache } from "@gadgets/gatekeeper-kit/cache";
import { ZERO_OID } from "@gadgets/gatekeeper-kit/git-transport";
import { startGitPull } from "@gadgets/gatekeeper-kit/git-pull-transfer";
import { observerAccessVerifier } from "@gadgets/gatekeeper-kit/observers";
import {
  actions, BINDING_TAGS, type BitbucketAction, type BitbucketActionHost, type BitbucketActions, type PushPayload,
} from "./bitbucket-actions";
import { BitbucketApi, BitbucketApiError, seg } from "./bitbucket-api";
import {
  accountSource, accountStub, parseSubresource, subresourceId, type BitbucketVerifierApi, type Identity,
  type RepositoryKey,
} from "./bitbucket-credentials";
import { VENDOR_ID, repositoryUrl, type BitbucketGatekeeperImplProps, type Env } from "./bitbucket-env";
import { pullRequestUrl, type WireRepository } from "./bitbucket-normalize";
import {
  BitbucketPullRequestImpl, BitbucketRepositoryImpl, SessionContext, type SessionHost,
} from "./bitbucket-sessions";
import type { BitbucketPullRequest, BitbucketRepository } from "./types";
import { obsContext } from "./observability";
import TYPES_CODE from "./types.txt";

const logger = obsContext.createLogger({ component: "gatekeeper.bitbucket.gatekeeper", vendorId: VENDOR_ID });

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

/** How many pages of branch restrictions are read before a branch is taken as restricted. */
const MAX_RESTRICTION_PAGES = 5;

/** One branch restriction, as `GET …/branch-restrictions` lists it. */
type WireRestriction = {
  kind: string;
  branch_match_kind?: "glob" | "branching_model";
  pattern?: string;
  branch_type?: string;
};

/** The repository's branching model, as `GET …/branching-model` reads it. */
type WireBranchingModel = {
  development?: { branch?: { name?: string } | null } | null;
  production?: { branch?: { name?: string } | null } | null;
  branch_types?: { kind: string; prefix: string }[];
};

/** Whether a Bitbucket branch glob (`*` any run of characters) matches `branch`. */
function globMatches(pattern: string, branch: string): boolean {
  const source = pattern.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`).test(branch);
}

/** The branching-model type of `branch` (`production`, `development`, `feature`, ...), if any. */
function branchTypeOf(model: WireBranchingModel, branch: string): string | undefined {
  if (model.production?.branch?.name === branch) return "production";
  if (model.development?.branch?.name === branch) return "development";
  return model.branch_types?.find(type => branch.startsWith(type.prefix))?.kind;
}

@validateRpc()
export class BitbucketGatekeeperImpl extends DurableObject<Env, BitbucketGatekeeperImplProps>
  implements Gatekeeper<BitbucketSession> {
  readonly #creds = accountSource(this.ctx.exports, this.ctx.props.userObjectId);
  readonly #cache = KvTtlCache.partitionedBy(this.ctx.storage.kv, this.#creds, { name: "bitbucket" });
  readonly #journal = new ActionJournal<BitbucketAction>(this.ctx.storage.kv, { namespace: "bitbucket" });
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
      return await this.#creds.run(creds => op(new BitbucketApi(creds), basePath(pinned)), { replayable: true });
    },
    cached: (key, ttlMs, load) => this.#cache.cached(key, ttlMs, load),
    submit: async (queue, kind, payload) =>
      // Fenced on the user the binding is pinned to (see bitbucket-actions.ts).
      await this.#actions.submit(queue, kind, payload, { fence: { generation: (await this.#pinned()).userUuid } }),
    preparePush: (branch, commitId, force, gitCache) => this.#preparePush(branch, commitId, force, gitCache),
  };

  // What apply handlers may do. A plain object, not this class: its stub is the overseer's.
  readonly #actionHost: BitbucketActionHost = {
    write: async op => {
      const pinned = await this.#pinned();
      const { full_name } = await this.#currentRepository(pinned);
      return await this.#creds.run(creds => op(new BitbucketApi(creds), basePath(pinned), full_name));
    },
    branchHead: branch => this.#branchHead(branch),
    isProtectedBranch: branch => this.#isProtectedBranch(branch),
    fullName: () => this.#repository?.value.full_name ?? `${this.ctx.props.workspace}/${this.ctx.props.repoSlug}`,
  };

  readonly #actions = actions.bind(this.#journal, this.#actionHost);

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
    const tags = BINDING_TAGS[this.ctx.props.resourceKind];
    return this.#actions.autoApprovableKinds().filter(kind => tags.has(kind.tag));
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
      body => new BitbucketApi(creds).fetchGitUploadPack(fullName, body), oids, options));
  }

  async applyAction(actionId: number, cache: RpcStub<GitCache>): Promise<void> {
    // Fenced on the user the binding is pinned to, as each action was submitted.
    const { userUuid } = await this.#pinned();
    try {
      await this.#actions.apply(actionId, { gitCache: cache, generation: userUuid });
    } finally {
      this.#repository = undefined;
    }
  }

  async rejectAction(actionId: number): Promise<void> {
    await this.#actions.reject(actionId);
  }

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
      new BitbucketApi(creds).find<WireRepository>(`/repositories/${seg(workspace)}/${seg(repoSlug)}`),
      { replayable: true });
    if (!repo) {
      throw new Error(`The Bitbucket repository ${workspace}/${repoSlug} does not exist, or this connection can't read it.`);
    }
    const fresh: Pinned = { workspaceUuid: repo.workspace.uuid, repoUuid: repo.uuid, userUuid: me.userUuid };
    kv.put<Pinned>(PINNED_KEY, fresh);
    this.#repository = { value: repo, at: Date.now() };
    return fresh;
  }

  /**
   * Checks a push and picks the definition it is submitted through, or null when the branch is
   * already at `commitId`. Without `force`, the branch's current head must be an ancestor of
   * `commitId` over the locally cached history.
   */
  async #preparePush(branch: string, commitId: string, force: boolean, gitCache: RpcStub<GitCache>):
      Promise<{ kind: keyof BitbucketActions; payload: PushPayload } | null> {
    const head = await this.#branchHead(branch);
    if (head === commitId) return null;
    const expectedOldSha = head ?? ZERO_OID;
    if (!force && head !== null) {
      let fastForward: boolean;
      try {
        fastForward = await gitCache.isAncestor(head, commitId);
      } catch (error) {
        throw new Error(`Commit ${commitId} is not in the workspace's git cache. Push a commit made in a worktree ` +
          "mounted from this repository.", { cause: error });
      }
      if (!fastForward) {
        throw new Error(`Cannot push to branch "${branch}": its current head ${head} is not an ancestor of ` +
          `${commitId}, so this push is not a fast-forward -- the branch has moved past the head this work was ` +
          "based on. Mount the branch's new head and redo the change on it, or pass force: true to overwrite the branch.");
      }
    }
    // A gate that could not be read holds the push for a person.
    const gated = await this.#isProtectedBranch(branch) ?? true;
    const kind = force ? (gated ? "forcePushProtected" : "forcePush") : (gated ? "pushProtected" : "push");
    return { kind, payload: { branch, expectedOldSha, newSha: commitId, force } };
  }

  /** The branch's head commit now, or null when Bitbucket has no such branch. */
  async #branchHead(branch: string): Promise<string | null> {
    const pinned = await this.#pinned();
    // Listed by an exact-name query: a branch name with a slash can't be a path segment here.
    const page = await this.#creds.run(creds => new BitbucketApi(creds).page<{ name: string; target: { hash: string } }>(
      `${basePath(pinned)}/refs/branches`, { q: `name = "${branch.replace(/[\\"]/g, ch => `\\${ch}`)}"`, pagelen: 1 }),
      { replayable: true });
    return page.values.find(ref => ref.name === branch)?.target.hash ?? null;
  }

  /**
   * Whether `branch` is the repository's main branch or covered by a branch restriction, read
   * live; undefined when that could not be read. Bitbucket lists restrictions only to repository
   * admins: one refusing this user counts as no restriction covering it, since Bitbucket enforces
   * its restrictions on the push itself.
   */
  async #isProtectedBranch(branch: string): Promise<boolean | undefined> {
    try {
      const pinned = await this.#pinned();
      const repo = await this.#currentRepository(pinned, { fresh: true });
      if (!repo.mainbranch?.name || repo.mainbranch.name === branch) return true;
      return await this.#creds.run(async creds => {
        const api = new BitbucketApi(creds);
        const base = basePath(pinned);
        const restrictions: WireRestriction[] = [];
        let next: string | undefined;
        for (let read = 0; ; read++) {
          if (read === MAX_RESTRICTION_PAGES) return true;
          let page;
          try {
            page = await api.page<WireRestriction>(`${base}/branch-restrictions`, { pagelen: 100 }, next);
          } catch (error) {
            if (error instanceof BitbucketApiError && error.status === 403) return false;
            throw error;
          }
          restrictions.push(...page.values);
          if (!page.next) break;
          next = page.next;
        }
        if (restrictions.some(r => r.branch_match_kind !== "branching_model" && r.pattern && globMatches(r.pattern, branch))) {
          return true;
        }
        if (!restrictions.some(r => r.branch_match_kind === "branching_model")) return false;
        const model = await api.get<WireBranchingModel>(`${base}/branching-model`);
        const type = branchTypeOf(model, branch);
        return type !== undefined && restrictions.some(r => r.branch_match_kind === "branching_model" && r.branch_type === type);
      }, { replayable: true });
    } catch (error) {
      logger.warn("failed to read whether a branch is restricted", { event: "bitbucket.branch.protection.read.failed", error });
      return undefined;
    }
  }

  /** The pinned repository as Bitbucket describes it now, by UUID. */
  async #currentRepository(pinned: RepositoryKey, options?: { fresh?: boolean }): Promise<WireRepository> {
    const now = Date.now();
    if (!options?.fresh && this.#repository && now - this.#repository.at < REPOSITORY_TTL_MS) {
      return this.#repository.value;
    }
    const repo = await this.#creds.run(creds =>
      new BitbucketApi(creds).find<WireRepository>(basePath(pinned)), { replayable: true });
    if (!repo || repo.uuid !== pinned.repoUuid) {
      throw new Error("The pinned Bitbucket repository was deleted, or this connection can no longer read it.");
    }
    this.#repository = { value: repo, at: now };
    return repo;
  }
}
