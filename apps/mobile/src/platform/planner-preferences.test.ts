import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitJournal, loadProjection, migrateJournal, type SqlConnection, type TransactionDatabase } from './journal-core';
import { serializeKeyedConnection } from './journal-queue';
import { assertPlannerJournalAccess, assertPlannerPreferences, confirmPlannerPreferences, createPlannerPreferences, plannerPreferenceDocumentId, plannerPreferencesAtDecision, plannerPreferenceScope, resetPlannerPositionMode } from './planner-preferences';
import type { PlannerPreferences } from './planner-preferences';
import type { JournalDiagnostics } from './types';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(run => run()));
const local = plannerPreferenceScope('synthetic-match', 'review-device', { kind: 'fictional-local' });
const accepted = { batchPreference: 3, leadThreshold: 4, returnToNormal: false };
const controller = { baseUrl: 'https://api.example.test', issuer: 'https://issuer.example.test', accountId: 'manager-a', teamId: 'roma', seasonId: '2026-27', matchId: 'synthetic-match', deviceId: 'manager-wire-device' };
const diagnostics: JournalDiagnostics = { mode: 'synthetic-browser', cipherVersion: null, backupExcluded: false, deviceId: 'review-device', pendingCount: 0, conflictCount: 0, savedCount: 0, wrongKeyProbe: 'unsupported' };

async function open(path = ':memory:') {
  const raw = new DatabaseSync(path); cleanup.push(() => raw.close());
  let fail = false;
  const sql: SqlConnection = {
    execAsync: async query => { raw.exec(query); },
    runAsync: async (query, ...values) => {
      if (fail && query.includes('INSERT INTO projections')) throw new Error('disk write denied');
      return raw.prepare(query).run(...values);
    },
    getFirstAsync: async <T>(query: string, ...values: (string | number | null)[]) => (raw.prepare(query).get(...values) as T | undefined) ?? null,
  };
  const { database } = serializeKeyedConnection(sql);
  await migrateJournal(database);
  return { raw, database, setFailure: (value: boolean) => { fail = value; } };
}
async function save(database: TransactionDatabase, value: PlannerPreferences, eventId: string, expectedRevision: number) {
  return commitJournal(database, { eventId, matchId: plannerPreferenceDocumentId(value.scope), deviceId: value.scope.journalDeviceId, controllerEpoch: 0, baseRevision: 0, expectedLocalRevision: expectedRevision, event: { type: 'planner.settings.local', sourceRevision: expectedRevision }, projection: value });
}
async function read(database: SqlConnection) {
  const value = await loadProjection<PlannerPreferences>(database, plannerPreferenceDocumentId(local));
  assertPlannerPreferences(value, local);
  return value;
}

