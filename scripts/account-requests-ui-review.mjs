import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { identityTrialAppUrl } from "./identity-trial-support.mjs";
const base = identityTrialAppUrl(),
  output = resolve(".local/identity/browser-review");
const fixture = JSON.parse(
  await readFile(".local/identity/trial/manager-fixture.json", "utf8"),
);
assert.equal(fixture.fictionalOnly, true);
assert.equal(
  fixture.issuer,
  "https://localhost:8443/realms/longball-fictional",
);
const checks = [],
  attempts = [],
  pageErrors = [];
const record = (description) => {
  checks.push(description);
  console.log(`PASS ${description}`);
};
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
    viewport: { width: 320, height: 760 },
  }),
  page = await context.newPage();
page.on("pageerror", () => pageErrors.push("Application page error"));
function totp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.replace(/\s|=/g, "").toUpperCase())
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const key = Buffer.from(
      (bits.match(/.{8}/g) ?? []).map((value) => parseInt(value, 2)),
    ),
    counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest(),
    offset = digest[19] & 15;
  return String(
    (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000,
  ).padStart(6, "0");
}
async function eventually(check, message, timeout = 25_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(message);
}
try {
  const certPage = await context.newPage(),
    discovery = await certPage.goto(
      `${fixture.issuer}/.well-known/openid-configuration`,
    );
  assert.equal(discovery.status(), 200);
  assert.equal(
    JSON.parse(await certPage.locator("body").innerText()).issuer,
    fixture.issuer,
  );
  await certPage.close();
  record(
    "Isolated Chromium trusts the exact local CA with normal certificate validation",
  );
  if (process.env.LONGBALL_IDENTITY_TRUST_ONLY === "1") {
    await browser.close();
    process.exit(0);
  }
  await page.goto(base, { waitUntil: "networkidle" });
  await page.getByTestId("welcome-sign-in").click();
  await page.getByTestId("prepare-oidc-signin").waitFor();
  await page.getByTestId("connection-settings-toggle").click();
  await page
    .getByLabel("OIDC issuer (HTTPS)", { exact: true })
    .fill(fixture.issuer);
  await page
    .getByLabel("Public client identifier", { exact: true })
    .fill(fixture.publicClientId);
  await page
    .getByLabel("LongBall API base URL (HTTPS)", { exact: true })
    .fill(fixture.apiBaseUrl);
  await page
    .getByLabel("Exact registered redirect URI", { exact: true })
    .fill(`${base}/`);
  await page.getByTestId("prepare-oidc-signin").click();
  await page.getByTestId("continue-oidc-signin").waitFor();
  const popupWait = context.waitForEvent("page");
  await page.getByTestId("continue-oidc-signin").click();
  const provider = await popupWait;
  await provider.waitForURL((url) => url.origin === "https://localhost:8443");
  await provider.locator("#username").fill(fixture.username);
  await provider.locator("#password").fill(fixture.password);
  await provider.locator("#kc-login").click();
  await provider.locator("#kc-totp-settings-form").waitFor();
  await provider.locator("#mode-manual").click();
  const secret = await provider.locator("#kc-totp-secret-key").innerText();
  await provider.locator('[name="totp"]').fill(totp(secret));
  await provider
    .locator('[name="userLabel"]')
    .fill("Isolated phone-width UI proof");
  await provider.locator("#saveTOTPBtn").click();
  await provider.locator("#kc-recovery-codes-list").waitFor();
  await provider.locator("#kcRecoveryCodesConfirmationCheck").check();
  await provider.locator("#saveRecoveryAuthnCodesBtn").click();
  await eventually(
    () => Promise.resolve(provider.isClosed()),
    "Real PKCE provider browser return did not finish",
  );
  await page.getByTestId("connected-account").waitFor();
  record(
    "Real provider password/TOTP setup and PKCE browser return establish the API-verified account without vault injection",
  );
  await page.getByTestId("connected-account").click();
  const statusRead = page.waitForResponse(
    (response) =>
      response.url().endsWith("/v1/privacy/requests") &&
      response.request().method() === "GET",
  );
  await page.getByTestId("open-account-requests").click();
  const snapshot = await (await statusRead).json(),
    screen = page.getByTestId("account-requests-screen");
  await screen.getByText("Choose a request", { exact: true }).waitFor();
  assert.ok(snapshot.memberships.length > 0);
  const knownKinds = snapshot.items
    .filter(
      (item) =>
        item.kind !== "leave_team" &&
        item.reviewStatus === "pending_verification_and_policy",
    )
    .map((item) => item.kind);
  const kind = !knownKinds.includes("export")
    ? "export"
    : !knownKinds.includes("delete_account")
      ? "delete_account"
      : null;
  assert.ok(
    kind,
    "Both global requests already exist; preserve their history and use another explicit fictional fixture for a new mutation proof",
  );
  await screen.getByTestId(`choose-account-${kind}`).click();
  const confirm = screen.getByTestId("confirm-account-request-scope");
  assert.match(
    await confirm.innerText(),
    /global account request covering all memberships/,
  );
  assert.equal(
    await screen.getByTestId("submit-account-request").isDisabled(),
    true,
  );
  record(
    "Global account request shows the own-membership list and requires explicit all-memberships confirmation",
  );
  let stage = "drop-before-write";
  await page.route("**/v1/privacy/requests", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    const body = JSON.parse(request.postData());
    attempts.push({ body, key: request.headers()["idempotency-key"] });
    if (stage === "drop-before-write") {
      stage = "retry-original";
      await route.abort("connectionreset");
      return;
    }
    if (stage === "drop-after-write") {
      stage = "resolved-from-status";
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      await response.body();
      await route.abort("connectionreset");
      return;
    }
    await route.continue();
  });
  await confirm.click();
  await screen.getByTestId("submit-account-request").click();
  await screen
    .getByText("Uncertain submission retained in this screen", { exact: true })
    .waitFor();
  assert.equal(
    await screen.getByTestId("retry-account-request").isDisabled(),
    true,
  );
  await screen.getByTestId("refresh-account-requests").click();
  await eventually(
    () => screen.getByText(/Fresh service status does not show/).isVisible(),
    "Missing-status retry state was not shown",
  );
  await confirm.click();
  await screen.getByTestId("retry-account-request").click();
  await eventually(
    () =>
      screen.getByText(/service confirms this request is recorded/).isVisible(),
    "Original retry did not show pending confirmation",
  );
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1], attempts[0]);
  assert.deepEqual(attempts[0].body, {
    kind,
    scope: "all_memberships",
    confirmAllMemberships: true,
  });
  record(
    "Phone-width UI blocks blind retry and reuses the exact original body/key after fresh status and renewed confirmation",
  );
  const choice = snapshot.memberships.find((item) => item.status === "active");
  assert.ok(choice);
  assert.equal(
    snapshot.items.some(
      (item) =>
        item.kind === "leave_team" &&
        item.scope?.teamId === choice.teamId &&
        item.scope?.seasonId === choice.seasonId &&
        item.reviewStatus === "pending_verification_and_policy",
    ),
    false,
    "An existing leave request must be preserved; use a fresh explicit fictional fixture",
  );
  await screen.getByTestId("choose-account-leave_team").click();
  await screen
    .getByRole("button", {
      name: `${choice.teamId} · ${choice.seasonId}`,
      exact: true,
    })
    .click();
  assert.match(await confirm.innerText(), /exact team and season request/);
  stage = "drop-after-write";
  await confirm.click();
  await screen.getByTestId("submit-account-request").click();
  await screen
    .getByText("Uncertain submission retained in this screen", { exact: true })
    .waitFor();
  const beforeRefresh = attempts.length;
  await screen.getByTestId("refresh-account-requests").click();
  await eventually(
    () =>
      screen.getByText(/service confirms this request is recorded/).isVisible(),
    "Lost committed leave response did not resolve from status",
  );
  assert.equal(attempts.length, beforeRefresh);
  assert.deepEqual(attempts.at(-1).body, {
    kind: "leave_team",
    teamId: choice.teamId,
    seasonId: choice.seasonId,
    confirmLeave: true,
  });
  record(
    "Selected team-season leave UI resolves a lost committed response from status without another POST",
  );
  assert.ok(
    await screen.getByText(/Nothing has been fulfilled or erased/).isVisible(),
  );
  assert.ok(
    await screen
      .getByText("Recorded request status", { exact: true })
      .isVisible(),
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
  );
  assert.deepEqual(pageErrors, []);
  await page.screenshot({
    path: resolve(output, "account-requests-320.png"),
    fullPage: true,
  });
  record(
    "320px request layout retains honest pending status without horizontal overflow or application page errors",
  );
  await writeFile(
    resolve(output, "evidence.json"),
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        actualBrowser: await browser.version(),
        width: 320,
        checks,
        actualOidcPkce: true,
        certificateValidationDisabled: false,
        privateVaultInjected: false,
        responseLossInjected: true,
        physicalDeviceTested: false,
        fulfilled: false,
        erased: false,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
