// The Bitbucket gatekeeper's main module: the HTTP entrypoint (connect link and OAuth callback),
// the vendor and per-account entrypoints, the account Durable Object that holds the OAuth grant,
// and the observer verifier. The per-binding gatekeeper Durable Object and its sessions live in
// bitbucket-gatekeeper.ts and bitbucket-sessions.ts, re-exported here so wrangler finds every
// class on the main module.
//
// A connection is a Bitbucket Cloud OAuth 2.0 consumer grant. Access tokens live two hours and
// are refreshed through the kit's `CredentialCoordinator`; Bitbucket documents no revocation
// endpoint, so a disconnect forgets the grant. The consumer's permissions are fixed when it is
// created, so a grant is checked against the scopes the token response reports. A connection is
// pinned to the Bitbucket user (`GET /user`'s UUID) it was made as, and a reconnect that comes
// back as anyone else is refused.

import { DurableObject, RpcStub, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ConnectHandoff,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  GatekeeperVendor as GatekeeperVendorIface,
  ResourceConfiguratorFrame,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { workerVersionTag } from "@gadgets/workshop-shared/gatekeeper";
import { KvTtlCache } from "@gadgets/gatekeeper-kit/cache";
import {
  connectHandoffPageHtml, errorPageHtml, htmlResponse, INVALID_LINK_HTML,
} from "@gadgets/gatekeeper-kit/connect-pages";
import { NONCE_KEY, advanceToOAuth, claimOAuth, putInitiation } from "@gadgets/gatekeeper-kit/connect-handshake";
import { CONNECT_TIMEOUT_MS, NONCE_BYTES, generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import {
  CredentialCoordinator,
  CredentialSource,
  CredentialsExpiredError,
  isConnectionSuperseded,
  isCredentialsExpired,
  type CredentialsWithIdentity,
  type RejectionVerdict,
} from "@gadgets/gatekeeper-kit/credentials";
import { notifyCredentialsExpiredOnce } from "@gadgets/gatekeeper-kit/credential-expiry";
import { commitStagedCredentials, discardStagedCredentials, stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import { OAuthClient, mergeOAuthTokens, oauthRefresh, type OAuthTokens } from "@gadgets/gatekeeper-kit/oauth-client";
import { PreviewOAuth, PreviewOAuthConfigurationError } from "@gadgets/gatekeeper-kit/preview-oauth";
import { BitbucketApi, isAuthError, isDenial, seg } from "./bitbucket-api";
import { BitbucketConfiguratorUI } from "./bitbucket-configurator";
import {
  RECONNECT_MESSAGE,
  accountSource,
  accountStub,
  parseSubresource,
  subresourceId,
  type BitbucketVerifierApi,
  type Identity,
  type PublicGrant,
  type RepositoryKey,
} from "./bitbucket-credentials";
import {
  ALL_RESOURCES,
  AUTHORIZE_URL,
  RESOURCES,
  TOKEN_URL,
  VENDOR_ID,
  getBasePath,
  getBaseUrl,
  getRedirectUri,
  missingScopes,
  parseResourceUrl,
  type BitbucketGatekeeperImplProps,
  type Env,
} from "./bitbucket-env";
import type { WireUser } from "./bitbucket-normalize";
import { obsContext } from "./observability";
import BITBUCKET_LOGO_SVG from "./bitbucket-logo.svg";
import TYPES_CODE from "./types.txt";
import REPOSITORY_CONFIGURATOR_HTML from "./generated/bitbucket-repository-configurator-ui.txt";
import PULL_REQUEST_CONFIGURATOR_HTML from "./generated/bitbucket-pull-request-configurator-ui.txt";

export { BitbucketGatekeeperImpl } from "./bitbucket-gatekeeper";

const logger = obsContext.createLogger({ component: "gatekeeper.bitbucket", vendorId: VENDOR_ID });

const LOGO_URL = `data:image/svg+xml,${encodeURIComponent(BITBUCKET_LOGO_SVG)}`;

/** How long the connected user's details are served before they are read from Bitbucket again. */
const IDENTITY_TTL_MS = 24 * 60 * 60 * 1000;
/** Bitbucket's documented access-token lifetime, for a response that omits `expires_in`. */
const ACCESS_TOKEN_SECONDS = 2 * 60 * 60;

/**
 * How long an observer-access answer is reused, by whether it allowed. Bitbucket doesn't say when
 * a repository permission changes, so a removal is noticed once the allowance expires, while a
 * denial is kept only briefly so a new grant is noticed soon.
 */
const ACCESS_ALLOWED_TTL_MS = 15 * 60_000;
const ACCESS_DENIED_TTL_MS = 15_000;
const accessTtl = (allowed: boolean): number => allowed ? ACCESS_ALLOWED_TTL_MS : ACCESS_DENIED_TTL_MS;
/** How many repositories an access check probes at once. */
const PROBE_CONCURRENCY = 6;

/**
 * Whether Bitbucket opens a repository for the user whose token this is: a 403 or 404 is a
 * definite no, and any other failure leaves access undetermined, so it throws.
 */
async function probe(accessToken: string, { workspaceUuid, repoUuid }: RepositoryKey): Promise<boolean> {
  try {
    await new BitbucketApi(accessToken).get(`/repositories/${seg(workspaceUuid)}/${seg(repoUuid)}`, { fields: "uuid" });
    return true;
  } catch (error) {
    if (isDenial(error)) return false;
    throw error;
  }
}

/** The stored grant. The refresh token is never sent across the account boundary. */
type Grant = { accessToken: string; refreshToken?: string; expiresAt?: number; scopes: string[] };

/** What a connect attempt carries from the authorize redirect to the callback. */
type ConnectAttempt = {
  /** The `redirect_uri` the authorize request carried, which the code exchange must repeat. */
  redirectUri: string;
  /** The connection generation the attempt began under; a disconnect or reconnect since wins. */
  startedUnder: string;
  /** Set when the link was minted to connect a new account, whose grant goes live. */
  firstConnect?: true;
};

/** A reconnect's grant, staged until the Workshop confirms the browser that finished it. */
type ReconnectStage = { grant: Grant; identity: Identity; startedUnder: string };

/** How the callback ended: a handoff for the browser, or a refusal to show it. */
type CallbackResult = { handoff: ConnectHandoff } | { refused: { title: string; detail: string } };

const NOT_CONFIGURED_HTML = errorPageHtml(
  "Bitbucket gatekeeper not configured",
  "Configure a Bitbucket OAuth consumer key and secret for this gatekeeper.");

/** The Bitbucket OAuth consumer, built from this Worker's secrets. */
function oauthClient(env: Env): OAuthClient {
  if (!env.CLIENT_ID || !env.CLIENT_SECRET) throw new Error("The Bitbucket gatekeeper is not configured.");
  return new OAuthClient({
    label: "Bitbucket",
    client: { method: "basic", id: env.CLIENT_ID, secret: env.CLIENT_SECRET },
    tokenEndpoint: TOKEN_URL,
    authorizationEndpoint: AUTHORIZE_URL,
    defaultExpiresIn: ACCESS_TOKEN_SECONDS,
  });
}

/** Bitbucket reports a grant's scopes as a space-separated `scopes`, not OAuth's `scope`. */
function grantedScopes(tokens: OAuthTokens): string[] {
  if (tokens.scopes) return tokens.scopes;
  const raw = tokens.raw.scopes;
  return typeof raw === "string" ? raw.split(/\s+/).filter(Boolean) : [];
}

function toGrant(tokens: OAuthTokens): Grant {
  return {
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
    scopes: grantedScopes(tokens),
  };
}

/** Reads the user a token belongs to. */
async function fetchUser(accessToken: string): Promise<Identity> {
  const user = await new BitbucketApi(accessToken).get<WireUser>("/user");
  if (!user.uuid) throw new Error("Bitbucket did not say which user this connection belongs to.");
  return {
    userUuid: user.uuid,
    ...(user.account_id ? { accountId: user.account_id } : {}),
    displayName: user.display_name ?? user.nickname ?? "Bitbucket user",
    nickname: user.nickname ?? user.display_name ?? "",
    ...(user.links?.avatar?.href ? { avatarUrl: user.links.avatar.href } : {}),
    fetchedAt: Date.now(),
  };
}

/** The OAuth callback policy: direct in production, a relay through the stable Worker on a preview. */
function previewOAuthFor(env: Env): PreviewOAuth | Response {
  try {
    return new PreviewOAuth({ callbackUri: getRedirectUri(env), env });
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "The Bitbucket OAuth callback is not configured.",
      { status: 503 });
  }
}

/** The account a connect link or callback state names; null when the id is not one of ours. */
function accountFor(ctx: ExecutionContext, doId: string): DurableObjectStub<UserAccount> | null {
  try {
    return accountStub(ctx.exports, doId);
  } catch {
    return null;
  }
}

/** The `UserAccount` an entrypoint's props name. */
function accountOf(ctx: ExecutionContext<{ userObjectId: string }>): DurableObjectStub<UserAccount> {
  return accountStub(ctx.exports, ctx.props.userObjectId);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }

    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");

    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) return htmlResponse(NOT_CONFIGURED_HTML);
      const previewOAuth = previewOAuthFor(env);
      if (previewOAuth instanceof Response) return previewOAuth;
      const begun = await accountFor(ctx, path[0])?.beginOAuthFlow(path[1], previewOAuth.redirectUri);
      if (!begun) return htmlResponse(INVALID_LINK_HTML);
      // No `scope` and no PKCE: a Bitbucket consumer's permissions are fixed on the consumer, and
      // Bitbucket Cloud's authorization server does not take a code challenge.
      const authorize = oauthClient(env).authorizationUrl({
        redirectUri: previewOAuth.redirectUri,
        state: await previewOAuth.createAuthorizationState({ userObjectId: path[0], oauthNonce: begun.oauthNonce }),
      });
      return Response.redirect(authorize.toString(), 302);
    }

    if (relPath === "/oauth") {
      const previewOAuth = previewOAuthFor(env);
      if (previewOAuth instanceof Response) return previewOAuth;
      let doId: string;
      let oauthNonce: string;
      try {
        const result = await previewOAuth.handleCallback(url);
        if (result.kind === "relay") return result.response;
        ({ userObjectId: doId, oauthNonce } = result.state);
      } catch (error) {
        if (error instanceof PreviewOAuthConfigurationError) return new Response(error.message, { status: 500 });
        return new Response("Error: malformed state", { status: 400 });
      }
      const stub = accountFor(ctx, doId);
      if (stub === null) return new Response("Error: malformed state", { status: 400 });

      if (url.searchParams.get("error")) {
        // The refusal ends the attempt: its nonce is consumed so a replayed callback cannot resume it.
        if (!await stub.consumeOAuthNonce(oauthNonce)) return htmlResponse(INVALID_LINK_HTML);
        return htmlResponse(errorPageHtml(
          "Bitbucket authorization was not granted", "Start the connection again from the Workshop."), 400);
      }
      const code = url.searchParams.get("code");
      if (!code) return new Response("Error: no 'code' provided", { status: 400 });

      const result = await stub.acceptAuthCode(code, oauthNonce);
      if (result === null) return htmlResponse(INVALID_LINK_HTML);
      if ("refused" in result) return htmlResponse(errorPageHtml(result.refused.title, result.refused.detail), 409);
      return htmlResponse(connectHandoffPageHtml(result.handoff));
    }

    return new Response("Not Found", { status: 404 });
  },
};

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Bitbucket",
      url: "https://bitbucket.org",
      logo: { url: LOGO_URL },
      color: "#e9f2ff",
      tagline: "Work on Bitbucket Cloud repositories and pull requests",
      description:
        "Connect your Bitbucket account so Cloudflare OS can read repositories, branches, commits, " +
        "build statuses and pull requests, mount commits as worktrees, and push branches, open " +
        "pull requests and comment once you approve.",
    };
  }

  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       _options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    // Every resource type needs the same consumer permissions, so `options` narrows nothing.
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const initiationNonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return ALL_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

