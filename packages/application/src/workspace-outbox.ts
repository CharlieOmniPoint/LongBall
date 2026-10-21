import { assertAdultAuthority, assertTeamRole, type Membership, type Principal } from './access';
import { workspaceBindingIsCurrent, workspaceSessionAllows, type WorkspaceBinding, type WorkspaceSessionAccess } from './workspace-boundary';

/** Local acknowledgement uncertainty only. A queued vote is never a counted vote. */
export type WorkspaceOutboxScope = Omit<WorkspaceBinding, 'generation'>;
export interface WorkspaceRequestInput { path: string; key: string; body: unknown; label: string }
export interface WorkspaceOutboxRequest {
  path: string;
  key: string;
  /** Exact wire bytes survive a close/reopen; never regenerate the command or revision. */
  bodyJson: string;
  label: string;
  createdAtMs: number;
  status: 'awaiting_receipt' | 'uncertain' | 'access_blocked';
  lastAttemptAtMs: number | null;
  lastFailure: { reason: WorkspaceUnconfirmedReason; httpStatus: number | null; code: string | null } | null;
}
export type WorkspaceUnconfirmedReason = 'network' | 'unreadable' | 'retryable_service' | 'authentication' | 'access';
export type WorkspaceRequestOutcome =
  | { kind: 'unconfirmed'; reason: WorkspaceUnconfirmedReason; httpStatus?: number; code?: string }
  | { kind: 'accepted'; httpStatus: number; serverRequestId?: string | null; serverRevision?: number | null }
  | { kind: 'refused'; httpStatus: number; code: string; serverRequestId?: string | null };
