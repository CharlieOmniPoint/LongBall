import { describe, expect, it } from 'vitest';
import {
  createMatch, goalRecords, matchEventHistory, matchTimeline, playerMinutes, readClock,
  reduceMatch, replayMatch, upgradeMatchState, validateLineup,
} from './index';
import type { Allocation, ClockSample, MatchConfig, MatchEvent, MatchState } from './types';

const players = Array.from({ length: 9 }, (_, index) => ({ id: `p${index + 1}`, displayName: `Fictional ${index + 1}`, goalkeeperChoice: index === 0 ? 1 : 0 }));
const config: MatchConfig = { matchId: 'synthetic-live-events', players, selectedPlayerIds: players.map(player => player.id), pitchPlaces: 7, plannedHalfDurationMs: 1_500_000, fixedKeeperId: 'p1' };
const lineup: Allocation[] = ['GK', 'CB', 'CB', 'CM', 'LW', 'RW', 'ST'].map((position, index) => ({ playerId: `p${index + 1}`, slotId: `slot-${index}`, position }));
const sample = (monotonicMs: number, sessionId = 'continuous', wallTimeMs = 1_900_000_000_000 + monotonicMs): ClockSample => ({ monotonicMs, sessionId, wallTimeMs });
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
let serial = 0;
const command = <E extends WithoutId<MatchEvent>>(event: E): E & { id: string } => ({ ...event, id: `live-event-${++serial}` });

function started(custom = config, allocations = lineup): MatchState {
  let state = createMatch(custom);
  for (const playerId of custom.selectedPlayerIds) state = reduceMatch(state, command({ type: 'attendance.recorded', playerId, status: 'present', sample: sample(0) }));
  state = reduceMatch(state, command({ type: 'lineup.staged', lineup: allocations, sample: sample(0) }));
  return reduceMatch(state, command({ type: 'half.started', sample: sample(0) }));
}
const substituted = lineup.map(allocation => allocation.playerId === 'p7' ? { ...allocation, playerId: 'p8' } : allocation);

