import { createHash, randomUUID } from 'node:crypto';
import { AccessError, assertAdultAuthority, type Principal } from '../../../packages/application/src/access';
import { LOGIN_ACTIVITY_WINDOW_MS, LOGIN_REPORT_MAX_EVENTS, parseLoginAnalyticsQuery, type LoginAnalyticsDto, type LoginAnalyticsEvent, type LoginAnalyticsQuery, type LoginAnalyticsRole, type LoginAnalyticsScope } from '../../../packages/application/src/login-analytics';
import { loginAnalyticsCursor, loginAnalyticsEventAsOf, loginAnalyticsPeriodStart, projectLoginAnalytics, type AnalyticsAccount, type AnalyticsSession, type LoginAnalyticsSnapshot } from '../../../packages/application/src/login-analytics-projection';
import { demoAccountLabels } from '../../../packages/testing/src/index';
import type { SessionFailureObservation, SessionObservation } from './session-observation';
import type { DevelopmentStore } from './store';
import type { PostgresStore } from './postgres-store';

type Source = DevelopmentStore | PostgresStore;
const pg = (source:Source):source is PostgresStore => 'db' in source;
export const LOGIN_ANALYTICS_SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS login_reporting_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),started_at INTEGER);
INSERT INTO login_reporting_state VALUES(1,NULL) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS login_access_snapshots(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),label TEXT NOT NULL,role TEXT NOT NULL,scopes_json TEXT NOT NULL,scopes_truncated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_events(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,at INTEGER NOT NULL,type TEXT NOT NULL,provider TEXT NOT NULL,account_id TEXT REFERENCES accounts(id),snapshot_id TEXT REFERENCES login_access_snapshots(id),session_id TEXT,reason TEXT,count INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS login_events_at ON login_events(at DESC,id DESC);
CREATE INDEX IF NOT EXISTS login_events_account ON login_events(account_id,at DESC);
CREATE TABLE IF NOT EXISTS login_sessions(session_id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),snapshot_id TEXT NOT NULL REFERENCES login_access_snapshots(id),provider TEXT NOT NULL,runtime_id TEXT NOT NULL,issued_at INTEGER NOT NULL,expires_at INTEGER,last_seen_at INTEGER NOT NULL,ended_at INTEGER);
CREATE INDEX IF NOT EXISTS login_sessions_seen ON login_sessions(last_seen_at DESC);`;
interface ActorSnapshot extends AnalyticsAccount { scopesTruncated:boolean }
interface Observation { type:'login_success'|'activity'|'logout'|'login_failure';at:number;provider:'demo'|'spectator_pin'|'oidc';runtimeId:string;accountId?:string;sessionId?:string;issuedAtMs?:number;expiresAtMs?:number|null;reason?:string;eventId?:string }
interface RawSnapshot { highWater:number;events:Record<string,unknown>[];sessions:Record<string,unknown>[];snapshots:Record<string,unknown>[];accounts?:AnalyticsAccount[];directory:LoginAnalyticsDto['directory'];startedAt:number|null }
const parse = <T>(value:unknown):T => (typeof value==='string'?JSON.parse(value):value) as T;
const labels:Record<string,string> = {super_admin:'Super Admin',club_admin:'Club Admin',manager:'Manager',player:'Player',spectator:'Spectator'};
function sqliteActor(source:DevelopmentStore,accountId:string,now:number):ActorSnapshot|null {
  const db=source.database,account=db.prepare('SELECT status FROM accounts WHERE id=?').get(accountId);if(!account)return null;
  const grants=db.prepare('SELECT level FROM administration_grants WHERE account_id=?').all(accountId);
  const memberships=db.prepare("SELECT m.*,COALESCE(json_extract(doc.value_json,'$.team.name'),t.name) team_name,COALESCE(json_extract(doc.value_json,'$.team.ageGroup'),d.age_group,'') age_group,d.club_id,COALESCE(json_extract(doc.value_json,'$.club.name'),c.name) club_name FROM memberships m JOIN teams t ON t.id=m.team_id JOIN directory_teams d ON d.team_id=m.team_id JOIN directory_clubs c ON c.id=d.club_id LEFT JOIN documents doc ON doc.team_id=m.team_id AND doc.season_id=m.season_id AND doc.kind='preparation' WHERE m.account_id=? AND m.revoked_at IS NULL AND(m.expires_at IS NULL OR m.expires_at>?) ORDER BY c.name,t.name,m.team_id,m.season_id").all(accountId,now);
  const role:LoginAnalyticsRole=grants.some(g=>g.level==='super')?'super_admin':grants.some(g=>g.level==='club')?'club_admin':memberships.some(m=>m.role==='manager')?'manager':memberships.some(m=>m.role==='player')?'player':'spectator';
  const scopes=new Map<string,LoginAnalyticsScope>();
  if(role!=='super_admin')for(const m of memberships){const key=JSON.stringify([m.team_id,m.season_id]);if(!scopes.has(key))scopes.set(key,{clubId:String(m.club_id),clubName:String(m.club_name),teamId:String(m.team_id),teamName:String(m.team_name)+(m.age_group&&!String(m.team_name).toLowerCase().endsWith(' '+String(m.age_group).toLowerCase())?' '+String(m.age_group):''),seasonId:String(m.season_id),role});}
  const profile=db.prepare("SELECT json_extract(p.value,'$.displayName') label FROM memberships m JOIN documents d ON d.team_id=m.team_id AND d.season_id=m.season_id AND d.kind='preparation' JOIN json_each(d.value_json,'$.profiles')p WHERE m.account_id=? AND m.role='player' AND json_extract(p.value,'$.playerId')=m.player_id LIMIT 1").get(accountId);
  const label=String(profile?.label??demoAccountLabels[accountId]??`${labels[role]} · ${accountId.slice(-6)}`).slice(0,120);
  return {accountId,label,role,enabled:account.status==='active',scopes:[...scopes.values()].slice(0,500),scopesTruncated:scopes.size>500};
}
function eligible(row:ActorSnapshot,query:LoginAnalyticsQuery):boolean {return row.enabled&&(!query.role||query.role===row.role)&&(!query.clubId&&!query.teamId||row.scopes.some(s=>(!query.clubId||s.clubId===query.clubId)&&(!query.teamId||s.teamId===query.teamId)));}

/** Minimal server observations, separate from credentials and immutable match history. */
export class LoginAnalyticsService {
  readonly runtimeId=randomUUID();
  private healthy=true;
  private initialized=false;
  private readonly seen=new Map<string,number>();
  private readonly oidc=new Map<string,{sessionId:string;issuedAtMs:number}>();
  private readonly limited=new Map<string,number>();
  constructor(private readonly source:Source){}
  async initialize():Promise<void>{
    if(this.initialized)return;
    if(pg(this.source))await this.source.one('SELECT login_reporting_initialize($1)',[this.source.now()]);
    else{this.source.database.exec(LOGIN_ANALYTICS_SQLITE_DDL);this.source.database.prepare('UPDATE login_reporting_state SET started_at=COALESCE(started_at,?) WHERE singleton=1').run(this.source.now());}
    this.initialized=true;
  }
  private async safe(work:()=>Promise<void>):Promise<void>{try{await this.initialize();await work();}catch{if(this.healthy)console.error('LONGBALL_LOGIN_REPORT_WRITE_FAILED');this.healthy=false;}}
  async recordFailure(event:SessionFailureObservation):Promise<void>{
    // Credential evaluations are already limited by the authentication service.
    // Post-limit floods are represented by at most one event/provider/minute.
    if(event.reason==='rate_limited'){
      const previous=this.limited.get(event.provider);if(previous!==undefined&&event.at-previous<60_000)return;this.limited.set(event.provider,event.at);
    }
    await this.safe(()=>this.write({type:'login_failure',provider:event.provider,at:event.at,runtimeId:this.runtimeId,reason:event.reason,eventId:randomUUID()}));
  }
  async signIn(principal:Principal,session:SessionObservation):Promise<void>{
    await this.safe(async()=>{await this.actorWrite(principal,{type:'login_success',provider:session.provider,at:this.source.now(),runtimeId:this.runtimeId,accountId:session.accountId,sessionId:session.sessionId,issuedAtMs:session.issuedAtMs,expiresAtMs:session.expiresAtMs});this.seen.set(session.sessionId,this.source.now());});
  }
  async observe(principal:Principal,session:SessionObservation|null,provider:'demo'|'spectator_pin'|'oidc'):Promise<void>{
    if(provider!=='oidc'&&!session)return;
    let observation=session?{sessionId:session.sessionId,issuedAtMs:session.issuedAtMs,expiresAtMs:session.expiresAtMs as number|null}:{sessionId:'',issuedAtMs:principal.authenticatedAt,expiresAtMs:null as number|null};
    if(provider==='oidc'){
      const key=JSON.stringify([principal.accountId,principal.issuer,principal.subject,principal.authenticatedAt]);
      let context=this.oidc.get(key);if(!context){if(this.oidc.size>=20_000)this.oidc.delete(this.oidc.keys().next().value!);context={sessionId:randomUUID(),issuedAtMs:Math.min(principal.authenticatedAt,this.source.now())};this.oidc.set(key,context);}observation={...context,expiresAtMs:null};
    }
    const previous=this.seen.get(observation.sessionId),now=this.source.now();if(previous!==undefined&&now-previous<60_000)return;
    await this.safe(async()=>{await this.actorWrite(principal,{type:'activity',provider,at:now,runtimeId:this.runtimeId,accountId:principal.accountId,...observation});if(this.seen.size>=20_000)this.seen.delete(this.seen.keys().next().value!);this.seen.set(observation.sessionId,now);});
  }
  async logout(session:SessionObservation):Promise<void>{
    await this.safe(async()=>{
      const source=this.source,identity={issuer:session.provider==='demo'?'urn:longball:synthetic':'urn:longball:spectator-pin',subject:session.accountId,strongAuth:false,authenticatedAt:session.issuedAtMs};
      const event:Observation={type:'logout',at:source.now(),provider:session.provider,accountId:session.accountId,sessionId:session.sessionId,runtimeId:this.runtimeId};
      try{
        const principal=pg(source)?await source.withIdentityContext(identity,()=>source.principal(identity)):source.principal(identity);
        await this.actorWrite(principal,event);
      }catch(error){
        if(!(error instanceof AccessError)||error.code!=='ACCOUNT_UNAVAILABLE')throw error;
        // Revocation is still valid for a disabled account. The server has
        // already verified and revoked this exact opaque local session.
        if(pg(source))await source.withIdentityContext(identity,async()=>{await source.transaction(async()=>{await this.write(event);});});
        else source.transaction(()=>this.writeSqlite(source,event));
      }
    });
    this.seen.delete(session.sessionId);
  }
  private async actorWrite(principal:Principal,event:Observation):Promise<void>{
    if(event.accountId!==principal.accountId)throw new Error('Login observation actor mismatch.');
    if(pg(this.source)){const source=this.source;await source.withActorContext(principal,{operation:'login.activity',requestedRole:'default'},async()=>{await source.transaction(async()=>{await this.write(event);});});}else this.source.transaction(()=>this.writeSqlite(this.source as DevelopmentStore,event));
  }
  private async write(event:Observation):Promise<void>{
    if(pg(this.source)){await this.source.one('SELECT login_activity_write($1::jsonb)',[JSON.stringify(event)]);return;}
    this.writeSqlite(this.source,event);
  }
  private writeSqlite(source:DevelopmentStore,event:Observation):void {
    const db=source.database;
    if(event.type==='login_failure'){db.prepare('INSERT INTO login_events(id,at,type,provider,reason) VALUES(?,?,?,?,?)').run(`failure-${event.eventId}`,event.at,event.type,event.provider,event.reason!);return;}
    if(event.type==='logout'){
      const prior=db.prepare('SELECT * FROM login_sessions WHERE session_id=? AND account_id=? AND runtime_id=? AND ended_at IS NULL').get(event.sessionId!,event.accountId!,event.runtimeId);
      if(prior){db.prepare('UPDATE login_sessions SET ended_at=? WHERE session_id=? AND ended_at IS NULL').run(event.at,event.sessionId!);db.prepare('INSERT INTO login_events(id,at,type,provider,account_id,snapshot_id,session_id) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').run(`logout-${createHash('sha256').update(event.sessionId!).digest('hex')}`,event.at,'logout',event.provider,event.accountId!,String(prior.snapshot_id),event.sessionId!);}return;
    }
    const actor=sqliteActor(source,event.accountId!,event.at);if(!actor?.enabled)throw new AccessError('ACCOUNT_UNAVAILABLE',401,'The account is unavailable.');
    const snapshot=createHash('sha256').update(JSON.stringify(actor)).digest('hex');
    db.prepare('INSERT INTO login_access_snapshots(id,account_id,label,role,scopes_json,scopes_truncated) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING').run(snapshot,actor.accountId,actor.label,actor.role,JSON.stringify(actor.scopes),Number(actor.scopesTruncated));
    db.prepare('INSERT INTO login_sessions(session_id,account_id,snapshot_id,provider,runtime_id,issued_at,expires_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET snapshot_id=excluded.snapshot_id,last_seen_at=excluded.last_seen_at WHERE login_sessions.account_id=excluded.account_id AND login_sessions.runtime_id=excluded.runtime_id AND login_sessions.ended_at IS NULL').run(event.sessionId!,event.accountId!,snapshot,event.provider,event.runtimeId,event.issuedAtMs!,event.expiresAtMs??null,event.at);
    db.prepare('INSERT INTO login_events(id,at,type,provider,account_id,snapshot_id,session_id) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').run(`login-${createHash('sha256').update(event.sessionId!).digest('hex')}`,event.at,'login_success',event.provider,event.accountId!,snapshot,event.sessionId!);
  }
  async view(principal:Principal,parameters:URLSearchParams):Promise<LoginAnalyticsDto>{
    await this.initialize();
    const fresh=await this.source.principal({issuer:principal.issuer,subject:principal.subject,strongAuth:principal.strongAuth,authenticatedAt:principal.authenticatedAt});
    assertAdultAuthority(fresh,false,this.source.now());if(fresh.administration?.level!=='super')throw new AccessError('NOT_FOUND',404,'Application login reports are unavailable.');
    const query=parseLoginAnalyticsQuery(parameters),now=this.source.now(),asOf=loginAnalyticsEventAsOf(query,now),from=loginAnalyticsPeriodStart(query.range,asOf);
    const snapshot=await this.snapshot(query,from,asOf,now);
    return projectLoginAnalytics(snapshot,query,now,this.runtimeId,this.healthy);
  }
  private async snapshot(query:LoginAnalyticsQuery,from:number,until:number,now:number):Promise<LoginAnalyticsSnapshot>{
    let raw:RawSnapshot,enabledAccountsCount:number;
    if(pg(this.source)){
      let row;try{row=await this.source.one('SELECT login_analytics_snapshot($1,$2,$3,$4) AS value',[from,until,now-LOGIN_ACTIVITY_WINDOW_MS,loginAnalyticsCursor(query,now)?.highWater??null]);}catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='23514')throw new AccessError('INVALID_LOGIN_REPORT_QUERY',400,'Use the returned login event cursor.');throw error;}raw=parse<RawSnapshot>(row?.value);
      const count=await this.source.one('SELECT login_analytics_enabled_accounts($1,$2,$3) AS value',[query.clubId??null,query.teamId??null,query.role??null]);enabledAccountsCount=Number(count?.value??0);
    }else{
      const db=this.source.database;
      const actualHighWater=Number(db.prepare('SELECT COALESCE(MAX(ordinal),0) value FROM login_events').get()?.value??0),highWater=loginAnalyticsCursor(query,now)?.highWater??actualHighWater;if(highWater>actualHighWater)throw new AccessError('INVALID_LOGIN_REPORT_QUERY',400,'Use the returned login event cursor.');
      const events=db.prepare('SELECT * FROM login_events WHERE at>=? AND at<=? AND ordinal<=? ORDER BY at DESC,id DESC LIMIT 20001').all(from,until,highWater);
      const sessions=db.prepare("SELECT s.* FROM login_sessions s JOIN accounts a ON a.id=s.account_id WHERE a.status='active' AND s.last_seen_at>=? ORDER BY s.last_seen_at DESC,s.session_id LIMIT 20001").all(now-LOGIN_ACTIVITY_WINDOW_MS);
      const ids=[...new Set([...events,...sessions].map(e=>e.snapshot_id).filter(Boolean))].sort().slice(0,1001);
      const snapshots=ids.flatMap(id=>{const row=db.prepare('SELECT * FROM login_access_snapshots WHERE id=?').get(String(id));return row?[row]:[];});
      const clubs=db.prepare(`SELECT c.id,COALESCE((SELECT json_extract(value_json,'$.club.name') FROM documents WHERE kind='preparation' AND json_extract(value_json,'$.club.id')=c.id ORDER BY season_id DESC LIMIT 1),c.name) name FROM directory_clubs c ORDER BY name,id LIMIT 20001`).all() as unknown as LoginAnalyticsDto['directory']['clubs'];
      const teams=db.prepare(`SELECT d.team_id id,d.club_id clubId,COALESCE((SELECT json_extract(value_json,'$.team.name') FROM documents WHERE team_id=t.id AND kind='preparation' ORDER BY season_id DESC LIMIT 1),t.name) name,COALESCE((SELECT json_extract(value_json,'$.team.ageGroup') FROM documents WHERE team_id=t.id AND kind='preparation' ORDER BY season_id DESC LIMIT 1),d.age_group) ageGroup FROM directory_teams d JOIN teams t ON t.id=d.team_id ORDER BY name,t.id LIMIT 20001`).all() as unknown as LoginAnalyticsDto['directory']['teams'];
      enabledAccountsCount=0;
      for(const row of db.prepare("SELECT DISTINCT a.id FROM accounts a LEFT JOIN memberships m ON m.account_id=a.id LEFT JOIN administration_grants g ON g.account_id=a.id WHERE a.status='active' AND(g.account_id IS NOT NULL OR m.account_id IS NOT NULL AND m.revoked_at IS NULL AND(m.expires_at IS NULL OR m.expires_at>?))").all(now)){const account=sqliteActor(this.source,String(row.id),now);if(account&&eligible(account,query))enabledAccountsCount++;}
      raw={highWater,events,sessions,snapshots,directory:{clubs,teams},startedAt:Number(db.prepare('SELECT started_at FROM login_reporting_state WHERE singleton=1').get()?.started_at??now)};
    }
    if(!raw)throw new AccessError('LOGIN_REPORT_UNAVAILABLE',503,'Login activity is temporarily unavailable.');
    const sets=new Map(raw.snapshots.slice(0,1000).map(s=>[String(s.id),{label:String(s.label),role:s.role as LoginAnalyticsRole,scopes:parse<LoginAnalyticsScope[]>(s.scopes_json),truncated:Boolean(s.scopes_truncated)}]));
    const events:(LoginAnalyticsEvent & {ordinal:number})[]=raw.events.slice(0,LOGIN_REPORT_MAX_EVENTS).map(e=>{const snapshot=sets.get(String(e.snapshot_id));return {ordinal:Number(e.ordinal),id:String(e.id),at:Number(e.at),type:e.type as LoginAnalyticsEvent['type'],provider:e.provider as LoginAnalyticsEvent['provider'],accountId:e.account_id===null?null:String(e.account_id),actorLabel:snapshot?.label??null,role:snapshot?.role??null,scopes:snapshot?.scopes??[],reason:e.reason===null?null:String(e.reason),count:Number(e.count)};});
    const sessions:AnalyticsSession[]=raw.sessions.slice(0,LOGIN_REPORT_MAX_EVENTS).flatMap(s=>{const snapshot=sets.get(String(s.snapshot_id));return snapshot?[{sessionId:String(s.session_id),accountId:String(s.account_id),provider:s.provider as AnalyticsSession['provider'],runtimeId:String(s.runtime_id),issuedAtMs:Number(s.issued_at),expiresAtMs:s.expires_at===null?null:Number(s.expires_at),lastSeenAt:Number(s.last_seen_at),endedAt:s.ended_at===null?null:Number(s.ended_at),...snapshot}]:[];});
    return {events,sessions,accounts:[],eventHighWater:raw.highWater,enabledAccountsCount,activityAccountsVerified:true,directory:{clubs:raw.directory.clubs.slice(0,20_000),teams:raw.directory.teams.slice(0,20_000)},startedAt:raw.startedAt,eventRowsTruncated:raw.events.length>20_000,activityRowsTruncated:raw.sessions.length>20_000||raw.directory.clubs.length>20_000||raw.directory.teams.length>20_000,scopeRowsTruncated:raw.snapshots.length>1000||[...sets.values()].some(s=>s.truncated)};
  }
}
