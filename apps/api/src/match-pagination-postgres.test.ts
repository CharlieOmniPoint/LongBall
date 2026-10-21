import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresStore } from './postgres-store';
import { PgMediaService } from './postgres-media';
import { PostgresActivationService } from './postgres-activation';
import { createPostgresApi } from './postgres-server';
import { applyRuntimeGrants } from './runtime-grants';
import { SYNTHETIC_IDS } from './store';
import type { MatchConfig } from '../../../packages/domain/src/index';

const configuredUrl = process.env.LONGBALL_POSTGRES_TEST_URL;
describe.skipIf(!configuredUrl)('API04/DS13 restricted PostgreSQL match continuation', () => {
  it('pages108 matches through real non-bypass HTTP roles and keeps child payloads and cursors scoped', async () => {
    const admin = new Pool({ connectionString: configuredUrl, max: 2 }), suffix = randomUUID().replaceAll('-', '');
    const database = `lb_page_${suffix}`, directory = mkdtempSync(join(tmpdir(), 'longball-match-pages-'));
    const roles = { apiRole: `lb_page_api_${suffix}`, workerRole: `lb_page_worker_${suffix}` };
    let owner: PostgresStore | undefined, media: PgMediaService | undefined, api: Awaited<ReturnType<typeof createPostgresApi>> | undefined;
    try {
      await admin.query(`CREATE DATABASE "${database}"`);
      for (const role of Object.values(roles)) await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      const ownerUrl = new URL(configuredUrl!); ownerUrl.pathname = `/${database}`;
      owner = await PostgresStore.open(ownerUrl.href); await owner.seedSynthetic();
      media = await PgMediaService.open({ directory: join(directory, 'media'), database: owner.db }); await new PostgresActivationService({ store: owner }).initialize();
      const config = JSON.parse((await owner.match(SYNTHETIC_IDS.matchId)).config_json) as MatchConfig;
      const expected: string[] = [SYNTHETIC_IDS.matchId];
      await owner.transaction(async () => { for (let i = 0; i < 107; i++) { const matchId = `page-match-${String(i).padStart(3, '0')}${i === 24 ? '.round:one@v2' : ''}`; expected.push(matchId); await owner!.insertMatch({ ...config, matchId }, SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId); } });
      await applyRuntimeGrants(owner.db, roles);
      const apiUrl = new URL(ownerUrl); apiUrl.username = roles.apiRole; apiUrl.password = '';
      api = await createPostgresApi({ connectionString: apiUrl.href, databasePath: join(directory, 'unused.sqlite'), mediaDirectory: join(directory, 'media'), migrationMode: 'verify', syntheticAuth: true, seedSynthetic: false });
      await new Promise<void>(resolve => api!.server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`, route = `/v1/teams/${SYNTHETIC_IDS.teamId}/matches?seasonId=${SYNTHETIC_IDS.seasonId}`;
      const call = async (suffix = '', token = 'synthetic-manager-2', role = 'manager') => { const response = await fetch(base + route + suffix, { headers: { Authorization: `Bearer ${token}`, 'X-Longball-Role': role } }); return { status: response.status, body: await response.json() as { items: { matchId: string; audience: string; state?: unknown; score?: unknown }[]; nextCursor: string | null } }; };
      const first = await call(); expect(first.status).toBe(200); expect(first.body.items).toHaveLength(25);
      const found = first.body.items.map(item => item.matchId); let cursor = first.body.nextCursor;
      while (cursor) { const page = await call(`&cursor=${cursor}`); expect(page.status).toBe(200); found.push(...page.body.items.map(item => item.matchId)); cursor = page.body.nextCursor; }
      expect(found).toEqual(expected.sort()); expect(new Set(found).size).toBe(108);
      expect((await call('&limit=100')).body.items).toHaveLength(100);
      expect((await call(`&cursor=${first.body.nextCursor}`, 'synthetic-manager-3')).status).toBe(400);
      expect((await call(`&cursor=${first.body.nextCursor}`, 'synthetic-account-player-01', 'player')).status).toBe(400);
      const child = await call('&limit=100', 'synthetic-account-player-01', 'player'); expect(child.status).toBe(200); expect(child.body.items).toHaveLength(100); expect(child.body.items.every(item => item.audience === 'player' && item.state === undefined && item.score === null)).toBe(true);
      expect((await call('', 'synthetic-admin', 'administrator')).status).toBe(404);
    } finally {
      api?.server.closeAllConnections(); await api?.close(); await media?.close(); await owner?.close();
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      for (const role of Object.values(roles)) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end(); rmSync(directory, { recursive: true, force: true });
    }
  });
});
