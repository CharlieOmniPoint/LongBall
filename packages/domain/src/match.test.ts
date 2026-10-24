import { describe, expect, it } from 'vitest';
import {
  calculateTargets, createMatch, currentTargets, playerMinutes, rational, rationalToNumber,
  readClock, reduceMatch, replayMatch, validateLineup, withinTargetBand, proveFixedKeeperGridContradiction, projectedTargets,
} from './index';
import type { Allocation, ClockSample, MatchConfig, MatchEvent, MatchState } from './index';

const roster = Array.from({ length: 13 }, (_, index) => ({ id: `p${index + 1}`, displayName: `Player ${index + 1}`, goalkeeperChoice: index === 0 ? 1 : 0 }));
const config: MatchConfig = { matchId: 'synthetic-roma-match', players: roster, selectedPlayerIds: roster.slice(0, 9).map(player => player.id), pitchPlaces: 7, plannedHalfDurationMs: 1_500_000, fixedKeeperId: 'p1' };
const lineup: Allocation[] = ['GK', 'LB', 'RB', 'LM', 'CM', 'RM', 'ST'].map((position, index) => ({ slotId: `slot-${index}`, position, playerId: `p${index + 1}` }));
const sample = (monotonicMs: number, sessionId = 'continuous-session', wallTimeMs = 1_800_000_000_000 + monotonicMs): ClockSample => ({ monotonicMs, sessionId, wallTimeMs });
let nextId = 0;
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
function event(value: WithoutId<MatchEvent>): MatchEvent { return { ...value, id: `event-${++nextId}` } as MatchEvent; }
function checkedIn(matchConfig = config): MatchState {
  let state = createMatch(matchConfig);
  for (const playerId of matchConfig.selectedPlayerIds) state = reduceMatch(state, event({ type: 'attendance.recorded', playerId, status: 'present', sample: sample(0) }));
  return state;
}
function started(): MatchState {
  let state = checkedIn();
  state = reduceMatch(state, event({ type: 'lineup.staged', lineup, sample: sample(0) }));
  return reduceMatch(state, event({ type: 'half.started', sample: sample(0) }));
}
function sumValues(values: Record<string, number>): number { return Object.values(values).reduce((left, right) => left + right, 0); }

