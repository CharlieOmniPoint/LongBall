import { describe, expect, it } from 'vitest';
import { createCommunityState, getCommunityView } from './community';
import { composeReportCommunity, type CommunityReportBoundary, type ReportCommunitySource } from './report-community';
const nowMs = Date.parse('2026-10-21T12:00:00Z');
function fixture(noVotes = false) {
  const state = createCommunityState(nowMs), match = state.matches[0];
  state.awards.push({ matchId: match.id, winnerPlayerIds: noVotes ? [] : ['synthetic-player-01', 'synthetic-player-02'], result: noVotes ? 'no_valid_votes' : 'winners', voteCutoffAtMs: nowMs - 60_000, finalisationDeadlineAtMs: nowMs, finalisedAtMs: nowMs - 30_000, deadlineMissed: false });
  state.ballots.push({ id: 'private-ballot', matchId: match.id, voterAccountId: 'synthetic-account-player-03', voterPlayerId: 'synthetic-player-03', candidatePlayerId: 'synthetic-player-04', receivedAtMs: nowMs - 120_000, revision: 1 });
  const source: ReportCommunitySource = { accountId: 'synthetic-account-manager', teamId: match.teamId, seasonId: match.seasonId, audience: 'manager', playerId: null, revision: state.revision, view: getCommunityView(state, { accountId: 'synthetic-account-manager', teamId: match.teamId, seasonId: match.seasonId, role: 'manager' }, nowMs) };
  const report: CommunityReportBoundary = { matchId: match.id, teamId: match.teamId, seasonId: match.seasonId, visibilityScope: 'manager', suppressionReason: null, appliedFilters: { playerId: null } };
  return { report, source };
}
describe('report final award and published album composition', () => {
  it('retains a sealed joint award/deadline and counts only this game’s already-published filtered photos', () => {
    const { report, source } = fixture(), before = JSON.stringify(source);
    source.view.gallery.push({ ...source.view.gallery[0], id: 'other-game-photo', matchId: 'other-game' });
    const result = composeReportCommunity(report, source.accountId, source);
    expect(result).toMatchObject({ communityStatus: 'available', award: { result: 'winners', winnerLabels: ['Oliver Bennett', 'Noah Patel'], finalisationDeadlineAtMs: nowMs }, publishedAlbum: { matchId: report.matchId, photoCount: 1 } });
    for (const secret of ['private-ballot', 'synthetic-pending-ball', 'voterAccountId', 'candidatePlayerId', 'ownChoice', 'candidates', 'uploaderAccountId', 'caption', 'winnerPlayerIds']) expect(JSON.stringify(result)).not.toContain(secret);
    expect(source.view.matches[0].award?.finalisationDeadlineAtMs).toBe(nowMs); expect(before).not.toContain('other-game-photo');
  });
  it('reports the actual no-valid-votes final result without inventing winners', () => {
    const { report, source } = fixture(true);
    expect(composeReportCommunity(report, source.accountId, source).award).toMatchObject({ result: 'no_valid_votes', winnerLabels: [], deadlineMissed: false });
  });
  it('withholds awards and even album counts whenever the report’s competition policy suppresses scores', () => {
    const { report, source } = fixture();
    expect(composeReportCommunity({ ...report, suppressionReason: 'Scores are not shared for this competition.' }, source.accountId, source)).toEqual({ communityStatus: 'withheld', communityRevision: null, award: null, publishedAlbum: null });
  });
  it('also obeys fresh community policy/access even if the report permits its summary', () => {
    const { report, source } = fixture(); source.view.matches[0].sharingAllowed = false;
    expect(composeReportCommunity(report, source.accountId, source)).toMatchObject({ communityStatus: 'withheld', award: null, publishedAlbum: null });
    expect(composeReportCommunity(report, source.accountId, { ...source, view: { ...source.view, allowed: false } })).toMatchObject({ communityStatus: 'unavailable', award: null, publishedAlbum: null });
  });
  it('rejects another account, team, season, audience or own-player source without joining same-ID records', () => {
    const { report, source } = fixture();
    for (const change of [{ accountId: 'other' }, { teamId: 'other' }, { seasonId: 'other' }, { audience: 'player' as const }, { revision: -1 }]) expect(composeReportCommunity(report, source.accountId, { ...source, ...change })).toMatchObject({ communityStatus: 'unavailable', award: null, publishedAlbum: null });
    const ownReport = { ...report, visibilityScope: 'player' as const, appliedFilters: { playerId: 'synthetic-player-01' } };
    expect(composeReportCommunity(ownReport, source.accountId, { ...source, audience: 'player', playerId: 'synthetic-player-02' }).communityStatus).toBe('unavailable');
  });
  it('keeps unlinked historical context explicitly unrecorded and rejects ambiguous/malformed sealed evidence', () => {
    const { report, source } = fixture();
    expect(composeReportCommunity({ ...report, matchId: 'historical-without-album' }, source.accountId, source)).toMatchObject({ communityStatus: 'not_recorded', award: null, publishedAlbum: null });
    const duplicated = { ...source, view: { ...source.view, matches: [...source.view.matches, source.view.matches[0]] } };
    expect(composeReportCommunity(report, source.accountId, duplicated).communityStatus).toBe('unavailable');
    source.view.matches[0].award!.deadlineMissed = true;
    expect(composeReportCommunity(report, source.accountId, source)).toMatchObject({ communityStatus: 'unavailable', award: null, publishedAlbum: null });
  });
});
