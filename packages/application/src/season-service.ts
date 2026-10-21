import { AccessError, assertAdultAuthority, assertTeamRole, type Membership, type Principal } from './access';
import type { CommunityState } from './community';
import { reducePreparation, seasonBounds, type PreparationCommand, type PreparationState } from './preparation';
import type { RecordsState } from './records';

/** Read from verified server account rows, never from a submitted role/identity payload. */
export interface SeasonAccountEvidence {
  accountId: string;
  label: string;
  status: 'active' | 'disabled';
  identityClassification: Principal['identityClassification'];
  adultVerified: boolean;
  strongAuthEnrolled: boolean;
}
export interface SeasonRolloverCommand {
  id: string;
  type: 'season.rolled_over';
  expectedPreparationRevision: number;
  idForSeason: string;
  startYear: number;
  copyPlayers: boolean;
  managerAccountIds: string[];
  administratorAccountIds: string[];
  playerAssignments: { accountId: string; playerId: string }[];
  confirmSpectatorRenewal: true;
}
export interface SeasonRolloverContext {
  principal: Principal;
  memberships: Membership[];
  accounts: SeasonAccountEvidence[];
  preparation: PreparationState;
  records: RecordsState;
  community: CommunityState;
  /** Authoritative destination catalogue gathered inside the team's assignment transaction. */
  existingSeasons: { teamId: string; id: string; startYear: number }[];
  nowMs: number;
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const fail = (message: string, code = 'INVALID_REQUEST', status = 422): never => { throw new AccessError(code, status, message); };
function requireThat(value: unknown, message: string): asserts value { if (!value) fail(message); }
function validId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value); }
function current(item: Membership, nowMs: number): boolean { return item.revokedAt == null && (item.expiresAt == null || item.expiresAt > nowMs); }
function source(context: SeasonRolloverContext) {
  const { preparation, records } = context;
  requireThat(Number.isSafeInteger(context.nowMs) && context.nowMs >= 0, 'A trusted server time is required.');
  requireThat(preparation.team.id === records.teamId && preparation.club.id === records.clubId, 'Preparation and reports must belong to the same club and team.');
  const season = preparation.seasons.find(item => item.id === records.seasonId);
  requireThat(season, 'The source season is unavailable.');
  requireThat(context.community.seasons.some(item => item.teamId === records.teamId && item.id === season.id), 'The source community scope is inconsistent.');
  return season;
}
function visibleAccounts(context: SeasonRolloverContext) {
  const season = source(context);
  const permitted = new Set(context.memberships.filter(item => item.teamId === context.records.teamId && item.seasonId === season.id && current(item, context.nowMs)).map(item => item.accountId));
  return context.accounts.filter(account => permitted.has(account.accountId) && account.status === 'active');
}
function verifiedAdult(account: SeasonAccountEvidence): boolean { return account.status === 'active' && account.identityClassification === 'adult_individual' && account.adultVerified && account.strongAuthEnrolled; }
function activeManagers(context: SeasonRolloverContext): string[] {
  return [...new Set(context.memberships.filter(item => item.teamId === context.records.teamId && item.role === 'manager' && current(item, context.nowMs) && context.accounts.find(account => account.accountId === item.accountId)?.status !== 'disabled').map(item => item.accountId))];
}
/** September 1 midnight in Europe/London, evaluated using the runtime timezone database. */
export function seasonAccessEndsAtMs(startYear: number): number {
  const midnightUtc = Date.UTC(startYear + 1, 8, 1);
  const offset = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'shortOffset' }).formatToParts(midnightUtc).find(part => part.type === 'timeZoneName')?.value;
  const match = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(offset ?? '');
  requireThat(match, 'The season boundary timezone is unavailable.');
  const minutes = match[1] ? (match[1] === '+' ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3] ?? 0)) : 0;
  return midnightUtc - minutes * 60_000;
}
export function seasonRolloverOptions(context: SeasonRolloverContext) {
  const season = source(context), { principal, memberships, records, preparation, nowMs } = context;
  assertTeamRole(principal, memberships, records.teamId, season.id, ['administrator', 'manager'], nowMs);
  assertAdultAuthority(principal, false, nowMs);
  const accounts = visibleAccounts(context);
  const currentRows = memberships.filter(item => item.teamId === records.teamId && item.seasonId === season.id && current(item, nowMs));
  const administrator = currentRows.some(item => item.accountId === principal.accountId && item.role === 'administrator');
  const existingNextSeasonId = context.existingSeasons.find(item => item.teamId === records.teamId && item.startYear === season.startYear + 1)?.id ?? null;
  return {
    revision: preparation.revision, sourceSeasonId: season.id, sourceSeason: copy(season),
    canRollover: administrator && principal.strongAuth && !existingNextSeasonId && principal.authenticatedAt <= nowMs + 30_000 && nowMs - principal.authenticatedAt <= 300_000,
    existingNextSeasonId,
    requiredAuthority: 'administrator_with_recent_stronger_sign_in' as const,
    nextSeason: { startYear: season.startYear + 1, ...seasonBounds(season.startYear + 1) },
    activeManagerAccountIds: activeManagers(context),
    managerCandidates: accounts.filter(verifiedAdult).map(account => ({ accountId: account.accountId, label: account.label, currentManager: currentRows.some(item => item.accountId === account.accountId && item.role === 'manager'), administrator: currentRows.some(item => item.accountId === account.accountId && item.role === 'administrator') })),
    playerCandidates: currentRows.filter(item => item.role === 'player' && item.playerId && accounts.some(account => account.accountId === item.accountId)).flatMap(item => {
      const profile = preparation.profiles.find(profile => profile.seasonId === season.id && profile.playerId === item.playerId && profile.active);
      return profile ? [{ accountId: item.accountId, playerId: profile.playerId, label: profile.displayName }] : [];
    }),
    spectatorRenewal: 'individual_explicit_invitation_only' as const,
  };
}

