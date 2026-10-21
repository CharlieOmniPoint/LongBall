import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { enterFictionalReview } from './review-entry.mjs';
const baseURL = process.env.LONGBALL_REVIEW_BASE_URL ?? 'http://127.0.0.1:4388';
const output = process.env.LONGBALL_REVIEW_OUTPUT_DIRECTORY ?? '.local/match-plans-review'; await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.LONGBALL_CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
async function journal(page) { return page.evaluate(() => new Promise((resolve, reject) => { const opening = indexedDB.open('longball-synthetic-m0'); opening.onerror = () => reject(opening.error); opening.onsuccess = () => { const db = opening.result, transaction = db.transaction('journal', 'readonly'), read = transaction.objectStore('journal').get('record'); read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); transaction.oncomplete = () => db.close(); }; })); }
const application = async page => (await journal(page))?.projections?.['synthetic-longball-application-v1'];
async function until(page, predicate, message) { const deadline = Date.now() + 20_000; while (Date.now() < deadline) { const app = await application(page); if (app && predicate(app)) return app; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(message); }
const click = (page, name) => page.getByRole('button', { name, exact: true }).click();
const results = [];
try {
  for (const width of [320, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: 'reduce' }), page = await context.newPage(), errors = [];
    page.setDefaultTimeout(20_000); page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(baseURL, { waitUntil: 'networkidle' }); await enterFictionalReview(page); await page.getByTestId('prepare-match').waitFor();
      await click(page, 'Schedule'); await click(page, 'Open fixture Maple FC, 2026-10-24');
      await click(page, 'Save a reusable match plan from this fixture'); await click(page, 'Save preparation for match-plan review');
      let app = await until(page, value => value.preparation.snapshots.length > 0, 'Source preparation saved'); const snapshot = structuredClone(app.preparation.snapshots.at(-1)), originalSnapshots = structuredClone(app.preparation.snapshots);
      await page.getByLabel('Reusable plan name', { exact: true }).fill(`Phone template ${width}`);
      await page.getByLabel('Reusable plan description (optional, no sensitive details)', { exact: true }).fill('Explicit reviewed opening');
      const used = new Set();
      for (const slot of snapshot.formation.slots) {
        const profile = snapshot.profiles.find(person => !used.has(person.playerId) && person.eligiblePositions.includes(slot.position) && (slot.position !== 'GK' || person.preferences.slice(0, 2).includes('GK'))); assert(profile); used.add(profile.playerId);
        await click(page, `${slot.label} · Choose player`); await click(page, `Plan ${profile.displayName}`);
      }
      await click(page, 'Plan return No'); await page.getByTestId('save-reusable-match-plan').click();
      app = await until(page, value => value.preparation.matchPlans?.length === 1, 'Reusable plan saved'); const plan = structuredClone(app.preparation.matchPlans[0]); assert.deepEqual(app.preparation.snapshots, originalSnapshots);
      await click(page, 'Back to schedule'); await page.getByTestId('preparation-create-event').click();
      await page.getByLabel('Opposition', { exact: true }).fill(`Template target ${width}`); await page.getByLabel('Match date (YYYY-MM-DD)', { exact: true }).fill('2026-11-14'); await page.getByTestId('preparation-save').click();
      app = await until(page, value => value.preparation.fixtures.some(row => row.opponent === `Template target ${width}`), 'Destination fixture saved'); const destination = app.preparation.fixtures.find(row => row.opponent === `Template target ${width}`);
      await click(page, `Open fixture Template target ${width}, 2026-11-14`);
      for (const profile of snapshot.profiles) { await page.getByRole('switch', { name: `Select ${profile.displayName}`, exact: true }).click(); await until(page, value => value.preparation.fixtures.find(row => row.id === destination.id).selectedProfileIds.includes(profile.id), 'Destination explicit selection saved'); }
      app = await application(page); const beforeTarget = structuredClone(app.preparation.fixtures.find(row => row.id === destination.id));
      await click(page, `Preview Phone template ${width} for this fixture`); await page.getByTestId('match-plan-apply-preview').waitFor();
      assert.equal((await application(page)).preparation.fixtures.find(row => row.id === destination.id).matchPlanDraft, undefined, 'Preview cannot apply the plan');
      await page.screenshot({ path: `${output}/preview-${width}.png`, fullPage: false }); await page.getByTestId('confirm-apply-match-plan').click();
      app = await until(page, value => value.preparation.fixtures.find(row => row.id === destination.id).matchPlanDraft, 'Explicit plan apply saved');
      const applied = app.preparation.fixtures.find(row => row.id === destination.id); assert.deepEqual(applied.responses, beforeTarget.responses); assert.deepEqual(applied.attendance, beforeTarget.attendance); assert.deepEqual(applied.selectedProfileIds, beforeTarget.selectedProfileIds); assert.deepEqual(app.preparation.snapshots, originalSnapshots); assert.deepEqual(applied.matchPlanDraft.allocations, plan.allocations);
      await page.getByTestId('preparation-open-match').click(); await page.getByRole('heading', { name: 'Who’s here?', exact: true }).waitFor();
      let saved = await journal(page), match = saved.projections[destination.id]; match = match?.state ?? match; assert(match); assert.deepEqual(match.stagedLineup, []); assert(Object.values(match.attendance).every(value => value === 'not_recorded')); assert.deepEqual(match.config.initialLineupProposal, plan.allocations); assert.deepEqual(match.config.initialPolicyProposal, plan.settings);
      for (const row of plan.allocations) { const name = snapshot.profiles.find(profile => profile.playerId === row.playerId).displayName; await page.getByRole('radio', { name: `${name}, Present`, exact: true }).click(); await page.waitForTimeout(80); }
      await page.getByTestId('continue-lineup').click(); await click(page, 'Stage reviewed match-plan lineup');
      await page.waitForFunction(id => new Promise(resolve => { const opening = indexedDB.open('longball-synthetic-m0'); opening.onsuccess = () => { const db = opening.result, tx = db.transaction('journal', 'readonly'), read = tx.objectStore('journal').get('record'); read.onsuccess = () => { const stored = read.result?.projections?.[id], value = stored?.state ?? stored; resolve(value?.stagedLineup?.length === 7); }; tx.oncomplete = () => db.close(); }; }), destination.id);
      saved = await journal(page); match = saved.projections[destination.id]; match = match?.state ?? match; assert.deepEqual(match.stagedLineup, plan.allocations); assert.equal(match.status, 'preparation'); assert.equal(match.matchActiveMs, 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); assert.deepEqual(errors, []); await page.screenshot({ path: `${output}/staged-${width}.png`, fullPage: false });
      await page.reload({ waitUntil: 'networkidle' }); await enterFictionalReview(page); await page.getByTestId('prepare-match').waitFor(); app = await application(page); assert.deepEqual(app.preparation.matchPlans[0], plan); assert.deepEqual(app.preparation.snapshots[0], originalSnapshots[0]);
      results.push({ width, passed: true, checks: ['Explicit source snapshot and saved seven-place plan', 'Preview has no write', 'Confirmed copy preserves selection, replies, check-in and source snapshots', 'Prepared config contains inactive policy/lineup proposals', 'Actual check-in precedes explicit staging, clock stays stopped', 'Reload preserves template/source snapshot', 'No overflow/page errors'] });
    } catch (error) { await page.screenshot({ path: `${output}/failure-${width}.png`, fullPage: false }); throw error; } finally { await context.close(); }
  }
  await writeFile(`${output}/report.json`, `${JSON.stringify({ passed: true, baseURL, results }, null, 2)}\n`); console.log(JSON.stringify({ passed: true, results }));
} finally { await browser.close(); }
