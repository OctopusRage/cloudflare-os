// Bitbucket's wire shapes, as far as this gatekeeper reads them, and their translation into the
// agent-facing types of types.d.ts. Pure functions: no fetching, no authorization.

import { repositoryUrl } from "./bitbucket-env";
import type {
  BitbucketActor, BitbucketBranchSummary, BitbucketBuildStatus, BitbucketComment, BitbucketCommitSummary,
  BitbucketDiffFile, BitbucketParticipant, BitbucketPullRequestDetails, BitbucketPullRequestState,
  BitbucketPullRequestSummary, BitbucketRepositoryMetadata, BitbucketTagSummary,
} from "./types";

export type WireUser = {
  uuid?: string;
  account_id?: string;
  display_name?: string;
  nickname?: string;
  links?: { avatar?: { href?: string } };
};

export type WireRepository = {
  uuid: string;
  full_name: string;
  name: string;
  description?: string;
  is_private: boolean;
  mainbranch?: { name?: string } | null;
  language?: string;
  updated_on: string;
  workspace: { uuid: string; slug: string };
};

export type WireRef = { name: string; target: { hash: string } };

export type WireCommit = {
  hash: string;
  message: string;
  date: string;
  author: { raw: string; user?: WireUser };
  parents: { hash: string }[];
};

export type WireStatus = {
  key: string;
  name?: string;
  state: BitbucketBuildStatus["state"];
  description?: string;
  url?: string;
  updated_on: string;
};

export type WirePullRequest = {
  id: number;
  title: string;
  description?: string;
  state: BitbucketPullRequestState;
  author?: WireUser;
  source: { branch: { name: string }; commit?: { hash: string } | null };
  destination: { branch: { name: string }; commit?: { hash: string } | null };
  created_on: string;
  updated_on: string;
  comment_count?: number;
  close_source_branch?: boolean;
  participants?: { user?: WireUser; role: "REVIEWER" | "PARTICIPANT"; state?: string | null; approved?: boolean }[];
  links?: { html?: { href?: string } };
};

export type WireDiffStat = {
  status: "added" | "removed" | "modified" | "renamed" | "merge conflict" | "local deleted" | "remote deleted";
  lines_added: number;
  lines_removed: number;
  old?: { path: string } | null;
  new?: { path: string } | null;
};

export type WireComment = {
  id: number;
  user?: WireUser;
  content?: { raw?: string };
  created_on: string;
  updated_on: string;
  parent?: { id: number };
  inline?: { path: string; from?: number | null; to?: number | null };
  deleted?: boolean;
};

export function toActor(user: WireUser | undefined): BitbucketActor {
  return {
    displayName: user?.display_name ?? "(unknown user)",
    ...(user?.account_id ? { accountId: user.account_id } : {}),
    ...(user?.nickname ? { nickname: user.nickname } : {}),
  };
}

export function toRepositoryMetadata(repo: WireRepository): BitbucketRepositoryMetadata {
  return {
    fullName: repo.full_name,
    name: repo.name,
    description: repo.description ?? "",
    private: repo.is_private,
    mainBranch: repo.mainbranch?.name ?? "main",
    ...(repo.language ? { language: repo.language } : {}),
    url: repositoryUrl(repo.full_name),
    updatedAt: new Date(repo.updated_on),
  };
}

export function toBranch(ref: WireRef, mainBranch: string): BitbucketBranchSummary {
  return { name: ref.name, headCommit: ref.target.hash, main: ref.name === mainBranch };
}

export function toTag(ref: WireRef): BitbucketTagSummary {
  return { name: ref.name, commit: ref.target.hash };
}

export function toCommit(fullName: string, commit: WireCommit): BitbucketCommitSummary {
  return {
    id: commit.hash,
    message: commit.message,
    author: { raw: commit.author.raw, ...(commit.author.user ? { user: toActor(commit.author.user) } : {}) },
    date: new Date(commit.date),
    parents: commit.parents.map(parent => parent.hash),
    url: `${repositoryUrl(fullName)}/commits/${commit.hash}`,
  };
}

export function toStatus(status: WireStatus): BitbucketBuildStatus {
  return {
    key: status.key,
    name: status.name ?? status.key,
    state: status.state,
    description: status.description ?? "",
    url: status.url ?? "",
    updatedAt: new Date(status.updated_on),
  };
}

