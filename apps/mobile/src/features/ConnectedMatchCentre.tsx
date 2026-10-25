import { useState } from "react";
import { Text, View } from "react-native";
import type { MatchState } from "@longball/domain";
import {
  selectMatchCentreDetails,
  type MatchCentreReport,
  type MatchCentreScope,
} from "@longball/application/match-centre";
import { Button, Card, Notice, Pill } from "../ui";
import { typography } from "../ui/tokens";
import { ReportCommunityCard } from "./ReportCommunityCard";
import {
  formatUkDate,
  formatUkDateTime,
} from "@longball/application/uk-display";

export interface ConnectedMatchCentreDto {
  matchId: string;
  teamId?: string;
  seasonId?: string;
  audience: "manager" | "player" | "spectator";
  revision: number;
  status?: string;
  score?: { for: number; against: number } | null;
  halfTimeScore?: { for: number; against: number } | null;
  sharingRestricted?: boolean;
  sharingPolicyVersion?: string;
  lastRecorderSyncAt: number | null;
  freshness?: "last_synced" | "updates_delayed";
  fixture?: { opponent?: string; playedDate?: string; homeAway?: string };
  opponent?: string;
  playedDate?: string;
  ownRecord?: {
    playerId: string;
    attendance: string;
    playingMs: number;
    intervals: {
      half: number;
      startMs: number;
      endMs: number;
      state: string;
      position?: string | null;
    }[];
    completeness: string;
  };
  state?: MatchState;
}
const time = (value: number) =>
  `${Math.floor(value / 60_000)}:${String(Math.floor((value % 60_000) / 1000)).padStart(2, "0")}`;
const matchStatusLabels: Record<string, string> = {
  preparation: "Scheduled",
  scheduled: "Scheduled",
  first_half_running: "First half",
  first_half_paused: "First half paused",
  half_time: "Half-time",
  second_half_running: "Second half",
  second_half_paused: "Second half paused",
  completed: "Completed",
  abandoned: "Abandoned",
  postponed: "Postponed",
  cancelled: "Cancelled",
};
const matchStatusLabel = (status: string) =>
  matchStatusLabels[status] ?? "Status not recorded";
