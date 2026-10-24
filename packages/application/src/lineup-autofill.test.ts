import { describe, expect, it } from 'vitest';
import { createMatch, reduceMatch, validateLineup } from '@longball/domain';
import { autoFillLineup, autoFillMatchLineup, type AutoFillPlayer } from './lineup-autofill';
import { createPreparationState, prepareFixtureSnapshot } from './preparation';
import { fixtureMatchConfig } from './application';

const player = (id: string, preferences: string[], eligiblePositions = preferences, available = true): AutoFillPlayer => ({ id, preferences, eligiblePositions, available, goalkeeperChoice: preferences.indexOf('GK') + 1 });
const slots = [{ slotId: 'gk', position: 'GK' }, { slotId: 'back', position: 'CB' }, { slotId: 'front', position: 'ST' }];
const keeper = player('keeper', ['GK', 'CB', 'ST'], ['GK']);

describe('complete available-player lineup matching', () => {
  it('finds a complete assignment when a greedy preferred choice would strand a place', () => {
    const result = autoFillLineup({ slots, players: [keeper, player('a-flexible', ['CB', 'ST']), player('b-defender', ['CB'])] });
    expect(result.status).toBe('complete');
    if (result.status === 'complete') expect(result.allocations).toEqual([{ slotId: 'gk', position: 'GK', playerId: 'keeper' }, { slotId: 'back', position: 'CB', playerId: 'b-defender' }, { slotId: 'front', position: 'ST', playerId: 'a-flexible' }]);
  });
  it('globally prefers core positions and is deterministic when players arrive in another order', () => {
    const players = [keeper, player('a-back', ['CB', 'ST']), player('b-front', ['ST', 'CB']), player('c-cover', ['ST', 'CB'])];
    const first = autoFillLineup({ slots, players });
    expect(first).toEqual(autoFillLineup({ slots, players: [...players].reverse() }));
    expect(first).toMatchObject({ status: 'complete', preferenceCost: 0, allocations: [{ playerId: 'keeper' }, { playerId: 'a-back' }, { playerId: 'b-front' }] });
  });
  it('uses manager-approved custom positions without treating a preference as eligibility', () => {
    const custom = [{ slotId: 'gk', position: 'GK' }, { slotId: 'holder', position: 'DM' }];
    const result = autoFillLineup({ slots: custom, players: [keeper, player('wrong', ['DM'], ['ST']), player('approved', ['DM'], ['DM'])] });
    expect(result).toMatchObject({ status: 'complete', allocations: [{ playerId: 'keeper' }, { playerId: 'approved' }] });
  });
  it('requires available first/second preference keeper cover and honors the fixed keeper', () => {
    expect(autoFillLineup({ slots: [{ slotId: 'gk', position: 'GK' }], players: [player('third', ['CB', 'ST', 'GK'])] }).status).toBe('infeasible');
    expect(autoFillLineup({ slots: [{ slotId: 'gk', position: 'GK' }], players: [{ ...keeper, available: false }] }).status).toBe('infeasible');
    expect(autoFillLineup({ slots: [{ slotId: 'gk', position: 'GK' }], players: [keeper, player('other', ['CB', 'GK'], ['GK'])], fixedKeeperId: 'other' })).toMatchObject({ status: 'complete', allocations: [{ playerId: 'other' }] });
  });
  it('reports infeasible instead of returning a partial or duplicated lineup and never changes availability', () => {
    const players = [keeper, player('only-back', ['CB']), player('unavailable-front', ['ST'], ['ST'], false)], before = structuredClone(players);
    expect(autoFillLineup({ slots, players })).toMatchObject({ status: 'infeasible', unfilledSlotIds: ['gk', 'back', 'front'] });
    expect(players).toEqual(before);
    expect(autoFillLineup({ slots, players: [keeper, player('same', ['CB']), player('same', ['ST'])] }).status).toBe('infeasible');
    expect(autoFillLineup({ slots: [...slots, slots[1]], players }).status).toBe('infeasible');
  });
  it('fills an eleven-place squad from a larger pool without duplicate players', () => {
    const largeSlots = [{ slotId: 'gk', position: 'GK' }, ...Array.from({ length: 10 }, (_, index) => ({ slotId: `out-${index}`, position: 'CM' }))];
    const result = autoFillLineup({ slots: largeSlots, players: [keeper, ...Array.from({ length: 30 }, (_, index) => player(`out-${String(index).padStart(2, '0')}`, ['CM'], ['CM']))] });
    expect(result.status).toBe('complete');
    if (result.status === 'complete') expect(new Set(result.allocations.map(row => row.playerId)).size).toBe(11);
  });
  it('uses actual match check-in rather than available replies and opens no accepted lineup itself', () => {
    const preparation = createPreparationState({ demoScenario: true }), fixture = preparation.fixtures.find(item => item.id === 'synthetic-roma-maple-2026-10-24')!;
    expect(Object.values(fixture.responses).filter(response => response === 'available')).toHaveLength(9);
    let match = createMatch(fixtureMatchConfig(preparation, prepareFixtureSnapshot(preparation, fixture.id)));
    expect(autoFillMatchLineup(match).status).toBe('infeasible');
    const sample = { monotonicMs: 0, wallTimeMs: 1_800_000_000_000, sessionId: 'autofill-check-in' };
    for (const playerId of match.config.selectedPlayerIds) match = reduceMatch(match, { id: `present-${playerId}`, type: 'attendance.recorded', playerId, status: 'present', sample });
    const before = structuredClone(match), result = autoFillMatchLineup(match);
    expect(result.status).toBe('complete');
    if (result.status === 'complete') expect(validateLineup(match, result.allocations)).toEqual([]);
    expect(match).toEqual(before); expect(match.stagedLineup).toEqual([]); expect(match.half).toBe(0);
    match = reduceMatch(match, { id: 'keeper-absent', type: 'attendance.recorded', playerId: match.config.fixedKeeperId!, status: 'absent', sample });
    expect(autoFillMatchLineup(match).status).toBe('infeasible');
  });
});
