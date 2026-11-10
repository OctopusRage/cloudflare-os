/**
 * A Bitbucket Cloud repository.
 *
 * Repositories live in a workspace: `full_name` is `workspace/repo-slug`, as in
 * `https://bitbucket.org/workspace/repo-slug`.
 *
 * Git-level access works in terms of commit ids: use `listBranches()`, `listTags()`,
 * `listCommits()`, `resolveRef()`, or `getCommit()` to discover commit ids, then mount a commit
 * as a worktree (see the `createWorktree` tool) to read or edit the files it contains. The
 * repository's file *content* is not readable through this interface directly.
 */
export interface BitbucketRepository {
  /** Returns basic metadata about the repository. */
  getMetadata(): Promise<BitbucketRepositoryMetadata>;

  /**
   * Lists branches in this repository, most recently updated first.
   *
   * Results are streamed through the returned cursor. Call `next()` repeatedly on that
   * same cursor until it returns `null`.
   */
  listBranches(options?: BitbucketBranchFilter): Promise<Cursor<BitbucketBranchSummary>>;

  /**
   * Lists tags in this repository.
   *
   * Results are streamed through the returned cursor. Call `next()` repeatedly on that
   * same cursor until it returns `null`.
   */
  listTags(options?: BitbucketPageOptions): Promise<Cursor<BitbucketTagSummary>>;

  /**
   * Resolves a ref to a full commit id, without fetching the commit's details.
   *
   * `ref` may be a full commit id, an unambiguously truncated commit id, a branch name, or a tag
   * name; it defaults to the main branch, so `resolveRef()` with no argument answers "what
   * commit is the repository currently at?". Prefer it over `getCommit()` when all you need is
   * the commit id, e.g. to mount a worktree.
   */
  resolveRef(ref?: string): Promise<string>;

  /**
   * Looks up a single commit, with the build statuses reported on it (CI results from
   * Bitbucket Pipelines, Jenkins, and other tools) in `statuses`.
   *
   * `ref` may be a full commit id, an unambiguously truncated commit id, a branch name, or a tag
   * name; it defaults to the main branch, whose latest commit is then returned.
   */
  getCommit(ref?: string): Promise<BitbucketCommitDetails>;

  /**
   * Lists this repository's commit history, newest first, starting from `options.ref` (the
   * main branch when omitted).
   *
   * Results are streamed through the returned cursor. Call `next()` repeatedly on that
   * same cursor until it returns `null`.
   */
  listCommits(options?: BitbucketCommitFilter): Promise<Cursor<BitbucketCommitSummary>>;

  /**
   * Pushes a commit to a branch, setting the branch's head to `commitId` -- the way commits made
   * in a worktree get to Bitbucket. The branch is created if it does not exist.
   *
   * `commitId` must be a full 40-character commit id (e.g. the result of a worktree `commit()`),
   * and the commit's history must be locally available down to a commit that came from this
   * repository -- which is automatic for commits authored in a worktree mounted from a commit of
   * this repository.
   *
   * Without `force`, the push must be a fast-forward: the branch's current head must be an
   * ancestor of `commitId`. If the branch has moved past the head your work was based on, the
   * push fails with an error saying so; mount the new head and redo your change on it, or pass
   * `force: true` to overwrite the branch (which may discard others' commits). Bitbucket's
   * branch restrictions are checked by Bitbucket when the push is made: a push they reject is
   * not made, and Bitbucket's reason is reported.
   *
   * The push is made only once the user approves it, and your turn pauses until they decide.
   * Afterwards the branch reads as pushed (or unchanged, if they rejected it).
   *
   * To open a pull request for newly pushed work: `push(branch, commitId)` to a new branch,
   * then `createPullRequest({sourceBranch: branch, ...})`.
   */
  push(branch: string, commitId: string, options?: { force?: boolean }): Promise<void>;

  /**
   * Opens a pull request from `options.sourceBranch` into `options.destinationBranch` (the main
   * branch when omitted), both in this repository.
   *
   * The pull request is opened only once the user approves it, and your turn pauses until they
   * decide. To work with it afterwards, find it with
   * `listPullRequests({ sourceBranch })` and open it with `getPullRequest(id)`.
   */
  createPullRequest(options: BitbucketCreatePullRequestOptions): Promise<void>;

  /** Opens a pull request of this repository by its number (e.g. `"42"`). */
  getPullRequest(id: string): Promise<BitbucketPullRequest>;

  /**
   * Lists this repository's pull requests, newest first; open ones only unless
   * `options.state` says otherwise.
   *
   * Results are streamed through the returned cursor. Call `next()` repeatedly on that
   * same cursor until it returns `null`.
   */
  listPullRequests(options?: BitbucketPullRequestFilter): Promise<Cursor<BitbucketPullRequestSummary>>;
}

/**
 * A single Bitbucket pull request.
 *
 * Its commits can be mounted as worktrees like any other commit of its repository: use
 * `getDetails()` for the source and destination commit ids.
 */
