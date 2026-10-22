import { describe, expect, it, vi } from 'vitest';
import { signInDemo, signOutDemo } from './demo-login';

const now = Date.parse('2026-10-22T10:00:00Z');
const base = 'https://longball-demo.trycloudflare.com';
const token = 'demo_' + 'a'.repeat(43);
const session = { accessToken: token, accountId: 'synthetic-account-player-01', expiresAt: new Date(now + 3600000).toISOString(), syntheticOnly: true };
const membership = { accountId: session.accountId, teamId: 'roma', seasonId: '2026-27', role: 'player' };
const identity = { syntheticOnly: true, principal: { accountId: session.accountId, status: 'active' }, memberships: [membership] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const input = () => ({ apiBaseUrl: base, username: ' Oliver.Bennett ', passcode: 'test-only-never-a-configured-passcode', signal: new AbortController().signal, now: () => now });

describe('demo username/passcode client', () => {
  it('checks current service identity and derives the role without a caller role or stored credential', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(session)).mockResolvedValueOnce(json(identity));
    const result = await signInDemo({ ...input(), fetch });
    expect(result).toEqual({ apiBaseUrl: base, accessToken: token, accountId: session.accountId, role: 'player', expiresAtMs: now + 3600000 });
    expect(fetch.mock.calls[0]).toEqual([base + '/v1/demo/sessions', expect.objectContaining({ method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', body: JSON.stringify({ username: 'oliver.bennett', passcode: input().passcode }) })]);
    expect(fetch.mock.calls[1]).toEqual([base + '/v1/me', expect.objectContaining({ headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } })]);
    expect(result).not.toHaveProperty('passcode'); expect(result).not.toHaveProperty('username');
  });
  it('does not send credentials to an unverified URL or with invalid input', async () => {
    const fetch = vi.fn();
    for (const apiBaseUrl of ['https://api.example.test', 'http://longball-demo.trycloudflare.com', 'https://longball-demo.trycloudflare.com/foreign']) await expect(signInDemo({ ...input(), apiBaseUrl, fetch })).rejects.toThrow('verified');
    await expect(signInDemo({ ...input(), username: '', fetch })).rejects.toThrow('username');
    await expect(signInDemo({ ...input(), passcode: 'short', fetch })).rejects.toThrow('username');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('displays generic wrong-credential and bounded-attempt errors without echoing server bodies', async () => {
    for (const [code, expected] of [[401, 'incorrect'], [429, 'wait a moment'], [503, 'unavailable']] as const) {
      const fetch = vi.fn(async () => json({ error: 'private diagnostic' }, code));
      await expect(signInDemo({ ...input(), fetch })).rejects.toThrow(expected);
      expect(fetch).toHaveBeenCalledOnce();
    }
  });
  it('refuses a foreign principal, disabled account, revoked membership or forged role', async () => {
    for (const value of [
      { ...identity, principal: { ...identity.principal, accountId: 'another-account' } },
      { ...identity, principal: { ...identity.principal, status: 'disabled' } },
      { ...identity, memberships: [{ ...membership, revokedAt: now - 1 }] },
      { ...identity, memberships: [{ ...membership, expiresAt: now }] },
      { ...identity, memberships: [{ ...membership, accountId: 'another-account', role: 'administrator' }] },
      { ...identity, memberships: [{ ...membership, role: 'global-admin' }] },
      { ...identity, syntheticOnly: false },
    ]) {
      const fetch = vi.fn().mockResolvedValueOnce(json(session)).mockResolvedValueOnce(json(value));
      await expect(signInDemo({ ...input(), fetch })).rejects.toThrow(/access/);
    }
  });
  it('refuses expired or excessively long sessions before opening a workspace', async () => {
    for (const expiresAt of [new Date(now).toISOString(), new Date(now + 13 * 3600000).toISOString(), 'invalid']) {
      const fetch = vi.fn().mockResolvedValueOnce(json({ ...session, expiresAt }));
      await expect(signInDemo({ ...input(), fetch })).rejects.toThrow(/expired/);
      expect(fetch).toHaveBeenCalledOnce();
    }
  });
  it('does not attach a response after the sign-in operation is canceled', async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockResolvedValueOnce(json(session)).mockImplementationOnce(async () => { controller.abort(); return json(identity); });
    await expect(signInDemo({ ...input(), signal: controller.signal, fetch })).rejects.toThrow('access');
  });
  it('rejects redirected, oversized and malformed session responses', async () => {
    const redirected = json(session); Object.defineProperty(redirected, 'redirected', { value: true });
    for (const response of [redirected, new Response('x'.repeat(65537)), json({ ...session, accessToken: 'short' }), json({ ...session, syntheticOnly: false })]) {
      const fetch = vi.fn(async () => response);
      await expect(signInDemo({ ...input(), fetch })).rejects.toThrow('verified');
    }
  });
  it('revokes only the current server session and treats an already-expired session as signed out', async () => {
    const signedIn = { apiBaseUrl: base, accessToken: token, accountId: session.accountId, role: 'player' as const, expiresAtMs: now + 3600000 };
    for (const code of [204, 401]) {
      const fetch = vi.fn(async () => new Response(null, { status: code }));
      await expect(signOutDemo(signedIn, new AbortController().signal, fetch)).resolves.toBeUndefined();
      expect(fetch.mock.calls[0]).toEqual([base + '/v1/demo/sessions/current', expect.objectContaining({ method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, credentials: 'omit', redirect: 'error' })]);
    }
    await expect(signOutDemo(signedIn, new AbortController().signal, async () => new Response(null, { status: 503 }))).rejects.toThrow('confirm');
  });
});
