import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Platform, ScrollView, StyleSheet, Text, View, type ScrollViewInstance } from "react-native";
import {
  validateLineup,
  type Allocation,
  type Attendance,
  type ClockReading,
  type MatchState,
  type EffectiveMatchTime,
} from "@longball/domain";
import {
  assertLiveEditorAccess,
  assertLiveEditorCommand,
  type LiveEditorMode,
} from "@longball/application/live-editor-access";
import type { ConnectedCommand } from "@longball/application/sync";
import type { Journal, JournalDiagnostics } from "../platform/types";
import { Button, Card, Notice, Pill } from "../ui/Button";
import { Pitch } from "../ui/Pitch";
import { colors, typography } from "../ui/tokens";
import { formatTime } from "../useMatch";
import { LiveEventsPanel } from "./LiveEventsPanel";
import { reviewPreparedMatchPlanLineup } from '@longball/application/match-plans';
import { autoFillMatchLineup } from '@longball/application/lineup-autofill';

export interface ConnectedLiveEditorProps {
  match: MatchState;
  clock: ClockReading | null;
  busy: boolean;
  onCommand: (command: ConnectedCommand) => Promise<boolean>;
  journal: Journal | null;
  eligible: boolean;
  mode?: LiveEditorMode;
  teamLabel?: string;
  reviewDraft?: {
    matchId: string;
    sourceRevision: number;
    lineup: Allocation[];
  } | null;
  onReviewDraftConsumed?: () => void;
  /** Opens the parent's existing actual-event confirmation; never records directly. */
  onReviewClockAction?: (action: "start" | "pause" | "resume" | "end") => void;
  clockActionReview?: ReactNode;
  fillScreen?: boolean;
  header?: ReactNode;
  extraContent?: ReactNode;
}

