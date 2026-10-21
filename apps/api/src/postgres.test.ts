import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ENGINE_VERSION, reduceMatch, type MatchEvent, type MatchState } from '../../../packages/domain/src/index';
import { effectiveEventTime } from '../../../packages/application/src/sync';
import type { RecordsState } from '../../../packages/application/src/records';
import { createPostgresApi } from './postgres-server';
import { EVENT_CONTRACT_VERSION, SYNTHETIC_IDS, type EventEnvelope } from './store';
import type { ApiOptions } from './server';
import type { CommunityState } from '../../../packages/application/src/community';
import { runDuePostgresJobs } from '../../worker/src/postgres-jobs';
import { runDueTeamNotifications } from '../../worker/src/notification-jobs';
import { PostgresStore } from './postgres-store';
import { applyRuntimeGrants } from './runtime-grants';

const configuredUrl = process.env.LONGBALL_POSTGRES_TEST_URL;
let at = Date.now();
const running: Awaited<ReturnType<typeof createPostgresApi>>[] = [];
const fixtures: { database: string; directory: string }[] = [];
const workers: PostgresStore[] = [];
const workerFixtureRoles: string[] = [];
let admin: Pool;
const teamUrl = `/v1/teams/${SYNTHETIC_IDS.teamId}`;
const matchUrl = `/v1/matches/${SYNTHETIC_IDS.matchId}`;

