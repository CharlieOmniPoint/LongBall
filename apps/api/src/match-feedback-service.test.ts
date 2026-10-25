import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '../../../packages/application/src/access';
import { matchFeedbackClosesAt } from '../../../packages/application/src/match-feedback';
import type { MatchState } from '../../../packages/domain/src/types';
import { DevelopmentStore, SYNTHETIC_IDS } from './store';
import { sqliteRuntimeStore } from './runtime-store';
import { MatchFeedbackRepository } from './match-feedback-repository';
import { MatchFeedbackService, type MatchFeedbackSession } from './match-feedback-service';

const stores: DevelopmentStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
async function fixture(finish = Date.parse('2026-07-15T15:00:00Z')) {
  let now = finish + 60_000;
  const source = new DevelopmentStore(':memory:', () => now); stores.push(source); source.seedSynthetic({ demoSharing: true });
  const runtime = sqliteRuntimeStore(source).store, repository = new MatchFeedbackRepository(source, runtime); await repository.initialize();
  const service = new MatchFeedbackService(repository), teamId = SYNTHETIC_IDS.teamId, seasonId = SYNTHETIC_IDS.seasonId;
  const community = source.communityState(teamId, seasonId), context = community.matches.find(item => item.actualFullTimeAtMs !== null)!;
  const row = source.database.prepare('SELECT state_json FROM matches WHERE id=?').get(context.id) as { state_json: string };
  const state = JSON.parse(row.state_json) as MatchState;
  context.actualFullTimeAtMs = finish; context.finishQuality = 'trusted';
  context.selectedPlayerIds = [...state.config.selectedPlayerIds]; context.presentPlayerIds = state.config.selectedPlayerIds.filter(id => state.attendance[id] === 'present');
  context.playedPlayerIds = state.config.selectedPlayerIds.filter(id => state.intervals.some(interval => interval.playerId === id && interval.state === 'playing' && interval.endMs > interval.startMs));
  source.saveDocument(teamId, seasonId, 'community', community);
  const principal = (name: string): Principal => source.principal({ issuer: 'urn:longball:synthetic', subject: `synthetic-account-${name}`, strongAuth: name.startsWith('manager') || name === 'admin', authenticatedAt: now });
  const session = (name = 'player-01', role: string = name.startsWith('manager') ? 'manager' : name === 'admin' ? 'administrator' : name === 'spectator' ? 'spectator' : 'player'): MatchFeedbackSession => ({ principal: principal(name), teamId, seasonId, role });
  const command = (changes = {}) => ({ id: 'feedback-command-0001', type: 'feedback.saved', matchId: state.config.matchId, expectedRevision: 0, rating: 4, text: 'I enjoyed playing with the team.', ...changes });
  return { source, runtime, repository, service, state, context, community, session, command, setNow: (time: number) => { now = time; } };
}
describe('private feedback service with actual SQLite persistence', () => {
  it('saves and updates only own entry with CAS and exact idempotency, visible only to own account and assigned manager', async () => {
    const f = await fixture(), player = f.session();
    const initial = (await f.service.view(player)).matches.find(item => item.matchId === f.state.config.matchId)!;
    expect(initial).toMatchObject({ eligible: true, canEdit: true, own: null, status: 'open' }); expect(initial).not.toHaveProperty('entries');
    const receipt = await f.service.command(player, f.command()); expect(receipt.revision).toBe(1);
    expect(await f.service.command(player, f.command())).toEqual(receipt);
    await expect(f.service.command(player, f.command({ text: 'different' }))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(f.service.command(player, f.command({ id: 'feedback-stale-0002' }))).rejects.toMatchObject({ code: 'FEEDBACK_REVISION_CONFLICT' });
    await f.service.command(player, f.command({ id: 'feedback-update-0002', expectedRevision: 1, rating: 5, text: null }));
    const own = (await f.service.view(player)).matches.find(item => item.matchId === f.state.config.matchId)!;
    expect(own.own).toMatchObject({ rating: 5, text: null, revision: 2, playerId: 'synthetic-player-01' });
    const other = await f.service.view(f.session('player-02')); expect(JSON.stringify(other)).not.toContain('I enjoyed'); expect(other.matches.every(item => !item.entries && !item.own)).toBe(true);
    const manager = await f.service.view(f.session('manager-2')); expect(manager.matches.find(item => item.matchId === f.state.config.matchId)?.entries).toHaveLength(1);
    for (const session of [f.session('admin'), f.session('spectator'), { ...f.session('manager-2'), teamId: 'synthetic-other-team' }]) await expect(f.service.view(session)).rejects.toMatchObject({ status: 404 });
    await expect(f.service.command(f.session('manager-2'), f.command())).rejects.toMatchObject({ status: 404 });
    expect(f.source.database.prepare('SELECT COUNT(*) AS count FROM match_feedback').get()?.count).toBe(1);
  });
  it('closes exactly at original London midnight, keeps entries readable and retries an already accepted command truthfully', async () => {
    const finish = Date.parse('2026-07-15T15:00:00Z'), f = await fixture(finish), player = f.session();
    f.setNow(matchFeedbackClosesAt(finish) - 1); const receipt = await f.service.command(player, f.command());
    f.setNow(matchFeedbackClosesAt(finish));
    expect(await f.service.command(player, f.command())).toEqual(receipt);
    await expect(f.service.command(player, f.command({ id: 'after-midnight-0002', expectedRevision: 1 }))).rejects.toMatchObject({ code: 'FEEDBACK_WINDOW_CLOSED' });
    expect((await f.service.view(player)).matches.find(item => item.matchId === f.state.config.matchId)).toMatchObject({ status: 'closed', canEdit: false, own: { revision: 1 } });
  });
  it('refuses bench-only, untrusted completion, contradicted corrections and revoked/relinked accounts without deleting accepted feedback', async () => {
    const f = await fixture(), player = f.session(); await f.service.command(player, f.command());
    const benchState = structuredClone(f.state); benchState.intervals = benchState.intervals.filter(interval => interval.playerId !== 'synthetic-player-08');
    f.context.playedPlayerIds = f.context.playedPlayerIds.filter(id => id !== 'synthetic-player-08');
    f.source.database.prepare('UPDATE matches SET state_json=? WHERE id=?').run(JSON.stringify(benchState), benchState.config.matchId);
    f.source.saveDocument(player.teamId, player.seasonId, 'community', f.community);
    await expect(f.service.command(f.session('player-08'), f.command({ id: 'bench-only-request' }))).rejects.toMatchObject({ status: 404 });
    f.context.finishQuality = 'review_required'; f.source.saveDocument(player.teamId, player.seasonId, 'community', f.community);
    await expect(f.service.command(player, f.command({ id: 'untrusted-request', expectedRevision: 1 }))).rejects.toMatchObject({ code: 'FEEDBACK_FINISH_UNVERIFIED' });
    expect((await f.service.view(player)).matches.find(item => item.matchId === f.state.config.matchId)).toMatchObject({ status: 'review_required', canEdit: false, own: { revision: 1 } });
    f.context.finishQuality = 'trusted'; f.source.saveDocument(player.teamId, player.seasonId, 'community', f.community);
    const changed = structuredClone(f.state); changed.intervals = changed.intervals.filter(interval => interval.playerId !== 'synthetic-player-01');
    f.source.database.prepare('UPDATE matches SET state_json=? WHERE id=?').run(JSON.stringify(changed), changed.config.matchId);
    await expect(f.service.command(player, f.command({ id: 'corrected-request', expectedRevision: 1 }))).rejects.toMatchObject({ code: 'FEEDBACK_FINISH_UNVERIFIED' });
    f.source.database.prepare("UPDATE memberships SET revoked_at=? WHERE account_id=? AND role='player'").run(Date.now(), player.principal.accountId);
    await expect(f.service.view(player)).rejects.toMatchObject({ status: 404 });
    await expect(f.service.command(player, f.command())).rejects.toMatchObject({ status: 404 });
    expect(f.source.database.prepare('SELECT COUNT(*) AS count FROM match_feedback').get()?.count).toBe(1);
  });
  it('rolls feedback and receipt back together when durable receipt saving fails', async () => {
    const f = await fixture();
    f.source.database.exec("CREATE TRIGGER refuse_feedback_receipt BEFORE INSERT ON match_feedback_receipts BEGIN SELECT RAISE(ABORT,'receipt save failed'); END");
    await expect(f.service.command(f.session(), f.command())).rejects.toThrow('receipt save failed');
    expect(f.source.database.prepare('SELECT COUNT(*) AS count FROM match_feedback').get()?.count).toBe(0);
    expect(f.source.database.prepare('SELECT COUNT(*) AS count FROM match_feedback_receipts').get()?.count).toBe(0);
  });
  it('rejects expiry during an awaited read rather than accepting using the earlier window check', async () => {
    const finish = Date.parse('2026-07-15T15:00:00Z'), f = await fixture(finish);
    const read = f.repository.entries.bind(f.repository);
    f.repository.entries = async (...args) => { const rows = await read(...args); f.setNow(matchFeedbackClosesAt(finish)); return rows; };
    await expect(f.service.command(f.session(), f.command())).rejects.toMatchObject({ code: 'FEEDBACK_WINDOW_CLOSED' });
    expect(f.source.database.prepare('SELECT COUNT(*) AS count FROM match_feedback').get()?.count).toBe(0);
  });
  it('hides the original player entry/receipt after relinking and rejects ambiguous player bindings', async () => {
    const f = await fixture(), player = f.session(); await f.service.command(player, f.command());
    f.source.database.prepare("UPDATE memberships SET player_id='synthetic-player-02' WHERE account_id=? AND role='player'").run(player.principal.accountId);
    expect(JSON.stringify(await f.service.view(player))).not.toContain('I enjoyed playing');
    await expect(f.service.command(player, f.command())).rejects.toMatchObject({ code: 'FEEDBACK_REVISION_CONFLICT' });
    const memberships = await f.runtime.memberships();
    f.runtime.memberships = async () => [...memberships, { accountId: player.principal.accountId, teamId: player.teamId, seasonId: player.seasonId, role: 'player', playerId: 'synthetic-player-03' }];
    await expect(f.service.view(player)).rejects.toMatchObject({ status: 404 });
    expect(f.source.database.prepare('SELECT COUNT(*) AS count FROM match_feedback').get()?.count).toBe(1);
  });
});
