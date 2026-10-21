import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { enterFictionalReview, openWorkspaceTab } from './review-entry.mjs';

const baseURL = process.env.LONGBALL_REVIEW_BASE_URL ?? 'http://127.0.0.1:4386';
const apiURL = 'http://127.0.0.1:4387', tunnel = 'https://longball-training-review.trycloudflare.com';
const directory = '.local/training-review', results = [], servers = [];
await mkdir(directory, { recursive: true });
const log = createWriteStream(`${directory}/api.log`);
const api = spawn(process.execPath, ['apps/api/dist/api.mjs'], { env: { ...process.env, NODE_ENV: 'development', LONGBALL_SYNTHETIC_AUTH: '1', LONGBALL_DATABASE_URL: '', LONGBALL_DATABASE_URL_FILE: '', LONGBALL_API_HOST: '127.0.0.1', LONGBALL_API_PORT: '4387', LONGBALL_API_DATABASE: `${directory}/service-${Date.now()}.sqlite`, LONGBALL_MEDIA_DIRECTORY: `${directory}/media`, LONGBALL_API_ORIGINS: new URL(baseURL).origin }, stdio: ['ignore', 'pipe', 'pipe'] });
api.stdout.pipe(log); api.stderr.pipe(log); servers.push(api);
const staticServer = spawn('python3', ['-m', 'http.server', '4386', '--bind', '127.0.0.1', '--directory', '.local/training-web'], { stdio: 'ignore' }); servers.push(staticServer);
const browser = await chromium.launch({ executablePath: process.env.LONGBALL_CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
async function available(url) {
  const deadline = Date.now() + 20_000;
  while (true) { try { assert((await fetch(url)).ok); return; } catch (error) { if (Date.now() > deadline) throw error; await new Promise(resolve => setTimeout(resolve, 100)); } }
}
try {
  await available(`${apiURL}/health`); await available(baseURL);
  for (const mode of ['local', 'connected']) {
    const context = await browser.newContext({ viewport: { width: 320, height: 844 }, reducedMotion: 'reduce' });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(20_000); page.on('pageerror', error => errors.push(error.message));
    const button = name => page.getByRole('button', { name, exact: true });
    const radio = name => page.getByRole('radio', { name, exact: true });
    const openTraining = async date => {
      if (mode === 'connected') await openWorkspaceTab(page, 'schedule');
      const back = button('Back to schedule'), filter = radio('Event type: Training');
      await back.or(filter).first().waitFor();
      if (await back.isVisible()) await back.click();
      await filter.click();
      await button(`Open training ${date}`).click();
    };

    const read = async () => mode === 'connected'
      ? (await (await fetch(`${apiURL}/v1/teams/synthetic-roma-u10/preparation?seasonId=synthetic-season-2026-27`, { headers: { Authorization: 'Bearer synthetic-manager-2' } })).json())
      : page.evaluate(() => new Promise((resolve, reject) => { const open = indexedDB.open('longball-synthetic-m0'); open.onerror = () => reject(open.error); open.onsuccess = () => { const db = open.result; const tx = db.transaction('journal', 'readonly'); const row = tx.objectStore('journal').get('record'); row.onsuccess = () => resolve(row.result.projections['synthetic-longball-application-v1'].preparation); row.onerror = () => reject(row.error); tx.oncomplete = () => db.close(); }; }));
    const until = async predicate => { const deadline = Date.now() + 12_000; while (true) { const state = await read(); if (predicate(state)) return state; if (Date.now() > deadline) throw new Error('Expected training save did not appear in the independent read.'); await new Promise(resolve => setTimeout(resolve, 50)); } };
    try {
      await page.route('https://raw.githubusercontent.com/CharlieOmniPoint/LongBall/preview/longball-m0/preview-status.json', route => route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: { state: 'ready', url: tunnel, startedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), sourceRevision: 'a'.repeat(40) } }));
      await page.route(`${tunnel}/**`, async route => { const response = await route.fetch({ url: apiURL + route.request().url().slice(tunnel.length) }); await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': new URL(baseURL).origin } }); });
      await page.goto(baseURL, { waitUntil: 'networkidle' }); await enterFictionalReview(page, 'manager', mode === 'connected' ? 'connected' : 'local');
      if (mode === 'connected') await openWorkspaceTab(page, 'schedule'); else await button('Schedule').click();
      await radio('Event type: Training').click();
      const before = await read();
      await page.getByTestId('training-series-create').click();
      await page.getByLabel('First training date (YYYY-MM-DD)', { exact: true }).fill('2026-11-05');
      await page.getByLabel('Number of weekly occurrences', { exact: true }).fill('3');
      await page.getByLabel('Series training time (HH:MM)', { exact: true }).fill('18:30');
      await page.getByLabel('Series training venue', { exact: true }).fill('Fictional recurring practice');
      await page.getByTestId('training-series-review').click();
      await page.getByText('2026-11-19 · 18:30', { exact: true }).waitFor();
      assert.equal((await read()).revision, before.revision, 'A preview must not persist the series.');
      await page.getByTestId('training-series-confirm').click();
      let state = await until(value => value.training.length === before.training.length + 3);
      const created = state.training.filter(item => item.venue === 'Fictional recurring practice');
      const ids = created.map(item => item.id);
      assert.equal(new Set(ids).size, 3); assert.equal(new Set(created.map(item => item.recurrenceGroupId)).size, 1);
      await openTraining('2026-11-05');
      await radio('Player 01 training reply: Available').click();
      await until(value => Object.values(value.training.find(item => item.id === ids[0]).responses).includes('available'));
      await openTraining('2026-11-05');
      await radio('Occurrence status: Held').click();
      await until(value => value.training.find(item => item.id === ids[0]).status === 'held');
      await openTraining('2026-11-05');
      await radio('Player 01 training attendance: Present').click();
      await until(value => Object.values(value.training.find(item => item.id === ids[0]).attendance).includes('present'));
      await openTraining('2026-11-12');
      await radio('Occurrence status: Cancelled').click();
      state = await until(value => value.training.find(item => item.id === ids[1]).status === 'cancelled');
      const preserved = state.training.filter(item => item.id !== ids[2]);
      await openTraining('2026-11-19');
      await page.getByTestId('training-series-manage').click();
      await page.getByLabel('Series training time (HH:MM)', { exact: true }).fill('19:15');
      await page.getByTestId('training-series-review').click();
      await page.getByTestId('training-series-confirm').click();
      state = await until(value => value.training.find(item => item.id === ids[2]).time === '19:15');
      assert.deepEqual(state.training.filter(item => item.id !== ids[2]), preserved);
      await openTraining('2026-11-19');
      await page.getByTestId('training-series-manage').click(); await button('Cancel scheduled occurrences').click();
      await page.getByTestId('training-series-review').click(); await page.getByTestId('training-series-confirm').click();
      state = await until(value => value.training.find(item => item.id === ids[2]).status === 'cancelled');
      assert.deepEqual(state.training.filter(item => item.id !== ids[2]), preserved);
      assert.equal(state.training.length, before.training.length + 3);
      assert.deepEqual(errors, []); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `${directory}/${mode}-series-retained.png`, fullPage: true, animations: 'disabled' });
      results.push({ mode, status: 'passed', occurrences: 3, checks: ['Preview does not write before confirmation.', 'Three dated stable occurrences save with one series identity.', 'Held attendance and cancelled occurrence remain unchanged during series time edit.', 'Explicit series cancellation retains all occurrences, original RSVP and attendance.'], browserErrors: errors });
    } catch (error) { await page.screenshot({ path: `${directory}/${mode}-failed.png`, fullPage: true }).catch(() => {}); throw error; }
    finally { await context.close(); }
  }
  await writeFile(`${directory}/report.json`, JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(), baseURL, viewport: '320x844', results, nativeDeviceEvidence: false, method: 'Actual UI controls; independent HTTP or read-only IndexedDB verification; no domain state injection. Fictional SQLite service only. No notification delivery claim.' }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', modes: results.length }));
} catch (error) { await writeFile(`${directory}/failure.json`, JSON.stringify({ results, error: String(error) }, null, 2) + '\n'); throw error; }
finally { await browser.close(); for (const server of servers) server.kill('SIGTERM'); log.end(); }
