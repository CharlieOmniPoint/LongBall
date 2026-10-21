import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { enterFictionalReview, openWorkspaceTab } from './review-entry.mjs';
import { captureReviewArtifacts, assertReviewArtifactsUnchanged, assertReviewApiPortAvailable } from './review-artifacts.mjs';

// Transport-only discovery redirect to a new isolated fictional API. No match state injection.
const baseURL = process.env.LONGBALL_REVIEW_BASE_URL ?? 'http://127.0.0.1:4390';
const api = process.env.LONGBALL_REVIEW_API_URL ?? 'http://127.0.0.1:4391';
const apiEntry = process.env.LONGBALL_REVIEW_API_ENTRY ?? '.local/policy-review/api/api.mjs';
const directory = path.resolve(process.env.LONGBALL_REVIEW_OUTPUT ?? '.local/policy-review/connected');
const tunnel = 'https://longball-policy-review.trycloudflare.com';
const matchId = 'synthetic-roma-maple-2026-10-24';
const accountId = 'synthetic-account-manager-2';
await mkdir(directory, { recursive: true });
await assertReviewApiPortAvailable(api);
const artifacts = await captureReviewArtifacts(baseURL, apiEntry);
const runId = Date.now();
const log = createWriteStream(path.join(directory, `${runId}-api.log`));
const server = spawn(process.execPath, [apiEntry], { env: { ...process.env, NODE_ENV: 'development', LONGBALL_SYNTHETIC_AUTH: '1', LONGBALL_DATABASE_URL: '', LONGBALL_DATABASE_URL_FILE: '', LONGBALL_API_HOST: '127.0.0.1', LONGBALL_API_PORT: new URL(api).port, LONGBALL_API_DATABASE: path.join(directory, `${runId}.sqlite`), LONGBALL_MEDIA_DIRECTORY: path.join(directory, `${runId}-media`), LONGBALL_API_ORIGINS: new URL(baseURL).origin }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.pipe(log); server.stderr.pipe(log);
let startupError; server.on('error', error => { startupError = error; });
const browser = await chromium.launch({ executablePath: process.env.LONGBALL_CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
const errors = [], checks = [], pages = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate, label) {
  const deadline = Date.now() + 25_000;
  let value;
  do { value = await read(); if (predicate(value)) return value; await sleep(50); } while (Date.now() < deadline);
  assert.fail(`${label}; ${JSON.stringify(value)?.slice(0, 300)}`);
}
async function stored(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('longball-synthetic-m0');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, transaction = db.transaction('journal', 'readonly');
      const read = transaction.objectStore('journal').get('record');
      transaction.oncomplete = () => { db.close(); resolve(read.result); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  }));
}
async function connected(page) { return Object.values((await stored(page))?.projections ?? {}).find(value => value?.kind === 'longball-canonical-connected-v1' && value.matchId === matchId && value.baseUrl === tunnel); }
async function accepted() {
  const response = await fetch(`${api}/v1/matches/${matchId}/download?deviceId=independent-policy-observer`, { headers: { Authorization: 'Bearer synthetic-manager-2', 'X-Longball-Role': 'manager' } });
  assert(response.ok); return response.json();
}
const button = (page, name) => page.getByRole('button', { name, exact: true }).click();
async function open(prepared = false) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const page = await context.newPage(); pages.push(page); page.setDefaultTimeout(25_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://raw.githubusercontent.com/CharlieOmniPoint/LongBall/preview/longball-m0/preview-status.json', route => route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: { state: 'ready', url: tunnel, startedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), sourceRevision: 'a'.repeat(40) } }));
  await page.route(`${tunnel}/**`, async route => { const response = await route.fetch({ url: api + route.request().url().slice(tunnel.length) }); await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': new URL(baseURL).origin } }); });
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await enterFictionalReview(page, 'manager', 'connected');
  await page.getByTestId('workspace-context-ready').waitFor();
  if (prepared) {
    await openWorkspaceTab(page, 'controller');
    await page.getByLabel('Connected match identifier', { exact: true }).fill(matchId);
  } else {
    await openWorkspaceTab(page, 'schedule');
    await page.getByRole('button', { name: 'Open fixture Maple FC, 2026-10-24', exact: true }).click();
    await page.getByTestId('preparation-open-match').click();
  }
  await page.getByTestId('recording-acquire').or(page.getByTestId('recording-upload')).first().waitFor();
  await until(() => connected(page), value => Boolean(value?.localState), 'Connected document has its authoritative fixture');
  return page;
}
async function configure(page, minutes, buffer, reason) {
  const review = page.getByRole('button', { name: 'Review settings', exact: true });
  if (await review.count()) await review.click();
  await page.getByLabel('Preferred continuous spell minutes', { exact: true }).fill(String(minutes));
  await page.getByLabel('Preferred half buffer percent', { exact: true }).fill(String(buffer));
  await page.getByLabel('Score lead threshold', { exact: true }).fill('2');
  const no = page.getByRole('button', { name: 'No', exact: true }); if (await no.count()) await no.click();
  await page.getByLabel('Match policy change reason', { exact: true }).fill(reason);
  await page.getByTestId('planner-settings-confirm').click();
  await page.getByTestId('planner-settings-saved').waitFor();
  return until(() => connected(page), value => value?.localState?.activePolicy?.reason === reason, 'Policy command durably saved');
}
async function upload(page) {
  await page.getByTestId('recording-upload').click();
  return until(() => connected(page), value => value && !value.pendingRequest && !value.authoritativeDownloadRequired && value.outbox.every(entry => entry.disposition !== 'pending'), 'Accepted receipt and actor-bound snapshot saved');
}
try {
  await until(async () => { if (startupError || server.exitCode !== null) throw startupError ?? new Error(`API stopped ${server.exitCode}`); try { return await (await fetch(`${api}/health`)).json(); } catch { return null; } }, health => health?.syntheticOnly === true, 'Isolated fictional API health');
  assert.equal((await accepted()).acceptedRevision, 0);
  const a = await open();
  await a.getByTestId('recording-acquire').click();
  await until(() => connected(a), value => value?.controllerConfirmed && !value.authoritativeDownloadRequired && !value.pendingRequest, 'Phone A claims controller');
  const firstReason = 'Phone A explicitly confirmed three-minute spells and ten-percent soft buffers.';
  const localA = await configure(a, 3, 10, firstReason);
  assert.equal((await accepted()).acceptedRevision, 0);
  assert.equal(localA.localState.policyHistory.length, 1);
  assert.equal(localA.outbox[0].envelope.engineVersion, 'synthetic-live-4');
  assert.equal(localA.outbox[0].envelope.command.type, 'policy.changed');
  await upload(a);
  const afterA = await accepted();
  assert.equal(afterA.state.activePolicy.payload.minimumStintMs, 180000);
  assert.equal(afterA.state.activePolicy.softPreferences.halfBufferFraction, 0.1);
  assert.equal(afterA.state.activePolicy.actorId, accountId);
  assert.equal(afterA.state.activePolicy.reason, firstReason);
  checks.push('Connected UI confirms a reason and explicit soft values through its durable canonical outbox; independent HTTP verifies service acceptance and bound actor.');
  const b = await open(true);
  const target = await connected(b);
  assert.notEqual(target.deviceId, localA.deviceId);
  await a.getByTestId('controller-recording-details').click();
  await a.getByLabel('Handover target account', { exact: true }).fill(accountId);
  await a.getByLabel('Handover target device', { exact: true }).fill(target.deviceId);
  await button(a, 'Offer control to the named manager/device');
  const offer = await until(() => connected(a), value => value?.lastTransferId && !value.pendingRequest, 'Explicit addressed handover offer');
  await b.getByTestId('controller-recording-details').click();
  await b.getByLabel('Transfer id to accept', { exact: true }).fill(offer.lastTransferId);
  await button(b, 'Accept addressed transfer on this device');
  const heldB = await until(() => connected(b), value => value?.controllerConfirmed && value.grant?.epoch === 2 && !value.pendingRequest && !value.authoritativeDownloadRequired, 'Phone B accepts and downloads');
  assert.deepEqual(heldB.localState.policyHistory, afterA.state.policyHistory);
  assert.match(await b.getByTestId('planner-settings-saved').innerText(), /Preferred spell 3 min · half buffer 10%/);
  checks.push('A distinct browser phone explicitly accepts addressed controller handover and opens the same accepted policy history and settings.');
  await configure(b, 7, 20, 'Phone B reviewed longer soft spells after the explicit controller handover.');
  await upload(b);
  const final = await accepted();
  assert.equal(final.state.policyHistory.length, 2);
  assert.deepEqual(final.state.policyHistory[0], afterA.state.policyHistory[0]);
  assert.equal(final.state.activePolicy.payload.minimumStintMs, 420000);
  assert.equal(final.state.activePolicy.softPreferences.halfBufferFraction, 0.2);
  assert.equal(final.state.matchActiveMs, 0);
  assert.deepEqual(final.state.intervals, []); assert.deepEqual(final.state.targetIntervals, []);
  assert.deepEqual(errors, []);
  assert.equal(await b.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await b.screenshot({ path: path.join(directory, 'accepted-policy-after-handover.png'), fullPage: true, animations: 'disabled' });
  await assertReviewArtifactsUnchanged(artifacts, baseURL, apiEntry);
  const report = { status: 'passed', checkedAt: new Date().toISOString(), baseURL, api, checks, acceptedRevision: final.acceptedRevision, policyHistory: final.state.policyHistory, browserErrors: errors, artifacts, limitations: ['Fictional development accounts and transport-only discovery redirect to loopback.', 'Browser evidence does not establish native encrypted storage, physical clocks, background reminders or real identity-provider sign-in.', 'Q07 keeper transitions remain unapproved and refused.'] };
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, checks, artifacts: report.artifacts, acceptedRevision: report.acceptedRevision }, null, 2));
} catch (error) {
  await pages.at(-1)?.screenshot({ path: path.join(directory, 'failed.png'), fullPage: true }).catch(() => {});
  await writeFile(path.join(directory, 'failure.json'), JSON.stringify({ artifacts, checks, error: String(error), errors }, null, 2) + '\n');
  throw error;
} finally { await browser.close(); server.kill('SIGTERM'); log.end(); }
