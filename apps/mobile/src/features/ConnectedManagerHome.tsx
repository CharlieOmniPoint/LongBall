import { formatUkDate } from "@longball/application/uk-display";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { PreparationState } from "@longball/application/preparation";
import type { getCommunityView } from "@longball/application/community";
import {
  selectManagerHome,
  type ManagerHomeEvent,
} from "@longball/application/manager-home";
import type { ConnectedRecordsDto } from "./ConnectedRecordsScreens";
import { Button, Card, Notice, Pill } from "../ui";
import { colors, typography } from "../ui/tokens";
import { useWorkspaceLayout } from "../ui/WorkspaceLayout";

export interface ConnectedManagerHomeProps {
  state: PreparationState;
  records: ConnectedRecordsDto | null;
  /** The current server-filtered manager DTO, never a raw community document. */
  community: ReturnType<typeof getCommunityView> | null;
  nowMs?: number;
  onOpenSchedule: () => void;
  onOpenTeam: () => void;
  onOpenReports: () => void;
  onOpenCommunity: () => void;
  onResumeMatch?: (matchId: string) => void;
  onPrepareMatch?: (fixtureId: string) => void;
}
const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;
const dateLabel = formatUkDate;
function EventSummary({
  event,
  compact = false,
}: {
  event: ManagerHomeEvent;
  compact?: boolean;
}) {
  return (
    <View style={s.event}>
      <Text style={typography.label}>
        {event.kind === "match" ? "Match" : "Training"} ·{" "}
        {dateLabel(event.date)} · {event.time ?? "Time to confirm"}
      </Text>
      <Text style={compact ? typography.body : typography.section}>
        {event.title}
      </Text>
      <Text style={typography.muted}>{event.venue ?? "Venue to confirm"}</Text>
      {!compact && (
        <>
          <Text style={typography.body}>
            {plural(
              event.selectedCount,
              event.kind === "match" ? "player selected" : "player expected",
              event.kind === "match" ? "players selected" : "players expected",
            )}
          </Text>
          <Text style={typography.muted}>
            {plural(
              event.unansweredReplies,
              "availability reply",
              "availability replies",
            )}{" "}
            outstanding · {plural(event.unrecordedCheckIns, "check-in")} not
            recorded
          </Text>
          {event.kind === "match" && (
            <Pill tone={event.prepared ? "brand" : "warning"}>
              {event.prepared
                ? "Saved preparation snapshot"
                : "Preparation to review"}
            </Pill>
          )}
        </>
      )}
    </View>
  );
}

