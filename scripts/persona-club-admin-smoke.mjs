import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPersonaReview } from './persona-review-session.mjs';

// A later compiled-client check supplements, rather than relabels, the full final journey.
const phase = process.env.LONGBALL_PERSONA_PHASE ?? 'smoke';
const r = await createPersonaReview({ persona: 'club', name: 'club-admin', phase });
const digest = async () => createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
r.report.source.wrapperSha256 = await digest();
let state, failure;
const deadline = setTimeout(() => {
  void r.finish({ passed: false, error: new Error('Club Admin smoke exceeded its five-minute bound.') }).then(() => process.exit(1));
}, 5 * 60_000);
const record = text => r.report.checks.push(text);
const noOverflow = async () => assert(await state.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
try {
  state = await r.login();
  const { page } = state;
  const directory = await r.api('/v1/administration', { state });
  assert.equal(directory.administration.level, 'club');
  assert(directory.teams.every(team => directory.clubs.some(club => club.id === team.clubId)));
  record('Generated Club Admin signs into the rebuilt client and receives only its authorised directory.');
  await r.openTab(state, 'team');
  await page.getByTestId('administration-team-directory').waitFor();
  await page.getByTestId(`admin-open-team-${r.teamId}-${r.seasonId}`).waitFor();
  await page.getByTestId(`admin-manage-team-${r.teamId}-${r.seasonId}`).waitFor();
  assert.equal(await page.getByTestId('administrator-configuration').count(), 0);
  await noOverflow();
  record('Phone Teams opens the authorised directory with Open/Manage actions and no configuration form or horizontal overflow.');
  await r.openTab(state, 'clubReports');
  const heading = page.getByText(/Richmond Rovers · recorded completed games/);
  await heading.waitFor();
  await page.getByRole('button', { name: 'Richmond Rovers', exact: true }).click();
  await heading.waitFor();
  await page.setViewportSize({ width: 1024, height: 768 });
  await noOverflow();
  await r.screenshot('club-admin-smoke-reports-1024', state);
  record('Club reports load automatically, retain the current report after selecting its club again, and fit the tablet viewport.');
  await page.setViewportSize({ width: 390, height: 844 });
  await r.openTab(state, 'account');
  await page.getByTestId('workspace-account-panel').waitFor();
  await page.getByTestId('account-section-help').click();
  await page.getByTestId('account-help').waitFor();
  await page.getByTestId('account-section-privacy').click();
  await page.getByTestId('account-privacy').waitFor();
  await page.getByTestId('account-section-requests').click();
  await page.getByTestId('choose-account-export').waitFor();
  assert(!(await page.locator('body').innerText()).includes(state.account.accountId), 'Ordinary Account UI keeps the internal account reference collapsed.');
  await page.getByRole('button', { name: 'Show technical references', exact: true }).click();
  await page.getByText(state.account.accountId, { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Hide technical references', exact: true }).click();
  assert.equal((await r.api('/v1/privacy/requests', { state })).items.length, 0, 'Reading request help does not submit or fulfil a privacy request.');
  await noOverflow();
  record('Account Help, Privacy and real request status remain readable; internal references are optional and no privacy request is submitted.');
  const closed = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/demo/sessions/current' && response.request().method() === 'DELETE');
  await page.getByTestId('demo-sign-out').click();
  assert.equal((await closed).status(), 204);
  await page.getByTestId('demo-login-screen').waitFor();
  assert.equal(await page.getByTestId('demo-signed-in').count(), 0);
  record('Real logout closes private Club Admin views on the rebuilt client.');
  assert.equal(await digest(), r.report.source.wrapperSha256);
} catch (cause) {
  failure = cause;
  if (state) await r.screenshot('club-admin-smoke-failure', state).catch(() => {});
} finally {
  clearTimeout(deadline);
  const report = await r.finish({ passed: !failure, error: failure });
  console.log(JSON.stringify({ persona: 'club', phase, passed: report.passed, checks: report.checks.length, failures: report.failures, report: `${r.output}/report.json` }));
  if (!report.passed) process.exitCode = 1;
}
