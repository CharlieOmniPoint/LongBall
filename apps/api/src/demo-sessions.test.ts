import { randomBytes, scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_SCRYPT_OPTIONS, DemoSessions, parseDemoAccountOptions, readDemoAccountOptions, type DemoAccountOptions } from './demo-sessions';

const passcode = randomBytes(18).toString('base64url');
const salt = randomBytes(16).toString('base64url');
const config: DemoAccountOptions = { version: 1, accounts: [{ username: 'demo.manager', accountId: 'synthetic-account-manager', salt, hash: scryptSync(passcode, Buffer.from(salt, 'base64url'), 32, DEMO_SCRYPT_OPTIONS).toString('hex') }] };
afterEach(() => vi.restoreAllMocks());

describe('bounded preauthorised demo account sessions', () => {
  it('verifies a passcode, normalises the username and retains no authority in its opaque token', async () => {
    const service = new DemoSessions(config, () => 1000);
    const result = await service.login({ username: ' DEMO.Manager ', passcode }, 'loopback');
    expect(result).toMatchObject({ accountId: 'synthetic-account-manager', syntheticOnly: true, expiresAt: new Date(1000 + 21_600_000).toISOString() });
    expect(result.accessToken).toMatch(/^demo_[A-Za-z0-9_-]{43}$/);
    expect(result.accessToken).not.toContain('manager');
    expect(service.identity(result.accessToken)).toEqual({ issuer: 'urn:longball:synthetic', subject: 'synthetic-account-manager', authenticatedAt: 1000, strongAuth: true });
  });

  it('returns the same safe denial for an unknown username and an incorrect passcode', async () => {
    const service = new DemoSessions(config);
    for (const input of [{ username: 'unknown.person', passcode }, { username: 'demo.manager', passcode: randomBytes(18).toString('base64url') }]) {
      await expect(service.login(input, 'loopback')).rejects.toMatchObject({ code: 'INVALID_DEMO_CREDENTIALS', status: 401, message: 'The username or passcode was not recognised.' });
    }
    expect(() => service.identity('synthetic-manager-1')).toThrow('valid authenticated session');
    expect(() => service.identity(`demo_${randomBytes(32).toString('base64url')}`)).toThrow('valid authenticated session');
  });

  it('never accepts caller-supplied role or account authority and rejects malformed credential fields', async () => {
    const service = new DemoSessions(config);
    for (const input of [{ username: 'demo.manager', passcode, role: 'administrator' }, { username: 'demo.manager', passcode, accountId: 'synthetic-account-admin' }, { username: 'demo.manager', passcode: 'short' }, { username: 'demo.manager', passcode: 'x'.repeat(129) }, { username: 'demo.manager' }, ['demo.manager', passcode]]) {
      await expect(service.login(input, 'loopback')).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
    }
  });

  it('keeps child and spectator identities separate from adult authority', async () => {
    for (const accountId of ['synthetic-account-player-01', 'synthetic-account-spectator']) {
      const service = new DemoSessions({ ...config, accounts: [{ ...config.accounts[0], accountId }] });
      const session = await service.login({ username: 'demo.manager', passcode }, 'loopback');
      expect(service.identity(session.accessToken)).toMatchObject({ subject: accountId, strongAuth: false });
    }
  });

  it('expires sessions at the configured boundary and revokes only the selected session', async () => {
    let now = 1000;
    const service = new DemoSessions({ ...config, sessionTtlSeconds: 600 }, () => now);
    const one = await service.login({ username: 'demo.manager', passcode }, 'loopback');
    const two = await service.login({ username: 'demo.manager', passcode }, 'loopback');
    service.revoke(one.accessToken);
    expect(() => service.identity(one.accessToken)).toThrow('valid authenticated session');
    expect(service.identity(two.accessToken)).toHaveProperty('subject', 'synthetic-account-manager');
    now = 601_000;
    expect(() => service.identity(two.accessToken)).toThrow('valid authenticated session');
    const three = await service.login({ username: 'demo.manager', passcode }, 'loopback');
    service.close();
    expect(() => service.identity(three.accessToken)).toThrow('valid authenticated session');
    expect(() => new DemoSessions(config).identity(three.accessToken)).toThrow('valid authenticated session');
  });

  it('bounds anonymous credential attempts and permits a new request window', async () => {
    let now = 1000;
    const service = new DemoSessions(config, () => now);
    for (let i = 0; i < 20; i++) await expect(service.login({}, 'loopback')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(service.login({ username: 'demo.manager', passcode }, 'loopback')).rejects.toMatchObject({ code: 'RATE_LIMIT', status: 429 });
    now += 60_000;
    await expect(service.login({ username: 'demo.manager', passcode }, 'loopback')).resolves.toHaveProperty('accessToken');
  });

  it('bounds verifier files and refuses executable costs, duplicate identities and authority outside the Roma demo', () => {
    expect(parseDemoAccountOptions(config)).toEqual(config);
    for (const candidate of [{ ...config, n: 1 }, { ...config, sessionTtlSeconds: 1 }, { ...config, sessionTtlSeconds: 43_201 }, { ...config, accounts: [] }, { ...config, accounts: [config.accounts[0], config.accounts[0]] }, { ...config, accounts: [{ ...config.accounts[0], accountId: 'real-account' }] }, { ...config, accounts: [{ ...config.accounts[0], passcode }] }, { ...config, accounts: [{ ...config.accounts[0], salt: 'too-short' }] }, { ...config, accounts: [{ ...config.accounts[0], hash: 'not-a-hash' }] }]) expect(() => parseDemoAccountOptions(candidate)).toThrow('valid demo account verifiers');
  });

  it('loads only explicit nonproduction demo files and never echoes a bad path or configuration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'longball-demo-verifiers-'));
    const path = join(directory, 'accounts.json');
    try {
      writeFileSync(path, JSON.stringify(config));
      const env = { LONGBALL_DEMO_ACCOUNTS_FILE: path, LONGBALL_SYNTHETIC_AUTH: '1', LONGBALL_DEMO_SCENARIO: '1' };
      expect(readDemoAccountOptions({})).toBeUndefined();
      expect(readDemoAccountOptions(env)).toEqual(config);
      expect(() => readDemoAccountOptions({ ...env, NODE_ENV: 'production' })).toThrow('explicitly isolated nonproduction');
      expect(() => readDemoAccountOptions({ ...env, LONGBALL_DEMO_SCENARIO: '0' })).toThrow('explicitly isolated nonproduction');
      writeFileSync(path, 'x'.repeat(65_537));
      expect(() => readDemoAccountOptions(env)).toThrow('valid demo account verifiers');
      expect(() => readDemoAccountOptions({ ...env, LONGBALL_DEMO_ACCOUNTS_FILE: join(directory, 'private-do-not-echo') })).toThrow(/^Configure valid demo account verifiers/);
    } finally { rmSync(directory, { recursive: true }); }
  });
});
