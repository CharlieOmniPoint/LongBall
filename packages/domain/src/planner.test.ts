import { describe, expect, it } from 'vitest';
import { rationalToNumber } from './index';
import { planMatch, selectPositionMode, selectMatchPositionMode, updatePlanAlerts, validatePlannerSchedule } from './planner';
import type { FutureSegment, PlannerInput, PlannerResult, PlannerSettings } from './planner';

const positions = ['GK', 'CB', 'CM', 'LW', 'RW', 'ST', 'DM'];
const settings: PlannerSettings = {
  policyStatus: 'synthetic_experiment', preferredMinSpellMs: 300_000, preferredBufferFraction: 0.15,
  preferredBatchSize: 2, hardMinSpellMs: null, hardBufferFraction: null, hardBatchCap: null, hardSubstitutionGridMs: null,
  normalPositionCosts: [0, 1, 4, 8], adventurousPositionCosts: [1, 0, 0.5, 8], positionMode: 'normal', maxWork: 2_000_000,
};
function fixture(playerCount = 9, keeperCount = 1, durationMs = 3_000_000, pitchPlaces = 7): PlannerInput {
  const slots = positions.slice(0, pitchPlaces).map((position, index) => ({ slotId: `slot-${index}`, position }));
  while (slots.length < pitchPlaces) slots.push({ slotId: `slot-${slots.length}`, position: slots.length % 2 ? 'CB' : 'CM' });
  const players = Array.from({ length: playerCount }, (_, index) => ({
    id: `p${index + 1}`, goalkeeperChoice: index < keeperCount ? index === 0 ? 1 : 2 : 0,
    eligiblePositions: index < keeperCount ? positions : positions.filter(position => position !== 'GK'),
    preferences: index < keeperCount ? ['GK', 'CM', 'CB'] : ['CM', 'CB', 'ST'],
  }));
  const playerIds = players.map(player => player.id);
  const half = durationMs / 2;
  const policy: FutureSegment['goalkeeperPolicy'] = keeperCount === 1 ? { kind: 'fixed', playerId: 'p1' } : { kind: 'shared', eligibleKeeperIds: playerIds.slice(0, keeperCount) };
  return {
    planId: 'synthetic-plan', planVersion: 1, sourceRevision: 8, seed: 'roma-fixture-rotation-1', nowMs: 0,
    players, slots, currentLineup: slots.map((slot, index) => ({ ...slot, playerId: playerIds[index] })),
    currentSpellStartedMs: Object.fromEntries(playerIds.map(id => [id, 0])),
    actual: Object.fromEntries(playerIds.map(id => [id, { playingMs: 0, goalkeeperMs: 0 }])), pastTargetSegments: [],
    futureSegments: [
      { startMs: 0, endMs: half, half: 1, halfStartMs: 0, plannedHalfMs: half, availablePlayerIds: playerIds, goalkeeperPolicy: policy, availabilityBasis: 'confirmed', underStrengthApproval: null },
      { startMs: half, endMs: durationMs, half: 2, halfStartMs: half, plannedHalfMs: half, availablePlayerIds: playerIds, goalkeeperPolicy: policy, availabilityBasis: 'confirmed', underStrengthApproval: null },
    ], locks: [], settings: { ...settings },
  };
}
function expectFair(result: PlannerResult) {
  expect(result.status, JSON.stringify(result.explanations)).toBe('feasible');
  expect(result.players.every(player => player.withinBand)).toBe(true);
  expect(result.diagnostics.equalKeeperDuties).toBe(true);
  expect(result.schedule.every(slice => slice.requiresConfirmation)).toBe(true);
}

