import { fictionalReviewApiUrl, type ReviewRole } from '@longball/application/review-entry';

export interface DemoLoginSession {
  apiBaseUrl: string;
  accessToken: string;
  accountId: string;
  role: ReviewRole;
  expiresAtMs: number;
}
export type DemoLoginFetch = typeof globalThis.fetch;
const roles: readonly ReviewRole[] = ['manager', 'administrator', 'player', 'spectator'];
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

async function exchange(base: string, path: string, input: RequestInit, signal: AbortSignal, fetchRequest: DemoLoginFetch): Promise<Response> {
  const response = await fetchRequest(base + path, { ...input, credentials: 'omit', redirect: 'error', cache: 'no-store', signal });
  if (response.redirected || response.url && response.url !== base + path) throw new Error('The demo sign-in response could not be verified.');
  return response;
}
async function read(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > 65_536) throw new Error('The demo sign-in response could not be verified.');
  try { return JSON.parse(text) as unknown; } catch { throw new Error('The demo sign-in response could not be verified.'); }
}

/** Demo credentials and session tokens stay in memory, outside the saved match journal. */
export async function signInDemo(input: {
  apiBaseUrl: string;
  username: string;
  passcode: string;
  signal: AbortSignal;
  fetch?: DemoLoginFetch;
  now?: () => number;
}): Promise<DemoLoginSession> {
  const base = fictionalReviewApiUrl(input.apiBaseUrl);
  if (!base) throw new Error('The verified demo service is unavailable.');
  const username = input.username.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username) || input.passcode.length < 6 || input.passcode.length > 128) throw new Error('Enter your demo username and password.');
  const fetchRequest = input.fetch ?? globalThis.fetch;
  const response = await exchange(base, '/v1/demo/sessions', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, passcode: input.passcode }),
  }, input.signal, fetchRequest);
  if (response.status === 401) throw new Error('The username or password is incorrect.');
  if (response.status === 429) throw new Error('Please wait a moment before trying to sign in again.');
  if (response.status !== 201 && response.status !== 200) throw new Error('Demo sign-in is unavailable. Please try again.');
  const value = await read(response), now = input.now ?? Date.now;
  if (!record(value) || value.syntheticOnly !== true || typeof value.accessToken !== 'string' || !/^[A-Za-z0-9._~-]{32,256}$/.test(value.accessToken) || typeof value.accountId !== 'string' || !value.accountId || typeof value.expiresAt !== 'string') throw new Error('The demo sign-in response could not be verified.');
  const expiresAtMs = Date.parse(value.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now() || expiresAtMs - now() > 12 * 60 * 60 * 1000) throw new Error('This demo sign-in has expired. Please sign in again.');
  const identityResponse = await exchange(base, '/v1/me', { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${value.accessToken}` } }, input.signal, fetchRequest);
  if (!identityResponse.ok) throw new Error('Your demo account access could not be checked. Please sign in again.');
  const identity = await read(identityResponse);
  if (!record(identity) || identity.syntheticOnly !== true || !record(identity.principal) || identity.principal.accountId !== value.accountId || identity.principal.status !== 'active' || !Array.isArray(identity.memberships)) throw new Error('Your demo account access could not be checked. Please sign in again.');
  const authorised = identity.memberships.filter(item => record(item) && item.accountId === value.accountId && item.revokedAt == null && (item.expiresAt == null || typeof item.expiresAt === 'number' && item.expiresAt > now()));
  const role = roles.find(role => authorised.some(item => item.role === role));
  if (!role || input.signal.aborted || expiresAtMs <= now()) throw new Error('This demo account has no current team access.');
  return { apiBaseUrl: base, accessToken: value.accessToken, accountId: value.accountId, role, expiresAtMs };
}

export async function signOutDemo(session: DemoLoginSession, signal: AbortSignal, fetchRequest: DemoLoginFetch = globalThis.fetch): Promise<void> {
  const base = fictionalReviewApiUrl(session.apiBaseUrl);
  if (!base) throw new Error('The demo service is unavailable.');
  const response = await exchange(base, '/v1/demo/sessions/current', { method: 'DELETE', headers: { Authorization: `Bearer ${session.accessToken}` } }, signal, fetchRequest);
  if (response.status !== 204 && response.status !== 401) throw new Error('The demo service could not confirm sign-out.');
}
