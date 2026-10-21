import type { MatchState } from "../../../packages/domain/src/types";
import { replayMatch } from "../../../packages/domain/src/index";
import type { CommunityMatch } from "../../../packages/application/src/community";
import type { EventEnvelope } from "./store";
import {
  mapContinuousInstant,
  type ContinuousUtcMapping,
  type TrustedTimePolicy,
} from "./trusted-time";

export interface FinishedMatchContextInput {
  /** State and final envelope must be loaded from accepted server history inside one transaction. */
  state: MatchState;
  acceptedFinish: EventEnvelope | null;
  acceptedFinishActorId: string | null;
  teamId: string;
  seasonId: string;
  currentControllerEpoch: number;
  unresolvedConflicts: boolean;
  mapping: ContinuousUtcMapping | null;
  policy: TrustedTimePolicy | null;
  serverNowMs: number;
  /** Accepted scheduled fixture instant; never labelled actual full time. */
  scheduledAtMs: number;
  /** Server-owned decision only. Missing approval preserves manager-only recording. */
  sharing: CommunityMatch["sharing"];
  sharingPolicyVersion: number;
}
function eligibilityEvidence(state: MatchState) {
  const selected = [...state.config.selectedPlayerIds];
  const present = selected.filter((id) => state.attendance[id] === "present");
  const played = selected.filter((id) =>
    state.intervals.some(
      (interval) =>
        interval.playerId === id &&
        interval.state === "playing" &&
        interval.endMs > interval.startMs,
    ),
  );
  return {
    selected,
    present,
    played,
    contradictory: played.some((id) => !present.includes(id)),
  };
}
/** Eligibility corrections need review; they never reopen a sealed award or its deadline. */
export function finishEligibilityChanged(
  state: MatchState,
  original: Pick<
    CommunityMatch,
    "selectedPlayerIds" | "presentPlayerIds" | "playedPlayerIds"
  >,
): boolean {
  const evidence = eligibilityEvidence(state);
  const equal = (left: string[], right: string[]) =>
    JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
  return (
    evidence.contradictory ||
    !equal(evidence.selected, original.selectedPlayerIds) ||
    !equal(evidence.present, original.presentPlayerIds) ||
    !equal(evidence.played, original.playedPlayerIds)
  );
}
export function deriveFinishedMatchContext(
  input: FinishedMatchContextInput,
): Omit<
  CommunityMatch,
  "voteCutoffAtMs" | "cutoffSource" | "finalisationDeadlineAtMs"
> {
  const { state, acceptedFinish: finish } = input;
  if (state.status !== "completed")
    throw new Error(
      "Only an explicitly completed match can establish full-time award context.",
    );
  const retainedFinish = state.eventHistory
    ?.filter((event) => event.type === "half.ended")
    .at(-1);
  const matchesAcceptedFinish =
    finish?.command.type === "half.ended" &&
    finish.eventId === retainedFinish?.id &&
    finish.matchId === state.config.matchId &&
    finish.controllerEpoch === input.currentControllerEpoch &&
    finish.command.sample.monotonicMs === retainedFinish.sample.monotonicMs &&
    finish.command.sample.sessionId === retainedFinish.sample.sessionId &&
    finish.clockEvidence.monotonicMs === finish.command.sample.monotonicMs &&
    finish.command.sample.sessionId === finish.clockEvidence.continuityId &&
    input.acceptedFinishActorId !== null;
  const instant =
    matchesAcceptedFinish && input.mapping && input.policy && finish
      ? mapContinuousInstant(
          input.mapping,
          {
            accountId: input.acceptedFinishActorId!,
            deviceId: finish.deviceId,
            matchId: finish.matchId,
            controllerEpoch: finish.controllerEpoch,
            continuityId: finish.command.sample.sessionId,
          },
          finish.command.sample.monotonicMs,
          input.serverNowMs,
          input.policy,
        )
      : null;
  const trusted =
    !input.unresolvedConflicts &&
    !state.recoveryRequired &&
    instant?.quality === "trusted" &&
    instant.utcMs <= input.serverNowMs;
  const eligibility = eligibilityEvidence(state);
  const present = eligibility.present;
  const history = state.eventHistory ?? [];
  const finishIndex = history.findIndex(
    (event) => event.id === retainedFinish?.id,
  );
  let changedAfterFinish = false;
  if (finishIndex >= 0 && finishIndex < history.length - 1) {
    const atFinish = eligibilityEvidence(
      replayMatch(state.config, history.slice(0, finishIndex + 1)),
    );
    changedAfterFinish = finishEligibilityChanged(state, {
      selectedPlayerIds: atFinish.selected,
      presentPlayerIds: atFinish.present,
      playedPlayerIds: atFinish.played,
    });
  }
  return {
    id: state.config.matchId,
    teamId: input.teamId,
    seasonId: input.seasonId,
    label: state.config.fixture
      ? `${state.config.fixture.teamName} v ${state.config.fixture.opponent}`
      : state.config.matchId,
    // No device wall clock or upload receipt establishes the original finish.
    playedAtMs: input.scheduledAtMs,
    selectedPlayerIds: [...state.config.selectedPlayerIds],
    presentPlayerIds: present,
    playedPlayerIds: present.filter((id) =>
      state.intervals.some(
        (interval) =>
          interval.playerId === id &&
          interval.state === "playing" &&
          interval.endMs > interval.startMs,
      ),
    ),
    actualFullTimeAtMs: trusted ? instant.utcMs : null,
    finishQuality: input.unresolvedConflicts
      ? "conflicted"
      : trusted && !eligibility.contradictory && !changedAfterFinish
        ? "trusted"
        : "review_required",
    sharing: input.sharing,
    policyVersion: input.sharingPolicyVersion,
  };
}
