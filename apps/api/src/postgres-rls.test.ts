import { createHash,randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { afterAll,afterEach,beforeAll,describe,expect,it } from 'vitest';
import { PostgresStore } from './postgres-store';
import { PgMediaService } from './postgres-media';
import { PostgresActivationService } from './postgres-activation';
import { createPostgresApi } from './postgres-server';
import { applyRuntimeGrants } from './runtime-grants';
import { EVENT_CONTRACT_VERSION,SYNTHETIC_IDS } from './store';
import type { PreparationState } from '../../../packages/application/src/preparation';
import type { RecordsState } from '../../../packages/application/src/records';
import type { CommunityState } from '../../../packages/application/src/community';
import { romaFixture } from '../../../packages/testing/src/index';
import { runDuePostgresJobs } from '../../worker/src/postgres-jobs';
import type { MediaScanner } from './media';
import { parseAccountDevicesDto } from '../../../packages/application/src/account-devices';

const configuredUrl=process.env.LONGBALL_POSTGRES_TEST_URL;
const teamUrl=`/v1/teams/${SYNTHETIC_IDS.teamId}`;
const matchUrl=`/v1/matches/${SYNTHETIC_IDS.matchId}`;
const season=`?seasonId=${SYNTHETIC_IDS.seasonId}`;
let admin:Pool;
interface Fixture{database:string;directory:string;roles:{apiRole:string;workerRole:string};owner?:PostgresStore;media?:PgMediaService;api?:Awaited<ReturnType<typeof createPostgresApi>>;worker?:PostgresStore}
const fixtures:Fixture[]=[];
describe.skipIf(!configuredUrl)('SEC10 actual non-bypass PostgreSQL HTTP and repository scopes',()=>{
  beforeAll(()=>{admin=new Pool({connectionString:configuredUrl,max:2});});
  afterEach(async()=>{for(const fixture of fixtures.splice(0)){if(fixture.api){fixture.api.server.closeAllConnections();await fixture.api.close();}await fixture.worker?.close();await fixture.media?.close();await fixture.owner?.close();await admin.query(`DROP DATABASE "${fixture.database}" WITH (FORCE)`);for(const role of Object.values(fixture.roles))await admin.query(`DROP ROLE "${role}"`);rmSync(fixture.directory,{recursive:true,force:true});}});
  afterAll(async()=>{await admin.end();});
  async function start(mediaScanner?:MediaScanner){
    const suffix=randomUUID().replaceAll('-',''),database=`lb_scope_${suffix}`,directory=mkdtempSync(join(tmpdir(),'longball-rls-http-'));
    const roles={apiRole:`lb_scope_api_${suffix}`,workerRole:`lb_scope_worker_${suffix}`};
    await admin.query(`CREATE DATABASE "${database}"`);const fixture:Fixture={database,directory,roles};fixtures.push(fixture);
    for(const name of Object.values(roles))await admin.query(`CREATE ROLE "${name}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    const ownerUrl=new URL(configuredUrl!);ownerUrl.pathname=`/${database}`;
    const owner=await PostgresStore.open(ownerUrl.href);fixture.owner=owner;await owner.seedSynthetic();
    const media=await PgMediaService.open({directory:join(directory,'media'),database:owner.db});fixture.media=media;await new PostgresActivationService({store:owner}).initialize();
    const preparation=await owner.document<PreparationState>(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'preparation');
    const otherPreparation={...preparation,club:{...preparation.club,id:'synthetic-other-club',name:'Other Club Private'},team:{...preparation.team,id:'synthetic-other-team',name:'Other Club Private'},profiles:[],fixtures:[],training:[]};
    const records=await owner.document<RecordsState>(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'records');
    const otherRecords:RecordsState={...records,clubId:'synthetic-other-club',teamId:'synthetic-other-team',players:[],liveMatch:{...records.liveMatch,matchId:'synthetic-other-match',opponent:'Other Club Private'},results:records.results.map((record,index)=>({...record,id:`other-private-record-${index}`,teamId:'synthetic-other-team',opponent:'Other Club Private',goals:[]}))};
    const community=await owner.document<CommunityState>(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community');
    const otherCommunity:CommunityState={...community,seasons:community.seasons.map(item=>({...item,teamId:'synthetic-other-team',teamLabel:'Other Club Private'})),matches:[],photos:[],ballots:[],awards:[],grants:[],invitations:[]};
    await owner.transaction(async()=>{await owner.saveDocument('synthetic-other-team',SYNTHETIC_IDS.seasonId,'preparation',otherPreparation);await owner.saveDocument('synthetic-other-team',SYNTHETIC_IDS.seasonId,'records',otherRecords);await owner.saveDocument('synthetic-other-team',SYNTHETIC_IDS.seasonId,'community',otherCommunity);await owner.insertMatch({matchId:'synthetic-other-match',players:romaFixture.players.map(player=>({...player,id:`other-${player.id}`})),selectedPlayerIds:romaFixture.players.filter(player=>player.available).map(player=>`other-${player.id}`),pitchPlaces:7,plannedHalfDurationMs:1_500_000,fixedKeeperId:null},'synthetic-other-team',SYNTHETIC_IDS.seasonId);});
    await applyRuntimeGrants(owner.db,roles);
    const apiUrl=new URL(ownerUrl);apiUrl.username=roles.apiRole;apiUrl.password='';
    const api=await createPostgresApi({connectionString:apiUrl.href,databasePath:join(directory,'unused.sqlite'),mediaDirectory:join(directory,'media'),migrationMode:'verify',syntheticAuth:true,seedSynthetic:false,mediaScanner});fixture.api=api;
    await new Promise<void>(resolve=>api.server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
    const call=async(path:string,input:{token?:string;role?:string;body?:unknown;key?:string;controller?:string}={})=>{
      const headers:Record<string,string>={Authorization:`Bearer ${input.token??'synthetic-manager-1'}`};
      if(input.role)headers['X-Longball-Role']=input.role;
      if(input.controller)headers['X-Controller-Token']=input.controller;
      if(input.body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=input.key??randomUUID();headers['X-Api-Contract-Version']=EVENT_CONTRACT_VERSION;}
      const response=await fetch(`${base}${path}`,{method:input.body===undefined?'GET':'POST',headers,body:input.body===undefined?undefined:JSON.stringify(input.body)});
      return{status:response.status,body:await response.json() as Record<string,unknown>};
    };
    return{owner,api,call,fixture,ownerUrl,base};
  }
  it('processes and publishes supplied logos through restricted HTTP roles and enforces live pointers, ancestry and private history',async()=>{
    const {owner,api,base}=await start({scan:async()=>({verdict:'clean',engine:'explicit-http-test-double'})});
    const png=await sharp({create:{width:12,height:10,channels:4,background:{r:14,g:150,b:84,alpha:0.5}}}).png().toBuffer();
    const path=(suffix='')=>`${teamUrl}/branding${suffix}${season}`;
    const request=async(route:string,{role='manager',token='synthetic-manager-1',body,raw,cap,key=randomUUID()}: {role?:string;token?:string;body?:unknown;raw?:Buffer;cap?:string;key?:string}={})=>{
      const headers:Record<string,string>={Authorization:`Bearer ${token}`,'X-Longball-Role':role};if(body!==undefined||raw){headers['Content-Type']=raw?'image/png':'application/json';headers['Idempotency-Key']=key;headers['X-Api-Contract-Version']=EVENT_CONTRACT_VERSION;}if(cap)headers['X-Media-Upload-Token']=cap;
      return fetch(base+route,{method:raw?'PUT':body===undefined?'GET':'POST',headers,body:raw?new Uint8Array(raw):body===undefined?undefined:JSON.stringify(body)});
    };
    const json=async(route:string,input:Parameters<typeof request>[1]={})=>{const response=await request(route,input);return{status:response.status,body:await response.json() as Record<string,unknown>};};
    const metadata={byteSize:png.length,mimeType:'image/png',sha256:createHash('sha256').update(png).digest('hex'),policyAcknowledged:true};
    expect((await json(path('/team_logo/uploads/prepare'),{role:'administrator',token:'synthetic-admin',body:{kind:'team_logo',teamId:SYNTHETIC_IDS.teamId,...metadata}})).status).toBe(404);
    expect((await json(path('/club_logo/uploads/prepare'),{body:{kind:'club_logo',clubId:'synthetic-richmond-rovers',...metadata}})).status).toBe(404);
    const prepareKey=randomUUID(),teamInput={kind:'team_logo',teamId:SYNTHETIC_IDS.teamId,...metadata};
    const simultaneous=await Promise.all([json(path('/team_logo/uploads/prepare'),{key:prepareKey,body:teamInput}),json(path('/team_logo/uploads/prepare'),{key:prepareKey,body:teamInput})]);expect(simultaneous.map(result=>result.status)).toEqual([200,200]);expect(simultaneous[0].body.uploadId).toBe(simultaneous[1].body.uploadId);expect(await owner.one('SELECT COUNT(*)::integer AS count FROM brand_assets WHERE request_id=$1',[prepareKey])).toEqual({count:1});
    const prepared=await json(path('/club_logo/uploads/prepare'),{role:'administrator',token:'synthetic-admin',body:{kind:'club_logo',clubId:'synthetic-richmond-rovers',...metadata}});expect(prepared.status,JSON.stringify(prepared.body)).toBe(200);
    const upload=String(prepared.body.uploadId),cap=String(prepared.body.uploadToken),asset=prepared.body.asset as {assetId:string;revision:number};
    expect((await json(path(`/uploads/${upload}`),{role:'administrator',token:'synthetic-admin',raw:png,cap})).status).toBe(200);
    const completed=await json(path(`/uploads/${upload}/complete`),{role:'administrator',token:'synthetic-admin',body:{},cap});expect(completed.status,JSON.stringify(completed.body)).toBe(200);
    const imagePath=path(`/assets/${asset.assetId}/revisions/1/display`);expect((await request(imagePath,{role:'player',token:'synthetic-account-player-01'})).status).toBe(404);
    const command={id:randomUUID(),type:'logo.published',kind:'club_logo',assetId:asset.assetId,reviewedRevision:1,expectedSlotVersion:0,confirmRightsToUse:true,policyVersion:'logo-rights-v1'};
    const publication=await json(path('/club_logo/publish'),{role:'administrator',token:'synthetic-admin',key:command.id,body:{command}});expect(publication.status,JSON.stringify(publication.body)).toBe(200);expect(publication.body.revision).toBe(1);
    const child=await json(path(),{role:'player',token:'synthetic-account-player-01'});expect(child.status,JSON.stringify(child.body)).toBe(200);expect(child.body.assets).toEqual([]);expect(child.body.effective).toEqual({source:'club',logo:prepared.body.asset});
    const image=await request(imagePath,{role:'player',token:'synthetic-account-player-01'});expect(image.status).toBe(200);expect(image.headers.get('content-type')).toBe('image/png');expect((await sharp(Buffer.from(await image.arrayBuffer())).metadata()).hasAlpha).toBe(true);
    expect(await owner.one('SELECT kind,club_id,team_id,season_id,match_id,status FROM brand_assets WHERE id=$1',[upload])).toEqual({kind:'club_logo',club_id:'synthetic-richmond-rovers',team_id:null,season_id:null,match_id:null,status:'linked'});
    expect(await api.store.many('SELECT * FROM brand_assets')).toEqual([]);
    await owner.execute('UPDATE memberships SET revoked_at=$1 WHERE account_id=$2 AND team_id=$3',[Date.now(),'synthetic-account-player-01',SYNTHETIC_IDS.teamId]);expect((await request(imagePath,{role:'player',token:'synthetic-account-player-01'})).status).toBe(404);
  });
  it('enrols an own native installation without membership using database timestamps and grants no recorder authority',async()=>{
    const {owner,api,call}=await start();await owner.execute('DELETE FROM memberships WHERE account_id=$1',['synthetic-account-invitee']);
    const enrolled=await call('/v1/identity/devices',{token:'synthetic-account-invitee',body:{deviceId:'native-membership-free',platform:'android'}});expect(enrolled.status,JSON.stringify(enrolled.body)).toBe(200);
    const dto=parseAccountDevicesDto(enrolled.body);expect(dto.devices).toHaveLength(1);expect(dto.devices[0]).toMatchObject({source:'native_app_enrolment',platform:'android',platformVerified:false});expect(dto.devices[0].registeredAt).not.toBeNull();expect(dto.devices[0].lastSeenAt).not.toBeNull();
    expect((await call('/v1/identity/devices',{token:'synthetic-account-player-01'})).body.devices).toEqual([]);
    expect((await call('/v1/identity/devices',{token:'synthetic-account-player-01',body:{deviceId:'native-membership-free',platform:'ios'}})).status).toBe(409);
    expect(await api.store.many('SELECT * FROM native_app_devices')).toEqual([]);expect(await owner.many('SELECT * FROM memberships WHERE account_id=$1',['synthetic-account-invitee'])).toEqual([]);expect(await owner.many('SELECT * FROM controller_grants')).toEqual([]);
  });
  it('filters real HTTP reads and exports across two clubs while preserving scoped manager, own-player and administrator journeys',async()=>{
    const {api,call}=await start();expect(await api.store.one('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).toEqual({rolsuper:false,rolbypassrls:false});
    expect((await call(`${teamUrl}/preparation${season}`,{role:'manager'})).status).toBe(200);
    const own=await call(`${teamUrl}/preparation/own${season}`,{token:'synthetic-account-player-01',role:'player'});expect(own.status).toBe(200);expect(JSON.stringify(own.body)).not.toContain('synthetic-player-02');
    const configuration=await call(`${teamUrl}/configuration${season}`,{token:'synthetic-admin',role:'administrator'});expect(configuration.status).toBe(200);expect(configuration.body).not.toHaveProperty('profiles');
    expect((await call(`${teamUrl}/managers${season}`,{token:'synthetic-admin',role:'administrator'})).status).toBe(200);
    expect((await call(`${teamUrl}/records${season}`,{token:'synthetic-admin',role:'administrator'})).status).toBe(404);
    for(const leaf of ['preparation','records','records/export']){
      const suffix=leaf==='records/export'?`${season}&kind=season&format=json`:season;
      const denied=await call(`/v1/teams/synthetic-other-team/${leaf}${suffix}`),missing=await call(`/v1/teams/does-not-exist/${leaf}${suffix}`);expect(denied.status).toBe(404);expect(missing.status).toBe(404);expect(denied.body.message).toBe(missing.body.message);
    }
    expect((await call(`/v1/matches/synthetic-other-match`)).status).toBe(404);
    const exported=await call(`${teamUrl}/records/export${season}&kind=season&format=json`,{role:'manager'});expect(exported.status).toBe(200);expect(JSON.stringify(exported.body)).not.toContain('Other Club Private');
    expect((await call(`${matchUrl}/download?deviceId=selected-player`,{role:'player'})).status).toBe(404);
    expect(await api.store.many('SELECT * FROM documents')).toEqual([]);
  });
  it('constrains direct SQL and child ancestry to the selected scope and clears context after exceptions and requests',async()=>{
    const {api,owner,call}=await start();
    await owner.execute("INSERT INTO memberships(account_id,team_id,season_id,role) VALUES($1,$2,$3,'manager')",['synthetic-account-manager','synthetic-other-team',SYNTHETIC_IDS.seasonId]);
    const identity={issuer:'urn:longball:synthetic',subject:'synthetic-account-manager',strongAuth:true,authenticatedAt:Date.now()};
    const principal=await api.store.withIdentityContext(identity,()=>api.store.principal(identity));
    const scope={operation:'records.read',requestedRole:'manager' as const,teamId:SYNTHETIC_IDS.teamId,seasonId:SYNTHETIC_IDS.seasonId};
    await expect(api.store.withActorContext(principal,scope,async()=>{const rows=await api.store.many('SELECT team_id FROM documents');expect(rows.length).toBeGreaterThan(0);expect(rows.every(row=>row.team_id===SYNTHETIC_IDS.teamId)).toBe(true);expect(await api.store.many('SELECT * FROM documents WHERE team_id=$1',['synthetic-other-team'])).toEqual([]);throw new Error('rollback-context');})).rejects.toThrow('rollback-context');
    expect(await api.store.many('SELECT * FROM documents')).toEqual([]);
    expect((await call('/v1/teams/synthetic-other-team/records'+season,{role:'manager'})).status).toBe(200);
    const acquired=await call(`${matchUrl}/controller`,{role:'manager',body:{deviceId:'rls-phone'}});expect(acquired.status).toBe(200);
    await expect(api.store.withActorContext(principal,{...scope,operation:'match.manage',matchId:SYNTHETIC_IDS.matchId},()=>api.store.execute('INSERT INTO events(event_id,match_id,device_id,client_sequence,envelope_json,signature,disposition,received_at,club_id,team_id,season_id) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10)',[randomUUID(),SYNTHETIC_IDS.matchId,'rls-phone','{}','fixture','quarantined',Date.now(),'synthetic-other-club','synthetic-other-team',SYNTHETIC_IDS.seasonId]))).rejects.toHaveProperty('code','42501');
    expect(await owner.one('SELECT COUNT(*)::integer AS count FROM events')).toEqual({count:0});
    await expect(api.store.assertRuntimeRole('api')).resolves.toBeUndefined();await expect(owner.assertRuntimeRole('api')).rejects.toThrow('non-owner');
    expect(await api.store.many('SELECT * FROM accounts')).toEqual([]);
  });
  it('freezes an actually held controller when the selected administrator revokes a manager, without exposing private match state',async()=>{
    const {owner,call}=await start();
    expect((await call(`${matchUrl}/controller`,{token:'synthetic-manager-4',role:'manager',body:{deviceId:'departing-manager-phone'}})).status).toBe(200);
    const staff=await call(`${teamUrl}/managers${season}`,{token:'synthetic-admin',role:'administrator'});expect(staff.status).toBe(200);expect(staff.body.revision).toBe(0);
    const revokeId=randomUUID(),revoke={command:{id:revokeId,type:'manager.revoked',expectedRevision:0,accountId:'synthetic-account-manager-4',reason:'Explicit fictional departure from this season',confirmRevocation:true}};
    const revoked=await call(`${teamUrl}/managers/revoke${season}`,{token:'synthetic-admin',role:'administrator',key:revokeId,body:revoke});expect(revoked.status).toBe(200);expect(revoked.body).toMatchObject({revision:1,controllerFrozen:true});
    expect(await owner.one('SELECT frozen FROM controller_grants WHERE match_id=$1',[SYNTHETIC_IDS.matchId])).toEqual({frozen:1});
    expect(await call(`${teamUrl}/managers/revoke${season}`,{token:'synthetic-admin',role:'administrator',key:revokeId,body:revoke})).toEqual(revoked);
    expect((await call(matchUrl,{token:'synthetic-manager-4',role:'manager'})).status).toBe(404);
    expect((await call(matchUrl,{token:'synthetic-admin',role:'administrator'})).status).toBe(404);
    const assignId=randomUUID();const assigned=await call(`${teamUrl}/managers${season}`,{token:'synthetic-admin',role:'administrator',key:assignId,body:{command:{id:assignId,type:'manager.assigned',expectedRevision:1,accountId:'synthetic-account-manager-5'}}});expect(assigned.status).toBe(200);expect(assigned.body.revision).toBe(2);
    expect((await call(`${teamUrl}/community${season}`,{token:'synthetic-manager-5',role:'manager'})).status).toBe(200);
    const current=await call(`${teamUrl}/managers${season}`,{token:'synthetic-admin',role:'administrator'});expect(current.body.activeTeamManagerCount).toBe(4);
  });
  it('keeps valid community-only game media scoped and finalizes only the claimed award with restricted worker authority',async()=>{
    const {owner,api,call,fixture,ownerUrl}=await start();
    const prepared=await call(`${teamUrl}/media/uploads/prepare${season}`,{role:'manager',body:{matchId:'synthetic-community-willow',byteSize:100,mimeType:'image/png',sha256:'a'.repeat(64),caption:'Fictional scope fixture',policyAcknowledged:true}});expect(prepared.status).toBe(200);
    const community=await owner.document<CommunityState>(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community');const cutoff=Date.now()-1;
    community.matches[0]={...community.matches[0],actualFullTimeAtMs:cutoff-3_600_000+15_000,finalisationDeadlineAtMs:cutoff+15_000,voteCutoffAtMs:cutoff,cutoffSource:'explicit_fictional_setting'};community.matches.push({...community.matches[0],id:'unclaimed-second-game'});
    await owner.saveDocument(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community',community);
    await owner.execute("INSERT INTO jobs(id,business_key,kind,payload_json,due_at) VALUES($1,$2,'award.finalise',$3,$4)",[randomUUID(),randomUUID(),JSON.stringify({teamId:SYNTHETIC_IDS.teamId,seasonId:SYNTHETIC_IDS.seasonId,matchId:community.matches[0].id}),cutoff]);
    const workerUrl=new URL(ownerUrl);workerUrl.username=fixture.roles.workerRole;workerUrl.password='';const worker=await PostgresStore.open(workerUrl.href,()=>Date.now()+25_000,{migrationMode:'verify'});fixture.worker=worker;await worker.assertRuntimeRole('worker');await expect(worker.assertRuntimeRole('api')).rejects.toThrow('api runtime purpose');await expect(api.store.assertRuntimeRole('worker')).rejects.toThrow('worker runtime purpose');
    let workerFailure:unknown,failedStatement='';const execute=worker.execute.bind(worker);worker.execute=async(sql,values)=>{try{return await execute(sql,values);}catch(error){workerFailure=error;failedStatement=sql.split(/\s+/).slice(0,3).join(' ');throw error;}};
    const one=worker.one.bind(worker);worker.one=async(sql,values)=>{try{return await one(sql,values);}catch(error){workerFailure=error;failedStatement=sql.split(/\s+/).slice(0,3).join(' ');throw error;}};
    const before=Date.now();await owner.execute('UPDATE memberships SET expires_at=$1 WHERE account_id=$2 AND team_id=$3 AND season_id=$4',[before+20_000,'synthetic-account-player-01',SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId]);expect(await runDuePostgresJobs(worker,before+25_000),workerFailure instanceof Error?`${failedStatement}: ${workerFailure.message}`:undefined).toEqual({completed:1,retried:0,failed:0});const after=Date.now();const next=await owner.document<CommunityState>(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community');expect(next.awards.map(award=>award.matchId)).toEqual([community.matches[0].id]);expect(next.awards[0].finalisedAtMs).toBeGreaterThanOrEqual(before);expect(next.awards[0].finalisedAtMs).toBeLessThanOrEqual(after);expect(next.awards[0].deadlineMissed).toBe(next.awards[0].finalisedAtMs>community.matches[0].finalisationDeadlineAtMs!);expect(await owner.one("SELECT COUNT(*)::integer AS count FROM jobs WHERE kind='notification.dispatch' AND payload_json->>'accountId'=$1",['synthetic-account-player-01'])).toEqual({count:1});
    expect(await worker.many('SELECT * FROM documents')).toEqual([]);await expect(api.store.db.withContext({kind:'worker_claim',jobKind:'award.finalise',nowMs:Date.now()},()=>api.store.one('SELECT * FROM longball.claim_due_job($1,$2,$3)',['award.finalise',Date.now(),'a'.repeat(64)]))).rejects.toHaveProperty('code','42501');
  });
  it('rolls back the sealed award and notification fanout when the final lease completion affects no row',async()=>{
    const {owner,fixture,ownerUrl}=await start();
    const community=await owner.document<CommunityState>(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community'),cutoff=Date.now()-1;
    community.matches[0]={...community.matches[0],voteCutoffAtMs:cutoff,cutoffSource:'explicit_fictional_setting'};
    await owner.saveDocument(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community',community);
    const jobId=randomUUID();await owner.execute("INSERT INTO jobs(id,business_key,kind,payload_json,due_at) VALUES($1,$1,'award.finalise',$2,$3)",[jobId,JSON.stringify({teamId:SYNTHETIC_IDS.teamId,seasonId:SYNTHETIC_IDS.seasonId,matchId:community.matches[0].id}),cutoff]);
    const url=new URL(ownerUrl);url.username=fixture.roles.workerRole;url.password='';const worker=await PostgresStore.open(url.href,Date.now,{migrationMode:'verify'});fixture.worker=worker;await worker.assertRuntimeRole('worker');
    const execute=worker.execute.bind(worker);worker.execute=async(sql,values)=>sql.startsWith("UPDATE jobs SET state='completed'")?{changes:0}:execute(sql,values);
    expect(await runDuePostgresJobs(worker,Date.now(),1)).toEqual({completed:0,retried:1,failed:0});
    expect(await owner.document<CommunityState>(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community')).toEqual(community);
    expect(await owner.one("SELECT COUNT(*)::integer AS count FROM jobs WHERE kind='notification.dispatch'")).toEqual({count:0});
    expect(await owner.one('SELECT state,attempts FROM jobs WHERE id=$1',[jobId])).toEqual({state:'pending',attempts:1});
  });
});
