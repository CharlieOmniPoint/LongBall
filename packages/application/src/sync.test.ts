import { offlineDownloadFixture } from './offline-bundle.test-fixture';
import { describe, expect, it, vi } from 'vitest';
import { createMatch, ENGINE_VERSION, reduceMatch, type MatchEvent } from '../../domain/src/index';
import { applyMutationResponse, applyUploadReceipt, attachGrant, createConnectedDocument, effectiveEventTime, LongBallServiceClient, mergeDownload, prepareServiceRequest, queueConnectedCommand, retainClockMapping, selectAcceptedBranch, ServiceError, settleDefiniteRefusal, WIRE_CONTRACT_VERSION, type ConnectedMatchDocument, type HttpFetch, type MatchDownload, type UploadReceipt } from './sync';

const now = 1_800_000_000_000;
const state = createMatch({ matchId: 'synthetic-wire-match', players: Array.from({ length: 9 }, (_, index) => ({ id: `p${index + 1}`, displayName: `Player ${index + 1}`, goalkeeperChoice: index === 0 ? 1 : 0 })), selectedPlayerIds: Array.from({ length: 9 }, (_, index) => `p${index + 1}`), pitchPlaces: 7, plannedHalfDurationMs: 1_500_000, fixedKeeperId: 'p1' });
const sample = (monotonicMs = 0) => ({ monotonicMs, sessionId: 'wire-session', wallTimeMs: now + monotonicMs });
function downloaded(checkpoint = { clientSequence: 0, previousEventId: null as string | null }): MatchDownload {
  return offlineDownloadFixture({ contractVersion: WIRE_CONTRACT_VERSION, schemaVersion: 1, engineVersion: ENGINE_VERSION, matchId: state.config.matchId, state, acceptedRevision: 0, deviceCheckpoint: checkpoint, controller: { epoch: 1, account_id: 'manager-a', device_id: 'device-a', frozen: 0 }, downloadedAt: new Date(now).toISOString(), clockAnchor: { serverTime: new Date(now).toISOString(), quality: 'observation_only', continuousMappingEstablished: false }, syntheticOnly: true });
}
function ready(): ConnectedMatchDocument {
  return mergeDownload(attachGrant(mergeDownload(createConnectedDocument('device-a', state.config.matchId, 'http://127.0.0.1:4310'), downloaded()), { epoch: 1, deviceId: 'device-a', controllerToken: 'synthetic-capability-a', checkpoint: { clientSequence: 0, previousEventId: null } }), downloaded());
}
function response(status: number, body: unknown) { return { status, ok: status >= 200 && status < 300, json: async () => body }; }