export function ConnectedMatchCentre({
  matches,
  observedAtMs,
  lastCheckedAtMs = null,
  refreshing = false,
  autoRefreshEnabled = false,
  refreshDelayed = false,
  audience,
  onRefresh,
  onReports,
  onPhotos,
  reportView,
  scope,
  onOpenReport,
  onOpenAlbum,
  busy,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
}: {
  matches: ConnectedMatchCentreDto[];
  observedAtMs: number;
  lastCheckedAtMs?: number | null;
  refreshing?: boolean;
  autoRefreshEnabled?: boolean;
  refreshDelayed?: boolean;
  audience: ConnectedMatchCentreDto["audience"];
  onRefresh: () => void;
  onReports: () => void;
  onPhotos: () => void;
  reportView?: { matches: readonly MatchCentreReport[] } | null;
  scope?: Omit<MatchCentreScope, "audience">;
  onOpenReport?: (matchId: string) => void;
  onOpenAlbum?: (matchId: string) => void;
  busy: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [openDetails, setOpenDetails] = useState<string | null>(null);
  return (
    <View style={{ gap: 12 }} testID="workspace-match-centre">
      <Card>
        <Text style={typography.section}>Match centre</Text>
        <Text style={typography.body}>
          Match updates appear after the team’s recorder syncs.
        </Text>
        <Text style={typography.muted} testID="match-centre-last-checked">
          {lastCheckedAtMs === null
            ? "Not checked yet"
            : `Last checked: ${formatUkDateTime(lastCheckedAtMs, { seconds: true })} · UK time`}
          {refreshing
            ? " · Refreshing…"
            : refreshDelayed
              ? " · Connection delayed"
              : ""}
        </Text>
        <Text style={typography.muted} testID="match-centre-auto-refresh">
          {autoRefreshEnabled
            ? "Checks automatically every 2 minutes, or every few seconds during a live game."
            : "Automatic checks pause while this view is inactive or a change needs attention."}
        </Text>
        <Button
          label={
            refreshing ? "Refreshing match updates…" : "Refresh match updates"
          }
          compact
          variant="secondary"
          disabled={busy || refreshing}
          onPress={onRefresh}
        />
      </Card>
      {!matches.length && (
        <Card>
          <Notice>
            No match updates are available for this team and season.
          </Notice>
          <Button
            label="Open earlier results"
            variant="secondary"
            disabled={busy}
            onPress={onReports}
          />
        </Card>
      )}
      {matches.map((match) => {
        if (
          match.audience !== audience ||
          (scope &&
            ((match.teamId !== undefined && match.teamId !== scope.teamId) ||
              (match.seasonId !== undefined &&
                match.seasonId !== scope.seasonId)))
        )
          return null;
        const manager = audience === "manager" && match.audience === "manager";
        const score = manager
          ? (match.state?.score ?? null)
          : (match.score ?? null);
        const half = manager
          ? (match.state?.halfTimeScore ?? null)
          : (match.halfTimeScore ?? null);
        const status = manager
          ? (match.state?.status ?? "unknown")
          : (match.status ?? "unknown");
        const notStarted = status === "preparation" || status === "scheduled";
        const own =
          audience === "player" &&
          match.audience === "player" &&
          scope?.playerId &&
          match.ownRecord?.playerId === scope.playerId
            ? match.ownRecord
            : undefined;
        const details = scope
          ? selectMatchCentreDetails({
              reports: reportView?.matches ?? [],
              scope: { ...scope, audience },
              matchId: match.matchId,
              expectedSourceRevision: match.revision,
              sharingRestricted: !manager && match.sharingRestricted,
            })
          : null;
        const active = [
          "first_half_running",
          "first_half_paused",
          "half_time",
          "second_half_running",
          "second_half_paused",
        ].includes(status);
        const fresh =
          match.lastRecorderSyncAt !== null &&
          observedAtMs >= match.lastRecorderSyncAt &&
          observedAtMs - match.lastRecorderSyncAt <= 15_000;
        return (
          <Card key={match.matchId}>
            <View
              testID={`match-centre-game-${match.matchId}`}
              style={{ gap: 12 }}
            >
              <Text style={typography.section}>
                {match.fixture?.opponent ??
                  match.opponent ??
                  (manager
                    ? match.state?.config.fixture?.opponent
                    : undefined) ??
                  "Team match"}
              </Text>
              <Text style={typography.muted}>
                {formatUkDate(
                  match.fixture?.playedDate ??
                    match.playedDate ??
                    (manager
                      ? match.state?.config.fixture?.playedDate
                      : undefined),
                )}{" "}
                · {matchStatusLabel(status)}
              </Text>
              {(match.sharingRestricted && !manager) ||
              details?.status === "withheld" ? (
                <Notice tone="warning">
                  Scores and results are not shared for this competition.
                </Notice>
              ) : (
                <>
                  <Text
                    testID={`match-centre-score-${match.matchId}`}
                    style={{
                      ...typography.section,
                      fontSize: 32,
                      lineHeight: 40,
                    }}
                  >
                    {notStarted
                      ? "Not started"
                      : score
                        ? `${score.for} – ${score.against}`
                        : "Score not recorded"}
                  </Text>
                  {!notStarted && (
                    <Text style={typography.body}>
                      Half time:{" "}
                      {half ? `${half.for} – ${half.against}` : "Not recorded"}
                    </Text>
                  )}
                </>
              )}
              <Pill tone={active ? (fresh ? "brand" : "warning") : "muted"}>
                {active
                  ? fresh
                    ? "Last accepted update"
                    : "Updates delayed"
                  : status === "completed"
                    ? "Full time"
                    : status === "abandoned"
                      ? "Abandoned"
                      : "Awaiting kickoff"}
              </Pill>
              {!notStarted && (
                <Text style={typography.muted}>
                  Last shared update:{" "}
                  {match.lastRecorderSyncAt === null
                    ? "Not recorded"
                    : formatUkDateTime(match.lastRecorderSyncAt)}{" "}
                  · UK time
                </Text>
              )}
              {notStarted && (
                <Text style={typography.muted}>
                  Match updates will appear when recording begins.
                </Text>
              )}
              {!notStarted && !active && (
                <Button
                  compact
                  label={
                    openDetails === match.matchId
                      ? "Hide match details"
                      : "Show match details"
                  }
                  testID={`match-centre-toggle-details-${match.matchId}`}
                  variant="quiet"
                  disabled={busy}
                  onPress={() =>
                    setOpenDetails((current) =>
                      current === match.matchId ? null : match.matchId,
                    )
                  }
                />
              )}
              {!notStarted &&
                (active || openDetails === match.matchId) &&
                (details?.status === "available" ? (
                  <>
                    <Text style={typography.section}>Goal events</Text>
                    <Text style={typography.muted}>
                      {details.recordMode === "historical_summary"
                        ? "Historical summary · only supplied goal details are recorded."
                        : "Recorded goals in match order."}
                      {details.detailCompleteness === "review_required"
                        ? " These records require review."
                        : ""}
                    </Text>
                    {details.goals.map((goal) => (
                      <View
                        key={goal.id}
                        style={{ gap: 4 }}
                        testID={`match-centre-goal-${goal.id}`}
                      >
                        <Text style={typography.label}>
                          {goal.beneficiary === "us"
                            ? goal.isOwnGoal
                              ? "Opposition own goal"
                              : `Our goal · ${goal.scorerLabel ?? "Scorer not recorded"}`
                            : goal.isOwnGoal
                              ? `Our own goal · ${goal.scorerLabel ?? "Player not recorded"}`
                              : "Opposition goal"}
                        </Text>
                        <Text style={typography.body}>
                          {goal.half === null
                            ? "Half not recorded"
                            : `Half ${goal.half}`}{" "}
                          ·{" "}
                          {goal.halfElapsedMs === null
                            ? "Time not recorded"
                            : time(goal.halfElapsedMs)}{" "}
                          ·{" "}
                          {goal.goalType === null
                            ? "Type not recorded"
                            : goal.goalType.replaceAll("_", " ")}
                        </Text>
                      </View>
                    ))}
                    {!details.goals.length && (
                      <Text style={typography.body}>
                        {details.goalsEvidence === "no_goals"
                          ? "No goals in this accepted score."
                          : "Goal details not recorded."}
                      </Text>
                    )}
                    {((details.unassignedGoalsFor ?? 0) > 0 ||
                      (details.unassignedGoalsAgainst ?? 0) > 0) && (
                      <Text style={typography.muted}>
                        Goals without individual details: our team{" "}
                        {details.unassignedGoalsFor ?? "not recorded"} ·
                        opposition{" "}
                        {details.unassignedGoalsAgainst ?? "not recorded"}.
                      </Text>
                    )}
                    <ReportCommunityCard
                      matchId={match.matchId}
                      value={details.community}
                      onOpenAlbum={onOpenAlbum}
                      disabled={busy}
                    />
                  </>
                ) : details?.status === "withheld" ? (
                  <Notice>
                    Goal details, the award and match photos are not shared for
                    this competition.
                  </Notice>
                ) : (
                  <Notice>
                    {details?.status === "stale"
                      ? "The match and report updates differ. Refresh before reviewing goal events, the award or album."
                      : "Goal, award and album details are unavailable. Refresh to check the latest records."}
                  </Notice>
                ))}
              {!notStarted && own && (
                <>
                  <Text style={typography.label}>My recorded game</Text>
                  <Text style={typography.body}>
                    Attendance: {own.attendance.replaceAll("_", " ")} · playing
                    time {time(own.playingMs)} at the last shared update.
                  </Text>
                  <Text style={typography.muted}>
                    {own.completeness.replaceAll("_", " ")}. Playing time
                    updates when the recorder syncs.
                  </Text>
                  <Button
                    label={
                      expanded === match.matchId
                        ? "Hide my playing-time details"
                        : "Show my playing-time details"
                    }
                    variant="quiet"
                    compact
                    onPress={() =>
                      setExpanded((value) =>
                        value === match.matchId ? null : match.matchId,
                      )
                    }
                  />
                  {expanded === match.matchId &&
                    own.intervals.map((interval, index) => (
                      <Text key={index} style={typography.muted}>
                        Half {interval.half} · {time(interval.startMs)}–
                        {time(interval.endMs)} ·{" "}
                        {interval.state.replaceAll("_", " ")}
                        {interval.position ? ` · ${interval.position}` : ""}
                      </Text>
                    ))}
                </>
              )}
              {!notStarted && (
                <Button
                  label={
                    audience === "player"
                      ? "Open my reports"
                      : "Open match report"
                  }
                  variant="secondary"
                  compact
                  disabled={busy}
                  testID={`match-centre-open-report-${match.matchId}`}
                  onPress={() =>
                    onOpenReport ? onOpenReport(match.matchId) : onReports()
                  }
                />
              )}
            </View>
          </Card>
        );
      })}
      <Button
        label="Open game photos"
        compact
        variant="quiet"
        disabled={busy}
        onPress={onPhotos}
      />
      {audience === "spectator" && (
        <Text style={typography.muted}>
          Your view includes shared match updates and published photos. Player
          attendance, minutes, submissions and votes stay private.
        </Text>
      )}
      {hasMore && onLoadMore && (
        <Button
          label={loadingMore ? "Loading matches…" : "Load more matches"}
          testID="match-centre-load-more"
          variant="secondary"
          disabled={busy || loadingMore}
          onPress={onLoadMore}
        />
      )}
    </View>
  );
}
