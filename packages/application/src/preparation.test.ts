import { describe, expect, it } from "vitest";
import {
  createPreparationState,
  defaultFormation,
  effectiveLogo,
  goalkeeperChoice,
  prepareFixtureSnapshot,
  reducePreparation,
  seasonBounds,
  seasonPlayers,
  trainingAttendanceEvidence,
  type PreparationCommand,
  type PreparationState,
} from "./preparation";

type Payload = PreparationCommand extends infer Command
  ? Command extends PreparationCommand
    ? Omit<Command, "id" | "expectedRevision">
    : never
  : never;
function apply(state: PreparationState, payload: Payload) {
  return reducePreparation(state, {
    ...payload,
    id: `command-${state.revision + 1}`,
    expectedRevision: state.revision,
  } as PreparationCommand);
}
function teamChange(
  state: PreparationState,
  changes: Partial<PreparationState["team"]> = {},
): Extract<Payload, { type: "team.updated" }> {
  const { id: _id, ...settings } = state.team;
  return { type: "team.updated", ...settings, ...changes };
}

describe("F01 club and team preparation", () => {
  it("preserves a team badge override when the club changes, then restores inheritance without touching players", () => {
    let state = createPreparationState();
    const profiles = JSON.stringify(state.profiles);
    state = apply(state, teamChange(state, { logo: "shield" }));
    state = apply(state, {
      type: "club.updated",
      name: "Fictional Rovers",
      logo: "ball",
    });
    expect(effectiveLogo(state)).toBe("shield");
    state = apply(state, teamChange(state, { logo: null }));
    expect(effectiveLogo(state)).toBe("ball");
    expect(JSON.stringify(state.profiles)).toBe(profiles);
    expect(Object.keys(state.team).sort()).toEqual([
      "ageGroup",
      "defaultHalfDurationMs",
      "defaultPitchPlaces",
      "id",
      "logo",
      "name",
    ]);
  });
  it("does not let team defaults rewrite an existing fixture override", () => {
    let state = createPreparationState();
    const fixture = state.fixtures[0];
    state = apply(state, {
      type: "fixture.saved",
      fixture: { ...fixture, plannedHalfDurationMs: 1_200_000 },
    });
    state = apply(
      state,
      teamChange(state, {
        defaultHalfDurationMs: 1_800_000,
        defaultPitchPlaces: 9,
      }),
    );
    expect(state.fixtures.find(item => item.id === fixture.id)?.plannedHalfDurationMs).toBe(1_200_000);
    expect(state.fixtures[0].format).toBe(7);
  });
});

