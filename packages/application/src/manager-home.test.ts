import { describe, expect, it } from 'vitest';
import { createMatch } from '@longball/domain';
import { romaFixture } from '@longball/testing';
import { createPreparationState } from './preparation';
import { createRecordsSeed, selectSeasonResults } from './records';
import { selectManagerHome, type ManagerHomeCommunity, type ManagerHomeRecords } from './manager-home';

const now = Date.parse('2026-10-21T12:00:00Z');
const records = (): ManagerHomeRecords => ({ results: selectSeasonResults(createRecordsSeed(), { actor: 'manager' }) });
const community = (): ManagerHomeCommunity => ({ allowed: true, reviewQueue: [], reviewConcerns: [] });
function match() {
  return createMatch({ matchId: 'synthetic-in-progress', players: romaFixture.players, selectedPlayerIds: romaFixture.players.slice(0, 9).map(player => player.id), pitchPlaces: 7, plannedHalfDurationMs: 1_500_000, fixedKeeperId: romaFixture.players[0].id });
}

describe('UI04 connected manager home selectors', () => {
  it('uses the actual next training and match dates without treating upload or entry time as schedule', () => {
    const state = createPreparationState();
    const home = selectManagerHome({ state, records: records(), community: community(), nowMs: now });
    expect(home.next).toMatchObject({ id: 'synthetic-training-1', kind: 'training', date: '2026-10-22', time: '18:00', title: 'Team training' });
    expect(home.upcoming.map(item => item.date)).toEqual(['2026-10-22', '2026-10-24', '2026-10-29', '2026-10-31', '2026-11-05']);
    expect(home.next?.prepared).toBe(false);
    expect(home.recentResults).toHaveLength(3);
  });

  it('does not invent an event when scheduled records are cancelled, postponed or in another season', () => {
    const state = createPreparationState();
    state.fixtures = state.fixtures.slice(0, 1); state.training = state.training.slice(0, 2);
    state.fixtures[0].status = 'postponed';
    state.training[0].status = 'cancelled';
    state.training[1].seasonId = 'another-season';
    const home = selectManagerHome({ state, records: null, community: null, nowMs: now });
    expect(home.next).toBeNull();
    expect(home.upcoming).toEqual([]);
    expect(home.repliesDue).toBe(0);
    expect(home.attendanceToRecord).toBe(0);
  });

  it('keeps same-day unknown times and exact ties explicit instead of preferring a match or inventing kickoff', () => {
    const state = createPreparationState();
    state.fixtures[0].playedDate = '2026-10-22';
    state.fixtures[0].kickoff = null;
    state.training = [state.training[0]];
    let home = selectManagerHome({ state, records: null, community: null, nowMs: now });
    expect(home.needsOrdering).toBe(true);
    expect(home.next).toBeNull();
    expect(home.nextCandidates).toHaveLength(2);
    expect(home.nextCandidates.find(item => item.kind === 'match')?.time).toBeNull();
    state.fixtures[0].kickoff = '17:00';
    home = selectManagerHome({ state, records: null, community: null, nowMs: now });
    expect(home.next?.kind).toBe('match');
    state.fixtures[0].kickoff = '18:00';
    home = selectManagerHome({ state, records: null, community: null, nowMs: now });
    expect(home.needsOrdering).toBe(true);
    expect(home.next).toBeNull();
  });

  it('uses the explicit pilot team date across the midnight/BST boundary, not the host timezone', () => {
    const state = createPreparationState();
    state.training = [{ ...state.training[0], date: '2026-10-25' }];
    const home = selectManagerHome({ state, records: null, community: null, nowMs: Date.parse('2026-10-24T23:30:00Z') });
    expect(home.today).toBe('2026-10-25');
    expect(home.next?.date).toBe('2026-10-25');
    expect(home.olderUnresolved.map(item => item.id)).toContain(state.fixtures[0].id);
    expect(home.timeZone).toBe('Europe/London');
  });

  it('counts unanswered responses separately from due selected/held attendance and excludes cancelled sessions', () => {
    const state = createPreparationState();
    const first = state.profiles[0].id, second = state.profiles[1].id;
    state.profiles = state.profiles.map((profile, index) => ({ ...profile, active: index < 2 }));
    state.fixtures[0] = { ...state.fixtures[0], playedDate: '2026-10-21', selectedProfileIds: [first], responses: { [first]: 'available' }, attendance: {} };
    state.training = [{ ...state.training[0], status: 'held', date: '2026-10-20', expectedProfileIds: [second], attendance: {} }, { ...state.training[1], status: 'cancelled' }];
    const home = selectManagerHome({ state, records: null, community: null, nowMs: now });
    expect(home.repliesDue).toBe(1);
    expect(home.attendanceToRecord).toBe(2);
    state.fixtures[0].attendance[first] = 'absent';
    state.training[0].attendance[second] = 'present';
    expect(selectManagerHome({ state, records: null, community: null, nowMs: now }).attendanceToRecord).toBe(0);
  });

  it('shows incomplete preference setup without changing eligibility or silently filling a position', () => {
    const state = createPreparationState();
    state.profiles[0].preferences = [];
    state.profiles[1].preferences = ['GK', 'GK', 'ST'];
    const before = JSON.stringify(state);
    const home = selectManagerHome({ state, records: null, community: null, nowMs: now });
    expect(home.missingPreferences).toBe(2);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('removes an explicitly completed accepted fixture from upcoming preparation work', () => {
    const state = createPreparationState(), value = records();
    value.results.rows[0] = { ...value.results.rows[0], id: state.fixtures[0].id, status: 'completed' };
    const home = selectManagerHome({ state, records: value, community: null, nowMs: now });
    expect(home.upcoming.some(item => item.id === state.fixtures[0].id)).toBe(false);
    expect(home.repliesDue).toBe(44);
  });

  it('keeps recent date-only ties explicit and never converts unknown scores into zero', () => {
    const state = createPreparationState(), value = records();
    value.results.rows[0] = { ...value.results.rows[0], playedDate: '2026-10-20', recordedKickoff: null, sameDayOrder: null, finalScore: null };
    value.results.rows[1] = { ...value.results.rows[1], playedDate: '2026-10-20', recordedKickoff: null, sameDayOrder: null };
    const home = selectManagerHome({ state, records: value, community: null, nowMs: now });
    expect(home.recentOrderUnknown).toBe(true);
    expect(home.recentResults).toHaveLength(2);
    expect(home.recentResults.find(item => item.id === value.results.rows[0].id)?.finalScore).toBeNull();
  });

  it('does not reuse another team/season or another audience report to populate a manager dashboard', () => {
    const state = createPreparationState();
    for (const patch of [{ teamId: 'other-team' }, { seasonId: 'other-season' }, { visibilityScope: 'player' as const }]) {
      const value = records();
      value.results = { ...value.results, ...patch };
      value.activeMatch = { ...match(), status: 'first_half_running' };
      const home = selectManagerHome({ state, records: value, community: null, nowMs: now });
      expect(home.recordsAvailable).toBe(false);
      expect(home.recentResults).toEqual([]);
      expect(home.resumable).toBeNull();
    }
  });

  it('offers resume only for an actual in-progress accepted match, without extrapolating elapsed time', () => {
    const state = createPreparationState(), value = records();
    value.activeMatch = { ...match(), status: 'first_half_paused', score: { for: 2, against: 1 } };
    const home = selectManagerHome({ state, records: value, community: null, nowMs: now });
    expect(home.resumable).toEqual({ matchId: 'synthetic-in-progress', status: 'first_half_paused', score: { for: 2, against: 1 } });
    expect(home.resumable).not.toHaveProperty('elapsedMs');
    state.fixtures[0].playedDate = '2026-10-20';
    value.activeMatch = { ...value.activeMatch, config: { ...value.activeMatch.config, matchId: state.fixtures[0].id } };
    expect(selectManagerHome({ state, records: value, community: null, nowMs: now }).olderUnresolved).toEqual([]);
    value.activeMatch = { ...value.activeMatch, status: 'completed' };
    expect(selectManagerHome({ state, records: value, community: null, nowMs: now }).resumable).toBeNull();
  });

  it('counts only supplied manager review rows and keeps inaccessible status unavailable rather than zero', () => {
    const state = createPreparationState(), view = community();
    view.reviewQueue.push({ id: 'photo-1', version: 1, art: 'pitch', caption: 'private caption', uploaderLabel: 'Private uploader' });
    for (const status of ['submitted', 'under_review', 'resolved'] as const) view.reviewConcerns.push({ id: status, targetType: 'photo', targetId: 'photo-1', category: 'privacy', explanation: 'private concern', status });
    const home = selectManagerHome({ state, records: null, community: view, nowMs: now });
    expect(home.photoReviews).toBe(1);
    expect(home.concernsToReview).toBe(2);
    expect(JSON.stringify(home)).not.toContain('private caption');
    expect(JSON.stringify(home)).not.toContain('private concern');
    expect(selectManagerHome({ state, records: null, community: { ...view, allowed: false }, nowMs: now })).toMatchObject({ photoReviews: null, concernsToReview: null });
  });

  it('keeps invalid or missing date/time fields unknown without generating an event or preparation snapshot', () => {
    const state = createPreparationState();
    state.training = [];
    state.fixtures = state.fixtures.slice(0, 1);
    state.fixtures[0].playedDate = '2026-02-30';
    state.fixtures[0].kickoff = '25:00';
    const home = selectManagerHome({ state, records: null, community: null, nowMs: now });
    expect(home.next).toBeNull();
    expect(home.undated[0]).toMatchObject({ date: null, time: null, prepared: false });
    expect(state.snapshots).toEqual([]);
  });
});
