import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { enterFictionalReview } from './review-entry.mjs';

/** Real phone-width browser actions; no domain state is injected or rewritten. */
const baseURL = process.env.LONGBALL_REVIEW_BASE_URL ?? 'http://127.0.0.1:4173';
const matchId = 'synthetic-roma-maple-2026-10-24';
const directory = path.resolve('.local/review');
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.LONGBALL_CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
  headless: true, args: ['--no-sandbox'],
});
const checks = [];
const errors = [];
let activePage;

async function record(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('longball-synthetic-m0', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('journal')) { database.close(); resolve(null); return; }
      const transaction = database.transaction('journal', 'readonly');
      const query = transaction.objectStore('journal').get('record');
      query.onerror = () => reject(query.error);
      transaction.oncomplete = () => { const value = query.result; database.close(); resolve(value); };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  }));
}
async function saved(page, requestedId = matchId) {
  const journal = await record(page);
  assert(journal?.projections?.[requestedId], `Missing saved projection ${requestedId}.`);
  return journal.projections[requestedId];
}
async function waitState(page, predicate, message, requestedId = matchId) {
  const deadline = Date.now() + 15_000;
  let state;
  do {
    state = (await record(page))?.projections?.[requestedId];
    if (state && predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 40));
  } while (Date.now() < deadline);
  assert.fail(`${message}; latest=${state?.status ?? 'missing'}/${state?.revision ?? 'unknown'}`);
}
async function picture(page, name) {
  await page.screenshot({ path: path.join(directory, `live-${name}.png`), animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: horizontal overflow.`);
}
async function open(context) {
  const page = await context.newPage();
  activePage = page;
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await enterFictionalReview(page);
  await page.getByTestId('prepare-match').waitFor();
  await waitState(page, state => state.status === 'preparation', 'Initial match did not load');
  return page;
}
const played = state => state.intervals.filter(interval => interval.state === 'playing')
  .reduce((sum, interval) => sum + interval.endMs - interval.startMs, 0);
function playerTotals(state, playerId) {
  const totals = { playing: 0, available_bench: 0, unavailable: 0 };
  for (const interval of state.intervals.filter(interval => interval.playerId === playerId)) totals[interval.state] += interval.endMs - interval.startMs;
  return totals;
}
async function start(page) {
  await page.getByTestId('prepare-match').click();
  await page.getByTestId('check-in-all').click();
  await waitState(page, state => state.config.selectedPlayerIds.every(id => state.attendance[id] === 'present'), 'Check-in did not save');
  await page.getByTestId('continue-lineup').click();
  await page.getByTestId('place-seven').click();
  await waitState(page, state => state.stagedLineup.length === 7, 'Lineup did not stage');
  const date = new Date('2026-10-24T09:00:00.000Z');
  // pauseAt advances from installation time. Leave headroom for the browser
  // protocol round trip before freezing the clock at the match start time.
  await page.clock.install({ time: new Date(date.getTime() - 3_600_000) });
  await page.clock.pauseAt(date);
  await page.getByTestId('start-half').click();
  return waitState(page, state => state.status === 'first_half_running', 'First half did not start');
}

try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const page = await open(context);
  await start(page);

  await page.clock.fastForward(60_000);
  await page.getByText('24:00 remaining', { exact: true }).waitFor();
  await page.getByTestId('open-goal').click();
  await page.getByRole('button', { name: 'Open play', exact: true }).click();
  await page.getByRole('button', { name: 'Player 02', exact: true }).click();
  await page.clock.fastForward(15_000);
  await page.getByTestId('save-goal').click();
  let state = await waitState(page, value => value.goals?.length === 1, 'Captured goal did not save');
  const firstGoalId = state.goals[0].eventId;
  assert.deepEqual(state.score, { for: 1, against: 0 });
  assert.equal(state.goals[0].effective.halfElapsedMs, 60_000, 'Goal confirmation cannot move the captured effective time.');
  assert.equal(state.halfActiveMs, 75_000, 'Entering a goal cannot pause the clock.');
  assert.equal(state.goals[0].scorerPlayerId, 'synthetic-player-02');
  checks.push('A goal retains its captured active time and scorer while the clock advances through entry.');

  await page.clock.fastForward(15_000);
  await page.getByText('23:30 remaining', { exact: true }).waitFor();
  await page.getByTestId('open-goal').click();
  await page.getByRole('button', { name: 'Own goal · no', exact: true }).click();
  await page.getByTestId('save-goal').click();
  state = await waitState(page, value => value.goals?.length === 2, 'Opposition own goal did not save');
  const oppositionOwnGoalId = state.goals[1].eventId;
  assert.deepEqual(state.score, { for: 2, against: 0 });
  assert.equal(state.goals[1].beneficiary, 'us');
  assert.equal(state.goals[1].isOwnGoal, true);
  assert.equal(state.goals[1].scorerPlayerId, null, 'Opposition own goals cannot credit a Roma player.');

  await page.clock.fastForward(15_000);
  await page.getByText('23:15 remaining', { exact: true }).waitFor();
  await page.getByTestId('open-goal').click();
  await page.getByRole('button', { name: 'Opposition score', exact: true }).click();
  await page.getByRole('button', { name: 'Own goal · no', exact: true }).click();
  await page.getByRole('button', { name: 'Player 03', exact: true }).click();
  await page.getByTestId('save-goal').click();
  state = await waitState(page, value => value.goals?.length === 3, 'Roma own goal did not save');
  assert.deepEqual(state.score, { for: 2, against: 1 });
  assert.equal(state.goals[2].beneficiary, 'opposition');
  assert.equal(state.goals[2].isOwnGoal, true);
  assert.equal(state.goals[2].scorerPlayerId, 'synthetic-player-03');
  checks.push('Both own-goal directions change the correct score and preserve truthful team attribution.');

  await page.getByTestId('pause-resume').click();
  state = await waitState(page, value => value.status === 'first_half_paused', 'Pause before score review did not save');
  const originalIntervals = JSON.stringify(state.intervals);
  const originalTargets = JSON.stringify(state.targetIntervals);
  const revision = state.revision;
  await page.getByRole('button', { name: /^Goals and corrections/ }).click();
  await page.getByRole('button', { name: 'Correct this goal', exact: true }).first().click();
  await page.getByRole('button', { name: 'Penalty', exact: true }).click();
  await page.getByRole('textbox', { name: 'Goal correction reason', exact: true }).fill('Synthetic referee review confirmed a penalty');
  await page.getByTestId('save-goal').click();
  state = await waitState(page, value => value.revision > revision && value.goals?.[0].goalType === 'penalty', 'Audited goal correction did not save');
  assert.deepEqual(state.score, { for: 2, against: 1 });
  assert.equal(JSON.stringify(state.intervals), originalIntervals);
  assert.equal(JSON.stringify(state.targetIntervals), originalTargets);
  assert(state.eventHistory.some(event => event.id === firstGoalId), 'Original goal evidence must remain.');
  assert(state.audit.some(entry => entry.type === 'event.corrected' && entry.targetEventId === firstGoalId && entry.priorValue.goalType === 'open_play' && entry.value.goalType === 'penalty'));

  await page.getByRole('button', { name: /^Goals and corrections/ }).click();
  const voidReason = page.getByRole('textbox', { name: `Void reason for goal ${oppositionOwnGoalId}`, exact: true });
  await voidReason.click();
  await voidReason.fill('Synthetic duplicate opposition own-goal report');
  await page.getByRole('button', { name: 'Void goal; keep audit record', exact: true }).nth(1).click();
  state = await waitState(page, value => value.goals?.[1].voided === true, 'Goal void did not save');
  assert.deepEqual(state.score, { for: 1, against: 1 });
  assert.equal(JSON.stringify(state.intervals), originalIntervals, 'A score review cannot change actual participation.');
  assert.equal(JSON.stringify(state.targetIntervals), originalTargets);
  assert(state.eventHistory.some(event => event.id === oppositionOwnGoalId));
  await picture(page, '01-goal-audit');
  checks.push('Correction and compensating void retain original evidence and reasons without changing paused actual minutes or targets.');

  await page.getByTestId('pause-resume').click();
  await waitState(page, value => value.status === 'first_half_running', 'Resume did not save');
  await page.clock.fastForward(60_000);
  await page.getByText('22:15 remaining', { exact: true }).waitFor();
  await page.getByTestId('open-availability').click();
  await page.getByRole('button', { name: 'Player 07 · available', exact: true }).click();
  await page.clock.fastForward(10_000);
  await page.getByTestId('confirm-availability').click();
  state = await waitState(page, value => value.availability['synthetic-player-07'] === false, 'Injury change did not save');
  assert.equal(state.lineup.length, 6);
  assert.equal(state.availabilityHistory.at(-1).effective.matchElapsedMs, 165_000, 'Captured injury time must precede delayed confirmation.');
  await page.clock.fastForward(30_000);
  await page.getByTestId('pause-resume').click();
  state = await waitState(page, value => value.status === 'first_half_paused', 'Pause after vacancy did not save');
  await page.getByText('21:35 remaining', { exact: true }).waitFor();
  assert.equal(state.matchActiveMs, 205_000);
  assert.deepEqual(playerTotals(state, 'synthetic-player-07'), { playing: 165_000, available_bench: 0, unavailable: 40_000 });
  assert.equal(played(state), 7 * 205_000 - 40_000, 'A vacant place must remain an actual capacity shortfall.');

  await page.getByTestId('open-availability').click();
  await page.getByRole('button', { name: 'Player 07 · unavailable', exact: true }).click();
  await page.getByTestId('confirm-availability').click();
  state = await waitState(page, value => value.availability['synthetic-player-07'] === true, 'Return did not save');
  assert.equal(state.lineup.length, 6, 'An available return cannot automatically make a substitution.');
  assert(!state.lineup.some(allocation => allocation.playerId === 'synthetic-player-07'));
  await page.getByRole('button', { name: /^Striker, unfilled,/ }).click();
  await page.getByRole('button', { name: 'Choose Player 07', exact: true }).click();
  assert.equal((await saved(page)).lineup.length, 6, 'The replacement remains a draft until confirmation.');
  await page.getByTestId('confirm-lineup').click();
  state = await waitState(page, value => value.lineup.length === 7, 'Confirmed replacement did not save');
  await page.getByTestId('pause-resume').click();
  await waitState(page, value => value.status === 'first_half_running', 'Resume after replacement did not save');
  await page.clock.fastForward(20_000);
  await page.getByTestId('pause-resume').click();
  state = await waitState(page, value => value.status === 'first_half_paused', 'Final pause did not save');
  assert.equal(state.matchActiveMs, 225_000);
  assert.equal(played(state), 7 * 225_000 - 40_000);
  assert.deepEqual(playerTotals(state, 'synthetic-player-07'), { playing: 185_000, available_bench: 0, unavailable: 40_000 });
  for (const playerId of state.config.selectedPlayerIds) {
    const total = playerTotals(state, playerId);
    assert.equal(total.playing + total.available_bench + total.unavailable, state.matchActiveMs);
  }
  await picture(page, '02-vacancy-return-replacement');
  checks.push('Injury preserves a 40-second vacancy; confirmed return stays on the bench until a reviewed replacement, and every player partition conserves actual active time.');
  await context.close();

  // Boundary formats exercise saved fixture -> immutable profile/formation snapshot -> draft.
  // They use their own browser contexts so the active match controller is never replaced.
  for (const format of [5, 11]) {
    const formatContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const formatPage = await open(formatContext);
    const applicationId = 'synthetic-longball-application-v1';
    const opponent = `Fictional Format ${format}`;
    await formatPage.getByRole('button', { name: 'Schedule', exact: true }).click();
    await formatPage.getByTestId('preparation-create-event').click();
    await formatPage.getByRole('textbox', { name: 'Opposition', exact: true }).fill(opponent);
    await formatPage.getByRole('textbox', { name: 'Match date (YYYY-MM-DD)', exact: true }).fill('2026-11-01');
    await formatPage.getByRole('radio', { name: `Pitch places: ${format}`, exact: true }).click();
    await formatPage.getByRole('textbox', { name: 'Minutes per half for this match', exact: true }).fill('20');
    await formatPage.getByTestId('preparation-save').click();
    const applicationState = await waitState(formatPage, value => value.preparation.fixtures.some(fixture => fixture.opponent === opponent), 'Fixture did not save', applicationId);
    const fixture = applicationState.preparation.fixtures.find(value => value.opponent === opponent);
    assert.equal(fixture.format, format);
    assert.equal(fixture.plannedHalfDurationMs, 1_200_000);
    assert.equal(applicationState.preparation.team.defaultHalfDurationMs, 1_500_000, 'A fixture duration override cannot change the team default.');
    await formatPage.getByRole('button', { name: `Open fixture ${opponent}, 2026-11-01`, exact: true }).click();
    for (let index = 1; index <= format; index++) {
      await formatPage.getByRole('switch', { name: `Select Player ${String(index).padStart(2, '0')}`, exact: true }).click();
      await waitState(formatPage, value => value.preparation.fixtures.find(item => item.id === fixture.id).selectedProfileIds.length === index, 'Selection did not save', applicationId);
    }
    await formatPage.getByTestId('preparation-open-match').click();
    let prepared = await waitState(formatPage, value => value.config?.matchId === fixture.id, 'Prepared fixture did not open', fixture.id);
    assert.equal(prepared.config.pitchPlaces, format);
    assert.equal(prepared.config.slots.length, format);
    assert.equal(prepared.config.profileSnapshot.length, format);
    assert.equal(prepared.config.plannedHalfDurationMs, 1_200_000);
    assert.equal(Object.values(prepared.attendance).filter(value => value === 'present').length, 0, 'Selection cannot invent check-in.');
    await formatPage.getByTestId('check-in-all').click();
    await waitState(formatPage, value => Object.values(value.attendance).filter(status => status === 'present').length === format, 'Prepared fixture check-in did not save', fixture.id);
    await formatPage.getByTestId('continue-lineup').click();
    await formatPage.getByTestId('place-seven').click();
    prepared = await waitState(formatPage, value => value.stagedLineup.length === format, 'Prepared fixture lineup did not stage', fixture.id);
    assert.equal(new Set(prepared.stagedLineup.map(item => item.playerId)).size, format);
    assert.equal(new Set(prepared.stagedLineup.map(item => item.slotId)).size, format);
    for (const allocation of prepared.stagedLineup) {
      assert(prepared.config.slots.some(slot => slot.slotId === allocation.slotId && slot.position === allocation.position));
      assert(prepared.config.profileSnapshot.find(profile => profile.playerId === allocation.playerId).eligiblePositions.includes(allocation.position));
    }
    assert.equal(prepared.intervals.length, 0, 'Formation preparation must remain a draft.');
    assert.equal(await formatPage.getByTestId('start-half').isDisabled(), false);
    assert.equal((await saved(formatPage)).config.pitchPlaces, 7, 'Opening another fixture must preserve the original M0 document.');
    await picture(formatPage, `format-${format}-preparation`);
    checks.push(`${format}-a-side fixture creation, selection, saved profile/formation snapshot and valid ${format}-place draft preserve the original fixture and team duration.`);
    await formatContext.close();
  }

  assert.equal(errors.length, 0, `Browser runtime errors: ${errors.join('; ')}`);
  const result = { status: 'passed', synthetic: true, baseURL, viewport: '390×844', browser: await browser.version(), checks, nativeDeviceEvidence: false };
  await writeFile(path.join(directory, 'live-results.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: path.join(directory, 'live-error.png') }).catch(() => {});
  await writeFile(path.join(directory, 'live-results.json'), `${JSON.stringify({ status: 'failed', checks, error: String(error), errors }, null, 2)}\n`);
  throw error;
} finally { await browser.close(); }
