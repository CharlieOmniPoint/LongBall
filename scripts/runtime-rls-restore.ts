/** Restore a retained fictional media checkpoint into isolated non-bypass current runtimes. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { PostgresStore, SYNTHETIC_IDS } from '../apps/api/src/postgres-store';
import { PgMediaService } from '../apps/api/src/postgres-media';
import { PostgresActivationService } from '../apps/api/src/postgres-activation';
import { applyRuntimeGrants } from '../apps/api/src/runtime-grants';
import type { CommunityState } from '../packages/application/src/community';
const { Pool } = createRequire(resolve('apps/api/package.json'))('pg');
const configured = new URL(process.env.LONGBALL_POSTGRES_TEST_URL ?? 'postgresql://127.0.0.1:55432/longball_runtime_test');
assert(['127.0.0.1','localhost','[::1]'].includes(configured.hostname) && configured.pathname==='/longball_runtime_test' && !configured.password,'Use only the disposable loopback test selector.');
const container=process.env.LONGBALL_RUNTIME_POSTGRES_CONTAINER ?? 'longball-postgres-runtime';assert(/^[a-zA-Z0-9_-]+$/.test(container));
const suffix=randomUUID().replaceAll('-',''),sourceName=`lb_rls_source_${suffix}`,restoredName=`lb_rls_restore_${suffix}`;
const roles={owner:`lb_restore_owner_${suffix}`,apiRole:`lb_restore_api_${suffix}`,workerRole:`lb_restore_worker_${suffix}`};
const directory=resolve(`.local/runtime/rls-restores/${Date.now()}`);await mkdir(directory,{recursive:true,mode:0o700});
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function docker(args:string[],input?:Buffer):Promise<Buffer>{return new Promise((yes,no)=>{const child=spawn('env',['-u','DOCKER_HOST','-u','DOCKER_CONTEXT','-u','DOCKER_TLS','-u','DOCKER_TLS_VERIFY','-u','DOCKER_CERT_PATH','docker','--host=unix:///var/run/docker.sock',...args],{stdio:['pipe','pipe','pipe']});const chunks:Buffer[]=[];let length=0,error='';child.stdout.on('data',chunk=>{length+=chunk.length;if(length>64*1024*1024)child.kill('SIGKILL');else chunks.push(chunk);});child.stderr.on('data',chunk=>{if(error.length<8192)error+=chunk.toString();});child.on('error',no);child.on('close',code=>code===0?yes(Buffer.concat(chunks)):no(new Error(`Restore tool failed (${code}): ${error.slice(0,300)}`)));child.stdin.on('error',()=>{});child.stdin.end(input);});}
const adminUrl=new URL(configured);adminUrl.pathname='/postgres';const admin=new Pool({connectionString:adminUrl.href});
const stores:PostgresStore[]=[];const created:string[]=[];let rolesCreated=false;
const url=(database:string,role:string)=>{const value=new URL(configured);value.pathname=`/${database}`;value.username=role;value.password='';return value.href;};
async function empty(database:string){await admin.query(`CREATE DATABASE "${database}"`);created.push(database);await admin.query(`REVOKE ALL ON DATABASE "${database}" FROM PUBLIC`);await admin.query(`GRANT CONNECT ON DATABASE "${database}" TO "${roles.owner}","${roles.apiRole}","${roles.workerRole}"`);await admin.query(`GRANT CREATE ON DATABASE "${database}" TO "${roles.owner}"`);}
async function restore(database:string,archive:Buffer){await empty(database);try{await docker(['exec','-i',container,'pg_restore','-U','postgres','-d',database,`--role=${roles.owner}`,'--no-owner','--no-privileges','--exit-on-error'],archive);}finally{await admin.query(`REVOKE CREATE ON DATABASE "${database}" FROM "${roles.owner}"`);}}
try{
 let checkpoint:string|undefined;let historical:{observedAt?:string;checks?:{name:string;detail:Record<string,unknown>}[]}|undefined;
 for(const id of(await readdir('.local/runtime/proofs')).sort().reverse()){try{const report=JSON.parse(await readFile(resolve('.local/runtime/proofs',id,'report.json'),'utf8'));if(report.status==='passed'&&/^\d+$/.test(id)){checkpoint=id;historical=report;break;}}catch{}}
 assert(checkpoint,'Run the actual media proof once before this affected-security restore.');
 for(const role of Object.values(roles))await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`);rolesCreated=true;
 const historicalDump=await docker(['exec',container,'pg_dump','-U','postgres','-d',`longball_media_${checkpoint}`,'--format=custom','--no-owner','--no-privileges']);
 await restore(sourceName,historicalDump);
 const owner=await PostgresStore.open(url(sourceName,roles.owner));stores.push(owner);
 const sourceMedia=resolve(directory,'source-media');await cp(resolve('.local/runtime/proofs',checkpoint,'media'),sourceMedia,{recursive:true});
 await PgMediaService.open({directory:sourceMedia,database:owner.db});await new PostgresActivationService({store:owner}).initialize();await applyRuntimeGrants(owner.db,roles);
 const sourceVersions=(await owner.many('SELECT version FROM schema_migrations ORDER BY version')).map(row=>row.version);assert.deepEqual(sourceVersions,[2,3,4,5,6,7,8,9,10,11,12]);
 const archive=await docker(['exec',container,'pg_dump','-U','postgres','-d',sourceName,'--format=custom','--no-owner','--no-privileges']);await writeFile(resolve(directory,'schema12.dump'),archive,{mode:0o600});
 const objectArchive=resolve(directory,'objects');await cp(sourceMedia,objectArchive,{recursive:true});
 await restore(restoredName,archive);
 const restoredOwner=await PostgresStore.open(url(restoredName,roles.owner));stores.push(restoredOwner);await applyRuntimeGrants(restoredOwner.db,roles);
 const restoredMedia=resolve(directory,'restored-media');await cp(objectArchive,restoredMedia,{recursive:true});
 const api=await PostgresStore.open(url(restoredName,roles.apiRole),Date.now,{migrationMode:'verify'});stores.push(api);await api.assertRuntimeRole('api');
 const worker=await PostgresStore.open(url(restoredName,roles.workerRole),Date.now,{migrationMode:'verify'});stores.push(worker);await worker.assertRuntimeRole('worker');
 const service=await PgMediaService.open({directory:restoredMedia,database:api.db});await new PostgresActivationService({store:api}).initialize();
 const context={kind:'actor' as const,accountId:'synthetic-account-player-02',issuer:'urn:longball:synthetic',subject:'synthetic-account-player-02',strongAuth:false,authenticatedAtMs:Date.now(),requestedRole:'player' as const,clubId:'synthetic-richmond-rovers',teamId:SYNTHETIC_IDS.teamId,seasonId:SYNTHETIC_IDS.seasonId,operation:'media.gateway',nowMs:Date.now()};
 const restoredHash=await api.db.withContext(context,async()=>{const state=await api.document<CommunityState>(context.teamId,context.seasonId,'community');const photo=state.photos.find(item=>item.id.startsWith('upload-')&&item.publishedRevision!==null)??state.photos.find(item=>item.publishedRevision!==null&&item.id!=='synthetic-published-pitch');assert(photo,'Retained published processed photo required.');const image=await service.gateway(state,{accountId:context.accountId,role:'player',playerId:'synthetic-player-02',teamId:context.teamId,seasonId:context.seasonId},photo.id,'display');return hash(image.body);});
 const expected=historical?.checks?.find(check=>check.name==='actual-pg-dump-restore-with-paired-private-objects')?.detail.exactPublishedDerivativeSha256;assert.equal(restoredHash,expected);
 assert.equal((await api.db.query('SELECT * FROM documents')).rowCount,0);assert.equal((await api.db.query('SELECT * FROM media_uploads')).rowCount,0);
 await api.db.withContext({...context,clubId:'synthetic-other-club',teamId:'synthetic-other-team'},async()=>{assert.equal((await api.db.query('SELECT * FROM documents')).rowCount,0);assert.equal((await api.db.query('SELECT * FROM media_uploads')).rowCount,0);});
 await worker.db.withContext(context,async()=>{assert.equal((await worker.db.query('SELECT * FROM documents')).rowCount,0);assert.equal((await worker.db.query('SELECT * FROM accounts')).rowCount,0);});
 const security=await restoredOwner.one("SELECT count(*)::integer AS protected_tables FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='longball' AND c.relrowsecurity");
 const constraints=await restoredOwner.one("SELECT count(*)::integer AS composite_foreign_keys FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='longball' AND c.contype='f' AND array_length(c.conkey,1)>1");
 assert(Number(security?.protected_tables)>=34);assert(Number(constraints?.composite_foreign_keys)>=18);
 const preservedCounts=await restoredOwner.one('SELECT (SELECT count(*)::integer FROM media_uploads) AS manifests,(SELECT count(*)::integer FROM clubs) AS clubs,(SELECT count(*)::integer FROM team_seasons) AS seasons,(SELECT count(*)::integer FROM game_contexts) AS game_contexts');assert.equal(preservedCounts?.manifests,3);
 const result={status:'passed',observedAt:new Date().toISOString(),syntheticOnly:true,versions:sourceVersions,featureVersions:{media:3,activation:2},historicalMediaCheckpoint:historical?.observedAt,archiveSha256:hash(archive),exactRestoredDerivativeSha256:restoredHash,protectedTables:security?.protected_tables,compositeForeignKeys:constraints?.composite_foreign_keys,preservedCounts,temporaryDatabaseCreateRevoked:true,restoredSchemaOwnerNonBypass:true,restoredApiWorkerNonBypass:true,restoredCurrentPlayerGateway:true,contextFreeDataDenied:true,foreignTeamDenied:true,workerForgedActorDenied:true,limitations:['Reuses previously processed fictional image bytes; ClamAV engine was not rerun.','Paired private object copy and custom-format archive; no encrypted offsite backup, retention, RPO or RTO claim.','Disposable proof database roles use loopback-only trust authentication; production credentials remain separate mounted secrets.']};
 await writeFile(resolve(directory,'report.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});await writeFile('.local/runtime/latest-rls-restore.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result));
}finally{for(const store of stores.reverse())await store.close();for(const database of created.reverse())await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);if(rolesCreated)for(const role of Object.values(roles))await admin.query(`DROP ROLE "${role}"`);await admin.end();}
