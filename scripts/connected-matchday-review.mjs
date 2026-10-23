import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { captureReviewArtifacts, assertReviewArtifactsUnchanged, assertReviewApiPortAvailable } from './review-artifacts.mjs';
import { REVIEW_STATUS_REQUEST, enterFictionalReview, openWorkspaceTab } from './review-entry.mjs';

const baseURL = process.env.LONGBALL_REVIEW_BASE_URL ?? 'http://127.0.0.1:4173';
const api = process.env.LONGBALL_REVIEW_API_URL ?? 'http://127.0.0.1:4360', tunnel = 'https://longball-matchday-review.trycloudflare.com';
const apiEntry = process.env.LONGBALL_REVIEW_API_ENTRY ?? 'apps/api/dist/api.mjs';
const directory = process.env.LONGBALL_REVIEW_OUTPUT ?? '.local/connected-matchday-review', matchId = 'synthetic-roma-maple-2026-10-24';
const token = 'synthetic-manager-2';
const phoneWidth = Number(process.env.LONGBALL_REVIEW_PHONE_WIDTH ?? 390);
assert([320, 390].includes(phoneWidth), 'Choose an explicitly reviewed320px or390px phone viewport.');
await assertReviewApiPortAvailable(api);
const artifacts = await captureReviewArtifacts(baseURL, apiEntry);
await mkdir(directory, { recursive: true });
const id = Date.now(), log = createWriteStream(`${directory}/${id}-api.log`);
const server = spawn(process.execPath, [apiEntry], { env: { ...process.env, NODE_ENV: 'development', LONGBALL_SYNTHETIC_AUTH: '1', LONGBALL_DEMO_SCENARIO: '1', LONGBALL_DATABASE_URL: '', LONGBALL_DATABASE_URL_FILE: '', LONGBALL_API_HOST: '127.0.0.1', LONGBALL_API_PORT: new URL(api).port, LONGBALL_API_DATABASE: `${directory}/${id}.sqlite`, LONGBALL_MEDIA_DIRECTORY: `${directory}/${id}-media`, LONGBALL_API_ORIGINS: new URL(baseURL).origin, LONGBALL_FICTIONAL_CLOCK_POLICY: JSON.stringify({ id: 'fictional-connected-matchday-clock-v1', serverClockUncertaintyMs: 1000, maximumRoundTripMs: 5000, maximumMappingAgeMs: 3600000, maximumUncertaintyMs: 3000, maximumDriftPpm: 100 }) }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.pipe(log); server.stderr.pipe(log);
const browser = await chromium.launch({ executablePath: process.env.LONGBALL_CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: phoneWidth, height: 844 }, reducedMotion: 'reduce' });
page.setDefaultTimeout(20_000);
const errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
const button = name => page.getByRole('button', { name, exact: true });
async function readAccepted() {
  const response = await fetch(`${api}/v1/matches/${matchId}/download?deviceId=independent-read-only-review`, { headers: { Authorization: `Bearer ${token}` } });
  assert(response.ok, `Independent accepted read HTTP${response.status}`);
  return response.json();
}
async function createUnpreparedFixture(contractVersion) {
  const route = `${api}/v1/teams/synthetic-roma-u10/preparation?seasonId=synthetic-season-2026-27`;
  let preparation = await (await fetch(route, { headers: { Authorization: `Bearer ${token}` } })).json();
  const fixtureId = `qa-unprepared-${randomUUID()}`;
  const commands = [
    { type: 'fixture.saved', fixture: { id: fixtureId, seasonId: 'synthetic-season-2026-27', opponent: 'Cedar QA FC', playedDate: '2026-10-25', kickoff: '10:00', arrival: '09:30', venue: 'Roma training ground', homeAway: 'home', format: 7, plannedHalfDurationMs: 1_500_000 } },
    { type: 'fixture.selection_saved', fixtureId, selectedProfileIds: preparation.profiles.filter(profile => profile.active).slice(0, 9).map(profile => profile.id) },
  ];
  for (const payload of commands) {
    const command = { ...payload, id: randomUUID(), expectedRevision: preparation.revision };
    const response = await fetch(route, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Longball-Role': 'manager', 'Content-Type': 'application/json', 'X-Api-Contract-Version': contractVersion, 'Idempotency-Key': command.id }, body: JSON.stringify({ command }) });
    assert.equal(response.status, 200, 'The negative fixture must be created through actual preparation commands.');
    preparation = await response.json();
  }
  assert(!preparation.snapshots.some(snapshot => snapshot.fixtureId === fixtureId), 'The negative fixture must have no prepared snapshot.');
  const download = await fetch(`${api}/v1/matches/${fixtureId}/download?deviceId=unprepared-negative-review`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(download.status, 404, 'An unprepared fixture must not expose a canonical match.');
  const claim = await fetch(`${api}/v1/matches/${fixtureId}/controller`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Api-Contract-Version': contractVersion, 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ deviceId: 'unprepared-negative-review' }) });
  assert.equal(claim.status, 404, 'An unprepared fixture must not acquire recording authority through HTTP.');
  return fixtureId;
}
try {
  const deadline = Date.now() + 20_000;
  while (true) { try { assert.equal((await (await fetch(`${api}/health`)).json()).syntheticOnly, true); break; } catch (error) { if (Date.now() >= deadline || server.exitCode !== null) throw error; await new Promise(resolve => setTimeout(resolve, 100)); } }
  const health = await (await fetch(`${api}/health`)).json();
  const unpreparedFixtureId = await createUnpreparedFixture(health.contractVersion);
  await page.route(REVIEW_STATUS_REQUEST, route => route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: { state: 'ready', url: tunnel, startedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), sourceRevision: 'a'.repeat(40) } }));
  await page.route(`${tunnel}/**`, async route => { const response = await route.fetch({ url: api + route.request().url().slice(tunnel.length) }); await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': new URL(baseURL).origin } }); });
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await enterFictionalReview(page, 'manager', 'connected');
  await page.getByTestId('workspace-context-ready').waitFor();
  await openWorkspaceTab(page, 'controller');
  await page.getByLabel('Connected match identifier', { exact: true }).fill(unpreparedFixtureId);
  await page.getByTestId('recording-acquire').waitFor();
  assert.equal(await page.getByTestId('recording-acquire').isDisabled(), true, 'The separately created unprepared fixture must not claim recording authority');
  checks.push('A separate fixture created through actual preparation commands, with no prepared formation/player snapshot, has no canonical match, refuses HTTP controller claim, and keeps the UI recording claim disabled. Prepared Maple remains the positive matchday fixture.');
  await openWorkspaceTab(page, 'schedule');
  await page.getByRole('button', { name: 'Open fixture Maple FC, 2026-10-24', exact: true }).click();
  await page.getByTestId('preparation-open-match').click();
  await page.getByTestId('recording-acquire').waitFor();
  await page.getByTestId('workspace-match-header').waitFor();
  assert.equal(await page.getByTestId('workspace-tab-home').count(), 0, 'The focused match console must hide team navigation');
  const initial = await readAccepted();
  assert.equal(initial.acceptedRevision, 0);
  const match = initial.state ?? initial.acceptedState ?? initial.match;
  assert(match?.config, 'The real service must supply the match fixture');
  const slots = match.config.slots;
  // Choose a valid fixture lineup, then enter every assignment through the visible UI.
  const assignments = [];
  function choose(index, used = new Set()) {
    if (index === slots.length) return true;
    for (const player of match.config.players.filter(player => match.config.selectedPlayerIds.includes(player.id))) {
      const profile = match.config.profileSnapshot.find(profile => profile.playerId === player.id);
      if (used.has(player.id) || !profile.eligiblePositions.includes(slots[index].position) || slots[index].position === 'GK' && match.config.fixedKeeperId && player.id !== match.config.fixedKeeperId) continue;
      assignments[index] = player;
      if (choose(index + 1, new Set([...used, player.id]))) return true;
    }
    return false;
  }
  assert(choose(0), 'The controlled service fixture needs a valid lineup');
  await page.getByTestId('recording-acquire').click();
  await page.getByTestId('connected-match-attendance').click();
  for (const playerId of match.config.selectedPlayerIds) {
    const row = page.locator('div').filter({ has: page.getByText(new RegExp(`^${match.config.players.find(player => player.id === playerId).displayName} · `)) }).filter({ has: button('Present') }).last();
    const present = row.getByRole('button', { name: 'Present', exact: true });
    await present.click();
    await present.waitFor({ state: 'visible' });
    await page.waitForFunction(() => ![...document.querySelectorAll('[role="progressbar"]')].length);
  }
  checks.push('Selected manager account downloads the real service fixture, explicitly claims recording, and records actual attendance through the shared editor.');
  await page.getByTestId('connected-match-lineup').click();
  await button('Show position list').click();
  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index];
    await page.getByRole('button', { name: new RegExp(`^${slot.label ?? slot.position} · place ${index + 1},`) }).click();
    await button(assignments[index].displayName).click();
  }
  await button('Save staged lineup').click();
  assert.equal((await readAccepted()).acceptedRevision, 0, 'Local saves must not claim server acknowledgement');
  checks.push('A complete eligible staged lineup is saved locally; the independent service read remains unchanged before explicit upload.');
  await page.getByTestId('connected-match-live').click();
  await button('Start first half').click();
  await button('Confirm the actual event now').click();
  await page.getByTestId('workspace-back-to-team').click();
  await page.getByTestId('workspace-manager-home').waitFor();
  await page.getByTestId('workspace-return-to-match').click();
  await page.getByTestId('connected-match-live').click();
  await button('Review referee pause').click();
  await button('Confirm the actual event now').click();
  await page.getByTestId('recording-upload').click();
  let accepted;
  for (let attempt = 0; attempt < 40; attempt++) { accepted = await readAccepted(); if (accepted.acceptedRevision >= match.config.selectedPlayerIds.length + 3) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  const saved = accepted.state ?? accepted.acceptedState ?? accepted.match;
  assert.equal(saved.status, 'first_half_paused');
  assert.equal(saved.lineup.length, match.config.pitchPlaces);
  assert.equal(saved.config.selectedPlayerIds.filter(id => saved.attendance[id] === 'present').length, match.config.selectedPlayerIds.length);
  assert(saved.matchActiveMs >= 0);
  assert.deepEqual(saved.score, { for: 0, against: 0 });
  await page.getByText('Up to date with the service', { exact: true }).waitFor();
  const fixedSummary = page.getByTestId('connected-match-fixed-summary');
  const actionRail = page.getByTestId('connected-match-action-rail');
  const beforeGeometry = { summary: await fixedSummary.boundingBox(), rail: await actionRail.boundingBox() };
  assert(beforeGeometry.summary && beforeGeometry.rail && beforeGeometry.summary.y < 330 && beforeGeometry.rail.y + beforeGeometry.rail.height <= 845, 'Score/countdown and match actions must be visible in the phone viewport');
  await page.getByTestId('connected-match-content-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
  const afterGeometry = { summary: await fixedSummary.boundingBox(), rail: await actionRail.boundingBox() };
  assert(Math.abs(afterGeometry.summary.y - beforeGeometry.summary.y) < 1 && Math.abs(afterGeometry.rail.y - beforeGeometry.rail.y) < 1, 'Score/countdown and action rail must stay fixed while match details scroll');
  assert.match(await page.getByTestId('connected-match-countdown').innerText(), /25:00|24:5\d/);
  checks.push('The focused match hides team navigation; Back to team and return preserve the running clock without another event. Explicit kickoff and referee pause use the existing confirmation, journal and canonical upload; an independent HTTP read verifies accepted attendance, lineup, time and unchanged score. Fixed score/countdown and action rail stay visible while match details scroll.');
  const viewer = await browser.newPage({ viewport: { width: phoneWidth, height: 844 }, reducedMotion: 'reduce' });
  viewer.setDefaultTimeout(20_000);
  viewer.on('pageerror', error => errors.push(error.message));
  await viewer.route(REVIEW_STATUS_REQUEST, route => route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: { state: 'ready', url: tunnel, startedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), sourceRevision: 'a'.repeat(40) } }));
  await viewer.route(`${tunnel}/**`, async route => { const response = await route.fetch({ url: api + route.request().url().slice(tunnel.length) }); await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': new URL(baseURL).origin } }); });
  await viewer.goto(baseURL, { waitUntil: 'networkidle' });
  await enterFictionalReview(viewer, 'spectator', 'connected');
  const sharedCard = viewer.getByTestId(`match-centre-game-${matchId}`);
  await sharedCard.getByText('0 – 0', { exact: true }).waitFor();
  await page.getByTestId('open-goal').click();
  await button('Penalty').click();
  const capturedGoalTime = await page.getByText(/^Effective time: half /).innerText();
  await button('Review clock resume').click();
  await button('Confirm the actual event now').click();
  await page.getByTestId('recording-upload').click();
  await page.getByText('Up to date with the service', { exact: true }).waitFor();
  await page.getByTestId('save-goal').waitFor();
  assert.equal(await page.getByText(/^Effective time: half /).innerText(), capturedGoalTime, 'Upload verification must not discard or recapture the open goal draft');
  await page.getByTestId('save-goal').click();
  await page.getByTestId('save-goal').waitFor({ state: 'hidden' });
  const savedGoal = await page.evaluate(async (target) => {
    const record = await new Promise((resolve, reject) => {
      const opening = indexedDB.open('longball-synthetic-m0');
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => { const db = opening.result, transaction = db.transaction('journal', 'readonly'); const read = transaction.objectStore('journal').get('record'); transaction.oncomplete = () => { db.close(); resolve(read.result); }; transaction.onerror = () => reject(transaction.error); };
    });
    const document = Object.values(record?.projections ?? {}).find(value => value?.kind === 'longball-canonical-connected-v1' && value.matchId === target);
    return document?.outbox.findLast(value => value.envelope.command.type === 'goal.recorded')?.envelope.command;
  }, matchId);
  assert.equal(savedGoal.goalType, 'penalty', 'Selected goal type survives clock-upload verification');
  assert.equal(savedGoal.effective.halfElapsedMs, saved.halfActiveMs, 'Goal keeps its original paused capture time after the clock resumes');
  checks.push('An open penalty goal draft retains its selection and original paused capture time while a resumed-clock event is uploaded and its verified snapshot installed; only the later explicit goal confirmation records it.');
  assert.deepEqual((await readAccepted()).state.score, { for: 0, against: 0 }, 'A locally saved goal must remain invisible to the spectator');
  assert.equal(await sharedCard.getByText('1 – 0', { exact: true }).count(), 0);
  await page.getByTestId('recording-upload').click();
  await sharedCard.getByText('1 – 0', { exact: true }).waitFor({ timeout: 8_000 });
  const finalAccepted = await readAccepted();
  assert.deepEqual(finalAccepted.state.score, { for: 1, against: 0 });
  checks.push('A second spectator browser sees no locally queued goal, then receives its accepted score automatically without clicking Refresh. This is a functional loopback observation, not a mobile-network p95 benchmark.');
  assert(!/fictional|Player \d{2}/i.test(await viewer.locator('body').innerText()));
  await viewer.screenshot({ path: `${directory}/automatic-spectator-update-${phoneWidth}.png`, animations: 'disabled' });
  await viewer.close();
  assert.deepEqual(errors, []);
  await assertReviewArtifactsUnchanged(artifacts, baseURL, apiEntry);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: `${directory}/accepted-match-clock-${phoneWidth}.png`, fullPage: true, animations: 'disabled' });
  await writeFile(`${directory}/report.json`, JSON.stringify({ passed: true, phoneViewport: { width: phoneWidth, height: 844 }, checkedAt: new Date().toISOString(), artifacts, checks, pausedCheckpoint: { acceptedRevision: accepted.acceptedRevision, status: saved.status }, acceptedRevision: finalAccepted.acceptedRevision, acceptedStatus: finalAccepted.state.status, browserErrors: errors, fixture: 'Isolated fictional SQLite; transport-only discovery redirect; actual HTTP commands, no state injection', nativeDeviceEvidence: false }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, checks: checks.length, phoneWidth, acceptedRevision: finalAccepted.acceptedRevision }));
} catch (error) {
  await page.screenshot({ path: `${directory}/failed.png`, fullPage: true }).catch(() => {});
  await writeFile(`${directory}/failure.json`, JSON.stringify({ artifacts, checks, error: String(error), errors }, null, 2) + '\n');
  throw error;
} finally { await browser.close(); server.kill('SIGTERM'); log.end(); }
