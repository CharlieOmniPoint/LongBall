import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Pass-through observation only: never reads/writes application values or changes transaction lifetime. */
export async function installStartupDiagnostics(page) {
  const external = { console: [], pageErrors: [], failedRequests: [] };
  page.on('console', item => { if (['error', 'warning'].includes(item.type())) external.console.push({ type: item.type(), text: item.text() }); });
  page.on('pageerror', error => external.pageErrors.push(error.message));
  page.on('requestfailed', request => external.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
  await page.addInitScript(() => {
    const state = { sequence: 0, operations: [], timerTicks: 0, lastTimerAt: null, animationFrames: 0, lastFrameAt: null };
    globalThis.__longballStartupDiagnostics = state;
    setInterval(() => { state.timerTicks += 1; state.lastTimerAt = performance.now(); }, 1000);
    const frame = () => { state.animationFrames += 1; state.lastFrameAt = performance.now(); requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    const log = (kind, detail = {}) => {
      state.operations.push({ kind, at: performance.now(), ...detail });
      if (state.operations.length > 300) state.operations.shift();
    };
    const originalOpen = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args) {
      const id = ++state.sequence;
      log('open.requested', { id, name: args[0], version: args[1] ?? null });
      const request = Reflect.apply(originalOpen, this, args);
      for (const event of ['upgradeneeded', 'blocked', 'error', 'success']) request.addEventListener(event, () => {
        log(`open.${event}`, { id, name: args[0], error: event === 'error' ? request.error?.message ?? null : null });
        if (event === 'success') request.result.addEventListener('versionchange', () => log('database.versionchange', { name: args[0] }));
      });
      return request;
    };
    const originalTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const id = ++state.sequence;
      log('transaction.requested', { id, name: this.name, stores: typeof args[0] === 'string' ? [args[0]] : Array.from(args[0]), mode: args[1] ?? 'readonly' });
      const transaction = Reflect.apply(originalTransaction, this, args);
      for (const event of ['complete', 'abort', 'error']) transaction.addEventListener(event, () => log(`transaction.${event}`, { id, error: transaction.error?.message ?? null }));
      return transaction;
    };
    const originalClose = IDBDatabase.prototype.close;
    IDBDatabase.prototype.close = function (...args) { log('database.close', { name: this.name }); return Reflect.apply(originalClose, this, args); };
  });
  return external;
}

/** Existing-store read only, bounded so a hung storage request cannot prevent evidence capture. */
export async function captureStartupDiagnostics(page, label, directory, external = {}) {
  const observed = await page.evaluate(async () => {
    const bounded = async (operation) => {
      let timer;
      try { return await Promise.race([operation(), new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), 2000); })]); }
      catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
      finally { clearTimeout(timer); }
    };
    const operations = structuredClone(globalThis.__longballStartupDiagnostics ?? null);
    const databases = await bounded(() => indexedDB.databases());
    const locks = await bounded(() => navigator.locks?.query() ?? Promise.resolve(null));
    const record = Array.isArray(databases) && databases.some(item => item.name === 'longball-synthetic-m0') ? await bounded(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('longball-synthetic-m0');
      request.onerror = () => reject(request.error);
      request.onblocked = () => resolve({ blocked: true });
      request.onsuccess = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('journal')) { database.close(); resolve({ journalStoreMissing: true }); return; }
        const transaction = database.transaction('journal', 'readonly');
        const read = transaction.objectStore('journal').get('record');
        transaction.oncomplete = () => { database.close(); const value = read.result; resolve(value ? { version: value.version, deviceId: value.deviceId, projections: Object.entries(value.projections ?? {}).map(([id, projection]) => ({ id, kind: projection?.kind ?? null, revision: projection?.revision ?? null, storedMatchId: projection?.config?.matchId ?? null, activeMatchId: projection?.activeMatchConfig?.matchId ?? null })), eventCount: Object.keys(value.events ?? {}).length, checkpointIds: Object.keys(value.checkpoints ?? {}) } : { recordMissing: true }); };
        transaction.onabort = () => { database.close(); reject(transaction.error); };
      };
    })) : { existingDatabaseUnavailable: true };
    return { readyState: document.readyState, visibility: document.visibilityState, operations, databases, locks, record, body: document.body.innerText.slice(0, 4000) };
  }).catch(error => ({ evaluateError: error.message }));
  const result = { label, at: new Date().toISOString(), url: page.url(), ...external, observed };
  await writeFile(path.join(directory, `${label}-startup-diagnostics.json`), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
