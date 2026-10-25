import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LoginAnalyticsDto } from '../../../packages/application/src/login-analytics';
import { AccessError } from '../../../packages/application/src/access';
import { DEMO_SCRYPT_OPTIONS, type DemoAccountOptions } from './demo-sessions';
import { createApi } from './server';
import { EVENT_CONTRACT_VERSION, SYNTHETIC_IDS } from './store';

const passcode = randomBytes(18).toString('base64url');
const identities = {
  super: 'synthetic-account-admin',
  club: 'synthetic-account-club-admin',
  manager: 'synthetic-account-manager-2',
  player: 'synthetic-account-player-01',
  spectator: 'synthetic-account-spectator',
} as const;
const accounts = Object.entries(identities).map(([name, accountId]) => {
  const salt = randomBytes(16).toString('base64url');
  return { username: `review.${name}`, accountId, salt, hash: scryptSync(passcode, Buffer.from(salt, 'base64url'), 32, DEMO_SCRYPT_OPTIONS).toString('hex') };
});
const demoAccounts: DemoAccountOptions = { version: 1, sessionTtlSeconds: 3600, accounts };

describe('Super Admin login reporting through actual SQLite HTTP', () => {
  let app: ReturnType<typeof createApi> | undefined, directory: string, base: string, now: number;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'longball-login-http-')); now = Date.parse('2026-10-25T15:00:00Z'); });
  afterEach(async () => { app?.server.closeAllConnections(); await app?.close(); await rm(directory, { recursive: true, force: true }); });
  const options = (configured: boolean) => ({ databasePath: join(directory, 'review.sqlite'), syntheticAuth: true, demoScenario: true, ...(configured ? { demoAccounts } : {}), publicAppEntryUrl: 'https://example.invalid/LongBall/', invitationPolicyVersion: 'login-report-test-v1', now: () => now });
  async function start(configured = true) {
    app = createApi(options(configured));
    await new Promise<void>(resolve => app!.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  }
  const login = (name: keyof typeof identities, override?: object) => fetch(base + '/v1/demo/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: `review.${name}`, passcode, ...override }) });
  async function token(name: keyof typeof identities) {
    const response = await login(name); expect(response.status).toBe(200);
    const body = await response.json() as { accessToken: string; accountId: string };
    expect(body.accountId).toBe(identities[name]); return body.accessToken;
  }
  const read = (path: string, auth: string, role = 'administrator') => fetch(base + path, { headers: { Authorization: `Bearer ${auth}`, 'X-Longball-Role': role } });
  async function report(auth: string, query = ''): Promise<LoginAnalyticsDto> {
    const response = await read('/v1/administration/login-analytics' + query, auth);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
    const result = await response.json() as LoginAnalyticsDto; expect(result.kind).toBe('login-analytics'); return result;
  }
  const post = (path: string, body: object, auth?: string, role?: string) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Contract-Version': EVENT_CONTRACT_VERSION, 'Idempotency-Key': randomUUID(), ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(role ? { 'X-Longball-Role': role } : {}) }, body: JSON.stringify(body) });

  it('records accepted sessions once, heartbeats separately, and preserves logout semantics', async () => {
    await start();
    const sessions = {} as Record<keyof typeof identities, string>;
    for (const name of Object.keys(identities) as (keyof typeof identities)[]) sessions[name] = await token(name);
    const initial = await report(sessions.super);
    expect(initial.summary).toMatchObject({ signIns: 5, failedAttempts: 0, uniqueAccounts: 5, activeAccounts: 5, activeSessions: 5 });
    expect(initial.events.filter(event => event.type === 'login_success')).toHaveLength(5);
    expect(initial.roles.filter(role => role.signIns > 0)).toHaveLength(5);
    expect(initial.coverage).toMatchObject({ activityWindowMinutes: 15, pollingIncluded: true, upstreamProviderFailuresIncluded: false, collectionHealthy: true });
    const before = initial.activeUsers.find(user => user.accountId === identities.manager)!.lastSeenAt;
    for (let i = 0; i < 3; i++) expect((await read('/v1/me', sessions.manager, 'manager')).status).toBe(200);
    expect((await report(sessions.super)).summary.signIns).toBe(5);
    now += 61_000;
    expect((await read('/v1/me', sessions.manager, 'manager')).status).toBe(200);
    const heartbeat = await report(sessions.super);
    expect(heartbeat.summary.signIns).toBe(5);
    expect(heartbeat.activeUsers.find(user => user.accountId === identities.manager)!.lastSeenAt).toBeGreaterThan(before);
    const logout = await fetch(base + '/v1/demo/sessions/current', { method: 'DELETE', headers: { Authorization: `Bearer ${sessions.manager}` } });
    expect(logout.status).toBe(204);
    expect((await read('/v1/me', sessions.manager, 'manager')).status).toBe(401);
    const after = await report(sessions.super);
    expect(after.summary).toMatchObject({ signIns: 5, activeAccounts: 5, activeSessions: 4 });
    expect(after.events.filter(event => event.type === 'logout')).toEqual([expect.objectContaining({ accountId: identities.manager, provider: 'demo' })]);
    expect(after.activeUsers.find(user => user.accountId === identities.manager)!.sessionCount).toBe(0);
    const serialized = JSON.stringify(after);
    for (const session of Object.values(sessions)) expect(serialized).not.toContain(session);
    for (const account of accounts) { expect(serialized).not.toContain(account.salt); expect(serialized).not.toContain(account.hash); }
    expect(serialized).not.toContain(passcode);
    expect(serialized).not.toContain('127.0.0.1');
  });

  it('filters captured club/team access and rejects every non-Super role and stale Super grant', async () => {
    await start();
    const admin = await token('super'), manager = await token('manager');
    const whole = await report(admin), { teamId } = SYNTHETIC_IDS;
    const roma = whole.directory.teams.find(team => team.id === teamId)!;
    expect(roma).toBeDefined();
    const selected = await report(admin, `?range=24h&clubId=${roma.clubId}&teamId=${roma.id}`);
    expect(selected.summary).toMatchObject({ signIns: 1, uniqueAccounts: 1, activeAccounts: 1 });
    expect(selected.events.every(event => event.accountId === identities.manager)).toBe(true);
    expect(selected.events.flatMap(event => event.scopes).every(scope => scope.clubId === roma.clubId && scope.teamId === roma.id)).toBe(true);
    expect((await report(admin, '?role=manager')).summary.signIns).toBe(1);
    const otherClub = whole.directory.clubs.find(club => club.id !== roma.clubId)!;
    expect((await report(admin, `?clubId=${otherClub.id}`)).summary.signIns).toBe(0);
    for (const name of ['club', 'player', 'spectator'] as const) {
      const auth = await token(name);
      expect([403, 404]).toContain((await read('/v1/administration/login-analytics', auth)).status);
    }
    expect([403, 404]).toContain((await read('/v1/administration/login-analytics', manager)).status);
    expect((await fetch(base + '/v1/administration/login-analytics')).status).toBe(401);
    for (const query of ['?range=1d', '?range=7d&range=24h', '?unknown=field', '?role=administrator', '?cursor=forged', `?clubId=${otherClub.id}&teamId=${roma.id}`]) expect((await read('/v1/administration/login-analytics' + query, admin)).status).toBe(400);
    app!.store.database.prepare('DELETE FROM administration_grants WHERE account_id=?').run(identities.super);
    expect((await read('/v1/administration/login-analytics', admin)).status).toBe(404);
  });

  it('keeps failures unattributed, excludes malformed requests, and never marks a disabled account as signed in', async () => {
    await start(); const admin = await token('super'), wrong = randomBytes(18).toString('base64url');
    expect((await login('manager', { passcode: wrong })).status).toBe(401);
    expect((await login('manager', { username: 'unlisted.reviewer' })).status).toBe(401);
    app!.store.database.prepare("UPDATE accounts SET status='disabled' WHERE id=?").run(identities.player);
    expect((await login('player')).status).toBe(403);
    expect((await login('manager', { passcode: 'short' })).status).toBe(400);
    const result = await report(admin);
    expect(result.summary).toMatchObject({ signIns: 1, uniqueAccounts: 1, failedAttempts: 3 });
    const failures = result.events.filter(event => event.type === 'login_failure');
    expect(failures.reduce((count, event) => count + event.count, 0)).toBe(3);
    for (const failure of failures) expect(failure).toMatchObject({ accountId: null, actorLabel: null, role: null, scopes: [] });
    const serialized = JSON.stringify(failures);
    for (const privateValue of ['unlisted.reviewer', 'review.manager', identities.player, wrong, passcode]) expect(serialized).not.toContain(privateValue);
    expect((await report(admin, '?clubId=synthetic-richmond-rovers')).summary.failedAttempts).toBe(0);
    expect((await report(admin, '?role=player')).summary.failedAttempts).toBe(0);
    expect((await report(admin, '?event=login_failure')).summary.signIns).toBe(0);
  });

  it('retains observed history after service restart while dropping old sessions and respecting periods', async () => {
    await start(); const firstAdmin = await token('super'), manager = await token('manager');
    const initial = await report(firstAdmin), ids = initial.events.map(event => event.id);
    app!.server.closeAllConnections(); await app!.close(); app = undefined;
    await start();
    expect((await read('/v1/me', manager, 'manager')).status).toBe(401);
    const secondAdmin = await token('super'), reopened = await report(secondAdmin);
    expect(reopened.summary).toMatchObject({ signIns: 3, uniqueAccounts: 2, activeSessions: 1 });
    expect(ids.every(id => reopened.events.some(event => event.id === id))).toBe(true);
    expect(reopened.coverage.startedAt).toBe(initial.coverage.startedAt);
    now += 25 * 3_600_000;
    const fresh = await token('super');
    const today = await report(fresh, '?range=24h'), week = await report(fresh, '?range=7d');
    expect(today.summary).toMatchObject({ signIns: 1, uniqueAccounts: 1, activeAccounts: 1, activeSessions: 1 });
    expect(week.summary).toMatchObject({ signIns: 4, uniqueAccounts: 2 });
    expect(today.trend).toHaveLength(24); expect(week.trend).toHaveLength(7);
  });

  it('does not invent historical sign-ins for static development fixture credentials', async () => {
    await start(false);
    const result = await report('synthetic-admin');
    expect(result.summary).toMatchObject({ signIns: 0, failedAttempts: 0, uniqueAccounts: 0, activeAccounts: 0, activeSessions: 0 });
    expect(result.events).toEqual([]); expect(result.activeUsers).toEqual([]);
    expect(result.coverage.collectionHealthy).toBe(true);
  });

  it('records real invitation/PIN login and logout without granting report access to Spectators', async () => {
    await start(false); const { teamId, seasonId } = SYNTHETIC_IDS;
    const invite = await post(`/v1/teams/${teamId}/spectator-invites?seasonId=${seasonId}`, { seasonId, expiresInHours: 1 }, 'synthetic-manager-1', 'manager');
    expect(invite.status).toBe(201);
    const issued = await invite.json() as { shareUrl: string }, code = new URLSearchParams(new URL(issued.shareUrl).hash.slice(1)).get('code');
    const registered = await post('/v1/spectator-access/register', { token: code, username: 'review.supporter', passcode: '4729', requestId: randomUUID() });
    expect(registered.status).toBe(201);
    const one = await registered.json() as { accessToken: string; accountId: string };
    expect((await read('/v1/me', one.accessToken, 'spectator')).status).toBe(200);
    expect((await post('/v1/spectator-access/login', { username: 'review.supporter', passcode: '5826' })).status).toBe(401);
    const signedIn = await post('/v1/spectator-access/login', { username: 'REVIEW.SUPPORTER', passcode: '4729' });
    expect(signedIn.status).toBe(201);
    const two = await signedIn.json() as { accessToken: string; accountId: string };
    expect(two.accountId).toBe(one.accountId);
    const before = await report('synthetic-admin');
    expect(before.summary).toMatchObject({ signIns: 2, uniqueAccounts: 1, activeAccounts: 1, activeSessions: 2, failedAttempts: 1 });
    expect(before.events.filter(event => event.type === 'login_success').every(event => event.provider === 'spectator_pin')).toBe(true);
    const logout = await fetch(base + '/v1/spectator-access/session', { method: 'DELETE', headers: { Authorization: `Bearer ${one.accessToken}` } });
    expect(logout.status).toBe(204);
    expect((await read('/v1/me', one.accessToken, 'spectator')).status).toBe(401);
    expect((await read('/v1/me', two.accessToken, 'spectator')).status).toBe(200);
    const after = await report('synthetic-admin', `?clubId=synthetic-richmond-rovers&teamId=${teamId}`);
    expect(after.summary).toMatchObject({ signIns: 2, activeAccounts: 1, activeSessions: 1, failedAttempts: 0 });
    expect(after.events.filter(event => event.type === 'logout')).toEqual([expect.objectContaining({ accountId: one.accountId, provider: 'spectator_pin' })]);
    expect([403, 404]).toContain((await read('/v1/administration/login-analytics', two.accessToken)).status);
  });

  it('observes verified OIDC authentication contexts without inventing provider failures or session validity', async () => {
    await start(false);
    const issuer = 'https://identity.example.invalid/realms/report-test', subject = 'test-only-provider-super';
    app!.store.database.prepare('UPDATE accounts SET issuer=?,subject=? WHERE id=?').run(issuer, subject, identities.super);
    app!.server.closeAllConnections(); await app!.close(); app = undefined;
    let authenticatedAt = now;
    app = createApi({ databasePath: join(directory, 'review.sqlite'), now: () => now, verifyIdentity: async token => {
      if (!['test-only-provider-session-a', 'test-only-provider-session-b'].includes(token)) throw new AccessError('INVALID_SESSION', 401, 'A valid authenticated session is required.');
      return { issuer, subject, authenticatedAt, strongAuth: true };
    } });
    await new Promise<void>(resolve => app!.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const one = 'test-only-provider-session-a', renewed = 'test-only-provider-session-b';
    expect((await read('/v1/me', one)).status).toBe(200);
    const first = await report(one);
    expect(first.summary).toMatchObject({ signIns: 1, uniqueAccounts: 1, activeAccounts: 1, activeSessions: null, failedAttempts: 0 });
    expect(first.events).toEqual([expect.objectContaining({ provider: 'oidc', type: 'login_success', accountId: identities.super })]);
    expect((await read('/v1/me', renewed)).status).toBe(200);
    now += 61_000;
    expect((await read('/v1/me', renewed)).status).toBe(200);
    expect((await report(renewed)).summary.signIns).toBe(1);
    expect((await read('/v1/me', 'test-only-invalid-provider-session')).status).toBe(401);
    expect((await report(renewed)).summary.failedAttempts).toBe(0);
    authenticatedAt = now;
    expect((await read('/v1/me', renewed)).status).toBe(200);
    const next = await report(renewed);
    expect(next.summary).toMatchObject({ signIns: 2, uniqueAccounts: 1, activeSessions: null });
    expect(next.coverage.upstreamProviderFailuresIncluded).toBe(false);
    expect(JSON.stringify(next)).not.toContain(one);
    expect(JSON.stringify(next)).not.toContain(renewed);
  });
});
