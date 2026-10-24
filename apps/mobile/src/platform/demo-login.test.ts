import { describe, expect, it, vi } from 'vitest';
import { DemoSessionAccessDenied, demoServiceUnavailableMessage, signInDemo, signOutDemo, verifyDemoSession, type DemoLoginSession } from './demo-login';
import type { WorkspaceBinding } from '@longball/application/workspace-boundary';

const now = Date.parse('2026-10-22T10:00:00Z');
const base = 'https://longball-demo.trycloudflare.com';
const token = 'demo_' + 'a'.repeat(43);
const session = { accessToken: token, accountId: 'synthetic-account-player-01', expiresAt: new Date(now + 3600000).toISOString(), syntheticOnly: true };
const membership = { accountId: session.accountId, teamId: 'roma', seasonId: '2026-27', role: 'player' };
const identity = { syntheticOnly: true, principal: { accountId: session.accountId, status: 'active' }, memberships: [membership] };
const signedIn: DemoLoginSession = { apiBaseUrl: base, accessToken: token, accountId: session.accountId, role: 'player', expiresAtMs: now + 3600000 };
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
      { ...identity, memberships: [{ ...membership, teamId: ' ' }] },
      { ...identity, memberships: [{ ...membership, seasonId: '' }] },
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
    await expect(signInDemo({ ...input(), signal: controller.signal, fetch })).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('rejects redirected, oversized and malformed session responses', async () => {
    const redirected = json(session); Object.defineProperty(redirected, 'redirected', { value: true });
    for (const response of [redirected, new Response('x'.repeat(65537)), json({ ...session, accessToken: 'short' }), json({ ...session, syntheticOnly: false })]) {
      const fetch = vi.fn(async () => response);
      await expect(signInDemo({ ...input(), fetch })).rejects.toThrow('verified');
    }
  });
  it('revokes only the current server session and treats an already-expired session as signed out', async () => {
    for (const code of [204, 401]) {
      const fetch = vi.fn(async () => new Response(null, { status: code }));
      await expect(signOutDemo(signedIn, new AbortController().signal, fetch)).resolves.toBeUndefined();
      expect(fetch.mock.calls[0]).toEqual([base + '/v1/demo/sessions/current', expect.objectContaining({ method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, credentials: 'omit', redirect: 'error' })]);
    }
    await expect(signOutDemo(signedIn, new AbortController().signal, async () => new Response(null, { status: 503 }))).rejects.toThrow('confirm');
  });

  it('allows a canceled uncooperative fetch or stalled response body to stop promptly', async () => {
    const controller = new AbortController();
    const pendingFetch = signInDemo({ ...input(), signal: controller.signal, fetch: () => new Promise<Response>(() => {}) });
    controller.abort();
    await expect(pendingFetch).rejects.toMatchObject({ name: 'AbortError' });

    const bodyController = new AbortController(), cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(new TextEncoder().encode('{')); }, cancel });
    const pendingBody = signInDemo({ ...input(), signal: bodyController.signal, fetch: async () => new Response(body) });
    await vi.waitFor(() => expect(body.locked).toBe(true));
    bodyController.abort();
    await expect(pendingBody).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce(); expect(body.locked).toBe(false);
  });
  it('caps streamed JSON before the service finishes and does not expose raw transport diagnostics', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(new Uint8Array(65_537)); }, cancel });
    await expect(signInDemo({ ...input(), fetch: async () => new Response(body) })).rejects.toThrow('verified');
    expect(cancel).toHaveBeenCalledOnce(); expect(body.locked).toBe(false);
    const cause = new Error('private diagnostic with sensitive request');
    await expect(signInDemo({ ...input(), fetch: async () => { throw cause; } })).rejects.toThrow('Check your connection');
    const textOnlyResponse = new Response(null);
    Object.defineProperty(textOnlyResponse, 'text', { value: async () => { throw cause; } });
    await expect(signInDemo({ ...input(), fetch: async () => textOnlyResponse })).rejects.toThrow('verified');
  });
  it('also cancels an uncooperative native-style text-only response', async () => {
    const controller = new AbortController(), response = new Response(null);
    const text = vi.fn(() => new Promise<string>(() => {}));
    Object.defineProperty(response, 'text', { value: text });
    const pending = signInDemo({ ...input(), signal: controller.signal, fetch: async () => response });
    await vi.waitFor(() => expect(text).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('revalidates the same current role after foreground without extending the credential lifetime', async () => {
    const fetch = vi.fn(async () => json(identity));
    await expect(verifyDemoSession(signedIn, new AbortController().signal, fetch, () => now)).resolves.toBeUndefined();
    expect(fetch.mock.calls[0]).toEqual([base + '/v1/me', expect.objectContaining({ method: 'GET', credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } })]);
    expect(signedIn.expiresAtMs).toBe(now + 3600000);
    const noFetch = vi.fn();
    await expect(verifyDemoSession({ ...signedIn, expiresAtMs: now }, new AbortController().signal, noFetch, () => now)).rejects.toBeInstanceOf(DemoSessionAccessDenied);
    expect(noFetch).not.toHaveBeenCalled();
  });
  it('distinguishes a genuine current access denial from an unavailable service', async () => {
    for (const code of [401, 403, 404]) await expect(verifyDemoSession(signedIn, new AbortController().signal, async () => json({ error: 'private diagnostic' }, code), () => now)).rejects.toBeInstanceOf(DemoSessionAccessDenied);
    for (const value of [
      { ...identity, principal: { ...identity.principal, accountId: 'another-account' } },
      { ...identity, principal: { ...identity.principal, status: 'disabled' } },
      { ...identity, memberships: [{ ...membership, role: 'spectator' }] },
      { ...identity, memberships: [{ ...membership, revokedAt: now - 1 }] },
    ]) await expect(verifyDemoSession(signedIn, new AbortController().signal, async () => json(value), () => now)).rejects.toBeInstanceOf(DemoSessionAccessDenied);
    for (const code of [429, 500, 503]) {
      const failure = verifyDemoSession(signedIn, new AbortController().signal, async () => json({ error: 'private diagnostic' }, code), () => now);
      await expect(failure).rejects.toThrow('Please retry');
      await expect(failure).rejects.not.toBeInstanceOf(DemoSessionAccessDenied);
    }
  });
  it('requires the selected workspace grant even when another same-role grant remains current', async () => {
    const principal = { accountId: session.accountId, status: 'active', issuer: 'https://demo-identity.test', subject: 'demo-person', identityClassification: 'adult_individual', adultVerified: true, strongAuth: true };
    const scope: WorkspaceBinding = { generation: 5, apiBaseUrl: base, accountId: session.accountId, issuer: principal.issuer, subject: principal.subject, teamId: 'roma', seasonId: '2026-27', role: 'manager', playerId: null };
    const selected = { ...membership, role: 'manager' }, other = { ...selected, teamId: 'milan' };
    const manager = { ...signedIn, role: 'manager' as const };
    const current = (memberships: unknown[], identityPrincipal = principal) => async () => json({ syntheticOnly: true, principal: identityPrincipal, memberships });
    await expect(verifyDemoSession(manager, new AbortController().signal, current([selected, other]), () => now, scope)).resolves.toBeUndefined();
    for (const memberships of [[other], [{ ...selected, revokedAt: now - 1 }, other], [{ ...selected, expiresAt: now }, other], [{ ...selected, seasonId: '2027-28' }, other]]) await expect(verifyDemoSession(manager, new AbortController().signal, current(memberships), () => now, scope)).rejects.toBeInstanceOf(DemoSessionAccessDenied);
    await expect(verifyDemoSession(manager, new AbortController().signal, current([selected, other], { ...principal, subject: 'different' }), () => now, scope)).rejects.toBeInstanceOf(DemoSessionAccessDenied);
    const administrator = { ...selected, role: 'administrator' };
    await expect(verifyDemoSession(manager, new AbortController().signal, current([administrator]), () => now, { ...scope, role: 'administrator' })).resolves.toBeUndefined();
    await expect(verifyDemoSession(signedIn, new AbortController().signal, current([{ ...membership, playerId: 'another-child' }]), () => now, { ...scope, role: 'player', playerId: 'selected-child' })).rejects.toBeInstanceOf(DemoSessionAccessDenied);
  });
  it('keeps login-only service recovery messages accurate without an unavailable local route', () => {
    expect(demoServiceUnavailableMessage('expired')).toContain('renewed');
    expect(demoServiceUnavailableMessage('not_ready')).toContain('paused');
    expect(demoServiceUnavailableMessage('health_unavailable')).toContain('Check your connection');
    for (const reason of ['expired', 'not_ready', 'health_unavailable', 'status_unavailable', 'timeout', 'cancelled', 'invalid_status', 'not_fictional'] as const) expect(demoServiceUnavailableMessage(reason)).not.toMatch(/local|rehearsal/i);
  });
});
