import { describe, expect, it } from 'vitest';
import { mergeSharedMatchViews, refreshSharedHistoryPage, refreshSharedMatchViews, SharedMatchRefreshAuthorityDenied, type SharedMatchRefreshItem, type SharedMatchRefreshPort } from './shared-match-refresh';
import type { WorkspaceBinding } from './workspace-boundary';
import type { Membership, Principal } from './access';
const now = Date.parse('2026-10-21T12:00:00Z');
const ticket: WorkspaceBinding = { generation: 2, apiBaseUrl: 'https://api.example.test', accountId: 'spectator', issuer: 'issuer', subject: 'subject', teamId: 'team-a', seasonId: '2026-27', role: 'spectator', playerId: null };
const principal: Principal = { accountId: ticket.accountId, issuer: ticket.issuer, subject: ticket.subject, status: 'active', identityClassification: 'adult_individual', adultVerified: true, strongAuth: true, authenticatedAt: now };
const members: Membership[] = [{ accountId: ticket.accountId, teamId: ticket.teamId, seasonId: ticket.seasonId, role: 'spectator', expiresAt: now + 60_000, revokedAt: null }];
const item = (matchId: string, status = 'first_half_running'): SharedMatchRefreshItem => ({ matchId, teamId: ticket.teamId, seasonId: ticket.seasonId, audience: ticket.role, status });
const page = (items: SharedMatchRefreshItem[], nextCursor: string | null = null) => ({ items, nextCursor, serverTime: new Date(now).toISOString() });
const port = (request: SharedMatchRefreshPort['request']): SharedMatchRefreshPort => ({ me: async () => ({ principal, memberships: members }), request, currentBinding: () => ticket, sessionCurrent: async () => true, now: () => now });
describe('API06 shared active-match reads', () => {
  it('discovers an active game beyond historical pages, merges by ID and preserves loaded history/cursor separately', async () => {
    const reads: string[] = []; const value = await refreshSharedMatchViews<SharedMatchRefreshItem>(ticket, [], port(async path => { reads.push(path); return page([item('zz-live')]); }), new AbortController().signal);
    expect(reads).toEqual(['/v1/teams/team-a/matches?seasonId=2026-27&status=active&limit=100']);
    const historical = Array.from({ length: 108 }, (_, index) => item(`history-${index}`, 'completed'));
    expect(mergeSharedMatchViews(historical, value!.matches.value)).toHaveLength(109);
    expect(historical).toHaveLength(108); expect(mergeSharedMatchViews(historical, value!.matches.value).at(-1)?.matchId).toBe('zz-live');
  });
  it('continues active pages with their exact filter and refuses repeated cursors or protected manager state', async () => {
    const paths: string[] = [];
    const result = await refreshSharedMatchViews<SharedMatchRefreshItem>(ticket, [], port(async path => { paths.push(path); return paths.length === 1 ? page([item('a')], 'cursorOne') : page([item('b')]); }), new AbortController().signal);
    expect(result!.matches.value.map(row => row.matchId)).toEqual(['a', 'b']); expect(paths[1]).toContain('&status=active&limit=100&cursor=cursorOne');
    await expect(refreshSharedMatchViews<SharedMatchRefreshItem>(ticket, [], port(async () => page([item('a')], 'sameCursor')), new AbortController().signal)).rejects.toThrow('invalid active-match page');
    await expect(refreshSharedMatchViews<SharedMatchRefreshItem>(ticket, [], port(async () => page([{ ...item('a'), state: { status: 'first_half_running' } }])), new AbortController().signal)).rejects.toThrow('outside');
  });
  it('refreshes a no-longer-active game once so completion never leaves a false running state', async () => {
    const paths: string[] = [];
    const result = await refreshSharedMatchViews<SharedMatchRefreshItem>(ticket, [item('a')], port(async path => { paths.push(path); return path.includes('/teams/') ? page([]) : item('a', 'completed'); }), new AbortController().signal);
    expect(paths).toEqual(['/v1/teams/team-a/matches?seasonId=2026-27&status=active&limit=100', '/v1/matches/a']);
    expect(result!.matches.value[0].status).toBe('completed');
    const again = await refreshSharedMatchViews<SharedMatchRefreshItem>(ticket, result!.matches.value, port(async path => { expect(path).toContain('/teams/'); return page([]); }), new AbortController().signal);
    expect(again!.matches.value[0].status).toBe('completed');
  });
  it('closes changed membership before scoped reads and discards late replies after abort, logout or context switch', async () => {
    let called = false;
    await expect(refreshSharedMatchViews<SharedMatchRefreshItem>(ticket, [], { ...port(async () => { called = true; return page([]); }), me: async () => ({ principal, memberships: [] }) }, new AbortController().signal)).rejects.toBeInstanceOf(SharedMatchRefreshAuthorityDenied);
    expect(called).toBe(false);
    for (const reason of ['abort', 'scope', 'session']) {
      const controller = new AbortController(); let current: WorkspaceBinding | null = ticket, session = true;
      const value = await refreshSharedMatchViews<SharedMatchRefreshItem>(ticket, [], { ...port(async () => { if (reason === 'abort') controller.abort(); else if (reason === 'scope') current = { ...ticket, teamId: 'other' }; else session = false; return page([item('a')]); }), currentBinding: () => current, sessionCurrent: async () => session }, controller.signal);
      expect(value).toBeNull();
    }
  });
  it('applies current equal-revision withheld projections instead of retaining a previously shared score', () => {
    const old = { ...item('a'), revision: 2, score: { for: 3, against: 1 } };
    const fresh = { ...item('a'), revision: 2, sharingRestricted: true };
    expect(mergeSharedMatchViews<SharedMatchRefreshItem>([old], [fresh])[0]).not.toHaveProperty('score');
  });
});


