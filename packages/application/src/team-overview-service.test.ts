import { describe, expect, it } from 'vitest';
import { createPreparationState, prepareFixtureSnapshot } from './preparation';
import { createMatch } from '../../domain/src';
import { fixtureMatchConfig } from './application';
import { assertTeamOverviewDto, projectTeamOverview } from './team-overview-service';

describe('safe team overview projection', () => {
  it('preserves dotted and colon fixture identities accepted by preparation and CSV imports', () => {
    const preparation = createPreparationState({ demoScenario: true });
    const fixture = { ...preparation.fixtures[0], id: 'csv.fixture:2026-27.01' };
    preparation.fixtures = [fixture];
    const canonical = createMatch(fixtureMatchConfig(preparation, prepareFixtureSnapshot(preparation, fixture.id)));
    const overview = projectTeamOverview(preparation, [canonical], preparation.activeSeasonId);
    expect(overview.games).toHaveLength(1);
    expect(overview.games[0].id).toBe(fixture.id);
    expect(() => assertTeamOverviewDto(overview, { teamId: preparation.team.id, seasonId: preparation.activeSeasonId })).not.toThrow();
    for (const invalid of ['fixture/other', 'fixture?query', 'fixture with space']) {
      expect(() => assertTeamOverviewDto({ ...overview, games: [{ ...overview.games[0], id: invalid }] }, { teamId: preparation.team.id, seasonId: preparation.activeSeasonId })).toThrow();
    }
  });
  it('includes an unprepared fixture without disclosing roster or replies, and uses accepted status only', () => {
    const preparation = createPreparationState({ demoScenario: true });
    const canonical = createMatch(fixtureMatchConfig(preparation, prepareFixtureSnapshot(preparation, preparation.fixtures[0].id)));
    const overview = projectTeamOverview(preparation, [canonical], preparation.activeSeasonId);
    expect(overview.games).toHaveLength(4);
    expect(overview.games.find(game => game.id === preparation.fixtures[0].id)?.status).toBe('preparation');
    expect(overview.games.find(game => game.id === preparation.fixtures[1].id)?.status).toBe('scheduled');
    for (const privateField of ['profiles', 'attendance', 'responses', 'score', 'selectedProfileIds']) expect(JSON.stringify(overview)).not.toContain(privateField);
    expect(() => assertTeamOverviewDto(overview, { teamId: preparation.team.id, seasonId: preparation.activeSeasonId })).not.toThrow();
  });
  it('refuses private fields, wrong scope and inferred active states at the DTO boundary', () => {
    const preparation = createPreparationState(), overview = projectTeamOverview(preparation, [], preparation.activeSeasonId), scope = { teamId: preparation.team.id, seasonId: preparation.activeSeasonId };
    for (const value of [{ ...overview, teamId: 'another' }, { ...overview, profiles: [] }, { ...overview, games: [{ ...overview.games[0], score: null }] }, { ...overview, games: [{ ...overview.games[0], active: true }] }]) expect(() => assertTeamOverviewDto(value, scope)).toThrow();
  });
});