describe('canonical connected outbox separate from M0 local history', () => {
  it('queues original wire identities, exact effective times and projected state without network or mutation', () => {
    const before = ready(); const next = queueConnectedCommand(before, { type: 'attendance.recorded', playerId: 'p1', status: 'present' }, sample(), 'event-one');
    expect(before.outbox).toEqual([]); expect(before.allocatedSequence).toBe(0);
    expect(next.outbox[0].envelope).toMatchObject({ contractVersion: WIRE_CONTRACT_VERSION, schemaVersion: 1, engineVersion: ENGINE_VERSION, eventId: 'event-one', clientSequence: 1, previousEventId: null, baseRevision: 0, effectiveHalf: 0, halfElapsedMs: 0, matchElapsedMs: 0, timeQuality: 'reviewRequired', effectiveAt: null });
    expect(next.localState?.attendance.p1).toBe('present'); expect(next.acceptedState?.attendance.p1).toBe('not_recorded');
  });
  it('retains an uncertain full HTTP request/key and retries byte-identical payload after server committed', async () => {
    let document = queueConnectedCommand(ready(), { type: 'attendance.recorded', playerId: 'p1', status: 'present' }, sample(), 'event-one');
    document = prepareServiceRequest(document, 'upload', 'upload-original-key');
    const original = JSON.stringify(document.pendingRequest);
    const requests: string[] = []; let first = true;
    const receipt: UploadReceipt = { revision: 1, pendingReview: false, results: [{ eventId: 'event-one', clientSequence: 1, disposition: 'accepted', reason: null, revision: 1, duplicate: false }] };
    const fakeFetch: HttpFetch = async (_url, options) => { requests.push(`${options.headers['Idempotency-Key']}:${options.body}`); if (first) { first = false; throw new Error('Response lost after server commit'); } return response(200, receipt); };
    const client = new LongBallServiceClient(document.baseUrl, fakeFetch);
    await expect(client.execute(document.pendingRequest!, document.grant)).rejects.toThrow('Response lost');
    expect(JSON.stringify(document.pendingRequest)).toBe(original);
    const accepted = await client.execute<UploadReceipt>(document.pendingRequest!, document.grant);
    document = applyUploadReceipt(document, accepted, new Date(now).toISOString());
    expect(requests[1]).toBe(requests[0]); expect(document.outbox[0].disposition).toBe('accepted'); expect(document.pendingRequest).toBeNull(); expect(document.acceptedState?.attendance.p1).toBe('not_recorded');
    expect(() => selectAcceptedBranch(document)).toThrow('authoritative accepted snapshot');
    const authoritative = reduceMatch(state, { ...document.outbox[0].envelope.command, actorId: 'verified-server-account' });
    document = mergeDownload(document, offlineDownloadFixture({ ...downloaded({ clientSequence: 1, previousEventId: 'event-one' }), state: authoritative, acceptedRevision: 1 }));
    expect(document.acceptedState?.audit).toEqual(authoritative.audit);
    expect(document.acceptedState?.audit?.at(-1)?.actorId).toBe('verified-server-account');
  });
  it('captures an offline clock/goal suffix behind an immutable upload and rebases only its confirmed prefix audit', () => {
    let document = ready();
    for (const playerId of state.config.selectedPlayerIds) document = queueConnectedCommand(document, { type: 'attendance.recorded', playerId, status: 'present' }, sample(), `present-${playerId}`);
    document = queueConnectedCommand(document, { type: 'lineup.staged', lineup: state.config.selectedPlayerIds.slice(0, 7).map((playerId, index) => ({ playerId, slotId: `slot-${index}`, position: index === 0 ? 'GK' : 'CM' })) }, sample(), 'staged');
    document = queueConnectedCommand(document, { type: 'half.started' }, sample(), 'kickoff');
    document = queueConnectedCommand(document, { type: 'half.paused' }, sample(10_000), 'prefix-pause');
    const prefix = [...document.outbox];
    document = prepareServiceRequest(document, 'upload', 'immutable-prefix-upload');
    const exactRequest = JSON.stringify(document.pendingRequest);
    document = queueConnectedCommand(document, { type: 'half.resumed' }, sample(20_000), 'offline-resume');
    document = queueConnectedCommand(document, { type: 'goal.recorded', beneficiary: 'us', scorerPlayerId: 'p2' }, sample(30_000), 'offline-goal');
    document = queueConnectedCommand(document, { type: 'half.paused' }, sample(35_000), 'offline-pause');
    expect(JSON.stringify(document.pendingRequest)).toBe(exactRequest);
    let authoritative = state;
    for (const entry of prefix) authoritative = reduceMatch(authoritative, { ...entry.envelope.command, actorId: 'server-verified-manager' });
    document = applyUploadReceipt(document, { revision: authoritative.revision, pendingReview: false, results: prefix.map(entry => ({ eventId: entry.envelope.eventId, clientSequence: entry.envelope.clientSequence, disposition: 'accepted', reason: null, revision: entry.envelope.baseRevision + 1, duplicate: true })) }, new Date(now).toISOString());
    expect(document.authoritativeDownloadRequired).toBe(true);
    expect(() => selectAcceptedBranch(document)).toThrow('authoritative');
    // Even if the follow-up download is offline, the held controller keeps capturing actual events.
    document = queueConnectedCommand(document, { type: 'half.ended' }, sample(40_000), 'offline-half-end');
    const suffix = JSON.stringify(document.outbox.filter(entry => entry.disposition === 'pending').map(entry => entry.envelope));
    document = mergeDownload(document, offlineDownloadFixture({ ...downloaded({ clientSequence: prefix.length, previousEventId: 'prefix-pause' }), state: authoritative, acceptedRevision: authoritative.revision }));
    expect(document.reconciliationRequired).toBe(false); expect(document.controllerConfirmed).toBe(true);
    expect(document.localState?.status).toBe('half_time'); expect(document.localState?.matchActiveMs).toBe(25_000);
    expect(document.localState?.goals?.length).toBe(1); expect(document.acceptedState?.goals?.length).toBe(0);
    expect(document.localState?.audit?.slice(0, prefix.length).every(entry => entry.actorId === 'server-verified-manager')).toBe(true);
    expect(JSON.stringify(document.outbox.filter(entry => entry.disposition === 'pending').map(entry => entry.envelope))).toBe(suffix);
    expect(document.localState?.intervals.filter(interval => interval.state === 'playing').reduce((sum, interval) => sum + interval.endMs - interval.startMs, 0)).toBe(7 * 25_000);
    document = prepareServiceRequest(document, 'upload', 'offline-suffix-upload');
    expect(JSON.stringify((document.pendingRequest!.body as { events: unknown[] }).events)).toBe(suffix);
  });
  it('bounds hung fetches and body reads, aborts transport, and retains the exact uncertain request', async () => {
    vi.useFakeTimers();
    try {
      const document = prepareServiceRequest(queueConnectedCommand(ready(), { type: 'attendance.recorded', playerId: 'p1', status: 'present' }, sample(), 'timeout-event'), 'upload', 'timeout-original-key');
      const retained = JSON.stringify(document.pendingRequest);
      let observedSignal: AbortSignal | undefined;
      const client = new LongBallServiceClient('', async (_url, options) => { observedSignal = options.signal; return new Promise(() => {}); }, 100);
      const failure = client.execute(document.pendingRequest!, document.grant).catch(error => error);
      await vi.advanceTimersByTimeAsync(100);
      expect(await failure).toMatchObject({ code: 'REQUEST_TIMEOUT', retryable: true }); expect(observedSignal?.aborted).toBe(true);
      const hangingBody = new LongBallServiceClient('', async () => ({ status: 200, ok: true, json: () => new Promise(() => {}) }), 100);
      const bodyFailure = hangingBody.execute(document.pendingRequest!, document.grant).catch(error => error);
      await vi.advanceTimersByTimeAsync(100);
      expect(await bodyFailure).toMatchObject({ code: 'REQUEST_TIMEOUT' }); expect(JSON.stringify(document.pendingRequest)).toBe(retained);
    } finally { vi.useRealTimers(); }
  });
  it('cancels a foreground read immediately, aborting transport or a hanging body without waiting for timeout', async () => {
    const controller = new AbortController(); let observed: AbortSignal | undefined;
    const client = new LongBallServiceClient('', async (_url, options) => { observed = options.signal; return new Promise(() => {}); });
    const pending = client.request('/v1/me', { signal: controller.signal }).catch(error => error);
    controller.abort(); expect(await pending).toMatchObject({ name: 'AbortError' }); expect(observed?.aborted).toBe(true);
    let contacted = false;
    const skipped = new LongBallServiceClient('', async () => { contacted = true; return response(200, {}); });
    await expect(skipped.request('/v1/me', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' }); expect(contacted).toBe(false);
    const bodyController = new AbortController();
    const body = new LongBallServiceClient('', async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }));
    const bodyPending = body.request('/v1/me', { signal: bodyController.signal }).catch(error => error);
    await Promise.resolve(); bodyController.abort(); expect(await bodyPending).toMatchObject({ name: 'AbortError' });
  });
  it('treats409 stale-epoch quarantine as durable acknowledgement and preserves candidate branch', async () => {
    let document = queueConnectedCommand(ready(), { type: 'attendance.recorded', playerId: 'p2', status: 'present' }, sample(), 'old-epoch-event');
    document = prepareServiceRequest(document, 'upload', 'upload-stale-key');
    const receipt: UploadReceipt = { revision: 0, pendingReview: true, results: [{ eventId: 'old-epoch-event', clientSequence: 1, disposition: 'quarantined', reason: 'STALE_CONTROLLER', revision: null, duplicate: false }] };
    const client = new LongBallServiceClient('', async () => response(409, receipt));
    document = applyUploadReceipt(document, await client.execute(document.pendingRequest!, document.grant), new Date(now).toISOString());
    expect(document.controllerConfirmed).toBe(false); expect(document.reconciliationRequired).toBe(true);
    expect(document.localState?.attendance.p2).toBe('present'); expect(document.acceptedState?.attendance.p2).toBe('not_recorded');
    expect(document.outbox[0]).toMatchObject({ disposition: 'quarantined', reason: 'STALE_CONTROLLER' }); expect(document.allocatedSequence).toBe(1);
    document = mergeDownload(document, offlineDownloadFixture({ ...downloaded({ clientSequence: 1, previousEventId: 'old-epoch-event' }), controller: { epoch: 2, account_id: 'manager-b', device_id: 'device-b', frozen: 0 } }));
    expect(selectAcceptedBranch(document).localState?.attendance.p2).toBe('not_recorded'); expect(selectAcceptedBranch(document).outbox).toHaveLength(1);
  });
  it('never overwrites unsynchronised local history when another controller advanced the server', () => {
    const original = queueConnectedCommand(ready(), { type: 'attendance.recorded', playerId: 'p2', status: 'present' }, sample(), 'unsynced');
    const otherState = reduceMatch(state, { type: 'attendance.recorded', playerId: 'p3', status: 'present', id: 'other-device-event', sample: sample() });
    const server = offlineDownloadFixture({ ...downloaded(), state: otherState, acceptedRevision: 1, controller: { epoch: 2, account_id: 'manager-b', device_id: 'device-b', frozen: 0 } });
    const merged = mergeDownload(original, server);
    expect(merged.localState).toBe(original.localState); expect(merged.acceptedState).toBe(otherState); expect(merged.reconciliationRequired).toBe(true); expect(merged.controllerConfirmed).toBe(false);
    expect(() => selectAcceptedBranch(merged)).toThrow('pending');
  });
  it('resumes device sequence across handover away/back without resetting rejected reservations', () => {
    let document = ready();
    document = queueConnectedCommand(document, { type: 'attendance.recorded', playerId: 'p1', status: 'present' }, sample(), 'sequence-one');
    document = prepareServiceRequest(document, 'upload', 'upload-sequence-key');
    document = applyUploadReceipt(document, { revision: 1, pendingReview: false, results: [{ eventId: 'sequence-one', clientSequence: 1, disposition: 'accepted', reason: null, revision: 1, duplicate: false }] }, new Date(now).toISOString());
    document = attachGrant(document, { epoch: 3, deviceId: 'device-a', controllerToken: 'synthetic-returned-capability', checkpoint: { clientSequence: 1, previousEventId: 'sequence-one' } });
    expect(() => queueConnectedCommand(document, { type: 'attendance.recorded', playerId: 'p2', status: 'present' }, sample(), 'not-ready')).toThrow('Download');
    const returned = reduceMatch(state, { ...document.outbox[0].envelope.command, actorId: 'server-manager' });
    document = mergeDownload(document, offlineDownloadFixture({ ...downloaded({ clientSequence: 1, previousEventId: 'sequence-one' }), state: returned, acceptedRevision: 1, controller: { epoch: 3, account_id: 'manager-a', device_id: 'device-a', frozen: 0 } }));
    document = queueConnectedCommand(document, { type: 'attendance.recorded', playerId: 'p2', status: 'present' }, sample(), 'sequence-two');
    expect(document.outbox[1].envelope).toMatchObject({ controllerEpoch: 3, clientSequence: 2, previousEventId: 'sequence-one', baseRevision: 1 });
  });
  it('missing local wire stream with existing server checkpoint requires explicit reconciliation', () => {
    const merged = mergeDownload(createConnectedDocument('device-a', state.config.matchId, ''), downloaded({ clientSequence: 8, previousEventId: 'old-event-eight' }));
    expect(merged.allocatedSequence).toBe(8); expect(merged.reconciliationRequired).toBe(true);
    expect(() => queueConnectedCommand(attachGrant(merged, { epoch: 3, deviceId: 'device-a', controllerToken: 'cap', checkpoint: merged.serverCheckpoint }), { type: 'attendance.recorded', playerId: 'p1', status: 'present' }, sample(), 'new-nine')).toThrow('reconciliation');
  });
  it('does not advance local server checkpoint for sequence-gap or ID-conflict submissions', () => {
    let document = queueConnectedCommand(ready(), { type: 'attendance.recorded', playerId: 'p1', status: 'present' }, sample(), 'gap-event');
    document = prepareServiceRequest(document, 'upload', 'upload-gap-key');
    const result = applyUploadReceipt(document, { revision: 0, pendingReview: true, results: [{ eventId: 'gap-event', clientSequence: 1, disposition: 'quarantined', reason: 'SEQUENCE_GAP_OR_REUSE', revision: null, duplicate: false }] }, new Date(now).toISOString());
    expect(result.serverCheckpoint).toEqual({ clientSequence: 0, previousEventId: null }); expect(result.outbox[0].disposition).toBe('quarantined');
    expect(() => selectAcceptedBranch(result)).toThrow('never reset');
  });
  it('actual EVENT_ID_CONFLICT receipt cannot be cleared into a guaranteed future sequence gap', () => {
    let document = queueConnectedCommand(ready(), { type: 'attendance.recorded', playerId: 'p1', status: 'present' }, sample(), 'conflicting-id');
    document = prepareServiceRequest(document, 'upload', 'id-conflict-key');
    document = applyUploadReceipt(document, { revision: 0, pendingReview: true, results: [{ eventId: 'conflicting-id', clientSequence: 1, disposition: 'quarantined', reason: 'EVENT_ID_CONFLICT', revision: null, duplicate: false }] }, new Date(now).toISOString());
    expect(document.serverCheckpoint.clientSequence).toBe(0); expect(document.allocatedSequence).toBe(1);
    expect(() => selectAcceptedBranch(document)).toThrow('never reset');
  });
  it('an older idempotent receipt never rolls back a newer downloaded accepted revision', () => {
    let document = queueConnectedCommand(ready(), { type: 'attendance.recorded', playerId: 'p1', status: 'present' }, sample(), 'accepted-earlier');
    document = prepareServiceRequest(document, 'upload', 'old-receipt-key');
    const serverState = reduceMatch(reduceMatch(state, document.outbox[0].envelope.command), { id: 'another-accepted', type: 'attendance.recorded', playerId: 'p2', status: 'present', sample: sample() });
    document = mergeDownload(document, offlineDownloadFixture({ ...downloaded({ clientSequence: 1, previousEventId: 'accepted-earlier' }), state: serverState, acceptedRevision: 2 }));
    document = applyUploadReceipt(document, { revision: 1, pendingReview: false, results: [{ eventId: 'accepted-earlier', clientSequence: 1, disposition: 'accepted', reason: null, revision: 1, duplicate: true }] }, new Date(now).toISOString());
    expect(document.acceptedRevision).toBe(2); expect(document.acceptedState?.attendance.p2).toBe('present'); expect(document.localState?.attendance.p2).toBe('not_recorded');
  });
  it('forbids a second request/command while an HTTP outcome is uncertain, and requires paused handover', () => {
    const acquiring = prepareServiceRequest(ready(), 'acquire', 'acquire-first-key');
    expect(() => prepareServiceRequest(acquiring, 'acquire', 'another-key')).toThrow('same retained');
    expect(() => queueConnectedCommand(acquiring, { type: 'attendance.recorded', playerId: 'p1', status: 'present' }, sample(), 'new-event')).toThrow('retained');
    const running = { ...ready(), localState: { ...state, status: 'first_half_running' as const } };
    expect(() => prepareServiceRequest(running, 'handover', 'handover-key', { toAccountId: 'manager-b', toDeviceId: 'device-b' })).toThrow('genuinely paused');
  });
  it('handover acknowledgement freezes local writes without deleting the capability or device stream', () => {
    const source = prepareServiceRequest(ready(), 'handover', 'offer-control-key', { toAccountId: 'manager-b', toDeviceId: 'device-b' });
    const next = applyMutationResponse(source, { transferId: 'transfer-one', state: 'pending', acceptedRevision: 0 }, new Date(now).toISOString());
    expect(next.controllerConfirmed).toBe(false); expect(next.lastTransferId).toBe('transfer-one'); expect(next.grant?.epoch).toBe(1); expect(next.allocatedSequence).toBe(0); expect(next.pendingRequest).toBeNull();
    expect(next.requestHistory.at(-1)).toMatchObject({ kind: 'handover', outcome: 'accepted', idempotencyKey: 'offer-control-key' });
  });
  it('settles only definite atomic refusals; auth/network uncertainty keeps the original pending request', () => {
    const source = prepareServiceRequest(ready(), 'acquire', 'acquire-refusal-key');
    const refused = settleDefiniteRefusal(source, new ServiceError('CONTROLLER_EXISTS', 409, 'Use handover.', false), new Date(now).toISOString());
    expect(refused.pendingRequest).toBeNull(); expect(refused.requestHistory.at(-1)).toMatchObject({ outcome: 'refused', code: 'CONTROLLER_EXISTS' });
    expect(source.pendingRequest?.idempotencyKey).toBe('acquire-refusal-key');
    expect(() => settleDefiniteRefusal(source, new ServiceError('INVALID_SESSION', 401, 'Sign in again.', false), new Date(now).toISOString())).toThrow('Sign in');
    expect(() => settleDefiniteRefusal(source, new ServiceError('SERVICE_UNAVAILABLE', 503, 'Unknown outcome.', true), new Date(now).toISOString())).toThrow('Unknown outcome');
  });
  it('keeps late-event and correction effective boundaries separate from entry/checkpoint time', () => {
    const entered: MatchEvent = { id: 'late', type: 'goal.recorded', beneficiary: 'us', scorerPlayerId: 'p2', effective: { half: 1, halfElapsedMs: 20_000, matchElapsedMs: 20_000 }, sample: sample(60_000) };
    expect(effectiveEventTime(state, { ...state, half: 1, halfActiveMs: 60_000, matchActiveMs: 60_000 }, entered)).toEqual({ half: 1, halfElapsedMs: 20_000, matchElapsedMs: 20_000 });
    const previous = { ...state, goals: [{ eventId: 'goal-original', latestEventId: 'late', beneficiary: 'us' as const, isOwnGoal: false, scorerPlayerId: 'p2', goalType: 'open_play' as const, effective: { half: 1 as const, halfElapsedMs: 20_000, matchElapsedMs: 20_000 }, recordedAtMs: now, voided: false }] };
    expect(effectiveEventTime(previous, state, { id: 'void', type: 'event.voided', targetEventId: 'goal-original', reason: 'Duplicate', sample: sample(90_000) })).toEqual({ half: 1, halfElapsedMs: 20_000, matchElapsedMs: 20_000 });
  });
  it('fails closed on identity/HTTP errors and malformed receipts without clearing pending wire records', async () => {
    const denied = new LongBallServiceClient('', async () => response(401, { code: 'INVALID_SESSION', message: 'Sign in again.' }));
    await expect(denied.me()).rejects.toMatchObject({ code: 'INVALID_SESSION', status: 401 });
    let document = queueConnectedCommand(ready(), { type: 'attendance.recorded', playerId: 'p1', status: 'present' }, sample(), 'retained'); document = prepareServiceRequest(document, 'upload', 'receipt-key');
    expect(() => applyUploadReceipt(document, { results: [], revision: 1, pendingReview: false }, new Date(now).toISOString())).toThrow('exact retained');
    expect(document.outbox[0].disposition).toBe('pending'); expect(document.pendingRequest).not.toBeNull();
  });
});

