import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createPostgresApi } from "./postgres-server";
import { SYNTHETIC_IDS, EVENT_CONTRACT_VERSION } from "./store";
import {
  previewRosterImport,
  ROSTER_CSV_TEMPLATE,
} from "../../../packages/application/src/roster-import";
import type { PreparationState } from "../../../packages/application/src/preparation";

describe.skipIf(!process.env.LONGBALL_POSTGRES_TEST_URL)(
  "actual PostgreSQL roster import HTTP",
  () => {
    it("commits all profiles and roster projection once, rejects partial/revoked writes and creates no account access", async () => {
      const at = Date.now();
      const admin = new Pool({
        connectionString: process.env.LONGBALL_POSTGRES_TEST_URL,
        max: 2,
      });
      const database = `longball_import_${randomUUID().replaceAll("-", "")}`,
        directory = mkdtempSync(join(tmpdir(), "longball-import-pg-"));
      let api: Awaited<ReturnType<typeof createPostgresApi>> | null = null;
      try {
        await admin.query(`CREATE DATABASE "${database}"`);
        const url = new URL(process.env.LONGBALL_POSTGRES_TEST_URL!);
        url.pathname = `/${database}`;
        api = await createPostgresApi({
          connectionString: url.href,
          databasePath: join(directory, "unused.sqlite"),
          syntheticAuth: true,
          now: () => at,
          allowOwnerTestFixture: true,
          mediaDirectory: join(directory, "media"),
        });
        await new Promise<void>((resolve) =>
          api!.server.listen(0, "127.0.0.1", resolve),
        );
        const route = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}/v1/teams/${SYNTHETIC_IDS.teamId}/preparation?seasonId=${SYNTHETIC_IDS.seasonId}`;
        const call = async (command?: unknown, key = randomUUID()) => {
          const reply = await fetch(route, {
            method: command ? "POST" : "GET",
            headers: {
              Authorization: "Bearer synthetic-manager-2",
              "X-Longball-Role": "manager",
              ...(command
                ? {
                    "Idempotency-Key": key,
                    "X-Api-Contract-Version": EVENT_CONTRACT_VERSION,
                    "Content-Type": "application/json",
                  }
                : {}),
            },
            ...(command ? { body: JSON.stringify({ command }) } : {}),
          });
          return { status: reply.status, body: (await reply.json()) as PreparationState };
        };
        const before = (await call()).body as PreparationState,
          memberships = await api.store.memberships();
        const profiles = previewRosterImport(
          ROSTER_CSV_TEMPLATE,
          before,
          randomUUID,
        ).profiles;
        const id = randomUUID(),
          command = {
            id,
            expectedRevision: before.revision,
            type: "roster.imported",
            profiles,
            confirmNewPlayers: true,
          };
        const imported = await call(command, id);
        expect(imported.status).toBe(200);
        expect(imported.body.profiles).toHaveLength(before.profiles.length + 1);
        expect(await call(command, id)).toEqual(imported);
        expect(await api.store.memberships()).toEqual(memberships);
        expect(imported.body.fixtures).toEqual(before.fixtures);
        expect(imported.body.snapshots).toEqual(before.snapshots);
        const bad = {
          ...command,
          id: randomUUID(),
          expectedRevision: imported.body.revision,
          profiles: [
            {
              ...profiles[0],
              id: randomUUID(),
              playerId: randomUUID(),
              shirtNumber: 21,
            },
            {
              ...profiles[0],
              id: randomUUID(),
              playerId: randomUUID(),
              shirtNumber: 21,
            },
          ],
        };
        expect((await call(bad)).status).toBe(422);
        expect((await call()).body).toEqual(imported.body);
        const records = await api.store.document<{ players: { id: string }[] }>(
          SYNTHETIC_IDS.teamId,
          SYNTHETIC_IDS.seasonId,
          "records",
        );
        expect(
          records.players.some((player) => player.id === profiles[0].playerId),
        ).toBe(true);
        await api.store.db.query(
          "UPDATE memberships SET revoked_at=$1 WHERE account_id='synthetic-account-manager-2' AND team_id=$2",
          [at, SYNTHETIC_IDS.teamId],
        );
        expect((await call(command, id)).status).toBe(404);
      } finally {
        if (api) {
          api.server.closeAllConnections();
          await api.close();
        }
        await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
        await admin.end();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  },
);
