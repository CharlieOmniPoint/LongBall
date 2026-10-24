import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import type { Principal } from "../../../packages/application/src/access";
import { createApi } from "./server";
import {
  DevelopmentStore,
  EVENT_CONTRACT_VERSION,
  SYNTHETIC_IDS as ids,
} from "./store";
import { PostgresStore } from "./postgres-store";
import { PgMediaService } from "./postgres-media";
import { PostgresActivationService } from "./postgres-activation";
import { createPostgresApi } from "./postgres-server";
import { applyRuntimeGrants } from "./runtime-grants";

const configured = process.env.LONGBALL_POSTGRES_TEST_URL;
async function fixture(backend: "sqlite" | "postgres") {
  const directory = mkdtempSync(join(tmpdir(), "lb-inherited-manager-"));
  let api:
      | ReturnType<typeof createApi>
      | Awaited<ReturnType<typeof createPostgresApi>>,
    owner: PostgresStore | undefined,
    media: PgMediaService | undefined,
    admin: Pool | undefined,
    database: string | undefined,
    roles: { apiRole: string; workerRole: string } | undefined;
  const close = async () => {
    api?.server.closeAllConnections();
    await api?.close();
    await media?.close();
    await owner?.close();
    if (admin) {
      if (database)
        await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH(FORCE)`);
      for (const name of Object.values(roles ?? {}))
        await admin.query(`DROP ROLE IF EXISTS "${name}"`);
      await admin.end();
    }
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    if (backend === "sqlite")
      api = createApi({
        databasePath: join(directory, "db.sqlite"),
        syntheticAuth: true,
        demoScenario: true,
      });
    else {
      admin = new Pool({ connectionString: configured, max: 2 });
      const suffix = randomUUID().replaceAll("-", "");
      database = `lb_inherited_${suffix}`;
      roles = {
        apiRole: `lb_inherited_api_${suffix}`,
        workerRole: `lb_inherited_worker_${suffix}`,
      };
      await admin.query(`CREATE DATABASE "${database}"`);
      for (const name of Object.values(roles))
        await admin.query(
          `CREATE ROLE "${name}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
        );
      const url = new URL(configured!);
      url.pathname = `/${database}`;
      owner = await PostgresStore.open(url.href);
      await owner.seedSynthetic({ demoSharing: true });
      media = await PgMediaService.open({
        directory: join(directory, "media"),
        database: owner.db,
      });
      await new PostgresActivationService({ store: owner }).initialize();
      await applyRuntimeGrants(owner.db, roles);
      url.username = roles.apiRole;
      url.password = "";
      api = await createPostgresApi({
        connectionString: url.href,
        databasePath: join(directory, "unused.sqlite"),
        mediaDirectory: join(directory, "media"),
        migrationMode: "verify",
        syntheticAuth: true,
        demoScenario: true,
        seedSynthetic: false,
      });
    }
    await new Promise<void>((resolve) =>
      api.server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
    const call = async (
      path: string,
      account: string,
      role: string,
      body?: unknown,
    ) => {
      const response = await fetch(base + path, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${account}`,
          "X-Longball-Role": role,
          ...(body
            ? {
                "Content-Type": "application/json",
                "X-Api-Contract-Version": EVENT_CONTRACT_VERSION,
                "Idempotency-Key": randomUUID(),
              }
            : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    };
    const rows = async (
      sql: string,
      values: (string | number)[] = [],
    ): Promise<Record<string, unknown>[]> => {
      if (owner) return owner.many(sql, values);
      const source = api.store as DevelopmentStore;
      return source.database
        .prepare(sql.replace(/\$\d+/g, "?"))
        .all(...values) as Record<string, unknown>[];
    };
    const snapshot = async () => ({
      memberships: await rows(
        "SELECT * FROM memberships ORDER BY account_id,team_id,season_id,role",
      ),
      grants: await rows(
        "SELECT * FROM administration_grants ORDER BY account_id,scope_key",
      ),
      inherited: await rows(
        "SELECT * FROM administrative_memberships ORDER BY account_id,team_id,season_id,role",
      ),
      controller: await rows(
        "SELECT match_id,epoch,account_id,device_id,frozen FROM controller_grants ORDER BY match_id",
      ),
      staff: await rows(
        "SELECT team_id,season_id,revision,value_json FROM documents WHERE kind='staff' ORDER BY team_id,season_id",
      ),
      revocationAudit: await rows(
        "SELECT actor_id,action,object_id,outcome FROM audit WHERE action='manager.assignment_revoked' ORDER BY id",
      ),
    });
    return { api, owner, call, rows, snapshot, close };
  } catch (error) {
    await close();
    throw error;
  }
}
const team = `/v1/teams/${ids.teamId}`,
  season = `?seasonId=${ids.seasonId}`;
for (const backend of ["sqlite", "postgres"] as const)
  describe.skipIf(backend === "postgres" && !configured)(
    `inherited administration versus appointed managers — actual ${backend}`,
    () => {
      it("rejects inherited revocation for every staff actor without freezing the controller or changing any authority, revision or audit", async () => {
        const test = await fixture(backend);
        try {
          expect(
            (
              await test.call(
                `${team}/preparation${season}`,
                "synthetic-admin",
                "manager",
              )
            ).status,
          ).toBe(200);
          expect(
            (
              await test.call(
                `/v1/matches/${ids.matchId}/controller`,
                "synthetic-admin",
                "manager",
                { deviceId: "inherited-manager-device" },
              )
            ).status,
          ).toBe(200);
          const before = await test.snapshot();
          for (const actor of ["synthetic-club-admin", "synthetic-admin"]) {
            const result = await test.call(
              `${team}/managers/revoke${season}`,
              actor,
              "administrator",
              {
                accountId: "synthetic-account-admin",
                reason:
                  "This is an inherited authority, not a coach appointment.",
                confirmRevocation: true,
              },
            );
            expect(result).toMatchObject({
              status: 404,
              body: { code: "NOT_FOUND" },
            });
            expect(await test.snapshot()).toEqual(before);
          }
          expect(
            (
              await test.call(
                `${team}/preparation${season}`,
                "synthetic-admin",
                "manager",
              )
            ).status,
          ).toBe(200);
          expect(
            (
              await test.call(
                "/v1/administration",
                "synthetic-admin",
                "administrator",
              )
            ).status,
          ).toBe(200);
          if (test.api.store instanceof PostgresStore) {
            const store = test.api.store,
              identity = {
                issuer: "urn:longball:synthetic",
                subject: "synthetic-account-club-admin",
                strongAuth: true,
                authenticatedAt: Date.now(),
              };
            const principal: Principal = await store.withIdentityContext(
              identity,
              () => store.principal(identity),
            );
            const result = await store.withActorContext(
              principal,
              {
                operation: "staff.revoke",
                requestedRole: "administrator",
                teamId: ids.teamId,
                seasonId: ids.seasonId,
                staffTargetAccountId: "synthetic-account-admin",
              },
              () =>
                store.transaction(() =>
                  store.execute(
                    "UPDATE memberships SET revoked_at=$1 WHERE account_id='synthetic-account-admin' AND team_id=$2 AND season_id=$3 AND role='manager'",
                    [Date.now(), ids.teamId, ids.seasonId],
                  ),
                ),
            );
            expect(result.changes).toBe(0);
            expect(await test.snapshot()).toEqual(before);
          }
        } finally {
          await test.close();
        }
      });
      it("still revokes an independently appointed coach under an admin grant, preserves that grant, and retains the revoked appointment after grant removal", async () => {
        const test = await fixture(backend);
        try {
          expect(
            (
              await test.call(
                "/v1/administration",
                "synthetic-admin",
                "administrator",
                {
                  command: {
                    type: "administrator.grant",
                    accountId: "synthetic-account-manager-2",
                    level: "club",
                    clubId: "synthetic-richmond-rovers",
                  },
                },
              )
            ).status,
          ).toBe(200);
          expect(
            await test.rows(
              "SELECT * FROM administrative_memberships WHERE account_id='synthetic-account-manager-2' AND team_id=$1 AND season_id=$2 AND role='manager'",
              [ids.teamId, ids.seasonId],
            ),
          ).toEqual([]);
          const grantsBefore = await test.rows(
            "SELECT * FROM administration_grants ORDER BY account_id,scope_key",
          );
          expect(
            (
              await test.call(
                `/v1/matches/${ids.matchId}/controller`,
                "synthetic-manager-2",
                "manager",
                { deviceId: "appointed-manager-device" },
              )
            ).status,
          ).toBe(200);
          const result = await test.call(
            `${team}/managers/revoke${season}`,
            "synthetic-club-admin",
            "administrator",
            {
              accountId: "synthetic-account-manager-2",
              reason:
                "The independently appointed coach has left this assignment.",
              confirmRevocation: true,
            },
          );
          expect(result.status).toBe(200);
          expect(result.body).toMatchObject({
            revoked: true,
            controllerFrozen: true,
          });
          expect(
            await test.rows(
              "SELECT * FROM administration_grants ORDER BY account_id,scope_key",
            ),
          ).toEqual(grantsBefore);
          expect(
            (
              await test.call(
                `${team}/preparation${season}`,
                "synthetic-manager-2",
                "manager",
              )
            ).status,
          ).toBe(404);
          expect(
            (
              await test.call(
                "/v1/administration",
                "synthetic-manager-2",
                "administrator",
              )
            ).status,
          ).toBe(200);
          const appointment = await test.rows(
            "SELECT account_id,team_id,season_id,role,expires_at,revoked_at FROM memberships WHERE account_id='synthetic-account-manager-2' AND team_id=$1 AND season_id=$2 AND role='manager'",
            [ids.teamId, ids.seasonId],
          );
          expect(appointment[0]?.revoked_at).toBeTypeOf("number");
          expect(
            (
              await test.call(
                "/v1/administration",
                "synthetic-admin",
                "administrator",
                {
                  command: {
                    type: "administrator.revoke",
                    accountId: "synthetic-account-manager-2",
                    level: "club",
                    clubId: "synthetic-richmond-rovers",
                  },
                },
              )
            ).status,
          ).toBe(200);
          expect(
            await test.rows(
              "SELECT account_id,team_id,season_id,role,expires_at,revoked_at FROM memberships WHERE account_id='synthetic-account-manager-2' AND team_id=$1 AND season_id=$2 AND role='manager'",
              [ids.teamId, ids.seasonId],
            ),
          ).toEqual(appointment);
        } finally {
          await test.close();
        }
      });
    },
  );

describe.skipIf(!configured)(
  "inherited Manager authority append-only PostgreSQL migration",
  () => {
    it("upgrades the actual preceding schema24 in place, preserves domain bytes and controller state, and verifies schema25 before runtime acceptance", async () => {
      const test = await fixture("postgres");
      try {
        const owner = test.owner!;
        expect(
          (
            await test.call(
              `/v1/matches/${ids.matchId}/controller`,
              "synthetic-admin",
              "manager",
              { deviceId: "upgrade-inherited-device" },
            )
          ).status,
        ).toBe(200);
        // Reconstruct exactly the preceding version: 025 introduces this policy only.
        await owner.transaction(async () => {
          await owner.execute(
            "DROP POLICY appointed_manager_updates ON memberships",
          );
          await owner.execute("DELETE FROM schema_migrations WHERE version=25");
        });
        const before = await test.snapshot();
        expect(
          (
            await owner.many(
              "SELECT version FROM schema_migrations ORDER BY version",
            )
          ).map((r) => r.version),
        ).toEqual(Array.from({ length: 23 }, (_, i) => i + 2));
        const runtime = test.api.store as PostgresStore;
        await expect(runtime.db.migrate()).rejects.toThrow(
          "migrations are required",
        );
        await owner.db.migrate();
        await runtime.db.migrate();
        expect(await test.snapshot()).toEqual(before);
        expect(
          (
            await owner.many(
              "SELECT version FROM schema_migrations ORDER BY version",
            )
          ).map((r) => r.version),
        ).toEqual(Array.from({ length: 24 }, (_, i) => i + 2));
        const policy = await owner.one(
          "SELECT polpermissive FROM pg_policy WHERE polname='appointed_manager_updates' AND polrelid='longball.memberships'::regclass",
        );
        expect(policy?.polpermissive).toBe(false);
        const identity = {
          issuer: "urn:longball:synthetic",
          subject: "synthetic-account-club-admin",
          strongAuth: true,
          authenticatedAt: Date.now(),
        };
        const principal = await runtime.withIdentityContext(identity, () =>
          runtime.principal(identity),
        );
        const update = await runtime.withActorContext(
          principal,
          {
            operation: "staff.revoke",
            requestedRole: "administrator",
            teamId: ids.teamId,
            seasonId: ids.seasonId,
            staffTargetAccountId: "synthetic-account-admin",
          },
          () =>
            runtime.transaction(() =>
              runtime.execute(
                "UPDATE memberships SET revoked_at=$1 WHERE account_id='synthetic-account-admin' AND team_id=$2 AND season_id=$3 AND role='manager'",
                [Date.now(), ids.teamId, ids.seasonId],
              ),
            ),
        );
        expect(update.changes).toBe(0);
        expect(await test.snapshot()).toEqual(before);
        expect(
          (
            await test.call(
              `${team}/preparation${season}`,
              "synthetic-admin",
              "manager",
            )
          ).status,
        ).toBe(200);
        await owner.db.migrate();
        expect(await test.snapshot()).toEqual(before);
      } finally {
        await test.close();
      }
    });
  },
);
