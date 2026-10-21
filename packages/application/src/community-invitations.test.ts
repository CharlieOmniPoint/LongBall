import { describe, expect, it } from "vitest";
import {
  applyCommunityCommand,
  applyVerifiedInvitationCommand,
  communityCanAccess,
  createCommunityState,
  getCommunityView,
  parseCommunityCommand,
  syntheticCommunityActors,
  type CommunityActor,
  type CommunityState,
  type VerifiedInvitationCommand,
} from "./community";
import { pendingInvitation } from "./invitation-credentials";

const now = Date.parse("2026-10-21T10:00:00Z");
const firstHash = "1".repeat(64),
  secondHash = "2".repeat(64),
  thirdHash = "3".repeat(64);
function setup() {
  const state = createCommunityState(now);
  return { state, actors: syntheticCommunityActors(state) };
}
function issue(
  state: CommunityState,
  actor: CommunityActor,
  id = "first",
  tokenHash = firstHash,
) {
  return applyVerifiedInvitationCommand(
    state,
    actor,
    {
      id: `issue-${id}`,
      type: "invite.issued",
      invitationId: id,
      tokenHash,
      expiresAtMs: now + 3_600_000,
    },
    now,
  );
}
function reissue(
  state: CommunityState,
  actor: CommunityActor,
  sourceInvitationId = "first",
  invitationId = "replacement",
  tokenHash = secondHash,
) {
  return applyVerifiedInvitationCommand(
    state,
    actor,
    {
      id: `reissue-${invitationId}`,
      type: "invite.reissued",
      sourceInvitationId,
      invitationId,
      tokenHash,
      expiresAtMs: now + 3_600_000,
    },
    now + 1,
  );
}

