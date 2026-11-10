// The repository and pull request capabilities gadgets hold. Every read authorizes its
// observation, reporting the one repository it depends on, before anything it read is returned;
// listings authorize each page. Commit ids a read returns are advertised to the workspace git
// cache, so the overseer knows this gatekeeper can pull them (see `Gatekeeper.gitPull`).
//
// Every write is checked here, then submitted for the user's approval and made only once
// approved (see bitbucket-actions.ts). None is simulated: the agent waits for the decision.

import { RpcTarget, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ApprovalQueue, GitCache } from "@gadgets/workshop-shared/gatekeeper";
import { TokenCursor, SessionGitCache } from "@gadgets/gatekeeper-kit/cursors";
import { commitIdsOfSummary, isCommitOid } from "@gadgets/gatekeeper-kit/git-objects";
import { validateBranchName } from "@gadgets/gatekeeper-kit/git-transport";
import { MAX_BODY_LENGTH, type BitbucketActions, type PushPayload } from "./bitbucket-actions";
import type { ObservationInput } from "@gadgets/gatekeeper-kit/observers";
import { BitbucketApi, seg, type Page } from "./bitbucket-api";
import {
  splitDiff, toBranch, toComment, toCommit, toDiffFile, toPullRequestDetails, toPullRequestSummary,
  toRepositoryMetadata, toStatus, toTag, type WireComment, type WireCommit, type WireDiffStat,
  type WirePullRequest, type WireRef, type WireRepository, type WireStatus,
} from "./bitbucket-normalize";
import type {
  BitbucketBranchFilter, BitbucketBranchSummary, BitbucketComment, BitbucketCommitDetails, BitbucketCommitFilter,
  BitbucketCommitSummary, BitbucketCreatePullRequestOptions, BitbucketDiffFile, BitbucketMergeOptions,
  BitbucketPageOptions, BitbucketPullRequest, BitbucketPullRequestDetails, BitbucketPullRequestFilter,
  BitbucketPullRequestState, BitbucketPullRequestSummary, BitbucketRepository, BitbucketRepositoryMetadata,
  BitbucketTagSummary, Cursor,
} from "./types";

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;
/** Bitbucket's largest `pagelen` for most listings. */
const REMOTE_PAGE_SIZE = 50;
/** How long a listing page or commit read is reused within a connection. */
const LIST_CACHE_TTL_MS = 30_000;
const PR_STATES: readonly BitbucketPullRequestState[] = ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"];
const MAX_TITLE_LENGTH = 255;
const MERGE_STRATEGIES = ["merge_commit", "squash", "fast_forward"] as const;
const ACCOUNT_ID = /^[A-Za-z0-9:_-]{1,128}$/;

/** What the gatekeeper Durable Object lends its sessions. */
export type SessionHost = {
  /** The pinned repository as Bitbucket describes it now, and its subresource ID. */
  repository(): Promise<{ wire: WireRepository; subresource: string }>;
  /** Runs a read as the connection; `base` is the repository's API path, addressed by UUID. */
  read<T>(op: (api: BitbucketApi, base: string) => Promise<T>): Promise<T>;
  /** A read cache partitioned by connection. */
  cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T>;
  /** Submits an action for approval, fenced on the binding's pinned user. */
  submit<K extends keyof BitbucketActions>(queue: RpcStub<ApprovalQueue>, kind: K, payload: BitbucketActions[K]):
    Promise<number>;
  /** Checks a push and picks its definition; null when the branch is already at the commit. */
  preparePush(branch: string, commitId: string, force: boolean, gitCache: RpcStub<GitCache>):
    Promise<{ kind: keyof BitbucketActions; payload: PushPayload } | null>;
};

