// What the account Durable Object shares with the rest of the Worker: the public view of a grant,
// the connected identity, the subresource IDs every read reports, the verifier's own methods, and
// a credential source over one account. Kept apart from bitbucket.ts so the gatekeeper, session
// and configurator modules can use them without an import cycle.

import { CredentialSource } from "@gadgets/gatekeeper-kit/credentials";
import { formatSubresourceId, parseSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";
import type { GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import { isAuthError } from "./bitbucket-api";
import { VENDOR_ID } from "./bitbucket-env";

/** What the gadget is told when the connection no longer works. */
export const RECONNECT_MESSAGE =
  "The Bitbucket connection has expired or was revoked. Reconnect the Bitbucket account.";

/**
 * What a facet sees of the grant: the refresh token never crosses the account boundary. `email`
 * is set for a connection made with an Atlassian API token, whose `accessToken` is that token.
 */
export type PublicGrant = { accessToken: string; expiresAt?: number; email?: string };

/** The connected Bitbucket user, as the account last read them. */
export type Identity = {
  /** Bitbucket's user UUID, braces included, e.g. `{889f…}`; what a connection is pinned to. */
  userUuid: string;
  accountId?: string;
  displayName: string;
  nickname: string;
  avatarUrl?: string;
  fetchedAt: number;
};

/** The `UserAccount` holding the connection `userObjectId` names. */
export const accountStub = (exports: Cloudflare.Exports, userObjectId: string) =>
  exports.UserAccount.get(exports.UserAccount.idFromString(userObjectId));

/** Credentials for the account behind `userObjectId`, as a facet or entrypoint reads them. */
export function accountSource(exports: Cloudflare.Exports, userObjectId: string): CredentialSource<PublicGrant> {
  return new CredentialSource<PublicGrant>({
    // A fresh stub per read: a source can outlive the request that made it.
    account: () => accountStub(exports, userObjectId),
    isAuthError,
    expiredMessage: RECONNECT_MESSAGE,
    vendorId: VENDOR_ID,
  });
}

// ---------------------------------------------------------------------------
// Subresources
//
// Every read through a binding depends on one repository, and only on it: a pull request, its
// comments and its diff are visible to exactly who can read the repository. So the one
// subresource is the repository, named by the UUIDs Bitbucket never reassigns (slugs can be
// renamed, and a deleted repository's slug reused).

/** One repository, by its workspace's and its own UUID, braces included. */
export type RepositoryKey = { workspaceUuid: string; repoUuid: string };

const UUID = /^\{[0-9a-f-]{36}\}$/;
const bare = (uuid: string): string => uuid.slice(1, -1);

/** The subresource ID of a repository: `workspace/<uuid>/repository/<uuid>` (braces dropped). */
export function subresourceId(key: RepositoryKey): string {
  if (!UUID.test(key.workspaceUuid) || !UUID.test(key.repoUuid)) throw new Error("Not a Bitbucket UUID.");
  return formatSubresourceId({
    fragments: [{ name: "workspace", id: bare(key.workspaceUuid) }, { name: "repository", id: bare(key.repoUuid) }],
  });
}

/**
 * The repository a {@link subresourceId} ID names.
 * @throws Error for any other ID, or a spelling other than the canonical one.
 */
export function parseSubresource(id: string): RepositoryKey {
  const { namespace, fragments: [workspace, repository, ...rest] } = parseSubresourceId(id);
  if (namespace !== undefined || rest.length > 0 || workspace?.name !== "workspace" || repository?.name !== "repository") {
    throw new Error("Not a Bitbucket subresource ID.");
  }
  const key = { workspaceUuid: `{${workspace.id}}`, repoUuid: `{${repository.id}}` };
  if (!UUID.test(key.workspaceUuid) || !UUID.test(key.repoUuid)) throw new Error("Not a Bitbucket subresource ID.");
  return key;
}

/** The Bitbucket gatekeeper's own methods on its verifier, which the overseer hands back only to us. */
export interface BitbucketVerifierApi extends GatekeeperUserVerifier {
  /**
   * Whether the observer's own connection can read each subresource, in order (see
   * `UserAccount.checkSubresourceAccess`). Throws for an ID it can't check, or when access can't
   * be determined.
   */
  checkSubresourceAccess(subresources: string[]): Promise<boolean[]>;
}
