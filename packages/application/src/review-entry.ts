import { demoAccountLabels } from '@longball/testing';

/** Public fictional review identities. These strings are never production credentials or role grants. */
export type ReviewRole = 'manager' | 'administrator' | 'player' | 'spectator';
export interface ReviewIdentity {
  readonly role: ReviewRole;
  readonly label: string;
  readonly token: string;
  readonly accountId: string;
  readonly localFallback: boolean;
}
export const REVIEW_IDENTITIES: Readonly<Record<ReviewRole, ReviewIdentity>> = Object.freeze({
  manager: Object.freeze({ role: 'manager', label: 'Roma U10 manager', token: 'synthetic-manager-2', accountId: 'synthetic-account-manager-2', localFallback: true }),
  administrator: Object.freeze({ role: 'administrator', label: 'Sam Taylor', token: 'synthetic-admin', accountId: 'synthetic-account-admin', localFallback: false }),
  player: Object.freeze({ role: 'player', label: demoAccountLabels['synthetic-account-player-01'], token: 'synthetic-account-player-01', accountId: 'synthetic-account-player-01', localFallback: true }),
  spectator: Object.freeze({ role: 'spectator', label: 'Jamie Bennett', token: 'synthetic-spectator', accountId: 'synthetic-account-spectator', localFallback: true }),
});

export const REVIEW_STATUS_URL = 'https://raw.githubusercontent.com/CharlieOmniPoint/LongBall/preview/longball-m0/preview-status.json';
const WIRE_VERSION = 'longball.events/1.1';
const MAX_RESPONSE_CHARACTERS = 16_384;
let statusRequestSequence = 0;

/** Public cache key only; never an identity, credential or configurable URL. */
function freshStatusRequestUrl(): string {
  // GitHub's edge cache may retain the canonical key despite cache: 'no-store'.
  // The counter also separates explicit retries within one wall-clock tick.
  const wallClock = Date.now();
  const timestamp = Number.isSafeInteger(wallClock) && wallClock >= 0 ? wallClock : 0;
  statusRequestSequence = statusRequestSequence >= 999_999_999 ? 1 : statusRequestSequence + 1;
  return `${REVIEW_STATUS_URL}?reviewCheck=${timestamp}-${statusRequestSequence}`;
}

export type ReviewUnavailableReason = 'not_chosen' | 'not_ready' | 'expired' | 'invalid_status' | 'status_unavailable' | 'health_unavailable' | 'not_fictional' | 'cancelled' | 'timeout';
export interface ReviewUnavailable { status: 'unavailable'; reason: ReviewUnavailableReason; message: string }
export interface ReviewAvailable {
  status: 'available';
  apiBaseUrl: string;
  sourceRevision: string;
  expiresAtMs: number;
  statusUrl: typeof REVIEW_STATUS_URL;
}
export type ReviewDiscovery = ReviewAvailable | ReviewUnavailable;
export interface ReviewResponse {
  ok: boolean;
  status: number;
  redirected?: boolean;
  url?: string;
  text(): Promise<string>;
}
/** Pass anonymous global fetch, never an OIDC/authenticated service adapter. */
export type ReviewFetch = (url: string, options: {
  method: 'GET';
  headers: Record<string, string>;
  credentials: 'omit';
  redirect: 'error';
  cache: 'no-store';
  signal: AbortSignal;
}) => Promise<ReviewResponse>;

