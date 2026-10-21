import type { ClockMappingReceipt } from './clock-exchange';
import { ENGINE_VERSION, readClock, reduceMatch, type ClockSample, type MatchEvent, type MatchState } from '../../domain/src/index';

export const WIRE_CONTRACT_VERSION = 'longball.events/1.1' as const;
export interface WireEvent {
  contractVersion: typeof WIRE_CONTRACT_VERSION; schemaVersion: 1; engineVersion: string;
  eventId: string; matchId: string; deviceId: string; controllerEpoch: number;
  clientSequence: number; previousEventId: string | null; baseRevision: number;
  effectiveHalf: 0 | 1 | 2; halfElapsedMs: number; matchElapsedMs: number;
  effectiveAt: string | null; recordedAt: string; timeQuality: 'anchored' | 'estimated' | 'reviewRequired';
  clockEvidence: { monotonicMs: number; anchorId: string; continuityId: string | null };
  command: MatchEvent;
}
export interface WireReceipt { eventId: string; clientSequence: number; disposition: 'accepted' | 'quarantined'; reason: string | null; revision: number | null; duplicate: boolean }
export interface UploadReceipt { results: WireReceipt[]; revision: number; pendingReview: boolean }
export interface DeviceCheckpoint { clientSequence: number; previousEventId: string | null }
export interface ControllerGrant { epoch: number; deviceId: string; controllerToken: string; checkpoint: DeviceCheckpoint; reconciliationRequired?: boolean }
export interface MatchDownload {
  contractVersion: typeof WIRE_CONTRACT_VERSION; schemaVersion: 1; engineVersion: string;
  matchId: string; state: MatchState; acceptedRevision: number; deviceCheckpoint: DeviceCheckpoint;
  controller: { epoch: number; account_id: string; device_id: string; frozen: number } | null;
  downloadedAt: string;
  clockAnchor: { serverTime: string; quality: 'observation_only'; continuousMappingEstablished: false };
  syntheticOnly: boolean;
}
export interface CanonicalOutboxEntry {
  envelope: WireEvent;
  disposition: 'pending' | 'accepted' | 'quarantined';
  reason: string | null;
  acceptedRevision: number | null;
}
export interface DurableRequest { idempotencyKey: string; path: string; body: unknown; kind: 'acquire' | 'upload' | 'handover' | 'accept' | 'recover' | 'reconciliation_proposal' | 'clock_exchange' }
/** This namespace is independent of the legacy M0 local-command journal stream. */
export interface ConnectedMatchDocument {
  revision: number;
  kind: 'longball-canonical-connected-v1';
  baseUrl: string;
  matchId: string;
  deviceId: string;
  acceptedState: MatchState | null;
  localState: MatchState | null;
  acceptedRevision: number;
  /** Grants and receipts require an authenticated snapshot before more recording. */
  authoritativeDownloadRequired?: boolean;
  /** Initial enrollment/handover needs its new snapshot; a known accepted prefix can capture offline suffixes. */
  captureBlockedUntilDownload?: boolean;
  allocatedSequence: number;
  previousEventId: string | null;
  serverCheckpoint: DeviceCheckpoint;
  outbox: CanonicalOutboxEntry[];
  grant: ControllerGrant | null;
  clockMapping?: ClockMappingReceipt | null;
  clockMappingHistory?: ClockMappingReceipt[];
  controllerConfirmed: boolean;
  reconciliationRequired: boolean;
  downloadedAt: string | null;
  pendingRequest: DurableRequest | null;
  lastReceiptAt: string | null;
  lastTransferId: string | null;
  requestHistory: { idempotencyKey: string; kind: DurableRequest['kind']; outcome: 'accepted' | 'refused'; code: string | null; recordedAt: string }[];
}
export type ConnectedCommand = MatchEvent extends infer Event ? Event extends MatchEvent ? Omit<Event, 'id' | 'sample' | 'actorId'> : never : never;
export interface HttpResponse { status: number; ok: boolean; json(): Promise<unknown> }
export type HttpFetch = (url: string, options: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<HttpResponse>;
export class ServiceError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly retryable: boolean) { super(message); this.name = 'ServiceError'; }
}

