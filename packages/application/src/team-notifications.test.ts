import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyCommunityCommand, createCommunityState, defaultCommunityPreferences, syntheticCommunityActors } from './community';
import { claimTeamNotificationJob, createTeamNotificationJob, dispatchClaimedTeamNotification, evaluateTeamNotification, nextTeamNotificationTime, resumeBlockedTeamNotification, TEAM_NOTIFICATION_BODY, validateTeamNotificationJob, type TeamNotificationDispatchPorts, type TeamNotificationEvidence, type TeamNotificationInput, type TeamNotificationJob, type TeamNotificationProvider } from './team-notifications';

const baseTime = Date.parse('2026-10-21T12:00:00Z');
const input: TeamNotificationInput = { id: 'notification-001', businessKey: 'event-001.account-001.schedule', accountId: 'account-001', teamId: 'team-001', seasonId: 'season-001', audience: 'player', playerId: 'player-001', category: 'schedule', entityId: 'opaque-entity-001', dueAtMs: baseTime };
function evidence(): TeamNotificationEvidence {
  return { account: { accountId: input.accountId, status: 'active', identityClassification: 'child_shared', adultVerified: false, strongAuthEnrolled: false }, memberships: [{ accountId: input.accountId, teamId: input.teamId, seasonId: input.seasonId, role: 'player', playerId: input.playerId!, expiresAt: baseTime + 86_400_000 }], grants: [], preferences: defaultCommunityPreferences(), entityAccess: 'allowed' };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function lab(patch: Partial<TeamNotificationInput> = {}) {
  let now = baseTime, saved = createTeamNotificationJob({ ...input, ...patch });
  let current = evidence();
  const send = vi.fn<TeamNotificationProvider['send']>(async () => ({ status: 'accepted', receiptId: 'provider-receipt-001' }));
  const provider: TeamNotificationProvider = { configured: true, idempotency: 'provider', send };
  const owns = (job: TeamNotificationJob) => saved.state === 'leased' && saved.revision === job.revision && saved.lease?.attemptId === job.lease?.attemptId && saved.lease!.untilMs > now;
  const ports: TeamNotificationDispatchPorts = {
    now: () => now, provider,
    readCurrentEvidence: vi.fn(async () => structuredClone(current)),
    stillOwnsLease: vi.fn(async job => owns(job)),
    commit: vi.fn(async (leased, settled) => { if (!owns(leased)) return false; saved = JSON.parse(JSON.stringify(settled)) as TeamNotificationJob; return true; }),
  };
  return { ports, provider, send, get saved() { return saved; }, get now() { return now; }, setTime(at: number) { now = at; }, setEvidence(next: TeamNotificationEvidence) { current = next; },
    claim(attempt = `attempt-${saved.attempts + 1}`) { const next = claimTeamNotificationJob(saved, attempt, now); if (!next) throw new Error('The test job was not claimable.'); saved = JSON.parse(JSON.stringify(next)) as TeamNotificationJob; return structuredClone(saved); },
    restore(job = saved) { saved = JSON.parse(JSON.stringify(job)) as TeamNotificationJob; },
  };
}
afterEach(() => vi.useRealTimers());
describe('generic ordinary team notifications', () => {
  it('allowlists persisted jobs and sends exactly the generic body and opaque entity ID', async () => {
    const contaminated = { ...input, childName: 'Private child', injury: 'private reason', votes: [1], invitationToken: 'private token', thumbnail: 'private bytes' };
    const clean = createTeamNotificationJob(contaminated);
    expect(JSON.stringify(clean)).not.toContain('private'); expect(clean).not.toHaveProperty('childName');
    const test = lab();
    const result = await dispatchClaimedTeamNotification(test.claim(), test.ports);
    expect(result.status).toBe('provider_accepted'); expect(test.saved.acceptedAtMs).toBe(baseTime);
    expect(test.send.mock.calls[0][0].payload).toEqual({ body: TEAM_NOTIFICATION_BODY, data: { entityId: input.entityId } });
    expect(test.send.mock.calls[0][0].idempotencyKey).toBe(input.businessKey);
    expect(test.saved).not.toHaveProperty('deliveredAt');
    expect(claimTeamNotificationJob(test.saved, 'another-attempt', baseTime + 100_000)).toBeNull();
  });
  it('rechecks current account, exact player binding and entity policy instead of trusting enqueue authority', async () => {
    for (const patch of [
      { account: { ...evidence().account, status: 'disabled' as const } },
      { memberships: [] },
      { memberships: [{ ...evidence().memberships[0], revokedAt: baseTime }] },
      { memberships: [{ ...evidence().memberships[0], expiresAt: baseTime }] },
      { memberships: [{ ...evidence().memberships[0], playerId: 'different-player' }] },
      { entityAccess: 'withheld' as const },
    ]) {
      const test = lab(); test.setEvidence({ ...evidence(), ...patch });
      expect((await dispatchClaimedTeamNotification(test.claim(), test.ports)).status).toBe('suppressed');
      expect(test.send).not.toHaveBeenCalled();
    }
  });
  it('requires at least one current spectator grant even when a stale SQL membership still exists', () => {
    const job = createTeamNotificationJob({ ...input, audience: 'spectator', playerId: null });
    const state = { ...evidence(), memberships: [{ ...evidence().memberships[0], role: 'spectator' as const, playerId: undefined }] };
    const grant = { id: 'grant-001', invitationId: 'invitation-001', accountId: input.accountId, teamId: input.teamId, seasonId: input.seasonId, startsAtMs: baseTime - 1000, expiresAtMs: baseTime + 1000, revokedAtMs: null };
    for (const grants of [[], [{ ...grant, expiresAtMs: baseTime }], [{ ...grant, revokedAtMs: baseTime }], [{ ...grant, seasonId: 'other-season' }]]) expect(evaluateTeamNotification(job, { ...state, grants }, baseTime).action).toBe('suppress');
    expect(evaluateTeamNotification(job, { ...state, grants: [{ ...grant, revokedAtMs: baseTime }, { ...grant, id: 'grant-002' }] }, baseTime)).toEqual({ action: 'send' });
  });
  it('evaluates quiet hours through both Europe/London DST transitions using absolute instants', () => {
    const preferences = { ...defaultCommunityPreferences(), quietStart: '22:00', quietEnd: '07:00' };
    expect(nextTeamNotificationTime(preferences, Date.parse('2027-03-28T00:30:00Z'))).toBe(Date.parse('2027-03-28T06:00:00Z'));
    expect(nextTeamNotificationTime(preferences, Date.parse('2026-10-25T00:30:00Z'))).toBe(Date.parse('2026-10-25T07:00:00Z'));
    expect(nextTeamNotificationTime(preferences, Date.parse('2026-10-25T07:00:00Z'))).toBe(Date.parse('2026-10-25T07:00:00Z'));
    expect(() => nextTeamNotificationTime({ ...preferences, quietEnd: '22:00' }, baseTime)).toThrow('distinct');
    const community = createCommunityState(baseTime), actor = syntheticCommunityActors(community).player;
    expect(() => applyCommunityCommand(community, actor, { id: 'quiet-equal', type: 'preferences.changed', preferences: { ...preferences, quietEnd: '22:00' } }, baseTime)).toThrow('distinct');
  });
  it('persists quiet deferral and rechecks changed preferences at its later dispatch rather than treating the queue as permission', async () => {
    const test = lab(); test.setTime(Date.parse('2026-10-21T22:00:00Z'));
    test.setEvidence({ ...evidence(), memberships: [{ ...evidence().memberships[0], expiresAt: null }], preferences: { ...defaultCommunityPreferences(), quietStart: '22:00', quietEnd: '07:00' } });
    expect((await dispatchClaimedTeamNotification(test.claim(), test.ports)).status).toBe('pending');
    expect(test.saved).toMatchObject({ dueAtMs: Date.parse('2026-10-22T06:00:00Z'), lastCode: 'QUIET_HOURS', deliveryAttempts: 0 });
    test.restore(); test.setTime(test.saved.dueAtMs);
    test.setEvidence({ ...evidence(), memberships: [{ ...evidence().memberships[0], expiresAt: null }], preferences: { ...defaultCommunityPreferences(), schedule: false } });
    expect((await dispatchClaimedTeamNotification(test.claim(), test.ports)).status).toBe('suppressed'); expect(test.send).not.toHaveBeenCalled();
  });
  it('records an absent provider as blocked and requires explicit resumption after configuration', async () => {
    const test = lab(); test.ports.provider = null;
    expect((await dispatchClaimedTeamNotification(test.claim(), test.ports)).status).toBe('blocked_provider');
    expect(test.saved).toMatchObject({ lastCode: 'PUSH_PROVIDER_UNCONFIGURED', providerReceiptId: null, acceptedAtMs: null, deliveryAttempts: 0 });
    expect(test.send).not.toHaveBeenCalled(); expect(claimTeamNotificationJob(test.saved, 'not-configured-retry', baseTime + 1000)).toBeNull();
    test.restore(resumeBlockedTeamNotification(test.saved, baseTime)); test.ports.provider = test.provider;
    expect((await dispatchClaimedTeamNotification(test.claim(), test.ports)).status).toBe('provider_accepted');
  });
  it('retains the same business key through durable retry after an externally accepted lost response', async () => {
    const test = lab(); const accepted = new Set<string>();
    test.send.mockImplementation(async request => { if (!accepted.has(request.idempotencyKey)) { accepted.add(request.idempotencyKey); throw new Error('Lost response, raw provider data must not persist.'); } return { status: 'accepted', receiptId: 'same-provider-receipt' }; });
    expect((await dispatchClaimedTeamNotification(test.claim(), test.ports)).status).toBe('pending');
    expect(test.saved.lastCode).toBe('PROVIDER_OUTCOME_UNKNOWN'); expect(JSON.stringify(test.saved)).not.toContain('raw provider');
    test.restore(); test.setTime(test.saved.dueAtMs);
    expect((await dispatchClaimedTeamNotification(test.claim(), test.ports)).status).toBe('provider_accepted');
    expect(accepted.size).toBe(1); expect(test.send.mock.calls.map(([request]) => request.idempotencyKey)).toEqual([input.businessKey, input.businessKey]);
  });
  it('requires review for unknown provider outcomes when the provider cannot deduplicate', async () => {
    const test = lab(); test.provider.idempotency = 'none'; test.send.mockRejectedValue(new Error('Transport outcome unknown'));
    expect((await dispatchClaimedTeamNotification(test.claim(), test.ports)).status).toBe('review_required');
    expect(claimTeamNotificationJob(test.saved, 'unsafe-blind-retry', baseTime + 100_000)).toBeNull();
  });
  it('does not send or overwrite a newer durable lease after an old evidence lookup returns late', async () => {
    const test = lab(), waiting = deferred<TeamNotificationEvidence>();
    test.ports.readCurrentEvidence = () => waiting.promise;
    const pending = dispatchClaimedTeamNotification(test.claim('old-attempt'), test.ports);
    await Promise.resolve(); test.setTime(baseTime + 30_001); const next = test.claim('new-attempt');
    waiting.resolve(evidence());
    expect((await pending).status).toBe('superseded'); expect(test.saved.revision).toBe(next.revision); expect(test.saved.lease?.attemptId).toBe('new-attempt'); expect(test.send).not.toHaveBeenCalled();
  });
  it('bounds a hanging external provider and aborts it without claiming delivery', async () => {
    vi.useFakeTimers();
    const test = lab(), started = deferred<void>(); let signal: AbortSignal | null = null;
    test.provider.idempotency = 'none'; test.send.mockImplementation(request => { signal = request.signal; started.resolve(); return new Promise(() => {}); });
    const pending = dispatchClaimedTeamNotification(test.claim(), test.ports);
    await started.promise; await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).status).toBe('review_required'); expect((signal as AbortSignal | null)?.aborted).toBe(true); expect(test.saved.acceptedAtMs).toBeNull();
  });
  it('keeps read failures retryable, bounds delivery retries and refuses damaged restored state', async () => {
    const unavailable = lab(); unavailable.ports.readCurrentEvidence = async () => { throw new Error('Database unavailable'); };
    expect((await dispatchClaimedTeamNotification(unavailable.claim(), unavailable.ports)).status).toBe('pending'); expect(unavailable.saved.lastCode).toBe('AUTHORITY_LOOKUP_UNAVAILABLE'); expect(unavailable.send).not.toHaveBeenCalled();
    const retrying = lab(); retrying.send.mockResolvedValue({ status: 'retryable', code: 'RATE_LIMIT' });
    for (let index = 0; index < 6; index++) { await dispatchClaimedTeamNotification(retrying.claim(), retrying.ports); retrying.setTime(retrying.saved.dueAtMs); }
    expect(retrying.saved.state).toBe('failed'); expect(retrying.saved.deliveryAttempts).toBe(6);
    expect(() => validateTeamNotificationJob({ ...retrying.saved, childName: 'private' } as TeamNotificationJob)).toThrow('Unexpected');
    expect(() => validateTeamNotificationJob({ ...retrying.saved, schemaVersion: 2 } as unknown as TeamNotificationJob)).toThrow();
  });
});
