/** Actual fictional logo bytes, maintained scanner and restricted PostgreSQL proof. */
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PgDatabase,type PgApplicationContext } from '../apps/api/src/pg';
import { PostgresStore,SYNTHETIC_IDS } from '../apps/api/src/postgres-store';
import { PgMediaService } from '../apps/api/src/postgres-media';
import { PostgresActivationService } from '../apps/api/src/postgres-activation';
import { PostgresBrandRepository } from '../apps/api/src/postgres-brand-repository';
import { createBrandMedia } from '../apps/api/src/server';
import { createClamAvDaemonScanner } from '../apps/api/src/media';
import { applyRuntimeGrants } from '../apps/api/src/runtime-grants';
const requireApi=createRequire(resolve('apps/api/package.json')),sharp=requireApi('sharp'),{Pool}=requireApi('pg');
const source=new URL(process.env.LONGBALL_POSTGRES_TEST_URL??'postgresql://127.0.0.1:55432/longball_runtime_test');
assert(['127.0.0.1','localhost','[::1]'].includes(source.hostname)&&source.pathname==='/longball_runtime_test'&&!source.password,'Use only the disposable loopback selector.');
const suffix=randomUUID().replaceAll('-',''),database=`lb_brand_proof_${suffix}`,roles={owner:`lb_brand_owner_${suffix}`,apiRole:`lb_brand_api_${suffix}`,workerRole:`lb_brand_worker_${suffix}`};
const directory=resolve(`.local/runtime/brand-proofs/${Date.now()}`);await mkdir(directory,{recursive:true,mode:0o700});
const admin=new Pool({connectionString:source.href}),pools:PgDatabase[]=[];let created=false;
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const scanner=createClamAvDaemonScanner({host:process.env.LONGBALL_CLAMD_HOST??'127.0.0.1',port:Number(process.env.LONGBALL_CLAMD_PORT??53310)});
const checks:{name:string;detail:Record<string,unknown>}[]=[];
async function* chunks(bytes:Buffer){for(let offset=0;offset<bytes.length;offset+=257)yield bytes.subarray(offset,offset+257);}
try{
 for(const role of Object.values(roles))await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`);
 await admin.query(`CREATE DATABASE "${database}"`);created=true;const base=new URL(source);base.pathname=`/${database}`;
 const bootstrap=new Pool({connectionString:base.href});try{await bootstrap.query(`CREATE SCHEMA longball AUTHORIZATION "${roles.owner}"`);await bootstrap.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');}finally{await bootstrap.end();}
 const connect=(role:string,mode:'apply'|'verify')=>{const url=new URL(base);url.username=role;url.password='';const db=new PgDatabase(url.href,{migrationMode:mode,maximumConnections:2});pools.push(db);return db;};
 const owner=connect(roles.owner,'apply');await owner.migrate();const fixture=new PostgresStore(owner);await fixture.seedSynthetic();await PgMediaService.open({directory,database:owner});await new PostgresActivationService({store:fixture}).initialize();await applyRuntimeGrants(owner,roles);
 const api=connect(roles.apiRole,'verify');await api.migrate();const store=new PostgresStore(api);await store.assertRuntimeRole('api');
 const service=createBrandMedia({databasePath:resolve(directory,'unused.sqlite'),mediaDirectory:directory,mediaScanner:scanner},store,new PostgresBrandRepository(api));
 const context=(accountId:string,requestedRole:'administrator'|'manager'|'player',operation:string):Extract<PgApplicationContext,{kind:'actor'}>=>({kind:'actor',accountId,issuer:'urn:longball:synthetic',subject:accountId,strongAuth:requestedRole!=='player',authenticatedAtMs:Date.now(),nowMs:Date.now(),requestedRole,operation,clubId:'synthetic-richmond-rovers',teamId:SYNTHETIC_IDS.teamId,seasonId:SYNTHETIC_IDS.seasonId});
 const session=async(accountId:string,role:'administrator'|'manager'|'player')=>({principal:await api.withContext({kind:'identity',issuer:'urn:longball:synthetic',subject:accountId,nowMs:Date.now()},()=>store.principal({issuer:'urn:longball:synthetic',subject:accountId,strongAuth:role!=='player',authenticatedAt:Date.now()})),teamId:SYNTHETIC_IDS.teamId,seasonId:SYNTHETIC_IDS.seasonId,role});
 const manager=await session('synthetic-account-manager','manager'),administrator=await session('synthetic-account-admin','administrator'),player=await session('synthetic-account-player-01','player');
 const run=<T>(who:typeof manager,operation:string,work:()=>Promise<T>)=>api.withContext(context(who.principal.accountId,who.role,operation),work);
 const original:Buffer=await sharp({create:{width:64,height:32,channels:4,background:{r:106,g:25,b:43,alpha:0.4}}}).withMetadata({orientation:6}).withExif({IFD0:{Artist:'FICTIONAL_LOGO_METADATA_TO_STRIP'}}).png().toBuffer();
 const eicar=Buffer.from('WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=','base64');
 const clean=await scanner.scan(original,{mimeType:'image/png',sha256:hash(original)}),rejected=await scanner.scan(eicar,{mimeType:'application/octet-stream',sha256:hash(eicar)});assert.equal(clean.verdict,'clean');assert.equal(rejected.verdict,'rejected');
 checks.push({name:'actual-maintained-clamav-clean-and-eicar',detail:{engine:clean.engine,clean:clean.verdict,standardHarmlessAntivirusPattern:rejected.verdict}});
 const prepare=async(who:typeof manager,kind:'club_logo'|'team_logo',bytes=original)=>run(who,'branding.prepare',()=>service.prepare(who,randomUUID(),{kind,...(kind==='club_logo'?{clubId:'synthetic-richmond-rovers'}:{teamId:SYNTHETIC_IDS.teamId}),byteSize:bytes.length,mimeType:'image/png',sha256:hash(bytes),policyAcknowledged:true}));
 const publish=async(who:typeof manager,kind:'club_logo'|'team_logo')=>{
  const prepared=await prepare(who,kind);await run(who,'branding.upload',()=>service.upload(who,prepared.uploadId,prepared.uploadToken,chunks(original)));await run(who,'branding.complete',()=>service.complete(who,prepared.uploadId,prepared.uploadToken));
  await assert.rejects(run(player,'branding.gateway',()=>service.gateway(player,prepared.asset.assetId,1,'display')));
  const own=await run(who,'branding.gateway',()=>service.gateway(who,prepared.asset.assetId,1,'display','own'));const metadata=await sharp(own.body).metadata();assert.equal(metadata.format,'png');assert.equal(metadata.hasAlpha,true);assert.equal(metadata.width,32);assert.equal(metadata.height,64);for(const field of ['exif','icc','xmp','orientation'])assert.equal(metadata[field],undefined);
  const receipt=await run(who,'branding.publish',()=>service.command(who,{id:randomUUID(),type:'logo.published',kind,expectedSlotVersion:0,assetId:prepared.asset.assetId,reviewedRevision:1,confirmRightsToUse:true,policyVersion:'logo-rights-v1'}));assert.equal(receipt.revision,1);
  const image=await run(player,'branding.gateway',()=>service.gateway(player,prepared.asset.assetId,1,'display'));assert.equal(hash(image.body),hash(own.body));
  return{prepared,derivativeSha256:hash(image.body),dimensions:[metadata.width,metadata.height]};
 };
 const club=await publish(administrator,'club_logo'),team=await publish(manager,'team_logo');const current=await run(player,'branding.read',()=>service.get(player));assert.equal(current.effective.source,'team');
 await assert.rejects(run(manager,'branding.publish',()=>service.command(manager,{id:randomUUID(),type:'logo.removed',kind:'team_logo',expectedSlotVersion:0})),error=>(error as {code?:string}).code==='STALE_REVISION');
 await run(manager,'branding.remove',()=>service.command(manager,{id:randomUUID(),type:'logo.removed',kind:'team_logo',expectedSlotVersion:1}));assert.equal((await run(player,'branding.read',()=>service.get(player))).effective.source,'club');await assert.rejects(run(player,'branding.gateway',()=>service.gateway(player,team.prepared.asset.assetId,1,'display')));
 await run(administrator,'branding.remove',()=>service.command(administrator,{id:randomUUID(),type:'logo.removed',kind:'club_logo',expectedSlotVersion:1}));assert.equal((await run(player,'branding.read',()=>service.get(player))).effective.source,'neutral');
 checks.push({name:'actual-restricted-pg-scanned-transparent-logo-journey',detail:{clubDerivativeSha256:club.derivativeSha256,teamDerivativeSha256:team.derivativeSha256,dimensions:team.dimensions,metadataStripped:true,alphaPreserved:true,pendingPrivate:true,explicitReviewedPublication:true,staleVersionDenied:true,teamClubNeutralInheritance:true,removedRevisionPrivate:true}});
 const unavailable=createBrandMedia({databasePath:resolve(directory,'unused.sqlite'),mediaDirectory:directory,mediaScanner:createClamAvDaemonScanner({host:'127.0.0.1',port:1,timeoutMs:100})},store,new PostgresBrandRepository(api));
 const retained=await prepare(manager,'team_logo');await run(manager,'branding.upload',()=>unavailable.upload(manager,retained.uploadId,retained.uploadToken,chunks(original)));await assert.rejects(run(manager,'branding.complete',()=>unavailable.complete(manager,retained.uploadId,retained.uploadToken)),error=>(error as {code?:string}).code==='SCANNER_UNAVAILABLE');assert.equal((await owner.query('SELECT status,display_key FROM brand_assets WHERE id=$1',[retained.uploadId])).rows[0].status,'uploaded');
 checks.push({name:'actual-scanner-unavailable-fail-closed',detail:{originalRetainedPrivate:true,noProcessedPointer:true}});
 const result={status:'passed',observedAt:new Date().toISOString(),syntheticOnly:true,versions:(await owner.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row=>row.version),checks,limitations:['Harmless generated fictional PNGs and standard EICAR scanner probe only; no real child images.','Actual PostgreSQL uses isolated non-owner API role and disposable loopback trust authentication.','No HEIC claim; current pipeline supports JPEG/PNG pending additive codec work.','Scanner verdict/version is an observation, not an operating signature-update SLA.','Physical iPhone/Android picker behavior and hosted/private-volume recovery remain separate checks.']};
 await writeFile(resolve(directory,'report.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});await writeFile('.local/runtime/latest-brand-proof.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});process.stdout.write(JSON.stringify(result)+'\n');
}finally{for(const pool of pools.reverse())await pool.close();if(created)await admin.query(`DROP DATABASE "${database}" WITH(FORCE)`);for(const role of Object.values(roles))await admin.query(`DROP ROLE "${role}"`);await admin.end();}
