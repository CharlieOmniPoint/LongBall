import { loadBrowserRecord, prepareBrowserCommit, validateBrowserRecord } from './browser-journal';
import { browserId } from './browser-id';
import type { BrowserRecord } from './browser-journal';
import type { Journal } from './types';

const databaseName = 'longball-synthetic-m0';
const storeName = 'journal';
const recordKey = 'record';

async function openBrowserDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) throw new Error('This browser does not offer the transactional storage required for review.');
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onerror = () => reject(request.error ?? new Error('Browser storage could not be opened. Existing data was retained.'));
    request.onblocked = () => reject(new Error('Another review tab is blocking storage setup. Close that tab and retry.'));
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

/** No await between reading and writing: IndexedDB serializes this transaction across browser tabs. */
function transact<T>(
  database: IDBDatabase, writable: boolean,
  work: (record: BrowserRecord | null) => { record?: BrowserRecord; result: T },
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, writable ? 'readwrite' : 'readonly');
    let result: T;
    let failure: unknown;
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Browser write was not committed. Please retry.'));
    transaction.onerror = () => { failure ??= transaction.error; };
    const store = transaction.objectStore(storeName);
    const read = store.get(recordKey);
    read.onsuccess = () => {
      try {
        const record = read.result === undefined ? null : validateBrowserRecord(read.result);
        const changed = work(record);
        result = changed.result;
        if (changed.record) store.put(changed.record, recordKey);
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
  });
}

export async function openJournal(): Promise<Journal> {
  const database = await openBrowserDatabase();
  let initial: BrowserRecord;
  try {
    initial = await transact(database, true, (record) => {
      if (record) return { result: record };
      // Retain the previous localStorage document unchanged as migration provenance.
      const migrated = loadBrowserRecord(globalThis.localStorage);
      const created: BrowserRecord = migrated ?? {
        version: 1, deviceId: browserId(), events: {}, projections: {}, checkpoints: {},
      };
      return { record: created, result: created };
    });
  } catch (error) { database.close(); throw error; }
  let closed = false;
  return {
    load: async <T>(matchId: string): Promise<T | null> => transact(database, false, (record) => ({
      result: (record?.projections[matchId] as T | undefined) ?? null,
    })),
    commit: async (input) => {
      const prepared = await transact(database, true, (record) => {
        if (!record) throw new Error('Browser journal is not initialized.');
        const candidate = prepareBrowserCommit(record, input);
        return { result: candidate, ...(candidate.updated !== record ? { record: candidate.updated } : {}) };
      });
      // The rejected candidate's sequence/history is committed before exposing a reload option.
      if (prepared.conflict) throw prepared.conflict;
      return prepared.result;
    },
    getDiagnostics: () => transact(database, false, (record) => {
      const count = Object.keys(record?.events ?? {}).length;
      return { result: {
        mode: 'synthetic-browser', cipherVersion: null,
        pendingCount: Object.values(record?.events ?? {}).filter(event => event.disposition === 'pending').length,
        conflictCount: Object.values(record?.events ?? {}).filter(event => event.disposition === 'quarantined').length,
        savedCount: count, backupExcluded: false, deviceId: initial.deviceId, wrongKeyProbe: 'unsupported',
      } };
    }),
    runCipherProbe: async () => ({
      status: 'unsupported',
      detail: 'Browser review uses unprotected synthetic IndexedDB. SQLCipher, SecureStore, backup, reboot and lock tests require a native development build on each phone.',
    }),
    close: async () => { if (!closed) { closed = true; database.close(); } },
  };
}
