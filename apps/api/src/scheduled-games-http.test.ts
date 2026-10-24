import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { createApi } from './server';
import { createPostgresApi } from './postgres-server';
import { PostgresStore } from './postgres-store';
import { PgMediaService } from './postgres-media';
import { PostgresActivationService } from './postgres-activation';
import { applyRuntimeGrants } from './runtime-grants';
import { EVENT_CONTRACT_VERSION, SYNTHETIC_IDS } from './store';
import type { ManagedPreparationState, ScheduledGameCommand, ScheduledGameManagementDto } from '../../../packages/application/src/fixture-management';
import type { CommunityState } from '../../../packages/application/src/community';
import type { MatchState } from '../../../packages/domain/src';
import type { MatchFeedbackReceipt, MatchFeedbackView } from '../../../packages/application/src/match-feedback';
import type { PlayerStatsDto } from '../../../packages/application/src/player-stats';
import { autoFillLineup } from '../../../packages/application/src/lineup-autofill';
import { previewLineupTemplate } from '../../../packages/application/src/lineup-templates';
import { assertTeamOverviewDto, type TeamOverviewDto } from '../../../packages/application/src/team-overview-service';

const configuredUrl = process.env.LONGBALL_POSTGRES_TEST_URL;
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const team = `/v1/teams/${SYNTHETIC_IDS.teamId}`, season = `?seasonId=${SYNTHETIC_IDS.seasonId}`;
const path = `${team}/scheduled-games${season}`, matchPath = `/v1/matches/${SYNTHETIC_IDS.matchId}`;
const tokens = { manager: 'synthetic-account-manager-2', administrator: 'synthetic-account-admin', player: 'synthetic-account-player-01', spectator: 'synthetic-account-spectator' };
type Role = keyof typeof tokens;
async function start(backend: 'sqlite' | 'postgres', now: () => number = Date.now) {
  const directory = mkdtempSync(join(tmpdir(), 'longball-scheduled-games-'));
  cleanups.push(async () => rmSync(directory, { recursive: true, force: true }));
  let owner: PostgresStore | undefined, runtimeUrl: string | undefined;
  let api: ReturnType<typeof createApi> | Awaited<ReturnType<typeof createPostgresApi>>;
  if (backend === 'postgres') {
    const admin = new Pool({ connectionString: configuredUrl, max: 1 }), suffix = randomUUID().replaceAll('-', '');
    const database = `lb_schedule_${suffix}`, apiRole = `lb_schedule_api_${suffix}`, workerRole = `lb_schedule_worker_${suffix}`;
    await admin.query(`CREATE DATABASE "${database}"`);
    cleanups.push(async () => { await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); for (const role of [apiRole, workerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`); await admin.end(); });
    for (const role of [apiRole, workerRole]) await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    const ownerUrl = new URL(configuredUrl!); ownerUrl.pathname = `/${database}`;
    owner = await PostgresStore.open(ownerUrl.href, now); cleanups.push(() => owner!.close()); await owner.seedSynthetic({ demoSharing: true });
    const media = await PgMediaService.open({ directory: join(directory, 'media'), database: owner.db }); cleanups.push(() => media.close());
    await new PostgresActivationService({ store: owner }).initialize();
    await applyRuntimeGrants(owner.db, { apiRole, workerRole });
    const url = new URL(ownerUrl); url.username = apiRole; url.password = ''; runtimeUrl = url.href;
    api = await createPostgresApi({ connectionString: runtimeUrl, databasePath: join(directory, 'unused.sqlite'), mediaDirectory: join(directory, 'media'), migrationMode: 'verify', syntheticAuth: true, demoScenario: true, seedSynthetic: false, now });
  } else api = createApi({ databasePath: join(directory, 'api.sqlite'), syntheticAuth: true, demoScenario: true, now });
  const open = async (value: typeof api) => { cleanups.push(async () => { value.server.closeAllConnections(); await value.close(); }); await new Promise<void>(resolve => value.server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${(value.server.address() as AddressInfo).port}`; };
  const base = await open(api);
  const call = async <T = Record<string, unknown>>(route: string, role: Role = 'manager', body?: unknown, options: { key?: string; token?: string; base?: string } = {}) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${options.token ?? tokens[role]}`, 'X-Longball-Role': role };
    if (body !== undefined) Object.assign(headers, { 'Content-Type': 'application/json', 'X-Api-Contract-Version': EVENT_CONTRACT_VERSION, 'Idempotency-Key': options.key ?? randomUUID() });
    const response = await fetch((options.base ?? base) + route, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as T };
  };
  const source = owner ?? (api as ReturnType<typeof createApi>).store;
  const read = () => source.document<ManagedPreparationState>(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'preparation');
  const command = async (type: ScheduledGameCommand['type'], fixtureId: string, role: Role = 'manager', patch: Partial<ScheduledGameCommand> = {}) => {
    const current = await read(), command: ScheduledGameCommand = { id: randomUUID(), expectedRevision: current.revision, fixtureId, type, reason: 'Pitch unavailable for the scheduled game', confirm: true, ...patch };
    return { command, reply: await call<ScheduledGameManagementDto & { code?: string }>(path, role, { command }, { key: command.id }) };
  };
  const otherApi = async () => {
    if (!runtimeUrl) return base;
    const other = await createPostgresApi({ connectionString: runtimeUrl, databasePath: join(directory, 'unused-other.sqlite'), mediaDirectory: join(directory, 'media'), migrationMode: 'verify', syntheticAuth: true, demoScenario: true, seedSynthetic: false, now });
    return open(other);
  };
  return { api, owner, source, call, read, command, otherApi };
}
for (const backend of ['sqlite', 'postgres'] as const) describe.skipIf(backend === 'postgres' && !configuredUrl)(`scoped schedule, stats and feedback actual ${backend} HTTP`, () => {
  it('grants staff metadata without private roster and keeps stats and feedback role boundaries separate', async () => {
    const { call } = await start(backend);
    for (const role of ['manager', 'administrator'] as const) {
      const reply = await call<ScheduledGameManagementDto>(path, role);
      expect(reply.status).toBe(200); expect(reply.body.fixtures).toHaveLength(4);
      for (const field of ['profiles', 'selectedProfileIds', 'attendance', 'responses', 'synthetic-player-01']) expect(JSON.stringify(reply.body)).not.toContain(field);
    }
    expect((await call(path, 'player')).status).toBe(404); expect((await call(path, 'spectator')).status).toBe(404);
    expect((await call(path, 'administrator', undefined, { token: tokens.manager })).status).toBe(404);
    for (const role of ['manager', 'administrator', 'player'] as const) {
      const stats = await call<PlayerStatsDto>(`${team}/player-stats${season}`, role);
      expect(stats.status, JSON.stringify(stats.body)).toBe(200);
      expect(stats.body.kind).toBe(role === 'player' ? 'own-player-stats' : 'team-player-stats');
      for (const field of ['attendance', 'preferences', 'feedback', 'injury', 'selectedProfileIds']) expect(JSON.stringify(stats.body)).not.toContain(field);
      if (role === 'player') { expect(JSON.stringify(stats.body)).toContain('synthetic-player-01'); expect(JSON.stringify(stats.body)).not.toContain('synthetic-player-02'); }
    }
    expect((await call(`${team}/player-stats${season}`, 'spectator')).status).toBe(404);
    expect((await call(`${team}/preparation${season}`, 'administrator')).status).toBe(404);
    expect((await call(`${team}/records${season}`, 'administrator')).status).toBe(404);
    expect((await call(`${team}/match-feedback${season}`, 'administrator')).status).toBe(404);
    expect((await call(`${team}/match-feedback${season}`, 'spectator')).status).toBe(404);
  });
  it('keeps cancellation visible, blocks all recording paths and protects claimed history from the alternate status route', async () => {
    const { call, source, read, command } = await start(backend);
    const before = await source.match(SYNTHETIC_IDS.matchId);
    const cancelled = await command('fixture.cancelled', SYNTHETIC_IDS.matchId);
    expect(cancelled.reply.status, JSON.stringify(cancelled.reply.body)).toBe(200);
    expect(cancelled.reply.body.fixtures.find(item => item.id === SYNTHETIC_IDS.matchId)).toMatchObject({ status: 'cancelled', canCancel: false, canDelete: true });
    expect(await source.match(SYNTHETIC_IDS.matchId)).toEqual(before);
    expect((await call(matchPath, 'manager', undefined, { token: 'synthetic-account-other-manager' })).status).toBe(404);
    const community = await source.document<CommunityState>(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'community');
    for (const grant of community.grants.filter(item => item.accountId === tokens.spectator)) grant.revokedAtMs = Date.now();
    await source.saveDocument(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'community', community);
    expect((await call(matchPath, 'spectator')).status).toBe(404);
    for (const [route, body] of [[`${matchPath}/download?deviceId=cancelled-phone`, undefined], [`${matchPath}/controller`, { deviceId: 'cancelled-phone' }], [`${matchPath}/events`, { events: [] }]] as const) expect((await call(route, 'manager', body)).status).toBe(409);
    const preparation = await read(), restore = { id: randomUUID(), expectedRevision: preparation.revision, type: 'fixture.status_changed', fixtureId: SYNTHETIC_IDS.matchId, status: 'scheduled' };
    expect((await call(`${team}/preparation${season}`, 'manager', { command: restore })).status).toBe(200);
    expect((await call(`${matchPath}/controller`, 'manager', { deviceId: 'claimed-phone' })).status).toBe(200);
    expect((await command('fixture.cancelled', SYNTHETIC_IDS.matchId, 'administrator')).reply.status).toBe(409);
    const current = await read();
    expect((await call(`${team}/preparation${season}`, 'manager', { command: { ...restore, id: randomUUID(), expectedRevision: current.revision, status: 'cancelled' } })).status).toBe(409);
    expect((await read()).fixtures.find(item => item.id === SYNTHETIC_IDS.matchId)?.status).toBe('scheduled');
  });
  it('deletes only an unplayed schedule item, retains private tombstone and canonical rows, and rejects resurrection or key substitution', async () => {
    const { call, source, read, command } = await start(backend), id = 'synthetic-roma-oak-2026-10-31';
    const original = (await read()).fixtures.find(item => item.id === id)!;
    const canonical = await source.match(id), removed = await command('fixture.deleted', id, 'administrator');
    expect(removed.reply.status, JSON.stringify(removed.reply.body)).toBe(200);
    expect(removed.reply.body.fixtures.some(item => item.id === id)).toBe(false);
    expect((await read()).fixtureManagement?.tombstones[0].fixture).toEqual(original);
    expect(await source.match(id)).toEqual(canonical);
    expect((await call<{ items: { matchId: string }[] }>(`${team}/matches${season}`)).body.items.some(item => item.matchId === id)).toBe(false);
    expect((await call(`/v1/matches/${id}/download?deviceId=deleted-phone`)).status).toBe(409);
    expect((await call(`/v1/matches/${id}/controller`, 'manager', { deviceId: 'deleted-phone' })).status).toBe(409);
    expect((await call(path, 'administrator', { command: removed.command }, { key: removed.command.id })).status).toBe(200);
    expect((await call(path, 'administrator', { command: { ...removed.command, reason: 'Different reviewed reason' } }, { key: removed.command.id })).status).toBe(409);
    expect((await call(path, 'administrator', { command: { ...removed.command, id: randomUUID() } }, { key: removed.command.id })).status).toBe(400);
    const { selectedProfileIds: _selected, responses: _responses, attendance: _attendance, history: _history, status: _status, ...fixture } = original;
    expect((await call(`${team}/preparation${season}`, 'manager', { command: { id: randomUUID(), expectedRevision: (await read()).revision, type: 'fixture.saved', fixture } })).status).toBe(409);
    expect((await command('fixture.deleted', 'synthetic-history-oak', 'administrator')).reply.status).toBe(409);
  });
  it('serializes cancellation against an independent controller contender so both cannot succeed', async () => {
    const { call, read, otherApi } = await start(backend), second = await otherApi();
    const command: ScheduledGameCommand = { id: randomUUID(), expectedRevision: (await read()).revision, fixtureId: SYNTHETIC_IDS.matchId, type: 'fixture.deleted', reason: 'Fixture cannot go ahead', confirm: true };
    const [cancel, control] = await Promise.all([call(path, 'administrator', { command }, { key: command.id }), call(`${matchPath}/controller`, 'manager', { deviceId: 'simultaneous-recorder' }, { base: second })]);
    expect([cancel.status, control.status].sort()).toEqual([200, 409]);
    const remaining = (await read()).fixtures.some(item => item.id === SYNTHETIC_IDS.matchId);
    expect(remaining).toBe(control.status === 200);
  });
  it('submits private own feedback through exact durable command receipts without exposing it to other players, stats or administrators', async () => {
    const { call, source, owner } = await start(backend), matchId = 'synthetic-history-oak';
    const stored = await source.match(matchId), state = JSON.parse(stored.state_json) as MatchState;
    const completedAt = Date.now() - 1000; state.completedAtMs = completedAt;
    const community = await source.document<CommunityState>(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'community');
    const context = community.matches.find(item => item.id === matchId)!; context.actualFullTimeAtMs = completedAt;
    if (owner) await owner.execute('UPDATE matches SET state_json=$1 WHERE id=$2', [JSON.stringify(state), matchId]);
    else (source as ReturnType<typeof createApi>['store']).database.prepare('UPDATE matches SET state_json=? WHERE id=?').run(JSON.stringify(state), matchId);
    await source.saveDocument(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'community', community);
    const route = `${team}/match-feedback${season}`, command = { id: randomUUID(), type: 'feedback.saved', matchId, expectedRevision: 0, rating: 4, text: 'I kept looking for space.' };
    const first = await call<MatchFeedbackReceipt>(route, 'player', { command }, { key: command.id });
    expect(first.status, JSON.stringify(first.body)).toBe(200); expect(first.body.revision).toBe(1);
    expect((await call(route, 'player', { command }, { key: command.id })).body).toEqual(first.body);
    expect((await call(route, 'player', { command: { ...command, text: 'Changed under old identity' } }, { key: command.id })).status).toBe(409);
    const own = await call<MatchFeedbackView>(route, 'player'); expect(own.body.matches.find(item => item.matchId === matchId)?.own?.text).toBe(command.text);
    const other = await call<MatchFeedbackView>(route, 'player', undefined, { token: 'synthetic-account-player-02' }); expect(JSON.stringify(other.body)).not.toContain(command.text);
    const manager = await call<MatchFeedbackView>(route, 'manager'); expect(manager.body.matches.find(item => item.matchId === matchId)?.entries?.[0].text).toBe(command.text);
    expect((await call(route, 'administrator')).status).toBe(404); expect((await call(route, 'manager', { command }, { key: command.id })).status).toBe(404);
    expect((await call(route, 'player', { command: { ...command, id: randomUUID(), playerId: 'synthetic-player-02' } })).status).toBe(400);
    const stats = await call(`${team}/player-stats${season}`, 'administrator'); expect(stats.status).toBe(200); expect(JSON.stringify(stats.body)).not.toContain(command.text);
  });
  it('includes a fresh unprepared game for all four current roles without exposing roster, feedback or scoring', async () => {
    const { call, read, source, command } = await start(backend);
    const current = await read(), fixtureId = 'csv.fixture:2026-27.01';
    const fixture = { id: fixtureId, seasonId: SYNTHETIC_IDS.seasonId, opponent: 'Cedar Athletic', playedDate: '2026-11-07', kickoff: null, arrival: null, venue: 'North pitch', homeAway: 'home', format: 7, plannedHalfDurationMs: 1_500_000 };
    expect((await call(`${team}/preparation${season}`, 'manager', { command: { id: randomUUID(), expectedRevision: current.revision, type: 'fixture.saved', fixture } })).status).toBe(200);
    for (const role of ['manager', 'administrator', 'player', 'spectator'] as const) {
      const overview = await call<TeamOverviewDto>(`${team}/team-overview${season}`, role);
      expect(overview.status, JSON.stringify(overview.body)).toBe(200);
      expect(() => assertTeamOverviewDto(overview.body, { teamId: SYNTHETIC_IDS.teamId, seasonId: SYNTHETIC_IDS.seasonId })).not.toThrow();
      expect(overview.body.games.find(game => game.id === fixtureId)).toMatchObject({ status: 'scheduled', kickoff: null, active: false });
      for (const field of ['profiles', 'attendance', 'responses', 'score', 'feedback', 'synthetic-player-01']) expect(JSON.stringify(overview.body)).not.toContain(field);
    }
    const preparation = await read();
    expect((await call(`${team}/preparation${season}`, 'manager', { command: { id: randomUUID(), expectedRevision: preparation.revision, type: 'fixture.selection_saved', fixtureId, selectedProfileIds: preparation.profiles.slice(0, 9).map(profile => profile.id) } })).status).toBe(200);
    expect((await call(`${team}/preparation${season}`, 'manager', { command: { id: randomUUID(), expectedRevision: (await read()).revision, type: 'fixture.prepared', fixtureId, formationId: 'formation-7' } })).status).toBe(200);
    expect((await command('fixture.cancelled', fixtureId)).reply.status).toBe(200);
    expect((await command('fixture.deleted', fixtureId, 'administrator')).reply.status).toBe(200);
    const community = await source.document<CommunityState>(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'community');
    for (const grant of community.grants.filter(item => item.accountId === tokens.spectator)) grant.revokedAtMs = Date.now();
    await source.saveDocument(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'community', community);
    expect((await call(`${team}/team-overview${season}`, 'spectator')).status).toBe(404);
  });
  it('saves and applies a team lineup draft without inventing check-in, then refuses template changes after control', async () => {
    const now = () => Date.parse('2026-10-24T08:00:00Z'), { call, read, source } = await start(backend, now);
    const before = await read(), formation = before.formations.find(item => item.id === 'formation-7')!, profiles = before.profiles.slice(0, 9), fixtureId = 'synthetic-roma-oak-2026-10-31';
    const filled = autoFillLineup({ slots: formation.slots.map(slot => ({ slotId: slot.id, position: slot.position })), players: profiles.map(profile => ({ id: profile.playerId, preferences: profile.preferences, eligiblePositions: profile.eligiblePositions, goalkeeperChoice: profile.preferences.indexOf('GK') + 1, available: true })) });
    expect(filled.status).toBe('complete'); if (filled.status !== 'complete') throw new Error(filled.reason);
    expect(before.snapshots).toEqual([]);
    const save = { id: randomUUID(), expectedRevision: before.revision, type: 'lineup_template.saved', templateId: 'api-team-template', expectedTemplateVersion: 0, name: 'Saturday starters', formationId: formation.id, selectedPlayerIds: profiles.map(profile => profile.playerId), allocations: filled.allocations };
    expect((await call(`${team}/preparation${season}`, 'manager', { command: save })).status).toBe(200);
    const saved = await read(), previousFixture = saved.fixtures.find(item => item.id === fixtureId)!;
    const preview = previewLineupTemplate(saved, save.templateId, fixtureId, { nowMs: now() }); expect(preview.ready).toBe(true);
    const apply = { id: randomUUID(), expectedRevision: saved.revision, type: 'lineup_template.applied', fixtureId, templateId: save.templateId, templateVersion: 1, previewKey: preview.previewKey, confirm: true };
    expect((await call(`${team}/preparation${season}`, 'manager', { command: apply })).status).toBe(200);
    const applied = (await read()).fixtures.find(item => item.id === fixtureId)!;
    expect(applied.attendance).toEqual(previousFixture.attendance); expect(applied.responses).toEqual(previousFixture.responses);
    expect(applied.lineupTemplateDraft?.allocations).toEqual(filled.allocations);
    const canonical = await source.match(fixtureId);
    expect((await call(`/v1/matches/${fixtureId}/controller`, 'manager', { deviceId: 'template-protected-controller' })).status).toBe(200);
    const current = await read(), again = previewLineupTemplate(current, save.templateId, fixtureId, { nowMs: now() });
    expect((await call(`${team}/preparation${season}`, 'manager', { command: { ...apply, id: randomUUID(), expectedRevision: current.revision, previewKey: again.previewKey } })).status).toBe(422);
    expect((await call(`${team}/preparation${season}`, 'manager', { command: { id: randomUUID(), expectedRevision: current.revision, type: 'lineup_template.cleared', fixtureId } })).status).toBe(422);
    expect(await source.match(fixtureId)).toEqual(canonical);
  });
});
