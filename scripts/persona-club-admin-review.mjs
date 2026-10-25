import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPersonaReview } from './persona-review-session.mjs';
import { changeWorkspaceContext } from './review-entry.mjs';

const final = process.env.LONGBALL_PERSONA_PHASE === 'final';
const r = await createPersonaReview({ persona: 'club', name: 'club-admin' });
const wrapperHash = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
r.report.source.wrapperSha256 = wrapperHash;
if (!final) assert.equal(r.report.source.webScriptSha256, '629ef0ee691c9b95e0d5b76653beb9e6b0b4d30c2105f3f60e483edb472a209d', 'The baseline must use the pinned published f31b823 UI artifact.');
console.log(JSON.stringify({persona:'club',phase:r.report.phase,pinnedArtifactsReady:true,webScriptSha256:r.report.source.webScriptSha256}));
let state, failure;
const deadline = setTimeout(() => {
  void r.finish({ passed: false, error: new Error('Club Admin persona exceeded its 12-minute review bound.') }).then(() => process.exit(1));
}, 12 * 60_000);
const finding = (id, problem) => r.report.findings.push({ id, problem, source: 'Observed compiled Club Admin interface' });
const noOverflow = async label => {
  assert(await state.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${label}: no horizontal document overflow.`);
};
const visit = async (tab, expected) => {
  await r.budget(state);
  await r.openTab(state, tab);
  if (expected) await state.page.getByTestId(expected).waitFor();
  await noOverflow(tab);
  r.report.checks.push(`Club Admin opens ${tab} in the current authorised team/season.`);
};
const saveClick = async (action, path) => {
  const received = state.page.waitForResponse(reply => new URL(reply.url()).pathname === path && reply.request().method() === 'POST');
  await action();
  assert.equal((await received).status(), 200, `The actual ${path} write must be accepted.`);
};
const guardMessage = 'Save or discard your unsaved changes before leaving this view. If a request is awaiting confirmation, retry or explicitly close that request first. Sign-out remains available.';
const proveNavigationRetained = async (viewId, inputLabel, value) => {
  const nav = state.page.getByTestId('workspace-tab-team');
  if (!await nav.isDisabled()) {
    await nav.click();
    await state.page.getByText(guardMessage, { exact: true }).waitFor();
  }
  await state.page.getByTestId(viewId).waitFor();
  assert.equal(await state.page.getByLabel(inputLabel, { exact: true }).inputValue(), value, 'The protected view and its exact original draft survive the attempted navigation.');
};
try {
  state = await r.login();
  const { page } = state;
  const directory = await r.api('/v1/administration', { state });
  assert.equal(directory.administration.level, 'club');
  assert.deepEqual(directory.clubs.map(club => club.id), ['synthetic-richmond-rovers']);
  assert(directory.teams.every(team => team.clubId === directory.clubs[0].id));
  await visit('clubs', 'club-administration');
  assert.equal(await page.getByTestId('admin-create-club').count(), 0);
  assert.equal(await page.getByTestId('workspace-tab-loginActivity').count(), 0);
  await r.screenshot('club-admin-clubs-390', state);
  await visit('team');
  if (final) {
    await page.getByTestId('administration-team-directory').waitFor();
    assert.equal(await page.getByTestId('administrator-configuration').count(), 0, 'Teams opens the directory rather than editing settings.');
  } else if (await page.getByTestId('administrator-configuration').count()) {
    finding('CA01', 'The Teams primary tab opens configuration forms rather than a usable team directory.');
  }
  for (const [tab, id] of [
    ['schedule', 'scheduled-game-management'],
    ['stats', 'team-player-stats'],
    ['people', 'connected-staff'],
    ['opposition', 'opposition-reviews'],
    ['invitations', 'connected-invitations'],
    ['seasons', 'connected-season-rollover'],
    ['settings', 'administrator-configuration'],
    ['overview', 'team-overview'],
  ]) await visit(tab, id);
  await visit('people', 'connected-staff');
  const staff = await r.api(r.scope('managers'), { state });
  assert.equal(staff.maximumManagers, 4);
  assert(staff.candidates.every(person => typeof person.label === 'string'));
  if (!final && await page.getByLabel('Existing adult account reference', { exact: true }).isVisible()) finding('CA02', 'Staff assignment presents an opaque account-reference input as the primary path and has no candidate search.');
  const inherited = staff.candidates.find(person => person.accountId === state.account.accountId);
  if (final) assert.equal(inherited?.currentManager, true, 'Inherited management access must not be offered as a new appointed manager.');
  else if (inherited && !inherited.currentManager) {
    const candidateButton = page.getByRole('button', { name: `Select ${inherited.label} for manager review`, exact: true });
    if (await candidateButton.count() > 1) {
      finding('CA07', 'Several staff candidates share the same generic verified-adult label, so their selection buttons are ambiguous without an account reference.');
      await page.getByLabel('Existing adult account reference', { exact: true }).fill(inherited.accountId);
    } else await candidateButton.click();
    await page.getByTestId('staff-review-assign').click();
    const selfReceipt = page.waitForResponse(reply => new URL(reply.url()).pathname === `/v1/teams/${r.teamId}/managers` && reply.request().method() === 'POST');
    await page.getByTestId('staff-confirm').click();
    const selfResponse = await selfReceipt;
    if (staff.activeTeamManagerCount >= staff.maximumManagers) {
      assert.equal(selfResponse.status(), 409);
      assert.equal((await selfResponse.json()).code, 'MANAGER_LIMIT');
      const exact = r.report.httpFailures.findLast(item => item.method === 'POST' && item.path === `/v1/teams/${r.teamId}/managers` && item.status === 409 && item.code === 'MANAGER_LIMIT');
      assert(exact); exact.expected = true; exact.baselineAffordanceDefect = true;
      await page.getByRole('button', { name: 'Edit staff review', exact: true }).click();
    } else assert.equal(selfResponse.status(), 200);
    assert.equal((await r.api(r.scope('managers'), { state })).revision, staff.revision);
    finding('CA04', 'Inherited Club Admin management access is incorrectly offered as a new appointment; at the full appointed-seat limit it is rejected as a fifth manager despite the inherited access already existing.');
  }
  const appointed = staff.managers.find(person => person.status === 'active' && person.accountId !== state.account.accountId);
  assert(appointed, 'Use an existing appointed Manager in the isolated team.');
  await page.getByRole('button', { name: `Review revoking ${appointed.label} manager access`, exact: true }).click();
  await page.getByLabel('Manager revocation reason', { exact: true }).fill('Temporary appointment change in isolated persona review');
  await page.getByTestId('staff-review-revoke').click();
  await saveClick(() => page.getByTestId('staff-confirm').click(), `/v1/teams/${r.teamId}/managers/revoke`);
  await page.getByTestId('staff-review-assign').waitFor();
  const revoked = await r.api(r.scope('managers'), { state });
  assert.equal(revoked.managers.find(person => person.accountId === appointed.accountId)?.status, 'revoked');
  await r.budget(state);
  if (final) {
    await page.getByLabel('Search manager candidates', { exact: true }).fill(appointed.accountId);
    const choices = page.getByTestId('staff-edit-panel').getByRole('button', { name: /^Select .+ for manager review$/ });
    assert.equal(await choices.count(), 1, 'Searching an authorised reference must identify exactly the intended verified adult.');
    await choices.click();
  } else {
    if (!await page.getByLabel('Existing adult account reference', { exact: true }).isVisible()) await page.getByRole('button', { name: 'Enter an account reference', exact: true }).click();
    await page.getByLabel('Existing adult account reference', { exact: true }).fill(appointed.accountId);
  }
  await page.getByTestId('staff-review-assign').click();
  if (final) await page.getByText(new RegExp(`${appointed.accountId}.*season`)).waitFor();
  await saveClick(() => page.getByTestId('staff-confirm').click(), `/v1/teams/${r.teamId}/managers`);
  await page.getByTestId('staff-review-assign').waitFor();
  const restored = await r.api(r.scope('managers'), { state });
  assert.equal(restored.managers.find(person => person.accountId === appointed.accountId)?.status, 'active');
  assert.equal(restored.activeTeamManagerCount, staff.activeTeamManagerCount);
  r.report.checks.push('Club Admin reviews and confirms a real scoped Manager revocation, then restores the same verified account; appointed-seat totals return to the original value.');

  if (final) {
    await page.getByLabel('Search manager candidates', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Existing adult account reference', { exact: true }).count(), 0, 'Account-reference entry starts collapsed.');
    await page.getByRole('button', { name: 'Enter an account reference', exact: true }).click();
    await page.getByLabel('Existing adult account reference', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Hide account reference', exact: true }).click();
  }
  await visit('clubReports', 'club-administration');
  const reportPath = `/v1/clubs/${directory.clubs[0].id}/reports`;
  if (!final) await page.getByTestId('admin-club-report').click();
  await page.getByText(/recorded completed games/).waitFor();
  const report = await r.api(reportPath, { state });
  assert.equal(report.club.id, directory.clubs[0].id);
  await page.getByRole('button', { name: 'Games', exact: true }).click();
  await noOverflow('club reports');
  await r.screenshot('club-admin-reports-390', state);
  await page.setViewportSize({ width: 1024, height: 768 });
  await noOverflow('tablet reports');
  await r.screenshot('club-admin-reports-1024', state);
  await page.setViewportSize({ width: 390, height: 844 });
  await r.budget(state);
  await r.api('/v1/administration/sign-in-rules', { state, expected: 404 });
  await r.api('/v1/administration/login-analytics', { state, expected: 404 });
  await r.api('/v1/administration', { state, body: { command: { type: 'club.create', name: 'Forbidden Club Admin club' } }, expected: 404 });
  await r.api('/v1/clubs/synthetic-other-club/reports', { state, expected: 404 });
  await r.api('/v1/administration', { state, body: { command: { type: 'administrator.grant', accountId: state.account.accountId, level: 'super', clubId: null } }, expected: 404 });
  r.report.checks.push('Club Admin cannot create a global club, grant Super Admin, read another club report, or access global sign-in policy/login reports.');
  await visit('clubs', 'club-administration');
  if (!await page.getByLabel('New team name', { exact: true }).isVisible()) await page.getByTestId('admin-team-form-toggle').click();
  if (final) {
    await page.getByLabel('New team name', { exact: true }).fill('Unsaved pathways team');
    await page.getByTestId('admin-unsaved-draft').waitFor();
    await proveNavigationRetained('admin-team-form', 'New team name', 'Unsaved pathways team');
    await page.getByTestId('admin-discard-drafts').click();
    assert.equal(await page.getByLabel('New team name', { exact: true }).inputValue(), '');
    await visit('team', 'administration-team-directory');
    await visit('clubs', 'club-administration');
    if (!await page.getByLabel('New team name', { exact: true }).isVisible()) await page.getByTestId('admin-team-form-toggle').click();
    r.report.checks.push('A real new-team draft retains navigation until explicit discard; discarding clears only the local form and sends no creation.');
  }
  const createdName = 'Roma Pathways';
  await page.getByLabel('New team name', { exact: true }).fill(createdName);
  await page.getByLabel('New team age group', { exact: true }).fill('U12');
  await page.getByLabel('New team format', { exact: true }).fill('9');
  if (final) {
    let committed = false, retryDenied = false;
    const keys = [], bodies = [];
    await page.route('**/v1/administration', async route => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      const body = JSON.parse(request.postData());
      assert.equal(body.command.type, 'team.create');
      const key = request.headers()['idempotency-key'];
      keys.push(key); bodies.push(body);
      if (!committed) {
        committed = true;
        await r.api('/v1/administration', { state, body, key });
        (r.report.controlledFaults ??= []).push({ method: 'POST', path: '/v1/administration', status: 200, type: 'malformed-receipt-after-origin-commit' });
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ kind: 'club-administration', teams: 'unverified' }) });
      }
      if (!retryDenied) {
        retryDenied = true;
        r.report.httpFailures.push({ method: 'POST', path: '/v1/administration', status: 403, code: 'CONTROLLED_ADMIN_RETRY_DENIED', expected: true, controlledFault: true });
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: 'CONTROLLED_ADMIN_RETRY_DENIED', message: 'The isolated review withheld this retry without an origin write.' }) });
      }
      return route.fallback();
    });
    await page.getByTestId('admin-create-team').click();
    await page.getByTestId('administration-pending').waitFor();
    assert(!await page.getByLabel('New team name', { exact: true }).isEditable());
    await proveNavigationRetained('administration-pending', 'New team name', createdName);
    assert.equal(await page.getByTestId('admin-discard-drafts').count(), 0, 'An unconfirmed server command cannot be discarded as a local draft.');
    const denied = page.waitForResponse(reply => new URL(reply.url()).pathname === '/v1/administration' && reply.request().method() === 'POST' && reply.status() === 403);
    await page.getByTestId('admin-retry-change').click(); await denied;
    await page.getByTestId('administration-pending').waitFor();
    assert(!await page.getByLabel('New team name', { exact: true }).isEditable());
    await proveNavigationRetained('administration-pending', 'New team name', createdName);
    await saveClick(() => page.getByTestId('admin-retry-change').click(), '/v1/administration');
    await page.getByTestId('admin-created-team').waitFor();
    await page.unroute('**/v1/administration');
    assert.equal(keys.length, 3); assert(keys[0] && keys.every(key => key === keys[0]));
    for (const body of bodies) assert.deepEqual(body, bodies[0], 'Every retained administration retry sends the exact original command.');
    r.report.checks.push('A real team creation committed on the isolated service receives a deliberately malformed200, then a controlled non-committing403 retry denial; the original body/key remain locked until a final accepted same-key receipt. The denial is injected transport evidence, not a physical expiry test.');
  } else await saveClick(() => page.getByTestId('admin-create-team').click(), '/v1/administration');
  const updated = await r.api('/v1/administration', { state });
  const created = updated.teams.find(team => team.name === createdName);
  assert(created && created.clubId === directory.clubs[0].id);
  assert.equal(updated.teams.filter(team => team.name === createdName).length, 1);
  if (final) {
    await page.getByTestId('admin-created-team').waitFor();
    assert.equal(await page.getByLabel('New team name', { exact: true }).count(), 0, 'The acknowledged creation form closes rather than offering accidental duplicate submission.');
    await page.getByRole('button', { name: 'Open new team', exact: true }).click();
    await page.getByTestId('team-overview').waitFor();
  } else {
    assert.equal(await page.getByLabel('New team name', { exact: true }).inputValue(), createdName);
    finding('CA03', 'Confirmed team creation leaves the old name and create button in place, with no direct open-new-team action.');
    await changeWorkspaceContext(page, 'administrator', { teamId: created.id, seasonId: created.seasonId });
  }
  const createdScope = leaf => `/v1/teams/${created.id}/${leaf}?seasonId=${created.seasonId}`;
  await visit('settings', 'administrator-configuration');
  if (final) {
    await page.getByLabel('Team name', { exact: true }).fill('Unsaved configuration name');
    await page.getByTestId('administrator-configuration-draft').waitFor();
    await proveNavigationRetained('administrator-configuration', 'Team name', 'Unsaved configuration name');
    await page.getByTestId('administrator-config-discard').click();
    assert.equal(await page.getByLabel('Team name', { exact: true }).inputValue(), createdName);
    await visit('team', 'administration-team-directory');
    await visit('settings', 'administrator-configuration');
    r.report.checks.push('Configuration fields advertise unsaved changes, retain ordinary navigation and restore the current service baseline only after explicit discard.');
  }
  await page.getByLabel('Team name', { exact: true }).fill('Roma Pathways Blue');
  await saveClick(() => page.getByRole('button', { name: 'Save administrator team configuration', exact: true }).click(), `/v1/teams/${created.id}/configuration`);
  assert.equal((await r.api(createdScope('configuration'), { state })).team.name, 'Roma Pathways Blue');
  r.report.checks.push('Club Admin creates a real empty U12 nine-a-side team in its own club, opens its authorised scope, and saves team configuration.');
  await changeWorkspaceContext(page, 'administrator', { teamId: r.teamId, seasonId: r.seasonId });
  if (final) {
    await visit('team', 'administration-team-directory');
    await page.getByLabel('Search club teams', { exact: true }).fill('Roma Pathways Blue');
    await page.getByTestId(`admin-directory-team-${created.id}-${created.seasonId}`).waitFor();
    assert.equal(await page.locator('[data-testid^="admin-directory-team-"]').count(), 1, 'The directory search shows only the matching authorised team-season.');
    await page.getByRole('button', { name: 'Clear team filters', exact: true }).click();
    await page.getByTestId('admin-team-age-U12').click();
    assert.equal(await page.getByTestId('admin-team-age-U12').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-testid^="admin-directory-team-"]').count(), 1);
    await page.getByRole('button', { name: 'Clear team filters', exact: true }).click();
    await page.getByTestId(`admin-manage-team-${r.teamId}-${r.seasonId}`).click();
    r.report.checks.push('The authorised team directory searches a renamed team, filters by age with pressed state, clears filters and opens explicit inherited Manager context for the chosen team-season.');
  } else await page.getByTestId('workspace-admin-manage-team').click();
  await visit('team', 'preparation-roster-grid');
  const preparation = await r.api(r.scope('preparation'), { state, role: 'manager' });
  assert.equal(preparation.profiles.filter(profile => profile.active && profile.seasonId === r.seasonId).length, 8);
  await visit('formation', 'formation-designer');
  await visit('stats', 'team-player-stats');
  assert(await page.getByTestId('stats-core-positions').count(), 'Inherited Manager view has its authorised current profile preferences.');
  r.report.checks.push('Club Admin explicitly enters inherited Manager context and can use the real Roma roster, formation designer and private selected-player statistics. Shared Manager elements are separately traversed by the Manager persona.');
  await changeWorkspaceContext(page, 'administrator', { teamId: r.teamId, seasonId: r.seasonId });

  const recipient = state.account.accountId;
  const fixtureSuper = await r.login('super');
  await r.api('/v1/administration', { state: fixtureSuper, body: { command: { type: 'team.create', clubId: 'synthetic-other-club', name: 'Brookfield Pathways', ageGroup: 'U14', format: 11, seasonStartYear: 2026 } } });
  await r.api('/v1/administration', { state: fixtureSuper, body: { command: { type: 'administrator.grant', accountId: recipient, level: 'club', clubId: 'synthetic-other-club' } } });
  await fixtureSuper.page.getByTestId('demo-sign-out').click(); await fixtureSuper.page.getByTestId('demo-login-screen').waitFor();
  await page.getByTestId('demo-sign-out').click(); await page.getByTestId('demo-login-screen').waitFor();
  state = await r.login();
  const multi = state.page;
  await visit('clubs', 'club-administration');
  const richmond = multi.getByRole('button', { name: 'Richmond Rovers', exact: true });
  if (final) assert.equal(await richmond.getAttribute('aria-pressed'), 'true', 'The team directory initially follows the selected team club, rather than the first alphabetic club.');
  else if (await multi.getByRole('button', { name: 'Brookfield Juniors', exact: true }).evaluate(node => getComputedStyle(node).backgroundColor) === 'rgb(18, 105, 70)') finding('CA05', 'A multi-club administrator signed into Roma initially sees the first alphabetical directory club instead of the club in the current team header.');
  await visit('clubReports', 'club-administration');
  if (final) await multi.getByText(/Richmond Rovers · recorded completed games/).waitFor();
  await multi.getByRole('button', { name: 'Richmond Rovers', exact: true }).click();
  if (!final) await multi.getByTestId('admin-club-report').click();
  await multi.getByText(/Richmond Rovers · recorded completed games/).waitFor();
  if (final) r.report.checks.push('Selecting the already-current club preserves its loaded report rather than clearing it without a new request.');
  if (final) {
    await multi.getByLabel('Search club report teams', { exact: true }).fill('No matching academy');
    assert.equal(await multi.locator('[data-testid^="admin-report-team-"]').count(), 0);
    await multi.getByText('No teams match these filters. Choose All ages or clear the search.', { exact: true }).waitFor();
    await multi.getByLabel('Search club report teams', { exact: true }).fill('');
    assert.equal(await multi.locator('[data-testid^="admin-report-team-"]').count(), 2, 'Both Roma team-seasons return after clearing the report search.');
  }
  await (final ? multi.getByTestId('admin-report-age-U10') : multi.getByRole('button', { name: 'U10', exact: true })).click();
  await multi.getByRole('button', { name: 'Brookfield Juniors', exact: true }).click();
  if (!final) await multi.getByTestId('admin-club-report').click();
  await multi.getByText(/Brookfield Juniors · recorded completed games/).waitFor();
  if (final) {
    assert.equal(await multi.getByTestId('admin-report-age-All').getAttribute('aria-pressed'), 'true');
    await multi.getByText(/Brookfield Pathways · U14 ·/).waitFor();
  } else if (!await multi.getByText(/Brookfield Pathways · U14 ·/).count()) finding('CA06', 'The previous club age filter carries into a different club report and hides its teams without a clear scope reset.');
  r.report.checks.push('A Super Admin fixture grant adds a second test club; a normal fresh Club Admin login selects permitted clubs, and report controls are exercised across U10 and U14 club scopes.');
  await visit('account');
  assert(await state.page.getByTestId('demo-signed-in').isVisible());
  r.report.checks.push('Account remains scoped to the signed-in Club Admin; privacy/support policy decisions are not treated as approved.');
  const signedOut = state.page.waitForResponse(reply => new URL(reply.url()).pathname === '/v1/demo/sessions/current' && reply.request().method() === 'DELETE');
  await state.page.getByTestId('demo-sign-out').click();
  assert.equal((await signedOut).status(), 204);
  await state.page.getByTestId('demo-login-screen').waitFor();
  assert.equal(await state.page.getByTestId('demo-signed-in').count(), 0);
  r.report.checks.push('Explicit logout ends the real session and closes all private Club Admin views.');
  assert.equal(createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'), wrapperHash, 'The persona wrapper stays unchanged during execution.');
} catch (cause) {
  failure = cause;
  if (state) await r.screenshot('club-admin-failure', state).catch(() => {});
} finally {
  clearTimeout(deadline);
  const report = await r.finish({ passed: !failure, error: failure });
  console.log(JSON.stringify({ persona: 'club', phase: report.phase, passed: report.passed, checks: report.checks.length, findings: report.findings.length, failures: report.failures, report: `${r.output}/report.json` }));
  if (!report.passed) process.exitCode = 1;
}
