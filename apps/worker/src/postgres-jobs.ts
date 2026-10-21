import { finalizeDueCommunityAwards, type CommunityState } from '../../../packages/application/src/community';
import type { PostgresStore } from '../../api/src/postgres-store';

interface Job { id: string; kind: string; payload_json: string; attempts: number }
/** Actual PostgreSQL leases are durable across worker processes and business effects commit with completion. */
export async function runDuePostgresJobs(store: PostgresStore, nowMs = Date.now(), maximum = 20): Promise<{ completed: number; retried: number; failed: number }> {
  const result = { completed: 0, retried: 0, failed: 0 };
  for (let count=0; count<maximum; count++) {
    const job = await store.transaction(async () => {
      const found = await store.one("SELECT id,kind,payload_json,attempts FROM jobs WHERE kind='award.finalise' AND ((state='pending' AND due_at<=$1) OR (state='leased' AND lease_until<=$1)) ORDER BY due_at,id FOR UPDATE SKIP LOCKED LIMIT 1", [nowMs]) as unknown as Job | undefined;
      if (!found) return null;
      await store.execute("UPDATE jobs SET state='leased',attempts=attempts+1,lease_until=$1 WHERE id=$2", [nowMs+30_000, found.id]);
      return { ...found, attempts: found.attempts+1 };
    });
    if (!job) break;
    try {
      await store.transaction(async () => {
        const lease = await store.one('SELECT state,attempts FROM jobs WHERE id=$1 FOR UPDATE', [job.id]);
        if (!lease || lease.state !== 'leased' || lease.attempts !== job.attempts) throw new Error('LEASE_SUPERSEDED');
        if (job.kind !== 'award.finalise') throw new Error('UNSUPPORTED_JOB');
        const payload = JSON.parse(job.payload_json) as { teamId:string;seasonId:string;matchId:string };
        const state = await store.document<CommunityState>(payload.teamId,payload.seasonId,'community');
        const match = state.matches.find(item=>item.id===payload.matchId);
        if (!match || match.voteCutoffAtMs===null || match.finishQuality!=='trusted') throw new Error('AWARD_REVIEW_REQUIRED');
        const next = finalizeDueCommunityAwards(state,nowMs);
        if (!next.awards.some(award=>award.matchId===payload.matchId)) throw new Error('AWARD_NOT_DUE_OR_UNRESOLVED');
        await store.saveDocument(payload.teamId,payload.seasonId,'community',next);
        for(const award of next.awards.filter(award=>!state.awards.some(previous=>previous.matchId===award.matchId)))await store.enqueueNotifications(payload.teamId,payload.seasonId,'awards',award.matchId,`award-finalised-${award.matchId}-${award.voteCutoffAtMs}`);
        await store.execute("UPDATE jobs SET state='completed',lease_until=NULL,last_error_code=NULL WHERE id=$1 AND attempts=$2",[job.id,job.attempts]);
      });
      result.completed++;
    } catch {
      const terminal = job.attempts>=3;
      await store.transaction(()=>store.execute("UPDATE jobs SET state=$1,due_at=$2,lease_until=NULL,last_error_code='JOB_REQUIRES_REVIEW' WHERE id=$3 AND state='leased' AND attempts=$4",[terminal?'failed':'pending',nowMs+Math.min(60_000,1_000*2**job.attempts),job.id,job.attempts]));
      if (terminal) result.failed++; else result.retried++;
    }
  }
  return result;
}
