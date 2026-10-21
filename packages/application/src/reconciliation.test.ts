import { describe, expect, it } from "vitest";
import {
  createMatch,
  reduceMatch,
  type Allocation,
} from "../../domain/src/index";
import {
  acknowledgeReconciliationProposal,
  assertParticipationConservation,
  assertReconciliationApplyPolicy,
  assertReconciliationReview,
  canonicalReviewJson,
  createReconciliationReview,
  previewReconciliation,
  orderedReconciliationSubmissions,
  previewReviewedCommands,
  Q08_RECONCILIATION_POLICY,
  reconciliationRequest,
  retainReconciliationProposal,
  retainReconciliationRefusal,
  type ReconciliationProposal,
  type ReconciliationProposalInput,
  type ReconciliationSubmission,
} from "./reconciliation";
import { LongBallServiceClient, type HttpFetch } from "./sync";
const now = 1_800_000_000_000;
const sample = (ms: number) => ({
  monotonicMs: ms,
  sessionId: "continuous",
  wallTimeMs: now + ms,
});
const players = Array.from({ length: 8 }, (_, index) => ({
  id: `p${index + 1}`,
  displayName: `Player ${index + 1}`,
  goalkeeperChoice: index === 0 ? 1 : 0,
}));
const lineup: Allocation[] = players.slice(0, 7).map((player, index) => ({
  playerId: player.id,
  slotId: `slot-${index}`,
  position: index === 0 ? "GK" : "CM",
}));
function checkpoint() {
  let state = createMatch({
    matchId: "synthetic-review",
    selectedPlayerIds: players.map((item) => item.id),
    players,
    fixedKeeperId: "p1",
    plannedHalfDurationMs: 1_500_000,
    pitchPlaces: 7,
  });
  for (const player of players)
    state = reduceMatch(state, {
      type: "attendance.recorded",
      id: `present-${player.id}`,
      playerId: player.id,
      status: "present",
      sample: sample(0),
    });
  state = reduceMatch(state, {
    type: "lineup.staged",
    id: "staged",
    lineup,
    sample: sample(0),
  });
  state = reduceMatch(state, {
    type: "half.started",
    id: "start",
    sample: sample(0),
  });
  return reduceMatch(state, {
    type: "half.paused",
    id: "pause",
    sample: sample(30_000),
  });
}
const original = {
  eventId: "old-phone-sub",
  command: {
    type: "lineup.committed",
    lineup: lineup.map((item) =>
      item.playerId === "p7" ? { ...item, playerId: "p8" } : item,
    ),
  },
};
const submission: ReconciliationSubmission = {
  submissionId: "submission-one",
  matchId: "synthetic-review",
  eventId: "old-phone-sub",
  deviceId: "old-phone",
  controllerEpoch: 1,
  clientSequence: 23,
  reason: "STALE_CONTROLLER_EPOCH",
  original,
  originalDigest: "server-bound-digest",
  receivedAt: new Date(now).toISOString(),
};
function proposal(): ReconciliationProposalInput {
  return {
    proposalId: "proposal-one",
    baseRevision: checkpoint().revision,
    sourceSubmissionIds: ["submission-one"],
    reason: "Compare the original device and touchline evidence.",
    resolution: "import_confirmed_events",
    commands: [
      {
        type: "lineup.committed",
        sourceRevision: checkpoint().revision,
        lineup: original.command.lineup,
        effective: { half: 1, halfElapsedMs: 10_000, matchElapsedMs: 10_000 },
        lateEntryReason:
          "Touchline sheet independently verifies the actual substitution.",
      },
    ],
  };
}
const context = { actorId: "verified-manager", recordedAtMs: now + 50_000 };
describe("ME53 immutable reconciliation preparation and explicit Q08 policy boundary", () => {
  it("previews an explicit missing substitution and conserves exact time without changing accepted/source evidence", () => {
    const state = checkpoint(),
      input = proposal(),
      before = canonicalReviewJson([state, input, submission]);
    const preview = previewReconciliation(state, input, [submission], context);
    expect(preview.valid).toBe(true);
    expect(preview.issues).toEqual([]);
    expect(
      preview.after?.playerMinutes.find((item) => item.playerId === "p7")
        ?.playingMs,
    ).toBe(10_000);
    expect(
      preview.after?.playerMinutes.find((item) => item.playerId === "p8")
        ?.playingMs,
    ).toBe(20_000);
    expect(preview.after).toMatchObject({
      matchActiveMs: 30_000,
      capacityPlayerMs: 210_000,
      occupiedPlayerMs: 210_000,
      vacancyPlayerMs: 0,
    });
    expect(preview.earliestAffected?.matchElapsedMs).toBe(10_000);
    expect(preview.projectedState?.eventHistory?.at(-1)?.id).toBe(
      "proposal-one-preview-0",
    );
    expect(canonicalReviewJson([state, input, submission])).toBe(before);
    expect(() =>
      assertReconciliationApplyPolicy(Q08_RECONCILIATION_POLICY),
    ).toThrow("who may approve");
    expect(() =>
      assertReconciliationApplyPolicy({
        status: "approved",
        policyId: Q08_RECONCILIATION_POLICY.policyId,
        decisionRequired: null,
      }),
    ).toThrow();
  });
  it("requires current accepted revision, unique same-match source digests and a reason", () => {
    const input = proposal();
    expect(
      previewReconciliation(
        checkpoint(),
        { ...input, baseRevision: input.baseRevision - 1 },
        [submission],
        context,
      ).valid,
    ).toBe(false);
    expect(
      previewReconciliation(
        checkpoint(),
        { ...input, sourceSubmissionIds: ["submission-one", "submission-one"] },
        [submission],
        context,
      ).valid,
    ).toBe(false);
    expect(
      previewReconciliation(
        checkpoint(),
        input,
        [{ ...submission, matchId: "another-team" }],
        context,
      ).valid,
    ).toBe(false);
    expect(
      previewReconciliation(
        checkpoint(),
        input,
        [{ ...submission, originalDigest: "" }],
        context,
      ).valid,
    ).toBe(false);
    expect(
      previewReconciliation(
        checkpoint(),
        { ...input, reason: " " },
        [submission],
        context,
      ).valid,
    ).toBe(false);
  });
  it("does not copy old commands, infer clock boundaries, rebase drafts or accept client authority", () => {
    const input = proposal();
    const intents = [
      { type: "half.ended" },
      {
        type: "clock.corrected",
        halfActiveMs: 9000,
        confirmUnchangedLineup: true,
        reason: "guess",
      },
      { ...input.commands[0], effective: undefined },
      { ...input.commands[0], sourceRevision: 0 },
      { ...input.commands[0], actorId: "self-appointed" },
    ];
    for (const command of intents)
      expect(
        previewReconciliation(
          checkpoint(),
          { ...input, commands: [command as never] },
          [submission],
          context,
        ).valid,
      ).toBe(false);
    expect(
      previewReconciliation(
        checkpoint(),
        { ...input, commands: [] },
        [submission],
        context,
      ).valid,
    ).toBe(false);
  });
  it("prepares duplicate/disputed proposals without modifying participation or silently clearing quarantine", () => {
    const state = checkpoint(),
      input = proposal();
    for (const resolution of ["duplicate", "retain_conflict"] as const) {
      const preview = previewReconciliation(
        state,
        { ...input, resolution, commands: [] },
        [submission],
        context,
      );
      expect(preview.valid).toBe(true);
      expect(preview.projectedState).toBe(state);
      expect(preview.after).toEqual(preview.before);
      expect(
        previewReconciliation(
          state,
          { ...input, resolution },
          [submission],
          context,
        ).valid,
      ).toBe(false);
    }
  });
  it("detects overlapping or missing per-player time, duplicate occupied slots, and damaged target coverage", () => {
    const state = checkpoint();
    expect(() => assertParticipationConservation(state)).not.toThrow();
    expect(() =>
      assertParticipationConservation({
        ...state,
        intervals: [...state.intervals, state.intervals[0]],
      }),
    ).toThrow("overlap");
    expect(() =>
      assertParticipationConservation({
        ...state,
        intervals: state.intervals.slice(1),
      }),
    ).toThrow("partition");
    expect(() =>
      assertParticipationConservation({
        ...state,
        intervals: state.intervals.map((item) =>
          item.state === "playing" ? { ...item, slotId: "same" } : item,
        ),
      }),
    ).toThrow("twice");
    expect(() =>
      assertParticipationConservation({ ...state, targetIntervals: [] }),
    ).toThrow("target intervals");
  });
  it("requires each sequential participation draft to retain its explicitly reviewed revision", () => {
    const state = checkpoint(),
      input = proposal();
    expect(
      previewReviewedCommands(state, [input.commands[0], input.commands[0]], {
        ...context,
        previewId: "two-events",
      }).valid,
    ).toBe(false);
    const second = { ...input.commands[0], sourceRevision: state.revision + 1 };
    expect(
      previewReviewedCommands(state, [input.commands[0], second], {
        ...context,
        previewId: "two-events",
      }).valid,
    ).toBe(true);
  });
  it("retries byte-identical durable proposal after response loss/reopen and validates its saved receipt", async () => {
    const input = proposal();
    let document = retainReconciliationProposal(
      createReconciliationReview("synthetic-review"),
      input,
      "exact-proposal-key",
    );
    const preview = previewReconciliation(
      checkpoint(),
      input,
      [submission],
      context,
    );
    const { projectedState: _, ...wirePreview } = preview;
    const receipt: ReconciliationProposal = {
      input,
      matchId: "synthetic-review",
      actorId: context.actorId,
      createdAt: new Date(now).toISOString(),
      sourceDigests: [
        {
          submissionId: submission.submissionId,
          originalDigest: submission.originalDigest,
        },
      ],
      acceptedStateDigest: "accepted-digest",
      preview: wirePreview,
      status: "prepared",
      appliedRevision: null,
    };
    const requests: string[] = [];
    let first = true;
    const fetch: HttpFetch = async (_url, options) => {
      requests.push(`${options.headers["Idempotency-Key"]}:${options.body}`);
      if (first) {
        first = false;
        throw new Error("committed response lost");
      }
      return { ok: true, status: 200, json: async () => receipt };
    };
    const client = new LongBallServiceClient("", fetch);
    await expect(
      client.execute(reconciliationRequest(document), null),
    ).rejects.toThrow("response lost");
    document = JSON.parse(JSON.stringify(document));
    assertReconciliationReview(document);
    expect(() =>
      retainReconciliationProposal(
        document,
        { ...input, proposalId: "new" },
        "new-key",
      ),
    ).toThrow("Retry the exact");
    const accepted = await client.execute<ReconciliationProposal>(
      reconciliationRequest(document),
      null,
    );
    expect(requests[1]).toBe(requests[0]);
    expect(() =>
      acknowledgeReconciliationProposal(document, {
        ...accepted,
        input: { ...input, reason: "different" },
      }),
    ).toThrow("differs");
    document = acknowledgeReconciliationProposal(document, accepted);
    expect(document.pending).toBeNull();
    expect(document.receipts).toHaveLength(1);
    expect(document.receipts[0].status).toBe("prepared");
  });
  it("shows per-device sequence lanes without discarding conflicting reuse or inventing cross-device time agreement", () => {
    const later = {
      ...submission,
      submissionId: "later",
      clientSequence: 25,
      receivedAt: new Date(now - 10000).toISOString(),
    };
    const reuse = {
      ...submission,
      submissionId: "conflicting-reuse",
      reason: "SEQUENCE_GAP_OR_REUSE",
    };
    const another = {
      ...submission,
      submissionId: "other-device",
      deviceId: "a-device",
      clientSequence: 70,
    };
    const input = [later, submission, reuse, another],
      original = JSON.stringify(input);
    const ordered = orderedReconciliationSubmissions(input);
    expect(ordered.map((item) => item.submissionId)).toEqual([
      "other-device",
      "conflicting-reuse",
      "submission-one",
      "later",
    ]);
    expect(ordered).toHaveLength(4);
    expect(JSON.stringify(input)).toBe(original);
  });
  it("retains definite semantic refusals while network, timeout and authorization uncertainty stay retryable", () => {
    const document = retainReconciliationProposal(
      createReconciliationReview("synthetic-review"),
      proposal(),
      "refused-original-key",
    );
    const refused = retainReconciliationRefusal(
      document,
      {
        code: "RECONCILIATION_PREVIEW_REJECTED",
        status: 422,
        retryable: false,
      },
      new Date(now).toISOString(),
    );
    expect(refused.pending).toBeNull();
    expect(refused.refusals?.[0].request).toEqual(document.pending);
    for (const failure of [
      { code: "REQUEST_TIMEOUT", status: 0, retryable: true },
      { code: "NOT_FOUND", status: 403, retryable: false },
      { code: "HTTP_FAILURE", status: 503, retryable: true },
    ])
      expect(() =>
        retainReconciliationRefusal(
          document,
          failure,
          new Date(now).toISOString(),
        ),
      ).toThrow("does not prove");
    expect(document.pending?.idempotencyKey).toBe("refused-original-key");
    expect(
      previewReconciliation(checkpoint(), null as never, [submission], context)
        .valid,
    ).toBe(false);
    expect(
      previewReconciliation(
        checkpoint(),
        { ...proposal(), reason: 5 as never },
        [submission],
        context,
      ).valid,
    ).toBe(false);
  });
  it("rejects mutated retained bytes and exposes no accepted device sequence allocation", () => {
    const input = proposal(),
      document = retainReconciliationProposal(
        createReconciliationReview("synthetic-review"),
        input,
        "original-key",
      );
    input.reason = "later UI edit";
    expect(document.pending?.input.reason).not.toBe(input.reason);
    expect(() =>
      assertReconciliationReview({
        ...document,
        pending: { ...document.pending!, bodyJson: "{}" },
      }),
    ).toThrow("bytes differ");
    expect(document).not.toHaveProperty("allocatedSequence");
    expect(document).not.toHaveProperty("grant");
  });
});
