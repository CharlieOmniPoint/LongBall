import { describe, expect, it } from "vitest";
import { createMatch } from "../../domain/src/index";
import {
  assertLiveEditorAccess,
  assertLiveEditorCommand,
  type LiveEditorAccess,
} from "./live-editor-access";
import type { ConnectedCommand } from "./sync";

function match() {
  const players = Array.from({ length: 5 }, (_, index) => ({
    id: `synthetic-player-${index}`,
    displayName: `Fictional player ${index + 1}`,
    goalkeeperChoice: index === 0 ? 1 : 0,
  }));
  return createMatch({
    matchId: "synthetic-roma-maple-2026-10-24",
    players,
    selectedPlayerIds: players.map((player) => player.id),
    pitchPlaces: 5,
    plannedHalfDurationMs: 1_500_000,
    fixedKeeperId: players[0].id,
    slots: players.map((_, index) => ({
      slotId: `place-${index}`,
      position: index === 0 ? "GK" : "CM",
    })),
    fixture: {
      teamId: "synthetic-roma-u10",
      seasonId: "synthetic-season",
      teamName: "Fictional Roma",
      clubName: "Fictional club",
      opponent: "Fictional Maple",
      playedDate: "2026-10-24",
      kickoff: null,
      homeAway: "home",
    },
    profileSnapshot: players.map((player, index) => ({
      playerId: player.id,
      preferences: [index === 0 ? "GK" : "CM"],
      eligiblePositions: [index === 0 ? "GK" : "CM"],
      initials: `P${index}`,
    })),
  });
}
const preview: LiveEditorAccess = {
  mode: "fictional-review",
  allowFictionalReview: true,
  platform: "web",
  eligible: true,
  journalEvidence: {
    mode: "synthetic-browser",
    deviceId: "703fc99c-47ac-459b-9b97-688309fa69be",
    cipherVersion: null,
    backupExcluded: false,
    wrongKeyProbe: "unsupported",
  },
};

describe("explicit fictional connected editor boundary", () => {
  it("allows the exact fictional browser context without claiming native encryption", () => {
    expect(() =>
      assertLiveEditorCommand(
        match(),
        {
          type: "attendance.recorded",
          playerId: "synthetic-player-0",
          status: "present",
        },
        preview,
      ),
    ).not.toThrow();
  });

  it.each([
    { allowFictionalReview: false },
    { allowFictionalReview: undefined },
    { platform: "ios" },
    { platform: "android" },
    { eligible: false },
    { journalEvidence: null },
    { journalEvidence: { ...preview.journalEvidence!, deviceId: " " } },
    {
      journalEvidence: {
        ...preview.journalEvidence!,
        mode: "encrypted-native",
      },
    },
  ])("refuses incomplete or production review context %j", (change) => {
    expect(() =>
      assertLiveEditorAccess(match(), { ...preview, ...change }),
    ).toThrow(/Demo recording/);
  });

  it("refuses real fixture IDs and incomplete immutable preparation", () => {
    const real = match();
    real.config.matchId = "actual-service-match";
    expect(() => assertLiveEditorAccess(real, preview)).toThrow(
      /Demo recording/,
    );
    const incomplete = match();
    incomplete.config.profileSnapshot = [];
    expect(() => assertLiveEditorAccess(incomplete, preview)).toThrow(
      /snapshots are incomplete/,
    );
  });

  it("does not allow mode selection to make the default real browser editor writable", () => {
    for (const mode of [undefined, "native"] as const)
      expect(() =>
        assertLiveEditorAccess(match(), { ...preview, mode }),
      ).toThrow(/browser recording is read-only/);
  });

  it("retains canonical actor/event identity and saved-roster checks in fictional mode", () => {
    expect(() =>
      assertLiveEditorCommand(
        match(),
        { type: "half.started", actorId: "chosen-manager" } as ConnectedCommand,
        preview,
      ),
    ).toThrow(/canonical adapter/);
    expect(() =>
      assertLiveEditorCommand(
        match(),
        {
          type: "goal.recorded",
          beneficiary: "us",
          scorerPlayerId: "other-team-player",
        },
        preview,
      ),
    ).toThrow(/saved match squad/);
  });

  it("continues to require observed encryption and wrong-key evidence for real native editing", () => {
    const native: LiveEditorAccess = {
      ...preview,
      mode: "native",
      platform: "android",
      allowFictionalReview: false,
      journalEvidence: {
        mode: "encrypted-native",
        deviceId: "actual-device",
        cipherVersion: "observed-cipher",
        backupExcluded: true,
        wrongKeyProbe: "passed",
      },
    };
    expect(() => assertLiveEditorAccess(match(), native)).not.toThrow();
    expect(() =>
      assertLiveEditorAccess(match(), {
        ...native,
        journalEvidence: {
          ...native.journalEvidence!,
          wrongKeyProbe: "not-run",
        },
      }),
    ).toThrow(/Check secure storage/);
  });
});
