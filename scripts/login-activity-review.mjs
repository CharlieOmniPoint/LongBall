import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { REVIEW_STATUS_REQUEST, openWorkspaceTab, selectWorkspaceContext } from './review-entry.mjs';

/** Real generated sign-ins against owned loopback processes; no public account credentials. */
const output = path.resolve('.local/quality/login-activity-review');
const webRoot = path.resolve(process.env.LONGBALL_LOGIN_ACTIVITY_WEB_ROOT ?? 'apps/mobile/dist-demo-web');
const apiBundle = path.resolve('apps/api/dist/api.mjs');
const virtualApi = 'https://longball-login-activity-qa.trycloudflare.com';
const endpoint = '/v1/administration/login-analytics';
const contract = 'longball.events/1.1';
const romaTeam = 'synthetic-roma-u10';
const secrets = new Set(), states = [], children = [], windows = new Map(), tokenAccounts = new Map();
const report = {
  startedAt: new Date().toISOString(),
  scope: 'Compiled native-shared browser UI and real isolated SQLite API. Actual credential verification, sign-in, rejected sign-in and logout requests create the report history; no historic login rows are seeded.',
  transportBridge: { connectionHeader: 'close', retries: 0, scope: 'Only pinned discovery and virtual API transport are redirected to owned loopback connections; production TCP pooling is not certified.' },
  checks: [], failures: [], httpFailures: [], transportErrors: [], browserCancellations: [], apiWindows: [], accountBudgetPauses: [], loginBudgetPauses: [],
  passed: false, nativeHardwareTested: false, publicCredentialsUsed: false, paidServicesProvisioned: false,
};
let browser, privateDirectory, base, environment, apiProcess, stage = 'preconditions', processDiagnostics = '';
let loginWindow = { began: 0, attempts: 0 }, knownSignIns = 0;
const check = (value, message) => assert(value, message);
const digest = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function safe(value, limit = 5000) {
  let text = String(value);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) if (secret) text = text.replaceAll(secret, '[redacted]');
  return text.replace(/(?:demo|spectator)_[A-Za-z0-9_-]{43}/g, '[redacted-session]').replace(/Bearer\s+[^\s"',;}]+/gi, 'Bearer [redacted]').slice(0, limit);
}
function observe(token, method) {
  const accountId = tokenAccounts.get(token); if (!accountId) return;
  const now = Date.now(); let window = windows.get(accountId);
  if (!window || now - window.startedAtMs >= 60_000) { window = { accountId, startedAtMs: now, attempts: 0, mutations: 0 }; windows.set(accountId, window); report.apiWindows.push(window); }
  window.attempts++; if (method !== 'GET') window.mutations++;
}
async function accountBudget(accountId, phase) {
  const window = windows.get(accountId);
  if (!window || window.attempts < 65 && window.mutations < 35) return;
  const waitMs = Math.max(0, window.startedAtMs + 61_000 - Date.now());
  report.accountBudgetPauses.push({ phase, accountId, waitMs, observedAttempts: window.attempts, observedMutations: window.mutations, retries: 0 });
  console.log(JSON.stringify({ phase, accountBudgetPauseMs: waitMs }));
  const until = Date.now() + waitMs;
  while (Date.now() < until) await delay(Math.min(1000, until - Date.now()));
}
async function loginBudget() {
  const now = Date.now();
  if (!loginWindow.began || now - loginWindow.began >= 60_000) loginWindow = { began: now, attempts: 0 };
  if (loginWindow.attempts >= 18) {
    const waitMs = Math.max(0, loginWindow.began + 61_000 - now);
    report.loginBudgetPauses.push({ waitMs, observedAttempts: loginWindow.attempts, actualLimitPerMinute: 20, retries: 0 });
    console.log(JSON.stringify({ loginBudgetPauseMs: waitMs, actualLimitPerMinute: 20 }));
    const until = now + waitMs; while (Date.now() < until) await delay(Math.min(1000, until - Date.now()));
    loginWindow = { began: Date.now(), attempts: 0 };
  }
  loginWindow.attempts++;
}
function launch() {
  const child = spawn(process.execPath, [apiBundle], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
  const retain = value => { processDiagnostics = (processDiagnostics + safe(value.toString())).slice(-5000); };
  child.stdout.on('data', retain); child.stderr.on('data', retain); child.on('error', retain); return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM'); for (let attempt = 0; attempt < 50 && child.exitCode === null && child.signalCode === null; attempt++) await delay(100);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
async function availablePort() {
  const server = createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function healthy(child) {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('The owned API stopped before readiness.');
    try { const response = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) }); if (response.ok) { const value = await response.json(); check(value.syntheticOnly && value.demoScenario && value.demoAccountLogin, 'Use the explicitly isolated configured-account API.'); return; } } catch { /* Retry readiness only for the newly created loopback process. */ }
    await delay(100);
  }
  throw new Error('The owned API did not become ready within thirty seconds.');
}
async function api(token, route, { role = 'administrator', body, method = body ? 'POST' : 'GET', expected = 200 } = {}) {
  if (route === '/v1/demo/sessions' && method === 'POST') await loginBudget();
  observe(token, method);
  const response = await fetch(base + route, { method, signal: AbortSignal.timeout(20_000), headers: {
    ...(token ? { Authorization: `Bearer ${token}`, 'X-Longball-Role': role } : {}),
    ...(body ? { 'Content-Type': 'application/json', 'X-Api-Contract-Version': contract, 'Idempotency-Key': randomUUID() } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = response.status === 204 ? null : await response.json();
  const accepted = Array.isArray(expected) ? expected.includes(response.status) : response.status === expected;
  if (response.status >= 400) report.httpFailures.push({ stage, method, path: new URL(base + route).pathname, status: response.status, code: value?.code ?? null, expected: accepted });
  check(accepted, `API ${method} ${new URL(base + route).pathname} returned ${response.status}, expected ${expected}.`);
  return value;
}
async function signIn(account) {
  const value = await api(null, '/v1/demo/sessions', { body: { username: account.username, passcode: account.passcode } });
  secrets.add(value.accessToken); tokenAccounts.set(value.accessToken, value.accountId); knownSignIns++;
  check(value.accountId === account.accountId, 'A real configured login must resolve the intended account.'); return value;
}
async function signOut(session) { await api(session.accessToken, '/v1/demo/sessions/current', { method: 'DELETE', expected: 204 }); }

async function makePage(width) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
  const page = await context.newPage(), state = { page, context, session: null, closed: false, pageErrors: [], reactKeyWarnings: 0, analyticsReads: 0 }; states.push(state);
  page.setDefaultTimeout(25_000);
  page.on('pageerror', error => state.pageErrors.push(safe(error.message)));
  page.on('console', message => {
    if (['error', 'warning'].includes(message.type()) && /Encountered two children with the same key|Each child in a list should have a unique ["']?key["']?/i.test(message.text())) { state.reactKeyWarnings++; state.pageErrors.push('React reported duplicate or missing component keys.'); }
  });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === base) return route.continue();
    if (REVIEW_STATUS_REQUEST.test(request.url())) return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': base, 'Cache-Control': 'no-store' }, body: JSON.stringify({ state: 'ready', url: virtualApi, sourceRevision: report.source.gitHead, startedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }) });
    if (url.origin !== virtualApi) return route.abort();
    if (url.pathname === endpoint && request.method() === 'GET') state.analyticsReads++;
    if (url.pathname === '/v1/demo/sessions' && request.method() === 'POST') await loginBudget();
    const token = request.headers().authorization?.replace(/^Bearer\s+/i, ''); if (token) secrets.add(token); observe(token, request.method());
    try {
      const response = await route.fetch({ url: base + url.pathname + url.search, headers: { ...request.headers(), connection: 'close' }, maxRedirects: 0, maxRetries: 0 });
      if (url.pathname === '/v1/demo/sessions' && request.method() === 'POST' && response.ok()) { const session = await response.json(); secrets.add(session.accessToken); tokenAccounts.set(session.accessToken, session.accountId); state.session = session; knownSignIns++; }
      if (response.status() >= 400) { const value = await response.json().catch(() => ({})); report.httpFailures.push({ stage, method: request.method(), path: url.pathname, status: response.status(), code: value.code ?? null, fromBrowser: true }); }
      await route.fulfill({ response });
    } catch (error) {
      const failure = request.failure()?.errorText ?? null;
      if (failure === 'net::ERR_ABORTED') report.browserCancellations.push({ stage, method: request.method(), path: url.pathname, failure });
      else if (!state.closed && !/closed|disposed|abort|cancel/i.test(String(error.message))) { report.transportErrors.push({ stage, method: request.method(), path: url.pathname, failure, error: safe(error.message.split('\n')[0]) }); state.pageErrors.push(safe(error.message)); }
      await route.abort().catch(() => {});
    }
  });
  return state;
}
async function openAccount(account, width = 390) {
  const state = await makePage(width), { page } = state;
  await page.goto(base, { waitUntil: 'networkidle' }); await page.getByTestId('welcome-sign-in').click();
  await page.getByTestId('demo-username').fill(account.username); await page.getByTestId('demo-passcode').fill(account.passcode); await page.getByTestId('demo-login-submit').click();
  await page.getByTestId('demo-signed-in').waitFor(); await selectWorkspaceContext(page, account.role);
  check(state.session?.accountId === account.accountId, 'The UI login must bind its real assigned identity.'); return state;
}
async function closePage(state) { state.closed = true; await state.context.close(); }
async function reauthenticate(state, account) {
  const { page } = state, previous = state.session.accessToken;
  const closing = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/demo/sessions/current' && response.request().method() === 'DELETE');
  await page.getByTestId('demo-sign-out').click(); check((await closing).status() === 204, 'A normal UI sign-out must close the old Super Admin session.');
  await page.getByTestId('demo-username').waitFor();
  await page.getByTestId('demo-username').fill(account.username); await page.getByTestId('demo-passcode').fill(account.passcode); await page.getByTestId('demo-login-submit').click();
  await page.getByTestId('demo-signed-in').waitFor(); await selectWorkspaceContext(page, account.role);
  check(state.session.accessToken !== previous && state.session.accountId === account.accountId, 'An explicit fresh sign-in must replace the old session after normal credential verification.');
  await dashboard(state);
  report.checks.push('A real UI sign-out and fresh Super Admin sign-in occur between completed phases; session revocation, credential verification and all role checks remain required.');
}
async function screenshot(state, name) {
  check(await state.page.getByTestId('demo-signed-in').isVisible(), 'Only authenticated workspace views may be photographed.');
  const body = await state.page.locator('body').innerText(); for (const secret of secrets) check(!body.includes(secret), 'The dashboard must not reveal generated credentials or capabilities.');
  await state.page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
}
async function overviewScreenshot(state, suffix) {
  const { page } = state;
  await page.getByTestId('login-activity-view-overview').click(); await page.getByTestId('login-activity-trend').waitFor();
  if (await page.getByTestId('login-activity-filters-toggle').getAttribute('aria-expanded') === 'true') await page.getByTestId('login-activity-filters-toggle').click();
  await page.getByTestId('workspace-content-scroll').evaluate(node => { node.scrollTop = 0; });
  await page.evaluate(() => window.scrollTo(0, 0));
  await noOverflow(page); await screenshot(state, `super-admin-activity-${suffix}`);
}
async function scrollPanelTop(page, testId) {
  await page.evaluate(id => {
    const scroll = document.querySelector('[data-testid="workspace-content-scroll"]'), panel = document.querySelector(`[data-testid="${id}"]`);
    if (!scroll || !panel) throw new Error('The actual workspace panel is unavailable.');
    scroll.scrollTop += panel.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
  }, testId);
}
async function dashboard(state) {
  await openWorkspaceTab(state.page, 'clubs'); await state.page.getByTestId('workspace-tab-loginActivity').click();
  await state.page.getByTestId('login-activity-dashboard').waitFor(); await state.page.getByTestId('login-activity-summary').waitFor();
}
async function reportRead(state, action, predicate = () => true, timeout = 25_000) {
  const pending = state.page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === 'GET' && predicate(new URL(response.url())), { timeout });
  await action(); const response = await pending; check(response.status() === 200, 'The dashboard must load an actual authorised analytics response.'); return response.json();
}
async function noOverflow(page) { check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'The responsive dashboard must fit without horizontal page scrolling.'); }

