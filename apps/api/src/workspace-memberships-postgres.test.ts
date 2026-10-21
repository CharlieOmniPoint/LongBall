import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { CommunityState } from '../../../packages/application/src/community';
import type { PreparationState } from '../../../packages/application/src/preparation';
import type { NamedWorkspaceMembership } from '../../../packages/application/src/workspace-context';
import { PgDatabase } from './pg';
import { PostgresStore } from './postgres-store';
import { PgMediaService } from './postgres-media';
import { PostgresActivationService } from './postgres-activation';
import { createPostgresApi } from './postgres-server';
import { applyRuntimeGrants } from './runtime-grants';
import { EVENT_CONTRACT_VERSION, SYNTHETIC_IDS } from './store';

const configured = process.env.LONGBALL_POSTGRES_TEST_URL;
describe.skipIf(!configured)('named own workspace metadata through restricted PostgreSQL', () => {
  it('reads current configuration labels without private documents, peer metadata or retained revoked access', async () => {
    const admin = new Pool({ connectionString: configured, max: 2 }), suffix = randomUUID().replaceAll('-', '');
    const database = `lb_names_${suffix}`, directory = mkdtempSync(join(tmpdir(), 'longball-own-workspaces-pg-'));
    const roles = { apiRole: `lb_names_api_${suffix}`, workerRole: `lb_names_worker_${suffix}` };
    let owner: PostgresStore | undefined, api: Awaited<ReturnType<typeof createPostgresApi>> | undefined, worker: PgDatabase | undefined, media: PgMediaService | undefined;
    try {
      await admin.query(`CREATE DATABASE "${database}"`);
      for (const role of Object.values(roles)) await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      const ownerUrl = new URL(configured!); ownerUrl.pathname = `/${database}`;
      owner = await PostgresStore.open(ownerUrl.href); await owner.seedSynthetic();
      media = await PgMediaService.open({ directory: join(directory, 'media'), database: owner.db });
      await new PostgresActivationService({ store: owner }).initialize();
      await applyRuntimeGrants(owner.db, roles);
      const apiUrl = new URL(ownerUrl); apiUrl.username = roles.apiRole; apiUrl.password = '';
      api = await createPostgresApi({ connectionString: apiUrl.href, databasePath: join(directory, 'unused.sqlite'), mediaDirectory: join(directory, 'media'), migrationMode: 'verify', syntheticAuth: true, seedSynthetic: false });
      await new Promise<void>(resolve => api!.server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
      const call = async (route = '/v1/me', token = 'synthetic-manager-1', command?: unknown, role?: string) => {
        const response = await fetch(base + route, { method: command ? 'POST' : 'GET', headers: {
          Authorization: `Bearer ${token}`,
          ...(role ? { 'X-Longball-Role': role } : {}),
          ...(command ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), 'X-Api-Contract-Version': EVENT_CONTRACT_VERSION } : {}),
        }, body: command ? JSON.stringify({ command }) : undefined });
        return { status: response.status, body: await response.json() as { memberships: NamedWorkspaceMembership[] } };
      };
      expect((await api.store.db.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      const initial = await call();
      expect(initial.status).toBe(200);
      expect(initial.body.memberships).toHaveLength(2);
      expect(initial.body.memberships.every(member => member.accountId === 'synthetic-account-manager' && member.teamName === 'Roma U10' && member.clubName === 'Richmond Rovers' && member.seasonLabel === '2026/27')).toBe(true);
      expect(JSON.stringify(initial.body)).not.toContain('synthetic-account-manager-2');
      expect(JSON.stringify(initial.body)).not.toContain('Milan');
      expect(JSON.stringify(initial.body)).not.toContain('profiles');

      const identity = { issuer: 'urn:longball:synthetic', subject: 'synthetic-account-player-01', strongAuth: false, authenticatedAt: Date.now() };
      const child = await api.store.withIdentityContext(identity, () => api!.store.principal(identity));
      await api.store.withActorContext(child, { operation: 'account.read', requestedRole: 'default' }, async () => {
        expect(await api!.store.many('SELECT * FROM documents')).toEqual([]);
        expect(await api!.store.myMemberships(child)).toEqual([expect.objectContaining({ role: 'player', playerId: 'synthetic-player-01' })]);
        expect((await api!.store.myMemberships(child))[0]).not.toHaveProperty('teamName');
        expect(await api!.store.workspaceMemberships(child)).toEqual([expect.objectContaining({ role: 'player', playerId: 'synthetic-player-01', teamName: 'Roma U10' })]);
      });
      await expect(api.store.withActorContext(child, { operation: 'account.read', requestedRole: 'default', teamId: 'synthetic-other-team', seasonId: SYNTHETIC_IDS.seasonId }, () => api!.store.workspaceMemberships(child))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await api.store.withActorContext(child, { operation: 'account.read', requestedRole: 'default', teamId: SYNTHETIC_IDS.teamId, seasonId: SYNTHETIC_IDS.seasonId }, async () => {
        expect(await api!.store.many('SELECT * FROM longball.workspace_membership_names()')).toEqual([]);
      });
      await api.store.withActorContext(child, { operation: 'community.read', requestedRole: 'player', teamId: SYNTHETIC_IDS.teamId, seasonId: SYNTHETIC_IDS.seasonId }, async () => {
        expect(await api!.store.many('SELECT * FROM longball.workspace_membership_names()')).toEqual([]);
      });
      const workerUrl = new URL(ownerUrl); workerUrl.username = roles.workerRole; workerUrl.password = '';
      worker = new PgDatabase(workerUrl.href, { migrationMode: 'verify' }); await worker.migrate();
      await expect(worker.query('SELECT * FROM longball.workspace_membership_names()')).rejects.toMatchObject({ code: '42501' });

      const route = `/v1/teams/${SYNTHETIC_IDS.teamId}/configuration?seasonId=${SYNTHETIC_IDS.seasonId}`;
      const preparation = await owner.document<PreparationState>(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'preparation');
      expect((await call(route, 'synthetic-manager-1', { id: randomUUID(), expectedRevision: preparation.revision, type: 'team.updated', name: 'Roma Lions', ageGroup: 'U11', defaultPitchPlaces: preparation.team.defaultPitchPlaces, defaultHalfDurationMs: preparation.team.defaultHalfDurationMs, logo: null }, 'manager')).status).toBe(200);
      expect((await call(route, 'synthetic-admin', { id: randomUUID(), expectedRevision: preparation.revision + 1, type: 'club.updated', name: 'Richmond Rovers Juniors', logo: null }, 'administrator')).status).toBe(200);
      const renamed = await call('/v1/me', 'synthetic-account-player-01');
      expect(renamed.status).toBe(200);
      expect(renamed.body.memberships).toEqual([expect.objectContaining({ teamName: 'Roma Lions U11', clubName: 'Richmond Rovers Juniors', seasonLabel: '2026/27', playerId: 'synthetic-player-01' })]);
      expect((await call(route, 'synthetic-account-player-01')).status).toBe(404);
      expect(JSON.stringify(renamed.body)).not.toContain('synthetic-player-02');

      expect((await call('/v1/me', 'synthetic-spectator')).body.memberships).toHaveLength(1);
      const community = await owner.document<CommunityState>(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'community');
      const revoked: CommunityState = { ...community, grants: community.grants.map(grant => ({ ...grant, revokedAtMs: Date.now() })) };
      await owner.saveDocument(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'community', revoked);
      expect((await call('/v1/me', 'synthetic-spectator')).body.memberships).toEqual([]);
      await owner.execute("UPDATE memberships SET revoked_at=$1 WHERE account_id='synthetic-account-manager-2'", [Date.now()]);
      expect((await call('/v1/me', 'synthetic-manager-2')).body.memberships).toEqual([]);
      await owner.execute("UPDATE memberships SET expires_at=$1 WHERE account_id='synthetic-account-player-01'", [Date.now()]);
      expect((await call('/v1/me', 'synthetic-account-player-01')).body.memberships).toEqual([]);
    } finally {
      api?.server.closeAllConnections(); await api?.close(); await worker?.close(); await media?.close(); await owner?.close();
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      for (const role of Object.values(roles)) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end(); rmSync(directory, { recursive: true, force: true });
    }
  });
});
