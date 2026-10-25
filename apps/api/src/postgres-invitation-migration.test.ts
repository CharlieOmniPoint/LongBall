import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
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
describe.skipIf(!configured)('actual PostgreSQL secret retirement and own-device metadata',()=>{
 let admin:Pool,owner:PgDatabase,api:PgDatabase,worker:PgDatabase,database:string,directory:string,grants:string,rollbackSecret:string,rollbackTable:unknown;
 const pools:PgDatabase[]=[],roles:Record<string,string>={},secret='FICTIONAL-OLD-INVITATION-SECRET',command=JSON.stringify(['synthetic-account-manager',{type:'invite.created',reviewCode:'FICTIONAL-OLD-INVITATION-SECRET'}]);
 const actor=(changes:Partial<Extract<PgApplicationContext,{kind:'actor'}>>={}):Extract<PgApplicationContext,{kind:'actor'}>=>({kind:'actor',accountId:'synthetic-account-manager',issuer:'urn:longball:synthetic',subject:'synthetic-account-manager',strongAuth:true,authenticatedAtMs:Date.now(),nowMs:Date.now(),operation:'identity.devices',...changes});
 beforeAll(async()=>{
  admin=new Pool({connectionString:configured,max:2});const suffix=randomUUID().replaceAll('-','');database=`lb_inv_${suffix}`;
  for(const purpose of ['owner','api','worker']){roles[purpose]=`lb_inv_${purpose}_${suffix}`;await admin.query(`CREATE ROLE "${roles[purpose]}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);}
  await admin.query(`CREATE DATABASE "${database}"`);const base=new URL(configured!);base.pathname=`/${database}`;const bootstrap=new Pool({connectionString:base.href});try{await bootstrap.query(`CREATE SCHEMA longball AUTHORIZATION "${roles.owner}"`);}finally{await bootstrap.end();}
  const connect=(purpose:string,mode:'apply'|'verify')=>{const url=new URL(base);url.username=roles[purpose];url.password='';const db=new PgDatabase(url.href,{migrationMode:mode,maximumConnections:1});pools.push(db);return db;};
  owner=connect('owner','apply');await owner.query('CREATE TABLE schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  const migrations=['002_runtime','003_clock_review','004_account_requests','005_scope_security','006_award_notifications','007_worker_boundaries','008_controller_revocation','009_dispatch_database_clock','010_brand_assets'];
  for(let i=0;i<migrations.length;i++){await owner.query(await readFile(new URL(`../migrations/postgresql/${migrations[i]}.sql`,import.meta.url),'utf8'));await owner.query('INSERT INTO schema_migrations(version) VALUES($1)',[i+2]);}
  const store=new PostgresStore(owner);await store.seedSynthetic();const d=(await owner.query("SELECT value_json FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='community'",[SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId])).rows[0];const state=JSON.parse(d.value_json);grants=JSON.stringify(state.grants);
  const invite={teamId:SYNTHETIC_IDS.teamId,seasonId:SYNTHETIC_IDS.seasonId,inviterAccountId:'synthetic-account-manager',reviewCode:secret,createdAtMs:100,expiresAtMs:Date.now()+60000,acceptedBy:null,acceptedAtMs:null,revokedAtMs:null};
  state.invitations=[{...invite,id:'legacy-pending'},{...invite,id:'legacy-accepted',acceptedBy:'synthetic-account-player-01',acceptedAtMs:200}];state.appliedCommands={'old-invite-command':command,'unrelated-command':'unchanged'};
  await owner.query("UPDATE documents SET value_json=$1 WHERE team_id=$2 AND season_id=$3 AND kind='community'",[JSON.stringify(state),SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId]);
  await owner.query("INSERT INTO idempotency(account_id,operation,key,signature,response_json) VALUES('synthetic-account-manager','community','old-secret-cache','retained-digest',$1)",[JSON.stringify({invitations:state.invitations,appliedCommands:state.appliedCommands,nested:{id:'created',shareUrl:`https://example.invalid/#${secret}`,expiresAt:'2026-10-21T23:00:00.000Z',teamId:SYNTHETIC_IDS.teamId,seasonId:SYNTHETIC_IDS.seasonId}})]);
  const sql=await readFile(new URL('../migrations/postgresql/011_spectator_capabilities.sql',import.meta.url),'utf8');const client=await owner.pool.connect();try{await client.query('BEGIN');await client.query(sql);await client.query('ROLLBACK');rollbackSecret=(await client.query("SELECT value_json::text AS text FROM documents WHERE team_id=$1 AND kind='community'",[SYNTHETIC_IDS.teamId])).rows[0].text;rollbackTable=(await client.query("SELECT to_regclass('longball.spectator_invitations') AS name")).rows[0].name;}finally{client.release();}
  await owner.migrate();directory=await mkdtemp(join(tmpdir(),'longball-inv-pg-'));await PgMediaService.open({directory,database:owner});await new PostgresActivationService({store}).initialize();await applyRuntimeGrants(owner,{apiRole:roles.api,workerRole:roles.worker});api=connect('api','verify');worker=connect('worker','verify');await api.migrate();
 });
 afterAll(async()=>{for(const db of pools)await db.close();if(database)await admin.query(`DROP DATABASE "${database}" WITH(FORCE)`);for(const role of Object.values(roles))await admin.query(`DROP ROLE "${role}"`);if(directory)await rm(directory,{recursive:true,force:true});await admin.end();});
 it('atomically retires every legacy secret copy while retaining accepted grants and command/cache identity',async()=>{
  expect(rollbackSecret).toContain(secret);expect(rollbackTable).toBe(null);
  const state=JSON.parse((await owner.query("SELECT value_json FROM documents WHERE team_id=$1 AND kind='community'",[SYNTHETIC_IDS.teamId])).rows[0].value_json);expect(JSON.stringify(state)).not.toContain(secret);expect(JSON.stringify(state.grants)).toBe(grants);expect(state.invitations[0].credential.requiresReissue).toBe(true);expect(state.invitations[0].revokedAtMs).toBeGreaterThan(0);expect(state.invitations[1].acceptedBy).toBe('synthetic-account-player-01');expect(state.invitations[1].revokedAtMs).toBe(null);
  const expected=createHash('sha256').update('longball.spectator-invitation.legacy-retired.v1:14:legacy-pending:'+secret).digest('hex');expect(state.invitations[0].credential.fingerprint).toBe(expected);
  expect(state.appliedCommands['old-invite-command']).toBe('invitation-command-retired:v1:'+createHash('sha256').update('longball.spectator-invitation.command-retired.v1:'+command).digest('hex'));expect(state.appliedCommands['unrelated-command']).toBe('unchanged');
  const cache=(await owner.query("SELECT signature,response_json FROM idempotency WHERE key='old-secret-cache'")).rows[0];expect(cache.signature).toBe('retained-digest');expect(cache.response_json).not.toContain(secret);expect(JSON.parse(cache.response_json).nested).toMatchObject({credentialAvailable:false,requiresReissue:true});
  expect((await owner.query('SELECT token_hash,policy_version FROM spectator_invitations')).rows).toEqual([{token_hash:null,policy_version:null},{token_hash:null,policy_version:null}]);
 });
 it('enrols only the current account/issuer with database time and no match-controller authority',async()=>{
  const context=actor({operation:'identity.enrol'}),now=Date.now();await api.withContext(context,()=>api.query("INSERT INTO native_app_devices(device_id,account_id,issuer,platform,registered_at,last_seen_at) VALUES('own-native','synthetic-account-manager','urn:longball:synthetic','ios',1,9999999999999)"));
  const row=(await api.withContext(actor(),()=>api.query('SELECT * FROM native_app_devices'))).rows[0];expect(row.registered_at).toBeGreaterThanOrEqual(now);expect(row.last_seen_at).toBe(row.registered_at);expect((await owner.query("SELECT * FROM devices WHERE id='own-native'")).rowCount).toBe(0);
  await api.withContext(context,()=>api.query("UPDATE native_app_devices SET registered_at=1,last_seen_at=1 WHERE device_id='own-native'"));const updated=(await api.withContext(actor(),()=>api.query('SELECT * FROM native_app_devices'))).rows[0];expect(updated.registered_at).toBe(row.registered_at);expect(updated.last_seen_at).toBeGreaterThanOrEqual(row.last_seen_at);
  await expect(api.withContext(context,()=>api.query("UPDATE native_app_devices SET account_id='synthetic-account-player-01' WHERE device_id='own-native'"))).rejects.toMatchObject({code:'42501'});
  expect((await api.withContext(actor({accountId:'synthetic-account-player-01',subject:'synthetic-account-player-01'}),()=>api.query('SELECT * FROM native_app_devices'))).rowCount).toBe(0);expect((await api.query('SELECT * FROM native_app_devices')).rowCount).toBe(0);await expect(worker.query('SELECT * FROM native_app_devices')).rejects.toMatchObject({code:'42501'});
 });
 it('does not expose private invitation records through an unrelated or worker capability',async()=>{
  const cap={kind:'invitation_activation' as const,tokenHash:'a'.repeat(64),nowMs:Date.now()};expect((await api.withContext(cap,()=>api.query('SELECT * FROM invitation_preflight($1)',['a'.repeat(64)]))).rowCount).toBe(0);expect((await api.withContext(cap,()=>api.query('SELECT * FROM accounts'))).rowCount).toBe(0);expect((await api.withContext(cap,()=>api.query('SELECT * FROM documents'))).rowCount).toBe(0);await expect(worker.withContext(cap,()=>worker.query('SELECT * FROM invitation_preflight($1)',['a'.repeat(64)]))).rejects.toMatchObject({code:'42501'});
 });
 it('allows current player issue and exact authenticated scope inspection without joining or exposing other invitations',async()=>{
  const player=actor({accountId:'synthetic-account-player-01',subject:'synthetic-account-player-01',requestedRole:'player',operation:'invite.issue',clubId:'synthetic-richmond-rovers',teamId:SYNTHETIC_IDS.teamId,seasonId:SYNTHETIC_IDS.seasonId});
  const tokenHash='c'.repeat(64),now=Date.now();
  await api.withContext(player,()=>api.query("INSERT INTO spectator_invitations(id,club_id,team_id,season_id,inviter_account_id,credential_kind,token_hash,created_at,expires_at,policy_version) VALUES('new-player-invite','synthetic-richmond-rovers',$1,$2,'synthetic-account-player-01','sha256',$3,$4,$5,'fictional-configured-policy-v1')",[SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,tokenHash,now,now+60000]));
  await owner.query("UPDATE documents SET value_json=jsonb_set(value_json,'{invitations}',value_json->'invitations'||$1::jsonb) WHERE team_id=$2 AND season_id=$3 AND kind='community'",[JSON.stringify([{id:'new-player-invite',teamId:SYNTHETIC_IDS.teamId,seasonId:SYNTHETIC_IDS.seasonId,inviterAccountId:'synthetic-account-player-01',credential:{kind:'sha256',version:1,tokenHash},createdAtMs:now,expiresAtMs:now+60000,acceptedBy:null,acceptedAtMs:null,revokedAtMs:null,reissuedFromInvitationId:null}]),SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId]);
  const invitee=actor({accountId:'synthetic-account-invitee',subject:'synthetic-account-invitee',strongAuth:false,operation:'invite.resolve',invitationTokenHash:tokenHash});
  await api.withContext(invitee,async()=>{const rows=(await api.query('SELECT * FROM invitation_accept_scope($1)',[tokenHash])).rows;expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({id:'new-player-invite',team_id:SYNTHETIC_IDS.teamId,season_id:SYNTHETIC_IDS.seasonId,expires_at:now+60000});expect(Object.keys(rows[0]).sort()).toEqual(['club_id','expires_at','id','season_id','season_label','team_id','team_name']);expect((await api.query('SELECT * FROM documents')).rowCount).toBe(0);expect((await api.query('SELECT * FROM spectator_invitations')).rowCount).toBe(0);expect((await api.query('SELECT * FROM invitation_accept_scope($1)',['d'.repeat(64)])).rowCount).toBe(0);});
  expect((await owner.query("SELECT * FROM memberships WHERE account_id='synthetic-account-invitee'")).rowCount).toBe(0);
  const second=actor({...player,accountId:'synthetic-account-player-02',subject:'synthetic-account-player-02'});expect((await api.withContext(second,()=>api.query('SELECT * FROM spectator_invitations'))).rowCount).toBe(0);
  await api.withContext({...player,operation:'invite.revoke'},()=>api.query("UPDATE spectator_invitations SET revoked_at=$1 WHERE id='new-player-invite'",[Date.now()]));expect((await api.withContext(invitee,()=>api.query('SELECT * FROM invitation_accept_scope($1)',[tokenHash]))).rowCount).toBe(0);
 });
});
