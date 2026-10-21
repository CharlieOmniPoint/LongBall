import { useRef, useState } from "react";
import { Text, View } from "react-native";
import type { MatchState } from "@longball/domain";
import type {
  FixtureClass,
  LiveMatchDetails,
  RecordsActor,
  RecordsCommand,
  RecordsState,
  selectMatchReport,
  selectParticipationReport,
  selectSeasonResults,
} from "@longball/application/records";
import { randomUUID } from "../platform/id";
import { Button, Card, Notice, Pill } from "../ui";
import { typography } from "../ui/tokens";
import { ParticipationCard, RecordsScreens } from "./RecordsScreens";
import type { ReportCommunityComposition } from "@longball/application/report-community";
import { ReportCommunityCard } from "./ReportCommunityCard";

export interface ConnectedReportContext extends LiveMatchDetails {
  status: MatchState["status"];
  sourceMatchRevision: number;
  archivedSourceMatchRevision: number | null;
}
type WithScorerLabels<T extends { goals: unknown[] }> = T extends unknown
  ? Omit<T, "goals"> & {
      goals: (T["goals"][number] & { scorerLabel?: string | null })[];
    }
  : never;
export interface ConnectedRecordsDto {
  revision: number;
  results: ReturnType<typeof selectSeasonResults>;
  participation: ReturnType<typeof selectParticipationReport>;
  matches: (WithScorerLabels<
    NonNullable<ReturnType<typeof selectMatchReport>>
  > & ReportCommunityComposition)[];
  editableState?: RecordsState;
  activeMatch?: MatchState | null;
  contexts?: ConnectedReportContext[];
  playerLabels?: { id: string; label: string }[];
}
export type ConnectedRecordsCommand =
  | Exclude<RecordsCommand, { type: "live.archive" }>
  | {
      type: "live.archive";
      commandId: string;
      actor: "manager";
      at: string;
      matchId: string;
      expectedSourceMatchRevision: number;
      reason?: string;
    };
