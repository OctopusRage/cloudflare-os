// What a gadget can change on Bitbucket, each change staged for the user's approval and carried
// out only once approved: pushes, pull request creation, comments, edits, reviews, declines and
// merges.
//
// No action is simulated. Every one is submitted with `delivery: "await-decision"`, so the harness
// suspends the agent until the user decides, and later reads see Bitbucket as it is. That is why
// `createPullRequest` returns nothing rather than a provisional pull request.
//
// Auto-approval verdicts (see the write-gatekeeper skill's rules), each `false` naming its rule:
// - push / force push: `true` to a branch that is neither the main branch nor covered by a branch
//   restriction, `false` otherwise (rule 5). The verdict is a sibling definition picked at submit,
//   and an approvable push is checked again at apply, since a restriction can be added meanwhile.
//   A force push has its own kind, as GitHub's does, so enabling pushes does not enable it.
// - approve, merge: `false` (rule 5). decline: `false` (rule 1): Bitbucket Cloud cannot reopen a
//   declined pull request.
// - opening a pull request, comments, title and description edits, requesting changes: `true`.
//
// Every action is fenced on the Bitbucket user the binding is pinned to, not the connection
// generation: a reconnect, which must be the same user, does not strand what is waiting.

import type { ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import {
  buildDescription, codeSpan, sanitizeTitle, type ActionDescriptionBuilder,
} from "@gadgets/gatekeeper-kit/action-description";
import {
  ActionApplyError, ActionOutcomeUnknownError, defineActions, type ActionContext, type ActionPresentation,
  type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import { GitRefUpdateRejectedError, ZERO_OID, pushGitRefUpdate } from "@gadgets/gatekeeper-kit/git-transport";
import { BitbucketApiError, type BitbucketApi } from "./bitbucket-api";
import { VENDOR_ID, repositoryUrl } from "./bitbucket-env";
import { pullRequestUrl, type WirePullRequest } from "./bitbucket-normalize";

/** What apply handlers may do: write as the connection, and read the repository's live state. */
export type BitbucketActionHost = {
  /** Runs a write as the connection; `base` is the repository's API path, `fullName` its name now. */
  write<T>(op: (api: BitbucketApi, base: string, fullName: string) => Promise<T>): Promise<T>;
  /** The branch's head commit now, or null when Bitbucket has no such branch. */
  branchHead(branch: string): Promise<string | null>;
  /**
   * Whether `branch` is the main branch or covered by a branch restriction, read live; undefined
   * when that could not be read.
   */
  isProtectedBranch(branch: string): Promise<boolean | undefined>;
  /** The repository's `workspace/repo` name now, for descriptions. */
  fullName(): string;
};

export type PushPayload = {
  branch: string;
  /** The branch head the push was checked against at submit; `ZERO_OID` to create the branch. */
  expectedOldSha: string;
  newSha: string;
  force: boolean;
};

export type CreatePullRequestPayload = {
  title: string;
  sourceBranch: string;
  /** Absent for the repository's main branch. */
  destinationBranch?: string;
  description?: string;
  closeSourceBranch: boolean;
  reviewerAccountIds: string[];
};

export type CommentPayload = {
  pullRequestId: number;
  body: string;
  inline?: { path: string; line: number; side: "old" | "new" };
  parentId?: number;
};

export type EditPayload = { pullRequestId: number; title?: string; description?: string };

export type PullRequestPayload = { pullRequestId: number };

export type MergePayload = PullRequestPayload & {
  strategy?: "merge_commit" | "squash" | "fast_forward";
  message?: string;
  closeSourceBranch?: boolean;
};

export type BitbucketActions = {
  push: PushPayload;
  pushProtected: PushPayload;
  forcePush: PushPayload;
  forcePushProtected: PushPayload;
  createPullRequest: CreatePullRequestPayload;
  comment: CommentPayload;
  editPullRequest: EditPayload;
  requestChanges: PullRequestPayload;
  approve: PullRequestPayload;
  decline: PullRequestPayload;
  merge: MergePayload;
};

export type BitbucketAction = TaggedAction<BitbucketActions>;

const PUSH: ActionKind = { tag: "push", label: "Push commits to a branch" };
const FORCE_PUSH: ActionKind = { tag: "force-push", label: "Force-push a branch" };
const CREATE_PULL_REQUEST: ActionKind = { tag: "create-pull-request", label: "Open a pull request" };
const COMMENT: ActionKind = { tag: "comment", label: "Comment on a pull request" };
const EDIT: ActionKind = { tag: "edit-pull-request", label: "Edit a pull request's title or description" };
const REQUEST_CHANGES: ActionKind = { tag: "request-changes", label: "Request changes on a pull request" };
const APPROVE: ActionKind = { tag: "approve", label: "Approve a pull request" };
const DECLINE: ActionKind = { tag: "decline", label: "Decline a pull request" };
const MERGE: ActionKind = { tag: "merge", label: "Merge a pull request" };

/** The action tags a binding of each kind can submit, for `getAutoApprovableActions`. */
export const BINDING_TAGS = {
  repository: new Set([PUSH, FORCE_PUSH, CREATE_PULL_REQUEST, COMMENT, EDIT, REQUEST_CHANGES, APPROVE, DECLINE, MERGE]
    .map(kind => kind.tag)),
  pullRequest: new Set([COMMENT, EDIT, REQUEST_CHANGES, APPROVE, DECLINE, MERGE].map(kind => kind.tag)),
};

/** The longest body a comment or description may carry; Bitbucket's own limit is larger. */
export const MAX_BODY_LENGTH = 32_000;

function present(title: string, description: ActionDescriptionBuilder, extra?: { pushedCommits?: string[] }):
    ActionPresentation {
  // Bitbucket has no undo for any of these through its API.
  return { title: sanitizeTitle(title), ...description.finish(), ...extra, implementsRevert: false };
}

const prLink = (host: BitbucketActionHost, id: number): string =>
  `[pull request #${id}](${pullRequestUrl(host.fullName(), id)})`;

const prPath = (base: string, id: number): string => `${base}/pullrequests/${id}`;

// ---------------------------------------------------------------------------
// Push

function describePush(payload: PushPayload, host: BitbucketActionHost, protectedTarget: boolean): ActionPresentation {
  const repo = `[${host.fullName()}](${repositoryUrl(host.fullName())})`;
  const verb = payload.force ? "Force-pushes" : "Pushes";
  const description = buildDescription(payload.expectedOldSha === ZERO_OID
    ? `${verb} commit ${codeSpan(payload.newSha)} to a new branch ${codeSpan(payload.branch)} in ${repo}.`
    : `${verb} commit ${codeSpan(payload.newSha)} to branch ${codeSpan(payload.branch)} in ${repo}, moving it ` +
      `from ${codeSpan(payload.expectedOldSha)}.` +
      (payload.force ? " This overwrites the branch: commits on it that aren't in the pushed history are discarded." : ""));
  if (protectedTarget) description.prose("This is the main branch, or a branch Bitbucket restricts.");
  return present(`${payload.force ? "Force-push" : "Push"} ${payload.newSha.slice(0, 12)} to ${payload.branch}`,
    description, { pushedCommits: [payload.newSha] });
}

async function applyPush(payload: PushPayload, host: BitbucketActionHost, approvable: boolean,
                         gitCache: ActionContext["gitCache"]): Promise<void> {
  // A branch already at the pushed commit is an apply whose first attempt landed.
  if (await host.branchHead(payload.branch) === payload.newSha) return;
  if (approvable) {
    // A restriction can be added, or the main branch changed, while the push waits.
    const gated = await host.isProtectedBranch(payload.branch);
    if (gated === undefined) {
      throw new Error(`Could not read whether branch "${payload.branch}" is restricted, so the push was not made. Try again.`);
    }
    if (gated) {
      throw new ActionApplyError(`Branch "${payload.branch}" became the main branch or a restricted branch while ` +
        "this push waited, so it can no longer be applied without review. Reject it and push again.");
    }
  }
  if (!gitCache) throw new Error("The push was applied without a git cache to build its pack from.");
  // The overseer builds the pack from the action's `pushedCommits`; this side sends it with a
  // ref update whose old head is the one checked at submit, so Bitbucket refuses the update if the
  // branch moved since (a force push skipped only the fast-forward check, not this one).
  const pack = await gitCache.buildPack();
  try {
    await host.write((api, _base, fullName) => pushGitRefUpdate(
      body => api.fetchGitReceivePack(fullName, body),
      { branch: payload.branch, oldSha: payload.expectedOldSha, newSha: payload.newSha },
      pack));
  } catch (error) {
    if (!(error instanceof GitRefUpdateRejectedError)) throw error;
    // Applied iff the branch ends up at the pushed commit, however it got there.
    if (await host.branchHead(payload.branch) === payload.newSha) return;
    throw new ActionApplyError(payload.expectedOldSha === ZERO_OID
      ? `Branch "${payload.branch}" was created by someone else after this push was queued. Read its head and ` +
        `push again. Bitbucket said: ${error.reason}`
      : `Branch "${payload.branch}" moved from ${payload.expectedOldSha} after this push was queued, or ` +
        `Bitbucket refused it. Read its head and push again. Bitbucket said: ${error.reason}`);
  }
}

function pushDefinition(kind: ActionKind, autoApprovable: boolean) {
  return {
    kind,
    autoApprovable,
    delivery: "await-decision" as const,
    describe: (payload: PushPayload, host: BitbucketActionHost) => describePush(payload, host, !autoApprovable),
    apply: (payload: PushPayload, host: BitbucketActionHost, ctx: ActionContext) =>
      applyPush(payload, host, autoApprovable, ctx.gitCache),
  };
}

// ---------------------------------------------------------------------------
// Pull requests

/** The pull request as Bitbucket has it now. */
async function currentPullRequest(host: BitbucketActionHost, id: number): Promise<WirePullRequest> {
  const pr = await host.write((api, base) => api.find<WirePullRequest>(prPath(base, id)));
  if (!pr) throw new ActionApplyError(`Pull request #${id} no longer exists, or this connection can no longer read it.`);
  return pr;
}

/** Refuses a write to a pull request that is no longer open. */
async function requireOpen(host: BitbucketActionHost, id: number, what: string): Promise<void> {
  const pr = await currentPullRequest(host, id);
  if (pr.state !== "OPEN") {
    throw new ActionApplyError(`Pull request #${id} is ${pr.state.toLowerCase()} now, so it can't be ${what}.`);
  }
}

/** Runs a write whose request may have landed even though it failed: its outcome is unknown. */
async function once<T>(host: BitbucketActionHost, op: (api: BitbucketApi, base: string) => Promise<T>): Promise<T> {
  try {
    return await host.write(op);
  } catch (error) {
    // A 4xx is Bitbucket refusing the request, so nothing was made.
    if (error instanceof BitbucketApiError && error.status >= 400 && error.status < 500) {
      throw new ActionApplyError(error.message);
    }
    throw new ActionOutcomeUnknownError(
      `Bitbucket may or may not have made this change: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const actions = defineActions<BitbucketActionHost, BitbucketActions>({
  push: pushDefinition(PUSH, true),
  // Rule 5: a push to the main branch or a restricted branch passes a governance gate.
  pushProtected: pushDefinition(PUSH, false),
  forcePush: pushDefinition(FORCE_PUSH, true),
  // Rule 5, as above; and rule 1, since it can discard commits.
  forcePushProtected: pushDefinition(FORCE_PUSH, false),

  createPullRequest: {
    kind: CREATE_PULL_REQUEST,
    autoApprovable: true,
    delivery: "await-decision",
    // Bitbucket would open a second pull request on a repeated request.
    claimBeforeApply: true,
    describe: (payload, host) => {
      const description = buildDescription(`Opens a pull request in [${host.fullName()}](${repositoryUrl(host.fullName())}) ` +
        `from ${codeSpan(payload.sourceBranch)} into ${payload.destinationBranch ? codeSpan(payload.destinationBranch)
          : "the main branch"}.`)
        .inline("Title", payload.title);
      if (payload.description) description.verbatim("Description", payload.description, "markdown");
      if (payload.reviewerAccountIds.length > 0) description.list("Reviewers (account ids)", payload.reviewerAccountIds);
      if (payload.closeSourceBranch) description.prose("The source branch is deleted when the pull request is merged.");
      return present(`Open a pull request: ${payload.title}`, description);
    },
    apply: async (payload, host) => {
      await once(host, (api, base) => api.send("POST", `${base}/pullrequests`, {
        title: payload.title,
        source: { branch: { name: payload.sourceBranch } },
        ...(payload.destinationBranch ? { destination: { branch: { name: payload.destinationBranch } } } : {}),
        ...(payload.description ? { description: payload.description } : {}),
        close_source_branch: payload.closeSourceBranch,
        ...(payload.reviewerAccountIds.length > 0
          ? { reviewers: payload.reviewerAccountIds.map(account_id => ({ account_id })) } : {}),
      }));
    },
  },

  comment: {
    kind: COMMENT,
    autoApprovable: true,
    delivery: "await-decision",
    // A repeated request posts the comment twice.
    claimBeforeApply: true,
    describe: (payload, host) => {
      const where = payload.inline
        ? ` on line ${payload.inline.line} of ${codeSpan(payload.inline.path)} (${payload.inline.side === "old"
          ? "old" : "new"} version)`
        : payload.parentId !== undefined ? `, replying to comment ${payload.parentId}` : "";
      return present(`Comment on pull request #${payload.pullRequestId}`,
        buildDescription(`Posts a comment as you on ${prLink(host, payload.pullRequestId)}${where}.`)
          .verbatim("Comment", payload.body, "markdown"));
    },
    apply: async (payload, host) => {
      await once(host, (api, base) => api.send("POST", `${prPath(base, payload.pullRequestId)}/comments`, {
        content: { raw: payload.body },
        ...(payload.inline ? {
          inline: { path: payload.inline.path, ...(payload.inline.side === "old"
            ? { from: payload.inline.line } : { to: payload.inline.line }) },
        } : {}),
        ...(payload.parentId !== undefined ? { parent: { id: payload.parentId } } : {}),
      }));
    },
  },

  editPullRequest: {
    kind: EDIT,
    autoApprovable: true,
    delivery: "await-decision",
    describe: (payload, host) => {
      const description = buildDescription(`Edits ${prLink(host, payload.pullRequestId)}.`);
      if (payload.title !== undefined) description.inline("New title", payload.title);
      if (payload.description !== undefined) description.verbatim("New description", payload.description, "markdown");
      return present(`Edit pull request #${payload.pullRequestId}`, description);
    },
    apply: async (payload, host) => {
      // Setting a field to a value is the same however often it is repeated.
      await host.write((api, base) => api.send("PUT", prPath(base, payload.pullRequestId), {
        ...(payload.title !== undefined ? { title: payload.title } : {}),
        ...(payload.description !== undefined ? { description: payload.description } : {}),
      }));
    },
  },

  requestChanges: {
    kind: REQUEST_CHANGES,
    autoApprovable: true,
    delivery: "await-decision",
    describe: (payload, host) => present(`Request changes on pull request #${payload.pullRequestId}`,
      buildDescription(`Marks ${prLink(host, payload.pullRequestId)} as needing changes, as you.`)),
    apply: async (payload, host) => {
      await requireOpen(host, payload.pullRequestId, "reviewed");
      await reviewOnce(host, payload.pullRequestId, "request-changes");
    },
  },

  approve: {
    kind: APPROVE,
    // Rule 5: an approving review passes a governance gate.
    autoApprovable: false,
    delivery: "await-decision",
    describe: (payload, host) => present(`Approve pull request #${payload.pullRequestId}`,
      buildDescription(`Approves ${prLink(host, payload.pullRequestId)} as you.`)),
    apply: async (payload, host) => {
      await requireOpen(host, payload.pullRequestId, "approved");
      await reviewOnce(host, payload.pullRequestId, "approve");
    },
  },

  decline: {
    kind: DECLINE,
    // Rule 1: Bitbucket Cloud can't reopen a declined pull request.
    autoApprovable: false,
    delivery: "await-decision",
    describe: (payload, host) => present(`Decline pull request #${payload.pullRequestId}`,
      buildDescription(`Declines (closes without merging) ${prLink(host, payload.pullRequestId)}. ` +
        "Bitbucket can't reopen a declined pull request.")),
    apply: async (payload, host) => {
      const pr = await currentPullRequest(host, payload.pullRequestId);
      if (pr.state === "DECLINED") return;
      if (pr.state !== "OPEN") throw new ActionApplyError(`Pull request #${payload.pullRequestId} is ${pr.state.toLowerCase()} now.`);
      await host.write((api, base) => api.send("POST", `${prPath(base, payload.pullRequestId)}/decline`));
    },
  },

  merge: {
    kind: MERGE,
    // Rule 5: a merge passes a governance gate.
    autoApprovable: false,
    delivery: "await-decision",
    claimBeforeApply: true,
    describe: (payload, host) => {
      const description = buildDescription(`Merges ${prLink(host, payload.pullRequestId)} into its destination branch` +
        (payload.strategy ? `, by ${payload.strategy.replace("_", " ")}.` : ", by the repository's default strategy."));
      if (payload.message !== undefined) description.verbatim("Commit message", payload.message);
      if (payload.closeSourceBranch !== undefined) {
        description.prose(payload.closeSourceBranch ? "The source branch is deleted." : "The source branch is kept.");
      }
      return present(`Merge pull request #${payload.pullRequestId}`, description);
    },
    apply: async (payload, host) => {
      const pr = await currentPullRequest(host, payload.pullRequestId);
      if (pr.state === "MERGED") return;
      if (pr.state !== "OPEN") throw new ActionApplyError(`Pull request #${payload.pullRequestId} is ${pr.state.toLowerCase()} now.`);
      // Bitbucket may answer 202 and merge in the background; the merge is made either way.
      await once(host, (api, base) => api.send("POST", `${prPath(base, payload.pullRequestId)}/merge`, {
        type: "pullrequest",
        ...(payload.strategy ? { merge_strategy: payload.strategy } : {}),
        ...(payload.message !== undefined ? { message: payload.message } : {}),
        ...(payload.closeSourceBranch !== undefined ? { close_source_branch: payload.closeSourceBranch } : {}),
      }));
    },
  },
}, {
  fence: "authority",
  vendorId: VENDOR_ID,
});

/** Approves or requests changes; Bitbucket answering that it is already so counts as done. */
async function reviewOnce(host: BitbucketActionHost, id: number, verb: "approve" | "request-changes"): Promise<void> {
  try {
    await host.write((api, base) => api.send("POST", `${prPath(base, id)}/${verb}`));
  } catch (error) {
    if (error instanceof BitbucketApiError && error.status === 409) return;
    if (error instanceof BitbucketApiError && error.status === 400) throw new ActionApplyError(error.message);
    throw error;
  }
}
