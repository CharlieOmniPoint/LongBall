import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { DevelopmentStore, SYNTHETIC_IDS } from './store';

describe('development SQLite expand migrations', () => {
  it('serialises actual API/worker process startup against one fresh database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'longball-concurrent-migration-')); const path = join(directory, 'service.sqlite');
    try {
      const source = `import {DevelopmentStore} from ${JSON.stringify(new URL('./store.ts', import.meta.url).href)}; const store=new DevelopmentStore(process.argv[1]); store.seedSynthetic(); console.log(store.integrity()); store.close();`;
      const results = await Promise.all([1, 2].map(() => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, path], { cwd: process.cwd(), timeout: 10_000, maxBuffer: 65_536 })));
      expect(results.map(result => result.stdout.trim())).toEqual(['ok', 'ok']);
      const store = new DevelopmentStore(path);
      expect(store.database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 5 });
      expect(store.database.prepare('SELECT COUNT(*) AS n FROM documents').get()).toEqual({ n: 3 }); store.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 15_000);
  it('rolls back all version steps when a later expansion fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'longball-migration-rollback-')); const path = join(directory, 'failure.sqlite');
    try {
      const fixture = new DatabaseSync(path); fixture.exec("CREATE TABLE devices(id TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO devices VALUES('retained','keep'); PRAGMA user_version=0;"); fixture.close();
      expect(() => new DevelopmentStore(path)).toThrow();
      const retained = new DatabaseSync(path);
      expect(retained.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
      expect(retained.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='accounts'").get()).toEqual({ n: 0 });
      expect(retained.prepare('SELECT value FROM devices').get()).toEqual({ value: 'keep' }); retained.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('migrates the earlier account/event schema without removing an unresolved event or changing projection bytes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'longball-migration-'));
    const path = join(directory, 'old.sqlite');
    try {
      const original = new DevelopmentStore(path); original.seedSynthetic();
      const projection = original.match(SYNTHETIC_IDS.matchId).state_json;
      original.database.prepare('INSERT INTO events(event_id,match_id,device_id,client_sequence,envelope_json,signature,disposition,reason,revision,received_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('retained-offline-event', SYNTHETIC_IDS.matchId, 'old-device', 7, '{"original":"retained bytes"}', 'original-signature', 'quarantined', 'UNSUPPORTED_EVENT_VERSION', null, 1_800_000_000_000);
      // Recreate the earlier v1 layout by removing only columns/tables introduced by expand migrations.
      original.database.exec('ALTER TABLE events DROP COLUMN actor_id; ALTER TABLE accounts DROP COLUMN strong_auth_enrolled; DROP TABLE devices; DROP TABLE documents; PRAGMA user_version=1;');
      original.close();
      const migrated = new DevelopmentStore(path);
      expect(migrated.database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 5 });
      expect(migrated.match(SYNTHETIC_IDS.matchId).state_json).toBe(projection);
      expect(migrated.database.prepare('SELECT envelope_json,disposition,reason,client_sequence FROM events WHERE event_id=?').get('retained-offline-event')).toEqual({ envelope_json: '{"original":"retained bytes"}', disposition: 'quarantined', reason: 'UNSUPPORTED_EVENT_VERSION', client_sequence: 7 });
      // Newly required eligibility is not silently approved for an existing adult account.
      expect(migrated.database.prepare("SELECT strong_auth_enrolled FROM accounts WHERE id='synthetic-account-manager'").get()).toEqual({ strong_auth_enrolled: 0 });
      expect(migrated.integrity()).toBe('ok'); migrated.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('refuses a future schema and leaves its bytes and version available for a compatible application', () => {
    const directory = mkdtempSync(join(tmpdir(), 'longball-future-'));
    const path = join(directory, 'future.sqlite');
    try {
      const database = new DatabaseSync(path); database.exec("CREATE TABLE future_evidence(id TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO future_evidence VALUES('one','keep me'); PRAGMA user_version=99;"); database.close();
      expect(() => new DevelopmentStore(path)).toThrow('newer than this application');
      const retained = new DatabaseSync(path);
      expect(retained.prepare('PRAGMA user_version').get()).toEqual({ user_version: 99 });
      expect(retained.prepare('SELECT value FROM future_evidence').get()).toEqual({ value: 'keep me' }); retained.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
