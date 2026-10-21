import { AccessError } from './access';

export type TeamPrivilege = 'uploads' | 'invitations';
export interface TeamPrivilegeRestriction { accountId: string; privilege: TeamPrivilege; suspended: boolean }
export interface TeamPrivilegeState { schemaVersion: 1; teamId: string; revision: number; restrictions: TeamPrivilegeRestriction[] }
export interface TeamPrivilegeCommand {
  id: string;
  type: 'privilege.suspended' | 'privilege.reinstated';
  expectedRevision: number;
  targetAccountId: string;
  privilege: TeamPrivilege;
  reasonCode: string;
  privateNote: string | null;
  confirm: true;
}
export interface OwnTeamPrivileges { kind: 'own-team-privileges'; teamId: string; seasonId: string; revision: number; uploadsAllowed: boolean; invitationsAllowed: boolean }
export interface TeamPrivilegesView {
  kind: 'team-privileges'; teamId: string; seasonId: string; revision: number;
  own: OwnTeamPrivileges;
  targets: { accountId: string; label: string; uploadsSuspended: boolean; invitationsSuspended: boolean }[];
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,150}$/.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const invalid = (): never => { throw new AccessError('INVALID_TEAM_PRIVILEGE_COMMAND', 400, 'Use an exact confirmed privilege decision, current revision and operational reason code.'); };
export function parseTeamPrivilegeCommand(value: unknown): TeamPrivilegeCommand {
  if (!object(value) || Object.keys(value).some(key => !['id', 'type', 'expectedRevision', 'targetAccountId', 'privilege', 'reasonCode', 'privateNote', 'confirm'].includes(key)) ||
      !id(value.id) || !id(value.targetAccountId) || !integer(value.expectedRevision) || !['privilege.suspended', 'privilege.reinstated'].includes(String(value.type)) ||
      !['uploads', 'invitations'].includes(String(value.privilege)) || typeof value.reasonCode !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(value.reasonCode) ||
      value.confirm !== true || !(value.privateNote === undefined || value.privateNote === null || typeof value.privateNote === 'string' && value.privateNote.length <= 1000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.privateNote))) return invalid();
  return { id: value.id, type: value.type as TeamPrivilegeCommand['type'], expectedRevision: value.expectedRevision, targetAccountId: value.targetAccountId, privilege: value.privilege as TeamPrivilege, reasonCode: value.reasonCode, privateNote: typeof value.privateNote === 'string' ? value.privateNote.trim() || null : null, confirm: true };
}
export function createTeamPrivilegeState(teamId: string): TeamPrivilegeState {
  if (!id(teamId)) return invalid();
  return { schemaVersion: 1, teamId, revision: 0, restrictions: [] };
}
export function validateTeamPrivilegeState(value: unknown): asserts value is TeamPrivilegeState {
  if (!object(value) || Object.keys(value).some(key => !['schemaVersion', 'teamId', 'revision', 'restrictions'].includes(key)) || value.schemaVersion !== 1 || !id(value.teamId) || !integer(value.revision) || !Array.isArray(value.restrictions) || value.restrictions.some(row => !object(row) || Object.keys(row).some(key => !['accountId', 'privilege', 'suspended'].includes(key)) || !id(row.accountId) || !['uploads', 'invitations'].includes(String(row.privilege)) || typeof row.suspended !== 'boolean') || new Set(value.restrictions.map(row => JSON.stringify([row.accountId, row.privilege]))).size !== value.restrictions.length) throw new AccessError('TEAM_PRIVILEGES_RECONCILIATION_REQUIRED', 409, 'The team privilege record needs authorised reconciliation. Preserve the existing record.');
}
export function teamPrivilegeAllowed(state: TeamPrivilegeState, accountId: string, privilege: TeamPrivilege): boolean {
  validateTeamPrivilegeState(state);
  return !state.restrictions.some(row => row.accountId === accountId && row.privilege === privilege && row.suspended);
}
/** Authorisation, team membership, receipt and immutable audit are committed by the service transaction. */
export function applyTeamPrivilegeCommand(state: TeamPrivilegeState, command: TeamPrivilegeCommand): TeamPrivilegeState {
  validateTeamPrivilegeState(state);
  const input = parseTeamPrivilegeCommand(command);
  if (input.expectedRevision !== state.revision) throw new AccessError('TEAM_PRIVILEGE_REVISION_CONFLICT', 409, 'Team privileges changed. Refresh and review before confirming this decision.');
  const suspended = input.type === 'privilege.suspended';
  if (teamPrivilegeAllowed(state, input.targetAccountId, input.privilege) === !suspended) throw new AccessError('TEAM_PRIVILEGE_ALREADY_SET', 409, 'This privilege already has the requested status. Refresh the current team decision.');
  const restrictions = state.restrictions.filter(row => row.accountId !== input.targetAccountId || row.privilege !== input.privilege);
  restrictions.push({ accountId: input.targetAccountId, privilege: input.privilege, suspended });
  return { schemaVersion: 1, teamId: state.teamId, revision: state.revision + 1, restrictions };
}
