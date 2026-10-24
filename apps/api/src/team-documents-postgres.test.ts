import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { createPostgresApi } from "./postgres-server";
import { assertTeamDocumentView } from "../../../packages/application/src/team-documents";
import { applyRuntimeGrants } from "./runtime-grants";
import { EVENT_CONTRACT_VERSION, SYNTHETIC_IDS } from "./store";

describe.skipIf(!process.env.LONGBALL_POSTGRES_TEST_URL)(
  "actual PostgreSQL team-sheet runtime role",
  () => {
    it("persists staff PDF across API restart with forced row security and no player/spectator/cross-club disclosure", async () => {
      const admin = new Pool({
          connectionString: process.env.LONGBALL_POSTGRES_TEST_URL,
          max: 2,
        }),
        suffix = randomUUID().replaceAll("-", ""),
        database = `longball_sheet_${suffix}`,
        apiRole = `sheet_api_${suffix}`,
        workerRole = `sheet_worker_${suffix}`,
        directory = mkdtempSync(join(tmpdir(), "longball-sheet-pg-"));
      let service: Awaited<ReturnType<typeof createPostgresApi>> | null = null;
      try {
        await admin.query(`CREATE DATABASE "${database}"`);
        await admin.query(`CREATE ROLE "${apiRole}" LOGIN`);
        await admin.query(`CREATE ROLE "${workerRole}" LOGIN`);
        const ownerUrl = new URL(process.env.LONGBALL_POSTGRES_TEST_URL!);
        ownerUrl.pathname = `/${database}`;
        service = await createPostgresApi({
          connectionString: ownerUrl.href,
          databasePath: join(directory, "unused.sqlite"),
          mediaDirectory: join(directory, "media"),
          syntheticAuth: true,
          allowOwnerTestFixture: true,
        });
        await applyRuntimeGrants(service.store.db, { apiRole, workerRole });
        await service.close();
        service = null;
        const apiUrl = new URL(ownerUrl);
        apiUrl.username = apiRole;
        apiUrl.password = "";
        const open = async () => {
          service = await createPostgresApi({
            connectionString: apiUrl.href,
            databasePath: join(directory, "unused.sqlite"),
            mediaDirectory: join(directory, "media"),
            syntheticAuth: true,
            migrationMode: "verify",
            seedSynthetic: false,
          });
          await new Promise<void>((resolve) =>
            service!.server.listen(0, "127.0.0.1", resolve),
          );
          return `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
        };
        let base = await open();
        const path = `/v1/teams/${SYNTHETIC_IDS.teamId}/team-sheet?seasonId=${SYNTHETIC_IDS.seasonId}`;
        const call = async (
          command?: Record<string, unknown>,
          token = "synthetic-manager-2",
          role = "manager",
        ) => {
          const r = await fetch(base + path, {
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
          revision: 0,
          document: null,
        });
        const pdf = await PDFDocument.create();
        pdf.addPage();
        const bytes = Buffer.from(await pdf.save());
        const command = {
            id: randomUUID(),
            type: "team_sheet.uploaded",
            expectedRevision: 0,
            fileName: "Roma FA sheet.pdf",
            base64: bytes.toString("base64"),
          },
          saved = await call(command);
        expect(saved.status).toBe(200);
        assertTeamDocumentView(saved.body, SYNTHETIC_IDS.teamId);
        expect(saved.body.revision).toBe(1);
        expect(
          (await service!.store.db.query("SELECT * FROM team_documents")).rows,
        ).toHaveLength(0);
        for (const [token, role] of [
          ["synthetic-account-player-01", "player"],
          ["synthetic-spectator", "spectator"],
          ["synthetic-other-manager", "manager"],
        ])
          expect((await call(undefined, token, role)).status).toBe(404);
        service!.server.closeAllConnections();
        await service!.close();
        service = null;
        base = await open();
        expect((await call()).body).toEqual(saved.body);
        expect(await call(command)).toEqual(saved);
      } finally {
        if (service) {
          service.server.closeAllConnections();
          await service.close();
        }
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
          [database],
        );
        await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
        await admin.query(`DROP ROLE IF EXISTS "${apiRole}"`);
        await admin.query(`DROP ROLE IF EXISTS "${workerRole}"`);
        await admin.end();
        rmSync(directory, { recursive: true, force: true });
      }
    }, 60000);
  },
);
