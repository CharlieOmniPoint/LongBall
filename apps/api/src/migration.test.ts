import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { DevelopmentStore, SYNTHETIC_IDS } from './store';
import { SqliteBrandRepository } from './brand-repository';

const currentVersion = 11;
const dropPrivilegeSchema = 'DROP TABLE administrative_memberships; DROP TABLE administration_grants; DROP TABLE directory_teams; DROP TABLE directory_clubs; DROP TABLE push_registrations; DROP TRIGGER team_privileges_new_team; DROP TABLE team_privilege_decisions; DROP TABLE team_privilege_states; ';
const observedAt = 1_800_000_000_000;
const historicalTables = ['accounts', 'audit', 'conflicting_submissions', 'controller_grants', 'controller_history', 'events', 'idempotency', 'jobs', 'matches', 'memberships', 'privacy_requests', 'streams', 'teams', 'transfers'];
const versionSixTables = [...historicalTables, 'clock_challenges', 'clock_mappings', 'devices', 'documents', 'reconciliation_proposals'];
const tableNames = (database: DatabaseSync) => database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => String(row.name));
function snapshotRows(database: DatabaseSync, tables: string[]) {
  return Object.fromEntries(tables.map(table => [table, JSON.stringify(database.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}" ORDER BY rowid`).all())]));
}
function seedRetainedEvidence(store: DevelopmentStore): void {
  const database = store.database, matchId = SYNTHETIC_IDS.matchId, manager = 'synthetic-account-manager';
  const row = store.match(matchId);
  database.prepare('UPDATE matches SET config_json=?,state_json=? WHERE id=?').run(`\n${JSON.stringify(JSON.parse(row.config_json), null, 2)}\n`, `\n${JSON.stringify(JSON.parse(row.state_json), null, 2)}\n`, matchId);
  database.prepare('INSERT INTO devices(id,account_id) VALUES(?,?)').run('retained-device', manager);
  database.prepare('INSERT INTO events(event_id,match_id,device_id,client_sequence,envelope_json,signature,disposition,reason,revision,received_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('retained-offline-event', matchId, 'retained-device', 7, '{ "engineVersion": "legacy-unsupported", "original": "retained bytes" }\n', 'original-signature', 'quarantined', 'UNSUPPORTED_EVENT_VERSION', null, observedAt);
  database.prepare('INSERT INTO streams VALUES(?,?,?,?)').run(matchId, 'retained-device', 7, 'retained-offline-event');
  database.prepare('INSERT INTO controller_grants VALUES(?,?,?,?,?,?)').run(matchId, 3, manager, 'retained-device', 'a'.repeat(64), 1);
  database.prepare('INSERT INTO controller_history VALUES(?,?,?,?,?,?,?,?,?)').run('retained-handover', matchId, 3, manager, 'old-device', 'retained-device', 'manual_review', 'Unresolved handover', observedAt);
  database.prepare('INSERT INTO conflicting_submissions VALUES(?,?,?,?,?,?)').run('retained-conflict', matchId, manager, '{ "original": "unaltered conflict" }\n', 'STALE_CONTROLLER_EPOCH', observedAt);
  database.prepare('INSERT INTO transfers VALUES(?,?,?,?,?,?,?)').run('retained-transfer', matchId, 2, manager, 'next-device', 'pending_review', observedAt);
  database.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?)').run(manager, 'legacy-operation', 'retained-request-key', 'b'.repeat(64), '{ "pendingReview": true, "original": "retained receipt" }\n');
  database.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?)').run('retained-audit', manager, 'manual_review', matchId, 'pending', observedAt);
  database.prepare('INSERT INTO jobs(id,business_key,kind,payload_json,due_at,state) VALUES(?,?,?,?,?,?)').run('retained-job', 'retained-business-key', 'legacy_unsupported_job', '{ "original": "retained job" }\n', observedAt, 'pending_review');
}

describe('development SQLite expand migrations', () => {
  it('expands version nine with no automatic push opt-in and preserves every earlier row across reopen',()=>{
    const directory=mkdtempSync(join(tmpdir(),'longball-push-migration-')),path=join(directory,'v9.sqlite');
    try{
      let store=new DevelopmentStore(path,()=>observedAt);store.seedSynthetic();seedRetainedEvidence(store);
      store.database.exec('DROP TABLE push_registrations; PRAGMA user_version=9;');
      const tables=tableNames(store.database),before=snapshotRows(store.database,tables);store.close();
      store=new DevelopmentStore(path,()=>observedAt);expect(store.database.prepare('PRAGMA user_version').get()).toEqual({user_version:11});expect(snapshotRows(store.database,tables)).toEqual(before);expect(store.database.prepare('SELECT * FROM push_registrations').all()).toEqual([]);store.close();
      store=new DevelopmentStore(path,()=>observedAt);expect(snapshotRows(store.database,tables)).toEqual(before);expect(store.database.prepare('SELECT * FROM push_registrations').all()).toEqual([]);store.close();
    }finally{rmSync(directory,{recursive:true,force:true});}
  });
  it('rolls back a failed push expansion without overwriting a colliding retained table',()=>{
    const directory=mkdtempSync(join(tmpdir(),'longball-push-migration-conflict-')),path=join(directory,'v9.sqlite');
    try{
      const store=new DevelopmentStore(path);store.seedSynthetic();store.database.exec("DROP TABLE push_registrations; CREATE TABLE push_registrations(retained TEXT); INSERT INTO push_registrations VALUES('keep original bytes'); PRAGMA user_version=9;");store.close();
      expect(()=>new DevelopmentStore(path)).toThrow();const retained=new DatabaseSync(path);expect(retained.prepare('PRAGMA user_version').get()).toEqual({user_version:9});expect(retained.prepare('SELECT * FROM push_registrations').all()).toEqual([{retained:'keep original bytes'}]);retained.close();
    }finally{rmSync(directory,{recursive:true,force:true});}
  });
  it('serialises synchronized API/worker first-open processes across three fresh databases', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'longball-concurrent-migration-'));
    try {
      const source = `import {DevelopmentStore} from ${JSON.stringify(new URL('./store.ts', import.meta.url).href)}; const start=new Promise(resolve=>process.once('message',resolve)); process.send('ready'); await start; const store=new DevelopmentStore(process.argv[1]); store.seedSynthetic(); console.log(store.integrity()); store.close();`;
      for (let round = 0; round < 3; round++) {
        const path = join(directory, `service-${round}.sqlite`);
        const children = [1, 2].map(() => spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, path], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }));
        const ready = children.map(child => new Promise<void>(resolve => { child.once('message', message => { if (message === 'ready') resolve(); }); }));
        const completed = children.map(child => new Promise<string>((resolve, reject) => {
          let stdout = '', stderr = '';
          child.stdout!.on('data', chunk => { stdout += String(chunk); });
          child.stderr!.on('data', chunk => { stderr += String(chunk); });
          const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Concurrent SQLite startup exceeded its process deadline.')); }, 10_000);
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(stdout.trim()); else reject(new Error(`Concurrent SQLite startup failed (${code}): ${stderr}`)); });
        }));
        try {
          await Promise.race([Promise.all(ready), Promise.all(completed).then(() => { throw new Error('SQLite processes exited before the synchronized launch.'); })]);
          for (const child of children) child.send('start');
          expect(await Promise.all(completed)).toEqual(['ok', 'ok']);
          const store = new DevelopmentStore(path);
          try {
            expect(store.database.prepare('PRAGMA user_version').get()).toEqual({ user_version: currentVersion });
            expect(store.database.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
            expect(store.database.prepare('SELECT COUNT(*) AS n FROM documents').get()).toEqual({ n: 3 });
            expect(store.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
          } finally { store.close(); }
        } finally { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); }
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);
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
      seedRetainedEvidence(original);
      const projection = original.match(SYNTHETIC_IDS.matchId).state_json;
      // Recreate the earlier v1 layout by removing only columns/tables introduced by expand migrations.
      original.database.exec(dropPrivilegeSchema + 'DROP TABLE native_app_devices; ALTER TABLE events DROP COLUMN actor_id; ALTER TABLE accounts DROP COLUMN strong_auth_enrolled; DROP TABLE clock_mappings; DROP TABLE clock_challenges; DROP TABLE reconciliation_proposals; DROP TABLE devices; DROP TABLE documents; DROP TABLE privacy_pending_keys; ALTER TABLE privacy_requests DROP COLUMN team_id; ALTER TABLE privacy_requests DROP COLUMN season_id; ALTER TABLE privacy_requests DROP COLUMN affected_memberships_json; PRAGMA user_version=1;');
      expect(tableNames(original.database)).toEqual([...historicalTables].sort());
      expect(original.database.prepare('PRAGMA table_info(accounts)').all().map(row => row.name)).toEqual(['id', 'issuer', 'subject', 'classification', 'adult_verified', 'status']);
      const preserved = snapshotRows(original.database, ['matches', 'streams', 'controller_grants', 'controller_history', 'conflicting_submissions', 'transfers', 'idempotency', 'audit', 'jobs']);
      original.close();
      const migrated = new DevelopmentStore(path);
      expect(migrated.database.prepare('PRAGMA user_version').get()).toEqual({ user_version: currentVersion });
      expect(migrated.match(SYNTHETIC_IDS.matchId).state_json).toBe(projection);
      expect(snapshotRows(migrated.database, Object.keys(preserved))).toEqual(preserved);
      expect(migrated.database.prepare('SELECT envelope_json,signature,disposition,reason,client_sequence,actor_id FROM events WHERE event_id=?').get('retained-offline-event')).toEqual({ envelope_json: '{ "engineVersion": "legacy-unsupported", "original": "retained bytes" }\n', signature: 'original-signature', disposition: 'quarantined', reason: 'UNSUPPORTED_EVENT_VERSION', client_sequence: 7, actor_id: null });
      expect(migrated.database.prepare('SELECT * FROM native_app_devices').all()).toEqual([]);
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
  it('expands an actual version seven schema once while preserving retained history and a published asset pointer', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'longball-native-device-migration-'));
    const path = join(directory, 'version-seven.sqlite');
    let store: DevelopmentStore | undefined;
    try {
      store = new DevelopmentStore(path, () => observedAt); store.seedSynthetic(); seedRetainedEvidence(store);
      const repository = new SqliteBrandRepository(store.database, async work => work());
      store.database.prepare('INSERT INTO branding_clubs VALUES(?)').run('retained-club');
      store.database.prepare('INSERT INTO branding_teams VALUES(?,?)').run(SYNTHETIC_IDS.teamId, 'retained-club');
      await repository.create({
        id: 'retained-brand-upload', asset_id: 'retained-logo', revision: 1, kind: 'team_logo', club_id: 'retained-club', team_id: SYNTHETIC_IDS.teamId, owner_id: 'synthetic-account-manager',
        request_id: 'retained-logo-request', request_signature: 'c'.repeat(64), status: 'linked', expected_bytes: 1, expected_sha: 'd'.repeat(64), declared_mime: 'image/png', token_hash: 'e'.repeat(64),
        expires_at: observedAt + 1000, created_at: observedAt - 1000, processed_at: observedAt, original_key: 'quarantine/retained.png', display_key: 'derivatives/retained-display.png', thumbnail_key: 'derivatives/retained-thumbnail.png', width: 64, height: 32,
        scanner_engine: 'historical-fictional-fixture', failure_code: null, attempt: null, lease_until: null,
      });
      store.database.prepare('INSERT INTO brand_slots(kind,club_id,team_id,version,asset_id,asset_revision,reviewed_revision,policy_version,confirmed_by,confirmed_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('team_logo', 'retained-club', SYNTHETIC_IDS.teamId, 4, 'retained-logo', 1, 1, 'logo-rights-v1', 'synthetic-account-manager', observedAt);
      // Version eight introduces only this table and its trigger. Existing feature tables are independent.
      store.database.exec(dropPrivilegeSchema + 'DROP TABLE native_app_devices; PRAGMA user_version=7;');
      expect(store.database.prepare("SELECT name FROM sqlite_schema WHERE name IN('native_app_devices','native_device_identity_immutable')").all()).toEqual([]);
      const previousTables = tableNames(store.database);
      const preserved = snapshotRows(store.database, previousTables);
      const schema = store.database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
      store.close(); store = new DevelopmentStore(path, () => observedAt);
      expect(store.database.prepare('PRAGMA user_version').get()).toEqual({ user_version: currentVersion });
      expect(snapshotRows(store.database, previousTables)).toEqual(preserved);
      expect(store.database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT IN('administration_grants','administrative_memberships','directory_clubs','directory_teams','push_registrations','push_registration_identity','push_registration_enrolment_insert','push_registration_enrolment_update','native_app_devices','native_device_identity_immutable','team_privilege_states','team_privilege_decisions','team_privileges_new_team','team_privilege_state_identity','team_privilege_decision_immutable_update','team_privilege_decision_immutable_delete') ORDER BY type,name").all()).toEqual(schema);
      // A legacy controller device is not silently enrolled as a native installation.
      expect(store.database.prepare('SELECT * FROM native_app_devices').all()).toEqual([]);
      const principal = store.principal({ issuer: 'urn:longball:synthetic', subject: 'synthetic-account-manager', strongAuth: true, authenticatedAt: observedAt });
      store.enrolDevice(principal, { deviceId: 'new-native-device', platform: 'ios' });
      const nativeRows = store.database.prepare('SELECT * FROM native_app_devices').all();
      expect(nativeRows).toHaveLength(1);
      expect(() => store!.database.prepare('UPDATE native_app_devices SET registered_at=? WHERE device_id=?').run(observedAt - 1, 'new-native-device')).toThrow('Immutable native device identity');
      store.close(); store = new DevelopmentStore(path, () => observedAt);
      expect(snapshotRows(store.database, previousTables)).toEqual(preserved);
      expect(store.database.prepare('SELECT * FROM native_app_devices').all()).toEqual(nativeRows);
      expect(store.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(store.integrity()).toBe('ok');
    } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('refuses an unexpected version seven native-table collision without adopting or replacing its evidence', () => {
    const directory = mkdtempSync(join(tmpdir(), 'longball-native-migration-collision-'));
    const path = join(directory, 'collision.sqlite');
    try {
      const original = new DevelopmentStore(path); original.seedSynthetic(); seedRetainedEvidence(original);
      original.database.exec(dropPrivilegeSchema + "DROP TABLE native_app_devices; CREATE TABLE native_app_devices(device_id TEXT PRIMARY KEY,retained TEXT NOT NULL); INSERT INTO native_app_devices VALUES('legacy-evidence','keep exact bytes'); PRAGMA user_version=7;");
      const preserved = snapshotRows(original.database, tableNames(original.database));
      const schema = original.database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
      original.close();
      expect(() => new DevelopmentStore(path)).toThrow('table native_app_devices already exists');
      const retained = new DatabaseSync(path);
      try {
        expect(retained.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 });
        expect(snapshotRows(retained, Object.keys(preserved))).toEqual(preserved);
        expect(retained.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all()).toEqual(schema);
      } finally { retained.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('retains legacy request history, selects the earliest pending global request and marks unscoped leave for review',()=>{
    const directory=mkdtempSync(join(tmpdir(),'longball-privacy-migration-')),path=join(directory,'old.sqlite');
    try{
      const original=new DevelopmentStore(path);original.seedSynthetic();
      original.database.exec(dropPrivilegeSchema + 'DROP TABLE native_app_devices; DROP TABLE privacy_pending_keys; ALTER TABLE privacy_requests DROP COLUMN team_id; ALTER TABLE privacy_requests DROP COLUMN season_id; ALTER TABLE privacy_requests DROP COLUMN affected_memberships_json; PRAGMA user_version=6;');
      expect(tableNames(original.database)).toEqual([...versionSixTables].sort());
      expect(original.database.prepare('PRAGMA table_info(privacy_requests)').all().map(row => row.name)).toEqual(['id', 'account_id', 'kind', 'status', 'policy_version', 'verified_at', 'created_at']);
      const insert=original.database.prepare('INSERT INTO privacy_requests VALUES(?,?,?,?,NULL,NULL,?)');
      insert.run('legacy-export-b','synthetic-account-player-01','export','pending_verification_and_policy',10);
      insert.run('legacy-export-a','synthetic-account-player-01','export','pending_verification_and_policy',10);
      insert.run('legacy-leave','synthetic-account-player-01','leave_team','pending_verification_and_policy',11);
      insert.run('retained-nonpending','synthetic-account-player-01','leave_team','operator_review_recorded',12);original.close();
      const migrated=new DevelopmentStore(path);
      expect(migrated.database.prepare('SELECT id,status FROM privacy_requests ORDER BY id').all()).toEqual([{id:'legacy-export-a',status:'pending_verification_and_policy'},{id:'legacy-export-b',status:'pending_verification_and_policy'},{id:'legacy-leave',status:'needs_scope'},{id:'retained-nonpending',status:'operator_review_recorded'}]);
      expect(migrated.database.prepare('SELECT * FROM privacy_pending_keys').all()).toEqual([{business_key:'["synthetic-account-player-01","export","all_memberships"]',request_id:'legacy-export-a'}]);
      expect(migrated.database.prepare('SELECT affected_memberships_json FROM privacy_requests').all()).toEqual(Array.from({length:4},()=>({affected_memberships_json:null})));migrated.close();
    }finally{rmSync(directory,{recursive:true,force:true});}
  });
});
