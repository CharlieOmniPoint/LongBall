import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PgDatabase } from './pg';
import { PostgresStore } from './postgres-store';
import { PostgresActivationService } from './postgres-activation';
import { PgMediaService } from './postgres-media';
import { applyRuntimeGrants } from './runtime-grants';

const configured = process.env.LONGBALL_POSTGRES_TEST_URL;
const pending = 'pending_verification_and_policy';
const account = 'fictional-"quoted-\\-é';
const exportKey = JSON.stringify([account, 'export', 'all_memberships']);
let admin: Pool;
const pools: PgDatabase[] = [];
const fixtures: { database: string; roles: string[]; directory: string }[] = [];

describe.skipIf(!configured)('real PostgreSQL privacy expansion and runtime grants', () => {
  beforeAll(() => { admin = new Pool({ connectionString: configured, max: 2 }); });
  afterEach(async () => {
    for (const database of pools.splice(0)) await database.close();
    for (const fixture of fixtures.splice(0)) {
      await admin.query(`DROP DATABASE "${fixture.database}" WITH (FORCE)`);
      for (const role of fixture.roles) await admin.query(`DROP ROLE "${role}"`);
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
  afterAll(async () => { await admin.end(); });

  async function previousSchema() {
    const suffix = randomUUID().replaceAll('-', '');
    const database = `longball_privacy_${suffix}`;
    const roles = { owner: `lb_priv_owner_${suffix}`, api: `lb_priv_api_${suffix}`, worker: `lb_priv_worker_${suffix}` };
    const directory = await mkdtemp(join(tmpdir(), 'longball-privacy-pg-'));
    for (const role of Object.values(roles)) await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query(`CREATE DATABASE "${database}"`);
    fixtures.push({ database, roles: Object.values(roles), directory });
    const target = new URL(configured!); target.pathname = `/${database}`;
    const bootstrap = new Pool({ connectionString: target.href });
    try {
      await bootstrap.query(`REVOKE ALL ON DATABASE "${database}" FROM PUBLIC`);
      await bootstrap.query(`GRANT CONNECT ON DATABASE "${database}" TO ${Object.values(roles).map(role => `"${role}"`).join(',')}`);
      await bootstrap.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await bootstrap.query(`CREATE SCHEMA longball AUTHORIZATION "${roles.owner}"`);
    } finally { await bootstrap.end(); }
    const connect = (role: string, migrationMode: 'apply' | 'verify' = 'verify') => {
      const url = new URL(target); url.username = role; url.password = '';
      const database = new PgDatabase(url.href, { migrationMode }); pools.push(database); return database;
    };
    const owner = connect(roles.owner, 'apply');
    await owner.transaction(async () => {
      await owner.query('CREATE TABLE longball.schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
      for (const name of ['002_runtime.sql', '003_clock_review.sql']) await owner.query(await readFile(new URL(`../migrations/postgresql/${name}`, import.meta.url), 'utf8'));
      await owner.query('INSERT INTO longball.schema_migrations(version) VALUES(2),(3)');
      await owner.query("INSERT INTO accounts(id,issuer,subject,classification) VALUES($1,'urn:fictional','fixture','adult_individual')", [account]);
      await owner.query("INSERT INTO teams(id,name) VALUES('fictional-roma','Fictional Roma U10')");
      await owner.query("INSERT INTO documents(team_id,season_id,kind,revision,value_json) VALUES('fictional-roma','fictional-2026','preparation',0,$1)", [JSON.stringify({ club: { id: 'fictional-club', name: 'Fictional club' }, seasons: [{ id: 'fictional-2026', label: '2026/27', startYear: 2026, startDate: '2026-09-01', endDate: '2027-08-31' }] })]);
      await owner.query("INSERT INTO memberships(account_id,team_id,season_id,role) VALUES($1,'fictional-roma','fictional-2026','player')", [account]);
      for (const [id, kind, status, created] of [
        ['export-a', 'export', pending, 100], ['export-b', 'export', pending, 100],
        ['export-history', 'export', 'legacy_status_retained', 1], ['delete-a', 'delete_account', pending, 200],
        ['leave-pending', 'leave_team', pending, 200], ['leave-history', 'leave_team', 'cancelled', 1],
      ] as const) await owner.query('INSERT INTO privacy_requests(id,account_id,kind,status,policy_version,created_at) VALUES($1,$2,$3,$4,$5,$6)', [id, account, kind, status, 'fictional-original-policy', created]);
    });
    return { owner, connect, roles, directory };
  }

  it('preserves duplicate legacy rows and unknown snapshots, chooses one exact canonical key and requires current migration', async () => {
    const fixture = await previousSchema();
    const reader = fixture.connect(fixture.roles.owner);
    await expect(reader.migrate()).rejects.toThrow('migrations are required');
    await fixture.owner.migrate();
    await reader.migrate();
    const rows = (await fixture.owner.query('SELECT id,status,policy_version,affected_memberships_json,team_id,season_id FROM privacy_requests ORDER BY id')).rows;
    expect(rows).toHaveLength(6);
    expect(rows.find(row => row.id === 'leave-pending')).toMatchObject({ status: 'needs_scope', team_id: null, season_id: null });
    expect(rows.find(row => row.id === 'leave-history')?.status).toBe('cancelled');
    expect(rows.filter(row => row.id.startsWith('export-')).map(row => row.status)).toEqual([pending, pending, 'legacy_status_retained']);
    expect(rows.every(row => row.affected_memberships_json === null && row.policy_version === 'fictional-original-policy')).toBe(true);
    expect((await fixture.owner.query('SELECT request_id FROM privacy_pending_keys WHERE business_key=$1', [exportKey])).rows).toEqual([{ request_id: 'export-a' }]);
    expect((await fixture.owner.query('SELECT COUNT(*)::integer AS count FROM privacy_pending_keys')).rows).toEqual([{ count: 2 }]);
    await fixture.owner.query("INSERT INTO documents(team_id,season_id,kind,revision,value_json) VALUES('fictional-roma','fictional-2026','staff',0,'{\"revision\":0}')");
    await expect(fixture.owner.query("INSERT INTO documents(team_id,season_id,kind,revision,value_json) VALUES('fictional-roma','fictional-2026','unknown',0,'{}')")).rejects.toMatchObject({ code: '23514' });
    await fixture.owner.migrate();
    expect((await fixture.owner.query('SELECT version FROM schema_migrations ORDER BY version')).rows).toEqual([{ version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }]);
    await fixture.owner.query('INSERT INTO schema_migrations(version) VALUES(99)');
    await expect(reader.migrate()).rejects.toThrow('newer than the application');
    expect((await fixture.owner.query('SELECT version FROM schema_migrations WHERE version=99')).rowCount).toBe(1);
  });

  it('rolls back columns, legacy status changes, mapping and version together when an expansion fails', async () => {
    const fixture = await previousSchema();
    await fixture.owner.query('ALTER TABLE documents RENAME CONSTRAINT documents_kind_check TO unexpected_fixture_constraint');
    await expect(fixture.owner.migrate()).rejects.toMatchObject({ code: '42704' });
    expect((await fixture.owner.query("SELECT column_name FROM information_schema.columns WHERE table_schema='longball' AND table_name='privacy_requests' AND column_name='team_id'")).rows).toEqual([]);
    expect((await fixture.owner.query("SELECT to_regclass('longball.privacy_pending_keys') AS table_name")).rows).toEqual([{ table_name: null }]);
    expect((await fixture.owner.query("SELECT status FROM privacy_requests WHERE id='leave-pending'")).rows).toEqual([{ status: pending }]);
    expect((await fixture.owner.query('SELECT version FROM schema_migrations ORDER BY version')).rows).toEqual([{ version: 2 }, { version: 3 }]);
    await fixture.owner.query('ALTER TABLE documents RENAME CONSTRAINT unexpected_fixture_constraint TO documents_kind_check');
    await fixture.owner.migrate();
    expect((await fixture.owner.query("SELECT status FROM privacy_requests WHERE id='leave-pending'")).rows).toEqual([{ status: 'needs_scope' }]);
  });

  it('permits scoped request/mapping writes for the API while denying worker privacy access and runtime DDL', async () => {
    const fixture = await previousSchema(); await fixture.owner.migrate();
    const store = new PostgresStore(fixture.owner);
    await PgMediaService.open({ directory: fixture.directory, database: fixture.owner });
    await new PostgresActivationService({ store }).initialize();
    await applyRuntimeGrants(fixture.owner, { apiRole: fixture.roles.api, workerRole: fixture.roles.worker });
    const api = fixture.connect(fixture.roles.api), worker = fixture.connect(fixture.roles.worker);
    await api.migrate(); await worker.migrate();
    const key = JSON.stringify([account, 'leave_team', 'team_season', 'fictional-roma', 'fictional-2026']);
    const context = { kind: 'actor' as const, accountId: account, issuer: 'urn:fictional', subject: 'fixture', strongAuth: false, authenticatedAtMs: Date.now(), nowMs: Date.now(), operation: 'privacy.request' };
    await api.withContext(context, () => api.transaction(async () => {
      await api.query('INSERT INTO privacy_requests(id,account_id,kind,status,created_at,team_id,season_id,affected_memberships_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', ['new-scoped', account, 'leave_team', pending, 500, 'fictional-roma', 'fictional-2026', '[]']);
      await api.query('INSERT INTO privacy_pending_keys(business_key,request_id) VALUES($1,$2)', [key, 'new-scoped']);
    }));
    expect((await api.withContext(context, () => api.query('SELECT team_id,season_id,affected_memberships_json FROM privacy_requests WHERE id=$1', ['new-scoped']))).rows).toEqual([{ team_id: 'fictional-roma', season_id: 'fictional-2026', affected_memberships_json: '[]' }]);
    await expect(api.withContext(context, () => api.query('INSERT INTO privacy_pending_keys(business_key,request_id) VALUES($1,$2)', [key, 'export-b']))).rejects.toMatchObject({ code: '23505' });
    await expect(worker.query('SELECT id FROM privacy_requests')).rejects.toMatchObject({ code: '42501' });
    await expect(worker.query('SELECT request_id FROM privacy_pending_keys')).rejects.toMatchObject({ code: '42501' });
    await expect(api.query('DELETE FROM privacy_requests WHERE false')).rejects.toMatchObject({ code: '42501' });
    await expect(api.query('UPDATE schema_migrations SET version=version')).rejects.toMatchObject({ code: '42501' });
    await expect(api.query('CREATE TABLE longball.forbidden_fixture_table(id text)')).rejects.toMatchObject({ code: '42501' });
  });
});
