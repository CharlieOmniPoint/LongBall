import { AccessError, assertAdultAuthority, assertTeamRole, type Membership, type Principal } from './access';
import type { PreparationFixture, PreparationState } from './preparation';

export interface ScheduledGameCommand {
  id: string; expectedRevision: number; fixtureId: string;
  type: 'fixture.cancelled' | 'fixture.deleted'; reason: string; confirm: true;
}
export type FixtureManagementRole = 'manager' | 'administrator';
export interface FixtureManagementAction {
  commandId: string; fixtureId: string; type: ScheduledGameCommand['type']; actorId: string;
  role: FixtureManagementRole; reason: string; at: string; signature: string;
}
export interface ManagedPreparationState extends PreparationState {
  fixtureManagement?: {
    actions: FixtureManagementAction[];
    tombstones: { fixture: PreparationFixture; action: FixtureManagementAction }[];
  };
}
export interface ScheduledGameMetadata {
  id: string; seasonId: string; opponent: string; playedDate: string; kickoff: string | null;
  arrival: string | null; venue: string; homeAway: 'home' | 'away'; format: number;
  plannedHalfDurationMs: number; status: PreparationFixture['status'];
  canCancel: boolean; canDelete: boolean; blockedReason: 'recording_exists' | null;
}
export interface ScheduledGameManagementDto {
  kind: 'scheduled-game-management'; teamId: string; seasonId: string; revision: number;
  teamName: string; fixtures: ScheduledGameMetadata[];
}
export interface FixtureManagementContext {
  principal: Principal; memberships: Membership[]; role: FixtureManagementRole;
  seasonId: string; nowMs: number; protectedFixtureIds: readonly string[];
}
export function assertScheduledGameManagementDto(value: unknown, scope: { teamId: string; seasonId: string }): asserts value is ScheduledGameManagementDto {
  const object = (item: unknown): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item));
  const keys = (item: Record<string, unknown>, allowed: readonly string[]) => Object.keys(item).length === allowed.length && Object.keys(item).every(key => allowed.includes(key));
  const text = (item: unknown, maximum: number) => typeof item === 'string' && item.length <= maximum && !/[\u0000-\u001f\u007f]/.test(item);
  const time = (item: unknown) => item === null || typeof item === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item);
  const fail = () => { throw new Error('The scheduled-game metadata differs from its authorised team-season or contains unsupported fields.'); };
  if (!object(value) || !keys(value, ['kind', 'teamId', 'seasonId', 'revision', 'teamName', 'fixtures']) || value.kind !== 'scheduled-game-management' || value.teamId !== scope.teamId || value.seasonId !== scope.seasonId || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !text(value.teamName, 200) || !Array.isArray(value.fixtures)) return fail();
  const ids = new Set<string>();
  for (const fixture of value.fixtures) {
    if (!object(fixture) || !keys(fixture, ['id', 'seasonId', 'opponent', 'playedDate', 'kickoff', 'arrival', 'venue', 'homeAway', 'format', 'plannedHalfDurationMs', 'status', 'canCancel', 'canDelete', 'blockedReason']) || !entityId(fixture.id) || ids.has(fixture.id) || fixture.seasonId !== scope.seasonId || !text(fixture.opponent, 200) || typeof fixture.playedDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fixture.playedDate) || !Number.isFinite(Date.parse(fixture.playedDate)) || new Date(fixture.playedDate).toISOString().slice(0, 10) !== fixture.playedDate || !time(fixture.kickoff) || !time(fixture.arrival) || !text(fixture.venue, 1000) || !['home', 'away'].includes(String(fixture.homeAway)) || !Number.isSafeInteger(fixture.format) || Number(fixture.format) < 5 || Number(fixture.format) > 11 || !Number.isSafeInteger(fixture.plannedHalfDurationMs) || Number(fixture.plannedHalfDurationMs) <= 0 || Number(fixture.plannedHalfDurationMs) > 3_600_000 || !['scheduled', 'postponed', 'cancelled'].includes(String(fixture.status)) || typeof fixture.canCancel !== 'boolean' || typeof fixture.canDelete !== 'boolean' || ![null, 'recording_exists'].includes(fixture.blockedReason as null | string)) return fail();
    if (fixture.blockedReason === 'recording_exists' ? fixture.canCancel || fixture.canDelete : !fixture.canDelete || fixture.canCancel !== (fixture.status !== 'cancelled')) return fail();
    ids.add(fixture.id);
  }
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{8,150}$/.test(value);
const entityId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,150}$/.test(value);
const invalid = (message: string): never => { throw new AccessError('INVALID_REQUEST', 400, message); };
function signature(command: ScheduledGameCommand): string {
  return [command.id, command.expectedRevision, command.fixtureId, command.type, command.reason, 'true'].join('\n');
}
export function parseScheduledGameCommand(value: unknown): ScheduledGameCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Use a captured scheduled-game command.');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !['id', 'expectedRevision', 'fixtureId', 'type', 'reason', 'confirm'].includes(key)) ||
    !opaque(item.id) || !entityId(item.fixtureId) || !Number.isSafeInteger(item.expectedRevision) || Number(item.expectedRevision) < 0 ||
    !['fixture.cancelled', 'fixture.deleted'].includes(String(item.type)) || item.confirm !== true ||
    typeof item.reason !== 'string' || item.reason.trim().length < 5 || item.reason.trim().length > 500) {
    return invalid('Confirm cancellation or deletion with its current revision and a reason of 5–500 characters.');
  }
  return { id: item.id, expectedRevision: Number(item.expectedRevision), fixtureId: item.fixtureId, type: item.type as ScheduledGameCommand['type'], reason: item.reason.trim(), confirm: true };
}
export function assertFixtureManagementAuthority(state: PreparationState, context: FixtureManagementContext): void {
  if (!['manager', 'administrator'].includes(context.role)) throw new AccessError('NOT_FOUND', 404, 'Choose the current manager or administrator context.');
  assertTeamRole(context.principal, context.memberships, state.team.id, context.seasonId, [context.role], context.nowMs);
  assertAdultAuthority(context.principal, context.role === 'administrator', context.nowMs);
  if (state.activeSeasonId !== context.seasonId) throw new AccessError('NOT_FOUND', 404, 'The requested schedule is unavailable.');
}
export function fixtureWasDeleted(state: PreparationState, fixtureId: string): boolean {
  return Boolean((state as ManagedPreparationState).fixtureManagement?.tombstones.some(item => item.fixture.id === fixtureId));
}
export function assertFixtureNotDeleted(state: PreparationState, fixtureId: string): void {
  if (fixtureWasDeleted(state, fixtureId)) throw new AccessError('FIXTURE_DELETED', 409, 'This schedule item was deleted. Its audit is retained; create a new fixture identity.');
}
/** Canonical match rows remain retained, but an unavailable schedule cannot be recorded or downloaded. */
export function fixtureRecordingUnavailable(state: PreparationState, fixtureId: string): boolean {
  const fixture = state.fixtures.find(item => item.id === fixtureId);
  return fixtureWasDeleted(state, fixtureId) || Boolean(fixture && fixture.status !== 'scheduled');
}
export function scheduledGameManagementView(state: PreparationState, context: FixtureManagementContext): ScheduledGameManagementDto {
  assertFixtureManagementAuthority(state, context);
  const protectedIds = new Set(context.protectedFixtureIds);
  return { kind: 'scheduled-game-management', teamId: state.team.id, seasonId: context.seasonId, revision: state.revision, teamName: state.team.name,
    fixtures: state.fixtures.filter(fixture => fixture.seasonId === context.seasonId).map(fixture => {
      const protectedHistory = protectedIds.has(fixture.id);
      return { id: fixture.id, seasonId: fixture.seasonId, opponent: fixture.opponent, playedDate: fixture.playedDate, kickoff: fixture.kickoff, arrival: fixture.arrival, venue: fixture.venue, homeAway: fixture.homeAway, format: fixture.format, plannedHalfDurationMs: fixture.plannedHalfDurationMs, status: fixture.status,
        canCancel: !protectedHistory && fixture.status !== 'cancelled', canDelete: !protectedHistory, blockedReason: protectedHistory ? 'recording_exists' as const : null };
    }).sort((left, right) => `${left.playedDate} ${left.kickoff ?? ''} ${left.id}`.localeCompare(`${right.playedDate} ${right.kickoff ?? ''} ${right.id}`)) };
}
export function applyScheduledGameCommand(previous: PreparationState, input: unknown, context: FixtureManagementContext): ManagedPreparationState {
  assertFixtureManagementAuthority(previous, context);
  const command = parseScheduledGameCommand(input), before = previous as ManagedPreparationState;
  const prior = before.fixtureManagement?.actions.find(item => item.commandId === command.id);
  if (prior) {
    if (prior.signature !== signature(command)) throw new AccessError('IDEMPOTENCY_CONFLICT', 409, 'This command identity already preserves a different schedule decision.');
    return previous;
  }
  if (previous.appliedCommands[command.id]) throw new AccessError('IDEMPOTENCY_CONFLICT', 409, 'This command identity already belongs to another preparation change.');
  if (command.expectedRevision !== previous.revision) throw new AccessError('STALE_REVISION', 409, 'The schedule changed. Refresh it before reviewing this decision again.');
  assertFixtureNotDeleted(previous, command.fixtureId);
  const fixture = previous.fixtures.find(item => item.id === command.fixtureId && item.seasonId === context.seasonId);
  if (!fixture) throw new AccessError('NOT_FOUND', 404, 'The requested schedule item is unavailable.');
  if (context.protectedFixtureIds.includes(fixture.id)) throw new AccessError('MATCH_HISTORY_EXISTS', 409, 'This game has recording authority or saved match history. Preserve it and use the recorded-match workflow.');
  if (command.type === 'fixture.cancelled' && fixture.status === 'cancelled') throw new AccessError('ALREADY_CANCELLED', 409, 'This fixture is already cancelled.');
  const state = clone(before), revision = previous.revision + 1;
  const action: FixtureManagementAction = { commandId: command.id, fixtureId: fixture.id, type: command.type, actorId: context.principal.accountId, role: context.role, reason: command.reason, at: new Date(context.nowMs).toISOString(), signature: signature(command) };
  const management = state.fixtureManagement ??= { actions: [], tombstones: [] };
  management.actions.push(action);
  if (command.type === 'fixture.deleted') {
    management.tombstones.push({ fixture: clone(fixture), action: clone(action) });
    state.fixtures = state.fixtures.filter(item => item.id !== fixture.id);
  } else {
    const cancelled = state.fixtures.find(item => item.id === fixture.id)!;
    cancelled.status = 'cancelled';
    cancelled.history.push({ revision, action: 'cancelled', playedDate: cancelled.playedDate, kickoff: cancelled.kickoff, status: 'cancelled' });
  }
  state.revision = revision;
  state.appliedCommands[command.id] = signature(command);
  state.audit.push({ id: command.id, revision, type: command.type });
  return state;
}
