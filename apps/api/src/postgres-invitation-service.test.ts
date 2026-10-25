import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../../../packages/application/src/access';
import type { CommunityState } from '../../../packages/application/src/community';
import { PgDatabase } from './pg';
import { PostgresStore, SYNTHETIC_IDS } from './postgres-store';
import { PgMediaService } from './postgres-media';
import { PostgresActivationService } from './postgres-activation';
import { applyRuntimeGrants } from './runtime-grants';
import { PostgresInvitationRepository } from './postgres-invitation-repository';
import { invitationVerifier, SpectatorInvitationService, type InvitationSession } from './invitation-service';
const configured = process.env.LONGBALL_POSTGRES_TEST_URL;
describe.skipIf(!configured)('actual restricted PostgreSQL invitation service', () => {
  let admin: Pool, owner: PgDatabase, api: PgDatabase, worker: PgDatabase, store: PostgresStore, service: SpectatorInvitationService, database: string, directory: string;
  const pools: PgDatabase[] = [], roles: Record<string, string> = {}, principals: Record<string, Principal> = {};
  const teamId = SYNTHETIC_IDS.teamId, seasonId = SYNTHETIC_IDS.seasonId, input = { seasonId, expiresInHours: 1 };
  const session = (name = 'manager', role = name.startsWith('player') ? 'player' : 'manager'): InvitationSession => ({ principal: principals[name], teamId, seasonId, role });
  const run = <T>(session: InvitationSession, operation: string, work: () => Promise<T>, tokenHash?: string) => store.withActorContext(session.principal, { operation, requestedRole: session.role as 'manager'|'player'|'spectator', teamId, seasonId, ...(tokenHash ? { invitationTokenHash: tokenHash } : {}) }, work);
  const issue = async (owner = session(), source?: string) => {
    const key = randomUUID(), result = await run(owner, source ? 'invite.reissue' : 'invite.issue', () => service.issue(owner, key, input, source));
    if (!('shareUrl' in result.body)) throw new Error('FIRST_CREDENTIAL_REQUIRED');
    return { key, ...result.body, token: new URLSearchParams(new URL(result.body.shareUrl).hash.slice(1)).get('code')! };
  };
  const accept = (token: string, owner = session('invitee', 'spectator'), key = randomUUID()) => run(owner, 'invite.accept', () => service.accept(owner, key, { token }), invitationVerifier(token));
  beforeAll(async () => {
    admin = new Pool({ connectionString: configured, max: 2 }); const suffix = randomUUID().replaceAll('-', ''); database = `lb_invsvc_${suffix}`;
    for (const purpose of ['owner', 'api', 'worker']) { roles[purpose] = `lb_invsvc_${purpose}_${suffix}`; await admin.query(`CREATE ROLE "${roles[purpose]}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`); }
    await admin.query(`CREATE DATABASE "${database}"`); const base = new URL(configured!); base.pathname = `/${database}`; const bootstrap = new Pool({ connectionString: base.href });
    try { await bootstrap.query(`CREATE SCHEMA longball AUTHORIZATION "${roles.owner}"`); } finally { await bootstrap.end(); }
    const connect = (purpose: string, migrationMode: 'apply'|'verify') => { const url = new URL(base); url.username = roles[purpose]; url.password = ''; const db = new PgDatabase(url.href, { migrationMode, maximumConnections: 1 }); pools.push(db); return db; };
    owner = connect('owner', 'apply'); await owner.migrate(); const seed = new PostgresStore(owner); await seed.seedSynthetic(); directory = await mkdtemp(join(tmpdir(), 'longball-invsvc-'));
    await PgMediaService.open({ directory, database: owner }); await new PostgresActivationService({ store: seed }).initialize(); await applyRuntimeGrants(owner, { apiRole: roles.api, workerRole: roles.worker });
    api = connect('api', 'verify'); worker = connect('worker', 'verify'); await api.migrate(); store = new PostgresStore(api);
    for (const name of ['manager', 'player-01', 'player-02', 'invitee']) principals[name] = await seed.principal({ issuer: 'urn:longball:synthetic', subject: `synthetic-account-${name}`, strongAuth: name === 'manager', authenticatedAt: Date.now() });
    service = new SpectatorInvitationService({ repository: new PostgresInvitationRepository(store), publicAppEntryUrl: 'https://example.invalid/LongBall/', invitationPolicyVersion: 'explicit-test-policy' });
  });
  afterAll(async () => { for (const db of pools) await db.close(); if (database) await admin.query(`DROP DATABASE "${database}" WITH(FORCE)`); for (const role of Object.values(roles)) await admin.query(`DROP ROLE "${role}"`); if (directory) await rm(directory, { recursive: true, force: true }); await admin?.end(); });
  it('allows current selected players to issue with no approval while cached retries and all durable rows contain no raw credential', async () => {
    const player = session('player-01'), first = await issue(player);
    const retry = await run(player, 'invite.issue', () => service.issue(player, first.key, input)); expect(retry).toMatchObject({ status: 200, body: { credentialAvailable: false, requiresReissue: true, id: first.id } });
    const row = (await owner.query('SELECT * FROM spectator_invitations WHERE id=$1', [first.id])).rows[0]; expect(row.token_hash).toBe(invitationVerifier(first.token));
    const saved = JSON.stringify([(await owner.query('SELECT * FROM spectator_invitations')).rows, (await owner.query('SELECT * FROM documents')).rows, (await owner.query('SELECT * FROM idempotency')).rows, (await owner.query('SELECT * FROM audit')).rows]); expect(saved).not.toContain(first.token); expect(saved).not.toContain(first.shareUrl);
    const own = await run(player, 'invite.list', () => service.list(player)); expect(own.invitations.some(item => item.id === first.id)).toBe(true); expect(JSON.stringify(own)).not.toMatch(/tokenHash|token_hash|credential|reviewCode|shareUrl/);
    const other = session('player-02'); expect((await run(other, 'invite.list', () => service.list(other))).invitations.some(item => item.id === first.id)).toBe(false);
    expect((await api.query('SELECT * FROM spectator_invitations')).rowCount).toBe(0); await expect(worker.query('SELECT * FROM spectator_invitations')).rejects.toMatchObject({ code: '42501' });
  });
  it('resolves and inspects only the possessed live hash, then accepts once and never writes unrelated membership scopes', async () => {
    const first = await issue(), invitee = session('invitee', 'spectator');
    const before = (await owner.query('SELECT * FROM memberships ORDER BY account_id,role')).rows;
    const inspected = await store.withActorContext(invitee.principal, { operation: 'invite.resolve', requestedRole: 'default', invitationTokenHash: invitationVerifier(first.token) }, () => service.inspect(invitee.principal, { token: first.token }));
    expect(inspected).toEqual({ invitationId: first.id, teamId, seasonId, expiresAt: first.expiresAt, context: { clubName: 'Richmond Rovers', teamName: 'Roma', ageGroup: 'U10', seasonLabel: '2026/27', inviterLabel: 'Team manager' } }); expect((await owner.query('SELECT * FROM memberships ORDER BY account_id,role')).rows).toEqual(before);
    const key = randomUUID(), accepted = await accept(first.token, invitee, key); expect((await accept(first.token, invitee, key))).toEqual(accepted);
    const state = JSON.parse((await owner.query("SELECT value_json FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='community'", [teamId, seasonId])).rows[0].value_json) as CommunityState;
    expect(state.grants.filter(grant => grant.invitationId === first.id)).toHaveLength(1); expect(accepted.body.expiresAt).toBe(new Date(state.seasons.find(item => item.id === seasonId)!.accessEndsAtMs).toISOString());
    await expect(accept(first.token, session('player-02', 'spectator'))).rejects.toMatchObject({ status: 404 });
    expect((await owner.query("SELECT * FROM memberships WHERE account_id<>'synthetic-account-invitee' ORDER BY account_id,role")).rows).toEqual(before.filter(row => row.account_id !== 'synthetic-account-invitee'));
  });
  it('reissues pending source atomically and manager revocation preserves unrelated roles and another grant union', async () => {
    const player = session('player-01'), first = await issue(player), other = session('player-02');
    await expect(run(other, 'invite.reissue', () => service.issue(other, randomUUID(), input, first.id))).rejects.toThrow(/original current inviter/);
    const replacement = await issue(player, first.id); expect((await owner.query('SELECT revoked_at FROM spectator_invitations WHERE id=$1', [first.id])).rows[0].revoked_at).not.toBe(null);
    await expect(accept(first.token)).rejects.toThrow();
    const acceptedAccount = session('player-02', 'spectator'); await accept(replacement.token, acceptedAccount); const second = await issue(); await accept(second.token, acceptedAccount);
    const manager = session(); await run(manager, 'invite.revoke', () => service.revoke(manager, randomUUID(), replacement.id));
    expect((await owner.query("SELECT revoked_at FROM memberships WHERE account_id='synthetic-account-player-02' AND role='spectator'")).rows[0].revoked_at).toBe(null);
    await run(manager, 'invite.revoke', () => service.revoke(manager, randomUUID(), second.id));
    expect((await owner.query("SELECT revoked_at FROM memberships WHERE account_id='synthetic-account-player-02' AND role='spectator'")).rows[0].revoked_at).not.toBe(null);
    expect((await owner.query("SELECT revoked_at FROM memberships WHERE account_id='synthetic-account-player-02' AND role='player'")).rows[0].revoked_at).toBe(null);
  });
  it('rolls back mirror and document on receipt failure and rejects purpose/context substitution', async () => {
    const before = (await owner.query("SELECT value_json FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='community'", [teamId, seasonId])).rows[0].value_json;
    await owner.query("CREATE FUNCTION refuse_invitation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test receipt refusal'; END $$; CREATE TRIGGER refuse_invitation_receipt BEFORE INSERT ON idempotency FOR EACH ROW EXECUTE FUNCTION refuse_invitation_receipt()");
    try { await expect(issue()).rejects.toThrow(/test receipt refusal/); } finally { await owner.query('DROP TRIGGER refuse_invitation_receipt ON idempotency; DROP FUNCTION refuse_invitation_receipt()'); }
    expect((await owner.query("SELECT value_json FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='community'", [teamId, seasonId])).rows[0].value_json).toBe(before);
    const player = session('player-01'); await expect(run(player, 'community.write', () => service.issue(player, randomUUID(), input))).rejects.toMatchObject({ code: '42501' });
    expect((await owner.query("SELECT value_json FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='community'", [teamId, seasonId])).rows[0].value_json).toBe(before);
  });
  it('refuses normalized revocation drift before inspection or mutation without repairing either history', async () => {
    const first = await issue(), invitee = session('invitee', 'spectator');
    await owner.query('UPDATE spectator_invitations SET revoked_at=$1 WHERE id=$2', [Date.now(), first.id]);
    const before = (await owner.query("SELECT value_json FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='community'", [teamId, seasonId])).rows[0].value_json;
    await expect(store.withActorContext(invitee.principal, { operation: 'invite.resolve', requestedRole: 'default', invitationTokenHash: invitationVerifier(first.token) }, () => service.inspect(invitee.principal, { token: first.token }))).rejects.toMatchObject({ status: 404 });
    await expect(run(session(), 'invite.list', () => service.list(session()))).rejects.toMatchObject({ code: 'INVITATION_RECONCILIATION_REQUIRED' });
    expect((await owner.query("SELECT value_json FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='community'", [teamId, seasonId])).rows[0].value_json).toBe(before);
  });
});
