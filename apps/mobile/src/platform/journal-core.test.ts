/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitJournal, loadProjection, migrateJournal, recordDisposition } from './journal-core';
import { serializeKeyedConnection } from './journal-queue';
import type { SqlConnection } from './journal-core';

type Bind = string | number | null;
const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach((run) => run()); });

function connection(path = ':memory:') {
  const sql = new DatabaseSync(path);
  cleanup.push(() => sql.close());
  let failOn: string | null = null;
  const base: SqlConnection = {
    execAsync: async (query) => { sql.exec(query); },
    runAsync: async (query, ...params: Bind[]) => {
      if (failOn && query.includes(failOn)) throw new Error('injected write failure');
      return sql.prepare(query).run(...params);
    },
    getFirstAsync: async <T>(query: string, ...params: Bind[]) => (sql.prepare(query).get(...params) as T | undefined) ?? null,
  };
  const database = serializeKeyedConnection(base).database;
  return { sql, database, fail: (fragment: string | null) => { failOn = fragment; } };
}

const command = (id: string, epoch = 1) => ({
  eventId: id, matchId: 'synthetic-match', deviceId: 'synthetic-device',
  controllerEpoch: epoch, baseRevision: 0,
  event: { type: 'half.started', id }, projection: { revision: id },
});

describe('M0 durable local transaction boundary (real Node SQLite; not SQLCipher proof)', () => {
  it('serializes simultaneous writes on the same connection without interleaving transactions', async () => {
    const { database } = connection();
    await migrateJournal(database);
    const [first, second] = await Promise.all([
      commitJournal(database, command('first')), commitJournal(database, command('second')),
    ]);
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(second.previousEventId).toBe('first');
    expect(await loadProjection(database, 'synthetic-match')).toEqual({ revision: 'second' });
  });

  it('rolls back event, outbox and projection together and reuses no committed sequence', async () => {
    const { database, fail } = connection();
    await migrateJournal(database);
    await commitJournal(database, command('first'));
    fail('INSERT INTO projections');
    await expect(commitJournal(database, command('second'))).rejects.toThrow('injected');
    expect(await loadProjection(database, 'synthetic-match')).toEqual({ revision: 'first' });
    expect(await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM events')).toEqual({ count: 1 });
    expect(await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM outbox')).toEqual({ count: 1 });
    fail(null);
    expect(await commitJournal(database, command('second'))).toEqual({ sequence: 2, previousEventId: 'first', duplicate: false });
  });

  it('returns duplicate retries once, rejects changed content and does not roll back newer projection', async () => {
    const { database } = connection();
    await migrateJournal(database);
    await commitJournal(database, command('first'));
    await commitJournal(database, command('second'));
    expect(await commitJournal(database, command('first'))).toEqual({ sequence: 1, previousEventId: null, duplicate: true });
    expect(await loadProjection(database, 'synthetic-match')).toEqual({ revision: 'second' });
    await expect(commitJournal(database, { ...command('first'), event: { type: 'half.ended' } })).rejects.toThrow('different content');
    expect((await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM events'))?.count).toBe(2);
  });

  it('keeps rejected branches and sequence reservations across controller epochs and reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'longball-journal-'));
    // Remove files after closing connections in afterEach.
    cleanup.unshift(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'journal.db');
    const first = connection(path);
    await migrateJournal(first.database);
    await commitJournal(first.database, command('rejected', 1));
    await recordDisposition(first.database, 'rejected', 'quarantined', 'old controller branch');
    const second = connection(path);
    await migrateJournal(second.database);
    expect(await commitJournal(second.database, command('returned', 3))).toEqual({ sequence: 2, previousEventId: 'rejected', duplicate: false });
    expect(await second.database.getFirstAsync<{ disposition: string }>(
      'SELECT disposition FROM outbox WHERE event_id = ?', 'rejected',
    )).toEqual({ disposition: 'quarantined' });
    await expect(recordDisposition(second.database, 'rejected', 'accepted', 'silent rewrite', 1)).rejects.toThrow('reconciliation');
  });

  it('refuses unsupported newer schema while preserving existing file content', async () => {
    const { database } = connection();
    await database.execAsync("CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES ('unsynced'); PRAGMA user_version = 99;");
    await expect(migrateJournal(database)).rejects.toThrow('newer');
    expect(await database.getFirstAsync('SELECT value FROM preserved')).toEqual({ value: 'unsynced' });
  });

  it('rejects a stale concurrent projection while preserving the winning action', async () => {
    const { database, fail } = connection();
    await migrateJournal(database);
    const initial = { ...command('initial'), projection: { revision: 0 }, expectedLocalRevision: -1 };
    const winner = { ...command('winner'), projection: { revision: 1 }, expectedLocalRevision: 0 };
    await commitJournal(database, initial);
    await commitJournal(database, winner);
    fail('INSERT INTO outbox');
    await expect(commitJournal(database, { ...command('stale'), projection: { revision: 1 }, expectedLocalRevision: 0 })).rejects.toThrow('injected');
    expect((await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM events'))?.count).toBe(2);
    fail(null);
    await expect(commitJournal(database, { ...command('stale'), projection: { revision: 1 }, expectedLocalRevision: 0 })).rejects.toThrow('stale');
    expect(await loadProjection(database, 'synthetic-match')).toEqual({ revision: 1 });
    expect((await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM events'))?.count).toBe(3);
    expect(await database.getFirstAsync('SELECT disposition FROM outbox WHERE event_id = ?', 'stale')).toEqual({ disposition: 'quarantined' });
    await expect(commitJournal(database, { ...command('stale'), projection: { revision: 1 }, expectedLocalRevision: 0 }))
      .rejects.toMatchObject({ code: 'LOCAL_CONFLICT', eventId: 'stale' });
    expect((await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM events'))?.count).toBe(3);
    // An uncertain successful write can still retry its exact original precondition.
    expect((await commitJournal(database, winner)).duplicate).toBe(true);
  });
});
