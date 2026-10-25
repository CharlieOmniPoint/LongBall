import { currentMemberships, type Membership, type Principal, type Role } from './access';

/** A navigation choice, never a grant or a retained authenticated membership. */
export interface WorkspaceContextSelection {
  teamId: string;
  seasonId: string;
  role: Role;
  playerId: string | null;
}
export interface WorkspaceContextChoice extends WorkspaceContextSelection {
  teamLabel: string;
  seasonLabel: string;
  clubLabel: string | null;
  roleLabel: string;
}
/** Optional display metadata supplied by /me, kept outside the stored preference. */
export interface NamedWorkspaceMembership extends Membership {
  teamName?: string;
  teamLabel?: string;
  seasonLabel?: string;
  clubName?: string;
  clubLabel?: string;
}
export interface WorkspaceContextPreference {
  schemaVersion: 1;
  apiBaseUrl: string;
  accountId: string;
  issuer: string;
  subject: string;
  context: WorkspaceContextSelection;
}
const roles: Role[] = ['administrator', 'manager', 'player', 'spectator'];
const labels: Record<Role, string> = { administrator: 'Administrator', manager: 'Manager', player: 'Player and parent', spectator: 'Spectator' };
function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
}
function identifier(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value); }
function displayLabel(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 120 && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : null;
}
function exact(value: Record<string, unknown>, fields: string[]): boolean {
  return Object.keys(value).length === fields.length && Object.keys(value).every(field => fields.includes(field));
}
function selection(value: unknown): value is WorkspaceContextSelection {
  return object(value) && exact(value, ['teamId', 'seasonId', 'role', 'playerId']) && identifier(value.teamId) && identifier(value.seasonId) && roles.includes(value.role as Role) && (value.role === 'player' ? identifier(value.playerId) : value.playerId === null);
}
function copySelection(value: WorkspaceContextSelection): WorkspaceContextSelection {
  return { teamId: value.teamId, seasonId: value.seasonId, role: value.role, playerId: value.playerId };
}
function apiIdentity(value: string): string {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || value.length > 2048) throw new Error('Invalid workspace API identity.');
  return `${url.origin}${url.pathname.replace(/\/$/, '').replace(/\/v1$/, '')}`;
}
function validPrincipal(principal: Principal): boolean {
  return principal.status === 'active' && identifier(principal.accountId) && identifier(principal.issuer) && identifier(principal.subject);
}
export function workspaceContextKey(value: WorkspaceContextSelection): string {
  return JSON.stringify([value.teamId, value.seasonId, value.role, value.playerId]);
}
/** All eligible contexts in server order, without role priority or inferred authority. */
export function workspaceContextChoices(principal: Principal, memberships: NamedWorkspaceMembership[], nowMs: number): WorkspaceContextChoice[] {
  if (!validPrincipal(principal) || !Number.isSafeInteger(nowMs) || nowMs < 0) return [];
  const found = new Map<string, WorkspaceContextChoice>();
  for (const row of currentMemberships(principal, memberships, nowMs)) {
    if (!roles.includes(row.role) || !identifier(row.teamId) || !identifier(row.seasonId)) continue;
    if (row.role === 'player' && !identifier(row.playerId)) continue;
    if (['administrator', 'manager'].includes(row.role) && (principal.identityClassification !== 'adult_individual' || !principal.adultVerified || !principal.strongAuth)) continue;
    const choice: WorkspaceContextSelection = { teamId: row.teamId, seasonId: row.seasonId, role: row.role, playerId: row.role === 'player' ? row.playerId! : null };
    const key = workspaceContextKey(choice);
    const named = row as NamedWorkspaceMembership;
    // Conflicting duplicates for the same exact identity are one choice. Conflicting player
    // bindings stay distinct and therefore can never be silently chosen as the sole context.
    if (!found.has(key)) found.set(key, {
      ...choice,
      teamLabel: displayLabel(named.teamName) ?? displayLabel(named.teamLabel) ?? `Team ${row.teamId}`,
      seasonLabel: displayLabel(named.seasonLabel) ?? `Season ${row.seasonId}`,
      clubLabel: displayLabel(named.clubName) ?? displayLabel(named.clubLabel),
      roleLabel: labels[row.role],
    });
  }
  return [...found.values()];
}
export function createWorkspaceContextPreference(apiBaseUrl: string, principal: Principal, context: WorkspaceContextSelection): WorkspaceContextPreference {
  const clean = copySelection(context);
  if (!validPrincipal(principal) || !selection(clean)) throw new Error('Choose a current workspace context.');
  return { schemaVersion: 1, apiBaseUrl: apiIdentity(apiBaseUrl), accountId: principal.accountId, issuer: principal.issuer, subject: principal.subject, context: clean };
}
/** Public preference metadata only; the same key lifecycle must never be used to store grants. */
export function workspaceContextPreferenceKey(apiBaseUrl: string, principal: Principal): string {
  if (!validPrincipal(principal)) throw new Error('A current service identity is required.');
  return `longball.context-preference.v1:${encodeURIComponent(JSON.stringify([apiIdentity(apiBaseUrl), principal.accountId, principal.issuer, principal.subject]))}`;
}
function parsePreference(value: unknown): WorkspaceContextPreference | null {
  if (!object(value) || !exact(value, ['schemaVersion', 'apiBaseUrl', 'accountId', 'issuer', 'subject', 'context']) || value.schemaVersion !== 1 || !identifier(value.accountId) || !identifier(value.issuer) || !identifier(value.subject) || typeof value.apiBaseUrl !== 'string' || !selection(value.context)) return null;
  try {
    if (apiIdentity(value.apiBaseUrl) !== value.apiBaseUrl) return null;
    return { schemaVersion: 1, apiBaseUrl: value.apiBaseUrl, accountId: value.accountId, issuer: value.issuer, subject: value.subject, context: copySelection(value.context) };
  } catch { return null; }
}
export interface ResolveWorkspaceContextInput {
  apiBaseUrl: string;
  principal: Principal;
  memberships: Membership[];
  nowMs: number;
  preference?: unknown;
  /** Fully selected by the user; never synthesise this from a preferred role. */
  selected?: WorkspaceContextSelection | null;
  /** Initial navigation hints may reject an incompatible default, not grant or choose a role. */
  initialRole?: Role;
  teamId?: string;
  seasonId?: string;
}
export function resolveWorkspaceContext(input: ResolveWorkspaceContextInput): { choices: WorkspaceContextChoice[]; selected: WorkspaceContextChoice | null; preferenceValid: boolean } {
  const choices = workspaceContextChoices(input.principal, input.memberships, input.nowMs);
  const find = (candidate: WorkspaceContextSelection | null | undefined) => candidate ? choices.find(item => workspaceContextKey(item) === workspaceContextKey(candidate)) ?? null : null;
  const matchesHints = (candidate: WorkspaceContextSelection) => (!input.initialRole || candidate.role === input.initialRole) && (!input.teamId || candidate.teamId === input.teamId) && (!input.seasonId || candidate.seasonId === input.seasonId);
  const stored = parsePreference(input.preference);
  let sameIdentity = false;
  try {
    const currentApi = apiIdentity(input.apiBaseUrl);
    sameIdentity = Boolean(stored && stored.apiBaseUrl === currentApi && stored.accountId === input.principal.accountId && stored.issuer === input.principal.issuer && stored.subject === input.principal.subject);
  } catch { return { choices: [], selected: null, preferenceValid: false }; }
  const remembered = sameIdentity ? find(stored?.context) : null;
  const preferenceValid = Boolean(remembered);
  const explicit = find(input.selected);
  // An explicit invalid selection is not an invitation to silently fall back to another role.
  if (input.selected) return { choices, selected: explicit, preferenceValid };
  if (remembered && matchesHints(remembered)) return { choices, selected: remembered, preferenceValid };
  return { choices, selected: choices.length === 1 && matchesHints(choices[0]) ? choices[0] : null, preferenceValid };
}
