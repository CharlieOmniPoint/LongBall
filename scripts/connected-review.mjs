import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

/** Real UI/HTTP journeys. IndexedDB and service GETs are inspected read-only.
 * Each API uses a fresh isolated fictional database; no app state is injected.
 * A lost HTTP response is simulated only after route.fetch confirms server commit.
 */
const baseURL = process.env.LONGBALL_REVIEW_BASE_URL ?? 'http://127.0.0.1:4173';
const primaryAPI = process.env.LONGBALL_REVIEW_API_URL ?? 'http://127.0.0.1:4310';
const controlAPI = process.env.LONGBALL_REVIEW_CONTROL_API_URL ?? 'http://127.0.0.1:4311';
const matchId = 'synthetic-roma-maple-2026-10-24';
const teamId = 'synthetic-roma-u10', seasonId = 'synthetic-season-2026-27';
const directory = path.resolve('.local/connected-review');
const runId = new Date().toISOString().replaceAll(/[^0-9]/g, '');
const checks = [], errors = [], servers = [];
let activePage;
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.LONGBALL_CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const button = async (page, name) => {
  try { await page.getByRole('button', { name, exact: true }).click(); }
  catch (error) { await page.screenshot({ path: path.join(directory, 'last-action-failed.png'), animations: 'disabled' }).catch(() => {}); throw error; }
};
const input = (page, name, value) => page.getByLabel(name, { exact: true }).fill(value);
async function poll(read, predicate, label) {
  const deadline = Date.now() + 20_000;
  let value;
  do { value = await read(); if (predicate(value)) return value; await sleep(50); } while (Date.now() < deadline);
  assert.fail(`${label}; latest revision ${value?.revision ?? value?.acceptedRevision ?? 'unavailable'}`);
}
async function json(api, route, token = 'synthetic-manager-1') {
  const response = await fetch(`${api}${route}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.ok, true, `${route}: HTTP ${response.status}`);
  return response.json();
}
const download = (api, alias) => json(api, `/v1/matches/${matchId}/download?deviceId=${encodeURIComponent(alias)}`);
const scoped = section => `/v1/teams/${teamId}/${section}?seasonId=${seasonId}`;
async function startAPI(api, name) {
  if (process.env.LONGBALL_REVIEW_EXTERNAL_API === '1') return;
  const url = new URL(api);
  assert(['127.0.0.1', 'localhost'].includes(url.hostname), 'The fictional rehearsal may only start local APIs.');
  const database = path.join(directory, `${runId}-${name}.sqlite`);
  const stream = createWriteStream(path.join(directory, `${name}-api.log`));
  const child = spawn(process.execPath, ['apps/api/dist/api.mjs'], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'development', LONGBALL_SYNTHETIC_AUTH: '1', LONGBALL_API_HOST: '127.0.0.1', LONGBALL_API_PORT: url.port, LONGBALL_API_DATABASE: database, LONGBALL_MEDIA_DIRECTORY: path.join(directory, `${runId}-${name}-media`), LONGBALL_API_ORIGINS: `${new URL(baseURL).origin},http://localhost:4173,http://127.0.0.1:4173`, LONGBALL_CLAMSCAN_PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(stream); child.stderr.pipe(stream);
  servers.push({ child, stream });
  await poll(async () => {
    if (child.exitCode !== null) throw new Error(`Isolated API ${name} exited ${child.exitCode}; see ${name}-api.log.`);
    try { const response = await fetch(`${api}/health`); return response.ok; } catch { return false; }
  }, Boolean, `Start isolated ${name} API`);
  const initial = await download(api, 'fresh-stream-probe');
  assert.equal(initial.acceptedRevision, 0, 'Use an isolated API database, never reset or overwrite an existing match.');
}
async function stored(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('longball-synthetic-m0');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('journal')) { db.close(); resolve(null); return; }
      const transaction = db.transaction('journal', 'readonly');
      const read = transaction.objectStore('journal').get('record');
      transaction.oncomplete = () => { db.close(); resolve(read.result ?? null); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  }));
}
async function connected(page, alias, api) {
  return Object.values((await stored(page))?.projections ?? {}).find(value => value?.kind === 'longball-canonical-connected-v1' && value.deviceId === alias && value.baseUrl === api) ?? null;
}
async function workspaceOutbox(page, api, accountId = 'synthetic-account-manager') {
  return Object.entries((await stored(page))?.projections ?? {}).find(([key, value]) => key.startsWith('workspace-outbox.v1:') && value?.scope?.apiBaseUrl === api && value.scope.accountId === accountId && value.scope.teamId === teamId && value.scope.seasonId === seasonId)?.[1] ?? null;
}
const waitConnected = (page, alias, api, predicate, label) => poll(() => connected(page, alias, api), value => value && predicate(value), label);
async function enterWorkspace(page, api, account) {
  await page.getByTestId('prepare-match').waitFor();
  await button(page, 'More'); await button(page, 'Service and controller');
  await input(page, 'Workspace API URL', api);
  await button(page, 'Fictional API review'); await button(page, account);
  await page.getByTestId('workspace-connect').click();
  await page.getByTestId('workspace-session').waitFor();
  await page.getByTestId(account === 'Fictional manager' ? 'workspace-tab-controller' : 'workspace-tab-community').waitFor();
}
async function openWorkspace(api, account = 'Fictional manager') {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const page = await context.newPage(); activePage = page;
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await enterWorkspace(page, api, account);
  return { context, page };
}
async function openController(page, api, alias, manager = 'Manager A') {
  await page.getByTestId('workspace-tab-controller').click();
  await input(page, 'Connected match identifier', matchId);
  await input(page, 'LongBall service URL', api);
  await button(page, manager);
  await input(page, 'Rehearsal device identifier', alias);
  await button(page, 'Open this service connection');
  await waitConnected(page, alias, api, () => true, 'Create authorized controller document after /me');
  await button(page, 'Download accepted service match');
  return waitConnected(page, alias, api, doc => Boolean(doc.localState), 'Download canonical match');
}
async function acquire(page, alias, api) {
  await button(page, 'Acquire controller for this device');
  return waitConnected(page, alias, api, doc => doc.controllerConfirmed && !doc.pendingRequest && !doc.authoritativeDownloadRequired, 'Controller capability and authoritative checkpoint confirmed');
}
async function recordPresent(page, alias, api) {
  const before = (await connected(page, alias, api)).allocatedSequence;
  await button(page, 'Record fictional squad present');
  return waitConnected(page, alias, api, doc => doc.allocatedSequence === before + doc.localState.config.selectedPlayerIds.length, 'Explicit attendance events durably queued');
}
async function confirm(page, label, alias, api, status) {
  await button(page, label); await button(page, 'Confirm the actual event now');
  return waitConnected(page, alias, api, doc => doc.localState.status === status, label);
}
async function upload(page, alias, api) {
  await button(page, 'Upload pending canonical events');
  return waitConnected(page, alias, api, doc => !doc.pendingRequest && !doc.authoritativeDownloadRequired && doc.outbox.every(entry => entry.disposition !== 'pending') && doc.acceptedState?.revision === doc.acceptedRevision, 'Upload receipt plus authoritative audit download');
}
async function picture(page, name) {
  await page.screenshot({ path: path.join(directory, `${name}.png`), animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: no phone horizontal overflow`);
}
async function offer(page, alias, api, account, device) {
  await input(page, 'Handover target account', account); await input(page, 'Handover target device', device);
  const old = (await connected(page, alias, api)).lastTransferId;
  await button(page, 'Offer control to the named manager/device');
  return (await waitConnected(page, alias, api, doc => Boolean(doc.lastTransferId && doc.lastTransferId !== old && !doc.pendingRequest), 'Addressed controller handover offer')).lastTransferId;
}
async function accept(page, alias, api, transferId, epoch) {
  await input(page, 'Transfer id to accept', transferId); await button(page, 'Accept addressed transfer on this device');
  return waitConnected(page, alias, api, doc => doc.controllerConfirmed && doc.grant.epoch === epoch && !doc.pendingRequest && !doc.authoritativeDownloadRequired, 'Accept addressed controller transfer with current checkpoint');
}
async function scenario(name, work) {
  try { const detail = await work(); checks.push({ name, status: 'passed', detail }); }
  catch (error) { await activePage?.screenshot({ path: path.join(directory, `${name}-failed.png`), animations: 'disabled' }).catch(() => {}); checks.push({ name, status: 'failed', error: error.message }); }
  console.log(`${checks.at(-1).status.toUpperCase()} ${name}${checks.at(-1).error ? `: ${checks.at(-1).error}` : ''}`);
}

try {
  await startAPI(primaryAPI, 'journey'); await startAPI(controlAPI, 'controller');
  await scenario('01-canonical-match-and-lost-response', async () => {
    const alias = 'connected-browser-journey-a';
    const { context, page } = await openWorkspace(primaryAPI);
    let releaseLostResponse = () => {};
    try {
      const legacy = structuredClone((await stored(page)).projections[matchId]);
      await openController(page, primaryAPI, alias); await acquire(page, alias, primaryAPI);
      await recordPresent(page, alias, primaryAPI);
      await button(page, 'Stage first seven present players');
      await waitConnected(page, alias, primaryAPI, doc => doc.localState.stagedLineup?.length === 7, 'Explicit staged lineup');
      const date = new Date('2026-10-24T09:00:00.000Z');
      await page.clock.install({ time: date }); await page.clock.pauseAt(date);
      await confirm(page, 'Review kickoff', alias, primaryAPI, 'first_half_running');
      await page.clock.fastForward(20_000); await button(page, 'Record fictional team goal');
      await waitConnected(page, alias, primaryAPI, doc => doc.localState.goals.length === 1, 'Live goal queued');
      await page.clock.fastForward(5_000);
      await confirm(page, 'Review actual referee clock pause', alias, primaryAPI, 'first_half_paused');
      const candidate = await connected(page, alias, primaryAPI);
      assert.equal(candidate.localState.halfActiveMs, 25_000);
      const observations = []; let loseResponse = true, prefixCommitted = false;
      const heldResponse = new Promise(resolve => { releaseLostResponse = resolve; });
      await page.route(`${primaryAPI}/v1/matches/${matchId}/events`, async route => {
        if (route.request().method() !== 'POST') { await route.continue(); return; }
        observations.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() });
        if (!loseResponse) { await route.continue(); return; }
        loseResponse = false;
        const committed = await route.fetch();
        assert.equal(committed.ok(), true, 'Service committed before its response was lost.');
        prefixCommitted = true;
        await heldResponse;
        await route.abort('failed');
      });
      await button(page, 'Upload pending canonical events');
      await page.getByRole('button', { name: 'Retry same upload request', exact: true }).waitFor();
      await poll(async () => prefixCommitted, Boolean, 'Service committed while its original response remains in flight');
      const uncertain = await connected(page, alias, primaryAPI);
      assert(uncertain.pendingRequest); assert(uncertain.outbox.every(entry => entry.disposition === 'pending'));
      const committed = await download(primaryAPI, alias);
      assert.equal(committed.acceptedRevision, candidate.localState.revision);
      assert.equal(committed.state.goals.length, 1);
      const originalRequest = JSON.stringify(uncertain.pendingRequest);
      // The phone keeps recording actual events while the original upload awaits its receipt.
      await confirm(page, 'Review actual clock resume', alias, primaryAPI, 'first_half_running');
      await page.clock.fastForward(4_000); await button(page, 'Record fictional team goal');
      await waitConnected(page, alias, primaryAPI, value => value.localState.goals.length === 2, 'Offline goal suffix saved behind the original upload');
      await page.clock.fastForward(1_000);
      let doc = await confirm(page, 'Review actual referee clock pause', alias, primaryAPI, 'first_half_paused');
      assert.equal(doc.localState.halfActiveMs, 30_000);
      assert.equal(JSON.stringify(doc.pendingRequest), originalRequest, 'New actual events cannot modify the retained upload.');
      const suffix = JSON.stringify(doc.outbox.slice(candidate.outbox.length).map(entry => entry.envelope));
      releaseLostResponse();
      await poll(async () => page.getByRole('button', { name: 'Retry same upload request', exact: true }).isEnabled(), Boolean, 'Lost response settled without discarding request');
      await button(page, 'Retry same upload request');
      doc = await waitConnected(page, alias, primaryAPI, value => !value.pendingRequest && !value.authoritativeDownloadRequired && value.acceptedState?.revision === committed.acceptedRevision, 'Retry acknowledged and authoritative prefix plus offline suffix replayed');
      assert.equal(observations.length, 2); assert.deepEqual(observations[1], observations[0]);
      assert.equal(JSON.stringify({ idempotencyKey: observations[0].key, body: JSON.parse(observations[0].body) }), JSON.stringify({ idempotencyKey: uncertain.pendingRequest.idempotencyKey, body: uncertain.pendingRequest.body }));
      assert.equal(originalRequest, JSON.stringify(uncertain.pendingRequest));
      assert.deepEqual(doc.acceptedState.audit, (await download(primaryAPI, alias)).state.audit, 'Local accepted audit equals authenticated service projection.');
      assert(doc.acceptedState.audit.every(entry => entry.actorId === 'synthetic-account-manager'));
      assert.equal(doc.localState.goals.length, 2); assert.equal(doc.acceptedState.goals.length, 1);
      assert.equal(doc.outbox.filter(entry => entry.disposition === 'pending').length, 3);
      assert.equal(JSON.stringify(doc.outbox.filter(entry => entry.disposition === 'pending').map(entry => entry.envelope)), suffix);
      assert.equal(doc.reconciliationRequired, false);
      await page.unroute(`${primaryAPI}/v1/matches/${matchId}/events`);
      doc = await upload(page, alias, primaryAPI);
      assert.equal(doc.acceptedState.goals.length, 2);
      await page.clock.fastForward(300_000);
      await confirm(page, 'Review actual clock resume', alias, primaryAPI, 'first_half_running');
      await page.clock.fastForward(1_473_000);
      doc = await confirm(page, 'Review manual half-time', alias, primaryAPI, 'half_time');
      assert.equal(doc.localState.firstHalfDurationMs, 1_503_000, 'First-half overtime is retained.');
      doc = await confirm(page, 'Review second-half start', alias, primaryAPI, 'second_half_running');
      assert.equal(doc.localState.halfActiveMs, 0, 'Second half begins with its independent25 minutes.');
      await page.clock.fastForward(30_000); await button(page, 'Record fictional team goal');
      await waitConnected(page, alias, primaryAPI, value => value.localState.goals.length === 3, 'Second-half goal');
      await page.clock.fastForward(1_470_000);
      doc = await confirm(page, 'Review manual full-time', alias, primaryAPI, 'completed');
      assert.equal(doc.localState.matchActiveMs, 3_003_000);
      doc = await upload(page, alias, primaryAPI);
      const final = await download(primaryAPI, alias);
      assert.equal(final.state.status, 'completed'); assert.deepEqual(final.state.score, { for: 3, against: 0 });
      assert.deepEqual(doc.acceptedState.audit, final.state.audit);
      assert.equal(final.deviceCheckpoint.clientSequence, doc.allocatedSequence);
      assert.equal(final.state.intervals.filter(interval => interval.state === 'playing').reduce((total, interval) => total + interval.endMs - interval.startMs, 0), 7 * 3_003_000);
      assert.deepEqual((await stored(page)).projections[matchId], legacy, 'Legacy M0 history was never uploaded or rewritten.');
      await picture(page, '01-canonical-completed');
      const retainedOutbox = JSON.stringify(doc.outbox);
      // A transport-only403 fixture tests cache closure; it does not claim a real membership was revoked.
      await page.route(`${primaryAPI}/v1/me`, async route => {
        if (route.request().method() === 'OPTIONS') { await route.continue(); return; }
        await route.fulfill({ status: 403, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': new URL(baseURL).origin }, body: JSON.stringify({ code: 'NOT_FOUND', message: 'Authoritative denial fixture: manager scope no longer available.' }) });
      });
      await button(page, 'Download accepted service match');
      await page.getByText(/Controller cache closed because the service or current account denied access/).waitFor();
      assert.equal(await page.getByText('Connected match rehearsal', { exact: true }).count(), 0, 'Known access denial hides the private match view.');
      assert.equal(JSON.stringify((await connected(page, alias, primaryAPI)).outbox), retainedOutbox, 'Access denial retains the canonical audit/outbox.');
      await picture(page, '01-authority-denial-hides-private-cache');
      return { acceptedRevision: final.acceptedRevision, clientSequence: final.deviceCheckpoint.clientSequence, firstHalfMs: 1_503_000, secondHalfMs: 1_500_000, pauseExcludedMs: 300_000, score: final.state.score, identicalRetry: true, offlineSuffixEvents: 3, offlineSuffixReplayedOverAuthoritativePrefix: true, authoritativeActorAudit: true, legacyM0Unchanged: true, trustedUtc: false, cacheClosureAfterHttp403Fixture: true, realMembershipRevocationTested: false };
    } finally { releaseLostResponse(); await context.close(); }
  });

  await scenario('02-handover-sequence-and-stale-quarantine', async () => {
    const aliasA = 'connected-browser-control-a', aliasB = 'connected-browser-control-b';
    const first = await openWorkspace(controlAPI), second = await openWorkspace(controlAPI);
    const a = first.page, b = second.page;
    try {
      await openController(a, controlAPI, aliasA); await acquire(a, aliasA, controlAPI);
      await recordPresent(a, aliasA, controlAPI); const before = await upload(a, aliasA, controlAPI);
      const sequence = before.allocatedSequence;
      const transfer = await offer(a, aliasA, controlAPI, 'synthetic-account-manager-2', aliasB);
      await openController(b, controlAPI, aliasB, 'Manager B'); await accept(b, aliasB, controlAPI, transfer, 2);
      await recordPresent(b, aliasB, controlAPI); await upload(b, aliasB, controlAPI);
      const back = await offer(b, aliasB, controlAPI, 'synthetic-account-manager', aliasA);
      await accept(a, aliasA, controlAPI, back, 3);
      const oldEvents = (await connected(a, aliasA, controlAPI)).outbox.length;
      await recordPresent(a, aliasA, controlAPI);
      let doc = await connected(a, aliasA, controlAPI);
      assert.equal(doc.outbox[oldEvents].envelope.clientSequence, sequence + 1);
      assert.equal(doc.outbox[oldEvents].envelope.previousEventId, before.previousEventId);
      await upload(a, aliasA, controlAPI);
      const accepted = await download(controlAPI, aliasA);
      await input(b, 'Controller recovery reason', 'Fictional lost-phone recovery rehearsal; retain old-device evidence.');
      await button(b, 'Acknowledge possible unsynchronised old records');
      await button(b, 'Recover control; retain old branch for reconciliation');
      await waitConnected(b, aliasB, controlAPI, value => value.grant?.epoch === 4 && value.reconciliationRequired && !value.pendingRequest, 'Explicit recovery requires reconciliation');
      await recordPresent(a, aliasA, controlAPI);
      const oldCandidate = structuredClone((await connected(a, aliasA, controlAPI)).localState);
      doc = await upload(a, aliasA, controlAPI);
      const quarantined = doc.outbox.filter(entry => entry.disposition === 'quarantined');
      assert.equal(quarantined.length, oldCandidate.config.selectedPlayerIds.length);
      assert(quarantined.every(entry => entry.reason === 'STALE_CONTROLLER'));
      assert.equal(doc.controllerConfirmed, false); assert.equal(doc.reconciliationRequired, true);
      assert.deepEqual(doc.localState, oldCandidate, 'Stale candidate remains separate and recoverable.');
      const after = await download(controlAPI, aliasA);
      assert.deepEqual(after.state, accepted.state, 'Stale records cannot alter the accepted service projection.');
      assert.equal(after.deviceCheckpoint.clientSequence, doc.allocatedSequence, 'Quarantined reserved sequence is not reset.');
      await button(a, 'Read service quarantine');
      const quarantine = await json(controlAPI, `/v1/matches/${matchId}/quarantine`);
      assert.equal(quarantine.items.length, quarantined.length);
      await picture(a, '02-stale-controller-retained');
      return { acceptedRevision: after.acceptedRevision, epochs: [1, 2, 3, 4], sequenceBeforeHandback: sequence, nextSequenceOnHandback: sequence + 1, finalReservedSequence: doc.allocatedSequence, quarantined: quarantine.items.length, acceptedProjectionUnchanged: true, managerReviewRequired: true };
    } finally { await first.context.close(); await second.context.close(); }
  });

  await scenario('03-workspace-service-preparation-results-and-privacy', async () => {
    const { context, page } = await openWorkspace(primaryAPI);
    try {
      await page.getByTestId('workspace-tab-schedule').click(); await page.getByTestId('preparation-create-event').click();
      await input(page, 'Opposition', 'Connected Birch rehearsal'); await input(page, 'Match date (YYYY-MM-DD)', '2026-11-07');
      await input(page, 'Kick-off (HH:MM, blank if not recorded)', '11:00'); await input(page, 'Venue', 'Fictional connected south field');
      await page.getByTestId('preparation-save').click();
      let prep = await poll(() => json(primaryAPI, scoped('preparation')), value => value.fixtures?.some(item => item.opponent === 'Connected Birch rehearsal'), 'Fixture persisted in service');
      const fixture = prep.fixtures.find(item => item.opponent === 'Connected Birch rehearsal');
      await button(page, 'Open fixture Connected Birch rehearsal, 2026-11-07'); await button(page, 'Edit or reschedule fixture');
      await input(page, 'Match date (YYYY-MM-DD)', '2026-11-14'); await page.getByTestId('preparation-save').click();
      prep = await poll(() => json(primaryAPI, scoped('preparation')), value => value.fixtures?.find(item => item.id === fixture.id)?.playedDate === '2026-11-14', 'Service fixture rescheduled with same identity');
      assert.equal(prep.fixtures.filter(item => item.id === fixture.id).length, 1);
      assert.equal(prep.fixtures.find(item => item.id === fixture.id).history[0].playedDate, '2026-11-07');
      await page.getByTestId('workspace-tab-reports').click(); await button(page, 'Add historical result to service');
      await input(page, 'Service result Played date (YYYY-MM-DD)', '2026-09-20'); await input(page, 'Service result Opponent', 'Connected Willow historical');
      await input(page, 'Service result Goals for', '2'); await input(page, 'Service result Goals against', '1'); await button(page, 'friendly');
      await button(page, 'Save historical result to service');
      const records = await poll(() => json(primaryAPI, scoped('records')), value => value.results?.rows?.some(item => item.opponent === 'Connected Willow historical'), 'Historical result persisted via actual service');
      const historical = records.editableState.results.find(item => item.opponent === 'Connected Willow historical');
      assert.equal(historical.participation, null); assert.equal(historical.actualActiveDurationMs, null);
      await page.getByTestId('workspace-tab-community').click();
      await button(page, 'Acknowledge sharing a limited season invitation'); await button(page, 'Create service invitation code');
      const community = await poll(() => json(primaryAPI, scoped('community')), value => value.invitations?.some(item => !item.revokedAtMs), 'Service invitation created');
      const invitation = community.invitations.find(item => !item.revokedAtMs);
      await picture(page, '03-workspace-manager');
      const own = await openWorkspace(primaryAPI, 'Fictional Player 01');
      try {
        await own.page.getByTestId('workspace-own-preparation').waitFor();
        const ownView = await own.page.getByTestId('workspace-own-preparation').innerText();
        assert.match(ownView, /Player 01/); assert.doesNotMatch(ownView, /Player 02|Player 13/);
        await own.page.getByRole('button', { name: 'Unsure', exact: true }).first().click();
        const ownData = await poll(() => json(primaryAPI, scoped('preparation/own'), 'synthetic-account-player-01'), value => value.fixtures?.[0]?.response === 'unsure', 'Player own-only RSVP persisted');
        assert.equal(ownData.profile.playerId, 'synthetic-player-01');
        assert.equal(ownData.fixtures[0].attendance, 'not_recorded', 'RSVP cannot fabricate attendance.');
        assert.equal(ownData.profiles, undefined); await picture(own.page, '03-workspace-own-player');
      } finally { await own.context.close(); }
      const invitee = await openWorkspace(primaryAPI, 'Fictional invite recipient');
      try {
        await invitee.page.getByTestId('workspace-tab-community').click(); await input(invitee.page, 'Service invitation code', invitation.reviewCode);
        await button(invitee.page, 'Accept service invitation');
        const member = await poll(() => json(primaryAPI, '/v1/me', 'synthetic-account-invitee'), value => value.memberships?.some(item => item.teamId === teamId && item.seasonId === seasonId && item.role === 'spectator'), 'Invitation grants only addressed season spectator access');
        assert(member.memberships.every(item => item.role === 'spectator'));
        const publicMatch = await json(primaryAPI, `/v1/matches/${matchId}`, 'synthetic-account-invitee');
        assert.equal(publicMatch.score, null); assert.equal(publicMatch.state, undefined); assert.equal(publicMatch.intervals, undefined);
        const spectatorReports = await json(primaryAPI, scoped('records'), 'synthetic-account-invitee');
        assert.equal(spectatorReports.results.totals, null, 'Q21 remains withheld; invitation cannot approve score sharing.');
        await picture(invitee.page, '03-workspace-invited-spectator');
      } finally { await invitee.context.close(); }
      return { fixtureId: fixture.id, sameIdentityAfterReschedule: true, historicalSummaryUnknownMinutes: true, ownPlayerDataOnly: true, rsvpDistinctFromAttendance: true, invitationAcceptedOverHttp: true, q21SharingWithheld: true };
    } finally { await context.close(); }
  });

  await scenario('04-private-media-fails-closed-without-scanner', async () => {
    const { context, page } = await openWorkspace(primaryAPI);
    try {
      await page.getByTestId('workspace-tab-community').click();
      await page.getByTestId('media-generated-image').click(); await page.getByLabel('Connected image policy acknowledgement', { exact: true }).check();
      await page.getByTestId('media-upload-image').click();
      const uploads = await poll(() => json(primaryAPI, scoped('media/uploads')), value => value.items?.some(item => item.failureCode === 'SCANNER_REQUIRED'), 'Unscanned upload is retained privately and rejected for publication');
      const item = uploads.items.find(value => value.failureCode === 'SCANNER_REQUIRED');
      await page.getByTestId('media-refresh-uploads').click(); await page.getByText(/SCANNER_REQUIRED/).waitFor();
      const community = await json(primaryAPI, scoped('community'));
      assert(!community.photos?.some(photo => photo.id === item.photoId && photo.status === 'published'));
      await picture(page, '04-private-unscanned-media');
      return { uploadStatus: item.status, failureCode: item.failureCode, published: false, actualAntivirusDatabaseValidated: false };
    } finally { await context.close(); }
  });

  await scenario('05-workspace-durable-outbox-reload-and-exact-retry', async () => {
    const { context, page } = await openWorkspace(primaryAPI);
    try {
      const observations = []; let loseResponse = true;
      const matchesPreparation = url => url.origin === new URL(primaryAPI).origin && url.pathname === `/v1/teams/${teamId}/preparation`;
      await page.route(matchesPreparation, async route => {
        if (route.request().method() !== 'POST') { await route.continue(); return; }
        observations.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() });
        if (!loseResponse) { await route.continue(); return; }
        loseResponse = false;
        const committed = await route.fetch();
        assert.equal(committed.ok(), true, 'Workspace mutation reached the API before acknowledgement was lost.');
        await route.abort('failed');
      });
      await page.getByTestId('workspace-tab-schedule').click(); await page.getByTestId('preparation-create-event').click();
      await input(page, 'Opposition', 'Outbox Alder rehearsal'); await input(page, 'Match date (YYYY-MM-DD)', '2026-11-21');
      await input(page, 'Kick-off (HH:MM, blank if not recorded)', '10:15'); await input(page, 'Venue', 'Fictional durable-outbox field');
      await page.getByTestId('preparation-save').click();
      await page.getByRole('button', { name: 'Retry exact service request', exact: true }).waitFor();
      await poll(async () => page.getByRole('button', { name: 'Retry exact service request', exact: true }).isEnabled(), Boolean, 'Lost workspace acknowledgement settles before reload');
      const pending = await poll(() => workspaceOutbox(page, primaryAPI), value => value?.pending?.status === 'uncertain', 'Original workspace command durably retained');
      assert.equal(observations.length, 1); assert.equal(pending.pending.key, observations[0].key); assert.equal(pending.pending.bodyJson, observations[0].body);
      const retained = structuredClone(pending.pending);
      const committed = await json(primaryAPI, scoped('preparation'));
      assert.equal(committed.fixtures.filter(item => item.opponent === 'Outbox Alder rehearsal').length, 1);
      const fixtureId = committed.fixtures.find(item => item.opponent === 'Outbox Alder rehearsal').id;
      await page.reload({ waitUntil: 'networkidle' });
      await enterWorkspace(page, primaryAPI, 'Fictional Player 01');
      await page.getByTestId('workspace-own-preparation').waitFor();
      assert.equal(await page.getByRole('button', { name: 'Retry exact service request', exact: true }).count(), 0, 'Another account cannot replay the manager retained request.');
      assert.equal((await workspaceOutbox(page, primaryAPI)).pending.bodyJson, retained.bodyJson, 'Account change retains the manager branch without exposing its replay control.');
      await button(page, 'Fictional manager'); await page.getByTestId('workspace-connect').click();
      await page.getByTestId('workspace-tab-controller').waitFor();
      await page.getByRole('button', { name: 'Retry exact service request', exact: true }).waitFor();
      const reopened = await poll(() => workspaceOutbox(page, primaryAPI), value => value?.pending?.key === retained.key, 'Reopen exact account/API/team/season outbox');
      assert.equal(reopened.pending.bodyJson, retained.bodyJson); assert.equal(reopened.pending.path, retained.path);
      await button(page, 'Retry exact service request');
      const settled = await poll(() => workspaceOutbox(page, primaryAPI), value => !value?.pending && value?.lastSettled?.request.key === retained.key && value.lastSettled.outcome.kind === 'accepted', 'Service receipt durably settled after exact replay');
      assert.equal(observations.length, 2); assert.deepEqual(observations[1], observations[0]);
      assert.equal(settled.lastSettled.request.bodyJson, retained.bodyJson);
      const final = await json(primaryAPI, scoped('preparation'));
      assert.equal(final.revision, committed.revision, 'Cached HTTP receipt does not apply the fixture command twice.');
      assert.equal(final.fixtures.filter(item => item.id === fixtureId).length, 1);
      assert.equal(final.fixtures.find(item => item.id === fixtureId).history.length, 1);
      await page.reload({ waitUntil: 'networkidle' }); await enterWorkspace(page, primaryAPI, 'Fictional manager');
      await poll(() => workspaceOutbox(page, primaryAPI), value => !value?.pending && value?.lastSettled?.request.key === retained.key, 'Acknowledgement survives a second reload');
      assert.equal(await page.getByRole('button', { name: 'Retry exact service request', exact: true }).count(), 0);
      await picture(page, '05-workspace-durable-receipt');
      return { fixtureId, retainedAcrossReload: true, otherAccountCannotReplay: true, identicalWireKeyAndBody: true, finalServiceRevision: final.revision, noDuplicateFixtureOrHistory: true, acknowledgementDurableAfterSecondReload: true };
    } finally { await context.close(); }
  });
  assert.equal(errors.length, 0, `Browser runtime errors: ${errors.join('; ')}`);
} catch (error) { checks.push({ name: 'harness', status: 'failed', error: error.message }); }
finally {
  await writeFile(path.join(directory, 'results.json'), `${JSON.stringify({ baseURL, primaryAPI, controlAPI, runId, checks, errors, limitations: ['Fictional development authentication; no real identity provider rehearsal.', 'Browser-controlled monotonic time validates rules and HTTP boundaries, not native clock continuity.', 'Phone reboot, SQLCipher, background alerts, lock-screen and physical-device continuity still require native device evidence.', 'Unconfigured antivirus blocks media processing; no publication or malware-scanner claim.'] }, null, 2)}\n`);
  await browser.close();
  for (const { child, stream } of servers) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(5000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    stream.end();
  }
}
if (checks.some(check => check.status === 'failed') || errors.length) process.exitCode = 1;