export function effectiveEventTime(previous: MatchState, next: MatchState, event: MatchEvent): { half: 0 | 1 | 2; halfElapsedMs: number; matchElapsedMs: number } {
  let effective: { half: 1 | 2; halfElapsedMs: number; matchElapsedMs: number } | null | undefined;
  if (event.type === 'goal.recorded' || event.type === 'availability.changed' || event.type === 'lineup.committed') effective = event.effective;
  if (event.type === 'event.corrected') effective = event.replacement.effective;
  if ((event.type === 'event.corrected' || event.type === 'event.voided') && !effective) {
    const goal = previous.goals?.find(record => record.eventId === event.targetEventId || record.latestEventId === event.targetEventId);
    const availability = previous.availabilityHistory?.find(record => record.eventId === event.targetEventId || record.latestEventId === event.targetEventId);
    effective = goal?.effective ?? availability?.effective;
    if (!effective) {
      const target = previous.audit?.find(record => record.eventId === event.targetEventId);
      effective = target?.effective;
    }
  }
  return effective ? { half: effective.half, halfElapsedMs: effective.halfElapsedMs, matchElapsedMs: effective.matchElapsedMs } : { half: next.half, halfElapsedMs: next.halfActiveMs, matchElapsedMs: next.matchActiveMs };
}

/** Authentication is supplied by an adapter; this module never stores or logs bearer tokens. */
export class LongBallServiceClient {
  readonly baseUrl: string;
  constructor(baseUrl: string, readonly authenticatedFetch: HttpFetch, readonly requestTimeoutMs = 15_000) {
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 120_000) throw new Error('Use a bounded service timeout between1 and120000 milliseconds.');
    const trimmed = baseUrl.trim().replace(/\/$/, '');
    if (trimmed && !/^https?:\/\/[^/?#]+(?::\d+)?(?:\/[^?#]*)?$/.test(trimmed)) throw new Error('Use an absolute HTTP(S) service base URL or / for the same origin.');
    if (trimmed) { const parsed = new URL(trimmed); if (parsed.username || parsed.password) throw new Error('Service URL must not contain credentials. Use the authentication adapter.'); }
    this.baseUrl = trimmed === '/' ? '' : trimmed;
  }
  async request<T>(path: string, options: { request?: DurableRequest; controllerToken?: string } = {}): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new ServiceError('REQUEST_TIMEOUT', 0, 'The service request timed out. Its original key and payload remain retained for retry.', true)); controller.abort(); }, this.requestTimeoutMs); });
    try { return await Promise.race([this.exchange<T>(path, options, controller.signal), timeout]); }
    finally { clearTimeout(timer); }
  }
  private async exchange<T>(path: string, options: { request?: DurableRequest; controllerToken?: string }, signal: AbortSignal): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.request) { headers['Content-Type'] = 'application/json'; headers['X-Api-Contract-Version'] = WIRE_CONTRACT_VERSION; headers['Idempotency-Key'] = options.request.idempotencyKey; }
    if (options.controllerToken) headers['X-Controller-Token'] = options.controllerToken;
    const response = await this.authenticatedFetch(`${this.baseUrl}${path}`, { method: options.request ? 'POST' : 'GET', headers, signal, ...(options.request ? { body: JSON.stringify(options.request.body) } : {}) });
    let body: unknown;
    try { body = await response.json(); }
    catch { throw new ServiceError('INVALID_RESPONSE', response.status, 'The service did not return JSON. Check the configured API URL; the browser review page alone is not an API.', response.status >= 500); }
    // Event quarantine is a meaningful committed409 receipt, not a transient HTTP failure.
    if (response.status === 409 && body && typeof body === 'object' && 'results' in body && Array.isArray(body.results)) return body as T;
    if (!response.ok) {
      const failure = body && typeof body === 'object' ? body as { code?: unknown; message?: unknown; retryable?: unknown } : {};
      throw new ServiceError(typeof failure.code === 'string' ? failure.code : 'HTTP_FAILURE', response.status, typeof failure.message === 'string' ? failure.message : 'The service request failed.', failure.retryable === true || response.status >= 500 || response.status === 429);
    }
    return body as T;
  }
  me<T = { accountId: string; syntheticOnly: boolean }>(): Promise<T> { return this.request('/v1/me'); }
  download(matchId: string, deviceId: string): Promise<MatchDownload> { return this.request(`/v1/matches/${encodeURIComponent(matchId)}/download?deviceId=${encodeURIComponent(deviceId)}`); }
  quarantine(matchId: string): Promise<{ items: unknown[] }> { return this.request(`/v1/matches/${encodeURIComponent(matchId)}/quarantine`); }
  execute<T>(request: DurableRequest, grant: ControllerGrant | null): Promise<T> { return this.request(request.path, { request, ...(grant ? { controllerToken: grant.controllerToken } : {}) }); }
}

