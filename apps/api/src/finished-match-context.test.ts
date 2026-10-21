import { describe, expect, it } from "vitest";
import {
  createMatch,
  ENGINE_VERSION,
  reduceMatch,
  type MatchConfig,
  type MatchEvent,
} from "../../../packages/domain/src/index";
import {
  deriveFinishedMatchContext,
  finishEligibilityChanged,
  type FinishedMatchContextInput,
} from "./finished-match-context";
import {
  acknowledgeClockChallenge,
  issueClockChallenge,
  type TrustedTimePolicy,
} from "./trusted-time";
import { EVENT_CONTRACT_VERSION, type EventEnvelope } from "./store";

const start = 1_790_000_000_000;
const config: MatchConfig = {
  matchId: "synthetic-finish",
  players: Array.from({ length: 9 }, (_, index) => ({
    id: `p${index}`,
    displayName: `Fictional ${index}`,
    goalkeeperChoice: index === 0 ? 1 : 0,
  })),
  selectedPlayerIds: Array.from({ length: 9 }, (_, index) => `p${index}`),
  pitchPlaces: 7,
  plannedHalfDurationMs: 1_500_000,
  fixedKeeperId: "p0",
};
const policy: TrustedTimePolicy = {
  id: "explicit-fictional-trial",
  serverClockUncertaintyMs: 10,
  maximumRoundTripMs: 2_000,
  maximumMappingAgeMs: 3_600_000,
  maximumUncertaintyMs: 1_000,
  maximumDriftPpm: 20,
};
function fixture(): FinishedMatchContextInput {
  let state = createMatch(config);
  let serial = 0;
  const sample = (monotonicMs: number) => ({
    monotonicMs,
    sessionId: "boot",
    wallTimeMs: start + 900_000_000 + monotonicMs,
  });
  for (const playerId of config.selectedPlayerIds)
    state = reduceMatch(state, {
      id: `check-${++serial}`,
      type: "attendance.recorded",
      playerId,
      status: "present",
      sample: sample(10_000),
    });
  const lineup = config.selectedPlayerIds
    .slice(0, 7)
    .map((playerId, index) => ({
      slotId: `slot-${index}`,
      position: index === 0 ? "GK" : "CM",
      playerId,
    }));
  state = reduceMatch(state, {
    id: "lineup",
    type: "lineup.staged",
    lineup,
    sample: sample(10_000),
  });
  state = reduceMatch(state, {
    id: "start-one",
    type: "half.started",
    sample: sample(10_000),
  });
  state = reduceMatch(state, {
    id: "end-one",
    type: "half.ended",
    sample: sample(1_510_000),
  });
  state = reduceMatch(state, {
    id: "start-two",
    type: "half.started",
    sample: sample(1_810_000),
  });
  const finish: MatchEvent = {
    id: "end-two",
    type: "half.ended",
    sample: sample(3_310_000),
  };
  state = reduceMatch(state, finish);
  const acceptedFinish: EventEnvelope = {
    contractVersion: EVENT_CONTRACT_VERSION,
    schemaVersion: 1,
    engineVersion: ENGINE_VERSION,
    eventId: finish.id,
    matchId: config.matchId,
    deviceId: "phone",
    controllerEpoch: 1,
    clientSequence: serial + 5,
    previousEventId: "start-two",
    baseRevision: state.revision - 1,
    effectiveHalf: 2,
    halfElapsedMs: 1_500_000,
    matchElapsedMs: 3_000_000,
    effectiveAt: null,
    recordedAt: new Date(finish.sample.wallTimeMs).toISOString(),
    timeQuality: "estimated",
    clockEvidence: {
      monotonicMs: finish.sample.monotonicMs,
      anchorId: "local",
      continuityId: "boot",
    },
    command: finish,
  };
  const scope = {
    accountId: "manager",
    deviceId: "phone",
    matchId: config.matchId,
    controllerEpoch: 1,
    continuityId: "boot",
  };
  const mapping = acknowledgeClockChallenge(
    issueClockChallenge(scope, "challenge", start, policy),
    { receivedMonotonicMs: 10_050, sentMonotonicMs: 10_070 },
    start + 120,
    policy,
  );
  return {
    state,
    acceptedFinish,
    acceptedFinishActorId: "manager",
    teamId: "team",
    seasonId: "season",
    currentControllerEpoch: 1,
    unresolvedConflicts: false,
    mapping,
    policy,
    serverNowMs: start + 8_000_000,
    scheduledAtMs: start,
    sharing: "manager_only",
    sharingPolicyVersion: 0,
  };
}
describe("accepted full-time community context", () => {
  it("flags corrected participation eligibility while retaining the independently mapped original finish", () => {
    const input = fixture();
    const original = deriveFinishedMatchContext(input);
    expect(finishEligibilityChanged(input.state, original)).toBe(false);
    const state = reduceMatch(input.state, {
      id: "late-substitution",
      type: "lineup.committed",
      lineup: config.selectedPlayerIds
        .slice(0, 7)
        .map((playerId, index) => ({
          slotId: `slot-${index}`,
          position: index === 0 ? "GK" : "CM",
          playerId: playerId === "p6" ? "p8" : playerId,
        })),
      effective: { half: 2, halfElapsedMs: 1_000, matchElapsedMs: 1_501_000 },
      sourceRevision: input.state.revision,
      lateEntryReason:
        "The notebook confirms the missed second-half substitution.",
      sample: {
        monotonicMs: 3_400_000,
        sessionId: "boot",
        wallTimeMs: start + 99_000_000,
      },
    });
    expect(finishEligibilityChanged(state, original)).toBe(true);
    expect(deriveFinishedMatchContext({ ...input, state })).toMatchObject({
      finishQuality: "review_required",
      actualFullTimeAtMs: original.actualFullTimeAtMs,
    });
    // A separately recorded goal does not alter award eligibility.
    const goal = reduceMatch(input.state, {
      id: "late-goal",
      type: "goal.recorded",
      beneficiary: "us",
      effective: { half: 1, halfElapsedMs: 1_000, matchElapsedMs: 1_000 },
      lateEntryReason: "The referee confirmed the missed goal.",
      sample: {
        monotonicMs: 3_400_000,
        sessionId: "boot",
        wallTimeMs: start + 99_000_000,
      },
    });
    expect(finishEligibilityChanged(goal, original)).toBe(false);
  });
  it("uses mapped original full time despite wrong device wall time and late upload, preserving actual eligibility", () => {
    const input = fixture();
    const match = deriveFinishedMatchContext(input);
    expect(match).toMatchObject({
      actualFullTimeAtMs: start + 3_300_000,
      finishQuality: "trusted",
      sharing: "manager_only",
      playedAtMs: start,
    });
    expect(match.actualFullTimeAtMs).not.toBe(input.state.completedAtMs);
    expect(match.presentPlayerIds).toHaveLength(9);
    expect(match.playedPlayerIds).toHaveLength(7);
    expect(match).not.toHaveProperty("voteCutoffAtMs");
  });
  it("retains missing or disputed evidence for review rather than accepting a client trusted label", () => {
    for (const change of [
      { mapping: null },
      { policy: null },
      { acceptedFinish: null },
      { acceptedFinishActorId: "other" },
      { currentControllerEpoch: 2 },
      { state: { ...fixture().state, recoveryRequired: true } },
    ]) {
      expect(
        deriveFinishedMatchContext({ ...fixture(), ...change }),
      ).toMatchObject({
        finishQuality: "review_required",
        actualFullTimeAtMs: null,
      });
    }
    expect(
      deriveFinishedMatchContext({ ...fixture(), unresolvedConflicts: true }),
    ).toMatchObject({ finishQuality: "conflicted", actualFullTimeAtMs: null });
  });
  it("requires the retained accepted final boundary, not an unrelated half or mutated sample", () => {
    const input = fixture();
    const finish = input.acceptedFinish!;
    for (const changed of [
      { ...finish, eventId: "end-one" },
      {
        ...finish,
        command: {
          ...finish.command,
          sample: { ...finish.command.sample, monotonicMs: 1_510_000 },
        },
      },
    ]) {
      expect(
        deriveFinishedMatchContext({ ...input, acceptedFinish: changed })
          .finishQuality,
      ).toBe("review_required");
    }
    expect(() =>
      deriveFinishedMatchContext({
        ...input,
        state: { ...input.state, status: "abandoned" },
      }),
    ).toThrow();
  });
});
