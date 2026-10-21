import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import {
  validateLineup,
  type Allocation,
  type Attendance,
  type ClockReading,
  type MatchState,
} from "@longball/domain";
import {
  assertNativeLiveAccess,
  assertNativeLiveCommand,
} from "@longball/application/connected-live-editor";
import type { ConnectedCommand } from "@longball/application/sync";
import type { Journal, JournalDiagnostics } from "../platform/types";
import { Button, Card, Notice } from "../ui/Button";
import { colors, typography } from "../ui/tokens";
import { LiveEventsPanel } from "./LiveEventsPanel";

export interface ConnectedLiveEditorProps {
  match: MatchState;
  clock: ClockReading | null;
  busy: boolean;
  onCommand: (command: ConnectedCommand) => Promise<boolean>;
  journal: Journal | null;
  eligible: boolean;
  teamLabel?: string;
  reviewDraft?: {
    matchId: string;
    sourceRevision: number;
    lineup: Allocation[];
  } | null;
  onReviewDraftConsumed?: () => void;
}

/** Authenticated native recording only. Browser review keeps the same pure domain rules. */
export function ConnectedLiveEditor(props: ConnectedLiveEditorProps) {
  const [observedJournal, setObservedJournal] = useState<{
    journal: Journal;
    diagnostics: JournalDiagnostics;
  } | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [lineupDraft, setLineupDraft] = useState<{
    matchId: string;
    sourceRevision: number;
    lineup: Allocation[];
  } | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const current = useRef(props);
  const saveLock = useRef(false);
  useLayoutEffect(() => {
    current.current = props;
  }, [props]);
  const preparation =
    props.match.status === "preparation" || props.match.status === "half_time";
  const terminal = ["completed", "abandoned"].includes(props.match.status);
  const diagnostics =
    observedJournal?.journal === props.journal
      ? observedJournal.diagnostics
      : null;
  const savedLineup = preparation
    ? props.match.stagedLineup
    : props.match.lineup;
  const retainedDraft =
    lineupDraft?.matchId === props.match.config.matchId ? lineupDraft : null;
  const draft = retainedDraft?.lineup ?? savedLineup;
  const sourceRevision = retainedDraft?.sourceRevision ?? props.match.revision;
  const dirty = retainedDraft !== null;
  const changeDraft = (update: (value: Allocation[]) => Allocation[]) => {
    setLineupDraft((previous) => {
      const retained =
        previous?.matchId === props.match.config.matchId ? previous : null;
      return {
        matchId: props.match.config.matchId,
        sourceRevision: retained?.sourceRevision ?? props.match.revision,
        lineup: update(retained?.lineup ?? savedLineup),
      };
    });
  };
  useEffect(() => {
    const journal = props.journal;
    if (!journal) return;
    let active = true;
    void journal
      .getDiagnostics()
      .then((value) => {
        if (active) setObservedJournal({ journal, diagnostics: value });
      })
      .catch(() => {
        if (active)
          setStorageError(
            "Secure storage could not be checked. Existing saved records were retained.",
          );
      });
    return () => {
      active = false;
    };
  }, [props.journal]);
  const checkStorage = async () => {
    if (!props.journal || storageBusy) return;
    setStorageBusy(true);
    setStorageError(null);
    try {
      const result = await props.journal.runCipherProbe();
      const next = await props.journal.getDiagnostics();
      if (current.current.journal !== props.journal)
        throw new Error("Storage context changed; reopen this match.");
      setObservedJournal({ journal: props.journal, diagnostics: next });
      if (result.status !== "passed") throw new Error(result.detail);
    } catch (error) {
      setStorageError(
        error instanceof Error ? error.message : "Secure storage check failed.",
      );
    } finally {
      setStorageBusy(false);
    }
  };
  let gate: string | null = null;
  try {
    assertNativeLiveAccess(props.match, {
      platform: Platform.OS,
      eligible: props.eligible,
      journalEvidence: diagnostics,
    });
  } catch (error) {
    gate =
      error instanceof Error
        ? error.message
        : "Native recording is unavailable.";
  }
  const record = async (command: ConnectedCommand): Promise<boolean> => {
    if (saveLock.current) return false;
    saveLock.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const journal = current.current.journal;
      if (!journal) throw new Error("The secure journal is unavailable.");
      const evidence = await journal.getDiagnostics();
      const active = current.current;
      if (journal !== active.journal || active.busy)
        throw new Error(
          "The recording context changed or another save is pending. Retry after checking the current state.",
        );
      assertNativeLiveCommand(active.match, command, {
        platform: Platform.OS,
        eligible: active.eligible,
        journalEvidence: evidence,
      });
      return await active.onCommand(command);
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : "This event was not saved. Existing records were retained.",
      );
      return false;
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  };
  const busy = props.busy || saving || storageBusy || Boolean(gate);
  const staleDraft = dirty && sourceRevision !== props.match.revision;
  const lineupErrors = validateLineup(props.match, draft, !preparation);
  const suggestedDraft = props.reviewDraft;
  const suggestedStale = Boolean(
    suggestedDraft &&
      (suggestedDraft.matchId !== props.match.config.matchId ||
        suggestedDraft.sourceRevision !== props.match.revision),
  );
  const suggestedErrors = suggestedDraft
    ? validateLineup(props.match, suggestedDraft.lineup, !preparation)
    : [];
  const slot = props.match.config.slots?.find(
    (value) => value.slotId === selectedSlot,
  );
  const teamLabel =
    props.teamLabel ?? props.match.config.fixture?.teamName ?? "Our team";
  const resetDraft = () => {
    setLineupDraft(null);
    setSelectedSlot(null);
  };
  return (
    <View style={styles.stack}>
      <Card>
        <Text style={typography.section}>
          {teamLabel} · native match recording
        </Text>
        <Text style={typography.muted}>
          Events use this saved fixture and roster. Saved on this phone means
          the secure transaction completed; service acknowledgement is shown
          separately above.
        </Text>
        {gate && <Notice tone="warning">{gate}</Notice>}
        {(storageError || saveError) && (
          <Notice tone="error">{storageError || saveError}</Notice>
        )}
        {diagnostics?.wrongKeyProbe !== "passed" && (
          <Button
            label={
              storageBusy
                ? "Checking secure storage…"
                : "Check secure storage for recording"
            }
            disabled={storageBusy || !props.journal || Platform.OS === "web"}
            onPress={() => {
              void checkStorage();
            }}
          />
        )}
        <Text style={typography.muted}>
          This check does not prove phone backup/restore, sleep/reboot clock
          recovery or notification delivery. Those device checks remain
          required.
        </Text>
      </Card>
      {!gate && props.clock && (
        <>
          {!terminal && (
            <Card>
              <Text style={typography.section}>Actual match check-in</Text>
              <Text style={typography.muted}>
                Confirm each player on arrival. An availability reply is not
                attendance.
                {props.match.half > 0
                  ? " During play, this records attendance at the current confirmed active time. Earlier arrival time is not guessed, and a present player stays off the pitch until you confirm a lineup change."
                  : ""}
              </Text>
              {props.match.config.players
                .filter((player) =>
                  props.match.config.selectedPlayerIds.includes(player.id),
                )
                .map((player) => (
                  <View key={player.id} style={styles.player}>
                    <Text style={typography.label}>
                      {player.displayName} ·{" "}
                      {props.match.attendance[player.id].replaceAll("_", " ")}
                    </Text>
                    <View style={styles.wrap}>
                      {(
                        [
                          ["present", "Present"],
                          ["absent", "Absent"],
                          ["excused", "Excused"],
                          ["not_recorded", "Not recorded"],
                        ] as [Attendance, string][]
                      ).map(([status, label]) => (
                        <Button
                          key={status}
                          label={
                            props.match.half > 0 && status === "present"
                              ? "Arrived / present now"
                              : label
                          }
                          variant={
                            props.match.attendance[player.id] === status
                              ? "primary"
                              : "secondary"
                          }
                          disabled={
                            busy ||
                            props.clock!.recoveryRequired ||
                            props.match.attendance[player.id] === status
                          }
                          onPress={() => {
                            void record({
                              type: "attendance.recorded",
                              playerId: player.id,
                              status,
                            });
                          }}
                        />
                      ))}
                    </View>
                  </View>
                ))}
            </Card>
          )}
          {!terminal && (
            <Card>
              <Text style={typography.section}>
                {preparation
                  ? "Prepare the saved formation"
                  : "Review a lineup change"}
              </Text>
              <Text style={typography.muted}>
                {preparation
                  ? "Assign the actual present players to the saved places. Kickoff commits the staged lineup."
                  : "Draft a complete batch. Confirm only when the changes actually happen; the clock continues while you review."}
              </Text>
              {suggestedDraft && (
                <View style={styles.stack}>
                  <Notice
                    tone={
                      suggestedStale || suggestedErrors.length
                        ? "warning"
                        : "info"
                    }
                  >
                    {suggestedStale
                      ? "This suggestion belongs to a different match or an older saved revision. Replan from the current match before opening it."
                      : suggestedErrors.length
                        ? suggestedErrors.join(" ")
                        : dirty
                          ? "Opening the selected suggestion replaces this unsaved lineup draft. Actual participation stays unchanged until you confirm the event."
                          : "The selected suggestion opens a draft. Review every place, then confirm only when the players actually change."}
                  </Notice>
                  <Button
                    label={
                      dirty
                        ? "Replace unsaved draft with suggestion"
                        : "Open suggested lineup as draft"
                    }
                    disabled={
                      busy ||
                      suggestedStale ||
                      suggestedErrors.length > 0 ||
                      props.clock.recoveryRequired
                    }
                    onPress={() => {
                      if (
                        suggestedDraft.matchId !== props.match.config.matchId ||
                        suggestedDraft.sourceRevision !== props.match.revision
                      )
                        return;
                      setLineupDraft({
                        matchId: suggestedDraft.matchId,
                        sourceRevision: suggestedDraft.sourceRevision,
                        lineup: suggestedDraft.lineup.map((allocation) => ({
                          ...allocation,
                        })),
                      });
                      setSelectedSlot(null);
                      props.onReviewDraftConsumed?.();
                    }}
                  />
                  <Button
                    label="Dismiss selected suggestion"
                    variant="quiet"
                    disabled={busy}
                    onPress={() => props.onReviewDraftConsumed?.()}
                  />
                </View>
              )}
              <View style={styles.stack}>
                {props.match.config.slots!.map((saved) => {
                  const allocation = draft.find(
                    (value) => value.slotId === saved.slotId,
                  );
                  const player = props.match.config.players.find(
                    (value) => value.id === allocation?.playerId,
                  );
                  return (
                    <Button
                      key={saved.slotId}
                      label={`${saved.label ?? saved.position} · ${player?.displayName ?? "Vacant"}`}
                      variant={
                        selectedSlot === saved.slotId ? "primary" : "secondary"
                      }
                      disabled={busy}
                      onPress={() => setSelectedSlot(saved.slotId)}
                    />
                  );
                })}
              </View>
              {slot && (
                <View style={styles.stack}>
                  <Text style={typography.label}>
                    Choose for {slot.label ?? slot.position}
                  </Text>
                  {props.match.config.players
                    .filter(
                      (player) =>
                        props.match.config.selectedPlayerIds.includes(
                          player.id,
                        ) &&
                        props.match.attendance[player.id] === "present" &&
                        props.match.availability[player.id] &&
                        props.match.config.profileSnapshot!.some(
                          (profile) =>
                            profile.playerId === player.id &&
                            profile.eligiblePositions.includes(slot.position),
                        ),
                    )
                    .map((player) => (
                      <Button
                        key={player.id}
                        label={player.displayName}
                        variant="secondary"
                        disabled={busy}
                        onPress={() => {
                          changeDraft((value) => [
                            ...value.filter(
                              (item) =>
                                item.slotId !== slot.slotId &&
                                item.playerId !== player.id,
                            ),
                            {
                              slotId: slot.slotId,
                              position: slot.position,
                              playerId: player.id,
                            },
                          ]);
                        }}
                      />
                    ))}
                  <Button
                    label="Leave this place vacant in the draft"
                    variant="quiet"
                    disabled={busy}
                    onPress={() => {
                      changeDraft((value) =>
                        value.filter((item) => item.slotId !== slot.slotId),
                      );
                    }}
                  />
                </View>
              )}
              {lineupErrors.length > 0 && (
                <Notice tone="warning">{lineupErrors.join(" ")}</Notice>
              )}
              {staleDraft && (
                <Notice tone="warning">
                  Saved match state changed while this draft was open. Review
                  the saved lineup before making another change.
                </Notice>
              )}
              <Button
                label={
                  preparation
                    ? "Save staged lineup"
                    : "Confirm lineup changes happened now"
                }
                disabled={
                  busy ||
                  !dirty ||
                  staleDraft ||
                  lineupErrors.length > 0 ||
                  props.clock.recoveryRequired
                }
                onPress={() => {
                  void record(
                    preparation
                      ? { type: "lineup.staged", lineup: draft }
                      : {
                          type: "lineup.committed",
                          lineup: draft,
                          sourceRevision,
                        },
                  ).then((saved) => {
                    if (saved) {
                      setLineupDraft(null);
                      setSelectedSlot(null);
                    }
                  });
                }}
              />
              <Button
                label="Review saved lineup; discard this unsaved draft"
                variant="quiet"
                disabled={saving}
                onPress={resetDraft}
              />
            </Card>
          )}
          <LiveEventsPanel
            match={props.match}
            clock={props.clock}
            onCommand={record}
            busy={busy}
            teamLabel={teamLabel}
          />
        </>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  stack: { gap: 12 },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  player: {
    borderTopWidth: 1,
    borderColor: colors.border,
    paddingTop: 12,
    gap: 8,
  },
});
