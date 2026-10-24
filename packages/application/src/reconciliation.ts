import {
  playerMinutes,
  reduceMatch,
  type ClockSample,
  type MatchState,
  type PlayerMinutes,
} from "../../domain/src/index";
import type { ConnectedCommand, DurableRequest, WireEvent } from "./sync";

export const Q08_RECONCILIATION_POLICY = {
  status: "unapproved" as const,
  policyId: "q08-reconciliation-authority-unapproved",
  decisionRequired:
    "Confirm who may approve unresolved history reconciliation: importing old-device evidence, marking submissions duplicate, or retaining a disputed history. Define the reviewer authority and required evidence; assigned-manager access alone does not approve this policy.",
};
export interface ReconciliationPolicy {
  status: "unapproved" | "approved";
  policyId: string;
  decisionRequired: string | null;
}
export interface ReconciliationSubmission {
  submissionId: string;
  matchId: string;
  eventId: string | null;
  deviceId: string | null;
  clientSequence: number | null;
  controllerEpoch: number | null;
  reason: string;
  original: unknown;
  originalDigest: string;
  receivedAt: string;
}
export type ReconciliationResolution =
  | "duplicate"
  | "retain_conflict"
  | "import_confirmed_events";
/** Commands are deliberate reviewed intents. They are never blindly copied from an old stream. */
export interface ReconciliationProposalInput {
  proposalId: string;
  baseRevision: number;
  sourceSubmissionIds: string[];
  reason: string;
  resolution: ReconciliationResolution;
  commands: ConnectedCommand[];
}
export interface ReconciliationSummary {
  revision: number;
  status: MatchState["status"];
  half: 0 | 1 | 2;
  halfActiveMs: number;
  matchActiveMs: number;
  firstHalfDurationMs: number | null;
  score: { for: number; against: number };
  halfTimeScore: { for: number; against: number } | null;
  playerMinutes: PlayerMinutes[];
  occupiedPlayerMs: number;
  capacityPlayerMs: number;
  vacancyPlayerMs: number;
}
export interface ReconciliationPreview {
  valid: boolean;
  issues: string[];
  before: ReconciliationSummary;
  after: ReconciliationSummary | null;
  earliestAffected: {
    half: 1 | 2;
    halfElapsedMs: number;
    matchElapsedMs: number;
  } | null;
  /** An ephemeral reducer projection, not an accepted stream or clock measurement. */
  projectedState: MatchState | null;
}
export interface ReconciliationProposal {
  input: ReconciliationProposalInput;
  matchId: string;
  actorId: string;
  createdAt: string;
  sourceDigests: { submissionId: string; originalDigest: string }[];
  acceptedStateDigest: string;
  preview: Omit<ReconciliationPreview, "projectedState">;
  status: "prepared" | "applied";
  appliedRevision: number | null;
}
export interface ReconciliationSnapshot {
  matchId: string;
  acceptedRevision: number;
  submissions: ReconciliationSubmission[];
  proposals: ReconciliationProposal[];
  policy: ReconciliationPolicy;
}
/** Policy approval is server configuration. This input cannot nominate its own approver. */
export interface ReconciliationApplyInput {
  proposalId: string;
  expectedRevision: number;
  events: WireEvent[];
}
const identifier = /^[a-zA-Z0-9_-]{1,120}$/;
export function canonicalReviewJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalReviewJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${canonicalReviewJson(item)}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
function checkpointSample(
  state: MatchState,
  recordedAtMs: number,
): ClockSample {
  // A running anchor is sampled at its exact recorded checkpoint: zero added time.
  return state.anchor
    ? { ...state.anchor.sample }
    : {
        monotonicMs: 0,
        sessionId: "review-preview-only",
        wallTimeMs: recordedAtMs,
      };
}
export function reconciliationSummary(
  state: MatchState,
): ReconciliationSummary {
  const minutes = playerMinutes(state, checkpointSample(state, 0));
  const occupiedPlayerMs = minutes.reduce(
    (sum, item) => sum + item.playingMs,
    0,
  );
  const capacityPlayerMs = state.config.pitchPlaces * state.matchActiveMs;
  return {
    revision: state.revision,
    status: state.status,
    half: state.half,
    halfActiveMs: state.halfActiveMs,
    matchActiveMs: state.matchActiveMs,
    firstHalfDurationMs: state.firstHalfDurationMs,
    score: { ...state.score },
    halfTimeScore: state.halfTimeScore ? { ...state.halfTimeScore } : null,
    playerMinutes: minutes,
    occupiedPlayerMs,
    capacityPlayerMs,
    vacancyPlayerMs: capacityPlayerMs - occupiedPlayerMs,
  };
}
/** Validate conservation from materialised evidence, including legitimate vacant places. */
export function assertParticipationConservation(state: MatchState): void {
  const selected = new Set(state.config.selectedPlayerIds);
  const firstEnd =
    state.firstHalfDurationMs ?? (state.half === 1 ? state.matchActiveMs : 0);
  for (const interval of state.intervals) {
    if (
      !selected.has(interval.playerId) ||
      !Number.isSafeInteger(interval.startMs) ||
      !Number.isSafeInteger(interval.endMs) ||
      interval.startMs < 0 ||
      interval.endMs <= interval.startMs ||
      interval.endMs > state.matchActiveMs ||
      (interval.half === 1 && interval.endMs > firstEnd) ||
      (interval.half === 2 && interval.startMs < firstEnd)
    )
      throw new Error(
        "Participation contains invalid coordinates, identity or half boundaries.",
      );
    if (
      (interval.state === "playing") !==
      Boolean(interval.position && interval.slotId)
    )
      throw new Error(
        "Playing intervals need one saved position and occupied slot; bench/unavailable intervals cannot occupy a place.",
      );
  }
  for (const playerId of selected) {
    const intervals = state.intervals
      .filter((item) => item.playerId === playerId)
      .sort((a, b) => a.startMs - b.startMs || a.half - b.half);
    let end = 0;
    for (const interval of intervals) {
      if (interval.startMs !== end)
        throw new Error(
          `Participation for ${playerId} has an overlap or uncovered active time.`,
        );
      end = interval.endMs;
    }
    if (end !== state.matchActiveMs)
      throw new Error(
        `Participation for ${playerId} does not partition the actual match time.`,
      );
  }
  const boundaries = [
    ...new Set([
      0,
      state.matchActiveMs,
      ...state.intervals.flatMap((item) => [item.startMs, item.endMs]),
    ]),
  ].sort((a, b) => a - b);
  for (let index = 0; index + 1 < boundaries.length; index++) {
    const active = state.intervals.filter(
      (item) =>
        item.state === "playing" &&
        item.startMs <= boundaries[index] &&
        item.endMs >= boundaries[index + 1],
    );
    if (
      active.length > state.config.pitchPlaces ||
      new Set(active.map((item) => item.slotId)).size !== active.length ||
      new Set(active.map((item) => item.playerId)).size !== active.length
    )
      throw new Error(
        "Participation occupies a player/slot twice or exceeds pitch capacity.",
      );
  }
  const summary = reconciliationSummary(state);
  if (
    summary.vacancyPlayerMs < 0 ||
    summary.playerMinutes.some(
      (item) =>
        item.playingMs + item.benchMs + item.unavailableMs !==
          state.matchActiveMs ||
        Object.values(item.positionMs).reduce(
          (sum, value) => sum + value,
          0,
        ) !== item.playingMs,
    )
  )
    throw new Error(
      "Player/position participation totals do not conserve active time.",
    );
  if (
    state.targetIntervals.reduce((sum, item) => sum + item.durationMs, 0) !==
    state.matchActiveMs
  )
    throw new Error(
      "Availability target intervals do not partition the actual match time.",
    );
}
function validateCommandIntent(command: ConnectedCommand): void {
  if (
    !command ||
    typeof command !== "object" ||
    [
      "id",
      "sample",
      "actorId",
      "controllerEpoch",
      "clientSequence",
      "controllerToken",
    ].some((field) => field in command)
  )
    throw new Error(
      "Reviewed command intents cannot supply identity, clock evidence or controller authority.",
    );
  if (
    command.type === "goal.recorded" ||
    command.type === "availability.changed" ||
    command.type === "lineup.committed"
  ) {
    if (!command.effective || !command.lateEntryReason?.trim())
      throw new Error(
        "Import each historical event with an explicit active-time boundary and late-entry evidence reason.",
      );
    if (
      command.type !== "goal.recorded" &&
      command.sourceRevision === undefined
    )
      throw new Error(
        "Historical participation imports need the exact reviewed source revision.",
      );
  } else if (!["event.corrected", "event.voided"].includes(command.type))
    throw new Error(
      "Clock, half, attendance and controller transitions need a separate evidence review. No time or authority is inferred from a quarantined device.",
    );
}
/** Preview-only identifiers never consume device sequence numbers or become wire events. */
export function previewReviewedCommands(
  state: MatchState,
  commands: ConnectedCommand[],
  context: { previewId: string; actorId: string; recordedAtMs: number },
): ReconciliationPreview {
  const before = reconciliationSummary(state),
    issues: string[] = [];
  let projected = state;
  let earliestAffected: ReconciliationPreview["earliestAffected"] = null;
  if (
    !identifier.test(context.previewId) ||
    !context.actorId ||
    !Number.isSafeInteger(context.recordedAtMs) ||
    context.recordedAtMs < 0
  )
    issues.push(
      "Preview context requires a bounded ID, verified actor and valid entry timestamp.",
    );
  if (!Array.isArray(commands) || commands.length < 1 || commands.length > 100)
    issues.push("Review between1 and100 explicit commands.");
  if (issues.length)
    return {
      valid: false,
      issues,
      before,
      after: null,
      earliestAffected,
      projectedState: null,
    };
  try {
    assertParticipationConservation(state);
    for (const [index, command] of commands.entries()) {
      validateCommandIntent(command);
      const event = {
        ...command,
        id: `${context.previewId}-preview-${index}`,
        sample: checkpointSample(projected, context.recordedAtMs),
        actorId: context.actorId,
      };
      projected = reduceMatch(projected, event);
      const boundary = projected.audit?.at(-1)?.effective;
      const auditValue = projected.audit?.at(-1)?.value as
        | { earliestAffected?: ReconciliationPreview["earliestAffected"] }
        | undefined;
      const affected = auditValue?.earliestAffected ?? boundary;
      if (
        affected &&
        (!earliestAffected ||
          affected.matchElapsedMs < earliestAffected.matchElapsedMs)
      )
        earliestAffected = affected;
      assertParticipationConservation(projected);
    }
    if (
      projected.matchActiveMs !== state.matchActiveMs ||
      projected.halfActiveMs !== state.halfActiveMs ||
      projected.half !== state.half ||
      projected.firstHalfDurationMs !== state.firstHalfDurationMs ||
      projected.status !== state.status ||
      projected.completedAtMs !== state.completedAtMs ||
      canonicalReviewJson(projected.config) !==
        canonicalReviewJson(state.config)
    )
      throw new Error(
        "A history proposal cannot change the current clock, actual half lengths, lifecycle, completion anchor or immutable match preparation.",
      );
    return {
      valid: true,
      issues: [],
      before,
      after: reconciliationSummary(projected),
      earliestAffected,
      projectedState: projected,
    };
  } catch (error) {
    issues.push(
      error instanceof Error
        ? error.message
        : "The proposed history could not be validated.",
    );
  }
  return {
    valid: false,
    issues,
    before,
    after: null,
    earliestAffected,
    projectedState: null,
  };
}
export function previewReconciliation(
  state: MatchState,
  input: ReconciliationProposalInput,
  submissions: ReconciliationSubmission[],
  context: { actorId: string; recordedAtMs: number },
): ReconciliationPreview {
  const before = reconciliationSummary(state),
    issues: string[] = [];
  if (!input || typeof input !== "object")
    return {
      valid: false,
      issues: ["A typed immutable proposal is required."],
      before,
      after: null,
      earliestAffected: null,
      projectedState: null,
    };
  if (
    !identifier.test(input.proposalId) ||
    !Number.isSafeInteger(input.baseRevision) ||
    input.baseRevision !== state.revision
  )
    issues.push(
      "The proposal ID or reviewed accepted revision is invalid/stale. Download and review again without rebasing the proposal silently.",
    );
  if (
    typeof input.reason !== "string" ||
    !input.reason.trim() ||
    input.reason.length > 500
  )
    issues.push("Record an evidence reason of1–500 characters.");
  if (
    !Array.isArray(input.sourceSubmissionIds) ||
    input.sourceSubmissionIds.length < 1 ||
    input.sourceSubmissionIds.length > 100 ||
    new Set(input.sourceSubmissionIds).size !==
      input.sourceSubmissionIds.length ||
    input.sourceSubmissionIds.some(
      (id) =>
        !submissions.some(
          (item) =>
            item.submissionId === id &&
            item.matchId === state.config.matchId &&
            Boolean(item.originalDigest),
        ),
    )
  )
    issues.push(
      "Select unique retained submissions from this same match with immutable source digests.",
    );
  if (
    !["duplicate", "retain_conflict", "import_confirmed_events"].includes(
      input.resolution,
    )
  )
    issues.push("Choose a supported explicit review disposition.");
  if (
    !Array.isArray(input.commands) ||
    (input.resolution !== "import_confirmed_events" &&
      input.commands.length !== 0)
  )
    issues.push(
      "Duplicate/disputed dispositions cannot also alter accepted play.",
    );
  if (issues.length)
    return {
      valid: false,
      issues,
      before,
      after: null,
      earliestAffected: null,
      projectedState: null,
    };
  if (input.resolution === "import_confirmed_events")
    return previewReviewedCommands(state, input.commands, {
      ...context,
      previewId: input.proposalId,
    });
  try {
    assertParticipationConservation(state);
  } catch (error) {
    return {
      valid: false,
      issues: [
        error instanceof Error
          ? error.message
          : "Invalid accepted participation.",
      ],
      before,
      after: null,
      earliestAffected: null,
      projectedState: null,
    };
  }
  return {
    valid: true,
    issues: [],
    before,
    after: before,
    earliestAffected: null,
    projectedState: state,
  };
}
export function assertReconciliationApplyPolicy(
  policy: ReconciliationPolicy,
): void {
  if (
    policy.status !== "approved" ||
    !policy.policyId ||
    policy.policyId === Q08_RECONCILIATION_POLICY.policyId
  )
    throw Object.assign(new Error(Q08_RECONCILIATION_POLICY.decisionRequired), {
      code: "Q08_AUTHORITY_UNAPPROVED",
      status: 503,
    });
}

