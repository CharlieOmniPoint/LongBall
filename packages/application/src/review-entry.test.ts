import { describe, expect, it, vi } from 'vitest';
import { discoverFictionalReview, fictionalReviewApiUrl, parseFictionalReviewStatus, REVIEW_IDENTITIES, REVIEW_STATUS_URL, type ReviewFetch } from './review-entry';

const nowMs = Date.parse('2026-10-21T14:00:00Z');
const published = {
  state: 'ready', url: 'https://fictional-review-example.trycloudflare.com',
  sourceRevision: 'c'.repeat(40), startedAt: '2026-10-21T13:30:00Z', expiresAt: '2026-10-21T14:30:00Z',
  runUrl: 'https://github.com/CharlieOmniPoint/LongBall/actions/runs/123', audience: 'Adult review of fictional Roma U10 data only',
};
const health = { status: 'ok', service: 'longball-api', contractVersion: 'longball.events/1.1', backend: 'fictional-sqlite', syntheticOnly: true };
const statusRequest = /^https:\/\/raw\.githubusercontent\.com\/CharlieOmniPoint\/LongBall\/preview\/longball-m0\/preview-status\.json\?reviewCheck=\d{1,16}-\d{1,9}$(?![\s\S])/;
const reply = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
function ready() {
  return vi.fn<ReviewFetch>().mockResolvedValueOnce(reply(published)).mockResolvedValueOnce(reply(health));
}

