import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createMatch, ENGINE_VERSION, reduceMatch } from '../../domain/src/index';
import { canonicalOfflineJson, MAX_OFFLINE_EVENTS, offlineChecksum, offlineUtf8, sealOfflineSnapshot } from './offline-bundle';
import { offlineDownloadFixture } from './offline-bundle.test-fixture';
import { assertConnectedDocument, attachGrant, canCaptureConnectedEvents, createConnectedDocument, mergeDownload, prepareServiceRequest, queueConnectedCommand, type MatchDownload } from './sync';

const date = '2026-10-21T12:00:00.000Z';
const sample = { monotonicMs: 0, sessionId: 'snapshot-session', wallTimeMs: Date.parse(date) };
function snapshot(): MatchDownload {
  const state = createMatch({ matchId: 'snapshot-match', players: Array.from({ length: 7 }, (_, index) => ({ id: `p${index}`, displayName: `Player ${index}`, goalkeeperChoice: 0 })), selectedPlayerIds: Array.from({ length: 7 }, (_, index) => `p${index}`), pitchPlaces: 7, plannedHalfDurationMs: 1_500_000, fixedKeeperId: null });
  return offlineDownloadFixture({ contractVersion: 'longball.events/1.1', schemaVersion: 1, engineVersion: ENGINE_VERSION, matchId: state.config.matchId, state, acceptedRevision: 0, deviceCheckpoint: { clientSequence: 0, previousEventId: null }, controller: { epoch: 1, account_id: 'manager', device_id: 'device-a', frozen: 0 }, downloadedAt: date, clockAnchor: { serverTime: date, quality: 'observation_only', continuousMappingEstablished: false }, syntheticOnly: true });
}
function ready() {
  return mergeDownload(attachGrant(createConnectedDocument('device-a', 'snapshot-match', '/'), { epoch: 1, deviceId: 'device-a', controllerToken: 'local-capability', checkpoint: { clientSequence: 0, previousEventId: null } }), snapshot());
}
describe('DS10 complete, versioned atomic offline snapshot', () => {
  it('has deterministic UTF-8/SHA-256 vectors independent of locale, insertion order and host encoders', () => {
    vi.stubGlobal('TextEncoder', undefined); vi.stubGlobal('crypto', undefined);
    try {
    expect(offlineChecksum('abc')).toBe(createHash('sha256').update('"abc"').digest('hex'));
    const values = [{ z: -0, a: 'Roma ⚽\n\u0000', 'é': [true, null, 1e-7], '😀': '\ud800' }, { '😀': '\ud800', 'é': [true, null, 1e-7], a: 'Roma ⚽\n\u0000', z: 0 }];
    const canonical = '{"a":"Roma ⚽\\n\\u0000","z":0,"é":[true,null,1e-7],"😀":"\\ud800"}';
    for (const value of values) { expect(canonicalOfflineJson(value)).toBe(canonical); expect(offlineUtf8(canonical)).toEqual(new Uint8Array(Buffer.from(canonical))); expect(offlineChecksum(value)).toBe(createHash('sha256').update(canonical).digest('hex')); }
    } finally { vi.unstubAllGlobals(); }
  });
  it('rejects ambiguous non-JSON values, sparse arrays, cycles and accessors rather than silently coercing them', () => {
    const cycle: unknown[] = []; cycle.push(cycle);
    for (const value of [undefined, NaN, Infinity, 1n, () => 1, new Date(), { a: undefined }, new Array(2), cycle, Object.defineProperty({}, 'a', { get() { throw new Error('must not execute'); }, enumerable: true })]) expect(() => canonicalOfflineJson(value)).toThrow();
  });
  it('detects changed score, rules, scope, publication and clock bytes before touching pending requests or candidates', () => {
    const before = prepareServiceRequest(queueConnectedCommand(ready(), { type: 'attendance.recorded', playerId: 'p0', status: 'present' }, sample, 'pending-one'), 'upload', 'stable-pending-key');
    const retained = JSON.stringify(before);
    const corruptions: ((value: MatchDownload) => void)[] = [value => { value.state.score.for++; }, value => { value.state.config.pitchPlaces = 8; }, value => { value.teamId = 'another-team'; }, value => { value.publication.sharingPolicy.shareScores = true; }, value => { value.clockAnchor.serverTime = '2026-10-22T12:00:00.000Z'; }];
    for (const corrupt of corruptions) { const value = structuredClone(snapshot()); corrupt(value); expect(() => mergeDownload(before, value)).toThrow(); expect(JSON.stringify(before)).toBe(retained); }
  });
  it('rejects a correctly hashed incomplete or inconsistent revision/history/checkpoint and unsupported schema', () => {
    const base = snapshot(); const state = reduceMatch(base.state, { id: 'accepted-one', type: 'attendance.recorded', playerId: 'p0', status: 'present', sample });
    const full = offlineDownloadFixture({ ...base, state, acceptedRevision: 1 });
    for (const value of [{ ...full, acceptedRevision: 2 }, { ...full, acceptedEvents: [] }, { ...full, acceptedEvents: [full.acceptedEvents[0], full.acceptedEvents[0]] }, { ...full, deviceCheckpoint: { clientSequence: 0, previousEventId: 'invalid-zero' } }, { ...full, snapshotSchemaVersion: 2 }]) expect(() => mergeDownload(ready(), sealOfflineSnapshot(value) as MatchDownload)).toThrow();
    expect(mergeDownload(ready(), full).acceptedRevision).toBe(1);
  });
  it('binds a valid checksum to the actual requested device and match, never a caller-selected substitute', () => {
    for (const patch of [{ deviceId: 'another-device' }, { matchId: 'another-match' }, { teamId: 'another-team' }, { seasonId: 'another-season' }]) expect(() => mergeDownload(ready(), sealOfflineSnapshot({ ...snapshot(), ...patch }))).toThrow();
  });
  it('preserves old installed caches and immutable old-engine pending bytes, requiring a verified refresh before capture', () => {
    const original = queueConnectedCommand(ready(), { type: 'attendance.recorded', playerId: 'p0', status: 'present' }, sample, 'original-v3');
    const legacy = { ...original, verifiedSnapshot: undefined };
    const bytes = JSON.stringify(legacy.outbox); expect(canCaptureConnectedEvents(legacy)).toBe(false);
    const invalid = { ...snapshot() } as Partial<MatchDownload>; delete invalid.checksumSha256;
    expect(() => mergeDownload(legacy, invalid as MatchDownload)).toThrow(); expect(JSON.stringify(legacy.outbox)).toBe(bytes);
    expect(canCaptureConnectedEvents(mergeDownload(legacy, snapshot()))).toBe(true);
    const old = { ...legacy, outbox: legacy.outbox.map(entry => ({ ...entry, envelope: { ...entry.envelope, engineVersion: 'synthetic-live-3' } })) };
    const preserved = JSON.stringify(old.outbox); const merged = mergeDownload(old, snapshot()); expect(JSON.stringify(merged.outbox)).toBe(preserved); expect(merged.reconciliationRequired).toBe(true); expect(canCaptureConnectedEvents(merged)).toBe(false);
  });
  it('retains historical accepted engine labels as evidence without relabelling them', () => {
    const base = snapshot(); const state = reduceMatch(base.state, { id: 'historical-v3', type: 'attendance.recorded', playerId: 'p0', status: 'present', sample });
    const full = offlineDownloadFixture({ ...base, state, acceptedRevision: 1 }); full.acceptedEvents[0].event.engineVersion = 'synthetic-live-3';
    expect(mergeDownload(ready(), sealOfflineSnapshot(full)).acceptedState?.revision).toBe(1); expect(full.acceptedEvents[0].event.engineVersion).toBe('synthetic-live-3');
  });
  it('durably retains and revalidates the complete bundle metadata/history after JSON reload', () => {
    const saved = ready(); const reloaded = JSON.parse(JSON.stringify(saved)) as typeof saved;
    expect(reloaded.installedSnapshot?.publication).toEqual(snapshot().publication); expect(reloaded.installedSnapshot?.checksumSha256).toBe(snapshot().checksumSha256);
    expect(() => assertConnectedDocument(reloaded)).not.toThrow(); expect(canCaptureConnectedEvents(reloaded)).toBe(true);
    reloaded.acceptedState!.score.for++;
    expect(() => assertConnectedDocument(reloaded)).toThrow(); expect(saved.acceptedState!.score.for).toBe(0);
  });
  it('explicitly downgrades stale-capability refreshes to viewing without erasing an uncertain original upload', () => {
    const before = prepareServiceRequest(queueConnectedCommand(ready(), { type: 'attendance.recorded', playerId: 'p0', status: 'present' }, sample, 'retained-old-recorder'), 'upload', 'old-recorder-upload-key');
    const refreshed = mergeDownload(before, snapshot(), { observationOnly: true });
    expect(refreshed.controllerConfirmed).toBe(false); expect(canCaptureConnectedEvents(refreshed)).toBe(false);
    expect(refreshed.outbox).toBe(before.outbox); expect(refreshed.pendingRequest).toBe(before.pendingRequest); expect(refreshed.grant).toBe(before.grant); expect(refreshed.localState).toBe(before.localState);
    expect(refreshed.acceptedState).not.toBeNull(); expect(refreshed.authoritativeDownloadRequired).toBe(false);
  });
  it('fails closed beyond the complete-history record bound, without truncation', () => {
    const tooMany = { ...snapshot(), acceptedEvents: Array(MAX_OFFLINE_EVENTS + 1).fill(null) } as MatchDownload;
    expect(() => mergeDownload(ready(), tooMany)).toThrow();
  });
  it('supports all10000 accepted records including long allowed reason strings without a tighter byte cap', () => {
    const base = snapshot();
    const history = Array.from({ length: MAX_OFFLINE_EVENTS }, (_, index) => ({ id: `full-history-${index}`, type: 'goal.recorded' as const, beneficiary: 'us' as const, lateEntryReason: 'r'.repeat(1000), sample }));
    const full = offlineDownloadFixture({ ...base, state: { ...base.state, revision: MAX_OFFLINE_EVENTS, eventHistory: history }, acceptedRevision: MAX_OFFLINE_EVENTS });
    expect(mergeDownload(ready(), full).acceptedRevision).toBe(MAX_OFFLINE_EVENTS);
    expect(full.acceptedEvents).toHaveLength(MAX_OFFLINE_EVENTS);
  }, 30_000);
});
