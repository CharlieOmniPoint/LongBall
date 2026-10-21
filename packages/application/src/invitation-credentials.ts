/** Only the service's CSPRNG may issue real credentials. Encoding checks do not prove entropy. */
export const INVITATION_TOKEN_BYTES = 32;
export const INVITATION_CREDENTIAL_DOMAIN =
  "longball.spectator-invitation.v1\0";
export type InvitationCredential =
  | { kind: "sha256"; version: 1; tokenHash: string }
  | {
      kind: "legacy_retired";
      version: 1;
      redactedAtMs: number;
      fingerprint: string;
      requiresReissue: boolean;
    }
  | { kind: "fictional_review"; version: 1; code: string };
export interface CredentialInvitation {
  id: string;
  teamId: string;
  seasonId: string;
  inviterAccountId: string;
  credential: InvitationCredential;
  createdAtMs: number;
  expiresAtMs: number;
  acceptedBy: string | null;
  acceptedAtMs: number | null;
  revokedAtMs: number | null;
  reissuedFromInvitationId: string | null;
}
export interface InvitationLookupState {
  invitations: readonly CredentialInvitation[];
  seasons: readonly { id: string; teamId: string; accessEndsAtMs: number }[];
}
export interface InvitationScope {
  teamId: string;
  seasonId: string;
}
export function isCanonicalInvitationToken(token: unknown): token is string {
  // Exactly 32 bytes encoded as unpadded base64url. Tail bits must be canonical.
  return (
    typeof token === "string" &&
    token.length === 43 &&
    !/[^A-Za-z0-9_-]/.test(token) &&
    "AEIMQUYcgkosw048".includes(token[42])
  );
}
export function invitationTokenHashInput(token: string): string {
  if (!isCanonicalInvitationToken(token))
    throw new Error("The invitation credential is unavailable.");
  return INVITATION_CREDENTIAL_DOMAIN + token;
}
export function isInvitationTokenHash(hash: unknown): hash is string {
  return (
    typeof hash === "string" && hash.length === 64 && !/[^a-f0-9]/.test(hash)
  );
}
const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0;
function sameHash(left: string, right: string): boolean {
  let difference = 0;
  for (let index = 0; index < 64; index += 1)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
/** Internal verifier lookup. A client-provided digest is NEVER an acceptance credential. */
export function pendingInvitation(
  state: InvitationLookupState,
  tokenHash: string,
  nowMs: number,
  scope?: InvitationScope,
): Readonly<CredentialInvitation> | null {
  if (!isInvitationTokenHash(tokenHash) || !validTime(nowMs)) return null;
  const matches = state.invitations.filter(
    (invite) =>
      invite.credential?.kind === "sha256" &&
      invite.credential.version === 1 &&
      isInvitationTokenHash(invite.credential.tokenHash) &&
      sameHash(invite.credential.tokenHash, tokenHash),
  );
  if (matches.length !== 1) return null;
  const invite = matches[0];
  if (
    scope &&
    (invite.teamId !== scope.teamId || invite.seasonId !== scope.seasonId)
  )
    return null;
  if (
    invite.acceptedBy !== null ||
    invite.acceptedAtMs !== null ||
    invite.revokedAtMs !== null ||
    !validTime(invite.createdAtMs) ||
    invite.createdAtMs > nowMs ||
    !validTime(invite.expiresAtMs) ||
    invite.expiresAtMs <= nowMs
  )
    return null;
  const seasons = state.seasons.filter(
    (season) =>
      season.id === invite.seasonId && season.teamId === invite.teamId,
  );
  if (
    seasons.length !== 1 ||
    !validTime(seasons[0].accessEndsAtMs) ||
    seasons[0].accessEndsAtMs <= nowMs ||
    invite.expiresAtMs > seasons[0].accessEndsAtMs
  )
    return null;
  return invite;
}
/** Allowlist presentation fields; no verifier or secret reaches DTOs or retained receipts. */
export function publicInvitation(invite: CredentialInvitation, nowMs: number) {
  if (!validTime(nowMs))
    throw new Error("A valid invitation observation is required.");
  const legacy =
    !invite.credential || invite.credential.kind === "legacy_retired";
  const state =
    invite.revokedAtMs !== null
      ? "revoked"
      : invite.acceptedBy !== null
        ? "accepted"
        : legacy
          ? "requires_reissue"
          : invite.expiresAtMs <= nowMs
            ? "expired"
            : "pending";
  return {
    id: invite.id,
    teamId: invite.teamId,
    seasonId: invite.seasonId,
    inviterAccountId: invite.inviterAccountId,
    createdAtMs: invite.createdAtMs,
    expiresAtMs: invite.expiresAtMs,
    acceptedBy: invite.acceptedBy,
    acceptedAtMs: invite.acceptedAtMs,
    revokedAtMs: invite.revokedAtMs,
    reissuedFromInvitationId: invite.reissuedFromInvitationId ?? null,
    state,
    requiresReissue: !invite.credential
      ? invite.acceptedBy === null && invite.revokedAtMs === null
      : invite.credential.kind === "legacy_retired" &&
        invite.credential.requiresReissue,
  };
}
export interface InviteWrite {
  seasonId: string;
  expiresInHours?: number;
}
export interface InviteCreated {
  id: string;
  shareUrl: string;
  expiresAt: string;
  teamId: string;
  seasonId: string;
}
export interface RedactedInviteReceipt {
  id: string;
  expiresAt: string;
  teamId: string;
  seasonId: string;
  credentialAvailable: false;
  requiresReissue: true;
}
export function redactInviteCreated(
  receipt: InviteCreated,
): RedactedInviteReceipt {
  return {
    id: receipt.id,
    expiresAt: receipt.expiresAt,
    teamId: receipt.teamId,
    seasonId: receipt.seasonId,
    credentialAvailable: false,
    requiresReissue: true,
  };
}
export interface InvitationActivationPreflight {
  invitationId: string;
  expiresAt: string;
  policyVersion: string;
}
