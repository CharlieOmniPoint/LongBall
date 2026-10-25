import type { Membership, Principal } from '@longball/application/access';
import { attachWorkspaceValue, sameWorkspaceBinding, type BoundWorkspaceValue, type WorkspaceBinding } from '@longball/application/workspace-boundary';

/** Keep a same-context form mounted only after fresh authority validates its new request generation. */
export function rebindWorkspaceRefresh<T>(cached: BoundWorkspaceValue<T> | null, previous: WorkspaceBinding | null, next: WorkspaceBinding, principal: Principal, memberships: Membership[], nowMs: number): BoundWorkspaceValue<T> | null {
  if (!cached || !previous || !Number.isSafeInteger(next.generation) || next.generation <= previous.generation || !sameWorkspaceBinding(cached.binding, previous) || !sameWorkspaceBinding({ ...previous, generation: next.generation }, next)) return null;
  return attachWorkspaceValue(next, next, principal, memberships, nowMs, cached.value);
}

export interface AcceptedWorkspaceRefresh {
  source: WorkspaceBinding | null;
  path: string;
  /** Exact serialized body actually sent, including a protected replay. */
  bodyJson: string;
}

const responseCommands = new Set(['fixture.response_recorded', 'training.response_recorded']);
const attendanceCommands = new Set(['fixture.attendance_recorded', 'training.attendance_recorded']);
const scopedPreparationResources = ['preparation', 'records', 'player-stats'] as const;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/**
 * After an accepted receipt, narrow only the four frequent preparation edits.
 * Both authority checks and the normal generation/rebinding boundary remain in
 * the caller. Records carry projected RSVP/attendance evidence and stats carry
 * its projection revision, so neither can be omitted. Team overview, match
 * recording, community and configuration have no changed fields for these edits.
 * Unknown commands, paths, fields or context changes require the full refresh.
 */
export function workspaceMutationRefreshResources(request: AcceptedWorkspaceRefresh | undefined, previous: WorkspaceBinding | null, next: WorkspaceBinding): typeof scopedPreparationResources | null {
  const source = request?.source;
  if (!request || !source || source.role !== 'manager' || !sameWorkspaceBinding(source, previous) || !Number.isSafeInteger(next.generation) || next.generation <= source.generation || !sameWorkspaceBinding({ ...source, generation: next.generation }, next)) return null;
  try {
    const url = new URL(request.path, 'https://workspace.invalid');
    if (!request.path.startsWith('/v1/') || url.origin !== 'https://workspace.invalid' || url.hash || url.pathname !== `/v1/teams/${encodeURIComponent(source.teamId)}/preparation` || [...url.searchParams].length !== 1 || url.searchParams.get('seasonId') !== source.seasonId || request.bodyJson.length > 32_000) return null;
    const body: unknown = JSON.parse(request.bodyJson);
    if (!object(body) || Object.keys(body).length !== 1 || !object(body.command)) return null;
    const command = body.command, type = command.type;
    if (typeof type !== 'string' || !responseCommands.has(type) && !attendanceCommands.has(type)) return null;
    const target = type.startsWith('fixture.') ? 'fixtureId' : 'trainingId';
    const valueKey = responseCommands.has(type) ? 'response' : 'attendance';
    const expectedKeys = ['id', 'expectedRevision', 'type', target, 'profileId', valueKey];
    if (Object.keys(command).length !== expectedKeys.length || !expectedKeys.every(key => Object.hasOwn(command, key)) || !['id', target, 'profileId'].every(key => typeof command[key] === 'string' && command[key] !== '') || !Number.isSafeInteger(command.expectedRevision) || Number(command.expectedRevision) < 0) return null;
    const values = valueKey === 'response' ? ['available', 'unavailable', 'unsure', 'no_reply'] : ['present', 'absent', 'not_recorded'];
    return values.includes(String(command[valueKey])) ? scopedPreparationResources : null;
  } catch { return null; }
}
