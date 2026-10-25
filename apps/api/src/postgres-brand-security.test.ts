import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDatabase, type PgApplicationContext } from './pg';
import { PostgresStore, SYNTHETIC_IDS } from './postgres-store';
import { PgMediaService } from './postgres-media';
import { PostgresActivationService } from './postgres-activation';
import { applyRuntimeGrants } from './runtime-grants';
const configured=process.env.LONGBALL_POSTGRES_TEST_URL;
describe.skipIf(!configured)('actual restricted PostgreSQL logo ancestry and reviewed pointers',()=>{
 let admin:Pool,owner:PgDatabase,api:PgDatabase,worker:PgDatabase,database:string,directory:string;
 const pools:PgDatabase[]=[],roles:Record<string,string>={};
 const actor=(changes:Partial<Extract<PgApplicationContext,{kind:'actor'}>>={}):Extract<PgApplicationContext,{kind:'actor'}>=>({kind:'actor',accountId:'synthetic-account-manager',issuer:'urn:longball:synthetic',subject:'synthetic-account-manager',strongAuth:true,authenticatedAtMs:Date.now(),nowMs:Date.now(),requestedRole:'manager',operation:'branding.publish',clubId:'synthetic-richmond-rovers',teamId:SYNTHETIC_IDS.teamId,seasonId:SYNTHETIC_IDS.seasonId,...changes});
 beforeAll(async()=>{
  admin=new Pool({connectionString:configured,max:2});const suffix=randomUUID().replaceAll('-','');database=`lb_brand_${suffix}`;
  for(const purpose of ['owner','api','worker']){roles[purpose]=`lb_brand_${purpose}_${suffix}`;await admin.query(`CREATE ROLE "${roles[purpose]}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);}
  await admin.query(`CREATE DATABASE "${database}"`);const base=new URL(configured!);base.pathname=`/${database}`;const bootstrap=new Pool({connectionString:base.href});
  try{await bootstrap.query(`CREATE SCHEMA longball AUTHORIZATION "${roles.owner}"`);}finally{await bootstrap.end();}
  const connect=(purpose:string,mode:'apply'|'verify')=>{const url=new URL(base);url.username=roles[purpose];url.password='';const db=new PgDatabase(url.href,{migrationMode:mode,maximumConnections:1});pools.push(db);return db;};
  owner=connect('owner','apply');await owner.migrate();const store=new PostgresStore(owner);await store.seedSynthetic();directory=await mkdtemp(join(tmpdir(),'longball-brand-'));
  await PgMediaService.open({directory,database:owner});await new PostgresActivationService({store}).initialize();await applyRuntimeGrants(owner,{apiRole:roles.api,workerRole:roles.worker});
  api=connect('api','verify');worker=connect('worker','verify');await api.migrate();await worker.migrate();
 });
 afterAll(async()=>{for(const db of pools)await db.close();if(database)await admin.query(`DROP DATABASE "${database}" WITH(FORCE)`);for(const role of Object.values(roles))await admin.query(`DROP ROLE "${role}"`);if(directory)await rm(directory,{recursive:true,force:true});await admin.end();});
 const prepare=(id:string,kind='team_logo',team:string|null=SYNTHETIC_IDS.teamId,club='synthetic-richmond-rovers')=>api.query(`INSERT INTO brand_assets(id,asset_id,revision,kind,club_id,team_id,owner_id,request_id,request_signature,status,expected_bytes,expected_sha,declared_mime,token_hash,expires_at,created_at) VALUES($1,$1,1,$2,$3,$4,$5,$1,$1,'prepared',4,repeat('a',64),'image/png',repeat('b',64),$6,$7)`,[id,kind,club,team,api.applicationContext?.kind==='actor'?api.applicationContext.accountId:'',Date.now()+60000,Date.now()]);
 it('uses exact selected logo role and cannot substitute nullable kind ancestry or tenant',async()=>{
  await api.withContext(actor(),()=>prepare('manager-team'));
  await expect(api.withContext(actor(),()=>prepare('manager-club','club_logo',null))).rejects.toMatchObject({code:'42501'});
  const adminContext=actor({accountId:'synthetic-account-admin',subject:'synthetic-account-admin',requestedRole:'administrator'});
  await api.withContext(adminContext,()=>prepare('admin-club','club_logo',null));
  await expect(api.withContext(adminContext,()=>prepare('admin-team'))).rejects.toMatchObject({code:'42501'});
  await expect(api.withContext(actor(),()=>prepare('wrong-club','team_logo',SYNTHETIC_IDS.teamId,'synthetic-other-club'))).rejects.toMatchObject({code:'42501'});
  await expect(api.withContext(actor(),()=>prepare('bad-null','team_logo',null))).rejects.toMatchObject({code:'42501'});
  await expect(owner.query("INSERT INTO brand_assets(id,asset_id,revision,kind,club_id,owner_id,request_id,request_signature,status,expected_bytes,expected_sha,declared_mime,token_hash,expires_at,created_at) VALUES('bad-owner-null','bad-owner-null',1,'team_logo','synthetic-richmond-rovers','synthetic-account-manager','bad-owner-null','test','prepared',4,repeat('a',64),'image/png',repeat('b',64),2,1)")).rejects.toMatchObject({code:'23514'});
  await expect(api.withContext(actor(),()=>api.query("UPDATE brand_assets SET team_id='synthetic-other-team' WHERE id='manager-team'"))).rejects.toMatchObject({code:'23514'});
  await expect(worker.query('SELECT * FROM brand_assets')).rejects.toMatchObject({code:'42501'});
 });
 it('publishes only processed reviewed revisions, enforces CAS and current-pointer inheritance',async()=>{
  await api.withContext(actor(),async()=>{
   await expect(api.query("INSERT INTO brand_slots(kind,club_id,team_id,version,asset_id,asset_revision,reviewed_revision,policy_version,confirmed_by,confirmed_at) VALUES('team_logo','synthetic-richmond-rovers',$1,1,'manager-team',1,1,'logo-rights-v1','synthetic-account-manager',$2)",[SYNTHETIC_IDS.teamId,Date.now()])).rejects.toMatchObject({code:'23514'});
   await api.query("UPDATE brand_assets SET status='processed',processed_at=$1,width=2,height=2,scanner_engine='actual-test-adapter',display_key='brand/display.png',thumbnail_key='brand/thumb.png' WHERE id='manager-team'",[Date.now()]);
   await api.query("INSERT INTO brand_slots(kind,club_id,team_id,version,asset_id,asset_revision,reviewed_revision,policy_version,confirmed_by,confirmed_at) VALUES('team_logo','synthetic-richmond-rovers',$1,1,'manager-team',1,1,'logo-rights-v1','synthetic-account-manager',$2)",[SYNTHETIC_IDS.teamId,Date.now()]);
   await api.query("UPDATE brand_assets SET status='linked' WHERE id='manager-team'");
   await expect(api.query("UPDATE brand_slots SET version=1 WHERE kind='team_logo'")).rejects.toMatchObject({code:'23514'});
  });
  const player=actor({accountId:'synthetic-account-player-01',subject:'synthetic-account-player-01',requestedRole:'player',operation:'branding.gateway'});
  expect((await api.withContext(player,()=>api.query('SELECT id FROM brand_assets'))).rows).toEqual([{id:'manager-team'}]);
  await api.withContext(actor(),()=>api.query("UPDATE brand_slots SET version=2,asset_id=NULL,asset_revision=NULL,reviewed_revision=NULL,policy_version=NULL WHERE kind='team_logo'"));
  expect((await api.withContext(player,()=>api.query('SELECT id FROM brand_assets'))).rowCount).toBe(0);
  expect((await api.withContext(actor(),()=>api.query('SELECT id FROM brand_assets'))).rowCount).toBe(1);
 });
 it('returns only branding names through a scoped administrator helper without private documents',async()=>{
  const adminContext=actor({accountId:'synthetic-account-admin',subject:'synthetic-account-admin',requestedRole:'administrator',operation:'branding.read'});
  await api.withContext(adminContext,async()=>{const row=(await api.query('SELECT * FROM branding_context($1,$2)',[SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId])).rows[0];expect(Object.keys(row).sort()).toEqual(['age_group','club_id','club_name','team_id','team_name']);expect(row.age_group).toBe('U10');expect((await api.query('SELECT * FROM documents')).rowCount).toBe(0);expect((await api.query('SELECT * FROM branding_context($1,$2)',['synthetic-other-team',SYNTHETIC_IDS.seasonId])).rowCount).toBe(0);});
  expect((await api.query('SELECT * FROM brand_slots')).rowCount).toBe(0);
 });
});