describe("service-verified spectator invitation transitions", () => {
  it("retains only the verifier in trusted state and excludes it from every public invitation DTO", () => {
    const { state, actors } = setup(),
      original = JSON.stringify(state);
    const issued = issue(state, actors.player);
    expect(JSON.stringify(state)).toBe(original);
    expect(issued.invitations[0]).toMatchObject({
      credential: { kind: "sha256", version: 1, tokenHash: firstHash },
      inviterAccountId: actors.player.accountId,
    });
    expect(issued.invitations[0]).not.toHaveProperty("reviewCode");
    expect(JSON.stringify(issued.appliedCommands)).not.toMatch(
      /reviewCode|shareUrl|rawToken/,
    );
    expect(
      JSON.stringify(getCommunityView(issued, actors.manager, now).invitations),
    ).not.toContain(firstHash);
    expect(pendingInvitation(issued, firstHash, now, actors.player)?.id).toBe(
      "first",
    );
  });
  it("never accepts a client-supplied digest through the public community command parser", () => {
    for (const type of [
      "invite.issued",
      "invite.reissued",
      "invite.accepted_verified",
    ]) {
      expect(() =>
        parseCommunityCommand({
          id: "untrusted",
          type,
          invitationId: "first",
          tokenHash: firstHash,
        }),
      ).toThrow();
    }
    const { state, actors } = setup();
    const unexpected = {
      id: "bad",
      type: "invite.issued",
      invitationId: "first",
      tokenHash: firstHash,
      expiresAtMs: now + 1000,
      rawToken: "must-never-retain",
    } as VerifiedInvitationCommand;
    expect(() =>
      applyVerifiedInvitationCommand(state, actors.player, unexpected, now),
    ).toThrow(/Unexpected/);
    expect(JSON.stringify(state)).not.toContain("must-never-retain");
  });
  it("allows the original current player to replace their pending invitation without manager approval", () => {
    const { state, actors } = setup();
    const issued = issue(state, actors.player);
    expect(() => reissue(issued, actors.secondPlayer)).toThrow(
      /original current inviter/,
    );
    const replaced = reissue(issued, actors.player);
    expect(replaced.invitations[0].revokedAtMs).toBe(now + 1);
    expect(replaced.invitations[1].reissuedFromInvitationId).toBe("first");
    expect(pendingInvitation(replaced, firstHash, now + 1)).toBeNull();
    expect(pendingInvitation(replaced, secondHash, now + 1)?.id).toBe(
      "replacement",
    );
    expect(() =>
      reissue(replaced, actors.manager, "first", "another", thirdHash),
    ).toThrow(/revoked|already has a replacement/);
    expect(
      reissue(
        replaced,
        actors.player,
        "replacement",
        "next-replacement",
        thirdHash,
      ).invitations,
    ).toHaveLength(3);
  });
  it("requires current issuer authority, exact scope, unique verifier and explicit bounded expiry", () => {
    const { state, actors } = setup();
    expect(() => issue(state, actors.spectator)).toThrow(
      /current player or manager/,
    );
    const issued = issue(state, actors.player);
    expect(() => issue(issued, actors.player, "reused-hash")).toThrow(
      /cannot be reused/,
    );
    const inactive = JSON.parse(JSON.stringify(issued)) as CommunityState;
    inactive.memberships.find(
      (item) => item.accountId === actors.player.accountId,
    )!.active = false;
    expect(() => reissue(inactive, actors.player)).toThrow(
      /access is unavailable/,
    );
    expect(() =>
      reissue(issued, { ...actors.manager, teamId: "another-team" }),
    ).toThrow(/access is unavailable/);
    for (const expiresAtMs of [
      undefined,
      now,
      now + 48 * 3_600_000 + 1,
      Number.NaN,
    ]) {
      expect(() =>
        applyVerifiedInvitationCommand(
          state,
          actors.manager,
          {
            id: "expiry",
            type: "invite.issued",
            invitationId: "first",
            tokenHash: firstHash,
            expiresAtMs,
          } as VerifiedInvitationCommand,
          now,
        ),
      ).toThrow(/explicit invitation expiry/);
    }
    expect(
      applyVerifiedInvitationCommand(
        state,
        actors.manager,
        {
          id: "max-expiry",
          type: "invite.issued",
          invitationId: "max",
          tokenHash: firstHash,
          expiresAtMs: now + 48 * 3_600_000,
        },
        now,
      ).invitations,
    ).toHaveLength(1);
    const earlySeason = {
      ...state,
      seasons: state.seasons.map((item) => ({
        ...item,
        accessEndsAtMs: now + 10,
      })),
    };
    expect(() => issue(earlySeason, actors.manager)).toThrow(/current season/);
  });
  it("accepts once into a season grant while preserving identity, other memberships, and accepted history", () => {
    const { state, actors } = setup(),
      issued = issue(state, actors.player);
    const command: VerifiedInvitationCommand = {
      id: "accept",
      type: "invite.accepted_verified",
      invitationId: "first",
      tokenHash: firstHash,
      expectedRevision: issued.revision,
    };
    const accepted = applyVerifiedInvitationCommand(
      issued,
      actors.invitee,
      command,
      now + 2,
    );
    expect(accepted.accounts).toEqual(state.accounts);
    expect(accepted.memberships).toEqual(state.memberships);
    expect(accepted.grants.at(-1)).toMatchObject({
      invitationId: "first",
      accountId: actors.invitee.accountId,
      expiresAtMs: state.seasons[0].accessEndsAtMs,
    });
    expect(communityCanAccess(accepted, actors.invitee, now + 2)).toBe(true);
    expect(
      applyVerifiedInvitationCommand(
        accepted,
        actors.invitee,
        command,
        now + 3_600_001,
      ),
    ).toBe(accepted);
    expect(() => reissue(accepted, actors.manager)).toThrow(
      /accepted invitation/,
    );
    expect(() =>
      applyVerifiedInvitationCommand(
        accepted,
        actors.spectator,
        {
          ...command,
          id: "second-accept",
          expectedRevision: accepted.revision,
        },
        now + 3,
      ),
    ).toThrow(/unavailable/);
    expect(accepted.grants.slice(0, -1)).toEqual(state.grants);
  });
  it("refuses cross-scope, expired, revoked, stale and ambiguous acceptance evidence", () => {
    const { state, actors } = setup(),
      issued = issue(state, actors.player);
    const command: VerifiedInvitationCommand = {
      id: "accept",
      type: "invite.accepted_verified",
      invitationId: "first",
      tokenHash: firstHash,
    };
    expect(() =>
      applyVerifiedInvitationCommand(
        issued,
        { ...actors.invitee, seasonId: "other" },
        command,
        now,
      ),
    ).toThrow(/unavailable/);
    expect(() =>
      applyVerifiedInvitationCommand(
        issued,
        actors.invitee,
        command,
        now + 3_600_000,
      ),
    ).toThrow(/unavailable/);
    expect(() =>
      applyVerifiedInvitationCommand(
        issued,
        actors.invitee,
        { ...command, expectedRevision: 0 },
        now,
      ),
    ).toThrow(/records changed/);
    const revoked = applyCommunityCommand(
      issued,
      actors.manager,
      { id: "revoke", type: "invite.revoked", invitationId: "first" },
      now,
    );
    expect(() =>
      applyVerifiedInvitationCommand(revoked, actors.invitee, command, now),
    ).toThrow(/unavailable/);
    const corrupt = {
      ...issued,
      invitations: [
        ...issued.invitations,
        { ...issued.invitations[0], id: "duplicate" },
      ],
    };
    expect(() =>
      applyVerifiedInvitationCommand(corrupt, actors.invitee, command, now),
    ).toThrow(/unavailable/);
  });
  it("makes service-internal retries exact and does not reuse a command identity for another credential", () => {
    const { state, actors } = setup();
    const issued = issue(state, actors.player);
    expect(issue(issued, actors.player)).toBe(issued);
    expect(() => issue(issued, actors.player, "first", secondHash)).toThrow(
      /different content/,
    );
    const replaced = reissue(issued, actors.player);
    expect(reissue(replaced, actors.player)).toBe(replaced);
    expect(replaced.audit.slice(-2).map((item) => item.action)).toEqual([
      "invite.issued",
      "invite.reissued",
    ]);
    expect(
      replaced.audit.every((item) => !JSON.stringify(item).includes(firstHash)),
    ).toBe(true);
  });
  it("does not accept an unmarked legacy plaintext code through the fictional route", () => {
    const { state, actors } = setup();
    const fictional = applyCommunityCommand(
      state,
      actors.player,
      {
        id: "local-create",
        type: "invite.created",
        invitationId: "old",
        reviewCode: "OLD-PLAINTEXT",
        expiresAtMs: now + 1000,
      },
      now,
    );
    const legacy = JSON.parse(JSON.stringify(fictional)) as CommunityState;
    delete (legacy.invitations[0] as unknown as { credential?: unknown })
      .credential;
    expect(() =>
      applyCommunityCommand(
        legacy,
        actors.invitee,
        {
          id: "old-accept",
          type: "invite.accepted",
          reviewCode: "OLD-PLAINTEXT",
        },
        now,
      ),
    ).toThrow(/not valid/);
    expect(() => reissue(legacy, actors.manager, "old")).toThrow(
      /Retire legacy/,
    );
  });
});
