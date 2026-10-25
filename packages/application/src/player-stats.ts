import { goalRecords, playerMinutes } from "@longball/domain";
import type { MatchRecord, RecordsState } from "./records";
import type { AcceptedRecordsMatch } from "./records-service";
import { AccessError } from "./access";
import { goalkeeperCleanSheetOutcomes, type GoalkeeperOutcome } from "./goalkeeper-clean-sheets";

export interface StatsPosition {
  code: string;
  label: string;
  active: boolean;
}
export interface StatsFormation {
  id: string;
  label: string;
  slots: {
    id: string;
    positionCode: string;
    label: string;
    x: number;
    y: number;
  }[];
}
/** A private service input containing only accepted match facts needed for stats. */
export interface StatsMatchEvidence {
  id: string;
  teamId: string;
  seasonId: string;
  status: MatchRecord["status"];
  recordMode: MatchRecord["recordMode"];
  detailCompleteness: MatchRecord["detailCompleteness"];
  revision: number;
  sourceMatchRevision: number | null;
  updatedAt: string | null;
  finalScore: { for: number; against: number } | null;
  goals: {
    id: string;
    beneficiary: "us" | "opposition";
    isOwnGoal: boolean;
    scorerPlayerId: string | null;
  }[];
  participation:
    | {
        playerId: string;
        playedMs: number;
        positionMs: Record<string, number>;
      }[]
    | null;
  /** Narrow PostgreSQL administrator helpers return counts, never goal events. */
  scorerTotals?: {
    playerId: string;
    knownGoals: number;
    knownOwnGoals: number;
  }[];
  scoringCoverage?: "complete" | "partial" | "unknown";
  goalkeeperOutcomes?: GoalkeeperOutcome[];
}
export interface PlayerStatsSource {
  clubId: string;
  teamId: string;
  seasonId: string;
  seasonLabel: string;
  revision: number;
  players: { id: string; label: string }[];
  matches: StatsMatchEvidence[];
  positions: StatsPosition[];
  formation: StatsFormation | null;
}
export interface StatsCoverage {
  recordedMatches: number;
  playingTimeKnownMatches: number;
  playingTimeUnknownMatches: number;
  reviewRequiredMatches: number;
  scoringCompleteMatches: number;
  scoringPartialMatches: number;
  scoringUnknownMatches: number;
}
export interface PositionStats {
  code: string;
  label: string;
  playingMs: number;
  /** Share of known playing time, including its unknown-position remainder. */
  percentage: number | null;
}
export interface PositionStatsTotals {
  knownPlayingMs: number;
  positions: PositionStats[];
  unknownPositionMs: number;
}
export interface PlayerStatsRow extends PositionStatsTotals {
  playerId: string;
  label: string;
  knownAppearances: number;
  knownGoals: number;
  knownOwnGoals: number;
  knownCleanSheets: number;
  goalkeepingReviewedMatches: number;
  goalkeepingUnknownMatches: number;
  coverage: StatsCoverage;
}
export interface StatsScope {
  clubId: string;
  teamId: string;
  seasonId: string;
  seasonLabel: string;
  projectionVersion: number;
  asOf: string | null;
}
export interface OwnPlayerStatsDto {
  kind: "own-player-stats";
  scope: StatsScope;
  player: PlayerStatsRow;
}
export interface TeamPlayerStatsDto {
  kind: "team-player-stats";
  scope: StatsScope;
  players: PlayerStatsRow[];
  team: PositionStatsTotals;
  formation: StatsFormation | null;
}
export type PlayerStatsDto = OwnPlayerStatsDto | TeamPlayerStatsDto;
export interface StatsViewer {
  role: "manager" | "administrator" | "player" | "spectator";
  playerId?: string;
  teamId?: string;
  seasonId?: string;
}

