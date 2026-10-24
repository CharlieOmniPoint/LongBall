import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../../../packages/application/src/access';
import type { PreparationState } from '../../../packages/application/src/preparation';
import { PgDatabase, type PgApplicationContext } from './pg';
import { PostgresStore, SYNTHETIC_IDS } from './postgres-store';
import { PgMediaService } from './postgres-media';
import { PostgresActivationService } from './postgres-activation';
import { applyRuntimeGrants } from './runtime-grants';
import { PostgresInvitationRepository } from './postgres-invitation-repository';
import { invitationVerifier, SpectatorInvitationService, type InvitationSession } from './invitation-service';

const configured = process.env.LONGBALL_POSTGRES_TEST_URL;
describe.skipIf(!configured)('actual restricted PostgreSQL invitation preview context', () => {
  let admin: Pool, owner: PgDatabase, api: PgDatabase, worker: PgDatabase, store: PostgresStore, service: SpectatorInvitationService, database: string, directory: string;
  const pools: PgDatabase[] = [], roles: Record<string, string> = {}, principals: Record<string, Principal> = {};
  const { teamId, seasonId } = SYNTHETIC_IDS;
  const session = (name = 'manager'): InvitationSession => ({ principal: principals[name], teamId, seasonId, role: name.startsWith('player') ? 'player' : 'manager' });
  const run = <T>(selected: InvitationSession, operation: string, work: () => Promise<T>) => store.withActorContext(selected.principal, { operation, requestedRole: selected.role as 'manager' | 'player', teamId, seasonId }, work);
  const issue = async (name = 'manager') => {
    const selected = session(name), result = await run(selected, 'invite.issue', () => service.issue(selected, randomUUID(), { seasonId, expiresInHours: 1 }));
    if (!('shareUrl' in result.body)) throw new Error('FIRST_CREDENTIAL_REQUIRED');
    return { ...result.body, hash: invitationVerifier(new URLSearchParams(new URL(result.body.shareUrl).hash.slice(1)).get('code')) };
  };
  const activationContext = (hash: string, nowMs = Date.now()): PgApplicationContext => ({ kind: 'invitation_activation', tokenHash: hash, nowMs });
  const actorContext = (hash: string, extra: Partial<Extract<PgApplicationContext, { kind: 'actor' }>> = {}): PgApplicationContext => ({ kind: 'actor', accountId: principals.invitee.accountId, issuer: principals.invitee.issuer, subject: principals.invitee.subject, strongAuth: false, authenticatedAtMs: Date.now(), nowMs: Date.now(), requestedRole: 'default', operation: 'invite.resolve', invitationTokenHash: hash, ...extra });
  const preview = (context: PgApplicationContext, hash: string) => api.withContext(context, async () => (await api.query('SELECT * FROM invitation_preview_context($1)', [hash])).rows);

  beforeAll(async () => {
    admin = new Pool({ connectionString: configured, max: 2 });
    const suffix = randomUUID().replaceAll('-', ''); database = `lb_invctx_${suffix}`;
    for (const purpose of ['owner', 'api', 'worker']) {
      roles[purpose] = `lb_invctx_${purpose}_${suffix}`;
      await admin.query(`CREATE ROLE "${roles[purpose]}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    }
    await admin.query(`CREATE DATABASE "${database}"`);
    const base = new URL(configured!); base.pathname = `/${database}`;
    const bootstrap = new Pool({ connectionString: base.href });
    try { await bootstrap.query(`CREATE SCHEMA longball AUTHORIZATION "${roles.owner}"`); } finally { await bootstrap.end(); }
    const connect = (purpose: string, migrationMode: 'apply' | 'verify') => {
      const url = new URL(base); url.username = roles[purpose]; url.password = '';
      const connection = new PgDatabase(url.href, { migrationMode, maximumConnections: 1 }); pools.push(connection); return connection;
    };
    owner = connect('owner', 'apply'); await owner.migrate();
    const seed = new PostgresStore(owner); await seed.seedSynthetic();
    directory = await mkdtemp(join(tmpdir(), 'longball-invitation-context-'));
    await PgMediaService.open({ directory, database: owner });
    await new PostgresActivationService({ store: seed }).initialize();
    await applyRuntimeGrants(owner, { apiRole: roles.api, workerRole: roles.worker });
    api = connect('api', 'verify'); worker = connect('worker', 'verify'); await api.migrate();
    store = new PostgresStore(api);
    for (const name of ['manager', 'player-01', 'invitee']) principals[name] = await seed.principal({ issuer: 'urn:longball:synthetic', subject: `synthetic-account-${name}`, strongAuth: name === 'manager', authenticatedAt: Date.now() });
    service = new SpectatorInvitationService({ repository: new PostgresInvitationRepository(store), publicAppEntryUrl: 'https://example.invalid/LongBall/', invitationPolicyVersion: 'explicit-context-test' });
  });
  afterAll(async () => {
    for (const connection of pools) await connection.close();
    if (database) await admin.query(`DROP DATABASE "${database}" WITH(FORCE)`);
    for (const role of Object.values(roles)) await admin.query(`DROP ROLE "${role}"`);
    if (directory) await rm(directory, { recursive: true, force: true });
    await admin?.end();
  });

  it('returns only current token-bound names for authenticated inspection and activation preflight without opening private rows', async () => {
    const first = await issue();
    const expected = [{ club_name: 'Richmond Rovers', team_name: 'Roma', age_group: 'U10', season_label: '2026/27', inviter_label: 'Team manager' }];
    for (const context of [actorContext(first.hash), activationContext(first.hash)]) {
      expect(await preview(context, first.hash)).toEqual(expected);
      await api.withContext(context, async () => {
        expect((await api.query('SELECT * FROM documents')).rowCount).toBe(0);
        expect((await api.query('SELECT * FROM memberships')).rowCount).toBe(0);
      });
    }
    const playerInvite = await issue('player-01');
    expect(await preview(activationContext(playerInvite.hash), playerInvite.hash)).toEqual([{ ...expected[0], inviter_label: 'Team member' }]);
  });
  it('reads actual configuration renames and exact scoped season metadata ahead of stale normalized labels', async () => {
    const first = await issue();
    const before = (await owner.query("SELECT value_json FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='preparation'", [teamId, seasonId])).rows[0].value_json;
    try {
      await store.withActorContext(principals.manager, { operation: 'configuration.write', requestedRole: 'administrator', teamId, seasonId }, async () => {
        let current = await store.document<PreparationState>(teamId, seasonId, 'preparation');
        await store.configurationCommand(principals.manager, teamId, seasonId, { id: randomUUID(), expectedRevision: current.revision, type: 'club.updated', name: 'Richmond Athletic', logo: null }, 'administrator');
        current = await store.document<PreparationState>(teamId, seasonId, 'preparation');
        await store.configurationCommand(principals.manager, teamId, seasonId, { id: randomUUID(), expectedRevision: current.revision, type: 'team.updated', name: 'Roma Academy', ageGroup: 'U11', defaultPitchPlaces: current.team.defaultPitchPlaces, defaultHalfDurationMs: current.team.defaultHalfDurationMs, logo: null }, 'administrator');
      });
      await owner.query("UPDATE documents SET value_json=jsonb_set(value_json,'{seasons,0,label}','\"Autumn development 2026/27\"'::jsonb) WHERE team_id=$1 AND season_id=$2 AND kind='preparation'", [teamId, seasonId]);
      expect((await owner.query('SELECT name FROM teams WHERE id=$1', [teamId])).rows[0].name).toBe('Roma U10');
      expect((await owner.query('SELECT label FROM team_seasons WHERE team_id=$1 AND season_id=$2', [teamId, seasonId])).rows[0].label).toBe('2026/27');
      expect(await preview(actorContext(first.hash), first.hash)).toEqual([{ club_name: 'Richmond Athletic', team_name: 'Roma Academy', age_group: 'U11', season_label: 'Autumn development 2026/27', inviter_label: 'Team manager' }]);
      await owner.query("UPDATE documents SET value_json=jsonb_set(value_json,'{team,id}','\"synthetic-other-team\"'::jsonb) WHERE team_id=$1 AND season_id=$2 AND kind='preparation'", [teamId, seasonId]);
      expect(await preview(actorContext(first.hash), first.hash)).toEqual([{ club_name: 'Richmond Rovers', team_name: 'Roma U10', age_group: null, season_label: '2026/27', inviter_label: 'Team manager' }]);
    } finally {
      await owner.query("UPDATE documents SET value_json=$1,revision=($1::jsonb->>'revision')::bigint WHERE team_id=$2 AND season_id=$3 AND kind='preparation'", [before, teamId, seasonId]);
    }
  });
  it('refuses missing context, wrong hash, operation and explicit cross-club/team/season scope without revealing names', async () => {
    const first = await issue(), second = await issue(), unknown = randomBytes(32).toString('hex');
    expect((await api.query('SELECT * FROM invitation_preview_context($1)', [first.hash])).rowCount).toBe(0);
    for (const context of [actorContext(first.hash), activationContext(first.hash)]) {
      expect(await preview(context, second.hash)).toEqual([]);
      expect(await preview(context, unknown)).toEqual([]);
    }
    for (const extra of [{ operation: 'community.read' }, { clubId: 'synthetic-other-club' }, { teamId: 'synthetic-other-team' }, { seasonId: 'other-season' }]) expect(await preview(actorContext(first.hash, extra), first.hash)).toEqual([]);
    await expect(worker.withContext(activationContext(first.hash), () => worker.query('SELECT * FROM invitation_preview_context($1)', [first.hash]))).rejects.toMatchObject({ code: '42501' });
  });
  it('refuses expired and revoked pending tokens for both capability and authenticated previews', async () => {
    const first = await issue(), expiredAt = Date.parse(first.expiresAt) + 1;
    expect(await preview(activationContext(first.hash, expiredAt), first.hash)).toEqual([]);
    expect(await preview(actorContext(first.hash, { nowMs: expiredAt }), first.hash)).toEqual([]);
    const manager = session(); await run(manager, 'invite.revoke', () => service.revoke(manager, randomUUID(), first.id));
    expect(await preview(activationContext(first.hash), first.hash)).toEqual([]);
    expect(await preview(actorContext(first.hash), first.hash)).toEqual([]);
  });
});
