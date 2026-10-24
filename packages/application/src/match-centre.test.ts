import { describe, expect, it } from "vitest";
import {
  selectMatchCentreDetails,
  type MatchCentreReport,
  type MatchCentreScope,
} from "./match-centre";
const scope: MatchCentreScope = {
  teamId: "roma",
  seasonId: "2026",
  audience: "spectator",
  playerId: null,
};
const goal = (
  id: string,
  half: 1 | 2 | null,
  halfElapsedMs: number | null,
) => ({
  id,
  beneficiary: "us" as const,
  isOwnGoal: false,
  scorerPlayerId: "private-player-id",
  scorerLabel: "Player 01",
  goalType: "open_play" as const,
  half,
  halfElapsedMs,
});
function report(): MatchCentreReport {
  return {
    matchId: "game",
    teamId: "roma",
    seasonId: "2026",
    visibilityScope: "spectator",
    appliedFilters: { matchId: "game", playerId: null },
    sourceMatchRevision: 8,
    suppressionReason: null,
    recordMode: "detailed_live",
    detailCompleteness: "complete",
    score: { for: 3, against: 1 },
    goals: [goal("second", 2, 5000), goal("first", 1, 12000)],
    unassignedGoalsFor: 1,
    unassignedGoalsAgainst: 1,
    communityStatus: "available",
    communityRevision: 5,
    award: {
      matchId: "game",
      result: "winners",
      winnerLabels: ["Player 02", "Player 03"],
      voteCutoffAtMs: 100,
      finalisationDeadlineAtMs: 200,
      finalisedAtMs: 150,
      deadlineMissed: false,
    },
    publishedAlbum: { matchId: "game", photoCount: 2 },
  };
}
const select = (
  value: MatchCentreReport,
  patch: Partial<Parameters<typeof selectMatchCentreDetails>[0]> = {},
) =>
  selectMatchCentreDetails({
    reports: [value],
    scope,
    matchId: "game",
    expectedSourceRevision: 8,
    ...patch,
  });
describe("match-centre permitted game composition", () => {
  it("orders accepted goals by half/active time and includes only safe final award/album fields", () => {
    const value = {
        ...report(),
        privateBallot: "secret",
        attendance: { child: "injury" },
      },
      before = JSON.stringify(value);
    const result = select(value);
    expect(result.status).toBe("available");
    expect(result.goals.map((item) => item.id)).toEqual(["first", "second"]);
    expect(result.community).toMatchObject({
      award: { winnerLabels: ["Player 02", "Player 03"] },
      publishedAlbum: { matchId: "game", photoCount: 2 },
    });
    for (const secret of [
      "privateBallot",
      "secret",
      "attendance",
      "injury",
      "private-player-id",
      "scorerPlayerId",
    ])
      expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(value)).toBe(before);
  });
  it("suppresses goals, final awards and album counts if either current projection withholds the game", () => {
    expect(
      select({ ...report(), suppressionReason: "Policy denied" }),
    ).toMatchObject({ status: "withheld", goals: [], community: null });
    expect(select(report(), { sharingRestricted: true })).toMatchObject({
      status: "withheld",
      goals: [],
      community: null,
    });
  });
  it("does not join another team, season, audience or own-player report with the same match identity", () => {
    for (const patch of [
      { teamId: "other" },
      { seasonId: "other" },
      { visibilityScope: "manager" as const },
      { appliedFilters: { matchId: "other", playerId: null } },
    ])
      expect(select({ ...report(), ...patch }).status).toBe("unavailable");
    const own = {
      ...report(),
      visibilityScope: "player" as const,
      appliedFilters: { matchId: "game", playerId: "p1" },
    };
    expect(
      select(own, { scope: { ...scope, audience: "player", playerId: "p2" } })
        .status,
    ).toBe("unavailable");
    expect(
      select(own, { scope: { ...scope, audience: "player", playerId: "p1" } })
        .status,
    ).toBe("available");
  });
  it("requires one exact report and a matching detailed accepted revision", () => {
    expect(select(report(), { reports: [] }).status).toBe("unavailable");
    expect(select(report(), { reports: [report(), report()] }).status).toBe(
      "unavailable",
    );
    expect(select(report(), { expectedSourceRevision: 9 })).toMatchObject({
      status: "stale",
      goals: [],
      community: null,
    });
  });
  it("preserves historical unknown time/type/scorer and absent goal evidence without guessing zero", () => {
    const historical = {
      ...report(),
      recordMode: "historical_summary" as const,
      detailCompleteness: "summary_only" as const,
      sourceMatchRevision: null,
      score: null,
      goals: [
        { ...goal("unknown", null, null), goalType: null, scorerLabel: null },
      ],
      unassignedGoalsFor: null,
      unassignedGoalsAgainst: null,
    };
    expect(select(historical)).toMatchObject({
      status: "available",
      recordMode: "historical_summary",
      goals: [
        { half: null, halfElapsedMs: null, goalType: null, scorerLabel: null },
      ],
      unassignedGoalsFor: null,
    });
    expect(select({ ...historical, goals: [] }).goalsEvidence).toBe(
      "not_recorded",
    );
    expect(
      select({ ...historical, goals: [], score: { for: 0, against: 0 } })
        .goalsEvidence,
    ).toBe("not_recorded");
    expect(
      select({ ...report(), goals: [], score: { for: 0, against: 0 } })
        .goalsEvidence,
    ).toBe("no_goals");
  });
  it("keeps untimed goals after timed ones and does not credit our player for an opposition own goal", () => {
    const value = {
      ...report(),
      goals: [
        goal("unknown", null, null),
        { ...goal("own", 1, 2000), isOwnGoal: true },
        goal("known", 1, 1000),
      ],
    };
    expect(
      select(value).goals.map((item) => [item.id, item.scorerLabel]),
    ).toEqual([
      ["known", "Player 01"],
      ["own", null],
      ["unknown", "Player 01"],
    ]);
  });
  it("keeps sealed no-valid-votes distinct from no final award and rejects another game album", () => {
    const value = report();
    value.award = {
      ...value.award!,
      result: "no_valid_votes",
      winnerLabels: [],
    };
    expect(select(value).community?.award?.result).toBe("no_valid_votes");
    expect(select({ ...value, award: null }).community?.award).toBeNull();
    expect(
      select({ ...value, publishedAlbum: { matchId: "other", photoCount: 20 } })
        .community,
    ).toMatchObject({
      communityStatus: "unavailable",
      award: null,
      publishedAlbum: null,
    });
  });
  it("keeps filtered community withholding dominant even if malformed optional payloads are attached", () => {
    expect(
      select({ ...report(), communityStatus: "withheld" }).community,
    ).toEqual({
      communityStatus: "withheld",
      communityRevision: 5,
      award: null,
      publishedAlbum: null,
    });
  });
});
