import { cloneValue, effectiveTime, goalRecord } from "./live-events";
import type {
  Allocation,
  Attendance,
  AvailabilityRecord,
  EffectiveMatchTime,
  MatchEvent,
  MatchState,
  ParticipationInterval,
  TargetInterval,
} from "./types";

type Correction = Extract<
  MatchEvent,
  { type: "event.corrected" | "event.voided" }
>;
type ReviewedChange =
  | Correction
  | Extract<MatchEvent, { type: "lineup.committed" | "availability.changed" }>;
type FactType =
  | "attendance.recorded"
  | "availability.changed"
  | "lineup.committed"
  | "half.started";
export interface ParticipationFact {
  eventId: string;
  latestEventId: string;
  aliases: string[];
  type: FactType;
  order: number;
  effective: EffectiveMatchTime | null;
  recordedAtMs: number;
  playerId?: string;
  status?: Attendance;
  available?: boolean;
  reason?: AvailabilityRecord["reason"];
  lineup?: Allocation[];
  voided: boolean;
}
export interface ParticipationReprojection {
  state: MatchState;
  priorValue: unknown;
  value: unknown;
  effective: EffectiveMatchTime | null;
  earliestAffected: EffectiveMatchTime | null;
}
type Fact = ParticipationFact;
type ValidateLineup = (
  state: MatchState,
  lineup: Allocation[],
  requireComplete?: boolean,
) => string[];
const copyLineup = (lineup: Allocation[]) =>
  lineup.map((item) => ({ ...item }));
const compare = (left: Fact, right: Fact) =>
  (left.effective?.half ?? 0) - (right.effective?.half ?? 0) ||
  (left.effective?.matchElapsedMs ?? 0) -
    (right.effective?.matchElapsedMs ?? 0) ||
  left.order - right.order;