describe.skipIf(!configuredUrl)('real PostgreSQL HTTP runtime (requires disposable PostgreSQL)', () => {
  beforeAll(() => { admin = new Pool({ connectionString: configuredUrl, max: 2 }); });
  beforeEach(() => { at = Date.now(); });
  afterEach(async () => {
    for (const worker of workers.splice(0)) await worker.close();
    for (const api of running.splice(0)) { api.server.closeAllConnections(); await api.close(); }
    for (const fixture of fixtures.splice(0)) {
      await admin.query(`DROP DATABASE "${fixture.database}" WITH (FORCE)`);
      rmSync(fixture.directory, { recursive: true, force: true });
    }
    for (const role of workerFixtureRoles.splice(0)) await admin.query(`DROP ROLE "${role}"`);
  });
  afterAll(async () => { await admin.end(); });
  async function start(connectionString?: string, directory?: string, overrides:Partial<ApiOptions>={}) {
    if (!connectionString) {
      const database = `longball_api_${randomUUID().replaceAll('-', '')}`;
      directory = mkdtempSync(join(tmpdir(), 'longball-real-pg-'));
      fixtures.push({ database, directory });
      await admin.query(`CREATE DATABASE "${database}"`);
      const url = new URL(configuredUrl!); url.pathname = `/${database}`; connectionString = url.href;
    }
    const api = await createPostgresApi({ connectionString, databasePath: join(directory!, 'unused-sqlite-path'), mediaDirectory: join(directory!, 'private-media'), syntheticAuth: true, allowOwnerTestFixture:true, now: () => at, ...overrides });
    running.push(api);
    await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
    const call = async (path: string, input: { token?: string | null; body?: unknown; key?: string; controller?: string; role?: string } = {}) => {
      const headers: Record<string, string> = {};
      if (input.token !== null) headers.Authorization = `Bearer ${input.token ?? 'synthetic-manager-1'}`;
      if (input.body !== undefined) { headers['Content-Type'] = 'application/json'; headers['Idempotency-Key'] = input.key ?? randomUUID(); headers['X-Api-Contract-Version'] = EVENT_CONTRACT_VERSION; }
      if (input.controller) headers['X-Controller-Token'] = input.controller;
      if (input.role) headers['X-Longball-Role'] = input.role;
      const response = await fetch(`${base}${path}`, { method: input.body === undefined ? 'GET' : 'POST', headers, body: input.body === undefined ? undefined : JSON.stringify(input.body) });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    return { api, call, base, connectionString, directory: directory! };
  }
  async function restrictedWorker(client: Awaited<ReturnType<typeof start>>) {
    const suffix = randomUUID().replaceAll('-', '');
    const roles = { apiRole: `lb_fixture_api_${suffix}`, workerRole: `lb_fixture_worker_${suffix}` };
    for (const role of Object.values(roles)) {
      await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      workerFixtureRoles.push(role);
    }
    await applyRuntimeGrants(client.api.store.db, roles);
    const url = new URL(client.connectionString); url.username = roles.workerRole; url.password = '';
    const worker = await PostgresStore.open(url.href, client.api.store.now, { migrationMode: 'verify' });
    workers.push(worker); await worker.assertRuntimeRole('worker');
    return worker;
  }
  const event = (state: MatchState, details: Record<string, unknown>, sequence = 1, previousEventId: string | null = null, monotonicMs=0, anchorId='pg-clock-anchor'): EventEnvelope => {
    const id = randomUUID();
    const command = { id, sample: { monotonicMs, sessionId: 'pg-continuity-a', wallTimeMs: at+monotonicMs }, ...details } as MatchEvent;
    const next = reduceMatch(state, command); const effective = effectiveEventTime(state, next, command);
    return { contractVersion: EVENT_CONTRACT_VERSION, schemaVersion: 1, engineVersion: ENGINE_VERSION, eventId: id, matchId: SYNTHETIC_IDS.matchId, deviceId: 'pg-phone-a', controllerEpoch: 1, clientSequence: sequence, previousEventId, baseRevision: state.revision, effectiveHalf: effective.half, halfElapsedMs: effective.halfElapsedMs, matchElapsedMs: effective.matchElapsedMs, effectiveAt: null, recordedAt: new Date(at+monotonicMs).toISOString(), timeQuality: 'reviewRequired', clockEvidence: { monotonicMs, anchorId, continuityId: 'pg-continuity-a' }, command };
  };
  const clockPolicy={id:'fictional-postgres-clock-test-v1',serverClockUncertaintyMs:1,maximumRoundTripMs:5_000,maximumMappingAgeMs:7_200_000,maximumUncertaintyMs:2_000,maximumDriftPpm:50};
  it('consumes a controller-bound clock challenge once and retains a replayable receipt without granting a new epoch authority',async()=>{
    let clock=at;const client=await start(undefined,undefined,{now:()=>clock,clockPolicy});
    const acquired=await client.call(`${matchUrl}/controller`,{body:{deviceId:'pg-phone-a'}});const controller=acquired.body.controllerToken as string;
    const challenge=await client.call(`${matchUrl}/clock/challenges`,{controller,body:{deviceId:'pg-phone-a',controllerEpoch:1,continuityId:'pg-continuity-a'}});
    expect(challenge.status).toBe(200);clock+=100;
    const key=randomUUID();const body={receivedMonotonicMs:10.25,sentMonotonicMs:20.5};
    const mapping=await client.call(`${matchUrl}/clock/challenges/${challenge.body.id}/acknowledge`,{key,controller,body});
    expect(mapping.status).toBe(200);expect(mapping.body).toMatchObject({accountId:'synthetic-account-manager',deviceId:'pg-phone-a',controllerEpoch:1,continuityId:'pg-continuity-a',sampleMonotonicMs:20.5});
    expect(await client.call(`${matchUrl}/clock/challenges/${challenge.body.id}/acknowledge`,{key,controller,body})).toEqual(mapping);
    expect((await client.call(`${matchUrl}/clock/challenges/${challenge.body.id}/acknowledge`,{controller,body})).body.code).toBe('CLOCK_CHALLENGE_CONSUMED');
    expect((await client.call(`${matchUrl}/clock/challenges`,{controller,body:{deviceId:'other-device',controllerEpoch:1,continuityId:'pg-continuity-a'}})).status).toBe(409);
    expect(await client.api.store.one('SELECT COUNT(*)::integer AS count FROM clock_mappings')).toEqual({count:1});
  });
  it('keeps accepted full time and the original deadline across late first sync, a sealed award and later conflicting history',async()=>{
    // Record the historical match clock first; worker claims always observe the actual database clock.
    at=Date.now()-6_660_100;
    let clock=at;const client=await start(undefined,undefined,{now:()=>clock,clockPolicy});
    expect((await client.call(`${teamUrl}/preparation`,{body:{command:{id:randomUUID(),expectedRevision:0,type:'fixture.saved',fixture:{id:SYNTHETIC_IDS.matchId,seasonId:SYNTHETIC_IDS.seasonId,opponent:'Fictional clock FC',playedDate:'2026-10-21',kickoff:'10:00',arrival:'09:30',venue:'Fictional pitch',homeAway:'home',format:7,plannedHalfDurationMs:1_500_000}}}})).status).toBe(200);
    expect((await client.call(`${teamUrl}/preparation`,{body:{command:{id:randomUUID(),expectedRevision:1,type:'fixture.prepared',fixtureId:SYNTHETIC_IDS.matchId,formationId:'formation-7'}}})).status).toBe(200);
    const acquired=await client.call(`${matchUrl}/controller`,{body:{deviceId:'pg-phone-a'}});const controller=acquired.body.controllerToken as string;
    const challenge=await client.call(`${matchUrl}/clock/challenges`,{controller,body:{deviceId:'pg-phone-a',controllerEpoch:1,continuityId:'pg-continuity-a'}});
    clock+=100;const mapped=await client.call(`${matchUrl}/clock/challenges/${challenge.body.id}/acknowledge`,{controller,body:{receivedMonotonicMs:10,sentMonotonicMs:20}});expect(mapped.status).toBe(200);
    const downloaded=await client.call(`${matchUrl}/download?deviceId=pg-phone-a`);let state=downloaded.body.state as MatchState;let sequence=0;let previous:string|null=null;const events:EventEnvelope[]=[];
    const append=(details:Record<string,unknown>,mono:number)=>{const wire=event(state,details,++sequence,previous,mono,challenge.body.id as string);state=reduceMatch(state,wire.command);previous=wire.eventId;events.push(wire);return wire;};
    for(const playerId of state.config.selectedPlayerIds)append({type:'attendance.recorded',playerId,status:'present'},20);
    const lineup=state.config.selectedPlayerIds.slice(0,7).map((playerId,index)=>({playerId,slotId:state.config.slots?.[index]?.slotId??`slot-${index}`,position:state.config.slots?.[index]?.position??(index===0?'GK':'CM')}));
    append({type:'lineup.staged',lineup},20);append({type:'half.started'},20);append({type:'half.ended'},1_500_020);append({type:'half.started'},1_500_020);append({type:'half.ended'},3_000_020);
    clock=at+6_660_100;
    const uploaded=await client.call(`${matchUrl}/events`,{controller,body:{events}});expect(uploaded.status).toBe(200);expect(uploaded.body.communityContext).toMatchObject({status:'registered_from_accepted_history',finishQuality:'trusted'});
    const registered=await client.api.store.document<CommunityState>(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community');const context=registered.matches.find(match=>match.id===SYNTHETIC_IDS.matchId)!;
    expect(context.actualFullTimeAtMs).toBe(at+3_000_055);expect(context.actualFullTimeAtMs).toBeLessThan(clock-3_600_000);expect(context.finalisationDeadlineAtMs).toBe(context.actualFullTimeAtMs!+3_600_000);expect(context.sharing).toBe('manager_only');expect(context.voteCutoffAtMs).toBeNull();
    const configured=await client.call(`${teamUrl}/community`,{body:{command:{id:randomUUID(),type:'award.cutoffConfigured',matchId:SYNTHETIC_IDS.matchId,minutesAfterFullTime:58}}});expect(configured.status).toBe(200);
    expect(await runDuePostgresJobs(await restrictedWorker(client),Date.now())).toEqual({completed:1,retried:0,failed:0});
    const sealed=await client.api.store.document<CommunityState>(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community');const original=sealed.matches.find(match=>match.id===SYNTHETIC_IDS.matchId)!;const award=sealed.awards.find(award=>award.matchId===SYNTHETIC_IDS.matchId)!;expect(award.deadlineMissed).toBe(true);
    const newId=randomUUID();const oldBranch={...events.at(-1)!,eventId:newId,clientSequence:sequence+1,previousEventId:previous,baseRevision:state.revision,engineVersion:'unrecognized-engine',command:{...events.at(-1)!.command,id:newId}};
    expect((await client.call(`${matchUrl}/events`,{controller,body:{events:[oldBranch]}})).status).toBe(409);
    const flagged=await client.api.store.document<CommunityState>(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community');expect(flagged.matches.find(match=>match.id===SYNTHETIC_IDS.matchId)).toEqual({...original,finishQuality:'conflicted'});expect(flagged.awards.find(item=>item.matchId===SYNTHETIC_IDS.matchId)).toEqual(award);
  });
  it('persists immutable review proposals while keeping Q08 apply authority fail closed and original branches intact',async()=>{
    const client=await start();const granted=await client.call(`${matchUrl}/controller`,{body:{deviceId:'pg-phone-a'}});const controller=granted.body.controllerToken as string;
    const download=await client.call(`${matchUrl}/download?deviceId=pg-phone-a`);const pending=event(download.body.state as MatchState,{type:'attendance.recorded',playerId:'synthetic-player-01',status:'present'});pending.engineVersion='future-retained-engine';
    expect((await client.call(`${matchUrl}/events`,{controller,body:{events:[pending]}})).status).toBe(409);
    const snapshot=await client.call(`${matchUrl}/reconciliation`);expect(snapshot.status).toBe(200);expect(snapshot.body.policy).toMatchObject({status:'unapproved'});
    const proposal={proposalId:randomUUID(),baseRevision:0,sourceSubmissionIds:[pending.eventId],reason:'Reviewed original device evidence; retain disputed history without importing any clock or play',resolution:'retain_conflict',commands:[]};
    const prepared=await client.call(`${matchUrl}/reconciliation/proposals`,{body:proposal});expect(prepared.status).toBe(200);expect(prepared.body.status).toBe('prepared');expect(prepared.body.appliedRevision).toBeNull();expect(prepared.body.preview).not.toHaveProperty('projectedState');
    expect(await client.call(`${matchUrl}/reconciliation/proposals`,{body:proposal})).toEqual(prepared);
    expect((await client.call(`${matchUrl}/reconciliation/proposals`,{body:{...proposal,reason:'Different evidence under the same immutable identity'}})).status).toBe(409);
    const applied=await client.call(`${matchUrl}/reconciliation/apply`,{body:{proposalId:proposal.proposalId,expectedRevision:0,events:[]}});expect(applied.status).toBe(503);expect(applied.body.code).toBe('Q08_AUTHORITY_UNAPPROVED');
    expect((await client.call(`${matchUrl}/reconciliation`,{token:'synthetic-account-player-01'})).status).toBe(404);
    expect(await client.api.store.one('SELECT COUNT(*)::integer AS count FROM events')).toEqual({count:1});expect((JSON.parse((await client.api.store.match(SYNTHETIC_IDS.matchId)).state_json) as MatchState).revision).toBe(0);
  });
  it('accepts late v3 participation correction wire events and refreshes the same archive while another report context is selected',async()=>{
    const client=await start();const granted=await client.call(`${matchUrl}/controller`,{body:{deviceId:'pg-phone-a'}});const controller=granted.body.controllerToken as string;
    const download=await client.call(`${matchUrl}/download?deviceId=pg-phone-a`);let state=download.body.state as MatchState;let sequence=0;let previous:string|null=null;
    const append=(details:Record<string,unknown>,mono:number)=>{const wire=event(state,details,++sequence,previous,mono);state=reduceMatch(state,wire.command);previous=wire.eventId;return wire;};
    const initial:EventEnvelope[]=[];
    for(const playerId of state.config.selectedPlayerIds)initial.push(append({type:'attendance.recorded',playerId,status:'present'},0));
    const lineup=state.config.selectedPlayerIds.slice(0,7).map((playerId,index)=>({playerId,slotId:`slot-${index}`,position:index===0?'GK':'CM'}));
    initial.push(append({type:'lineup.staged',lineup},0),append({type:'half.started'},0),append({type:'half.ended'},1_500_000),append({type:'half.started'},1_500_000),append({type:'half.ended'},3_000_000));
    expect((await client.call(`${matchUrl}/events`,{controller,body:{events:initial}})).status).toBe(200);
    expect((await client.call(`${teamUrl}/records`,{body:{command:{type:'live.archive',commandId:randomUUID(),matchId:SYNTHETIC_IDS.matchId,expectedSourceMatchRevision:state.revision}}})).status).toBe(200);
    const before=await client.api.store.document<RecordsState>(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'records');
    const profileIds=state.config.selectedPlayerIds.map(playerId=>`${playerId}:${SYNTHETIC_IDS.seasonId}`);let prepRevision=0;
    for(const command of [{type:'fixture.saved',fixture:{id:'fictional-other-report-context',seasonId:SYNTHETIC_IDS.seasonId,opponent:'Fictional Other FC',playedDate:'2026-10-25',kickoff:'10:00',arrival:'09:30',venue:'Fictional pitch',homeAway:'home',format:7,plannedHalfDurationMs:1_500_000}},{type:'fixture.selection_saved',fixtureId:'fictional-other-report-context',selectedProfileIds:profileIds},{type:'fixture.prepared',fixtureId:'fictional-other-report-context',formationId:'formation-7'}]){
      const reply=await client.call(`${teamUrl}/preparation`,{body:{command:{id:randomUUID(),expectedRevision:prepRevision,...command}}});expect(reply.status).toBe(200);prepRevision=reply.body.revision as number;
    }
    expect((await client.call(`${teamUrl}/records`,{body:{command:{type:'live.context.set',commandId:randomUUID(),details:{matchId:'fictional-other-report-context',playedDate:'2026-10-25',opponent:'Fictional Other FC',homeAway:'home',fixtureClass:'unclassified'}}}})).status).toBe(200);
    const benchPlayer=state.config.selectedPlayerIds.find(playerId=>!lineup.some(item=>item.playerId===playerId))!;
    const replacement=lineup.map((item,index)=>index===1?{...item,playerId:benchPlayer}:item);
    const late=append({type:'lineup.committed',sourceRevision:state.revision,lineup:replacement,effective:{half:1,halfElapsedMs:300_000,matchElapsedMs:300_000},lateEntryReason:'Retrospective coaching notes and referee evidence confirm the first-half substitution',actorId:'forged-actor'},3_000_000);
    expect(late.halfElapsedMs).toBe(300_000);expect((await client.call(`${matchUrl}/events`,{controller,body:{events:[late]}})).status).toBe(200);
    const first=await client.api.store.document<RecordsState>(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'records');const archived=first.results.find(item=>item.id===SYNTHETIC_IDS.matchId)!;
    expect(first.results).toHaveLength(before.results.length);expect(first.liveMatch.matchId).toBe('fictional-other-report-context');expect(archived.participation?.find(item=>item.playerId===benchPlayer)?.playedMs).toBe(1_200_000);
    const original=await client.api.store.one('SELECT envelope_json FROM events WHERE event_id=$1',[late.eventId]);
    const corrected=append({type:'event.corrected',targetEventId:late.eventId,sourceRevision:state.revision,reason:'Corrected first-half substitution from five to ten active minutes using the retained referee record',replacement:{type:'lineup.committed',lineup:replacement,effective:{half:1,halfElapsedMs:600_000,matchElapsedMs:600_000}}},3_000_000);
    expect(corrected.halfElapsedMs).toBe(600_000);expect((await client.call(`${matchUrl}/events`,{controller,body:{events:[corrected]}})).status).toBe(200);
    const latest=await client.api.store.document<RecordsState>(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'records');const result=latest.results.find(item=>item.id===SYNTHETIC_IDS.matchId)!;
    expect(result.participation?.find(item=>item.playerId===benchPlayer)?.playedMs).toBe(900_000);expect(result.sourceMatchRevision).toBe(state.revision);expect(latest.liveMatch.matchId).toBe('fictional-other-report-context');
    expect(await client.api.store.one('SELECT envelope_json FROM events WHERE event_id=$1',[late.eventId])).toEqual(original);
    const accepted=JSON.parse((await client.api.store.match(SYNTHETIC_IDS.matchId)).state_json) as MatchState;expect(accepted.eventHistory?.find(item=>item.id===late.eventId)?.actorId).toBe('synthetic-account-manager');expect(accepted.matchActiveMs).toBe(3_000_000);
    const report=await client.call(`${teamUrl}/records`);expect((report.body.participation as {rows:{playerId:string;playingMs:number}[]}).rows.find(row=>row.playerId===benchPlayer)?.playingMs).toBe(900_000);
  });
  it('serves current administrator staff DTOs without a directory and persists scoped revisioned commands',async()=>{
    const client=await start(),path=`${teamUrl}/managers`;
    expect((await client.call(path,{token:'synthetic-manager-2'})).status).toBe(404);expect((await client.call(path,{token:'synthetic-account-player-01'})).status).toBe(404);expect((await client.call(path,{role:'manager'})).status).toBe(404);
    const roster=await client.call(path,{token:'synthetic-admin',role:'administrator'});expect(roster.status).toBe(200);expect(roster.body).toMatchObject({kind:'manager-roster',revision:0,activeTeamManagerCount:4,maximumManagers:4});
    const wire=JSON.stringify(roster.body);expect(wire).not.toContain('synthetic-player');expect(wire).not.toContain('synthetic-account-manager-5');expect(wire).not.toContain('synthetic-account-other-manager');expect(wire).not.toContain('subject');
    await client.api.store.execute('INSERT INTO team_seasons(club_id,team_id,season_id) VALUES($1,$2,$3)',['synthetic-richmond-rovers',SYNTHETIC_IDS.teamId,'fictional-retained-season']);
    await client.api.store.execute("INSERT INTO memberships(account_id,team_id,season_id,role) VALUES($1,$2,$3,'manager')",['synthetic-account-manager-4',SYNTHETIC_IDS.teamId,'fictional-retained-season']);
    const key=randomUUID(),body={command:{id:key,type:'manager.revoked',expectedRevision:0,accountId:'synthetic-account-manager-4',reason:'Explicit departure from the requested season',confirmRevocation:true}};
    const revoked=await client.call(`${path}/revoke`,{token:'synthetic-admin',role:'administrator',key,body});expect(revoked.status).toBe(200);expect(revoked.body).toMatchObject({commandId:key,revision:1,remainingActiveTeamSeasons:['fictional-retained-season']});expect(await client.call(`${path}/revoke`,{token:'synthetic-admin',role:'administrator',key,body})).toEqual(revoked);
    const current=await client.call(path,{token:'synthetic-admin'});expect(current.body.activeTeamManagerCount).toBe(4);expect((current.body.managers as {accountId:string}[]).find(item=>item.accountId==='synthetic-account-manager-4')).toMatchObject({status:'revoked',otherActiveSeasonIds:['fictional-retained-season']});
    expect((await client.call(path,{token:'synthetic-admin',body:{accountId:'synthetic-account-manager-5'}})).body.code).toBe('MANAGER_LIMIT');
    await client.api.store.execute("UPDATE memberships SET revoked_at=$1 WHERE account_id=$2 AND season_id=$3",[at,'synthetic-account-manager-4','fictional-retained-season']);
    const assignKey=randomUUID(),assigned=await client.call(path,{token:'synthetic-admin',key:assignKey,body:{command:{id:assignKey,type:'manager.assigned',expectedRevision:1,accountId:'synthetic-account-manager-5'}}});expect(assigned.status).toBe(200);expect(assigned.body.revision).toBe(2);
    expect((await client.call(path,{token:'synthetic-admin'})).body.candidates).toContainEqual({accountId:'synthetic-account-manager-5',label:'Verified adult account',currentManager:true});
    await client.api.store.execute("UPDATE accounts SET adult_verified=0 WHERE id='synthetic-account-admin'");expect((await client.call(path,{token:'synthetic-admin'})).status).toBe(403);
  });
  it('deduplicates explicitly scoped account requests across PostgreSQL pools and rechecks leave authority on retries',async()=>{
    const client=await start(),other=await start(client.connectionString,client.directory),path='/v1/privacy/requests',token='synthetic-account-player-01';
    expect((await client.call(path,{token,body:{kind:'leave_team'}})).status).toBe(400);expect((await client.call(path,{token,body:{kind:'delete_account'}})).status).toBe(400);expect((await client.call(path,{token,body:{kind:'leave_team',teamId:'synthetic-other-team',seasonId:SYNTHETIC_IDS.seasonId,confirmLeave:true}})).status).toBe(404);
    await client.api.store.execute('INSERT INTO team_seasons(club_id,team_id,season_id) VALUES($1,$2,$3)',['synthetic-richmond-rovers',SYNTHETIC_IDS.teamId,'fictional-revoked-season']);
    await client.api.store.execute("INSERT INTO memberships(account_id,team_id,season_id,role,player_id,revoked_at) VALUES($1,$2,$3,'player',$4,$5)",[token,SYNTHETIC_IDS.teamId,'fictional-revoked-season','synthetic-player-01',at-1]);
    const body={kind:'export',scope:'all_memberships',confirmAllMemberships:true};const responses=await Promise.all([client.call(path,{token,body}),other.call(path,{token,body})]);expect(responses.map(item=>item.status)).toEqual([200,200]);expect(responses[0].body).toEqual(responses[1].body);expect(responses[0].body.affectedMemberships).toHaveLength(2);
    await client.api.store.execute("INSERT INTO privacy_requests(id,account_id,kind,status,created_at,affected_memberships_json) VALUES($1,$2,'export','pending_verification_and_policy',$3,$4)",['legacy-retained-export',token,at+1,JSON.stringify(responses[0].body.affectedMemberships)]);
    const duplicates=await client.call(path,{token});expect((duplicates.body.items as {requestId:string}[]).find(item=>item.requestId==='legacy-retained-export')).toMatchObject({duplicateOfRequestId:responses[0].body.requestId,reviewStatus:'duplicate_requires_review'});
    await client.api.store.execute("UPDATE privacy_requests SET status='needs_scope' WHERE id=$1",[responses[0].body.requestId]);expect((await other.call(path,{token,body})).body.requestId).toBe('legacy-retained-export');
    expect(await client.api.store.one('SELECT COUNT(*)::integer AS count FROM privacy_requests')).toEqual({count:2});expect(await client.api.store.one('SELECT COUNT(*)::integer AS count FROM privacy_pending_keys')).toEqual({count:1});
    const key=randomUUID(),leave={kind:'leave_team',teamId:SYNTHETIC_IDS.teamId,seasonId:SYNTHETIC_IDS.seasonId,confirmLeave:true};const submitted=await client.call(path,{token,key,body:leave});expect(submitted.status).toBe(200);expect(await client.call(path,{token,key,body:leave})).toEqual(submitted);
    await client.api.store.execute('UPDATE memberships SET revoked_at=$1 WHERE account_id=$2 AND season_id=$3',[at,token,SYNTHETIC_IDS.seasonId]);expect((await other.call(path,{token,key,body:leave})).status).toBe(404);
    const list=await client.call(path,{token});expect(list.body.memberships).toHaveLength(2);expect((list.body.items as {requestId:string;affectedMemberships:{status:string}[]}[]).find(item=>item.requestId===submitted.body.requestId)?.affectedMemberships[0].status).toBe('active');expect((await client.call(path,{token:'synthetic-account-player-02'})).body.items).toEqual([]);
    expect(await client.api.store.one('SELECT status FROM accounts WHERE id=$1',[token])).toEqual({status:'active'});expect((await client.api.store.many('SELECT * FROM memberships WHERE account_id=$1',[token]))).toHaveLength(2);
  });
  it('joins only a sealed award summary and permitted published album count into current role-filtered reports and exports',async()=>{
    // The accepted vote is historical; finalisation runs at actual time after its original cutoff.
    at=Date.now()-600_001;
    let clock=at;const client=await start(undefined,undefined,{now:()=>clock});
    const records=await client.api.store.document<RecordsState>(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'records');const record=records.results[0];
    // An explicit fictional policy fixture exercises both allow/withhold paths; clients cannot approve it.
    record.publication={id:'fictional-report-sharing-test',version:1,fixtureClass:record.fixtureClass,confirmed:true,confirmationReference:'isolated-fixture-only',allowedRoles:['player','spectator']};
    const community=await client.api.store.document<CommunityState>(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community');const originalId=community.matches[0].id;
    community.matches[0]={...community.matches[0],id:record.id,sharing:'fictional_review_only'};community.photos=community.photos.map(photo=>photo.matchId===originalId?{...photo,matchId:record.id}:photo);
    await client.api.store.transaction(async()=>{await client.api.store.saveDocument(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'records',records);await client.api.store.saveDocument(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community',community);});
    expect((await client.call(`${teamUrl}/community`,{body:{command:{id:randomUUID(),type:'award.cutoffConfigured',matchId:record.id,minutesAfterFullTime:20}}})).status).toBe(200);
    const ballotId=randomUUID();expect((await client.call(`${teamUrl}/community`,{token:'synthetic-account-player-01',role:'player',body:{command:{id:ballotId,type:'ballot.cast',matchId:record.id,candidatePlayerId:'synthetic-player-02'}}})).status).toBe(200);
    const queued=await client.api.store.document<CommunityState>(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community');queued.matches.push({...queued.matches[0],id:'unclaimed-due-award-context',voteCutoffAtMs:at-1,cutoffSource:'explicit_fictional_setting'});await client.api.store.saveDocument(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community',queued);
    const before=await client.call(`${teamUrl}/records`,{token:'synthetic-account-player-01',role:'player'});expect((before.body.matches as Record<string,unknown>[]).find(item=>item.matchId===record.id)).toMatchObject({award:null,publishedAlbum:{matchId:record.id,photoCount:1},communityStatus:'available'});
    clock=Date.now();expect(await runDuePostgresJobs(await restrictedWorker(client),clock)).toEqual({completed:1,retried:0,failed:0});
    expect((await client.api.store.document<CommunityState>(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community')).awards.some(award=>award.matchId==='unclaimed-due-award-context')).toBe(false);
    for(const audience of [{token:'synthetic-manager-1',role:'manager'},{token:'synthetic-account-player-01',role:'player'},{token:'synthetic-spectator',role:'spectator'}]){
      const response=await client.call(`${teamUrl}/records`,audience);expect(response.status).toBe(200);const report=(response.body.matches as Record<string,unknown>[]).find(item=>item.matchId===record.id)!;
      expect(report).toMatchObject({communityStatus:'available',publishedAlbum:{matchId:record.id,photoCount:1},award:{matchId:record.id,result:'winners',winnerLabels:['Noah Patel'],deadlineMissed:false}});
      const wire=JSON.stringify(response.body);for(const privateValue of [ballotId,'winnerPlayerIds','voterAccountId','synthetic-pending-ball','Fictional football illustration awaiting review.'])expect(wire).not.toContain(privateValue);
      const exported=await client.call(`${teamUrl}/records/export?kind=match&matchId=${record.id}&format=json`,audience);expect(exported.status).toBe(200);const document=JSON.parse(exported.body.body as string) as {audience:string;matches:Record<string,unknown>[]};expect(document.audience).toBe(audience.role);expect(document.matches[0].award).toEqual(report.award);expect(document.matches[0].publishedAlbum).toEqual(report.publishedAlbum);
    }
    expect((await client.call(`${teamUrl}/community`,{token:'synthetic-account-player-01',role:'player',body:{command:{id:randomUUID(),type:'uploader.hidden',uploaderAccountId:'synthetic-account-manager',hidden:true}}})).status).toBe(200);
    const own=await client.call(`${teamUrl}/records`,{token:'synthetic-account-player-01',role:'player'});expect((own.body.matches as Record<string,unknown>[]).find(item=>item.matchId===record.id)?.publishedAlbum).toEqual({matchId:record.id,photoCount:0});
    const withheld=await client.api.store.document<CommunityState>(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community');withheld.matches[0].sharing='manager_only';await client.api.store.saveDocument(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community',withheld);
    const privateCommunity=await client.call(`${teamUrl}/records`,{token:'synthetic-spectator',role:'spectator'});expect((privateCommunity.body.matches as Record<string,unknown>[]).find(item=>item.matchId===record.id)).toMatchObject({communityStatus:'withheld',award:null,publishedAlbum:null});
    record.publication={...record.publication,confirmed:false,allowedRoles:[]};await client.api.store.saveDocument(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'records',records);
    const privateReport=await client.call(`${teamUrl}/records`,{token:'synthetic-account-player-01',role:'player'});expect((privateReport.body.matches as Record<string,unknown>[]).find(item=>item.matchId===record.id)).toMatchObject({communityStatus:'withheld',award:null,publishedAlbum:null});
    expect((await client.call(`${teamUrl}/records`,{token:'synthetic-admin',role:'administrator'})).status).toBe(404);
  });
  it('revokes only the explicit season assignment, freezes its controller and frees a manager place without erasing history',async()=>{
    const client=await start();const acquired=await client.call(`${matchUrl}/controller`,{token:'synthetic-manager-4',body:{deviceId:'departing-manager-phone'}});expect(acquired.status).toBe(200);
    const denied=await client.call(`${teamUrl}/managers/revoke`,{token:'synthetic-manager-2',body:{accountId:'synthetic-account-manager-4',reason:'Departure independently recorded for this season',confirmRevocation:true}});expect(denied.status).toBe(404);
    const revoked=await client.call(`${teamUrl}/managers/revoke`,{token:'synthetic-admin',body:{accountId:'synthetic-account-manager-4',reason:'Departure independently recorded for this season',confirmRevocation:true}});expect(revoked.status).toBe(200);expect(revoked.body).toMatchObject({revoked:true,otherSeasonAssignmentsRetained:true});
    expect((await client.call(`${matchUrl}/download?deviceId=departing-manager-phone`,{token:'synthetic-manager-4'})).status).toBe(404);
    expect(await client.api.store.one('SELECT frozen FROM controller_grants WHERE match_id=$1',[SYNTHETIC_IDS.matchId])).toEqual({frozen:1});
    expect((await client.call(`${teamUrl}/managers`,{token:'synthetic-admin',body:{accountId:'synthetic-account-manager-5'}})).status).toBe(200);
    expect(await client.api.store.one('SELECT COUNT(*)::integer AS count FROM matches')).toEqual({count:1});
  });
  it('commits generic notification jobs with the triggering schedule edit, deduplicates retries, and rolls both back on a queue failure',async()=>{
    const client=await start();
    const fixture={id:'fictional-notification-fixture',seasonId:SYNTHETIC_IDS.seasonId,opponent:'Fictional private fixture label',playedDate:'2026-11-05',kickoff:'10:00',arrival:'09:30',venue:'Fictional pitch',homeAway:'home',format:7,plannedHalfDurationMs:1_500_000};
    const key=randomUUID();const body={command:{id:randomUUID(),expectedRevision:0,type:'fixture.saved',fixture}};
    const saved=await client.call(`${teamUrl}/preparation`,{key,body});expect(saved.status).toBe(200);
    const jobs=await client.api.store.many("SELECT payload_json FROM jobs WHERE kind='notification.dispatch'");expect(jobs.length).toBeGreaterThan(0);expect(JSON.stringify(jobs)).not.toContain(fixture.opponent);expect(JSON.stringify(jobs)).not.toContain('Your team has an update');
    expect(await client.call(`${teamUrl}/preparation`,{key,body})).toEqual(saved);expect((await client.api.store.many("SELECT id FROM jobs WHERE kind='notification.dispatch'")).length).toBe(jobs.length);
    expect((await client.call(`${teamUrl}/preparation/own`,{token:'synthetic-account-player-01',body:{command:{id:randomUUID(),expectedRevision:1,type:'own.fixture_response_recorded',fixtureId:fixture.id,response:'available'}}})).status).toBe(200);
    expect((await client.api.store.many("SELECT id FROM jobs WHERE kind='notification.dispatch'")).length).toBe(jobs.length);
    await client.api.store.db.query("CREATE FUNCTION longball.reject_notification_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='notification.dispatch' AND NEW.payload_json->>'accountId'='synthetic-account-player-02' THEN RAISE EXCEPTION 'one recipient queue fault'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_notification_test BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION longball.reject_notification_test()");
    const rejectedKey=randomUUID();const rejectedBody={command:{id:randomUUID(),expectedRevision:2,type:'fixture.saved',fixture:{...fixture,id:'fictional-rolled-back-notification'}}};
    expect((await client.call(`${teamUrl}/preparation`,{key:rejectedKey,body:rejectedBody})).status).toBe(422);
    const after=await client.call(`${teamUrl}/preparation`);expect((after.body.fixtures as {id:string}[]).some(item=>item.id==='fictional-rolled-back-notification')).toBe(false);expect(after.body.revision).toBe(2);expect(await client.api.store.one('SELECT key FROM idempotency WHERE key=$1',[rejectedKey])).toBeUndefined();expect((await client.api.store.many("SELECT id FROM jobs WHERE kind='notification.dispatch'")).length).toBe(jobs.length);
    await client.api.store.db.query('DROP TRIGGER reject_notification_test ON jobs');
    expect((await client.call(`${teamUrl}/preparation`,{key:rejectedKey,body:rejectedBody})).status).toBe(200);
    const dispatched=await runDueTeamNotifications(await restrictedWorker(client),{now:()=>at,maximum:3});expect(dispatched.accepted).toBe(0);expect(dispatched.blocked+dispatched.suppressed).toBe(3);
    expect(await client.api.store.one("SELECT COUNT(*)::integer AS count FROM jobs WHERE kind='notification.dispatch' AND state='completed'")).toEqual({count:0});
  });
  it('uses real PostgreSQL JSONB/FKs and filters auth, team, own-player and selected-role access', async () => {
    const client = await start();
    const version = await client.api.store.one('SELECT version() AS version,current_database() AS database');
    expect(version?.version).toMatch(/^PostgreSQL /); expect(version?.database).toMatch(/^longball_api_/);
    const physical = await client.api.store.one("SELECT data_type FROM information_schema.columns WHERE table_schema='longball' AND table_name='documents' AND column_name='value_json'");
    expect(physical?.data_type).toBe('jsonb');
    expect((await client.call('/v1/me', { token: null })).status).toBe(401);
    expect((await client.call(matchUrl, { token: 'synthetic-other-manager' })).status).toBe(404);
    const own = await client.call(matchUrl, { token: 'synthetic-account-player-01' });
    expect(own.status).toBe(200); expect(own.body).not.toHaveProperty('state'); expect(own.body.score).toBeNull();
    expect(JSON.stringify(own.body)).not.toContain('synthetic-player-02');
    await client.api.store.execute("INSERT INTO memberships(account_id,team_id,season_id,role,player_id) VALUES($1,$2,$3,'player',$4)", ['synthetic-account-manager', SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'synthetic-player-01']);
    expect((await client.call(matchUrl)).body).toHaveProperty('state');
    const selected = await client.call(matchUrl, { role: 'player' });
    expect(selected.body.audience).toBe('player'); expect(selected.body).not.toHaveProperty('state');
    expect((await client.call(matchUrl, { role: 'spectator' })).status).toBe(404);
    const centre = await client.call(`${teamUrl}/matches`, { role: 'player' });
    expect(JSON.stringify(centre.body)).not.toContain('eventHistory');
  });
  it('serializes the manager cap across independent PostgreSQL pools and refuses child promotion', async () => {
    const a = await start(); const b = await start(a.connectionString, a.directory);
    await a.api.store.execute("UPDATE memberships SET revoked_at=$1 WHERE account_id='synthetic-account-manager-4' AND role='manager'", [at]);
    const results = await Promise.all([
      a.call(`${teamUrl}/managers`, { token: 'synthetic-admin', body: { accountId: 'synthetic-account-manager-5' } }),
      b.call(`${teamUrl}/managers`, { token: 'synthetic-admin', body: { accountId: 'synthetic-account-admin' } }),
    ]);
    expect(results.map(result => result.status).sort()).toEqual([200,409]);
    expect((await a.call(`${teamUrl}/managers`, { token: 'synthetic-admin', body: { accountId: 'synthetic-account-player-01' } })).status).toBe(403);
    const count = await a.api.store.one("SELECT COUNT(DISTINCT account_id)::integer AS count FROM memberships WHERE team_id=$1 AND role='manager' AND revoked_at IS NULL", [SYNTHETIC_IDS.teamId]);
    expect(count?.count).toBe(4);
  });
  it('retains permanent event deduplication, quarantine and controller epochs after process restart', async () => {
    const client = await start();
    const acquired = await client.call(`${matchUrl}/controller`, { body: { deviceId: 'pg-phone-a' } });
    expect(acquired.status).toBe(200); const token = acquired.body.controllerToken as string;
    const downloaded = await client.call(`${matchUrl}/download?deviceId=pg-phone-a`);
    const first = event(downloaded.body.state as MatchState, { type: 'attendance.recorded', playerId: 'synthetic-player-01', status: 'present', actorId: 'forged-account' });
    const key = randomUUID();
    const accepted = await client.call(`${matchUrl}/events`, { body: { events: [first] }, key, controller: token });
    expect(accepted.status).toBe(200);
    expect(await client.call(`${matchUrl}/events`, { body: { events: [first] }, key, controller: token })).toEqual(accepted);
    const state = JSON.parse((await client.api.store.match(SYNTHETIC_IDS.matchId)).state_json) as MatchState;
    expect(state.eventHistory?.at(-1)?.actorId).toBe('synthetic-account-manager');
    const second = event(state, { type: 'attendance.recorded', playerId: 'synthetic-player-02', status: 'present' }, 2, first.eventId);
    second.engineVersion = 'unrecognized-future-engine';
    expect((await client.call(`${matchUrl}/events`, { body: { events: [second] }, controller: token })).status).toBe(409);
    const offered = await client.call(`${matchUrl}/handover`, { body: { toAccountId: 'synthetic-account-manager-2', toDeviceId: 'pg-phone-b', baseRevision: 1 }, controller: token });
    const transferred = await client.call(`${matchUrl}/handover/${offered.body.transferId}/accept`, { token: 'synthetic-manager-2', body: { deviceId: 'pg-phone-b' } });
    expect(transferred.body.epoch).toBe(2);
    const stale = event(state, { type: 'attendance.recorded', playerId: 'synthetic-player-03', status: 'present' }, 3, second.eventId);
    expect((await client.call(`${matchUrl}/events`, { body: { events: [stale] }, controller: token })).status).toBe(409);
    client.api.server.closeAllConnections(); await client.api.close(); running.splice(running.indexOf(client.api), 1);
    const reopened = await start(client.connectionString, client.directory);
    const restored = await reopened.call(`${matchUrl}/download?deviceId=pg-phone-a`);
    expect(restored.body.acceptedRevision).toBe(1); expect(restored.body.deviceCheckpoint).toEqual({ clientSequence: 3, previousEventId: stale.eventId });
    expect((restored.body.controller as { epoch:number }).epoch).toBe(2);
    const rejected = await reopened.call(`${matchUrl}/quarantine`);
    expect(JSON.stringify(rejected.body)).toContain('unrecognized-future-engine'); expect(JSON.stringify(rejected.body)).toContain('STALE_CONTROLLER');
    expect(await reopened.api.store.one('SELECT COUNT(*)::integer AS count FROM events')).toEqual({ count: 3 });
  });
  it('rolls back accepted event, stream, projection and receipt on an actual PostgreSQL trigger failure', async () => {
    const client = await start();
    const acquired = await client.call(`${matchUrl}/controller`, { body: { deviceId: 'pg-phone-a' } });
    const downloaded = await client.call(`${matchUrl}/download?deviceId=pg-phone-a`);
    const first = event(downloaded.body.state as MatchState, { type: 'attendance.recorded', playerId: 'synthetic-player-01', status: 'present' });
    await client.api.store.db.query("CREATE FUNCTION longball.reject_test_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fictional injected failure'; END $$; CREATE TRIGGER reject_test_event BEFORE INSERT ON longball.events FOR EACH ROW EXECUTE FUNCTION longball.reject_test_event()");
    const key = randomUUID(); const controller = acquired.body.controllerToken as string;
    expect((await client.call(`${matchUrl}/events`, { body: { events: [first] }, key, controller })).status).toBe(422);
    expect(await client.api.store.one('SELECT COUNT(*)::integer AS count FROM events')).toEqual({ count: 0 });
    expect(await client.api.store.one('SELECT COUNT(*)::integer AS count FROM streams')).toEqual({ count: 0 });
    expect(await client.api.store.one('SELECT key FROM idempotency WHERE key=$1', [key])).toBeUndefined();
    expect((JSON.parse((await client.api.store.match(SYNTHETIC_IDS.matchId)).state_json) as MatchState).revision).toBe(0);
    await client.api.store.db.query('DROP TRIGGER reject_test_event ON events');
    expect((await client.call(`${matchUrl}/events`, { body: { events: [first] }, key, controller })).status).toBe(200);
  });
  it('creates an assigned new season without source mutation or copied spectator authority, and projects training reports', async () => {
    const client = await start(); let revision=0;
    const baselineReport=await client.call(`${teamUrl}/records`,{token:'synthetic-account-player-01'});
    expect(baselineReport.status).toBe(200);
    const baseline=(baselineReport.body.participation as {rows:{training:{eligibleEventCount:number;attendanceRecordedCount:number;attendedCount:number}}[]}).rows[0].training;
    const prep = async (command:Record<string,unknown>) => { const reply=await client.call(`${teamUrl}/preparation`,{body:{command:{id:randomUUID(),expectedRevision:revision,...command}}}); if(reply.status===200)revision=reply.body.revision as number;return reply; };
    const profileId=`synthetic-player-01:${SYNTHETIC_IDS.seasonId}`;
    expect((await prep({type:'training.saved',training:{id:'pg-training',seasonId:SYNTHETIC_IDS.seasonId,date:'2026-11-02',time:'18:00',venue:'Fictional pitch',recurrenceGroupId:null,expectedProfileIds:[profileId]}})).status).toBe(200);
    expect((await prep({type:'training.status_changed',trainingId:'pg-training',status:'held'})).status).toBe(200);
    expect((await prep({type:'training.attendance_recorded',trainingId:'pg-training',profileId,attendance:'present'})).status).toBe(200);
    const report=await client.call(`${teamUrl}/records`,{token:'synthetic-account-player-01'});
    const reportRow=(report.body.participation as {rows:{training:unknown;trainingRecords:{eventId:string;actualAttendance:string;availabilityResponse:string|null}[]}[]}).rows[0];
    expect(reportRow.training).toMatchObject({eligibleEventCount:baseline.eligibleEventCount+1,attendanceRecordedCount:baseline.attendanceRecordedCount+1,attendedCount:baseline.attendedCount+1});
    expect(reportRow.trainingRecords.find(item=>item.eventId==='pg-training')).toMatchObject({actualAttendance:'present',availabilityResponse:null});
    const before=await client.call(`${teamUrl}/preparation`);
    const command={id:randomUUID(),type:'season.rolled_over',expectedPreparationRevision:revision,idForSeason:'fictional-season-2027-28',startYear:2027,copyPlayers:true,managerAccountIds:['synthetic-account-manager'],administratorAccountIds:['synthetic-account-manager'],playerAssignments:[{accountId:'synthetic-account-player-01',playerId:'synthetic-player-01'}],confirmSpectatorRenewal:true};
    const key=randomUUID();const created=await client.call(`${teamUrl}/seasons`,{key,body:{command}});
    expect(created.status).toBe(200);expect(created.body.spectatorGrantCount).toBe(0);
    expect(await client.call(`${teamUrl}/seasons`,{key,body:{command}})).toEqual(created);
    expect((await client.call(`${teamUrl}/preparation`)).body).toEqual(before.body);
    expect((await client.call(`${teamUrl}/preparation/own?seasonId=fictional-season-2027-28`,{token:'synthetic-account-player-01'})).status).toBe(200);
    expect((await client.call(`${teamUrl}/records?seasonId=fictional-season-2027-28`,{token:'synthetic-spectator'})).status).toBe(404);
    expect((await client.api.store.document<RecordsState>(SYNTHETIC_IDS.teamId,'fictional-season-2027-28','records')).results).toEqual([]);
    const config=await client.call(`${teamUrl}/configuration`,{token:'synthetic-admin'});
    expect(config.status).toBe(200);expect(config.body).not.toHaveProperty('profiles');expect(config.body).not.toHaveProperty('training');
    expect((await client.call(`${teamUrl}/records`,{token:'synthetic-admin'})).status).toBe(404);
  });
  it('exports filtered own evidence and keeps missing provider activation fail closed on PostgreSQL', async () => {
    const client=await start();
    const exported=await client.call(`${teamUrl}/records/export?kind=season&format=json`,{token:'synthetic-account-player-01'});
    expect(exported.status).toBe(200);expect(exported.body.kind).toBe('records-export');
    expect(exported.body.body).toContain('synthetic-player-01');expect(exported.body.body).not.toContain('synthetic-player-02');expect(exported.body.body).not.toContain('editableState');
    const stale=await client.call(`${teamUrl}/records/export?kind=season&format=json&expectedProjectionVersion=999`);
    expect(stale.status).toBe(409);
    const activation=await client.call(`${teamUrl}/activation/pending-child`,{body:{playerId:'synthetic-player-01'}});
    expect(activation.status).toBe(503);expect(activation.body.code).toBe('ACTIVATION_NOT_CONFIGURED');
    const forged=await client.call(`${teamUrl}/community`,{body:{command:{type:'match.registered',id:randomUUID(),sharing:'fictional_review_only',finishQuality:'trusted'}}});
    expect(forged.status).toBe(503);expect(forged.body.code).toBe('POLICY_APPROVAL_REQUIRED');
  });
});