/** A non-empty text argument within `max` characters. */
function text(value: unknown, what: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${what} must be a non-empty string.`);
  if (value.length > max) throw new Error(`${what} is longer than ${max} characters.`);
  return value;
}

/** One session's borrowed approval queue, git cache and host. */
export class SessionContext implements Disposable {
  readonly git: SessionGitCache;

  constructor(readonly host: SessionHost, readonly queue: RpcStub<ApprovalQueue>) {
    this.git = new SessionGitCache(queue);
  }

  /** Authorizes a read, reporting the repository. Every read goes through here. */
  async authorize(observation: ObservationInput): Promise<void> {
    const { subresource } = await this.host.repository();
    await this.queue.authorizeObservation({ ...observation, subresources: [subresource] });
  }

  /**
   * A cursor over a Bitbucket listing: pages fetched lazily, each authorized before it is
   * returned, and — when `commitIds` is given — its commit ids advertised.
   */
  async listing<W, T>(options: {
    title: string;
    noun: string;
    pageSize: number;
    path: (base: string) => string;
    query: Record<string, string | number | readonly string[] | undefined>;
    map: (wire: W, fullName: string) => T;
    commitIds?: (item: T) => readonly string[];
    cacheKey: string;
  }): Promise<Cursor<T>> {
    const { wire: repo, subresource } = await this.host.repository();
    const walk = this.queue.dup();
    const cursor = new TokenCursor<T>({
      pageSize: options.pageSize,
      remotePageSize: REMOTE_PAGE_SIZE,
      dispose: () => walk[Symbol.dispose](),
      fetchPage: async (token, perPage) => {
        const page = await this.host.cached(`${options.cacheKey}|${perPage}|${token ?? ""}`, LIST_CACHE_TTL_MS,
          () => this.host.read<Page<W>>(
            (api, base) => api.page<W>(options.path(base), { ...options.query, pagelen: perPage }, token)));
        return { items: page.values.map(wire => options.map(wire, repo.full_name)), nextToken: page.next };
      },
      authorizePage: (items, { terminal }) => walk.authorizeObservation({
        title: `${options.title} in ${repo.full_name}`,
        description: items.length > 0
          ? `Read ${items.length} ${options.noun}`
          : terminal ? `Listed ${options.noun}; there were none` : `Scanned ${options.noun}; none matched`,
        subresources: [subresource],
      }),
    });
    return options.commitIds ? await this.git.wrap(cursor, options.commitIds) : cursor;
  }

  [Symbol.dispose](): void {
    this.git.dispose();
    this.queue[Symbol.dispose]();
  }
}

/** A listing's page size, checked. */
function pageSizeOf(options: BitbucketPageOptions | undefined): number {
  const size = options?.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
    throw new Error(`pageSize must be a whole number from 1 to ${MAX_PAGE_SIZE}.`);
  }
  return size;
}

/** BBQL string literal: quotes and backslashes escaped. */
const literal = (value: string): string => `"${value.replace(/[\\"]/g, ch => `\\${ch}`)}"`;

