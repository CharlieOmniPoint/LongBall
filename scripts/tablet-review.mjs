import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { changeWorkspaceContext, openWorkspaceTab, selectWorkspaceContext } from './review-entry.mjs';

/** Built application, actual loopback API and generated credentials; never a public service or existing database. */
const output = path.resolve('.local/quality/tablet-review');
const webRoot = path.resolve(process.env.LONGBALL_TABLET_REVIEW_WEB_ROOT ?? 'apps/mobile/dist-demo-web');
const apiBundle = path.resolve(process.env.LONGBALL_TABLET_REVIEW_API_BUNDLE ?? 'apps/api/dist/api.mjs');
const virtualApi = 'https://longball-tablet-review.trycloudflare.com';
const statusPath = '/CharlieOmniPoint/LongBall/preview/longball-m0/preview-status.json';
const teamId = 'synthetic-roma-u10', seasonId = 'synthetic-season-2026-27', matchId = 'synthetic-roma-maple-2026-10-24';
const viewports = [
  { width: 320, height: 844 }, { width: 390, height: 844 },
  { width: 768, height: 1024 }, { width: 820, height: 1180 },
  { width: 1024, height: 768 }, { width: 1180, height: 820 }, { width: 1366, height: 1024 },
  { width: 844, height: 390 }, { width: 915, height: 412 },
];
const roleLabels = { manager: /Manager/, administrator: /Administrator/, player: /Player/, spectator: /Spectator/ };
const children = [], states = [], secrets = new Set(), tokenAccounts = new Map(), budgets = new Map();
const report = { scope: 'Staff-only device-local tablet layout, role boundaries, rotation and untouched football command state against an isolated generated-account API and exact built application.', passed: false, viewports, journeys: [], checks: [], failures: [], apiBudgetWaits: [], nativeDeviceEvidence: false, paidServicesProvisioned: false };
let browser, privateDirectory, base, stage = 'preconditions', diagnostics = '';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const staff = role => role === 'manager' || role === 'administrator';
const route = section => `/v1/teams/${teamId}/${section}?seasonId=${seasonId}`;
function sanitise(value, limit = 3000) {
  let text = String(value);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) if (secret) text = text.replaceAll(secret, '[redacted]');
  return text.replace(/Bearer\s+[^\s"',;}]+/gi, 'Bearer [redacted]').replace(/demo_[A-Za-z0-9_-]{43}/g, '[redacted-session]').slice(0, limit);
}
function observe(token, method) {
  const accountId = tokenAccounts.get(token); if (!accountId) return;
  const now = Date.now(); let current = budgets.get(accountId);
  if (!current || now - current.began >= 60000) { current = { began: now, requests: 0 }; budgets.set(accountId, current); }
  current.requests++; if (method !== 'GET') current.mutations = (current.mutations ?? 0) + 1;
}
async function freshBudget(account, phase) {
  const budget = budgets.get(account.accountId), until = budget ? budget.began + 60300 : Date.now();
  if (!budget || until <= Date.now()) return;
  report.apiBudgetWaits.push({ phase, observedRequests: budget.requests, observedMutations: budget.mutations ?? 0, waitMs: until - Date.now(), automaticRetry: false, serverLimitsChanged: false });
  console.log(JSON.stringify({ phase, waitingForExistingAccountRateWindowMs: until - Date.now() }));
  while (Date.now() < until) await delay(Math.min(1000, until - Date.now()));
}
async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); return port;
}
function launch(environment) {
  const child = spawn(process.execPath, [apiBundle], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
  const retain = bytes => { diagnostics = (diagnostics + sanitise(bytes.toString())).slice(-5000); };
  child.stdout.on('data', retain); child.stderr.on('data', retain); child.on('error', error => retain(error.message)); return child;
}
async function healthy(child) {
  for (let attempt = 0; attempt < 120; attempt++) {
    assert(child.exitCode === null && child.signalCode === null, 'The owned loopback API must remain running.');
    try {
      const response = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) });
      if (response.ok) { const value = await response.json(); assert(value.syntheticOnly && value.demoScenario && value.demoAccountLogin, 'The isolated API must require generated demo accounts.'); report.apiContractVersion = value.contractVersion; return; }
    } catch { /* Bounded startup polling only. */ }
    await delay(100);
  }
  throw new Error('The owned API did not become ready.');
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM'); for (let attempt = 0; attempt < 50 && child.exitCode === null && child.signalCode === null; attempt++) await delay(100);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
async function makePage(viewport = viewports[0]) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' }), page = await context.newPage();
  const state = { context, page, errors: [], transportErrors: [], mutations: [], session: null, closed: false };
  states.push(state); page.setDefaultTimeout(20000);
  page.on('pageerror', error => state.errors.push(sanitise(error.message)));
  await context.route('**/*', async intercepted => {
    const request = intercepted.request(), address = new URL(request.url());
    if (address.origin === base) return intercepted.continue();
    if (address.origin === 'https://raw.githubusercontent.com' && address.pathname === statusPath) return intercepted.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': base, 'Cache-Control': 'no-store' }, body: JSON.stringify({ state: 'ready', url: virtualApi, sourceRevision: report.source.gitHead, startedAt: new Date(Date.now() - 10000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() }) });
    if (address.origin !== virtualApi) { state.transportErrors.push('An unexpected external request was blocked.'); return intercepted.abort(); }
    const headers = request.headers(), token = headers.authorization?.replace(/^Bearer\s+/i, '');
    if (token) { secrets.add(token); observe(token, request.method()); }
    for (const name of ['x-controller-token', 'x-media-upload-token']) if (headers[name]) secrets.add(headers[name]);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) state.mutations.push({ method: request.method(), pathname: address.pathname, commandType: request.postDataJSON()?.command?.type ?? null });
    try {
      const response = await intercepted.fetch({ url: base + address.pathname + address.search, maxRedirects: 0 });
      if (response.status() >= 400) { const value = await response.json().catch(() => null); (report.httpFailures ??= []).push({ stage, method: request.method(), pathname: address.pathname, status: response.status(), code: typeof value?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(value.code) ? value.code : 'UNRECOGNISED_ERROR' }); }
      if (address.pathname === '/v1/demo/sessions' && request.method() === 'POST' && [200, 201].includes(response.status())) { state.session = await response.json(); secrets.add(state.session.accessToken); tokenAccounts.set(state.session.accessToken, state.session.accountId); }
      await intercepted.fulfill({ response });
    } catch (error) {
      if (!state.closed && !/abort|closed|disposed|canceled|cancelled|already handled/i.test(error.message)) state.transportErrors.push(sanitise(error.message));
      await intercepted.abort().catch(() => undefined);
    }
  });
  return state;
}
async function login(state, account, role = account.role, navigate = true) {
  const { page } = state;
  if (navigate) await page.goto(base, { waitUntil: 'networkidle' });
  if (await page.getByTestId('welcome-sign-in').isVisible()) await page.getByTestId('welcome-sign-in').click();
  await page.getByTestId('demo-login-screen').waitFor();
  assert.equal(await page.getByTestId('review-account-screen').count(), 0, 'The build must require actual demo credentials.');
  await page.getByTestId('demo-username').fill(account.username); await page.getByTestId('demo-passcode').fill(account.passcode); await page.getByTestId('demo-login-submit').click();
  await selectWorkspaceContext(page, role);
  assert.match(await page.getByTestId('workspace-current-role').innerText(), roleLabels[role]);
  assert.equal(state.session?.accountId, account.accountId, 'The configured account must be server-bound.');
  report.loginAttempts = (report.loginAttempts ?? 0) + 1;
  assert(report.loginAttempts <= 17, 'The review must stay within its bounded seventeen-login budget.');
}
async function logout(state) {
  const token = state.session.accessToken;
  const ended = state.page.waitForResponse(response => new URL(response.url()).pathname === '/v1/demo/sessions/current' && response.request().method() === 'DELETE');
  await state.page.getByTestId('demo-sign-out').click(); await state.page.getByTestId('demo-login-screen').waitFor(); assert.equal((await ended).status(), 204);
  assert.equal((await fetch(base + '/v1/me', { headers: { Authorization: `Bearer ${token}` } })).status, 401, 'Sign out must revoke the exact current session.');
}
async function currentJson(state, pathname, role = 'manager') {
  const token = state.session.accessToken; observe(token, 'GET');
  const response = await fetch(base + pathname, { headers: { Authorization: `Bearer ${token}`, 'X-Longball-Role': role }, signal: AbortSignal.timeout(15000) }); assert.equal(response.status, 200, 'An independent authorised read must succeed.'); return response.json();
}
async function settled(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
// Preference/effective-mode hooks are intentionally asserted against the actual product, rather than seeded client state.
async function expectLayout(state, role, preference = 'auto') {
  const { page } = state, { width, height } = page.viewportSize(), effective = staff(role) && (preference === 'tablet' || preference === 'auto' && width >= 768 && Math.min(width, height) >= 600) ? 'tablet' : 'phone';
  const root = page.getByTestId(`workspace-layout-${effective}`); await root.waitFor();
  assert.equal(await page.getByTestId(`workspace-layout-${effective === 'tablet' ? 'phone' : 'tablet'}`).count(), 0, 'The workspace must expose exactly one effective layout.');
  if (staff(role)) {
    assert.equal(await page.getByTestId('workspace-layout-controls').count(), 1, 'A staff workspace must retain one mounted layout preference panel.');
    await page.getByTestId('workspace-layout-menu').waitFor();
    assert.equal(await page.getByTestId(`workspace-layout-choice-${preference}`).getAttribute('aria-pressed'), 'true', 'The selected local preference must be explicit.');
  } else {
    assert.equal(await page.getByTestId('workspace-layout-controls').count(), 0, 'Players and spectators must never receive staff layout controls.');
    assert.equal(await page.getByTestId('workspace-layout-menu').count(), 0, 'Players and spectators must never receive the staff layout menu.');
  }
  if (!await page.getByTestId('workspace-match-header').isVisible()) {
    const rail = effective === 'tablet' && width >= 1024 && height >= 600;
    await page.getByTestId(rail ? 'workspace-side-navigation' : 'workspace-bottom-navigation').waitFor();
    assert.equal(await page.getByTestId(rail ? 'workspace-bottom-navigation' : 'workspace-side-navigation').isVisible(), false, 'Only the appropriate primary navigation surface may be visible.');
  }
  return effective;
}
async function chooseLayout(state, preference) {
  const before = state.mutations.length;
  const controls = state.page.getByTestId('workspace-layout-controls');
  if (!await controls.isVisible()) await state.page.getByTestId('workspace-layout-menu').click();
  await controls.waitFor(); await controls.getByTestId(`workspace-layout-choice-${preference}`).click(); await controls.waitFor({ state: 'hidden' }); await settled(state.page);
  await state.page.waitForFunction(value => localStorage.getItem('longball.layout.v1.staff') === value, preference);
  const keys = await state.page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('longball.layout.')));
  assert.deepEqual(keys, ['longball.layout.v1.staff'], 'Only one device-local staff preference key may be stored; no account or authority binding belongs in a layout preference.');
  assert.equal(state.mutations.length, before, 'Choosing a layout must never send a server mutation.');
}
async function geometry(state, label) {
  await settled(state.page);
  const result = await state.page.evaluate(() => {
    const visible = element => { const rect = element.getBoundingClientRect(), style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0 && !element.closest('[aria-hidden="true"]'); };
    const named = element => element.getAttribute('aria-label') || element.getAttribute('data-testid') || element.textContent?.trim().slice(0, 60) || element.tagName;
    const targets = [...document.querySelectorAll('button,[role="button"],[role="checkbox"],[role="switch"],[role="tab"],input:not([type="hidden"]),textarea')].filter(element => visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true');
    const undersized = targets.flatMap(element => { const rect = element.getBoundingClientRect(); return rect.width < 43.5 || rect.height < 43.5 ? [{ label: named(element), width: rect.width, height: rect.height }] : []; });
    const fonts = [...document.querySelectorAll('div,span,input,textarea,button')].filter(element => visible(element) && ([...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim()) || element.matches('input,textarea'))).flatMap(element => {
      const style = getComputedStyle(element), family = style.fontFamily.toLowerCase().split(',').map(value => value.trim().replaceAll('"', '').replaceAll("'", ''));
      return Number.parseFloat(style.fontSize) < 11.5 || family.some(value => ['serif', 'times new roman', 'georgia'].includes(value)) ? [{ label: named(element), size: style.fontSize, family: style.fontFamily }] : [];
    });
    const pitchGroups = [...document.querySelectorAll('[aria-label^="Season recorded position time on "]')];
    const overlaps = [];
    for (const pitch of pitchGroups) {
      const cells = [...pitch.querySelectorAll('[data-testid^="stats-position-"]')].filter(visible);
      for (let index = 0; index < cells.length; index++) for (let other = index + 1; other < cells.length; other++) { const a = cells[index].getBoundingClientRect(), b = cells[other].getBoundingClientRect(); if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) overlaps.push([named(cells[index]), named(cells[other])]); }
    }
    const places = [...document.querySelectorAll('[role="button"][aria-label*=" · place "]')].filter(visible);
    for (let index = 0; index < places.length; index++) for (let other = index + 1; other < places.length; other++) { const a = places[index].getBoundingClientRect(), b = places[other].getBoundingClientRect(); if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) overlaps.push([named(places[index]), named(places[other])]); }
    const tablet = !!document.querySelector('[data-testid="workspace-layout-tablet"]');
    const columnIds = ['stats-workspace-layout', 'club-team-configuration-panels', 'preparation-workspace-panels', 'player-editor-columns', 'connected-match-lineup-layout', 'connected-match-live-layout'];
    const columns = columnIds.flatMap(id => {
      const element = document.querySelector(`[data-testid="${id}"]`); if (!element || !visible(element)) return [];
      const rect = element.getBoundingClientRect(), direction = getComputedStyle(element).flexDirection;
      return [{ id, width: rect.width, direction, expected: tablet && innerHeight >= 480 && rect.width >= 700 ? 'row' : 'column' }];
    });
    return { overflow: document.documentElement.scrollWidth > innerWidth + 1, undersized, fonts, mapOverlaps: overlaps, columns, targetCount: targets.length };
  });
  assert(!result.overflow, `${label}: the document must not overflow horizontally.`);
  assert.deepEqual(result.undersized, [], `${label}: actionable controls must retain44px targets.`);
  assert.deepEqual(result.fonts, [], `${label}: visible text must use readable sans-serif typography.`);
  assert.deepEqual(result.mapOverlaps, [], `${label}: statistics position cards must not overlap.`);
  for (const columns of result.columns) assert.equal(columns.direction, columns.expected, `${label}: ${columns.id} must adapt to the actual available width.`);
  assert.deepEqual(state.errors, [], `${label}: no runtime errors.`); assert.deepEqual(state.transportErrors, [], `${label}: no unexpected transports.`);
  return { visibleTargets: result.targetCount, noOverflow: true, targets44px: true, readableTypography: true, mapCardsDoNotOverlap: true, columns: result.columns };
}
async function resizeFocusedField(state, locator, viewport) {
  await locator.focus();
  const marker = `tablet-focus-${randomBytes(5).toString('hex')}`;
  await locator.evaluate((element, value) => { element.dataset.qaRetainedFocus = value; }, marker);
  const scroll = state.page.getByTestId('workspace-content-scroll');
  const prior = await scroll.evaluate(element => { element.scrollTop = Math.min(240, Math.max(0, element.scrollHeight - element.clientHeight)); return element.scrollTop; });
  await state.page.setViewportSize(viewport); await settled(state.page);
  assert(await locator.evaluate((element, value) => document.activeElement === element && element.dataset.qaRetainedFocus === value, marker), 'Ordinary rotation must preserve the same focused input.');
  const after = await scroll.evaluate(element => ({ top: element.scrollTop, max: element.scrollHeight - element.clientHeight }));
  if (prior > 80 && after.max > 80) assert(after.top > 40, 'A layout-only resize must not reset a scrolled draft to the top.');
}
async function shortLiveControls(state) {
  const { page } = state;
  const summary = await page.getByTestId('connected-match-fixed-summary').boundingBox(), rail = await page.getByTestId('connected-match-action-rail').boundingBox(), scroll = await page.getByTestId('connected-match-content-scroll').boundingBox();
  assert(summary && rail && scroll && scroll.height >= 40, 'Short-height windows must leave a usable live-content viewport.');
  assert(summary.y + summary.height <= scroll.y + 2 && scroll.y + scroll.height <= rail.y + 2, 'The fixed summary, content and action rail must not overlap.');
  await page.getByTestId('workspace-layout-menu').click({ trial: true }); await page.getByTestId('workspace-back-to-team').click({ trial: true });
  await page.getByTestId('connected-match-countdown').scrollIntoViewIfNeeded();
  const clock = await page.getByTestId('connected-match-countdown').boundingBox(); assert(clock && clock.width > 0 && clock.height > 0, 'The match clock must remain reachable in short-height windows.');
  await page.getByTestId('open-goal').filter({ visible: true }).click({ trial: true });
}
async function safeScreenshot(state, name) {
  assert.equal(await state.page.getByTestId('demo-login-screen').count(), 0, 'Screenshots may only retain signed-in application views.');
  const body = await state.page.locator('body').innerText(); for (const secret of secrets) assert(!body.includes(secret), 'Signed-in screenshots must not contain credentials or capabilities.');
  await state.page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
}
async function roleMatrix(account) {
  const state = await makePage(), { page } = state;
  try {
    await login(state, account);
    await page.getByTestId('workspace-team-overview').click(); await page.getByTestId('team-overview').waitFor();
    await expectLayout(state, account.role); await geometry(state, `${account.role} overview`);
    if (staff(account.role)) {
      await openWorkspaceTab(page, 'stats'); await page.getByTestId('team-player-stats').waitFor();
      await page.getByTestId('stats-choose-synthetic-player-02').click(); await page.getByTestId('stats-map-player').click();
    } else if (account.role === 'player') {
      await openWorkspaceTab(page, 'home'); await page.getByTestId('player-home-my-stats').click(); await page.getByTestId('player-my-stats').waitFor();
    }
    const before = state.mutations.length;
    for (const viewport of viewports) {
      stage = `${account.role} ${viewport.width}x${viewport.height}`;
      await page.setViewportSize(viewport); const effective = await expectLayout(state, account.role);
      if (staff(account.role)) {
        await page.getByTestId('stats-player-detail-synthetic-player-02').waitFor();
        assert.equal(await page.getByTestId('stats-choose-synthetic-player-02').getAttribute('aria-pressed'), 'true', 'Rotation must retain the chosen statistics player.');
      } else {
        assert.equal(await page.getByTestId('team-player-stats').count(), 0, 'Non-staff screens must not expose staff statistics.');
        if (account.role === 'spectator') assert.equal(await page.getByTestId('workspace-tab-stats').count(), 0);
      }
      const checked = await geometry(state, stage);
      await safeScreenshot(state, `${account.role}-${viewport.width}x${viewport.height}`);
      report.journeys.push({ role: account.role, ...viewport, preference: 'auto', effective, selectedPlayerRetained: staff(account.role), ...checked });
    }
    assert.equal(state.mutations.length, before, 'The role/rotation matrix must remain read-only after login.');
    await logout(state);
  } catch (error) { await retainFailure(state); throw error; }
  finally { state.closed = true; await state.context.close(); }
}
async function adminPreferenceDrafts(account, playerAccount, spectatorAccount) {
  const state = await makePage({ width: 1024, height: 768 }), { page } = state;
  try {
    await login(state, account, 'manager'); await expectLayout(state, 'manager'); await chooseLayout(state, 'phone'); await expectLayout(state, 'manager', 'phone');
    await changeWorkspaceContext(page, 'administrator'); await expectLayout(state, 'administrator', 'phone');
    await chooseLayout(state, 'tablet'); await expectLayout(state, 'administrator', 'tablet');
    await openWorkspaceTab(page, 'clubs'); await page.getByRole('button', { name: 'Edit club and team configuration', exact: true }).click(); await page.getByTestId('administrator-configuration').waitFor();
    const team = page.getByLabel('Team name', { exact: true }), club = page.getByLabel('Club name', { exact: true });
    const initialTeam = await team.inputValue(), initialClub = await club.inputValue(), teamDraft = `${initialTeam} retained tablet draft`, clubDraft = `${initialClub} retained tablet draft`;
    await team.fill(teamDraft); await club.fill(clubDraft);
    const before = state.mutations.length;
    for (const [viewport, preference] of [[viewports[0], 'tablet'], [viewports[2], 'auto'], [viewports[4], 'phone'], [viewports[3], 'tablet']]) {
      await resizeFocusedField(state, team, viewport); await chooseLayout(state, preference); await expectLayout(state, 'administrator', preference);
      assert.equal(await team.inputValue(), teamDraft, 'Rotation and preference changes must preserve the unsaved team field.'); assert.equal(await club.inputValue(), clubDraft, 'Rotation and preference changes must preserve the sibling club field.'); await geometry(state, 'administrator retained configuration');
    }
    assert.equal(state.mutations.length, before, 'Device layout changes must not save either administrator field.');
    const configuration = await currentJson(state, route('configuration'), 'administrator'); assert.equal(configuration.team.name, initialTeam); assert.equal(configuration.club.name, initialClub);
    await safeScreenshot(state, 'administrator-retained-drafts');
    // The fields are deliberately restored before reload/sign-out: this checks persistence without claiming cross-session memory-only drafts are saved.
    await team.fill(initialTeam); await club.fill(initialClub); await page.reload({ waitUntil: 'networkidle' }); await login(state, account, 'administrator', false); await expectLayout(state, 'administrator', 'tablet');
    await logout(state); await login(state, account, 'manager', false); await expectLayout(state, 'manager', 'tablet'); await logout(state);
    for (const nonstaff of [playerAccount, spectatorAccount]) {
      await login(state, nonstaff, nonstaff.role, false); await expectLayout(state, nonstaff.role, 'tablet');
      assert.equal(await page.getByTestId('workspace-layout-controls').count(), 0, 'Saved staff preferences must not create staff controls for a player or spectator.'); await geometry(state, `${nonstaff.role} with retained staff preference`); await logout(state);
    }
    report.checks.push('Actual dual-role context switching, narrow-screen fallback, refresh and sign-out/relogin preserve the device-local preference; unsaved administrator sibling fields survive rotation/toggles without a configuration POST; player and spectator ignore the retained staff preference.');
  } catch (error) { await retainFailure(state); throw error; }
  finally { state.closed = true; await state.context.close(); }
}
async function localMatch(page) {
  return page.evaluate(async target => {
    const record = await new Promise((resolve, reject) => {
      const opening = indexedDB.open('longball-synthetic-m0'); opening.onerror = () => reject(new Error('The owned journal could not be read.'));
      opening.onsuccess = () => { const database = opening.result, transaction = database.transaction('journal', 'readonly'), query = transaction.objectStore('journal').get('record'); transaction.oncomplete = () => { database.close(); resolve(query.result); }; transaction.onerror = () => reject(new Error('The owned journal read failed.')); };
    });
    const value = Object.values(record?.projections ?? {}).find(item => item?.kind === 'longball-canonical-connected-v1' && item.matchId === target);
    return value ? { state: value.localState, outbox: value.outbox, acceptedRevision: value.acceptedRevision } : null;
  }, matchId);
}
async function mutateLayoutOnly(state, action, assertDraft, name) {
  const before = await localMatch(state.page), posts = state.mutations.length;
  await action(); await settled(state.page); await assertDraft();
  assert.deepEqual(await localMatch(state.page), before, `${name}: a layout change must not alter the match journal or exact outbox.`);
  assert.equal(state.mutations.length, posts, `${name}: a layout change must not send a write, claim, upload, pause or start request.`);
  await geometry(state, name);
}
async function managerDrafts(account) {
  await freshBudget(account, 'manager actual-match layout retention');
  const state = await makePage({ width: 820, height: 1180 }), { page } = state, button = name => page.getByRole('button', { name, exact: true });
  try {
    await login(state, account); await expectLayout(state, 'manager');
    await openWorkspaceTab(page, 'team');
    const preparation = await currentJson(state, route('preparation')), profile = preparation.profiles.find(item => item.playerId === 'synthetic-player-02'); assert(profile);
    await page.getByRole('button', { name: `Edit ${profile.displayName}`, exact: true }).click();
    const name = page.getByLabel('Player display name', { exact: true }), draftName = `${profile.displayName} tablet review`;
    await name.fill(draftName); const rosterPosts = state.mutations.length;
    for (const [viewport, preference] of [[viewports[4], 'phone'], [viewports[2], 'tablet'], [{ width: 820, height: 360 }, 'auto'], [viewports[1], 'auto']]) {
      await resizeFocusedField(state, name, viewport); await chooseLayout(state, preference); await expectLayout(state, 'manager', preference); assert.equal(await name.inputValue(), draftName); await geometry(state, 'manager profile draft');
    }
    assert.equal(state.mutations.length, rosterPosts, 'Rotation/toggles must retain a profile editor without saving it.');
    await name.fill(profile.displayName); await button('Keep previous values').click();
    await page.setViewportSize(viewports[3]); await chooseLayout(state, 'auto'); await openWorkspaceTab(page, 'schedule');
    await page.getByRole('button', { name: /^Open fixture Maple FC,/ }).click(); await page.getByTestId('preparation-open-match').click();
    await page.getByTestId('recording-acquire').click(); await page.getByTestId('connected-match-attendance').click();
    let current = await localMatch(page); assert(current?.state.status === 'preparation'); const match = current.state;
    for (const playerId of match.config.selectedPlayerIds) {
      const displayName = match.config.players.find(player => player.id === playerId).displayName;
      const row = page.locator('div').filter({ has: page.getByText(new RegExp(`^${displayName} · `)) }).filter({ has: button('Present') }).last();
      await row.getByRole('button', { name: 'Present', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('[role="progressbar"]'));
    }
    await page.getByTestId('connected-match-lineup').click(); await page.getByTestId('lineup-auto-fill').click(); await button('Show position list').click();
    const firstSlot = match.config.slots[0], slot = page.getByRole('button', { name: new RegExp(`^${firstSlot.label ?? firstSlot.position} · place 1,`) });
    await slot.click(); const chooseLabel = page.getByText(`Choose for ${firstSlot.label ?? firstSlot.position}`, { exact: true }); await chooseLabel.waitFor();
    const lineupLabels = await page.getByRole('button', { name: / · place \d+,/ }).allTextContents();
    const retainLineup = async () => { await button('Save staged lineup').waitFor(); await chooseLabel.waitFor(); assert.deepEqual(await page.getByRole('button', { name: / · place \d+,/ }).allTextContents(), lineupLabels); };
    for (const viewport of [viewports[4], viewports[2], viewports[0], viewports[3]]) await mutateLayoutOnly(state, async () => { await page.setViewportSize(viewport); await expectLayout(state, 'manager'); }, retainLineup, 'unsaved lineup rotation');
    for (const preference of ['phone', 'tablet', 'auto']) await mutateLayoutOnly(state, async () => { await chooseLayout(state, preference); await expectLayout(state, 'manager', preference); }, retainLineup, 'unsaved lineup preference');
    await safeScreenshot(state, 'manager-unsaved-lineup');
    await button('Save staged lineup').click(); await page.waitForFunction(() => !document.querySelector('[role="progressbar"]'));
    await page.getByTestId('connected-match-live').click(); await button('Start first half').click();
    const confirmation = button('Confirm the actual event now'); await confirmation.waitFor();
    await mutateLayoutOnly(state, async () => { await page.setViewportSize(viewports[4]); await chooseLayout(state, 'tablet'); }, async () => { await confirmation.waitFor(); assert.equal((await localMatch(page)).state.status, 'preparation'); }, 'pending kickoff review');
    await confirmation.click(); await button('Review referee pause').click(); await button('Confirm the actual event now').click();
    current = await localMatch(page); assert.equal(current.state.status, 'first_half_paused');
    await page.getByTestId('open-goal').filter({ visible: true }).click(); await button('Penalty').click();
    const scorerName = match.config.players.find(player => player.id === match.config.selectedPlayerIds[0]).displayName; await button(scorerName).click();
    const captured = await page.getByText(/^Effective time: half /).innerText();
    const penaltyColor = await button('Penalty').evaluate(element => getComputedStyle(element).backgroundColor), scorerColor = await button(scorerName).evaluate(element => getComputedStyle(element).backgroundColor);
    const retainGoal = async () => { await page.getByTestId('save-goal').waitFor(); assert.equal(await page.getByText(/^Effective time: half /).innerText(), captured); assert.equal(await button('Penalty').evaluate(element => getComputedStyle(element).backgroundColor), penaltyColor); assert.equal(await button(scorerName).evaluate(element => getComputedStyle(element).backgroundColor), scorerColor); assert.equal((await localMatch(page)).state.status, 'first_half_paused'); };
    for (const viewport of [...viewports, { width: 820, height: 360 }]) await mutateLayoutOnly(state, async () => { await page.setViewportSize(viewport); await expectLayout(state, 'manager', 'tablet'); }, async () => { await retainGoal(); if (viewport.height < 480) await shortLiveControls(state); }, 'goal review rotation');
    for (const preference of ['phone', 'auto', 'tablet']) await mutateLayoutOnly(state, async () => { await chooseLayout(state, preference); await expectLayout(state, 'manager', preference); }, retainGoal, 'goal review preference');
    await safeScreenshot(state, 'manager-goal-review');
    await button('Cancel goal entry').click();
    await button('Review clock resume').click(); await button('Confirm the actual event now').click();
    for (const [viewport, preference] of [[viewports[2], 'auto'], [viewports[4], 'phone'], [viewports[3], 'tablet']]) {
      await mutateLayoutOnly(state, async () => { await page.setViewportSize(viewport); await chooseLayout(state, preference); await expectLayout(state, 'manager', preference); }, async () => { await page.getByTestId('connected-match-countdown').waitFor(); assert.equal((await localMatch(page)).state.status, 'first_half_running'); await button('Review referee pause').click({ trial: true }); }, 'running match rotation');
    }
    // Explicit user actions above intentionally stayed local: layout checks never upload their play.
    const accepted = await currentJson(state, `/v1/matches/${matchId}/download?deviceId=tablet-review-independent`);
    assert.equal(accepted.acceptedRevision, 0); assert.equal(accepted.state.status, 'preparation'); assert.deepEqual(accepted.state.score, { for: 0, against: 0 });
    await page.getByTestId('workspace-back-to-team').click(); await page.getByTestId('team-overview').waitFor(); await page.getByTestId('workspace-return-to-match').click(); await page.getByTestId('connected-match-live').click();
    await page.getByTestId('connected-match-countdown').waitFor(); await page.getByTestId('workspace-back-to-team').click({ trial: true });
    await logout(state);
    report.checks.push('Manager profile text, selected lineup place/complete draft, pending kickoff confirmation and captured penalty/scorer review survive phone/tablet rotation and preference changes; exact local journal/outbox and HTTP writes remain unchanged during every layout action; a running match remains running with reachable clock controls; accepted match stays unstarted, unscored and revision0 without upload, with back/return navigation reachable.');
  } catch (error) { await retainFailure(state); throw error; }
  finally { state.closed = true; await state.context.close(); }
}
async function retainFailure(state) {
  try { if (state.closed || await state.page.getByTestId('demo-signed-in').count() !== 1) return; await safeScreenshot(state, 'failure-signed-in'); report.failureWorkspace = sanitise(await state.page.locator('body').innerText(), 12000); } catch { /* Keep the original failure if the session is changing. */ }
}
const watchdog = setTimeout(() => { void browser?.close().catch(() => undefined); for (const child of children) child.kill('SIGTERM'); }, 540000); watchdog.unref();
try {
  await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true });
  assert(existsSync(path.join(webRoot, 'index.html')) && existsSync(apiBundle), 'Build the tablet-enabled demo web application and API before running this separate review.');
  const html = await readFile(path.join(webRoot, 'index.html'), 'utf8'), script = html.match(/<script[^>]+src="([^"]+)"/)?.[1]; assert(script && !script.includes('..') && !script.includes('://'));
  const javascript = await readFile(path.join(webRoot, script.replace(/^\//, '')));
  report.source = { gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), workingTreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()), harnessSha256: digest(await readFile(new URL(import.meta.url))), webIndexSha256: digest(html), webJavaScriptSha256: digest(javascript), apiBundleSha256: digest(await readFile(apiBundle)) };
  privateDirectory = await mkdtemp(path.join(tmpdir(), 'longball-tablet-qa-'));
  const accounts = [['manager', 'manager', 'synthetic-account-manager-2'], ['administrator', 'administrator', 'synthetic-account-admin'], ['player', 'player', 'synthetic-account-player-01'], ['spectator', 'spectator', 'synthetic-account-spectator'], ['dual', 'manager', 'synthetic-account-manager']].map(([key, role, accountId]) => {
    const username = `qa-${randomBytes(5).toString('hex')}.${key}`, passcode = randomBytes(24).toString('base64url'), salt = randomBytes(16).toString('base64url'); secrets.add(username); secrets.add(passcode);
    assert(!javascript.includes(username) && !javascript.includes(passcode), 'Generated credentials must never appear in the application bundle.');
    return { key, role, accountId, username, passcode, salt, hash: scryptSync(passcode, Buffer.from(salt, 'base64url'), 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }).toString('hex') };
  });
  const verifierFile = path.join(privateDirectory, 'verifiers.json'); await writeFile(verifierFile, JSON.stringify({ version: 1, sessionTtlSeconds: 3600, accounts: accounts.map(({ username, accountId, salt, hash }) => ({ username, accountId, salt, hash })) }), { mode: 0o600 });
  const environment = { ...process.env }; for (const key of Object.keys(environment)) if (key.startsWith('LONGBALL_') || /^PG(?:HOST|PORT|USER|DATABASE|PASSWORD|PASSFILE|SERVICE|SERVICEFILE|SSLMODE)$/.test(key) || ['DATABASE_URL', 'DATABASE_URL_FILE'].includes(key)) delete environment[key];
  base = `http://127.0.0.1:${await availablePort()}`;
  Object.assign(environment, { NODE_ENV: 'test', LONGBALL_SYNTHETIC_AUTH: '1', LONGBALL_DEMO_SCENARIO: '1', LONGBALL_DEMO_ACCOUNTS_FILE: verifierFile, LONGBALL_API_HOST: '127.0.0.1', LONGBALL_API_PORT: new URL(base).port, LONGBALL_API_DATABASE: path.join(privateDirectory, 'service.sqlite'), LONGBALL_MEDIA_DIRECTORY: path.join(privateDirectory, 'media'), LONGBALL_STATIC_DIRECTORY: webRoot, LONGBALL_API_ORIGINS: base, LONGBALL_OIDC_CONNECT_ORIGINS: `https://raw.githubusercontent.com,${virtualApi}` });
  stage = 'isolated API startup'; await healthy(launch(environment));
  browser = await chromium.launch({ executablePath: process.env.LONGBALL_CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
  for (const role of ['manager', 'administrator', 'player', 'spectator']) { stage = `${role} viewport matrix`; await roleMatrix(accounts.find(account => account.role === role)); }
  stage = 'staff preference and administrator draft retention'; await adminPreferenceDrafts(accounts.find(account => account.key === 'dual'), accounts.find(account => account.role === 'player'), accounts.find(account => account.role === 'spectator'));
  stage = 'manager football draft and event-review retention'; await managerDrafts(accounts.find(account => account.key === 'manager'));
  assert.deepEqual(report.httpFailures ?? [], [], 'No real API request may fail during the tablet review.'); report.passed = true;
} catch (error) {
  report.failures.push({ stage, name: sanitise(error.name), message: sanitise(error.message) }); report.processDiagnostic = sanitise(diagnostics); process.exitCode = 1;
  for (const state of states) await retainFailure(state);
} finally {
  clearTimeout(watchdog); for (const state of states) state.closed = true; await browser?.close().catch(() => undefined); for (const child of [...children].reverse()) await stop(child);
  if (privateDirectory) await rm(privateDirectory, { recursive: true, force: true });
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'report.json'), sanitise(JSON.stringify(report, null, 2), Infinity) + '\n');
}
console.log(JSON.stringify({ passed: report.passed, viewportJourneys: report.journeys.length, checks: report.checks.length, failures: report.failures, report: '.local/quality/tablet-review/report.json' }));
