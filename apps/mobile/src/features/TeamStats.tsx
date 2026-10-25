import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type {
  PositionStatsTotals,
  StatsFormation,
  TeamPlayerStatsDto,
} from "@longball/application/player-stats";
import { formatUkSeasonLabel } from "@longball/application/uk-display";
import { Button, Card, Notice } from "../ui";
import { colors, typography } from "../ui/tokens";
import { useWorkspaceLayout } from "../ui/WorkspaceLayout";
import {
  formatStatsPositionPercentage,
  isRecordedZeroPosition,
  statsCorePositionsOutsideLayout,
  statsPositionPreference,
  type PlayerStatsCorePositions,
} from "../platform/player-stats-presentation";
import {
  PlayerStatsDetails,
  PositionBreakdown,
  statsTime,
} from "./PlayerStats";

export interface TeamStatsProps {
  value: TeamPlayerStatsDto;
  teamLabel?: string;
  selectedPlayerId?: string;
  onSelectPlayer?: (playerId: string) => void;
  /** Already-authorised current-season preferences; never inferred from stats. */
  corePositions?: readonly PlayerStatsCorePositions[];
}
/** Both manager and administrator receive this same aggregate-only DTO. */
export function TeamStats({
  value,
  teamLabel,
  selectedPlayerId,
  onSelectPlayer,
  corePositions,
}: TeamStatsProps) {
  const { wide } = useWorkspaceLayout();
  const [panelWidth, setPanelWidth] = useState(0);
  const splitDetails = wide && panelWidth >= 800;
  const [localPlayer, setLocalPlayer] = useState<string | null>(null);
  const player =
    value.players.find(
      (row) => row.playerId === (selectedPlayerId ?? localPlayer),
    ) ?? value.players[0];
  const selectionKey = JSON.stringify([
    value.scope.clubId,
    value.scope.teamId,
    value.scope.seasonId,
    player?.playerId ?? null,
  ]);
  const [mapView, setMapView] = useState<{
    selectionKey: string;
    scope: "team" | "player";
  }>(() => ({ selectionKey, scope: player ? "player" : "team" }));
  const mapScope =
    mapView.selectionKey === selectionKey
      ? mapView.scope
      : player
        ? "player"
        : "team";
  const setMapScope = (scope: "team" | "player") =>
    setMapView({ selectionKey, scope });
  const select = (id: string) => {
    setLocalPlayer(id);
    setMapView({
      selectionKey: JSON.stringify([
        value.scope.clubId,
        value.scope.teamId,
        value.scope.seasonId,
        id,
      ]),
      scope: "player",
    });
    onSelectPlayer?.(id);
  };
  return (
    <View style={s.section} testID="team-player-stats">
      <Text style={typography.title}>Player Stats</Text>
      <Text style={typography.muted}>
        {teamLabel ? `${teamLabel} · ` : ""}
        {formatUkSeasonLabel(value.scope.seasonLabel)}
      </Text>
      <View
        style={[s.workspace, wide && s.workspaceWide]}
        testID="stats-workspace-layout"
      >
        <View
          style={[s.picker, wide && s.pickerWide]}
          testID="stats-player-picker"
        >
          <Card>
            <Text style={typography.section}>Choose a player</Text>
            <ScrollView
              horizontal={!wide}
              nestedScrollEnabled
              style={wide ? s.playerScrollWide : undefined}
              accessibilityLabel="Choose a player for recorded stats"
              contentContainerStyle={[s.players, wide && s.playersWide]}
            >
              {value.players.map((row) => (
                <Pressable
                  key={row.playerId}
                  accessibilityRole="button"
                  accessibilityState={{
                    selected: player?.playerId === row.playerId,
                  }}
                  aria-pressed={player?.playerId === row.playerId}
                  testID={`stats-choose-${row.playerId}`}
                  onPress={() => select(row.playerId)}
                  style={[
                    s.player,
                    player?.playerId === row.playerId && s.selected,
                  ]}
                >
                  <Text
                    style={[
                      typography.label,
                      player?.playerId === row.playerId && s.selectedText,
                    ]}
                  >
                    {row.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            {!player && (
              <Notice>No players are recorded in this team and season.</Notice>
            )}
          </Card>
        </View>
        <View
          style={[
            s.panels,
            wide && s.panelsFlexible,
            splitDetails && s.panelsWide,
          ]}
          testID="stats-season-panels"
          onLayout={(event) => {
            const width = event.nativeEvent.layout.width;
            if (width > 0)
              setPanelWidth((previous) =>
                Math.abs(previous - width) > 1 ? width : previous,
              );
          }}
        >
          <View style={[s.mapPanel, splitDetails && s.splitPanel]}>
            <Card>
              <Text style={typography.section}>Season position map</Text>
              <View style={s.actions}>
                <Button
                  label="Whole team"
                  variant={mapScope === "team" ? "primary" : "secondary"}
                  accessibilityState={{ selected: mapScope === "team" }}
                  onPress={() => setMapScope("team")}
                  testID="stats-map-team"
                />
                <Button
                  label="Selected player"
                  variant={mapScope === "player" ? "primary" : "secondary"}
                  accessibilityState={{ selected: mapScope === "player" }}
                  disabled={!player}
                  onPress={() => setMapScope("player")}
                  testID="stats-map-player"
                />
              </View>
              <Text style={typography.label} testID="stats-map-scope">
                {mapScope === "player" && player
                  ? player.label
                  : "All player playing time"}
              </Text>
              <FormationStats
                formation={value.formation}
                value={mapScope === "player" && player ? player : value.team}
                playerView={mapScope === "player" && Boolean(player)}
                core={
                  mapScope === "player" && player
                    ? corePositions?.find(
                        (row) => row.playerId === player.playerId,
                      )
                    : undefined
                }
              />
            </Card>
          </View>
          <View style={[s.detailsPanel, splitDetails && s.splitPanel]}>
            {player && <PlayerStatsDetails row={player} scope={value.scope} />}
          </View>
        </View>
      </View>
    </View>
  );
}
function FormationStats({
  formation,
  value,
  playerView,
  core,
}: {
  formation: StatsFormation | null;
  value: PositionStatsTotals;
  playerView: boolean;
  core: PlayerStatsCorePositions | undefined;
}) {
  const [pitchWidth, setPitchWidth] = useState(240);
  const groups = new Map<string, { x: number; y: number; count: number }>();
  for (const slot of formation?.slots ?? []) {
    const prior = groups.get(slot.positionCode) ?? { x: 0, y: 0, count: 0 };
    groups.set(slot.positionCode, {
      x: prior.x + slot.x,
      y: prior.y + slot.y,
      count: prior.count + 1,
    });
  }
  const bands: { code: string; x: number; y: number }[][] = [];
  for (const [code, spot] of [...groups].sort(
    (left, right) => left[1].y / left[1].count - right[1].y / right[1].count,
  )) {
    const point = { code, x: spot.x / spot.count, y: spot.y / spot.count };
    const last = bands.at(-1);
    if (last && point.y - last[0].y < 0.12) last.push(point);
    else bands.push([point]);
  }
  const capacity = Math.max(1, Math.floor((pitchWidth - 24 + 8) / 52));
  const rows = bands.flatMap((band) => {
    const sorted = band.sort((left, right) => left.x - right.x),
      chunks: (typeof band)[] = [];
    for (let index = 0; index < sorted.length; index += capacity)
      chunks.push(sorted.slice(index, index + capacity));
    return chunks;
  });
  const outsideLayout = formation
    ? statsCorePositionsOutsideLayout(core, new Set(groups.keys()))
    : [];
  return (
    <View style={s.section}>
      {playerView &&
        (core ? (
          <View style={s.coreLegend} testID="stats-core-positions">
            <Text style={typography.muted}>Current core positions</Text>
            <View style={s.actions}>
              <View style={s.legendItem}>
                <View
                  style={[s.legendMark, s.primaryPosition]}
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                />
                <Text style={typography.muted}>
                  Primary · {core.primary ?? "not recorded"}
                </Text>
              </View>
              <View style={s.legendItem}>
                <View
                  style={[s.legendMark, s.secondaryPosition]}
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                />
                <Text style={typography.muted}>
                  Secondary · {core.secondary ?? "not recorded"}
                </Text>
              </View>
            </View>
          </View>
        ) : (
          <Text style={typography.muted} testID="stats-core-unavailable">
            Primary and secondary positions are not available in this view.
          </Text>
        ))}
      {formation && (
        <>
          <Text style={typography.muted}>
            {formation.label} · reference layout
          </Text>
          <View
            style={[
              s.pitch,
              { minHeight: Math.max(340, rows.length * 92 + 24) },
            ]}
            onLayout={(event) => {
              const width = event.nativeEvent.layout.width;
              if (width > 0 && Math.abs(width - pitchWidth) > 1)
                setPitchWidth(width);
            }}
            accessibilityLabel={`Season recorded position time on ${formation.label}. Exact values are listed below.`}
          >
            <View style={s.halfway} />
            <View style={s.centre} />
            <View style={s.positions}>
              {rows.map((row, index) => (
                <View key={index} style={s.positionRow}>
                  {row.map(({ code }) => {
                    const position = value.positions.find(
                      (row) => row.code === code,
                    );
                    const zero = isRecordedZeroPosition(position);
                    const preference = statsPositionPreference(code, core);
                    return (
                      <View
                        key={code}
                        testID={`stats-position-${code}`}
                        accessible
                        accessibilityLabel={`${code}${preference ? `, ${preference === "primary" ? "Primary" : "Secondary"} core position` : ""}, ${statsTime(position?.playingMs ?? 0)}, ${position?.percentage == null ? "percentage not recorded" : `${formatStatsPositionPercentage(position.percentage)} of known playing time`}`}
                        style={[
                          s.position,
                          preference === "primary" && s.primaryPosition,
                          preference === "secondary" && s.secondaryPosition,
                          {
                            width: Math.min(
                              80,
                              (pitchWidth - 24 - (row.length - 1) * 8) /
                                row.length,
                            ),
                          },
                        ]}
                      >
                        <Text
                          style={[s.code, zero && s.zeroText]}
                          testID={`stats-position-code-${code}`}
                        >
                          {code}
                        </Text>
                        <Text
                          style={[s.pitchTime, zero && s.zeroText]}
                          testID={`stats-position-time-${code}`}
                        >
                          {statsTime(position?.playingMs ?? 0)}
                        </Text>
                        <Text
                          style={[s.pitchTime, zero && s.zeroText]}
                          testID={`stats-position-percentage-${code}`}
                        >
                          {formatStatsPositionPercentage(position?.percentage)}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              ))}
            </View>
          </View>
          <Text style={typography.muted}>
            Each position code is combined across matching slots. Formation rows
            adapt to the screen; this reference layout does not infer where a
            player stood within a position.
          </Text>
        </>
      )}
      {outsideLayout.length > 0 && (
        <View style={s.coreLegend} testID="stats-core-outside-layout">
          <Text style={typography.muted}>
            Core positions outside this reference layout
          </Text>
          <View style={s.actions}>
            {outsideLayout.map((row) => (
              <View
                key={row.rank}
                testID={`stats-core-outside-${row.code}`}
                style={[
                  s.outsideCorePosition,
                  row.rank === "primary"
                    ? s.primaryPosition
                    : s.secondaryPosition,
                ]}
                accessible
                accessibilityLabel={`${row.rank === "primary" ? "Primary" : "Secondary"} core position ${row.code}, outside reference layout`}
              >
                <Text style={typography.label}>
                  {row.rank === "primary" ? "Primary" : "Secondary"} ·{" "}
                  {row.code}
                </Text>
              </View>
            ))}
          </View>
          <Text style={typography.muted}>
            These preference markers do not add formation slots. Recorded time
            is listed in the breakdown.
          </Text>
        </View>
      )}
      {!formation && (
        <Notice>
          A saved formation layout is not available. The recorded position
          breakdown is shown below.
        </Notice>
      )}
      <PositionBreakdown value={value} />
      <Text style={typography.muted}>
        Team percentages use the sum of player playing time, not match-clock
        duration. Position codes absent from the layout remain in the breakdown.
      </Text>
    </View>
  );
}
const s = StyleSheet.create({
  section: { gap: 12 },
  workspace: { gap: 16 },
  workspaceWide: { flexDirection: "row", alignItems: "flex-start" },
  picker: { minWidth: 0 },
  pickerWide: { width: 220, flexShrink: 0 },
  playerScrollWide: { maxHeight: 640 },
  playersWide: { gap: 8, paddingBottom: 4 },
  panels: { minWidth: 0, gap: 16 },
  panelsFlexible: { flex: 1 },
  panelsWide: { flexDirection: "row", alignItems: "flex-start" },
  mapPanel: { minWidth: 0 },
  detailsPanel: { minWidth: 0 },
  splitPanel: { flex: 1 },
  players: { gap: 8, paddingBottom: 4 },
  player: {
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: colors.controlBorder,
    borderRadius: 24,
    backgroundColor: colors.surface,
  },
  selected: { backgroundColor: colors.brand, borderColor: colors.brand },
  selectedText: { color: colors.surface },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pitch: {
    minHeight: 340,
    borderWidth: 2,
    borderColor: colors.pitchLine,
    backgroundColor: colors.pitch,
    borderRadius: 12,
    overflow: "hidden",
  },
  positions: { flex: 1, padding: 12, gap: 12, justifyContent: "space-around" },
  positionRow: {
    flexDirection: "row",
    gap: 8,
    justifyContent: "space-around",
    alignItems: "center",
  },
  halfway: {
    position: "absolute",
    top: "50%",
    width: "100%",
    borderTopWidth: 1,
    borderColor: colors.pitchLine,
  },
  centre: {
    position: "absolute",
    width: 70,
    height: 70,
    top: "50%",
    left: "50%",
    marginTop: -35,
    marginLeft: -35,
    borderRadius: 35,
    borderWidth: 1,
    borderColor: colors.pitchLine,
  },
  position: {
    minWidth: 44,
    minHeight: 76,
    borderRadius: 10,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 4,
    alignItems: "center",
  },
  code: { ...typography.label, color: colors.brand },
  pitchTime: { fontSize: 12, lineHeight: 16, color: colors.ink },
  zeroText: { color: "#6B7280" },
  primaryPosition: {
    borderWidth: 2,
    borderColor: "#C62828",
    borderStyle: "solid",
  },
  secondaryPosition: {
    borderWidth: 2,
    borderColor: "#C62828",
    borderStyle: "dotted",
  },
  coreLegend: { gap: 6 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  legendMark: {
    width: 22,
    height: 22,
    backgroundColor: colors.surface,
    borderRadius: 4,
  },
  outsideCorePosition: {
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: colors.surface,
  },
});