export function createConnectedDocument(deviceId: string, matchId: string, baseUrl: string): ConnectedMatchDocument {
  return { revision: 0, kind: 'longball-canonical-connected-v1', baseUrl, matchId, deviceId, acceptedState: null, localState: null, acceptedRevision: 0, authoritativeDownloadRequired: true, captureBlockedUntilDownload: true, allocatedSequence: 0, previousEventId: null, serverCheckpoint: { clientSequence: 0, previousEventId: null }, outbox: [], grant: null, controllerConfirmed: false, reconciliationRequired: false, downloadedAt: null, pendingRequest: null, lastReceiptAt: null, lastTransferId: null, requestHistory: [] };
}
export function assertConnectedDocument(value: ConnectedMatchDocument): void {
  if (value.kind !== 'longball-canonical-connected-v1' || !Number.isSafeInteger(value.revision) || !value.deviceId || !value.matchId || !Array.isArray(value.outbox) || !Number.isSafeInteger(value.allocatedSequence) || value.allocatedSequence < 0) throw new Error('Connected rehearsal document is incompatible. Preserve it for recovery; no legacy M0 data is uploaded.');
  const ids = new Set<string>();
  for (const entry of value.outbox) {
    if (entry.envelope.matchId !== value.matchId || entry.envelope.deviceId !== value.deviceId || ids.has(entry.envelope.eventId) || entry.envelope.clientSequence > value.allocatedSequence) throw new Error('Canonical outbox chain is inconsistent. Preserve it for reconciliation.');
    ids.add(entry.envelope.eventId);
  }
}

export function mergeDownload(previous: ConnectedMatchDocument, download: MatchDownload): ConnectedMatchDocument {
  if (download.contractVersion !== WIRE_CONTRACT_VERSION || download.schemaVersion !== 1 || download.engineVersion !== ENGINE_VERSION || download.matchId !== previous.matchId || download.state.config.matchId !== previous.matchId) throw new Error('Downloaded contract/engine/match differs from this client. Existing journal retained.');
  const pending = previous.outbox.some(entry => entry.disposition === 'pending');
  const controller = download.controller;
  const assigned = Boolean(previous.grant && controller && controller.device_id === previous.deviceId && controller.epoch === previous.grant.epoch && !controller.frozen);
  const disagreement = pending && download.acceptedRevision !== previous.acceptedRevision;
  const serverAhead = download.deviceCheckpoint.clientSequence > previous.allocatedSequence;
  const checkpointBehindKnownReceipt = download.deviceCheckpoint.clientSequence < previous.serverCheckpoint.clientSequence;
  const missingLocalStream = previous.downloadedAt === null && previous.outbox.length === 0 && download.deviceCheckpoint.clientSequence > 0;
  const quarantined = previous.outbox.some(entry => entry.disposition === 'quarantined');
  let localState = pending || quarantined ? previous.localState ?? download.state : download.state;
  let replayFailed = false;
  // A receipt can confirm a prefix while newer actual events remain local. Rebase only
  // an exact contiguous suffix, preserving every original wire envelope and identity.
  if (pending && !quarantined && assigned && !disagreement && !checkpointBehindKnownReceipt && !missingLocalStream && !previous.reconciliationRequired) {
    try {
      let projection = download.state;
      let checkpoint = download.deviceCheckpoint;
      for (const entry of previous.outbox.filter(item => item.disposition === 'pending')) {
        const envelope = entry.envelope;
        if (envelope.engineVersion !== ENGINE_VERSION) throw new Error('The original pending engine version requires explicit review; never relabel old wire evidence.');
        if (envelope.clientSequence !== checkpoint.clientSequence + 1 || envelope.previousEventId !== checkpoint.previousEventId || envelope.baseRevision !== projection.revision || envelope.controllerEpoch !== previous.grant?.epoch) throw new Error('Suffix differs from the accepted checkpoint.');
        const next = reduceMatch(projection, envelope.command);
        const effective = effectiveEventTime(projection, next, envelope.command);
        if (effective.half !== envelope.effectiveHalf || effective.halfElapsedMs !== envelope.halfElapsedMs || effective.matchElapsedMs !== envelope.matchElapsedMs) throw new Error('Suffix effective time differs.');
        projection = next;
        checkpoint = { clientSequence: envelope.clientSequence, previousEventId: envelope.eventId };
      }
      localState = projection;
    } catch { replayFailed = true; }
  }
  return {
    ...previous, acceptedState: download.state, acceptedRevision: download.acceptedRevision, authoritativeDownloadRequired: false, captureBlockedUntilDownload: false,
    localState,
    allocatedSequence: Math.max(previous.allocatedSequence, download.deviceCheckpoint.clientSequence),
    previousEventId: serverAhead ? download.deviceCheckpoint.previousEventId : previous.previousEventId,
    serverCheckpoint: download.deviceCheckpoint, controllerConfirmed: assigned,
    reconciliationRequired: previous.reconciliationRequired || disagreement || checkpointBehindKnownReceipt || missingLocalStream || replayFailed || pending && !assigned || pending && serverAhead,
    downloadedAt: download.downloadedAt,
  };
}

