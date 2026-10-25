import type { Membership, Principal } from './access';
import { compareMatchIds, parseMatchListPage, type MatchListItem, type MatchListPage } from './match-list';
import { attachWorkspaceValue, sameWorkspaceBinding, workspaceBindingIsCurrent, type BoundWorkspaceValue, type WorkspaceBinding } from './workspace-boundary';

export interface SharedMatchRefreshItem extends MatchListItem { status?: string; state?: { status?: string } }
export const isActiveSharedMatch = (item: SharedMatchRefreshItem) => ['first_half_running', 'first_half_paused', 'half_time', 'second_half_running', 'second_half_paused'].includes(item.status ?? item.state?.status ?? '');
export class SharedMatchRefreshAuthorityDenied extends Error { readonly authorityDenied = true; }
export interface SharedMatchRefreshPort {
  me: (signal: AbortSignal) => Promise<{ principal: Principal; memberships: Membership[] }>;
  request: (path: string, signal: AbortSignal) => Promise<unknown>;
  currentBinding: () => WorkspaceBinding | null;
  sessionCurrent: (ticket: WorkspaceBinding) => Promise<boolean>;
  now: () => number;
}
/** Incoming authorised projections replace by ID, including equal-revision policy changes.
 * The separately loaded keyset page and its cursor are never rewritten. */
export function mergeSharedMatchViews<T extends SharedMatchRefreshItem>(paged: readonly T[], refreshed: readonly T[]): T[] {
  const updates = new Map(refreshed.map(item => [item.matchId, item]));
  return [...paged.map(item => { const replacement = updates.get(item.matchId); updates.delete(item.matchId); return replacement ?? item; }), ...updates.values()];
}
/** Prioritise all active games regardless of their position in historical keyset pages.
 * A disappeared active game is read once at its exact ID to capture final/abandoned state. */
export async function refreshSharedMatchViews<T extends SharedMatchRefreshItem>(ticket: WorkspaceBinding, previous: readonly T[], port: SharedMatchRefreshPort, signal: AbortSignal): Promise<{ identity: { principal: Principal; memberships: Membership[] }; matches: BoundWorkspaceValue<T[]> } | null> {
  const current = async () => !signal.aborted && sameWorkspaceBinding(ticket, port.currentBinding()) && await port.sessionCurrent(ticket) && !signal.aborted && sameWorkspaceBinding(ticket, port.currentBinding());
  if (!await current()) return null;
  const identity = await port.me(signal);
  if (!await current()) return null;
  if (!workspaceBindingIsCurrent(ticket, identity.principal, identity.memberships, port.now())) throw new SharedMatchRefreshAuthorityDenied('Current team access changed. Private shared views were closed.');
  const active: T[] = [], cursors = new Set<string>(); let cursor: string | null = null; let serverTime = '';
  const root = `/v1/teams/${encodeURIComponent(ticket.teamId)}/matches?seasonId=${encodeURIComponent(ticket.seasonId)}&status=active&limit=100`;
  do {
    const page: MatchListPage<T> = parseMatchListPage<T>(await port.request(`${root}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, signal), ticket);
    if (!await current()) return null;
    if (page.items.some(item => !isActiveSharedMatch(item) || active.some(prior => prior.matchId === item.matchId))) throw new Error('The service returned an invalid active-match page. The last confirmed view is retained.');
    if (active.length && page.items.length && compareMatchIds(page.items[0].matchId, active.at(-1)!.matchId) <= 0) throw new Error('The active-match page changed its ordered position. The last confirmed view is retained.');
    active.push(...page.items); cursor = page.nextCursor; serverTime = page.serverTime;
    if (cursor && cursors.has(cursor)) throw new Error('The active-match page repeated its cursor. The last confirmed view is retained.');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  const activeIds = new Set(active.map(item => item.matchId));
  const retired = previous.filter(item => !isActiveSharedMatch(item));
  for (const before of previous.filter(item => isActiveSharedMatch(item) && !activeIds.has(item.matchId))) {
    const response = await port.request(`/v1/matches/${encodeURIComponent(before.matchId)}`, signal);
    if (!await current()) return null;
    // Reuse the page role/scope boundary without synthesising recording freshness.
    const next = parseMatchListPage<T>({ items: [response], nextCursor: null, serverTime }, ticket).items[0];
    if (next.matchId !== before.matchId) throw new Error('The refreshed match differs from the requested game. The last confirmed view is retained.');
    retired.push(next);
  }
  if (!await current()) return null;
  const matches = attachWorkspaceValue(ticket, port.currentBinding(), identity.principal, identity.memberships, port.now(), mergeSharedMatchViews(retired, active));
  return matches ? { identity, matches } : null;
}

/** Sweep one bounded history page on the slower related-data cadence. Only rows
 * already in the visible loaded window are replaced; this never loads more UI
 * rows or rewrites its keyset cursor. Large history is revalidated in batches. */
export async function refreshSharedHistoryPage<T extends SharedMatchRefreshItem>(ticket: WorkspaceBinding, known: readonly T[], cursor: string | null, identity: { principal: Principal; memberships: Membership[] }, port: SharedMatchRefreshPort, signal: AbortSignal): Promise<{ matches: BoundWorkspaceValue<T[]>; nextCursor: string | null } | null> {
  const current = async () => !signal.aborted && sameWorkspaceBinding(ticket, port.currentBinding()) && await port.sessionCurrent(ticket) && !signal.aborted && sameWorkspaceBinding(ticket, port.currentBinding());
  if (!known.length || !await current()) return null;
  if (!workspaceBindingIsCurrent(ticket, identity.principal, identity.memberships, port.now())) throw new SharedMatchRefreshAuthorityDenied('Current team access changed. Private shared views were closed.');
  const path = `/v1/teams/${encodeURIComponent(ticket.teamId)}/matches?seasonId=${encodeURIComponent(ticket.seasonId)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
  const page = parseMatchListPage<T>(await port.request(path, signal), ticket);
  if (!await current()) return null;
  if (cursor !== null && page.nextCursor === cursor) throw new Error('The history refresh repeated its cursor. The last confirmed view is retained.');
  const knownIds = new Set(known.map(item => item.matchId));
  const highestKnownId = known.reduce((last, item) => compareMatchIds(item.matchId, last) > 0 ? item.matchId : last, '');
  const updates = page.items.filter(item => knownIds.has(item.matchId));
  const matches = attachWorkspaceValue(ticket, port.currentBinding(), identity.principal, identity.memberships, port.now(), mergeSharedMatchViews(known, updates));
  const reachedKnownBoundary = page.items.length > 0 && compareMatchIds(page.items.at(-1)!.matchId, highestKnownId) >= 0;
  return matches ? { matches, nextCursor: reachedKnownBoundary ? null : page.nextCursor } : null;
}
