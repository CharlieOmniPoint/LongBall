import { createMatch, reduceMatch, type Allocation, type MatchConfig, type MatchEvent, type MatchState } from '@longball/domain';
import { romaFixture } from '@longball/testing';
import { autoFillLineup } from './lineup-autofill';

/** Generated match history, replayed through the same rules as recorded play. */
export function createDemoCompletedMatches(): MatchState[] {
  return romaFixture.fixtures.filter(fixture => fixture.demoPhase === 'completed').map((fixture, matchIndex) => {
    const selected = [...fixture.selectedPlayerIds];
    if (selected.length !== 8) throw new Error('The recorded Roma demo needs its eight-player squad.');
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
    // Eight 6m15 stints share the single bench place among all seven outfield
    // players. The extra spell alternates between the two central midfielders
    // across these games; the fixed goalkeeper plays all 50 active minutes.
    const benchOrder = (matchIndex % 2 === 0 ? [3, 4, 1, 2, 5, 6, 7, 3] : [4, 3, 2, 1, 6, 5, 7, 4]).map(index => selected[index]);
    const stintLineup = (stint: number): Allocation[] => {
      const filled = autoFillLineup({ slots: config.slots!, fixedKeeperId: config.fixedKeeperId,
        players: selected.map(playerId => {
          const profile = profiles.find(item => item.playerId === playerId)!;
          return { id: playerId, preferences: profile.preferences, eligiblePositions: profile.eligiblePositions,
            goalkeeperChoice: config.players.find(player => player.id === playerId)!.goalkeeperChoice,
            available: playerId !== benchOrder[stint] };
        }) });
      if (filled.status !== 'complete') throw new Error(`The recorded Roma lineup is unavailable: ${filled.reason}`);
      return filled.allocations;
    };
    for (const playerId of selected) send({ type: 'attendance.recorded', playerId, status: 'present' } as Omit<MatchEvent, 'id' | 'sample'>, 0);
    send({ type: 'lineup.staged', lineup: stintLineup(0) } as Omit<MatchEvent, 'id' | 'sample'>, 0);
    send({ type: 'half.started' }, 0);
    send({ type: 'lineup.committed', sourceRevision: state.revision, lineup: stintLineup(1) } as Omit<MatchEvent, 'id' | 'sample'>, 375_000);
    send({ type: 'goal.recorded', beneficiary: 'us', scorerPlayerId: selected[1], goalType: 'open_play' } as Omit<MatchEvent, 'id' | 'sample'>, 8 * 60_000);
    send({ type: 'lineup.committed', sourceRevision: state.revision, lineup: stintLineup(2) } as Omit<MatchEvent, 'id' | 'sample'>, 750_000);
    send({ type: 'goal.recorded', beneficiary: 'opposition', scorerPlayerId: null, goalType: 'open_play' } as Omit<MatchEvent, 'id' | 'sample'>, 18 * 60_000);
    send({ type: 'lineup.committed', sourceRevision: state.revision, lineup: stintLineup(3) } as Omit<MatchEvent, 'id' | 'sample'>, 1_125_000);
    send({ type: 'half.ended' }, 1_500_000);
    send({ type: 'lineup.staged', lineup: stintLineup(4) } as Omit<MatchEvent, 'id' | 'sample'>, 1_800_000);
    send({ type: 'half.started' }, 1_800_000);
    send({ type: 'lineup.committed', sourceRevision: state.revision, lineup: stintLineup(5) } as Omit<MatchEvent, 'id' | 'sample'>, 2_175_000);
    send({ type: 'goal.recorded', beneficiary: 'us', scorerPlayerId: selected[7], goalType: 'open_play' } as Omit<MatchEvent, 'id' | 'sample'>, 2_220_000);
    send({ type: 'lineup.committed', sourceRevision: state.revision, lineup: stintLineup(6) } as Omit<MatchEvent, 'id' | 'sample'>, 2_550_000);
    send({ type: 'lineup.committed', sourceRevision: state.revision, lineup: stintLineup(7) } as Omit<MatchEvent, 'id' | 'sample'>, 2_925_000);
    send({ type: 'goal.recorded', beneficiary: fixture.id === 'synthetic-history-oak' ? 'opposition' : 'us',
      scorerPlayerId: fixture.id === 'synthetic-history-oak' ? null : selected[7], goalType: 'open_play' } as Omit<MatchEvent, 'id' | 'sample'>, 2_940_000);
    send({ type: 'half.ended' }, 3_300_000);
    return state;
  });
}