export function pullRequestUrl(fullName: string, id: number): string {
  return `${repositoryUrl(fullName)}/pull-requests/${id}`;
}

export function toPullRequestSummary(fullName: string, pr: WirePullRequest): BitbucketPullRequestSummary {
  return {
    id: String(pr.id),
    title: pr.title,
    state: pr.state,
    author: toActor(pr.author),
    sourceBranch: pr.source.branch.name,
    destinationBranch: pr.destination.branch.name,
    createdAt: new Date(pr.created_on),
    updatedAt: new Date(pr.updated_on),
    url: pullRequestUrl(fullName, pr.id),
  };
}

function participantState(state: string | null | undefined, approved: boolean | undefined): BitbucketParticipant["state"] {
  if (state === "approved" || approved) return "approved";
  if (state === "changes_requested") return "changes_requested";
  return null;
}

/**
 * A pull request's details. Bitbucket reports its source and destination commits by a 12-digit
 * prefix, so the caller passes them resolved to full commit ids.
 */
export function toPullRequestDetails(fullName: string, pr: WirePullRequest,
                                     commits: { source?: string; destination?: string }): BitbucketPullRequestDetails {
  return {
    ...toPullRequestSummary(fullName, pr),
    descriptionMarkdown: pr.description ?? "",
    ...(commits.source ? { sourceCommit: commits.source } : {}),
    ...(commits.destination ? { destinationCommit: commits.destination } : {}),
    participants: (pr.participants ?? []).map(p => ({
      user: toActor(p.user), role: p.role, state: participantState(p.state, p.approved),
    })),
    commentCount: pr.comment_count ?? 0,
    closeSourceBranch: pr.close_source_branch ?? false,
  };
}

export function toComment(comment: WireComment): BitbucketComment {
  const inline = comment.inline;
  return {
    id: String(comment.id),
    author: toActor(comment.user),
    bodyMarkdown: comment.deleted ? "" : comment.content?.raw ?? "",
    createdAt: new Date(comment.created_on),
    updatedAt: new Date(comment.updated_on),
    ...(comment.parent ? { parentId: String(comment.parent.id) } : {}),
    ...(inline
      ? {
        inline: inline.to != null
          ? { path: inline.path, line: inline.to, side: "new" as const }
          : { path: inline.path, line: inline.from ?? 0, side: "old" as const },
      }
      : {}),
    deleted: comment.deleted ?? false,
  };
}

const MAX_DIFF_LINES = 2000;

/** Splits a multi-file unified diff into each file's hunks, keyed by its new (else old) path. */
export function splitDiff(diff: string): Map<string, string> {
  const files = new Map<string, string>();
  const chunks = diff.split(/^(?=diff --git )/m).filter(chunk => chunk.startsWith("diff --git "));
  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    const newPath = lines.find(line => line.startsWith("+++ "))?.slice(4);
    const oldPath = lines.find(line => line.startsWith("--- "))?.slice(4);
    const path = (newPath && newPath !== "/dev/null" ? newPath : oldPath)?.replace(/^[ab]\//, "");
    const hunkStart = lines.findIndex(line => line.startsWith("@@"));
    if (!path || hunkStart === -1) continue;
    files.set(path, lines.slice(hunkStart).join("\n"));
  }
  return files;
}

/** One diffstat entry, with its hunks from `hunks` (see `splitDiff`) when the diff carried them. */
export function toDiffFile(stat: WireDiffStat, hunks: Map<string, string>): BitbucketDiffFile {
  const newPath = stat.new?.path;
  const oldPath = stat.old?.path;
  const path = newPath ?? oldPath ?? "";
  const status: BitbucketDiffFile["status"] =
    stat.status === "added" || stat.status === "removed" || stat.status === "renamed" ? stat.status : "modified";
  const text = hunks.get(path);
  let diff: string | undefined;
  let truncated: boolean | undefined;
  if (text !== undefined) {
    const lines = text.split("\n");
    truncated = lines.length > MAX_DIFF_LINES;
    diff = truncated ? lines.slice(0, MAX_DIFF_LINES).join("\n") : text;
  }
  return {
    path,
    ...(status === "renamed" && oldPath && oldPath !== path ? { oldPath } : {}),
    status,
    linesAdded: stat.lines_added,
    linesRemoved: stat.lines_removed,
    ...(diff !== undefined ? { diff } : {}),
    ...(truncated ? { truncated } : {}),
  };
}
