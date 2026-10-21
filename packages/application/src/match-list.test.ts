import { describe, expect, it } from 'vitest';
import { appendMatchListPage, compareMatchIds, continueMatchList, MatchListAuthorityDenied, parseMatchListPage, type MatchListPage } from './match-list';
import type { Principal, Membership } from './access';
import type { WorkspaceBinding } from './workspace-boundary';
const ticket: WorkspaceBinding = { generation: 1, apiBaseUrl: 'https://api.example.test', accountId: 'manager', issuer: 'issuer', subject: 'subject', teamId: 'team', seasonId: 'season', role: 'manager', playerId: null };
const principal: Principal = { accountId: 'manager', issuer: 'issuer', subject: 'subject', identityClassification: 'adult_individual', adultVerified: true, strongAuth: true, authenticatedAt: 0, status: 'active' };
const memberships: Membership[] = [{ accountId: 'manager', teamId: 'team', seasonId: 'season', role: 'manager' }];
const item = (matchId: string) => ({ matchId, teamId: 'team', seasonId: 'season', audience: 'manager' });
const page = (ids: string[], nextCursor: string | null): MatchListPage<ReturnType<typeof item>> => ({ items: ids.map(item), nextCursor, serverTime: '2026-10-21T12:00:00.000Z' });
describe('authorised Match Centre continuation', () => {
  it('appends only a new ordered page and carries the next cursor and evidence time', async () => {
    const paths: string[] = [], cached = { binding: ticket, value: page(['m001', 'm002'], 'opaque_cursor') };
    const result = await continueMatchList(cached, { me: async () => ({ principal, memberships }), request: async path => { paths.push(path); return page(['m003'], null); }, currentBinding: () => ticket, sessionCurrent: async () => true, now: () => 10 });
    expect(result?.value.items.map(value => value.matchId)).toEqual(['m001', 'm002', 'm003']); expect(result?.value.nextCursor).toBeNull(); expect(cached.value.items).toHaveLength(2);
    expect(paths).toEqual(['/v1/teams/team/matches?seasonId=season&cursor=opaque_cursor']);
  });
  it('preserves existing punctuated/long identifiers and database Unicode order across pages', () => {
    const long = `fixture.preview:one@v2-${'x'.repeat(2000)}`;
    const first = parseMatchListPage(page([long], 'opaque'), ticket);
    const second = page(['fixture.z-next', '\ue000', '\u{10000}'], null);
    expect(appendMatchListPage(first, second, ticket).items.map(item => item.matchId)).toEqual([long, 'fixture.z-next', '\ue000', '\u{10000}']);
    expect(compareMatchIds('\ue000', '\u{10000}')).toBeLessThan(0);
    expect(parseMatchListPage({ ...first, nextCursor: 'a'.repeat(3000) }, ticket).nextCursor).toHaveLength(3000);
  });
  it('discards a late response after another role, team or generation opens', async () => {
    let current: WorkspaceBinding | null = ticket;
    const result = await continueMatchList({ binding: ticket, value: page(['m001'], 'opaque') }, { me: async () => ({ principal, memberships }), request: async () => { current = { ...ticket, generation: 2, teamId: 'other-team' }; return page(['m002'], null); }, currentBinding: () => current, sessionCurrent: async () => true, now: () => 10 });
    expect(result).toBeNull();
  });
  it('does not request data after current membership is revoked or session is locked', async () => {
    let reads = 0;
    const port = { me: async () => ({ principal, memberships: memberships.map(value => ({ ...value, revokedAt: 5 })) }), request: async () => { reads++; return page(['m002'], null); }, currentBinding: () => ticket, sessionCurrent: async () => true, now: () => 10 };
    await expect(continueMatchList({ binding: ticket, value: page(['m001'], 'opaque') }, port)).rejects.toBeInstanceOf(MatchListAuthorityDenied);
    expect(await continueMatchList({ binding: ticket, value: page(['m001'], 'opaque') }, { ...port, sessionCurrent: async () => false })).toBeNull(); expect(reads).toBe(0);
  });
  it('rejects wrong scope/private child payloads, malformed pages and non-progressing continuation', () => {
    for (const patch of [{ teamId: 'other' }, { seasonId: 'other' }, { audience: 'spectator' }]) expect(() => parseMatchListPage({ ...page(['m001'], null), items: [{ ...item('m001'), ...patch }] }, ticket)).toThrow();
    expect(() => parseMatchListPage({ ...page(['m001'], null), items: [{ ...item('m001'), audience: 'player', state: {} }] }, { ...ticket, role: 'player' })).toThrow();
    for (const value of [page([], 'opaque'), page(['m002', 'm001'], null), page(['m001', 'm001'], null), { ...page(['m001'], null), serverTime: 'unknown' }, { ...page(['m001'], null), nextCursor: 'https://evil.test/' }]) expect(() => parseMatchListPage(value, ticket)).toThrow();
    expect(() => appendMatchListPage(page(['m001'], 'same'), page(['m002'], 'same'), ticket)).toThrow('position');
    expect(() => appendMatchListPage(page(['m002'], 'cursor'), page(['m002'], null), ticket)).toThrow('position');
  });
});