describe("F02/F03/F04 team-season history and player snapshots", () => {
  it("creates exact September-to-August seasons and explicitly requires spectator renewal", () => {
    let state = createPreparationState();
    const originalProfiles = JSON.stringify(state.profiles);
    const originalFixture = JSON.stringify(state.fixtures[0]);
    expect(seasonBounds(2026)).toEqual({
      label: "2026/27",
      startDate: "2026-09-01",
      endDate: "2027-08-31",
    });
    state = apply(state, {
      type: "season.rolled_over",
      idForSeason: "synthetic-season-2027-28",
      startYear: 2027,
      copyPlayers: true,
      confirmSpectatorRenewal: true,
    });
    expect(state.seasons[1].spectatorRenewalRequired).toBe(true);
    expect(seasonPlayers(state)).toHaveLength(13);
    expect(JSON.stringify(state.profiles.slice(0, 13))).toBe(originalProfiles);
    expect(JSON.stringify(state.fixtures[0])).toBe(originalFixture);
    expect(state.profiles[0].playerId).toBe(state.profiles[13].playerId);
    expect(state.profiles[0].id).not.toBe(state.profiles[13].id);
    expect(state.training).toHaveLength(createPreparationState().training.length);
    expect(state.fixtures).toHaveLength(createPreparationState().fixtures.length);
    expect(() =>
      apply(state, {
        type: "profile.saved",
        profile: { ...state.profiles[0], displayName: "Changed old season" },
      }),
    ).toThrow(/read-only/);
  });
  it("does not accept an implicit renewal, a duplicate season, or skipped years", () => {
    const state = createPreparationState();
    expect(() =>
      apply(state, {
        type: "season.rolled_over",
        idForSeason: "next",
        startYear: 2027,
        copyPlayers: false,
        confirmSpectatorRenewal: false as true,
      }),
    ).toThrow(/Confirm/);
    expect(() =>
      apply(state, {
        type: "season.rolled_over",
        idForSeason: "later",
        startYear: 2028,
        copyPlayers: true,
        confirmSpectatorRenewal: true,
      }),
    ).toThrow(/immediately following/);
  });
  it("allows colliding pitch initials while preserving distinct identities and unique shirts", () => {
    let state = createPreparationState();
    const first = state.profiles[0];
    const second = state.profiles[1];
    state = apply(state, {
      type: "profile.saved",
      profile: { ...first, initials: "AB" },
    });
    state = apply(state, {
      type: "profile.saved",
      profile: { ...second, initials: "AB" },
    });
    expect(
      new Set(state.profiles.map((profile) => profile.playerId)).size,
    ).toBe(13);
    expect(() =>
      apply(state, {
        type: "profile.saved",
        profile: { ...second, shirtNumber: first.shirtNumber },
      }),
    ).toThrow(/shirt number/);
  });
  it("retains prepared preference/formation snapshots when profiles and reusable templates change", () => {
    let state = createPreparationState();
    const fixtureId = state.fixtures[0].id;
    state = apply(state, {
      type: "fixture.prepared",
      fixtureId,
      formationId: "formation-7",
    });
    const snapshot = JSON.stringify(state.snapshots[0]);
    const profile = state.profiles[1];
    state = apply(state, {
      type: "profile.saved",
      profile: { ...profile, preferences: ["ST", "LW", "CM"] },
    });
    const { version: _version, ...formation } = state.formations.find(
      (item) => item.id === "formation-7",
    )!;
    state = apply(state, {
      type: "formation.saved",
      formation: {
        ...formation,
        name: "New positions",
        slots: formation.slots.map((slot) => ({ ...slot, x: 1 - slot.x })),
      },
    });
    expect(JSON.stringify(state.snapshots[0])).toBe(snapshot);
    expect(
      state.formations.find((item) => item.id === "formation-7")?.version,
    ).toBe(2);
  });
  it("requires three distinct preferences and explicit keeper eligibility; third-choice GK is not enough", () => {
    const state = createPreparationState();
    const profile = state.profiles[0];
    expect(() =>
      apply(state, {
        type: "profile.saved",
        profile: { ...profile, preferences: ["GK", "GK", "CB"] },
      }),
    ).toThrow(/three different/);
    expect(
      goalkeeperChoice({ ...profile, preferences: ["CB", "ST", "GK"] }),
    ).toBe(0);
    expect(
      goalkeeperChoice({ ...profile, preferences: ["CB", "GK", "ST"] }),
    ).toBe(2);
    expect(
      goalkeeperChoice({ ...profile, eligiblePositions: ["CB", "ST"] }),
    ).toBe(0);
  });
});

