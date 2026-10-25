import { describe, expect, it } from 'vitest';
import { parseLoginAnalyticsQuery, type LoginAnalyticsEvent, type LoginAnalyticsQuery, type LoginAnalyticsScope } from './login-analytics';
import { loginAnalyticsEventAsOf, loginAnalyticsPeriodStart, projectLoginAnalytics, type AnalyticsAccount, type AnalyticsSession, type LoginAnalyticsSnapshot } from './login-analytics-projection';

const now=Date.parse('2026-10-25T12:00:00Z'),runtime='this-service';
const roma:LoginAnalyticsScope={clubId:'roma',clubName:'Roma FC',teamId:'roma-u10',teamName:'Roma U10',seasonId:'26-27',role:'manager'};
const older:LoginAnalyticsScope={...roma,teamId:'roma-u12',teamName:'Roma U12'};
const harbour:LoginAnalyticsScope={clubId:'harbour',clubName:'Harbour FC',teamId:'harbour-u10',teamName:'Harbour U10',seasonId:'26-27',role:'spectator'};
const account=(accountId:string,scopes:LoginAnalyticsScope[],extra:Partial<AnalyticsAccount>={}):AnalyticsAccount=>({accountId,label:accountId==='one'?'Priya Shah':'Sam Taylor',role:accountId==='one'?'manager':'spectator',enabled:true,scopes,...extra});
const event=(id:string,accountId:string|null,scopes:LoginAnalyticsScope[],extra:Partial<LoginAnalyticsEvent>={}):LoginAnalyticsEvent=>({id,at:now-60_000,type:'login_success',provider:'demo',accountId,actorLabel:accountId==='one'?'Priya Shah':accountId?'Sam Taylor':null,role:accountId==='one'?'manager':accountId?'spectator':null,scopes,reason:null,count:1,...extra});
const session=(accountId:string,scopes:LoginAnalyticsScope[],extra:Partial<AnalyticsSession>={}):AnalyticsSession=>({sessionId:`session-${accountId}`,accountId,label:accountId==='one'?'Priya Shah':'Sam Taylor',role:accountId==='one'?'manager':'spectator',provider:'demo',issuedAtMs:now-600_000,expiresAtMs:now+600_000,lastSeenAt:now-60_000,endedAt:null,runtimeId:runtime,scopes,...extra});
function snapshot():LoginAnalyticsSnapshot{return {events:[event('one-login','one',[roma,older]),event('two-login','two',[harbour]),event('unknown-fail',null,[],{type:'login_failure',count:4,reason:'invalid_credentials'}),event('one-logout','one',[roma,older],{type:'logout',at:now-30_000}),event('too-old','one',[roma],{at:now-40*86_400_000})],sessions:[session('one',[roma,older]),session('one',[roma,older],{sessionId:'one-old-service',runtimeId:'previous-service'}),session('two',[harbour],{endedAt:now-30_000}),session('disabled',[roma],{role:'manager'})],accounts:[account('one',[roma,older]),account('two',[harbour]),account('disabled',[roma],{role:'manager',enabled:false})],directory:{clubs:[{id:'roma',name:'Roma FC'},{id:'harbour',name:'Harbour FC'}],teams:[{id:'roma-u10',clubId:'roma',name:'Roma U10',ageGroup:'U10'},{id:'roma-u12',clubId:'roma',name:'Roma U12',ageGroup:'U12'},{id:'harbour-u10',clubId:'harbour',name:'Harbour U10',ageGroup:'U10'}]},startedAt:now-2*86_400_000,eventRowsTruncated:false,activityRowsTruncated:false,scopeRowsTruncated:false};}
const report=(s=snapshot(),q:LoginAnalyticsQuery={range:'7d'},at=now)=>projectLoginAnalytics(s,q,at,runtime,true);

