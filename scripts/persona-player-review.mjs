import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPersonaReview } from './persona-review-session.mjs';

const phase = process.env.LONGBALL_PERSONA_PHASE ?? 'baseline';
const revised = phase !== 'baseline';
const r = await createPersonaReview({ persona: 'player', name: 'player', phase });
const digest = value => createHash('sha256').update(value).digest('hex');
r.report.source.harnessSha256 = digest(await readFile(new URL(import.meta.url)));
let state, stage = 'Player sign in', failed;
const passed = label => { r.report.checks.push(label); console.log(JSON.stringify({ phase, completed: label })); };
const enhancement = (condition, finding) => { if (!condition) { r.report.findings.push(finding); if (revised) assert(condition, finding); } };
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const scope = leaf => r.scope(leaf);
async function fits(label) {
  await settle(state.page);
  const result = await state.page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert(result.scroll <= result.width + 2 && result.body <= result.width + 2, `${label} must fit its browser viewport.`);
}
async function viewport(label) {
  for (const [width, height] of [[320, 844], [390, 844], [1024, 768]]) {
    await state.page.setViewportSize({ width, height }); await fits(`${label} ${width}`);
    await r.screenshot(`${label}-${width}`, state);
  }
}
async function open(tab) { await r.budget(state); await r.openTab(state, tab); await settle(state.page); }
async function own() { return r.api(scope('preparation/own'), { state }); }

