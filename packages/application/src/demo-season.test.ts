import { describe, expect, it } from 'vitest';
import { playerMinutes } from '@longball/domain';
import { romaFixture } from '@longball/testing';
import { createDemoCompletedMatches } from './demo-season';
import { createPreparationState } from './preparation';
import { createRecordsSeed, selectSeasonResults } from './records';
import { applyCommunityCommand, createCommunityState, getCommunityView, syntheticCommunityActors } from './community';

const now = Date.parse('2026-10-22T12:00:00Z');
describe('coherent four-game Roma demo season', () => {
  it('joins thirteen named profiles to exactly two played and two upcoming games without future attendance', () => {
    const preparation = createPreparationState({ demoScenario: true });
    expect(preparation.profiles).toHaveLength(13);
    expect(new Set(preparation.profiles.map(profile => profile.shirtNumber)).size).toBe(13);
    expect(preparation.profiles.every(profile => profile.displayName.includes(' ') && profile.preferences.length === 3 && profile.foot !== 'not_recorded')).toBe(true);
    expect(preparation.fixtures.map(fixture => fixture.id).sort()).toEqual(romaFixture.fixtures.map(fixture => fixture.id).sort());
    const past = preparation.fixtures.filter(fixture => fixture.playedDate < '2026-10-22');
    const future = preparation.fixtures.filter(fixture => fixture.playedDate > '2026-10-22');
    expect(past).toHaveLength(2); expect(future).toHaveLength(2);
    for (const fixture of future) {
      expect(fixture.selectedProfileIds).toHaveLength(9);
      expect(Object.values(fixture.attendance)).toEqual([]);
      expect(fixture.responses).not.toEqual({});
    }
    for (const fixture of past) expect(Object.values(fixture.attendance).filter(value => value === 'present')).toHaveLength(9);
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
      const players = playerMinutes(match, { monotonicMs: 3_300_000, wallTimeMs: match.completedAtMs!, sessionId: `demo-history-${match.config.matchId}` });
      expect(players.reduce((sum, player) => sum + player.playingMs, 0)).toBe(7 * 50 * 60_000);
      for (const player of players) {
        participated.add(player.playerId);
        expect(player.playingMs + player.benchMs + player.unavailableMs).toBe(50 * 60_000);
      }
      for (const goal of match.goals ?? []) if (goal.scorerPlayerId) {
        expect(match.intervals.some(interval => interval.playerId === goal.scorerPlayerId && interval.state === 'playing' && interval.half === goal.effective.half && interval.startMs <= goal.effective.matchElapsedMs && interval.endMs >= goal.effective.matchElapsedMs)).toBe(true);
      }
    }
    expect(participated.size).toBe(13);
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
    expect(view.matches.every(match => !match.mayVote && match.award?.result === 'winners' && match.award.winnerLabels.includes('Noah Patel'))).toBe(true);
    expect(view.gallery.every(photo => photo.matchId === 'synthetic-history-hill')).toBe(true);
    expect(() => applyCommunityCommand(community, actor, { id: 'late-demo-ballot', type: 'ballot.cast', matchId: community.matches[0].id, candidatePlayerId: 'synthetic-player-02' }, now)).toThrow('Voting is closed');
  });
});
