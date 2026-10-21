import { useState, type ReactNode } from "react";
import {
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import type { MatchState } from "@longball/domain";
import {
  reduceRecords,
  selectMatchReport,
  selectParticipationReport,
  selectSeasonResults,
  type AttendanceSummary,
  type FixtureClass,
  type HistoricalResultInput,
  type MatchRecord,
  type ParticipationReportRow,
  type RecordedGoal,
  type RecordedScore,
  type RecordsActor,
  type RecordsCommand,
  type RecordsState,
} from "@longball/application/records";
import { randomUUID } from "../platform/id";
import { Button, Card, colors, Notice, Pill } from "../ui";

export interface RecordsScreensProps {
  state: RecordsState;
  onChange?: (command: RecordsCommand) => Promise<boolean> | boolean;
  match: MatchState | null;
  actor: RecordsActor;
  /** Required for a child/parent's own named reports; never inferred from list order. */
  playerId?: string;
  busy?: boolean;
  teamLabel?: string;
  synthetic?: boolean;
  service?: boolean;
  renderMatchCommunity?: (matchId: string) => ReactNode;
  initialMatchId?: string;
}
type Tab = "results" | "participation";
type Editor = { record: MatchRecord | null };
const scoreLabel = (score: RecordedScore | null) =>
  score ? `${score.for} – ${score.against}` : "Not recorded";
const dateLabel = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/London",
  });
const duration = (milliseconds: number) =>
  `${Math.floor(milliseconds / 60_000)}:${String(Math.floor((milliseconds % 60_000) / 1000)).padStart(2, "0")}`;
const percent = (value: number | null) =>
  value === null ? "Not applicable" : `${Math.round(value * 100)}%`;
const attendanceLabel = (value: string) =>
  ({
    present: "Present",
    absent: "Absent",
    excused: "Excused absence",
    not_recorded: "Not recorded",
    not_selected: "Not selected",
  })[value] ?? value;

