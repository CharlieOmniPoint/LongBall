import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../../../packages/application/src/access';
import type { CommunityState } from '../../../packages/application/src/community';
import type { MatchState } from '../../../packages/domain/src/types';
import { PgDatabase } from './pg';
import { PostgresStore, SYNTHETIC_IDS } from './postgres-store';
import { PgMediaService } from './postgres-media';
import { PostgresActivationService } from './postgres-activation';
import { applyRuntimeGrants } from './runtime-grants';
import { MatchFeedbackRepository } from './match-feedback-repository';
import { MatchFeedbackService, type MatchFeedbackSession } from './match-feedback-service';

const configured = process.env.LONGBALL_POSTGRES_TEST_URL;
describe.skipIf(!configured)('actual restricted PostgreSQL private match feedback', () => {
  let admin: Pool, maintenance: Pool, owner: PgDatabase, api: PgDatabase, worker: PgDatabase, store: PostgresStore, service: MatchFeedbackService, database: string, directory: string, matchId: string;
  const pools: PgDatabase[] = [], roles: Record<string, string> = {}, principals: Record<string, Principal> = {};
  const teamId = SYNTHETIC_IDS.teamId, seasonId = SYNTHETIC_IDS.seasonId;
  const session = (name = 'player-01', role = name.startsWith('manager') ? 'manager' : name === 'admin' ? 'administrator' : name === 'spectator' ? 'spectator' : 'player'): MatchFeedbackSession => ({ principal: principals[name], teamId, seasonId, role });
  const run = <T>(actor: MatchFeedbackSession, operation: string, work: () => Promise<T>) => store.withActorContext(actor.principal, { operation, requestedRole: actor.role as 'manager' | 'player' | 'administrator' | 'spectator', teamId: actor.teamId, seasonId: actor.seasonId }, work);
  const command = (changes = {}) => ({ id: 'postgres-feedback-command', type: 'feedback.saved', matchId, expectedRevision: 0, rating: 4, text: 'A private post-game note.', ...changes });
  beforeAll(async () => {
    admin = new Pool({ connectionString: configured, max: 2 }); const suffix = randomUUID().replaceAll('-', ''); database = `lb_feedback_${suffix}`;
    for (const purpose of ['owner', 'api', 'worker']) { roles[purpose] = `lb_feedback_${purpose}_${suffix}`; await admin.query(`CREATE ROLE "${roles[purpose]}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`); }
    await admin.query(`CREATE DATABASE "${database}"`); const base = new URL(configured!); base.pathname = `/${database}`;
    maintenance = new Pool({ connectionString: base.href, max: 2 }); await maintenance.query(`CREATE SCHEMA longball AUTHORIZATION "${roles.owner}"`);
    const connect = (purpose: string, migrationMode: 'apply' | 'verify') => { const url = new URL(base); url.username = roles[purpose]; url.password = ''; const db = new PgDatabase(url.href, { migrationMode, maximumConnections: 1 }); pools.push(db); return db; };
    owner = connect('owner', 'apply'); await owner.migrate(); const seed = new PostgresStore(owner); await seed.seedSynthetic({ demoSharing: true });
    directory = await mkdtemp(join(tmpdir(), 'longball-feedback-')); await PgMediaService.open({ directory, database: owner }); await new PostgresActivationService({ store: seed }).initialize();
    await applyRuntimeGrants(owner, { apiRole: roles.api, workerRole: roles.worker });
    api = connect('api', 'verify'); worker = connect('worker', 'verify'); await api.migrate(); store = new PostgresStore(api);
    for (const name of ['manager-2', 'player-01', 'player-02', 'admin', 'spectator']) principals[name] = await seed.principal({ issuer: 'urn:longball:synthetic', subject: `synthetic-account-${name}`, strongAuth: name.startsWith('manager') || name === 'admin', authenticatedAt: Date.now() });
    const matches = (await owner.query('SELECT state_json FROM matches WHERE team_id=$1 AND season_id=$2', [teamId, seasonId])).rows.map(row => JSON.parse(row.state_json) as MatchState);
    const state = matches.find(item => item.status === 'completed' && item.intervals.some(interval => interval.playerId === 'synthetic-player-01' && interval.state === 'playing' && interval.endMs > interval.startMs))!;
    matchId = state.config.matchId;
    const row = (await owner.query("SELECT value_json FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='community'", [teamId, seasonId])).rows[0];
    const community = JSON.parse(row.value_json) as CommunityState, context = community.matches.find(item => item.id === matchId)!;
    context.actualFullTimeAtMs = Date.now() - 1; context.finishQuality = 'trusted';
    context.selectedPlayerIds = [...state.config.selectedPlayerIds]; context.presentPlayerIds = state.config.selectedPlayerIds.filter(id => state.attendance[id] === 'present');
    context.playedPlayerIds = state.config.selectedPlayerIds.filter(id => state.intervals.some(interval => interval.playerId === id && interval.state === 'playing' && interval.endMs > interval.startMs));
    await owner.query("UPDATE documents SET value_json=$1,revision=revision+1 WHERE team_id=$2 AND season_id=$3 AND kind='community'", [JSON.stringify(community), teamId, seasonId]);
    service = new MatchFeedbackService(new MatchFeedbackRepository(store, store));
  });
  afterAll(async () => { for (const db of pools) await db.close(); await maintenance?.end(); if (database) await admin.query(`DROP DATABASE "${database}"`); for (const role of Object.values(roles)) await admin.query(`DROP ROLE "${role}"`); if (directory) await rm(directory, { recursive: true, force: true }); await admin?.end(); });
  it('enforces own-player persistence, manager-only private read and exact CAS/idempotency through restricted logins', async () => {
    const player = session(), receipt = await run(player, 'feedback.write', () => service.command(player, command()));
    expect(receipt.revision).toBe(1); expect(await run(player, 'feedback.write', () => service.command(player, command()))).toEqual(receipt);
    await expect(run(player, 'feedback.write', () => service.command(player, command({ id: 'postgres-stale-command' })))).rejects.toMatchObject({ code: 'FEEDBACK_REVISION_CONFLICT' });
    const own = await run(player, 'feedback.read', () => service.view(player)); expect(own.matches.find(item => item.matchId === matchId)?.own?.text).toBe('A private post-game note.');
    const other = session('player-02'); expect(JSON.stringify(await run(other, 'feedback.read', () => service.view(other)))).not.toContain('A private post-game note.');
    const manager = session('manager-2'); expect((await run(manager, 'feedback.read', () => service.view(manager))).matches.find(item => item.matchId === matchId)?.entries).toHaveLength(1);
    for (const denied of [session('admin'), session('spectator')]) await expect(run(denied, 'feedback.read', () => service.view(denied))).rejects.toMatchObject({ status: 404 });
    expect((await api.query('SELECT * FROM match_feedback')).rows).toEqual([]);
    await expect(worker.query('SELECT * FROM match_feedback')).rejects.toMatchObject({ code: '42501' });
    await expect(worker.query('SELECT * FROM match_feedback_receipts')).rejects.toMatchObject({ code: '42501' });
  });
  it('keeps raw feedback out of administrator statistics/other-player SQL and rejects immutable-window or other-player writes', async () => {
    const player = session(), manager = session('manager-2'), other = session('player-02'), administrator = session('admin');
    expect((await run(other, 'feedback.read', () => api.query('SELECT * FROM match_feedback'))).rows).toEqual([]);
    expect((await run(administrator, 'admin.stats', () => api.query('SELECT * FROM match_feedback'))).rows).toEqual([]);
    expect((await run(manager, 'records.read', () => api.query('SELECT * FROM match_feedback'))).rows).toEqual([]);
    await expect(run(player, 'feedback.write', () => api.query('UPDATE match_feedback SET closes_at=closes_at+86400000,revision=revision+1 WHERE match_id=$1', [matchId]))).rejects.toMatchObject({ code: '23514' });
    await expect(run(player, 'feedback.write', () => api.query("UPDATE match_feedback SET player_id='synthetic-player-02',revision=revision+1 WHERE match_id=$1", [matchId]))).rejects.toThrow();
    await expect(run(manager, 'feedback.write', () => api.query('UPDATE match_feedback SET rating=5,revision=revision+1 WHERE match_id=$1', [matchId]))).resolves.toMatchObject({ rowCount: 0 });
    await expect(api.query('DELETE FROM match_feedback WHERE false')).rejects.toMatchObject({ code: '42501' });
    expect((await maintenance.query('SELECT count(*)::integer AS count FROM longball.match_feedback')).rows[0].count).toBe(1);
  });
  it('immediately denies both cached receipt and private read after account grant revocation, retaining history', async () => {
    const player = session();
    await owner.query("UPDATE memberships SET revoked_at=$1 WHERE account_id=$2 AND team_id=$3 AND season_id=$4 AND role='player'", [Date.now(), player.principal.accountId, teamId, seasonId]);
    try {
      await expect(run(player, 'feedback.read', () => service.view(player))).rejects.toMatchObject({ status: 404 });
      await expect(run(player, 'feedback.write', () => service.command(player, command()))).rejects.toMatchObject({ status: 404 });
      expect((await run(player, 'feedback.read', () => api.query('SELECT * FROM match_feedback'))).rows).toEqual([]);
      expect((await maintenance.query('SELECT count(*)::integer AS count FROM longball.match_feedback')).rows[0].count).toBe(1);
    } finally { await owner.query("UPDATE memberships SET revoked_at=NULL WHERE account_id=$1 AND team_id=$2 AND season_id=$3 AND role='player'", [player.principal.accountId, teamId, seasonId]); }
  });
  it('rejects direct SQL without positive accepted playing evidence despite a current player membership', async () => {
    const accountId = 'feedback-bench-account';
    await owner.query("INSERT INTO accounts(id,issuer,subject,classification) VALUES($1,'urn:longball:synthetic',$1,'child_shared')", [accountId]);
    await owner.query("INSERT INTO memberships(account_id,team_id,season_id,role,player_id) VALUES($1,$2,$3,'player','feedback-never-played')", [accountId, teamId, seasonId]);
    const principal = await new PostgresStore(owner).principal({ issuer: 'urn:longball:synthetic', subject: accountId, strongAuth: false, authenticatedAt: Date.now() });
    const actor = { principal, teamId, seasonId, role: 'player' };
    const existing = (await maintenance.query('SELECT * FROM longball.match_feedback LIMIT 1')).rows[0];
    await expect(run(actor, 'feedback.write', () => api.query('INSERT INTO match_feedback(team_id,season_id,match_id,account_id,player_id,rating,note,revision,completed_at,closes_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,4,NULL,1,$6,$7,$8,$8)', [teamId, seasonId, matchId, accountId, 'feedback-never-played', existing.completed_at, existing.closes_at, Date.now()]))).rejects.toMatchObject({ code: '23514' });
    expect((await maintenance.query('SELECT count(*)::integer AS count FROM longball.match_feedback')).rows[0].count).toBe(1);
  });
});
