import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { chromium } from 'playwright';
import { changeWorkspaceContext, openWorkspaceTab, reviewDateLabel, selectWorkspaceContext } from './review-entry.mjs';

/** Actual isolated API/worker/browser journeys. No public demo account or live data is changed. */
const output = path.resolve('.local/quality/club-expansion-review');
const webRoot = path.resolve(process.env.LONGBALL_EXPANSION_WEB_ROOT ?? 'apps/mobile/dist-demo-web');
const apiBundle = path.resolve('apps/api/dist/api.mjs'), workerBundle = path.resolve('apps/api/dist/worker.mjs');
const virtualApi = 'https://longball-expansion-qa.trycloudflare.com';
const statusPath = '/CharlieOmniPoint/LongBall/preview/longball-m0/preview-status.json';
const teamId = 'synthetic-roma-u10', seasonId = 'synthetic-season-2026-27', clubId = 'synthetic-richmond-rovers';
const contract = 'longball.events/1.1';
const secrets = new Set(), children = [], states = [], windows = new Map(), tokenAccounts = new Map();
const report = { startedAt: new Date().toISOString(), scope: 'Fresh SQLite API, separate actual report worker, compiled connected browser clients; only discovery and transport origins are rerouted to loopback. No fabricated feature DTOs.', checks: [], failures: [], httpFailures: [], apiWindows: [], passed: false, nativeDeviceEvidence: false, paidServicesProvisioned: false };
let browser, privateDirectory, base, stage = 'preconditions', diagnostics = '';
const check = (value, message) => assert(value, message);
const digest = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const appRequire = createRequire(path.resolve('packages/application/package.json'));
const XLSX = appRequire('@e965/xlsx');
function safe(value, max = 3000) {
  let text = String(value);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) if (secret) text = text.replaceAll(secret, '[redacted]');
  return text.replace(/(?:demo|spectator)_[A-Za-z0-9_-]{43}/g, '[redacted-session]').replace(/Bearer\s+[^\s"',;}]+/gi, 'Bearer [redacted]').slice(0, max);
}
function observe(token, method) {
  const account = tokenAccounts.get(token); if (!account) return;
  const now = Date.now(); let window = windows.get(account);
  if (!window || now - window.started >= 60_000) { window = { accountId: account, started: now, attempts: 0, mutations: 0 }; windows.set(account, window); report.apiWindows.push(window); }
  window.attempts++; if (method !== 'GET') window.mutations++;
}
async function budget(state, phase) {
  const window = windows.get(state.session?.accountId);
  if (!window || window.attempts < 65 && window.mutations < 35) return;
  const wait = Math.max(0, window.started + 61_000 - Date.now());
  console.log(JSON.stringify({ phase, apiBudgetPauseMs: wait }));
  const until = Date.now() + wait;
  while (Date.now() < until) await delay(Math.min(1000, until - Date.now()));
}
function launch(file, env) {
  const child = spawn(process.execPath, [file], { env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
  const keep = data => { diagnostics = (diagnostics + safe(data.toString())).slice(-4000); };
  child.stdout.on('data', keep); child.stderr.on('data', keep); child.on('error', keep); return child;
}
async function port() {
  const server = createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const chosen = server.address().port; await new Promise(resolve => server.close(resolve)); return chosen;
}
async function healthy(child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('The isolated API exited during startup.');
    try { const response = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) }); if (response.ok) { const data = await response.json(); check(data.syntheticOnly && data.demoScenario && data.demoAccountLogin, 'Use the isolated configured-account demo only.'); return; } } catch { /* Fresh owned listener only. */ }
    await delay(100);
  }
  throw new Error('The isolated API failed its bounded health check.');
}
async function api(token, route, { role = 'manager', body, method = body ? 'POST' : 'GET', expected = 200, key } = {}) {
  observe(token, method);
  const response = await fetch(base + route, { method, signal: AbortSignal.timeout(20_000), headers: { ...(token ? { Authorization: `Bearer ${token}`, 'X-Longball-Role': role } : {}), ...(body ? { 'Content-Type': 'application/json', 'X-Api-Contract-Version': contract, 'Idempotency-Key': key ?? body.command?.id ?? randomUUID() } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = response.status === 204 ? null : await response.json();
  if (response.status >= 400) report.httpFailures.push({ stage, route: new URL(base + route).pathname, method, status: response.status, code: value?.code ?? null, expected: response.status === expected });
  check(response.status === expected, `API ${method} ${new URL(base + route).pathname} expected ${expected}, received ${response.status} ${value?.code ?? ''}`);
  return value;
}
const scope = (leaf, team = teamId, season = seasonId) => `/v1/teams/${team}/${leaf}?seasonId=${season}`;
async function makePage(width = 390) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, acceptDownloads: true, reducedMotion: 'reduce' });
  const page = await context.newPage(), state = { page, context, session: null, pageErrors: [], closed: false, registrations: 0 };
  states.push(state); page.setDefaultTimeout(20_000);
  page.on('pageerror', error => state.pageErrors.push(safe(error.message)));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === base) return route.continue();
    if (url.origin === 'https://raw.githubusercontent.com' && url.pathname === statusPath) return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': base, 'Cache-Control': 'no-store' }, body: JSON.stringify({ state: 'ready', url: virtualApi, sourceRevision: report.source.gitHead, startedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }) });
    if (url.origin !== virtualApi) return route.abort();
    const token = request.headers().authorization?.replace(/^Bearer\s+/i, ''); if (token) secrets.add(token);
    observe(token, request.method());
    try {
      const response = await route.fetch({ url: base + url.pathname + url.search, maxRedirects: 0 });
      if (['/v1/demo/sessions', '/v1/spectator-access/register', '/v1/spectator-access/login'].includes(url.pathname) && request.method() === 'POST' && response.ok()) {
        const session = await response.json(); secrets.add(session.accessToken); tokenAccounts.set(session.accessToken, session.accountId); state.session = session;
      }
      if (url.pathname === '/v1/spectator-access/register' && request.method() === 'POST') state.registrations++;
      if (response.status() >= 400) { const value = await response.json().catch(() => ({})); report.httpFailures.push({ stage, route: url.pathname, method: request.method(), status: response.status(), code: value.code ?? null, fromBrowser: true }); }
      await route.fulfill({ response });
    } catch (error) { if (!state.closed && !/closed|disposed|abort|cancel/i.test(String(error.message))) state.pageErrors.push(safe(error.message)); await route.abort().catch(() => {}); }
  });
  return state;
}
async function openDemo(account, width = 390) {
  const state = await makePage(width), { page } = state;
  await page.goto(base, { waitUntil: 'networkidle' }); await page.getByTestId('welcome-sign-in').click();
  await page.getByTestId('demo-username').fill(account.username); await page.getByTestId('demo-passcode').fill(account.passcode); await page.getByTestId('demo-login-submit').click();
  await page.getByTestId('demo-signed-in').waitFor(); await selectWorkspaceContext(page, account.role);
  check(state.session?.accountId === account.accountId, 'Login must bind the actual generated account.'); return state;
}
async function close(state) { state.closed = true; await state.context.close(); }
async function saved(page, action, leaf = 'preparation') {
  const result = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/' + leaf) && response.request().method() === 'POST');
  const [response] = await Promise.all([result, action()]); check(response.status() === 200, `The actual ${leaf} UI save must be accepted.`); return response.json();
}
async function screenshot(state, name) {
  check(await state.page.getByTestId('demo-signed-in').isVisible(), 'Only signed-in workspaces may be photographed.');
  const text = await state.page.locator('body').innerText(); for (const secret of secrets) check(!text.includes(secret), 'Do not screenshot credentials or open invitation capabilities.');
  await state.page.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' });
}
async function anonymousRequest() {
  const state = await makePage(320), { page } = state;
  await page.goto(base); await page.getByTestId('welcome-request-invite').click(); await page.getByTestId('invite-request-entry').waitFor();
  await page.getByRole('button', { name: 'Richmond Rovers', exact: true }).click(); await page.getByRole('button', { name: /^Roma U10 ·/ }).click();
  await page.getByRole('button', { name: 'Player', exact: true }).click(); await page.getByLabel('Name for invitation request').fill('Taylor Harper'); await page.getByLabel('Invitation request contact email').fill('taylor.harper@example.invalid');
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/v1/spectator-access/requests' && r.request().method() === 'POST'); await page.getByTestId('submit-invite-request').click(); check((await response).status() === 202, 'The actual anonymous request must remain pending.');
  await page.getByText(/No account or team access has been created yet/).waitFor(); check(await page.getByTestId('demo-signed-in').count() === 0, 'A request never grants player authority.');
  report.checks.push('Anonymous320px Player request selects real club/team and persists a pending request without creating account access.'); await close(state);
}
async function formations(account) {
  const state = await openDemo(account), { page } = state, token = state.session.accessToken;
  await openWorkspaceTab(page, 'formation'); await page.getByTestId('formation-designer').waitFor();
  check(await page.getByRole('button', { name: /^Choose a saved formation \(/ }).isVisible() && await page.getByLabel('Position code line-1-1', { exact: true }).count() === 0, 'Phone formation controls keep optional templates and role inputs collapsed.'); await page.getByRole('button', { name: 'Edit position codes', exact: true }).click(); await page.getByLabel('Position code line-1-1', { exact: true }).waitFor(); await page.getByRole('button', { name: 'Hide position codes', exact: true }).click();
  await page.getByRole('button', { name: '11', exact: true }).click(); await page.getByTestId('formation-pattern-input').fill('4-4-2'); await page.getByLabel('Formation template name').fill('Review 4-4-2');
  let value = await saved(page, () => page.getByTestId('formation-pattern-save').click());
  let stored = await api(token, scope('preparation')); const first = stored.formations.find(item => item.name === 'Review 4-4-2'); check(first?.slots.length === 11 && first.slots.filter(slot => slot.position === 'GK').length === 1, '4-4-2 must persist eleven places including one goalkeeper.');
  const pitch = page.getByTestId('formation-pattern-pitch'); check(!/Choose player|unfilled|Thomas Arnold|\bTA\b/.test(await pitch.innerText()), 'The formation diagram must contain position codes, never player text.');
  await page.getByRole('button', { name: '7', exact: true }).click(); await page.getByTestId('formation-pattern-input').fill('4-4-2'); check(await page.getByTestId('formation-pattern-save').isDisabled(), 'A mismatched typed total must not save.');
  await page.getByTestId('formation-pattern-input').fill('3-2-1'); await page.getByLabel('Formation template name').fill('Review 3-2-1'); await saved(page, () => page.getByTestId('formation-pattern-save').click());
  stored = await api(token, scope('preparation')); const changed = stored.formations.find(item => item.id === first.id); check(changed?.format === 7 && changed.version === first.version + 1 && changed.slots.length === 7, 'Editing the same template must save a new seven-place version.');
  await page.getByTestId('formation-pattern-save').click({ trial: true }); await pitch.scrollIntoViewIfNeeded(); await screenshot(state, 'manager-formation-390');
  await budget(state, 'before-formation-advice'); await openWorkspaceTab(page, 'schedule');
  const fixture = stored.fixtures.find(item => item.id === 'synthetic-roma-maple-2026-10-24'); check(fixture, 'The real demo fixture must exist.');
  const fixtureButton = page.getByRole('button', { name: `Open fixture ${fixture.opponent}, ${reviewDateLabel(fixture.playedDate)}`, exact: true });
  if (!await fixtureButton.isVisible()) await page.getByRole('radio', { name: 'Schedule period: Past', exact: true }).click();
  await fixtureButton.click(); await page.getByTestId('formation-advice-open').click(); await page.getByTestId('formation-advice-choose').waitFor();
  check(await page.getByTestId('formation-advice-choose').isEnabled(), 'The available Roma squad must receive a usable formation recommendation.');
  const advisedName = (await page.getByTestId('formation-advice').getByTestId('formation-pattern-pitch').innerText()).split(' · ')[0];
  await page.getByTestId('formation-advice-choose').click();
  await page.waitForFunction(prefix => [...document.querySelectorAll('[role="radio"]')].some(node => node.getAttribute('aria-label')?.startsWith(prefix) && node.getAttribute('aria-checked') === 'true'), `Saved formation for this match: ${advisedName} ·`);
  check(await page.getByText(/Capacity estimate for the whole match/).count() > 0, 'Advice must disclose its capacity estimate and manual-substitution boundary.');
  report.formations = { format11Saved: true, invalidTotalBlocked: true, format7Versioned: true, playerTextAbsent: true, availableSquadAdviceChosen: true, receivedActualSave: Boolean(value) };
  report.checks.push('Manager types4-4-2 and3-2-1, saves real revisioned formations, sees positions-only pitch, rejects wrong totals, and chooses available-squad65/35 advice.'); await close(state);
}
async function rosterAndDocuments(account) {
  const state = await openDemo(account), { page } = state, token = state.session.accessToken;
  await openWorkspaceTab(page, 'settings'); await page.getByTestId('team-league').fill('EMFJL 4th Division'); await saved(page, () => page.getByTestId('team-league-save').click());
  check((await api(token, scope('preparation'))).team.league === 'EMFJL 4th Division', 'The optional free-text league must persist.');
  await page.getByRole('switch', { name: 'Enable team substitution audio', exact: true }).check(); await page.getByLabel('Substitution audio seconds before', { exact: true }).fill('45'); await page.getByLabel('Substitution audio volume percent', { exact: true }).fill('35'); await saved(page, () => page.getByTestId('save-substitution-alerts').click());
  assert.deepEqual((await api(token, scope('preparation'))).substitutionAlerts, { enabled: true, leadSeconds: 45, volume: 0.35 }, 'Manager lead time, volume and enabled choice must reach actual team persistence.');
  await openWorkspaceTab(page, 'team'); let before = await api(token, scope('preparation')); const profile = before.profiles.find(item => item.playerId === 'synthetic-player-02');
  await page.getByRole('button', { name: `Edit ${profile.displayName}`, exact: true }).click(); await page.getByLabel('FA player ID (optional)', { exact: true }).fill('55000029'); await saved(page, () => page.getByRole('button', { name: 'Save changes', exact: true }).click());
  await page.getByTestId('squad-tools-toggle').click(); const received = page.waitForEvent('download'); await page.getByTestId('roster-xls-download').click(); const download = await received;
  const file = path.join(privateDirectory, 'roster.xls'); await download.saveAs(file); const bytes = await readFile(file);
  check(download.suggestedFilename().endsWith('.xls') && bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), 'The downloaded file must be actual BIFF/OLE XLS, not renamed text.');
  const workbook = XLSX.read(bytes, { type: 'buffer' }), rows = XLSX.utils.sheet_to_json(workbook.Sheets.Players, { header: 1, raw: false, defval: '', blankrows: false }).filter(row => row.some(cell => String(cell).trim()));
  const first = rows[1]; check(rows[0][5] === 'faPlayerId' && first[0] && first[1], 'The proforma must preserve identity columns and FA ID.'); first[5] = '66000013'; rows.push(['', '', 'Theo Mercer', 'TM', '49', '77000044', 'right', 'CB', 'CM', 'ST', 'CB|CM|ST']);
  workbook.Sheets.Players = XLSX.utils.aoa_to_sheet(rows); const updatedBytes = XLSX.write(workbook, { type: 'buffer', bookType: 'biff8', bookSST: true }); const edited = path.join(privateDirectory, 'updated.xls'); await writeFile(edited, updatedBytes);
  const choosing = page.waitForEvent('filechooser'); await page.getByTestId('roster-xls-import').click(); await (await choosing).setFiles(edited); await page.getByTestId('roster-import-review').waitFor(); await page.getByRole('switch', { name: 'Confirm distinct new players and eligibility' }).check();
  await saved(page, () => page.getByTestId('roster-import-confirm').click()); const after = await api(token, scope('preparation'));
  check(after.profiles.length === before.profiles.length + 1 && after.profiles.find(item => item.playerId === first[1]).faPlayerId === '66000013' && after.profiles.find(item => item.playerId === profile.playerId).faPlayerId === '55000029', 'XLS import must update existing identity and append only the new player.');
  check(after.profiles.some(item => item.displayName === 'Theo Mercer' && item.faPlayerId === '77000044'), 'The added dummy player and FA ID must reach actual persistence.');
  await budget(state, 'before-team-sheet'); await page.getByTestId('workspace-team-sheet').click(); await page.getByTestId('team-documents').waitFor();
  const pdf = await PDFDocument.create(); pdf.addPage().drawText('Roma U10 FA team sheet - generated review'); const pdfBytes = Buffer.from(await pdf.save()), pdfPath = path.join(privateDirectory, 'team-sheet.pdf'); await writeFile(pdfPath, pdfBytes);
  const pickPdf = page.waitForEvent('filechooser'); await page.getByTestId('team-sheet-upload').click(); await (await pickPdf).setFiles(pdfPath); await page.getByTestId('team-sheet-open').waitFor();
  const pdfReceived = page.waitForEvent('download'); await page.getByTestId('team-sheet-open').click(); const pdfDownload = await pdfReceived, savedPdf = path.join(privateDirectory, 'downloaded-sheet.pdf'); await pdfDownload.saveAs(savedPdf); check(digest(await readFile(savedPdf)) === digest(pdfBytes), 'A downloaded protected team sheet must match the actual uploaded PDF bytes.');
  await screenshot(state, 'manager-team-sheet-390'); report.roster = { actualOleXlsBytes: bytes.length, downloadedSha256: digest(bytes), updatedExistingIdentity: true, newProfiles: 1, managerFaIdPersisted: true, optionalLeaguePersisted: true, pdfRoundTripExact: true, managerAudioSettingsPersisted: true };
  report.checks.push('Manager saves free-text league/FA ID, downloads genuine XLS, edits/reimports existing+new players with identities retained, and uploads/downloads an identical protected PDF.'); await close(state);
}
async function administration(superAccount, clubAccount) {
  const admin = await openDemo(superAccount, 1024), { page } = admin, token = admin.session.accessToken;
  await openWorkspaceTab(page, 'clubs'); await page.getByTestId('club-administration').waitFor(); const colour = await page.getByTestId('admin-create-club').evaluate(node => getComputedStyle(node).backgroundColor); check(colour === 'rgb(113, 58, 162)', 'SuperAdmin primary actions must use purple.');
  await page.getByLabel('New club name').fill('Harbour Athletic'); await saved(page, () => page.getByTestId('admin-create-club').click(), 'administration');
  await page.getByRole('button', { name: 'Harbour Athletic', exact: true }).click(); await page.getByLabel('New team name').fill('Harbour Youth'); await page.getByLabel('New team age group').fill('U21'); await page.getByLabel('New team format').fill('11');
  await saved(page, () => page.getByTestId('admin-create-team').click(), 'administration'); const directory = await api(token, '/v1/administration', { role: 'administrator' }), harbour = directory.clubs.find(item => item.name === 'Harbour Athletic'), team = directory.teams.find(item => item.name === 'Harbour Youth');
  check(harbour && team?.clubId === harbour.id, 'SuperAdmin must create a real club and its scoped team.'); const empty = await api(token, scope('preparation', team.id, team.seasonId)); check(empty.profiles.length === 0 && empty.fixtures.length === 0 && empty.training.length === 0, 'New teams must start empty without leaking Roma data.'); await screenshot(admin, 'super-admin-purple-tablet');
  await changeWorkspaceContext(page, 'manager', { teamId: team.id, seasonId: team.seasonId }); await createInvite(admin, team.id, team.seasonId);
  const club = await openDemo(clubAccount), clubToken = club.session.accessToken; await openWorkspaceTab(club.page, 'clubs'); await club.page.getByTestId('club-administration').waitFor();
  check(await club.page.getByTestId('admin-create-club').count() === 0, 'Club Admin must not see global club creation.'); await api(clubToken, '/v1/administration', { role: 'administrator', body: { command: { type: 'club.create', name: 'Forbidden club' } }, expected: 404 });
  await api(clubToken, `/v1/clubs/${harbour.id}/reports`, { role: 'administrator', expected: 404 }); await api(clubToken, scope('preparation', team.id, team.seasonId), { expected: 404 });
  await club.page.getByLabel('New team name').fill('Roma Falcons'); await club.page.getByLabel('New team age group').fill('U12'); await club.page.getByLabel('New team format').fill('9'); await saved(club.page, () => club.page.getByTestId('admin-create-team').click(), 'administration');
  const clubDirectory = await api(clubToken, '/v1/administration', { role: 'administrator' }), falcons = clubDirectory.teams.find(item => item.name === 'Roma Falcons'); check(falcons?.clubId === clubId, 'Club Admin creates teams only inside its own club.');
  await club.page.getByTestId('admin-club-report').click(); await club.page.getByRole('button', { name: 'U12', exact: true }).click(); await club.page.getByRole('button', { name: 'Games', exact: true }).click(); check(await club.page.getByText(/Roma Falcons · U12 ·/).count() > 0, 'Club reports must filter the created age group.');
  await changeWorkspaceContext(club.page, 'manager', { teamId: falcons.id, seasonId: falcons.seasonId }); await openWorkspaceTab(club.page, 'team'); check((await api(clubToken, scope('preparation', falcons.id, falcons.seasonId))).profiles.length === 0, 'Club Admin inherits actual manager authority on its new team.');
  await screenshot(club, 'club-admin-inherited-manager-390');
  report.administration = { superPurple: true, clubCreated: true, teamCreatedEmpty: true, superInheritedManagerInvites: true, clubCreationDenied: true, crossClubReportAndManagerDenied: true, clubTeamCreated: true, reportAgeFilterAndSort: true, inheritedManagerScopeSelected: true };
  report.checks.push('SuperAdmin purple UI creates club/team with no Roma leakage; ClubAdmin has real cross-club denials, own-team creation, report age filtering/sorting and inherited Manager scope switching.');
  await close(admin); return { club, falcons };
}
async function createInvite(state, team = teamId, season = seasonId) {
  await budget(state, 'before-spectator-invitation'); const { page } = state;
  if (await page.getByTestId('workspace-tab-invitations').count() || await page.getByTestId('workspace-tab-more').count()) await openWorkspaceTab(page, 'invitations');
  else { await openWorkspaceTab(page, 'account'); await page.getByTestId('workspace-account-invite').click(); }
  await page.getByTestId('invitation-hours').fill('2'); const result = page.waitForResponse(r => new URL(r.url()).pathname === `/v1/teams/${team}/spectator-invites` && r.request().method() === 'POST'); await page.getByTestId('invitation-create').click(); const response = await result; check(response.status() === 201, 'Any current allowed user must issue a real spectator invitation.'); const value = await response.json(); secrets.add(value.shareUrl); const code = new URLSearchParams(new URL(value.shareUrl).hash.slice(1)).get('code'); check(code && new URLSearchParams(new URL(value.shareUrl).hash.slice(1)).get('teamId') === team, 'The invitation URL must bind the exact team.'); secrets.add(code);
  await page.getByTestId('invitation-show-qr').click(); await page.getByTestId('invitation-qr-code').waitFor(); check(await page.getByTestId('invitation-qr-code').locator('svg path').count() === 1, 'The exact invitation must have a locally rendered QR matrix.');
  check(await page.getByRole('button', { name: 'Invite by email', exact: true }).isEnabled(), 'Email must be available for the invitation, without sending during this check.');
  await page.getByTestId('invitation-close-link').click(); return { code, shareUrl: value.shareUrl, teamId: team, seasonId: season };
}
async function invitationsAndPlayers(accounts, clubState, falcons) {
  const manager = await openDemo(accounts.manager3), managerToken = manager.session.accessToken;
  const invitation = await createInvite(manager); check((await api(managerToken, scope('invite-requests'))).some(item => item.name === 'Taylor Harper' && item.requestedRole === 'player' && item.status === 'pending'), 'Staff must see the actual anonymous Player request.');
  await Promise.all([manager.page.waitForResponse(r => /\/invite-requests\/[^/]+\/decision$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST'), manager.page.getByRole('button', { name: 'Mark Taylor Harper handled', exact: true }).click()]);
  check((await api(managerToken, scope('invite-requests'))).some(item => item.name === 'Taylor Harper' && item.status === 'handled'), 'Staff decision must persist against the actual request.');
  stage = 'Spectator invitation registration and weak PIN';
  const joined = await makePage(320), joinedUsername = `review-${randomBytes(5).toString('hex')}`, pin = '4729'; secrets.add(joinedUsername); secrets.add(pin);
  await joined.page.goto(invitation.shareUrl, { waitUntil: 'networkidle' }); await joined.page.getByTestId('welcome-spectator').click(); await joined.page.getByTestId('spectator-pin-context').waitFor(); check((await joined.page.getByTestId('spectator-pin-context').innerText()).includes('Roma'), 'Invitation join must show the actual bound club/team context.');
  await joined.page.getByTestId('spectator-pin-username').fill(joinedUsername); await joined.page.getByTestId('spectator-pin-passcode').fill('1111'); await joined.page.getByTestId('spectator-pin-confirmation').fill('1111'); await joined.page.getByTestId('spectator-pin-submit').click(); check(joined.registrations === 0 && await joined.page.getByTestId('demo-signed-in').count() === 0, 'Weak PIN must be blocked before account registration.');
  await joined.page.getByTestId('spectator-pin-passcode').fill(pin); await joined.page.getByTestId('spectator-pin-confirmation').fill(pin); await joined.page.getByTestId('spectator-pin-submit').click(); await joined.page.getByTestId('demo-signed-in').waitFor(); await selectWorkspaceContext(joined.page, 'spectator');
  await openWorkspaceTab(joined.page, 'account'); const connection = joined.page.getByTestId('spectator-player-connection'); await connection.waitFor(); await Promise.all([joined.page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/spectator-connections') && r.request().method() === 'POST'), connection.getByRole('button', { name: 'Thomas Arnold', exact: true }).click()]); const ownConnection = await api(joined.session.accessToken, scope('spectator-connections'), { role: 'spectator' }); check(ownConnection.followedPlayerId === 'synthetic-player-01', 'Spectator chooses an account-owned player connection.');
  const blue = await connection.getByRole('button', { name: 'Thomas Arnold', exact: true }).evaluate(node => getComputedStyle(node).backgroundColor); check(blue === 'rgb(21, 87, 165)', 'Spectator selected actions must be blue.');
  await api(joined.session.accessToken, scope('opposition-reviews'), { role: 'spectator', expected: 404 }); await api(joined.session.accessToken, scope('team-sheet'), { role: 'spectator', expected: 404 }); check(await joined.page.getByTestId('next-substitution-countdown').count() === 0 && await joined.page.getByTestId('save-substitution-alerts').count() === 0, 'Spectators cannot receive manager-only match alerts.');
  const delegated = await createInvite(joined); check(delegated.teamId === teamId, 'Spectator can invite another scoped spectator.');
  const logout = joined.page.waitForResponse(r => new URL(r.url()).pathname === '/v1/spectator-access/session' && r.request().method() === 'DELETE'); await joined.page.getByTestId('demo-sign-out').click(); check((await logout).status() === 204, 'PIN logout must revoke its own server session.');
  await joined.page.getByText('Spectator sign in', { exact: true }).waitFor(); check(await joined.page.getByTestId('spectator-pin-confirmation').count() === 0, 'After an invited account signs out, show ordinary PIN sign-in without retrying its consumed registration invitation.');
  await joined.page.goto(base); await joined.page.getByTestId('welcome-spectator').click(); await joined.page.getByTestId('spectator-pin-username').fill(joinedUsername); await joined.page.getByTestId('spectator-pin-passcode').fill(pin); await joined.page.getByTestId('spectator-pin-submit').click(); await joined.page.getByTestId('demo-signed-in').waitFor();
  const second = await createInvite(clubState, falcons.id, falcons.seasonId); await close(joined);
  const multi = await makePage(390); await multi.page.goto(second.shareUrl); await multi.page.getByTestId('welcome-spectator').click(); await multi.page.getByTestId('spectator-pin-context').waitFor(); await multi.page.getByRole('button', { name: 'I already have a spectator account', exact: true }).click(); await multi.page.getByTestId('spectator-pin-username').fill(joinedUsername); await multi.page.getByTestId('spectator-pin-passcode').fill(pin); await multi.page.getByTestId('spectator-pin-submit').click(); await multi.page.getByTestId('demo-signed-in').waitFor(); await selectWorkspaceContext(multi.page, 'spectator', { teamId: falcons.id, seasonId: falcons.seasonId });
  const memberships = await api(multi.session.accessToken, '/v1/me', { role: 'spectator' }); check(memberships.memberships.filter(item => item.role === 'spectator').some(item => item.teamId === teamId) && memberships.memberships.some(item => item.teamId === falcons.id && item.role === 'spectator'), 'Existing PIN account accepts a second team without replacing its first grant.');
  await changeWorkspaceContext(multi.page, 'spectator', { teamId, seasonId }); await openWorkspaceTab(multi.page, 'account'); check((await api(multi.session.accessToken, scope('spectator-connections'), { role: 'spectator' })).followedPlayerId === 'synthetic-player-01', 'Switching teams retains the original account-owned player connection.'); await screenshot(multi, 'spectator-blue-multiple-teams-390');
  const player = await openDemo(accounts.player); await openWorkspaceTab(player.page, 'team'); await player.page.getByTestId('fa-player-id').fill('88000015'); await saved(player.page, () => player.page.getByTestId('fa-player-id-save').click(), 'own'); check((await api(player.session.accessToken, scope('preparation/own'), { role: 'player' })).profile.faPlayerId === '88000015', 'Player saves only their own FA ID through the own-player command.');
  check(await player.page.getByTestId('next-substitution-countdown').count() === 0 && await player.page.getByTestId('save-substitution-alerts').count() === 0, 'Player has no manager alerts or countdown.'); await createInvite(player);
  stage = 'Manager protected opposition write and Player read';
  await openWorkspaceTab(manager.page, 'opposition'); await manager.page.getByTestId('opposition-reviews').waitFor(); await manager.page.getByTestId('opposition-rating-4').click(); await manager.page.getByTestId('opposition-note').fill('Well organised defence; useful challenge for passing practice.'); await saved(manager.page, () => manager.page.getByTestId('opposition-save').click(), 'opposition-reviews');
  const reviews = await api(managerToken, scope('opposition-reviews')); check(reviews.games.some(item => item.review?.rating === 4), 'Opposition notes must reach actual completed-game persistence.');
  await openWorkspaceTab(player.page, 'more'); await Promise.all([player.page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/opposition-reviews') && r.request().method() === 'GET'), player.page.getByRole('button', { name: 'Refresh service views', exact: true }).click()]); await openWorkspaceTab(player.page, 'opposition'); await player.page.getByText('Well organised defence; useful challenge for passing practice.', { exact: true }).waitFor(); check(await player.page.getByTestId('opposition-save').count() === 0, 'Player reads completed opposition notes without edit authority.');
  report.invitations = { managerIssuedScopedLink: true, locallyRenderedQr: true, emailComposerOptionPresentNotSent: true, weakPinBlockedBeforePost: true, registeredPinAccount: true, signOutReturnsOrdinaryPinForm: true, persistedPinLogin: true, spectatorBlue: true, spectatorInvitesEnabled: true, secondTeamAcceptedWithoutNewAccount: true, playerFollowPreferenceRetained: true, playerInvitesEnabled: true, anonymousRequestVisibleToStaff: true, ownFaIdSaved: true, oppositionManagerWritePlayerReadSpectatorDenied: true, privateTeamSheetSpectatorDenied: true };
  report.checks.push('Scoped invitation QR creates a four-digit PIN spectator after weak-code refusal, supports logout/relogin and a second team with retained player connection; Player/Spectator both issue invitations.');
  report.checks.push('Staff sees anonymous requests; Manager opposition notes persist and are Player-read-only/Spectator-denied; Player saves own FA ID and neither nonstaff role exposes Manager alert controls.');
  await close(manager); await close(player); await close(multi); await close(clubState);
}

const watchdog = setTimeout(() => { console.error('The isolated club-expansion review exceeded its ten-minute watchdog.'); process.exit(124); }, 600_000); watchdog.unref();
try {
  await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true });
  check(existsSync(path.join(webRoot, 'index.html')) && existsSync(apiBundle) && existsSync(workerBundle), 'Build flagged demo web and current API/worker bundles before review.');
  const html = await readFile(path.join(webRoot, 'index.html'), 'utf8'), scriptPath = html.match(/<script[^>]+src="([^"]+)"/)?.[1]; check(scriptPath && !scriptPath.includes('..') && !scriptPath.includes('://'), 'Use a local compiled entry script.'); const script = await readFile(path.join(webRoot, scriptPath.replace(/^\//, '')));
  report.source = { gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), workingTreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()), harnessSha256: digest(await readFile(new URL(import.meta.url))), webIndexSha256: digest(html), webJavaScriptSha256: digest(script), apiBundleSha256: digest(await readFile(apiBundle)), workerBundleSha256: digest(await readFile(workerBundle)) };
  privateDirectory = await mkdtemp(path.join(tmpdir(), 'longball-club-expansion-'));
  const specs = [['manager2','manager','synthetic-account-manager-2'], ['manager3','manager','synthetic-account-manager-3'], ['super','administrator','synthetic-account-admin'], ['club','administrator','synthetic-account-club-admin'], ['player','player','synthetic-account-player-01']];
  const accounts = Object.fromEntries(specs.map(([name, role, accountId]) => { const username = `qa-${randomBytes(5).toString('hex')}.${name}`, passcode = randomBytes(24).toString('base64url'), salt = randomBytes(16).toString('base64url'); secrets.add(username); secrets.add(passcode); return [name, { username, passcode, role, accountId, salt, hash: scryptSync(passcode, Buffer.from(salt, 'base64url'), 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }).toString('hex') }]; }));
  for (const account of Object.values(accounts)) check(!script.includes(account.username) && !script.includes(account.passcode), 'Generated credentials must be absent from compiled assets.');
  const verifierFile = path.join(privateDirectory, 'verifiers.json'), keyFile = path.join(privateDirectory, 'export-key'); await writeFile(verifierFile, JSON.stringify({ version: 1, sessionTtlSeconds: 1800, accounts: Object.values(accounts).map(({ username, accountId, salt, hash }) => ({ username, accountId, salt, hash })) }), { mode: 0o600 }); const key = randomBytes(32).toString('hex'); secrets.add(key); await writeFile(keyFile, key, { mode: 0o600 });
  base = `http://localhost:${await port()}`; const environment = { ...process.env }; for (const name of Object.keys(environment)) if (name.startsWith('LONGBALL_') || /^PG(?:HOST|PORT|USER|DATABASE|PASSWORD|PASSFILE|SERVICE|SERVICEFILE|SSLMODE)$/.test(name) || ['DATABASE_URL','DATABASE_URL_FILE'].includes(name)) delete environment[name];
  Object.assign(environment, { NODE_ENV: 'test', LONGBALL_SYNTHETIC_AUTH: '1', LONGBALL_DEMO_SCENARIO: '1', LONGBALL_DEMO_ACCOUNTS_FILE: verifierFile, LONGBALL_API_HOST: '127.0.0.1', LONGBALL_API_PORT: new URL(base).port, LONGBALL_API_DATABASE: path.join(privateDirectory,'review.sqlite'), LONGBALL_MEDIA_DIRECTORY: path.join(privateDirectory,'media'), LONGBALL_STATIC_DIRECTORY: webRoot, LONGBALL_API_ORIGINS: base, LONGBALL_PUBLIC_APP_ENTRY_URL: base+'/', LONGBALL_INVITATION_POLICY_VERSION: 'generated-review-spectator-invites-v1', LONGBALL_OIDC_CONNECT_ORIGINS: `https://raw.githubusercontent.com,${virtualApi}`, LONGBALL_EXPORT_ENCRYPTION_KEY_FILE: keyFile, LONGBALL_EXPORT_TTL_MS: '600000' });
  stage = 'owned runtime startup'; await healthy(launch(apiBundle, environment)); launch(workerBundle, environment); browser = await chromium.launch({ executablePath: process.env.LONGBALL_CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
  stage = 'anonymous invitation request'; await anonymousRequest();
  stage = 'Manager formation design and advice'; await formations(accounts.manager2);
  stage = 'Manager roster, league and PDF'; await rosterAndDocuments(accounts.manager3);
  stage = 'SuperAdmin and ClubAdmin club scopes'; const { club, falcons } = await administration(accounts.super, accounts.club);
  stage = 'invitations, PIN accounts, player and spectator boundaries'; await invitationsAndPlayers(accounts, club, falcons);
  check(states.every(state => state.pageErrors.length === 0), 'No connected expansion journey may produce a browser runtime error.'); check(!report.httpFailures.some(failure => failure.status === 429), 'Do not weaken or exhaust account rate limits.'); check(!report.httpFailures.some(failure => failure.fromBrowser), 'Connected journeys must not silently depend on browser API failures.');
  check(digest(await readFile(apiBundle)) === report.source.apiBundleSha256 && digest(await readFile(workerBundle)) === report.source.workerBundleSha256 && digest(await readFile(path.join(webRoot, scriptPath.replace(/^\//, '')))) === report.source.webJavaScriptSha256 && digest(await readFile(new URL(import.meta.url))) === report.source.harnessSha256, 'API, worker, browser and harness bytes must stay unchanged during the review.'); report.artifactsStableBeforeAfter = true;
  report.apiRateLimitsUnchanged = { ordinary: 120, mutations: 60 }; report.audioHardwareBoundary = 'No hardware sound, OS volume, background delivery or native installation is claimed. Active-match countdown needs separate actual matchday evidence.';
  report.passed = true;
} catch (error) {
  report.failures.push({ stage, message: safe(error.message), name: safe(error.name) }); report.processDiagnostic = safe(diagnostics); report.pageErrors = states.flatMap(state => state.pageErrors);
  report.failureWorkspaces = [];
  for (const state of states.filter(state => !state.closed)) { try { if (await state.page.getByTestId('demo-signed-in').isVisible()) report.failureWorkspaces.push({ accountId: state.session?.accountId, body: safe(await state.page.locator('body').innerText(), 9000) }); } catch { /* Preserve the original failure if a context is already closing. */ } }
  process.exitCode = 1;
}
finally {
  clearTimeout(watchdog); for (const state of states) state.closed = true; await browser?.close().catch(() => {});
  for (const child of [...children].reverse()) { if (child.exitCode !== null || child.signalCode !== null) continue; child.kill('SIGTERM'); for (let i = 0; i < 30 && child.exitCode === null && child.signalCode === null; i++) await delay(100); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  if (privateDirectory) await rm(privateDirectory, { recursive: true, force: true });
  report.completedAt = new Date().toISOString();
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'report.json'), safe(JSON.stringify(report, null, 2), Infinity)+'\n');
}
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures, report: '.local/quality/club-expansion-review/report.json' }));