describe("F06/F07 fixture, availability and attendance boundaries", () => {
  it("reschedules a postponed fixture with the same identity, historical dates and separate existing replies", () => {
    let state = createPreparationState();
    const fixtureId = state.fixtures[0].id;
    const responses = JSON.stringify(state.fixtures.find(item => item.id === fixtureId)!.responses);
    state = apply(state, {
      type: "fixture.status_changed",
      fixtureId,
      status: "postponed",
    });
    state = apply(state, {
      type: "fixture.saved",
      fixture: {
        ...state.fixtures.find(item => item.id === fixtureId)!,
        playedDate: "2026-11-07",
        kickoff: "11:30",
      },
    });
    expect(state.fixtures.find(item => item.id === fixtureId)!.id).toBe(fixtureId);
    expect(state.fixtures.find(item => item.id === fixtureId)!.status).toBe("scheduled");
    expect(state.fixtures.find(item => item.id === fixtureId)!.history.map((item) => item.action)).toEqual([
      "created",
      "postponed",
      "rescheduled",
    ]);
    expect(JSON.stringify(state.fixtures.find(item => item.id === fixtureId)!.responses)).toBe(responses);
    expect(state.fixtures.find(item => item.id === fixtureId)!.attendance).toEqual({});
  });
  it("never treats a reply, selection or cancellation as actual attendance", () => {
    let state = createPreparationState();
    const fixtureId = state.fixtures[0].id;
    const profile = state.profiles[10];
    state = apply(state, {
      type: "fixture.response_recorded",
      fixtureId,
      profileId: profile.id,
      response: "available",
    });
    expect(state.fixtures[0].selectedProfileIds).not.toContain(profile.id);
    expect(state.fixtures[0].attendance[profile.id]).toBeUndefined();
    state = apply(state, {
      type: "fixture.selection_saved",
      fixtureId,
      selectedProfileIds: [...state.fixtures[0].selectedProfileIds, profile.id],
    });
    expect(state.fixtures[0].attendance[profile.id]).toBeUndefined();
    state = apply(state, {
      type: "fixture.status_changed",
      fixtureId,
      status: "cancelled",
    });
    expect(state.fixtures[0].attendance).toEqual({});
    expect(() =>
      apply(state, {
        type: "fixture.attendance_recorded",
        fixtureId,
        profileId: profile.id,
        attendance: "absent",
      }),
    ).toThrow(/scheduled/);
  });
  it("requires a genuine selected player for check-in and preserves explicit unknown attendance", () => {
    const state = createPreparationState();
    const fixtureId = state.fixtures[0].id;
    expect(() =>
      apply(state, {
        type: "fixture.attendance_recorded",
        fixtureId,
        profileId: state.profiles[12].id,
        attendance: "present",
      }),
    ).toThrow(/selected/);
    const snapshot = prepareFixtureSnapshot(state, fixtureId);
    expect(snapshot.selectedPlayerIds).toHaveLength(9);
    expect(Object.values(snapshot.attendance)).toEqual(
      Array(9).fill("not_recorded"),
    );
  });
  it("rejects invalid or out-of-season dates and invalid formats without mutating the fixture", () => {
    const state = createPreparationState();
    const fixture = state.fixtures[0];
    const before = JSON.stringify(state);
    for (const playedDate of ["2026-02-30", "2027-09-01", "not-a-date"])
      expect(() =>
        apply(state, {
          type: "fixture.saved",
          fixture: { ...fixture, playedDate },
        }),
      ).toThrow(/valid date/);
    expect(() =>
      apply(state, {
        type: "fixture.saved",
        fixture: { ...fixture, kickoff: "25:00" },
      }),
    ).toThrow(/HH:MM/);
    expect(() =>
      apply(state, {
        type: "fixture.saved",
        fixture: { ...fixture, format: 4 },
      }),
    ).toThrow(/five to eleven/);
    expect(JSON.stringify(state)).toBe(before);
  });
  it("cannot prepare a cancelled game, missing keeper, duplicate squad, or insufficient squad", () => {
    let state = createPreparationState();
    const fixtureId = state.fixtures[0].id;
    expect(() =>
      apply(state, {
        type: "fixture.selection_saved",
        fixtureId,
        selectedProfileIds: [state.profiles[0].id, state.profiles[0].id],
      }),
    ).toThrow(/only once/);
    state = apply(state, {
      type: "fixture.selection_saved",
      fixtureId,
      selectedProfileIds: state.profiles
        .slice(1, 9)
        .map((profile) => profile.id),
    });
    expect(() => prepareFixtureSnapshot(state, fixtureId)).toThrow(
      /goalkeeper/,
    );
    state = apply(state, {
      type: "fixture.selection_saved",
      fixtureId,
      selectedProfileIds: state.profiles
        .slice(0, 6)
        .map((profile) => profile.id),
    });
    expect(() => prepareFixtureSnapshot(state, fixtureId)).toThrow(
      /enough players/,
    );
    state = apply(state, {
      type: "fixture.status_changed",
      fixtureId,
      status: "cancelled",
    });
    expect(() => prepareFixtureSnapshot(state, fixtureId)).toThrow(/scheduled/);
  });
});

