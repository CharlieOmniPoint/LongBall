import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  INVITATION_CREDENTIAL_DOMAIN,
  invitationTokenHashInput,
  isCanonicalInvitationToken,
  isInvitationTokenHash,
  pendingInvitation,
  publicInvitation,
  redactInviteCreated,
  type CredentialInvitation,
  type InvitationLookupState,
} from "./invitation-credentials";

// Deliberately deterministic encoding fixtures, never a credential issuance source.
const token = "A".repeat(43);
const tokenHash = createHash("sha256")
  .update(invitationTokenHashInput(token))
  .digest("hex");
const now = 1000;
const invite: CredentialInvitation = {
  id: "invitation-one",
  teamId: "team-one",
  seasonId: "season-one",
  inviterAccountId: "player-account",
  credential: { kind: "sha256", version: 1, tokenHash },
  createdAtMs: 900,
  expiresAtMs: 2000,
  acceptedBy: null,
  acceptedAtMs: null,
  revokedAtMs: null,
  reissuedFromInvitationId: null,
};
const fixture = (invitation = invite): InvitationLookupState => ({
  invitations: [invitation],
  seasons: [{ id: "season-one", teamId: "team-one", accessEndsAtMs: 3000 }],
});
describe("hash-bound server invitation credentials", () => {
  it("accepts only canonical encodings of exactly32 random bytes without trimming or alternate tail bits", () => {
    expect(isCanonicalInvitationToken(token)).toBe(true);
    expect(isCanonicalInvitationToken("_".repeat(42) + "8")).toBe(true);
    for (const invalid of [
      "A".repeat(42),
      "A".repeat(44),
      "A".repeat(42) + "B",
      "A".repeat(42) + "\n",
      `${token}\n`,
      ` ${token}`,
      `${token}=`,
      tokenHash,
    ])
      expect(isCanonicalInvitationToken(invalid)).toBe(false);
    expect(invitationTokenHashInput(token)).toBe(
      INVITATION_CREDENTIAL_DOMAIN + token,
    );
    expect(() => invitationTokenHashInput(tokenHash)).toThrow("unavailable");
  });
  it("requires exactly64 lowercase hash characters and never normalizes malformed hashes", () => {
    expect(isInvitationTokenHash(tokenHash)).toBe(true);
    for (const invalid of [
      "A".repeat(64),
      "a".repeat(63) + "\n",
      "a".repeat(65),
      ` ${tokenHash}`,
      null,
    ])
      expect(isInvitationTokenHash(invalid)).toBe(false);
  });
  it("binds a pending lookup to unique verifier and exact current team-season without mutating history", () => {
    const state = fixture(),
      original = JSON.stringify(state);
    expect(
      pendingInvitation(state, tokenHash, now, {
        teamId: "team-one",
        seasonId: "season-one",
      })?.id,
    ).toBe(invite.id);
    expect(
      pendingInvitation(state, tokenHash, now, {
        teamId: "other-team",
        seasonId: "season-one",
      }),
    ).toBeNull();
    expect(
      pendingInvitation(state, tokenHash, now, {
        teamId: "team-one",
        seasonId: "other-season",
      }),
    ).toBeNull();
    expect(pendingInvitation(state, "b".repeat(64), now)).toBeNull();
    expect(
      pendingInvitation(
        {
          ...state,
          invitations: [invite, { ...invite, id: "duplicate-verifier" }],
        },
        tokenHash,
        now,
      ),
    ).toBeNull();
    expect(JSON.stringify(state)).toBe(original);
  });
  it("refuses accepted, revoked, future-issued, expired and mismatched season evidence", () => {
    for (const changed of [
      { ...invite, acceptedBy: "already-member" },
      { ...invite, acceptedAtMs: 950 },
      { ...invite, revokedAtMs: 950 },
      { ...invite, createdAtMs: now + 1 },
      { ...invite, expiresAtMs: now },
    ])
      expect(pendingInvitation(fixture(changed), tokenHash, now)).toBeNull();
    expect(
      pendingInvitation({ ...fixture(), seasons: [] }, tokenHash, now),
    ).toBeNull();
    expect(
      pendingInvitation(
        {
          ...fixture(),
          seasons: [
            { id: "season-one", teamId: "team-one", accessEndsAtMs: now },
          ],
        },
        tokenHash,
        now,
      ),
    ).toBeNull();
    expect(pendingInvitation(fixture(), tokenHash, NaN)).toBeNull();
  });
  it("does not grant production lookup authority to a retired verifier or fictional code", () => {
    const retired: CredentialInvitation = {
      ...invite,
      credential: {
        kind: "legacy_retired",
        version: 1,
        redactedAtMs: 950,
        fingerprint: tokenHash,
        requiresReissue: true,
      },
    };
    const fictional: CredentialInvitation = {
      ...invite,
      credential: {
        kind: "fictional_review",
        version: 1,
        code: "FICTIONAL-ONLY",
      },
    };
    expect(pendingInvitation(fixture(retired), tokenHash, now)).toBeNull();
    expect(pendingInvitation(fixture(fictional), tokenHash, now)).toBeNull();
  });
  it("allowlists public metadata and redacted exact-retry receipts, excluding all credential material", () => {
    const contaminated = {
      ...invite,
      reviewCode: "old-secret",
      token,
      extraPrivateField: "must-omit",
    };
    const view = publicInvitation(contaminated, now);
    expect(JSON.stringify(view)).not.toMatch(
      /old-secret|must-omit|tokenHash|credential|AAAAAAAA/,
    );
    const issued = {
      id: invite.id,
      shareUrl: `https://review.example/invite#token=${token}`,
      expiresAt: "2026-10-21T12:00:00Z",
      teamId: invite.teamId,
      seasonId: invite.seasonId,
    };
    expect(redactInviteCreated(issued)).toEqual({
      id: invite.id,
      expiresAt: issued.expiresAt,
      teamId: invite.teamId,
      seasonId: invite.seasonId,
      credentialAvailable: false,
      requiresReissue: true,
    });
    expect(JSON.stringify(redactInviteCreated(issued))).not.toContain(token);
  });
});