async function historyAndPermissions(accounts) {
  await api(null, endpoint + '?range=7d', { expected: 401 });
  const superState = await openAccount(accounts.super, 1024);
  await dashboard(superState);
  const first = await api(superState.session.accessToken, endpoint + '?range=7d');
  check(first.kind === 'login-analytics' && first.summary.signIns === 1 && first.summary.uniqueAccounts === 1, 'A fresh report starts with its one real Super Admin sign-in, without seeded historic activity.');
  check(first.coverage.startedAt !== null && first.coverage.activityWindowMinutes === 15 && first.coverage.pollingIncluded === true && first.coverage.upstreamProviderFailuresIncluded === false, 'The report must expose its truthful observation window and provider boundaries.');
  report.checks.push('A fresh database reports one actual sign-in and explicit reporting/active-account coverage, without invented historic events.');

  const actorStates = {};
  for (const name of ['club', 'manager', 'player', 'spectator']) {
    const state = await openAccount(accounts[name]); actorStates[name] = state;
    check(await state.page.getByTestId('workspace-tab-loginActivity').count() === 0, 'Other roles must not have a Super Admin analytics entry point.');
    const denied = await api(state.session.accessToken, endpoint + '?range=7d', { role: accounts[name].role, expected: [403, 404] });
    check(denied.kind !== 'login-analytics' && !Object.hasOwn(denied, 'events') && !Object.hasOwn(denied, 'summary'), 'An unauthorised role must receive no analytics rows or summary.');
  }
  const wrong = randomBytes(24).toString('base64url'); secrets.add(wrong);
  await api(null, '/v1/demo/sessions', { body: { username: accounts.player.username, passcode: wrong }, expected: 401 });
  const current = await api(superState.session.accessToken, endpoint + '?range=7d');
  check(current.summary.signIns === knownSignIns && current.summary.uniqueAccounts === 5 && current.summary.activeAccounts === 5, 'Real five-role sign-ins and authenticated requests produce truthful unique and recently active account counts.');
  check(current.summary.failedAttempts === 1, 'Exactly the real rejected credential check is counted.');
  const failed = current.events.find(event => event.type === 'login_failure');
  check(failed && failed.accountId === null && failed.actorLabel === null && failed.role === null && failed.scopes.length === 0, 'Rejected credentials must not expose the submitted identity or guess a club/team.');
  report.checks.push('All five real account types contribute activity; Club Admin/Manager/Player/Spectator have no entry point or API data; rejected credentials stay unattributed.');
  return { superState, actorStates };
}

