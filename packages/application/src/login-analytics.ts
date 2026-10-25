import { AccessError } from './access';

export const LOGIN_ACTIVITY_WINDOW_MS = 15 * 60_000;
export const LOGIN_REPORT_MAX_EVENTS = 20_000;
export const LOGIN_REPORT_PAGE_SIZE = 50;
export type LoginAnalyticsRole = 'super_admin' | 'club_admin' | 'manager' | 'player' | 'spectator';
export type LoginAnalyticsEventType = 'login_success' | 'login_failure' | 'logout';
export type LoginAnalyticsProvider = 'demo' | 'spectator_pin' | 'oidc';
export interface LoginAnalyticsQuery { range: '24h' | '7d' | '30d'; clubId?: string; teamId?: string; role?: LoginAnalyticsRole; event?: LoginAnalyticsEventType; cursor?: string }
export interface LoginAnalyticsScope { clubId: string; clubName: string; teamId: string; teamName: string; seasonId: string; role: LoginAnalyticsRole }
export interface LoginAnalyticsEvent { id: string; at: number; type: LoginAnalyticsEventType; provider: LoginAnalyticsProvider; accountId: string | null; actorLabel: string | null; role: LoginAnalyticsRole | null; scopes: LoginAnalyticsScope[]; reason: string | null; count: number }
export interface LoginAnalyticsDto {
  kind: 'login-analytics';
  observedAt: number;
  eventAsOf: number;
  from: number;
  filters: LoginAnalyticsQuery;
  summary: { signIns: number; failedAttempts: number; uniqueAccounts: number; activeAccounts: number; activeSessions: number | null; enabledAccounts: number; lastSignInAt: number | null };
  directory: { clubs: { id: string; name: string }[]; teams: { id: string; clubId: string; name: string; ageGroup: string }[] };
  trend: { from: number; to: number; signIns: number; failedAttempts: number; uniqueAccounts: number }[];
  roles: { role: LoginAnalyticsRole; label: string; signIns: number; uniqueAccounts: number; activeAccounts: number }[];
  clubs: { clubId: string; clubName: string; teamCount: number; signIns: number; uniqueAccounts: number; activeAccounts: number; lastSeenAt: number | null }[];
  teams: { teamId: string; teamName: string; clubId: string; clubName: string; ageGroup: string; signIns: number; uniqueAccounts: number; activeAccounts: number; lastSeenAt: number | null }[];
  activeUsers: { accountId: string; label: string; role: LoginAnalyticsRole; lastSeenAt: number; sessionCount: number | null; scopes: LoginAnalyticsScope[] }[];
  events: LoginAnalyticsEvent[];
  page: { nextCursor: string | null; limit: 50 };
  coverage: { startedAt: number | null; eventRowsTruncated: boolean; activityRowsTruncated: boolean; scopeRowsTruncated: boolean; eventLimit: 20000; activityWindowMinutes: 15; pollingIncluded: true; upstreamProviderFailuresIncluded: false; collectionHealthy: boolean };
  definitions: string[];
}
export const LOGIN_ROLE_LABELS: Record<LoginAnalyticsRole,string> = { super_admin:'Super Admin',club_admin:'Club Admin',manager:'Manager',player:'Player',spectator:'Spectator' };
const id = (v: string) => /^[A-Za-z0-9_-]{1,150}$/.test(v);
export function parseLoginAnalyticsQuery(parameters: URLSearchParams): LoginAnalyticsQuery {
  const known = ['range','clubId','teamId','role','event','cursor'];
  if ([...parameters.keys()].some(key => !known.includes(key) || parameters.getAll(key).length !== 1)) throw new AccessError('INVALID_LOGIN_REPORT_QUERY',400,'Use one documented login-report filter per field.');
  const range = parameters.get('range') ?? '7d', clubId=parameters.get('clubId')??undefined, teamId=parameters.get('teamId')??undefined, role=parameters.get('role')??undefined, event=parameters.get('event')??undefined, cursor=parameters.get('cursor')??undefined;
  if (!['24h','7d','30d'].includes(range) || clubId!==undefined&&!id(clubId) || teamId!==undefined&&!id(teamId) || role!==undefined&&!Object.hasOwn(LOGIN_ROLE_LABELS,role) || event!==undefined&&!['login_success','login_failure','logout'].includes(event) || cursor!==undefined&&!/^2\.\d{1,16}\.\d{1,16}\.\d{1,16}\.[A-Za-z0-9_-]{1,150}\.[a-f0-9]{16}$/.test(cursor)) throw new AccessError('INVALID_LOGIN_REPORT_QUERY',400,'Choose a supported period, club, team, account type or event filter.');
  if(cursor){const [,asOf,highWater,at]=cursor.split('.');if(!Number.isSafeInteger(Number(asOf))||!Number.isSafeInteger(Number(highWater))||!Number.isSafeInteger(Number(at))||Number(at)>Number(asOf))throw new AccessError('INVALID_LOGIN_REPORT_QUERY',400,'Use the returned login event cursor.');}
  return {range:range as LoginAnalyticsQuery['range'],...(clubId?{clubId}:{}),...(teamId?{teamId}:{}),...(role?{role:role as LoginAnalyticsRole}:{}),...(event?{event:event as LoginAnalyticsEventType}:{}),...(cursor?{cursor}:{})};
}
