import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceBinding } from '@longball/application/workspace-boundary';
import type { DemoLoginSession } from './demo-login';
import { demoSessionIdentityKey, prepareDemoSessionRenewal, type DemoSessionRenewalPort } from './demo-session-renewal';
vi.mock('./id', () => ({ randomUUID: () => 'test-only-renewal-key' }));

const base = 'https://review-team.trycloudflare.com';
const previous: DemoLoginSession = { apiBaseUrl: base, accountId: 'admin', accessToken: 'demo_' + 'a'.repeat(43), role: 'administrator', expiresAtMs: 1000 };
const next: DemoLoginSession = { ...previous, accessToken: 'demo_' + 'b'.repeat(43), expiresAtMs: 2000, role: 'manager' };
const scope: WorkspaceBinding = { apiBaseUrl: base, accountId: 'admin', issuer: 'https://identity.test', subject: 'admin-person', teamId: 'roma', seasonId: '2026', role: 'administrator', playerId: null, generation: 1 };
const create = (candidate = next) => {
  const port: DemoSessionRenewalPort = { signIn: vi.fn(async () => candidate), verify: vi.fn(async () => {}), revoke: vi.fn(async () => {}) };
  const input = { previous, username: 'test-admin', passcode: 'example passcode', scope, signal: new AbortController().signal, isCurrent: () => true, port };
  return { port, input };
};

describe('same-account demo session renewal', () => {
  it('keeps a credential-free actor/API key stable while rechecking the selected scope with a fresh credential', async () => {
    const { port, input } = create();
    const renewed = await prepareDemoSessionRenewal(input);
    expect(renewed).toEqual({ ...next, role: scope.role });
    expect(port.signIn).toHaveBeenCalledWith(expect.objectContaining({ apiBaseUrl: base }));
    expect(port.verify).toHaveBeenCalledWith(renewed, input.signal, scope);
    expect(port.revoke).not.toHaveBeenCalled();
    expect(demoSessionIdentityKey(previous)).toBe(demoSessionIdentityKey({ ...next, apiBaseUrl: base + '/' }));
    expect(demoSessionIdentityKey(previous)).not.toContain(previous.accessToken);
    expect(demoSessionIdentityKey(previous)).not.toContain(String(previous.expiresAtMs));
  });

  it('rejects and revokes another account or API without ending the existing session or forwarding a token to another origin', async () => {
    for (const candidate of [{ ...next, accountId: 'other' }, { ...next, apiBaseUrl: 'https://different-team.trycloudflare.com' }]) {
      const { port, input } = create(candidate);
      await expect(prepareDemoSessionRenewal(input)).rejects.toThrow('already open');
      expect(port.verify).not.toHaveBeenCalled();
      expect(port.revoke).toHaveBeenCalledWith({ ...candidate, apiBaseUrl: base });
      expect(port.revoke).not.toHaveBeenCalledWith(previous);
    }
  });

  it('disposes a new credential when the current scope is refused, the operation changes or it is cancelled', async () => {
    for (const variant of ['refused', 'stale', 'aborted']) {
      const { port, input } = create(); let current = true;
      const controller = new AbortController(); input.signal = controller.signal; input.isCurrent = () => current;
      port.verify = vi.fn(async () => {
        if (variant === 'refused') throw new Error('Current scope refused');
        if (variant === 'stale') current = false;
        if (variant === 'aborted') controller.abort();
      });
      await expect(prepareDemoSessionRenewal(input)).rejects.toThrow();
      expect(port.revoke).toHaveBeenCalledWith(next);
    }
  });

  it('does not send credentials for a stale or mismatched held context, and never revokes the existing credential returned in error', async () => {
    const { port, input } = create();
    await expect(prepareDemoSessionRenewal({ ...input, isCurrent: () => false })).rejects.toThrow('cancelled');
    await expect(prepareDemoSessionRenewal({ ...input, scope: { ...scope, accountId: 'other' } })).rejects.toThrow('current account');
    expect(port.signIn).not.toHaveBeenCalled();
    const unchanged = create(previous);
    await expect(prepareDemoSessionRenewal(unchanged.input)).rejects.toThrow('new sign-in');
    expect(unchanged.port.revoke).not.toHaveBeenCalled();
  });

  it('retains a failed candidate revocation for an explicit retry without treating it as accepted access', async () => {
    const { port, input } = create({ ...next, accountId: 'wrong' });
    const retain = vi.fn(); port.revoke = vi.fn(async () => { throw new Error('Service unavailable'); });
    await expect(prepareDemoSessionRenewal({ ...input, onUnconfirmedRevocation: retain })).rejects.toThrow('already open');
    expect(retain).toHaveBeenCalledWith({ ...next, accountId: 'wrong' });
    expect(port.verify).not.toHaveBeenCalled();
  });

  it('ends a cancelled spinner even if a provider ignores abort, and disposes its late credential', async () => {
    const { port, input } = create();
    let complete: (session: DemoLoginSession) => void = () => {};
    port.signIn = vi.fn(() => new Promise<DemoLoginSession>(resolve => { complete = resolve; }));
    const controller = new AbortController();
    const pending = prepareDemoSessionRenewal({ ...input, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    complete(next);
    await vi.waitFor(() => expect(port.revoke).toHaveBeenCalledWith(next));
    expect(port.verify).not.toHaveBeenCalled();
  });
});