describe('accepted history refresh without cursor loss', () => {
  it('revalidates completed scores and equal-revision sharing changes, replacing only known loaded rows', async () => {
    const known = [{ ...item('a', 'completed'), revision: 4, score: { for: 2, against: 1 } }, item('c', 'completed')];
    const next = { ...item('a', 'completed'), revision: 5, score: { for: 3, against: 1 } };
    const result = await refreshSharedHistoryPage<SharedMatchRefreshItem>(ticket, known, null, { principal, memberships: members }, port(async () => page([next, item('b', 'completed'), item('c', 'completed')])), new AbortController().signal);
    expect(result?.matches.value).toEqual([next, item('c', 'completed')]); expect(result?.nextCursor).toBeNull();
    const withheld = { ...item('a', 'completed'), revision: 5, sharingRestricted: true };
    const again = await refreshSharedHistoryPage<SharedMatchRefreshItem>(ticket, result!.matches.value, null, { principal, memberships: members }, port(async () => page([withheld, item('c', 'completed')])), new AbortController().signal);
    expect(again?.matches.value[0]).toEqual(withheld); expect(again?.matches.value[0]).not.toHaveProperty('score');
    expect(known[0]).toHaveProperty('score.for', 2);
  });
  it('sweeps bounded pages until the loaded window ends, then restarts without fetching or displaying new history rows', async () => {
    const known = [item('a', 'completed'), item('z', 'completed')], paths: string[] = [];
    const first = await refreshSharedHistoryPage(ticket, known, null, { principal, memberships: members }, port(async path => { paths.push(path); return page([item('a', 'completed'), item('b', 'completed')], 'nextHistory'); }), new AbortController().signal);
    expect(first?.nextCursor).toBe('nextHistory'); expect(first?.matches.value.map(row => row.matchId)).toEqual(['a', 'z']);
    const next = await refreshSharedHistoryPage(ticket, first!.matches.value, first!.nextCursor, { principal, memberships: members }, port(async path => { paths.push(path); return page([item('z', 'completed')], 'moreUnloadedHistory'); }), new AbortController().signal);
    expect(next?.nextCursor).toBeNull(); expect(paths).toEqual(['/v1/teams/team-a/matches?seasonId=2026-27&limit=100', '/v1/teams/team-a/matches?seasonId=2026-27&limit=100&cursor=nextHistory']);
  });
  it('never attaches a late history reply to another context or after background cancellation', async () => {
    for (const background of [true, false]) {
      let current: WorkspaceBinding | null = ticket; const controller = new AbortController();
      const result = await refreshSharedHistoryPage(ticket, [item('a', 'completed')], null, { principal, memberships: members }, { ...port(async () => { if (background) controller.abort(); else current = { ...ticket, role: 'player', playerId: 'other' }; return page([item('a', 'completed')]); }), currentBinding: () => current }, controller.signal);
      expect(result).toBeNull();
    }
  });
});
