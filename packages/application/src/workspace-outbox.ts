import { parseTeamPrivilegeCommand } from './team-privileges';
import { assertAdultAuthority, assertTeamRole, currentMemberships, type Membership, type Principal } from './access';
import { parseBrandingCommand } from './branding';
import { parseScheduledGameCommand } from './fixture-management';
import { parseMatchFeedbackCommand } from './match-feedback';
import { parseOppositionReviewCommand } from './opposition-review';
import { assertSubstitutionAlertSettings } from './substitution-alerts';
import { normaliseFaPlayerId } from './preparation';
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
export type WorkspaceSettledOutcome = Exclude<WorkspaceRequestOutcome, { kind: 'unconfirmed' }> |
  { kind: 'locally_retired'; reason: 'legacy_invitation_protocol_retired'; serverAcknowledged: false };
export interface WorkspaceOutboxState {
  schemaVersion: 1;
  revision: number;
  scope: WorkspaceOutboxScope;
  pending: WorkspaceOutboxRequest | null;
  /** Keep the exact settled request for review; earlier versions remain in the journal. */
  lastSettled: { request: WorkspaceOutboxRequest; outcome: WorkspaceSettledOutcome; settledAtMs: number } | null;
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
  const branding = ['club_logo', 'team_logo'].flatMap(kind => ['publish', 'remove'].map(action => `branding/${kind}/${action}`));
  assert(['preparation', 'preparation/own', 'community', 'records', 'seasons', 'configuration', 'managers', 'managers/revoke', 'privileges', 'scheduled-games', 'match-feedback', 'opposition-reviews', ...branding].some(section => path === `${prefix}${section}?seasonId=${encodeURIComponent(value.seasonId)}`));
  const staff = path.startsWith(`${prefix}managers?`) || path.startsWith(`${prefix}managers/revoke?`);
  const scheduledGames = path.startsWith(`${prefix}scheduled-games?`), feedback = path.startsWith(`${prefix}match-feedback?`);
  const opposition = path.startsWith(`${prefix}opposition-reviews?`);
  const clubLogo = path.startsWith(`${prefix}branding/club_logo/`), teamLogo = path.startsWith(`${prefix}branding/team_logo/`);
  if (clubLogo) assert(value.role === 'administrator');
  if (teamLogo) assert(value.role === 'manager');
  if (staff) assert(value.role === 'administrator');
  if (scheduledGames) assert(value.role === 'manager' || value.role === 'administrator');
  if (feedback) assert(value.role === 'player');
  if (opposition) assert(value.role === 'manager' || value.role === 'administrator');
  if(path.startsWith(`${prefix}privileges?`))assert(value.role==='manager');
  if (value.role === 'administrator') assert(path.startsWith(`${prefix}configuration?`) || path.startsWith(`${prefix}seasons?`) || staff || clubLogo || scheduledGames || opposition);
  if (value.role === 'player') assert(path.startsWith(`${prefix}preparation/own?`) || path.startsWith(`${prefix}community?`) || feedback);
  if (value.role === 'spectator') assert(path.startsWith(`${prefix}community?`));
}
function utf8Size(value: string): number {
  let count = 0;
  for (const char of value) { const point = char.codePointAt(0)!; count += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4; }
  return count;
}
function serializeBody(body: unknown, requestKey: string, retained = false): string {
  assert(record(body) && Object.keys(body).length === 1 && record(body.command));
  const command = body.command;
  assert((command.id ?? command.commandId) === requestKey && text(command.type, 100));
  // Invitation acceptance is a separate connected flow: no prior destination membership.
  assert(command.type !== 'invite.accepted' || retained);
  let nodes = 0;
  const inspect = (value: unknown, depth: number): void => {
    assert(depth <= 30 && ++nodes <= 75_000);
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number') { assert(Number.isFinite(value)); return; }
    if (typeof value === 'string') { assert(value.length <= 200_000 && !/^Bearer\s/i.test(value)); return; }
    if (Array.isArray(value)) { value.forEach(item => inspect(item, depth + 1)); return; }
    assert(record(value));
    for (const [field, item] of Object.entries(value)) {
      // Legacy invitation candidates remain readable for recovery; new ones are blocked at enqueue.
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
function assertTeamPrivilegeRequest(path:string,bodyJson:string,owner:WorkspaceOutboxScope):void{
  const command=(JSON.parse(bodyJson) as {command:Record<string,unknown>}).command;
  if(path.startsWith(`/v1/teams/${encodeURIComponent(owner.teamId)}/privileges?`)){assert(owner.role==='manager');parseTeamPrivilegeCommand(command);}
  else assert(command.type!=='privilege.suspended'&&command.type!=='privilege.reinstated');
}
function assertBrandingRequest(path: string, bodyJson: string, owner: WorkspaceOutboxScope): void {
  const prefix = `/v1/teams/${encodeURIComponent(owner.teamId)}/branding/`;
  const command = (JSON.parse(bodyJson) as { command: Record<string, unknown> }).command;
  if (!path.startsWith(prefix)) { assert(command.type !== 'logo.published' && command.type !== 'logo.removed'); return; }
  const assetKind = path.slice(prefix.length).split('/')[0];
  assert(assetKind === 'club_logo' || assetKind === 'team_logo');
  const parsed = parseBrandingCommand(command, assetKind);
  assert(parsed.type === (path.startsWith(`${prefix}${assetKind}/publish?`) ? 'logo.published' : 'logo.removed'));
}
function assertScheduledGameFeedbackRequest(path: string, bodyJson: string, owner: WorkspaceOutboxScope): void {
  const prefix = `/v1/teams/${encodeURIComponent(owner.teamId)}/`;
  const command = (JSON.parse(bodyJson) as { command: Record<string, unknown> }).command;
  if (path.startsWith(`${prefix}scheduled-games?`)) {
    assert(owner.role === 'manager' || owner.role === 'administrator');
    parseScheduledGameCommand(command);
  } else assert(command.type !== 'fixture.cancelled' && command.type !== 'fixture.deleted');
  if (path.startsWith(`${prefix}match-feedback?`)) {
    assert(owner.role === 'player');
    parseMatchFeedbackCommand(command);
  } else assert(command.type !== 'feedback.saved');
}
/** Bind new commands to their exact existing protocol route, not merely a writable team URL. */
function assertClubExpansionRequest(path: string, bodyJson: string, owner: WorkspaceOutboxScope): void {
  const prefix = `/v1/teams/${encodeURIComponent(owner.teamId)}/`;
  const command = (JSON.parse(bodyJson) as { command: Record<string, unknown> }).command;
  const opposition = path.startsWith(`${prefix}opposition-reviews?`);
  if (opposition) {
    assert(owner.role === 'manager' || owner.role === 'administrator');
    parseOppositionReviewCommand(command);
  } else assert(command.type !== 'opposition.review.saved');
  if (command.type === 'own.fa_id_saved') {
    assert(owner.role === 'player' && path.startsWith(`${prefix}preparation/own?`));
    exactFields(command, ['id', 'type', 'expectedRevision', 'faPlayerId']);
    assert(time(command.expectedRevision));
    normaliseFaPlayerId(command.faPlayerId);
  }
  if (command.type === 'team.league_updated' || command.type === 'team.alerts_updated' || command.type === 'roster.proforma_imported') {
    assert(owner.role === 'manager' || owner.role === 'administrator');
    assert(path.startsWith(`${prefix}preparation?`) || path.startsWith(`${prefix}configuration?`));
    assert(time(command.expectedRevision));
    if (command.type === 'team.league_updated') {
      exactFields(command, ['id', 'type', 'expectedRevision', 'league']);
      assert(typeof command.league === 'string' && command.league.trim().length <= 120 && !/[\u0000-\u001f]/.test(command.league));
    } else if (command.type === 'team.alerts_updated') {
      exactFields(command, ['id', 'type', 'expectedRevision', 'substitutionAlerts']);
      assertSubstitutionAlertSettings(command.substitutionAlerts);
    } else {
      assert(owner.role === 'manager' && path.startsWith(`${prefix}preparation?`));
      exactFields(command, ['id', 'type', 'expectedRevision', 'profiles', 'confirmChanges']);
      assert(command.confirmChanges === true && Array.isArray(command.profiles) && command.profiles.length > 0 && command.profiles.length <= 200);
      const profiles = new Set<string>(), players = new Set<string>();
      const position = (value: unknown): value is string => typeof value === 'string' && /^[A-Z]{2}$/.test(value);
      for (const profile of command.profiles) {
        assert(record(profile));
        exactFields(profile, ['id','playerId','seasonId','displayName','initials','shirtNumber','foot','preferences','eligiblePositions','active', ...(Object.hasOwn(profile,'faPlayerId') ? ['faPlayerId'] : [])]);
        assert(typeof profile.id === 'string' && /^[A-Za-z0-9_.:-]{1,150}$/.test(profile.id) && typeof profile.playerId === 'string' && /^[A-Za-z0-9_.:-]{1,150}$/.test(profile.playerId));
        assert(profile.seasonId === owner.seasonId && profile.active === true && !profiles.has(profile.id) && !players.has(profile.playerId));
        profiles.add(profile.id); players.add(profile.playerId);
        assert(text(profile.displayName,60) && profile.displayName.trim().length > 0 && typeof profile.initials === 'string' && /^[A-Za-z0-9]{1,2}$/.test(profile.initials));
        assert(profile.shirtNumber === null || Number.isInteger(profile.shirtNumber) && Number(profile.shirtNumber) >= 1 && Number(profile.shirtNumber) <= 99);
        assert(['left','right','both','not_recorded'].includes(String(profile.foot)));
        assert(Array.isArray(profile.preferences) && profile.preferences.length === 3 && profile.preferences.every(position) && new Set(profile.preferences).size === 3);
        assert(Array.isArray(profile.eligiblePositions) && profile.eligiblePositions.length > 0 && profile.eligiblePositions.every(position) && new Set(profile.eligiblePositions).size === profile.eligiblePositions.length);
        if (Object.hasOwn(profile,'faPlayerId')) normaliseFaPlayerId(profile.faPlayerId);
      }
      // Current catalogue, identity ownership and active-season CAS remain server checks;
      // no invented local preparation document is used to approve a retained import.
    }
  }
}
function validateRequest(value: unknown, owner: WorkspaceOutboxScope): asserts value is WorkspaceOutboxRequest {
  assert(record(value)); exactFields(value, ['path', 'key', 'bodyJson', 'label', 'createdAtMs', 'status', 'lastAttemptAtMs', 'lastFailure']); assertPath(value.path, owner);
  assert(key(value.key) && text(value.label, 100) && time(value.createdAtMs));
  assert(typeof value.bodyJson === 'string' && utf8Size(value.bodyJson) <= 262_144);
  assert(serializeBody(JSON.parse(value.bodyJson), value.key, true) === value.bodyJson);
  assertStaffCommand(value.path, value.bodyJson, owner);
  assertBrandingRequest(value.path, value.bodyJson, owner);
  assertTeamPrivilegeRequest(value.path,value.bodyJson,owner);
  assertScheduledGameFeedbackRequest(value.path, value.bodyJson, owner);
  assertClubExpansionRequest(value.path, value.bodyJson, owner);
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
    const outcome = value.lastSettled.outcome;
    if (outcome.kind === 'locally_retired') {
      exactFields(outcome, ['kind', 'reason', 'serverAcknowledged']);
      assert(outcome.reason === 'legacy_invitation_protocol_retired' && outcome.serverAcknowledged === false);
      assert(isLegacyInvitation(value.lastSettled.request));
    } else {
      validateOutcome(outcome);
      assert(['accepted', 'refused'].includes(outcome.kind));
      exactFields(outcome, outcome.kind === 'accepted' ? ['kind', 'httpStatus', 'serverRequestId', 'serverRevision'] : ['kind', 'httpStatus', 'code', 'serverRequestId']);
    }
  }
}
export function enqueueWorkspaceRequest(state: WorkspaceOutboxState, binding: WorkspaceBinding, input: WorkspaceRequestInput, nowMs: number): WorkspaceOutboxState {
  validateWorkspaceOutbox(state); assert(sameScope(state.scope, scope(binding)) && time(nowMs));
  assertPath(input.path, state.scope); assert(key(input.key) && text(input.label, 100));
  const bodyJson = serializeBody(input.body, input.key);
  const commandType = (JSON.parse(bodyJson) as { command: { type: string } }).command.type;
  assert(commandType !== 'invite.created' && commandType !== 'invite.accepted');
  assertStaffCommand(input.path, bodyJson, state.scope);
  assertBrandingRequest(input.path, bodyJson, state.scope);
  assertTeamPrivilegeRequest(input.path,bodyJson,state.scope);
  assertScheduledGameFeedbackRequest(input.path, bodyJson, state.scope);
  assertClubExpansionRequest(input.path, bodyJson, state.scope);
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
  assertWorkspaceRequestAuthority(state, auth);
  if (isLegacyInvitation(state.pending!)) {
    throw new Error('This retained legacy invitation cannot be sent. Keep the original request for review and explicitly issue or reissue a server-generated invitation.');
  }
  return { ...state.pending!, lastFailure: state.pending!.lastFailure && { ...state.pending!.lastFailure } };
}
function isLegacyInvitation(request: WorkspaceOutboxRequest): boolean {
  return ['invite.created', 'invite.accepted'].includes((JSON.parse(request.bodyJson) as { command: { type: string } }).command.type);
}
function assertWorkspaceRequestAuthority(state: WorkspaceOutboxState, auth: WorkspaceOutboxAuthorization): void {
  validateWorkspaceOutbox(state);
  assert(state.pending && sameScope(state.scope, scope(auth.binding)) && time(auth.nowMs) && time(auth.verifiedAtMs));
  assert(auth.verifiedAtMs <= auth.nowMs && auth.nowMs - auth.verifiedAtMs <= 30_000);
  assert(workspaceBindingIsCurrent(auth.binding, auth.principal, auth.memberships, auth.nowMs));
  if (['seasons', 'managers', 'managers/revoke', ...(state.scope.role === 'administrator' ? ['scheduled-games'] : [])].some(section => state.pending!.path === `/v1/teams/${encodeURIComponent(state.scope.teamId)}/${section}?seasonId=${encodeURIComponent(state.scope.seasonId)}`)) {
    assertTeamRole(auth.principal, auth.memberships, state.scope.teamId, state.scope.seasonId, ['administrator'], auth.nowMs);
    assertAdultAuthority(auth.principal, true, auth.nowMs);
  }
  if (state.pending!.path === `/v1/teams/${encodeURIComponent(state.scope.teamId)}/opposition-reviews?seasonId=${encodeURIComponent(state.scope.seasonId)}`) {
    assertTeamRole(auth.principal, auth.memberships, state.scope.teamId, state.scope.seasonId, [state.scope.role === 'administrator' ? 'administrator' : 'manager'], auth.nowMs);
    assertAdultAuthority(auth.principal, false, auth.nowMs);
  }
  const ownFa = (JSON.parse(state.pending!.bodyJson) as {command:{type:string}}).command.type === 'own.fa_id_saved';
  if (ownFa || state.pending!.path === `/v1/teams/${encodeURIComponent(state.scope.teamId)}/match-feedback?seasonId=${encodeURIComponent(state.scope.seasonId)}`) {
    const currentPlayers = currentMemberships(auth.principal, auth.memberships, auth.nowMs).filter(member => member.accountId === state.scope.accountId && member.teamId === state.scope.teamId && member.seasonId === state.scope.seasonId && member.role === 'player');
    assert(new Set(currentPlayers.map(member => member.playerId)).size === 1 && currentPlayers[0]?.playerId === state.scope.playerId);
  }
  if (!auth.synthetic) {
    assert(workspaceSessionAllows(auth.session, state.scope.apiBaseUrl, auth.nowMs));
    assert(auth.session?.accountId === state.scope.accountId && auth.session.issuer === state.scope.issuer && auth.session.subject === state.scope.subject);
  }
}
/** Explicit local protocol retirement. This is never a server receipt or a generic request-discard path. */
export function retireLegacyWorkspaceInvitation(state: WorkspaceOutboxState, auth: WorkspaceOutboxAuthorization, requestKey: string, confirmNeverReplay: true, nowMs: number): WorkspaceOutboxState {
  assertWorkspaceRequestAuthority(state, auth);
  assert(state.pending?.key === requestKey && confirmNeverReplay === true && time(nowMs) && nowMs === auth.nowMs);
  assert(isLegacyInvitation(state.pending));
  assert(state.pending.path === `/v1/teams/${encodeURIComponent(state.scope.teamId)}/community?seasonId=${encodeURIComponent(state.scope.seasonId)}`);
  return { ...state, revision: state.revision + 1, pending: null, lastSettled: { request: { ...state.pending, lastFailure: state.pending.lastFailure && { ...state.pending.lastFailure } }, outcome: { kind: 'locally_retired', reason: 'legacy_invitation_protocol_retired', serverAcknowledged: false }, settledAtMs: nowMs } };
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