async function multiClubScope(superState, spectatorState, accounts) {
  const token = superState.session.accessToken;
  let directory = await api(token, '/v1/administration', { body: { command: { type: 'club.create', name: 'Harbour Access Review' } } });
  const club = directory.clubs.find(item => item.name === 'Harbour Access Review'); check(club, 'Create the second club through the actual Super Admin command.');
  directory = await api(token, '/v1/administration', { body: { command: { type: 'team.create', clubId: club.id, name: 'Harbour Comets', ageGroup: 'U12', format: 9, seasonStartYear: 2026 } } });
  const team = directory.teams.find(item => item.name === 'Harbour Comets'); check(team?.clubId === club.id, 'The second team must belong to its actual club.');
  const invitation = await api(token, `/v1/teams/${team.id}/spectator-invites`, { role: 'manager', body: { seasonId: team.seasonId, expiresInHours: 1 }, expected: 201 });
  secrets.add(invitation.shareUrl); const code = new URLSearchParams(new URL(invitation.shareUrl).hash.slice(1)).get('code'); check(code, 'The canonical invitation must contain a capability.'); secrets.add(code);
  await api(spectatorState.session.accessToken, '/v1/spectator-invites/accept', { role: 'spectator', body: { token: code } });
  const second = await signIn(accounts.spectator); await api(second.accessToken, '/v1/me', { role: 'spectator' }); await signOut(second);
  const data = await api(token, endpoint + '?range=7d');
  check(data.summary.uniqueAccounts === 5, 'An account with several team grants remains one global account.');
  const spectral = data.events.find(event => event.type === 'login_success' && event.accountId === accounts.spectator.accountId && event.scopes.some(scope => scope.teamId === team.id));
  check(spectral?.scopes.some(scope => scope.teamId === romaTeam), 'The second actual login snapshots both permitted teams.');
  const spectatorOnly = await api(token, endpoint + '?range=7d&role=spectator');
  check(spectatorOnly.summary.uniqueAccounts === 1 && spectatorOnly.teams.reduce((sum, row) => sum + row.uniqueAccounts, 0) > 1, 'The same Spectator counts once globally and in both permitted team groups; team groups are not additive.');
  const scoped = await api(token, endpoint + `?range=7d&clubId=${club.id}&teamId=${team.id}`);
  check(scoped.events.every(event => event.scopes.some(scope => scope.clubId === club.id && scope.teamId === team.id)) && scoped.summary.failedAttempts === 0, 'Club/team filters use verified access snapshots and exclude unattributed failures.');
  report.checks.push('Real club/team creation and invitation acceptance prove event-time access scope, multi-team non-additivity and safe exclusion of unattributed failures.');
  return { club, team };
}

