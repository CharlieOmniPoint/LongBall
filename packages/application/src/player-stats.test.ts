import { describe, expect, it } from "vitest";
import { createMatch, reduceMatch, type MatchEvent } from "@longball/domain";
import { romaFixture } from "@longball/testing";
import { createRecordsSeed } from "./records";
import {
  playerStatsSourceFromRecords,
  projectPlayerStats,
  assertPlayerStatsDto,
  type PlayerStatsSource,
  type StatsMatchEvidence,
  type TeamPlayerStatsDto,
} from "./player-stats";

const evidence = (
  overrides: Partial<StatsMatchEvidence> = {},
): StatsMatchEvidence => ({
  id: "game-1",
  teamId: "team",
  seasonId: "season",
  status: "completed",
  recordMode: "detailed_live",
  detailCompleteness: "complete",
  revision: 1,
  sourceMatchRevision: 10,
  updatedAt: "2026-10-21T12:00:00Z",
  finalScore: { for: 2, against: 1 },
  goals: [
    { id: "goal-1", beneficiary: "us", isOwnGoal: false, scorerPlayerId: "p1" },
    { id: "goal-2", beneficiary: "us", isOwnGoal: true, scorerPlayerId: null },
    {
      id: "goal-3",
      beneficiary: "opposition",
      isOwnGoal: true,
      scorerPlayerId: "p1",
    },
  ],
  participation: [
    {
      playerId: "p1",
      playedMs: 120_000,
      positionMs: { CM: 60_000, SS: 30_000 },
    },
    { playerId: "p2", playedMs: 60_000, positionMs: { GK: 60_000 } },
  ],
  ...overrides,
});
const source = (matches = [evidence()]): PlayerStatsSource => ({
  clubId: "club",
  teamId: "team",
  seasonId: "season",
  seasonLabel: "2026/27",
  revision: 5,
  players: [
    { id: "p1", label: "Player One" },
    { id: "p2", label: "Player Two" },
  ],
  matches,
  positions: [
    { code: "GK", label: "Goalkeeper", active: true },
    { code: "CM", label: "Centre midfield", active: true },
    { code: "SS", label: "Support striker", active: false },
  ],
  formation: {
    id: "shape",
    label: "Recorded shape",
    slots: [
      { id: "centre", positionCode: "CM", label: "Centre", x: 0.5, y: 0.5 },
    ],
  },
});
const staff = (value: PlayerStatsSource) =>
  projectPlayerStats(value, { role: "manager" }) as TeamPlayerStatsDto;

describe("fetched stats scope and privacy validation", () => {
  it("accepts own/staff aggregates and rejects cross-player, cross-season and private extras", () => {
    const own = projectPlayerStats(source(), {
      role: "player",
      playerId: "p1",
    });
    assertPlayerStatsDto(own, {
      role: "player",
      playerId: "p1",
      teamId: "team",
      seasonId: "season",
    });
    assertPlayerStatsDto(staff(source()), {
      role: "administrator",
      teamId: "team",
      seasonId: "season",
    });
    expect(() =>
      assertPlayerStatsDto(own, {
        role: "player",
        playerId: "p2",
        teamId: "team",
        seasonId: "season",
      }),
    ).toThrow();
    expect(() =>
      assertPlayerStatsDto(own, {
        role: "player",
        playerId: "p1",
        teamId: "team",
        seasonId: "other",
      }),
    ).toThrow();
    const privateValue = staff(source());
    Object.assign(privateValue.players[0], { attendance: "private" });
    expect(() =>
      assertPlayerStatsDto(privateValue, {
        role: "administrator",
        teamId: "team",
        seasonId: "season",
      }),
    ).toThrow();
  });
  it("refuses inconsistent percentage denominators and malformed formation coordinates", () => {
    const percentValue = staff(source());
    percentValue.players[0].positions[0].percentage = 999;
    expect(() =>
      assertPlayerStatsDto(percentValue, {
        role: "manager",
        teamId: "team",
        seasonId: "season",
      }),
    ).toThrow();
    const formationValue = staff(source());
    formationValue.formation!.slots[0].x = 2;
    expect(() =>
      assertPlayerStatsDto(formationValue, {
        role: "manager",
        teamId: "team",
        seasonId: "season",
      }),
    ).toThrow();
  });
});

