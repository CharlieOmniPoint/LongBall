import { StyleSheet, Text, View } from "react-native";
import type {
  OwnPlayerStatsDto,
  PlayerStatsRow,
  PositionStatsTotals,
  StatsScope,
} from "@longball/application/player-stats";
import { formatUkSeasonLabel } from "@longball/application/uk-display";
import { Card, Notice, Pill } from "../ui";
import { colors, typography } from "../ui/tokens";
import { formatStatsPositionPercentage } from "../platform/player-stats-presentation";

export interface PlayerStatsProps {
  value: OwnPlayerStatsDto;
  teamLabel?: string;
}
export const statsTime = (ms: number) =>
  `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
const percent = (value: number | null) =>
  formatStatsPositionPercentage(value, "Not recorded");

/** Accepts the own-only service DTO; no raw records/profile/attendance document. */
export function PlayerStats({ value, teamLabel }: PlayerStatsProps) {
  return (
    <View style={s.section} testID="player-my-stats">
      <Text style={typography.title}>My Stats</Text>
      <Text style={typography.muted}>
        {teamLabel ? `${teamLabel} · ` : ""}
        {formatUkSeasonLabel(value.scope.seasonLabel)}
      </Text>
      <PlayerStatsDetails row={value.player} scope={value.scope} own />
    </View>
  );
}

export function PlayerStatsDetails({
  row,
  scope,
  own = false,
}: {
  row: PlayerStatsRow;
  scope: StatsScope;
  own?: boolean;
}) {
  return (
    <View style={s.section} testID={`stats-player-detail-${row.playerId}`}>
      <Card>
        <Text style={typography.section}>
          {own ? "Your recorded season" : row.label}
        </Text>
        <View style={s.totals}>
          <Total
            label="Known playing time"
            value={statsTime(row.knownPlayingMs)}
          />
          <Total
            label="Known appearances"
            value={String(row.knownAppearances)}
          />
          <Total label="Known goals" value={String(row.knownGoals)} />
          <Total label="Recorded own goals" value={String(row.knownOwnGoals)} />
          <Total
            label="Clean sheets in goal"
            value={String(row.knownCleanSheets)}
          />
        </View>
        <Text style={typography.muted}>
          Appearances count only matches with recorded playing time above zero.
          Known goals count explicit scorer attribution; gaps are not treated as
          zero. Clean sheets count completed games with no opposition goal
          during the recorded goalkeeper stints, including opposition goals from
          own goals.
        </Text>
        <Text style={typography.muted}>
          Goalkeeping reviewed: {row.goalkeepingReviewedMatches} games.
          {row.goalkeepingUnknownMatches > 0
            ? ` ${row.goalkeepingUnknownMatches} games lack complete goalkeeper or goal-timing evidence.`
            : ""}
        </Text>
      </Card>
      <Card>
        <Text style={typography.section}>
          Where {own ? "you played" : "they played"}
        </Text>
        <PositionBreakdown value={row} />
      </Card>
      <Card>
        <Text style={typography.section}>What is recorded</Text>
        {row.coverage.recordedMatches === 0 ? (
          <Notice>No played matches are recorded in this season yet.</Notice>
        ) : (
          <>
            <Text style={typography.body}>
              Playing-time entries: {row.coverage.playingTimeKnownMatches} of{" "}
              {row.coverage.recordedMatches} recorded matches.
            </Text>
            {row.coverage.playingTimeUnknownMatches > 0 && (
              <Text style={typography.muted}>
                {row.coverage.playingTimeUnknownMatches} matches have no usable
                playing-time entry for this player. This does not infer
                selection, attendance or minutes.
              </Text>
            )}
            {row.coverage.reviewRequiredMatches > 0 && (
              <Notice tone="warning">
                {row.coverage.reviewRequiredMatches} matches need review and
                contribute no uncertain time or goals to these totals.
              </Notice>
            )}
            <View style={s.pills}>
              <Pill>
                Scoring complete: {row.coverage.scoringCompleteMatches}
              </Pill>
              <Pill tone="muted">
                Partial: {row.coverage.scoringPartialMatches}
              </Pill>
              <Pill tone="muted">
                Unknown: {row.coverage.scoringUnknownMatches}
              </Pill>
            </View>
          </>
        )}
        <Text style={typography.muted}>
          {scope.asOf
            ? "Through the latest accepted match checkpoint. Running clocks do not add unaccepted time here."
            : "A latest recording time is not available."}
        </Text>
      </Card>
    </View>
  );
}

export function PositionBreakdown({ value }: { value: PositionStatsTotals }) {
  const recorded = value.positions.filter((position) => position.playingMs > 0);
  return (
    <View style={s.section}>
      {recorded.length === 0 && (
        <Text style={typography.muted}>
          No named position time is recorded yet.
        </Text>
      )}
      {recorded.map((position) => (
        <View
          key={position.code}
          style={s.barRow}
          accessibilityLabel={`${position.label}, ${statsTime(position.playingMs)}, ${percent(position.percentage)} of known playing time`}
        >
          <View style={s.barLabel}>
            <Text style={typography.label}>
              {position.code} · {position.label}
            </Text>
            <Text style={typography.body}>
              {statsTime(position.playingMs)} · {percent(position.percentage)}
            </Text>
          </View>
          <View style={s.track}>
            <View
              style={[
                s.fill,
                {
                  width: `${Math.min(100, Math.max(0, position.percentage ?? 0))}%`,
                },
              ]}
            />
          </View>
        </View>
      ))}
      {value.unknownPositionMs > 0 && (
        <View style={s.barRow}>
          <Text style={typography.label}>
            Position not recorded · {statsTime(value.unknownPositionMs)}
          </Text>
          <View style={s.track}>
            <View
              style={[
                s.fill,
                s.unknownFill,
                {
                  width: `${value.knownPlayingMs ? (value.unknownPositionMs / value.knownPlayingMs) * 100 : 0}%`,
                },
              ]}
            />
          </View>
        </View>
      )}
      <Text style={typography.muted}>
        Percentages use known playing time. Time without a position stays in the
        denominator; historical gaps are not filled in.
      </Text>
    </View>
  );
}
function Total({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.total}>
      <Text style={typography.label}>{label}</Text>
      <Text style={s.totalValue}>{value}</Text>
    </View>
  );
}
const s = StyleSheet.create({
  section: { gap: 12 },
  totals: { flexDirection: "row", flexWrap: "wrap", gap: 16 },
  total: { minWidth: 110, flexGrow: 1, flexBasis: "42%", gap: 4 },
  totalValue: { ...typography.section, color: colors.brand },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  barRow: { gap: 6 },
  barLabel: { gap: 2 },
  track: {
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.bench,
    overflow: "hidden",
  },
  fill: { height: 12, backgroundColor: colors.brand, borderRadius: 6 },
  unknownFill: { backgroundColor: colors.inkMuted },
});
