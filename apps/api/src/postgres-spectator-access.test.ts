import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDatabase } from "./pg";
import { PostgresStore, SYNTHETIC_IDS } from "./postgres-store";
import { PgMediaService } from "./postgres-media";
import { PostgresActivationService } from "./postgres-activation";
import { applyRuntimeGrants } from "./runtime-grants";
import {
  invitationVerifier,
  SpectatorInvitationService,
} from "./invitation-service";
import { PostgresInvitationRepository } from "./postgres-invitation-repository";
import { SpectatorAccessService } from "./spectator-access";
import { PersistedSpectatorAccessRepository } from "./spectator-access-repository";
import type { Principal } from "../../../packages/application/src/access";
import { reserveConfiguredUsernames } from "./username-registry";
const configured = process.env.LONGBALL_POSTGRES_TEST_URL;
describe.skipIf(!configured)(
  "restricted PostgreSQL invitation-backed PIN and invite requests",
  () => {
    let admin: Pool,
      owner: PgDatabase,
      api: PgDatabase,
      worker: PgDatabase,
      store: PostgresStore,
      service: SpectatorAccessService,
      repo: PersistedSpectatorAccessRepository,
      invites: SpectatorInvitationService,
      database: string,
      directory: string,
      manager: Principal;
    const roles: Record<string, string> = {},
      pools: PgDatabase[] = [],
      { teamId, seasonId } = SYNTHETIC_IDS;
    let now = Date.parse("2026-10-24T09:00:00Z");
    beforeAll(async () => {
      admin = new Pool({ connectionString: configured, max: 2 });
      const suffix = randomUUID().replaceAll("-", "");
      database = `lb_pin_${suffix}`;
      for (const kind of ["owner", "api", "worker"]) {
        roles[kind] = `lb_pin_${kind}_${suffix}`;
        await admin.query(
          `CREATE ROLE "${roles[kind]}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
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
      const connect = (kind: string, mode: "apply" | "verify") => {
        const url = new URL(base);
        url.username = roles[kind];
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
      await new PostgresStore(owner, () => now).seedSynthetic({
        demoSharing: true,
      });
      directory = await mkdtemp(join(tmpdir(), "longball-pin-pg-"));
      await PgMediaService.open({ directory, database: owner });
      await new PostgresActivationService({
        store: new PostgresStore(owner, () => now),
      }).initialize();
      await applyRuntimeGrants(owner, {
        apiRole: roles.api,
        workerRole: roles.worker,
      });
      api = connect("api", "verify");
      worker = connect("worker", "verify");
      await api.migrate();
      store = new PostgresStore(api, () => now);
      repo = new PersistedSpectatorAccessRepository(store, store);
      service = new SpectatorAccessService(repo, () => now);
      invites = new SpectatorInvitationService({
        repository: new PostgresInvitationRepository(store),
        publicAppEntryUrl: "https://example.invalid/LongBall/",
        invitationPolicyVersion: "pin-test-v1",
        now: () => now,
      });
      const identity = {
        issuer: "urn:longball:synthetic",
        subject: "synthetic-account-manager",
        strongAuth: true,
        authenticatedAt: now,
      };
      manager = await store.withIdentityContext(identity, () =>
        store.principal(identity),
      );
    });
    afterAll(async () => {
      service?.close();
      for (const pool of pools) await pool.close();
      if (database)
        await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      for (const role of Object.values(roles))
        await admin.query(`DROP ROLE "${role}"`);
      if (directory) await rm(directory, { recursive: true, force: true });
      await admin?.end();
    });
    const issue = async (
      principal = manager,
      role: "manager" | "spectator" = "manager",
    ) => {
      const first = await store.withActorContext(
        principal,
        { operation: "invite.issue", requestedRole: role, teamId, seasonId },
        () =>
          invites.issue({ principal, teamId, seasonId, role }, randomUUID(), {
            seasonId,
            expiresInHours: 2,
          }),
      );
      if (!("shareUrl" in first.body)) throw new Error("Fresh invite required");
      return new URLSearchParams(
        new URL(first.body.shareUrl).hash.slice(1),
      ).get("code")!;
    };
    it("rejects a configured account's case-insensitive username without exposing the namespace or consuming the invitation", async () => {
      await reserveConfiguredUsernames(store, [{ username: "Roma.Supporter", accountId: "synthetic-account-manager" }]);
      await expect(api.query("SELECT * FROM global_usernames")).rejects.toMatchObject({ code: "42501" });
      await expect(worker.query("SELECT claim_configured_demo_username('worker.name','synthetic-account-manager')")).rejects.toMatchObject({ code: "42501" });
      const token = await issue();
      await expect(service.register({ token, username: "ROMA.SUPPORTER", passcode: "4729", requestId: randomUUID() }, "namespace")).rejects.toMatchObject({ code: "USERNAME_UNAVAILABLE", status: 409 });
      expect(await service.preview({ token }, "namespace")).toMatchObject({ teamId, seasonId });
      expect((await owner.query("SELECT account_id FROM global_usernames WHERE normalized_username='roma.supporter'")).rows).toEqual([{ account_id: "synthetic-account-manager" }]);
    });
    it("limits credentials and anonymous helpers to API, consumes a possessed invitation, grants only spectator", async () => {
      const token = await issue(),
        before = (await owner.query("SELECT count(*) count FROM accounts"))
          .rows[0].count;
      expect(await service.preview({ token }, "one")).toMatchObject({
        teamId,
        seasonId,
      });
      const registered = await service.register(
        {
          token,
          username: "robin.park",
          passcode: "4729",
          requestId: randomUUID(),
        },
        "one",
      );
      const identity = service.identity(registered.accessToken),
        principal = await store.withIdentityContext(identity, () =>
          store.principal(identity),
        );
      expect(principal).toMatchObject({
        identityClassification: "unclassified",
        adultVerified: false,
        strongAuth: false,
      });
      const own = await store.withActorContext(
        principal,
        { operation: "account.read", requestedRole: "default" },
        () => store.myMemberships(principal),
      );
      expect(own).toEqual([
        expect.objectContaining({ teamId, seasonId, role: "spectator" }),
      ]);
      const row = (
        await owner.query(
          "SELECT * FROM spectator_pin_credentials WHERE account_id=$1",
          [principal.accountId],
        )
      ).rows[0];
      expect(row.verifier).toMatch(/^[a-f0-9]{64}$/);
      expect(row).not.toHaveProperty("passcode");
      await expect(
        api.query("SELECT * FROM spectator_pin_credentials"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        worker.query("SELECT * FROM spectator_pin_preview($1,$2)", [
          invitationVerifier(token),
          now,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        service.register(
          {
            token,
            username: "another.name",
            passcode: "5826",
            requestId: randomUUID(),
          },
          "two",
        ),
      ).rejects.toMatchObject({ status: 404 });
      expect(
        (await owner.query("SELECT count(*) count FROM accounts")).rows[0]
          .count,
      ).toBe(Number(before) + 1);
    });
    it("persists lockout across independent clients and service restart", async () => {
      for (let n = 0; n < 5; n++)
        await expect(
          service.login(
            { username: "robin.park", passcode: "5826" },
            `remote-${n}`,
          ),
        ).rejects.toMatchObject({ status: 401 });
      await expect(
        service.login(
          { username: "robin.park", passcode: "4729" },
          "remote-new",
        ),
      ).rejects.toMatchObject({ status: 401 });
      now += 900001;
      const restart = new SpectatorAccessService(repo, () => now);
      const session = await restart.login(
        { username: "robin.park", passcode: "4729" },
        "remote-new",
      );
      expect(restart.identity(session.accessToken).strongAuth).toBe(false);
      restart.close();
    });
    it("allows an active spectator own invitations and own follow preference without exposing private profile fields", async () => {
      const session = await service.login(
          { username: "robin.park", passcode: "4729" },
          "three",
        ),
        identity = service.identity(session.accessToken),
        principal = await store.withIdentityContext(identity, () =>
          store.principal(identity),
        );
      const token = await issue(principal, "spectator");
      expect(token).toHaveLength(43);
      const scope = {
        operation: "community.read",
        requestedRole: "spectator" as const,
        teamId,
        seasonId,
      };
      const choices = await store.withActorContext(principal, scope, () =>
        repo.connections(principal, teamId, seasonId, "spectator"),
      );
      expect(choices.players).toHaveLength(8);
      expect(Object.keys(choices.players[0]).sort()).toEqual(["id", "label"]);
      await store.withActorContext(
        principal,
        { ...scope, operation: "community.write" },
        () =>
          repo.follow(
            principal,
            teamId,
            seasonId,
            "spectator",
            choices.players[0].id,
            randomUUID(),
          ),
      );
      expect(
        (
          await store.withActorContext(principal, scope, () =>
            repo.connections(principal, teamId, seasonId, "spectator"),
          )
        ).followedPlayerId,
      ).toBe(choices.players[0].id);
      await expect(
        store.withActorContext(
          principal,
          { ...scope, operation: "community.write" },
          () =>
            repo.follow(
              principal,
              teamId,
              seasonId,
              "spectator",
              "foreign-player",
              randomUUID(),
            ),
        ),
      ).rejects.toMatchObject({ status: 400 });
      await owner.query(
        "UPDATE memberships SET revoked_at=$1 WHERE account_id=$2 AND role='spectator'",
        [now, principal.accountId],
      );
      await expect(
        store.withActorContext(principal, scope, () =>
          repo.connections(principal, teamId, seasonId, "spectator"),
        ),
      ).rejects.toMatchObject({ status: 404 });
    });
    it("accepts private invite requests without account access and restricts staff review to the team", async () => {
      const directory = await service.directory(),
        team = directory.find((t) => t.teamId === teamId)!;
      const input = {
        requestId: randomUUID(),
        clubId: team.clubId,
        teamId,
        seasonId,
        requestedRole: "player" as const,
        name: "Alex Parent",
        email: "alex@example.invalid",
      };
      expect(await service.request(input, "request-a")).toMatchObject({
        status: "pending",
      });
      await expect(
        worker.query("SELECT * FROM spectator_invite_directory()"),
      ).rejects.toMatchObject({ code: "42501" });
      const choices = await store.withActorContext(
        manager,
        {
          operation: "community.read",
          requestedRole: "manager",
          teamId,
          seasonId,
        },
        () => repo.requests(manager, teamId, seasonId, "manager"),
      );
      expect(choices).toEqual([
        expect.objectContaining({
          email: input.email,
          requestedRole: "player",
        }),
      ]);
      const otherIdentity = {
          issuer: "urn:longball:synthetic",
          subject: "synthetic-account-other-manager",
          strongAuth: true,
          authenticatedAt: now,
        },
        other = await store.withIdentityContext(otherIdentity, () =>
          store.principal(otherIdentity),
        );
      await expect(
        store.withActorContext(
          other,
          {
            operation: "community.read",
            requestedRole: "manager",
            teamId,
            seasonId,
          },
          () => repo.requests(other, teamId, seasonId, "manager"),
        ),
      ).rejects.toMatchObject({ status: 404 });
    });
  },
);
