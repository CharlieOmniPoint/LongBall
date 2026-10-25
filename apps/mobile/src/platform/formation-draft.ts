import {
  formationFromPattern,
  parseFormationPattern,
  patternFromFormation,
} from "@longball/application/formation-pattern";
import type { PreparationFormation } from "@longball/application/preparation";

export type FormationDraftSource = Omit<PreparationFormation, "version">;

/** PostgreSQL JSON ordering is not an edit; only modeled formation values count. */
export function formationDraftFingerprint(
  formation: FormationDraftSource,
): string {
  return JSON.stringify({
    id: formation.id,
    name: formation.name,
    format: formation.format,
    slots: formation.slots.map(({ id, label, position, x, y }) => ({
      id,
      label,
      position,
      x,
      y,
    })),
  });
}

/** Opening a saved layout must not reinterpret its roles, labels or coordinates. */
export function previewFormationDraft(input: {
  source: FormationDraftSource | null;
  pattern: string;
  format: number;
  id: string;
  name: string;
  slotOverrides: Readonly<Record<string, string>>;
}): {
  formation: FormationDraftSource;
  preservesSavedLayout: boolean;
  customLayout: boolean;
} {
  const savedPattern = input.source ? patternFromFormation(input.source) : null;
  let preservesSavedLayout = false;
  if (input.source?.format === input.format) {
    if (savedPattern === null) preservesSavedLayout = !input.pattern.trim();
    else {
      try {
        preservesSavedLayout =
          parseFormationPattern(input.pattern, input.format).join("-") ===
          savedPattern;
      } catch {
        // Invalid edits still go through the normal formation validation below.
      }
    }
  }
  const base =
    preservesSavedLayout && input.source
      ? {
          id: input.id,
          name: input.name.trim() || savedPattern || input.source.name,
          format: input.source.format,
          slots: input.source.slots,
        }
      : formationFromPattern(input);
  return {
    formation: {
      ...base,
      slots: base.slots.map((slot) => {
        const position = input.slotOverrides[slot.id];
        return position === undefined || position === slot.position
          ? { ...slot }
          : { ...slot, position, label: position };
      }),
    },
    preservesSavedLayout,
    customLayout: preservesSavedLayout && savedPattern === null,
  };
}
