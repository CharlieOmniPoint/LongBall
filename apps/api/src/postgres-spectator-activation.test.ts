import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PgDatabase } from "./pg";
import { PostgresStore, SYNTHETIC_IDS } from "./postgres-store";
import { PgMediaService } from "./postgres-media";
import { PostgresActivationService } from "./postgres-activation";
import { applyRuntimeGrants } from "./runtime-grants";
import {
  SpectatorActivationService,
  spectatorInvitationHash,
} from "./spectator-activation";
import { PostgresSpectatorActivationRepository } from "./postgres-spectator-activation";
import type { ActivationProvider } from "./activation";
const configured = process.env.LONGBALL_POSTGRES_TEST_URL;
describe.skipIf(!configured)(
  "actual restricted PostgreSQL spectator activation",
  () => {
    let admin: Pool,
      owner: PgDatabase,
      api: PgDatabase,
      worker: PgDatabase,
      database: string,
      directory: string;
    const roles: Record<string, string> = {},
      pools: PgDatabase[] = [];
    const policy = {
      version: "explicit-spectator-fixture",
      activationTtlMs: 90_000,
      fictionalOnly: true as const,
    };
    const provider: ActivationProvider = {
      issuer: "https://fixture-identity.example/realms/trial",
      credentialSetupOrigins: ["https://fixture-identity.example"],
      provisionPending: vi.fn<ActivationProvider["provisionPending"]>(
        async (input) => ({
          issuer: provider.issuer,
          subject: input.accountId,
          username: input.username,
          pending: true,
          credentialConfigured: false,
        }),
      ),
      beginCredentialSetup: vi.fn(async (input) => ({
        flowId: input.operationId.slice(11),
        setupUrl: `${provider.issuer}/login-actions/action-token?key=fixture`,
        expiresAt: input.expiresAt,
      })),
      cancelCredentialSetup: vi.fn(),
      verifyCredentialSetup: vi.fn<ActivationProvider["verifyCredentialSetup"]>(
        async (input) => {
          if (input.completionProof !== "p".repeat(43))
            throw new Error("Invalid fixture proof");
          return {
            issuer: input.issuer,
            subject: input.subject,
            flowId: input.flowId,
            completedAt: Date.now(),
            credentialConfigured: true,
            recoveryMaterialIssued: true,
          };
        },
      ),
    };
    let service: SpectatorActivationService;
    beforeAll(async () => {
      admin = new Pool({ connectionString: configured, max: 2 });
      const suffix = randomUUID().replaceAll("-", "");
      database = `lb_spec_${suffix}`;
      for (const purpose of ["owner", "api", "worker"]) {
        roles[purpose] = `lb_spec_${purpose}_${suffix}`;
        await admin.query(
          `CREATE ROLE "${roles[purpose]}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
        );
      }
      await admin.query(`CREATE DATABASE "${database}"`);
      const base = new URL(configured!);
      base.pathname = `/${database}`;
      const bootstrap = new Pool({ connectionString: base.href });
      try {
        await bootstrap.query(
          `CREATE SCHEMA longball AUTHORIZATION "${roles.owner}"`,
        );
      } finally {
        await bootstrap.end();
      }
      const connect = (purpose: string, mode: "apply" | "verify") => {
        const url = new URL(base);
        url.username = roles[purpose];
        url.password = "";
        const db = new PgDatabase(url.href, {
          migrationMode: mode,
          maximumConnections: 1,
        });
        pools.push(db);
        return db;
      };
      owner = connect("owner", "apply");
      await owner.migrate();
      const store = new PostgresStore(owner);
      await store.seedSynthetic();
      directory = await mkdtemp(join(tmpdir(), "longball-spectator-"));
      await PgMediaService.open({ directory, database: owner });
      await new PostgresActivationService({ store }).initialize();
      await applyRuntimeGrants(owner, {
        apiRole: roles.api,
        workerRole: roles.worker,
      });
      api = connect("api", "verify");
      worker = connect("worker", "verify");
      await api.migrate();
      await worker.migrate();
      service = new SpectatorActivationService({
        repository: new PostgresSpectatorActivationRepository(
          new PostgresStore(api),
        ),
        provider,
        policy,
      });
    });
    afterAll(async () => {
      for (const db of pools) await db.close();
      if (database)
        await admin.query(`DROP DATABASE "${database}" WITH(FORCE)`);
      for (const role of Object.values(roles))
        await admin.query(`DROP ROLE "${role}"`);
      if (directory) await rm(directory, { recursive: true, force: true });
      await admin?.end();
    });
    async function invitation() {
      const token = randomBytes(32).toString("base64url"),
        hash = spectatorInvitationHash(token),
        id = randomUUID(),
        now = Date.now();
      await owner.query(
        "INSERT INTO spectator_invitations(id,club_id,team_id,season_id,inviter_account_id,credential_kind,token_hash,created_at,expires_at,policy_version) VALUES($1,'synthetic-richmond-rovers',$2,$3,'synthetic-account-manager','sha256',$4,$5,$6,$7)",
        [
          id,
          SYNTHETIC_IDS.teamId,
          SYNTHETIC_IDS.seasonId,
          hash,
          now,
          now + 120_000,
          policy.version,
        ],
      );
      await owner.query(
        "UPDATE documents SET value_json=jsonb_set(value_json,'{invitations}',COALESCE(value_json->'invitations','[]'::jsonb)||$1::jsonb) WHERE kind='community' AND team_id=$2 AND season_id=$3",
        [
          JSON.stringify([
            {
              id,
              teamId: SYNTHETIC_IDS.teamId,
              seasonId: SYNTHETIC_IDS.seasonId,
              inviterAccountId: "synthetic-account-manager",
              credential: { kind: "sha256", version: 1, tokenHash: hash },
              createdAtMs: now,
              expiresAtMs: now + 120_000,
              acceptedBy: null,
              acceptedAtMs: null,
              revokedAtMs: null,
              reissuedFromInvitationId: null,
            },
          ]),
          SYNTHETIC_IDS.teamId,
          SYNTHETIC_IDS.seasonId,
        ],
      );
      return {
        token,
        hash,
        id,
        input: {
          token,
          deviceId: `fixture-${randomUUID()}`,
          policyVersion: policy.version,
          requestId: randomUUID(),
        },
      };
    }
    it("uses exact token context while unscoped and worker reads remain denied", async () => {
      const f = await invitation();
      expect(
        (await api.query("SELECT * FROM spectator_invitations")).rowCount,
      ).toBe(0);
      await expect(
        worker.query("SELECT * FROM spectator_invitations"),
      ).rejects.toMatchObject({ code: "42501" });
      expect((await service.preflight({ token: f.token })).invitationId).toBe(
        f.id,
      );
      await expect(
        service.preflight({ token: randomBytes(32).toString("base64url") }),
      ).rejects.toMatchObject({ code: "ACTIVATION_UNAVAILABLE" });
    });
    it("creates one disabled unclassified identity, requires provider proof and grants no membership", async () => {
      const f = await invitation(),
        first = await service.activate(f.input),
        retry = await service.activate({ ...f.input, requestId: randomUUID() });
      expect(retry).toEqual(first);
      const activationId = new URL(first.identityActionUrl).hash.slice(
        "#longballActivation=".length,
      );
      expect(await service.ownsActivationToken(f.token, activationId)).toBe(
        true,
      );
      expect(
        (
          await owner.query(
            "SELECT classification,status,adult_verified,strong_auth_enrolled FROM accounts WHERE id=$1",
            [first.accountId],
          )
        ).rows[0],
      ).toEqual({
        classification: "unclassified",
        status: "disabled",
        adult_verified: 0,
        strong_auth_enrolled: 0,
      });
      expect(
        (
          await owner.query("SELECT * FROM memberships WHERE account_id=$1", [
            first.accountId,
          ])
        ).rowCount,
      ).toBe(0);
      await expect(
        api.withContext(
          {
            kind: "invitation_activation",
            tokenHash: f.hash,
            activationId,
            nowMs: Date.now(),
          },
          () =>
            api.query("UPDATE accounts SET status='active' WHERE id=$1", [
              first.accountId,
            ]),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        service.completeActivation({
          activationId,
          token: f.token,
          completionProof: "bad".repeat(15),
        }),
      ).rejects.toMatchObject({ code: "PROVIDER_FLOW_UNAVAILABLE" });
      expect(
        (
          await owner.query("SELECT status FROM accounts WHERE id=$1", [
            first.accountId,
          ])
        ).rows[0].status,
      ).toBe("disabled");
      expect(
        await service.completeActivation({
          activationId,
          token: f.token,
          completionProof: "p".repeat(43),
        }),
      ).toEqual({ status: "complete", signInRequired: true });
      expect(
        await service.completeActivation({
          activationId,
          token: f.token,
          completionProof: "p".repeat(43),
        }),
      ).toEqual({ status: "complete", signInRequired: true });
      expect(
        (
          await owner.query(
            "SELECT classification,status,adult_verified,strong_auth_enrolled FROM accounts WHERE id=$1",
            [first.accountId],
          )
        ).rows[0],
      ).toEqual({
        classification: "unclassified",
        status: "active",
        adult_verified: 0,
        strong_auth_enrolled: 0,
      });
      expect(
        (
          await owner.query("SELECT * FROM memberships WHERE account_id=$1", [
            first.accountId,
          ])
        ).rowCount,
      ).toBe(0);
      const saved = JSON.stringify(
        (
          await owner.query(
            "SELECT * FROM lb_spectator_activation_accounts WHERE account_id=$1",
            [first.accountId],
          )
        ).rows,
      );
      expect(saved).not.toContain(f.token);
      expect(
        (
          await owner.query(
            "SELECT * FROM audit WHERE actor_id=$1 AND action='identity.spectator_activation_completed'",
            [first.accountId],
          )
        ).rowCount,
      ).toBe(1);
    });
    it("does not allow a different invitation token to complete the same provider attempt", async () => {
      const f = await invitation(),
        foreign = await invitation(),
        receipt = await service.activate(f.input),
        activationId = new URL(receipt.identityActionUrl).hash.slice(
          "#longballActivation=".length,
        ),
        before = vi.mocked(provider.verifyCredentialSetup).mock.calls.length;
      await expect(
        service.completeActivation({
          activationId,
          token: foreign.token,
          completionProof: "p".repeat(43),
        }),
      ).rejects.toMatchObject({ code: "ACTIVATION_UNAVAILABLE" });
      expect(vi.mocked(provider.verifyCredentialSetup).mock.calls.length).toBe(
        before,
      );
      await owner.query(
        "UPDATE spectator_invitations SET revoked_at=$1 WHERE id=$2",
        [Date.now(), f.id],
      );
      await expect(
        service.completeActivation({
          activationId,
          token: f.token,
          completionProof: "p".repeat(43),
        }),
      ).rejects.toMatchObject({ code: "ACTIVATION_UNAVAILABLE" });
    });
    it("serializes concurrent retries into one reserved identity and one provider attempt", async () => {
      const f = await invitation();
      const [left, right] = await Promise.all([
        service.activate(f.input),
        service.activate({ ...f.input, requestId: randomUUID() }),
      ]);
      expect(right).toEqual(left);
      expect(
        (
          await owner.query(
            "SELECT account_id FROM lb_spectator_activation_accounts WHERE invitation_id=$1",
            [f.id],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await owner.query(
            "SELECT id FROM lb_spectator_activation_attempts WHERE account_id=$1",
            [left.accountId],
          )
        ).rowCount,
      ).toBe(1);
    });
    it("retains the same provider attempt when a post-provider database transaction fails", async () => {
      const f = await invitation();
      await owner.query(
        "CREATE FUNCTION fixture_spectator_flow_failure() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'fixture flow write failure'; END; $f$; CREATE TRIGGER fixture_spectator_flow_failure BEFORE UPDATE OF state ON lb_spectator_activation_attempts FOR EACH ROW EXECUTE FUNCTION fixture_spectator_flow_failure()",
      );
      try {
        await expect(service.activate(f.input)).rejects.toThrow(
          "fixture flow write failure",
        );
      } finally {
        await owner.query(
          "DROP TRIGGER fixture_spectator_flow_failure ON lb_spectator_activation_attempts; DROP FUNCTION fixture_spectator_flow_failure()",
        );
      }
      const retained = (
        await owner.query(
          "SELECT x.id,x.account_id,x.state FROM lb_spectator_activation_attempts x JOIN lb_spectator_activation_accounts a ON a.account_id=x.account_id WHERE a.invitation_id=$1",
          [f.id],
        )
      ).rows[0];
      expect(retained.state).toBe("provisioning");
      const retry = await service.activate(f.input);
      expect(retry.accountId).toBe(retained.account_id);
      expect(new URL(retry.identityActionUrl).hash).toBe(
        `#longballActivation=${retained.id}`,
      );
    });
  },
);
