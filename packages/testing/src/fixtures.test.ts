import { describe, expect, it } from 'vitest';
import { assertSyntheticFixture, romaFixture } from './index';

describe('M0 fixture import boundary', () => {
  it('accepts the supplied fictional seven-a-side scenario', () => {
    expect(() => assertSyntheticFixture(romaFixture)).not.toThrow();
  });

  it('rejects a dataset without the synthetic marker', () => {
    expect(() => assertSyntheticFixture({ ...romaFixture, synthetic: false })).toThrow(/synthetic/);
  });

  it('rejects duplicate identities before seeding local storage', () => {
    const invalid = structuredClone(romaFixture);
    invalid.players[1].id = invalid.players[0].id;
    expect(() => assertSyntheticFixture(invalid)).toThrow(/distinct/);
  });

  it('rejects personal names in the fixture seed', () => {
    const invalid = structuredClone(romaFixture);
    invalid.players[0].displayName = 'Actual Person';
    expect(() => assertSyntheticFixture(invalid)).toThrow(/fictional/);
  });

  it('rejects a scenario without an available goalkeeper', () => {
    const invalid = structuredClone(romaFixture);
    invalid.players.forEach((player) => { player.goalkeeperChoice = 0; });
    expect(() => assertSyntheticFixture(invalid)).toThrow(/goalkeeper/);
  });

  it('rejects changed half durations in the baseline fixture', () => {
    expect(() => assertSyntheticFixture({ ...romaFixture, plannedHalfDurationMs: 1_200_000 })).toThrow(/25-minute/);
  });
});
