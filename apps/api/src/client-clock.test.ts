import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { establishContinuousClockMapping } from '../../../packages/application/src/clock-exchange';
import { applyMutationResponse, createConnectedDocument, LongBallServiceClient, mergeDownload, prepareServiceRequest, queueConnectedCommand, retainClockMapping, type ConnectedMatchDocument, type UploadReceipt } from '../../../packages/application/src/sync';
import type { CommunityState } from '../../../packages/application/src/community';
import { createApi } from './server';
import { SYNTHETIC_IDS } from './store';

it('connects actual HTTP clock exchange through durable client mapping and queued full-time envelope to server-owned finish evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'longball-client-clock-'));
  const at = Date.parse('2026-10-21T10:00:00Z'); let mono = 1000;
  const sample = () => ({ monotonicMs: mono, sessionId: 'actual-client-boot', wallTimeMs: at + 99_000_000 + mono });
  const policy = { id:'fictional-client-clock-integration-v1', serverClockUncertaintyMs:10, maximumRoundTripMs:5000, maximumMappingAgeMs:7_200_000, maximumUncertaintyMs:2000, maximumDriftPpm:50 };
  const api = createApi({ databasePath:join(directory,'service.sqlite'), syntheticAuth:true, now:()=>at+mono, clockPolicy:policy });
  await new Promise<void>(resolve => api.server.listen(0,'127.0.0.1',resolve));
  try {
    const client = new LongBallServiceClient(`http://127.0.0.1:${(api.server.address() as AddressInfo).port}`, (url,options)=>fetch(url,{...options,headers:{...options.headers,Authorization:'Bearer synthetic-manager-1'}}));
    let document = mergeDownload(createConnectedDocument('client-clock-phone',SYNTHETIC_IDS.matchId,client.baseUrl), await client.download(SYNTHETIC_IDS.matchId,'client-clock-phone'));
    document = prepareServiceRequest(document,'acquire',randomUUID());
    document = applyMutationResponse(document,await client.execute(document.pendingRequest!,null),new Date(at+mono).toISOString());
    document = mergeDownload(document,await client.download(SYNTHETIC_IDS.matchId,document.deviceId));
    for (const playerId of document.localState!.config.selectedPlayerIds) document = queueConnectedCommand(document,{type:'attendance.recorded',playerId,status:'present'},sample(),randomUUID());
    const config=document.localState!.config;
    const lineup=config.selectedPlayerIds.slice(0,7).map((playerId,index)=>({playerId,slotId:config.slots?.[index]?.slotId??`slot-${index}`,position:config.slots?.[index]?.position??(index===0?'GK':'CM')}));
    document=queueConnectedCommand(document,{type:'lineup.staged',lineup},sample(),randomUUID());
    document=queueConnectedCommand(document,{type:'half.started'},sample(),randomUUID());
    document=prepareServiceRequest(document,'upload',randomUUID());
    const originalPrefix=JSON.stringify(document.pendingRequest);
    const mapping=await establishContinuousClockMapping({
      mutate:(path,body,idempotencyKey)=>client.execute({kind:'clock_exchange',path,body,idempotencyKey},document.grant),
      observe:()=>({sample:sample(),verifiedContinuous:true}),nextId:randomUUID,assertCurrent:()=>{},
    },{matchId:document.matchId,deviceId:document.deviceId,controllerEpoch:document.grant!.epoch});
    document=retainClockMapping(document,mapping,sample());
    document=JSON.parse(JSON.stringify(document)) as ConnectedMatchDocument;
    mono+=1_500_000; document=queueConnectedCommand(document,{type:'half.ended'},sample(),randomUUID());
    mono+=120_000; document=queueConnectedCommand(document,{type:'half.started'},sample(),randomUUID());
    mono+=1_500_000; document=queueConnectedCommand(document,{type:'half.ended'},sample(),randomUUID());
    const finish=document.outbox.at(-1)!.envelope;
    expect(finish.clockEvidence.anchorId).toBe(mapping.challengeId);
    expect(finish.clockEvidence.continuityId).toBe(mapping.continuityId);
    expect(finish.timeQuality).toBe('reviewRequired'); expect(finish.effectiveAt).toBeNull();
    expect(JSON.stringify(document.pendingRequest)).toBe(originalPrefix);
    document=applyMutationResponse(document,await client.execute(document.pendingRequest!,document.grant),new Date(at+mono).toISOString());
    document=mergeDownload(document,await client.download(document.matchId,document.deviceId));
    document=prepareServiceRequest(document,'upload',randomUUID());
    const response=await client.execute<UploadReceipt & {communityContext:{status:string;finishQuality:string}}>(document.pendingRequest!,document.grant);
    expect(response.communityContext).toMatchObject({status:'registered_from_accepted_history',finishQuality:'trusted'});
    const row=api.store.database.prepare("SELECT value_json FROM documents WHERE team_id=? AND season_id=? AND kind='community'").get(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId) as {value_json:string};
    const context=(JSON.parse(row.value_json) as CommunityState).matches.find(item=>item.id===document.matchId)!;
    expect(context.actualFullTimeAtMs).toBe(at+mono); expect(context.actualFullTimeAtMs).not.toBe(sample().wallTimeMs);
    expect(context.finalisationDeadlineAtMs).toBe(at+mono+3_600_000); expect(context.sharing).toBe('manager_only'); expect(context.voteCutoffAtMs).toBeNull();
    expect(document.clockMappingHistory).toEqual([mapping]);
  } finally { api.server.closeAllConnections(); await api.close(); rmSync(directory,{recursive:true,force:true}); }
});
