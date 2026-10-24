import {
  validateLineup,
  type Allocation,
  type MatchState,
  type MatchPolicyProposal,
} from "@longball/domain";
import type {
  PreparationFixture,
  PreparationFormation,
  PreparationState,
  PreparedFixtureSnapshot,
} from "./preparation";
import { assertActiveFormationPositions } from './position-catalogue';

/** A reusable proposal: no policy version, clock boundary, authority or acknowledgement is copied. */
export type MatchPlanSettings = MatchPolicyProposal;
export interface ReusableMatchPlan {
  id: string;
  version: number;
  teamId: string;
  seasonId: string;
  name: string;
  description: string;
  sourceFixtureId: string;
  sourceSnapshotId: string;
  sourcePreparedRevision: number;
  formation: PreparationFormation;
  allocations: Allocation[];
  settings: MatchPlanSettings;
}
export interface FixtureMatchPlanDraft {
  templateId: string;
  templateVersion: number;
  appliedRevision: number;
  formation: PreparationFormation;
  allocations: Allocation[];
  settings: MatchPlanSettings;
}
export interface MatchPlanContext {
  nowMs?: number;
  protectedFixtureIds?: readonly string[];
}
export interface MatchPlanSaveInput {
  planId: string;
  expectedPlanVersion: number;
  name: string;
  description: string;
  sourceFixtureId: string;
  sourceSnapshotId: string;
  allocations: Allocation[];
  settings: MatchPlanSettings;
}
export interface MatchPlanApplyInput {
  planId: string;
  planVersion: number;
  fixtureId: string;
  previewKey: string;
  confirm: true;
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function shape(
  value: unknown,
  keys: string[],
): asserts value is Record<string, unknown> {
  assert(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) => keys.includes(key)),
    "Match-plan data contains unsupported fields.",
  );
}
function required(value: string, maximum: number, label: string) {
  assert(
    typeof value === "string" &&
      value.trim() &&
      value.trim().length <= maximum &&
      !/[\u0000-\u001f\u007f]/.test(value),
    `${label} is required and must be at most ${maximum} characters.`,
  );
  return value.trim();
}
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
          .join(",")}}`
      : JSON.stringify(value);
function keeper(profile: PreparedFixtureSnapshot["profiles"][number]) {
  return (
    (profile.eligiblePositions.includes("GK") &&
      ["GK"].includes(profile.preferences[0])) ||
    (profile.eligiblePositions.includes("GK") &&
      profile.preferences[1] === "GK")
  );
}
export function latestMatchPlans(state: PreparationState): ReusableMatchPlan[] {
  const map = new Map<string, ReusableMatchPlan>();
  for (const plan of state.matchPlans ?? [])
    if (!map.has(plan.id) || map.get(plan.id)!.version < plan.version)
      map.set(plan.id, plan);
  return [...map.values()]
    .filter(
      (plan) =>
        plan.teamId === state.team.id && plan.seasonId === state.activeSeasonId,
    )
    .map(copy);
}
export function validateMatchPlanSettings(settings: MatchPlanSettings): void {
  shape(settings, ["payload", "applicability", "softPreferences"]);
  shape(settings.payload, [
    "keeperMode",
    "fixedKeeperPlayerSeasonId",
    "minimumStintMs",
    "batchLimit",
    "scoreLeadThreshold",
    "returnToNormalEnabled",
  ]);
  shape(settings.applicability, ["minimumStint", "batchLimit", "q07"]);
  shape(settings.softPreferences, ["halfBufferFraction"]);
  const p = settings.payload;
  assert(
    ["sole_fixed", "common_pool"].includes(p.keeperMode) &&
      (p.fixedKeeperPlayerSeasonId === null ||
        (typeof p.fixedKeeperPlayerSeasonId === "string" &&
          p.fixedKeeperPlayerSeasonId.length > 0)),
    "Choose a known keeper proposal.",
  );
  assert(
    (p.keeperMode === "sole_fixed") === (p.fixedKeeperPlayerSeasonId !== null),
    "Fixed keeper identity must agree with the keeper proposal.",
  );
  assert(
    Number.isSafeInteger(p.minimumStintMs) &&
      p.minimumStintMs >= 0 &&
      Number.isSafeInteger(p.batchLimit) &&
      p.batchLimit >= 1 &&
      p.batchLimit <= 11 &&
      Number.isSafeInteger(p.scoreLeadThreshold) &&
      p.scoreLeadThreshold >= 1 &&
      typeof p.returnToNormalEnabled === "boolean",
    "Review minimum spell, batch preference, threshold and explicit return choice.",
  );
  assert(
    settings.applicability.minimumStint === "soft_preference" &&
      settings.applicability.batchLimit === "soft_preference" &&
      settings.applicability.q07 === "unapproved",
    "A saved plan cannot approve Q07 or convert preferences into hard rules.",
  );
  assert(
    Number.isFinite(settings.softPreferences.halfBufferFraction) &&
      settings.softPreferences.halfBufferFraction >= 0 &&
      settings.softPreferences.halfBufferFraction <= 0.49,
    "Half buffer must be a fraction between zero and 0.49.",
  );
}
function validateProposal(
  state: PreparationState,
  fixture: PreparationFixture,
  formation: PreparationFormation,
  allocations: Allocation[],
  settings: MatchPlanSettings,
) {
  assertActiveFormationPositions(state, formation);
  assert(
    formation.format === fixture.format &&
      formation.slots.length === fixture.format &&
      formation.slots.filter((slot) => slot.position === "GK").length === 1,
    "The saved formation must match this fixture format and include one goalkeeper.",
  );
  assert(
    Array.isArray(allocations) &&
      allocations.length === fixture.format &&
      new Set(allocations.map((row) => row.slotId)).size === fixture.format &&
      new Set(allocations.map((row) => row.playerId)).size === fixture.format,
    "Review one distinct player for every saved place.",
  );
  const selected = fixture.selectedProfileIds
    .map((id) =>
      state.profiles.find(
        (profile) =>
          profile.id === id &&
          profile.seasonId === fixture.seasonId &&
          profile.active,
      ),
    )
    .filter((profile): profile is NonNullable<typeof profile> =>
      Boolean(profile),
    );
  for (const allocation of allocations) {
    shape(allocation, ["slotId", "position", "playerId"]);
    const slot = formation.slots.find(
      (value) => value.id === allocation.slotId,
    );
    const profile = selected.find(
      (value) => value.playerId === allocation.playerId,
    );
    assert(
      slot &&
        slot.position === allocation.position &&
        profile &&
        profile.eligiblePositions.includes(slot.position),
      "A proposed player is missing, unselected, archived or no longer eligible. Review the squad and places first.",
    );
    if (slot.position === "GK")
      assert(
        keeper(profile),
        "The proposed goalkeeper must remain a first- or second-choice eligible keeper.",
      );
  }
  validateMatchPlanSettings(settings);
  const qualifying = selected.filter(keeper);
  assert(
    settings.payload.minimumStintMs <= fixture.plannedHalfDurationMs,
    "The preferred spell exceeds this fixture’s planned half.",
  );
  assert(
    settings.payload.keeperMode === "sole_fixed"
      ? qualifying.length === 1 &&
          qualifying[0].playerId ===
            settings.payload.fixedKeeperPlayerSeasonId &&
          allocations.some(
            (row) =>
              row.position === "GK" && row.playerId === qualifying[0].playerId,
          )
      : qualifying.length >= 2,
    "The saved keeper proposal does not match this selected squad. Review current keeper coverage; no exemption is inferred.",
  );
}
export function saveMatchPlan(
  state: PreparationState,
  input: MatchPlanSaveInput,
): ReusableMatchPlan {
  shape(input, [
    "planId",
    "expectedPlanVersion",
    "name",
    "description",
    "sourceFixtureId",
    "sourceSnapshotId",
    "allocations",
    "settings",
  ]);
  const fixture = state.fixtures.find(
    (row) =>
      row.id === input.sourceFixtureId && row.seasonId === state.activeSeasonId,
  );
  const snapshot = state.snapshots.find(
    (row) =>
      row.id === input.sourceSnapshotId &&
      row.fixtureId === input.sourceFixtureId,
  );
  assert(
    fixture && snapshot && snapshot.seasonId === state.activeSeasonId,
    "Review an explicit saved preparation for this team and season.",
  );
  const latestSnapshot = state.snapshots
    .filter((row) => row.fixtureId === fixture.id)
    .at(-1);
  const {
    status: _status,
    selectedProfileIds: _selection,
    responses: _responses,
    attendance: _attendance,
    history: _history,
    matchPlanDraft: _draft,
    ...fixtureDetails
  } = fixture;
  assert(
    latestSnapshot?.id === snapshot.id &&
      canonical(snapshot.fixture) === canonical(fixtureDetails) &&
      canonical(snapshot.selectedPlayerIds.slice().sort()) ===
        canonical(
          fixture.selectedProfileIds
            .map(
              (id) =>
                state.profiles.find((profile) => profile.id === id)?.playerId,
            )
            .sort(),
        ),
    "Source preparation changed. Prepare and review its latest snapshot before saving a plan.",
  );
  const previous = latestMatchPlans(state).find(
    (row) => row.id === input.planId,
  );
  assert(
    input.expectedPlanVersion === (previous?.version ?? 0),
    "The reusable plan changed. Refresh and review its current version.",
  );
  validateProposal(
    state,
    fixture,
    snapshot.formation,
    input.allocations,
    input.settings,
  );
  assert(
    typeof input.description === "string" &&
      input.description.length <= 300 &&
      !/[\u0000-\u001f\u007f]/.test(input.description),
    "Use a short non-sensitive description, at most300 characters.",
  );
  return {
    id: required(input.planId, 150, "Plan identity"),
    version: (previous?.version ?? 0) + 1,
    teamId: state.team.id,
    seasonId: fixture.seasonId,
    name: required(input.name, 40, "Plan name"),
    description: input.description.trim(),
    sourceFixtureId: fixture.id,
    sourceSnapshotId: snapshot.id,
    sourcePreparedRevision: snapshot.preparedRevision,
    formation: copy(snapshot.formation),
    allocations: copy(input.allocations),
    settings: copy(input.settings),
  };
}
function today(now: number) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
}
export function previewMatchPlan(
  state: PreparationState,
  planId: string,
  fixtureId: string,
  context: MatchPlanContext = {},
) {
  const plan = latestMatchPlans(state).find((row) => row.id === planId);
  const fixture = state.fixtures.find(
    (row) => row.id === fixtureId && row.seasonId === state.activeSeasonId,
  );
  const issues: string[] = [];
  try {
    assert(
      plan && fixture,
      "Choose an existing plan and target fixture in this team and season.",
    );
    assert(
      fixture.id !== plan.sourceFixtureId,
      "Choose another fixture; saving a template never overwrites its source.",
    );
    assert(
      fixture.status === "scheduled" &&
        fixture.playedDate >= today(context.nowMs ?? Date.now()) &&
        !context.protectedFixtureIds?.includes(fixture.id),
      "Only a prospective, unrecorded and unclaimed fixture can receive a match plan.",
    );
    validateProposal(
      state,
      fixture,
      plan.formation,
      plan.allocations,
      plan.settings,
    );
  } catch (error) {
    issues.push(
      error instanceof Error ? error.message : "This plan is not applicable.",
    );
  }
  const previewKey =
    plan && fixture
      ? canonical([
          state.revision,
          plan,
          fixture,
          state.profiles
            .filter((profile) =>
              fixture.selectedProfileIds.includes(profile.id),
            )
            .map((profile) => [
              profile.id,
              profile.playerId,
              profile.active,
              profile.eligiblePositions,
              profile.preferences,
            ]),
        ])
      : "";
  return {
    ready: issues.length === 0,
    issues,
    previewKey,
    plan: plan ? copy(plan) : null,
    fixture: fixture ? copy(fixture) : null,
  };
}
export function applyMatchPlan(
  state: PreparationState,
  input: MatchPlanApplyInput,
  context: MatchPlanContext = {},
): FixtureMatchPlanDraft {
  shape(input, ["planId", "planVersion", "fixtureId", "previewKey", "confirm"]);
  const preview = previewMatchPlan(
    state,
    input.planId,
    input.fixtureId,
    context,
  );
  assert(
    input.confirm === true &&
      preview.ready &&
      preview.plan &&
      input.planVersion === preview.plan.version &&
      input.previewKey === preview.previewKey,
    preview.issues[0] ??
      "The preview or plan changed. Review this fixture again before explicitly confirming.",
  );
  const plan = preview.plan;
  return {
    templateId: plan.id,
    templateVersion: plan.version,
    appliedRevision: state.revision + 1,
    formation: {
      ...copy(plan.formation),
      id: `match-plan:${plan.id}:${plan.version}`,
      name: plan.name,
    },
    allocations: copy(plan.allocations),
    settings: copy(plan.settings),
  };
}
export function validateFixtureMatchPlan(
  state: PreparationState,
  fixture: PreparationFixture,
): void {
  if (fixture.matchPlanDraft)
    validateProposal(
      state,
      fixture,
      fixture.matchPlanDraft.formation,
      fixture.matchPlanDraft.allocations,
      fixture.matchPlanDraft.settings,
    );
}
export function reviewPreparedMatchPlanLineup(match: MatchState): {
  lineup: Allocation[];
  sourceRevision: number;
} {
  const proposal = match.config.initialLineupProposal;
  assert(
    match.status === "preparation" && Array.isArray(proposal),
    "A reusable starting-lineup proposal is available only before kickoff.",
  );
  const errors = validateLineup(match, proposal);
  assert(errors.length === 0, errors.join(" "));
  return { lineup: copy(proposal), sourceRevision: match.revision };
}
