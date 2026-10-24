import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import { openWorkspaceTab, reviewDateLabel } from './review-entry.mjs';

/** Real built clients/API/worker, isolated generated credentials, and loopback-only transport. */
const output = path.resolve('.local/quality/demo-account-review');
const webRoot = path.resolve('apps/mobile/dist-demo-web');
const apiBundle = path.resolve('apps/api/dist/api.mjs');
const workerBundle = path.resolve('apps/api/dist/worker.mjs');
const virtualApi = 'https://longball-qa-demo.trycloudflare.com';
const statusAddress = 'https://raw.githubusercontent.com/CharlieOmniPoint/LongBall/preview/longball-m0/preview-status.json';
const teamId = 'synthetic-roma-u10', seasonId = 'synthetic-season-2026-27';
const secrets = new Set();
// Canonical controller/media capabilities are durable demo work, while account
// credentials and login sessions must remain memory-only. Both stay redacted.
const forbiddenBrowserCredentials = new Set();
const children = [];
const browserStates = [];
const checks = [];
const report = { scope: 'Built demo-login web application with fresh SQLite API and separate report worker; virtual discovery/API requests rerouted only to loopback.', roles: [], checks, failures: [], passed: false, loginAttempts: 0, apiRequestWindows: [], apiBudgetWaits: [], httpFailures: [], nativeDeviceEvidence: false, paidServicesProvisioned: false };
const tokenAccounts = new Map(), requestWindows = new Map();
let browser, privateDirectory, base, stage = 'preconditions';
let processDiagnostics = '';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (condition, message) => assert(condition, message);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function sanitise(value, limit = 2500) {
  let text = String(value);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) if (secret) text = text.replaceAll(secret, '[redacted]');
  return text.replace(/Bearer\s+[^\s"',;}]+/gi, 'Bearer [redacted]').replace(/demo_[A-Za-z0-9_-]{43}/g, '[redacted-session]').slice(0, limit);
}
function observeApiRequest(token, method, route) {
  const accountId = tokenAccounts.get(token);
  if (!accountId || route === '/v1/demo/sessions/current') return;
  const now = Date.now();
  let window = requestWindows.get(accountId);
  if (!window || now - window.startedAtMs >= 60000) {
    window = { accountId, startedAtMs: now, startedAt: new Date(now).toISOString(), observedAttempts: 0, observedMutations: 0, scope: 'Actual attempted loopback requests in a local sixty-second observation window; pre-authority denials can make this an upper bound on server counts.' };
    requestWindows.set(accountId, window); report.apiRequestWindows.push(window);
  }
  window.observedAttempts++; if (method !== 'GET') window.observedMutations++;
}
function observeHttpFailure(token, method, route, status, code, controlled = false) {
  report.httpFailures.push({ stage, accountId: tokenAccounts.get(token) ?? 'pre-session', method, pathname: new URL(base + route).pathname, status, code: typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'UNRECOGNISED_ERROR', controlled });
}
async function freshManagerRequestWindow(accountId, phase) {
  const window = requestWindows.get(accountId), began = Date.now();
  // The real API retains 120 reads/commands and 60 mutations per account/minute,
  // across all sessions. Pause only between completed phases; no command is
  // retried, delayed in transit or rebased, and the server limits stay unchanged.
  const waitMs = window ? Math.max(0, window.startedAtMs + 60300 - began) : 0;
  const evidence = { accountId, phase, windowStartedAt: window?.startedAt ?? null, observedAttemptsBefore: window?.observedAttempts ?? 0, observedMutationsBefore: window?.observedMutations ?? 0, plannedWaitMs: waitMs, waitedMs: 0, ordinaryLimit: 120, mutationLimit: 60, pendingCommandRetried: false };
  report.apiBudgetWaits.push(evidence);
  if (waitMs) console.log(JSON.stringify({ reviewBudgetPause: phase, accountRole: 'manager', waitMs }));
  const until = began + waitMs;
  while (Date.now() < until) await delay(Math.min(1000, until - Date.now()));
  evidence.waitedMs = Date.now() - began;
}
function launch(file, environment) {
  const child = spawn(process.execPath, [file], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let ownOutput = '';
  const retain = bytes => {
    ownOutput = (ownOutput + bytes.toString()).slice(-5000);
    if (base && ownOutput.includes(`LongBall API ${base}`)) child.qaApiReady = true;
    processDiagnostics = (processDiagnostics + sanitise(bytes.toString())).slice(-5000);
  };
  child.stdout.on('data', retain); child.stderr.on('data', retain);
  child.on('error', error => retain(error.message));
  return child;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  for (let attempt = 0; attempt < 50 && child.exitCode === null && child.signalCode === null; attempt++) await delay(100);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
async function awaitHealthy(child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('The isolated API exited before becoming ready.');
    if (!child.qaApiReady) { await delay(100); continue; }
    try {
      const response = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const health = await response.json();
        check(health.syntheticOnly === true && health.demoScenario === true && health.demoAccountLogin === true, 'The isolated API must require configured demo accounts.');
        report.apiContractVersion = health.contractVersion;
        return;
      }
    } catch { /* Retry only this newly started loopback process. */ }
    await delay(100);
  }
  throw new Error('The isolated API did not become ready within its bounded startup window.');
}
async function currentJson(token, route, role = 'manager') {
  observeApiRequest(token, 'GET', route);
  const response = await fetch(base + route, { headers: { Authorization: `Bearer ${token}`, 'X-Longball-Role': role }, signal: AbortSignal.timeout(10000) });
  if (response.status !== 200) {
    const value = await response.json().catch(() => null);
    const code = typeof value?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(value.code) ? value.code : 'UNRECOGNISED_ERROR';
    observeHttpFailure(token, 'GET', route, response.status, code);
    const pathname = new URL(base + route).pathname;
    report.apiReadFailure = { stage, pathname, status: response.status, code };
    throw new Error(`The current authorised API read failed: HTTP ${response.status}, ${code}, ${pathname}, stage ${stage}.`);
  }
  return response.json();
}
function changeAccountStatus(databasePath, accountId, status) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA busy_timeout=5000');
    const result = database.prepare('UPDATE accounts SET status=? WHERE id=?').run(status, accountId);
    check(result.changes === 1, 'Only the isolated selected demo account may change status.');
  } finally { database.close(); }
}
function substituteManagerMembership(databasePath, accountId) {
  const database = new DatabaseSync(databasePath), otherTeamId = 'synthetic-other-team';
  let original;
  try {
    database.exec('PRAGMA busy_timeout=5000');
    original = database.prepare("SELECT revoked_at FROM memberships WHERE account_id=? AND team_id=? AND season_id=? AND role='manager'").get(accountId, teamId, seasonId);
    check(original && original.revoked_at === null, 'The owned manager must initially have the current Roma grant.');
    check(!database.prepare("SELECT 1 FROM memberships WHERE account_id=? AND team_id=? AND season_id=? AND role='manager'").get(accountId, otherTeamId, seasonId), 'Only this test may create its temporary other-team manager grant.');
    database.exec('BEGIN IMMEDIATE');
    database.prepare("INSERT INTO memberships(account_id,team_id,season_id,role) VALUES(?,?,?,'manager')").run(accountId, otherTeamId, seasonId);
    check(database.prepare("UPDATE memberships SET revoked_at=? WHERE account_id=? AND team_id=? AND season_id=? AND role='manager'").run(Date.now(), accountId, teamId, seasonId).changes === 1, 'Only the selected Roma manager grant may be revoked.');
    database.exec('COMMIT');
  } catch (error) { if (database.isTransaction) database.exec('ROLLBACK'); throw error; }
  finally { database.close(); }
  return () => {
    const restoring = new DatabaseSync(databasePath);
    try {
      restoring.exec('PRAGMA busy_timeout=5000');
      restoring.exec('BEGIN IMMEDIATE');
      restoring.prepare("DELETE FROM memberships WHERE account_id=? AND team_id=? AND season_id=? AND role='manager'").run(accountId, otherTeamId, seasonId);
      check(restoring.prepare("UPDATE memberships SET revoked_at=? WHERE account_id=? AND team_id=? AND season_id=? AND role='manager'").run(original.revoked_at, accountId, teamId, seasonId).changes === 1, 'The exact owned Roma grant must be restored.');
      restoring.exec('COMMIT');
    } catch (error) { if (restoring.isTransaction) restoring.exec('ROLLBACK'); throw error; }
    finally { restoring.close(); }
  };
}
async function safeScreenshot(page, name) {
  check(await page.getByTestId('demo-signed-in').count() === 1 && await page.getByTestId('demo-login-screen').count() === 0, 'Retained screenshots must contain only a signed-in workspace.');
  const body = await page.locator('body').innerText();
  for (const secret of secrets) check(!body.includes(secret), 'A signed-in view must not disclose a generated credential.');
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
}
async function retainFailureWorkspace(state) {
  try {
    if (state.closed || await state.page.getByTestId('demo-signed-in').count() !== 1 || await state.page.getByTestId('demo-login-screen').count() !== 0) return;
    const body = sanitise(await state.page.locator('body').innerText(), 10000);
    report.failureWorkspaces ??= [];
    const index = report.failureWorkspaces.length;
    await safeScreenshot(state.page, `failure-signed-in-${index}`);
    report.failureWorkspaces.push({ accountId: state.currentSession?.accountId ?? 'unknown', stage, body, screenshot: `failure-signed-in-${index}.png` });
  } catch { /* A closed or changing view must not replace the original safe failure. */ }
}
async function makePage(width) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, acceptDownloads: true, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const state = { context, page, errors: [], routes: [], closed: false, currentSession: null, lastLoginStatus: null, meRequests: 0, holdMe: null, meReplyOnce: null, preparationPosts: 0, configurationPosts: 0, scopedReadReplyOnce: null };
  browserStates.push(state);
  page.on('pageerror', error => state.errors.push(sanitise(error.message)));
  await page.clock.install();
  await context.route('**/*', async route => {
    const request = route.request(), address = new URL(request.url());
    if (address.origin === base) return route.continue();
    if (address.origin === 'https://raw.githubusercontent.com' && address.pathname === new URL(statusAddress).pathname) {
      return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': base, 'Cache-Control': 'no-store' }, body: JSON.stringify({ state: 'ready', url: virtualApi, sourceRevision: report.source.gitHead, startedAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() }) });
    }
    if (address.origin !== virtualApi) {
      state.routes.push('An unexpected external request was blocked.');
      return route.abort();
    }
    const headers = request.headers();
    for (const name of ['authorization', 'x-controller-token', 'x-media-upload-token']) if (headers[name]) {
      const value = headers[name].replace(/^Bearer\s+/i, ''); secrets.add(value);
      if (name === 'authorization') forbiddenBrowserCredentials.add(value);
    }
    const observedToken = headers.authorization?.replace(/^Bearer\s+/i, '');
    try {
      if (address.pathname === '/v1/demo/sessions' && request.method() === 'POST') {
        report.loginAttempts++;
        check(report.loginAttempts <= 17, 'The complete isolated review must stay within its bounded seventeen-attempt login budget.');
      }
      if (/\/preparation$/.test(address.pathname) && request.method() === 'POST') state.preparationPosts++;
      if (/\/configuration$/.test(address.pathname) && request.method() === 'POST') state.configurationPosts++;
      if (state.scopedReadReplyOnce && request.method() === 'GET' && address.pathname.endsWith(state.scopedReadReplyOnce.path)) {
        const status = state.scopedReadReplyOnce.status; state.scopedReadReplyOnce = null;
        observeHttpFailure(observedToken, request.method(), address.pathname, status, status === 503 ? 'STORAGE_UNAVAILABLE' : 'NOT_FOUND', true);
        return route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': base, 'Cache-Control': 'private, no-store' }, body: JSON.stringify({ code: status === 503 ? 'STORAGE_UNAVAILABLE' : 'NOT_FOUND', message: 'The isolated test service cannot supply this scoped read.', retryable: status === 503 }) });
      }
      if (address.pathname === '/v1/me' && request.method() === 'GET') {
        state.meRequests++;
        if (state.holdMe) { state.holdMe.seen(); await state.holdMe.wait; }
        if (state.meReplyOnce) {
          const status = state.meReplyOnce; state.meReplyOnce = null;
          observeHttpFailure(observedToken, request.method(), address.pathname, status, 'STORAGE_UNAVAILABLE', true);
          return route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': base, 'Cache-Control': 'private, no-store' }, body: JSON.stringify({ code: 'STORAGE_UNAVAILABLE', message: 'The isolated test service is temporarily unavailable.', retryable: true }) });
        }
      }
      observeApiRequest(observedToken, request.method(), address.pathname);
      const response = await route.fetch({ url: base + address.pathname + address.search, maxRedirects: 0 });
      if (response.status() >= 400) {
        const failure = await response.json().catch(() => null);
        observeHttpFailure(observedToken, request.method(), address.pathname, response.status(), failure?.code);
      }
      if (address.pathname === '/v1/demo/sessions' && request.method() === 'POST') {
        state.lastLoginStatus = response.status();
        if ([200, 201].includes(response.status())) {
          const session = await response.json();
          check(typeof session.accessToken === 'string', 'A successful login must return its opaque session.');
          secrets.add(session.accessToken); forbiddenBrowserCredentials.add(session.accessToken); tokenAccounts.set(session.accessToken, session.accountId); state.currentSession = session;
        }
      }
      await route.fulfill({ response });
    } catch (error) {
      // Canceled foreground reads and closing contexts can reject route.fetch.
      // Never dump its request headers or raw error object into CI artifacts.
      const message = sanitise(error.message);
      if (!state.closed && !/abort|closed|disposed|canceled|cancelled|already handled/i.test(message)) state.routes.push(message);
      await route.abort().catch(() => undefined);
    }
  });
  return state;
}
async function login(state, account) {
  const { page } = state;
  await page.getByTestId('demo-username').fill(account.username);
  await page.getByTestId('demo-passcode').fill(account.passcode);
  await page.getByTestId('demo-login-submit').click();
  await page.getByTestId('demo-signed-in').waitFor({ timeout: 25000 });
  const ready = { manager: 'Next event', administrator: 'View assigned teams', player: 'Your team, Oliver Bennett' };
  if (account.role === 'spectator') await page.getByTestId('team-overview').waitFor({ timeout: 20000 });
  else await page.getByText(ready[account.role], { exact: true }).first().waitFor({ timeout: 20000 });
  check(state.currentSession?.accountId === account.accountId, 'The service must bind the generated account to its preauthorised identity.');
  check(await page.getByTestId('demo-passcode').count() === 0, 'A signed-in workspace must remove the passcode form.');
}
async function logout(state) {
  const { page } = state, token = state.currentSession.accessToken;
  const deleted = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/demo/sessions/current' && response.request().method() === 'DELETE');
  await page.getByTestId('demo-sign-out').click();
  await page.getByTestId('demo-login-screen').waitFor({ timeout: 15000 });
  check((await deleted).status() === 204, 'Sign-out must revoke its current server session.');
  observeApiRequest(token, 'GET', '/v1/me');
  const stale = await fetch(base + '/v1/me', { headers: { Authorization: `Bearer ${token}` } });
  check(stale.status === 401, 'A signed-out token must not reopen private service views.');
  check(await page.getByTestId('demo-passcode').inputValue() === '', 'Sign-out must leave the passcode empty.');
  check(await page.getByTestId('demo-signed-in').count() === 0, 'Sign-out must close the private workspace.');
}
async function checkBackground(state) {
  const { page } = state;
  const workspace = page.getByTestId('demo-session-workspace');
  await workspace.evaluate(node => { node.dataset.qaRetainedMount = 'same-workspace'; });
  const visibility = value => page.evaluate(next => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => next }); document.dispatchEvent(new Event('visibilitychange')); }, value);
  await visibility('hidden');
  await page.getByTestId('demo-session-cover').waitFor();
  check(await workspace.count() === 1 && !await workspace.isVisible(), 'Backgrounding must cover rather than unmount the private workspace.');
  let release, observed;
  const wait = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { observed = resolve; });
  state.holdMe = { wait, seen: observed, release };
  await visibility('visible');
  let timeout;
  try {
    await Promise.race([seen, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Returning to the foreground must recheck current service identity.')), 10000); })]);
  } finally { clearTimeout(timeout); }
  check(await page.getByTestId('demo-session-cover').isVisible() && !await workspace.isVisible(), 'Private views must remain covered until foreground identity is confirmed.');
  state.holdMe = null; release();
  await page.getByTestId('demo-session-cover').waitFor({ state: 'detached', timeout: 15000 });
  check(await workspace.isVisible() && await workspace.evaluate(node => node.dataset.qaRetainedMount === 'same-workspace'), 'Successful foreground revalidation must reveal the same retained workspace.');
  checks.push('Browser visibility lifecycle covers the private DOM, waits for actual /v1/me, and restores the same mounted workspace.');
  await visibility('hidden');
  await page.getByTestId('demo-session-cover').waitFor();
  state.meReplyOnce = 503;
  await visibility('visible');
  await page.getByTestId('demo-session-retry').waitFor();
  check(!await workspace.isVisible() && await workspace.evaluate(node => node.dataset.qaRetainedMount === 'same-workspace'), 'A transient foreground failure must retain and cover the same workspace.');
  await page.getByTestId('demo-session-retry').click();
  await page.getByTestId('demo-session-cover').waitFor({ state: 'detached', timeout: 15000 });
  check(await workspace.isVisible() && await workspace.evaluate(node => node.dataset.qaRetainedMount === 'same-workspace'), 'Retry must confirm real current access before revealing the retained workspace.');
  checks.push('A controlled foreground503 keeps private views covered; explicit retry rechecks the real service and restores the same DOM.');
}
async function coverForSignOut(state) {
  const { page } = state;
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.getByTestId('demo-session-cover').waitFor();
  let release, observed;
  const wait = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { observed = resolve; });
  state.holdMe = { wait, seen: observed, release };
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  let timeout;
  try { await Promise.race([seen, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('The sign-out check must hold an actual foreground identity request.')), 10000); })]); }
  finally { clearTimeout(timeout); }
  check(await page.getByTestId('demo-session-cover').isVisible(), 'Sign-out must remain available while foreground authorisation is pending.');
  return () => { state.holdMe = null; release(); };
}
async function checkServerDenial(state, account, databasePath) {
  const { page } = state;
  changeAccountStatus(databasePath, account.accountId, 'disabled');
  try {
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.getByTestId('demo-session-cover').waitFor();
    const denied = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/me' && response.status() === 403);
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
    await denied;
    await page.getByTestId('demo-login-screen').waitFor({ timeout: 15000 });
    check(await page.getByTestId('demo-signed-in').count() === 0, 'A real current account denial must close all private views.');
  } finally { changeAccountStatus(databasePath, account.accountId, 'active'); }
  await login(state, account);
  checks.push('A real server-side account disablement closes private views on resume; a fresh login works after independent reactivation.');
}
async function checkStoredCredentials(page) {
  const stored = await page.evaluate(async () => {
    const values = [...Object.values(localStorage), ...Object.values(sessionStorage)];
    for (const info of await indexedDB.databases()) {
      if (!info.name?.includes('longball')) continue;
      const rows = await new Promise((resolve, reject) => {
        const open = indexedDB.open(info.name); open.onerror = () => reject(new Error('The isolated browser journal could not be inspected.'));
        open.onsuccess = () => {
          const db = open.result, names = Array.from(db.objectStoreNames);
          if (!names.length) { db.close(); resolve([]); return; }
          const transaction = db.transaction(names, 'readonly'), found = [];
          for (const name of names) { const query = transaction.objectStore(name).getAll(); query.onsuccess = () => found.push(...query.result); }
          transaction.oncomplete = () => { db.close(); resolve(found); };
          transaction.onerror = () => { db.close(); reject(new Error('The isolated browser journal inspection failed.')); };
        };
      });
      values.push(JSON.stringify(rows));
    }
    return values.join('\n');
  });
  for (const secret of forbiddenBrowserCredentials) check(!stored.includes(secret), 'All browser stores must exclude generated usernames, passwords, demo login tokens and server-only export keys.');
  report.browserStoreInspections = (report.browserStoreInspections ?? 0) + 1;
}
async function exportReports(state) {
  const { page } = state, token = state.currentSession.accessToken;
  await openWorkspaceTab(page, 'reports');
  await selectedWorkspaceTab(page, 'reports');
  await page.getByTestId('records-export-panel').waitFor();
  const records = await currentJson(token, `/v1/teams/${teamId}/records?seasonId=${seasonId}`);
  const exports = {};
  for (const format of ['pdf', 'csv']) {
    await page.getByTestId(`records-export-${format}`).click();
    await page.getByTestId('records-export-download').waitFor({ timeout: 45000 });
    const received = page.waitForResponse(response => /\/v1\/exports\/[^/]+\/download$/.test(new URL(response.url()).pathname));
    const downloaded = page.waitForEvent('download', { timeout: 20000 });
    await page.getByTestId('records-export-download').click();
    const [response, download] = await Promise.all([received, downloaded]);
    check(response.status() === 200 && response.headers()['cache-control'] === 'private, no-store', 'The queued export must use the protected no-store download.');
    check(response.headers()['content-type']?.startsWith(format === 'pdf' ? 'application/pdf' : 'text/csv'), 'The actual export MIME type must match the selected format.');
    check(new RegExp(`^longball-report-[a-f0-9-]+\\.${format}$`).test(download.suggestedFilename()), 'The browser must receive a bounded report attachment filename.');
    const destination = path.join(privateDirectory, `report.${format}`);
    await download.saveAs(destination);
    const bytes = await readFile(destination);
    check(bytes.byteLength > 100 && bytes.byteLength <= 5 * 1024 * 1024, 'The saved export must contain the bounded actual artifact.');
    const python = path.resolve('.venv/bin/python');
    check(existsSync(python), 'Install the pinned requirements-dev.txt virtual environment before parsing reports.');
    const parser = format === 'pdf'
      ? "import json,pymupdf,sys; d=pymupdf.open(sys.argv[1]); t='\\n'.join(p.get_text() for p in d); labels={n:n in t for n in ['Roma U10','Oak FC','Hill FC']}; assert all(labels.values()),'The saved PDF must contain readable current team and completed opponents'; print(json.dumps({'pages':len(d),'readableLabels':labels}))"
      : "import csv,json,sys; rows=list(csv.reader(open(sys.argv[1],encoding='utf-8-sig',newline=''))); assert rows[0]==['section','field','value'],'The queued CSV header must match the export contract'; revision=[r[2] for r in rows if r[:2]==['metadata','projectionVersion']]; assert revision==[sys.argv[2]],'The CSV must use the current report revision'; text='\\n'.join(','.join(r) for r in rows); assert 'Oak FC' in text and 'Hill FC' in text,'Completed opponents must remain in the saved CSV'; print(json.dumps({'rows':len(rows),'header':rows[0],'projectionVersion':int(revision[0])}))";
    const parsed = JSON.parse(execFileSync(python, ['-c', parser, destination, String(records.revision)], { encoding: 'utf8', timeout: 20000, maxBuffer: 65536 }));
    if (format === 'pdf') check(bytes.subarray(0, 5).toString() === '%PDF-', 'The saved PDF must have the actual PDF signature.');
    else check(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'The queued CSV must retain its UTF-8 signature.');
    exports[format] = { bytes: bytes.byteLength, sha256: digest(bytes), status: response.status(), noStore: true, ...parsed };
    await page.getByRole('button', { name: 'Close this export request', exact: true }).click();
  }
  const current = await currentJson(token, `/v1/teams/${teamId}/records?seasonId=${seasonId}`);
  check(current.revision === records.revision, 'Preparing and downloading reports must not change the accepted report revision.');
  report.exports = exports;
  checks.push('Separate worker prepares actual PDF/CSV; browser saves and parses protected artifacts at the current report revision.');
}