/** All named report rows come from audience-filtered selectors, including drill-downs. */
export function RecordsScreens({
  state,
  onChange,
  match,
  actor,
  playerId,
  busy = false,
  teamLabel = "Roma U10",
  synthetic = true,
  service = false,
  renderMatchCommunity,
  initialMatchId,
}: RecordsScreensProps) {
  const [tab, setTab] = useState<Tab>("results");
  const [selected, setSelected] = useState<string | null>(initialMatchId ?? null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const viewer = {
    actor,
    playerId,
    teamId: state.teamId,
    seasonId: state.seasonId,
  };
  const results = selectSeasonResults(state, viewer);
  const participation = selectParticipationReport(state, match, viewer);
  const editable = actor === "manager" && Boolean(onChange);
  const save = async (command: RecordsCommand) => {
    if (!onChange || saving || busy) return false;
    setSaving(true);
    setError(null);
    try {
      const saved = await onChange(command);
      if (!saved)
        setError(
          "This change has not been saved. Keep the review open and retry.",
        );
      return saved;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "This change has not been saved. Retry from the review.",
      );
      return false;
    } finally {
      setSaving(false);
    }
  };
  if (editor)
    return (
      <View style={s.stack} testID="records-editor">
        <Text style={s.title}>
          {editor.record ? "Correct past result" : "Add past result"}
        </Text>
        {error && <Notice tone="error">{error}</Notice>}
        <HistoricalEditor
          teamLabel={teamLabel}
          service={service}
          key={editor.record?.id ?? "new"}
          state={state}
          record={editor.record}
          disabled={busy || saving}
          onSave={async (command) => {
            if (await save(command)) {
              setEditor(null);
              setSelected(
                command.type === "historical.add" ||
                  command.type === "historical.correct"
                  ? command.recordId
                  : null,
              );
            }
          }}
          onCancel={() => {
            setError(null);
            setEditor(null);
          }}
        />
      </View>
    );
  if (selected)
    return (
      <View style={s.stack} testID="records-match-detail">
        <Button
          label="Back to records"
          variant="quiet"
          onPress={() => setSelected(null)}
        />
        {error && <Notice tone="error">{error}</Notice>}
        <MatchDetail
          teamLabel={teamLabel}
          state={state}
          matchId={selected}
          match={match}
          actor={actor}
          playerId={playerId}
          disabled={saving || busy}
          renderCommunity={renderMatchCommunity}
          onNote={
            editable &&
            state.results.some(
              (record) =>
                record.id === selected && record.recordMode === "detailed_live",
            )
              ? async (id, reason) => {
                  const record = state.results.find(
                    (item) => item.id === selected,
                  )!;
                  return save({
                    type: "participation.exception.noted",
                    commandId: randomUUID(),
                    actor: "manager",
                    at: new Date().toISOString(),
                    recordId: selected,
                    expectedRevision: record.revision,
                    playerId: id,
                    reason,
                  });
                }
              : undefined
          }
        />
        {editable &&
          state.results.find((record) => record.id === selected)?.recordMode ===
            "historical_summary" && (
            <Button
              label="Correct this result"
              variant="secondary"
              testID="records-correct"
              onPress={() =>
                setEditor({
                  record: state.results.find(
                    (record) => record.id === selected,
                  )!,
                })
              }
            />
          )}
      </View>
    );
  return (
    <View style={s.stack} testID="records-screen">
      <View style={s.row}>
        <View style={s.grow}>
          <Text style={s.title}>Team records</Text>
          <Text style={s.muted}>
            {teamLabel} · Season {state.seasonLabel}
          </Text>
        </View>
        {synthetic && <Pill tone="muted">Sample data</Pill>}
      </View>
      <View style={s.row} accessibilityRole="tablist">
        <TabButton
          label="Results"
          active={tab === "results"}
          onPress={() => setTab("results")}
          testID="records-tab-results"
        />
        {actor !== "spectator" && (
          <TabButton
            label={
              actor === "player" ? "My participation" : "Minutes & attendance"
            }
            active={tab === "participation"}
            onPress={() => setTab("participation")}
            testID="records-tab-participation"
          />
        )}
      </View>
      {error && <Notice tone="error">{error}</Notice>}
      {tab === "results" || actor === "spectator" ? (
        <>
          {results.suppressionReason ? (
            <Notice tone="warning">
              {results.suppressionReason} The club/league publication decision
              is still required.
            </Notice>
          ) : (
            results.totals && (
              <>
                <Card>
                  <Text style={s.section}>Season at a glance</Text>
                  <View style={s.stats} testID="records-season-totals">
                    <Stat
                      label="Played"
                      value={results.totals.played}
                      testID="records-total-played"
                    />
                    <Stat
                      label="App points"
                      value={results.totals.points}
                      testID="records-total-points"
                    />
                    <Stat label="Won" value={results.totals.wins} />
                    <Stat label="Drawn" value={results.totals.draws} />
                    <Stat label="Lost" value={results.totals.losses} />
                  </View>
                  <Text style={s.muted}>
                    Goals {results.totals.goalsFor} for ·{" "}
                    {results.totals.goalsAgainst} against · Difference{" "}
                    {results.totals.goalDifference > 0 ? "+" : ""}
                    {results.totals.goalDifference}
                  </Text>
                  <Text style={s.muted}>
                    App points: 3 for a win, 1 for a draw, 0 for a loss.
                    Ordinary completed games include friendlies. These are team
                    records, with no official league rank.
                  </Text>
                </Card>
                <Card>
                  <Text style={s.section}>Recent form</Text>
                  {results.form ? (
                    <View style={s.row} testID="records-form">
                      {results.form.length ? (
                        results.form.map((item, index) => (
                          <View
                            key={item.matchId}
                            style={[
                              s.form,
                              item.outcome === "W"
                                ? s.win
                                : item.outcome === "L"
                                  ? s.loss
                                  : s.draw,
                            ]}
                          >
                            <Text
                              testID={`records-form-${index}`}
                              style={s.formText}
                            >
                              {item.outcome}
                            </Text>
                          </View>
                        ))
                      ) : (
                        <Text style={s.muted}>
                          No known completed results yet.
                        </Text>
                      )}
                    </View>
                  ) : (
                    <Text style={s.muted}>
                      Same-day order is not recorded. Confirm the order to show
                      form.
                    </Text>
                  )}
                  <Text style={s.muted}>
                    Last five ordinary completed games · oldest left, newest
                    right
                  </Text>
                </Card>
              </>
            )
          )}
          {results.unknownScoreCount > 0 && (
            <Notice tone="warning">
              {results.unknownScoreCount} completed game(s) have no recorded
              score. They do not count as draws.
            </Notice>
          )}
          {results.excludedExceptionalMatches > 0 && (
            <Notice tone="warning">
              {results.excludedExceptionalMatches} exceptional or abandoned
              result(s) are excluded from app points while the outcome policy is
              unresolved.
            </Notice>
          )}
          {editable && (
            <Button
              label={
                service ? "Add historical result to service" : "Add past result"
              }
              testID="records-add-past"
              onPress={() => {
                setError(null);
                setEditor({ record: null });
              }}
            />
          )}
          <Text style={s.section}>Results</Text>
          {results.rows.map((record) => (
            <Pressable
              key={record.id}
              accessibilityRole="button"
              accessibilityLabel={`${record.opponent}, ${dateLabel(record.playedDate)}, ${scoreLabel(record.finalScore)}. Open match report.`}
              testID={`records-result-${record.id}`}
              onPress={() => setSelected(record.id)}
              style={({ pressed }) => [s.result, pressed && s.pressed]}
            >
              <View style={s.row}>
                <View style={s.grow}>
                  <Text style={s.muted}>
                    {dateLabel(record.playedDate)} ·{" "}
                    {record.homeAway === "home"
                      ? "Home"
                      : record.homeAway === "away"
                        ? "Away"
                        : "Neutral"}
                  </Text>
                  <Text style={s.section}>{record.opponent}</Text>
                </View>
                <Text style={s.score}>{scoreLabel(record.finalScore)}</Text>
              </View>
              <View style={s.wrap}>
                <Pill
                  tone={
                    record.recordMode === "historical_summary"
                      ? "warning"
                      : "brand"
                  }
                >
                  {record.recordMode === "historical_summary"
                    ? "Summary only"
                    : record.detailCompleteness === "review_required"
                      ? "Review required"
                      : "Detailed record"}
                </Pill>
                <Pill tone="muted">{record.fixtureClass}</Pill>
                {record.outcome && (
                  <Pill>
                    {record.outcome} · {record.points} pts
                  </Pill>
                )}
              </View>
              <Text style={s.muted}>
                {record.recordMode === "historical_summary"
                  ? "Minutes, attendance and unknown goal details stay not recorded."
                  : "Based on recorded match intervals."}
              </Text>
            </Pressable>
          ))}
          {results.rows.length === 0 && !results.suppressionReason && (
            <Card>
              <Text style={s.body}>
                No results recorded for this team season.
              </Text>
            </Card>
          )}
          {results.scorerTotals && results.scorerTotals.length > 0 && (
            <Card>
              <Text style={s.section}>Known goal credits</Text>
              <Text style={s.muted}>
                Recorded attribution only. Unassigned goals are not credited to
                a child.
              </Text>
              {results.scorerTotals.map((item) => (
                <View style={s.row} key={item.playerId}>
                  <Text style={[s.body, s.grow]}>{item.label}</Text>
                  <Text style={s.body}>{item.knownGoals}</Text>
                </View>
              ))}
            </Card>
          )}
          {editable && match?.status === "completed" && (
            <Button
              label="Save completed match to season"
              variant="secondary"
              disabled={
                saving ||
                busy ||
                match.recoveryRequired ||
                state.results.some(
                  (record) =>
                    record.id === match.config.matchId &&
                    record.sourceMatchRevision === match.revision,
                )
              }
              testID="records-archive-match"
              onPress={() => {
                void save({
                  type: "live.archive",
                  commandId: randomUUID(),
                  actor: "manager",
                  at: new Date().toISOString(),
                  match,
                });
              }}
            />
          )}
          <Text style={s.small}>
            {service ? "Service" : "Local"} records revision{" "}
            {results.projectionVersion} · Last recorded update{" "}
            {results.asOf
              ? new Date(results.asOf).toLocaleString("en-GB", {
                  timeZone: "Europe/London",
                })
              : "not recorded"}
            . Result sharing is manager-only until an applicable policy is
            explicitly confirmed.
          </Text>
        </>
      ) : (
        <>
          <Text style={s.section}>
            {actor === "player"
              ? "My known participation"
              : "Minutes & attendance"}
          </Text>
          <Notice tone="warning">
            Attendance denominator and excused-absence handling remain a
            proposed rule. Rates use present ÷ known records, including recorded
            excused absence. Completeness is shown separately.
          </Notice>
          {match && match.status !== "preparation" && (
            <Card>
              <Text style={s.body}>Current match checkpoint</Text>
              <Text style={s.muted}>
                Shows recorded active play through the last saved boundary.
                Clock uncertainty and ongoing play can leave these totals
                partial.
              </Text>
              <Button
                label="Open current match report"
                variant="secondary"
                onPress={() => setSelected(match.config.matchId)}
              />
            </Card>
          )}
          {participation.access === "denied" ? (
            <Notice>{participation.reason}</Notice>
          ) : (
            participation.rows.map((row) => (
              <ParticipationCard key={row.playerId} row={row} />
            ))
          )}
        </>
      )}
    </View>
  );
}

