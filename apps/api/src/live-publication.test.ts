import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { createMatch, reduceMatch, type MatchConfig, type MatchEvent } from '../../../packages/domain/src';
import { createApi } from './server';
import { createPostgresApi } from './postgres-server';
import { PostgresStore } from './postgres-store';
import { PostgresActivationService } from './postgres-activation';
import { PgMediaService } from './postgres-media';
import { applyRuntimeGrants } from './runtime-grants';
import { EVENT_CONTRACT_VERSION, SYNTHETIC_IDS } from './store';
import type { RecordsState } from '../../../packages/application/src/records';
import type { recordsServiceView } from '../../../packages/application/src/records-service';

const configuredUrl = process.env.LONGBALL_POSTGRES_TEST_URL;
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const scope = `?seasonId=${SYNTHETIC_IDS.seasonId}`;
const recordsPath = `/v1/teams/${SYNTHETIC_IDS.teamId}/records`;
type View = ReturnType<typeof recordsServiceView>;

function recordedMatch(config: MatchConfig) {
  let match = createMatch(config), counter = 0;
  const send = (command: Omit<MatchEvent, 'id' | 'sample'>) => {
    match = reduceMatch(match, { ...command, id: `publication-fixture-${++counter}`, sample: {
      monotonicMs: counter * 100, sessionId: 'accepted-policy-fixture', wallTimeMs: Date.now() + counter * 100,
    } } as MatchEvent);
  };
  for (const playerId of config.selectedPlayerIds) send({ type: 'attendance.recorded', playerId, status: 'present' } as Omit<MatchEvent, 'id' | 'sample'>);
  send({ type: 'lineup.staged', lineup: ['GK', 'CB', 'CB', 'CM', 'LW', 'RW', 'ST'].map((position, index) => ({ position, slotId: `slot-${index}`, playerId: config.selectedPlayerIds[index] })) } as Omit<MatchEvent, 'id' | 'sample'>);
  send({ type: 'half.started' });
  send({ type: 'goal.recorded', beneficiary: 'us', scorerPlayerId: null, goalType: 'open_play', isOwnGoal: false } as Omit<MatchEvent, 'id' | 'sample'>);
  send({ type: 'half.ended' }); send({ type: 'half.started' }); send({ type: 'half.ended' });
  return match;
}