export function attachGrant(document: ConnectedMatchDocument, grant: ControllerGrant): ConnectedMatchDocument {
  if (grant.deviceId !== document.deviceId || !Number.isSafeInteger(grant.epoch) || grant.epoch < 1 || !grant.controllerToken || grant.checkpoint.clientSequence < document.serverCheckpoint.clientSequence) throw new Error('Controller grant/checkpoint differs from this device. Reconciliation is required.');
  const pending = document.outbox.some(entry => entry.disposition === 'pending');
  const movedEpoch = document.grant && document.grant.epoch !== grant.epoch;
  const serverAhead = grant.checkpoint.clientSequence > document.allocatedSequence;
  return { ...document, grant, clockMapping: document.clockMapping?.controllerEpoch === grant.epoch ? document.clockMapping : null, controllerConfirmed: true, authoritativeDownloadRequired: true, captureBlockedUntilDownload: true,
    allocatedSequence: Math.max(document.allocatedSequence, grant.checkpoint.clientSequence),
    previousEventId: serverAhead ? grant.checkpoint.previousEventId : document.previousEventId,
    serverCheckpoint: grant.checkpoint,
    reconciliationRequired: document.reconciliationRequired || grant.reconciliationRequired === true || Boolean(pending && (movedEpoch || serverAhead)),
    pendingRequest: null,
  };
}

/** Retain the server receipt without changing a previously allocated envelope. */
export function retainClockMapping(document: ConnectedMatchDocument, mapping: ClockMappingReceipt, sample: ClockSample): ConnectedMatchDocument {
  if (!document.controllerConfirmed || !document.grant || document.reconciliationRequired || mapping.matchId !== document.matchId || mapping.deviceId !== document.deviceId || mapping.controllerEpoch !== document.grant.epoch || mapping.continuityId !== sample.sessionId || !/^[a-zA-Z0-9_-]{1,150}$/.test(mapping.challengeId) || !mapping.policyId || ![mapping.establishedAtMs,mapping.validUntilMs,mapping.offsetMinimumMs,mapping.offsetMaximumMs,mapping.sampleMonotonicMs].every(Number.isFinite) || mapping.validUntilMs <= mapping.establishedAtMs || mapping.offsetMaximumMs < mapping.offsetMinimumMs || sample.monotonicMs < mapping.sampleMonotonicMs || !mappingWithinLifetime(mapping, sample)) throw new Error('Clock receipt differs from the current controller, continuous session or original lifetime. Existing clock evidence is retained.');
  const existing = document.clockMappingHistory?.find(item => item.challengeId === mapping.challengeId);
  if (existing && JSON.stringify(existing) !== JSON.stringify(mapping)) throw new Error('Clock mapping identity was reused with different evidence. Retain both for review.');
  return { ...document, clockMapping: { ...mapping }, clockMappingHistory: existing ? document.clockMappingHistory : [...document.clockMappingHistory ?? [], { ...mapping }] };
}
function mappingWithinLifetime(mapping: ClockMappingReceipt, sample: ClockSample): boolean {
  return Number.isFinite(sample.monotonicMs) && sample.monotonicMs >= mapping.sampleMonotonicMs && sample.monotonicMs - mapping.sampleMonotonicMs <= mapping.validUntilMs - mapping.establishedAtMs && sample.monotonicMs + mapping.offsetMaximumMs <= mapping.validUntilMs;
}
function currentClockAnchor(document: ConnectedMatchDocument, sample: ClockSample): string {
  const mapping = document.clockMapping;
  return mapping && mapping.matchId === document.matchId && mapping.deviceId === document.deviceId && mapping.controllerEpoch === document.grant?.epoch && mapping.continuityId === sample.sessionId && mappingWithinLifetime(mapping, sample) ? mapping.challengeId : `anchor-${document.deviceId}`;
}

