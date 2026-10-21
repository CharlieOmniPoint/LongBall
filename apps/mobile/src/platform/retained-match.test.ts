import { describe, expect, it } from "vitest";
import { createMatch, reduceMatch } from "@longball/domain";
import { romaFixture } from "@longball/testing";
import { assertRetainedMatchFixture } from "./retained-match";

const matchId = "synthetic-retained-fixture";
function retainedFixture() {
  return reduceMatch(
    createMatch({
      matchId,
      players: romaFixture.players,
      selectedPlayerIds: romaFixture.players
        .filter((player) => player.available)
        .map((player) => player.id),
      pitchPlaces: romaFixture.pitchPlaces,
      plannedHalfDurationMs: romaFixture.plannedHalfDurationMs,
      fixedKeeperId: romaFixture.players[0].id,
    }),
    {
      id: "retained-attendance-event",
      type: "attendance.recorded",
      playerId: romaFixture.players[0].id,
      status: "present",
      sample: {
        sessionId: "retained-continuity",
        monotonicMs: 10,
        wallTimeMs: 100,
      },
    },
  );
}

describe("retained match fixture boundary", () => {
  it("accepts the same immutable fixture without rebuilding or changing its retained event history", () => {
    const saved = retainedFixture(),
      original = JSON.stringify(saved);
    expect(() => assertRetainedMatchFixture(saved, matchId)).not.toThrow();
    expect(JSON.stringify(saved)).toBe(original);
    expect(saved.eventHistory?.[0].id).toBe("retained-attendance-event");
  });

  it("refuses a different fixture without relabelling the saved configuration or event history", () => {
    const saved = retainedFixture(),
      original = JSON.stringify(saved);
    expect(() =>
      assertRetainedMatchFixture(saved, "another-requested-fixture"),
    ).toThrow(
      "Existing data and event history were retained; no replacement match was created.",
    );
    expect(JSON.stringify(saved)).toBe(original);
    expect(saved.config.matchId).toBe(matchId);
    expect(saved.eventHistory?.[0].id).toBe("retained-attendance-event");
  });

  it.each([
    false,
    0,
    "",
    undefined,
    null,
    {},
    { config: null },
    { config: {} },
    { config: { matchId: 7 } },
  ])(
    "refuses malformed retained projection %j instead of treating it as a new fixture",
    (value) => {
      const original = JSON.stringify(value);
      expect(() => assertRetainedMatchFixture(value, matchId)).toThrow(
        "saved match does not belong",
      );
      expect(JSON.stringify(value)).toBe(original);
    },
  );
});
