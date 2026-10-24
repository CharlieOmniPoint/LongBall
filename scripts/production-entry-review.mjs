import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

const baseURL = process.env.LONGBALL_PRODUCTION_REVIEW_URL ?? 'http://127.0.0.1:4174';
const output = '.local/production-review';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.LONGBALL_CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await page.getByTestId('welcome-sign-in').waitFor();
  assert.equal(await page.getByTestId('welcome-review').count(), 0, 'Production Welcome must not offer fictional review.');
  const welcomeText = await page.locator('body').innerText();
  assert(!/Alex Morgan · Manager|Fictional Player|Manager A|Prepare match|synthetic-manager|Roma U10/.test(welcomeText), 'Fictional production entry leaked');
  assert.deepEqual(await page.evaluate(() => indexedDB.databases()), [], 'Anonymous production entry opened recording storage');
  await page.screenshot({ path: `${output}/welcome.png`, fullPage: true });
  await page.getByTestId('welcome-sign-in').click();
  await page.getByText('Sign-in & security', { exact: true }).waitFor();
  await page.getByTestId('prepare-oidc-signin').waitFor();
  assert.equal(await page.getByLabel('OIDC issuer (HTTPS)', { exact: true }).isVisible(), false, 'Provider configuration should stay inside advanced connection settings.');
  assert.deepEqual(await page.evaluate(() => indexedDB.databases()), [], 'Anonymous sign-in opened recording storage');
  const layout = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth }));
  assert(layout.documentWidth <= layout.width, 'Production sign-in overflows');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: `${output}/sign-in.png`, fullPage: true });
  const result = { passed: true, checks: ['Production Welcome has explicit sign-in and no fictional review choice', 'Fictional accounts/seed absent', 'Recording journal not opened at Welcome or anonymous sign-in', 'Welcome opens the account sign-in screen', 'Provider settings remain inside the advanced connection controls', '390px layout and no runtime errors'], layout };
  await writeFile(`${output}/report.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
