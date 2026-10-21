import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommunityState } from '../../../packages/application/src/community';
import { DevelopmentStore, SYNTHETIC_IDS } from '../../api/src/store';
import { runDueJobs } from './jobs';

const stores: DevelopmentStore[] = [];
const directories: string[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function setup() {
  let clock = 1_800_000_000_000;
  const directory = mkdtempSync(join(tmpdir(), 'longball-jobs-test-')); directories.push(directory);
  const store = new DevelopmentStore(join(directory, 'jobs.sqlite'), () => clock); stores.push(store); store.seedSynthetic();
  const identity = (accountId: string, adult = false) => store.principal({ issuer: 'urn:longball:synthetic', subject: accountId, strongAuth: adult, authenticatedAt: clock });
  const manager = identity('synthetic-account-manager', true);
  const community = () => store.document<CommunityState>(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'community');
  return { store, community, manager, identity, get now() { return clock; }, setTime(value: number) { clock = value; } };
}
describe('durable award deadline worker', () => {
  it('does not schedule the unapproved +59 proposal automatically', () => {
    const test = setup();
    expect(test.community().matches[0].voteCutoffAtMs).toBeNull();
    expect(test.store.database.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual({ n: 0 });
    expect(runDueJobs(test.store, test.now)).toEqual({ completed: 0, retried: 0, failed: 0 });
  });
  it('seals private latest ballots once, publishes tied winners by the unchanged +60 deadline and records a service actor', () => {
    const test = setup(); const scope = SYNTHETIC_IDS;
    const state = test.community(); state.matches[0].sharing = 'fictional_review_only';
    test.store.transaction(() => test.store.saveDocument(scope.teamId, scope.seasonId, 'community', state));
    test.store.transaction(() => test.store.communityCommand(test.manager, scope.teamId, scope.seasonId, { id: randomUUID(), type: 'award.cutoffConfigured', matchId: state.matches[0].id, minutesAfterFullTime: 59 }));
    for (const [voter, candidate] of [['01', '02'], ['02', '01']]) {
      const principal = test.identity(`synthetic-account-player-${voter}`);
      test.store.transaction(() => test.store.communityCommand(principal, scope.teamId, scope.seasonId, { id: randomUUID(), type: 'ballot.cast', matchId: state.matches[0].id, candidatePlayerId: `synthetic-player-${candidate}` }, 'player'));
    }
    const cutoff = test.community().matches[0].voteCutoffAtMs!;
    expect(runDueJobs(test.store, cutoff - 1).completed).toBe(0);
    test.setTime(cutoff + 30_000);
    expect(runDueJobs(test.store, test.now).completed).toBe(1);
    expect(test.community().awards[0]).toMatchObject({ winnerPlayerIds: ['synthetic-player-01', 'synthetic-player-02'], voteCutoffAtMs: cutoff, deadlineMissed: false });
    expect(test.community().awards[0].finalisationDeadlineAtMs).toBe(state.matches[0].actualFullTimeAtMs! + 3_600_000);
    const sealed = JSON.stringify(test.community().awards);
    expect(runDueJobs(test.store, test.now + 10_000).completed).toBe(0);
    expect(JSON.stringify(test.community().awards)).toBe(sealed);
    expect(test.community().audit.at(-1)).toMatchObject({ actorAccountId: null, origin: 'award_worker' });
    expect(test.store.community(test.manager, scope.teamId, scope.seasonId)).not.toHaveProperty('ballots');
  });
  it('reports a missed deadline instead of moving cutoff/full-time to worker receipt', () => {
    const test = setup(); const state = test.community(); const match = state.matches[0];
    test.store.transaction(() => test.store.communityCommand(test.manager, SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, { id: randomUUID(), type: 'award.cutoffConfigured', matchId: match.id, minutesAfterFullTime: 59 }));
    const originalCutoff = test.community().matches[0].voteCutoffAtMs!;
    test.setTime(match.actualFullTimeAtMs! + 3_600_001);
    expect(runDueJobs(test.store, test.now).completed).toBe(1);
    expect(test.community().awards[0]).toMatchObject({ voteCutoffAtMs: originalCutoff, finalisationDeadlineAtMs: match.actualFullTimeAtMs! + 3_600_000, finalisedAtMs: test.now, deadlineMissed: true });
  });
  it('recovers an expired lease and retains bounded failed jobs for review', () => {
    const test = setup();
    test.store.database.prepare('INSERT INTO jobs(id,business_key,kind,payload_json,due_at,state,attempts,lease_until) VALUES(?,?,?,?,?,?,?,?)').run('unknown-job', 'unknown-business', 'award.finalise', '{}', test.now - 1, 'leased', 0, test.now - 1);
    expect(runDueJobs(test.store, test.now)).toEqual({ completed: 0, retried: 1, failed: 0 });
    test.setTime(test.now + 10_000); expect(runDueJobs(test.store, test.now).retried).toBe(1);
    test.setTime(test.now + 10_000); expect(runDueJobs(test.store, test.now).failed).toBe(1);
    expect(test.store.database.prepare('SELECT state,attempts,last_error_code FROM jobs WHERE id=?').get('unknown-job')).toEqual({ state: 'failed', attempts: 3, last_error_code: 'JOB_REQUIRES_REVIEW' });
  });
});