function knownBoundary(
  state: MatchState,
  eventId: string,
): EffectiveMatchTime | null {
  const audit = state.audit?.find((item) => item.eventId === eventId);
  if (!audit)
    throw new Error(
      "Original event boundary evidence is missing. Retain the history for explicit reconciliation.",
    );
  return audit.effective ? effectiveTime(state, audit.effective) : null;
}
function initial(state: MatchState) {
  return {
    attendance: Object.fromEntries(
      state.config.selectedPlayerIds.map((id) => [
        id,
        state.config.initialAttendance?.[id] ?? "not_recorded",
      ]),
    ) as Record<string, Attendance>,
    availability: Object.fromEntries(
      state.config.selectedPlayerIds.map((id) => [id, true]),
    ) as Record<string, boolean>,
    lineup: [] as Allocation[],
  };
}
function applyFact(current: ReturnType<typeof initial>, fact: Fact): void {
  if (fact.voided) return;
  if (fact.type === "attendance.recorded") {
    current.attendance[fact.playerId!] = fact.status!;
    if (fact.status !== "present")
      current.lineup = current.lineup.filter(
        (item) => item.playerId !== fact.playerId,
      );
  } else if (fact.type === "availability.changed") {
    current.availability[fact.playerId!] = fact.available!;
    if (!fact.available)
      current.lineup = current.lineup.filter(
        (item) => item.playerId !== fact.playerId,
      );
    if (fact.lineup) current.lineup = copyLineup(fact.lineup);
  } else current.lineup = copyLineup(fact.lineup!);
}
function factsAt(
  state: MatchState,
  facts: Fact[],
  half: 0 | 1 | 2,
  activeMs: number,
) {
  const current = initial(state);
  for (const fact of [...facts].sort(compare)) {
    if (
      fact.effective &&
      (fact.effective.half > half || fact.effective.matchElapsedMs > activeMs)
    )
      continue;
    applyFact(current, fact);
  }
  return current;
}
function replacementValue(
  state: MatchState,
  fact: Fact,
  event: Correction,
): Fact {
  if (fact.type !== "lineup.committed" && fact.type !== "availability.changed")
    throw new Error(
      "This correction requires a separate review of clock, halves or attendance evidence.",
    );
  const next = {
    ...cloneValue(fact),
    latestEventId: event.id,
    aliases: [...fact.aliases, event.id],
  };
  if (event.type === "event.voided") {
    if (fact.voided)
      throw new Error("This participation event is already voided.");
    return { ...next, voided: true };
  }
  if (event.replacement.type !== fact.type)
    throw new Error("A correction cannot change the original event family.");
  if (fact.voided && event.restoreVoided !== true)
    throw new Error(
      "Restoring a voided participation event needs explicit confirmation.",
    );
  const requested = event.replacement.effective ?? fact.effective;
  const boundary = requested ? effectiveTime(state, requested) : null;
  if ((boundary?.half ?? 0) !== (fact.effective?.half ?? 0))
    throw new Error(
      "A participation correction cannot move evidence into another half. Review both halves separately.",
    );
  if (event.replacement.type === "lineup.committed") {
    if (!boundary)
      throw new Error(
        "A corrected lineup needs its actual active-time boundary.",
      );
    return {
      ...next,
      effective: boundary,
      lineup: copyLineup(event.replacement.lineup),
      voided: false,
    };
  }
  const replacement = event.replacement;
  if (
    replacement.playerId !== fact.playerId ||
    !state.config.selectedPlayerIds.includes(replacement.playerId)
  )
    throw new Error(
      "An availability correction must retain its selected player identity.",
    );
  if (typeof replacement.available !== "boolean")
    throw new Error("Availability must be confirmed explicitly.");
  const reason = replacement.reason ?? fact.reason ?? "other";
  if (
    !["arrival", "departure", "injury", "return", "other"].includes(reason) ||
    (["arrival", "return"].includes(reason) && !replacement.available) ||
    (["injury", "departure"].includes(reason) && replacement.available)
  )
    throw new Error("Availability reason conflicts with the confirmed state.");
  return {
    ...next,
    effective: boundary,
    available: replacement.available,
    reason,
    lineup: replacement.replacementLineup
      ? copyLineup(replacement.replacementLineup)
      : fact.lineup
        ? copyLineup(fact.lineup)
        : undefined,
    voided: false,
  };
}

function retainedParticipationFacts(state: MatchState): Fact[] {
  const facts: Fact[] = [];
  let staged: Allocation[] = [];
  for (const [order, event] of (state.eventHistory ?? []).entries()) {
    const effective = knownBoundary(state, event.id);
    if (event.type === "lineup.staged") {
      staged = copyLineup(event.lineup);
      continue;
    }
    if (event.type === "half.ended" && effective?.half === 1) {
      staged = copyLineup(
        factsAt(state, facts, 1, effective.matchElapsedMs).lineup,
      );
      continue;
    }
    if (event.type === "event.corrected" || event.type === "event.voided") {
      const index = facts.findIndex((fact) =>
        fact.aliases.includes(event.targetEventId),
      );
      if (
        index >= 0 &&
        ["lineup.committed", "availability.changed"].includes(facts[index].type)
      )
        facts[index] = replacementValue(state, facts[index], event);
      continue;
    }
    const base = {
      eventId: event.id,
      latestEventId: event.id,
      aliases: [event.id],
      order,
      effective,
      recordedAtMs: event.sample.wallTimeMs,
      voided: false,
    };
    if (event.type === "half.started") {
      if (!effective)
        throw new Error("A half start is missing its actual active boundary.");
      facts.push({ ...base, type: event.type, lineup: copyLineup(staged) });
    } else if (event.type === "lineup.committed")
      facts.push({
        ...base,
        type: event.type,
        lineup: copyLineup(event.lineup),
      });
    else if (event.type === "attendance.recorded")
      facts.push({
        ...base,
        type: event.type,
        playerId: event.playerId,
        status: event.status,
      });
    else if (event.type === "availability.changed")
      facts.push({
        ...base,
        type: event.type,
        playerId: event.playerId,
        available: event.available,
        reason: event.reason ?? "other",
        lineup: event.replacementLineup
          ? copyLineup(event.replacementLineup)
          : undefined,
      });
  }
  return facts;
}

