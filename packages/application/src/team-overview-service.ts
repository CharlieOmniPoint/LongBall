import type { PreparationState } from './preparation';
import type { MatchState } from '../../domain/src';
import type { TeamOverviewGame } from './team-overview';
import { fixtureWasDeleted } from './fixture-management';

export interface TeamOverviewDto {
  kind: 'team-overview'; teamId: string; seasonId: string;
  team: { name: string; ageGroup: string; clubName: string; seasonLabel: string };
  games: TeamOverviewGame[];
}
const active = new Set(['first_half_running', 'first_half_paused', 'half_time', 'second_half_running', 'second_half_paused']);
/** Server-only source projection: no squad, attendance, feedback or scores enter this overview. */
export function projectTeamOverview(preparation: PreparationState, accepted: readonly MatchState[], seasonId: string): TeamOverviewDto {
  const games = new Map<string, TeamOverviewGame>();
  for (const fixture of preparation.fixtures.filter(item => item.seasonId === seasonId && !fixtureWasDeleted(preparation, item.id))) games.set(fixture.id, { id: fixture.id, opponent: fixture.opponent, playedDate: fixture.playedDate, kickoff: fixture.kickoff, venue: fixture.venue || null, status: fixture.status, active: false });
  for (const state of accepted) {
    const id = state.config.matchId;
    if (fixtureWasDeleted(preparation, id)) continue;
    const current = games.get(id), fixture = state.config.fixture;
    if (current && ['cancelled', 'postponed'].includes(current.status)) continue;
    if (!current && (fixture?.teamId !== preparation.team.id || fixture.seasonId !== seasonId)) continue;
    games.set(id, { id, opponent: current?.opponent ?? fixture?.opponent ?? 'Opponent to confirm', playedDate: current?.playedDate ?? fixture?.playedDate ?? '', kickoff: current ? current.kickoff ?? null : fixture?.kickoff ?? null, venue: current?.venue ?? null, status: state.status, active: active.has(state.status) });
  }
  return { kind: 'team-overview', teamId: preparation.team.id, seasonId, team: { name: preparation.team.name, ageGroup: preparation.team.ageGroup, clubName: preparation.club.name, seasonLabel: preparation.seasons.find(item => item.id === seasonId)?.label ?? seasonId }, games: [...games.values()].sort((left, right) => left.playedDate.localeCompare(right.playedDate) || left.id.localeCompare(right.id)) };
}
export function assertTeamOverviewDto(value: unknown, scope: { teamId: string; seasonId: string }): asserts value is TeamOverviewDto {
  const object = (item: unknown): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item));
  const keys = (item: Record<string, unknown>, names: readonly string[]) => Object.keys(item).length === names.length && Object.keys(item).every(key => names.includes(key));
  const text = (item: unknown, maximum = 200) => typeof item === 'string' && item.length <= maximum && !/[\u0000-\u001f\u007f]/.test(item);
  const error = () => { throw new Error('The team overview differs from its current scope or contains unsupported private fields.'); };
  if (!object(value) || !keys(value, ['kind', 'teamId', 'seasonId', 'team', 'games']) || value.kind !== 'team-overview' || value.teamId !== scope.teamId || value.seasonId !== scope.seasonId || !object(value.team) || !keys(value.team, ['name', 'ageGroup', 'clubName', 'seasonLabel']) || !Object.values(value.team).every(item => text(item)) || !Array.isArray(value.games)) return error();
  const ids = new Set<string>(), statuses = ['scheduled', 'postponed', 'cancelled', 'preparation', ...active, 'completed', 'abandoned'];
  for (const game of value.games) {
    if (!object(game) || !keys(game, ['id', 'opponent', 'playedDate', 'kickoff', 'venue', 'status', 'active']) || typeof game.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,150}$/.test(game.id) || ids.has(game.id) || !text(game.opponent) || typeof game.playedDate !== 'string' || game.playedDate !== '' && (!/^\d{4}-\d{2}-\d{2}$/.test(game.playedDate) || !Number.isFinite(Date.parse(game.playedDate)) || new Date(game.playedDate).toISOString().slice(0, 10) !== game.playedDate) || !(game.kickoff === null || typeof game.kickoff === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(game.kickoff)) || !(game.venue === null || text(game.venue, 1000)) || !statuses.includes(String(game.status)) || typeof game.active !== 'boolean' || game.active !== active.has(String(game.status))) return error();
    ids.add(game.id);
  }
}