export interface BitbucketPullRequest {
  // Every change below (comments, edits, reviews, decline, merge) is made only once the user
  // approves it, and your turn pauses until they decide. Approving, declining and merging always
  // need the user's review; the others can be auto-approved if the user allows it.

  /** Returns the pull request's title, description, state, branches, and reviewers. */
  getDetails(): Promise<BitbucketPullRequestDetails>;

  /**
   * Reads the pull request's diff (source against its merge base with the destination) as
   * unified-diff text, one file per entry.
   */
  readDiff(options?: BitbucketPageOptions): Promise<Cursor<BitbucketDiffFile>>;

  /**
   * Lists the commits the pull request would merge, newest first.
   *
   * Results are streamed through the returned cursor. Call `next()` repeatedly on that
   * same cursor until it returns `null`.
   */
  listCommits(options?: BitbucketPageOptions): Promise<Cursor<BitbucketCommitSummary>>;

  /**
   * Reads the pull request's comments, oldest first: general comments and inline comments on
   * the diff (`inline` set) alike.
   *
   * Results are streamed through the returned cursor. Call `next()` repeatedly on that
   * same cursor until it returns `null`.
   */
  readComments(options?: BitbucketPageOptions): Promise<Cursor<BitbucketComment>>;

  /** Posts a general comment on the pull request. `bodyMarkdown` is Bitbucket Markdown. */
  postComment(bodyMarkdown: string): Promise<void>;

  /**
   * Posts a comment on one line of the diff. `line` is a line number in the new version of
   * `path` (or in the old version when `side` is `"old"`, for a removed line).
   */
  postInlineComment(path: string, line: number, bodyMarkdown: string,
      options?: { side?: "old" | "new" }): Promise<void>;

  /** Replies to an existing comment, by its `id` from `readComments()`. */
  replyToComment(commentId: string, bodyMarkdown: string): Promise<void>;

  /** Changes the pull request's title. */
  setTitle(title: string): Promise<void>;

  /** Replaces the pull request's description. */
  setDescription(bodyMarkdown: string): Promise<void>;

  /** Approves the pull request as you. */
  approve(): Promise<void>;

  /** Marks the pull request as needing changes, as you. */
  requestChanges(): Promise<void>;

  /** Declines (closes) the pull request without merging it. */
  decline(): Promise<void>;

  /**
   * Merges the pull request into its destination branch. `strategy` defaults to the
   * repository's default merge strategy.
   */
  merge(options?: BitbucketMergeOptions): Promise<void>;
}

/** A person as Bitbucket shows them. */
export type BitbucketActor = {
  displayName: string;
  /** Bitbucket's stable account id, when the person has an Atlassian account. */
  accountId?: string;
  /** The person's Bitbucket nickname, when known. */
  nickname?: string;
}

/** Basic metadata returned by `BitbucketRepository.getMetadata()`. */
export type BitbucketRepositoryMetadata = {
  /** `workspace/repo-slug`. */
  fullName: string;
  name: string;
  description: string;
  /** Whether the repository is private. */
  private: boolean;
  /** The repository's main (default) branch. */
  mainBranch: string;
  /** The repository's main language, when Bitbucket records one. */
  language?: string;
  /** The Bitbucket web page for the repository. */
  url: string;
  updatedAt: Date;
}

/** A branch returned by `BitbucketRepository.listBranches()`. */
export type BitbucketBranchSummary = {
  name: string;
  /** Commit id of the branch's current head. */
  headCommit: string;
  /** Whether this is the repository's main branch. */
  main: boolean;
}

/** A tag returned by `BitbucketRepository.listTags()`. */
export type BitbucketTagSummary = {
  name: string;
  /** Commit id the tag points at. */
  commit: string;
}

/** The author of a commit, as recorded in the commit itself. */
export type BitbucketCommitIdentity = {
  /** The raw `Name <email>` string from the commit. */
  raw: string;
  /** The Bitbucket user it maps to, when Bitbucket can tell. */
  user?: BitbucketActor;
}

/**
 * A commit, as returned from commit lookups and history enumeration.
 *
 * `id` is the commit's full git commit id. A commit can be mounted as a worktree (see the
 * `createWorktree` tool) to read or edit the files it contains, and commit ids created on such a
 * worktree can be passed back into this API.
 */
export type BitbucketCommitSummary = {
  /** The full git commit id (40 hex digits). */
  id: string;
  /** The full commit message. The first line is conventionally a short summary. */
  message: string;
  author: BitbucketCommitIdentity;
  date: Date;
  /** Commit ids of this commit's parents: empty for a root commit, two or more for a merge. */
  parents: string[];
  /** The Bitbucket web page where this commit can be viewed. */
  url: string;
}

/** Full commit details returned by `BitbucketRepository.getCommit()`. */
export type BitbucketCommitDetails = BitbucketCommitSummary & {
  /** Build statuses reported on this commit, newest first. Empty when none were reported. */
  statuses: BitbucketBuildStatus[];
}

