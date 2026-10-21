import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installStartupDiagnostics, captureStartupDiagnostics } from './browser-startup-diagnostics.mjs';

const directory = path.resolve('.local/bootstrap-review');
await mkdir(directory, { recursive: true });
const baseURL = process.env.LONGBALL_REVIEW_BASE_URL ?? 'http://127.0.0.1:4173';
const browser = await chromium.launch({ executablePath: existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined, headless: true, args: ['--no-sandbox'] });
const results = [];
try {
  for (let index = 1; index <= 20; index += 1) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const observations = await installStartupDiagnostics(page);
    const started = Date.now();
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    try {
      await page.getByTestId('prepare-match').waitFor({ timeout: 12_000 });
      results.push({ index, status: 'passed', durationMs: Date.now() - started });
      console.log(`PASSED bootstrap ${index}`);
    } catch (error) {
      const label = `cold-${index}`;
      await page.screenshot({ path: path.join(directory, `${label}.png`) });
      const diagnosis = await captureStartupDiagnostics(page, label, directory, observations);
      results.push({ index, status: 'failed', error: error.message, diagnosis });
      console.error(`FAILED bootstrap ${index}; read-only diagnostics retained`);
      // Keep this exact context/document unchanged for a second observation; no reload or reseed.
      await page.waitForTimeout(5000);
      await captureStartupDiagnostics(page, `${label}-later`, directory, observations);
      break;
    } finally { await context.close(); }
  }
} finally {
  await browser.close();
  await writeFile(path.join(directory, 'results.json'), `${JSON.stringify({ baseURL, results }, null, 2)}\n`);
}
assert(results.every(item => item.status === 'passed'), 'A cold startup stalled; inspect read-only diagnostic evidence.');
