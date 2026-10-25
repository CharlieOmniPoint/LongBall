import type { LoginAnalyticsDto, LoginAnalyticsQuery } from '@longball/application/login-analytics';
import { LOGIN_ROLE_LABELS, parseLoginAnalyticsQuery } from '@longball/application/login-analytics';
import { startForegroundRefresh, type ForegroundRefresh } from '@longball/application/foreground-refresh';

const endpoint = '/v1/administration/login-analytics';
/** A paginated history remains stable until its reader explicitly asks for a fresh page. */
export function startLoginActivityRefresh(port: { read: (signal: AbortSignal) => Promise<void>; automaticPaused: () => boolean }, initiallyForeground: boolean): ForegroundRefresh {
  return startForegroundRefresh({ read: async signal => { if (!port.automaticPaused()) await port.read(signal); }, intervalMs: () => 60_000 }, initiallyForeground);
}
export function loginActivityPath(query: LoginAnalyticsQuery): string {
  const parameters = new URLSearchParams();
  for (const key of ['range', 'clubId', 'teamId', 'role', 'event', 'cursor'] as const) if (query[key]) parameters.set(key, query[key]!);
  parseLoginAnalyticsQuery(parameters);
  return `${endpoint}?${parameters}`;
}
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const text = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const number = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const time = (v: unknown) => number(v) && Number(v) <= 8.64e15;
const nullableTime = (v: unknown) => v === null || time(v);
const role = (v: unknown) => typeof v === 'string' && Object.hasOwn(LOGIN_ROLE_LABELS, v);
const list = (v: unknown, max: number, check: (v: Record<string, unknown>) => boolean): boolean => Array.isArray(v) && v.length <= max && v.every(row => object(row) && check(row));
const scope = (v: Record<string, unknown>) => text(v.clubId, 150) && text(v.clubName) && text(v.teamId, 150) && text(v.teamName) && text(v.seasonId, 150) && role(v.role);
function invalid(): never { throw new Error('The login activity report could not be verified. Refresh to try again.'); }

