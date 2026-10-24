import { REVIEW_STATUS_REQUEST, openWorkspaceTab } from './review-entry.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { captureReviewArtifacts, assertReviewArtifactsUnchanged, assertReviewApiPortAvailable } from './review-artifacts.mjs';

// Real UI and isolated fictional HTTP API; only published service discovery is redirected locally.
const baseURL = process.env.LONGBALL_REVIEW_BASE_URL ?? 'http://127.0.0.1:4173';
const api = process.env.LONGBALL_REVIEW_API_URL ?? 'http://127.0.0.1:4358';
const apiEntry = process.env.LONGBALL_REVIEW_API_ENTRY ?? 'apps/api/dist/api.mjs';
const tunnel = 'https://longball-entry-review.trycloudflare.com';
const directory = process.env.LONGBALL_REVIEW_OUTPUT ?? '.local/account-entry-review';
const checks = [], errors = [];
await assertReviewApiPortAvailable(api);
const artifacts = await captureReviewArtifacts(baseURL, apiEntry);
await mkdir(directory, { recursive: true });
const id = Date.now();
const log = createWriteStream(`${directory}/${id}-api.log`);
const server = spawn(process.execPath, [apiEntry], { env: { ...process.env, NODE_ENV: 'development', LONGBALL_SYNTHETIC_AUTH: '1', LONGBALL_DATABASE_URL: '', LONGBALL_DATABASE_URL_FILE: '', LONGBALL_API_HOST: '127.0.0.1', LONGBALL_API_PORT: new URL(api).port, LONGBALL_API_DATABASE: `${directory}/${id}.sqlite`, LONGBALL_MEDIA_DIRECTORY: `${directory}/${id}-media`, LONGBALL_API_ORIGINS: new URL(baseURL).origin, LONGBALL_CLAMD_SOCKET: '', LONGBALL_CLAMD_HOST: '', LONGBALL_CLAMD_PORT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.pipe(log); server.stderr.pipe(log);
const browser = await chromium.launch({ executablePath: process.env.LONGBALL_CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
try {
  const deadline = Date.now() + 20_000;
  while (true) {
    try { assert.equal((await (await fetch(`${api}/health`)).json()).syntheticOnly, true); break; }
    catch (error) { if (Date.now() >= deadline || server.exitCode !== null) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  for (const width of [320, 390]) {
    for (const role of ['manager', 'administrator', 'player', 'spectator']) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      console.log(`Reviewing ${role} at ${width}px`);
      page.on('pageerror', error => errors.push(error.message));
      const requests = [];
      await context.route(REVIEW_STATUS_REQUEST, route => route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: { state: 'ready', url: tunnel, startedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), sourceRevision: 'a'.repeat(40) } }));
      await context.route(`${tunnel}/**`, async route => {
        const request = route.request();
        const path = request.url().slice(tunnel.length);
        requests.push({ method: request.method(), path, role: request.headers()['x-longball-role'] ?? null });
        const response = await route.fetch({ url: `${api}${path}` });
        await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': new URL(baseURL).origin } });
      });
      await page.goto(baseURL, { waitUntil: 'networkidle' });
      await page.getByTestId('welcome-review').waitFor();
      assert.equal(await page.getByTestId('prepare-match').count(), 0, 'Welcome must not mount the manager match');
      assert.deepEqual(await page.evaluate(() => indexedDB.databases()), [], 'Welcome must not open fictional recording storage');
      await page.getByTestId('welcome-review').click();
      for (const value of ['manager', 'administrator', 'player', 'spectator']) await page.getByTestId(`review-entry-${value}`).waitFor();
      await page.getByTestId(`review-entry-${role}`).click();
      await page.getByTestId('review-open-connected').click();
      await page.getByTestId('workspace-session').waitFor();
      await page.getByTestId('workspace-context-ready').waitFor();
      if (role === 'administrator') {
        await page.getByTestId('workspace-tab-clubs').waitFor();
        await openWorkspaceTab(page, 'people');
        await page.getByTestId('connected-staff').waitFor();
        assert.equal(await page.getByTestId('workspace-tab-controller').count(), 0);
        assert.equal(await page.getByTestId('workspace-tab-reports').count(), 0);
        assert(!requests.some(request => /\/(preparation|records|download)(?:\?|$)/.test(request.path)), 'Administrator entry loaded private team records');
      } else if (role === 'manager') {
        await page.getByTestId('workspace-tab-home').waitFor();
        await page.getByTestId('workspace-tab-schedule').click();
        await page.getByTestId('preparation-create-event').waitFor();
        assert.equal(await page.getByTestId('workspace-tab-people').count(), 0);
      } else {
        await page.getByTestId(role === 'player' ? 'workspace-player-home' : 'team-overview').waitFor();
        await openWorkspaceTab(page, 'centre');
        await page.getByTestId('workspace-match-centre').waitFor();
        assert.equal(await page.getByTestId('workspace-tab-controller').count(), 0);
        assert.equal(await page.getByTestId('workspace-tab-people').count(), 0);
        assert(!requests.some(request => /\/download(?:\?|$)/.test(request.path)), `${role} entry loaded a private match stream`);
      }
      const visibleCopy = await page.locator('body').innerText();
      assert(!/fictional|Player \d{2}/i.test(visibleCopy), `${role} still shows placeholder demo wording`);
      const footer = page.getByTestId('workspace-bottom-navigation');
      await footer.waitFor();
      const initialFooter = await footer.boundingBox();
      assert(initialFooter && initialFooter.y >= 724 && initialFooter.y + initialFooter.height <= 845, `${role} navigation must remain at the phone bottom`);
      await page.getByTestId('workspace-content-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
      const scrolledFooter = await footer.boundingBox();
      assert(scrolledFooter && Math.abs(scrolledFooter.y - initialFooter.y) < 1, `${role} navigation moved with its content`);
      await page.getByTestId('workspace-content-scroll').evaluate(element => { element.scrollTop = 0; });
      const layout = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth }));
      assert(layout.documentWidth <= layout.width, `${role} overflows ${width}px`);
      await page.screenshot({ path: `${directory}/${role}-${width}.png`, fullPage: true, animations: 'disabled' });
      checks.push({ role, width, passed: true, requests });
      await context.close();
    }
  }
  assert.deepEqual(errors, []);
  await assertReviewArtifactsUnchanged(artifacts, baseURL, apiEntry);
  await writeFile(`${directory}/report.json`, JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), artifacts, navigation: 'Bottom navigation stays visible while content scrolls in every role at320/390px', sampleCopy: 'No fictional or numbered-player labels in loaded role screens', serviceDiscovery: 'Pinned status and tunnel requests routed to isolated local fictional HTTP service; no production identity simulation', checks, runtimeErrors: errors }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, journeys: checks.length, widths: [320, 390], roles: ['manager', 'administrator', 'player', 'spectator'] }));
} catch (error) {
  await writeFile(`${directory}/failure.json`, JSON.stringify({ artifacts, checks, error: String(error), errors }, null, 2) + '\n');
  for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: `${directory}/failed.png`, fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  server.kill('SIGTERM');
  log.end();
}
