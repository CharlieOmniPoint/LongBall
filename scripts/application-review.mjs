import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { enterFictionalReview } from './review-entry.mjs';

/** UI-only feature journeys. IndexedDB is inspected read-only as persistence evidence. */
const baseURL = process.env.LONGBALL_REVIEW_BASE_URL ?? 'http://127.0.0.1:4173';
const output = path.resolve('.local/application-review');
const documentId = 'synthetic-longball-application-v1';
const seasonId = 'synthetic-season-2026-27';
const playerId = 'synthetic-player-01';
const scenarioFilter = process.env.LONGBALL_REVIEW_SCENARIO ?? '';
const results = [];
const errors = [];
const browser = await chromium.launch({ executablePath: process.env.LONGBALL_CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
await mkdir(output, { recursive: true });

async function stored(page) {
  return page.evaluate(async () => new Promise((resolve, reject) => {
    const request = indexedDB.open('longball-synthetic-m0');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('journal')) { database.close(); resolve(null); return; }
      const transaction = database.transaction('journal', 'readonly');
      const read = transaction.objectStore('journal').get('record');
      read.onsuccess = () => resolve(read.result ?? null);
      read.onerror = () => reject(read.error);
      transaction.oncomplete = () => database.close();
    };
  }));
}
async function application(page) { return (await stored(page))?.projections?.[documentId] ?? null; }
async function until(page, predicate, label) {
  const deadline = Date.now() + 12_000;
  let state;
  do { state = await application(page); if (state && predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 40)); } while (Date.now() < deadline);
  assert.fail(`${label}; latest application revision ${state?.revision ?? 'missing'}`);
}
async function open(context) {
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await enterFictionalReview(page);
  await page.getByTestId('prepare-match').waitFor();
  await until(page, () => true, 'Application document should initialize');
  return page;
}
async function button(page, name) { await page.getByRole('button', { name, exact: true }).click(); }
async function radio(page, name) { await page.getByRole('radio', { name, exact: true }).click(); }
async function role(page, next) {
  const more = page.getByRole('button', { name: 'More', exact: true });
  if (await more.isVisible()) {
    await more.click();
    await page.getByTestId(`review-role-${next}`).click();
  } else {
    await button(page, 'Change demo account');
    await page.getByTestId(`review-entry-${next}`).click();
    await page.getByTestId('review-open-local').click();
  }
}
async function more(page, destination) { await button(page, 'More'); await button(page, destination); }
async function screenshot(page, name) {
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: no phone horizontal overflow`);
}
async function scenario(name, work) {
  if (scenarioFilter && !name.startsWith(scenarioFilter)) return;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  let page;
  context.on('page', opened => { page ??= opened; });
  try { page = await open(context); const detail = await work(page, context); await screenshot(page, name); results.push({ name, status: 'passed', detail }); }
  catch (failure) { if (page) await page.screenshot({ path: path.join(output, `${name}-failed.png`), animations: 'disabled' }).catch(() => {}); results.push({ name, status: 'failed', error: failure.message }); }
  finally { await context.close(); }
  console.log(`${results.at(-1).status.toUpperCase()} ${name}${results.at(-1).error ? `: ${results.at(-1).error}` : ''}`);
}

try {
  await scenario('01-fixture-history', async page => {
    await button(page, 'Schedule');
    await page.getByTestId('preparation-create-event').click();
    await page.getByLabel('Opposition', { exact: true }).fill('Birch FC rehearsal');
    await page.getByLabel('Match date (YYYY-MM-DD)', { exact: true }).fill('2026-11-07');
    await page.getByLabel('Kick-off (HH:MM, blank if not recorded)', { exact: true }).fill('11:00');
    await page.getByLabel('Venue', { exact: true }).fill('Fictional south field');
    await page.getByTestId('preparation-save').click();
    let app = await until(page, value => value.preparation.fixtures.some(item => item.opponent === 'Birch FC rehearsal'), 'Fixture create');
    const fixture = app.preparation.fixtures.find(item => item.opponent === 'Birch FC rehearsal');
    await button(page, 'Open fixture Birch FC rehearsal, 07/11/26');
    await button(page, 'Edit or reschedule fixture');
    await page.getByLabel('Match date (YYYY-MM-DD)', { exact: true }).fill('2026-11-14');
    await page.getByTestId('preparation-save').click();
    app = await until(page, value => value.preparation.fixtures.find(item => item.id === fixture.id)?.playedDate === '2026-11-14', 'Fixture reschedule');
    assert.equal(app.preparation.fixtures.filter(item => item.id === fixture.id).length, 1);
    await button(page, 'Cancel fixture');
    app = await until(page, value => value.preparation.fixtures.find(item => item.id === fixture.id)?.status === 'cancelled', 'Fixture cancel');
    const final = app.preparation.fixtures.find(item => item.id === fixture.id);
    assert.equal(final.history[0].playedDate, '2026-11-07');
    assert(final.history.length >= 3);
    await page.reload({ waitUntil: 'networkidle' });
    await enterFictionalReview(page);
    await button(page, 'Schedule');
    await button(page, 'Open fixture Birch FC rehearsal, 14/11/26');
    await page.getByRole('button', { name: 'Restore as scheduled', exact: true }).waitFor();
    return 'Create/reschedule/cancel preserve one identity and old played date; cancelled status survives reload.';
  });

  await scenario('02-training-evidence', async page => {
    const initial = await application(page);
    const initialProfileId = initial.preparation.profiles.find(item => item.playerId === playerId).id;
    const initialHeld = initial.preparation.training.filter(item => item.status === 'held' && item.seasonId === seasonId && item.expectedProfileIds.includes(initialProfileId)).length;
    await button(page, 'Schedule'); await radio(page, 'Event type: Training');
    await button(page, 'Open training 22/10/26');
    await radio(page, 'Oliver Bennett training reply: Available');
    let app = await until(page, value => Object.values(value.preparation.training[0].responses).includes('available'), 'Training RSVP');
    const profile = app.preparation.profiles.find(item => item.playerId === playerId);
    assert.equal(app.preparation.training[0].attendance[profile.id], undefined, 'Available is not attendance');
    await radio(page, 'Occurrence status: Held');
    await until(page, value => value.preparation.training[0].status === 'held', 'Training held');
    await radio(page, 'Oliver Bennett training attendance: Present');
    await until(page, value => value.preparation.training[0].attendance[profile.id] === 'present', 'Training actual attendance');
    await button(page, 'Back to schedule'); await button(page, 'Open training 29/10/26');
    await radio(page, 'Occurrence status: Cancelled');
    app = await until(page, value => value.preparation.training[1].status === 'cancelled', 'Cancel second occurrence');
    assert.equal(app.preparation.training[0].status, 'held', 'Occurrence cancellation cannot cancel whole series');
    const evidence = app.recordsBySeason[seasonId].trainingAttendance;
    const eligible = evidence.filter(item => item.eventStatus === 'held' && item.expectedPlayerIds.includes(playerId));
    assert.equal(eligible.length, initialHeld + 1);
    assert(!eligible.some(item => item.sessionId === app.preparation.training[1].id), 'Cancelled occurrence cannot enter the denominator');
    await button(page, 'Reports'); await page.getByTestId('records-tab-participation').click();
    const own = page.getByTestId(`records-participation-${playerId}`).locator('..');
    const recorded = eligible.filter(item => ['present', 'absent', 'excused'].includes(item.attendance[playerId])).length;
    assert((await own.innerText()).includes(`Completeness ${Math.round(recorded / eligible.length * 100)}% (${recorded}/${eligible.length} eligible events)`));
    assert.equal(eligible.find(item => item.sessionId === app.preparation.training[0].id).attendance[playerId], 'present');
    return 'RSVP does not check in; the newly held expected session increases the retained baseline denominator by one, while the cancelled occurrence is excluded.';
  });

  await scenario('03-snapshots-and-formats', async page => {
    await button(page, 'Schedule'); await button(page, 'Open fixture Maple FC, 24/10/26');
    await page.getByTestId('preparation-open-match').click();
    const prepared = await until(page, value => value.preparation.snapshots.length > 0, 'Prepare immutable profile snapshot');
    const previous = prepared.preparation.snapshots[0].profiles.find(item => item.playerId === playerId);
    await button(page, 'Back to team; clock continues'); await button(page, 'Team'); await button(page, 'Edit Oliver Bennett');
    await page.getByLabel('Player display name', { exact: true }).fill('Oliver Bennett Rehearsal'); await page.getByTestId('preparation-save').click();
    let app = await until(page, value => value.preparation.profiles.some(item => item.displayName === 'Oliver Bennett Rehearsal'), 'Profile edit');
    assert.deepEqual(app.preparation.snapshots[0].profiles.find(item => item.playerId === playerId), previous);
    await more(page, 'Team and season settings');
    for (const size of [5, 11]) {
      await button(page, 'Create formation template'); await page.getByLabel('Formation name', { exact: true }).fill(`Browser ${size} formation`);
      await radio(page, `Formation pitch places: ${size}`); await page.getByTestId('preparation-save').click();
      app = await until(page, value => value.preparation.formations.some(item => item.name === `Browser ${size} formation`), `${size}-a-side template`);
      const formation = app.preparation.formations.find(item => item.name === `Browser ${size} formation`);
      assert.equal(formation.slots.length, size); assert.equal(new Set(formation.slots.map(item => item.id)).size, size);
    }
    return 'Prepared profiles are unchanged after edit; 5- and 11-place formations save with distinct stable slots.';
  });

  await scenario('04-historical-results', async page => {
    await button(page, 'Reports'); assert.equal(await page.getByTestId('records-total-points').innerText(), '4');
    await page.getByTestId('records-add-past').click();
    await page.getByTestId('records-past-date').fill('2026-09-20'); await page.getByTestId('records-past-opponent').fill('Birch historical rehearsal');
    await radio(page, 'friendly'); await page.getByTestId('records-past-for').fill('1'); await page.getByTestId('records-past-against').fill('0');
    await page.getByTestId('records-past-review-button').click(); await page.getByTestId('records-past-save').click();
    let app = await until(page, value => value.recordsBySeason[seasonId].results.some(item => item.opponent === 'Birch historical rehearsal'), 'Historical result save');
    let record = app.recordsBySeason[seasonId].results.find(item => item.opponent === 'Birch historical rehearsal');
    assert.equal(record.participation, null); assert.equal(record.attendance, null); assert.equal(record.actualActiveDurationMs, null); assert.equal(record.halfTimeScore, null); assert.equal(record.awardStatus, 'not_recorded');
    await page.getByText('Minutes, position intervals and targets were not recorded for this historical summary.', { exact: true }).waitFor();
    await button(page, 'Back to records'); assert.equal(await page.getByTestId('records-total-points').innerText(), '7');
    await page.getByTestId(`records-result-${record.id}`).click(); await page.getByTestId('records-correct').click();
    await page.getByTestId('records-past-against').fill('2'); await page.getByTestId('records-correction-reason').fill('Fictional original score verified.');
    await page.getByTestId('records-past-review-button').click(); await page.getByTestId('records-past-save').click();
    app = await until(page, value => value.recordsBySeason[seasonId].results.find(item => item.id === record.id)?.revision === 2, 'Historical correction');
    const audit = app.recordsBySeason[seasonId].audit.at(-1); assert.equal(audit.before.finalScore.against, 0); assert.equal(audit.after.finalScore.against, 2);
    await button(page, 'Back to records'); assert.equal(await page.getByTestId('records-total-points').innerText(), '4');
    return 'A friendly win adds 3 points; corrected loss removes them with before/after audit; unknown participation remains null.';
  });

  await scenario('05-private-role-projections', async page => {
    await role(page, 'player'); await button(page, 'Schedule'); await button(page, 'Training');
    await page.getByRole('button', { name: 'Training: Available', exact: true }).first().click();
    let app = await until(page, value => Object.values(value.preparation.training[0].responses).includes('available'), 'Own training response');
    const profile = app.preparation.profiles.find(item => item.playerId === playerId);
    assert.equal(app.preparation.training[0].attendance[profile.id], undefined);
    await button(page, 'My game'); await page.getByTestId('records-tab-participation').click();
    const ownView = await page.getByTestId('records-screen').innerText();
    assert.match(ownView, /Oliver Bennett/); assert.doesNotMatch(ownView, /Noah Patel|Leo Martin|George Taylor/);
    assert.equal(await page.getByTestId('records-participation-synthetic-player-02').count(), 0);
    await role(page, 'spectator');
    assert.equal(await page.getByTestId('records-tab-participation').count(), 0);
    assert.equal(await page.getByTestId('records-season-totals').count(), 0);
    assert.equal(await page.getByTestId('records-form').count(), 0);
    assert.equal(await page.getByTestId('records-add-past').count(), 0);
    await page.getByText(/Scores and derived totals are not shared/).waitFor();
    await button(page, 'Photos'); assert.equal(await page.getByTestId('community-submit-photo').count(), 0); assert.equal(await page.getByTestId('community-approve-photo').count(), 0);
    assert.equal(await page.getByText('Fictional football illustration awaiting review.', { exact: true }).count(), 0);
    return 'Player sees own named rows only; responses leave attendance unknown; spectator has no private report/control or withheld derived score.';
  });

  await scenario('06-exact-photo-revision', async page => {
    const originalCaption = (await application(page)).community.photos.find(item => item.id === 'synthetic-pending-ball').revisions[0].caption;
    await role(page, 'spectator'); await button(page, 'Photos');
    assert.equal(await page.getByText(originalCaption, { exact: true }).count(), 0);
    await role(page, 'manager'); await more(page, 'Team photos');
    await button(page, 'Approve Oliver Bennett revision 1');
    await until(page, value => value.community.photos.find(item => item.id === 'synthetic-pending-ball')?.publishedRevision === 1, 'Approve exact original revision');
    await role(page, 'player'); await button(page, 'Photos');
    await page.getByLabel('Illustration caption', { exact: true }).fill('Browser revised cones'); await radio(page, 'Choose cones illustration'); await page.getByRole('switch', { name: 'Content policy reviewed', exact: true }).check();
    await button(page, 'Submit a revised caption and selected illustration');
    let app = await until(page, value => value.community.photos.find(item => item.id === 'synthetic-pending-ball')?.currentRevision === 2, 'Submit revised pending media');
    assert.equal(app.community.photos.find(item => item.id === 'synthetic-pending-ball').publishedRevision, 1);
    await role(page, 'spectator'); await button(page, 'Photos');
    assert.equal(await page.getByText('Browser revised cones', { exact: true }).count(), 0);
    await page.getByRole('button', { name: `Open ${originalCaption}`, exact: true }).waitFor();
    await role(page, 'manager'); await more(page, 'Team photos'); await button(page, 'Approve Oliver Bennett revision 2');
    await until(page, value => value.community.photos.find(item => item.id === 'synthetic-pending-ball')?.publishedRevision === 2, 'Approve exact replacement revision');
    await button(page, 'Open Browser revised cones'); await button(page, 'Remove this published illustration');
    app = await until(page, value => value.community.photos.find(item => item.id === 'synthetic-pending-ball')?.removedAtMs !== null, 'Remove published revision');
    assert.equal(app.community.photos.find(item => item.id === 'synthetic-pending-ball').revisions.length, 2);
    await role(page, 'spectator'); await button(page, 'Photos'); assert.equal(await page.getByText('Browser revised cones', { exact: true }).count(), 0);
    return 'Pending media stays private; exact approval publishes v1/v2, previous approved revision remains until replacement approval, removal blocks spectator retrieval.';
  });

  await scenario('07-private-ballot', async page => {
    let app = await application(page); assert.equal(app.community.matches[0].voteCutoffAtMs, null); assert.equal(app.community.ballots.length, 0);
    await more(page, 'Players’ award');
    assert.equal(await page.getByTestId('community-cast-ballot').count(), 0, 'Managers cannot cast player ballot');
    await page.getByLabel('Demo ballot cutoff minutes', { exact: true }).fill('25'); await page.getByTestId('community-configure-cutoff').click();
    app = await until(page, value => value.community.matches[0].cutoffSource === 'explicit_fictional_setting', 'Explicit cutoff');
    assert.equal(app.community.matches[0].voteCutoffAtMs - app.community.matches[0].actualFullTimeAtMs, 25 * 60_000);
    await role(page, 'player'); await more(page, 'Players’ award');
    assert.equal(await page.getByRole('radio', { name: 'Oliver Bennett', exact: true }).count(), 0, 'Self is absent from candidates');
    await radio(page, 'Noah Patel'); await page.getByTestId('community-cast-ballot').click();
    app = await until(page, value => value.community.ballots.length === 1, 'Private own ballot');
    await radio(page, 'Leo Martin'); await page.getByTestId('community-cast-ballot').click();
    app = await until(page, value => value.community.ballots.length === 2, 'Changed private own ballot');
    assert.deepEqual(app.community.ballots.map(item => item.revision), [1, 2]); assert.equal(new Set(app.community.ballots.map(item => item.voterPlayerId)).size, 1);
    await role(page, 'manager'); await more(page, 'Players’ award'); assert.equal(await page.getByText(/Your saved choice:/).count(), 0); assert.equal(await page.getByRole('radio').count(), 0);
    await page.getByTestId('community-finalise-award').click(); await button(page, 'Confirm close and finalise');
    app = await until(page, value => value.community.awards.length === 1, 'Sealed latest valid ballot');
    assert.deepEqual(app.community.awards[0].winnerPlayerIds, ['synthetic-player-03']);
    assert.equal(app.community.awards[0].finalisationDeadlineAtMs, app.community.matches[0].actualFullTimeAtMs + 3_600_000);
    return 'No default +59 cutoff; explicit fictional +25; self excluded, one player changes own private revision, manager sees no ballot, latest valid vote seals under original deadline.';
  });

  await scenario('08-invitations-revocation', async page => {
    await more(page, 'Invitations and access'); await page.getByLabel('Invitation validity in hours', { exact: true }).fill('24'); await page.getByTestId('community-create-invite').click();
    let app = await until(page, value => value.community.invitations.length === 1, 'Individual invitation'); const invite = app.community.invitations[0];
    assert.match(invite.reviewCode, /^DEMO-/); assert.equal(invite.seasonId, seasonId);
    await button(page, 'Revoke invitation and linked access'); await until(page, value => value.community.invitations[0].revokedAtMs !== null, 'Invitation revocation');
    const spectatorLabel = app.community.accounts.find(account => account.id === app.community.grants[0].accountId).label;
    await button(page, `Revoke access for ${spectatorLabel}`); app = await until(page, value => value.community.grants[0].revokedAtMs !== null, 'Grant revocation');
    await role(page, 'spectator'); await button(page, 'Photos');
    await page.getByText(/Access unavailable|revoked|expired|no active invitation/i).first().waitFor();
    assert.equal(await page.getByRole('button', { name: /Open .*illustration/ }).count(), 0);
    assert(app.community.audit.some(item => item.type === 'grant.revoked' || item.action === 'grant.revoked'));
    return 'Individual invitation and season grant revocations retain audit and block old spectator gallery retrieval.';
  });

  await scenario('09-durability-stale-tab', async (page, context) => {
    const other = await open(context);
    await button(page, 'Team'); await button(other, 'Team');
    await button(page, 'Edit Oliver Bennett'); await button(other, 'Edit Oliver Bennett');
    await page.getByLabel('Player display name', { exact: true }).fill('Oliver Bennett accepted tab'); await page.getByTestId('preparation-save').click();
    await until(page, value => value.preparation.profiles.some(item => item.displayName === 'Oliver Bennett accepted tab'), 'Accepted first tab');
    await other.getByLabel('Player display name', { exact: true }).fill('Oliver Bennett rejected tab'); await other.getByTestId('preparation-save').click();
    await other.getByRole('button', { name: 'Reload saved team records; retain conflict', exact: true }).waitFor();
    const record = await stored(other); const app = record.projections[documentId];
    assert(app.preparation.profiles.some(item => item.displayName === 'Oliver Bennett accepted tab'));
    assert(!app.preparation.profiles.some(item => item.displayName === 'Oliver Bennett rejected tab'));
    const conflicts = Object.values(record.events).filter(item => item.matchId === documentId && item.disposition === 'quarantined');
    assert.equal(conflicts.length, 1); assert(conflicts[0].rejectedProjection.preparation.profiles.some(item => item.displayName === 'Oliver Bennett rejected tab'));
    await button(other, 'Reload saved team records; retain conflict');
    const retainedEditor = other.getByRole('button', { name: 'Keep previous values', exact: true });
    if (await retainedEditor.count()) await retainedEditor.click();
    await other.getByRole('button', { name: 'Edit Oliver Bennett accepted tab', exact: true }).waitFor();
    await page.reload({ waitUntil: 'networkidle' }); await enterFictionalReview(page); await button(page, 'Team'); await page.getByRole('button', { name: 'Edit Oliver Bennett accepted tab', exact: true }).waitFor();
    assert.equal(Object.values((await stored(page)).events).filter(item => item.disposition === 'quarantined').length, 1);
    return 'Reload preserves accepted team document; stale second-tab write cannot overwrite it and retained rejected projection survives reload.';
  });
} finally {
  await browser.close();
  const report = { baseURL, generatedAt: new Date().toISOString(), scenarioFilter: scenarioFilter || null, viewport: { width: 390, height: 844 }, method: 'User controls only; read-only IndexedDB evidence; no state injection.', results, pageErrors: errors, limitations: ['Fictional local role controls do not establish server authorisation.', 'Native encryption, background delivery, reboot and lock need physical iPhone/Android verification.', 'Photo processing uses original synthetic illustrations; device picker/upload/scanning are not proved.'] };
  await writeFile(path.join(output, scenarioFilter ? `report-${scenarioFilter.replaceAll(/[^a-zA-Z0-9_-]/g, '_')}.json` : 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  assert(results.length > 0, 'The selected application review scenario must exist.');
  assert.equal(errors.length, 0, `Unexpected page errors: ${errors.join('; ')}`);
  assert.equal(results.filter(item => item.status === 'failed').length, 0, 'Some application journeys failed. Read .local/application-review/report.json.');
}
