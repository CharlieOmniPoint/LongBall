import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { assertDemoScenarioOptions, createApi } from './server';
import { SYNTHETIC_IDS } from './store';
import type { getCommunityView } from '../../../packages/application/src/community';
import type { recordsServiceView } from '../../../packages/application/src/records-service';
import { UNAPPROVED_SHARING_POLICY } from '../../../packages/application/src/access';

const directory = await mkdtemp(join(tmpdir(), 'longball-generated-demo-'));
const servers: ReturnType<typeof createApi>[] = [];
afterEach(async () => { for (const api of servers.splice(0)) await api.close(); vi.unstubAllEnvs(); });
const mediaModule = new URL('../../../infra/cloud-preview/seed-demo-media.mjs', import.meta.url).href;
const now = Date.parse('2026-10-21T18:00:00Z');
async function start(demoScenario: boolean, scanner = false) {
  const media = await import(mediaModule);
  const allowed = new Set(['pitch', 'cones', 'ball'].map(kind => createHash('sha256').update(media.demoArtwork(kind)).digest('hex')));
  const api = createApi({ databasePath: ':memory:', mediaDirectory: join(directory, randomUUID()), syntheticAuth: true, demoScenario, now: () => now,
    ...(scanner ? { mediaScanner: { scan: async (_bytes: Buffer, context: { sha256: string }) => ({ verdict: allowed.has(context.sha256) ? 'clean' as const : 'rejected' as const, engine: 'exact-generated-artwork-test-fixture-only' }) } } : {}),
  });
  servers.push(api); await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const get = async <T = Record<string, unknown>>(path: string, role = 'spectator', token = role === 'player' ? 'synthetic-account-player-01' : 'synthetic-spectator') => {
    const response = await fetch(base + path, { headers: { Authorization: `Bearer ${token}`, 'X-Longball-Role': role } });
    expect(response.status).toBe(200); return response.json() as Promise<T>;
  };
  return { api, base, get, media };
}

