import { sha256 } from '@noble/hashes/sha2.js';
import type { MatchState } from '../../domain/src/index';
import type { SharingPolicy } from './access';
import type { ResultPublicationPolicy, FixtureClass } from './records';
import type { MatchDownload, WireEvent } from './sync';

export const OFFLINE_SNAPSHOT_SCHEMA = 1 as const;
export const OFFLINE_CHECKSUM_SERIALIZATION = 'longball.canonical-json/1' as const;
export const MAX_OFFLINE_EVENTS = 10_000;
export interface AcceptedOfflineEvent { serverSequence: number; receivedAt: string; event: WireEvent }
/** Control transitions have their own persisted IDs/epochs, never invented event ordinals. */
export interface OfflineControllerTransition { id: string; epoch: number; actorId: string; fromDevice: string | null; toDevice: string; kind: string; reason: string | null; createdAt: string }
export interface OfflinePublication {
  fixtureClass: FixtureClass | null; classificationVersion: number | null;
  resultPolicy: ResultPublicationPolicy | null; sharingPolicy: SharingPolicy;
}
export interface OfflineSnapshotMetadata {
  bundleId: string; snapshotSchemaVersion: typeof OFFLINE_SNAPSHOT_SCHEMA;
  checksumSerialization: typeof OFFLINE_CHECKSUM_SERIALIZATION;
  checksumSha256: string; teamId: string; seasonId: string; deviceId: string;
  publication: OfflinePublication;
  acceptedEvents: AcceptedOfflineEvent[]; controllerTransitions: OfflineControllerTransition[];
}

/** Code-unit key order, JSON number/string escaping, no locale dependence or coercion. */
function* canonicalTokens(value: unknown): Generator<string> {
  const ancestors = new Set<object>();
  function* encode(input: unknown, depth: number): Generator<string> {
    if (depth > 100) throw new Error('Offline snapshot nesting exceeds the supported bound.');
    if (input === null || typeof input === 'string' || typeof input === 'boolean') { yield JSON.stringify(input); return; }
    if (typeof input === 'number' && Number.isFinite(input)) { yield JSON.stringify(input); return; }
    if (typeof input !== 'object' || !input || ancestors.has(input) || ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(input))) throw new Error('Offline snapshot must contain finite JSON values only.');
    ancestors.add(input);
    try {
      if (Object.getOwnPropertySymbols(input).length) throw new Error('Offline snapshot cannot contain symbolic fields.');
      const descriptors = Object.getOwnPropertyDescriptors(input);
      if (Array.isArray(input)) {
        if (Object.keys(input).length !== input.length || Object.entries(descriptors).some(([key, item]) => key !== 'length' && (!('value' in item) || !item.enumerable)) || Array.from({ length: input.length }, (_, index) => index).some(index => !Object.hasOwn(input, index))) throw new Error('Offline snapshot arrays must be dense JSON arrays.');
        yield '[';
        for (let index = 0; index < input.length; index++) { if (index) yield ','; yield* encode(input[index], depth + 1); }
        yield ']'; return;
      }
      if (Object.values(descriptors).some(item => !('value' in item) || !item.enumerable)) throw new Error('Offline snapshot cannot contain accessors or hidden fields.');
      yield '{'; let separator = '';
      for (const key of Object.keys(input).sort()) { yield separator; separator = ','; yield JSON.stringify(key); yield ':'; yield* encode(descriptors[key].value, depth + 1); }
      yield '}';
    } finally { ancestors.delete(input); }
  }
  yield* encode(value, 0);
}
export function canonicalOfflineJson(value: unknown): string { return Array.from(canonicalTokens(value)).join(''); }