const watchdog = setTimeout(() => { void r.finish({ passed: false, error: new Error(`Player review exceeded its bounded eight-minute deadline at ${stage}.`) }).finally(() => { process.exitCode = 1; }); }, 480_000); watchdog.unref();
try {
  state = await r.login();
  const { page } = state;
  assert.match(await page.getByTestId('workspace-current-role').innerText(), /Player/);
  await page.getByTestId('workspace-player-home').waitFor();
  assert.equal(await page.getByTestId('workspace-tab-team').count(), 0, 'The primary Player navigation must not expose staff roster controls.');
  const source = await own();
  assert.equal(source.profile.playerId, 'synthetic-player-01');
  assert(!Object.hasOwn(source, 'profiles'), 'Own preparation must not carry the private staff roster.');
  const earlyStats = await page.getByTestId('workspace-tab-stats').boundingBox();
  assert(earlyStats && earlyStats.y + earlyStats.height <= 844, 'The fixed My Stats navigation must remain visible without scrolling the home feed.');
  await viewport('player-home');
  passed('Player signs in to the assigned Roma team; own preparation excludes peer profiles and the phone/tablet home fits.');

  stage = 'Player next-event reply';
  await page.setViewportSize({ width: 390, height: 844 });
  const reply = page.getByTestId('player-home-reply-unavailable');
  if (await reply.count()) {
    const write = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/preparation/own') && response.request().method() === 'POST');
    await reply.click(); assert.equal((await write).status(), 200);
    await page.getByText('Your reply: Unavailable', { exact: true }).waitFor();
    enhancement(await reply.getAttribute('aria-pressed') === 'true', 'The saved Home availability reply has no browser pressed state.');
    const replySaved = await own();
    assert([...replySaved.fixtures, ...replySaved.training].some(event => event.response === 'unavailable'), 'A confirmed reply must persist in the own-player API.');
    const restore = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/preparation/own') && response.request().method() === 'POST');
    await page.getByTestId('player-home-reply-available').click(); assert.equal((await restore).status(), 200);
    await page.getByText('Your reply: Available', { exact: true }).waitFor();
    passed('Home availability changes receive actual service acknowledgement and update the own-player view.');
  } else {
    r.report.findings.push('The current seed has no dated upcoming event that permits a Home reply; the empty/ordering state remains explicit.');
  }

  stage = 'Player schedule and calendar';
  await open('schedule'); await page.getByTestId('workspace-own-preparation').waitFor();
  await page.getByTestId('own-schedule-upcoming').click();
  await page.getByTestId('own-schedule-kind-match').click();
  const upcomingCards = page.locator('[data-testid^="player-fixture-"]');
  assert(await upcomingCards.count() > 0, 'The Roma fixture data must include upcoming games.');
  await page.getByTestId('calendar-export-open').click();
  const calendarOptions = page.locator('[data-testid^="calendar-event-"]');
  assert(await calendarOptions.count() > 0, 'Own upcoming events must be available for a calendar copy.');
  assert(await page.getByTestId('calendar-export-confirm').isDisabled(), 'A calendar export must not silently preselect events.');
  await calendarOptions.first().click();
  const downloading = page.waitForEvent('download');
  await page.getByTestId('calendar-export-confirm').click();
  const download = await downloading;
  assert.equal(download.suggestedFilename(), 'longball-calendar.ics');
  const calendar = await readFile(await download.path(), 'utf8');
  assert(calendar.startsWith('BEGIN:VCALENDAR\r\n') && calendar.endsWith('END:VCALENDAR\r\n'));
  assert.equal((calendar.match(/BEGIN:VEVENT/g) ?? []).length, 1, 'Only the explicitly selected own event is exported.');
  assert(!/ATTENDEE|ORGANIZER|VALARM|synthetic-player|FA\s*ID|preferences|attendance/i.test(calendar), 'A schedule copy must not export player identities, private preparation or unsolicited alarms.');
  r.report.calendarCoverage = { actualBrowserDownload: true, explicitlySelectedEvents: 1, noPrivatePlayerFields: true, nativeShareSheetTested: false };
  await page.getByRole('button', { name: 'Close calendar selection', exact: true }).click();
  await page.getByTestId('own-schedule-past').click();
  const past = page.locator('[data-testid^="player-fixture-"]');
  assert(await past.count() >= 2, 'The two historic fixtures must remain visible.');
  for (const card of await past.all()) assert.equal(await card.getByRole('button', { name: /^(Available|Unavailable|Unsure)$/ }).count(), 0, 'Past games must not offer availability changes.');
  await page.getByTestId('own-schedule-kind-training').click();
  const trainingText = await page.getByTestId('workspace-own-preparation').innerText();
  assert.match(trainingText, /training|Training/);
  enhancement(await page.getByRole('button', { name: /^(Available|Unavailable|Unsure)$/ }).count() === 0, 'Past training still exposes fresh availability controls.');
  await viewport('player-past-schedule');
  passed('Player can switch upcoming/past matches and training, download only a chosen calendar event, and past match replies are read-only.');

  stage = 'Player own profile and FA identifier';
  await open('team'); await page.getByTestId('own-preference-rank-0').waitFor();
  const beforeProfile = await own(), original = beforeProfile.profile.preferences;
  assert.equal(original.length, 3);
  await page.getByTestId('own-preference-rank-0').click();
  await page.getByTestId(`own-preference-position-${original[1]}`).click();
  const savePreferences = page.getByRole('button', { name: 'Save preferences', exact: true });
  enhancement(!await savePreferences.isDisabled(), 'Choosing the existing secondary as primary creates a duplicate draft and silently disables Save preferences.');
  if (revised) {
    assert.match(await page.getByTestId('own-preference-rank-1').innerText(), new RegExp(`Secondary · ${original[0]}`), 'Choosing an already ranked position must visibly swap the displaced position.');
    const saved = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/preparation/own') && response.request().method() === 'POST');
    await savePreferences.click(); assert.equal((await saved).status(), 200);
    assert.deepEqual((await own()).profile.preferences, [original[1], original[0], original[2]], 'The actual own preparation service must acknowledge the swapped preferences.');
    assert(await savePreferences.isDisabled(), 'An acknowledged unchanged preference draft must not offer another save.');
  }
  await page.getByTestId(`own-preference-position-${original[0]}`).click();
  if (revised) {
    const restored = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/preparation/own') && response.request().method() === 'POST');
    await savePreferences.click(); assert.equal((await restored).status(), 200);
    assert.deepEqual((await own()).profile.preferences, original, 'The Player can restore its original preference order through a second explicit save.');
  }
  const fa = page.getByTestId('fa-player-id'); await fa.fill('1234567890');
  const faWrite = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/preparation/own') && response.request().method() === 'POST');
  await page.getByTestId('fa-player-id-save').click(); assert.equal((await faWrite).status(), 200);
  assert.equal((await own()).profile.faPlayerId, '1234567890', 'The Player may update only their own FA identifier.');
  await viewport('player-profile');
  passed('Player profile exposes only its own membership/preferences, and an actual FA-ID save persists without a staff role.');

  stage = 'Player own My Stats';
  await open('stats'); await page.getByTestId('player-my-stats').waitFor();
  const stats = await r.api(scope('player-stats'), { state });
  assert.equal(stats.kind, 'own-player-stats'); assert.equal(stats.player.playerId, 'synthetic-player-01'); assert(!Object.hasOwn(stats, 'players'));
  assert.equal(await page.getByTestId(/^stats-player-detail-/).count(), 1);
  assert.equal(await page.getByTestId('team-player-stats').count(), 0);
  assert.equal(await page.locator('[data-testid^="stats-choose-"]').count(), 0, 'A Player must never receive teammate statistics selectors.');
  const about = page.getByTestId('player-stats-about-toggle');
  enhancement(await about.count() === 1, 'Own My Stats puts long scoring/coverage explanations ahead of the position breakdown instead of a compact disclosure.');
  if (await about.count()) {
    assert.equal(await about.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.getByTestId('player-stats-about-details').count(), 0);
    assert.match(await page.getByTestId('player-stats-coverage-summary').innerText(), /Missing information stays unknown/);
    await viewport('player-stats-compact');
    await about.click(); assert.equal(await about.getAttribute('aria-expanded'), 'true');
    assert.match(await page.getByTestId('player-stats-about-details').innerText(), /Playing-time entries/);
    await about.click(); assert.equal(await page.getByTestId('player-stats-about-details').count(), 0);
  } else await viewport('player-stats-current');
  passed('Player statistics have one bound player and no teammate selector; detail and unknown-data coverage remain own-only.');

  stage = 'Player team overview and game';
  await page.getByTestId('workspace-team-overview').click(); await page.getByTestId('team-overview').waitFor();
  await fits('Player team overview');
  await open('centre'); await page.getByTestId('workspace-match-centre').waitFor();
  assert.equal(await page.getByTestId('recording-acquire').count(), 0, 'Players must never acquire match control.');
  await viewport('player-match-centre');
  passed('Player can open team overview and shared game updates without match-controller controls.');

  stage = 'Player private feedback';
  await open('feedback'); await page.getByTestId('match-feedback').waitFor();
  const feedback = await r.api(scope('match-feedback'), { state });
  assert.equal(feedback.audience, 'player'); assert.equal(feedback.playerId, 'synthetic-player-01');
  assert(feedback.matches.every(match => !Object.hasOwn(match, 'entries')), 'Own feedback must not contain peer entries.');
  for (const match of feedback.matches.filter(match => match.status === 'closed')) assert.equal(await page.getByTestId(`match-feedback-${match.matchId}`).getByTestId('match-feedback-review').count(), 0);
  await viewport('player-feedback');
  r.report.feedbackCoverage = { closedHistoryReadOnly: true, peerEntriesExcluded: true, openWindowPresent: feedback.matches.some(match => match.status === 'open' && match.canEdit) };
  if (!r.report.feedbackCoverage.openWindowPresent) r.report.findings.push('Current seed correctly has no eligible same-day completed game: open feedback editing needs a separately labelled reducer-completed fixture; closed history/privacy are exercised here.');
  passed('Player feedback is own-only and closed historic games do not display editors.');

  stage = 'Player opposition and records';
  await open('opposition'); await fits('Player opposition notes');
  const opposition = await r.api(scope('opposition-reviews'), { state });
  assert.equal(opposition.kind, 'opposition-reviews');
  assert.equal(opposition.canEdit, false, 'Player opposition notes must remain read-only.');
  await open('reports'); await fits('Player reports');
  passed('Player can read permitted team/opposition summaries and its own reports without staff controls.');

  stage = 'Player photos and awards';
  await open('community');
  await page.getByTestId('connected-albums').or(page.getByText('Game albums', { exact: true })).first().waitFor();
  const community = await r.api(scope('community'), { state });
  assert.equal(community.allowed, true);
  assert.deepEqual(community.reviewQueue, [], 'The Player API must not disclose other players’ pending photo reviews.');
  assert.deepEqual(community.reviewConcerns, [], 'The Player API must not disclose staff concern-review records.');
  assert.deepEqual(community.grants, [], 'The Player API must not disclose the team’s private spectator grant directory.');
  assert.equal(await page.getByRole('button', { name: /Approve this exact service photo revision/ }).count(), 0, 'A Player must not receive publication review controls.');
  await viewport('player-photos');
  if (revised) {
    await page.getByTestId('community-section-awards').click();
    await page.getByTestId('community-awards').waitFor();
    assert.equal(await page.getByTestId('connected-albums').count(), 0, 'Awards and photo browsing must have separate deliberate views.');
    assert.equal(await page.getByTestId('media-upload-image').count(), 0, 'An awards view must not also show photo upload controls.');
  } else {
    const awardTab = page.getByRole('button', { name: /^(?:Players. award|Player of the match|Awards)$/ });
    if (await awardTab.count()) await awardTab.first().click();
  }
  r.report.awardCoverage = { permittedMatches: community.matches.length, openBallotPresent: community.matches.some(match => match.mayVote), pendingPhotoPublicationDeniedByRole: true };
  if (!r.report.awardCoverage.openBallotPresent) r.report.findings.push('Current completed seed games have closed ballots; no voting window is invented for this review.');
  passed('Player photos show only permitted albums, and no staff moderation controls are exposed; ballot window metadata remains explicit.');

  stage = 'Player spectator invitation and account';
  await open('invitations'); await page.getByTestId('connected-invitations').waitFor();
  assert(await page.getByTestId('invitation-create').count() > 0, 'Player has its agreed spectator invitation route.');
  await fits('Player spectator invitation form');
  // No live invitation capability is created, photographed or retained in this audit.
  await open('account'); await fits('Player account');
  if (revised) {
    await page.getByTestId('workspace-account-panel').waitFor();
    await page.getByTestId('account-section-help').click();
    assert.match(await page.getByTestId('account-help').innerText(), /only you and your Managers can see your feedback/);
    await page.getByTestId('account-section-privacy').click();
    const privacy = await page.getByTestId('account-privacy').innerText();
    assert.match(privacy, /pending review/); assert.match(privacy, /does not export or erase data or remove team access/);
    await page.getByTestId('account-section-requests').click();
    await page.getByTestId('account-requests-screen').waitFor();
    await page.getByText(/This is a shared household\/player account/).waitFor();
    assert.match(await page.getByTestId('account-requests-screen').innerText(), /shared household\/player account/);
    await page.getByTestId('choose-account-export').click();
    assert(await page.getByTestId('submit-account-request').isDisabled(), 'A data request cannot be submitted without an explicit scope confirmation.');
    await fits('Player account request intake');
    await page.getByTestId('account-section-summary').click();
    r.report.accountCoverage = { roleSpecificHelp: true, pendingPolicyExplained: true, ownSharedAccountRequestsReadable: true, noRequestSubmittedOrPolicyApproved: true };
  }
  await r.screenshot('player-account', state);
  passed('Player can reach scoped spectator invitations and account controls; no invitation capability is captured.');

  stage = 'Player sign out';
  const logout = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/demo/sessions/current' && response.request().method() === 'DELETE');
  await page.getByTestId('demo-sign-out').click(); assert.equal((await logout).status(), 204);
  await page.getByTestId('demo-login-screen').waitFor();
  assert.equal(await page.getByTestId('workspace-player-home').count(), 0);
  assert.equal(await page.getByTestId('player-my-stats').count(), 0);
  passed('Player sign out ends the actual session and closes private home/stat views.');
  if (revised) {
    stage = 'A prospective Player requests a scoped invitation without acquiring access';
    await page.getByTestId('demo-request-invite').click();
    const intake = page.getByTestId('invite-request-entry'); await intake.waitFor();
    await intake.getByLabel('Search clubs', { exact: true }).fill('Richmond');
    await intake.getByRole('button', { name: 'Richmond Rovers', exact: true }).click();
    await intake.getByLabel('Search teams or age groups', { exact: true }).fill('Roma');
    await intake.getByRole('button', { name: /^Roma U10 · / }).click();
    await intake.getByRole('button', { name: 'Player', exact: true }).click();
    await intake.getByLabel('Name for invitation request', { exact: true }).fill('Prospective Player Review');
    await intake.getByLabel('Invitation request contact email', { exact: true }).fill('player-review@example.invalid');
    const receiving = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/spectator-access/requests' && response.request().method() === 'POST');
    await page.getByTestId('submit-invite-request').click();
    const received = await receiving; assert.equal(received.status(), 202);
    assert(!Object.hasOwn(await received.json(), 'accessToken'), 'An invitation request must not create a session or self-authorize a child account.');
    await intake.getByText(/No account or team access has been created yet/).waitFor();
    await r.api('/v1/me', { state, token: null, expected: 401 });
    assert.equal(await page.getByTestId('demo-signed-in').count(), 0);
    const staff = await r.login('manager');
    const requests = await r.api(scope('invite-requests'), { state: staff });
    const request = requests.find(item => item.name === 'Prospective Player Review');
    assert(request && request.requestedRole === 'player' && request.status === 'pending' && request.teamId === r.teamId && request.seasonId === r.seasonId, 'Actual assigned team staff must receive the scoped request for review.');
    r.report.invitationRequestCoverage = { actualPublicIntake: true, requestedRole: 'player', staffReviewPending: true, noAccountOrTeamAccessCreated: true, actualChildActivationTested: false, guardianRecoveryPolicyApproved: false };
    passed('A prospective Player can request the exact club/team; staff receive a pending request without a new login, membership or child-account approval.');
  }
  assert.equal(digest(await readFile(new URL(import.meta.url))), r.report.source.harnessSha256, 'The persona harness must remain unchanged during a run.');
} catch (error) {
  failed = error;
  r.report.findings.push(`Failure at ${stage}: ${r.safe(error.message)}`);
  if (state && await state.page.getByTestId('demo-signed-in').isVisible().catch(() => false)) await r.screenshot('player-failure', state).catch(() => {});
} finally {
  clearTimeout(watchdog);
  const result = await r.finish({ passed: !failed, error: failed });
  console.log(JSON.stringify({ passed: result?.passed, phase, checks: result?.checks.length, findings: result?.findings, failures: result?.failures.length, output: r.output }));
  if (!result?.passed) process.exitCode = 1;
}
