import { randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Principal } from '../../../packages/application/src/access';
import { authorizeCommunityMedia, defaultCommunityPreferences, getCommunityView, type CommunityActor, type CommunityState } from '../../../packages/application/src/community';
import type { PreparationState } from '../../../packages/application/src/preparation';
import { claimTeamNotificationJob, createTeamNotificationJob, dispatchClaimedTeamNotification, validateTeamNotificationJob, type TeamNotificationEvidence, type TeamNotificationJob, type TeamNotificationProvider } from '../../../packages/application/src/team-notifications';
import { DevelopmentStore } from '../../api/src/store';
import { PostgresStore } from '../../api/src/postgres-store';
import type { PgApplicationContext } from '../../api/src/pg';

type Store = DevelopmentStore | PostgresStore;
interface JobRow { id: string; kind: string; business_key: string; payload_json: string; state: string; attempts: number; lease_until: number | null }
interface ScopedJobRow extends JobRow { club_id: string; team_id: string; season_id: string }
type JobContext = Extract<PgApplicationContext, { kind: 'worker_job' }>;
interface ClaimedJob { job: TeamNotificationJob | null; reviewed: boolean; context?: JobContext }
const KIND = 'notification.dispatch';
const decode = (row: JobRow): TeamNotificationJob => { const job = JSON.parse(row.payload_json) as TeamNotificationJob; validateTeamNotificationJob(job); if (row.id !== job.id || row.business_key !== job.businessKey || row.kind !== KIND) throw new Error('NOTIFICATION_SCOPE_CONFLICT'); return job; };
const outerState = (job: TeamNotificationJob) => job.state === 'provider_accepted' ? 'completed' : job.state;
function identity(job: TeamNotificationJob): string { return JSON.stringify([job.businessKey, job.accountId, job.teamId, job.seasonId, job.audience, job.playerId, job.category, job.entityId]); }
function duplicate(row: JobRow, job: TeamNotificationJob) {
  if (identity(decode(row)) !== identity(job)) throw new Error('NOTIFICATION_KEY_CONFLICT');
  return { duplicate: true, id: row.id };
}
/** Call from the same domain transaction as the triggering change. A business key never creates two jobs. */
export async function enqueueTeamNotification(store: Store, job: TeamNotificationJob): Promise<{ duplicate: boolean; id: string }> {
  validateTeamNotificationJob(job);
  if (job.state !== 'pending' || job.revision !== 0 || job.attempts !== 0) throw new Error('NOTIFICATION_INITIAL_STATE_REQUIRED');
  if (store instanceof PostgresStore) return store.transaction(async () => {
    const found = await store.one('SELECT id,kind,business_key,payload_json,state,attempts,lease_until FROM jobs WHERE business_key=$1', [job.businessKey]) as unknown as JobRow | undefined;
    if (found) return duplicate(found, job);
    const inserted = await store.execute('INSERT INTO jobs(id,business_key,kind,payload_json,due_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(business_key) DO NOTHING', [job.id, job.businessKey, KIND, JSON.stringify(job), job.dueAtMs]);
    if (!inserted.changes) return duplicate((await store.one('SELECT id,kind,business_key,payload_json,state,attempts,lease_until FROM jobs WHERE business_key=$1', [job.businessKey])) as unknown as JobRow, job);
    return { duplicate: false, id: job.id };
  });
  return store.transaction(() => {
    const found = store.database.prepare('SELECT id,kind,business_key,payload_json,state,attempts,lease_until FROM jobs WHERE business_key=?').get(job.businessKey) as JobRow | undefined;
    if (found) return duplicate(found, job);
    store.database.prepare('INSERT INTO jobs(id,business_key,kind,payload_json,due_at) VALUES(?,?,?,?,?)').run(job.id, job.businessKey, KIND, JSON.stringify(job), job.dueAtMs);
    return { duplicate: false, id: job.id };
  });
}
async function readRow(store: Store, id: string): Promise<JobRow | undefined> {
  return store instanceof PostgresStore
    ? await store.one('SELECT id,kind,business_key,payload_json,state,attempts,lease_until FROM jobs WHERE id=$1', [id]) as unknown as JobRow | undefined
    : store.database.prepare('SELECT id,kind,business_key,payload_json,state,attempts,lease_until FROM jobs WHERE id=?').get(id) as JobRow | undefined;
}
function owns(row: JobRow | undefined, job: TeamNotificationJob, nowMs: number): boolean {
  if (!row || row.state !== 'leased' || row.attempts !== job.attempts || row.lease_until === null || row.lease_until <= nowMs) return false;
  const saved = decode(row);
  return saved.revision === job.revision && saved.lease?.attemptId === job.lease?.attemptId;
}
function expiredNeedsReview(job: TeamNotificationJob, provider: TeamNotificationProvider | null): boolean { return job.state === 'leased' && (!provider?.configured || provider.idempotency !== 'provider' || job.attempts >= 6); }
function reviewExpired(job: TeamNotificationJob): TeamNotificationJob { return { ...job, revision: job.revision + 1, state: 'review_required', lease: null, lastCode: 'LEASE_EXPIRED_OUTCOME_UNKNOWN' }; }
async function inJobContext<T>(store: Store, context: JobContext | undefined, nowMs: number, work: () => Promise<T>): Promise<T> {
  if (!(store instanceof PostgresStore)) return work();
  if (!context) throw new Error('NOTIFICATION_JOB_CAPABILITY_REQUIRED');
  return store.db.withContext({ ...context, nowMs: Math.max(context.nowMs, nowMs) }, work);
}
async function claimNext(store: Store, nowMs: number, provider: TeamNotificationProvider | null): Promise<ClaimedJob> {
  if (store instanceof PostgresStore) {
    const capability = randomBytes(32).toString('hex');
    // The claim context cannot read jobs or recipient data. Only this protected function
    // chooses a due row and grants its exact, expiring capability from stored ancestry.
    const row = await store.db.withContext({ kind: 'worker_claim', jobKind: KIND, nowMs }, () => store.one('SELECT * FROM longball.claim_due_job($1,$2,$3)', [KIND, nowMs, capability])) as unknown as ScopedJobRow | undefined;
    if (!row) return { job: null, reviewed: false };
    const prior = decode(row);
    if (![row.club_id, row.team_id, row.season_id].every(value => typeof value === 'string' && value.length > 0) || row.team_id !== prior.teamId || row.season_id !== prior.seasonId || !Number.isSafeInteger(row.lease_until) || row.lease_until! <= nowMs) throw new Error('NOTIFICATION_SCOPE_CONFLICT');
    // The database alone chooses claim time and the 30-second lease. An observed
    // application clock must never advance either boundary.
    const claimedAt = row.lease_until! - 30_000;
    const context: JobContext = { kind: 'worker_job', jobId: row.id, leaseToken: capability, clubId: row.club_id, teamId: row.team_id, seasonId: row.season_id, nowMs: claimedAt };
    return inJobContext(store, context, claimedAt, () => store.transaction(async () => {
      // The SQL function changes the outer lease only. Inspect the original payload
      // to distinguish a fresh pending job from a crashed previous provider call.
      const reviewed = expiredNeedsReview(prior, provider);
      const next = reviewed ? reviewExpired(prior) : claimTeamNotificationJob(prior, randomUUID(), claimedAt);
      if (!next) throw new Error('NOTIFICATION_QUEUE_STATE_CONFLICT');
      if (next.lease) next.lease.untilMs = row.lease_until!;
      const changed = await store.execute('UPDATE jobs SET payload_json=$1,state=$2,attempts=$3,lease_until=$4,last_error_code=$5 WHERE id=$6 AND state=\'leased\' AND attempts=$7 AND lease_until=$8', [JSON.stringify(next), outerState(next), next.attempts, next.lease?.untilMs ?? null, next.lastCode, next.id, prior.attempts, row.lease_until]);
      if (!changed.changes) return { job: null, reviewed: false };
      return { job: reviewed ? null : next, reviewed, context };
    }));
  }
  return store.transaction(() => {
    const row = store.database.prepare("SELECT id,kind,business_key,payload_json,state,attempts,lease_until FROM jobs WHERE kind=? AND ((state='pending' AND due_at<=?) OR (state='leased' AND lease_until<=?)) ORDER BY due_at,id LIMIT 1").get(KIND, nowMs, nowMs) as JobRow | undefined;
    if (!row) return { job: null, reviewed: false };
    const prior = decode(row), reviewed = expiredNeedsReview(prior, provider);
    const next = reviewed ? reviewExpired(prior) : claimTeamNotificationJob(prior, randomUUID(), nowMs);
    if (!next) throw new Error('NOTIFICATION_QUEUE_STATE_CONFLICT');
    store.database.prepare('UPDATE jobs SET payload_json=?,state=?,attempts=?,lease_until=?,last_error_code=? WHERE id=?').run(JSON.stringify(next), outerState(next), next.attempts, next.lease?.untilMs ?? null, next.lastCode, next.id);
    return { job: reviewed ? null : next, reviewed };
  });
}
async function commit(store: Store, leased: TeamNotificationJob, next: TeamNotificationJob, nowMs: number): Promise<boolean> {
  validateTeamNotificationJob(next);
  if (store instanceof PostgresStore) return store.transaction(async () => {
    const row = await store.one('SELECT id,kind,business_key,payload_json,state,attempts,lease_until FROM jobs WHERE id=$1 FOR UPDATE', [leased.id]) as unknown as JobRow | undefined;
    if (!owns(row, leased, nowMs)) return false;
    const updated = await store.execute('UPDATE jobs SET payload_json=$1,state=$2,due_at=$3,attempts=$4,lease_until=NULL,last_error_code=$5 WHERE id=$6', [JSON.stringify(next), outerState(next), next.dueAtMs, next.attempts, next.lastCode, next.id]);
    return updated.changes === 1;
  });
  return store.transaction(() => {
    const row = store.database.prepare('SELECT id,kind,business_key,payload_json,state,attempts,lease_until FROM jobs WHERE id=?').get(leased.id) as JobRow | undefined;
    if (!owns(row, leased, nowMs)) return false;
    store.database.prepare('UPDATE jobs SET payload_json=?,state=?,due_at=?,attempts=?,lease_until=NULL,last_error_code=? WHERE id=?').run(JSON.stringify(next), outerState(next), next.dueAtMs, next.attempts, next.lastCode, next.id);
    return true;
  });
}
async function entityAccess(store: Store, job: TeamNotificationJob, principal: Principal, community: CommunityState, nowMs: number): Promise<TeamNotificationEvidence['entityAccess']> {
  const actor: CommunityActor = { accountId: job.accountId, teamId: job.teamId, seasonId: job.seasonId, role: job.audience, ...(job.playerId ? { playerId: job.playerId } : {}) };
  if (job.category === 'schedule') {
    if (job.audience === 'spectator') return 'denied';
    const preparation = await store.document<PreparationState>(job.teamId, job.seasonId, 'preparation');
    return preparation.team.id === job.teamId && (preparation.fixtures.some(item => item.seasonId === job.seasonId && item.id === job.entityId) || preparation.training.some(item => item.seasonId === job.seasonId && item.id === job.entityId)) ? 'allowed' : 'missing';
  }
  if (job.category === 'match') {
    try {
      const row = await store.match(job.entityId);
      if (row.team_id !== job.teamId || row.season_id !== job.seasonId) return 'denied';
      const projected = await store.matchDto(principal, job.entityId, job.audience);
      return projected.sharingRestricted === true ? 'withheld' : 'allowed';
    } catch (error) { if (error && typeof error === 'object' && 'status' in error && [403, 404].includes(Number(error.status))) return 'denied'; throw error; }
  }
  if (job.category === 'photos') {
    const photo = community.photos.find(item => item.id === job.entityId && item.teamId === job.teamId && item.seasonId === job.seasonId);
    if (!photo) return 'missing';
    const mode = photo.uploaderAccountId === job.accountId ? 'own' : job.audience === 'manager' ? 'review' : 'gallery';
    return authorizeCommunityMedia(community, actor, photo.id, nowMs, mode).allowed ? 'allowed' : 'denied';
  }
  const projected = getCommunityView(community, actor, nowMs);
  const match = projected.matches.find(item => item.id === job.entityId);
  return !match ? 'missing' : !match.sharingAllowed ? 'withheld' : match.award ? 'allowed' : 'missing';
}
async function evidence(store: Store, job: TeamNotificationJob, nowMs: number): Promise<TeamNotificationEvidence> {
  const row = store instanceof PostgresStore
    ? await store.one('SELECT * FROM accounts WHERE id=$1', [job.accountId])
    : store.database.prepare('SELECT * FROM accounts WHERE id=?').get(job.accountId) as Record<string, unknown> | undefined;
  const account: TeamNotificationEvidence['account'] = { accountId: job.accountId, status: row?.status === 'active' ? 'active' : 'disabled', identityClassification: row?.classification as Principal['identityClassification'] ?? 'unclassified', adultVerified: Boolean(row?.adult_verified), strongAuthEnrolled: Boolean(row?.strong_auth_enrolled) };
  const memberships = await store.memberships();
  const empty = { account, memberships, grants: [], preferences: defaultCommunityPreferences(), entityAccess: 'missing' as const };
  if (!row || account.status !== 'active') return empty;
  let community: CommunityState;
  try { community = await store.communityState(job.teamId, job.seasonId); } catch (error) { if (error && typeof error === 'object' && 'status' in error && Number(error.status) === 404) return empty; throw error; }
  const principal: Principal = { accountId: job.accountId, issuer: String(row.issuer), subject: String(row.subject), status: account.status, identityClassification: account.identityClassification, adultVerified: account.adultVerified, strongAuth: account.strongAuthEnrolled, authenticatedAt: nowMs };
  // This stored enrollment evidence authorises a generic background recipient. Opening its link still requires real sign-in.
  let access: TeamNotificationEvidence['entityAccess'] = 'denied';
  if (memberships.some(item => item.accountId === job.accountId && item.teamId === job.teamId && item.seasonId === job.seasonId && item.role === job.audience && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > nowMs))) access = await entityAccess(store, job, principal, community, nowMs);
  return { account, memberships, grants: community.grants, preferences: community.preferences[job.accountId] ?? defaultCommunityPreferences(), entityAccess: access };
}
export async function runDueTeamNotifications(store: Store, options: { provider?: TeamNotificationProvider; now?: () => number; maximum?: number } = {}) {
  const now = options.now ?? Date.now, provider = options.provider ?? null;
  const maximum = options.maximum ?? 20;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 1000) throw new Error('INVALID_NOTIFICATION_BATCH_LIMIT');
  const result = { accepted: 0, blocked: 0, retried: 0, suppressed: 0, reviewRequired: 0, failed: 0 };
  for (let index = 0; index < maximum; index++) {
    const claimed = await claimNext(store, now(), provider);
    if (claimed.reviewed) { result.reviewRequired++; continue; }
    if (!claimed.job) break;
    // Caller wall time is only a bounded observation for claiming. Recipient,
    // quiet-hour and outcome decisions advance from the database's lease anchor
    // using elapsed process time; a tolerated wall-clock offset grants no authority.
    let observedMonotonic = performance.now();
    let observedDatabaseMs = claimed.context?.nowMs ?? 0;
    const dispatchNow = store instanceof PostgresStore
      ? () => observedDatabaseMs + Math.max(0, Math.floor(performance.now() - observedMonotonic))
      : now;
    const observeDatabaseNow = async () => {
      if (!(store instanceof PostgresStore)) return now();
      const observation = await store.one('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms');
      if (!Number.isSafeInteger(observation?.now_ms)) throw new Error('NOTIFICATION_DATABASE_CLOCK_UNAVAILABLE');
      observedDatabaseMs = Number(observation!.now_ms);
      observedMonotonic = performance.now();
      return observedDatabaseMs;
    };
    // The claim/payload transactions may take time. Re-observe at every asynchronous
    // dispatch boundary instead of treating receipt as the original claim instant.
    await inJobContext(store, claimed.context, dispatchNow(), observeDatabaseNow);
    const scopedProvider: TeamNotificationProvider | null = provider ? { ...provider, send: async input => {
      if (!provider.prepareSend) return provider.send(input);
      const prepared = await inJobContext(store, claimed.context, dispatchNow(), () => provider.prepareSend!(input));
      return prepared();
    } } : null;
    const settled = await dispatchClaimedTeamNotification(claimed.job, { now: dispatchNow, provider:scopedProvider,
      readCurrentEvidence: (job, at) => inJobContext(store, claimed.context, at, async () => { const current = await evidence(store, job, await observeDatabaseNow()); await observeDatabaseNow(); return current; }),
      stillOwnsLease: (job, at) => inJobContext(store, claimed.context, at, async () => owns(await readRow(store, job.id), job, await observeDatabaseNow())),
      commit: (leased, next) => inJobContext(store, claimed.context, dispatchNow(), async () => commit(store, leased, next, await observeDatabaseNow())),
    });
    if (settled.status === 'provider_accepted') result.accepted++;
    else if (settled.status === 'blocked_provider') result.blocked++;
    else if (settled.status === 'pending') result.retried++;
    else if (settled.status === 'suppressed') result.suppressed++;
    else if (settled.status === 'review_required') result.reviewRequired++;
    else if (settled.status === 'failed') result.failed++;
  }
  return result;
}

export { createTeamNotificationJob };