describe('Super Admin login report projection',()=>{
 it('counts accounts once globally and once within each accessible group, without treating shared accounts as people',()=>{
  const r=report();expect(r.summary).toMatchObject({signIns:2,failedAttempts:4,uniqueAccounts:2,activeAccounts:2,activeSessions:1,enabledAccounts:2});
  expect(r.clubs.find(c=>c.clubId==='roma')).toMatchObject({signIns:1,uniqueAccounts:1,activeAccounts:1,teamCount:2});
  expect(r.teams.filter(t=>t.clubId==='roma').map(t=>t.signIns)).toEqual([1,1]);expect(r.events.find(e=>e.type==='login_failure')).toMatchObject({accountId:null,actorLabel:null,scopes:[]});
  expect(r.activeUsers.find(u=>u.accountId==='two')?.sessionCount).toBe(0);expect(r.activeUsers.some(u=>u.accountId==='disabled')).toBe(false);
  expect(r.definitions.join(' ')).toMatch(/not proof that a person is online/);expect(r.definitions.join(' ')).toMatch(/totals overlap/);
 });
 it('filters exact snapshotted club/team access, excludes unattributed failures and preserves the full directory',()=>{
  const s=snapshot(),r=report(s,{range:'7d',clubId:'roma',teamId:'roma-u12',role:'manager'});
  expect(r.summary).toMatchObject({signIns:1,failedAttempts:0,uniqueAccounts:1,activeAccounts:1,enabledAccounts:1});expect(r.events.every(e=>e.scopes.every(scope=>scope.teamId==='roma-u12'))).toBe(true);expect(r.activeUsers[0].scopes).toEqual([older]);expect(r.directory).toEqual(s.directory);
  for(const query of [{range:'7d',clubId:'missing'},{range:'7d',teamId:'missing'},{range:'7d',clubId:'roma',teamId:'harbour-u10'}] as LoginAnalyticsQuery[])expect(()=>report(s,query)).toThrow('Choose a team in the selected club');
 });
 it('uses membership access at the observation, never current account memberships to relabel historical events',()=>{
  const s=snapshot();s.accounts[0].scopes=[harbour];s.sessions[0].scopes=[harbour];
  const r=report(s,{range:'7d',clubId:'roma'});expect(r.summary.signIns).toBe(1);expect(r.summary.enabledAccounts).toBe(0);expect(r.events[0].scopes.every(scope=>scope.clubId==='roma')).toBe(true);
 });
 it('keeps recent account activity separate from event-type filtering and refuses to infer provider session validity',()=>{
  const s=snapshot();s.sessions.push(session('one',[roma],{sessionId:'oidc-seen',provider:'oidc',expiresAtMs:null}));
  const r=report(s,{range:'7d',event:'logout'});expect(r.summary).toMatchObject({signIns:0,failedAttempts:0,uniqueAccounts:1,activeAccounts:2,activeSessions:null});expect(r.events.every(e=>e.type==='logout')).toBe(true);expect(r.activeUsers.find(u=>u.accountId==='one')?.sessionCount).toBeNull();
  expect(r.definitions.join(' ')).toMatch(/Upstream provider failures/);
 });
 it('freezes event pages at a selection-bound cutoff while rechecking current recent activity',()=>{
  const s=snapshot();s.events=Array.from({length:75},(_,i)=>event(`event-${String(i).padStart(3,'0')}`,'one',[roma]));
  const first=report(s,{range:'7d',clubId:'roma'});expect(first.events).toHaveLength(50);expect(first.page.nextCursor).toMatch(/^2\./);
  s.events.push(event('new-after-page','one',[roma],{at:now+10_000}));s.sessions[0].lastSeenAt=now+20_000;
  const nextQuery:LoginAnalyticsQuery={range:'7d',clubId:'roma',cursor:first.page.nextCursor!};const second=report(s,nextQuery,now+30_000);
  expect(second.events).toHaveLength(25);expect(second.page.nextCursor).toBeNull();expect(second.summary.signIns).toBe(75);expect(second.eventAsOf).toBe(now);expect(second.observedAt).toBe(now+30_000);expect(second.activeUsers.find(u=>u.accountId==='one')?.lastSeenAt).toBe(now+20_000);
  expect(new Set([...first.events,...second.events].map(e=>e.id)).size).toBe(75);
  expect(()=>report(s,{...nextQuery,clubId:'harbour'},now+30_000)).toThrow('does not match');expect(()=>report(s,nextQuery,now+3_600_001)).toThrow('expired');
  expect(loginAnalyticsEventAsOf(nextQuery,now+30_000)).toBe(now);
 });
 it('excludes post-first-page inserts at the same clock time or backdated time using the persisted event high-water mark',()=>{
  const s=snapshot();s.events=Array.from({length:75},(_,i)=>({...event(`event-${String(i).padStart(3,'0')}`,'one',[roma],{at:now}),ordinal:i+1}));s.eventHighWater=75;
  const first=report(s,{range:'7d',clubId:'roma'});expect(first.events).toHaveLength(50);expect(first.page.nextCursor).toMatch(new RegExp(`^2\\.${now}\\.75\\.`));
  // Both new rows would sort into page two if a wall-clock timestamp were the only cutoff.
  s.events.push({...event('event-000a','one',[roma],{at:now}),ordinal:76},{...event('backdated-new','one',[roma],{at:now-1}),ordinal:77});s.eventHighWater=77;
  const next=report(s,{range:'7d',clubId:'roma',cursor:first.page.nextCursor!},now+10_000);
  expect(next.summary.signIns).toBe(75);expect(next.events).toHaveLength(25);expect(next.events.some(e=>e.id==='event-000a'||e.id==='backdated-new')).toBe(false);expect(next.events.every(e=>!Object.hasOwn(e,'ordinal'))).toBe(true);
  expect(report(s,{range:'7d',clubId:'roma'},now+10_000).summary.signIns).toBe(77);
 });
 it('uses actual UK calendar-day boundaries through both summer-time clock changes',()=>{
  const fallNow=Date.parse('2026-10-26T12:00:00Z'),s=snapshot();s.events=[event('fall-bst','one',[roma],{at:Date.parse('2026-10-25T00:30:00Z')}),event('fall-gmt','one',[roma],{at:Date.parse('2026-10-25T01:30:00Z')})];
  const fall=report(s,{range:'7d'},fallNow),fallDay=fall.trend.find(p=>p.from===Date.parse('2026-10-24T23:00:00Z'))!;
  expect(fall.trend).toHaveLength(7);expect(fallDay.to-fallDay.from).toBe(25*3_600_000);expect(fallDay.signIns).toBe(2);
  const springNow=Date.parse('2026-03-30T12:00:00Z'),spring=report({...s,events:[]},{range:'7d'},springNow),springDay=spring.trend.find(p=>p.from===Date.parse('2026-03-29T00:00:00Z'))!;
  expect(springDay.to-springDay.from).toBe(23*3_600_000);expect(loginAnalyticsPeriodStart('7d',now)).toBe(Date.parse('2026-10-18T23:00:00Z'));
  expect(report(s,{range:'24h'},fallNow).trend).toHaveLength(24);expect(loginAnalyticsPeriodStart('24h',fallNow)).toBe(fallNow-24*3_600_000);
 });
 it('supports a 170-team club without multiplying one login or account into club totals',()=>{
  const s=snapshot(),scopes=Array.from({length:170},(_,i)=>({...roma,teamId:`team-${i}`,teamName:`Roma ${i}`,role:'club_admin' as const}));
  s.directory={clubs:[{id:'roma',name:'Roma FC'}],teams:scopes.map((scope,i)=>({id:scope.teamId,name:scope.teamName,clubId:'roma',ageGroup:`U${5+i%17}`}))};s.events=[event('admin-sign-in','one',scopes,{role:'club_admin'})];s.sessions=[session('one',scopes,{role:'club_admin'})];s.accounts=[account('one',scopes,{role:'club_admin'})];
  const r=report(s);expect(r.teams).toHaveLength(170);expect(r.teams.every(t=>t.signIns===1&&t.uniqueAccounts===1&&t.activeAccounts===1)).toBe(true);expect(r.clubs[0]).toMatchObject({signIns:1,uniqueAccounts:1,activeAccounts:1,teamCount:170});expect(r.coverage.scopeRowsTruncated).toBe(false);
 });
 it('does not fabricate history, labels limited coverage and emits only public DTO fields',()=>{
  const s=snapshot();s.events=[];s.sessions=[];s.startedAt=null;s.eventRowsTruncated=true;s.activityRowsTruncated=true;s.scopeRowsTruncated=true;const r=report(s);
  expect(r.summary.signIns).toBe(0);expect(r.events).toEqual([]);expect(r.trend.every(p=>p.signIns===0&&p.failedAttempts===0)).toBe(true);expect(r.coverage).toMatchObject({startedAt:null,eventRowsTruncated:true,activityRowsTruncated:true,scopeRowsTruncated:true,collectionHealthy:true});
  const contaminated=snapshot();Object.assign(contaminated.events[0],{password:'never-public',token:'never-public'});Object.assign(contaminated.events[0].scopes[0],{privateNote:'never-public'});Object.assign(contaminated.directory.clubs[0],{secret:'never-public'});
  expect(JSON.stringify(report(contaminated))).not.toContain('never-public');
 });
 it('uses a verified repository activity source and scalar enabled-account count without serializing a directory of accounts',()=>{
  const s=snapshot();s.accounts=[];s.sessions=[session('one',[roma])];s.activityAccountsVerified=true;s.enabledAccountsCount=84_500;
  const r=report(s);expect(r.summary.enabledAccounts).toBe(84_500);expect(r.summary.activeAccounts).toBe(1);expect(r.activeUsers[0].label).toBe('Priya Shah');
 });
 it('keeps failed attempts unattributed even if an older observation accidentally carried an account and caps public scope rows',()=>{
  const s=snapshot(),scopes=Array.from({length:501},(_,i)=>({...roma,teamId:`many-${i}`}));
  s.events=[event('bad-known-failure','one',[roma],{type:'login_failure',reason:'locked'}),event('large-access','one',scopes)];s.sessions=[session('one',scopes)];
  const r=report(s);expect(r.events.find(e=>e.type==='login_failure')).toMatchObject({accountId:null,actorLabel:null,role:null,scopes:[]});expect(r.events.find(e=>e.type==='login_success')?.scopes).toHaveLength(500);expect(r.activeUsers[0].scopes).toHaveLength(500);expect(r.coverage.scopeRowsTruncated).toBe(true);
  expect(report(s,{range:'7d',clubId:'roma'}).summary.failedAttempts).toBe(0);
 });
 it('flags an activity access union that exceeds the public scope limit even when each source snapshot fits',()=>{
  const s=snapshot(),first=Array.from({length:300},(_,i)=>({...roma,teamId:`union-${i}`})),second=Array.from({length:300},(_,i)=>({...roma,teamId:`union-${i+300}`}));
  s.events=[];s.sessions=[session('one',first),session('one',second,{sessionId:'other-one'})];
  const r=report(s);expect(r.activeUsers[0].scopes).toHaveLength(500);expect(r.coverage.scopeRowsTruncated).toBe(true);expect(r.summary.activeAccounts).toBe(1);
 });
 it('rejects duplicate/unknown query fields and unsafe cursors before aggregation',()=>{
  for(const search of ['range=7d&range=24h','range=365d','password=anything','cursor=9007199254740992:id','cursor=2.9007199254740992.1.1.id.0123456789abcdef','cursor=2.1.9007199254740992.1.id.0123456789abcdef','cursor=2.1.1.2.id.0123456789abcdef'])expect(()=>parseLoginAnalyticsQuery(new URLSearchParams(search))).toThrow();
 });
 it('caps only the recent account list, retains distinct summary counts and does not mutate source arrays',()=>{
  const s=snapshot();s.accounts=Array.from({length:101},(_,i)=>account(`account-${i}`,[roma],{role:'manager'}));s.sessions=s.accounts.map(a=>session(a.accountId,[roma],{role:'manager'}));s.events=[];const before=structuredClone(s),r=report(s);
  expect(r.activeUsers).toHaveLength(100);expect(r.summary.activeAccounts).toBe(101);expect(r.coverage.activityRowsTruncated).toBe(true);expect(s).toEqual(before);
 });
});
