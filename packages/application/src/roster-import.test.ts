import { describe, expect, it } from "vitest";
import { createPreparationState, reducePreparation } from "./preparation";
import { previewRosterImport, ROSTER_CSV_TEMPLATE } from "./roster-import";

const allocate = () => {
  let id = 0;
  return () => `import-identity-${++id}`;
};
describe("roster import boundary", () => {
  it("parses BOM, quoted commas, escaped quotes and CRLF without treating equal initials as identities", () => {
    const state = createPreparationState();
    const csv =
      '\uFEFFdisplayName,initials,shirtNumber,foot,preference1,preference2,preference3,eligiblePositions\r\n"Fictional, \"\"Keeper\"\"",FP,20,both,GK,CB,CM,GK|CB|CM\r\nOther player,FP,21,,CM,CB,ST,CM|CB|ST';
    const preview = previewRosterImport(csv, state, allocate());
    expect(preview.errors).toEqual([]);
    expect(preview.profiles.map((profile) => profile.displayName)).toEqual([
      'Fictional, "Keeper"',
      "Other player",
    ]);
    expect(
      new Set(preview.profiles.map((profile) => profile.playerId)).size,
    ).toBe(2);
    expect(preview.profiles[1].foot).toBe("not_recorded");
  });
  it("rejects account/DOB headers, malformed quotes, invalid preferences and inferred keeper eligibility", () => {
    const state = createPreparationState();
    for (const csv of [
      ROSTER_CSV_TEMPLATE.replace("displayName", "dateOfBirth"),
      ROSTER_CSV_TEMPLATE + '\n"not closed',
      ROSTER_CSV_TEMPLATE.replace("CM,CB,ST,CM|CB|ST", "GK,GK,ST,"),
      "x".repeat(65_537),
    ])
      expect(
        previewRosterImport(csv, state, allocate()).errors.length,
      ).toBeGreaterThan(0);
  });
  it("rejects existing player IDs and duplicate shirts while warning instead of merging coincident names", () => {
    const state = createPreparationState();
    const known = previewRosterImport(
      `playerId,displayName,initials,shirtNumber,foot,preference1,preference2,preference3,eligiblePositions\n${state.profiles[0].playerId},Existing identity,EI,20,not_recorded,CM,CB,ST,CM|CB|ST`,
      state,
      allocate(),
    );
    expect(known.errors.join()).toMatch(/identity already exists/);
    const duplicate = previewRosterImport(
      ROSTER_CSV_TEMPLATE + "\nSecond,SP,20,left,CM,CB,ST,CM|CB|ST",
      state,
      allocate(),
    );
    expect(duplicate.errors.join()).toMatch(/shirt number/);
    const names = previewRosterImport(
      `displayName,initials,shirtNumber,foot,preference1,preference2,preference3,eligiblePositions\n${state.profiles[0].displayName},NP,20,not_recorded,CM,CB,ST,CM|CB|ST`,
      state,
      allocate(),
    );
    expect(names.errors).toEqual([]);
    expect(names.warnings).toHaveLength(1);
  });
  it("commits a batch once, preserving snapshots, attendance, selection and account-independent identities", () => {
    const state = createPreparationState(),
      snapshot = JSON.stringify(state);
    const preview = previewRosterImport(
      ROSTER_CSV_TEMPLATE + "\nOther,OP,21,left,CM,CB,ST,CM|CB|ST",
      state,
      allocate(),
    );
    const command = {
      id: "import-batch-1",
      expectedRevision: state.revision,
      type: "roster.imported" as const,
      profiles: preview.profiles,
      confirmNewPlayers: true as const,
    };
    const saved = reducePreparation(state, command);
    expect(saved.revision).toBe(state.revision + 1);
    expect(saved.audit).toHaveLength(state.audit.length + 1);
    expect(saved.profiles).toHaveLength(state.profiles.length + 2);
    expect(saved.snapshots).toEqual(state.snapshots);
    expect(saved.fixtures).toEqual(state.fixtures);
    expect(saved.training).toEqual(state.training);
    expect(reducePreparation(saved, command)).toBe(saved);
    expect(JSON.stringify(state)).toBe(snapshot);
    expect(() =>
      reducePreparation(saved, { ...command, profiles: [] }),
    ).toThrow(/different content/);
    expect(() =>
      reducePreparation(saved, { ...command, id: "new-import" }),
    ).toThrow(/changed on another screen/);
  });
  it("rejects the entire batch on a late invalid row, foreign season or unknown contact fields", () => {
    const state = createPreparationState(),
      snapshot = JSON.stringify(state),
      preview = previewRosterImport(ROSTER_CSV_TEMPLATE, state, allocate());
    const command = {
      id: "atomic-import",
      expectedRevision: state.revision,
      type: "roster.imported" as const,
      confirmNewPlayers: true as const,
      profiles: [
        preview.profiles[0],
        {
          ...preview.profiles[0],
          id: "different-profile",
          playerId: "different-player",
        },
      ],
    };
    expect(() => reducePreparation(state, command)).toThrow(/shirt number/);
    for (const profile of [
      { ...preview.profiles[0], seasonId: "other-season" },
      { ...preview.profiles[0], contact: "not-supported" },
      { ...preview.profiles[0], initials: "X\n" },
      { ...preview.profiles[0], playerId: "opaque-player\n" },
    ])
      expect(() =>
        reducePreparation(state, { ...command, profiles: [profile] }),
      ).toThrow();
    expect(() =>
      reducePreparation(state, { ...command, profiles: Array(2) }),
    ).toThrow();
    expect(() =>
      reducePreparation(state, {
        ...command,
        id: "import\n",
        profiles: preview.profiles,
      }),
    ).toThrow(/stable roster import/);
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});
