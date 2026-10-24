import { describe, expect, it } from 'vitest';
import { createPreparationState, defaultFormation, prepareFixtureSnapshot, reducePreparation } from './preparation';
import { formationFromPattern, parseFormationPattern, patternFromFormation, TRADITIONAL_FORMATIONS } from './formation-pattern';

describe('traditional formation notation', () => {
  it('omits the goalkeeper and accepts common typed separators', () => {
    expect(parseFormationPattern(' 4 – 4 – 2 ', 11)).toEqual([4, 4, 2]);
    expect(parseFormationPattern('3-2-1', 7)).toEqual([3, 2, 1]);
    expect(parseFormationPattern('4-1-2-1-2', 11)).toEqual([4, 1, 2, 1, 2]);
  });
  it.each(['4-4-2', '1-3-2-1', '3-0-3', '-3-2-1', '3--2-1', '3/2/1', '3.5-1.5-1', '03-2-1', '6', '1-1-1-1-1-1'])('rejects invalid seven-a-side input %s', pattern => {
    expect(() => parseFormationPattern(pattern, 7)).toThrow();
  });
  it('accepts every offered preset, with one goalkeeper and the stated outfield bands', () => {
    for (const [format, patterns] of Object.entries(TRADITIONAL_FORMATIONS)) {
      for (const pattern of patterns) {
        const formation = formationFromPattern({ pattern, format: Number(format), id: 'test' });
        expect(formation.slots).toHaveLength(Number(format));
        expect(formation.slots.filter(slot => slot.position === 'GK')).toHaveLength(1);
        expect(patternFromFormation(formation)).toBe(pattern);
        expect(new Set(formation.slots.map(slot => slot.id)).size).toBe(Number(format));
        for (const slot of formation.slots) {
          expect(slot.x).toBeGreaterThan(0); expect(slot.x).toBeLessThan(1);
          expect(slot.y).toBeGreaterThan(0); expect(slot.y).toBeLessThan(1);
        }
      }
    }
  });
  it('lays out defence below midfield and attack, while keeping four lines distinct', () => {
    const formation = formationFromPattern({ pattern: '4-2-3-1', format: 11, id: 'pattern' });
    const rows = [...new Set(formation.slots.filter(slot => slot.position !== 'GK').map(slot => slot.y))];
    expect(rows).toHaveLength(4);
    expect(rows[0]).toBeGreaterThan(rows[1]); expect(rows[1]).toBeGreaterThan(rows[2]); expect(rows[2]).toBeGreaterThan(rows[3]);
    expect(formation.slots.filter(slot => slot.id.startsWith('line-1')).map(slot => slot.position)).toEqual(['LB', 'CB', 'CB', 'RB']);
    expect(formation.slots.filter(slot => slot.id.startsWith('line-3')).map(slot => slot.position)).toEqual(['LW', 'CM', 'RW']);
  });
  it('never silently activates a disabled team position', () => {
    expect(() => formationFromPattern({ pattern: '4-4-2', format: 11, id: 'blocked', activePositions: ['GK', 'CB', 'CM', 'LW', 'RW', 'ST'] })).toThrow('Activate LB, RB');
  });
  it('can interpret old aligned templates without changing their slots', () => {
    const old = defaultFormation(7), before = JSON.stringify(old);
    expect(patternFromFormation(old)).toBe('2-1-2-1');
    expect(JSON.stringify(old)).toBe(before);
    old.slots[0].position = 'CB';
    expect(patternFromFormation(old)).toBeNull();
  });
  it('persists a typed shape through existing revisioned commands without rewriting prepared matches', () => {
    let state = createPreparationState();
    const formation = formationFromPattern({ pattern: '3-2-1', format: 7, id: 'manager-shape' });
    const first = { id: 'save-typed-shape', expectedRevision: state.revision, type: 'formation.saved' as const, formation };
    state = reducePreparation(state, first);
    const snapshot = prepareFixtureSnapshot(state, state.fixtures[0].id, formation.id);
    const retained = JSON.stringify(snapshot);
    expect(snapshot.formation.version).toBe(1);
    expect(snapshot.formation.slots).toHaveLength(7);
    expect(reducePreparation(state, first)).toEqual(state);
    state = reducePreparation(state, { id: 'change-typed-shape', expectedRevision: state.revision, type: 'formation.saved', formation: formationFromPattern({ pattern: '2-3-1', format: 7, id: formation.id }) });
    expect(state.formations.find(item => item.id === formation.id)?.version).toBe(2);
    expect(JSON.stringify(snapshot)).toBe(retained);
    expect(() => reducePreparation(state, { ...first, id: 'fresh-stale-shape' })).toThrow();
  });
});
