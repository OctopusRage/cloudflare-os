// A thin client for Bitbucket Cloud's REST API 2.0 and its git smart-HTTP endpoints, as one
// OAuth access token or one Atlassian API token. It knows paths, paging and errors; what the responses mean is
// bitbucket-normalize.ts's business, and who may ask is the gatekeeper's.
//
// Bitbucket answers some reads (a pull request's diff and diffstat) with a 302 to another API
// path. Redirects are followed by hand and only within the API origin, so the bearer token never
// travels to a host it was not meant for.

import { API_ROOT, WEB_ORIGIN } from "./bitbucket-env";

const API_ORIGIN = new URL(API_ROOT).origin;
const USER_AGENT = "cloudflare-os-gatekeeper-bitbucket";
const REQUEST_TIMEOUT_MS = 30_000;
/** Longer than a REST call: the signal also covers streaming a pack. */
const GIT_TIMEOUT_MS = 5 * 60_000;
const MAX_REDIRECTS = 3;

/** A Bitbucket HTTP failure. `status` is the HTTP status; the message is safe to show. */
export class BitbucketApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "BitbucketApiError";
  }
}

/** Whether Bitbucket refused the credentials themselves (as opposed to one resource). */
export function isAuthError(error: unknown): boolean {
  return error instanceof BitbucketApiError && error.status === 401;
}

/** Whether Bitbucket definitely refused this user one resource: 403, or 404 for one it hides. */
export function isDenial(error: unknown): boolean {
  return error instanceof BitbucketApiError && (error.status === 403 || error.status === 404);
}

/** Whether the resource is not there (or hidden from this user). */
export function isNotFound(error: unknown): boolean {
  return error instanceof BitbucketApiError && error.status === 404;
}

/** One page of a Bitbucket listing. `next` is the full URL of the following page, when any. */
export type Page<T> = { values: T[]; next?: string };

type Query = Record<string, string | number | readonly string[] | undefined>;

/** Percent-encodes one path segment; Bitbucket UUIDs keep their braces, encoded. */
export const seg = (value: string): string => encodeURIComponent(value);

function withQuery(url: URL, query: Query | undefined): URL {
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
    else url.searchParams.set(key, String(value));
  }
  return url;
}

async function errorOf(response: Response, what: string): Promise<BitbucketApiError> {
  let detail = "";
  try {
    const body = await response.json() as { error?: { message?: unknown } };
    if (typeof body?.error?.message === "string") detail = body.error.message.slice(0, 300);
  } catch {
    // Not JSON; the status says enough.
  }
  return new BitbucketApiError(response.status,
    `Bitbucket ${what} failed (HTTP ${response.status})${detail ? `: ${detail}` : "."}`);
}

/**
 * How a request authenticates: an OAuth access token alone, or an Atlassian API token with the
 * email of the account it belongs to.
 */
export type BitbucketAuth = { accessToken: string; email?: string };

export class BitbucketApi {
  readonly #restAuth: string;
  readonly #gitAuth: string;

  constructor(auth: BitbucketAuth) {
    if (auth.email !== undefined) {
      // An Atlassian API token is Basic auth: the account email for REST, and a fixed username
      // for git over HTTPS. It is refused as a bearer token.
      this.#restAuth = `Basic ${btoa(`${auth.email}:${auth.accessToken}`)}`;
      this.#gitAuth = `Basic ${btoa(`x-bitbucket-api-token-auth:${auth.accessToken}`)}`;
    } else {
      // An OAuth access token authenticates git over HTTPS as the `x-token-auth` user.
      this.#restAuth = `Bearer ${auth.accessToken}`;
      this.#gitAuth = `Basic ${btoa(`x-token-auth:${auth.accessToken}`)}`;
    }
  }

