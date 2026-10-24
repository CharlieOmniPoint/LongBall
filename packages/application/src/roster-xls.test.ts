import { describe, expect, it } from "vitest";
import * as XLSX from "@e965/xlsx";
import { createPreparationState, reducePreparation } from "./preparation";
import { createRosterXls, previewRosterXls } from "./roster-xls";
const allocate = () => {
  let n = 0;
  return () => `xls-new-${++n}`;
};
function change(bytes: Uint8Array, work: (wb: XLSX.WorkBook) => void) {
  const workbook = XLSX.read(bytes, { type: "array" });
  work(workbook);
  return new Uint8Array(
    XLSX.write(workbook, { type: "array", bookType: "biff8" }),
  );
}
// Construct a genuine BIFF8 FORMULA record: the library writer intentionally strips .f.
function withFormula(bytes: Uint8Array): Uint8Array {
  const cfb = XLSX.CFB.read(bytes, { type: "buffer" }),
    entry = XLSX.CFB.find(cfb, "Workbook");
  const source = new Uint8Array(entry.content),
    view = new DataView(source.buffer);
  let at = -1,
    oldLength = 0;
  for (let offset = 0; offset + 4 < source.length; ) {
    const type = view.getUint16(offset, true),
      length = view.getUint16(offset + 2, true);
    if (
      type === 0xfd &&
      view.getUint16(offset + 4, true) === 1 &&
      view.getUint16(offset + 6, true) === 2
    ) {
      at = offset;
      oldLength = length + 4;
      break;
    }
    offset += length + 4;
  }
  if (at < 0) throw new Error("Expected BIFF8 player name cell.");
  const record = new Uint8Array(33),
    rv = new DataView(record.buffer);
  rv.setUint16(0, 6, true);
  rv.setUint16(2, 29, true);
  rv.setUint16(4, 1, true);
  rv.setUint16(6, 2, true);
  rv.setFloat64(10, 2, true);
  rv.setUint16(24, 7, true);
  record.set([0x1e, 1, 0, 0x1e, 1, 0, 3], 26);
  const delta = record.length - oldLength,
    output = new Uint8Array(source.length + delta);
  output.set(source.slice(0, at));
  output.set(record, at);
  output.set(source.slice(at + oldLength), at + record.length);
  const outView = new DataView(output.buffer);
  for (let offset = 0; offset < at; ) {
    const type = outView.getUint16(offset, true),
      length = outView.getUint16(offset + 2, true);
    if (type === 0x85) {
      const position = outView.getUint32(offset + 4, true);
      if (position > at) outView.setUint32(offset + 4, position + delta, true);
    }
    offset += length + 4;
  }
  XLSX.CFB.utils.cfb_add(cfb, "Workbook", output);
  return new Uint8Array(XLSX.CFB.write(cfb, { type: "array" }));
}
describe("Excel team player proforma", () => {
  it("round-trips genuine BIFF8, updates explicit identities and preserves FA leading zeroes and omitted players", () => {
    const state = createPreparationState(),
      bytes = createRosterXls(state);
    expect(previewRosterXls(bytes, state, allocate()).errors).toEqual([]);
    expect([...bytes.slice(0, 8)]).toEqual([
      0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
    ]);
    const edited = change(bytes, (wb) => {
      wb.Sheets.Players.C2 = { t: "s", v: "Updated name" };
      wb.Sheets.Players.F2 = { t: "s", v: "0012345678" };
      wb.Sheets.Players["!ref"] = "A1:K2";
    });
    const result = previewRosterXls(edited, state, allocate());
    expect(result.errors).toEqual([]);
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]).toMatchObject({
      id: state.profiles[0].id,
      playerId: state.profiles[0].playerId,
      displayName: "Updated name",
      faPlayerId: "0012345678",
    });
    const next = reducePreparation(state, {
      id: "xls-import-identity",
      expectedRevision: state.revision,
      type: "roster.proforma_imported",
      profiles: result.profiles,
      confirmChanges: true,
    });
    expect(next.profiles).toHaveLength(state.profiles.length);
    expect(next.profiles.find((p) => p.id === state.profiles[1].id)).toEqual(
      state.profiles[1],
    );
    expect(next.fixtures).toEqual(state.fixtures);
    expect(next.snapshots).toEqual(state.snapshots);
  });
  it("rejects formulas, renamed CSV, edited scope, extra columns and a stolen player identity", () => {
    const state = createPreparationState(),
      bytes = createRosterXls(state);
    const invalid = [
      new TextEncoder().encode("displayName,name\nAlex,Test"),
      withFormula(bytes),
      change(bytes, (w) => {
        w.Sheets.LongBall.C2 = { t: "s", v: "other-team" };
      }),
      change(bytes, (w) => {
        w.Sheets.Players.L1 = { t: "s", v: "email" };
        w.Sheets.Players["!ref"] = "A1:L14";
      }),
      change(bytes, (w) => {
        w.Sheets.Players.B2 = { t: "s", v: state.profiles[1].playerId };
      }),
    ];
    for (const value of invalid)
      expect(
        previewRosterXls(value, state, allocate()).errors.length,
      ).toBeGreaterThan(0);
    expect(state.revision).toBe(0);
  });
  it("adds a new player from blank identity cells and supports shirt swaps in one atomic batch", () => {
    const state = createPreparationState(),
      bytes = createRosterXls(state);
    const edited = change(bytes, (w) => {
      const first = w.Sheets.Players.E2,
        second = w.Sheets.Players.E3;
      w.Sheets.Players.E2 = second;
      w.Sheets.Players.E3 = first;
      const rows = XLSX.utils
        .sheet_to_json<unknown[]>(w.Sheets.Players, {
          header: 1,
          raw: true,
          defval: "",
          blankrows: false,
        })
        .filter((row) =>
          row.some(
            (value) =>
              value !== null &&
              value !== undefined &&
              String(value).trim() !== "",
          ),
        );
      rows.push([
        "",
        "",
        "New player",
        "NP",
        "99",
        "",
        "left",
        "CM",
        "CB",
        "ST",
        "CM|CB|ST",
      ]);
      w.Sheets.Players = XLSX.utils.aoa_to_sheet(rows);
    });
    const result = previewRosterXls(edited, state, allocate());
    expect(result.errors).toEqual([]);
    expect(result.profiles.at(-1)).toMatchObject({
      displayName: "New player",
      playerId: "xls-new-2",
    });
    expect(result.profiles[0].shirtNumber).toBe(state.profiles[1].shirtNumber);
    expect(result.profiles[1].shirtNumber).toBe(state.profiles[0].shirtNumber);
  });
  it("bounds worksheet dimensions and rejects unsafe plain formula-like cells", () => {
    const state = createPreparationState(),
      bytes = createRosterXls(state);
    for (const value of [
      change(bytes, (w) => {
        w.Sheets.Players.C2 = { t: "s", v: '=HYPERLINK("x")' };
      }),
      change(bytes, (w) => {
        w.Sheets.Players.A202 = { t: "s", v: "extra" };
        w.Sheets.Players["!ref"] = "A1:K202";
      }),
    ])
      expect(
        previewRosterXls(value, state, allocate()).errors.length,
      ).toBeGreaterThan(0);
  });
  it("keeps optional league, FA ID and team alerts validated and replayable", () => {
    let state = createPreparationState();
    state = reducePreparation(state, {
      id: "team-league-command",
      expectedRevision: 0,
      type: "team.league_updated",
      league: "EMFJL 4th Division",
    });
    state = reducePreparation(state, {
      id: "team-alert-command",
      expectedRevision: 1,
      type: "team.alerts_updated",
      substitutionAlerts: { enabled: true, leadSeconds: 45, volume: 0.6 },
    });
    expect(state.team.league).toBe("EMFJL 4th Division");
    expect(state.substitutionAlerts?.leadSeconds).toBe(45);
    expect(() =>
      reducePreparation(state, {
        id: "bad-alert-command",
        expectedRevision: 2,
        type: "team.alerts_updated",
        substitutionAlerts: { enabled: true, leadSeconds: -1, volume: 0.6 },
      }),
    ).toThrow();
    expect(() =>
      reducePreparation(state, {
        id: "bad-fa-command",
        expectedRevision: 2,
        type: "profile.saved",
        profile: { ...state.profiles[0], faPlayerId: "12x" },
      }),
    ).toThrow(/FA player ID/);
  });
});