describe('F16 goal evidence, own goals and effective time', () => {
  it('separates positive scorer credit from both own-goal classifications', () => {
    let state = started();
    state = reduceMatch(state, command({ type: 'goal.recorded', beneficiary: 'us', scorerPlayerId: 'p2', isOwnGoal: false, goalType: 'free_kick', sample: sample(10_000) }));
    state = reduceMatch(state, command({ type: 'goal.recorded', beneficiary: 'us', scorerPlayerId: null, isOwnGoal: true, goalType: 'open_play', sample: sample(20_000) }));
    state = reduceMatch(state, command({ type: 'goal.recorded', beneficiary: 'opposition', scorerPlayerId: 'p3', isOwnGoal: true, goalType: 'open_play', sample: sample(30_000) }));
    state = reduceMatch(state, command({ type: 'goal.recorded', beneficiary: 'opposition', scorerPlayerId: null, isOwnGoal: false, goalType: 'penalty', sample: sample(40_000) }));
    expect(state.score).toEqual({ for: 2, against: 2 });
    expect(goalRecords(state).filter(goal => goal.beneficiary === 'us' && !goal.isOwnGoal).map(goal => goal.scorerPlayerId)).toEqual(['p2']);
    expect(readClock(state, sample(60_000)).halfActiveMs).toBe(60_000);
    expect(() => reduceMatch(state, command({ type: 'goal.recorded', beneficiary: 'us', isOwnGoal: true, scorerPlayerId: 'p2', sample: sample(50_000) }))).toThrow('cannot credit');
    expect(() => reduceMatch(state, command({ type: 'goal.recorded', beneficiary: 'opposition', isOwnGoal: false, scorerPlayerId: 'p2', sample: sample(50_000) }))).toThrow('cannot credit');
    expect(() => reduceMatch(state, command({ type: 'goal.recorded', beneficiary: 'us', scorerPlayerId: 'p9', sample: sample(50_000) }))).toThrow('on-pitch evidence');
  });

  it('keeps a captured goal time after later substitution and entry while the clock continues', () => {
    let state = started();
    state = reduceMatch(state, command({ type: 'lineup.committed', lineup: substituted, sourceRevision: state.revision, sample: sample(40_000) }));
    const goal = command({ type: 'goal.recorded', beneficiary: 'us', isOwnGoal: false, scorerPlayerId: 'p7', goalType: 'open_play',
      effective: { half: 1, halfElapsedMs: 30_000, matchElapsedMs: 30_000 }, sample: sample(45_000) });
    state = reduceMatch(state, goal);
    expect(goalRecords(state)[0]).toMatchObject({ eventId: goal.id, recordedAtMs: sample(45_000).wallTimeMs, effective: { half: 1, halfElapsedMs: 30_000, matchElapsedMs: 30_000 } });
    expect(reduceMatch(state, goal)).toBe(state);
    expect(() => reduceMatch(state, { ...goal, beneficiary: 'opposition' } as MatchEvent)).toThrow('reused');
    expect(readClock(state, sample(60_000)).halfActiveMs).toBe(60_000);
    expect(playerMinutes(state, sample(60_000)).find(player => player.playerId === 'p7')?.playingMs).toBe(40_000);
  });

  it('retains unknown legacy detail and rejects future or half-time-inflated coordinates', () => {
    let state = started();
    state = reduceMatch(state, command({ type: 'goal.recorded', beneficiary: 'us', sample: sample(100_000) }));
    expect(goalRecords(state)[0]).toMatchObject({ goalType: 'not_recorded', scorerPlayerId: null });
    state = reduceMatch(state, command({ type: 'half.ended', sample: sample(1_420_000) }));
    state = reduceMatch(state, command({ type: 'half.started', sample: sample(1_840_000) }));
    state = reduceMatch(state, command({ type: 'goal.recorded', beneficiary: 'opposition', goalType: 'penalty',
      effective: { half: 2, halfElapsedMs: 180_000, matchElapsedMs: 1_600_000 }, sample: sample(2_020_000) }));
    expect(goalRecords(state)[1].effective).toEqual({ half: 2, halfElapsedMs: 180_000, matchElapsedMs: 1_600_000 });
    expect(() => reduceMatch(state, command({ type: 'goal.recorded', beneficiary: 'us',
      effective: { half: 2, halfElapsedMs: 180_000, matchElapsedMs: 1_680_000 }, sample: sample(2_020_000) }))).toThrow('exclude half-time');
    expect(() => reduceMatch(state, command({ type: 'goal.recorded', beneficiary: 'us',
      effective: { half: 2, halfElapsedMs: 999_000, matchElapsedMs: 2_419_000 }, sample: sample(2_020_000) }))).toThrow('future');
  });
});

