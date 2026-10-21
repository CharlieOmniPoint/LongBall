import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installStartupDiagnostics, captureStartupDiagnostics } from './browser-startup-diagnostics.mjs';

/** Deliberate corruption fixtures in isolated fictional contexts. No reset/reseed or accepted-history edits. */
const directory = path.resolve('.local/storage-guard-review');
await mkdir(directory, { recursive: true });
const baseURL = process.env.LONGBALL_REVIEW_BASE_URL ?? 'http://127.0.0.1:4173';
const matchId = 'synthetic-roma-maple-2026-10-24';
const html = await (await fetch(baseURL)).text();
const entryPath = /src="([^"]*\/index-[^"]+\.js)"/.exec(html)?.[1];
assert(entryPath, 'The review page must expose its actual bundled entry.');
const entryUrl = new URL(entryPath, baseURL).href;
const artifact = { url: entryUrl, sha256: createHash('sha256').update(new Uint8Array(await (await fetch(entryUrl)).arrayBuffer())).digest('hex') };
const browser = await chromium.launch({ executablePath: existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined, headless: true, args: ['--no-sandbox'] });
const results = [];
const cases = [
  { id: 'blank-device', message: 'The saved browser device identity is invalid. Existing data and event history were retained; no replacement identity was created.' },
  { id: 'malformed-device', message: 'The saved browser device identity is invalid. Existing data and event history were retained; no replacement identity was created.' },
  { id: 'different-match', message: 'The saved match does not belong to the requested fixture. Existing data and event history were retained; no replacement match was created.' },
];
async function journalFixture(page, corruption = null) {
  return page.evaluate(({ corruption, matchId }) => new Promise((resolve, reject) => {
    const request = indexedDB.open('longball-synthetic-m0');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('journal', corruption ? 'readwrite' : 'readonly');
      const store = transaction.objectStore('journal'), read = store.get('record');
      let saved;
      read.onsuccess = () => {
        saved = read.result;
        if (!saved?.projections?.[matchId]) { transaction.abort(); return; }
        if (corruption === 'blank-device') saved.deviceId = '';
        if (corruption === 'malformed-device') saved.deviceId = 'valid-looking-device\n';
        if (corruption === 'different-match') {
          // Break any shared reference first, so raw command/config history is not changed by the fixture.
          saved.projections[matchId] = { ...saved.projections[matchId], config: { ...saved.projections[matchId].config, matchId: 'corrupt-projection-other-fixture' } };
        }
        if (corruption) store.put(saved, 'record');
      };
      transaction.oncomplete = () => { database.close(); resolve(saved); };
      transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error('The fictional guard fixture could not be inspected.')); };
    };
  }), { corruption, matchId });
}
try {
  for (const test of cases) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const observations = await installStartupDiagnostics(page);
    page.setDefaultTimeout(20_000);
    try {
      await page.goto(baseURL, { waitUntil: 'networkidle' });
      await page.getByTestId('prepare-match').waitFor();
      const body = await page.locator('body').innerText();
      assert.match(body, /fictional players/, 'Corruption fixtures require a newly isolated fictional roster.');
      assert.match(body, /Local manager review · no live team data/, 'Corruption fixtures are prohibited outside the local fictional review.');
      const original = await journalFixture(page);
      assert.equal(original.projections[matchId].config.matchId, matchId);
      const retained = await journalFixture(page, test.id);
      const retainedJson = JSON.stringify(retained);
      assert.deepEqual(retained.events, original.events, 'The deliberate fixture must preserve every original event.');
      assert.deepEqual(retained.checkpoints, original.checkpoints, 'The deliberate fixture must preserve reserved sequence history.');
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByText(test.message, { exact: true }).waitFor();
      assert.equal(await page.getByTestId('prepare-match').count(), 0);
      assert.equal(await page.getByText('Opening the local Roma fixture…', { exact: true }).count(), 0, 'Corruption must be an explicit error, not an indefinite spinner.');
      assert.equal(JSON.stringify(await journalFixture(page)), retainedJson, 'Reopen may not replace, relabel or reseed saved data.');
      const closedBefore = await page.evaluate(() => globalThis.__longballStartupDiagnostics.operations.filter(item => item.kind === 'database.close').length);
      await page.getByRole('button', { name: 'Retry opening match', exact: true }).click();
      await page.waitForFunction(({ count, message }) => globalThis.__longballStartupDiagnostics.operations.filter(item => item.kind === 'database.close').length > count && document.body.innerText.includes(message), { count: closedBefore, message: test.message });
      assert.equal(JSON.stringify(await journalFixture(page)), retainedJson, 'Retry may not manufacture a replacement identity or history.');
      assert.equal(observations.pageErrors.length, 0);
      await page.screenshot({ path: path.join(directory, `${test.id}.png`) });
      results.push({ name: test.id, status: 'passed', explicitRetainedError: true, exactRecordPreservedAfterReopenAndRetry: true, retainedRecordSha256: createHash('sha256').update(retainedJson).digest('hex'), originalEventCount: Object.keys(original.events).length });
      console.log(`PASSED ${test.id}`);
    } catch (error) {
      await captureStartupDiagnostics(page, test.id, directory, observations);
      await page.screenshot({ path: path.join(directory, `${test.id}-failed.png`) }).catch(() => {});
      results.push({ name: test.id, status: 'failed', error: error.message });
      console.error(`FAILED ${test.id}: ${error.message}`);
    } finally { await context.close(); }
  }
} finally {
  await browser.close();
  await writeFile(path.join(directory, 'results.json'), `${JSON.stringify({ baseURL, artifact, deliberateFictionalCorruptionFixtures: true, results }, null, 2)}\n`);
}
assert(results.every(item => item.status === 'passed'), 'A corruption guard failed; original fixture evidence was retained.');