describe('explicit fictional review entry', () => {
  it('uses four distinct pre-existing identities, keeping administrator and manager authority separate', () => {
    expect(Object.values(REVIEW_IDENTITIES).map(identity => identity.token)).toEqual(['synthetic-manager-2', 'synthetic-admin', 'synthetic-account-player-01', 'synthetic-spectator']);
    expect(new Set(Object.values(REVIEW_IDENTITIES).map(identity => identity.accountId)).size).toBe(4);
    expect(REVIEW_IDENTITIES.manager.accountId).toBe('synthetic-account-manager-2');
    expect(REVIEW_IDENTITIES.administrator.accountId).toBe('synthetic-account-admin');
    expect(Object.values(REVIEW_IDENTITIES).filter(identity => identity.localFallback).map(identity => identity.role)).toEqual(['manager', 'player', 'spectator']);
  });

  it('makes no discovery request before an explicit review choice or after cancellation', async () => {
    const fetch = ready();
    expect(await discoverFictionalReview({ fictionalReviewChosen: false, fetch, now: () => nowMs })).toMatchObject({ status: 'unavailable', reason: 'not_chosen' });
    const cancellation = new AbortController(); cancellation.abort();
    expect(await discoverFictionalReview({ fictionalReviewChosen: true, fetch, signal: cancellation.signal, now: () => nowMs })).toMatchObject({ status: 'unavailable', reason: 'cancelled' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('checks the pinned public status and anonymous fictional health before returning an expiring address', async () => {
    const fetch = ready();
    const result = await discoverFictionalReview({ fictionalReviewChosen: true, fetch, now: () => nowMs });
    expect(result).toEqual({ status: 'available', apiBaseUrl: published.url, sourceRevision: published.sourceRevision, expiresAtMs: Date.parse(published.expiresAt), statusUrl: REVIEW_STATUS_URL });
    expect(fetch.mock.calls[0][0]).toMatch(statusRequest);
    expect(fetch.mock.calls[1][0]).toBe(`${published.url}/health`);
    for (const [, request] of fetch.mock.calls) {
      expect(request).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' } });
      expect(Object.keys(request.headers)).toEqual(['Accept']);
      expect(request).not.toHaveProperty('body');
      expect(JSON.stringify(request)).not.toMatch(/Bearer|synthetic-manager|accessToken|refreshToken/);
    }
  });

  it('supports browser global fetch without supplying an invalid Window receiver', async () => {
    const fetch: ReviewFetch = async function (this: unknown, url) {
      if (this !== undefined) throw new TypeError('Illegal invocation');
      return { ...reply(statusRequest.test(url) ? published : health), url };
    };
    expect(await discoverFictionalReview({ fictionalReviewChosen: true, fetch, now: () => nowMs })).toMatchObject({ status: 'available', apiBaseUrl: published.url });
  });

  it('bypasses a cached canonical status on every check, including retries in one clock tick', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const cache = new Map([[REVIEW_STATUS_URL, { ...published, url: 'https://old-dead-review.trycloudflare.com' }]]);
    const fetch = vi.fn<ReviewFetch>().mockImplementation(async url => {
      if (statusRequest.test(url)) {
        if (!cache.has(url)) cache.set(url, published);
        return { ...reply(cache.get(url)), url };
      }
      if (url === `${published.url}/health`) return { ...reply(health), url };
      throw new Error('An unexpected endpoint must never be requested');
    });
    try {
      const first = await discoverFictionalReview({ fictionalReviewChosen: true, fetch, now: () => nowMs });
      const second = await discoverFictionalReview({ fictionalReviewChosen: true, fetch, now: () => nowMs });
      expect(first).toMatchObject({ status: 'available', apiBaseUrl: published.url, statusUrl: REVIEW_STATUS_URL });
      expect(second).toEqual(first);
      const requests = fetch.mock.calls.map(([url]) => url);
      expect(requests).toHaveLength(4);
      expect(requests[0]).toMatch(statusRequest);
      expect(requests[2]).toMatch(statusRequest);
      expect(requests[0]).not.toBe(requests[2]);
      expect(requests[1]).toBe(`${published.url}/health`);
      expect(requests[3]).toBe(`${published.url}/health`);
      expect(requests).not.toContain(REVIEW_STATUS_URL);
      expect(cache.get(REVIEW_STATUS_URL)?.url).toBe('https://old-dead-review.trycloudflare.com');
    } finally { clock.mockRestore(); }
  });

  it('keeps the public cache key bounded even if the wall clock is invalid or unsafe', async () => {
    const clock = vi.spyOn(Date, 'now');
    const fetch = vi.fn<ReviewFetch>().mockImplementation(async url => ({ ...reply(statusRequest.test(url) ? published : health), url }));
    try {
      for (const observed of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER]) {
        clock.mockReturnValue(observed);
        const result = await discoverFictionalReview({ fictionalReviewChosen: true, fetch, now: () => nowMs });
        expect(result).toMatchObject({ status: 'available', statusUrl: REVIEW_STATUS_URL });
        const url = fetch.mock.calls.at(-2)![0];
        expect(url).toMatch(statusRequest);
        expect(new URL(url).searchParams.get('reviewCheck')?.split('-')[0]).toBe(observed === Number.MAX_SAFE_INTEGER ? String(observed) : '0');
      }
    } finally { clock.mockRestore(); }
  });

  it.each(['canonical', 'different_key', 'extra_query', 'different_path', 'redirect'] as const)('rejects a status response with %s destination instead of the exact requested cache key', async changed => {
    const fetch = vi.fn<ReviewFetch>().mockImplementation(async url => {
      const destination = changed === 'canonical' ? REVIEW_STATUS_URL
        : changed === 'different_key' ? `${REVIEW_STATUS_URL}?reviewCheck=0-0`
        : changed === 'extra_query' ? `${url}&token=not-allowed`
        : changed === 'different_path' ? url.replace('preview-status.json', 'other.json') : url;
      return { ...reply(published), url: destination, redirected: changed === 'redirect' };
    });
    expect(await discoverFictionalReview({ fictionalReviewChosen: true, fetch, now: () => nowMs })).toMatchObject({ status: 'unavailable', reason: 'status_unavailable' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the health response destination exact and unqueried after a valid status response', async () => {
    const fetch = vi.fn<ReviewFetch>().mockImplementation(async url => statusRequest.test(url)
      ? { ...reply(published), url }
      : { ...reply(health), url: `${url}?reviewCheck=0-1` });
    expect(await discoverFictionalReview({ fictionalReviewChosen: true, fetch, now: () => nowMs })).toMatchObject({ status: 'unavailable', reason: 'health_unavailable' });
    expect(fetch.mock.calls[1][0]).toBe(`${published.url}/health`);
    expect(fetch.mock.calls[1][1]).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' } });
  });

  it.each(['starting', 'stopped', 'failed'])('does not contact a %s service', async state => {
    const fetch = vi.fn<ReviewFetch>().mockResolvedValue(reply({ ...published, state }));
    expect(await discoverFictionalReview({ fictionalReviewChosen: true, fetch, now: () => nowMs })).toMatchObject({ status: 'unavailable', reason: 'not_ready' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses an expired service including the exact expiry boundary without contacting it', async () => {
    const fetch = vi.fn<ReviewFetch>().mockResolvedValue(reply({ ...published, expiresAt: '2026-10-21T14:00:00Z' }));
    expect(await discoverFictionalReview({ fictionalReviewChosen: true, fetch, now: () => nowMs })).toMatchObject({ status: 'unavailable', reason: 'expired' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    null, [], {}, { ...published, state: 'pretend-ready' }, { ...published, sourceRevision: '<script>' },
    { ...published, startedAt: '2026-10-21T14:01:00Z' }, { ...published, expiresAt: '2026-02-30T14:00:00Z' },
    { ...published, startedAt: published.expiresAt }, { ...published, expiresAt: 'tomorrow' },
  ])('refuses malformed availability evidence %#', value => {
    expect(parseFictionalReviewStatus(value, nowMs)).toMatchObject({ status: 'unavailable', reason: 'invalid_status' });
  });

  it.each([
    'http://review.trycloudflare.com', 'https://evil.example', 'https://review.trycloudflare.com.evil.example',
    'https://extra.review.trycloudflare.com', 'https://user:secret@review.trycloudflare.com',
    'https://review.trycloudflare.com/private', 'https://review.trycloudflare.com/?token=secret',
    'https://review.trycloudflare.com/#token', 'https://review.trycloudflare.com:443',
    'https://review.trycloudflare.com/%2e%2e', 'https://api.trycloudflare.com',
    'https://review.trycloudflare.com\\@evil.example', 'https://review.trycloudflare.com\n',
  ])('never broadens the allowed tunnel origin: %s', async url => {
    expect(fictionalReviewApiUrl(url)).toBeNull();
    const fetch = vi.fn<ReviewFetch>().mockResolvedValue(reply({ ...published, url }));
    expect(await discoverFictionalReview({ fictionalReviewChosen: true, fetch, now: () => nowMs })).toMatchObject({ status: 'unavailable', reason: 'invalid_status' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('normalises only an optional root slash', () => {
    expect(fictionalReviewApiUrl(`${published.url}/`)).toBe(published.url);
  });

  it.each([
    { ...health, syntheticOnly: false }, { ...health, syntheticOnly: 'true' },
    { ...health, service: 'another-service' }, { ...health, status: 'starting' },
    { ...health, contractVersion: 'unknown' }, null,
  ])('refuses a live endpoint without exact fictional service evidence %#', async value => {
    const fetch = vi.fn<ReviewFetch>().mockResolvedValueOnce(reply(published)).mockResolvedValueOnce(reply(value));
    expect(await discoverFictionalReview({ fictionalReviewChosen: true, fetch, now: () => nowMs })).toMatchObject({ status: 'unavailable', reason: 'not_fictional' });
  });

  it('rechecks expiry after awaiting health instead of opening an already expired service', async () => {
    let observed = nowMs;
    const fetch = vi.fn<ReviewFetch>().mockResolvedValueOnce(reply(published)).mockImplementationOnce(async () => {
      observed = Date.parse(published.expiresAt);
      return reply(health);
    });
    expect(await discoverFictionalReview({ fictionalReviewChosen: true, fetch, now: () => observed })).toMatchObject({ status: 'unavailable', reason: 'expired' });
  });

  it.each(['status', 'health'] as const)('reports a %s network failure without exposing the thrown value', async phase => {
    const fetch = vi.fn<ReviewFetch>();
    if (phase === 'health') fetch.mockResolvedValueOnce(reply(published));
    fetch.mockRejectedValueOnce(new Error('sensitive unrelated diagnostic'));
    const result = await discoverFictionalReview({ fictionalReviewChosen: true, fetch, now: () => nowMs });
    expect(result).toMatchObject({ status: 'unavailable', reason: phase === 'status' ? 'status_unavailable' : 'health_unavailable' });
    expect(JSON.stringify(result)).not.toContain('sensitive');
  });

  it('rejects redirects, changed response destinations and oversized or malformed status bodies', async () => {
    for (const response of [
      { ...reply(published), redirected: true }, { ...reply(published), url: 'https://other.example/status.json' },
      { ...reply(published), text: async () => 'x'.repeat(16_385) }, { ...reply(published), text: async () => '{invalid' },
      { ...reply(published), ok: false, status: 503 },
    ]) {
      const fetch = vi.fn<ReviewFetch>().mockResolvedValue(response);
      expect(await discoverFictionalReview({ fictionalReviewChosen: true, fetch, now: () => nowMs })).toMatchObject({ status: 'unavailable', reason: 'status_unavailable' });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it.each(['request', 'body'] as const)('bounds a stalled %s even when its adapter ignores abort', async stall => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn<ReviewFetch>();
      if (stall === 'request') fetch.mockImplementation(() => new Promise(() => undefined));
      else fetch.mockResolvedValue({ ...reply(published), text: () => new Promise(() => undefined) });
      const pending = discoverFictionalReview({ fictionalReviewChosen: true, fetch, now: () => nowMs, timeoutMs: 500 });
      await vi.advanceTimersByTimeAsync(500);
      expect(await pending).toMatchObject({ status: 'unavailable', reason: 'timeout' });
      expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('cancels an in-flight check without exposing an address to a no-longer-current entry', async () => {
    const cancellation = new AbortController();
    const fetch = vi.fn<ReviewFetch>().mockImplementation(() => new Promise(() => undefined));
    const pending = discoverFictionalReview({ fictionalReviewChosen: true, fetch, now: () => nowMs, signal: cancellation.signal });
    cancellation.abort();
    expect(await pending).toMatchObject({ status: 'unavailable', reason: 'cancelled' });
  });
});
