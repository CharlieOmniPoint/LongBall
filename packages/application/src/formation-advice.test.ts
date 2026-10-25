import { describe, expect, it } from 'vitest';
import type { PlayerProfile, PreparationFormation } from './preparation';
import { assessFormation, recommendFormations } from './formation-advice';
import { formationFromPattern } from './formation-pattern';

const player = (id: string, preferences: string[], eligiblePositions = preferences): PlayerProfile => ({ id: `profile-${id}`, playerId: id, seasonId: 'season', displayName: id, initials: id.toUpperCase(), shirtNumber: null, foot: 'not_recorded', preferences, eligiblePositions, active: true });
const formation = (pattern: string): PreparationFormation => ({ ...formationFromPattern({ pattern, format: 5, id: pattern }), version: 1 });
const profiles = [player('keeper', ['GK', 'CB']), player('a', ['CB', 'ST']), player('b', ['CB', 'ST']), player('c', ['ST', 'CB']), player('d', ['ST', 'CB'])];

describe('formation position-share advice', () => {
  it('finds the formation that supports the 65/35 split rather than the first preset', () => {
    const advice = recommendFormations({ profiles, format: 5 });
    expect(advice[0].formation.name).toBe('2-2');
    expect(advice[0].feasible).toBe(true);
    expect(advice[0].targetFit).toBeCloseTo(1);
    for (const row of advice[0].players.filter(row => !row.fixedGoalkeeper)) {
      expect(row.primary).toBeCloseTo(0.65); expect(row.secondary).toBeCloseTo(0.35); expect(row.other).toBeCloseTo(0);
    }
    expect(advice[0].players.find(row => row.fixedGoalkeeper)).toMatchObject({ playingShare: 1, primary: 1, secondary: 0 });
    expect(advice[0].notes.join(' ')).toContain('sole qualifying goalkeeper');
  });
  it('uses reverse capacity edges so earlier assignments do not strand a later player', () => {
    const squad = [player('keeper', ['GK', 'ST']), player('a', ['CB', 'ST']), player('b', ['CB', 'ST']), player('c', ['CB'], ['CB']), player('d', ['ST'], ['ST'])];
    const assessed = assessFormation({ profiles: squad, formation: formation('2-2') });
    expect(assessed.feasible).toBe(true);
    expect(assessed.players.every(row => row.unallocatedShare < 0.0001)).toBe(true);
    expect(assessed.players.find(row => row.playerId === 'c')?.positions.CB).toBeCloseTo(1);
  });
  it('does not place anyone in an unapproved position to make advice appear feasible', () => {
    const assessed = assessFormation({ profiles, formation: formation('2-1-1') });
    expect(assessed.feasible).toBe(false);
    expect(assessed.shortfall).toBeGreaterThan(0);
    for (const row of assessed.players) {
      const profile = profiles.find(profile => profile.playerId === row.playerId)!;
      expect(Object.keys(row.positions).every(position => profile.eligiblePositions.includes(position))).toBe(true);
    }
    expect(assessed.notes.join(' ')).toContain('no unapproved position');
  });
  it('keeps other approved positions available when core roles cannot cover the shape', () => {
    const squad = profiles.map(profile => ({ ...profile, eligiblePositions: [...profile.eligiblePositions, 'CM'] }));
    const assessed = assessFormation({ profiles: squad, formation: formation('2-1-1') });
    expect(assessed.feasible).toBe(true);
    expect(assessed.players.some(row => row.other > 0)).toBe(true);
    expect(assessed.targetFit).toBeLessThan(1);
  });
  it('refuses goalkeeper third choice and gives a truthful missing-cover result', () => {
    const noKeeper = profiles.map(profile => ({ ...profile, preferences: profile.playerId === 'keeper' ? ['CB', 'ST', 'GK'] : profile.preferences, eligiblePositions: ['CB', 'ST', 'GK'] }));
    const assessed = assessFormation({ profiles: noKeeper, formation: formation('2-2') });
    expect(assessed.feasible).toBe(false);
    expect(assessed.notes.join(' ')).toContain('No available player has goalkeeper as an approved first or second position');
    expect(assessed.players.every(row => !row.positions.GK)).toBe(true);
  });
  it('shares equal-time capacity over a larger squad and reports missing secondary preferences', () => {
    const squad = [...profiles, player('e', ['CB'], ['CB', 'ST'])];
    const assessed = assessFormation({ profiles: squad, formation: formation('2-2') });
    expect(assessed.feasible).toBe(true);
    expect(assessed.players.find(row => row.playerId === 'e')?.playingShare).toBeCloseTo(4 / 5);
    expect(assessed.notes.join(' ')).toContain('no approved secondary');
    for (const row of assessed.players) expect(Object.values(row.positions).reduce((sum, value) => sum + value, 0)).toBeCloseTo(row.playingShare);
    expect(assessed.players.reduce((sum, row) => sum + row.playingShare, 0)).toBeCloseTo(5);
  });
  it('has deterministic ties and does not mutate profiles or saved formations', () => {
    const input = { profiles, formations: [formation('2-2')], format: 5 }, before = JSON.stringify(input);
    expect(recommendFormations(input)).toEqual(recommendFormations(input));
    expect(JSON.stringify(input)).toBe(before);
  });
  it('excludes inactive-position candidates and refuses a too-small or duplicate squad', () => {
    expect(recommendFormations({ profiles, format: 5, activePositions: ['GK', 'CB', 'ST'] }).every(row => row.formation.slots.every(slot => ['GK', 'CB', 'ST'].includes(slot.position)))).toBe(true);
    expect(() => assessFormation({ profiles: profiles.slice(0, 4), formation: formation('2-2') })).toThrow('at least one player');
    expect(() => assessFormation({ profiles: [...profiles, profiles[0]], formation: formation('2-2') })).toThrow('unique');
  });
  it('covers the full import-size boundary without dropping player-time demand', () => {
    const squad = [profiles[0], ...Array.from({ length: 199 }, (_, index) => player(`outfield-${String(index).padStart(3, '0')}`, index % 2 ? ['CB', 'ST'] : ['ST', 'CB']))];
    const assessed = assessFormation({ profiles: squad, formation: formation('2-2') });
    expect(assessed.feasible).toBe(true);
    expect(assessed.players).toHaveLength(200);
    expect(assessed.players.reduce((sum, row) => sum + Object.values(row.positions).reduce((subtotal, value) => subtotal + value, 0), 0)).toBeCloseTo(5);
    expect(assessed.players.every(row => row.unallocatedShare < 0.0001)).toBe(true);
  });
});
