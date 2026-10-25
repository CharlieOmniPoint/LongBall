import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { openWorkspaceTab, reviewDateLabel, selectWorkspaceContext } from './review-entry.mjs';

/** Actual built application and loopback API; no existing database, public account or client state is changed. */
const output = path.resolve('.local/quality/feature-pass-review');
const webRoot = path.resolve(process.env.LONGBALL_FEATURE_REVIEW_WEB_ROOT ?? 'apps/mobile/dist-demo-web');
const apiBundle = path.resolve(process.env.LONGBALL_FEATURE_REVIEW_API_BUNDLE ?? 'apps/api/dist/api.mjs');
const virtualApi = 'https://longball-feature-review.trycloudflare.com';
const statusPath = '/CharlieOmniPoint/LongBall/preview/longball-m0/preview-status.json';
const teamId = 'synthetic-roma-u10', seasonId = 'synthetic-season-2026-27';
const route = section => `/v1/teams/${teamId}/${section}?seasonId=${seasonId}`;
const children = [], states = [], secrets = new Set(), checks = [];
const report = { scope: 'Seventeen-feature functional and phone-usability regression against an isolated generated-account API and built application.', passed: false, roles: [], checks, failures: [], nativeDeviceEvidence: false, paidServicesProvisioned: false };
const requestWindows = new Map(), tokenAccounts = new Map();
let browser, privateDirectory, base, fixture, stage = 'preconditions', processDiagnostic = '';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function futureReviewDate(days) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const today = `${parts.find(part => part.type === 'year').value}-${parts.find(part => part.type === 'month').value}-${parts.find(part => part.type === 'day').value}`;
  return new Date(Date.parse(`${today}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
function sanitise(value, limit = 2500) {
  let text = String(value);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) if (secret) text = text.replaceAll(secret, '[redacted]');
  return text.replace(/Bearer\s+[^\s"',;}]+/gi, 'Bearer [redacted]').replace(/demo_[A-Za-z0-9_-]{43}/g, '[redacted-session]').slice(0, limit);
}
function observe(token, method) {
  const accountId = tokenAccounts.get(token);
  if (!accountId) return;
  const now = Date.now(); let window = requestWindows.get(accountId);
  if (!window || now - window.began >= 60000) { window = { began: now, attempts: 0, mutations: 0 }; requestWindows.set(accountId, window); }
  window.attempts++; if (method !== 'GET') window.mutations++;
}
async function freshBudget(accountId, phase) {
  const current = requestWindows.get(accountId), until = current ? current.began + 60300 : Date.now();
  if (!current || current.attempts === 0 || until <= Date.now()) return;
  (report.apiBudgetWaits ??= []).push({ phase, observedAttemptsBefore: current.attempts, observedMutationsBefore: current.mutations, waitMs: until - Date.now(), requestRetried: false, serverLimitChanged: false });
  console.log(JSON.stringify({ phase, waitingForExistingAccountRateWindowMs: until - Date.now() }));
  while (Date.now() < until) await delay(Math.min(1000, until - Date.now()));
}
async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
function launch(command, args, env) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
  const retain = bytes => { processDiagnostic = (processDiagnostic + sanitise(bytes.toString())).slice(-5000); };
  child.stdout.on('data', retain); child.stderr.on('data', retain); child.on('error', error => retain(error.message));
  return child;
}
async function exited(child) {
  if (child.exitCode !== null) assert.equal(child.exitCode, 0, 'The owned fixture setup must finish successfully.');
  else await new Promise((resolve, reject) => { child.once('exit', code => code === 0 ? resolve() : reject(new Error('The owned fixture setup failed.'))); child.once('error', reject); });
}
async function healthy(child) {
  for (let attempt = 0; attempt < 120; attempt++) {
    assert(child.exitCode === null && child.signalCode === null, 'The newly started loopback API must remain running.');
    try {
      const response = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const value = await response.json();
        assert(value.syntheticOnly === true && value.demoScenario === true && value.demoAccountLogin === true, 'The isolated API must require configured demo accounts.');
        report.apiContractVersion = value.contractVersion; return;
      }
    } catch { /* Bounded startup polling only. */ }
    await delay(100);
  }
  throw new Error('The isolated API did not become healthy.');
}
async function currentJson(token, section, role = 'manager') {
  observe(token, 'GET');
  const response = await fetch(base + (section.startsWith('/') ? section : route(section)), { headers: { Authorization: `Bearer ${token}`, 'X-Longball-Role': role }, signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, 'An independent authorised API read must succeed.'); return response.json();
}
async function apiCommand(token, section, command, role = 'manager') {
  observe(token, 'POST');
  const response = await fetch(base + route(section), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Longball-Role': role, 'Content-Type': 'application/json', 'X-Api-Contract-Version': report.apiContractVersion, 'Idempotency-Key': command.id }, body: JSON.stringify({ command }), signal: AbortSignal.timeout(15000) });
  return { status: response.status, value: await response.json() };
}
async function makePage(width) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
  const page = await context.newPage(), state = { context, page, width, errors: [], transportErrors: [], preparationPosts: [], feedbackPosts: [], session: null, closed: false };
  states.push(state); page.setDefaultTimeout(20000);
  page.on('pageerror', error => state.errors.push(sanitise(error.message)));
  await context.route('**/*', async intercepted => {
    const request = intercepted.request(), address = new URL(request.url());
    if (address.origin === base) return intercepted.continue();
    if (address.origin === 'https://raw.githubusercontent.com' && address.pathname === statusPath) return intercepted.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': base, 'Cache-Control': 'no-store' }, body: JSON.stringify({ state: 'ready', url: virtualApi, sourceRevision: report.source.gitHead, startedAt: new Date(Date.now() - 10000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() }) });
    if (address.origin !== virtualApi) { state.transportErrors.push('An unexpected external request was blocked.'); return intercepted.abort(); }
    const headers = request.headers(), token = headers.authorization?.replace(/^Bearer\s+/i, '');
    if (token) secrets.add(token);
    for (const name of ['x-controller-token', 'x-media-upload-token']) if (headers[name]) secrets.add(headers[name]);
    if (token) observe(token, request.method());
    if (request.method() === 'POST' && ['/preparation', '/match-feedback'].some(suffix => address.pathname.endsWith(suffix))) {
      const command = request.postDataJSON()?.command;
      if (address.pathname.endsWith('/preparation')) state.preparationPosts.push(command);
      else state.feedbackPosts.push(command);
    }
    try {
      const response = await intercepted.fetch({ url: base + address.pathname + address.search, headers: { ...request.headers(), connection: 'close' }, maxRedirects: 0, maxRetries: 0 });
      if (!response.ok()) {
        const body = await response.json().catch(() => null);
        (report.httpFailures ??= []).push({ stage, method: request.method(), pathname: address.pathname, status: response.status(), code: typeof body?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(body.code) ? body.code : 'UNRECOGNISED_ERROR' });
      }
      if (address.pathname === '/v1/demo/sessions' && request.method() === 'POST' && [200, 201].includes(response.status())) {
        state.session = await response.json(); secrets.add(state.session.accessToken); tokenAccounts.set(state.session.accessToken, state.session.accountId);
      }
      await intercepted.fulfill({ response });
    } catch (error) {
      if (!state.closed && request.failure()?.errorText !== 'net::ERR_ABORTED') state.transportErrors.push(sanitise(error.message));
      else if (!state.closed) (report.browserCancellations ??= []).push({ method: request.method(), pathname: address.pathname, failure: 'net::ERR_ABORTED' });
      await intercepted.abort().catch(() => undefined);
    }
  });
  return state;
}
async function login(state, account) {
  const { page } = state;
  await page.goto(base, { waitUntil: 'networkidle' });
  assert.equal(await page.getByTestId('review-account-screen').count(), 0, 'The credential-required build must not expose a review-role chooser.');
  await page.getByTestId('welcome-sign-in').click();
  await page.getByTestId('demo-username').fill(account.username);
  await page.getByTestId('demo-passcode').fill(account.passcode);
  await page.getByTestId('demo-login-submit').click();
  await page.getByTestId('demo-signed-in').waitFor();
  await selectWorkspaceContext(page, account.role);
  const badge = page.getByTestId('workspace-current-role'); await badge.waitFor();
  const expected = { manager: /Manager/, administrator: /Super Admin/, player: /Player/, spectator: /Spectator/ };
  assert.match(await badge.innerText(), expected[account.role], 'The current selected role must be visible.');
  assert.equal(state.session?.accountId, account.accountId, 'The actual server must bind the configured account.');
  await page.getByTestId('demo-sign-out').click({ trial: true });
}
async function logout(state) {
  const { page } = state, token = state.session.accessToken;
  const ended = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/demo/sessions/current' && response.request().method() === 'DELETE');
  await page.getByTestId('demo-sign-out').click(); await page.getByTestId('demo-login-screen').waitFor();
  assert.equal((await ended).status(), 204, 'Sign out must revoke the real current API session.');
  const stale = await fetch(base + '/v1/me', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(stale.status, 401, 'The old opaque session must be refused.');
  assert.equal(await page.getByTestId('demo-signed-in').count(), 0);
}
async function fits(state) {
  assert(!await state.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), 'The page must fit the phone width without horizontal overflow.');
  assert.deepEqual(state.errors, [], 'The actual journey must have no runtime errors.');
  assert.deepEqual(state.transportErrors, [], 'The actual journey must have no unexpected transport errors.');
}
async function targetSize(locator, name) {
  await locator.scrollIntoViewIfNeeded(); const box = await locator.boundingBox();
  assert(box && box.width >= 43.5 && box.height >= 43.5, `${name} must retain at least a44px actionable target.`); return box;
}
async function pairedActions(first, second) {
  const a = await targetSize(first, 'First paired action'), b = await targetSize(second, 'Second paired action');
  assert(Math.abs(a.y - b.y) <= 2 && Math.abs(a.height - b.height) <= 2 && Math.abs(a.width - b.width) <= 2, 'Paired actions must share one row with equal sizes.');
  assert(a.x + a.width <= b.x + 2 || b.x + b.width <= a.x + 2, 'Paired actions must not overlap.');
}
function assertNoPrivateStats(value) {
  const forbidden = new Set(['attendance', 'intervals', 'preferences', 'eligiblePositions', 'feedback', 'note', 'text', 'rawEvents', 'rating', 'ratings']);
  const visit = candidate => {
    if (!candidate || typeof candidate !== 'object') return;
    for (const [key, nested] of Object.entries(candidate)) { assert(!forbidden.has(key) && !/feedback/i.test(key), 'Statistics must not contain private profile, attendance, interval or feedback fields.'); visit(nested); }
  };
  visit(value);
}
async function noPositionOverlaps(page) {
  const pitch = page.getByLabel(/^Season recorded position time on /);
  if (await pitch.count() === 0) return;
  await pitch.getByTestId(/^stats-position-/).first().waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const collisions = await pitch.evaluate(element => {
    const cells = [...element.querySelectorAll('[data-testid^="stats-position-"]')].filter(node => /^stats-position-[A-Z]{2}$/.test(node.getAttribute('data-testid'))).map(node => node.getBoundingClientRect());
    let overlap = 0;
    for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) if (Math.min(cells[i].right, cells[j].right) - Math.max(cells[i].left, cells[j].left) > 2 && Math.min(cells[i].bottom, cells[j].bottom) - Math.max(cells[i].top, cells[j].top) > 2) overlap++;
    return overlap;
  });
  assert.equal(collisions, 0, 'Position-map cards must not overlap on the reviewed phone width.');
}
async function roleJourney(account, width, privateNote) {
  const state = await makePage(width), { page } = state;
  try {
    await login(state, account);
    await targetSize(page.getByTestId('demo-sign-out'), 'Icon-only Sign out');
    assert.equal(await page.getByTestId('demo-sign-out').innerText(), '', 'Sign out should use its accessible icon rather than a large text button.');
    assert.equal(await page.getByText(/^(?:DEMO|DEMO ROMA U10|Sample data|Fictional data)$/).count(), 0, 'Redundant development status tags must not appear in the signed-in app.');
    await targetSize(page.getByTestId('workspace-team-overview'), 'Team overview shortcut');
    await page.getByTestId('workspace-team-overview').click(); await page.getByTestId('team-overview').waitFor();
    await fits(state);
    assert.equal(await page.getByTestId('demo-login-screen').count(), 0, 'Only signed-in application screens may be retained as screenshots.');
    const statsResponse = account.role === 'spectator' ? null : await currentJson(state.session.accessToken, 'player-stats', account.role);
    if (account.role === 'player') {
      await openWorkspaceTab(page, 'stats');
      await page.getByTestId('player-my-stats').waitFor();
      assert.equal(statsResponse.kind, 'own-player-stats'); assert.equal(statsResponse.player.playerId, 'synthetic-player-01'); assert(!Object.hasOwn(statsResponse, 'players')); assertNoPrivateStats(statsResponse);
      assert.equal(await page.getByTestId(/^stats-player-detail-/).count(), 1, 'Player statistics must contain exactly the bound player.');
      assert.equal(await page.getByTestId('team-player-stats').count(), 0, 'Player views must never show the staff roster statistics.');
      if (width === 390) {
        await feedbackJourney(state, privateNote);
        await ballotJourney(state, account);
      }
    } else if (['manager', 'administrator'].includes(account.role)) {
      await openWorkspaceTab(page, 'stats'); await page.getByTestId('team-player-stats').waitFor();
      assert.equal(statsResponse.kind, 'team-player-stats'); assert.equal(statsResponse.players.length, 8, 'The reviewed staff roster must retain the owner\'s eight Roma players.'); assertNoPrivateStats(statsResponse);
      assert(!JSON.stringify(statsResponse).includes(privateNote), 'Private feedback must not leak into staff statistics.');
      await targetSize(page.getByTestId('stats-map-team'), 'Whole-team position map');
      await page.getByTestId('stats-map-player').click(); await noPositionOverlaps(page);
      await page.getByTestId('stats-map-team').click(); await noPositionOverlaps(page);
    } else {
      assert.equal(await page.getByTestId('workspace-tab-stats').count(), 0, 'Spectators must not receive a statistics navigation grant.');
      assert.equal(await page.getByTestId('workspace-tab-feedback').count(), 0, 'Spectators must not receive private feedback navigation.');
      const denied = await fetch(base + route('player-stats'), { headers: { Authorization: `Bearer ${state.session.accessToken}`, 'X-Longball-Role': 'spectator' } }); assert.equal(denied.status, 404);
    }
    await fits(state);
    const body = await page.locator('body').innerText(); for (const secret of secrets) assert(!body.includes(secret), 'A signed-in view must not display generated credentials.');
    await page.screenshot({ path: path.join(output, `${account.role}-${width}.png`), animations: 'disabled' });
    await logout(state);
    report.roles.push({ role: account.role, width, roleLabelVisible: true, iconSignOut44px: true, teamOverview: true, noOverflow: true, currentTokenRevoked: true });
  } finally { state.closed = true; await state.context.close(); }
}
async function feedbackJourney(state, privateNote) {
  const { page } = state, token = state.session.accessToken;
  const before = await currentJson(token, 'match-feedback', 'player');
  const open = before.matches.find(match => match.matchId === fixture.matchId);
  assert(open?.eligible && open.canEdit && open.status === 'open', 'The actual Node-owned trusted completion must open feedback for its played player.');
  await openWorkspaceTab(page, 'home'); await page.getByTestId('player-home-feedback').click();
  const card = page.getByTestId(`match-feedback-${fixture.matchId}`); await card.waitFor();
  await card.getByTestId('match-feedback-rating-4').click();
  await card.getByTestId('match-feedback-note').fill('x'.repeat(257));
  assert(await card.getByTestId('match-feedback-review').isDisabled(), 'A257-character note must be refused before review.');
  await card.getByTestId('match-feedback-note').fill('😀'.repeat(256));
  assert.equal(Array.from(await card.getByTestId('match-feedback-note').inputValue()).length, 256);
  assert(!await card.getByTestId('match-feedback-review').isDisabled(), 'The256-character limit must support Unicode code points rather than limiting emoji to128.');
  await card.getByTestId('match-feedback-note').fill(privateNote);
  const postsBefore = state.feedbackPosts.length;
  await card.getByTestId('match-feedback-review').click();
  assert.equal(state.feedbackPosts.length, postsBefore, 'Reviewing private feedback must not write.');
  const accepted = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/match-feedback') && response.request().method() === 'POST');
  await card.getByTestId('match-feedback-save').click(); assert.equal((await accepted).status(), 200);
  await card.getByText('The reviewed feedback was saved.', { exact: true }).waitFor();
  const saved = await currentJson(token, 'match-feedback', 'player'), entry = saved.matches.find(match => match.matchId === fixture.matchId)?.own;
  assert(entry?.rating === 4 && entry.text === privateNote && entry.revision === 1 && !Object.hasOwn(saved.matches.find(match => match.matchId === fixture.matchId), 'entries'));
  const command = state.feedbackPosts.at(-1), replay = await apiCommand(token, 'match-feedback', command, 'player');
  assert.equal(replay.status, 200); assert.equal(replay.value.revision, 1, 'An exact accepted HTTP replay must not create another revision.');
  await card.getByTestId('match-feedback-rating-5').click(); await card.getByTestId('match-feedback-review').click();
  const updated = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/match-feedback') && response.request().method() === 'POST');
  await card.getByTestId('match-feedback-save').click(); assert.equal((await updated).status(), 200);
  const latest = await currentJson(token, 'match-feedback', 'player');
  assert.deepEqual({ rating: latest.matches.find(match => match.matchId === fixture.matchId).own.rating, revision: latest.matches.find(match => match.matchId === fixture.matchId).own.revision }, { rating: 5, revision: 2 }, 'A reviewed own feedback edit must save as the next CAS revision.');
  const closed = saved.matches.find(match => match.status === 'closed'); assert(closed, 'Historical accepted matches must expose closed feedback windows.');
  assert.equal(await page.getByTestId(`match-feedback-${closed.matchId}`).getByTestId('match-feedback-review').count(), 0, 'A closed feedback window must have no editor.');
  report.feedback = { actualPlayedProof: true, trustedNodeCompletion: true, unicodeNoteBoundary: true, reviewHasNoWrite: true, ratingAndNoteSaved: true, exactReplayRevisionUnchanged: true, ownFeedbackUpdate: true, closedHistoryReadOnly: true };
  checks.push('Private feedback uses an actual reducer-completed accepted fixture and Node-owned trusted finish; Unicode note limits are respected, review writes nothing, confirmed save persists once, exact replay keeps revision, an own edit advances CAS and closed history has no editor.');
}
async function ballotJourney(state, account) {
  await freshBudget(account.accountId, 'own private ballot and same-account second session');
  const { page } = state, token = state.session.accessToken;
  const before = await currentJson(token, 'community', 'player');
  const match = before.matches.find(item => item.id === fixture.matchId);
  assert(match?.mayVote && match.candidates.length >= 2 && match.ownChoice === null);
  assert(!match.candidates.some(item => item.id === 'synthetic-player-01'), 'The played Player must not be a candidate for its own vote.');
  const [first, second] = match.candidates;
  const posts = [];
  const capture = request => {
    if (new URL(request.url()).pathname.endsWith('/community') && request.method() === 'POST') posts.push(request.postDataJSON().command);
  };
  page.on('request', capture);
  try {
    await openWorkspaceTab(page, 'home'); await page.getByTestId('player-home-vote').click();
    const card = page.getByTestId(`connected-ballot-${fixture.matchId}`); await card.waitFor();
    await card.getByTestId(`community-vote-option-${fixture.matchId}-${first.id}`).click();
    assert.equal(posts.length, 0, 'Selecting a teammate must remain a draft until explicit confirmation.');
    const received = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/community') && response.request().method() === 'POST');
    await card.getByTestId(`community-confirm-vote-${fixture.matchId}`).click(); assert.equal((await received).status(), 200);
    await card.getByTestId(`community-change-vote-${fixture.matchId}`).waitFor();
    const firstSaved = await currentJson(token, 'community', 'player');
    assert.equal(firstSaved.matches.find(item => item.id === fixture.matchId).ownChoice, first.id);
    assert.equal(posts.length, 1); assert.equal(posts[0].type, 'ballot.cast');
    const replay = await apiCommand(token, 'community', posts[0], 'player');
    assert.equal(replay.status, 200); assert.equal(replay.value.revision, firstSaved.revision, 'Replaying the exact accepted ballot request must not add another revision.');
    await card.getByTestId(`community-change-vote-${fixture.matchId}`).click();
    await card.getByTestId(`community-vote-option-${fixture.matchId}-${second.id}`).click();
    await card.getByRole('button', { name: 'Keep current vote', exact: true }).click();
    assert.equal(posts.length, 1); assert.equal((await currentJson(token, 'community', 'player')).matches.find(item => item.id === fixture.matchId).ownChoice, first.id, 'Cancelling a changed-vote draft must retain the confirmed choice.');
    await card.getByTestId(`community-change-vote-${fixture.matchId}`).click();
    await card.getByTestId(`community-vote-option-${fixture.matchId}-${second.id}`).click();
    const changed = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/community') && response.request().method() === 'POST');
    await card.getByTestId(`community-confirm-vote-${fixture.matchId}`).click(); assert.equal((await changed).status(), 200);
    await card.getByTestId(`community-change-vote-${fixture.matchId}`).waitFor();
    assert.equal(posts.length, 2); assert.equal((await currentJson(token, 'community', 'player')).matches.find(item => item.id === fixture.matchId).ownChoice, second.id);
    const household = await makePage(390);
    try {
      await login(household, account); await openWorkspaceTab(household.page, 'home'); await household.page.getByTestId('player-home-vote').click();
      const same = household.page.getByTestId(`connected-ballot-${fixture.matchId}`); await same.waitFor();
      await same.getByTestId(`community-change-vote-${fixture.matchId}`).waitFor();
      await same.getByText(`Current choice: ${second.label}`, { exact: true }).waitFor();
      assert.equal(await same.getByTestId(`community-confirm-vote-${fixture.matchId}`).count(), 0, 'A second session for the same shared account must show its existing choice rather than another new-vote prompt.');
      assert.equal((await currentJson(household.session.accessToken, 'community', 'player')).matches.find(item => item.id === fixture.matchId).ownChoice, second.id);
      await fits(household); await logout(household);
    } finally { household.closed = true; await household.context.close(); }
    report.ballot = { actualCompiledPlayerUi: true, labelledTrustedReducerFixture: true, selfExcluded: true, selectionAndCancelledDraftDoNotWrite: true, explicitVoteAndChangedVoteAcknowledged: true, exactReplayDoesNotAdvanceRevision: true, sameSharedAccountSecondSessionSeesExistingChoice: true, cutoffMs: match.cutoffAtMs, originalFinalisationDeadlineMs: match.deadlineAtMs, policyOrClockChanged: false };
    checks.push('Player casts and changes its own private vote only after confirmation; cancelling a draft and exact replay add no vote revision, self is excluded, and a second session for the same shared account sees the existing confirmed choice. The isolated trusted fixture uses its explicitly configured cutoff; no proposed59-minute default or original60-minute finalisation deadline is changed.');
  } finally { page.off('request', capture); }
}
async function managerFeatures(account, privateNote) {
  await freshBudget(account.accountId, 'manager setup/cancellation features');
  const state = await makePage(390), { page } = state;
  try {
    await login(state, account);
    const privateBallotBoundary = await currentJson(state.session.accessToken, 'community');
    const managerMatch = privateBallotBoundary.matches.find(item => item.id === fixture.matchId);
    assert(managerMatch && managerMatch.ownChoice === null && managerMatch.candidates.length === 0 && !Object.hasOwn(privateBallotBoundary, 'ballots'), 'Managers may operate the award window without receiving a player’s private choice or a ballot directory.');
    await openWorkspaceTab(page, 'feedback'); await page.getByTestId('match-feedback-manager-view').first().waitFor();
    await page.getByTestId(`match-feedback-${fixture.matchId}`).getByText(privateNote, { exact: true }).waitFor();
    assert.equal(await page.getByTestId('match-feedback-save').count(), 0, 'Managers may read private feedback but must not submit a player entry.');
    await openWorkspaceTab(page, 'team');
    const preparation = await currentJson(state.session.accessToken, 'preparation');
    const player = preparation.profiles.find(row => row.active);
    await pairedActions(page.getByRole('button', { name: `Edit ${player.displayName}`, exact: true }), page.getByRole('button', { name: `Archive ${player.displayName}`, exact: true }));
    const originalSnapshots = structuredClone(preparation.snapshots), postsBefore = state.preparationPosts.length;
    const name = 'QA reviewed player setup';
    await page.getByTestId('saved-lineup-create').click(); await page.getByLabel('Saved setup name', { exact: true }).fill(name);
    await page.getByTestId('saved-lineup-next').click(); await page.getByTestId('saved-lineup-next').click();
    await page.getByTestId('saved-lineup-auto-fill').click();
    assert.equal(state.preparationPosts.length, postsBefore, 'Automatic position suggestion must remain an unsaved wizard draft.');
    await page.getByTestId('saved-lineup-next').click();
    assert.equal(state.preparationPosts.length, postsBefore, 'Setup review must not save a template.');
    const saved = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/preparation') && response.request().method() === 'POST');
    await page.getByTestId('saved-lineup-confirm').click(); assert.equal((await saved).status(), 200);
    let current = await currentJson(state.session.accessToken, 'preparation');
    const template = current.lineupTemplates?.find(item => item.active && item.name === name); assert(template?.allocations.length === template.formation.format);
    assert.deepEqual(current.snapshots, originalSnapshots, 'Saving a squad setup must not change immutable match snapshots.');
    const fixtureId = `qa-feature-${randomUUID()}`;
    const fixtureCommand = { id: randomUUID(), type: 'fixture.saved', expectedRevision: current.revision, fixture: { id: fixtureId, seasonId, opponent: 'QA Setup Review', playedDate: futureReviewDate(14), kickoff: '10:00', arrival: '09:30', venue: 'Roma training ground', homeAway: 'home', format: template.formation.format, plannedHalfDurationMs: 1500000 } };
    assert.equal((await apiCommand(state.session.accessToken, 'preparation', fixtureCommand)).status, 200);
    await openWorkspaceTab(page, 'more'); const refreshed = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/preparation') && response.request().method() === 'GET');
    await page.getByRole('button', { name: 'Refresh service views', exact: true }).click(); await refreshed;
    await openWorkspaceTab(page, 'schedule'); await page.getByRole('button', { name: /^Open fixture QA Setup Review,/ }).click();
    current = await currentJson(state.session.accessToken, 'preparation'); const beforeApply = structuredClone(current.fixtures.find(item => item.id === fixtureId)), applyPosts = state.preparationPosts.length;
    await page.getByRole('button', { name: `Review setup ${name} for this fixture`, exact: true }).click();
    assert.equal(state.preparationPosts.length, applyPosts, 'The fixture setup preview must not issue a write.');
    const applied = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/preparation') && response.request().method() === 'POST');
    await page.getByTestId('saved-lineup-apply').click(); assert.equal((await applied).status(), 200);
    current = await currentJson(state.session.accessToken, 'preparation'); const fixtureDraft = current.fixtures.find(item => item.id === fixtureId);
    assert.deepEqual(fixtureDraft.lineupTemplateDraft.allocations, template.allocations);
    assert.deepEqual(fixtureDraft.lineupTemplateDraft.selectedPlayerIds, template.selectedPlayerIds);
    assert.deepEqual(fixtureDraft.responses, beforeApply.responses); assert.deepEqual(fixtureDraft.attendance, beforeApply.attendance); assert.deepEqual(current.snapshots, originalSnapshots);
    await pairedActions(page.getByTestId(`scheduled-game-cancel-${fixtureId}`), page.getByTestId(`scheduled-game-delete-${fixtureId}`));
    await page.getByTestId(`scheduled-game-cancel-${fixtureId}`).click();
    await page.getByTestId('scheduled-game-reason').fill('QA weather cancellation review');
    assert.equal((await currentJson(state.session.accessToken, 'preparation')).fixtures.find(item => item.id === fixtureId).status, 'scheduled', 'Reviewing cancellation must not change the fixture.');
    const cancelled = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/scheduled-games') && response.request().method() === 'POST');
    await page.getByTestId('scheduled-game-confirm').click(); assert.equal((await cancelled).status(), 200);
    current = await currentJson(state.session.accessToken, 'preparation'); const cancelledFixture = current.fixtures.find(item => item.id === fixtureId);
    assert.equal(cancelledFixture.status, 'cancelled'); assert.deepEqual(cancelledFixture.responses, fixtureDraft.responses); assert.deepEqual(cancelledFixture.attendance, fixtureDraft.attendance);
    await page.getByTestId(`scheduled-game-delete-${fixtureId}`).click(); await page.getByTestId('scheduled-game-reason').fill('QA remove unplayed schedule item');
    const deleted = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/scheduled-games') && response.request().method() === 'POST');
    await page.getByTestId('scheduled-game-confirm').click(); assert.equal((await deleted).status(), 200);
    current = await currentJson(state.session.accessToken, 'preparation'); assert(!current.fixtures.some(item => item.id === fixtureId)); assert.deepEqual(current.snapshots, originalSnapshots);
    await fits(state); await logout(state);
    report.managerFeatures = { privateFeedbackReadOnly: true, pairedRosterActions: true, setupWizardAutofillDraftOnly: true, templateSaved: true, applyRequiresReview: true, fixtureSelectionCopiedDeliberately: true, repliesAndAttendanceUnchanged: true, cancellationReviewedAndRetained: true, unplayedItemDeleted: true, immutableSnapshotsRetained: true };
    checks.push('Manager reads player feedback without editing it; paired roster/schedule controls fit; wizard suggestions and previews do not write; explicit template apply copies only the reviewed planning squad/draft; cancellation/deletion preserve replies, actual attendance and immutable snapshots.');
  } finally { state.closed = true; await state.context.close(); }
}
async function privacyChecks(accounts, privateNote) {
  for (const role of ['administrator', 'spectator', 'other-player']) {
    const account = accounts.find(item => item.key === role), state = await makePage(390);
    try {
      await login(state, account);
      if (account.role === 'administrator') {
        const deniedCommunity = await fetch(base + route('community'), { headers: { Authorization: `Bearer ${state.session.accessToken}`, 'X-Longball-Role': 'administrator' } });
        assert.equal(deniedCommunity.status, 404, 'Administrative context does not silently gain a player’s community identity.');
      } else {
        const community = await currentJson(state.session.accessToken, 'community', account.role);
        const ownMatch = community.matches.find(item => item.id === fixture.matchId);
        assert(ownMatch && ownMatch.ownChoice === null, 'A different account or role must not receive the reviewed Player’s private choice.');
        assert(!Object.hasOwn(community, 'ballots'), 'A community projection must not return a ballot directory.');
        if (account.role !== 'player') assert.deepEqual(ownMatch.candidates, [], 'A non-player role receives no private ballot candidates or controls.');
      }
      const response = await fetch(base + route('match-feedback'), { headers: { Authorization: `Bearer ${state.session.accessToken}`, 'X-Longball-Role': account.role } });
      if (account.role === 'player') {
        assert.equal(response.status, 200); const view = await response.json();
        assert(!JSON.stringify(view).includes(privateNote) && view.matches.every(match => !match.entries && !match.own), 'Another played player must receive no peer feedback entry.');
      } else assert.equal(response.status, 404, 'Administrators and spectators must not receive private match feedback.');
      await logout(state); await fits(state);
    } finally { state.closed = true; await state.context.close(); }
  }
  checks.push('Actual HTTP denies private feedback to administrators/spectators and omits it from another player’s own-only projection.');
}
async function localMatch(page, matchId) {
  return page.evaluate(async target => {
    const record = await new Promise((resolve, reject) => {
      const opening = indexedDB.open('longball-synthetic-m0');
      opening.onerror = () => reject(new Error('The owned demo journal could not be read.'));
      opening.onsuccess = () => {
        const database = opening.result, transaction = database.transaction('journal', 'readonly'), query = transaction.objectStore('journal').get('record');
        transaction.oncomplete = () => { database.close(); resolve(query.result); }; transaction.onerror = () => reject(new Error('The owned journal read failed.'));
      };
    });
    const value = Object.values(record?.projections ?? {}).find(item => item?.kind === 'longball-canonical-connected-v1' && item.matchId === target);
    return value ? { state: value.localState, outboxCount: value.outbox.length, acceptedRevision: value.acceptedRevision } : null;
  }, matchId);
}
async function actualMatchAutofill(account) {
  await freshBudget(account.accountId, 'actual checked-in lineup suggestion');
  const state = await makePage(390), { page } = state;
  try {
    await login(state, account);
    const token = state.session.accessToken, opponent = 'QA Check-in Review', playedDate = futureReviewDate(21);
    let preparation = await currentJson(token, 'preparation');
    const originalFixtures = structuredClone(preparation.fixtures), originalSnapshots = structuredClone(preparation.snapshots);
    const formation = preparation.formations.find(row => row.format === 7); assert(formation, 'The saved seven-a-side formation must be available.');
    await openWorkspaceTab(page, 'schedule');
    await page.getByRole('radio', { name: 'Event type: Matches', exact: true }).click();
    await page.getByTestId('preparation-create-event').click();
    await page.getByLabel('Opposition', { exact: true }).fill(opponent);
    await page.getByLabel('Match date (YYYY-MM-DD)', { exact: true }).fill(playedDate);
    await page.getByLabel('Venue', { exact: true }).fill('Roma review pitch');
    await page.getByRole('radio', { name: 'Pitch places: 7', exact: true }).click();
    await page.getByLabel('Minutes per half for this match', { exact: true }).fill('25');
    const creating = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/preparation') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Save fixture', exact: true }).click(); assert.equal((await creating).status(), 200);
    await page.getByRole('button', { name: 'Save fixture', exact: true }).waitFor({ state: 'hidden' });
    preparation = await currentJson(token, 'preparation');
    const created = preparation.fixtures.find(row => row.opponent === opponent && row.playedDate === playedDate);
    const creationCommand = state.preparationPosts.at(-1);
    assert(created && creationCommand?.type === 'fixture.saved' && creationCommand.fixture.id === created.id, 'The exact game must be created by the actual Schedule form and acknowledged by the service.');
    const matchId = created.id;
    assert(matchId.startsWith('synthetic-'), 'The trusted demo creation mode must classify its actual new game for the narrow browser recording boundary.');
    const commands = [
      { type: 'fixture.selection_saved', fixtureId: matchId, selectedProfileIds: preparation.profiles.filter(row => row.active && row.seasonId === seasonId).map(row => row.id) },
      { type: 'fixture.prepared', fixtureId: matchId, formationId: formation.id },
    ];
    for (const payload of commands) {
      const reply = await apiCommand(token, 'preparation', { ...payload, id: randomUUID(), expectedRevision: preparation.revision });
      assert.equal(reply.status, 200, 'Owned QA fixture setup must use accepted Manager commands.');
      preparation = await currentJson(token, 'preparation');
    }
    assert.deepEqual(preparation.fixtures.filter(row => originalFixtures.some(original => original.id === row.id)), originalFixtures, 'Setting up an isolated future fixture must not rewrite seeded games.');
    assert.deepEqual(preparation.snapshots.filter(row => originalSnapshots.some(original => original.id === row.id)), originalSnapshots, 'Existing immutable match snapshots remain unchanged.');
    report.autofillFixture = { matchId, playedDate, commandCount: 3, createdThroughActualScheduleUi: true, trustedDemoIdentityGeneratedByApp: true, selectionAndPreparationUseRealManagerCommands: true, createdOnlyInOwnedDatabase: true, originalFixturesUnchanged: true, actualClockUnchanged: true };
    await logout(state); await login(state, account); await openWorkspaceTab(page, 'schedule');
    const open = () => page.getByRole('button', { name: `Open fixture ${opponent}, ${reviewDateLabel(playedDate)}`, exact: true });
    await open().click(); await page.getByTestId('preparation-open-saved-match').click();
    await page.getByTestId('recording-acquire').click(); await page.getByTestId('connected-match-lineup').click();
    const initial = await localMatch(page, matchId); assert(initial?.state?.status === 'preparation');
    await page.getByTestId('lineup-auto-fill').click();
    let current = await localMatch(page, matchId);
    assert.deepEqual(current.state.stagedLineup, initial.state.stagedLineup); assert.equal(current.outboxCount, initial.outboxCount, 'An infeasible suggestion before actual check-in must not create a staged lineup or event.');
    await page.getByTestId('connected-match-attendance').click();
    for (const playerId of initial.state.config.selectedPlayerIds) {
      const name = initial.state.config.players.find(player => player.id === playerId).displayName;
      const row = page.locator('div').filter({ has: page.getByText(new RegExp(`^${name} · `)) }).filter({ has: page.getByRole('button', { name: 'Present', exact: true }) }).last();
      await row.getByRole('button', { name: 'Present', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('[role="progressbar"]'));
    }
    await page.getByTestId('connected-match-lineup').click();
    const beforeSuggestion = await localMatch(page, matchId);
    await page.getByTestId('lineup-auto-fill').click();
    await page.getByRole('button', { name: 'Save staged lineup', exact: true }).click({ trial: true });
    current = await localMatch(page, matchId);
    assert.deepEqual(current, beforeSuggestion, 'A feasible auto-fill must remain an unsaved review draft until the separate staged-lineup confirmation.');
    await page.getByRole('button', { name: 'Save staged lineup', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[role="progressbar"]'));
    current = await localMatch(page, matchId);
    assert.equal(current.state.stagedLineup.length, current.state.config.pitchPlaces);
    assert.equal(current.outboxCount, beforeSuggestion.outboxCount + 1); assert.equal(current.state.status, 'preparation'); assert.equal(current.state.matchActiveMs, 0);
    assert(current.state.stagedLineup.every(allocation => current.state.attendance[allocation.playerId] === 'present' && current.state.availability[allocation.playerId] && current.state.config.profileSnapshot.find(profile => profile.playerId === allocation.playerId)?.eligiblePositions.includes(allocation.position)));
    const accepted = await currentJson(state.session.accessToken, `/v1/matches/${matchId}/download?deviceId=feature-review-read-only`);
    assert.equal(accepted.acceptedRevision, 0); assert.equal(accepted.state.stagedLineup.length, 0); assert.equal(accepted.state.status, 'preparation');
    const retained = current;
    await fits(state); await logout(state); await login(state, account);
    await openWorkspaceTab(page, 'schedule'); await open().click(); await page.getByTestId('preparation-open-saved-match').click();
    await page.getByText('Recording on this phone', { exact: true }).waitFor();
    const reopened = await localMatch(page, matchId);
    assert.deepEqual(reopened.state.stagedLineup, retained.state.stagedLineup); assert.equal(reopened.outboxCount, retained.outboxCount); assert.equal(reopened.state.status, 'preparation');
    await logout(state);
    report.matchAutofill = { actualCheckInRequired: true, infeasibleSuggestionHasNoWrite: true, completeSuggestionHasNoWrite: true, explicitStagedSaveOnly: true, savedEligibilityRespected: true, matchClockNotStarted: true, acceptedServicePlayUnchanged: true, unsentDraftRetainedAcrossSignOut: true };
    checks.push('Actual controller auto-fill refuses an unchecked squad, suggests only checked-in available eligible players without writing, and requires a separate staged save; neither suggestion nor staging starts the clock or uploads play, and a fresh sign-in reopens the same unsent staged record.');
  } finally { state.closed = true; await state.context.close(); }
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  for (let attempt = 0; attempt < 50 && child.exitCode === null && child.signalCode === null; attempt++) await delay(100);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
const watchdog = setTimeout(() => { void browser?.close().catch(() => undefined); for (const child of children) child.kill('SIGTERM'); }, 420000); watchdog.unref();
try {
  if (existsSync(output)) await rename(output, `${output}-attempt-${Date.now()}`);
  await mkdir(output, { recursive: true });
  assert(existsSync(path.join(webRoot, 'index.html')) && existsSync(apiBundle), 'Build the new flagged web application and API before this separate review.');
  const html = await readFile(path.join(webRoot, 'index.html'), 'utf8'), scriptPath = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
  assert(scriptPath && !scriptPath.includes('..') && !scriptPath.includes('://'));
  const javascript = await readFile(path.join(webRoot, scriptPath.replace(/^\//, '')));
  report.source = { gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), workingTreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()), harnessSha256: digest(await readFile(new URL(import.meta.url))), fixtureSha256: digest(await readFile(new URL('./feature-pass-fixture.ts', import.meta.url))), webIndexSha256: digest(html), webJavaScriptSha256: digest(javascript), apiBundleSha256: digest(await readFile(apiBundle)) };
  privateDirectory = await mkdtemp(path.join(tmpdir(), 'longball-feature-pass-qa-'));
  const accounts = [['manager', 'manager', 'synthetic-account-manager-2'], ['administrator', 'administrator', 'synthetic-account-admin'], ['player', 'player', 'synthetic-account-player-01'], ['spectator', 'spectator', 'synthetic-account-spectator'], ['other-player', 'player', 'synthetic-account-player-02']].map(([key, role, accountId]) => {
    const username = `qa-${randomBytes(5).toString('hex')}.${key}`, passcode = randomBytes(24).toString('base64url'), salt = randomBytes(16).toString('base64url');
    secrets.add(username); secrets.add(passcode);
    return { key, role, accountId, username, passcode, salt, hash: scryptSync(passcode, Buffer.from(salt, 'base64url'), 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }).toString('hex') };
  });
  for (const account of accounts) assert(!javascript.includes(account.passcode) && !javascript.includes(account.username), 'Generated credentials must not be bundled.');
  const verifierFile = path.join(privateDirectory, 'verifiers.json'), databasePath = path.join(privateDirectory, 'service.sqlite'), fixtureManifest = path.join(privateDirectory, 'fixture.json');
  await writeFile(verifierFile, JSON.stringify({ version: 1, sessionTtlSeconds: 3600, accounts: accounts.map(({ username, accountId, salt, hash }) => ({ username, accountId, salt, hash })) }), { mode: 0o600 });
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (key.startsWith('LONGBALL_') || /^PG(?:HOST|PORT|USER|DATABASE|PASSWORD|PASSFILE|SERVICE|SERVICEFILE|SSLMODE)$/.test(key) || ['DATABASE_URL', 'DATABASE_URL_FILE'].includes(key)) delete environment[key];
  stage = 'owned reducer-completed feedback fixture';
  await exited(launch(process.execPath, ['--import', 'tsx', 'scripts/feature-pass-fixture.ts', databasePath, fixtureManifest], { ...environment, LONGBALL_FEATURE_REVIEW_FIXTURE: '1' }));
  fixture = JSON.parse(await readFile(fixtureManifest, 'utf8')); report.fixture = fixture;
  base = `http://127.0.0.1:${await availablePort()}`;
  Object.assign(environment, { NODE_ENV: 'test', LONGBALL_SYNTHETIC_AUTH: '1', LONGBALL_DEMO_SCENARIO: '1', LONGBALL_DEMO_ACCOUNTS_FILE: verifierFile, LONGBALL_API_HOST: '127.0.0.1', LONGBALL_API_PORT: new URL(base).port, LONGBALL_API_DATABASE: databasePath, LONGBALL_MEDIA_DIRECTORY: path.join(privateDirectory, 'media'), LONGBALL_STATIC_DIRECTORY: webRoot, LONGBALL_API_ORIGINS: base, LONGBALL_OIDC_CONNECT_ORIGINS: `https://raw.githubusercontent.com,${virtualApi}` });
  stage = 'isolated API startup'; await healthy(launch(process.execPath, [apiBundle], environment));
  browser = await chromium.launch({ executablePath: process.env.LONGBALL_CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
  const privateNote = 'QA private match reflection';
  for (const width of [320, 390]) for (const key of ['player', 'administrator', 'manager', 'spectator']) { stage = `${key} ${width}px`; await roleJourney(accounts.find(item => item.key === key), width, privateNote); }
  stage = 'manager planning/cancellation'; await managerFeatures(accounts.find(item => item.key === 'manager'), privateNote);
  stage = 'actual checked-in lineup suggestion'; await actualMatchAutofill(accounts.find(item => item.key === 'manager'));
  stage = 'private feedback access boundaries'; await privacyChecks(accounts, privateNote);
  assert.equal((report.httpFailures ?? []).length, 0, 'The actual UI journey must have no unexpected HTTP failures; intentional direct denial probes are separate.');
  for (const state of states) { assert.deepEqual(state.errors, []); assert.deepEqual(state.transportErrors, []); }
  assert.equal(digest(await readFile(apiBundle)), report.source.apiBundleSha256, 'The actual API bundle must remain unchanged throughout the review.');
  assert.equal(digest(await readFile(path.join(webRoot, scriptPath.replace(/^\//, '')))), report.source.webJavaScriptSha256, 'The actual browser bundle must remain unchanged throughout the review.');
  assert.equal(digest(await readFile(new URL(import.meta.url))), report.source.harnessSha256, 'The feature harness must remain unchanged throughout the review.');
  report.passed = true;
} catch (error) {
  report.failures.push({ stage, name: sanitise(error.name), message: sanitise(error.message) }); report.processDiagnostic = sanitise(processDiagnostic); process.exitCode = 1;
} finally {
  clearTimeout(watchdog); for (const state of states) state.closed = true;
  await browser?.close().catch(() => undefined); for (const child of [...children].reverse()) await stop(child);
  if (privateDirectory) await rm(privateDirectory, { recursive: true, force: true });
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'report.json'), sanitise(JSON.stringify(report, null, 2), Infinity) + '\n');
}
console.log(JSON.stringify({ passed: report.passed, roleJourneys: report.roles.length, checks: checks.length, failures: report.failures, report: '.local/quality/feature-pass-review/report.json' }));
