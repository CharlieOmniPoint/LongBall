import { createHash,randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { afterEach,describe,expect,it } from 'vitest';
import { createApi } from './server';
import { EVENT_CONTRACT_VERSION,SYNTHETIC_IDS } from './store';
import type { MediaScanner } from './media';
import type { BrandingDto,BrandReference } from '../../../packages/application/src/branding';
import { parseAccountDevicesDto } from '../../../packages/application/src/account-devices';

const running:ReturnType<typeof createApi>[]=[],directories:string[]=[];
afterEach(async()=>{for(const api of running.splice(0)){api.server.closeAllConnections();await api.close();}for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
const root=`/v1/teams/${SYNTHETIC_IDS.teamId}/branding?seasonId=${SYNTHETIC_IDS.seasonId}`;
const path=(suffix:string)=>`/v1/teams/${SYNTHETIC_IDS.teamId}/branding${suffix}?seasonId=${SYNTHETIC_IDS.seasonId}`;
const scanner:MediaScanner={scan:async()=>({verdict:'clean',engine:'explicit-unit-test-double'})};
async function start(scan:MediaScanner|null=scanner){
  const directory=mkdtempSync(join(tmpdir(),'longball-brand-'));directories.push(directory);let now=Date.now();
  const api=createApi({databasePath:join(directory,'api.sqlite'),syntheticAuth:true,mediaScanner:scan??undefined,now:()=>now});running.push(api);await new Promise<void>(resolve=>api.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const request=(route:string,input:{role?:string;token?:string;body?:unknown;raw?:Buffer;method?:string;cap?:string;key?:string}={})=>{
    const headers:Record<string,string>={Authorization:`Bearer ${input.token??'synthetic-manager-1'}`};if(input.role)headers['X-Longball-Role']=input.role;
    if(input.body!==undefined||input.raw){headers['Content-Type']=input.raw?'image/png':'application/json';headers['Idempotency-Key']=input.key??randomUUID();headers['X-Api-Contract-Version']=EVENT_CONTRACT_VERSION;}
    if(input.cap)headers['X-Media-Upload-Token']=input.cap;
    return fetch(base+route,{method:input.method??(input.raw?'PUT':input.body===undefined?'GET':'POST'),headers,body:input.raw?new Uint8Array(input.raw):(input.body===undefined?undefined:JSON.stringify(input.body))});
  };
  const json=async(route:string,input:Parameters<typeof request>[1]={})=>{const response=await request(route,input);return{status:response.status,body:await response.json() as Record<string,unknown>};};
  const png=await sharp({create:{width:12,height:10,channels:4,background:{r:17,g:144,b:83,alpha:0.5}}}).png().withMetadata({exif:{IFD0:{Artist:'Private upload metadata'}}}).toBuffer();
  const stage=async(kind:'club_logo'|'team_logo',role=kind==='club_logo'?'administrator':'manager')=>{
    const prepared=await json(path(`/${kind}/uploads/prepare`),{role,body:{kind,...(kind==='club_logo'?{clubId:'synthetic-richmond-rovers'}:{teamId:SYNTHETIC_IDS.teamId}),byteSize:png.length,mimeType:'image/png',sha256:createHash('sha256').update(png).digest('hex'),policyAcknowledged:true}});expect(prepared.status).toBe(200);
    const uploadId=prepared.body.uploadId as string,cap=prepared.body.uploadToken as string,asset=prepared.body.asset as BrandReference;
    expect((await json(path(`/uploads/${uploadId}`),{role,raw:png,cap})).status).toBe(200);
    const complete=await json(path(`/uploads/${uploadId}/complete`),{role,body:{},cap});return{prepared,complete,uploadId,cap,asset};
  };
  const publish=async(asset:BrandReference,version:number,role=asset.kind==='club_logo'?'administrator':'manager',key=randomUUID())=>json(path(`/${asset.kind}/publish`),{role,key,body:{command:{id:key,type:'logo.published',kind:asset.kind,assetId:asset.assetId,reviewedRevision:asset.revision,expectedSlotVersion:version,confirmRightsToUse:true,policyVersion:'logo-rights-v1'}}});
  return{api,json,request,stage,publish,png,tick:()=>{now+=1000;}};
}
describe('F01 supplied private logos and live inheritance',()=>{
  it('processes transparent PNGs, publishes exact reviewed revisions, preserves a team override and restores live club inheritance',async()=>{
    const client=await start();const initial=await client.json(root,{role:'manager'});expect((initial.body as unknown as BrandingDto).effective.source).toBe('neutral');
    const club=await client.stage('club_logo');expect(club.complete.status).toBe(200);
    const own=await client.request(path(`/assets/${club.asset.assetId}/revisions/1/display`)+'&mode=own',{role:'administrator'});expect(own.status).toBe(200);expect(own.headers.get('content-type')).toBe('image/png');
    const metadata=await sharp(Buffer.from(await own.arrayBuffer())).metadata();expect(metadata.hasAlpha).toBe(true);expect(metadata.exif).toBeUndefined();
    expect((await client.request(path(`/assets/${club.asset.assetId}/revisions/1/display`),{role:'player',token:'synthetic-account-player-01'})).status).toBe(404);
    const first=await client.publish(club.asset,0);expect(first.status).toBe(200);expect(first.body.revision).toBe(1);
    expect((await client.json(root,{role:'player',token:'synthetic-account-player-01'})).body.effective).toEqual({source:'club',logo:club.asset});
    const team=await client.stage('team_logo');expect(team.complete.status).toBe(200);expect((await client.publish(team.asset,0)).status).toBe(200);
    const nextClub=await client.stage('club_logo');expect((await client.publish(nextClub.asset,1)).status).toBe(200);
    expect((await client.json(root,{role:'player',token:'synthetic-account-player-01'})).body.effective).toEqual({source:'team',logo:team.asset});
    const key=randomUUID();const removed=await client.json(path('/team_logo/remove'),{role:'manager',key,body:{command:{id:key,type:'logo.removed',kind:'team_logo',expectedSlotVersion:1}}});expect(removed.status).toBe(200);expect((removed.body.branding as BrandingDto).effective).toEqual({source:'club',logo:nextClub.asset});
    expect((await client.request(path(`/assets/${team.asset.assetId}/revisions/1/display`),{role:'player',token:'synthetic-account-player-01'})).status).toBe(404);
    expect((await client.request(path(`/assets/${nextClub.asset.assetId}/revisions/1/display`),{role:'player',token:'synthetic-account-player-01'})).status).toBe(200);
    expect(client.api.store.database.prepare("SELECT COUNT(*) AS count FROM brand_assets WHERE status='linked'").get()).toEqual({count:3});
  });
  it('denies wrong roles and ancestry, stale publication, wrong revisions and reported processing evidence while preserving exact retries',async()=>{
    const client=await start();
    const invalid={kind:'team_logo',teamId:SYNTHETIC_IDS.teamId,byteSize:client.png.length,mimeType:'image/png',sha256:createHash('sha256').update(client.png).digest('hex'),policyAcknowledged:true};
    expect((await client.json(path('/team_logo/uploads/prepare'),{role:'administrator',token:'synthetic-admin',body:invalid})).status).toBe(404);
    expect((await client.json(path('/club_logo/uploads/prepare'),{role:'manager',body:{...invalid,kind:'club_logo',clubId:'synthetic-richmond-rovers'}})).status).toBe(422);
    const {teamId:_team,...clubInput}=invalid;
    expect((await client.json(path('/club_logo/uploads/prepare'),{role:'manager',body:{...clubInput,kind:'club_logo',clubId:'synthetic-richmond-rovers'}})).status).toBe(404);
    expect((await client.json(path('/team_logo/uploads/prepare'),{role:'manager',body:{...invalid,teamId:'synthetic-other-team'}})).status).toBe(404);
    const staged=await client.stage('team_logo');const key=randomUUID();const published=await client.publish(staged.asset,0,'manager',key);expect(published.status).toBe(200);expect(await client.publish(staged.asset,0,'manager',key)).toEqual(published);
    expect((await client.publish(staged.asset,0)).status).toBe(409);
    expect((await client.publish({...staged.asset,revision:2},1)).status).toBe(404);
    expect((await client.json(path(`/uploads/${staged.uploadId}/complete`),{role:'manager',cap:staged.cap,body:{scannerClean:true}})).status).toBe(400);
    const child=await client.json(root,{role:'player',token:'synthetic-account-player-01'});expect(child.body.assets).toEqual([]);expect(JSON.stringify(child.body)).not.toContain(staged.cap);
  });
  it('fails closed without a scanner and leaves the original private and the published slot unchanged',async()=>{
    const client=await start(null);const staged=await client.stage('team_logo');
    expect(staged.complete.status).toBe(503);expect(staged.complete.body.code).toBe('SCANNER_REQUIRED');expect((await client.json(root,{role:'manager'})).body.effective).toEqual({source:'neutral',logo:null});
    expect(client.api.store.database.prepare('SELECT status,display_key FROM brand_assets WHERE id=?').get(staged.uploadId)).toEqual({status:'uploaded',display_key:null});
  });
});
describe('UI33 own native installation inventory',()=>{
  it('records reported platform and observed times for an account without membership, retains recorder unknowns and cannot adopt another account device',async()=>{
    const client=await start();client.api.store.database.prepare('DELETE FROM memberships WHERE account_id=?').run('synthetic-account-invitee');
    const first=await client.json('/v1/identity/devices',{token:'synthetic-account-invitee',body:{deviceId:'native-isolated-account',platform:'ios'}});expect(first.status).toBe(200);const dto=parseAccountDevicesDto(first.body);expect(dto.devices).toHaveLength(1);expect(dto.devices[0]).toMatchObject({source:'native_app_enrolment',platform:'ios',platformVerified:false});
    client.tick();const second=await client.json('/v1/identity/devices',{token:'synthetic-account-invitee',body:{deviceId:'native-isolated-account',platform:'ios'}});const updated=parseAccountDevicesDto(second.body);expect(updated.devices[0].registeredAt).toBe(dto.devices[0].registeredAt);expect(updated.devices[0].lastSeenAt!>dto.devices[0].lastSeenAt!).toBe(true);
    expect((await client.json('/v1/identity/devices',{token:'synthetic-account-player-01'})).body.devices).toEqual([]);
    expect((await client.json('/v1/identity/devices',{token:'synthetic-account-player-01',body:{deviceId:'native-isolated-account',platform:'android'}})).status).toBe(409);
    expect((await client.json('/v1/identity/devices',{token:'synthetic-account-invitee',body:{deviceId:'native-other',platform:'ios',accountId:'synthetic-account-manager'}})).status).toBe(400);
    client.api.store.database.prepare('INSERT INTO devices(id,account_id) VALUES(?,?)').run('legacy-recorder','synthetic-account-invitee');
    client.api.store.database.prepare('INSERT INTO devices(id,account_id) VALUES(?,?)').run('native-isolated-account','synthetic-account-invitee');
    const history=parseAccountDevicesDto((await client.json('/v1/identity/devices',{token:'synthetic-account-invitee'})).body);expect(history.devices).toHaveLength(2);expect(history.devices.find(device=>device.deviceId==='legacy-recorder')).toMatchObject({source:'match_controller_enrolment',platform:null,registeredAt:null,lastSeenAt:null});expect(history.devices.find(device=>device.deviceId==='native-isolated-account')?.source).toBe('native_app_enrolment');
    expect(client.api.store.database.prepare('SELECT * FROM memberships WHERE account_id=?').all('synthetic-account-invitee')).toEqual([]);expect(client.api.store.database.prepare('SELECT * FROM controller_grants').all()).toEqual([]);
  });
});
