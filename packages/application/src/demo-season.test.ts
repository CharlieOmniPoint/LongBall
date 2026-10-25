import { describe, expect, it } from 'vitest';
import { playerMinutes, replayMatch } from '@longball/domain';
import { romaFixture } from '@longball/testing';
import { createDemoCompletedMatches } from './demo-season';
import { createPreparationState } from './preparation';
import { createRecordsSeed, selectSeasonResults } from './records';
import { applyCommunityCommand, createCommunityState, getCommunityView, syntheticCommunityActors } from './community';

const now = Date.parse('2026-10-22T12:00:00Z');
describe('coherent four-game Roma demo season', () => {
  it('joins the eight requested profiles to exactly two played and two upcoming games without future attendance', () => {
    const preparation = createPreparationState({ demoScenario: true });
    expect(preparation.profiles).toHaveLength(8);
    expect(new Set(preparation.profiles.map(profile => profile.shirtNumber)).size).toBe(8);
    expect(preparation.profiles.every(profile => profile.displayName.includes(' ') && profile.preferences.length === 3 && profile.foot !== 'not_recorded')).toBe(true);
    expect(preparation.fixtures.map(fixture => fixture.id).sort()).toEqual(romaFixture.fixtures.map(fixture => fixture.id).sort());
    const past = preparation.fixtures.filter(fixture => fixture.playedDate < '2026-10-22');
    const future = preparation.fixtures.filter(fixture => fixture.playedDate > '2026-10-22');
    expect(past).toHaveLength(2); expect(future).toHaveLength(2);
    for (const fixture of future) {
      expect(fixture.selectedProfileIds).toHaveLength(8);
      expect(Object.values(fixture.attendance)).toEqual([]);
      expect(fixture.responses).not.toEqual({});
    }
    for (const fixture of past) expect(Object.values(fixture.attendance).filter(value => value === 'present')).toHaveLength(8);
  });

  it('replays both completed games with valid goals, two manual halves and conserved participation', () => {
    const matches = createDemoCompletedMatches();
    expect(matches).toHaveLength(2);
    const participated = new Set<string>();
    for (const match of matches) {
      expect(match.status).toBe('completed');
      expect(match.firstHalfDurationMs).toBe(25 * 60_000);
      expect(match.matchActiveMs).toBe(50 * 60_000);
      expect(match.eventHistory?.filter(event => event.type === 'half.ended')).toHaveLength(2);
      expect(match.halfTimeScore).toEqual({ for: 1, against: 1 });
      expect(match.score).toEqual(match.config.matchId === 'synthetic-history-oak' ? { for: 2, against: 2 } : { for: 3, against: 1 });
      expect(replayMatch(match.config, match.eventHistory!)).toEqual(match);
      expect(match.config.selectedPlayerIds).toEqual(romaFixture.players.map(player => player.id));
      for (const event of match.eventHistory ?? []) if (event.type === 'lineup.staged' || event.type === 'lineup.committed') {
        expect(event.lineup).toHaveLength(7);
        expect(new Set(event.lineup.map(item => item.playerId)).size).toBe(7);
        expect(event.lineup.find(item => item.position === 'GK')?.playerId).toBe('synthetic-player-01');
        for (const allocation of event.lineup) expect(romaFixture.profiles.find(profile => profile.playerId === allocation.playerId)?.eligiblePositions).toContain(allocation.position);
      }
      const players = playerMinutes(match, { monotonicMs: 3_300_000, wallTimeMs: match.completedAtMs!, sessionId: `demo-history-${match.config.matchId}` });
      expect(players).toHaveLength(8);
      expect(players.reduce((sum, player) => sum + player.playingMs, 0)).toBe(7 * 50 * 60_000);
      for (const player of players) {
        participated.add(player.playerId);
        expect(player.playingMs + player.benchMs + player.unavailableMs).toBe(50 * 60_000);
        if (player.playerId === 'synthetic-player-01') {
          expect(player.playingMs).toBe(50 * 60_000);
          expect(player.benchMs).toBe(0);
        } else {
          expect(player.playingMs).toBeGreaterThanOrEqual(37.5 * 60_000);
          expect(player.playingMs).toBeLessThanOrEqual(43.75 * 60_000);
          expect(player.benchMs).toBeGreaterThan(0);
        }
      }
      for (const goal of match.goals ?? []) if (goal.scorerPlayerId) {
        expect(match.intervals.some(interval => interval.playerId === goal.scorerPlayerId && interval.state === 'playing' && interval.half === goal.effective.half && interval.startMs <= goal.effective.matchElapsedMs && interval.endMs >= goal.effective.matchElapsedMs)).toBe(true);
      }
    }
    expect([...participated].sort()).toEqual(romaFixture.players.map(player => player.id).sort());
  });

  it('derives complete archived results from the same played games and preserves unknown upcoming results', () => {
    const records = createRecordsSeed({ demoSharing: true }), matches = createDemoCompletedMatches();
    expect(records.results).toHaveLength(2);
    for (const record of records.results) {
      const match = matches.find(item => item.config.matchId === record.id)!;
      expect(record).toMatchObject({ recordMode: 'detailed_live', detailCompleteness: 'complete', status: 'completed', finalScore: match.score, halfTimeScore: match.halfTimeScore, actualActiveDurationMs: 3_000_000 });
      expect(record.participation?.reduce((sum, player) => sum + player.playedMs, 0)).toBe(21_000_000);
    }
    expect(selectSeasonResults(records, { actor: 'manager' }).totals).toEqual({ played: 2, wins: 1, draws: 1, losses: 0, goalsFor: 5, goalsAgainst: 3, goalDifference: 2, points: 4 });
    expect(records.results.some(record => record.id === records.liveMatch.matchId)).toBe(false);
  });

  it('uses played fixture albums and sealed historical awards without reopening expired voting', () => {
    const community = createCommunityState(now, { demoScenario: true }), actor = syntheticCommunityActors(community).player;
    expect(community.matches.map(match => match.id).sort()).toEqual(createDemoCompletedMatches().map(match => match.config.matchId).sort());
    const view = getCommunityView(community, actor, now);
    expect(view.matches).toHaveLength(2);
    expect(view.matches.every(match => !match.mayVote && match.award?.result === 'winners' && match.award.winnerLabels.includes('Ralph Barrett'))).toBe(true);
    expect(view.gallery.every(photo => photo.matchId === 'synthetic-history-hill')).toBe(true);
    expect(() => applyCommunityCommand(community, actor, { id: 'late-demo-ballot', type: 'ballot.cast', matchId: community.matches[0].id, candidatePlayerId: 'synthetic-player-02' }, now)).toThrow('Voting is closed');
  });
});
