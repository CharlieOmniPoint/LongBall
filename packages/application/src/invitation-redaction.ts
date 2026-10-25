import type { CommunityState, SpectatorInvite } from "./community";
import {
  isInvitationTokenHash,
  publicInvitation,
  type CredentialInvitation,
  type InvitationCredential,
} from "./invitation-credentials";

export const LEGACY_INVITATION_FINGERPRINT_DOMAIN =
  "longball.spectator-invitation.legacy-retired.v1:";
export const LEGACY_INVITATION_COMMAND_DOMAIN =
  "longball.spectator-invitation.command-retired.v1:";
export const RETIRED_INVITATION_COMMAND_PREFIX =
  "invitation-command-retired:v1:";
export type InvitationDigest = (input: string) => string;

function checkedDigest(digest: InvitationDigest, input: string): string {
  const result = digest(input);
  if (!isInvitationTokenHash(result))
    throw new Error("The invitation retirement digest is unavailable.");
  return result;
}
export function legacyInvitationFingerprintInput(
  id: string,
  code: string,
): string {
  return `${LEGACY_INVITATION_FINGERPRINT_DOMAIN}${id.length}:${id}:${code}`;
}
export function redactLegacyInvitationCommand(
  value: string,
  digest: InvitationDigest,
): string {
  if (value.startsWith(RETIRED_INVITATION_COMMAND_PREFIX)) return value;
  let legacy = false;
  try {
    const parsed: unknown = JSON.parse(value);
    const command = Array.isArray(parsed) ? parsed[1] : null;
    legacy = Boolean(
      command &&
        typeof command === "object" &&
        ["invite.created", "invite.accepted"].includes(command.type) &&
        Object.hasOwn(command, "reviewCode"),
    );
  } catch {
    // Malformed imported history is not an authority and must not retain a recognizable secret.
    legacy = /"reviewCode"\s*:/.test(value);
  }
  return legacy
    ? RETIRED_INVITATION_COMMAND_PREFIX +
        checkedDigest(digest, LEGACY_INVITATION_COMMAND_DOMAIN + value)
    : value;
}

export interface InvitationRetirementEvidence {
  version: 1;
  atMs: number;
  invitationIds: string[];
  commandIds: string[];
}

/** Service migration only. Never invoke on the deliberately separate local fictional rehearsal. */
export function retireLegacyInvitationCredentials(
  state: CommunityState,
  atMs: number,
  digest: InvitationDigest,
): { state: CommunityState; evidence: InvitationRetirementEvidence } {
  if (!Number.isSafeInteger(atMs) || atMs < 0)
    throw new Error("A valid invitation retirement time is required.");
  const evidence: InvitationRetirementEvidence = {
    version: 1,
    atMs,
    invitationIds: [],
    commandIds: [],
  };
  const next: CommunityState = JSON.parse(JSON.stringify(state));
  next.invitations = next.invitations.map((invite) => {
    const raw = invite as Omit<CredentialInvitation, "credential"> & {
      credential?: InvitationCredential;
      reviewCode?: unknown;
    };
    const hasPlaintext =
      Object.hasOwn(raw, "reviewCode") ||
      raw.credential?.kind === "fictional_review";
    if (
      (raw.credential?.kind === "sha256" && !hasPlaintext) ||
      (raw.credential?.kind === "legacy_retired" && !hasPlaintext)
    )
      return invite;
    const code =
      typeof raw.reviewCode === "string"
        ? raw.reviewCode
        : raw.credential?.kind === "fictional_review"
          ? raw.credential.code
          : "";
    const requiresReissue =
      raw.acceptedBy === null &&
      raw.acceptedAtMs === null &&
      raw.revokedAtMs === null;
    evidence.invitationIds.push(raw.id);
    // Explicit allowlist also removes accidentally imported token/shareUrl fields.
    return {
      id: raw.id,
      teamId: raw.teamId,
      seasonId: raw.seasonId,
      inviterAccountId: raw.inviterAccountId,
      createdAtMs: raw.createdAtMs,
      expiresAtMs: raw.expiresAtMs,
      acceptedBy: raw.acceptedBy,
      acceptedAtMs: raw.acceptedAtMs,
      revokedAtMs: requiresReissue ? atMs : raw.revokedAtMs,
      reissuedFromInvitationId: raw.reissuedFromInvitationId ?? null,
      credential: {
        kind: "legacy_retired",
        version: 1,
        redactedAtMs: atMs,
        fingerprint: checkedDigest(
          digest,
          legacyInvitationFingerprintInput(raw.id, code),
        ),
        requiresReissue,
      },
    };
  });
  for (const [id, fingerprint] of Object.entries(next.appliedCommands)) {
    const redacted = redactLegacyInvitationCommand(fingerprint, digest);
    if (redacted !== fingerprint) {
      next.appliedCommands[id] = redacted;
      evidence.commandIds.push(id);
    }
  }
  if (!evidence.invitationIds.length && !evidence.commandIds.length)
    return { state, evidence };
  next.revision += 1;
  next.audit.push({
    id: `invitation-retirement:${next.revision}`,
    actorAccountId: null,
    action: "service.invitation_legacy_credentials_retired",
    atMs,
  });
  return { state: next, evidence };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Migration of retained service responses only: credentials never belong in an idempotency receipt. */
export function redactRetainedInvitationResponse(
  value: unknown,
  atMs: number,
  digest: InvitationDigest,
): unknown {
  if (!Number.isSafeInteger(atMs) || atMs < 0)
    throw new Error("A valid invitation retirement time is required.");
  if (Array.isArray(value))
    return value.map((item) =>
      redactRetainedInvitationResponse(item, atMs, digest),
    );
  if (!record(value)) return value;
  if (
    typeof value.shareUrl === "string" &&
    typeof value.id === "string" &&
    typeof value.teamId === "string" &&
    typeof value.seasonId === "string"
  ) {
    return {
      id: value.id,
      expiresAt: value.expiresAt,
      teamId: value.teamId,
      seasonId: value.seasonId,
      credentialAvailable: false,
      requiresReissue: true,
    };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key === "invitations" && Array.isArray(item)) {
        return [
          key,
          item
            .filter(record)
            .map((invite) =>
              publicInvitation(invite as unknown as SpectatorInvite, atMs),
            ),
        ];
      }
      if (key === "appliedCommands" && record(item)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(item).map(([id, fingerprint]) => [
              id,
              typeof fingerprint === "string"
                ? redactLegacyInvitationCommand(fingerprint, digest)
                : fingerprint,
            ]),
          ),
        ];
      }
      return [key, redactRetainedInvitationResponse(item, atMs, digest)];
    }),
  );
}