describe('ME54 score corrections preserve immutable evidence and actual participation', () => {
  it('refuses unsafe monotonic evidence even when a retrospective correction has a safe effective boundary', () => {
    const firstGoal = command({ type: 'goal.recorded', beneficiary: 'us', sample: sample(10_000) });
    const state = reduceMatch(started(), firstGoal);
    const correction = command({ type: 'event.corrected', targetEventId: firstGoal.id, reason: 'Reviewed original scorer evidence', replacement: { type: 'goal.recorded', beneficiary: 'opposition' }, sample: sample(1e308, 'continuous', 1_900_000_020_000) });
    expect(() => reduceMatch(state, correction)).toThrow('Clock sample is invalid');
    expect(state.matchActiveMs).toBe(10_000);
    const fractional = reduceMatch(state, { ...correction, sample: sample(20_000.75, 'continuous', 1_900_000_020_000) });
    expect(fractional.matchActiveMs).toBe(20_000);
    expect(fractional.score).toEqual({ for: 0, against: 1 });
  });
  it('refuses accumulated active-time overflow before producing a projection', () => {
    const initial = started();
    const nearLimit = Number.MAX_SAFE_INTEGER - 5;
    const state = { ...initial, halfActiveMs: nearLimit, matchActiveMs: nearLimit, anchor: { sample: sample(0), halfActiveMs: nearLimit, matchActiveMs: nearLimit } };
    expect(() => readClock(state, sample(10))).toThrow('safe integer');
    expect(state.matchActiveMs).toBe(nearLimit);
  });
  it('corrects and voids first-half goals after completion without reopening play or its deadline', () => {
    let state = started();
    const firstGoal = command({ type: 'goal.recorded', beneficiary: 'us', scorerPlayerId: 'p2', isOwnGoal: false, goalType: 'open_play', sample: sample(100_000) });
    state = reduceMatch(state, firstGoal);
    state = reduceMatch(state, command({ type: 'half.ended', sample: sample(1_420_000) }));
    state = reduceMatch(state, command({ type: 'half.started', sample: sample(1_840_000) }));
    state = reduceMatch(state, command({ type: 'goal.recorded', beneficiary: 'us', sample: sample(1_940_000) }));
    state = reduceMatch(state, command({ type: 'half.ended', sample: sample(3_340_000) }));
    const intervals = state.intervals;
    const targets = state.targetIntervals;
    const finish = state.completedAtMs;
    const correction = command({ type: 'event.corrected', targetEventId: firstGoal.id, reason: 'Referee confirmed opposition goal', actorId: 'synthetic-manager',
      replacement: { type: 'goal.recorded', beneficiary: 'opposition', isOwnGoal: false, scorerPlayerId: null, goalType: 'penalty' }, sample: sample(10, 'reopened-app', 1_900_100_000_000) });
    state = reduceMatch(state, correction);
    expect(state).toMatchObject({ status: 'completed', score: { for: 1, against: 1 }, halfTimeScore: { for: 0, against: 1 }, completedAtMs: finish });
    expect(state.intervals).toBe(intervals);
    expect(state.targetIntervals).toBe(targets);
    expect(reduceMatch(state, correction)).toBe(state);
    const audit = matchTimeline(state).find(entry => entry.eventId === correction.id)!;
    expect(audit).toMatchObject({ targetEventId: firstGoal.id, actorId: 'synthetic-manager', reason: 'Referee confirmed opposition goal', priorValue: { beneficiary: 'us' }, value: { beneficiary: 'opposition' } });
    const voidGoal = command({ type: 'event.voided', targetEventId: firstGoal.id, reason: 'Duplicate report confirmed', sample: sample(20, 'reopened-app', 1_900_100_000_010) });
    state = reduceMatch(state, voidGoal);
    expect(state).toMatchObject({ score: { for: 1, against: 0 }, halfTimeScore: { for: 0, against: 0 }, completedAtMs: finish });
    expect(goalRecords(state)[0]).toMatchObject({ eventId: firstGoal.id, latestEventId: voidGoal.id, voided: true });
    expect(matchEventHistory(state).find(event => event.id === firstGoal.id)).toEqual(firstGoal);
    expect(state.intervals).toBe(intervals);
    expect(reduceMatch(state, voidGoal)).toBe(state);
    expect(() => reduceMatch(state, { ...correction, id: 'new-correction' })).toThrow('explicit restoreVoided');
    state = reduceMatch(state, { ...correction, id: 'explicit-restoration', restoreVoided: true });
    expect(state.score).toEqual({ for: 1, against: 1 });
    expect(state.completedAtMs).toBe(finish);
  });

  it('requires real targets/reasons and retains the original command even if its caller mutates it', () => {
    let state = started();
    const goal = command({ type: 'goal.recorded', beneficiary: 'us', sample: sample(10_000) });
    state = reduceMatch(state, goal);
    (goal as Extract<MatchEvent, { type: 'goal.recorded' }>).beneficiary = 'opposition';
    expect(matchEventHistory(state).find(event => event.id === goal.id)).toMatchObject({ beneficiary: 'us' });
    const missing = command({ type: 'event.voided', targetEventId: 'not-in-this-match', reason: 'Review', sample: sample(20_000) });
    expect(() => reduceMatch(state, missing)).toThrow('not found');
    expect(() => reduceMatch(state, { ...missing, reason: '' })).toThrow('audited reason');
    const startId = matchEventHistory(state).find(event => event.type === 'half.started')!.id;
    expect(() => reduceMatch(state, command({ type: 'event.voided', targetEventId: startId, reason: 'Mistaken tap', sample: sample(20_000) }))).toThrow('interval reconciliation');
    expect(state.score).toEqual({ for: 1, against: 0 });
  });
});

