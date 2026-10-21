import { describe, expect, it } from "vitest";
import evidence from "./fixtures/live-v2-accepted.json";
import {
  ENGINE_VERSION,
  replayMatch,
  type MatchConfig,
  type MatchEvent,
} from "./index";
import { assertParticipationConservation } from "../../application/src/reconciliation";

describe("explicit synthetic-live-2 to live-3 accepted replay evidence", () => {
  it("matches the archived v2 projection byte-for-byte for the retained two-half accepted stream", () => {
    expect(evidence.engineVersion).toBe("synthetic-live-2");
    expect(ENGINE_VERSION).toBe("synthetic-live-3");
    const state = replayMatch(
      evidence.config as MatchConfig,
      evidence.events as MatchEvent[],
    );
    expect(state).toEqual(evidence.expected);
    assertParticipationConservation(state);
    expect(state).toMatchObject({
      status: "completed",
      score: { for: 1, against: 0 },
      completedTimeQuality: "reviewRequired",
    });
  });
});
