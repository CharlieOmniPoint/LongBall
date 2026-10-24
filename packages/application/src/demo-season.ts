import { createMatch, reduceMatch, type Allocation, type MatchConfig, type MatchEvent, type MatchState } from '@longball/domain';
import { romaFixture } from '@longball/testing';

/** Generated match history, replayed through the same rules as recorded play. */
export function createDemoCompletedMatches(): MatchState[] {
  return romaFixture.fixtures.filter(fixture => fixture.demoPhase === 'completed').map(fixture => {
    const selected = [...fixture.selectedPlayerIds];
    const profiles = selected.map(playerId => romaFixture.profiles.find(profile => profile.playerId === playerId)!);
    const kickoff = Date.parse(`${fixture.playedDate}T${fixture.kickoff}:00+01:00`);
    const positions = ['GK', 'CB', 'CB', 'CM', 'LW', 'RW', 'ST'];
    const config: MatchConfig = {
      matchId: fixture.id, players: romaFixture.players.map(player => ({ id: player.id, displayName: player.displayName, goalkeeperChoice: player.goalkeeperChoice,
        positionPreferences: [...romaFixture.profiles.find(profile => profile.playerId === player.id)!.preferences] })),
      selectedPlayerIds: selected, pitchPlaces: 7, plannedHalfDurationMs: 1_500_000, fixedKeeperId: selected[0],
      fixture: { opponent: fixture.opponent, playedDate: fixture.playedDate, kickoff: fixture.kickoff, homeAway: fixture.homeAway as 'home' | 'away',
        teamId: romaFixture.teamId, seasonId: 'synthetic-season-2026-27', teamName: 'Roma', clubName: romaFixture.club.name },
      slots: positions.map((position, index) => ({ slotId: `demo-slot-${index}`, position })),
      profileSnapshot: profiles.map(profile => ({ playerId: profile.playerId, initials: profile.initials,
        preferences: [...profile.preferences], eligiblePositions: [...profile.eligiblePositions] })),
    };
    let state = createMatch(config), sequence = 0;
    const send = (command: Omit<MatchEvent, 'id' | 'sample'>, milliseconds: number) => {
      state = reduceMatch(state, { ...command, id: `${fixture.id}-demo-${++sequence}`,
        actorId: 'synthetic-account-manager', sample: { monotonicMs: milliseconds, sessionId: `demo-history-${fixture.id}`, wallTimeMs: kickoff + milliseconds } } as MatchEvent);
    };
    // Every outfield player has one 12m30 bench quarter; 6×50+50 =350 player-minutes.
    const quarterLineup = (quarter: number): Allocation[] => {
      const omitted = [[7, 8], [5, 6], [3, 4], [1, 2]][quarter];
      const playing = selected.filter((_, index) => !omitted.includes(index));
      return playing.map((playerId, index) => ({ playerId, position: positions[index], slotId: `demo-slot-${index}` }));
    };
    for (const playerId of selected) send({ type: 'attendance.recorded', playerId, status: 'present' } as Omit<MatchEvent, 'id' | 'sample'>, 0);
    send({ type: 'lineup.staged', lineup: quarterLineup(0) } as Omit<MatchEvent, 'id' | 'sample'>, 0);
    send({ type: 'half.started' }, 0);
    send({ type: 'goal.recorded', beneficiary: 'us', scorerPlayerId: selected[1], goalType: 'open_play' } as Omit<MatchEvent, 'id' | 'sample'>, 8 * 60_000);
    send({ type: 'lineup.committed', sourceRevision: state.revision, lineup: quarterLineup(1) } as Omit<MatchEvent, 'id' | 'sample'>, 750_000);
    send({ type: 'goal.recorded', beneficiary: 'opposition', scorerPlayerId: null, goalType: 'open_play' } as Omit<MatchEvent, 'id' | 'sample'>, 18 * 60_000);
    send({ type: 'half.ended' }, 1_500_000);
    send({ type: 'lineup.staged', lineup: quarterLineup(2) } as Omit<MatchEvent, 'id' | 'sample'>, 1_800_000);
    send({ type: 'half.started' }, 1_800_000);
    send({ type: 'goal.recorded', beneficiary: 'us', scorerPlayerId: selected[7], goalType: 'open_play' } as Omit<MatchEvent, 'id' | 'sample'>, 2_220_000);
    send({ type: 'lineup.committed', sourceRevision: state.revision, lineup: quarterLineup(3) } as Omit<MatchEvent, 'id' | 'sample'>, 2_550_000);
    send({ type: 'goal.recorded', beneficiary: fixture.id === 'synthetic-history-oak' ? 'opposition' : 'us',
      scorerPlayerId: fixture.id === 'synthetic-history-oak' ? null : selected[8], goalType: 'open_play' } as Omit<MatchEvent, 'id' | 'sample'>, 2_940_000);
    send({ type: 'half.ended' }, 3_300_000);
    return state;
  });
}
