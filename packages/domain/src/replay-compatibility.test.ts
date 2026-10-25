import { describe, expect, it } from "vitest";
import evidence from "./fixtures/live-v2-accepted.json";
import v3Evidence from './fixtures/live-v3-accepted.json';
import {
  ENGINE_VERSION,
  replayMatch,
  type MatchConfig,
  type MatchEvent,
} from "./index";
import { assertParticipationConservation } from "../../application/src/reconciliation";

describe("explicit historical accepted replay compatibility", () => {
  it("matches the archived v2 projection byte-for-byte for the retained two-half accepted stream", () => {
    expect(evidence.engineVersion).toBe("synthetic-live-2");
    expect(ENGINE_VERSION).toBe("synthetic-live-4");
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
  it('replays the archived actual v3 stream including participation review exactly without inventing policy defaults', () => {
    expect(v3Evidence.engineVersion).toBe('synthetic-live-3');
    const state = replayMatch(v3Evidence.config as MatchConfig, v3Evidence.events as MatchEvent[]);
    expect(state).toEqual(v3Evidence.expected);
    expect(state.activePolicy).toBeUndefined();
    expect(state.policyHistory).toBeUndefined();
    assertParticipationConservation(state);
  });
});
