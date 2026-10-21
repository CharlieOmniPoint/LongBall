import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { createApi } from './server';
import { createPostgresApi } from './postgres-server';
import { PostgresStore } from './postgres-store';
import { PgMediaService } from './postgres-media';
import { PostgresActivationService } from './postgres-activation';
import { applyRuntimeGrants } from './runtime-grants';
import { EVENT_CONTRACT_VERSION, SYNTHETIC_IDS } from './store';
import type { PreparationCommand, PreparationState } from '../../../packages/application/src/preparation';

const configuredUrl = process.env.LONGBALL_POSTGRES_TEST_URL;
for (const backend of ['sqlite', 'postgres'] as const) {
  describe.skipIf(backend === 'postgres' && !configuredUrl)(`${backend} atomic recurring training HTTP`, () => {
    it('preserves occurrence evidence, exact retries and scoped authority through series creation, editing and cancellation', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'longball-recurring-training-'));
      let api: ReturnType<typeof createApi> | Awaited<ReturnType<typeof createPostgresApi>> | undefined;
      let admin: Pool | undefined, owner: PostgresStore | undefined, media: PgMediaService | undefined;
      const suffix = randomUUID().replaceAll('-', ''), database = `lb_training_${suffix}`, apiRole = `lb_training_api_${suffix}`, workerRole = `lb_training_worker_${suffix}`;
      try {
        if (backend === 'postgres') {
          admin = new Pool({ connectionString: configuredUrl, max: 2 });
          await admin.query(`CREATE DATABASE "${database}"`);
          for (const role of [apiRole, workerRole]) await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
          const ownerUrl = new URL(configuredUrl!); ownerUrl.pathname = `/${database}`;
          owner = await PostgresStore.open(ownerUrl.href); await owner.seedSynthetic();
          media = await PgMediaService.open({ directory: join(directory, 'media'), database: owner.db });
          await new PostgresActivationService({ store: owner }).initialize();
          await applyRuntimeGrants(owner.db, { apiRole, workerRole });
          const apiUrl = new URL(ownerUrl); apiUrl.username = apiRole; apiUrl.password = '';
          api = await createPostgresApi({ connectionString: apiUrl.href, databasePath: join(directory, 'unused.sqlite'), mediaDirectory: join(directory, 'media'), migrationMode: 'verify', syntheticAuth: true, seedSynthetic: false });
        } else api = createApi({ databasePath: join(directory, 'service.sqlite'), mediaDirectory: join(directory, 'media'), syntheticAuth: true });
        await new Promise<void>(resolve => api!.server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
        const path = `/v1/teams/${SYNTHETIC_IDS.teamId}/preparation?seasonId=${SYNTHETIC_IDS.seasonId}`;
        const call = async (route = path, command?: PreparationCommand, key = randomUUID(), token = 'synthetic-manager-2') => {
          const response = await fetch(base + route, { method: command ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'X-Longball-Role': token.includes('player') ? 'player' : 'manager', ...(command ? { 'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-Api-Contract-Version': EVENT_CONTRACT_VERSION } : {}) }, body: command ? JSON.stringify({ command }) : undefined });
          return { status: response.status, body: await response.json() as PreparationState };
        };
        let state = (await call()).body;
        const profileId = state.profiles[0].id, group = `fixture-series-${suffix}`;
        const occurrences = ['2026-11-05', '2026-11-12', '2026-11-19'].map((date, index) => ({ id: `${group}-${index}`, seasonId: SYNTHETIC_IDS.seasonId, date, time: '18:00', venue: 'Fictional practice pitch', recurrenceGroupId: group, expectedProfileIds: [profileId] }));
        const command: PreparationCommand = { id: randomUUID(), expectedRevision: state.revision, type: 'training.series_created', seasonId: state.activeSeasonId, recurrenceGroupId: group, occurrences, confirmOccurrences: true };
        const key = randomUUID(), created = await call(path, command, key);
        expect(created.status, JSON.stringify(created.body)).toBe(200); state = created.body;
        expect((await call(path, command, key)).body).toEqual(state);
        expect((await call(path, command)).body).toEqual(state);
        expect(state.training.filter(item => item.recurrenceGroupId === group)).toHaveLength(3);
        const apply = async (payload: Record<string, unknown>) => {
          const reply = await call(path, { ...payload, id: randomUUID(), expectedRevision: state.revision } as PreparationCommand);
          expect(reply.status, JSON.stringify(reply.body)).toBe(200); state = reply.body;
        };
        await apply({ type: 'training.status_changed', trainingId: occurrences[0].id, status: 'held' });
        await apply({ type: 'training.attendance_recorded', trainingId: occurrences[0].id, profileId, attendance: 'present' });
        await apply({ type: 'training.status_changed', trainingId: occurrences[1].id, status: 'cancelled' });
        await apply({ type: 'training.response_recorded', trainingId: occurrences[2].id, profileId, response: 'available' });
        const preserved = structuredClone(state.training.filter(item => item.id !== occurrences[2].id));
        await apply({ type: 'training.series_updated', seasonId: state.activeSeasonId, recurrenceGroupId: group, occurrenceIds: [occurrences[2].id], changes: { time: '19:00', venue: 'Fictional west pitch', expectedProfileIds: [profileId] }, confirmOccurrences: true });
        expect(state.training.filter(item => item.id !== occurrences[2].id)).toEqual(preserved);
        expect(state.training.find(item => item.id === occurrences[2].id)).toMatchObject({ date: '2026-11-19', time: '19:00', responses: { [profileId]: 'available' }, attendance: {} });
        const stale = await call(path, { ...command, id: randomUUID(), recurrenceGroupId: 'another-series' });
        expect(stale.status).toBeGreaterThanOrEqual(400);
        const before = structuredClone(state);
        const invalid = await call(path, { ...command, id: randomUUID(), expectedRevision: state.revision, recurrenceGroupId: 'invalid-series', occurrences: occurrences.map((item, index) => ({ ...item, id: `invalid-${index}`, recurrenceGroupId: 'invalid-series', expectedProfileIds: index === 2 ? ['foreign-profile'] : [profileId] })) });
        expect(invalid.status).toBeGreaterThanOrEqual(400); expect((await call()).body).toEqual(before);
        expect((await call(path, { ...command, id: randomUUID(), expectedRevision: state.revision }, randomUUID(), 'synthetic-account-player-01')).status).toBe(404);
        expect((await call(path.replace(SYNTHETIC_IDS.teamId, 'synthetic-other-team'), command)).status).toBe(404);
        await apply({ type: 'training.series_cancelled', seasonId: state.activeSeasonId, recurrenceGroupId: group, occurrenceIds: [occurrences[2].id], confirmOccurrences: true });
        expect(state.training.filter(item => item.id !== occurrences[2].id)).toEqual(preserved);
        expect(state.training.find(item => item.id === occurrences[2].id)).toMatchObject({ status: 'cancelled', responses: { [profileId]: 'available' }, attendance: {} });
        const own = await call(`/v1/teams/${SYNTHETIC_IDS.teamId}/preparation/own?seasonId=${SYNTHETIC_IDS.seasonId}`, undefined, undefined, 'synthetic-account-player-01');
        expect(own.status).toBe(200);
        if (owner) {
          const rows = await owner.many("SELECT payload_json::text FROM jobs WHERE kind='notification.dispatch'") as { payload_json: string }[];
          const jobs = rows.map(row => JSON.parse(row.payload_json) as { entityId: string; businessKey: string });
          const occurrenceJobs = jobs.filter(job => occurrences.some(item => item.id === job.entityId));
          expect(occurrenceJobs.length).toBeGreaterThan(3);
          expect(new Set(occurrenceJobs.map(job => job.businessKey)).size).toBe(occurrenceJobs.length);
          expect(await (api.store as PostgresStore).db.query("SELECT * FROM longball.documents").then(result => result.rowCount)).toBe(0);
        }
      } finally {
        if (api) { api.server.closeAllConnections(); await api.close(); }
        await media?.close(); await owner?.close();
        if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); for (const role of [apiRole, workerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`); await admin.end(); }
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
}
