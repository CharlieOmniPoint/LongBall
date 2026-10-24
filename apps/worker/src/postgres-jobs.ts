import { finalizeDueCommunityAwards, type CommunityState } from '../../../packages/application/src/community';
import type { PostgresStore } from '../../api/src/postgres-store';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

interface Job { id: string; kind: string; payload_json: string; attempts: number;club_id:string;team_id:string;season_id:string;lease_until:number }
/** Actual PostgreSQL leases are durable across worker processes and business effects commit with completion. */
export async function runDuePostgresJobs(store: PostgresStore, nowMs = Date.now(), maximum = 20): Promise<{ completed: number; retried: number; failed: number }> {
  const result = { completed: 0, retried: 0, failed: 0 };
  const began=performance.now();
  const databaseNow=async()=>{
    const row=await store.one('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms');
    if(typeof row?.now_ms!=='number'||!Number.isSafeInteger(row.now_ms)||row.now_ms<0)throw new Error('DATABASE_CLOCK_UNAVAILABLE');
    return row.now_ms;
  };
  for (let count=0; count<maximum; count++) {
    const capability=randomBytes(32).toString('hex');
    const observation=Math.floor(nowMs+performance.now()-began);
    const job=await store.db.withContext({kind:'worker_claim',jobKind:'award.finalise',nowMs:observation},()=>store.one('SELECT * FROM longball.claim_due_job($1,$2,$3)',['award.finalise',observation,capability])) as unknown as Job|undefined;
    if (!job) break;
    const claimedAt=performance.now(),claimedDatabaseAt=job.lease_until-30_000;
    const context=()=>({kind:'worker_job' as const,jobId:job.id,leaseToken:capability,clubId:job.club_id,teamId:job.team_id,seasonId:job.season_id,nowMs:Math.floor(claimedDatabaseAt+performance.now()-claimedAt)});
    const attempt=await store.db.withContext(context(),()=>store.transaction(()=>store.one("UPDATE jobs SET attempts=attempts+1 WHERE id=$1 AND state='leased' AND attempts=$2 RETURNING attempts",[job.id,job.attempts])));
    if(!attempt)continue;
    job.attempts=Number(attempt.attempts);
    try {
      await store.db.withContext(context(),()=>store.transaction(async () => {
        const lease = await store.one('SELECT state,attempts FROM jobs WHERE id=$1 FOR UPDATE', [job.id]);
        if (!lease || lease.state !== 'leased' || lease.attempts !== job.attempts) throw new Error('LEASE_SUPERSEDED');
        if (job.kind !== 'award.finalise') throw new Error('UNSUPPORTED_JOB');
        const payload = JSON.parse(job.payload_json) as { teamId:string;seasonId:string;matchId:string };
        if(payload.teamId!==job.team_id||payload.seasonId!==job.season_id)throw new Error('JOB_SCOPE_CONFLICT');
        const state = await store.document<CommunityState>(payload.teamId,payload.seasonId,'community');
        const match = state.matches.find(item=>item.id===payload.matchId);
        if (!match || match.voteCutoffAtMs===null || match.finishQuality!=='trusted') throw new Error('AWARD_REVIEW_REQUIRED');
        // The claim observation is bounded input, never authority for award/deadline timestamps.
        const scoped=finalizeDueCommunityAwards({...state,matches:[match]},await databaseNow());
        const next={...scoped,matches:state.matches};
        if (!next.awards.some(award=>award.matchId===payload.matchId)) throw new Error('AWARD_NOT_DUE_OR_UNRESOLVED');
        await store.saveDocument(payload.teamId,payload.seasonId,'community',next);
        for(const award of next.awards.filter(award=>!state.awards.some(previous=>previous.matchId===award.matchId)))await store.enqueueNotifications(payload.teamId,payload.seasonId,'awards',award.matchId,`award-finalised-${award.matchId}-${award.voteCutoffAtMs}`);
        const completed=await store.execute("UPDATE jobs SET state='completed',lease_until=NULL,last_error_code=NULL WHERE id=$1 AND state='leased' AND attempts=$2",[job.id,job.attempts]);
        if(completed.changes!==1)throw new Error('LEASE_SUPERSEDED');
      }));
      result.completed++;
    } catch {
      const terminal = job.attempts>=3;
      const settled=await store.db.withContext(context(),()=>store.transaction(async()=>store.execute("UPDATE jobs SET state=$1,due_at=$2,lease_until=NULL,last_error_code='JOB_REQUIRES_REVIEW' WHERE id=$3 AND state='leased' AND attempts=$4",[terminal?'failed':'pending',(await databaseNow())+Math.min(60_000,1_000*2**job.attempts),job.id,job.attempts])));
      if(settled.changes){if (terminal) result.failed++; else result.retried++;}
    }
  }
  return result;
}