/** An agent-supplied ref: a branch, tag or commit id. Refuses what no git ref can be. */
function refOf(ref: string): string {
  if (ref.length === 0 || ref.length > 255 || /[\x00-\x20~^:?*[\\]|\.\.|@\{/.test(ref)) {
    throw new Error(`"${ref}" is not a valid branch, tag or commit id.`);
  }
  return ref;
}

/**
 * The commit `ref` names. Bitbucket's single-commit endpoint can't take a branch name with a
 * slash, so the ref's history listing is asked for its first entry instead.
 */
async function commitAt(api: BitbucketApi, base: string, ref: string): Promise<WireCommit | null> {
  const found = await api.find<{ values?: WireCommit[] }>(`${base}/commits/${seg(ref)}`, { pagelen: 1 });
  return found?.values?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// Repository

@validateRpc()
export class BitbucketRepositoryImpl extends RpcTarget implements BitbucketRepository {
  constructor(private readonly ctx: SessionContext) {
    super();
  }

  async getMetadata(): Promise<BitbucketRepositoryMetadata> {
    const { wire } = await this.ctx.host.repository();
    await this.ctx.authorize({ title: `Read ${wire.full_name}`, description: "Read the repository's metadata." });
    return toRepositoryMetadata(wire);
  }

  async listBranches(options?: BitbucketBranchFilter): Promise<Cursor<BitbucketBranchSummary>> {
    const pageSize = pageSizeOf(options);
    const search = options?.search?.trim();
    const { wire } = await this.ctx.host.repository();
    const main = wire.mainbranch?.name ?? "";
    return await this.ctx.listing<WireRef, BitbucketBranchSummary>({
      title: "Branches", noun: "branches", pageSize,
      path: base => `${base}/refs/branches`,
      query: { sort: "-target.date", ...(search ? { q: `name ~ ${literal(search)}` } : {}) },
      map: ref => toBranch(ref, main),
      commitIds: branch => [branch.headCommit],
      cacheKey: `branches|${search ?? ""}`,
    });
  }

  async listTags(options?: BitbucketPageOptions): Promise<Cursor<BitbucketTagSummary>> {
    return await this.ctx.listing<WireRef, BitbucketTagSummary>({
      title: "Tags", noun: "tags", pageSize: pageSizeOf(options),
      path: base => `${base}/refs/tags`,
      query: { sort: "-target.date" },
      map: toTag,
      commitIds: tag => [tag.commit],
      cacheKey: "tags",
    });
  }

  /** The commit `ref` (default: the main branch) names, or a clear error. */
  async #commit(ref: string | undefined): Promise<{ wire: WireCommit; fullName: string; ref: string }> {
    const { wire: repo } = await this.ctx.host.repository();
    const target = ref === undefined ? repo.mainbranch?.name ?? "main" : refOf(ref);
    const wire = await this.ctx.host.read((api, base) => commitAt(api, base, target));
    if (!wire) {
      await this.ctx.authorize({ title: `Look up "${target}" in ${repo.full_name}`, description: "No such commit, branch or tag." });
      throw new Error(`No commit found for ref "${target}".`);
    }
    return { wire, fullName: repo.full_name, ref: target };
  }

  async resolveRef(ref?: string): Promise<string> {
    const { wire, fullName, ref: target } = await this.#commit(ref);
    await this.ctx.authorize({ title: `Resolve "${target}" in ${fullName}`, description: `Resolved to ${wire.hash}.` });
    await this.ctx.git.advertise([wire.hash]);
    return wire.hash;
  }

  async getCommit(ref?: string): Promise<BitbucketCommitDetails> {
    const { wire, fullName, ref: target } = await this.#commit(ref);
    const statuses = await this.ctx.host.read((api, base) =>
      api.page<WireStatus>(`${base}/commit/${wire.hash}/statuses`, { pagelen: 50, sort: "-updated_on" }));
    const commit = toCommit(fullName, wire);
    await this.ctx.authorize({
      title: `Read commit ${wire.hash.slice(0, 12)} in ${fullName}`,
      description: `Read "${target}" and its ${statuses.values.length} build statuses.`,
    });
    await this.ctx.git.advertise(commitIdsOfSummary(commit));
    return { ...commit, statuses: statuses.values.map(toStatus) };
  }

  async listCommits(options?: BitbucketCommitFilter): Promise<Cursor<BitbucketCommitSummary>> {
    const pageSize = pageSizeOf(options);
    const { wire: repo } = await this.ctx.host.repository();
    const ref = options?.ref === undefined ? repo.mainbranch?.name ?? "main" : refOf(options.ref);
    const path = options?.path;
    return await this.ctx.listing<WireCommit, BitbucketCommitSummary>({
      title: `Commits on ${ref}`, noun: "commits", pageSize,
      path: base => `${base}/commits/${seg(ref)}`,
      query: { ...(path ? { path } : {}) },
      map: (wire, fullName) => toCommit(fullName, wire),
      commitIds: commitIdsOfSummary,
      cacheKey: `commits|${ref}|${path ?? ""}`,
    });
  }

  async push(branch: string, commitId: string, options?: { force?: boolean }): Promise<void> {
    validateBranchName(branch);
    if (!isCommitOid(commitId)) {
      throw new Error(`push() requires a full 40-character commit id; got ${JSON.stringify(commitId)}. ` +
        "Use resolveRef() to resolve a truncated id.");
    }
    const prepared = await this.ctx.host.preparePush(branch, commitId, options?.force === true, await this.ctx.git.stub());
    if (prepared === null) return;  // the branch is already at commitId
    await this.ctx.host.submit(this.ctx.queue, prepared.kind, prepared.payload);
  }

  async createPullRequest(options: BitbucketCreatePullRequestOptions): Promise<void> {
    const title = text(options?.title, "title", MAX_TITLE_LENGTH);
    const sourceBranch = validateBranchName(options.sourceBranch);
    const destinationBranch = options.destinationBranch === undefined ? undefined
      : validateBranchName(options.destinationBranch);
    if (destinationBranch === sourceBranch) throw new Error("The source and destination branches are the same.");
    const description = options.descriptionMarkdown === undefined ? undefined
      : text(options.descriptionMarkdown, "descriptionMarkdown", MAX_BODY_LENGTH);
    const reviewers = options.reviewerAccountIds ?? [];
    if (!Array.isArray(reviewers) || reviewers.length > 20 || reviewers.some(id => typeof id !== "string" || !ACCOUNT_ID.test(id))) {
      throw new Error("reviewerAccountIds must be up to 20 Bitbucket account ids.");
    }
    await this.ctx.host.submit(this.ctx.queue, "createPullRequest", {
      title, sourceBranch,
      ...(destinationBranch !== undefined ? { destinationBranch } : {}),
      ...(description !== undefined ? { description } : {}),
      closeSourceBranch: options.closeSourceBranch === true,
      reviewerAccountIds: [...reviewers],
    });
  }

  async getPullRequest(id: string): Promise<BitbucketPullRequest> {
    if (!/^\d+$/.test(id)) throw new Error(`"${id}" is not a pull request number.`);
    return new BitbucketPullRequestImpl(new SessionContext(this.ctx.host, this.ctx.queue.dup()), Number(id));
  }

  async listPullRequests(options?: BitbucketPullRequestFilter): Promise<Cursor<BitbucketPullRequestSummary>> {
    const pageSize = pageSizeOf(options);
    const states = options?.state ?? ["OPEN"];
    for (const state of states) if (!PR_STATES.includes(state)) throw new Error(`Unknown pull request state "${state}".`);
    const clauses = [
      ...(options?.search ? [`title ~ ${literal(options.search)}`] : []),
      ...(options?.sourceBranch ? [`source.branch.name = ${literal(options.sourceBranch)}`] : []),
    ];
    return await this.ctx.listing<WirePullRequest, BitbucketPullRequestSummary>({
      title: "Pull requests", noun: "pull requests", pageSize,
      path: base => `${base}/pullrequests`,
      query: { state: states, sort: "-created_on", ...(clauses.length ? { q: clauses.join(" AND ") } : {}) },
      map: (wire, fullName) => toPullRequestSummary(fullName, wire),
      cacheKey: `prs|${states.join(",")}|${clauses.join("|")}`,
    });
  }

  [Symbol.dispose](): void {
    this.ctx[Symbol.dispose]();
  }
}

// ---------------------------------------------------------------------------
// Pull request

@validateRpc()
export class BitbucketPullRequestImpl extends RpcTarget implements BitbucketPullRequest {
  constructor(private readonly ctx: SessionContext, private readonly id: number) {
    super();
  }

  async #wire(): Promise<WirePullRequest> {
    const pr = await this.ctx.host.read((api, base) => api.find<WirePullRequest>(`${base}/pullrequests/${this.id}`));
    if (!pr) {
      const { wire } = await this.ctx.host.repository();
      await this.ctx.authorize({ title: `Look up pull request #${this.id} in ${wire.full_name}`, description: "No such pull request." });
      throw new Error(`Pull request #${this.id} does not exist.`);
    }
    return pr;
  }

  async getDetails(): Promise<BitbucketPullRequestDetails> {
    const pr = await this.#wire();
    const { wire: repo } = await this.ctx.host.repository();
    // Bitbucket names the source and destination commits by a 12-digit prefix; resolve them.
    const full = async (hash: string | undefined) => hash === undefined ? undefined
      : (await this.ctx.host.read((api, base) => commitAt(api, base, hash)))?.hash;
    const [source, destination] = await Promise.all([full(pr.source.commit?.hash), full(pr.destination.commit?.hash)]);
    await this.ctx.authorize({ title: `Read pull request #${this.id} in ${repo.full_name}`, description: `Read "${pr.title}".` });
    await this.ctx.git.advertise([...(source ? [source] : []), ...(destination ? [destination] : [])]);
    return toPullRequestDetails(repo.full_name, pr,
      { ...(source ? { source } : {}), ...(destination ? { destination } : {}) });
  }

  async readDiff(options?: BitbucketPageOptions): Promise<Cursor<BitbucketDiffFile>> {
    const pageSize = pageSizeOf(options);
    const { wire: repo } = await this.ctx.host.repository();
    const diff = await this.ctx.host.cached(`pr-diff|${this.id}`, LIST_CACHE_TTL_MS,
      () => this.ctx.host.read((api, base) => api.getText(`${base}/pullrequests/${this.id}/diff`)));
    const hunks = splitDiff(diff);
    return await this.ctx.listing<WireDiffStat, BitbucketDiffFile>({
      title: `Diff of pull request #${this.id}`, noun: "changed files", pageSize,
      path: base => `${base}/pullrequests/${this.id}/diffstat`,
      query: {},
      map: stat => toDiffFile(stat, hunks),
      cacheKey: `pr-diffstat|${this.id}|${repo.full_name}`,
    });
  }

  async listCommits(options?: BitbucketPageOptions): Promise<Cursor<BitbucketCommitSummary>> {
    return await this.ctx.listing<WireCommit, BitbucketCommitSummary>({
      title: `Commits of pull request #${this.id}`, noun: "commits", pageSize: pageSizeOf(options),
      path: base => `${base}/pullrequests/${this.id}/commits`,
      query: {},
      map: (wire, fullName) => toCommit(fullName, wire),
      commitIds: commitIdsOfSummary,
      cacheKey: `pr-commits|${this.id}`,
    });
  }

  async readComments(options?: BitbucketPageOptions): Promise<Cursor<BitbucketComment>> {
    return await this.ctx.listing<WireComment, BitbucketComment>({
      title: `Comments on pull request #${this.id}`, noun: "comments", pageSize: pageSizeOf(options),
      path: base => `${base}/pullrequests/${this.id}/comments`,
      query: { sort: "created_on" },
      map: toComment,
      cacheKey: `pr-comments|${this.id}`,
    });
  }

  /** Submits a write to this pull request, once Bitbucket confirms it exists. */
  async #submit<K extends keyof BitbucketActions>(kind: K, payload: BitbucketActions[K]): Promise<void> {
    await this.#wire();
    await this.ctx.host.submit(this.ctx.queue, kind, payload);
  }

  async postComment(bodyMarkdown: string): Promise<void> {
    await this.#submit("comment", { pullRequestId: this.id, body: text(bodyMarkdown, "bodyMarkdown", MAX_BODY_LENGTH) });
  }

  async postInlineComment(path: string, line: number, bodyMarkdown: string,
                          options?: { side?: "old" | "new" }): Promise<void> {
    const file = text(path, "path", 1024);
    if (!Number.isInteger(line) || line < 1) throw new Error("line must be a positive line number.");
    const side = options?.side ?? "new";
    if (side !== "old" && side !== "new") throw new Error(`side must be "old" or "new".`);
    await this.#submit("comment", {
      pullRequestId: this.id, body: text(bodyMarkdown, "bodyMarkdown", MAX_BODY_LENGTH), inline: { path: file, line, side },
    });
  }

  async replyToComment(commentId: string, bodyMarkdown: string): Promise<void> {
    if (typeof commentId !== "string" || !/^\d+$/.test(commentId)) throw new Error(`"${commentId}" is not a comment id.`);
    await this.#submit("comment", {
      pullRequestId: this.id, body: text(bodyMarkdown, "bodyMarkdown", MAX_BODY_LENGTH), parentId: Number(commentId),
    });
  }

  async setTitle(title: string): Promise<void> {
    await this.#submit("editPullRequest", { pullRequestId: this.id, title: text(title, "title", MAX_TITLE_LENGTH) });
  }

  async setDescription(bodyMarkdown: string): Promise<void> {
    if (typeof bodyMarkdown !== "string" || bodyMarkdown.length > MAX_BODY_LENGTH) {
      throw new Error(`bodyMarkdown must be a string of at most ${MAX_BODY_LENGTH} characters.`);
    }
    await this.#submit("editPullRequest", { pullRequestId: this.id, description: bodyMarkdown });
  }

  async approve(): Promise<void> {
    await this.#submit("approve", { pullRequestId: this.id });
  }

  async requestChanges(): Promise<void> {
    await this.#submit("requestChanges", { pullRequestId: this.id });
  }

  async decline(): Promise<void> {
    await this.#submit("decline", { pullRequestId: this.id });
  }

  async merge(options?: BitbucketMergeOptions): Promise<void> {
    if (options?.strategy !== undefined && !MERGE_STRATEGIES.includes(options.strategy)) {
      throw new Error(`strategy must be one of ${MERGE_STRATEGIES.join(", ")}.`);
    }
    const message = options?.message === undefined ? undefined : text(options.message, "message", MAX_BODY_LENGTH);
    await this.#submit("merge", {
      pullRequestId: this.id,
      ...(options?.strategy !== undefined ? { strategy: options.strategy } : {}),
      ...(message !== undefined ? { message } : {}),
      ...(options?.closeSourceBranch !== undefined ? { closeSourceBranch: options.closeSourceBranch === true } : {}),
    });
  }

  [Symbol.dispose](): void {
    this.ctx[Symbol.dispose]();
  }
}
