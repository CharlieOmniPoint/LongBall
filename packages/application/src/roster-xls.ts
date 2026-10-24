import * as XLSX from "@e965/xlsx";
import {
  validateRosterProformaImport,
  type PlayerProfile,
  type PreparationState,
} from "./preparation";
import type { RosterImportPreview } from "./roster-import";

export const ROSTER_XLS_MIME = "application/vnd.ms-excel";
export const MAX_ROSTER_XLS_BYTES = 2 * 1024 * 1024;
const headers = [
  "profileId",
  "playerId",
  "displayName",
  "initials",
  "shirtNumber",
  "faPlayerId",
  "foot",
  "preference1",
  "preference2",
  "preference3",
  "eligiblePositions",
];
const safeText = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string" && typeof value !== "number")
    throw new Error("Use text or numbers only in player cells.");
  const text = String(value).trim();
  if (
    text.length > 300 ||
    /^[=+@-]/.test(text) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)
  )
    throw new Error(
      "Player cells cannot contain formulas, control characters or text longer than 300 characters.",
    );
  return text;
};
export function rosterXlsFileName(state: PreparationState): string {
  return `${state.team.name.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 60) || "team"}-player-proforma.xls`;
}
/** Genuine BIFF8/OLE Excel workbook. Every cell is a string, never an executable formula. */
export function createRosterXls(
  state: PreparationState,
  includePlayers = true,
): Uint8Array {
  const rows: string[][] = [headers];
  if (includePlayers)
    for (const profile of state.profiles.filter(
      (p) => p.active && p.seasonId === state.activeSeasonId,
    ))
      rows.push([
        profile.id,
        profile.playerId,
        profile.displayName,
        profile.initials,
        profile.shirtNumber === null ? "" : String(profile.shirtNumber),
        profile.faPlayerId ?? "",
        profile.foot,
        profile.preferences[0] ?? "",
        profile.preferences[1] ?? "",
        profile.preferences[2] ?? "",
        profile.eligiblePositions.join("|"),
      ]);
  // Preformat all supported new rows as text so Excel preserves identifiers such as 0012345678.
  while (rows.length < 201) rows.push(headers.map(() => ""));
  const workbook = XLSX.utils.book_new();
  const players = XLSX.utils.aoa_to_sheet(rows);
  players["!cols"] = headers.map((header) => ({
    wch:
      header === "displayName" ? 28 : header === "eligiblePositions" ? 25 : 20,
  }));
  for (const [key, cell] of Object.entries(players))
    if (!key.startsWith("!") && cell && typeof cell === "object") {
      cell.t = "s";
      cell.z = "@";
    }
  XLSX.utils.book_append_sheet(workbook, players, "Players");
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["version", "clubId", "teamId", "seasonId"],
      ["1", state.club.id, state.team.id, state.activeSeasonId],
    ]),
    "LongBall",
  );
  return new Uint8Array(
    XLSX.write(workbook, { bookType: "biff8", type: "array", bookSST: true }),
  );
}
export function previewRosterXls(
  bytes: Uint8Array,
  state: PreparationState,
  allocateId: () => string,
): RosterImportPreview {
  const result: RosterImportPreview = {
    revision: state.revision,
    seasonId: state.activeSeasonId,
    profiles: [],
    errors: [],
    warnings: [],
  };
  try {
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.length < 512 ||
      bytes.length > MAX_ROSTER_XLS_BYTES ||
      ![0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every(
        (byte, i) => bytes[i] === byte,
      )
    )
      throw new Error(
        "Choose the downloaded Excel .xls proforma, at most 2 MB. CSV, HTML and renamed files are not Excel workbooks.",
      );
    const workbook = XLSX.read(bytes, {
      type: "array",
      sheetRows: 202,
      cellFormula: true,
      cellHTML: false,
      cellStyles: false,
      bookVBA: true,
    });
    if (
      workbook.vbaraw ||
      workbook.SheetNames.length !== 2 ||
      workbook.SheetNames[0] !== "Players" ||
      workbook.SheetNames[1] !== "LongBall"
    )
      throw new Error(
        "Use the Players and LongBall sheets from the downloaded proforma. Macros and extra sheets are not supported.",
      );
    for (const sheet of Object.values(workbook.Sheets)) {
      const range = XLSX.utils.decode_range(
        sheet["!fullref"] ?? sheet["!ref"] ?? "A1",
      );
      if (range.e.r > 200 || range.e.c > 10)
        throw new Error(
          "Import at most 200 player rows and the original columns.",
        );
      for (const [key, cell] of Object.entries(sheet))
        if (
          !key.startsWith("!") &&
          cell &&
          typeof cell === "object" &&
          ("f" in cell || cell.t === "e")
        )
          throw new Error(
            "Formulas and cell errors are not supported. Replace them with ordinary text before importing.",
          );
    }
    const scope = XLSX.utils.sheet_to_json<unknown[]>(
      workbook.Sheets.LongBall,
      { header: 1, raw: true, defval: "" },
    );
    if (
      scope.length !== 2 ||
      JSON.stringify(scope[0]) !==
        JSON.stringify(["version", "clubId", "teamId", "seasonId"]) ||
      JSON.stringify(scope[1]?.map(String)) !==
        JSON.stringify([
          "1",
          state.club.id,
          state.team.id,
          state.activeSeasonId,
        ])
    )
      throw new Error(
        "This proforma belongs to another club, team or season. Download a fresh proforma for the selected team.",
      );
    const rows = XLSX.utils
      .sheet_to_json<unknown[]>(workbook.Sheets.Players, {
        header: 1,
        raw: true,
        defval: "",
        blankrows: false,
      })
      .filter((row) =>
        row.some(
          (cell) =>
            cell !== null && cell !== undefined && String(cell).trim() !== "",
        ),
      );
    if (JSON.stringify(rows.shift()) !== JSON.stringify(headers))
      throw new Error(
        "Keep the downloaded column names and order unchanged. Contact, account and birth-date fields are not supported.",
      );
    if (!rows.length || rows.length > 200)
      throw new Error("Add between one and 200 player rows.");
    const profiles: PlayerProfile[] = [];
    for (const [at, row] of rows.entries()) {
      try {
        if (row.length !== headers.length)
          throw new Error("Keep all eleven columns, including blank cells.");
        const cells = row.map(safeText),
          value = Object.fromEntries(headers.map((key, i) => [key, cells[i]]));
        const existing = value.profileId
          ? state.profiles.find(
              (p) =>
                p.id === value.profileId &&
                p.seasonId === state.activeSeasonId &&
                p.active,
            )
          : undefined;
        if (value.profileId && !existing)
          throw new Error(
            "An existing profile ID must belong to this team and active season. Leave both identity cells blank for a new player.",
          );
        if (!value.profileId && value.playerId)
          throw new Error("Leave both identity cells blank for a new player.");
        if (existing && value.playerId !== existing.playerId)
          throw new Error("Keep the downloaded player identity unchanged.");
        if (value.shirtNumber && !/^[1-9][0-9]?$/.test(value.shirtNumber))
          throw new Error("Shirt number must be one to 99 or blank.");
        profiles.push({
          id: existing?.id ?? allocateId(),
          playerId: existing?.playerId ?? allocateId(),
          seasonId: state.activeSeasonId,
          displayName: value.displayName,
          initials: value.initials,
          shirtNumber: value.shirtNumber ? Number(value.shirtNumber) : null,
          faPlayerId: value.faPlayerId || null,
          foot: (value.foot || "not_recorded") as PlayerProfile["foot"],
          preferences: [
            value.preference1,
            value.preference2,
            value.preference3,
          ],
          eligiblePositions: value.eligiblePositions
            .split("|")
            .map((p) => p.trim()),
          active: true,
        });
      } catch (error) {
        result.errors.push(
          `Row ${at + 2}: ${error instanceof Error ? error.message : "Invalid player row."}`,
        );
      }
    }
    if (!result.errors.length)
      result.profiles = validateRosterProformaImport(state, profiles);
    const updated = result.profiles.filter((p) =>
      state.profiles.some((old) => old.id === p.id),
    ).length;
    if (updated)
      result.warnings.push(
        `${updated} existing player row${updated === 1 ? "" : "s"} will be updated using the downloaded identities. Omitted players are retained.`,
      );
  } catch (error) {
    result.errors.push(
      error instanceof Error
        ? error.message
        : "The Excel workbook could not be read.",
    );
  }
  return result;
}
