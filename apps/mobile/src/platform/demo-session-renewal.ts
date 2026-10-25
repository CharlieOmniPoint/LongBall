import { fictionalReviewApiUrl } from '@longball/application/review-entry';
import type { WorkspaceBinding } from '@longball/application/workspace-boundary';
import { signInDemo, signOutDemo, verifyDemoSession, type DemoLoginFetch, type DemoLoginSession } from './demo-login';
import { signInSpectatorPin } from './spectator-access-client';

export interface DemoSessionRenewalPort {
  signIn: (input: { apiBaseUrl: string; username: string; passcode: string; signal: AbortSignal }) => Promise<DemoLoginSession>;
  verify: (session: DemoLoginSession, signal: AbortSignal, scope: WorkspaceBinding | null) => Promise<void>;
  revoke: (session: DemoLoginSession) => Promise<void>;
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => undefined); return Promise.reject(new Error('Sign-in verification was cancelled. Try again.')); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Sign-in verification was cancelled. Try again.'));
    signal.addEventListener('abort', abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Contains no credential and changes only when the actual account or API changes. */
export function demoSessionIdentityKey(session: Pick<DemoLoginSession, 'apiBaseUrl' | 'accountId'>): string {
  const api = fictionalReviewApiUrl(session.apiBaseUrl);
  if (!api || !session.accountId) throw new Error('The current account could not be verified.');
  return JSON.stringify([api, session.accountId]);
}

/** Cleanup uses an independent deadline, even when the sign-in attempt was cancelled. */
export async function revokeDemoSessionBounded(session: DemoLoginSession, request: DemoLoginFetch = globalThis.fetch): Promise<void> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
  try { await signOutDemo(session, controller.signal, request); }
  finally { clearTimeout(timer); }
}

/**
 * Prepare a replacement credential, without installing it or ending the old
 * session. The caller keeps the mounted workspace covered until this succeeds,
 * installs the verified replacement, then revokes the superseded credential.
 */
export async function prepareDemoSessionRenewal(input: {
  previous: DemoLoginSession;
  username: string;
  passcode: string;
  scope: WorkspaceBinding | null;
  signal: AbortSignal;
  isCurrent: () => boolean;
  fetch?: DemoLoginFetch;
  now?: () => number;
  port?: Partial<DemoSessionRenewalPort>;
  onUnconfirmedRevocation?: (session: DemoLoginSession) => void;
}): Promise<DemoLoginSession> {
  const base = fictionalReviewApiUrl(input.previous.apiBaseUrl);
  if (!base || !input.previous.accountId || input.scope && (input.scope.accountId !== input.previous.accountId || input.scope.apiBaseUrl !== base)) throw new Error('Reopen the current account before verifying this sign-in.');
  const request = input.fetch ?? globalThis.fetch;
  const port: DemoSessionRenewalPort = {
    signIn: input.port?.signIn ?? ((credentials) => input.previous.accessToken.startsWith('spectator_')
      ? signInSpectatorPin({ ...credentials, fetch: request })
      : signInDemo({ ...credentials, fetch: request, now: input.now })),
    verify: input.port?.verify ?? ((session, signal, scope) => verifyDemoSession(session, signal, request, input.now, scope)),
    revoke: input.port?.revoke ?? (session => revokeDemoSessionBounded(session, request)),
  };
  const current = () => {
    if (input.signal.aborted || !input.isCurrent()) throw new Error('Sign-in verification was cancelled. Try again.');
  };
  const dispose = async (session: DemoLoginSession) => {
    if (session.accessToken === input.previous.accessToken) return;
    const issued = { ...session, apiBaseUrl: base };
    try { await port.revoke(issued); }
    catch { input.onUnconfirmedRevocation?.(issued); }
  };
  let candidate: DemoLoginSession | null = null;
  try {
    current();
    // Never discover or switch to another API while a private workspace is held.
    const signingIn = port.signIn({ apiBaseUrl: base, username: input.username, passcode: input.passcode, signal: input.signal });
    try { candidate = await abortable(signingIn, input.signal); }
    catch (cause) {
      if (input.signal.aborted) void signingIn.then(dispose, () => undefined).catch(() => undefined);
      throw cause;
    }
    current();
    if (demoSessionIdentityKey(candidate) !== demoSessionIdentityKey(input.previous)) throw new Error('Please verify the account that is already open.');
    if (candidate.accessToken === input.previous.accessToken) throw new Error('A new sign-in could not be verified. Please try again.');
    const renewed = { ...candidate, role: input.scope?.role ?? input.previous.role };
    await abortable(port.verify(renewed, input.signal, input.scope), input.signal);
    current();
    return renewed;
  } catch (cause) {
    if (candidate && candidate.accessToken !== input.previous.accessToken) {
      // The credential was issued by the pinned sign-in endpoint. Do not send
      // it to a different origin named by an invalid candidate response.
      await dispose(candidate);
    }
    throw cause;
  }
}
