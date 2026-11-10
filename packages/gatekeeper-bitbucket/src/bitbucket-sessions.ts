// The repository and pull request capabilities gadgets hold. Every read authorizes its
// observation, reporting the one repository it depends on, before anything it read is returned;
// listings authorize each page. Commit ids a read returns are advertised to the workspace git
// cache, so the overseer knows this gatekeeper can pull them (see `Gatekeeper.gitPull`).
//
// Phase 1 is read-only: every write method refuses until actions land (push, pull request
// creation, comments, review and merge are all staged for approval then).

import { RpcTarget, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import { TokenCursor, SessionGitCache } from "@gadgets/gatekeeper-kit/cursors";
import { commitIdsOfSummary } from "@gadgets/gatekeeper-kit/git-objects";
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
const READ_ONLY = "Writes to Bitbucket are not supported by this gatekeeper yet; it is read-only for now.";

/** What the gatekeeper Durable Object lends its sessions. */
export type SessionHost = {
  /** The pinned repository as Bitbucket describes it now, and its subresource ID. */
  repository(): Promise<{ wire: WireRepository; subresource: string }>;
  /** Runs a read as the connection; `base` is the repository's API path, addressed by UUID. */
  read<T>(op: (api: BitbucketApi, base: string) => Promise<T>): Promise<T>;
  /** A read cache partitioned by connection. */
  cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T>;
};

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

  async push(_branch: string, _commitId: string, _options?: { force?: boolean }): Promise<void> {
    throw new Error(READ_ONLY);
  }

  async createPullRequest(_options: BitbucketCreatePullRequestOptions): Promise<BitbucketPullRequest> {
    throw new Error(READ_ONLY);
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
    if (!source) throw new Error(`Pull request #${this.id}'s source commit could not be read.`);
    await this.ctx.authorize({ title: `Read pull request #${this.id} in ${repo.full_name}`, description: `Read "${pr.title}".` });
    await this.ctx.git.advertise([source, ...(destination ? [destination] : [])]);
    return toPullRequestDetails(repo.full_name, pr, { source, ...(destination ? { destination } : {}) });
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

  async postComment(_bodyMarkdown: string): Promise<void> {
    throw new Error(READ_ONLY);
  }

  async postInlineComment(_path: string, _line: number, _bodyMarkdown: string,
                          _options?: { side?: "old" | "new" }): Promise<void> {
    throw new Error(READ_ONLY);
  }

  async replyToComment(_commentId: string, _bodyMarkdown: string): Promise<void> {
    throw new Error(READ_ONLY);
  }

  async setTitle(_title: string): Promise<void> {
    throw new Error(READ_ONLY);
  }

  async setDescription(_bodyMarkdown: string): Promise<void> {
    throw new Error(READ_ONLY);
  }

  async approve(): Promise<void> {
    throw new Error(READ_ONLY);
  }

  async requestChanges(): Promise<void> {
    throw new Error(READ_ONLY);
  }

  async decline(): Promise<void> {
    throw new Error(READ_ONLY);
  }

  async merge(_options?: BitbucketMergeOptions): Promise<void> {
    throw new Error(READ_ONLY);
  }

  [Symbol.dispose](): void {
    this.ctx[Symbol.dispose]();
  }
}
