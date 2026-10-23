import { fictionalReviewApiUrl, type ReviewRole, type ReviewUnavailableReason } from '@longball/application/review-entry';

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
const MAX_JSON_BYTES = 65_536;
const invalidResponse = () => new Error('The demo sign-in response could not be verified.');
const canceled = () => Object.assign(new Error('Demo sign-in was canceled.'), { name: 'AbortError' });

/** An access denial closes local credentials; a network failure only covers the retained workspace. */
export class DemoSessionAccessDenied extends Error {
  constructor() { super('Your demo account access has ended. Please sign in again.'); this.name = 'DemoSessionAccessDenied'; }
}
export function demoServiceUnavailableMessage(reason: ReviewUnavailableReason): string {
  if (reason === 'expired' || reason === 'not_ready') return 'The demo service is paused or its review session has ended. Try again after the demo is renewed.';
  if (reason === 'cancelled') return 'Demo sign-in was canceled. Please try again.';
  if (reason === 'not_chosen') return 'Choose Sign in to open the demo.';
  if (reason === 'invalid_status' || reason === 'not_fictional') return 'The demo service could not be verified. Please try again later.';
  return 'The demo service could not be reached. Check your connection and try again.';
}
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => undefined); throw canceled(); }
  let abort = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { abort = () => reject(canceled()); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([work, stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}

async function exchange(base: string, path: string, input: RequestInit, signal: AbortSignal, fetchRequest: DemoLoginFetch): Promise<Response> {
  if (signal.aborted) throw canceled();
  let response: Response;
  try { response = await abortable(fetchRequest(base + path, { ...input, credentials: 'omit', redirect: 'error', cache: 'no-store', signal }), signal); }
  catch { if (signal.aborted) throw canceled(); throw new Error('The demo service could not be reached. Check your connection and try again.'); }
  if (response.redirected || response.url && response.url !== base + path) throw new Error('The demo sign-in response could not be verified.');
  return response;
}
async function read(response: Response, signal: AbortSignal): Promise<unknown> {
  let text: string;
  if (response.body?.getReader) {
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0, finished = false;
    try {
      while (true) {
        const part = await abortable(reader.read(), signal);
        if (part.done) { finished = true; break; }
        size += part.value.byteLength;
        if (size > MAX_JSON_BYTES) throw invalidResponse();
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) { if (signal.aborted) throw canceled(); if (error instanceof Error && error.message === invalidResponse().message) throw error; throw invalidResponse(); }
    finally {
      if (!finished) void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } else {
    try { text = await abortable(response.text(), signal); }
    catch { if (signal.aborted) throw canceled(); throw invalidResponse(); }
    if (text.length > MAX_JSON_BYTES || new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) throw invalidResponse();
  }
  if (signal.aborted) throw canceled();
  try { return JSON.parse(text) as unknown; } catch { throw invalidResponse(); }
}
function authorisedRoles(identity: unknown, accountId: string, nowMs: number): ReviewRole[] {
  if (!record(identity) || identity.syntheticOnly !== true || !record(identity.principal) || identity.principal.accountId !== accountId || identity.principal.status !== 'active' || !Array.isArray(identity.memberships)) throw new DemoSessionAccessDenied();
  const authorised = identity.memberships.filter(item => record(item) && item.accountId === accountId && typeof item.teamId === 'string' && item.teamId.trim().length > 0 && typeof item.seasonId === 'string' && item.seasonId.trim().length > 0 && item.revokedAt == null && (item.expiresAt == null || typeof item.expiresAt === 'number' && Number.isFinite(item.expiresAt) && item.expiresAt > nowMs));
  return roles.filter(role => authorised.some(item => item.role === role));
}
/** Recheck the same account and selected role before uncovering a backgrounded workspace. */
export async function verifyDemoSession(session: DemoLoginSession, signal: AbortSignal, fetchRequest: DemoLoginFetch = globalThis.fetch, now: () => number = Date.now): Promise<void> {
  const base = fictionalReviewApiUrl(session.apiBaseUrl);
  if (!base || !Number.isFinite(session.expiresAtMs) || session.expiresAtMs <= now()) throw new DemoSessionAccessDenied();
  const response = await exchange(base, '/v1/me', { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${session.accessToken}` } }, signal, fetchRequest);
  if ([401, 403, 404].includes(response.status)) throw new DemoSessionAccessDenied();
  if (!response.ok) throw new Error('Current demo access could not be checked. Please retry.');
  const currentRoles = authorisedRoles(await read(response, signal), session.accountId, now());
  if (!currentRoles.includes(session.role) || session.expiresAtMs <= now()) throw new DemoSessionAccessDenied();
  if (signal.aborted) throw canceled();
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
  const value = await read(response, input.signal), now = input.now ?? Date.now;
  if (!record(value) || value.syntheticOnly !== true || typeof value.accessToken !== 'string' || !/^[A-Za-z0-9._~-]{32,256}$/.test(value.accessToken) || typeof value.accountId !== 'string' || !value.accountId || typeof value.expiresAt !== 'string') throw new Error('The demo sign-in response could not be verified.');
  const expiresAtMs = Date.parse(value.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now() || expiresAtMs - now() > 12 * 60 * 60 * 1000) throw new Error('This demo sign-in has expired. Please sign in again.');
  const identityResponse = await exchange(base, '/v1/me', { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${value.accessToken}` } }, input.signal, fetchRequest);
  if (!identityResponse.ok) throw new Error('Your demo account access could not be checked. Please sign in again.');
  const role = authorisedRoles(await read(identityResponse, input.signal), value.accountId, now())[0];
  if (!role || input.signal.aborted || expiresAtMs <= now()) throw new Error('This demo account has no current team access.');
  return { apiBaseUrl: base, accessToken: value.accessToken, accountId: value.accountId, role, expiresAtMs };
}

export async function signOutDemo(session: DemoLoginSession, signal: AbortSignal, fetchRequest: DemoLoginFetch = globalThis.fetch): Promise<void> {
  const base = fictionalReviewApiUrl(session.apiBaseUrl);
  if (!base) throw new Error('The demo service is unavailable.');
  const response = await exchange(base, '/v1/demo/sessions/current', { method: 'DELETE', headers: { Authorization: `Bearer ${session.accessToken}` } }, signal, fetchRequest);
  if (response.status !== 204 && response.status !== 401) throw new Error('The demo service could not confirm sign-out.');
}
