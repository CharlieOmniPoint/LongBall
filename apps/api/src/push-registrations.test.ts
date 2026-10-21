import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createApi, type ApiOptions } from "./server";
import { createPostgresApi } from "./postgres-server";
import { PostgresStore } from "./postgres-store";
import { PgMediaService } from "./postgres-media";
import { PostgresActivationService } from "./postgres-activation";
import { applyRuntimeGrants } from "./runtime-grants";
import { createPushTokenCipher } from "./push-token-crypto";
import { parseAccountPushStatus } from "../../../packages/application/src/push-registrations";
import { EVENT_CONTRACT_VERSION, SYNTHETIC_IDS } from "./store";
import { SqlitePushRepository } from "./sqlite-push-registrations";
import { PostgresPushRepository } from "./postgres-push-registrations";
import { createRegisteredPushProvider } from "./registered-push-provider";
import {
  createTeamNotificationJob,
  enqueueTeamNotification,
  runDueTeamNotifications,
} from "../../worker/src/notification-jobs";
import type { PreparationState } from "../../../packages/application/src/preparation";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const testUrl = process.env.LONGBALL_POSTGRES_TEST_URL;
const rawToken = "fictional-device-token-not-an-authentication-credential";
const options: Pick<ApiOptions, "pushPlatforms" | "pushTokenCipher"> = {
  pushPlatforms: {
    android: { transport: "fcm", providerConfigId: "explicit-test-config" },
    ios: { transport: "apns", providerConfigId: "explicit-ios-test-config" },
  },
  pushTokenCipher: createPushTokenCipher(
    "test-key",
    new Map([["test-key", randomBytes(32)]]),
  ),
};
type Call = (
  path: string,
  input?: {
    body?: unknown;
    method?: string;
    token?: string | null;
    key?: string;
    revision?: number;
    noRevision?: boolean;
  },
) => Promise<{ status: number; body: Record<string, unknown>; text: string }>;
async function start(kind: "sqlite" | "postgres", configured = true) {
  const directory = mkdtempSync(join(tmpdir(), "longball-push-http-")),
    databasePath = join(directory, "push.sqlite");
  cleanups.push(async () =>
    rmSync(directory, { recursive: true, force: true }),
  );
  let api:
    | ReturnType<typeof createApi>
    | Awaited<ReturnType<typeof createPostgresApi>>;
  let owner: PostgresStore | undefined;
  let workerUrl: string | undefined;
  if (kind === "postgres") {
    const admin = new Pool({ connectionString: testUrl!, max: 1 }),
      suffix = randomUUID().replaceAll("-", ""),
      database = `lb_push_${suffix}`,
      roles = {
        apiRole: `lb_push_api_${suffix}`,
        workerRole: `lb_push_worker_${suffix}`,
      };
    await admin.query(`CREATE DATABASE "${database}"`);
    for (const role of Object.values(roles))
      await admin.query(
        `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
    cleanups.push(async () => {
      await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      for (const role of Object.values(roles))
        await admin.query(`DROP ROLE "${role}"`);
      await admin.end();
    });
    const ownerUrl = new URL(testUrl!);
    ownerUrl.pathname = `/${database}`;
    owner = await PostgresStore.open(ownerUrl.href);
    await owner.seedSynthetic();
    await PgMediaService.open({
      directory: join(directory, "media"),
      database: owner.db,
    });
    await new PostgresActivationService({ store: owner }).initialize();
    await applyRuntimeGrants(owner.db, roles);
    cleanups.push(() => owner!.close());
    const apiUrl = new URL(ownerUrl);
    apiUrl.username = roles.apiRole;
    apiUrl.password = "";
    const workerAddress = new URL(ownerUrl);
    workerAddress.username = roles.workerRole;
    workerAddress.password = "";
    workerUrl = workerAddress.href;
    api = await createPostgresApi({
      connectionString: apiUrl.href,
      databasePath,
      mediaDirectory: join(directory, "media"),
      migrationMode: "verify",
      syntheticAuth: true,
      seedSynthetic: false,
      ...(configured ? options : {}),
    });
  } else
    api = createApi({
      databasePath,
      syntheticAuth: true,
      ...(configured ? options : {}),
    });
  await new Promise<void>((resolve) =>
    api.server.listen(0, "127.0.0.1", resolve),
  );
  cleanups.push(async () => {
    api.server.closeAllConnections();
    await api.close();
  });
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const call: Call = async (path, input = {}) => {
    const method = input.method ?? (input.body === undefined ? "GET" : "POST"),
      headers: Record<string, string> = {};
    if (input.token !== null)
      headers.authorization = `Bearer ${input.token ?? "synthetic-account-invitee"}`;
    if (method !== "GET") {
      headers["idempotency-key"] = input.key ?? randomUUID();
      headers["x-api-contract-version"] = EVENT_CONTRACT_VERSION;
      if (!input.noRevision) headers["if-match"] = `"${input.revision ?? 0}"`;
    }
    if (input.body !== undefined) headers["content-type"] = "application/json";
    const reply = await fetch(base + path, {
      method,
      headers,
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await reply.text();
    return { status: reply.status, body: JSON.parse(text), text };
  };
  const row = async () =>
    kind === "postgres"
      ? await owner!.one(
          "SELECT * FROM push_registrations WHERE device_id=$1",
          ["account-native-device"],
        )
      : api.store instanceof PostgresStore
        ? null
        : api.store.database
            .prepare("SELECT * FROM push_registrations WHERE device_id=?")
            .get("account-native-device");
  const enrolled = await call("/v1/identity/devices", {
    body: { deviceId: "account-native-device", platform: "android" },
  });
  expect(enrolled.status).toBe(200);
  return { api, call, row, directory, databasePath, owner, workerUrl };
}
const route = "/v1/me/push-registrations";
const body = {
  deviceId: "account-native-device",
  platform: "android",
  transport: "fcm",
  token: rawToken,
  appBuild: "explicit-fictional-build",
  permission: "granted",
};
for (const kind of ["sqlite", "postgres"] as const)
  describe.skipIf(kind === "postgres" && !testUrl)(
    `DS14 ${kind} actual authenticated HTTP`,
    () => {
      it("registers an enrolled membership-free account and durably stores only encrypted token material", async () => {
        const client = await start(kind),
          key = randomUUID();
        const reply = await client.call(route, { body, key });
        expect(reply.status, reply.text).toBe(200);
        expect(reply.body).toMatchObject({ id: body.deviceId, revision: 1 });
        expect(await client.call(route, { body, key })).toEqual(reply);
        const status = parseAccountPushStatus(
          (await client.call(route)).body,
          "synthetic-account-invitee",
        );
        expect(status.deliveryConfigured).toBe(false);
        expect(status.devices).toHaveLength(1);
        expect(status.devices[0]).toMatchObject({
          state: "registered",
          revision: 1,
          permission: "granted",
        });
        const saved = await client.row();
        expect(saved?.token_ciphertext).toBeTypeOf("string");
        expect(saved?.token_ciphertext).not.toContain(rawToken);
        expect(JSON.stringify(status)).not.toMatch(/token|ciphertext|digest/i);
        const audit =
          kind === "postgres"
            ? await client.owner!.many("SELECT * FROM audit")
            : client.api.store instanceof PostgresStore
              ? []
              : client.api.store.database.prepare("SELECT * FROM audit").all();
        const receipts =
          kind === "postgres"
            ? await client.owner!.many("SELECT * FROM idempotency")
            : client.api.store instanceof PostgresStore
              ? []
              : client.api.store.database
                  .prepare("SELECT * FROM idempotency")
                  .all();
        expect(JSON.stringify([audit, receipts])).not.toContain(rawToken);
        if (kind === "sqlite")
          for (const path of [
            client.databasePath,
            client.databasePath + "-wal",
          ]) {
            if (existsSync(path))
              expect(readFileSync(path).includes(Buffer.from(rawToken))).toBe(
                false,
              );
          }
        if (kind === "postgres") {
          const tables = await client.owner!.many(
            "SELECT tablename FROM pg_tables WHERE schemaname='longball'",
          );
          for (const table of tables) {
            const name = String(table.tablename);
            expect(name).toMatch(/^[a-z0-9_]+$/);
            expect(
              JSON.stringify(
                await client.owner!.many(
                  `SELECT to_jsonb(t) AS value FROM longball.\"${name}\" t`,
                ),
              ),
            ).not.toContain(rawToken);
          }
        }
        if (client.api.store instanceof PostgresStore)
          expect(
            await client.api.store.many("SELECT * FROM push_registrations"),
          ).toEqual([]);
      });
      it("fences stale rotations and makes revocation durable without deleting account/device evidence", async () => {
        const { call, row } = await start(kind),
          initialKey = randomUUID();
        const original = await call(route, { body, key: initialKey });
        expect(original.status).toBe(200);
        expect(
          (
            await call(route, {
              body: { ...body, token: `${rawToken}-rotated` },
              revision: 1,
            })
          ).status,
        ).toBe(200);
        expect((await call(route, { body, revision: 1 })).body.code).toBe(
          "PUSH_REGISTRATION_CHANGED",
        );
        const removal = await call(`${route}/${body.deviceId}`, {
          method: "DELETE",
          revision: 2,
        });
        expect(removal.status, removal.text).toBe(202);
        expect(removal.body.status).toBe("completed");
        expect(await row()).toMatchObject({
          state: "revoked",
          revision: 3,
          token_ciphertext: null,
          token_digest: null,
        });
        expect((await call(route, { body, revision: 2 })).status).toBe(409);
        expect(await call(route, { body, key: initialKey })).toEqual(original);
        expect(await row()).toMatchObject({
          state: "revoked",
          revision: 3,
          token_ciphertext: null,
        });
        const withdrawnDeviceId = "never-registered-withdrawn-device";
        expect(
          (
            await call("/v1/identity/devices", {
              body: { deviceId: withdrawnDeviceId, platform: "android" },
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await call(`${route}/${withdrawnDeviceId}`, {
              method: "DELETE",
              revision: 0,
            })
          ).status,
        ).toBe(202);
        expect(
          (
            await call(route, {
              body: { ...body, deviceId: withdrawnDeviceId },
              revision: 0,
            })
          ).body.code,
        ).toBe("PUSH_REGISTRATION_CHANGED");
        expect((await call("/v1/identity/devices")).body.devices).toHaveLength(
          2,
        );
      });
      it("cannot bind, inspect or revoke another account's device, even with its raw push token", async () => {
        const { call } = await start(kind);
        expect((await call(route, { body })).status).toBe(200);
        for (const deviceId of [body.deviceId, "unknown-device"]) {
          const registered = await call(route, {
            token: "synthetic-account-player-01",
            body: { ...body, deviceId },
          });
          expect(registered.status).toBe(404);
          expect(registered.body.code).toBe("PUSH_DEVICE_UNAVAILABLE");
          expect(
            (
              await call(`${route}/${deviceId}`, {
                method: "DELETE",
                token: "synthetic-account-player-01",
                revision: 1,
              })
            ).status,
          ).toBe(404);
        }
        expect(
          parseAccountPushStatus(
            (await call(route, { token: "synthetic-account-player-01" })).body,
            "synthetic-account-player-01",
          ).devices,
        ).toEqual([]);
        expect((await call(route, { token: rawToken })).status).toBe(401);
        expect((await call(route, { token: null })).status).toBe(401);
      });
      it("fails closed for missing CAS, rejected permission, unapproved transport and conflicting retry bytes", async () => {
        const { call } = await start(kind);
        expect((await call(route, { body, noRevision: true })).status).toBe(
          428,
        );
        expect(
          (await call(route, { body: { ...body, permission: "denied" } })).body
            .code,
        ).toBe("PUSH_PERMISSION_DENIED");
        expect(
          (await call(route, { body: { ...body, transport: "expo" } })).body
            .code,
        ).toBe("PUSH_PROCESSOR_UNAVAILABLE");
        const key = randomUUID();
        expect((await call(route, { body, key })).status).toBe(200);
        expect(
          (
            await call(route, {
              body: { ...body, token: `${rawToken}-other` },
              key,
            })
          ).body.code,
        ).toBe("IDEMPOTENCY_CONFLICT");
        expect((await call(route, { body, key, revision: 1 })).body.code).toBe(
          "IDEMPOTENCY_CONFLICT",
        );
      });
      it("keeps removal available when no processor or encryption key is configured and fences delayed initial registration", async () => {
        const { call, row } = await start(kind, false);
        expect((await call(route, { body })).body.code).toBe(
          "PUSH_NOT_CONFIGURED",
        );
        const status = parseAccountPushStatus(
          (await call(route)).body,
          "synthetic-account-invitee",
        );
        expect(status.registrationConfigured).toBe(false);
        expect(status.platforms).toEqual({});
        expect(
          (await call(`${route}/${body.deviceId}`, { method: "DELETE" }))
            .status,
        ).toBe(202);
        expect(await row()).toMatchObject({ state: "revoked", revision: 1 });
      });
      it("resolves current encrypted destinations only inside an eligible notification job and excludes rotations, withdrawals and changed enrolment", async () => {
        const client = await start(kind),
          source = client.owner ?? client.api.store;
        const manager = "synthetic-manager-1",
          deviceId = "manager-native-device";
        expect(
          (
            await client.call("/v1/identity/devices", {
              token: manager,
              body: { deviceId, platform: "android" },
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await client.call(route, {
              token: manager,
              body: { ...body, deviceId },
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await client.call(route, {
              body: { ...body, token: rawToken + "-another-account" },
            })
          ).status,
        ).toBe(200);
        const worker = client.workerUrl
          ? await PostgresStore.open(client.workerUrl, Date.now, {
              migrationMode: "verify",
            })
          : source;
        if (worker instanceof PostgresStore && worker !== source)
          cleanups.push(() => worker.close());
        const repository =
          worker instanceof PostgresStore
            ? new PostgresPushRepository(worker.db)
            : new SqlitePushRepository(worker.database, async (work) => work());
        if (worker instanceof PostgresStore) {
          expect(
            await repository.deliveryTargets("synthetic-account-manager"),
          ).toEqual([]);
          await expect(
            worker.many("SELECT * FROM push_registrations"),
          ).rejects.toHaveProperty("code", "42501");
          await expect(
            (client.api.store as PostgresStore).many(
              "SELECT * FROM longball.push_targets_for_current_job('synthetic-account-manager')",
            ),
          ).rejects.toHaveProperty("code", "42501");
        }
        const sent: { token: string; revision: number }[][] = [];
        const provider = createRegisteredPushProvider(repository, options, {
          configured: true,
          idempotency: "provider",
          send: async (input) => {
            if (worker instanceof PostgresStore)
              expect(worker.db.applicationContext).toBeUndefined();
            expect(Object.keys(input.payload.data)).toEqual(["entityId"]);
            expect(JSON.stringify(input.payload)).not.toContain(rawToken);
            sent.push(
              input.destinations.map((item) => ({
                token: item.token,
                revision: item.revision,
              })),
            );
            return {
              status: "accepted",
              receiptId: `explicit-test-receipt-${sent.length}`,
            };
          },
        });
        const preparation = await source.document<PreparationState>(
          SYNTHETIC_IDS.teamId,
          SYNTHETIC_IDS.seasonId,
          "preparation",
        );
        const enqueue = async () => {
          await enqueueTeamNotification(
            source,
            createTeamNotificationJob({
              id: randomUUID(),
              businessKey: randomUUID(),
              accountId: "synthetic-account-manager",
              teamId: SYNTHETIC_IDS.teamId,
              seasonId: SYNTHETIC_IDS.seasonId,
              audience: "manager",
              playerId: null,
              category: "schedule",
              entityId: preparation.fixtures[0].id,
              dueAtMs: Date.now() - 1000,
            }),
          );
        };
        await enqueue();
        expect(
          await runDueTeamNotifications(worker, { provider, maximum: 1 }),
        ).toMatchObject({ accepted: 1 });
        expect(sent[0]).toEqual([{ token: rawToken, revision: 1 }]);
        expect(
          (
            await client.call(route, {
              token: manager,
              revision: 1,
              body: { ...body, deviceId, token: rawToken + "-rotated" },
            })
          ).status,
        ).toBe(200);
        await enqueue();
        expect(
          await runDueTeamNotifications(worker, { provider, maximum: 1 }),
        ).toMatchObject({ accepted: 1 });
        expect(sent[1]).toEqual([
          { token: rawToken + "-rotated", revision: 2 },
        ]);
        // A changed native enrolment must immediately make the old platform destination ineligible.
        expect(
          (
            await client.call("/v1/identity/devices", {
              token: manager,
              body: { deviceId, platform: "ios" },
            })
          ).status,
        ).toBe(200);
        await enqueue();
        expect(
          await runDueTeamNotifications(worker, { provider, maximum: 1 }),
        ).toMatchObject({ failed: 1 });
        expect(sent).toHaveLength(2);
        expect(
          (
            await client.call("/v1/identity/devices", {
              token: manager,
              body: { deviceId, platform: "android" },
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await client.call(`${route}/${deviceId}`, {
              token: manager,
              method: "DELETE",
              revision: 2,
            })
          ).status,
        ).toBe(202);
        await enqueue();
        expect(
          await runDueTeamNotifications(worker, { provider, maximum: 1 }),
        ).toMatchObject({ failed: 1 });
        expect(sent).toHaveLength(2);
        if (source instanceof PostgresStore)
          await source.execute(
            "UPDATE accounts SET status='disabled' WHERE id=$1",
            ["synthetic-account-manager"],
          );
        else
          source.database
            .prepare("UPDATE accounts SET status='disabled' WHERE id=?")
            .run("synthetic-account-manager");
        await enqueue();
        expect(
          await runDueTeamNotifications(worker, { provider, maximum: 1 }),
        ).toMatchObject({ suppressed: 1 });
        expect(sent).toHaveLength(2);
        expect((await client.call(route, { token: manager })).status).toBe(403);
      });
    },
  );

describe.skipIf(!testUrl)("DS14 PostgreSQL additive migration", () => {
  it("preserves every schema13 row, rolls back failed installation, and reopens without opting devices in", async () => {
    const client = await start("postgres"),
      database = client.owner!.db;
    // Construct the actual preceding schema shape, rather than just lowering its ledger.
    await database.query(
      "DROP TRIGGER team_privilege_decision_received ON longball.team_privilege_decisions",
    );
    await database.query(
      "DROP FUNCTION longball.stamp_team_privilege_decision_received()",
    );
    await database.query(
      "ALTER POLICY team_privilege_decision_insert ON longball.team_privilege_decisions WITH CHECK(longball.team_privilege_manager(club_id,team_id) AND longball.context_json()->>'operation'='privileges.write' AND actor_id=longball.context_json()->>'accountId' AND longball.team_privilege_target(club_id,team_id,target_account_id) AND created_at=longball.context_now())",
    );
    await database.query(
      "DELETE FROM longball.schema_migrations WHERE version=15",
    );
    await database.query(
      "DROP FUNCTION longball.push_targets_for_current_job(text)",
    );
    await database.query("DROP TABLE longball.push_registrations");
    await database.query("DROP FUNCTION longball.push_registration_guard()");
    await database.query(
      "DROP POLICY native_devices_push_read ON longball.native_app_devices",
    );
    await database.query(
      "DELETE FROM longball.schema_migrations WHERE version=14",
    );
    const snapshot = async () => {
      const tables = await client.owner!.many(
          "SELECT tablename FROM pg_tables WHERE schemaname='longball' AND tablename<>'schema_migrations' AND tablename<>'push_registrations' ORDER BY tablename",
        ),
        result: Record<string, unknown> = {};
      for (const row of tables) {
        const name = String(row.tablename);
        expect(name).toMatch(/^[a-z0-9_]+$/);
        result[name] = await client.owner!.many(
          `SELECT to_jsonb(t) AS value FROM longball."${name}" t ORDER BY to_jsonb(t)::text`,
        );
      }
      return result;
    };
    const before = await snapshot();
    await database.query(
      "CREATE TABLE longball.push_registrations(collision text)",
    );
    await expect(database.migrate()).rejects.toThrow();
    expect(
      (
        await database.query(
          "SELECT version FROM longball.schema_migrations ORDER BY version",
        )
      ).rows.map((row) => row.version),
    ).not.toContain(14);
    expect(await snapshot()).toEqual(before);
    await database.query("DROP TABLE longball.push_registrations");
    await database.migrate();
    expect(await snapshot()).toEqual(before);
    expect(
      (await database.query("SELECT * FROM longball.push_registrations")).rows,
    ).toEqual([]);
    await database.migrate();
    if (!(client.api.store instanceof PostgresStore))
      throw new Error("Expected PostgreSQL fixture");
    await client.api.store.db.migrate(); // Runtime verify mode performs no migration.
    expect(await snapshot()).toEqual(before);
    expect(
      (
        await database.query(
          "SELECT version FROM longball.schema_migrations WHERE version=14",
        )
      ).rows,
    ).toHaveLength(1);
  });
});