describe('explicit generated demo scenario boundary', () => {
  it('refuses demo-sharing authority without synthetic auth and in a production process', () => {
    expect(() => assertDemoScenarioOptions({ demoScenario: true, syntheticAuth: false })).toThrow(/isolated synthetic/);
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => assertDemoScenarioOptions({ demoScenario: true, syntheticAuth: true })).toThrow(/outside production/);
    expect(() => assertDemoScenarioOptions({ syntheticAuth: false })).not.toThrow();
  });

  it('exposes sample scores only with explicit demo opt-in and leaves the real unapproved policy unchanged', async () => {
    const normal = await start(false), demo = await start(true);
    const path = `/v1/matches/${SYNTHETIC_IDS.matchId}`;
    expect(await normal.get(path)).toMatchObject({ score: null, sharingRestricted: true });
    const publicMatch = await demo.get(path);
    expect(publicMatch).toMatchObject({ score: { for: 0, against: 0 }, sharingRestricted: false, sharingPolicyVersion: 'demo-simulated-scores-v1', opponent: 'Maple FC' });
    for (const forbidden of ['state', 'ownRecord', 'attendance', 'intervals', 'controller']) expect(publicMatch).not.toHaveProperty(forbidden);
    expect(UNAPPROVED_SHARING_POLICY).toMatchObject({ approvedBy: null, approvedAt: null, shareScores: false, shareDerivedResults: false });
    const acquired = await fetch(`${demo.base}${path}/controller`, { method: 'POST', headers: { Authorization: 'Bearer synthetic-manager-2', 'Content-Type': 'application/json', 'X-Api-Contract-Version': 'longball.events/1.1', 'Idempotency-Key': 'demo-controller-profile-boundary' }, body: JSON.stringify({ deviceId: 'demo-controller-boundary' }) });
    expect(acquired.status).toBe(200);
    const snapshot = await demo.get<{ state: { config: { fixture: { kickoff: string }; players: Record<string, unknown>[] } } }>(`${path}/download?deviceId=demo-controller-boundary`, 'manager', 'synthetic-manager-2');
    expect(snapshot.state.config.fixture.kickoff).toBe('10:00');
    expect(snapshot.state.config.players[0].displayName).toBe('Oliver Bennett');
    for (const key of ['initials', 'shirtNumber', 'foot']) expect(snapshot.state.config.players[0]).not.toHaveProperty(key);

    const community = await demo.get<ReturnType<typeof getCommunityView>>(`/v1/teams/${SYNTHETIC_IDS.teamId}/community?seasonId=${SYNTHETIC_IDS.seasonId}`, 'player');
    expect(community.matches[0]).toMatchObject({ sharingAllowed: true, mayVote: true });
    expect(community.matches[0].candidates.some((item: { label: string }) => item.label === 'Noah Patel')).toBe(true);
    const reports = await demo.get<ReturnType<typeof recordsServiceView>>(`/v1/teams/${SYNTHETIC_IDS.teamId}/records?seasonId=${SYNTHETIC_IDS.seasonId}`);
    expect(reports.results.totals).not.toBeNull();
    expect(reports.matches.some((item: { score: unknown }) => item.score !== null)).toBe(true);
  });

  it('seeds gallery derivatives through real processing and keeps player submissions private until review', async () => {
    const { base, get, media } = await start(true, true);
    expect(await media.seedDemoMedia(base)).toMatchObject({ processed: 3, publishedExamples: 2, pendingPlayerExamples: 1, throughNormalMediaPipeline: true });
    const view = await get<ReturnType<typeof getCommunityView>>(`/v1/teams/${SYNTHETIC_IDS.teamId}/community?seasonId=${SYNTHETIC_IDS.seasonId}`);
    expect(view.gallery).toHaveLength(2); expect(view.reviewQueue).toEqual([]); expect(view.submissions).toEqual([]);
    const image = await fetch(`${base}/v1/teams/${SYNTHETIC_IDS.teamId}/media/photos/${view.gallery[0].id}/thumbnail?seasonId=${SYNTHETIC_IDS.seasonId}`, { headers: { Authorization: 'Bearer synthetic-spectator', 'X-Longball-Role': 'spectator' } });
    expect(image.status).toBe(200); expect(image.headers.get('content-type')).toBe('image/jpeg'); expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(100);
    const manager = await get<ReturnType<typeof getCommunityView>>(`/v1/teams/${SYNTHETIC_IDS.teamId}/community?seasonId=${SYNTHETIC_IDS.seasonId}`, 'manager', 'synthetic-manager-1');
    expect(manager.reviewQueue).toHaveLength(1);
    const pending = await fetch(`${base}/v1/teams/${SYNTHETIC_IDS.teamId}/media/photos/${manager.reviewQueue[0].id}/display?seasonId=${SYNTHETIC_IDS.seasonId}`, { headers: { Authorization: 'Bearer synthetic-spectator' } });
    expect(pending.status).toBe(404);
    expect(await media.seedDemoMedia(base)).toMatchObject({ processed: 0 });
  });

  it('retains failed private uploads when the scanner is unavailable and refuses to seed through a non-demo service', async () => {
    const demo = await start(true);
    await expect(demo.media.seedDemoMedia(demo.base)).rejects.toThrow(/HTTP 503/);
    expect((await demo.get<ReturnType<typeof getCommunityView>>(`/v1/teams/${SYNTHETIC_IDS.teamId}/community?seasonId=${SYNTHETIC_IDS.seasonId}`)).gallery).toEqual([]);
    const normal = await start(false);
    await expect(normal.media.seedDemoMedia(normal.base)).rejects.toThrow(/explicit generated-demo/);
  });
});

// All generated objects and temporary media remain isolated to this test process.
afterAll(() => rm(directory, { recursive: true, force: true }));