/** UI04: a service-backed entry for the current assigned manager. */
export function ConnectedManagerHome({
  state,
  records,
  community,
  nowMs,
  onOpenSchedule,
  onOpenTeam,
  onOpenReports,
  onOpenCommunity,
  onResumeMatch,
  onPrepareMatch,
}: ConnectedManagerHomeProps) {
  const { wide } = useWorkspaceLayout();
  const cardStyle = [s.dashboardCard, wide && s.dashboardCardWide];
  const [observedAt, setObservedAt] = useState(() => Date.now());
  useEffect(() => {
    if (nowMs !== undefined) return;
    const timer = setInterval(() => setObservedAt(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [nowMs]);
  const home = selectManagerHome({
    state,
    records,
    community,
    nowMs: nowMs ?? observedAt,
  });
  const next = home.next;
  return (
    <View style={s.stack} testID="workspace-manager-home">
      {home.resumable && (
        <Card>
          <Pill>Match in progress</Pill>
          <Text style={typography.section}>Return to the accepted match</Text>
          <Text style={typography.body}>
            {home.resumable.score.for}–{home.resumable.score.against} ·{" "}
            {home.resumable.status.replaceAll("_", " ")}
          </Text>
          <Text style={typography.muted}>
            This is the service checkpoint. The recording phone may hold newer
            events.
          </Text>
          <Button
            label={onResumeMatch ? "Resume match" : "Review match in progress"}
            icon="play"
            testID="manager-home-resume"
            onPress={() =>
              onResumeMatch
                ? onResumeMatch(home.resumable!.matchId)
                : onOpenReports()
            }
          />
        </Card>
      )}

      <View style={s.dashboardGrid} testID="manager-home-dashboard-grid">
        <Card style={cardStyle}>
          <Text accessibilityRole="header" style={typography.section}>
            {home.needsOrdering ? "Next events · confirm order" : "Next event"}
          </Text>
          {next ? (
            <>
              <EventSummary event={next} />
              {next.prepared && (
                <Text style={typography.muted}>
                  Review current replies, check-in and formation before using
                  the saved preparation.
                </Text>
              )}
              <Button
                label={
                  next.kind === "match" ? "Prepare match" : "Review training"
                }
                icon={next.kind === "match" ? "play" : "calendar"}
                testID="manager-home-prepare"
                onPress={() =>
                  next.kind === "match" && onPrepareMatch
                    ? onPrepareMatch(next.id)
                    : onOpenSchedule()
                }
              />
            </>
          ) : home.needsOrdering ? (
            <>
              <Notice tone="warning">
                The recorded dates or times do not establish one next event.
                Confirm the schedule before preparing a match.
              </Notice>
              {home.nextCandidates.slice(0, 3).map((event) => (
                <EventSummary
                  key={`${event.kind}:${event.id}`}
                  event={event}
                  compact
                />
              ))}
              {home.nextCandidates.length > 3 && (
                <Text style={typography.muted}>
                  {home.nextCandidates.length - 3} more events on this date.
                </Text>
              )}
              <Button
                label="Review next events"
                icon="calendar"
                onPress={onOpenSchedule}
              />
            </>
          ) : (
            <>
              <Text style={typography.body}>
                No upcoming dated event is recorded.
              </Text>
              {home.undated.length > 0 && (
                <Notice tone="warning">
                  {plural(home.undated.length, "event")} still need a date.
                  Review them before relying on this schedule.
                </Notice>
              )}
              <Button
                label={
                  home.undated.length ? "Review schedule" : "Create fixture"
                }
                icon="calendar"
                testID="manager-home-create-fixture"
                onPress={onOpenSchedule}
              />
            </>
          )}
        </Card>

        <Card style={cardStyle}>
          <Text accessibilityRole="header" style={typography.section}>
            To follow up
          </Text>
          <View style={s.counts}>
            <View style={s.count}>
              <Text style={s.number}>{home.repliesDue}</Text>
              <Text style={typography.muted}>availability replies</Text>
            </View>
            <View style={s.count}>
              <Text style={s.number}>{home.attendanceToRecord}</Text>
              <Text style={typography.muted}>attendance records</Text>
            </View>
          </View>
          <Text style={typography.muted}>
            Replies are plans. Attendance is recorded separately for selected
            players and held training.
          </Text>
          {home.olderUnresolved.length > 0 && (
            <Notice tone="warning">
              {plural(home.olderUnresolved.length, "older event")} still show
              scheduled. Check the recorded status.
            </Notice>
          )}
          <Button
            label="Review replies and attendance"
            variant="secondary"
            onPress={onOpenSchedule}
          />
          {home.missingPreferences > 0 && (
            <Notice tone="warning">
              {plural(home.missingPreferences, "player profile")} need complete
              position preferences. Review the setup in Squad.
            </Notice>
          )}
          <Button
            label={
              home.missingPreferences
                ? "Complete player preferences"
                : "Open squad"
            }
            variant="quiet"
            icon="users"
            onPress={onOpenTeam}
          />
        </Card>

        <Card style={cardStyle}>
          <Text accessibilityRole="header" style={typography.section}>
            Team photos and concerns
          </Text>
          {home.photoReviews === null || home.concernsToReview === null ? (
            <Text style={typography.muted}>
              The current photo-review status is unavailable.
            </Text>
          ) : (
            <>
              <Text style={typography.body}>
                {plural(home.photoReviews, "photo")} awaiting manager review
              </Text>
              <Text style={typography.body}>
                {plural(home.concernsToReview, "concern")} to review
              </Text>
            </>
          )}
          <Button
            label="Review team photos"
            variant="secondary"
            icon="photo"
            onPress={onOpenCommunity}
          />
        </Card>

        <Card style={cardStyle}>
          <Text accessibilityRole="header" style={typography.section}>
            Upcoming schedule
          </Text>
          {home.upcoming.length ? (
            home.upcoming
              .slice(0, 3)
              .map((event) => (
                <EventSummary
                  key={`${event.kind}:${event.id}`}
                  event={event}
                  compact
                />
              ))
          ) : (
            <Text style={typography.muted}>
              No dated upcoming matches or training.
            </Text>
          )}
          {home.undated.length > 0 && (
            <Text style={typography.muted}>
              {plural(home.undated.length, "event")} have a date to confirm.
            </Text>
          )}
          <Button
            label="Open schedule"
            variant="quiet"
            icon="calendar"
            onPress={onOpenSchedule}
          />
        </Card>

        <Card style={cardStyle}>
          <Text accessibilityRole="header" style={typography.section}>
            Recent results
          </Text>
          {!home.recordsAvailable ? (
            <Text style={typography.muted}>
              Current authorised results are unavailable.
            </Text>
          ) : !home.recentResults.length ? (
            <Text style={typography.muted}>
              No completed result is recorded.
            </Text>
          ) : (
            <>
              {home.recentOrderUnknown && (
                <Notice>
                  These results share a played date and their order is not
                  recorded.
                </Notice>
              )}
              {home.recentResults.slice(0, 3).map((result) => (
                <View key={result.id} style={s.result}>
                  <View style={s.resultLabel}>
                    <Text style={typography.label}>{result.opponent}</Text>
                    <Text style={typography.muted}>
                      {dateLabel(result.playedDate)} ·{" "}
                      {result.recordMode === "historical_summary"
                        ? "Historical summary"
                        : "Recorded match"}
                    </Text>
                  </View>
                  <Text style={s.resultScore}>
                    {result.finalScore
                      ? `${result.finalScore.for}–${result.finalScore.against}`
                      : "Score not recorded"}
                  </Text>
                </View>
              ))}
            </>
          )}
          <Button
            label="Open reports"
            variant="secondary"
            icon="chart"
            onPress={onOpenReports}
          />
        </Card>
      </View>
      <Text style={s.footnote}>
        Schedule dates and times use Europe/London for the pilot.
      </Text>
    </View>
  );
}
const s = StyleSheet.create({
  stack: { gap: 16 },
  dashboardGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    gap: 16,
  },
  dashboardCard: { flexBasis: "100%", flexGrow: 1, minWidth: 0 },
  dashboardCardWide: { flexBasis: "48%" },
  event: { gap: 6, paddingVertical: 4 },
  counts: { flexDirection: "row", flexWrap: "wrap", gap: 20 },
  count: { minWidth: 120, flex: 1 },
  number: {
    color: colors.brand,
    fontSize: 30,
    lineHeight: 38,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  result: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 12,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 12,
  },
  resultLabel: { flex: 1, minWidth: 140 },
  resultScore: {
    color: colors.ink,
    fontSize: 20,
    lineHeight: 28,
    fontWeight: "700",
    flexShrink: 1,
  },
  footnote: { color: colors.inkMuted, fontSize: 12, lineHeight: 18 },
});
