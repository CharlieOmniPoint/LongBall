import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { assertOfflineSnapshot, canonicalOfflineJson } from '../../../packages/application/src/offline-bundle';
import { attachGrant, createConnectedDocument, mergeDownload, queueConnectedCommand, type ControllerGrant, type MatchDownload } from '../../../packages/application/src/sync';
import { createApi } from './server';
import { createPostgresApi } from './postgres-server';
import { PostgresStore } from './postgres-store';
import { PostgresActivationService } from './postgres-activation';
import { PgMediaService } from './postgres-media';
import { applyRuntimeGrants } from './runtime-grants';
import { EVENT_CONTRACT_VERSION, SYNTHETIC_IDS } from './store';

const configuredUrl = process.env.LONGBALL_POSTGRES_TEST_URL;
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const matchPath = `/v1/matches/${SYNTHETIC_IDS.matchId}`;
async function start(backend: 'sqlite' | 'postgres') {
  const directory = mkdtempSync(join(tmpdir(), 'longball-complete-bundle-'));
  cleanups.push(async () => rmSync(directory, { recursive: true, force: true }));
  let owner: PostgresStore | undefined;
  let api: ReturnType<typeof createApi> | Awaited<ReturnType<typeof createPostgresApi>>;
  if (backend === 'postgres') {
    const admin = new Pool({ connectionString: configuredUrl, max: 2 });
    const suffix = randomUUID().replaceAll('-', ''), database = `lb_bundle_${suffix}`, apiRole = `lb_bundle_api_${suffix}`, workerRole = `lb_bundle_worker_${suffix}`;
    await admin.query(`CREATE DATABASE "${database}"`);
    cleanups.push(async () => { await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`); for (const role of [apiRole, workerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`); await admin.end(); });
    for (const role of [apiRole, workerRole]) await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    const ownerUrl = new URL(configuredUrl!); ownerUrl.pathname = `/${database}`;
    owner = await PostgresStore.open(ownerUrl.href); cleanups.push(() => owner!.close()); await owner.seedSynthetic();
    const media = await PgMediaService.open({ directory: join(directory, 'media'), database: owner.db }); cleanups.push(() => media.close()); await new PostgresActivationService({ store: owner }).initialize();
    await applyRuntimeGrants(owner.db, { apiRole, workerRole });
    const apiUrl = new URL(ownerUrl); apiUrl.username = apiRole; apiUrl.password = '';
    api = await createPostgresApi({ connectionString: apiUrl.href, databasePath: join(directory, 'unused.sqlite'), mediaDirectory: join(directory, 'media'), migrationMode: 'verify', syntheticAuth: true, seedSynthetic: false });
  } else api = createApi({ databasePath: join(directory, 'api.sqlite'), syntheticAuth: true });
  cleanups.push(async () => { api.server.closeAllConnections(); await api.close(); });
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const call = async (suffix: string, input: { body?: unknown; cap?: string; token?: string; role?: string } = {}) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${input.token ?? 'synthetic-manager-1'}`, 'X-Longball-Role': input.role ?? 'manager' };
    if (input.cap) headers['X-Controller-Token'] = input.cap;
    if (input.body !== undefined) { headers['Content-Type'] = 'application/json'; headers['X-Api-Contract-Version'] = EVENT_CONTRACT_VERSION; headers['Idempotency-Key'] = randomUUID(); }
    const response = await fetch(base + matchPath + suffix, { method: input.body === undefined ? 'GET' : 'POST', headers, body: input.body === undefined ? undefined : JSON.stringify(input.body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { api, owner, call };
}

for (const backend of ['sqlite', 'postgres'] as const) describe.skipIf(backend === 'postgres' && !configuredUrl)(`DS10 actual ${backend} consistent offline bundles`, () => {
  it('hashes actual complete accepted evidence/publication and restricts controller downloads without issuing capabilities to observers', async () => {
    const { api, owner, call } = await start(backend);
    const deviceId = 'verified-offline-phone';
    const before = await call(`/download?deviceId=${deviceId}`); expect(before.status, JSON.stringify(before.body)).toBe(200);
    const observed = before.body as unknown as MatchDownload; assertOfflineSnapshot(observed, { matchId: SYNTHETIC_IDS.matchId, deviceId });
    expect(observed.publication.fixtureClass).toBe('development'); expect(observed.publication.sharingPolicy.approvedBy).toBeNull();
    expect(observed.acceptedEvents).toEqual([]); expect(observed.controller).toBeNull();
    expect(observed.state.config.players[0]).toHaveProperty('available', true); expect(observed.state.attendance[observed.state.config.players[0].id]).toBe('not_recorded');
    expect((await call(`/offline-bundle?deviceId=${deviceId}`)).status).toBe(409);
    const acquired = await call('/controller', { body: { deviceId } }); expect(acquired.status, JSON.stringify(acquired.body)).toBe(200);
    const grant = acquired.body as unknown as ControllerGrant;
    expect((await call(`/offline-bundle?deviceId=${deviceId}`, { cap: 'wrong-capability' })).status).toBe(409);
    expect((await call('/offline-bundle?deviceId=another-phone', { cap: grant.controllerToken })).status).toBe(409);
    expect((await call(`/download?deviceId=${deviceId}`, { token: 'synthetic-account-player-01', role: 'player' })).status).toBe(404);
    const initial = await call(`/offline-bundle?deviceId=${deviceId}`, { cap: grant.controllerToken }); expect(initial.status, JSON.stringify(initial.body)).toBe(200);
    const saved = mergeDownload(attachGrant(createConnectedDocument(deviceId, SYNTHETIC_IDS.matchId, '/'), grant), initial.body as unknown as MatchDownload);
    const playerId = saved.localState!.config.selectedPlayerIds[0];
    const queued = queueConnectedCommand(saved, { type: 'attendance.recorded', playerId, status: 'present' }, { monotonicMs: 0, sessionId: 'offline-bundle-test', wallTimeMs: Date.now() }, randomUUID());
    const event = queued.outbox[0].envelope;
    const uploaded = await call('/events', { body: { events: [event] }, cap: grant.controllerToken }); expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
    const result = await call(`/offline-bundle?deviceId=${deviceId}`, { cap: grant.controllerToken }); expect(result.status, JSON.stringify(result.body)).toBe(200);
    const bundle = result.body as unknown as MatchDownload; assertOfflineSnapshot(bundle, { matchId: SYNTHETIC_IDS.matchId, deviceId });
    const { checksumSha256, ...payload } = bundle;
    expect(checksumSha256).toBe(createHash('sha256').update(canonicalOfflineJson(payload)).digest('hex'));
    expect(bundle.acceptedRevision).toBe(1); expect(bundle.acceptedEvents).toHaveLength(1); expect(bundle.acceptedEvents[0].event).toEqual(event); const persisted = owner ? await owner.one('SELECT received_at FROM events WHERE event_id=$1', [event.eventId]) : (api as ReturnType<typeof createApi>).store.database.prepare('SELECT received_at FROM events WHERE event_id=?').get(event.eventId);
    expect(bundle.acceptedEvents[0].receivedAt).toBe(new Date(Number(persisted?.received_at)).toISOString());
    expect(bundle.state.eventHistory?.[0].actorId).toBe('synthetic-account-manager'); expect(bundle.deviceCheckpoint).toEqual({ clientSequence: 1, previousEventId: event.eventId });
    for (const secret of [grant.controllerToken, 'capability_hash', 'birthDate', 'parentEmail', 'ballots', 'photos']) expect(JSON.stringify(bundle)).not.toContain(secret);
    const observer = await call('/download?deviceId=second-manager-phone', { token: 'synthetic-manager-2' }); expect(observer.status).toBe(200); expect(observer.body).not.toHaveProperty('controllerToken');
    expect((await call('/offline-bundle?deviceId=second-manager-phone', { token: 'synthetic-manager-2', cap: grant.controllerToken })).status).toBe(409);
    // A damaged persisted projection cannot be presented as a complete, usable bundle.
    if (owner) await owner.execute("UPDATE matches SET state_json=jsonb_set(state_json,'{revision}','2'::jsonb) WHERE id=$1", [SYNTHETIC_IDS.matchId]);
    else (api as ReturnType<typeof createApi>).store.database.prepare("UPDATE matches SET state_json=json_set(state_json,'$.revision',2) WHERE id=?").run(SYNTHETIC_IDS.matchId);
    expect((await call(`/download?deviceId=${deviceId}`)).status).toBe(422); expect(saved.acceptedRevision).toBe(0); expect(queued.outbox[0].envelope).toBe(event);
  });
  if (backend === 'postgres') it('keeps a competing accepted write outside the entire snapshot transaction', async () => {
    const { api, call } = await start(backend); const store = api.store as PostgresStore; const deviceId = 'concurrent-bundle-phone';
    const acquired = await call('/controller', { body: { deviceId } }); expect(acquired.status).toBe(200); const grant = acquired.body as unknown as ControllerGrant;
    const original = await call(`/offline-bundle?deviceId=${deviceId}`, { cap: grant.controllerToken }); expect(original.status).toBe(200);
    const saved = mergeDownload(attachGrant(createConnectedDocument(deviceId, SYNTHETIC_IDS.matchId, '/'), grant), original.body as unknown as MatchDownload);
    const queued = queueConnectedCommand(saved, { type: 'attendance.recorded', playerId: saved.localState!.config.selectedPlayerIds[0], status: 'present' }, { monotonicMs: 0, sessionId: 'concurrent-snapshot-session', wallTimeMs: Date.now() }, randomUUID());
    let reached!: () => void, release!: () => void;
    const paused = new Promise<void>(resolve => { reached = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
    const many = store.many.bind(store); let intercept = true;
    store.many = async (sql, values) => { const result = await many(sql, values); if (intercept && sql.includes('FROM events WHERE')) { intercept = false; reached(); await resume; } return result; };
    let writerSettled = false;
    const download = call(`/offline-bundle?deviceId=${deviceId}`, { cap: grant.controllerToken });
    try {
      await paused;
      const writer = call('/events', { body: { events: [queued.outbox[0].envelope] }, cap: grant.controllerToken }).then(result => { writerSettled = true; return result; });
      await new Promise(resolve => setTimeout(resolve, 40)); expect(writerSettled).toBe(false);
      release();
      const snapshot = await download; expect(snapshot.status, JSON.stringify(snapshot.body)).toBe(200);
      assertOfflineSnapshot(snapshot.body as unknown as MatchDownload, { matchId: SYNTHETIC_IDS.matchId, deviceId });
      expect(snapshot.body.acceptedRevision).toBe(0); expect(snapshot.body.acceptedEvents).toEqual([]);
      expect((await writer).status).toBe(200);
      const next = await call(`/offline-bundle?deviceId=${deviceId}`, { cap: grant.controllerToken }); expect(next.status).toBe(200); expect(next.body.acceptedRevision).toBe(1); expect(next.body.acceptedEvents).toHaveLength(1);
    } finally { release(); store.many = many; await download; }
  });
});