function assertCaptureAllowed(document: ConnectedMatchDocument): void {
  if (document.outbox.some(entry => entry.disposition === 'pending' && entry.envelope.engineVersion !== ENGINE_VERSION)) throw new Error('An older-engine pending stream is retained byte-for-byte. Submit its original upload for version quarantine or review it explicitly before recording with the new engine.');
  if (!document.localState || !document.grant || !document.controllerConfirmed) throw new Error('Download the match and acquire/accept its explicit controller capability before recording.');
  if (document.reconciliationRequired || document.pendingRequest && document.pendingRequest.kind !== 'upload') throw new Error('Resolve the retained request or reconciliation branch before recording another command.');
  if (document.captureBlockedUntilDownload ?? document.authoritativeDownloadRequired) throw new Error('Download the authoritative accepted snapshot before recording another command.');
  if (document.pendingRequest) {
    const request = document.pendingRequest;
    const body = request.body as { events?: WireEvent[] } | null;
    const queued = document.outbox.filter(entry => entry.disposition === 'pending');
    if (request.path !== `/v1/matches/${encodeURIComponent(document.matchId)}/events` || !Array.isArray(body?.events) || body.events.length === 0 || body.events.length > 100 || body.events.some((event, index) => JSON.stringify(event) !== JSON.stringify(queued[index]?.envelope))) throw new Error('The retained upload is not an exact queued prefix. Preserve it for reconciliation before recording.');
  }
}
export function canCaptureConnectedEvents(document: ConnectedMatchDocument): boolean {
  try { assertCaptureAllowed(document); return true; } catch { return false; }
}
export function queueConnectedCommand(document: ConnectedMatchDocument, command: ConnectedCommand, sample: ClockSample, eventId: string): ConnectedMatchDocument {
  assertCaptureAllowed(document);
  if (!document.localState || !document.grant) throw new Error('The controller match is unavailable.');
  if (!/^[a-zA-Z0-9_-]{1,150}$/.test(eventId) || !/^[a-zA-Z0-9_-]{1,150}$/.test(sample.sessionId)) throw new Error('Canonical event and clock continuity identifiers must be valid wire ids.');
  if (document.outbox.some(entry => entry.envelope.eventId === eventId)) throw new Error('Event identifier is already reserved.');
  const event = { ...command, id: eventId, sample } as MatchEvent;
  const next = reduceMatch(document.localState, event);
  const effective = effectiveEventTime(document.localState, next, event);
  const envelope: WireEvent = {
    contractVersion: WIRE_CONTRACT_VERSION, schemaVersion: 1, engineVersion: ENGINE_VERSION,
    eventId, matchId: document.matchId, deviceId: document.deviceId, controllerEpoch: document.grant.epoch,
    clientSequence: document.allocatedSequence + 1, previousEventId: document.previousEventId,
    baseRevision: document.localState.revision,
    effectiveHalf: effective.half, halfElapsedMs: effective.halfElapsedMs, matchElapsedMs: effective.matchElapsedMs,
    effectiveAt: null, recordedAt: new Date(sample.wallTimeMs).toISOString(), timeQuality: 'reviewRequired',
    clockEvidence: { monotonicMs: sample.monotonicMs, anchorId: currentClockAnchor(document, sample), continuityId: sample.sessionId }, command: event,
  };
  return { ...document, localState: next, allocatedSequence: envelope.clientSequence, previousEventId: eventId,
    outbox: [...document.outbox, { envelope, disposition: 'pending', reason: null, acceptedRevision: null }] };
}

