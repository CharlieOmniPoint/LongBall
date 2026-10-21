import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

// Commands use real UI controls. Read-only API/browser storage checks establish
// authority and ensure invitation credentials were not persisted by the client.
const baseUrl = process.env.LONGBALL_REVIEW_BASE_URL ?? 'http://127.0.0.1:4173/';
const apiUrl = process.env.LONGBALL_REVIEW_API_URL ?? 'http://127.0.0.1:4349';
const output = path.resolve('.local/invitation-ui-review');
const teamId = 'synthetic-roma-u10', seasonId = 'synthetic-season-2026-27';
const errors = [];
let stage = 'startup';
const browser = await chromium.launch({ executablePath: process.env.LONGBALL_CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox'], headless: true });
await mkdir(output, { recursive: true });
const contexts = [];
const button = (page, name) => page.getByRole('button', { name, exact: true });
async function workspace(account, entry = baseUrl) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', () => errors.push('browser page error'));
  await page.goto(entry, { waitUntil: 'networkidle' });
  await page.getByTestId('prepare-match').waitFor({ timeout: 30000 });
  if (new URL(entry).hash) {
    await page.getByTestId('review-received-service-invitation').click();
    assert.equal(new URL(page.url()).hash, '', 'Received capability is removed from the browser address');
  } else {
    await button(page, 'More').click();
    await button(page, 'Service and controller').click();
  }
  await page.getByLabel('Workspace API URL', { exact: true }).fill(apiUrl);
  await button(page, 'Fictional API review').click();
  await button(page, account).click();
  await page.getByTestId('workspace-connect').click();
  await page.getByTestId('workspace-session').waitFor();
  await page.getByTestId('workspace-tab-invitations').click();
  await page.getByTestId('connected-invitations').waitFor();
  return page;
}
async function phoneWidths(page) {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `No horizontal overflow at ${width}px`);
  }
}
async function absentFromStorage(page, credential) {
  const found = await page.evaluate(async secret => {
    const values = [JSON.stringify(localStorage), JSON.stringify(sessionStorage)];
    for (const { name } of await indexedDB.databases()) {
      if (!name) continue;
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      for (const store of db.objectStoreNames) {
        const rows = await new Promise((resolve, reject) => { const r = db.transaction(store, 'readonly').objectStore(store).getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        values.push(JSON.stringify(rows));
      }
      db.close();
    }
    return values.some(value => value.includes(secret));
  }, credential);
  assert.equal(found, false, 'One-time invitation credential must stay out of browser persistence');
}
try {
  const issuer = await workspace('Fictional manager');
  stage = 'issuer issue and retained display';
  await issuer.getByTestId('invitation-hours').fill('24');
  const created = issuer.waitForResponse(response => response.request().method() === 'POST' && response.url() === `${apiUrl}/v1/teams/${teamId}/spectator-invites`);
  await issuer.getByTestId('invitation-create').click();
  const createdBody = await (await created).json();
  const disclosure = issuer.getByLabel('One-time spectator invitation link', { exact: true });
  await disclosure.waitFor();
  const firstUrl = new URL(await disclosure.innerText());
  const original = new URLSearchParams(firstUrl.hash.slice(1)).get('code');
  assert.match(original ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await issuer.getByLabel('Workspace API URL', { exact: true }).isEditable(), false);
  for (const name of ['Fictional Player 01', 'Connected sign-in']) assert.equal(await button(issuer, name).isDisabled(), true);
  assert.equal(await issuer.getByTestId('workspace-connect').isDisabled(), true);
  assert.equal(await issuer.getByTestId('workspace-tab-community').isDisabled(), true);
  await absentFromStorage(issuer, original);
  await phoneWidths(issuer);
  await issuer.getByTestId('invitation-close-link').click();
  stage = 'issuer explicit reissue';
  await issuer.getByTestId('invitation-hours').fill('24');
  const reissue = issuer.getByTestId(`invitation-reissue-${createdBody.id}`);
  await reissue.click();
  await issuer.getByTestId('invitation-confirm-change').click();
  await disclosure.waitFor();
  const replacementUrl = new URL(await disclosure.innerText());
  const replacement = new URLSearchParams(replacementUrl.hash.slice(1)).get('code');
  assert.match(replacement ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(replacement, original, 'Reissue replaces the capability');
  await absentFromStorage(issuer, replacement);
  await issuer.getByTestId('invitation-close-link').click();
  assert.equal(await issuer.getByLabel('Workspace API URL', { exact: true }).isEditable(), true);
  await issuer.screenshot({ path: path.join(output, 'issuer-closed.png'), animations: 'disabled' });

  const changedHints = new URLSearchParams(replacementUrl.hash.slice(1));
  changedHints.set('teamId', 'synthetic-untrusted-link-team');
  changedHints.set('seasonId', 'synthetic-untrusted-link-season');
  replacementUrl.hash = changedHints.toString();
  const recipient = await workspace('Fictional invite recipient', replacementUrl.href);
  stage = 'memberless recipient inspection';
  await recipient.getByText('No current team membership returned.', { exact: true }).waitFor();
  assert.equal(await recipient.getByTestId('invitation-create').count(), 0);
  assert.equal(await recipient.getByTestId('invitation-token').inputValue(), replacement, 'Received link is captured only in the open review');
  await recipient.getByTestId('invitation-token').fill(original);
  await recipient.getByTestId('invitation-inspect').click();
  await recipient.getByText('The invitation service request could not be completed. No credential was saved or logged.', { exact: true }).waitFor();
  assert.equal(await recipient.getByTestId('invitation-accept').count(), 0);
  await recipient.getByTestId('invitation-token').fill(replacement);
  stage = 'recipient explicit acceptance';
  await recipient.getByTestId('invitation-inspect').click();
  await recipient.getByText(`Team: ${teamId}`, { exact: true }).waitFor();
  assert.equal(await recipient.getByTestId('invitation-accept').isDisabled(), true);
  await recipient.getByLabel('Confirm the service-reviewed invitation destination', { exact: true }).click();
  await recipient.getByTestId('invitation-accept').click();
  await recipient.getByText(`spectator · ${teamId} · ${seasonId}`, { exact: true }).waitFor();
  await absentFromStorage(recipient, replacement);
  await phoneWidths(recipient);
  await recipient.screenshot({ path: path.join(output, 'recipient-accepted.png'), animations: 'disabled' });
  const me = await fetch(`${apiUrl}/v1/me`, { headers: { authorization: 'Bearer synthetic-account-invitee' } });
  assert.equal(me.status, 200);
  const identity = await me.json();
  assert(identity.memberships.some(item => item.teamId === teamId && item.seasonId === seasonId && item.role === 'spectator'));
  assert.equal(errors.length, 0);
  const report = { checkedAt: new Date().toISOString(), status: 'passed', baseUrl, apiUrl, fictionalOnly: true, widths: [320, 390], checks: ['UI issue with explicit lifetime', 'one-time display locks outer connection/account/tab controls', 'no capability persisted to browser storage', 'UI explicit reissue invalidates old capability', 'received link opens review and is removed from address', 'untrusted link hints never select authoritative team or season', 'memberless signed-in recipient cannot issue', 'server inspection before explicit acceptance', 'authoritative membership appears after acceptance', 'no horizontal overflow or page errors'], credentialValuesRecorded: false };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} catch (error) {
  // Do not dump page state or invitation URLs when an assertion fails.
  console.error(`${stage}: ${error instanceof Error ? error.message.replace(/[A-Za-z0-9_-]{43}/g, '[redacted]') : 'Invitation browser proof failed'}`);
  process.exitCode = 1;
} finally {
  await Promise.all(contexts.map(context => context.close()));
  await browser.close();
}
