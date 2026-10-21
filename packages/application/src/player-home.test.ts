import { describe, expect, it } from 'vitest';
import { selectPlayerHome, type PlayerHomeCommunity, type PlayerHomeMatch, type PlayerHomeOwn } from './player-home';
const now = Date.parse('2026-10-21T12:00:00Z');
const scope = { teamId: 'team-a', seasonId: '2026-27', playerId: 'player-01' };
const own = (): PlayerHomeOwn => ({ team: { id: scope.teamId }, season: { id: scope.seasonId }, profile: { id: 'player-01:2026-27', playerId: scope.playerId }, fixtures: [{ id: 'match-a', opponent: 'Fictional Greens', playedDate: '2026-10-24', kickoff: '10:00', venue: 'Fictional pitch', status: 'scheduled', response: 'no_reply' }], training: [{ id: 'training-a', date: '2026-10-22', time: '18:00', venue: 'Fictional training pitch', expected: true, status: 'scheduled', response: 'available' }] });
const match = (changes: Partial<PlayerHomeMatch> = {}): PlayerHomeMatch => ({ matchId: 'match-a', audience: 'player', teamId: scope.teamId, seasonId: scope.seasonId, ownRecord: { playerId: scope.playerId }, status: 'first_half_running', sharingRestricted: false, score: { for: 2, against: 1 }, opponent: 'Fictional Greens', playedDate: '2026-10-24', lastRecorderSyncAt: now - 1000, ...changes });
const community = (): PlayerHomeCommunity => ({ allowed: true, matches: [], gallery: [] });
function vote(): PlayerHomeCommunity['matches'][number] {
  return { id: 'finished-a', label: 'Recorded match', playedAtMs: now - 3_600_000, sharingAllowed: true, fullTimeAtMs: now - 600_000, finishQuality: 'trusted', cutoffAtMs: now + 600_000, cutoffSource: 'explicit_fictional_setting', deadlineAtMs: now + 1_200_000, mayVote: true, ownChoice: null, candidates: [{ id: 'player-02', label: 'Player02' }], award: null };
}
const input = () => ({ own: own(), community: community(), matches: [] as PlayerHomeMatch[], scope, nowMs: now });

