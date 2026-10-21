import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Real UI and isolated fictional HTTP API; only published service discovery is redirected locally.
const baseURL = process.env.LONGBALL_REVIEW_BASE_URL ?? 'http://127.0.0.1:4173';
const api = 'http://127.0.0.1:4358';
const tunnel = 'https://longball-entry-review.trycloudflare.com';
const directory = '.local/account-entry-review';
const checks = [], errors = [];
await mkdir(directory, { recursive: true });
const id = Date.now();
const log = createWriteStream(`${directory}/${id}-api.log`);
const server = spawn(process.execPath, ['apps/api/dist/api.mjs'], { env: { ...process.env, NODE_ENV: 'development', LONGBALL_SYNTHETIC_AUTH: '1', LONGBALL_DATABASE_URL: '', LONGBALL_DATABASE_URL_FILE: '', LONGBALL_API_HOST: '127.0.0.1', LONGBALL_API_PORT: '4358', LONGBALL_API_DATABASE: `${directory}/${id}.sqlite`, LONGBALL_MEDIA_DIRECTORY: `${directory}/${id}-media`, LONGBALL_API_ORIGINS: new URL(baseURL).origin, LONGBALL_CLAMD_SOCKET: '', LONGBALL_CLAMD_HOST: '', LONGBALL_CLAMD_PORT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
      await context.route('https://raw.githubusercontent.com/CharlieOmniPoint/LongBall/preview/longball-m0/preview-status.json', route => route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: { state: 'ready', url: tunnel, startedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), sourceRevision: 'a'.repeat(40) } }));
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
        await page.getByTestId('workspace-tab-people').click();
        await page.getByTestId('connected-staff').waitFor();
        assert.equal(await page.getByTestId('workspace-tab-controller').count(), 0);
        assert.equal(await page.getByTestId('workspace-tab-reports').count(), 0);
        assert(!requests.some(request => /\/(preparation|records|download)(?:\?|$)/.test(request.path)), 'Administrator entry loaded private team records');
      } else if (role === 'manager') {
        await page.getByTestId('workspace-tab-home').waitFor();
        await page.getByTestId('workspace-tab-schedule').click();
        await page.getByTestId('preparation-create-event').waitFor();
        assert.equal(await page.getByRole('button', { name: 'People', exact: true }).count(), 0);
      } else {
        await page.getByTestId('workspace-tab-centre').waitFor();
        assert.equal(await page.getByTestId('workspace-tab-controller').count(), 0);
        assert.equal(await page.getByRole('button', { name: 'People', exact: true }).count(), 0);
        assert(!requests.some(request => /\/download(?:\?|$)/.test(request.path)), `${role} entry loaded a private match stream`);
      }
      const layout = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth }));
      assert(layout.documentWidth <= layout.width, `${role} overflows ${width}px`);
      await page.screenshot({ path: `${directory}/${role}-${width}.png`, fullPage: true, animations: 'disabled' });
      checks.push({ role, width, passed: true, requests });
      await context.close();
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(`${directory}/report.json`, JSON.stringify({ passed: true, serviceDiscovery: 'Pinned status and tunnel requests routed to isolated local fictional HTTP service; no production identity simulation', checks, runtimeErrors: errors }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, journeys: checks.length, widths: [320, 390], roles: ['manager', 'administrator', 'player', 'spectator'] }));
} catch (error) {
  for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: `${directory}/failed.png`, fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  server.kill('SIGTERM');
  log.end();
}
