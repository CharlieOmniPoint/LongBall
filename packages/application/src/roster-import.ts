import {
  validateRosterImport,
  type PlayerProfile,
  type PreparationState,
} from "./preparation";

export const ROSTER_CSV_TEMPLATE =
  "displayName,initials,shirtNumber,foot,preference1,preference2,preference3,eligiblePositions\nFictional Player,FP,20,not_recorded,CM,CB,ST,CM|CB|ST";
export interface RosterImportPreview {
  revision: number;
  seasonId: string;
  profiles: PlayerProfile[];
  errors: string[];
  warnings: string[];
}
/** Bounded RFC4180-style records. Quoted commas/newlines are text, never fields. */
function records(source: string): string[][] {
  if (typeof source !== "string" || source.length > 65_536)
    throw new Error("Paste at most 65,536 characters of CSV.");
  const rows: string[][] = [],
    row: string[] = [];
  let cell = "",
    quoted = false,
    closed = false;
  const endCell = () => {
    row.push(cell);
    cell = "";
    closed = false;
  };
  const endRow = () => {
    endCell();
    if (row.some((value) => value.trim())) rows.push([...row]);
    row.length = 0;
    if (rows.length > 201) throw new Error("Import at most 200 player rows.");
  };
  source = source.replace(/^\uFEFF/, "");
  for (let at = 0; at < source.length; at += 1) {
    const value = source[at];
    if (quoted) {
      if (value === '"') {
        if (source[at + 1] === '"') {
          cell += '"';
          at += 1;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += value;
    } else if (value === ",") endCell();
    else if (value === "\n" || value === "\r") {
      if (value === "\r" && source[at + 1] === "\n") at += 1;
      endRow();
    } else if (value === '"') {
      if (cell || closed) throw new Error("A CSV quote must begin a field.");
      quoted = true;
    } else {
      if (closed)
        throw new Error(
          "Separate a closed quoted field with a comma or new line.",
        );
      cell += value;
    }
  }
  if (quoted) throw new Error("Close every quoted CSV field.");
  endRow();
  return rows;
}
export function previewRosterImport(
  source: string,
  state: PreparationState,
  allocateId: () => string,
): RosterImportPreview {
  const preview: RosterImportPreview = {
    revision: state.revision,
    seasonId: state.activeSeasonId,
    profiles: [],
    errors: [],
    warnings: [],
  };
  try {
    const rows = records(source),
      headers = rows.shift()?.map((value) => value.trim()) ?? [];
    const required = [
      "displayName",
      "initials",
      "preference1",
      "preference2",
      "preference3",
      "eligiblePositions",
    ];
    const allowed = [...required, "playerId", "shirtNumber", "foot"];
    if (
      new Set(headers).size !== headers.length ||
      required.some((name) => !headers.includes(name)) ||
      headers.some((name) => !allowed.includes(name))
    )
      throw new Error(
        "Use the template headers only. Name, initials, three preferences and eligible positions are required; account, contact and date-of-birth fields are not supported.",
      );
    if (!rows.length) throw new Error("Add at least one player row.");
    for (const [index, row] of rows.entries()) {
      try {
        if (row.length !== headers.length)
          throw new Error(
            "Each row must have the same number of fields as the header.",
          );
        const value = Object.fromEntries(
          headers.map((header, at) => [header, row[at].trim()]),
        );
        if (value.shirtNumber && !/^[1-9][0-9]?$/.test(value.shirtNumber))
          throw new Error("Shirt number must be one to 99 or blank.");
        const playerId = value.playerId || allocateId();
        const profile: PlayerProfile = {
          id: allocateId(),
          playerId,
          seasonId: state.activeSeasonId,
          displayName: value.displayName,
          initials: value.initials,
          shirtNumber: value.shirtNumber ? Number(value.shirtNumber) : null,
          foot: (value.foot || "not_recorded") as PlayerProfile["foot"],
          preferences: [
            value.preference1,
            value.preference2,
            value.preference3,
          ] as PlayerProfile["preferences"],
          eligiblePositions: value.eligiblePositions
            .split("|")
            .map((position) =>
              position.trim(),
            ) as PlayerProfile["eligiblePositions"],
          active: true,
        };
        const checked = validateRosterImport(
          { ...state, profiles: [...state.profiles, ...preview.profiles] },
          [profile],
        )[0];
        if (
          state.profiles.some(
            (existing) =>
              existing.displayName.toLocaleLowerCase() ===
              checked.displayName.toLocaleLowerCase(),
          ) ||
          preview.profiles.some(
            (existing) =>
              existing.displayName.toLocaleLowerCase() ===
              checked.displayName.toLocaleLowerCase(),
          )
        )
          preview.warnings.push(
            `Row ${index + 2}: this display name already appears. Confirm these are distinct new players; names are not identity keys.`,
          );
        preview.profiles.push(checked);
      } catch (error) {
        preview.errors.push(
          `Row ${index + 2}: ${error instanceof Error ? error.message : "Invalid player row."}`,
        );
      }
    }
  } catch (error) {
    preview.errors.push(
      error instanceof Error ? error.message : "The CSV could not be read.",
    );
  }
  return preview;
}