/** JSON escapes lone surrogates; encode remaining Unicode without a host TextEncoder/Buffer dependency. */
export function offlineUtf8(value: string): Uint8Array {
  let length = 0;
  for (const character of value) { const code = character.codePointAt(0)!; length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4; }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 0x80) bytes[offset++] = code;
    else if (code < 0x800) { bytes[offset++] = 0xc0 | code >> 6; bytes[offset++] = 0x80 | code & 63; }
    else if (code < 0x10000) { bytes[offset++] = 0xe0 | code >> 12; bytes[offset++] = 0x80 | code >> 6 & 63; bytes[offset++] = 0x80 | code & 63; }
    else { bytes[offset++] = 0xf0 | code >> 18; bytes[offset++] = 0x80 | code >> 12 & 63; bytes[offset++] = 0x80 | code >> 6 & 63; bytes[offset++] = 0x80 | code & 63; }
  }
  return bytes;
}
export function offlineChecksum(payload: unknown): string {
  const hash = sha256.create();
  let chunk = ''; // Bounded temporary encoding buffer, not a payload-size limit.
  for (const token of canonicalTokens(payload)) {
    chunk += token;
    if (chunk.length >= 16_384) { hash.update(offlineUtf8(chunk)); chunk = ''; }
  }
  if (chunk) hash.update(offlineUtf8(chunk));
  return Array.from(hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function sealOfflineSnapshot<T extends object>(payload: T): T & { checksumSha256: string } {
  const unsigned = { ...payload } as T & { checksumSha256?: string };
  delete unsigned.checksumSha256;
  return { ...unsigned, checksumSha256: offlineChecksum(unsigned) } as T & { checksumSha256: string };
}
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,150}$/.test(value);
const iso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const equal = (left: unknown, right: unknown) => canonicalOfflineJson(left) === canonicalOfflineJson(right);
const only = (value: object, fields: readonly string[]) => Object.keys(value).every(key => fields.includes(key));

/** Verify before a journal transaction can replace any accepted/local branch. */
export function assertOfflineSnapshot(download: MatchDownload, scope: { matchId: string; deviceId: string; teamId?: string; seasonId?: string }): void {
  const fail = (): never => { throw new Error('Offline snapshot is incomplete, inconsistent or unsupported. Existing journal retained; download a fresh verified bundle.'); };
  if (!download || download.snapshotSchemaVersion !== OFFLINE_SNAPSHOT_SCHEMA || download.checksumSerialization !== OFFLINE_CHECKSUM_SERIALIZATION || !identifier(download.bundleId) || !identifier(download.teamId) || !identifier(download.seasonId) || scope.teamId !== undefined && scope.teamId !== download.teamId || scope.seasonId !== undefined && scope.seasonId !== download.seasonId || download.deviceId !== scope.deviceId || download.matchId !== scope.matchId || !iso(download.downloadedAt) || !/^[0-9a-f]{64}$/.test(download.checksumSha256 ?? '')) fail();
  if (!only(download, ['contractVersion', 'schemaVersion', 'engineVersion', 'bundleId', 'snapshotSchemaVersion', 'checksumSerialization', 'checksumSha256', 'matchId', 'teamId', 'seasonId', 'deviceId', 'state', 'acceptedRevision', 'deviceCheckpoint', 'controller', 'publication', 'acceptedEvents', 'controllerTransitions', 'downloadedAt', 'clockAnchor', 'syntheticOnly']) || download.controller && !only(download.controller, ['epoch', 'account_id', 'device_id', 'frozen'])) fail();
  if (!Array.isArray(download.acceptedEvents) || !Array.isArray(download.controllerTransitions) || download.acceptedEvents.length > MAX_OFFLINE_EVENTS || download.controllerTransitions.length > MAX_OFFLINE_EVENTS) fail();
  const { checksumSha256, ...payload } = download;
  if (offlineChecksum(payload) !== checksumSha256) fail();
  const state: MatchState = download.state;
  if (!state?.config || state.config.matchId !== scope.matchId || !natural(state.revision) || state.revision !== download.acceptedRevision || !Array.isArray(state.config.players) || state.config.players.length > 100 || !Array.isArray(state.config.selectedPlayerIds) || state.config.selectedPlayerIds.length > 100 || new Set(state.config.players.map(player => player.id)).size !== state.config.players.length || state.config.fixture && (state.config.fixture.teamId !== download.teamId || state.config.fixture.seasonId !== download.seasonId)) fail();
  if (!only(state.config, ['matchId', 'players', 'selectedPlayerIds', 'pitchPlaces', 'plannedHalfDurationMs', 'fixedKeeperId', 'initialPolicyProposal', 'initialLineupProposal', 'initialAttendance', 'slots', 'fixture', 'profileSnapshot']) || state.config.players.some(player => !only(player, ['id', 'displayName', 'goalkeeperChoice', 'positionPreferences', 'profileVersion', 'available'])) || state.config.profileSnapshot?.some(profile => !only(profile, ['playerId', 'preferences', 'eligiblePositions', 'initials']))) fail();
  if (!download.publication || !Object.hasOwn(download.publication, 'fixtureClass') || !Object.hasOwn(download.publication, 'classificationVersion') || !Object.hasOwn(download.publication, 'resultPolicy') || !download.publication.sharingPolicy || typeof download.publication.sharingPolicy.shareScores !== 'boolean' || typeof download.publication.sharingPolicy.shareDerivedResults !== 'boolean') fail();
  if (!Array.isArray(download.acceptedEvents) || !Array.isArray(download.controllerTransitions) || download.acceptedEvents.length > MAX_OFFLINE_EVENTS || download.controllerTransitions.length > MAX_OFFLINE_EVENTS || download.acceptedEvents.length !== state.revision) fail();
  const ids = new Set<string>();
  for (const [index, record] of download.acceptedEvents.entries()) {
    const event = record.event;
    // Historical wire versions remain original evidence; do not relabel/replay them as current commands.
    if (record.serverSequence !== index + 1 || !iso(record.receivedAt) || !event || event.matchId !== scope.matchId || event.baseRevision !== index || !identifier(event.eventId) || !identifier(event.deviceId) || !natural(event.clientSequence) || event.clientSequence < 1 || !natural(event.controllerEpoch) || event.controllerEpoch < 1 || !event.engineVersion || event.command?.id !== event.eventId || ids.has(event.eventId)) fail();
    ids.add(event.eventId);
  }
  if (state.eventHistory && (state.eventHistory.length !== download.acceptedEvents.length || !state.eventHistory.every((event, index) => event.id === download.acceptedEvents[index].event.eventId && equal({ ...download.acceptedEvents[index].event.command, ...(event.actorId === undefined ? {} : { actorId: event.actorId }) }, event)))) fail();
  const checkpoint = download.deviceCheckpoint;
  if (!checkpoint || !natural(checkpoint.clientSequence) || !(checkpoint.previousEventId === null || identifier(checkpoint.previousEventId)) || (checkpoint.clientSequence === 0) !== (checkpoint.previousEventId === null)) fail();
  for (const record of download.acceptedEvents) if (record.event.deviceId === scope.deviceId && record.event.clientSequence > checkpoint.clientSequence) fail();
  for (const transition of download.controllerTransitions) if (!identifier(transition.id) || !natural(transition.epoch) || transition.epoch < 1 || !identifier(transition.actorId) || !identifier(transition.toDevice) || !(transition.fromDevice === null || identifier(transition.fromDevice)) || !iso(transition.createdAt) || typeof transition.kind !== 'string' || !(transition.reason === null || typeof transition.reason === 'string')) fail();
  if (!download.clockAnchor || download.clockAnchor.serverTime !== download.downloadedAt || download.clockAnchor.quality !== 'observation_only' || download.clockAnchor.continuousMappingEstablished !== false || typeof download.syntheticOnly !== 'boolean') fail();
}