describe('M0 manual match journey (D11/D14/D23, ME10–13)', () => {
  it('does not turn responses/selection into actual attendance', () => {
    const state = createMatch(config);
    expect(state.attendance.p1).toBe('not_recorded');
    expect(validateLineup(state, lineup)).toContain('p1: confirm actual attendance first.');
    expect(state.intervals).toEqual([]);
    expect(() => reduceMatch(state, event({ type: 'half.started', sample: sample(0) }))).toThrow('Choose exactly 7');
  });
  it('MT01: duplicate Start is idempotent and an ID cannot carry different content', () => {
    let state = checkedIn();
    state = reduceMatch(state, event({ type: 'lineup.staged', lineup, sample: sample(0) }));
    const start = event({ type: 'half.started', sample: sample(0) });
    const playing = reduceMatch(state, start);
    expect(reduceMatch(playing, start)).toBe(playing);
    expect(() => reduceMatch(playing, { ...start, sample: sample(1) })).toThrow('reused');
    expect(() => reduceMatch(playing, event({ type: 'half.started', sample: sample(2) }))).toThrow('only from preparation');
    expect(playing.intervals).toHaveLength(0);
  });
  it('rejects duplicate players, duplicate slots, unavailable starters and unwilling keeper cover', () => {
    const state = checkedIn();
    expect(validateLineup(state, lineup.map((item, index) => index === 6 ? { ...item, playerId: 'p2' } : item))).toContain('A player can occupy only one pitch place.');
    expect(validateLineup(state, lineup.map((item, index) => index === 6 ? { ...item, slotId: 'slot-1' } : item))).toContain('Each pitch slot must be unique.');
    expect(validateLineup(state, lineup.map((item, index) => index === 0 ? { ...item, playerId: 'p8' } : item))).toContain('Goalkeeper cover requires a first- or second-choice eligible keeper.');
    const absent = reduceMatch(state, event({ type: 'availability.changed', playerId: 'p7', available: false, sample: sample(0) }));
    expect(validateLineup(absent, lineup)).toContain('p7: player is unavailable.');
    expect(validateLineup(state, lineup.slice(1))).toContain('Choose exactly 7 pitch players.');
  });
  it('MT02/MT03: halftime is draft-only; short first half leaves an independent 25 minute second half', () => {
    let state = started();
    state = reduceMatch(state, event({ type: 'half.ended', sample: sample(1_420_000) }));
    expect(state.status).toBe('half_time');
    const firstHistory = state.intervals;
    const secondLineup = lineup.map(item => item.playerId === 'p7' ? { ...item, playerId: 'p8' } : item);
    state = reduceMatch(state, event({ type: 'lineup.staged', lineup: secondLineup, sample: sample(1_840_000) }));
    expect(state.intervals).toBe(firstHistory);
    expect(state.lineup).toEqual(lineup);
    expect(readClock(state, sample(1_840_000)).matchActiveMs).toBe(1_420_000);
    state = reduceMatch(state, event({ type: 'half.started', sample: sample(1_840_000) }));
    expect(state.lineup).toEqual(secondLineup);
    expect(readClock(state, sample(1_840_000)).remainingMs).toBe(1_500_000);
    state = reduceMatch(state, event({ type: 'half.ended', sample: sample(3_340_000) }));
    expect(state.status).toBe('completed');
    expect(state.completedTimeQuality).toBe('reviewRequired');
    expect(state.matchActiveMs).toBe(2_920_000);
    const minutes = playerMinutes(state, sample(3_340_000));
    expect(minutes.find(player => player.playerId === 'p7')?.playingMs).toBe(1_420_000);
    expect(minutes.find(player => player.playerId === 'p8')?.playingMs).toBe(1_500_000);
    expect(currentTargets(state, sample(3_340_000)).find(player => player.playerId === 'p2')?.target).toEqual(rational(2_190_000n));
    expect(minutes.reduce((total, player) => total + player.playingMs, 0)).toBe(7 * 2_920_000);
    for (const player of minutes) expect(sumValues(player.positionMs)).toBe(player.playingMs);
  });
  it('ME21: projection retains observed short first half and does not cap overtime at 50 minutes', () => {
    let state = started();
    expect(projectedTargets(state, sample(1_560_000))[0].target).toEqual(rational(3_060_000n));
    state = reduceMatch(state, event({ type: 'half.ended', sample: sample(1_420_000) }));
    expect(projectedTargets(state, sample(1_840_000))[0].target).toEqual(rational(2_920_000n));
    expect(projectedTargets(state, sample(1_840_000))[1].target).toEqual(rational(2_190_000n));
  });
  it('MT04: zero and overtime never end play or change the lineup automatically', () => {
    const state = started();
    expect(readClock(state, sample(1_500_000))).toMatchObject({ remainingMs: 0, addedMs: 0 });
    expect(readClock(state, sample(1_572_000))).toMatchObject({ remainingMs: 0, addedMs: 72_000 });
    expect(state.status).toBe('first_half_running');
    expect(playerMinutes(state, sample(1_572_000))[0].playingMs).toBe(1_572_000);
    expect(state.lineup).toEqual(lineup);
  });
  it('MT05: actual pause excludes the whole gap, resume continues the same half', () => {
    let state = started();
    state = reduceMatch(state, event({ type: 'half.paused', sample: sample(720_000) }));
    expect(readClock(state, sample(900_000)).halfActiveMs).toBe(720_000);
    state = reduceMatch(state, event({ type: 'half.resumed', sample: sample(900_000) }));
    expect(readClock(state, sample(960_000)).halfActiveMs).toBe(780_000);
    expect(playerMinutes(state, sample(960_000))[0].playingMs).toBe(780_000);
  });
  it('MT16: a live position swap preserves playing totals and rejects stale drafts', () => {
    let state = started();
    const swapped = lineup.map(item => item.playerId === 'p2' ? { ...item, position: 'RB', slotId: 'slot-2' } : item.playerId === 'p3' ? { ...item, position: 'LB', slotId: 'slot-1' } : item);
    const revision = state.revision;
    state = reduceMatch(state, event({ type: 'lineup.committed', lineup: swapped, sourceRevision: revision, sample: sample(300_000) }));
    expect(() => reduceMatch(state, event({ type: 'lineup.committed', lineup, sourceRevision: revision, sample: sample(600_000) }))).toThrow('stale');
    const p2 = playerMinutes(state, sample(600_000)).find(player => player.playerId === 'p2');
    expect(p2).toMatchObject({ playingMs: 600_000, positionMs: { LB: 300_000, RB: 300_000 } });
  });
  it('MT11: injury closes actual play immediately and exposes unfilled capacity', () => {
    let state = started();
    state = reduceMatch(state, event({ type: 'availability.changed', playerId: 'p7', available: false, sample: sample(1_000_000) }));
    expect(state.lineup).toHaveLength(6);
    const minutes = playerMinutes(state, sample(1_030_000));
    expect(minutes.find(player => player.playerId === 'p7')).toMatchObject({ playingMs: 1_000_000, unavailableMs: 30_000 });
    expect(minutes.reduce((sum, player) => sum + player.playingMs, 0)).toBe(7 * 1_000_000 + 6 * 30_000);
  });
  it('a goal captures active time, keeps the clock running, and duplicates do not score again', () => {
    const goal = event({ type: 'goal.recorded', beneficiary: 'us', sample: sample(30_000) });
    const state = reduceMatch(started(), goal);
    expect(state.score).toEqual({ for: 1, against: 0 });
    expect(reduceMatch(state, goal).score.for).toBe(1);
    expect(readClock(state, sample(60_000)).halfActiveMs).toBe(60_000);
  });
  it('deterministic replay preserves original events and never mutates the input', () => {
    const events: MatchEvent[] = config.selectedPlayerIds.map(playerId => event({ type: 'attendance.recorded', playerId, status: 'present', sample: sample(0) }));
    events.push(event({ type: 'lineup.staged', lineup, sample: sample(0) }), event({ type: 'half.started', sample: sample(0) }), event({ type: 'half.ended', sample: sample(1_500_000) }));
    expect(replayMatch(config, events)).toEqual(replayMatch(config, [...events]));
    expect(config.players).toEqual(roster);
    expect(lineup).toHaveLength(7);
  });
});

