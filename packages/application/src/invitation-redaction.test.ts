import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyCommunityCommand,
  applyVerifiedInvitationCommand,
  createCommunityState,
  getCommunityView,
  syntheticCommunityActors,
} from "./community";
import { pendingInvitation } from "./invitation-credentials";
import {
  LEGACY_INVITATION_COMMAND_DOMAIN,
  RETIRED_INVITATION_COMMAND_PREFIX,
  legacyInvitationFingerprintInput,
  redactLegacyInvitationCommand,
  redactRetainedInvitationResponse,
  retireLegacyInvitationCredentials,
} from "./invitation-redaction";

const now = Date.parse("2026-10-21T10:00:00Z");
const digest = (input: string) =>
  createHash("sha256").update(input).digest("hex");
function setup() {
  let state = createCommunityState(now);
  const actors = syntheticCommunityActors(state);
  for (const [id, code] of [
    ["pending", "PENDING-SECRET"],
    ["accepted", "ACCEPTED-SECRET"],
    ["revoked", "REVOKED-SECRET"],
  ]) {
    state = applyCommunityCommand(
      state,
      actors.player,
      {
        id: `create-${id}`,
        type: "invite.created",
        invitationId: id,
        reviewCode: code,
        expiresAtMs: now + 3_600_000,
      },
      now,
    );
  }
  state = applyCommunityCommand(
    state,
    actors.invitee,
    { id: "accept", type: "invite.accepted", reviewCode: "ACCEPTED-SECRET" },
    now,
  );
  state = applyCommunityCommand(
    state,
    actors.manager,
    { id: "revoke", type: "invite.revoked", invitationId: "revoked" },
    now,
  );
  state = applyCommunityCommand(
    state,
    actors.player,
    {
      id: "preferences",
      type: "preferences.changed",
      preferences: {
        schedule: true,
        match: true,
        awards: true,
        photos: true,
        quietStart: null,
        quietEnd: null,
      },
    },
    now,
  );
  // Represents the exact old persisted shape before credentials became a tagged union.
  for (const invite of state.invitations)
    delete (invite as unknown as { credential?: unknown }).credential;
  return { state, actors };
}