describe('UI05 own-player home', () => {
  it('finds actual expected next training without guessing attendance or exposing teammate fields', () => {
    const home = selectPlayerHome(input());
    expect(home.next).toEqual({ id: 'training-a', kind: 'training', title: 'Team training', date: '2026-10-22', time: '18:00', venue: 'Fictional training pitch', response: 'available' });
    expect(home.next).not.toHaveProperty('attendance');
    expect(home.next).not.toHaveProperty('selectedPlayerIds');
  });
  it('requires the exact own team, season and linked player, accepting full season profile IDs only through explicit playerId', () => {
    for (const patch of [{ team: { id: 'other' } }, { season: { id: 'other' } }, { profile: { id: scope.playerId, playerId: 'other' } }, { profile: { id: 'player-01:2026-27' } }]) {
      expect(selectPlayerHome({ ...input(), own: { ...own(), ...patch } })).toMatchObject({ ownAvailable: false, next: null, nextCandidates: [] });
    }
    expect(selectPlayerHome({ ...input(), own: { ...own(), profile: { id: scope.playerId } } }).ownAvailable).toBe(true);
  });
  it('excludes cancelled/postponed fixtures and unneeded or held training without creating an event', () => {
    const value = own(); value.fixtures[0].status = 'postponed'; value.training[0].expected = false;
    expect(selectPlayerHome({ ...input(), own: value }).next).toBeNull();
    value.training[0].expected = true; value.training[0].status = 'held';
    expect(selectPlayerHome({ ...input(), own: value }).nextCandidates).toEqual([]);
  });
  it('keeps date/time omissions and same-day order unknown, with London day comparison', () => {
    const value = own(); value.fixtures[0].playedDate = '2026-10-22'; value.fixtures[0].kickoff = null;
    const ambiguous = selectPlayerHome({ ...input(), own: value });
    expect(ambiguous.next).toBeNull(); expect(ambiguous.needsOrdering).toBe(true); expect(ambiguous.nextCandidates).toHaveLength(2);
    value.fixtures[0].playedDate = 'not-a-date';
    expect(selectPlayerHome({ ...input(), own: value }).undated[0].date).toBeNull();
    expect(selectPlayerHome({ ...input(), nowMs: Date.parse('2026-10-24T23:30:00Z') }).today).toBe('2026-10-25');
  });
  it('omits already accepted active/completed/abandoned fixtures from next event but ignores foreign-scope matches', () => {
    const value = own(); value.training = [];
    for (const status of ['first_half_running', 'completed', 'abandoned']) expect(selectPlayerHome({ ...input(), own: value, matches: [match({ status })] }).next).toBeNull();
    expect(selectPlayerHome({ ...input(), own: value, matches: [match({ teamId: 'other' })] }).next?.id).toBe('match-a');
  });
  it('shows only explicit permitted player scores and never falls back to a raw manager state', () => {
    expect(selectPlayerHome({ ...input(), matches: [match()] }).liveMatch).toMatchObject({ matchId: 'match-a', score: { for: 2, against: 1 }, lastRecorderSyncAt: now - 1000 });
    expect(selectPlayerHome({ ...input(), matches: [match({ fixture: { opponent: 'Actual scoped fixture' } })] }).liveMatch?.opponent).toBe('Actual scoped fixture');
    const denied: Partial<PlayerHomeMatch>[] = [{ audience: 'manager' }, { teamId: 'other' }, { seasonId: 'other' }, { teamId: undefined }, { ownRecord: { playerId: 'other' } }, { sharingRestricted: true }, { sharingRestricted: undefined }, { score: null }, { score: { for: -1, against: 1 } }, { score: { for: 0.5, against: 1 } }, { status: 'preparation' }];
    for (const patch of denied) {
      const row = { ...match(patch), state: { score: { for: 99, against: 99 }, intervals: ['private teammate evidence'] } };
      expect(selectPlayerHome({ ...input(), matches: [row] }).liveMatch).toBeNull();
    }
  });
  it('does not choose a current game from multiple active games based on upload timestamp', () => {
    const home = selectPlayerHome({ ...input(), matches: [match(), match({ matchId: 'match-b', lastRecorderSyncAt: now })] });
    expect(home.liveMatch).toBeNull(); expect(home.multipleActiveMatches).toBe(true);
  });
  it('keeps a vote only while the filtered DTO permits it and its actual supplied cutoff has not arrived', () => {
    const view = community(); view.matches = [vote()];
    expect(selectPlayerHome({ ...input(), community: view }).vote?.id).toBe('finished-a');
    expect(selectPlayerHome({ ...input(), community: view, nowMs: vote().cutoffAtMs! }).vote).toBeNull();
    expect(selectPlayerHome({ ...input(), community: { ...view, allowed: false } }).vote).toBeNull();
    for (const patch of [{ cutoffAtMs: null }, { deadlineAtMs: null }, { cutoffSource: 'unresolved' as const }, { finishQuality: 'review_required' as const }]) {
      expect(selectPlayerHome({ ...input(), community: { ...view, matches: [{ ...vote(), ...patch }] } }).vote).toBeNull();
    }
    view.matches[0].mayVote = false;
    expect(selectPlayerHome({ ...input(), community: view }).vote).toBeNull();
  });
  it('selects a permitted photo using recorded played time, without manufacturing a date or asset access', () => {
    const view = community();
    const photo = { id: 'photo-a', matchId: 'finished-a', matchLabel: 'Recorded match', playedAtMs: now - 1000, uploaderAccountId: 'uploader', uploaderLabel: 'Uploader', version: 1, art: 'pitch' as const, caption: 'Generated illustration' };
    view.gallery = [photo, { ...photo, id: 'photo-b', playedAtMs: now - 100 }, { ...photo, id: 'invalid', playedAtMs: Number.NaN }];
    expect(selectPlayerHome({ ...input(), community: view }).latestPhoto?.id).toBe('photo-b');
    expect(selectPlayerHome({ ...input(), community: { ...view, allowed: false } }).latestPhoto).toBeNull();
    expect(selectPlayerHome({ ...input(), community: view }).latestPhoto).not.toHaveProperty('url');
  });
  it('does not mutate incoming own, match or community records during selection', () => {
    const value = { ...input(), matches: [match()] }, before = JSON.stringify(value);
    selectPlayerHome(value);
    expect(JSON.stringify(value)).toBe(before);
  });
});