export class UserAccount extends DurableObject<Env> {
  readonly #creds = new CredentialCoordinator<Grant>(this.ctx.storage.kv, {
    expiresAt: grant => grant.expiresAt,
    vendorId: VENDOR_ID,
  });

  readonly #refresh = (grant: Grant): Promise<Grant> => {
    logger.info("refreshing Bitbucket access token", { event: "bitbucket.token.refresh" });
    return oauthRefresh<Grant>(oauthClient(this.env), {
      refreshToken: current => current.refreshToken,
      merge: mergeOAuthTokens,
      expiredMessage: RECONNECT_MESSAGE,
    })(grant);
  };

  readonly #notify = (): Promise<void> => notifyCredentialsExpiredOnce(this.ctx.storage.kv,
    this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback"), VENDOR_ID);

  // The account's own Bitbucket reads (its user, its observer probes) run through the same
  // rejection handling as a facet's: a refused token is refreshed, or the grant marked dead and the
  // user asked to reconnect.
  readonly #source = new CredentialSource<PublicGrant>({
    account: () => this,
    isAuthError,
    expiredMessage: RECONNECT_MESSAGE,
    vendorId: VENDOR_ID,
  });

  // This account's answers about its own access to repositories, partitioned by the connection
  // that learned them, so none outlives a disconnect or survives a reconnect. Bypassed while the
  // account holds no grant.
  readonly #access = new KvTtlCache(this.ctx.storage.kv,
    () => this.#creds.stored() ? this.#creds.connectionGeneration() : undefined, { name: "access" });

  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string): Promise<void> {
    if (!this.#creds.stored()) await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    this.ctx.storage.kv.put("callback", callback);
    putInitiation<Pick<ConnectAttempt, "firstConnect">>(this.ctx.storage.kv, initiationNonce, Date.now(),
      { firstConnect: true });
  }

  /** Arms a reconnect flow. */
  async prepareReconnect(initiationNonce: string): Promise<void> {
    putInitiation(this.ctx.storage.kv, initiationNonce, Date.now());
  }

  /** Swaps the initiation nonce for the OAuth-stage nonce. */
  async beginOAuthFlow(initiationNonce: string, redirectUri: string): Promise<{ oauthNonce: string } | null> {
    // Reading the generation below writes one, which an old link to a deleted account must not.
    if (this.ctx.storage.kv.get(NONCE_KEY) === undefined) return null;
    const oauthNonce = advanceToOAuth<ConnectAttempt>(this.ctx.storage.kv, initiationNonce, Date.now(), {
      redirectUri,
      startedUnder: this.#creds.connectionGeneration(),
    });
    return oauthNonce === null ? null : { oauthNonce };
  }

  /** Ends an attempt Bitbucket refused; returns whether `oauthNonce` named the live one. */
  async consumeOAuthNonce(oauthNonce: string): Promise<boolean> {
    return claimOAuth(this.ctx.storage.kv, oauthNonce, Date.now()) !== null;
  }

  /**
   * Finishes the code exchange. Bitbucket documents no token revocation, so a grant this refuses
   * is dropped rather than revoked.
   * @returns The handoff, a refusal to show, or null when the callback's nonce doesn't match.
   */
  async acceptAuthCode(code: string, oauthNonce: string): Promise<CallbackResult | null> {
    const kv = this.ctx.storage.kv;
    const attempt = claimOAuth<ConnectAttempt>(kv, oauthNonce, Date.now());
    if (attempt === null) return null;
    const tokens = await oauthClient(this.env).exchangeCode({ code, redirectUri: attempt.redirectUri });
    const grant = toGrant(tokens);

    const missing = missingScopes(grant.scopes);
    if (missing.length > 0) {
      return {
        refused: {
          title: "The Bitbucket OAuth consumer is missing permissions",
          detail: `Bitbucket didn't grant ${missing.join(", ")}. Ask whoever created the OAuth consumer to ` +
            "give it Account Read, Repositories Write and Pull requests Write, then connect again.",
        },
      };
    }
    let identity: Identity;
    try {
      identity = await fetchUser(grant.accessToken);
    } catch (error) {
      throw new Error("Could not read which Bitbucket user authorized this connection. Please try again.",
        { cause: error });
    }

    const callback = kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (callback === undefined) {
      throw new Error("The Bitbucket account was disconnected while it was being authorized. Connect it again.");
    }

    let handoff: ConnectHandoff;
    if (!attempt.firstConnect) {
      const pinned = kv.get<Identity>("identity");
      if (pinned !== undefined && pinned.userUuid !== identity.userUuid) {
        return {
          refused: {
            title: "That's a different Bitbucket user",
            detail: `This connection is for ${pinned.nickname}, but Bitbucket authorized ` +
              `${identity.nickname}. Sign in to Bitbucket as ${pinned.nickname} and reconnect, or ` +
              "connect the other user as a separate account.",
          },
        };
      }
      // The reconnect URL is a bearer capability, so the new grant is only staged until the
      // Workshop has confirmed the browser that finished the flow is the owner's.
      discardStagedCredentials<ReconnectStage>(kv);
      const stageId = stageCredentials<ReconnectStage>(kv,
        { grant, identity, startedUnder: attempt.startedUnder }, Date.now());
      handoff = await callback.reconnectComplete(stageId);
    } else {
      try {
        this.#creds.connect(grant, { ifGeneration: attempt.startedUnder });
      } catch (error) {
        if (!isConnectionSuperseded(error)) throw error;
        throw new Error("The Bitbucket account was disconnected while it was being authorized. Connect it again.",
          { cause: error });
      }
      kv.put<Identity>("identity", identity);
      try {
        const props = { userObjectId: this.ctx.id.toString() };
        handoff = await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }));
      } catch (error) {
        // A connection the Workshop never took leaves its grant with nobody: drop it.
        this.#creds.clear();
        kv.delete("identity");
        throw error;
      }
    }
    await this.ctx.storage.deleteAlarm();
    return { handoff };
  }

  /**
   * Makes the grant staged under `stageId` live. One a newer reconnect overtook is discarded, and
   * the connection stays pinned to the user it was made with.
   */
  async commitReconnect(stageId: string): Promise<void> {
    const staged = commitStagedCredentials<ReconnectStage>(this.ctx.storage.kv, Date.now(), stageId);
    if (!staged) throw new Error("No reconnect is awaiting confirmation. Please try again.");
    try {
      this.#creds.connect(staged.grant, { ifGeneration: staged.startedUnder });
    } catch (error) {
      if (!isConnectionSuperseded(error)) throw error;
      throw new Error("This Bitbucket account was reconnected again while this reconnect was finishing, " +
        "so this one was discarded.", { cause: error });
    }
    this.ctx.storage.kv.put<Identity>("identity", staged.identity);
  }

  /** The credential triple a facet's `CredentialSource` reads, refresh material projected out. */
  async getCredentials(): Promise<CredentialsWithIdentity<PublicGrant>> {
    let snapshot: CredentialsWithIdentity<Grant>;
    try {
      snapshot = await this.#creds.snapshot(this.#refresh, { notify: this.#notify });
    } catch (error) {
      // A dead grant, a disconnect, a revoke mid-refresh: to the gadget each means one thing.
      if (isCredentialsExpired(error)) throw new CredentialsExpiredError(RECONNECT_MESSAGE, { cause: error });
      throw error;
    }
    const { creds: { accessToken, expiresAt }, identity, generation } = snapshot;
    return { creds: { accessToken, ...(expiresAt !== undefined ? { expiresAt } : {}) }, identity, generation };
  }

  /** Adjudicates Bitbucket's refusal of the credential with `identity`. */
  async reportCredentialsRejected(identity: string): Promise<RejectionVerdict> {
    return await this.#creds.adjudicateRejection(identity, { refresh: this.#refresh, notify: this.#notify });
  }

  /**
   * The connected user, read again from Bitbucket once a day old. A failed re-read serves the
   * stored copy.
   */
  async getIdentity(): Promise<Identity> {
    const stored = this.ctx.storage.kv.get<Identity>("identity");
    if (stored === undefined || !this.#creds.stored()) throw new CredentialsExpiredError(RECONNECT_MESSAGE);
    if (Date.now() - stored.fetchedAt < IDENTITY_TTL_MS) return stored;
    try {
      const fresh = await this.#source.run(creds => fetchUser(creds.accessToken), { replayable: true });
      if (fresh.userUuid !== stored.userUuid) throw new Error("Bitbucket described a different user than the grant's.");
      this.ctx.storage.kv.put<Identity>("identity", fresh);
      return fresh;
    } catch (error) {
      logger.warn("failed to refresh the Bitbucket identity", { event: "bitbucket.identity.refresh.failed", error });
      return stored;
    }
  }

  /**
   * Whether this connection can read each repository subresource (see `subresourceId`), in order:
   * whether Bitbucket opens it for this user, a 403 or 404 being a definite no. An allowed answer
   * is reused for up to 15 minutes and a denial for 15 seconds, until the next reconnect. Throws
   * for an ID it can't check, or when access can't be determined, which is never reused.
   */
  async checkSubresourceAccess(subresources: string[]): Promise<boolean[]> {
    // Parsed before anything is asked, so an ID this account can't check is refused outright.
    const parsed = subresources.map(parseSubresource);
    // A connection that is gone fails the check outright, rather than serve answers it cached.
    await this.getCredentials();
    const ids = [...new Set(parsed.map(subresourceId))];
    const allowed = new Map<string, boolean>();
    for (let start = 0; start < ids.length; start += PROBE_CONCURRENCY) {
      await Promise.all(ids.slice(start, start + PROBE_CONCURRENCY).map(async id => {
        allowed.set(id, await this.#access.cached(id, accessTtl, () =>
          this.#source.run(creds => probe(creds.accessToken, parseSubresource(id)), { replayable: true })));
      }));
    }
    return parsed.map(key => allowed.get(subresourceId(key))!);
  }

  async alarm(): Promise<void> {
    // Drop the account if the connect flow never completed.
    if (!this.#creds.stored()) await this.ctx.storage.deleteAll();
  }

  /**
   * Disconnects. Bitbucket documents no token revocation, so the grant is forgotten here and the
   * access token lapses within two hours. A user can revoke the consumer's access sooner from
   * their Bitbucket settings.
   */
  async revoke(): Promise<void> {
    this.#creds.clear();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

type GatekeeperUserImplProps = { userObjectId: string };

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    const identity = await accountOf(this.ctx).getIdentity();
    return {
      displayName: identity.displayName,
      uniqueName: identity.nickname ? `@${identity.nickname}` : identity.userUuid,
      avatar: { url: identity.avatarUrl ?? "" },
    };
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return ALL_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    const link = parseResourceUrl(url);
    if (!link) {
      throw new Error("Not a Bitbucket link this gatekeeper can bind: expected a repository " +
        "(https://bitbucket.org/<workspace>/<repo>) or a pull request in one.");
    }
    const base = { userObjectId: this.ctx.props.userObjectId, workspace: link.workspace, repoSlug: link.repoSlug };
    const props: BitbucketGatekeeperImplProps = link.kind === "repository"
      ? { ...base, resourceKind: "repository" }
      : { ...base, resourceKind: "pullRequest", pullRequestId: link.pullRequestId };
    return { class: this.ctx.exports.BitbucketGatekeeperImpl({ props }), resource: RESOURCES[link.kind] };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    const ui = () => new RpcStub(new BitbucketConfiguratorUI(accountSource(this.ctx.exports, this.ctx.props.userObjectId)));
    if (resourceUrlPattern === RESOURCES.repository.urlPattern) {
      return { iframeHtml: REPOSITORY_CONFIGURATOR_HTML, ui: ui() };
    }
    if (resourceUrlPattern === RESOURCES.pullRequest.urlPattern) {
      return { iframeHtml: PULL_REQUEST_CONFIGURATOR_HTML, ui: ui() };
    }
    throw new Error(`Unsupported Bitbucket resource configurator type: ${resourceUrlPattern}`);
  }

  async revoke(): Promise<void> {
    await accountOf(this.ctx).revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const initiationNonce = generateNonce();
    await accountOf(this.ctx).prepareReconnect(initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  async commitReconnect(stageId: string): Promise<void> {
    await accountOf(this.ctx).commitReconnect(stageId);
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    // A connection holds every scope or was refused, so it already covers every resource type.
    return {};
  }

  /** Mints a verifier for this account; see `BitbucketGatekeeperImpl.verifyObserverAccess`. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.BitbucketVerifier({ props: { userObjectId: this.ctx.props.userObjectId } });
  }
}

// ---------------------------------------------------------------------------
// Verifier
//
// Every read reports the one repository it depends on; an observer may see it only if their own
// connection can read that repository (see UserAccount.checkSubresourceAccess).

@validateRpc()
export class BitbucketVerifier extends WorkerEntrypoint<Env, GatekeeperUserImplProps> implements BitbucketVerifierApi {
  async checkSubresourceAccess(subresources: string[]): Promise<boolean[]> {
    return await accountOf(this.ctx).checkSubresourceAccess(subresources);
  }
}
