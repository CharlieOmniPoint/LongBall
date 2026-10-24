import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDatabase, type PgApplicationContext } from "./pg";
import { PostgresStore, SYNTHETIC_IDS } from "./postgres-store";
import { applyRuntimeGrants } from "./runtime-grants";
import { PgMediaService } from "./postgres-media";
import { PostgresActivationService } from "./postgres-activation";
import {
  createMatch,
  replayMatch,
  type MatchState,
} from "../../../packages/domain/src/index";
import { createDemoCompletedMatches } from "../../../packages/application/src/demo-season";
import type { ManagedPreparationState } from "../../../packages/application/src/fixture-management";
import {
  assertTeamOverviewDto,
  projectTeamOverview,
  type TeamOverviewDto,
} from "../../../packages/application/src/team-overview-service";

const configured = process.env.LONGBALL_POSTGRES_TEST_URL;
describe.skipIf(!configured)(
  "restricted all-role team overview metadata",
  () => {
    let admin: Pool,
      owner: PgDatabase,
      api: PgDatabase,
      worker: PgDatabase,
      database = "",
      directory = "",
      preparation: ManagedPreparationState;
    const roles: string[] = [],
      pools: PgDatabase[] = [],
      accepted: MatchState[] = [];
    const parse = <T>(value: unknown): T =>
      (typeof value === "string" ? JSON.parse(value) : value) as T;
    const actor = (
      role: "manager" | "administrator" | "player" | "spectator",
      extra: Partial<Extract<PgApplicationContext, { kind: "actor" }>> = {},
    ): Extract<PgApplicationContext, { kind: "actor" }> => {
      const accountId = {
        manager: "synthetic-account-manager",
        administrator: "synthetic-account-admin",
        player: "synthetic-account-player-01",
        spectator: "synthetic-account-spectator",
      }[role];
      return {
        kind: "actor",
        accountId,
        issuer: "urn:longball:synthetic",
        subject: accountId,
        strongAuth: role === "manager" || role === "administrator",
        authenticatedAtMs: Date.now(),
        nowMs: Date.now(),
        requestedRole: role,
        operation: "team_overview.read",
        clubId: "synthetic-richmond-rovers",
        teamId: SYNTHETIC_IDS.teamId,
        seasonId: SYNTHETIC_IDS.seasonId,
        ...extra,
      };
    };
    const overview = async (
      context: PgApplicationContext,
      team: string = SYNTHETIC_IDS.teamId,
      season: string = SYNTHETIC_IDS.seasonId,
    ) =>
      parse<TeamOverviewDto | null>(
        (
          await api.withContext(context, () =>
            api.query("SELECT longball.team_overview_source($1,$2) AS value", [
              team,
              season,
            ]),
          )
        ).rows[0].value,
      );
    beforeAll(async () => {
      admin = new Pool({ connectionString: configured, max: 2 });
      const suffix = randomUUID().replaceAll("-", "");
      database = `lb_overview_${suffix}`;
      for (const purpose of ["owner", "api", "worker"]) {
        const name = `lb_overview_${purpose}_${suffix}`;
        roles.push(name);
        await admin.query(
          `CREATE ROLE "${name}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
        );
      }
      await admin.query(`CREATE DATABASE "${database}"`);
      const base = new URL(configured!);
      base.pathname = `/${database}`;
      const bootstrap = new Pool({ connectionString: base.href });
      try {
        await bootstrap.query(
          `CREATE SCHEMA longball AUTHORIZATION "${roles[0]}"`,
        );
      } finally {
        await bootstrap.end();
      }
      const connect = (index: number, mode: "apply" | "verify") => {
        const url = new URL(base);
        url.username = roles[index];
        url.password = "";
        const connection = new PgDatabase(url.href, {
          migrationMode: mode,
          maximumConnections: 1,
        });
        pools.push(connection);
        return connection;
      };
      owner = connect(0, "apply");
      await owner.migrate();
      const exists = (
        await owner.query(
          "SELECT to_regprocedure('longball.team_overview_source(text,text)') AS value",
        )
      ).rows[0].value;
      if (!exists)
        await owner.query(
          await readFile(
            new URL(
              "../migrations/postgresql/020_team_overview.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
      const store = new PostgresStore(owner);
      await store.seedSynthetic();
      preparation = await store.document<ManagedPreparationState>(
        SYNTHETIC_IDS.teamId,
        SYNTHETIC_IDS.seasonId,
        "preparation",
      );
      Object.assign(preparation, {
        privateCanary: "private-roster-medical-feedback-response",
      });
      const fixture = preparation.fixtures[0],
        future = {
          ...fixture,
          id: "overview-unprepared",
          playedDate: "2026-11-15",
          opponent: "New fictional fixture",
          kickoff: null,
          venue: "Fictional pitch",
          status: "scheduled" as const,
        };
      preparation.fixtures.push(future);
      const completed = createDemoCompletedMatches()[0],
        config = {
          ...completed.config,
          matchId: "overview-canonical",
          fixture: {
            ...completed.config.fixture!,
            playedDate: "2026-11-15",
            kickoff: "11:00",
          },
        };
      const end = completed.eventHistory!.findIndex(
        (event) => event.type === "goal.recorded",
      );
      accepted.push(
        replayMatch(config, completed.eventHistory!.slice(0, end + 1)),
      );
      preparation.fixtures.push({
        ...future,
        id: config.matchId,
        opponent: "Current metadata",
        kickoff: null,
      });
      for (const id of ["overview-cancelled", "overview-deleted"])
        accepted.push(createMatch({ ...config, matchId: id }));
      preparation.fixtures.push({
        ...future,
        id: "overview-cancelled",
        status: "cancelled",
      });
      preparation.fixtureManagement = {
        actions: [],
        tombstones: [
          {
            fixture: { ...future, id: "overview-deleted" },
            action: {
              commandId: "overview-delete",
              fixtureId: "overview-deleted",
              type: "fixture.deleted",
              actorId: "synthetic-account-manager",
              role: "manager",
              reason: "private-delete-reason",
              at: new Date().toISOString(),
              signature: "private",
            },
          },
        ],
      };
      await owner.query(
        "UPDATE documents SET value_json=$1 WHERE team_id=$2 AND season_id=$3 AND kind='preparation'",
        [
          JSON.stringify(preparation),
          SYNTHETIC_IDS.teamId,
          SYNTHETIC_IDS.seasonId,
        ],
      );
      for (const match of accepted)
        await owner.query(
          "INSERT INTO matches(id,team_id,season_id,config_json,state_json,sharing_policy_json) VALUES($1,$2,$3,$4,$5,$6)",
          [
            match.config.matchId,
            SYNTHETIC_IDS.teamId,
            SYNTHETIC_IDS.seasonId,
            JSON.stringify(match.config),
            JSON.stringify(match),
            "{}",
          ],
        );
      accepted.push(
        ...(
          await owner.query(
            "SELECT state_json FROM matches WHERE team_id=$1 AND season_id=$2 AND id NOT LIKE $3",
            [SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, "overview-%"],
          )
        ).rows.map((row) => parse<MatchState>(row.state_json)),
      );
      directory = await mkdtemp(join(tmpdir(), "longball-overview-"));
      await PgMediaService.open({ directory, database: owner });
      await new PostgresActivationService({ store }).initialize();
      await applyRuntimeGrants(owner, {
        apiRole: roles[1],
        workerRole: roles[2],
      });
      await owner.query(
        `GRANT EXECUTE ON FUNCTION longball.team_overview_source(text,text) TO "${roles[1]}"`,
      );
      api = connect(1, "verify");
      worker = connect(2, "verify");
      await api.migrate();
    });
    afterAll(async () => {
      for (const pool of pools) await pool.close();
      if (database)
        await admin.query(`DROP DATABASE "${database}" WITH(FORCE)`);
      for (const role of roles) await admin.query(`DROP ROLE "${role}"`);
      await admin?.end();
      if (directory) await rm(directory, { recursive: true, force: true });
    });
    it("gives all four current roles only safe metadata with new unprepared fixtures and authoritative cancellation/deletion", async () => {
      const projected = projectTeamOverview(
        preparation,
        accepted,
        SYNTHETIC_IDS.seasonId,
      );
      for (const role of [
        "administrator",
        "manager",
        "player",
        "spectator",
      ] as const) {
        const value = await overview(actor(role));
        expect(value).not.toBeNull();
        assertTeamOverviewDto(value, {
          teamId: SYNTHETIC_IDS.teamId,
          seasonId: SYNTHETIC_IDS.seasonId,
        });
        expect(value).toEqual(projected);
        expect(
          value.games.find((game) => game.id === "overview-unprepared"),
        ).toMatchObject({ status: "scheduled", kickoff: null, active: false });
        expect(
          value.games.find((game) => game.id === "overview-canonical"),
        ).toMatchObject({
          status: "first_half_running",
          kickoff: null,
          opponent: "Current metadata",
          active: true,
        });
        expect(
          value.games.find((game) => game.id === "overview-cancelled"),
        ).toMatchObject({ status: "cancelled", active: false });
        expect(value.games.some((game) => game.id === "overview-deleted")).toBe(
          false,
        );
        expect(JSON.stringify(value)).not.toMatch(
          /private-|profiles|attendance|responses|feedback|goals|score|tombstone|reason/,
        );
      }
    });
    it("fails closed for missing/wrong operation or role, wrong tenant, worker and a revoked spectator grant", async () => {
      for (const extra of [
        { operation: undefined },
        { operation: "records.read" },
        { requestedRole: undefined },
        { requestedRole: "administrator" as const },
      ])
        expect(await overview(actor("player", extra))).toBeNull();
      expect(
        await overview(actor("manager"), "synthetic-other-team"),
      ).toBeNull();
      expect(
        await overview(actor("manager"), SYNTHETIC_IDS.teamId, "other-season"),
      ).toBeNull();
      await expect(
        worker.query("SELECT longball.team_overview_source($1,$2)", [
          SYNTHETIC_IDS.teamId,
          SYNTHETIC_IDS.seasonId,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      await owner.query(
        "UPDATE documents SET value_json=jsonb_set(value_json,'{grants}',(SELECT jsonb_agg(jsonb_set(g,'{revokedAtMs}',to_jsonb($1::bigint))) FROM jsonb_array_elements(value_json->'grants')g)) WHERE team_id=$2 AND season_id=$3 AND kind='community'",
        [Date.now() - 1, SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId],
      );
      expect(await overview(actor("spectator"))).toBeNull();
      expect(await overview(actor("player"))).not.toBeNull();
    });
  },
);