function TabButton({
  label,
  active,
  onPress,
  testID,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      testID={testID}
      style={[s.tab, active && s.activeTab]}
    >
      <Text style={[s.tabText, active && s.activeTabText]}>{label}</Text>
    </Pressable>
  );
}
function Stat({
  label,
  value,
  testID,
}: {
  label: string;
  value: number;
  testID?: string;
}) {
  return (
    <View style={s.stat}>
      <Text style={s.statValue} testID={testID}>
        {value}
      </Text>
      <Text style={s.muted}>{label}</Text>
    </View>
  );
}
function AttendanceBlock({
  title,
  summary,
}: {
  title: string;
  summary: AttendanceSummary;
}) {
  return (
    <View style={s.stackSmall}>
      <Text style={s.label}>{title}</Text>
      <Text style={s.body}>
        {summary.attendedCount} present · {summary.knownAbsentCount} known
        absent · {summary.unknownAttendanceCount} not recorded
      </Text>
      <Text style={s.muted}>
        Known-record rate {percent(summary.knownRecordAttendanceRate)} (
        {summary.attendedCount}/{summary.attendanceRecordedCount}). Completeness{" "}
        {percent(summary.completenessRatio)} ({summary.attendanceRecordedCount}/
        {summary.eligibleEventCount} eligible events). Excused:{" "}
        {summary.excusedCount}.
      </Text>
    </View>
  );
}
export function ParticipationCard({ row }: { row: ParticipationReportRow }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Card>
      <View style={s.row}>
        <Text style={[s.section, s.grow]}>{row.label}</Text>
        <Pill tone={row.evidenceState === "complete" ? "brand" : "warning"}>
          {row.evidenceState === "complete"
            ? "Known records"
            : row.evidenceState === "review_required"
              ? "Review required"
              : "Partial history"}
        </Pill>
      </View>
      <View style={s.stats} testID={`records-participation-${row.playerId}`}>
        <View style={s.stat}>
          <Text style={s.statValue}>
            {row.matchesWithParticipationRecorded
              ? duration(row.playingMs)
              : "Not recorded"}
          </Text>
          <Text style={s.muted}>Playing min:sec</Text>
        </View>
        <Stat label="Played" value={row.matchesPlayed} />
        <Stat label="Attended" value={row.matchesAttended} />
      </View>
      <Text style={s.muted}>{row.coverageLabel}</Text>
      <Text style={s.muted}>
        {row.matchesSelected} known selections ·{" "}
        {row.matchesWithAttendanceRecorded} recorded game attendances. A known
        zero-minute attendee counts as attended and does not count as a played
        appearance.
      </Text>
      <Text style={s.body}>
        Per played appearance:{" "}
        {row.minutesPerPlayedAppearance === null
          ? "Not applicable"
          : `${row.minutesPerPlayedAppearance.toFixed(1)} min`}{" "}
        · denominator {row.matchesPlayed} played
      </Text>
      {row.matchesWithParticipationRecorded > 0 && (
        <>
          <Text style={s.label}>Recorded positions</Text>
          <View style={s.wrap}>
            {Object.entries(row.positionMs).map(([position, ms]) => (
              <Pill key={position} tone="muted">
                {position} {duration(ms)} ·{" "}
                {percent(row.playingMs ? ms / row.playingMs : null)}
              </Pill>
            ))}
          </View>
          <Text style={s.muted}>
            Goalkeeper {duration(row.goalkeeperMs)} · Outfield{" "}
            {duration(row.outfieldMs)} · Non-primary keeper{" "}
            {duration(row.nonPrimaryGoalkeeperMs)} · Keeper with unknown primary
            preference {duration(row.goalkeeperMsWithUnknownPrimaryPreference)}.
          </Text>
          <Text style={s.muted}>
            Match-time preferences: first {duration(row.preferenceMs.first)},
            second {duration(row.preferenceMs.second)}, backup{" "}
            {duration(row.preferenceMs.backup)}, other{" "}
            {duration(row.preferenceMs.other)}, unknown{" "}
            {duration(row.preferenceMs.unknown)}.
          </Text>
        </>
      )}
      <AttendanceBlock
        title="Game attendance · held and known selected"
        summary={row.games}
      />
      <AttendanceBlock
        title="Training attendance · held and expected"
        summary={row.training}
      />
      <Button
        label={expanded ? "Hide attendance records" : "Show attendance records"}
        variant="quiet"
        onPress={() => setExpanded(!expanded)}
      />
      {expanded && (
        <View style={s.stackSmall}>
          {row.gameRecords.map((item) => (
            <Text style={s.muted} key={item.eventId}>
              {dateLabel(item.heldDate)} · Game ·{" "}
              {attendanceLabel(item.actualAttendance)} · selected · RSVP{" "}
              {item.availabilityResponse?.replaceAll("_", " ") ??
                "not recorded"}
            </Text>
          ))}
          {row.trainingRecords.map((item) => (
            <Text style={s.muted} key={item.eventId}>
              {dateLabel(item.heldDate)} · Training ·{" "}
              {attendanceLabel(item.actualAttendance)} · expected · RSVP{" "}
              {item.availabilityResponse?.replaceAll("_", " ") ??
                "not recorded"}
            </Text>
          ))}
          {row.gameRecords.length + row.trainingRecords.length === 0 && (
            <Text style={s.muted}>
              No eligible attendance evidence is recorded. Historical summaries
              do not establish selection or attendance.
            </Text>
          )}
        </View>
      )}
    </Card>
  );
}