describe('engine upgrade preserves immutable older wire evidence', () => {
  it('blocks mixed-engine capture/replay while permitting exact original upload and retained version quarantine', () => {
    let old = queueConnectedCommand(ready(), { type: 'attendance.recorded', playerId: 'p1', status: 'present' }, sample(), 'v2-pending-event');
    old = { ...old, outbox: old.outbox.map(entry => ({ ...entry, envelope: { ...entry.envelope, engineVersion: 'synthetic-live-2' } })) };
    const original = JSON.stringify(old.outbox), candidate = old.localState;
    expect(() => queueConnectedCommand(old, { type: 'attendance.recorded', playerId: 'p2', status: 'present' }, sample(), 'new-v3')).toThrow('older-engine');
    const downloadedCurrent = mergeDownload(old, downloaded());
    expect(downloadedCurrent.localState).toBe(candidate); expect(downloadedCurrent.reconciliationRequired).toBe(true);
    expect(JSON.stringify(downloadedCurrent.outbox)).toBe(original);
    const request = prepareServiceRequest(old, 'upload', 'retained-v2-upload-key');
    expect((request.pendingRequest!.body as { events: { engineVersion:string }[] }).events[0].engineVersion).toBe('synthetic-live-2');
    const retained = applyUploadReceipt(request, { results: [{ eventId: 'v2-pending-event', clientSequence: 1, disposition: 'quarantined', reason: 'UNSUPPORTED_EVENT_VERSION', revision: null, duplicate: false }], revision: 0, pendingReview: true }, new Date(now).toISOString());
    expect(retained.outbox[0]).toMatchObject({ disposition: 'quarantined', reason: 'UNSUPPORTED_EVENT_VERSION', envelope: { engineVersion: 'synthetic-live-2', eventId: 'v2-pending-event', clientSequence: 1 } });
    expect(retained.localState).toBe(candidate); expect(retained.reconciliationRequired).toBe(true); expect(retained.allocatedSequence).toBe(1);
  });
});