export interface ReconciliationReviewDocument {
  revision: number;
  kind: "longball-reconciliation-review-v1";
  matchId: string;
  snapshot: ReconciliationSnapshot | null;
  pending: {
    idempotencyKey: string;
    bodyJson: string;
    input: ReconciliationProposalInput;
  } | null;
  receipts: ReconciliationProposal[];
  refusals?: {
    request: NonNullable<ReconciliationReviewDocument["pending"]>;
    code: string;
    status: number;
    recordedAt: string;
  }[];
}
export function createReconciliationReview(
  matchId: string,
): ReconciliationReviewDocument {
  return {
    revision: 0,
    kind: "longball-reconciliation-review-v1",
    matchId,
    snapshot: null,
    pending: null,
    receipts: [],
  };
}
export function assertReconciliationReview(
  value: ReconciliationReviewDocument,
): void {
  if (
    value.kind !== "longball-reconciliation-review-v1" ||
    !Number.isSafeInteger(value.revision) ||
    !value.matchId ||
    !Array.isArray(value.receipts) ||
    (value.snapshot && value.snapshot.matchId !== value.matchId) ||
    (value.pending &&
      value.pending.bodyJson !== JSON.stringify(value.pending.input))
  )
    throw new Error(
      "Retain this review document: its match or exact pending proposal bytes differ.",
    );
}
export function retainReconciliationProposal(
  document: ReconciliationReviewDocument,
  input: ReconciliationProposalInput,
  idempotencyKey: string,
): ReconciliationReviewDocument {
  if (document.pending)
    throw new Error(
      "Retry the exact retained proposal before preparing another review.",
    );
  if (!identifier.test(idempotencyKey))
    throw new Error("A proposal needs a bounded immutable request ID.");
  const retained = JSON.parse(
    JSON.stringify(input),
  ) as ReconciliationProposalInput;
  return {
    ...document,
    pending: {
      idempotencyKey,
      input: retained,
      bodyJson: JSON.stringify(retained),
    },
  };
}
/** Compatible HTTP transport shape without treating a proposal response as a controller grant. */
export function reconciliationRequest(
  document: ReconciliationReviewDocument,
): DurableRequest {
  if (!document.pending)
    throw new Error("There is no durable proposal to retry.");
  assertReconciliationReview(document);
  return {
    kind: "reconciliation_proposal",
    path: `/v1/matches/${encodeURIComponent(document.matchId)}/reconciliation/proposals`,
    idempotencyKey: document.pending.idempotencyKey,
    body: JSON.parse(document.pending.bodyJson),
  };
}
export function acknowledgeReconciliationProposal(
  document: ReconciliationReviewDocument,
  receipt: ReconciliationProposal,
): ReconciliationReviewDocument {
  if (
    !document.pending ||
    receipt.matchId !== document.matchId ||
    canonicalReviewJson(receipt.input) !==
      canonicalReviewJson(document.pending.input)
  )
    throw new Error(
      "The proposal receipt differs from the exact retained review. Keep the original request.",
    );
  return {
    ...document,
    pending: null,
    receipts: [
      ...document.receipts.filter(
        (item) => item.input.proposalId !== receipt.input.proposalId,
      ),
      receipt,
    ],
  };
}