export function prepareServiceRequest(document: ConnectedMatchDocument, kind: DurableRequest['kind'], idempotencyKey: string, details: Record<string, unknown> = {}): ConnectedMatchDocument {
  if (kind === 'reconciliation_proposal' || kind === 'clock_exchange') throw new Error('History proposals use their separate durable review document, not the controller request stream.');
  if (document.pendingRequest) throw new Error('Retry the same retained HTTP request before creating another.');
  if (!/^[a-zA-Z0-9_-]{8,150}$/.test(idempotencyKey)) throw new Error('Use a stable canonical idempotency key.');
  const base = `/v1/matches/${encodeURIComponent(document.matchId)}`;
  let path = base; let body: unknown;
  if (kind === 'upload') {
    const events = document.outbox.filter(entry => entry.disposition === 'pending').slice(0, 100).map(entry => entry.envelope);
    if (!events.length || !document.grant) throw new Error('No canonical pending events or controller capability to upload.');
    body = { events }; path += '/events';
  } else if (kind === 'acquire') { body = { deviceId: document.deviceId }; path += '/controller'; }
  else if (kind === 'accept') { if (typeof details.transferId !== 'string' || !details.transferId) throw new Error('Transfer id is required.'); body = { deviceId: document.deviceId }; path += `/handover/${encodeURIComponent(details.transferId)}/accept`; }
  else if (kind === 'recover') { if (details.confirmUnsynchronisedRisk !== true || typeof details.reason !== 'string' || !details.reason.trim()) throw new Error('Recovery needs an explicit unsynchronised-history acknowledgement and reason.'); body = { deviceId: document.deviceId, reason: details.reason, confirmUnsynchronisedRisk: true }; path += '/recover'; }
  else {
    if (document.outbox.some(entry => entry.disposition === 'pending') || document.reconciliationRequired || !document.localState || document.localState.status.endsWith('_running')) throw new Error('Synchronise and use a genuinely paused/preparation/half-time checkpoint before this development handover. Running handover needs verified cross-device clock mapping.');
    body = { toAccountId: details.toAccountId, toDeviceId: details.toDeviceId, baseRevision: document.acceptedRevision }; path += '/handover';
  }
  return { ...document, pendingRequest: { idempotencyKey, kind, path, body } };
}

export function applyUploadReceipt(document: ConnectedMatchDocument, receipt: UploadReceipt, receivedAt: string): ConnectedMatchDocument {
  if (document.pendingRequest?.kind !== 'upload') throw new Error('No retained upload request matches this receipt.');
  const sent = (document.pendingRequest.body as { events: WireEvent[] }).events;
  if (!Number.isSafeInteger(receipt.revision) || receipt.revision < 0 || !Array.isArray(receipt.results) || receipt.results.some(result => !['accepted', 'quarantined'].includes(result.disposition) || !(result.reason === null || typeof result.reason === 'string') || !(result.revision === null || Number.isSafeInteger(result.revision))) || receipt.results.length !== sent.length || receipt.results.some((result, index) => result.eventId !== sent[index].eventId || result.clientSequence !== sent[index].clientSequence)) throw new Error('Receipt does not cover the exact retained ordered batch. Keep the outbox for retry/reconciliation.');
  const receiptMap = new Map(receipt.results.map(result => [result.eventId, result]));
  // A receipt confirms dispositions/revision, but carries no server-bound actor/provenance.
  // Only an authenticated download may replace the accepted projection and its audit.
  const acceptedState = document.acceptedState;
  const fenced = receipt.results.some(result => ['STALE_CONTROLLER', 'HANDOVER_WRITES_FROZEN'].includes(result.reason ?? ''));
  const quarantine = receipt.results.some(result => result.disposition === 'quarantined');
  const reserved = receipt.results.filter(result => result.reason !== 'SEQUENCE_GAP_OR_REUSE' && result.reason !== 'EVENT_ID_CONFLICT').sort((left, right) => right.clientSequence - left.clientSequence)[0];
  const checkpoint = reserved && reserved.clientSequence >= document.serverCheckpoint.clientSequence ? { clientSequence: reserved.clientSequence, previousEventId: reserved.eventId } : document.serverCheckpoint;
  return { ...document, acceptedState, acceptedRevision: Math.max(document.acceptedRevision, receipt.revision), authoritativeDownloadRequired: true,
    outbox: document.outbox.map(entry => { const result = receiptMap.get(entry.envelope.eventId); return result ? { ...entry, disposition: result.disposition, reason: result.reason, acceptedRevision: result.revision } : entry; }),
    serverCheckpoint: checkpoint,
    controllerConfirmed: document.controllerConfirmed && !fenced,
    reconciliationRequired: document.reconciliationRequired || quarantine,
    pendingRequest: null, lastReceiptAt: receivedAt, requestHistory: [...(document.requestHistory ?? []), { idempotencyKey: document.pendingRequest.idempotencyKey, kind: 'upload', outcome: 'accepted', code: null, recordedAt: receivedAt }],
  };
}

