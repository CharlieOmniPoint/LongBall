import type {
  Allocation, ClockReading, ClockSample, MatchConfig, MatchEvent, MatchState,
  PlayerMinutes, Rational, TargetInterval, TargetResult, GoalRecord, AvailabilityRecord,
  EffectiveMatchTime, MatchAuditEntry,
} from './types';
import { cloneValue, effectiveTime, goalRecord, scoresFromGoals } from './live-events';
import { reprojectParticipation } from './participation-corrections';
import { applyPolicyChange, assertInitialLineupProposal, assertMatchPolicyProposal, currentFixedKeeper, updatePolicyPositionMode } from './policy';
export type * from './types';
export { currentFixedKeeper, assertMatchPolicyProposal } from './policy';

export const ENGINE_VERSION = 'synthetic-live-4';

function integer(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer.`);
}
function assertSample(sample: ClockSample): void {
  if (!Number.isFinite(sample.monotonicMs) || sample.monotonicMs < 0 || !Number.isSafeInteger(Math.floor(sample.monotonicMs)) || !sample.sessionId) throw new Error('Clock sample is invalid.');
  integer(sample.wallTimeMs, 'Wall time');
}
function isRunning(state: MatchState): boolean {
  return state.status === 'first_half_running' || state.status === 'second_half_running';
}
function isPaused(state: MatchState): boolean {
  return state.status === 'first_half_paused' || state.status === 'second_half_paused';
}
function available(state: MatchState, id: string): boolean {
  return state.availability[id] === true && state.attendance[id] === 'present';
}
function selectedPlayer(state: MatchState, id: string): void {
  if (!state.config.selectedPlayerIds.includes(id)) throw new Error('Player is outside this selected match squad.');
}
function cloneLineup(lineup: Allocation[]): Allocation[] { return lineup.map(item => ({ ...item })); }
function keeperChoice(config: MatchConfig, playerId: string): number {
  const snapshot = config.profileSnapshot?.find(profile => profile.playerId === playerId);
  if (snapshot?.preferences.length) return snapshot.preferences.indexOf('GK') + 1;
  return config.players.find(player => player.id === playerId)?.goalkeeperChoice ?? 0;
}

export function createMatch(config: MatchConfig): MatchState {
  if (!config.matchId || config.pitchPlaces < 5 || config.pitchPlaces > 11 || !Number.isInteger(config.pitchPlaces)) throw new Error('Match format must have 5–11 pitch places.');
  integer(config.plannedHalfDurationMs, 'Planned half duration');
  if (config.plannedHalfDurationMs < 30_000) throw new Error('Planned half duration must be at least 30 seconds.');
  const ids = config.players.map(player => player.id);
  if (new Set(ids).size !== ids.length || new Set(config.selectedPlayerIds).size !== config.selectedPlayerIds.length) throw new Error('Player identifiers must be unique.');
  if (config.selectedPlayerIds.some(id => !ids.includes(id))) throw new Error('Selected players must belong to this roster.');
  if (config.initialAttendance && Object.entries(config.initialAttendance).some(([id, status]) => !config.selectedPlayerIds.includes(id) || !['present', 'absent', 'excused', 'not_selected', 'not_recorded'].includes(status))) throw new Error('Initial attendance must be explicit valid check-in for the selected squad.');
  if (config.slots && (config.slots.length !== config.pitchPlaces || new Set(config.slots.map(slot => slot.slotId)).size !== config.slots.length || config.slots.filter(slot => slot.position === 'GK').length !== 1 || config.slots.some(slot => !slot.slotId || !slot.position))) throw new Error('Saved formation needs one distinct slot per pitch place and exactly one goalkeeper.');
  if (config.profileSnapshot && (new Set(config.profileSnapshot.map(profile => profile.playerId)).size !== config.profileSnapshot.length || config.profileSnapshot.some(profile => !ids.includes(profile.playerId) || profile.preferences.length > 3 || new Set(profile.preferences).size !== profile.preferences.length || new Set(profile.eligiblePositions).size !== profile.eligiblePositions.length))) throw new Error('Match profile snapshots must belong to distinct roster players with distinct preferences and eligibility.');
  if (config.fixedKeeperId !== null && (!config.selectedPlayerIds.includes(config.fixedKeeperId) || ![1, 2].includes(keeperChoice(config, config.fixedKeeperId)))) throw new Error('Fixed keeper must be a selected first- or second-choice goalkeeper.');
  if (config.initialPolicyProposal !== undefined) assertMatchPolicyProposal(config.initialPolicyProposal, config);
  if (config.initialLineupProposal !== undefined) assertInitialLineupProposal(config, config.initialLineupProposal);
  return {
    config: cloneValue(config),
    status: 'preparation', revision: 0,
    attendance: Object.fromEntries(ids.map(id => [id, config.initialAttendance?.[id] ?? 'not_recorded'])),
    availability: Object.fromEntries(ids.map(id => [id, config.selectedPlayerIds.includes(id)])),
    stagedLineup: [], lineup: [], half: 0, halfActiveMs: 0, matchActiveMs: 0,
    firstHalfDurationMs: null, anchor: null, recoveryRequired: false,
    intervals: [], targetIntervals: [], score: { for: 0, against: 0 }, halfTimeScore: null,
    completedAtMs: null, completedTimeQuality: null, abandonedAtMs: null, abandonReason: null, recoveryReason: null, appliedEvents: {},
    schemaVersion: 2, goals: [], availabilityHistory: [], eventHistory: [], audit: [],
  };
}

/** M0 retained original commands in appliedEvents. Upgrade by replay, never by inventing history. */
export function upgradeMatchState(previous: MatchState): MatchState {
  if (previous.schemaVersion === 2 && previous.goals && previous.availabilityHistory && previous.eventHistory && previous.audit) return previous;
  let events: MatchEvent[];
  try { events = Object.values(previous.appliedEvents).map(signature => JSON.parse(signature) as MatchEvent); }
  catch { throw new Error('Legacy command history cannot be read. Preserve the journal and reconcile it before continuing.'); }
  const replayed = replayMatch(previous.config, events);
  for (const field of ['status', 'revision', 'half', 'halfActiveMs', 'matchActiveMs', 'firstHalfDurationMs', 'completedAtMs', 'completedTimeQuality', 'recoveryRequired', 'recoveryReason', 'attendance', 'availability', 'anchor', 'score', 'halfTimeScore', 'lineup', 'stagedLineup', 'intervals', 'targetIntervals'] as const) {
    if (canonical(replayed[field]) !== canonical(previous[field])) throw new Error(`Legacy replay differs at ${field}. Preserve the original journal for explicit reconciliation.`);
  }
  return replayed;
}

/** Validation is strict for the initial journey; under-strength exceptions need Q07. */
export function validateLineup(state: MatchState, lineup: Allocation[], requireComplete = true): string[] {
  const errors: string[] = [];
  const fixedKeeperId = currentFixedKeeper(state);
  if (lineup.length > state.config.pitchPlaces || (requireComplete && lineup.length !== state.config.pitchPlaces)) errors.push(`Choose exactly ${state.config.pitchPlaces} pitch players.`);
  if (new Set(lineup.map(item => item.playerId)).size !== lineup.length) errors.push('A player can occupy only one pitch place.');
  if (new Set(lineup.map(item => item.slotId)).size !== lineup.length) errors.push('Each pitch slot must be unique.');
  for (const item of lineup) {
    if (!item.slotId || !item.position) errors.push('Every allocation needs a slot and position.');
    if (!state.config.selectedPlayerIds.includes(item.playerId)) errors.push('Only selected match-squad players can start.');
    else {
      if (state.attendance[item.playerId] !== 'present') errors.push(`${item.playerId}: confirm actual attendance first.`);
      if (!state.availability[item.playerId]) errors.push(`${item.playerId}: player is unavailable.`);
    }
    if (state.config.slots && !state.config.slots.some(slot => slot.slotId === item.slotId && slot.position === item.position)) errors.push('Allocation must use its saved formation slot and position.');
    const profile = state.config.profileSnapshot?.find(snapshot => snapshot.playerId === item.playerId);
    if (profile && !profile.eligiblePositions.includes(item.position)) errors.push(`${item.playerId}: position is outside the saved match eligibility.`);
  }
  const keepers = lineup.filter(item => item.position === 'GK');
  if (requireComplete && keepers.length !== 1) errors.push('Choose exactly one goalkeeper.');
  if (keepers.length > 1) errors.push('Only one goalkeeper place is allowed.');
  for (const keeper of keepers) {
    const player = state.config.players.find(item => item.id === keeper.playerId);
    if (!player || ![1, 2].includes(keeperChoice(state.config, keeper.playerId))) errors.push('Goalkeeper cover requires a first- or second-choice eligible keeper.');
    if (fixedKeeperId && keeper.playerId !== fixedKeeperId) errors.push('The fixed keeper policy cannot be changed by moving a pitch piece.');
  }
  const qualifying = state.config.players.filter(player => available(state, player.id) && [1, 2].includes(keeperChoice(state.config, player.id)));
  if (fixedKeeperId && qualifying.length > 1) errors.push('Multiple qualifying available keepers require a reviewed shared-keeper policy.');
  return [...new Set(errors)];
}

/** Rendering never increments a timer and never guesses elapsed time from UTC. */
export function readClock(state: MatchState, sample: ClockSample): ClockReading {
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
  integer(halfActiveMs, 'Half active time');
  integer(matchActiveMs, 'Match active time');
  return {
    halfActiveMs, matchActiveMs,
    remainingMs: Math.max(0, state.config.plannedHalfDurationMs - halfActiveMs),
    addedMs: Math.max(0, halfActiveMs - state.config.plannedHalfDurationMs),
    recoveryRequired,
  };
}

function accrue(state: MatchState, sample: ClockSample): MatchState {
  const clock = readClock(state, sample);
  if (clock.recoveryRequired) throw new Error('Time needs checking. Confirm the clock against a referee or trusted source.');
  const durationMs = clock.matchActiveMs - state.matchActiveMs;
  const fixedKeeperId = currentFixedKeeper(state);
  if (!isRunning(state) || durationMs === 0) return state;
  if (state.half !== 1 && state.half !== 2) throw new Error('No active half.');
  const intervals = state.config.selectedPlayerIds.map(playerId => {
    const allocation = state.lineup.find(item => item.playerId === playerId);
    const eligible = available(state, playerId);
    return {
      playerId, state: allocation ? 'playing' as const : eligible ? 'available_bench' as const : 'unavailable' as const,
      position: allocation?.position ?? null, slotId: allocation?.slotId ?? null,
      startMs: state.matchActiveMs, endMs: clock.matchActiveMs, half: state.half as 1 | 2,
    };
  });
  return {
    ...state, halfActiveMs: clock.halfActiveMs, matchActiveMs: clock.matchActiveMs,
    anchor: { sample: { ...sample }, halfActiveMs: clock.halfActiveMs, matchActiveMs: clock.matchActiveMs },
    intervals: [...state.intervals, ...intervals],
    targetIntervals: [...state.targetIntervals, {
      durationMs, availablePlayerIds: state.config.selectedPlayerIds.filter(id => available(state, id)),
      pitchPlaces: state.config.pitchPlaces,
      fixedKeeperId: fixedKeeperId && available(state, fixedKeeperId) ? fixedKeeperId : null,
      ...(state.activePolicy ? { policyVersion: state.activePolicy.policyVersion } : {}),
    }],
  };
}
function ensureLive(state: MatchState): void {
  if (!isRunning(state) && !isPaused(state)) throw new Error('This command requires an active half.');
}
function assertLineup(state: MatchState, lineup: Allocation[]): void {
  const errors = validateLineup(state, lineup);
  if (errors.length) throw new Error(errors.join(' '));
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Local experiment command reducer. Persist event and returned projection atomically. */
export function reduceMatch(previous: MatchState, event: MatchEvent): MatchState {
  previous = upgradeMatchState(previous);
  if (!event.id) throw new Error('Event id is required.');
  const signature = canonical(event);
  if (previous.appliedEvents[event.id]) {
    if (previous.appliedEvents[event.id] !== signature) throw new Error('Event id was reused with different content.');
    return previous;
  }
  assertSample(event.sample);
  if ((previous.status === 'completed' || previous.status === 'abandoned') && event.type !== 'event.corrected' && event.type !== 'event.voided' && event.type !== 'goal.recorded' && !((event.type === 'lineup.committed' || event.type === 'availability.changed') && event.effective && event.sourceRevision !== undefined && event.lateEntryReason?.trim())) throw new Error('Completed or abandoned play is read-only. Use an audited correction without reopening the clock.');
  let state = previous;
  let auditEffective: EffectiveMatchTime | null | undefined;
  let auditPrior: unknown = null;
  let auditValue: unknown = event;
  const reviewedParticipationEntry = (event.type === 'lineup.committed' || event.type === 'availability.changed') && event.effective !== undefined && event.sourceRevision !== undefined && Boolean(event.lateEntryReason?.trim());
  if (event.type === 'policy.changed') {
    const latest = accrue(previous, event.sample);
    const boundary = event.effective;
    if (!boundary || boundary.half !== previous.half || !Number.isSafeInteger(boundary.matchElapsedMs) || boundary.matchElapsedMs < previous.matchActiveMs || boundary.matchElapsedMs > latest.matchActiveMs) throw new Error('A policy change must use its captured current continuous boundary, never earlier history or future play.');
    if (isRunning(previous)) {
      if (!previous.anchor) throw new Error('A continuous anchor is required for prospective policy changes.');
      const boundarySample = { ...event.sample, monotonicMs: Math.floor(previous.anchor.sample.monotonicMs) + boundary.matchElapsedMs - previous.anchor.matchActiveMs };
      state = accrue(previous, boundarySample);
    } else state = latest;
  } else if (event.type === 'availability.changed' && event.effective && !reviewedParticipationEntry) {
    if (previous.half === 0) throw new Error('Preparation availability has no active-time boundary.');
    const latest = accrue(previous, event.sample);
    const boundary = effectiveTime(latest, event.effective);
    if (boundary.half !== previous.half || boundary.matchElapsedMs < previous.matchActiveMs) throw new Error('Historical availability crosses a recorded boundary. Preserve actual intervals and use explicit history reconciliation; no minutes were changed.');
    if (!isRunning(previous) && boundary.matchElapsedMs !== previous.matchActiveMs) throw new Error('Paused or half-time availability must use the current active-time boundary.');
    if (isRunning(previous)) {
      if (!previous.anchor) throw new Error('A continuous anchor is required for an effective availability boundary.');
      const boundarySample = { ...event.sample, monotonicMs: Math.floor(previous.anchor.sample.monotonicMs) + boundary.matchElapsedMs - previous.anchor.matchActiveMs };
      state = accrue(previous, boundarySample);
    } else state = latest;
    auditEffective = boundary;
  } else if (event.type !== 'clock.recovery_required' && event.type !== 'clock.corrected') state = accrue(previous, event.sample);
  switch (event.type) {
    case 'policy.changed': {
      auditPrior = state.activePolicy ?? null;
      state = applyPolicyChange(state, event, previous.revision);
      auditEffective = event.effective.half === 0 ? null : { ...event.effective, half: event.effective.half };
      auditValue = state.policyHistory?.at(-1);
      // Only the uncommitted suffix after the captured change uses the new policy.
      state = accrue(state, event.sample);
      break;
    }
    case 'attendance.recorded': {
      selectedPlayer(state, event.playerId);
      if (!['present', 'absent', 'excused', 'not_selected', 'not_recorded'].includes(event.status)) throw new Error('Attendance status is invalid.');
      state = { ...state, attendance: { ...state.attendance, [event.playerId]: event.status } };
      if (event.status !== 'present') state = { ...state, lineup: state.lineup.filter(item => item.playerId !== event.playerId), stagedLineup: state.stagedLineup.filter(item => item.playerId !== event.playerId) };
      break;
    }
    case 'availability.changed': {
      if (reviewedParticipationEntry) {
        const corrected = reprojectParticipation(state, event, validateLineup);
        state = corrected.state; auditEffective = corrected.effective; auditPrior = corrected.priorValue;
        auditValue = { inserted: corrected.value, earliestAffected: corrected.earliestAffected };
        break;
      }
      selectedPlayer(state, event.playerId);
      if (typeof event.available !== 'boolean') throw new Error('Availability must be explicitly true or false.');
      const reason = event.reason ?? 'other';
      if (!['arrival', 'departure', 'injury', 'return', 'other'].includes(reason)) throw new Error('Availability reason must be an approved category.');
      if ((reason === 'arrival' || reason === 'return') && !event.available) throw new Error('Arrival or return requires confirmed availability.');
      if ((reason === 'departure' || reason === 'injury') && event.available) throw new Error('Injury or departure requires unavailable status.');
      const record: AvailabilityRecord = {
        eventId: event.id, latestEventId: event.id, playerId: event.playerId,
        available: event.available, previousAvailability: state.availability[event.playerId], reason,
        effective: auditEffective ?? (state.half === 0 ? null : effectiveTime(state)), recordedAtMs: event.sample.wallTimeMs,
      };
      auditPrior = { available: record.previousAvailability, lineup: cloneLineup(state.lineup) };
      state = { ...state, availability: { ...state.availability, [event.playerId]: event.available } };
      if (!event.available) state = { ...state, lineup: state.lineup.filter(item => item.playerId !== event.playerId), stagedLineup: state.stagedLineup.filter(item => item.playerId !== event.playerId) };
      if (event.replacementLineup) {
        ensureLive(state);
        assertLineup(state, event.replacementLineup);
        state = { ...state, lineup: cloneLineup(event.replacementLineup) };
      }
      state = { ...state, availabilityHistory: [...state.availabilityHistory ?? [], record] };
      auditEffective = record.effective;
      auditValue = record;
      // A captured boundary may precede entry within this still-uncommitted segment.
      // Close that segment using the newly confirmed availability/lineup; never use wall time.
      state = accrue(state, event.sample);
      break;
    }
    case 'lineup.staged': {
      if (state.status !== 'preparation' && state.status !== 'half_time') throw new Error('Only preparation and half-time have a staged lineup.');
      const errors = validateLineup(state, event.lineup, false);
      if (errors.length) throw new Error(errors.join(' '));
      state = { ...state, stagedLineup: cloneLineup(event.lineup) };
      break;
    }
    case 'half.started': {
      if (state.status !== 'preparation' && state.status !== 'half_time') throw new Error('A half can start only from preparation or half-time.');
      assertLineup(state, state.stagedLineup);
      const half = state.status === 'preparation' ? 1 : 2;
      state = {
        ...state, half, status: half === 1 ? 'first_half_running' : 'second_half_running',
        lineup: cloneLineup(state.stagedLineup), halfActiveMs: 0,
        anchor: { sample: { ...event.sample }, halfActiveMs: 0, matchActiveMs: state.matchActiveMs },
      };
      break;
    }
    case 'half.paused': {
      if (!isRunning(state)) throw new Error('Only a running half can pause.');
      state = { ...state, status: state.half === 1 ? 'first_half_paused' : 'second_half_paused', anchor: null };
      break;
    }
    case 'half.resumed': {
      if (!isPaused(state)) throw new Error('Only a paused half can resume.');
      assertLineup(state, state.lineup);
      state = { ...state, status: state.half === 1 ? 'first_half_running' : 'second_half_running', anchor: { sample: { ...event.sample }, halfActiveMs: state.halfActiveMs, matchActiveMs: state.matchActiveMs } };
      break;
    }
    case 'half.ended': {
      ensureLive(state);
      if (state.half === 1) state = { ...state, status: 'half_time', anchor: null, firstHalfDurationMs: state.halfActiveMs, halfTimeScore: { ...state.score }, stagedLineup: cloneLineup(state.lineup) };
      else state = { ...state, status: 'completed', anchor: null, completedAtMs: event.sample.wallTimeMs, completedTimeQuality: 'reviewRequired' };
      break;
    }
    case 'match.abandoned': {
      if (state.half === 0) throw new Error('Only a started match can be abandoned; cancel an unplayed fixture separately.');
      if (!['weather', 'safety', 'insufficient_players', 'other'].includes(event.reason) || (event.note?.length ?? 0) > 200) throw new Error('Abandonment requires an approved reason category and a note of at most 200 characters.');
      state = { ...state, status: 'abandoned', anchor: null, abandonedAtMs: event.sample.wallTimeMs, abandonReason: event.reason };
      break;
    }
    case 'lineup.committed': {
      if (event.effective) {
        const corrected = reprojectParticipation(state, event, validateLineup);
        state = corrected.state; auditEffective = corrected.effective; auditPrior = corrected.priorValue;
        auditValue = { inserted: corrected.value, earliestAffected: corrected.earliestAffected };
        break;
      }
      ensureLive(state);
      if (event.sourceRevision !== previous.revision) throw new Error('Lineup draft is stale. Review against the current match revision.');
      assertLineup(state, event.lineup);
      state = { ...state, lineup: cloneLineup(event.lineup) };
      break;
    }
    case 'goal.recorded': {
      const recorded = goalRecord(state, event, event.id, event.sample.wallTimeMs);
      if ((!isRunning(state) && !isPaused(state)) || recorded.effective.half !== state.half) {
        if (!event.effective || !event.lateEntryReason?.trim()) throw new Error('A goal entered outside its active half needs its actual effective time and a late-entry reason.');
      }
      const goals = [...state.goals ?? [], recorded];
      state = { ...state, goals, ...scoresFromGoals(state, goals) };
      auditEffective = recorded.effective;
      auditValue = recorded;
      break;
    }
    case 'event.corrected': {
      if (!event.reason.trim() || event.reason.length > 500) throw new Error('An audited correction needs a reason of 1–500 characters.');
      const goal = state.goals?.find(item => item.eventId === event.targetEventId || item.latestEventId === event.targetEventId);
      if (goal) {
        if (event.replacement.type !== 'goal.recorded') throw new Error('A correction cannot change the original event family.');
        if (goal.voided && event.restoreVoided !== true) throw new Error('Restoring a voided goal requires explicit restoreVoided confirmation.');
        const corrected = goalRecord(state, { ...goal, ...event.replacement, effective: event.replacement.effective ?? goal.effective }, goal.eventId, goal.recordedAtMs);
        const replacement = { ...corrected, latestEventId: event.id };
        const goals = state.goals!.map(item => item.eventId === goal.eventId ? replacement : item);
        state = { ...state, goals, ...scoresFromGoals(state, goals) };
        auditEffective = replacement.effective;
        auditPrior = goal;
        auditValue = replacement;
        break;
      }
      const availability = state.availabilityHistory?.find(item => item.eventId === event.targetEventId || item.latestEventId === event.targetEventId);
      if (availability) {
        if (event.replacement.type !== 'availability.changed') throw new Error('A correction cannot change the original event family.');
        const replacement = event.replacement;
        if (replacement.playerId !== availability.playerId || replacement.available !== availability.available || replacement.replacementLineup ||
          (replacement.effective && canonical(replacement.effective) !== canonical(availability.effective))) {
          const corrected = reprojectParticipation(state, event, validateLineup);
          state = corrected.state;
          auditEffective = corrected.effective;
          auditPrior = corrected.priorValue;
          auditValue = { correction: corrected.value, earliestAffected: corrected.earliestAffected };
          break;
        }
        const reason = replacement.reason ?? availability.reason;
        if (!['arrival', 'departure', 'injury', 'return', 'other'].includes(reason) ||
          ((reason === 'arrival' || reason === 'return') && !availability.available) ||
          ((reason === 'injury' || reason === 'departure') && availability.available)) throw new Error('Corrected availability reason conflicts with its recorded state.');
        const corrected = { ...availability, reason, latestEventId: event.id };
        state = { ...state, availabilityHistory: state.availabilityHistory!.map(item => item.eventId === availability.eventId ? corrected : item) };
        auditEffective = corrected.effective;
        auditPrior = availability;
        auditValue = corrected;
        break;
      }
      if (event.replacement.type === 'lineup.committed' || event.replacement.type === 'availability.changed' && event.sourceRevision !== undefined) {
        const corrected = reprojectParticipation(state, event, validateLineup);
        state = corrected.state;
        auditEffective = corrected.effective;
        auditPrior = corrected.priorValue;
        auditValue = { correction: corrected.value, earliestAffected: corrected.earliestAffected };
        break;
      }
      if (state.eventHistory?.some(item => item.id === event.targetEventId)) throw new Error('This historical interval or half transition needs explicit reconciliation of the affected play. No recorded minutes were changed.');
      throw new Error('Correction target was not found in this match history.');
    }
    case 'event.voided': {
      if (!event.reason.trim() || event.reason.length > 500) throw new Error('Voiding an event needs an audited reason of 1–500 characters.');
      const goal = state.goals?.find(item => item.eventId === event.targetEventId || item.latestEventId === event.targetEventId);
      if (!goal) {
        if (state.eventHistory?.some(item => item.id === event.targetEventId && (item.type === 'lineup.committed' || item.type === 'availability.changed' || item.type === 'event.corrected'))) {
          const corrected = reprojectParticipation(state, event, validateLineup);
          state = corrected.state;
          auditEffective = corrected.effective;
          auditPrior = corrected.priorValue;
          auditValue = { correction: corrected.value, earliestAffected: corrected.earliestAffected };
          break;
        }
        if (state.eventHistory?.some(item => item.id === event.targetEventId)) throw new Error('Voiding a participation or half event requires explicit interval reconciliation. Original history was retained.');
        throw new Error('Void target was not found in this match history.');
      }
      if (goal.voided) throw new Error('This goal is already voided.');
      const replacement = { ...goal, voided: true, latestEventId: event.id };
      const goals = state.goals!.map(item => item.eventId === goal.eventId ? replacement : item);
      state = { ...state, goals, ...scoresFromGoals(state, goals) };
      auditEffective = replacement.effective;
      auditPrior = goal;
      auditValue = replacement;
      break;
    }
    case 'clock.recovery_required': {
      if (!isRunning(state)) throw new Error('Only a running clock needs continuity recovery.');
      if (!event.reason.trim()) throw new Error('A recovery reason is required.');
      state = { ...state, recoveryRequired: true, recoveryReason: event.reason };
      break;
    }
    case 'clock.corrected': {
      ensureLive(state);
      if (!isRunning(state) || !(state.recoveryRequired || readClock(state, event.sample).recoveryRequired)) throw new Error('Clock correction is only available for an uncertain running-clock recovery.');
      if (event.confirmUnchangedLineup !== true) throw new Error('Confirm unchanged lineup and availability since the secure checkpoint, or reconcile history separately.');
      if (!event.reason.trim()) throw new Error('Record the referee/trusted-source reason for a clock correction.');
      integer(event.halfActiveMs, 'Corrected active half time');
      if (event.halfActiveMs < state.halfActiveMs) throw new Error('Backdated clock correction needs audited history reconciliation, outside this M0 slice.');
      const newMatchMs = (state.half === 2 ? state.firstHalfDurationMs ?? 0 : 0) + event.halfActiveMs;
      if (newMatchMs < state.matchActiveMs) throw new Error('Clock correction cannot discard recorded participation.');
      // A controller-confirmed forward correction fills the unchanged last secure lineup only.
      // No wall-clock inference is involved; original command remains in the journal.
      if (isRunning(state) && newMatchMs > state.matchActiveMs) {
        const syntheticSample = { ...event.sample, sessionId: 'explicit-referee-correction', monotonicMs: newMatchMs - state.matchActiveMs };
        state = accrue({ ...state, recoveryRequired: false, anchor: { sample: { ...syntheticSample, monotonicMs: 0 }, halfActiveMs: state.halfActiveMs, matchActiveMs: state.matchActiveMs } }, syntheticSample);
      }
      state = { ...state, halfActiveMs: event.halfActiveMs, matchActiveMs: newMatchMs, recoveryRequired: false, recoveryReason: null, anchor: isRunning(state) ? { sample: { ...event.sample }, halfActiveMs: event.halfActiveMs, matchActiveMs: newMatchMs } : null };
      break;
    }
    default: throw new Error('Unsupported match command type.');
  }
  state = updatePolicyPositionMode(state, previous.revision + 1);
  const audit: MatchAuditEntry = {
    eventId: event.id, type: event.type, revision: previous.revision + 1, recordedAtMs: event.sample.wallTimeMs,
    actorId: event.actorId ?? null,
    effective: auditEffective === undefined ? (state.half === 0 ? null : effectiveTime(state)) : auditEffective,
    targetEventId: 'targetEventId' in event ? event.targetEventId : null,
    reason: 'lateEntryReason' in event && event.lateEntryReason?.trim() ? event.lateEntryReason : 'reason' in event ? event.reason ?? null : null,
    priorValue: cloneValue(auditPrior), value: cloneValue(auditValue),
  };
  return {
    ...state, revision: previous.revision + 1,
    appliedEvents: { ...previous.appliedEvents, [event.id]: signature },
    eventHistory: [...previous.eventHistory ?? [], cloneValue(event)],
    audit: [...previous.audit ?? [], audit],
  };
}

export function replayMatch(config: MatchConfig, events: MatchEvent[]): MatchState {
  return events.reduce(reduceMatch, createMatch(config));
}

/** Includes voided records for authorised audit; callers filter active goals for ordinary reports. */
export function goalRecords(state: MatchState): GoalRecord[] { return cloneValue(upgradeMatchState(state).goals ?? []); }
export function matchEventHistory(state: MatchState): MatchEvent[] { return cloneValue(upgradeMatchState(state).eventHistory ?? []); }
export function matchTimeline(state: MatchState): MatchAuditEntry[] {
  return cloneValue(upgradeMatchState(state).audit ?? []).sort((left, right) =>
    (left.effective?.matchElapsedMs ?? -1) - (right.effective?.matchElapsedMs ?? -1) || left.revision - right.revision);
}

export function playerMinutes(state: MatchState, sample: ClockSample): PlayerMinutes[] {
  // An unproved source contributes no invented post-checkpoint duration.
  const clock = readClock(state, sample);
  const projected = clock.recoveryRequired ? state : accrue(state, sample);
  return state.config.selectedPlayerIds.map(playerId => {
    const result: PlayerMinutes = { playerId, playingMs: 0, benchMs: 0, unavailableMs: 0, positionMs: {} };
    for (const interval of projected.intervals.filter(item => item.playerId === playerId)) {
      const durationMs = interval.endMs - interval.startMs;
      if (interval.state === 'playing') {
        result.playingMs += durationMs;
        if (interval.position) result.positionMs[interval.position] = (result.positionMs[interval.position] ?? 0) + durationMs;
      } else if (interval.state === 'available_bench') result.benchMs += durationMs;
      else result.unavailableMs += durationMs;
    }
    return result;
  });
}

function gcd(left: bigint, right: bigint): bigint { return right === 0n ? left : gcd(right, left % right); }
export function rational(numerator: bigint, denominator = 1n): Rational {
  if (denominator <= 0n || numerator < 0n) throw new Error('Rational target must be nonnegative with a positive denominator.');
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}
function add(left: Rational, right: Rational): Rational { return rational(left.numerator * right.denominator + right.numerator * left.denominator, left.denominator * right.denominator); }
function scale(value: Rational, numerator: bigint, denominator: bigint): Rational { return rational(value.numerator * numerator, value.denominator * denominator); }
export function rationalToNumber(value: Rational): number { return Number(value.numerator) / Number(value.denominator); }
export function withinTargetBand(actualMs: number, target: TargetResult): boolean {
  integer(actualMs, 'Actual playing time');
  const actual = BigInt(actualMs);
  return actual * target.lower.denominator >= target.lower.numerator && actual * target.upper.denominator <= target.upper.numerator;
}

/** Exact ME20 arithmetic experiment. Q07 policy acceptance and a solver remain open. */
export function calculateTargets(intervals: TargetInterval[], allPlayerIds: string[] = []): TargetResult[] {
  const totals = new Map<string, Rational>(allPlayerIds.map(id => [id, rational(0n)]));
  for (const interval of intervals) {
    integer(interval.durationMs, 'Target interval duration');
    integer(interval.pitchPlaces, 'Target pitch capacity');
    const ids = interval.availablePlayerIds;
    if (new Set(ids).size !== ids.length) throw new Error('Target interval repeats an available player.');
    if (interval.fixedKeeperId && !ids.includes(interval.fixedKeeperId)) throw new Error('Fixed keeper is not available in this target interval.');
    const count = ids.length;
    const capacity = Math.min(interval.pitchPlaces, count);
    if (capacity === 0) continue;
    for (const playerId of ids) {
      let contribution: Rational;
      if (playerId === interval.fixedKeeperId) contribution = rational(BigInt(interval.durationMs));
      else if (interval.fixedKeeperId) contribution = rational(BigInt(interval.durationMs) * BigInt(capacity - 1), BigInt(count - 1));
      else contribution = rational(BigInt(interval.durationMs) * BigInt(capacity), BigInt(count));
      totals.set(playerId, add(totals.get(playerId) ?? rational(0n), contribution));
    }
  }
  return [...totals].map(([playerId, target]) => ({ playerId, target, lower: scale(target, 9n, 10n), upper: scale(target, 11n, 10n) }));
}

export function currentTargets(state: MatchState, sample: ClockSample): TargetResult[] {
  const clock = readClock(state, sample);
  const projected = clock.recoveryRequired ? state : accrue(state, sample);
  return calculateTargets(projected.targetIntervals, state.config.selectedPlayerIds);
}

export interface GridCapacityProof {
  status: 'proved_infeasible_under_grid';
  reason: string;
  requiredOutfieldMs: number;
  minimumAllowedPerPlayerMs: number;
  maximumAllowedPerPlayerMs: number;
}

/**
 * Narrow FV06 arithmetic certificate for uniform availability and one fixed keeper.
 * Returning null means no capacity contradiction was proved; it does not prove a plan.
 */
export function proveFixedKeeperGridContradiction(input: {
  actualDurationMs: number;
  pitchPlaces: number;
  outfieldPlayerCount: number;
  gridMs: number;
}): GridCapacityProof | null {
  for (const [key, value] of Object.entries(input)) integer(value, key);
  if (input.outfieldPlayerCount === 0 || input.gridMs === 0 || input.pitchPlaces < 2) throw new Error('Grid proof requires outfield players, capacity and a positive grid.');
  const duration = BigInt(input.actualDurationMs);
  const places = BigInt(Math.min(input.pitchPlaces - 1, input.outfieldPlayerCount));
  const count = BigInt(input.outfieldPlayerCount);
  const grid = BigInt(input.gridMs);
  const required = duration * places;
  const lowerNumerator = required * 9n;
  const upperNumerator = required * 11n;
  const bandDenominator = count * 10n;
  const minimum = ((lowerNumerator + bandDenominator * grid - 1n) / (bandDenominator * grid)) * grid;
  const maximum = (upperNumerator / (bandDenominator * grid)) * grid;
  if (minimum <= maximum && minimum * count <= required && maximum * count >= required) return null;
  return {
    status: 'proved_infeasible_under_grid',
    reason: `Strict grid permits ${Number(minimum) / 60_000}–${Number(maximum) / 60_000} minutes per outfielder; that cannot fill ${Number(required) / 60_000} outfield player-minutes inside every individual ±10% band.`,
    requiredOutfieldMs: Number(required),
    minimumAllowedPerPlayerMs: Number(minimum),
    maximumAllowedPerPlayerMs: Number(maximum),
  };
}

/** Projection assumes current confirmed attendance/availability and fixed policy continue. */
export function projectedTargets(state: MatchState, sample: ClockSample): TargetResult[] {
  const clock = readClock(state, sample);
  if (clock.recoveryRequired) throw new Error('Time needs checking before projecting remaining opportunity.');
  const checkpoint = accrue(state, sample);
  let futureMs = 0;
  if (state.status === 'preparation') futureMs = state.config.plannedHalfDurationMs * 2;
  else if (state.status === 'half_time') futureMs = state.config.plannedHalfDurationMs;
  else if (isRunning(state) || isPaused(state)) futureMs = Math.max(0, state.config.plannedHalfDurationMs - clock.halfActiveMs) + (state.half === 1 ? state.config.plannedHalfDurationMs : 0);
  const future: TargetInterval = {
    durationMs: futureMs,
    availablePlayerIds: state.config.selectedPlayerIds.filter(id => available(state, id)),
    pitchPlaces: state.config.pitchPlaces,
    fixedKeeperId: state.config.fixedKeeperId && available(state, state.config.fixedKeeperId) ? state.config.fixedKeeperId : null,
  };
  return calculateTargets([...checkpoint.targetIntervals, future], state.config.selectedPlayerIds);
}
