import { AccessError, type Membership, type Principal, type Role } from './access';

export type PrivacyRequestKind = 'export' | 'delete_account' | 'leave_team';
export type PrivacyRequestInput =
  | { kind: 'export' | 'delete_account'; scope: 'all_memberships'; confirmAllMemberships: true }
  | { kind: 'leave_team'; teamId: string; seasonId: string; confirmLeave: true };
export type PrivacyRequestScope = { type: 'all_memberships' } | { type: 'team_season'; teamId: string; seasonId: string };
export interface PrivacyAffectedMembership { teamId: string; seasonId: string; role: Role; playerId: string | null; status: 'active' | 'expired' | 'revoked' }
export interface PrivacyRequestRecord {
  requestId: string; accountId: string; kind: PrivacyRequestKind;
  status: 'pending_verification_and_policy' | 'needs_scope';
  scope: PrivacyRequestScope | null; affectedMemberships: PrivacyAffectedMembership[] | null; createdAtMs: number;
}
export interface PrivacyRequestDto extends Omit<PrivacyRequestRecord, 'accountId'> {
  verificationRequired: true; erased: false; fulfilled: false;
  scopeStatus: 'recorded' | 'needs_scope';
  reviewStatus: 'pending_verification_and_policy' | 'needs_scope' | 'duplicate_requires_review';
  duplicateOfRequestId: string | null;
}
export interface AccountPrivacyRequestsDto { accountId: string; memberships: PrivacyAffectedMembership[]; items: PrivacyRequestDto[] }
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,150}$/.test(value);
function requireThat(condition: unknown, message: string): asserts condition { if (!condition) throw new AccessError('INVALID_REQUEST', 400, message); }
function fields(value: Record<string, unknown>, names: string[]) { requireThat(Object.keys(value).length === names.length && Object.keys(value).every(key => names.includes(key)), 'Use only the documented account request fields.'); }
function active(principal: Principal) { if (principal.status !== 'active') throw new AccessError('ACCOUNT_UNAVAILABLE', 403, 'Use an active signed-in account to review or submit its own requests.'); }
function validTime(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
export function parsePrivacyRequestInput(value: unknown): PrivacyRequestInput {
  requireThat(object(value), 'Choose a scoped account request.');
  if (value.kind === 'leave_team') {
    fields(value, ['kind', 'teamId', 'seasonId', 'confirmLeave']);
    requireThat(opaque(value.teamId) && opaque(value.seasonId) && value.confirmLeave === true, 'Explicitly confirm the selected team and season leave request.');
    return { kind: 'leave_team', teamId: value.teamId, seasonId: value.seasonId, confirmLeave: true };
  }
  fields(value, ['kind', 'scope', 'confirmAllMemberships']);
  requireThat((value.kind === 'export' || value.kind === 'delete_account') && value.scope === 'all_memberships' && value.confirmAllMemberships === true, 'Explicitly confirm that this global account request covers every membership.');
  return { kind: value.kind, scope: 'all_memberships', confirmAllMemberships: true };
}
function parseScope(value: unknown): PrivacyRequestScope | null {
  if (value === null) return null;
  requireThat(object(value), 'Invalid retained account request scope.');
  if (value.type === 'all_memberships') { fields(value, ['type']); return { type: 'all_memberships' }; }
  fields(value, ['type', 'teamId', 'seasonId']);
  requireThat(value.type === 'team_season' && opaque(value.teamId) && opaque(value.seasonId), 'Invalid retained team and season scope.');
  return { type: 'team_season', teamId: value.teamId, seasonId: value.seasonId };
}
export function privacyRequestBusinessKey(accountId: string, kind: PrivacyRequestKind, scope: PrivacyRequestScope): string {
  requireThat(opaque(accountId) && ['export', 'delete_account', 'leave_team'].includes(kind), 'A stable own-account request scope is required.');
  const checked = parseScope(scope)!;
  requireThat(kind === 'leave_team' ? checked.type === 'team_season' : checked.type === 'all_memberships', 'The request kind and scope differ.');
  return JSON.stringify(checked.type === 'team_season' ? [accountId, kind, checked.type, checked.teamId, checked.seasonId] : [accountId, kind, checked.type]);
}
export function ownPrivacyMemberships(principal: Principal, memberships: Membership[], nowMs: number): PrivacyAffectedMembership[] {
  active(principal); requireThat(validTime(nowMs), 'Use the current service time.');
  return memberships.filter(item => item.accountId === principal.accountId).map(item => ({ teamId: item.teamId, seasonId: item.seasonId, role: item.role, playerId: item.playerId ?? null,
    status: item.revokedAt != null ? 'revoked' as const : item.expiresAt != null && item.expiresAt <= nowMs ? 'expired' as const : 'active' as const,
  })).sort((a, b) => a.teamId.localeCompare(b.teamId) || a.seasonId.localeCompare(b.seasonId) || a.role.localeCompare(b.role));
}
/** Capture the exact confirmed scope. No credential, membership, media or match is removed. */
export function prepareAccountPrivacyRequest(input: { principal: Principal; memberships: Membership[]; input: unknown; nowMs: number }) {
  const command = parsePrivacyRequestInput(input.input), own = ownPrivacyMemberships(input.principal, input.memberships, input.nowMs);
  const scope: PrivacyRequestScope = command.kind === 'leave_team' ? { type: 'team_season', teamId: command.teamId, seasonId: command.seasonId } : { type: 'all_memberships' };
  const affectedMemberships = scope.type === 'all_memberships' ? own : own.filter(item => item.teamId === scope.teamId && item.seasonId === scope.seasonId && item.status === 'active');
  if (scope.type === 'team_season' && !affectedMemberships.length) throw new AccessError('NOT_FOUND', 404, 'The selected current own membership is unavailable.');
  return { accountId: input.principal.accountId, kind: command.kind, scope, businessKey: privacyRequestBusinessKey(input.principal.accountId, command.kind, scope), affectedMemberships,
    status: 'pending_verification_and_policy' as const, verificationRequired: true as const, erased: false as const, fulfilled: false as const };
}
function parseMembership(value: unknown): PrivacyAffectedMembership {
  requireThat(object(value), 'Invalid affected membership.'); fields(value, ['teamId', 'seasonId', 'role', 'playerId', 'status']);
  requireThat(opaque(value.teamId) && opaque(value.seasonId) && ['administrator', 'manager', 'player', 'spectator'].includes(value.role as string) && (value.playerId === null || opaque(value.playerId)) && ['active', 'expired', 'revoked'].includes(value.status as string), 'Invalid affected membership fields.');
  return { teamId: value.teamId, seasonId: value.seasonId, role: value.role as Role, playerId: value.playerId as string | null, status: value.status as PrivacyAffectedMembership['status'] };
}
export function parsePrivacyRequestDto(value: unknown): PrivacyRequestDto {
  requireThat(object(value), 'Invalid account request response.');
  fields(value, ['requestId', 'kind', 'status', 'scope', 'affectedMemberships', 'createdAtMs', 'verificationRequired', 'erased', 'fulfilled', 'scopeStatus', 'reviewStatus', 'duplicateOfRequestId']);
  requireThat(opaque(value.requestId) && ['export', 'delete_account', 'leave_team'].includes(value.kind as string) && ['pending_verification_and_policy', 'needs_scope'].includes(value.status as string) && validTime(value.createdAtMs), 'Invalid account request status or identity.');
  requireThat(value.verificationRequired === true && value.erased === false && value.fulfilled === false && (value.duplicateOfRequestId === null || opaque(value.duplicateOfRequestId)), 'A pending request never establishes fulfilment or deletion.');
  const scope = parseScope(value.scope), kind = value.kind as PrivacyRequestKind;
  requireThat(scope === null || (kind === 'leave_team' ? scope.type === 'team_season' : scope.type === 'all_memberships'), 'The account request kind and scope differ.');
  requireThat(value.scopeStatus === (scope === null ? 'needs_scope' : 'recorded') && value.reviewStatus === (scope === null || value.status === 'needs_scope' ? 'needs_scope' : value.duplicateOfRequestId === null ? 'pending_verification_and_policy' : 'duplicate_requires_review'), 'The account request review status is inconsistent.');
  requireThat(value.affectedMemberships === null || Array.isArray(value.affectedMemberships), 'The confirmed membership snapshot is missing or invalid.');
  const affectedMemberships = value.affectedMemberships === null ? null : (value.affectedMemberships as unknown[]).map(parseMembership);
  requireThat(scope?.type !== 'team_season' || affectedMemberships === null || affectedMemberships.every(item => item.teamId === scope.teamId && item.seasonId === scope.seasonId), 'The affected membership snapshot crosses the selected leave scope.');
  return { requestId: value.requestId, kind, status: value.status as PrivacyRequestRecord['status'], scope, affectedMemberships, createdAtMs: value.createdAtMs, verificationRequired: true, erased: false, fulfilled: false, scopeStatus: value.scopeStatus as PrivacyRequestDto['scopeStatus'], reviewStatus: value.reviewStatus as PrivacyRequestDto['reviewStatus'], duplicateOfRequestId: value.duplicateOfRequestId as string | null };
}
export function projectAccountPrivacyRequests(input: { principal: Principal; memberships: Membership[]; records: PrivacyRequestRecord[]; nowMs: number }): AccountPrivacyRequestsDto {
  const memberships = ownPrivacyMemberships(input.principal, input.memberships, input.nowMs), canonical = new Map<string, string>();
  const items = input.records.filter(item => item.accountId === input.principal.accountId).sort((a, b) => a.createdAtMs - b.createdAtMs || a.requestId.localeCompare(b.requestId)).map(record => {
    const scope = parseScope(record.scope);
    const key = scope && record.status === 'pending_verification_and_policy' ? privacyRequestBusinessKey(record.accountId, record.kind, scope) : null;
    const duplicateOfRequestId = key ? canonical.get(key) ?? null : null;
    if (key && !canonical.has(key)) canonical.set(key, record.requestId);
    return parsePrivacyRequestDto({ requestId: record.requestId, kind: record.kind, status: record.status, scope, affectedMemberships: record.affectedMemberships, createdAtMs: record.createdAtMs,
      verificationRequired: true, erased: false, fulfilled: false, scopeStatus: scope === null ? 'needs_scope' : 'recorded', duplicateOfRequestId,
      reviewStatus: scope === null || record.status === 'needs_scope' ? 'needs_scope' : duplicateOfRequestId ? 'duplicate_requires_review' : 'pending_verification_and_policy' });
  });
  return { accountId: input.principal.accountId, memberships, items };
}
export function parseAccountPrivacyRequestsDto(value: unknown): AccountPrivacyRequestsDto {
  requireThat(object(value), 'Invalid own account request list.'); fields(value, ['accountId', 'memberships', 'items']);
  requireThat(opaque(value.accountId) && Array.isArray(value.memberships) && Array.isArray(value.items), 'Invalid own account request list fields.');
  return { accountId: value.accountId, memberships: value.memberships.map(parseMembership), items: value.items.map(parsePrivacyRequestDto) };
}
export function isSamePendingPrivacyRequest(value: PrivacyRequestDto, input: PrivacyRequestInput): boolean {
  const dto = parsePrivacyRequestDto(value), command = parsePrivacyRequestInput(input);
  if (dto.status !== 'pending_verification_and_policy' || dto.reviewStatus !== 'pending_verification_and_policy' || dto.kind !== command.kind || !dto.scope) return false;
  return command.kind === 'leave_team' ? dto.scope.type === 'team_season' && dto.scope.teamId === command.teamId && dto.scope.seasonId === command.seasonId : dto.scope.type === 'all_memberships';
}