describe('match-scoped planner preferences (real SQLite transactions; not SQLCipher/device proof)', () => {
  it('reopens explicitly confirmed settings while leaving canonical match history unchanged', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'longball-planner-'));
    cleanup.unshift(() => rmSync(directory, { recursive: true, force: true }));
    const filename = join(directory, 'journal.db');
    const first = await open(filename);
    const canonical = { revision: 3, status: 'preparation', score: { for: 0, against: 0 }, intervals: [] };
    await commitJournal(first.database, { eventId: 'canonical-event', matchId: local.matchId, deviceId: local.journalDeviceId, controllerEpoch: 0, baseRevision: 0, expectedLocalRevision: -1, event: { type: 'fixture-opened' }, projection: canonical });
    const before = first.raw.prepare('SELECT * FROM events WHERE match_id=?').all(local.matchId);
    const unconfirmed = createPlannerPreferences(local);
    expect(unconfirmed.settings).toBeNull();
    await save(first.database, unconfirmed, 'preferences-initialized', -1);
    const confirmed = { ...confirmPlannerPreferences(unconfirmed, accepted), revision: 1 };
    await save(first.database, confirmed, 'settings-confirmed', 0);
    const reopened = await open(filename);
    expect((await read(reopened.database)).settings).toEqual(accepted);
    expect(await loadProjection(reopened.database, local.matchId)).toEqual(canonical);
    expect(reopened.raw.prepare('SELECT * FROM events WHERE match_id=?').all(local.matchId)).toEqual(before);
  });

  it('retains sticky adventurous mode after a falling lead and a manual reset across reload', async () => {
    const { database } = await open();
    let preferences = confirmPlannerPreferences(createPlannerPreferences(local), accepted);
    preferences = plannerPreferencesAtDecision(preferences, { matchId: local.matchId, revision: 10, ourScore: 5, oppositionScore: 1 });
    await save(database, preferences, 'entered-adventurous', -1);
    const restored = await read(database);
    expect(plannerPreferencesAtDecision(restored, { matchId: local.matchId, revision: 11, ourScore: 5, oppositionScore: 3 }).positionMode).toBe('adventurous');
    const reset = { ...resetPlannerPositionMode(restored, 11), revision: 1 };
    await save(database, reset, 'explicit-manual-reset', 0);
    const resetAfterReload = await read(database);
    expect(plannerPreferencesAtDecision(resetAfterReload, { matchId: local.matchId, revision: 11, ourScore: 8, oppositionScore: 1 }).positionMode).toBe('normal');
    expect(resetAfterReload.manualResetAtSourceRevision).toBe(11);
  });

  it('does not mark a failed settings confirmation saved, and retries without a partial projection', async () => {
    const { database, raw, setFailure } = await open();
    await save(database, createPlannerPreferences(local), 'initial', -1);
    const candidate = { ...confirmPlannerPreferences(await read(database), accepted), revision: 1 };
    setFailure(true);
    await expect(save(database, candidate, 'retained-confirmation', 0)).rejects.toThrow('disk write denied');
    expect((await read(database)).settings).toBeNull();
    expect(raw.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 });
    setFailure(false);
    expect((await save(database, candidate, 'retained-confirmation', 0)).sequence).toBe(2);
    expect((await read(database)).settings).toEqual(accepted);
  });

  it('keeps the winning confirmation and quarantines a concurrent stale setting change', async () => {
    const { database, raw } = await open();
    const seed = createPlannerPreferences(local); await save(database, seed, 'seed', -1);
    await save(database, { ...confirmPlannerPreferences(seed, accepted), revision: 1 }, 'winner', 0);
    await expect(save(database, { ...confirmPlannerPreferences(seed, { ...accepted, leadThreshold: 2 }), revision: 1 }, 'stale', 0)).rejects.toThrow('stale');
    expect((await read(database)).settings).toEqual(accepted);
    expect(raw.prepare('SELECT disposition FROM outbox WHERE event_id=?').get('stale')).toEqual({ disposition: 'quarantined' });
  });

  it('separates account, API, issuer, team, season, match and device scopes', () => {
    const scope = plannerPreferenceScope(local.matchId, local.journalDeviceId, { kind: 'connected', mode: 'oidc', controllerScope: controller });
    const value = confirmPlannerPreferences(createPlannerPreferences(scope), accepted);
    for (const field of ['accountId', 'baseUrl', 'issuer', 'teamId', 'seasonId', 'deviceId'] as const) {
      const other = plannerPreferenceScope(local.matchId, local.journalDeviceId, { kind: 'connected', mode: 'oidc', controllerScope: { ...controller, [field]: `${controller[field]}-other` } });
      expect(plannerPreferenceDocumentId(other)).not.toBe(plannerPreferenceDocumentId(scope));
      expect(() => assertPlannerPreferences(value, other)).toThrow('another account');
    }
    expect(() => plannerPreferenceScope('other-match', local.journalDeviceId, { kind: 'connected', mode: 'oidc', controllerScope: controller })).toThrow('another match');
    const otherPhysical = { ...scope, journalDeviceId: 'other-physical-device' };
    expect(() => assertPlannerPreferences(value, otherPhysical)).toThrow('another account');
  });

  it('refuses real-account browser caching and incomplete native protection', () => {
    const scope = plannerPreferenceScope(local.matchId, local.journalDeviceId, { kind: 'connected', mode: 'oidc', controllerScope: controller });
    expect(() => assertPlannerJournalAccess(diagnostics, scope)).toThrow('native encrypted journal');
    expect(() => assertPlannerJournalAccess(diagnostics, local)).not.toThrow();
    const native = { ...diagnostics, mode: 'encrypted-native' as const, cipherVersion: 'test-only-diagnostics', backupExcluded: true };
    expect(() => assertPlannerJournalAccess(native, scope)).not.toThrow();
    expect(() => assertPlannerJournalAccess({ ...native, cipherVersion: null }, scope)).toThrow('backup exclusion');
    expect(() => assertPlannerJournalAccess({ ...native, deviceId: 'other-device' }, scope)).toThrow('another device');
  });

  it('refuses damaged/future settings without replacing retained values or approving defaults', async () => {
    const { database, raw } = await open();
    const damaged = { ...createPlannerPreferences(local), schemaVersion: 99, settings: { ...accepted, returnToNormal: null } };
    await commitJournal(database, { eventId: 'future-settings', matchId: plannerPreferenceDocumentId(local), deviceId: local.journalDeviceId, controllerEpoch: 0, baseRevision: 0, expectedLocalRevision: -1, event: { type: 'fixture-future-settings' }, projection: damaged });
    const before = raw.prepare('SELECT * FROM projections').all();
    await expect(read(database)).rejects.toThrow('unsupported or invalid version');
    expect(raw.prepare('SELECT * FROM projections').all()).toEqual(before);
    expect(() => confirmPlannerPreferences(createPlannerPreferences(local), { ...accepted, returnToNormal: null } as never)).toThrow('explicit return-to-normal');
  });
});