async function preparationCommand(token, payload) {
  const route = `/v1/teams/${teamId}/preparation?seasonId=${seasonId}`;
  const current = await currentJson(token, route);
  const id = randomUUID();
  observeApiRequest(token, 'POST', route);
  const response = await fetch(base + route, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Longball-Role': 'manager', 'Content-Type': 'application/json', 'X-Api-Contract-Version': report.apiContractVersion, 'Idempotency-Key': id },
    body: JSON.stringify({ command: { ...payload, id, expectedRevision: current.revision } }), signal: AbortSignal.timeout(10000),
  });
  if (response.status !== 200) {
    const failure = await response.json().catch(() => null);
    observeHttpFailure(token, 'POST', route, response.status, failure?.code);
    throw new Error(`The isolated preparation command failed: HTTP ${response.status}, ${/^[A-Z0-9_]{1,80}$/.test(failure?.code ?? '') ? failure.code : 'UNRECOGNISED_ERROR'}, ${new URL(base + route).pathname}, stage ${stage}.`);
  }
  return response.json();
}
function fixtureLineup(match) {
  const assignments = [], { slots, players, selectedPlayerIds, profileSnapshot, fixedKeeperId } = match.config;
  function choose(index, used = new Set()) {
    if (index === slots.length) return true;
    for (const player of players.filter(item => selectedPlayerIds.includes(item.id))) {
      const profile = profileSnapshot.find(item => item.playerId === player.id);
      if (used.has(player.id) || !profile?.eligiblePositions.includes(slots[index].position) || slots[index].position === 'GK' && fixedKeeperId && player.id !== fixedKeeperId) continue;
      assignments[index] = player;
      if (choose(index + 1, new Set([...used, player.id]))) return true;
    }
    return false;
  }
  check(choose(0), 'The actual prepared snapshot must support a complete eligible lineup.');
  return assignments;
}
async function openDemo(state, account) {
  await state.page.goto(base, { waitUntil: 'networkidle' });
  await state.page.getByTestId('welcome-sign-in').click();
  await state.page.getByTestId('demo-login-screen').waitFor();
  await login(state, account);
}
async function selectedWorkspaceTab(page, tab) {
  const navigation = page.getByTestId('workspace-primary-navigation');
  const direct = navigation.getByTestId(`workspace-tab-${tab}`);
  const target = await direct.count() ? direct : navigation.getByTestId('workspace-tab-more');
  await target.waitFor();
  check(await target.getAttribute('aria-selected') === 'true', 'The current workspace navigation tab must expose its selected state to browser assistive technology.');
}
async function managerDetailRegression(state, preparation, fixtureId) {
  const { page } = state;
  await openWorkspaceTab(page, 'schedule');
  const fixture = preparation.fixtures.find(item => item.id === fixtureId);
  await page.getByRole('button', { name: `Open fixture ${fixture.opponent}, ${reviewDateLabel(fixture.playedDate)}`, exact: true }).click();
  for (const profileId of fixture.selectedProfileIds.slice(0, 2)) {
    const profile = preparation.profiles.find(item => item.id === profileId);
    const saved = page.waitForResponse(response => /\/preparation$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST');
    const option = page.getByRole('radio', { name: `${profile.displayName} availability reply: Unsure`, exact: true });
    await option.click();
    check((await saved).status() === 200, 'The manager detail mutation must reach the actual service.');
    await page.getByRole('button', { name: 'Back to schedule', exact: true }).waitFor();
    await page.waitForFunction(name => document.querySelector(`[role="radio"][aria-label="${name}"]`)?.getAttribute('aria-checked') === 'true', `${profile.displayName} availability reply: Unsure`);
    check(await page.getByText(`${preparation.team.name} vs ${fixture.opponent}`, { exact: true }).isVisible(), 'Accepted preparation refresh must retain the selected fixture detail.');
  }
  const accepted = await currentJson(state.currentSession.accessToken, `/v1/teams/${teamId}/preparation?seasonId=${seasonId}`);
  const updated = accepted.fixtures.find(item => item.id === fixtureId);
  check(fixture.selectedProfileIds.slice(0, 2).every(id => updated.responses[id] === 'unsure'), 'Both sequential edits must remain accepted for the same selected fixture.');
  checks.push('Two actual fixture reply mutations retain the selected Schedule detail through accepted refresh, allowing the next player edit.');
}
async function administratorDraftRegression(account) {
  const state = await makePage(390), { page } = state;
  try {
    await openDemo(state, account);
    await openWorkspaceTab(page, 'clubs');
    await selectedWorkspaceTab(page, 'clubs');
    await page.getByRole('button', { name: 'Edit club and team configuration', exact: true }).click();
    await page.getByTestId('administrator-configuration').waitFor();
    const team = page.getByLabel('Team name', { exact: true });
    const originalName = await team.inputValue(), draftName = `${originalName} review draft`;
    const club = page.getByLabel('Club name', { exact: true });
    const originalClub = await club.inputValue();
    await team.fill(draftName);
    await club.fill(`${originalClub} review`);
    const saved = page.waitForResponse(response => /\/configuration$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Save administrator club configuration', exact: true }).click();
    check((await saved).status() === 200, 'The club-only command must be accepted.');
    await page.getByTestId('administrator-configuration').waitFor();
    await page.waitForFunction(expected => document.querySelector('input[aria-label="Team name"]')?.value === expected, draftName);
    const configuration = await currentJson(state.currentSession.accessToken, `/v1/teams/${teamId}/configuration?seasonId=${seasonId}`, 'administrator');
    check(configuration.team.name === originalName && configuration.club.name === `${originalClub} review`, 'Saving club configuration must not submit the separate unsaved team draft.');
    const panel = page.getByTestId('administrator-configuration');
    await panel.evaluate(node => { node.dataset.qaRetainedConfiguration = 'same-authorised-draft'; });
    const externalId = randomUUID(), conflictingDraft = `${originalClub} retained draft`, externalName = `${originalClub} external review`;
    await club.fill(conflictingDraft);
    observeApiRequest(state.currentSession.accessToken, 'POST', `/v1/teams/${teamId}/configuration`);
    const external = await fetch(`${base}/v1/teams/${teamId}/configuration?seasonId=${seasonId}`, {
      method: 'POST', headers: { Authorization: `Bearer ${state.currentSession.accessToken}`, 'X-Longball-Role': 'administrator', 'Content-Type': 'application/json', 'X-Api-Contract-Version': report.apiContractVersion, 'Idempotency-Key': externalId },
      body: JSON.stringify({ command: { id: externalId, expectedRevision: configuration.revision, type: 'club.updated', name: externalName, logo: configuration.club.logo } }), signal: AbortSignal.timeout(10000),
    });
    check(external.status === 200, 'An independent actual administrator update must create the stale editor revision.');
    const postsBeforeConflict = state.configurationPosts;
    const conflict = page.waitForResponse(response => /\/configuration$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Save administrator club configuration', exact: true }).click();
    const conflictResponse = await conflict;
    check(conflictResponse.status() === 422 && (await conflictResponse.json()).code === 'COMMAND_REJECTED', 'The current configuration wire contract must reject a stale administrator draft with COMMAND_REJECTED422.');
    await page.getByRole('button', { name: 'Refresh service views', exact: true }).waitFor();
    await page.waitForLoadState('networkidle');
    check(state.configurationPosts === postsBeforeConflict + 1 && await club.inputValue() === conflictingDraft && await club.isEditable(), 'A definitive rejected command must retain its editable draft and avoid automatic resubmission.');
    const reloaded = page.waitForResponse(response => /\/configuration$/.test(new URL(response.url()).pathname) && response.request().method() === 'GET' && response.status() === 200);
    await page.getByRole('button', { name: 'Refresh service views', exact: true }).click();
    await reloaded;
    await page.getByText(`Current club name: ${externalName}`, { exact: true }).waitFor();
    check(await club.inputValue() === conflictingDraft && await team.inputValue() === draftName && state.configurationPosts === postsBeforeConflict + 1, 'Explicit refresh must show the latest server value while retaining both drafts without a write.');
    await page.getByRole('button', { name: 'I have reviewed the latest club configuration; keep my draft', exact: true }).click();
    check(await club.inputValue() === conflictingDraft, 'Explicit conflict review must keep the reviewer-selected draft unchanged.');
    await club.fill(`${originalClub} retry review`);
    state.scopedReadReplyOnce = { path: '/configuration', status: 503 };
    const unavailable = page.waitForResponse(response => /\/configuration$/.test(new URL(response.url()).pathname) && response.request().method() === 'GET' && response.status() === 503);
    await page.getByRole('button', { name: 'Save administrator club configuration', exact: true }).click();
    await unavailable;
    await page.getByRole('button', { name: 'Refresh service views', exact: true }).waitFor();
    check(await panel.evaluate(node => node.dataset.qaRetainedConfiguration === 'same-authorised-draft') && await team.inputValue() === draftName && await page.getByRole('button', { name: 'Save administrator team configuration', exact: true }).isDisabled(), 'A transient required scoped read must keep the same private draft mounted but disable further changes.');
    const retried = page.waitForResponse(response => /\/configuration$/.test(new URL(response.url()).pathname) && response.request().method() === 'GET' && response.status() === 200);
    await page.getByRole('button', { name: 'Refresh service views', exact: true }).click();
    await retried;
    await page.getByRole('button', { name: 'Save administrator team configuration', exact: true }).click({ trial: true });
    check(await panel.evaluate(node => node.dataset.qaRetainedConfiguration === 'same-authorised-draft') && await team.inputValue() === draftName, 'Successful explicit retry must restore the same authorised unsaved team draft.');
    const meBeforeDenial = state.meRequests;
    await club.fill(`${originalClub} denied review`);
    state.scopedReadReplyOnce = { path: '/configuration', status: 403 };
    const denied = page.waitForResponse(response => /\/configuration$/.test(new URL(response.url()).pathname) && response.request().method() === 'GET' && response.status() === 403);
    await page.getByRole('button', { name: 'Save administrator club configuration', exact: true }).click();
    await denied;
    await panel.waitFor({ state: 'detached' });
    check(await page.getByTestId('demo-signed-in').count() === 1 && state.meRequests > meBeforeDenial, 'A denied current scope must close private configuration even when the demo account remains signed in.');
    const currentIdentity = await currentJson(state.currentSession.accessToken, '/v1/me', 'administrator');
    check(currentIdentity.principal?.accountId === account.accountId, 'The scoped-denial regression must independently confirm that current /v1/me still succeeds for the same account.');
    check(state.errors.length === 0 && state.routes.length === 0, 'The administrator draft regression must have no runtime or transport errors.');
    await checkStoredCredentials(page);
    await logout(state);
    report.administratorDraft = { unrelatedClubSaveAccepted: true, unsavedTeamDraftRetained: true, teamNameUnchangedOnService: true, actual422RetainsEditableDraftWithoutAutomaticWrite: true, explicitConflictRefreshAndReview: true, transientScopedRead503RetainsDisabledDraft: true, explicitRetryRestoresSameDraft: true, scopedRead403ClosesPrivateFormWhileMe200: true, signedOut: true };
    checks.push('Administrator club save preserves the separate unsaved Team name draft across accepted refresh without submitting it.');
    checks.push('Actual concurrent administrator update produces the existing COMMAND_REJECTED422; the editor retains editable drafts with no automatic POST, and explicit refresh exposes the latest value for separate keep-draft review.');
    checks.push('Controlled required configuration503 retains the same disabled draft and explicit retry restores it; configuration403 closes private views even while independently verified /v1/me remains200.');
  } finally { state.closed = true; await state.context.close(); }
}
async function playerReplyRegression(account) {
  const state = await makePage(390), { page } = state;
  try {
    await openDemo(state, account);
    await openWorkspaceTab(page, 'schedule');
    await page.getByTestId('own-schedule-upcoming').click();
    await page.getByTestId('own-schedule-kind-match').click();
    const fixtureId = 'synthetic-roma-maple-2026-10-24';
    const fixture = page.getByTestId(`own-schedule-event-match-${fixtureId}`);
    await fixture.evaluate(node => { node.dataset.qaRetainedReply = 'same-selected-match'; });
    const before = await currentJson(state.currentSession.accessToken, `/v1/teams/${teamId}/preparation/own?seasonId=${seasonId}`, 'player');
    const previous = before.fixtures.find(item => item.id === fixtureId);
    const saved = page.waitForResponse(response => /\/preparation\/own$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST');
    const refreshed = page.waitForResponse(response => /\/preparation\/own$/.test(new URL(response.url()).pathname) && response.request().method() === 'GET');
    await fixture.getByRole('button', { name: 'Unsure', exact: true }).click();
    check((await saved).status() === 200 && (await refreshed).status() === 200, 'Own RSVP must be accepted and current player preparation reloaded.');
    await fixture.getByRole('button', { name: 'Available', exact: true }).waitFor();
    const accepted = await currentJson(state.currentSession.accessToken, `/v1/teams/${teamId}/preparation/own?seasonId=${seasonId}`, 'player');
    const current = accepted.fixtures.find(item => item.id === fixtureId);
    check(current.response === 'unsure' && current.attendance === previous.attendance && current.selected === previous.selected, 'Own RSVP must change only the current player reply, retaining selection and actual attendance.');
    check(await fixture.evaluate(node => node.dataset.qaRetainedReply === 'same-selected-match') && await page.getByTestId(/^own-schedule-event-training-/).count() === 0, 'Accepted own-reply refresh must retain the mounted match card and Matches filter.');
    check(state.errors.length === 0 && state.routes.length === 0, 'Player RSVP regression must have no runtime or transport errors.');
    await checkStoredCredentials(page);
    await logout(state);
    report.playerReply = { accepted: 'unsure', actualAttendanceUnchanged: true, selectionUnchanged: true, matchFilterRetained: true, matchCardRetained: true, signedOut: true };
    checks.push('Player upcoming RSVP is accepted without changing actual attendance or manager selection; accepted refresh retains the same match card, Matches filter and usable Schedule.');
  } finally { state.closed = true; await state.context.close(); }
}
async function refreshManagerViews(page) {
  await openWorkspaceTab(page, 'more');
  const refreshed = page.waitForResponse(response => /\/preparation$/.test(new URL(response.url()).pathname) && response.request().method() === 'GET');
  await page.getByRole('button', { name: 'Refresh service views', exact: true }).click();
  check((await refreshed).status() === 200, 'Explicit manager refresh must load actual current preparation.');
}
async function staleProfileRegression(state) {
  const { page } = state, token = state.currentSession.accessToken;
  const route = `/v1/teams/${teamId}/preparation?seasonId=${seasonId}`;
  const preparation = await currentJson(token, route);
  const profile = preparation.profiles.find(item => item.playerId === 'synthetic-player-01');
  await openWorkspaceTab(page, 'team');
  await page.getByRole('button', { name: `Edit ${profile.displayName}`, exact: true }).click();
  const name = page.getByLabel('Player display name', { exact: true }), draftName = `${profile.displayName} unsaved review`;
  await name.fill(draftName);
  const remoteFoot = profile.foot === 'both' ? 'right' : 'both';
  await preparationCommand(token, { type: 'profile.saved', profile: { ...profile, foot: remoteFoot } });
  const postsBefore = state.preparationPosts;
  const rejected = page.waitForResponse(response => /\/preparation$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST');
  await page.getByTestId('preparation-save').click();
  const response = await rejected;
  check(response.status() === 422 && (await response.json()).code === 'COMMAND_REJECTED', 'The stale full-form save must be rejected by the actual preparation CAS contract.');
  await page.getByRole('button', { name: 'Refresh service views', exact: true }).waitFor();
  check(await name.inputValue() === draftName, 'The rejected profile form must keep its unsaved display-name draft.');
  const refreshed = page.waitForResponse(reply => /\/preparation$/.test(new URL(reply.url()).pathname) && reply.request().method() === 'GET');
  await page.getByRole('button', { name: 'Refresh service views', exact: true }).click();
  check((await refreshed).status() === 200, 'The explicit refresh must verify the newer profile revision.');
  await page.getByTestId('preparation-discard-stale-draft').waitFor();
  check(await name.inputValue() === draftName && await page.getByTestId('preparation-save').isDisabled() && state.preparationPosts === postsBefore + 1, 'A refreshed full-form draft must retain its opening revision and stay blocked without another POST.');
  const accepted = await currentJson(token, route), current = accepted.profiles.find(item => item.id === profile.id);
  check(current.foot === remoteFoot && current.displayName === profile.displayName, 'The rejected stale form must preserve the independent newer field and never publish its unsaved name.');
  await page.getByTestId('preparation-discard-stale-draft').click();
  await page.getByRole('button', { name: `Edit ${profile.displayName}`, exact: true }).click();
  check(await page.getByLabel('Player display name', { exact: true }).inputValue() === profile.displayName, 'Discard and reopen must show the current saved profile name.');
  check(await page.getByRole('radio', { name: `Preferred foot: ${remoteFoot === 'both' ? 'Both' : 'Right'}`, exact: true }).getAttribute('aria-checked') === 'true', 'The independently updated foot must be exposed as the checked radio after discard and reopen.');
  await page.getByRole('button', { name: 'Keep previous values', exact: true }).click();
  report.staleProfile = { actualRejectedStatus: 422, originalDraftRetained: true, explicitRefreshBlocksStaleForm: true, automaticWriteCount: 0, newerFootPreserved: true, unsavedNameNotPublished: true, discardAndReopenCurrent: true };
  checks.push('Actual concurrent profile-field change rejects a stale full-form save; explicit refresh retains the draft but blocks saving at its original revision, and discard/reopen reveals the newer saved field without publishing the unsaved name.');
}
async function selectedManagerScopeRevocation(state, account, databasePath) {
  const { page } = state, token = state.currentSession.accessToken;
  const restore = substituteManagerMembership(databasePath, account.accountId);
  try {
    const identity = await currentJson(token, '/v1/me');
    check(identity.principal.accountId === account.accountId && identity.memberships.some(item => item.role === 'manager' && item.teamId === 'synthetic-other-team') && !identity.memberships.some(item => item.role === 'manager' && item.teamId === teamId && item.seasonId === seasonId), 'Actual current identity must keep another manager grant while denying only the selected Roma scope.');
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.getByTestId('demo-session-cover').waitFor();
    const freshIdentity = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/me' && response.request().method() === 'GET' && response.status() === 200);
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
    await freshIdentity;
    await page.getByTestId('demo-login-screen').waitFor();
    check(await page.getByTestId('demo-signed-in').count() === 0 && await page.getByTestId('workspace-match-header').count() === 0, 'A current selected-scope denial must close the private manager match despite another manager grant.');
  } finally { restore(); }
  await login(state, account);
  checks.push('Actual Roma manager grant revocation closes its private workspace on foreground even while /v1/me200 retains a separate Milan manager grant; the exact temporary membership changes are then restored.');
}
async function archivedFutureRegression(state) {
  const { page } = state, token = state.currentSession.accessToken;
  const route = `/v1/teams/${teamId}/preparation?seasonId=${seasonId}`;
  const before = await currentJson(token, route);
  const profile = before.profiles.find(item => item.displayName === 'Noah Patel');
  const fixture = before.fixtures.find(item => item.id === 'synthetic-roma-oak-2026-10-31');
  check(profile?.active && fixture.selectedProfileIds.includes(profile.id), 'The archive regression needs an active named player selected for the future Oak game.');
  const retainedHistory = structuredClone(before.training.filter(item => item.status !== 'scheduled'));
  const held = retainedHistory.find(item => item.status === 'held' && item.expectedProfileIds.includes(profile.id));
  const upcomingTraining = before.training.filter(item => item.status === 'scheduled' && item.date >= '2026-10-24').sort((a, b) => a.date.localeCompare(b.date));
  check(upcomingTraining.length >= 2 && held, 'The archive regression needs future occurrence/series drafts and actual held history.');
  const occurrence = upcomingTraining.at(-1), seriesOccurrence = upcomingTraining[0];
  await preparationCommand(token, { type: 'profile.archived', profileId: profile.id });
  await page.getByTestId('workspace-back-to-team').click();
  await refreshManagerViews(page);
  await openWorkspaceTab(page, 'schedule');
  await page.getByRole('button', { name: `Open fixture ${fixture.opponent}, ${reviewDateLabel(fixture.playedDate)}`, exact: true }).click();
  const remove = page.getByRole('button', { name: `Remove ${profile.displayName} from match squad`, exact: true });
  await remove.waitFor();
  check(await page.getByText('Archived', { exact: true }).count() > 0, 'A retained archived selection must remain visible rather than silently disappearing.');
  const removed = page.waitForResponse(response => /\/preparation$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST');
  await remove.click();
  check((await removed).status() === 200, 'Removing the archived future selection must be an explicit accepted command.');
  await remove.waitFor({ state: 'hidden' });
  let current = await currentJson(token, route), changed = current.fixtures.find(item => item.id === fixture.id);
  assert.deepEqual(changed.selectedProfileIds, fixture.selectedProfileIds.filter(id => id !== profile.id));
  assert.deepEqual(changed.attendance, fixture.attendance, 'Removing an archived future selection must not invent actual attendance.');
  checks.push('A selected player archived through an actual manager command remains visible in the future fixture until explicit UI removal; accepted selection changes without inferred attendance.');

  await page.getByRole('button', { name: 'Back to schedule', exact: true }).click();
  await page.getByRole('radio', { name: 'Event type: Training', exact: true }).click();
  await page.getByRole('button', { name: `Open training ${reviewDateLabel(occurrence.date)}`, exact: true }).click();
  await page.getByRole('button', { name: 'Edit this occurrence', exact: true }).click();
  await page.getByRole('button', { name: `Remove ${profile.displayName} from expected players`, exact: true }).click();
  const occurrenceSaved = page.waitForResponse(response => /\/preparation$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save training occurrence', exact: true }).click();
  check((await occurrenceSaved).status() === 200, 'The future occurrence must save after explicit archived expected-player removal.');
  await page.getByRole('button', { name: 'Edit this occurrence', exact: true }).waitFor();
  current = await currentJson(token, route);
  check(!current.training.find(item => item.id === occurrence.id).expectedProfileIds.includes(profile.id), 'The accepted future occurrence must omit only the explicitly removed expected player.');
  assert.deepEqual(current.training.filter(item => item.status !== 'scheduled'), retainedHistory, 'Editing a future training occurrence must retain held/cancelled history exactly.');

  await page.getByRole('button', { name: 'Back to schedule', exact: true }).click();
  await page.getByRole('button', { name: `Open training ${reviewDateLabel(seriesOccurrence.date)}`, exact: true }).click();
  await page.getByTestId('training-series-manage').click();
  await page.getByRole('button', { name: `Remove ${profile.displayName} from series expected players`, exact: true }).click();
  await page.getByTestId('training-series-review').click();
  await page.getByTestId('training-series-confirm').waitFor();
  const seriesSaved = page.waitForResponse(response => /\/preparation$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST');
  await page.getByTestId('training-series-confirm').click();
  check((await seriesSaved).status() === 200, 'The explicitly reviewed future training series must save after archived expected-player removal.');
  await page.getByTestId('training-series-manage').waitFor();
  current = await currentJson(token, route);
  const scheduled = current.training.filter(item => item.recurrenceGroupId === seriesOccurrence.recurrenceGroupId && item.status === 'scheduled');
  check(scheduled.length > 0 && scheduled.every(item => !item.expectedProfileIds.includes(profile.id)), 'Every explicitly reviewed scheduled occurrence must use the updated expected-player selection.');
  assert.deepEqual(current.training.filter(item => item.status !== 'scheduled'), retainedHistory, 'Updating scheduled series expectations must retain held/cancelled history exactly.');
  for (const previous of before.training.filter(item => item.status === 'scheduled')) {
    assert.deepEqual(current.training.find(item => item.id === previous.id).attendance, previous.attendance, 'Future expected-player changes must not invent training attendance.');
  }
  await page.getByRole('button', { name: 'Back to schedule', exact: true }).click();
  await page.getByRole('radio', { name: 'Schedule period: Past', exact: true }).click();
  await page.getByRole('button', { name: `Open training ${reviewDateLabel(held.date)}`, exact: true }).click();
  await page.getByText(profile.displayName, { exact: true }).waitFor();
  check(await page.getByText('Archived', { exact: true }).count() > 0 && await page.getByRole('radio', { name: `${profile.displayName} training attendance: Present`, exact: true }).isDisabled(), 'Past training must retain the archived player and read-only historical attendance.');
  await page.getByTestId('workspace-return-to-match').click();
  await page.getByText('Recording on this phone', { exact: true }).waitFor();
  await page.getByTestId('connected-match-live').click();
  report.archivedFuture = { playerId: profile.playerId, futureSelectionExplicitlyRemoved: true, futureMatchAttendanceUnchanged: true, occurrenceSaved: true, reviewedSeriesSaved: true, heldAndCancelledHistoryUnchanged: retainedHistory.length, futureTrainingAttendanceUnchanged: true, historicalArchivedRowReadOnly: true };
  checks.push('Future occurrence and reviewed series drafts expose archived expected players for explicit removal and save successfully; future attendance and complete held/cancelled records remain unchanged, with archived historical attendance visible and read-only.');
}
async function managerMatchday(accounts, databasePath) {
  const matchId = 'synthetic-roma-maple-2026-10-24';
  const manager = await makePage(390), viewer = await makePage(390), { page } = manager;
  const button = name => page.getByRole('button', { name, exact: true });
  try {
    await openDemo(manager, accounts.find(item => item.role === 'manager'));
    const token = manager.currentSession.accessToken;
    const readAccepted = () => currentJson(token, `/v1/matches/${matchId}/download?deviceId=independent-matchday-review`);
    await staleProfileRegression(manager);
    const preparation = await currentJson(token, `/v1/teams/${teamId}/preparation?seasonId=${seasonId}`);
    await managerDetailRegression(manager, preparation, matchId);
    await page.getByTestId('preparation-open-match').click();
    await page.getByTestId('recording-acquire').waitFor();
    await page.getByTestId('workspace-match-header').waitFor();
    check(await page.getByTestId('workspace-tab-home').count() === 0, 'The focused match console must hide team navigation.');
    stage = 'manager initial accepted checkpoint after current preparation';
    const initial = await readAccepted(), match = initial.state;
    check(initial.acceptedRevision === 0 && match.config.selectedPlayerIds.length === 9 && match.config.pitchPlaces === 7, 'The prepared upcoming game must start with nine selected, seven places and no accepted play.');
    const assignments = fixtureLineup(match), slots = match.config.slots;
    stage = 'manager initial controller acquisition after accepted checkpoint';
    await page.getByTestId('recording-acquire').click();
    await page.getByTestId('connected-match-attendance').click();
    for (const playerId of match.config.selectedPlayerIds) {
      const name = match.config.players.find(item => item.id === playerId).displayName;
      const row = page.locator('div').filter({ has: page.getByText(new RegExp(`^${name} · `)) }).filter({ has: button('Present') }).last();
      await row.getByRole('button', { name: 'Present', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('[role="progressbar"]'));
    }
    await page.getByTestId('connected-match-lineup').click();
    await button('Show position list').click();
    for (let index = 0; index < slots.length; index++) {
      await page.getByRole('button', { name: new RegExp(`^${slots[index].label ?? slots[index].position} · place ${index + 1},`) }).click();
      await button(assignments[index].displayName).click();
    }
    await button('Save staged lineup').click();
    check((await readAccepted()).acceptedRevision === 0, 'Locally recorded attendance and staged lineup must not claim service acceptance.');
    await page.getByTestId('connected-match-live').click();
    await button('Start first half').click();
    await button('Confirm the actual event now').click();
    await page.getByTestId('workspace-back-to-team').click();
    await page.getByTestId('workspace-manager-home').waitFor();
    await page.getByTestId('workspace-return-to-match').click();
    await page.getByTestId('connected-match-live').click();
    await button('Review referee pause').click();
    await button('Confirm the actual event now').click();
    await page.getByTestId('recording-upload').click();
    await page.getByText('Up to date with the service', { exact: true }).waitFor();
    stage = 'manager accepted attendance, lineup and paused clock';
    const paused = await readAccepted(), saved = paused.state;
    check(paused.acceptedRevision >= 12 && saved.status === 'first_half_paused', 'Actual attendance, lineup, kickoff and referee pause must reach the canonical accepted stream.');
    check(match.config.selectedPlayerIds.every(id => saved.attendance[id] === 'present'), 'All nine selected players must have explicit accepted present attendance.');
    assert.deepEqual(saved.lineup.map(item => ({ slotId: item.slotId, playerId: item.playerId })), slots.map((slot, index) => ({ slotId: slot.slotId, playerId: assignments[index].id })), 'The accepted seven-place lineup must match the actual eligible UI selections.');
    check(saved.matchActiveMs >= 0 && saved.half === 1, 'The accepted first-half clock must remain valid.');
    assert.deepEqual(saved.score, { for: 0, against: 0 });
    checks.push('Manager explicitly claims recording, checks in nine players, stages seven eligible places, confirms kickoff and referee pause, navigates back/return, and uploads; independent HTTP verifies accepted attendance, lineup and clock.');
    stage = 'bounded API window pause after accepted referee pause';
    await freshManagerRequestWindow(accounts.find(item => item.role === 'manager').accountId, 'after-accepted-referee-pause');
    const afterBudgetPause = await readAccepted();
    check(afterBudgetPause.acceptedRevision === paused.acceptedRevision && afterBudgetPause.state.status === saved.status && afterBudgetPause.state.matchActiveMs === saved.matchActiveMs, 'A completed API-budget phase pause must leave the accepted referee-paused match unchanged.');
    stage = 'recorded match reopening and future archived selections';

    // Profile/template edits are future preparation. They cannot rewrite a claimed match.
    const beforeConfig = structuredClone(saved.config);
    const profile = preparation.profiles.find(item => item.playerId === assignments[0].id);
    await preparationCommand(token, { type: 'profile.saved', profile: { ...profile, displayName: `${profile.displayName} future` } });
    const formation = preparation.formations.find(item => item.id === 'formation-7');
    const { version: _version, ...template } = formation;
    await preparationCommand(token, { type: 'formation.saved', formation: { ...template, name: `${template.name} future` } });
    await page.getByTestId('workspace-back-to-team').click();
    await refreshManagerViews(page);
    await openWorkspaceTab(page, 'schedule');
    await page.getByRole('button', { name: 'Open fixture Maple FC, 24/10/26', exact: true }).click();
    const postsBeforeOpen = manager.preparationPosts;
    await page.getByTestId('preparation-open-saved-match').click();
    await page.getByText('Recording on this phone', { exact: true }).waitFor();
    await page.getByTestId('connected-match-live').click();
    check(manager.preparationPosts === postsBeforeOpen, 'Opening saved recorded play must not attempt another fixture.prepared mutation.');
    const reopened = await readAccepted();
    assert.deepEqual(reopened.state.config, beforeConfig, 'Opening a recorded match after profile/template edits must retain its original immutable snapshot.');
    check(reopened.acceptedRevision === paused.acceptedRevision && reopened.state.status === 'first_half_paused', 'Reopening saved play must preserve the accepted revision and paused clock.');
    checks.push('After actual future profile/template edits, Schedule reopens the saved recorded match without preparation POST or immutable-history failure; its original squad/formation and accepted clock remain unchanged.');
    await archivedFutureRegression(manager);

    await openDemo(viewer, accounts.find(item => item.role === 'spectator'));
    await openWorkspaceTab(viewer.page, 'centre');
    await selectedWorkspaceTab(viewer.page, 'centre');
    const sharedCard = viewer.page.getByTestId(`match-centre-game-${matchId}`);
    await sharedCard.getByText('0 – 0', { exact: true }).waitFor();
    await page.getByTestId('open-goal').click();
    await button('Penalty').click();
    const captured = await page.getByText(/^Effective time: half /).innerText();
    await button('Review clock resume').click();
    await button('Confirm the actual event now').click();
    await page.getByTestId('recording-upload').click();
    await page.getByText('Up to date with the service', { exact: true }).waitFor();
    await page.getByTestId('save-goal').waitFor();
    check(await page.getByText(/^Effective time: half /).innerText() === captured, 'A verified clock upload must retain the open goal draft and its original paused capture time.');
    await page.getByTestId('save-goal').click();
    await page.getByTestId('save-goal').waitFor({ state: 'hidden' });
    const queuedGoal = await page.evaluate(async target => {
      const record = await new Promise((resolve, reject) => {
        const opening = indexedDB.open('longball-synthetic-m0');
        opening.onerror = () => reject(new Error('Cannot inspect the owned local match journal.'));
        opening.onsuccess = () => { const db = opening.result, transaction = db.transaction('journal', 'readonly'), read = transaction.objectStore('journal').get('record'); transaction.oncomplete = () => { db.close(); resolve(read.result); }; transaction.onerror = () => reject(new Error('Cannot read the owned local match journal.')); };
      });
      return Object.values(record?.projections ?? {}).find(value => value?.kind === 'longball-canonical-connected-v1' && value.matchId === target)?.outbox.findLast(value => value.envelope.command.type === 'goal.recorded')?.envelope.command;
    }, matchId);
    check(queuedGoal?.goalType === 'penalty' && queuedGoal.effective.halfElapsedMs === saved.halfActiveMs, 'The locally queued goal must preserve penalty selection and its original paused effective time.');
    assert.deepEqual((await readAccepted()).state.score, { for: 0, against: 0 }, 'A local goal must remain absent from independently read accepted play.');
    check(await sharedCard.getByText('1 – 0', { exact: true }).count() === 0, 'Spectators must not receive locally queued goals.');
    await page.getByTestId('recording-upload').click();
    await sharedCard.getByText('1 – 0', { exact: true }).waitFor({ timeout: 15000 });
    await page.getByText('Up to date with the service', { exact: true }).waitFor();
    const final = await readAccepted();
    assert.deepEqual(final.state.score, { for: 1, against: 0 });
    check(final.acceptedRevision > paused.acceptedRevision && final.state.status === 'first_half_running', 'Only explicit later upload may accept the goal and resumed clock.');
    checks.push('An open penalty draft survives a clock-resume upload with its captured time; local goal stays invisible to spectators until explicit upload, then actual accepted polling updates a second browser automatically. This is functional loopback evidence, not a network latency benchmark.');
    for (const state of [manager, viewer]) {
      check(state.errors.length === 0 && state.routes.length === 0, 'The actual matchday browsers must have no runtime or transport errors.');
      check(!await state.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), 'The matchday workspace must fit the phone width.');
      await checkStoredCredentials(state.page);
      await safeScreenshot(state.page, state === manager ? 'manager-matchday-390' : 'spectator-matchday-390');
      if (state === manager) await selectedManagerScopeRevocation(state, accounts.find(item => item.role === 'manager'), databasePath);
      await logout(state);
      check(state.errors.length === 0 && state.routes.length === 0, 'Scope revalidation, restored login and final sign-out must have no runtime or transport errors.');
    }
    report.matchday = { viewport: { width: 390, height: 844 }, fixtureId: matchId, selectedPlayers: 9, acceptedLineupPlaces: 7, pausedCheckpoint: { acceptedRevision: paused.acceptedRevision, status: saved.status }, finalCheckpoint: { acceptedRevision: final.acceptedRevision, status: final.state.status, score: final.state.score }, savedMatchReopenedAfterFutureEdits: true, openGoalDraftRetained: true, localGoalWithheldUntilUpload: true, acceptedSpectatorAutoRefresh: true, selectedScopeRevocationClosesDespiteOtherManagerGrant: true, signedOut: true, nativeDeviceEvidence: false, latencyBenchmark: false };
  } catch (error) {
    for (const state of [manager, viewer]) await retainFailureWorkspace(state);
    throw error;
  } finally {
    for (const state of [manager, viewer]) { state.closed = true; state.holdMe?.release(); await state.context.close(); }
  }
}

const watchdog = setTimeout(() => { void browser?.close().catch(() => undefined); for (const child of children) child.kill('SIGTERM'); }, 240000);
watchdog.unref();
try {
  // This directory contains only this runner's generated report and signed-in images.
  // A failed later attempt must never retain successful screenshots from an older run.
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  check(existsSync(path.join(webRoot, 'index.html')) && existsSync(apiBundle) && existsSync(workerBundle), 'Build the flagged dist-demo-web application and API/worker exports before this check.');
  const html = await readFile(path.join(webRoot, 'index.html'), 'utf8');
  const scriptPath = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
  check(scriptPath && !scriptPath.includes('..') && !scriptPath.includes('://'), 'The built web entry must reference its own compiled JavaScript.');
  const scriptBytes = await readFile(path.join(webRoot, scriptPath.replace(/^\//, '')));
  report.source = { gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), workingTreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()), harnessSha256: digest(await readFile(new URL(import.meta.url))), webIndexSha256: digest(html), webJavaScriptSha256: digest(scriptBytes), apiBundleSha256: digest(await readFile(apiBundle)), workerBundleSha256: digest(await readFile(workerBundle)) };
  privateDirectory = await mkdtemp(path.join(tmpdir(), 'longball-demo-account-qa-'));
  const databasePath = path.join(privateDirectory, 'demo.sqlite');
  const accounts = [['manager', 'synthetic-account-manager-2'], ['administrator', 'synthetic-account-admin'], ['player', 'synthetic-account-player-01'], ['spectator', 'synthetic-account-spectator']].map(([role, accountId]) => {
    const passcode = randomBytes(24).toString('base64url'), salt = randomBytes(16).toString('base64url');
    const username = `qa-${randomBytes(5).toString('hex')}.${role}`;
    for (const credential of [username, passcode]) { secrets.add(credential); forbiddenBrowserCredentials.add(credential); }
    return { role, accountId, username, passcode, salt, hash: scryptSync(passcode, Buffer.from(salt, 'base64url'), 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }).toString('hex') };
  });
  for (const account of accounts) check(!scriptBytes.includes(account.passcode) && !scriptBytes.includes(account.username), 'Generated account credentials must not be embedded in compiled assets.');
  const verifierFile = path.join(privateDirectory, 'verifiers.json'), encryptionFile = path.join(privateDirectory, 'export-key');
  await writeFile(verifierFile, JSON.stringify({ version: 1, sessionTtlSeconds: 600, accounts: accounts.map(({ username, accountId, salt, hash }) => ({ username, accountId, salt, hash })) }), { mode: 0o600 });
  const encryptionKey = randomBytes(32).toString('hex'); secrets.add(encryptionKey); forbiddenBrowserCredentials.add(encryptionKey);
  await writeFile(encryptionFile, encryptionKey, { mode: 0o600 });
  const probeToken = `demo_${randomBytes(32).toString('base64url')}`, probeController = randomBytes(32).toString('base64url');
  secrets.add(probeController);
  const redactionProbe = sanitise(JSON.stringify({ headers: { Authorization: `Bearer ${probeToken}`, 'X-Controller-Token': probeController }, passcode: accounts[0].passcode, privateKey: encryptionKey }));
  check(![probeToken, probeController, accounts[0].passcode, encryptionKey].some(secret => redactionProbe.includes(secret)), 'Error redaction must remove generated passwords, opaque headers and private key material.');
  checks.push('Credential/header/key redaction is checked before any diagnostic can be retained.');
  const childEnvironment = { ...process.env };
  for (const key of Object.keys(childEnvironment)) if (key.startsWith('LONGBALL_') || /^PG(?:HOST|PORT|USER|DATABASE|PASSWORD|PASSFILE|SERVICE|SERVICEFILE|SSLMODE)$/.test(key) || ['DATABASE_URL', 'DATABASE_URL_FILE'].includes(key)) delete childEnvironment[key];
  base = `http://127.0.0.1:${await availablePort()}`;
  Object.assign(childEnvironment, { NODE_ENV: 'test', LONGBALL_SYNTHETIC_AUTH: '1', LONGBALL_DEMO_SCENARIO: '1', LONGBALL_DEMO_ACCOUNTS_FILE: verifierFile, LONGBALL_API_HOST: '127.0.0.1', LONGBALL_API_PORT: new URL(base).port, LONGBALL_API_DATABASE: databasePath, LONGBALL_MEDIA_DIRECTORY: path.join(privateDirectory, 'media'), LONGBALL_STATIC_DIRECTORY: webRoot, LONGBALL_API_ORIGINS: base, LONGBALL_OIDC_CONNECT_ORIGINS: `https://raw.githubusercontent.com,${virtualApi}`, LONGBALL_EXPORT_ENCRYPTION_KEY_FILE: encryptionFile, LONGBALL_EXPORT_TTL_MS: '600000', LONGBALL_FICTIONAL_CLOCK_POLICY: JSON.stringify({ id: 'isolated-demo-matchday-clock-v1', serverClockUncertaintyMs: 1000, maximumRoundTripMs: 5000, maximumMappingAgeMs: 3600000, maximumUncertaintyMs: 3000, maximumDriftPpm: 100 }) });
  stage = 'isolated API/worker startup';
  await awaitHealthy(launch(apiBundle, childEnvironment));
  launch(workerBundle, childEnvironment);
  const executablePath = process.env.LONGBALL_CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  for (const width of [390, 320]) for (const account of accounts) {
    stage = `${account.role} ${width}px`;
    const state = await makePage(width), { page } = state;
    try {
      await page.goto(base, { waitUntil: 'networkidle' });
      const welcome = await page.locator('body').innerText();
      check(!welcome.includes('Choose your demo role'), 'The credential-required demo must not expose a role-picker bypass.');
      for (const item of accounts) check(!welcome.includes(item.username) && !welcome.includes(item.passcode), 'Welcome must not publish generated account details.');
      await page.getByTestId('welcome-sign-in').click();
      await page.getByTestId('demo-login-screen').waitFor();
      check(await page.getByTestId('demo-login-submit').isDisabled(), 'Empty credential fields must disable sign-in.');
      await page.getByTestId('demo-username').fill(account.username);
      if (account.role === 'manager' && width === 390) {
        await page.getByTestId('demo-passcode').fill('incorrect-qa-passcode');
        await page.getByTestId('demo-login-submit').click();
        await page.getByText('The username or password is incorrect.', { exact: true }).waitFor();
        check(state.lastLoginStatus === 401 && await page.getByTestId('demo-passcode').inputValue() === '', 'Wrong credentials must be refused generically and clear the passcode.');
        checks.push('Wrong password is refused; empty sign-in stays disabled and the passcode is cleared.');
      }
      if (account.role === 'administrator' && width === 320) {
        changeAccountStatus(databasePath, account.accountId, 'disabled');
        try {
          await page.getByTestId('demo-passcode').fill(account.passcode);
          await page.getByTestId('demo-login-submit').click();
          await page.getByText('Demo sign-in is unavailable. Please try again.', { exact: true }).waitFor();
          check(state.lastLoginStatus === 403 && await page.getByTestId('demo-signed-in').count() === 0, 'A disabled account must not receive a usable workspace.');
        } finally { changeAccountStatus(databasePath, account.accountId, 'active'); }
        checks.push('An independently disabled account is refused despite a correct passcode.');
      }
      await login(state, account);
      const body = await page.locator('body').innerText();
      check(body.includes('Roma U10') && !await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), 'Each assigned phone workspace must load without horizontal overflow.');
      if (account.role === 'manager') {
        const preparation = await currentJson(state.currentSession.accessToken, `/v1/teams/${teamId}/preparation?seasonId=${seasonId}`);
        const matches = await currentJson(state.currentSession.accessToken, `/v1/teams/${teamId}/matches?seasonId=${seasonId}`);
        const statuses = matches.items.map(item => item.status ?? item.state?.status);
        check(preparation.profiles.length === 13 && preparation.fixtures.length === 4 && matches.items.length === 4 && statuses.filter(status => status === 'completed').length === 2 && statuses.filter(status => status === 'preparation').length === 2, 'The fresh demo must contain thirteen profiles, four accepted fixtures, two completed games and two prepared upcoming games.');
        await page.getByRole('tab', { name: 'Team', exact: true }).click();
        await selectedWorkspaceTab(page, 'team');
        await page.getByText('13 active players', { exact: true }).waitFor();
        check(await page.getByRole('button', { name: /^Edit / }).count() === 13, 'Manager Team must show all thirteen editable sample players.');
        await page.getByRole('tab', { name: 'Schedule', exact: true }).click();
        await selectedWorkspaceTab(page, 'schedule');
        await page.getByRole('radio', { name: 'Schedule period: Past', exact: true }).click();
        await page.getByRole('radio', { name: 'Event type: Matches', exact: true }).click();
        await page.getByText('Completed', { exact: true }).first().waitFor();
        check(await page.getByText('Completed', { exact: true }).count() === 2, 'Manager Past must recognise both accepted completed fixtures.');
        if (width === 390) { await checkBackground(state); await exportReports(state); }
      }
      if (account.role === 'player') {
        await page.getByRole('tab', { name: 'Schedule', exact: true }).click();
        await selectedWorkspaceTab(page, 'schedule');
        await page.getByTestId('own-schedule-past').click();
        await page.getByTestId('own-schedule-kind-match').click();
        await page.getByText(/ · Completed$/).first().waitFor();
        check(await page.getByText(/ · Completed$/).count() === 2 && await page.getByRole('button', { name: 'Available', exact: true }).count() === 0, 'Completed player fixtures must remain read-only rather than accepting RSVP changes.');
        if (width === 390) await checkServerDenial(state, account, databasePath);
      }
      if (account.role === 'spectator') {
        await openWorkspaceTab(page, 'centre');
        await selectedWorkspaceTab(page, 'centre');
      }
      check(state.errors.length === 0 && state.routes.length === 0, 'The assigned role journey must not have runtime or transport errors.');
      await checkStoredCredentials(page);
      await safeScreenshot(page, `${account.role}-${width}`);
      if (account.role === 'manager' && width === 390) {
        const release = await coverForSignOut(state);
        try { await logout(state); } finally { release(); }
        checks.push('Top Sign out closes private views and revokes the session while foreground access checking is stalled.');
      } else await logout(state);
      report.roles.push({ role: account.role, width, assignedWorkspace: true, noOverflow: true, signedOut: true, revokedTokenRefused: true, pageErrors: [] });
      if (account.role === 'spectator' && width === 320) {
        await login(state, account);
        const expires = Date.parse(state.currentSession.expiresAt);
        await page.clock.setSystemTime(new Date(expires + 1000));
        await page.clock.runFor(1500);
        await page.getByTestId('demo-login-screen').waitFor({ timeout: 15000 });
        check(await page.getByTestId('demo-signed-in').count() === 0 && await page.getByTestId('demo-passcode').inputValue() === '', 'Client expiry must close private views and return to an empty passcode form.');
        checks.push('Client expiry uses setSystemTime plus a short timer advance and closes private views without replaying hours of intervals.');
      }
    } finally { state.closed = true; state.holdMe?.release(); await state.context.close(); }
  }
  checks.push('All four preauthorised roles pass at 320px and 390px; logout revokes each opaque server session.');
  checks.push('Thirteen named profiles, four accepted fixtures and two completed games agree with manager/player screens.');
  checks.push('Generated passwords and login tokens are absent from built assets, visible workspace text and browser journal/preferences.');
  report.browserCredentialBoundary = { generatedUsernamesPasswordsForbidden: true, demoSessionBearerTokensForbidden: true, serverOnlyExportKeyForbidden: true, allBrowserStoresInspected: true, canonicalControllerGrantIntentionallyRetained: true, allOpaqueHeadersRedactedFromEvidence: true };
  stage = 'administrator retained configuration draft';
  await administratorDraftRegression(accounts.find(account => account.role === 'administrator'));
  stage = 'player retained schedule reply';
  await playerReplyRegression(accounts.find(account => account.role === 'player'));
  stage = 'actual manager matchday and accepted spectator refresh';
  await freshManagerRequestWindow(accounts.find(account => account.role === 'manager').accountId, 'before-manager-matchday');
  await managerMatchday(accounts, databasePath);
  check(!report.httpFailures.some(failure => failure.status === 429 && !failure.controlled), 'The complete review must avoid actual API429 while preserving unchanged account rate limits.');
  report.actualApiRateLimitsRespected = true;
  report.passed = true;
} catch (error) {
  report.failures.push({ stage, name: sanitise(error.name), message: sanitise(error.message) });
  report.failureWorkspaces ??= [];
  for (const state of browserStates.filter(item => !item.closed)) await retainFailureWorkspace(state);
  report.processDiagnostic = sanitise(processDiagnostics);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  for (const state of browserStates) { state.closed = true; state.holdMe?.release(); }
  await browser?.close().catch(() => undefined);
  for (const child of [...children].reverse()) await stop(child);
  if (privateDirectory) await rm(privateDirectory, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'report.json'), sanitise(JSON.stringify(report, null, 2), Infinity) + '\n');
}
console.log(JSON.stringify({ passed: report.passed, roleJourneys: report.roles.length, checks: checks.length, failures: report.failures, report: '.local/quality/demo-account-review/report.json' }));