/** An explicit read of the accepted branch never deletes the candidate/outbox audit. */
export function selectAcceptedBranch(document: ConnectedMatchDocument): ConnectedMatchDocument {
  if (document.outbox.some(entry => entry.disposition === 'quarantined' && ['SEQUENCE_GAP_OR_REUSE', 'EVENT_ID_CONFLICT'].includes(entry.reason ?? ''))) throw new Error('Stream identity/sequence conflict needs authorised checkpoint reconciliation or a new enrolled device. Reserved sequence numbers are never reset.');
  if (!document.acceptedState || document.authoritativeDownloadRequired || document.acceptedState.revision !== document.acceptedRevision) throw new Error('Download the current authoritative accepted snapshot before selecting its branch; a receipt alone does not establish its actor-bound audit.');
  if (!document.acceptedState || document.outbox.some(entry => entry.disposition === 'pending') || document.pendingRequest) throw new Error('Upload/reconcile every uncertain pending request before selecting the accepted checkpoint.');
  return { ...document, localState: document.acceptedState, reconciliationRequired: document.grant?.reconciliationRequired === true };
}

export function connectedClock(document: ConnectedMatchDocument, sample: ClockSample) { return document.localState ? readClock(document.localState, sample) : null; }


export function applyMutationResponse(document: ConnectedMatchDocument, response: unknown, receivedAt: string): ConnectedMatchDocument {
  const request = document.pendingRequest;
  if (!request) throw new Error('No retained mutation request matches the response.');
  if (request.kind === 'reconciliation_proposal' || request.kind === 'clock_exchange') throw new Error('Proposal receipts belong to the separate review document; controller authority is unchanged.');
  if (request.kind === 'upload') return applyUploadReceipt(document, response as UploadReceipt, receivedAt);
  if (!response || typeof response !== 'object') throw new Error('Mutation returned an invalid response; retain the original request.');
  let next: ConnectedMatchDocument;
  if (request.kind === 'handover') {
    const transferId = (response as { transferId?: unknown }).transferId;
    if (typeof transferId !== 'string' || !transferId) throw new Error('Transfer response has no transfer id. Original request retained.');
    next = { ...document, pendingRequest: null, controllerConfirmed: false, lastTransferId: transferId };
  } else next = attachGrant(document, response as ControllerGrant);
  return { ...next, lastReceiptAt: receivedAt, requestHistory: [...(document.requestHistory ?? []), { idempotencyKey: request.idempotencyKey, kind: request.kind, outcome: 'accepted', code: null, recordedAt: receivedAt }] };
}

/** Only atomic precondition refusals can settle a request. Network/auth uncertainty stays pending. */
export function settleDefiniteRefusal(document: ConnectedMatchDocument, failure: ServiceError, receivedAt: string): ConnectedMatchDocument {
  const safeCodes = ['CONTROLLER_EXISTS', 'STALE_REVISION', 'CLOCK_ANCHOR_REQUIRED', 'TRANSFER_PENDING', 'TRANSFER_CONFLICT', 'RECOVERY_CONFIRMATION_REQUIRED', 'INVALID_REQUEST', 'CONTRACT_VERSION_REQUIRED', 'COMMAND_REJECTED'];
  if (!document.pendingRequest || !safeCodes.includes(failure.code) || failure.status < 400 || failure.status >= 500 || [401, 403, 404, 429].includes(failure.status)) throw failure;
  return { ...document, pendingRequest: null, requestHistory: [...(document.requestHistory ?? []), { idempotencyKey: document.pendingRequest.idempotencyKey, kind: document.pendingRequest.kind, outcome: 'refused', code: failure.code, recordedAt: receivedAt }] };
}