/** Administrators can configure a team without implicitly gaining manager/private child-report access. */
export function configurationServiceView(input: { principal: Principal; memberships: Membership[]; preparation: PreparationState; seasonId: string; nowMs: number }) {
  assertTeamRole(input.principal, input.memberships, input.preparation.team.id, input.seasonId, ['administrator', 'manager'], input.nowMs);
  assertAdultAuthority(input.principal, false, input.nowMs);
  const { version, revision, club, team, activeSeasonId, seasons } = input.preparation;
  return copy({ version, revision, club, team, activeSeasonId, seasons });
}
export function applyConfigurationServiceCommand(input: { principal: Principal; memberships: Membership[]; preparation: PreparationState; seasonId: string; nowMs: number; command: PreparationCommand }): PreparationState {
  const { principal, memberships, preparation, seasonId, nowMs, command } = input;
  requireThat(command?.type === 'club.updated' || command?.type === 'team.updated', 'Configuration accepts only club or team settings.');
  assertTeamRole(principal, memberships, preparation.team.id, seasonId, command.type === 'club.updated' ? ['administrator'] : ['administrator', 'manager'], nowMs);
  assertAdultAuthority(principal, command.type === 'club.updated', nowMs);
  return reducePreparation(preparation, command);
}

/** Return only new-season documents. The caller persists this plan atomically; source documents are untouched. */
export function planSeasonRollover(context: SeasonRolloverContext & { command: SeasonRolloverCommand }) {
  const old = source(context), { principal, memberships, accounts, preparation, records, community, command, nowMs } = context;
  assertTeamRole(principal, memberships, records.teamId, old.id, ['administrator'], nowMs);
  requireThat(Number.isSafeInteger(principal.authenticatedAt) && principal.authenticatedAt >= 0, 'Verified authentication time is required.');
  assertAdultAuthority(principal, true, nowMs);
  requireThat(command?.type === 'season.rolled_over' && validId(command.id) && validId(command.idForSeason), 'Use valid command and season identifiers.');
  requireThat(command.expectedPreparationRevision === preparation.revision, 'The source preparation changed. Refresh before creating its next season.');
  requireThat(command.startYear === old.startYear + 1 && command.startYear <= 2100 && command.startYear >= 2020, 'Create the immediately following September-to-August season.');
  requireThat(command.idForSeason !== old.id && !preparation.seasons.some(item => item.id === command.idForSeason || item.startYear === command.startYear) && !memberships.some(item => item.teamId === records.teamId && item.seasonId === command.idForSeason), 'That destination season already exists.');
  requireThat(!context.existingSeasons.some(item => item.teamId === records.teamId && (item.id === command.idForSeason || item.startYear === command.startYear)), 'That destination season or season year already exists.');
  requireThat(command.confirmSpectatorRenewal === true && typeof command.copyPlayers === 'boolean', 'Acknowledge that spectators receive no automatic new-season access.');
  requireThat(Array.isArray(command.managerAccountIds) && Array.isArray(command.administratorAccountIds) && Array.isArray(command.playerAssignments), 'Explicit manager, administrator and player assignments are required.');
  requireThat(command.playerAssignments.length <= 2000 && command.playerAssignments.every(item => item && typeof item === 'object' && validId(item.accountId) && validId(item.playerId)), 'Player assignments must be a bounded list of known identities.');
  const unique = (items: string[]) => items.every(validId) && new Set(items).size === items.length;
  requireThat(command.managerAccountIds.length >= 1 && command.managerAccountIds.length <= 4 && unique(command.managerAccountIds), 'Select one to four distinct verified adult managers.');
  requireThat(command.administratorAccountIds.length >= 1 && unique(command.administratorAccountIds), 'Explicitly retain at least one current verified administrator.');
  const options = seasonRolloverOptions(context);
  for (const id of command.managerAccountIds) requireThat(options.managerCandidates.some(account => account.accountId === id), 'Each manager must be an active verified adult with stronger authentication already enrolled in this team.');
  for (const id of command.administratorAccountIds) requireThat(options.managerCandidates.some(account => account.accountId === id && account.administrator), 'Only a current verified administrator can retain administrator authority in the new season.');
  if (new Set([...activeManagers(context), ...command.managerAccountIds]).size > 4) fail('A team can have at most four active manager accounts. Revoke departed manager authority explicitly before adding another account.', 'MANAGER_LIMIT', 409);
  requireThat(new Set(command.playerAssignments.map(item => item.accountId)).size === command.playerAssignments.length && new Set(command.playerAssignments.map(item => item.playerId)).size === command.playerAssignments.length, 'Player assignments must retain one distinct known account for each player.');
  requireThat(command.copyPlayers || command.playerAssignments.length === 0, 'Copy the relevant player profiles before assigning their existing accounts.');
  for (const assignment of command.playerAssignments) requireThat(validId(assignment.accountId) && validId(assignment.playerId) && options.playerCandidates.some(item => item.accountId === assignment.accountId && item.playerId === assignment.playerId), 'New player membership must preserve the source account/player binding. Use activation for new identity links.');
  const season = { id: command.idForSeason, startYear: command.startYear, ...seasonBounds(command.startYear), spectatorRenewalRequired: true as const };
  const newMemberships: Membership[] = [
    ...command.managerAccountIds.map(accountId => ({ accountId, teamId: records.teamId, seasonId: season.id, role: 'manager' as const })),
    ...command.administratorAccountIds.map(accountId => ({ accountId, teamId: records.teamId, seasonId: season.id, role: 'administrator' as const })),
    ...command.playerAssignments.map(item => ({ ...item, teamId: records.teamId, seasonId: season.id, role: 'player' as const })),
  ];
  const sourceProfiles = preparation.profiles.filter(profile => profile.seasonId === old.id && profile.active);
  requireThat(sourceProfiles.length <= 2000 && new Set(sourceProfiles.map(profile => profile.playerId)).size === sourceProfiles.length, 'The source roster must have one distinct active profile for each player.');
  const profiles = command.copyPlayers ? sourceProfiles.map((profile, index) => ({ ...copy(profile), id: `profile-${season.id.slice(0, 60)}-${String(index + 1).padStart(4, '0')}`, seasonId: season.id })) : [];
  const nextPreparation: PreparationState = { ...copy(preparation), revision: 0, activeSeasonId: season.id, seasons: [season], profiles, fixtures: [], training: [], snapshots: [], matchPlans: [], appliedCommands: {}, audit: [{ id: command.id, revision: 0, type: 'season.created_from_explicit_assignments' }] };
  const nextRecords: RecordsState = { ...copy(records), revision: 0, seasonId: season.id, seasonLabel: season.label, startsOn: season.startDate, endsOn: season.endDate, players: profiles.map(profile => ({ id: profile.playerId, label: profile.displayName })),
    liveMatch: { matchId: '', playedDate: season.startDate, opponent: '', homeAway: 'home', fixtureClass: 'unclassified' }, results: [], trainingAttendance: [], audit: [], appliedCommands: {} };
  const assignedIds = new Set(newMemberships.map(item => item.accountId));
  const nextCommunity: CommunityState = { ...copy(community), revision: 0,
    accounts: accounts.filter(account => assignedIds.has(account.accountId)).map(account => ({ id: account.accountId, label: account.label, classification: account.identityClassification === 'child_shared' ? 'child_shared' : 'adult_individual', adultVerified: account.adultVerified })),
    memberships: newMemberships.filter(item => item.role === 'manager' || item.role === 'player').map(item => ({ accountId: item.accountId, teamId: item.teamId, seasonId: item.seasonId, role: item.role as 'manager' | 'player', ...(item.playerId ? { playerId: item.playerId } : {}), active: true })),
    seasons: [{ id: season.id, teamId: records.teamId, label: season.label, teamLabel: preparation.team.name, accessEndsAtMs: seasonAccessEndsAtMs(command.startYear) }],
    invitations: [], grants: [], matches: [], ballots: [], awards: [], photos: [], concerns: [], privacyRequests: [], appliedCommands: {},
    hiddenUploaders: community.hiddenUploaders.filter(item => assignedIds.has(item.accountId)).map(copy),
    preferences: Object.fromEntries(Object.entries(community.preferences).filter(([accountId]) => assignedIds.has(accountId)).map(([id, value]) => [id, copy(value)])),
    audit: [{ id: command.id, actorAccountId: principal.accountId, action: 'season.created_from_explicit_assignments', atMs: nowMs }],
  };
  return { preparation: nextPreparation, records: nextRecords, community: nextCommunity, memberships: newMemberships,
    receipt: { revision: 0, seasonId: season.id, season, sourceSeasonId: old.id, commandId: command.id, managerAccountIds: [...command.managerAccountIds], administratorAccountIds: [...command.administratorAccountIds], playerAssignmentCount: command.playerAssignments.length, spectatorGrantCount: 0, spectatorRenewal: 'individual_explicit_invitation_only' as const } };
}
