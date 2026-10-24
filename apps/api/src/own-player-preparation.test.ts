import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "./server";
import { createPostgresApi } from "./postgres-server";
import { PostgresStore } from "./postgres-store";
import { PgMediaService } from "./postgres-media";
import { PostgresActivationService } from "./postgres-activation";
import { applyRuntimeGrants } from "./runtime-grants";
import { EVENT_CONTRACT_VERSION, SYNTHETIC_IDS } from "./store";
import { parseOwnPlayerPreparation } from "../../../packages/application/src/player-preparation";
import type { RecordsState } from "../../../packages/application/src/records";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const testUrl = process.env.LONGBALL_POSTGRES_TEST_URL;
const teamUrl = `/v1/teams/${SYNTHETIC_IDS.teamId}`;
const scope = {
  teamId: SYNTHETIC_IDS.teamId,
  seasonId: SYNTHETIC_IDS.seasonId,
  playerId: "synthetic-player-01",
};
async function start(kind: "sqlite" | "postgres") {
  const directory = mkdtempSync(join(tmpdir(), "longball-own-player-ui07-"));
  cleanups.push(async () =>
    rmSync(directory, { recursive: true, force: true }),
  );
  let owner: PostgresStore | undefined;
  let api:
    | ReturnType<typeof createApi>
    | Awaited<ReturnType<typeof createPostgresApi>>;
  if (kind === "postgres") {
    const admin = new Pool({ connectionString: testUrl!, max: 1 }),
      suffix = randomUUID().replaceAll("-", ""),
      database = `lb_ui07_${suffix}`,
      roles = {
        apiRole: `lb_ui07_api_${suffix}`,
        workerRole: `lb_ui07_worker_${suffix}`,
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
    cleanups.push(() => owner!.close());
    const media = await PgMediaService.open({
      directory: join(directory, "media"),
      database: owner.db,
    });
    cleanups.push(() => media.close());
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
      seedSynthetic: false,
    });
  } else
    api = createApi({
      databasePath: join(directory, "service.sqlite"),
      syntheticAuth: true,
    });
  await new Promise<void>((resolve) =>
    api.server.listen(0, "127.0.0.1", resolve),
  );
  cleanups.push(async () => {
    api.server.closeAllConnections();
    await api.close();
  });
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const call = async (
    path: string,
    {
      token = "synthetic-account-player-01",
      body,
      key,
    }: { token?: string; body?: unknown; key?: string } = {},
  ) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      headers["idempotency-key"] = key ?? randomUUID();
      headers["x-api-contract-version"] = EVENT_CONTRACT_VERSION;
    }
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  return { api, owner, call };
}
for (const kind of ["sqlite", "postgres"] as const)
  describe.skipIf(kind === "postgres" && !testUrl)(
    `UI07 ${kind} authorised own-player HTTP`,
    () => {
      it("persists manager and own RSVP changes into scoped REP02 reports without inventing check-in or permitting client evidence writes", async () => {
        const { call, api, owner } = await start(kind);
        const store = owner ?? api.store;
        const records = await store.document<RecordsState>(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'records');
        const ids = ['synthetic-player-01', 'synthetic-player-02', 'synthetic-player-03'];
        const record = { ...records.results[0], id: SYNTHETIC_IDS.matchId, selectedPlayerIds: ids, attendance: { [ids[0]]: 'not_recorded' as const, [ids[1]]: 'present' as const, [ids[2]]: 'excused' as const } };
        const updatedRecords: RecordsState = { ...records, results: [record] };
        await store.saveDocument(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'records', updatedRecords);
        const ownCommand = { id: randomUUID(), expectedRevision: 0, type: 'own.fixture_response_recorded', fixtureId: SYNTHETIC_IDS.matchId, response: 'unsure' };
        const key = randomUUID();
        const accepted = await call(`${teamUrl}/preparation/own`, { body: { command: ownCommand }, key });
        expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
        const immediate = await call(`${teamUrl}/records`);
        expect(immediate.status, JSON.stringify(immediate.body)).toBe(200);
        expect(immediate.body.participation).toMatchObject({ sourcePreparationRevision: accepted.body.revision, rows: [{ playerId: ids[0], gameRecords: [{ availabilityResponse: 'unsure', actualAttendance: 'not_recorded' }] }] });
        const firstEvidence = await store.document<RecordsState>(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'records');
        const duplicate = await call(`${teamUrl}/preparation/own`, { body: { command: ownCommand }, key });
        expect(duplicate).toEqual(accepted);
        expect((await store.document<RecordsState>(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'records')).revision).toBe(firstEvidence.revision);
        const managerCommand = { id: randomUUID(), expectedRevision: accepted.body.revision, type: 'fixture.response_recorded', fixtureId: SYNTHETIC_IDS.matchId, profileId: `${ids[1]}:${SYNTHETIC_IDS.seasonId}`, response: 'unavailable' };
        const changed = await call(`${teamUrl}/preparation`, { token: 'synthetic-manager-1', body: { command: managerCommand } });
        expect(changed.status, JSON.stringify(changed.body)).toBe(200);
        const manager = await call(`${teamUrl}/records`, { token: 'synthetic-manager-1' });
        expect(manager.status, JSON.stringify(manager.body)).toBe(200);
        const managerRows = (manager.body.participation as { rows: { playerId: string; gameRecords: Record<string, unknown>[]; games: { attendanceRecordedCount: number } }[] }).rows;
        expect(managerRows.find(row => row.playerId === ids[0])?.gameRecords[0]).toMatchObject({ eventType: 'game', availabilityResponse: 'unsure', actualAttendance: 'not_recorded', correctionProvenance: { sourcePreparationCommandId: managerCommand.id } });
        expect(managerRows.find(row => row.playerId === ids[0])?.games.attendanceRecordedCount).toBe(0);
        expect(managerRows.find(row => row.playerId === ids[1])?.gameRecords[0]).toMatchObject({ availabilityResponse: 'unavailable', actualAttendance: 'present' });
        const own = await call(`${teamUrl}/records`);
        expect(own.status).toBe(200);
        const participation = own.body.participation as { rows: { playerId: string; gameRecords: Record<string, unknown>[] }[] };
        expect(participation.rows).toHaveLength(1);
        expect(participation.rows[0].gameRecords[0]).toMatchObject({ availabilityResponse: 'unsure', actualAttendance: 'not_recorded' });
        expect(JSON.stringify(participation)).not.toContain(ids[1]);
        const spectator = await call(`${teamUrl}/records`, { token: 'synthetic-spectator' });
        expect(spectator.status).toBe(200);
        expect(spectator.body.participation).toMatchObject({ access: 'denied', rows: [] });
        const exportReply = await call(`${teamUrl}/records/export?kind=season&format=json`);
        expect(exportReply.status).toBe(200);
        expect(JSON.parse(String(exportReply.body.body)).participation.rows[0].gameRecords[0]).toMatchObject({ availabilityResponse: 'unsure', actualAttendance: 'not_recorded' });
        const forged = await call(`${teamUrl}/records`, { token: 'synthetic-manager-1', body: { command: { type: 'game.evidence.replace', commandId: randomUUID(), evidence: [] } } });
        expect(forged.status).toBe(403);
        expect(forged.body).toMatchObject({ code: 'SERVICE_OWNED_PROJECTION' });
        if (api.store instanceof PostgresStore) expect(await api.store.many('SELECT * FROM documents')).toEqual([]);
      });
      it("accepts own preferences and held-training RSVP without granting manager-record writes", async () => {
        const { call, api, owner } = await start(kind);
        const store = owner ?? api.store;
        const trainingId = `rep02-own-training-${kind}`;
        const created = await call(`${teamUrl}/preparation`, { token: 'synthetic-manager-1', body: { command: { id: randomUUID(), expectedRevision: 0, type: 'training.saved', training: { id: trainingId, seasonId: SYNTHETIC_IDS.seasonId, date: '2026-10-20', time: '18:00', venue: 'South training pitch', recurrenceGroupId: null, expectedProfileIds: [`synthetic-player-01:${SYNTHETIC_IDS.seasonId}`] } } } });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const held = await call(`${teamUrl}/preparation`, { token: 'synthetic-manager-1', body: { command: { id: randomUUID(), expectedRevision: created.body.revision, type: 'training.status_changed', trainingId, status: 'held' } } });
        expect(held.status, JSON.stringify(held.body)).toBe(200);
        const before = await store.document<RecordsState>(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'records');
        const responded = await call(`${teamUrl}/preparation/own`, { body: { command: { id: randomUUID(), expectedRevision: held.body.revision, type: 'own.training_response_recorded', trainingId, response: 'available' } } });
        expect(responded.status, JSON.stringify(responded.body)).toBe(200);
        const preferences = await call(`${teamUrl}/preparation/own`, { body: { command: { id: randomUUID(), expectedRevision: responded.body.revision, type: 'own.preferences_saved', preferences: ['GK', 'CB', 'ST'] } } });
        expect(preferences.status, JSON.stringify(preferences.body)).toBe(200);
        expect((await store.document<RecordsState>(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'records')).revision).toBe(before.revision);
        const own = await call(`${teamUrl}/records`);
        expect(own.status, JSON.stringify(own.body)).toBe(200);
        const rows = (own.body.participation as { rows: { trainingRecords: { eventId: string; actualAttendance: string; availabilityResponse: string }[] }[] }).rows;
        expect(rows[0].trainingRecords.find(item => item.eventId === trainingId)).toMatchObject({ eventType: 'training', availabilityResponse: 'available', actualAttendance: 'not_recorded' });
        if (api.store instanceof PostgresStore) expect(await api.store.many('SELECT * FROM documents')).toEqual([]);
      });
      it("returns saved arrival, format and duration through fresh own views/replies while filtering private preparation", async () => {
        const { call, api } = await start(kind);
        let revision = 0;
        const apply = async (command: Record<string, unknown>) => {
          const reply = await call(`${teamUrl}/preparation`, {
            token: "synthetic-manager-1",
            body: {
              command: {
                id: randomUUID(),
                expectedRevision: revision,
                ...command,
              },
            },
          });
          expect(reply.status, JSON.stringify(reply.body)).toBe(200);
          revision = Number(reply.body.revision);
          return reply.body;
        };
        await apply({
          type: "fixture.saved",
          fixture: {
            id: SYNTHETIC_IDS.matchId,
            seasonId: SYNTHETIC_IDS.seasonId,
            opponent: "Fictional saved UI07 FC",
            playedDate: "2026-10-24",
            arrival: "08:35",
            kickoff: "09:05",
            venue: "Fictional south pitch",
            homeAway: "away",
            format: 5,
            plannedHalfDurationMs: 1_050_000,
          },
        });
        await apply({
          type: "fixture.response_recorded",
          fixtureId: SYNTHETIC_IDS.matchId,
          profileId: `synthetic-player-02:${SYNTHETIC_IDS.seasonId}`,
          response: "unavailable",
        });
        await apply({
          type: "fixture.response_recorded",
          fixtureId: SYNTHETIC_IDS.matchId,
          profileId: `synthetic-player-01:${SYNTHETIC_IDS.seasonId}`,
          response: "unsure",
        });
        const reply = await call(`${teamUrl}/preparation/own`);
        expect(reply.status).toBe(200);
        const own = parseOwnPlayerPreparation(reply.body, scope);
        expect(own.fixtures.find(item => item.id === SYNTHETIC_IDS.matchId)!).toMatchObject({
          arrival: "08:35",
          kickoff: "09:05",
          format: 5,
          plannedHalfDurationMs: 1_050_000,
          homeAway: "away",
          venue: "Fictional south pitch",
          response: "unsure",
          attendance: "not_recorded",
        });
        for (const key of [
          "profiles",
          "formations",
          "snapshots",
          "matchPlans",
          "club",
          "audit",
          "appliedCommands",
        ])
          expect(own).not.toHaveProperty(key);
        for (const key of [
          "responses",
          "attendanceByPlayer",
          "selectedProfileIds",
          "history",
          "matchPlanDraft",
        ])
          expect(own.fixtures.find(item => item.id === SYNTHETIC_IDS.matchId)!).not.toHaveProperty(key);
        expect(JSON.stringify(own)).not.toContain("synthetic-player-02");
        const accepted = await call(`${teamUrl}/preparation/own`, {
          body: {
            command: {
              id: randomUUID(),
              expectedRevision: revision,
              type: "own.fixture_response_recorded",
              fixtureId: SYNTHETIC_IDS.matchId,
              response: "available",
            },
          },
        });
        expect(accepted.status).toBe(200);
        revision = Number(accepted.body.revision);
        expect(
          parseOwnPlayerPreparation(accepted.body, scope).fixtures.find(item => item.id === SYNTHETIC_IDS.matchId)!,
        ).toMatchObject({
          arrival: "08:35",
          format: 5,
          plannedHalfDurationMs: 1_050_000,
          response: "available",
          attendance: "not_recorded",
        });
        const raw = await call(`${teamUrl}/preparation`, {
          token: "synthetic-manager-1",
        });
        const team = raw.body.team as Record<string, unknown>;
        const { id: _id, ...settings } = team;
        await apply({
          type: "team.updated",
          ...settings,
          defaultPitchPlaces: 11,
          defaultHalfDurationMs: 2_100_000,
        });
        expect(
          parseOwnPlayerPreparation(
            (await call(`${teamUrl}/preparation/own`)).body,
            scope,
          ).fixtures.find(item => item.id === SYNTHETIC_IDS.matchId)!,
        ).toMatchObject({ format: 5, plannedHalfDurationMs: 1_050_000 });
        if (api.store instanceof PostgresStore) {
          expect(await api.store.many("SELECT * FROM documents")).toEqual([]);
          expect(
            await api.store.one(
              "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
            ),
          ).toEqual({ rolsuper: false, rolbypassrls: false });
        }
      });
      it("keeps nullable arrival honest and refuses wrong-team/season/role or revoked player access", async () => {
        const { call, api, owner } = await start(kind);
        const update = await call(`${teamUrl}/preparation`, {
          token: "synthetic-manager-1",
          body: {
            command: {
              id: randomUUID(),
              expectedRevision: 0,
              type: "fixture.saved",
              fixture: {
                id: SYNTHETIC_IDS.matchId,
                seasonId: SYNTHETIC_IDS.seasonId,
                opponent: "Fictional unknown arrival FC",
                playedDate: "2026-10-24",
                arrival: null,
                kickoff: null,
                venue: "Fictional south pitch",
                homeAway: "home",
                format: 7,
                plannedHalfDurationMs: 1_500_000,
              },
            },
          },
        });
        expect(update.status).toBe(200);
        expect(
          parseOwnPlayerPreparation(
            (await call(`${teamUrl}/preparation/own`)).body,
            scope,
          ).fixtures.find(item => item.id === SYNTHETIC_IDS.matchId)!,
        ).toMatchObject({ arrival: null, kickoff: null });
        for (const [path, token] of [
          [
            `${teamUrl}/preparation/own?seasonId=other-season`,
            "synthetic-account-player-01",
          ],
          [
            "/v1/teams/synthetic-other-team/preparation/own",
            "synthetic-account-player-01",
          ],
          [`${teamUrl}/preparation`, "synthetic-account-player-01"],
          [`${teamUrl}/preparation/own`, "synthetic-spectator"],
          [`${teamUrl}/preparation/own`, "synthetic-account-invitee"],
        ])
          expect((await call(path, { token })).status).toBe(404);
        if (owner)
          await owner.execute(
            "UPDATE memberships SET revoked_at=$1 WHERE account_id=$2 AND team_id=$3",
            [Date.now(), "synthetic-account-player-01", SYNTHETIC_IDS.teamId],
          );
        else if (!(api.store instanceof PostgresStore))
          api.store.database
            .prepare(
              "UPDATE memberships SET revoked_at=? WHERE account_id=? AND team_id=?",
            )
            .run(
              Date.now(),
              "synthetic-account-player-01",
              SYNTHETIC_IDS.teamId,
            );
        expect((await call(`${teamUrl}/preparation/own`)).status).toBe(404);
      });
    },
  );
