import { type Membership, type Principal } from './access';
import { attachWorkspaceValue, sameWorkspaceBinding, workspaceBindingIsCurrent, type BoundWorkspaceValue, type WorkspaceBinding } from './workspace-boundary';

export interface MatchListItem { matchId: string; teamId?: string; seasonId?: string; audience: string; state?: unknown }
export interface MatchListPage<T extends MatchListItem> { items: T[]; nextCursor: string | null; serverTime: string }
export function parseMatchListPage<T extends MatchListItem>(value: unknown, scope: Pick<WorkspaceBinding, 'teamId' | 'seasonId' | 'role'>): MatchListPage<T> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The service match page is invalid.');
  const page = value as MatchListPage<T>;
  if (Object.keys(value).some(key => !['items', 'nextCursor', 'serverTime'].includes(key)) || !Array.isArray(page.items) || page.items.length > 100 || typeof page.serverTime !== 'string' || !Number.isFinite(Date.parse(page.serverTime)) || !(page.nextCursor === null || typeof page.nextCursor === 'string' && page.nextCursor.length >= 1 && page.nextCursor.length <= 1024 && !/[^A-Za-z0-9_-]/.test(page.nextCursor))) throw new Error('The service match page is invalid.');
  let previousId = '';
  for (const item of page.items) {
    if (!item || typeof item !== 'object' || typeof item.matchId !== 'string' || item.matchId.length < 1 || item.matchId.length > 150 || /[^A-Za-z0-9_-]/.test(item.matchId) || item.matchId <= previousId || item.teamId !== scope.teamId || item.seasonId !== scope.seasonId || item.audience !== scope.role || scope.role !== 'manager' && item.state !== undefined) throw new Error('The service returned match data outside the selected page, role or scope. The page was discarded.');
    previousId = item.matchId;
  }
  if (!page.items.length && page.nextCursor !== null) throw new Error('An empty match page cannot continue.');
  return page;
}
export function appendMatchListPage<T extends MatchListItem>(previous: MatchListPage<T>, next: MatchListPage<T>, scope: Pick<WorkspaceBinding, 'teamId' | 'seasonId' | 'role'>): MatchListPage<T> {
  parseMatchListPage(next, scope);
  const last = previous.items.at(-1)?.matchId;
  if (!previous.nextCursor || next.nextCursor === previous.nextCursor || last && next.items.some(item => item.matchId <= last)) throw new Error('The match continuation repeated or changed its ordered position. Refresh the accepted list.');
  return { items: [...previous.items, ...next.items], nextCursor: next.nextCursor, serverTime: next.serverTime };
}
export class MatchListAuthorityDenied extends Error { readonly authorityDenied = true; }
export interface MatchListPort {
  me: () => Promise<{ principal: Principal; memberships: Membership[] }>;
  request: (path: string) => Promise<unknown>;
  currentBinding: () => WorkspaceBinding | null;
  sessionCurrent: (ticket: WorkspaceBinding) => Promise<boolean>;
  now: () => number;
}
/** The cursor stays with its original protected-view binding. Late replies cannot append to another scope. */
export async function continueMatchList<T extends MatchListItem>(cached: BoundWorkspaceValue<MatchListPage<T>>, port: MatchListPort): Promise<BoundWorkspaceValue<MatchListPage<T>> | null> {
  const ticket = cached.binding, cursor = cached.value.nextCursor;
  if (!cursor || !sameWorkspaceBinding(ticket, port.currentBinding()) || !await port.sessionCurrent(ticket)) return null;
  const fresh = await port.me();
  if (!sameWorkspaceBinding(ticket, port.currentBinding()) || !await port.sessionCurrent(ticket)) return null;
  if (!workspaceBindingIsCurrent(ticket, fresh.principal, fresh.memberships, port.now())) throw new MatchListAuthorityDenied('Current service account or team access changed. Private match pages were closed; refresh the original authorised workspace.');
  const path = `/v1/teams/${encodeURIComponent(ticket.teamId)}/matches?seasonId=${encodeURIComponent(ticket.seasonId)}&cursor=${encodeURIComponent(cursor)}`;
  const next = parseMatchListPage<T>(await port.request(path), ticket);
  if (!sameWorkspaceBinding(ticket, port.currentBinding()) || !await port.sessionCurrent(ticket)) return null;
  return attachWorkspaceValue(ticket, port.currentBinding(), fresh.principal, fresh.memberships, port.now(), appendMatchListPage(cached.value, next, ticket));
}
