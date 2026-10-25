import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { LoginAnalyticsService } from './login-analytics-service';
import { PostgresStore } from './postgres-store';
import { PgMediaService } from './postgres-media';
import { PostgresActivationService } from './postgres-activation';
import { applyRuntimeGrants } from './runtime-grants';
import { PgDatabase } from './pg';

const configured=process.env.LONGBALL_POSTGRES_TEST_URL;
async function fixture(){
 const admin=new Pool({connectionString:configured,max:2}),suffix=randomUUID().replaceAll('-',''),database=`lb_login_${suffix}`,roles={apiRole:`lb_login_api_${suffix}`,workerRole:`lb_login_worker_${suffix}`},directory=await mkdtemp(join(tmpdir(),'lb-login-pg-'));
 let now=Date.now();let owner:PostgresStore|undefined,api:PostgresStore|undefined,worker:PgDatabase|undefined,media:PgMediaService|undefined;
 const close=async()=>{await media?.close();await api?.close();await worker?.close();await owner?.close();await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH(FORCE)`);for(const role of Object.values(roles))await admin.query(`DROP ROLE IF EXISTS "${role}"`);await admin.end();await rm(directory,{recursive:true,force:true});};
 try{
  await admin.query(`CREATE DATABASE "${database}"`);for(const role of Object.values(roles))await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
  const url=new URL(configured!);url.pathname=`/${database}`;owner=await PostgresStore.open(url.href,()=>now);await owner.seedSynthetic({demoSharing:true});media=await PgMediaService.open({directory:join(directory,'media'),database:owner.db});await new PostgresActivationService({store:owner}).initialize();await applyRuntimeGrants(owner.db,roles);
  const apiUrl=new URL(url);apiUrl.username=roles.apiRole;apiUrl.password='';api=await PostgresStore.open(apiUrl.href,()=>now,{migrationMode:'verify'});
  const workerUrl=new URL(url);workerUrl.username=roles.workerRole;workerUrl.password='';worker=new PgDatabase(workerUrl.href,{migrationMode:'verify'});
  const principal=async(subject='synthetic-account-admin',strongAuth=true)=>{const identity={issuer:'urn:longball:synthetic',subject,strongAuth,authenticatedAt:now};return api!.withIdentityContext(identity,()=>api!.principal(identity));};
  const report=async(service:LoginAnalyticsService,query=new URLSearchParams())=>{const actor=await principal();return api!.withActorContext(actor,{operation:'administration.read',requestedRole:'administrator'},()=>service.view(actor,query));};
  return{owner,api,worker,service:new LoginAnalyticsService(api),roles,now:()=>now,advance:(ms:number)=>{now+=ms;},principal,report,close};
 }catch(error){await close();throw error;}
}
describe.skipIf(!configured)('restricted PostgreSQL application login analytics',()=>{
 it('records real application observations and logout with no raw-table or worker privilege, and validates direct function input',async()=>{
  const x=await fixture();try{
   await x.service.initialize();const actor=await x.principal('synthetic-account-manager-2'),entry={accountId:actor.accountId,sessionId:randomUUID(),provider:'demo' as const,issuedAtMs:x.now(),expiresAtMs:x.now()+3_600_000};
   await x.service.signIn(actor,entry);await x.service.recordFailure({kind:'login_failure',provider:'demo',at:x.now(),reason:'invalid_credentials'});await x.service.recordFailure({kind:'login_failure',provider:'demo',at:x.now(),reason:'invalid_credentials'});
   const report=await x.report(x.service);expect(report.coverage.collectionHealthy).toBe(true);expect(report.summary).toMatchObject({signIns:1,failedAttempts:2,uniqueAccounts:1,activeAccounts:1,activeSessions:1});expect(report.events.filter(e=>e.type==='login_failure').every(e=>e.accountId===null&&e.actorLabel===null&&e.scopes.length===0)).toBe(true);
   for(const table of ['login_reporting_state','login_access_snapshots','login_events','login_sessions']){await expect(x.api.one(`SELECT * FROM ${table}`)).rejects.toMatchObject({code:'42501'});await expect(x.worker.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({code:'42501'});}
   await expect(x.worker.query('SELECT login_analytics_snapshot(0,1,0)')).rejects.toMatchObject({code:'42501'});
   const club=await x.principal('synthetic-account-club-admin');await expect(x.api.withActorContext(club,{operation:'administration.read',requestedRole:'administrator'},()=>x.service.view(club,new URLSearchParams()))).rejects.toMatchObject({status:404});
   const incompleteContext={kind:'actor',accountId:'synthetic-account-admin',issuer:'urn:longball:synthetic',subject:'synthetic-account-admin',authenticatedAtMs:x.now(),nowMs:x.now(),operation:'administration.read',requestedRole:'administrator'};
   await expect(x.api.transaction(async()=>{await x.api.execute("SELECT set_config('longball.context',$1,true)",[JSON.stringify(incompleteContext)]);await x.api.one('SELECT login_analytics_snapshot($1,$2,$3)',[x.now()-86_400_000,x.now(),x.now()-900_000]);})).rejects.toMatchObject({code:'42501'});
   await expect(x.api.transaction(async()=>{await x.api.execute("SELECT set_config('longball.context',$1,true)",[JSON.stringify(incompleteContext)]);await x.api.one('SELECT login_analytics_enabled_accounts(NULL,NULL,NULL)');})).rejects.toMatchObject({code:'42501'});
   const valid={type:'activity',at:x.now(),provider:'demo',accountId:actor.accountId,sessionId:randomUUID(),runtimeId:randomUUID(),issuedAtMs:x.now(),expiresAtMs:x.now()+3_600_000};
   const superActor=await x.principal();await expect(x.api.withActorContext(superActor,{operation:'administration.read',requestedRole:'administrator'},()=>x.api.one('SELECT login_activity_write($1::jsonb)',[JSON.stringify({...valid,accountId:superActor.accountId})]))).rejects.toMatchObject({code:'42501'});
   for(const invalid of [{...valid,type:null},{...valid,provider:null},{...valid,runtimeId:123},{...valid,sessionId:123},{...valid,issuedAtMs:null},{...valid,expiresAtMs:'999'},{...valid,expiresAtMs:x.now()-1},{...valid,password:'must-not-be-accepted'}])await expect(x.api.withActorContext(actor,{operation:'login.activity',requestedRole:'default'},()=>x.api.one('SELECT login_activity_write($1::jsonb)',[JSON.stringify(invalid)]))).rejects.toBeDefined();
   const stranger=await x.principal('synthetic-account-player-01',false);await expect(x.api.withActorContext(stranger,{operation:'login.activity',requestedRole:'default'},()=>x.api.one('SELECT login_activity_write($1::jsonb)',[JSON.stringify({type:'logout',at:x.now(),provider:'demo',accountId:actor.accountId,sessionId:entry.sessionId,runtimeId:x.service.runtimeId})]))).rejects.toMatchObject({code:'42501'});
   await x.service.logout(entry);const ended=await x.report(x.service);expect(ended.coverage.collectionHealthy).toBe(true);expect(ended.summary.activeSessions).toBe(0);expect(ended.events.filter(e=>e.type==='logout')).toHaveLength(1);expect(ended.events.every(e=>!e.id.includes(entry.sessionId))).toBe(true);
   const restarted=new LoginAnalyticsService(x.api);await restarted.initialize();expect((await x.report(restarted)).summary.activeSessions).toBe(0);
   const disabledEntry={...entry,sessionId:randomUUID()};await x.service.signIn(actor,disabledEntry);await x.owner.execute("UPDATE accounts SET status='disabled' WHERE id=$1",[actor.accountId]);await x.service.logout(disabledEntry);expect((await x.report(x.service)).coverage.collectionHealthy).toBe(true);expect((await x.owner.one('SELECT ended_at FROM login_sessions WHERE session_id=$1',[disabledEntry.sessionId]))?.ended_at).toBe(x.now());
   const stale=await x.principal();await x.owner.execute("DELETE FROM administration_grants WHERE account_id='synthetic-account-admin'");await expect(x.api.withActorContext(stale,{operation:'administration.read',requestedRole:'administrator'},()=>x.service.view(stale,new URLSearchParams()))).rejects.toMatchObject({status:404});
  }finally{await x.close();}
 });
 it('serializes event ordinal allocation through commit so a frozen high-water prefix cannot gain late older commits',async()=>{
  const x=await fixture();try{
   await x.service.initialize();const actor=await x.principal('synthetic-account-manager-2');let release!:()=>void,ready!:()=>void;const hold=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{ready=r;});
   const input=(id:string)=>({type:'login_success',at:x.now(),provider:'demo',accountId:actor.accountId,sessionId:id,runtimeId:x.service.runtimeId,issuedAtMs:x.now(),expiresAtMs:x.now()+3_600_000});
   const first=x.api.withActorContext(actor,{operation:'login.activity',requestedRole:'default'},()=>x.api.transaction(async()=>{await x.api.one('SELECT login_activity_write($1::jsonb)',[JSON.stringify(input(randomUUID()))]);ready();await hold;}));
   await entered;let secondDone=false;
   const second=x.api.withActorContext(actor,{operation:'login.activity',requestedRole:'default'},()=>x.api.transaction(async()=>{await x.api.one('SELECT login_activity_write($1::jsonb)',[JSON.stringify(input(randomUUID()))]);secondDone=true;}));
   await new Promise(r=>setTimeout(r,80));expect(secondDone).toBe(false);expect((await x.report(x.service)).summary.signIns).toBe(0);
   release();await first;await second;expect((await x.report(x.service)).summary.signIns).toBe(2);
  }finally{await x.close();}
 });
});
