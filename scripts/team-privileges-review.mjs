import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { enterFictionalReview, openWorkspaceTab, selectWorkspaceContext } from './review-entry.mjs';

const directory = path.resolve('.local/sec17-browser');
const api = 'http://127.0.0.1:4380', web = 'http://127.0.0.1:4381';
const team = 'synthetic-roma-u10', season = 'synthetic-season-2026-27', account = 'synthetic-account-player-01';
const checks = [], pageErrors = [], children = [];
await mkdir(directory, { recursive: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function ready(url) { for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(url)).ok) return; } catch { /* Bounded local startup only. */ } await delay(100); } throw new Error('Isolated review service did not start.'); }
async function own() { const response = await fetch(`${api}/v1/teams/${team}/privileges/own?seasonId=${season}`, { headers: { Authorization: `Bearer ${account}`, 'X-Longball-Role': 'player' } }); assert.equal(response.status, 200); return response.json(); }
async function open(page, label) {
  await page.goto(web, { waitUntil: 'networkidle' }); await enterFictionalReview(page);
  await page.getByTestId('prepare-match').waitFor(); await page.getByRole('button', { name: 'More', exact: true }).click(); await page.getByRole('button', { name: 'Service and controller', exact: true }).click();
  await page.getByLabel('Workspace API URL', { exact: true }).fill(api);
  await page.getByRole('button', { name: 'Fictional API review', exact: true }).click(); await page.getByRole('button', { name: label, exact: true }).click(); await page.getByTestId('workspace-connect').click();
  await selectWorkspaceContext(page, label === 'Fictional Player 01' ? 'player' : 'manager');
}
async function decide(page, privilege, suspend) {
  await openWorkspaceTab(page, 'privileges'); await page.getByTestId('workspace-team-privileges').waitFor();
  await page.getByTestId(`privilege-${suspend ? 'suspend' : 'reinstate'}-${privilege}-${account}`).click();
  assert.equal(await page.getByTestId('privilege-confirm').isDisabled(), true);
  await page.getByTestId('privilege-reason-code').fill(suspend ? 'content_review' : 'review_complete');
  await page.getByTestId('privilege-confirm').click();
  await page.getByTestId(`privilege-${suspend ? 'reinstate' : 'suspend'}-${privilege}-${account}`).waitFor();
  assert.equal((await own())[privilege === 'uploads' ? 'uploadsAllowed' : 'invitationsAllowed'], !suspend);
}
async function refresh(page) {
  await openWorkspaceTab(page, 'more');
  const refreshed = page.waitForResponse(response => response.url().includes('/privileges/own?') && response.status() === 200);
  await page.getByRole('button', { name: 'Refresh service views', exact: true }).click(); await refreshed;
  await page.getByTestId('workspace-primary-navigation').waitFor();
}
let browser;
try {
  const source = new URL('../apps/api/src/server.ts', import.meta.url).href;
  const boot = `import {createApi} from ${JSON.stringify(source)};const app=createApi({databasePath:${JSON.stringify(path.join(directory, `service-${Date.now()}.sqlite`))},syntheticAuth:true,now:()=>1800000000000,allowedOrigins:[${JSON.stringify(web)}],publicAppEntryUrl:'https://example.invalid/LongBall/',invitationPolicyVersion:'explicit-fictional-review-policy'});app.server.listen(4380,'127.0.0.1');process.on('SIGTERM',()=>{void app.close().then(()=>process.exit(0))});`;
  children.push(spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', boot], { stdio: ['ignore', 'ignore', 'inherit'] }));
  children.push(spawn('python3', ['-m', 'http.server', '4381', '--bind', '127.0.0.1', '--directory', 'apps/mobile/dist-web-sec17'], { stdio: 'ignore' }));
  await ready(`${api}/health`); await ready(web);
  browser = await chromium.launch({ executablePath: process.env.LONGBALL_CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
  for (const width of [320, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
    const manager = await context.newPage(), player = await context.newPage();
    for (const page of [manager, player]) { page.setDefaultTimeout(20_000); page.on('pageerror', error => pageErrors.push(error.message)); }
    await open(manager, 'Fictional manager'); await decide(manager, 'uploads', true); await open(player, 'Fictional Player 01');
    await openWorkspaceTab(player, 'more'); assert.equal(await player.getByTestId('workspace-tab-privileges').count(), 0);
    await openWorkspaceTab(player, 'community'); await player.getByText('Photo contributions are currently held or awaiting a current privilege check.', { exact: false }).waitFor();
    assert.equal(await player.getByTestId('media-generated-image').isDisabled(), true);
    await player.screenshot({ path: path.join(directory, `player-uploads-held-${width}.png`), fullPage: true });
    await decide(manager, 'uploads', false); await refresh(player); await openWorkspaceTab(player, 'community');
    await player.getByText('Photo contributions are currently held or awaiting a current privilege check.', { exact: false }).waitFor({ state: 'hidden' });
    checks.push({ width, check: 'Reasoned manager upload suspension and explicit reinstatement reached current player status; no player moderation controls', passed: true });
    await decide(manager, 'invitations', true); await refresh(player); await openWorkspaceTab(player, 'invitations');
    await player.getByTestId('invitation-hours').fill('1');
    await player.getByText('Creating or reissuing invitations is currently held or awaiting a current privilege check.', { exact: false }).waitFor();
    assert.equal(await player.getByTestId('invitation-create').isDisabled(), true);
    await player.screenshot({ path: path.join(directory, `player-invitations-held-${width}.png`), fullPage: true });
    await decide(manager, 'invitations', false); await refresh(player); await openWorkspaceTab(player, 'invitations');
    await player.getByTestId('invitation-hours').fill('1'); await player.getByTestId('invitation-create').waitFor(); assert.equal(await player.getByTestId('invitation-create').isEnabled(), true);
    await manager.getByTestId(`privilege-suspend-invitations-${account}`).scrollIntoViewIfNeeded(); await manager.screenshot({ path: path.join(directory, `manager-privileges-${width}.png`), fullPage: true });
    for (const page of [manager, player]) { const sizes = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth })); assert.ok(sizes.scroll <= sizes.width + 1); }
    checks.push({ width, check: 'Invitation create held after explicit suspension and enabled after explicit reinstatement; phone layout has no horizontal overflow', passed: true });
    await context.close();
  }
  assert.deepEqual(pageErrors, []);
  const index = await readFile('apps/mobile/dist-web-sec17/index.html', 'utf8'), bundlePath = /src="([^"]+\.js)"/.exec(index)?.[1];
  const bundle = bundlePath ? await readFile(path.join('apps/mobile/dist-web-sec17', bundlePath.replace(/^\//, ''))) : null;
  await writeFile(path.join(directory, 'report.json'), JSON.stringify({ kind: 'fictional-sec17-phone-browser', observedAt: new Date().toISOString(), widths: [320, 390], checks, pageErrors, bundleSha256: bundle ? createHash('sha256').update(bundle).digest('hex') : null, limits: ['Synthetic SQLite browser review; restricted PostgreSQL behaviour is covered separately by actual HTTP tests.', 'No native device, real child data, real identity-provider or platform-wide safeguarding case proof.'] }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, widths: [320, 390], pageErrors: pageErrors.length }));
} finally { await browser?.close(); for (const child of children) child.kill('SIGTERM'); }