function MatchDetail({
  teamLabel,
  state,
  matchId,
  match,
  actor,
  playerId,
  onNote,
  disabled,
  renderCommunity,
}: {
  teamLabel: string;
  state: RecordsState;
  matchId: string;
  match: MatchState | null;
  actor: RecordsActor;
  playerId?: string;
  onNote?: (playerId: string, reason: string) => Promise<boolean>;
  disabled: boolean;
  renderCommunity?: (matchId: string) => ReactNode;
}) {
  const report = selectMatchReport(state, matchId, { actor, playerId }, match);
  if (!report)
    return (
      <Notice>This record is unavailable in the selected team season.</Notice>
    );
  const named = "participation" in report ? report : null;
  const label = (id: string) =>
    state.players.find((player) => player.id === id)?.label ??
    "Recorded player";
  const audit =
    actor === "manager"
      ? state.audit.filter((entry) => entry.matchId === matchId)
      : [];
  return (
    <>
      <Text style={s.title}>
        {teamLabel} v {report.opponent}
      </Text>
      <Text style={s.muted}>
        {dateLabel(report.playedDate)} · {report.status.replaceAll("_", " ")}
      </Text>
      <Card>
        <Pill
          tone={
            report.recordMode === "historical_summary" ? "warning" : "brand"
          }
        >
          {report.recordMode === "historical_summary"
            ? "Historical summary · incomplete detail"
            : report.detailCompleteness.replaceAll("_", " ")}
        </Pill>
        {report.suppressionReason ? (
          <Notice tone="warning">{report.suppressionReason}</Notice>
        ) : (
          <>
            <Text style={s.score} testID="records-detail-score">
              {scoreLabel(report.score)}
            </Text>
            <Text style={s.body}>
              Half time: {scoreLabel(report.halfTimeScore)}
            </Text>
            <Text style={s.muted}>
              {report.recordMode === "historical_summary"
                ? "Final score is the manager’s recorded summary."
                : "Score derives from non-voided recorded goals."}
            </Text>
            <Text style={s.body}>
              Unassigned goals: {teamLabel}{" "}
              {report.unassignedGoalsFor ?? "not recorded"} · Opposition{" "}
              {report.unassignedGoalsAgainst ?? "not recorded"}
            </Text>
            {report.goals.map((goal) => (
              <Text style={s.body} key={goal.id}>
                {goal.beneficiary === "us" ? teamLabel : "Opposition"} ·{" "}
                {goal.isOwnGoal
                  ? "Own goal"
                  : goal.scorerPlayerId
                    ? label(goal.scorerPlayerId)
                    : "Scorer not recorded"}{" "}
                · {goal.goalType?.replaceAll("_", " ") ?? "Type not recorded"} ·{" "}
                {goal.half === null ? "Half not recorded" : `Half ${goal.half}`}{" "}
                ·{" "}
                {goal.halfElapsedMs === null
                  ? "Time not recorded"
                  : `${duration(goal.halfElapsedMs)} active`}
              </Text>
            ))}
          </>
        )}
        {!renderCommunity && <Text style={s.muted}>
          Award: Not recorded in this records store. Historical entry does not
          create an award or voting window.
        </Text>}
      </Card>
      {renderCommunity?.(matchId)}
      {named && (
        <Card>
          <Text style={s.section}>
            {actor === "player"
              ? "My recorded participation"
              : "Recorded participation"}
          </Text>
          <Text style={s.muted}>
            Actual active duration:{" "}
            {named.actualActiveDurationMs === null
              ? "Not recorded"
              : duration(named.actualActiveDurationMs)}{" "}
            min:sec
          </Text>
          {named.keeperPolicy && (
            <Notice tone="warning">
              Targets use the experimental availability-interval policy and an
              individual 90–110% band. Keeper policy:{" "}
              {named.keeperPolicy.replaceAll("_", " ")}. This planning default
              still needs acceptance.
            </Notice>
          )}
          {named.participation === null ? (
            <Text style={s.body}>
              Minutes, position intervals and targets were not recorded for this
              historical summary.
            </Text>
          ) : (
            named.participation.map((item) => (
              <View key={item.playerId} style={s.stackSmall}>
                <Text style={s.label}>
                  {label(item.playerId)} · {duration(item.playedMs)} played
                </Text>
                <Text style={s.muted}>
                  Available bench {duration(item.availableBenchMs)} ·
                  unavailable {duration(item.unavailableMs)}
                </Text>
                <Text style={s.muted}>
                  {Object.entries(item.positionMs)
                    .map(([position, ms]) => `${position} ${duration(ms)}`)
                    .join(" · ") || "Known zero playing time"}
                </Text>
                {item.target && (
                  <Text style={s.muted}>
                    Target {(item.target.targetMs / 60_000).toFixed(1)} min ·
                    band {(item.target.lowerMs / 60_000).toFixed(1)}–
                    {(item.target.upperMs / 60_000).toFixed(1)} min ·{" "}
                    {item.target.withinBand ? "within" : "outside"} band ·
                    deviation{" "}
                    {item.target.deviationRatio === null
                      ? "not applicable (zero target)"
                      : `${(item.target.deviationRatio * 100).toFixed(1)}%`}
                    {item.target.withinBand
                      ? ""
                      : ` · exception: ${item.target.exceptionReason ?? "reason not recorded"}`}
                  </Text>
                )}
                {item.target && !item.target.withinBand && onNote && (
                  <ExceptionNote
                    initial={item.target.exceptionReason ?? ""}
                    disabled={disabled}
                    onSave={(reason) => onNote(item.playerId, reason)}
                  />
                )}
                {item.intervals?.map((interval, index) => (
                  <Text style={s.small} key={index}>
                    Half {interval.half} · cumulative{" "}
                    {duration(interval.startMs)}–{duration(interval.endMs)} ·{" "}
                    {interval.state.replaceAll("_", " ")}
                    {interval.position ? ` · ${interval.position}` : ""}
                  </Text>
                ))}
              </View>
            ))
          )}
          <Text style={s.label}>Actual attendance</Text>
          {named.attendance === null ? (
            <Text style={s.muted}>
              Not recorded. Selection and RSVP are also unknown for this
              summary.
            </Text>
          ) : (
            Object.entries(named.attendance).map(([id, value]) => (
              <Text style={s.muted} key={id}>
                {label(id)} · {attendanceLabel(value)}
              </Text>
            ))
          )}
        </Card>
      )}
      {audit.length > 0 && (
        <Card>
          <Text style={s.section}>Correction history</Text>
          {audit.map((entry) => (
            <View style={s.stackSmall} key={entry.commandId}>
              <Text style={s.label}>
                {entry.action.replaceAll(".", " ")} ·{" "}
                {new Date(entry.at).toLocaleString("en-GB", {
                  timeZone: "Europe/London",
                })}
              </Text>
              <Text style={s.body}>{entry.reason}</Text>
              {entry.before && (
                <Text style={s.muted}>
                  Previous: {entry.before.playedDate} · {entry.before.opponent}{" "}
                  · {scoreLabel(entry.before.finalScore)} · revision{" "}
                  {entry.before.revision}
                </Text>
              )}
              {entry.after && (
                <Text style={s.muted}>
                  Recorded: {entry.after.playedDate} · {entry.after.opponent} ·{" "}
                  {scoreLabel(entry.after.finalScore)} · revision{" "}
                  {entry.after.revision}
                </Text>
              )}
            </View>
          ))}
        </Card>
      )}
      <Text style={s.small}>
        Projection {report.projectionVersion} · Record revision{" "}
        {report.revision}
        {report.sourceMatchRevision === null
          ? ""
          : ` · Source match revision ${report.sourceMatchRevision}`}{" "}
        · As of{" "}
        {report.asOf
          ? new Date(report.asOf).toLocaleString("en-GB", {
              timeZone: "Europe/London",
            })
          : "not recorded"}
        . {report.policyId} v{report.policyVersion}.
      </Text>
    </>
  );
}
function ExceptionNote({
  initial,
  disabled,
  onSave,
}: {
  initial: string;
  disabled: boolean;
  onSave: (reason: string) => Promise<boolean>;
}) {
  const [reason, setReason] = useState(initial);
  return (
    <View style={s.stackSmall}>
      <Field
        label="Manager’s recorded reason for target exception"
        value={reason}
        onChange={setReason}
      />
      <Button
        label="Save exception reason"
        variant="secondary"
        disabled={disabled || !reason.trim() || reason.trim() === initial}
        onPress={() => {
          void onSave(reason);
        }}
      />
    </View>
  );
}

