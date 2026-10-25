import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoginAnalyticsDto, LoginAnalyticsEvent } from '@longball/application/login-analytics';
import { appendLoginActivityEvents, loginActivityPath, loginTrendPoints, parseLoginActivity, recordedLoginTrend, startLoginActivityRefresh } from './login-activity';

const now = Date.parse('2026-10-25T14:00:00Z');
const cursor = (id = 'event-1') => `2.${now}.500.${now - 1_000}.${id}.0123456789abcdef`;
const event = (id = 'event-1'): LoginAnalyticsEvent => ({ id, at: now - 1_000, type: 'login_success', provider: 'demo', accountId: 'account-1', actorLabel: 'Thomas Arnold', role: 'player', scopes: [{ clubId: 'club-1', clubName: 'Roma Club', teamId: 'team-1', teamName: 'Roma', seasonId: 'season-1', role: 'player' }], reason: null, count: 1 });
const report = (): LoginAnalyticsDto => ({
  kind: 'login-analytics', observedAt: now, eventAsOf: now, from: now - 7 * 86_400_000, filters: { range: '7d' },
  summary: { signIns: 1, failedAttempts: 0, uniqueAccounts: 1, activeAccounts: 1, activeSessions: null, enabledAccounts: 8, lastSignInAt: now - 1_000 },
  directory: { clubs: [{ id: 'club-1', name: 'Roma Club' }], teams: [{ id: 'team-1', clubId: 'club-1', name: 'Roma', ageGroup: 'U10' }] },
  trend: [{ from: now - 86_400_000, to: now, signIns: 1, failedAttempts: 0, uniqueAccounts: 1 }],
  roles: [{ role: 'player', label: 'Player', signIns: 1, uniqueAccounts: 1, activeAccounts: 1 }],
  clubs: [{ clubId: 'club-1', clubName: 'Roma Club', teamCount: 1, signIns: 1, uniqueAccounts: 1, activeAccounts: 1, lastSeenAt: now }],
  teams: [{ teamId: 'team-1', teamName: 'Roma', clubId: 'club-1', clubName: 'Roma Club', ageGroup: 'U10', signIns: 1, uniqueAccounts: 1, activeAccounts: 1, lastSeenAt: now }],
  activeUsers: [{ accountId: 'account-1', label: 'Thomas Arnold', role: 'player', lastSeenAt: now, sessionCount: null, scopes: event().scopes }],
  events: [event()], page: { nextCursor: null, limit: 50 },
  coverage: { startedAt: now - 86_400_000, eventRowsTruncated: false, activityRowsTruncated: false, scopeRowsTruncated: false, eventLimit: 20000, activityWindowMinutes: 15, pollingIncluded: true, upstreamProviderFailuresIncluded: false, collectionHealthy: true },
  definitions: ['Active accounts were observed in the last 15 minutes.'],
});
afterEach(() => vi.useRealTimers());

