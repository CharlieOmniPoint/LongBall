import type { RecordedGoal, RecordedScore, RecordsActor } from "./records";
import type { ReportCommunityComposition } from "./report-community";

export interface MatchCentreScope {
  teamId: string;
  seasonId: string;
  audience: RecordsActor;
  playerId?: string | null;
}
/** Input is an already authorised report DTO, never a raw match/community projection. */
export interface MatchCentreReport extends ReportCommunityComposition {
  matchId: string;
  teamId: string;
  seasonId: string;
  visibilityScope: RecordsActor;
  appliedFilters: { matchId: string; playerId: string | null };
  sourceMatchRevision: number | null;
  suppressionReason: string | null;
  recordMode: "historical_summary" | "detailed_live";
  detailCompleteness: "summary_only" | "complete" | "review_required";
  score: RecordedScore | null;
  goals: (RecordedGoal & { scorerLabel?: string | null })[];
  unassignedGoalsFor: number | null;
  unassignedGoalsAgainst: number | null;
}
export interface MatchCentreGoal {
  id: string;
  beneficiary: "us" | "opposition";
  isOwnGoal: boolean;
  scorerLabel: string | null;
  goalType: RecordedGoal["goalType"];
  half: RecordedGoal["half"];
  halfElapsedMs: number | null;
}
export interface MatchCentreDetails {
  status: "available" | "withheld" | "unavailable" | "stale";
  recordMode: MatchCentreReport["recordMode"] | null;
  detailCompleteness: MatchCentreReport["detailCompleteness"] | null;
  goals: MatchCentreGoal[];
  goalsEvidence: "recorded" | "no_goals" | "not_recorded";
  unassignedGoalsFor: number | null;
  unassignedGoalsAgainst: number | null;
  community: ReportCommunityComposition | null;
}
const empty = (status: MatchCentreDetails["status"]): MatchCentreDetails => ({
  status,
  recordMode: null,
  detailCompleteness: null,
  goals: [],
  goalsEvidence: "not_recorded",
  unassignedGoalsFor: null,
  unassignedGoalsAgainst: null,
  community: null,
});
const count = (value: number | null) =>
  value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
/** Defensive presentation boundary: match identity, scope, audience and own binding must agree. */
export function selectMatchCentreDetails(input: {
  reports: readonly MatchCentreReport[];
  scope: MatchCentreScope;
  matchId: string;
  expectedSourceRevision?: number;
  sharingRestricted?: boolean;
}): MatchCentreDetails {
  const { scope } = input;
  const candidates = input.reports.filter(
    (report) => report.matchId === input.matchId,
  );
  if (!scope.teamId || !scope.seasonId || candidates.length !== 1)
    return empty("unavailable");
  const report = candidates[0];
  if (
    report.teamId !== scope.teamId ||
    report.seasonId !== scope.seasonId ||
    report.visibilityScope !== scope.audience ||
    report.appliedFilters.matchId !== input.matchId ||
    (scope.audience === "player"
      ? !scope.playerId || report.appliedFilters.playerId !== scope.playerId
      : report.appliedFilters.playerId !== null)
  )
    return empty("unavailable");
  // Either source can withhold content; a more permissive/stale report never overrides a denied card.
  if (input.sharingRestricted || report.suppressionReason)
    return empty("withheld");
  if (
    report.recordMode === "detailed_live" &&
    input.expectedSourceRevision !== undefined &&
    report.sourceMatchRevision !== input.expectedSourceRevision
  )
    return empty("stale");
  const goals = report.goals
    .map((goal, index) => ({
      index,
      id: goal.id,
      beneficiary: goal.beneficiary,
      isOwnGoal: goal.isOwnGoal,
      scorerLabel:
        ((goal.beneficiary === "us" && !goal.isOwnGoal) ||
          (goal.beneficiary === "opposition" && goal.isOwnGoal)) &&
        typeof goal.scorerLabel === "string" &&
        goal.scorerLabel.trim()
          ? goal.scorerLabel.trim().slice(0, 120)
          : null,
      goalType: goal.goalType,
      half: goal.half,
      halfElapsedMs: count(goal.halfElapsedMs),
    }))
    .sort((left, right) => {
      const a = left.half !== null && left.halfElapsedMs !== null;
      const b = right.half !== null && right.halfElapsedMs !== null;
      if (a !== b) return a ? -1 : 1;
      return a && b
        ? left.half! - right.half! ||
            left.halfElapsedMs! - right.halfElapsedMs! ||
            left.index - right.index
        : left.index - right.index;
    })
    .map(({ index: _index, ...goal }) => goal);
  const communityCompatible =
    (!report.award || report.award.matchId === input.matchId) &&
    (!report.publishedAlbum || report.publishedAlbum.matchId === input.matchId);
  const community: ReportCommunityComposition =
    communityCompatible && report.communityStatus === "available"
      ? {
          communityStatus: report.communityStatus,
          communityRevision: report.communityRevision,
          award: report.award
            ? {
                matchId: report.award.matchId,
                result: report.award.result,
                winnerLabels: [...report.award.winnerLabels],
                voteCutoffAtMs: report.award.voteCutoffAtMs,
                finalisationDeadlineAtMs: report.award.finalisationDeadlineAtMs,
                finalisedAtMs: report.award.finalisedAtMs,
                deadlineMissed: report.award.deadlineMissed,
              }
            : null,
          publishedAlbum: report.publishedAlbum
            ? {
                matchId: report.publishedAlbum.matchId,
                photoCount: report.publishedAlbum.photoCount,
              }
            : null,
        }
      : {
          communityStatus: communityCompatible
            ? report.communityStatus
            : "unavailable",
          communityRevision: communityCompatible
            ? report.communityRevision
            : null,
          award: null,
          publishedAlbum: null,
        };
  return {
    status: "available",
    recordMode: report.recordMode,
    detailCompleteness: report.detailCompleteness,
    goals,
    goalsEvidence: goals.length
      ? "recorded"
      : report.recordMode === "detailed_live" &&
          report.score?.for === 0 &&
          report.score.against === 0
        ? "no_goals"
        : "not_recorded",
    unassignedGoalsFor: count(report.unassignedGoalsFor),
    unassignedGoalsAgainst: count(report.unassignedGoalsAgainst),
    community,
  };
}