function unavailable(reason: ReviewUnavailableReason, message: string): ReviewUnavailable {
  return { status: 'unavailable', reason, message };
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function utcTime(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== (value.includes('.') ? value : value.replace('Z', '.000Z'))) return null;
  return time;
}
/** Only the root of one ASCII tunnel hostname is allowed; URL normalisation cannot broaden this set. */
export function fictionalReviewApiUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com\/?$/.test(value)) return null;
  const url = new URL(value);
  if (url.hostname === 'api.trycloudflare.com') return null;
  return url.origin;
}
/** Status is availability evidence, never an account, membership, or authority assertion. */
export function parseFictionalReviewStatus(value: unknown, nowMs: number): ReviewDiscovery {
  if (!object(value) || !Number.isFinite(nowMs) || !['ready', 'starting', 'stopped', 'failed'].includes(String(value.state))) return unavailable('invalid_status', 'The published demo service status is invalid.');
  if (value.state !== 'ready') return unavailable('not_ready', 'The temporary demo service is not running.');
  const apiBaseUrl = fictionalReviewApiUrl(value.url);
  const startedAtMs = utcTime(value.startedAt), expiresAtMs = utcTime(value.expiresAt);
  if (!apiBaseUrl || startedAtMs === null || expiresAtMs === null || startedAtMs >= expiresAtMs || startedAtMs > nowMs || typeof value.sourceRevision !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.sourceRevision)) return unavailable('invalid_status', 'The published demo service address, lifetime or source revision is invalid.');
  if (expiresAtMs <= nowMs) return unavailable('expired', 'The temporary demo service expired. Choose a local rehearsal or try again after it is renewed.');
  return { status: 'available', apiBaseUrl, sourceRevision: value.sourceRevision, expiresAtMs, statusUrl: REVIEW_STATUS_URL };
}

/** Called only after an explicit fictional-review choice. No OIDC token, cookie or fixture token is sent. */
export async function discoverFictionalReview(options: {
  fictionalReviewChosen: boolean;
  fetch: ReviewFetch;
  now?: () => number;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ReviewDiscovery> {
  if (!options.fictionalReviewChosen) return unavailable('not_chosen', 'Choose demo review before looking for its temporary service.');
  if (options.signal?.aborted) return unavailable('cancelled', 'Demo service discovery was cancelled.');
  const now = options.now ?? Date.now;
  const controller = new AbortController();
  let abortedAs: 'cancelled' | 'timeout' | null = null;
  const timeoutMs = options.timeoutMs ?? 8_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) return unavailable('invalid_status', 'The demo service discovery deadline is invalid.');
  let rejectAbort: (reason: Error) => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = (reason: 'cancelled' | 'timeout') => {
    if (abortedAs) return;
    abortedAs = reason;
    controller.abort();
    rejectAbort(new Error(reason));
  };
  const cancel = () => abort('cancelled');
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => abort('timeout'), timeoutMs);
  let phase: 'status' | 'health' = 'status';
  try {
    // Browser fetch accepts an unbound call, but rejects an arbitrary object as
    // its receiver. Do not invoke a supplied global fetch as an options method.
    const fetchReview = options.fetch;
    const read = async (url: string): Promise<unknown> => {
      const response = await Promise.race([fetchReview(url, { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal }), aborted]);
      if (!response.ok || response.redirected || response.url && response.url !== url) throw new Error('Unavailable endpoint');
      const body = await Promise.race([response.text(), aborted]);
      if (body.length > MAX_RESPONSE_CHARACTERS) throw new Error('Oversized response');
      return JSON.parse(body) as unknown;
    };
    const status = parseFictionalReviewStatus(await read(freshStatusRequestUrl()), now());
    if (status.status === 'unavailable') return status;
    phase = 'health';
    const health = await read(`${status.apiBaseUrl}/health`);
    if (!object(health) || health.status !== 'ok' || health.service !== 'longball-api' || health.syntheticOnly !== true || health.contractVersion !== WIRE_VERSION) return unavailable('not_fictional', 'This endpoint did not verify the demo LongBall review service. No account was opened.');
    if (status.expiresAtMs <= now()) return unavailable('expired', 'The temporary demo service expired while it was being checked.');
    return status;
  } catch {
    if (abortedAs === 'cancelled') return unavailable('cancelled', 'Demo service discovery was cancelled.');
    if (abortedAs === 'timeout') return unavailable('timeout', 'The temporary demo service did not answer in time. Local rehearsal remains available.');
    return phase === 'status'
      ? unavailable('status_unavailable', 'The published demo service status could not be checked. Local rehearsal remains available.')
      : unavailable('health_unavailable', 'The temporary demo service could not be reached. Local rehearsal remains available.');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}