function HistoricalEditor({
  teamLabel,
  service,
  state,
  record,
  disabled,
  onSave,
  onCancel,
}: {
  teamLabel: string;
  service: boolean;
  state: RecordsState;
  record: MatchRecord | null;
  disabled: boolean;
  onSave: (command: RecordsCommand) => Promise<void>;
  onCancel: () => void;
}) {
  const [date, setDate] = useState(record?.playedDate ?? "");
  const [opponent, setOpponent] = useState(record?.opponent ?? "");
  const [fixtureClass, setFixtureClass] = useState<FixtureClass>(
    record?.fixtureClass ?? "unclassified",
  );
  const [homeAway, setHomeAway] = useState<HistoricalResultInput["homeAway"]>(
    record?.homeAway ?? "home",
  );
  const [status, setStatus] = useState<HistoricalResultInput["status"]>(
    record?.status ?? "completed",
  );
  const [specialOutcome, setSpecialOutcome] = useState<
    HistoricalResultInput["specialOutcome"]
  >(record?.specialOutcome ?? "ordinary");
  const [scoreKnown, setScoreKnown] = useState(
    record ? record.finalScore !== null : true,
  );
  const [ourScore, setOurScore] = useState(
    record?.finalScore ? String(record.finalScore.for) : "",
  );
  const [theirScore, setTheirScore] = useState(
    record?.finalScore ? String(record.finalScore.against) : "",
  );
  const [halfKnown, setHalfKnown] = useState(
    record?.halfTimeScore !== null && record?.halfTimeScore !== undefined,
  );
  const [halfUs, setHalfUs] = useState(
    record?.halfTimeScore ? String(record.halfTimeScore.for) : "",
  );
  const [halfThem, setHalfThem] = useState(
    record?.halfTimeScore ? String(record.halfTimeScore.against) : "",
  );
  const [kickoff, setKickoff] = useState(record?.recordedKickoff ?? "");
  const [order, setOrder] = useState(
    record?.sameDayOrder === null || record?.sameDayOrder === undefined
      ? ""
      : String(record.sameDayOrder),
  );
  const [goals, setGoals] = useState<RecordedGoal[]>(
    record?.goals.map((goal) => ({ ...goal })) ?? [],
  );
  const [reason, setReason] = useState("");
  const [duplicate, setDuplicate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<{
    input: HistoricalResultInput;
    command: RecordsCommand;
  } | null>(null);
  const number = (text: string, label: string) => {
    if (!/^\d+$/.test(text))
      throw new Error(
        `${label} needs a whole number, or mark the score not recorded.`,
      );
    const value = Number(text);
    if (!Number.isSafeInteger(value)) throw new Error(`${label} is too large.`);
    return value;
  };
  const startReview = () => {
    try {
      const input: HistoricalResultInput = {
        playedDate: date.trim(),
        opponent: opponent.trim(),
        fixtureClass,
        homeAway,
        status,
        specialOutcome,
        recordedKickoff: kickoff.trim() || null,
        sameDayOrder: order.trim()
          ? number(order.trim(), "Same-day order")
          : null,
        finalScore: scoreKnown
          ? {
              for: number(ourScore, "Our score"),
              against: number(theirScore, "Opposition score"),
            }
          : null,
        halfTimeScore: halfKnown
          ? {
              for: number(halfUs, "Our half-time score"),
              against: number(halfThem, "Opposition half-time score"),
            }
          : null,
        goals,
      };
      const common = {
        actor: "manager" as const,
        commandId: randomUUID(),
        at: new Date().toISOString(),
      };
      const command: RecordsCommand = record
        ? {
            ...common,
            type: "historical.correct",
            recordId: record.id,
            expectedRevision: record.revision,
            input,
            reason,
          }
        : {
            ...common,
            type: "historical.add",
            recordId: randomUUID(),
            input,
            acknowledgePossibleDuplicate: duplicate,
          };
      reduceRecords(state, command); // Validate the complete review without changing persisted state.
      setError(null);
      setReview({ input, command });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Check the entered result.",
      );
    }
  };
  if (review)
    return (
      <View style={s.stack} testID="records-past-review">
        <Card>
          <Text style={s.section}>Review before saving</Text>
          <Text style={s.body}>
            {dateLabel(review.input.playedDate)} · {teamLabel} v{" "}
            {review.input.opponent}
          </Text>
          <Text style={s.score}>{scoreLabel(review.input.finalScore)}</Text>
          <Text style={s.body}>
            Half time: {scoreLabel(review.input.halfTimeScore)}
          </Text>
          <Text style={s.muted}>
            {review.input.fixtureClass} · {review.input.status} ·{" "}
            {review.input.specialOutcome}
          </Text>
          <Text style={s.body}>
            Known goal details: {review.input.goals.length}. Unassigned team
            goals:{" "}
            {review.input.finalScore
              ? review.input.finalScore.for -
                review.input.goals.filter((goal) => goal.beneficiary === "us")
                  .length
              : "not recorded"}
            .
          </Text>
        </Card>
        <Notice tone="warning">
          This saves a historical summary. Unknown detail stays not recorded. No
          minutes, attendance, clock, award window or historical notification is
          created. Publication remains subject to the competition policy.
        </Notice>
        <Button
          label={
            record
              ? "Save correction"
              : service
                ? "Save historical result to service"
                : "Save past result"
          }
          disabled={disabled}
          testID="records-past-save"
          onPress={() => {
            void onSave(review.command);
          }}
        />
        <Button
          label="Edit details"
          variant="secondary"
          disabled={disabled}
          onPress={() => setReview(null)}
        />
        <Button
          label="Cancel"
          variant="quiet"
          disabled={disabled}
          onPress={onCancel}
        />
      </View>
    );
  return (
    <View style={s.stack}>
      <Notice>
        Season {state.seasonLabel} · {state.startsOn} to {state.endsOn}. Record
        only what is known.
      </Notice>
      {error && <Notice tone="error">{error}</Notice>}
      <Field
        label="Played date · YYYY-MM-DD"
        value={date}
        onChange={setDate}
        testID="records-past-date"
      />
      <Field
        label="Opposition"
        value={opponent}
        onChange={setOpponent}
        testID="records-past-opponent"
      />
      <Choice
        label="Venue"
        values={["home", "away", "neutral"]}
        value={homeAway}
        onChange={setHomeAway}
      />
      <Choice
        label="Fixture class"
        values={["unclassified", "development", "friendly", "trophy"]}
        value={fixtureClass}
        onChange={setFixtureClass}
      />
      <Choice
        label="Match status"
        values={[
          "completed",
          "abandoned",
          "cancelled",
          "postponed",
          "incomplete",
        ]}
        value={status}
        onChange={setStatus}
      />
      <Choice
        label="Outcome type"
        values={["ordinary", "awarded", "forfeit", "shootout"]}
        value={specialOutcome}
        onChange={setSpecialOutcome}
      />
      {specialOutcome !== "ordinary" && (
        <Notice tone="warning">
          Outcome policy is unresolved. This exceptional result will not receive
          ordinary app points.
        </Notice>
      )}
      <Toggle
        label="Final score is known"
        value={scoreKnown}
        onChange={setScoreKnown}
      />
      {scoreKnown && (
        <View style={s.row}>
          <Field
            label="Our goals"
            value={ourScore}
            onChange={setOurScore}
            numeric
            testID="records-past-for"
          />
          <Field
            label="Opposition goals"
            value={theirScore}
            onChange={setTheirScore}
            numeric
            testID="records-past-against"
          />
        </View>
      )}
      <Toggle
        label="Half-time score is known"
        value={halfKnown}
        onChange={setHalfKnown}
      />
      {halfKnown && (
        <View style={s.row}>
          <Field
            label="Our half-time goals"
            value={halfUs}
            onChange={setHalfUs}
            numeric
          />
          <Field
            label="Opposition at half time"
            value={halfThem}
            onChange={setHalfThem}
            numeric
          />
        </View>
      )}
      <Field
        label="Known kick-off · ISO time with timezone, optional"
        value={kickoff}
        onChange={setKickoff}
        placeholder="2026-10-03T10:00:00+01:00"
      />
      <Field
        label="Same-day order · optional if time is unknown"
        value={order}
        onChange={setOrder}
        numeric
      />
      <Text style={s.section}>Known goal details</Text>
      <Text style={s.muted}>
        Optional. Adding attribution does not change the score. Leave unknown
        type, half or time unrecorded.
      </Text>
      {goals.map((goal, index) => (
        <GoalForm
          key={goal.id}
          goal={goal}
          state={state}
          onChange={(next) =>
            setGoals(goals.map((item) => (item.id === goal.id ? next : item)))
          }
          onRemove={() => setGoals(goals.filter((item) => item.id !== goal.id))}
          index={index}
        />
      ))}
      <Button
        label="Add known goal detail"
        variant="secondary"
        onPress={() =>
          setGoals([
            ...goals,
            {
              id: randomUUID(),
              beneficiary: "us",
              isOwnGoal: false,
              scorerPlayerId: null,
              goalType: null,
              half: null,
              halfElapsedMs: null,
            },
          ])
        }
      />
      {record ? (
        <Field
          label="Reason for correction"
          value={reason}
          onChange={setReason}
          testID="records-correction-reason"
        />
      ) : (
        <Toggle
          label="I checked for an existing result; any same-date opponent entry is a separate game"
          value={duplicate}
          onChange={setDuplicate}
        />
      )}
      <Button
        label="Review result"
        disabled={disabled}
        testID="records-past-review-button"
        onPress={startReview}
      />
      <Button
        label="Cancel"
        variant="quiet"
        disabled={disabled}
        onPress={onCancel}
      />
    </View>
  );
}
function GoalForm({
  goal,
  state,
  onChange,
  onRemove,
  index,
}: {
  goal: RecordedGoal;
  state: RecordsState;
  onChange: (value: RecordedGoal) => void;
  onRemove: () => void;
  index: number;
}) {
  const [timeText, setTimeText] = useState(
    goal.halfElapsedMs === null ? "" : String(goal.halfElapsedMs / 1000),
  );
  const [timeError, setTimeError] = useState<string | null>(null);
  const allowedScorer =
    (goal.beneficiary === "us" && !goal.isOwnGoal) ||
    (goal.beneficiary === "opposition" && goal.isOwnGoal);
  return (
    <Card>
      <Text style={s.label}>Known goal {index + 1}</Text>
      <Choice
        label="Scoring side"
        values={["us", "opposition"]}
        value={goal.beneficiary}
        onChange={(value) =>
          onChange({ ...goal, beneficiary: value, scorerPlayerId: null })
        }
      />
      <Toggle
        label="Own goal"
        value={goal.isOwnGoal}
        onChange={(value) =>
          onChange({ ...goal, isOwnGoal: value, scorerPlayerId: null })
        }
      />
      {allowedScorer && (
        <>
          <Text style={s.label}>
            {goal.isOwnGoal
              ? "Our player who scored the own goal"
              : "Known team scorer"}
          </Text>
          <View style={s.wrap}>
            <Selection
              label="Not recorded"
              selected={goal.scorerPlayerId === null}
              onPress={() => onChange({ ...goal, scorerPlayerId: null })}
            />
            {state.players.map((player) => (
              <Selection
                key={player.id}
                label={player.label}
                selected={goal.scorerPlayerId === player.id}
                onPress={() => onChange({ ...goal, scorerPlayerId: player.id })}
              />
            ))}
          </View>
        </>
      )}
      <Choice
        label="Goal type"
        values={["not_recorded", "open_play", "free_kick", "penalty"]}
        value={goal.goalType ?? "not_recorded"}
        onChange={(value) =>
          onChange({
            ...goal,
            goalType: value === "not_recorded" ? null : value,
          })
        }
      />
      <Choice
        label="Known half"
        values={["not_recorded", "1", "2"]}
        value={
          goal.half === null ? "not_recorded" : (String(goal.half) as "1" | "2")
        }
        onChange={(value) => {
          setTimeText("");
          setTimeError(null);
          onChange({
            ...goal,
            half: value === "not_recorded" ? null : value === "1" ? 1 : 2,
            halfElapsedMs: null,
          });
        }}
      />
      {goal.half !== null && (
        <>
          <Field
            label="Known active seconds in this half · optional"
            value={timeText}
            numeric
            onChange={(value) => {
              setTimeText(value);
              const valid =
                value.trim() === "" ||
                (/^\d+$/.test(value) &&
                  Number.isSafeInteger(Number(value) * 1000));
              setTimeError(
                valid
                  ? null
                  : "Use whole seconds, or leave the time not recorded.",
              );
              onChange({
                ...goal,
                halfElapsedMs: valid
                  ? value.trim()
                    ? Number(value) * 1000
                    : null
                  : -1,
              });
            }}
          />
          {timeError && (
            <Text accessibilityLiveRegion="polite" style={s.error}>
              {timeError}
            </Text>
          )}
        </>
      )}
      <Button
        label="Remove this goal detail"
        variant="quiet"
        onPress={onRemove}
      />
    </Card>
  );
}
function Field({
  label,
  value,
  onChange,
  numeric = false,
  testID,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  numeric?: boolean;
  testID?: string;
  placeholder?: string;
}) {
  return (
    <View style={[s.stackSmall, s.grow]}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        keyboardType={numeric ? "number-pad" : "default"}
        autoCapitalize="none"
        placeholder={placeholder}
        testID={testID}
        style={s.input}
      />
    </View>
  );
}
function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View style={s.row}>
      <Text style={[s.body, s.grow]}>{label}</Text>
      <Switch
        accessibilityLabel={label}
        value={value}
        onValueChange={onChange}
        trackColor={{ true: colors.brand }}
      />
    </View>
  );
}
function Choice<Value extends string>({
  label,
  values,
  value,
  onChange,
}: {
  label: string;
  values: Value[];
  value: Value;
  onChange: (value: Value) => void;
}) {
  return (
    <View style={s.stackSmall}>
      <Text style={s.label}>{label}</Text>
      <View style={s.wrap}>
        {values.map((option) => (
          <Selection
            key={option}
            label={option.replaceAll("_", " ")}
            selected={value === option}
            onPress={() => onChange(option)}
          />
        ))}
      </View>
    </View>
  );
}
function Selection({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={label}
      onPress={onPress}
      style={[s.choice, selected && s.selectedChoice]}
    >
      <Text style={[s.body, selected && s.selectedText]}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  stack: { gap: 16 },
  stackSmall: { gap: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  grow: { flex: 1, minWidth: 0 },
  title: { fontSize: 24, lineHeight: 30, color: colors.ink, fontWeight: "700" },
  section: {
    fontSize: 20,
    lineHeight: 26,
    color: colors.ink,
    fontWeight: "600",
  },
  body: { fontSize: 16, lineHeight: 24, color: colors.ink },
  label: { fontSize: 14, lineHeight: 20, fontWeight: "600", color: colors.ink },
  muted: { fontSize: 14, lineHeight: 20, color: colors.inkMuted },
  small: { fontSize: 12, lineHeight: 18, color: colors.inkMuted },
  error: { fontSize: 14, lineHeight: 20, color: colors.errorInk },
  score: {
    fontSize: 28,
    lineHeight: 36,
    fontWeight: "700",
    color: colors.ink,
    fontVariant: ["tabular-nums"],
    flexShrink: 1,
  },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: 20 },
  stat: { minWidth: 60, gap: 2 },
  statValue: {
    fontSize: 28,
    lineHeight: 36,
    fontWeight: "700",
    color: colors.brand,
    fontVariant: ["tabular-nums"],
  },
  result: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 16,
    gap: 12,
  },
  pressed: { backgroundColor: colors.bench },
  form: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  formText: {
    fontSize: 18,
    lineHeight: 24,
    fontWeight: "700",
    color: colors.ink,
  },
  win: { backgroundColor: "#CEE8D7" },
  draw: { backgroundColor: colors.bench },
  loss: { backgroundColor: "#F3D9D6" },
  tab: {
    flex: 1,
    minHeight: 52,
    borderBottomWidth: 3,
    borderBottomColor: colors.border,
    paddingVertical: 12,
    justifyContent: "center",
  },
  activeTab: { borderBottomColor: colors.brand },
  tabText: {
    color: colors.inkMuted,
    fontSize: 15,
    lineHeight: 22,
    fontWeight: "600",
    textAlign: "center",
  },
  activeTabText: { color: colors.brand },
  input: {
    borderWidth: 1,
    borderColor: colors.controlBorder,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    minHeight: 52,
    fontSize: 16,
    lineHeight: 24,
    color: colors.ink,
    backgroundColor: colors.surface,
  },
  choice: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.controlBorder,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  selectedChoice: { backgroundColor: colors.brand, borderColor: colors.brand },
  selectedText: { color: colors.surface },
});
