import { describe, expect, it } from 'vitest';
import { assertSyntheticFixture, romaFixture } from './index';

describe('M0 fixture import boundary', () => {
  it('accepts the supplied generated seven-a-side scenario', () => {
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

  it('rejects a renamed identity outside the generated seed', () => {
    const invalid = structuredClone(romaFixture);
    invalid.players[0].displayName = 'Actual Person';
    expect(() => assertSyntheticFixture(invalid)).toThrow(/generated sample/);
  });

  it('rejects duplicate sample events and opposition outside the generated club schedule', () => {
    const duplicate = structuredClone(romaFixture); duplicate.training[0].id = duplicate.fixtures[0].id;
    expect(() => assertSyntheticFixture(duplicate)).toThrow(/distinct identities/);
    const unknown = structuredClone(romaFixture); unknown.fixtures[0].opponent = 'Unlisted opposition';
    expect(() => assertSyntheticFixture(unknown)).toThrow(/known opponent/);
  });

  it('keeps profile-only details out of match players and rejects orphaned or duplicate profile joins', () => {
    for (const player of romaFixture.players) expect(Object.keys(player).sort()).toEqual(['available', 'displayName', 'goalkeeperChoice', 'id']);
    const orphan = structuredClone(romaFixture); orphan.profiles[0].playerId = 'synthetic-player-missing';
    expect(() => assertSyntheticFixture(orphan)).toThrow(/unique player join/);
    const duplicate = structuredClone(romaFixture); duplicate.profiles[1].playerId = duplicate.profiles[0].playerId;
    expect(() => assertSyntheticFixture(duplicate)).toThrow(/unique player join/);
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