describe("legacy invitation retirement without invented authority", () => {
  it("revokes pending plaintext authority and preserves accepted grants, account identities and existing audit history", () => {
    const { state } = setup(),
      original = JSON.stringify(state);
    const result = retireLegacyInvitationCredentials(state, now + 10, digest);
    expect(JSON.stringify(state)).toBe(original);
    expect(result.state.grants).toEqual(state.grants);
    expect(result.state.accounts).toEqual(state.accounts);
    expect(result.state.memberships).toEqual(state.memberships);
    expect(result.state.audit.slice(0, -1)).toEqual(state.audit);
    expect(result.state.audit.at(-1)).toEqual({
      id: `invitation-retirement:${state.revision + 1}`,
      actorAccountId: null,
      action: "service.invitation_legacy_credentials_retired",
      atMs: now + 10,
    });
    expect(result.state.invitations[0]).toMatchObject({
      revokedAtMs: now + 10,
      credential: {
        kind: "legacy_retired",
        version: 1,
        redactedAtMs: now + 10,
        requiresReissue: true,
        fingerprint: digest(
          legacyInvitationFingerprintInput("pending", "PENDING-SECRET"),
        ),
      },
    });
    expect(result.state.invitations[1]).toMatchObject({
      acceptedBy: state.invitations[1].acceptedBy,
      acceptedAtMs: now,
      revokedAtMs: null,
      credential: { requiresReissue: false },
    });
    expect(result.state.invitations[2]).toMatchObject({
      revokedAtMs: now,
      credential: { requiresReissue: false },
    });
    expect(result.evidence).toEqual({
      version: 1,
      atMs: now + 10,
      invitationIds: ["pending", "accepted", "revoked"],
      commandIds: [
        "create-pending",
        "create-accepted",
        "create-revoked",
        "accept",
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /PENDING-SECRET|ACCEPTED-SECRET|REVOKED-SECRET|reviewCode/,
    );
  });
  it("retires raw command fingerprints while preserving unrelated idempotency identities and exact second migration", () => {
    const { state } = setup();
    const result = retireLegacyInvitationCredentials(state, now + 10, digest);
    expect(result.state.appliedCommands["create-pending"]).toBe(
      RETIRED_INVITATION_COMMAND_PREFIX +
        digest(
          LEGACY_INVITATION_COMMAND_DOMAIN +
            state.appliedCommands["create-pending"],
        ),
    );
    expect(result.state.appliedCommands.preferences).toBe(
      state.appliedCommands.preferences,
    );
    expect(result.state.appliedCommands.revoke).toBe(
      state.appliedCommands.revoke,
    );
    const repeated = retireLegacyInvitationCredentials(
      result.state,
      now + 20,
      digest,
    );
    expect(repeated.state).toBe(result.state);
    expect(repeated.evidence.invitationIds).toEqual([]);
    expect(repeated.evidence.commandIds).toEqual([]);
    expect(
      redactLegacyInvitationCommand('{"reviewCode":"malformed-secret"', digest),
    ).toMatch(/^invitation-command-retired:v1:[a-f0-9]{64}$/);
  });
  it("requires explicit reissue, never revives the old code and never rotates an accepted grant", () => {
    const { state, actors } = setup();
    const retired = retireLegacyInvitationCredentials(
      state,
      now + 10,
      digest,
    ).state;
    expect(() =>
      applyCommunityCommand(
        retired,
        actors.invitee,
        {
          id: "old-accept",
          type: "invite.accepted",
          reviewCode: "PENDING-SECRET",
        },
        now + 11,
      ),
    ).toThrow(/not valid/);
    expect(
      pendingInvitation(retired, digest("PENDING-SECRET"), now + 11),
    ).toBeNull();
    const replacement = applyVerifiedInvitationCommand(
      retired,
      actors.player,
      {
        id: "reissue",
        type: "invite.reissued",
        sourceInvitationId: "pending",
        invitationId: "replacement",
        tokenHash: "a".repeat(64),
        expiresAtMs: now + 3_600_000,
      },
      now + 11,
    );
    expect(replacement.invitations[0].credential).toMatchObject({
      kind: "legacy_retired",
      requiresReissue: false,
    });
    expect(replacement.invitations[0].revokedAtMs).toBe(now + 10);
    expect(pendingInvitation(replacement, "a".repeat(64), now + 11)?.id).toBe(
      "replacement",
    );
    expect(replacement.grants).toEqual(state.grants);
    for (const sourceInvitationId of ["accepted", "revoked"])
      expect(() =>
        applyVerifiedInvitationCommand(
          retired,
          actors.manager,
          {
            id: `bad-${sourceInvitationId}`,
            type: "invite.reissued",
            sourceInvitationId,
            invitationId: `new-${sourceInvitationId}`,
            tokenHash: "b".repeat(64),
            expiresAtMs: now + 3_600_000,
          },
          now + 11,
        ),
      ).toThrow(/accepted|revoked/);
  });
  it("handles explicitly tagged fictional code migration only when the service opts into this migration", () => {
    const { state, actors } = setup();
    const tagged = applyCommunityCommand(
      state,
      actors.player,
      {
        id: "tagged",
        type: "invite.created",
        invitationId: "tagged",
        reviewCode: "TAGGED-FICTIONAL-SECRET",
        expiresAtMs: now + 1000,
      },
      now,
    );
    const retired = retireLegacyInvitationCredentials(tagged, now + 1, digest);
    expect(retired.state.invitations.at(-1)?.credential.kind).toBe(
      "legacy_retired",
    );
    expect(JSON.stringify(retired)).not.toContain("TAGGED-FICTIONAL-SECRET");
    // Rehearsals are not automatically migrated by normal local community commands.
    expect(
      getCommunityView(tagged, actors.player, now).invitations.at(-1)
        ?.reviewCode,
    ).toBe("TAGGED-FICTIONAL-SECRET");
  });
  it("scrubs nested cached community DTOs, retained command strings and one-time issued response URLs", () => {
    const { state } = setup();
    const response = {
      wrapper: {
        invitations: state.invitations,
        appliedCommands: state.appliedCommands,
      },
      unrelated: {
        shareUrl: "https://safe.example/non-invitation",
        label: "retained",
      },
      receipt: {
        id: "issued",
        teamId: "team",
        seasonId: "season",
        expiresAt: "2026-10-21T11:00:00Z",
        shareUrl: "https://private.example/#token=RAW-SHARE-SECRET",
      },
    };
    const original = JSON.stringify(response);
    const redacted = redactRetainedInvitationResponse(
      response,
      now + 10,
      digest,
    ) as typeof response & {
      receipt: { credentialAvailable: false; requiresReissue: true };
    };
    expect(JSON.stringify(response)).toBe(original);
    expect(JSON.stringify(redacted)).not.toMatch(
      /PENDING-SECRET|ACCEPTED-SECRET|REVOKED-SECRET|RAW-SHARE-SECRET|reviewCode|tokenHash/,
    );
    expect(redacted.unrelated).toEqual(response.unrelated);
    expect(redacted.receipt).toEqual({
      id: "issued",
      teamId: "team",
      seasonId: "season",
      expiresAt: "2026-10-21T11:00:00Z",
      credentialAvailable: false,
      requiresReissue: true,
    });
    expect(
      redactRetainedInvitationResponse(redacted, now + 10, digest),
    ).toEqual(redacted);
  });
  it("fails without changing any source bytes when clock or digest evidence is invalid", () => {
    const { state } = setup(),
      original = JSON.stringify(state);
    expect(() =>
      retireLegacyInvitationCredentials(state, Number.NaN, digest),
    ).toThrow(/valid/);
    expect(() =>
      retireLegacyInvitationCredentials(state, now, () => "not-a-hash"),
    ).toThrow(/digest is unavailable/);
    expect(JSON.stringify(state)).toBe(original);
  });
});
