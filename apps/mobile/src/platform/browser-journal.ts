import { assertLocalRevision, canonicalJson } from './serialization';
import { LocalConflictError } from './types';
import type { CommitInput, CommitResult } from './types';

export interface BrowserRecord {
  version: 1;
  deviceId: string;
  events: Record<string, {
    signature: string; event: unknown; sequence: number; previousEventId: string | null;
    matchId: string; deviceId: string; controllerEpoch: number; disposition: 'pending' | 'quarantined';
    conflictReason?: string; rejectedProjection?: unknown;
  }>;
  projections: Record<string, unknown>;
  checkpoints: Record<string, { sequence: number; eventId: string }>;
}

export interface LocalStorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const browserStorageKey = 'longball.synthetic.m0.v1';

export function loadBrowserRecord(storage: LocalStorageAdapter): BrowserRecord | null {
  const raw = storage.getItem(browserStorageKey);
  if (!raw) return null;
  return validateBrowserRecord(JSON.parse(raw));
}

export function validateBrowserRecord(value: unknown): BrowserRecord {
  if (!value || typeof value !== 'object') throw new Error('Browser review data is incompatible or damaged. Existing data was retained.');
  const record = value as Partial<BrowserRecord>;
  if (record.version !== 1 || typeof record.deviceId !== 'string' ||
      !record.events || !record.projections || !record.checkpoints) {
    throw new Error('Browser review data is incompatible or damaged. Existing data was retained.');
  }
  return record as BrowserRecord;
}

export function createBrowserRecord(storage: LocalStorageAdapter, deviceId: string): BrowserRecord {
  const existing = loadBrowserRecord(storage);
  if (existing) return existing;
  const record: BrowserRecord = { version: 1, deviceId, events: {}, projections: {}, checkpoints: {} };
  storage.setItem(browserStorageKey, JSON.stringify(record));
  return record;
}

/** One atomic localStorage value is sufficient for synthetic review; this is not native durability. */
export function commitBrowser<T>(storage: LocalStorageAdapter, input: CommitInput<T>): CommitResult {
  const previous = loadBrowserRecord(storage);
  if (!previous) throw new Error('Browser journal is not initialized.');
  const { result, updated, conflict } = prepareBrowserCommit(previous, input);
  if (updated !== previous) storage.setItem(browserStorageKey, JSON.stringify(updated));
  if (conflict) throw conflict;
  return result;
}

/** Pure preparation runs inside the real browser's IndexedDB read/write transaction. */
export function prepareBrowserCommit<T>(previous: BrowserRecord, input: CommitInput<T>): { result: CommitResult; updated: BrowserRecord; conflict?: LocalConflictError } {
  const signature = canonicalJson(input);
  const priorEvent = previous.events[input.eventId];
  if (priorEvent) {
    if (priorEvent.signature !== signature) throw new Error('Event identifier already belongs to different content. Original history retained.');
    return {
      updated: previous, result: { sequence: priorEvent.sequence, previousEventId: priorEvent.previousEventId, duplicate: true },
      ...(priorEvent.conflictReason ? { conflict: new LocalConflictError(input.eventId, priorEvent.conflictReason) } : {}),
    };
  }
  let conflict: LocalConflictError | undefined;
  try { assertLocalRevision(input.expectedLocalRevision, previous.projections[input.matchId] ?? null); }
  catch (error) {
    conflict = new LocalConflictError(input.eventId, `${error instanceof Error ? error.message : 'Local source revision changed.'} Rejected candidate retained for review.`);
  }
  const scope = JSON.stringify([input.matchId, input.deviceId]);
  const checkpoint = previous.checkpoints[scope];
  const sequence = (checkpoint?.sequence ?? 0) + 1;
  const previousEventId = checkpoint?.eventId ?? null;
  const updated: BrowserRecord = {
    ...previous,
    events: { ...previous.events, [input.eventId]: {
      signature, event: input.event, sequence, previousEventId, matchId: input.matchId,
      deviceId: input.deviceId, controllerEpoch: input.controllerEpoch, disposition: conflict ? 'quarantined' : 'pending',
      ...(conflict ? { conflictReason: conflict.message, rejectedProjection: input.projection } : {}),
    } },
    projections: conflict ? previous.projections : { ...previous.projections, [input.matchId]: input.projection },
    checkpoints: { ...previous.checkpoints, [scope]: { sequence, eventId: input.eventId } },
  };
  return { updated, result: { sequence, previousEventId, duplicate: false }, ...(conflict ? { conflict } : {}) };
}
