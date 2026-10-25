import { describe, expect, it } from "vitest";
import { createMatch, reduceMatch } from "@longball/domain";
import { fixtureMatchConfig } from "./application";
import {
  createPreparationState,
  reducePreparation,
  type PreparationCommand,
  type PreparationState,
} from "./preparation";
import {
  applyMatchPlan,
  previewMatchPlan,
  reviewPreparedMatchPlanLineup,
  saveMatchPlan,
  type MatchPlanSettings,
} from "./match-plans";
const nowMs = Date.parse("2026-10-21T12:00:00Z");
type Payload = PreparationCommand extends infer C
  ? C extends PreparationCommand
    ? Omit<C, "id" | "expectedRevision">
    : never
  : never;
const apply = (state: PreparationState, payload: Payload) =>
  reducePreparation(
    state,
    {
      ...payload,
      id: `test-${state.revision}`,
      expectedRevision: state.revision,
    } as PreparationCommand,
    { nowMs },
  );
function fixture() {
  let state = createPreparationState();
  const source = state.fixtures[0];
  state = apply(state, {
    type: "fixture.prepared",
    fixtureId: source.id,
    formationId: "formation-7",
  });
  const snapshot = state.snapshots[0],
    allocated = new Set<string>();
  const allocations = snapshot.formation.slots.map((slot) => {
    const player = snapshot.profiles.find(
      (profile) =>
        !allocated.has(profile.playerId) &&
        profile.eligiblePositions.includes(slot.position) &&
        (slot.position !== "GK" ||
          profile.preferences.slice(0, 2).includes("GK")),
    )!;
    allocated.add(player.playerId);
    return {
      slotId: slot.id,
      position: slot.position,
      playerId: player.playerId,
    };
  });
  const keeper = allocations.find((row) => row.position === "GK")!.playerId;
  const settings: MatchPlanSettings = {
    payload: {
      keeperMode: "sole_fixed",
      fixedKeeperPlayerSeasonId: keeper,
      minimumStintMs: 300_000,
      batchLimit: 2,
      scoreLeadThreshold: 4,
      returnToNormalEnabled: false,
    },
    applicability: {
      minimumStint: "soft_preference",
      batchLimit: "soft_preference",
      q07: "unapproved",
    },
    softPreferences: { halfBufferFraction: 0.15 },
  };
  const {
    responses: _responses,
    attendance: _attendance,
    selectedProfileIds: _ids,
    history: _history,
    status: _status,
    ...draft
  } = source;
  state = apply(state, {
    type: "fixture.saved",
    fixture: {
      ...draft,
      id: "destination",
      opponent: "Fictional Other FC",
      playedDate: "2026-11-07",
    },
  });
  state = apply(state, {
    type: "fixture.selection_saved",
    fixtureId: "destination",
    selectedProfileIds: [...source.selectedProfileIds],
  });
  const input = {
    planId: "rotation-plan",
    expectedPlanVersion: 0,
    name: "Reviewed opening",
    description: "Selected starting places",
    sourceFixtureId: source.id,
    sourceSnapshotId: snapshot.id,
    allocations,
    settings,
  };
  return { state, source, snapshot, input };
}
function saved() {
  const data = fixture();
  return {
    ...data,
    state: apply(data.state, { type: "match_plan.saved", ...data.input }),
  };
}
describe("reusable match-plan preparation", () => {
  it("saves an immutable versioned proposal from explicit preparation, not a formation alone", () => {
    const { state, input, snapshot } = fixture(),
      before = JSON.stringify(state);
    const plan = saveMatchPlan(state, input);
    expect(plan).toMatchObject({
      version: 1,
      teamId: state.team.id,
      seasonId: state.activeSeasonId,
      sourceSnapshotId: snapshot.id,
      allocations: input.allocations,
      settings: input.settings,
    });
    expect(JSON.stringify(state)).toBe(before);
    plan.allocations[0].playerId = "changed";
    expect(snapshot.profiles[0].playerId).not.toBe("changed");
  });
  it("rejects stale source preparation, malformed allocations and unapproved hard-policy claims", () => {
    const { state, input } = fixture();
    const changed = structuredClone(state);
    changed.fixtures[0].opponent = "Changed after preparation";
    expect(() => saveMatchPlan(changed, input)).toThrow(
      /Source preparation changed/,
    );
    expect(() =>
      saveMatchPlan(state, {
        ...input,
        allocations: input.allocations.slice(1),
      }),
    ).toThrow(/every saved place/);
    const boundary = structuredClone(input.settings);
    boundary.softPreferences.halfBufferFraction = 0.495;
    expect(() =>
      saveMatchPlan(state, { ...input, settings: boundary }),
    ).toThrow(/between zero and 0.49/);
    boundary.softPreferences.halfBufferFraction = 0.49;
    expect(
      saveMatchPlan(state, { ...input, settings: boundary }).settings,
    ).toEqual(boundary);
    const settings = structuredClone(input.settings);
    settings.applicability.q07 = "approved" as "unapproved";
    expect(() => saveMatchPlan(state, { ...input, settings })).toThrow(
      /cannot approve Q07/,
    );
  });
  it("applies only after exact preview/confirmation and leaves replies, selection, attendance and old snapshots unchanged", () => {
    const { state } = saved(),
      target = state.fixtures.find((row) => row.id === "destination")!;
    target.responses[target.selectedProfileIds[0]] = "unavailable";
    target.attendance[target.selectedProfileIds[1]] = "absent";
    const before = structuredClone(target),
      snapshots = JSON.stringify(state.snapshots),
      preview = previewMatchPlan(state, "rotation-plan", target.id, { nowMs });
    expect(preview.ready).toBe(true);
    const next = apply(state, {
      type: "match_plan.applied",
      fixtureId: target.id,
      planId: "rotation-plan",
      planVersion: 1,
      previewKey: preview.previewKey,
      confirm: true,
    });
    expect(next.fixtures.find((row) => row.id === target.id)).toMatchObject({
      responses: before.responses,
      attendance: before.attendance,
      selectedProfileIds: before.selectedProfileIds,
      matchPlanDraft: { templateId: "rotation-plan", templateVersion: 1 },
    });
    expect(JSON.stringify(next.snapshots)).toBe(snapshots);
    expect(target.matchPlanDraft).toBeUndefined();
  });
  it("refuses source, past, cancelled, protected played/claimed, wrong-format and other-season targets", () => {
    const { state, source } = saved();
    expect(
      previewMatchPlan(state, "rotation-plan", source.id, { nowMs }).ready,
    ).toBe(false);
    expect(
      previewMatchPlan(state, "rotation-plan", "destination", {
        nowMs,
        protectedFixtureIds: ["destination"],
      }).ready,
    ).toBe(false);
    for (const patch of [
      { playedDate: "2026-10-01" },
      { status: "cancelled" as const },
      { format: 5 },
      { seasonId: "other-season" },
    ]) {
      const changed = structuredClone(state);
      Object.assign(
        changed.fixtures.find((row) => row.id === "destination")!,
        patch,
      );
      expect(
        previewMatchPlan(changed, "rotation-plan", "destination", { nowMs })
          .ready,
      ).toBe(false);
    }
  });
  it("requires current selection/eligibility and never auto-adds, removes or resurrects profiles", () => {
    const { state, input } = saved();
    const missing = structuredClone(state);
    missing.fixtures.find(
      (row) => row.id === "destination",
    )!.selectedProfileIds = [];
    expect(
      previewMatchPlan(missing, "rotation-plan", "destination", { nowMs })
        .ready,
    ).toBe(false);
    const archived = structuredClone(state);
    archived.profiles.find(
      (profile) => profile.playerId === input.allocations[0].playerId,
    )!.active = false;
    expect(
      previewMatchPlan(archived, "rotation-plan", "destination", { nowMs })
        .ready,
    ).toBe(false);
    const changed = structuredClone(state);
    changed.profiles.find(
      (profile) => profile.playerId === input.allocations[1].playerId,
    )!.eligiblePositions = ["GK"];
    expect(
      previewMatchPlan(changed, "rotation-plan", "destination", { nowMs })
        .ready,
    ).toBe(false);
  });
  it("rejects a mutated or newly versioned template after preview and retains prior versions", () => {
    const { state, input } = saved(),
      preview = previewMatchPlan(state, "rotation-plan", "destination", {
        nowMs,
      });
    const request = {
      fixtureId: "destination",
      planId: "rotation-plan",
      planVersion: 1,
      previewKey: preview.previewKey,
      confirm: true as const,
    };
    const changed = structuredClone(state);
    changed.matchPlans![0].settings.payload.scoreLeadThreshold = 6;
    expect(() => applyMatchPlan(changed, request, { nowMs })).toThrow(
      /preview or plan changed/,
    );
    const next = apply(state, {
      type: "match_plan.saved",
      ...input,
      expectedPlanVersion: 1,
      name: "Version two",
    });
    expect(next.matchPlans?.map((plan) => plan.version)).toEqual([1, 2]);
    expect(() => applyMatchPlan(next, request, { nowMs })).toThrow(
      /preview or plan changed/,
    );
  });
  it("preserves exact command idempotency and refuses stale revision/different-body retry", () => {
    const { state, input } = fixture();
    const command: PreparationCommand = {
      type: "match_plan.saved",
      ...input,
      id: "durable-save",
      expectedRevision: state.revision,
    };
    const next = reducePreparation(state, command, { nowMs });
    expect(reducePreparation(next, command, { nowMs })).toBe(next);
    expect(() =>
      reducePreparation(next, { ...command, name: "Different" }, { nowMs }),
    ).toThrow(/different content/);
    expect(() =>
      reducePreparation(next, { ...command, id: "fresh-key" }, { nowMs }),
    ).toThrow(/Preparation changed/);
  });
  it("copies proposals into fresh preparation without staging play or inferring check-in, then uses current validated profiles", () => {
    let { state } = saved();
    const preview = previewMatchPlan(state, "rotation-plan", "destination", {
      nowMs,
    });
    state = apply(state, {
      type: "match_plan.applied",
      fixtureId: "destination",
      planId: "rotation-plan",
      planVersion: 1,
      previewKey: preview.previewKey,
      confirm: true,
    });
    const target = state.fixtures.find((row) => row.id === "destination")!;
    state.profiles[0].displayName = "Current future name";
    state = apply(state, {
      type: "fixture.prepared",
      fixtureId: target.id,
      formationId: target.matchPlanDraft!.formation.id,
    });
    const snapshot = state.snapshots.at(-1)!;
    expect(snapshot.profiles[0].displayName).toBe("Current future name");
    expect(state.snapshots[0].profiles[0].displayName).not.toBe(
      "Current future name",
    );
    let match = createMatch(fixtureMatchConfig(state, snapshot));
    expect(match.stagedLineup).toEqual([]);
    expect(
      Object.values(match.attendance).every(
        (value) => value === "not_recorded",
      ),
    ).toBe(true);
    expect(() => reviewPreparedMatchPlanLineup(match)).toThrow();
    for (const row of target.matchPlanDraft!.allocations)
      match = reduceMatch(match, {
        type: "attendance.recorded",
        id: `arrived-${row.playerId}`,
        sample: { monotonicMs: 0, wallTimeMs: nowMs, sessionId: "test" },
        playerId: row.playerId,
        status: "present",
      });
    const reviewed = reviewPreparedMatchPlanLineup(match);
    expect(reviewed.lineup).toEqual(target.matchPlanDraft!.allocations);
    expect(match.stagedLineup).toEqual([]);
    match = reduceMatch(match, {
      type: "lineup.staged",
      id: "explicit-stage",
      sample: { monotonicMs: 0, wallTimeMs: nowMs, sessionId: "test" },
      lineup: reviewed.lineup,
    });
    expect(match.stagedLineup).toEqual(reviewed.lineup);
    expect(match.status).toBe("preparation");
  });
  it("removes only a fixture proposal without altering template history or old snapshots", () => {
    let { state } = saved();
    const preview = previewMatchPlan(state, "rotation-plan", "destination", {
      nowMs,
    });
    state = apply(state, {
      type: "match_plan.applied",
      fixtureId: "destination",
      planId: "rotation-plan",
      planVersion: 1,
      previewKey: preview.previewKey,
      confirm: true,
    });
    const plans = JSON.stringify(state.matchPlans),
      snapshots = JSON.stringify(state.snapshots);
    const next = apply(state, {
      type: "match_plan.cleared",
      fixtureId: "destination",
    });
    expect(
      next.fixtures.find((row) => row.id === "destination")!.matchPlanDraft,
    ).toBeUndefined();
    expect(JSON.stringify(next.matchPlans)).toBe(plans);
    expect(JSON.stringify(next.snapshots)).toBe(snapshots);
  });
});
