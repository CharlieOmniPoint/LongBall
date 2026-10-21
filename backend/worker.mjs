// packages/application/src/training-series.ts
var maximumTrainingOccurrences = 52;
function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}
function trainingSeriesOccurrences(state, seasonId, recurrenceGroupId) {
  requireThat(typeof recurrenceGroupId === "string" && recurrenceGroupId.trim().length > 0 && recurrenceGroupId.length <= 150, "A stable training series identity is required.");
  requireThat(seasonId === state.activeSeasonId, "Choose the current season before editing a training series.");
  const occurrences = state.training.filter((item) => item.recurrenceGroupId === recurrenceGroupId);
  requireThat(occurrences.every((item) => item.seasonId === seasonId), "The training series belongs to a different season.");
  return [...occurrences].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
}
function applyTrainingSeries(state, command, validate) {
  requireThat(command.confirmOccurrences === true, "Review and explicitly confirm the listed training occurrences.");
  const series = trainingSeriesOccurrences(state, command.seasonId, command.recurrenceGroupId);
  if (command.type === "training.series_created") {
    requireThat(series.length === 0, "That training series already exists; use its scheduled-occurrence editor.");
    requireThat(Array.isArray(command.occurrences) && command.occurrences.length >= 2 && command.occurrences.length <= maximumTrainingOccurrences, "A series needs between 2 and 52 explicit occurrences.");
    const ids = /* @__PURE__ */ new Set(), dates = /* @__PURE__ */ new Set();
    for (const draft of command.occurrences) {
      requireThat(draft.seasonId === command.seasonId && draft.recurrenceGroupId === command.recurrenceGroupId, "Every occurrence must belong to the confirmed series and season.");
      requireThat(!ids.has(draft.id) && !state.training.some((item) => item.id === draft.id), "Each occurrence must have a new stable identity.");
      requireThat(!dates.has(draft.date), "Each series occurrence must have a distinct calendar date.");
      validate(draft);
      ids.add(draft.id);
      dates.add(draft.date);
    }
    state.training.push(...command.occurrences.map((draft) => ({ ...draft, expectedProfileIds: [...draft.expectedProfileIds], status: "scheduled", responses: {}, attendance: {} })));
    return;
  }
  const scheduled = series.filter((item) => item.status === "scheduled");
  requireThat(Array.isArray(command.occurrenceIds) && command.occurrenceIds.length > 0 && command.occurrenceIds.length <= maximumTrainingOccurrences && new Set(command.occurrenceIds).size === command.occurrenceIds.length, "Review a nonempty list of distinct scheduled occurrences.");
  requireThat(command.occurrenceIds.length === scheduled.length && scheduled.every((item) => command.occurrenceIds.includes(item.id)), "The scheduled series changed; review its exact occurrence list again. Held and cancelled occurrences cannot be edited as scheduled sessions.");
  if (command.type === "training.series_updated") {
    for (const occurrence of scheduled) validate({ ...occurrence, ...command.changes });
    const ids = new Set(command.occurrenceIds);
    state.training = state.training.map((item) => ids.has(item.id) ? { ...item, time: command.changes.time, venue: command.changes.venue, expectedProfileIds: [...command.changes.expectedProfileIds] } : item);
  } else {
    const ids = new Set(command.occurrenceIds);
    state.training = state.training.map((item) => ids.has(item.id) ? { ...item, status: "cancelled" } : item);
  }
}

// packages/domain/src/live-events.ts
function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}
function duration(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer.`);
}
function effectiveTime(state, requested) {
  if (state.half !== 1 && state.half !== 2) throw new Error("An effective match event requires a started half.");
  const time3 = requested ?? { half: state.half, halfElapsedMs: state.halfActiveMs, matchElapsedMs: state.matchActiveMs };
  if (time3.half !== 1 && time3.half !== 2) throw new Error("Effective half must be one or two.");
  duration(time3.halfElapsedMs, "Effective half time");
  duration(time3.matchElapsedMs, "Effective match time");
  if (time3.half > state.half) throw new Error("Effective time cannot refer to a half that has not started.");
  const firstHalf = state.firstHalfDurationMs;
  if (time3.half === 2 && firstHalf === null) throw new Error("Second-half time requires the recorded actual first-half duration.");
  const expected = (time3.half === 2 ? firstHalf ?? 0 : 0) + time3.halfElapsedMs;
  if (expected !== time3.matchElapsedMs) throw new Error("Effective cumulative time must use actual first-half duration and exclude half-time.");
  const maximum = time3.half === 1 && firstHalf !== null ? firstHalf : state.halfActiveMs;
  if (time3.halfElapsedMs > maximum || time3.matchElapsedMs > state.matchActiveMs) throw new Error("Effective time cannot invent future active play.");
  return { ...time3 };
}
function wasOnPitch(state, playerId, time3) {
  if (time3.matchElapsedMs === state.matchActiveMs && time3.half === state.half && state.lineup.some((item) => item.playerId === playerId)) return true;
  return state.intervals.some((interval) => interval.playerId === playerId && interval.state === "playing" && interval.half === time3.half && interval.startMs <= time3.matchElapsedMs && interval.endMs >= time3.matchElapsedMs);
}
function goalRecord(state, details, eventId, recordedAtMs) {
  if (details.beneficiary !== "us" && details.beneficiary !== "opposition") throw new Error("Goal beneficiary is invalid.");
  if (details.isOwnGoal !== void 0 && typeof details.isOwnGoal !== "boolean") throw new Error("Own-goal classification must be explicit.");
  const isOwnGoal = details.isOwnGoal ?? false;
  const scorerPlayerId = details.scorerPlayerId ?? null;
  const goalType = details.goalType ?? "not_recorded";
  if (!["open_play", "free_kick", "penalty", "not_recorded"].includes(goalType)) throw new Error("Goal type is invalid.");
  const effective = effectiveTime(state, details.effective);
  if (scorerPlayerId !== null) {
    if (!state.config.selectedPlayerIds.includes(scorerPlayerId)) throw new Error("A scorer must belong to this selected match squad.");
    if (details.beneficiary === "us" && isOwnGoal || details.beneficiary === "opposition" && !isOwnGoal) {
      throw new Error("An opposition scorer or opposition own goal cannot credit a team player.");
    }
    if (!wasOnPitch(state, scorerPlayerId, effective)) throw new Error("The scorer has no recorded on-pitch evidence at the effective goal time. Correct participation separately before attributing this goal.");
  }
  return { eventId, latestEventId: eventId, beneficiary: details.beneficiary, isOwnGoal, scorerPlayerId, goalType, effective, recordedAtMs, voided: false };
}
function scoresFromGoals(state, goals) {
  const active2 = goals.filter((goal) => !goal.voided);
  const sum = (values) => ({
    for: values.filter((goal) => goal.beneficiary === "us").length,
    against: values.filter((goal) => goal.beneficiary === "opposition").length
  });
  return {
    score: sum(active2),
    halfTimeScore: state.firstHalfDurationMs === null ? state.halfTimeScore : sum(active2.filter((goal) => goal.effective.half === 1))
  };
}

// packages/domain/src/policy.ts
function fail(message) {
  throw new Error(message);
}
function keys(value, fields4, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields4.includes(key)) || fields4.some((key) => !Object.hasOwn(value, key))) fail(`Use the exact versioned ${label} fields.`);
}
function nonnegative(value, label) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(`${label} must be a nonnegative safe integer.`);
}
function keeperRank(config, playerId) {
  const saved = config.profileSnapshot?.find((profile) => profile.playerId === playerId);
  return saved ? saved.preferences.indexOf("GK") + 1 : config.players.find((player) => player.id === playerId)?.goalkeeperChoice ?? 0;
}
function initialKeeperPolicy(config) {
  return { keeperMode: config.fixedKeeperId ? "sole_fixed" : "common_pool", fixedKeeperPlayerSeasonId: config.fixedKeeperId };
}
function assertMatchPolicyProposal(value, config) {
  keys(value, ["payload", "applicability", "softPreferences"], "match policy proposal");
  const payload = value.payload;
  keys(payload, ["keeperMode", "fixedKeeperPlayerSeasonId", "minimumStintMs", "batchLimit", "scoreLeadThreshold", "returnToNormalEnabled"], "canonical policy payload");
  if (!["sole_fixed", "common_pool"].includes(String(payload.keeperMode))) fail("Choose an explicit supported goalkeeper policy.");
  if (payload.keeperMode === "common_pool" && payload.fixedKeeperPlayerSeasonId !== null) fail("Common-pool policy cannot create a fixed-keeper exemption.");
  if (payload.keeperMode === "sole_fixed" && (typeof payload.fixedKeeperPlayerSeasonId !== "string" || !config.selectedPlayerIds.includes(payload.fixedKeeperPlayerSeasonId) || ![1, 2].includes(keeperRank(config, payload.fixedKeeperPlayerSeasonId)))) fail("The fixed keeper must be a selected first- or second-choice goalkeeper.");
  nonnegative(payload.minimumStintMs, "Preferred minimum stint");
  if (!Number.isSafeInteger(payload.batchLimit) || Number(payload.batchLimit) < 1 || Number(payload.batchLimit) > 11) fail("Choose a batch preference from one to eleven.");
  if (!Number.isSafeInteger(payload.scoreLeadThreshold) || Number(payload.scoreLeadThreshold) < 1 || typeof payload.returnToNormalEnabled !== "boolean") fail("Choose a positive score threshold and an explicit return-to-normal option.");
  keys(value.applicability, ["minimumStint", "batchLimit", "q07"], "policy applicability");
  if (value.applicability.minimumStint !== "soft_preference" || value.applicability.batchLimit !== "soft_preference" || value.applicability.q07 !== "unapproved") fail("Ordinary stint and batch settings remain soft. This command cannot approve Q07 or introduce a mandatory constraint.");
  keys(value.softPreferences, ["halfBufferFraction"], "soft preferences");
  const fraction = value.softPreferences.halfBufferFraction;
  if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 0.49) fail("The soft half buffer must be between zero and 0.49.");
}
function assertInitialLineupProposal(config, value) {
  if (!Array.isArray(value) || value.length !== config.pitchPlaces || new Set(value.map((item) => item?.playerId)).size !== value.length || new Set(value.map((item) => item?.slotId)).size !== value.length) fail("A starting-lineup proposal needs distinct selected players and slots for the saved format.");
  for (const allocation of value) {
    keys(allocation, ["slotId", "position", "playerId"], "lineup proposal");
    if (typeof allocation.playerId !== "string" || !config.selectedPlayerIds.includes(allocation.playerId) || typeof allocation.slotId !== "string" || !allocation.slotId || typeof allocation.position !== "string" || !allocation.position) fail("Starting-lineup proposals must use the selected saved match squad.");
    if (config.slots && !config.slots.some((slot) => slot.slotId === allocation.slotId && slot.position === allocation.position)) fail("Starting-lineup proposals must use the saved formation slots and roles.");
    const saved = config.profileSnapshot?.find((profile) => profile.playerId === allocation.playerId);
    if (saved && !saved.eligiblePositions.includes(allocation.position)) fail("A proposed role is outside the saved player eligibility.");
  }
  const keepers = value.filter((allocation) => allocation.position === "GK");
  if (keepers.length !== 1 || ![1, 2].includes(keeperRank(config, keepers[0].playerId)) || config.fixedKeeperId && keepers[0].playerId !== config.fixedKeeperId) fail("A lineup proposal needs one qualifying keeper consistent with its explicit policy.");
}
function policyAtBoundary(state, half2, activeMs, maximumRevision = Infinity) {
  const matching = (state.policyHistory ?? []).filter((policy) => policy.revision <= maximumRevision && policy.effective.half <= half2 && policy.effective.matchElapsedMs <= activeMs);
  return matching.length ? matching[matching.length - 1] : null;
}
function fixedKeeperAtBoundary(state, half2, activeMs, maximumRevision = Infinity) {
  const policy = policyAtBoundary(state, half2, activeMs, maximumRevision);
  return policy ? policy.payload.keeperMode === "sole_fixed" ? policy.payload.fixedKeeperPlayerSeasonId : null : state.config.fixedKeeperId;
}
function currentFixedKeeper(state) {
  return state.activePolicy ? state.activePolicy.payload.keeperMode === "sole_fixed" ? state.activePolicy.payload.fixedKeeperPlayerSeasonId : null : state.config.fixedKeeperId;
}
function assertPolicyBoundary(state, time3) {
  keys(time3, ["half", "halfElapsedMs", "matchElapsedMs"], "policy boundary");
  nonnegative(time3.halfElapsedMs, "Policy half time");
  nonnegative(time3.matchElapsedMs, "Policy match time");
  if (time3.half !== state.half || ![0, 1, 2].includes(time3.half)) fail("Policy changes must use the current preparation or half boundary.");
  const expected = (time3.half === 2 ? state.firstHalfDurationMs ?? fail("The actual first-half duration is required.") : 0) + time3.halfElapsedMs;
  if (expected !== time3.matchElapsedMs || time3.matchElapsedMs !== state.matchActiveMs || time3.halfElapsedMs !== state.halfActiveMs) fail("Policy changes are prospective only; the captured boundary must match the current continuous checkpoint.");
}
function applyPolicyChange(state, event, previousRevision) {
  const allowed = ["id", "sample", "actorId", "type", "policySchemaVersion", "policyVersion", "previousPolicyVersion", "sourceRevision", "effective", "reason", "payload", "applicability", "softPreferences", "resetPositionMode"];
  if (Object.keys(event).some((key) => !allowed.includes(key))) fail("Use only the documented versioned policy command fields.");
  nonnegative(event.policyVersion, "Policy version");
  nonnegative(event.previousPolicyVersion, "Previous policy version");
  nonnegative(event.sourceRevision, "Policy source revision");
  assertMatchPolicyProposal({ payload: event.payload, applicability: event.applicability, softPreferences: event.softPreferences }, state.config);
  if (event.policySchemaVersion !== 1 || event.sourceRevision !== previousRevision || event.previousPolicyVersion !== (state.activePolicy?.policyVersion ?? 0) || event.policyVersion !== event.previousPolicyVersion + 1) fail("The policy source or version changed. Review the current match before confirming again.");
  if (typeof event.reason !== "string" || event.reason.trim().length < 5 || event.reason.length > 500) fail("Record a concise reason for this prospective settings change.");
  if (event.resetPositionMode !== void 0 && typeof event.resetPositionMode !== "boolean") fail("A position-mode reset must be explicit.");
  assertPolicyBoundary(state, event.effective);
  const previous = state.activePolicy?.payload ?? initialKeeperPolicy(state.config);
  if (event.payload.keeperMode !== previous.keeperMode || event.payload.fixedKeeperPlayerSeasonId !== previous.fixedKeeperPlayerSeasonId) fail("Q07 goalkeeper-policy transitions are unapproved. This service has no explicit experimental transition gate; retain the proposal for policy review.");
  const details = { policySchemaVersion: 1, policyVersion: event.policyVersion, previousPolicyVersion: event.previousPolicyVersion, sourceRevision: event.sourceRevision, effective: cloneValue(event.effective), reason: event.reason, payload: cloneValue(event.payload), applicability: cloneValue(event.applicability), softPreferences: cloneValue(event.softPreferences), ...event.resetPositionMode === void 0 ? {} : { resetPositionMode: event.resetPositionMode } };
  const record = { ...details, eventId: event.id, revision: previousRevision + 1, recordedAtMs: event.sample.wallTimeMs, actorId: event.actorId ?? null };
  const activePolicy = { ...cloneValue(record), positionMode: event.resetPositionMode ? "normal" : state.activePolicy?.positionMode ?? "normal", manualResetAtSourceRevision: event.resetPositionMode ? previousRevision + 1 : null };
  return { ...state, activePolicy, policyHistory: [...state.policyHistory ?? [], record] };
}
function updatePolicyPositionMode(state, nextRevision) {
  const policy = state.activePolicy;
  if (!policy || policy.manualResetAtSourceRevision === nextRevision) return state;
  const leading = state.score.for - state.score.against >= policy.payload.scoreLeadThreshold;
  const mode = leading ? "adventurous" : policy.payload.returnToNormalEnabled ? "normal" : policy.positionMode;
  return mode === policy.positionMode ? state : { ...state, activePolicy: { ...policy, positionMode: mode } };
}

// packages/domain/src/participation-corrections.ts
var copyLineup = (lineup) => lineup.map((item) => ({ ...item }));
function policyStateAt(state, half2, activeMs, maximumRevision = Infinity) {
  const policy = policyAtBoundary(state, half2, activeMs, maximumRevision);
  return { ...state, activePolicy: policy ? { ...policy, positionMode: "normal", manualResetAtSourceRevision: null } : void 0 };
}
var compare = (left, right) => (left.effective?.half ?? 0) - (right.effective?.half ?? 0) || (left.effective?.matchElapsedMs ?? 0) - (right.effective?.matchElapsedMs ?? 0) || left.order - right.order;
function knownBoundary(state, eventId) {
  const audit = state.audit?.find((item) => item.eventId === eventId);
  if (!audit)
    throw new Error(
      "Original event boundary evidence is missing. Retain the history for explicit reconciliation."
    );
  return audit.effective ? effectiveTime(state, audit.effective) : null;
}
function initial(state) {
  return {
    attendance: Object.fromEntries(
      state.config.selectedPlayerIds.map((id) => [
        id,
        state.config.initialAttendance?.[id] ?? "not_recorded"
      ])
    ),
    availability: Object.fromEntries(
      state.config.selectedPlayerIds.map((id) => [id, true])
    ),
    lineup: []
  };
}
function applyFact(current3, fact) {
  if (fact.voided) return;
  if (fact.type === "attendance.recorded") {
    current3.attendance[fact.playerId] = fact.status;
    if (fact.status !== "present")
      current3.lineup = current3.lineup.filter(
        (item) => item.playerId !== fact.playerId
      );
  } else if (fact.type === "availability.changed") {
    current3.availability[fact.playerId] = fact.available;
    if (!fact.available)
      current3.lineup = current3.lineup.filter(
        (item) => item.playerId !== fact.playerId
      );
    if (fact.lineup) current3.lineup = copyLineup(fact.lineup);
  } else current3.lineup = copyLineup(fact.lineup);
}
function factsAt(state, facts, half2, activeMs) {
  const current3 = initial(state);
  for (const fact of [...facts].sort(compare)) {
    if (fact.effective && (fact.effective.half > half2 || fact.effective.matchElapsedMs > activeMs))
      continue;
    applyFact(current3, fact);
  }
  return current3;
}
function replacementValue(state, fact, event) {
  if (fact.type !== "lineup.committed" && fact.type !== "availability.changed")
    throw new Error(
      "This correction requires a separate review of clock, halves or attendance evidence."
    );
  const next = {
    ...cloneValue(fact),
    latestEventId: event.id,
    aliases: [...fact.aliases, event.id]
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
      "Restoring a voided participation event needs explicit confirmation."
    );
  const requested = event.replacement.effective ?? fact.effective;
  const boundary = requested ? effectiveTime(state, requested) : null;
  if ((boundary?.half ?? 0) !== (fact.effective?.half ?? 0))
    throw new Error(
      "A participation correction cannot move evidence into another half. Review both halves separately."
    );
  if (event.replacement.type === "lineup.committed") {
    if (!boundary)
      throw new Error(
        "A corrected lineup needs its actual active-time boundary."
      );
    return {
      ...next,
      effective: boundary,
      lineup: copyLineup(event.replacement.lineup),
      voided: false
    };
  }
  const replacement = event.replacement;
  if (replacement.playerId !== fact.playerId || !state.config.selectedPlayerIds.includes(replacement.playerId))
    throw new Error(
      "An availability correction must retain its selected player identity."
    );
  if (typeof replacement.available !== "boolean")
    throw new Error("Availability must be confirmed explicitly.");
  const reason = replacement.reason ?? fact.reason ?? "other";
  if (!["arrival", "departure", "injury", "return", "other"].includes(reason) || ["arrival", "return"].includes(reason) && !replacement.available || ["injury", "departure"].includes(reason) && replacement.available)
    throw new Error("Availability reason conflicts with the confirmed state.");
  return {
    ...next,
    effective: boundary,
    available: replacement.available,
    reason,
    lineup: replacement.replacementLineup ? copyLineup(replacement.replacementLineup) : fact.lineup ? copyLineup(fact.lineup) : void 0,
    voided: false
  };
}
function retainedParticipationFacts(state) {
  const facts = [];
  let staged = [];
  for (const [order, event] of (state.eventHistory ?? []).entries()) {
    const effective = knownBoundary(state, event.id);
    if (event.type === "lineup.staged") {
      staged = copyLineup(event.lineup);
      continue;
    }
    if (event.type === "half.ended" && effective?.half === 1) {
      staged = copyLineup(
        factsAt(state, facts, 1, effective.matchElapsedMs).lineup
      );
      continue;
    }
    if (event.type === "event.corrected" || event.type === "event.voided") {
      const index = facts.findIndex(
        (fact) => fact.aliases.includes(event.targetEventId)
      );
      if (index >= 0 && ["lineup.committed", "availability.changed"].includes(facts[index].type))
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
      voided: false
    };
    if (event.type === "half.started") {
      if (!effective)
        throw new Error("A half start is missing its actual active boundary.");
      facts.push({ ...base, type: event.type, lineup: copyLineup(staged) });
    } else if (event.type === "lineup.committed")
      facts.push({
        ...base,
        type: event.type,
        lineup: copyLineup(event.lineup)
      });
    else if (event.type === "attendance.recorded")
      facts.push({
        ...base,
        type: event.type,
        playerId: event.playerId,
        status: event.status
      });
    else if (event.type === "availability.changed")
      facts.push({
        ...base,
        type: event.type,
        playerId: event.playerId,
        available: event.available,
        reason: event.reason ?? "other",
        lineup: event.replacementLineup ? copyLineup(event.replacementLineup) : void 0
      });
  }
  return facts;
}
function reprojectParticipation(state, correction, validateLineup2) {
  if (correction.sourceRevision !== state.revision)
    throw new Error(
      "Participation correction draft is stale or lacks explicit interval reconciliation review. Review the current recorded history first."
    );
  const facts = retainedParticipationFacts(state);
  let prior = null;
  let changed;
  if (correction.type === "event.corrected" || correction.type === "event.voided") {
    const targetIndex = facts.findIndex(
      (fact) => fact.aliases.includes(correction.targetEventId)
    );
    if (targetIndex < 0)
      throw new Error(
        "The participation correction target has no complete original evidence in this match."
      );
    prior = cloneValue(facts[targetIndex]);
    changed = replacementValue(state, prior, correction);
    facts[targetIndex] = changed;
  } else {
    if (!correction.effective || !correction.lateEntryReason?.trim() || correction.lateEntryReason.length > 500)
      throw new Error(
        "A historical participation entry needs an explicit effective time and audited late-entry reason of 1\u2013500 characters."
      );
    const effective = effectiveTime(state, correction.effective);
    const base = {
      eventId: correction.id,
      latestEventId: correction.id,
      aliases: [correction.id],
      order: state.eventHistory?.length ?? 0,
      effective,
      recordedAtMs: correction.sample.wallTimeMs,
      voided: false
    };
    if (correction.type === "lineup.committed")
      changed = {
        ...base,
        type: correction.type,
        lineup: copyLineup(correction.lineup)
      };
    else {
      if (!state.config.selectedPlayerIds.includes(correction.playerId) || typeof correction.available !== "boolean")
        throw new Error(
          "Historical availability requires a selected player and explicit state."
        );
      const reason = correction.reason ?? "other";
      if (!["arrival", "departure", "injury", "return", "other"].includes(
        reason
      ) || ["arrival", "return"].includes(reason) && !correction.available || ["injury", "departure"].includes(reason) && correction.available)
        throw new Error(
          "Availability reason conflicts with the confirmed state."
        );
      changed = {
        ...base,
        type: correction.type,
        playerId: correction.playerId,
        available: correction.available,
        reason,
        lineup: correction.replacementLineup ? copyLineup(correction.replacementLineup) : void 0
      };
    }
    facts.push(changed);
  }
  const sorted = [...facts].sort(compare);
  const intervals = [];
  const targetIntervals = [];
  const availabilityHistory = [];
  const current3 = initial(state);
  let activeHalf = 0;
  for (const fact of sorted) {
    if (fact.voided) continue;
    if (fact.type === "availability.changed")
      availabilityHistory.push({
        eventId: fact.eventId,
        latestEventId: fact.latestEventId,
        playerId: fact.playerId,
        available: fact.available,
        previousAvailability: current3.availability[fact.playerId],
        reason: fact.reason ?? "other",
        effective: fact.effective,
        recordedAtMs: fact.recordedAtMs
      });
    applyFact(current3, fact);
    if (fact.effective) activeHalf = fact.effective.half;
    if (fact.type === "half.started" || fact.type === "lineup.committed" || fact.type === "availability.changed" && fact.lineup) {
      const errors = validateLineup2(
        {
          ...policyStateAt(state, fact.effective?.half ?? 0, fact.effective?.matchElapsedMs ?? 0, fact.order + 1),
          attendance: current3.attendance,
          availability: current3.availability
        },
        current3.lineup,
        true
      );
      if (errors.length)
        throw new Error(`Corrected allocation is invalid: ${errors.join(" ")}`);
    }
    if (activeHalf > state.half)
      throw new Error("Corrected evidence refers to an unstarted half.");
  }
  const firstEnd = state.firstHalfDurationMs ?? (state.half === 1 ? state.matchActiveMs : 0);
  for (const half2 of [1, 2]) {
    if (half2 > state.half) continue;
    const start = half2 === 1 ? 0 : firstEnd;
    const end = half2 === 1 ? firstEnd : state.matchActiveMs;
    const boundaries = [
      .../* @__PURE__ */ new Set([
        start,
        end,
        ...sorted.filter((fact) => !fact.voided && fact.effective?.half === half2).map((fact) => fact.effective.matchElapsedMs),
        ...(state.policyHistory ?? []).filter((policy) => policy.effective.half === half2).map((policy) => policy.effective.matchElapsedMs)
      ])
    ].sort((a, b) => a - b);
    for (let index = 0; index + 1 < boundaries.length; index++) {
      const from = boundaries[index], to = boundaries[index + 1];
      if (from < start || to > end || to <= from) continue;
      const actual = factsAt(state, sorted, half2, from);
      const errors = validateLineup2(
        {
          ...policyStateAt(state, half2, from),
          attendance: actual.attendance,
          availability: actual.availability
        },
        actual.lineup,
        false
      );
      if (errors.length)
        throw new Error(
          `Corrected participation is invalid: ${errors.join(" ")}`
        );
      for (const playerId of state.config.selectedPlayerIds) {
        const allocation = actual.lineup.find(
          (item) => item.playerId === playerId
        );
        const available2 = actual.attendance[playerId] === "present" && actual.availability[playerId];
        intervals.push({
          playerId,
          state: allocation ? "playing" : available2 ? "available_bench" : "unavailable",
          position: allocation?.position ?? null,
          slotId: allocation?.slotId ?? null,
          startMs: from,
          endMs: to,
          half: half2
        });
      }
      const availablePlayerIds = state.config.selectedPlayerIds.filter(
        (id) => actual.attendance[id] === "present" && actual.availability[id]
      );
      const policy = policyAtBoundary(state, half2, from);
      const fixedKeeperId = fixedKeeperAtBoundary(state, half2, from);
      targetIntervals.push({
        durationMs: to - from,
        availablePlayerIds,
        pitchPlaces: state.config.pitchPlaces,
        fixedKeeperId: fixedKeeperId && availablePlayerIds.includes(fixedKeeperId) ? fixedKeeperId : null,
        ...policy ? { policyVersion: policy.policyVersion } : {}
      });
    }
  }
  const final = factsAt(state, sorted, state.half, state.matchActiveMs);
  const projected = {
    ...state,
    intervals,
    targetIntervals,
    lineup: final.lineup,
    attendance: { ...state.attendance, ...final.attendance },
    availability: { ...state.availability, ...final.availability },
    availabilityHistory
  };
  for (const goal of state.goals ?? [])
    if (!goal.voided) {
      try {
        goalRecord(projected, goal, goal.eventId, goal.recordedAtMs);
      } catch {
        throw new Error(
          `Goal ${goal.eventId} no longer has consistent on-pitch evidence. Review that goal explicitly before applying this participation correction.`
        );
      }
    }
  const oldTime = prior?.effective, newTime = changed.effective;
  const earliestAffected = oldTime && newTime ? oldTime.matchElapsedMs <= newTime.matchElapsedMs ? oldTime : newTime : oldTime ?? newTime;
  return {
    state: projected,
    priorValue: prior,
    value: changed,
    effective: changed.effective,
    earliestAffected
  };
}

// packages/domain/src/index.ts
var ENGINE_VERSION = "synthetic-live-4";
function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer.`);
}
function assertSample(sample) {
  if (!Number.isFinite(sample.monotonicMs) || sample.monotonicMs < 0 || !sample.sessionId) throw new Error("Clock sample is invalid.");
  integer(sample.wallTimeMs, "Wall time");
}
function isRunning(state) {
  return state.status === "first_half_running" || state.status === "second_half_running";
}
function isPaused(state) {
  return state.status === "first_half_paused" || state.status === "second_half_paused";
}
function available(state, id) {
  return state.availability[id] === true && state.attendance[id] === "present";
}
function selectedPlayer(state, id) {
  if (!state.config.selectedPlayerIds.includes(id)) throw new Error("Player is outside this selected match squad.");
}
function cloneLineup(lineup) {
  return lineup.map((item) => ({ ...item }));
}
function keeperChoice(config, playerId) {
  const snapshot = config.profileSnapshot?.find((profile) => profile.playerId === playerId);
  if (snapshot?.preferences.length) return snapshot.preferences.indexOf("GK") + 1;
  return config.players.find((player) => player.id === playerId)?.goalkeeperChoice ?? 0;
}
function createMatch(config) {
  if (!config.matchId || config.pitchPlaces < 5 || config.pitchPlaces > 11 || !Number.isInteger(config.pitchPlaces)) throw new Error("Match format must have 5\u201311 pitch places.");
  integer(config.plannedHalfDurationMs, "Planned half duration");
  if (config.plannedHalfDurationMs < 3e4) throw new Error("Planned half duration must be at least 30 seconds.");
  const ids = config.players.map((player) => player.id);
  if (new Set(ids).size !== ids.length || new Set(config.selectedPlayerIds).size !== config.selectedPlayerIds.length) throw new Error("Player identifiers must be unique.");
  if (config.selectedPlayerIds.some((id) => !ids.includes(id))) throw new Error("Selected players must belong to this roster.");
  if (config.initialAttendance && Object.entries(config.initialAttendance).some(([id, status]) => !config.selectedPlayerIds.includes(id) || !["present", "absent", "excused", "not_selected", "not_recorded"].includes(status))) throw new Error("Initial attendance must be explicit valid check-in for the selected squad.");
  if (config.slots && (config.slots.length !== config.pitchPlaces || new Set(config.slots.map((slot) => slot.slotId)).size !== config.slots.length || config.slots.filter((slot) => slot.position === "GK").length !== 1 || config.slots.some((slot) => !slot.slotId || !slot.position))) throw new Error("Saved formation needs one distinct slot per pitch place and exactly one goalkeeper.");
  if (config.profileSnapshot && (new Set(config.profileSnapshot.map((profile) => profile.playerId)).size !== config.profileSnapshot.length || config.profileSnapshot.some((profile) => !ids.includes(profile.playerId) || profile.preferences.length > 3 || new Set(profile.preferences).size !== profile.preferences.length || new Set(profile.eligiblePositions).size !== profile.eligiblePositions.length))) throw new Error("Match profile snapshots must belong to distinct roster players with distinct preferences and eligibility.");
  if (config.fixedKeeperId !== null && (!config.selectedPlayerIds.includes(config.fixedKeeperId) || ![1, 2].includes(keeperChoice(config, config.fixedKeeperId)))) throw new Error("Fixed keeper must be a selected first- or second-choice goalkeeper.");
  if (config.initialPolicyProposal !== void 0) assertMatchPolicyProposal(config.initialPolicyProposal, config);
  if (config.initialLineupProposal !== void 0) assertInitialLineupProposal(config, config.initialLineupProposal);
  return {
    config: cloneValue(config),
    status: "preparation",
    revision: 0,
    attendance: Object.fromEntries(ids.map((id) => [id, config.initialAttendance?.[id] ?? "not_recorded"])),
    availability: Object.fromEntries(ids.map((id) => [id, config.selectedPlayerIds.includes(id)])),
    stagedLineup: [],
    lineup: [],
    half: 0,
    halfActiveMs: 0,
    matchActiveMs: 0,
    firstHalfDurationMs: null,
    anchor: null,
    recoveryRequired: false,
    intervals: [],
    targetIntervals: [],
    score: { for: 0, against: 0 },
    halfTimeScore: null,
    completedAtMs: null,
    completedTimeQuality: null,
    abandonedAtMs: null,
    abandonReason: null,
    recoveryReason: null,
    appliedEvents: {},
    schemaVersion: 2,
    goals: [],
    availabilityHistory: [],
    eventHistory: [],
    audit: []
  };
}
function upgradeMatchState(previous) {
  if (previous.schemaVersion === 2 && previous.goals && previous.availabilityHistory && previous.eventHistory && previous.audit) return previous;
  let events;
  try {
    events = Object.values(previous.appliedEvents).map((signature2) => JSON.parse(signature2));
  } catch {
    throw new Error("Legacy command history cannot be read. Preserve the journal and reconcile it before continuing.");
  }
  const replayed = replayMatch(previous.config, events);
  for (const field of ["status", "revision", "half", "halfActiveMs", "matchActiveMs", "firstHalfDurationMs", "completedAtMs", "completedTimeQuality", "recoveryRequired", "recoveryReason", "attendance", "availability", "anchor", "score", "halfTimeScore", "lineup", "stagedLineup", "intervals", "targetIntervals"]) {
    if (canonical(replayed[field]) !== canonical(previous[field])) throw new Error(`Legacy replay differs at ${field}. Preserve the original journal for explicit reconciliation.`);
  }
  return replayed;
}
function validateLineup(state, lineup, requireComplete = true) {
  const errors = [];
  const fixedKeeperId = currentFixedKeeper(state);
  if (lineup.length > state.config.pitchPlaces || requireComplete && lineup.length !== state.config.pitchPlaces) errors.push(`Choose exactly ${state.config.pitchPlaces} pitch players.`);
  if (new Set(lineup.map((item) => item.playerId)).size !== lineup.length) errors.push("A player can occupy only one pitch place.");
  if (new Set(lineup.map((item) => item.slotId)).size !== lineup.length) errors.push("Each pitch slot must be unique.");
  for (const item of lineup) {
    if (!item.slotId || !item.position) errors.push("Every allocation needs a slot and position.");
    if (!state.config.selectedPlayerIds.includes(item.playerId)) errors.push("Only selected match-squad players can start.");
    else {
      if (state.attendance[item.playerId] !== "present") errors.push(`${item.playerId}: confirm actual attendance first.`);
      if (!state.availability[item.playerId]) errors.push(`${item.playerId}: player is unavailable.`);
    }
    if (state.config.slots && !state.config.slots.some((slot) => slot.slotId === item.slotId && slot.position === item.position)) errors.push("Allocation must use its saved formation slot and position.");
    const profile = state.config.profileSnapshot?.find((snapshot) => snapshot.playerId === item.playerId);
    if (profile && !profile.eligiblePositions.includes(item.position)) errors.push(`${item.playerId}: position is outside the saved match eligibility.`);
  }
  const keepers = lineup.filter((item) => item.position === "GK");
  if (requireComplete && keepers.length !== 1) errors.push("Choose exactly one goalkeeper.");
  if (keepers.length > 1) errors.push("Only one goalkeeper place is allowed.");
  for (const keeper2 of keepers) {
    const player = state.config.players.find((item) => item.id === keeper2.playerId);
    if (!player || ![1, 2].includes(keeperChoice(state.config, keeper2.playerId))) errors.push("Goalkeeper cover requires a first- or second-choice eligible keeper.");
    if (fixedKeeperId && keeper2.playerId !== fixedKeeperId) errors.push("The fixed keeper policy cannot be changed by moving a pitch piece.");
  }
  const qualifying = state.config.players.filter((player) => available(state, player.id) && [1, 2].includes(keeperChoice(state.config, player.id)));
  if (fixedKeeperId && qualifying.length > 1) errors.push("Multiple qualifying available keepers require a reviewed shared-keeper policy.");
  return [...new Set(errors)];
}
function readClock(state, sample) {
  assertSample(sample);
  let halfActiveMs = state.halfActiveMs;
  let matchActiveMs = state.matchActiveMs;
  let recoveryRequired = state.recoveryRequired;
  if (isRunning(state)) {
    const anchor = state.anchor;
    if (!anchor || anchor.sample.sessionId !== sample.sessionId || sample.monotonicMs < anchor.sample.monotonicMs) recoveryRequired = true;
    if (!recoveryRequired && anchor) {
      const delta = Math.floor(sample.monotonicMs) - Math.floor(anchor.sample.monotonicMs);
      halfActiveMs = anchor.halfActiveMs + delta;
      matchActiveMs = anchor.matchActiveMs + delta;
    }
  }
  return {
    halfActiveMs,
    matchActiveMs,
    remainingMs: Math.max(0, state.config.plannedHalfDurationMs - halfActiveMs),
    addedMs: Math.max(0, halfActiveMs - state.config.plannedHalfDurationMs),
    recoveryRequired
  };
}
function accrue(state, sample) {
  const clock = readClock(state, sample);
  if (clock.recoveryRequired) throw new Error("Time needs checking. Confirm the clock against a referee or trusted source.");
  const durationMs = clock.matchActiveMs - state.matchActiveMs;
  const fixedKeeperId = currentFixedKeeper(state);
  if (!isRunning(state) || durationMs === 0) return state;
  if (state.half !== 1 && state.half !== 2) throw new Error("No active half.");
  const intervals = state.config.selectedPlayerIds.map((playerId) => {
    const allocation = state.lineup.find((item) => item.playerId === playerId);
    const eligible2 = available(state, playerId);
    return {
      playerId,
      state: allocation ? "playing" : eligible2 ? "available_bench" : "unavailable",
      position: allocation?.position ?? null,
      slotId: allocation?.slotId ?? null,
      startMs: state.matchActiveMs,
      endMs: clock.matchActiveMs,
      half: state.half
    };
  });
  return {
    ...state,
    halfActiveMs: clock.halfActiveMs,
    matchActiveMs: clock.matchActiveMs,
    anchor: { sample: { ...sample }, halfActiveMs: clock.halfActiveMs, matchActiveMs: clock.matchActiveMs },
    intervals: [...state.intervals, ...intervals],
    targetIntervals: [...state.targetIntervals, {
      durationMs,
      availablePlayerIds: state.config.selectedPlayerIds.filter((id) => available(state, id)),
      pitchPlaces: state.config.pitchPlaces,
      fixedKeeperId: fixedKeeperId && available(state, fixedKeeperId) ? fixedKeeperId : null,
      ...state.activePolicy ? { policyVersion: state.activePolicy.policyVersion } : {}
    }]
  };
}
function ensureLive(state) {
  if (!isRunning(state) && !isPaused(state)) throw new Error("This command requires an active half.");
}
function assertLineup(state, lineup) {
  const errors = validateLineup(state, lineup);
  if (errors.length) throw new Error(errors.join(" "));
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== void 0).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function reduceMatch(previous, event) {
  previous = upgradeMatchState(previous);
  if (!event.id) throw new Error("Event id is required.");
  const signature2 = canonical(event);
  if (previous.appliedEvents[event.id]) {
    if (previous.appliedEvents[event.id] !== signature2) throw new Error("Event id was reused with different content.");
    return previous;
  }
  assertSample(event.sample);
  if ((previous.status === "completed" || previous.status === "abandoned") && event.type !== "event.corrected" && event.type !== "event.voided" && event.type !== "goal.recorded" && !((event.type === "lineup.committed" || event.type === "availability.changed") && event.effective && event.sourceRevision !== void 0 && event.lateEntryReason?.trim())) throw new Error("Completed or abandoned play is read-only. Use an audited correction without reopening the clock.");
  let state = previous;
  let auditEffective;
  let auditPrior = null;
  let auditValue = event;
  const reviewedParticipationEntry = (event.type === "lineup.committed" || event.type === "availability.changed") && event.effective !== void 0 && event.sourceRevision !== void 0 && Boolean(event.lateEntryReason?.trim());
  if (event.type === "policy.changed") {
    const latest = accrue(previous, event.sample);
    const boundary = event.effective;
    if (!boundary || boundary.half !== previous.half || !Number.isSafeInteger(boundary.matchElapsedMs) || boundary.matchElapsedMs < previous.matchActiveMs || boundary.matchElapsedMs > latest.matchActiveMs) throw new Error("A policy change must use its captured current continuous boundary, never earlier history or future play.");
    if (isRunning(previous)) {
      if (!previous.anchor) throw new Error("A continuous anchor is required for prospective policy changes.");
      const boundarySample = { ...event.sample, monotonicMs: Math.floor(previous.anchor.sample.monotonicMs) + boundary.matchElapsedMs - previous.anchor.matchActiveMs };
      state = accrue(previous, boundarySample);
    } else state = latest;
  } else if (event.type === "availability.changed" && event.effective && !reviewedParticipationEntry) {
    if (previous.half === 0) throw new Error("Preparation availability has no active-time boundary.");
    const latest = accrue(previous, event.sample);
    const boundary = effectiveTime(latest, event.effective);
    if (boundary.half !== previous.half || boundary.matchElapsedMs < previous.matchActiveMs) throw new Error("Historical availability crosses a recorded boundary. Preserve actual intervals and use explicit history reconciliation; no minutes were changed.");
    if (!isRunning(previous) && boundary.matchElapsedMs !== previous.matchActiveMs) throw new Error("Paused or half-time availability must use the current active-time boundary.");
    if (isRunning(previous)) {
      if (!previous.anchor) throw new Error("A continuous anchor is required for an effective availability boundary.");
      const boundarySample = { ...event.sample, monotonicMs: Math.floor(previous.anchor.sample.monotonicMs) + boundary.matchElapsedMs - previous.anchor.matchActiveMs };
      state = accrue(previous, boundarySample);
    } else state = latest;
    auditEffective = boundary;
  } else if (event.type !== "clock.recovery_required" && event.type !== "clock.corrected") state = accrue(previous, event.sample);
  switch (event.type) {
    case "policy.changed": {
      auditPrior = state.activePolicy ?? null;
      state = applyPolicyChange(state, event, previous.revision);
      auditEffective = event.effective.half === 0 ? null : { ...event.effective, half: event.effective.half };
      auditValue = state.policyHistory?.at(-1);
      state = accrue(state, event.sample);
      break;
    }
    case "attendance.recorded": {
      selectedPlayer(state, event.playerId);
      if (!["present", "absent", "excused", "not_selected", "not_recorded"].includes(event.status)) throw new Error("Attendance status is invalid.");
      state = { ...state, attendance: { ...state.attendance, [event.playerId]: event.status } };
      if (event.status !== "present") state = { ...state, lineup: state.lineup.filter((item) => item.playerId !== event.playerId), stagedLineup: state.stagedLineup.filter((item) => item.playerId !== event.playerId) };
      break;
    }
    case "availability.changed": {
      if (reviewedParticipationEntry) {
        const corrected = reprojectParticipation(state, event, validateLineup);
        state = corrected.state;
        auditEffective = corrected.effective;
        auditPrior = corrected.priorValue;
        auditValue = { inserted: corrected.value, earliestAffected: corrected.earliestAffected };
        break;
      }
      selectedPlayer(state, event.playerId);
      if (typeof event.available !== "boolean") throw new Error("Availability must be explicitly true or false.");
      const reason = event.reason ?? "other";
      if (!["arrival", "departure", "injury", "return", "other"].includes(reason)) throw new Error("Availability reason must be an approved category.");
      if ((reason === "arrival" || reason === "return") && !event.available) throw new Error("Arrival or return requires confirmed availability.");
      if ((reason === "departure" || reason === "injury") && event.available) throw new Error("Injury or departure requires unavailable status.");
      const record = {
        eventId: event.id,
        latestEventId: event.id,
        playerId: event.playerId,
        available: event.available,
        previousAvailability: state.availability[event.playerId],
        reason,
        effective: auditEffective ?? (state.half === 0 ? null : effectiveTime(state)),
        recordedAtMs: event.sample.wallTimeMs
      };
      auditPrior = { available: record.previousAvailability, lineup: cloneLineup(state.lineup) };
      state = { ...state, availability: { ...state.availability, [event.playerId]: event.available } };
      if (!event.available) state = { ...state, lineup: state.lineup.filter((item) => item.playerId !== event.playerId), stagedLineup: state.stagedLineup.filter((item) => item.playerId !== event.playerId) };
      if (event.replacementLineup) {
        ensureLive(state);
        assertLineup(state, event.replacementLineup);
        state = { ...state, lineup: cloneLineup(event.replacementLineup) };
      }
      state = { ...state, availabilityHistory: [...state.availabilityHistory ?? [], record] };
      auditEffective = record.effective;
      auditValue = record;
      state = accrue(state, event.sample);
      break;
    }
    case "lineup.staged": {
      if (state.status !== "preparation" && state.status !== "half_time") throw new Error("Only preparation and half-time have a staged lineup.");
      const errors = validateLineup(state, event.lineup, false);
      if (errors.length) throw new Error(errors.join(" "));
      state = { ...state, stagedLineup: cloneLineup(event.lineup) };
      break;
    }
    case "half.started": {
      if (state.status !== "preparation" && state.status !== "half_time") throw new Error("A half can start only from preparation or half-time.");
      assertLineup(state, state.stagedLineup);
      const half2 = state.status === "preparation" ? 1 : 2;
      state = {
        ...state,
        half: half2,
        status: half2 === 1 ? "first_half_running" : "second_half_running",
        lineup: cloneLineup(state.stagedLineup),
        halfActiveMs: 0,
        anchor: { sample: { ...event.sample }, halfActiveMs: 0, matchActiveMs: state.matchActiveMs }
      };
      break;
    }
    case "half.paused": {
      if (!isRunning(state)) throw new Error("Only a running half can pause.");
      state = { ...state, status: state.half === 1 ? "first_half_paused" : "second_half_paused", anchor: null };
      break;
    }
    case "half.resumed": {
      if (!isPaused(state)) throw new Error("Only a paused half can resume.");
      assertLineup(state, state.lineup);
      state = { ...state, status: state.half === 1 ? "first_half_running" : "second_half_running", anchor: { sample: { ...event.sample }, halfActiveMs: state.halfActiveMs, matchActiveMs: state.matchActiveMs } };
      break;
    }
    case "half.ended": {
      ensureLive(state);
      if (state.half === 1) state = { ...state, status: "half_time", anchor: null, firstHalfDurationMs: state.halfActiveMs, halfTimeScore: { ...state.score }, stagedLineup: cloneLineup(state.lineup) };
      else state = { ...state, status: "completed", anchor: null, completedAtMs: event.sample.wallTimeMs, completedTimeQuality: "reviewRequired" };
      break;
    }
    case "match.abandoned": {
      if (state.half === 0) throw new Error("Only a started match can be abandoned; cancel an unplayed fixture separately.");
      if (!["weather", "safety", "insufficient_players", "other"].includes(event.reason) || (event.note?.length ?? 0) > 200) throw new Error("Abandonment requires an approved reason category and a note of at most 200 characters.");
      state = { ...state, status: "abandoned", anchor: null, abandonedAtMs: event.sample.wallTimeMs, abandonReason: event.reason };
      break;
    }
    case "lineup.committed": {
      if (event.effective) {
        const corrected = reprojectParticipation(state, event, validateLineup);
        state = corrected.state;
        auditEffective = corrected.effective;
        auditPrior = corrected.priorValue;
        auditValue = { inserted: corrected.value, earliestAffected: corrected.earliestAffected };
        break;
      }
      ensureLive(state);
      if (event.sourceRevision !== previous.revision) throw new Error("Lineup draft is stale. Review against the current match revision.");
      assertLineup(state, event.lineup);
      state = { ...state, lineup: cloneLineup(event.lineup) };
      break;
    }
    case "goal.recorded": {
      const recorded = goalRecord(state, event, event.id, event.sample.wallTimeMs);
      if (!isRunning(state) && !isPaused(state) || recorded.effective.half !== state.half) {
        if (!event.effective || !event.lateEntryReason?.trim()) throw new Error("A goal entered outside its active half needs its actual effective time and a late-entry reason.");
      }
      const goals = [...state.goals ?? [], recorded];
      state = { ...state, goals, ...scoresFromGoals(state, goals) };
      auditEffective = recorded.effective;
      auditValue = recorded;
      break;
    }
    case "event.corrected": {
      if (!event.reason.trim() || event.reason.length > 500) throw new Error("An audited correction needs a reason of 1\u2013500 characters.");
      const goal = state.goals?.find((item) => item.eventId === event.targetEventId || item.latestEventId === event.targetEventId);
      if (goal) {
        if (event.replacement.type !== "goal.recorded") throw new Error("A correction cannot change the original event family.");
        if (goal.voided && event.restoreVoided !== true) throw new Error("Restoring a voided goal requires explicit restoreVoided confirmation.");
        const corrected = goalRecord(state, { ...goal, ...event.replacement, effective: event.replacement.effective ?? goal.effective }, goal.eventId, goal.recordedAtMs);
        const replacement = { ...corrected, latestEventId: event.id };
        const goals = state.goals.map((item) => item.eventId === goal.eventId ? replacement : item);
        state = { ...state, goals, ...scoresFromGoals(state, goals) };
        auditEffective = replacement.effective;
        auditPrior = goal;
        auditValue = replacement;
        break;
      }
      const availability = state.availabilityHistory?.find((item) => item.eventId === event.targetEventId || item.latestEventId === event.targetEventId);
      if (availability) {
        if (event.replacement.type !== "availability.changed") throw new Error("A correction cannot change the original event family.");
        const replacement = event.replacement;
        if (replacement.playerId !== availability.playerId || replacement.available !== availability.available || replacement.replacementLineup || replacement.effective && canonical(replacement.effective) !== canonical(availability.effective)) {
          const corrected2 = reprojectParticipation(state, event, validateLineup);
          state = corrected2.state;
          auditEffective = corrected2.effective;
          auditPrior = corrected2.priorValue;
          auditValue = { correction: corrected2.value, earliestAffected: corrected2.earliestAffected };
          break;
        }
        const reason = replacement.reason ?? availability.reason;
        if (!["arrival", "departure", "injury", "return", "other"].includes(reason) || (reason === "arrival" || reason === "return") && !availability.available || (reason === "injury" || reason === "departure") && availability.available) throw new Error("Corrected availability reason conflicts with its recorded state.");
        const corrected = { ...availability, reason, latestEventId: event.id };
        state = { ...state, availabilityHistory: state.availabilityHistory.map((item) => item.eventId === availability.eventId ? corrected : item) };
        auditEffective = corrected.effective;
        auditPrior = availability;
        auditValue = corrected;
        break;
      }
      if (event.replacement.type === "lineup.committed" || event.replacement.type === "availability.changed" && event.sourceRevision !== void 0) {
        const corrected = reprojectParticipation(state, event, validateLineup);
        state = corrected.state;
        auditEffective = corrected.effective;
        auditPrior = corrected.priorValue;
        auditValue = { correction: corrected.value, earliestAffected: corrected.earliestAffected };
        break;
      }
      if (state.eventHistory?.some((item) => item.id === event.targetEventId)) throw new Error("This historical interval or half transition needs explicit reconciliation of the affected play. No recorded minutes were changed.");
      throw new Error("Correction target was not found in this match history.");
    }
    case "event.voided": {
      if (!event.reason.trim() || event.reason.length > 500) throw new Error("Voiding an event needs an audited reason of 1\u2013500 characters.");
      const goal = state.goals?.find((item) => item.eventId === event.targetEventId || item.latestEventId === event.targetEventId);
      if (!goal) {
        if (state.eventHistory?.some((item) => item.id === event.targetEventId && (item.type === "lineup.committed" || item.type === "availability.changed" || item.type === "event.corrected"))) {
          const corrected = reprojectParticipation(state, event, validateLineup);
          state = corrected.state;
          auditEffective = corrected.effective;
          auditPrior = corrected.priorValue;
          auditValue = { correction: corrected.value, earliestAffected: corrected.earliestAffected };
          break;
        }
        if (state.eventHistory?.some((item) => item.id === event.targetEventId)) throw new Error("Voiding a participation or half event requires explicit interval reconciliation. Original history was retained.");
        throw new Error("Void target was not found in this match history.");
      }
      if (goal.voided) throw new Error("This goal is already voided.");
      const replacement = { ...goal, voided: true, latestEventId: event.id };
      const goals = state.goals.map((item) => item.eventId === goal.eventId ? replacement : item);
      state = { ...state, goals, ...scoresFromGoals(state, goals) };
      auditEffective = replacement.effective;
      auditPrior = goal;
      auditValue = replacement;
      break;
    }
    case "clock.recovery_required": {
      if (!isRunning(state)) throw new Error("Only a running clock needs continuity recovery.");
      if (!event.reason.trim()) throw new Error("A recovery reason is required.");
      state = { ...state, recoveryRequired: true, recoveryReason: event.reason };
      break;
    }
    case "clock.corrected": {
      ensureLive(state);
      if (!isRunning(state) || !(state.recoveryRequired || readClock(state, event.sample).recoveryRequired)) throw new Error("Clock correction is only available for an uncertain running-clock recovery.");
      if (event.confirmUnchangedLineup !== true) throw new Error("Confirm unchanged lineup and availability since the secure checkpoint, or reconcile history separately.");
      if (!event.reason.trim()) throw new Error("Record the referee/trusted-source reason for a clock correction.");
      integer(event.halfActiveMs, "Corrected active half time");
      if (event.halfActiveMs < state.halfActiveMs) throw new Error("Backdated clock correction needs audited history reconciliation, outside this M0 slice.");
      const newMatchMs = (state.half === 2 ? state.firstHalfDurationMs ?? 0 : 0) + event.halfActiveMs;
      if (newMatchMs < state.matchActiveMs) throw new Error("Clock correction cannot discard recorded participation.");
      if (isRunning(state) && newMatchMs > state.matchActiveMs) {
        const syntheticSample = { ...event.sample, sessionId: "explicit-referee-correction", monotonicMs: newMatchMs - state.matchActiveMs };
        state = accrue({ ...state, recoveryRequired: false, anchor: { sample: { ...syntheticSample, monotonicMs: 0 }, halfActiveMs: state.halfActiveMs, matchActiveMs: state.matchActiveMs } }, syntheticSample);
      }
      state = { ...state, halfActiveMs: event.halfActiveMs, matchActiveMs: newMatchMs, recoveryRequired: false, recoveryReason: null, anchor: isRunning(state) ? { sample: { ...event.sample }, halfActiveMs: event.halfActiveMs, matchActiveMs: newMatchMs } : null };
      break;
    }
    default:
      throw new Error("Unsupported match command type.");
  }
  state = updatePolicyPositionMode(state, previous.revision + 1);
  const audit = {
    eventId: event.id,
    type: event.type,
    revision: previous.revision + 1,
    recordedAtMs: event.sample.wallTimeMs,
    actorId: event.actorId ?? null,
    effective: auditEffective === void 0 ? state.half === 0 ? null : effectiveTime(state) : auditEffective,
    targetEventId: "targetEventId" in event ? event.targetEventId : null,
    reason: "lateEntryReason" in event && event.lateEntryReason?.trim() ? event.lateEntryReason : "reason" in event ? event.reason ?? null : null,
    priorValue: cloneValue(auditPrior),
    value: cloneValue(auditValue)
  };
  return {
    ...state,
    revision: previous.revision + 1,
    appliedEvents: { ...previous.appliedEvents, [event.id]: signature2 },
    eventHistory: [...previous.eventHistory ?? [], cloneValue(event)],
    audit: [...previous.audit ?? [], audit]
  };
}
function replayMatch(config, events) {
  return events.reduce(reduceMatch, createMatch(config));
}
function goalRecords(state) {
  return cloneValue(upgradeMatchState(state).goals ?? []);
}
function playerMinutes(state, sample) {
  const clock = readClock(state, sample);
  const projected = clock.recoveryRequired ? state : accrue(state, sample);
  return state.config.selectedPlayerIds.map((playerId) => {
    const result = { playerId, playingMs: 0, benchMs: 0, unavailableMs: 0, positionMs: {} };
    for (const interval of projected.intervals.filter((item) => item.playerId === playerId)) {
      const durationMs = interval.endMs - interval.startMs;
      if (interval.state === "playing") {
        result.playingMs += durationMs;
        if (interval.position) result.positionMs[interval.position] = (result.positionMs[interval.position] ?? 0) + durationMs;
      } else if (interval.state === "available_bench") result.benchMs += durationMs;
      else result.unavailableMs += durationMs;
    }
    return result;
  });
}
function gcd(left, right) {
  return right === 0n ? left : gcd(right, left % right);
}
function rational(numerator, denominator = 1n) {
  if (denominator <= 0n || numerator < 0n) throw new Error("Rational target must be nonnegative with a positive denominator.");
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}
function add(left, right) {
  return rational(left.numerator * right.denominator + right.numerator * left.denominator, left.denominator * right.denominator);
}
function scale(value, numerator, denominator) {
  return rational(value.numerator * numerator, value.denominator * denominator);
}
function rationalToNumber(value) {
  return Number(value.numerator) / Number(value.denominator);
}
function withinTargetBand(actualMs, target) {
  integer(actualMs, "Actual playing time");
  const actual = BigInt(actualMs);
  return actual * target.lower.denominator >= target.lower.numerator && actual * target.upper.denominator <= target.upper.numerator;
}
function calculateTargets(intervals, allPlayerIds = []) {
  const totals = new Map(allPlayerIds.map((id) => [id, rational(0n)]));
  for (const interval of intervals) {
    integer(interval.durationMs, "Target interval duration");
    integer(interval.pitchPlaces, "Target pitch capacity");
    const ids = interval.availablePlayerIds;
    if (new Set(ids).size !== ids.length) throw new Error("Target interval repeats an available player.");
    if (interval.fixedKeeperId && !ids.includes(interval.fixedKeeperId)) throw new Error("Fixed keeper is not available in this target interval.");
    const count = ids.length;
    const capacity = Math.min(interval.pitchPlaces, count);
    if (capacity === 0) continue;
    for (const playerId of ids) {
      let contribution;
      if (playerId === interval.fixedKeeperId) contribution = rational(BigInt(interval.durationMs));
      else if (interval.fixedKeeperId) contribution = rational(BigInt(interval.durationMs) * BigInt(capacity - 1), BigInt(count - 1));
      else contribution = rational(BigInt(interval.durationMs) * BigInt(capacity), BigInt(count));
      totals.set(playerId, add(totals.get(playerId) ?? rational(0n), contribution));
    }
  }
  return [...totals].map(([playerId, target]) => ({ playerId, target, lower: scale(target, 9n, 10n), upper: scale(target, 11n, 10n) }));
}
function currentTargets(state, sample) {
  const clock = readClock(state, sample);
  const projected = clock.recoveryRequired ? state : accrue(state, sample);
  return calculateTargets(projected.targetIntervals, state.config.selectedPlayerIds);
}

// packages/application/src/match-plans.ts
var copy = (value) => JSON.parse(JSON.stringify(value));
function assert(value, message) {
  if (!value) throw new Error(message);
}
function shape(value, keys2) {
  assert(
    value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => keys2.includes(key)),
    "Match-plan data contains unsupported fields."
  );
}
function required(value, maximum, label) {
  assert(
    typeof value === "string" && value.trim() && value.trim().length <= maximum && !/[\u0000-\u001f\u007f]/.test(value),
    `${label} is required and must be at most ${maximum} characters.`
  );
  return value.trim();
}
var canonical2 = (value) => Array.isArray(value) ? `[${value.map(canonical2).join(",")}]` : value && typeof value === "object" ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical2(item)}`).join(",")}}` : JSON.stringify(value);
function keeper(profile) {
  return profile.eligiblePositions.includes("GK") && ["GK"].includes(profile.preferences[0]) || profile.eligiblePositions.includes("GK") && profile.preferences[1] === "GK";
}
function latestMatchPlans(state) {
  const map = /* @__PURE__ */ new Map();
  for (const plan of state.matchPlans ?? [])
    if (!map.has(plan.id) || map.get(plan.id).version < plan.version)
      map.set(plan.id, plan);
  return [...map.values()].filter(
    (plan) => plan.teamId === state.team.id && plan.seasonId === state.activeSeasonId
  ).map(copy);
}
function validateMatchPlanSettings(settings) {
  shape(settings, ["payload", "applicability", "softPreferences"]);
  shape(settings.payload, [
    "keeperMode",
    "fixedKeeperPlayerSeasonId",
    "minimumStintMs",
    "batchLimit",
    "scoreLeadThreshold",
    "returnToNormalEnabled"
  ]);
  shape(settings.applicability, ["minimumStint", "batchLimit", "q07"]);
  shape(settings.softPreferences, ["halfBufferFraction"]);
  const p = settings.payload;
  assert(
    ["sole_fixed", "common_pool"].includes(p.keeperMode) && (p.fixedKeeperPlayerSeasonId === null || typeof p.fixedKeeperPlayerSeasonId === "string" && p.fixedKeeperPlayerSeasonId.length > 0),
    "Choose a known keeper proposal."
  );
  assert(
    p.keeperMode === "sole_fixed" === (p.fixedKeeperPlayerSeasonId !== null),
    "Fixed keeper identity must agree with the keeper proposal."
  );
  assert(
    Number.isSafeInteger(p.minimumStintMs) && p.minimumStintMs >= 0 && Number.isSafeInteger(p.batchLimit) && p.batchLimit >= 1 && p.batchLimit <= 11 && Number.isSafeInteger(p.scoreLeadThreshold) && p.scoreLeadThreshold >= 1 && typeof p.returnToNormalEnabled === "boolean",
    "Review minimum spell, batch preference, threshold and explicit return choice."
  );
  assert(
    settings.applicability.minimumStint === "soft_preference" && settings.applicability.batchLimit === "soft_preference" && settings.applicability.q07 === "unapproved",
    "A saved plan cannot approve Q07 or convert preferences into hard rules."
  );
  assert(
    Number.isFinite(settings.softPreferences.halfBufferFraction) && settings.softPreferences.halfBufferFraction >= 0 && settings.softPreferences.halfBufferFraction <= 0.49,
    "Half buffer must be a fraction between zero and 0.49."
  );
}
function validateProposal(state, fixture, formation, allocations, settings) {
  assert(
    formation.format === fixture.format && formation.slots.length === fixture.format && formation.slots.filter((slot) => slot.position === "GK").length === 1,
    "The saved formation must match this fixture format and include one goalkeeper."
  );
  assert(
    Array.isArray(allocations) && allocations.length === fixture.format && new Set(allocations.map((row) => row.slotId)).size === fixture.format && new Set(allocations.map((row) => row.playerId)).size === fixture.format,
    "Review one distinct player for every saved place."
  );
  const selected = fixture.selectedProfileIds.map(
    (id) => state.profiles.find(
      (profile) => profile.id === id && profile.seasonId === fixture.seasonId && profile.active
    )
  ).filter(
    (profile) => Boolean(profile)
  );
  for (const allocation of allocations) {
    shape(allocation, ["slotId", "position", "playerId"]);
    const slot = formation.slots.find(
      (value) => value.id === allocation.slotId
    );
    const profile = selected.find(
      (value) => value.playerId === allocation.playerId
    );
    assert(
      slot && slot.position === allocation.position && profile && profile.eligiblePositions.includes(slot.position),
      "A proposed player is missing, unselected, archived or no longer eligible. Review the squad and places first."
    );
    if (slot.position === "GK")
      assert(
        keeper(profile),
        "The proposed goalkeeper must remain a first- or second-choice eligible keeper."
      );
  }
  validateMatchPlanSettings(settings);
  const qualifying = selected.filter(keeper);
  assert(
    settings.payload.minimumStintMs <= fixture.plannedHalfDurationMs,
    "The preferred spell exceeds this fixture\u2019s planned half."
  );
  assert(
    settings.payload.keeperMode === "sole_fixed" ? qualifying.length === 1 && qualifying[0].playerId === settings.payload.fixedKeeperPlayerSeasonId && allocations.some(
      (row) => row.position === "GK" && row.playerId === qualifying[0].playerId
    ) : qualifying.length >= 2,
    "The saved keeper proposal does not match this selected squad. Review current keeper coverage; no exemption is inferred."
  );
}
function saveMatchPlan(state, input) {
  shape(input, [
    "planId",
    "expectedPlanVersion",
    "name",
    "description",
    "sourceFixtureId",
    "sourceSnapshotId",
    "allocations",
    "settings"
  ]);
  const fixture = state.fixtures.find(
    (row) => row.id === input.sourceFixtureId && row.seasonId === state.activeSeasonId
  );
  const snapshot = state.snapshots.find(
    (row) => row.id === input.sourceSnapshotId && row.fixtureId === input.sourceFixtureId
  );
  assert(
    fixture && snapshot && snapshot.seasonId === state.activeSeasonId,
    "Review an explicit saved preparation for this team and season."
  );
  const latestSnapshot = state.snapshots.filter((row) => row.fixtureId === fixture.id).at(-1);
  const {
    status: _status,
    selectedProfileIds: _selection,
    responses: _responses,
    attendance: _attendance,
    history: _history,
    matchPlanDraft: _draft,
    ...fixtureDetails
  } = fixture;
  assert(
    latestSnapshot?.id === snapshot.id && canonical2(snapshot.fixture) === canonical2(fixtureDetails) && canonical2(snapshot.selectedPlayerIds.slice().sort()) === canonical2(
      fixture.selectedProfileIds.map(
        (id) => state.profiles.find((profile) => profile.id === id)?.playerId
      ).sort()
    ),
    "Source preparation changed. Prepare and review its latest snapshot before saving a plan."
  );
  const previous = latestMatchPlans(state).find(
    (row) => row.id === input.planId
  );
  assert(
    input.expectedPlanVersion === (previous?.version ?? 0),
    "The reusable plan changed. Refresh and review its current version."
  );
  validateProposal(
    state,
    fixture,
    snapshot.formation,
    input.allocations,
    input.settings
  );
  assert(
    typeof input.description === "string" && input.description.length <= 300 && !/[\u0000-\u001f\u007f]/.test(input.description),
    "Use a short non-sensitive description, at most300 characters."
  );
  return {
    id: required(input.planId, 150, "Plan identity"),
    version: (previous?.version ?? 0) + 1,
    teamId: state.team.id,
    seasonId: fixture.seasonId,
    name: required(input.name, 40, "Plan name"),
    description: input.description.trim(),
    sourceFixtureId: fixture.id,
    sourceSnapshotId: snapshot.id,
    sourcePreparedRevision: snapshot.preparedRevision,
    formation: copy(snapshot.formation),
    allocations: copy(input.allocations),
    settings: copy(input.settings)
  };
}
function today(now) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(now));
}
function previewMatchPlan(state, planId, fixtureId, context = {}) {
  const plan = latestMatchPlans(state).find((row) => row.id === planId);
  const fixture = state.fixtures.find(
    (row) => row.id === fixtureId && row.seasonId === state.activeSeasonId
  );
  const issues = [];
  try {
    assert(
      plan && fixture,
      "Choose an existing plan and target fixture in this team and season."
    );
    assert(
      fixture.id !== plan.sourceFixtureId,
      "Choose another fixture; saving a template never overwrites its source."
    );
    assert(
      fixture.status === "scheduled" && fixture.playedDate >= today(context.nowMs ?? Date.now()) && !context.protectedFixtureIds?.includes(fixture.id),
      "Only a prospective, unrecorded and unclaimed fixture can receive a match plan."
    );
    validateProposal(
      state,
      fixture,
      plan.formation,
      plan.allocations,
      plan.settings
    );
  } catch (error) {
    issues.push(
      error instanceof Error ? error.message : "This plan is not applicable."
    );
  }
  const previewKey = plan && fixture ? canonical2([
    state.revision,
    plan,
    fixture,
    state.profiles.filter(
      (profile) => fixture.selectedProfileIds.includes(profile.id)
    ).map((profile) => [
      profile.id,
      profile.playerId,
      profile.active,
      profile.eligiblePositions,
      profile.preferences
    ])
  ]) : "";
  return {
    ready: issues.length === 0,
    issues,
    previewKey,
    plan: plan ? copy(plan) : null,
    fixture: fixture ? copy(fixture) : null
  };
}
function applyMatchPlan(state, input, context = {}) {
  shape(input, ["planId", "planVersion", "fixtureId", "previewKey", "confirm"]);
  const preview = previewMatchPlan(
    state,
    input.planId,
    input.fixtureId,
    context
  );
  assert(
    input.confirm === true && preview.ready && preview.plan && input.planVersion === preview.plan.version && input.previewKey === preview.previewKey,
    preview.issues[0] ?? "The preview or plan changed. Review this fixture again before explicitly confirming."
  );
  const plan = preview.plan;
  return {
    templateId: plan.id,
    templateVersion: plan.version,
    appliedRevision: state.revision + 1,
    formation: {
      ...copy(plan.formation),
      id: `match-plan:${plan.id}:${plan.version}`,
      name: plan.name
    },
    allocations: copy(plan.allocations),
    settings: copy(plan.settings)
  };
}
function validateFixtureMatchPlan(state, fixture) {
  if (fixture.matchPlanDraft)
    validateProposal(
      state,
      fixture,
      fixture.matchPlanDraft.formation,
      fixture.matchPlanDraft.allocations,
      fixture.matchPlanDraft.settings
    );
}

// packages/application/src/preparation.ts
var positionCodes = [
  "GK",
  "CB",
  "LB",
  "RB",
  "CM",
  "LW",
  "RW",
  "ST"
];
function requireThat2(condition, message) {
  if (!condition) throw new Error(message);
}
var clone = (value) => JSON.parse(JSON.stringify(value));
function text(value, label, maximum = 80) {
  requireThat2(
    typeof value === "string" && value.trim().length > 0 && value.trim().length <= maximum,
    `${label} is required and must be at most ${maximum} characters.`
  );
  return value.trim();
}
function canonical3(value) {
  if (Array.isArray(value)) return `[${value.map(canonical3).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical3(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function validDate(value) {
  const date = /* @__PURE__ */ new Date(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validTime(value) {
  return value === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
function validateFormat(format2) {
  requireThat2(
    Number.isInteger(format2) && format2 >= 5 && format2 <= 11,
    "Choose a format from five to eleven players."
  );
}
function validateHalf(duration2) {
  requireThat2(
    Number.isSafeInteger(duration2) && duration2 > 0 && duration2 % 1e3 === 0,
    "Each planned half must be a positive whole number of seconds."
  );
}
function validateLogo(logo) {
  requireThat2(
    logo === null || ["roundel", "shield", "ball"].includes(logo),
    "Choose one of the original fictional badges."
  );
}
function activeSeason(state, seasonId) {
  const season = state.seasons.find((item) => item.id === seasonId);
  requireThat2(season, "Season not found.");
  requireThat2(
    seasonId === state.activeSeasonId,
    "Past seasons are read-only here. Their records are retained unchanged."
  );
  return season;
}
function dateInSeason(state, seasonId, date) {
  const season = activeSeason(state, seasonId);
  requireThat2(
    validDate(date) && date >= season.startDate && date <= season.endDate,
    "Choose a valid date within the selected September-to-August season."
  );
}
function checkProfile(state, profileId, seasonId) {
  const profile = state.profiles.find(
    (item) => item.id === profileId && item.seasonId === seasonId && item.active
  );
  requireThat2(profile, "Choose an active player from this team and season.");
  return profile;
}
function validResponse(value) {
  requireThat2(
    ["available", "unavailable", "unsure", "no_reply"].includes(value),
    "Choose an availability response."
  );
}
function validAttendance(value) {
  requireThat2(
    ["present", "absent", "not_recorded"].includes(value),
    "Choose Present, Absent or Not recorded."
  );
}
function unique(ids) {
  requireThat2(
    new Set(ids).size === ids.length,
    "Each player or slot can appear only once."
  );
}
function validateTraining(state, training) {
  text(training.id, "Training identity", 150);
  dateInSeason(state, training.seasonId, training.date);
  requireThat2(validTime(training.time) && training.time !== null, "Use a 24-hour HH:MM training time.");
  requireThat2(typeof training.venue === "string" && training.venue.length <= 200, "Use a training venue of at most 200 characters.");
  requireThat2(training.recurrenceGroupId === null || typeof training.recurrenceGroupId === "string" && training.recurrenceGroupId.trim().length > 0 && training.recurrenceGroupId.length <= 150, "Use a valid training series identity.");
  requireThat2(Array.isArray(training.expectedProfileIds), "Choose the expected players explicitly.");
  unique(training.expectedProfileIds);
  training.expectedProfileIds.forEach((id) => checkProfile(state, id, training.seasonId));
}
function seasonBounds(startYear) {
  requireThat2(
    Number.isInteger(startYear) && startYear >= 2e3 && startYear <= 2100,
    "Choose a season start year between 2000 and 2100."
  );
  return {
    startDate: `${startYear}-09-01`,
    endDate: `${startYear + 1}-08-31`,
    label: `${startYear}/${String(startYear + 1).slice(-2)}`
  };
}
function seasonPlayers(state, seasonId = state.activeSeasonId) {
  return state.profiles.filter(
    (profile) => profile.seasonId === seasonId && profile.active
  );
}
function goalkeeperChoice(profile) {
  const rank = profile.preferences.indexOf("GK") + 1;
  return profile.eligiblePositions.includes("GK") && (rank === 1 || rank === 2) ? rank : 0;
}
function defaultFormation(format2) {
  validateFormat(format2);
  const roles = {
    5: ["GK", "CB", "CB", "CM", "ST"],
    6: ["GK", "CB", "CB", "LW", "RW", "ST"],
    7: ["GK", "CB", "CB", "CM", "LW", "RW", "ST"],
    8: ["GK", "LB", "CB", "RB", "CM", "LW", "RW", "ST"],
    9: ["GK", "LB", "CB", "CB", "RB", "CM", "LW", "RW", "ST"],
    10: ["GK", "LB", "CB", "CB", "RB", "CM", "CM", "LW", "RW", "ST"],
    11: ["GK", "LB", "CB", "CB", "RB", "CM", "CM", "LW", "RW", "ST", "ST"]
  };
  const count = {};
  const row = (position) => position === "GK" ? 0.9 : ["CB", "LB", "RB"].includes(position) ? 0.72 : position === "CM" ? 0.5 : ["LW", "RW"].includes(position) ? 0.32 : 0.13;
  return {
    id: `formation-${format2}`,
    name: `${format2}-a-side`,
    format: format2,
    version: 1,
    slots: roles[format2].map((position) => {
      const ordinal = count[position] = (count[position] ?? 0) + 1;
      const peers = roles[format2].filter((role) => row(role) === row(position));
      const index = roles[format2].slice(
        0,
        roles[format2].findIndex(
          (role, i) => role === position && roles[format2].slice(0, i + 1).filter((p) => p === position).length === ordinal
        )
      ).filter((role) => row(role) === row(position)).length;
      return {
        id: `${position.toLowerCase()}-${ordinal}`,
        position,
        label: `${position}${roles[format2].filter((role) => role === position).length > 1 ? ordinal : ""}`,
        x: (index + 1) / (peers.length + 1),
        y: row(position)
      };
    })
  };
}
function prepareFixtureSnapshot(state, fixtureId, formationId) {
  const fixture = state.fixtures.find((item) => item.id === fixtureId);
  requireThat2(
    fixture && fixture.status === "scheduled",
    "Only a scheduled match can be prepared."
  );
  activeSeason(state, fixture.seasonId);
  if (fixture.matchPlanDraft && fixture.matchPlanDraft.formation.id === formationId) validateFixtureMatchPlan(state, fixture);
  const formation = fixture.matchPlanDraft && fixture.matchPlanDraft.formation.id === formationId ? fixture.matchPlanDraft.formation : state.formations.find(
    (item) => item.id === (formationId ?? `formation-${fixture.format}`)
  );
  requireThat2(
    formation && formation.format === fixture.format,
    "Choose a saved formation for this match format."
  );
  requireThat2(
    fixture.selectedProfileIds.length >= fixture.format,
    "Select enough players for the match format."
  );
  const profiles = fixture.selectedProfileIds.map(
    (id) => checkProfile(state, id, fixture.seasonId)
  );
  requireThat2(
    profiles.some((profile) => goalkeeperChoice(profile) > 0),
    "Select a first- or second-choice eligible goalkeeper."
  );
  const {
    responses: _responses,
    attendance: _attendance,
    selectedProfileIds: _selected,
    history: _history,
    status: _status,
    matchPlanDraft: _planDraft,
    ...draft
  } = fixture;
  return clone({
    id: `${fixture.id}@${state.revision + 1}`,
    fixtureId,
    seasonId: fixture.seasonId,
    preparedRevision: state.revision + 1,
    fixture: draft,
    formation,
    profiles,
    selectedPlayerIds: profiles.map((profile) => profile.playerId),
    attendance: Object.fromEntries(
      profiles.map((profile) => [
        profile.playerId,
        fixture.attendance[profile.id] ?? "not_recorded"
      ])
    ),
    ...fixture.matchPlanDraft?.formation.id === formation.id ? { matchPlanDraft: fixture.matchPlanDraft } : {}
  });
}
function saveProfile(state, source2) {
  const profile = clone(source2);
  activeSeason(state, profile.seasonId);
  text(profile.id, "Profile identity", 150);
  text(profile.playerId, "Player identity", 150);
  const existing = state.profiles.find((item) => item.id === profile.id);
  if (existing)
    requireThat2(
      existing.playerId === profile.playerId && existing.seasonId === profile.seasonId,
      "Profile identity and season cannot be reassigned."
    );
  requireThat2(
    !state.profiles.some(
      (item) => item.id !== profile.id && item.seasonId === profile.seasonId && item.playerId === profile.playerId
    ),
    "That player already has a profile in this season."
  );
  profile.displayName = text(profile.displayName, "Display name", 60);
  requireThat2(
    typeof profile.initials === "string" && /^[A-Za-z0-9]{1,2}$/.test(profile.initials),
    "Use one or two letters or digits for the pitch label."
  );
  profile.initials = profile.initials.toUpperCase();
  requireThat2(
    profile.shirtNumber === null || Number.isInteger(profile.shirtNumber) && profile.shirtNumber >= 1 && profile.shirtNumber <= 99,
    "Shirt number must be one to 99 or not recorded."
  );
  requireThat2(
    !state.profiles.some(
      (item) => item.id !== profile.id && item.seasonId === profile.seasonId && item.active && profile.active && profile.shirtNumber !== null && item.shirtNumber === profile.shirtNumber
    ),
    "Another active player already has that shirt number."
  );
  requireThat2(
    profile.preferences.length === 3 && new Set(profile.preferences).size === 3 && profile.preferences.every((position) => positionCodes.includes(position)),
    "Choose three different ranked positions."
  );
  requireThat2(
    profile.eligiblePositions.length > 0 && new Set(profile.eligiblePositions).size === profile.eligiblePositions.length && profile.eligiblePositions.every(
      (position) => positionCodes.includes(position)
    ),
    "Choose distinct manager-approved eligible positions."
  );
  requireThat2(
    ["left", "right", "both", "not_recorded"].includes(profile.foot),
    "Choose a preferred foot or Not recorded."
  );
  state.profiles = state.profiles.filter((item) => item.id !== profile.id);
  state.profiles.push(profile);
  return profile;
}
function validateRosterImport(state, profiles) {
  requireThat2(
    Array.isArray(profiles) && profiles.length > 0 && profiles.length <= 200,
    "Import between one and 200 new player profiles."
  );
  const candidate = clone(state);
  return Array.from(profiles).map((profile) => {
    requireThat2(
      profile && typeof profile === "object" && Object.keys(profile).length === 10 && Object.keys(profile).every(
        (key) => [
          "id",
          "playerId",
          "seasonId",
          "displayName",
          "initials",
          "shirtNumber",
          "foot",
          "preferences",
          "eligiblePositions",
          "active"
        ].includes(key)
      ),
      "Use only the documented player profile fields; accounts, contacts and dates of birth cannot be imported."
    );
    requireThat2(
      Array.isArray(profile.preferences) && Array.isArray(profile.eligiblePositions),
      "Provide ranked preferences and explicit eligible positions."
    );
    requireThat2(
      typeof profile.initials === "string" && profile.initials.length >= 1 && profile.initials.length <= 2 && !/[^A-Za-z0-9]/.test(profile.initials),
      "Use one or two letters or digits for the pitch label."
    );
    requireThat2(
      profile.active === true && profile.seasonId === state.activeSeasonId,
      "Import active players into the current season only."
    );
    for (const id of [profile.id, profile.playerId])
      requireThat2(
        typeof id === "string" && id.length >= 1 && id.length <= 150 && !/[^A-Za-z0-9_.:-]/.test(id),
        "Use a valid opaque player/profile identity of at most 150 characters."
      );
    requireThat2(
      !candidate.profiles.some(
        (existing) => existing.id === profile.id || existing.playerId === profile.playerId
      ),
      "A player or profile identity already exists. Import never merges identities; edit that player separately."
    );
    return saveProfile(candidate, profile);
  });
}
function reducePreparation(previous, command, context = {}) {
  requireThat2(
    command.id && typeof command.id === "string",
    "A stable command identity is required."
  );
  const signature2 = canonical3(command);
  if (previous.appliedCommands[command.id]) {
    requireThat2(
      previous.appliedCommands[command.id] === signature2,
      "This command identity already belongs to different content."
    );
    return previous;
  }
  requireThat2(
    command.expectedRevision === previous.revision,
    "Preparation changed on another screen. Reload the saved version before applying this change."
  );
  const state = clone(previous);
  const revision = state.revision + 1;
  switch (command.type) {
    case "club.updated":
      validateLogo(command.logo);
      state.club = {
        ...state.club,
        name: text(command.name, "Club name"),
        logo: command.logo
      };
      break;
    case "team.updated":
      validateLogo(command.logo);
      validateFormat(command.defaultPitchPlaces);
      validateHalf(command.defaultHalfDurationMs);
      state.team = {
        ...state.team,
        name: text(command.name, "Team name"),
        ageGroup: text(command.ageGroup, "Age group", 12),
        defaultPitchPlaces: command.defaultPitchPlaces,
        defaultHalfDurationMs: command.defaultHalfDurationMs,
        logo: command.logo
      };
      break;
    case "season.rolled_over": {
      requireThat2(
        command.confirmSpectatorRenewal === true,
        "Confirm that spectator access must be renewed explicitly."
      );
      const old = state.seasons.find(
        (item) => item.id === state.activeSeasonId
      );
      requireThat2(
        command.startYear === old.startYear + 1,
        "Rollover creates the immediately following September-to-August season."
      );
      requireThat2(
        !state.seasons.some(
          (item) => item.id === command.idForSeason || item.startYear === command.startYear
        ),
        "That season already exists."
      );
      const season = {
        id: text(command.idForSeason, "Season identity"),
        startYear: command.startYear,
        ...seasonBounds(command.startYear),
        spectatorRenewalRequired: true
      };
      if (command.copyPlayers)
        state.profiles.push(
          ...seasonPlayers(state).map((profile) => ({
            ...clone(profile),
            id: `${profile.playerId}:${season.id}`,
            seasonId: season.id
          }))
        );
      state.seasons.push(season);
      state.activeSeasonId = season.id;
      break;
    }
    case "profile.saved":
      saveProfile(state, command.profile);
      break;
    case "roster.imported": {
      requireThat2(
        command.id.length <= 150 && !/[^A-Za-z0-9_.:-]/.test(command.id),
        "Use a valid stable roster import identity."
      );
      requireThat2(
        command.confirmNewPlayers === true,
        "Confirm that every imported row creates a new player; no accounts or access are granted."
      );
      requireThat2(
        Object.keys(command).every(
          (key) => [
            "id",
            "type",
            "expectedRevision",
            "profiles",
            "confirmNewPlayers"
          ].includes(key)
        ),
        "Use the documented roster import command."
      );
      state.profiles.push(...validateRosterImport(state, command.profiles));
      break;
    }
    case "profile.archived": {
      const profile = state.profiles.find(
        (item) => item.id === command.profileId
      );
      requireThat2(profile, "Player profile not found.");
      activeSeason(state, profile.seasonId);
      profile.active = false;
      break;
    }
    case "formation.saved": {
      const formation = clone(command.formation);
      validateFormat(formation.format);
      formation.name = text(formation.name, "Formation name", 40);
      requireThat2(
        formation.slots.length === formation.format && formation.slots.filter((slot) => slot.position === "GK").length === 1,
        "A formation needs the chosen number of slots and exactly one goalkeeper."
      );
      unique(formation.slots.map((slot) => slot.id));
      for (const slot of formation.slots) {
        requireThat2(
          slot.id.length > 0 && positionCodes.includes(slot.position),
          "Each slot needs an identity and position type."
        );
        slot.label = text(slot.label, "Slot label", 16);
        requireThat2(
          Number.isFinite(slot.x) && slot.x >= 0 && slot.x <= 1 && Number.isFinite(slot.y) && slot.y >= 0 && slot.y <= 1,
          "Formation coordinates must be between zero and one."
        );
      }
      const version = (state.formations.find((item) => item.id === formation.id)?.version ?? 0) + 1;
      state.formations = state.formations.filter(
        (item) => item.id !== formation.id
      );
      state.formations.push({ ...formation, version });
      break;
    }
    case "fixture.saved": {
      const fixture = clone(command.fixture);
      dateInSeason(state, fixture.seasonId, fixture.playedDate);
      validateFormat(fixture.format);
      validateHalf(fixture.plannedHalfDurationMs);
      fixture.opponent = text(fixture.opponent, "Opposition");
      requireThat2(
        validTime(fixture.kickoff) && validTime(fixture.arrival),
        "Use 24-hour HH:MM times, or leave time not recorded."
      );
      requireThat2(
        ["home", "away"].includes(fixture.homeAway),
        "Choose home or away."
      );
      const existing = state.fixtures.find((item) => item.id === fixture.id);
      if (existing)
        requireThat2(
          existing.seasonId === fixture.seasonId && existing.status !== "cancelled",
          "Cancelled matches must be restored explicitly before rescheduling."
        );
      const status = "scheduled";
      const updated = {
        ...fixture,
        status,
        selectedProfileIds: existing?.selectedProfileIds ?? [],
        responses: existing?.responses ?? {},
        attendance: existing?.attendance ?? {},
        ...existing?.matchPlanDraft ? { matchPlanDraft: existing.matchPlanDraft } : {},
        history: [
          ...existing?.history ?? [],
          {
            revision,
            action: existing ? "rescheduled" : "created",
            playedDate: fixture.playedDate,
            kickoff: fixture.kickoff,
            status
          }
        ]
      };
      state.fixtures = state.fixtures.filter((item) => item.id !== fixture.id);
      state.fixtures.push(updated);
      break;
    }
    case "fixture.status_changed": {
      const fixture = state.fixtures.find(
        (item) => item.id === command.fixtureId
      );
      requireThat2(fixture, "Match not found.");
      activeSeason(state, fixture.seasonId);
      requireThat2(
        ["scheduled", "postponed", "cancelled"].includes(command.status),
        "Choose a valid fixture state."
      );
      fixture.status = command.status;
      fixture.history.push({
        revision,
        action: command.status,
        playedDate: fixture.playedDate,
        kickoff: fixture.kickoff,
        status: command.status
      });
      break;
    }
    case "fixture.response_recorded":
    case "fixture.selection_saved":
    case "fixture.attendance_recorded": {
      const fixture = state.fixtures.find(
        (item) => item.id === command.fixtureId
      );
      requireThat2(fixture, "Match not found.");
      activeSeason(state, fixture.seasonId);
      requireThat2(
        fixture.status === "scheduled",
        "Only a scheduled match can collect responses, selection or attendance."
      );
      if (command.type === "fixture.selection_saved") {
        unique(command.selectedProfileIds);
        command.selectedProfileIds.forEach(
          (id) => checkProfile(state, id, fixture.seasonId)
        );
        fixture.selectedProfileIds = [...command.selectedProfileIds];
      } else {
        checkProfile(state, command.profileId, fixture.seasonId);
        if (command.type === "fixture.response_recorded") {
          validResponse(command.response);
          fixture.responses[command.profileId] = command.response;
        } else {
          validAttendance(command.attendance);
          requireThat2(
            fixture.selectedProfileIds.includes(command.profileId),
            "Only selected match players can be checked in."
          );
          fixture.attendance[command.profileId] = command.attendance;
        }
      }
      break;
    }
    case "fixture.prepared": {
      const snapshot = prepareFixtureSnapshot(
        state,
        command.fixtureId,
        command.formationId
      );
      state.snapshots.push(snapshot);
      break;
    }
    case "training.series_created":
    case "training.series_updated":
    case "training.series_cancelled": {
      applyTrainingSeries(state, command, (draft) => validateTraining(state, draft));
      break;
    }
    case "match_plan.saved": {
      const { type: _type, id: _id, expectedRevision: _revision, ...input } = command;
      const plan = saveMatchPlan(state, input);
      state.matchPlans = [...state.matchPlans ?? [], plan];
      break;
    }
    case "match_plan.applied": {
      const { type: _type, id: _id, expectedRevision: _revision, ...input } = command;
      const draft = applyMatchPlan(state, input, context);
      state.fixtures.find((item) => item.id === command.fixtureId).matchPlanDraft = draft;
      break;
    }
    case "match_plan.cleared": {
      const fixture = state.fixtures.find((item) => item.id === command.fixtureId);
      requireThat2(fixture && fixture.seasonId === state.activeSeasonId, "Choose a fixture in the current season.");
      delete fixture.matchPlanDraft;
      break;
    }
    case "training.saved": {
      const training = clone(command.training);
      validateTraining(state, training);
      const existing = state.training.find((item) => item.id === training.id);
      if (existing)
        requireThat2(
          existing.seasonId === training.seasonId && existing.recurrenceGroupId === training.recurrenceGroupId && existing.status === "scheduled",
          "Held or cancelled training records are retained; create or restore a scheduled occurrence first."
        );
      state.training = state.training.filter((item) => item.id !== training.id);
      state.training.push({
        ...training,
        status: "scheduled",
        responses: existing?.responses ?? {},
        attendance: existing?.attendance ?? {}
      });
      break;
    }
    case "training.status_changed": {
      const training = state.training.find(
        (item) => item.id === command.trainingId
      );
      requireThat2(training, "Training occurrence not found.");
      activeSeason(state, training.seasonId);
      requireThat2(
        ["scheduled", "held", "cancelled"].includes(command.status),
        "Choose a valid training state."
      );
      training.status = command.status;
      break;
    }
    case "training.response_recorded":
    case "training.attendance_recorded": {
      const training = state.training.find(
        (item) => item.id === command.trainingId
      );
      requireThat2(training, "Training occurrence not found.");
      activeSeason(state, training.seasonId);
      checkProfile(state, command.profileId, training.seasonId);
      requireThat2(
        training.expectedProfileIds.includes(command.profileId),
        "Only expected players belong to this attendance occurrence."
      );
      if (command.type === "training.response_recorded") {
        requireThat2(
          training.status !== "cancelled",
          "Cancelled training cannot collect availability."
        );
        validResponse(command.response);
        training.responses[command.profileId] = command.response;
      } else {
        requireThat2(
          training.status === "held",
          "Mark this occurrence as held before recording actual attendance. Cancelled training is excluded."
        );
        validAttendance(command.attendance);
        training.attendance[command.profileId] = command.attendance;
      }
      break;
    }
    default:
      throw new Error(
        "This preparation command is not supported. No saved records were changed."
      );
  }
  state.revision = revision;
  state.appliedCommands[command.id] = signature2;
  state.audit.push({ id: command.id, revision, type: command.type });
  return state;
}
function trainingAttendanceEvidence(state) {
  return state.training.map((session) => ({
    sessionId: session.id,
    playedDate: session.date,
    eventStatus: session.status,
    expectedPlayerIds: session.expectedProfileIds.map(
      (id) => state.profiles.find((profile) => profile.id === id)?.playerId
    ).filter((id) => Boolean(id)),
    attendance: Object.fromEntries(
      Object.entries(session.attendance).flatMap(([id, attendance]) => {
        const profile = state.profiles.find((item) => item.id === id);
        return profile ? [[profile.playerId, attendance]] : [];
      })
    ),
    responses: Object.fromEntries(
      Object.entries(session.responses).flatMap(([id, response]) => {
        const profile = state.profiles.find((item) => item.id === id);
        return profile ? [[profile.playerId, response]] : [];
      })
    )
  }));
}
function createPreparationState() {
  const seasonId = "synthetic-season-2026-27";
  const profiles = Array.from({ length: 13 }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    const preferred = index === 0 ? "GK" : [
      "CB",
      "CB",
      "CM",
      "LW",
      "RW",
      "ST",
      "LW",
      "RW",
      "CM",
      "CB",
      "ST",
      "CM"
    ][index - 1];
    const preferences = [
      preferred,
      ...["CM", "CB", "ST", "LW"].filter(
        (position) => position !== preferred
      )
    ].slice(0, 3);
    return {
      id: `synthetic-player-${number}:${seasonId}`,
      playerId: `synthetic-player-${number}`,
      seasonId,
      displayName: `Player ${number}`,
      initials: number,
      shirtNumber: index + 1,
      foot: "not_recorded",
      preferences,
      eligiblePositions: index === 0 ? ["GK", "CB", "ST"] : ["CB", "LB", "RB", "CM", "LW", "RW", "ST"],
      active: true
    };
  });
  const fixture = {
    id: "synthetic-roma-maple-2026-10-24",
    seasonId,
    opponent: "Maple FC",
    playedDate: "2026-10-24",
    kickoff: "10:00",
    arrival: "09:30",
    venue: "Roma recreation ground",
    homeAway: "home",
    format: 7,
    plannedHalfDurationMs: 15e5,
    status: "scheduled",
    selectedProfileIds: profiles.slice(0, 9).map((profile) => profile.id),
    responses: Object.fromEntries(
      profiles.slice(0, 9).map((profile) => [profile.id, "available"])
    ),
    attendance: {},
    history: [
      {
        revision: 0,
        action: "created",
        playedDate: "2026-10-24",
        kickoff: "10:00",
        status: "scheduled"
      }
    ]
  };
  const training = ["2026-10-22", "2026-10-29"].map(
    (date, index) => ({
      id: `synthetic-training-${index + 1}`,
      seasonId,
      date,
      time: "18:00",
      venue: "Roma recreation ground",
      recurrenceGroupId: "synthetic-thursday-training",
      expectedProfileIds: profiles.map((profile) => profile.id),
      status: "scheduled",
      responses: {},
      attendance: {}
    })
  );
  return {
    version: 1,
    synthetic: true,
    revision: 0,
    club: {
      id: "synthetic-richmond-rovers",
      name: "Richmond Rovers",
      logo: "roundel"
    },
    team: {
      id: "synthetic-roma-u10",
      name: "Roma",
      ageGroup: "U10",
      defaultPitchPlaces: 7,
      defaultHalfDurationMs: 15e5,
      logo: null
    },
    activeSeasonId: seasonId,
    seasons: [
      {
        id: seasonId,
        ...seasonBounds(2026),
        startYear: 2026,
        spectatorRenewalRequired: true
      }
    ],
    profiles,
    formations: Array.from(
      { length: 7 },
      (_, index) => defaultFormation(index + 5)
    ),
    fixtures: [fixture],
    training,
    snapshots: [],
    appliedCommands: {},
    audit: []
  };
}

// packages/application/src/player-preparation.ts
var time = (value) => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
var format = (value) => Number.isInteger(value) && Number(value) >= 5 && Number(value) <= 11;
var half = (value) => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) % 1e3 === 0;
function projectOwnPlayerPreparation(state, profile, seasonId) {
  const season = state.seasons.find((item) => item.id === seasonId);
  if (!season || !profile.active || profile.seasonId !== seasonId || !state.profiles.some(
    (item) => item.id === profile.id && item.playerId === profile.playerId && item.seasonId === seasonId && item.active
  ))
    throw new Error("The authorised own-player preparation is unavailable.");
  return {
    kind: "player-preparation",
    revision: state.revision,
    team: {
      id: state.team.id,
      name: state.team.name,
      ageGroup: state.team.ageGroup
    },
    season: {
      id: season.id,
      label: season.label,
      startYear: season.startYear,
      startDate: season.startDate,
      endDate: season.endDate,
      spectatorRenewalRequired: true
    },
    profile: {
      id: profile.id,
      playerId: profile.playerId,
      seasonId: profile.seasonId,
      displayName: profile.displayName,
      initials: profile.initials,
      shirtNumber: profile.shirtNumber,
      foot: profile.foot,
      preferences: [...profile.preferences],
      eligiblePositions: [...profile.eligiblePositions],
      active: profile.active
    },
    fixtures: state.fixtures.filter((item) => item.seasonId === seasonId).map((item) => ({
      id: item.id,
      opponent: item.opponent,
      playedDate: item.playedDate,
      kickoff: time(item.kickoff) ? item.kickoff : null,
      arrival: time(item.arrival) ? item.arrival : null,
      venue: item.venue,
      homeAway: item.homeAway,
      status: item.status,
      format: format(item.format) ? item.format : null,
      plannedHalfDurationMs: half(item.plannedHalfDurationMs) ? item.plannedHalfDurationMs : null,
      response: item.responses[profile.id] ?? "no_reply",
      selected: item.selectedProfileIds.includes(profile.id),
      attendance: item.attendance[profile.id] ?? "not_recorded"
    })),
    training: state.training.filter((item) => item.seasonId === seasonId).map((item) => ({
      id: item.id,
      date: item.date,
      time: time(item.time) ? item.time : null,
      venue: item.venue,
      status: item.status,
      expected: item.expectedProfileIds.includes(profile.id),
      response: item.responses[profile.id] ?? "no_reply",
      attendance: item.attendance[profile.id] ?? "not_recorded"
    }))
  };
}

// apps/api/src/match-pagination.ts
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

// packages/application/src/access.ts
var AccessError = class extends Error {
  constructor(code2, status, message) {
    super(message);
    this.code = code2;
    this.status = status;
    this.name = "AccessError";
  }
  code;
  status;
};
function currentMemberships(principal, memberships, now) {
  if (principal.status !== "active") return [];
  return memberships.filter((item) => item.accountId === principal.accountId && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > now));
}
function assertTeamRole(principal, memberships, teamId, seasonId, roles, now = Date.now()) {
  const match = currentMemberships(principal, memberships, now).find((item) => item.teamId === teamId && item.seasonId === seasonId && roles.includes(item.role));
  if (!match) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
  return match;
}
function assertAdultAuthority(principal, recent = false, now = Date.now()) {
  if (principal.status !== "active" || principal.identityClassification !== "adult_individual" || !principal.adultVerified || !principal.strongAuth) {
    throw new AccessError("ADULT_AUTHORITY_REQUIRED", 403, "A verified adult account with stronger authentication is required.");
  }
  if (recent && (principal.authenticatedAt > now + 3e4 || now - principal.authenticatedAt > 3e5)) {
    throw new AccessError("RECENT_AUTHENTICATION_REQUIRED", 403, "Recent stronger authentication is required.");
  }
}
function assertCanManageTeam(principal, memberships, teamId, seasonId, now = Date.now()) {
  assertTeamRole(principal, memberships, teamId, seasonId, ["manager"], now);
  assertAdultAuthority(principal, false, now);
}
function assertCanAssignManager(actor, target, memberships, teamId, seasonId, now = Date.now()) {
  assertTeamRole(actor, memberships, teamId, seasonId, ["administrator"], now);
  assertAdultAuthority(actor, true, now);
  assertAdultAuthority(target, false, now);
  const managers = memberships.filter((item) => item.teamId === teamId && item.role === "manager" && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > now));
  if (!managers.some((item) => item.accountId === target.accountId) && new Set(managers.map((item) => item.accountId)).size >= 4) {
    throw new AccessError("MANAGER_LIMIT", 409, "A team can have at most four active managers, including administrators who also manage.");
  }
}
var UNAPPROVED_SHARING_POLICY = {
  version: "q21-unapproved",
  approvedBy: null,
  approvedAt: null,
  shareScores: false,
  shareDerivedResults: false
};
function filterMatchForPrincipal(input) {
  const now = input.now ?? Date.now();
  const current3 = currentMemberships(input.principal, input.memberships, now);
  const available2 = current3.filter((item) => item.teamId === input.teamId && item.seasonId === input.seasonId && ["manager", "player", "spectator"].includes(item.role));
  const chosen = input.requestedRole ? available2.find((item) => item.role === input.requestedRole) : available2.find((item) => item.role === "manager") ?? available2.find((item) => item.role === "player") ?? available2[0];
  if (!chosen) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
  const role = assertTeamRole(input.principal, input.memberships, input.teamId, input.seasonId, [chosen.role], now);
  if (role.role === "manager") {
    assertAdultAuthority(input.principal, false, now);
    return { matchId: input.state.config.matchId, teamId: input.teamId, seasonId: input.seasonId, audience: "manager", revision: input.state.revision, state: input.state, lastRecorderSyncAt: input.lastSyncAt };
  }
  const scoresAllowed = input.policy.approvedBy !== null && input.policy.approvedAt !== null && input.policy.shareScores;
  const dto = {
    matchId: input.state.config.matchId,
    teamId: input.teamId,
    seasonId: input.seasonId,
    audience: role.role,
    revision: input.state.revision,
    status: input.state.status,
    score: scoresAllowed ? input.state.score : null,
    halfTimeScore: scoresAllowed ? input.state.halfTimeScore : null,
    sharingPolicyVersion: input.policy.version,
    sharingRestricted: !scoresAllowed,
    lastRecorderSyncAt: input.lastSyncAt,
    ...input.state.config.fixture ? { opponent: input.state.config.fixture.opponent, playedDate: input.state.config.fixture.playedDate, homeAway: input.state.config.fixture.homeAway } : {},
    freshness: input.lastSyncAt !== null && now - input.lastSyncAt <= 15e3 ? "last_synced" : "updates_delayed"
  };
  if (role.role === "player" && role.playerId) {
    const ownIntervals = input.state.intervals.filter((item) => item.playerId === role.playerId);
    dto.ownRecord = {
      playerId: role.playerId,
      attendance: input.state.attendance[role.playerId] ?? "not_recorded",
      playingMs: ownIntervals.filter((item) => item.state === "playing").reduce((sum, item) => sum + item.endMs - item.startMs, 0),
      intervals: ownIntervals,
      completeness: input.state.recoveryRequired ? "review_required" : "recorded_to_last_sync"
    };
  }
  return dto;
}

// apps/api/src/match-pagination.ts
var invalid = () => {
  throw new AccessError("INVALID_PAGE", 400, "Use the original cursor for this account, team, season and selected role, with a page limit from 1 to 100.");
};
var validId = (value) => typeof value === "string" && value.length >= 1;
function matchPageAudience(principal, memberships, teamId, seasonId, requestedRole, nowMs) {
  const available2 = currentMemberships(principal, memberships, nowMs).filter((item) => item.teamId === teamId && item.seasonId === seasonId && ["manager", "player", "spectator"].includes(item.role));
  const chosen = requestedRole ? available2.find((item) => item.role === requestedRole) : available2.find((item) => item.role === "manager") ?? available2.find((item) => item.role === "player") ?? available2[0];
  if (!chosen) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
  if (chosen.role === "manager") assertAdultAuthority(principal, false, nowMs);
  return chosen;
}
var binding = (scope) => createHash("sha256").update(JSON.stringify(["longball.matches.id-asc.v1", scope.principal.accountId, scope.principal.issuer, scope.principal.subject, scope.teamId, scope.seasonId, scope.role, scope.playerId])).digest("base64url");
function matchPageCursor(scope, afterId) {
  if (!validId(afterId)) invalid();
  return Buffer.from(JSON.stringify({ version: 1, binding: binding(scope), afterId })).toString("base64url");
}
function matchPagePosition(scope, query) {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) invalid();
  if (query.cursor === null) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(query.cursor)) invalid();
    const bytes = Buffer.from(query.cursor, "base64url");
    if (bytes.toString("base64url") !== query.cursor) invalid();
    const cursor = JSON.parse(bytes.toString("utf8"));
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor) || Object.keys(cursor).sort().join(",") !== "afterId,binding,version" || cursor.version !== 1 || cursor.binding !== binding(scope) || !validId(cursor.afterId)) invalid();
    return cursor.afterId;
  } catch {
    return invalid();
  }
}

// apps/api/src/offline-bundle.ts
import { randomUUID } from "node:crypto";

// node_modules/.pnpm/@noble+hashes@2.4.0/node_modules/@noble/hashes/_u64.js
var fromNumH = (n) => n / 2 ** 32 | 0;
var fromNumL = (n) => n >>> 0;
function setU64FromNum(view, byteOffset, n, isLE) {
  const h = fromNumH(n);
  const l = fromNumL(n);
  view.setUint32(byteOffset, isLE ? l : h, isLE);
  view.setUint32(byteOffset + 4, isLE ? h : l, isLE);
}

// node_modules/.pnpm/@noble+hashes@2.4.0/node_modules/@noble/hashes/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
}
var atitle = (title) => title ? `"${title}" ` : "";
function anumber(n, title = "") {
  if (typeof n !== "number")
    throw new TypeError(atitle(title) + "expected number, got " + typeof n);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(atitle(title) + "expected integer >= 0, got " + n);
  return n;
}
function abytes(value, length, title = "") {
  if (isBytes(value) && (length === void 0 || value.length === length))
    return value;
  if (length !== void 0)
    anumber(length, "length");
  const bytes = isBytes(value);
  const ofLen = length !== void 0 ? ` of length ${length}` : "";
  const got = bytes ? `length=${value.length}` : `type=${typeof value}`;
  const message = atitle(title) + "expected Uint8Array" + ofLen + ", got " + got;
  if (!bytes)
    throw new TypeError(message);
  throw new RangeError(message);
}
var aobject = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError((label === "object" ? "" : `"${label}" `) + "expected object, got type=" + typeof value);
};
var aopts = (value, label) => {
  aobject(value, label);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw new TypeError(`"${label}" expected plain object`);
  if (Object.hasOwn(value, "__proto__"))
    throw new TypeError(`"${label}.__proto__" is not allowed`);
};
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("hash was destroyed");
  if (checkFinished && instance.finished)
    throw new Error("digest() was already called");
}
function aoutput(out, instance) {
  abytes(out, void 0, "output");
  const min = instance.outputLen;
  if (!(out.length >= min)) {
    throw new RangeError('"output" expected length >= ' + min);
  }
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
function checkOpts(defaults, opts, title = "opts") {
  aopts(defaults, "defaults");
  if (opts !== void 0)
    aopts(opts, title);
  const merged = Object.assign(/* @__PURE__ */ Object.create(null), defaults, opts);
  return merged;
}
function createHasher(hashCons, info = {}) {
  if (typeof hashCons !== "function")
    throw new TypeError('"hashCons" expected function, got type=' + typeof hashCons);
  info = checkOpts({}, info, "info");
  const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
  const tmp = hashCons(void 0);
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.canXOF = tmp.canXOF;
  hashC.create = (opts) => hashCons(opts);
  Object.assign(hashC, info);
  return Object.freeze(hashC);
}
var oidNist = (suffix) => ({
  // Current NIST hashAlgs suffixes used here fit in one DER subidentifier octet.
  // Larger suffix values would need base-128 OID encoding and a different length byte.
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, suffix])
});

// node_modules/.pnpm/@noble+hashes@2.4.0/node_modules/@noble/hashes/_md.js
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD = class {
  blockLen;
  outputLen;
  canXOF = false;
  padOffset;
  isLE;
  // For partial updates less than block size
  buffer;
  view;
  finished = false;
  length = 0;
  pos = 0;
  destroyed = false;
  constructor(blockLen, outputLen, padOffset, isLE) {
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    abytes(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    let processed = false;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        processed = true;
        continue;
      }
      buffer.set(pos === 0 && take === len ? data : data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
        processed = true;
      }
    }
    this.length += data.length;
    if (processed)
      this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    buffer.fill(0, pos);
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      buffer.fill(0);
    }
    setU64FromNum(view, blockLen - 8, this.length * 8, isLE);
    this.process(view, 0);
    this.roundClean();
    const oview = out === buffer ? view : createView(out);
    const len = this.outputLen;
    const outLen = len / 4;
    const state = this.get();
    if (len % 4 || outLen > state.length)
      throw new Error("invalid outputLen");
    for (let i = 0; i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneIntoMeta(to) {
    const { buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (pos)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);

// node_modules/.pnpm/@noble+hashes@2.4.0/node_modules/@noble/hashes/sha2.js
var SHA256_K = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
var SHA2_32B = class extends HashMD {
  // We cannot use array here since array allows indexing by variable
  // which means optimizer/compiler cannot use registers.
  // Numeric initializers matter: starting the fields as `undefined` changes
  // V8's field representation and makes sha256 3x slower (measured).
  A = 0;
  B = 0;
  C = 0;
  D = 0;
  E = 0;
  F = 0;
  G = 0;
  H = 0;
  constructor(outputLen, IV) {
    super(64, outputLen, 8, false);
    this.A = IV[0] | 0;
    this.B = IV[1] | 0;
    this.C = IV[2] | 0;
    this.D = IV[3] | 0;
    this.E = IV[4] | 0;
    this.F = IV[5] | 0;
    this.G = IV[6] | 0;
    this.H = IV[7] | 0;
  }
  get() {
    const { A, B, C, D, E, F, G, H } = this;
    return [A, B, C, D, E, F, G, H];
  }
  // prettier-ignore
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G | 0;
    this.H = H | 0;
  }
  _cloneInto(to) {
    (to ||= new this.constructor()).set(...this.get());
    return this._cloneIntoMeta(to);
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4)
      SHA256_W[i] = view.getUint32(offset, false);
    for (let i = 16; i < 64; i++) {
      const W15 = SHA256_W[i - 15];
      const W2 = SHA256_W[i - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let i = 0; i < 64; i++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma0 + Maj(A, B, C) | 0;
      H = G;
      G = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C = C + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G = G + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C, D, E, F, G, H);
  }
  roundClean() {
    clean(SHA256_W);
  }
  destroy() {
    this.destroyed = true;
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean(this.buffer);
  }
};
var _SHA256 = class extends SHA2_32B {
  constructor() {
    super(32, SHA256_IV);
  }
};
var sha256 = /* @__PURE__ */ createHasher(
  () => new _SHA256(),
  /* @__PURE__ */ oidNist(1)
);

// packages/application/src/offline-bundle.ts
var OFFLINE_SNAPSHOT_SCHEMA = 1;
var OFFLINE_CHECKSUM_SERIALIZATION = "longball.canonical-json/1";
var MAX_OFFLINE_EVENTS = 1e4;
function* canonicalTokens(value) {
  const ancestors = /* @__PURE__ */ new Set();
  function* encode(input, depth) {
    if (depth > 100) throw new Error("Offline snapshot nesting exceeds the supported bound.");
    if (input === null || typeof input === "string" || typeof input === "boolean") {
      yield JSON.stringify(input);
      return;
    }
    if (typeof input === "number" && Number.isFinite(input)) {
      yield JSON.stringify(input);
      return;
    }
    if (typeof input !== "object" || !input || ancestors.has(input) || ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(input))) throw new Error("Offline snapshot must contain finite JSON values only.");
    ancestors.add(input);
    try {
      if (Object.getOwnPropertySymbols(input).length) throw new Error("Offline snapshot cannot contain symbolic fields.");
      const descriptors = Object.getOwnPropertyDescriptors(input);
      if (Array.isArray(input)) {
        if (Object.keys(input).length !== input.length || Object.entries(descriptors).some(([key, item]) => key !== "length" && (!("value" in item) || !item.enumerable)) || Array.from({ length: input.length }, (_, index) => index).some((index) => !Object.hasOwn(input, index))) throw new Error("Offline snapshot arrays must be dense JSON arrays.");
        yield "[";
        for (let index = 0; index < input.length; index++) {
          if (index) yield ",";
          yield* encode(input[index], depth + 1);
        }
        yield "]";
        return;
      }
      if (Object.values(descriptors).some((item) => !("value" in item) || !item.enumerable)) throw new Error("Offline snapshot cannot contain accessors or hidden fields.");
      yield "{";
      let separator = "";
      for (const key of Object.keys(input).sort()) {
        yield separator;
        separator = ",";
        yield JSON.stringify(key);
        yield ":";
        yield* encode(descriptors[key].value, depth + 1);
      }
      yield "}";
    } finally {
      ancestors.delete(input);
    }
  }
  yield* encode(value, 0);
}
function canonicalOfflineJson(value) {
  return Array.from(canonicalTokens(value)).join("");
}
function offlineUtf8(value) {
  let length = 0;
  for (const character of value) {
    const code2 = character.codePointAt(0);
    length += code2 < 128 ? 1 : code2 < 2048 ? 2 : code2 < 65536 ? 3 : 4;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const character of value) {
    const code2 = character.codePointAt(0);
    if (code2 < 128) bytes[offset++] = code2;
    else if (code2 < 2048) {
      bytes[offset++] = 192 | code2 >> 6;
      bytes[offset++] = 128 | code2 & 63;
    } else if (code2 < 65536) {
      bytes[offset++] = 224 | code2 >> 12;
      bytes[offset++] = 128 | code2 >> 6 & 63;
      bytes[offset++] = 128 | code2 & 63;
    } else {
      bytes[offset++] = 240 | code2 >> 18;
      bytes[offset++] = 128 | code2 >> 12 & 63;
      bytes[offset++] = 128 | code2 >> 6 & 63;
      bytes[offset++] = 128 | code2 & 63;
    }
  }
  return bytes;
}
function offlineChecksum(payload) {
  const hash = sha256.create();
  let chunk = "";
  for (const token of canonicalTokens(payload)) {
    chunk += token;
    if (chunk.length >= 16384) {
      hash.update(offlineUtf8(chunk));
      chunk = "";
    }
  }
  if (chunk) hash.update(offlineUtf8(chunk));
  return Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function sealOfflineSnapshot(payload) {
  const unsigned = { ...payload };
  delete unsigned.checksumSha256;
  return { ...unsigned, checksumSha256: offlineChecksum(unsigned) };
}
var natural = (value) => Number.isSafeInteger(value) && Number(value) >= 0;
var identifier = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,150}$/.test(value);
var iso = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
var equal = (left, right) => canonicalOfflineJson(left) === canonicalOfflineJson(right);
var only = (value, fields4) => Object.keys(value).every((key) => fields4.includes(key));
function assertOfflineSnapshot(download, scope) {
  const fail4 = () => {
    throw new Error("Offline snapshot is incomplete, inconsistent or unsupported. Existing journal retained; download a fresh verified bundle.");
  };
  if (!download || download.snapshotSchemaVersion !== OFFLINE_SNAPSHOT_SCHEMA || download.checksumSerialization !== OFFLINE_CHECKSUM_SERIALIZATION || !identifier(download.bundleId) || !identifier(download.teamId) || !identifier(download.seasonId) || scope.teamId !== void 0 && scope.teamId !== download.teamId || scope.seasonId !== void 0 && scope.seasonId !== download.seasonId || download.deviceId !== scope.deviceId || download.matchId !== scope.matchId || !iso(download.downloadedAt) || !/^[0-9a-f]{64}$/.test(download.checksumSha256 ?? "")) fail4();
  if (!only(download, ["contractVersion", "schemaVersion", "engineVersion", "bundleId", "snapshotSchemaVersion", "checksumSerialization", "checksumSha256", "matchId", "teamId", "seasonId", "deviceId", "state", "acceptedRevision", "deviceCheckpoint", "controller", "publication", "acceptedEvents", "controllerTransitions", "downloadedAt", "clockAnchor", "syntheticOnly"]) || download.controller && !only(download.controller, ["epoch", "account_id", "device_id", "frozen"])) fail4();
  if (!Array.isArray(download.acceptedEvents) || !Array.isArray(download.controllerTransitions) || download.acceptedEvents.length > MAX_OFFLINE_EVENTS || download.controllerTransitions.length > MAX_OFFLINE_EVENTS) fail4();
  const { checksumSha256, ...payload } = download;
  if (offlineChecksum(payload) !== checksumSha256) fail4();
  const state = download.state;
  if (!state?.config || state.config.matchId !== scope.matchId || !natural(state.revision) || state.revision !== download.acceptedRevision || !Array.isArray(state.config.players) || state.config.players.length > 100 || !Array.isArray(state.config.selectedPlayerIds) || state.config.selectedPlayerIds.length > 100 || new Set(state.config.players.map((player) => player.id)).size !== state.config.players.length || state.config.fixture && (state.config.fixture.teamId !== download.teamId || state.config.fixture.seasonId !== download.seasonId)) fail4();
  if (!only(state.config, ["matchId", "players", "selectedPlayerIds", "pitchPlaces", "plannedHalfDurationMs", "fixedKeeperId", "initialPolicyProposal", "initialLineupProposal", "initialAttendance", "slots", "fixture", "profileSnapshot"]) || state.config.players.some((player) => !only(player, ["id", "displayName", "goalkeeperChoice", "positionPreferences", "profileVersion", "available"])) || state.config.profileSnapshot?.some((profile) => !only(profile, ["playerId", "preferences", "eligiblePositions", "initials"]))) fail4();
  if (!download.publication || !Object.hasOwn(download.publication, "fixtureClass") || !Object.hasOwn(download.publication, "classificationVersion") || !Object.hasOwn(download.publication, "resultPolicy") || !download.publication.sharingPolicy || typeof download.publication.sharingPolicy.shareScores !== "boolean" || typeof download.publication.sharingPolicy.shareDerivedResults !== "boolean") fail4();
  if (!Array.isArray(download.acceptedEvents) || !Array.isArray(download.controllerTransitions) || download.acceptedEvents.length > MAX_OFFLINE_EVENTS || download.controllerTransitions.length > MAX_OFFLINE_EVENTS || download.acceptedEvents.length !== state.revision) fail4();
  const ids = /* @__PURE__ */ new Set();
  for (const [index, record] of download.acceptedEvents.entries()) {
    const event = record.event;
    if (record.serverSequence !== index + 1 || !iso(record.receivedAt) || !event || event.matchId !== scope.matchId || event.baseRevision !== index || !identifier(event.eventId) || !identifier(event.deviceId) || !natural(event.clientSequence) || event.clientSequence < 1 || !natural(event.controllerEpoch) || event.controllerEpoch < 1 || !event.engineVersion || event.command?.id !== event.eventId || ids.has(event.eventId)) fail4();
    ids.add(event.eventId);
  }
  if (state.eventHistory && (state.eventHistory.length !== download.acceptedEvents.length || !state.eventHistory.every((event, index) => event.id === download.acceptedEvents[index].event.eventId && equal({ ...download.acceptedEvents[index].event.command, ...event.actorId === void 0 ? {} : { actorId: event.actorId } }, event)))) fail4();
  const checkpoint = download.deviceCheckpoint;
  if (!checkpoint || !natural(checkpoint.clientSequence) || !(checkpoint.previousEventId === null || identifier(checkpoint.previousEventId)) || checkpoint.clientSequence === 0 !== (checkpoint.previousEventId === null)) fail4();
  for (const record of download.acceptedEvents) if (record.event.deviceId === scope.deviceId && record.event.clientSequence > checkpoint.clientSequence) fail4();
  for (const transition of download.controllerTransitions) if (!identifier(transition.id) || !natural(transition.epoch) || transition.epoch < 1 || !identifier(transition.actorId) || !identifier(transition.toDevice) || !(transition.fromDevice === null || identifier(transition.fromDevice)) || !iso(transition.createdAt) || typeof transition.kind !== "string" || !(transition.reason === null || typeof transition.reason === "string")) fail4();
  if (!download.clockAnchor || download.clockAnchor.serverTime !== download.downloadedAt || download.clockAnchor.quality !== "observation_only" || download.clockAnchor.continuousMappingEstablished !== false || typeof download.syntheticOnly !== "boolean") fail4();
}

// apps/api/src/offline-bundle.ts
function offlinePublication(matchId, sharingPolicy, records) {
  const result = records?.results.find((item) => item.id === matchId);
  const policy = result?.publication;
  return {
    fixtureClass: result?.fixtureClass ?? (records?.liveMatch.matchId === matchId ? records.liveMatch.fixtureClass : null),
    classificationVersion: result?.classificationVersion ?? null,
    resultPolicy: policy ? { id: policy.id, version: policy.version, fixtureClass: policy.fixtureClass, confirmed: policy.confirmed, confirmationReference: policy.confirmationReference, allowedRoles: [...policy.allowedRoles] } : null,
    sharingPolicy: { version: sharingPolicy.version, approvedBy: sharingPolicy.approvedBy, approvedAt: sharingPolicy.approvedAt, shareScores: sharingPolicy.shareScores, shareDerivedResults: sharingPolicy.shareDerivedResults }
  };
}
function buildOfflineDownload(input) {
  if (input.events.length > MAX_OFFLINE_EVENTS || input.transitions.length > MAX_OFFLINE_EVENTS) throw new AccessError("OFFLINE_BUNDLE_UNSUPPORTED", 422, "The pilot requires complete accepted/control history within 10000 records in each stream. Nothing was truncated.");
  const downloadedAt = new Date(input.nowMs).toISOString();
  const controllerTransitions = input.transitions.map((row) => ({ id: row.id, epoch: row.epoch, actorId: row.actor_id, fromDevice: row.from_device, toDevice: row.to_device, kind: row.kind, reason: row.reason, createdAt: new Date(row.created_at).toISOString() }));
  try {
    const bundle = sealOfflineSnapshot({
      contractVersion: "longball.events/1.1",
      schemaVersion: 1,
      engineVersion: ENGINE_VERSION,
      bundleId: randomUUID(),
      snapshotSchemaVersion: OFFLINE_SNAPSHOT_SCHEMA,
      checksumSerialization: OFFLINE_CHECKSUM_SERIALIZATION,
      matchId: input.matchId,
      teamId: input.teamId,
      seasonId: input.seasonId,
      deviceId: input.deviceId,
      state: input.state,
      acceptedRevision: input.state.revision,
      deviceCheckpoint: input.checkpoint,
      controller: input.controller,
      publication: input.publication,
      acceptedEvents: input.events.map((row) => ({ serverSequence: row.revision, receivedAt: new Date(row.received_at).toISOString(), event: JSON.parse(row.envelope_json) })),
      controllerTransitions,
      downloadedAt,
      clockAnchor: { serverTime: downloadedAt, quality: "observation_only", continuousMappingEstablished: false },
      syntheticOnly: input.syntheticOnly
    });
    assertOfflineSnapshot(bundle, input);
    return bundle;
  } catch {
    throw new AccessError("OFFLINE_BUNDLE_UNSUPPORTED", 422, "The complete snapshot failed structural or full-history validation. The previous device bundle remains usable; no partial replacement was returned.");
  }
}

// apps/api/src/store.ts
import { createHash as createHash2, randomBytes, randomUUID as randomUUID2 } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

// apps/api/src/team-privilege-schema.ts
var SQLITE_TEAM_PRIVILEGES_DDL = `
CREATE TABLE team_privilege_states(team_id TEXT PRIMARY KEY REFERENCES teams(id),revision INTEGER NOT NULL CHECK(revision>=0),state_json TEXT NOT NULL CHECK(json_valid(state_json)));
CREATE TABLE team_privilege_decisions(team_id TEXT NOT NULL REFERENCES teams(id),revision INTEGER NOT NULL CHECK(revision>0),command_id TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES accounts(id),target_account_id TEXT NOT NULL REFERENCES accounts(id),privilege TEXT NOT NULL CHECK(privilege IN('uploads','invitations')),suspended INTEGER NOT NULL CHECK(suspended IN(0,1)),reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 80),private_note TEXT CHECK(length(private_note)<=1000),created_at INTEGER NOT NULL,PRIMARY KEY(team_id,revision),UNIQUE(team_id,actor_id,command_id));
INSERT INTO team_privilege_states(team_id,revision,state_json) SELECT id,0,json_object('schemaVersion',1,'teamId',id,'revision',0,'restrictions',json('[]')) FROM teams;
CREATE TRIGGER team_privileges_new_team AFTER INSERT ON teams BEGIN INSERT INTO team_privilege_states(team_id,revision,state_json) VALUES(NEW.id,0,json_object('schemaVersion',1,'teamId',NEW.id,'revision',0,'restrictions',json('[]'))); END;
CREATE TRIGGER team_privilege_state_identity BEFORE UPDATE ON team_privilege_states WHEN NEW.team_id<>OLD.team_id OR NEW.revision<>OLD.revision+1 OR json_extract(NEW.state_json,'$.teamId')<>NEW.team_id OR json_extract(NEW.state_json,'$.revision')<>NEW.revision BEGIN SELECT RAISE(ABORT,'Invalid team privilege revision'); END;
CREATE TRIGGER team_privilege_decision_immutable_update BEFORE UPDATE ON team_privilege_decisions BEGIN SELECT RAISE(ABORT,'Immutable team privilege decision'); END;
CREATE TRIGGER team_privilege_decision_immutable_delete BEFORE DELETE ON team_privilege_decisions BEGIN SELECT RAISE(ABORT,'Immutable team privilege decision'); END;
`;

// fixtures/roma.synthetic.json
var roma_synthetic_default = {
  synthetic: true,
  teamId: "synthetic-roma-u10",
  season: "2026/27",
  timeZone: "Europe/London",
  pitchPlaces: 7,
  plannedHalfDurationMs: 15e5,
  players: [
    {
      id: "synthetic-player-01",
      displayName: "Player 01",
      available: true,
      goalkeeperChoice: 1
    },
    {
      id: "synthetic-player-02",
      displayName: "Player 02",
      available: true,
      goalkeeperChoice: 0
    },
    {
      id: "synthetic-player-03",
      displayName: "Player 03",
      available: true,
      goalkeeperChoice: 0
    },
    {
      id: "synthetic-player-04",
      displayName: "Player 04",
      available: true,
      goalkeeperChoice: 0
    },
    {
      id: "synthetic-player-05",
      displayName: "Player 05",
      available: true,
      goalkeeperChoice: 0
    },
    {
      id: "synthetic-player-06",
      displayName: "Player 06",
      available: true,
      goalkeeperChoice: 0
    },
    {
      id: "synthetic-player-07",
      displayName: "Player 07",
      available: true,
      goalkeeperChoice: 0
    },
    {
      id: "synthetic-player-08",
      displayName: "Player 08",
      available: true,
      goalkeeperChoice: 0
    },
    {
      id: "synthetic-player-09",
      displayName: "Player 09",
      available: true,
      goalkeeperChoice: 0
    },
    {
      id: "synthetic-player-10",
      displayName: "Player 10",
      available: false,
      goalkeeperChoice: 0
    },
    {
      id: "synthetic-player-11",
      displayName: "Player 11",
      available: false,
      goalkeeperChoice: 0
    },
    {
      id: "synthetic-player-12",
      displayName: "Player 12",
      available: false,
      goalkeeperChoice: 0
    },
    {
      id: "synthetic-player-13",
      displayName: "Player 13",
      available: false,
      goalkeeperChoice: 0
    }
  ]
};

// packages/testing/src/index.ts
var romaFixture = roma_synthetic_default;

// packages/application/src/invitation-credentials.ts
var validTime2 = (value) => Number.isSafeInteger(value) && value >= 0;
function publicInvitation(invite, nowMs) {
  if (!validTime2(nowMs))
    throw new Error("A valid invitation observation is required.");
  const legacy = !invite.credential || invite.credential.kind === "legacy_retired";
  const state = invite.revokedAtMs !== null ? "revoked" : invite.acceptedBy !== null ? "accepted" : legacy ? "requires_reissue" : invite.expiresAtMs <= nowMs ? "expired" : "pending";
  return {
    id: invite.id,
    teamId: invite.teamId,
    seasonId: invite.seasonId,
    inviterAccountId: invite.inviterAccountId,
    createdAtMs: invite.createdAtMs,
    expiresAtMs: invite.expiresAtMs,
    acceptedBy: invite.acceptedBy,
    acceptedAtMs: invite.acceptedAtMs,
    revokedAtMs: invite.revokedAtMs,
    reissuedFromInvitationId: invite.reissuedFromInvitationId ?? null,
    state,
    requiresReissue: !invite.credential ? invite.acceptedBy === null && invite.revokedAtMs === null : invite.credential.kind === "legacy_retired" && invite.credential.requiresReissue
  };
}

// packages/application/src/community.ts
var CommunityError = class extends Error {
  constructor(code2, message) {
    super(message);
    this.code = code2;
    this.name = "CommunityError";
  }
  code;
};
function requireRule(condition, code2, message) {
  if (!condition) throw new CommunityError(code2, message);
}
function validTime3(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function unique2(values) {
  return new Set(values).size === values.length;
}
function account(state, actor) {
  const found = state.accounts.find((item) => item.id === actor.accountId);
  requireRule(found, "forbidden", "The account is not recognised.");
  return found;
}
function communityCanAccess(state, actor, nowMs) {
  const person = state.accounts.find((item) => item.id === actor.accountId);
  if (!person) return false;
  if (actor.role === "spectator") return state.grants.some((grant) => grant.accountId === actor.accountId && grant.teamId === actor.teamId && grant.seasonId === actor.seasonId && grant.revokedAtMs === null && grant.startsAtMs <= nowMs && nowMs < grant.expiresAtMs);
  if (actor.role === "manager" && (person.classification !== "adult_individual" || !person.adultVerified)) return false;
  const memberships = state.memberships.filter((member) => member.active && member.accountId === actor.accountId && member.teamId === actor.teamId && member.seasonId === actor.seasonId && member.role === actor.role);
  if (actor.role === "player") return memberships.length === 1 && memberships[0].playerId === actor.playerId;
  return memberships.length > 0;
}
function assertAccess(state, actor, nowMs) {
  requireRule(communityCanAccess(state, actor, nowMs), "forbidden", "Team access is unavailable or the season grant has expired. Other account memberships remain intact.");
}
function assertManager(state, actor, nowMs) {
  assertAccess(state, actor, nowMs);
  requireRule(actor.role === "manager", "forbidden", "Only an assigned verified adult manager can do this.");
}
function scopedMatch(state, actor, id) {
  const match = state.matches.find((item) => item.id === id);
  requireRule(match && match.teamId === actor.teamId && match.seasonId === actor.seasonId, "forbidden", "That match is outside this team and season.");
  return match;
}
function scopedPhoto(state, actor, id) {
  const photo = state.photos.find((item) => item.id === id);
  requireRule(photo && photo.teamId === actor.teamId && photo.seasonId === actor.seasonId, "forbidden", "That photo is outside this team and season.");
  return photo;
}
function currentPhoto(photo, version) {
  if (version !== void 0) requireRule(version === photo.currentRevision, "conflict", "This photo changed. Review its current revision before continuing.");
  requireRule(photo.removedAtMs === null, "closed", "This photo has been removed.");
  const revision = photo.revisions.find((item) => item.version === photo.currentRevision);
  requireRule(revision, "invalid", "The photo revision is missing.");
  return revision;
}
function labelForPlayer(state, playerId) {
  const membership = state.memberships.find((item) => item.playerId === playerId);
  return state.accounts.find((item) => item.id === membership?.accountId)?.label ?? "Player";
}
function labelForAccount(state, accountId) {
  return state.accounts.find((item) => item.id === accountId)?.label ?? "Team member";
}
function sharedAllowed(state, actor, match) {
  return actor.role === "manager" || state.synthetic && match.sharing === "fictional_review_only";
}
function eligibleVoter(match, playerId) {
  return Boolean(playerId && match.selectedPlayerIds.includes(playerId) && match.presentPlayerIds.includes(playerId));
}
function latestBallots(state, matchId) {
  const latest = /* @__PURE__ */ new Map();
  for (const ballot of state.ballots) if (ballot.matchId === matchId) {
    const previous = latest.get(ballot.voterPlayerId);
    if (!previous || ballot.revision > previous.revision) latest.set(ballot.voterPlayerId, ballot);
  }
  return [...latest.values()];
}
function sealAward(state, match, nowMs) {
  requireRule(match.voteCutoffAtMs !== null && match.finalisationDeadlineAtMs !== null, "invalid", "The award timing evidence is missing.");
  const counts = /* @__PURE__ */ new Map();
  for (const ballot of latestBallots(state, match.id)) if ((ballot.receivedAtMs < match.voteCutoffAtMs || match.cutoffSource === "manager_early_close" && ballot.receivedAtMs === match.voteCutoffAtMs) && eligibleVoter(match, ballot.voterPlayerId) && ballot.voterPlayerId !== ballot.candidatePlayerId && match.playedPlayerIds.includes(ballot.candidatePlayerId)) {
    counts.set(ballot.candidatePlayerId, (counts.get(ballot.candidatePlayerId) ?? 0) + 1);
  }
  const highest = Math.max(0, ...counts.values());
  const winners = [...counts].filter(([, count]) => count === highest).map(([id]) => id).sort();
  state.awards.push({
    matchId: match.id,
    winnerPlayerIds: winners,
    result: highest === 0 ? "no_valid_votes" : "winners",
    voteCutoffAtMs: match.voteCutoffAtMs,
    finalisationDeadlineAtMs: match.finalisationDeadlineAtMs,
    finalisedAtMs: nowMs,
    deadlineMissed: nowMs > match.finalisationDeadlineAtMs
  });
}
function validateArt(art, caption) {
  requireRule(["pitch", "ball", "cones"].includes(art), "invalid", "Choose a fictional review illustration. Arbitrary URLs and raw image uploads are not supported here.");
  requireRule(typeof caption === "string" && caption.trim().length <= 160, "invalid", "Keep the caption within 160 characters.");
}
function defaultCommunityPreferences() {
  return { schedule: true, match: true, awards: true, photos: true, quietStart: null, quietEnd: null };
}
function applyCommunityCommand(state, actor, command, nowMs) {
  requireRule(validTime3(nowMs), "invalid", "A valid receipt time is required.");
  account(state, actor);
  requireRule(command.id.trim(), "invalid", "A command identity is required.");
  const fingerprint = JSON.stringify([actor, command]);
  const prior = state.appliedCommands[command.id];
  if (prior !== void 0) {
    requireRule(prior === fingerprint, "conflict", "This command identity was already used for different content.");
    return state;
  }
  requireRule(command.expectedRevision === void 0 || command.expectedRevision === state.revision, "conflict", "Community records changed. Reload the saved record before retrying.");
  const next = JSON.parse(JSON.stringify(state));
  const personal = ["preferences.changed", "privacy.drafted", "privacy.cancelled"].includes(command.type) || command.type === "uploader.hidden" && !command.hidden;
  if (!personal && command.type !== "invite.accepted") assertAccess(next, actor, nowMs);
  switch (command.type) {
    case "invite.created": {
      requireRule(next.synthetic === true, "forbidden", "Review codes are available only in the fictional local journey.");
      requireRule(actor.role !== "spectator", "forbidden", "Spectators cannot invite other spectators.");
      const season = next.seasons.find((item) => item.id === actor.seasonId && item.teamId === actor.teamId);
      requireRule(season, "invalid", "The team season is missing.");
      requireRule(validTime3(command.expiresAtMs) && nowMs < command.expiresAtMs && command.expiresAtMs <= season.accessEndsAtMs, "invalid", "Choose an invitation expiry after now and before the season ends.");
      requireRule(command.reviewCode.trim().length >= 6 && !next.invitations.some((item) => item.reviewCode === command.reviewCode || item.id === command.invitationId), "invalid", "The fictional invitation identity/code must be unique.");
      next.invitations.push({
        id: command.invitationId,
        teamId: actor.teamId,
        seasonId: actor.seasonId,
        inviterAccountId: actor.accountId,
        reviewCode: command.reviewCode,
        credential: { kind: "fictional_review", version: 1, code: command.reviewCode },
        createdAtMs: nowMs,
        expiresAtMs: command.expiresAtMs,
        acceptedBy: null,
        acceptedAtMs: null,
        revokedAtMs: null,
        reissuedFromInvitationId: null
      });
      break;
    }
    case "invite.accepted": {
      requireRule(next.synthetic === true, "forbidden", "Review codes are available only in the fictional local journey.");
      const invite = next.invitations.find((item) => item.credential?.kind === "fictional_review" && item.credential.code === command.reviewCode && item.reviewCode === command.reviewCode);
      requireRule(invite && invite.teamId === actor.teamId && invite.seasonId === actor.seasonId, "forbidden", "That invitation is not valid for this team and season.");
      requireRule(invite.revokedAtMs === null && invite.acceptedBy === null, "closed", "That invitation has already been accepted or revoked.");
      requireRule(nowMs < invite.expiresAtMs, "expired", "This invitation has expired. Ask for a new individual invitation.");
      const season = next.seasons.find((item) => item.id === invite.seasonId && item.teamId === invite.teamId);
      requireRule(season && nowMs < season.accessEndsAtMs, "expired", "The invited season has ended. Renewal is explicit.");
      invite.acceptedBy = actor.accountId;
      invite.acceptedAtMs = nowMs;
      next.grants.push({
        id: `grant:${invite.id}`,
        invitationId: invite.id,
        accountId: actor.accountId,
        teamId: invite.teamId,
        seasonId: invite.seasonId,
        startsAtMs: nowMs,
        expiresAtMs: season.accessEndsAtMs,
        revokedAtMs: null
      });
      break;
    }
    case "invite.revoked": {
      assertManager(next, actor, nowMs);
      const invite = next.invitations.find((item) => item.id === command.invitationId && item.teamId === actor.teamId && item.seasonId === actor.seasonId);
      requireRule(invite, "forbidden", "That invitation is outside this team and season.");
      invite.revokedAtMs = nowMs;
      for (const grant of next.grants) if (grant.invitationId === invite.id) grant.revokedAtMs = nowMs;
      break;
    }
    case "grant.revoked": {
      assertManager(next, actor, nowMs);
      const grant = next.grants.find((item) => item.id === command.grantId && item.teamId === actor.teamId && item.seasonId === actor.seasonId);
      requireRule(grant, "forbidden", "That grant is outside this team and season.");
      grant.revokedAtMs = nowMs;
      break;
    }
    case "match.registered": {
      assertManager(next, actor, nowMs);
      const match = command.match;
      requireRule(match.teamId === actor.teamId && match.seasonId === actor.seasonId, "forbidden", "A match must belong to the active team and season.");
      requireRule(!next.matches.some((item) => item.id === match.id), "conflict", "This match is already registered. A corrected finish requires an audited exception process and never reopens an award.");
      requireRule(validTime3(match.playedAtMs) && unique2(match.selectedPlayerIds) && unique2(match.presentPlayerIds) && unique2(match.playedPlayerIds), "invalid", "The match evidence is invalid.");
      requireRule(match.presentPlayerIds.every((id) => match.selectedPlayerIds.includes(id)) && match.playedPlayerIds.every((id) => match.presentPlayerIds.includes(id)), "invalid", "Played and present evidence must belong to the selected squad.");
      requireRule(match.selectedPlayerIds.every((id) => next.memberships.some((member) => member.playerId === id && member.teamId === actor.teamId && member.seasonId === actor.seasonId)), "invalid", "Every selected player needs a membership in this team and season.");
      requireRule(match.actualFullTimeAtMs === null || validTime3(match.actualFullTimeAtMs) && match.actualFullTimeAtMs <= nowMs, "invalid", "Actual full time cannot be in the future.");
      next.matches.push({
        ...match,
        voteCutoffAtMs: null,
        cutoffSource: "unresolved",
        finalisationDeadlineAtMs: match.actualFullTimeAtMs === null ? null : match.actualFullTimeAtMs + 36e5
      });
      break;
    }
    case "award.cutoffConfigured": {
      assertManager(next, actor, nowMs);
      const match = scopedMatch(next, actor, command.matchId);
      requireRule(match.actualFullTimeAtMs !== null && match.finishQuality === "trusted", "policy_needed", "Trustworthy original full-time evidence is required first.");
      requireRule(!next.awards.some((item) => item.matchId === match.id) && match.cutoffSource === "unresolved", "closed", "A configured/closed award cannot be reopened by changing its cutoff.");
      requireRule(Number.isSafeInteger(command.minutesAfterFullTime) && command.minutesAfterFullTime > 0 && command.minutesAfterFullTime < 60, "invalid", "Choose an explicit fictional cutoff from 1 to 59 minutes. This does not approve a production default.");
      match.voteCutoffAtMs = match.actualFullTimeAtMs + command.minutesAfterFullTime * 6e4;
      match.cutoffSource = "explicit_fictional_setting";
      break;
    }
    case "ballot.cast": {
      const match = scopedMatch(next, actor, command.matchId);
      requireRule(actor.role === "player" && eligibleVoter(match, actor.playerId), "forbidden", "Only a present selected player may cast their own ballot. Parent use shares the same account and vote.");
      requireRule(sharedAllowed(next, actor, match), "policy_needed", "This match award is not shared under the current competition policy.");
      requireRule(match.finishQuality === "trusted", "policy_needed", "The finish/eligibility evidence requires review before voting.");
      requireRule(!next.awards.some((item) => item.matchId === match.id), "closed", "Voting is closed.");
      if (match.actualFullTimeAtMs !== null) {
        requireRule(match.voteCutoffAtMs !== null, "policy_needed", "The automatic ballot cutoff is unresolved (Q15). A manager must set an explicit fictional rehearsal cutoff or close deliberately.");
        requireRule(nowMs < match.voteCutoffAtMs && nowMs < match.finalisationDeadlineAtMs, "closed", "Voting is closed at its original cutoff, even if finalisation is delayed.");
      }
      requireRule(command.candidatePlayerId !== actor.playerId && match.playedPlayerIds.includes(command.candidatePlayerId), "invalid", "Choose a teammate who actually played. Self-votes are not permitted.");
      const revisions = next.ballots.filter((item) => item.matchId === match.id && item.voterPlayerId === actor.playerId);
      next.ballots.push({
        id: command.id,
        matchId: match.id,
        voterAccountId: actor.accountId,
        voterPlayerId: actor.playerId,
        candidatePlayerId: command.candidatePlayerId,
        receivedAtMs: nowMs,
        revision: revisions.length + 1
      });
      break;
    }
    case "award.finalised": {
      assertManager(next, actor, nowMs);
      const match = scopedMatch(next, actor, command.matchId);
      requireRule(match.actualFullTimeAtMs !== null && match.finalisationDeadlineAtMs !== null && nowMs >= match.actualFullTimeAtMs, "invalid", "A manager may close only after actual full time.");
      requireRule(match.finishQuality === "trusted", "policy_needed", "Contradictory or uncertain finish/eligibility evidence blocks finalisation. Retain it for audited review.");
      requireRule(!next.awards.some((item) => item.matchId === match.id), "closed", "This final award is already sealed. Report edits never reopen it.");
      if (match.voteCutoffAtMs === null || nowMs < match.voteCutoffAtMs) {
        match.voteCutoffAtMs = Math.min(nowMs, match.finalisationDeadlineAtMs);
        match.cutoffSource = "manager_early_close";
      }
      sealAward(next, match, nowMs);
      break;
    }
    case "photo.submitted": {
      requireRule(actor.role !== "spectator", "forbidden", "Spectators cannot upload photos.");
      const match = scopedMatch(next, actor, command.matchId);
      requireRule(command.policyAcknowledged === true, "invalid", "Review the photo policy before submission.");
      validateArt(command.art, command.caption);
      requireRule(!next.photos.some((item) => item.id === command.photoId), "conflict", "That photo identity is already in use.");
      next.photos.push({
        id: command.photoId,
        matchId: match.id,
        teamId: match.teamId,
        seasonId: match.seasonId,
        uploaderAccountId: actor.accountId,
        uploaderRole: actor.role,
        currentRevision: 1,
        publishedRevision: null,
        removedAtMs: null,
        revisions: [{
          version: 1,
          art: command.art,
          caption: command.caption.trim(),
          status: actor.role === "player" ? "pending" : "draft",
          createdAtMs: nowMs,
          reviewedAtMs: null,
          reviewerAccountId: null,
          rejectionReason: null,
          processing: "synthetic_derivative_ready"
        }]
      });
      break;
    }
    case "photo.revised": {
      const photo = scopedPhoto(next, actor, command.photoId);
      currentPhoto(photo, command.sourceRevision);
      requireRule(photo.uploaderAccountId === actor.accountId && actor.role === photo.uploaderRole, "forbidden", "Only the uploader may revise their submission.");
      requireRule(command.policyAcknowledged === true, "invalid", "Review the photo policy before resubmission.");
      validateArt(command.art, command.caption);
      photo.currentRevision += 1;
      photo.revisions.push({
        version: photo.currentRevision,
        art: command.art,
        caption: command.caption.trim(),
        status: actor.role === "player" ? "pending" : "draft",
        createdAtMs: nowMs,
        reviewedAtMs: null,
        reviewerAccountId: null,
        rejectionReason: null,
        processing: "synthetic_derivative_ready"
      });
      break;
    }
    case "photo.reviewed": {
      assertManager(next, actor, nowMs);
      const photo = scopedPhoto(next, actor, command.photoId);
      const revision = currentPhoto(photo, command.sourceRevision);
      requireRule(photo.uploaderRole === "player" && revision.status === "pending", "invalid", "Only a current pending player submission enters this review queue.");
      requireRule(photo.uploaderAccountId !== actor.accountId, "forbidden", "A conflicted reviewer cannot approve their own submission.");
      requireRule(command.decision !== "reject" || Boolean(command.reason?.trim()), "invalid", "Give a private reason for rejection.");
      revision.status = command.decision === "approve" ? "published" : "rejected";
      revision.reviewedAtMs = nowMs;
      revision.reviewerAccountId = actor.accountId;
      revision.rejectionReason = command.decision === "reject" ? command.reason.trim().slice(0, 240) : null;
      if (command.decision === "approve") photo.publishedRevision = revision.version;
      break;
    }
    case "photo.published": {
      assertManager(next, actor, nowMs);
      const photo = scopedPhoto(next, actor, command.photoId);
      const revision = currentPhoto(photo, command.sourceRevision);
      requireRule(photo.uploaderAccountId === actor.accountId && photo.uploaderRole === "manager" && revision.status === "draft", "forbidden", "Managers explicitly publish their own current draft; player photos need review.");
      requireRule(command.policyAcknowledged === true, "invalid", "Review the exact photo and content policy before Publish.");
      revision.status = "published";
      revision.reviewedAtMs = nowMs;
      revision.reviewerAccountId = actor.accountId;
      photo.publishedRevision = revision.version;
      break;
    }
    case "photo.withdrawn": {
      const photo = scopedPhoto(next, actor, command.photoId);
      const revision = currentPhoto(photo, command.sourceRevision);
      requireRule(photo.uploaderAccountId === actor.accountId, "forbidden", "Only the uploader can withdraw a submission.");
      requireRule(revision.status === "pending" || revision.status === "draft", "closed", "Only an unpublished submission can be withdrawn.");
      revision.status = "withdrawn";
      break;
    }
    case "photo.removed": {
      assertManager(next, actor, nowMs);
      const photo = scopedPhoto(next, actor, command.photoId);
      currentPhoto(photo);
      photo.removedAtMs = nowMs;
      photo.publishedRevision = null;
      break;
    }
    case "concern.submitted": {
      requireRule(!next.concerns.some((item) => item.id === command.concernId), "conflict", "That concern reference is already used.");
      let uploaderAccountId;
      let photoRevision = null;
      if (command.targetType === "photo") {
        const photo = scopedPhoto(next, actor, command.targetId);
        const decision = authorizeCommunityMedia(next, actor, photo.id, nowMs);
        requireRule(decision.allowed, "forbidden", "Only a photo you may view can be reported here.");
        photoRevision = decision.revision.version;
        uploaderAccountId = photo.uploaderAccountId;
      } else {
        requireRule(next.photos.some((photo) => photo.uploaderAccountId === command.targetId && authorizeCommunityMedia(next, actor, photo.id, nowMs).allowed), "forbidden", "Report an uploader through a photo you may view.");
        uploaderAccountId = command.targetId;
      }
      requireRule(command.explanation.length <= 500, "invalid", "Keep the explanation under 500 characters and avoid unnecessary personal details.");
      next.concerns.push({
        id: command.concernId,
        teamId: actor.teamId,
        seasonId: actor.seasonId,
        reporterAccountId: actor.accountId,
        targetType: command.targetType,
        targetId: command.targetId,
        photoRevision,
        uploaderAccountId,
        category: command.category,
        explanation: command.explanation.trim(),
        status: next.memberships.some((item) => item.accountId === uploaderAccountId && item.role === "manager" && item.active && item.teamId === actor.teamId) ? "escalation_required" : "submitted",
        createdAtMs: nowMs
      });
      break;
    }
    case "concern.updated": {
      assertManager(next, actor, nowMs);
      const concern = next.concerns.find((item) => item.id === command.concernId && item.teamId === actor.teamId && item.seasonId === actor.seasonId);
      requireRule(concern && concern.uploaderAccountId !== actor.accountId && concern.status !== "escalation_required", "forbidden", "A conflicted manager cannot review this concern. Operator escalation is required.");
      concern.status = command.status;
      break;
    }
    case "uploader.hidden": {
      requireRule(command.uploaderAccountId !== actor.accountId && next.accounts.some((item) => item.id === command.uploaderAccountId), "invalid", "Choose a different uploader.");
      const alreadyHidden = next.hiddenUploaders.some((item) => item.accountId === actor.accountId && item.uploaderAccountId === command.uploaderAccountId);
      requireRule(alreadyHidden || command.hidden && next.photos.some((photo) => photo.uploaderAccountId === command.uploaderAccountId && authorizeCommunityMedia(next, actor, photo.id, nowMs).allowed), "forbidden", "Choose an uploader through a published photo you may view.");
      next.hiddenUploaders = next.hiddenUploaders.filter((item) => !(item.accountId === actor.accountId && item.uploaderAccountId === command.uploaderAccountId));
      if (command.hidden) next.hiddenUploaders.push({ accountId: actor.accountId, uploaderAccountId: command.uploaderAccountId });
      break;
    }
    case "preferences.changed": {
      const preferences = command.preferences;
      requireRule(["schedule", "match", "awards", "photos"].every((key) => typeof preferences[key] === "boolean"), "invalid", "Notification choices must be on or off.");
      const time3 = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
      requireRule(preferences.quietStart === null && preferences.quietEnd === null || typeof preferences.quietStart === "string" && typeof preferences.quietEnd === "string" && time3.test(preferences.quietStart) && time3.test(preferences.quietEnd), "invalid", "Use HH:MM for both quiet-hour boundaries, or leave both empty.");
      requireRule(preferences.quietStart === null || preferences.quietStart !== preferences.quietEnd, "invalid", "Quiet hours need distinct boundaries; use channel switches to pause all day.");
      next.preferences[actor.accountId] = { ...preferences };
      break;
    }
    case "privacy.drafted": {
      requireRule(!next.privacyRequests.some((item) => item.id === command.requestId), "conflict", "That request reference is already used.");
      next.privacyRequests.push({
        id: command.requestId,
        accountId: actor.accountId,
        type: command.requestType,
        status: "verification_needed",
        createdAtMs: nowMs,
        delivery: "local_draft"
      });
      break;
    }
    case "privacy.cancelled": {
      const request = next.privacyRequests.find((item) => item.id === command.requestId && item.accountId === actor.accountId);
      requireRule(request, "forbidden", "That request belongs to another account.");
      requireRule(request.status === "verification_needed", "closed", "That draft is already cancelled.");
      request.status = "cancelled";
      break;
    }
    default: {
      const exhaustive = command;
      throw new CommunityError("invalid", `Unsupported community action: ${String(exhaustive.type)}`);
    }
  }
  next.revision += 1;
  next.appliedCommands[command.id] = fingerprint;
  next.audit.push({ id: command.id, actorAccountId: actor.accountId, action: command.type, atMs: nowMs, origin: "account" });
  return next;
}
function finalizeDueCommunityAwards(state, nowMs) {
  requireRule(validTime3(nowMs), "invalid", "A valid worker receipt time is required.");
  const due = state.matches.filter((match) => match.finishQuality === "trusted" && match.actualFullTimeAtMs !== null && match.voteCutoffAtMs !== null && match.cutoffSource !== "unresolved" && nowMs >= match.voteCutoffAtMs && !state.awards.some((award) => award.matchId === match.id));
  if (due.length === 0) return state;
  const next = JSON.parse(JSON.stringify(state));
  for (const source2 of due) {
    const match = next.matches.find((item) => item.id === source2.id);
    sealAward(next, match, nowMs);
    next.audit.push({
      id: `worker:award-finalise:${match.id}:${match.voteCutoffAtMs}`,
      actorAccountId: null,
      action: "award.finalised",
      atMs: nowMs,
      origin: "award_worker"
    });
  }
  next.revision += 1;
  return next;
}
function authorizeCommunityMedia(state, actor, photoId, nowMs, mode = "gallery", requestedRevision) {
  if (!communityCanAccess(state, actor, nowMs)) return { allowed: false, reason: "Access unavailable or expired" };
  const photo = state.photos.find((item) => item.id === photoId && item.teamId === actor.teamId && item.seasonId === actor.seasonId);
  if (!photo || photo.removedAtMs !== null) return { allowed: false, reason: "Photo unavailable" };
  const match = state.matches.find((item) => item.id === photo.matchId);
  if (!match) return { allowed: false, reason: "Photo context unavailable" };
  const number = mode === "gallery" ? photo.publishedRevision : photo.currentRevision;
  if (number === null || requestedRevision !== void 0 && number !== requestedRevision) return { allowed: false, reason: "Photo revision is not available to this audience" };
  const revision = photo.revisions.find((item) => item.version === number);
  if (!revision) return { allowed: false, reason: "Photo revision unavailable" };
  if (mode === "gallery") {
    if (revision.status !== "published" || !sharedAllowed(state, actor, match)) return { allowed: false, reason: "Publication policy does not permit this photo" };
    if (state.hiddenUploaders.some((item) => item.accountId === actor.accountId && item.uploaderAccountId === photo.uploaderAccountId)) return { allowed: false, reason: "Uploader hidden for this gallery" };
  } else if (mode === "own") {
    if (photo.uploaderAccountId !== actor.accountId || !["pending", "draft", "published"].includes(revision.status)) return { allowed: false, reason: "This submission is private" };
  } else if (actor.role !== "manager" || photo.uploaderRole !== "player" || revision.status !== "pending") return { allowed: false, reason: "Review permission required" };
  return { allowed: true, revision: { ...revision }, photo: { id: photo.id, matchId: photo.matchId, uploaderAccountId: photo.uploaderAccountId }, cacheControl: "private, no-store" };
}
function getCommunityView(state, actor, nowMs) {
  const allowed = communityCanAccess(state, actor, nowMs);
  const season = state.seasons.find((item) => item.id === actor.seasonId && item.teamId === actor.teamId);
  const person = account(state, actor);
  const scoped = (items) => items.filter((item) => item.teamId === actor.teamId && item.seasonId === actor.seasonId);
  const gallery = allowed ? scoped(state.photos).flatMap((photo) => {
    const decision = authorizeCommunityMedia(state, actor, photo.id, nowMs);
    if (!decision.allowed) return [];
    const match = state.matches.find((item) => item.id === photo.matchId);
    return [{
      id: photo.id,
      matchId: photo.matchId,
      matchLabel: match.label,
      playedAtMs: match.playedAtMs,
      uploaderAccountId: photo.uploaderAccountId,
      uploaderLabel: labelForAccount(state, photo.uploaderAccountId),
      version: decision.revision.version,
      art: decision.revision.art,
      caption: decision.revision.caption
    }];
  }).sort((a, b) => b.playedAtMs - a.playedAtMs || a.id.localeCompare(b.id)) : [];
  return {
    allowed,
    accessMessage: allowed ? null : "Team access has expired or is unavailable. Ask for a new invitation; unrelated account memberships are unchanged.",
    teamLabel: season?.teamLabel ?? "Team",
    seasonLabel: season?.label ?? "Season",
    accountLabel: person.label,
    memberships: state.memberships.filter((item) => item.accountId === actor.accountId).map((item) => ({ ...item })),
    preferences: { ...state.preferences[actor.accountId] ?? defaultCommunityPreferences() },
    invitations: allowed && actor.role !== "spectator" ? scoped(state.invitations).filter((item) => actor.role === "manager" || item.inviterAccountId === actor.accountId).map((item) => ({ ...publicInvitation(item, nowMs), reviewCode: item.credential?.kind === "fictional_review" && state.synthetic === true ? item.credential.code : void 0 })) : [],
    grants: allowed && actor.role === "manager" ? scoped(state.grants).map((item) => ({ ...item, accountLabel: labelForAccount(state, item.accountId) })) : [],
    matches: allowed ? scoped(state.matches).map((match) => {
      const share = sharedAllowed(state, actor, match);
      const award = state.awards.find((item) => item.matchId === match.id);
      const own = actor.role === "player" ? latestBallots(state, match.id).find((item) => item.voterAccountId === actor.accountId && item.voterPlayerId === actor.playerId) : null;
      const mayVote = share && actor.role === "player" && eligibleVoter(match, actor.playerId) && match.finishQuality === "trusted" && !award && (match.actualFullTimeAtMs === null || match.voteCutoffAtMs !== null && nowMs < match.voteCutoffAtMs && nowMs < match.finalisationDeadlineAtMs);
      return {
        id: match.id,
        label: share ? match.label : "Match context withheld by competition policy",
        playedAtMs: share ? match.playedAtMs : null,
        sharingAllowed: share,
        fullTimeAtMs: share ? match.actualFullTimeAtMs : null,
        finishQuality: match.finishQuality,
        cutoffAtMs: share ? match.voteCutoffAtMs : null,
        cutoffSource: match.cutoffSource,
        deadlineAtMs: share ? match.finalisationDeadlineAtMs : null,
        mayVote,
        ownChoice: own?.candidatePlayerId ?? null,
        candidates: mayVote ? match.playedPlayerIds.filter((id) => id !== actor.playerId).map((id) => ({ id, label: labelForPlayer(state, id) })) : [],
        award: share && award ? { ...award, winnerLabels: award.winnerPlayerIds.map((id) => labelForPlayer(state, id)) } : null
      };
    }) : [],
    gallery,
    submissions: allowed && actor.role !== "spectator" ? scoped(state.photos).filter((item) => item.uploaderAccountId === actor.accountId).map((photo) => {
      const revision = photo.revisions.find((item) => item.version === photo.currentRevision);
      return {
        id: photo.id,
        matchId: photo.matchId,
        version: photo.currentRevision,
        status: photo.removedAtMs !== null ? "removed" : revision.status,
        art: photo.removedAtMs !== null || ["rejected", "withdrawn"].includes(revision.status) ? null : revision.art,
        caption: revision.caption,
        rejectionReason: revision.rejectionReason,
        previousPublishedVersion: photo.publishedRevision !== photo.currentRevision ? photo.publishedRevision : null
      };
    }) : [],
    reviewQueue: allowed && actor.role === "manager" ? scoped(state.photos).flatMap((photo) => {
      const decision = authorizeCommunityMedia(state, actor, photo.id, nowMs, "review");
      return decision.allowed ? [{
        id: photo.id,
        version: decision.revision.version,
        art: decision.revision.art,
        caption: decision.revision.caption,
        uploaderLabel: labelForAccount(state, photo.uploaderAccountId)
      }] : [];
    }) : [],
    ownConcerns: state.concerns.filter((item) => item.reporterAccountId === actor.accountId).map((item) => ({ id: item.id, status: item.status, targetType: item.targetType, createdAtMs: item.createdAtMs })),
    reviewConcerns: allowed && actor.role === "manager" ? scoped(state.concerns).filter((item) => item.uploaderAccountId !== actor.accountId && item.status !== "escalation_required").map((item) => ({ id: item.id, targetType: item.targetType, targetId: item.targetId, category: item.category, explanation: item.explanation, status: item.status })) : [],
    hiddenUploaders: state.hiddenUploaders.filter((item) => item.accountId === actor.accountId).map((item) => ({ id: item.uploaderAccountId, label: labelForAccount(state, item.uploaderAccountId) })),
    privacyRequests: state.privacyRequests.filter((item) => item.accountId === actor.accountId).map((item) => ({ ...item }))
  };
}
function createCommunityState(nowMs = Date.now()) {
  const teamId = "synthetic-roma-u10";
  const seasonId = "synthetic-season-2026-27";
  const playerIds = Array.from({ length: 13 }, (_, index) => `synthetic-player-${String(index + 1).padStart(2, "0")}`);
  const accounts = [
    { id: "synthetic-account-manager", label: "Fictional manager", classification: "adult_individual", adultVerified: true },
    ...playerIds.map((id, index) => ({ id: `synthetic-account-player-${String(index + 1).padStart(2, "0")}`, label: `Player ${id.slice(-2)}`, classification: "child_shared", adultVerified: false })),
    { id: "synthetic-account-spectator", label: "Fictional spectator", classification: "spectator", adultVerified: false },
    { id: "synthetic-account-invitee", label: "Fictional invited spectator", classification: "spectator", adultVerified: false }
  ];
  const memberships = [
    { accountId: accounts[0].id, teamId, seasonId, role: "manager", active: true },
    ...playerIds.map((playerId, index) => ({ accountId: accounts[index + 1].id, playerId, teamId, seasonId, role: "player", active: true }))
  ];
  const fullTime = Math.max(0, nowMs - 6e5);
  const match = {
    id: "synthetic-community-willow",
    teamId,
    seasonId,
    label: "Roma vs Willow FC \xB7 fictional review",
    playedAtMs: Math.max(0, fullTime - 36e5),
    selectedPlayerIds: playerIds.slice(0, 9),
    presentPlayerIds: playerIds.slice(0, 9),
    playedPlayerIds: playerIds.slice(0, 9),
    actualFullTimeAtMs: fullTime,
    finishQuality: "trusted",
    voteCutoffAtMs: null,
    cutoffSource: "unresolved",
    finalisationDeadlineAtMs: fullTime + 36e5,
    sharing: "fictional_review_only",
    policyVersion: 1
  };
  const state = {
    schemaVersion: 1,
    synthetic: true,
    revision: 0,
    accounts,
    memberships,
    seasons: [{ id: seasonId, teamId, label: "2026/27", teamLabel: "Roma U10", accessEndsAtMs: Date.parse("2027-08-31T23:00:00Z") }],
    invitations: [],
    grants: [{
      id: "synthetic-demo-grant",
      invitationId: "synthetic-seeded-invitation",
      accountId: "synthetic-account-spectator",
      teamId,
      seasonId,
      startsAtMs: Math.max(0, nowMs - 864e5),
      expiresAtMs: Date.parse("2027-08-31T23:00:00Z"),
      revokedAtMs: null
    }],
    matches: [match],
    ballots: [],
    awards: [],
    photos: [],
    concerns: [],
    hiddenUploaders: [],
    preferences: {},
    privacyRequests: [],
    audit: [],
    appliedCommands: {}
  };
  state.photos.push({
    id: "synthetic-published-pitch",
    matchId: match.id,
    teamId,
    seasonId,
    uploaderAccountId: "synthetic-account-manager",
    uploaderRole: "manager",
    currentRevision: 1,
    publishedRevision: 1,
    removedAtMs: null,
    revisions: [{
      version: 1,
      art: "pitch",
      caption: "A fictional matchday illustration. No children or real photographs.",
      status: "published",
      createdAtMs: fullTime,
      reviewedAtMs: fullTime,
      reviewerAccountId: "synthetic-account-manager",
      rejectionReason: null,
      processing: "synthetic_derivative_ready"
    }]
  });
  state.photos.push({
    id: "synthetic-pending-ball",
    matchId: match.id,
    teamId,
    seasonId,
    uploaderAccountId: "synthetic-account-player-01",
    uploaderRole: "player",
    currentRevision: 1,
    publishedRevision: null,
    removedAtMs: null,
    revisions: [{
      version: 1,
      art: "ball",
      caption: "Fictional football illustration awaiting review.",
      status: "pending",
      createdAtMs: fullTime,
      reviewedAtMs: null,
      reviewerAccountId: null,
      rejectionReason: null,
      processing: "synthetic_derivative_ready"
    }]
  });
  return state;
}
function communityObjectShape(value, fields4) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const object4 = value;
  return Object.keys(object4).every((key) => Object.hasOwn(fields4, key)) && Object.entries(fields4).every(([key, rule]) => Object.hasOwn(object4, key) ? rule.accepts(object4[key]) : Boolean(rule.optional));
}
var communityText = (maximum, nonempty = true) => ({ accepts: (value) => typeof value === "string" && value.length <= maximum && (!nonempty || value.trim().length > 0) });
var communityInteger = (minimum = 0) => ({ accepts: (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum });
var communityEnum = (...values) => ({ accepts: (value) => typeof value === "string" && values.includes(value) });
var communityTrue = { accepts: (value) => value === true };
var communityBoolean = { accepts: (value) => typeof value === "boolean" };
var communityNullable = (rule) => ({ accepts: (value) => value === null || rule.accepts(value) });
var communityOptional = (rule) => ({ ...rule, optional: true });
var communityId = communityText(200);
var communityIds = { accepts: (value) => Array.isArray(value) && value.length <= 1e3 && value.every((item) => communityId.accepts(item)) };
var communityMatchRule = { accepts: (value) => communityObjectShape(value, {
  id: communityId,
  teamId: communityId,
  seasonId: communityId,
  label: communityText(200),
  playedAtMs: communityInteger(),
  selectedPlayerIds: communityIds,
  presentPlayerIds: communityIds,
  playedPlayerIds: communityIds,
  actualFullTimeAtMs: communityNullable(communityInteger()),
  finishQuality: communityEnum("trusted", "review_required", "conflicted"),
  sharing: communityEnum("manager_only", "fictional_review_only"),
  policyVersion: communityInteger(1)
}) };
var communityPreferencesRule = { accepts: (value) => communityObjectShape(value, {
  schedule: communityBoolean,
  match: communityBoolean,
  awards: communityBoolean,
  photos: communityBoolean,
  quietStart: communityNullable(communityText(5)),
  quietEnd: communityNullable(communityText(5))
}) };
var communityCommandFields = {
  "invite.created": { invitationId: communityId, reviewCode: communityText(128), expiresAtMs: communityInteger() },
  "invite.accepted": { reviewCode: communityText(128) },
  "invite.revoked": { invitationId: communityId },
  "grant.revoked": { grantId: communityId },
  "match.registered": { match: communityMatchRule },
  "award.cutoffConfigured": { matchId: communityId, minutesAfterFullTime: communityInteger(1) },
  "ballot.cast": { matchId: communityId, candidatePlayerId: communityId },
  "award.finalised": { matchId: communityId },
  "photo.submitted": { photoId: communityId, matchId: communityId, art: communityEnum("pitch", "ball", "cones"), caption: communityText(160, false), policyAcknowledged: communityTrue },
  "photo.revised": { photoId: communityId, sourceRevision: communityInteger(1), art: communityEnum("pitch", "ball", "cones"), caption: communityText(160, false), policyAcknowledged: communityTrue },
  "photo.reviewed": { photoId: communityId, sourceRevision: communityInteger(1), decision: communityEnum("approve", "reject"), reason: communityOptional(communityText(240)) },
  "photo.published": { photoId: communityId, sourceRevision: communityInteger(1), policyAcknowledged: communityTrue },
  "photo.withdrawn": { photoId: communityId, sourceRevision: communityInteger(1) },
  "photo.removed": { photoId: communityId },
  "concern.submitted": {
    concernId: communityId,
    targetType: communityEnum("photo", "uploader"),
    targetId: communityId,
    category: communityEnum("privacy", "inappropriate", "other"),
    explanation: communityText(500, false)
  },
  "concern.updated": { concernId: communityId, status: communityEnum("under_review", "resolved") },
  "uploader.hidden": { uploaderAccountId: communityId, hidden: communityBoolean },
  "preferences.changed": { preferences: communityPreferencesRule },
  "privacy.drafted": { requestId: communityId, requestType: communityEnum("export", "delete_global_account") },
  "privacy.cancelled": { requestId: communityId }
};

// packages/application/src/records.ts
function clone2(value) {
  return JSON.parse(JSON.stringify(value));
}
function signature(value) {
  if (Array.isArray(value)) return `[${value.map(signature).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== void 0).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${signature(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function nonnegative2(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative whole number.`);
}
function validDate2(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && (/* @__PURE__ */ new Date(`${value}T00:00:00Z`)).toISOString().slice(0, 10) === value;
}
function validInstant(value) {
  return Number.isFinite(Date.parse(value)) && /(?:Z|[+-]\d\d:\d\d)$/.test(value);
}
function validateScore(value) {
  if (value) {
    nonnegative2(value.for, "Our score");
    nonnegative2(value.against, "Opposition score");
  }
}
function managerOnlyPublication(fixtureClass) {
  return { id: "unconfirmed-competition-policy", version: 1, fixtureClass, confirmed: false, confirmationReference: null, allowedRoles: [] };
}
function validateInput(state, input) {
  if (!validDate2(input.playedDate) || input.playedDate < state.startsOn || input.playedDate > state.endsOn) throw new Error("Choose a real played date within this team season.");
  if (!input.opponent.trim()) throw new Error("Record the opposition.");
  if (input.recordedKickoff !== null && !validInstant(input.recordedKickoff)) throw new Error("Known kick-off must include its timezone; otherwise leave it not recorded.");
  if (input.sameDayOrder !== null) nonnegative2(input.sameDayOrder, "Same-day order");
  validateScore(input.finalScore);
  validateScore(input.halfTimeScore);
  if (input.halfTimeScore && input.finalScore && (input.halfTimeScore.for > input.finalScore.for || input.halfTimeScore.against > input.finalScore.against)) throw new Error("Half-time goals cannot exceed the final score.");
  if (new Set(input.goals.map((goal) => goal.id)).size !== input.goals.length) throw new Error("Known goals need distinct identifiers.");
  for (const goal of input.goals) {
    if (!goal.id) throw new Error("A known goal needs an identifier.");
    if (goal.scorerPlayerId && !state.players.some((player) => player.id === goal.scorerPlayerId)) throw new Error("The scorer must belong to this archived team-season roster.");
    if ((goal.beneficiary === "opposition" && !goal.isOwnGoal || goal.beneficiary === "us" && goal.isOwnGoal) && goal.scorerPlayerId !== null) throw new Error("An opposition scorer cannot be credited to one of our players.");
    if (goal.halfElapsedMs !== null) {
      nonnegative2(goal.halfElapsedMs, "Known goal time");
      if (goal.half === null) throw new Error("A known goal time needs its half.");
    }
  }
  if (input.finalScore && (input.goals.filter((goal) => goal.beneficiary === "us").length > input.finalScore.for || input.goals.filter((goal) => goal.beneficiary === "opposition").length > input.finalScore.against)) throw new Error("Known goal attribution cannot exceed the recorded score.");
}
function historicalRecord(state, id, input, at) {
  validateInput(state, input);
  return {
    ...clone2(input),
    opponent: input.opponent.trim(),
    id,
    teamId: state.teamId,
    seasonId: state.seasonId,
    recordMode: "historical_summary",
    detailCompleteness: "summary_only",
    publication: managerOnlyPublication(input.fixtureClass),
    classificationVersion: 1,
    selectedPlayerIds: null,
    attendance: null,
    participation: null,
    actualActiveDurationMs: null,
    keeperPolicy: null,
    sourceMatchRevision: null,
    enteredAt: at,
    updatedAt: at,
    revision: 1,
    awardStatus: "not_recorded"
  };
}
function createRecordsSeed() {
  const state = {
    schemaVersion: 1,
    clubId: "synthetic-richmond-rovers",
    teamId: romaFixture.teamId,
    seasonId: "synthetic-season-2026-27",
    seasonLabel: "26/27",
    startsOn: "2026-09-01",
    endsOn: "2027-08-31",
    players: romaFixture.players.map((player) => ({ id: player.id, label: player.displayName })),
    liveMatch: { matchId: "synthetic-roma-maple-2026-10-24", playedDate: "2026-10-24", opponent: "Maple FC", homeAway: "home", fixtureClass: "development" },
    results: [],
    trainingAttendance: [],
    audit: [],
    revision: 0,
    appliedCommands: {}
  };
  const examples = [
    { id: "synthetic-history-maple", date: "2026-10-03", opponent: "Maple FC", score: { for: 3, against: 1 }, fixtureClass: "development" },
    { id: "synthetic-history-oak", date: "2026-10-10", opponent: "Oak FC", score: { for: 2, against: 2 }, fixtureClass: "friendly" },
    { id: "synthetic-history-hill", date: "2026-10-17", opponent: "Hill FC", score: { for: 0, against: 1 }, fixtureClass: "development" }
  ];
  state.results = examples.map((example, index) => historicalRecord(state, example.id, {
    playedDate: example.date,
    recordedKickoff: null,
    sameDayOrder: null,
    opponent: example.opponent,
    homeAway: "home",
    fixtureClass: example.fixtureClass,
    status: "completed",
    specialOutcome: "ordinary",
    finalScore: example.score,
    halfTimeScore: null,
    goals: index === 0 ? [{ id: "synthetic-history-known-goal", beneficiary: "us", isOwnGoal: false, scorerPlayerId: romaFixture.players[1].id, goalType: null, half: null, halfElapsedMs: null }] : []
  }, "2026-10-20T12:00:00Z"));
  return state;
}
function snapshotLiveMatch(state, match, at) {
  if (match.config.matchId !== state.liveMatch.matchId) throw new Error("Set this match\u2019s recorded fixture details before reporting it.");
  const previousRecord = state.results.find((record) => record.id === match.config.matchId);
  const sameClassification = previousRecord?.fixtureClass === state.liveMatch.fixtureClass;
  const sample = match.anchor?.sample ?? { monotonicMs: 0, sessionId: "records-checkpoint", wallTimeMs: 0 };
  const started = match.status !== "preparation";
  const targets = started ? currentTargets(match, sample) : [];
  const input = {
    ...state.liveMatch,
    recordedKickoff: null,
    sameDayOrder: null,
    status: match.status === "completed" ? "completed" : match.status === "abandoned" ? "abandoned" : "incomplete",
    specialOutcome: "ordinary",
    finalScore: started ? { ...match.score } : null,
    halfTimeScore: match.halfTimeScore ? { ...match.halfTimeScore } : null,
    goals: started ? goalRecords(match).filter((goal) => !goal.voided).map((goal) => ({
      id: goal.eventId,
      beneficiary: goal.beneficiary,
      isOwnGoal: goal.isOwnGoal,
      scorerPlayerId: goal.scorerPlayerId,
      goalType: goal.goalType === "not_recorded" ? null : goal.goalType,
      half: goal.effective.half,
      halfElapsedMs: goal.effective.halfElapsedMs
    })) : []
  };
  validateInput(state, input);
  return {
    ...input,
    id: match.config.matchId,
    teamId: state.teamId,
    seasonId: state.seasonId,
    recordMode: "detailed_live",
    detailCompleteness: match.recoveryRequired ? "review_required" : "complete",
    publication: sameClassification ? clone2(previousRecord.publication) : managerOnlyPublication(state.liveMatch.fixtureClass),
    classificationVersion: previousRecord ? previousRecord.classificationVersion + Number(!sameClassification) : 1,
    selectedPlayerIds: [...match.config.selectedPlayerIds],
    attendance: { ...match.attendance },
    participation: started ? playerMinutes(match, sample).map((player) => {
      const saved = match.config.players.find((item) => item.id === player.playerId);
      const target = targets.find((item) => item.playerId === player.playerId);
      const targetMs = target ? rationalToNumber(target.target) : null;
      const priorEntry = state.results.find((record) => record.id === match.config.matchId)?.participation?.find((item) => item.playerId === player.playerId);
      const exceptionReason = priorEntry?.playedMs === player.playingMs && priorEntry.target?.targetMs === targetMs ? priorEntry.target.exceptionReason : null;
      const preferences = match.config.profileSnapshot?.find((item) => item.playerId === player.playerId)?.preferences ?? saved?.positionPreferences ?? [];
      const preferenceMs = { first: 0, second: 0, backup: 0, other: 0, unknown: 0 };
      for (const [position, duration2] of Object.entries(player.positionMs)) {
        const index = preferences.indexOf(position);
        const category = preferences.length === 0 ? "unknown" : index === 0 ? "first" : index === 1 ? "second" : index >= 2 ? "backup" : "other";
        preferenceMs[category] += duration2;
      }
      return {
        playerId: player.playerId,
        playedMs: player.playingMs,
        availableBenchMs: player.benchMs,
        unavailableMs: player.unavailableMs,
        positionMs: { ...player.positionMs },
        preferenceMs,
        target: target && targetMs !== null ? { targetMs, lowerMs: rationalToNumber(target.lower), upperMs: rationalToNumber(target.upper), withinBand: withinTargetBand(player.playingMs, target), deviationRatio: targetMs === 0 ? null : (player.playingMs - targetMs) / targetMs, exceptionReason } : void 0,
        intervals: match.intervals.filter((item) => item.playerId === player.playerId).map((item) => ({ half: item.half, startMs: item.startMs, endMs: item.endMs, state: item.state, position: item.position })),
        primaryWasGoalkeeper: preferences.length ? preferences[0] === "GK" : saved?.goalkeeperChoice ? saved.goalkeeperChoice === 1 : null
      };
    }) : null,
    actualActiveDurationMs: started ? match.matchActiveMs : null,
    keeperPolicy: match.config.fixedKeeperId ? "sole_fixed_keeper" : "rotating_or_unfixed",
    sourceMatchRevision: match.revision,
    enteredAt: at,
    updatedAt: at,
    revision: 1,
    awardStatus: "not_recorded"
  };
}
function reduceRecords(previous, command) {
  if (command.actor !== "manager") throw new Error("Only the assigned manager rehearsal can change records.");
  if (!command.commandId || !validInstant(command.at)) throw new Error("A record command needs an identifier and an explicit timestamp.");
  const encoded = signature(command);
  if (previous.appliedCommands[command.commandId]) {
    if (previous.appliedCommands[command.commandId] !== encoded) throw new Error("Command identifier conflicts with previously recorded content.");
    return previous;
  }
  let state = previous;
  let before = null;
  let after = null;
  let reason = "";
  switch (command.type) {
    case "historical.add": {
      if (!command.recordId.trim()) throw new Error("This historical match needs an identifier.");
      if (state.results.some((record) => record.id === command.recordId)) throw new Error("This match identifier already exists. Open its correction route.");
      if (!command.acknowledgePossibleDuplicate && state.results.some((record) => record.playedDate === command.input.playedDate && record.opponent.toLowerCase() === command.input.opponent.trim().toLowerCase())) throw new Error("A match against this opponent on this date already exists. Review it or acknowledge that these were separate games.");
      after = historicalRecord(state, command.recordId, command.input, command.at);
      state = { ...state, results: [...state.results, after] };
      reason = "Historical summary entered; unknown detail retained.";
      break;
    }
    case "historical.correct": {
      before = state.results.find((record) => record.id === command.recordId) ?? null;
      if (!before || before.recordMode !== "historical_summary") throw new Error("Use the live event correction route for a detailed match.");
      if (before.revision !== command.expectedRevision) throw new Error("This result changed. Review its latest revision before correcting.");
      if (!command.reason.trim()) throw new Error("Record a reason for the correction.");
      after = {
        ...historicalRecord(state, before.id, command.input, command.at),
        enteredAt: before.enteredAt,
        revision: before.revision + 1,
        classificationVersion: before.classificationVersion + Number(command.input.fixtureClass !== before.fixtureClass),
        publication: command.input.fixtureClass === before.fixtureClass ? clone2(before.publication) : managerOnlyPublication(command.input.fixtureClass)
      };
      state = { ...state, results: state.results.map((record) => record.id === before?.id ? after : record) };
      reason = command.reason.trim();
      break;
    }
    case "live.archive": {
      if (command.match.status !== "completed" || command.match.recoveryRequired) throw new Error("Finish the match and resolve clock uncertainty before archiving a final participation record.");
      before = state.results.find((record) => record.id === command.match.config.matchId) ?? null;
      if (before?.recordMode === "historical_summary") throw new Error("A historical summary already uses this match identifier; explicit reconciliation is required.");
      if (before && ((before.sourceMatchRevision ?? -1) > command.match.revision || before.sourceMatchRevision === command.match.revision && before.fixtureClass === state.liveMatch.fixtureClass)) throw new Error("This match revision is already archived.");
      after = { ...snapshotLiveMatch(state, command.match, command.at), enteredAt: before?.enteredAt ?? command.at, revision: (before?.revision ?? 0) + 1 };
      state = { ...state, results: [...state.results.filter((record) => record.id !== after?.id), after] };
      reason = command.reason?.trim() || "Local completed match captured from recorded intervals.";
      break;
    }
    case "live.context.set": {
      if (!validDate2(command.details.playedDate) || command.details.playedDate < state.startsOn || command.details.playedDate > state.endsOn || !command.details.opponent.trim()) throw new Error("Choose valid fixture details in this season.");
      state = { ...state, liveMatch: clone2(command.details) };
      reason = "Current fixture context recorded.";
      break;
    }
    case "publication.set": {
      before = state.results.find((record) => record.id === command.recordId) ?? null;
      if (!before || before.revision !== command.expectedRevision) throw new Error("Review the latest result before changing its publication policy.");
      if (!command.reason.trim() || !command.policy.confirmationReference?.trim() || !command.policy.confirmed) throw new Error("A confirmed competition decision and audit reason are required before sharing.");
      if (before.fixtureClass === "unclassified" || command.policy.fixtureClass !== before.fixtureClass || command.policy.version <= before.publication.version) throw new Error("Classify the fixture and provide a newer policy version that matches its class.");
      after = { ...before, publication: clone2(command.policy), updatedAt: command.at, revision: before.revision + 1 };
      state = { ...state, results: state.results.map((record) => record.id === before?.id ? after : record) };
      reason = command.reason.trim();
      break;
    }
    case "training.evidence.replace": {
      const ids = command.evidence.map((item) => item.sessionId);
      if (new Set(ids).size !== ids.length || command.evidence.some((item) => !validDate2(item.playedDate) || item.playedDate < state.startsOn || item.playedDate > state.endsOn || new Set(item.expectedPlayerIds).size !== item.expectedPlayerIds.length)) throw new Error("Training evidence needs distinct sessions, unique expected players and dates in this season.");
      state = { ...state, trainingAttendance: clone2(command.evidence) };
      reason = "Training evidence updated from the local schedule; cancelled sessions remain excluded.";
      break;
    }
    case "participation.exception.noted": {
      before = state.results.find((record) => record.id === command.recordId) ?? null;
      if (!before || before.revision !== command.expectedRevision) throw new Error("Review the latest archived match before explaining an exception.");
      const item = before.participation?.find((entry) => entry.playerId === command.playerId);
      if (!item?.target || item.target.withinBand) throw new Error("An exception note requires recorded participation outside its target band.");
      if (!command.reason.trim()) throw new Error("Record the reason for this target exception.");
      after = { ...before, participation: before.participation.map((entry) => entry.playerId === command.playerId ? { ...entry, target: { ...entry.target, exceptionReason: command.reason.trim() } } : entry), updatedAt: command.at, revision: before.revision + 1 };
      state = { ...state, results: state.results.map((record) => record.id === before?.id ? after : record) };
      reason = command.reason.trim();
      break;
    }
  }
  return {
    ...state,
    revision: previous.revision + 1,
    audit: [...state.audit, { commandId: command.commandId, action: command.type, matchId: after?.id ?? before?.id ?? null, at: command.at, reason, before: clone2(before), after: clone2(after) }],
    appliedCommands: { ...state.appliedCommands, [command.commandId]: encoded }
  };
}
function inScope(state, viewer) {
  return (!viewer.teamId || viewer.teamId === state.teamId) && (!viewer.seasonId || viewer.seasonId === state.seasonId);
}
function canShare(record, actor) {
  return actor === "manager" || record.fixtureClass !== "unclassified" && record.publication.confirmed && Boolean(record.publication.confirmationReference) && record.publication.fixtureClass === record.fixtureClass && record.publication.allowedRoles.includes(actor);
}
function ordinaryCompleted(record) {
  return record.status === "completed" && record.specialOutcome === "ordinary" && record.finalScore !== null;
}
function chronological(left, right) {
  return left.playedDate.localeCompare(right.playedDate) || (left.recordedKickoff && right.recordedKickoff ? Date.parse(left.recordedKickoff) - Date.parse(right.recordedKickoff) : (left.sameDayOrder ?? 0) - (right.sameDayOrder ?? 0)) || left.id.localeCompare(right.id);
}
function resultOutcome(score2) {
  return score2.for > score2.against ? "W" : score2.for < score2.against ? "L" : "D";
}
function publicResult(record) {
  const included = ordinaryCompleted(record);
  const outcome = included ? resultOutcome(record.finalScore) : null;
  return {
    id: record.id,
    playedDate: record.playedDate,
    recordedKickoff: record.recordedKickoff,
    sameDayOrder: record.sameDayOrder,
    opponent: record.opponent,
    homeAway: record.homeAway,
    fixtureClass: record.fixtureClass,
    status: record.status,
    recordMode: record.recordMode,
    detailCompleteness: record.detailCompleteness,
    finalScore: record.finalScore ? { ...record.finalScore } : null,
    halfTimeScore: record.halfTimeScore ? { ...record.halfTimeScore } : null,
    goals: clone2(record.goals),
    unassignedGoalsFor: record.finalScore ? record.finalScore.for - record.goals.filter((goal) => goal.beneficiary === "us").length : null,
    unassignedGoalsAgainst: record.finalScore ? record.finalScore.against - record.goals.filter((goal) => goal.beneficiary === "opposition").length : null,
    outcome,
    points: outcome === "W" ? 3 : outcome === "D" ? 1 : outcome === "L" ? 0 : null,
    revision: record.revision
  };
}
function selectSeasonResults(state, viewer) {
  const scoped = inScope(state, viewer) ? state.results.filter((record) => record.teamId === state.teamId && record.seasonId === state.seasonId) : [];
  const visible = scoped.filter((record) => canShare(record, viewer.actor)).sort(chronological);
  const withheld = scoped.length - visible.length;
  const denied = !inScope(state, viewer) || withheld > 0;
  const included = visible.filter(ordinaryCompleted);
  const totals = { played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0 };
  for (const record of included) {
    const outcome = resultOutcome(record.finalScore);
    totals.played += 1;
    totals.wins += Number(outcome === "W");
    totals.draws += Number(outcome === "D");
    totals.losses += Number(outcome === "L");
    totals.goalsFor += record.finalScore.for;
    totals.goalsAgainst += record.finalScore.against;
  }
  totals.goalDifference = totals.goalsFor - totals.goalsAgainst;
  totals.points = totals.wins * 3 + totals.draws;
  const scorerCounts = /* @__PURE__ */ new Map();
  for (const record of included) for (const goal of record.goals) {
    if (goal.beneficiary === "us" && !goal.isOwnGoal && goal.scorerPlayerId) scorerCounts.set(goal.scorerPlayerId, (scorerCounts.get(goal.scorerPlayerId) ?? 0) + 1);
  }
  const ambiguous = included.some((record, index) => included.some((other, otherIndex) => index !== otherIndex && other.playedDate === record.playedDate && !(other.recordedKickoff && record.recordedKickoff) && (other.sameDayOrder === null || record.sameDayOrder === null || other.sameDayOrder === record.sameDayOrder)));
  return {
    clubId: state.clubId,
    teamId: state.teamId,
    seasonId: state.seasonId,
    projectionVersion: state.revision,
    visibilityScope: viewer.actor,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    reportType: "season_results",
    appliedFilters: { teamId: state.teamId, seasonId: state.seasonId },
    asOf: latestRecordTime(state),
    competitionPolicies: visible.map((record) => ({ matchId: record.id, policyId: record.publication.id, policyVersion: record.publication.version, fixtureClass: record.fixtureClass, classificationVersion: record.classificationVersion })),
    sharing: denied ? "withheld_policy" : "permitted",
    suppressionReason: denied ? "Scores and derived totals are not shared for this competition or scope." : null,
    withheldResultCount: viewer.actor === "manager" ? withheld : null,
    rows: visible.map(publicResult),
    totals: denied ? null : totals,
    scorerTotals: denied ? null : state.players.filter((player) => scorerCounts.has(player.id)).map((player) => ({ playerId: player.id, label: player.label, knownGoals: scorerCounts.get(player.id) })),
    form: denied || ambiguous ? null : included.slice(-5).map((record) => ({ matchId: record.id, outcome: resultOutcome(record.finalScore) })),
    formChronologyState: ambiguous ? "same_day_order_unknown" : "known",
    unknownScoreCount: visible.filter((record) => record.status === "completed" && record.finalScore === null).length,
    excludedExceptionalMatches: visible.filter((record) => record.specialOutcome !== "ordinary" || record.status === "abandoned").length,
    dataCoverage: { totalRecordedMatches: denied ? null : scoped.length, knownOrdinaryResults: denied ? null : included.length, summaryOnlyCount: denied ? null : visible.filter((record) => record.recordMode === "historical_summary").length }
  };
}
function reportRecords(state, match) {
  const scoped = state.results.filter((record) => record.teamId === state.teamId && record.seasonId === state.seasonId);
  if (!match || match.config.matchId !== state.liveMatch.matchId || match.status === "preparation") return scoped;
  const current3 = snapshotLiveMatch(state, match, observedMatchTime(match) ?? latestRecordTime(state) ?? state.startsOn + "T00:00:00Z");
  return [...scoped.filter((record) => record.id !== current3.id), current3];
}
function observedMatchTime(match) {
  const value = match?.eventHistory?.at(-1)?.sample.wallTimeMs ?? match?.anchor?.sample.wallTimeMs ?? match?.completedAtMs;
  return value === null || value === void 0 ? null : new Date(value).toISOString();
}
function latestRecordTime(state) {
  const times = [...state.results.map((record) => record.updatedAt), ...state.audit.map((entry) => entry.at)].sort((a, b) => Date.parse(a) - Date.parse(b));
  return times.at(-1) ?? null;
}
function attendanceSummary(values) {
  const attended = values.filter((value) => value === "present").length;
  const absent = values.filter((value) => value === "absent" || value === "excused").length;
  const recorded = attended + absent;
  return {
    eligibleEventCount: values.length,
    attendanceRecordedCount: recorded,
    attendedCount: attended,
    knownAbsentCount: absent,
    unknownAttendanceCount: values.length - recorded,
    excusedCount: values.filter((value) => value === "excused").length,
    knownRecordAttendanceRate: recorded ? attended / recorded : null,
    completenessRatio: values.length ? recorded / values.length : null,
    policy: "proposed_known_records_excused_included"
  };
}
function selectParticipationReport(state, match, viewer) {
  const recordedAt = [latestRecordTime(state), observedMatchTime(match)].filter((item) => item !== null).sort((a, b) => Date.parse(a) - Date.parse(b));
  const metadata = { reportType: "season_participation", clubId: state.clubId, teamId: state.teamId, seasonId: state.seasonId, generatedAt: (/* @__PURE__ */ new Date()).toISOString(), asOf: recordedAt.at(-1) ?? null, projectionVersion: state.revision, sourceMatchRevision: match?.revision ?? null, visibilityScope: viewer.actor, appliedFilters: { playerId: viewer.actor === "player" ? viewer.playerId ?? null : null } };
  if (!inScope(state, viewer) || viewer.actor === "spectator" || viewer.actor === "player" && (!viewer.playerId || !state.players.some((player) => player.id === viewer.playerId))) return { ...metadata, access: "denied", reason: "Named participation and attendance are unavailable for this viewer.", rows: [] };
  const records = reportRecords(state, match).filter((record) => record.status === "completed" || record.recordMode === "detailed_live" && (record.status === "incomplete" || record.status === "abandoned"));
  const players = viewer.actor === "player" ? state.players.filter((player) => player.id === viewer.playerId) : state.players;
  return { ...metadata, access: "permitted", reason: null, rows: players.map((player) => {
    const selected = records.filter((record) => record.selectedPlayerIds?.includes(player.id) && record.attendance?.[player.id] !== "not_selected");
    const evidence2 = selected.flatMap((record) => record.participation?.filter((item) => item.playerId === player.id) ?? []);
    const positionMs = {};
    for (const entry of evidence2) for (const [position, duration2] of Object.entries(entry.positionMs)) positionMs[position] = (positionMs[position] ?? 0) + duration2;
    const preferenceMs = { first: 0, second: 0, backup: 0, other: 0, unknown: 0 };
    for (const entry of evidence2) {
      if (entry.preferenceMs) for (const category of Object.keys(preferenceMs)) preferenceMs[category] += entry.preferenceMs[category];
      else preferenceMs.unknown += entry.playedMs;
    }
    const playingMs = evidence2.reduce((sum, entry) => sum + entry.playedMs, 0);
    const goalkeeperMs = positionMs.GK ?? 0;
    const games = attendanceSummary(selected.map((record) => record.attendance?.[player.id] ?? "not_recorded"));
    const trainingEvidence = state.trainingAttendance.filter((item) => item.eventStatus === "held" && item.expectedPlayerIds.includes(player.id));
    const training = attendanceSummary(trainingEvidence.map((item) => item.attendance[player.id] ?? "not_recorded"));
    const matchesPlayed = evidence2.filter((entry) => entry.playedMs > 0).length;
    const unknown = records.filter((record) => record.selectedPlayerIds === null).length;
    return {
      playerId: player.id,
      label: player.label,
      matchesSelected: selected.length,
      unknownHistoricalSelectionCount: unknown,
      matchesWithParticipationRecorded: evidence2.length,
      matchesWithAttendanceRecorded: games.attendanceRecordedCount,
      matchesPlayed,
      matchesAttended: games.attendedCount,
      playingMs,
      goalkeeperMs,
      outfieldMs: playingMs - goalkeeperMs,
      nonPrimaryGoalkeeperMs: evidence2.filter((entry) => entry.primaryWasGoalkeeper === false).reduce((sum, entry) => sum + (entry.positionMs.GK ?? 0), 0),
      goalkeeperMsWithUnknownPrimaryPreference: evidence2.filter((entry) => entry.primaryWasGoalkeeper === null).reduce((sum, entry) => sum + (entry.positionMs.GK ?? 0), 0),
      goalkeeperMsWithKnownPrimaryPreference: evidence2.filter((entry) => entry.primaryWasGoalkeeper !== null).reduce((sum, entry) => sum + (entry.positionMs.GK ?? 0), 0),
      positionMs,
      preferenceMs,
      minutesPerPlayedAppearance: matchesPlayed ? playingMs / matchesPlayed / 6e4 : null,
      games,
      training,
      gameRecords: selected.map((record) => ({ eventId: record.id, heldDate: record.playedDate, eventStatus: record.status, selection: "selected", actualAttendance: record.attendance?.[player.id] ?? "not_recorded", availabilityResponse: null })),
      trainingRecords: trainingEvidence.map((item) => ({ eventId: item.sessionId, heldDate: item.playedDate, eventStatus: "held", expected: true, actualAttendance: item.attendance[player.id] ?? "not_recorded", availabilityResponse: item.responses?.[player.id] ?? null })),
      coverageLabel: `Minutes recorded for ${evidence2.length} of ${records.length} recorded games; ${unknown} historical squad${unknown === 1 ? "" : "s"} not recorded.`,
      evidenceState: selected.some((record) => record.detailCompleteness === "review_required") ? "review_required" : unknown || selected.length !== evidence2.length ? "partial" : "complete"
    };
  }) };
}
function selectMatchReport(state, matchId, viewer, currentMatch = null) {
  if (!inScope(state, viewer)) return null;
  const record = reportRecords(state, currentMatch).find((item) => item.id === matchId);
  if (!record) return null;
  const shared = canShare(record, viewer.actor);
  const base = {
    matchId: record.id,
    playedDate: record.playedDate,
    opponent: record.opponent,
    status: record.status,
    clubId: state.clubId,
    teamId: state.teamId,
    seasonId: state.seasonId,
    projectionVersion: state.revision,
    sourceMatchRevision: record.sourceMatchRevision,
    asOf: currentMatch?.config.matchId === matchId ? observedMatchTime(currentMatch) : record.updatedAt,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    reportType: "match",
    policyId: record.publication.id,
    policyVersion: record.publication.version,
    classificationVersion: record.classificationVersion,
    fixtureClass: record.fixtureClass,
    appliedFilters: { matchId, playerId: viewer.actor === "player" ? viewer.playerId ?? null : null },
    visibilityScope: viewer.actor,
    recordMode: record.recordMode,
    detailCompleteness: record.detailCompleteness,
    revision: record.revision,
    score: shared ? clone2(record.finalScore) : null,
    halfTimeScore: shared ? clone2(record.halfTimeScore) : null,
    goals: shared ? clone2(record.goals) : [],
    unassignedGoalsFor: shared && record.finalScore ? record.finalScore.for - record.goals.filter((goal) => goal.beneficiary === "us").length : null,
    unassignedGoalsAgainst: shared && record.finalScore ? record.finalScore.against - record.goals.filter((goal) => goal.beneficiary === "opposition").length : null,
    suppressionReason: shared ? null : "Scores are not shared for this competition.",
    awardStatus: record.awardStatus
  };
  if (viewer.actor === "spectator") return base;
  const eligible2 = viewer.actor === "manager" ? state.players.map((player) => player.id) : viewer.playerId ? [viewer.playerId] : [];
  return {
    ...base,
    actualActiveDurationMs: record.actualActiveDurationMs,
    keeperPolicy: record.keeperPolicy,
    participation: record.participation?.filter((item) => eligible2.includes(item.playerId)).map(clone2) ?? null,
    attendance: record.attendance ? Object.fromEntries(Object.entries(record.attendance).filter(([id]) => eligible2.includes(id))) : null
  };
}

// packages/application/src/sync.ts
function effectiveEventTime(previous, next, event) {
  if (event.type === "policy.changed") return { ...event.effective };
  let effective;
  if (event.type === "goal.recorded" || event.type === "availability.changed" || event.type === "lineup.committed") effective = event.effective;
  if (event.type === "event.corrected") effective = event.replacement.effective;
  if ((event.type === "event.corrected" || event.type === "event.voided") && !effective) {
    const goal = previous.goals?.find((record) => record.eventId === event.targetEventId || record.latestEventId === event.targetEventId);
    const availability = previous.availabilityHistory?.find((record) => record.eventId === event.targetEventId || record.latestEventId === event.targetEventId);
    effective = goal?.effective ?? availability?.effective;
    if (!effective) {
      const target = previous.audit?.find((record) => record.eventId === event.targetEventId);
      effective = target?.effective;
    }
  }
  return effective ? { half: effective.half, halfElapsedMs: effective.halfElapsedMs, matchElapsedMs: effective.matchElapsedMs } : { half: next.half, halfElapsedMs: next.halfActiveMs, matchElapsedMs: next.matchActiveMs };
}

// packages/application/src/application.ts
function fixtureMatchConfig(preparation, snapshot) {
  const keepers = snapshot.profiles.filter(
    (player) => goalkeeperChoice(player) > 0
  );
  const config = {
    matchId: snapshot.fixtureId,
    players: snapshot.profiles.map((player) => ({
      id: player.playerId,
      displayName: player.displayName,
      goalkeeperChoice: goalkeeperChoice(player)
    })),
    selectedPlayerIds: [...snapshot.selectedPlayerIds],
    pitchPlaces: snapshot.fixture.format,
    plannedHalfDurationMs: snapshot.fixture.plannedHalfDurationMs,
    fixedKeeperId: keepers.length === 1 ? keepers[0].playerId : null,
    ...snapshot.matchPlanDraft ? { initialPolicyProposal: snapshot.matchPlanDraft.settings, initialLineupProposal: snapshot.matchPlanDraft.allocations.map((row) => ({ ...row })) } : {},
    initialAttendance: { ...snapshot.attendance },
    slots: snapshot.formation.slots.map((slot) => ({
      slotId: slot.id,
      position: slot.position,
      x: slot.x,
      y: slot.y,
      label: slot.label
    })),
    profileSnapshot: snapshot.profiles.map((profile) => ({
      playerId: profile.playerId,
      preferences: [...profile.preferences],
      eligiblePositions: [...profile.eligiblePositions],
      initials: profile.initials
    })),
    fixture: {
      opponent: snapshot.fixture.opponent,
      playedDate: snapshot.fixture.playedDate,
      kickoff: snapshot.fixture.kickoff,
      homeAway: snapshot.fixture.homeAway,
      seasonId: snapshot.seasonId,
      teamId: preparation.team.id,
      teamName: preparation.team.name,
      clubName: preparation.club.name
    }
  };
  return config;
}
var defaultPlayerId = romaFixture.players[0].id;

// packages/application/src/season-service.ts
var copy2 = (value) => JSON.parse(JSON.stringify(value));
var fail2 = (message, code2 = "INVALID_REQUEST", status = 422) => {
  throw new AccessError(code2, status, message);
};
function requireThat3(value, message) {
  if (!value) fail2(message);
}
function validId2(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}
function current(item, nowMs) {
  return item.revokedAt == null && (item.expiresAt == null || item.expiresAt > nowMs);
}
function source(context) {
  const { preparation, records } = context;
  requireThat3(Number.isSafeInteger(context.nowMs) && context.nowMs >= 0, "A trusted server time is required.");
  requireThat3(preparation.team.id === records.teamId && preparation.club.id === records.clubId, "Preparation and reports must belong to the same club and team.");
  const season = preparation.seasons.find((item) => item.id === records.seasonId);
  requireThat3(season, "The source season is unavailable.");
  requireThat3(context.community.seasons.some((item) => item.teamId === records.teamId && item.id === season.id), "The source community scope is inconsistent.");
  return season;
}
function visibleAccounts(context) {
  const season = source(context);
  const permitted = new Set(context.memberships.filter((item) => item.teamId === context.records.teamId && item.seasonId === season.id && current(item, context.nowMs)).map((item) => item.accountId));
  return context.accounts.filter((account2) => permitted.has(account2.accountId) && account2.status === "active");
}
function verifiedAdult(account2) {
  return account2.status === "active" && account2.identityClassification === "adult_individual" && account2.adultVerified && account2.strongAuthEnrolled;
}
function activeManagers(context) {
  return [...new Set(context.memberships.filter((item) => item.teamId === context.records.teamId && item.role === "manager" && current(item, context.nowMs) && context.accounts.find((account2) => account2.accountId === item.accountId)?.status !== "disabled").map((item) => item.accountId))];
}
function seasonAccessEndsAtMs(startYear) {
  const midnightUtc = Date.UTC(startYear + 1, 8, 1);
  const offset = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", timeZoneName: "shortOffset" }).formatToParts(midnightUtc).find((part) => part.type === "timeZoneName")?.value;
  const match = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(offset ?? "");
  requireThat3(match, "The season boundary timezone is unavailable.");
  const minutes = match[1] ? (match[1] === "+" ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3] ?? 0)) : 0;
  return midnightUtc - minutes * 6e4;
}
function seasonRolloverOptions(context) {
  const season = source(context), { principal, memberships, records, preparation, nowMs } = context;
  assertTeamRole(principal, memberships, records.teamId, season.id, ["administrator", "manager"], nowMs);
  assertAdultAuthority(principal, false, nowMs);
  const accounts = visibleAccounts(context);
  const currentRows = memberships.filter((item) => item.teamId === records.teamId && item.seasonId === season.id && current(item, nowMs));
  const administrator = currentRows.some((item) => item.accountId === principal.accountId && item.role === "administrator");
  const existingNextSeasonId = context.existingSeasons.find((item) => item.teamId === records.teamId && item.startYear === season.startYear + 1)?.id ?? null;
  return {
    revision: preparation.revision,
    sourceSeasonId: season.id,
    sourceSeason: copy2(season),
    canRollover: administrator && principal.strongAuth && !existingNextSeasonId && principal.authenticatedAt <= nowMs + 3e4 && nowMs - principal.authenticatedAt <= 3e5,
    existingNextSeasonId,
    requiredAuthority: "administrator_with_recent_stronger_sign_in",
    nextSeason: { startYear: season.startYear + 1, ...seasonBounds(season.startYear + 1) },
    activeManagerAccountIds: activeManagers(context),
    managerCandidates: accounts.filter(verifiedAdult).map((account2) => ({ accountId: account2.accountId, label: account2.label, currentManager: currentRows.some((item) => item.accountId === account2.accountId && item.role === "manager"), administrator: currentRows.some((item) => item.accountId === account2.accountId && item.role === "administrator") })),
    playerCandidates: currentRows.filter((item) => item.role === "player" && item.playerId && accounts.some((account2) => account2.accountId === item.accountId)).flatMap((item) => {
      const profile = preparation.profiles.find((profile2) => profile2.seasonId === season.id && profile2.playerId === item.playerId && profile2.active);
      return profile ? [{ accountId: item.accountId, playerId: profile.playerId, label: profile.displayName }] : [];
    }),
    spectatorRenewal: "individual_explicit_invitation_only"
  };
}
function configurationServiceView(input) {
  assertTeamRole(input.principal, input.memberships, input.preparation.team.id, input.seasonId, ["administrator", "manager"], input.nowMs);
  assertAdultAuthority(input.principal, false, input.nowMs);
  const { version, revision, club, team, activeSeasonId, seasons } = input.preparation;
  return copy2({ version, revision, club, team, activeSeasonId, seasons });
}
function applyConfigurationServiceCommand(input) {
  const { principal, memberships, preparation, seasonId, nowMs, command } = input;
  requireThat3(command?.type === "club.updated" || command?.type === "team.updated", "Configuration accepts only club or team settings.");
  assertTeamRole(principal, memberships, preparation.team.id, seasonId, command.type === "club.updated" ? ["administrator"] : ["administrator", "manager"], nowMs);
  assertAdultAuthority(principal, command.type === "club.updated", nowMs);
  return reducePreparation(preparation, command);
}
function planSeasonRollover(context) {
  const old = source(context), { principal, memberships, accounts, preparation, records, community, command, nowMs } = context;
  assertTeamRole(principal, memberships, records.teamId, old.id, ["administrator"], nowMs);
  requireThat3(Number.isSafeInteger(principal.authenticatedAt) && principal.authenticatedAt >= 0, "Verified authentication time is required.");
  assertAdultAuthority(principal, true, nowMs);
  requireThat3(command?.type === "season.rolled_over" && validId2(command.id) && validId2(command.idForSeason), "Use valid command and season identifiers.");
  requireThat3(command.expectedPreparationRevision === preparation.revision, "The source preparation changed. Refresh before creating its next season.");
  requireThat3(command.startYear === old.startYear + 1 && command.startYear <= 2100 && command.startYear >= 2020, "Create the immediately following September-to-August season.");
  requireThat3(command.idForSeason !== old.id && !preparation.seasons.some((item) => item.id === command.idForSeason || item.startYear === command.startYear) && !memberships.some((item) => item.teamId === records.teamId && item.seasonId === command.idForSeason), "That destination season already exists.");
  requireThat3(!context.existingSeasons.some((item) => item.teamId === records.teamId && (item.id === command.idForSeason || item.startYear === command.startYear)), "That destination season or season year already exists.");
  requireThat3(command.confirmSpectatorRenewal === true && typeof command.copyPlayers === "boolean", "Acknowledge that spectators receive no automatic new-season access.");
  requireThat3(Array.isArray(command.managerAccountIds) && Array.isArray(command.administratorAccountIds) && Array.isArray(command.playerAssignments), "Explicit manager, administrator and player assignments are required.");
  requireThat3(command.playerAssignments.length <= 2e3 && command.playerAssignments.every((item) => item && typeof item === "object" && validId2(item.accountId) && validId2(item.playerId)), "Player assignments must be a bounded list of known identities.");
  const unique3 = (items) => items.every(validId2) && new Set(items).size === items.length;
  requireThat3(command.managerAccountIds.length >= 1 && command.managerAccountIds.length <= 4 && unique3(command.managerAccountIds), "Select one to four distinct verified adult managers.");
  requireThat3(command.administratorAccountIds.length >= 1 && unique3(command.administratorAccountIds), "Explicitly retain at least one current verified administrator.");
  const options = seasonRolloverOptions(context);
  for (const id of command.managerAccountIds) requireThat3(options.managerCandidates.some((account2) => account2.accountId === id), "Each manager must be an active verified adult with stronger authentication already enrolled in this team.");
  for (const id of command.administratorAccountIds) requireThat3(options.managerCandidates.some((account2) => account2.accountId === id && account2.administrator), "Only a current verified administrator can retain administrator authority in the new season.");
  if ((/* @__PURE__ */ new Set([...activeManagers(context), ...command.managerAccountIds])).size > 4) fail2("A team can have at most four active manager accounts. Revoke departed manager authority explicitly before adding another account.", "MANAGER_LIMIT", 409);
  requireThat3(new Set(command.playerAssignments.map((item) => item.accountId)).size === command.playerAssignments.length && new Set(command.playerAssignments.map((item) => item.playerId)).size === command.playerAssignments.length, "Player assignments must retain one distinct known account for each player.");
  requireThat3(command.copyPlayers || command.playerAssignments.length === 0, "Copy the relevant player profiles before assigning their existing accounts.");
  for (const assignment of command.playerAssignments) requireThat3(validId2(assignment.accountId) && validId2(assignment.playerId) && options.playerCandidates.some((item) => item.accountId === assignment.accountId && item.playerId === assignment.playerId), "New player membership must preserve the source account/player binding. Use activation for new identity links.");
  const season = { id: command.idForSeason, startYear: command.startYear, ...seasonBounds(command.startYear), spectatorRenewalRequired: true };
  const newMemberships = [
    ...command.managerAccountIds.map((accountId) => ({ accountId, teamId: records.teamId, seasonId: season.id, role: "manager" })),
    ...command.administratorAccountIds.map((accountId) => ({ accountId, teamId: records.teamId, seasonId: season.id, role: "administrator" })),
    ...command.playerAssignments.map((item) => ({ ...item, teamId: records.teamId, seasonId: season.id, role: "player" }))
  ];
  const sourceProfiles = preparation.profiles.filter((profile) => profile.seasonId === old.id && profile.active);
  requireThat3(sourceProfiles.length <= 2e3 && new Set(sourceProfiles.map((profile) => profile.playerId)).size === sourceProfiles.length, "The source roster must have one distinct active profile for each player.");
  const profiles = command.copyPlayers ? sourceProfiles.map((profile, index) => ({ ...copy2(profile), id: `profile-${season.id.slice(0, 60)}-${String(index + 1).padStart(4, "0")}`, seasonId: season.id })) : [];
  const nextPreparation = { ...copy2(preparation), revision: 0, activeSeasonId: season.id, seasons: [season], profiles, fixtures: [], training: [], snapshots: [], matchPlans: [], appliedCommands: {}, audit: [{ id: command.id, revision: 0, type: "season.created_from_explicit_assignments" }] };
  const nextRecords = {
    ...copy2(records),
    revision: 0,
    seasonId: season.id,
    seasonLabel: season.label,
    startsOn: season.startDate,
    endsOn: season.endDate,
    players: profiles.map((profile) => ({ id: profile.playerId, label: profile.displayName })),
    liveMatch: { matchId: "", playedDate: season.startDate, opponent: "", homeAway: "home", fixtureClass: "unclassified" },
    results: [],
    trainingAttendance: [],
    audit: [],
    appliedCommands: {}
  };
  const assignedIds = new Set(newMemberships.map((item) => item.accountId));
  const nextCommunity = {
    ...copy2(community),
    revision: 0,
    accounts: accounts.filter((account2) => assignedIds.has(account2.accountId)).map((account2) => ({ id: account2.accountId, label: account2.label, classification: account2.identityClassification === "child_shared" ? "child_shared" : "adult_individual", adultVerified: account2.adultVerified })),
    memberships: newMemberships.filter((item) => item.role === "manager" || item.role === "player").map((item) => ({ accountId: item.accountId, teamId: item.teamId, seasonId: item.seasonId, role: item.role, ...item.playerId ? { playerId: item.playerId } : {}, active: true })),
    seasons: [{ id: season.id, teamId: records.teamId, label: season.label, teamLabel: preparation.team.name, accessEndsAtMs: seasonAccessEndsAtMs(command.startYear) }],
    invitations: [],
    grants: [],
    matches: [],
    ballots: [],
    awards: [],
    photos: [],
    concerns: [],
    privacyRequests: [],
    appliedCommands: {},
    hiddenUploaders: community.hiddenUploaders.filter((item) => assignedIds.has(item.accountId)).map(copy2),
    preferences: Object.fromEntries(Object.entries(community.preferences).filter(([accountId]) => assignedIds.has(accountId)).map(([id, value]) => [id, copy2(value)])),
    audit: [{ id: command.id, actorAccountId: principal.accountId, action: "season.created_from_explicit_assignments", atMs: nowMs }]
  };
  return {
    preparation: nextPreparation,
    records: nextRecords,
    community: nextCommunity,
    memberships: newMemberships,
    receipt: { revision: 0, seasonId: season.id, season, sourceSeasonId: old.id, commandId: command.id, managerAccountIds: [...command.managerAccountIds], administratorAccountIds: [...command.administratorAccountIds], playerAssignmentCount: command.playerAssignments.length, spectatorGrantCount: 0, spectatorRenewal: "individual_explicit_invitation_only" }
  };
}

// packages/application/src/report-community.ts
var empty = (communityStatus, communityRevision = null) => ({ communityStatus, communityRevision, award: null, publishedAlbum: null });
function composeReportCommunity(report, accountId, source2) {
  if (report.suppressionReason) return empty("withheld");
  if (!source2 || source2.accountId !== accountId || source2.teamId !== report.teamId || source2.seasonId !== report.seasonId || source2.audience !== report.visibilityScope || report.visibilityScope === "player" && source2.playerId !== report.appliedFilters.playerId || !Number.isSafeInteger(source2.revision) || source2.revision < 0 || !source2.view.allowed) return empty("unavailable");
  const contexts = source2.view.matches.filter((item) => item.id === report.matchId);
  if (contexts.length > 1) return empty("unavailable");
  if (contexts.length === 0) return empty("not_recorded", source2.revision);
  const match = contexts[0];
  if (match.sharingAllowed !== true) return empty("withheld", source2.revision);
  const award = match.award;
  const times = award ? [award.voteCutoffAtMs, award.finalisationDeadlineAtMs, award.finalisedAtMs] : [];
  if (award && (award.matchId !== report.matchId || !["winners", "no_valid_votes"].includes(award.result) || !times.every((time3) => Number.isSafeInteger(time3) && time3 >= 0) || award.finalisationDeadlineAtMs < award.voteCutoffAtMs || award.deadlineMissed !== award.finalisedAtMs > award.finalisationDeadlineAtMs || !Array.isArray(award.winnerLabels) || award.winnerLabels.some((label) => typeof label !== "string" || !label.trim() || label.length > 120) || (award.result === "no_valid_votes" ? award.winnerLabels.length !== 0 : award.winnerLabels.length === 0))) return empty("unavailable");
  const photos = new Set(source2.view.gallery.filter((photo) => photo.matchId === report.matchId && typeof photo.id === "string" && photo.id.length > 0).map((photo) => photo.id));
  return {
    communityStatus: "available",
    communityRevision: source2.revision,
    award: award ? { matchId: report.matchId, result: award.result, winnerLabels: [...award.winnerLabels], voteCutoffAtMs: award.voteCutoffAtMs, finalisationDeadlineAtMs: award.finalisationDeadlineAtMs, finalisedAtMs: award.finalisedAtMs, deadlineMissed: award.deadlineMissed } : null,
    publishedAlbum: { matchId: report.matchId, photoCount: photos.size }
  };
}

// packages/application/src/records-service.ts
var copy3 = (value) => JSON.parse(JSON.stringify(value));
function fail3(message, code2 = "INVALID_REQUEST", status = 422) {
  throw new AccessError(code2, status, message);
}
function requireThat4(value, message) {
  if (!value) fail3(message);
}
function object(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function string(value, max = 150) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function fields(value, permitted) {
  requireThat4(Object.keys(value).every((key) => permitted.includes(key)), "The request includes unsupported fields.");
}
function integer2(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
var fixtureClasses = ["development", "friendly", "trophy", "unclassified"];
function score(value) {
  if (value === null) return null;
  requireThat4(object(value), "Provide a known score or explicitly leave it not recorded.");
  fields(value, ["for", "against"]);
  requireThat4(integer2(value.for, 999) && integer2(value.against, 999), "Scores must be nonnegative whole goals.");
  return { for: value.for, against: value.against };
}
function parseHistoricalResultInput(value) {
  requireThat4(object(value), "Historical details are required.");
  fields(value, ["playedDate", "recordedKickoff", "sameDayOrder", "opponent", "homeAway", "fixtureClass", "status", "specialOutcome", "finalScore", "halfTimeScore", "goals"]);
  requireThat4(string(value.playedDate, 10) && string(value.opponent, 120), "A played date and opposition are required.");
  requireThat4(value.recordedKickoff === null || string(value.recordedKickoff, 50), "Known kickoff needs a timestamp; use null for unknown.");
  requireThat4(value.sameDayOrder === null || integer2(value.sameDayOrder, 100), "Same-day ordering must be a whole number or unknown.");
  requireThat4(["home", "away", "neutral"].includes(value.homeAway) && fixtureClasses.includes(value.fixtureClass), "Choose a valid venue side and fixture class.");
  requireThat4(["completed", "abandoned", "cancelled", "postponed", "incomplete"].includes(value.status) && ["ordinary", "awarded", "forfeit", "shootout"].includes(value.specialOutcome), "Choose a known match status and outcome category.");
  requireThat4(Array.isArray(value.goals) && value.goals.length <= 1e3, "Known goal attribution must be a bounded list.");
  const goals = value.goals.map((item) => {
    requireThat4(object(item), "A known goal must be an object.");
    fields(item, ["id", "beneficiary", "isOwnGoal", "scorerPlayerId", "goalType", "half", "halfElapsedMs"]);
    requireThat4(string(item.id) && ["us", "opposition"].includes(item.beneficiary) && typeof item.isOwnGoal === "boolean", "Known goals require identity, beneficiary and explicit own-goal classification.");
    requireThat4(item.scorerPlayerId === null || string(item.scorerPlayerId), "Use a saved player identity or unknown scorer.");
    requireThat4(item.goalType === null || ["open_play", "free_kick", "penalty"].includes(item.goalType), "Use a known goal type or unknown.");
    requireThat4(item.half === null || item.half === 1 || item.half === 2, "Use a known half or unknown.");
    requireThat4(item.halfElapsedMs === null || integer2(item.halfElapsedMs, 864e5), "Known active goal time must be nonnegative whole milliseconds.");
    return { id: item.id, beneficiary: item.beneficiary, isOwnGoal: item.isOwnGoal, scorerPlayerId: item.scorerPlayerId, goalType: item.goalType, half: item.half, halfElapsedMs: item.halfElapsedMs };
  });
  return { playedDate: value.playedDate, recordedKickoff: value.recordedKickoff, sameDayOrder: value.sameDayOrder, opponent: value.opponent.trim(), homeAway: value.homeAway, fixtureClass: value.fixtureClass, status: value.status, specialOutcome: value.specialOutcome, finalScore: score(value.finalScore), halfTimeScore: score(value.halfTimeScore), goals };
}
function recordsServiceViewer(input) {
  const { principal, memberships, state, nowMs, requestedRole } = input;
  requireThat4(Number.isSafeInteger(nowMs) && nowMs >= 0, "Trusted server time is required.");
  if (requestedRole && !["manager", "player", "spectator"].includes(requestedRole)) fail3("Unknown report audience.");
  const permitted = memberships.filter((item) => item.accountId === principal.accountId && item.teamId === state.teamId && item.seasonId === state.seasonId && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > nowMs));
  const preferred = requestedRole ?? (permitted.some((item) => item.role === "manager") ? "manager" : permitted.some((item) => item.role === "player") ? "player" : "spectator");
  const membership = assertTeamRole(principal, memberships, state.teamId, state.seasonId, [preferred], nowMs);
  if (preferred === "manager") assertAdultAuthority(principal, false, nowMs);
  if (preferred === "player" && !membership.playerId) fail3("The current membership has no own-player binding.", "NOT_FOUND", 404);
  return { actor: preferred, ...preferred === "player" ? { playerId: membership.playerId } : {}, teamId: state.teamId, seasonId: state.seasonId };
}
function accepted(input, matchId) {
  const row = input.acceptedMatches.find((item) => item.teamId === input.state.teamId && item.seasonId === input.state.seasonId && item.match.config.matchId === matchId);
  if (!row) return null;
  if (row.match.config.fixture && (row.match.config.fixture.teamId !== row.teamId || row.match.config.fixture.seasonId !== row.seasonId)) fail3("Accepted fixture scope is inconsistent.", "NOT_FOUND", 404);
  return row.match;
}
function contextFor(state, match, fixtureClass) {
  const fixture = match.config.fixture;
  if (!fixture) return state.liveMatch.matchId === match.config.matchId ? { ...state.liveMatch, fixtureClass: fixtureClass ?? state.liveMatch.fixtureClass } : null;
  return { matchId: match.config.matchId, playedDate: fixture.playedDate, opponent: fixture.opponent, homeAway: fixture.homeAway, fixtureClass: fixtureClass ?? state.results.find((record) => record.id === match.config.matchId)?.fixtureClass ?? "unclassified" };
}
function recordsServiceView(input) {
  const viewer = recordsServiceViewer(input), { state, nowMs } = input;
  const activeMatch = accepted(input, state.liveMatch.matchId);
  const generatedAt = new Date(nowMs).toISOString();
  const stamp = (value) => ({ ...value, generatedAt });
  const ids = new Set(state.results.map((record) => record.id));
  for (const row of input.acceptedMatches)
    if (row.teamId === state.teamId && row.seasonId === state.seasonId && row.match.status !== "preparation") ids.add(row.match.config.matchId);
  const reports = [...ids].map((id) => {
    const match = accepted(input, id);
    const details = match ? contextFor(state, match, id === state.liveMatch.matchId ? state.liveMatch.fixtureClass : void 0) : null;
    return selectMatchReport(details ? { ...state, liveMatch: details } : state, id, viewer, match);
  }).filter((item) => item !== null);
  const common = { revision: state.revision, results: stamp(selectSeasonResults(state, viewer)), participation: stamp(selectParticipationReport(state, activeMatch, viewer)), matches: reports.map((report) => stamp({ ...report, ...composeReportCommunity(report, input.principal.accountId, input.community), goals: report.goals.map((goal) => ({ ...goal, scorerLabel: goal.scorerPlayerId ? state.players.find((player) => player.id === goal.scorerPlayerId)?.label ?? null : null })) })) };
  if (viewer.actor !== "manager") return common;
  return {
    ...common,
    editableState: copy3(state),
    activeMatch: activeMatch ? copy3(activeMatch) : null,
    contexts: input.acceptedMatches.filter((row) => row.teamId === state.teamId && row.seasonId === state.seasonId).flatMap((row) => {
      const match = accepted(input, row.match.config.matchId);
      const details = contextFor(state, match, state.liveMatch.matchId === match.config.matchId ? state.liveMatch.fixtureClass : void 0);
      return details ? [{ ...details, status: match.status, sourceMatchRevision: match.revision, archivedSourceMatchRevision: state.results.find((record) => record.id === match.config.matchId)?.sourceMatchRevision ?? null }] : [];
    })
  };
}
function applyRecordsServiceCommand(input) {
  const { state, command, principal, memberships, nowMs } = input;
  assertCanManageTeam(principal, memberships, state.teamId, state.seasonId, nowMs);
  if (input.requestedRole && input.requestedRole !== "manager") fail3("The selected audience cannot edit manager records.", "NOT_FOUND", 404);
  requireThat4(command && typeof command === "object" && string(command.commandId) && /^[A-Za-z0-9_-]+$/.test(command.commandId), "A stable record command identity is required.");
  let bound;
  const base = { commandId: command.commandId, at: new Date(nowMs).toISOString(), actor: "manager" };
  switch (command.type) {
    case "historical.add":
      requireThat4(string(command.recordId), "A historical match identity is required.");
      bound = { ...base, type: command.type, recordId: command.recordId, input: parseHistoricalResultInput(command.input), acknowledgePossibleDuplicate: command.acknowledgePossibleDuplicate === true };
      break;
    case "historical.correct":
      requireThat4(string(command.recordId) && integer2(command.expectedRevision) && string(command.reason, 500), "Review the current record revision and provide a correction reason.");
      bound = { ...base, type: command.type, recordId: command.recordId, expectedRevision: command.expectedRevision, reason: command.reason.trim(), input: parseHistoricalResultInput(command.input) };
      break;
    case "live.context.set": {
      requireThat4(command.details && typeof command.details === "object" && string(command.details.matchId) && fixtureClasses.includes(command.details.fixtureClass), "Choose a prepared match and an explicit fixture class.");
      const match = accepted(input, command.details.matchId);
      if (!match) fail3("The prepared match is outside this team and season.", "NOT_FOUND", 404);
      const details = contextFor(state, match, command.details.fixtureClass);
      requireThat4(details && details.playedDate === command.details.playedDate && details.opponent === command.details.opponent && details.homeAway === command.details.homeAway, "Match report context must retain the accepted fixture date, opponent and home/away side.");
      bound = { ...base, type: command.type, details };
      break;
    }
    case "live.archive": {
      const matchId = "matchId" in command ? command.matchId : command.match?.config?.matchId;
      const expectedRevision = "expectedSourceMatchRevision" in command ? command.expectedSourceMatchRevision : command.match?.revision;
      requireThat4(string(matchId) && integer2(expectedRevision), "Archive the reviewed accepted match identity and source revision.");
      const match = accepted(input, matchId);
      if (!match) fail3("The accepted match is outside this team and season.", "NOT_FOUND", 404);
      if (match.revision !== expectedRevision) fail3("The accepted match changed. Refresh its report before archiving.", "STALE_REVISION", 409);
      const old = state.results.find((record) => record.id === matchId);
      if (old && old.fixtureClass !== state.liveMatch.fixtureClass) requireThat4(string(command.reason, 500), "Explain the changed fixture classification before re-archiving.");
      bound = { ...base, type: command.type, match, ...command.reason ? { reason: command.reason } : {} };
      break;
    }
    case "participation.exception.noted":
      requireThat4(string(command.recordId) && string(command.playerId) && integer2(command.expectedRevision) && string(command.reason, 500), "Review the saved participation and explain the exception.");
      bound = { ...base, type: command.type, recordId: command.recordId, playerId: command.playerId, expectedRevision: command.expectedRevision, reason: command.reason.trim() };
      break;
    case "publication.set":
      fail3("A manager request cannot approve the unresolved competition policy. Independent operator evidence is required.", "POLICY_APPROVAL_REQUIRED", 503);
      break;
    case "training.evidence.replace":
      fail3("Training report evidence is projected from the authorised preparation service.", "SERVICE_OWNED_PROJECTION", 403);
      break;
    default:
      fail3("Unsupported record command.");
  }
  return reduceRecords(state, bound);
}
function policyFingerprint(state) {
  const source2 = JSON.stringify(state.results.map((record) => [record.id, record.classificationVersion, record.fixtureClass, record.publication]));
  let hash = 2166136261;
  for (const character of source2) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return `policy-v1-${hash.toString(16).padStart(8, "0")}`;
}
function recordsServiceExport(input) {
  const viewer = recordsServiceViewer(input), view = recordsServiceView(input), { request, state, nowMs } = input;
  requireThat4(request && ["season", "match"].includes(request.kind) && ["json", "csv"].includes(request.format), "Choose a report and supported export format.");
  const fingerprint = policyFingerprint(state);
  if (request.expectedProjectionVersion !== void 0 && request.expectedProjectionVersion !== state.revision || request.expectedPolicyFingerprint !== void 0 && request.expectedPolicyFingerprint !== fingerprint) fail3("This report or audience policy changed. Refresh before exporting.", "STALE_PROJECTION", 409);
  const matches = request.kind === "match" ? view.matches.filter((report) => report.matchId === request.matchId) : view.matches;
  if (request.kind === "match" && matches.length !== 1) fail3("That permitted match report is unavailable.", "NOT_FOUND", 404);
  const generatedAt = new Date(nowMs).toISOString();
  const document = {
    schemaVersion: 1,
    reportType: request.kind,
    teamId: state.teamId,
    seasonId: state.seasonId,
    audience: viewer.actor,
    appliedFilters: { matchId: request.kind === "match" ? request.matchId : null, playerId: viewer.actor === "player" ? viewer.playerId : null },
    generatedAt,
    asOf: request.kind === "match" ? matches[0].asOf : view.participation.asOf,
    projectionVersion: state.revision,
    policyFingerprint: fingerprint,
    policyVersions: state.results.filter((record) => request.kind === "season" || matches.some((report) => report.matchId === record.id)).map((record) => ({ matchId: record.id, policyId: record.publication.id, policyVersion: record.publication.version, classificationVersion: record.classificationVersion })),
    dataCoverage: { participationAccess: view.participation.access, attendancePolicy: view.participation.rows[0]?.games.policy ?? "proposed_known_records_excused_included", includesInventedHistoricalMinutes: false },
    ...request.kind === "season" ? { results: view.results, ...viewer.actor !== "spectator" ? { participation: view.participation } : {} } : {},
    matches
  };
  const csvCell = (value) => {
    let text2 = value === null || value === void 0 ? "Not recorded" : typeof value === "object" ? JSON.stringify(value) : String(value);
    if (/^[\t\r ]*[=+\-@]/.test(text2)) text2 = `'${text2}`;
    return `"${text2.replaceAll('"', '""')}"`;
  };
  const rows = [["section", "identity", "field", "value"], ["metadata", "report", "teamId", state.teamId], ["metadata", "report", "seasonId", state.seasonId], ["metadata", "report", "audience", viewer.actor], ["metadata", "report", "projectionVersion", state.revision], ["metadata", "report", "policyFingerprint", fingerprint], ["metadata", "report", "generatedAt", generatedAt], ["metadata", "report", "asOf", document.asOf], ["metadata", "report", "attendancePolicy", document.dataCoverage.attendancePolicy]];
  if (request.kind === "season") for (const [field, value] of Object.entries(view.results)) rows.push(["results", "season", field, value]);
  if (request.kind === "season" && viewer.actor !== "spectator") for (const row of view.participation.rows) for (const [field, value] of Object.entries(row)) rows.push(["participation", row.playerId, field, value]);
  for (const report of matches) for (const [field, value] of Object.entries(report)) rows.push(["match", report.matchId, field, value]);
  const body = request.format === "json" ? JSON.stringify(document, null, 2) : "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  return { kind: "records-export", format: request.format, contentType: request.format === "json" ? "application/json" : "text/csv; charset=utf-8", fileName: `longball-${state.teamId.replace(/[^A-Za-z0-9_-]/g, "_")}-${state.seasonId.replace(/[^A-Za-z0-9_-]/g, "_")}-${request.kind}.${request.format}`, body, teamId: state.teamId, seasonId: state.seasonId, audience: viewer.actor, projectionVersion: state.revision, policyFingerprint: fingerprint, generatedAt };
}

// apps/api/src/trusted-time.ts
var integer3 = (value) => Number.isSafeInteger(value) && value >= 0;
var continuous = (value) => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
function checkPolicy(policy) {
  if (!policy.id || ![
    policy.serverClockUncertaintyMs,
    policy.maximumRoundTripMs,
    policy.maximumMappingAgeMs,
    policy.maximumUncertaintyMs,
    policy.maximumDriftPpm
  ].every(integer3) || !policy.maximumRoundTripMs || !policy.maximumMappingAgeMs) {
    throw new Error("A versioned, explicit trusted-time policy is required.");
  }
}
function issueClockChallenge(scope, id, issuedAtMs, policy) {
  checkPolicy(policy);
  if (!id || !scope.accountId || !scope.deviceId || !scope.matchId || !scope.continuityId || !integer3(issuedAtMs) || !integer3(scope.controllerEpoch) || scope.controllerEpoch === 0) {
    throw new Error(
      "The clock challenge requires a current controller and continuous-clock identity."
    );
  }
  return {
    ...scope,
    id,
    issuedAtMs,
    expiresAtMs: issuedAtMs + policy.maximumRoundTripMs,
    policyId: policy.id
  };
}
function acknowledgeClockChallenge(challenge, sample, serverReceivedAtMs, policy) {
  checkPolicy(policy);
  const { receivedMonotonicMs, sentMonotonicMs } = sample;
  if (challenge.policyId !== policy.id || !integer3(serverReceivedAtMs) || !continuous(receivedMonotonicMs) || !continuous(sentMonotonicMs) || sentMonotonicMs < receivedMonotonicMs || serverReceivedAtMs < challenge.issuedAtMs || serverReceivedAtMs > challenge.expiresAtMs || sentMonotonicMs - receivedMonotonicMs > serverReceivedAtMs - challenge.issuedAtMs) {
    throw new Error(
      "The clock exchange expired or its continuous-clock evidence is inconsistent."
    );
  }
  const mapping = {
    accountId: challenge.accountId,
    deviceId: challenge.deviceId,
    matchId: challenge.matchId,
    controllerEpoch: challenge.controllerEpoch,
    continuityId: challenge.continuityId,
    challengeId: challenge.id,
    policyId: policy.id,
    establishedAtMs: serverReceivedAtMs,
    sampleMonotonicMs: sentMonotonicMs,
    offsetMinimumMs: challenge.issuedAtMs - receivedMonotonicMs - policy.serverClockUncertaintyMs,
    offsetMaximumMs: serverReceivedAtMs - sentMonotonicMs + policy.serverClockUncertaintyMs,
    validUntilMs: serverReceivedAtMs + policy.maximumMappingAgeMs
  };
  if ((mapping.offsetMaximumMs - mapping.offsetMinimumMs) / 2 > policy.maximumUncertaintyMs)
    throw new Error(
      "The clock exchange exceeds the approved uncertainty bound."
    );
  return mapping;
}
function mapContinuousInstant(mapping, scope, monotonicMs, serverNowMs, policy) {
  checkPolicy(policy);
  if (mapping.policyId !== policy.id || [
    "accountId",
    "deviceId",
    "matchId",
    "controllerEpoch",
    "continuityId"
  ].some((key) => scope[key] !== mapping[key])) {
    return {
      quality: "review_required",
      reason: "The clock mapping belongs to another controller, device, match or continuity session."
    };
  }
  if (!continuous(monotonicMs) || !integer3(serverNowMs) || serverNowMs < mapping.establishedAtMs)
    return {
      quality: "review_required",
      reason: "The server or continuous-clock observation is invalid."
    };
  const distance = Math.abs(monotonicMs - mapping.sampleMonotonicMs);
  if (distance > policy.maximumMappingAgeMs)
    return {
      quality: "review_required",
      reason: "The event exceeds the approved extrapolation duration."
    };
  const minimum = monotonicMs + mapping.offsetMinimumMs;
  const maximum = monotonicMs + mapping.offsetMaximumMs;
  if (minimum < mapping.establishedAtMs - policy.maximumRoundTripMs || maximum > mapping.validUntilMs || minimum > serverNowMs) {
    return {
      quality: "review_required",
      reason: "The event lies outside the original mapping lifetime or in the future."
    };
  }
  const utcMs = Math.round((minimum + maximum) / 2);
  const uncertaintyMs = Math.ceil(
    Math.max(utcMs - minimum, maximum - utcMs) + distance * policy.maximumDriftPpm / 1e6
  );
  if (uncertaintyMs > policy.maximumUncertaintyMs)
    return {
      quality: "review_required",
      reason: "Propagated clock uncertainty exceeds the approved bound."
    };
  return {
    quality: "trusted",
    utcMs,
    uncertaintyMs,
    mappingId: mapping.challengeId,
    policyId: mapping.policyId
  };
}

// packages/application/src/reconciliation.ts
var Q08_RECONCILIATION_POLICY = {
  status: "unapproved",
  policyId: "q08-reconciliation-authority-unapproved",
  decisionRequired: "Confirm who may approve unresolved history reconciliation: importing old-device evidence, marking submissions duplicate, or retaining a disputed history. Define the reviewer authority and required evidence; assigned-manager access alone does not approve this policy."
};
var identifier2 = /^[a-zA-Z0-9_-]{1,120}$/;
function canonicalReviewJson(value) {
  if (Array.isArray(value))
    return `[${value.map(canonicalReviewJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value).filter(([, item]) => item !== void 0).sort(([left], [right]) => left.localeCompare(right)).map(
      ([key, item]) => `${JSON.stringify(key)}:${canonicalReviewJson(item)}`
    ).join(",")}}`;
  return JSON.stringify(value);
}
function checkpointSample(state, recordedAtMs) {
  return state.anchor ? { ...state.anchor.sample } : {
    monotonicMs: 0,
    sessionId: "review-preview-only",
    wallTimeMs: recordedAtMs
  };
}
function reconciliationSummary(state) {
  const minutes = playerMinutes(state, checkpointSample(state, 0));
  const occupiedPlayerMs = minutes.reduce(
    (sum, item) => sum + item.playingMs,
    0
  );
  const capacityPlayerMs = state.config.pitchPlaces * state.matchActiveMs;
  return {
    revision: state.revision,
    status: state.status,
    half: state.half,
    halfActiveMs: state.halfActiveMs,
    matchActiveMs: state.matchActiveMs,
    firstHalfDurationMs: state.firstHalfDurationMs,
    score: { ...state.score },
    halfTimeScore: state.halfTimeScore ? { ...state.halfTimeScore } : null,
    playerMinutes: minutes,
    occupiedPlayerMs,
    capacityPlayerMs,
    vacancyPlayerMs: capacityPlayerMs - occupiedPlayerMs
  };
}
function assertParticipationConservation(state) {
  const selected = new Set(state.config.selectedPlayerIds);
  const firstEnd = state.firstHalfDurationMs ?? (state.half === 1 ? state.matchActiveMs : 0);
  for (const interval of state.intervals) {
    if (!selected.has(interval.playerId) || !Number.isSafeInteger(interval.startMs) || !Number.isSafeInteger(interval.endMs) || interval.startMs < 0 || interval.endMs <= interval.startMs || interval.endMs > state.matchActiveMs || interval.half === 1 && interval.endMs > firstEnd || interval.half === 2 && interval.startMs < firstEnd)
      throw new Error(
        "Participation contains invalid coordinates, identity or half boundaries."
      );
    if (interval.state === "playing" !== Boolean(interval.position && interval.slotId))
      throw new Error(
        "Playing intervals need one saved position and occupied slot; bench/unavailable intervals cannot occupy a place."
      );
  }
  for (const playerId of selected) {
    const intervals = state.intervals.filter((item) => item.playerId === playerId).sort((a, b) => a.startMs - b.startMs || a.half - b.half);
    let end = 0;
    for (const interval of intervals) {
      if (interval.startMs !== end)
        throw new Error(
          `Participation for ${playerId} has an overlap or uncovered active time.`
        );
      end = interval.endMs;
    }
    if (end !== state.matchActiveMs)
      throw new Error(
        `Participation for ${playerId} does not partition the actual match time.`
      );
  }
  const boundaries = [
    .../* @__PURE__ */ new Set([
      0,
      state.matchActiveMs,
      ...state.intervals.flatMap((item) => [item.startMs, item.endMs])
    ])
  ].sort((a, b) => a - b);
  for (let index = 0; index + 1 < boundaries.length; index++) {
    const active2 = state.intervals.filter(
      (item) => item.state === "playing" && item.startMs <= boundaries[index] && item.endMs >= boundaries[index + 1]
    );
    if (active2.length > state.config.pitchPlaces || new Set(active2.map((item) => item.slotId)).size !== active2.length || new Set(active2.map((item) => item.playerId)).size !== active2.length)
      throw new Error(
        "Participation occupies a player/slot twice or exceeds pitch capacity."
      );
  }
  const summary = reconciliationSummary(state);
  if (summary.vacancyPlayerMs < 0 || summary.playerMinutes.some(
    (item) => item.playingMs + item.benchMs + item.unavailableMs !== state.matchActiveMs || Object.values(item.positionMs).reduce(
      (sum, value) => sum + value,
      0
    ) !== item.playingMs
  ))
    throw new Error(
      "Player/position participation totals do not conserve active time."
    );
  if (state.targetIntervals.reduce((sum, item) => sum + item.durationMs, 0) !== state.matchActiveMs)
    throw new Error(
      "Availability target intervals do not partition the actual match time."
    );
}
function validateCommandIntent(command) {
  if (!command || typeof command !== "object" || [
    "id",
    "sample",
    "actorId",
    "controllerEpoch",
    "clientSequence",
    "controllerToken"
  ].some((field) => field in command))
    throw new Error(
      "Reviewed command intents cannot supply identity, clock evidence or controller authority."
    );
  if (command.type === "goal.recorded" || command.type === "availability.changed" || command.type === "lineup.committed") {
    if (!command.effective || !command.lateEntryReason?.trim())
      throw new Error(
        "Import each historical event with an explicit active-time boundary and late-entry evidence reason."
      );
    if (command.type !== "goal.recorded" && command.sourceRevision === void 0)
      throw new Error(
        "Historical participation imports need the exact reviewed source revision."
      );
  } else if (!["event.corrected", "event.voided"].includes(command.type))
    throw new Error(
      "Clock, half, attendance and controller transitions need a separate evidence review. No time or authority is inferred from a quarantined device."
    );
}
function previewReviewedCommands(state, commands, context) {
  const before = reconciliationSummary(state), issues = [];
  let projected = state;
  let earliestAffected = null;
  if (!identifier2.test(context.previewId) || !context.actorId || !Number.isSafeInteger(context.recordedAtMs) || context.recordedAtMs < 0)
    issues.push(
      "Preview context requires a bounded ID, verified actor and valid entry timestamp."
    );
  if (!Array.isArray(commands) || commands.length < 1 || commands.length > 100)
    issues.push("Review between1 and100 explicit commands.");
  if (issues.length)
    return {
      valid: false,
      issues,
      before,
      after: null,
      earliestAffected,
      projectedState: null
    };
  try {
    assertParticipationConservation(state);
    for (const [index, command] of commands.entries()) {
      validateCommandIntent(command);
      const event = {
        ...command,
        id: `${context.previewId}-preview-${index}`,
        sample: checkpointSample(projected, context.recordedAtMs),
        actorId: context.actorId
      };
      projected = reduceMatch(projected, event);
      const boundary = projected.audit?.at(-1)?.effective;
      const auditValue = projected.audit?.at(-1)?.value;
      const affected = auditValue?.earliestAffected ?? boundary;
      if (affected && (!earliestAffected || affected.matchElapsedMs < earliestAffected.matchElapsedMs))
        earliestAffected = affected;
      assertParticipationConservation(projected);
    }
    if (projected.matchActiveMs !== state.matchActiveMs || projected.halfActiveMs !== state.halfActiveMs || projected.half !== state.half || projected.firstHalfDurationMs !== state.firstHalfDurationMs || projected.status !== state.status || projected.completedAtMs !== state.completedAtMs || canonicalReviewJson(projected.config) !== canonicalReviewJson(state.config))
      throw new Error(
        "A history proposal cannot change the current clock, actual half lengths, lifecycle, completion anchor or immutable match preparation."
      );
    return {
      valid: true,
      issues: [],
      before,
      after: reconciliationSummary(projected),
      earliestAffected,
      projectedState: projected
    };
  } catch (error) {
    issues.push(
      error instanceof Error ? error.message : "The proposed history could not be validated."
    );
  }
  return {
    valid: false,
    issues,
    before,
    after: null,
    earliestAffected,
    projectedState: null
  };
}
function previewReconciliation(state, input, submissions, context) {
  const before = reconciliationSummary(state), issues = [];
  if (!input || typeof input !== "object")
    return {
      valid: false,
      issues: ["A typed immutable proposal is required."],
      before,
      after: null,
      earliestAffected: null,
      projectedState: null
    };
  if (!identifier2.test(input.proposalId) || !Number.isSafeInteger(input.baseRevision) || input.baseRevision !== state.revision)
    issues.push(
      "The proposal ID or reviewed accepted revision is invalid/stale. Download and review again without rebasing the proposal silently."
    );
  if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 500)
    issues.push("Record an evidence reason of1\u2013500 characters.");
  if (!Array.isArray(input.sourceSubmissionIds) || input.sourceSubmissionIds.length < 1 || input.sourceSubmissionIds.length > 100 || new Set(input.sourceSubmissionIds).size !== input.sourceSubmissionIds.length || input.sourceSubmissionIds.some(
    (id) => !submissions.some(
      (item) => item.submissionId === id && item.matchId === state.config.matchId && Boolean(item.originalDigest)
    )
  ))
    issues.push(
      "Select unique retained submissions from this same match with immutable source digests."
    );
  if (!["duplicate", "retain_conflict", "import_confirmed_events"].includes(
    input.resolution
  ))
    issues.push("Choose a supported explicit review disposition.");
  if (!Array.isArray(input.commands) || input.resolution !== "import_confirmed_events" && input.commands.length !== 0)
    issues.push(
      "Duplicate/disputed dispositions cannot also alter accepted play."
    );
  if (issues.length)
    return {
      valid: false,
      issues,
      before,
      after: null,
      earliestAffected: null,
      projectedState: null
    };
  if (input.resolution === "import_confirmed_events")
    return previewReviewedCommands(state, input.commands, {
      ...context,
      previewId: input.proposalId
    });
  try {
    assertParticipationConservation(state);
  } catch (error) {
    return {
      valid: false,
      issues: [
        error instanceof Error ? error.message : "Invalid accepted participation."
      ],
      before,
      after: null,
      earliestAffected: null,
      projectedState: null
    };
  }
  return {
    valid: true,
    issues: [],
    before,
    after: before,
    earliestAffected: null,
    projectedState: state
  };
}

// apps/api/src/finished-match-context.ts
function eligibilityEvidence(state) {
  const selected = [...state.config.selectedPlayerIds];
  const present = selected.filter((id) => state.attendance[id] === "present");
  const played = selected.filter(
    (id) => state.intervals.some(
      (interval) => interval.playerId === id && interval.state === "playing" && interval.endMs > interval.startMs
    )
  );
  return {
    selected,
    present,
    played,
    contradictory: played.some((id) => !present.includes(id))
  };
}
function finishEligibilityChanged(state, original) {
  const evidence2 = eligibilityEvidence(state);
  const equal2 = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
  return evidence2.contradictory || !equal2(evidence2.selected, original.selectedPlayerIds) || !equal2(evidence2.present, original.presentPlayerIds) || !equal2(evidence2.played, original.playedPlayerIds);
}
function deriveFinishedMatchContext(input) {
  const { state, acceptedFinish: finish } = input;
  if (state.status !== "completed")
    throw new Error(
      "Only an explicitly completed match can establish full-time award context."
    );
  const retainedFinish = state.eventHistory?.filter((event) => event.type === "half.ended").at(-1);
  const matchesAcceptedFinish = finish?.command.type === "half.ended" && finish.eventId === retainedFinish?.id && finish.matchId === state.config.matchId && finish.controllerEpoch === input.currentControllerEpoch && finish.command.sample.monotonicMs === retainedFinish.sample.monotonicMs && finish.command.sample.sessionId === retainedFinish.sample.sessionId && finish.clockEvidence.monotonicMs === finish.command.sample.monotonicMs && finish.command.sample.sessionId === finish.clockEvidence.continuityId && input.acceptedFinishActorId !== null;
  const instant = matchesAcceptedFinish && input.mapping && input.policy && finish ? mapContinuousInstant(
    input.mapping,
    {
      accountId: input.acceptedFinishActorId,
      deviceId: finish.deviceId,
      matchId: finish.matchId,
      controllerEpoch: finish.controllerEpoch,
      continuityId: finish.command.sample.sessionId
    },
    finish.command.sample.monotonicMs,
    input.serverNowMs,
    input.policy
  ) : null;
  const trusted = !input.unresolvedConflicts && !state.recoveryRequired && instant?.quality === "trusted" && instant.utcMs <= input.serverNowMs;
  const eligibility = eligibilityEvidence(state);
  const present = eligibility.present;
  const history = state.eventHistory ?? [];
  const finishIndex = history.findIndex(
    (event) => event.id === retainedFinish?.id
  );
  let changedAfterFinish = false;
  if (finishIndex >= 0 && finishIndex < history.length - 1) {
    const atFinish = eligibilityEvidence(
      replayMatch(state.config, history.slice(0, finishIndex + 1))
    );
    changedAfterFinish = finishEligibilityChanged(state, {
      selectedPlayerIds: atFinish.selected,
      presentPlayerIds: atFinish.present,
      playedPlayerIds: atFinish.played
    });
  }
  return {
    id: state.config.matchId,
    teamId: input.teamId,
    seasonId: input.seasonId,
    label: state.config.fixture ? `${state.config.fixture.teamName} v ${state.config.fixture.opponent}` : state.config.matchId,
    // No device wall clock or upload receipt establishes the original finish.
    playedAtMs: input.scheduledAtMs,
    selectedPlayerIds: [...state.config.selectedPlayerIds],
    presentPlayerIds: present,
    playedPlayerIds: present.filter(
      (id) => state.intervals.some(
        (interval) => interval.playerId === id && interval.state === "playing" && interval.endMs > interval.startMs
      )
    ),
    actualFullTimeAtMs: trusted ? instant.utcMs : null,
    finishQuality: input.unresolvedConflicts ? "conflicted" : trusted && !eligibility.contradictory && !changedAfterFinish ? "trusted" : "review_required",
    sharing: input.sharing,
    policyVersion: input.sharingPolicyVersion
  };
}

// packages/application/src/team-notifications.ts
var TEAM_NOTIFICATION_TIME_ZONE = "Europe/London";
var TEAM_NOTIFICATION_BODY = "Your team has an update";
var clone3 = (value) => JSON.parse(JSON.stringify(value));
function assert2(value, message) {
  if (!value) throw new Error(message);
}
var time2 = (value) => Number.isSafeInteger(value) && value >= 0;
var opaque = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
var code = (value) => /^[A-Z][A-Z0-9_]{0,79}$/.test(value);
function createTeamNotificationJob(input) {
  assert2(input && ["id", "businessKey", "accountId", "teamId", "seasonId", "entityId"].every((field) => opaque(input[field])), "Notifications require bounded opaque identities.");
  assert2(["manager", "player", "spectator"].includes(input.audience) && ["schedule", "match", "awards", "photos"].includes(input.category) && time2(input.dueAtMs), "Invalid notification scope, category or due time.");
  assert2(input.audience === "player" ? input.playerId !== null && opaque(input.playerId) : input.playerId === null, "Player notifications require their original own-player binding.");
  return {
    id: input.id,
    businessKey: input.businessKey,
    accountId: input.accountId,
    teamId: input.teamId,
    seasonId: input.seasonId,
    audience: input.audience,
    playerId: input.playerId,
    category: input.category,
    entityId: input.entityId,
    dueAtMs: input.dueAtMs,
    schemaVersion: 1,
    revision: 0,
    state: "pending",
    attempts: 0,
    deliveryAttempts: 0,
    lease: null,
    lastCode: null,
    providerReceiptId: null,
    acceptedAtMs: null
  };
}
function validateTeamNotificationJob(job) {
  createTeamNotificationJob(job);
  assert2(Object.keys(job).every((field) => ["id", "businessKey", "accountId", "teamId", "seasonId", "audience", "playerId", "category", "entityId", "dueAtMs", "schemaVersion", "revision", "state", "attempts", "deliveryAttempts", "lease", "lastCode", "providerReceiptId", "acceptedAtMs"].includes(field)), "Unexpected retained notification data.");
  assert2(job.schemaVersion === 1 && time2(job.revision) && time2(job.attempts) && time2(job.deliveryAttempts) && ["pending", "leased", "provider_accepted", "suppressed", "blocked_provider", "review_required", "failed"].includes(job.state), "Invalid retained notification state.");
  assert2(job.state === "leased" ? job.lease && opaque(job.lease.attemptId) && time2(job.lease.untilMs) : job.lease === null, "Invalid notification lease.");
  assert2(job.lastCode === null || code(job.lastCode), "Invalid notification outcome code.");
  assert2(job.providerReceiptId === null || opaque(job.providerReceiptId), "Invalid provider receipt identity.");
  assert2(job.acceptedAtMs === null || time2(job.acceptedAtMs), "Invalid provider acknowledgement time.");
  assert2(job.state !== "provider_accepted" || job.providerReceiptId && job.acceptedAtMs !== null, "A provider-accepted job needs a real receipt.");
}
function claimTeamNotificationJob(job, attemptId, nowMs, leaseMs = 3e4) {
  validateTeamNotificationJob(job);
  assert2(time2(nowMs) && opaque(attemptId) && Number.isSafeInteger(leaseMs) && leaseMs >= 1e3 && leaseMs <= 12e4, "Invalid notification lease request.");
  if (!(job.state === "pending" && job.dueAtMs <= nowMs || job.state === "leased" && job.lease.untilMs <= nowMs)) return null;
  return { ...clone3(job), revision: job.revision + 1, attempts: job.attempts + 1, state: "leased", lease: { attemptId, untilMs: nowMs + leaseMs } };
}
var londonClock = new Intl.DateTimeFormat("en-GB", { timeZone: TEAM_NOTIFICATION_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function localMinute(nowMs) {
  const parts = londonClock.formatToParts(nowMs);
  return Number(parts.find((part) => part.type === "hour").value) * 60 + Number(parts.find((part) => part.type === "minute").value);
}
function nextTeamNotificationTime(preferences, nowMs) {
  assert2(time2(nowMs), "Trusted dispatch time is required.");
  assert2(["schedule", "match", "awards", "photos"].every((field) => typeof preferences[field] === "boolean"), "Invalid notification channel preferences.");
  if (preferences.quietStart === null && preferences.quietEnd === null) return nowMs;
  const pattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  assert2(typeof preferences.quietStart === "string" && typeof preferences.quietEnd === "string" && pattern.test(preferences.quietStart) && pattern.test(preferences.quietEnd) && preferences.quietStart !== preferences.quietEnd, "Quiet hours need distinct HH:MM boundaries; use channel switches to pause all day.");
  const minute = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = minute(preferences.quietStart), end = minute(preferences.quietEnd);
  const quiet = (at) => {
    const value = localMinute(at);
    return start < end ? value >= start && value < end : value >= start || value < end;
  };
  if (!quiet(nowMs)) return nowMs;
  for (let at = Math.ceil(nowMs / 6e4) * 6e4; at <= nowMs + 49 * 36e5; at += 6e4) if (!quiet(at)) return at;
  throw new Error("The quiet-hour boundary could not be established.");
}
function evaluateTeamNotification(job, evidence2, nowMs) {
  validateTeamNotificationJob(job);
  if (evidence2.account.accountId !== job.accountId || evidence2.account.status !== "active") return { action: "suppress", code: "ACCOUNT_UNAVAILABLE" };
  const membership = evidence2.memberships.find((item) => item.accountId === job.accountId && item.teamId === job.teamId && item.seasonId === job.seasonId && item.role === job.audience && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > nowMs) && (job.audience !== "player" || item.playerId === job.playerId));
  if (!membership) return { action: "suppress", code: "NO_CURRENT_MEMBERSHIP" };
  if (job.audience === "manager" && !(evidence2.account.identityClassification === "adult_individual" && evidence2.account.adultVerified && evidence2.account.strongAuthEnrolled)) return { action: "suppress", code: "MANAGER_AUTHORITY_UNAVAILABLE" };
  if (job.audience === "spectator" && !evidence2.grants.some((grant) => grant.accountId === job.accountId && grant.teamId === job.teamId && grant.seasonId === job.seasonId && grant.startsAtMs <= nowMs && grant.expiresAtMs > nowMs && grant.revokedAtMs === null)) return { action: "suppress", code: "SPECTATOR_GRANT_UNAVAILABLE" };
  if (evidence2.entityAccess !== "allowed") return { action: "suppress", code: evidence2.entityAccess === "withheld" ? "ENTITY_POLICY_WITHHELD" : "ENTITY_UNAVAILABLE" };
  if (!evidence2.preferences[job.category]) return { action: "suppress", code: "CHANNEL_DISABLED" };
  const dueAtMs = nextTeamNotificationTime(evidence2.preferences, nowMs);
  return dueAtMs > nowMs ? { action: "defer", dueAtMs, code: "QUIET_HOURS" } : { action: "send" };
}
function settle(job, outcome) {
  assert2(job.state === "leased" && job.lease, "The current durable notification lease is required.");
  const next = {
    ...clone3(job),
    state: outcome.state,
    revision: job.revision + 1,
    lease: null,
    lastCode: outcome.code,
    deliveryAttempts: job.deliveryAttempts + Number(outcome.attempted === true),
    dueAtMs: outcome.dueAtMs ?? job.dueAtMs,
    providerReceiptId: outcome.receiptId ?? job.providerReceiptId,
    acceptedAtMs: outcome.state === "provider_accepted" ? outcome.nowMs : job.acceptedAtMs
  };
  validateTeamNotificationJob(next);
  return next;
}
async function dispatchClaimedTeamNotification(job, ports) {
  validateTeamNotificationJob(job);
  const current3 = () => job.state === "leased" && job.lease !== null && ports.now() < job.lease.untilMs;
  if (!current3() || !await ports.stillOwnsLease(job, ports.now())) return { status: "superseded", committed: false, job: null };
  const commit2 = async (next) => {
    const saved = await ports.commit(job, next);
    return { status: saved ? next.state : "superseded", committed: saved, job: saved ? next : null };
  };
  let evidence2;
  try {
    evidence2 = await ports.readCurrentEvidence(job, ports.now());
  } catch {
    return commit2(settle(job, { state: "pending", code: "AUTHORITY_LOOKUP_UNAVAILABLE", nowMs: ports.now(), dueAtMs: ports.now() + 6e4 }));
  }
  if (!current3() || !await ports.stillOwnsLease(job, ports.now())) return { status: "superseded", committed: false, job: null };
  let decision;
  try {
    decision = evaluateTeamNotification(job, evidence2, ports.now());
  } catch {
    return commit2(settle(job, { state: "review_required", code: "INVALID_PREFERENCES_OR_JOB", nowMs: ports.now() }));
  }
  if (decision.action === "suppress") return commit2(settle(job, { state: "suppressed", code: decision.code, nowMs: ports.now() }));
  if (decision.action === "defer") return commit2(settle(job, { state: "pending", code: decision.code, nowMs: ports.now(), dueAtMs: decision.dueAtMs }));
  const provider = ports.provider;
  if (!provider?.configured) return commit2(settle(job, { state: "blocked_provider", code: "PUSH_PROVIDER_UNCONFIGURED", nowMs: ports.now() }));
  const payload = { body: TEAM_NOTIFICATION_BODY, data: { entityId: job.entityId } };
  const abort = new AbortController();
  const remainingMs = Math.min(1e4, job.lease.untilMs - ports.now());
  if (remainingMs <= 0 || !await ports.stillOwnsLease(job, ports.now())) return { status: "superseded", committed: false, job: null };
  let timer;
  try {
    const reply = await Promise.race([provider.send({ idempotencyKey: job.businessKey, accountId: job.accountId, payload, signal: abort.signal }), new Promise((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error("PROVIDER_OUTCOME_UNKNOWN"));
      }, remainingMs);
    })]);
    if (reply.status === "accepted") {
      assert2(opaque(reply.receiptId), "Invalid provider receipt.");
      return commit2(settle(job, { state: "provider_accepted", code: null, nowMs: ports.now(), receiptId: reply.receiptId, attempted: true }));
    }
    const safeCode = ["RATE_LIMIT", "TEMPORARY_UNAVAILABLE", "DEVICE_UNREGISTERED", "PERMISSION_DENIED", "INVALID_DESTINATION"].includes(reply.code) ? reply.code : "PROVIDER_REFUSED";
    const terminal = reply.status === "rejected" || job.deliveryAttempts + 1 >= 6;
    return commit2(settle(job, { state: terminal ? "failed" : "pending", code: safeCode, nowMs: ports.now(), dueAtMs: ports.now() + Math.min(36e5, 3e4 * 2 ** job.deliveryAttempts), attempted: true }));
  } catch {
    const mayRetry = provider.idempotency === "provider" && job.deliveryAttempts + 1 < 6;
    return commit2(settle(job, { state: mayRetry ? "pending" : "review_required", code: "PROVIDER_OUTCOME_UNKNOWN", nowMs: ports.now(), dueAtMs: ports.now() + Math.min(36e5, 3e4 * 2 ** job.deliveryAttempts), attempted: true }));
  } finally {
    clearTimeout(timer);
  }
}

// apps/api/src/sqlite-push-registrations.ts
var PUSH_SQLITE_MIGRATION = `
CREATE TABLE push_registrations(
 account_id TEXT NOT NULL REFERENCES accounts(id),issuer TEXT NOT NULL,device_id TEXT NOT NULL REFERENCES native_app_devices(device_id),platform TEXT NOT NULL CHECK(platform IN('ios','android')),
 transport TEXT CHECK(transport IN('apns','fcm','expo')),provider_config_id TEXT,token_ciphertext TEXT,token_digest TEXT,
 permission TEXT NOT NULL CHECK(permission IN('granted','provisional','denied')),state TEXT NOT NULL CHECK(state IN('registered','revoked')),revision INTEGER NOT NULL CHECK(revision>=1),
 app_build TEXT NOT NULL,registered_at INTEGER,updated_at INTEGER NOT NULL,revoked_at INTEGER,last_operation_id TEXT NOT NULL,
 PRIMARY KEY(account_id,device_id),CHECK((state='registered' AND token_ciphertext IS NOT NULL AND token_digest IS NOT NULL AND transport IS NOT NULL AND provider_config_id IS NOT NULL AND permission<>'denied' AND registered_at IS NOT NULL AND revoked_at IS NULL) OR(state='revoked' AND token_ciphertext IS NULL AND token_digest IS NULL AND revoked_at IS NOT NULL)));
CREATE TRIGGER push_registration_identity BEFORE UPDATE ON push_registrations WHEN NEW.account_id<>OLD.account_id OR NEW.issuer<>OLD.issuer OR NEW.device_id<>OLD.device_id OR NEW.revision<>OLD.revision+1 OR NEW.registered_at IS NOT OLD.registered_at AND OLD.registered_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'Immutable push binding or stale revision'); END;
CREATE TRIGGER push_registration_enrolment_insert BEFORE INSERT ON push_registrations WHEN NOT EXISTS(SELECT 1 FROM native_app_devices d WHERE d.device_id=NEW.device_id AND d.account_id=NEW.account_id AND d.issuer=NEW.issuer AND d.platform=NEW.platform) BEGIN SELECT RAISE(ABORT,'Enrolled push device required'); END;
CREATE TRIGGER push_registration_enrolment_update BEFORE UPDATE ON push_registrations WHEN NOT EXISTS(SELECT 1 FROM native_app_devices d WHERE d.device_id=NEW.device_id AND d.account_id=NEW.account_id AND d.issuer=NEW.issuer AND d.platform=NEW.platform) BEGIN SELECT RAISE(ABORT,'Enrolled push device required'); END;`;

// packages/application/src/staff.ts
var current2 = (item, nowMs) => item.revokedAt == null && (item.expiresAt == null || item.expiresAt > nowMs);
var eligible = (account2) => account2.status === "active" && account2.identityClassification === "adult_individual" && account2.adultVerified && account2.strongAuthEnrolled;
function managerRoster(input) {
  const { principal, memberships, accounts, teamId, seasonId, nowMs } = input;
  if (input.requestedRole && input.requestedRole !== "administrator") throw new AccessError("NOT_FOUND", 404, "Choose the current administrator context for staff management.");
  assertTeamRole(principal, memberships, teamId, seasonId, ["administrator"], nowMs);
  assertAdultAuthority(principal, false, nowMs);
  if (!Number.isSafeInteger(input.revision) || input.revision < 0 || !Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Use the authoritative staff revision and current service time.");
  const associated = new Set(memberships.filter((item) => item.teamId === teamId && current2(item, nowMs)).map((item) => item.accountId));
  const liveManagers = memberships.filter((item) => item.teamId === teamId && item.role === "manager" && current2(item, nowMs));
  const managers = memberships.filter((item) => item.teamId === teamId && item.seasonId === seasonId && item.role === "manager").map((item) => {
    const account2 = accounts.find((account3) => account3.accountId === item.accountId);
    return {
      accountId: item.accountId,
      label: account2 && account2.identityClassification === "adult_individual" && account2.adultVerified ? account2.label : "Unavailable manager account",
      status: !account2 || !eligible(account2) ? "disabled" : item.revokedAt != null ? "revoked" : item.expiresAt != null && item.expiresAt <= nowMs ? "expired" : "active",
      expiresAt: item.expiresAt ?? null,
      revokedAt: item.revokedAt ?? null,
      otherActiveSeasonIds: [...new Set(liveManagers.filter((other) => other.accountId === item.accountId && other.seasonId !== seasonId).map((other) => other.seasonId))].sort()
    };
  }).sort((a, b) => a.label.localeCompare(b.label) || a.accountId.localeCompare(b.accountId));
  const candidates = accounts.filter((account2) => associated.has(account2.accountId) && eligible(account2)).map((account2) => ({ accountId: account2.accountId, label: account2.label, currentManager: liveManagers.some((item) => item.accountId === account2.accountId && item.seasonId === seasonId) })).sort((a, b) => a.label.localeCompare(b.label) || a.accountId.localeCompare(b.accountId));
  return { kind: "manager-roster", revision: input.revision, teamId, seasonId, asOf: new Date(nowMs).toISOString(), maximumManagers: 4, activeTeamManagerCount: new Set(liveManagers.map((item) => item.accountId)).size, canMutate: principal.authenticatedAt <= nowMs + 3e4 && nowMs - principal.authenticatedAt <= 3e5, managers, candidates };
}

// packages/application/src/privacy-requests.ts
var object2 = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
var opaque2 = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(value);
function requireThat5(condition, message) {
  if (!condition) throw new AccessError("INVALID_REQUEST", 400, message);
}
function fields2(value, names) {
  requireThat5(Object.keys(value).length === names.length && Object.keys(value).every((key) => names.includes(key)), "Use only the documented account request fields.");
}
function active(principal) {
  if (principal.status !== "active") throw new AccessError("ACCOUNT_UNAVAILABLE", 403, "Use an active signed-in account to review or submit its own requests.");
}
function validTime4(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function parsePrivacyRequestInput(value) {
  requireThat5(object2(value), "Choose a scoped account request.");
  if (value.kind === "leave_team") {
    fields2(value, ["kind", "teamId", "seasonId", "confirmLeave"]);
    requireThat5(opaque2(value.teamId) && opaque2(value.seasonId) && value.confirmLeave === true, "Explicitly confirm the selected team and season leave request.");
    return { kind: "leave_team", teamId: value.teamId, seasonId: value.seasonId, confirmLeave: true };
  }
  fields2(value, ["kind", "scope", "confirmAllMemberships"]);
  requireThat5((value.kind === "export" || value.kind === "delete_account") && value.scope === "all_memberships" && value.confirmAllMemberships === true, "Explicitly confirm that this global account request covers every membership.");
  return { kind: value.kind, scope: "all_memberships", confirmAllMemberships: true };
}
function parseScope(value) {
  if (value === null) return null;
  requireThat5(object2(value), "Invalid retained account request scope.");
  if (value.type === "all_memberships") {
    fields2(value, ["type"]);
    return { type: "all_memberships" };
  }
  fields2(value, ["type", "teamId", "seasonId"]);
  requireThat5(value.type === "team_season" && opaque2(value.teamId) && opaque2(value.seasonId), "Invalid retained team and season scope.");
  return { type: "team_season", teamId: value.teamId, seasonId: value.seasonId };
}
function privacyRequestBusinessKey(accountId, kind, scope) {
  requireThat5(opaque2(accountId) && ["export", "delete_account", "leave_team"].includes(kind), "A stable own-account request scope is required.");
  const checked = parseScope(scope);
  requireThat5(kind === "leave_team" ? checked.type === "team_season" : checked.type === "all_memberships", "The request kind and scope differ.");
  return JSON.stringify(checked.type === "team_season" ? [accountId, kind, checked.type, checked.teamId, checked.seasonId] : [accountId, kind, checked.type]);
}
function ownPrivacyMemberships(principal, memberships, nowMs) {
  active(principal);
  requireThat5(validTime4(nowMs), "Use the current service time.");
  return memberships.filter((item) => item.accountId === principal.accountId).map((item) => ({
    teamId: item.teamId,
    seasonId: item.seasonId,
    role: item.role,
    playerId: item.playerId ?? null,
    status: item.revokedAt != null ? "revoked" : item.expiresAt != null && item.expiresAt <= nowMs ? "expired" : "active"
  })).sort((a, b) => a.teamId.localeCompare(b.teamId) || a.seasonId.localeCompare(b.seasonId) || a.role.localeCompare(b.role));
}
function prepareAccountPrivacyRequest(input) {
  const command = parsePrivacyRequestInput(input.input), own = ownPrivacyMemberships(input.principal, input.memberships, input.nowMs);
  const scope = command.kind === "leave_team" ? { type: "team_season", teamId: command.teamId, seasonId: command.seasonId } : { type: "all_memberships" };
  const affectedMemberships = scope.type === "all_memberships" ? own : own.filter((item) => item.teamId === scope.teamId && item.seasonId === scope.seasonId && item.status === "active");
  if (scope.type === "team_season" && !affectedMemberships.length) throw new AccessError("NOT_FOUND", 404, "The selected current own membership is unavailable.");
  return {
    accountId: input.principal.accountId,
    kind: command.kind,
    scope,
    businessKey: privacyRequestBusinessKey(input.principal.accountId, command.kind, scope),
    affectedMemberships,
    status: "pending_verification_and_policy",
    verificationRequired: true,
    erased: false,
    fulfilled: false
  };
}
function parseMembership(value) {
  requireThat5(object2(value), "Invalid affected membership.");
  fields2(value, ["teamId", "seasonId", "role", "playerId", "status"]);
  requireThat5(opaque2(value.teamId) && opaque2(value.seasonId) && ["administrator", "manager", "player", "spectator"].includes(value.role) && (value.playerId === null || opaque2(value.playerId)) && ["active", "expired", "revoked"].includes(value.status), "Invalid affected membership fields.");
  return { teamId: value.teamId, seasonId: value.seasonId, role: value.role, playerId: value.playerId, status: value.status };
}
function parsePrivacyRequestDto(value) {
  requireThat5(object2(value), "Invalid account request response.");
  fields2(value, ["requestId", "kind", "status", "scope", "affectedMemberships", "createdAtMs", "verificationRequired", "erased", "fulfilled", "scopeStatus", "reviewStatus", "duplicateOfRequestId"]);
  requireThat5(opaque2(value.requestId) && ["export", "delete_account", "leave_team"].includes(value.kind) && ["pending_verification_and_policy", "needs_scope"].includes(value.status) && validTime4(value.createdAtMs), "Invalid account request status or identity.");
  requireThat5(value.verificationRequired === true && value.erased === false && value.fulfilled === false && (value.duplicateOfRequestId === null || opaque2(value.duplicateOfRequestId)), "A pending request never establishes fulfilment or deletion.");
  const scope = parseScope(value.scope), kind = value.kind;
  requireThat5(scope === null || (kind === "leave_team" ? scope.type === "team_season" : scope.type === "all_memberships"), "The account request kind and scope differ.");
  requireThat5(value.scopeStatus === (scope === null ? "needs_scope" : "recorded") && value.reviewStatus === (scope === null || value.status === "needs_scope" ? "needs_scope" : value.duplicateOfRequestId === null ? "pending_verification_and_policy" : "duplicate_requires_review"), "The account request review status is inconsistent.");
  requireThat5(value.affectedMemberships === null || Array.isArray(value.affectedMemberships), "The confirmed membership snapshot is missing or invalid.");
  const affectedMemberships = value.affectedMemberships === null ? null : value.affectedMemberships.map(parseMembership);
  requireThat5(scope?.type !== "team_season" || affectedMemberships === null || affectedMemberships.every((item) => item.teamId === scope.teamId && item.seasonId === scope.seasonId), "The affected membership snapshot crosses the selected leave scope.");
  return { requestId: value.requestId, kind, status: value.status, scope, affectedMemberships, createdAtMs: value.createdAtMs, verificationRequired: true, erased: false, fulfilled: false, scopeStatus: value.scopeStatus, reviewStatus: value.reviewStatus, duplicateOfRequestId: value.duplicateOfRequestId };
}
function projectAccountPrivacyRequests(input) {
  const memberships = ownPrivacyMemberships(input.principal, input.memberships, input.nowMs), canonical6 = /* @__PURE__ */ new Map();
  const items = input.records.filter((item) => item.accountId === input.principal.accountId).sort((a, b) => a.createdAtMs - b.createdAtMs || a.requestId.localeCompare(b.requestId)).map((record) => {
    const scope = parseScope(record.scope);
    const key = scope && record.status === "pending_verification_and_policy" ? privacyRequestBusinessKey(record.accountId, record.kind, scope) : null;
    const duplicateOfRequestId = key ? canonical6.get(key) ?? null : null;
    if (key && !canonical6.has(key)) canonical6.set(key, record.requestId);
    return parsePrivacyRequestDto({
      requestId: record.requestId,
      kind: record.kind,
      status: record.status,
      scope,
      affectedMemberships: record.affectedMemberships,
      createdAtMs: record.createdAtMs,
      verificationRequired: true,
      erased: false,
      fulfilled: false,
      scopeStatus: scope === null ? "needs_scope" : "recorded",
      duplicateOfRequestId,
      reviewStatus: scope === null || record.status === "needs_scope" ? "needs_scope" : duplicateOfRequestId ? "duplicate_requires_review" : "pending_verification_and_policy"
    });
  });
  return { accountId: input.principal.accountId, memberships, items };
}

// apps/api/src/brand-repository.ts
function brandSelectedRole(principal, memberships, teamId, seasonId, role, nowMs) {
  const own = currentMemberships(principal, memberships, nowMs).filter((member) => member.teamId === teamId && member.seasonId === seasonId);
  const chosen = role ?? ["manager", "player", "spectator", "administrator"].find((candidate) => own.some((member) => member.role === candidate));
  if (!chosen || !["manager", "player", "spectator", "administrator"].includes(chosen)) throw new AccessError("NOT_FOUND", 404, "The requested branding is unavailable.");
  assertTeamRole(principal, memberships, teamId, seasonId, [chosen], nowMs);
  return chosen;
}

// packages/application/src/account-devices.ts
var object3 = (v) => Boolean(v && typeof v === "object" && !Array.isArray(v));
var opaque3 = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(v);
var iso2 = (v) => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
function fields3(value, keys2) {
  if (Object.keys(value).length !== keys2.length || Object.keys(value).some((key) => !keys2.includes(key)))
    throw new Error("Invalid own device inventory fields.");
}
function parseAccountDevicesDto(value) {
  if (!object3(value)) throw new Error("Invalid own device inventory.");
  fields3(value, [
    "kind",
    "accountId",
    "asOf",
    "devices",
    "remoteRevocationAvailable"
  ]);
  if (value.kind !== "recognised-devices" || !opaque3(value.accountId) || !iso2(value.asOf) || !Array.isArray(value.devices) || value.remoteRevocationAvailable !== false)
    throw new Error("Invalid own device inventory.");
  const seen = /* @__PURE__ */ new Set();
  const devices = value.devices.map((item) => {
    if (!object3(item)) throw new Error("Invalid device entry.");
    fields3(item, [
      "deviceId",
      "source",
      "label",
      "platform",
      "platformVerified",
      "registeredAt",
      "lastSeenAt"
    ]);
    if (!opaque3(item.deviceId) || seen.has(item.deviceId) || !["native_app_enrolment", "match_controller_enrolment"].includes(
      item.source
    ) || item.label !== null || ![null, "ios", "android"].includes(item.platform) || item.platformVerified !== false || item.registeredAt !== null && !iso2(item.registeredAt) || item.lastSeenAt !== null && !iso2(item.lastSeenAt))
      throw new Error("Invalid device entry metadata.");
    if (item.source === "native_app_enrolment" && (item.platform === null || item.registeredAt === null || item.lastSeenAt === null))
      throw new Error("Native enrolment requires actual service timestamps.");
    if (item.source === "match_controller_enrolment" && (item.platform !== null || item.registeredAt !== null || item.lastSeenAt !== null))
      throw new Error("Legacy recorder metadata is unknown.");
    if (item.registeredAt && item.lastSeenAt && Date.parse(item.lastSeenAt) < Date.parse(item.registeredAt))
      throw new Error("Device timestamps are inconsistent.");
    seen.add(item.deviceId);
    return item;
  });
  return {
    kind: "recognised-devices",
    accountId: value.accountId,
    asOf: value.asOf,
    devices,
    remoteRevocationAvailable: false
  };
}

// apps/api/src/devices.ts
function parseNativeDeviceInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AccessError("INVALID_REQUEST", 400, "Use the reported native installation identity and platform.");
  const item = value;
  if (Object.keys(item).length !== 2 || Object.keys(item).some((key) => !["deviceId", "platform"].includes(key)) || typeof item.deviceId !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(item.deviceId) || !["ios", "android"].includes(String(item.platform))) throw new AccessError("INVALID_REQUEST", 400, "Use a canonical installation identity and reported iOS or Android platform.");
  return { deviceId: item.deviceId, platform: item.platform };
}
function ownDevicesDto(principal, legacy, native, nowMs) {
  if (legacy.some((row) => row.account_id !== principal.accountId) || native.some((row) => row.account_id !== principal.accountId || row.issuer !== principal.issuer)) throw new Error("OWN_DEVICE_SCOPE_REQUIRED");
  const nativeIds = new Set(native.map((row) => row.device_id));
  return parseAccountDevicesDto({ kind: "recognised-devices", accountId: principal.accountId, asOf: new Date(nowMs).toISOString(), devices: [...native.map((row) => ({ deviceId: row.device_id, source: "native_app_enrolment", label: null, platform: row.platform, platformVerified: false, registeredAt: new Date(row.registered_at).toISOString(), lastSeenAt: new Date(row.last_seen_at).toISOString() })), ...legacy.filter((row) => !nativeIds.has(row.id)).map((row) => ({ deviceId: row.id, source: "match_controller_enrolment", label: null, platform: null, platformVerified: false, registeredAt: null, lastSeenAt: null }))], remoteRevocationAvailable: false });
}

// apps/api/src/store.ts
var EVENT_CONTRACT_VERSION = "longball.events/1.1";
var SYNTHETIC_IDS = { teamId: "synthetic-roma-u10", seasonId: "synthetic-season-2026-27", matchId: "synthetic-roma-maple-2026-10-24" };
function canonical4(value) {
  if (Array.isArray(value)) return `[${value.map(canonical4).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical4(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
var digest = (value) => createHash2("sha256").update(value).digest("hex");
var validId3 = (value) => typeof value === "string" && value.length > 0 && value.length <= 150 && /^[a-zA-Z0-9_-]+$/.test(value);
var validDeviceId = (value) => validId3(value) && value.length <= 120;
var nonnegative3 = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function bad(message) {
  throw new AccessError("INVALID_REQUEST", 400, message);
}
function validateEnvelope(value, matchId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) bad("An event envelope is required.");
  const item = value;
  if (!validId3(item.eventId) || !validDeviceId(item.deviceId) || item.matchId !== matchId || !nonnegative3(item.clientSequence) || item.clientSequence < 1 || !nonnegative3(item.controllerEpoch) || item.controllerEpoch < 1 || !nonnegative3(item.baseRevision)) bad("Invalid event identity, scope or sequence.");
  if (!(item.previousEventId === null || validId3(item.previousEventId))) bad("Invalid previous event identifier.");
  if (item.contractVersion !== EVENT_CONTRACT_VERSION || item.schemaVersion !== 1 || item.engineVersion !== ENGINE_VERSION) return item;
  const fields4 = ["contractVersion", "schemaVersion", "engineVersion", "eventId", "matchId", "deviceId", "controllerEpoch", "clientSequence", "previousEventId", "baseRevision", "effectiveHalf", "halfElapsedMs", "matchElapsedMs", "effectiveAt", "recordedAt", "timeQuality", "clockEvidence", "command"];
  if (Object.keys(item).some((key) => !fields4.includes(key))) bad("Unknown event envelope fields are not accepted.");
  if (!nonnegative3(item.halfElapsedMs) || !nonnegative3(item.matchElapsedMs) || ![0, 1, 2].includes(item.effectiveHalf)) bad("Invalid effective playing-time boundary.");
  if (!["anchored", "estimated", "reviewRequired"].includes(item.timeQuality) || !Number.isFinite(Date.parse(item.recordedAt)) || !(item.effectiveAt === null || Number.isFinite(Date.parse(item.effectiveAt)))) bad("Invalid event time evidence.");
  const command = item.command;
  if (!command || typeof command !== "object" || command.id !== item.eventId || !command.sample || !Number.isFinite(command.sample.monotonicMs) || command.sample.monotonicMs < 0 || !validId3(command.sample.sessionId) || !nonnegative3(command.sample.wallTimeMs)) bad("Invalid versioned match command.");
  if (!item.clockEvidence || item.clockEvidence.monotonicMs !== command.sample.monotonicMs || !validId3(item.clockEvidence.anchorId) || !(item.clockEvidence.continuityId === null || validId3(item.clockEvidence.continuityId))) bad("Explicit clock evidence is required.");
  const commandTypes = ["attendance.recorded", "availability.changed", "lineup.staged", "half.started", "half.paused", "half.resumed", "half.ended", "lineup.committed", "goal.recorded", "clock.recovery_required", "clock.corrected", "event.corrected", "event.voided", "policy.changed", "match.abandoned"];
  if (!commandTypes.includes(command.type)) bad("Unsupported match command.");
  if (command.type === "goal.recorded" && !["us", "opposition"].includes(command.beneficiary)) bad("Invalid goal side.");
  if (command.type === "attendance.recorded" && (!validId3(command.playerId) || !["present", "absent", "excused", "not_selected", "not_recorded"].includes(command.status))) bad("Invalid attendance.");
  if (command.type === "availability.changed" && (!validId3(command.playerId) || typeof command.available !== "boolean")) bad("Invalid availability.");
  if ((command.type === "lineup.staged" || command.type === "lineup.committed") && (!Array.isArray(command.lineup) || command.lineup.length > 11 || command.lineup.some((item2) => !validId3(item2.playerId) || !validId3(item2.slotId) || typeof item2.position !== "string" || item2.position.length > 30))) bad("Invalid lineup allocations.");
  return item;
}
var DevelopmentStore = class {
  constructor(path, now = Date.now) {
    this.path = path;
    this.now = now;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 448 });
    this.database = new DatabaseSync(path);
    try {
      if (path !== ":memory:") chmodSync(path, 384);
      this.database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
      this.migrate();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }
  path;
  now;
  database;
  close() {
    this.database.close();
  }
  transaction(work) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  migrate() {
    this.transaction(() => {
      const version = Number(this.database.prepare("PRAGMA user_version").get().user_version);
      if (version > 10) throw new Error("This store version is newer than this application; preserve it and use a compatible build.");
      if (version === 0) this.database.exec(`
      CREATE TABLE accounts(id TEXT PRIMARY KEY,issuer TEXT NOT NULL,subject TEXT NOT NULL,classification TEXT NOT NULL CHECK(classification IN ('child_shared','adult_individual','unclassified')),adult_verified INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'active',UNIQUE(issuer,subject));
      CREATE TABLE teams(id TEXT PRIMARY KEY,name TEXT NOT NULL);
      CREATE TABLE memberships(account_id TEXT NOT NULL REFERENCES accounts(id),team_id TEXT NOT NULL REFERENCES teams(id),season_id TEXT NOT NULL,role TEXT NOT NULL,player_id TEXT,expires_at INTEGER,revoked_at INTEGER,PRIMARY KEY(account_id,team_id,season_id,role));
      CREATE TABLE matches(id TEXT PRIMARY KEY,team_id TEXT NOT NULL REFERENCES teams(id),season_id TEXT NOT NULL,config_json TEXT NOT NULL,state_json TEXT NOT NULL,sharing_policy_json TEXT NOT NULL,last_sync_at INTEGER);
      CREATE TABLE controller_grants(match_id TEXT PRIMARY KEY REFERENCES matches(id),epoch INTEGER NOT NULL,account_id TEXT NOT NULL REFERENCES accounts(id),device_id TEXT NOT NULL,capability_hash TEXT NOT NULL,frozen INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE controller_history(id TEXT PRIMARY KEY,match_id TEXT NOT NULL,epoch INTEGER NOT NULL,actor_id TEXT NOT NULL,from_device TEXT,to_device TEXT NOT NULL,kind TEXT NOT NULL,reason TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE events(event_id TEXT PRIMARY KEY,match_id TEXT NOT NULL REFERENCES matches(id),device_id TEXT NOT NULL,client_sequence INTEGER NOT NULL,envelope_json TEXT NOT NULL,signature TEXT NOT NULL,disposition TEXT NOT NULL,reason TEXT,revision INTEGER,received_at INTEGER NOT NULL,UNIQUE(match_id,device_id,client_sequence));
      CREATE TABLE streams(match_id TEXT NOT NULL REFERENCES matches(id),device_id TEXT NOT NULL,sequence INTEGER NOT NULL,previous_event_id TEXT NOT NULL,PRIMARY KEY(match_id,device_id));
      CREATE TABLE conflicting_submissions(id TEXT PRIMARY KEY,match_id TEXT NOT NULL,actor_id TEXT NOT NULL,original_json TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE transfers(id TEXT PRIMARY KEY,match_id TEXT NOT NULL REFERENCES matches(id),from_epoch INTEGER NOT NULL,to_account_id TEXT NOT NULL,to_device_id TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE idempotency(account_id TEXT NOT NULL,operation TEXT NOT NULL,key TEXT NOT NULL,signature TEXT NOT NULL,response_json TEXT NOT NULL,PRIMARY KEY(account_id,operation,key));
      CREATE TABLE audit(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,action TEXT NOT NULL,object_id TEXT NOT NULL,outcome TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE privacy_requests(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),kind TEXT NOT NULL,status TEXT NOT NULL,policy_version TEXT,verified_at INTEGER,created_at INTEGER NOT NULL);
      CREATE TABLE jobs(id TEXT PRIMARY KEY,business_key TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,payload_json TEXT NOT NULL,due_at INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,lease_until INTEGER,last_error_code TEXT);
      CREATE INDEX pending_jobs ON jobs(state,due_at);
      CREATE INDEX match_event_order ON events(match_id,revision);
      PRAGMA user_version=1;
    `);
      if (version < 2) this.database.exec(`
      CREATE TABLE documents(team_id TEXT NOT NULL REFERENCES teams(id),season_id TEXT NOT NULL,kind TEXT NOT NULL,revision INTEGER NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(team_id,season_id,kind));
      PRAGMA user_version=2;
    `);
      if (version < 3) this.database.exec("ALTER TABLE accounts ADD COLUMN strong_auth_enrolled INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=3;");
      if (version < 4) this.database.exec("CREATE TABLE devices(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id)); PRAGMA user_version=4;");
      if (version < 5) this.database.exec("ALTER TABLE events ADD COLUMN actor_id TEXT REFERENCES accounts(id); PRAGMA user_version=5;");
      if (version < 6) this.database.exec(`
      CREATE TABLE clock_challenges(id TEXT PRIMARY KEY,match_id TEXT NOT NULL REFERENCES matches(id),account_id TEXT NOT NULL REFERENCES accounts(id),challenge_json TEXT NOT NULL,consumed_at INTEGER);
      CREATE TABLE clock_mappings(challenge_id TEXT PRIMARY KEY REFERENCES clock_challenges(id),match_id TEXT NOT NULL REFERENCES matches(id),mapping_json TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE reconciliation_proposals(id TEXT PRIMARY KEY,match_id TEXT NOT NULL REFERENCES matches(id),actor_id TEXT NOT NULL REFERENCES accounts(id),signature TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at INTEGER NOT NULL);
      PRAGMA user_version=6;
    `);
      if (version < 7) this.database.exec(`
      ALTER TABLE privacy_requests ADD COLUMN team_id TEXT REFERENCES teams(id);
      ALTER TABLE privacy_requests ADD COLUMN season_id TEXT;
      ALTER TABLE privacy_requests ADD COLUMN affected_memberships_json TEXT;
      UPDATE privacy_requests SET status='needs_scope' WHERE kind='leave_team' AND status='pending_verification_and_policy' AND (team_id IS NULL OR season_id IS NULL);
      CREATE TABLE privacy_pending_keys(business_key TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE REFERENCES privacy_requests(id));
      INSERT INTO privacy_pending_keys(business_key,request_id)
        SELECT json_array(account_id,kind,'all_memberships'),id FROM (
          SELECT id,account_id,kind,ROW_NUMBER() OVER(PARTITION BY account_id,kind ORDER BY created_at,id) AS n
          FROM privacy_requests WHERE status='pending_verification_and_policy' AND kind IN ('export','delete_account')
        ) WHERE n=1;
      PRAGMA user_version=7;
    `);
      if (version < 8) this.database.exec(`CREATE TABLE native_app_devices(device_id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),issuer TEXT NOT NULL,platform TEXT NOT NULL CHECK(platform IN('ios','android')),registered_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL CHECK(last_seen_at>=registered_at));
      CREATE TRIGGER native_device_identity_immutable BEFORE UPDATE ON native_app_devices WHEN NEW.device_id<>OLD.device_id OR NEW.account_id<>OLD.account_id OR NEW.issuer<>OLD.issuer OR NEW.registered_at<>OLD.registered_at BEGIN SELECT RAISE(ABORT,'Immutable native device identity'); END;
      PRAGMA user_version=8;`);
      if (version < 9) this.database.exec(SQLITE_TEAM_PRIVILEGES_DDL + "PRAGMA user_version=9;");
      if (version < 10) this.database.exec(PUSH_SQLITE_MIGRATION + "PRAGMA user_version=10;");
    });
  }
  async backup(destination) {
    mkdirSync(dirname(destination), { recursive: true, mode: 448 });
    await backup(this.database, destination);
    chmodSync(destination, 384);
  }
  integrity() {
    return String(this.database.prepare("PRAGMA integrity_check").get().integrity_check);
  }
  seedSynthetic() {
    this.transaction(() => {
      if (this.database.prepare("SELECT id FROM teams LIMIT 1").get()) return;
      this.database.prepare("INSERT INTO teams(id,name) VALUES(?,?)").run(SYNTHETIC_IDS.teamId, "Roma U10 \xB7 fictional");
      this.database.prepare("INSERT INTO teams(id,name) VALUES(?,?)").run("synthetic-other-team", "Other fictional team");
      const add2 = (id, classification, adult) => this.database.prepare("INSERT INTO accounts(id,issuer,subject,classification,adult_verified,strong_auth_enrolled) VALUES(?,?,?,?,?,?)").run(id, "urn:longball:synthetic", id, classification, Number(adult), Number(adult));
      const membership = (id, role, playerId = null, teamId = SYNTHETIC_IDS.teamId) => this.database.prepare("INSERT INTO memberships(account_id,team_id,season_id,role,player_id) VALUES(?,?,?,?,?)").run(id, teamId, SYNTHETIC_IDS.seasonId, role, playerId);
      add2("synthetic-account-admin", "adult_individual", true);
      membership("synthetic-account-admin", "administrator");
      for (let number = 1; number <= 5; number++) {
        const id = number === 1 ? "synthetic-account-manager" : `synthetic-account-manager-${number}`;
        add2(id, "adult_individual", true);
        if (number <= 4) membership(id, "manager");
        if (number === 1) membership(id, "administrator");
      }
      for (let number = 1; number <= 13; number++) {
        const suffix = String(number).padStart(2, "0");
        const id = `synthetic-account-player-${suffix}`;
        add2(id, "child_shared", false);
        membership(id, "player", `synthetic-player-${suffix}`);
      }
      add2("synthetic-account-spectator", "adult_individual", false);
      membership("synthetic-account-spectator", "spectator");
      add2("synthetic-account-invitee", "adult_individual", false);
      add2("synthetic-account-other-manager", "adult_individual", true);
      membership("synthetic-account-other-manager", "manager", null, "synthetic-other-team");
      const config = { matchId: SYNTHETIC_IDS.matchId, players: romaFixture.players, selectedPlayerIds: romaFixture.players.filter((player) => player.available).map((player) => player.id), pitchPlaces: 7, plannedHalfDurationMs: 15e5, fixedKeeperId: romaFixture.players[0].id };
      this.insertMatch(config, SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId);
      const community = createCommunityState(this.now());
      community.matches = community.matches.map((match) => ({ ...match, sharing: "manager_only" }));
      for (let number = 2; number <= 4; number++) {
        const id = `synthetic-account-manager-${number}`;
        community.accounts.push({ id, label: `Fictional manager ${number}`, classification: "adult_individual", adultVerified: true });
        community.memberships.push({ accountId: id, teamId: SYNTHETIC_IDS.teamId, seasonId: SYNTHETIC_IDS.seasonId, role: "manager", active: true });
      }
      this.saveDocument(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, "preparation", createPreparationState());
      this.saveDocument(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, "community", community);
      this.saveDocument(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, "records", createRecordsSeed());
    });
  }
  insertMatch(config, teamId, seasonId) {
    this.database.prepare("INSERT INTO matches(id,team_id,season_id,config_json,state_json,sharing_policy_json) VALUES(?,?,?,?,?,?)").run(config.matchId, teamId, seasonId, JSON.stringify(config), JSON.stringify(createMatch(config)), JSON.stringify(UNAPPROVED_SHARING_POLICY));
  }
  principal(identity) {
    const account2 = this.database.prepare("SELECT * FROM accounts WHERE issuer=? AND subject=?").get(identity.issuer, identity.subject);
    if (!account2 || account2.status !== "active") throw new AccessError("ACCOUNT_UNAVAILABLE", 403, "The account is not active for this service.");
    return { accountId: account2.id, issuer: account2.issuer, subject: account2.subject, identityClassification: account2.classification, adultVerified: Boolean(account2.adult_verified), strongAuth: identity.strongAuth, authenticatedAt: identity.authenticatedAt, status: account2.status };
  }
  memberships() {
    const rows = this.database.prepare("SELECT * FROM memberships").all().map((row) => ({ accountId: row.account_id, teamId: row.team_id, seasonId: row.season_id, role: row.role, playerId: row.player_id ?? void 0, expiresAt: row.expires_at, revokedAt: row.revoked_at }));
    const communities = this.database.prepare("SELECT team_id,season_id,value_json FROM documents WHERE kind='community'").all().map((row) => ({ ...row, state: JSON.parse(row.value_json) }));
    return rows.map((row) => {
      if (row.role !== "spectator") return row;
      const scope = communities.find((document) => document.team_id === row.teamId && document.season_id === row.seasonId);
      const granted = scope?.state.grants.some((grant) => grant.accountId === row.accountId && grant.teamId === row.teamId && grant.seasonId === row.seasonId && grant.revokedAtMs === null && grant.startsAtMs <= this.now() && grant.expiresAtMs > this.now());
      return scope && !granted ? { ...row, revokedAt: row.revokedAt ?? Math.max(1, this.now()) } : row;
    });
  }
  myMemberships(principal) {
    return currentMemberships(principal, this.memberships(), this.now());
  }
  recognisedDevices(principal) {
    const legacy = this.database.prepare("SELECT id,account_id FROM devices WHERE account_id=? ORDER BY id").all(principal.accountId);
    const native = this.database.prepare("SELECT * FROM native_app_devices WHERE account_id=? AND issuer=? ORDER BY registered_at,device_id").all(principal.accountId, principal.issuer);
    return ownDevicesDto(principal, legacy, native, this.now());
  }
  enrolDevice(principal, input) {
    const parsed = parseNativeDeviceInput(input);
    if (this.database.prepare("SELECT id FROM devices WHERE id=? AND account_id=?").get(parsed.deviceId, principal.accountId)) throw new AccessError("DEVICE_ID_CONFLICT", 409, "Use a separate installation identity for sign-in recognition.");
    const previous = this.database.prepare("SELECT account_id,issuer FROM native_app_devices WHERE device_id=?").get(parsed.deviceId);
    if (previous && (previous.account_id !== principal.accountId || previous.issuer !== principal.issuer)) throw new AccessError("DEVICE_ID_CONFLICT", 409, "This installation identity is unavailable.");
    this.database.prepare("INSERT INTO native_app_devices(device_id,account_id,issuer,platform,registered_at,last_seen_at) VALUES(?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET platform=excluded.platform,last_seen_at=MAX(native_app_devices.last_seen_at,excluded.last_seen_at)").run(parsed.deviceId, principal.accountId, principal.issuer, parsed.platform, this.now(), this.now());
    return this.recognisedDevices(principal);
  }
  brandingContext(principal, teamId, seasonId, role) {
    const memberships = this.memberships(), nowMs = this.now(), selectedRole = brandSelectedRole(principal, memberships, teamId, seasonId, role, nowMs);
    const preparation = this.document(teamId, seasonId, "preparation");
    if (preparation.team.id !== teamId) throw new AccessError("NOT_FOUND", 404, "The requested branding is unavailable.");
    return { context: { principal, memberships, selectedRole, clubId: preparation.club.id, teamId, authoritySeasonId: seasonId, nowMs, spectatorGrantActive: selectedRole === "spectator" }, club: { id: preparation.club.id, name: preparation.club.name }, team: { id: teamId, name: preparation.team.name, ageGroup: preparation.team.ageGroup } };
  }
  match(matchId) {
    const row = this.database.prepare("SELECT * FROM matches WHERE id=?").get(matchId);
    if (!row) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    return row;
  }
  managerMatch(principal, matchId) {
    const row = this.match(matchId);
    assertCanManageTeam(principal, this.memberships(), row.team_id, row.season_id, this.now());
    return row;
  }
  matchDto(principal, matchId, requestedRole) {
    const row = this.match(matchId);
    return filterMatchForPrincipal({ principal, memberships: this.memberships(), teamId: row.team_id, seasonId: row.season_id, state: JSON.parse(row.state_json), policy: JSON.parse(row.sharing_policy_json), lastSyncAt: row.last_sync_at, now: this.now(), requestedRole });
  }
  download(principal, matchId, deviceId, syntheticOnly = false, controllerToken) {
    const read = () => {
      const row = this.managerMatch(principal, matchId);
      if (!validDeviceId(deviceId)) bad("A device identifier of at most 120 canonical characters is required.");
      if (controllerToken !== void 0) {
        const authority = this.assertController(principal, matchId, controllerToken);
        if (authority.device_id !== deviceId || authority.frozen) throw new AccessError("CONTROLLER_REQUIRED", 409, "Use the current unfrozen controller device and capability.");
      }
      const stream = this.database.prepare("SELECT sequence,previous_event_id FROM streams WHERE match_id=? AND device_id=?").get(matchId, deviceId);
      const controller = this.database.prepare("SELECT epoch,account_id,device_id,frozen FROM controller_grants WHERE match_id=?").get(matchId);
      const events = this.database.prepare("SELECT revision,received_at,envelope_json FROM events WHERE match_id=? AND disposition='accepted' ORDER BY revision LIMIT 10001").all(matchId);
      const transitions = this.database.prepare("SELECT id,epoch,actor_id,from_device,to_device,kind,reason,created_at FROM controller_history WHERE match_id=? ORDER BY epoch,created_at,id LIMIT 10001").all(matchId);
      const saved = this.database.prepare("SELECT value_json FROM documents WHERE team_id=? AND season_id=? AND kind='records'").get(row.team_id, row.season_id);
      return buildOfflineDownload({ matchId, teamId: row.team_id, seasonId: row.season_id, deviceId, state: JSON.parse(row.state_json), checkpoint: { clientSequence: stream?.sequence ?? 0, previousEventId: stream?.previous_event_id ?? null }, controller: controller ?? null, events, transitions, publication: offlinePublication(matchId, JSON.parse(row.sharing_policy_json), saved ? JSON.parse(saved.value_json) : null), nowMs: this.now(), syntheticOnly });
    };
    return this.database.isTransaction ? read() : this.transaction(read);
  }
  audit(principal, action, objectId, outcome) {
    this.database.prepare("INSERT INTO audit(id,actor_id,action,object_id,outcome,created_at) VALUES(?,?,?,?,?,?)").run(randomUUID2(), principal.accountId, action, objectId, outcome, this.now());
  }
  idempotent(principal, operation, key, payload, work) {
    if (!validId3(key) || key.length < 8) bad("A stable Idempotency-Key is required for mutations.");
    const signature2 = digest(canonical4(payload));
    return this.transaction(() => {
      const prior = this.database.prepare("SELECT signature,response_json FROM idempotency WHERE account_id=? AND operation=? AND key=?").get(principal.accountId, operation, key);
      if (prior) {
        if (prior.signature !== signature2) throw new AccessError("IDEMPOTENCY_CONFLICT", 409, "The idempotency key was already used with different content.");
        return JSON.parse(prior.response_json);
      }
      const response = work();
      this.database.prepare("INSERT INTO idempotency(account_id,operation,key,signature,response_json) VALUES(?,?,?,?,?)").run(principal.accountId, operation, key, signature2, JSON.stringify(response));
      return response;
    });
  }
  acquire(principal, matchId, deviceId) {
    this.managerMatch(principal, matchId);
    if (!validDeviceId(deviceId)) bad("A device identifier of at most 120 canonical characters is required.");
    const prior = this.database.prepare("SELECT * FROM controller_grants WHERE match_id=?").get(matchId);
    if (prior) throw new AccessError("CONTROLLER_EXISTS", 409, "This match already has a controller. Use handover or audited recovery.");
    this.bindDevice(principal, deviceId);
    const token = randomBytes(32).toString("base64url");
    this.database.prepare("INSERT INTO controller_grants(match_id,epoch,account_id,device_id,capability_hash) VALUES(?,?,?,?,?)").run(matchId, 1, principal.accountId, deviceId, digest(token));
    this.audit(principal, "controller.acquired", matchId, "accepted");
    return { epoch: 1, deviceId, controllerToken: token, checkpoint: this.download(principal, matchId, deviceId).deviceCheckpoint };
  }
  assertController(principal, matchId, token) {
    this.managerMatch(principal, matchId);
    const grant = this.database.prepare("SELECT * FROM controller_grants WHERE match_id=?").get(matchId);
    if (!grant || grant.account_id !== principal.accountId || !token || digest(token) !== grant.capability_hash) throw new AccessError("CONTROLLER_REQUIRED", 409, "Only the selected manager and enrolled device may write this match.");
    return grant;
  }
  issueClockChallenge(principal, matchId, token, input, policy) {
    const grant = this.assertController(principal, matchId, token);
    if (!policy) throw new AccessError("CLOCK_POLICY_REQUIRED", 503, "An explicitly configured trusted-time policy is required before establishing an anchor.");
    if (!input || Object.keys(input).some((key) => !["deviceId", "controllerEpoch", "continuityId"].includes(key)) || !validDeviceId(input.deviceId) || !validId3(input.continuityId) || input.deviceId !== grant.device_id || input.controllerEpoch !== grant.epoch || grant.frozen) throw new AccessError("CLOCK_SCOPE_CONFLICT", 409, "Use the current unfrozen controller device, epoch and continuous-clock identity.");
    const challenge = issueClockChallenge({ accountId: principal.accountId, deviceId: grant.device_id, matchId, controllerEpoch: grant.epoch, continuityId: input.continuityId }, randomUUID2(), this.now(), policy);
    this.database.prepare("INSERT INTO clock_challenges(id,match_id,account_id,challenge_json) VALUES(?,?,?,?)").run(challenge.id, matchId, principal.accountId, JSON.stringify(challenge));
    return challenge;
  }
  acknowledgeClockChallenge(principal, matchId, token, challengeId, sample, policy) {
    const grant = this.assertController(principal, matchId, token);
    if (!policy) throw new AccessError("CLOCK_POLICY_REQUIRED", 503, "An explicitly configured trusted-time policy is required before establishing an anchor.");
    if (!sample || Object.keys(sample).some((key) => !["receivedMonotonicMs", "sentMonotonicMs"].includes(key))) bad("Use the documented continuous-clock receipt and send observations.");
    const row = this.database.prepare("SELECT challenge_json,consumed_at FROM clock_challenges WHERE id=? AND match_id=? AND account_id=?").get(challengeId, matchId, principal.accountId);
    if (!row) throw new AccessError("NOT_FOUND", 404, "That challenge is unavailable.");
    const challenge = JSON.parse(row.challenge_json);
    if (row.consumed_at !== null) throw new AccessError("CLOCK_CHALLENGE_CONSUMED", 409, "That clock exchange was consumed. Retrying the same request key returns its receipt.");
    if (challenge.controllerEpoch !== grant.epoch || challenge.deviceId !== grant.device_id || grant.frozen) throw new AccessError("CLOCK_SCOPE_CONFLICT", 409, "The controller changed before the clock exchange completed.");
    let mapping;
    try {
      mapping = acknowledgeClockChallenge(challenge, sample, this.now(), policy);
    } catch {
      throw new AccessError("CLOCK_EXCHANGE_REJECTED", 422, "The clock exchange expired or its evidence exceeds the configured uncertainty bounds.");
    }
    this.database.prepare("UPDATE clock_challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL").run(this.now(), challengeId);
    this.database.prepare("INSERT INTO clock_mappings(challenge_id,match_id,mapping_json,created_at) VALUES(?,?,?,?)").run(challengeId, matchId, JSON.stringify(mapping), this.now());
    this.audit(principal, "clock.mapping_established", matchId, policy.id);
    return mapping;
  }
  reconciliation(principal, matchId) {
    const row = this.managerMatch(principal, matchId);
    const state = JSON.parse(row.state_json);
    const events = this.database.prepare("SELECT event_id,device_id,client_sequence,envelope_json,reason,received_at FROM events WHERE match_id=? AND disposition='quarantined' ORDER BY received_at,client_sequence").all(matchId);
    const conflicts = this.database.prepare("SELECT id,original_json,reason,created_at FROM conflicting_submissions WHERE match_id=? ORDER BY created_at,id").all(matchId);
    const submissions = [...events.map((event) => {
      const original = JSON.parse(event.envelope_json);
      return { submissionId: event.event_id, matchId, eventId: event.event_id, deviceId: event.device_id, clientSequence: event.client_sequence, controllerEpoch: original.controllerEpoch ?? null, reason: event.reason, original, originalDigest: digest(canonical4(original)), receivedAt: new Date(event.received_at).toISOString() };
    }), ...conflicts.map((conflict) => {
      const original = JSON.parse(conflict.original_json);
      return { submissionId: conflict.id, matchId, eventId: typeof original.eventId === "string" ? original.eventId : null, deviceId: typeof original.deviceId === "string" ? original.deviceId : null, clientSequence: typeof original.clientSequence === "number" ? original.clientSequence : null, controllerEpoch: typeof original.controllerEpoch === "number" ? original.controllerEpoch : null, reason: conflict.reason, original, originalDigest: digest(canonical4(original)), receivedAt: new Date(conflict.created_at).toISOString() };
    })];
    const proposals = this.database.prepare("SELECT receipt_json FROM reconciliation_proposals WHERE match_id=? ORDER BY created_at,id").all(matchId).map((item) => JSON.parse(item.receipt_json));
    return { matchId, acceptedRevision: state.revision, submissions, proposals, policy: Q08_RECONCILIATION_POLICY };
  }
  proposeReconciliation(principal, matchId, input) {
    const row = this.managerMatch(principal, matchId);
    const state = JSON.parse(row.state_json);
    if (!input || Object.keys(input).some((key) => !["proposalId", "baseRevision", "sourceSubmissionIds", "reason", "resolution", "commands"].includes(key))) bad("Use only the documented immutable reconciliation proposal fields.");
    const signature2 = digest(canonical4(input));
    const existing = this.database.prepare("SELECT signature,receipt_json FROM reconciliation_proposals WHERE id=? AND match_id=? AND actor_id=?").get(input.proposalId, matchId, principal.accountId);
    if (existing) {
      if (existing.signature !== signature2) throw new AccessError("RECONCILIATION_PROPOSAL_CONFLICT", 409, "That proposal identity already preserves different review evidence.");
      return JSON.parse(existing.receipt_json);
    }
    const snapshot = this.reconciliation(principal, matchId);
    const preview = previewReconciliation(state, input, snapshot.submissions, { actorId: principal.accountId, recordedAtMs: this.now() });
    if (!preview.valid) throw new AccessError("RECONCILIATION_PREVIEW_REJECTED", 422, preview.issues.join(" ").slice(0, 1500));
    const { projectedState: discarded, ...savedPreview } = preview;
    void discarded;
    const receipt = { input, matchId, actorId: principal.accountId, createdAt: new Date(this.now()).toISOString(), sourceDigests: input.sourceSubmissionIds.map((id) => ({ submissionId: id, originalDigest: snapshot.submissions.find((item) => item.submissionId === id).originalDigest })), acceptedStateDigest: digest(canonical4(state)), preview: savedPreview, status: "prepared", appliedRevision: null };
    this.database.prepare("INSERT INTO reconciliation_proposals(id,match_id,actor_id,signature,receipt_json,created_at) VALUES(?,?,?,?,?,?)").run(input.proposalId, matchId, principal.accountId, signature2, JSON.stringify(receipt), this.now());
    this.audit(principal, "reconciliation.proposal_prepared", matchId, "q08_authority_unapproved");
    return receipt;
  }
  recordFinishedContext(principal, matchId, policy) {
    const row = this.managerMatch(principal, matchId);
    const state = JSON.parse(row.state_json);
    if (state.status !== "completed") return { status: "not_finished" };
    this.refreshDetailedArchive(row, state);
    const community = this.communityState(row.team_id, row.season_id);
    const existing = community.matches.find((item) => item.id === matchId);
    const quarantine = this.database.prepare("SELECT event_id FROM events WHERE match_id=? AND disposition='quarantined' LIMIT 1").get(matchId);
    const conflict = this.database.prepare("SELECT id FROM conflicting_submissions WHERE match_id=? LIMIT 1").get(matchId);
    const unresolved = Boolean(quarantine || conflict);
    if (existing) {
      const retainedFinishId = state.eventHistory?.filter((event) => event.type === "half.ended").at(-1)?.id;
      const retainedFinish = retainedFinishId ? this.database.prepare("SELECT envelope_json FROM events WHERE event_id=? AND match_id=? AND disposition='accepted'").get(retainedFinishId, matchId) : void 0;
      const currentGrant = this.database.prepare("SELECT epoch FROM controller_grants WHERE match_id=?").get(matchId);
      const sourceEpoch = retainedFinish ? JSON.parse(retainedFinish.envelope_json).controllerEpoch : null;
      const quality = unresolved ? "conflicted" : state.recoveryRequired || sourceEpoch !== currentGrant?.epoch || finishEligibilityChanged(state, existing) ? "review_required" : existing.finishQuality;
      if (quality !== existing.finishQuality) {
        const next2 = { ...community, revision: community.revision + 1, matches: community.matches.map((match) => match.id === matchId ? { ...match, finishQuality: quality } : match), audit: [...community.audit, { id: randomUUID2(), actorAccountId: null, action: "service.finish_evidence_flagged_without_reopening", atMs: this.now() }] };
        this.saveDocument(row.team_id, row.season_id, "community", next2);
      }
      return { status: "original_context_preserved", finishQuality: quality };
    }
    const finishId = state.eventHistory?.filter((event) => event.type === "half.ended").at(-1)?.id;
    const finishRow = finishId ? this.database.prepare("SELECT envelope_json,actor_id FROM events WHERE event_id=? AND match_id=? AND disposition='accepted'").get(finishId, matchId) : void 0;
    const finish = finishRow ? JSON.parse(finishRow.envelope_json) : null;
    const mappingRow = finish ? this.database.prepare("SELECT mapping_json FROM clock_mappings WHERE challenge_id=? AND match_id=?").get(finish.clockEvidence.anchorId, matchId) : void 0;
    const grant = this.database.prepare("SELECT epoch FROM controller_grants WHERE match_id=?").get(matchId);
    const preparation = this.document(row.team_id, row.season_id, "preparation");
    const fixture = preparation.fixtures.find((item) => item.id === matchId && item.seasonId === row.season_id);
    const playedDate = state.config.fixture?.playedDate ?? fixture?.playedDate;
    if (!playedDate) return { status: "accepted_fixture_date_required" };
    const scheduledAtMs = Date.parse(`${playedDate}T00:00:00Z`);
    const context = deriveFinishedMatchContext({ state, acceptedFinish: finish, acceptedFinishActorId: finishRow?.actor_id ?? null, teamId: row.team_id, seasonId: row.season_id, currentControllerEpoch: grant?.epoch ?? 0, unresolvedConflicts: unresolved, mapping: mappingRow ? JSON.parse(mappingRow.mapping_json) : null, policy: policy ?? null, serverNowMs: this.now(), scheduledAtMs, sharing: "manager_only", sharingPolicyVersion: 0 });
    const next = { ...community, revision: community.revision + 1, matches: [...community.matches, { ...context, voteCutoffAtMs: null, cutoffSource: "unresolved", finalisationDeadlineAtMs: context.actualFullTimeAtMs === null ? null : context.actualFullTimeAtMs + 36e5 }], audit: [...community.audit, { id: randomUUID2(), actorAccountId: null, action: "service.accepted_finish_registered_manager_only", atMs: this.now() }] };
    this.saveDocument(row.team_id, row.season_id, "community", next);
    return { status: "registered_from_accepted_history", finishQuality: context.finishQuality };
  }
  refreshDetailedArchive(row, match) {
    const saved = this.database.prepare("SELECT value_json FROM documents WHERE team_id=? AND season_id=? AND kind='records'").get(row.team_id, row.season_id);
    if (!saved) return;
    const records = JSON.parse(saved.value_json);
    const archived = records.results.find((item) => item.id === match.config.matchId && item.recordMode === "detailed_live");
    if (!archived || (archived.sourceMatchRevision ?? -1) >= match.revision) return;
    if (match.recoveryRequired) {
      if (archived.detailCompleteness !== "review_required") {
        const reviewed = { ...records, revision: records.revision + 1, results: records.results.map((item) => item.id === archived.id ? { ...item, detailCompleteness: "review_required", revision: item.revision + 1 } : item) };
        this.saveDocument(row.team_id, row.season_id, "records", reviewed);
      }
      return;
    }
    const context = { matchId: archived.id, playedDate: archived.playedDate, opponent: archived.opponent, homeAway: archived.homeAway, fixtureClass: archived.fixtureClass };
    const updated = reduceRecords({ ...records, liveMatch: context }, { type: "live.archive", commandId: `accepted-archive-${digest(canonical4([archived.id, match.revision]))}`, at: new Date(this.now()).toISOString(), actor: "manager", match, reason: "Existing detailed archive refreshed from the newer accepted canonical match revision; original source events and prior archive audit remain retained." });
    const projected = { ...updated, liveMatch: records.liveMatch };
    this.saveDocument(row.team_id, row.season_id, "records", projected);
  }
  upload(principal, matchId, token, values) {
    const row = this.managerMatch(principal, matchId);
    if (!Array.isArray(values) || values.length === 0 || values.length > 100) bad("Upload between one and 100 ordered events.");
    const grant = this.database.prepare("SELECT * FROM controller_grants WHERE match_id=?").get(matchId);
    const currentCapability = !!grant && grant.account_id === principal.accountId && !!token && digest(token) === grant.capability_hash;
    let state = JSON.parse(row.state_json);
    const results = [];
    for (const value of values) {
      const event = validateEnvelope(value, matchId);
      const device = this.database.prepare("SELECT account_id FROM devices WHERE id=?").get(event.deviceId);
      if (!device || device.account_id !== principal.accountId) throw new AccessError("DEVICE_BINDING_REQUIRED", 403, "This event device is not enrolled to the authenticated account.");
      const signature2 = digest(canonical4(event));
      const previous = this.database.prepare("SELECT * FROM events WHERE event_id=?").get(event.eventId);
      if (previous) {
        if (previous.match_id !== matchId || previous.signature !== signature2) {
          this.database.prepare("INSERT INTO conflicting_submissions VALUES(?,?,?,?,?,?)").run(randomUUID2(), matchId, principal.accountId, JSON.stringify(value), "EVENT_ID_CONFLICT", this.now());
          results.push({ eventId: event.eventId, clientSequence: event.clientSequence, disposition: "quarantined", reason: "EVENT_ID_CONFLICT", revision: null, duplicate: false });
        } else results.push({ eventId: previous.event_id, clientSequence: previous.client_sequence, disposition: previous.disposition, reason: previous.reason, revision: previous.revision, duplicate: true });
        continue;
      }
      const stream = this.database.prepare("SELECT sequence,previous_event_id FROM streams WHERE match_id=? AND device_id=?").get(matchId, event.deviceId);
      if (event.clientSequence !== (stream?.sequence ?? 0) + 1 || event.previousEventId !== (stream?.previous_event_id ?? null)) {
        this.database.prepare("INSERT INTO conflicting_submissions VALUES(?,?,?,?,?,?)").run(randomUUID2(), matchId, principal.accountId, JSON.stringify(value), "SEQUENCE_GAP_OR_REUSE", this.now());
        results.push({ eventId: event.eventId, clientSequence: event.clientSequence, disposition: "quarantined", reason: "SEQUENCE_GAP_OR_REUSE", revision: null, duplicate: false });
        continue;
      }
      let reason = null;
      if (event.contractVersion !== EVENT_CONTRACT_VERSION || event.schemaVersion !== 1 || event.engineVersion !== ENGINE_VERSION) reason = "UNSUPPORTED_EVENT_VERSION";
      else if (!grant || !currentCapability || event.controllerEpoch !== grant.epoch || event.deviceId !== grant.device_id) reason = "STALE_CONTROLLER";
      else if (grant.frozen) reason = "HANDOVER_WRITES_FROZEN";
      else if (event.baseRevision !== state.revision) reason = "STALE_REVISION";
      if (!reason) {
        try {
          const next = reduceMatch(state, { ...event.command, actorId: principal.accountId });
          const effective = effectiveEventTime(state, next, event.command);
          if (effective.half !== event.effectiveHalf || effective.halfElapsedMs !== event.halfElapsedMs || effective.matchElapsedMs !== event.matchElapsedMs) throw new Error("Effective playing-time evidence differs from the command.");
          state = next;
        } catch {
          reason = "INVALID_MATCH_TRANSITION";
        }
      }
      const disposition = reason ? "quarantined" : "accepted";
      const revision = reason ? null : state.revision;
      this.database.prepare("INSERT INTO events(event_id,match_id,device_id,client_sequence,envelope_json,signature,disposition,reason,revision,received_at,actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(event.eventId, matchId, event.deviceId, event.clientSequence, JSON.stringify(event), signature2, disposition, reason, revision, this.now(), principal.accountId);
      this.database.prepare("INSERT INTO streams(match_id,device_id,sequence,previous_event_id) VALUES(?,?,?,?) ON CONFLICT(match_id,device_id) DO UPDATE SET sequence=excluded.sequence,previous_event_id=excluded.previous_event_id").run(matchId, event.deviceId, event.clientSequence, event.eventId);
      results.push({ eventId: event.eventId, clientSequence: event.clientSequence, disposition, reason, revision, duplicate: false });
    }
    if (results.some((item) => item.disposition === "accepted" && !item.duplicate)) this.database.prepare("UPDATE matches SET state_json=?,last_sync_at=? WHERE id=?").run(JSON.stringify(state), this.now(), matchId);
    this.audit(principal, "events.uploaded", matchId, results.some((item) => item.disposition === "quarantined") ? "review_required" : "accepted");
    if (results.some((item) => item.disposition === "accepted" && !item.duplicate)) this.enqueueNotifications(row.team_id, row.season_id, "match", matchId, `accepted-revision-${state.revision}`);
    return { results, revision: state.revision, pendingReview: results.some((item) => item.disposition === "quarantined") };
  }
  quarantine(principal, matchId) {
    this.managerMatch(principal, matchId);
    return [...this.database.prepare("SELECT event_id,device_id,client_sequence,envelope_json,reason,received_at FROM events WHERE match_id=? AND disposition='quarantined' ORDER BY received_at,client_sequence").all(matchId), ...this.database.prepare("SELECT id,original_json,reason,created_at FROM conflicting_submissions WHERE match_id=? ORDER BY created_at").all(matchId)];
  }
  offerHandover(principal, matchId, token, toAccountId, toDeviceId, baseRevision) {
    const row = this.managerMatch(principal, matchId);
    const grant = this.assertController(principal, matchId, token);
    if (grant.frozen) throw new AccessError("TRANSFER_PENDING", 409, "A controller transfer is already pending.");
    const state = JSON.parse(row.state_json);
    if (state.revision !== baseRevision) throw new AccessError("STALE_REVISION", 409, "Synchronise the accepted checkpoint before handover.");
    if (state.status.endsWith("_running")) throw new AccessError("CLOCK_ANCHOR_REQUIRED", 409, "Running handover requires a verified UTC/device clock exchange. This development service supports handover while the match clock is already paused, at half-time or before kick-off; it never silently pauses play.");
    if (!validId3(toAccountId) || !validDeviceId(toDeviceId)) bad("A target account and canonical device identifier of at most 120 characters are required.");
    const target = this.database.prepare("SELECT * FROM accounts WHERE id=?").get(toAccountId);
    if (!target) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    const targetPrincipal = { accountId: target.id, issuer: target.issuer, subject: target.subject, identityClassification: target.classification, adultVerified: !!target.adult_verified, strongAuth: !!target.strong_auth_enrolled, authenticatedAt: this.now(), status: target.status };
    assertCanManageTeam(targetPrincipal, this.memberships(), row.team_id, row.season_id, this.now());
    const id = randomUUID2();
    this.database.prepare("INSERT INTO transfers VALUES(?,?,?,?,?,?,?)").run(id, matchId, grant.epoch, toAccountId, toDeviceId, "pending", this.now());
    this.database.prepare("UPDATE controller_grants SET frozen=1 WHERE match_id=?").run(matchId);
    this.audit(principal, "controller.transfer_offered", matchId, "pending");
    return { transferId: id, state: "pending", acceptedRevision: state.revision };
  }
  acceptHandover(principal, matchId, transferId, deviceId) {
    this.managerMatch(principal, matchId);
    assertAdultAuthority(principal, false, this.now());
    const transfer = this.database.prepare("SELECT * FROM transfers WHERE id=? AND match_id=?").get(transferId, matchId);
    const grant = this.database.prepare("SELECT * FROM controller_grants WHERE match_id=?").get(matchId);
    if (!transfer || transfer.to_account_id !== principal.accountId || transfer.to_device_id !== deviceId) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    if (transfer.state !== "pending" || !grant || grant.epoch !== transfer.from_epoch || !grant.frozen) throw new AccessError("TRANSFER_CONFLICT", 409, "Check the authoritative transfer status before retrying.");
    this.bindDevice(principal, deviceId);
    const capability = randomBytes(32).toString("base64url");
    const epoch = grant.epoch + 1;
    this.database.prepare("UPDATE controller_grants SET epoch=?,account_id=?,device_id=?,capability_hash=?,frozen=0 WHERE match_id=?").run(epoch, principal.accountId, deviceId, digest(capability), matchId);
    this.database.prepare("UPDATE transfers SET state='accepted' WHERE id=?").run(transferId);
    this.database.prepare("INSERT INTO controller_history VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID2(), matchId, epoch, principal.accountId, grant.device_id, deviceId, "transferred", null, this.now());
    this.audit(principal, "controller.transferred", matchId, "accepted");
    return { epoch, deviceId, controllerToken: capability, checkpoint: this.download(principal, matchId, deviceId).deviceCheckpoint, acceptedRevision: JSON.parse(this.match(matchId).state_json).revision };
  }
  recover(principal, matchId, deviceId, reason) {
    const row = this.managerMatch(principal, matchId);
    assertAdultAuthority(principal, true, this.now());
    if (!validDeviceId(deviceId) || typeof reason !== "string" || reason.trim().length < 5 || reason.length > 500) bad("Recovery needs a target canonical device identifier of at most 120 characters and a concise audit reason.");
    this.bindDevice(principal, deviceId);
    const old = this.database.prepare("SELECT * FROM controller_grants WHERE match_id=?").get(matchId);
    const capability = randomBytes(32).toString("base64url");
    const epoch = (old?.epoch ?? 0) + 1;
    const state = JSON.parse(row.state_json);
    if (state.status.endsWith("_running")) {
      state.recoveryRequired = true;
      state.recoveryReason = "Controller recovery: reconcile the referee clock and any unsynchronised old-device events.";
      this.database.prepare("UPDATE matches SET state_json=? WHERE id=?").run(JSON.stringify(state), matchId);
    }
    this.database.prepare("INSERT INTO controller_grants(match_id,epoch,account_id,device_id,capability_hash,frozen) VALUES(?,?,?,?,?,0) ON CONFLICT(match_id) DO UPDATE SET epoch=excluded.epoch,account_id=excluded.account_id,device_id=excluded.device_id,capability_hash=excluded.capability_hash,frozen=0").run(matchId, epoch, principal.accountId, deviceId, digest(capability));
    this.database.prepare("UPDATE transfers SET state='superseded' WHERE match_id=? AND state='pending'").run(matchId);
    this.database.prepare("INSERT INTO controller_history VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID2(), matchId, epoch, principal.accountId, old?.device_id ?? null, deviceId, "recovered", reason.trim(), this.now());
    this.audit(principal, "controller.recovered", matchId, "reconciliation_required");
    return { epoch, deviceId, controllerToken: capability, reconciliationRequired: true, checkpoint: this.download(principal, matchId, deviceId).deviceCheckpoint };
  }
  staffRevision(teamId, seasonId) {
    const row = this.database.prepare("SELECT revision FROM documents WHERE team_id=? AND season_id=? AND kind='staff'").get(teamId, seasonId);
    return row?.revision ?? 0;
  }
  bumpStaffRevision(teamId, seasonId) {
    const revision = this.staffRevision(teamId, seasonId) + 1;
    this.saveDocument(teamId, seasonId, "staff", { revision });
    return revision;
  }
  managers(principal, teamId, seasonId, requestedRole) {
    assertTeamRole(principal, this.memberships(), teamId, seasonId, ["administrator"], this.now());
    assertAdultAuthority(principal, false, this.now());
    const accounts = this.database.prepare("SELECT * FROM accounts WHERE id IN (SELECT account_id FROM memberships WHERE team_id=?)").all(teamId);
    const community = this.document(teamId, seasonId, "community");
    const evidence2 = accounts.map((account2) => ({ accountId: account2.id, label: community.accounts.find((item) => item.id === account2.id)?.label ?? "Verified adult account", status: account2.status, identityClassification: account2.classification, adultVerified: Boolean(account2.adult_verified), strongAuthEnrolled: Boolean(account2.strong_auth_enrolled) }));
    return managerRoster({ principal, memberships: this.memberships(), accounts: evidence2, teamId, seasonId, nowMs: this.now(), revision: this.staffRevision(teamId, seasonId), requestedRole });
  }
  assignManager(actor, teamId, seasonId, accountId, expectedRevision) {
    assertTeamRole(actor, this.memberships(), teamId, seasonId, ["administrator"], this.now());
    assertAdultAuthority(actor, true, this.now());
    if (!validId3(accountId)) bad("A canonical account identifier is required.");
    if (expectedRevision !== void 0 && (!nonnegative3(expectedRevision) || expectedRevision !== this.staffRevision(teamId, seasonId))) throw new AccessError("STALE_REVISION", 409, "Refresh the current staff assignments before changing them.");
    const account2 = this.database.prepare("SELECT * FROM accounts WHERE id=?").get(accountId);
    if (!account2) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    const target = { accountId: account2.id, issuer: account2.issuer, subject: account2.subject, identityClassification: account2.classification, adultVerified: !!account2.adult_verified, strongAuth: !!account2.strong_auth_enrolled, authenticatedAt: this.now(), status: account2.status };
    assertCanAssignManager(actor, target, this.memberships(), teamId, seasonId, this.now());
    const alreadyActive = this.memberships().some((item) => item.accountId === accountId && item.teamId === teamId && item.seasonId === seasonId && item.role === "manager" && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > this.now()));
    if (!alreadyActive) {
      this.database.prepare("INSERT INTO memberships(account_id,team_id,season_id,role) VALUES(?,?,?,'manager') ON CONFLICT(account_id,team_id,season_id,role) DO UPDATE SET revoked_at=NULL,expires_at=NULL").run(accountId, teamId, seasonId);
      this.bumpStaffRevision(teamId, seasonId);
      this.audit(actor, "manager.assigned", teamId, "accepted");
    }
    return { accountId, teamId, seasonId, role: "manager", revision: this.staffRevision(teamId, seasonId), acceptedAt: new Date(this.now()).toISOString() };
  }
  revokeManager(actor, teamId, seasonId, input, expectedRevision) {
    assertTeamRole(actor, this.memberships(), teamId, seasonId, ["administrator"], this.now());
    assertAdultAuthority(actor, true, this.now());
    if (!input || Object.keys(input).some((key) => !["accountId", "reason", "confirmRevocation"].includes(key)) || !validId3(input.accountId) || input.confirmRevocation !== true || typeof input.reason !== "string" || input.reason.trim().length < 5 || input.reason.length > 500) bad("Confirm a scoped manager revocation and record its evidence reason.");
    if (expectedRevision !== void 0 && (!nonnegative3(expectedRevision) || expectedRevision !== this.staffRevision(teamId, seasonId))) throw new AccessError("STALE_REVISION", 409, "Refresh the current staff assignments before changing them.");
    const member = this.database.prepare("SELECT account_id,revoked_at FROM memberships WHERE account_id=? AND team_id=? AND season_id=? AND role='manager'").get(input.accountId, teamId, seasonId);
    if (!member) throw new AccessError("NOT_FOUND", 404, "That manager assignment is outside this scope.");
    if (member.revoked_at === null) {
      this.database.prepare("UPDATE memberships SET revoked_at=? WHERE account_id=? AND team_id=? AND season_id=? AND role='manager'").run(this.now(), input.accountId, teamId, seasonId);
      this.database.prepare("UPDATE controller_grants SET frozen=1 WHERE account_id=? AND match_id IN (SELECT id FROM matches WHERE team_id=? AND season_id=?)").run(input.accountId, teamId, seasonId);
      this.bumpStaffRevision(teamId, seasonId);
      this.audit(actor, "manager.assignment_revoked", input.accountId, input.reason.trim());
    }
    return { accountId: input.accountId, teamId, seasonId, role: "manager", revision: this.staffRevision(teamId, seasonId), acceptedAt: new Date(this.now()).toISOString(), revoked: true, controllerFrozen: true, otherSeasonAssignmentsRetained: true, remainingActiveTeamSeasons: this.memberships().filter((item) => item.accountId === input.accountId && item.teamId === teamId && item.role === "manager" && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > this.now())).map((item) => item.seasonId) };
  }
  privacyRecords(principal) {
    const rows = this.database.prepare("SELECT id,account_id,kind,status,team_id,season_id,affected_memberships_json,created_at FROM privacy_requests WHERE account_id=? ORDER BY created_at,id").all(principal.accountId);
    return rows.map((row) => ({ requestId: row.id, accountId: row.account_id, kind: row.kind, status: row.status, scope: row.kind === "leave_team" ? row.team_id && row.season_id ? { type: "team_season", teamId: row.team_id, seasonId: row.season_id } : null : { type: "all_memberships" }, affectedMemberships: row.affected_memberships_json === null ? null : JSON.parse(row.affected_memberships_json), createdAtMs: row.created_at }));
  }
  privacyRequest(principal, input) {
    const plan = prepareAccountPrivacyRequest({ principal, memberships: this.memberships(), input, nowMs: this.now() });
    const pending = this.database.prepare("SELECT p.id FROM privacy_pending_keys k JOIN privacy_requests p ON p.id=k.request_id WHERE k.business_key=? AND p.account_id=? AND p.status='pending_verification_and_policy'").get(plan.businessKey, principal.accountId);
    let requestId = pending?.id;
    if (!requestId) {
      const retained = plan.scope.type === "team_season" ? this.database.prepare("SELECT id FROM privacy_requests WHERE account_id=? AND kind=? AND team_id=? AND season_id=? AND status='pending_verification_and_policy' ORDER BY created_at,id LIMIT 1").get(principal.accountId, plan.kind, plan.scope.teamId, plan.scope.seasonId) : this.database.prepare("SELECT id FROM privacy_requests WHERE account_id=? AND kind=? AND team_id IS NULL AND season_id IS NULL AND status='pending_verification_and_policy' ORDER BY created_at,id LIMIT 1").get(principal.accountId, plan.kind);
      requestId = retained?.id;
    }
    if (!requestId) {
      requestId = randomUUID2();
      this.database.prepare("INSERT INTO privacy_requests(id,account_id,kind,status,policy_version,verified_at,created_at,team_id,season_id,affected_memberships_json) VALUES(?,?,?,?,NULL,NULL,?,?,?,?)").run(requestId, principal.accountId, plan.kind, plan.status, this.now(), plan.scope.type === "team_season" ? plan.scope.teamId : null, plan.scope.type === "team_season" ? plan.scope.seasonId : null, JSON.stringify(plan.affectedMemberships));
      this.audit(principal, "privacy.requested", requestId, "pending_verification_and_policy");
    }
    this.database.prepare("INSERT INTO privacy_pending_keys(business_key,request_id) VALUES(?,?) ON CONFLICT(business_key) DO UPDATE SET request_id=excluded.request_id").run(plan.businessKey, requestId);
    return this.privacyRequests(principal).items.find((item) => item.requestId === requestId);
  }
  privacyRequests(principal) {
    return projectAccountPrivacyRequests({ principal, memberships: this.memberships(), records: this.privacyRecords(principal), nowMs: this.now() });
  }
  /** Explicit setup seam: an authorised operator imports verified provider-to-account mappings; no token creates authority. */
  bindIdentity(accountId, issuer, subject) {
    this.database.prepare("UPDATE accounts SET issuer=?,subject=? WHERE id=?").run(issuer, subject, accountId);
  }
  bindDevice(principal, deviceId) {
    const device = this.database.prepare("SELECT account_id FROM devices WHERE id=?").get(deviceId);
    if (device && device.account_id !== principal.accountId) throw new AccessError("DEVICE_ACCOUNT_CONFLICT", 409, "Enrol a separate device identity for this account.");
    this.database.prepare("INSERT INTO devices(id,account_id) VALUES(?,?) ON CONFLICT(id) DO NOTHING").run(deviceId, principal.accountId);
  }
  teamMatches(principal, teamId, seasonId, requestedRole, query = { limit: 25, cursor: null }) {
    const memberships = this.memberships();
    const audience = matchPageAudience(principal, memberships, teamId, seasonId, requestedRole, this.now());
    const scope = { principal, teamId, seasonId, role: audience.role, playerId: audience.playerId ?? null }, afterId = matchPagePosition(scope, query);
    const rows = this.database.prepare("SELECT id,state_json,sharing_policy_json,last_sync_at FROM matches WHERE team_id=? AND season_id=? AND (? IS NULL OR id > ?) ORDER BY id COLLATE BINARY LIMIT ?").all(teamId, seasonId, afterId, afterId, query.limit + 1);
    const visible = rows.slice(0, query.limit);
    return { items: visible.map((row) => filterMatchForPrincipal({ principal, memberships, teamId, seasonId, state: JSON.parse(row.state_json), policy: JSON.parse(row.sharing_policy_json), lastSyncAt: row.last_sync_at, requestedRole, now: this.now() })), nextCursor: rows.length > query.limit ? matchPageCursor(scope, visible[visible.length - 1].id) : null, serverTime: new Date(this.now()).toISOString() };
  }
  document(teamId, seasonId, kind) {
    const row = this.database.prepare("SELECT value_json FROM documents WHERE team_id=? AND season_id=? AND kind=?").get(teamId, seasonId, kind);
    if (!row) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    return JSON.parse(row.value_json);
  }
  saveDocument(teamId, seasonId, kind, state) {
    this.database.prepare("INSERT INTO documents(team_id,season_id,kind,revision,value_json) VALUES(?,?,?,?,?) ON CONFLICT(team_id,season_id,kind) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json").run(teamId, seasonId, kind, state.revision, JSON.stringify(state));
  }
  enqueueNotifications(teamId, seasonId, category, entityId, sourceId) {
    const recipients = /* @__PURE__ */ new Map();
    const priority = { manager: 3, player: 2, spectator: 1, administrator: 0 };
    for (const member of this.memberships().filter((item) => item.teamId === teamId && item.seasonId === seasonId && ["manager", "player", "spectator"].includes(item.role) && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > this.now()))) {
      const current3 = recipients.get(member.accountId);
      if (!current3 || priority[member.role] > priority[current3.role]) recipients.set(member.accountId, member);
    }
    let inserted = 0;
    for (const member of recipients.values()) {
      if (member.role === "administrator" || member.role === "player" && !member.playerId) continue;
      const businessKey = `notify:${digest(canonical4([teamId, seasonId, category, entityId, sourceId, member.accountId, member.role]))}`;
      const job = createTeamNotificationJob({ id: randomUUID2(), businessKey, accountId: member.accountId, teamId, seasonId, audience: member.role, playerId: member.role === "player" ? member.playerId : null, category, entityId, dueAtMs: this.now() });
      const result = this.database.prepare("INSERT INTO jobs(id,business_key,kind,payload_json,due_at) VALUES(?,?,'notification.dispatch',?,?) ON CONFLICT(business_key) DO NOTHING").run(job.id, businessKey, JSON.stringify(job), job.dueAtMs);
      inserted += Number(result.changes);
    }
    return inserted;
  }
  preparation(principal, teamId, seasonId) {
    assertCanManageTeam(principal, this.memberships(), teamId, seasonId, this.now());
    return this.document(teamId, seasonId, "preparation");
  }
  configuration(principal, teamId, seasonId, role) {
    if (role) assertTeamRole(principal, this.memberships(), teamId, seasonId, role === "manager" || role === "administrator" ? [role] : [], this.now());
    const state = this.document(teamId, seasonId, "preparation");
    return configurationServiceView({ principal, memberships: this.memberships(), preparation: state, seasonId, nowMs: this.now() });
  }
  configurationCommand(principal, teamId, seasonId, command, role) {
    this.configuration(principal, teamId, seasonId, role);
    if (!command || !["club.updated", "team.updated"].includes(command.type)) bad("Only club or team configuration can be changed in this context.");
    if (role && command.type === "club.updated" && role !== "administrator") throw new AccessError("NOT_FOUND", 404, "Choose the current administrator context to administer the club.");
    const state = applyConfigurationServiceCommand({ principal, memberships: this.memberships(), preparation: this.document(teamId, seasonId, "preparation"), seasonId, nowMs: this.now(), command });
    this.saveDocument(teamId, seasonId, "preparation", state);
    this.audit(principal, command.type, teamId, "administrator_configuration_accepted");
    return this.configuration(principal, teamId, seasonId, role);
  }
  seasonContext(principal, teamId, seasonId) {
    const community = this.communityState(teamId, seasonId);
    const accounts = this.database.prepare("SELECT * FROM accounts").all();
    const preparationDocuments = this.database.prepare("SELECT value_json FROM documents WHERE team_id=? AND kind='preparation'").all(teamId);
    const existingSeasons = preparationDocuments.flatMap((row) => JSON.parse(row.value_json).seasons.map((season) => ({ teamId, id: season.id, startYear: season.startYear })));
    return {
      principal,
      memberships: this.memberships(),
      existingSeasons,
      nowMs: this.now(),
      preparation: this.document(teamId, seasonId, "preparation"),
      records: this.document(teamId, seasonId, "records"),
      community,
      accounts: accounts.map((account2) => ({ accountId: account2.id, label: community.accounts.find((item) => item.id === account2.id)?.label ?? "Verified account", status: account2.status, identityClassification: account2.classification, adultVerified: Boolean(account2.adult_verified), strongAuthEnrolled: Boolean(account2.strong_auth_enrolled) }))
    };
  }
  seasonOptions(principal, teamId, seasonId) {
    return seasonRolloverOptions(this.seasonContext(principal, teamId, seasonId));
  }
  createSeason(principal, teamId, seasonId, command) {
    const context = this.seasonContext(principal, teamId, seasonId);
    const plan = planSeasonRollover({ ...context, command });
    if (this.database.prepare("SELECT kind FROM documents WHERE team_id=? AND season_id=? LIMIT 1").get(teamId, plan.receipt.seasonId)) throw new AccessError("SEASON_EXISTS", 409, "That destination season already has saved documents.");
    for (const member of plan.memberships) this.database.prepare("INSERT INTO memberships(account_id,team_id,season_id,role,player_id,expires_at,revoked_at) VALUES(?,?,?,?,?,?,?)").run(member.accountId, member.teamId, member.seasonId, member.role, member.playerId ?? null, member.expiresAt ?? null, member.revokedAt ?? null);
    this.saveDocument(teamId, plan.receipt.seasonId, "preparation", plan.preparation);
    this.saveDocument(teamId, plan.receipt.seasonId, "records", plan.records);
    this.saveDocument(teamId, plan.receipt.seasonId, "community", plan.community);
    this.audit(principal, "season.created_from_explicit_assignments", plan.receipt.seasonId, "accepted_no_spectator_renewal");
    return plan.receipt;
  }
  /** Called inside the preparation mutation transaction; current labels never rewrite saved match evidence. */
  projectPreparationRecords(teamId, seasonId, preparation, sourceCommandId) {
    const previous = this.document(teamId, seasonId, "records");
    const labels = new Map(previous.players.map((player) => [player.id, player]));
    for (const profile of preparation.profiles.filter((profile2) => profile2.seasonId === seasonId)) labels.set(profile.playerId, { id: profile.playerId, label: profile.displayName });
    const players = [...labels.values()];
    const evidence2 = trainingAttendanceEvidence({ ...preparation, training: preparation.training.filter((session) => session.seasonId === seasonId) });
    let records = previous;
    const at = new Date(this.now()).toISOString();
    if (canonical4(players) !== canonical4(previous.players)) records = {
      ...records,
      players,
      revision: records.revision + 1,
      audit: [...records.audit, { commandId: `preparation-roster-${sourceCommandId}`, action: "preparation.roster.projected", matchId: null, at, reason: "Current season roster labels updated from preparation; saved match snapshots preserved.", before: null, after: null }]
    };
    if (canonical4(evidence2) !== canonical4(previous.trainingAttendance)) records = reduceRecords(records, { type: "training.evidence.replace", commandId: `preparation-training-${sourceCommandId}`, at, actor: "manager", evidence: evidence2 });
    if (records !== previous) this.saveDocument(teamId, seasonId, "records", records);
  }
  preparationCommand(principal, teamId, seasonId, command) {
    const previous = this.preparation(principal, teamId, seasonId);
    const types2 = ["club.updated", "team.updated", "season.rolled_over", "profile.saved", "roster.imported", "profile.archived", "formation.saved", "fixture.saved", "fixture.status_changed", "fixture.response_recorded", "fixture.selection_saved", "fixture.attendance_recorded", "fixture.prepared", "match_plan.saved", "match_plan.applied", "match_plan.cleared", "training.series_created", "training.series_updated", "training.series_cancelled", "training.saved", "training.status_changed", "training.response_recorded", "training.attendance_recorded"];
    if (!command || !types2.includes(command.type)) bad("Unsupported preparation command.");
    if (command.type === "season.rolled_over") throw new AccessError("SEASON_ASSIGNMENT_REQUIRED", 503, "A connected new season requires approved manager/player assignments and explicit spectator renewal. The local rehearsal supports rollover; this service will not save an inaccessible new season or silently copy authority.");
    if (command.type === "club.updated") {
      assertTeamRole(principal, this.memberships(), teamId, seasonId, ["administrator"], this.now());
      assertAdultAuthority(principal, true, this.now());
    }
    const protectedFixtureIds = [];
    if (command.type === "match_plan.applied") {
      const match = this.database.prepare("SELECT state_json FROM matches WHERE id=? AND team_id=? AND season_id=?").get(command.fixtureId, teamId, seasonId);
      if (match) {
        const accepted2 = JSON.parse(match.state_json);
        if (accepted2.status !== "preparation" || accepted2.revision !== 0 || this.database.prepare("SELECT match_id FROM controller_grants WHERE match_id=?").get(command.fixtureId) || this.database.prepare("SELECT event_id FROM events WHERE match_id=? LIMIT 1").get(command.fixtureId)) protectedFixtureIds.push(command.fixtureId);
      }
    }
    const state = reducePreparation(previous, command, { nowMs: this.now(), protectedFixtureIds });
    if (command.type === "fixture.prepared") {
      const snapshot = state.snapshots.find((snapshot2) => snapshot2.fixtureId === command.fixtureId && snapshot2.preparedRevision === command.expectedRevision + 1);
      if (!snapshot) throw new AccessError("PREPARATION_SNAPSHOT_REQUIRED", 409, "The immutable prepared fixture snapshot is unavailable.");
      assertCanManageTeam(principal, this.memberships(), teamId, snapshot.seasonId, this.now());
      const config = fixtureMatchConfig(state, snapshot);
      const existing = this.database.prepare("SELECT * FROM matches WHERE id=?").get(config.matchId);
      if (!existing) this.insertMatch(config, teamId, snapshot.seasonId);
      else {
        if (existing.team_id !== teamId || existing.season_id !== snapshot.seasonId) throw new AccessError("MATCH_SCOPE_CONFLICT", 409, "That fixture identity already belongs to another match scope.");
        if (canonical4(JSON.parse(existing.config_json)) !== canonical4(config)) {
          const matchState = JSON.parse(existing.state_json);
          const claimed = this.database.prepare("SELECT match_id FROM controller_grants WHERE match_id=?").get(config.matchId);
          const history = this.database.prepare("SELECT event_id FROM events WHERE match_id=? LIMIT 1").get(config.matchId);
          if (claimed || history || matchState.revision !== 0 || matchState.status !== "preparation") throw new AccessError("MATCH_HISTORY_EXISTS", 409, "This match already has a controller or recorded history. Preserve its saved snapshot and reconcile changes explicitly.");
          this.database.prepare("UPDATE matches SET config_json=?,state_json=? WHERE id=?").run(JSON.stringify(config), JSON.stringify(createMatch(config)), config.matchId);
        }
      }
    }
    if (command.type.startsWith("training.") || command.type.startsWith("profile.") || command.type === "roster.imported") this.projectPreparationRecords(teamId, seasonId, state, command.id);
    this.saveDocument(teamId, seasonId, "preparation", state);
    this.audit(principal, command.type, teamId, "accepted");
    if (command.type === "fixture.saved") this.enqueueNotifications(teamId, seasonId, "schedule", command.fixture.id, command.id);
    else if (command.type === "fixture.status_changed" || command.type === "fixture.selection_saved") this.enqueueNotifications(teamId, seasonId, "schedule", command.fixtureId, command.id);
    else if (command.type === "training.saved") this.enqueueNotifications(teamId, seasonId, "schedule", command.training.id, command.id);
    else if (command.type === "training.status_changed") this.enqueueNotifications(teamId, seasonId, "schedule", command.trainingId, command.id);
    else if (command.type === "training.series_created") for (const occurrence of command.occurrences) this.enqueueNotifications(teamId, seasonId, "schedule", occurrence.id, command.id);
    else if (command.type === "training.series_updated" || command.type === "training.series_cancelled") for (const id of command.occurrenceIds) this.enqueueNotifications(teamId, seasonId, "schedule", id, command.id);
    return state;
  }
  ownPreparation(principal, teamId, seasonId) {
    const membership = assertTeamRole(principal, this.memberships(), teamId, seasonId, ["player"], this.now());
    const state = this.document(teamId, seasonId, "preparation");
    const profiles = state.profiles.filter((profile2) => profile2.playerId === membership.playerId && profile2.seasonId === seasonId && profile2.active);
    if (profiles.length !== 1) throw new AccessError("NOT_FOUND", 404, "The requested own-player profile is unavailable.");
    const profile = profiles[0];
    return projectOwnPlayerPreparation(state, profile, seasonId);
  }
  ownPreparationCommand(principal, teamId, seasonId, command) {
    const membership = assertTeamRole(principal, this.memberships(), teamId, seasonId, ["player"], this.now());
    if (!command || !validId3(command.id) || !nonnegative3(command.expectedRevision) || !["own.preferences_saved", "own.fixture_response_recorded", "own.training_response_recorded"].includes(command.type)) bad("A valid own-player command and source revision are required.");
    const allowed = command.type === "own.preferences_saved" ? ["id", "expectedRevision", "type", "preferences"] : command.type === "own.fixture_response_recorded" ? ["id", "expectedRevision", "type", "fixtureId", "response"] : ["id", "expectedRevision", "type", "trainingId", "response"];
    if (Object.keys(command).some((key) => !allowed.includes(key))) bad("Own-player commands cannot change another profile or manager-controlled fields.");
    const state = this.document(teamId, seasonId, "preparation");
    const profiles = state.profiles.filter((profile2) => profile2.playerId === membership.playerId && profile2.seasonId === seasonId && profile2.active);
    if (profiles.length !== 1) throw new AccessError("NOT_FOUND", 404, "The requested own-player profile is unavailable.");
    const profile = profiles[0];
    const base = { id: command.id, expectedRevision: command.expectedRevision };
    const bound = command.type === "own.preferences_saved" ? { ...base, type: "profile.saved", profile: { ...profile, preferences: command.preferences } } : command.type === "own.fixture_response_recorded" ? { ...base, type: "fixture.response_recorded", fixtureId: command.fixtureId, profileId: profile.id, response: command.response } : { ...base, type: "training.response_recorded", trainingId: command.trainingId, profileId: profile.id, response: command.response };
    const updated = reducePreparation(state, bound);
    if (bound.type.startsWith("training.") || bound.type.startsWith("profile.")) this.projectPreparationRecords(teamId, seasonId, updated, command.id);
    this.saveDocument(teamId, seasonId, "preparation", updated);
    this.audit(principal, command.type, teamId, "accepted");
    return this.ownPreparation(principal, teamId, seasonId);
  }
  /** SQL account/membership records remain the authority; the serializable model is a projection. */
  communityState(teamId, seasonId) {
    const state = this.document(teamId, seasonId, "community");
    const accounts = this.database.prepare("SELECT * FROM accounts WHERE status='active'").all();
    const memberships = this.memberships();
    return {
      ...state,
      accounts: accounts.map((account2) => ({ id: account2.id, label: state.accounts.find((person) => person.id === account2.id)?.label ?? "Verified account", classification: account2.classification === "unclassified" ? "spectator" : account2.classification, adultVerified: !!account2.adult_verified })),
      memberships: memberships.filter((item) => item.role === "manager" || item.role === "player").map((item) => ({ accountId: item.accountId, teamId: item.teamId, seasonId: item.seasonId, role: item.role, playerId: item.playerId, active: item.revokedAt == null && (item.expiresAt == null || item.expiresAt > this.now()) }))
    };
  }
  communityActor(principal, teamId, seasonId, requestedRole, invitationAcceptance = false) {
    const memberships = this.memberships();
    if (invitationAcceptance) return { accountId: principal.accountId, teamId, seasonId, role: "spectator" };
    const allowed = currentMemberships(principal, memberships, this.now()).filter((item) => item.teamId === teamId && item.seasonId === seasonId && ["manager", "player", "spectator"].includes(item.role));
    const chosen = requestedRole ? allowed.find((item) => item.role === requestedRole) : allowed.find((item) => item.role === "manager") ?? allowed[0];
    if (!chosen) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    if (chosen.role === "manager") assertAdultAuthority(principal, false, this.now());
    const actor = { accountId: principal.accountId, teamId, seasonId, role: chosen.role, playerId: chosen.playerId };
    const document = this.database.prepare("SELECT team_id FROM documents WHERE team_id=? AND season_id=? AND kind='community'").get(teamId, seasonId);
    if (document && !communityCanAccess(this.communityState(teamId, seasonId), actor, this.now())) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    return actor;
  }
  community(principal, teamId, seasonId, role) {
    const actor = this.communityActor(principal, teamId, seasonId, role);
    const state = this.communityState(teamId, seasonId);
    return { ...getCommunityView(state, actor, this.now()), revision: state.revision };
  }
  communityCommand(principal, teamId, seasonId, command, role) {
    if (!command || !validId3(command.id) || typeof command.type !== "string") bad("A typed community command with a stable identity is required.");
    if (command.type === "concern.updated" && !["under_review", "resolved"].includes(command.status)) bad("Invalid concern status.");
    if (command.type === "concern.submitted" && (!["photo", "uploader"].includes(command.targetType) || !["privacy", "inappropriate", "other"].includes(command.category))) bad("Invalid concern category.");
    if (command.type === "uploader.hidden" && typeof command.hidden !== "boolean") bad("Choose whether to hide the uploader.");
    if (command.type === "privacy.drafted" && !["export", "delete_global_account"].includes(command.requestType)) bad("Invalid privacy request type.");
    if (command.type === "match.registered") throw new AccessError("POLICY_APPROVAL_REQUIRED", 503, "Connected award and sharing context must be derived from accepted match evidence, a verified finish-time anchor and independently approved competition policy. Caller-supplied trusted finish or sharing policy is not accepted.");
    const actor = this.communityActor(principal, teamId, seasonId, role, command.type === "invite.accepted");
    const previous = this.communityState(teamId, seasonId);
    const state = applyCommunityCommand(previous, actor, command, this.now());
    this.saveDocument(teamId, seasonId, "community", state);
    if (["invite.accepted", "invite.revoked", "grant.revoked"].includes(command.type)) this.synchronizeSpectatorMemberships(state);
    for (const match of state.matches.filter((match2) => match2.voteCutoffAtMs !== null && match2.finishQuality === "trusted" && !state.awards.some((award) => award.matchId === match2.id))) {
      const key = `award:${teamId}:${seasonId}:${match.id}:${match.voteCutoffAtMs}`;
      this.database.prepare("INSERT INTO jobs(id,business_key,kind,payload_json,due_at) VALUES(?,?,?,?,?) ON CONFLICT(business_key) DO NOTHING").run(randomUUID2(), key, "award.finalise", JSON.stringify({ teamId, seasonId, matchId: match.id }), match.voteCutoffAtMs);
    }
    this.audit(principal, command.type, teamId, "accepted");
    if (command.type === "photo.submitted" || command.type === "photo.revised" || command.type === "photo.published" || command.type === "photo.reviewed" && command.decision === "approve") this.enqueueNotifications(teamId, seasonId, "photos", command.photoId, command.id);
    if (command.type === "award.finalised") this.enqueueNotifications(teamId, seasonId, "awards", command.matchId, command.id);
    return { ...getCommunityView(state, actor, this.now()), revision: state.revision };
  }
  synchronizeSpectatorMemberships(state) {
    const scopes = /* @__PURE__ */ new Map();
    for (const grant of state.grants) scopes.set(JSON.stringify([grant.accountId, grant.teamId, grant.seasonId]), { accountId: grant.accountId, teamId: grant.teamId, seasonId: grant.seasonId });
    for (const scope of scopes.values()) {
      const grants = state.grants.filter((grant) => grant.accountId === scope.accountId && grant.teamId === scope.teamId && grant.seasonId === scope.seasonId);
      const active2 = grants.filter((grant) => grant.revokedAtMs === null && grant.startsAtMs <= this.now() && grant.expiresAtMs > this.now());
      const expiresAt = Math.max(...(active2.length ? active2 : grants).map((grant) => grant.expiresAtMs));
      const revokedAt = active2.length ? null : Math.max(1, this.now());
      this.database.prepare("INSERT INTO memberships(account_id,team_id,season_id,role,expires_at,revoked_at) VALUES(?,?,?,'spectator',?,?) ON CONFLICT(account_id,team_id,season_id,role) DO UPDATE SET expires_at=excluded.expires_at,revoked_at=excluded.revoked_at").run(scope.accountId, scope.teamId, scope.seasonId, expiresAt, revokedAt);
    }
  }
  media(principal, teamId, seasonId, photoId, mode, role) {
    const actor = this.communityActor(principal, teamId, seasonId, role);
    const result = authorizeCommunityMedia(this.communityState(teamId, seasonId), actor, photoId, this.now(), mode);
    if (!result.allowed) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    return result;
  }
  recordsViewer(principal, teamId, seasonId, role) {
    const actor = this.communityActor(principal, teamId, seasonId, role);
    return { actor: actor.role, playerId: actor.playerId, teamId, seasonId };
  }
  recordsContext(principal, teamId, seasonId, role) {
    const viewer = this.recordsViewer(principal, teamId, seasonId, role);
    const rows = this.database.prepare("SELECT state_json FROM matches WHERE team_id=? AND season_id=? ORDER BY id").all(teamId, seasonId);
    const community = this.communityState(teamId, seasonId);
    const actor = this.communityActor(principal, teamId, seasonId, viewer.actor);
    const filtered = getCommunityView(community, actor, this.now());
    return { principal, memberships: this.memberships(), nowMs: this.now(), requestedRole: viewer.actor, state: this.document(teamId, seasonId, "records"), acceptedMatches: rows.map((row) => ({ teamId, seasonId, match: JSON.parse(row.state_json) })), community: { accountId: principal.accountId, teamId, seasonId, audience: viewer.actor, playerId: viewer.playerId ?? null, revision: community.revision, view: { allowed: filtered.allowed, matches: filtered.matches, gallery: filtered.gallery } } };
  }
  records(principal, teamId, seasonId, role) {
    return recordsServiceView(this.recordsContext(principal, teamId, seasonId, role));
  }
  recordsExport(principal, teamId, seasonId, request, role) {
    return recordsServiceExport({ ...this.recordsContext(principal, teamId, seasonId, role), request });
  }
  recordsCommand(principal, teamId, seasonId, command, role) {
    const state = applyRecordsServiceCommand({ ...this.recordsContext(principal, teamId, seasonId, role), command });
    this.saveDocument(teamId, seasonId, "records", state);
    this.audit(principal, command.type, teamId, "accepted");
    return this.records(principal, teamId, seasonId, "manager");
  }
};

// apps/worker/src/jobs.ts
function runDueJobs(store2, nowMs = Date.now(), maximum = 20) {
  const result = { completed: 0, retried: 0, failed: 0 };
  for (let number = 0; number < maximum; number++) {
    const job = store2.transaction(() => {
      const found = store2.database.prepare("SELECT id,kind,payload_json,attempts FROM jobs WHERE kind='award.finalise' AND ((state='pending' AND due_at<=?) OR (state='leased' AND lease_until<=?)) ORDER BY due_at,id LIMIT 1").get(nowMs, nowMs);
      if (!found) return null;
      store2.database.prepare("UPDATE jobs SET state='leased',attempts=attempts+1,lease_until=? WHERE id=?").run(nowMs + 3e4, found.id);
      return { ...found, attempts: found.attempts + 1 };
    });
    if (!job) break;
    try {
      store2.transaction(() => {
        if (job.kind !== "award.finalise") throw new Error("UNSUPPORTED_JOB");
        const payload = JSON.parse(job.payload_json);
        const state = store2.document(payload.teamId, payload.seasonId, "community");
        const match = state.matches.find((item) => item.id === payload.matchId);
        if (!match || match.voteCutoffAtMs === null || match.finishQuality !== "trusted") throw new Error("AWARD_REVIEW_REQUIRED");
        const next = finalizeDueCommunityAwards(state, nowMs);
        store2.saveDocument(payload.teamId, payload.seasonId, "community", next);
        for (const award of next.awards.filter((award2) => !state.awards.some((previous) => previous.matchId === award2.matchId))) store2.enqueueNotifications(payload.teamId, payload.seasonId, "awards", award.matchId, `award-finalised-${award.matchId}-${award.voteCutoffAtMs}`);
        if (!next.awards.some((award) => award.matchId === payload.matchId)) throw new Error("AWARD_NOT_DUE_OR_UNRESOLVED");
        store2.database.prepare("UPDATE jobs SET state='completed',lease_until=NULL,last_error_code=NULL WHERE id=?").run(job.id);
      });
      result.completed += 1;
    } catch {
      const terminal = job.attempts >= 3;
      store2.transaction(() => store2.database.prepare("UPDATE jobs SET state=?,due_at=?,lease_until=NULL,last_error_code=? WHERE id=?").run(terminal ? "failed" : "pending", nowMs + Math.min(6e4, 1e3 * 2 ** job.attempts), "JOB_REQUIRES_REVIEW", job.id));
      if (terminal) result.failed += 1;
      else result.retried += 1;
    }
  }
  return result;
}

// apps/api/src/pg.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, types } from "pg";
import { readFile } from "node:fs/promises";
var contextKey = (context) => JSON.stringify(Object.entries(context).sort(([a], [b]) => a.localeCompare(b)));
function validateContext(context) {
  if (!context || typeof context !== "object" || !Number.isSafeInteger(context.nowMs) || context.nowMs < 0) throw new Error("Invalid PostgreSQL application context.");
  const required2 = {
    identity: ["issuer", "subject"],
    actor: ["accountId", "issuer", "subject"],
    activation_token: ["tokenHash"],
    invitation_activation: ["tokenHash"],
    worker_claim: ["jobKind"],
    worker_job: ["jobId", "leaseToken", "clubId", "teamId", "seasonId"]
  };
  if (!Object.hasOwn(required2, context.kind) || required2[context.kind].some((name) => typeof context[name] !== "string" || !context[name] || context[name].length > 2048)) throw new Error("Invalid PostgreSQL application context.");
  if (context.kind === "actor" && (typeof context.strongAuth !== "boolean" || !Number.isSafeInteger(context.authenticatedAtMs) || context.authenticatedAtMs < 0 || context.requestedRole !== void 0 && !["administrator", "manager", "player", "spectator", "default"].includes(context.requestedRole))) throw new Error("Invalid PostgreSQL actor context.");
  if (["activation_token", "invitation_activation"].includes(context.kind) && "tokenHash" in context && (!/^[a-f0-9]{64}$/.test(context.tokenHash) || "completionVerified" in context && context.completionVerified !== void 0 && context.completionVerified !== true)) throw new Error("Invalid PostgreSQL activation context.");
  if (context.kind === "worker_claim" && !["award.finalise", "notification.dispatch"].includes(context.jobKind)) throw new Error("Invalid PostgreSQL job context.");
  if (context.kind === "worker_job" && !/^[a-f0-9]{64}$/.test(context.leaseToken)) throw new Error("Invalid PostgreSQL job capability.");
}
function isNarrowing(parent, child) {
  if (parent.kind === "identity" && child.kind === "actor") return parent.issuer === child.issuer && parent.subject === child.subject;
  if (parent.kind !== child.kind) return false;
  for (const [name, value] of Object.entries(parent)) {
    if (name === "nowMs") continue;
    if (child[name] !== value) return false;
  }
  return child.nowMs >= parent.nowMs;
}
var PgDatabase = class {
  pool;
  migrationMode;
  transactions = new AsyncLocalStorage();
  applications = new AsyncLocalStorage();
  get applicationContext() {
    const frame = this.applications.getStore();
    for (let ancestor = frame; ancestor; ancestor = ancestor.parent) if (!ancestor.active) throw new Error("PostgreSQL application context has ended.");
    return frame?.value;
  }
  async withContext(value, work) {
    validateContext(value);
    const immutable = Object.freeze({ ...value });
    const parent = this.applicationContext;
    if (parent && !isNarrowing(parent, immutable)) throw new Error("PostgreSQL application context cannot widen an existing scope.");
    const key = contextKey(immutable);
    const transaction = this.transactions.getStore();
    if (transaction && !transaction.active) throw new Error("PostgreSQL transaction has ended.");
    if (transaction && transaction.applicationKey !== key) throw new Error("Narrow PostgreSQL application context before opening its SQL transaction.");
    const frame = { value: immutable, active: true, key, parent: this.applications.getStore() };
    try {
      return await this.applications.run(frame, work);
    } finally {
      frame.active = false;
    }
  }
  constructor(connectionString2, options = {}) {
    let url;
    try {
      url = new URL(connectionString2);
    } catch {
      throw new Error("A valid PostgreSQL connection URL is required.");
    }
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("A PostgreSQL connection URL is required.");
    this.migrationMode = options.migrationMode ?? "apply";
    this.pool = new Pool({
      connectionString: connectionString2,
      max: options.maximumConnections ?? 10,
      application_name: options.applicationName ?? "longball-api",
      connectionTimeoutMillis: 1e4,
      idleTimeoutMillis: 3e4,
      options: "-c search_path=longball,pg_catalog -c statement_timeout=15000 -c lock_timeout=10000",
      types: { getTypeParser: (oid, format2) => {
        if (oid === 114 || oid === 3802) return (value) => value;
        if (oid === 20) return (value) => {
          const parsed = Number(value);
          if (!Number.isSafeInteger(parsed)) throw new Error("PostgreSQL integer exceeds the application range.");
          return parsed;
        };
        return types.getTypeParser(oid, format2);
      } }
    });
    this.pool.on("error", () => {
      console.error("LONGBALL_POSTGRES_IDLE_CONNECTION_ERROR");
    });
  }
  async query(sql, values = []) {
    const application = this.applicationContext;
    const transaction = this.transactions.getStore();
    if (transaction) {
      if (!transaction.active) throw new Error("PostgreSQL transaction has ended.");
      if (transaction.applicationKey !== (application ? contextKey(application) : null)) throw new Error("PostgreSQL transaction context changed.");
      return transaction.client.query(sql, [...values]);
    }
    if (!application) return this.pool.query(sql, [...values]);
    return this.inTransaction(() => this.query(sql, values), false);
  }
  async transaction(work) {
    return this.inTransaction(work, true);
  }
  async inTransaction(work, lockWrites) {
    const application = this.applicationContext;
    const applicationKey = application ? contextKey(application) : null;
    const existing = this.transactions.getStore();
    if (existing) {
      if (!existing.active) throw new Error("PostgreSQL transaction has ended.");
      if (existing.applicationKey !== applicationKey) throw new Error("PostgreSQL transaction context changed.");
      return work();
    }
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN");
      if (application) await client.query("SELECT set_config('longball.context',$1,true)", [JSON.stringify(application)]);
      if (lockWrites) await client.query("SELECT pg_advisory_xact_lock(hashtextextended('longball:domain-write:v1', 0))");
      const transaction = { client, applicationKey, active: true };
      let result;
      try {
        result = await this.transactions.run(transaction, work);
      } finally {
        transaction.active = false;
      }
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }
  async migrate() {
    if (this.migrationMode === "verify") {
      const versions = await this.query("SELECT version FROM longball.schema_migrations ORDER BY version");
      if (versions.rows.some((row) => row.version > 15)) throw new Error("This PostgreSQL schema is newer than the application. Preserve it and use a compatible build.");
      if (![2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].every((version) => versions.rows.some((row) => row.version === version))) throw new Error("PostgreSQL migrations are required. Run the separate migrator before starting the runtime.");
      const protectedTables = ["clubs", "teams", "team_seasons", "game_contexts", "accounts", "memberships", "matches", "documents", "devices", "controller_grants", "controller_history", "events", "streams", "conflicting_submissions", "transfers", "clock_challenges", "clock_mappings", "reconciliation_proposals", "audit", "idempotency", "privacy_requests", "privacy_pending_keys", "jobs", "brand_assets", "brand_slots", "spectator_invitations", "lb_spectator_activation_accounts", "lb_spectator_activation_attempts", "native_app_devices", "team_privilege_states", "team_privilege_decisions", "push_registrations"];
      const security = await this.query(`SELECT c.relname,c.relrowsecurity,(SELECT count(*)::integer FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid) AS policies FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='longball' AND c.relname=ANY($1::text[])`, [protectedTables]);
      if (security.rows.length !== protectedTables.length || security.rows.some((row) => !row.relrowsecurity || row.policies < 1)) throw new Error("PostgreSQL row security is missing. Run the separate migrator before starting runtime.");
      return;
    }
    const migration = await readFile(new URL("../migrations/postgresql/002_runtime.sql", import.meta.url), "utf8");
    const clockReviewMigration = await readFile(new URL("../migrations/postgresql/003_clock_review.sql", import.meta.url), "utf8");
    const accountRequestsMigration = await readFile(new URL("../migrations/postgresql/004_account_requests.sql", import.meta.url), "utf8");
    const scopeSecurityMigration = await readFile(new URL("../migrations/postgresql/005_scope_security.sql", import.meta.url), "utf8");
    const awardNotificationsMigration = await readFile(new URL("../migrations/postgresql/006_award_notifications.sql", import.meta.url), "utf8");
    const workerBoundariesMigration = await readFile(new URL("../migrations/postgresql/007_worker_boundaries.sql", import.meta.url), "utf8");
    const controllerRevocationMigration = await readFile(new URL("../migrations/postgresql/008_controller_revocation.sql", import.meta.url), "utf8");
    const dispatchClockMigration = await readFile(new URL("../migrations/postgresql/009_dispatch_database_clock.sql", import.meta.url), "utf8");
    const brandAssetsMigration = await readFile(new URL("../migrations/postgresql/010_brand_assets.sql", import.meta.url), "utf8");
    const spectatorCapabilitiesMigration = await readFile(new URL("../migrations/postgresql/011_spectator_capabilities.sql", import.meta.url), "utf8");
    const heicMigration = await readFile(new URL("../migrations/postgresql/012_heic_support.sql", import.meta.url), "utf8");
    const teamPrivilegesMigration = await readFile(new URL("../migrations/postgresql/013_team_privileges.sql", import.meta.url), "utf8");
    const pushRegistrationMigration = await readFile(new URL("../migrations/postgresql/014_push_registrations.sql", import.meta.url), "utf8");
    const privilegeAuditClockMigration = await readFile(new URL("../migrations/postgresql/015_team_privilege_audit_clock.sql", import.meta.url), "utf8");
    await this.transaction(async () => {
      const schema = await this.query("SELECT to_regnamespace('longball')::text AS namespace");
      if (!schema.rows[0]?.namespace) await this.query("CREATE SCHEMA longball");
      await this.query("CREATE TABLE IF NOT EXISTS longball.schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      const versions = await this.query("SELECT version FROM longball.schema_migrations ORDER BY version");
      if (versions.rows.some((row) => row.version > 15)) throw new Error("This PostgreSQL schema is newer than the application. Preserve it and use a compatible build.");
      if (!versions.rows.some((row) => row.version === 2)) {
        await this.query(migration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(2)");
      }
      if (!versions.rows.some((row) => row.version === 3)) {
        await this.query(clockReviewMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(3)");
      }
      if (!versions.rows.some((row) => row.version === 4)) {
        await this.query(accountRequestsMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(4)");
      }
      if (!versions.rows.some((row) => row.version === 5)) {
        await this.query(scopeSecurityMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(5)");
      }
      if (!versions.rows.some((row) => row.version === 6)) {
        await this.query(awardNotificationsMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(6)");
      }
      if (!versions.rows.some((row) => row.version === 7)) {
        await this.query(workerBoundariesMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(7)");
      }
      if (!versions.rows.some((row) => row.version === 8)) {
        await this.query(controllerRevocationMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(8)");
      }
      if (!versions.rows.some((row) => row.version === 9)) {
        await this.query(dispatchClockMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(9)");
      }
      if (!versions.rows.some((row) => row.version === 10)) {
        await this.query(brandAssetsMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(10)");
      }
      if (!versions.rows.some((row) => row.version === 11)) {
        await this.query(spectatorCapabilitiesMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(11)");
      }
      if (!versions.rows.some((row) => row.version === 12)) {
        await this.query(heicMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(12)");
      }
      if (!versions.rows.some((row) => row.version === 13)) {
        await this.query(teamPrivilegesMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(13)");
      }
      if (!versions.rows.some((row) => row.version === 14)) {
        await this.query(pushRegistrationMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(14)");
      }
      if (!versions.rows.some((row) => row.version === 15)) {
        await this.query(privilegeAuditClockMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(15)");
      }
    });
  }
  async close() {
    await this.pool.end();
  }
};

// apps/api/src/postgres-store.ts
import { createHash as createHash3, randomBytes as randomBytes2, randomUUID as randomUUID3 } from "node:crypto";
var EVENT_CONTRACT_VERSION2 = "longball.events/1.1";
var SYNTHETIC_IDS2 = { teamId: "synthetic-roma-u10", seasonId: "synthetic-season-2026-27", matchId: "synthetic-roma-maple-2026-10-24" };
function canonical5(value) {
  if (Array.isArray(value)) return `[${value.map(canonical5).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical5(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
var digest2 = (value) => createHash3("sha256").update(value).digest("hex");
var validId4 = (value) => typeof value === "string" && value.length > 0 && value.length <= 150 && /^[a-zA-Z0-9_-]+$/.test(value);
var validDeviceId2 = (value) => validId4(value) && value.length <= 120;
var nonnegative4 = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function bad2(message) {
  throw new AccessError("INVALID_REQUEST", 400, message);
}
function validateEnvelope2(value, matchId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) bad2("An event envelope is required.");
  const item = value;
  if (!validId4(item.eventId) || !validDeviceId2(item.deviceId) || item.matchId !== matchId || !nonnegative4(item.clientSequence) || item.clientSequence < 1 || !nonnegative4(item.controllerEpoch) || item.controllerEpoch < 1 || !nonnegative4(item.baseRevision)) bad2("Invalid event identity, scope or sequence.");
  if (!(item.previousEventId === null || validId4(item.previousEventId))) bad2("Invalid previous event identifier.");
  if (item.contractVersion !== EVENT_CONTRACT_VERSION2 || item.schemaVersion !== 1 || item.engineVersion !== ENGINE_VERSION) return item;
  const fields4 = ["contractVersion", "schemaVersion", "engineVersion", "eventId", "matchId", "deviceId", "controllerEpoch", "clientSequence", "previousEventId", "baseRevision", "effectiveHalf", "halfElapsedMs", "matchElapsedMs", "effectiveAt", "recordedAt", "timeQuality", "clockEvidence", "command"];
  if (Object.keys(item).some((key) => !fields4.includes(key))) bad2("Unknown event envelope fields are not accepted.");
  if (!nonnegative4(item.halfElapsedMs) || !nonnegative4(item.matchElapsedMs) || ![0, 1, 2].includes(item.effectiveHalf)) bad2("Invalid effective playing-time boundary.");
  if (!["anchored", "estimated", "reviewRequired"].includes(item.timeQuality) || !Number.isFinite(Date.parse(item.recordedAt)) || !(item.effectiveAt === null || Number.isFinite(Date.parse(item.effectiveAt)))) bad2("Invalid event time evidence.");
  const command = item.command;
  if (!command || typeof command !== "object" || command.id !== item.eventId || !command.sample || !Number.isFinite(command.sample.monotonicMs) || command.sample.monotonicMs < 0 || !validId4(command.sample.sessionId) || !nonnegative4(command.sample.wallTimeMs)) bad2("Invalid versioned match command.");
  if (!item.clockEvidence || item.clockEvidence.monotonicMs !== command.sample.monotonicMs || !validId4(item.clockEvidence.anchorId) || !(item.clockEvidence.continuityId === null || validId4(item.clockEvidence.continuityId))) bad2("Explicit clock evidence is required.");
  const commandTypes = ["attendance.recorded", "availability.changed", "lineup.staged", "half.started", "half.paused", "half.resumed", "half.ended", "lineup.committed", "goal.recorded", "clock.recovery_required", "clock.corrected", "event.corrected", "event.voided", "policy.changed", "match.abandoned"];
  if (!commandTypes.includes(command.type)) bad2("Unsupported match command.");
  if (command.type === "goal.recorded" && !["us", "opposition"].includes(command.beneficiary)) bad2("Invalid goal side.");
  if (command.type === "attendance.recorded" && (!validId4(command.playerId) || !["present", "absent", "excused", "not_selected", "not_recorded"].includes(command.status))) bad2("Invalid attendance.");
  if (command.type === "availability.changed" && (!validId4(command.playerId) || typeof command.available !== "boolean")) bad2("Invalid availability.");
  if ((command.type === "lineup.staged" || command.type === "lineup.committed") && (!Array.isArray(command.lineup) || command.lineup.length > 11 || command.lineup.some((item2) => !validId4(item2.playerId) || !validId4(item2.slotId) || typeof item2.position !== "string" || item2.position.length > 30))) bad2("Invalid lineup allocations.");
  return item;
}
var PostgresStore = class _PostgresStore {
  constructor(db, now = Date.now) {
    this.db = db;
    this.now = now;
  }
  db;
  now;
  static async open(connectionString2, now = Date.now, options = {}) {
    const db = new PgDatabase(connectionString2, options);
    try {
      await db.migrate();
      return new _PostgresStore(db, now);
    } catch (error) {
      await db.close();
      throw error;
    }
  }
  async close() {
    await this.db.close();
  }
  async assertRuntimeRole(kind) {
    const role = await this.one(`SELECT r.rolsuper,r.rolbypassrls,longball.runtime_purpose() AS runtime_purpose,
     EXISTS(SELECT 1 FROM pg_catalog.pg_roles privileged WHERE (privileged.rolsuper OR privileged.rolbypassrls) AND pg_has_role(current_user,privileged.oid,'MEMBER')) AS privileged_membership,
     (EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname='longball' AND pg_has_role(current_user,n.nspowner,'MEMBER')) OR
      EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='longball' AND c.relkind IN('r','p') AND pg_has_role(current_user,c.relowner,'MEMBER'))) AS owns_data
     FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
    if (!role || role.rolsuper || role.rolbypassrls || role.privileged_membership || role.owns_data) throw new Error(`The PostgreSQL ${kind} requires a separate non-owner role without superuser, bypass-RLS or privileged-role membership.`);
    if (role.runtime_purpose !== kind) throw new Error(`The PostgreSQL role is not assigned the ${kind} runtime purpose.`);
  }
  transaction(work) {
    return this.db.transaction(work);
  }
  async withIdentityContext(identity, work) {
    return this.db.withContext({ kind: "identity", issuer: identity.issuer, subject: identity.subject, nowMs: this.now() }, work);
  }
  async withActorContext(principal, scope, work) {
    const context = { kind: "actor", accountId: principal.accountId, issuer: principal.issuer, subject: principal.subject, strongAuth: principal.strongAuth, authenticatedAtMs: principal.authenticatedAt, nowMs: this.now(), ...scope };
    return this.db.withContext(context, async () => {
      if (scope.matchId) {
        const match = await this.one("SELECT club_id,team_id,season_id FROM matches WHERE id=$1", [scope.matchId]);
        if (!match || typeof match.club_id !== "string" || typeof match.team_id !== "string" || typeof match.season_id !== "string") throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
        return this.db.withContext({ ...context, clubId: String(match.club_id), teamId: String(match.team_id), seasonId: String(match.season_id) }, work);
      }
      if (scope.teamId) {
        const team = await this.one("SELECT club_id FROM teams WHERE id=$1 AND scope_status='resolved'", [scope.teamId]);
        if (!team || typeof team.club_id !== "string") throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
        return this.db.withContext({ ...context, clubId: String(team.club_id) }, work);
      }
      return work();
    });
  }
  async one(sql, values = []) {
    return (await this.db.query(sql, values)).rows[0];
  }
  async many(sql, values = []) {
    return (await this.db.query(sql, values)).rows;
  }
  async execute(sql, values = []) {
    return { changes: (await this.db.query(sql, values)).rowCount ?? 0 };
  }
  async seedSynthetic() {
    await this.transaction(async () => {
      if (await this.one("SELECT id FROM teams LIMIT 1", []))
        return;
      await this.execute("INSERT INTO clubs(id,name) VALUES($1,$2),($3,$4)", ["synthetic-richmond-rovers", "Richmond Rovers \xB7 fictional", "synthetic-other-club", "Other fictional club"]);
      await this.execute("INSERT INTO teams(id,name,club_id,scope_status) VALUES($1,$2,$3,'resolved')", [SYNTHETIC_IDS2.teamId, "Roma U10 \xB7 fictional", "synthetic-richmond-rovers"]);
      await this.execute("INSERT INTO teams(id,name,club_id,scope_status) VALUES($1,$2,$3,'resolved')", ["synthetic-other-team", "Other fictional team", "synthetic-other-club"]);
      await this.execute("INSERT INTO team_seasons(club_id,team_id,season_id,label,start_year,start_date,end_date) VALUES($1,$2,$3,$4,$5,$6,$7),($8,$9,$3,$4,$5,$6,$7)", ["synthetic-richmond-rovers", SYNTHETIC_IDS2.teamId, SYNTHETIC_IDS2.seasonId, "2026/27", 2026, "2026-09-01", "2027-08-31", "synthetic-other-club", "synthetic-other-team"]);
      const add2 = async (id, classification, adult) => await this.execute("INSERT INTO accounts(id,issuer,subject,classification,adult_verified,strong_auth_enrolled) VALUES($1,$2,$3,$4,$5,$6)", [id, "urn:longball:synthetic", id, classification, Number(adult), Number(adult)]);
      const membership = async (id, role, playerId = null, teamId = SYNTHETIC_IDS2.teamId) => await this.execute("INSERT INTO memberships(account_id,team_id,season_id,role,player_id) VALUES($1,$2,$3,$4,$5)", [id, teamId, SYNTHETIC_IDS2.seasonId, role, playerId]);
      await add2("synthetic-account-admin", "adult_individual", true);
      await membership("synthetic-account-admin", "administrator");
      for (let number = 1; number <= 5; number++) {
        const id = number === 1 ? "synthetic-account-manager" : `synthetic-account-manager-${number}`;
        await add2(id, "adult_individual", true);
        if (number <= 4)
          await membership(id, "manager");
        if (number === 1)
          await membership(id, "administrator");
      }
      for (let number = 1; number <= 13; number++) {
        const suffix = String(number).padStart(2, "0");
        const id = `synthetic-account-player-${suffix}`;
        await add2(id, "child_shared", false);
        await membership(id, "player", `synthetic-player-${suffix}`);
      }
      await add2("synthetic-account-spectator", "adult_individual", false);
      await membership("synthetic-account-spectator", "spectator");
      await add2("synthetic-account-invitee", "adult_individual", false);
      await add2("synthetic-account-other-manager", "adult_individual", true);
      await membership("synthetic-account-other-manager", "manager", null, "synthetic-other-team");
      const config = { matchId: SYNTHETIC_IDS2.matchId, players: romaFixture.players, selectedPlayerIds: romaFixture.players.filter((player) => player.available).map((player) => player.id), pitchPlaces: 7, plannedHalfDurationMs: 15e5, fixedKeeperId: romaFixture.players[0].id };
      await this.insertMatch(config, SYNTHETIC_IDS2.teamId, SYNTHETIC_IDS2.seasonId);
      const community = createCommunityState(this.now());
      community.matches = community.matches.map((match) => ({ ...match, sharing: "manager_only" }));
      for (let number = 2; number <= 4; number++) {
        const id = `synthetic-account-manager-${number}`;
        community.accounts.push({ id, label: `Fictional manager ${number}`, classification: "adult_individual", adultVerified: true });
        community.memberships.push({ accountId: id, teamId: SYNTHETIC_IDS2.teamId, seasonId: SYNTHETIC_IDS2.seasonId, role: "manager", active: true });
      }
      await this.saveDocument(SYNTHETIC_IDS2.teamId, SYNTHETIC_IDS2.seasonId, "preparation", createPreparationState());
      await this.saveDocument(SYNTHETIC_IDS2.teamId, SYNTHETIC_IDS2.seasonId, "community", community);
      await this.saveDocument(SYNTHETIC_IDS2.teamId, SYNTHETIC_IDS2.seasonId, "records", createRecordsSeed());
    });
  }
  async insertMatch(config, teamId, seasonId) {
    await this.execute("INSERT INTO matches(id,team_id,season_id,config_json,state_json,sharing_policy_json) VALUES($1,$2,$3,$4,$5,$6)", [config.matchId, teamId, seasonId, JSON.stringify(config), JSON.stringify(createMatch(config)), JSON.stringify(UNAPPROVED_SHARING_POLICY)]);
  }
  async principal(identity) {
    const account2 = await this.one("SELECT * FROM accounts WHERE issuer=$1 AND subject=$2", [identity.issuer, identity.subject]);
    if (!account2 || account2.status !== "active")
      throw new AccessError("ACCOUNT_UNAVAILABLE", 403, "The account is not active for this service.");
    return { accountId: account2.id, issuer: account2.issuer, subject: account2.subject, identityClassification: account2.classification, adultVerified: Boolean(account2.adult_verified), strongAuth: identity.strongAuth, authenticatedAt: identity.authenticatedAt, status: account2.status };
  }
  async memberships() {
    const rows = await this.many("SELECT m.*,CASE WHEN m.role='spectator' THEN longball.spectator_grant_active(m.account_id,m.club_id,m.team_id,m.season_id) ELSE true END AS grant_active FROM memberships m");
    return rows.map((row) => ({ accountId: row.account_id, teamId: row.team_id, seasonId: row.season_id, role: row.role, playerId: row.player_id ?? void 0, expiresAt: row.expires_at, revokedAt: row.role === "spectator" && !row.grant_active ? row.revoked_at ?? Math.max(1, this.now()) : row.revoked_at }));
  }
  async myMemberships(principal) {
    return currentMemberships(principal, await this.memberships(), this.now());
  }
  async recognisedDevices(principal) {
    const legacy = await this.many("SELECT id,account_id FROM devices WHERE account_id=$1 ORDER BY id", [principal.accountId]);
    const native = await this.many("SELECT * FROM native_app_devices WHERE account_id=$1 AND issuer=$2 ORDER BY registered_at,device_id", [principal.accountId, principal.issuer]);
    return ownDevicesDto(principal, legacy, native, this.now());
  }
  async enrolDevice(principal, input) {
    const parsed = parseNativeDeviceInput(input);
    if (await this.one("SELECT id FROM devices WHERE id=$1 AND account_id=$2", [parsed.deviceId, principal.accountId])) throw new AccessError("DEVICE_ID_CONFLICT", 409, "Use a separate installation identity for sign-in recognition.");
    const updated = await this.one("INSERT INTO native_app_devices(device_id,account_id,issuer,platform,registered_at,last_seen_at) VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT(device_id) DO UPDATE SET platform=EXCLUDED.platform,last_seen_at=GREATEST(native_app_devices.last_seen_at,EXCLUDED.last_seen_at) WHERE native_app_devices.account_id=EXCLUDED.account_id AND native_app_devices.issuer=EXCLUDED.issuer RETURNING device_id", [parsed.deviceId, principal.accountId, principal.issuer, parsed.platform, this.now()]);
    if (!updated) throw new AccessError("DEVICE_ID_CONFLICT", 409, "This installation identity is unavailable.");
    return this.recognisedDevices(principal);
  }
  async brandingContext(principal, teamId, seasonId, role) {
    const memberships = await this.memberships(), nowMs = this.now(), selectedRole = brandSelectedRole(principal, memberships, teamId, seasonId, role, nowMs);
    const names = await this.one("SELECT * FROM longball.branding_context($1,$2)", [teamId, seasonId]);
    if (!names || typeof names.club_id !== "string" || names.team_id !== teamId) throw new AccessError("NOT_FOUND", 404, "The requested branding is unavailable.");
    return { context: { principal, memberships, selectedRole, clubId: names.club_id, teamId, authoritySeasonId: seasonId, nowMs, spectatorGrantActive: selectedRole === "spectator" }, club: { id: names.club_id, name: String(names.club_name) }, team: { id: teamId, name: String(names.team_name), ageGroup: names.age_group === null ? "" : String(names.age_group) } };
  }
  async match(matchId) {
    const row = await this.one("SELECT * FROM matches WHERE id=$1", [matchId]);
    if (!row)
      throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    return row;
  }
  async managerMatch(principal, matchId) {
    const row = await this.match(matchId);
    assertCanManageTeam(principal, await this.memberships(), row.team_id, row.season_id, this.now());
    return row;
  }
  async matchDto(principal, matchId, requestedRole) {
    const row = await this.match(matchId);
    return filterMatchForPrincipal({ principal, memberships: await this.memberships(), teamId: row.team_id, seasonId: row.season_id, state: JSON.parse(row.state_json), policy: JSON.parse(row.sharing_policy_json), lastSyncAt: row.last_sync_at, now: this.now(), requestedRole });
  }
  async download(principal, matchId, deviceId, syntheticOnly = false, controllerToken) {
    return this.transaction(async () => {
      const row = await this.managerMatch(principal, matchId);
      if (!validDeviceId2(deviceId)) bad2("A device identifier of at most 120 canonical characters is required.");
      if (controllerToken !== void 0) {
        const authority = await this.assertController(principal, matchId, controllerToken);
        if (authority.device_id !== deviceId || authority.frozen) throw new AccessError("CONTROLLER_REQUIRED", 409, "Use the current unfrozen controller device and capability.");
      }
      const stream = await this.one("SELECT sequence,previous_event_id FROM streams WHERE match_id=$1 AND device_id=$2", [matchId, deviceId]);
      const controller = await this.one("SELECT epoch,account_id,device_id,frozen FROM controller_grants WHERE match_id=$1", [matchId]);
      const events = await this.many("SELECT revision,received_at,envelope_json FROM events WHERE match_id=$1 AND disposition='accepted' ORDER BY revision LIMIT 10001", [matchId]);
      const transitions = await this.many("SELECT id,epoch,actor_id,from_device,to_device,kind,reason,created_at FROM controller_history WHERE match_id=$1 ORDER BY epoch,created_at,id LIMIT 10001", [matchId]);
      const saved = await this.one("SELECT value_json FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='records'", [row.team_id, row.season_id]);
      return buildOfflineDownload({ matchId, teamId: row.team_id, seasonId: row.season_id, deviceId, state: JSON.parse(row.state_json), checkpoint: { clientSequence: stream?.sequence ?? 0, previousEventId: stream?.previous_event_id ?? null }, controller: controller ?? null, events, transitions, publication: offlinePublication(matchId, JSON.parse(row.sharing_policy_json), saved ? JSON.parse(saved.value_json) : null), nowMs: this.now(), syntheticOnly });
    });
  }
  async audit(principal, action, objectId, outcome) {
    await this.execute("INSERT INTO audit(id,actor_id,action,object_id,outcome,created_at) VALUES($1,$2,$3,$4,$5,$6)", [randomUUID3(), principal.accountId, action, objectId, outcome, this.now()]);
  }
  async idempotent(principal, operation, key, payload, work) {
    if (!validId4(key) || key.length < 8)
      bad2("A stable Idempotency-Key is required for mutations.");
    const signature2 = digest2(canonical5(payload));
    return await this.transaction(async () => {
      const prior = await this.one("SELECT signature,response_json FROM idempotency WHERE account_id=$1 AND operation=$2 AND key=$3", [principal.accountId, operation, key]);
      if (prior) {
        if (prior.signature !== signature2)
          throw new AccessError("IDEMPOTENCY_CONFLICT", 409, "The idempotency key was already used with different content.");
        return JSON.parse(prior.response_json);
      }
      const response = await work();
      await this.execute("INSERT INTO idempotency(account_id,operation,key,signature,response_json) VALUES($1,$2,$3,$4,$5)", [principal.accountId, operation, key, signature2, JSON.stringify(response)]);
      return response;
    });
  }
  async acquire(principal, matchId, deviceId) {
    await this.managerMatch(principal, matchId);
    if (!validDeviceId2(deviceId))
      bad2("A device identifier of at most 120 canonical characters is required.");
    const prior = await this.one("SELECT * FROM controller_grants WHERE match_id=$1", [matchId]);
    if (prior)
      throw new AccessError("CONTROLLER_EXISTS", 409, "This match already has a controller. Use handover or audited recovery.");
    await this.bindDevice(principal, deviceId);
    const token = randomBytes2(32).toString("base64url");
    await this.execute("INSERT INTO controller_grants(match_id,epoch,account_id,device_id,capability_hash) VALUES($1,$2,$3,$4,$5)", [matchId, 1, principal.accountId, deviceId, digest2(token)]);
    await this.audit(principal, "controller.acquired", matchId, "accepted");
    return { epoch: 1, deviceId, controllerToken: token, checkpoint: (await this.download(principal, matchId, deviceId)).deviceCheckpoint };
  }
  async assertController(principal, matchId, token) {
    await this.managerMatch(principal, matchId);
    const grant = await this.one("SELECT * FROM controller_grants WHERE match_id=$1", [matchId]);
    if (!grant || grant.account_id !== principal.accountId || !token || digest2(token) !== grant.capability_hash)
      throw new AccessError("CONTROLLER_REQUIRED", 409, "Only the selected manager and enrolled device may write this match.");
    return grant;
  }
  async issueClockChallenge(principal, matchId, token, input, policy) {
    const grant = await this.assertController(principal, matchId, token);
    if (!policy)
      throw new AccessError("CLOCK_POLICY_REQUIRED", 503, "An explicitly configured trusted-time policy is required before establishing an anchor.");
    if (!input || Object.keys(input).some((key) => !["deviceId", "controllerEpoch", "continuityId"].includes(key)) || !validDeviceId2(input.deviceId) || !validId4(input.continuityId) || input.deviceId !== grant.device_id || input.controllerEpoch !== grant.epoch || grant.frozen)
      throw new AccessError("CLOCK_SCOPE_CONFLICT", 409, "Use the current unfrozen controller device, epoch and continuous-clock identity.");
    const challenge = issueClockChallenge({ accountId: principal.accountId, deviceId: grant.device_id, matchId, controllerEpoch: grant.epoch, continuityId: input.continuityId }, randomUUID3(), this.now(), policy);
    await this.execute("INSERT INTO clock_challenges(id,match_id,account_id,challenge_json) VALUES($1,$2,$3,$4)", [challenge.id, matchId, principal.accountId, JSON.stringify(challenge)]);
    return challenge;
  }
  async acknowledgeClockChallenge(principal, matchId, token, challengeId, sample, policy) {
    const grant = await this.assertController(principal, matchId, token);
    if (!policy)
      throw new AccessError("CLOCK_POLICY_REQUIRED", 503, "An explicitly configured trusted-time policy is required before establishing an anchor.");
    if (!sample || Object.keys(sample).some((key) => !["receivedMonotonicMs", "sentMonotonicMs"].includes(key)))
      bad2("Use the documented continuous-clock receipt and send observations.");
    const row = await this.one("SELECT challenge_json,consumed_at FROM clock_challenges WHERE id=$1 AND match_id=$2 AND account_id=$3", [challengeId, matchId, principal.accountId]);
    if (!row)
      throw new AccessError("NOT_FOUND", 404, "That challenge is unavailable.");
    const challenge = JSON.parse(row.challenge_json);
    if (row.consumed_at !== null)
      throw new AccessError("CLOCK_CHALLENGE_CONSUMED", 409, "That clock exchange was consumed. Retrying the same request key returns its receipt.");
    if (challenge.controllerEpoch !== grant.epoch || challenge.deviceId !== grant.device_id || grant.frozen)
      throw new AccessError("CLOCK_SCOPE_CONFLICT", 409, "The controller changed before the clock exchange completed.");
    let mapping;
    try {
      mapping = acknowledgeClockChallenge(challenge, sample, this.now(), policy);
    } catch {
      throw new AccessError("CLOCK_EXCHANGE_REJECTED", 422, "The clock exchange expired or its evidence exceeds the configured uncertainty bounds.");
    }
    await this.execute("UPDATE clock_challenges SET consumed_at=$1 WHERE id=$2 AND consumed_at IS NULL", [this.now(), challengeId]);
    await this.execute("INSERT INTO clock_mappings(challenge_id,match_id,mapping_json,created_at) VALUES($1,$2,$3,$4)", [challengeId, matchId, JSON.stringify(mapping), this.now()]);
    await this.audit(principal, "clock.mapping_established", matchId, policy.id);
    return mapping;
  }
  async reconciliation(principal, matchId) {
    const row = await this.managerMatch(principal, matchId);
    const state = JSON.parse(row.state_json);
    const events = await this.many("SELECT event_id,device_id,client_sequence,envelope_json,reason,received_at FROM events WHERE match_id=$1 AND disposition='quarantined' ORDER BY received_at,client_sequence", [matchId]);
    const conflicts = await this.many("SELECT id,original_json,reason,created_at FROM conflicting_submissions WHERE match_id=$1 ORDER BY created_at,id", [matchId]);
    const submissions = [...events.map((event) => {
      const original = JSON.parse(event.envelope_json);
      return { submissionId: event.event_id, matchId, eventId: event.event_id, deviceId: event.device_id, clientSequence: event.client_sequence, controllerEpoch: original.controllerEpoch ?? null, reason: event.reason, original, originalDigest: digest2(canonical5(original)), receivedAt: new Date(event.received_at).toISOString() };
    }), ...conflicts.map((conflict) => {
      const original = JSON.parse(conflict.original_json);
      return { submissionId: conflict.id, matchId, eventId: typeof original.eventId === "string" ? original.eventId : null, deviceId: typeof original.deviceId === "string" ? original.deviceId : null, clientSequence: typeof original.clientSequence === "number" ? original.clientSequence : null, controllerEpoch: typeof original.controllerEpoch === "number" ? original.controllerEpoch : null, reason: conflict.reason, original, originalDigest: digest2(canonical5(original)), receivedAt: new Date(conflict.created_at).toISOString() };
    })];
    const proposals = (await this.many("SELECT receipt_json FROM reconciliation_proposals WHERE match_id=$1 ORDER BY created_at,id", [matchId])).map((item) => JSON.parse(item.receipt_json));
    return { matchId, acceptedRevision: state.revision, submissions, proposals, policy: Q08_RECONCILIATION_POLICY };
  }
  async proposeReconciliation(principal, matchId, input) {
    const row = await this.managerMatch(principal, matchId);
    const state = JSON.parse(row.state_json);
    if (!input || Object.keys(input).some((key) => !["proposalId", "baseRevision", "sourceSubmissionIds", "reason", "resolution", "commands"].includes(key)))
      bad2("Use only the documented immutable reconciliation proposal fields.");
    const signature2 = digest2(canonical5(input));
    const existing = await this.one("SELECT signature,receipt_json FROM reconciliation_proposals WHERE id=$1 AND match_id=$2 AND actor_id=$3", [input.proposalId, matchId, principal.accountId]);
    if (existing) {
      if (existing.signature !== signature2)
        throw new AccessError("RECONCILIATION_PROPOSAL_CONFLICT", 409, "That proposal identity already preserves different review evidence.");
      return JSON.parse(existing.receipt_json);
    }
    const snapshot = await this.reconciliation(principal, matchId);
    const preview = previewReconciliation(state, input, snapshot.submissions, { actorId: principal.accountId, recordedAtMs: this.now() });
    if (!preview.valid)
      throw new AccessError("RECONCILIATION_PREVIEW_REJECTED", 422, preview.issues.join(" ").slice(0, 1500));
    const { projectedState: discarded, ...savedPreview } = preview;
    void discarded;
    const receipt = { input, matchId, actorId: principal.accountId, createdAt: new Date(this.now()).toISOString(), sourceDigests: input.sourceSubmissionIds.map((id) => ({ submissionId: id, originalDigest: snapshot.submissions.find((item) => item.submissionId === id).originalDigest })), acceptedStateDigest: digest2(canonical5(state)), preview: savedPreview, status: "prepared", appliedRevision: null };
    await this.execute("INSERT INTO reconciliation_proposals(id,match_id,actor_id,signature,receipt_json,created_at) VALUES($1,$2,$3,$4,$5,$6)", [input.proposalId, matchId, principal.accountId, signature2, JSON.stringify(receipt), this.now()]);
    await this.audit(principal, "reconciliation.proposal_prepared", matchId, "q08_authority_unapproved");
    return receipt;
  }
  async recordFinishedContext(principal, matchId, policy) {
    const row = await this.managerMatch(principal, matchId);
    const state = JSON.parse(row.state_json);
    if (state.status !== "completed")
      return { status: "not_finished" };
    await this.refreshDetailedArchive(row, state);
    const community = await this.communityState(row.team_id, row.season_id);
    const existing = community.matches.find((item) => item.id === matchId);
    const quarantine = await this.one("SELECT event_id FROM events WHERE match_id=$1 AND disposition='quarantined' LIMIT 1", [matchId]);
    const conflict = await this.one("SELECT id FROM conflicting_submissions WHERE match_id=$1 LIMIT 1", [matchId]);
    const unresolved = Boolean(quarantine || conflict);
    if (existing) {
      const retainedFinishId = state.eventHistory?.filter((event) => event.type === "half.ended").at(-1)?.id;
      const retainedFinish = retainedFinishId ? await this.one("SELECT envelope_json FROM events WHERE event_id=$1 AND match_id=$2 AND disposition='accepted'", [retainedFinishId, matchId]) : void 0;
      const currentGrant = await this.one("SELECT epoch FROM controller_grants WHERE match_id=$1", [matchId]);
      const sourceEpoch = retainedFinish ? JSON.parse(retainedFinish.envelope_json).controllerEpoch : null;
      const quality = unresolved ? "conflicted" : state.recoveryRequired || sourceEpoch !== currentGrant?.epoch || finishEligibilityChanged(state, existing) ? "review_required" : existing.finishQuality;
      if (quality !== existing.finishQuality) {
        const next2 = { ...community, revision: community.revision + 1, matches: community.matches.map((match) => match.id === matchId ? { ...match, finishQuality: quality } : match), audit: [...community.audit, { id: randomUUID3(), actorAccountId: null, action: "service.finish_evidence_flagged_without_reopening", atMs: this.now() }] };
        await this.saveDocument(row.team_id, row.season_id, "community", next2);
      }
      return { status: "original_context_preserved", finishQuality: quality };
    }
    const finishId = state.eventHistory?.filter((event) => event.type === "half.ended").at(-1)?.id;
    const finishRow = finishId ? await this.one("SELECT envelope_json,actor_id FROM events WHERE event_id=$1 AND match_id=$2 AND disposition='accepted'", [finishId, matchId]) : void 0;
    const finish = finishRow ? JSON.parse(finishRow.envelope_json) : null;
    const mappingRow = finish ? await this.one("SELECT mapping_json FROM clock_mappings WHERE challenge_id=$1 AND match_id=$2", [finish.clockEvidence.anchorId, matchId]) : void 0;
    const grant = await this.one("SELECT epoch FROM controller_grants WHERE match_id=$1", [matchId]);
    const preparation = await this.document(row.team_id, row.season_id, "preparation");
    const fixture = preparation.fixtures.find((item) => item.id === matchId && item.seasonId === row.season_id);
    const playedDate = state.config.fixture?.playedDate ?? fixture?.playedDate;
    if (!playedDate)
      return { status: "accepted_fixture_date_required" };
    const scheduledAtMs = Date.parse(`${playedDate}T00:00:00Z`);
    const context = deriveFinishedMatchContext({ state, acceptedFinish: finish, acceptedFinishActorId: finishRow?.actor_id ?? null, teamId: row.team_id, seasonId: row.season_id, currentControllerEpoch: grant?.epoch ?? 0, unresolvedConflicts: unresolved, mapping: mappingRow ? JSON.parse(mappingRow.mapping_json) : null, policy: policy ?? null, serverNowMs: this.now(), scheduledAtMs, sharing: "manager_only", sharingPolicyVersion: 0 });
    const next = { ...community, revision: community.revision + 1, matches: [...community.matches, { ...context, voteCutoffAtMs: null, cutoffSource: "unresolved", finalisationDeadlineAtMs: context.actualFullTimeAtMs === null ? null : context.actualFullTimeAtMs + 36e5 }], audit: [...community.audit, { id: randomUUID3(), actorAccountId: null, action: "service.accepted_finish_registered_manager_only", atMs: this.now() }] };
    await this.saveDocument(row.team_id, row.season_id, "community", next);
    return { status: "registered_from_accepted_history", finishQuality: context.finishQuality };
  }
  async refreshDetailedArchive(row, match) {
    const saved = await this.one("SELECT value_json FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='records'", [row.team_id, row.season_id]);
    if (!saved)
      return;
    const records = JSON.parse(saved.value_json);
    const archived = records.results.find((item) => item.id === match.config.matchId && item.recordMode === "detailed_live");
    if (!archived || (archived.sourceMatchRevision ?? -1) >= match.revision)
      return;
    if (match.recoveryRequired) {
      if (archived.detailCompleteness !== "review_required") {
        const reviewed = { ...records, revision: records.revision + 1, results: records.results.map((item) => item.id === archived.id ? { ...item, detailCompleteness: "review_required", revision: item.revision + 1 } : item) };
        await this.saveDocument(row.team_id, row.season_id, "records", reviewed);
      }
      return;
    }
    const context = { matchId: archived.id, playedDate: archived.playedDate, opponent: archived.opponent, homeAway: archived.homeAway, fixtureClass: archived.fixtureClass };
    const updated = reduceRecords({ ...records, liveMatch: context }, { type: "live.archive", commandId: `accepted-archive-${digest2(canonical5([archived.id, match.revision]))}`, at: new Date(this.now()).toISOString(), actor: "manager", match, reason: "Existing detailed archive refreshed from the newer accepted canonical match revision; original source events and prior archive audit remain retained." });
    const projected = { ...updated, liveMatch: records.liveMatch };
    await this.saveDocument(row.team_id, row.season_id, "records", projected);
  }
  async upload(principal, matchId, token, values) {
    const row = await this.managerMatch(principal, matchId);
    if (!Array.isArray(values) || values.length === 0 || values.length > 100)
      bad2("Upload between one and 100 ordered events.");
    const grant = await this.one("SELECT * FROM controller_grants WHERE match_id=$1", [matchId]);
    const currentCapability = !!grant && grant.account_id === principal.accountId && !!token && digest2(token) === grant.capability_hash;
    let state = JSON.parse(row.state_json);
    const results = [];
    for (const value of values) {
      const event = validateEnvelope2(value, matchId);
      const device = await this.one("SELECT account_id FROM devices WHERE id=$1", [event.deviceId]);
      if (!device || device.account_id !== principal.accountId)
        throw new AccessError("DEVICE_BINDING_REQUIRED", 403, "This event device is not enrolled to the authenticated account.");
      const signature2 = digest2(canonical5(event));
      const previous = await this.one("SELECT * FROM events WHERE event_id=$1", [event.eventId]);
      if (previous) {
        if (previous.match_id !== matchId || previous.signature !== signature2) {
          await this.execute("INSERT INTO conflicting_submissions VALUES($1,$2,$3,$4,$5,$6)", [randomUUID3(), matchId, principal.accountId, JSON.stringify(value), "EVENT_ID_CONFLICT", this.now()]);
          results.push({ eventId: event.eventId, clientSequence: event.clientSequence, disposition: "quarantined", reason: "EVENT_ID_CONFLICT", revision: null, duplicate: false });
        } else
          results.push({ eventId: previous.event_id, clientSequence: previous.client_sequence, disposition: previous.disposition, reason: previous.reason, revision: previous.revision, duplicate: true });
        continue;
      }
      const stream = await this.one("SELECT sequence,previous_event_id FROM streams WHERE match_id=$1 AND device_id=$2", [matchId, event.deviceId]);
      if (event.clientSequence !== (stream?.sequence ?? 0) + 1 || event.previousEventId !== (stream?.previous_event_id ?? null)) {
        await this.execute("INSERT INTO conflicting_submissions VALUES($1,$2,$3,$4,$5,$6)", [randomUUID3(), matchId, principal.accountId, JSON.stringify(value), "SEQUENCE_GAP_OR_REUSE", this.now()]);
        results.push({ eventId: event.eventId, clientSequence: event.clientSequence, disposition: "quarantined", reason: "SEQUENCE_GAP_OR_REUSE", revision: null, duplicate: false });
        continue;
      }
      let reason = null;
      if (event.contractVersion !== EVENT_CONTRACT_VERSION2 || event.schemaVersion !== 1 || event.engineVersion !== ENGINE_VERSION)
        reason = "UNSUPPORTED_EVENT_VERSION";
      else if (!grant || !currentCapability || event.controllerEpoch !== grant.epoch || event.deviceId !== grant.device_id)
        reason = "STALE_CONTROLLER";
      else if (grant.frozen)
        reason = "HANDOVER_WRITES_FROZEN";
      else if (event.baseRevision !== state.revision)
        reason = "STALE_REVISION";
      if (!reason) {
        try {
          const next = reduceMatch(state, { ...event.command, actorId: principal.accountId });
          const effective = effectiveEventTime(state, next, event.command);
          if (effective.half !== event.effectiveHalf || effective.halfElapsedMs !== event.halfElapsedMs || effective.matchElapsedMs !== event.matchElapsedMs)
            throw new Error("Effective playing-time evidence differs from the command.");
          state = next;
        } catch {
          reason = "INVALID_MATCH_TRANSITION";
        }
      }
      const disposition = reason ? "quarantined" : "accepted";
      const revision = reason ? null : state.revision;
      await this.execute("INSERT INTO events(event_id,match_id,device_id,client_sequence,envelope_json,signature,disposition,reason,revision,received_at,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [event.eventId, matchId, event.deviceId, event.clientSequence, JSON.stringify(event), signature2, disposition, reason, revision, this.now(), principal.accountId]);
      await this.execute("INSERT INTO streams(match_id,device_id,sequence,previous_event_id) VALUES($1,$2,$3,$4) ON CONFLICT(match_id,device_id) DO UPDATE SET sequence=excluded.sequence,previous_event_id=excluded.previous_event_id", [matchId, event.deviceId, event.clientSequence, event.eventId]);
      results.push({ eventId: event.eventId, clientSequence: event.clientSequence, disposition, reason, revision, duplicate: false });
    }
    if (results.some((item) => item.disposition === "accepted" && !item.duplicate))
      await this.execute("UPDATE matches SET state_json=$1,last_sync_at=$2 WHERE id=$3", [JSON.stringify(state), this.now(), matchId]);
    await this.audit(principal, "events.uploaded", matchId, results.some((item) => item.disposition === "quarantined") ? "review_required" : "accepted");
    if (results.some((item) => item.disposition === "accepted" && !item.duplicate))
      await this.enqueueNotifications(row.team_id, row.season_id, "match", matchId, `accepted-revision-${state.revision}`);
    return { results, revision: state.revision, pendingReview: results.some((item) => item.disposition === "quarantined") };
  }
  async quarantine(principal, matchId) {
    await this.managerMatch(principal, matchId);
    return [...await this.many("SELECT event_id,device_id,client_sequence,envelope_json,reason,received_at FROM events WHERE match_id=$1 AND disposition='quarantined' ORDER BY received_at,client_sequence", [matchId]), ...await this.many("SELECT id,original_json,reason,created_at FROM conflicting_submissions WHERE match_id=$1 ORDER BY created_at", [matchId])];
  }
  async offerHandover(principal, matchId, token, toAccountId, toDeviceId, baseRevision) {
    const row = await this.managerMatch(principal, matchId);
    const grant = await this.assertController(principal, matchId, token);
    if (grant.frozen)
      throw new AccessError("TRANSFER_PENDING", 409, "A controller transfer is already pending.");
    const state = JSON.parse(row.state_json);
    if (state.revision !== baseRevision)
      throw new AccessError("STALE_REVISION", 409, "Synchronise the accepted checkpoint before handover.");
    if (state.status.endsWith("_running"))
      throw new AccessError("CLOCK_ANCHOR_REQUIRED", 409, "Running handover requires a verified UTC/device clock exchange. This development service supports handover while the match clock is already paused, at half-time or before kick-off; it never silently pauses play.");
    if (!validId4(toAccountId) || !validDeviceId2(toDeviceId))
      bad2("A target account and canonical device identifier of at most 120 characters are required.");
    const target = await this.one("SELECT * FROM accounts WHERE id=$1", [toAccountId]);
    if (!target)
      throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    const targetPrincipal = { accountId: target.id, issuer: target.issuer, subject: target.subject, identityClassification: target.classification, adultVerified: !!target.adult_verified, strongAuth: !!target.strong_auth_enrolled, authenticatedAt: this.now(), status: target.status };
    assertCanManageTeam(targetPrincipal, await this.memberships(), row.team_id, row.season_id, this.now());
    const id = randomUUID3();
    await this.execute("INSERT INTO transfers VALUES($1,$2,$3,$4,$5,$6,$7)", [id, matchId, grant.epoch, toAccountId, toDeviceId, "pending", this.now()]);
    await this.execute("UPDATE controller_grants SET frozen=1 WHERE match_id=$1", [matchId]);
    await this.audit(principal, "controller.transfer_offered", matchId, "pending");
    return { transferId: id, state: "pending", acceptedRevision: state.revision };
  }
  async acceptHandover(principal, matchId, transferId, deviceId) {
    await this.managerMatch(principal, matchId);
    assertAdultAuthority(principal, false, this.now());
    const transfer = await this.one("SELECT * FROM transfers WHERE id=$1 AND match_id=$2", [transferId, matchId]);
    const grant = await this.one("SELECT * FROM controller_grants WHERE match_id=$1", [matchId]);
    if (!transfer || transfer.to_account_id !== principal.accountId || transfer.to_device_id !== deviceId)
      throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    if (transfer.state !== "pending" || !grant || grant.epoch !== transfer.from_epoch || !grant.frozen)
      throw new AccessError("TRANSFER_CONFLICT", 409, "Check the authoritative transfer status before retrying.");
    await this.bindDevice(principal, deviceId);
    const capability = randomBytes2(32).toString("base64url");
    const epoch = grant.epoch + 1;
    await this.execute("UPDATE controller_grants SET epoch=$1,account_id=$2,device_id=$3,capability_hash=$4,frozen=0 WHERE match_id=$5", [epoch, principal.accountId, deviceId, digest2(capability), matchId]);
    await this.execute("UPDATE transfers SET state='accepted' WHERE id=$1", [transferId]);
    await this.execute("INSERT INTO controller_history VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [randomUUID3(), matchId, epoch, principal.accountId, grant.device_id, deviceId, "transferred", null, this.now()]);
    await this.audit(principal, "controller.transferred", matchId, "accepted");
    return { epoch, deviceId, controllerToken: capability, checkpoint: (await this.download(principal, matchId, deviceId)).deviceCheckpoint, acceptedRevision: JSON.parse((await this.match(matchId)).state_json).revision };
  }
  async recover(principal, matchId, deviceId, reason) {
    const row = await this.managerMatch(principal, matchId);
    assertAdultAuthority(principal, true, this.now());
    if (!validDeviceId2(deviceId) || typeof reason !== "string" || reason.trim().length < 5 || reason.length > 500)
      bad2("Recovery needs a target canonical device identifier of at most 120 characters and a concise audit reason.");
    await this.bindDevice(principal, deviceId);
    const old = await this.one("SELECT * FROM controller_grants WHERE match_id=$1", [matchId]);
    const capability = randomBytes2(32).toString("base64url");
    const epoch = (old?.epoch ?? 0) + 1;
    const state = JSON.parse(row.state_json);
    if (state.status.endsWith("_running")) {
      state.recoveryRequired = true;
      state.recoveryReason = "Controller recovery: reconcile the referee clock and any unsynchronised old-device events.";
      await this.execute("UPDATE matches SET state_json=$1 WHERE id=$2", [JSON.stringify(state), matchId]);
    }
    await this.execute("INSERT INTO controller_grants(match_id,epoch,account_id,device_id,capability_hash,frozen) VALUES($1,$2,$3,$4,$5,0) ON CONFLICT(match_id) DO UPDATE SET epoch=excluded.epoch,account_id=excluded.account_id,device_id=excluded.device_id,capability_hash=excluded.capability_hash,frozen=0", [matchId, epoch, principal.accountId, deviceId, digest2(capability)]);
    await this.execute("UPDATE transfers SET state='superseded' WHERE match_id=$1 AND state='pending'", [matchId]);
    await this.execute("INSERT INTO controller_history VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [randomUUID3(), matchId, epoch, principal.accountId, old?.device_id ?? null, deviceId, "recovered", reason.trim(), this.now()]);
    await this.audit(principal, "controller.recovered", matchId, "reconciliation_required");
    return { epoch, deviceId, controllerToken: capability, reconciliationRequired: true, checkpoint: (await this.download(principal, matchId, deviceId)).deviceCheckpoint };
  }
  async staffRevision(teamId, seasonId) {
    const row = await this.one("SELECT revision FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='staff'", [teamId, seasonId]);
    return row?.revision ?? 0;
  }
  async bumpStaffRevision(teamId, seasonId) {
    const revision = await this.staffRevision(teamId, seasonId) + 1;
    await this.saveDocument(teamId, seasonId, "staff", { revision });
    return revision;
  }
  async managers(principal, teamId, seasonId, requestedRole) {
    assertTeamRole(principal, await this.memberships(), teamId, seasonId, ["administrator"], this.now());
    assertAdultAuthority(principal, false, this.now());
    const accounts = await this.many("SELECT * FROM accounts WHERE id IN (SELECT account_id FROM memberships WHERE team_id=$1)", [teamId]);
    const community = await this.document(teamId, seasonId, "community");
    const evidence2 = accounts.map((account2) => ({ accountId: account2.id, label: community.accounts.find((item) => item.id === account2.id)?.label ?? "Verified adult account", status: account2.status, identityClassification: account2.classification, adultVerified: Boolean(account2.adult_verified), strongAuthEnrolled: Boolean(account2.strong_auth_enrolled) }));
    return managerRoster({ principal, memberships: await this.memberships(), accounts: evidence2, teamId, seasonId, nowMs: this.now(), revision: await this.staffRevision(teamId, seasonId), requestedRole });
  }
  async assignManager(actor, teamId, seasonId, accountId, expectedRevision) {
    assertTeamRole(actor, await this.memberships(), teamId, seasonId, ["administrator"], this.now());
    assertAdultAuthority(actor, true, this.now());
    if (!validId4(accountId))
      bad2("A canonical account identifier is required.");
    if (expectedRevision !== void 0 && (!nonnegative4(expectedRevision) || expectedRevision !== await this.staffRevision(teamId, seasonId)))
      throw new AccessError("STALE_REVISION", 409, "Refresh the current staff assignments before changing them.");
    const account2 = await this.one("SELECT * FROM accounts WHERE id=$1", [accountId]);
    if (!account2)
      throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    const target = { accountId: account2.id, issuer: account2.issuer, subject: account2.subject, identityClassification: account2.classification, adultVerified: !!account2.adult_verified, strongAuth: !!account2.strong_auth_enrolled, authenticatedAt: this.now(), status: account2.status };
    assertCanAssignManager(actor, target, await this.memberships(), teamId, seasonId, this.now());
    const alreadyActive = (await this.memberships()).some((item) => item.accountId === accountId && item.teamId === teamId && item.seasonId === seasonId && item.role === "manager" && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > this.now()));
    if (!alreadyActive) {
      await this.execute("INSERT INTO memberships(account_id,team_id,season_id,role) VALUES($1,$2,$3,'manager') ON CONFLICT(account_id,team_id,season_id,role) DO UPDATE SET revoked_at=NULL,expires_at=NULL", [accountId, teamId, seasonId]);
      await this.bumpStaffRevision(teamId, seasonId);
      await this.audit(actor, "manager.assigned", teamId, "accepted");
    }
    return { accountId, teamId, seasonId, role: "manager", revision: await this.staffRevision(teamId, seasonId), acceptedAt: new Date(this.now()).toISOString() };
  }
  async revokeManager(actor, teamId, seasonId, input, expectedRevision) {
    assertTeamRole(actor, await this.memberships(), teamId, seasonId, ["administrator"], this.now());
    assertAdultAuthority(actor, true, this.now());
    if (!input || Object.keys(input).some((key) => !["accountId", "reason", "confirmRevocation"].includes(key)) || !validId4(input.accountId) || input.confirmRevocation !== true || typeof input.reason !== "string" || input.reason.trim().length < 5 || input.reason.length > 500)
      bad2("Confirm a scoped manager revocation and record its evidence reason.");
    if (expectedRevision !== void 0 && (!nonnegative4(expectedRevision) || expectedRevision !== await this.staffRevision(teamId, seasonId)))
      throw new AccessError("STALE_REVISION", 409, "Refresh the current staff assignments before changing them.");
    const member = await this.one("SELECT account_id,revoked_at FROM memberships WHERE account_id=$1 AND team_id=$2 AND season_id=$3 AND role='manager'", [input.accountId, teamId, seasonId]);
    if (!member)
      throw new AccessError("NOT_FOUND", 404, "That manager assignment is outside this scope.");
    if (member.revoked_at === null) {
      await this.execute("UPDATE memberships SET revoked_at=$1 WHERE account_id=$2 AND team_id=$3 AND season_id=$4 AND role='manager'", [this.now(), input.accountId, teamId, seasonId]);
      await this.execute("UPDATE controller_grants SET frozen=1 WHERE account_id=$1 AND team_id=$2 AND season_id=$3", [input.accountId, teamId, seasonId]);
      await this.bumpStaffRevision(teamId, seasonId);
      await this.audit(actor, "manager.assignment_revoked", input.accountId, input.reason.trim());
    }
    return { accountId: input.accountId, teamId, seasonId, role: "manager", revision: await this.staffRevision(teamId, seasonId), acceptedAt: new Date(this.now()).toISOString(), revoked: true, controllerFrozen: true, otherSeasonAssignmentsRetained: true, remainingActiveTeamSeasons: (await this.memberships()).filter((item) => item.accountId === input.accountId && item.teamId === teamId && item.role === "manager" && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > this.now())).map((item) => item.seasonId) };
  }
  async privacyRecords(principal) {
    const rows = await this.many("SELECT id,account_id,kind,status,team_id,season_id,affected_memberships_json,created_at FROM privacy_requests WHERE account_id=$1 ORDER BY created_at,id", [principal.accountId]);
    return rows.map((row) => ({ requestId: row.id, accountId: row.account_id, kind: row.kind, status: row.status, scope: row.kind === "leave_team" ? row.team_id && row.season_id ? { type: "team_season", teamId: row.team_id, seasonId: row.season_id } : null : { type: "all_memberships" }, affectedMemberships: row.affected_memberships_json === null ? null : JSON.parse(row.affected_memberships_json), createdAtMs: row.created_at }));
  }
  async privacyRequest(principal, input) {
    const plan = prepareAccountPrivacyRequest({ principal, memberships: await this.memberships(), input, nowMs: this.now() });
    const pending = await this.one("SELECT p.id FROM privacy_pending_keys k JOIN privacy_requests p ON p.id=k.request_id WHERE k.business_key=$1 AND p.account_id=$2 AND p.status='pending_verification_and_policy'", [plan.businessKey, principal.accountId]);
    let requestId = pending?.id;
    if (!requestId) {
      const retained = plan.scope.type === "team_season" ? await this.one("SELECT id FROM privacy_requests WHERE account_id=$1 AND kind=$2 AND team_id=$3 AND season_id=$4 AND status='pending_verification_and_policy' ORDER BY created_at,id LIMIT 1", [principal.accountId, plan.kind, plan.scope.teamId, plan.scope.seasonId]) : await this.one("SELECT id FROM privacy_requests WHERE account_id=$1 AND kind=$2 AND team_id IS NULL AND season_id IS NULL AND status='pending_verification_and_policy' ORDER BY created_at,id LIMIT 1", [principal.accountId, plan.kind]);
      requestId = retained?.id;
    }
    if (!requestId) {
      requestId = randomUUID3();
      await this.execute("INSERT INTO privacy_requests(id,account_id,kind,status,policy_version,verified_at,created_at,team_id,season_id,affected_memberships_json) VALUES($1,$2,$3,$4,NULL,NULL,$5,$6,$7,$8)", [requestId, principal.accountId, plan.kind, plan.status, this.now(), plan.scope.type === "team_season" ? plan.scope.teamId : null, plan.scope.type === "team_season" ? plan.scope.seasonId : null, JSON.stringify(plan.affectedMemberships)]);
      await this.audit(principal, "privacy.requested", requestId, "pending_verification_and_policy");
    }
    await this.execute("INSERT INTO privacy_pending_keys(business_key,request_id) VALUES($1,$2) ON CONFLICT(business_key) DO UPDATE SET request_id=excluded.request_id", [plan.businessKey, requestId]);
    return (await this.privacyRequests(principal)).items.find((item) => item.requestId === requestId);
  }
  async privacyRequests(principal) {
    return projectAccountPrivacyRequests({ principal, memberships: await this.memberships(), records: await this.privacyRecords(principal), nowMs: this.now() });
  }
  /** Explicit setup seam: an authorised operator imports verified provider-to-account mappings; no token creates authority. */
  async bindIdentity(accountId, issuer, subject) {
    await this.execute("UPDATE accounts SET issuer=$1,subject=$2 WHERE id=$3", [issuer, subject, accountId]);
  }
  async bindDevice(principal, deviceId) {
    const device = await this.one("SELECT account_id FROM devices WHERE id=$1", [deviceId]);
    if (device && device.account_id !== principal.accountId)
      throw new AccessError("DEVICE_ACCOUNT_CONFLICT", 409, "Enrol a separate device identity for this account.");
    await this.execute("INSERT INTO devices(id,account_id) VALUES($1,$2) ON CONFLICT(id) DO NOTHING", [deviceId, principal.accountId]);
  }
  async teamMatches(principal, teamId, seasonId, requestedRole, query = { limit: 25, cursor: null }) {
    const memberships = await this.memberships();
    const audience = matchPageAudience(principal, memberships, teamId, seasonId, requestedRole, this.now());
    const scope = { principal, teamId, seasonId, role: audience.role, playerId: audience.playerId ?? null }, afterId = matchPagePosition(scope, query);
    const rows = await this.many('SELECT id,state_json,sharing_policy_json,last_sync_at FROM matches WHERE team_id=$1 AND season_id=$2 AND ($3::text IS NULL OR id COLLATE "C" > $3::text COLLATE "C") ORDER BY id COLLATE "C" LIMIT $4', [teamId, seasonId, afterId, query.limit + 1]);
    const visible = rows.slice(0, query.limit);
    return { items: visible.map((row) => filterMatchForPrincipal({ principal, memberships, teamId, seasonId, state: JSON.parse(row.state_json), policy: JSON.parse(row.sharing_policy_json), lastSyncAt: row.last_sync_at, requestedRole, now: this.now() })), nextCursor: rows.length > query.limit ? matchPageCursor(scope, visible[visible.length - 1].id) : null, serverTime: new Date(this.now()).toISOString() };
  }
  async document(teamId, seasonId, kind) {
    const row = await this.one("SELECT value_json FROM documents WHERE team_id=$1 AND season_id=$2 AND kind=$3", [teamId, seasonId, kind]);
    if (!row)
      throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    return JSON.parse(row.value_json);
  }
  async saveDocument(teamId, seasonId, kind, state) {
    await this.execute("INSERT INTO documents(team_id,season_id,kind,revision,value_json) VALUES($1,$2,$3,$4,$5) ON CONFLICT(team_id,season_id,kind) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json", [teamId, seasonId, kind, state.revision, JSON.stringify(state)]);
  }
  async enqueueNotifications(teamId, seasonId, category, entityId, sourceId) {
    const workerJob = this.db.applicationContext?.kind === "worker_job";
    const observed = workerJob ? (await this.one("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms"))?.now_ms : this.now();
    if (typeof observed !== "number" || !Number.isSafeInteger(observed) || observed < 0) throw new Error("DATABASE_CLOCK_UNAVAILABLE");
    const recipients = /* @__PURE__ */ new Map();
    const priority = { manager: 3, player: 2, spectator: 1, administrator: 0 };
    for (const member of (await this.memberships()).filter((item) => item.teamId === teamId && item.seasonId === seasonId && ["manager", "player", "spectator"].includes(item.role) && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > observed))) {
      const current3 = recipients.get(member.accountId);
      if (!current3 || priority[member.role] > priority[current3.role])
        recipients.set(member.accountId, member);
    }
    let inserted = 0;
    for (const member of recipients.values()) {
      if (member.role === "administrator" || member.role === "player" && !member.playerId)
        continue;
      const businessKey = `notify:${digest2(canonical5([teamId, seasonId, category, entityId, sourceId, member.accountId, member.role]))}`;
      const job = createTeamNotificationJob({ id: randomUUID3(), businessKey, accountId: member.accountId, teamId, seasonId, audience: member.role, playerId: member.role === "player" ? member.playerId : null, category, entityId, dueAtMs: observed });
      if (workerJob) {
        const result = await this.one("SELECT longball.enqueue_award_notification($1,$2,$3::jsonb,$4) AS changes", [job.id, businessKey, JSON.stringify(job), job.dueAtMs]);
        inserted += Number(result?.changes ?? 0);
      } else {
        const result = await this.execute("INSERT INTO jobs(id,business_key,kind,payload_json,due_at) VALUES($1,$2,'notification.dispatch',$3,$4) ON CONFLICT(business_key) DO NOTHING", [job.id, businessKey, JSON.stringify(job), job.dueAtMs]);
        inserted += Number(result.changes);
      }
    }
    return inserted;
  }
  async preparation(principal, teamId, seasonId) {
    assertCanManageTeam(principal, await this.memberships(), teamId, seasonId, this.now());
    return await this.document(teamId, seasonId, "preparation");
  }
  async configuration(principal, teamId, seasonId, role) {
    if (role)
      assertTeamRole(principal, await this.memberships(), teamId, seasonId, role === "manager" || role === "administrator" ? [role] : [], this.now());
    const state = await this.document(teamId, seasonId, "preparation");
    return configurationServiceView({ principal, memberships: await this.memberships(), preparation: state, seasonId, nowMs: this.now() });
  }
  async configurationCommand(principal, teamId, seasonId, command, role) {
    await this.configuration(principal, teamId, seasonId, role);
    if (!command || !["club.updated", "team.updated"].includes(command.type))
      bad2("Only club or team configuration can be changed in this context.");
    if (role && command.type === "club.updated" && role !== "administrator")
      throw new AccessError("NOT_FOUND", 404, "Choose the current administrator context to administer the club.");
    const state = applyConfigurationServiceCommand({ principal, memberships: await this.memberships(), preparation: await this.document(teamId, seasonId, "preparation"), seasonId, nowMs: this.now(), command });
    await this.saveDocument(teamId, seasonId, "preparation", state);
    await this.audit(principal, command.type, teamId, "administrator_configuration_accepted");
    return await this.configuration(principal, teamId, seasonId, role);
  }
  async seasonContext(principal, teamId, seasonId) {
    const community = await this.communityState(teamId, seasonId);
    const accounts = await this.many("SELECT * FROM accounts", []);
    const catalogue = await this.many("SELECT season_id,start_year FROM team_seasons WHERE team_id=$1", [teamId]);
    if (catalogue.some((season) => season.start_year === null)) throw new AccessError("SEASON_SCOPE_REVIEW_REQUIRED", 409, "Record the existing season catalogue before creating another season.");
    const existingSeasons = catalogue.map((season) => ({ teamId, id: season.season_id, startYear: season.start_year }));
    return {
      principal,
      memberships: await this.memberships(),
      existingSeasons,
      nowMs: this.now(),
      preparation: await this.document(teamId, seasonId, "preparation"),
      records: await this.document(teamId, seasonId, "records"),
      community,
      accounts: accounts.map((account2) => ({ accountId: account2.id, label: community.accounts.find((item) => item.id === account2.id)?.label ?? "Verified account", status: account2.status, identityClassification: account2.classification, adultVerified: Boolean(account2.adult_verified), strongAuthEnrolled: Boolean(account2.strong_auth_enrolled) }))
    };
  }
  async seasonOptions(principal, teamId, seasonId) {
    return seasonRolloverOptions(await this.seasonContext(principal, teamId, seasonId));
  }
  async createSeason(principal, teamId, seasonId, command) {
    const context = await this.seasonContext(principal, teamId, seasonId);
    const plan = planSeasonRollover({ ...context, command });
    if (await this.one("SELECT kind FROM documents WHERE team_id=$1 AND season_id=$2 LIMIT 1", [teamId, plan.receipt.seasonId]))
      throw new AccessError("SEASON_EXISTS", 409, "That destination season already has saved documents.");
    const team = await this.one("SELECT club_id FROM teams WHERE id=$1 AND scope_status='resolved'", [teamId]);
    const destination = plan.preparation.seasons.find((item) => item.id === plan.receipt.seasonId);
    if (!team || !destination) throw new AccessError("NOT_FOUND", 404, "The authorised team season is unavailable.");
    await this.execute("INSERT INTO team_seasons(club_id,team_id,season_id,label,start_year,start_date,end_date) VALUES($1,$2,$3,$4,$5,$6,$7)", [team.club_id, teamId, destination.id, destination.label, destination.startYear, destination.startDate, destination.endDate]);
    for (const member of plan.memberships)
      await this.execute("INSERT INTO memberships(account_id,team_id,season_id,role,player_id,expires_at,revoked_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [member.accountId, member.teamId, member.seasonId, member.role, member.playerId ?? null, member.expiresAt ?? null, member.revokedAt ?? null]);
    await this.saveDocument(teamId, plan.receipt.seasonId, "preparation", plan.preparation);
    await this.saveDocument(teamId, plan.receipt.seasonId, "records", plan.records);
    await this.saveDocument(teamId, plan.receipt.seasonId, "community", plan.community);
    await this.audit(principal, "season.created_from_explicit_assignments", plan.receipt.seasonId, "accepted_no_spectator_renewal");
    return plan.receipt;
  }
  /** Called inside the preparation mutation transaction; current labels never rewrite saved match evidence. */
  async projectPreparationRecords(teamId, seasonId, preparation, sourceCommandId) {
    const previous = await this.document(teamId, seasonId, "records");
    const labels = new Map(previous.players.map((player) => [player.id, player]));
    for (const profile of preparation.profiles.filter((profile2) => profile2.seasonId === seasonId))
      labels.set(profile.playerId, { id: profile.playerId, label: profile.displayName });
    const players = [...labels.values()];
    const evidence2 = trainingAttendanceEvidence({ ...preparation, training: preparation.training.filter((session) => session.seasonId === seasonId) });
    let records = previous;
    const at = new Date(this.now()).toISOString();
    if (canonical5(players) !== canonical5(previous.players))
      records = {
        ...records,
        players,
        revision: records.revision + 1,
        audit: [...records.audit, { commandId: `preparation-roster-${sourceCommandId}`, action: "preparation.roster.projected", matchId: null, at, reason: "Current season roster labels updated from preparation; saved match snapshots preserved.", before: null, after: null }]
      };
    if (canonical5(evidence2) !== canonical5(previous.trainingAttendance))
      records = reduceRecords(records, { type: "training.evidence.replace", commandId: `preparation-training-${sourceCommandId}`, at, actor: "manager", evidence: evidence2 });
    if (records !== previous)
      await this.saveDocument(teamId, seasonId, "records", records);
  }
  async preparationCommand(principal, teamId, seasonId, command) {
    const previous = await this.preparation(principal, teamId, seasonId);
    const types2 = ["club.updated", "team.updated", "season.rolled_over", "profile.saved", "roster.imported", "profile.archived", "formation.saved", "fixture.saved", "fixture.status_changed", "fixture.response_recorded", "fixture.selection_saved", "fixture.attendance_recorded", "fixture.prepared", "match_plan.saved", "match_plan.applied", "match_plan.cleared", "training.series_created", "training.series_updated", "training.series_cancelled", "training.saved", "training.status_changed", "training.response_recorded", "training.attendance_recorded"];
    if (!command || !types2.includes(command.type))
      bad2("Unsupported preparation command.");
    if (command.type === "season.rolled_over")
      throw new AccessError("SEASON_ASSIGNMENT_REQUIRED", 503, "A connected new season requires approved manager/player assignments and explicit spectator renewal. The local rehearsal supports rollover; this service will not save an inaccessible new season or silently copy authority.");
    if (command.type === "club.updated") {
      assertTeamRole(principal, await this.memberships(), teamId, seasonId, ["administrator"], this.now());
      assertAdultAuthority(principal, true, this.now());
    }
    const protectedFixtureIds = [];
    if (command.type === "match_plan.applied") {
      const match = await this.one("SELECT state_json FROM matches WHERE id=$1 AND team_id=$2 AND season_id=$3", [command.fixtureId, teamId, seasonId]);
      if (match) {
        const accepted2 = JSON.parse(match.state_json);
        if (accepted2.status !== "preparation" || accepted2.revision !== 0 || await this.one("SELECT match_id FROM controller_grants WHERE match_id=$1", [command.fixtureId]) || await this.one("SELECT event_id FROM events WHERE match_id=$1 LIMIT 1", [command.fixtureId])) protectedFixtureIds.push(command.fixtureId);
      }
    }
    const state = reducePreparation(previous, command, { nowMs: this.now(), protectedFixtureIds });
    if (command.type === "fixture.prepared") {
      const snapshot = state.snapshots.find((snapshot2) => snapshot2.fixtureId === command.fixtureId && snapshot2.preparedRevision === command.expectedRevision + 1);
      if (!snapshot)
        throw new AccessError("PREPARATION_SNAPSHOT_REQUIRED", 409, "The immutable prepared fixture snapshot is unavailable.");
      assertCanManageTeam(principal, await this.memberships(), teamId, snapshot.seasonId, this.now());
      const config = fixtureMatchConfig(state, snapshot);
      const existing = await this.one("SELECT * FROM matches WHERE id=$1", [config.matchId]);
      if (!existing)
        await this.insertMatch(config, teamId, snapshot.seasonId);
      else {
        if (existing.team_id !== teamId || existing.season_id !== snapshot.seasonId)
          throw new AccessError("MATCH_SCOPE_CONFLICT", 409, "That fixture identity already belongs to another match scope.");
        if (canonical5(JSON.parse(existing.config_json)) !== canonical5(config)) {
          const matchState = JSON.parse(existing.state_json);
          const claimed = await this.one("SELECT match_id FROM controller_grants WHERE match_id=$1", [config.matchId]);
          const history = await this.one("SELECT event_id FROM events WHERE match_id=$1 LIMIT 1", [config.matchId]);
          if (claimed || history || matchState.revision !== 0 || matchState.status !== "preparation")
            throw new AccessError("MATCH_HISTORY_EXISTS", 409, "This match already has a controller or recorded history. Preserve its saved snapshot and reconcile changes explicitly.");
          await this.execute("UPDATE matches SET config_json=$1,state_json=$2 WHERE id=$3", [JSON.stringify(config), JSON.stringify(createMatch(config)), config.matchId]);
        }
      }
    }
    if (command.type.startsWith("training.") || command.type.startsWith("profile.") || command.type === "roster.imported")
      await this.projectPreparationRecords(teamId, seasonId, state, command.id);
    await this.saveDocument(teamId, seasonId, "preparation", state);
    await this.audit(principal, command.type, teamId, "accepted");
    if (command.type === "fixture.saved")
      await this.enqueueNotifications(teamId, seasonId, "schedule", command.fixture.id, command.id);
    else if (command.type === "fixture.status_changed" || command.type === "fixture.selection_saved")
      await this.enqueueNotifications(teamId, seasonId, "schedule", command.fixtureId, command.id);
    else if (command.type === "training.saved")
      await this.enqueueNotifications(teamId, seasonId, "schedule", command.training.id, command.id);
    else if (command.type === "training.status_changed")
      await this.enqueueNotifications(teamId, seasonId, "schedule", command.trainingId, command.id);
    else if (command.type === "training.series_created")
      for (const occurrence of command.occurrences) await this.enqueueNotifications(teamId, seasonId, "schedule", occurrence.id, command.id);
    else if (command.type === "training.series_updated" || command.type === "training.series_cancelled")
      for (const id of command.occurrenceIds) await this.enqueueNotifications(teamId, seasonId, "schedule", id, command.id);
    return state;
  }
  async ownPreparation(principal, teamId, seasonId) {
    const membership = assertTeamRole(principal, await this.memberships(), teamId, seasonId, ["player"], this.now());
    const state = await this.document(teamId, seasonId, "preparation");
    const profiles = state.profiles.filter((profile2) => profile2.playerId === membership.playerId && profile2.seasonId === seasonId && profile2.active);
    if (profiles.length !== 1)
      throw new AccessError("NOT_FOUND", 404, "The requested own-player profile is unavailable.");
    const profile = profiles[0];
    return projectOwnPlayerPreparation(state, profile, seasonId);
  }
  async ownPreparationCommand(principal, teamId, seasonId, command) {
    const membership = assertTeamRole(principal, await this.memberships(), teamId, seasonId, ["player"], this.now());
    if (!command || !validId4(command.id) || !nonnegative4(command.expectedRevision) || !["own.preferences_saved", "own.fixture_response_recorded", "own.training_response_recorded"].includes(command.type))
      bad2("A valid own-player command and source revision are required.");
    const allowed = command.type === "own.preferences_saved" ? ["id", "expectedRevision", "type", "preferences"] : command.type === "own.fixture_response_recorded" ? ["id", "expectedRevision", "type", "fixtureId", "response"] : ["id", "expectedRevision", "type", "trainingId", "response"];
    if (Object.keys(command).some((key) => !allowed.includes(key)))
      bad2("Own-player commands cannot change another profile or manager-controlled fields.");
    const state = await this.document(teamId, seasonId, "preparation");
    const profiles = state.profiles.filter((profile2) => profile2.playerId === membership.playerId && profile2.seasonId === seasonId && profile2.active);
    if (profiles.length !== 1)
      throw new AccessError("NOT_FOUND", 404, "The requested own-player profile is unavailable.");
    const profile = profiles[0];
    const base = { id: command.id, expectedRevision: command.expectedRevision };
    const bound = command.type === "own.preferences_saved" ? { ...base, type: "profile.saved", profile: { ...profile, preferences: command.preferences } } : command.type === "own.fixture_response_recorded" ? { ...base, type: "fixture.response_recorded", fixtureId: command.fixtureId, profileId: profile.id, response: command.response } : { ...base, type: "training.response_recorded", trainingId: command.trainingId, profileId: profile.id, response: command.response };
    const updated = reducePreparation(state, bound);
    if (bound.type.startsWith("training.") || bound.type.startsWith("profile."))
      await this.projectPreparationRecords(teamId, seasonId, updated, command.id);
    await this.saveDocument(teamId, seasonId, "preparation", updated);
    await this.audit(principal, command.type, teamId, "accepted");
    return await this.ownPreparation(principal, teamId, seasonId);
  }
  /** SQL account/membership records remain the authority; the serializable model is a projection. */
  async communityState(teamId, seasonId) {
    const state = await this.document(teamId, seasonId, "community");
    const accounts = await this.many("SELECT * FROM accounts WHERE status='active'", []);
    const memberships = await this.memberships();
    return {
      ...state,
      accounts: accounts.map((account2) => ({ id: account2.id, label: state.accounts.find((person) => person.id === account2.id)?.label ?? "Verified account", classification: account2.classification === "unclassified" ? "spectator" : account2.classification, adultVerified: !!account2.adult_verified })),
      memberships: memberships.filter((item) => item.role === "manager" || item.role === "player").map((item) => ({ accountId: item.accountId, teamId: item.teamId, seasonId: item.seasonId, role: item.role, playerId: item.playerId, active: item.revokedAt == null && (item.expiresAt == null || item.expiresAt > this.now()) }))
    };
  }
  async communityActor(principal, teamId, seasonId, requestedRole, invitationAcceptance = false) {
    const memberships = await this.memberships();
    if (invitationAcceptance)
      return { accountId: principal.accountId, teamId, seasonId, role: "spectator" };
    const allowed = currentMemberships(principal, memberships, this.now()).filter((item) => item.teamId === teamId && item.seasonId === seasonId && ["manager", "player", "spectator"].includes(item.role));
    const chosen = requestedRole ? allowed.find((item) => item.role === requestedRole) : allowed.find((item) => item.role === "manager") ?? allowed[0];
    if (!chosen)
      throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    if (chosen.role === "manager")
      assertAdultAuthority(principal, false, this.now());
    const actor = { accountId: principal.accountId, teamId, seasonId, role: chosen.role, playerId: chosen.playerId };
    const document = await this.one("SELECT team_id FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='community'", [teamId, seasonId]);
    if (document && !communityCanAccess(await this.communityState(teamId, seasonId), actor, this.now()))
      throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    return actor;
  }
  async community(principal, teamId, seasonId, role) {
    const actor = await this.communityActor(principal, teamId, seasonId, role);
    const state = await this.communityState(teamId, seasonId);
    return { ...getCommunityView(state, actor, this.now()), revision: state.revision };
  }
  async communityCommand(principal, teamId, seasonId, command, role) {
    if (!command || !validId4(command.id) || typeof command.type !== "string")
      bad2("A typed community command with a stable identity is required.");
    if (command.type === "concern.updated" && !["under_review", "resolved"].includes(command.status))
      bad2("Invalid concern status.");
    if (command.type === "concern.submitted" && (!["photo", "uploader"].includes(command.targetType) || !["privacy", "inappropriate", "other"].includes(command.category)))
      bad2("Invalid concern category.");
    if (command.type === "uploader.hidden" && typeof command.hidden !== "boolean")
      bad2("Choose whether to hide the uploader.");
    if (command.type === "privacy.drafted" && !["export", "delete_global_account"].includes(command.requestType))
      bad2("Invalid privacy request type.");
    if (command.type === "match.registered")
      throw new AccessError("POLICY_APPROVAL_REQUIRED", 503, "Connected award and sharing context must be derived from accepted match evidence, a verified finish-time anchor and independently approved competition policy. Caller-supplied trusted finish or sharing policy is not accepted.");
    const actor = await this.communityActor(principal, teamId, seasonId, role, command.type === "invite.accepted");
    const previous = await this.communityState(teamId, seasonId);
    const state = applyCommunityCommand(previous, actor, command, this.now());
    await this.saveDocument(teamId, seasonId, "community", state);
    if (["invite.accepted", "invite.revoked", "grant.revoked"].includes(command.type))
      await this.synchronizeSpectatorMemberships(state);
    for (const match of state.matches.filter((match2) => match2.voteCutoffAtMs !== null && match2.finishQuality === "trusted" && !state.awards.some((award) => award.matchId === match2.id))) {
      const key = `award:${teamId}:${seasonId}:${match.id}:${match.voteCutoffAtMs}`;
      await this.execute("INSERT INTO jobs(id,business_key,kind,payload_json,due_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(business_key) DO NOTHING", [randomUUID3(), key, "award.finalise", JSON.stringify({ teamId, seasonId, matchId: match.id }), match.voteCutoffAtMs]);
    }
    await this.audit(principal, command.type, teamId, "accepted");
    if (command.type === "photo.submitted" || command.type === "photo.revised" || command.type === "photo.published" || command.type === "photo.reviewed" && command.decision === "approve")
      await this.enqueueNotifications(teamId, seasonId, "photos", command.photoId, command.id);
    if (command.type === "award.finalised")
      await this.enqueueNotifications(teamId, seasonId, "awards", command.matchId, command.id);
    return { ...getCommunityView(state, actor, this.now()), revision: state.revision };
  }
  async synchronizeSpectatorMemberships(state) {
    const scopes = /* @__PURE__ */ new Map();
    for (const grant of state.grants)
      scopes.set(JSON.stringify([grant.accountId, grant.teamId, grant.seasonId]), { accountId: grant.accountId, teamId: grant.teamId, seasonId: grant.seasonId });
    for (const scope of scopes.values()) {
      const grants = state.grants.filter((grant) => grant.accountId === scope.accountId && grant.teamId === scope.teamId && grant.seasonId === scope.seasonId);
      const active2 = grants.filter((grant) => grant.revokedAtMs === null && grant.startsAtMs <= this.now() && grant.expiresAtMs > this.now());
      const expiresAt = Math.max(...(active2.length ? active2 : grants).map((grant) => grant.expiresAtMs));
      const revokedAt = active2.length ? null : Math.max(1, this.now());
      await this.execute("INSERT INTO memberships(account_id,team_id,season_id,role,expires_at,revoked_at) VALUES($1,$2,$3,'spectator',$4,$5) ON CONFLICT(account_id,team_id,season_id,role) DO UPDATE SET expires_at=excluded.expires_at,revoked_at=excluded.revoked_at", [scope.accountId, scope.teamId, scope.seasonId, expiresAt, revokedAt]);
    }
  }
  async media(principal, teamId, seasonId, photoId, mode, role) {
    const actor = await this.communityActor(principal, teamId, seasonId, role);
    const result = authorizeCommunityMedia(await this.communityState(teamId, seasonId), actor, photoId, this.now(), mode);
    if (!result.allowed)
      throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    return result;
  }
  async recordsViewer(principal, teamId, seasonId, role) {
    const actor = await this.communityActor(principal, teamId, seasonId, role);
    return { actor: actor.role, playerId: actor.playerId, teamId, seasonId };
  }
  async recordsContext(principal, teamId, seasonId, role) {
    const viewer = await this.recordsViewer(principal, teamId, seasonId, role);
    const rows = await this.many("SELECT state_json FROM matches WHERE team_id=$1 AND season_id=$2 ORDER BY id", [teamId, seasonId]);
    const community = await this.communityState(teamId, seasonId);
    const actor = await this.communityActor(principal, teamId, seasonId, viewer.actor);
    const filtered = getCommunityView(community, actor, this.now());
    return { principal, memberships: await this.memberships(), nowMs: this.now(), requestedRole: viewer.actor, state: await this.document(teamId, seasonId, "records"), acceptedMatches: rows.map((row) => ({ teamId, seasonId, match: JSON.parse(row.state_json) })), community: { accountId: principal.accountId, teamId, seasonId, audience: viewer.actor, playerId: viewer.playerId ?? null, revision: community.revision, view: { allowed: filtered.allowed, matches: filtered.matches, gallery: filtered.gallery } } };
  }
  async records(principal, teamId, seasonId, role) {
    return recordsServiceView(await this.recordsContext(principal, teamId, seasonId, role));
  }
  async recordsExport(principal, teamId, seasonId, request, role) {
    return recordsServiceExport({ ...await this.recordsContext(principal, teamId, seasonId, role), request });
  }
  async recordsCommand(principal, teamId, seasonId, command, role) {
    const state = applyRecordsServiceCommand({ ...await this.recordsContext(principal, teamId, seasonId, role), command });
    await this.saveDocument(teamId, seasonId, "records", state);
    await this.audit(principal, command.type, teamId, "accepted");
    return await this.records(principal, teamId, seasonId, "manager");
  }
};

// apps/worker/src/postgres-jobs.ts
import { randomBytes as randomBytes3 } from "node:crypto";
import { performance } from "node:perf_hooks";
async function runDuePostgresJobs(store2, nowMs = Date.now(), maximum = 20) {
  const result = { completed: 0, retried: 0, failed: 0 };
  const began = performance.now();
  const databaseNow = async () => {
    const row = await store2.one("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms");
    if (typeof row?.now_ms !== "number" || !Number.isSafeInteger(row.now_ms) || row.now_ms < 0) throw new Error("DATABASE_CLOCK_UNAVAILABLE");
    return row.now_ms;
  };
  for (let count = 0; count < maximum; count++) {
    const capability = randomBytes3(32).toString("hex");
    const observation = Math.floor(nowMs + performance.now() - began);
    const job = await store2.db.withContext({ kind: "worker_claim", jobKind: "award.finalise", nowMs: observation }, () => store2.one("SELECT * FROM longball.claim_due_job($1,$2,$3)", ["award.finalise", observation, capability]));
    if (!job) break;
    const claimedAt = performance.now(), claimedDatabaseAt = job.lease_until - 3e4;
    const context = () => ({ kind: "worker_job", jobId: job.id, leaseToken: capability, clubId: job.club_id, teamId: job.team_id, seasonId: job.season_id, nowMs: Math.floor(claimedDatabaseAt + performance.now() - claimedAt) });
    const attempt = await store2.db.withContext(context(), () => store2.transaction(() => store2.one("UPDATE jobs SET attempts=attempts+1 WHERE id=$1 AND state='leased' AND attempts=$2 RETURNING attempts", [job.id, job.attempts])));
    if (!attempt) continue;
    job.attempts = Number(attempt.attempts);
    try {
      await store2.db.withContext(context(), () => store2.transaction(async () => {
        const lease = await store2.one("SELECT state,attempts FROM jobs WHERE id=$1 FOR UPDATE", [job.id]);
        if (!lease || lease.state !== "leased" || lease.attempts !== job.attempts) throw new Error("LEASE_SUPERSEDED");
        if (job.kind !== "award.finalise") throw new Error("UNSUPPORTED_JOB");
        const payload = JSON.parse(job.payload_json);
        if (payload.teamId !== job.team_id || payload.seasonId !== job.season_id) throw new Error("JOB_SCOPE_CONFLICT");
        const state = await store2.document(payload.teamId, payload.seasonId, "community");
        const match = state.matches.find((item) => item.id === payload.matchId);
        if (!match || match.voteCutoffAtMs === null || match.finishQuality !== "trusted") throw new Error("AWARD_REVIEW_REQUIRED");
        const scoped = finalizeDueCommunityAwards({ ...state, matches: [match] }, await databaseNow());
        const next = { ...scoped, matches: state.matches };
        if (!next.awards.some((award) => award.matchId === payload.matchId)) throw new Error("AWARD_NOT_DUE_OR_UNRESOLVED");
        await store2.saveDocument(payload.teamId, payload.seasonId, "community", next);
        for (const award of next.awards.filter((award2) => !state.awards.some((previous) => previous.matchId === award2.matchId))) await store2.enqueueNotifications(payload.teamId, payload.seasonId, "awards", award.matchId, `award-finalised-${award.matchId}-${award.voteCutoffAtMs}`);
        const completed = await store2.execute("UPDATE jobs SET state='completed',lease_until=NULL,last_error_code=NULL WHERE id=$1 AND state='leased' AND attempts=$2", [job.id, job.attempts]);
        if (completed.changes !== 1) throw new Error("LEASE_SUPERSEDED");
      }));
      result.completed++;
    } catch {
      const terminal = job.attempts >= 3;
      const settled = await store2.db.withContext(context(), () => store2.transaction(async () => store2.execute("UPDATE jobs SET state=$1,due_at=$2,lease_until=NULL,last_error_code='JOB_REQUIRES_REVIEW' WHERE id=$3 AND state='leased' AND attempts=$4", [terminal ? "failed" : "pending", await databaseNow() + Math.min(6e4, 1e3 * 2 ** job.attempts), job.id, job.attempts])));
      if (settled.changes) {
        if (terminal) result.failed++;
        else result.retried++;
      }
    }
  }
  return result;
}

// apps/api/src/database-config.ts
import { readFileSync } from "node:fs";
function readDatabaseUrl(env, key = "LONGBALL_DATABASE_URL") {
  const inline = env[key];
  const file = env[`${key}_FILE`];
  if (inline && file) throw new Error(`Configure exactly one of ${key} and ${key}_FILE.`);
  const value = file ? readFileSync(file, "utf8").trim() : inline;
  if (!value) return void 0;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("A valid PostgreSQL connection URL is required.");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("A PostgreSQL connection URL is required.");
  return value;
}

// apps/worker/src/notification-jobs.ts
import { randomBytes as randomBytes4, randomUUID as randomUUID4 } from "node:crypto";
import { performance as performance2 } from "node:perf_hooks";
var KIND = "notification.dispatch";
var decode = (row) => {
  const job = JSON.parse(row.payload_json);
  validateTeamNotificationJob(job);
  if (row.id !== job.id || row.business_key !== job.businessKey || row.kind !== KIND) throw new Error("NOTIFICATION_SCOPE_CONFLICT");
  return job;
};
var outerState = (job) => job.state === "provider_accepted" ? "completed" : job.state;
async function readRow(store2, id) {
  return store2 instanceof PostgresStore ? await store2.one("SELECT id,kind,business_key,payload_json,state,attempts,lease_until FROM jobs WHERE id=$1", [id]) : store2.database.prepare("SELECT id,kind,business_key,payload_json,state,attempts,lease_until FROM jobs WHERE id=?").get(id);
}
function owns(row, job, nowMs) {
  if (!row || row.state !== "leased" || row.attempts !== job.attempts || row.lease_until === null || row.lease_until <= nowMs) return false;
  const saved = decode(row);
  return saved.revision === job.revision && saved.lease?.attemptId === job.lease?.attemptId;
}
function expiredNeedsReview(job, provider) {
  return job.state === "leased" && (!provider?.configured || provider.idempotency !== "provider" || job.attempts >= 6);
}
function reviewExpired(job) {
  return { ...job, revision: job.revision + 1, state: "review_required", lease: null, lastCode: "LEASE_EXPIRED_OUTCOME_UNKNOWN" };
}
async function inJobContext(store2, context, nowMs, work) {
  if (!(store2 instanceof PostgresStore)) return work();
  if (!context) throw new Error("NOTIFICATION_JOB_CAPABILITY_REQUIRED");
  return store2.db.withContext({ ...context, nowMs: Math.max(context.nowMs, nowMs) }, work);
}
async function claimNext(store2, nowMs, provider) {
  if (store2 instanceof PostgresStore) {
    const capability = randomBytes4(32).toString("hex");
    const row = await store2.db.withContext({ kind: "worker_claim", jobKind: KIND, nowMs }, () => store2.one("SELECT * FROM longball.claim_due_job($1,$2,$3)", [KIND, nowMs, capability]));
    if (!row) return { job: null, reviewed: false };
    const prior = decode(row);
    if (![row.club_id, row.team_id, row.season_id].every((value) => typeof value === "string" && value.length > 0) || row.team_id !== prior.teamId || row.season_id !== prior.seasonId || !Number.isSafeInteger(row.lease_until) || row.lease_until <= nowMs) throw new Error("NOTIFICATION_SCOPE_CONFLICT");
    const claimedAt = row.lease_until - 3e4;
    const context = { kind: "worker_job", jobId: row.id, leaseToken: capability, clubId: row.club_id, teamId: row.team_id, seasonId: row.season_id, nowMs: claimedAt };
    return inJobContext(store2, context, claimedAt, () => store2.transaction(async () => {
      const reviewed = expiredNeedsReview(prior, provider);
      const next = reviewed ? reviewExpired(prior) : claimTeamNotificationJob(prior, randomUUID4(), claimedAt);
      if (!next) throw new Error("NOTIFICATION_QUEUE_STATE_CONFLICT");
      if (next.lease) next.lease.untilMs = row.lease_until;
      const changed = await store2.execute("UPDATE jobs SET payload_json=$1,state=$2,attempts=$3,lease_until=$4,last_error_code=$5 WHERE id=$6 AND state='leased' AND attempts=$7 AND lease_until=$8", [JSON.stringify(next), outerState(next), next.attempts, next.lease?.untilMs ?? null, next.lastCode, next.id, prior.attempts, row.lease_until]);
      if (!changed.changes) return { job: null, reviewed: false };
      return { job: reviewed ? null : next, reviewed, context };
    }));
  }
  return store2.transaction(() => {
    const row = store2.database.prepare("SELECT id,kind,business_key,payload_json,state,attempts,lease_until FROM jobs WHERE kind=? AND ((state='pending' AND due_at<=?) OR (state='leased' AND lease_until<=?)) ORDER BY due_at,id LIMIT 1").get(KIND, nowMs, nowMs);
    if (!row) return { job: null, reviewed: false };
    const prior = decode(row), reviewed = expiredNeedsReview(prior, provider);
    const next = reviewed ? reviewExpired(prior) : claimTeamNotificationJob(prior, randomUUID4(), nowMs);
    if (!next) throw new Error("NOTIFICATION_QUEUE_STATE_CONFLICT");
    store2.database.prepare("UPDATE jobs SET payload_json=?,state=?,attempts=?,lease_until=?,last_error_code=? WHERE id=?").run(JSON.stringify(next), outerState(next), next.attempts, next.lease?.untilMs ?? null, next.lastCode, next.id);
    return { job: reviewed ? null : next, reviewed };
  });
}
async function commit(store2, leased, next, nowMs) {
  validateTeamNotificationJob(next);
  if (store2 instanceof PostgresStore) return store2.transaction(async () => {
    const row = await store2.one("SELECT id,kind,business_key,payload_json,state,attempts,lease_until FROM jobs WHERE id=$1 FOR UPDATE", [leased.id]);
    if (!owns(row, leased, nowMs)) return false;
    const updated = await store2.execute("UPDATE jobs SET payload_json=$1,state=$2,due_at=$3,attempts=$4,lease_until=NULL,last_error_code=$5 WHERE id=$6", [JSON.stringify(next), outerState(next), next.dueAtMs, next.attempts, next.lastCode, next.id]);
    return updated.changes === 1;
  });
  return store2.transaction(() => {
    const row = store2.database.prepare("SELECT id,kind,business_key,payload_json,state,attempts,lease_until FROM jobs WHERE id=?").get(leased.id);
    if (!owns(row, leased, nowMs)) return false;
    store2.database.prepare("UPDATE jobs SET payload_json=?,state=?,due_at=?,attempts=?,lease_until=NULL,last_error_code=? WHERE id=?").run(JSON.stringify(next), outerState(next), next.dueAtMs, next.attempts, next.lastCode, next.id);
    return true;
  });
}
async function entityAccess(store2, job, principal, community, nowMs) {
  const actor = { accountId: job.accountId, teamId: job.teamId, seasonId: job.seasonId, role: job.audience, ...job.playerId ? { playerId: job.playerId } : {} };
  if (job.category === "schedule") {
    if (job.audience === "spectator") return "denied";
    const preparation = await store2.document(job.teamId, job.seasonId, "preparation");
    return preparation.team.id === job.teamId && (preparation.fixtures.some((item) => item.seasonId === job.seasonId && item.id === job.entityId) || preparation.training.some((item) => item.seasonId === job.seasonId && item.id === job.entityId)) ? "allowed" : "missing";
  }
  if (job.category === "match") {
    try {
      const row = await store2.match(job.entityId);
      if (row.team_id !== job.teamId || row.season_id !== job.seasonId) return "denied";
      const projected2 = await store2.matchDto(principal, job.entityId, job.audience);
      return projected2.sharingRestricted === true ? "withheld" : "allowed";
    } catch (error) {
      if (error && typeof error === "object" && "status" in error && [403, 404].includes(Number(error.status))) return "denied";
      throw error;
    }
  }
  if (job.category === "photos") {
    const photo = community.photos.find((item) => item.id === job.entityId && item.teamId === job.teamId && item.seasonId === job.seasonId);
    if (!photo) return "missing";
    const mode = photo.uploaderAccountId === job.accountId ? "own" : job.audience === "manager" ? "review" : "gallery";
    return authorizeCommunityMedia(community, actor, photo.id, nowMs, mode).allowed ? "allowed" : "denied";
  }
  const projected = getCommunityView(community, actor, nowMs);
  const match = projected.matches.find((item) => item.id === job.entityId);
  return !match ? "missing" : !match.sharingAllowed ? "withheld" : match.award ? "allowed" : "missing";
}
async function evidence(store2, job, nowMs) {
  const row = store2 instanceof PostgresStore ? await store2.one("SELECT * FROM accounts WHERE id=$1", [job.accountId]) : store2.database.prepare("SELECT * FROM accounts WHERE id=?").get(job.accountId);
  const account2 = { accountId: job.accountId, status: row?.status === "active" ? "active" : "disabled", identityClassification: row?.classification ?? "unclassified", adultVerified: Boolean(row?.adult_verified), strongAuthEnrolled: Boolean(row?.strong_auth_enrolled) };
  const memberships = await store2.memberships();
  const empty2 = { account: account2, memberships, grants: [], preferences: defaultCommunityPreferences(), entityAccess: "missing" };
  if (!row || account2.status !== "active") return empty2;
  let community;
  try {
    community = await store2.communityState(job.teamId, job.seasonId);
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && Number(error.status) === 404) return empty2;
    throw error;
  }
  const principal = { accountId: job.accountId, issuer: String(row.issuer), subject: String(row.subject), status: account2.status, identityClassification: account2.identityClassification, adultVerified: account2.adultVerified, strongAuth: account2.strongAuthEnrolled, authenticatedAt: nowMs };
  let access = "denied";
  if (memberships.some((item) => item.accountId === job.accountId && item.teamId === job.teamId && item.seasonId === job.seasonId && item.role === job.audience && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > nowMs))) access = await entityAccess(store2, job, principal, community, nowMs);
  return { account: account2, memberships, grants: community.grants, preferences: community.preferences[job.accountId] ?? defaultCommunityPreferences(), entityAccess: access };
}
async function runDueTeamNotifications(store2, options = {}) {
  const now = options.now ?? Date.now, provider = options.provider ?? null;
  const maximum = options.maximum ?? 20;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 1e3) throw new Error("INVALID_NOTIFICATION_BATCH_LIMIT");
  const result = { accepted: 0, blocked: 0, retried: 0, suppressed: 0, reviewRequired: 0, failed: 0 };
  for (let index = 0; index < maximum; index++) {
    const claimed = await claimNext(store2, now(), provider);
    if (claimed.reviewed) {
      result.reviewRequired++;
      continue;
    }
    if (!claimed.job) break;
    let observedMonotonic = performance2.now();
    let observedDatabaseMs = claimed.context?.nowMs ?? 0;
    const dispatchNow = store2 instanceof PostgresStore ? () => observedDatabaseMs + Math.max(0, Math.floor(performance2.now() - observedMonotonic)) : now;
    const observeDatabaseNow = async () => {
      if (!(store2 instanceof PostgresStore)) return now();
      const observation = await store2.one("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms");
      if (!Number.isSafeInteger(observation?.now_ms)) throw new Error("NOTIFICATION_DATABASE_CLOCK_UNAVAILABLE");
      observedDatabaseMs = Number(observation.now_ms);
      observedMonotonic = performance2.now();
      return observedDatabaseMs;
    };
    await inJobContext(store2, claimed.context, dispatchNow(), observeDatabaseNow);
    const scopedProvider = provider ? { ...provider, send: async (input) => {
      if (!provider.prepareSend) return provider.send(input);
      const prepared = await inJobContext(store2, claimed.context, dispatchNow(), () => provider.prepareSend(input));
      return prepared();
    } } : null;
    const settled = await dispatchClaimedTeamNotification(claimed.job, {
      now: dispatchNow,
      provider: scopedProvider,
      readCurrentEvidence: (job, at) => inJobContext(store2, claimed.context, at, async () => {
        const current3 = await evidence(store2, job, await observeDatabaseNow());
        await observeDatabaseNow();
        return current3;
      }),
      stillOwnsLease: (job, at) => inJobContext(store2, claimed.context, at, async () => owns(await readRow(store2, job.id), job, await observeDatabaseNow())),
      commit: (leased, next) => inJobContext(store2, claimed.context, dispatchNow(), async () => commit(store2, leased, next, await observeDatabaseNow()))
    });
    if (settled.status === "provider_accepted") result.accepted++;
    else if (settled.status === "blocked_provider") result.blocked++;
    else if (settled.status === "pending") result.retried++;
    else if (settled.status === "suppressed") result.suppressed++;
    else if (settled.status === "review_required") result.reviewRequired++;
    else if (settled.status === "failed") result.failed++;
  }
  return result;
}

// apps/worker/src/main.ts
var connectionString = readDatabaseUrl(process.env);
if (!connectionString && process.env.LONGBALL_SYNTHETIC_AUTH !== "1") throw new Error("Configure PostgreSQL or explicit fictional SQLite mode for the worker.");
var migrationMode = process.env.LONGBALL_DATABASE_MIGRATION_MODE ?? (process.env.LONGBALL_SYNTHETIC_AUTH === "1" ? "apply" : "verify");
if (!["apply", "verify"].includes(migrationMode) || process.env.NODE_ENV === "production" && migrationMode !== "verify") throw new Error("The production worker verifies schemas; use the dedicated operator migration command.");
var store = connectionString ? await PostgresStore.open(connectionString, Date.now, { migrationMode }) : new DevelopmentStore(process.env.LONGBALL_API_DATABASE ?? ".local/api/longball.sqlite");
if (store instanceof PostgresStore) {
  try {
    await store.assertRuntimeRole("worker");
  } catch (error) {
    await store.close();
    throw error;
  }
}
var running = false;
var run = async () => {
  if (running) return;
  running = true;
  try {
    const result = store instanceof PostgresStore ? await runDuePostgresJobs(store) : runDueJobs(store);
    const notifications = await runDueTeamNotifications(store);
    if (result.completed || result.retried || result.failed || Object.values(notifications).some(Boolean)) console.log(JSON.stringify({ worker: connectionString ? "longball-postgresql" : "longball-fictional", ...result, notifications }));
  } finally {
    running = false;
  }
};
await run();
if (process.argv.includes("--once")) await store.close();
else {
  const timer = setInterval(() => {
    void run().catch(() => console.error("LONGBALL_WORKER_CYCLE_FAILED"));
  }, 5e3);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
    clearInterval(timer);
    void Promise.resolve(store.close()).then(() => process.exit(0));
  });
}
