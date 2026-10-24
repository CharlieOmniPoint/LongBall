import type { SqlConnection, TransactionDatabase } from './journal-core';

/**
 * Keep a SQLCipher transaction on its keyed connection. Expo's exclusive helper opens an
 * additional connection, which does not inherit PRAGMA key. Queue all public reads/writes.
 */
export function serializeKeyedConnection(connection: SqlConnection): {
  database: TransactionDatabase;
  serial: <T>(work: () => Promise<T>) => Promise<T>;
} {
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const attempt = tail.catch(() => {}).then(work);
    tail = attempt;
    return attempt;
  }
  return {
    serial,
    database: {
      ...connection,
      withExclusiveTransactionAsync: (work) => serial(async () => {
        await connection.execAsync('BEGIN IMMEDIATE');
        try {
          await work(connection);
          await connection.execAsync('COMMIT');
        } catch (error) {
          try { await connection.execAsync('ROLLBACK'); }
          catch { /* Preserve the write error if SQLite already rolled back. */ }
          throw error;
        }
      }),
    },
  };
}
