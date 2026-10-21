import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import {
  matchTimeline,
  type Allocation,
  type EffectiveMatchTime,
  type MatchState,
} from "@longball/domain";
import {
  participationEvidence,
  type ParticipationFact,
} from "@longball/domain/participation-corrections";
import {
  acknowledgeReconciliationProposal,
  assertReconciliationReview,
  createReconciliationReview,
  previewReconciliation,
  orderedReconciliationSubmissions,
  previewReviewedCommands,
  Q08_RECONCILIATION_POLICY,
  reconciliationRequest,
  retainReconciliationProposal,
  retainReconciliationRefusal,
  type ReconciliationPreview,
  type ReconciliationProposal,
  type ReconciliationProposalInput,
  type ReconciliationResolution,
  type ReconciliationReviewDocument,
  type ReconciliationSnapshot,
  type ReconciliationSubmission,
} from "@longball/application/reconciliation";
import {
  LongBallServiceClient,
  ServiceError,
  type ConnectedCommand,
} from "@longball/application/sync";
import type { Journal } from "../platform/types";
import { randomUUID } from "../platform/id";
import { useDocument } from "../useDocument";
import { Button, Card, Notice, Pill } from "../ui/Button";
import { colors, typography } from "../ui/tokens";

interface Props {
  match: MatchState;
  accepted: MatchState | null;
  eligible: boolean;
  busy: boolean;
  onCommand: (command: ConnectedCommand) => Promise<boolean>;
  client: LongBallServiceClient;
  journal: Journal | null;
  physicalDeviceId: string | null;
  documentId: string;
  verifyAuthority: () => Promise<void>;
  onAuthorityFailure: (error: unknown) => void;
}
interface Draft {
  sourceRevision: number;
  target: ParticipationFact | null;
  kind: "lineup.committed" | "availability.changed" | "goal.recorded";
  lineup: Allocation[];
  playerId: string;
  available: boolean;
  availabilityReason: "arrival" | "departure" | "injury" | "return" | "other";
  beneficiary: "us" | "opposition";
  scorerPlayerId: string | null;
  half: 1 | 2;
  time: string;
  reason: string;
  voided: boolean;
  restoreConfirmed: boolean;
}
function timeText(ms: number) {
  return `${Math.floor(ms / 60_000)}:${Math.floor(ms / 1000) % 60 < 10 ? "0" : ""}${Math.floor(ms / 1000) % 60}.${String(ms % 1000).padStart(3, "0")}`;
}
function parseTime(
  state: MatchState,
  half: 1 | 2,
  text: string,
): EffectiveMatchTime {
  const match = /^(\d{1,3}):([0-5]\d)(?:\.(\d{1,3}))?$/.exec(text.trim());
  if (!match)
    throw new Error("Enter actual active half time as MM:SS or MM:SS.mmm.");
  const halfElapsedMs =
    (Number(match[1]) * 60 + Number(match[2])) * 1000 +
    Number((match[3] ?? "").padEnd(3, "0"));
  if (half === 2 && state.firstHalfDurationMs === null)
    throw new Error(
      "Second-half evidence needs its recorded actual first-half duration.",
    );
  return {
    half,
    halfElapsedMs,
    matchElapsedMs:
      (half === 2 ? state.firstHalfDurationMs! : 0) + halfElapsedMs,
  };
}
function intent(state: MatchState, draft: Draft): ConnectedCommand {
  if (draft.sourceRevision !== state.revision)
    throw new Error(
      "This review is stale. Open the evidence again against the current revision.",
    );
  if (!draft.reason.trim())
    throw new Error(
      "Record the evidence and reason before previewing a correction.",
    );
  if (draft.target?.voided && !draft.voided && !draft.restoreConfirmed)
    throw new Error(
      "Explicitly acknowledge restoring this voided participation fact before previewing it.",
    );
  if (draft.target && draft.voided)
    return {
      type: "event.voided",
      targetEventId: draft.target.latestEventId,
      sourceRevision: draft.sourceRevision,
      reason: draft.reason.trim(),
    };
  const effective = parseTime(state, draft.half, draft.time);
  const details =
    draft.kind === "lineup.committed"
      ? {
          type: "lineup.committed" as const,
          lineup: draft.lineup.map((item) => ({ ...item })),
          effective,
        }
      : draft.kind === "availability.changed"
        ? {
            type: "availability.changed" as const,
            playerId: draft.playerId,
            available: draft.available,
            reason: draft.availabilityReason,
            effective,
          }
        : {
            type: "goal.recorded" as const,
            beneficiary: draft.beneficiary,
            scorerPlayerId: draft.scorerPlayerId,
            goalType: "not_recorded" as const,
            isOwnGoal: false,
            effective,
          };
  if (draft.target)
    return {
      type: "event.corrected",
      targetEventId: draft.target.latestEventId,
      sourceRevision: draft.sourceRevision,
      reason: draft.reason.trim(),
      restoreVoided: draft.target.voided && draft.restoreConfirmed,
      replacement: details,
    };
  if (details.type === "goal.recorded")
    return { ...details, lateEntryReason: draft.reason.trim() };
  return {
    ...details,
    sourceRevision: draft.sourceRevision,
    lateEntryReason: draft.reason.trim(),
  };
}
function makeDraft(
  state: MatchState,
  fact: ParticipationFact | null,
  kind: Draft["kind"] = "lineup.committed",
): Draft {
  const effective = fact?.effective;
  return {
    sourceRevision: state.revision,
    target: fact,
    kind: fact?.type === "availability.changed" ? fact.type : kind,
    lineup: (fact?.lineup ?? state.lineup).map((item) => ({ ...item })),
    playerId: fact?.playerId ?? "",
    available: fact?.available ?? false,
    availabilityReason: fact?.reason ?? "other",
    beneficiary: "us",
    scorerPlayerId: null,
    half: effective?.half ?? (state.half === 2 ? 2 : 1),
    time: effective ? timeText(effective.halfElapsedMs) : "",
    reason: "",
    voided: false,
    restoreConfirmed: false,
  };
}
function Preview({
  value,
  state,
}: {
  value: ReconciliationPreview;
  state: MatchState;
}) {
  return (
    <View style={styles.stack}>
      <Pill tone={value.valid ? "info" : "warning"}>
        {value.valid
          ? "VALIDATED PREVIEW · NOTHING APPLIED"
          : "REQUIRES REVIEW · NOTHING APPLIED"}
      </Pill>
      {value.issues.map((issue, index) => (
        <Notice key={index} tone="error">
          {issue}
        </Notice>
      ))}
      {value.after && (
        <>
          <Text style={typography.body}>
            Actual active time {timeText(value.before.matchActiveMs)} →{" "}
            {timeText(value.after.matchActiveMs)}. Score{" "}
            {value.before.score.for}–{value.before.score.against} →{" "}
            {value.after.score.for}–{value.after.score.against}.
          </Text>
          <Text style={typography.muted}>
            Occupied player milliseconds {value.before.occupiedPlayerMs} →{" "}
            {value.after.occupiedPlayerMs}. Vacant capacity{" "}
            {value.before.vacancyPlayerMs} → {value.after.vacancyPlayerMs}.
            Every selected player and position has been checked for exact
            active-time conservation.
          </Text>
          {value.after.playerMinutes
            .filter((after) => {
              const before = value.before.playerMinutes.find(
                (item) => item.playerId === after.playerId,
              );
              return JSON.stringify(before) !== JSON.stringify(after);
            })
            .map((after) => {
              const before = value.before.playerMinutes.find(
                (item) => item.playerId === after.playerId,
              )!;
              return (
                <Text key={after.playerId} style={typography.body}>
                  {state.config.players.find(
                    (player) => player.id === after.playerId,
                  )?.displayName ?? after.playerId}
                  : played {timeText(before.playingMs)} →{" "}
                  {timeText(after.playingMs)}; bench {timeText(before.benchMs)}{" "}
                  → {timeText(after.benchMs)}; unavailable{" "}
                  {timeText(before.unavailableMs)} →{" "}
                  {timeText(after.unavailableMs)}.
                </Text>
              );
            })}
          <Text style={typography.muted}>
            Original events, actual half lengths, saved profiles and the final
            whistle timestamp remain retained. Goals with contradictory scorer
            evidence must be corrected explicitly first. Awards and reminders
            are not replayed.
          </Text>
        </>
      )}
    </View>
  );
}

