import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { PostgresStore, SYNTHETIC_IDS } from "./postgres-store";
import { PostgresActivationService } from "./postgres-activation";
import type { ActivationProvider } from "./activation";

const databaseUrl = process.env.LONGBALL_POSTGRES_TEST_URL;
describe.skipIf(!databaseUrl)("actual PostgreSQL activation repository", () => {
  let store: PostgresStore;
  let admin: Pool;
  let featureDatabaseUrl: string;
  const databaseName = `longball_activation_test_${randomBytes(6).toString("hex")}`;
  let clock = Date.parse("2026-10-21T12:00:00Z");
  const users = new Map<
    string,
    {
      issuer: string;
      subject: string;
      username: string;
      pending: true;
      credentialConfigured: false;
    }
  >();
  const cancelled = new Set<string>();
  const provider: ActivationProvider = {
    issuer: "https://fixture-identity.example.invalid/realms/longball",
    credentialSetupOrigins: ["https://fixture-identity.example.invalid"],
    async provisionPending(input) {
      let user = users.get(input.operationId);
      if (!user) {
        user = {
          issuer: provider.issuer,
          subject: randomUUID(),
          username: input.username,
          pending: true,
          credentialConfigured: false,
        };
        users.set(input.operationId, user);
      }
      return user;
    },
    async beginCredentialSetup(input) {
      if (cancelled.has(input.operationId))
        throw new Error("Cancelled fixture flow");
      return {
        flowId: input.operationId.slice("activation:".length),
        setupUrl: "https://fixture-identity.example.invalid/credential-screen",
        expiresAt: input.expiresAt,
      };
    },
    async cancelCredentialSetup(input) {
      cancelled.add(input.operationId);
    },
    async verifyCredentialSetup(input) {
      if (
        input.completionProof !== "fixture-provider-proof" ||
        cancelled.has(input.operationId)
      )
        throw new Error("Invalid fixture proof");
      return {
        issuer: input.issuer,
        subject: input.subject,
        flowId: input.flowId,
        completedAt: clock,
        credentialConfigured: true,
        recoveryMaterialIssued: true,
      };
    },
  };
  const policy = {
    version: "explicit-postgres-fixture-only",
    activationTtlMs: 90_000,
    fictionalOnly: true as const,
  };
  const service = () =>
    new PostgresActivationService({ store, provider, policy }).initialize();
  const manager = () =>
    store.principal({
      issuer: "urn:longball:synthetic",
      subject: "synthetic-account-manager",
      strongAuth: true,
      authenticatedAt: clock,
    });
  async function input() {
    const principal = await manager();
    const state = await store.preparation(
      principal,
      SYNTHETIC_IDS.teamId,
      SYNTHETIC_IDS.seasonId,
    );
    const playerId = `pg-fictional-player-${randomUUID()}`;
    await store.transaction(() =>
      store.preparationCommand(
        principal,
        SYNTHETIC_IDS.teamId,
        SYNTHETIC_IDS.seasonId,
        {
          type: "profile.saved",
          id: randomUUID(),
          expectedRevision: state.revision,
          profile: {
            ...state.profiles[0],
            id: randomUUID(),
            playerId,
            shirtNumber: null,
            displayName: "Fictional Roma activation fixture",
          },
        },
      ),
    );
    return {
      requestId: randomUUID(),
      playerId,
      teamId: SYNTHETIC_IDS.teamId,
      seasonId: SYNTHETIC_IDS.seasonId,
    };
  }
  beforeAll(async () => {
    const parsed = new URL(databaseUrl!);
    parsed.pathname = "/postgres";
    admin = new Pool({ connectionString: parsed.toString() });
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    parsed.pathname = `/${databaseName}`;
    featureDatabaseUrl = parsed.toString();
    store = await PostgresStore.open(featureDatabaseUrl, () => clock);
    await store.seedSynthetic();
  });
  afterAll(async () => {
    await store?.close();
    if (admin) {
      await admin.query(
        `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
      );
      await admin.end();
    }
  });
  it("migrates concurrently, binds an actual pending row and enforces case-insensitive username/classification constraints", async () => {
    const [first, second] = await Promise.all([service(), service()]);
    const request = await input();
    const principal = await manager();
    const pending = await first.createPendingChild(principal, request);
    expect(await second.createPendingChild(principal, request)).toEqual(
      pending,
    );
    expect(
      await store.one(
        "SELECT state FROM lb_activation_children WHERE lower(username)=lower($1)",
        [pending.username.toLowerCase()],
      ),
    ).toMatchObject({ state: "pending_activation" });
    expect(
      await store.one(
        "SELECT status,adult_verified FROM accounts WHERE id=$1",
        [pending.accountId],
      ),
    ).toMatchObject({ status: "disabled", adult_verified: 0 });
    await expect(
      store.execute(
        "UPDATE accounts SET classification='adult_individual' WHERE id=$1",
        [pending.accountId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("verifies the migrated feature inside an actual read-only PostgreSQL transaction without runtime DDL", async () => {
    const verifier = await PostgresStore.open(featureDatabaseUrl, () => clock, {
      migrationMode: "verify",
    });
    try {
      await verifier.db.transaction(async () => {
        await verifier.db.query("SET TRANSACTION READ ONLY");
        await new PostgresActivationService({
          store: verifier,
          provider,
          policy,
        }).initialize();
      });
    } finally {
      await verifier.close();
    }
  });
  it("rolls back the account binding on a failed write and retries the same durable provider operation", async () => {
    const activation = await service();
    const request = await input();
    const principal = await manager();
    const previousUsers = users.size;
    await store.execute(
      "CREATE FUNCTION lb_fixture_binding_failure() RETURNS trigger LANGUAGE plpgsql AS $fixture$ BEGIN RAISE EXCEPTION 'fixture binding failure'; END; $fixture$; CREATE TRIGGER lb_fixture_binding_failure BEFORE UPDATE OF state ON lb_activation_children FOR EACH ROW EXECUTE FUNCTION lb_fixture_binding_failure()",
    );
    try {
      await expect(
        activation.createPendingChild(principal, request),
      ).rejects.toThrow("fixture binding failure");
    } finally {
      await store.execute(
        "DROP TRIGGER lb_fixture_binding_failure ON lb_activation_children; DROP FUNCTION lb_fixture_binding_failure()",
      );
    }
    const retained = await store.one(
      "SELECT account_id,state FROM lb_activation_children WHERE request_id=$1",
      [request.requestId],
    );
    expect(retained).toMatchObject({ state: "provisioning" });
    expect(
      await store.one("SELECT issuer,status FROM accounts WHERE id=$1", [
        retained!.account_id,
      ]),
    ).toMatchObject({
      issuer: "urn:longball:pending-activation",
      status: "disabled",
    });
    expect(
      (await activation.createPendingChild(principal, request)).accountId,
    ).toBe(retained!.account_id);
    expect(users.size).toBe(previousUsers + 1);
  });
  it("reserves concurrent issue generations, retains only hashes and rejects an old claimed flow after reissue", async () => {
    const activation = await service();
    const principal = await manager();
    const request = await input();
    const pending = await activation.createPendingChild(principal, request);
    const base = {
      teamId: request.teamId,
      seasonId: request.seasonId,
      accountId: pending.accountId,
    };
    const issued = await Promise.allSettled([
      activation.issueActivation(principal, {
        ...base,
        requestId: randomUUID(),
      }),
      activation.issueActivation(principal, {
        ...base,
        requestId: randomUUID(),
      }),
    ]);
    expect(issued.some((result) => result.status === "fulfilled")).toBe(true);
    const rows = await store.many(
      "SELECT * FROM lb_activation_tokens WHERE account_id=$1",
      [pending.accountId],
    );
    expect(rows.filter((row) => row.state === "issued")).toHaveLength(1);
    const active = issued
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value)
      .find((value) =>
        rows.some(
          (row) => row.id === value.activationId && row.state === "issued",
        ),
      )!;
    expect(JSON.stringify(rows)).not.toContain(active.token);
    await activation.redeemActivation({
      token: active.token,
      requestId: randomUUID(),
    });
    const replacement = await activation.issueActivation(principal, {
      ...base,
      requestId: randomUUID(),
    });
    await expect(
      activation.completeActivation({
        activationId: active.activationId,
        completionProof: "fixture-provider-proof",
      }),
    ).rejects.toMatchObject({ code: "ACTIVATION_UNAVAILABLE" });
    const setup = await activation.redeemActivation({
      token: replacement.token,
      requestId: randomUUID(),
    });
    expect(
      await activation.completeActivation({
        activationId: setup.activationId,
        completionProof: "fixture-provider-proof",
      }),
    ).toEqual({ status: "complete", signInRequired: true });
    expect(
      await store.one(
        "SELECT classification,status FROM accounts WHERE id=$1",
        [pending.accountId],
      ),
    ).toMatchObject({ classification: "child_shared", status: "active" });
  });
  it("retains scoped exact-ID verification requests without looking up or taking over the target", async () => {
    const activation = await service();
    const principal = await manager();
    const request = await input();
    const target = randomUUID();
    const link = { ...request, existingAccountId: target };
    expect(
      await activation.requestExistingAccountLink(principal, link),
    ).toMatchObject({
      status: "pending_independent_verification",
      completed: false,
    });
    expect(
      await store.one("SELECT id FROM accounts WHERE id=$1", [target]),
    ).toBeUndefined();
    const other = await store.principal({
      issuer: "urn:longball:synthetic",
      subject: "synthetic-account-other-manager",
      strongAuth: true,
      authenticatedAt: clock,
    });
    await expect(
      activation.requestRecovery(other, {
        requestId: randomUUID(),
        teamId: request.teamId,
        seasonId: request.seasonId,
        accountId: target,
      }),
    ).rejects.toMatchObject({ status: 404 });
    const pending = await activation.createPendingChild(principal, {
      ...request,
      requestId: randomUUID(),
    });
    const token = await activation.issueActivation(principal, {
      requestId: randomUUID(),
      teamId: request.teamId,
      seasonId: request.seasonId,
      accountId: pending.accountId,
    });
    clock = token.expiresAt;
    await expect(
      activation.redeemActivation({
        token: token.token,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "ACTIVATION_UNAVAILABLE" });
    expect(
      await store.one("SELECT status FROM accounts WHERE id=$1", [
        pending.accountId,
      ]),
    ).toMatchObject({ status: "disabled" });
  });
});
