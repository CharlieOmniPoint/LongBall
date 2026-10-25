import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPersonaReview } from './persona-review-session.mjs';

const phase = process.env.LONGBALL_PERSONA_PHASE ?? 'baseline';
const candidate = phase.startsWith('candidate');
const fingerprint = async () => createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
const scriptFingerprint = await fingerprint();
const r = await createPersonaReview({ persona: 'spectator', name: 'spectator', mediaFixture: candidate, phase });
r.report.source.personaScriptSha256 = scriptFingerprint;
let error;
const noOverflow = async page => {
  const size = await page.evaluate(() => ({ viewport: innerWidth, body: document.documentElement.scrollWidth }));
  assert(size.body <= size.viewport + 2, 'Spectator pages must fit the phone/tablet viewport.');
};
const endpoint = (response, leaf, method = 'POST') => new URL(response.url()).pathname.endsWith('/' + leaf) && response.request().method() === method;
const mutation = async (page, leaf, action) => {
  const response = page.waitForResponse(value => endpoint(value, leaf));
  await action();
  const value = await response;
  assert(value.ok(), `The actual ${leaf} mutation must succeed.`);
  return value;
};
async function connectionRecovery(state, chosen) {
  const { page } = state, pattern = `${r.virtualApi}/v1/teams/${r.teamId}/spectator-connections?*`;
  let failures = 0;
  const failRead = async route => {
    if (route.request().method() !== 'GET' || failures++) return route.fallback();
    return route.fulfill({ status: 503, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': r.base }, body: JSON.stringify({ code: 'CONTROLLED_REVIEW_FAILURE' }) });
  };
  await page.route(pattern, failRead);
  try {
    await page.getByTestId('spectator-connections-refresh').click();
    await page.getByText('We could not load your player connections. Retry to check your choice.', { exact: true }).waitFor();
    assert.match(await page.getByTestId('spectator-connection-current').innerText(), /Last confirmed: Following the whole team/);
    await page.getByTestId('spectator-connections-refresh').click();
    await page.getByTestId('spectator-connection-current').filter({ hasText: 'Following the whole team' }).waitFor();
    assert.equal(await page.getByTestId('spectator-connections-loading').count(), 0);
  } finally { await page.unroute(pattern, failRead); }
  let writes = 0;
  const loseReceipt = async route => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fallback();
    writes++;
    const url = new URL(request.url());
    const accepted = await route.fetch({ url: r.base + url.pathname + url.search, headers: { ...request.headers(), connection: 'close' }, maxRedirects: 0, maxRetries: 0 });
    assert(accepted.ok(), 'The controlled lost receipt must follow a real accepted write.');
    await route.fulfill({ status: 503, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': r.base }, body: JSON.stringify({ code: 'CONTROLLED_LOST_RECEIPT' }) });
  };
  await page.route(pattern, loseReceipt);
  try {
    await page.getByTestId(`spectator-support-player-${chosen.id}`).click();
    await page.getByText('We could not confirm your choice. Refresh connections to check it before trying again.', { exact: true }).waitFor();
    assert.match(await page.getByTestId('spectator-connection-current').innerText(), /Last confirmed: Following the whole team/);
    assert.equal((await r.api(r.scope('spectator-connections'), { state })).followedPlayerId, chosen.id);
    await page.getByTestId('spectator-connections-refresh').click();
    await page.getByTestId('spectator-connection-current').filter({ hasText: `Supporting ${chosen.label}` }).waitFor();
    assert.equal(writes, 1, 'An uncertain save must not automatically send another write.');
  } finally { await page.unroute(pattern, loseReceipt); }
  let release, seen;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { seen = resolve; });
  const holdRead = async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    seen(); await gate; await route.abort().catch(() => {});
  };
  await page.route(pattern, holdRead);
  try {
    await page.getByTestId('spectator-connections-refresh').click(); await started;
    await page.getByTestId('spectator-connections-loading').waitFor();
    assert(await page.getByTestId(`spectator-support-player-${chosen.id}`).isDisabled());
    await page.getByText('Loading your connections took too long. Retry when connected.', { exact: true }).waitFor({ timeout: 23_000 });
    assert(await page.getByTestId('spectator-connections-refresh').isEnabled());
  } finally { release(); await page.unroute(pattern, holdRead); }
  await page.getByTestId('spectator-connections-refresh').click();
  await page.getByTestId('spectator-connection-current').filter({ hasText: `Supporting ${chosen.label}` }).waitFor();
  r.report.controlledFailures = ['One connection GET503 recovered manually', 'One accepted connection POST with its successful receipt replaced by503; no automatic duplicate', 'One connection GET held beyond the product20-second bound; retry recovered'];
  r.report.checks.push('Connection loading disables choices; a transient read, an accepted save with lost receipt and a bounded stalled read all recover with an explicit retry and keep the last confirmed selection honest.');
}
async function publishedPhotos(state) {
  const { page } = state;
  await r.budget(state); await r.openTab(state, 'community');
  const initial = await r.api(r.scope('community'), { state });
  assert.equal(initial.gallery.length, 2); assert.equal(initial.submissions.length, 0); assert.equal(initial.reviewQueue.length, 0);
  const photo = initial.gallery[0];
  if (await page.getByTestId('album-clear-selection').count()) {
    await page.getByTestId('album-clear-selection').click(); await page.getByTestId('album-selected-game').waitFor({ state: 'detached' });
  }
  const imageReads = { thumbnail: 0, display: 0 };
  page.on('request', request => {
    if (request.method() !== 'GET') return;
    const path = new URL(request.url()).pathname;
    for (const variant of ['thumbnail', 'display']) if (path.endsWith(`/photos/${photo.id}/${variant}`)) imageReads[variant]++;
  });
  const thumbnailPattern = `${r.virtualApi}/v1/teams/${r.teamId}/media/photos/${photo.id}/thumbnail?*`;
  let thumbnailFailures = 0;
  const failThumbnail = async route => {
    if (route.request().method() !== 'GET' || thumbnailFailures++) return route.fallback();
    await route.fulfill({ status: 503, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': r.base }, body: JSON.stringify({ code: 'CONTROLLED_THUMBNAIL_FAILURE' }) });
  };
  await page.route(thumbnailPattern, failThumbnail);
  try {
    await page.getByTestId(`album-game-${photo.matchId}`).click();
    await page.getByTestId(`media-thumbnail-retry-${photo.id}`).waitFor();
    await page.getByTestId(`media-thumbnail-retry-${photo.id}`).click();
    await page.getByTestId(`media-thumbnail-${photo.id}`).waitFor();
  } finally { await page.unroute(thumbnailPattern, failThumbnail); }
  assert.equal(await page.getByTestId(`album-game-${photo.matchId}`).getAttribute('aria-pressed'), 'true');
  const legacyThumbnail = page.getByRole('button', { name: 'View authorised thumbnail', exact: true });
  if (await legacyThumbnail.count()) await legacyThumbnail.first().click();
  const thumbnail = page.getByTestId(`media-thumbnail-${photo.id}`).locator('img');
  await thumbnail.waitFor();
  const photoData = await thumbnail.getAttribute('src');
  assert.match(photoData, /^data:image\//, 'The actual protected thumbnail must decode to image bytes.');
  await thumbnail.evaluate(image => new Promise((resolve, reject) => { if (image.complete) return image.naturalWidth > 0 ? resolve() : reject(new Error('Thumbnail failed to decode.')); image.onload = () => resolve(); image.onerror = () => reject(new Error('Thumbnail failed to decode.')); }));
  await r.delay(2200);
  assert.equal(imageReads.thumbnail, 2, 'A controlled failed thumbnail and one explicit retry must not reload again on the workspace clock ticks.');
  await page.getByTestId(`album-photo-${photo.id}`).click();
  const viewer = page.getByTestId('album-photo-viewer'); await viewer.waitFor();
  const legacyDisplay = viewer.getByRole('button', { name: 'View authorised service image', exact: true });
  if (await legacyDisplay.count()) await legacyDisplay.click();
  await viewer.locator('img').waitFor();
  assert.match(await viewer.locator('img').getAttribute('src'), /^data:image\//);
  await viewer.locator('img').evaluate(image => new Promise((resolve, reject) => { if (image.complete) return image.naturalWidth > 0 ? resolve() : reject(new Error('Photo failed to decode.')); image.onload = () => resolve(); image.onerror = () => reject(new Error('Photo failed to decode.')); }));
  assert.equal(imageReads.display, 1, 'Opening a game photo must make one real current-access display request.');
  assert.equal(await page.locator('[data-testid^="album-game-"]').count(), 0, 'The open viewer must replace the album chooser and grid.');
  const imageBox = await page.getByTestId(`media-photo-${photo.id}`).boundingBox(), navBox = await page.getByTestId('workspace-primary-navigation').boundingBox();
  assert(imageBox && navBox && imageBox.y >= 0 && imageBox.y + imageBox.height <= navBox.y, 'The complete opened photo must be visible above phone navigation without a further scroll.');
  r.report.photoViewerGeometry = { viewportWidth: 390, image: imageBox, navigationTop: navBox.y, noPostOpenScroll: true };
  await r.screenshot('photo-open-390', state);
  await page.getByTestId('album-close-photo').click();
  const samePhoto = page.getByTestId(`album-photo-${photo.id}`); await samePhoto.waitFor();
  assert.match(await samePhoto.innerText(), /^Open photo \d+$/);
  assert.match(await samePhoto.getAttribute('aria-label'), new RegExp(photo.caption.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(await page.getByTestId(`album-game-${photo.matchId}`).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByTestId(`media-photo-${photo.id}`).count(), 0, 'Closing the photo must dispose its full image while preserving the chosen album.');
  await samePhoto.click(); await page.getByTestId(`media-photo-${photo.id}`).waitFor();
  await page.getByTestId(`community-report-uploader-${photo.id}`).click();
  await page.getByTestId(`community-concern-form-${photo.id}`).waitFor();
  await page.getByTestId('community-cancel-concern').click();
  assert.equal(await page.getByTestId(`community-concern-form-${photo.id}`).count(), 0);
  await page.getByTestId(`community-report-photo-${photo.id}`).click();
  await page.getByLabel('Concern explanation', { exact: true }).fill('Review check: please confirm this matchday picture has the expected permission.');
  await mutation(page, 'community', () => page.getByTestId('community-submit-concern').click());
  const reported = await r.api(r.scope('community'), { state });
  const concern = reported.ownConcerns.find(item => !initial.ownConcerns.some(previous => previous.id === item.id));
  assert(concern && concern.targetType === 'photo');
  await page.getByTestId(`community-own-concern-${concern.id}`).waitFor();
  await page.getByTestId(`community-hide-uploader-${photo.id}`).click();
  const confirmation = page.getByTestId('community-hide-confirmation'); await confirmation.waitFor();
  assert.match(await confirmation.innerText(), /this account|your gallery/);
  await mutation(page, 'community', () => page.getByTestId('community-confirm-hide-uploader').click());
  const hidden = await r.api(r.scope('community'), { state });
  assert(hidden.hiddenUploaders.some(item => item.id === photo.uploaderAccountId));
  assert(hidden.gallery.every(item => item.uploaderAccountId !== photo.uploaderAccountId));
  assert.deepEqual(hidden.matches.map(item => [item.id, item.score, item.award]), reported.matches.map(item => [item.id, item.score, item.award]), 'Hiding gallery content must preserve official match/award projections.');
  await mutation(page, 'community', () => page.getByRole('button', { name: `Show ${photo.uploaderLabel} again`, exact: true }).click());
  const restored = await r.api(r.scope('community'), { state });
  assert(restored.gallery.some(item => item.id === photo.id)); assert.equal(restored.hiddenUploaders.length, 0);
  for (const width of [320, 390, 1024]) { await page.setViewportSize({ width, height: 844 }); await noOverflow(page); }
  await page.setViewportSize({ width: 390, height: 844 });
  await r.screenshot('photos-real-protected-gallery-390', state);
  await page.getByTestId('community-toggle-preferences').click();
  const schedule = page.getByRole('switch', { name: /schedule updates/i });
  const before = restored.preferences.schedule;
  await mutation(page, 'community', () => schedule.click());
  assert.equal((await r.api(r.scope('community'), { state })).preferences.schedule, !before);
  await page.getByPlaceholder('Start HH:MM', { exact: true }).fill('22:00');
  await page.getByPlaceholder('End HH:MM', { exact: true }).fill('22:00');
  const save = page.getByRole('button', { name: /Save.*quiet hours/i }); assert(await save.isDisabled());
  await page.getByPlaceholder('End HH:MM', { exact: true }).fill('07:00');
  await mutation(page, 'community', () => save.click());
  const preferences = (await r.api(r.scope('community'), { state })).preferences;
  assert.equal(preferences.quietStart, '22:00'); assert.equal(preferences.quietEnd, '07:00');
  r.report.checks.push('Actual protected thumbnail/full-image bytes open from published-only albums; reporting, cancellation, account-only uploader hiding and restoration persist without altering official match/award data.');
  r.report.checks.push('Gallery previews load automatically, a controlled thumbnail503 offers a successful explicit retry, and the preview makes no additional request over successive workspace clock ticks; Open photo loads one decoded current-access display image.');
  r.report.checks.push('On390px the viewer replaces album/grid clutter, shows the complete photo above navigation without an extra scroll, preserves the full caption in accessible button names and returns to the same selected album when closed.');
  r.report.checks.push('Notification category and UK quiet-hour preferences persist, equal start/end is refused; no notification delivery or real antivirus proof is claimed.');
}
const registerCapability = value => {
  r.addSecret(value.shareUrl);
  const token = new URLSearchParams(new URL(value.shareUrl).hash.slice(1)).get('code'); assert(token); r.addSecret(token);
  return { ...value, token };
};
async function anonymousRequest(staff) {
  const state = await r.makePage('spectator'), { page } = state;
  await page.setViewportSize({ width: 320, height: 844 });
  const pattern = `${r.virtualApi}/v1/spectator-access/directory`;
  let failures = 0;
  const failFirst = async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    if (failures++) return route.fallback();
    await route.fulfill({ status: 503, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': r.base }, body: JSON.stringify({ code: 'CONTROLLED_DIRECTORY_FAILURE' }) });
  };
  await page.route(pattern, failFirst);
  const email = `spectator-review-${randomBytes(4).toString('hex')}@example.test`; r.addSecret(email);
  try {
    await page.goto(r.base); await page.getByTestId('welcome-sign-in').click(); await page.getByTestId('demo-request-invite').click();
    await page.getByTestId('invite-directory-retry').waitFor();
    await page.getByLabel('Name for invitation request', { exact: true }).fill('Alex Review');
    await page.getByLabel('Invitation request contact email', { exact: true }).fill(email);
    await page.getByRole('button', { name: 'Spectator', exact: true }).click();
    assert(await page.getByTestId('submit-invite-request').isDisabled());
    await page.getByTestId('invite-directory-retry').click();
    await page.getByRole('button', { name: 'Richmond Rovers', exact: true }).click();
    assert.equal(await page.getByLabel('Name for invitation request', { exact: true }).inputValue(), 'Alex Review');
    assert.equal(await page.getByLabel('Invitation request contact email', { exact: true }).inputValue(), email);
    await page.getByRole('button', { name: /^Roma U10 ·/ }).click();
    await noOverflow(page);
    const requestPattern = `${r.virtualApi}/v1/spectator-access/requests`, bodies = [];
    let lost = 0;
    const loseRequestReceipt = async route => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      bodies.push(request.postDataJSON());
      if (lost++) return route.fallback();
      const url = new URL(request.url());
      const accepted = await route.fetch({ url: r.base + url.pathname + url.search, headers: { ...request.headers(), connection: 'close' }, maxRedirects: 0, maxRetries: 0 });
      assert.equal(accepted.status(), 202, 'The lost receipt must follow an actual pending staff request.');
      await route.fulfill({ status: 503, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': r.base }, body: JSON.stringify({ code: 'CONTROLLED_REQUEST_LOST_RECEIPT' }) });
    };
    await page.route(requestPattern, loseRequestReceipt);
    let response;
    try {
      await page.getByTestId('submit-invite-request').click();
      await page.getByText('Your request was not confirmed. Retry the original request to check it; your details have been kept unchanged.', { exact: true }).waitFor();
      assert.equal(bodies.length, 1, 'A lost request receipt must not trigger an automatic second request.');
      assert.equal(await page.getByLabel('Name for invitation request', { exact: true }).isEditable(), false);
      assert.equal(await page.getByLabel('Invitation request contact email', { exact: true }).isEditable(), false);
      await page.getByRole('button', { name: 'Back to sign in', exact: true }).click();
      await page.getByTestId('invite-request-leave-confirmation').waitFor(); await page.getByRole('button', { name: 'Stay and retry', exact: true }).click();
      response = await mutation(page, 'requests', () => page.getByTestId('submit-invite-request').click());
      assert.equal(bodies.length, 2); assert.deepEqual(bodies[0], bodies[1], 'An explicit retry must preserve the exact original requestId and body.');
    } finally { await page.unroute(requestPattern, loseRequestReceipt); }
    assert.equal(response.status(), 202);
    await page.getByText('Your request has been sent to the team staff. They will review it and contact you. No account or team access has been created yet.', { exact: true }).waitFor();
    assert.equal(await page.getByTestId('demo-signed-in').count(), 0);
    assert.equal(state.session, null);
    const queue = await r.api(r.scope('invite-requests'), { state: staff, role: 'manager' });
    assert.equal(queue.filter(item => item.email === email && item.requestedRole === 'spectator' && item.status === 'pending').length, 1, 'An exact retry after a lost receipt must leave one pending staff request.');
  } finally { await page.unroute(pattern, failFirst); }
  r.report.checks.push('A first-time320px Spectator request recovers a directory503 with retained contact fields; an accepted request whose receipt is lost locks its exact body, warns before leaving and retries the original requestId explicitly to produce one pending staff request without an account or automatic membership.');
}
async function invitationJourney(state) {
  await r.budget(state); const { page } = state;
  await r.openTab(state, 'account'); await page.getByTestId('workspace-account-invite').click();
  await page.getByTestId('invitation-hours').fill('2');
  const created = await mutation(page, 'spectator-invites', () => page.getByTestId('invitation-create').click());
  assert.equal(created.status(), 201); const invitation = registerCapability(await created.json());
  await page.getByTestId('invitation-show-qr').click(); await page.getByTestId('invitation-qr-code').waitFor();
  assert.equal(await page.getByTestId('invitation-qr-code').locator('svg path').count(), 1);
  assert(await page.getByRole('button', { name: 'Invite by email', exact: true }).isEnabled());
  await page.getByTestId('invitation-close-link').click();
  const joined = await r.makePage('spectator'), jp = joined.page;
  await jp.setViewportSize({ width: 320, height: 844 });
  const username = `Roma.Review${randomBytes(3).toString('hex')}`, pin = '4729'; r.addSecret(username); r.addSecret(pin);
  let registrations = 0, failedPreviews = 0;
  const previewPattern = `${r.virtualApi}/v1/spectator-access/preview`;
  const failPreview = async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    if (failedPreviews++) return route.fallback();
    await route.fulfill({ status: 503, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': r.base }, body: JSON.stringify({ code: 'CONTROLLED_PREVIEW_FAILURE' }) });
  };
  jp.on('request', request => { if (new URL(request.url()).pathname === '/v1/spectator-access/register') registrations++; });
  await jp.route(previewPattern, failPreview);
  try {
    await jp.goto(invitation.shareUrl, { waitUntil: 'networkidle' }); await jp.getByTestId('welcome-spectator').click();
    await jp.getByTestId('spectator-invitation-retry').waitFor();
    await jp.getByTestId('spectator-signup-name').fill('Taylor Harper'); await jp.getByTestId('spectator-pin-username').fill(username);
    await jp.getByTestId('spectator-invitation-retry').click(); await jp.getByTestId('spectator-pin-context').waitFor();
    assert.equal(await jp.getByTestId('spectator-pin-username').inputValue(), username);
    assert.equal(await jp.getByTestId('spectator-signup-name').inputValue(), 'Taylor Harper');
    assert.match(await jp.getByTestId('spectator-pin-context').innerText(), /Roma U10/);
    await noOverflow(jp);
  } finally { await jp.unroute(previewPattern, failPreview); }
  await jp.getByTestId('spectator-pin-passcode').fill('1111'); await jp.getByTestId('spectator-pin-confirmation').fill('1111');
  await jp.getByTestId('spectator-pin-submit').click(); assert.equal(registrations, 0);
  await jp.getByTestId('spectator-pin-passcode').fill(pin); await jp.getByTestId('spectator-pin-confirmation').fill(pin);
  const registered = await mutation(jp, 'register', () => jp.getByTestId('spectator-pin-submit').click());
  const session = await registered.json(); r.addSecret(session.accessToken);
  joined.session = session; joined.account = { ...joined.account, accountId: session.accountId };
  await jp.getByTestId('demo-signed-in').waitFor(); await r.selectWorkspaceContext(jp, 'spectator');
  assert.equal(registrations, 1);
  await r.openTab(joined, 'account');
  await jp.getByTestId('spectator-connection-current').waitFor();
  await mutation(jp, 'spectator-connections', () => jp.getByTestId('spectator-support-player-synthetic-player-01').click());
  assert.equal((await r.api(r.scope('spectator-connections'), { state: joined })).followedPlayerId, 'synthetic-player-01');
  const oldSession = session.accessToken;
  const logout = jp.waitForResponse(response => endpoint(response, 'session', 'DELETE'));
  await jp.getByTestId('demo-sign-out').click(); assert.equal((await logout).status(), 204);
  await jp.getByText('Spectator sign in', { exact: true }).waitFor();
  assert.equal(await jp.getByTestId('spectator-pin-confirmation').count(), 0);
  await r.api('/v1/me', { state: joined, token: oldSession, expected: 401 });
  await jp.goto(r.base); await jp.getByTestId('welcome-spectator').click();
  await jp.getByTestId('spectator-pin-username').fill(username); await jp.getByTestId('spectator-pin-passcode').fill(pin);
  const signedIn = await mutation(jp, 'login', () => jp.getByTestId('spectator-pin-submit').click());
  joined.session = await signedIn.json(); r.addSecret(joined.session.accessToken);
  await jp.getByTestId('demo-signed-in').waitFor(); await r.selectWorkspaceContext(jp, 'spectator');
  assert.equal(joined.session.accountId, session.accountId);
  const superState = await r.login('super');
  await anonymousRequest(superState);
  const clubName = 'Spectator review club', teamName = 'Review U12';
  let directory = await r.api('/v1/administration', { state: superState, body: { command: { type: 'club.create', name: clubName } } });
  const club = directory.clubs.find(item => item.name === clubName); assert(club);
  directory = await r.api('/v1/administration', { state: superState, body: { command: { type: 'team.create', clubId: club.id, name: teamName, ageGroup: 'U12', format: 9, seasonStartYear: 2026 } } });
  const team = directory.teams.find(item => item.name === teamName); assert(team);
  const second = registerCapability(await r.api(`/v1/teams/${team.id}/spectator-invites`, { state: superState, role: 'manager', body: { seasonId: team.seasonId, expiresInHours: 1 }, expected: 201 }));
  const multi = await r.makePage('spectator'), mp = multi.page;
  await mp.goto(second.shareUrl); await mp.getByTestId('welcome-spectator').click(); await mp.getByTestId('spectator-pin-context').waitFor();
  await mp.getByRole('button', { name: 'I already have a spectator account', exact: true }).click();
  await mp.getByTestId('spectator-pin-username').fill(username); await mp.getByTestId('spectator-pin-passcode').fill(pin);
  const accepted = await mutation(mp, 'login', () => mp.getByTestId('spectator-pin-submit').click());
  multi.session = await accepted.json(); r.addSecret(multi.session.accessToken); multi.account = { ...multi.account, accountId: session.accountId };
  await mp.getByTestId('demo-signed-in').waitFor(); await r.selectWorkspaceContext(mp, 'spectator', { teamId: team.id, seasonId: team.seasonId });
  const memberships = (await r.api('/v1/me', { state: multi })).memberships;
  assert(memberships.some(item => item.teamId === r.teamId && item.role === 'spectator'));
  assert(memberships.some(item => item.teamId === team.id && item.role === 'spectator'));
  await r.openTab(multi, 'account'); await mp.getByText('No player names are available yet. You can still follow the whole team.', { exact: true }).waitFor();
  assert.equal(await mp.getByTestId('spectator-support-team').getAttribute('aria-pressed'), 'true');
  await mp.getByTestId('workspace-change-context').click(); await r.selectWorkspaceContext(mp, 'spectator');
  await r.openTab(multi, 'account'); await mp.getByTestId('spectator-connection-current').filter({ hasText: 'Thomas Arnold' }).waitFor();
  assert.equal((await r.api(r.scope('spectator-connections'), { state: multi })).followedPlayerId, 'synthetic-player-01');
  r.report.checks.push('A Spectator creates a scoped invitation and local QR with email-compose availability; a new320px join recovers a preview503, preserves edited name/username, refuses1111 before any POST, creates its own PIN account, signs out/revokes and signs back in. No email was sent or capability screenshot retained.');
  r.report.checks.push('An existing PIN account accepts a second actual team, sees a safe whole-team-only empty roster, switches back and retains its original per-team supported player without replacing either grant.');
}
const watchdog = setTimeout(() => { void r.finish({ passed: false, error: new Error('The bounded Spectator review exceeded its ten-minute deadline.') }).finally(() => { process.exitCode = 1; }); }, 600_000); watchdog.unref();
try {
  const state = await r.login(), { page } = state;
  const primary = page.getByTestId('workspace-primary-navigation');
  assert.deepEqual(await primary.getByRole('tab').allTextContents(), ['Home', 'Scores', 'Results', 'Photos', 'Account']);
  assert.match(await page.getByTestId('workspace-current-role').innerText(), /Spectator/);
  assert.equal(await primary.getByTestId('workspace-tab-stats').count(), 0);
  r.report.checks.push('Spectator sign-in opens only the simple Home, Scores, Results, Photos and Account navigation, with its role identified.');

  for (const width of [320, 390, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    await r.openTab(state, 'overview'); await page.getByTestId('team-overview').waitFor();
    assert.match(await page.getByTestId('team-overview').innerText(), /Roma U10/);
    await noOverflow(page);
    if (width !== 320) await r.screenshot(`home-${width}`, state);
  }
  const openGame = page.getByTestId('team-overview-open-game');
  if (await openGame.isVisible()) {
    await openGame.click();
    await page.getByTestId('workspace-all-games').waitFor();
    await page.getByTestId('workspace-all-games').click();
  }
  r.report.checks.push('Home overview fits 320/390/1024px and opens its recommended game, with an All games return path.');
  await r.budget(state);

  await r.openTab(state, 'centre'); await page.getByTestId('workspace-match-centre').waitFor();
  const matches = await r.api(r.scope('matches'), { state });
  const cards = page.locator('[data-testid^="match-centre-game-"]');
  const preparation = (matches.items ?? []).filter(item => (item.status ?? item.state?.status) === 'preparation');
  const misleadingPreplay = [];
  for (const match of preparation) {
    const card = page.getByTestId(`match-centre-game-${match.matchId}`);
    if (await card.count() && /0\s*[–-]\s*0/.test(await card.innerText())) misleadingPreplay.push(match.matchId);
  }
  if (candidate) {
    assert.equal(misleadingPreplay.length, 0, 'An unstarted fixture must not look like a recorded0–0 result.');
    for (const match of preparation) {
      const card = page.getByTestId(`match-centre-game-${match.matchId}`);
      assert.match(await card.innerText(), /Not started/);
      assert.equal(await card.getByRole('button', { name: /match details|match report/i }).count(), 0);
    }
  } else if (misleadingPreplay.length) r.report.findings.push({ id: 'S-PREPLAY-SCORE', severity: 'medium', area: 'Scores', finding: 'Unstarted games display a 0–0 score, which can be mistaken for a recorded result.', affectedGames: misleadingPreplay });
  assert(await cards.count() > 0);
  assert.equal(await page.locator('[data-testid^="stats-player-detail-"]').count(), 0);
  const detailToggle = page.locator('[data-testid^="match-centre-toggle-details-"]').first();
  if (await detailToggle.count()) await detailToggle.click();
  if (candidate) {
    const refreshed = page.waitForResponse(response => endpoint(response, 'matches', 'GET'));
    await page.getByRole('button', { name: 'Refresh match updates', exact: true }).click(); assert((await refreshed).ok());
    await page.getByTestId('match-centre-last-checked').filter({ hasText: 'Last checked:' }).waitFor();
    assert.match(await page.getByTestId('match-centre-last-checked').innerText(), /UK time/);
    assert.match(await page.getByTestId('match-centre-auto-refresh').innerText(), /every 2 minutes/);
    r.report.checks.push('Manual match refresh reaches the actual permitted match endpoint and presents its last-checked UK-time receipt plus the existing two-minute auto-check explanation; this journey does not simulate an elapsed background scheduler interval.');
  }
  await noOverflow(page); await r.screenshot('scores-1024', state);
  r.report.checks.push('Scores exposes permitted match cards/details and refresh receipts without private player-stat views.');

  await r.openTab(state, 'reports'); await page.getByTestId('workspace-reports').waitFor();
  assert.equal(await page.getByText('My known participation', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Recorded participation', { exact: true }).count(), 0);
  await noOverflow(page); await r.screenshot('results-1024', state);
  await r.api(r.scope('player-stats'), { state, expected: 404 });
  if (candidate) {
    await r.api(r.scope('opposition-reviews'), { state, expected: 404 });
    await r.api(r.scope('team-sheet'), { state, expected: 404 });
    assert(matches.items.every(match => match.audience === 'spectator' && !match.ownRecord && !match.state), 'Spectator match DTOs must exclude another player’s participation and Manager state.');
    await page.getByRole('button', { name: 'Open report for Hill FC', exact: true }).click();
    const gamePhotoLink = page.locator('[data-testid^="report-open-album-"]').first();
    assert(await gamePhotoLink.count(), 'A completed report with published pictures must offer its game album.');
    await gamePhotoLink.click(); await page.getByTestId('album-selected-game').waitFor();
    assert.equal(await page.getByTestId('community-awards').isVisible().catch(() => false), false);
    r.report.checks.push('A completed result opens its published game album directly; protected opposition notes, FA team sheets, private player participation and Manager match state remain unavailable to Spectators.');
  }
  const community = await r.api(r.scope('community'), { state });
  assert(community.matches.every(match => !match.mayVote && match.ownChoice === null && match.candidates.length === 0));
  assert.equal(community.submissions.length, 0); assert.equal(community.reviewQueue.length, 0);
  r.report.checks.push('Results are readable without player participation rows; direct player stats are denied and the community projection contains no ballot candidates, own ballot, submissions or review queue.');
  await r.budget(state);

  await page.setViewportSize({ width: 390, height: 844 });
  await r.openTab(state, 'community'); await page.getByTestId('workspace-community').waitFor();
  assert.equal(await page.locator('[data-testid^="connected-ballot-"]').count(), 0);
  const photosText = await page.getByTestId('workspace-community').innerText();
  const awardsVisible = await page.getByTestId('community-awards').isVisible().catch(() => false);
  const invitationsVisible = await page.getByTestId('invitation-create').isVisible().catch(() => false);
  if (candidate) {
    assert(!awardsVisible, 'Photos must keep the awards list behind a deliberate choice.');
    assert(!invitationsVisible, 'Photos must not display unrelated invitation creation.');
    assert(!/service revision/.test(photosText), 'Spectator photo browsing must avoid raw implementation revision copy.');
  } else {
    if (awardsVisible) r.report.findings.push({ id: 'S-PHOTOS-CLUTTER', severity: 'medium', area: 'Photos', finding: 'The Photos destination also presents the full awards list instead of a separate deliberate section.' });
    if (invitationsVisible) r.report.findings.push({ id: 'S-PHOTOS-INVITES', severity: 'medium', area: 'Photos', finding: 'Invitation creation is presented inline with browsing photos.' });
    if (/service revision/.test(photosText)) r.report.findings.push({ id: 'S-TECHNICAL-COPY', severity: 'low', area: 'Photos', finding: 'Technical service revision/implementation wording crowds the spectator experience.' });
  }
  const zeroAlbumLabels = await page.locator('[data-testid^="album-game-"]').allTextContents();
  if (candidate) assert(!zeroAlbumLabels.some(label => /\b0 photos\b/.test(label)), 'Spectators must only be offered game albums with published photos.');
  else if (zeroAlbumLabels.some(label => /\b0 photos\b/.test(label))) r.report.findings.push({ id: 'S-EMPTY-ALBUMS', severity: 'medium', area: 'Photos', finding: 'Spectators are offered empty game albums despite having no upload action.' });
  await noOverflow(page); await r.screenshot('photos-390', state);
  r.report.checks.push('Photos is reachable without vote/upload/review controls; published-only data and empty/cluttered states were inspected.');

  await r.openTab(state, 'account'); await page.getByTestId('spectator-player-connection').waitFor();
  const connection = await r.api(r.scope('spectator-connections'), { state });
  const chosen = connection.players[0]; assert(chosen);
  const support = page.getByTestId('spectator-player-connection');
  if (!candidate) {
    await mutation(page, 'spectator-connections', () => support.getByRole('button', { name: chosen.label, exact: true }).click());
    assert.equal((await r.api(r.scope('spectator-connections'), { state })).followedPlayerId, chosen.id);
    if (!await page.getByTestId('spectator-connections-refresh').count()) r.report.findings.push({ id: 'S-CONNECTION-RETRY', severity: 'medium', area: 'Account', finding: 'Player connection load/save failures have no direct refresh/retry control or initial loading state.' });
    if (await support.getByRole('button', { name: chosen.label, exact: true }).getAttribute('aria-pressed') !== 'true') r.report.findings.push({ id: 'S-CONNECTION-STATE', severity: 'medium', area: 'Account', finding: 'The chosen supported player is indicated by colour only, without pressed/selected accessibility state.' });
  } else {
    await page.getByTestId(`spectator-support-player-${chosen.id}`).click();
    await page.getByTestId('spectator-connection-current').filter({ hasText: chosen.label }).waitFor();
    assert.equal(await page.getByTestId(`spectator-support-player-${chosen.id}`).getAttribute('aria-pressed'), 'true');
    await page.getByTestId('spectator-support-team').click();
    await page.getByTestId('spectator-connection-current').filter({ hasText: 'Following the whole team' }).waitFor();
    assert.equal(await page.getByTestId('spectator-support-team').getAttribute('aria-pressed'), 'true');
  }
  assert(await page.getByTestId('workspace-account-invite').isVisible());
  await noOverflow(page); await r.screenshot('account-390', state);
  r.report.checks.push('A Spectator can save the player they support within the invited team; this does not expose private player stats. The later owner-authorized spectator invitation entry remains available.');

  if (candidate) {
    await page.getByTestId('account-section-help').click(); await page.getByTestId('account-help').waitFor();
    assert.match(await page.getByTestId('account-help').innerText(), /Home shows your team/);
    await page.getByTestId('account-section-privacy').click(); await page.getByTestId('account-privacy').waitFor();
    assert.match(await page.getByTestId('account-privacy').innerText(), /pending review|awaiting the agreed club policy/);
    await page.getByTestId('account-section-requests').click(); await page.getByTestId('account-requests-screen').waitFor();
    await page.getByText('Choose a request', { exact: true }).waitFor(); await noOverflow(page);
    assert.equal(await page.getByTestId('submit-account-request').count(), 0, 'Opening privacy intake must not submit a request without a chosen and confirmed scope.');
    await page.getByTestId('account-section-summary').click();
    r.report.checks.push('Spectator Account exposes role-specific Help, Privacy and its own data-request intake, clearly marks policy/verification as pending, and submits nothing merely by opening the screen. Deferred fulfilment decisions remain pending.');
    await connectionRecovery(state, chosen);
    await publishedPhotos(state);
    await invitationJourney(state);
    await r.budget(state);
  }

  await r.openTab(state, 'account');
  await page.getByTestId('workspace-account-invite').click();
  const invitationRoot = page.getByTestId('connected-invitations');
  if (await invitationRoot.count()) await invitationRoot.waitFor();
  r.report.checks.push(candidate ? 'Account returns to the distinct invitation workspace after the earlier issued link/QR was closed; no capability screenshot is retained.' : 'Account opens the distinct spectator invitation workspace; no invitation credential or QR is generated or photographed in this baseline.');
  await r.openTab(state, 'overview');
  const signOut = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/demo/sessions/current' && response.request().method() === 'DELETE');
  await page.getByTestId('demo-sign-out').click(); assert.equal((await signOut).status(), 204);
  await page.getByTestId('demo-login-screen').waitFor();
  assert.equal(await page.getByTestId('workspace-community').count(), 0);
  await r.api('/v1/me', { state, expected: 401 });
  r.report.checks.push('Explicit sign-out closes private views and revokes the old session token.');
} catch (cause) { error = cause; }
clearTimeout(watchdog);
if (await fingerprint() !== scriptFingerprint) error ??= new Error('The Spectator review harness changed during its run.');
const report = await r.finish({ passed: !error, error });
console.log(JSON.stringify({ persona: 'spectator', phase, passed: report.passed, checks: report.checks.length, findings: report.findings, failures: report.failures, report: `.local/quality/persona-spectator-${phase}/report.json` }));
if (!report.passed) process.exitCode = 1;