/** Mounted only inside the authorized, account/team/season-scoped controller cache. */
export function HistoryReviewPanel(props: Props) {
  const review = useDocument<ReconciliationReviewDocument>(
    props.journal,
    props.physicalDeviceId,
    `history-review.v1:${props.documentId}`,
    () => createReconciliationReview(props.match.config.matchId),
    assertReconciliationReview,
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftPurpose, setDraftPurpose] = useState<
    "accepted" | "reconciliation"
  >("accepted");
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    command: ConnectedCommand;
    value: ReconciliationPreview;
    sourceRevision: number;
  } | null>(null);
  const [proposalPreview, setProposalPreview] = useState<{
    input: ReconciliationProposalInput;
    value: ReconciliationPreview;
  } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [showAcceptedTimeline, setShowAcceptedTimeline] = useState(false);
  const [acceptedEventId, setAcceptedEventId] = useState<string | null>(null);
  const [resolution, setResolution] =
    useState<ReconciliationResolution>("retain_conflict");
  const [proposalReason, setProposalReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [networkBusy, setNetworkBusy] = useState(false);
  const lock = useRef(false);
  const active = useRef(props);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    active.current = props;
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, [props]);
  const assertCurrent = () => {
    if (
      !mounted.current ||
      active.current.client !== props.client ||
      active.current.documentId !== props.documentId
    )
      throw new Error(
        "The authorized review context changed. Reopen this same protected scope to retry the original proposal.",
      );
  };
  const evidence = useMemo(
    () => participationEvidence(props.match),
    [props.match],
  );
  const snapshot = review.state?.snapshot;
  const acceptedTimeline = useMemo(
    () => (props.accepted ? matchTimeline(props.accepted) : []),
    [props.accepted],
  );
  const orderedSources = useMemo(
    () => orderedReconciliationSubmissions(snapshot?.submissions ?? []),
    [snapshot],
  );
  const name = (id: string) =>
    props.match.config.players.find((player) => player.id === id)
      ?.displayName ?? id;
  const busy =
    props.busy ||
    networkBusy ||
    review.busy ||
    review.retryPending ||
    review.conflict;
  const edit = (change: Partial<Draft>) => {
    setDraft((previous) => (previous ? { ...previous, ...change } : null));
    setPreview(null);
    setProposalPreview(null);
  };
  const run = async (work: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setNetworkBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      props.onAuthorityFailure(failure);
      setError(
        failure instanceof Error
          ? failure.message
          : "The review was retained and not applied.",
      );
    } finally {
      lock.current = false;
      setNetworkBusy(false);
    }
  };
  const retryProposal = async (document: ReconciliationReviewDocument) => {
    await props.verifyAuthority();
    assertCurrent();
    try {
      const receipt = await props.client.execute<ReconciliationProposal>(
        reconciliationRequest(document),
        null,
      );
      assertCurrent();
      await props.verifyAuthority();
      assertCurrent();
      const saved = await review.change(
        (current) => acknowledgeReconciliationProposal(current, receipt),
        "history.proposal.receipt.saved",
      );
      if (saved)
        setNotice(
          "Immutable proposal saved by the service and receipt retained on this device. No history was reconciled or applied.",
        );
    } catch (failure) {
      assertCurrent();
      if (
        failure instanceof ServiceError &&
        [
          "RECONCILIATION_PREVIEW_REJECTED",
          "RECONCILIATION_PROPOSAL_CONFLICT",
          "STALE_REVISION",
          "INVALID_REQUEST",
          "CONTRACT_VERSION_REQUIRED",
        ].includes(failure.code) &&
        !failure.retryable
      )
        await review.change(
          (current) =>
            retainReconciliationRefusal(
              current,
              failure,
              new Date().toISOString(),
            ),
          "history.proposal.refusal.retained",
        );
      throw failure;
    }
  };
  const openFact = (fact: ParticipationFact) => {
    setDraftPurpose("accepted");
    setDraft(makeDraft(props.match, fact));
    setPreview(null);
    setProposalPreview(null);
    setError(null);
  };
  const template = (submission: ReconciliationSubmission) => {
    const value =
      submission.original && typeof submission.original === "object"
        ? (submission.original as {
            command?: unknown;
            envelope_json?: unknown;
          })
        : {};
    let candidate: unknown = value.command;
    if (!candidate && typeof value.envelope_json === "string") {
      try {
        candidate = (JSON.parse(value.envelope_json) as { command?: unknown })
          .command;
      } catch {
        /* Retain unparseable evidence for manual review. */
      }
    }
    const type =
      candidate && typeof candidate === "object" && "type" in candidate
        ? candidate.type
        : null;
    if (
      type !== "lineup.committed" &&
      type !== "availability.changed" &&
      type !== "goal.recorded"
    )
      throw new Error(
        "This source contains clock/control or unsupported evidence. Review it separately; no command or clock is inferred.",
      );
    // Only choose the command family. Actual time, player and allocations must be deliberately reviewed.
    setDraftPurpose("reconciliation");
    setDraft(makeDraft(props.accepted ?? props.match, null, type));
    setPreview(null);
    setProposalPreview(null);
    setNotice(
      "A blank reviewed intent is open. Source bytes stay read-only. Enter actual time, allocation/player and evidence before previewing an import proposal.",
    );
  };
  return (
    <Card>
      <Text style={typography.section}>
        History corrections and reconciliation
      </Text>
      <Text style={typography.body}>
        Review actual recorded evidence. Corrections append a compensating
        event; the original remains available for audit. Contradictory
        old-device histories need a separate immutable proposal.
      </Text>
      {(error || review.error) && (
        <Notice tone="error">{error || review.error}</Notice>
      )}
      {notice && <Notice>{notice}</Notice>}
      {review.retryPending && (
        <Button
          label="Retry history review local save"
          onPress={() => {
            void review.retry();
          }}
        />
      )}
      {review.conflict && (
        <Button
          label="Reload history review; retain conflicting proposal"
          onPress={review.reload}
        />
      )}
      <Text style={typography.label}>
        Accepted-history participation evidence
      </Text>
      {evidence.length === 0 && (
        <Text style={typography.muted}>
          No recorded substitution or availability event to correct yet.
        </Text>
      )}
      {evidence.map((fact) => (
        <Button
          key={fact.eventId}
          label={`Review ${fact.type === "lineup.committed" ? "substitution" : name(fact.playerId!)} · H${fact.effective?.half ?? 0} ${timeText(fact.effective?.halfElapsedMs ?? 0)}${fact.voided ? " · voided" : ""}`}
          testID={`history-fact-${fact.eventId}`}
          variant="secondary"
          disabled={busy}
          onPress={() => openFact(fact)}
        />
      ))}
      <View style={styles.row}>
        <Button
          label="Review missed substitution"
          testID="history-missing-lineup"
          variant="secondary"
          disabled={busy || !props.eligible || props.match.half === 0}
          onPress={() => {
            setDraftPurpose("accepted");
            setDraft(makeDraft(props.match, null, "lineup.committed"));
            setPreview(null);
            setProposalPreview(null);
          }}
        />
        <Button
          label="Review missed availability change"
          variant="secondary"
          disabled={busy || !props.eligible || props.match.half === 0}
          onPress={() => {
            setDraftPurpose("accepted");
            setDraft(makeDraft(props.match, null, "availability.changed"));
            setPreview(null);
            setProposalPreview(null);
          }}
        />
      </View>
      {draft && (
        <View style={styles.stack}>
          <Text style={typography.label}>
            {draft.target
              ? `Correct recorded ${draft.kind}`
              : `Propose missing ${draft.kind}`}{" "}
            · reviewed revision {draft.sourceRevision}
          </Text>
          {draft.sourceRevision !==
            (draftPurpose === "accepted"
              ? props.match.revision
              : (props.accepted?.revision ?? props.match.revision)) && (
            <Notice tone="warning">
              Current history changed. Reopen the evidence before applying this
              draft.
            </Notice>
          )}
          {draft.target?.voided && (
            <>
              <Notice tone="warning">
                This fact is currently voided. A corrected replacement restores
                its effect on participation; the original void remains in the
                audit.
              </Notice>
              <Button
                label={
                  draft.restoreConfirmed
                    ? "Restore voided participation fact · acknowledged"
                    : "Acknowledge restoring this voided participation fact"
                }
                variant="secondary"
                onPress={() =>
                  edit({ restoreConfirmed: !draft.restoreConfirmed })
                }
              />
            </>
          )}
          {draft.target && !draft.target.voided && (
            <Button
              label={
                draft.voided
                  ? "Void selected · review reason below"
                  : "Void this event instead"
              }
              variant={draft.voided ? "danger" : "secondary"}
              disabled={busy}
              onPress={() => edit({ voided: !draft.voided })}
            />
          )}
          {!draft.voided && (
            <>
              {!draft.target && (
                <View style={styles.row}>
                  {([1, 2] as const).map((half) => (
                    <Button
                      key={half}
                      label={`Half ${half}${draft.half === half ? " · selected" : ""}`}
                      variant={draft.half === half ? "primary" : "secondary"}
                      onPress={() => edit({ half })}
                    />
                  ))}
                </View>
              )}
              <TextInput
                accessibilityLabel="History actual active half time"
                testID="history-effective-time"
                value={draft.time}
                onChangeText={(time) => edit({ time })}
                placeholder="Actual active MM:SS.mmm"
                keyboardType="numbers-and-punctuation"
                style={styles.input}
              />
              {draft.kind === "lineup.committed" && (
                <>
                  <Text style={typography.muted}>
                    Select a saved slot, then the player who actually occupied
                    it. Selecting an already allocated player swaps the two
                    places. Eligibility is checked against this match’s saved
                    profiles.
                  </Text>
                  <View style={styles.row}>
                    {draft.lineup.map((item) => (
                      <Button
                        key={item.slotId}
                        testID={`history-slot-${item.slotId}`}
                        label={`${item.position}: ${name(item.playerId)}`}
                        variant={
                          selectedSlot === item.slotId ? "primary" : "secondary"
                        }
                        onPress={() => setSelectedSlot(item.slotId)}
                      />
                    ))}
                  </View>
                  {selectedSlot && (
                    <View style={styles.row}>
                      {props.match.config.selectedPlayerIds.map((playerId) => (
                        <Button
                          key={playerId}
                          testID={`history-player-${playerId}`}
                          label={name(playerId)}
                          variant="secondary"
                          onPress={() => {
                            const former = draft.lineup.find(
                              (item) => item.slotId === selectedSlot,
                            )?.playerId;
                            edit({
                              lineup: draft.lineup.map((item) =>
                                item.slotId === selectedSlot
                                  ? { ...item, playerId }
                                  : item.playerId === playerId && former
                                    ? { ...item, playerId: former }
                                    : item,
                              ),
                            });
                            setSelectedSlot(null);
                          }}
                        />
                      ))}
                    </View>
                  )}
                </>
              )}
              {draft.kind === "availability.changed" && (
                <>
                  {!draft.target && (
                    <View style={styles.row}>
                      {props.match.config.selectedPlayerIds.map((playerId) => (
                        <Button
                          key={playerId}
                          label={`${name(playerId)}${draft.playerId === playerId ? " · selected" : ""}`}
                          variant={
                            draft.playerId === playerId
                              ? "primary"
                              : "secondary"
                          }
                          onPress={() => edit({ playerId })}
                        />
                      ))}
                    </View>
                  )}
                  <View style={styles.row}>
                    <Button
                      label="Confirmed available"
                      variant={draft.available ? "primary" : "secondary"}
                      onPress={() => edit({ available: true })}
                    />
                    <Button
                      label="Confirmed unavailable"
                      variant={!draft.available ? "primary" : "secondary"}
                      onPress={() => edit({ available: false })}
                    />
                  </View>
                  <View style={styles.row}>
                    {(
                      [
                        "arrival",
                        "departure",
                        "injury",
                        "return",
                        "other",
                      ] as const
                    ).map((availabilityReason) => (
                      <Button
                        key={availabilityReason}
                        label={`${availabilityReason}${draft.availabilityReason === availabilityReason ? " · selected" : ""}`}
                        variant="secondary"
                        onPress={() => edit({ availabilityReason })}
                      />
                    ))}
                  </View>
                  <Text style={typography.muted}>
                    An availability return does not put a player on the pitch
                    automatically. Genuine vacancies remain visible; a separate
                    reviewed allocation records an actual replacement.
                  </Text>
                </>
              )}
              {draft.kind === "goal.recorded" && (
                <>
                  <View style={styles.row}>
                    <Button
                      label="Team goal"
                      onPress={() => edit({ beneficiary: "us" })}
                      variant={
                        draft.beneficiary === "us" ? "primary" : "secondary"
                      }
                    />
                    <Button
                      label="Opposition goal"
                      onPress={() =>
                        edit({
                          beneficiary: "opposition",
                          scorerPlayerId: null,
                        })
                      }
                      variant={
                        draft.beneficiary === "opposition"
                          ? "primary"
                          : "secondary"
                      }
                    />
                  </View>
                  <Button
                    label="Scorer not recorded"
                    variant={
                      draft.scorerPlayerId === null ? "primary" : "secondary"
                    }
                    onPress={() => edit({ scorerPlayerId: null })}
                  />
                  {draft.beneficiary === "us" && (
                    <View style={styles.row}>
                      {props.match.config.selectedPlayerIds.map(
                        (scorerPlayerId) => (
                          <Button
                            key={scorerPlayerId}
                            label={name(scorerPlayerId)}
                            variant={
                              draft.scorerPlayerId === scorerPlayerId
                                ? "primary"
                                : "secondary"
                            }
                            onPress={() => edit({ scorerPlayerId })}
                          />
                        ),
                      )}
                    </View>
                  )}
                </>
              )}
            </>
          )}
          <TextInput
            accessibilityLabel="History evidence and correction reason"
            testID="history-evidence-reason"
            value={draft.reason}
            onChangeText={(reason) => edit({ reason })}
            multiline
            placeholder="What actually happened, and the evidence for this change"
            style={styles.input}
          />
          {draftPurpose === "accepted" && (
            <Button
              label="Validate participation correction"
              testID="history-preview"
              disabled={busy}
              onPress={() => {
                void run(async () => {
                  const command = intent(props.match, draft),
                    value = previewReviewedCommands(props.match, [command], {
                      previewId: randomUUID(),
                      actorId: "preview-only-current-manager",
                      recordedAtMs: Date.now(),
                    });
                  setPreview({
                    command,
                    value,
                    sourceRevision: props.match.revision,
                  });
                });
              }}
            />
          )}
          {preview && (
            <>
              <Preview value={preview.value} state={props.match} />
              <Button
                label="Confirm audited history correction"
                testID="history-confirm"
                disabled={
                  busy ||
                  !props.eligible ||
                  !preview.value.valid ||
                  preview.sourceRevision !== props.match.revision
                }
                onPress={() => {
                  void run(async () => {
                    if (preview.sourceRevision !== props.match.revision)
                      throw new Error("The preview is stale. Review again.");
                    if (await props.onCommand(preview.command)) {
                      setPreview(null);
                      setDraft(null);
                      setNotice(
                        "Compensating event saved to the canonical outbox. Original evidence remains retained; service acknowledgement is still required.",
                      );
                    }
                  });
                }}
              />
            </>
          )}
          <Button
            label="Close history draft"
            variant="quiet"
            onPress={() => {
              setDraft(null);
              setPreview(null);
              setProposalPreview(null);
            }}
          />
        </View>
      )}
      <Button
        label={
          showAcceptedTimeline
            ? "Hide accepted event timeline"
            : "Compare accepted event timeline"
        }
        testID="history-accepted-timeline"
        variant="secondary"
        onPress={() => setShowAcceptedTimeline((value) => !value)}
      />
      {showAcceptedTimeline && (
        <View style={styles.stack}>
          <Text style={typography.label}>
            Accepted revision {props.accepted?.revision ?? "not downloaded"} ·
            effective order / original entry revision
          </Text>
          {acceptedTimeline.map((item) => (
            <View key={item.eventId} style={styles.stack}>
              <Button
                variant="secondary"
                label={`H${item.effective?.half ?? 0} ${timeText(item.effective?.halfElapsedMs ?? 0)} · ${item.type} · revision ${item.revision}`}
                onPress={() =>
                  setAcceptedEventId((previous) =>
                    previous === item.eventId ? null : item.eventId,
                  )
                }
              />
              {acceptedEventId === item.eventId && (
                <Text selectable style={typography.muted}>
                  Actor {item.actorId ?? "not recorded"} · entered{" "}
                  {new Date(item.recordedAtMs).toISOString()}
                  {"\n"}Event {item.eventId}
                  {item.targetEventId
                    ? `\nCompensates ${item.targetEventId}`
                    : ""}
                  {item.reason ? `\nReason: ${item.reason}` : ""}
                  {"\n"}
                  {JSON.stringify(
                    props.accepted?.eventHistory?.find(
                      (event) => event.id === item.eventId,
                    ),
                    null,
                    2,
                  )}
                </Text>
              )}
            </View>
          ))}
        </View>
      )}
      <Text style={typography.label}>
        Contradictory device submissions · ME53
      </Text>
      <Button
        label="Download ordered reconciliation evidence"
        testID="reconciliation-download"
        variant="secondary"
        disabled={busy || !review.state}
        onPress={() => {
          void run(async () => {
            await props.verifyAuthority();
            const downloaded =
              await props.client.request<ReconciliationSnapshot>(
                `/v1/matches/${encodeURIComponent(props.match.config.matchId)}/reconciliation`,
              );
            assertCurrent();
            await props.verifyAuthority();
            assertCurrent();
            if (downloaded.matchId !== props.match.config.matchId)
              throw new Error(
                "Reconciliation evidence belongs to another match.",
              );
            if (
              await review.change(
                (current) => ({ ...current, snapshot: downloaded }),
                "history.evidence.downloaded",
              )
            )
              setNotice(
                "Ordered service submissions and immutable proposals downloaded. No branch was merged.",
              );
          });
        }}
      />
      <Notice tone="warning">
        {snapshot?.policy.decisionRequired ??
          Q08_RECONCILIATION_POLICY.decisionRequired}{" "}
        Preparing a proposal does not approve this decision or clear quarantine.
      </Notice>
      {snapshot && (
        <>
          <Text style={typography.body}>
            Accepted revision {snapshot.acceptedRevision} ·{" "}
            {snapshot.submissions.length} original submissions ·{" "}
            {snapshot.proposals.length} proposals · authority policy{" "}
            {snapshot.policy.status}.
          </Text>
          {orderedSources.map((item) => (
            <View key={item.submissionId} style={styles.stack}>
              <Button
                label={`${selected.includes(item.submissionId) ? "Selected · " : ""}${item.deviceId ?? "conflicting stream"} / seq ${item.clientSequence ?? "?"} / epoch ${item.controllerEpoch ?? "?"} · ${item.reason}`}
                testID={`reconciliation-source-${item.submissionId}`}
                variant={
                  selected.includes(item.submissionId) ? "primary" : "secondary"
                }
                disabled={busy}
                onPress={() => {
                  setSelected((previous) =>
                    previous.includes(item.submissionId)
                      ? previous.filter((id) => id !== item.submissionId)
                      : [...previous, item.submissionId],
                  );
                  setProposalPreview(null);
                }}
              />
              {selected.includes(item.submissionId) && (
                <>
                  <Text selectable style={typography.muted}>
                    Original digest{" "}
                    {item.originalDigest.match(/.{1,16}/g)?.join(" ")}
                    {"\n"}
                    {JSON.stringify(item.original, null, 2)}
                  </Text>
                  <Button
                    label="Open blank import review for this event family"
                    variant="secondary"
                    onPress={() => {
                      void run(async () => template(item));
                    }}
                  />
                </>
              )}
            </View>
          ))}
          <View style={styles.row}>
            {(
              [
                ["retain_conflict", "Retain disputed"],
                ["duplicate", "Propose duplicate"],
                ["import_confirmed_events", "Propose verified import"],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                label={`${label}${resolution === value ? " · selected" : ""}`}
                variant={resolution === value ? "primary" : "secondary"}
                onPress={() => {
                  setResolution(value);
                  setProposalPreview(null);
                }}
              />
            ))}
          </View>
          <TextInput
            accessibilityLabel="Reconciliation proposal evidence reason"
            testID="reconciliation-reason"
            value={proposalReason}
            onChangeText={(value) => {
              setProposalReason(value);
              setProposalPreview(null);
            }}
            multiline
            placeholder="Why these sources support the proposed disposition"
            style={styles.input}
          />
          <Button
            label="Validate immutable reconciliation proposal"
            testID="reconciliation-preview"
            disabled={busy || selected.length === 0 || !props.accepted}
            onPress={() => {
              void run(async () => {
                if (!props.accepted)
                  throw new Error(
                    "Download the accepted canonical checkpoint first.",
                  );
                const input: ReconciliationProposalInput = {
                  proposalId: randomUUID(),
                  baseRevision: props.accepted.revision,
                  sourceSubmissionIds: [...selected],
                  reason: proposalReason.trim(),
                  resolution,
                  commands:
                    resolution === "import_confirmed_events"
                      ? [
                          draft &&
                          !draft.target &&
                          draftPurpose === "reconciliation"
                            ? intent(props.accepted, draft)
                            : (() => {
                                throw new Error(
                                  "Open and complete an explicit missing-event review first.",
                                );
                              })(),
                        ]
                      : [],
                };
                setProposalPreview({
                  input,
                  value: previewReconciliation(
                    props.accepted,
                    input,
                    snapshot.submissions,
                    {
                      actorId: "preview-only-current-manager",
                      recordedAtMs: Date.now(),
                    },
                  ),
                });
              });
            }}
          />
          {proposalPreview && (
            <>
              <Preview value={proposalPreview.value} state={props.match} />
              <Button
                label="Save proposal for authorised review"
                testID="reconciliation-save"
                disabled={
                  busy ||
                  !proposalPreview.value.valid ||
                  !review.state ||
                  Boolean(review.state.pending) ||
                  proposalPreview.input.baseRevision !==
                    props.accepted?.revision
                }
                onPress={() => {
                  void run(async () => {
                    let prepared: ReconciliationReviewDocument | null = null;
                    const saved = await review.change((current) => {
                      prepared = retainReconciliationProposal(
                        current,
                        proposalPreview.input,
                        randomUUID(),
                      );
                      return prepared;
                    }, "history.proposal.retained");
                    if (saved && prepared) await retryProposal(prepared);
                  });
                }}
              />
            </>
          )}
          {snapshot.proposals.map((item) => (
            <Notice key={item.input.proposalId}>
              Proposal {item.input.proposalId}: {item.input.resolution} ·{" "}
              {item.status} · actor {item.actorId} · revision{" "}
              {item.input.baseRevision}. {item.input.reason}
            </Notice>
          ))}
        </>
      )}
      {review.state?.pending && (
        <Button
          label="Retry exact reconciliation proposal"
          testID="reconciliation-retry"
          disabled={busy}
          onPress={() => {
            const current = review.state;
            if (current) void run(() => retryProposal(current));
          }}
        />
      )}
      {(review.state?.refusals ?? []).map((item) => (
        <Notice key={item.request.idempotencyKey} tone="warning">
          Proposal {item.request.input.proposalId} was refused: {item.code}. The
          original key and evidence remain retained. Open a new review against
          the current accepted revision.
        </Notice>
      ))}
      {(review.state?.receipts ?? []).map((item) => (
        <Notice key={item.input.proposalId}>
          Saved proposal {item.input.proposalId} · {item.status}.{" "}
          {item.status === "prepared"
            ? "No accepted history or quarantine disposition has changed."
            : `Applied revision ${item.appliedRevision}.`}
        </Notice>
      ))}
      <Text style={typography.muted}>
        Changing historical half lengths, clock continuity or control authority
        is not inferred by this review. Those cases retain the original evidence
        and require a trustworthy clock/both-half review. Proposal IDs and
        retries do not allocate canonical event sequence numbers.
      </Text>
    </Card>
  );
}
const styles = StyleSheet.create({
  stack: { gap: 12 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.controlBorder,
    borderRadius: 8,
    padding: 12,
    backgroundColor: colors.surface,
    color: colors.ink,
    fontSize: 16,
  },
});
