import { describe, expect, it } from "vitest";
import { createMatch, playerMinutes, reduceMatch, replayMatch } from "./index";
import type { Allocation, ClockSample, MatchEvent, MatchState } from "./types";

const players = Array.from({ length: 9 }, (_, index) => ({
  id: `p${index + 1}`,
  displayName: `Player ${index + 1}`,
  goalkeeperChoice: index === 0 ? 1 : 0,
}));
const config = {
  matchId: "synthetic-correction",
  players,
  selectedPlayerIds: players.map((player) => player.id),
  pitchPlaces: 7,
  plannedHalfDurationMs: 1_500_000,
  fixedKeeperId: "p1",
};
const lineup: Allocation[] = players.slice(0, 7).map((player, index) => ({
  playerId: player.id,
  slotId: `s${index}`,
  position: index === 0 ? "GK" : "CM",
}));
const swap = (from: string, to: string, allocations = lineup) =>
  allocations.map((item) =>
    item.playerId === from ? { ...item, playerId: to } : item,
  );
const sample = (ms: number, sessionId = "clock"): ClockSample => ({
  monotonicMs: ms,
  wallTimeMs: 1_900_000_000_000 + ms,
  sessionId,
});
type Command = MatchEvent extends infer E
  ? E extends MatchEvent
    ? Omit<E, "id" | "sample">
    : never
  : never;
