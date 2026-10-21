import { randomUUID } from 'node:crypto';
import type { Principal } from '../../../packages/application/src/access';
import { authorizeCommunityMedia, defaultCommunityPreferences, getCommunityView, type CommunityActor, type CommunityState } from '../../../packages/application/src/community';
import type { PreparationState } from '../../../packages/application/src/preparation';
import { claimTeamNotificationJob, createTeamNotificationJob, dispatchClaimedTeamNotification, validateTeamNotificationJob, type TeamNotificationEvidence, type TeamNotificationJob, type TeamNotificationProvider } from '../../../packages/application/src/team-notifications';
import { DevelopmentStore } from '../../api/src/store';
import { PostgresStore } from '../../api/src/postgres-store';

type Store = DevelopmentStore | PostgresStore;
interface JobRow { id: string; kind: string; business_key: string; payload_json: string; state: string; attempts: number; lease_until: number | null }
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
function expiredNeedsReview(row: JobRow, provider: TeamNotificationProvider | null): boolean { return row.state === 'leased' && (!provider?.configured || provider.idempotency !== 'provider' || row.attempts >= 6); }
function reviewExpired(job: TeamNotificationJob): TeamNotificationJob { return { ...job, revision: job.revision + 1, state: 'review_required', lease: null, lastCode: 'LEASE_EXPIRED_OUTCOME_UNKNOWN' }; }
async function claimNext(store: Store, nowMs: number, provider: TeamNotificationProvider | null): Promise<{ job: TeamNotificationJob | null; reviewed: boolean }> {
  if (store instanceof PostgresStore) return store.transaction(async () => {
    const row = await store.one("SELECT id,kind,business_key,payload_json,state,attempts,lease_until FROM jobs WHERE kind=$1 AND ((state='pending' AND due_at<=$2) OR (state='leased' AND lease_until<=$2)) ORDER BY due_at,id FOR UPDATE SKIP LOCKED LIMIT 1", [KIND, nowMs]) as unknown as JobRow | undefined;
    if (!row) return { job: null, reviewed: false };
    const prior = decode(row), reviewed = expiredNeedsReview(row, provider);
    const next = reviewed ? reviewExpired(prior) : claimTeamNotificationJob(prior, randomUUID(), nowMs);
    if (!next) throw new Error('NOTIFICATION_QUEUE_STATE_CONFLICT');
    await store.execute('UPDATE jobs SET payload_json=$1,state=$2,attempts=$3,lease_until=$4,last_error_code=$5 WHERE id=$6', [JSON.stringify(next), outerState(next), next.attempts, next.lease?.untilMs ?? null, next.lastCode, next.id]);
    return { job: reviewed ? null : next, reviewed };
  });
  return store.transaction(() => {
    const row = store.database.prepare("SELECT id,kind,business_key,payload_json,state,attempts,lease_until FROM jobs WHERE kind=? AND ((state='pending' AND due_at<=?) OR (state='leased' AND lease_until<=?)) ORDER BY due_at,id LIMIT 1").get(KIND, nowMs, nowMs) as JobRow | undefined;
    if (!row) return { job: null, reviewed: false };
    const prior = decode(row), reviewed = expiredNeedsReview(row, provider);
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
    await store.execute('UPDATE jobs SET payload_json=$1,state=$2,due_at=$3,attempts=$4,lease_until=NULL,last_error_code=$5 WHERE id=$6', [JSON.stringify(next), outerState(next), next.dueAtMs, next.attempts, next.lastCode, next.id]);
    return true;
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
    const settled = await dispatchClaimedTeamNotification(claimed.job, { now, provider,
      readCurrentEvidence: (job, at) => evidence(store, job, at),
      stillOwnsLease: async (job, at) => owns(await readRow(store, job.id), job, at),
      commit: (leased, next) => commit(store, leased, next, now()),
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