describe("F08 training occurrences and denominator evidence", () => {
  it("keeps expected players, replies and actual attendance distinct until an occurrence was held", () => {
    let state = createPreparationState();
    const training = state.training[0];
    const profileId = state.profiles[0].id;
    state = apply(state, {
      type: "training.response_recorded",
      trainingId: training.id,
      profileId,
      response: "available",
    });
    expect(state.training[0].attendance).toEqual({});
    expect(() =>
      apply(state, {
        type: "training.attendance_recorded",
        trainingId: training.id,
        profileId,
        attendance: "present",
      }),
    ).toThrow(/held/);
    state = apply(state, {
      type: "training.status_changed",
      trainingId: training.id,
      status: "held",
    });
    state = apply(state, {
      type: "training.attendance_recorded",
      trainingId: training.id,
      profileId,
      attendance: "present",
    });
    const evidence = trainingAttendanceEvidence(state)[0];
    expect(evidence.expectedPlayerIds).toContain("synthetic-player-01");
    expect(evidence.responses["synthetic-player-01"]).toBe("available");
    expect(evidence.attendance["synthetic-player-01"]).toBe("present");
    expect(evidence.attendance["synthetic-player-02"]).toBeUndefined();
  });
  it("cancels one recurring occurrence without changing another date or turning missing records into absences", () => {
    let state = createPreparationState();
    const second = JSON.stringify(state.training[1]);
    state = apply(state, {
      type: "training.status_changed",
      trainingId: state.training[0].id,
      status: "cancelled",
    });
    expect(JSON.stringify(state.training[1])).toBe(second);
    expect(state.training[0].attendance).toEqual({});
    expect(
      trainingAttendanceEvidence(state).map((item) => item.eventStatus),
    ).toEqual(["cancelled", ...createPreparationState().training.slice(1).map(item => item.status)]);
  });
});

describe("F09 reusable formation templates and durable command boundaries", () => {
  it("creates formats 5–11 with one keeper and stable, distinct same-role slots", () => {
    for (let format = 5; format <= 11; format += 1) {
      const formation = defaultFormation(format);
      expect(formation.slots).toHaveLength(format);
      expect(
        formation.slots.filter((slot) => slot.position === "GK"),
      ).toHaveLength(1);
      expect(new Set(formation.slots.map((slot) => slot.id)).size).toBe(format);
      expect(
        formation.slots.every(
          (slot) => slot.x > 0 && slot.x < 1 && slot.y > 0 && slot.y < 1,
        ),
      ).toBe(true);
    }
    expect(
      defaultFormation(7)
        .slots.filter((slot) => slot.position === "CB")
        .map((slot) => slot.id),
    ).toEqual(["cb-1", "cb-2"]);
  });
  it("rejects duplicate slot identities and invalid pitch coordinates", () => {
    const state = createPreparationState();
    const { version: _version, ...formation } = defaultFormation(7);
    expect(() =>
      apply(state, {
        type: "formation.saved",
        formation: {
          ...formation,
          slots: formation.slots.map((slot) => ({ ...slot, id: "duplicate" })),
        },
      }),
    ).toThrow(/only once/);
    expect(() =>
      apply(state, {
        type: "formation.saved",
        formation: {
          ...formation,
          slots: formation.slots.map((slot) => ({ ...slot, x: 1.2 })),
        },
      }),
    ).toThrow(/between zero and one/);
  });
  it("deduplicates the same command but rejects changed content and stale overwrites", () => {
    const initial = createPreparationState();
    const command: PreparationCommand = {
      id: "fixed-command",
      expectedRevision: 0,
      type: "club.updated",
      name: "Fictional club",
      logo: "shield",
    };
    const state = reducePreparation(initial, command);
    expect(reducePreparation(state, command)).toBe(state);
    expect(state.audit).toHaveLength(1);
    expect(() =>
      reducePreparation(state, { ...command, name: "Different payload" }),
    ).toThrow(/different content/);
    expect(() =>
      reducePreparation(state, { ...command, id: "stale-command" }),
    ).toThrow(/another screen/);
    expect(initial.club.name).toBe("Richmond Rovers");
    expect(initial.revision).toBe(0);
  });
});