function denied(): never {
  throw new AccessError(
    "NOT_FOUND",
    404,
    "The requested player statistics are unavailable.",
  );
}
const safeMs = (value: number) => Number.isSafeInteger(value) && value >= 0;
const instant = (value: string | null): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
function cleanEvidence(record: StatsMatchEvidence): StatsMatchEvidence {
  return {
    id: record.id,
    teamId: record.teamId,
    seasonId: record.seasonId,
    status: record.status,
    recordMode: record.recordMode,
    detailCompleteness: record.detailCompleteness,
    revision: record.revision,
    sourceMatchRevision: record.sourceMatchRevision,
    updatedAt: record.updatedAt,
    finalScore: record.finalScore
      ? { for: record.finalScore.for, against: record.finalScore.against }
      : null,
    goals: record.goals.map((goal) => ({
      id: goal.id,
      beneficiary: goal.beneficiary,
      isOwnGoal: goal.isOwnGoal,
      scorerPlayerId: goal.scorerPlayerId,
    })),
    goalkeeperOutcomes: record.recordMode === "detailed_live" && (record as MatchRecord).participation?.every(row => Array.isArray(row.intervals))
      ? goalkeeperCleanSheetOutcomes({
          completed: record.status === "completed", reviewRequired: record.detailCompleteness !== "complete",
          activeDurationMs: (record as MatchRecord).actualActiveDurationMs ?? 0,
          intervals: (record as MatchRecord).participation!.flatMap(row => row.intervals!.map(interval => ({...interval, playerId:row.playerId}))),
          oppositionGoals: (record as MatchRecord).goals.filter(goal => goal.beneficiary === "opposition").map(goal => ({atMs: goal.half !== null && goal.halfElapsedMs !== null ? goal.halfElapsedMs + (goal.half === 2 ? Math.max(0,...(record as MatchRecord).participation!.flatMap(row => row.intervals!.filter(interval => interval.half === 1).map(interval => interval.endMs))) : 0) : null})),
          recordedOppositionScore:record.finalScore?.against ?? null,
        }) : record.goalkeeperOutcomes?.map(row => ({...row})),
    participation:
      record.participation?.map((row) => ({
        playerId: row.playerId,
        playedMs: row.playedMs,
        positionMs: { ...row.positionMs },
      })) ?? null,
  };
}
/** Reuses the canonical accepted participation selector, sampled only at its accepted checkpoint. */
export function playerStatsSourceFromRecords(input: {
  state: RecordsState;
  acceptedMatches?: AcceptedRecordsMatch[];
  positions?: StatsPosition[];
  formation?: StatsFormation | null;
}): PlayerStatsSource {
  const { state } = input,
    records = new Map<string, StatsMatchEvidence>();
  for (const record of state.results) {
    if (record.teamId !== state.teamId || record.seasonId !== state.seasonId)
      continue;
    const previous = records.get(record.id);
    if (!previous || record.revision > previous.revision)
      records.set(record.id, cleanEvidence(record));
  }
  for (const accepted of [...(input.acceptedMatches ?? [])].sort(
    (left, right) => left.match.revision - right.match.revision,
  )) {
    const match = accepted.match,
      id = match.config.matchId;
    if (
      accepted.teamId !== state.teamId ||
      accepted.seasonId !== state.seasonId ||
      match.status === "preparation"
    )
      continue;
    if (
      match.config.fixture &&
      (match.config.fixture.teamId !== state.teamId ||
        match.config.fixture.seasonId !== state.seasonId)
    )
      denied();
    const previous = records.get(id);
    if (
      previous?.sourceMatchRevision != null &&
      previous.sourceMatchRevision >= match.revision
    )
      continue;
    const sample = match.anchor?.sample ?? {
      monotonicMs: 0,
      sessionId: "stats-checkpoint",
      wallTimeMs: 0,
    };
    const observed =
      match.eventHistory?.at(-1)?.sample.wallTimeMs ??
      match.completedAtMs ??
      match.anchor?.sample.wallTimeMs;
    records.set(id, {
      id,
      teamId: state.teamId,
      seasonId: state.seasonId,
      status:
        match.status === "completed"
          ? "completed"
          : match.status === "abandoned"
            ? "abandoned"
            : "incomplete",
      recordMode: "detailed_live",
      detailCompleteness: match.recoveryRequired
        ? "review_required"
        : "complete",
      revision: previous?.revision ?? 0,
      sourceMatchRevision: match.revision,
      updatedAt:
        typeof observed === "number" &&
        observed > 0 &&
        Number.isFinite(observed)
          ? new Date(observed).toISOString()
          : (previous?.updatedAt ?? null),
      finalScore: { for: match.score.for, against: match.score.against },
      goals: goalRecords(match)
        .filter((goal) => !goal.voided)
        .map((goal) => ({
          id: goal.eventId,
          beneficiary: goal.beneficiary,
          isOwnGoal: goal.isOwnGoal,
          scorerPlayerId: goal.scorerPlayerId,
        })),
      goalkeeperOutcomes: goalkeeperCleanSheetOutcomes({
        completed:match.status === "completed", reviewRequired:match.recoveryRequired || match.schemaVersion !== 2,
        activeDurationMs:match.matchActiveMs, intervals:match.intervals,
        oppositionGoals:goalRecords(match).filter(goal => !goal.voided && goal.beneficiary === "opposition").map(goal => ({atMs:goal.effective.matchElapsedMs})),
        recordedOppositionScore:match.score.against,
      }),
      participation: playerMinutes(match, sample).map((row) => ({
        playerId: row.playerId,
        playedMs: row.playingMs,
        positionMs: { ...row.positionMs },
      })),
    });
  }
  return {
    clubId: state.clubId,
    teamId: state.teamId,
    seasonId: state.seasonId,
    seasonLabel: state.seasonLabel,
    revision: state.revision,
    players: state.players.map((player) => ({
      id: player.id,
      label: player.label,
    })),
    matches: [...records.values()],
    positions: (input.positions ?? []).map((position) => ({
      code: position.code,
      label: position.label,
      active: position.active,
    })),
    formation: cleanFormation(input.formation ?? null),
  };
}
function cleanFormation(value: StatsFormation | null): StatsFormation | null {
  if (
    !value ||
    value.slots.some(
      (slot) =>
        !Number.isFinite(slot.x) ||
        !Number.isFinite(slot.y) ||
        slot.x < 0 ||
        slot.x > 1 ||
        slot.y < 0 ||
        slot.y > 1,
    )
  )
    return null;
  return {
    id: value.id,
    label: value.label,
    slots: value.slots.map((slot) => ({
      id: slot.id,
      positionCode: slot.positionCode,
      label: slot.label,
      x: slot.x,
      y: slot.y,
    })),
  };
}
function positionsFor(
  totals: Record<string, number>,
  knownPlayingMs: number,
  catalogue: StatsPosition[],
): PositionStats[] {
  const codes = [
    ...new Set([
      ...catalogue.map((position) => position.code),
      ...Object.keys(totals),
    ]),
  ];
  return codes.map((code) => ({
    code,
    label: catalogue.find((position) => position.code === code)?.label ?? code,
    playingMs: totals[code] ?? 0,
    percentage:
      knownPlayingMs > 0 ? ((totals[code] ?? 0) / knownPlayingMs) * 100 : null,
  }));
}
/** Pure projection, not authentication. The service must bind role and own player to current membership. */
export function projectPlayerStats(
  source: PlayerStatsSource,
  viewer: StatsViewer,
): PlayerStatsDto {
  if (
    !["manager", "administrator", "player"].includes(viewer.role) ||
    (viewer.teamId && viewer.teamId !== source.teamId) ||
    (viewer.seasonId && viewer.seasonId !== source.seasonId)
  )
    denied();
  const players =
    viewer.role === "player"
      ? source.players.filter((player) => player.id === viewer.playerId)
      : source.players;
  if (viewer.role === "player" && players.length !== 1) denied();
  const byId = new Map<string, StatsMatchEvidence>();
  for (const record of source.matches) {
    if (
      record.teamId !== source.teamId ||
      record.seasonId !== source.seasonId ||
      record.status === "cancelled" ||
      record.status === "postponed"
    )
      continue;
    if (
      record.status !== "completed" &&
      !(
        record.recordMode === "detailed_live" &&
        ["incomplete", "abandoned"].includes(record.status)
      )
    )
      continue;
    const previous = byId.get(record.id);
    if (
      !previous ||
      (record.sourceMatchRevision ?? -1) >
        (previous.sourceMatchRevision ?? -1) ||
      (record.sourceMatchRevision === previous.sourceMatchRevision &&
        record.revision > previous.revision)
    )
      byId.set(record.id, record);
  }
  const records = [...byId.values()],
    observed = records
      .map((record) => record.updatedAt)
      .filter(instant)
      .sort((left, right) => Date.parse(left) - Date.parse(right));
  const rows: PlayerStatsRow[] = players.map((player) => {
    const coverage: StatsCoverage = {
      recordedMatches: records.length,
      playingTimeKnownMatches: 0,
      playingTimeUnknownMatches: 0,
      reviewRequiredMatches: 0,
      scoringCompleteMatches: 0,
      scoringPartialMatches: 0,
      scoringUnknownMatches: 0,
    };
    let knownPlayingMs = 0,
      knownAppearances = 0,
      knownGoals = 0,
      knownOwnGoals = 0,
      knownCleanSheets = 0,
      goalkeepingReviewedMatches = 0,
      goalkeepingUnknownMatches = 0,
      unknownPositionMs = 0;
    const positionMs: Record<string, number> = Object.create(null);
    for (const record of records) {
      const goalkeeper = record.goalkeeperOutcomes?.find(row => row.playerId === player.id);
      if (goalkeeper && goalkeeper.outcome !== "unknown") {
        goalkeepingReviewedMatches++;
        knownCleanSheets += Number(goalkeeper.outcome === "clean_sheet");
      } else if (goalkeeper || !record.participation || record.participation.some(row => row.playerId === player.id && (row.positionMs.GK ?? 0) > 0)) goalkeepingUnknownMatches++;
      if (record.detailCompleteness === "review_required") {
        coverage.reviewRequiredMatches++;
        coverage.playingTimeUnknownMatches++;
        coverage.scoringUnknownMatches++;
        continue;
      }
      const entries =
        record.participation?.filter((entry) => entry.playerId === player.id) ??
        [];
      const entry = entries.length === 1 ? entries[0] : null;
      const positions = entry ? Object.values(entry.positionMs) : [];
      if (
        entry &&
        safeMs(entry.playedMs) &&
        positions.every(safeMs) &&
        positions.reduce((sum, ms) => sum + ms, 0) <= entry.playedMs
      ) {
        coverage.playingTimeKnownMatches++;
        knownPlayingMs += entry.playedMs;
        knownAppearances += Number(entry.playedMs > 0);
        const named = Object.entries(entry.positionMs).filter(([code]) =>
          /^[A-Z]{2}$/.test(code),
        );
        unknownPositionMs +=
          entry.playedMs - named.reduce((sum, [, ms]) => sum + ms, 0);
        for (const [code, ms] of named)
          positionMs[code] = (positionMs[code] ?? 0) + ms;
      } else coverage.playingTimeUnknownMatches++;
      const goals = [
        ...new Map(record.goals.map((goal) => [goal.id, goal])).values(),
      ];
      const counts = record.scorerTotals?.find(
        (item) => item.playerId === player.id,
      );
      knownGoals +=
        counts && safeMs(counts.knownGoals)
          ? counts.knownGoals
          : goals.filter(
              (goal) =>
                goal.beneficiary === "us" &&
                !goal.isOwnGoal &&
                goal.scorerPlayerId === player.id,
            ).length;
      knownOwnGoals +=
        counts && safeMs(counts.knownOwnGoals)
          ? counts.knownOwnGoals
          : goals.filter(
              (goal) =>
                goal.beneficiary === "opposition" &&
                goal.isOwnGoal &&
                goal.scorerPlayerId === player.id,
            ).length;
      const complete =
        record.finalScore !== null &&
        goals.filter((goal) => goal.beneficiary === "us").length ===
          record.finalScore.for &&
        goals.filter((goal) => goal.beneficiary === "opposition").length ===
          record.finalScore.against &&
        goals.every((goal) =>
          (goal.beneficiary === "us" && !goal.isOwnGoal) ||
          (goal.beneficiary === "opposition" && goal.isOwnGoal)
            ? goal.scorerPlayerId !== null
            : true,
        );
      if (
        record.scoringCoverage === "complete" ||
        (!record.scoringCoverage && complete)
      )
        coverage.scoringCompleteMatches++;
      else if (
        record.scoringCoverage === "partial" ||
        (!record.scoringCoverage &&
          (record.finalScore !== null || goals.length))
      )
        coverage.scoringPartialMatches++;
      else coverage.scoringUnknownMatches++;
    }
    return {
      playerId: player.id,
      label: player.label,
      knownPlayingMs,
      knownAppearances,
      knownGoals,
      knownOwnGoals,
      knownCleanSheets,
      goalkeepingReviewedMatches,
      goalkeepingUnknownMatches,
      positions: positionsFor(positionMs, knownPlayingMs, source.positions),
      unknownPositionMs,
      coverage,
    };
  });
  const scope: StatsScope = {
    clubId: source.clubId,
    teamId: source.teamId,
    seasonId: source.seasonId,
    seasonLabel: source.seasonLabel,
    projectionVersion: source.revision,
    asOf: observed.at(-1) ?? null,
  };
  if (viewer.role === "player")
    return { kind: "own-player-stats", scope, player: rows[0] };
  const knownPlayingMs = rows.reduce((sum, row) => sum + row.knownPlayingMs, 0),
    positionMs: Record<string, number> = Object.create(null);
  for (const row of rows)
    for (const position of row.positions)
      positionMs[position.code] =
        (positionMs[position.code] ?? 0) + position.playingMs;
  return {
    kind: "team-player-stats",
    scope,
    players: rows,
    team: {
      knownPlayingMs,
      positions: positionsFor(positionMs, knownPlayingMs, source.positions),
      unknownPositionMs: rows.reduce(
        (sum, row) => sum + row.unknownPositionMs,
        0,
      ),
    },
    formation: cleanFormation(source.formation),
  };
}