async function createPagedHistory(accounts) {
  for (let index = 0; index < 25; index++) { const session = await signIn(accounts.player); await signOut(session); }
  report.actualHistoryGeneration = { signInLogoutPairs: 25, seededRows: 0, loginLimitsChanged: false, backdatedEvents: false };
}

async function uiFiltersAndPagination(state, created, accounts) {
  const { page } = state;
  await accountBudget(state.session.accountId, 'before-dashboard-filters');
  let data = await reportRead(state, () => page.getByTestId('login-activity-refresh').click());
  check(data.summary.signIns === knownSignIns && data.summary.uniqueAccounts === 5, 'Dashboard refresh must use the real sign-in history without counting repeated sessions as new accounts.');
  check(await page.getByTestId('login-activity-summary').evaluate(node => getComputedStyle(node).backgroundColor) === 'rgb(84, 40, 121)', 'The Super Admin report masthead must use its purple visual theme.');
  await overviewScreenshot(state, '1024');
  await scrollPanelTop(page, 'login-activity-trend'); await screenshot(state, 'super-admin-trend-1024');
  await page.getByTestId('login-activity-view-users').click(); await page.getByTestId('login-activity-users').waitFor();
  check(data.activeUsers.length === 5, 'The five recently observed accounts must appear in the active-account report.');
  for (const account of data.activeUsers) check(await page.getByTestId(`login-activity-user-${account.accountId}`).count() === 1, 'The active-account view must render each account once, including a shared household account.');
  await page.getByTestId('login-activity-view-overview').click();
  await page.getByTestId('login-activity-filters-toggle').click();
  await page.getByTestId('login-activity-club').click();
  data = await reportRead(state, () => page.getByRole('button', { name: `Choose club ${created.club.name}`, exact: true }).click(), url => url.searchParams.get('clubId') === created.club.id);
  check(data.filters.clubId === created.club.id && data.summary.failedAttempts === 0, 'The club picker must request the selected real scope.');
  await page.getByTestId('login-activity-team').click();
  data = await reportRead(state, () => page.getByRole('button', { name: `Choose team ${created.team.name} · ${created.team.ageGroup}`, exact: true }).click(), url => url.searchParams.get('teamId') === created.team.id);
  check(data.filters.teamId === created.team.id, 'The team picker must preserve the selected club.');
  await page.getByTestId('login-activity-club').click();
  data = await reportRead(state, () => page.getByRole('button', { name: 'Choose club All clubs', exact: true }).click(), url => !url.searchParams.has('clubId'));
  check(!data.filters.teamId, 'Changing a club clears an incompatible team filter.');
  data = await reportRead(state, () => page.getByTestId('login-activity-range-24h').click(), url => url.searchParams.get('range') === '24h'); check(data.filters.range === '24h', 'The 24-hour range must be sent to the service.');
  data = await reportRead(state, () => page.getByTestId('login-activity-role-player').click(), url => url.searchParams.get('role') === 'player'); check(data.events.every(event => event.role === 'player'), 'The Player filter must request only Player event rows.');
  data = await reportRead(state, () => page.getByTestId('login-activity-event-logout').click(), url => url.searchParams.get('event') === 'logout'); check(data.events.every(event => event.type === 'logout'), 'The outcome filter must request actual logout rows.');
  data = await reportRead(state, () => page.getByTestId('login-activity-role-all').click(), url => !url.searchParams.has('role'));
  data = await reportRead(state, () => page.getByTestId('login-activity-event-all').click(), url => !url.searchParams.has('event'));
  await page.getByTestId('login-activity-view-events').click();
  const firstIds = data.events.map(event => event.id); check(firstIds.length === 50 && data.page.nextCursor, 'Real generated authentication history must exercise the bounded fifty-row page.');
  const later = await signIn(accounts.player); await signOut(later);
  const next = await reportRead(state, () => page.getByTestId('login-activity-load-more').click(), url => url.searchParams.has('cursor'));
  check(next.events.length > 0 && next.events.every(event => !firstIds.includes(event.id)), 'History continuation must not duplicate rows when newer real events arrive.');
  check(next.eventAsOf === data.eventAsOf && next.summary.signIns === data.summary.signIns, 'Continuation must retain the original event cutoff and summary while newer real sign-ins remain outside that frozen page selection.');
  await page.getByTestId(`login-activity-event-${next.events.at(-1).id}`).waitFor();
  for (const id of [...firstIds, ...next.events.map(event => event.id)]) check(await page.getByTestId(`login-activity-event-${id}`).count() === 1, 'The rendered history must retain every loaded row exactly once after pagination.');
  stage = 'pagination: expanded event history pauses automatic refresh';
  check(/paused/i.test(await page.getByTestId('login-activity-refresh-mode').innerText()), 'Browsing more than fifty events must explicitly explain the automatic-refresh pause.');
  const expandedReads = state.analyticsReads, browsingBegan = Date.now(), browsingUntil = browsingBegan + 61_000;
  while (Date.now() < browsingUntil) await delay(Math.min(1000, browsingUntil - Date.now()));
  check(state.analyticsReads === expandedReads, 'Automatic updates must not silently replace an expanded event history.');
  for (const id of [...firstIds, ...next.events.map(event => event.id)]) check(await page.getByTestId(`login-activity-event-${id}`).count() === 1, 'Every loaded history row must remain after an actual minute of browsing.');
  report.historyBrowsing = { actualPausedMs: Date.now() - browsingBegan, automaticRequestsWhileExpanded: state.analyticsReads - expandedReads, loadedRowsPreserved: firstIds.length + next.events.length, clocksMocked: false };
  stage = 'pagination: manual refresh resets to current events and resumes automatic updates';
  data = await reportRead(state, () => page.getByTestId('login-activity-refresh').click());
  check(data.events.length === 50 && data.summary.signIns === knownSignIns, 'Explicit manual refresh must return the current first page and current real sign-in count.');
  check(!/paused/i.test(await page.getByTestId('login-activity-refresh-mode').innerText()), 'The automatic-refresh pause must clear after manual first-page refresh.');
  const resumedReads = state.analyticsReads, resumedAt = Date.now();
  const resumed = await reportRead(state, async () => {}, () => true, 75_000);
  check(state.analyticsReads > resumedReads && resumed.events.length === 50, 'Automatic one-minute updates must resume while the Events view has only its first page.');
  report.historyBrowsing.resumedAutomaticAfterMs = Date.now() - resumedAt; report.historyBrowsing.resumeWaitBoundMs = 75_000;
  report.checks.push('Actual dashboard controls request club/team/range/role/outcome filters, reset incompatible teams, and page real history without duplicates when new events arrive.');
  report.checks.push('An actual minute of expanded-history browsing retains every row with automatic updates explicitly paused; manual first-page refresh resumes the actual one-minute timer.');
  await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page); await scrollPanelTop(page, 'login-activity-events'); await screenshot(state, 'super-admin-events-390');
  await overviewScreenshot(state, '390');
  await page.setViewportSize({ width: 320, height: 844 }); await overviewScreenshot(state, '320');
  check(await page.getByTestId('login-activity-trend').getByRole('img').getAttribute('aria-label'), 'The actual SVG trend needs an accessible summary.');
  report.checks.push('Phone320/390 and tablet1024 layouts fit without horizontal overflow and the actual trend exposes an accessible text summary.');
}

