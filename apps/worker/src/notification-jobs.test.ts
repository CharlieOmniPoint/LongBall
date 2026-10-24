import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defaultCommunityPreferences, type CommunityState } from '../../../packages/application/src/community';
import type { PreparationState } from '../../../packages/application/src/preparation';
import { claimTeamNotificationJob, nextTeamNotificationTime, type TeamNotificationJob, type TeamNotificationProvider } from '../../../packages/application/src/team-notifications';
import { PostgresStore } from '../../api/src/postgres-store';
import { PgDatabase } from '../../api/src/pg';
import { PgMediaService } from '../../api/src/postgres-media';
import { PostgresActivationService } from '../../api/src/postgres-activation';
import { applyRuntimeGrants } from '../../api/src/runtime-grants';
import { DevelopmentStore, SYNTHETIC_IDS } from '../../api/src/store';
import { createTeamNotificationJob, enqueueTeamNotification, runDueTeamNotifications } from './notification-jobs';

const configuredUrl = process.env.LONGBALL_POSTGRES_TEST_URL;
type Store = DevelopmentStore | PostgresStore;
interface Harness {
  store: Store; now: () => number; setTime: (value: number) => void;
  worker?: PostgresStore;
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
  let clock = Date.now();
  const now = postgres ? Date.now : () => clock;
  const directory = mkdtempSync(join(tmpdir(), 'longball-notification-jobs-'));
  const path = join(directory, 'notifications.sqlite');
  let url: string | undefined, database: string | undefined;
  if (postgres) {
    database = `longball_notifications_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE "${database}"`);
    const parsed = new URL(configuredUrl!); parsed.pathname = `/${database}`; url = parsed.href;
  }
  const open = async (): Promise<Store> => postgres ? PostgresStore.open(url!, now) : new DevelopmentStore(path, now);
  const test = { store: await open() } as Harness;
  cleanups.push(async () => { await test.store.close(); if (database) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`); rmSync(directory, { recursive: true, force: true }); });
  await test.store.seedSynthetic();
  test.now = now; test.setTime = value => { if (postgres) throw new Error('PostgreSQL dispatch tests use the actual database clock.'); clock = value; };
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
async function restrictedWorker(test: Harness): Promise<PostgresStore> {
  if (!(test.store instanceof PostgresStore)) throw new Error('An actual PostgreSQL fixture is required.');
  const owner = test.store, suffix = randomUUID().replaceAll('-', '');
  const roles = { apiRole: `lb_notify_api_${suffix}`, workerRole: `lb_notify_worker_${suffix}` };
  for (const name of Object.values(roles)) await admin.query(`CREATE ROLE "${name}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  const directory = mkdtempSync(join(tmpdir(), 'longball-notification-worker-'));
  let worker: PostgresStore | undefined;
  cleanups.unshift(async () => { await worker?.close(); });
  cleanups.push(async () => { for (const name of Object.values(roles)) await admin.query(`DROP ROLE "${name}"`); rmSync(directory, { recursive: true, force: true }); });
  await PgMediaService.open({ directory, database: owner.db });
  await new PostgresActivationService({ store: owner }).initialize();
  await applyRuntimeGrants(owner.db, roles);
  const url = new URL(configuredUrl!);
  url.pathname = `/${(await owner.one('SELECT current_database() AS name'))!.name}`;
  url.username = roles.workerRole; url.password = '';
  worker = await PostgresStore.open(url.href, test.now, { migrationMode: 'verify' });
  // Close restricted connections before dropping the disposable DB; role dependencies
  // disappear with that DB, then its temporary roles can be dropped safely.
  return worker;
}
async function runNotifications(test: Harness, options: Parameters<typeof runDueTeamNotifications>[1] = {}) {
  if (test.store instanceof PostgresStore) test.worker ??= await restrictedWorker(test);
  return runDueTeamNotifications(test.worker ?? test.store, options);
}
/** Controlled durable fixture transition; never forge a future worker clock. */
async function makePendingDue(test: Harness): Promise<void> {
  for (const pending of (await test.jobs()).filter(value => value.state === 'pending')) {
    const next = { ...pending, dueAtMs: Date.now() - 1000 };
    await test.execute('UPDATE jobs SET due_at=$1,payload_json=$2 WHERE id=$3', [next.dueAtMs, JSON.stringify(next), next.id]);
  }
}
function scenarios(postgres: boolean) {
  it('persists a single generic job, rejects conflicting reuse, and blocks without an installed provider', async () => {
    const test = await setup(postgres), original = job(test);
    expect(await enqueueTeamNotification(test.store, original)).toEqual({ duplicate: false, id: original.id });
    expect(await enqueueTeamNotification(test.store, { ...original, id: randomUUID() })).toEqual({ duplicate: true, id: original.id });
    await expect(enqueueTeamNotification(test.store, { ...original, id: randomUUID(), entityId: 'other-opaque-entity' })).rejects.toThrow('NOTIFICATION_KEY_CONFLICT');
    expect(await runNotifications(test, { now: test.now })).toMatchObject({ blocked: 1, accepted: 0 });
    await test.reopen();
    expect(await test.jobs()).toHaveLength(1);
    expect((await test.jobs())[0]).toMatchObject({ state: 'blocked_provider', lastCode: 'PUSH_PROVIDER_UNCONFIGURED', deliveryAttempts: 0, providerReceiptId: null });
    expect(await runNotifications(test, { now: test.now })).toMatchObject({ blocked: 0, accepted: 0 });
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
    expect(await runNotifications(test, { provider: fake.provider, now: test.now })).toMatchObject({ accepted: 0, suppressed: 3 });
    expect(fake.sent).toHaveLength(0);
    expect((await test.jobs()).map(value => value.lastCode)).toEqual(expect.arrayContaining(['NO_CURRENT_MEMBERSHIP', 'CHANNEL_DISABLED']));
  });
  it('defers through London quiet hours, then rechecks preferences (SQLite exercises the DST boundary)', async () => {
    const test = await setup(postgres), fake = fakeProvider();
    if (!postgres) test.setTime(Date.parse('2026-10-25T00:30:00Z'));
    const community = await test.community();
    const london = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(test.now()));
    const localMinute = Number(london.slice(0, 2)) * 60 + Number(london.slice(3));
    const hhmm = (value: number) => `${String(Math.floor((value + 1440) % 1440 / 60)).padStart(2, '0')}:${String((value + 1440) % 60).padStart(2, '0')}`;
    community.preferences['synthetic-account-manager'] = { ...defaultCommunityPreferences(), quietStart: postgres ? hhmm(localMinute - 1) : '01:00', quietEnd: postgres ? hhmm(localMinute + 30) : '02:00' }; await test.saveCommunity(community);
    await enqueueTeamNotification(test.store, job(test));
    expect(await runNotifications(test, { provider: fake.provider, now: test.now })).toMatchObject({ retried: 1, accepted: 0 });
    expect((await test.jobs())[0]).toMatchObject({ state: 'pending', dueAtMs: postgres ? nextTeamNotificationTime(community.preferences['synthetic-account-manager'], test.now()) : Date.parse('2026-10-25T02:00:00Z'), lastCode: 'QUIET_HOURS', deliveryAttempts: 0 });
    if (postgres) await makePendingDue(test); else test.setTime(Date.parse('2026-10-25T02:00:00Z'));
    community.preferences['synthetic-account-manager'].schedule = false; await test.saveCommunity(community);
    expect(await runNotifications(test, { provider: fake.provider, now: test.now })).toMatchObject({ suppressed: 1 }); expect(fake.sent).toHaveLength(0);
  });
  it('reopens a durable retry using the same provider key and sends only a generic payload', async () => {
    const test = await setup(postgres), original = job(test);
    const fake = fakeProvider(async () => { if (fake.sent.length === 1) throw new Error('test double lost acknowledgement containing private upstream details'); return { status: 'accepted', receiptId: 'test-second-receipt' }; });
    await enqueueTeamNotification(test.store, original);
    expect(await runNotifications(test, { provider: fake.provider, now: test.now })).toMatchObject({ retried: 1, accepted: 0 });
    await test.reopen(); if (postgres) await makePendingDue(test); else test.setTime(test.now() + 30_000);
    expect(await runNotifications(test, { provider: fake.provider, now: test.now })).toMatchObject({ accepted: 1 });
    expect(fake.sent.map(item => item.idempotencyKey)).toEqual([original.businessKey, original.businessKey]);
    expect(fake.sent[1].payload).toEqual({ body: 'Your team has an update', data: { entityId: test.fixtureId } });
    expect((await test.jobs())[0]).toMatchObject({ state: 'provider_accepted', deliveryAttempts: 2, providerReceiptId: 'test-second-receipt' });
    expect(JSON.stringify(await test.jobs())).not.toContain('upstream details');
    expect(await runNotifications(test, { provider: fake.provider, now: test.now })).toMatchObject({ accepted: 0 });
  });
  it('leases once across concurrent workers and releases database transactions while a provider is pending', async () => {
    const test = await setup(postgres), original = job(test); await enqueueTeamNotification(test.store, original);
    let finish!: (value: { status: 'accepted'; receiptId: string }) => void;
    let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
    const fake = fakeProvider(() => { began(); return new Promise(resolve => { finish = resolve; }); });
    const first = runNotifications(test, { provider: fake.provider, now: test.now, maximum: 1 }); await started;
    // A separate pinned PG connection/store proves a provider request does not retain an open domain transaction.
    if (test.store instanceof PostgresStore) await test.store.transaction(() => (test.store as PostgresStore).execute('UPDATE accounts SET status=status WHERE id=$1', ['synthetic-account-manager']));
    else test.store.transaction(() => (test.store as DevelopmentStore).database.prepare('UPDATE accounts SET status=status WHERE id=?').run('synthetic-account-manager'));
    expect(await runNotifications(test, { provider: fake.provider, now: test.now, maximum: 1 })).toMatchObject({ accepted: 0, retried: 0 });
    finish({ status: 'accepted', receiptId: 'test-lease-receipt' }); expect(await first).toMatchObject({ accepted: 1 }); expect(fake.sent).toHaveLength(1);
  });
  it('marks an expired non-idempotent lease for review instead of blindly duplicating a possible accepted notification', async () => {
    const test = await setup(postgres), original = job(test); await enqueueTeamNotification(test.store, original);
    const claimed = claimTeamNotificationJob(original, 'test-crashed-attempt', test.now())!;
    const leased = postgres ? { ...claimed, lease: { ...claimed.lease!, untilMs: Date.now() - 1 } } : claimed;
    await test.execute("UPDATE jobs SET payload_json=$1,state='leased',attempts=$2,lease_until=$3 WHERE id=$4", [JSON.stringify(leased), leased.attempts, leased.lease!.untilMs, leased.id]);
    if (!postgres) test.setTime(leased.lease!.untilMs);
    const fake = fakeProvider(); fake.provider.idempotency = 'none';
    expect(await runNotifications(test, { provider: fake.provider, now: test.now })).toMatchObject({ reviewRequired: 1, accepted: 0 }); expect(fake.sent).toHaveLength(0);
    expect((await test.jobs())[0]).toMatchObject({ state: 'review_required', lastCode: 'LEASE_EXPIRED_OUTCOME_UNKNOWN', lease: null });
  });
  it('suppresses lower-role match notifications when the current publication policy withholds the entity', async () => {
    const test = await setup(postgres), fake = fakeProvider();
    await enqueueTeamNotification(test.store, job(test, { category: 'match', entityId: SYNTHETIC_IDS.matchId, accountId: 'synthetic-account-player-01', audience: 'player', playerId: 'synthetic-player-01' }));
    expect(await runNotifications(test, { provider: fake.provider, now: test.now })).toMatchObject({ suppressed: 1, accepted: 0 }); expect(fake.sent).toHaveLength(0);
    expect((await test.jobs())[0].lastCode).toBe('ENTITY_POLICY_WITHHELD');
  });
}
describe('actual SQLite durable generic notification queue', () => scenarios(false));
describe.skipIf(!configuredUrl)('actual PostgreSQL durable generic notification queue (disposable database)', () => {
  beforeAll(() => { admin = new PgDatabase(configuredUrl!, { maximumConnections: 2, applicationName: 'longball-notification-test-admin' }); });
  afterAll(async () => { await admin.close(); });
  scenarios(true);
  it('uses database time for dispatch evidence and receipts despite a tolerated future clock observation', async () => {
    const test = await setup(true), original = job(test);
    await enqueueTeamNotification(test.store, original);
    const worker = await restrictedWorker(test), fake = fakeProvider();
    await test.execute("UPDATE memberships SET expires_at=$1 WHERE account_id=$2 AND role='manager'", [Date.now() + 15_000, original.accountId]);
    const before = Date.now();
    expect(await runDueTeamNotifications(worker, { provider: fake.provider, now: () => Date.now() + 25_000, maximum: 1 })).toMatchObject({ accepted: 1, suppressed: 0 });
    expect(fake.sent).toHaveLength(1);
    const saved = (await test.jobs())[0];
    expect(saved.acceptedAtMs).toBeGreaterThanOrEqual(before - 1000);
    expect(saved.acceptedAtMs).toBeLessThanOrEqual(Date.now() + 1000);
  });
  it('rechecks database time after claim latency before evaluating a recipient expiry', async () => {
    const test = await setup(true), original = job(test);
    await enqueueTeamNotification(test.store, original);
    const worker = await restrictedWorker(test), fake = fakeProvider(), execute = worker.execute.bind(worker);
    let delayed = false;
    worker.execute = async (sql, values = []) => {
      const result = await execute(sql, values);
      if (!delayed && sql.startsWith('UPDATE jobs SET payload_json=')) {
        const retained = JSON.parse(String(values[0])) as TeamNotificationJob;
        if (retained.state === 'leased') {
          delayed = true;
          const expiresAt = retained.lease!.untilMs - 30_000 + 5;
          await test.execute("UPDATE memberships SET expires_at=$1 WHERE account_id=$2 AND role='manager'", [expiresAt, original.accountId]);
          // Explicit repository-latency fixture; no future dispatch observation.
          await (test.store as PostgresStore).one('SELECT pg_sleep(0.02)');
        }
      }
      return result;
    };
    expect(await runDueTeamNotifications(worker, { provider: fake.provider, now: Date.now, maximum: 1 })).toMatchObject({ accepted: 0, suppressed: 1 });
    expect(delayed).toBe(true); expect(fake.sent).toHaveLength(0);
    expect((await test.jobs())[0].lastCode).toBe('NO_CURRENT_MEMBERSHIP');
  });
  it('does not report a durable provider receipt when RLS expires the lease between locked read and outcome update', async () => {
    const test = await setup(true), original = job(test);
    await enqueueTeamNotification(test.store, original);
    const worker = await restrictedWorker(test), fake = fakeProvider(), execute = worker.execute.bind(worker);
    let expired = false, outcomeChanges: number | null = null;
    worker.execute = async (sql, values = []) => {
      if (!expired && sql.startsWith('UPDATE jobs SET payload_json=') && sql.includes('lease_until=NULL')) {
        expired = true;
        // Expire the capability in the same pinned transaction after owns() has
        // locked/read it; an independent writer would correctly wait on that lock.
        await execute('UPDATE jobs SET lease_until=floor(extract(epoch FROM clock_timestamp())*1000)::bigint+5 WHERE id=$1', [original.id]);
        await worker.one('SELECT pg_sleep(0.02)');
        const result = await execute(sql, values); outcomeChanges = result.changes; return result;
      }
      return execute(sql, values);
    };
    expect(await runDueTeamNotifications(worker, { provider: fake.provider, now: Date.now, maximum: 1 })).toMatchObject({ accepted: 0, failed: 0 });
    expect(expired).toBe(true); expect(outcomeChanges).toBe(0); expect(fake.sent).toHaveLength(1);
    expect((await test.jobs())[0]).toMatchObject({ state: 'leased', providerReceiptId: null, acceptedAtMs: null });
  });
  it('dispatches with a restricted non-bypass worker, fresh recipient evidence and no ambient provider authority', async () => {
    const test = await setup(true), original = job(test);
    await enqueueTeamNotification(test.store, original);
    const worker = await restrictedWorker(test);
    expect(await worker.one('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).toMatchObject({ rolsuper: false, rolbypassrls: false });
    expect(await worker.many('SELECT id FROM jobs')).toEqual([]);
    expect(await worker.many('SELECT id FROM accounts')).toEqual([]);
    // The database worker credential cannot manufacture API authority by changing
    // the application-context GUC, even when a real account's public IDs are known.
    const identity = { issuer: 'urn:longball:synthetic', subject: original.accountId, nowMs: test.now() };
    await worker.db.withContext({ kind: 'identity', ...identity }, async () => {
      expect(await worker.many('SELECT id FROM accounts')).toEqual([]);
    });
    await worker.db.withContext({ kind: 'actor', ...identity, accountId: original.accountId, strongAuth: true, authenticatedAtMs: test.now(), requestedRole: 'manager', operation: 'records.export', clubId: 'synthetic-richmond-rovers', teamId: original.teamId, seasonId: original.seasonId }, async () => {
      expect(await worker.many('SELECT id FROM accounts')).toEqual([]);
      expect(await worker.many('SELECT kind FROM documents')).toEqual([]);
      expect(await worker.many('SELECT id FROM matches')).toEqual([]);
    });
    const fake = fakeProvider(async () => {
      expect(worker.db.applicationContext).toBeUndefined();
      expect(await worker.many('SELECT id FROM jobs')).toEqual([]);
      // No SQL transaction is held across the external provider request.
      await test.execute('UPDATE accounts SET status=status WHERE id=$1', [original.accountId]);
      return { status: 'accepted', receiptId: 'test-restricted-worker-receipt' };
    });
    expect(await runDueTeamNotifications(worker, { provider: fake.provider, now: test.now })).toMatchObject({ accepted: 1, reviewRequired: 0 });
    expect(fake.sent).toHaveLength(1);
    const revoked = job(test); await enqueueTeamNotification(test.store, revoked);
    await test.execute("UPDATE memberships SET revoked_at=$1 WHERE account_id=$2 AND role='manager'", [test.now(), original.accountId]);
    expect(await runDueTeamNotifications(worker, { provider: fake.provider, now: test.now })).toMatchObject({ suppressed: 1, accepted: 0 });
    expect(fake.sent).toHaveLength(1);
  });
  it('binds a protected claim to one job, recipient and ancestry and rejects wrong or actually expired capabilities', async () => {
    const test = await setup(true), first = job(test), second = job(test, { accountId: 'synthetic-account-player-01', audience: 'player', playerId: 'synthetic-player-01' });
    await enqueueTeamNotification(test.store, first); await enqueueTeamNotification(test.store, second);
    const worker = await restrictedWorker(test), capability = randomBytes(32).toString('hex');
    await expect(worker.one('SELECT * FROM longball.claim_due_job($1,$2,$3)', ['notification.dispatch', test.now(), capability])).rejects.toMatchObject({ code: '42501' });
    const observedAt = test.now();
    const row = await worker.db.withContext({ kind: 'worker_claim', jobKind: 'notification.dispatch', nowMs: observedAt }, async () => {
      expect(await worker.many('SELECT id FROM accounts')).toEqual([]);
      expect(await worker.many('SELECT id FROM jobs')).toEqual([]);
      return worker.one('SELECT * FROM longball.claim_due_job($1,$2,$3)', ['notification.dispatch', observedAt, capability]);
    });
    expect(row).toBeDefined();
    const original = JSON.parse(String(row!.payload_json)) as TeamNotificationJob;
    // SQL leaves the original dispatch payload/attempt count untouched.
    expect(original).toMatchObject({ state: 'pending', attempts: 0, revision: 0 });
    const context = { kind: 'worker_job' as const, jobId: String(row!.id), leaseToken: capability, clubId: String(row!.club_id), teamId: String(row!.team_id), seasonId: String(row!.season_id), nowMs: test.now() };
    await worker.db.withContext(context, async () => {
      expect(await worker.many('SELECT id FROM jobs')).toEqual([{ id: original.id }]);
      expect(await worker.many('SELECT id FROM accounts')).toEqual([{ id: original.accountId }]);
      // A scheduling job does not carry authority to read even another match in its season.
      expect(await worker.many('SELECT id FROM matches')).toEqual([]);
      expect((await worker.many('SELECT account_id FROM memberships')).every(item => item.account_id === original.accountId)).toBe(true);
      expect((await worker.many('SELECT team_id,season_id FROM documents')).every(item => item.team_id === original.teamId && item.season_id === original.seasonId)).toBe(true);
      await expect(worker.execute("UPDATE jobs SET payload_json=jsonb_set(payload_json,'{category}','\"match\"') WHERE id=$1", [original.id])).rejects.toMatchObject({ code: '23514' });
      await expect(worker.execute('UPDATE jobs SET lease_token_hash=$1 WHERE id=$2', [randomBytes(32).toString('hex'), original.id])).rejects.toMatchObject({ code: '23514' });
      await expect(worker.execute('UPDATE jobs SET lease_until=lease_until+1 WHERE id=$1', [original.id])).rejects.toMatchObject({ code: '23514' });
      expect(await worker.one('SELECT lease_until FROM jobs WHERE id=$1', [original.id])).toEqual({ lease_until: row!.lease_until });
    });
    for (const invalid of [{ ...context, leaseToken: randomBytes(32).toString('hex') }, { ...context, jobId: original.id === first.id ? second.id : first.id }, { ...context, teamId: 'fictional-other-team' }, { ...context, seasonId: 'fictional-other-season' }]) {
      await worker.db.withContext(invalid, async () => { expect(await worker.many('SELECT id FROM jobs')).toEqual([]); expect(await worker.many('SELECT id FROM accounts')).toEqual([]); expect(await worker.many('SELECT team_id FROM documents')).toEqual([]); });
    }
    // A stale supplied time cannot prolong a capability past the actual database clock.
    await test.execute('UPDATE jobs SET lease_until=$1 WHERE id=$2', [Date.now() - 1, original.id]);
    await worker.db.withContext({ ...context, nowMs: 1 }, async () => {
      expect(await worker.many('SELECT id FROM jobs')).toEqual([]);
      expect(await worker.many('SELECT id FROM accounts')).toEqual([]);
      expect((await worker.execute("UPDATE jobs SET last_error_code='TEST_STALE_CAPABILITY' WHERE id=$1", [original.id])).changes).toBe(0);
    });
    expect((await test.jobs()).find(value => value.id === original.id)?.lastCode).toBeNull();
  });
});