describe('stable expanded login history', () => {
  it('keeps older loaded pages through automatic ticks, while explicit refresh remains available and resumes the cadence', async () => {
    vi.useFakeTimers();
    let expanded = false;
    const read = vi.fn(async (_signal: AbortSignal) => undefined);
    const refresh = startLoginActivityRefresh({ read, automaticPaused: () => expanded }, true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(1);
    expanded = true;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(read).toHaveBeenCalledTimes(1);
    // The dashboard's explicit refresh calls the same read directly, not the automatic scheduler.
    await read(new AbortController().signal);
    expect(read).toHaveBeenCalledTimes(2);
    expanded = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(3);
    refresh.setForeground(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(3);
    refresh.stop();
  });
});

describe('login report client receipts and pagination', () => {
  it('builds validated filters and preserves opaque event cursors exactly', () => {
    const opaque = cursor();
    const path = loginActivityPath({ range: '24h', clubId: 'club-1', teamId: 'team-1', role: 'player', event: 'login_success', cursor: opaque });
    const url = new URL(path, 'https://demo.example.invalid');
    expect(url.pathname).toBe('/v1/administration/login-analytics');
    expect(Object.fromEntries(url.searchParams)).toEqual({ range: '24h', clubId: 'club-1', teamId: 'team-1', role: 'player', event: 'login_success', cursor: opaque });
    expect(() => loginActivityPath({ range: '7d', clubId: '../other-club' })).toThrow();
    expect(() => loginActivityPath({ range: '7d', cursor: 'unbound-old-format' })).toThrow();
    expect(() => loginActivityPath({ range: '7d', cursor: `1.${now}.${now - 1_000}.event-1.0123456789abcdef` })).toThrow();
  });
  it('adopts only the documented data and discards unexpected private fields at every nested boundary', () => {
    const valid = report();
    const input = { ...valid, token: 'never-retain', summary: { ...valid.summary, password: 'never-retain' }, events: [{ ...valid.events[0], token: 'never-retain', scopes: [{ ...valid.events[0].scopes[0], verifier: 'never-retain' }] }], activeUsers: [{ ...valid.activeUsers[0], token: 'never-retain' }] };
    const parsed = parseLoginActivity(input);
    expect(parsed).toEqual(valid);
    expect(JSON.stringify(parsed)).not.toContain('never-retain');
    expect(parsed.events).not.toBe(input.events);
    expect(parsed.events[0].scopes).not.toBe(input.events[0].scopes);
  });
  it('refuses malformed counts, roles, time boundaries and cursors rather than presenting empty or misleading data', () => {
    const valid = report();
    for (const value of [
      null, [], { ...valid, kind: 'other' }, { ...valid, eventAsOf: now + 1 }, { ...valid, from: now + 1 },
      { ...valid, summary: { ...valid.summary, activeAccounts: -1 } },
      { ...valid, events: [{ ...event(), role: 'owner' }] },
      { ...valid, events: [{ ...event(), at: Number.NaN }] },
      { ...valid, events: [{ ...event(), count: 0 }] },
      { ...valid, page: { nextCursor: 'not-a-bound-cursor', limit: 50 } },
      { ...valid, coverage: { ...valid.coverage, activityWindowMinutes: 60 } },
      { ...valid, coverage: { ...valid.coverage, collectionHealthy: 'true' } },
    ]) expect(() => parseLoginActivity(value)).toThrow('could not be verified');
  });
  it('appends events only to the same filter and event snapshot, deduplicating IDs without refreshing the summary', () => {
    const previous = { ...report(), page: { nextCursor: cursor(), limit: 50 as const } }, next = { ...report(), filters: { range: '7d' as const, cursor: cursor() }, observedAt: now + 10_000, events: [event(), event('event-2')], summary: { ...previous.summary, activeAccounts: 3 } };
    const result = appendLoginActivityEvents(previous, next);
    expect(result.events.map(row => row.id)).toEqual(['event-1', 'event-2']);
    expect(result.observedAt).toBe(now);
    expect(result.summary).toBe(previous.summary);
    expect(() => appendLoginActivityEvents(previous, { ...next, filters: { range: '7d', clubId: 'different' } })).toThrow('scope or event snapshot');
    expect(() => appendLoginActivityEvents(previous, { ...next, eventAsOf: now + 1 })).toThrow('scope or event snapshot');
    expect(() => appendLoginActivityEvents(previous, { ...next, from: previous.from + 1 })).toThrow('scope or event snapshot');
    expect(() => appendLoginActivityEvents(previous, { ...next, filters: { ...next.filters, cursor: cursor().replace('.500.', '.501.') } })).toThrow('scope or event snapshot');
  });
  it('bounds retained rows on small devices and removes the continuation once 500 events are loaded', () => {
    const previous = { ...report(), page: { nextCursor: cursor('old-489'), limit: 50 as const }, events: Array.from({ length: 490 }, (_, i) => event(`old-${i}`)) };
    const next = { ...report(), filters: { range: '7d' as const, cursor: cursor('old-489') }, events: Array.from({ length: 50 }, (_, i) => event(`next-${i}`)), page: { nextCursor: cursor('next-49'), limit: 50 as const } };
    const result = appendLoginActivityEvents(previous, next);
    expect(result.events).toHaveLength(500);
    expect(result.page.nextCursor).toBeNull();
  });
});

describe('honest login chart scales', () => {
  it('omits unknown history before collection began rather than inventing zero activity', () => {
    const data = report(), start = now - 30 * 60_000;
    const buckets = [{ from: now - 2 * 86_400_000, to: start, signIns: 0, failedAttempts: 0, uniqueAccounts: 0 }, { from: start - 1_000, to: now, signIns: 1, failedAttempts: 0, uniqueAccounts: 1 }];
    expect(recordedLoginTrend({ ...data, trend: buckets, coverage: { ...data.coverage, startedAt: null } })).toEqual([]);
    expect(recordedLoginTrend({ ...data, trend: buckets, coverage: { ...data.coverage, startedAt: start } })).toEqual([buckets[1]]);
    const instant = { from: start, to: start, signIns: 1, failedAttempts: 0, uniqueAccounts: 1 };
    expect(recordedLoginTrend({ ...data, trend: [instant], coverage: { ...data.coverage, startedAt: start } })).toEqual([instant]);
    expect(parseLoginActivity({ ...data, trend: [instant] }).trend).toEqual([instant]);
  });
  it('keeps zero and single-bucket reports finite and never invents activity', () => {
    expect(loginTrendPoints([]).points).toEqual([]);
    expect(loginTrendPoints([0]).points).toEqual([{ x: 300, y: 134 }]);
    expect(loginTrendPoints([0, 0, 0]).points.every(point => point.y === 134)).toBe(true);
    expect(loginTrendPoints([0, 0]).line).not.toMatch(/NaN|Infinity/);
    expect(() => loginTrendPoints([-1])).toThrow();
  });
  it('uses the same scale for successful and failed attempts so a small series is not visually exaggerated', () => {
    const successful = loginTrendPoints([1, 0], 600, 100, 10), failures = loginTrendPoints([10, 0], 600, 100, 10);
    expect(successful.points[0].y).toBe(90);
    expect(failures.points[0].y).toBe(0);
  });
});
