import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import { commitJournal, loadProjection, migrateJournal } from './journal-core';
import { serializeKeyedConnection } from './journal-queue';
import { nativeCapabilities } from './native-capabilities';
import type { CipherProbe, Journal } from './types';

const databaseName = 'longball-m0.db';
const secureKeyName = 'longball.m0.database-key.v1';
const secureOptions: SecureStore.SecureStoreOptions = {
  keychainService: 'longball-m0-journal',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

async function randomKey(): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(32);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function openEncrypted(name: string, key: string, directory: string): Promise<SQLite.SQLiteDatabase> {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('Encryption key is invalid. Journal retained for recovery.');
  const database = await SQLite.openDatabaseAsync(name, { useNewConnection: true }, directory);
  try {
    // A generated, strictly checked raw 256-bit key is the only interpolated SQL value.
    try { await database.execAsync(`PRAGMA key = "x'${key}'";`); }
    catch { throw new Error('Database encryption-key activation failed. Journal retained; no key details are exposed.'); }
    const version = await database.getFirstAsync<Record<string, unknown>>('PRAGMA cipher_version');
    if (!version || !String(Object.values(version)[0] ?? '').trim()) {
      throw new Error('SQLCipher is unavailable. Rebuild the native development client with useSQLCipher enabled.');
    }
    // A cipher pragma alone does not establish that an existing file is readable with this key.
    await database.getFirstAsync('SELECT COUNT(*) FROM sqlite_master');
    return database;
  } catch (error) {
    await database.closeAsync();
    throw error;
  }
}

/** Disposable encrypted file only; never resets or rekeys the authoritative journal. */
async function probeCipher(directory: string): Promise<CipherProbe> {
  const name = `longball-m0-probe-${Crypto.randomUUID()}.db`;
  const key = await randomKey();
  let current: SQLite.SQLiteDatabase | null = null;
  try {
    current = await openEncrypted(name, key, directory);
    await current.execAsync('CREATE TABLE proof (marker TEXT NOT NULL);');
    await current.runAsync('INSERT INTO proof VALUES (?)', 'synthetic SQLCipher reopen proof');
    await current.closeAsync();
    current = null;
    current = await openEncrypted(name, key, directory);
    const row = await current.getFirstAsync<{ marker: string }>('SELECT marker FROM proof');
    if (row?.marker !== 'synthetic SQLCipher reopen proof') throw new Error('Correct-key reopen did not preserve the probe.');
    await current.closeAsync();
    current = null;
    let wrongKeyRefused = false;
    try {
      current = await openEncrypted(name, await randomKey(), directory);
      await current.getFirstAsync('SELECT marker FROM proof');
    } catch {
      wrongKeyRefused = true;
    }
    if (!wrongKeyRefused) throw new Error('Wrong key unexpectedly read the encrypted probe.');
    return { status: 'passed', detail: 'Disposable database: cipher active, correct-key reopen passed, wrong-key read refused. Physical backup and key-loss tests remain pending.' };
  } catch (error) {
    return { status: 'failed', detail: error instanceof Error ? error.message : 'Cipher probe failed.' };
  } finally {
    if (current) await current.closeAsync();
    await SQLite.deleteDatabaseAsync(name, directory);
  }
}

async function openNativeJournal(): Promise<Journal> {
  if (!nativeCapabilities) {
    throw new Error('LongBall native module is missing. Rebuild the custom development client; Expo Go cannot run the encrypted M0 journal.');
  }
  const location = nativeCapabilities.storageDirectory();
  if (!location.backupExcluded) throw new Error('Database backup exclusion failed. Journal activation blocked; no file was discarded.');
  if (!(await SecureStore.isAvailableAsync())) throw new Error('Secure key storage is unavailable.');
  let key = await SecureStore.getItemAsync(secureKeyName, secureOptions);
  if (!key) {
    if (location.existingJournal) throw new Error('Journal exists but its device key is missing. Preserve this phone and journal for recovery; no replacement database was created.');
    key = await randomKey();
    await SecureStore.setItemAsync(secureKeyName, key, secureOptions);
  }
  const database = await openEncrypted(databaseName, key, location.directory);
  try {
    await database.execAsync('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    const queued = serializeKeyedConnection({
      execAsync: (query) => database.execAsync(query),
      runAsync: (query, ...params) => database.runAsync(query, ...params),
      getFirstAsync: <T>(query: string, ...params: (string | number | null)[]) => database.getFirstAsync<T>(query, ...params),
    });
    await migrateJournal(queued.database);
    let device = await database.getFirstAsync<{ value: string }>('SELECT value FROM metadata WHERE key = ?', 'deviceId');
    if (!device) {
      await database.runAsync('INSERT INTO metadata VALUES (?, ?)', 'deviceId', Crypto.randomUUID());
      device = await database.getFirstAsync<{ value: string }>('SELECT value FROM metadata WHERE key = ?', 'deviceId');
    }
    if (!device) throw new Error('Cannot establish device identity.');
    const deviceId = device.value;
    const cipher = await database.getFirstAsync<Record<string, unknown>>('PRAGMA cipher_version');
    let probeStatus: 'not-run' | 'passed' | 'failed' = 'not-run';
    let closed = false;
    return {
      load: <T>(matchId: string) => queued.serial(() => loadProjection<T>(database, matchId)),
      commit: (input) => commitJournal(queued.database, input),
      getDiagnostics: () => queued.serial(async () => ({
        mode: 'encrypted-native', cipherVersion: String(Object.values(cipher ?? {})[0] ?? ''),
        pendingCount: (await database.getFirstAsync<{ count: number }>("SELECT COUNT(*) AS count FROM outbox WHERE disposition = 'pending'"))?.count ?? 0,
        conflictCount: (await database.getFirstAsync<{ count: number }>("SELECT COUNT(*) AS count FROM outbox WHERE disposition = 'quarantined'"))?.count ?? 0,
        savedCount: (await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM events'))?.count ?? 0,
        backupExcluded: location.backupExcluded, deviceId, wrongKeyProbe: probeStatus,
      })),
      runCipherProbe: async () => {
        const result = await probeCipher(location.directory);
        probeStatus = result.status === 'passed' ? 'passed' : 'failed';
        return result;
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await queued.serial(() => database.closeAsync());
      },
    };
  } catch (error) {
    await database.closeAsync();
    throw error;
  }
}

// Duplicate development mounts must not generate competing first-install keys.
let opening: Promise<unknown> = Promise.resolve();
export function openJournal(): Promise<Journal> {
  const attempt = opening.catch(() => {}).then(openNativeJournal);
  opening = attempt;
  return attempt;
}
