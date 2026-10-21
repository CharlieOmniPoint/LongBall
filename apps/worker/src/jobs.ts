import { finalizeDueCommunityAwards, type CommunityState } from '../../../packages/application/src/community';
import type { DevelopmentStore } from '../../api/src/store';

interface Job { id: string; kind: string; payload_json: string; attempts: number }
/** Durable lease + idempotent business key. Runs locally against the development SQLite queue. */
export function runDueJobs(store: DevelopmentStore, nowMs = Date.now(), maximum = 20): { completed: number; retried: number; failed: number } {
  const result = { completed: 0, retried: 0, failed: 0 };
  for (let number = 0; number < maximum; number++) {
    const job = store.transaction(() => {
      const found = store.database.prepare("SELECT id,kind,payload_json,attempts FROM jobs WHERE kind='award.finalise' AND ((state='pending' AND due_at<=?) OR (state='leased' AND lease_until<=?)) ORDER BY due_at,id LIMIT 1").get(nowMs, nowMs) as Job | undefined;
      if (!found) return null;
      store.database.prepare("UPDATE jobs SET state='leased',attempts=attempts+1,lease_until=? WHERE id=?").run(nowMs + 30_000, found.id);
      return { ...found, attempts: found.attempts + 1 };
    });
    if (!job) break;
    try {
      store.transaction(() => {
        if (job.kind !== 'award.finalise') throw new Error('UNSUPPORTED_JOB');
        const payload = JSON.parse(job.payload_json) as { teamId: string; seasonId: string; matchId: string };
        const state = store.document<CommunityState>(payload.teamId, payload.seasonId, 'community');
        const match = state.matches.find(item => item.id === payload.matchId);
        if (!match || match.voteCutoffAtMs === null || match.finishQuality !== 'trusted') throw new Error('AWARD_REVIEW_REQUIRED');
        const next = finalizeDueCommunityAwards(state, nowMs);
        store.saveDocument(payload.teamId, payload.seasonId, 'community', next);
        for(const award of next.awards.filter(award=>!state.awards.some(previous=>previous.matchId===award.matchId)))store.enqueueNotifications(payload.teamId,payload.seasonId,'awards',award.matchId,`award-finalised-${award.matchId}-${award.voteCutoffAtMs}`);
        if (!next.awards.some(award => award.matchId === payload.matchId)) throw new Error('AWARD_NOT_DUE_OR_UNRESOLVED');
        store.database.prepare("UPDATE jobs SET state='completed',lease_until=NULL,last_error_code=NULL WHERE id=?").run(job.id);
      });
      result.completed += 1;
    } catch {
      const terminal = job.attempts >= 3;
      store.transaction(() => store.database.prepare('UPDATE jobs SET state=?,due_at=?,lease_until=NULL,last_error_code=? WHERE id=?').run(terminal ? 'failed' : 'pending', nowMs + Math.min(60_000, 1_000 * 2 ** job.attempts), 'JOB_REQUIRES_REVIEW', job.id));
      if (terminal) result.failed += 1; else result.retried += 1;
    }
  }
  return result;
}
