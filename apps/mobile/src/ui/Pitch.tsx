import { useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import Svg, { Circle, Line, Path, Rect } from "react-native-svg";
import type { Allocation, Player } from "@longball/domain";
import { colors } from "./tokens";

const defaultSlots = [
  { id: "gk", label: "GK", name: "Goalkeeper", x: 50, y: 82 },
  { id: "cb-left", label: "CB", name: "Left centre back", x: 28, y: 63 },
  { id: "cb-right", label: "CB", name: "Right centre back", x: 72, y: 63 },
  { id: "cm", label: "CM", name: "Centre midfield", x: 50, y: 44 },
  { id: "lw", label: "LW", name: "Left wing", x: 20, y: 25 },
  { id: "rw", label: "RW", name: "Right wing", x: 80, y: 25 },
  { id: "st", label: "ST", name: "Striker", x: 50, y: 6 },
] as const;
export interface PitchSlot {
  id: string;
  label: string;
  name: string;
  x: number;
  y: number;
}

export interface PitchProps {
  lineup: Allocation[];
  players: Player[];
  /** Match-snapshotted initials preserve the manager's selected short label. */
  initialsByPlayerId?: Readonly<Record<string, string>>;
  onSlotPress?: (slotId: string) => void;
  selectedSlot?: string | null;
  compact?: boolean;
  changedSlotIds?: string[];
  slots?: PitchSlot[];
  formationName?: string;
  /** Formation-template placement only; match allocation behavior remains unchanged. */
  positionEditing?: boolean;
  /** Tactical diagram with position labels and no player identity or empty-player prompt. */
  positionsOnly?: boolean;
  onPitchPress?: (point: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => void;
}

export function Pitch({
  lineup,
  players,
  initialsByPlayerId,
  onSlotPress,
  selectedSlot,
  compact = false,
  changedSlotIds = [],
  slots = [...defaultSlots],
  formationName = "2–3–1 formation",
  positionEditing = false,
  positionsOnly = false,
  onPitchPress,
}: PitchProps) {
  const { fontScale } = useWindowDimensions();
  const [showList, setShowList] = useState(false);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const list = showList || fontScale >= 1.5;
  const positionDiagram = positionEditing || positionsOnly;
  const diagramRows = new Set(slots.filter(slot => slot.label !== 'GK').map(slot => Math.round(slot.y))).size;
  const widestDiagramRow = Math.max(1, ...slots.map(slot => slots.filter(other => Math.round(other.y) === Math.round(slot.y)).length));
  const positionDiscSize = Math.max(20, Math.min(44, (bounds.width - 48) / (widestDiagramRow + 1) - 4));

  return (
    <View style={styles.wrapper}>
      <View style={styles.heading}>
        <Text style={styles.formation}>{formationName}</Text>
        <Pressable
          onPress={() => setShowList(!showList)}
          accessibilityRole="button"
          accessibilityLabel={
            list ? "Show pitch diagram" : "Show position list"
          }
          style={styles.listToggle}
        >
          <Text style={styles.toggleText}>
            {list
              ? fontScale >= 1.5
                ? "Large text · list view"
                : "Pitch view"
              : "List view"}
          </Text>
        </Pressable>
      </View>
      {list ? (
        <View style={styles.positionList}>
          {slots.map((slot) => {
            const allocation = lineup.find((item) => item.slotId === slot.id);
            const player = players.find(
              (item) => item.id === allocation?.playerId,
            );
            const changed = changedSlotIds.includes(slot.id);
            return (
              <Pressable
                key={slot.id}
                onPress={() => onSlotPress?.(slot.id)}
                disabled={!onSlotPress}
                accessibilityRole={onSlotPress ? "button" : undefined}
                accessibilityLabel={
                  positionsOnly ? slot.name : positionEditing
                    ? `Choose formation slot ${slot.name}`
                    : `${slot.name}, ${player?.displayName ?? "unfilled"}${changed ? ", pending start" : ""}`
                }
                testID={
                  positionEditing ? `formation-position-${slot.id}` : undefined
                }
                accessibilityState={{ selected: selectedSlot === slot.id }}
                aria-pressed={onSlotPress ? selectedSlot === slot.id : undefined}
                aria-disabled={!onSlotPress}
                style={[
                  styles.positionRow,
                  selectedSlot === slot.id && styles.selectedRow,
                ]}
              >
                <Text style={styles.positionName}>{slot.name}</Text>
                <Text style={styles.positionPlayer}>
                  {positionsOnly ? slot.label : positionEditing
                    ? `${slot.label} · ${Math.round(slot.x)}%, ${Math.round(slot.y)}%`
                    : (player?.displayName ?? "Choose player")}
                  {changed ? " · Pending" : ""}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : (
        <View
          style={[
            styles.pitch,
            positionsOnly
              ? { height: Math.max(compact ? 306 : 396, 72 + Math.max(0, diagramRows - 1) * 64 / 0.59) }
              : positionEditing
              ? { aspectRatio: 0.72 }
              : { height: compact ? 306 : 396 },
          ]}
          onLayout={(event) => setBounds(event.nativeEvent.layout)}
        >
          {onPitchPress && (
            <Pressable
              style={StyleSheet.absoluteFill}
              testID="formation-placement-surface"
              accessibilityRole="button"
              accessibilityLabel="Place selected formation slot on pitch"
              onPress={(event) => {
                // React Native supplies locationX/Y; web Pressable's mouse-click event uses offsetX/Y.
                const point = event.nativeEvent as typeof event.nativeEvent & {
                  offsetX?: number;
                  offsetY?: number;
                };
                onPitchPress({
                  x:
                    (Number.isFinite(point.locationX)
                      ? point.locationX
                      : (point.offsetX ?? NaN)) - 24,
                  y:
                    (Number.isFinite(point.locationY)
                      ? point.locationY
                      : (point.offsetY ?? NaN)) - 24,
                  width: bounds.width - 48,
                  height: bounds.height - 72,
                });
              }}
            />
          )}
          <Svg
            width="100%"
            height="100%"
            viewBox="0 0 320 400"
            preserveAspectRatio="none"
            style={StyleSheet.absoluteFill}
            accessible={false}
            aria-hidden
            pointerEvents="none"
          >
            <Rect width="320" height="400" fill={colors.pitch} />
            {[0, 2, 4, 6].map((stripe) => (
              <Rect
                key={stripe}
                x={stripe * 40}
                width="40"
                height="400"
                fill={colors.pitchAlternate}
              />
            ))}
            <Rect
              x="9"
              y="9"
              width="302"
              height="382"
              rx="3"
              stroke="white"
              strokeWidth="1.2"
              fill="none"
            />
            <Line
              x1="9"
              y1="200"
              x2="311"
              y2="200"
              stroke="white"
              strokeWidth="1.2"
            />
            <Circle
              cx="160"
              cy="200"
              r="44"
              stroke="white"
              strokeWidth="1.2"
              fill="none"
            />
            <Circle cx="160" cy="200" r="2" fill="white" />
            <Path
              d="M95 9v45h130V9M125 9v19h70V9M95 391v-45h130v45M125 391v-19h70v19"
              stroke="white"
              strokeWidth="1.2"
              fill="none"
            />
            <Path
              d="M9 20a11 11 0 0 0 11-11M300 9a11 11 0 0 0 11 11M9 380a11 11 0 0 1 11 11M300 391a11 11 0 0 1 11-11"
              stroke="white"
              strokeWidth="1.2"
              fill="none"
            />
          </Svg>
          {slots.map((slot) => {
            const allocation = lineup.find((item) => item.slotId === slot.id);
            const player = players.find(
              (item) => item.id === allocation?.playerId,
            );
            const shirt = player?.displayName.match(/\d+$/)?.[0];
            const changed = changedSlotIds.includes(slot.id);
            const selected = selectedSlot === slot.id;
            return (
              <Pressable
                key={slot.id}
                onPress={() => onSlotPress?.(slot.id)}
                disabled={!onSlotPress}
                accessibilityRole={onSlotPress ? "button" : undefined}
                accessibilityLabel={
                  positionsOnly ? slot.name : positionEditing
                    ? `Choose formation slot ${slot.name}`
                    : `${slot.name}, ${player?.displayName ?? "unfilled"}, ${changed ? "pending start" : "current allocation"}`
                }
                testID={
                  positionEditing ? `formation-position-${slot.id}` : undefined
                }
                accessibilityState={{ selected }}
                aria-pressed={onSlotPress ? selected : undefined}
                aria-disabled={!onSlotPress}
                style={[
                  styles.slot,
                  (slots.length > 7 || positionDiagram) && {
                    width: 52,
                    marginLeft: -26,
                  },
                  positionsOnly && { width: positionDiscSize + 8, marginLeft: -(positionDiscSize + 8) / 2, minHeight: positionDiscSize },
                  {
                    left: positionDiagram
                      ? 24 + (slot.x / 100) * Math.max(0, bounds.width - 48)
                      : `${slot.x}%`,
                    top: positionDiagram
                      ? (slot.y / 100) * Math.max(0, bounds.height - 72)
                      : `${compact && slot.label === "GK" ? 78 : slot.y}%`,
                  },
                ]}
              >
                <View
                  style={[
                    styles.disc,
                    slot.label === "GK" && styles.goalkeeper,
                    !player && !positionsOnly && styles.emptyDisc,
                    positionsOnly && { width: positionDiscSize, height: positionDiscSize, borderRadius: positionDiscSize / 2 },
                    (selected || changed) && styles.selectedDisc,
                  ]}
                >
                  <Text style={[styles.discText, positionsOnly && { fontSize: Math.max(12, Math.min(18, positionDiscSize * 0.42)), lineHeight: Math.max(16, Math.min(24, positionDiscSize * 0.6)) }]}>
                    {positionDiagram
                      ? slot.label
                      : (shirt ??
                        (player
                          ? initialsByPlayerId?.[player.id] ?? player.displayName.trim().split(/\s+/).map((part) => part[0]).filter(Boolean).slice(0, 2).join("").toUpperCase()
                          : "+"))}
                  </Text>
                  {selected && (
                    <View style={styles.selectedMarker}>
                      <Text style={styles.selectedCheck}>✓</Text>
                    </View>
                  )}
                </View>
                {!positionsOnly && <Text style={styles.slotText}>
                  {slot.label}
                  {changed ? " · Pending" : ""}
                </Text>}
              </Pressable>
            );
          })}
        </View>
      )}
      {onSlotPress && (
        <Text style={styles.hint}>
          {positionEditing
            ? "Choose a named slot, then tap an empty pitch area. List view and direction buttons offer the same editing controls."
            : "Tap a position to choose or swap a player."}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: 5 },
  heading: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  formation: {
    fontSize: 14,
    lineHeight: 20,
    color: colors.inkMuted,
    flexShrink: 1,
  },
  listToggle: {
    minWidth: 48,
    minHeight: 48,
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  toggleText: {
    fontSize: 14,
    lineHeight: 20,
    color: colors.brand,
    fontWeight: "600",
  },
  pitch: {
    backgroundColor: colors.pitch,
    borderRadius: 10,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.brandPressed,
  },
  slot: {
    position: "absolute",
    width: 86,
    minHeight: 62,
    marginLeft: -43,
    alignItems: "center",
    justifyContent: "flex-start",
  },
  disc: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1.5,
    borderColor: colors.ink,
    backgroundColor: colors.disc,
    justifyContent: "center",
    alignItems: "center",
  },
  discText: {
    fontSize: 18,
    lineHeight: 24,
    fontWeight: "700",
    color: colors.discInk,
  },
  goalkeeper: { backgroundColor: colors.selection },
  emptyDisc: { backgroundColor: "#E3EFE8", borderStyle: "dashed" },
  selectedDisc: { borderWidth: 3, borderColor: colors.selection },
  selectedMarker: {
    position: "absolute",
    top: -6,
    right: -7,
    backgroundColor: colors.selection,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.ink,
  },
  selectedCheck: { fontSize: 12, fontWeight: "700", color: colors.ink },
  slotText: {
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "600",
    color: colors.surface,
    marginTop: 2,
    textAlign: "center",
  },
  hint: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.inkMuted,
    textAlign: "center",
    paddingVertical: 5,
  },
  positionList: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    overflow: "hidden",
    backgroundColor: colors.surface,
  },
  positionRow: {
    minHeight: 58,
    padding: 12,
    borderBottomWidth: 1,
    borderColor: colors.border,
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
    flexWrap: "wrap",
  },
  selectedRow: { backgroundColor: colors.warningSurface },
  positionName: {
    fontSize: 14,
    lineHeight: 20,
    color: colors.inkMuted,
    flex: 1,
    minWidth: 110,
  },
  positionPlayer: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: "600",
    color: colors.ink,
    flex: 1,
    minWidth: 110,
  },
});