/** One CI result reported on a commit (Bitbucket Pipelines, Jenkins, and so on). */
export type BitbucketBuildStatus = {
  /** The reporting tool's key for this build, stable across re-runs. */
  key: string;
  name: string;
  state: "INPROGRESS" | "SUCCESSFUL" | "FAILED" | "STOPPED";
  description: string;
  /** Where the build can be viewed, e.g. the Jenkins job page. */
  url: string;
  updatedAt: Date;
}

/** The state of a pull request. */
export type BitbucketPullRequestState = "OPEN" | "MERGED" | "DECLINED" | "SUPERSEDED";

/** A pull request as listed by `BitbucketRepository.listPullRequests()`. */
export type BitbucketPullRequestSummary = {
  /** The pull request's number, as a string; provisional (`"~1"`) while creation is pending. */
  id: string;
  title: string;
  state: BitbucketPullRequestState;
  author: BitbucketActor;
  sourceBranch: string;
  destinationBranch: string;
  createdAt: Date;
  updatedAt: Date;
  /** The Bitbucket web page for the pull request. */
  url: string;
}

/** A reviewer or other participant of a pull request, and where they stand. */
export type BitbucketParticipant = {
  user: BitbucketActor;
  role: "REVIEWER" | "PARTICIPANT";
  /** `null` while they have neither approved nor requested changes. */
  state: "approved" | "changes_requested" | null;
}

/** Full pull request details returned by `BitbucketPullRequest.getDetails()`. */
export type BitbucketPullRequestDetails = BitbucketPullRequestSummary & {
  /** The description, as Bitbucket Markdown. */
  descriptionMarkdown: string;
  /** Commit id at the head of the source branch. */
  sourceCommit: string;
  /** Commit id at the head of the destination branch, when Bitbucket reports it. */
  destinationCommit?: string;
  participants: BitbucketParticipant[];
  commentCount: number;
  /** Whether the source branch is deleted when the pull request is merged. */
  closeSourceBranch: boolean;
}

/** One file's change in a pull request's diff. */
export type BitbucketDiffFile = {
  /** The file's path after the change; for a deleted file, its path before. */
  path: string;
  /** The file's path before the change, when it was renamed. */
  oldPath?: string;
  status: "added" | "removed" | "modified" | "renamed";
  linesAdded: number;
  linesRemoved: number;
  /**
   * The file's unified diff (hunks only, without the `diff --git` header). Omitted for binary
   * files, and cut short past 2,000 lines with `truncated` set.
   */
  diff?: string;
  truncated?: boolean;
}

/** A comment on a pull request. */
export type BitbucketComment = {
  id: string;
  author: BitbucketActor;
  bodyMarkdown: string;
  createdAt: Date;
  updatedAt: Date;
  /** The comment this one replies to, if any. */
  parentId?: string;
  /** Where on the diff an inline comment sits; absent for a general comment. */
  inline?: { path: string; line: number; side: "old" | "new" };
  /** Whether the comment was deleted (its body is then empty). */
  deleted: boolean;
}

/** Options for `BitbucketRepository.createPullRequest()`. */
export type BitbucketCreatePullRequestOptions = {
  title: string;
  /** The branch with the changes. Push to it first with `push()`. */
  sourceBranch: string;
  /** The branch to merge into; defaults to the main branch. */
  destinationBranch?: string;
  descriptionMarkdown?: string;
  /** Delete the source branch when the pull request is merged. Defaults to false. */
  closeSourceBranch?: boolean;
  /** Reviewers, by Bitbucket account id. */
  reviewerAccountIds?: string[];
}

/** Options for `BitbucketPullRequest.merge()`. */
export type BitbucketMergeOptions = {
  strategy?: "merge_commit" | "squash" | "fast_forward";
  /** The merge (or squash) commit's message. */
  message?: string;
  /** Delete the source branch after merging. Defaults to the pull request's own setting. */
  closeSourceBranch?: boolean;
}

/** A cursor over a long result list. */
export interface Cursor<T> {
  /** Returns the next page, or `null` once there are no more. */
  next(): Promise<T[] | null>;
}

export type BitbucketPageOptions = {
  /** Items per page, 1 to 100. Defaults to 30. */
  pageSize?: number;
}

export type BitbucketBranchFilter = BitbucketPageOptions & {
  /** Only branches whose name contains this text. */
  search?: string;
}

export type BitbucketCommitFilter = BitbucketPageOptions & {
  /** Where history starts: a branch, tag, or commit id. Defaults to the main branch. */
  ref?: string;
  /** Only commits touching this file or directory path. */
  path?: string;
}

export type BitbucketPullRequestFilter = BitbucketPageOptions & {
  /** Which states to list. Defaults to `["OPEN"]`. */
  state?: BitbucketPullRequestState[];
  /** Only pull requests whose title contains this text. */
  search?: string;
  /** Only pull requests from this source branch. */
  sourceBranch?: string;
}
