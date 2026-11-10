// Configuration shared by every part of the Bitbucket gatekeeper: the Worker's environment,
// Bitbucket Cloud's endpoints, the connectable resources with their URL patterns, and the OAuth
// scopes a connection needs.
//
// Bitbucket Cloud only (bitbucket.org). Bitbucket Data Center has a different API and is not
// supported.

import { stripTrailingSlashes, type SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import type { PreviewOAuthEnv } from "@gadgets/gatekeeper-kit/preview-oauth";

/** The vendor id: the router's `/gatekeeper/bitbucket/` path segment, and the log attribution. */
export const VENDOR_ID = "bitbucket";

/** The Worker's environment. The OAuth consumer is required; everything else is optional. */
export type Env = Cloudflare.Env & PreviewOAuthEnv & {
  /** This Worker's public base URL, ending in `/gatekeeper/bitbucket`. */
  BASE_URL?: string;
  /** The OAuth consumer's key. */
  CLIENT_ID?: string;
  /** The OAuth consumer's secret. */
  CLIENT_SECRET?: string;
};

/** Bitbucket's web origin; repository and pull request links live here. */
export const WEB_ORIGIN = "https://bitbucket.org";
/** The REST API root. */
export const API_ROOT = "https://api.bitbucket.org/2.0";
/** The browser-facing authorization page. */
export const AUTHORIZE_URL = "https://bitbucket.org/site/oauth2/authorize";
/** The token endpoint, for code exchange and refresh. Bitbucket documents no revocation endpoint. */
export const TOKEN_URL = "https://bitbucket.org/site/oauth2/access_token";

/** This Worker's public base URL, without a trailing slash. */
export function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL || "http://localhost:8787/gatekeeper/bitbucket");
}

export function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

/** The OAuth callback registered with the Bitbucket consumer. */
export function getRedirectUri(env: Env): string {
  return `${getBaseUrl(env)}/oauth`;
}

/** The kinds of resource a binding can be. */
export type ResourceKind = "repository" | "pullRequest";

/** Props baked into the gatekeeper Durable Object class for one binding. */
export type BitbucketGatekeeperImplProps = {
  /** The `UserAccount` Durable Object holding the connection. */
  userObjectId: string;
  /** The workspace slug and repository slug the binding's link named. */
  workspace: string;
  repoSlug: string;
} & ({ resourceKind: "repository" } | { resourceKind: "pullRequest"; pullRequestId: number });

const REPO_PATTERN = `${WEB_ORIGIN}/:workspace/:repo`;
const PULL_REQUEST_PATTERN = `${WEB_ORIGIN}/:workspace/:repo/pull-requests/:id(\\d+){/*}?`;

/** The connectable resources. Each has its own configurator (see `startResourceConfigurator`). */
export const RESOURCES: Record<ResourceKind, SupportedResource> = {
  repository: {
    urlPattern: REPO_PATTERN,
    title: "Bitbucket Repository",
    description: "Read branches, commits, build statuses and pull requests, mount commits as " +
      "worktrees, push branches and open pull requests.",
  },
  pullRequest: {
    urlPattern: PULL_REQUEST_PATTERN,
    title: "Bitbucket Pull Request",
    description: "One pull request: read its diff, commits and comments, and comment, review or merge it.",
  },
};

/** The resources in the order the picker lists them: the more specific pattern first. */
export const ALL_RESOURCES: SupportedResource[] = [RESOURCES.pullRequest, RESOURCES.repository];

/**
 * The scopes a connection needs, as Bitbucket names them in a token response's `scopes`. A
 * consumer's permissions are fixed when it is created, not asked for at authorization, so a
 * grant is checked against this list (see `missingScopes`). A `:write` scope implies its read.
 */
export const SCOPES = ["account", "repository:write", "pullrequest:write"] as const;

/** The required scopes a grant lacks. */
export function missingScopes(granted: readonly string[]): string[] {
  const have = new Set(granted);
  return SCOPES.filter(scope => !have.has(scope));
}

/** A workspace or repository slug: what Bitbucket allows in a path segment. */
const SLUG = /^[A-Za-z0-9_.-]+$/;

/** A parsed resource link. */
export type ResourceLink =
  | { kind: "repository"; workspace: string; repoSlug: string }
  | { kind: "pullRequest"; workspace: string; repoSlug: string; pullRequestId: number };

/** Reserved first path segments on bitbucket.org that are not workspaces. */
const NOT_WORKSPACES = new Set(["account", "dashboard", "site", "product", "repo", "workspace", "-"]);

/**
 * The repository or pull request a bitbucket.org link names, or null for anything else. Accepts
 * any page under a repository (e.g. `/src/main/README.md`) as the repository itself.
 */
export function parseResourceUrl(url: string): ResourceLink | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== WEB_ORIGIN) return null;
  const [workspace, rawRepo, section, id] = parsed.pathname.split("/").filter(Boolean);
  const repoSlug = rawRepo?.replace(/\.git$/, "");
  if (!workspace || !repoSlug || !SLUG.test(workspace) || !SLUG.test(repoSlug) || NOT_WORKSPACES.has(workspace)) {
    return null;
  }
  if (section === "pull-requests" && id !== undefined) {
    if (!/^\d+$/.test(id)) return null;
    return { kind: "pullRequest", workspace, repoSlug, pullRequestId: Number(id) };
  }
  return { kind: "repository", workspace, repoSlug };
}

/** The web page of a repository, by its `workspace/repo` full name. */
export const repositoryUrl = (fullName: string): string => `${WEB_ORIGIN}/${fullName}`;