  /** Sends one API request, following same-origin redirects. `path` is under `/2.0` or a full API URL. */
  async #request(pathOrUrl: string, init: { method?: string; query?: Query; body?: unknown; accept?: string } = {}):
      Promise<Response> {
    let url = withQuery(new URL(pathOrUrl.startsWith("https://") ? pathOrUrl : `${API_ROOT}${pathOrUrl}`), init.query);
    if (url.origin !== API_ORIGIN) throw new Error(`Refusing to send a Bitbucket token to ${url.origin}.`);
    for (let hop = 0; ; hop++) {
      const response = await fetch(url.toString(), {
        method: init.method ?? "GET",
        headers: {
          Authorization: this.#restAuth,
          Accept: init.accept ?? "application/json",
          "User-Agent": USER_AGENT,
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status < 300 || response.status >= 400) return response;
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      if (!location || hop >= MAX_REDIRECTS || (init.method ?? "GET") !== "GET") {
        throw new BitbucketApiError(response.status, "Bitbucket redirected a request unexpectedly.");
      }
      url = new URL(location, url);
      if (url.origin !== API_ORIGIN) throw new BitbucketApiError(response.status, "Bitbucket redirected off its API.");
    }
  }

  /** GETs JSON. */
  async get<T>(path: string, query?: Query): Promise<T> {
    const response = await this.#request(path, { query });
    if (!response.ok) throw await errorOf(response, `GET ${new URL(path, API_ROOT).pathname}`);
    return await response.json() as T;
  }

  /** GETs JSON, or null on a 404. */
  async find<T>(path: string, query?: Query): Promise<T | null> {
    try {
      return await this.get<T>(path, query);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** GETs text, e.g. a diff. */
  async getText(path: string, query?: Query): Promise<string> {
    const response = await this.#request(path, { query, accept: "text/plain" });
    if (!response.ok) throw await errorOf(response, `GET ${new URL(path, API_ROOT).pathname}`);
    return await response.text();
  }

  /**
   * One page of a listing: the first, from `path` and `query`, or a later one from the `next` URL
   * an earlier page returned (which carries its own query).
   */
  async page<T>(path: string, query: Query, next?: string): Promise<Page<T>> {
    const body = next === undefined
      ? await this.get<{ values?: T[]; next?: string }>(path, query)
      : await this.get<{ values?: T[]; next?: string }>(next);
    return { values: body.values ?? [], ...(body.next ? { next: body.next } : {}) };
  }

  /** Sends a write. Returns the JSON body, or null for an empty one. */
  async send<T>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T | null> {
    const response = await this.#request(path, { method, body });
    if (!response.ok) throw await errorOf(response, `${method} ${new URL(path, API_ROOT).pathname}`);
    const text = await response.text();
    return text ? JSON.parse(text) as T : null;
  }

  // -- git smart HTTP -----------------------------------------------------------------------

  /** POSTs a protocol v2 `upload-pack` request for `workspace/repo`, returning the raw response. */
  async fetchGitUploadPack(fullName: string, requestBody: Uint8Array): Promise<Response> {
    return await this.#gitPost(fullName, "git-upload-pack", requestBody, {
      "Content-Type": "application/x-git-upload-pack-request",
      Accept: "application/x-git-upload-pack-result",
      "Git-Protocol": "version=2",
    });
  }

  /** POSTs a classic `receive-pack` request (there is no v2 for receive-pack). */
  async fetchGitReceivePack(fullName: string, requestBody: ReadableStream<Uint8Array> | Uint8Array): Promise<Response> {
    return await this.#gitPost(fullName, "git-receive-pack", requestBody, {
      "Content-Type": "application/x-git-receive-pack-request",
      Accept: "application/x-git-receive-pack-result",
    });
  }

  async #gitPost(fullName: string, service: string, body: Uint8Array | ReadableStream<Uint8Array>,
                 headers: Record<string, string>): Promise<Response> {
    const [workspace, repo] = fullName.split("/");
    const response = await fetch(`${WEB_ORIGIN}/${seg(workspace)}/${seg(repo)}.git/${service}`, {
      method: "POST",
      headers: { ...headers, Authorization: this.#gitAuth, "User-Agent": USER_AGENT },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new BitbucketApiError(response.status, `git ${service} was redirected; the repository may have moved.`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new BitbucketApiError(response.status, `git ${service} failed (HTTP ${response.status}).`);
    }
    return response;
  }
}
