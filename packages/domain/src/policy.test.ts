import { describe, expect, it } from 'vitest';
import { calculateTargets, createMatch, playerMinutes, rationalToNumber, readClock, reduceMatch, replayMatch, type Allocation, type ClockSample, type MatchConfig, type MatchEvent, type MatchPolicyProposal, type MatchState } from './index';
import { makePolicyChangeCommand } from '../../application/src/match-policy';
import { assertParticipationConservation } from '../../application/src/reconciliation';

const config: MatchConfig = { matchId: 'policy-match', players: Array.from({length:9},(_,i)=>({id:`p${i+1}`,displayName:`Player ${i+1}`,goalkeeperChoice:i===0?1:0})), selectedPlayerIds: Array.from({length:9},(_,i)=>`p${i+1}`), pitchPlaces:7, plannedHalfDurationMs:1_500_000, fixedKeeperId:'p1' };
const lineup: Allocation[] = config.selectedPlayerIds.slice(0,7).map((playerId,i)=>({playerId,slotId:`slot-${i}`,position:i===0?'GK':'CM'}));
const sample=(ms=0):ClockSample=>({monotonicMs:ms,sessionId:'continuous-policy-session',wallTimeMs:1_800_000_000_000+ms});
const settings={batchPreference:2,leadThreshold:2,returnToNormal:false};
let serial=0;
function send(state:MatchState, command:Omit<MatchEvent,'id'|'sample'>, ms=0):MatchState { return reduceMatch(state,{...command,id:`policy-${++serial}`,sample:sample(ms)} as MatchEvent); }
function started():MatchState {
  let state=createMatch(config);
  for(const playerId of config.selectedPlayerIds)state=send(state,{type:'attendance.recorded',playerId,status:'present'} as Omit<MatchEvent,'id'|'sample'>);
  state=send(state,{type:'lineup.staged',lineup} as Omit<MatchEvent,'id'|'sample'>);
  return send(state,{type:'half.started'});
}
function change(state:MatchState,ms:number,changes:Partial<typeof settings>={}) { return makePolicyChangeCommand(state,sample(ms),{...settings,...changes},'Manager explicitly reviewed future planning preferences.'); }

