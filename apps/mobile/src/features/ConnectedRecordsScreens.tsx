import { useState } from "react";
import { ReportExportPanel } from "./ReportExportPanel";
import type { ReportExportJobPort } from "../platform/report-export-jobs";
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
  > &
    ReportCommunityComposition)[];
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
  openExportJobs,
  active = true,
  onOpenController,
  onOpenAlbum,
  initialMatchId,
}: {
  value: ConnectedRecordsDto;
  audience: RecordsActor;
  teamLabel: string;
  disabled: boolean;
  onChange: (command: ConnectedRecordsCommand) => Promise<boolean>;
  onExport: (request: ConnectedExportRequest, signal?: AbortSignal) => Promise<string>;
  openExportJobs: () => ReportExportJobPort;
  active?: boolean;
  onOpenController?: (matchId: string) => void;
  onOpenAlbum?: (matchId: string) => void;
  initialMatchId?: string;
}) {
  const [requestedMatchId, setRequestedMatchId] = useState<string | null>(
    initialMatchId ?? null,
  );
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
  if (requestedMatchId)
    return (
      <View style={{ gap: 12 }} testID="workspace-reports">
        <Button
          label="Back to all records"
          variant="quiet"
          onPress={() => setRequestedMatchId(null)}
        />
        <ReadOnlyRecords
          value={value}
          teamLabel={teamLabel}
          audience={audience}
          onOpenAlbum={onOpenAlbum}
          disabled={disabled}
          initialMatchId={requestedMatchId}
          matchOnly
          onCloseMatch={() => setRequestedMatchId(null)}
        />
      </View>
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
          renderMatchCommunity={(matchId) => (
            <ReportCommunityCard
              matchId={matchId}
              value={value.matches.find((report) => report.matchId === matchId)}
              onOpenAlbum={onOpenAlbum}
              disabled={disabled}
            />
          )}
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
      <ReportExportPanel
        teamId={value.results.teamId}
        seasonId={value.results.seasonId}
        audience={audience}
        projectionVersion={value.revision}
        matches={value.matches}
        disabled={disabled}
        active={active}
        openJobs={openExportJobs}
        onLegacyJson={onExport}
      />
    </View>
  );
}
function ReadOnlyRecords({
  value,
  teamLabel,
  audience,
  onOpenAlbum,
  disabled,
  initialMatchId,
  matchOnly = false,
  onCloseMatch,
}: {
  value: ConnectedRecordsDto;
  teamLabel: string;
  audience: RecordsActor;
  onOpenAlbum?: (matchId: string) => void;
  disabled: boolean;
  initialMatchId?: string;
  matchOnly?: boolean;
  onCloseMatch?: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(
    initialMatchId ?? null,
  );
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
      {!matchOnly && (
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
                  {results.totals.goalsFor} · GA{results.totals.goalsAgainst} ·
                  GD
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
              {results.unknownScoreCount} completed games have no recorded
              score; they do not count as draws.
            </Notice>
          )}
          {results.excludedExceptionalMatches > 0 && (
            <Notice tone="warning">
              {results.excludedExceptionalMatches} exceptional or abandoned
              results are excluded from ordinary app points pending their
              outcome rule.
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
      )}
      {matchOnly && !report && (
        <Notice>
          This match report is unavailable in the current authorised team and
          season. Refresh the service views or choose another permitted record.
        </Notice>
      )}
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
              <Text style={typography.label}>
                {audience === "manager"
                  ? "Recorded participation"
                  : "My recorded participation"}
              </Text>
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
          <ReportCommunityCard
            matchId={report.matchId}
            value={report}
            onOpenAlbum={onOpenAlbum}
            disabled={disabled}
          />
          <Text style={typography.muted}>
            Projection {report.projectionVersion} · record revision{" "}
            {report.revision} · {report.policyId} v{report.policyVersion}
          </Text>
          <Button
            label="Close service report"
            variant="quiet"
            onPress={() => {
              setSelected(null);
              onCloseMatch?.();
            }}
          />
        </Card>
      )}
      {!matchOnly && audience !== "spectator" && (
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