describe('F17 availability, actual vacancies and confirmed replacement boundaries', () => {
  it('records vacancy until the replacement actually happens and conserves every player partition', () => {
    let state = started();
    state = reduceMatch(state, command({ type: 'availability.changed', playerId: 'p7', available: false, reason: 'injury', sample: sample(100_000) }));
    expect(state.lineup).toHaveLength(6);
    state = reduceMatch(state, command({ type: 'lineup.committed', lineup: substituted, sourceRevision: state.revision, sample: sample(130_000) }));
    const totals = playerMinutes(state, sample(160_000));
    expect(totals.find(player => player.playerId === 'p7')).toMatchObject({ playingMs: 100_000, unavailableMs: 60_000 });
    expect(totals.find(player => player.playerId === 'p8')).toMatchObject({ playingMs: 30_000, benchMs: 130_000 });
    expect(totals.reduce((sum, player) => sum + player.playingMs, 0)).toBe(7 * 160_000 - 30_000);
    for (const total of totals) {
      expect(total.playingMs + total.benchMs + total.unavailableMs).toBe(160_000);
      expect(Object.values(total.positionMs).reduce((sum, time) => sum + time, 0)).toBe(total.playingMs);
    }
  });

  it('commits an injury and replacement as one boundary; a return never puts the player back automatically', () => {
    let state = started();
    state = reduceMatch(state, command({ type: 'availability.changed', playerId: 'p7', available: false, reason: 'injury', replacementLineup: substituted, sample: sample(100_000) }));
    state = reduceMatch(state, command({ type: 'availability.changed', playerId: 'p7', available: true, reason: 'return', sample: sample(110_000) }));
    expect(state.lineup).toEqual(substituted);
    const totals = playerMinutes(state, sample(160_000));
    expect(totals.reduce((sum, player) => sum + player.playingMs, 0)).toBe(7 * 160_000);
    expect(totals.find(player => player.playerId === 'p7')).toMatchObject({ playingMs: 100_000, unavailableMs: 10_000, benchMs: 50_000 });
    expect(totals.find(player => player.playerId === 'p8')?.playingMs).toBe(60_000);
    expect(() => reduceMatch(state, command({ type: 'availability.changed', playerId: 'p7', available: true, reason: 'injury', sample: sample(170_000) }))).toThrow('unavailable status');
  });

  it('honours a captured effective boundary inside the current uncommitted segment and rejects rewriting a prior checkpoint', () => {
    let state = started();
    const injury = command({ type: 'availability.changed', playerId: 'p7', available: false, reason: 'injury',
      effective: { half: 1, halfElapsedMs: 100_000, matchElapsedMs: 100_000 }, sample: sample(130_000) });
    state = reduceMatch(state, injury);
    expect(playerMinutes(state, sample(160_000)).find(player => player.playerId === 'p7')).toMatchObject({ playingMs: 100_000, unavailableMs: 60_000 });
    expect(matchTimeline(state).find(entry => entry.eventId === injury.id)).toMatchObject({ effective: { matchElapsedMs: 100_000 }, recordedAtMs: sample(130_000).wallTimeMs });
    const earlier = started();
    const checkpoint = reduceMatch(earlier, command({ type: 'goal.recorded', beneficiary: 'us', sample: sample(120_000) }));
    expect(() => reduceMatch(checkpoint, injury)).toThrow('recorded boundary');
    expect(checkpoint.intervals.find(interval => interval.playerId === 'p7')).toMatchObject({ state: 'playing', startMs: 0, endMs: 120_000 });
  });

  it('allows reason-only audit corrections but never silently rewrites availability or actual intervals', () => {
    let state = started();
    const unavailable = command({ type: 'availability.changed', playerId: 'p7', available: false, reason: 'other', sample: sample(100_000) });
    state = reduceMatch(state, unavailable);
    const corrected = command({ type: 'event.corrected', targetEventId: unavailable.id, reason: 'Correct category',
      replacement: { type: 'availability.changed', playerId: 'p7', available: false, reason: 'departure' }, sample: sample(110_000) });
    state = reduceMatch(state, corrected);
    expect(state.availabilityHistory?.[0]).toMatchObject({ reason: 'departure', latestEventId: corrected.id });
    const before = state;
    expect(() => reduceMatch(state, command({ type: 'event.corrected', targetEventId: unavailable.id, reason: 'Change the past',
      replacement: { type: 'availability.changed', playerId: 'p7', available: true, reason: 'return' }, sample: sample(120_000) }))).toThrow('interval reconciliation');
    expect(state).toBe(before);
    expect(playerMinutes(state, sample(130_000)).find(player => player.playerId === 'p7')).toMatchObject({ playingMs: 100_000, unavailableMs: 30_000 });
  });
});