describe('EV05 prospective match policy',()=>{
  it('keeps prepared policy and lineup proposals inactive without inferring RSVP, attendance or confirmation',()=>{
    const base=createMatch(config), command=change(base,0);
    const proposal:MatchPolicyProposal={payload:command.payload,applicability:command.applicability,softPreferences:command.softPreferences};
    const state=createMatch({...config,initialPolicyProposal:proposal,initialLineupProposal:lineup});
    expect(state.activePolicy).toBeUndefined();expect(state.policyHistory).toBeUndefined();expect(state.stagedLineup).toEqual([]);expect(state.lineup).toEqual([]);
    expect(Object.values(state.attendance)).toEqual(Array(9).fill('not_recorded'));
    expect(state.config.initialPolicyProposal).toEqual(proposal);expect(state.config.initialLineupProposal).toEqual(lineup);
    expect(()=>createMatch({...config,initialLineupProposal:lineup.map(row=>({...row,playerId:'p1'}))})).toThrow('distinct');
  });
  it('records a versioned source, reason and preparation boundary, with soft semantics and no active-time accrual',()=>{
    const prior=createMatch(config), command=change(prior,0);
    const state=send(prior,command);
    expect(state.activePolicy).toMatchObject({policyVersion:1,previousPolicyVersion:0,sourceRevision:0,revision:1,payload:{minimumStintMs:300_000,batchLimit:2},applicability:{minimumStint:'soft_preference',batchLimit:'soft_preference',q07:'unapproved'},effective:{half:0,halfElapsedMs:0,matchElapsedMs:0}});
    expect(state.audit?.at(-1)).toMatchObject({type:'policy.changed',reason:command.reason,priorValue:null,effective:null});
    expect(state.matchActiveMs).toBe(0);expect(state.intervals).toEqual([]);expect(state.targetIntervals).toEqual([]);
    expect(prior.activePolicy).toBeUndefined();
  });
  it('closes old-policy time first and applies a captured policy only to the subsequent uncommitted suffix',()=>{
    let state=started();state=send(state,{type:'goal.recorded',beneficiary:'us'} as Omit<MatchEvent,'id'|'sample'>,10_000);
    const prior=state, prefix=JSON.stringify({intervals:prior.intervals,targets:prior.targetIntervals,goals:prior.goals,config:prior.config});
    const command=change(prior,15_000);
    state=send(prior,command,18_000);
    expect(JSON.stringify({intervals:prior.intervals,targets:prior.targetIntervals,goals:prior.goals,config:prior.config})).toBe(prefix);
    expect(state.intervals.slice(0,prior.intervals.length)).toEqual(prior.intervals);
    expect(state.targetIntervals.slice(0,prior.targetIntervals.length)).toEqual(prior.targetIntervals);
    expect(state.targetIntervals.slice(-2)).toEqual([{durationMs:5000,availablePlayerIds:config.selectedPlayerIds,pitchPlaces:7,fixedKeeperId:'p1'},{durationMs:3000,availablePlayerIds:config.selectedPlayerIds,pitchPlaces:7,fixedKeeperId:'p1',policyVersion:1}]);
    expect(state.audit?.at(-1)?.effective).toEqual(command.effective);
    expect(state.goals).toEqual(prior.goals);expect(state.lineup).toEqual(prior.lineup);expect(state.config).toEqual(prior.config);
    const targets=calculateTargets(state.targetIntervals,state.config.selectedPlayerIds);
    expect(rationalToNumber(targets.find(target=>target.playerId==='p1')!.target)).toBe(18_000);
    expect(rationalToNumber(targets.find(target=>target.playerId==='p2')!.target)).toBe(13_500);
    expect(targets.reduce((sum,target)=>sum+rationalToNumber(target.target),0)).toBe(18_000*7);
    expect(playerMinutes(state,sample(18_000)).find(player=>player.playerId==='p2')?.playingMs).toBe(18_000);
    assertParticipationConservation(state);
  });
  it('rejects stale source/version, backdated committed history, invented future time and clock uncertainty without changing the original',()=>{
    const state=send(started(),{type:'half.paused'},10_000), before=JSON.stringify(state);
    const command=change(state,10_000);
    for(const mutation of [{sourceRevision:state.revision-1},{policyVersion:7},{previousPolicyVersion:3},{effective:{half:1,halfElapsedMs:9_000,matchElapsedMs:9_000}},{effective:{half:1,halfElapsedMs:11_000,matchElapsedMs:11_000}},{effective:{half:2,halfElapsedMs:0,matchElapsedMs:10_000}}])expect(()=>send(state,{...command,...mutation} as Omit<MatchEvent,'id'|'sample'>,10_000)).toThrow();
    const resumed=send(state,{type:'half.resumed'},10_000);
    const uncertain=send(resumed,{type:'clock.recovery_required',reason:'Unverified clock boundary.'} as Omit<MatchEvent,'id'|'sample'>,10_000);
    expect(()=>change(uncertain,10_000)).toThrow('clock');expect(JSON.stringify(state)).toBe(before);
  });
  it('cannot turn soft preferences into hard constraints or gain a Q07 keeper exemption',()=>{
    const state=started(), command=change(state,0), before=JSON.stringify(state);
    expect(()=>send(state,{...command,applicability:{...command.applicability,batchLimit:'hard_limit'}} as unknown as Omit<MatchEvent,'id'|'sample'>)).toThrow('soft');
    expect(()=>send(state,{...command,payload:{...command.payload,keeperMode:'common_pool',fixedKeeperPlayerSeasonId:null}} as Omit<MatchEvent,'id'|'sample'>)).toThrow('Q07');
    expect(()=>send(state,{...command,applicability:{...command.applicability,q07:'accepted'}} as unknown as Omit<MatchEvent,'id'|'sample'>)).toThrow('Q07');
    expect(JSON.stringify(state)).toBe(before);
  });
  it('replays sticky score mode and explicit manual reset without relying on another device cache',()=>{
    let state=started();state=send(state,change(state,0));
    state=send(state,{type:'goal.recorded',beneficiary:'us'} as Omit<MatchEvent,'id'|'sample'>,1000);
    state=send(state,{type:'goal.recorded',beneficiary:'us'} as Omit<MatchEvent,'id'|'sample'>,2000);
    expect(state.activePolicy?.positionMode).toBe('adventurous');
    state=send(state,{type:'goal.recorded',beneficiary:'opposition'} as Omit<MatchEvent,'id'|'sample'>,3000);
    expect(state.activePolicy?.positionMode).toBe('adventurous');
    expect(replayMatch(state.config,state.eventHistory!)).toEqual(state);
    const old=state.policyHistory![0];
    state=send(state,makePolicyChangeCommand(state,sample(3000),settings,'Manager deliberately reset future position suggestions.',true),3000);
    expect(state.activePolicy?.positionMode).toBe('normal');expect(state.policyHistory![0]).toEqual(old);
    expect(replayMatch(state.config,state.eventHistory!)).toEqual(state);
  });
  it('is exactly idempotent and rejects reusing the event identity with altered policy content',()=>{
    const prior=started(), command=change(prior,0), event={...command,id:'same-policy-event',sample:sample()};
    const next=reduceMatch(prior,event);
    expect(reduceMatch(next,event)).toBe(next);
    expect(()=>reduceMatch(next,{...event,reason:'Changed retry contents are not the original event.'})).toThrow('different content');
    expect(next.policyHistory).toHaveLength(1);
  });
  it('retains policy boundaries and versions when an authorised historical availability correction reprojects targets',()=>{
    let state=started();
    state=send(state,{type:'availability.changed',playerId:'p9',available:false,reason:'departure'} as Omit<MatchEvent,'id'|'sample'>,1000);
    const departure=state.eventHistory!.at(-1)!;
    state=send(state,change(state,2000),2000);
    state=send(state,{type:'half.paused'},4000);
    const history=JSON.stringify(state.policyHistory), targetsBefore=state.targetIntervals;
    state=send(state,{type:'event.corrected',targetEventId:departure.id,sourceRevision:state.revision,reason:'Verified recorded departure was five hundred milliseconds later.',replacement:{type:'availability.changed',playerId:'p9',available:false,reason:'departure',effective:{half:1,halfElapsedMs:1500,matchElapsedMs:1500}}} as Omit<MatchEvent,'id'|'sample'>,4000);
    expect(state.targetIntervals.map(interval=>[interval.durationMs,interval.policyVersion??null])).toEqual([[1500,null],[500,null],[2000,1]]);
    expect(state.targetIntervals.at(-1)).toEqual(targetsBefore.at(-1));expect(JSON.stringify(state.policyHistory)).toBe(history);
    assertParticipationConservation(state);
  });
  it('keeps half-time policy changes at zero additional active time and preserves the independent second half',()=>{
    let state=send(started(),{type:'half.ended'},1_600_000), history=JSON.stringify(state.targetIntervals);
    state=send(state,change(state,1_800_000),1_800_000);
    expect(state.matchActiveMs).toBe(1_600_000);expect(JSON.stringify(state.targetIntervals)).toBe(history);
    state=send(state,{type:'half.started'},1_900_000);
    expect(readClock(state,sample(1_900_000)).remainingMs).toBe(1_500_000);
    state=send(state,{type:'half.ended'},3_400_000);
    expect(()=>change(state,3_400_000)).toThrow('Completed');
    expect(state.policyHistory).toHaveLength(1);
  });
});