function event<E extends Command>(
  command: E,
  id: string,
  ms: number,
): E & { id: string; sample: ClockSample; actorId: string } {
  return { ...command, id, sample: sample(ms), actorId: "manager-a" };
}
function started() {
  let state = createMatch(config);
  for (const player of players)
    state = reduceMatch(
      state,
      event(
        { type: "attendance.recorded", playerId: player.id, status: "present" },
        `present-${player.id}`,
        0,
      ),
    );
  state = reduceMatch(
    state,
    event({ type: "lineup.staged", lineup }, "staged", 0),
  );
  return reduceMatch(state, event({ type: "half.started" }, "kickoff", 0));
}
function changed() {
  let state = started();
  state = reduceMatch(
    state,
    event(
      {
        type: "lineup.committed",
        lineup: swap("p7", "p8"),
        sourceRevision: state.revision,
      },
      "sub-one",
      10_000,
    ),
  );
  state = reduceMatch(
    state,
    event(
      {
        type: "lineup.committed",
        lineup: swap("p7", "p9"),
        sourceRevision: state.revision,
      },
      "sub-two",
      20_000,
    ),
  );
  return reduceMatch(state, event({ type: "half.paused" }, "pause", 30_000));
}
function correct(
  state: MatchState,
  id = "correct-one",
  ms = 30_000,
  at = 5_000,
  allocations = swap("p7", "p8"),
) {
  return event(
    {
      type: "event.corrected",
      targetEventId: "sub-one",
      sourceRevision: state.revision,
      reason: "Actual substitution verified against the touchline record.",
      replacement: {
        type: "lineup.committed",
        lineup: allocations,
        effective: { half: 1, halfElapsedMs: at, matchElapsedMs: at },
      },
    },
    id,
    ms,
  );
}
function conservation(state: MatchState) {
  const totals = playerMinutes(state, state.anchor?.sample ?? sample(40_000));
  for (const player of totals) {
    expect(player.playingMs + player.benchMs + player.unavailableMs).toBe(
      state.matchActiveMs,
    );
    expect(
      Object.values(player.positionMs).reduce((sum, value) => sum + value, 0),
    ).toBe(player.playingMs);
    const intervals = state.intervals
      .filter((item) => item.playerId === player.playerId)
      .sort((a, b) => a.startMs - b.startMs || a.half - b.half);
    expect(
      intervals.every(
        (interval, index) =>
          interval.startMs >= 0 &&
          interval.endMs > interval.startMs &&
          (index === 0 || interval.startMs === intervals[index - 1].endMs),
      ),
    ).toBe(true);
  }
}
describe("ME54 retrospective participation evidence", () => {
  it("moves an actual substitution earlier, preserves immutable evidence, and replays exactly once", () => {
    const original = changed(),
      before = JSON.stringify(original);
    const command = correct(original);
    const state = reduceMatch(original, command);
    expect(JSON.stringify(original)).toBe(before);
    expect(state).toMatchObject({
      status: original.status,
      halfActiveMs: 30_000,
      matchActiveMs: 30_000,
      anchor: null,
      firstHalfDurationMs: null,
    });
    const minutes = playerMinutes(state, sample(30_000));
    expect(minutes.find((item) => item.playerId === "p7")?.playingMs).toBe(
      5_000,
    );
    expect(minutes.find((item) => item.playerId === "p8")?.playingMs).toBe(
      15_000,
    );
    expect(minutes.find((item) => item.playerId === "p9")?.playingMs).toBe(
      10_000,
    );
    expect(state.eventHistory?.find((item) => item.id === "sub-one")).toEqual(
      original.eventHistory?.find((item) => item.id === "sub-one"),
    );
    expect(state.audit?.at(-1)).toMatchObject({
      actorId: "manager-a",
      targetEventId: "sub-one",
      priorValue: { effective: { matchElapsedMs: 10_000 } },
      value: { earliestAffected: { matchElapsedMs: 5_000 } },
    });
    expect(reduceMatch(state, command)).toBe(state);
    expect(replayMatch(config, state.eventHistory!)).toEqual(state);
    conservation(state);
  });
  it("moves a substitution later and handles repeated same-millisecond allocation changes deterministically", () => {
    const original = changed();
    let state = reduceMatch(
      original,
      correct(original, "later", 30_000, 15_000),
    );
    expect(
      playerMinutes(state, sample(30_000)).find(
        (item) => item.playerId === "p7",
      )?.playingMs,
    ).toBe(15_000);
    state = reduceMatch(state, correct(state, "same-time", 30_000, 20_000));
    expect(
      playerMinutes(state, sample(30_000)).find(
        (item) => item.playerId === "p8",
      )?.playingMs,
    ).toBe(0);
    expect(state.lineup).toEqual(swap("p7", "p9"));
    conservation(state);
    expect(replayMatch(config, state.eventHistory!)).toEqual(state);
  });
  it("reprojects an injury boundary and targets while exposing real vacant capacity", () => {
    let state = started();
    state = reduceMatch(
      state,
      event(
        {
          type: "availability.changed",
          playerId: "p7",
          available: false,
          reason: "injury",
        },
        "injury",
        10_000,
      ),
    );
    state = reduceMatch(state, event({ type: "half.paused" }, "pause", 30_000));
    state = reduceMatch(
      state,
      event(
        {
          type: "event.corrected",
          targetEventId: "injury",
          sourceRevision: state.revision,
          reason: "The player left earlier; no replacement entered.",
          replacement: {
            type: "availability.changed",
            playerId: "p7",
            available: false,
            reason: "injury",
            effective: { half: 1, halfElapsedMs: 5_000, matchElapsedMs: 5_000 },
          },
        },
        "injury-corrected",
        30_000,
      ),
    );
    const minutes = playerMinutes(state, sample(30_000));
    expect(minutes.find((item) => item.playerId === "p7")).toMatchObject({
      playingMs: 5_000,
      unavailableMs: 25_000,
    });
    expect(state.lineup).toHaveLength(6);
    expect(
      state.targetIntervals
        .filter((item) => item.availablePlayerIds.includes("p7"))
        .reduce((sum, item) => sum + item.durationMs, 0),
    ).toBe(5_000);
    expect(minutes.reduce((sum, item) => sum + item.playingMs, 0)).toBe(
      7 * 5_000 + 6 * 25_000,
    );
    conservation(state);
    expect(replayMatch(config, state.eventHistory!)).toEqual(state);
  });
  it("preserves the confirmed atomic replacement batch when correcting its availability time", () => {
    let state = started();
    state = reduceMatch(
      state,
      event(
        {
          type: "availability.changed",
          playerId: "p7",
          available: false,
          reason: "injury",
          replacementLineup: swap("p7", "p8"),
        },
        "injury-and-sub",
        10_000,
      ),
    );
    state = reduceMatch(state, event({ type: "half.paused" }, "pause", 30_000));
    state = reduceMatch(
      state,
      event(
        {
          type: "event.corrected",
          targetEventId: "injury-and-sub",
          sourceRevision: state.revision,
          reason:
            "The same confirmed injury and replacement batch happened earlier.",
          replacement: {
            type: "availability.changed",
            playerId: "p7",
            available: false,
            reason: "injury",
            effective: { half: 1, halfElapsedMs: 5_000, matchElapsedMs: 5_000 },
          },
        },
        "earlier-atomic-batch",
        30_000,
      ),
    );
    expect(
      playerMinutes(state, sample(30_000)).find(
        (item) => item.playerId === "p8",
      )?.playingMs,
    ).toBe(25_000);
    expect(state.lineup).toEqual(swap("p7", "p8"));
    conservation(state);
    expect(replayMatch(config, state.eventHistory!)).toEqual(state);
  });
  it("rejects unavailable play, duplicate slots and unsupported cross-half or stale corrections without mutation", () => {
    let state = started();
    state = reduceMatch(
      state,
      event(
        {
          type: "lineup.committed",
          lineup: swap("p7", "p8"),
          sourceRevision: state.revision,
        },
        "sub-one",
        10_000,
      ),
    );
    state = reduceMatch(
      state,
      event(
        {
          type: "lineup.committed",
          lineup: swap("p7", "p9"),
          sourceRevision: state.revision,
        },
        "sub-two",
        20_000,
      ),
    );
    state = reduceMatch(
      state,
      event(
        {
          type: "availability.changed",
          playerId: "p8",
          available: false,
          reason: "departure",
        },
        "p8-left",
        25_000,
      ),
    );
    state = reduceMatch(state, event({ type: "half.paused" }, "pause", 30_000));
    const before = JSON.stringify(state);
    expect(() =>
      reduceMatch(state, correct(state, "unavailable", 30_000, 30_000)),
    ).toThrow("unavailable");
    expect(() =>
      reduceMatch(
        state,
        correct(
          state,
          "duplicates",
          30_000,
          5_000,
          lineup.map((item) => ({ ...item, slotId: "duplicate" })),
        ),
      ),
    ).toThrow("unique");
    expect(() =>
      reduceMatch(state, {
        ...correct(state),
        sourceRevision: state.revision - 1,
      }),
    ).toThrow("stale");
    expect(() =>
      reduceMatch(state, {
        ...correct(state),
        replacement: {
          type: "lineup.committed",
          lineup,
          effective: { half: 2, halfElapsedMs: 0, matchElapsedMs: 30_000 },
        },
      }),
    ).toThrow();
    expect(JSON.stringify(state)).toBe(before);
  });
  it("requires explicit goal review when a correction contradicts a recorded scorer", () => {
    let state = started();
    state = reduceMatch(
      state,
      event(
        {
          type: "lineup.committed",
          lineup: swap("p7", "p8"),
          sourceRevision: state.revision,
        },
        "sub-one",
        10_000,
      ),
    );
    state = reduceMatch(
      state,
      event(
        { type: "goal.recorded", beneficiary: "us", scorerPlayerId: "p8" },
        "goal-eight",
        15_000,
      ),
    );
    state = reduceMatch(state, event({ type: "half.paused" }, "pause", 30_000));
    expect(() =>
      reduceMatch(state, correct(state, "bad-scorer", 30_000, 20_000)),
    ).toThrow("goal-eight");
    state = reduceMatch(
      state,
      event(
        {
          type: "event.corrected",
          targetEventId: "goal-eight",
          reason: "Scorer was not recorded reliably.",
          replacement: {
            type: "goal.recorded",
            beneficiary: "us",
            scorerPlayerId: null,
          },
        },
        "goal-unknown",
        30_000,
      ),
    );
    state = reduceMatch(
      state,
      correct(state, "verified-later", 30_000, 20_000),
    );
    expect(state.score).toEqual({ for: 1, against: 0 });
    conservation(state);
  });
  it("preserves actual halves, second-half starting allocations, final time and historical profile snapshots", () => {
    let state = changed();
    state = reduceMatch(
      state,
      event({ type: "half.ended" }, "first-end", 40_000),
    );
    state = reduceMatch(
      state,
      event({ type: "half.started" }, "second-start", 100_000),
    );
    state = reduceMatch(
      state,
      event({ type: "half.ended" }, "second-end", 150_000),
    );
    const original = state;
    state = reduceMatch(
      state,
      correct(state, "after-completion", 150_000, 5_000),
    );
    expect(state).toMatchObject({
      status: "completed",
      matchActiveMs: original.matchActiveMs,
      firstHalfDurationMs: original.firstHalfDurationMs,
      completedAtMs: original.completedAtMs,
    });
    expect(state.config).toEqual(original.config);
    expect(
      state.intervals
        .filter((item) => item.half === 2 && item.state === "playing")
        .map((item) => item.playerId)
        .sort(),
    ).toEqual(
      original.intervals
        .filter((item) => item.half === 2 && item.state === "playing")
        .map((item) => item.playerId)
        .sort(),
    );
    conservation(state);
    expect(replayMatch(config, state.eventHistory!)).toEqual(state);
  });
  it("inserts explicitly reviewed missing participation facts without guessing entry clock or changing later actual batches", () => {
    const original = changed();
    let state = reduceMatch(
      original,
      event(
        {
          type: "lineup.committed",
          sourceRevision: original.revision,
          lineup: swap("p7", "p8"),
          effective: { half: 1, halfElapsedMs: 5_000, matchElapsedMs: 5_000 },
          lateEntryReason:
            "The touchline sheet confirms a missing change at five seconds.",
        },
        "missing-sub",
        80_000,
      ),
    );
    expect(state.matchActiveMs).toBe(30_000);
    expect(
      playerMinutes(state, sample(80_000)).find(
        (item) => item.playerId === "p8",
      )?.playingMs,
    ).toBe(15_000);
    expect(state.audit?.at(-1)).toMatchObject({
      recordedAtMs: sample(80_000).wallTimeMs,
      effective: { matchElapsedMs: 5_000 },
      priorValue: null,
    });
    state = reduceMatch(
      state,
      event(
        {
          type: "availability.changed",
          playerId: "p7",
          available: false,
          reason: "injury",
          sourceRevision: state.revision,
          effective: { half: 1, halfElapsedMs: 25_000, matchElapsedMs: 25_000 },
          lateEntryReason:
            "Recorded player left the bench injured at twenty-five seconds.",
        },
        "missing-injury",
        90_000,
      ),
    );
    expect(
      playerMinutes(state, sample(90_000)).find(
        (item) => item.playerId === "p7",
      ),
    ).toMatchObject({ playingMs: 5_000, unavailableMs: 5_000 });
    conservation(state);
    expect(replayMatch(config, state.eventHistory!)).toEqual(state);
    expect(() =>
      reduceMatch(
        original,
        event(
          {
            type: "lineup.committed",
            sourceRevision: original.revision,
            lineup,
            effective: { half: 1, halfElapsedMs: 5_000, matchElapsedMs: 5_000 },
          },
          "no-evidence",
          80_000,
        ),
      ),
    ).toThrow("late-entry reason");
  });
  it("restores a voided participation fact only through a separately confirmed compensating correction", () => {
    const original = changed();
    let state = reduceMatch(
      original,
      event(
        {
          type: "event.voided",
          targetEventId: "sub-one",
          sourceRevision: original.revision,
          reason: "The first review recorded this as an erroneous entry.",
        },
        "void-for-review",
        30_000,
      ),
    );
    const restore = {
      ...correct(state, "restore-verified"),
      targetEventId: "void-for-review",
    };
    expect(() => reduceMatch(state, restore)).toThrow("explicit confirmation");
    state = reduceMatch(state, { ...restore, restoreVoided: true });
    expect(
      playerMinutes(state, sample(30_000)).find(
        (item) => item.playerId === "p8",
      )?.playingMs,
    ).toBe(15_000);
    conservation(state);
    expect(replayMatch(config, state.eventHistory!)).toEqual(state);
    expect(
      state.eventHistory?.some((item) => item.id === "void-for-review"),
    ).toBe(true);
  });
  it("voids an erroneous substitution through a compensating event and preserves both records", () => {
    const original = changed();
    const state = reduceMatch(
      original,
      event(
        {
          type: "event.voided",
          targetEventId: "sub-one",
          sourceRevision: original.revision,
          reason: "This substitution was recorded but did not happen.",
        },
        "void-sub",
        30_000,
      ),
    );
    expect(
      playerMinutes(state, sample(30_000)).find(
        (item) => item.playerId === "p8",
      )?.playingMs,
    ).toBe(0);
    expect(state.eventHistory?.some((item) => item.id === "sub-one")).toBe(
      true,
    );
    expect(state.audit?.at(-1)?.targetEventId).toBe("sub-one");
    conservation(state);
    expect(replayMatch(config, state.eventHistory!)).toEqual(state);
  });
});