/** Logical facts retain original and latest event IDs, including explicitly voided evidence. */
export function participationEvidence(state: MatchState): ParticipationFact[] {
  return cloneValue(
    retainedParticipationFacts(state)
      .filter(
        (fact) =>
          fact.type === "lineup.committed" ||
          fact.type === "availability.changed",
      )
      .sort(compare),
  );
}

/** Rebuild materialised intervals from recorded active coordinates, never fabricated clock samples.
 * Clock controls, actual half lengths, raw evidence, original commands and profile snapshots are retained.
 */
export function reprojectParticipation(
  state: MatchState,
  correction: ReviewedChange,
  validateLineup: ValidateLineup,
): ParticipationReprojection {
  if (correction.sourceRevision !== state.revision)
    throw new Error(
      "Participation correction draft is stale or lacks explicit interval reconciliation review. Review the current recorded history first.",
    );
  const facts = retainedParticipationFacts(state);
  let prior: Fact | null = null;
  let changed: Fact;
  if (
    correction.type === "event.corrected" ||
    correction.type === "event.voided"
  ) {
    const targetIndex = facts.findIndex((fact) =>
      fact.aliases.includes(correction.targetEventId),
    );
    if (targetIndex < 0)
      throw new Error(
        "The participation correction target has no complete original evidence in this match.",
      );
    prior = cloneValue(facts[targetIndex]);
    changed = replacementValue(state, prior, correction);
    facts[targetIndex] = changed;
  } else {
    if (
      !correction.effective ||
      !correction.lateEntryReason?.trim() ||
      correction.lateEntryReason.length > 500
    )
      throw new Error(
        "A historical participation entry needs an explicit effective time and audited late-entry reason of 1–500 characters.",
      );
    const effective = effectiveTime(state, correction.effective);
    const base = {
      eventId: correction.id,
      latestEventId: correction.id,
      aliases: [correction.id],
      order: state.eventHistory?.length ?? 0,
      effective,
      recordedAtMs: correction.sample.wallTimeMs,
      voided: false,
    };
    if (correction.type === "lineup.committed")
      changed = {
        ...base,
        type: correction.type,
        lineup: copyLineup(correction.lineup),
      };
    else {
      if (
        !state.config.selectedPlayerIds.includes(correction.playerId) ||
        typeof correction.available !== "boolean"
      )
        throw new Error(
          "Historical availability requires a selected player and explicit state.",
        );
      const reason = correction.reason ?? "other";
      if (
        !["arrival", "departure", "injury", "return", "other"].includes(
          reason,
        ) ||
        (["arrival", "return"].includes(reason) && !correction.available) ||
        (["injury", "departure"].includes(reason) && correction.available)
      )
        throw new Error(
          "Availability reason conflicts with the confirmed state.",
        );
      changed = {
        ...base,
        type: correction.type,
        playerId: correction.playerId,
        available: correction.available,
        reason,
        lineup: correction.replacementLineup
          ? copyLineup(correction.replacementLineup)
          : undefined,
      };
    }
    facts.push(changed);
  }
  const sorted = [...facts].sort(compare);
  const intervals: ParticipationInterval[] = [];
  const targetIntervals: TargetInterval[] = [];
  const availabilityHistory: AvailabilityRecord[] = [];
  const current = initial(state);
  let activeHalf: 0 | 1 | 2 = 0;
  for (const fact of sorted) {
    if (fact.voided) continue;
    if (fact.type === "availability.changed")
      availabilityHistory.push({
        eventId: fact.eventId,
        latestEventId: fact.latestEventId,
        playerId: fact.playerId!,
        available: fact.available!,
        previousAvailability: current.availability[fact.playerId!],
        reason: fact.reason ?? "other",
        effective: fact.effective,
        recordedAtMs: fact.recordedAtMs,
      });
    applyFact(current, fact);
    if (fact.effective) activeHalf = fact.effective.half;
    if (
      fact.type === "half.started" ||
      fact.type === "lineup.committed" ||
      (fact.type === "availability.changed" && fact.lineup)
    ) {
      const errors = validateLineup(
        {
          ...state,
          attendance: current.attendance,
          availability: current.availability,
        },
        current.lineup,
        true,
      );
      if (errors.length)
        throw new Error(`Corrected allocation is invalid: ${errors.join(" ")}`);
    }
    if (activeHalf > state.half)
      throw new Error("Corrected evidence refers to an unstarted half.");
  }
  const firstEnd =
    state.firstHalfDurationMs ?? (state.half === 1 ? state.matchActiveMs : 0);
  for (const half of [1, 2] as const) {
    if (half > state.half) continue;
    const start = half === 1 ? 0 : firstEnd;
    const end = half === 1 ? firstEnd : state.matchActiveMs;
    const boundaries = [
      ...new Set([
        start,
        end,
        ...sorted
          .filter((fact) => !fact.voided && fact.effective?.half === half)
          .map((fact) => fact.effective!.matchElapsedMs),
      ]),
    ].sort((a, b) => a - b);
    for (let index = 0; index + 1 < boundaries.length; index++) {
      const from = boundaries[index],
        to = boundaries[index + 1];
      if (from < start || to > end || to <= from) continue;
      const actual = factsAt(state, sorted, half, from);
      const errors = validateLineup(
        {
          ...state,
          attendance: actual.attendance,
          availability: actual.availability,
        },
        actual.lineup,
        false,
      );
      if (errors.length)
        throw new Error(
          `Corrected participation is invalid: ${errors.join(" ")}`,
        );
      for (const playerId of state.config.selectedPlayerIds) {
        const allocation = actual.lineup.find(
          (item) => item.playerId === playerId,
        );
        const available =
          actual.attendance[playerId] === "present" &&
          actual.availability[playerId];
        intervals.push({
          playerId,
          state: allocation
            ? "playing"
            : available
              ? "available_bench"
              : "unavailable",
          position: allocation?.position ?? null,
          slotId: allocation?.slotId ?? null,
          startMs: from,
          endMs: to,
          half,
        });
      }
      const availablePlayerIds = state.config.selectedPlayerIds.filter(
        (id) => actual.attendance[id] === "present" && actual.availability[id],
      );
      targetIntervals.push({
        durationMs: to - from,
        availablePlayerIds,
        pitchPlaces: state.config.pitchPlaces,
        fixedKeeperId:
          state.config.fixedKeeperId &&
          availablePlayerIds.includes(state.config.fixedKeeperId)
            ? state.config.fixedKeeperId
            : null,
      });
    }
  }
  const final = factsAt(state, sorted, state.half, state.matchActiveMs);
  const projected: MatchState = {
    ...state,
    intervals,
    targetIntervals,
    lineup: final.lineup,
    attendance: { ...state.attendance, ...final.attendance },
    availability: { ...state.availability, ...final.availability },
    availabilityHistory,
  };
  for (const goal of state.goals ?? [])
    if (!goal.voided) {
      try {
        goalRecord(projected, goal, goal.eventId, goal.recordedAtMs);
      } catch {
        throw new Error(
          `Goal ${goal.eventId} no longer has consistent on-pitch evidence. Review that goal explicitly before applying this participation correction.`,
        );
      }
    }
  const oldTime = prior?.effective,
    newTime = changed.effective;
  const earliestAffected =
    oldTime && newTime
      ? oldTime.matchElapsedMs <= newTime.matchElapsedMs
        ? oldTime
        : newTime
      : (oldTime ?? newTime);
  return {
    state: projected,
    priorValue: prior,
    value: changed,
    effective: changed.effective,
    earliestAffected,
  };
}