describe('Clock uncertainty (ME12/MT17/MT18)', () => {
  it('does not use wall-clock movement for active duration', () => {
    const state = started();
    expect(readClock(state, sample(600_000, 'continuous-session', 1_800_000_000_000 - 1_200_000)).halfActiveMs).toBe(600_000);
    expect(readClock(state, sample(600_000, 'continuous-session', 1_800_000_000_000 + 99_000_000)).halfActiveMs).toBe(600_000);
    expect(state.halfActiveMs).toBe(0);
  });
  it('preserves fractional sample residuals across frequent commands', () => {
    let state = started();
    for (const value of [0.7, 1.4, 2.1, 2.8, 3.5]) state = reduceMatch(state, event({ type: 'goal.recorded', beneficiary: 'us', sample: sample(value, 'continuous-session', 1_800_000_000_000 + Math.floor(value)) }));
    expect(readClock(state, sample(4.2, 'continuous-session', 1_800_000_000_004)).halfActiveMs).toBe(4);
    expect(playerMinutes(state, sample(4.2, 'continuous-session', 1_800_000_000_004))[0].playingMs).toBe(4);
  });
  it('requires recovery on reload or rollback and retains the last secure checkpoint', () => {
    let state = started();
    state = reduceMatch(state, event({ type: 'goal.recorded', beneficiary: 'us', sample: sample(600_000) }));
    expect(readClock(state, sample(20_000, 'new-session'))).toMatchObject({ halfActiveMs: 600_000, recoveryRequired: true });
    expect(readClock(state, sample(599_999))).toMatchObject({ halfActiveMs: 600_000, recoveryRequired: true });
    expect(() => reduceMatch(state, event({ type: 'half.ended', sample: sample(20_000, 'new-session') }))).toThrow('Time needs checking');
    expect(playerMinutes(state, sample(20_000, 'new-session'))[0].playingMs).toBe(600_000);
  });
  it('explicit referee recovery preserves prior events and needs unchanged-lineup confirmation', () => {
    let state = started();
    state = reduceMatch(state, event({ type: 'goal.recorded', beneficiary: 'us', sample: sample(600_000) }));
    state = reduceMatch(state, event({ type: 'clock.recovery_required', reason: 'Browser reloaded', sample: sample(10, 'restarted') }));
    const correction = event({ type: 'clock.corrected', halfActiveMs: 720_000, reason: 'Referee stopwatch; no lineup or availability changes', confirmUnchangedLineup: true, sample: sample(20, 'restarted') });
    expect(() => reduceMatch(state, { ...correction, confirmUnchangedLineup: false } as unknown as MatchEvent)).toThrow('Confirm unchanged lineup');
    state = reduceMatch(state, correction);
    expect(readClock(state, sample(60_020, 'restarted'))).toMatchObject({ halfActiveMs: 780_000, recoveryRequired: false });
    expect(playerMinutes(state, sample(60_020, 'restarted'))[0].playingMs).toBe(780_000);
    expect(state.score.for).toBe(1);
    expect(Object.keys(state.appliedEvents)).toContain(correction.id);
  });
  it('does not offer ordinary clock correction as a way to discard known elapsed time', () => {
    const state = started();
    expect(() => reduceMatch(state, event({ type: 'clock.corrected', halfActiveMs: 1_000, reason: 'shortcut', confirmUnchangedLineup: true, sample: sample(600_000) }))).toThrow('uncertain running-clock');
  });
});

