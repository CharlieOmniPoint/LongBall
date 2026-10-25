/** Actual fictional logo bytes, maintained scanner and restricted PostgreSQL proof. */
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp,mkdir,readFile,writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { PgDatabase,type PgApplicationContext } from '../apps/api/src/pg';
import { PostgresStore,SYNTHETIC_IDS } from '../apps/api/src/postgres-store';
import { PgMediaService } from '../apps/api/src/postgres-media';
import { PostgresActivationService } from '../apps/api/src/postgres-activation';
import { PostgresBrandRepository } from '../apps/api/src/postgres-brand-repository';
import { createBrandMedia } from '../apps/api/src/server';
import { createClamAvDaemonScanner } from '../apps/api/src/media';
import { applyRuntimeGrants } from '../apps/api/src/runtime-grants';
import { prepareRuntimeContributions,verifyRuntimeContributions,verifyRuntimeProofSchema } from './runtime-contribution-boundaries';
import { applyCommunityCommand,syntheticCommunityActors,type CommunityState } from '../packages/application/src/community';
const requireApi=createRequire(resolve('apps/api/package.json')),sharp=requireApi('sharp'),{Pool}=requireApi('pg');
const source=new URL(process.env.LONGBALL_POSTGRES_TEST_URL??'postgresql://127.0.0.1:55432/longball_runtime_test');
assert(['127.0.0.1','localhost','[::1]'].includes(source.hostname)&&source.pathname==='/longball_runtime_test'&&!source.password,'Use only the disposable loopback selector.');
const suffix=randomUUID().replaceAll('-',''),database=`lb_brand_proof_${suffix}`,roles={owner:`lb_brand_owner_${suffix}`,apiRole:`lb_brand_api_${suffix}`,workerRole:`lb_brand_worker_${suffix}`};
const directory=resolve(`.local/runtime/heic-proofs/${Date.now()}`);await mkdir(directory,{recursive:true,mode:0o700});
assert(process.env.LONGBALL_HEIC_DECODER_FILE,'Use the actual source-built native helper.');
const container=process.env.LONGBALL_RUNTIME_POSTGRES_CONTAINER??'longball-postgres-runtime';assert(/^[a-zA-Z0-9_-]+$/.test(container));
const restoredName=`${database}_restored`;let restoredCreated=false;
async function docker(args:string[],input?:Buffer):Promise<Buffer>{return new Promise((yes,no)=>{const child=spawn('env',['-u','DOCKER_HOST','-u','DOCKER_CONTEXT','-u','DOCKER_TLS','-u','DOCKER_TLS_VERIFY','-u','DOCKER_CERT_PATH','docker','--host=unix:///var/run/docker.sock',...args],{stdio:['pipe','pipe','pipe']});const output:Buffer[]=[];let length=0,error='';child.stdout.on('data',chunk=>{length+=chunk.length;if(length>64*1024*1024)child.kill('SIGKILL');else output.push(chunk);});child.stderr.on('data',chunk=>{if(error.length<8192)error+=chunk.toString();});child.on('error',no);child.on('close',code=>code===0?yes(Buffer.concat(output)):no(new Error(`Runtime proof tool failed (${code}): ${error.slice(0,300)}`)));child.stdin.on('error',()=>{});child.stdin.end(input);});}
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
 const owner=connect(roles.owner,'apply');await owner.migrate();const fixture=new PostgresStore(owner);await fixture.seedSynthetic();
 // An explicit disposable fictional sharing fixture, never a production policy decision.
 const reviewFixture=await fixture.document<CommunityState>(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community');assert.equal(reviewFixture.synthetic,true);reviewFixture.matches=reviewFixture.matches.map(match=>({...match,sharing:'fictional_review_only'}));await fixture.saveDocument(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community',reviewFixture);
 await PgMediaService.open({directory,database:owner});await new PostgresActivationService({store:fixture}).initialize();await applyRuntimeGrants(owner,roles);
 const api=connect(roles.apiRole,'verify');await api.migrate();const store=new PostgresStore(api);await store.assertRuntimeRole('api');
 const service=createBrandMedia({databasePath:resolve(directory,'unused.sqlite'),mediaDirectory:directory,mediaScanner:scanner},store,new PostgresBrandRepository(api));
 const context=(accountId:string,requestedRole:'administrator'|'manager'|'player',operation:string):Extract<PgApplicationContext,{kind:'actor'}>=>({kind:'actor',accountId,issuer:'urn:longball:synthetic',subject:accountId,strongAuth:requestedRole!=='player',authenticatedAtMs:Date.now(),nowMs:Date.now(),requestedRole,operation,clubId:'synthetic-richmond-rovers',teamId:SYNTHETIC_IDS.teamId,seasonId:SYNTHETIC_IDS.seasonId});
 const session=async(accountId:string,role:'administrator'|'manager'|'player')=>({principal:await api.withContext({kind:'identity',issuer:'urn:longball:synthetic',subject:accountId,nowMs:Date.now()},()=>store.principal({issuer:'urn:longball:synthetic',subject:accountId,strongAuth:role!=='player',authenticatedAt:Date.now()})),teamId:SYNTHETIC_IDS.teamId,seasonId:SYNTHETIC_IDS.seasonId,role});
 const manager=await session('synthetic-account-manager','manager'),administrator=await session('synthetic-account-admin','administrator'),player=await session('synthetic-account-player-01','player');
 const run=<T>(who:typeof manager,operation:string,work:()=>Promise<T>)=>api.withContext(context(who.principal.accountId,who.role,operation),work);
 const original=await readFile('fixtures/media/fictional.heic');
 const eicar=Buffer.from('WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=','base64');
 const clean=await scanner.scan(original,{mimeType:'image/heic',sha256:hash(original)}),rejected=await scanner.scan(eicar,{mimeType:'application/octet-stream',sha256:hash(eicar)});assert.equal(clean.verdict,'clean');assert.equal(rejected.verdict,'rejected');
 checks.push({name:'actual-maintained-clamav-clean-and-eicar',detail:{engine:clean.engine,clean:clean.verdict,standardHarmlessAntivirusPattern:rejected.verdict}});
 const prepare=async(who:typeof manager,kind:'club_logo'|'team_logo',bytes=original)=>run(who,'branding.prepare',()=>service.prepare(who,randomUUID(),{kind,...(kind==='club_logo'?{clubId:'synthetic-richmond-rovers'}:{teamId:SYNTHETIC_IDS.teamId}),byteSize:bytes.length,mimeType:'image/heic',sha256:hash(bytes),policyAcknowledged:true}));
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
 checks.push({name:'actual-restricted-pg-scanned-heic-logo-journey',detail:{originalSha256:hash(original),clubDerivativeSha256:club.derivativeSha256,teamDerivativeSha256:team.derivativeSha256,dimensions:team.dimensions,metadataStripped:true,pendingPrivate:true,explicitReviewedPublication:true,staleVersionDenied:true,teamClubNeutralInheritance:true,removedRevisionPrivate:true}});
 // Republish one exact processed logo so the paired checkpoint contains a live pointer.
 await run(manager,'branding.publish',()=>service.command(manager,{id:randomUUID(),type:'logo.published',kind:'team_logo',expectedSlotVersion:2,assetId:team.prepared.asset.assetId,reviewedRevision:1,confirmRightsToUse:true,policyVersion:'logo-rights-v1'}));
 const media=await PgMediaService.open({directory,database:api,scanner});
 let state=await run(manager,'community.read',()=>store.document<CommunityState>(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community'));
 const actors=syntheticCommunityActors(state),sharedMatch=state.matches.find(match=>match.sharing==='fictional_review_only');assert(sharedMatch,'Use an explicitly shared fictional game.');
 const photoInput=(bytes:Buffer)=>({requestId:randomUUID(),matchId:sharedMatch.id,byteSize:bytes.length,mimeType:'image/heic',sha256:hash(bytes),caption:'Fictional generated HEIC; no people',policyAcknowledged:true as const});
 const photo=await run(manager,'media.prepare',()=>media.prepare(state,actors.manager,photoInput(original)));
 await run(manager,'media.upload',()=>media.upload(state,actors.manager,photo.uploadId,photo.uploadToken,chunks(original)));
 const completed=await run(manager,'media.complete',()=>media.complete(state,actors.manager,photo.uploadId,photo.uploadToken));
 await run(manager,'media.complete',()=>store.transaction(async()=>{state=applyCommunityCommand(state,actors.manager,completed.command,Date.now());await store.saveDocument(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community',state);await media.link(photo.uploadId,state);}));
 await assert.rejects(run(player,'media.gateway',()=>media.gateway(state,actors.player,photo.photoId,'display')));
 await run(manager,'community.write',async()=>{state=applyCommunityCommand(state,actors.manager,{id:randomUUID(),type:'photo.published',photoId:photo.photoId,sourceRevision:1,policyAcknowledged:true},Date.now());await store.saveDocument(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community',state);});
 const photoImage=await run(player,'media.gateway',()=>media.gateway(state,actors.player,photo.photoId,'display'));const photoMetadata=await sharp(photoImage.body).metadata();assert.equal(photoMetadata.format,'jpeg');assert.equal(photoMetadata.width,32);assert.equal(photoMetadata.height,64);for(const key of ['exif','icc','xmp','orientation'])assert.equal(photoMetadata[key],undefined);
 for(const name of ['multiple','hidden-oversize']){const bytes=await readFile(`fixtures/media/${name}.heic`),bad=await run(manager,'media.prepare',()=>media.prepare(state,actors.manager,photoInput(bytes)));await run(manager,'media.upload',()=>media.upload(state,actors.manager,bad.uploadId,bad.uploadToken,chunks(bytes)));await assert.rejects(run(manager,'media.complete',()=>media.complete(state,actors.manager,bad.uploadId,bad.uploadToken)));const row=(await owner.query('SELECT status,display_key FROM media_uploads WHERE id=$1',[bad.uploadId])).rows[0];assert.equal(row.status,'rejected');assert.equal(row.display_key,null);}
 checks.push({name:'actual-original-heic-scan-photo-decode-and-reject-controls',detail:{jpegSha256:hash(photoImage.body),dimensions:[photoMetadata.width,photoMetadata.height],orientationAppliedOnce:true,exifGpsStripped:true,multiplePrimaryRejected:true,oversizeHiddenThumbnailRejected:true,noRejectedDerivative:true}});
 const unavailable=createBrandMedia({databasePath:resolve(directory,'unused.sqlite'),mediaDirectory:directory,mediaScanner:createClamAvDaemonScanner({host:'127.0.0.1',port:1,timeoutMs:100})},store,new PostgresBrandRepository(api));
 const retained=await prepare(manager,'team_logo');await run(manager,'branding.upload',()=>unavailable.upload(manager,retained.uploadId,retained.uploadToken,chunks(original)));await assert.rejects(run(manager,'branding.complete',()=>unavailable.complete(manager,retained.uploadId,retained.uploadToken)),error=>(error as {code?:string}).code==='SCANNER_UNAVAILABLE');assert.equal((await owner.query('SELECT status,display_key FROM brand_assets WHERE id=$1',[retained.uploadId])).rows[0].status,'uploaded');
 checks.push({name:'actual-scanner-unavailable-fail-closed',detail:{originalRetainedPrivate:true,noProcessedPointer:true}});
 const installed=await verifyRuntimeProofSchema(owner);
 const sourceWorkerDatabase=connect(roles.workerRole,'verify');await sourceWorkerDatabase.migrate();const sourceWorker=new PostgresStore(sourceWorkerDatabase);await sourceWorker.assertRuntimeRole('worker');
 const contributions=await prepareRuntimeContributions(fixture,store,sourceWorker);
 const archive=await docker(['exec',container,'pg_dump','-U','postgres','-d',database,'--format=custom','--no-owner','--no-privileges']);await writeFile(resolve(directory,'schema16.dump'),archive,{mode:0o600});const objects=resolve(directory,'paired-objects');for(const name of ['quarantine','derivatives','branding'])await cp(resolve(directory,name),resolve(objects,name),{recursive:true});
 await admin.query(`CREATE DATABASE "${restoredName}"`);restoredCreated=true;const restoredBase=new URL(base);restoredBase.pathname=`/${restoredName}`;const bootstrapRestore=new Pool({connectionString:restoredBase.href});try{await bootstrapRestore.query(`GRANT CREATE ON DATABASE "${restoredName}" TO "${roles.owner}"`);}finally{await bootstrapRestore.end();}
 await docker(['exec','-i',container,'pg_restore','-U','postgres','-d',restoredName,`--role=${roles.owner}`,'--no-owner','--no-privileges','--exit-on-error'],archive);
 await admin.query(`REVOKE CREATE ON DATABASE "${restoredName}" FROM "${roles.owner}"`);
 const restoredUrl=new URL(restoredBase);restoredUrl.username=roles.owner;const restoredOwner=new PgDatabase(restoredUrl.href,{migrationMode:'verify'});pools.push(restoredOwner);await restoredOwner.migrate();await applyRuntimeGrants(restoredOwner,roles);
 restoredUrl.username=roles.apiRole;const restoredApi=new PgDatabase(restoredUrl.href,{migrationMode:'verify'});pools.push(restoredApi);await restoredApi.migrate();const restoredStore=new PostgresStore(restoredApi);await restoredStore.assertRuntimeRole('api');
 restoredUrl.username=roles.workerRole;const restoredWorker=new PgDatabase(restoredUrl.href,{migrationMode:'verify'});pools.push(restoredWorker);await restoredWorker.migrate();const restoredWorkerStore=new PostgresStore(restoredWorker);await restoredWorkerStore.assertRuntimeRole('worker');
 assert.deepEqual(await verifyRuntimeProofSchema(restoredOwner),installed);
 const restoredMedia=await PgMediaService.open({directory:objects,database:restoredApi}),restoredBrand=createBrandMedia({databasePath:resolve(objects,'unused.sqlite'),mediaDirectory:objects},restoredStore,new PostgresBrandRepository(restoredApi));
 await restoredApi.withContext(context(player.principal.accountId,'player','media.gateway'),async()=>{const restoredState=await restoredStore.document<CommunityState>(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community');assert.equal(hash((await restoredMedia.gateway(restoredState,actors.player,photo.photoId,'display')).body),hash(photoImage.body));});
 await restoredApi.withContext(context(player.principal.accountId,'player','branding.gateway'),async()=>{assert.equal(hash((await restoredBrand.gateway(player,team.prepared.asset.assetId,1,'display')).body),team.derivativeSha256);});
 for(const db of [restoredApi,restoredWorker])assert.equal((await db.query('SELECT * FROM documents')).rowCount,0);
 await restoredApi.withContext({...context(player.principal.accountId,'player','media.gateway'),teamId:'synthetic-other-team',clubId:'synthetic-other-club'},async()=>{for(const table of ['media_uploads','brand_assets','brand_slots'])assert.equal((await restoredApi.query(`SELECT * FROM ${table}`)).rowCount,0);});
 await restoredWorker.withContext(context(manager.principal.accountId,'manager','community.read'),async()=>{for(const table of ['documents','accounts'])assert.equal((await restoredWorker.query(`SELECT * FROM ${table}`)).rowCount,0);});
 const security=installed.protectedTables;
 const contributionChecks=await verifyRuntimeContributions(new PostgresStore(restoredOwner),restoredStore,restoredWorkerStore,contributions);
 checks.push({name:'actual-schema16-encrypted-push-and-audited-privilege-restore',detail:contributionChecks});
 checks.push({name:'actual-schema16-paired-archive-object-restore',detail:{archiveSha256:hash(archive),exactPhotoDerivativeSha256:hash(photoImage.body),exactCurrentLogoDerivativeSha256:team.derivativeSha256,protectedTables:security,apiWorkerNonOwnerNonBypass:true,verifyOnlyStartup:true,currentReviewedPointerPreserved:true,contextFreeAndForeignTeamDenied:true,workerForgedActorDenied:true,temporaryCreateGrantRevoked:true}});
 const result={status:'passed',observedAt:new Date().toISOString(),syntheticOnly:true,execution:'host-bundled-operational-proof',productionImageExercised:false,actualPushDelivered:false,...installed,checks,limitations:['Generated flat-color fictional HEIC fixtures with deliberate fictional EXIF/GPS, and standard harmless EICAR scanner probe; no people.','Actual PostgreSQL uses isolated non-owner API/worker roles and disposable loopback trust authentication.','Scanner verdict/version is an observation, not an operating signature-update SLA.','Paired private object copy and database archive; no offsite encryption, retention, RPO or RTO claim.','Physical iPhone/Android picker behavior remains separate native device testing.']};
 await writeFile(resolve(directory,'report.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});await writeFile('.local/runtime/latest-heic-proof.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});process.stdout.write(JSON.stringify(result)+'\n');
}finally{for(const pool of pools.reverse())await pool.close();if(restoredCreated)await admin.query(`DROP DATABASE "${restoredName}" WITH(FORCE)`);if(created)await admin.query(`DROP DATABASE "${database}" WITH(FORCE)`);for(const role of Object.values(roles))await admin.query(`DROP ROLE "${role}"`);await admin.end();}
