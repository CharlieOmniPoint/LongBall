import { describe, expect, it } from "vitest";
import { formationFromPattern } from "@longball/application/formation-pattern";
import {
  formationDraftFingerprint,
  previewFormationDraft,
  type FormationDraftSource,
} from "./formation-draft";

const saved: FormationDraftSource = {
  ...formationFromPattern({
    pattern: "2-3-1",
    format: 7,
    id: "saved",
    name: "Wide team",
  }),
  slots: formationFromPattern({
    pattern: "2-3-1",
    format: 7,
    id: "saved",
  }).slots.map((slot, index) => ({
    ...slot,
    id: `custom-place-${index}`,
    label: index === 1 ? "Left defender" : slot.label,
    position: index === 1 ? "LB" : slot.position,
    x: index === 1 ? 0.12 : slot.x,
  })),
};
const draft = (
  patch: Partial<Parameters<typeof previewFormationDraft>[0]> = {},
) =>
  previewFormationDraft({
    source: saved,
    pattern: "2-3-1",
    format: 7,
    id: saved.id,
    name: saved.name,
    slotOverrides: {},
    ...patch,
  });

describe("saved formation editing", () => {
  it("recognizes a matching saved receipt despite object-key ordering", () => {
    const reordered = {
      name: saved.name,
      slots: saved.slots.map((slot) => ({
        x: slot.x,
        position: slot.position,
        y: slot.y,
        id: slot.id,
        label: slot.label,
      })),
      format: saved.format,
      id: saved.id,
    };
    expect(formationDraftFingerprint(reordered)).toBe(
      formationDraftFingerprint(saved),
    );
    expect(formationDraftFingerprint({ ...saved, name: "Different" })).not.toBe(
      formationDraftFingerprint(saved),
    );
  });
  it("preserves exact saved identities, custom roles, labels and geometry when reopened or renamed", () => {
    const reopened = draft();
    expect(reopened.preservesSavedLayout).toBe(true);
    expect(reopened.formation).toEqual(saved);
    expect(reopened.formation.slots).not.toBe(saved.slots);
    expect(reopened.formation.slots[1]).not.toBe(saved.slots[1]);
    expect(draft({ name: "Renamed team" }).formation).toEqual({
      ...saved,
      name: "Renamed team",
    });
    expect(draft({ pattern: " 2 – 3 - 1 " }).formation.slots).toEqual(
      saved.slots,
    );
    const versioned = { ...saved, version: 4 };
    expect(draft({ source: versioned }).formation).toEqual(saved);
    expect(draft({ source: versioned }).formation).not.toHaveProperty(
      "version",
    );
  });

  it("changes only the explicitly edited role and restores its saved label when reverted", () => {
    const slot = saved.slots[1];
    const changed = draft({ slotOverrides: { [slot.id]: "RB" } });
    expect(changed.formation.slots[1]).toEqual({
      ...slot,
      position: "RB",
      label: "RB",
    });
    expect(
      changed.formation.slots.filter((item) => item.id !== slot.id),
    ).toEqual(saved.slots.filter((item) => item.id !== slot.id));
    expect(
      draft({ slotOverrides: { [slot.id]: slot.position } }).formation,
    ).toEqual(saved);
  });

  it("regenerates a layout only for an intentional different pattern or format", () => {
    const changed = draft({ pattern: "3-2-1" });
    expect(changed.preservesSavedLayout).toBe(false);
    expect(changed.formation).toEqual(
      formationFromPattern({
        pattern: "3-2-1",
        format: 7,
        id: saved.id,
        name: saved.name,
      }),
    );
    expect(
      draft({ format: 11, pattern: "4-4-2" }).formation.slots,
    ).toHaveLength(11);
    expect(() => draft({ pattern: "4-4-2" })).toThrow(/total/);
    expect(() => draft({ pattern: "" })).toThrow(/Use 2 to 5/);
  });

  it("retains free-position layouts that have no traditional pattern until an explicit replacement", () => {
    const custom = {
      ...saved,
      slots: saved.slots.map((slot, index) => ({
        ...slot,
        y: index === 0 ? 0.93 : 0.08 + index * 0.1,
      })),
    };
    const reopened = draft({ source: custom, pattern: "" });
    expect(reopened.customLayout).toBe(true);
    expect(reopened.formation).toEqual(custom);
    expect(
      draft({ source: custom, pattern: "3-2-1" }).preservesSavedLayout,
    ).toBe(false);
    expect(() => draft({ source: custom, pattern: "4-4-2" })).toThrow(/total/);
  });
});
