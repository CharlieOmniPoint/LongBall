import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createApi } from './server';
import { EVENT_CONTRACT_VERSION, SYNTHETIC_IDS } from './store';
import type { FixtureDraft, PreparationState } from '../../../packages/application/src/preparation';
import type { MatchConfig } from '../../../packages/domain/src/index';

const rootPath = `/v1/teams/${SYNTHETIC_IDS.teamId}/matches?seasonId=${SYNTHETIC_IDS.seasonId}`;
describe('API04/DS13 real HTTP scoped keyset match pages', () => {
  it('selects active games before pagination, binds the filter into cursors and retains audience restrictions', async () => {
    const api = createApi({ databasePath: ':memory:', syntheticAuth: true });
    const config = JSON.parse(api.store.match(SYNTHETIC_IDS.matchId).config_json) as MatchConfig;
    for (let i = 0; i < 105; i++) api.store.insertMatch({ ...config, matchId: `inactive-${i}` }, SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId);
    for (const [id, status] of [['z-active-a', 'first_half_running'], ['z-active-b', 'half_time'], ['z-active-c', 'second_half_paused']] as const) {
      api.store.insertMatch({ ...config, matchId: id }, SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId);
      // Only read selection is under test; these fixtures do not claim recorded clock/event proof.
      api.store.database.prepare("UPDATE matches SET state_json=json_set(state_json,'$.status',?) WHERE id=?").run(status, id);
    }
    await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
    const read = async (suffix: string, token = 'synthetic-manager-2', role = 'manager') => {
      const response = await fetch(base + rootPath + suffix, { headers: { Authorization: `Bearer ${token}`, 'X-Longball-Role': role } });
      return { status: response.status, body: await response.json() as { items: { matchId: string; audience: string; state?: unknown; score?: unknown }[]; nextCursor: string | null } };
    };
    try {
      const first = await read('&status=active&limit=1');
      expect(first.status).toBe(200); expect(first.body.items.map(item => item.matchId)).toEqual(['z-active-a']);
      const cursor = encodeURIComponent(first.body.nextCursor!);
      const rest = await read(`&status=active&limit=100&cursor=${cursor}`);
      expect(rest.body.items.map(item => item.matchId)).toEqual(['z-active-b', 'z-active-c']); expect(rest.body.nextCursor).toBeNull();
      expect((await read(`&cursor=${cursor}`)).status).toBe(400);
      const all = await read('&limit=1');
      expect((await read(`&status=active&cursor=${all.body.nextCursor}`)).status).toBe(400);
      for (const suffix of ['&status=', '&status=completed', '&status=active&status=active']) expect((await read(suffix)).status).toBe(400);
      const child = await read('&status=active', 'synthetic-account-player-01', 'player');
      expect(child.status).toBe(200); expect(child.body.items).toHaveLength(3);
      expect(child.body.items.every(item => item.audience === 'player' && item.state === undefined && item.score === null)).toBe(true);
      expect((await read('&status=active', 'synthetic-admin', 'administrator')).status).toBe(404);
    } finally { api.server.closeAllConnections(); await api.close(); }
  });
  it('discovers every accepted match beyond100, bounds pages, preserves replay positions and validates query/cursor scope', async () => {
    const api = createApi({ databasePath: ':memory:', syntheticAuth: true, now: () => 1_800_000_000_000 });
    const config = JSON.parse(api.store.match(SYNTHETIC_IDS.matchId).config_json) as MatchConfig;
    const expected: string[] = [SYNTHETIC_IDS.matchId];
    for (let i = 0; i < 107; i++) { const matchId = `page-match-${String(i).padStart(3, '0')}`; expected.push(matchId); api.store.insertMatch({ ...config, matchId }, SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId); }
    for (let i = 0; i < 30; i++) api.store.insertMatch({ ...config, matchId: `foreign-${i}` }, 'synthetic-other-team', SYNTHETIC_IDS.seasonId);
    api.store.database.prepare('INSERT INTO memberships(account_id,team_id,season_id,role) VALUES(?,?,?,?)').run('synthetic-account-manager-2', 'synthetic-other-team', SYNTHETIC_IDS.seasonId, 'manager');
    api.store.database.prepare('INSERT INTO memberships(account_id,team_id,season_id,role) VALUES(?,?,?,?)').run('synthetic-account-manager-2', SYNTHETIC_IDS.teamId, 'another-season', 'manager');
    await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
    const call = async (path = rootPath, token = 'synthetic-manager-2', role = 'manager') => {
      const response = await fetch(base + path, { headers: { Authorization: `Bearer ${token}`, 'X-Longball-Role': role } });
      return { status: response.status, body: await response.json() as { items: { matchId: string; audience: string; state?: unknown; score?: unknown }[]; nextCursor: string | null; serverTime: string; code?: string } };
    };
    try {
      const first = await call(); expect(first.status).toBe(200); expect(first.body.items).toHaveLength(25); expect(first.body.nextCursor).toBeTypeOf('string'); expect(first.body.serverTime).toBe(new Date(1_800_000_000_000).toISOString());
      const found = first.body.items.map(item => item.matchId); let cursor = first.body.nextCursor;
      while (cursor) { const page = await call(`${rootPath}&cursor=${encodeURIComponent(cursor)}`); expect(page.status).toBe(200); expect(page.body.items.length).toBeLessThanOrEqual(25); found.push(...page.body.items.map(item => item.matchId)); cursor = page.body.nextCursor; }
      expect(found).toEqual(expected.sort()); expect(new Set(found).size).toBe(108); expect(found).not.toContain('foreign-0');
      const hundred = await call(`${rootPath}&limit=100`); expect(hundred.body.items).toHaveLength(100); expect(hundred.body.nextCursor).toBeTypeOf('string');
      const eight = await call(`${rootPath}&cursor=${hundred.body.nextCursor}&limit=100`); expect(eight.body.items).toHaveLength(8); expect(eight.body.nextCursor).toBeNull();
      const repeated = await call(`${rootPath}&cursor=${first.body.nextCursor}`); expect(repeated.body.items.map(item => item.matchId)).toEqual(expected.slice(25, 50));
      // A new row behind the immutable boundary does not shift the next page as OFFSET would.
      api.store.insertMatch({ ...config, matchId: 'page-match-000-a' }, SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId);
      expect((await call(`${rootPath}&cursor=${first.body.nextCursor}`)).body.items).toEqual(repeated.body.items);
      for (const suffix of ['&limit=0', '&limit=101', '&limit=1.5', '&limit=025', '&limit=', '&limit=1&limit=2', '&sort=id', '&filter=all', '&cursor=', '&cursor=bad*cursor', '&cursor=Zm9v']) expect((await call(rootPath + suffix)).status, suffix).toBe(400);
      expect((await call(`${rootPath}&cursor=${first.body.nextCursor}`, 'synthetic-manager-3')).status).toBe(400);
      expect((await call(`/v1/teams/synthetic-other-team/matches?seasonId=${SYNTHETIC_IDS.seasonId}&cursor=${first.body.nextCursor}`)).status).toBe(400);
      expect((await call(`/v1/teams/${SYNTHETIC_IDS.teamId}/matches?seasonId=another-season&cursor=${first.body.nextCursor}`)).status).toBe(400);
      expect((await call(`${rootPath}&cursor=${first.body.nextCursor}`, 'synthetic-account-player-01', 'player')).status).toBe(400);
      const child = await call(`${rootPath}&limit=100`, 'synthetic-account-player-01', 'player'); expect(child.status).toBe(200); expect(child.body.items).toHaveLength(100); expect(child.body.items.every(item => item.audience === 'player' && item.state === undefined && item.score === null)).toBe(true);
      expect((await call(rootPath, 'synthetic-admin', 'administrator')).status).toBe(404);
      api.store.database.prepare('UPDATE memberships SET revoked_at=? WHERE account_id=? AND team_id=? AND role=?').run(1_800_000_000_000, 'synthetic-account-manager-2', SYNTHETIC_IDS.teamId, 'manager');
      expect((await call(`${rootPath}&cursor=${first.body.nextCursor}`)).status).toBe(404);
    } finally { api.server.closeAllConnections(); await api.close(); }
  });
  it('continues after a legal punctuated match created through the actual preparation HTTP commands', async () => {
    const api = createApi({ databasePath: ':memory:', syntheticAuth: true });
    await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
    const headers = { Authorization: 'Bearer synthetic-manager-2', 'X-Longball-Role': 'manager' };
    const preparationPath = `/v1/teams/${SYNTHETIC_IDS.teamId}/preparation?seasonId=${SYNTHETIC_IDS.seasonId}`;
    try {
      let state = await (await fetch(base + preparationPath, { headers })).json() as PreparationState;
      const source = state.fixtures[0], matchId = 'fixture.preview:round-one.v2';
      const fixture: FixtureDraft = { id: matchId, seasonId: source.seasonId, opponent: 'Punctuation boundary fixture', playedDate: source.playedDate, kickoff: source.kickoff, arrival: source.arrival, venue: source.venue, homeAway: source.homeAway, format: source.format, plannedHalfDurationMs: source.plannedHalfDurationMs };
      const mutate = async (command: object) => {
        const id = randomUUID();
        const reply = await fetch(base + preparationPath, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-Api-Contract-Version': EVENT_CONTRACT_VERSION, 'Idempotency-Key': id }, body: JSON.stringify({ command: { ...command, id, expectedRevision: state.revision } }) });
        const body = await reply.json(); expect(reply.status, JSON.stringify(body)).toBe(200); state = body as PreparationState;
      };
      await mutate({ type: 'fixture.saved', fixture });
      await mutate({ type: 'fixture.selection_saved', fixtureId: matchId, selectedProfileIds: source.selectedProfileIds });
      await mutate({ type: 'fixture.prepared', fixtureId: matchId, formationId: state.formations.find(row => row.format === source.format)!.id });
      expect(api.store.match(matchId).id).toBe(matchId);
      const firstReply = await fetch(base + rootPath + '&limit=1', { headers });
      const first = await firstReply.json() as { items: { matchId: string }[]; nextCursor: string | null };
      expect(firstReply.status).toBe(200); expect(first.items[0].matchId).toBe(matchId); expect(first.nextCursor).toBeTypeOf('string');
      const nextReply = await fetch(base + rootPath + `&limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`, { headers });
      const next = await nextReply.json() as { items: { matchId: string }[]; nextCursor: string | null };
      expect(nextReply.status).toBe(200); expect(next.items.map(item => item.matchId)).toEqual([SYNTHETIC_IDS.matchId]); expect(next.nextCursor).toBeNull();
    } finally { api.server.closeAllConnections(); await api.close(); }
  });

});