describe('deterministic substitution/position scheduling', () => {
  it('FV01: nine players, one fixed keeper, individual targets37:30 and validated actual allocation', () => {
    const input = fixture(); const result = planMatch(input);
    expectFair(result);
    expect(result.players.find(player => player.playerId === 'p1')?.projectedMs).toBe(3_000_000);
    expect(rationalToNumber(result.players.find(player => player.playerId === 'p2')!.target)).toBe(2_250_000);
    expect(result.nextChange?.requiresConfirmation).toBe(true);
    expect(input.actual.p2.playingMs).toBe(0);
    expect(input.currentLineup).toHaveLength(7);
    expect(validatePlannerSchedule(input, result.schedule).legal).toBe(true);
  });
  it('FV02: eight players satisfy unrounded300/7-minute bands', () => {
    const result = planMatch(fixture(8)); expectFair(result);
    const outfield = result.players.find(player => player.playerId === 'p2')!;
    expect(rationalToNumber(outfield.target)).toBeCloseTo(18_000_000 / 7, 8);
  });
  it('FV03/MT30: two keepers share25:00 each and also receive fair common-pool total minutes', () => {
    const input = fixture(9, 2); const result = planMatch(input); expectFair(result);
    for (const id of ['p1', 'p2']) {
      const player = result.players.find(item => item.playerId === id)!;
      expect(player.projectedGoalkeeperMs).toBe(1_500_000);
      expect(player.projectedMs).toBeGreaterThanOrEqual(2_100_000);
    }
    const avoidablyUnequal = result.schedule.map(slice => ({ ...slice, lineup: slice.lineup.map(item => item.position === 'GK' && slice.startMs >= 1_500_000 ? { ...item, playerId: 'p1' } : item) }));
    expect(validatePlannerSchedule(input, avoidablyUnequal).equalKeeperDuties).toBe(false);
  });
  it('FV04: late arrival changes only future targets and cannot be placed before availability', () => {
    const input = fixture(); const first = input.futureSegments[0];
    input.futureSegments = [
      { ...first, endMs: 600_000, availablePlayerIds: first.availablePlayerIds.filter(id => id !== 'p9') },
      { ...first, startMs: 600_000, availabilityBasis: 'expected' },
      input.futureSegments[1],
    ];
    const result = planMatch(input); expectFair(result);
    expect(rationalToNumber(result.players.find(player => player.playerId === 'p9')!.target)).toBe(1_800_000);
    expect(rationalToNumber(result.players.find(player => player.playerId === 'p2')!.target)).toBeCloseTo(16_200_000 / 7, 8);
    expect(result.schedule.filter(slice => slice.startMs < 600_000).every(slice => slice.lineup.every(item => item.playerId !== 'p9'))).toBe(true);
  });
  it('FV05: final targets use23:40 plus independent25:00, with no fixed50-minute rewrite', () => {
    const input = fixture(); input.futureSegments[0].endMs = 1_420_000;
    input.futureSegments[1] = { ...input.futureSegments[1], startMs: 1_420_000, halfStartMs: 1_420_000, endMs: 2_920_000 };
    const result = planMatch(input); expectFair(result);
    expect(rationalToNumber(result.players.find(player => player.playerId === 'p2')!.target)).toBe(2_190_000);
  });
  it('FV06: strict5-minute grid gets a capacity proof; flexible timing can establish all bands', () => {
    const input = fixture(10, 1, 2_400_000); input.settings.hardSubstitutionGridMs = 300_000;
    const blocked = planMatch(input);
    expect(blocked.status).toBe('infeasible'); expect(blocked.proof?.kind).toBe('strict_grid_capacity');
    input.settings.hardSubstitutionGridMs = null;
    expectFair(planMatch(input));
  });
  it('replanning freezes actual history and catches up from real confirmed substitutions', () => {
    const input = fixture(); input.nowMs = 600_000;
    for (const id of input.currentLineup.map(item => item.playerId)) input.actual[id] = { playingMs: 600_000, goalkeeperMs: id === 'p1' ? 600_000 : 0 };
    input.pastTargetSegments = [{ durationMs: 600_000, availablePlayerIds: input.players.map(player => player.id), fixedKeeperId: 'p1', keeperIds: ['p1'], pitchPlaces: 7 }];
    input.futureSegments[0].startMs = 600_000;
    const before = structuredClone(input.actual); const result = planMatch(input); expectFair(result);
    expect(input.actual).toEqual(before); expect(result.schedule[0].startMs).toBe(600_000);
    for (const player of result.players) expect(player.projectedMs).toBeGreaterThanOrEqual(input.actual[player.playerId].playingMs);
  });
  it('a second keeper arrival changes only future policy/role targets with explicit expected availability', () => {
    const input = fixture(9, 2); const first = input.futureSegments[0];
    input.futureSegments = [
      { ...first, endMs: 600_000, availablePlayerIds: first.availablePlayerIds.filter(id => id !== 'p2'), goalkeeperPolicy: { kind: 'fixed', playerId: 'p1' } },
      { ...first, startMs: 600_000, availabilityBasis: 'expected' }, input.futureSegments[1],
    ];
    const result = planMatch(input); expectFair(result);
    expect(rationalToNumber(result.players.find(player => player.playerId === 'p1')!.goalkeeperTarget)).toBe(1_800_000);
    expect(rationalToNumber(result.players.find(player => player.playerId === 'p2')!.goalkeeperTarget)).toBe(1_200_000);
  });
  it('MT08: goalkeeper-role equality cannot substitute for common total-minute bands', () => {
    const input = fixture(9, 2); input.players[0].eligiblePositions = ['GK']; input.players[1].eligiblePositions = ['GK'];
    const result = planMatch(input); expect(result.status).toBe('infeasible'); expect(result.proof?.kind).toBe('insufficient_opportunity');
    expect(result.proof?.detail).toContain('goalkeeper duties alone');
  });
  it('MT30: rejects an avoidable40/10 keeper split even when every total-minute band passes', () => {
    const input = fixture(9, 2);
    const bench = [['p2', 'p3'], ['p2', 'p4'], ['p3', 'p5'], ['p4', 'p6'], ['p5', 'p7'], ['p6', 'p8'], ['p7', 'p9'], ['p8', 'p9'], ['p1', 'p3'], ['p1', 'p4']];
    const schedule = bench.map((off, index) => {
      const keeper = index < 8 ? 'p1' : 'p2';
      const on = [keeper, ...input.players.map(player => player.id).filter(id => id !== keeper && !off.includes(id))];
      return { startMs: index * 300_000, endMs: (index + 1) * 300_000, half: (index < 5 ? 1 : 2) as 1 | 2, lineup: input.slots.map((slot, slotIndex) => ({ ...slot, playerId: on[slotIndex] })), requiresConfirmation: true as const };
    });
    const validation = validatePlannerSchedule(input, schedule);
    expect(validation.legal).toBe(true); expect(validation.allWithinBands).toBe(true); expect(validation.equalKeeperDuties).toBe(false);
  });
  it('missing historical evidence and unapproved under-strength play remain undecided, not mathematical impossibility', () => {
    const unknown = fixture(); unknown.nowMs = 1000; expect(planMatch(unknown).status).toBe('indeterminate'); expect(planMatch(unknown).proof).toBeNull();
    const short = fixture(6); expect(planMatch(short).status).toBe('indeterminate');
  });
  it('same fixed inputs/seed yield identical output and changing seed only resolves deterministic ties', () => {
    const input = fixture(); expect(planMatch(input)).toEqual(planMatch(structuredClone(input)));
    const alternate = { ...input, seed: 'roma-another-fixture' }; expectFair(planMatch(alternate));
  });
  it('5 through11 pitch places use distinct slots including repeated position types', () => {
    for (let capacity = 5; capacity <= 11; capacity++) {
      const input = fixture(capacity + 2, 1, 3_000_000, capacity); const result = planMatch(input); expectFair(result);
      expect(result.schedule.every(slice => new Set(slice.lineup.map(item => item.slotId)).size === capacity)).toBe(true);
    }
  });
  it('position eligibility is hard; preferences never grant willingness or keeper cover', () => {
    const input = fixture(); input.players.forEach(player => { player.eligiblePositions = ['GK', 'CM']; });
    const result = planMatch(input); expect(result.status).toBe('infeasible'); expect(result.proof?.kind).toBe('position_capacity');
    const missing = fixture(); missing.futureSegments[0].goalkeeperPolicy = { kind: 'shared', eligibleKeeperIds: [] };
    expect(planMatch(missing).proof?.kind).toBe('missing_keeper');
  });
  it('locks and actual-history excess have specific proofs; no history is altered', () => {
    const input = fixture(); input.locks = [
      { playerId: 'p2', slotId: 'slot-1', startMs: 0, endMs: 3_000_000 },
      { playerId: 'p3', slotId: 'slot-1', startMs: 0, endMs: 3_000_000 },
    ];
    expect(planMatch(input).proof?.kind).toBe('position_capacity');
    const excess = fixture(); excess.nowMs = 2_000_000;
    excess.actual.p2.playingMs = 2_000_000;
    excess.pastTargetSegments = [{ durationMs: 2_000_000, availablePlayerIds: excess.players.map(player => player.id), fixedKeeperId: 'p1', pitchPlaces: 7, keeperIds: ['p1'] }];
    excess.actual.p1 = { playingMs: 2_000_000, goalkeeperMs: 2_000_000 };
    excess.futureSegments = [{ ...excess.futureSegments[1], startMs: 2_000_000, halfStartMs: 1_500_000, endMs: 2_100_000 }];
    const before = structuredClone(excess.actual); expect(planMatch(excess).proof?.kind).toBe('past_excess'); expect(excess.actual).toEqual(before);
  });
  it('fractional-second keeper targets use the exact same acceptance bounds for proofs and validation', () => {
    const input = fixture(5, 2, 3200, 5); input.nowMs = 2400;
    input.actual = Object.fromEntries(input.players.map(player => [player.id, { playingMs: 2400, goalkeeperMs: player.id === 'p2' ? 2400 : 0 }]));
    input.currentLineup = input.slots.map((slot, index) => ({ ...slot, playerId: index === 0 ? 'p2' : index === 1 ? 'p1' : `p${index + 1}` }));
    input.pastTargetSegments = [{ durationMs: 2400, availablePlayerIds: input.players.map(player => player.id), pitchPlaces: 5, fixedKeeperId: null, keeperIds: ['p1', 'p2'] }];
    input.futureSegments = [{ ...input.futureSegments[1], startMs: 2400 }];
    const result = planMatch(input); expect(result.status).not.toBe('infeasible'); expectFair(result);
    expect(result.players.find(player => player.playerId === 'p2')!.projectedGoalkeeperMs).toBe(2400);
  });
  it('zero/limited solver budget means incomplete, never a false impossibility proof', () => {
    const input = fixture(); input.settings.maxWork = 0;
    const result = planMatch(input); expect(result.status).toBe('indeterminate'); expect(result.proof).toBeNull(); expect(result.diagnostics.budgetExhausted).toBe(true);
    input.settings.maxWork = 20; expect(planMatch(input).status).toBe('indeterminate');
  });
  it('independent validation rejects unavailable duplicate slots and avoids rounding target bands', () => {
    const input = fixture(); const result = planMatch(input); expectFair(result);
    const broken = structuredClone(result.schedule); broken[0].lineup[1] = { ...broken[0].lineup[0] };
    expect(validatePlannerSchedule(input, broken).legal).toBe(false);
  });
});

