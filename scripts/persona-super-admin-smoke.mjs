import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createPersonaReview } from './persona-review-session.mjs';

// A separate smoke of the later shared presentation build; never relabel the full candidate4 journey.
const phase = process.env.LONGBALL_PERSONA_PHASE ?? 'candidate5';
const r = await createPersonaReview({ persona: 'super', name: 'super-admin-smoke', phase, width: 390, height: 844 });
const digest = async () => createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
r.report.scenarioSha256 = await digest();
let state, failure;
try {
  state = await r.login(); const { page } = state;
  await r.openTab(state, 'clubs'); await page.getByTestId('sign-in-rules-toggle').click();
  await page.getByLabel('Minimum password length', { exact: true }).waitFor();
  assert(await page.getByTestId('sign-in-rules-save').isDisabled(), 'An unchanged policy remains unsaveable.');
  r.report.checks.push('Later candidate retains readable current global policy and disabled unchanged Save.');

  await page.getByTestId('workspace-tab-loginActivity').click(); await page.getByTestId('login-activity-metric-active').waitFor();
  const report = await r.api('/v1/administration/login-analytics', { state });
  const team = report.directory.teams.find(row => row.id === r.teamId); assert(team);
  const club = report.directory.clubs.find(row => row.id === team.clubId); assert(club);
  await page.getByTestId('login-activity-filters-toggle').click(); await page.getByTestId('login-activity-club').click();
  const readScope = async (parameter, value, action) => {
    const response = page.waitForResponse(receipt => {
      const url = new URL(receipt.url());
      return url.pathname === '/v1/administration/login-analytics' && receipt.request().method() === 'GET' && url.searchParams.get(parameter) === value;
    });
    const [, receipt] = await Promise.all([action(), response]); assert.equal(receipt.status(), 200);
    assert.equal((await receipt.json()).filters[parameter], value); await page.getByTestId('login-activity-metric-active').waitFor();
  };
  await readScope('clubId', club.id, () => page.getByRole('button', { name: `Choose club ${club.name}`, exact: true }).click());
  await page.getByTestId('login-activity-team').click();
  await readScope('teamId', team.id, () => page.getByRole('button', { name: `Choose team ${team.name} · ${team.ageGroup}`, exact: true }).click());
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  r.report.checks.push('Actual phone Club and Team options remain tappable and receive correctly scoped activity responses without horizontal overflow.');

  await r.openTab(state, 'account'); await page.getByTestId('workspace-account-panel').waitFor();
  await page.getByTestId('account-section-help').click(); await page.getByTestId('account-help').waitFor();
  await page.getByTestId('account-section-privacy').click();
  assert.match(await page.getByTestId('account-privacy').innerText(), /Verification and fulfilment are awaiting the agreed club policy/);
  await page.getByTestId('account-section-requests').click(); await page.getByTestId('choose-account-export').waitFor();
  assert.equal((await r.api('/v1/privacy/requests', { state })).accountId, state.account.accountId);
  await page.getByTestId('account-section-summary').click(); await page.setViewportSize({ width: 1024, height: 768 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  r.report.checks.push('Account Help, pending-policy Privacy and own request status remain scoped/readable on phone and tablet; no request is fulfilled or submitted by this smoke.');

  const ended = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/demo/sessions/current' && response.request().method() === 'DELETE');
  const [, receipt] = await Promise.all([page.getByTestId('demo-sign-out').click(), ended]); assert.equal(receipt.status(), 204);
  await page.getByTestId('demo-login-screen').waitFor(); await r.api('/v1/me', { state, expected: 401 });
  assert.equal(await page.getByTestId('workspace-account-panel').count(), 0);
  r.report.checks.push('Explicit logout revokes the real session and removes private Account views.');
  assert.equal(await digest(), r.report.scenarioSha256);
} catch (cause) {
  failure = cause; r.report.findings.push({ stage: 'later-candidate Super Admin smoke', observed: r.safe(cause.message) });
  if (state) await r.screenshot('smoke-failure', state).catch(() => {});
} finally {
  const report = await r.finish({ passed: !failure, error: failure });
  if (!report.passed) process.exitCode = 1;
}
console.log(JSON.stringify({ passed: r.report.passed, checks: r.report.checks.length, output: r.output, failures: r.report.failures }));
