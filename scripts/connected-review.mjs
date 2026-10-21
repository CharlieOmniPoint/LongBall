import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { existsSync, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { installStartupDiagnostics, captureStartupDiagnostics } from './browser-startup-diagnostics.mjs';

/** Real UI/HTTP journeys. IndexedDB and service GETs are inspected read-only.
 * Each API uses a fresh isolated fictional database; no app state is injected.
 * A lost HTTP response is simulated only after route.fetch confirms server commit.
 */
const baseURL = process.env.LONGBALL_REVIEW_BASE_URL ?? 'http://127.0.0.1:4173';
const primaryAPI = process.env.LONGBALL_REVIEW_API_URL ?? 'http://127.0.0.1:4320';
const controlAPI = process.env.LONGBALL_REVIEW_CONTROL_API_URL ?? 'http://127.0.0.1:4321';
const matchId = 'synthetic-roma-maple-2026-10-24';
const teamId = 'synthetic-roma-u10', seasonId = 'synthetic-season-2026-27';
const directory = path.resolve('.local/connected-review');
const runId = new Date().toISOString().replaceAll(/[^0-9]/g, '');
const checks = [], errors = [], servers = [];
let artifacts = null;
let activePage, workspaceOpenSequence = 0;
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.LONGBALL_CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const button = async (page, name) => {
  try { await page.getByRole('button', { name, exact: true }).click(); }
  catch (error) { await page.screenshot({ path: path.join(directory, 'last-action-failed.png'), animations: 'disabled' }).catch(() => {}); throw error; }
};
const input = (page, name, value) => page.getByLabel(name, { exact: true }).fill(value);
async function poll(read, predicate, label) {
  const deadline = Date.now() + 20_000;
  let value;
  do { value = await read(); if (predicate(value)) return value; await sleep(50); } while (Date.now() < deadline);
  assert.fail(`${label}; latest revision ${value?.revision ?? value?.acceptedRevision ?? 'unavailable'}`);
}
async function json(api, route, token = 'synthetic-manager-1') {
  const response = await fetch(`${api}${route}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.ok, true, `${route}: HTTP ${response.status}`);
  return response.json();
}
const download = (api, alias) => json(api, `/v1/matches/${matchId}/download?deviceId=${encodeURIComponent(alias)}`);
const scoped = section => `/v1/teams/${teamId}/${section}?seasonId=${seasonId}`;
async function startAPI(api, name) {
  if (process.env.LONGBALL_REVIEW_EXTERNAL_API === '1') {
    const health = await (await fetch(`${api}/health`)).json();
    assert.equal(health.syntheticOnly, true, 'The explicit external review API must advertise fictional authentication.');
    assert.equal((await download(api, 'fresh-stream-probe')).acceptedRevision, 0, 'The explicit external review API must have an isolated fresh match.');
    return;
  }
  const url = new URL(api);
  assert(['127.0.0.1', 'localhost'].includes(url.hostname), 'The fictional rehearsal may only start local APIs.');
  const database = path.join(directory, `${runId}-${name}.sqlite`);
  const stream = createWriteStream(path.join(directory, `${name}-api.log`));
  const child = spawn(process.execPath, [process.env.LONGBALL_REVIEW_API_ENTRY ?? 'apps/api/dist/api.mjs'], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'development', LONGBALL_SYNTHETIC_AUTH: '1', LONGBALL_DATABASE_URL: '', LONGBALL_DATABASE_URL_FILE: '', LONGBALL_DATABASE_MIGRATION_MODE: 'apply', LONGBALL_CLAMD_SOCKET: '', LONGBALL_CLAMD_HOST: '', LONGBALL_CLAMD_PORT: '', LONGBALL_FICTIONAL_CLOCK_POLICY: api === controlAPI ? JSON.stringify({ id: 'fictional-connected-review-clock-v1', serverClockUncertaintyMs: 1000, maximumRoundTripMs: 5000, maximumMappingAgeMs: 3600000, maximumUncertaintyMs: 3000, maximumDriftPpm: 100 }) : '', LONGBALL_API_HOST: '127.0.0.1', LONGBALL_API_PORT: url.port, LONGBALL_API_DATABASE: database, LONGBALL_MEDIA_DIRECTORY: path.join(directory, `${runId}-${name}-media`), LONGBALL_API_ORIGINS: `${new URL(baseURL).origin},http://localhost:4173,http://127.0.0.1:4173`, LONGBALL_CLAMSCAN_PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let startupText = '', childFailure = null;
  child.stdout.on('data', data => { startupText = `${startupText}${data.toString()}`.slice(-2000); });
  child.on('error', error => { childFailure = error; });
  child.stdout.pipe(stream); child.stderr.pipe(stream);
  servers.push({ child, stream });
  await poll(async () => {
    if (childFailure) throw childFailure;
    if (child.exitCode !== null) throw new Error(`Isolated API ${name} exited ${child.exitCode}; see ${name}-api.log.`);
    if (!startupText.includes(`LongBall API http://127.0.0.1:${url.port}`)) return false;
    try { const response = await fetch(`${api}/health`); if (!response.ok) return false; const health = await response.json(); assert.equal(health.syntheticOnly, true, 'Only an explicitly fictional API may run this mutation rehearsal.'); return true; } catch (error) { if (error.code === 'ERR_ASSERTION') throw error; return false; }
  }, Boolean, `Start isolated ${name} API`);
  const initial = await download(api, 'fresh-stream-probe');
  assert.equal(initial.acceptedRevision, 0, 'Use an isolated API database, never reset or overwrite an existing match.');
}
async function stored(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('longball-synthetic-m0');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('journal')) { db.close(); resolve(null); return; }
      const transaction = db.transaction('journal', 'readonly');
      const read = transaction.objectStore('journal').get('record');
      transaction.oncomplete = () => { db.close(); resolve(read.result ?? null); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  }));
}
async function connected(page, alias, api) {
  return Object.values((await stored(page))?.projections ?? {}).find(value => value?.kind === 'longball-canonical-connected-v1' && value.deviceId === alias && value.baseUrl === api) ?? null;
}
async function workspaceOutbox(page, api, accountId = 'synthetic-account-manager') {
  return Object.entries((await stored(page))?.projections ?? {}).find(([key, value]) => key.startsWith('workspace-outbox.v1:') && value?.scope?.apiBaseUrl === api && value.scope.accountId === accountId && value.scope.teamId === teamId && value.scope.seasonId === seasonId)?.[1] ?? null;
}
const waitConnected = (page, alias, api, predicate, label) => poll(() => connected(page, alias, api), value => value && predicate(value), label);
async function enterWorkspace(page, api, account) {
  await page.getByTestId('prepare-match').waitFor();
  await button(page, 'More'); await button(page, 'Service and controller');
  await input(page, 'Workspace API URL', api);
  await button(page, 'Fictional API review'); await button(page, account);
  await page.getByTestId('workspace-connect').click();
  await page.getByTestId('workspace-session').waitFor();
  await page.getByTestId(account === 'Fictional manager' ? 'workspace-tab-controller' : 'workspace-tab-community').waitFor();
}
async function openWorkspace(api, account = 'Fictional manager') {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const page = await context.newPage(); activePage = page;
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => errors.push(error.message));
  const observations = await installStartupDiagnostics(page);
  const opening = ++workspaceOpenSequence;
  try {
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    await enterWorkspace(page, api, account);
  } catch (error) {
    const label = `${runId}-workspace-open-${opening}`;
    await page.screenshot({ path: path.join(directory, `${label}.png`) }).catch(() => {});
    await captureStartupDiagnostics(page, label, directory, observations);
    await page.waitForTimeout(5000);
    await captureStartupDiagnostics(page, `${label}-later`, directory, observations);
    error.startupDiagnostics = label;
    await context.close();
    throw error;
  }
  return { context, page };
}
async function openController(page, api, alias, manager = 'Manager A') {
  await page.getByTestId('workspace-tab-controller').click();
  await input(page, 'Connected match identifier', matchId);
  await input(page, 'LongBall service URL', api);
  await button(page, manager);
  await input(page, 'Rehearsal device identifier', alias);
  await button(page, 'Open this service connection');
  await waitConnected(page, alias, api, () => true, 'Create authorized controller document after /me');
  await button(page, 'Download accepted service match');
  return waitConnected(page, alias, api, doc => Boolean(doc.localState), 'Download canonical match');
}
async function acquire(page, alias, api) {
  await button(page, 'Acquire controller for this device');
  return waitConnected(page, alias, api, doc => doc.controllerConfirmed && !doc.pendingRequest && !doc.authoritativeDownloadRequired, 'Controller capability and authoritative checkpoint confirmed');
}
async function recordPresent(page, alias, api) {
  const before = (await connected(page, alias, api)).allocatedSequence;
  await button(page, 'Record fictional squad present');
  return waitConnected(page, alias, api, doc => doc.allocatedSequence === before + doc.localState.config.selectedPlayerIds.length, 'Explicit attendance events durably queued');
}
async function confirm(page, label, alias, api, status) {
  await button(page, label); await button(page, 'Confirm the actual event now');
  return waitConnected(page, alias, api, doc => doc.localState.status === status, label);
}
async function upload(page, alias, api) {
  await button(page, 'Upload pending canonical events');
  return waitConnected(page, alias, api, doc => !doc.pendingRequest && !doc.authoritativeDownloadRequired && doc.outbox.every(entry => entry.disposition !== 'pending') && doc.acceptedState?.revision === doc.acceptedRevision, 'Upload receipt plus authoritative audit download');
}
async function picture(page, name) {
  await page.screenshot({ path: path.join(directory, `${name}.png`), animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: no phone horizontal overflow`);
}
async function offer(page, alias, api, account, device) {
  await input(page, 'Handover target account', account); await input(page, 'Handover target device', device);
  const old = (await connected(page, alias, api)).lastTransferId;
  await button(page, 'Offer control to the named manager/device');
  return (await waitConnected(page, alias, api, doc => Boolean(doc.lastTransferId && doc.lastTransferId !== old && !doc.pendingRequest), 'Addressed controller handover offer')).lastTransferId;
}
async function accept(page, alias, api, transferId, epoch) {
  await input(page, 'Transfer id to accept', transferId); await button(page, 'Accept addressed transfer on this device');
  return waitConnected(page, alias, api, doc => doc.controllerConfirmed && doc.grant.epoch === epoch && !doc.pendingRequest && !doc.authoritativeDownloadRequired, 'Accept addressed controller transfer with current checkpoint');
}
async function scenario(name, work) {
  try { const detail = await work(); checks.push({ name, status: 'passed', detail }); }
  catch (error) { await activePage?.screenshot({ path: path.join(directory, `${name}-failed.png`), animations: 'disabled' }).catch(() => {}); checks.push({ name, status: 'failed', error: error.message, ...(error.startupDiagnostics ? { startupDiagnostics: error.startupDiagnostics } : {}) }); }
  console.log(`${checks.at(-1).status.toUpperCase()} ${name}${checks.at(-1).error ? `: ${checks.at(-1).error}` : ''}`);
}

try {
  const webHtml = await (await fetch(baseURL)).text();
  const scriptPath = /src="([^"]*\/index-[^"]+\.js)"/.exec(webHtml)?.[1];
  assert(scriptPath, 'Review HTML must expose its actual bundled entry.');
  const scriptUrl = new URL(scriptPath, baseURL).href;
  artifacts = { web: { url: scriptUrl, sha256: createHash('sha256').update(Buffer.from(await (await fetch(scriptUrl)).arrayBuffer())).digest('hex') }, api: { entry: process.env.LONGBALL_REVIEW_API_ENTRY ?? 'apps/api/dist/api.mjs', sha256: createHash('sha256').update(await readFile(process.env.LONGBALL_REVIEW_API_ENTRY ?? 'apps/api/dist/api.mjs')).digest('hex') } };
  await startAPI(primaryAPI, 'journey'); await startAPI(controlAPI, 'controller');
  await scenario('01-canonical-match-and-lost-response', async () => {
    const alias = 'connected-browser-journey-a';
    const { context, page } = await openWorkspace(primaryAPI);
    let releaseLostResponse = () => {};
    try {
      const legacy = structuredClone((await stored(page)).projections[matchId]);
      await openController(page, primaryAPI, alias); await acquire(page, alias, primaryAPI);
      await recordPresent(page, alias, primaryAPI);
      await button(page, 'Stage first seven present players');
      await waitConnected(page, alias, primaryAPI, doc => doc.localState.stagedLineup?.length === 7, 'Explicit staged lineup');
      const date = new Date('2026-10-24T09:00:00.000Z');
      await page.clock.install({ time: new Date(date.getTime() - 3_600_000) }); await page.clock.pauseAt(date);
      await confirm(page, 'Review kickoff', alias, primaryAPI, 'first_half_running');
      await page.clock.fastForward(20_000); await button(page, 'Record fictional team goal');
      await waitConnected(page, alias, primaryAPI, doc => doc.localState.goals.length === 1, 'Live goal queued');
      await page.clock.fastForward(5_000);
      await confirm(page, 'Review actual referee clock pause', alias, primaryAPI, 'first_half_paused');
      const candidate = await connected(page, alias, primaryAPI);
      assert.equal(candidate.localState.halfActiveMs, 25_000);
      const observations = []; let loseResponse = true, prefixCommitted = false;
      const heldResponse = new Promise(resolve => { releaseLostResponse = resolve; });
      await page.route(`${primaryAPI}/v1/matches/${matchId}/events`, async route => {
        if (route.request().method() !== 'POST') { await route.continue(); return; }
        observations.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() });
        if (!loseResponse) { await route.continue(); return; }
        loseResponse = false;
        const committed = await route.fetch();
        assert.equal(committed.ok(), true, 'Service committed before its response was lost.');
        prefixCommitted = true;
        await heldResponse;
        await route.abort('failed');
      });
      await button(page, 'Upload pending canonical events');
      await page.getByRole('button', { name: 'Retry same upload request', exact: true }).waitFor();
      await poll(async () => prefixCommitted, Boolean, 'Service committed while its original response remains in flight');
      const uncertain = await connected(page, alias, primaryAPI);
      assert(uncertain.pendingRequest); assert(uncertain.outbox.every(entry => entry.disposition === 'pending'));
      const committed = await download(primaryAPI, alias);
      assert.equal(committed.acceptedRevision, candidate.localState.revision);
      assert.equal(committed.state.goals.length, 1);
      const originalRequest = JSON.stringify(uncertain.pendingRequest);
      // The phone keeps recording actual events while the original upload awaits its receipt.
      await confirm(page, 'Review actual clock resume', alias, primaryAPI, 'first_half_running');
      await page.clock.fastForward(4_000); await button(page, 'Record fictional team goal');
      await waitConnected(page, alias, primaryAPI, value => value.localState.goals.length === 2, 'Offline goal suffix saved behind the original upload');
      await page.clock.fastForward(1_000);
      let doc = await confirm(page, 'Review actual referee clock pause', alias, primaryAPI, 'first_half_paused');
      assert.equal(doc.localState.halfActiveMs, 30_000);
      assert.equal(JSON.stringify(doc.pendingRequest), originalRequest, 'New actual events cannot modify the retained upload.');
      const suffix = JSON.stringify(doc.outbox.slice(candidate.outbox.length).map(entry => entry.envelope));
      releaseLostResponse();
      await poll(async () => page.getByRole('button', { name: 'Retry same upload request', exact: true }).isEnabled(), Boolean, 'Lost response settled without discarding request');
      await button(page, 'Retry same upload request');
      doc = await waitConnected(page, alias, primaryAPI, value => !value.pendingRequest && !value.authoritativeDownloadRequired && value.acceptedState?.revision === committed.acceptedRevision, 'Retry acknowledged and authoritative prefix plus offline suffix replayed');
      assert.equal(observations.length, 2); assert.deepEqual(observations[1], observations[0]);
      assert.equal(JSON.stringify({ idempotencyKey: observations[0].key, body: JSON.parse(observations[0].body) }), JSON.stringify({ idempotencyKey: uncertain.pendingRequest.idempotencyKey, body: uncertain.pendingRequest.body }));
      assert.equal(originalRequest, JSON.stringify(uncertain.pendingRequest));
      assert.deepEqual(doc.acceptedState.audit, (await download(primaryAPI, alias)).state.audit, 'Local accepted audit equals authenticated service projection.');
      assert(doc.acceptedState.audit.every(entry => entry.actorId === 'synthetic-account-manager'));
      assert.equal(doc.localState.goals.length, 2); assert.equal(doc.acceptedState.goals.length, 1);
      assert.equal(doc.outbox.filter(entry => entry.disposition === 'pending').length, 3);
      assert.equal(JSON.stringify(doc.outbox.filter(entry => entry.disposition === 'pending').map(entry => entry.envelope)), suffix);
      assert.equal(doc.reconciliationRequired, false);
      await page.unroute(`${primaryAPI}/v1/matches/${matchId}/events`);
      doc = await upload(page, alias, primaryAPI);
      assert.equal(doc.acceptedState.goals.length, 2);
      await page.clock.fastForward(300_000);
      await confirm(page, 'Review actual clock resume', alias, primaryAPI, 'first_half_running');
      await page.clock.fastForward(1_473_000);
      doc = await confirm(page, 'Review manual half-time', alias, primaryAPI, 'half_time');
      assert.equal(doc.localState.firstHalfDurationMs, 1_503_000, 'First-half overtime is retained.');
      doc = await confirm(page, 'Review second-half start', alias, primaryAPI, 'second_half_running');
      assert.equal(doc.localState.halfActiveMs, 0, 'Second half begins with its independent25 minutes.');
      await page.clock.fastForward(30_000); await button(page, 'Record fictional team goal');
      await waitConnected(page, alias, primaryAPI, value => value.localState.goals.length === 3, 'Second-half goal');
      await page.clock.fastForward(1_470_000);
      doc = await confirm(page, 'Review manual full-time', alias, primaryAPI, 'completed');
      assert.equal(doc.localState.matchActiveMs, 3_003_000);
      doc = await upload(page, alias, primaryAPI);
      const final = await download(primaryAPI, alias);
      assert.equal(final.state.status, 'completed'); assert.deepEqual(final.state.score, { for: 3, against: 0 });
      assert.deepEqual(doc.acceptedState.audit, final.state.audit);
      assert.equal(final.deviceCheckpoint.clientSequence, doc.allocatedSequence);
      assert.equal(final.state.intervals.filter(interval => interval.state === 'playing').reduce((total, interval) => total + interval.endMs - interval.startMs, 0), 7 * 3_003_000);
      assert.deepEqual((await stored(page)).projections[matchId], legacy, 'Legacy M0 history was never uploaded or rewritten.');
      await picture(page, '01-canonical-completed');
      const finish = final.state.completedAtMs, originalHistory = structuredClone(final.state.eventHistory);
      await page.getByTestId('history-missing-lineup').click();
      await button(page, 'Half 1');
      await page.getByTestId('history-effective-time').fill('05:00.000');
      const outgoing = doc.localState.lineup.at(-1), incoming = doc.localState.config.selectedPlayerIds.find(id => !doc.localState.lineup.some(item => item.playerId === id));
      assert(outgoing && incoming);
      await page.getByTestId(`history-slot-${outgoing.slotId}`).click(); await page.getByTestId(`history-player-${incoming}`).click();
      await page.getByTestId('history-evidence-reason').fill('Fictional referee and touchline records confirm the missed first-half substitution.');
      await page.getByTestId('history-preview').click(); await page.getByText('VALIDATED PREVIEW · NOTHING APPLIED', { exact: true }).waitFor();
      assert.equal((await connected(page, alias, primaryAPI)).localState.revision, final.state.revision, 'Preview cannot change accepted/local history.');
      await page.getByTestId('history-confirm').click();
      doc = await waitConnected(page, alias, primaryAPI, value => value.localState.revision === final.state.revision + 1, 'Explicit reviewed missing participation fact queued');
      const insertion = doc.outbox.at(-1).envelope;
      assert.equal(insertion.effectiveHalf, 1); assert.equal(insertion.halfElapsedMs, 300_000); assert.equal(insertion.command.sourceRevision, final.state.revision);
      doc = await upload(page, alias, primaryAPI);
      await page.getByTestId(`history-fact-${insertion.eventId}`).click(); await page.getByTestId('history-effective-time').fill('07:00.000');
      await page.getByTestId('history-evidence-reason').fill('Fictional reviewed source corrects the actual substitution time to seven minutes.');
      await page.getByTestId('history-preview').click(); await page.getByText('VALIDATED PREVIEW · NOTHING APPLIED', { exact: true }).waitFor();
      await page.getByTestId('history-confirm').click();
      await waitConnected(page, alias, primaryAPI, value => value.localState.revision === final.state.revision + 2, 'Compensating correction saved');
      doc = await upload(page, alias, primaryAPI);
      const corrected = await download(primaryAPI, alias);
      assert.equal(corrected.state.status, 'completed'); assert.equal(corrected.state.completedAtMs, finish); assert.equal(corrected.state.matchActiveMs, final.state.matchActiveMs);
      assert.deepEqual(corrected.state.eventHistory.slice(0, originalHistory.length), originalHistory, 'Original accepted history is immutable.');
      const incomingMs = corrected.state.intervals.filter(item => item.playerId === incoming && item.state === 'playing').reduce((sum, item) => sum + item.endMs - item.startMs, 0);
      assert.equal(incomingMs, 1_503_000 - 420_000, 'Retrospective time changes rebuild first-half play and preserve actual second-half kickoff allocations.');
      assert(corrected.state.audit.at(-1).priorValue); assert.equal(corrected.state.audit.at(-1).actorId, 'synthetic-account-manager');
      for (const playerId of corrected.state.config.selectedPlayerIds) assert.equal(corrected.state.intervals.filter(item => item.playerId === playerId).reduce((sum, item) => sum + item.endMs - item.startMs, 0), corrected.state.matchActiveMs);
      assert.equal(corrected.state.intervals.filter(item => item.state === 'playing').reduce((sum, item) => sum + item.endMs - item.startMs, 0), 7 * corrected.state.matchActiveMs);
      await page.getByTestId('history-accepted-timeline').click();
      await page.getByRole('button', { name: /event\.corrected · revision/ }).last().click();
      await picture(page, '01-retrospective-participation-correction');
      const retainedOutbox = JSON.stringify(doc.outbox);
      // A transport-only403 fixture tests cache closure; it does not claim a real membership was revoked.
      await page.route(`${primaryAPI}/v1/me`, async route => {
        if (route.request().method() === 'OPTIONS') { await route.continue(); return; }
        await route.fulfill({ status: 403, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': new URL(baseURL).origin }, body: JSON.stringify({ code: 'NOT_FOUND', message: 'Authoritative denial fixture: manager scope no longer available.' }) });
      });
      await button(page, 'Download accepted service match');
      await page.getByText(/Controller cache closed because the service or current account denied access/).waitFor();
      assert.equal(await page.getByText('Connected match rehearsal', { exact: true }).count(), 0, 'Known access denial hides the private match view.');
      assert.equal(JSON.stringify((await connected(page, alias, primaryAPI)).outbox), retainedOutbox, 'Access denial retains the canonical audit/outbox.');
      await picture(page, '01-authority-denial-hides-private-cache');
      return { acceptedRevision: final.acceptedRevision, clientSequence: final.deviceCheckpoint.clientSequence, firstHalfMs: 1_503_000, secondHalfMs: 1_500_000, pauseExcludedMs: 300_000, score: final.state.score, identicalRetry: true, offlineSuffixEvents: 3, offlineSuffixReplayedOverAuthoritativePrefix: true, authoritativeActorAudit: true, legacyM0Unchanged: true, trustedUtc: false, cacheClosureAfterHttp403Fixture: true, realMembershipRevocationTested: false, lateSubstitutionThenAuditedCorrectionOverHttp: true, originalHistoryRetained: true, correctedOccupiedPlayerMs: 7 * corrected.state.matchActiveMs };
    } finally { releaseLostResponse(); await context.close(); }
  });

  await scenario('02-handover-sequence-and-stale-quarantine', async () => {
    const aliasA = 'connected-browser-control-a', aliasB = 'connected-browser-control-b';
    const first = await openWorkspace(controlAPI), second = await openWorkspace(controlAPI);
    const a = first.page, b = second.page;
    try {
      await openController(a, controlAPI, aliasA); await acquire(a, aliasA, controlAPI);
      await button(a, 'Acknowledge fictional session-clock experiment'); await a.getByTestId('clock-exchange').click();
      await a.getByText(/Exchange received under fictional-connected-review-clock-v1/).waitFor();
      assert.equal((await json(controlAPI, `/v1/matches/${matchId}/clock/policy`)).status, 'configured_trial');
      const retainedMapping = (await connected(a, aliasA, controlAPI)).clockMapping; assert(retainedMapping?.challengeId);
      assert.equal((await connected(a, aliasA, controlAPI)).clockMappingHistory.length, 1);
      await recordPresent(a, aliasA, controlAPI); const before = await upload(a, aliasA, controlAPI);
      assert(before.outbox.every(entry => entry.envelope.clockEvidence.anchorId === retainedMapping.challengeId));
      const sequence = before.allocatedSequence;
      const transfer = await offer(a, aliasA, controlAPI, 'synthetic-account-manager-2', aliasB);
      await openController(b, controlAPI, aliasB, 'Manager B'); await accept(b, aliasB, controlAPI, transfer, 2);
      await recordPresent(b, aliasB, controlAPI); await upload(b, aliasB, controlAPI);
      const back = await offer(b, aliasB, controlAPI, 'synthetic-account-manager', aliasA);
      await accept(a, aliasA, controlAPI, back, 3);
      assert.equal((await connected(a, aliasA, controlAPI)).clockMapping, null, 'A new controller epoch cannot reuse the old active clock proof.');
      assert.equal((await connected(a, aliasA, controlAPI)).clockMappingHistory[0].challengeId, retainedMapping.challengeId, 'Old clock receipts remain retained.');
      const oldEvents = (await connected(a, aliasA, controlAPI)).outbox.length;
      await recordPresent(a, aliasA, controlAPI);
      let doc = await connected(a, aliasA, controlAPI);
      assert.equal(doc.outbox[oldEvents].envelope.clientSequence, sequence + 1);
      assert.equal(doc.outbox[oldEvents].envelope.previousEventId, before.previousEventId);
      await upload(a, aliasA, controlAPI);
      const accepted = await download(controlAPI, aliasA);
      await input(b, 'Controller recovery reason', 'Fictional lost-phone recovery rehearsal; retain old-device evidence.');
      await button(b, 'Acknowledge possible unsynchronised old records');
      await button(b, 'Recover control; retain old branch for reconciliation');
      await waitConnected(b, aliasB, controlAPI, value => value.grant?.epoch === 4 && value.reconciliationRequired && !value.pendingRequest, 'Explicit recovery requires reconciliation');
      await recordPresent(a, aliasA, controlAPI);
      const oldCandidate = structuredClone((await connected(a, aliasA, controlAPI)).localState);
      doc = await upload(a, aliasA, controlAPI);
      const quarantined = doc.outbox.filter(entry => entry.disposition === 'quarantined');
      assert.equal(quarantined.length, oldCandidate.config.selectedPlayerIds.length);
      assert(quarantined.every(entry => entry.reason === 'STALE_CONTROLLER'));
      assert.equal(doc.controllerConfirmed, false); assert.equal(doc.reconciliationRequired, true);
      assert.deepEqual(doc.localState, oldCandidate, 'Stale candidate remains separate and recoverable.');
      const after = await download(controlAPI, aliasA);
      assert.deepEqual(after.state, accepted.state, 'Stale records cannot alter the accepted service projection.');
      assert.equal(after.deviceCheckpoint.clientSequence, doc.allocatedSequence, 'Quarantined reserved sequence is not reset.');
      await button(a, 'Read service quarantine');
      const quarantine = await json(controlAPI, `/v1/matches/${matchId}/quarantine`);
      assert.equal(quarantine.items.length, quarantined.length);
      await a.getByTestId('reconciliation-download').click();
      const evidence = await json(controlAPI, `/v1/matches/${matchId}/reconciliation`);
      assert.equal(evidence.policy.status, 'unapproved'); assert.equal(evidence.submissions.length, quarantine.items.length);
      await a.getByTestId(`reconciliation-source-${evidence.submissions[0].submissionId}`).click();
      await a.getByTestId('reconciliation-reason').fill('Fictional old-device evidence remains disputed; preserve it without merging or granting reviewer authority.');
      await a.getByTestId('reconciliation-preview').click(); await a.getByText('VALIDATED PREVIEW · NOTHING APPLIED', { exact: true }).waitFor();
      const requests = []; let dropProposalResponse = true;
      await a.route(`${controlAPI}/v1/matches/${matchId}/reconciliation/proposals`, async route => {
        if (route.request().method() !== 'POST') { await route.continue(); return; }
        requests.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() });
        if (!dropProposalResponse) { await route.continue(); return; }
        dropProposalResponse = false; const committed = await route.fetch(); assert.equal(committed.ok(), true); await route.abort('failed');
      });
      await a.getByTestId('reconciliation-save').click();
      await a.getByTestId('reconciliation-retry').waitFor();
      await poll(async () => a.getByTestId('reconciliation-retry').isEnabled(), Boolean, 'Proposal response loss retains exact request');
      const prepared = await json(controlAPI, `/v1/matches/${matchId}/reconciliation`);
      assert.equal(prepared.proposals.length, 1); assert.equal(prepared.proposals[0].status, 'prepared');
      await a.reload({ waitUntil: 'networkidle' }); await enterWorkspace(a, controlAPI, 'Fictional manager'); await openController(a, controlAPI, aliasA);
      await a.getByTestId('reconciliation-retry').click();
      await poll(async () => a.getByTestId('reconciliation-retry').count(), value => value === 0, 'Proposal receipt saved after exact retained retry');
      assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]);
      const reviewed = await json(controlAPI, `/v1/matches/${matchId}/reconciliation`);
      assert.equal(reviewed.proposals.length, 1); assert.equal(reviewed.submissions.length, evidence.submissions.length);
      assert.deepEqual((await download(controlAPI, aliasA)).state, accepted.state, 'A prepared proposal cannot change accepted play or clear quarantine.');
      const refusedApply = await fetch(`${controlAPI}/v1/matches/${matchId}/reconciliation/apply`, { method: 'POST', headers: { Authorization: 'Bearer synthetic-manager-1', 'Content-Type':'application/json', 'X-Api-Contract-Version':'longball.events/1.1', 'Idempotency-Key': `q08-unapproved-${runId}` }, body: JSON.stringify({ proposalId: reviewed.proposals[0].input.proposalId, expectedRevision: accepted.acceptedRevision, events: [] }) });
      assert.equal(refusedApply.status, 503); assert.match((await refusedApply.json()).code, /Q08|POLICY|AUTHORITY/);
      await picture(a, '02-stale-controller-retained');
      return { acceptedRevision: after.acceptedRevision, epochs: [1, 2, 3, 4], sequenceBeforeHandback: sequence, nextSequenceOnHandback: sequence + 1, finalReservedSequence: doc.allocatedSequence, quarantined: quarantine.items.length, acceptedProjectionUnchanged: true, managerReviewRequired: true, immutableProposalOverHttp: true, exactProposalRetryAfterReload: true, q08Apply503: true, quarantineNotClearedByProposal: true, fictionalClockExchangeOverHttp: true, nativeClockContinuityTested: false };
    } finally { await first.context.close(); await second.context.close(); }
  });

  await scenario('03-workspace-service-preparation-results-and-privacy', async () => {
    const { context, page } = await openWorkspace(primaryAPI);
    try {
      await page.getByTestId('workspace-tab-schedule').click(); await page.getByTestId('preparation-create-event').click();
      await input(page, 'Opposition', 'Connected Birch rehearsal'); await input(page, 'Match date (YYYY-MM-DD)', '2026-11-07');
      await input(page, 'Kick-off (HH:MM, blank if not recorded)', '11:00'); await input(page, 'Venue', 'Fictional connected south field');
      await page.getByTestId('preparation-save').click();
      let prep = await poll(() => json(primaryAPI, scoped('preparation')), value => value.fixtures?.some(item => item.opponent === 'Connected Birch rehearsal'), 'Fixture persisted in service');
      const fixture = prep.fixtures.find(item => item.opponent === 'Connected Birch rehearsal');
      await button(page, 'Open fixture Connected Birch rehearsal, 2026-11-07'); await button(page, 'Edit or reschedule fixture');
      await input(page, 'Match date (YYYY-MM-DD)', '2026-11-14'); await page.getByTestId('preparation-save').click();
      prep = await poll(() => json(primaryAPI, scoped('preparation')), value => value.fixtures?.find(item => item.id === fixture.id)?.playedDate === '2026-11-14', 'Service fixture rescheduled with same identity');
      assert.equal(prep.fixtures.filter(item => item.id === fixture.id).length, 1);
      assert.equal(prep.fixtures.find(item => item.id === fixture.id).history[0].playedDate, '2026-11-07');
      await poll(() => workspaceOutbox(page, primaryAPI), value => value && !value.pending && value.lastSettled?.outcome?.kind === 'accepted', 'Reschedule receipt durably saved before navigation');
      await page.getByTestId('preparation-create-event').waitFor({ state: 'visible' });
      await poll(async () => page.getByTestId('preparation-create-event').isEnabled(), Boolean, 'Refreshed preparation UI finishes its save before changing tabs');
      await page.getByTestId('workspace-tab-reports').click(); await button(page, 'Add historical result to service');
      await page.getByTestId('records-past-date').fill('2026-09-20'); await page.getByTestId('records-past-opponent').fill('Connected Willow historical');
      await page.getByTestId('records-past-for').fill('2'); await page.getByTestId('records-past-against').fill('1'); await page.getByRole('radio', { name: 'friendly', exact: true }).click();
      await page.getByTestId('records-past-review-button').click();
      await page.getByTestId('records-past-save').click();
      const records = await poll(() => json(primaryAPI, scoped('records')), value => value.results?.rows?.some(item => item.opponent === 'Connected Willow historical'), 'Historical result persisted via actual service');
      const historical = records.editableState.results.find(item => item.opponent === 'Connected Willow historical');
      assert.equal(historical.participation, null); assert.equal(historical.actualActiveDurationMs, null);
      await page.getByTestId('workspace-tab-community').click();
      await button(page, 'Acknowledge sharing a limited season invitation'); await button(page, 'Create service invitation code');
      const community = await poll(() => json(primaryAPI, scoped('community')), value => value.invitations?.some(item => !item.revokedAtMs), 'Service invitation created');
      const invitation = community.invitations.find(item => !item.revokedAtMs);
      await picture(page, '03-workspace-manager');
      const own = await openWorkspace(primaryAPI, 'Fictional Player 01');
      try {
        await own.page.getByTestId('workspace-own-preparation').waitFor();
        const ownView = await own.page.getByTestId('workspace-own-preparation').innerText();
        assert.match(ownView, /Player 01/); assert.doesNotMatch(ownView, /Player 02|Player 13/);
        await own.page.getByRole('button', { name: 'Unsure', exact: true }).first().click();
        const ownData = await poll(() => json(primaryAPI, scoped('preparation/own'), 'synthetic-account-player-01'), value => value.fixtures?.[0]?.response === 'unsure', 'Player own-only RSVP persisted');
        assert.equal(ownData.profile.playerId, 'synthetic-player-01');
        assert.equal(ownData.fixtures[0].attendance, 'not_recorded', 'RSVP cannot fabricate attendance.');
        assert.equal(ownData.profiles, undefined); await picture(own.page, '03-workspace-own-player');
      } finally { await own.context.close(); }
      const invitee = await openWorkspace(primaryAPI, 'Fictional invite recipient');
      try {
        await invitee.page.getByTestId('workspace-tab-community').click(); await input(invitee.page, 'Service invitation code', invitation.reviewCode);
        await button(invitee.page, 'Accept service invitation');
        const member = await poll(() => json(primaryAPI, '/v1/me', 'synthetic-account-invitee'), value => value.memberships?.some(item => item.teamId === teamId && item.seasonId === seasonId && item.role === 'spectator'), 'Invitation grants only addressed season spectator access');
        assert(member.memberships.every(item => item.role === 'spectator'));
        const publicMatch = await json(primaryAPI, `/v1/matches/${matchId}`, 'synthetic-account-invitee');
        assert.equal(publicMatch.score, null); assert.equal(publicMatch.state, undefined); assert.equal(publicMatch.intervals, undefined);
        const spectatorReports = await json(primaryAPI, scoped('records'), 'synthetic-account-invitee');
        assert.equal(spectatorReports.results.totals, null, 'Q21 remains withheld; invitation cannot approve score sharing.');
        await picture(invitee.page, '03-workspace-invited-spectator');
      } finally { await invitee.context.close(); }
      return { fixtureId: fixture.id, sameIdentityAfterReschedule: true, historicalSummaryUnknownMinutes: true, ownPlayerDataOnly: true, rsvpDistinctFromAttendance: true, invitationAcceptedOverHttp: true, q21SharingWithheld: true };
    } finally { await context.close(); }
  });

  await scenario('04-private-media-two-explicit-game-albums-without-scanner', async () => {
    const { context, page } = await openWorkspace(primaryAPI);
    try {
      await page.getByTestId('workspace-tab-community').click();
      const before = await json(primaryAPI, scoped('community'));
      const games = before.matches.filter(item => item.sharingAllowed === true).sort((a, b) => (b.playedAtMs ?? -1) - (a.playedAtMs ?? -1) || a.id.localeCompare(b.id)).slice(0, 2);
      assert.equal(games.length, 2, 'Two independently permitted games are needed to prove explicit upload targeting.');
      assert.equal(await page.getByTestId('album-selected-game').count(), 0, 'No first-game upload target is selected automatically.');
      const preparations = [];
      await page.route(url => url.origin === new URL(primaryAPI).origin && url.pathname === `/v1/teams/${teamId}/media/uploads/prepare`, async route => {
        if (route.request().method() === 'POST') preparations.push({ key: route.request().headers()['idempotency-key'], body: JSON.parse(route.request().postData()) });
        await route.continue();
      });
      const uploadIds = [];
      for (const [index, game] of games.entries()) {
        await page.getByTestId(`album-game-${game.id}`).click();
        await page.getByTestId('album-selected-game').getByText(game.label, { exact: true }).waitFor();
        await page.getByTestId('media-generated-image').click();
        await input(page, 'Connected image caption', `Fictional game album ${index + 1}`);
        await page.getByLabel('Connected image policy acknowledgement', { exact: true }).check();
        await page.getByTestId('media-upload-image').click();
        const uploads = await poll(() => json(primaryAPI, scoped('media/uploads')), value => value.items?.filter(item => item.failureCode === 'SCANNER_REQUIRED').length === index + 1, 'Unscanned upload stays private under its selected game');
        const item = uploads.items.find(value => !uploadIds.includes(value.uploadId));
        assert(item); uploadIds.push(item.uploadId);
        await page.getByTestId('media-refresh-uploads').click(); await page.getByText(/SCANNER_REQUIRED/).first().waitFor();
        assert.equal(await page.getByTestId(`album-game-${games[1 - index].id}`).isEnabled(), false, 'A retained upload cannot be silently moved to another game.');
        await page.getByTestId('media-close-retained').click();
        await poll(async () => page.getByRole('button', { name: 'Retry the retained upload request', exact: true }).count(), value => value === 0, 'Explicitly close local capability while retaining the private service record');
      }
      assert.equal(preparations.length, 2); assert.notEqual(preparations[0].key, preparations[1].key);
      assert.deepEqual(preparations.map(item => item.body.matchId), games.map(item => item.id));
      assert.deepEqual(preparations.map(item => item.body.caption), ['Fictional game album 1', 'Fictional game album 2']);
      assert(preparations.every(item => item.body.policyAcknowledged === true));
      const after = await json(primaryAPI, scoped('community'));
      assert.deepEqual(after.gallery.map(photo => [photo.id, photo.matchId, photo.version]), before.gallery.map(photo => [photo.id, photo.matchId, photo.version]), 'Private processing failures do not create published album photos or inflate counts.');
      const ownUploads = await json(primaryAPI, scoped('media/uploads'));
      assert.equal(ownUploads.items.length, 2); assert(ownUploads.items.every(item => item.failureCode === 'SCANNER_REQUIRED'));
      await picture(page, '04-two-explicit-private-game-albums');
      return { selectedGameIds: games.map(item => item.id), preparedGameIds: preparations.map(item => item.body.matchId), explicitChoiceRequired: true, retainedJobCannotRetarget: true, distinctPrivateUploadIds: uploadIds, failureCode: 'SCANNER_REQUIRED', publishedGalleryUnchanged: true, actualAntivirusDatabaseValidated: false };
    } finally { await context.close(); }
  });

  await scenario('05-workspace-durable-outbox-reload-and-exact-retry', async () => {
    const { context, page } = await openWorkspace(primaryAPI);
    try {
      const observations = []; let loseResponse = true;
      const matchesPreparation = url => url.origin === new URL(primaryAPI).origin && url.pathname === `/v1/teams/${teamId}/preparation`;
      await page.route(matchesPreparation, async route => {
        if (route.request().method() !== 'POST') { await route.continue(); return; }
        observations.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() });
        if (!loseResponse) { await route.continue(); return; }
        loseResponse = false;
        const committed = await route.fetch();
        assert.equal(committed.ok(), true, 'Workspace mutation reached the API before acknowledgement was lost.');
        await route.abort('failed');
      });
      await page.getByTestId('workspace-tab-schedule').click(); await page.getByTestId('preparation-create-event').click();
      await input(page, 'Opposition', 'Outbox Alder rehearsal'); await input(page, 'Match date (YYYY-MM-DD)', '2026-11-21');
      await input(page, 'Kick-off (HH:MM, blank if not recorded)', '10:15'); await input(page, 'Venue', 'Fictional durable-outbox field');
      await page.getByTestId('preparation-save').click();
      await page.getByRole('button', { name: 'Retry exact service request', exact: true }).waitFor();
      await poll(async () => page.getByRole('button', { name: 'Retry exact service request', exact: true }).isEnabled(), Boolean, 'Lost workspace acknowledgement settles before reload');
      const pending = await poll(() => workspaceOutbox(page, primaryAPI), value => value?.pending?.status === 'uncertain', 'Original workspace command durably retained');
      assert.equal(observations.length, 1); assert.equal(pending.pending.key, observations[0].key); assert.equal(pending.pending.bodyJson, observations[0].body);
      const retained = structuredClone(pending.pending);
      const committed = await json(primaryAPI, scoped('preparation'));
      assert.equal(committed.fixtures.filter(item => item.opponent === 'Outbox Alder rehearsal').length, 1);
      const fixtureId = committed.fixtures.find(item => item.opponent === 'Outbox Alder rehearsal').id;
      await page.reload({ waitUntil: 'networkidle' });
      await enterWorkspace(page, primaryAPI, 'Fictional Player 01');
      await page.getByTestId('workspace-own-preparation').waitFor();
      assert.equal(await page.getByRole('button', { name: 'Retry exact service request', exact: true }).count(), 0, 'Another account cannot replay the manager retained request.');
      assert.equal((await workspaceOutbox(page, primaryAPI)).pending.bodyJson, retained.bodyJson, 'Account change retains the manager branch without exposing its replay control.');
      await button(page, 'Fictional manager'); await page.getByTestId('workspace-connect').click();
      await page.getByTestId('workspace-tab-controller').waitFor();
      await page.getByRole('button', { name: 'Retry exact service request', exact: true }).waitFor();
      const reopened = await poll(() => workspaceOutbox(page, primaryAPI), value => value?.pending?.key === retained.key, 'Reopen exact account/API/team/season outbox');
      assert.equal(reopened.pending.bodyJson, retained.bodyJson); assert.equal(reopened.pending.path, retained.path);
      await button(page, 'Retry exact service request');
      const settled = await poll(() => workspaceOutbox(page, primaryAPI), value => !value?.pending && value?.lastSettled?.request.key === retained.key && value.lastSettled.outcome.kind === 'accepted', 'Service receipt durably settled after exact replay');
      assert.equal(observations.length, 2); assert.deepEqual(observations[1], observations[0]);
      assert.equal(settled.lastSettled.request.bodyJson, retained.bodyJson);
      const final = await json(primaryAPI, scoped('preparation'));
      assert.equal(final.revision, committed.revision, 'Cached HTTP receipt does not apply the fixture command twice.');
      assert.equal(final.fixtures.filter(item => item.id === fixtureId).length, 1);
      assert.equal(final.fixtures.find(item => item.id === fixtureId).history.length, 1);
      await page.reload({ waitUntil: 'networkidle' }); await enterWorkspace(page, primaryAPI, 'Fictional manager');
      await poll(() => workspaceOutbox(page, primaryAPI), value => !value?.pending && value?.lastSettled?.request.key === retained.key, 'Acknowledgement survives a second reload');
      assert.equal(await page.getByRole('button', { name: 'Retry exact service request', exact: true }).count(), 0);
      await picture(page, '05-workspace-durable-receipt');
      return { fixtureId, retainedAcrossReload: true, otherAccountCannotReplay: true, identicalWireKeyAndBody: true, finalServiceRevision: final.revision, noDuplicateFixtureOrHistory: true, acknowledgementDurableAfterSecondReload: true };
    } finally { await context.close(); }
  });
  assert.equal(errors.length, 0, `Browser runtime errors: ${errors.join('; ')}`);
} catch (error) { checks.push({ name: 'harness', status: 'failed', error: error.message }); }
finally {
  await writeFile(path.join(directory, 'results.json'), `${JSON.stringify({ baseURL, primaryAPI, controlAPI, runId, artifacts, checks, errors, limitations: ['Fictional development authentication; no real identity provider rehearsal.', 'Browser-controlled monotonic time validates rules and HTTP boundaries, not native clock continuity.', 'Control API clock exchange uses an explicitly fictional trial policy; it approves no Q08 authority or production clock/sharing policy.', 'Phone reboot, SQLCipher, background alerts, lock-screen and physical-device continuity still require native device evidence.', 'Unconfigured antivirus blocks media processing; no publication or malware-scanner claim.'] }, null, 2)}\n`);
  await browser.close();
  for (const { child, stream } of servers) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(5000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    stream.end();
  }
}
if (checks.some(check => check.status === 'failed') || errors.length) process.exitCode = 1;
