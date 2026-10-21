import { describe, expect, it } from "vitest";
import { createPreparationState, type PreparationFixture } from "./preparation";
import {
  parseOwnPlayerPreparation,
  playerFixtureDetailLabels,
  projectOwnPlayerPreparation,
} from "./player-preparation";
const stateForTest = () => createPreparationState();
function fixture() {
  const state = stateForTest();
  const profile = state.profiles[0];
  return {
    state,
    profile,
    scope: {
      teamId: state.team.id,
      seasonId: profile.seasonId,
      playerId: profile.playerId,
    },
  };
}
describe("UI07 own-player recorded fixture detail boundary", () => {
  it("projects recorded details and only the current profile response in the authorised season", () => {
    const { state, profile, scope } = fixture(),
      current = state.fixtures[0],
      other = state.profiles[1];
    current.arrival = "08:35";
    current.kickoff = "09:05";
    current.format = 5;
    current.plannedHalfDurationMs = 1_050_000;
    current.responses = {
      [profile.id]: "unavailable",
      [other.id]: "available",
    };
    current.attendance = { [profile.id]: "absent", [other.id]: "present" };
    Object.assign(current, { managerNotes: "private preparation note" });
    Object.assign(profile, { privateNotes: "private profile extra" });
    Object.assign(state.seasons[0], { internalNotes: "private season extra" });
    state.fixtures.push({
      ...current,
      id: "other-season-fixture",
      seasonId: "other-season",
    });
    state.training.push({
      ...state.training[0],
      id: "other-season-training",
      seasonId: "other-season",
    });
    const dto = projectOwnPlayerPreparation(state, profile, scope.seasonId),
      parsed = parseOwnPlayerPreparation(dto, scope);
    expect(parsed.fixtures).toHaveLength(1);
    expect(parsed.fixtures[0]).toMatchObject({
      arrival: "08:35",
      kickoff: "09:05",
      format: 5,
      plannedHalfDurationMs: 1_050_000,
      response: "unavailable",
      attendance: "absent",
    });
    expect(
      parsed.training.some((item) => item.id === "other-season-training"),
    ).toBe(false);
    const text = JSON.stringify(dto);
    for (const privateValue of [
      other.playerId,
      "managerNotes",
      "private preparation note",
      "private profile extra",
      "private season extra",
      "other-season-fixture",
      "other-season-training",
      "selectedProfileIds",
      "responses",
      "formations",
      "snapshots",
    ])
      expect(text).not.toContain(privateValue);
    dto.profile.preferences[0] = "ST";
    expect(profile.preferences[0]).toBe("GK");
  });
  it("does not fill unknown old fixture fields from current team defaults", () => {
    const { state, profile, scope } = fixture();
    const old = state.fixtures[0] as Partial<PreparationFixture>;
    delete old.arrival;
    delete old.format;
    delete old.plannedHalfDurationMs;
    state.team.defaultPitchPlaces = 11;
    state.team.defaultHalfDurationMs = 2_100_000;
    const dto = projectOwnPlayerPreparation(state, profile, scope.seasonId);
    expect(dto.fixtures[0]).toMatchObject({
      arrival: null,
      format: null,
      plannedHalfDurationMs: null,
    });
    expect(parseOwnPlayerPreparation(dto, scope).fixtures[0]).toMatchObject({
      arrival: null,
      format: null,
      plannedHalfDurationMs: null,
    });
    expect(playerFixtureDetailLabels(dto.fixtures[0])).toMatchObject({
      arrival: "Arrival: Not recorded",
      format: "Format: Not recorded",
      duration: "Planned duration: Not recorded",
    });
  });
  it("rejects stale team/season/player scope and private extras before the UI attaches a response", () => {
    const { state, profile, scope } = fixture(),
      dto = projectOwnPlayerPreparation(state, profile, scope.seasonId);
    for (const changed of [
      { ...scope, teamId: "other-team" },
      { ...scope, seasonId: "other-season" },
      { ...scope, playerId: "other-player" },
    ])
      expect(() => parseOwnPlayerPreparation(dto, changed)).toThrow();
    for (const changed of [
      { ...dto, profiles: state.profiles },
      { ...dto, profile: { ...dto.profile, managerNotes: "private" } },
      {
        ...dto,
        fixtures: [
          { ...dto.fixtures[0], responses: state.fixtures[0].responses },
        ],
      },
      { ...dto, fixtures: [dto.fixtures[0], dto.fixtures[0]] },
      { ...dto, fixtures: [{ ...dto.fixtures[0], format: 12 }] },
      { ...dto, fixtures: [{ ...dto.fixtures[0], plannedHalfDurationMs: 0 }] },
    ])
      expect(() => parseOwnPlayerPreparation(changed, scope)).toThrow();
  });
  it("retains the recorded whole-second plan and makes no actual-duration claim", () => {
    expect(
      playerFixtureDetailLabels({
        arrival: "08:35",
        kickoff: "09:05",
        format: 5,
        plannedHalfDurationMs: 1_050_000,
      }),
    ).toEqual({
      arrival: "Arrival: 08:35",
      kickoff: "Kick-off: 09:05",
      format: "Format: 5-a-side",
      duration: "Planned duration: 2 × 17 min 30 sec",
    });
    expect(
      playerFixtureDetailLabels({
        format: 11,
        plannedHalfDurationMs: 1_500_000,
      }).duration,
    ).toBe("Planned duration: 2 × 25 min");
    expect(
      playerFixtureDetailLabels({
        arrival: "unknown",
        format: 99,
        plannedHalfDurationMs: -1,
      }),
    ).toMatchObject({
      arrival: "Arrival: Not recorded",
      format: "Format: Not recorded",
      duration: "Planned duration: Not recorded",
    });
  });
  it("refuses an inactive or unrelated profile without changing the authorised state", () => {
    const { state, profile, scope } = fixture(),
      before = JSON.stringify(state);
    for (const changed of [
      { ...profile, active: false },
      { ...profile, seasonId: "other-season" },
      { ...profile, id: "other-profile" },
    ])
      expect(() =>
        projectOwnPlayerPreparation(state, changed, scope.seasonId),
      ).toThrow();
    expect(JSON.stringify(state)).toBe(before);
  });
});
