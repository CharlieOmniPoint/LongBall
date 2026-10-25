import { currentFixedKeeper, playerMinutes, readClock as deriveClock, type ClockSample, type MatchState } from '../../domain/src/index';
import type { FutureSegment, PastTargetSegment, PlannerInput, PlannerSettings } from '../../domain/src/planner';
import type { ConfirmedMatchPlannerSettings } from './match-policy';

/** Builds a projection from frozen game snapshots; no availability or recorded time is invented. */
export function plannerInputFromMatch(match: MatchState, sample: ClockSample, accepted: ConfirmedMatchPlannerSettings, planVersion: number, mode: 'normal' | 'adventurous'): PlannerInput {
  const clock = deriveClock(match, sample);
  if (clock.recoveryRequired) throw new Error('Time needs checking before planning.');
  const snapshots = match.config.profileSnapshot;
  if (!snapshots?.length || !match.config.slots?.length) throw new Error('Review and save the formation and player eligibility in Preparation before planning.');
  const players = match.config.players.filter(player => match.config.selectedPlayerIds.includes(player.id)).map(player => {
    const profile = snapshots.find(item => item.playerId === player.id);
    if (!profile) throw new Error(`Saved eligibility is missing for ${player.displayName}; review Preparation.`);
    const rank = profile.preferences.indexOf('GK');
    return { id: player.id, goalkeeperChoice: rank === 0 || rank === 1 ? rank + 1 : 0, eligiblePositions: [...profile.eligiblePositions], preferences: [...profile.preferences] };
  });
  const keeperIdsFor = (availableIds: string[]) => players.filter(player => availableIds.includes(player.id) && (player.goalkeeperChoice === 1 || player.goalkeeperChoice === 2) && player.eligiblePositions.includes('GK')).map(player => player.id);
  const present = match.config.selectedPlayerIds.filter(id => match.attendance[id] === 'present' && match.availability[id]);
  const fixed = currentFixedKeeper(match);
  const keepers = keeperIdsFor(present);
  const goalkeeperPolicy: FutureSegment['goalkeeperPolicy'] = fixed ? { kind: 'fixed', playerId: fixed } : { kind: 'shared', eligibleKeeperIds: keepers };
  const history: PastTargetSegment[] = match.targetIntervals.map(interval => ({ ...interval, availablePlayerIds: [...interval.availablePlayerIds], keeperIds: interval.fixedKeeperId ? [interval.fixedKeeperId] : keeperIdsFor(interval.availablePlayerIds) }));
  const checkpointGap = clock.matchActiveMs - match.matchActiveMs;
  if (checkpointGap > 0) history.push({ durationMs: checkpointGap, availablePlayerIds: present, fixedKeeperId: fixed && present.includes(fixed) ? fixed : null, pitchPlaces: match.config.pitchPlaces, keeperIds: fixed && present.includes(fixed) ? [fixed] : keeperIdsFor(present) });
  const actual = Object.fromEntries(playerMinutes(match, sample).map(player => [player.playerId, { playingMs: player.playingMs, goalkeeperMs: player.positionMs.GK ?? 0 }]));
  const halfMs = match.config.plannedHalfDurationMs;
  const now = clock.matchActiveMs;
  const segments: FutureSegment[] = [];
  const append = (startMs: number, endMs: number, half: 1 | 2, halfStartMs: number) => {
    if (endMs > startMs) segments.push({ startMs, endMs, half, halfStartMs, plannedHalfMs: halfMs, availablePlayerIds: present, goalkeeperPolicy, availabilityBasis: 'confirmed', underStrengthApproval: null });
  };
  if (match.status === 'preparation') { append(0, halfMs, 1, 0); append(halfMs, halfMs * 2, 2, halfMs); }
  else if (match.status === 'half_time') append(now, now + halfMs, 2, now);
  else if (match.half === 1 && (match.status === 'first_half_running' || match.status === 'first_half_paused')) {
    const secondStart = now + Math.max(0, halfMs - clock.halfActiveMs);
    append(now, secondStart, 1, 0); append(secondStart, secondStart + halfMs, 2, secondStart);
  } else if (match.half === 2 && (match.status === 'second_half_running' || match.status === 'second_half_paused')) append(now, now + Math.max(0, halfMs - clock.halfActiveMs), 2, match.firstHalfDurationMs ?? now - clock.halfActiveMs);
  const currentLineup = match.status === 'preparation' || match.status === 'half_time' ? match.stagedLineup : match.lineup;
  const spells: Record<string, number> = {};
  for (const allocation of currentLineup) {
    let boundary = match.matchActiveMs;
    const intervals = match.intervals.filter(interval => interval.playerId === allocation.playerId).sort((left, right) => right.endMs - left.endMs);
    for (const interval of intervals) { if (interval.endMs !== boundary || interval.state !== 'playing') break; boundary = interval.startMs; }
    spells[allocation.playerId] = match.status === 'preparation' ? 0 : match.lineup.some(item => item.playerId === allocation.playerId) ? boundary : now;
  }
  const settings: PlannerSettings = {
    policyStatus: 'synthetic_experiment', preferredMinSpellMs: match.activePolicy?.payload.minimumStintMs ?? 300_000, preferredBufferFraction: match.activePolicy?.softPreferences.halfBufferFraction ?? 0.15, preferredBatchSize: accepted.batchPreference,
    hardMinSpellMs: null, hardBufferFraction: null, hardBatchCap: null, hardSubstitutionGridMs: null,
    normalPositionCosts: [0, 1, 4, 8], adventurousPositionCosts: [1, 0, 0.5, 8], positionMode: mode, maxWork: 500_000,
  };
  return { planId: `${match.config.matchId}-suggestion`, planVersion, sourceRevision: match.revision, seed: `${match.config.matchId}-rotation`, nowMs: now, players, slots: match.config.slots.map(slot => ({ slotId: slot.slotId, position: slot.position })), currentLineup: currentLineup.map(item => ({ ...item })), currentSpellStartedMs: spells, actual, pastTargetSegments: history, futureSegments: segments, locks: [], settings, ...(match.activePolicy ? { policyReference: {policyVersion:match.activePolicy.policyVersion,eventId:match.activePolicy.eventId,revision:match.activePolicy.revision,reason:match.activePolicy.reason} } : {}) };
}

