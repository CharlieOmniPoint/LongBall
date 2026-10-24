import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDatabase, type PgApplicationContext } from './pg';
import { PostgresStore, SYNTHETIC_IDS } from './postgres-store';
import { PgMediaService } from './postgres-media';
import { PostgresActivationService } from './postgres-activation';
import { applyRuntimeGrants } from './runtime-grants';
import { ReportExportRepository, type ExportRow } from './report-export-repository';

const configured=process.env.LONGBALL_POSTGRES_TEST_URL;
describe.skipIf(!configured)('API04 encrypted export repository with actual restricted PostgreSQL logins',()=>{
  let admin:Pool,owner:PgDatabase,api:PgDatabase,worker:PgDatabase;
  let apiRepository:ReportExportRepository,workerRepository:ReportExportRepository;
  let database:string,directory:string,roles:{owner:string;api:string;worker:string};
  const pools:PgDatabase[]=[];
  const context=(changes:Partial<Extract<PgApplicationContext,{kind:'actor'}>>={}):Extract<PgApplicationContext,{kind:'actor'}>=>({kind:'actor',accountId:'synthetic-account-manager',issuer:'urn:longball:synthetic',subject:'synthetic-account-manager',strongAuth:true,authenticatedAtMs:Date.now(),nowMs:Date.now(),requestedRole:'manager',clubId:'synthetic-richmond-rovers',teamId:SYNTHETIC_IDS.teamId,seasonId:SYNTHETIC_IDS.seasonId,operation:'exports.request',...changes});
  async function create(changes:Partial<ExportRow>={}):Promise<ExportRow>{
    const moment=Date.now(),id=`report_${randomUUID()}`,accountId=changes.account_id??'synthetic-account-manager';
    return api.withContext(context({accountId,subject:accountId,requestedRole:changes.role??'manager'}),async()=>{
      const row:ExportRow={id,job_id:`job_${id}`,account_id:accountId,issuer:'urn:longball:synthetic',subject:accountId,team_id:SYNTHETIC_IDS.teamId,season_id:SYNTHETIC_IDS.seasonId,role:'manager',player_id:null,request_json:JSON.stringify({teamId:SYNTHETIC_IDS.teamId,seasonId:SYNTHETIC_IDS.seasonId,kind:'season_results',format:'pdf'}),status:'queued',created_at:moment,expires_at:moment+60_000,generated_at:null,failure_code:null,publication_json:'[]',source_fingerprint:await apiRepository.sourceFingerprint(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId),snapshot_ciphertext:'encrypted-snapshot:test-value',artifact_ciphertext:null,artifact_sha256:null,key_id:'review-test-key',version:0,...changes};
      await apiRepository.create(row);return row;
    });
  }
  beforeAll(async()=>{
    admin=new Pool({connectionString:configured,max:2});const suffix=randomUUID().replaceAll('-','');database=`lb_export_${suffix}`;
    roles={owner:`lb_export_owner_${suffix}`,api:`lb_export_api_${suffix}`,worker:`lb_export_worker_${suffix}`};
    for(const role of Object.values(roles))await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`);
    await admin.query(`CREATE DATABASE "${database}"`);const url=new URL(configured!);url.pathname=`/${database}`;
    const bootstrap=new Pool({connectionString:url.href});try{await bootstrap.query(`CREATE SCHEMA longball AUTHORIZATION "${roles.owner}"`);await bootstrap.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');}finally{await bootstrap.end();}
    const connect=(role:string,mode:'apply'|'verify')=>{const target=new URL(url);target.username=role;target.password='';const db=new PgDatabase(target.href,{migrationMode:mode,maximumConnections:2});pools.push(db);return db;};
    owner=connect(roles.owner,'apply');await owner.migrate();const store=new PostgresStore(owner);await store.seedSynthetic();
    directory=await mkdtemp(join(tmpdir(),'longball-export-boundary-'));await PgMediaService.open({directory,database:owner});await new PostgresActivationService({store}).initialize();
    await applyRuntimeGrants(owner,{apiRole:roles.api,workerRole:roles.worker});api=connect(roles.api,'verify');worker=connect(roles.worker,'verify');await api.migrate();await worker.migrate();
    apiRepository=new ReportExportRepository(new PostgresStore(api));workerRepository=new ReportExportRepository(new PostgresStore(worker));
  });
  beforeEach(async()=>{await owner.query("UPDATE jobs SET state='failed',lease_until=NULL WHERE kind='report.export' AND state IN('pending','leased')");});
  afterAll(async()=>{for(const pool of pools)await pool.close();if(database)await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);for(const role of Object.values(roles??{}))await admin.query(`DROP ROLE "${role}"`);if(directory)await rm(directory,{recursive:true,force:true});await admin.end();});
  it('binds status to the requester, explicit role and narrowed scope while exposing no raw source helper',async()=>{
    const row=await create();
    expect((await api.query('SELECT * FROM report_exports')).rows).toEqual([]);
    await api.withContext(context({operation:'exports.read',clubId:undefined,teamId:undefined,seasonId:undefined}),async()=>{expect((await apiRepository.get(row.id))?.id).toBe(row.id);expect((await apiRepository.current(row)).allowed).toBe(true);});
    for(const changes of [{accountId:'synthetic-account-manager-2',subject:'synthetic-account-manager-2'},{requestedRole:'player' as const},{teamId:'synthetic-other-team'},{seasonId:'other-season'},{clubId:'synthetic-other-club'}])await api.withContext(context({operation:'exports.read',...changes}),async()=>{expect(await apiRepository.get(row.id)).toBeUndefined();await expect(apiRepository.current(row)).rejects.toMatchObject({code:'42501'});});
    await expect(api.query("SELECT report_export_fingerprint_raw($1,$2)",[row.team_id,row.season_id])).rejects.toMatchObject({code:'42501'});
    await expect(api.query("SELECT * FROM claim_due_job('report.export',0,repeat('a',64))")).rejects.toMatchObject({code:'42501'});
    await api.withContext(context({teamId:'synthetic-other-team'}),async()=>{await expect(apiRepository.sourceFingerprint(row.team_id,row.season_id)).rejects.toMatchObject({code:'42501'});});
  });
  it('gives an exact export lease only encrypted bytes and no private records, accounts or matches',async()=>{
    const row=await create(),claim=await workerRepository.claim();expect(claim?.row.id).toBe(row.id);
    await workerRepository.withClaim(claim!,async()=>{
      expect((await workerRepository.get(row.id))?.snapshot_ciphertext).toBe('encrypted-snapshot:test-value');
      expect((await workerRepository.current(row)).allowed).toBe(true);
      for(const table of ['documents','accounts','memberships','matches'])expect((await worker.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
      await expect(worker.query("SELECT report_export_fingerprint_raw($1,$2)",[row.team_id,row.season_id])).rejects.toMatchObject({code:'42501'});
      await expect(workerRepository.sourceFingerprint(row.team_id,row.season_id)).rejects.toMatchObject({code:'42501'});
      await expect(worker.query('UPDATE report_exports SET expires_at=expires_at+1,version=version+1 WHERE id=$1',[row.id])).rejects.toMatchObject({code:'23514'});
    });
    await workerRepository.withClaim({...claim!,leaseToken:randomBytes(32).toString('hex')},async()=>{expect(await workerRepository.get(row.id)).toBeUndefined();expect(await workerRepository.finish(claim!,{artifactCiphertext:'encrypted-artifact',artifactSha256:'a'.repeat(64),generatedAtMs:Date.now()})).toBe(false);});
    expect((await worker.query('SELECT * FROM report_exports')).rows).toEqual([]);
  });
  it('denies direct owned-row SQL after membership expiry or spectator grant revocation',async()=>{
    const manager=await create(),spectator=await create({account_id:'synthetic-account-spectator',role:'spectator'}),player=await create({account_id:'synthetic-account-player-01',role:'player',player_id:'synthetic-player-01'});
    const original=(await owner.query('SELECT expires_at FROM memberships WHERE account_id=$1 AND team_id=$2 AND season_id=$3 AND role=$4',[manager.account_id,manager.team_id,manager.season_id,'manager'])).rows[0]?.expires_at;
    await owner.query("UPDATE memberships SET expires_at=$1 WHERE account_id=$2 AND team_id=$3 AND season_id=$4 AND role='manager'",[Date.now()-1,manager.account_id,manager.team_id,manager.season_id]);
    try{await api.withContext(context({operation:'exports.download',teamId:undefined,seasonId:undefined,clubId:undefined}),async()=>{expect((await api.query('SELECT artifact_ciphertext,snapshot_ciphertext FROM report_exports WHERE id=$1',[manager.id])).rows).toEqual([]);await expect(apiRepository.current(manager)).rejects.toMatchObject({code:'42501'});});}finally{await owner.query("UPDATE memberships SET expires_at=$1 WHERE account_id=$2 AND team_id=$3 AND season_id=$4 AND role='manager'",[original??null,manager.account_id,manager.team_id,manager.season_id]);}
    const originalCommunity=(await owner.query("SELECT value_json FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='community'",[spectator.team_id,spectator.season_id])).rows[0]?.value_json as string;
    const community=JSON.parse(originalCommunity) as {grants:{accountId:string;revokedAtMs:number|null}[]};community.grants=community.grants.map(grant=>grant.accountId===spectator.account_id?{...grant,revokedAtMs:Date.now()}:grant);
    await owner.query("UPDATE documents SET value_json=$1,revision=revision+1 WHERE team_id=$2 AND season_id=$3 AND kind='community'",[JSON.stringify(community),spectator.team_id,spectator.season_id]);
    try{await api.withContext(context({accountId:spectator.account_id,subject:spectator.account_id,requestedRole:'spectator',operation:'exports.download'}),async()=>{expect((await api.query('SELECT artifact_ciphertext,snapshot_ciphertext FROM report_exports WHERE id=$1',[spectator.id])).rows).toEqual([]);await expect(apiRepository.current(spectator)).rejects.toMatchObject({code:'42501'});});}finally{await owner.query("UPDATE documents SET value_json=$1,revision=revision+1 WHERE team_id=$2 AND season_id=$3 AND kind='community'",[originalCommunity,spectator.team_id,spectator.season_id]);}
    await owner.query("UPDATE memberships SET player_id='synthetic-player-02' WHERE account_id=$1 AND team_id=$2 AND season_id=$3 AND role='player'",[player.account_id,player.team_id,player.season_id]);
    try{await api.withContext(context({accountId:player.account_id,subject:player.account_id,requestedRole:'player',operation:'exports.read'}),async()=>{expect(await apiRepository.get(player.id)).toBeUndefined();});}finally{await owner.query("UPDATE memberships SET player_id=$1 WHERE account_id=$2 AND team_id=$3 AND season_id=$4 AND role='player'",[player.player_id,player.account_id,player.team_id,player.season_id]);}
    await api.withContext(context({operation:'exports.read',strongAuth:false}),async()=>{expect(await apiRepository.get(manager.id)).toBeUndefined();});
  });
  it('rejects rewritten metadata and stale capabilities after a durable reclaim, then commits bytes atomically',async()=>{
    const row=await create();
    await api.withContext(context(),async()=>{await expect(api.query('UPDATE report_exports SET team_id=$1,version=version+1 WHERE id=$2',['synthetic-other-team',row.id])).rejects.toMatchObject({code:'23514'});await expect(api.query("UPDATE report_exports SET status='ready',artifact_ciphertext='untrusted',artifact_sha256=repeat('a',64),generated_at=$1,version=version+1 WHERE id=$2",[Date.now(),row.id])).rejects.toMatchObject({code:'42501'});});
    const old=await workerRepository.claim();expect(old?.attempt).toBe(1);
    await owner.query('UPDATE jobs SET lease_until=floor(extract(epoch FROM clock_timestamp())*1000)::bigint-1 WHERE id=$1',[row.job_id]);
    const restarted=new ReportExportRepository(new PostgresStore(worker)),current=await restarted.claim();expect(current?.attempt).toBe(2);
    await workerRepository.withClaim(old!,async()=>{expect(await workerRepository.finish(old!,{artifactCiphertext:'encrypted-old',artifactSha256:'a'.repeat(64),generatedAtMs:Date.now()})).toBe(false);});
    expect(await restarted.withClaim(current!,()=>restarted.finish(current!,{artifactCiphertext:'encrypted-current',artifactSha256:'b'.repeat(64),generatedAtMs:Date.now()}))).toBe(true);
    const saved=(await owner.query('SELECT * FROM report_exports WHERE id=$1',[row.id])).rows[0];expect(saved.status).toBe('ready');expect(saved.snapshot_ciphertext).toBeNull();expect(saved.artifact_ciphertext).toBe('encrypted-current');expect((await owner.query('SELECT state FROM jobs WHERE id=$1',[row.job_id])).rows[0]?.state).toBe('completed');
  });
  it('rechecks current role and source inside the artifact commit and clears an invalidated export',async()=>{
    const revoked=await create({account_id:'synthetic-account-manager-2'}),revokedClaim=await workerRepository.claim();
    await owner.query("UPDATE memberships SET revoked_at=$1 WHERE account_id=$2 AND team_id=$3 AND season_id=$4 AND role='manager'",[Date.now(),revoked.account_id,revoked.team_id,revoked.season_id]);
    try{await workerRepository.withClaim(revokedClaim!,async()=>{expect((await workerRepository.current(revoked)).allowed).toBe(false);expect(await workerRepository.finish(revokedClaim!,{artifactCiphertext:'encrypted-revoked',artifactSha256:'a'.repeat(64),generatedAtMs:Date.now()})).toBe(false);});}finally{await owner.query("UPDATE memberships SET revoked_at=NULL WHERE account_id=$1 AND team_id=$2 AND season_id=$3 AND role='manager'",[revoked.account_id,revoked.team_id,revoked.season_id]);}
    const changed=await create(),changedClaim=await workerRepository.claim();
    await owner.query("UPDATE documents SET revision=revision+1 WHERE team_id=$1 AND season_id=$2 AND kind='records'",[changed.team_id,changed.season_id]);
    expect(await workerRepository.withClaim(changedClaim!,()=>workerRepository.finish(changedClaim!,{artifactCiphertext:'encrypted-outdated',artifactSha256:'a'.repeat(64),generatedAtMs:Date.now()}))).toBe(false);
    for(const id of [revoked.id,changed.id]){const saved=(await owner.query('SELECT status,snapshot_ciphertext,artifact_ciphertext FROM report_exports WHERE id=$1',[id])).rows[0];expect(saved).toEqual({status:'failed',snapshot_ciphertext:null,artifact_ciphertext:null});}
  });
  it('keeps retry snapshots private and clears them at the third failed generation',async()=>{
    const row=await create();
    for(let attempt=1;attempt<=3;attempt++){
      const claim=await workerRepository.claim();expect(claim?.attempt).toBe(attempt);expect(await workerRepository.withClaim(claim!,()=>workerRepository.fail(claim!,'EXPORT_RENDER_FAILED',false))).toBe(true);
      const saved=(await owner.query('SELECT status,snapshot_ciphertext FROM report_exports WHERE id=$1',[row.id])).rows[0];expect(saved.status).toBe(attempt===3?'failed':'queued');expect(saved.snapshot_ciphertext).toBe(attempt===3?null:'encrypted-snapshot:test-value');
      if(attempt<3)await owner.query('UPDATE jobs SET due_at=0 WHERE id=$1',[row.job_id]);
    }
    expect((await owner.query('SELECT state,attempts FROM jobs WHERE id=$1',[row.job_id])).rows[0]).toEqual({state:'failed',attempts:3});
  });
  it('uses the independent database clock to expire artifacts and settles only the bounded cleanup scope',async()=>{
    const moment=Date.now(),row=await create({created_at:moment,expires_at:moment+1000});
    await expect(api.query('SELECT purge_report_exports()')).rejects.toMatchObject({code:'42501'});
    expect(await workerRepository.purgeExpired()).toBe(0);
    await new Promise(resolve=>setTimeout(resolve,1100));
    expect(await workerRepository.purgeExpired()).toBe(1);
    expect((await owner.query('SELECT status,snapshot_ciphertext,artifact_ciphertext,failure_code FROM report_exports WHERE id=$1',[row.id])).rows[0]).toEqual({status:'expired',snapshot_ciphertext:null,artifact_ciphertext:null,failure_code:'EXPORT_EXPIRED'});
    expect((await owner.query('SELECT state FROM jobs WHERE id=$1',[row.job_id])).rows[0]?.state).toBe('failed');
  });
  it('upgrades the actual preceding schema15, rolls back a late failure, and retries without changing domain bytes',async()=>{
    const upgradeDatabase=`lb_export_upgrade_${randomUUID().replaceAll('-','')}`,url=new URL(configured!);url.pathname=`/${upgradeDatabase}`;
    await admin.query(`CREATE DATABASE "${upgradeDatabase}"`);const bootstrap=new Pool({connectionString:url.href});
    try{await bootstrap.query(`CREATE SCHEMA longball AUTHORIZATION "${roles.owner}"`);await bootstrap.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');}finally{await bootstrap.end();}
    url.username=roles.owner;url.password='';const preceding=new PgDatabase(url.href,{maximumConnections:1});
    try{
      await preceding.query('CREATE TABLE schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
      const migrationsUrl=new URL('../migrations/postgresql/',import.meta.url);
      const files=['002_runtime.sql','003_clock_review.sql','004_account_requests.sql','005_scope_security.sql','006_award_notifications.sql','007_worker_boundaries.sql','008_controller_revocation.sql','009_dispatch_database_clock.sql','010_brand_assets.sql','011_spectator_capabilities.sql','012_heic_support.sql','013_team_privileges.sql','014_push_registrations.sql','015_team_privilege_audit_clock.sql'];
      expect(files).toHaveLength(14);
      for(const name of files)await preceding.transaction(async()=>{await preceding.query(await readFile(new URL(name,migrationsUrl),'utf8'));await preceding.query('INSERT INTO schema_migrations(version) VALUES($1)',[Number(name.slice(0,3))]);});
      const precedingStore=new PostgresStore(preceding);await precedingStore.seedSynthetic();
      const domainBefore=(await preceding.query('SELECT id,state_json,config_json,sharing_policy_json FROM matches ORDER BY id')).rows;
      expect((await preceding.query('SELECT max(version) AS version FROM schema_migrations')).rows[0]?.version).toBe(15);
      expect((await preceding.query("SELECT to_regclass('longball.report_exports')::text AS relation")).rows[0]?.relation).toBeNull();
      // A late collision proves DDL, RLS and claim-function replacement are one atomic migration.
      await preceding.query('CREATE FUNCTION purge_report_exports() RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$');
      await expect(preceding.migrate()).rejects.toMatchObject({code:'42723'});
      expect((await preceding.query('SELECT max(version) AS version FROM schema_migrations')).rows[0]?.version).toBe(15);
      expect((await preceding.query("SELECT to_regclass('longball.report_exports')::text AS relation")).rows[0]?.relation).toBeNull();
      expect(String((await preceding.query("SELECT pg_get_functiondef('longball.claim_due_job(text,bigint,text)'::regprocedure) AS definition")).rows[0]?.definition)).not.toContain('report.export');
      await preceding.query('DROP FUNCTION purge_report_exports()');await preceding.migrate();await preceding.migrate();
      expect((await preceding.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row=>row.version)).toEqual([2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25]);
      expect((await preceding.query('SELECT id,state_json,config_json,sharing_policy_json FROM matches ORDER BY id')).rows).toEqual(domainBefore);
      expect((await preceding.query("SELECT relrowsecurity AS rls FROM pg_class WHERE oid='longball.report_exports'::regclass")).rows[0]?.rls).toBe(true);
    }finally{await preceding.close();await admin.query(`DROP DATABASE "${upgradeDatabase}" WITH (FORCE)`);}
  });
});
