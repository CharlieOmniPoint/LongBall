import { randomUUID } from 'node:crypto';
import { AccessError, type SharingPolicy } from '../../../packages/application/src/access';
import { assertOfflineSnapshot, MAX_OFFLINE_EVENTS, OFFLINE_CHECKSUM_SERIALIZATION, OFFLINE_SNAPSHOT_SCHEMA, sealOfflineSnapshot, type OfflineControllerTransition, type OfflinePublication } from '../../../packages/application/src/offline-bundle';
import type { RecordsState } from '../../../packages/application/src/records';
import type { DeviceCheckpoint, MatchDownload, WireEvent } from '../../../packages/application/src/sync';
import { ENGINE_VERSION, type MatchState } from '../../../packages/domain/src/index';

export interface OfflineEventRow { revision: number; received_at: number; envelope_json: string }
export interface OfflineTransitionRow { id: string; epoch: number; actor_id: string; from_device: string | null; to_device: string; kind: string; reason: string | null; created_at: number }
export function offlinePublication(matchId: string, sharingPolicy: SharingPolicy, records: RecordsState | null): OfflinePublication {
  const result = records?.results.find(item => item.id === matchId);
  const policy = result?.publication;
  return {
    fixtureClass: result?.fixtureClass ?? (records?.liveMatch.matchId === matchId ? records.liveMatch.fixtureClass : null),
    classificationVersion: result?.classificationVersion ?? null,
    resultPolicy: policy ? { id: policy.id, version: policy.version, fixtureClass: policy.fixtureClass, confirmed: policy.confirmed, confirmationReference: policy.confirmationReference, allowedRoles: [...policy.allowedRoles] } : null,
    sharingPolicy: { version: sharingPolicy.version, approvedBy: sharingPolicy.approvedBy, approvedAt: sharingPolicy.approvedAt, shareScores: sharingPolicy.shareScores, shareDerivedResults: sharingPolicy.shareDerivedResults },
  };
}
/** The caller holds the same database transaction/authority lock for every source row. */
export function buildOfflineDownload(input: {
  matchId: string; teamId: string; seasonId: string; deviceId: string; state: MatchState;
  checkpoint: DeviceCheckpoint; controller: MatchDownload['controller']; publication: OfflinePublication;
  events: OfflineEventRow[]; transitions: OfflineTransitionRow[]; nowMs: number; syntheticOnly: boolean;
}): MatchDownload {
  if (input.events.length > MAX_OFFLINE_EVENTS || input.transitions.length > MAX_OFFLINE_EVENTS) throw new AccessError('OFFLINE_BUNDLE_UNSUPPORTED', 422, 'The pilot requires complete accepted/control history within 10000 records in each stream. Nothing was truncated.');
  const downloadedAt = new Date(input.nowMs).toISOString();
  const controllerTransitions: OfflineControllerTransition[] = input.transitions.map(row => ({ id: row.id, epoch: row.epoch, actorId: row.actor_id, fromDevice: row.from_device, toDevice: row.to_device, kind: row.kind, reason: row.reason, createdAt: new Date(row.created_at).toISOString() }));
  try {
    const bundle = sealOfflineSnapshot({
      contractVersion: 'longball.events/1.1' as const, schemaVersion: 1 as const, engineVersion: ENGINE_VERSION,
      bundleId: randomUUID(), snapshotSchemaVersion: OFFLINE_SNAPSHOT_SCHEMA, checksumSerialization: OFFLINE_CHECKSUM_SERIALIZATION,
      matchId: input.matchId, teamId: input.teamId, seasonId: input.seasonId, deviceId: input.deviceId,
      state: input.state, acceptedRevision: input.state.revision, deviceCheckpoint: input.checkpoint,
      controller: input.controller, publication: input.publication,
      acceptedEvents: input.events.map(row => ({ serverSequence: row.revision, receivedAt: new Date(row.received_at).toISOString(), event: JSON.parse(row.envelope_json) as WireEvent })),
      controllerTransitions, downloadedAt, clockAnchor: { serverTime: downloadedAt, quality: 'observation_only' as const, continuousMappingEstablished: false as const }, syntheticOnly: input.syntheticOnly,
    });
    assertOfflineSnapshot(bundle, input);
    return bundle;
  } catch {
    throw new AccessError('OFFLINE_BUNDLE_UNSUPPORTED', 422, 'The complete snapshot failed structural or full-history validation. The previous device bundle remains usable; no partial replacement was returned.');
  }
}
