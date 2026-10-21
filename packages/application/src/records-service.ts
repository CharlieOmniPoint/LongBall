import type { MatchState } from '@longball/domain';
import { AccessError, assertAdultAuthority, assertCanManageTeam, assertTeamRole, type Membership, type Principal } from './access';
import { reduceRecords, selectMatchReport, selectParticipationReport, selectSeasonResults, type FixtureClass, type HistoricalResultInput, type LiveMatchDetails, type RecordsActor, type RecordsCommand, type RecordsState, type RecordsViewer } from './records';
import { composeReportCommunity, type ReportCommunitySource } from './report-community';

export interface AcceptedRecordsMatch { teamId: string; seasonId: string; match: MatchState }
export interface RecordsServiceAuthority { principal: Principal; memberships: Membership[]; nowMs: number; requestedRole?: RecordsActor }
export interface RecordsServiceInput extends RecordsServiceAuthority { state: RecordsState; acceptedMatches: AcceptedRecordsMatch[]; community?: ReportCommunitySource | null }
export type CompactArchiveCommand = { type: 'live.archive'; commandId: string; matchId: string; expectedSourceMatchRevision: number; at?: string; actor?: RecordsActor; reason?: string };
export type RecordsServiceCommand = RecordsCommand | CompactArchiveCommand;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function fail(message: string, code = 'INVALID_REQUEST', status = 422): never { throw new AccessError(code, status, message); }
function requireThat(value: unknown, message: string): asserts value { if (!value) fail(message); }
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function string(value: unknown, max = 150): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value); }
function fields(value: Record<string, unknown>, permitted: string[]): void { requireThat(Object.keys(value).every(key => permitted.includes(key)), 'The request includes unsupported fields.'); }
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum; }
const fixtureClasses = ['development', 'friendly', 'trophy', 'unclassified'];
function score(value: unknown): HistoricalResultInput['finalScore'] {
  if (value === null) return null;
  requireThat(object(value), 'Provide a known score or explicitly leave it not recorded.'); fields(value, ['for', 'against']);
  requireThat(integer(value.for, 999) && integer(value.against, 999), 'Scores must be nonnegative whole goals.');
  return { for: value.for, against: value.against };
}
/** Reject unknown/private fields instead of storing arbitrary properties which could leak in future reports. */
export function parseHistoricalResultInput(value: unknown): HistoricalResultInput {
  requireThat(object(value), 'Historical details are required.');
  fields(value, ['playedDate', 'recordedKickoff', 'sameDayOrder', 'opponent', 'homeAway', 'fixtureClass', 'status', 'specialOutcome', 'finalScore', 'halfTimeScore', 'goals']);
  requireThat(string(value.playedDate, 10) && string(value.opponent, 120), 'A played date and opposition are required.');
  requireThat(value.recordedKickoff === null || string(value.recordedKickoff, 50), 'Known kickoff needs a timestamp; use null for unknown.');
  requireThat(value.sameDayOrder === null || integer(value.sameDayOrder, 100), 'Same-day ordering must be a whole number or unknown.');
  requireThat(['home', 'away', 'neutral'].includes(value.homeAway as string) && fixtureClasses.includes(value.fixtureClass as string), 'Choose a valid venue side and fixture class.');
  requireThat(['completed', 'abandoned', 'cancelled', 'postponed', 'incomplete'].includes(value.status as string) && ['ordinary', 'awarded', 'forfeit', 'shootout'].includes(value.specialOutcome as string), 'Choose a known match status and outcome category.');
  requireThat(Array.isArray(value.goals) && value.goals.length <= 1000, 'Known goal attribution must be a bounded list.');
  const goals = value.goals.map(item => {
    requireThat(object(item), 'A known goal must be an object.'); fields(item, ['id', 'beneficiary', 'isOwnGoal', 'scorerPlayerId', 'goalType', 'half', 'halfElapsedMs']);
    requireThat(string(item.id) && ['us', 'opposition'].includes(item.beneficiary as string) && typeof item.isOwnGoal === 'boolean', 'Known goals require identity, beneficiary and explicit own-goal classification.');
    requireThat(item.scorerPlayerId === null || string(item.scorerPlayerId), 'Use a saved player identity or unknown scorer.');
    requireThat(item.goalType === null || ['open_play', 'free_kick', 'penalty'].includes(item.goalType as string), 'Use a known goal type or unknown.');
    requireThat(item.half === null || item.half === 1 || item.half === 2, 'Use a known half or unknown.');
    requireThat(item.halfElapsedMs === null || integer(item.halfElapsedMs, 86_400_000), 'Known active goal time must be nonnegative whole milliseconds.');
    return { id: item.id, beneficiary: item.beneficiary, isOwnGoal: item.isOwnGoal, scorerPlayerId: item.scorerPlayerId, goalType: item.goalType, half: item.half, halfElapsedMs: item.halfElapsedMs } as HistoricalResultInput['goals'][number];
  });
  return { playedDate: value.playedDate, recordedKickoff: value.recordedKickoff, sameDayOrder: value.sameDayOrder, opponent: value.opponent.trim(), homeAway: value.homeAway, fixtureClass: value.fixtureClass, status: value.status, specialOutcome: value.specialOutcome, finalScore: score(value.finalScore), halfTimeScore: score(value.halfTimeScore), goals } as HistoricalResultInput;
}
export function recordsServiceViewer(input: RecordsServiceAuthority & { state: RecordsState }): RecordsViewer {
  const { principal, memberships, state, nowMs, requestedRole } = input;
  requireThat(Number.isSafeInteger(nowMs) && nowMs >= 0, 'Trusted server time is required.');
  if (requestedRole && !['manager', 'player', 'spectator'].includes(requestedRole)) fail('Unknown report audience.');
  const permitted = memberships.filter(item => item.accountId === principal.accountId && item.teamId === state.teamId && item.seasonId === state.seasonId && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > nowMs));
  const preferred = requestedRole ?? (permitted.some(item => item.role === 'manager') ? 'manager' : permitted.some(item => item.role === 'player') ? 'player' : 'spectator');
  const membership = assertTeamRole(principal, memberships, state.teamId, state.seasonId, [preferred], nowMs);
  if (preferred === 'manager') assertAdultAuthority(principal, false, nowMs);
  if (preferred === 'player' && !membership.playerId) fail('The current membership has no own-player binding.', 'NOT_FOUND', 404);
  return { actor: preferred, ...(preferred === 'player' ? { playerId: membership.playerId } : {}), teamId: state.teamId, seasonId: state.seasonId };
}
function accepted(input: { state: RecordsState; acceptedMatches: AcceptedRecordsMatch[] }, matchId: string): MatchState | null {
  const row = input.acceptedMatches.find(item => item.teamId === input.state.teamId && item.seasonId === input.state.seasonId && item.match.config.matchId === matchId);
  if (!row) return null;
  if (row.match.config.fixture && (row.match.config.fixture.teamId !== row.teamId || row.match.config.fixture.seasonId !== row.seasonId)) fail('Accepted fixture scope is inconsistent.', 'NOT_FOUND', 404);
  return row.match;
}
function contextFor(state: RecordsState, match: MatchState, fixtureClass?: FixtureClass): LiveMatchDetails | null {
  const fixture = match.config.fixture;
  if (!fixture) return state.liveMatch.matchId === match.config.matchId ? { ...state.liveMatch, fixtureClass: fixtureClass ?? state.liveMatch.fixtureClass } : null;
  return { matchId: match.config.matchId, playedDate: fixture.playedDate, opponent: fixture.opponent, homeAway: fixture.homeAway, fixtureClass: fixtureClass ?? state.results.find(record => record.id === match.config.matchId)?.fixtureClass ?? 'unclassified' };
}
export function recordsServiceView(input: RecordsServiceInput) {
  const viewer = recordsServiceViewer(input), { state, nowMs } = input;
  const activeMatch = accepted(input, state.liveMatch.matchId);
  const generatedAt = new Date(nowMs).toISOString();
  const stamp = <T extends object>(value: T) => ({ ...value, generatedAt });
  const ids = new Set(state.results.map(record => record.id));
  if (activeMatch && activeMatch.status !== 'preparation') ids.add(activeMatch.config.matchId);
  const common = { revision: state.revision, results: stamp(selectSeasonResults(state, viewer)), participation: stamp(selectParticipationReport(state, activeMatch, viewer)), matches: [...ids].map(id => selectMatchReport(state, id, viewer, activeMatch)).filter((item): item is NonNullable<typeof item> => item !== null).map(report => stamp({ ...report, ...composeReportCommunity(report, input.principal.accountId, input.community), goals: report.goals.map(goal => ({ ...goal, scorerLabel: goal.scorerPlayerId ? state.players.find(player => player.id === goal.scorerPlayerId)?.label ?? null : null })) })) };
  if (viewer.actor !== 'manager') return common;
  return { ...common, editableState: copy(state), activeMatch: activeMatch ? copy(activeMatch) : null,
    contexts: input.acceptedMatches.filter(row => row.teamId === state.teamId && row.seasonId === state.seasonId).flatMap(row => {
      const match = accepted(input, row.match.config.matchId)!;
      const details = contextFor(state, match, state.liveMatch.matchId === match.config.matchId ? state.liveMatch.fixtureClass : undefined);
      return details ? [{ ...details, status: match.status, sourceMatchRevision: match.revision, archivedSourceMatchRevision: state.results.find(record => record.id === match.config.matchId)?.sourceMatchRevision ?? null }] : [];
    }) };
}
export function applyRecordsServiceCommand(input: RecordsServiceInput & { command: RecordsServiceCommand }): RecordsState {
  const { state, command, principal, memberships, nowMs } = input;
  assertCanManageTeam(principal, memberships, state.teamId, state.seasonId, nowMs);
  if (input.requestedRole && input.requestedRole !== 'manager') fail('The selected audience cannot edit manager records.', 'NOT_FOUND', 404);
  requireThat(command && typeof command === 'object' && string(command.commandId) && /^[A-Za-z0-9_-]+$/.test(command.commandId), 'A stable record command identity is required.');
  let bound: RecordsCommand;
  const base = { commandId: command.commandId, at: new Date(nowMs).toISOString(), actor: 'manager' as const };
  switch (command.type) {
    case 'historical.add':
      requireThat(string(command.recordId), 'A historical match identity is required.');
      bound = { ...base, type: command.type, recordId: command.recordId, input: parseHistoricalResultInput(command.input), acknowledgePossibleDuplicate: command.acknowledgePossibleDuplicate === true }; break;
    case 'historical.correct':
      requireThat(string(command.recordId) && integer(command.expectedRevision) && string(command.reason, 500), 'Review the current record revision and provide a correction reason.');
      bound = { ...base, type: command.type, recordId: command.recordId, expectedRevision: command.expectedRevision, reason: command.reason.trim(), input: parseHistoricalResultInput(command.input) }; break;
    case 'live.context.set': {
      requireThat(command.details && typeof command.details === 'object' && string(command.details.matchId) && fixtureClasses.includes(command.details.fixtureClass), 'Choose a prepared match and an explicit fixture class.');
      const match = accepted(input, command.details.matchId);
      if (!match) fail('The prepared match is outside this team and season.', 'NOT_FOUND', 404);
      const details = contextFor(state, match, command.details.fixtureClass);
      requireThat(details && details.playedDate === command.details.playedDate && details.opponent === command.details.opponent && details.homeAway === command.details.homeAway, 'Match report context must retain the accepted fixture date, opponent and home/away side.');
      bound = { ...base, type: command.type, details }; break;
    }
    case 'live.archive': {
      const matchId = 'matchId' in command ? command.matchId : command.match?.config?.matchId;
      const expectedRevision = 'expectedSourceMatchRevision' in command ? command.expectedSourceMatchRevision : command.match?.revision;
      requireThat(string(matchId) && integer(expectedRevision), 'Archive the reviewed accepted match identity and source revision.');
      const match = accepted(input, matchId);
      if (!match) fail('The accepted match is outside this team and season.', 'NOT_FOUND', 404);
      if (match.revision !== expectedRevision) fail('The accepted match changed. Refresh its report before archiving.', 'STALE_REVISION', 409);
      const old = state.results.find(record => record.id === matchId);
      if (old && old.fixtureClass !== state.liveMatch.fixtureClass) requireThat(string(command.reason, 500), 'Explain the changed fixture classification before re-archiving.');
      bound = { ...base, type: command.type, match, ...(command.reason ? { reason: command.reason } : {}) }; break;
    }
    case 'participation.exception.noted':
      requireThat(string(command.recordId) && string(command.playerId) && integer(command.expectedRevision) && string(command.reason, 500), 'Review the saved participation and explain the exception.');
      bound = { ...base, type: command.type, recordId: command.recordId, playerId: command.playerId, expectedRevision: command.expectedRevision, reason: command.reason.trim() }; break;
    case 'publication.set': fail('A manager request cannot approve the unresolved competition policy. Independent operator evidence is required.', 'POLICY_APPROVAL_REQUIRED', 503); break;
    case 'training.evidence.replace': fail('Training report evidence is projected from the authorised preparation service.', 'SERVICE_OWNED_PROJECTION', 403); break;
    default: fail('Unsupported record command.');
  }
  // The HTTP idempotency layer owns retries. The reducer still preserves exact command identity.
  return reduceRecords(state, bound);
}
function policyFingerprint(state: RecordsState): string {
  const source = JSON.stringify(state.results.map(record => [record.id, record.classificationVersion, record.fixtureClass, record.publication]));
  let hash = 2166136261;
  for (const character of source) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return `policy-v1-${hash.toString(16).padStart(8, '0')}`; // Cache invalidation only; never authority or a signature.
}
export interface RecordsExportRequest { kind: 'season' | 'match'; matchId?: string; format: 'json' | 'csv'; expectedProjectionVersion?: number; expectedPolicyFingerprint?: string }
export function recordsServiceExport(input: RecordsServiceInput & { request: RecordsExportRequest }) {
  const viewer = recordsServiceViewer(input), view = recordsServiceView(input), { request, state, nowMs } = input;
  requireThat(request && ['season', 'match'].includes(request.kind) && ['json', 'csv'].includes(request.format), 'Choose a report and supported export format.');
  const fingerprint = policyFingerprint(state);
  if (request.expectedProjectionVersion !== undefined && request.expectedProjectionVersion !== state.revision || request.expectedPolicyFingerprint !== undefined && request.expectedPolicyFingerprint !== fingerprint) fail('This report or audience policy changed. Refresh before exporting.', 'STALE_PROJECTION', 409);
  const matches = request.kind === 'match' ? view.matches.filter(report => report.matchId === request.matchId) : view.matches;
  if (request.kind === 'match' && matches.length !== 1) fail('That permitted match report is unavailable.', 'NOT_FOUND', 404);
  const generatedAt = new Date(nowMs).toISOString();
  const document = { schemaVersion: 1, reportType: request.kind, teamId: state.teamId, seasonId: state.seasonId, audience: viewer.actor,
    appliedFilters: { matchId: request.kind === 'match' ? request.matchId : null, playerId: viewer.actor === 'player' ? viewer.playerId : null },
    generatedAt, asOf: request.kind === 'match' ? matches[0].asOf : view.participation.asOf, projectionVersion: state.revision, policyFingerprint: fingerprint,
    policyVersions: state.results.filter(record => request.kind === 'season' || matches.some(report => report.matchId === record.id)).map(record => ({ matchId: record.id, policyId: record.publication.id, policyVersion: record.publication.version, classificationVersion: record.classificationVersion })),
    dataCoverage: { participationAccess: view.participation.access, attendancePolicy: view.participation.rows[0]?.games.policy ?? 'proposed_known_records_excused_included', includesInventedHistoricalMinutes: false },
    ...(request.kind === 'season' ? { results: view.results, ...(viewer.actor !== 'spectator' ? { participation: view.participation } : {}) } : {}), matches };
  const csvCell = (value: unknown) => {
    let text = value === null || value === undefined ? 'Not recorded' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (/^[\t\r ]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const rows: unknown[][] = [['section', 'identity', 'field', 'value'], ['metadata', 'report', 'teamId', state.teamId], ['metadata', 'report', 'seasonId', state.seasonId], ['metadata', 'report', 'audience', viewer.actor], ['metadata', 'report', 'projectionVersion', state.revision], ['metadata', 'report', 'policyFingerprint', fingerprint], ['metadata', 'report', 'generatedAt', generatedAt], ['metadata', 'report', 'asOf', document.asOf], ['metadata', 'report', 'attendancePolicy', document.dataCoverage.attendancePolicy]];
  if (request.kind === 'season') for (const [field, value] of Object.entries(view.results)) rows.push(['results', 'season', field, value]);
  if (request.kind === 'season' && viewer.actor !== 'spectator') for (const row of view.participation.rows) for (const [field, value] of Object.entries(row)) rows.push(['participation', row.playerId, field, value]);
  for (const report of matches) for (const [field, value] of Object.entries(report)) rows.push(['match', report.matchId, field, value]);
  const body = request.format === 'json' ? JSON.stringify(document, null, 2) : '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
  return { kind: 'records-export' as const, format: request.format, contentType: request.format === 'json' ? 'application/json' : 'text/csv; charset=utf-8', fileName: `longball-${state.teamId.replace(/[^A-Za-z0-9_-]/g, '_')}-${state.seasonId.replace(/[^A-Za-z0-9_-]/g, '_')}-${request.kind}.${request.format}`, body, teamId: state.teamId, seasonId: state.seasonId, audience: viewer.actor, projectionVersion: state.revision, policyFingerprint: fingerprint, generatedAt };
}