/** A definite semantic refusal can be archived explicitly; uncertain network/auth requests stay pending. */
export function retainReconciliationRefusal(
  document: ReconciliationReviewDocument,
  failure: { code: string; status: number; retryable: boolean },
  recordedAt: string,
): ReconciliationReviewDocument {
  if (
    !document.pending ||
    failure.retryable ||
    ![
      "RECONCILIATION_PREVIEW_REJECTED",
      "RECONCILIATION_PROPOSAL_CONFLICT",
      "STALE_REVISION",
      "INVALID_REQUEST",
      "CONTRACT_VERSION_REQUIRED",
    ].includes(failure.code) ||
    ![400, 409, 422].includes(failure.status)
  )
    throw new Error(
      "This response does not prove a refused proposal. Retain and retry its original request.",
    );
  return {
    ...document,
    pending: null,
    refusals: [
      ...(document.refusals ?? []),
      {
        request: document.pending,
        code: failure.code,
        status: failure.status,
        recordedAt,
      },
    ],
  };
}

/** Display each retained device stream in sequence order; do not infer cross-device clock agreement. */
export function orderedReconciliationSubmissions(
  items: ReconciliationSubmission[],
): ReconciliationSubmission[] {
  return [...items].sort(
    (left, right) =>
      (left.deviceId ?? "").localeCompare(right.deviceId ?? "") ||
      (left.clientSequence ?? Number.MAX_SAFE_INTEGER) -
        (right.clientSequence ?? Number.MAX_SAFE_INTEGER) ||
      left.receivedAt.localeCompare(right.receivedAt) ||
      left.submissionId.localeCompare(right.submissionId),
  );
}
