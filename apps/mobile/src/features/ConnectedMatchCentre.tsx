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
export function ConnectedMatchCentre({
  matches,
  observedAtMs,
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
  return (
    <View style={{ gap: 12 }} testID="workspace-match-centre">
      <Card>
        <Text style={typography.section}>Match centre</Text>
        <Text style={typography.body}>
          These are accepted service updates. A recorder may have newer events
          waiting on its phone.
        </Text>
        <Button
          label="Refresh accepted match updates"
          variant="secondary"
          disabled={busy}
          onPress={onRefresh}
        />
      </Card>
      {!matches.length && (
        <Notice>
          No accepted match updates are available in this authorised team and
          season. Historical summaries remain in permitted reports.
        </Notice>
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
                {match.fixture?.playedDate ??
                  match.playedDate ??
                  (manager
                    ? match.state?.config.fixture?.playedDate
                    : undefined) ??
                  "Date unavailable"}{" "}
                · {status.replaceAll("_", " ")}
              </Text>
              {(match.sharingRestricted && !manager) ||
              details?.status === "withheld" ? (
                <Notice tone="warning">
                  Scores and derived results are not shared for this
                  competition. An invitation does not override the applicable
                  sharing policy.
                </Notice>
              ) : (
                <>
                  <Text
                    style={{
                      ...typography.section,
                      fontSize: 32,
                      lineHeight: 40,
                    }}
                  >
                    {score
                      ? `${score.for} – ${score.against}`
                      : "Score not recorded"}
                  </Text>
                  <Text style={typography.body}>
                    Half time:{" "}
                    {half ? `${half.for} – ${half.against}` : "Not recorded"}
                  </Text>
                </>
              )}
              <Pill tone={fresh ? "brand" : "warning"}>
                {fresh ? "Last accepted update" : "Updates delayed"}
              </Pill>
              <Text style={typography.muted}>
                Recorder last synchronised:{" "}
                {match.lastRecorderSyncAt === null
                  ? "Not recorded"
                  : new Date(match.lastRecorderSyncAt).toLocaleString("en-GB", {
                      timeZone: "Europe/London",
                    })}{" "}
                · revision {match.revision}
              </Text>
              {details?.status === "available" ? (
                <>
                  <Text style={typography.section}>Goal events</Text>
                  <Text style={typography.muted}>
                    {details.recordMode === "historical_summary"
                      ? "Historical summary · only supplied goal details are recorded."
                      : "Accepted match events · ordered by half and active time."}
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
                  Competition policy withholds this match’s goal events, award
                  and contextual photos.
                </Notice>
              ) : (
                <Notice>
                  {details?.status === "stale"
                    ? "The match and report updates differ. Refresh before reviewing goal events, the award or album."
                    : status === "preparation"
                      ? "Goal events and the final award become available after recorded play. No match report has been recorded yet."
                      : "Goal, award and album details are unavailable in this current permitted report. Refresh to check the latest records."}
                </Notice>
              )}
              {own && (
                <>
                  <Text style={typography.label}>My recorded game</Text>
                  <Text style={typography.body}>
                    Attendance: {own.attendance.replaceAll("_", " ")} · playing
                    time {time(own.playingMs)} through the last accepted
                    boundary.
                  </Text>
                  <Text style={typography.muted}>
                    {own.completeness.replaceAll("_", " ")}. The service does
                    not extrapolate this phone’s live clock.
                  </Text>
                  <Button
                    label={
                      expanded === match.matchId
                        ? "Hide my accepted intervals"
                        : "Show my accepted intervals"
                    }
                    variant="quiet"
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
              <Button
                label={
                  audience === "player"
                    ? "Open my reports"
                    : "Open permitted team reports"
                }
                variant="secondary"
                disabled={busy}
                testID={`match-centre-open-report-${match.matchId}`}
                onPress={() =>
                  onOpenReport ? onOpenReport(match.matchId) : onReports()
                }
              />
            </View>
          </Card>
        );
      })}
      <Button
        label="Open published game albums"
        variant="quiet"
        disabled={busy}
        onPress={onPhotos}
      />
      {audience === "spectator" && (
        <Notice>
          Spectator access includes permitted team updates and published photos.
          Named attendance, minutes, private submissions and ballots stay
          outside this view.
        </Notice>
      )}
      {hasMore && onLoadMore && <Button label={loadingMore ? "Loading accepted matches…" : "Load more accepted matches"} testID="match-centre-load-more" variant="secondary" disabled={busy || loadingMore} onPress={onLoadMore} />}
    </View>
  );
}
