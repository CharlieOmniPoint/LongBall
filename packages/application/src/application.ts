import type { MatchConfig } from "@longball/domain";
import { romaFixture } from "@longball/testing";
import { createCommunityState, type CommunityState } from "./community";
import {
  createPreparationState,
  goalkeeperChoice,
  type PreparedFixtureSnapshot,
  type PreparationState,
} from "./preparation";
import { createRecordsSeed, type RecordsState } from "./records";

export interface ApplicationState {
  schemaVersion: 1;
  synthetic: true;
  revision: number;
  preparation: PreparationState;
  community: CommunityState;
  recordsBySeason: Record<string, RecordsState>;
  activeMatchConfig: MatchConfig | null;
}

export function createApplicationState(): ApplicationState {
  const preparation = createPreparationState();
  const records = createRecordsSeed();
  return {
    schemaVersion: 1,
    synthetic: true,
    revision: 0,
    preparation,
    community: createCommunityState(),
    recordsBySeason: { [records.seasonId]: records },
    activeMatchConfig: null,
  };
}

export function validateApplicationState(state: ApplicationState) {
  if (
    state.schemaVersion !== 1 ||
    state.synthetic !== true ||
    !Number.isSafeInteger(state.revision) ||
    !state.preparation ||
    !state.community ||
    !state.recordsBySeason
  ) {
    throw new Error(
      "Application data requires a compatible build. Existing records were retained.",
    );
  }
  if (state.preparation.version !== 1 || state.community.schemaVersion !== 1)
    throw new Error(
      "A saved feature uses a newer schema. Existing records were retained.",
    );
}

export function fixtureMatchConfig(
  preparation: PreparationState,
  snapshot: PreparedFixtureSnapshot,
): MatchConfig {
  const keepers = snapshot.profiles.filter(
    (player) => goalkeeperChoice(player) > 0,
  );
  const config: MatchConfig = {
    matchId: snapshot.fixtureId,
    players: snapshot.profiles.map((player) => ({
      id: player.playerId,
      displayName: player.displayName,
      goalkeeperChoice: goalkeeperChoice(player),
    })),
    selectedPlayerIds: [...snapshot.selectedPlayerIds],
    pitchPlaces: snapshot.fixture.format,
    plannedHalfDurationMs: snapshot.fixture.plannedHalfDurationMs,
    fixedKeeperId: keepers.length === 1 ? keepers[0].playerId : null,
    ...(snapshot.matchPlanDraft ? { initialPolicyProposal: snapshot.matchPlanDraft.settings, initialLineupProposal: snapshot.matchPlanDraft.allocations.map(row => ({ ...row })) } : {}),
    initialAttendance: { ...snapshot.attendance },
    slots: snapshot.formation.slots.map((slot) => ({
      slotId: slot.id,
      position: slot.position,
      x: slot.x,
      y: slot.y,
      label: slot.label,
    })),
    profileSnapshot: snapshot.profiles.map((profile) => ({
      playerId: profile.playerId,
      preferences: [...profile.preferences],
      eligiblePositions: [...profile.eligiblePositions],
      initials: profile.initials,
    })),
    fixture: {
      opponent: snapshot.fixture.opponent,
      playedDate: snapshot.fixture.playedDate,
      kickoff: snapshot.fixture.kickoff,
      homeAway: snapshot.fixture.homeAway,
      seasonId: snapshot.seasonId,
      teamId: preparation.team.id,
      teamName: preparation.team.name,
      clubName: preparation.club.name,
    },
  };
  return config;
}

/** A rollover starts new totals and grants; old season projections remain intact. */
export function reconcileSeason(state: ApplicationState): ApplicationState {
  const seasonId = state.preparation.activeSeasonId;
  if (state.recordsBySeason[seasonId]) return state;
  const season = state.preparation.seasons.find(
    (item) => item.id === seasonId,
  )!;
  const seed = createRecordsSeed();
  const records: RecordsState = {
    ...seed,
    seasonId,
    seasonLabel: season.label,
    startsOn: season.startDate,
    endsOn: season.endDate,
    players: state.preparation.profiles
      .filter((profile) => profile.seasonId === seasonId && profile.active)
      .map((profile) => ({ id: profile.playerId, label: profile.displayName })),
    results: [],
    trainingAttendance: [],
    gamePreparation: [],
    audit: [],
    appliedCommands: {},
    revision: 0,
  };
  const oldSeasonId = state.community.seasons.find(
    (item) => item.teamId === state.preparation.team.id,
  )?.id;
  const community: CommunityState = {
    ...state.community,
    revision: state.community.revision + 1,
    seasons: [
      ...state.community.seasons,
      {
        id: seasonId,
        teamId: state.preparation.team.id,
        label: season.label,
        teamLabel: state.preparation.team.name,
        accessEndsAtMs: Date.parse(`${season.endDate}T23:00:00Z`),
      },
    ],
    memberships: [
      ...state.community.memberships,
      ...state.community.memberships
        .filter(
          (member) =>
            member.seasonId === oldSeasonId &&
            member.active &&
            (member.role === "manager" ||
              state.preparation.profiles.some(
                (profile) =>
                  profile.seasonId === seasonId &&
                  profile.playerId === member.playerId,
              )),
        )
        .map((member) => ({ ...member, seasonId })),
    ],
  };
  return {
    ...state,
    community,
    recordsBySeason: { ...state.recordsBySeason, [seasonId]: records },
  };
}

export const defaultPlayerId = romaFixture.players[0].id;