describe('Immutable formation/profile snapshots, legacy replay and abandonment', () => {
  it('enforces saved formation slots and eligibility across 5–11 without mutating profile snapshots', () => {
    for (const pitchPlaces of [5, 7, 9, 11]) {
      const roster = Array.from({ length: pitchPlaces + 1 }, (_, index) => ({ id: `f${index}`, displayName: `Fictional ${index}`, goalkeeperChoice: index === 0 ? 1 : 0 }));
      const slots = roster.slice(0, pitchPlaces).map((_, index) => ({ slotId: `formation-${index}`, position: index === 0 ? 'GK' : `P${index}` }));
      const snapshots = roster.map((player, index) => ({ playerId: player.id, initials: `F${index}`, preferences: [index === 0 ? 'GK' : `P${Math.min(index, pitchPlaces - 1)}`], eligiblePositions: index === 0 ? ['GK'] : slots.slice(1).map(slot => slot.position) }));
      const matchConfig: MatchConfig = { ...config, matchId: `format-${pitchPlaces}`, players: roster, selectedPlayerIds: roster.map(player => player.id), pitchPlaces, fixedKeeperId: 'f0', slots, profileSnapshot: snapshots };
      const allocations = slots.map((slot, index) => ({ ...slot, playerId: `f${index}` }));
      const state = started(matchConfig, allocations);
      expect(validateLineup(state, allocations)).toEqual([]);
      expect(validateLineup(state, allocations.map((allocation, index) => index === 1 ? { ...allocation, position: 'invented' } : allocation))).toContain('Allocation must use its saved formation slot and position.');
      snapshots[0].preferences[0] = 'ST';
      snapshots[0].eligiblePositions.length = 0;
      expect(state.config.profileSnapshot?.[0]).toMatchObject({ preferences: ['GK'], eligiblePositions: ['GK'] });
    }
  });

  it('upgrades retained M0 commands only when their clock, scores and actual intervals exactly reconcile', () => {
    let state = started();
    state = reduceMatch(state, command({ type: 'goal.recorded', beneficiary: 'us', sample: sample(100_000) }));
    const legacy = JSON.parse(JSON.stringify(state)) as MatchState;
    delete legacy.schemaVersion; delete legacy.goals; delete legacy.availabilityHistory; delete legacy.eventHistory; delete legacy.audit;
    const upgraded = upgradeMatchState(legacy);
    expect(upgraded.schemaVersion).toBe(2);
    expect(goalRecords(legacy)).toHaveLength(1);
    expect(upgraded.intervals).toEqual(legacy.intervals);
    expect(upgraded.matchActiveMs).toBe(100_000);
    const damaged = { ...legacy, score: { for: 2, against: 0 } };
    expect(() => upgradeMatchState(damaged)).toThrow('Legacy replay differs at score');
    expect(damaged.score.for).toBe(2);
    expect(replayMatch(upgraded.config, matchEventHistory(upgraded))).toEqual(upgraded);
  });

  it('abandons actual play without manufacturing full time, awards or later minutes', () => {
    let state = started();
    state = reduceMatch(state, command({ type: 'goal.recorded', beneficiary: 'us', sample: sample(10_000) }));
    const abandon = command({ type: 'match.abandoned', reason: 'weather', sample: sample(100_000) });
    state = reduceMatch(state, abandon);
    expect(state).toMatchObject({ status: 'abandoned', matchActiveMs: 100_000, completedAtMs: null, abandonReason: 'weather', abandonedAtMs: sample(100_000).wallTimeMs, score: { for: 1, against: 0 } });
    expect(readClock(state, sample(1_000_000)).matchActiveMs).toBe(100_000);
    expect(playerMinutes(state, sample(1_000_000)).reduce((sum, player) => sum + player.playingMs, 0)).toBe(7 * 100_000);
    expect(reduceMatch(state, abandon)).toBe(state);
    expect(() => reduceMatch(state, command({ type: 'half.started', sample: sample(200_000) }))).toThrow('read-only');
    expect(() => reduceMatch(createMatch(config), command({ type: 'match.abandoned', reason: 'weather', sample: sample(0) }))).toThrow('Only a started match');
  });
});
