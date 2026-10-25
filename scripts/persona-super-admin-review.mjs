import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createPersonaReview } from './persona-review-session.mjs';
import { changeWorkspaceContext } from './review-entry.mjs';

const phase = process.env.LONGBALL_PERSONA_PHASE ?? 'baseline';
const final = phase !== 'baseline';
const r = await createPersonaReview({ persona: 'super', name: 'super-admin', phase, width: 390, height: 844 });
const scriptDigest = async () => createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
r.report.scenarioSha256 = await scriptDigest();
let state, stage = 'sign in', completed = false, capabilityDisplayed = false;
const watchdog = setTimeout(() => { void r.finish({ passed: false, error: new Error(`Super Admin review exceeded its nine-minute bound at ${stage}.`) }).finally(() => process.exit(1)); }, 540_000);
const record = text => r.report.checks.push(text);
const settled = () => state.page.waitForFunction(() => !document.querySelector('[data-testid="demo-session-cover"]'));
const reveal = async id => {
  const toggle = state.page.getByTestId(id);
  if (final) await toggle.waitFor();
  if (await toggle.count() && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
};
const saved = async action => {
  await r.budget(state);
  const receipt = state.page.waitForResponse(response => new URL(response.url()).pathname === '/v1/administration' && response.request().method() === 'POST');
  await action();
  assert.equal((await receipt).status(), 200, 'A real administrative mutation must receive its accepted receipt.');
};
async function policyJourney() {
  const { page } = state;
  stage = 'application rules: load, edit, leave, discard/reload';
  await r.openTab(state, 'clubs');
  await page.getByTestId('sign-in-rules-toggle').click();
  const input = page.getByLabel('Minimum password length', { exact: true }); await input.waitFor();
  const original = await r.api('/v1/administration/sign-in-rules', { state });
  const changedMinimum = original.rules.password.minLength === 14 ? 15 : 14;
  const save = page.getByTestId('sign-in-rules-save');
  if (final) assert(await save.isDisabled(), 'An unchanged application policy must not create an unnecessary new revision.');
  else if (!await save.isDisabled()) r.report.findings.push({ id: 'SA02', severity: 'usability', observed: 'Save application rules is enabled before any rule changes.' });
  await input.fill(String(changedMinimum));
  if (final) {
    await page.getByTestId('sign-in-rules-draft-status').waitFor();
    assert(await page.getByTestId('workspace-tab-team').isDisabled(), 'Unsaved global policy edits must be retained before navigation can unmount them.');
    await page.getByTestId('sign-in-rules-reload').click();
    await page.getByTestId('sign-in-rules-confirm-reload').waitFor();
    assert.equal(await input.inputValue(), String(changedMinimum), 'Opening reload review must not overwrite the local draft.');
    await page.getByTestId('sign-in-rules-keep-editing').click();
    assert.equal(await input.inputValue(), String(changedMinimum));
    await page.getByTestId('sign-in-rules-discard').click();
    assert.equal(await input.inputValue(), String(original.rules.password.minLength));
    await page.getByTestId('workspace-tab-team').waitFor({ state: 'visible' });
    assert(!await page.getByTestId('workspace-tab-team').isDisabled(), 'Explicit discard must release ordinary navigation.');
    await input.fill('7');
    assert(await save.isDisabled());
    await page.getByTestId('sign-in-rules-validation').getByText('Minimum password length must be 8–64 characters.', { exact: true }).waitFor();
    assert.equal((await r.api('/v1/administration/sign-in-rules', { state })).revision, original.revision, 'Invalid local input must send no policy update.');
    await page.getByTestId('sign-in-rules-reload').click();
    const loading = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/administration/sign-in-rules' && response.request().method() === 'GET');
    await page.getByTestId('sign-in-rules-confirm-reload').click(); assert.equal((await loading).status(), 200);
    await page.waitForFunction(value => document.querySelector('[aria-label="Minimum password length"]')?.value === String(value), original.rules.password.minLength);
    record('Super Admin unsaved rules survive a reload review, Keep editing preserves the draft, explicit discard/reload releases navigation, and invalid/unchanged policies cannot be submitted.');
  } else {
    await r.openTab(state, 'team'); await r.openTab(state, 'clubs'); await page.getByTestId('sign-in-rules-toggle').click(); await input.waitFor();
    assert.equal(await input.inputValue(), String(original.rules.password.minLength));
    r.report.findings.push({ id: 'SA01', severity: 'data-loss', observed: 'Changing a password rule then navigating away silently loses the unsaved draft. Reload also has no discard review.' });
  }
  stage = 'application rules: committed lost receipt and exact retry';
  await input.fill(String(changedMinimum));
  let intercepted = false, deniedRetry = false; const keys = [], bodies = [];
  await page.route('**/v1/administration/sign-in-rules', async route => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fallback();
    const key = request.headers()['idempotency-key']; keys.push(key); bodies.push(JSON.parse(request.postData()));
    if (intercepted && final && !deniedRetry) {
      deniedRetry = true;
      r.report.httpFailures.push({ method: 'POST', path: '/v1/administration/sign-in-rules', status: 403, code: 'CONTROLLED_CURRENT_AUTHORITY_DENIED', expected: true, controlledFault: true });
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: 'CONTROLLED_CURRENT_AUTHORITY_DENIED', message: 'The isolated review withheld this retry without an origin write.' }) });
    }
    if (intercepted) return route.fallback(); intercepted = true;
    await r.api('/v1/administration/sign-in-rules', { state, body: JSON.parse(request.postData()), key });
    r.report.httpFailures.push({ method: 'POST', path: '/v1/administration/sign-in-rules', status: 503, code: 'CONTROLLED_POLICY_RECEIPT_LOST', expected: true, controlledFault: true });
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'CONTROLLED_POLICY_RECEIPT_LOST', message: 'The receipt was deliberately withheld by the isolated review.' }) });
  });
  await save.click(); await page.getByText('The service has not confirmed this update. Retry the same update when connected.', { exact: true }).waitFor();
  assert(!await input.isEditable()); assert(await page.getByTestId('workspace-tab-team').isDisabled());
  if (final) {
    const rejected = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/administration/sign-in-rules' && response.request().method() === 'POST' && response.status() === 403);
    await save.click(); await rejected;
    await page.getByText('The service has not confirmed this update. Retry the same update when connected.', { exact: true }).waitFor();
    assert(!await input.isEditable()); assert(await page.getByTestId('workspace-tab-team').isDisabled(), 'A later denied retry cannot prove that the original unconfirmed update did not commit.');
    stage = 'retained policy: wrong-account rejection and actual same-account verification';
    const previousSession = state.session;
    await page.getByTestId('workspace-verify-sign-in').click();
    await page.getByTestId('demo-session-verification').waitFor();
    await page.getByTestId('demo-verify-username').fill(r.accounts.manager.username);
    await page.getByTestId('demo-verify-passcode').fill(r.accounts.manager.passcode);
    const wrongIssued = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/demo/sessions' && response.request().method() === 'POST' && response.status() === 200);
    await page.getByTestId('demo-verify-submit').click(); await wrongIssued;
    await page.getByText('Please verify the account that is already open.', { exact: true }).waitFor();
    const rejectedSession = state.session; assert.equal(rejectedSession.accountId, r.accounts.manager.accountId);
    assert(await page.getByTestId('demo-session-verification').isVisible());
    await r.api('/v1/me', { state, token: rejectedSession.accessToken, role: 'manager', expected: 401 });
    // The transport observer sees every issued session. The application correctly did not adopt this one.
    state.session = previousSession;
    await page.getByTestId('demo-verify-username').fill(state.account.username);
    await page.getByTestId('demo-verify-passcode').fill(state.account.passcode);
    const previousRevoked = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/demo/sessions/current' && response.request().method() === 'DELETE' && response.request().headers().authorization === `Bearer ${previousSession.accessToken}`);
    const [, , revoked] = await Promise.all([
      page.getByTestId('demo-verify-submit').click(),
      page.getByTestId('demo-session-verification').waitFor({ state: 'detached' }),
      previousRevoked,
    ]);
    assert.equal(revoked.status(), 204); await settled();
    assert.equal(state.session.accountId, state.account.accountId); assert.notEqual(state.session.accessToken, previousSession.accessToken);
    await r.api('/v1/me', { state, token: previousSession.accessToken, expected: 401 });
    assert.equal(await input.inputValue(), String(changedMinimum));
    assert(!await input.isEditable()); assert(await page.getByTestId('workspace-tab-team').isDisabled(), 'A renewed same-account session must retain the exact mounted policy request.');
    record('Real verification rejects and revokes a valid different-account session, then verifies the original generated account on the pinned service, revokes its old token and preserves the mounted unconfirmed policy request.');
  }
  const receipt = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/administration/sign-in-rules' && response.request().method() === 'POST' && response.status() === 200);
  await save.click(); await receipt; await page.getByText('Application sign-in rules saved. Existing accounts keep their current login details.', { exact: true }).waitFor();
  await page.unroute('**/v1/administration/sign-in-rules');
  assert.equal(keys.length, final ? 3 : 2); assert(keys[0] && keys.every(key => key === keys[0]));
  for (const body of bodies) assert.deepEqual(body, bodies[0], 'Every retained retry must send its original policy body.');
  const updated = await r.api('/v1/administration/sign-in-rules', { state });
  assert.equal(updated.revision, original.revision + 1); assert.equal(updated.rules.password.minLength, changedMinimum);
  await r.budget(state);
  await r.api('/v1/administration/sign-in-rules', { state, body: { expectedRevision: updated.revision, rules: original.rules } });
  await page.getByRole('button', { name: 'Reload current rules', exact: true }).click();
  await page.waitForFunction(value => document.querySelector('[aria-label="Minimum password length"]')?.value === String(value), original.rules.password.minLength);
  assert.equal((await r.api('/v1/administration/sign-in-rules', { state })).rules.password.minLength, original.rules.password.minLength);
  record(final ? 'An actual committed policy with a deliberately lost receipt retains its original payload/key after a controlled non-committing403 retry denial and real same-account verification; a final same-key origin receipt creates only one revision. The denial is injected transport evidence, not an actual five-minute expiry test. Original rules are restored.' : 'An actual committed policy with a deliberately lost receipt retains its original payload/key, retries exactly once, creates one revision, and restores the original saved rules.');
  await r.screenshot('super-policy-phone', state);
}
async function activityJourney() {
  stage = 'application activity reports'; const { page } = state;
  await r.openTab(state, 'clubs'); await page.getByTestId('workspace-tab-loginActivity').click();
  await page.getByTestId('login-activity-dashboard').waitFor(); await page.getByTestId('login-activity-metric-active').waitFor();
  await page.getByTestId('login-activity-filters-toggle').click(); await page.getByTestId('login-activity-club').click();
  const all = page.getByRole('button', { name: 'Choose club All clubs', exact: true }); await all.waitFor();
  const pressed = await all.getAttribute('aria-pressed');
  if (final) assert.equal(pressed, 'true', 'The selected global filter option must expose proper pressed state.');
  else if (pressed !== 'true') r.report.findings.push({ id: 'SA03', severity: 'accessibility', observed: 'Selected activity club/team options show a check visually but expose no browser pressed state.' });
  await all.click();
  if (final) {
    const directory = await r.api('/v1/administration/login-analytics', { state });
    const team = directory.directory.teams.find(row => row.id === r.teamId); assert(team);
    const club = directory.directory.clubs.find(row => row.id === team.clubId); assert(club);
    const scopedRead = async (parameter, expected, action) => {
      const response = page.waitForResponse(receipt => {
        const url = new URL(receipt.url());
        return url.pathname === '/v1/administration/login-analytics' && receipt.request().method() === 'GET' && url.searchParams.get(parameter) === expected;
      });
      const [, receipt] = await Promise.all([action(), response]); assert.equal(receipt.status(), 200);
      const result = await receipt.json(); assert.equal(result.filters[parameter], expected);
      await page.getByTestId('login-activity-metric-active').waitFor();
      return result;
    };
    await page.getByTestId('login-activity-club').click();
    await scopedRead('clubId', club.id, () => page.getByRole('button', { name: `Choose club ${club.name}`, exact: true }).click());
    await page.getByTestId('login-activity-team').click();
    const filtered = await scopedRead('teamId', team.id, () => page.getByRole('button', { name: `Choose team ${team.name} · ${team.ageGroup}`, exact: true }).click());
    assert.equal(filtered.filters.clubId, club.id);
    assert(filtered.events.every(event => event.scopes.some(scope => scope.teamId === team.id && scope.clubId === club.id)), 'A selected-team event report must not include unrelated event scopes.');
    for (const range of ['24h', '30d', '7d']) await scopedRead('range', range, () => page.getByTestId(`login-activity-range-${range}`).click());
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await page.getByTestId('login-activity-metric-active').waitFor();
    record('Actual activity requests retain the chosen club/team scope, return only attributed team events, and support 24-hour, 30-day and 7-day ranges.');
  }
  await page.getByTestId('login-activity-role-manager').click();
  await page.getByTestId('login-activity-role-manager').waitFor();
  await page.getByTestId('login-activity-view-events').click();
  await page.getByTestId('login-activity-events').waitFor();
  await page.getByTestId('login-activity-event-logout').click();
  await page.getByTestId('login-activity-event-logout').waitFor();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.getByTestId('login-activity-view-users').click(); await page.getByTestId('login-activity-users').waitFor();
  await page.getByTestId('login-activity-view-overview').click();
  const value = await r.api('/v1/administration/login-analytics', { state });
  assert(value.summary.signIns >= 1); assert(value.coverage.startedAt !== null); assert(value.summary.activeAccounts >= 1);
  const body = await page.getByTestId('login-activity-dashboard').innerText(); assert.match(body, /Updated .*UK time/);
  await r.screenshot('super-activity-phone', state);
  record('Super Admin opens global activity, selects account/event filters, clears them and visits active/events/overview panels with real observed sign-in coverage and a UK-time successful receipt.');
}
async function globalAdministration() {
  stage = 'global club creation, team creation and privilege review'; const { page } = state;
  await r.openTab(state, 'clubs'); await page.getByTestId('club-administration').waitFor();
  await reveal('admin-club-form-toggle');
  await page.getByLabel('New club name', { exact: true }).fill('Seabrook Athletic');
  await saved(() => page.getByTestId('admin-create-club').click());
  await page.getByRole('button', { name: 'Seabrook Athletic', exact: true }).click();
  await reveal('admin-team-form-toggle');
  await page.getByLabel('New team name', { exact: true }).fill('Seabrook Falcons');
  await page.getByLabel('New team age group', { exact: true }).fill('U12');
  await page.getByLabel('New team format', { exact: true }).fill('9');
  await saved(() => page.getByTestId('admin-create-team').click());
  let directory = await r.api('/v1/administration', { state });
  const club = directory.clubs.find(row => row.name === 'Seabrook Athletic'), team = directory.teams.find(row => row.name === 'Seabrook Falcons');
  assert(club && team && team.clubId === club.id);
  const empty = await r.api(`/v1/teams/${team.id}/preparation?seasonId=${team.seasonId}`, { state, role: 'manager' });
  assert.equal(empty.profiles.length, 0); assert.equal(empty.fixtures.length, 0);
  await reveal('admin-access-toggle');
  const candidate = directory.candidates.find(row => row.accountId === r.accounts.manager.accountId); assert(candidate);
  if (final) assert.equal(candidate.label, 'Priya Shah', 'The verified review adult chooser must use its existing human display label rather than an opaque provider subject.');
  const search = page.getByLabel('Search administrator accounts', { exact: true }); if (await search.count()) await search.fill(candidate.label);
  await page.getByRole('button', { name: candidate.label, exact: true }).click();
  if (final) {
    await page.getByRole('button', { name: 'Grant Club Admin', exact: true }).click();
    const review = page.getByTestId('admin-access-review'); await review.waitFor();
    assert.match(await review.innerText(), /Seabrook Athletic/); assert((await review.innerText()).includes(candidate.label));
    assert(!(await r.api('/v1/administration', { state })).administrators.some(row => row.accountId === candidate.accountId && row.clubId === club.id));
    await page.getByRole('button', { name: 'Cancel access review', exact: true }).click();
    await page.getByRole('button', { name: 'Grant Club Admin', exact: true }).click();
    await saved(() => page.getByTestId('admin-access-confirm').click());
  } else {
    await saved(() => page.getByRole('button', { name: 'Grant Club Admin', exact: true }).click());
    r.report.findings.push({ id: 'SA04', severity: 'high-impact-usability', observed: 'An administrator grant is sent immediately without a target/scope review.' });
  }
  directory = await r.api('/v1/administration', { state });
  assert(directory.administrators.some(row => row.accountId === candidate.accountId && row.clubId === club.id));
  if (final) {
    await reveal('admin-access-toggle');
    await page.getByRole('button', { name: `Review revoking ${candidate.label} Club Admin access`, exact: true }).click();
    await page.getByTestId('admin-access-review').waitFor();
    await saved(() => page.getByTestId('admin-access-confirm').click());
  } else {
    const row = page.getByRole('button', { name: 'Revoke access', exact: true }).locator('..').filter({ hasText: candidate.label });
    await saved(() => row.getByRole('button', { name: 'Revoke access', exact: true }).click());
  }
  directory = await r.api('/v1/administration', { state }); assert(!directory.administrators.some(row => row.accountId === candidate.accountId && row.clubId === club.id));
  if (final) {
    await page.getByRole('button', { name: candidate.label, exact: true }).click();
    await page.getByRole('button', { name: 'Grant Super Admin', exact: true }).click();
    await page.getByTestId('admin-access-review').getByText('Super Admin access covers every club in LongBall.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Cancel access review', exact: true }).click();
    assert(!(await r.api('/v1/administration', { state })).administrators.some(row => row.accountId === candidate.accountId && row.level === 'super'));
    await page.getByRole('button', { name: 'Grant Super Admin', exact: true }).click();
    await saved(() => page.getByTestId('admin-access-confirm').click());
    assert((await r.api('/v1/administration', { state })).administrators.some(row => row.accountId === candidate.accountId && row.level === 'super'));
    await page.getByRole('button', { name: `Review revoking ${candidate.label} Super Admin access`, exact: true }).click();
    await saved(() => page.getByTestId('admin-access-confirm').click());
    assert(!(await r.api('/v1/administration', { state })).administrators.some(row => row.accountId === candidate.accountId && row.level === 'super'));
    await search.fill('');
    const self = directory.candidates.find(row => row.accountId === r.accounts.super.accountId); assert(self);
    assert(await page.getByRole('button', { name: `Review revoking ${self.label} Super Admin access`, exact: true }).isDisabled(), 'The current Super Admin must not accidentally revoke their own access.');
    record('Club and application-wide privilege changes show target/scope before submission; cancel makes no grant, accepted changes are verified and reversed, and self-revocation remains disabled.');
  }
  await page.getByTestId('admin-club-report').click(); await page.getByText('Seabrook Athletic · recorded completed games', { exact: true }).waitFor();
  await r.screenshot('super-global-clubs-phone', state);
  await changeWorkspaceContext(page, 'manager', { teamId: team.id, seasonId: team.seasonId }); await page.getByTestId('workspace-tab-home').waitFor();
  assert(!(await page.locator('body').innerText()).includes('Thomas Arnold'), 'An empty new team must not inherit Roma player rows.');
  await changeWorkspaceContext(page, 'administrator', { teamId: r.teamId, seasonId: r.seasonId });
  record('Super Admin creates a real isolated club and U12 team, verifies empty-team isolation and inherited Manager access, grants/revokes an existing verified adult, and reviews the new club report.');
}
async function routeInventory() {
  const { page } = state;
  const tabs = [
    ['team', final ? 'administration-team-directory' : 'administrator-configuration'], ['overview', 'team-overview'], ['schedule', 'scheduled-game-management'], ['stats', 'team-player-stats'], ['people', 'connected-staff'],
    ['seasons', 'connected-season-rollover'], ['opposition', 'opposition-reviews'], ['settings', 'club-team-configuration-panels'],
    ['invitations', 'staff-invitation-requests'], ['clubReports', 'club-administration'],
  ];
  for (const [tab, id] of tabs) {
    stage = `Super Admin element ${tab}`; await r.budget(state); await r.openTab(state, tab); await page.getByTestId(id).waitFor();
    r.report.elements ??= []; r.report.elements.push({ route: tab, rendered: true });
  }
  await r.openTab(state, 'account');
  if (!final && !(await page.locator('body').innerText()).match(/help|privacy|request.*data/i)) r.report.findings.push({ id: 'SA05', severity: 'capability-discoverability', observed: 'The demo Account page exposes an opaque ID and invitation/exit, with no account security/help or pending data-request entry.' });
  record('Super Admin visits Teams, overview, schedule, aggregate stats, People, seasons, opposition notes, configuration, invitations/access requests, club reports and Account through the actual compact navigation.');
}
async function invitationJourney() {
  stage = 'Super Admin scoped spectator invitation and local QR'; const { page } = state;
  await r.openTab(state, 'invitations'); await page.getByTestId('connected-invitations').waitFor(); await r.budget(state);
  await page.getByTestId('invitation-hours').fill('1');
  const created = page.waitForResponse(response => new URL(response.url()).pathname === `/v1/teams/${r.teamId}/spectator-invites` && response.request().method() === 'POST');
  await page.getByTestId('invitation-create').click(); const response = await created; assert.equal(response.status(), 201);
  capabilityDisplayed = true;
  const issued = await response.json(); assert(typeof issued.id === 'string' && issued.teamId === r.teamId && issued.seasonId === r.seasonId);
  await page.getByTestId('invitation-show-qr').click(); await page.getByTestId('invitation-qr-code').waitFor();
  await page.getByTestId('invitation-close-link').click(); await page.getByLabel('One-time spectator invitation link', { exact: true }).waitFor({ state: 'detached' }); capabilityDisplayed = false;
  await page.getByTestId(`invitation-revoke-${issued.id}`).click(); await page.getByTestId('invitation-confirm-change').click();
  await page.getByText('The invitation link was revoked.', { exact: true }).waitFor();
  record('Super Admin creates a real one-hour team/season spectator link, renders its QR locally, closes the secret display and explicitly revokes the invitation. No email/share message is sent.');
}
async function accountJourney() {
  if (!final) return;
  stage = 'Super Admin account help, privacy and pending request'; const { page } = state;
  await r.openTab(state, 'account'); await page.getByTestId('workspace-account-panel').waitFor();
  await page.getByTestId('account-section-help').click(); await page.getByTestId('account-help').waitFor();
  await page.getByTestId('account-section-privacy').click();
  assert.match(await page.getByTestId('account-privacy').innerText(), /Verification and fulfilment are awaiting the agreed club policy/);
  await page.getByTestId('account-section-requests').click(); await page.getByTestId('account-requests-screen').waitFor();
  for (const kind of ['export', 'delete_account', 'leave_team']) await page.getByTestId(`choose-account-${kind}`).waitFor();
  const before = await r.api('/v1/privacy/requests', { state });
  await page.getByTestId('choose-account-export').click();
  assert(await page.getByTestId('submit-account-request').isDisabled(), 'A global data request requires explicit scope confirmation.');
  await page.getByTestId('confirm-account-request-scope').click();
  const submitted = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/privacy/requests' && response.request().method() === 'POST');
  await page.getByTestId('submit-account-request').click(); assert.equal((await submitted).status(), 200);
  await page.getByText('The service confirms this request is recorded and still pending verification and policy. Nothing has been fulfilled or erased.', { exact: true }).waitFor();
  const after = await r.api('/v1/privacy/requests', { state });
  const request = after.items.find(row => !before.items.some(previous => previous.requestId === row.requestId));
  assert(request && request.kind === 'export' && request.scope.type === 'all_memberships' && request.status === 'pending_verification_and_policy');
  assert.equal(request.erased, false); assert.equal(request.fulfilled, false); assert.equal(request.verificationRequired, true);
  assert.deepEqual(after.memberships, before.memberships, 'Recording a request does not remove account access.');
  await page.getByTestId('account-section-summary').click();
  record('Super Admin Account provides readable access/help/privacy and records an explicitly confirmed own-account export request as pending verification/policy only; no fulfilment, erasure or membership change occurs.');
}
async function layoutAndLogout() {
  const { page } = state; await r.openTab(state, 'clubs');
  for (const viewport of [{ width: 390, height: 844 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(viewport); await settled();
    for (const mode of final ? ['phone', 'tablet'] : ['auto']) {
      if (final) {
        const menu = page.getByTestId('workspace-layout-menu');
        if (!await page.getByTestId('workspace-layout-controls').isVisible()) await menu.click();
        await page.getByTestId(`workspace-layout-choice-${mode}`).click();
        assert.equal(await page.getByTestId(`workspace-layout-choice-${mode}`).getAttribute('aria-pressed'), 'true');
      }
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Super Admin pages must not overflow a phone/tablet horizontally.');
      await r.screenshot(`super-clubs-${viewport.width}-${mode}`, state);
    }
  }
  stage = 'privacy and system access boundaries';
  const club = await r.login('club');
  await r.openTab(club, 'clubs');
  assert.equal(await club.page.getByTestId('application-sign-in-rules').count(), 0);
  assert.equal(await club.page.getByTestId('workspace-tab-loginActivity').count(), 0);
  await r.api('/v1/administration/login-analytics', { state: club, expected: 404 });
  await r.api('/v1/administration/sign-in-rules', { state: club, expected: 404 });
  await r.api('/v1/administration/login-analytics', { state, token: null, expected: 401 });
  const receipt = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/demo/sessions/current' && response.request().method() === 'DELETE');
  await page.getByTestId('demo-sign-out').click(); assert.equal((await receipt).status(), 204); await page.getByTestId('demo-login-screen').waitFor();
  assert.equal(await page.getByTestId('club-administration').count(), 0);
  record('Phone 390 and tablet 1024 fit in the staff phone/tablet modes; Club Admin cannot read global policy/activity, anonymous access is denied, and Super Admin logout revokes the session and closes private views.');
}
try {
  state = await r.login();
  await policyJourney(); await activityJourney();
  // Fresh normal credential verification keeps administrative writes inside their existing step-up window.
  await state.page.getByTestId('demo-sign-out').click(); await state.page.getByTestId('demo-login-screen').waitFor();
  state = await r.login();
  await globalAdministration(); await routeInventory(); await accountJourney(); await invitationJourney(); await layoutAndLogout();
  assert.equal(await scriptDigest(), r.report.scenarioSha256, 'The persona scenario must remain unchanged throughout its run.');
  completed = true;
} catch (error) {
  r.report.findings.push({ id: 'SUPER_REVIEW_STOP', stage, observed: r.safe(error.message) });
  if (!capabilityDisplayed && state && await state.page.getByTestId('demo-signed-in').isVisible().catch(() => false)) await r.screenshot('failure', state).catch(() => {});
  await r.finish({ passed: false, error }); process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  if (completed) { const report = await r.finish(); if (!report.passed) process.exitCode = 1; }
}
console.log(JSON.stringify({ persona: 'super', phase, completed, checks: r.report.checks.length, findings: r.report.findings, failures: r.report.failures, passed: r.report.passed, output: r.output }));