describe('ME20 exact availability-target arithmetic experiment (Q07 remains open)', () => {
  const ids = Array.from({ length: 9 }, (_, index) => `p${index + 1}`);
  it('FV01/FV05: fixed keeper 50:00, each outfielder 37:30; actual short game target 36:30', () => {
    const normal = calculateTargets([{ durationMs: 3_000_000, availablePlayerIds: ids, pitchPlaces: 7, fixedKeeperId: 'p1' }]);
    expect(normal[0].target).toEqual(rational(3_000_000n));
    expect(normal[1]).toMatchObject({ target: rational(2_250_000n), lower: rational(2_025_000n), upper: rational(2_475_000n) });
    const short = calculateTargets([{ durationMs: 2_920_000, availablePlayerIds: ids, pitchPlaces: 7, fixedKeeperId: 'p1' }]);
    expect(short[1].target).toEqual(rational(2_190_000n));
  });
  it('FV02: preserves exact 300/7 minute target and compares bands without rounded boundaries', () => {
    const result = calculateTargets([{ durationMs: 3_000_000, availablePlayerIds: ids.slice(0, 8), pitchPlaces: 7, fixedKeeperId: 'p1' }]);
    expect(result[1].target).toEqual(rational(18_000_000n, 7n));
    for (const actual of [2_580_000, 2_580_000, 2_640_000, 2_700_000, 2_520_000, 2_520_000, 2_460_000]) expect(withinTargetBand(actual, result[1])).toBe(true);
    expect(withinTargetBand(2_314_285, result[1])).toBe(false);
    expect(withinTargetBand(2_314_286, result[1])).toBe(true);
  });
  it('FV03/MT08: sharing goalkeeper role alone does not satisfy total playing-time fairness', () => {
    const result = calculateTargets([{ durationMs: 3_000_000, availablePlayerIds: ids, pitchPlaces: 7, fixedKeeperId: null }]);
    expect(result[0].target).toEqual(rational(21_000_000n, 9n));
    expect(withinTargetBand(1_500_000, result[0])).toBe(false);
    expect(withinTargetBand(2_100_000, result[0])).toBe(true);
    expect(withinTargetBand(2_400_000, result[0])).toBe(true);
  });
  it('FV04/MT09: late arrival changes only prospective interval denominators', () => {
    const result = calculateTargets([
      { durationMs: 600_000, availablePlayerIds: ids.slice(0, 8), pitchPlaces: 7, fixedKeeperId: 'p1' },
      { durationMs: 2_400_000, availablePlayerIds: ids, pitchPlaces: 7, fixedKeeperId: 'p1' },
    ]);
    expect(result.find(item => item.playerId === 'p2')?.target).toEqual(rational(16_200_000n, 7n));
    expect(result.find(item => item.playerId === 'p9')?.target).toEqual(rational(1_800_000n));
    expect(result.find(item => item.playerId === 'p1')?.target).toEqual(rational(3_000_000n));
    expect(result.reduce((sum, item) => sum + rationalToNumber(item.target), 0)).toBeCloseTo(21_000_000, 6);
  });
  it('FV06/MT13: proves the strict-grid capacity contradiction without claiming a general solver', () => {
    const proof = proveFixedKeeperGridContradiction({ actualDurationMs: 2_400_000, pitchPlaces: 7, outfieldPlayerCount: 9, gridMs: 300_000 });
    expect(proof).toMatchObject({ status: 'proved_infeasible_under_grid', minimumAllowedPerPlayerMs: 1_500_000, maximumAllowedPerPlayerMs: 1_500_000, requiredOutfieldMs: 14_400_000 });
    expect(9 * (proof?.maximumAllowedPerPlayerMs ?? 0)).toBe(13_500_000);
    expect(proveFixedKeeperGridContradiction({ actualDurationMs: 3_000_000, pitchPlaces: 7, outfieldPlayerCount: 8, gridMs: 300_000 })).toBeNull();
  });
  it('zero availability, a sole fixed keeper, repeated zero-duration boundaries and zero target are safe', () => {
    expect(calculateTargets([{ durationMs: 1_000, availablePlayerIds: [], pitchPlaces: 7, fixedKeeperId: null }], ['absent'])[0].target).toEqual(rational(0n));
    const single = calculateTargets([{ durationMs: 1_000, availablePlayerIds: ['p1'], pitchPlaces: 7, fixedKeeperId: 'p1' }]);
    expect(single[0].target).toEqual(rational(1_000n));
    expect(calculateTargets([{ durationMs: 0, availablePlayerIds: ids, pitchPlaces: 7, fixedKeeperId: null }])[0].target).toEqual(rational(0n));
    const zero = calculateTargets([], ['absent'])[0];
    expect(withinTargetBand(0, zero)).toBe(true);
    expect(withinTargetBand(1, zero)).toBe(false);
  });
});