async function start(backend: 'sqlite' | 'postgres') {
  const directory = mkdtempSync(join(tmpdir(), 'longball-live-publication-'));
  cleanups.push(async () => rmSync(directory, { recursive: true, force: true }));
  let owner: PostgresStore | undefined;
  let api: ReturnType<typeof createApi> | Awaited<ReturnType<typeof createPostgresApi>>;
  if (backend === 'postgres') {
    const admin = new Pool({ connectionString: configuredUrl, max: 1 });
    const suffix = randomUUID().replaceAll('-', ''), database = `lb_live_policy_${suffix}`;
    const apiRole = `lb_live_api_${suffix}`, workerRole = `lb_live_job_${suffix}`;
    await admin.query(`CREATE DATABASE "${database}"`);
    cleanups.push(async () => { await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); for (const role of [apiRole, workerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`); await admin.end(); });
    for (const role of [apiRole, workerRole]) await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    const ownerUrl = new URL(configuredUrl!); ownerUrl.pathname = `/${database}`;
    owner = await PostgresStore.open(ownerUrl.href); cleanups.push(() => owner!.close());
    await owner.seedSynthetic({ demoSharing: true });
    const media = await PgMediaService.open({ directory: join(directory, 'media'), database: owner.db }); cleanups.push(() => media.close());
    await new PostgresActivationService({ store: owner }).initialize();
    await applyRuntimeGrants(owner.db, { apiRole, workerRole });
    const apiUrl = new URL(ownerUrl); apiUrl.username = apiRole; apiUrl.password = '';
    api = await createPostgresApi({ connectionString: apiUrl.href, databasePath: join(directory, 'unused.sqlite'), mediaDirectory: join(directory, 'media'), migrationMode: 'verify', syntheticAuth: true, demoScenario: true, seedSynthetic: false });
  } else api = createApi({ databasePath: join(directory, 'api.sqlite'), syntheticAuth: true, demoScenario: true });
  cleanups.push(async () => { api.server.closeAllConnections(); await api.close(); });
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const stored = owner ? await owner.match(SYNTHETIC_IDS.matchId) : (api as ReturnType<typeof createApi>).store.match(SYNTHETIC_IDS.matchId);
  const match = recordedMatch(JSON.parse(stored.config_json));
  if (owner) await owner.execute('UPDATE matches SET state_json=$1,last_sync_at=$2 WHERE id=$3', [JSON.stringify(match), Date.now(), SYNTHETIC_IDS.matchId]);
  else (api as ReturnType<typeof createApi>).store.database.prepare('UPDATE matches SET state_json=?,last_sync_at=? WHERE id=?').run(JSON.stringify(match), Date.now(), SYNTHETIC_IDS.matchId);
  const setRecords = async (value: RecordsState) => {
    if (owner) await owner.saveDocument(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'records', value);
    else (api as ReturnType<typeof createApi>).store.saveDocument(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'records', value);
  };
  const policy = JSON.parse(stored.sharing_policy_json);
  const setPolicy = async (shareScores: boolean, shareDerivedResults: boolean) => {
    const next = JSON.stringify({ ...policy, version: `${policy.version}-${Number(shareScores)}-${Number(shareDerivedResults)}`, shareScores, shareDerivedResults });
    if (owner) await owner.execute('UPDATE matches SET sharing_policy_json=$1 WHERE id=$2', [next, SYNTHETIC_IDS.matchId]);
    else (api as ReturnType<typeof createApi>).store.database.prepare('UPDATE matches SET sharing_policy_json=? WHERE id=?').run(next, SYNTHETIC_IDS.matchId);
  };
  const call = async <T = Record<string, unknown>>(path: string, role = 'spectator', command?: unknown) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${role === 'manager' ? 'synthetic-manager-1' : role === 'player' ? 'synthetic-account-player-01' : 'synthetic-spectator'}`, 'X-Longball-Role': role };
    if (command) Object.assign(headers, { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), 'X-Api-Contract-Version': EVENT_CONTRACT_VERSION });
    const response = await fetch(base + path, { method: command ? 'POST' : 'GET', headers, body: command ? JSON.stringify(command) : undefined });
    return { status: response.status, body: await response.json() as T };
  };
  const view = async (role = 'spectator'): Promise<View> => { const response = await call<View>(recordsPath + scope, role); expect(response.status, JSON.stringify(response.body)).toBe(200); return response.body; };
  const command = async (value: Record<string, unknown>) => call<View & { editableState: RecordsState }>(recordsPath + scope, 'manager', { command: { commandId: randomUUID(), ...value } });
  return { api, owner, match, setRecords, setPolicy, call, view, command };
}

for (const backend of ['sqlite', 'postgres'] as const) describe.skipIf(backend === 'postgres' && !configuredUrl)(`current live publication through actual ${backend} HTTP`, () => {
  it('keeps demo publication scoped, intersects current score/derived decisions, rejects injected approval and invalidates class changes', async () => {
    const fixture = await start(backend), { match, view, call, command } = fixture;
    const current = (value: View) => value.matches.find(report => report.matchId === match.config.matchId)!;
    expect(current(await view())).toMatchObject({ score: { for: 1, against: 0 }, policyId: 'demo-simulated-scores-v1' });
    const before = await call<View & { editableState: RecordsState }>(recordsPath + scope, 'manager');
    const state = before.body.editableState as RecordsState;
    expect(state.results).toHaveLength(3); // No invented played result was needed for initial approval.
    const unapproved = structuredClone(state); delete unapproved.initialLivePublication;
    await fixture.setRecords(unapproved);
    expect(current(await view()).score).toBeNull(); // A permissive current row never approves an unconfirmed report.
    expect((await call(`/v1/matches/${match.config.matchId}`)).body.score).toEqual({ for: 1, against: 0 });
    await fixture.setRecords(state);
    expect(current(await view()).score).toEqual({ for: 1, against: 0 });
    const injected = await command({ type: 'live.context.set', details: { ...state.liveMatch, initialLivePublication: { confirmed: true } } });
    expect(injected.status).toBe(422);
    const archived = await command({ type: 'live.archive', matchId: match.config.matchId, expectedSourceMatchRevision: match.revision });
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    expect((await view()).results.totals?.played).toBe(4);
    await fixture.setPolicy(true, false);
    expect(current(await view()).score).toEqual({ for: 1, against: 0 });
    expect((await view()).results.totals).toBeNull();
    const own = await view('player');
    expect(own.participation.access).not.toBe('denied');
    expect(own.participation.rows.map(row => row.playerId)).toEqual(['synthetic-player-01']);
    const visibleExport = await call<{ body: string; policyFingerprint: string }>(recordsPath + '/export' + scope + `&kind=match&format=json&matchId=${match.config.matchId}`);
    expect(visibleExport.status, JSON.stringify(visibleExport.body)).toBe(200);
    const visibleDocument = JSON.parse(visibleExport.body.body);
    expect(visibleDocument.matches.find((report: { matchId: string }) => report.matchId === match.config.matchId).score).toEqual({ for: 1, against: 0 });
    await fixture.setPolicy(false, true);
    expect(current(await view()).score).toBeNull();
    const deniedDto = await call(`/v1/matches/${match.config.matchId}`);
    expect(deniedDto.body).toMatchObject({ score: null, sharingRestricted: true });
    const deniedExport = await call<{ body: string; policyFingerprint: string }>(recordsPath + '/export' + scope + `&kind=match&format=json&matchId=${match.config.matchId}`);
    expect(deniedExport.status).toBe(200);
    expect(JSON.parse(deniedExport.body.body).matches.find((report: { matchId: string }) => report.matchId === match.config.matchId).score).toBeNull();
    expect(deniedExport.body.policyFingerprint).not.toBe(visibleExport.body.policyFingerprint);
    await fixture.setPolicy(true, true);
    expect(current(await view()).score).toEqual({ for: 1, against: 0 });
    const friendly = await command({ type: 'live.context.set', details: { ...state.liveMatch, fixtureClass: 'friendly' } });
    expect(friendly.status, JSON.stringify(friendly.body)).toBe(200);
    expect(current(await view()).score).toBeNull();
    const back = await command({ type: 'live.context.set', details: state.liveMatch });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(current(await view()).score).toBeNull();
    expect(back.body.editableState.liveMatch.fixtureClass).toBe('development');
    expect(back.body.editableState.results.find((record: { id: string }) => record.id === match.config.matchId)?.publication.confirmed).toBe(false);
    expect(friendly.body.editableState.audit.at(-1)).toMatchObject({ action: 'live.context.set', before: { publication: { confirmed: true } }, after: { publication: { confirmed: false } } });
  });
});
