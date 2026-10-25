import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomBytes, randomUUID, scryptSync, createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, cp, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { REVIEW_STATUS_REQUEST, openWorkspaceTab, selectWorkspaceContext, reviewDateLabel } from './review-entry.mjs';
import { startPersonaMediaFixture } from './persona-media-fixture.mjs';

const TEAM = 'synthetic-roma-u10', SEASON = 'synthetic-season-2026-27';
const definitions = {
  spectator: ['spectator', 'synthetic-account-spectator'],
  player: ['player', 'synthetic-account-player-01'],
  manager: ['manager', 'synthetic-account-manager-2'],
  club: ['administrator', 'synthetic-account-club-admin'],
  super: ['administrator', 'synthetic-account-admin'],
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = async () => {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
};

/** Own loopback API/worker and generated credentials; never connects to the public demo. */
export async function createPersonaReview({ persona, name = persona, width = 390, height = 844, mediaFixture = false, phase = process.env.LONGBALL_PERSONA_PHASE ?? 'baseline' }) {
  assert(definitions[persona], 'Use an explicit LongBall persona.');
  const output = path.resolve(`.local/quality/persona-${name}-${phase}`);
  if (existsSync(path.join(output, 'report.json'))) await rename(output, `${output}-attempt-${Date.now()}`);
  await mkdir(output, { recursive: true });
  const privateDirectory = await mkdtemp(path.join(tmpdir(), `longball-persona-${name}-`));
  const webSource = path.resolve(process.env.LONGBALL_PERSONA_WEB_ROOT ?? 'apps/mobile/dist-demo-web');
  const webRoot = path.join(privateDirectory, 'web'), backendRoot = path.join(privateDirectory, 'backend');
  await cp(webSource, webRoot, { recursive: true });
  await cp(path.resolve('apps/api/dist'), backendRoot, { recursive: true });
  await symlink(path.resolve('apps/api/node_modules'), path.join(backendRoot, 'node_modules'), 'dir');
  const apiBundle = path.join(backendRoot, 'api.mjs'), workerBundle = path.join(backendRoot, 'worker.mjs');
  assert(existsSync(path.join(webRoot, 'index.html')) && existsSync(apiBundle), 'Build the flagged browser and API first.');
  const html = await readFile(path.join(webRoot, 'index.html'), 'utf8');
  const script = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
  assert(script && !script.includes('..') && !script.includes('://'), 'Use a local compiled client.');
  const scriptPath = path.join(webRoot, script.replace(/^\//, ''));
  const report = {
    persona, phase, startedAt: new Date().toISOString(),
    scope: 'Actual compiled UI and isolated SQLite API/worker; only discovery and virtual transport are redirected to owned loopback processes. Generated accounts, not public demo credentials.',
    checks: [], findings: [], failures: [], httpFailures: [], transportErrors: [], pageErrors: [], screenshots: [], passed: false,
    source: { gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), workingTreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()), webScriptSha256: digest(await readFile(scriptPath)), serverBundleSha256: digest(await readFile(apiBundle)), workerBundleSha256: digest(await readFile(workerBundle)), helperSha256: digest(await readFile(new URL(import.meta.url))) },
    physicalDeviceTested: false, publicCredentialsUsed: false, paidServicesProvisioned: false,
  };
  const secrets = new Set(), children = [], contexts = [], windows = new Map();
  const media = mediaFixture ? await startPersonaMediaFixture() : null;
  if (media) report.mediaFixture = media.boundary;
  const safe = (value, max = 5000) => {
    let text = String(value);
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) if (secret) text = text.replaceAll(secret, '[redacted]');
    return text.replace(/(?:demo|spectator)_[A-Za-z0-9_-]{43}/g, '[redacted-session]').replace(/Bearer\s+[^\s"',;}]+/gi, 'Bearer [redacted]').slice(0, max);
  };
  const accounts = Object.fromEntries(Object.entries(definitions).map(([key, [role, accountId]]) => {
    const username = `qa-${randomBytes(5).toString('hex')}.${key}`, passcode = randomBytes(24).toString('base64url'), salt = randomBytes(16).toString('base64url');
    const hash = scryptSync(passcode, Buffer.from(salt, 'base64url'), 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }).toString('hex');
    for (const value of [username, passcode, salt, hash]) secrets.add(value);
    return [key, { username, passcode, role, accountId, salt, hash }];
  }));
  const verifier = path.join(privateDirectory, 'accounts.json'), keyFile = path.join(privateDirectory, 'export-key');
  await writeFile(verifier, JSON.stringify({ version: 1, sessionTtlSeconds: 3600, accounts: Object.values(accounts).map(({ username, accountId, salt, hash }) => ({ username, accountId, salt, hash })) }), { mode: 0o600 });
  const encryptionKey = randomBytes(32).toString('hex'); secrets.add(encryptionKey); await writeFile(keyFile, encryptionKey, { mode: 0o600 });
  const base = `http://localhost:${await port()}`, virtualApi = 'https://longball-persona-review.trycloudflare.com';
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (key.startsWith('LONGBALL_') || /^PG(?:HOST|PORT|USER|DATABASE|PASSWORD|PASSFILE|SERVICE|SERVICEFILE|SSLMODE)$/.test(key) || ['DATABASE_URL', 'DATABASE_URL_FILE'].includes(key)) delete environment[key];
  Object.assign(environment, { NODE_ENV: 'test', LONGBALL_SYNTHETIC_AUTH: '1', LONGBALL_DEMO_SCENARIO: '1', LONGBALL_DEMO_ACCOUNTS_FILE: verifier, LONGBALL_API_HOST: '127.0.0.1', LONGBALL_API_PORT: new URL(base).port, LONGBALL_API_DATABASE: path.join(privateDirectory, 'review.sqlite'), LONGBALL_MEDIA_DIRECTORY: path.join(privateDirectory, 'media'), LONGBALL_STATIC_DIRECTORY: webRoot, LONGBALL_API_ORIGINS: base, LONGBALL_PUBLIC_APP_ENTRY_URL: base + '/', LONGBALL_INVITATION_POLICY_VERSION: 'persona-review-v1', LONGBALL_OIDC_CONNECT_ORIGINS: `https://raw.githubusercontent.com,${virtualApi}`, LONGBALL_EXPORT_ENCRYPTION_KEY_FILE: keyFile, LONGBALL_EXPORT_TTL_MS: '600000' });
  if (media) Object.assign(environment, media.env);
  let diagnostics = '', browser, closed = false, current;
  const observe = (state, method) => {
    if (!state?.session) return;
    const now = Date.now(), id = state.account.accountId;
    let window = windows.get(id);
    if (!window || now - window.startedAt >= 60_000) { window = { startedAt: now, attempts: 0, mutations: 0 }; windows.set(id, window); }
    window.attempts++; if (method !== 'GET') window.mutations++;
  };
  const launch = file => {
    const child = spawn(process.execPath, [file], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
    const retain = data => { diagnostics = (diagnostics + safe(data.toString())).slice(-5000); };
    child.stdout.on('data', retain); child.stderr.on('data', retain); child.on('error', retain); return child;
  };
  try {
  const apiProcess = launch(apiBundle);
  for (let attempt = 0; ; attempt++) {
    if (apiProcess.exitCode !== null || attempt >= 150) throw new Error('Persona API failed its bounded readiness check: ' + diagnostics);
    try { const response = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) }); if (response.ok) { const h = await response.json(); assert(h.syntheticOnly && h.demoScenario && h.demoAccountLogin); break; } } catch { /* Owned listener readiness only. */ }
    await delay(100);
  }
  launch(workerBundle);
  if (media) {
    const tokens = {};
    for (const role of ['manager', 'player']) {
      const account = accounts[role];
      const response = await fetch(base + '/v1/demo/sessions', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:account.username,passcode:account.passcode}),signal:AbortSignal.timeout(15_000)});
      assert(response.ok, 'The private media setup must authenticate its generated account.');
      const session = await response.json(); assert.equal(session.accountId, account.accountId);
      tokens[role] = session.accessToken; secrets.add(session.accessToken);
    }
    report.mediaSetup = await media.seed(base + '/', {accessTokens:tokens});
    for (const token of Object.values(tokens)) await fetch(base + '/v1/demo/sessions/current', {method:'DELETE',headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10_000)});
  }
  browser = await chromium.launch({ executablePath: process.env.LONGBALL_CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
  } catch (cause) {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.all(children.filter(child => child.exitCode === null).map(child => new Promise(resolve => { child.once('exit', resolve); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000).unref(); })));
    await media?.close();
    await rm(privateDirectory, {recursive:true,force:true});
    throw new Error(safe(cause instanceof Error ? cause.message : cause));
  }
  const makePage = async (accountKey = persona) => {
    const account = accounts[accountKey]; assert(account);
    const context = await browser.newContext({ viewport: { width, height } }); contexts.push(context);
    const page = await context.newPage(); page.setDefaultTimeout(20_000);
    const state = { page, context, accountKey, account, session: null, closed: false };
    page.on('pageerror', error => report.pageErrors.push(safe(error.message)));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === base) return route.continue();
      if (REVIEW_STATUS_REQUEST.test(request.url())) return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': base, 'Cache-Control': 'no-store' }, body: JSON.stringify({ state: 'ready', url: virtualApi, sourceRevision: report.source.gitHead, startedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }) });
      if (url.origin !== virtualApi) return route.abort();
      if (request.headers().authorization) observe(state, request.method());
      try {
        const response = await route.fetch({ url: base + url.pathname + url.search, headers: { ...request.headers(), connection: 'close' }, maxRedirects: 0, maxRetries: 0 });
        if (url.pathname === '/v1/demo/sessions' && request.method() === 'POST' && response.ok()) { state.session = await response.json(); secrets.add(state.session.accessToken); }
        if (response.status() >= 400) { const value = await response.json().catch(() => ({})); report.httpFailures.push({ method: request.method(), path: url.pathname, status: response.status(), code: value.code ?? null, expected: false }); }
        await route.fulfill({ response });
      } catch (error) {
        if (!closed && !state.closed && request.failure()?.errorText !== 'net::ERR_ABORTED') report.transportErrors.push({ path: url.pathname, method: request.method(), error: safe(error.message.split('\n')[0]) });
        await route.abort().catch(() => {});
      }
    });
    return state;
  };
  const login = async (accountKey = persona) => {
    const state = await makePage(accountKey); current = state;
    await state.page.goto(base, { waitUntil: 'networkidle' }); await state.page.getByTestId('welcome-sign-in').click();
    await state.page.getByTestId('demo-username').fill(state.account.username); await state.page.getByTestId('demo-passcode').fill(state.account.passcode); await state.page.getByTestId('demo-login-submit').click();
    await state.page.getByTestId('demo-signed-in').waitFor(); await selectWorkspaceContext(state.page, state.account.role);
    assert.equal(state.session?.accountId, state.account.accountId); return state;
  };
  const api = async (route, { state = current, token = state?.session?.accessToken, role = state?.account.role, body, method = body ? 'POST' : 'GET', expected = 200, key } = {}) => {
    if (token) observe(state, method);
    const response = await fetch(base + route, { method, signal: AbortSignal.timeout(20_000), headers: { ...(token ? { Authorization: `Bearer ${token}`, 'X-Longball-Role': role } : {}), ...(body ? { 'Content-Type': 'application/json', 'X-Api-Contract-Version': 'longball.events/1.1', 'Idempotency-Key': key ?? body.command?.id ?? randomUUID() } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = response.status === 204 ? null : await response.json();
    if (response.status >= 400) report.httpFailures.push({ method, path: new URL(base + route).pathname, status: response.status, code: value?.code ?? null, expected: response.status === expected });
    assert.equal(response.status, expected, `Persona API ${method} ${new URL(base + route).pathname}: ${response.status} ${value?.code ?? ''}`); return value;
  };
  const budget = async (state = current) => {
    const window = windows.get(state.account.accountId);
    if (!window || window.attempts < 65 && window.mutations < 35) return;
    const remaining = Math.max(0, window.startedAt + 61_000 - Date.now());
    (report.budgetWaits ??= []).push({ accountId: state.account.accountId, waitMs: remaining, attempts: window.attempts, mutations: window.mutations });
    if (remaining > 0) await delay(remaining);
  };
  const screenshot = async (label, state = current) => {
    assert(await state.page.getByTestId('demo-signed-in').isVisible(), 'Only retain authenticated persona views.');
    const body = await state.page.locator('body').innerText(); for (const secret of secrets) assert(!body.includes(secret), 'Do not screenshot credentials or invitation capabilities.');
    const filename = label.replace(/[^A-Za-z0-9_-]/g, '-') + '.png'; await state.page.screenshot({ path: path.join(output, filename), animations: 'disabled' }); report.screenshots.push(filename);
  };
  const finish = async ({ passed = true, error } = {}) => {
    if (closed) return; closed = true;
    if (error) report.failures.push(safe(error.stack ?? error));
    report.artifactsStable = digest(await readFile(apiBundle)) === report.source.serverBundleSha256 && digest(await readFile(workerBundle)) === report.source.workerBundleSha256 && digest(await readFile(scriptPath)) === report.source.webScriptSha256 && digest(await readFile(new URL(import.meta.url))) === report.source.helperSha256;
    report.passed = passed && !error && report.artifactsStable && report.pageErrors.length === 0 && report.transportErrors.length === 0 && report.httpFailures.every(item => item.expected);
    report.finishedAt = new Date().toISOString(); await writeFile(path.join(output, 'report.json'), safe(JSON.stringify(report, null, 2), Infinity) + '\n');
    for (const state of contexts) await state.close().catch(() => {}); await browser?.close();
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.all(children.filter(child => child.exitCode === null).map(child => new Promise(resolve => { child.once('exit', resolve); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000).unref(); })));
    await media?.close();
    await rm(privateDirectory, { recursive: true, force: true });
    return report;
  };
  const addSecret = value => { assert(typeof value === 'string' && value.length > 0 && value.length <= 4096); secrets.add(value); };
  return { persona, report, output, base, virtualApi, accounts, login, makePage, api, budget, screenshot, finish, safe, addSecret, delay, check: assert, teamId: TEAM, seasonId: SEASON, scope: leaf => `/v1/teams/${TEAM}/${leaf}?seasonId=${SEASON}`, openTab: (state, tab) => openWorkspaceTab(state.page, tab), selectWorkspaceContext, reviewDateLabel };
}