/** Native connected recording, or the explicitly isolated fictional browser review. */
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
  const [eventAction, setEventAction] = useState<{ revision: number; kind: "goal" | "availability"; effective: EffectiveMatchTime } | null>(null);
  const contentScroll = useRef<ScrollViewInstance | null>(null);
  const [mode, setMode] = useState<"attendance" | "lineup" | "live">(
    props.match.status === "preparation" ? "attendance" : "live",
  );
  const current = useRef(props);
  const saveLock = useRef(false);
  useLayoutEffect(() => {
    current.current = props;
  }, [props]);
  const preparation =
    props.match.status === "preparation" || props.match.status === "half_time";
  const terminal = ["completed", "abandoned"].includes(props.match.status);
  const activeMode = terminal ? "live" : mode;
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
    assertLiveEditorAccess(props.match, {
      mode: props.mode,
      allowFictionalReview:
        process.env.EXPO_PUBLIC_ENVIRONMENT !== "production",
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
      assertLiveEditorCommand(active.match, command, {
        mode: active.mode,
        allowFictionalReview:
          process.env.EXPO_PUBLIC_ENVIRONMENT !== "production",
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
  const reusableProposal = props.match.config.initialLineupProposal;
  let reusableProposalError: string | null = null;
  if (props.match.status === 'preparation' && reusableProposal) { try { reviewPreparedMatchPlanLineup(props.match); } catch (cause) { reusableProposalError = cause instanceof Error ? cause.message : 'Review actual check-in first.'; } }
  const slot = props.match.config.slots?.find(
    (value) => value.slotId === selectedSlot,
  );
  const teamLabel =
    props.teamLabel ?? props.match.config.fixture?.teamName ?? "Our team";
  const squad = props.match.config.players.filter((player) =>
    props.match.config.selectedPlayerIds.includes(player.id),
  );
  const present = squad.filter(
    (player) => props.match.attendance[player.id] === "present",
  );
  const availableBench = present.filter(
    (player) =>
      props.match.availability[player.id] &&
      !savedLineup.some((allocation) => allocation.playerId === player.id),
  );
  const unavailable = present.filter(
    (player) => !props.match.availability[player.id],
  );
  const pitchSlots = props.match.config.slots?.map((saved, index) => ({
    id: saved.slotId,
    label: saved.label ?? saved.position,
    name: `${saved.label ?? saved.position} · place ${index + 1}`,
    x: (saved.x ?? 0.5) * 100,
    y: Math.min(
      82,
      Math.max(5, (saved.y ?? index / props.match.config.pitchPlaces) * 90),
    ),
  }));
  const initialsByPlayerId = Object.fromEntries((props.match.config.profileSnapshot ?? []).map((profile) => [profile.playerId, profile.initials]));
  const changedSlotIds = props.match.config.slots
    ?.filter(
      (saved) =>
        draft.find((value) => value.slotId === saved.slotId)?.playerId !==
        savedLineup.find((value) => value.slotId === saved.slotId)?.playerId,
    )
    .map((saved) => saved.slotId);
  const running = props.match.status.endsWith("_running");
  const paused = props.match.status.endsWith("_paused");
  const resetDraft = () => {
    setLineupDraft(null);
    setSelectedSlot(null);
  };
  const clockActions = props.clock && (props.onReviewClockAction && !terminal && (
                <View style={styles.wrap}>
                  {preparation && (
                    <Button
                      label={
                        props.fillScreen ? props.match.status === "half_time" ? "Start second half" : "Start first half"
                          : props.match.status === "half_time" ? "Review second-half start" : "Review kickoff"
                      }
                      disabled={busy || props.clock.recoveryRequired || dirty || validateLineup(props.match, savedLineup, false).length > 0}
                      onPress={() => { setMode("live"); props.onReviewClockAction?.("start"); }}
                      style={[styles.action, props.fillScreen && styles.railButton]}
                    />
                  )}
                  {(running || paused) && (
                    <>
                      <Button
                        label={
                          paused
                            ? "Review clock resume"
                            : "Review referee pause"
                        }
                        variant="secondary"
                        disabled={busy || props.clock.recoveryRequired}
                        onPress={() =>
                          props.onReviewClockAction?.(
                            paused ? "resume" : "pause",
                          )
                        }
                        style={[styles.action, props.fillScreen && styles.railButton]}
                      />
                      <Button
                        label={
                          props.match.half === 1
                            ? "Review half-time"
                            : "Review full-time"
                        }
                        variant="danger"
                        disabled={busy || props.clock.recoveryRequired}
                        onPress={() => props.onReviewClockAction?.("end")}
                        style={[styles.action, props.fillScreen && styles.railButton]}
                      />
                    </>
                  )}
                </View>
              ));
  const scoreCard = props.clock && (<Card style={props.fillScreen ? { padding: 10, gap: 4 } : undefined}>
              <View style={styles.scoreboard}>
                <Text style={[typography.label, styles.teamName]}>
                  {teamLabel}
                </Text>
                <Text style={typography.score}>
                  {props.match.score.for}–{props.match.score.against}
                </Text>
                <Text style={[typography.label, styles.teamName]}>
                  {props.match.config.fixture?.opponent ?? "Opposition"}
                </Text>
              </View>
              <Pill
                tone={
                  paused || props.clock.recoveryRequired ? "warning" : "brand"
                }
              >
                {props.match.status === "preparation"
                  ? "Before kickoff"
                  : props.match.status === "half_time"
                    ? "Half-time"
                    : props.match.status === "completed"
                      ? "Full-time"
                      : props.match.status === "abandoned"
                        ? "Match abandoned"
                        : `${props.match.half === 1 ? "First" : "Second"} half · ${paused ? "referee clock paused" : "in play"}`}
              </Pill>
              <Text style={typography.muted}>
                {terminal ? "Total active match time"
                  : props.match.status === "half_time" ? "Actual first half"
                  : props.match.half === 0 ? "Planned half length"
                  : props.clock.remainingMs === 0 ? "Time elapsed · added active time"
                  : "Remaining this half"}
              </Text>
              <Text style={typography.clock} testID="connected-match-countdown" accessibilityLiveRegion="none">
                {terminal ? formatTime(props.clock.matchActiveMs)
                  : props.match.status === "half_time" ? formatTime(props.match.firstHalfDurationMs ?? props.clock.halfActiveMs)
                  : props.match.half === 0 ? formatTime(props.match.config.plannedHalfDurationMs)
                  : props.clock.remainingMs === 0 ? `+${formatTime(props.clock.addedMs)}`
                  : formatTime(props.clock.remainingMs)}
              </Text>
              <Text style={typography.body}>
                {terminal ? "Recorded duration"
                  : props.match.status === "half_time" ? "Changes take effect when you start the second half."
                  : props.match.half === 0 ? "The clock starts when you confirm kickoff."
                  : `${formatTime(props.clock.halfActiveMs)} played this half`}
              </Text>
              {!terminal && !props.fillScreen && (
                <Text style={typography.muted}>
                  The countdown is a guide. Half-time and full-time always need
                  your confirmation; they do not happen automatically.
                </Text>
              )}
              {props.clock.recoveryRequired && (
                <Notice tone="warning">
                  Time needs checking. The saved checkpoint is retained; review
                  clock recovery above before recording another event.
                </Notice>
              )}
              {!props.fillScreen && clockActions}
              {!props.fillScreen && props.clockActionReview}
            </Card>);
  const openEvent = (kind: "goal" | "availability") => {
    if (!props.clock) return;
    setMode("live");
    setEventAction((previous) => ({ revision: (previous?.revision ?? 0) + 1, kind, effective: {
      half: props.match.half === 2 ? 2 : 1,
      halfElapsedMs: props.clock!.halfActiveMs,
      matchElapsedMs: props.clock!.matchActiveMs,
    } }));
    contentScroll.current?.scrollTo({ y: 0, animated: false });
  };
  return (
    <View style={[styles.stack, props.fillScreen && styles.fullScreen]}>
      {props.fillScreen && <ScrollView style={{ flexGrow: 0, maxHeight: activeMode === "live" ? "45%" : "30%" }} contentContainerStyle={{ gap: 8 }} testID="connected-match-fixed-summary">
        {props.header}
        {activeMode === "live" && scoreCard}
      </ScrollView>}
      <EditorContent fillScreen={props.fillScreen} scrollRef={contentScroll}>

      {(activeMode !== "live" || gate || storageError || saveError ||
        props.mode !== "fictional-review" && diagnostics?.wrongKeyProbe !== "passed") && <Card>
        <Text style={typography.section}>{teamLabel} · match day</Text>
        <Text style={typography.muted}>
          {activeMode === "attendance"
            ? "Confirm each player’s arrival before choosing the starting lineup."
            : "Review the players and places before confirming a change."}
        </Text>
        {gate && <Notice tone="warning">{gate}</Notice>}
        {(storageError || saveError) && (
          <Notice tone="error">{storageError || saveError}</Notice>
        )}
        {props.mode !== "fictional-review" &&
          diagnostics?.wrongKeyProbe !== "passed" && (
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
      </Card>}
      {props.clock && (
        <>
          <View style={styles.wrap}>
            {(["attendance", "lineup", "live"] as const).map((value) => (
              <Button
                key={value}
                testID={`connected-match-${value}`}
                label={
                  value === "attendance"
                    ? `Attendance · ${present.length}/${squad.length}`
                    : value === "lineup"
                      ? `Lineup${dirty ? " · draft" : ""}`
                      : "Live"
                }
                variant={activeMode === value ? "primary" : "secondary"}
                disabled={terminal && value !== "live"}
                onPress={() => setMode(value)}
                style={styles.tab}
              />
            ))}
          </View>
          {suggestedDraft && activeMode !== "lineup" && !terminal && (
            <Card>
              <Text style={typography.label}>
                Suggested lineup ready for review
              </Text>
              <Text style={typography.muted}>
                Opening the lineup screen does not change the players on the
                pitch.
              </Text>
              <Button
                label="Review suggested lineup"
                variant="secondary"
                onPress={() => setMode("lineup")}
              />
            </Card>
          )}
          {!terminal && (
            <Card style={activeMode !== "attendance" && styles.hidden}>
              <Text style={typography.section}>Actual match check-in</Text>
              <Text style={typography.muted}>
                Confirm each player on arrival. An availability reply is not
                attendance.
                {props.match.half > 0
                  ? " During play, this records attendance at the current confirmed active time. Earlier arrival time is not guessed, and a present player stays off the pitch until you confirm a lineup change."
                  : ""}
              </Text>
              {squad.map((player) => (
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
            <Card style={activeMode !== "lineup" && styles.hidden}>
              <Text style={typography.section}>
                {preparation
                  ? "Prepare the saved formation"
                  : "Review a lineup change"}
              </Text>
              {props.match.status === 'preparation' && reusableProposal && <View style={styles.stack}><Notice>Saved starting-lineup proposal. Actual check-in is still required; reviewing this draft never puts an absent player on the pitch.</Notice>{reusableProposalError && <Text style={typography.muted}>{reusableProposalError}</Text>}<Button label="Review saved starting lineup" disabled={busy || Boolean(reusableProposalError)} onPress={() => { try { const reviewed = reviewPreparedMatchPlanLineup(current.current.match); setLineupDraft({ matchId: current.current.match.config.matchId, ...reviewed }); setSelectedSlot(null); } catch (cause) { setSaveError(cause instanceof Error ? cause.message : 'The saved proposal is no longer applicable.'); } }} /></View>}
              <Text style={typography.muted}>
                {preparation
                  ? "Assign the actual present players to the saved places. Kickoff commits the staged lineup."
                  : "Draft a complete batch. Confirm only when the changes actually happen; the clock continues while you review."}
              </Text>
              <Button
                label={dirty ? "Replace draft with best-fit available players" : "Auto-fill available players"}
                testID="lineup-auto-fill"
                variant="secondary"
                disabled={busy || Boolean(props.clock?.recoveryRequired)}
                onPress={() => {
                  const match = current.current.match;
                  const result = autoFillMatchLineup(match);
                  if (result.status === 'infeasible') { setSaveError(result.reason); return; }
                  setLineupDraft({ matchId: match.config.matchId, sourceRevision: match.revision, lineup: result.allocations });
                  setSelectedSlot(null); setSaveError(null);
                }}
              />
              <Text style={typography.muted}>Auto-fill uses actual present, available players and their saved approved positions. It opens a draft for review; it does not record a change or start a half.</Text>
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
              <Pitch
                lineup={draft}
                players={props.match.config.players}
                initialsByPlayerId={initialsByPlayerId}
                slots={pitchSlots}
                formationName={`${props.match.config.pitchPlaces} places · ${dirty ? "unsaved draft" : preparation ? "staged lineup" : "confirmed lineup"}`}
                selectedSlot={selectedSlot}
                changedSlotIds={changedSlotIds}
                onSlotPress={busy ? undefined : setSelectedSlot}
              />
              <Text style={typography.muted}>
                Select a place on the pitch or use List view. A player can
                occupy one place at a time; review the whole batch before
                confirming.
              </Text>
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
          <View style={[styles.stack, activeMode !== "live" && styles.hidden]}>
            {!props.fillScreen && scoreCard}
            <LiveEventsPanel
              match={props.match}
              clock={props.clock}
              onCommand={record}
              busy={busy}
              teamLabel={teamLabel}
              hideActions={props.fillScreen}
              actionRequest={eventAction}
            />
            <Pitch
              lineup={savedLineup}
              players={props.match.config.players}
              initialsByPlayerId={initialsByPlayerId}
              slots={pitchSlots}
              formationName={`${props.match.config.pitchPlaces} places · ${preparation ? "staged for next start" : "confirmed on pitch"}`}
              compact
            />
            {!terminal && (
              <Card>
                <Text style={typography.section}>
                  {preparation
                    ? "Available off the staged lineup"
                    : "Available bench"}{" "}
                  · {availableBench.length}
                </Text>
                <View style={styles.wrap}>
                  {availableBench.map((player) => (
                    <Pill key={player.id} tone="muted">
                      {player.displayName}
                    </Pill>
                  ))}
                </View>
                {!availableBench.length && (
                  <Text style={typography.muted}>
                    No present, available players off this lineup.
                  </Text>
                )}
                {unavailable.length > 0 && (
                  <Text style={typography.muted}>
                    Unavailable:{" "}
                    {unavailable.map((player) => player.displayName).join(", ")}
                  </Text>
                )}
                <Button
                  label={
                    dirty
                      ? "Review unsaved lineup draft"
                      : "Prepare a lineup change"
                  }
                  variant="secondary"
                  onPress={() => setMode("lineup")}
                />
                <Text style={typography.label}>Next change</Text>
                <Text style={typography.muted}>
                  {suggestedDraft
                    ? "A selected suggestion is ready for your lineup review. It has not changed actual participation."
                    : "Open the planner above to review the current next-change projection. A suggestion never moves players automatically."}
                </Text>
              </Card>
            )}

          </View>
        </>
      )}
      {props.extraContent}
      </EditorContent>
      {props.fillScreen && props.clock && !terminal && <View style={styles.fixedRail} testID="connected-match-action-rail">
        <ScrollView style={{ maxHeight: 220 }} contentContainerStyle={styles.stack} keyboardShouldPersistTaps="handled">
          {props.clockActionReview}
          {clockActions}
          {!preparation && !terminal && <View style={styles.wrap}>
            <Button label="Record goal" testID="open-goal" style={[styles.action, styles.railButton]} disabled={busy || props.clock.recoveryRequired || props.match.status === "half_time"} onPress={() => openEvent("goal")} />
            <Button label="Substitute" testID="connected-open-substitute" icon="swap" variant="secondary" style={[styles.action, styles.railButton]} disabled={busy || props.clock.recoveryRequired} onPress={() => { setMode("lineup"); contentScroll.current?.scrollTo({ y: 0, animated: false }); }} />
            <Button label="Unavailable / return" testID="open-availability" variant="secondary" style={[styles.action, styles.railButton]} disabled={busy || props.clock.recoveryRequired} onPress={() => openEvent("availability")} />
          </View>}
        </ScrollView>
      </View>}
    </View>
  );
}
function EditorContent({ fillScreen, scrollRef, children }: { fillScreen?: boolean; scrollRef: RefObject<ScrollViewInstance | null>; children: ReactNode }) {
  return fillScreen ? <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ gap: 12, paddingBottom: 12 }} keyboardShouldPersistTaps="handled" testID="connected-match-content-scroll">{children}</ScrollView> : <View style={{ gap: 12 }}>{children}</View>;
}
const styles = StyleSheet.create({
  stack: { gap: 12 },
  fullScreen: { flex: 1, minHeight: 0, gap: 8 },
  fixedRail: { borderTopWidth: 1, borderColor: colors.border, paddingTop: 8, backgroundColor: colors.canvas },
  railButton: { minHeight: 48, paddingVertical: 6, paddingHorizontal: 8 },
  hidden: { display: "none" },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tab: { flexGrow: 1, flexBasis: 100 },
  action: { flexGrow: 1, flexBasis: 140 },
  scoreboard: { flexDirection: "row", alignItems: "center", gap: 12 },
  teamName: { flex: 1, textAlign: "center" },
  player: {
    borderTopWidth: 1,
    borderColor: colors.border,
    paddingTop: 12,
    gap: 8,
  },
});
