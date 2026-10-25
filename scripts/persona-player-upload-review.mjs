import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPersonaReview } from './persona-review-session.mjs';
import { demoArtwork } from '../infra/cloud-preview/seed-demo-media.mjs';

const phase = process.env.LONGBALL_PERSONA_PHASE ?? 'final';
const baseline = phase === 'baseline';
const r = await createPersonaReview({ persona: 'player', name: 'player-upload', phase, mediaFixture: !baseline });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
r.report.source.harnessSha256 = digest(await readFile(new URL(import.meta.url)));
r.report.scannerBoundary = 'The optional isolated scanner fixture accepts only the three exact original people-free demoArtwork byte sequences. It is not antivirus acceptance; decoding, private storage, media authorization and publication remain the actual application pipeline.';
let player, manager, spectator, stage = 'Player sign in', failed;
const waitPost = (page, suffix) => page.waitForResponse(response => new URL(response.url()).pathname.endsWith(suffix) && response.request().method() === 'POST');
const caption = 'Player photo approval journey';
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function community(state) { return r.api(r.scope('community'), { state }); }
async function uploadAlbum(state) {
  await r.openTab(state, 'community');
  await state.page.getByTestId('album-game-synthetic-history-hill').click();
  await state.page.getByTestId('media-generated-image').waitFor();
}
async function managerPhotoRow(state) {
  const text = state.page.getByText(caption, { exact: true }); await text.waitFor();
  return text.locator('..');
}
const watchdog = setTimeout(() => { void r.finish({ passed: false, error: new Error(`Player photo review exceeded its bounded six-minute deadline at ${stage}.`) }).finally(() => { process.exitCode = 1; }); }, 360_000); watchdog.unref();
try {
  player = await r.login('player');
  assert.equal((await r.api('/v1/me', { state: player })).principal.accountId, player.account.accountId, 'The real Player login must be valid before photo actions.');
  await uploadAlbum(player);
  const { page } = player;
  await page.getByTestId('media-generated-image').click();
  const note = page.getByTestId('media-caption').or(page.getByLabel('Connected image caption', { exact: true })).first(); await note.fill(caption);
  const acknowledgement = page.getByRole('switch', { name: /^(?:I checked this photo and the team’s photo rules|Connected image policy acknowledgement)$/ });
  await acknowledgement.click();
  let submittedAuthorization, submittedHash;
  page.on('request', request => {
    const capability = request.headers()['x-media-upload-token'];
    if (capability && r.addSecret) r.addSecret(capability);
    if (new URL(request.url()).pathname.endsWith('/media/uploads/prepare') && request.method() === 'POST') {
      submittedAuthorization = request.headers().authorization;
      submittedHash = request.postDataJSON().sha256;
    }
  });
  stage = 'Player authenticated photo preparation';
  const preparedResponse = waitPost(page, '/media/uploads/prepare');
  // Register before the click: the exact artwork fixture can process immediately.
  const completionResponse = baseline ? null : page.waitForResponse(response => /\/media\/uploads\/[^/]+\/complete$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST').catch(error => error);
  await page.getByTestId('media-upload-image').click();
  const preparedReply = await preparedResponse;
  if (baseline) {
    assert.equal(preparedReply.status(), 401, 'This dedicated baseline probe demonstrates the recorded raw-identity upload authentication defect.');
    assert.equal(submittedAuthorization, `Bearer ${player.account.accountId}`);
    assert.equal((await r.api('/v1/me', { state: player })).principal.accountId, player.account.accountId, 'The surrounding Player session remains valid; this is not an expired login.');
    r.report.findings.push('Confirmed functional defect: MediaUpload in demo mode sends the raw account ID instead of the verified demo session token. Photo preparation returns401 while the same logged-in Player still has valid /me access.');
    r.report.baselineUploadAuthentication = { preparationStatus: 401, rawIdentityUsed: true, surroundingSessionValid: true };
    failed = new Error('Baseline Player photo upload uses raw identity and is rejected.');
  } else {
    assert.equal(preparedReply.status(), 200);
    assert.equal(submittedAuthorization, `Bearer ${player.session.accessToken}`, 'Upload preparation must use the same verified current session as the rest of the Player workspace.');
    assert.equal(submittedHash, digest(demoArtwork('ball')), 'The selected app illustration must match the approved original football artwork exactly.');
    const prepared = await preparedReply.json(); r.addSecret(prepared.uploadToken);
    const complete = await completionResponse;
    if (complete instanceof Error) throw complete;
    assert(new URL(complete.url()).pathname.endsWith(`/media/uploads/${prepared.uploadId}/complete`));
    assert.equal(complete.status(), 200);
    await page.getByText('Your photo is ready for your manager to review. The team cannot see it until it is approved.', { exact: true }).waitFor();
    assert(await page.getByTestId('media-upload-image').isDisabled(), 'A confirmed completed upload must not be accidentally submitted again.');
    const beforeReview = await community(player), own = beforeReview.submissions.find(photo => photo.id === prepared.photoId);
    assert(own && own.status === 'pending');
    assert(!beforeReview.gallery.some(photo => photo.id === prepared.photoId), 'A processed Player photo must stay out of the gallery before manager approval.');
    assert.equal(await page.getByRole('button', { name: /Publish this exact service photo revision/ }).count(), 0, 'Player upload does not grant publication authority.');
    r.report.checks.push('Actual Player upload uses its verified session; exact approved artwork passes processing and is pending, private, and not published automatically.');

    stage = 'A new selected image requires a fresh content review';
    const library = page.getByRole('button', { name: 'Choose a photo', exact: true });
    if (await library.count()) {
      const choosing = page.waitForEvent('filechooser'); await library.click();
      await (await choosing).setFiles({ name: 'football.png', mimeType: 'image/png', buffer: demoArtwork('ball') });
      await page.getByText('Selected local image · still private', { exact: true }).waitFor();
      r.report.browserLibraryPicker = { actualFileInput: true, selectedOriginalFootballArtwork: true, nativePhotoPermissionTested: false };
    } else {
      await page.getByTestId('media-generated-image').click();
      r.report.browserLibraryPicker = { actualFileInput: false, reason: 'The compiled review build does not enable library selection.', nativePhotoPermissionTested: false };
    }
    await settle(page);
    assert.equal(await acknowledgement.isChecked(), false, 'A newly selected photo must not inherit the last photo’s review acknowledgement.');
    assert(await page.getByTestId('media-upload-image').isDisabled());
    assert.equal(await page.getByText('Your photo is ready for your manager to review. The team cannot see it until it is approved.', { exact: true }).count(), 0, 'The previous receipt phase must not describe the new picture.');
    r.report.checks.push('Selecting a new photo clears only confirmed presentation/acknowledgement state; no second upload occurs without a new review.');

    stage = 'Spectator cannot read the pending Player photo';
    spectator = await r.login('spectator');
    const beforePublished = await community(spectator);
    assert(!beforePublished.gallery.some(photo => photo.id === prepared.photoId));
    await r.api(`${r.scope(`media/photos/${prepared.photoId}/display`)}&mode=gallery&revision=${own.version}`, { state: spectator, expected: 404 });
    r.report.checks.push('A real Spectator account cannot see or fetch a pending Player photo.');

    stage = 'Manager explicitly views and approves the exact pending revision';
    manager = await r.login('manager'); await r.openTab(manager, 'community');
    const review = await community(manager), queued = review.reviewQueue.find(photo => photo.id === prepared.photoId); assert(queued);
    const row = await managerPhotoRow(manager);
    const view = row.getByRole('button', { name: /^(?:View authorised service image|View photo|Open photo)$/ });
    const approve = row.getByRole('button', { name: /^(?:Approve this exact service photo revision|Approve photo|Approve)$/ });
    assert(await approve.isDisabled(), 'A pending photo cannot be approved before its exact private display is reviewed.');
    const image = manager.page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/media/photos/${prepared.photoId}/display`) && response.request().method() === 'GET');
    await view.click(); assert.equal((await image).status(), 200);
    const approval = waitPost(manager.page, '/community');
    await approve.click();
    assert.equal((await approval).status(), 200);
    const published = await community(spectator); assert(published.gallery.some(photo => photo.id === prepared.photoId));
    r.report.checks.push('A real Manager must fetch and review the exact private image before explicit approval adds it to the permitted gallery.');

    stage = 'Published Player photo appears in the actual Spectator album';
    const reopenedSpectator = await r.login('spectator'); await uploadAlbumForViewer(reopenedSpectator);
    const choice = reopenedSpectator.page.getByRole('button', { name: new RegExp(`^Open photo \\d+ · ${caption}$`) });
    const imageFetch = reopenedSpectator.page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/media/photos/${prepared.photoId}/display`) && response.request().method() === 'GET');
    await choice.click();
    const photoView = reopenedSpectator.page.getByTestId('album-photo-viewer'); await photoView.waitFor();
    const explicitView = photoView.getByRole('button', { name: /^(?:View authorised service image|View photo|Open photo)$/ });
    if (await explicitView.count()) await explicitView.click();
    assert.equal((await imageFetch).status(), 200);
    await reopenedSpectator.page.getByTestId(`media-photo-${prepared.photoId}`).waitFor();
    await reopenedSpectator.page.waitForFunction(photoId => {
      const element = document.querySelector(`[data-testid="media-photo-${photoId}"]`);
      return element && [...element.querySelectorAll('img'), ...(element.matches('img') ? [element] : [])].some(image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
    }, prepared.photoId);
    await r.screenshot('spectator-approved-player-photo', reopenedSpectator);
    r.report.checks.push('A newly opened actual Spectator album can fetch the approved image through the authenticated gateway.');

    stage = 'The Player can withdraw only an own unpublished submission';
    const reopenedPlayer = await r.login('player'); await r.openTab(reopenedPlayer, 'community');
    const refreshedOwn = await community(reopenedPlayer);
    const publishedOwn = refreshedOwn.submissions.find(photo => photo.id === prepared.photoId); assert.equal(publishedOwn.status, 'published');
    const publishedRow = reopenedPlayer.page.getByText(`${caption} · revision ${publishedOwn.version}`, { exact: true }).locator('..');
    assert.equal(await publishedRow.getByRole('button', { name: /^(?:Withdraw this service submission|Withdraw photo|Withdraw)$/ }).count(), 0, 'The UI must not offer withdrawal after publication because the server permits only pending/draft withdrawal.');
    const pendingOwn = refreshedOwn.submissions.find(photo => photo.id !== prepared.photoId && photo.status === 'pending');
    assert(pendingOwn, 'The normal authenticated fixture pipeline provides an own pending photo for the allowed withdrawal journey.');
    const ownRow = reopenedPlayer.page.getByText(`${pendingOwn.caption} · revision ${pendingOwn.version}`, { exact: true }).locator('..');
    const withdrawal = waitPost(reopenedPlayer.page, '/community');
    await ownRow.getByRole('button', { name: /^(?:Withdraw this service submission|Withdraw photo|Withdraw)$/ }).click();
    assert.equal((await withdrawal).status(), 200);
    assert.equal((await community(reopenedPlayer)).submissions.find(photo => photo.id === pendingOwn.id).status, 'withdrawn');
    assert((await community(spectator)).gallery.some(photo => photo.id === prepared.photoId), 'Withdrawing an unpublished submission must not alter the separate published photo.');
    r.report.checks.push('Player can explicitly withdraw an own pending photo; a published submission offers no invalid withdrawal and keeps the existing manager-removal policy.');

    stage = 'Manager removes the published photo and old gallery access is revoked';
    const removingManager = await r.login('manager'); await uploadAlbumForViewer(removingManager);
    await removingManager.page.getByTestId(`album-photo-${prepared.photoId}`).click();
    const removing = waitPost(removingManager.page, '/community');
    await removingManager.page.getByTestId('album-photo-viewer').getByRole('button', { name: /^(?:Remove this published service photo|Remove photo|Remove published photo)$/ }).click();
    assert.equal((await removing).status(), 200);
    assert(!(await community(spectator)).gallery.some(photo => photo.id === prepared.photoId));
    await r.api(`${r.scope(`media/photos/${prepared.photoId}/display`)}&mode=gallery&revision=${own.version}`, { state: spectator, expected: 404 });
    r.report.checks.push('An authorized Manager explicitly removes the published image; it leaves the permitted gallery and the same Spectator token can no longer fetch its former route. Existing screenshots or in-memory views are not claimed to be recalled.');
    r.report.photoLifecycle = { actualVerifiedSessionUsed: true, approvedFootballAssetUsed: true, pendingPrivate: true, secondImageNeedsReview: true, managerViewRequired: true, managerApprovalRequired: true, spectatorCanReadOnlyAfterApproval: true, playerCanWithdrawOwnPendingOnly: true, publishedWithdrawalNotOffered: true, managerRemovalRevokesFutureRead: true };
  }
  assert.equal(digest(await readFile(new URL(import.meta.url))), r.report.source.harnessSha256);
} catch (error) {
  failed = error;
  r.report.findings.push(`Failure at ${stage}: ${r.safe(error.message)}`);
} finally {
  clearTimeout(watchdog);
  const result = await r.finish({ passed: !failed, error: failed });
  console.log(JSON.stringify({ phase, passed: result?.passed, checks: result?.checks.length, failures: result?.failures, findings: result?.findings, output: r.output }));
  if (!result?.passed) process.exitCode = 1;
}

async function uploadAlbumForViewer(state) {
  await r.openTab(state, 'community'); await state.page.getByTestId('album-game-synthetic-history-hill').click();
}
