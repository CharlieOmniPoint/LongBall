import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION } from '../../../packages/domain/src/index';
import { EVENT_CONTRACT_VERSION, validateEnvelope } from './store';

const envelope = (monotonicMs: number) => ({
  contractVersion: EVENT_CONTRACT_VERSION, schemaVersion: 1, engineVersion: ENGINE_VERSION,
  eventId: 'clock-precision-event', matchId: 'precision-match', deviceId: 'precision-device', controllerEpoch: 1,
  clientSequence: 1, previousEventId: null, baseRevision: 0, effectiveHalf: 1, halfElapsedMs: 0, matchElapsedMs: 0,
  effectiveAt: null, recordedAt: '2026-10-21T12:00:00Z', timeQuality: 'reviewRequired',
  clockEvidence: { monotonicMs, anchorId: 'precision-anchor', continuityId: 'precision-continuity' },
  command: { id: 'clock-precision-event', type: 'goal.recorded', beneficiary: 'us', sample: { monotonicMs, sessionId: 'precision-continuity', wallTimeMs: 1_800_000_000_000 } },
});
describe('integer-millisecond replay precision', () => {
  it('rejects finite clock evidence which cannot produce exact integer milliseconds', () => {
    for (const reading of [1e308, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN, -0.25]) expect(() => validateEnvelope(envelope(reading), 'precision-match')).toThrow('match command');
  });
  it('keeps valid fractional native/browser samples and the exact integer limit supported', () => {
    for (const reading of [0, 0.25, 12_345.875, Number.MAX_SAFE_INTEGER]) expect(validateEnvelope(envelope(reading), 'precision-match').command.sample.monotonicMs).toBe(reading);
  });
});
