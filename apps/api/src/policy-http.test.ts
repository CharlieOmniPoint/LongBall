import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION, type ClockSample } from '../../../packages/domain/src/index';
import { makePolicyChangeCommand } from '../../../packages/application/src/match-policy';
import { applyUploadReceipt, attachGrant, createConnectedDocument, LongBallServiceClient, mergeDownload, prepareServiceRequest, queueConnectedCommand, type ControllerGrant, type DurableRequest, type UploadReceipt } from '../../../packages/application/src/sync';
import { createApi } from './server';
import { EVENT_CONTRACT_VERSION, SYNTHETIC_IDS } from './store';

describe('EV05 canonical controller policy HTTP integration',()=>{
  it('accepts prospective soft settings once, retains exact uncertain retry, and carries them through two handovers without resetting the device stream',async()=>{
    const api=createApi({databasePath:':memory:',syntheticAuth:true,now:()=>1_800_000_000_000});
    await new Promise<void>(resolve=>api.server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${(api.server.address() as AddressInfo).port}`, matchId=SYNTHETIC_IDS.matchId;
    const clock:ClockSample={monotonicMs:0,sessionId:'policy-http-continuous',wallTimeMs:1_800_000_000_000};
    const calls:{body?:string;key?:string}[]=[];let dropNext=false;
    const client=(token:string)=>new LongBallServiceClient(base,async(url,options)=>{
      calls.push({body:options.body,key:options.headers['Idempotency-Key']});
      const response=await fetch(url,{...options,headers:{...options.headers,Authorization:`Bearer ${token}`,'X-Longball-Role':'manager'}});
      if(dropNext){dropNext=false;await response.text();throw new Error('Deliberately dropped accepted policy receipt.');}
      return response;
    });
    const a=client('synthetic-manager-2'),b=client('synthetic-manager-3');
    const request=(kind:DurableRequest['kind'],body:unknown,path:string):DurableRequest=>({kind,body,path,idempotencyKey:randomUUID()});
    const claim=async(service:LongBallServiceClient,deviceId:string)=>service.execute<ControllerGrant>(request('acquire',{deviceId},`/v1/matches/${matchId}/controller`),null);
    const handover=async(from:LongBallServiceClient,grant:ControllerGrant,to:LongBallServiceClient,toAccountId:string,toDeviceId:string)=>{
      const checkpoint=await from.download(matchId,grant.deviceId);
      const offered=await from.execute<{transferId:string}>(request('handover',{toAccountId,toDeviceId,baseRevision:checkpoint.acceptedRevision},`/v1/matches/${matchId}/handover`),grant);
      return to.execute<ControllerGrant>(request('accept',{deviceId:toDeviceId},`/v1/matches/${matchId}/handover/${offered.transferId}/accept`),null);
    };
    try{
      const grantA=await claim(a,'policy-phone-a');
      let documentA=mergeDownload(attachGrant(createConnectedDocument('policy-phone-a',matchId,base),grantA),await a.download(matchId,'policy-phone-a'));
      const command=makePolicyChangeCommand(documentA.localState!,clock,{batchPreference:2,leadThreshold:4,returnToNormal:true},'Manager confirmed future soft preferences on phone A.');
      documentA=queueConnectedCommand(documentA,command,clock,randomUUID());
      documentA=prepareServiceRequest(documentA,'upload',randomUUID());
      const original=JSON.stringify(documentA.pendingRequest), wire=JSON.stringify(documentA.outbox[0].envelope);
      dropNext=true;
      await expect(a.execute(documentA.pendingRequest!,grantA)).rejects.toThrow('dropped accepted');
      expect(JSON.stringify(documentA.pendingRequest)).toBe(original);expect(JSON.stringify(documentA.outbox[0].envelope)).toBe(wire);
      const receipt=await a.execute<UploadReceipt>(documentA.pendingRequest!,grantA);
      expect(receipt.results[0]).toMatchObject({disposition:'accepted',revision:1});
      const sent=calls.filter(call=>call.key===documentA.pendingRequest!.idempotencyKey);
      expect(sent).toHaveLength(2);expect(sent[0]).toEqual(sent[1]);
      const acceptedA=await a.download(matchId,'policy-phone-a');
      documentA=mergeDownload(applyUploadReceipt(documentA,receipt,new Date(clock.wallTimeMs).toISOString()),acceptedA);
      expect(acceptedA.state.activePolicy).toMatchObject({policyVersion:1,actorId:'synthetic-account-manager-2',payload:{batchLimit:2,scoreLeadThreshold:4},applicability:{minimumStint:'soft_preference',batchLimit:'soft_preference',q07:'unapproved'}});
      expect(acceptedA.state.policyHistory).toHaveLength(1);
      expect(api.store.database.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({n:1});
      const grantB=await handover(a,grantA,b,'synthetic-account-manager-3','policy-phone-b');
      let documentB=mergeDownload(attachGrant(createConnectedDocument('policy-phone-b',matchId,base),grantB),await b.download(matchId,'policy-phone-b'));
      expect(documentB.localState!.activePolicy).toEqual(acceptedA.state.activePolicy);
      documentB=queueConnectedCommand(documentB,makePolicyChangeCommand(documentB.localState!,clock,{batchPreference:3,leadThreshold:5,returnToNormal:false},'Manager reviewed future settings after explicit handover.'),clock,randomUUID());
      documentB=prepareServiceRequest(documentB,'upload',randomUUID());
      const acceptedB=await b.execute<UploadReceipt>(documentB.pendingRequest!,grantB);expect(acceptedB.results[0].disposition).toBe('accepted');
      documentB=mergeDownload(applyUploadReceipt(documentB,acceptedB,new Date(clock.wallTimeMs).toISOString()),await b.download(matchId,'policy-phone-b'));
      const restoredGrant=await handover(b,grantB,a,'synthetic-account-manager-2','policy-phone-a');
      const checkpoint=await a.download(matchId,'policy-phone-a');
      expect(checkpoint.state.policyHistory).toHaveLength(2);expect(checkpoint.state.activePolicy?.payload.batchLimit).toBe(3);
      // A clean acknowledged download retains A's original sequence across both controller epochs.
      documentA=mergeDownload(attachGrant(documentA,restoredGrant),checkpoint);
      expect(checkpoint.deviceCheckpoint.clientSequence).toBe(1);
      documentA=queueConnectedCommand(documentA,makePolicyChangeCommand(documentA.localState!,clock,{batchPreference:2,leadThreshold:3,returnToNormal:true},'Manager explicitly confirmed settings on the returned device.'),clock,randomUUID());
      const nextEnvelope=documentA.outbox.at(-1)!.envelope;
      expect(nextEnvelope.clientSequence).toBe(2);expect(nextEnvelope.controllerEpoch).toBe(3);
      const old={...nextEnvelope,engineVersion:'synthetic-live-3'};
      const before=JSON.stringify(old);
      const rejected=await a.execute<UploadReceipt>(request('upload',{events:[old]},`/v1/matches/${matchId}/events`),restoredGrant);
      expect(rejected.results[0]).toMatchObject({disposition:'quarantined',reason:'UNSUPPORTED_EVENT_VERSION'});
      const retained=api.store.database.prepare('SELECT envelope_json FROM events WHERE event_id=?').get(old.eventId);
      expect(retained?.envelope_json).toBe(before);expect(checkpoint.engineVersion).toBe(ENGINE_VERSION);expect(ENGINE_VERSION).toBe('synthetic-live-4');
      const final=await a.download(matchId,'policy-phone-a');expect(final.state.policyHistory).toHaveLength(2);expect(final.deviceCheckpoint.clientSequence).toBe(2);
      const forged=await fetch(`${base}/v1/matches/${matchId}/events`,{method:'POST',headers:{Authorization:'Bearer synthetic-account-player-01','Content-Type':'application/json','X-Api-Contract-Version':EVENT_CONTRACT_VERSION,'Idempotency-Key':randomUUID(),'X-Controller-Token':restoredGrant.controllerToken,'X-Longball-Role':'manager'},body:JSON.stringify({events:[nextEnvelope]})});
      expect(forged.status).toBe(404);expect(api.store.match(matchId).state_json).toContain('"policyVersion":2');
    }finally{api.server.closeAllConnections();await api.close();}
  });
});
