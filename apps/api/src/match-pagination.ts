import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { AccessError, assertAdultAuthority, currentMemberships, type Membership, type Principal } from '../../../packages/application/src/access';

export interface MatchPageQuery { limit: number; cursor: string | null }
export interface MatchPageScope { principal: Pick<Principal, 'accountId' | 'issuer' | 'subject'>; teamId: string; seasonId: string; role: Membership['role']; playerId: string | null }
const invalid = (): never => { throw new AccessError('INVALID_PAGE', 400, 'Use the original cursor for this account, team, season and selected role, with a page limit from 1 to 100.'); };
const validId = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 150 && !/[^A-Za-z0-9_-]/.test(value);
export function parseMatchPageQuery(params: URLSearchParams): MatchPageQuery {
  for (const key of params.keys()) if (!['seasonId', 'limit', 'cursor'].includes(key) || params.getAll(key).length !== 1) invalid();
  const rawLimit = params.get('limit');
  if (rawLimit !== null && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit)) invalid();
  const cursor = params.get('cursor');
  if (cursor !== null && (!cursor.length || cursor.length > 1024 || /[^A-Za-z0-9_-]/.test(cursor))) invalid();
  return { limit: rawLimit === null ? 25 : Number(rawLimit), cursor };
}
export function matchPageAudience(principal: Principal, memberships: Membership[], teamId: string, seasonId: string, requestedRole: string | undefined, nowMs: number): Membership {
  const available = currentMemberships(principal, memberships, nowMs).filter(item => item.teamId === teamId && item.seasonId === seasonId && ['manager', 'player', 'spectator'].includes(item.role));
  const chosen = requestedRole ? available.find(item => item.role === requestedRole) : available.find(item => item.role === 'manager') ?? available.find(item => item.role === 'player') ?? available[0];
  if (!chosen) throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
  if (chosen.role === 'manager') assertAdultAuthority(principal, false, nowMs);
  return chosen;
}
const binding = (scope: MatchPageScope) => createHash('sha256').update(JSON.stringify(['longball.matches.id-asc.v1', scope.principal.accountId, scope.principal.issuer, scope.principal.subject, scope.teamId, scope.seasonId, scope.role, scope.playerId])).digest('base64url');
/** An opaque position, never a capability. Every page rechecks membership before a scoped SQL query. */
export function matchPageCursor(scope: MatchPageScope, afterId: string): string {
  if (!validId(afterId)) invalid();
  return Buffer.from(JSON.stringify({ version: 1, binding: binding(scope), afterId })).toString('base64url');
}
export function matchPagePosition(scope: MatchPageScope, query: MatchPageQuery): string | null {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) invalid();
  if (query.cursor === null) return null;
  try {
    if (query.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) invalid();
    const bytes = Buffer.from(query.cursor, 'base64url');
    if (bytes.toString('base64url') !== query.cursor) invalid();
    const cursor = JSON.parse(bytes.toString('utf8'));
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || Object.keys(cursor).sort().join(',') !== 'afterId,binding,version' || cursor.version !== 1 || cursor.binding !== binding(scope) || !validId(cursor.afterId)) invalid();
    return cursor.afterId;
  } catch { return invalid(); }
}