const alertPlan = { planId: 'plan', planVersion: 1, sourceRevision: 4, dueMatchActiveMs: 120_000 };
const alertInput = { plan: alertPlan, activeMs: 0, sourceRevision: 4, status: 'running' as const, hasControl: true, timeCertain: true, resuming: false, previous: null };
describe('ME60 current-plan alert revision/cancellation', () => {
  it('schedules90/60/30/0 only for the current plan and fires crossed thresholds once', () => {
    const initial = updatePlanAlerts(alertInput);
    expect(initial.schedule.map(item => item.thresholdSeconds)).toEqual([90, 60, 30, 0]);
    const first = updatePlanAlerts({ ...alertInput, activeMs: 30_001, previous: initial.state }); expect(first.fireNow).toEqual([90]);
    expect(updatePlanAlerts({ ...alertInput, activeMs: 30_100, previous: first.state }).fireNow).toEqual([]);
  });
  it('replan cancels old schedules and does not replay missed warning thresholds', () => {
    const previous = updatePlanAlerts(alertInput);
    const revised = updatePlanAlerts({ ...alertInput, activeMs: 75_000, plan: { ...alertPlan, planVersion: 2 }, previous: previous.state });
    expect(revised.cancelPrevious).toBe(true); expect(revised.fireNow).toEqual([]); expect(revised.schedule.map(item => item.thresholdSeconds)).toEqual([30, 0]);
  });
  it('a delayed rendering tick emits the single current warning rather than a burst of missed thresholds', () => {
    const initial = updatePlanAlerts(alertInput);
    const overdue = updatePlanAlerts({ ...alertInput, activeMs: 130_000, previous: initial.state }); expect(overdue.fireNow).toEqual([0]);
    const late = updatePlanAlerts({ ...alertInput, activeMs: 95_000, previous: initial.state }); expect(late.fireNow).toEqual([30]);
  });
  it('pause/halftime/terminal/control loss/uncertain clock cancel; resume gives one current due warning', () => {
    const initial = updatePlanAlerts(alertInput);
    for (const status of ['paused', 'half_time', 'terminal'] as const) expect(updatePlanAlerts({ ...alertInput, status, previous: initial.state }).schedule).toEqual([]);
    expect(updatePlanAlerts({ ...alertInput, hasControl: false }).cancelPrevious).toBe(true);
    expect(updatePlanAlerts({ ...alertInput, timeCertain: false }).schedule).toEqual([]);
    const resumed = updatePlanAlerts({ ...alertInput, activeMs: 130_000, resuming: true, previous: initial.state });
    expect(resumed.fireNow).toEqual([0]); expect(resumed.visual).toBe('overdue');
    expect(updatePlanAlerts({ ...alertInput, activeMs: 140_000, previous: resumed.state }).fireNow).toEqual([]);
  });
});
it('score-aware mode changes only at a caller decision and respects explicit return policy', () => {
  const input = { previousMode: 'normal' as const, ourScore: 5, oppositionScore: 1, leadThreshold: 4, returnToNormal: true, manualReset: false };
  expect(selectPositionMode(input)).toBe('adventurous');
  expect(selectPositionMode({ ...input, previousMode: 'adventurous', ourScore: 4 })).toBe('normal');
  expect(selectPositionMode({ ...input, previousMode: 'adventurous', ourScore: 4, returnToNormal: false })).toBe('adventurous');
});


it('sticky adventurous mode never transfers to another match at0–0', () => {
  const options = { ourScore: 0, oppositionScore: 0, leadThreshold: 4, returnToNormal: false, manualReset: false };
  expect(selectMatchPositionMode({ matchId: 'old-fixture', mode: 'adventurous' }, { ...options, matchId: 'new-fixture' }).mode).toBe('normal');
  expect(selectMatchPositionMode({ matchId: 'old-fixture', mode: 'adventurous' }, { ...options, matchId: 'old-fixture' }).mode).toBe('adventurous');
});