async function refreshAndForeground(state) {
  const { page } = state;
  report.lifecycle = { clockScope: 'Actual browser/server clocks; no widget timers or Date values are mocked.', visibilityScope: 'Controlled document visibility events exercise the browser/app lifecycle; actual OS background execution is not established.', milestones: [] };
  await accountBudget(state.session.accountId, 'before-dashboard-foreground-revalidation');
  stage = 'lifecycle: initial actual manual report';
  const initial = await reportRead(state, () => page.getByTestId('login-activity-refresh').click());
  report.lifecycle.milestones.push({ step: 'manual-report', observedAt: initial.observedAt, reads: state.analyticsReads });
  const receipt = await page.getByTestId('login-activity-last-checked').innerText();
  let rejected = false;
  await page.route('**/v1/administration/login-analytics?*', async route => {
    if (rejected || route.request().method() !== 'GET') return route.fallback();
    rejected = true;
    report.httpFailures.push({ stage, method: 'GET', path: endpoint, status: 503, code: 'CONTROLLED_LOGIN_REPORT_UNAVAILABLE', expected: true, controlledFault: true });
    await route.fulfill({ status: 503, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': base, 'Cache-Control': 'private, no-store' }, body: JSON.stringify({ code: 'CONTROLLED_LOGIN_REPORT_UNAVAILABLE', message: 'The test connection is temporarily unavailable.' }) });
  });
  stage = 'lifecycle: controlled failed refresh and retained receipt';
  await page.getByTestId('login-activity-refresh').click();
  await page.getByText(/The last successful report remains visible\./).waitFor();
  check((await page.getByTestId('login-activity-last-checked').innerText()).replace(' · Refresh delayed', '') === receipt, 'A failed refresh must retain the previous successful receipt.');
  report.lifecycle.milestones.push({ step: 'failed-refresh-retained-receipt', reads: state.analyticsReads });
  await page.unroute('**/v1/administration/login-analytics?*');
  stage = 'lifecycle: actual manual recovery';
  const recovered = await reportRead(state, () => page.getByTestId('login-activity-refresh').click());
  check(recovered.observedAt >= initial.observedAt && recovered.summary.signIns === knownSignIns, 'Manual recovery must load the current real report.');
  report.lifecycle.milestones.push({ step: 'manual-recovery', observedAt: recovered.observedAt, reads: state.analyticsReads });
  stage = 'lifecycle: actual hidden minute without report requests';
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await delay(100);
  const pausedAt = state.analyticsReads;
  const hiddenBegan = Date.now(), hiddenUntil = hiddenBegan + 61_000;
  while (Date.now() < hiddenUntil) await delay(Math.min(1000, hiddenUntil - Date.now()));
  check(state.analyticsReads === pausedAt, 'A hidden dashboard must not continue its one-minute analytics polling.');
  report.lifecycle.milestones.push({ step: 'hidden-polling-paused', elapsedMs: Date.now() - hiddenBegan, reads: state.analyticsReads });
  stage = 'lifecycle: verified foreground return refresh';
  await reportRead(state, () => page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); }));
  check(state.analyticsReads > pausedAt, 'Returning to a visible validated account must refresh the report.');
  report.lifecycle.milestones.push({ step: 'foreground-refreshed', reads: state.analyticsReads });
  report.checks.push('A controlled503 retains the successful report/receipt, manual and one-minute automatic refresh succeed, hidden views stop polling and foreground return refreshes the current authorised scope.');
}

