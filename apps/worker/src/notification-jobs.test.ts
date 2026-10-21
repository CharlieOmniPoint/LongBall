import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defaultCommunityPreferences, type CommunityState } from '../../../packages/application/src/community';
import type { PreparationState } from '../../../packages/application/src/preparation';
import { claimTeamNotificationJob, type TeamNotificationJob, type TeamNotificationProvider } from '../../../packages/application/src/team-notifications';
import { PostgresStore } from '../../api/src/postgres-store';
import { PgDatabase } from '../../api/src/pg';
import { DevelopmentStore, SYNTHETIC_IDS } from '../../api/src/store';
import { createTeamNotificationJob, enqueueTeamNotification, runDueTeamNotifications } from './notification-jobs';

const configuredUrl = process.env.LONGBALL_POSTGRES_TEST_URL;
const initialTime = Date.parse('2026-10-21T10:00:00Z');
type Store = DevelopmentStore | PostgresStore;
interface Harness {
  store: Store; now: () => number; setTime: (value: number) => void;
  execute: (sql: string, values?: unknown[]) => Promise<void>;
  jobs: () => Promise<TeamNotificationJob[]>;
  community: () => Promise<CommunityState>;
  saveCommunity: (state: CommunityState) => Promise<void>;
  fixtureId: string; reopen: () => Promise<void>;
}
const cleanups: (() => Promise<void>)[] = [];
let admin: PgDatabase;
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function setup(postgres: boolean): Promise<Harness> {
  let clock = initialTime;
  const directory = mkdtempSync(join(tmpdir(), 'longball-notification-jobs-'));
  const path = join(directory, 'notifications.sqlite');
  let url: string | undefined, database: string | undefined;
  if (postgres) {
    database = `longball_notifications_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE "${database}"`);
    const parsed = new URL(configuredUrl!); parsed.pathname = `/${database}`; url = parsed.href;
  }
  const open = async (): Promise<Store> => postgres ? PostgresStore.open(url!, () => clock) : new DevelopmentStore(path, () => clock);
  const test = { store: await open() } as Harness;
  cleanups.push(async () => { await test.store.close(); if (database) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`); rmSync(directory, { recursive: true, force: true }); });
  await test.store.seedSynthetic();
  test.now = () => clock; test.setTime = value => { clock = value; };
  test.execute = async (sql, values = []) => {
    if (test.store instanceof PostgresStore) await test.store.execute(sql, values);
    else { let index = 0; const sqliteSql = sql.replace(/\$\d+/g, () => { index++; return '?'; }); expect(index).toBe(values.length); test.store.database.prepare(sqliteSql).run(...values as (string | number | null)[]); }
  };
  test.jobs = async () => {
    const rows = test.store instanceof PostgresStore ? await test.store.many('SELECT payload_json FROM jobs ORDER BY id') : test.store.database.prepare('SELECT payload_json FROM jobs ORDER BY id').all();
    return rows.map(row => JSON.parse(String(row.payload_json)) as TeamNotificationJob);
  };
  test.community = () => Promise.resolve(test.store.document<CommunityState>(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'community'));
  test.saveCommunity = async state => { if (test.store instanceof PostgresStore) await test.store.transaction(() => (test.store as PostgresStore).saveDocument(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'community', state)); else test.store.transaction(() => (test.store as DevelopmentStore).saveDocument(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'community', state)); };
  test.fixtureId = (await test.store.document<PreparationState>(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'preparation')).fixtures[0].id;
  test.reopen = async () => { await test.store.close(); test.store = await open(); };
  return test;
}
function job(test: Harness, overrides: Partial<Parameters<typeof createTeamNotificationJob>[0]> = {}): TeamNotificationJob {
  return createTeamNotificationJob({ id: randomUUID(), businessKey: randomUUID(), accountId: 'synthetic-account-manager', teamId: SYNTHETIC_IDS.teamId, seasonId: SYNTHETIC_IDS.seasonId, audience: 'manager', playerId: null, category: 'schedule', entityId: test.fixtureId, dueAtMs: test.now(), ...overrides });
}
/** Explicit provider test double. No test result represents APNs/FCM or device delivery. */
function fakeProvider(send?: TeamNotificationProvider['send']): { provider: TeamNotificationProvider; sent: Parameters<TeamNotificationProvider['send']>[0][] } {
  const sent: Parameters<TeamNotificationProvider['send']>[0][] = [];
  return { sent, provider: { configured: true, idempotency: 'provider', send: async input => { sent.push(input); return send ? send(input) : { status: 'accepted', receiptId: `test-receipt-${sent.length}` }; } } };
}
function scenarios(postgres: boolean) {
  it('persists a single generic job, rejects conflicting reuse, and blocks without an installed provider', async () => {
    const test = await setup(postgres), original = job(test);
    expect(await enqueueTeamNotification(test.store, original)).toEqual({ duplicate: false, id: original.id });
    expect(await enqueueTeamNotification(test.store, { ...original, id: randomUUID() })).toEqual({ duplicate: true, id: original.id });
    await expect(enqueueTeamNotification(test.store, { ...original, id: randomUUID(), entityId: 'other-opaque-entity' })).rejects.toThrow('NOTIFICATION_KEY_CONFLICT');
    expect(await runDueTeamNotifications(test.store, { now: test.now })).toMatchObject({ blocked: 1, accepted: 0 });
    await test.reopen();
    expect(await test.jobs()).toHaveLength(1);
    expect((await test.jobs())[0]).toMatchObject({ state: 'blocked_provider', lastCode: 'PUSH_PROVIDER_UNCONFIGURED', deliveryAttempts: 0, providerReceiptId: null });
    expect(await runDueTeamNotifications(test.store, { now: test.now })).toMatchObject({ blocked: 0, accepted: 0 });
  });
  it('rechecks changed membership, disabled preferences, and revoked spectator grants before sending', async () => {
    const test = await setup(postgres), fake = fakeProvider();
    await enqueueTeamNotification(test.store, job(test));
    await enqueueTeamNotification(test.store, job(test, { accountId: 'synthetic-account-player-01', audience: 'player', playerId: 'synthetic-player-01' }));
    await enqueueTeamNotification(test.store, job(test, { accountId: 'synthetic-account-spectator', audience: 'spectator', category: 'photos', entityId: 'synthetic-published-pitch' }));
    await test.execute("UPDATE memberships SET revoked_at=$1 WHERE account_id=$2 AND role='manager'", [test.now(), 'synthetic-account-manager']);
    const community = await test.community();
    community.preferences['synthetic-account-player-01'] = { ...defaultCommunityPreferences(), schedule: false };
    community.grants[0].revokedAtMs = test.now(); await test.saveCommunity(community);
    expect(await runDueTeamNotifications(test.store, { provider: fake.provider, now: test.now })).toMatchObject({ accepted: 0, suppressed: 3 });
    expect(fake.sent).toHaveLength(0);
    expect((await test.jobs()).map(value => value.lastCode)).toEqual(expect.arrayContaining(['NO_CURRENT_MEMBERSHIP', 'CHANNEL_DISABLED']));
  });
  it('defers through London DST quiet hours, then rechecks preferences instead of sending stale work', async () => {
    const test = await setup(postgres), fake = fakeProvider(); test.setTime(Date.parse('2026-10-25T00:30:00Z'));
    const community = await test.community(); community.preferences['synthetic-account-manager'] = { ...defaultCommunityPreferences(), quietStart: '01:00', quietEnd: '02:00' }; await test.saveCommunity(community);
    await enqueueTeamNotification(test.store, job(test));
    expect(await runDueTeamNotifications(test.store, { provider: fake.provider, now: test.now })).toMatchObject({ retried: 1, accepted: 0 });
    expect((await test.jobs())[0]).toMatchObject({ state: 'pending', dueAtMs: Date.parse('2026-10-25T02:00:00Z'), lastCode: 'QUIET_HOURS', deliveryAttempts: 0 });
    test.setTime(Date.parse('2026-10-25T02:00:00Z')); community.preferences['synthetic-account-manager'].schedule = false; await test.saveCommunity(community);
    expect(await runDueTeamNotifications(test.store, { provider: fake.provider, now: test.now })).toMatchObject({ suppressed: 1 }); expect(fake.sent).toHaveLength(0);
  });
  it('reopens a durable retry using the same provider key and sends only a generic payload', async () => {
    const test = await setup(postgres), original = job(test);
    const fake = fakeProvider(async () => { if (fake.sent.length === 1) throw new Error('test double lost acknowledgement containing private upstream details'); return { status: 'accepted', receiptId: 'test-second-receipt' }; });
    await enqueueTeamNotification(test.store, original);
    expect(await runDueTeamNotifications(test.store, { provider: fake.provider, now: test.now })).toMatchObject({ retried: 1, accepted: 0 });
    await test.reopen(); test.setTime(test.now() + 30_000);
    expect(await runDueTeamNotifications(test.store, { provider: fake.provider, now: test.now })).toMatchObject({ accepted: 1 });
    expect(fake.sent.map(item => item.idempotencyKey)).toEqual([original.businessKey, original.businessKey]);
    expect(fake.sent[1].payload).toEqual({ body: 'Your team has an update', data: { entityId: test.fixtureId } });
    expect((await test.jobs())[0]).toMatchObject({ state: 'provider_accepted', deliveryAttempts: 2, providerReceiptId: 'test-second-receipt' });
    expect(JSON.stringify(await test.jobs())).not.toContain('upstream details');
    expect(await runDueTeamNotifications(test.store, { provider: fake.provider, now: test.now })).toMatchObject({ accepted: 0 });
  });
  it('leases once across concurrent workers and releases database transactions while a provider is pending', async () => {
    const test = await setup(postgres), original = job(test); await enqueueTeamNotification(test.store, original);
    let finish!: (value: { status: 'accepted'; receiptId: string }) => void;
    let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
    const fake = fakeProvider(() => { began(); return new Promise(resolve => { finish = resolve; }); });
    const first = runDueTeamNotifications(test.store, { provider: fake.provider, now: test.now, maximum: 1 }); await started;
    // A separate pinned PG connection/store proves a provider request does not retain an open domain transaction.
    if (test.store instanceof PostgresStore) await test.store.transaction(() => (test.store as PostgresStore).execute('UPDATE accounts SET status=status WHERE id=$1', ['synthetic-account-manager']));
    else test.store.transaction(() => (test.store as DevelopmentStore).database.prepare('UPDATE accounts SET status=status WHERE id=?').run('synthetic-account-manager'));
    expect(await runDueTeamNotifications(test.store, { provider: fake.provider, now: test.now, maximum: 1 })).toMatchObject({ accepted: 0, retried: 0 });
    finish({ status: 'accepted', receiptId: 'test-lease-receipt' }); expect(await first).toMatchObject({ accepted: 1 }); expect(fake.sent).toHaveLength(1);
  });
  it('marks an expired non-idempotent lease for review instead of blindly duplicating a possible accepted notification', async () => {
    const test = await setup(postgres), original = job(test); await enqueueTeamNotification(test.store, original);
    const leased = claimTeamNotificationJob(original, 'test-crashed-attempt', test.now())!;
    await test.execute("UPDATE jobs SET payload_json=$1,state='leased',attempts=$2,lease_until=$3 WHERE id=$4", [JSON.stringify(leased), leased.attempts, leased.lease!.untilMs, leased.id]);
    test.setTime(leased.lease!.untilMs);
    const fake = fakeProvider(); fake.provider.idempotency = 'none';
    expect(await runDueTeamNotifications(test.store, { provider: fake.provider, now: test.now })).toMatchObject({ reviewRequired: 1, accepted: 0 }); expect(fake.sent).toHaveLength(0);
    expect((await test.jobs())[0]).toMatchObject({ state: 'review_required', lastCode: 'LEASE_EXPIRED_OUTCOME_UNKNOWN', lease: null });
  });
  it('suppresses lower-role match notifications when the current publication policy withholds the entity', async () => {
    const test = await setup(postgres), fake = fakeProvider();
    await enqueueTeamNotification(test.store, job(test, { category: 'match', entityId: SYNTHETIC_IDS.matchId, accountId: 'synthetic-account-player-01', audience: 'player', playerId: 'synthetic-player-01' }));
    expect(await runDueTeamNotifications(test.store, { provider: fake.provider, now: test.now })).toMatchObject({ suppressed: 1, accepted: 0 }); expect(fake.sent).toHaveLength(0);
    expect((await test.jobs())[0].lastCode).toBe('ENTITY_POLICY_WITHHELD');
  });
}
describe('actual SQLite durable generic notification queue', () => scenarios(false));
describe.skipIf(!configuredUrl)('actual PostgreSQL durable generic notification queue (disposable database)', () => {
  beforeAll(() => { admin = new PgDatabase(configuredUrl!, { maximumConnections: 2, applicationName: 'longball-notification-test-admin' }); });
  afterAll(async () => { await admin.close(); });
  scenarios(true);
});
