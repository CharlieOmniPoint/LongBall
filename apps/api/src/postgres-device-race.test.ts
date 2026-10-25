import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MatchConfig } from '../../../packages/domain/src/index';
import { PgDatabase } from './pg';
import { PostgresStore, SYNTHETIC_IDS } from './postgres-store';
import { PgMediaService } from './postgres-media';
import { PostgresActivationService } from './postgres-activation';
import { createPostgresApi } from './postgres-server';
import { applyRuntimeGrants } from './runtime-grants';
import { EVENT_CONTRACT_VERSION } from './store';

const configured = process.env.LONGBALL_POSTGRES_TEST_URL;
describe.skipIf(!configured)('global device ownership across independent PostgreSQL API instances', () => {
  let admin: Pool, owner: PgDatabase, seed: PostgresStore, directory: string, database: string;
  let roles: { owner: string; apiRole: string; workerRole: string };
  const instances: Awaited<ReturnType<typeof createPostgresApi>>[] = [];
  const bases: string[] = [];
  let configuration: MatchConfig;
  const manager = 'synthetic-account-manager', other = 'synthetic-account-other-manager';
  beforeAll(async () => {
    admin = new Pool({ connectionString: configured, max: 2 });
    const suffix = randomUUID().replaceAll('-', ''); database = `lb_device_race_${suffix}`;
    roles = { owner: `lb_device_owner_${suffix}`, apiRole: `lb_device_api_${suffix}`, workerRole: `lb_device_worker_${suffix}` };
    for (const role of Object.values(roles)) await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`);
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(configured!); url.pathname = `/${database}`;
    const bootstrap = new Pool({ connectionString: url.href });
    try { await bootstrap.query(`CREATE SCHEMA longball AUTHORIZATION "${roles.owner}"`); await bootstrap.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC'); } finally { await bootstrap.end(); }
    const ownerUrl = new URL(url); ownerUrl.username = roles.owner; ownerUrl.password = '';
    owner = new PgDatabase(ownerUrl.href); await owner.migrate(); seed = new PostgresStore(owner); await seed.seedSynthetic();
    directory = await mkdtemp(join(tmpdir(), 'longball-device-race-'));
    await PgMediaService.open({ directory, database: owner }); await new PostgresActivationService({ store: seed }).initialize();
    await applyRuntimeGrants(owner, roles);
    configuration = JSON.parse(String((await seed.one('SELECT config_json FROM matches WHERE id=$1', [SYNTHETIC_IDS.matchId]))!.config_json)) as MatchConfig;
    const apiUrl = new URL(url); apiUrl.username = roles.apiRole; apiUrl.password = '';
    for (let index = 0; index < 2; index++) {
      const instance = await createPostgresApi({ connectionString: apiUrl.href, databasePath: join(directory, 'unused.sqlite'), mediaDirectory: directory, migrationMode: 'verify', seedSynthetic: false, syntheticAuth: true });
      instances.push(instance);
      await new Promise<void>(resolve => instance.server.listen(0, '127.0.0.1', resolve));
      bases.push(`http://127.0.0.1:${(instance.server.address() as AddressInfo).port}`);
    }
  });
  afterAll(async () => {
    for (const instance of instances) { instance.server.closeAllConnections(); await instance.close(); }
    await owner?.close();
    if (database) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    for (const role of Object.values(roles ?? {})) await admin.query(`DROP ROLE "${role}"`);
    await admin?.end(); if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function matches(): Promise<[string, string]> {
    const ids: [string, string] = [`device-a-${randomUUID()}`, `device-b-${randomUUID()}`];
    for (const [index, teamId] of [SYNTHETIC_IDS.teamId, 'synthetic-other-team'].entries()) {
      await seed.insertMatch({ ...configuration, matchId: ids[index], ...(configuration.fixture ? { fixture: { ...configuration.fixture, teamId } } : {}) }, teamId, SYNTHETIC_IDS.seasonId);
    }
    return ids;
  }
  async function acquire(index: number, matchId: string, deviceId: string, accountId: string) {
    const response = await fetch(`${bases[index]}/v1/matches/${matchId}/controller`, { method: 'POST', headers: {
      Authorization: `Bearer ${accountId}`, 'Content-Type': 'application/json', 'X-Api-Contract-Version': EVENT_CONTRACT_VERSION,
      'X-Longball-Role': 'manager', 'Idempotency-Key': randomUUID(),
    }, body: JSON.stringify({ deviceId }), signal: AbortSignal.timeout(15_000) });
    const body = await response.json() as { code?: string };
    return { status: response.status, code: body.code };
  }
  it('races an initially absent global device key and grants control only to its committed owner', async () => {
    const ids = await matches(), deviceId = `raced-device-${randomUUID()}`;
    let arrived = 0, release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const spies = instances.map(instance => {
      const read = instance.store.one.bind(instance.store);
      return vi.spyOn(instance.store, 'one').mockImplementation(async (sql, values = []) => {
        const row = await read(sql, values);
        if (sql === 'SELECT account_id FROM devices WHERE id=$1' && values[0] === deviceId) {
          expect(row).toBeUndefined(); if (++arrived === 2) release();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try { await Promise.race([barrier, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Independent team transactions did not reach the device race barrier.')), 5_000); })]); }
          finally { clearTimeout(timer); }
        }
        return row;
      });
    });
    try {
      const responses = await Promise.all([acquire(0, ids[0], deviceId, manager), acquire(1, ids[1], deviceId, other)]);
      expect(arrived).toBe(2); expect(responses.map(item => item.status).sort()).toEqual([200, 409]);
      const winner = responses.findIndex(item => item.status === 200), loser = winner === 0 ? 1 : 0;
      expect(responses[loser].code).toBe('DEVICE_ACCOUNT_CONFLICT');
      const accountId = winner === 0 ? manager : other;
      expect((await owner.query('SELECT account_id FROM devices WHERE id=$1', [deviceId])).rows).toEqual([{ account_id: accountId }]);
      expect((await owner.query('SELECT match_id,account_id,device_id FROM controller_grants WHERE match_id=ANY($1::text[])', [ids])).rows).toEqual([{ match_id: ids[winner], account_id: accountId, device_id: deviceId }]);
      expect((await owner.query('SELECT key FROM idempotency WHERE team_id=$1 AND operation=$2', [loser === 0 ? SYNTHETIC_IDS.teamId : 'synthetic-other-team', `/v1/matches/${ids[loser]}/controller`])).rows).toEqual([]);
    } finally { release(); for (const spy of spies) spy.mockRestore(); }
  });
  it('refuses a pre-existing device hidden by cross-team RLS without issuing a wrong-account grant', async () => {
    const ids = await matches(), deviceId = `hidden-device-${randomUUID()}`;
    await owner.query('INSERT INTO devices(id,account_id) VALUES($1,$2)', [deviceId, manager]);
    const identity = { issuer: 'urn:longball:synthetic', subject: other, strongAuth: true, authenticatedAt: Date.now() };
    const principal = await instances[1].store.withIdentityContext(identity, () => instances[1].store.principal(identity));
    await instances[1].store.withActorContext(principal, { operation: 'match.manage', requestedRole: 'manager', matchId: ids[1] }, async () => {
      expect(await instances[1].store.one('SELECT account_id FROM devices WHERE id=$1', [deviceId])).toBeUndefined();
    });
    expect(await acquire(1, ids[1], deviceId, other)).toEqual({ status: 409, code: 'DEVICE_ACCOUNT_CONFLICT' });
    expect((await owner.query('SELECT account_id FROM devices WHERE id=$1', [deviceId])).rows).toEqual([{ account_id: manager }]);
    expect((await owner.query('SELECT match_id FROM controller_grants WHERE match_id=$1', [ids[1]])).rows).toEqual([]);
  });
  it('allows the same account to reuse its committed device on another authorised team', async () => {
    const ids = await matches(), deviceId = `own-device-${randomUUID()}`;
    await owner.query("INSERT INTO memberships(account_id,team_id,season_id,role) VALUES($1,'synthetic-other-team',$2,'manager')", [manager, SYNTHETIC_IDS.seasonId]);
    try {
      expect((await acquire(0, ids[0], deviceId, manager)).status).toBe(200);
      expect((await acquire(1, ids[1], deviceId, manager)).status).toBe(200);
      expect((await owner.query('SELECT account_id FROM devices WHERE id=$1', [deviceId])).rows).toEqual([{ account_id: manager }]);
      expect((await owner.query('SELECT count(*)::integer AS count FROM controller_grants WHERE match_id=ANY($1::text[]) AND account_id=$2 AND device_id=$3', [ids, manager, deviceId])).rows).toEqual([{ count: 2 }]);
    } finally { await owner.query("DELETE FROM memberships WHERE account_id=$1 AND team_id='synthetic-other-team' AND season_id=$2 AND role='manager'", [manager, SYNTHETIC_IDS.seasonId]); }
  });
});
