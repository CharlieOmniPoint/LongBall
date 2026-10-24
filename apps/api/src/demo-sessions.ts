import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { AccessError } from '../../../packages/application/src/access';
import type { VerifiedIdentity } from './oidc';

export interface DemoAccountVerifier {
  username: string;
  accountId: string;
  salt: string;
  hash: string;
}
export interface DemoAccountOptions {
  version: 1;
  accounts: DemoAccountVerifier[];
  sessionTtlSeconds?: number;
}
export const DEMO_SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 } as const;
const ACCOUNT_ID = /^synthetic-account-(?:manager(?:-[2-5])?|admin|player-(?:0[1-9]|1[0-3])|spectator)$/;
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const CONFIG_ERROR = 'Configure valid demo account verifiers. No account configuration was loaded.';
const invalidSession = () => new AccessError('INVALID_SESSION', 401, 'A valid authenticated session is required.');
const invalidLogin = () => new AccessError('INVALID_DEMO_CREDENTIALS', 401, 'The username or passcode was not recognised.');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
/** Fixed, bounded verifier parameters. Configuration never accepts executable cost settings or plaintext credentials. */
export function parseDemoAccountOptions(value: unknown): DemoAccountOptions {
  if (!object(value) || value.version !== 1 || Object.keys(value).some(key => !['version', 'accounts', 'sessionTtlSeconds'].includes(key)) || !Array.isArray(value.accounts) || value.accounts.length < 1 || value.accounts.length > 32 || value.sessionTtlSeconds !== undefined && (!Number.isSafeInteger(value.sessionTtlSeconds) || Number(value.sessionTtlSeconds) < 600 || Number(value.sessionTtlSeconds) > 43_200)) throw new Error(CONFIG_ERROR);
  const names = new Set<string>();
  const subjects = new Set<string>();
  const accounts = value.accounts.map((account): DemoAccountVerifier => {
    if (!object(account) || Object.keys(account).length !== 4 || Object.keys(account).some(key => !['username', 'accountId', 'salt', 'hash'].includes(key)) || typeof account.username !== 'string' || !USERNAME.test(account.username) || typeof account.accountId !== 'string' || !ACCOUNT_ID.test(account.accountId) || typeof account.salt !== 'string' || !/^[A-Za-z0-9_-]{22,43}$/.test(account.salt) || Buffer.from(account.salt, 'base64url').toString('base64url') !== account.salt || Buffer.from(account.salt, 'base64url').length < 16 || Buffer.from(account.salt, 'base64url').length > 32 || typeof account.hash !== 'string' || !/^[a-f0-9]{64}$/.test(account.hash) || names.has(account.username) || subjects.has(account.accountId)) throw new Error(CONFIG_ERROR);
    names.add(account.username); subjects.add(account.accountId);
    return { username: account.username, accountId: account.accountId, salt: account.salt, hash: account.hash };
  });
  return { version: 1, accounts, ...(value.sessionTtlSeconds !== undefined ? { sessionTtlSeconds: Number(value.sessionTtlSeconds) } : {}) };
}

export function readDemoAccountOptions(environment: NodeJS.ProcessEnv): DemoAccountOptions | undefined {
  const path = environment.LONGBALL_DEMO_ACCOUNTS_FILE;
  if (path === undefined) return undefined;
  if (!path || environment.NODE_ENV === 'production' || environment.LONGBALL_SYNTHETIC_AUTH !== '1' || environment.LONGBALL_DEMO_SCENARIO !== '1') throw new Error('Demo account login requires an explicitly isolated nonproduction demo.');
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > 65_536) throw new Error(CONFIG_ERROR);
    return parseDemoAccountOptions(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    throw new Error(CONFIG_ERROR);
  }
}

async function derive(passcode: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(passcode, Buffer.from(salt, 'base64url'), 32, DEMO_SCRYPT_OPTIONS, (error, result) => error ? reject(error) : resolve(result)));
}

interface Session { accountId: string; issuedAt: number; expiresAt: number }
/** Disposable service sessions. Only digests survive in server memory; service restart signs every demo account out. */
export class DemoSessions {
  private readonly accounts: DemoAccountVerifier[];
  private readonly ttl: number;
  private readonly sessions = new Map<string, Session>();
  private readonly attempts = new Map<string, { begins: number; count: number }>();
  private readonly dummySalt = randomBytes(16).toString('base64url');
  private readonly dummyHash = randomBytes(32);
  private inFlight = 0;
  constructor(options: DemoAccountOptions, private readonly now: () => number = Date.now) {
    const parsed = parseDemoAccountOptions(options);
    this.accounts = parsed.accounts;
    this.ttl = (parsed.sessionTtlSeconds ?? 21_600) * 1000;
  }
  private prune(): void {
    const now = this.now();
    for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(key);
    for (const [key, attempt] of this.attempts) if (now - attempt.begins >= 60_000) this.attempts.delete(key);
  }
  async login(value: unknown, remoteAddress: string): Promise<{ accessToken: string; expiresAt: string; accountId: string; syntheticOnly: true }> {
    this.prune();
    const key = sha256(remoteAddress);
    const attempt = this.attempts.get(key) ?? { begins: this.now(), count: 0 };
    attempt.count += 1;
    if (!this.attempts.has(key) && this.attempts.size >= 1000 || attempt.count > 20 || this.inFlight >= 4) throw new AccessError('RATE_LIMIT', 429, 'Please retry after the current request window.');
    this.attempts.set(key, attempt);
    if (!object(value) || Object.keys(value).length !== 2 || Object.keys(value).some(field => !['username', 'passcode'].includes(field)) || typeof value.username !== 'string' || value.username.length > 128 || typeof value.passcode !== 'string' || value.passcode.length < 6 || value.passcode.length > 128) throw new AccessError('INVALID_REQUEST', 400, 'Enter a username and a passcode using only the documented fields.');
    const username = value.username.trim().toLowerCase();
    const account = this.accounts.find(item => item.username === username);
    this.inFlight += 1;
    let actual: Buffer;
    try { actual = await derive(value.passcode, account?.salt ?? this.dummySalt); }
    finally { this.inFlight -= 1; }
    const verified = timingSafeEqual(actual, account ? Buffer.from(account.hash, 'hex') : this.dummyHash);
    actual.fill(0);
    if (!account || !verified) throw invalidLogin();
    this.prune();
    if (this.sessions.size >= 1000) throw new AccessError('DEMO_SESSION_LIMIT', 503, 'The demo has reached its current session limit. Please try again later.');
    const accessToken = `demo_${randomBytes(32).toString('base64url')}`;
    const issuedAt = this.now(), expiresAt = issuedAt + this.ttl;
    this.sessions.set(sha256(accessToken), { accountId: account.accountId, issuedAt, expiresAt });
    return { accessToken, expiresAt: new Date(expiresAt).toISOString(), accountId: account.accountId, syntheticOnly: true };
  }
  identity(token: string): VerifiedIdentity {
    this.prune();
    const session = /^demo_[A-Za-z0-9_-]{43}$/.test(token) ? this.sessions.get(sha256(token)) : undefined;
    if (!session) throw invalidSession();
    return { issuer: 'urn:longball:synthetic', subject: session.accountId, authenticatedAt: session.issuedAt, strongAuth: /^synthetic-account-(?:manager(?:-[2-5])?|admin)$/.test(session.accountId) };
  }
  revoke(token: string): void {
    this.identity(token);
    this.sessions.delete(sha256(token));
  }
  close(): void { this.sessions.clear(); this.attempts.clear(); }
}
