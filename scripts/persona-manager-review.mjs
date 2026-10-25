import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { PDFDocument } from 'pdf-lib';
import { formationFromPattern } from '../packages/application/src/formation-pattern.ts';
import { createPersonaReview } from './persona-review-session.mjs';

const phase = process.env.LONGBALL_PERSONA_PHASE ?? 'baseline';
const r = await createPersonaReview({ persona: 'manager', name: 'manager', phase });
const harnessDigest = async () => createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
r.report.personaHarnessSha256 = await harnessDigest();
let state, fatal;
const findings = r.report.findings;
const finding = (id, message, details = {}) => findings.push({ id, message, ...details });
const section = async (name, work) => {
  console.log(JSON.stringify({ section: name, status: 'started' }));
  try { await r.budget(state); await work(); r.report.checks.push(name); console.log(JSON.stringify({ section: name, status: 'passed' })); }
  catch (error) { finding('journey-error', name, { error: r.safe(error.message) }); console.log(JSON.stringify({ section: name, status: 'failed', error: r.safe(error.message, 500) })); }
};
const attemptHome = async () => { const target = state.page.getByTestId('workspace-tab-home'); if (await target.isEnabled()) await target.click(); };
const openSchedule = async (filter = 'matches') => {
  await r.openTab(state, 'schedule');
  const back = state.page.getByRole('button', { name: 'Back to schedule', exact: true }); if (await back.isVisible()) await back.click();
  const label = `Event type: ${filter === 'matches' ? 'Matches' : 'Training'}`;
  await state.page.getByRole('radio', { name: label, exact: true }).click();
  await state.page.waitForFunction(label => document.querySelector(`[aria-label="${label}"]`)?.getAttribute('aria-checked') === 'true', label);
};
const saved = async (action, leaf = 'preparation') => {
  const response = state.page.waitForResponse(value => new URL(value.url()).pathname.endsWith('/' + leaf) && value.request().method() === 'POST');
  const [value] = await Promise.all([response, action()]); assert.equal(value.status(), 200); return value.json();
};
const refresh = async () => {
  await r.openTab(state, 'stats');
  const read = state.page.waitForResponse(value => new URL(value.url()).pathname.endsWith('/preparation') && value.request().method() === 'GET');
  await state.page.getByRole('button', { name: 'Refresh stats', exact: true }).click(); await read;
  await state.page.getByRole('button', { name: 'Refresh stats', exact: true }).waitFor({ state: 'visible' });
};
const prep = () => r.api(r.scope('preparation'), { state });
const mutatePrep = async payload => {
  const current = await prep();
  return r.api(r.scope('preparation'), { state, body: { command: { id: randomUUID(), expectedRevision: current.revision, ...payload } } });
};
const coreLineup = match => {
  const { slots, players, selectedPlayerIds, profileSnapshot, fixedKeeperId } = match.config, chosen = [];
  const choose = (index, used = new Set()) => {
    if (index === slots.length) return true;
    for (const player of players.filter(item => selectedPlayerIds.includes(item.id) && match.availability[item.id] !== false)) {
      const profile = profileSnapshot.find(item => item.playerId === player.id), slot = slots[index];
      if (used.has(player.id) || profile?.preferences[0] !== slot.position || !profile.eligiblePositions.includes(slot.position) || slot.position === 'GK' && fixedKeeperId && player.id !== fixedKeeperId) continue;
      chosen[index] = player; if (choose(index + 1, new Set([...used, player.id]))) return true;
    }
    return false;
  };
  assert(choose(0), 'The actual saved snapshot supports seven distinct primary-position starters.'); return chosen;
};
try {
  state = await r.login(); const { page } = state;
  await page.getByTestId('workspace-manager-home').waitFor();
  assert((await r.api('/v1/me', { state })).memberships.some(value => value.role === 'manager' && value.teamId === r.teamId && value.seasonId === r.seasonId));
  await r.screenshot('manager-home-phone', state);
  if (phase !== 'baseline') await section('Sixteen consecutive squad replies fit the unchanged authenticated request limit', async () => {
    const current = await prep();
    const fixture = current.fixtures.find(value => value.status === 'scheduled' && value.playedDate >= new Date().toISOString().slice(0, 10) && value.selectedProfileIds.length === 8); assert(fixture, 'Use the actual eight-player future demo fixture.');
    const profiles = fixture.selectedProfileIds.map(id => current.profiles.find(value => value.id === id)); assert(profiles.every(Boolean));
    await openSchedule('matches'); await page.getByRole('button', { name: `Open fixture ${fixture.opponent}, ${r.reviewDateLabel(fixture.playedDate)}`, exact: true }).click();
    const initialBrowserRequests = await page.evaluate(origin => performance.getEntriesByType('resource').filter(entry => entry.name.startsWith(origin + '/v1/') && !entry.name.includes('/v1/demo/sessions')).length, r.virtualApi);
    const requests = [], revisions = [], projections = { preparation: 0, records: 0, 'player-stats': 0 };
    const capture = request => { if (new URL(request.url()).origin === r.virtualApi && request.headers().authorization) requests.push({ method: request.method(), path: new URL(request.url()).pathname }); };
    const captureProjection = response => { const leaf = new URL(response.url()).pathname.split('/').at(-1); if (response.request().method() === 'GET' && leaf in projections && response.ok()) projections[leaf]++; };
    page.on('request', capture); page.on('response', captureProjection);
    try {
      let previousRevision = current.revision;
      for (let pass = 0; pass < 2; pass++) for (const profile of profiles) {
        const label = pass === 0 ? fixture.responses[profile.id] === 'unsure' ? 'Unavailable' : 'Unsure' : 'Available';
        const name = `${profile.displayName} availability reply: ${label}`;
        const keyboardSave = pass === 0 && profile.id === profiles[0].id;
        const option = page.getByRole('radio', { name, exact: true });
        if (keyboardSave) await option.focus();
        const receipt = await saved(() => keyboardSave ? page.keyboard.press('Space') : option.click());
        assert.equal(receipt.revision, previousRevision + 1); previousRevision = receipt.revision; revisions.push(receipt.revision);
        await page.waitForFunction(name => { const node = document.querySelector(`[aria-label="${name}"]`); return node?.getAttribute('aria-disabled') !== 'true' && node?.getAttribute('aria-checked') === 'true'; }, name);
        if (keyboardSave) assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), name);
      }
    } finally { page.off('request', capture); page.off('response', captureProjection); }
    r.report.rapidReplies = { replies: revisions.length, requests: requests.length, initialBrowserRequests, extraDirectReads: 2, revisions, projections, firstReplyByKeyboardSpace: true, keyboardFocusRetainedThroughRefresh: true, budgetWaitWithinBurst: false, ordinaryRateLimit: 120, mutationsRateLimit: 60 };
    assert.equal(revisions.length, 16); assert.equal(requests.length, 96); assert.deepEqual(projections, { preparation: 16, records: 16, 'player-stats': 16 });
    assert(initialBrowserRequests + 2 + requests.length <= 120);
  });
  if (phase !== 'baseline') await section('Compact squad cards preserve phone targets and use two tablet columns', async () => {
    r.report.squadSpacing = [];
    try { for (const width of [390, 1024]) {
      await page.setViewportSize({ width, height: 844 });
      const grid = page.getByTestId('fixture-squad-grid'); await grid.locator(':scope > *').first().scrollIntoViewIfNeeded();
      if (width === 1024) await page.waitForFunction(() => { const cards = document.querySelector('[data-testid="fixture-squad-grid"]')?.children; if (!cards || cards.length < 2) return false; const first = cards[0].getBoundingClientRect(), second = cards[1].getBoundingClientRect(); return first.x !== second.x && Math.abs(first.y - second.y) < 2; });
      const geometry = await grid.evaluate(node => ({ viewport: window.innerWidth, cards: [...node.children].slice(0,2).map(card => { const rect = card.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, touchHeights: [...card.querySelectorAll('[role="radio"]')].map(option => option.getBoundingClientRect().height) }; }), overflow: document.documentElement.scrollWidth > window.innerWidth + 1 }));
      assert(!geometry.overflow); assert(geometry.cards.every(card => card.touchHeights.every(height => height >= 44)));
      if (width === 390) assert(geometry.cards[0].height < 314, 'Compact phone row improves the measured314px baseline.');
      else { assert(Math.abs(geometry.cards[0].y - geometry.cards[1].y) < 2); assert(geometry.cards[0].x !== geometry.cards[1].x); }
      r.report.squadSpacing.push(geometry); await r.screenshot(`manager-squad-${width}`, state);
    } } finally { await page.setViewportSize({ width: 390, height: 844 }); }
  });
  await section('Home action opens the specific next event', async () => {
    await r.openTab(state, 'home');
    const button = page.getByTestId('manager-home-prepare');
    assert(await button.isVisible(), 'The demo has an actionable next event.');
    const label = await button.innerText();
    if (phase !== 'baseline' && label === 'Review training') assert(!/check-ins? not recorded/.test(await button.locator('..').innerText()), 'Future training does not ask for attendance before it is held.');
    await button.click();
    const opened = label === 'Prepare match'
      ? await page.getByText(/^Match squad ·/).count() > 0
      : await page.getByRole('radio', { name: 'Occurrence status: Scheduled', exact: true }).count() > 0;
    if (!opened) finding('home-next-event-target', `${label} opens the generic schedule rather than its specific event.`);
  });

  await section('Manager navigates every authorised ordinary workspace section', async () => {
    r.report.visitedSections = [];
    for (const tab of ['home', 'overview', 'schedule', 'team', 'formation', 'stats', 'centre', 'reports', 'feedback', 'opposition', 'community', 'settings', 'seasons', 'privileges', 'invitations']) {
      await r.openTab(state, tab);
      await page.getByTestId('workspace-context-ready').waitFor();
      assert(await page.getByTestId('demo-signed-in').isVisible());
      const rendered = await page.locator('body').evaluate(body => ({
        headings: [...body.querySelectorAll('[role="heading"],h1,h2,h3')].map(node => node.textContent?.trim()).filter(Boolean).slice(-8),
        actions: [...body.querySelectorAll('button,[role="button"]')].filter(node => node.getClientRects().length && getComputedStyle(node).display !== 'none').map(node => node.getAttribute('aria-label') || node.textContent?.trim()).filter(Boolean).slice(-45),
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      }));
      if (rendered.overflow) finding('phone-overflow', `${tab} overflows the390px phone viewport.`);
      r.report.visitedSections.push({ tab, ...JSON.parse(r.safe(JSON.stringify(rendered), 10000)) });
    }
    await r.openTab(state, 'team'); await page.getByTestId('workspace-team-sheet').click(); await page.getByTestId('team-documents').waitFor();
    r.report.visitedSections.push({ tab: 'documents', reached: true });
  });

  if (phase !== 'baseline') await section('Manager creates and explicitly closes a team-scoped spectator QR invitation', async () => {
    await r.openTab(state, 'invitations'); await page.getByTestId('invitation-hours').fill('2');
    const issued = page.waitForResponse(response => new URL(response.url()).pathname === `/v1/teams/${r.teamId}/spectator-invites` && response.request().method() === 'POST');
    await page.getByTestId('invitation-create').click(); const response = await issued; assert.equal(response.status(), 201);
    const receipt = await response.json(); r.addSecret(receipt.shareUrl); const destination = new URLSearchParams(new URL(receipt.shareUrl).hash.slice(1));
    assert.equal(destination.get('teamId'), r.teamId); assert.equal(destination.get('seasonId'), r.seasonId); assert(destination.get('code')); r.addSecret(destination.get('code'));
    await page.getByTestId('invitation-show-qr').click(); await page.getByTestId('invitation-qr-code').waitFor(); assert.equal(await page.getByTestId('invitation-qr-code').locator('svg path').count(), 1);
    await attemptHome(); assert(await page.getByLabel('One-time spectator invitation link', { exact: true }).isVisible());
    await page.getByTestId('invitation-close-link').click(); await page.getByLabel('One-time spectator invitation link', { exact: true }).waitFor({ state: 'hidden' });
    r.report.invitation = { exactTeamAndSeasonBound: true, locallyRenderedQr: true, privateDisclosureExplicitlyClosed: true, emailSent: false, capabilityRetainedInReport: false };
  });

  await section('Saved custom formation opens and name-only saves losslessly', async () => {
    const original = formationFromPattern({ pattern: '2-3-1', format: 7, id: 'persona-manager-custom', name: 'Manager custom layout' });
    original.slots = original.slots.map((slot, index) => ({ ...slot, id: `manager-place-${index}`, ...(index === 1 ? { position: 'CM', label: 'Left cover', x: 0.17 } : {}) }));
    await mutatePrep({ type: 'formation.saved', formation: original }); await refresh();
    await r.openTab(state, 'formation');
    const show = page.getByRole('button', { name: /^Choose a saved formation \(/ }); if (await show.isVisible()) await show.click();
    await page.getByRole('button', { name: 'Manager custom layout · 7-a-side', exact: true }).click();
    await page.getByLabel('Formation template name', { exact: true }).fill('Manager renamed layout');
    await saved(() => page.getByTestId('formation-pattern-save').click());
    const stored = (await prep()).formations.find(value => value.id === original.id); assert(stored);
    const sameSlots = isDeepStrictEqual(stored.slots, original.slots);
    r.report.customFormation = { sameSlots, original: original.slots, stored: stored.slots };
    if (!sameSlots) finding('saved-formation-rewritten', 'Opening and renaming a saved formation silently rewrites its custom slot identities, codes, labels or geometry.');
    if (phase !== 'baseline') assert(sameSlots, 'A saved layout must survive opening and a name-only save.');
    await r.screenshot('manager-formation-phone', state);
  });

  await section('Unsaved formation edits survive or block navigation', async () => {
    await r.openTab(state, 'formation');
    await page.getByLabel('Formation template name', { exact: true }).fill('Manager unsaved draft');
    const guardWarning = page.getByText('Save or discard your unsaved changes before leaving this view. If a request is awaiting confirmation, retry or explicitly close that request first. Sign-out remains available.', { exact: true });
    if (phase !== 'baseline') { await page.getByTestId('workspace-team-overview').click(); await guardWarning.waitFor(); }
    await attemptHome();
    const stayed = await page.getByTestId('formation-designer').isVisible();
    if (!stayed) {
      await r.openTab(state, 'formation');
      const retained = await page.getByLabel('Formation template name', { exact: true }).inputValue();
      if (retained !== 'Manager unsaved draft') finding('formation-draft-lost', 'Ordinary navigation silently discards unsaved formation edits.');
    } else r.report.formationNavigationGuarded = true;
    if (phase !== 'baseline') {
      assert(stayed, 'Dirty formation navigation should require explicit save/discard.');
      await page.getByRole('button', { name: 'New formation', exact: true }).click(); await page.getByTestId('formation-draft-switch-review').waitFor();
      await page.getByRole('button', { name: 'Keep editing formation', exact: true }).click();
      assert.equal(await page.getByLabel('Formation template name', { exact: true }).inputValue(), 'Manager unsaved draft');
      await page.getByTestId('formation-draft-discard').click();
      assert.notEqual(await page.getByLabel('Formation template name', { exact: true }).inputValue(), 'Manager unsaved draft');
      await r.openTab(state, 'home'); await page.getByTestId('workspace-manager-home').waitFor(); assert(!await guardWarning.isVisible(), 'Resolved draft navigation warnings must clear on the newly allowed view.');
    }
  });

  if (phase !== 'baseline') await section('Manager drafts have explicit discard and preserve decimal geometry input', async () => {
    await r.openTab(state, 'settings');
    const league = page.getByTestId('team-league'), oldLeague = await league.inputValue();
    await league.fill('Manager pending league'); await attemptHome();
    assert(await league.isVisible()); assert.equal(await league.inputValue(), 'Manager pending league');
    await page.getByTestId('team-league-discard').click(); assert.equal(await league.inputValue(), oldLeague);
    const lead = page.getByLabel('Substitution audio seconds before', { exact: true }), oldLead = await lead.inputValue();
    await lead.fill(oldLead === '45' ? '46' : '45'); await attemptHome(); assert(await lead.isVisible());
    await page.getByTestId('substitution-alerts-discard').click(); assert.equal(await lead.inputValue(), oldLead);
    await page.getByRole('button', { name: 'Edit Manager renamed layout', exact: true }).click();
    await page.getByRole('button', { name: 'Advanced position coordinates', exact: true }).click();
    const coordinate = page.getByLabel('X for manager-place-1', { exact: true });
    await coordinate.fill('0.'); assert.equal(await coordinate.inputValue(), '0.');
    await coordinate.fill(''); assert(await page.getByRole('button', { name: 'Save formation version', exact: true }).isDisabled());
    await coordinate.fill('0.23'); await attemptHome(); assert(await coordinate.isVisible());
    await saved(() => page.getByRole('button', { name: 'Save formation version', exact: true }).click());
    await page.getByRole('button', { name: 'Edit Manager renamed layout', exact: true }).waitFor();
    assert.equal((await prep()).formations.find(value => value.id === 'persona-manager-custom').slots.find(slot => slot.id === 'manager-place-1').x, 0.23);
    await openSchedule('matches'); await page.getByTestId('preparation-create-event').click();
    await page.getByLabel('Opposition', { exact: true }).fill('Unsaved fixture'); await attemptHome();
    assert.equal(await page.getByLabel('Opposition', { exact: true }).inputValue(), 'Unsaved fixture');
    await page.getByRole('button', { name: 'Close without saving', exact: true }).click();
  });

  if (phase !== 'baseline') await section('Manager saves a reusable player setup and reviews genuine XLS/PDF files', async () => {
    await r.openTab(state, 'team'); await page.getByTestId('saved-lineup-create').click();
    await page.getByLabel('Saved setup name', { exact: true }).fill('Weekend starting setup');
    await attemptHome(); assert(await page.getByLabel('Saved setup name', { exact: true }).isVisible());
    await page.getByTestId('saved-lineup-next').click(); await page.getByTestId('saved-lineup-next').click();
    await page.getByTestId('saved-lineup-auto-fill').click(); await page.getByTestId('saved-lineup-next').click();
    await saved(() => page.getByTestId('saved-lineup-confirm').click()); await page.getByTestId('saved-lineup-create').waitFor();
    const current = await prep(), setup = current.lineupTemplates.find(value => value.name === 'Weekend starting setup');
    assert(setup); assert.equal(setup.allocations.length, setup.formation.format); assert.equal(new Set(setup.allocations.map(row => row.playerId)).size, setup.allocations.length);
    await page.getByTestId('squad-tools-toggle').click();
    const downloaded = page.waitForEvent('download'); await page.getByTestId('roster-xls-download').click(); const download = await downloaded;
    const bytes = await readFile(await download.path()); assert(bytes.subarray(0, 8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])));
    const choosing = page.waitForEvent('filechooser'); await page.getByTestId('roster-xls-import').click();
    await (await choosing).setFiles({ name: 'Roma-review.xls', mimeType: 'application/vnd.ms-excel', buffer: bytes }); await page.getByTestId('roster-import-review').waitFor();
    await attemptHome(); assert(await page.getByTestId('roster-import-review').isVisible());
    assert(await page.getByTestId('squad-tools-toggle').isDisabled());
    await page.getByRole('button', { name: 'Discard roster import and close', exact: true }).click();
    await page.getByTestId('workspace-team-sheet').click(); await page.getByTestId('team-documents').waitFor();
    const document = await PDFDocument.create(); document.addPage().drawText('Roma U10 match-day team sheet'); const pdf = Buffer.from(await document.save());
    const choosingPdf = page.waitForEvent('filechooser'); await page.getByTestId('team-sheet-upload').click();
    await (await choosingPdf).setFiles({ name: 'Roma-team-sheet.pdf', mimeType: 'application/pdf', buffer: pdf }); await page.getByTestId('team-sheet-open').waitFor();
    const downloadedPdf = page.waitForEvent('download'); await page.getByTestId('team-sheet-open').click();
    const receivedPdf = await readFile(await (await downloadedPdf).path()); assert(receivedPdf.equals(pdf));
    r.report.files = { xlsBytes: bytes.length, actualBiffOle: true, importedPreviewRetainedUntilExplicitDiscard: true, protectedPdfRoundTripExact: true };
  });

  if (phase !== 'baseline') await section('Weekly training separates replies from held attendance and retains other occurrences', async () => {
    await openSchedule('training');
    const back = page.getByRole('button', { name: 'Back to schedule', exact: true });
    await page.getByTestId('training-series-create').click();
    await page.getByLabel('First training date (YYYY-MM-DD)', { exact: true }).fill('2026-11-04');
    await page.getByLabel('Number of weekly occurrences', { exact: true }).fill('3'); await page.getByLabel('Series training venue', { exact: true }).fill('Manager review training pitch');
    await attemptHome(); assert(await page.getByLabel('Number of weekly occurrences', { exact: true }).isVisible());
    await page.getByTestId('training-series-review').click(); await saved(() => page.getByTestId('training-series-confirm').click());
    await page.getByTestId('training-series-create').waitFor();
    const created = (await prep()).training.filter(item => item.venue === 'Manager review training pitch').sort((a,b) => a.date.localeCompare(b.date)); assert.equal(created.length, 3);
    await page.getByRole('button', { name: `Open training ${r.reviewDateLabel(created[0].date)}`, exact: true }).click();
    const profile = (await prep()).profiles.find(item => item.id === created[0].expectedProfileIds[0]); assert(profile);
    await saved(() => page.getByRole('radio', { name: `${profile.displayName} training reply: Available`, exact: true }).click());
    await page.getByRole('radio', { name: `${profile.displayName} training reply: Available`, exact: true }).waitFor();
    let latest = (await prep()).training.find(item => item.id === created[0].id); assert.equal(latest.attendance[profile.id] ?? 'not_recorded', 'not_recorded');
    await page.waitForFunction(() => document.querySelector('[aria-label="Occurrence status: Held"]')?.getAttribute('aria-disabled') !== 'true');
    await saved(() => page.getByRole('radio', { name: 'Occurrence status: Held', exact: true }).click());
    await page.waitForFunction(name => document.querySelector(`[aria-label="${name}"]`)?.getAttribute('aria-disabled') !== 'true', `${profile.displayName} training attendance: Present`);
    await saved(() => page.getByRole('radio', { name: `${profile.displayName} training attendance: Present`, exact: true }).click());
    await page.waitForFunction(() => document.querySelector('[aria-label="Occurrence status: Held"]')?.getAttribute('aria-disabled') !== 'true');
    latest = (await prep()).training.find(item => item.id === created[0].id); assert.equal(latest.attendance[profile.id], 'present'); assert.equal(latest.responses[profile.id], 'available');
    await back.click(); await page.getByRole('button', { name: `Open training ${r.reviewDateLabel(created[1].date)}`, exact: true }).click();
    await saved(() => page.getByRole('radio', { name: 'Occurrence status: Cancelled', exact: true }).click());
    await page.waitForFunction(() => document.querySelector('[aria-label="Occurrence status: Cancelled"]')?.getAttribute('aria-disabled') !== 'true');
    const persisted = (await prep()).training; assert.equal(persisted.find(item => item.id === created[0].id).status, 'held'); assert.equal(persisted.find(item => item.id === created[1].id).status, 'cancelled'); assert.equal(persisted.find(item => item.id === created[2].id).status, 'scheduled');
  });

  await section('Fixture creation, reply saves and lifecycle actions', async () => {
    await openSchedule('matches'); await page.getByTestId('preparation-create-event').click();
    await page.getByLabel('Opposition', { exact: true }).fill('Manager audit visitors');
    await page.getByLabel('Match date (YYYY-MM-DD)', { exact: true }).fill('2026-11-14');
    await page.getByLabel('Venue', { exact: true }).fill('Roma training ground');
    await saved(() => page.getByRole('button', { name: 'Save fixture', exact: true }).click());
    let current = await prep(); const fixture = current.fixtures.find(value => value.opponent === 'Manager audit visitors'); assert(fixture);
    const profile = current.profiles.find(value => value.active && value.seasonId === r.seasonId); assert(profile);
    await mutatePrep({ type: 'fixture.selection_saved', fixtureId: fixture.id, selectedProfileIds: [profile.id] }); await refresh();
    await openSchedule('matches'); await page.getByRole('button', { name: `Open fixture ${fixture.opponent}, ${r.reviewDateLabel(fixture.playedDate)}`, exact: true }).click();
    const requests = [];
    const capture = request => { if (new URL(request.url()).origin === r.virtualApi && request.headers().authorization) requests.push({ method: request.method(), path: new URL(request.url()).pathname }); };
    page.on('request', capture);
    await saved(() => page.getByRole('radio', { name: `${profile.displayName} availability reply: Available`, exact: true }).click());
    await page.getByRole('radio', { name: `${profile.displayName} availability reply: Available`, exact: true }).waitFor();
    await page.waitForFunction(name => document.querySelector(`[aria-label="${name}"]`)?.getAttribute('aria-disabled') !== 'true', `${profile.displayName} availability reply: Available`);
    page.off('request', capture); r.report.replySaveRequests = requests;
    if (requests.length > 6) finding('reply-refresh-amplification', `One normal reply save sends${requests.length}authenticated requests.`, { requests });
    if (phase !== 'baseline') assert(requests.length <= 6, 'A frequent reply edit should use a bounded narrow refresh.');
    await r.budget(state);
    await saved(() => page.getByRole('button', { name: 'Postpone fixture', exact: true }).click());
    await saved(() => page.getByRole('button', { name: 'Restore as scheduled', exact: true }).click());
    await page.getByTestId(`scheduled-game-cancel-${fixture.id}`).click(); await page.getByTestId('scheduled-game-review').waitFor();
    await page.getByTestId('scheduled-game-reason').fill('Manager review cancellation');
    if (phase !== 'baseline') { await attemptHome(); assert(await page.getByTestId('scheduled-game-review').isVisible()); assert(await page.getByRole('button', { name: 'Back to schedule', exact: true }).isDisabled()); }
    await saved(() => page.getByTestId('scheduled-game-confirm').click(), 'scheduled-games');
    await page.getByText('Cancelled matches do not create attendance absences. Existing replies and records are retained.', { exact: true }).waitFor();
    current = await prep(); assert.equal(current.fixtures.find(value => value.id === fixture.id)?.status, 'cancelled');
    await page.getByTestId(`scheduled-game-delete-${fixture.id}`).waitFor();
    await page.waitForFunction(id => document.querySelector(`[data-testid="scheduled-game-delete-${id}"]`)?.getAttribute('aria-disabled') !== 'true', fixture.id);
    await page.getByTestId(`scheduled-game-delete-${fixture.id}`).click(); await page.getByTestId('scheduled-game-reason').fill('Remove the unplayed review fixture');
    await saved(() => page.getByTestId('scheduled-game-confirm').click(), 'scheduled-games');
    current = await prep(); assert(!current.fixtures.some(value => value.id === fixture.id));
  });

  if (phase !== 'baseline') await section('Manager explicitly checks in, stages, starts, pauses and uploads an actual match', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const current = await prep(), fixture = current.fixtures.find(value => value.status === 'scheduled' && value.playedDate >= new Date().toISOString().slice(0, 10) && value.selectedProfileIds.length === 8); assert(fixture);
    await openSchedule('matches'); await page.getByRole('button', { name: `Open fixture ${fixture.opponent}, ${r.reviewDateLabel(fixture.playedDate)}`, exact: true }).click();
    await page.getByTestId('formation-advice-open').click(); await page.getByTestId('formation-advice-choose').waitFor();
    assert(await page.getByTestId('formation-advice-choose').isEnabled());
    assert(await page.getByText(/Capacity estimate for the whole match/).isVisible());
    await saved(() => page.getByTestId('preparation-open-match').click()); await page.getByTestId('recording-acquire').waitFor();
    const readAccepted = () => r.api(`/v1/matches/${fixture.id}/download?deviceId=manager-persona-independent`, { state });
    const initial = await readAccepted(), match = initial.state; assert.equal(initial.acceptedRevision, 0); const assignments = coreLineup(match), slots = match.config.slots;
    await page.getByTestId('recording-acquire').click(); await page.getByText('Recording on this phone', { exact: true }).waitFor();
    await page.getByTestId('connected-match-attendance').click();
    for (const playerId of match.config.selectedPlayerIds) {
      const name = match.config.players.find(item => item.id === playerId).displayName;
      const row = page.locator('div').filter({ has: page.getByText(new RegExp(`^${name} · `)) }).filter({ has: page.getByRole('button', { name: 'Present', exact: true }) }).last();
      await row.getByRole('button', { name: 'Present', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('[role="progressbar"]'));
    }
    await page.getByTestId('connected-match-lineup').click(); await page.getByRole('button', { name: 'Show position list', exact: true }).click();
    for (let index = 0; index < slots.length; index++) {
      await page.getByRole('button', { name: new RegExp(`^${slots[index].label ?? slots[index].position} · place ${index + 1},`) }).click();
      await page.getByRole('button', { name: assignments[index].displayName, exact: true }).click();
    }
    await page.getByRole('button', { name: 'Save staged lineup', exact: true }).click(); assert.equal((await readAccepted()).acceptedRevision, 0);
    await page.getByTestId('connected-match-live').click();
    if (await page.getByTestId('planner-settings-confirm').count()) {
      await page.getByRole('button', { name: /^Yes(?: · selected)?$/ }).click(); await page.getByLabel('Match policy change reason', { exact: true }).fill('Manager persona confirms proposed planning settings before kickoff');
      await page.getByTestId('planner-settings-confirm').click(); await page.getByTestId('planner-position-mode').waitFor();
    }
    await page.getByRole('button', { name: 'Start first half', exact: true }).click(); await page.getByRole('button', { name: 'Confirm the actual event now', exact: true }).click();
    await page.getByTestId('next-substitution-time').first().waitFor();
    const countdownBefore = await page.getByTestId('next-substitution-time').first().innerText(); assert(/^\d+:\d{2}$/.test(countdownBefore));
    await r.delay(2500); const countdownAfter = await page.getByTestId('next-substitution-time').first().innerText();
    const seconds = value => value.split(':').map(Number).reduce((minutes, seconds) => minutes * 60 + seconds); assert(seconds(countdownAfter) < seconds(countdownBefore));
    await r.screenshot('manager-active-match-phone', state);
    await page.getByRole('button', { name: 'Review referee pause', exact: true }).click(); await page.getByRole('button', { name: 'Confirm the actual event now', exact: true }).click();
    await page.getByRole('button', { name: 'Review clock resume', exact: true }).waitFor();
    const pausedBefore = await page.getByTestId('next-substitution-time').first().innerText(); await r.delay(2500); assert.equal(await page.getByTestId('next-substitution-time').first().innerText(), pausedBefore);
    await page.getByTestId('recording-upload').click(); await page.getByText('Up to date with the service', { exact: true }).waitFor();
    const accepted = await readAccepted(); assert.equal(accepted.state.status, 'first_half_paused'); assert(match.config.selectedPlayerIds.every(id => accepted.state.attendance[id] === 'present'));
    assert.deepEqual(accepted.state.lineup.map(row => ({ slotId: row.slotId, playerId: row.playerId })), slots.map((slot,index) => ({ slotId: slot.slotId, playerId: assignments[index].id })));
    r.report.matchday = { matchId: fixture.id, selectedPlayers: 8, actualStarters: 7, countdownBefore, countdownAfter, freezesWhilePaused: true, localChangesRequireExplicitUpload: true, canonicalAcceptedRevision: accepted.acceptedRevision, hardwareAudioProved: false };
    await page.getByTestId('workspace-back-to-team').click(); await page.getByTestId('team-overview').waitFor();
  });

  await section('Manager tablet stats retain selected player and visible role legend', async () => {
    await page.setViewportSize({ width: 1024, height: 768 }); await r.openTab(state, 'stats');
    await page.getByTestId('stats-choose-synthetic-player-02').click();
    assert.equal(await page.getByTestId('stats-map-player').getAttribute('aria-pressed'), 'true');
    await page.getByTestId('stats-core-positions').waitFor(); await r.screenshot('manager-stats-tablet', state);
  });

  await section('Manager account and explicit logout', async () => {
    await r.openTab(state, 'account');
    assert(await page.getByTestId('demo-signed-in').isVisible());
    if (phase !== 'baseline') {
      await page.getByTestId('workspace-account-panel').waitFor();
      await page.getByTestId('account-section-help').click(); await page.getByTestId('account-help').waitFor();
      await page.getByTestId('account-section-privacy').click(); await page.getByTestId('account-privacy').waitFor();
      assert(await page.getByText('These requests remain pending review. No retention, recovery or support policy is approved by this screen.', { exact: true }).isVisible());
      await page.getByTestId('account-section-requests').click(); await page.getByTestId('account-requests-screen').waitFor();
      assert(await page.getByTestId('refresh-account-requests').isVisible());
      await page.getByTestId('account-section-summary').click();
    }
    const logout = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/demo/sessions/current' && response.request().method() === 'DELETE');
    await page.getByTestId(phase === 'baseline' ? 'demo-sign-out' : 'account-sign-out').click(); assert.equal((await logout).status(), 204);
    assert.equal(await page.getByTestId('workspace-manager-home').count(), 0);
  });
} catch (error) { fatal = error; }
finally {
  if (await harnessDigest() !== r.report.personaHarnessSha256) fatal = new Error('The Manager persona harness changed during its review.');
  const report = await r.finish({ passed: findings.length === 0, error: fatal });
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, findings: report.findings, failures: report.failures, output: r.output }));
  if (!report.passed) process.exitCode = 1;
}
