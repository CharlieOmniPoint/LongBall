import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';

/** Real built clients/API/worker, isolated generated credentials, and loopback-only transport. */
const output = path.resolve('.local/quality/demo-account-review');
const webRoot = path.resolve('apps/mobile/dist-demo-web');
const apiBundle = path.resolve('apps/api/dist/api.mjs');
const workerBundle = path.resolve('apps/api/dist/worker.mjs');
const virtualApi = 'https://longball-qa-demo.trycloudflare.com';
const statusAddress = 'https://raw.githubusercontent.com/CharlieOmniPoint/LongBall/preview/longball-m0/preview-status.json';
const teamId = 'synthetic-roma-u10', seasonId = 'synthetic-season-2026-27';
const secrets = new Set();
const children = [];
const browserStates = [];
const checks = [];
const report = { scope: 'Built demo-login web application with fresh SQLite API and separate report worker; virtual discovery/API requests rerouted only to loopback.', roles: [], checks, failures: [], passed: false, nativeDeviceEvidence: false, paidServicesProvisioned: false };
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
        return;
      }
    } catch { /* Retry only this newly started loopback process. */ }
    await delay(100);
  }
  throw new Error('The isolated API did not become ready within its bounded startup window.');
}
async function currentJson(token, route, role = 'manager') {
  const response = await fetch(base + route, { headers: { Authorization: `Bearer ${token}`, 'X-Longball-Role': role }, signal: AbortSignal.timeout(10000) });
  check(response.status === 200, 'The current authorised API read must succeed.');
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
async function safeScreenshot(page, name) {
  check(await page.getByTestId('demo-signed-in').count() === 1 && await page.getByTestId('demo-login-screen').count() === 0, 'Retained screenshots must contain only a signed-in workspace.');
  const body = await page.locator('body').innerText();
  for (const secret of secrets) check(!body.includes(secret), 'A signed-in view must not disclose a generated credential.');
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
}
async function makePage(width) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, acceptDownloads: true, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const state = { context, page, errors: [], routes: [], closed: false, currentSession: null, lastLoginStatus: null, meRequests: 0, holdMe: null, meReplyOnce: null };
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
    for (const name of ['authorization', 'x-controller-token', 'x-media-upload-token']) if (headers[name]) secrets.add(headers[name].replace(/^Bearer\s+/i, ''));
    try {
      if (address.pathname === '/v1/me' && request.method() === 'GET') {
        state.meRequests++;
        if (state.holdMe) { state.holdMe.seen(); await state.holdMe.wait; }
        if (state.meReplyOnce) {
          const status = state.meReplyOnce; state.meReplyOnce = null;
          return route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': base, 'Cache-Control': 'private, no-store' }, body: JSON.stringify({ code: 'STORAGE_UNAVAILABLE', message: 'The isolated test service is temporarily unavailable.', retryable: true }) });
        }
      }
      const response = await route.fetch({ url: base + address.pathname + address.search, maxRedirects: 0 });
      if (address.pathname === '/v1/demo/sessions' && request.method() === 'POST') {
        state.lastLoginStatus = response.status();
        if ([200, 201].includes(response.status())) {
          const session = await response.json();
          check(typeof session.accessToken === 'string', 'A successful login must return its opaque session.');
          secrets.add(session.accessToken); state.currentSession = session;
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
  const ready = { manager: 'Next event', administrator: 'View assigned teams', player: 'Your team, Oliver Bennett', spectator: 'Match centre' };
  await page.getByText(ready[account.role], { exact: true }).first().waitFor({ timeout: 20000 });
  check(state.currentSession?.accountId === account.accountId, 'The service must bind the generated account to its preauthorised identity.');
  check(await page.getByTestId('demo-passcode').count() === 0, 'A signed-in workspace must remove the passcode form.');
}
async function logout(state) {
  const { page } = state, token = state.currentSession.accessToken;
  const deleted = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/demo/sessions/current' && response.request().method() === 'DELETE');
  await page.getByTestId('demo-sign-out').click();
  await page.getByTestId('demo-login-screen').waitFor({ timeout: 15000 });
  check((await deleted).status() === 204, 'Sign-out must revoke its current server session.');
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
  for (const secret of secrets) check(!stored.includes(secret), 'The browser journal and preferences must not store demo credentials or login tokens.');
}
async function exportReports(state) {
  const { page } = state, token = state.currentSession.accessToken;
  await page.getByRole('tab', { name: 'Reports', exact: true }).click();
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
    secrets.add(passcode);
    return { role, accountId, username: `qa-${randomBytes(5).toString('hex')}.${role}`, passcode, salt, hash: scryptSync(passcode, Buffer.from(salt, 'base64url'), 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }).toString('hex') };
  });
  for (const account of accounts) check(!scriptBytes.includes(account.passcode) && !scriptBytes.includes(account.username), 'Generated account credentials must not be embedded in compiled assets.');
  const verifierFile = path.join(privateDirectory, 'verifiers.json'), encryptionFile = path.join(privateDirectory, 'export-key');
  await writeFile(verifierFile, JSON.stringify({ version: 1, sessionTtlSeconds: 600, accounts: accounts.map(({ username, accountId, salt, hash }) => ({ username, accountId, salt, hash })) }), { mode: 0o600 });
  const encryptionKey = randomBytes(32).toString('hex'); secrets.add(encryptionKey);
  await writeFile(encryptionFile, encryptionKey, { mode: 0o600 });
  const probeToken = `demo_${randomBytes(32).toString('base64url')}`, probeController = randomBytes(32).toString('base64url');
  secrets.add(probeController);
  const redactionProbe = sanitise(JSON.stringify({ headers: { Authorization: `Bearer ${probeToken}`, 'X-Controller-Token': probeController }, passcode: accounts[0].passcode, privateKey: encryptionKey }));
  check(![probeToken, probeController, accounts[0].passcode, encryptionKey].some(secret => redactionProbe.includes(secret)), 'Error redaction must remove generated passwords, opaque headers and private key material.');
  checks.push('Credential/header/key redaction is checked before any diagnostic can be retained.');
  const childEnvironment = { ...process.env };
  for (const key of Object.keys(childEnvironment)) if (key.startsWith('LONGBALL_') || /^PG(?:HOST|PORT|USER|DATABASE|PASSWORD|PASSFILE|SERVICE|SERVICEFILE|SSLMODE)$/.test(key) || ['DATABASE_URL', 'DATABASE_URL_FILE'].includes(key)) delete childEnvironment[key];
  base = `http://127.0.0.1:${await availablePort()}`;
  Object.assign(childEnvironment, { NODE_ENV: 'test', LONGBALL_SYNTHETIC_AUTH: '1', LONGBALL_DEMO_SCENARIO: '1', LONGBALL_DEMO_ACCOUNTS_FILE: verifierFile, LONGBALL_API_HOST: '127.0.0.1', LONGBALL_API_PORT: new URL(base).port, LONGBALL_API_DATABASE: databasePath, LONGBALL_MEDIA_DIRECTORY: path.join(privateDirectory, 'media'), LONGBALL_STATIC_DIRECTORY: webRoot, LONGBALL_API_ORIGINS: base, LONGBALL_OIDC_CONNECT_ORIGINS: `https://raw.githubusercontent.com,${virtualApi}`, LONGBALL_EXPORT_ENCRYPTION_KEY_FILE: encryptionFile, LONGBALL_EXPORT_TTL_MS: '600000' });
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
        await page.getByText('13 active players', { exact: true }).waitFor();
        check(await page.getByRole('button', { name: /^Edit / }).count() === 13, 'Manager Team must show all thirteen editable sample players.');
        await page.getByRole('tab', { name: 'Schedule', exact: true }).click();
        await page.getByRole('radio', { name: 'Schedule period: Past', exact: true }).click();
        await page.getByRole('radio', { name: 'Event type: Matches', exact: true }).click();
        await page.getByText('Completed', { exact: true }).first().waitFor();
        check(await page.getByText('Completed', { exact: true }).count() === 2, 'Manager Past must recognise both accepted completed fixtures.');
        if (width === 390) { await checkBackground(state); await exportReports(state); await checkStoredCredentials(page); }
      }
      if (account.role === 'player') {
        await page.getByRole('tab', { name: 'Schedule', exact: true }).click();
        await page.getByTestId('own-schedule-past').click();
        await page.getByTestId('own-schedule-kind-match').click();
        await page.getByText(/ · Completed$/).first().waitFor();
        check(await page.getByText(/ · Completed$/).count() === 2 && await page.getByRole('button', { name: 'Available', exact: true }).count() === 0, 'Completed player fixtures must remain read-only rather than accepting RSVP changes.');
        if (width === 390) await checkServerDenial(state, account, databasePath);
      }
      check(state.errors.length === 0 && state.routes.length === 0, 'The assigned role journey must not have runtime or transport errors.');
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
  report.passed = true;
} catch (error) {
  report.failures.push({ stage, name: sanitise(error.name), message: sanitise(error.message) });
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
