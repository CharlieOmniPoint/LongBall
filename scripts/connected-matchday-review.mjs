import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { enterFictionalReview, openWorkspaceTab } from './review-entry.mjs';

const baseURL = process.env.LONGBALL_REVIEW_BASE_URL ?? 'http://127.0.0.1:4173';
const api = 'http://127.0.0.1:4360', tunnel = 'https://longball-matchday-review.trycloudflare.com';
const directory = '.local/connected-matchday-review', matchId = 'synthetic-roma-maple-2026-10-24';
const token = 'synthetic-manager-2';
await mkdir(directory, { recursive: true });
const id = Date.now(), log = createWriteStream(`${directory}/${id}-api.log`);
const server = spawn(process.execPath, ['apps/api/dist/api.mjs'], { env: { ...process.env, NODE_ENV: 'development', LONGBALL_SYNTHETIC_AUTH: '1', LONGBALL_DATABASE_URL: '', LONGBALL_DATABASE_URL_FILE: '', LONGBALL_API_HOST: '127.0.0.1', LONGBALL_API_PORT: '4360', LONGBALL_API_DATABASE: `${directory}/${id}.sqlite`, LONGBALL_MEDIA_DIRECTORY: `${directory}/${id}-media`, LONGBALL_API_ORIGINS: new URL(baseURL).origin, LONGBALL_FICTIONAL_CLOCK_POLICY: JSON.stringify({ id: 'fictional-connected-matchday-clock-v1', serverClockUncertaintyMs: 1000, maximumRoundTripMs: 5000, maximumMappingAgeMs: 3600000, maximumUncertaintyMs: 3000, maximumDriftPpm: 100 }) }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.pipe(log); server.stderr.pipe(log);
const browser = await chromium.launch({ executablePath: process.env.LONGBALL_CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
page.setDefaultTimeout(20_000);
const errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
const button = name => page.getByRole('button', { name, exact: true });
async function readAccepted() {
  const response = await fetch(`${api}/v1/matches/${matchId}/download?deviceId=independent-read-only-review`, { headers: { Authorization: `Bearer ${token}` } });
  assert(response.ok, `Independent accepted read HTTP${response.status}`);
  return response.json();
}
try {
  const deadline = Date.now() + 20_000;
  while (true) { try { assert.equal((await (await fetch(`${api}/health`)).json()).syntheticOnly, true); break; } catch (error) { if (Date.now() >= deadline || server.exitCode !== null) throw error; await new Promise(resolve => setTimeout(resolve, 100)); } }
  await page.route('https://raw.githubusercontent.com/CharlieOmniPoint/LongBall/preview/longball-m0/preview-status.json', route => route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: { state: 'ready', url: tunnel, startedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), sourceRevision: 'a'.repeat(40) } }));
  await page.route(`${tunnel}/**`, async route => { const response = await route.fetch({ url: api + route.request().url().slice(tunnel.length) }); await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': new URL(baseURL).origin } }); });
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await enterFictionalReview(page, 'manager', 'connected');
  await page.getByTestId('workspace-context-ready').waitFor();
  await openWorkspaceTab(page, 'controller');
  await page.getByLabel('Connected match identifier', { exact: true }).fill(matchId);
  await page.getByText('Open this fixture in Schedule and choose Open match preparation to save its formation and player snapshots before taking control.', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('recording-acquire').isDisabled(), true, 'An unprepared seed must not claim recording authority');
  checks.push('Opening an unprepared fixture cannot claim its controller; saved formation and player snapshots are required first.');
  await openWorkspaceTab(page, 'schedule');
  await page.getByRole('button', { name: 'Open fixture Maple FC, 2026-10-24', exact: true }).click();
  await page.getByTestId('preparation-open-match').click();
  await page.getByTestId('recording-acquire').waitFor();
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
  await button('Review kickoff').click();
  await button('Confirm the actual event now').click();
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
  checks.push('Explicit kickoff and referee pause go through the existing confirmation, journal and canonical upload; a separate HTTP read verifies accepted attendance, lineup, time and unchanged score.');
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: `${directory}/accepted-match-clock-390.png`, fullPage: true, animations: 'disabled' });
  await writeFile(`${directory}/report.json`, JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), checks, acceptedRevision: accepted.acceptedRevision, acceptedStatus: saved.status, browserErrors: errors, fixture: 'Isolated fictional SQLite; transport-only discovery redirect; actual HTTP commands, no state injection', nativeDeviceEvidence: false }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, checks: checks.length, acceptedRevision: accepted.acceptedRevision }));
} catch (error) {
  await page.screenshot({ path: `${directory}/failed.png`, fullPage: true }).catch(() => {});
  await writeFile(`${directory}/failure.json`, JSON.stringify({ checks, error: String(error), errors }, null, 2) + '\n');
  throw error;
} finally { await browser.close(); server.kill('SIGTERM'); log.end(); }
