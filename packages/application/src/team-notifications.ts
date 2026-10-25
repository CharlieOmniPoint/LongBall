import type { Membership, Principal } from './access';
import type { CommunityPreferences, SpectatorGrant } from './community';

export const TEAM_NOTIFICATION_TIME_ZONE = 'Europe/London';
export const TEAM_NOTIFICATION_BODY = 'Your team has an update';
export type TeamNotificationCategory = 'schedule' | 'match' | 'awards' | 'photos';
export interface TeamNotificationInput {
  id: string; businessKey: string; accountId: string; teamId: string; seasonId: string;
  audience: 'manager' | 'player' | 'spectator'; playerId: string | null;
  category: TeamNotificationCategory; entityId: string; dueAtMs: number;
}
export interface TeamNotificationJob extends TeamNotificationInput {
  schemaVersion: 1; revision: number;
  state: 'pending' | 'leased' | 'provider_accepted' | 'suppressed' | 'blocked_provider' | 'review_required' | 'failed';
  attempts: number; deliveryAttempts: number;
  lease: { attemptId: string; untilMs: number } | null;
  lastCode: string | null; providerReceiptId: string | null; acceptedAtMs: number | null;
}
export interface TeamNotificationEvidence {
  account: { accountId: string; status: Principal['status']; identityClassification: Principal['identityClassification']; adultVerified: boolean; strongAuthEnrolled: boolean };
  memberships: Membership[];
  grants: SpectatorGrant[];
  preferences: CommunityPreferences;
  /** Compute from the current permitted entity projection, not the enqueued payload. */
  entityAccess: 'allowed' | 'withheld' | 'denied' | 'missing';
}
export interface GenericTeamNotificationPayload { body: typeof TEAM_NOTIFICATION_BODY; data: { entityId: string } }
export interface TeamNotificationProvider {
  configured: boolean;
  /** Without provider deduplication, an unknown external outcome requires review, not blind retry. */
  idempotency: 'provider' | 'none';
  /** Optional server-side destination lookup within the exact leased job context.
   * The returned closure runs after that context ends; external transports get no DB authority. */
  prepareSend?: (input: Parameters<TeamNotificationProvider['send']>[0]) => Promise<() => ReturnType<TeamNotificationProvider['send']>>;
  send(input: { idempotencyKey: string; accountId: string; payload: GenericTeamNotificationPayload; signal: AbortSignal }): Promise<
    { status: 'accepted'; receiptId: string } | { status: 'retryable'; code: string } | { status: 'rejected'; code: string }
  >;
}
export interface TeamNotificationDispatchPorts {
  now: () => number;
  provider: TeamNotificationProvider | null;
  readCurrentEvidence: (job: TeamNotificationJob, nowMs: number) => Promise<TeamNotificationEvidence>;
  stillOwnsLease: (job: TeamNotificationJob, nowMs: number) => Promise<boolean>;
  /** Durable compare-and-set against the original revision/attempt. Never overwrite a newer lease. */
  commit: (leased: TeamNotificationJob, settled: TeamNotificationJob) => Promise<boolean>;
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const time = (value: number) => Number.isSafeInteger(value) && value >= 0;
const opaque = (value: string) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
const code = (value: string) => /^[A-Z][A-Z0-9_]{0,79}$/.test(value);
export function createTeamNotificationJob(input: TeamNotificationInput): TeamNotificationJob {
  assert(input && ['id', 'businessKey', 'accountId', 'teamId', 'seasonId', 'entityId'].every(field => opaque(input[field as keyof TeamNotificationInput] as string)), 'Notifications require bounded opaque identities.');
  assert(['manager', 'player', 'spectator'].includes(input.audience) && ['schedule', 'match', 'awards', 'photos'].includes(input.category) && time(input.dueAtMs), 'Invalid notification scope, category or due time.');
  assert(input.audience === 'player' ? input.playerId !== null && opaque(input.playerId) : input.playerId === null, 'Player notifications require their original own-player binding.');
  // Allowlist fields: no names, text, votes, secrets, scores, injury flags or media enter a job.
  return { id: input.id, businessKey: input.businessKey, accountId: input.accountId, teamId: input.teamId, seasonId: input.seasonId, audience: input.audience, playerId: input.playerId,
    category: input.category, entityId: input.entityId, dueAtMs: input.dueAtMs, schemaVersion: 1, revision: 0, state: 'pending', attempts: 0, deliveryAttempts: 0, lease: null, lastCode: null, providerReceiptId: null, acceptedAtMs: null };
}
export function validateTeamNotificationJob(job: TeamNotificationJob): void {
  createTeamNotificationJob(job);
  assert(Object.keys(job).every(field => ['id', 'businessKey', 'accountId', 'teamId', 'seasonId', 'audience', 'playerId', 'category', 'entityId', 'dueAtMs', 'schemaVersion', 'revision', 'state', 'attempts', 'deliveryAttempts', 'lease', 'lastCode', 'providerReceiptId', 'acceptedAtMs'].includes(field)), 'Unexpected retained notification data.');
  assert(job.schemaVersion === 1 && time(job.revision) && time(job.attempts) && time(job.deliveryAttempts) && ['pending', 'leased', 'provider_accepted', 'suppressed', 'blocked_provider', 'review_required', 'failed'].includes(job.state), 'Invalid retained notification state.');
  assert(job.state === 'leased' ? job.lease && opaque(job.lease.attemptId) && time(job.lease.untilMs) : job.lease === null, 'Invalid notification lease.');
  assert(job.lastCode === null || code(job.lastCode), 'Invalid notification outcome code.');
  assert(job.providerReceiptId === null || opaque(job.providerReceiptId), 'Invalid provider receipt identity.');
  assert(job.acceptedAtMs === null || time(job.acceptedAtMs), 'Invalid provider acknowledgement time.');
  assert(job.state !== 'provider_accepted' || job.providerReceiptId && job.acceptedAtMs !== null, 'A provider-accepted job needs a real receipt.');
}
export function claimTeamNotificationJob(job: TeamNotificationJob, attemptId: string, nowMs: number, leaseMs = 30_000): TeamNotificationJob | null {
  validateTeamNotificationJob(job);
  assert(time(nowMs) && opaque(attemptId) && Number.isSafeInteger(leaseMs) && leaseMs >= 1000 && leaseMs <= 120_000, 'Invalid notification lease request.');
  if (!(job.state === 'pending' && job.dueAtMs <= nowMs || job.state === 'leased' && job.lease!.untilMs <= nowMs)) return null;
  return { ...clone(job), revision: job.revision + 1, attempts: job.attempts + 1, state: 'leased', lease: { attemptId, untilMs: nowMs + leaseMs } };
}
export function resumeBlockedTeamNotification(job: TeamNotificationJob, nowMs: number): TeamNotificationJob {
  validateTeamNotificationJob(job);
  assert(job.state === 'blocked_provider' && time(nowMs), 'Only an explicitly configured provider may resume its blocked job.');
  return { ...clone(job), state: 'pending', revision: job.revision + 1, dueAtMs: nowMs, lastCode: null };
}
const londonClock = new Intl.DateTimeFormat('en-GB', { timeZone: TEAM_NOTIFICATION_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function localMinute(nowMs: number): number {
  const parts = londonClock.formatToParts(nowMs);
  return Number(parts.find(part => part.type === 'hour')!.value) * 60 + Number(parts.find(part => part.type === 'minute')!.value);
}
/** Absolute instants are stepped through the timezone transition; no fixed UTC offset is assumed. */
export function nextTeamNotificationTime(preferences: CommunityPreferences, nowMs: number): number {
  assert(time(nowMs), 'Trusted dispatch time is required.');
  assert(['schedule', 'match', 'awards', 'photos'].every(field => typeof preferences[field as TeamNotificationCategory] === 'boolean'), 'Invalid notification channel preferences.');
  if (preferences.quietStart === null && preferences.quietEnd === null) return nowMs;
  const pattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  assert(typeof preferences.quietStart === 'string' && typeof preferences.quietEnd === 'string' && pattern.test(preferences.quietStart) && pattern.test(preferences.quietEnd) && preferences.quietStart !== preferences.quietEnd, 'Quiet hours need distinct HH:MM boundaries; use channel switches to pause all day.');
  const minute = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = minute(preferences.quietStart), end = minute(preferences.quietEnd);
  const quiet = (at: number) => { const value = localMinute(at); return start < end ? value >= start && value < end : value >= start || value < end; };
  if (!quiet(nowMs)) return nowMs;
  for (let at = Math.ceil(nowMs / 60_000) * 60_000; at <= nowMs + 49 * 3_600_000; at += 60_000) if (!quiet(at)) return at;
  throw new Error('The quiet-hour boundary could not be established.');
}
export type TeamNotificationDecision = { action: 'send' } | { action: 'suppress'; code: string } | { action: 'defer'; dueAtMs: number; code: 'QUIET_HOURS' };
export function evaluateTeamNotification(job: TeamNotificationJob, evidence: TeamNotificationEvidence, nowMs: number): TeamNotificationDecision {
  validateTeamNotificationJob(job);
  if (evidence.account.accountId !== job.accountId || evidence.account.status !== 'active') return { action: 'suppress', code: 'ACCOUNT_UNAVAILABLE' };
  const membership = evidence.memberships.find(item => item.accountId === job.accountId && item.teamId === job.teamId && item.seasonId === job.seasonId && item.role === job.audience && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > nowMs) && (job.audience !== 'player' || item.playerId === job.playerId));
  if (!membership) return { action: 'suppress', code: 'NO_CURRENT_MEMBERSHIP' };
  if (job.audience === 'manager' && !(evidence.account.identityClassification === 'adult_individual' && evidence.account.adultVerified && evidence.account.strongAuthEnrolled)) return { action: 'suppress', code: 'MANAGER_AUTHORITY_UNAVAILABLE' };
  if (job.audience === 'spectator' && !evidence.grants.some(grant => grant.accountId === job.accountId && grant.teamId === job.teamId && grant.seasonId === job.seasonId && grant.startsAtMs <= nowMs && grant.expiresAtMs > nowMs && grant.revokedAtMs === null)) return { action: 'suppress', code: 'SPECTATOR_GRANT_UNAVAILABLE' };
  if (evidence.entityAccess !== 'allowed') return { action: 'suppress', code: evidence.entityAccess === 'withheld' ? 'ENTITY_POLICY_WITHHELD' : 'ENTITY_UNAVAILABLE' };
  if (!evidence.preferences[job.category]) return { action: 'suppress', code: 'CHANNEL_DISABLED' };
  const dueAtMs = nextTeamNotificationTime(evidence.preferences, nowMs);
  return dueAtMs > nowMs ? { action: 'defer', dueAtMs, code: 'QUIET_HOURS' } : { action: 'send' };
}
function settle(job: TeamNotificationJob, outcome: { state: TeamNotificationJob['state']; code: string | null; nowMs: number; dueAtMs?: number; receiptId?: string; attempted?: boolean }): TeamNotificationJob {
  assert(job.state === 'leased' && job.lease, 'The current durable notification lease is required.');
  const next: TeamNotificationJob = { ...clone(job), state: outcome.state, revision: job.revision + 1, lease: null, lastCode: outcome.code,
    deliveryAttempts: job.deliveryAttempts + Number(outcome.attempted === true), dueAtMs: outcome.dueAtMs ?? job.dueAtMs,
    providerReceiptId: outcome.receiptId ?? job.providerReceiptId, acceptedAtMs: outcome.state === 'provider_accepted' ? outcome.nowMs : job.acceptedAtMs };
  validateTeamNotificationJob(next);
  return next;
}
/** The lease and outcome must be persisted by the repository. This function never fabricates delivery. */
export async function dispatchClaimedTeamNotification(job: TeamNotificationJob, ports: TeamNotificationDispatchPorts): Promise<{ status: TeamNotificationJob['state'] | 'superseded'; committed: boolean; job: TeamNotificationJob | null }> {
  validateTeamNotificationJob(job);
  const current = () => job.state === 'leased' && job.lease !== null && ports.now() < job.lease.untilMs;
  if (!current() || !(await ports.stillOwnsLease(job, ports.now()))) return { status: 'superseded', committed: false, job: null };
  const commit = async (next: TeamNotificationJob) => { const saved = await ports.commit(job, next); return { status: saved ? next.state : 'superseded' as const, committed: saved, job: saved ? next : null }; };
  let evidence: TeamNotificationEvidence;
  try { evidence = await ports.readCurrentEvidence(job, ports.now()); } catch {
    return commit(settle(job, { state: 'pending', code: 'AUTHORITY_LOOKUP_UNAVAILABLE', nowMs: ports.now(), dueAtMs: ports.now() + 60_000 }));
  }
  if (!current() || !(await ports.stillOwnsLease(job, ports.now()))) return { status: 'superseded', committed: false, job: null };
  let decision: TeamNotificationDecision;
  try { decision = evaluateTeamNotification(job, evidence, ports.now()); } catch {
    return commit(settle(job, { state: 'review_required', code: 'INVALID_PREFERENCES_OR_JOB', nowMs: ports.now() }));
  }
  if (decision.action === 'suppress') return commit(settle(job, { state: 'suppressed', code: decision.code, nowMs: ports.now() }));
  if (decision.action === 'defer') return commit(settle(job, { state: 'pending', code: decision.code, nowMs: ports.now(), dueAtMs: decision.dueAtMs }));
  const provider = ports.provider;
  if (!provider?.configured) return commit(settle(job, { state: 'blocked_provider', code: 'PUSH_PROVIDER_UNCONFIGURED', nowMs: ports.now() }));
  const payload: GenericTeamNotificationPayload = { body: TEAM_NOTIFICATION_BODY, data: { entityId: job.entityId } };
  const abort = new AbortController();
  const remainingMs = Math.min(10_000, job.lease!.untilMs - ports.now());
  if (remainingMs <= 0 || !(await ports.stillOwnsLease(job, ports.now()))) return { status: 'superseded', committed: false, job: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([provider.send({ idempotencyKey: job.businessKey, accountId: job.accountId, payload, signal: abort.signal }), new Promise<never>((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error('PROVIDER_OUTCOME_UNKNOWN')); }, remainingMs); })]);
    if (reply.status === 'accepted') {
      assert(opaque(reply.receiptId), 'Invalid provider receipt.');
      return commit(settle(job, { state: 'provider_accepted', code: null, nowMs: ports.now(), receiptId: reply.receiptId, attempted: true }));
    }
    const safeCode = ['RATE_LIMIT', 'TEMPORARY_UNAVAILABLE', 'DEVICE_UNREGISTERED', 'PERMISSION_DENIED', 'INVALID_DESTINATION'].includes(reply.code) ? reply.code : 'PROVIDER_REFUSED';
    const terminal = reply.status === 'rejected' || job.deliveryAttempts + 1 >= 6;
    return commit(settle(job, { state: terminal ? 'failed' : 'pending', code: safeCode, nowMs: ports.now(), dueAtMs: ports.now() + Math.min(3_600_000, 30_000 * 2 ** job.deliveryAttempts), attempted: true }));
  } catch {
    const mayRetry = provider.idempotency === 'provider' && job.deliveryAttempts + 1 < 6;
    return commit(settle(job, { state: mayRetry ? 'pending' : 'review_required', code: 'PROVIDER_OUTCOME_UNKNOWN', nowMs: ports.now(), dueAtMs: ports.now() + Math.min(3_600_000, 30_000 * 2 ** job.deliveryAttempts), attempted: true }));
  } finally { clearTimeout(timer); }
}
