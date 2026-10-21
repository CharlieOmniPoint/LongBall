import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import {
  goalRecords,
  type AvailabilityReason,
  type ClockReading,
  type EffectiveMatchTime,
  type GoalRecord,
  type GoalType,
  type MatchEvent,
  type MatchState,
} from "@longball/domain";
import { Button, Card, colors, Notice, Pill } from "../ui";
import { formatTime } from "../useMatch";

type Command = MatchEvent extends infer E
  ? E extends MatchEvent
    ? Omit<E, "id" | "sample">
    : never
  : never;
export function LiveEventsPanel({
  match,
  clock,
  onCommand,
  busy = false,
  teamLabel = "Roma",
}: {
  match: MatchState;
  clock: ClockReading;
  onCommand: (command: Command) => Promise<boolean>;
  busy?: boolean;
  teamLabel?: string;
}) {
  const [panel, setPanel] = useState<
    "goal" | "availability" | "history" | null
  >(null);
  const [beneficiary, setBeneficiary] = useState<"us" | "opposition">("us");
  const [ownGoal, setOwnGoal] = useState(false);
  const [scorer, setScorer] = useState<string | null>(null);
  const [goalType, setGoalType] = useState<GoalType>("open_play");
  const [effective, setEffective] = useState<EffectiveMatchTime | null>(null);
  const [edit, setEdit] = useState<GoalRecord | null>(null);
  const [reason, setReason] = useState("");
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [availabilityReason, setAvailabilityReason] =
    useState<AvailabilityReason>("injury");
  const terminal = match.status === "completed" || match.status === "abandoned";
  const activeHalf = match.half === 1 || match.half === 2;
  const canRecord =
    activeHalf &&
    match.status !== "half_time" &&
    !terminal &&
    !clock.recoveryRequired;
  const goals = goalRecords(match);
  const playerName = (id: string | null) =>
    match.config.players.find((player) => player.id === id)?.displayName ??
    "Not recorded";
  const capture = (): EffectiveMatchTime => ({
    half: match.half === 2 ? 2 : 1,
    halfElapsedMs: clock.halfActiveMs,
    matchElapsedMs: clock.matchActiveMs,
  });
  const openGoal = (goal?: GoalRecord) => {
    setPanel("goal");
    setEdit(goal ?? null);
    setReason("");
    setBeneficiary(goal?.beneficiary ?? "us");
    setOwnGoal(goal?.isOwnGoal ?? false);
    setScorer(goal?.scorerPlayerId ?? null);
    setGoalType(goal?.goalType ?? "open_play");
    setEffective(goal?.effective ?? capture());
  };
  const saveGoal = async () => {
    if (!effective) return;
    const details = {
      type: "goal.recorded" as const,
      beneficiary,
      isOwnGoal: ownGoal,
      scorerPlayerId:
        (beneficiary === "us" && !ownGoal) ||
        (beneficiary === "opposition" && ownGoal)
          ? scorer
          : null,
      goalType,
      effective,
    };
    const command: Command = edit
      ? {
          type: "event.corrected",
          targetEventId: edit.eventId,
          reason,
          replacement: details,
          ...(edit.voided ? { restoreVoided: true } : {}),
        }
      : details;
    if (await onCommand(command)) {
      setPanel(null);
      setEdit(null);
    }
  };

  return (
    <View style={styles.stack}>
      <View style={styles.row}>
        <Button
          label="Record goal"
          testID="open-goal"
          disabled={busy || !canRecord}
          onPress={() => openGoal()}
          style={styles.flex}
        />
        <Button
          label="Unavailable / return"
          testID="open-availability"
          variant="secondary"
          disabled={busy || !activeHalf || terminal || clock.recoveryRequired}
          onPress={() => {
            setPanel("availability");
            setPlayerId(null);
            setEffective(capture());
          }}
          style={styles.flex}
        />
      </View>
      <Button
        label={`Goals and corrections · ${goals.length}`}
        variant="quiet"
        onPress={() => setPanel(panel === "history" ? null : "history")}
      />
      {panel === "goal" && (
        <Card>
          <Text accessibilityRole="header" style={styles.heading}>
            {edit ? "Correct recorded goal" : "Record a goal"}
          </Text>
          <Text style={styles.muted}>
            Effective time: half {effective?.half} ·{" "}
            {formatTime(effective?.halfElapsedMs ?? 0)}. The match clock
            continues.
          </Text>
          {!edit && (
            <Button
              label="Use current clock time"
              variant="quiet"
              onPress={() => setEffective(capture())}
            />
          )}
          <View style={styles.row}>
            <Button
              label={`${teamLabel} score`}
              variant={beneficiary === "us" ? "primary" : "secondary"}
              onPress={() => {
                setBeneficiary("us");
                setScorer(null);
              }}
              style={styles.flex}
            />
            <Button
              label="Opposition score"
              variant={beneficiary === "opposition" ? "primary" : "secondary"}
              onPress={() => {
                setBeneficiary("opposition");
                setScorer(null);
              }}
              style={styles.flex}
            />
          </View>
          <Button
            label={ownGoal ? "Own goal · yes" : "Own goal · no"}
            variant={ownGoal ? "primary" : "secondary"}
            onPress={() => {
              setOwnGoal(!ownGoal);
              setScorer(null);
            }}
          />
          <Text style={styles.label}>Goal type</Text>
          <View style={styles.wrap}>
            {(
              [
                ["not_recorded", "Not recorded"],
                ["open_play", "Open play"],
                ["free_kick", "Free kick"],
                ["penalty", "Penalty"],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                label={label}
                variant={goalType === value ? "primary" : "secondary"}
                onPress={() => setGoalType(value)}
              />
            ))}
          </View>
          {((beneficiary === "us" && !ownGoal) ||
            (beneficiary === "opposition" && ownGoal)) && (
            <>
              <Text style={styles.label}>
                {ownGoal ? "Our player involved in the own goal" : "Scorer"}
              </Text>
              <Button
                label="Scorer not recorded"
                variant={scorer === null ? "primary" : "secondary"}
                onPress={() => setScorer(null)}
              />
              <View style={styles.wrap}>
                {match.config.players
                  .filter((player) =>
                    match.config.selectedPlayerIds.includes(player.id),
                  )
                  .map((player) => (
                    <Button
                      key={player.id}
                      label={player.displayName}
                      variant={scorer === player.id ? "primary" : "secondary"}
                      onPress={() => setScorer(player.id)}
                    />
                  ))}
              </View>
            </>
          )}
          {ownGoal && (
            <Notice>
              {beneficiary === "us"
                ? `Opposition own goal: our score increases without crediting a ${teamLabel} scorer.`
                : `${teamLabel} own goal: the opposition score increases. It does not count as a ${teamLabel} scoring goal.`}
            </Notice>
          )}
          {edit && (
            <>
              <Text style={styles.label}>Correction reason</Text>
              <TextInput
                accessibilityLabel="Goal correction reason"
                value={reason}
                onChangeText={setReason}
                placeholder="Explain what was recorded incorrectly"
                style={styles.input}
              />
            </>
          )}
          <Button
            label={edit ? "Confirm goal correction" : "Save goal"}
            testID="save-goal"
            disabled={busy || (Boolean(edit) && !reason.trim())}
            onPress={() => {
              void saveGoal();
            }}
          />
          <Button
            label="Cancel goal entry"
            variant="quiet"
            onPress={() => setPanel(null)}
          />
        </Card>
      )}
      {panel === "availability" && (
        <Card>
          <Text accessibilityRole="header" style={styles.heading}>
            Availability during this match
          </Text>
          <Text style={styles.muted}>
            Participation changes at the recorded effective time. A vacated
            place stays empty until you confirm a replacement.
          </Text>
          <Text style={styles.muted}>
            Half {effective?.half} · {formatTime(effective?.halfElapsedMs ?? 0)}
          </Text>
          <Button
            label="Use current availability time"
            variant="quiet"
            onPress={() => setEffective(capture())}
          />
          {match.config.players
            .filter((player) =>
              match.config.selectedPlayerIds.includes(player.id),
            )
            .map((player) => (
              <Button
                key={player.id}
                label={`${player.displayName} · ${match.availability[player.id] ? "available" : "unavailable"}`}
                variant={playerId === player.id ? "primary" : "secondary"}
                onPress={() => setPlayerId(player.id)}
              />
            ))}
          {playerId && (
            <>
              {match.availability[playerId] ? (
                <View style={styles.wrap}>
                  {(["injury", "departure", "other"] as const).map((value) => (
                    <Button
                      key={value}
                      label={
                        value === "injury"
                          ? "Injury / unavailable"
                          : value === "departure"
                            ? "Left the match"
                            : "Other unavailability"
                      }
                      variant={
                        availabilityReason === value ? "primary" : "secondary"
                      }
                      onPress={() => setAvailabilityReason(value)}
                    />
                  ))}
                </View>
              ) : (
                <Notice>
                  Confirm this player has returned and is available. This does
                  not place them on the pitch.
                </Notice>
              )}
              <Button
                label={
                  match.availability[playerId]
                    ? "Confirm unavailable; leave place vacant"
                    : "Confirm available return"
                }
                testID="confirm-availability"
                disabled={busy}
                onPress={() => {
                  void onCommand({
                    type: "availability.changed",
                    playerId,
                    available: !match.availability[playerId],
                    reason: match.availability[playerId]
                      ? availabilityReason
                      : "return",
                    effective: effective ?? capture(),
                  }).then((saved) => {
                    if (saved) setPanel(null);
                  });
                }}
              />
            </>
          )}
          <Button
            label="Cancel availability change"
            variant="quiet"
            onPress={() => setPanel(null)}
          />
        </Card>
      )}
      {panel === "history" && (
        <Card>
          <Text accessibilityRole="header" style={styles.heading}>
            Goal history
          </Text>
          {goals.length === 0 && (
            <Text style={styles.muted}>No goals have been recorded.</Text>
          )}
          {goals.map((goal) => (
            <View key={goal.eventId} style={styles.goalRow}>
              <View style={styles.row}>
                <Text style={styles.label}>
                  {goal.beneficiary === "us" ? teamLabel : "Opposition"}
                  {goal.isOwnGoal ? " · own goal" : ""}
                </Text>
                {goal.voided && <Pill tone="warning">Voided</Pill>}
              </View>
              <Text style={styles.muted}>
                Half {goal.effective.half} ·{" "}
                {formatTime(goal.effective.halfElapsedMs)} ·{" "}
                {playerName(goal.scorerPlayerId)} ·{" "}
                {goal.goalType.replaceAll("_", " ")}
              </Text>
              <Button
                label={
                  goal.voided ? "Review and restore goal" : "Correct this goal"
                }
                variant="secondary"
                disabled={busy}
                onPress={() => openGoal(goal)}
              />
              {!goal.voided && (
                <>
                  <TextInput
                    accessibilityLabel={`Void reason for goal ${goal.eventId}`}
                    value={edit?.eventId === goal.eventId ? reason : ""}
                    onFocus={() => {
                      setEdit(goal);
                      setReason("");
                    }}
                    onChangeText={setReason}
                    placeholder="Reason to void this goal"
                    style={styles.input}
                  />
                  <Button
                    label="Void goal; keep audit record"
                    variant="danger"
                    disabled={
                      busy || edit?.eventId !== goal.eventId || !reason.trim()
                    }
                    onPress={() => {
                      void onCommand({
                        type: "event.voided",
                        targetEventId: goal.eventId,
                        reason,
                      }).then((saved) => {
                        if (saved) {
                          setEdit(null);
                          setReason("");
                        }
                      });
                    }}
                  />
                </>
              )}
            </View>
          ))}
          <Notice>
            Corrections retain the former event and a reason. Changing a score
            never changes actual playing time or the original full-time
            deadline.
          </Notice>
        </Card>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 10 },
  row: { flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" },
  flex: { flex: 1, minWidth: 125 },
  wrap: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  heading: {
    color: colors.ink,
    fontSize: 20,
    lineHeight: 27,
    fontWeight: "700",
  },
  label: { color: colors.ink, fontSize: 15, lineHeight: 22, fontWeight: "600" },
  muted: { color: colors.inkMuted, fontSize: 14, lineHeight: 21 },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.controlBorder,
    borderRadius: 8,
    padding: 12,
    color: colors.ink,
    backgroundColor: colors.surface,
    fontSize: 16,
  },
  goalRow: {
    borderTopWidth: 1,
    borderColor: colors.border,
    paddingTop: 12,
    gap: 8,
  },
});
