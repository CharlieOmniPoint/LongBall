import { ENGINE_VERSION } from '../../domain/src/index';
import { UNAPPROVED_SHARING_POLICY } from './access';
import { OFFLINE_CHECKSUM_SERIALIZATION, sealOfflineSnapshot, type OfflineSnapshotMetadata } from './offline-bundle';
import type { MatchDownload, WireEvent } from './sync';

/** Unit fixtures only. Real HTTP tests verify persisted envelopes and database receive times. */
export function offlineDownloadFixture(input: Omit<MatchDownload, keyof OfflineSnapshotMetadata> & Partial<OfflineSnapshotMetadata>, deviceId = input.deviceId ?? 'device-a'): MatchDownload {
  const matchId = input.matchId;
  return sealOfflineSnapshot({
    ...input, bundleId: 'fixture-bundle', snapshotSchemaVersion: 1 as const,
    checksumSerialization: OFFLINE_CHECKSUM_SERIALIZATION, teamId: input.state.config.fixture?.teamId ?? 'fixture-team', seasonId: input.state.config.fixture?.seasonId ?? 'fixture-season', deviceId,
    publication: { fixtureClass: null, classificationVersion: null, resultPolicy: null, sharingPolicy: { ...UNAPPROVED_SHARING_POLICY } },
    acceptedEvents: (input.state.eventHistory ?? []).map((command, index) => ({ serverSequence: index + 1, receivedAt: input.downloadedAt, event: {
      contractVersion: 'longball.events/1.1', schemaVersion: 1, engineVersion: ENGINE_VERSION,
      eventId: command.id, matchId, deviceId: 'historical-fixture-device', controllerEpoch: 1,
      clientSequence: index + 1, previousEventId: input.state.eventHistory?.[index - 1]?.id ?? null, baseRevision: index,
      effectiveHalf: 0, halfElapsedMs: 0, matchElapsedMs: 0, effectiveAt: null, recordedAt: input.downloadedAt,
      timeQuality: 'reviewRequired', clockEvidence: { monotonicMs: command.sample.monotonicMs, anchorId: 'fixture-anchor', continuityId: command.sample.sessionId }, command,
    } as WireEvent })), controllerTransitions: [],
  });
}