export interface WorkspaceOutboxState {
  schemaVersion: 1;
  revision: number;
  scope: WorkspaceOutboxScope;
  pending: WorkspaceOutboxRequest | null;
  /** Keep the exact settled request for review; earlier versions remain in the journal. */
  lastSettled: { request: WorkspaceOutboxRequest; outcome: Exclude<WorkspaceRequestOutcome, { kind: 'unconfirmed' }>; settledAtMs: number } | null;
}
export interface WorkspaceOutboxAuthorization {
  binding: WorkspaceBinding;
  principal: Principal;
  memberships: Membership[];
  /** Time of the latest authenticated /me reply, checked again immediately before replay. */
  verifiedAtMs: number;
  nowMs: number;
  synthetic: boolean;
  session: WorkspaceSessionAccess | null;
}
export interface WorkspaceOutboxStorageEvidence {
  platform: 'native' | 'web';
  synthetic: boolean;
  diagnostics: { mode: string; cipherVersion: string | null; wrongKeyProbe: string; backupExcluded: boolean } | null;
}
const failure = () => new Error('The retained request is invalid or belongs to another protected workspace. Existing records must be retained.');
function assert(value: unknown): asserts value { if (!value) throw failure(); }
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
}
function text(value: unknown, max = 256): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value); }
function time(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function code(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value); }
function key(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{8,150}$/.test(value); }
function exactFields(value: Record<string, unknown>, fields: string[]): void { assert(Object.keys(value).length === fields.length && Object.keys(value).every(field => fields.includes(field))); }
function apiIdentity(value: string): string {
  const url = new URL(value);
  assert(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && value.length <= 1024);
  assert(url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  return `${url.origin}${url.pathname.replace(/\/$/, '').replace(/\/v1$/, '')}`;
}
function scope(binding: WorkspaceBinding | WorkspaceOutboxScope): WorkspaceOutboxScope {
  assert(record(binding));
  assert(text(binding.accountId) && text(binding.issuer, 1024) && text(binding.subject, 512) && text(binding.teamId) && text(binding.seasonId));
  assert(['administrator', 'manager', 'player', 'spectator'].includes(binding.role));
  assert(binding.role === 'player' ? text(binding.playerId) : binding.playerId === null);
  return { apiBaseUrl: apiIdentity(binding.apiBaseUrl), accountId: binding.accountId, issuer: binding.issuer, subject: binding.subject, teamId: binding.teamId, seasonId: binding.seasonId, role: binding.role, playerId: binding.playerId };
}
function scopeKey(value: WorkspaceOutboxScope): string {
  return JSON.stringify([value.apiBaseUrl, value.accountId, value.issuer, value.subject, value.teamId, value.seasonId, value.role, value.playerId]);
}
function sameScope(left: WorkspaceOutboxScope, right: WorkspaceOutboxScope): boolean { return scopeKey(left) === scopeKey(right); }
/** Pure gate: UI supplies evidence read from the actual Journal, never a stored preference. */
export function workspaceOutboxStorageAllowed(evidence: WorkspaceOutboxStorageEvidence): boolean {
  const item = evidence.diagnostics;
  return Boolean(item && (evidence.synthetic && item.mode === 'synthetic-browser' || evidence.platform === 'native' && item.mode === 'encrypted-native' && item.cipherVersion && item.wrongKeyProbe === 'passed' && item.backupExcluded));
}
/** Exact, collision-free namespace, without URL credentials or authentication capabilities. */
export function workspaceOutboxDocumentId(binding: WorkspaceBinding | WorkspaceOutboxScope): string {
  return `workspace-outbox.v1:${encodeURIComponent(scopeKey(scope(binding)))}`;
}
export function createWorkspaceOutbox(binding: WorkspaceBinding | WorkspaceOutboxScope): WorkspaceOutboxState {
  return { schemaVersion: 1, revision: 0, scope: scope(binding), pending: null, lastSettled: null };
}
function assertPath(path: unknown, value: WorkspaceOutboxScope): asserts path is string {
  assert(text(path, 2048));
  const prefix = `/v1/teams/${encodeURIComponent(value.teamId)}/`;
  assert(['preparation', 'preparation/own', 'community', 'records', 'seasons', 'configuration', 'managers', 'managers/revoke'].some(section => path === `${prefix}${section}?seasonId=${encodeURIComponent(value.seasonId)}`));
  const staff = path.startsWith(`${prefix}managers?`) || path.startsWith(`${prefix}managers/revoke?`);
  if (staff) assert(value.role === 'administrator');
  if (value.role === 'administrator') assert(path.startsWith(`${prefix}configuration?`) || path.startsWith(`${prefix}seasons?`) || staff);
  if (value.role === 'player') assert(path.startsWith(`${prefix}preparation/own?`) || path.startsWith(`${prefix}community?`));
  if (value.role === 'spectator') assert(path.startsWith(`${prefix}community?`));
}
function utf8Size(value: string): number {
  let count = 0;
  for (const char of value) { const point = char.codePointAt(0)!; count += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4; }
  return count;
}
function serializeBody(body: unknown, requestKey: string): string {
  assert(record(body) && Object.keys(body).length === 1 && record(body.command));
  const command = body.command;
  assert((command.id ?? command.commandId) === requestKey && text(command.type, 100));
  // Invitation acceptance is a separate connected flow: no prior destination membership.
  assert(command.type !== 'invite.accepted');
  let nodes = 0;
  const inspect = (value: unknown, depth: number): void => {
    assert(depth <= 30 && ++nodes <= 75_000);
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number') { assert(Number.isFinite(value)); return; }
    if (typeof value === 'string') { assert(value.length <= 200_000 && !/^Bearer\s/i.test(value)); return; }
    if (Array.isArray(value)) { value.forEach(item => inspect(item, depth + 1)); return; }
    assert(record(value));
    for (const [field, item] of Object.entries(value)) {
      // Invite creation's reviewCode is stored only behind the Journal evidence gate.
      assert(!/^(?:authorization|headers|cookie|password|pin|secret|access.?token|refresh.?token|id.?token|upload.?token|controller.?token)$/i.test(field) && !/token$/i.test(field));
      assert(field !== '__proto__' && field !== 'constructor' && field !== 'prototype');
      if (item !== undefined) inspect(item, depth + 1); // JSON's object-field omission is intentional.
    }
  };
  inspect(body, 0);
  const encoded = JSON.stringify(body);
  assert(utf8Size(encoded) <= 262_144);
  return encoded;
}
function assertStaffCommand(path: string, bodyJson: string, owner: WorkspaceOutboxScope): void {
  const prefix = `/v1/teams/${encodeURIComponent(owner.teamId)}/`;
  const assign = path.startsWith(`${prefix}managers?`), revoke = path.startsWith(`${prefix}managers/revoke?`);
  const command = (JSON.parse(bodyJson) as { command: Record<string, unknown> }).command;
  if (!assign && !revoke) { assert(command.type !== 'manager.assigned' && command.type !== 'manager.revoked'); return; }
  exactFields(command, revoke ? ['id', 'expectedRevision', 'type', 'accountId', 'reason', 'confirmRevocation'] : ['id', 'expectedRevision', 'type', 'accountId']);
  assert(time(command.expectedRevision) && typeof command.accountId === 'string' && /^[A-Za-z0-9_-]{1,150}$/.test(command.accountId));
  assert(command.type === (assign ? 'manager.assigned' : 'manager.revoked'));
  if (revoke) assert(command.confirmRevocation === true && text(command.reason, 500) && command.reason.trim().length >= 5);
}
function validateRequest(value: unknown, owner: WorkspaceOutboxScope): asserts value is WorkspaceOutboxRequest {
  assert(record(value)); exactFields(value, ['path', 'key', 'bodyJson', 'label', 'createdAtMs', 'status', 'lastAttemptAtMs', 'lastFailure']); assertPath(value.path, owner);
  assert(key(value.key) && text(value.label, 100) && time(value.createdAtMs));
  assert(typeof value.bodyJson === 'string' && utf8Size(value.bodyJson) <= 262_144);
  assert(serializeBody(JSON.parse(value.bodyJson), value.key) === value.bodyJson);
  assertStaffCommand(value.path, value.bodyJson, owner);
  assert(['awaiting_receipt', 'uncertain', 'access_blocked'].includes(value.status as string));
  assert(value.lastAttemptAtMs === null || time(value.lastAttemptAtMs));
  if (value.lastFailure !== null) {
    assert(record(value.lastFailure) && ['network', 'unreadable', 'retryable_service', 'authentication', 'access'].includes(value.lastFailure.reason as string));
    exactFields(value.lastFailure, ['reason', 'httpStatus', 'code']);
    assert(value.lastFailure.httpStatus === null || Number.isInteger(value.lastFailure.httpStatus) && (value.lastFailure.httpStatus as number) >= 100 && (value.lastFailure.httpStatus as number) <= 599);
    assert(value.lastFailure.code === null || code(value.lastFailure.code));
  }
}
export function validateWorkspaceOutbox(value: WorkspaceOutboxState): void {
  assert(record(value) && value.schemaVersion === 1 && time(value.revision));
  exactFields(value, ['schemaVersion', 'revision', 'scope', 'pending', 'lastSettled']);
  assert(record(value.scope)); exactFields(value.scope, ['apiBaseUrl', 'accountId', 'issuer', 'subject', 'teamId', 'seasonId', 'role', 'playerId']);
  const owner = scope(value.scope);
  assert(sameScope(owner, value.scope));
  if (value.pending !== null) validateRequest(value.pending, owner);
  if (value.lastSettled !== null) {
    assert(record(value.lastSettled) && time(value.lastSettled.settledAtMs));
    exactFields(value.lastSettled, ['request', 'outcome', 'settledAtMs']);
    validateRequest(value.lastSettled.request, owner);
    validateOutcome(value.lastSettled.outcome);
    assert(['accepted', 'refused'].includes(value.lastSettled.outcome.kind));
    exactFields(value.lastSettled.outcome, value.lastSettled.outcome.kind === 'accepted' ? ['kind', 'httpStatus', 'serverRequestId', 'serverRevision'] : ['kind', 'httpStatus', 'code', 'serverRequestId']);
  }
}
export function enqueueWorkspaceRequest(state: WorkspaceOutboxState, binding: WorkspaceBinding, input: WorkspaceRequestInput, nowMs: number): WorkspaceOutboxState {
  validateWorkspaceOutbox(state); assert(sameScope(state.scope, scope(binding)) && time(nowMs));
  assertPath(input.path, state.scope); assert(key(input.key) && text(input.label, 100));
  const bodyJson = serializeBody(input.body, input.key);
  assertStaffCommand(input.path, bodyJson, state.scope);
  if (state.pending) {
    assert(state.pending.key === input.key && state.pending.path === input.path && state.pending.bodyJson === bodyJson && state.pending.label === input.label);
    return state;
  }
  // An already settled identity cannot be reused for new content or a second action.
  assert(state.lastSettled?.request.key !== input.key);
  return { ...state, revision: state.revision + 1, pending: { path: input.path, key: input.key, bodyJson, label: input.label, createdAtMs: nowMs, status: 'awaiting_receipt', lastAttemptAtMs: null, lastFailure: null } };
}
/** Call only after a successful current /me response. Never schedules background replay. */
export function authorizeWorkspaceReplay(state: WorkspaceOutboxState, auth: WorkspaceOutboxAuthorization): WorkspaceOutboxRequest {
  validateWorkspaceOutbox(state);
  assert(state.pending && sameScope(state.scope, scope(auth.binding)) && time(auth.nowMs) && time(auth.verifiedAtMs));
  assert(auth.verifiedAtMs <= auth.nowMs && auth.nowMs - auth.verifiedAtMs <= 30_000);
  assert(workspaceBindingIsCurrent(auth.binding, auth.principal, auth.memberships, auth.nowMs));
  if (['seasons', 'managers', 'managers/revoke'].some(section => state.pending!.path === `/v1/teams/${encodeURIComponent(state.scope.teamId)}/${section}?seasonId=${encodeURIComponent(state.scope.seasonId)}`)) {
    assertTeamRole(auth.principal, auth.memberships, state.scope.teamId, state.scope.seasonId, ['administrator'], auth.nowMs);
    assertAdultAuthority(auth.principal, true, auth.nowMs);
  }
  if (!auth.synthetic) {
    assert(workspaceSessionAllows(auth.session, state.scope.apiBaseUrl, auth.nowMs));
    assert(auth.session?.accountId === state.scope.accountId && auth.session.issuer === state.scope.issuer && auth.session.subject === state.scope.subject);
  }
  return { ...state.pending, lastFailure: state.pending.lastFailure && { ...state.pending.lastFailure } };
}
function validateOutcome(value: WorkspaceRequestOutcome): void {
  assert(record(value));
  if (value.kind === 'unconfirmed') {
    assert(['network', 'unreadable', 'retryable_service', 'authentication', 'access'].includes(value.reason));
    assert(value.httpStatus === undefined || Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599);
    assert(value.code === undefined || code(value.code)); return;
  }
  assert(value.kind === 'accepted' || value.kind === 'refused');
  assert(Number.isInteger(value.httpStatus));
  assert(value.serverRequestId === undefined || value.serverRequestId === null || key(value.serverRequestId));
  if (value.kind === 'accepted') {
    assert(value.httpStatus >= 200 && value.httpStatus < 300);
    assert(value.serverRevision === undefined || value.serverRevision === null || time(value.serverRevision));
  } else {
    const explicitPolicyRefusal = value.httpStatus === 503 && ['POLICY_APPROVAL_REQUIRED', 'SEASON_ASSIGNMENT_REQUIRED'].includes(value.code);
    assert((value.httpStatus >= 400 && value.httpStatus < 500 && ![401, 403, 404, 408, 425, 429].includes(value.httpStatus) || explicitPolicyRefusal) && code(value.code));
  }
}
export function recordWorkspaceOutcome(state: WorkspaceOutboxState, requestKey: string, outcome: WorkspaceRequestOutcome, nowMs: number): WorkspaceOutboxState {
  validateWorkspaceOutbox(state); validateOutcome(outcome);
  assert(state.pending?.key === requestKey && time(nowMs));
  const request: WorkspaceOutboxRequest = { ...state.pending, lastAttemptAtMs: nowMs };
  if (outcome.kind === 'unconfirmed') {
    request.status = ['authentication', 'access'].includes(outcome.reason) ? 'access_blocked' : 'uncertain';
    request.lastFailure = { reason: outcome.reason, httpStatus: outcome.httpStatus ?? null, code: outcome.code ?? null };
    return { ...state, revision: state.revision + 1, pending: request };
  }
  // Persist only allowlisted metadata, never the raw DTO, error text or response headers.
  const safeOutcome: Exclude<WorkspaceRequestOutcome, { kind: 'unconfirmed' }> = outcome.kind === 'accepted'
    ? { kind: 'accepted', httpStatus: outcome.httpStatus, serverRequestId: outcome.serverRequestId ?? null, serverRevision: outcome.serverRevision ?? null }
    : { kind: 'refused', httpStatus: outcome.httpStatus, code: outcome.code, serverRequestId: outcome.serverRequestId ?? null };
  return { ...state, revision: state.revision + 1, pending: null, lastSettled: { request, outcome: safeOutcome, settledAtMs: nowMs } };
}