export interface ConnectedExportRequest {
  kind: "season" | "match";
  format: "json" | "csv";
  matchId?: string;
  expectedProjectionVersion: number;
}
export function ConnectedRecordsScreens({
  value,
  audience,
  teamLabel,
  disabled,
  onChange,
  onExport,
  onOpenController,
  onOpenAlbum,
}: {
  value: ConnectedRecordsDto;
  audience: RecordsActor;
  teamLabel: string;
  disabled: boolean;
  onChange: (command: ConnectedRecordsCommand) => Promise<boolean>;
  onExport: (request: ConnectedExportRequest) => Promise<string>;
  onOpenController?: (matchId: string) => void;
  onOpenAlbum?: (matchId: string) => void;
}) {
  const [chosen, setChosen] = useState<ConnectedReportContext | null>(null);
  const [fixtureClass, setFixtureClass] =
    useState<FixtureClass>("unclassified");
  const manager = audience === "manager";
  const save = (command: RecordsCommand) =>
    onChange(
      command.type === "live.archive"
        ? {
            type: "live.archive",
            commandId: command.commandId,
            actor: "manager",
            at: command.at,
            matchId: command.match.config.matchId,
            expectedSourceMatchRevision: command.match.revision,
            ...(command.reason ? { reason: command.reason } : {}),
          }
        : command,
    );
  return (
    <View style={{ gap: 12 }} testID="workspace-reports">
      {manager && value.editableState && (
        <Card>
          <Text style={typography.section}>Accepted match used by reports</Text>
          <Text style={typography.body}>
            {value.editableState.liveMatch.opponent} ·{" "}
            {value.editableState.liveMatch.playedDate}
          </Text>
          <Text style={typography.muted}>
            Choose explicitly. Preparation does not silently switch report
            context, and archive always uses the service’s accepted match
            revision.
          </Text>
          {(value.contexts ?? []).map((context) => (
            <Button
              key={context.matchId}
              label={`${context.opponent} · ${context.playedDate} · ${context.status.replaceAll("_", " ")}`}
              variant={
                chosen?.matchId === context.matchId ? "primary" : "secondary"
              }
              disabled={disabled}
              onPress={() => {
                setChosen(context);
                setFixtureClass(context.fixtureClass);
              }}
            />
          ))}
          {chosen && (
            <>
              <Text style={typography.label}>
                Competition classification for this report
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {(
                  ["unclassified", "development", "friendly", "trophy"] as const
                ).map((option) => (
                  <Button
                    key={option}
                    label={option}
                    variant={fixtureClass === option ? "primary" : "secondary"}
                    disabled={disabled}
                    onPress={() => setFixtureClass(option)}
                  />
                ))}
              </View>
              <Notice>
                Classification does not approve score sharing. The applicable
                club sharing policy still controls scores, derived totals,
                awards and exports.
              </Notice>
              <Button
                label="Use this accepted match for reports"
                disabled={disabled}
                onPress={() => {
                  void onChange({
                    type: "live.context.set",
                    commandId: randomUUID(),
                    actor: "manager",
                    at: new Date().toISOString(),
                    details: {
                      matchId: chosen.matchId,
                      playedDate: chosen.playedDate,
                      opponent: chosen.opponent,
                      homeAway: chosen.homeAway,
                      fixtureClass,
                    },
                  });
                }}
              />
              {onOpenController && (
                <Button
                  label="Open this match controller"
                  variant="secondary"
                  disabled={disabled}
                  onPress={() => onOpenController(chosen.matchId)}
                />
              )}
            </>
          )}
        </Card>
      )}
      {manager && value.editableState ? (
        <RecordsScreens
          state={value.editableState}
          match={value.activeMatch ?? null}
          actor="manager"
          teamLabel={teamLabel}
          synthetic={false}
          service
          onChange={save}
          busy={disabled}
          renderMatchCommunity={matchId => <ReportCommunityCard matchId={matchId} value={value.matches.find(report => report.matchId === matchId)} onOpenAlbum={onOpenAlbum} disabled={disabled} />}
        />
      ) : (
        <ReadOnlyRecords
          value={value}
          teamLabel={teamLabel}
          audience={audience}
          onOpenAlbum={onOpenAlbum}
          disabled={disabled}
        />
      )}
      <ReportExport value={value} disabled={disabled} onExport={onExport} />
    </View>
  );
}
function ReportExport({
  value,
  disabled,
  onExport,
}: {
  value: ConnectedRecordsDto;
  disabled: boolean;
  onExport: (request: ConnectedExportRequest) => Promise<string>;
}) {
  const [kind, setKind] = useState<"season" | "match">("season");
  const [matchId, setMatchId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const lock = useRef(false);
  const run = async (format: "json" | "csv") => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setResult(null);
    try {
      setResult(
        await onExport({
          kind,
          format,
          ...(kind === "match" && matchId ? { matchId } : {}),
          expectedProjectionVersion: value.revision,
        }),
      );
    } catch (cause) {
      setResult(
        cause instanceof Error
          ? cause.message
          : "The permitted report could not be exported.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <Card>
      <Text style={typography.section}>Export a permitted report</Text>
      <Text style={typography.body}>
        The service checks current access and sharing policy again. The file
        records its audience, filters, policy and projection version. Saving it
        outside LongBall creates a separate copy.
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button
          label="Season report"
          variant={kind === "season" ? "primary" : "secondary"}
          disabled={disabled || busy}
          onPress={() => setKind("season")}
        />
        <Button
          label="Match report"
          variant={kind === "match" ? "primary" : "secondary"}
          disabled={disabled || busy}
          onPress={() => setKind("match")}
        />
      </View>
      {kind === "match" &&
        value.matches
          .filter((report) => report !== null)
          .map((report) => (
            <Button
              key={report.matchId}
              label={`${report.opponent} · ${report.playedDate}`}
              variant={matchId === report.matchId ? "primary" : "secondary"}
              disabled={disabled || busy}
              onPress={() => setMatchId(report.matchId)}
            />
          ))}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button
          label="Export permitted JSON"
          testID="records-export-json"
          disabled={disabled || busy || (kind === "match" && !matchId)}
          onPress={() => {
            void run("json");
          }}
        />
        <Button
          label="Export permitted CSV"
          testID="records-export-csv"
          variant="secondary"
          disabled={disabled || busy || (kind === "match" && !matchId)}
          onPress={() => {
            void run("csv");
          }}
        />
      </View>
      {result && <Notice>{result}</Notice>}
    </Card>
  );
}
function ReadOnlyRecords({
  value,
  teamLabel,
  audience,
  onOpenAlbum,
  disabled,
}: {
  value: ConnectedRecordsDto;
  teamLabel: string;
  audience: RecordsActor;
  onOpenAlbum?: (matchId: string) => void;
  disabled: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const report = value.matches.find((item) => item?.matchId === selected);
  const results = value.results;
  const duration = (ms: number) =>
    `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;
  const score = (item: { for: number; against: number } | null) =>
    item ? `${item.for} – ${item.against}` : "Not recorded";
  const label = (id: string) =>
    value.playerLabels?.find((person) => person.id === id)?.label ??
    value.participation.rows.find((person) => person.playerId === id)?.label ??
    "Recorded team player";
  return (
    <View style={{ gap: 12 }}>
      <Card>
        <Text style={typography.section}>{teamLabel} records</Text>
        <Text style={typography.muted}>
          {results.visibilityScope} · revision {results.projectionVersion} ·
          last recorded {results.asOf ?? "not recorded"}
        </Text>
        {results.suppressionReason ? (
          <Notice tone="warning">{results.suppressionReason}</Notice>
        ) : (
          results.totals && (
            <>
              <Text style={typography.body}>
                P{results.totals.played} · W{results.totals.wins} · D
                {results.totals.draws} · L{results.totals.losses} · GF
                {results.totals.goalsFor} · GA{results.totals.goalsAgainst} · GD
                {results.totals.goalDifference} · Pts{results.totals.points}
              </Text>
              <Text style={typography.muted}>
                App points use 3/1/0 for ordinary completed games, including
                friendlies. This is not an official league rank.
              </Text>
              <Text style={typography.body}>
                Recent form:{" "}
                {results.form
                  ? results.form.map((item) => item.outcome).join(" · ") ||
                    "No known completed results"
                  : "Same-day order not recorded"}
              </Text>
            </>
          )
        )}
        {results.unknownScoreCount > 0 && (
          <Notice tone="warning">
            {results.unknownScoreCount} completed games have no recorded score;
            they do not count as draws.
          </Notice>
        )}
        {results.excludedExceptionalMatches > 0 && (
          <Notice tone="warning">
            {results.excludedExceptionalMatches} exceptional or abandoned
            results are excluded from ordinary app points pending their outcome
            rule.
          </Notice>
        )}
        {results.rows.map((row) => (
          <View key={row.id} style={{ gap: 8 }}>
            <Text style={typography.label}>
              {row.playedDate} · {row.opponent}
            </Text>
            <Text style={typography.body}>
              {score(row.finalScore)} · {row.outcome ?? row.status} ·{" "}
              {row.detailCompleteness.replaceAll("_", " ")}
            </Text>
            <Button
              label={`Read service report for ${row.opponent}`}
              variant="secondary"
              onPress={() => setSelected(row.id)}
            />
          </View>
        ))}
        {results.scorerTotals?.map((row) => (
          <Text key={row.playerId} style={typography.body}>
            {row.label} · {row.knownGoals} known goal credits
          </Text>
        ))}
      </Card>
      {report && (
        <Card>
          <Text style={typography.section}>
            {report.opponent} · {report.playedDate}
          </Text>
          <Pill
            tone={
              report.detailCompleteness === "complete" ? "brand" : "warning"
            }
          >
            {report.detailCompleteness.replaceAll("_", " ")}
          </Pill>
          {report.suppressionReason ? (
            <Notice tone="warning">{report.suppressionReason}</Notice>
          ) : (
            <>
              <Text style={typography.section}>{score(report.score)}</Text>
              <Text style={typography.body}>
                Half time: {score(report.halfTimeScore)}
              </Text>
              <Text style={typography.muted}>
                Unassigned goals: team{" "}
                {report.unassignedGoalsFor ?? "not recorded"} · opposition{" "}
                {report.unassignedGoalsAgainst ?? "not recorded"}
              </Text>
              {report.goals.map((goal) => (
                <Text key={goal.id} style={typography.body}>
                  {goal.beneficiary === "us" ? "Team" : "Opposition"} ·{" "}
                  {goal.isOwnGoal
                    ? "Own goal"
                    : goal.scorerPlayerId
                      ? (goal.scorerLabel ?? label(goal.scorerPlayerId))
                      : "Scorer not recorded"}{" "}
                  · {goal.goalType?.replaceAll("_", " ") ?? "Type not recorded"}{" "}
                  · {goal.half ? `Half ${goal.half}` : "Half not recorded"} ·{" "}
                  {goal.halfElapsedMs === null
                    ? "Time not recorded"
                    : `${duration(goal.halfElapsedMs)} active`}
                </Text>
              ))}
            </>
          )}
          {"participation" in report && (
            <>
              <Text style={typography.label}>My recorded participation</Text>
              {report.participation === null ? (
                <Text style={typography.body}>
                  Minutes, intervals, selection and actual attendance are not
                  established by this historical summary.
                </Text>
              ) : (
                report.participation.map((row) => (
                  <View key={row.playerId} style={{ gap: 8 }}>
                    <Text style={typography.body}>
                      {label(row.playerId)} · {duration(row.playedMs)} played ·
                      available bench {duration(row.availableBenchMs)} ·
                      unavailable {duration(row.unavailableMs)}
                    </Text>
                    <Text style={typography.muted}>
                      {Object.entries(row.positionMs)
                        .map(([position, ms]) => `${position} ${duration(ms)}`)
                        .join(" · ") || "Known zero-minute appearance"}
                    </Text>
                    {row.intervals?.map((interval, index) => (
                      <Text key={index} style={typography.muted}>
                        Half {interval.half} · {duration(interval.startMs)}–
                        {duration(interval.endMs)} ·{" "}
                        {interval.state.replaceAll("_", " ")}
                        {interval.position ? ` · ${interval.position}` : ""}
                      </Text>
                    ))}
                  </View>
                ))
              )}
            </>
          )}
          <ReportCommunityCard matchId={report.matchId} value={report} onOpenAlbum={onOpenAlbum} disabled={disabled} />
          <Text style={typography.muted}>
            Projection {report.projectionVersion} · record revision{" "}
            {report.revision} · {report.policyId} v{report.policyVersion}
          </Text>
          <Button
            label="Close service report"
            variant="quiet"
            onPress={() => setSelected(null)}
          />
        </Card>
      )}
      {audience !== "spectator" && (
        <>
          <Text style={typography.section}>My known participation</Text>
          {value.participation.reason ? (
            <Notice>{value.participation.reason}</Notice>
          ) : (
            value.participation.rows.map((row) => (
              <ParticipationCard key={row.playerId} row={row} />
            ))
          )}
        </>
      )}
    </View>
  );
}
