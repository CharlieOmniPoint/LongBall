import { describe, expect, it } from "vitest";
import { createMatch, reduceMatch } from "../../domain/src/index";
import { planMatch } from "../../domain/src/planner";
import { fixtureMatchConfig } from "./application";
import { plannerInputFromMatch } from "./match-planner";
import {
  createPreparationState,
  prepareFixtureSnapshot,
  reducePreparation,
  type PreparationCommand,
  type PreparationState,
} from "./preparation";
import {
  activePositionCodes,
  archiveTeamPosition,
  defaultPositionCatalogue,
  positionCatalogueFor,
  saveTeamPosition,
  validPositionCatalogue,
} from "./position-catalogue";
import {
  parseOwnPlayerPreparation,
  projectOwnPlayerPreparation,
} from "./player-preparation";

type Payload = PreparationCommand extends infer C
  ? C extends PreparationCommand
    ? Omit<C, "id" | "expectedRevision">
    : never
  : never;
const apply = (state: PreparationState, payload: Payload) =>
  reducePreparation(state, {
    ...payload,
    id: `positions-${state.revision + 1}`,
    expectedRevision: state.revision,
  } as PreparationCommand);

describe("team-managed position catalogue", () => {
  it("inherits the original defaults for legacy preparations without mutating them", () => {
    const legacy = createPreparationState();
    delete legacy.positionCatalogue;
    expect(activePositionCodes(legacy)).toEqual([
      "GK",
      "CB",
      "LB",
      "RB",
      "CM",
      "LW",
      "RW",
      "ST",
    ]);
    const copy = positionCatalogueFor(legacy);
    copy[0].label = "Changed locally";
    expect(positionCatalogueFor(legacy)[0].label).toBe("Goalkeeper");
    expect(legacy).not.toHaveProperty("positionCatalogue");
  });
  it("validates exact two-letter codes and keeps goalkeeper active and core identities retained", () => {
    const state = createPreparationState();
    for (const code of ["A", "CAM", "am", "A1", " A"])
      expect(() =>
        saveTeamPosition(state, {
          code,
          label: "Attacking midfield",
          active: true,
        }),
      ).toThrow(/two-letter/);
    expect(() => archiveTeamPosition(state, "GK")).toThrow(/Goalkeeper/);
    expect(() => archiveTeamPosition(state, "ZZ")).toThrow(/saved/);
    expect(
      validPositionCatalogue(
        defaultPositionCatalogue().filter((position) => position.code !== "CB"),
      ),
    ).toBe(false);
    const added = saveTeamPosition(state, {
      code: "AM",
      label: "Attacking midfield",
      active: true,
    });
    expect(added).toHaveLength(9);
    expect(state.positionCatalogue).toHaveLength(8);
    expect(
      saveTeamPosition(
        { positionCatalogue: added },
        { code: "AM", label: "Attacking midfielder", active: true },
      ),
    ).toHaveLength(9);
  });
  it("uses a custom code through profile, frozen match configuration and the actual future planner", () => {
    let state = apply(createPreparationState(), {
      type: "position.saved",
      position: { code: "AM", label: "Attacking midfield", active: true },
    });
    const fixture = state.fixtures[0],
      formation = state.formations.find((item) => item.format === 7)!,
      keeperId = state.profiles[0].playerId;
    for (const profile of [...state.profiles])
      state = apply(state, {
        type: "profile.saved",
        profile: {
          ...profile,
          preferences:
            profile.playerId === keeperId
              ? ["GK", "AM", "CB"]
              : ["AM", "CB", "ST"],
          eligiblePositions: [
            "GK",
            "CB",
            "LB",
            "RB",
            "CM",
            "LW",
            "RW",
            "ST",
            "AM",
          ],
        },
      });
    const custom = {
      ...formation,
      slots: formation.slots.map((slot, index) =>
        index === 3 ? { ...slot, position: "AM", label: "AM" } : slot,
      ),
    };
    state = apply(state, { type: "formation.saved", formation: custom });
    const snapshot = prepareFixtureSnapshot(state, fixture.id, formation.id);
    const config = fixtureMatchConfig(state, snapshot);
    expect(config.slots!.some((slot) => slot.position === "AM")).toBe(true);
    expect(
      config.profileSnapshot!.every((profile) =>
        profile.eligiblePositions.includes("AM"),
      ),
    ).toBe(true);
    let match = createMatch(config);
    const sample = {
      sessionId: "custom-positions",
      monotonicMs: 0,
      wallTimeMs: Date.UTC(2026, 9, 24),
    };
    for (const playerId of config.selectedPlayerIds)
      match = reduceMatch(match, {
        id: `present-${playerId}`,
        type: "attendance.recorded",
        playerId,
        status: "present",
        sample,
      });
    const input = plannerInputFromMatch(
      match,
      sample,
      {
        batchPreference: 3,
        leadThreshold: 2,
        returnToNormal: false,
        minimumStintMs: 300_000,
        halfBufferFraction: 0.15,
      },
      1,
      "normal",
    );
    expect(input.slots.some((slot) => slot.position === "AM")).toBe(true);
    const result = planMatch(input);
    expect(result.status).toBe("feasible");
    expect(
      result.schedule.some((segment) =>
        segment.lineup.some((allocation) => allocation.position === "AM"),
      ),
    ).toBe(true);
    expect(match.status).toBe("preparation");
    expect(match.intervals).toEqual([]);
  });
  it("retains inactive history and existing profile values but refuses new inactive assignments and future formation use", () => {
    let state = apply(createPreparationState(), {
      type: "position.saved",
      position: { code: "AM", label: "Attacking midfield", active: true },
    });
    state = apply(state, {
      type: "profile.saved",
      profile: {
        ...state.profiles[1],
        preferences: ["AM", "CB", "ST"],
        eligiblePositions: ["AM", "CB", "ST"],
      },
    });
    const formation = state.formations.find((item) => item.format === 7)!;
    state = apply(state, {
      type: "formation.saved",
      formation: {
        ...formation,
        slots: formation.slots.map((slot, index) =>
          index === 3 ? { ...slot, position: "AM", label: "AM" } : slot,
        ),
      },
    });
    state = apply(state, {
      type: "fixture.prepared",
      fixtureId: state.fixtures[0].id,
      formationId: formation.id,
    });
    const history = JSON.stringify(state.snapshots);
    state = apply(state, { type: "position.archived", code: "AM" });
    expect(JSON.stringify(state.snapshots)).toBe(history);
    expect(
      state.formations
        .find((item) => item.id === formation.id)!
        .slots.some((slot) => slot.position === "AM"),
    ).toBe(true);
    state = apply(state, {
      type: "profile.saved",
      profile: {
        ...state.profiles.find((item) => item.preferences[0] === "AM")!,
        displayName: "Updated name",
      },
    });
    expect(() =>
      apply(state, {
        type: "profile.saved",
        profile: {
          ...state.profiles[2],
          id: "new-profile",
          playerId: "new-player",
          shirtNumber: null,
          preferences: ["AM", "CB", "ST"],
          eligiblePositions: ["AM", "CB"],
        },
      }),
    ).toThrow(/ranked positions/);
    expect(() =>
      apply(state, {
        type: "formation.saved",
        formation: state.formations.find((item) => item.id === formation.id)!,
      }),
    ).toThrow(/active team positions/);
    expect(() =>
      prepareFixtureSnapshot(state, state.fixtures[0].id, formation.id),
    ).toThrow(/active team positions/);
    state = apply(state, {
      type: "position.saved",
      position: { code: "AM", label: "Attacking midfield", active: true },
    });
    expect(
      prepareFixtureSnapshot(
        state,
        state.fixtures[0].id,
        formation.id,
      ).formation.slots.some((slot) => slot.position === "AM"),
    ).toBe(true);
  });
  it("carries only public catalogue metadata in the strict own-player DTO and validates dynamic codes", () => {
    let state = apply(createPreparationState(), {
      type: "position.saved",
      position: { code: "AM", label: "Attacking midfield", active: true },
    });
    state = apply(state, {
      type: "profile.saved",
      profile: {
        ...state.profiles[1],
        preferences: ["AM", "CB", "ST"],
        eligiblePositions: ["AM", "CB"],
      },
    });
    const profile = state.profiles.find(
      (item) => item.preferences[0] === "AM",
    )!;
    const dto = projectOwnPlayerPreparation(
        state,
        profile,
        state.activeSeasonId,
      ),
      scope = {
        teamId: state.team.id,
        seasonId: state.activeSeasonId,
        playerId: profile.playerId,
      };
    expect(parseOwnPlayerPreparation(dto, scope)).toEqual(dto);
    expect(dto.positionCatalogue).toContainEqual({
      code: "AM",
      label: "Attacking midfield",
      active: true,
    });
    expect(JSON.stringify(dto)).not.toContain(
      state.profiles.find((item) => item.playerId !== profile.playerId)!
        .displayName,
    );
    expect(() =>
      parseOwnPlayerPreparation(
        {
          ...dto,
          positionCatalogue: [
            ...(dto.positionCatalogue ?? []),
            { code: "private", label: "Invalid", active: true },
          ],
        },
        scope,
      ),
    ).toThrow(/authorised/);
    expect(() =>
      parseOwnPlayerPreparation(
        {
          ...dto,
          profile: { ...dto.profile, preferences: ["ZZ", "CB", "ST"] },
        },
        scope,
      ),
    ).toThrow(/authorised/);
  });
  it("preserves command replay and rejects stale catalogue drafts before changing state", () => {
    const before = createPreparationState(),
      command: PreparationCommand = {
        id: "same-position-command",
        expectedRevision: 0,
        type: "position.saved",
        position: { code: "AM", label: "Attacking midfield", active: true },
      };
    const after = reducePreparation(before, command);
    expect(reducePreparation(after, command)).toBe(after);
    expect(() =>
      reducePreparation(after, { ...command, id: "stale-position-command" }),
    ).toThrow(/changed/);
    expect(before.positionCatalogue).toHaveLength(8);
  });
});