/** Treat a malformed receipt as unavailable, never as a zero-activity report. */
export function parseLoginActivity(value: unknown): LoginAnalyticsDto {
  if (!object(value) || value.kind !== 'login-analytics' || !time(value.observedAt) || !time(value.eventAsOf) || Number(value.eventAsOf) > Number(value.observedAt) || !time(value.from) || Number(value.from) > Number(value.eventAsOf) || !object(value.filters) || !object(value.summary) || !object(value.directory) || !object(value.page) || !object(value.coverage)) invalid();
  const parameters = new URLSearchParams();
  for (const [key, v] of Object.entries(value.filters)) { if (typeof v !== 'string') invalid(); parameters.set(key, v); }
  try { parseLoginAnalyticsQuery(parameters); } catch { invalid(); }
  const summary = value.summary;
  if (!['signIns', 'failedAttempts', 'uniqueAccounts', 'activeAccounts', 'enabledAccounts'].every(key => number(summary[key])) || !(summary.activeSessions === null || number(summary.activeSessions)) || !nullableTime(summary.lastSignInAt)) invalid();
  if (!list(value.directory.clubs, 20000, v => text(v.id, 150) && text(v.name)) || !list(value.directory.teams, 20000, v => text(v.id, 150) && text(v.clubId, 150) && text(v.name) && text(v.ageGroup, 20))) invalid();
  if (!list(value.trend, 100, v => time(v.from) && time(v.to) && Number(v.from) <= Number(v.to) && ['signIns', 'failedAttempts', 'uniqueAccounts'].every(key => number(v[key]))) || !list(value.roles, 5, v => role(v.role) && text(v.label) && ['signIns', 'uniqueAccounts', 'activeAccounts'].every(key => number(v[key])))) invalid();
  if (!list(value.clubs, 20000, v => text(v.clubId, 150) && text(v.clubName) && ['teamCount', 'signIns', 'uniqueAccounts', 'activeAccounts'].every(key => number(v[key])) && nullableTime(v.lastSeenAt)) || !list(value.teams, 20000, v => text(v.teamId, 150) && text(v.teamName) && text(v.clubId, 150) && text(v.clubName) && text(v.ageGroup, 20) && ['signIns', 'uniqueAccounts', 'activeAccounts'].every(key => number(v[key])) && nullableTime(v.lastSeenAt))) invalid();
  if (!list(value.activeUsers, 500, v => text(v.accountId, 150) && text(v.label) && role(v.role) && time(v.lastSeenAt) && (v.sessionCount === null || number(v.sessionCount)) && list(v.scopes, 20000, scope))) invalid();
  if (!list(value.events, 50, v => text(v.id, 150) && time(v.at) && ['login_success', 'login_failure', 'logout'].includes(String(v.type)) && ['demo', 'spectator_pin', 'oidc'].includes(String(v.provider)) && (v.accountId === null || text(v.accountId, 150)) && (v.actorLabel === null || text(v.actorLabel)) && (v.role === null || role(v.role)) && (v.reason === null || text(v.reason)) && number(v.count) && Number(v.count) > 0 && list(v.scopes, 20000, scope))) invalid();
  if (value.page.limit !== 50 || !(value.page.nextCursor === null || typeof value.page.nextCursor === 'string')) invalid();
  if (value.page.nextCursor !== null) {
    try { const next = new URLSearchParams(parameters); next.set('cursor', String(value.page.nextCursor)); parseLoginAnalyticsQuery(next); } catch { invalid(); }
  }
  const coverage = value.coverage;
  if (!nullableTime(coverage.startedAt) || !['eventRowsTruncated', 'activityRowsTruncated', 'scopeRowsTruncated', 'collectionHealthy'].every(key => typeof coverage[key] === 'boolean') || coverage.eventLimit !== 20000 || coverage.activityWindowMinutes !== 15 || coverage.pollingIncluded !== true || coverage.upstreamProviderFailuresIncluded !== false || !Array.isArray(value.definitions) || value.definitions.length > 20 || !value.definitions.every(v => text(v, 500))) invalid();
  const dto = value as unknown as LoginAnalyticsDto;
  const pick = <T, K extends keyof T>(v: T, keys: readonly K[]): Pick<T, K> => Object.fromEntries(keys.map(key => [key, v[key]])) as Pick<T, K>;
  const scopes = (rows: LoginAnalyticsDto['events'][number]['scopes']) => rows.map(row => pick(row, ['clubId', 'clubName', 'teamId', 'teamName', 'seasonId', 'role']));
  return {
    kind: 'login-analytics', observedAt: dto.observedAt, eventAsOf: dto.eventAsOf, from: dto.from, filters: parseLoginAnalyticsQuery(parameters),
    summary: pick(dto.summary, ['signIns', 'failedAttempts', 'uniqueAccounts', 'activeAccounts', 'activeSessions', 'enabledAccounts', 'lastSignInAt']),
    directory: { clubs: dto.directory.clubs.map(row => pick(row, ['id', 'name'])), teams: dto.directory.teams.map(row => pick(row, ['id', 'clubId', 'name', 'ageGroup'])) },
    trend: dto.trend.map(row => pick(row, ['from', 'to', 'signIns', 'failedAttempts', 'uniqueAccounts'])),
    roles: dto.roles.map(row => pick(row, ['role', 'label', 'signIns', 'uniqueAccounts', 'activeAccounts'])),
    clubs: dto.clubs.map(row => pick(row, ['clubId', 'clubName', 'teamCount', 'signIns', 'uniqueAccounts', 'activeAccounts', 'lastSeenAt'])),
    teams: dto.teams.map(row => pick(row, ['teamId', 'teamName', 'clubId', 'clubName', 'ageGroup', 'signIns', 'uniqueAccounts', 'activeAccounts', 'lastSeenAt'])),
    activeUsers: dto.activeUsers.map(row => ({ ...pick(row, ['accountId', 'label', 'role', 'lastSeenAt', 'sessionCount']), scopes: scopes(row.scopes) })),
    events: dto.events.map(row => ({ ...pick(row, ['id', 'at', 'type', 'provider', 'accountId', 'actorLabel', 'role', 'reason', 'count']), scopes: scopes(row.scopes) })),
    page: pick(dto.page, ['nextCursor', 'limit']), coverage: pick(dto.coverage, ['startedAt', 'eventRowsTruncated', 'activityRowsTruncated', 'scopeRowsTruncated', 'eventLimit', 'activityWindowMinutes', 'pollingIncluded', 'upstreamProviderFailuresIncluded', 'collectionHealthy']), definitions: [...dto.definitions],
  };
}

export function sameLoginActivityFilters(a: LoginAnalyticsQuery, b: LoginAnalyticsQuery): boolean {
  return (['range', 'clubId', 'teamId', 'role', 'event'] as const).every(key => a[key] === b[key]);
}
export function recordedLoginTrend(report: LoginAnalyticsDto): LoginAnalyticsDto['trend'] {
  return report.coverage.startedAt === null ? [] : report.trend.filter(row => row.to > report.coverage.startedAt! || row.from === row.to && row.to === report.coverage.startedAt);
}
export function appendLoginActivityEvents(previous: LoginAnalyticsDto, next: LoginAnalyticsDto): LoginAnalyticsDto {
  if (!previous.page.nextCursor || previous.page.nextCursor !== next.filters.cursor || !sameLoginActivityFilters(previous.filters, next.filters) || previous.eventAsOf !== next.eventAsOf || previous.from !== next.from) throw new Error('The report scope or event snapshot changed. Refresh the current view.');
  const events = [...previous.events], ids = new Set(events.map(event => event.id));
  for (const event of next.events) if (!ids.has(event.id)) { ids.add(event.id); events.push(event); }
  return { ...previous, events: events.slice(0, 500), page: { ...next.page, nextCursor: events.length >= 500 ? null : next.page.nextCursor } };
}

export function loginTrendPoints(values: readonly number[], width = 600, height = 134, scaleMaximum = 1): { line: string; area: string; maximum: number; points: { x: number; y: number }[] } {
  if (!values.length) return { line: '', area: '', maximum: 1, points: [] };
  if (values.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('Trend counts must be nonnegative integers.');
  const maximum = Math.max(1, scaleMaximum, ...values), points = values.map((value, i) => ({ x: values.length === 1 ? width / 2 : i * width / (values.length - 1), y: height - value / maximum * height }));
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
  return { line, area: `${line} L ${points.at(-1)!.x.toFixed(2)} ${height} L ${points[0].x.toFixed(2)} ${height} Z`, maximum, points };
}
