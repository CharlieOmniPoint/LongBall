import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { chromium } from 'playwright';
import { enterFictionalReview } from './review-entry.mjs';

const baseURL = process.env.LONGBALL_REVIEW_BASE_URL ?? 'http://127.0.0.1:4177';
const output = path.resolve(process.env.LONGBALL_REVIEW_OUTPUT_DIRECTORY ?? '.local/preparation-presentation');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.LONGBALL_CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
const results = [];
async function application(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const opened = indexedDB.open('longball-synthetic-m0');
    opened.onerror = () => reject(opened.error);
    opened.onsuccess = () => {
      const database = opened.result;
      const transaction = database.transaction('journal', 'readonly');
      const read = transaction.objectStore('journal').get('record');
      read.onsuccess = () => resolve(read.result?.projections?.['synthetic-longball-application-v1'] ?? null);
      read.onerror = () => reject(read.error);
      transaction.oncomplete = () => database.close();
    };
  }));
}
async function until(page, predicate, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = await application(page);
    if (state && predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(label);
}
const button = (page, name) => page.getByRole('button', { name, exact: true }).click({ noWaitAfter: true });
const radio = (page, name) => page.getByRole('radio', { name, exact: true }).click({ noWaitAfter: true });
try {
  for (const width of [320, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const errors = [], bundles = []; page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().includes('/_expo/static/js/web/') && request.url().endsWith('.js')) bundles.push(request.url()); });
    try {
      await page.goto(baseURL, { waitUntil: 'networkidle' });
      await enterFictionalReview(page);
      await page.getByTestId('prepare-match').waitFor();
      const original = await until(page, () => true, 'Initial application document');
      await button(page, 'Schedule');
      const dates = { past: '2026-10-19', upcoming: '2026-11-12' };
      for (const [period, date] of Object.entries(dates)) {
        await page.getByTestId('preparation-create-event').click();
        await page.getByLabel('Opposition', { exact: true }).fill(`${period} UI06 ${width}`);
        await page.getByLabel('Match date (YYYY-MM-DD)', { exact: true }).fill(date);
        await page.getByLabel('Kick-off (HH:MM, blank if not recorded)', { exact: true }).fill('');
        await page.getByLabel('Arrival (HH:MM, blank if not recorded)', { exact: true }).fill('');
        await page.getByTestId('preparation-save').click();
        await until(page, state => state.preparation.fixtures.some(fixture => fixture.opponent === `${period} UI06 ${width}`), 'Saved dated fixture');
      }
      await page.getByRole('button', { name: `Open fixture upcoming UI06 ${width}, ${dates.upcoming}`, exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: `Open fixture past UI06 ${width}, ${dates.past}`, exact: true }).count(), 0);
      await radio(page, 'Schedule period: Past');
      await page.getByRole('button', { name: `Open fixture past UI06 ${width}, ${dates.past}`, exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: `Open fixture upcoming UI06 ${width}, ${dates.upcoming}`, exact: true }).count(), 0);
      assert.match(await page.locator('body').innerText(), /Time not recorded/);
      await radio(page, 'Event type: Training');
      await page.getByTestId('preparation-create-event').click();
      await page.getByLabel('Training date (YYYY-MM-DD)', { exact: true }).fill(dates.past);
      await page.getByLabel('Training venue', { exact: true }).fill(`UI06 training ${width}`);
      await page.getByTestId('preparation-save').click();
      await until(page, state => state.preparation.training.some(training => training.venue === `UI06 training ${width}`), 'Saved past training');
      await page.getByRole('button', { name: `Open training ${dates.past}`, exact: true }).waitFor();

      await button(page, 'More'); await button(page, 'Team and season settings');
      await button(page, 'Create formation template');
      const format = width === 320 ? 11 : 5, name = `Touch UI11 ${width}`;
      await page.getByLabel('Formation name', { exact: true }).fill(name);
      await radio(page, `Formation pitch places: ${format}`);
      const beforeDraft = await application(page);
      await page.getByTestId('formation-position-cb-1').click();
      const surface = page.getByTestId('formation-placement-surface');
      const bounds = await surface.boundingBox(); assert(bounds && bounds.width > 48 && bounds.height > 72);
      await surface.click({ position: { x: bounds.width * 0.18, y: bounds.height * 0.3 }, noWaitAfter: true });
      const advanced = page.getByRole('button', {name:'Advanced position coordinates',exact:true});
      await advanced.scrollIntoViewIfNeeded();
      const advancedBounds = await advanced.boundingBox(); assert(advancedBounds);
      await page.mouse.click(advancedBounds.x + advancedBounds.width / 2, advancedBounds.y + advancedBounds.height / 2);
      await page.getByLabel('X for cb-1', {exact:true}).waitFor();
      const x = Number(await page.getByLabel('X for cb-1', { exact: true }).inputValue());
      const y = Number(await page.getByLabel('Y for cb-1', { exact: true }).inputValue());
      assert(x >= 0 && x <= 1 && y >= 0 && y <= 1);
      assert(Math.abs(x - (bounds.width * 0.18 - 24) / (bounds.width - 48)) < 0.02, JSON.stringify({x,y,bounds,expectedX:(bounds.width * 0.18 - 24) / (bounds.width - 48),expectedY:(bounds.height * 0.3 - 24) / (bounds.height - 72)}));
      assert(Math.abs(y - (bounds.height * 0.3 - 24) / (bounds.height - 72)) < 0.02);
      assert.equal((await application(page)).revision, beforeDraft.revision, 'Touch placement must remain an unsaved draft');
      await button(page, 'Show position list');
      const target = page.getByTestId('formation-position-cb-1');
      const targetBounds = await target.boundingBox(); assert(targetBounds && targetBounds.height >= 48);
      await target.click(); await button(page, 'Move selected slot right');
      const movedX = Number(await page.getByLabel('X for cb-1', { exact: true }).inputValue());
      assert(Math.abs(movedX - Math.min(1, x + 0.05)) < 0.00001);
      await page.getByTestId('preparation-save').click();
      const saved = await until(page, state => state.preparation.formations.some(formation => formation.name === name), 'Atomic formation save');
      const formation = saved.preparation.formations.find(value => value.name === name);
      assert.equal(formation.slots.length, format);
      assert.equal(formation.slots.filter(slot => slot.position === 'GK').length, 1);
      assert.equal(formation.slots.find(slot => slot.id === 'cb-1').position, 'CB');
      assert.equal(formation.slots.find(slot => slot.id === 'cb-1').x, movedX);
      assert.deepEqual(saved.preparation.snapshots, original.preparation.snapshots, 'Template edit must not alter any saved match snapshot');
      await page.reload({ waitUntil: 'networkidle' }); await enterFictionalReview(page);
      await page.getByTestId('prepare-match').waitFor();
      const reopened = await until(page, state => state.preparation.formations.some(value => value.name === name), 'Reopened saved formation');
      assert.deepEqual(reopened.preparation.formations.find(value => value.id === formation.id), formation);
      await button(page, 'Change demo account'); await page.getByTestId('review-entry-player').click(); await page.getByTestId('review-open-local').click();
      await button(page, 'Schedule'); await button(page, 'Past');
      assert.match(await page.locator('body').innerText(), new RegExp(`past UI06 ${width}`));
      assert.doesNotMatch(await page.locator('body').innerText(), new RegExp(`upcoming UI06 ${width}`));
      await button(page, 'Training');
      assert.match(await page.locator('body').innerText(), new RegExp(`UI06 training ${width}`));
      assert.equal(await page.getByTestId('preparation-create-event').count(), 0);
      assert.doesNotMatch(await page.locator('body').innerText(), /Noah Patel.*attendance/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: path.join(output, `ui06-ui11-${width}.png`), fullPage: true });
      results.push({ width, status: 'passed', bundles, checks: ['Manager upcoming/past match and training filters', 'Missing fixture time remains unknown', `${format}-slot tap placement remains draft then saves atomically`, '48px position-list and directional alternative', 'GK/CB slot identities and saved snapshots preserved', 'Reopen retains coordinates', 'Player own schedule period/type controls without manager actions'] });
    } catch (error) {
      await page.screenshot({ path: path.join(output, `ui06-ui11-${width}-failed.png`), fullPage: true }).catch(() => {});
      results.push({ width, status: 'failed', bundles, error: error.message, errors });
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
let artifact = null;
try {
  const html = await readFile(path.join(output, 'site/index.html'), 'utf8');
  const bundle = html.match(/src="([^"]*\/_expo\/static\/js\/web\/[^"]+\.js)"/)?.[1];
  if (bundle) artifact = { bundle, sha256: createHash('sha256').update(await readFile(path.join(output, 'site', bundle.replace(/^\//, '')))).digest('hex') };
} catch { /* The remote run may have no corresponding local export. */ }
await writeFile(path.join(output, 'report.json'), `${JSON.stringify({ baseURL, artifact, observedAt: new Date().toISOString(), results }, null, 2)}\n`);
console.log(JSON.stringify(results, null, 2));
if (results.some(result => result.status !== 'passed')) process.exitCode = 1;
