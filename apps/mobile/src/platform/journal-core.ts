import { assertLocalRevision, canonicalJson } from './serialization';
import { LocalConflictError } from './types';
import type { CommitInput, CommitResult } from './types';

type Bind = string | number | null;
/** The small SQLite surface lets crash/idempotency checks run against real SQLite in Node. */
export interface SqlConnection {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: Bind[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, ...params: Bind[]): Promise<T | null>;
}
export interface TransactionDatabase extends SqlConnection {
  withExclusiveTransactionAsync(work: (transaction: SqlConnection) => Promise<void>): Promise<void>;
}

export async function migrateJournal(database: TransactionDatabase): Promise<void> {
  const version = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((version?.user_version ?? 0) > 1) throw new Error('Journal is newer than this app. Keep the file and use the compatible build.');
  await database.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.execAsync(`
      CREATE TABLE IF NOT EXISTS device_sequences (
        match_id TEXT NOT NULL, device_id TEXT NOT NULL, last_sequence INTEGER NOT NULL,
        last_event_id TEXT, PRIMARY KEY(match_id, device_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY, match_id TEXT NOT NULL, device_id TEXT NOT NULL,
        controller_epoch INTEGER NOT NULL, client_sequence INTEGER NOT NULL,
        previous_event_id TEXT, base_revision INTEGER NOT NULL, event_json TEXT NOT NULL,
        projection_json TEXT NOT NULL,
        UNIQUE(match_id, device_id, client_sequence)
      );
      CREATE TABLE IF NOT EXISTS projections (
        match_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, projection_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        event_id TEXT PRIMARY KEY REFERENCES events(event_id),
        disposition TEXT NOT NULL CHECK(disposition IN ('pending','accepted','rejected','quarantined')),
        reason TEXT, accepted_revision INTEGER
      );
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
  });
}

/** Event, sequence, projection and outbox succeed or roll back as one transaction (ME50–51). */
export async function commitJournal<T>(database: TransactionDatabase, input: CommitInput<T>): Promise<CommitResult> {
  const eventJson = canonicalJson(input.event);
  const projectionJson = canonicalJson(input.projection);
  let result: CommitResult | undefined;
  let conflict: LocalConflictError | null = null;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const prior = await transaction.getFirstAsync<{
      event_json: string; projection_json: string; match_id: string; device_id: string;
      controller_epoch: number; base_revision: number; client_sequence: number; previous_event_id: string | null;
    }>('SELECT * FROM events WHERE event_id = ?', input.eventId);
    if (prior) {
      if (prior.event_json !== eventJson || prior.projection_json !== projectionJson ||
          prior.match_id !== input.matchId || prior.device_id !== input.deviceId ||
          prior.controller_epoch !== input.controllerEpoch || prior.base_revision !== input.baseRevision) {
        throw new Error('Event identifier already belongs to different content. Original history retained.');
      }
      const disposition = await transaction.getFirstAsync<{ disposition: string; reason: string | null }>(
        'SELECT disposition, reason FROM outbox WHERE event_id = ?', input.eventId,
      );
      if (disposition?.reason?.startsWith('local_projection_conflict:')) {
        conflict = new LocalConflictError(input.eventId, disposition.reason.slice('local_projection_conflict:'.length));
        return;
      }
      result = { sequence: prior.client_sequence, previousEventId: prior.previous_event_id, duplicate: true };
      return;
    }
    const current = await transaction.getFirstAsync<{ projection_json: string }>(
      'SELECT projection_json FROM projections WHERE match_id = ?', input.matchId,
    );
    try { assertLocalRevision(input.expectedLocalRevision, current ? JSON.parse(current.projection_json) : null); }
    catch (error) {
      conflict = new LocalConflictError(input.eventId, `${error instanceof Error ? error.message : 'Local source revision changed.'} Rejected candidate retained for review.`);
    }
    const checkpoint = await transaction.getFirstAsync<{ last_sequence: number; last_event_id: string | null }>(
      'SELECT last_sequence, last_event_id FROM device_sequences WHERE match_id = ? AND device_id = ?',
      input.matchId, input.deviceId,
    );
    const sequence = (checkpoint?.last_sequence ?? 0) + 1;
    const previousEventId = checkpoint?.last_event_id ?? null;
    await transaction.runAsync(
      'INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      input.eventId, input.matchId, input.deviceId, input.controllerEpoch, sequence,
      previousEventId, input.baseRevision, eventJson, projectionJson,
    );
    await transaction.runAsync(
      'INSERT INTO outbox (event_id, disposition, reason) VALUES (?, ?, ?)',
      input.eventId, conflict ? 'quarantined' : 'pending',
      conflict ? `local_projection_conflict:${conflict.message}` : null,
    );
    if (!conflict) {
      await transaction.runAsync(
        'INSERT INTO projections VALUES (?, ?, ?) ON CONFLICT(match_id) DO UPDATE SET event_id=excluded.event_id, projection_json=excluded.projection_json',
        input.matchId, input.eventId, projectionJson,
      );
    }
    await transaction.runAsync(
      'INSERT INTO device_sequences VALUES (?, ?, ?, ?) ON CONFLICT(match_id,device_id) DO UPDATE SET last_sequence=excluded.last_sequence, last_event_id=excluded.last_event_id',
      input.matchId, input.deviceId, sequence, input.eventId,
    );
    result = { sequence, previousEventId, duplicate: false };
  });
  if (conflict) throw conflict;
  if (!result) throw new Error('Journal commit did not finish.');
  return result;
}

export async function loadProjection<T>(database: SqlConnection, matchId: string): Promise<T | null> {
  const row = await database.getFirstAsync<{ projection_json: string }>(
    'SELECT projection_json FROM projections WHERE match_id = ?', matchId,
  );
  return row ? JSON.parse(row.projection_json) as T : null;
}

/** Future synchronisation writes dispositions; rows and sequence reservations are never deleted. */
export async function recordDisposition(
  database: TransactionDatabase, eventId: string,
  disposition: 'accepted' | 'rejected' | 'quarantined', reason: string, acceptedRevision: number | null = null,
): Promise<void> {
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const existing = await transaction.getFirstAsync<{ disposition: string }>('SELECT disposition FROM outbox WHERE event_id = ?', eventId);
    if (!existing) throw new Error('Unknown local event.');
    if (existing.disposition !== 'pending' && existing.disposition !== disposition) {
      throw new Error('Disposition changed; explicit reconciliation is required.');
    }
    await transaction.runAsync('UPDATE outbox SET disposition = ?, reason = ?, accepted_revision = ? WHERE event_id = ?',
      disposition, reason, acceptedRevision, eventId);
  });
}
