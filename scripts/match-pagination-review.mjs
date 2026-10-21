import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { REVIEW_STATUS_REQUEST, enterFictionalReview, openWorkspaceTab } from './review-entry.mjs';

const baseURL = process.env.LONGBALL_REVIEW_BASE_URL ?? 'http://127.0.0.1:4390';
const api = process.env.LONGBALL_REVIEW_API_URL ?? 'http://127.0.0.1:4391';
const tunnel = 'https://longball-pagination-review.trycloudflare.com';
const runId = Date.now(), directory = path.resolve('.local/match-pagination/review');
await mkdir(directory, { recursive: true });
assert(['127.0.0.1', 'localhost'].includes(new URL(api).hostname));
try { await fetch(`${api}/health`); assert.fail('The explicitly selected pagination API port is occupied; preserve that listener.'); } catch (error) { if (error.code === 'ERR_ASSERTION') throw error; }
const log = createWriteStream(path.join(directory, `${runId}-api.log`));
const server = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/match-pagination-fixture.ts'], { env: { ...process.env, NODE_ENV: 'development', LONGBALL_PAGINATION_PORT: new URL(api).port, LONGBALL_PAGINATION_DATABASE: `.local/match-pagination/${runId}.sqlite`, LONGBALL_PAGINATION_ORIGIN: new URL(baseURL).origin }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.pipe(log); server.stderr.pipe(log);
let startupError; server.on('error', error => { startupError = error; });
const browser = await chromium.launch({ executablePath: process.env.LONGBALL_CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
page.setDefaultTimeout(25_000);
const errors = [], checks = [], pageRequests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { const url = new URL(request.url()); if (url.pathname.endsWith('/matches')) pageRequests.push({ path: url.pathname, cursor: url.searchParams.get('cursor'), limit: url.searchParams.get('limit') }); });
async function until(read, test) { const deadline = Date.now() + 25_000; do { const value = await read(); if (test(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < deadline); assert.fail('The scoped pagination review did not reach its expected state.'); }
try {
  await until(async () => { if (startupError || server.exitCode !== null) throw startupError ?? new Error(`Fixture API stopped ${server.exitCode}`); try { return await (await fetch(`${api}/health`)).json(); } catch { return null; } }, health => health?.syntheticOnly === true);
  const initial = await (await fetch(`${api}/v1/teams/synthetic-roma-u10/matches?seasonId=synthetic-season-2026-27&limit=100`, { headers: { Authorization: 'Bearer synthetic-manager-2', 'X-Longball-Role': 'manager' } })).json();
  assert.equal(initial.items.length, 100); assert(initial.nextCursor);
  await page.route(REVIEW_STATUS_REQUEST, route => route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: { state: 'ready', url: tunnel, startedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), sourceRevision: 'a'.repeat(40) } }));
  await page.route(`${tunnel}/**`, async route => { const response = await route.fetch({ url: api + route.request().url().slice(tunnel.length) }); await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': new URL(baseURL).origin } }); });
  await page.goto(baseURL, { waitUntil: 'networkidle' }); await enterFictionalReview(page, 'manager', 'connected');
  await page.getByTestId('workspace-context-ready').waitFor(); await openWorkspaceTab(page, 'centre');
  const cards = page.locator('[data-testid^="match-centre-game-"]');
  await until(() => cards.count(), count => count === 25);
  checks.push('The phone Match Centre initially renders the authorised default page of 25 service snapshots.');
  for (const count of [50, 75, 100, 108]) { await page.getByTestId('match-centre-load-more').click(); await until(() => cards.count(), value => value === count); }
  assert.equal(new Set(await cards.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid')))).size, 108);
  assert.equal(await page.getByTestId('match-centre-load-more').count(), 0);
  await page.getByTestId('match-centre-game-page-match-106').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(directory, 'match-beyond-first100.png'), animations: 'disabled' });
  checks.push('Four explicit Load more actions render 25 → 50 → 75 → 100 → 108 distinct matches, including the formerly undiscoverable 101st+ records; the final page has no continuation.');
  await page.getByRole('button', { name: 'Refresh accepted match updates', exact: true }).click();
  await until(() => cards.count(), count => count === 25);
  assert.equal(await page.getByTestId('match-centre-load-more').count(), 1);
  assert.equal(pageRequests.filter(request => request.cursor).length, 4);
  assert.deepEqual(errors, []);
  checks.push('Refresh replaces the accumulated list with a fresh authorised first page and its new continuation; no background full-collection fetch occurs.');
  const html = await (await fetch(baseURL)).text(), entry = /src="([^\"]*\/index-[^\"]+\.js)"/.exec(html)?.[1];
  const report = { status: 'passed', checkedAt: new Date().toISOString(), baseURL, api, checks, pageRequests, browserErrors: errors, web: { entry, sha256: createHash('sha256').update(Buffer.from(await (await fetch(new URL(entry, baseURL))).arrayBuffer())).digest('hex') }, method: 'Explicit fictional account, disposable 108-snapshot service fixture, transport-only discovery redirect, real UI continuation and HTTP; no browser business-state injection.', nativeDeviceEvidence: false };
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
} catch (error) { await page.screenshot({ path: path.join(directory, `${runId}-failed.png`), fullPage: true }).catch(() => {}); await writeFile(path.join(directory, `${runId}-failure.json`), JSON.stringify({ checks, errors, error: String(error) }, null, 2) + '\n'); throw error; }
finally { await browser.close(); server.kill('SIGTERM'); log.end(); }
