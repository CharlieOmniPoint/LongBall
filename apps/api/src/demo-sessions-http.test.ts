import { randomBytes, scryptSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_SCRYPT_OPTIONS, type DemoAccountOptions } from './demo-sessions';
import { assertDemoScenarioOptions, createApi } from './server';
import { SYNTHETIC_IDS } from './store';

const passcode = randomBytes(18).toString('base64url');
const accounts = ['manager', 'admin', 'player-01', 'spectator'].map(suffix => {
  const salt = randomBytes(16).toString('base64url');
  return { username: `demo.${suffix}`, accountId: `synthetic-account-${suffix}`, salt, hash: scryptSync(passcode, Buffer.from(salt, 'base64url'), 32, DEMO_SCRYPT_OPTIONS).toString('hex') };
});
const demoAccounts: DemoAccountOptions = { version: 1, accounts, sessionTtlSeconds: 600 };
const running: ReturnType<typeof createApi>[] = [];
afterEach(async () => { for (const api of running.splice(0)) await api.close(); vi.unstubAllEnvs(); });

async function start(configured = true, now = Date.now) {
  const api = createApi({ databasePath: ':memory:', syntheticAuth: true, demoScenario: true, ...(configured ? { demoAccounts } : {}), now });
  running.push(api);
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const login = (username: string, extra: Record<string, unknown> = {}) => fetch(`${base}/v1/demo/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, passcode, ...extra }) });
  return { api, base, login };
}

describe('preauthorised demo login HTTP boundary', () => {
  it('opens all four configured accounts with current service-assigned roles and no private credential disclosure', async () => {
    const { base, login } = await start();
    const health = await fetch(`${base}/health`);
    expect(await health.json()).toMatchObject({ syntheticOnly: true, demoScenario: true, demoAccountLogin: true });
    for (const [suffix, role] of [['manager', 'manager'], ['admin', 'administrator'], ['player-01', 'player'], ['spectator', 'spectator']]) {
      const response = await login(`demo.${suffix}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      const session = await response.json() as { accessToken: string; accountId: string };
      expect(Object.keys(session).sort()).toEqual(['accessToken', 'accountId', 'expiresAt', 'syntheticOnly']);
      expect(session.accountId).toBe(`synthetic-account-${suffix}`);
      const me = await fetch(`${base}/v1/me`, { headers: { Authorization: `Bearer ${session.accessToken}` } });
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({ accountId: session.accountId, memberships: expect.arrayContaining([expect.objectContaining({ role })]) });
    }
    for (const token of ['synthetic-manager-1', 'synthetic-manager-2', 'synthetic-admin', 'synthetic-spectator', 'synthetic-account-player-01']) expect((await fetch(`${base}/v1/me`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it('refuses wrong credentials and caller-supplied role authority without leaking input', async () => {
    const { base, login } = await start();
    const response = await login('demo.manager', { passcode: randomBytes(18).toString('base64url') });
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toContain('INVALID_DEMO_CREDENTIALS'); expect(body).not.toContain(passcode); expect(body).not.toContain('demo.manager');
    expect((await login('unknown.person')).status).toBe(401);
    expect((await login('demo.player-01', { role: 'administrator' })).status).toBe(400);
    const player = await (await login('demo.player-01')).json() as { accessToken: string };
    const preparation = await fetch(`${base}/v1/teams/${SYNTHETIC_IDS.teamId}/preparation?seasonId=${SYNTHETIC_IDS.seasonId}`, { headers: { Authorization: `Bearer ${player.accessToken}`, 'X-Longball-Role': 'manager' } });
    expect([403, 404]).toContain(preparation.status);
    const own = await fetch(`${base}/v1/teams/${SYNTHETIC_IDS.teamId}/preparation/own?seasonId=${SYNTHETIC_IDS.seasonId}`, { headers: { Authorization: `Bearer ${player.accessToken}`, 'X-Longball-Role': 'player' } });
    expect(own.status).toBe(200);
  });

  it('revokes one opaque session, expires the other and preserves existing test-only synthetic mode', async () => {
    let now = Date.now();
    const { base, login } = await start(true, () => now);
    const first = await (await login('demo.manager')).json() as { accessToken: string };
    const second = await (await login('demo.manager')).json() as { accessToken: string };
    const request = (token: string) => fetch(`${base}/v1/me`, { headers: { Authorization: `Bearer ${token}` } });
    const logout = await fetch(`${base}/v1/demo/sessions/current`, { method: 'DELETE', headers: { Authorization: `Bearer ${first.accessToken}` } });
    expect(logout.status).toBe(204); expect(logout.headers.get('cache-control')).toBe('private, no-store');
    expect((await request(first.accessToken)).status).toBe(401); expect((await request(second.accessToken)).status).toBe(200);
    now += 600_000; expect((await request(second.accessToken)).status).toBe(401);
    const ordinary = await start(false);
    expect((await ordinary.login('demo.manager')).status).toBe(404);
    expect((await fetch(`${ordinary.base}/v1/me`, { headers: { Authorization: 'Bearer synthetic-manager-1' } })).status).toBe(200);
  });

  it('enforces browser origins and bounded login attempts with safe retry metadata', async () => {
    const { base, login } = await start();
    const denied = await fetch(`${base}/v1/demo/sessions`, { method: 'POST', headers: { Origin: 'https://unconfigured.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'demo.manager', passcode }) });
    expect(denied.status).toBe(403);
    for (let i = 0; i < 20; i++) expect((await login('demo.manager', { role: 'administrator' })).status).toBe(400);
    const limited = await login('demo.manager');
    expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBe('60');
    expect(await limited.json()).toMatchObject({ code: 'RATE_LIMIT', retryable: true });
  });

  it('rejects demo account configuration outside an explicitly isolated nonproduction demo', () => {
    expect(() => assertDemoScenarioOptions({ demoAccounts })).toThrow('isolated nonproduction');
    expect(() => assertDemoScenarioOptions({ demoAccounts, syntheticAuth: true })).toThrow('isolated nonproduction');
    expect(() => assertDemoScenarioOptions({ demoAccounts, syntheticAuth: true, demoScenario: true })).not.toThrow();
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => assertDemoScenarioOptions({ demoAccounts, syntheticAuth: true, demoScenario: true })).toThrow('outside production');
  });
});
