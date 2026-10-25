import type { PreparationState } from './preparation';
import type { GamePreparationEvidence } from './records';

/** Preserve RSVP evidence separately from actual check-in and active availability. */
export function gamePreparationEvidence(state: PreparationState, seasonId: string, sourceCommandId: string): GamePreparationEvidence[] {
  const players = new Map(state.profiles.filter(profile => profile.seasonId === seasonId).map(profile => [profile.id, profile.playerId]));
  return state.fixtures.filter(fixture => fixture.seasonId === seasonId).map(fixture => ({
    matchId: fixture.id,
    responses: Object.fromEntries(Object.entries(fixture.responses).flatMap(([profileId, response]) => {
      const playerId = players.get(profileId);
      return playerId ? [[playerId, response]] : [];
    })),
    sourcePreparationRevision: state.revision,
    sourceCommandId,
  }));
}
