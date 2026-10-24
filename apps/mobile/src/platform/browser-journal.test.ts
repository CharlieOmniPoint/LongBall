import { describe, expect, it } from 'vitest';
import { browserStorageKey, commitBrowser, createBrowserRecord, loadBrowserRecord, validateBrowserRecord } from './browser-journal';
import type { LocalStorageAdapter } from './browser-journal';

function storageAdapter() {
  const values = new Map<string, string>();
  let denied = false;
  const storage: LocalStorageAdapter = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { if (denied) throw new Error('QuotaExceededError'); values.set(key, value); },
  };
  return { storage, setDenied: (value: boolean) => { denied = value; } };
}

const input = (eventId: string, controllerEpoch = 1) => ({
  eventId, matchId: 'synthetic-match', deviceId: 'review-device', controllerEpoch,
  baseRevision: 0, event: { type: 'synthetic-change', eventId }, projection: { last: eventId },
});

describe('synthetic browser persistence', () => {
  it('survives adapter reopen and keeps sequence across epochs', () => {
    const { storage } = storageAdapter();
    createBrowserRecord(storage, 'review-device');
    expect(commitBrowser(storage, input('first'))).toEqual({ sequence: 1, previousEventId: null, duplicate: false });
    const reopened = createBrowserRecord(storage, 'must-not-replace-device');
    expect(reopened.deviceId).toBe('review-device');
    expect(commitBrowser(storage, input('second', 3))).toEqual({ sequence: 2, previousEventId: 'first', duplicate: false });
    expect(commitBrowser(storage, input('first'))).toEqual({ sequence: 1, previousEventId: null, duplicate: true });
    expect(loadBrowserRecord(storage)?.projections['synthetic-match']).toEqual({ last: 'second' });
  });

  it('retains prior history when storage fails and does not display or reserve a failed commit', () => {
    const { storage, setDenied } = storageAdapter();
    createBrowserRecord(storage, 'review-device');
    commitBrowser(storage, input('first'));
    setDenied(true);
    expect(() => commitBrowser(storage, input('second'))).toThrow('QuotaExceededError');
    expect(loadBrowserRecord(storage)?.projections['synthetic-match']).toEqual({ last: 'first' });
    setDenied(false);
    expect(commitBrowser(storage, input('second')).sequence).toBe(2);
  });

  it('refuses conflicting retries and damaged records without deleting either', () => {
    const { storage } = storageAdapter();
    createBrowserRecord(storage, 'review-device');
    commitBrowser(storage, input('first'));
    expect(() => commitBrowser(storage, { ...input('first'), projection: { last: 'changed' } })).toThrow('different content');
    const damaged = '{"version":99,"unsynchronized":"keep"}';
    storage.setItem(browserStorageKey, damaged);
    expect(() => createBrowserRecord(storage, 'new')).toThrow('retained');
    expect(storage.getItem(browserStorageKey)).toBe(damaged);
  });

  it.each(['', ' ', '\n', 'review-device\n', 'review-device\r\n', 'unsafe/device', 'device.with.dots', 'é', 'a'.repeat(151), null, 7])(
    'refuses retained device identity %j on load, reopen and commit without replacing any saved bytes',
    (deviceId) => {
      const { storage } = storageAdapter();
      createBrowserRecord(storage, 'review-device');
      commitBrowser(storage, input('retained-event'));
      const damaged = { ...loadBrowserRecord(storage)!, deviceId };
      // Preserve formatting too: a failed open must not reserialize, migrate or allocate an identity.
      const original = JSON.stringify(damaged, null, 2);
      storage.setItem(browserStorageKey, original);
      for (const operation of [
        () => loadBrowserRecord(storage),
        () => createBrowserRecord(storage, 'replacement-must-not-be-used'),
        () => commitBrowser(storage, input('must-not-be-written')),
      ]) {
        expect(operation).toThrow('saved browser device identity is invalid');
        expect(storage.getItem(browserStorageKey)).toBe(original);
        expect(JSON.parse(storage.getItem(browserStorageKey)!).events).toEqual(damaged.events);
      }
    },
  );

  it('keeps canonical retained identifiers unchanged through the150-character boundary', () => {
    for (const deviceId of ['a', 'Review_device-01', 'a'.repeat(150)]) {
      const record = { version: 1, deviceId, events: {}, projections: {}, checkpoints: {} };
      expect(validateBrowserRecord(record)).toBe(record);
    }
  });

  it('rejects a second tab using a stale source revision without overwriting the saved match', () => {
    const { storage, setDenied } = storageAdapter();
    createBrowserRecord(storage, 'review-device');
    commitBrowser(storage, { ...input('initial'), expectedLocalRevision: -1, projection: { revision: 0 } });
    const winner = { ...input('winner'), expectedLocalRevision: 0, projection: { revision: 1 } };
    commitBrowser(storage, winner);
    setDenied(true);
    expect(() => commitBrowser(storage, { ...input('stale'), expectedLocalRevision: 0, projection: { revision: 1 } })).toThrow('QuotaExceededError');
    expect(Object.keys(loadBrowserRecord(storage)?.events ?? {})).toEqual(['initial', 'winner']);
    setDenied(false);
    expect(() => commitBrowser(storage, { ...input('stale'), expectedLocalRevision: 0, projection: { revision: 1 } })).toThrow('stale');
    expect(Object.keys(loadBrowserRecord(storage)?.events ?? {})).toEqual(['initial', 'winner', 'stale']);
    expect(loadBrowserRecord(storage)?.events.stale.disposition).toBe('quarantined');
    expect(loadBrowserRecord(storage)?.projections['synthetic-match']).toEqual({ revision: 1 });
    expect(() => commitBrowser(storage, { ...input('stale'), expectedLocalRevision: 0, projection: { revision: 1 } }))
      .toThrow('retained for review');
    expect(commitBrowser(storage, winner).duplicate).toBe(true);
  });
});