describe('persisted controller/session clock mapping proof', () => {
  const mapping = { challengeId:'verified-challenge', policyId:'fictional-explicit-clock-trial', matchId:state.config.matchId, deviceId:'device-a', controllerEpoch:1, continuityId:'wire-session', establishedAtMs:now, validUntilMs:now+3_600_000, offsetMinimumMs:now-10, offsetMaximumMs:now+10, sampleMonotonicMs:20 };
  it('uses the retained challenge only for new same-scope samples and never rewrites an existing pending request', () => {
    const pending = prepareServiceRequest(queueConnectedCommand(ready(), {type:'attendance.recorded',playerId:'p1',status:'present'}, sample(0), 'before-exchange'), 'upload','before-exchange-key');
    const original = JSON.stringify(pending.pendingRequest), originalEnvelope = JSON.stringify(pending.outbox[0]);
    const saved = retainClockMapping(pending,mapping,sample(20));
    const reopened = JSON.parse(JSON.stringify(saved)) as ConnectedMatchDocument;
    const next = queueConnectedCommand(reopened,{type:'attendance.recorded',playerId:'p2',status:'present'},sample(30),'after-exchange');
    expect(next.outbox[1].envelope.clockEvidence.anchorId).toBe(mapping.challengeId);
    expect(JSON.stringify(next.pendingRequest)).toBe(original); expect(JSON.stringify(next.outbox[0])).toBe(originalEnvelope);
    expect(queueConnectedCommand(saved,{type:'attendance.recorded',playerId:'p2',status:'present'},{...sample(30),sessionId:'new-boot'},'new-boot-event').outbox[1].envelope.clockEvidence.anchorId).toBe('anchor-device-a');
    expect(queueConnectedCommand(saved,{type:'attendance.recorded',playerId:'p2',status:'present'},sample(3_600_001),'expired-event').outbox[1].envelope.clockEvidence.anchorId).toBe('anchor-device-a');
    expect(() => retainClockMapping(saved,{...mapping,controllerEpoch:2},sample(30))).toThrow('current controller');
    expect(() => retainClockMapping(saved,{...mapping,deviceId:'other'},sample(30))).toThrow('current controller');
    expect(() => retainClockMapping(saved,mapping,sample(3_600_001))).toThrow('lifetime');
  });
  it('clears active proof on a new epoch while retaining original proof receipts', () => {
    const saved = retainClockMapping(ready(),mapping,sample(20));
    const moved = attachGrant(saved,{epoch:2,deviceId:'device-a',controllerToken:'new-token',checkpoint:saved.serverCheckpoint});
    expect(moved.clockMapping).toBeNull(); expect(moved.clockMappingHistory).toEqual([mapping]);
  });
});