async function restartPersistence(superState, accounts, baseline) {
  for (const state of states.filter(item => !item.closed)) await closePage(state);
  await stop(apiProcess); apiProcess = launch(); await healthy(apiProcess);
  const next = await signIn(accounts.super), after = await api(next.accessToken, endpoint + '?range=7d');
  check(after.summary.signIns === baseline.summary.signIns + 1 && after.coverage.startedAt === baseline.coverage.startedAt, 'Same-database restart must retain the real history and original reporting start.');
  check(after.summary.activeSessions === 1, 'Old local process sessions must not be presented as active after a restart.');
  await api(superState.session.accessToken, '/v1/me', { expected: 401 });
  await signOut(next);
  report.checks.push('Same-database process restart preserves login history while old in-memory login tokens and active local sessions do not survive.');
}

const watchdog = setTimeout(() => { console.error('The isolated login-activity review exceeded its seven-minute watchdog.'); process.exit(124); }, 420_000); watchdog.unref();
try {
  await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true });
  check(existsSync(path.join(webRoot, 'index.html')) && existsSync(apiBundle), 'Build the flagged demo web client and API before the login-activity review.');
  const html = await readFile(path.join(webRoot, 'index.html'), 'utf8'), entry = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
  check(entry && !entry.includes('..') && !entry.includes('://'), 'Use the local compiled client entry.');
  const scriptPath = path.join(webRoot, entry.replace(/^\//, ''));
  report.source = { gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), workingTreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()), harnessSha256: digest(await readFile(new URL(import.meta.url))), webIndexSha256: digest(html), webJavaScriptSha256: digest(await readFile(scriptPath)), apiBundleSha256: digest(await readFile(apiBundle)) };
  privateDirectory = await mkdtemp(path.join(tmpdir(), 'longball-login-activity-'));
  const specs = [['super', 'administrator', 'synthetic-account-admin'], ['club', 'administrator', 'synthetic-account-club-admin'], ['manager', 'manager', 'synthetic-account-manager-2'], ['player', 'player', 'synthetic-account-player-01'], ['spectator', 'spectator', 'synthetic-account-spectator']];
  const accounts = Object.fromEntries(specs.map(([name, role, accountId]) => { const username = `qa-${randomBytes(5).toString('hex')}.${name}`, passcode = randomBytes(24).toString('base64url'), salt = randomBytes(16).toString('base64url'); secrets.add(username); secrets.add(passcode); return [name, { username, passcode, role, accountId, salt, hash: scryptSync(passcode, Buffer.from(salt, 'base64url'), 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }).toString('hex') }]; }));
  for (const account of Object.values(accounts)) { secrets.add(account.salt); secrets.add(account.hash); }
  const verifier = path.join(privateDirectory, 'accounts.json'), key = path.join(privateDirectory, 'export-key');
  await writeFile(verifier, JSON.stringify({ version: 1, sessionTtlSeconds: 1800, accounts: Object.values(accounts).map(({ username, accountId, salt, hash }) => ({ username, accountId, salt, hash })) }), { mode: 0o600 });
  const exportKey = randomBytes(32).toString('hex'); secrets.add(exportKey); await writeFile(key, exportKey, { mode: 0o600 });
  base = `http://localhost:${await availablePort()}`; environment = { ...process.env };
  for (const name of Object.keys(environment)) if (name.startsWith('LONGBALL_') || /^PG(?:HOST|PORT|USER|DATABASE|PASSWORD|PASSFILE|SERVICE|SERVICEFILE|SSLMODE)$/.test(name) || ['DATABASE_URL', 'DATABASE_URL_FILE'].includes(name)) delete environment[name];
  Object.assign(environment, { NODE_ENV: 'test', LONGBALL_SYNTHETIC_AUTH: '1', LONGBALL_DEMO_SCENARIO: '1', LONGBALL_DEMO_ACCOUNTS_FILE: verifier, LONGBALL_API_HOST: '127.0.0.1', LONGBALL_API_PORT: new URL(base).port, LONGBALL_API_DATABASE: path.join(privateDirectory, 'review.sqlite'), LONGBALL_MEDIA_DIRECTORY: path.join(privateDirectory, 'media'), LONGBALL_STATIC_DIRECTORY: webRoot, LONGBALL_API_ORIGINS: base, LONGBALL_PUBLIC_APP_ENTRY_URL: base + '/', LONGBALL_INVITATION_POLICY_VERSION: 'login-activity-review-v1', LONGBALL_OIDC_CONNECT_ORIGINS: `https://raw.githubusercontent.com,${virtualApi}`, LONGBALL_EXPORT_ENCRYPTION_KEY_FILE: key, LONGBALL_EXPORT_TTL_MS: '600000' });
  stage = 'owned API readiness'; apiProcess = launch(); await healthy(apiProcess);
  browser = await chromium.launch({ executablePath: process.env.LONGBALL_CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
  stage = 'actual sign-in history and five-role permission boundaries';
  const { superState, actorStates } = await historyAndPermissions(accounts);
  stage = 'real club/team invitation scope'; const created = await multiClubScope(superState, actorStates.spectator, accounts);
  stage = 'real paginated authentication history'; await createPagedHistory(accounts);
  for (const state of Object.values(actorStates)) await closePage(state);
  stage = 'explicit fresh Super Admin sign-in between completed phases'; await reauthenticate(superState, accounts.super);
  stage = 'actual filters, pagination and responsive presentation'; await uiFiltersAndPagination(superState, created, accounts);
  stage = 'report refresh failure, recovery and foreground lifecycle'; await refreshAndForeground(superState);
  const beforeRestart = await api(superState.session.accessToken, endpoint + '?range=7d');
  stage = 'persistent report history and local-session restart boundary'; await restartPersistence(superState, accounts, beforeRestart);
  check(states.every(state => state.pageErrors.length === 0), 'No dashboard journey may produce a browser runtime or unexpected transport error.');
  check(!report.httpFailures.some(failure => failure.status === 429 || failure.fromBrowser && !failure.controlledFault), 'Do not exhaust real rate limits or silently tolerate unexpected browser API errors.');
  check(report.apiWindows.every(window => window.attempts <= 120 && window.mutations <= 60), 'All observed account request windows must respect the unchanged limits.');
  check(digest(await readFile(apiBundle)) === report.source.apiBundleSha256 && digest(await readFile(scriptPath)) === report.source.webJavaScriptSha256 && digest(await readFile(new URL(import.meta.url))) === report.source.harnessSha256, 'The actual API, browser and harness artifacts must stay unchanged throughout review.');
  report.actualSignIns = knownSignIns; report.rateLimits = { ordinary: 120, mutations: 60, loginAttemptsPerIp: 20 }; report.artifactsStableBeforeAfter = true; report.passed = true;
} catch (error) {
  report.failures.push({ stage, name: safe(error.name), message: safe(error.message) }); report.processDiagnostics = safe(processDiagnostics); report.pageErrors = states.flatMap(state => state.pageErrors); process.exitCode = 1;
} finally {
  clearTimeout(watchdog); for (const state of states) state.closed = true; await browser?.close().catch(() => {});
  for (const child of [...children].reverse()) await stop(child);
  if (privateDirectory) await rm(privateDirectory, { recursive: true, force: true });
  report.completedAt = new Date().toISOString(); report.reactKeyWarnings = states.reduce((sum, state) => sum + state.reactKeyWarnings, 0);
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'report.json'), safe(JSON.stringify(report, null, 2), Infinity) + '\n');
}
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures, report: '.local/quality/login-activity-review/report.json' }));
