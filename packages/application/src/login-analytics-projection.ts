import { sha256 } from '@noble/hashes/sha2.js';
import { AccessError } from './access';
import {
  LOGIN_ACTIVITY_WINDOW_MS, LOGIN_REPORT_MAX_EVENTS, LOGIN_REPORT_PAGE_SIZE, LOGIN_ROLE_LABELS,
  type LoginAnalyticsDto, type LoginAnalyticsEvent, type LoginAnalyticsProvider,
  type LoginAnalyticsQuery, type LoginAnalyticsRole, type LoginAnalyticsScope,
} from './login-analytics';
import { londonDateKey, UK_TIME_ZONE } from './uk-display';

export interface AnalyticsAccount { accountId: string; label: string; role: LoginAnalyticsRole; enabled: boolean; scopes: LoginAnalyticsScope[] }
export interface AnalyticsSession { sessionId: string; accountId: string; label: string; role: LoginAnalyticsRole; provider: LoginAnalyticsProvider; issuedAtMs: number; expiresAtMs: number | null; lastSeenAt: number; endedAt: number | null; runtimeId: string; scopes: LoginAnalyticsScope[] }
export interface LoginAnalyticsSnapshot { events: (LoginAnalyticsEvent & {ordinal?: number})[]; sessions: AnalyticsSession[]; accounts: AnalyticsAccount[]; directory: LoginAnalyticsDto['directory']; startedAt: number | null; eventRowsTruncated: boolean; activityRowsTruncated: boolean; scopeRowsTruncated: boolean; enabledAccountsCount?: number; activityAccountsVerified?: true; eventHighWater?: number }
const dayMs = 86_400_000;
const calendarParts = new Intl.DateTimeFormat('en-GB', { timeZone: UK_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function shiftDay(key: string, count: number): string { const day = new Date(`${key}T12:00:00Z`); day.setUTCDate(day.getUTCDate()+count); return day.toISOString().slice(0,10); }
/** UK midnight is unique even on the spring/fall clock-change days. */
function midnight(key: string): number {
  const [year, month, day] = key.split('-').map(Number), target = Date.UTC(year,month-1,day);
  let value=target;
  for(let i=0;i<3;i++) {
    const parts=calendarParts.formatToParts(new Date(value)), part=(kind:string)=>Number(parts.find(p=>p.type===kind)!.value);
    const shown=Date.UTC(part('year'),part('month')-1,part('day'),part('hour'),part('minute'),part('second'));
    const next=value+target-shown;if(next===value)break;value=next;
  }
  return value;
}
export function loginAnalyticsPeriodStart(range: LoginAnalyticsQuery['range'], now: number): number {
  return range==='24h' ? now-dayMs : midnight(shiftDay(londonDateKey(now),range==='7d'?-6:-29));
}

export function loginAnalyticsFilterDigest(query: LoginAnalyticsQuery): string {
  // Validated report selections use ASCII identifiers, allowing the same bytes on native and server without Buffer/TextEncoder.
  const text=JSON.stringify([query.range,query.clubId??null,query.teamId??null,query.role??null,query.event??null]);
  return Array.from(sha256(Uint8Array.from(text,char=>char.charCodeAt(0))).slice(0,8),byte=>byte.toString(16).padStart(2,'0')).join('');
}
export function loginAnalyticsCursor(query: LoginAnalyticsQuery, now: number): {asOf:number;highWater:number;at:number;id:string}|null {
  if(!query.cursor)return null;
  const match=/^2\.(\d{1,16})\.(\d{1,16})\.(\d{1,16})\.([A-Za-z0-9_-]{1,150})\.([a-f0-9]{16})$/.exec(query.cursor);
  if(!match)throw new AccessError('INVALID_LOGIN_REPORT_QUERY',400,'Use the returned login event cursor.');
  const asOf=Number(match[1]),highWater=Number(match[2]),at=Number(match[3]);
  if(!Number.isSafeInteger(asOf)||!Number.isSafeInteger(highWater)||!Number.isSafeInteger(at)||asOf>now||at>asOf||at<loginAnalyticsPeriodStart(query.range,asOf)||match[5]!==loginAnalyticsFilterDigest(query))throw new AccessError('INVALID_LOGIN_REPORT_QUERY',400,'The login event cursor does not match this report selection.');
  if(now-asOf>3_600_000)throw new AccessError('INVALID_LOGIN_REPORT_QUERY',400,'Refresh the report before continuing; this event cursor has expired.');
  return {asOf,highWater,at,id:match[4]};
}
export function loginAnalyticsEventAsOf(query: LoginAnalyticsQuery, now: number): number { return loginAnalyticsCursor(query,now)?.asOf??now; }

const newerFirst = (a: { at: number; id: string }, b: { at: number; id: string }) => b.at-a.at || (a.id===b.id ? 0 : a.id>b.id?-1:1);
function scoped(scopes: readonly LoginAnalyticsScope[], query: Pick<LoginAnalyticsQuery,'clubId'|'teamId'>): boolean {
  return !query.clubId&&!query.teamId || scopes.some(s=>(!query.clubId||s.clubId===query.clubId)&&(!query.teamId||s.teamId===query.teamId));
}
function scopeRows(scopes: Iterable<LoginAnalyticsScope>, query: Pick<LoginAnalyticsQuery,'clubId'|'teamId'>): {rows:LoginAnalyticsScope[];truncated:boolean} {
  const found = new Map<string,LoginAnalyticsScope>();
  for(const row of scopes)if((!query.clubId||row.clubId===query.clubId)&&(!query.teamId||row.teamId===query.teamId)) {
    const key=JSON.stringify([row.clubId,row.teamId,row.seasonId,row.role]);if(!found.has(key))found.set(key,{clubId:row.clubId,clubName:row.clubName,teamId:row.teamId,teamName:row.teamName,seasonId:row.seasonId,role:row.role});
    if(found.size>500)return {rows:[...found.values()].slice(0,500),truncated:true};
  }
  return {rows:[...found.values()],truncated:false};
}
const maximum = (values: number[]): number | null => values.length ? Math.max(...values) : null;
function eventCounts(events: readonly LoginAnalyticsEvent[]) {
  return {signIns:events.filter(e=>e.type==='login_success').reduce((n,e)=>n+e.count,0),uniqueAccounts:new Set(events.flatMap(e=>e.accountId?[e.accountId]:[])).size};
}
function validSession(session: AnalyticsSession, now: number, runtimeId: string): boolean {
  return session.provider!=='oidc' && session.runtimeId===runtimeId && session.endedAt===null && session.expiresAtMs!==null && session.expiresAtMs>now;
}
/** One account may have access to many teams. Group totals must never be summed as global uniques. */
export function projectLoginAnalytics(snapshot: LoginAnalyticsSnapshot, query: LoginAnalyticsQuery, now: number, runtimeId: string, collectionHealthy: boolean): LoginAnalyticsDto {
  if(!Number.isSafeInteger(now)||now<0)throw new Error('Use a valid report observation time.');
  const directory={clubs:snapshot.directory.clubs.map(c=>({id:c.id,name:c.name})),teams:snapshot.directory.teams.map(t=>({id:t.id,clubId:t.clubId,name:t.name,ageGroup:t.ageGroup}))};
  const club=query.clubId?directory.clubs.find(c=>c.id===query.clubId):null, team=query.teamId?directory.teams.find(t=>t.id===query.teamId):null;
  if(query.clubId&&!club || query.teamId&&!team || club&&team&&team.clubId!==club.id)throw new AccessError('INVALID_LOGIN_REPORT_QUERY',400,'Choose a team in the selected club.');
  const parsedCursor=loginAnalyticsCursor(query,now),eventAsOf=parsedCursor?.asOf??now,cursor=parsedCursor?{at:parsedCursor.at,id:parsedCursor.id}:null;
  const highWater=parsedCursor?.highWater??snapshot.eventHighWater??Math.max(0,...snapshot.events.flatMap(e=>e.ordinal===undefined?[]:[e.ordinal]));
  if(!Number.isSafeInteger(highWater)||highWater<0)throw new Error('Use a valid event collection high-water mark.');
  const from=loginAnalyticsPeriodStart(query.range,eventAsOf);
  const eventMatches=(e:LoginAnalyticsEvent)=>e.at>=from&&e.at<=eventAsOf&&(!query.role||e.role===query.role)&&(!query.event||e.type===query.event)&&scoped(e.scopes,query);
  const events=snapshot.events.filter(e=>e.ordinal===undefined||e.ordinal<=highWater).map(e=>e.type==='login_failure'?{...e,accountId:null,actorLabel:null,role:null,scopes:[]}:e).filter(eventMatches).sort(newerFirst);
  const enabled=new Set(snapshot.accounts.filter(a=>a.enabled).map(a=>a.accountId));
  const recent=snapshot.sessions.filter(s=>(snapshot.activityAccountsVerified===true||enabled.has(s.accountId))&&s.lastSeenAt>=now-LOGIN_ACTIVITY_WINDOW_MS&&s.lastSeenAt<=now&&(!query.role||s.role===query.role)&&scoped(s.scopes,query));
  const activeIds=new Set(recent.map(s=>s.accountId));
  const byAccount=new Map<string,AnalyticsSession[]>();
  for(const session of recent){const rows=byAccount.get(session.accountId)??[];rows.push(session);byAccount.set(session.accountId,rows);}
  let visibleScopesTruncated=false;
  const publicScopes=(scopes:Iterable<LoginAnalyticsScope>)=>{const selected=scopeRows(scopes,query);visibleScopesTruncated ||= selected.truncated;return selected.rows;};
  function* accountScopes(rows:readonly AnalyticsSession[]):Generator<LoginAnalyticsScope> { const seen=new Set<LoginAnalyticsScope[]>();for(const row of rows)if(!seen.has(row.scopes)){seen.add(row.scopes);yield* row.scopes;} }
  // Rank cheap references first. At most 100 public account/scope DTOs are ever constructed.
  const activeUsers=[...byAccount].map(([accountId,rows])=>({accountId,rows,latest:rows.reduce((a,b)=>b.lastSeenAt>a.lastSeenAt||b.lastSeenAt===a.lastSeenAt&&b.sessionId>a.sessionId?b:a)}))
    .sort((a,b)=>b.latest.lastSeenAt-a.latest.lastSeenAt||a.accountId.localeCompare(b.accountId)).slice(0,100).map(({accountId,rows,latest})=>({accountId,label:latest.label,role:latest.role,lastSeenAt:latest.lastSeenAt,sessionCount:rows.some(r=>r.provider==='oidc')?null:new Set(rows.filter(r=>validSession(r,now,runtimeId)).map(r=>r.sessionId)).size,scopes:publicScopes(accountScopes(rows))}));
  const selectedClubs=directory.clubs.filter(c=>(!query.clubId||c.id===query.clubId)&&(!team||team.clubId===c.id));
  const selectedTeams=directory.teams.filter(t=>(!query.clubId||t.clubId===query.clubId)&&(!query.teamId||t.id===query.teamId));
  type Group = { signIns:number;accounts:Set<string>;active:Set<string>;lastSeenAt:number|null };
  const clubMetrics=new Map<string,Group>(),teamMetrics=new Map<string,Group>();
  const metric=(map:Map<string,Group>,key:string)=>{let value=map.get(key);if(!value){value={signIns:0,accounts:new Set(),active:new Set(),lastSeenAt:null};map.set(key,value);}return value;};
  const selectedClubIds=new Set(selectedClubs.map(c=>c.id)),selectedTeamIds=new Set(selectedTeams.map(t=>t.id));
  for(const row of events) {
    const clubIds=new Set<string>(),teamIds=new Set<string>();
    for(const scope of row.scopes)if(selectedClubIds.has(scope.clubId)&&selectedTeamIds.has(scope.teamId)){clubIds.add(scope.clubId);teamIds.add(scope.teamId);}
    for(const [map,keys] of [[clubMetrics,clubIds],[teamMetrics,teamIds]] as const)for(const key of keys){const value=metric(map,key);if(row.type==='login_success')value.signIns+=row.count;if(row.accountId)value.accounts.add(row.accountId);}
  }
  for(const row of recent) {
    const clubIds=new Set<string>(),teamIds=new Set<string>();
    for(const scope of row.scopes)if(selectedClubIds.has(scope.clubId)&&selectedTeamIds.has(scope.teamId)){clubIds.add(scope.clubId);teamIds.add(scope.teamId);}
    for(const [map,keys] of [[clubMetrics,clubIds],[teamMetrics,teamIds]] as const)for(const key of keys){const value=metric(map,key);value.active.add(row.accountId);value.lastSeenAt=value.lastSeenAt===null?row.lastSeenAt:Math.max(value.lastSeenAt,row.lastSeenAt);}
  }
  const values=(value:Group|undefined)=>({signIns:value?.signIns??0,uniqueAccounts:value?.accounts.size??0,activeAccounts:value?.active.size??0,lastSeenAt:value?.lastSeenAt??null});
  const clubNames=new Map(directory.clubs.map(c=>[c.id,c.name])),teamCounts=new Map<string,number>();for(const row of selectedTeams)teamCounts.set(row.clubId,(teamCounts.get(row.clubId)??0)+1);
  const clubs=selectedClubs.map(c=>({clubId:c.id,clubName:c.name,teamCount:teamCounts.get(c.id)??0,...values(clubMetrics.get(c.id))}));
  const teams=selectedTeams.map(t=>({teamId:t.id,teamName:t.name,clubId:t.clubId,clubName:clubNames.get(t.clubId)??'Club',ageGroup:t.ageGroup,...values(teamMetrics.get(t.id))}));
  const roles=(Object.keys(LOGIN_ROLE_LABELS) as LoginAnalyticsRole[]).filter(role=>!query.role||query.role===role).map(role=>({role,label:LOGIN_ROLE_LABELS[role],...eventCounts(events.filter(e=>e.role===role)),activeAccounts:new Set(recent.filter(s=>s.role===role).map(s=>s.accountId)).size}));
  const trend: LoginAnalyticsDto['trend']=[];
  if(query.range==='24h')for(let index=0;index<24;index++)trend.push({from:from+index*3_600_000,to:Math.min(eventAsOf,from+(index+1)*3_600_000),signIns:0,failedAttempts:0,uniqueAccounts:0});
  else {
    const days=query.range==='7d'?7:30,key=londonDateKey(from);
    for(let index=0;index<days;index++)trend.push({from:midnight(shiftDay(key,index)),to:Math.min(eventAsOf,midnight(shiftDay(key,index+1))),signIns:0,failedAttempts:0,uniqueAccounts:0});
  }
  for(const point of trend) {
    const rows=events.filter(e=>e.at>=point.from&&(e.at<point.to||point.to===eventAsOf&&e.at===eventAsOf));
    const counts=eventCounts(rows);point.signIns=counts.signIns;point.uniqueAccounts=counts.uniqueAccounts;point.failedAttempts=rows.filter(e=>e.type==='login_failure').reduce((n,e)=>n+e.count,0);
  }
  const pageEvents=events.filter(e=>!cursor||e.at<cursor.at||e.at===cursor.at&&e.id<cursor.id), selected=pageEvents.slice(0,LOGIN_REPORT_PAGE_SIZE),last=selected.at(-1);
  const signIns=events.filter(e=>e.type==='login_success');
  const publicEvents=selected.map(e=>({id:e.id,at:e.at,type:e.type,provider:e.provider,accountId:e.accountId,actorLabel:e.actorLabel,role:e.role,scopes:publicScopes(e.scopes),reason:e.reason,count:e.count}));
  return {
    kind:'login-analytics',observedAt:now,eventAsOf,from,filters:{...query},
    summary:{...eventCounts(events),failedAttempts:events.filter(e=>e.type==='login_failure').reduce((n,e)=>n+e.count,0),activeAccounts:activeIds.size,activeSessions:recent.some(s=>s.provider==='oidc')?null:new Set(recent.filter(s=>validSession(s,now,runtimeId)).map(s=>s.sessionId)).size,enabledAccounts:snapshot.enabledAccountsCount??snapshot.accounts.filter(a=>a.enabled&&(!query.role||a.role===query.role)&&scoped(a.scopes,query)).length,lastSignInAt:maximum(signIns.map(e=>e.at))},
    directory,trend,roles,clubs,teams,activeUsers,
    events:publicEvents,
    page:{nextCursor:pageEvents.length>LOGIN_REPORT_PAGE_SIZE&&last?`2.${eventAsOf}.${highWater}.${last.at}.${last.id}.${loginAnalyticsFilterDigest(query)}`:null,limit:LOGIN_REPORT_PAGE_SIZE},
    coverage:{startedAt:snapshot.startedAt,eventRowsTruncated:snapshot.eventRowsTruncated,activityRowsTruncated:snapshot.activityRowsTruncated||byAccount.size>100,scopeRowsTruncated:visibleScopesTruncated||snapshot.scopeRowsTruncated||snapshot.events.some(e=>e.scopes.length>500)||snapshot.sessions.some(e=>e.scopes.length>500)||snapshot.accounts.some(e=>e.scopes.length>500),eventLimit:LOGIN_REPORT_MAX_EVENTS,activityWindowMinutes:15,pollingIncluded:true,upstreamProviderFailuresIncluded:false,collectionHealthy},
    definitions:[
      'Active accounts means enabled LongBall accounts with authenticated API activity in the last 15 minutes; automatic polling is included. This is not proof that a person is online.',
      'Club and team attribution is the membership access captured at the event or activity observation, not a claim that the user selected or visited that team. Group totals overlap and must not be added together.',
      'Unique accounts counts distinct known accounts with the selected recorded events. Shared Player accounts do not identify distinct people.',
      'The event filter applies to event counts and the timeline; recent activity and enabled-account counts are independent of event type.',
      'Enabled accounts are known to LongBall with current matching access; this is not the external identity provider user directory.',
      'Current local sessions are unexpired, not signed out, observed within 15 minutes and held by this running service. Counts are unavailable when the selection includes OIDC observations; provider session validity is not inferred.',
      'OIDC events record the first verified application use of an authentication context, not every identity-provider sign-in. Upstream provider failures and provider-only sign-outs are not observed.',
      'Rejected credentials are unattributed. Club, team and account-type filters exclude unknown failures. Network floods and requests rejected before credential evaluation are not a complete attempt log.',
      'Event pages retain the original persisted event high-water mark, event cutoff and selection through a filter-bound cursor; recent activity and account access are checked at the current observation time. Cursors expire after one hour.',
      'Periods of 7 or 30 days use UK calendar days, including today; 24 hours is a rolling period. Reporting history starts with collection and is not reconstructed.',
      'Collection health describes this running service process. It does not certify uninterrupted historical collection across service restarts.',
      'Event summaries use at most the newest 20,000 source events, and the recent-account list shows at most 100 accounts; coverage flags identify partial data.',
    ],
  };
}