describe("narrow player statistics projections", () => {
  it("counts only reviewed goalkeeper outcomes and preserves missing goal-timing coverage", () => {
    const clean = evidence({ id: "clean", goalkeeperOutcomes: [{ playerId: "p2", outcome: "clean_sheet" }] });
    const conceded = evidence({ id: "conceded", goalkeeperOutcomes: [{ playerId: "p2", outcome: "conceded" }] });
    const missing = evidence({ id: "missing" });
    const result = staff(source([clean, conceded, missing]));
    expect(result.players.find(row => row.playerId === "p2")).toMatchObject({ knownCleanSheets: 1, goalkeepingReviewedMatches: 2, goalkeepingUnknownMatches: 1 });
    expect(result.players.find(row => row.playerId === "p1")).toMatchObject({ knownCleanSheets: 0, goalkeepingReviewedMatches: 0, goalkeepingUnknownMatches: 0 });
    const own = projectPlayerStats(source([clean]), {role:"player",playerId:"p2"});
    expect(JSON.stringify(own)).not.toContain('Player One');
    assertPlayerStatsDto(own,{role:"player",playerId:"p2",teamId:"team",seasonId:"season"});
    if (own.kind === "own-player-stats") own.player.knownCleanSheets = 2;
    expect(() => assertPlayerStatsDto(own,{role:"player",playerId:"p2",teamId:"team",seasonId:"season"})).toThrow();
  });
  it("preserves known time, custom/inactive positions and unknown-position denominator", () => {
    const result = staff(source()),
      row = result.players[0];
    expect(row).toMatchObject({
      knownPlayingMs: 120_000,
      knownAppearances: 1,
      knownGoals: 1,
      knownOwnGoals: 1,
      unknownPositionMs: 30_000,
    });
    expect(
      row.positions.find((position) => position.code === "CM"),
    ).toMatchObject({ playingMs: 60_000, percentage: 50 });
    expect(row.positions.find((position) => position.code === "SS")).toEqual({
      code: "SS",
      label: "Support striker",
      playingMs: 30_000,
      percentage: 25,
    });
    expect(result.team.knownPlayingMs).toBe(180_000);
    expect(
      result.team.positions.find((position) => position.code === "GK")
        ?.percentage,
    ).toBeCloseTo(100 / 3);
    expect(row.coverage.scoringCompleteMatches).toBe(1);
  });
  it("returns exactly the current own player and denies spectators, missing binding and wrong scope", () => {
    const own = projectPlayerStats(source(), {
      role: "player",
      playerId: "p1",
      teamId: "team",
      seasonId: "season",
    });
    expect(own.kind).toBe("own-player-stats");
    expect(JSON.stringify(own)).not.toContain("Player Two");
    for (const viewer of [
      { role: "spectator" as const },
      { role: "player" as const },
      { role: "player" as const, playerId: "unknown" },
      { role: "manager" as const, teamId: "other" },
      { role: "administrator" as const, seasonId: "other" },
    ])
      expect(() => projectPlayerStats(source(), viewer)).toThrow("unavailable");
  });
  it("gives administrators the same aggregate-only DTO without private fields or widening publication", () => {
    const input = source();
    Object.assign(input.players[0], {
      injury: "private-injury",
      profile: "private-profile",
    });
    Object.assign(input.matches[0], {
      feedback: "private-feedback",
      attendance: "private-attendance",
      target: "private-target",
      publication: { confirmed: false },
    });
    const result = projectPlayerStats(input, { role: "administrator" });
    expect(result).toEqual(staff(input));
    expect(JSON.stringify(result)).not.toMatch(
      /private-|attendance|feedback|profile|injury|target|publication/,
    );
    expect(staff(input).players[0].knownGoals).toBe(1);
  });
  it("never invents historical minutes, positional percentages or scoring attribution", () => {
    const result = staff(
      source([
        evidence({
          recordMode: "historical_summary",
          participation: null,
          finalScore: { for: 3, against: 0 },
          goals: [],
        }),
      ]),
    ).players[0];
    expect(result).toMatchObject({
      knownPlayingMs: 0,
      knownAppearances: 0,
      knownGoals: 0,
      unknownPositionMs: 0,
      coverage: {
        playingTimeKnownMatches: 0,
        playingTimeUnknownMatches: 1,
        scoringPartialMatches: 1,
      },
    });
    expect(
      result.positions.every((position) => position.percentage === null),
    ).toBe(true);
  });
  it("deduplicates match and goal identities and uses newer accepted revisions once", () => {
    const record = evidence(),
      newer = evidence({
        sourceMatchRevision: 11,
        participation: [
          { playerId: "p1", playedMs: 10, positionMs: { SS: 10 } },
        ],
      });
    newer.goals.push({ ...newer.goals[0] });
    const before = JSON.stringify([record, newer]);
    const row = staff(source([record, record, newer])).players[0];
    expect(row.knownPlayingMs).toBe(10);
    expect(row.knownGoals).toBe(1);
    expect(row.coverage.recordedMatches).toBe(1);
    expect(JSON.stringify([record, newer])).toBe(before);
  });
  it("omits cancelled/postponed and unplayed summaries, retaining accepted interrupted play separately", () => {
    const row = staff(
      source([
        evidence({ id: "cancelled", status: "cancelled" }),
        evidence({ id: "postponed", status: "postponed" }),
        evidence({
          id: "summary",
          status: "incomplete",
          recordMode: "historical_summary",
        }),
        evidence({ id: "interrupted", status: "abandoned" }),
      ]),
    ).players[0];
    expect(row.knownPlayingMs).toBe(120_000);
    expect(row.coverage.recordedMatches).toBe(1);
  });
  it("marks review-required and impossible/duplicate time entries unknown instead of summing them", () => {
    const row = staff(
      source([
        evidence({ id: "review", detailCompleteness: "review_required" }),
        evidence({
          id: "bad-time",
          participation: [
            { playerId: "p1", playedMs: 10, positionMs: { CM: 11 } },
          ],
        }),
        evidence({
          id: "duplicate-player",
          participation: [
            { playerId: "p1", playedMs: 10, positionMs: {} },
            { playerId: "p1", playedMs: 10, positionMs: {} },
          ],
        }),
      ]),
    ).players[0];
    expect(row.knownPlayingMs).toBe(0);
    expect(row.coverage).toMatchObject({
      playingTimeUnknownMatches: 3,
      reviewRequiredMatches: 1,
      scoringUnknownMatches: 1,
    });
  });
  it("accepts numeric-only administrator scoring summaries with the same result as canonical goals", () => {
    const normal = staff(source());
    const numeric = source([
      evidence({
        goals: [],
        finalScore: null,
        scorerTotals: [{ playerId: "p1", knownGoals: 1, knownOwnGoals: 1 }],
        scoringCoverage: "complete",
      }),
    ]);
    expect(staff(numeric)).toEqual(normal);
  });
  it("keeps unsafe/non-position keys as unknown time and excludes cross-season source rows", () => {
    const row = staff(
      source([
        evidence({
          participation: [
            {
              playerId: "p1",
              playedMs: 10,
              positionMs: { "not-a-position": 10 },
            },
          ],
        }),
        evidence({ id: "foreign", seasonId: "other" }),
      ]),
    ).players[0];
    expect(row.knownPlayingMs).toBe(10);
    expect(row.unknownPositionMs).toBe(10);
    expect(row.positions.every((position) => position.playingMs === 0)).toBe(
      true,
    );
  });
});