/** Bind fetched aggregates to the fresh role/team/season and reject private extras. */
export function assertPlayerStatsDto(
  value: unknown,
  viewer: StatsViewer & { teamId: string; seasonId: string },
): asserts value is PlayerStatsDto {
  const object = (item: unknown): item is Record<string, unknown> =>
    Boolean(item && typeof item === "object" && !Array.isArray(item));
  const exact = (item: Record<string, unknown>, fields: string[]) =>
    Object.keys(item).length === fields.length &&
    fields.every((field) => Object.hasOwn(item, field));
  const text = (item: unknown) =>
    typeof item === "string" &&
    item.length > 0 &&
    item.length <= 150 &&
    !/[\u0000-\u001f\u007f]/.test(item);
  const number = (item: unknown): item is number =>
    typeof item === "number" && safeMs(item);
  const totals = (item: unknown): item is Record<string, unknown> => {
    if (
      !object(item) ||
      !number(item.knownPlayingMs) ||
      !number(item.unknownPositionMs) ||
      !Array.isArray(item.positions)
    )
      return false;
    let named = 0;
    const codes = new Set<string>();
    for (const position of item.positions) {
      if (
        !object(position) ||
        !exact(position, ["code", "label", "playingMs", "percentage"]) ||
        typeof position.code !== "string" ||
        !/^[A-Z]{2}$/.test(position.code) ||
        codes.has(position.code) ||
        !text(position.label) ||
        !number(position.playingMs)
      )
        return false;
      const expected = item.knownPlayingMs
        ? (position.playingMs / item.knownPlayingMs) * 100
        : null;
      if (
        expected === null
          ? position.percentage !== null
          : typeof position.percentage !== "number" ||
            !Number.isFinite(position.percentage) ||
            Math.abs(position.percentage - expected) > 0.000001
      )
        return false;
      codes.add(position.code);
      named += position.playingMs;
    }
    return named + item.unknownPositionMs === item.knownPlayingMs;
  };
  const row = (item: unknown) => {
    if (
      !totals(item) ||
      !exact(item, [
        "playerId",
        "label",
        "knownPlayingMs",
        "knownAppearances",
        "knownGoals",
        "knownOwnGoals",
        "knownCleanSheets",
        "goalkeepingReviewedMatches",
        "goalkeepingUnknownMatches",
        "positions",
        "unknownPositionMs",
        "coverage",
      ]) ||
      !text(item.playerId) ||
      !text(item.label) ||
      !number(item.knownAppearances) ||
      !number(item.knownGoals) ||
      !number(item.knownOwnGoals) ||
      !number(item.knownCleanSheets) ||
      !number(item.goalkeepingReviewedMatches) ||
      !number(item.goalkeepingUnknownMatches) ||
      item.knownCleanSheets > item.goalkeepingReviewedMatches ||
      !object(item.coverage)
    )
      return false;
    const coverage = item.coverage;
    const fields = [
      "recordedMatches",
      "playingTimeKnownMatches",
      "playingTimeUnknownMatches",
      "reviewRequiredMatches",
      "scoringCompleteMatches",
      "scoringPartialMatches",
      "scoringUnknownMatches",
    ];
    return (
      exact(coverage, fields) &&
      fields.every((field) => number(coverage[field])) &&
      Number(coverage.playingTimeKnownMatches) +
        Number(coverage.playingTimeUnknownMatches) ===
        coverage.recordedMatches &&
      Number(coverage.scoringCompleteMatches) +
        Number(coverage.scoringPartialMatches) +
        Number(coverage.scoringUnknownMatches) ===
        coverage.recordedMatches &&
      Number(coverage.reviewRequiredMatches) <=
        Number(coverage.playingTimeUnknownMatches)
    );
  };
  if (
    !object(value) ||
    !object(value.scope) ||
    !exact(value.scope, [
      "clubId",
      "teamId",
      "seasonId",
      "seasonLabel",
      "projectionVersion",
      "asOf",
    ]) ||
    !text(value.scope.clubId) ||
    value.scope.teamId !== viewer.teamId ||
    value.scope.seasonId !== viewer.seasonId ||
    !text(value.scope.seasonLabel) ||
    !number(value.scope.projectionVersion) ||
    !(
      value.scope.asOf === null ||
      (typeof value.scope.asOf === "string" && instant(value.scope.asOf))
    )
  )
    denied();
  if (viewer.role === "player") {
    if (
      value.kind !== "own-player-stats" ||
      !exact(value, ["kind", "scope", "player"]) ||
      !row(value.player) ||
      (value.player as PlayerStatsRow).playerId !== viewer.playerId
    )
      denied();
    return;
  }
  if (
    !["manager", "administrator"].includes(viewer.role) ||
    value.kind !== "team-player-stats" ||
    !exact(value, ["kind", "scope", "players", "team", "formation"]) ||
    !Array.isArray(value.players) ||
    !value.players.every(row) ||
    new Set(value.players.map((player) => player.playerId)).size !==
      value.players.length ||
    !totals(value.team) ||
    !exact(value.team, ["knownPlayingMs", "positions", "unknownPositionMs"])
  )
    denied();
  if (
    value.formation !== null &&
    (!object(value.formation) ||
      !exact(value.formation, ["id", "label", "slots"]) ||
      !text(value.formation.id) ||
      !text(value.formation.label) ||
      !Array.isArray(value.formation.slots) ||
      value.formation.slots.some(
        (slot) =>
          !object(slot) ||
          !exact(slot, ["id", "positionCode", "label", "x", "y"]) ||
          !text(slot.id) ||
          !text(slot.positionCode) ||
          !text(slot.label) ||
          typeof slot.x !== "number" ||
          typeof slot.y !== "number" ||
          !Number.isFinite(slot.x) ||
          !Number.isFinite(slot.y) ||
          slot.x < 0 ||
          slot.x > 1 ||
          slot.y < 0 ||
          slot.y > 1,
      ))
  )
    denied();
}
