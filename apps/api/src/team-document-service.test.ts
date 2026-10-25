import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { PDFDocument, PDFName } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { createApi } from "./server";
import { EVENT_CONTRACT_VERSION, SYNTHETIC_IDS } from "./store";
import { parseOwnPlayerPreparation } from "../../../packages/application/src/player-preparation";
import { validateTeamSheetPdf } from "./team-document-service";

async function pdfBytes(active = false) {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  if (active)
    pdf.catalog.set(
      PDFName.of("OpenAction"),
      pdf.context.obj({ S: "JavaScript", JS: "void(0)" }),
    );
  return Buffer.from(await pdf.save());
}
describe("private team PDF sheets", () => {
  it("validates actual PDF structure, rejecting scripts, malformed and encrypted-style input", async () => {
    const bytes = await pdfBytes();
    expect(
      (await validateTeamSheetPdf(bytes.toString("base64"))).bytes,
    ).toEqual(bytes);
    for (const value of [
      (await pdfBytes(true)).toString("base64"),
      Buffer.from("%PDF-not a document").toString("base64"),
      "not+canonical=",
    ])
      await expect(validateTeamSheetPdf(value)).rejects.toMatchObject({
        code: "INVALID_PDF",
      });
  });
  it("persists and privately downloads a team PDF, rejects stale/replayed-different edits and denies players, spectators and other clubs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "longball-team-document-")),
      api = createApi({
        databasePath: join(directory, "db.sqlite"),
        syntheticAuth: true,
      });
    try {
      await new Promise<void>((resolve) =>
        api.server.listen(0, "127.0.0.1", resolve),
      );
      const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}/v1/teams/${SYNTHETIC_IDS.teamId}/team-sheet`,
        season = `?seasonId=${SYNTHETIC_IDS.seasonId}`;
      const call = async (
        command?: Record<string, unknown>,
        token = "synthetic-manager-2",
        role = "manager",
        download = false,
      ) => {
        const r = await fetch(base + (download ? "/download" : "") + season, {
          method: command ? "POST" : "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Longball-Role": role,
            ...(command
              ? {
                  "Content-Type": "application/json",
                  "Idempotency-Key": String(command.id),
                  "X-Api-Contract-Version": EVENT_CONTRACT_VERSION,
                }
              : {}),
          },
          ...(command ? { body: JSON.stringify({ command }) } : {}),
        });
        return { status: r.status, body: await r.json() };
      };
      expect((await call()).body).toMatchObject({
        kind: "team-document",
        revision: 0,
        document: null,
      });
      const bytes = await pdfBytes(),
        command = {
          id: randomUUID(),
          type: "team_sheet.uploaded",
          expectedRevision: 0,
          fileName: "FA team sheet.pdf",
          base64: bytes.toString("base64"),
        },
        saved = await call(command);
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({
        revision: 1,
        document: { fileName: "FA team sheet.pdf", byteLength: bytes.length },
      });
      expect(JSON.stringify(saved.body)).not.toContain(command.base64);
      expect(await call(command)).toEqual(saved);
      expect(
        (await call({ ...command, fileName: "Different.pdf" })).status,
      ).toBe(409);
      const downloaded = await call(undefined, undefined, undefined, true);
      expect(downloaded.status).toBe(200);
      expect(downloaded.body).toHaveProperty("base64", command.base64);
      for (const [token, role] of [
        ["synthetic-account-player-01", "player"],
        ["synthetic-spectator", "spectator"],
        ["synthetic-other-manager", "manager"],
      ])
        expect((await call(undefined, token, role)).status).toBe(404);
      expect((await call({ ...command, id: randomUUID() })).status).toBe(409);
      const removed = await call({
        id: randomUUID(),
        type: "team_sheet.removed",
        expectedRevision: 1,
      });
      expect(removed.body).toMatchObject({ revision: 2, document: null });
      expect((await call(undefined, undefined, undefined, true)).status).toBe(
        404,
      );
    } finally {
      api.server.closeAllConnections();
      await api.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("accepts self FA IDs without permitting a player to update anyone else or manager fields", async () => {
    const directory = mkdtempSync(join(tmpdir(), "longball-own-fa-")),
      api = createApi({
        databasePath: join(directory, "db.sqlite"),
        syntheticAuth: true,
      });
    try {
      await new Promise<void>((resolve) =>
        api.server.listen(0, "127.0.0.1", resolve),
      );
      const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}/v1/teams/${SYNTHETIC_IDS.teamId}/preparation/own?seasonId=${SYNTHETIC_IDS.seasonId}`;
      const get = await fetch(base, {
          headers: {
            Authorization: "Bearer synthetic-account-player-01",
            "X-Longball-Role": "player",
          },
        }),
        before = parseOwnPlayerPreparation(await get.json(), {
          teamId: SYNTHETIC_IDS.teamId,
          seasonId: SYNTHETIC_IDS.seasonId,
          playerId: "synthetic-player-01",
        });
      const post = async (extra: Record<string, unknown>) => {
        const id = randomUUID();
        const r = await fetch(base, {
          method: "POST",
          headers: {
            Authorization: "Bearer synthetic-account-player-01",
            "X-Longball-Role": "player",
            "Content-Type": "application/json",
            "Idempotency-Key": id,
            "X-Api-Contract-Version": EVENT_CONTRACT_VERSION,
          },
          body: JSON.stringify({
            command: {
              id,
              expectedRevision: before.revision,
              type: "own.fa_id_saved",
              faPlayerId: "0012345678",
              ...extra,
            },
          }),
        });
        return { status: r.status, body: await r.json() };
      };
      expect((await post({ profileId: "other-player" })).status).toBe(400);
      expect((await post({ faPlayerId: "bad-ID" })).status).toBe(422);
      const saved = await post({});
      expect(saved.status).toBe(200);
      const ownSaved = parseOwnPlayerPreparation(saved.body, {
        teamId: SYNTHETIC_IDS.teamId,
        seasonId: SYNTHETIC_IDS.seasonId,
        playerId: "synthetic-player-01",
      });
      expect(ownSaved.profile.faPlayerId).toBe("0012345678");
      expect(ownSaved.profile.eligiblePositions).toEqual(
        before.profile.eligiblePositions,
      );
    } finally {
      api.server.closeAllConnections();
      await api.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
