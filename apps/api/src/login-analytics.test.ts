import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevelopmentStore } from './store';
import { LoginAnalyticsService } from './login-analytics-service';
import type { SessionObservation } from './session-observation';

const nowBase=Date.parse('2026-10-25T12:00:00Z');
const stores:DevelopmentStore[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();vi.restoreAllMocks();});
function setup(){let now=nowBase;const source=new DevelopmentStore(':memory:',()=>now);stores.push(source);source.seedSynthetic({demoSharing:true});const service=new LoginAnalyticsService(source);const principal=(account='synthetic-account-admin',strongAuth=true)=>source.principal({issuer:'urn:longball:synthetic',subject:account,strongAuth,authenticatedAt:now});return{source,service,principal,now:()=>now,advance:(ms:number)=>{now+=ms;}};}
const session=(accountId:string,at=nowBase):SessionObservation=>({accountId,sessionId:randomUUID(),provider:'demo',issuedAtMs:at,expiresAtMs:at+3_600_000});
describe('persisted application login analytics',()=>{
 it('records only real observations, snapshots membership names and counts current local sessions without credential material',async()=>{
  const x=setup();await x.service.initialize();expect((await x.service.view(x.principal(),new URLSearchParams())).events).toEqual([]);
  const manager=x.principal('synthetic-account-manager-2'),entry=session(manager.accountId);await x.service.signIn(manager,entry);
  const report=await x.service.view(x.principal(),new URLSearchParams());expect(report.summary).toMatchObject({signIns:1,uniqueAccounts:1,activeAccounts:1,activeSessions:1});expect(report.coverage.collectionHealthy).toBe(true);expect(report.events[0]).toMatchObject({actorLabel:'Priya Shah',type:'login_success',provider:'demo'});expect(report.events[0].scopes[0]).toMatchObject({teamId:'synthetic-roma-u10',role:'manager'});
  const saved=String(x.source.database.prepare('SELECT scopes_json FROM login_access_snapshots').get()?.scopes_json);expect(saved).toContain('Roma');
  const db=x.source.database;db.prepare("UPDATE documents SET value_json=json_set(value_json,'$.team.name','Roma Lions') WHERE kind='preparation' AND team_id='synthetic-roma-u10'").run();
  const renamed=await x.service.view(x.principal(),new URLSearchParams());expect(renamed.directory.teams.find(t=>t.id==='synthetic-roma-u10')?.name).toBe('Roma Lions');expect(renamed.events[0].scopes[0].teamName).toBe(report.events[0].scopes[0].teamName);
  expect(JSON.stringify(report)).not.toMatch(/passcode|verifier|remoteAddress|Bearer|salt|tokenHash/);
  await x.service.logout(entry);const ended=await x.service.view(x.principal(),new URLSearchParams());expect(ended.summary.activeSessions).toBe(0);expect(ended.summary.activeAccounts).toBe(1);expect(ended.events.filter(e=>e.type==='logout')).toHaveLength(1);
  await x.service.logout(entry);expect((await x.service.view(x.principal(),new URLSearchParams())).events.filter(e=>e.type==='logout')).toHaveLength(1);
 });
 it('keeps rejected credentials unattributed, rate-limit observations bounded and reads fail closed for non-Super users',async()=>{
  const x=setup();await x.service.recordFailure({kind:'login_failure',provider:'demo',at:x.now(),reason:'invalid_credentials'});await x.service.recordFailure({kind:'login_failure',provider:'demo',at:x.now(),reason:'invalid_credentials'});for(let i=0;i<50;i++)await x.service.recordFailure({kind:'login_failure',provider:'demo',at:x.now(),reason:'rate_limited'});
  const report=await x.service.view(x.principal(),new URLSearchParams());expect(report.summary.failedAttempts).toBe(3);expect(report.events.every(e=>e.accountId===null&&e.actorLabel===null&&e.scopes.length===0)).toBe(true);
  expect((await x.service.view(x.principal(),new URLSearchParams({clubId:report.directory.clubs[0].id,range:'7d'}))).summary.failedAttempts).toBe(0);
  for(const id of ['synthetic-account-club-admin','synthetic-account-manager-2','synthetic-account-player-01','synthetic-account-spectator'])await expect(x.service.view(x.principal(id),new URLSearchParams())).rejects.toMatchObject({status:id.includes('player')||id.includes('spectator')?403:404});
  x.source.database.prepare("DELETE FROM administration_grants WHERE account_id='synthetic-account-admin'").run();await expect(x.service.view(x.principal(),new URLSearchParams())).rejects.toMatchObject({status:404});
 });
 it('throttles ordinary activity and does not count old opaque sessions as currently live after a service restart',async()=>{
  const x=setup(),entry=session('synthetic-account-player-01'),actor=x.principal(entry.accountId,false);await x.service.signIn(actor,entry);x.advance(30_000);await x.service.observe(actor,entry,'demo');expect(Number(x.source.database.prepare('SELECT last_seen_at FROM login_sessions').get()?.last_seen_at)).toBe(nowBase);
  x.advance(31_000);await x.service.observe(actor,entry,'demo');expect(Number(x.source.database.prepare('SELECT last_seen_at FROM login_sessions').get()?.last_seen_at)).toBe(x.now());
  const restarted=new LoginAnalyticsService(x.source);await restarted.initialize();const report=await restarted.view(x.principal(),new URLSearchParams());expect(report.summary).toMatchObject({signIns:1,activeAccounts:1,activeSessions:0});
 });
 it('ends a server-validated local session after its account is disabled without marking collection broken',async()=>{
  const x=setup(),entry=session('synthetic-account-manager-2');await x.service.signIn(x.principal(entry.accountId),entry);x.source.database.prepare("UPDATE accounts SET status='disabled' WHERE id=?").run(entry.accountId);await x.service.logout(entry);expect(x.source.database.prepare('SELECT ended_at FROM login_sessions').get()?.ended_at).toBe(x.now());const report=await x.service.view(x.principal(),new URLSearchParams());expect(report.coverage.collectionHealthy).toBe(true);expect(report.events.filter(e=>e.type==='logout')).toHaveLength(1);
 });
 it('reports first verified OIDC application use at observation time, distinct from authentication time',async()=>{
  const x=setup(),actor={...x.principal('synthetic-account-manager-2'),authenticatedAt:nowBase-3_600_000};await x.service.observe(actor,null,'oidc');x.advance(61_000);await x.service.observe(actor,null,'oidc');const report=await x.service.view(x.principal(),new URLSearchParams());expect(report.events).toHaveLength(1);expect(report.events[0].at).toBe(nowBase);expect(report.summary.activeSessions).toBeNull();expect(report.coverage.upstreamProviderFailuresIncluded).toBe(false);
 });
 it('marks collection gaps while retaining original authentication outcomes when persistence fails',async()=>{
  const x=setup();await x.service.initialize();const db=x.source.database;db.exec("CREATE TRIGGER reject_login_event BEFORE INSERT ON login_events BEGIN SELECT RAISE(ABORT,'test-only-storage-failure');END;");const error=vi.spyOn(console,'error').mockImplementation(()=>{});await expect(x.service.signIn(x.principal('synthetic-account-manager-2'),session('synthetic-account-manager-2'))).resolves.toBeUndefined();db.exec('DROP TRIGGER reject_login_event');const report=await x.service.view(x.principal(),new URLSearchParams());expect(report.coverage.collectionHealthy).toBe(false);expect(report.events).toEqual([]);expect(db.prepare('SELECT count(*) n FROM login_sessions').get()?.n).toBe(0);expect(error).toHaveBeenCalledWith('LONGBALL_LOGIN_REPORT_WRITE_FAILED');
 });
});