describe("accepted canonical source composition", () => {
  it("samples canonical intervals at their accepted checkpoint and avoids an archive/live double count", () => {
    const state = createRecordsSeed(),
      id = state.liveMatch.matchId;
    let match = createMatch({
      matchId: id,
      players: romaFixture.players,
      selectedPlayerIds: romaFixture.players
        .slice(0, 9)
        .map((player) => player.id),
      pitchPlaces: 7,
      plannedHalfDurationMs: 1_500_000,
      fixedKeeperId: romaFixture.players[0].id,
    });
    let seq = 0;
    const send = (command: Record<string, unknown>, ms: number) => {
      match = reduceMatch(match, {
        ...command,
        id: `stats-event-${++seq}`,
        sample: {
          monotonicMs: ms,
          sessionId: "stats-clock",
          wallTimeMs: 1_800_000_000_000 + ms,
        },
      } as MatchEvent);
    };
    for (const playerId of match.config.selectedPlayerIds)
      send({ type: "attendance.recorded", playerId, status: "present" }, 0);
    send(
      {
        type: "lineup.staged",
        lineup: ["GK", "CB", "CB", "CM", "LW", "RW", "ST"].map(
          (position, index) => ({
            position,
            slotId: `slot-${index}`,
            playerId: match.config.selectedPlayerIds[index],
          }),
        ),
      },
      0,
    );
    send({ type: "half.started" }, 0);
    send({ type: "half.paused" }, 60_000);
    const archived = {
      ...state.results[0],
      id,
      sourceMatchRevision: match.revision - 1,
      participation: [
        {
          playerId: romaFixture.players[0].id,
          playedMs: 1,
          availableBenchMs: 0,
          unavailableMs: 0,
          positionMs: { GK: 1 },
          primaryWasGoalkeeper: true,
        },
      ],
    };
    state.results = [archived];
    const before = JSON.stringify({ state, match });
    const input = playerStatsSourceFromRecords({
      state,
      acceptedMatches: [
        { teamId: state.teamId, seasonId: state.seasonId, match },
      ],
    });
    expect(input.matches).toHaveLength(1);
    const row = (
      projectPlayerStats(input, {
        role: "player",
        playerId: romaFixture.players[0].id,
      }) as { player: { knownPlayingMs: number } }
    ).player;
    expect(row.knownPlayingMs).toBe(60_000);
    expect(JSON.stringify(input)).not.toMatch(
      /attendance|preferences|target|injury|feedback/,
    );
    expect(JSON.stringify({ state, match })).toBe(before);
    archived.sourceMatchRevision = match.revision + 1;
    expect(
      playerStatsSourceFromRecords({
        state,
        acceptedMatches: [
          { teamId: state.teamId, seasonId: state.seasonId, match },
        ],
      }).matches[0].participation?.[0].playedMs,
    ).toBe(1);
  });
});
