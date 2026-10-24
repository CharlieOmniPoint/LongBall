import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDatabase, type PgApplicationContext } from "./pg";
import { PostgresStore, SYNTHETIC_IDS } from "./postgres-store";
import { applyRuntimeGrants } from "./runtime-grants";
import { PgMediaService } from "./postgres-media";
import { PostgresActivationService } from "./postgres-activation";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPlayerStatsDto,
  playerStatsSourceFromRecords,
  projectPlayerStats,
  type PlayerStatsSource,
} from "../../../packages/application/src/player-stats";
import type { RecordsState } from "../../../packages/application/src/records";
import type { MatchState } from "../../../packages/domain/src/index";
import { replayMatch } from "../../../packages/domain/src/index";
import { createDemoCompletedMatches } from "../../../packages/application/src/demo-season";

const configured = process.env.LONGBALL_POSTGRES_TEST_URL;
describe.skipIf(!configured)(
  "restricted administrator aggregate player statistics",
  () => {
    let admin: Pool,
      owner: PgDatabase,
      api: PgDatabase,
      worker: PgDatabase,
      database = "",
      directory = "";
    const roles: string[] = [],
      pools: PgDatabase[] = [];
    const actor = (
      extra: Partial<Extract<PgApplicationContext, { kind: "actor" }>> = {},
    ): Extract<PgApplicationContext, { kind: "actor" }> => ({
      kind: "actor",
      accountId: "synthetic-account-admin",
      issuer: "urn:longball:synthetic",
      subject: "synthetic-account-admin",
      strongAuth: true,
      authenticatedAtMs: Date.now(),
      nowMs: Date.now(),
      requestedRole: "administrator",
      operation: "stats.read",
      clubId: "synthetic-richmond-rovers",
      teamId: SYNTHETIC_IDS.teamId,
      seasonId: SYNTHETIC_IDS.seasonId,
      ...extra,
    });
    const parse = <T>(value: unknown): T =>
      (typeof value === "string" ? JSON.parse(value) : value) as T;
    const source = async (
      context = actor(),
      team: string = SYNTHETIC_IDS.teamId,
      season: string = SYNTHETIC_IDS.seasonId,
    ) =>
      parse<PlayerStatsSource | null>(
        (
          await api.withContext(context, () =>
            api.query(
              "SELECT longball.admin_player_stats_source($1,$2) AS value",
              [team, season],
            ),
          )
        ).rows[0].value,
      );
    beforeAll(async () => {
      admin = new Pool({ connectionString: configured, max: 2 });
      const suffix = randomUUID().replaceAll("-", "");
      database = `lb_stats_${suffix}`;
      for (const purpose of ["owner", "api", "worker"]) {
        const name = `lb_stats_${purpose}_${suffix}`;
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
          "SELECT to_regprocedure('longball.admin_player_stats_source(text,text)') AS value",
        )
      ).rows[0].value;
      if (!exists)
        await owner.query(
          await readFile(
            new URL(
              "../migrations/postgresql/019_player_stats.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
      const store = new PostgresStore(owner);
      await store.seedSynthetic();
      const completed = createDemoCompletedMatches()[0];
      const accepted = replayMatch(
        { ...completed.config, matchId: "stats-checkpoint-match" },
        completed.eventHistory ?? [],
      );
      await owner.query(
        "INSERT INTO matches(id,team_id,season_id,config_json,state_json,sharing_policy_json) VALUES($1,$2,$3,$4,$5,$6)",
        [
          accepted.config.matchId,
          SYNTHETIC_IDS.teamId,
          SYNTHETIC_IDS.seasonId,
          JSON.stringify(accepted.config),
          JSON.stringify(accepted),
          "{}",
        ],
      );
      directory = await mkdtemp(join(tmpdir(), "longball-stats-"));
      await PgMediaService.open({ directory, database: owner });
      await new PostgresActivationService({ store }).initialize();
      await applyRuntimeGrants(owner, {
        apiRole: roles[1],
        workerRole: roles[2],
      });
      await owner.query(
        `GRANT EXECUTE ON FUNCTION longball.admin_player_stats_source(text,text) TO "${roles[1]}"`,
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
    it("returns only numeric accepted facts and labels, with the canonical manager totals and no private canaries", async () => {
      await owner.query(
        "UPDATE documents SET value_json=jsonb_set(value_json,'{privateCanary}','\"private-feedback-injury-attendance-profile\"') WHERE team_id=$1 AND season_id=$2 AND kind IN('records','preparation')",
        [SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId],
      );
      const value = await source();
      expect(value).not.toBeNull();
      expect(JSON.stringify(value)).not.toMatch(
        /privateCanary|private-feedback|attendance|feedback|preferences|injury|profile|exceptionReason/,
      );
      expect(
        value!.matches.every(
          (match) => match.goals.length === 0 && match.finalScore === null,
        ),
      ).toBe(true);
      const projected = projectPlayerStats(value!, { role: "administrator" });
      assertPlayerStatsDto(projected, {
        role: "administrator",
        teamId: SYNTHETIC_IDS.teamId,
        seasonId: SYNTHETIC_IDS.seasonId,
      });
      const state = parse<RecordsState>(
        (
          await owner.query(
            "SELECT value_json FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='records'",
            [SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId],
          )
        ).rows[0].value_json,
      );
      const matches = (
        await owner.query(
          "SELECT state_json FROM matches WHERE team_id=$1 AND season_id=$2",
          [SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId],
        )
      ).rows.map((row) => ({
        teamId: SYNTHETIC_IDS.teamId,
        seasonId: SYNTHETIC_IDS.seasonId,
        match: parse<MatchState>(row.state_json),
      }));
      const manager = projectPlayerStats(
        playerStatsSourceFromRecords({
          state,
          acceptedMatches: matches,
          positions: value!.positions,
          formation: value!.formation,
        }),
        { role: "manager" },
      );
      expect(projected).toEqual(manager);
      await api.withContext(actor(), async () => {
        expect(
          (
            await api.query(
              "SELECT value_json FROM documents WHERE kind IN('records','preparation')",
            )
          ).rows,
        ).toEqual([]);
        expect(
          (await api.query("SELECT state_json FROM matches")).rows,
        ).toEqual([]);
      });
    });
    it("requires the exact current administrator, request operation, tenant and season and denies worker/helper access", async () => {
      for (const changes of [
        { requestedRole: "manager" as const },
        { operation: "records.read" },
        { operation: undefined },
        { strongAuth: false },
        {
          accountId: "synthetic-account-player-01",
          subject: "synthetic-account-player-01",
        },
      ])
        expect(await source(actor(changes))).toBeNull();
      expect(await source(actor(), "synthetic-other-team")).toBeNull();
      expect(
        await source(actor(), SYNTHETIC_IDS.teamId, "other-season"),
      ).toBeNull();
      await expect(
        worker.query("SELECT longball.admin_player_stats_source($1,$2)", [
          SYNTHETIC_IDS.teamId,
          SYNTHETIC_IDS.seasonId,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        api.query("SELECT longball.stats_scorer_totals('[]')"),
      ).rejects.toMatchObject({ code: "42501" });
      await owner.query(
        "UPDATE memberships SET revoked_at=$1 WHERE account_id='synthetic-account-admin' AND team_id=$2 AND season_id=$3 AND role='administrator'",
        [Date.now() - 1, SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId],
      );
      expect(await source()).toBeNull();
    });
  },
);
