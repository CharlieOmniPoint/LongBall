import type { Principal } from '@longball/application/access';
import type { ClubAdministrationDto } from '@longball/application/club-administration';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, maximum: number, empty = false): value is string => typeof value === 'string' && value.length <= maximum && (empty || value.trim().length > 0) && !/[\u0000-\u001f\u007f]/.test(value);
const id = (value: unknown): value is string => text(value, 150);
const rows = (value: unknown): value is Record<string, unknown>[] => Array.isArray(value) && value.length <= 20_000 && value.every(object);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 20_000 && value.every(id) && new Set(value).size === value.length;
function invalid(): never { throw new Error('The club administration response could not be verified.'); }

/** Parse inside a retained send: malformed 200 responses are unconfirmed writes, not acknowledgements. */
export function parseClubAdministrationReceipt(value: unknown, expected?: Principal['administration']): ClubAdministrationDto {
  if (!object(value) || value.kind !== 'club-administration' || !object(value.administration) || !['super', 'club'].includes(String(value.administration.level)) || !strings(value.administration.clubIds) || !rows(value.clubs) || !rows(value.teams) || !rows(value.administrators) || !rows(value.candidates)) invalid();
  const level = value.administration.level as 'super' | 'club', clubIds = [...value.administration.clubIds];
  if (level === 'club' && !clubIds.length || expected?.level === 'club' && (level !== 'club' || clubIds.some(club => !expected.clubIds.includes(club)))) invalid();
  const clubs: ClubAdministrationDto['clubs'] = [], knownClubs = new Set<string>();
  for (const club of value.clubs) {
    if (!id(club.id) || !text(club.name, 100) || knownClubs.has(club.id) || level === 'club' && !clubIds.includes(club.id)) invalid();
    knownClubs.add(club.id); clubs.push({ id: club.id, name: club.name });
  }
  const teams: ClubAdministrationDto['teams'] = [], teamSeasons = new Set<string>(), teamClubs = new Map<string, string>();
  for (const team of value.teams) {
    if (!id(team.id) || !id(team.clubId) || !knownClubs.has(team.clubId) || !id(team.seasonId) || !text(team.name, 100) || !text(team.ageGroup, 40) || !text(team.seasonLabel, 120) || !text(team.leagueName, 1000, true)) invalid();
    const key = JSON.stringify([team.id, team.seasonId]);
    if (teamSeasons.has(key) || teamClubs.has(team.id) && teamClubs.get(team.id) !== team.clubId) invalid();
    teamSeasons.add(key); teamClubs.set(team.id, team.clubId);
    teams.push({ id: team.id, clubId: team.clubId, name: team.name, ageGroup: team.ageGroup, seasonId: team.seasonId, seasonLabel: team.seasonLabel, leagueName: team.leagueName });
  }
  const administrators: ClubAdministrationDto['administrators'] = [], grants = new Set<string>();
  for (const grant of value.administrators) {
    if (!id(grant.accountId) || !['super', 'club'].includes(String(grant.level)) || (grant.level === 'super' ? grant.clubId !== null || level !== 'super' : !id(grant.clubId) || !knownClubs.has(grant.clubId))) invalid();
    const key = JSON.stringify([grant.accountId, grant.level, grant.clubId]); if (grants.has(key)) invalid(); grants.add(key);
    administrators.push({ accountId: grant.accountId, level: grant.level as 'super' | 'club', clubId: grant.clubId as string | null });
  }
  if (level !== 'super' && value.candidates.length) invalid();
  const candidates: ClubAdministrationDto['candidates'] = [], adults = new Set<string>();
  for (const candidate of value.candidates) {
    if (!id(candidate.accountId) || !text(candidate.label, 1000) || adults.has(candidate.accountId)) invalid();
    adults.add(candidate.accountId); candidates.push({ accountId: candidate.accountId, label: candidate.label });
  }
  return { kind: 'club-administration', administration: { level, clubIds }, clubs, teams, administrators, candidates };
}
