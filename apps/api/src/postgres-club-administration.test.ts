import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresStore } from "./postgres-store";
import { PgMediaService } from "./postgres-media";
import { PostgresActivationService } from "./postgres-activation";
import { createPostgresApi } from "./postgres-server";
import { applyRuntimeGrants } from "./runtime-grants";
import { EVENT_CONTRACT_VERSION, SYNTHETIC_IDS } from "./store";
import type { ClubAdministrationDto } from "../../../packages/application/src/club-administration";
const configured = process.env.LONGBALL_POSTGRES_TEST_URL;
describe.skipIf(!configured)(
  "club administration through restricted PostgreSQL",
  () => {
    it("creates clubs/empty teams, inherits exact club authority and rejects cross-club and child escalation", async () => {
      const admin = new Pool({ connectionString: configured, max: 2 }),
        suffix = randomUUID().replaceAll("-", ""),
        database = `lb_club_${suffix}`,
        roles = {
          apiRole: `lb_club_api_${suffix}`,
          workerRole: `lb_club_worker_${suffix}`,
        },
        directory = mkdtempSync(join(tmpdir(), "lb-club-pg-"));
      let owner: PostgresStore | undefined,
        api: Awaited<ReturnType<typeof createPostgresApi>> | undefined,
        media: PgMediaService | undefined;
      try {
        await admin.query(`CREATE DATABASE "${database}"`);
        for (const role of Object.values(roles))
          await admin.query(
            `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
          );
        const ownerUrl = new URL(configured!);
        ownerUrl.pathname = `/${database}`;
        owner = await PostgresStore.open(ownerUrl.href);
        await owner.seedSynthetic({ demoSharing: true });
        media = await PgMediaService.open({
          directory: join(directory, "media"),
          database: owner.db,
        });
        await new PostgresActivationService({ store: owner }).initialize();
        await applyRuntimeGrants(owner.db, roles);
        const apiUrl = new URL(ownerUrl);
        apiUrl.username = roles.apiRole;
        apiUrl.password = "";
        api = await createPostgresApi({
          connectionString: apiUrl.href,
          databasePath: join(directory, "unused.sqlite"),
          mediaDirectory: join(directory, "media"),
          migrationMode: "verify",
          syntheticAuth: true,
          demoScenario: true,
          seedSynthetic: false,
        });
        await new Promise<void>((resolve) =>
          api!.server.listen(0, "127.0.0.1", resolve),
        );
        const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
        const call = async (
          route: string,
          account = "synthetic-admin",
          command?: unknown,
          role?: string,
        ) => {
          const response = await fetch(base + route, {
            method: command ? "POST" : "GET",
            headers: {
              Authorization: `Bearer ${account}`,
              ...(role ? { "X-Longball-Role": role } : {}),
              ...(command
                ? {
                    "Content-Type": "application/json",
                    "X-Api-Contract-Version": EVENT_CONTRACT_VERSION,
                    "Idempotency-Key": randomUUID(),
                  }
                : {}),
            },
            body: command ? JSON.stringify({ command }) : undefined,
          });
          return {
            status: response.status,
            body: (await response.json()) as Record<string, unknown>,
          };
        };
        const full = await call("/v1/administration");
        expect(full.status).toBe(200);
        expect(
          (full.body as unknown as ClubAdministrationDto).clubs,
        ).toHaveLength(2);
        expect((full.body as unknown as ClubAdministrationDto).candidates.find(candidate => candidate.accountId === 'synthetic-account-manager-2')?.label).toBe('Priya Shah');
        expect((full.body as unknown as ClubAdministrationDto).candidates.some(candidate => candidate.accountId.startsWith('synthetic-account-player-'))).toBe(false);
        const club = await call("/v1/administration", "synthetic-club-admin");
        expect(club.status).toBe(200);
        expect(
          (club.body as unknown as ClubAdministrationDto).clubs.map(
            (c) => c.id,
          ),
        ).toEqual(["synthetic-richmond-rovers"]);
        expect(
          (
            await call("/v1/administration", "synthetic-club-admin", {
              type: "club.create",
              name: "Denied",
            })
          ).status,
        ).toBe(404);
        expect(
          (
            await call("/v1/administration", "synthetic-admin", {
              type: "administrator.grant",
              accountId: "synthetic-account-player-01",
              level: "club",
              clubId: "synthetic-richmond-rovers",
            })
          ).status,
        ).not.toBe(200);
        const newClub = await call("/v1/administration", "synthetic-admin", {
          type: "club.create",
          name: "Eastfield Athletic",
        });
        expect(newClub.status).toBe(200);
        expect(
          (newClub.body as unknown as ClubAdministrationDto).clubs.some(
            (c) => c.name === "Eastfield Athletic",
          ),
        ).toBe(true);
        const created = await call(
          "/v1/administration",
          "synthetic-club-admin",
          {
            type: "team.create",
            clubId: "synthetic-richmond-rovers",
            name: "Roma Colts",
            ageGroup: "U5",
            format: 5,
            seasonStartYear: 2026,
          },
        );
        expect(created.status).toBe(200);
        const team = (
          created.body as unknown as ClubAdministrationDto
        ).teams.find((t) => t.name === "Roma Colts")!;
        expect(team).toBeDefined();
        const preparation = await call(
          `/v1/teams/${team.id}/preparation?seasonId=${team.seasonId}`,
          "synthetic-club-admin",
          undefined,
          "manager",
        );
        expect(preparation.status).toBe(200);
        expect(preparation.body.profiles).toEqual([]);
        expect(preparation.body.fixtures).toEqual([]);
        expect(
          (
            await call(
              `/v1/teams/${team.id}/preparation?seasonId=${team.seasonId}`,
              "synthetic-other-manager",
              undefined,
              "manager",
            )
          ).status,
        ).toBe(404);
        const report = await call(
          "/v1/clubs/synthetic-richmond-rovers/reports",
          "synthetic-club-admin",
        );
        expect(report.status).toBe(200);
        expect(JSON.stringify(report.body)).not.toContain("synthetic-player-");
        const original = await owner!.document<
          import("../../../packages/application/src/preparation").PreparationState
        >(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, "preparation");
        expect(
          (
            await call(
              `/v1/teams/${SYNTHETIC_IDS.teamId}/configuration?seasonId=${SYNTHETIC_IDS.seasonId}`,
              "synthetic-club-admin",
              {
                id: randomUUID(),
                expectedRevision: original.revision,
                type: "team.updated",
                name: "Roma Rangers",
                ageGroup: "U12",
                defaultPitchPlaces: 7,
                defaultHalfDurationMs: 1500000,
                logo: null,
              },
              "administrator",
            )
          ).status,
        ).toBe(200);
        expect(
          (
            await call(
              `/v1/teams/${SYNTHETIC_IDS.teamId}/configuration?seasonId=${SYNTHETIC_IDS.seasonId}`,
              "synthetic-club-admin",
              {
                id: randomUUID(),
                expectedRevision: original.revision + 1,
                type: "club.updated",
                name: "Richmond Athletic",
                logo: null,
              },
              "administrator",
            )
          ).status,
        ).toBe(200);
        const updated = await call(
          "/v1/administration",
          "synthetic-club-admin",
        );
        expect(
          (updated.body as unknown as ClubAdministrationDto).clubs[0].name,
        ).toBe("Richmond Athletic");
        expect(
          (updated.body as unknown as ClubAdministrationDto).teams.find(
            (t) => t.id === SYNTHETIC_IDS.teamId,
          ),
        ).toMatchObject({ name: "Roma Rangers", ageGroup: "U12" });
        const inheritedTeam = await owner!.document<
          import("../../../packages/application/src/preparation").PreparationState
        >(team.id, team.seasonId, "preparation");
        expect(inheritedTeam.club.name).toBe("Richmond Athletic");
        await owner!.execute(
          "UPDATE documents SET value_json=jsonb_set(value_json,'{results}','[]'::jsonb) WHERE team_id=$1 AND season_id=$2 AND kind='records'",
          [SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId],
        );
        const canonicalReport = await call(
          "/v1/clubs/synthetic-richmond-rovers/reports",
          "synthetic-club-admin",
        );
        expect(
          (
            canonicalReport.body.teams as {
              id: string;
              completedGames: number;
            }[]
          ).find((t) => t.id === SYNTHETIC_IDS.teamId)?.completedGames,
        ).toBe(2);
        expect(
          (
            await call(
              "/v1/clubs/synthetic-other-club/reports",
              "synthetic-club-admin",
            )
          ).status,
        ).toBe(404);
        expect(
          (
            await call("/v1/administration", "synthetic-admin", {
              type: "administrator.revoke",
              accountId: "synthetic-account-club-admin",
              level: "club",
              clubId: "synthetic-richmond-rovers",
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await call(
              `/v1/teams/${SYNTHETIC_IDS.teamId}/preparation?seasonId=${SYNTHETIC_IDS.seasonId}`,
              "synthetic-club-admin",
              undefined,
              "manager",
            )
          ).status,
        ).toBe(404);
      } finally {
        api?.server.closeAllConnections();
        await api?.close();
        await media?.close();
        await owner?.close();
        await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH(FORCE)`);
        for (const role of Object.values(roles))
          await admin.query(`DROP ROLE IF EXISTS "${role}"`);
        await admin.end();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  },
);
