import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

/** Receives a freshly issued fictional PG invitation through stdin memory, never a file/env/URL argument. */
export async function reviewSpectatorActivationJourney({
  browser,
  fixture,
  invitationToken,
  teamId,
  seasonId,
  baseUrl = "http://localhost:4174",
  output = resolve(".local/identity/spectator-browser-review"),
}) {
  assert.ok(
    ["http://localhost:4174", "http://localhost:4175"].includes(baseUrl),
  );
  assert.equal(
    fixture.issuer,
    "https://localhost:8443/realms/longball-fictional",
  );
  assert.equal(fixture.apiBaseUrl, "https://localhost:8444");
  assert.match(invitationToken, /^[A-Za-z0-9_-]{43}$/);
  const context = await browser.newContext({
      viewport: { width: 320, height: 760 },
    }),
    page = await context.newPage(),
    checks = [],
    pageErrors = [];
  let stage = "trusted-browser-entry";
  const completionDiagnostics = { responseStatus: null, responseCode: null };
  const record = (description) => {
    checks.push(description);
    console.log(`PASS ${description}`);
  };
  page.on("pageerror", () => pageErrors.push("Application page error"));
  async function eventually(check, message, timeout = 30_000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (await check()) return;
      await new Promise((done) => setTimeout(done, 150));
    }
    throw new Error(message);
  }
  try {
    const trusted = await context.newPage();
    assert.equal(
      (
        await trusted.goto(`${fixture.issuer}/.well-known/openid-configuration`)
      ).status(),
      200,
    );
    await trusted.close();
    await page.goto(
      `${baseUrl}/#${new URLSearchParams({ longballInvite: "1", teamId, seasonId, code: invitationToken })}`,
      { waitUntil: "networkidle" },
    );
    // A received link stays on Welcome until its owner chooses sign-in or activation.
    await page.getByTestId("welcome-activate").click();
    await page
      .getByText("Received spectator invitation", { exact: true })
      .waitFor();
    await eventually(
      () => Promise.resolve(new URL(page.url()).hash === ""),
      "Invitation fragment was not removed",
    );
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
      .fill(`${baseUrl}/`);
    record(
      "Trusted 320px production-entry browser receives the invitation in memory, strips its address fragment and uses explicit configured issuer/API fields",
    );
    stage = "preaccount-provider-setup";
    const activationWait = page.waitForResponse(
      (response) =>
        response.url().endsWith("/v1/spectator-invites/activate") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", {
        name: "Create sign-in for this invitation",
        exact: true,
      })
      .click();
    const activationResponse = await activationWait;
    assert.equal(activationResponse.status(), 200);
    const activation = await activationResponse.json();
    assert.equal(
      activationResponse.request().headers().authorization,
      undefined,
    );
    await page.getByTestId("show-account-activation").click();
    assert.equal(
      await page
        .getByRole("button", {
          name: "Set credentials with identity provider",
          exact: true,
        })
        .isVisible(),
      false,
    );
    await page.getByTestId("show-account-activation").click();
    const popupWait = context.waitForEvent("page");
    await page
      .getByRole("button", {
        name: "Set credentials with identity provider",
        exact: true,
      })
      .click();
    const provider = await popupWait;
    await provider.locator("#kc-passwd-update-form").waitFor();
    assert.equal(new URL(provider.url()).hash, "");
    assert.equal(provider.url().includes(invitationToken), false);
    const password = randomBytes(32).toString("base64url");
    await provider.locator('[name="password-new"]').fill(password);
    await provider.locator('[name="password-confirm"]').fill(password);
    await provider
      .locator(
        '#kc-passwd-update-form button[type="submit"], #kc-passwd-update-form input[type="submit"]',
      )
      .click();
    await provider.locator("#kc-recovery-codes-list").waitFor();
    assert.ok(await provider.locator("#kc-recovery-codes-list li").count());
    await provider.locator("#kcRecoveryCodesConfirmationCheck").check();
    await provider.locator("#saveRecoveryAuthnCodesBtn").click();
    await provider
      .locator('#longball-activation-finish button[type="submit"]')
      .click();
    await eventually(
      async () =>
        new URL(provider.url()).hash.includes("completionProof=") ||
        (await provider.locator('a[href*="completionProof="]').count()) > 0,
      "Provider completion return did not appear",
    );
    let returnUrl = provider.url();
    if (!new URL(returnUrl).hash.includes("completionProof="))
      returnUrl = await provider
        .locator('a[href*="completionProof="]')
        .getAttribute("href");
    record(
      "Actual preaccount UI opens the configured provider and enters password/recovery setup there; the provider receives no original invitation capability",
    );
    stage = "completion-return-input";
    await page
      .getByLabel("Provider activation return link", { exact: true })
      .fill(returnUrl);
    stage = "completion-return-review";
    await page
      .getByRole("button", { name: "Review provider return link", exact: true })
      .click();
    const completeWait = page.waitForResponse(
      (response) =>
        response.url().endsWith("/v1/activation/complete") &&
        response.request().method() === "POST",
    );
    stage = "completion-verify-button";
    // Household's separate generic card has no ready completion; the exact retained invitation setup owns this action.
    await page
      .getByRole("button", { name: "Verify provider completion", exact: true })
      .click();
    const completionResponse = await completeWait;
    completionDiagnostics.responseStatus = completionResponse.status();
    stage = "completion-response";
    const completed = await completionResponse.json();
    if (
      typeof completed.code === "string" &&
      /^[A-Z][A-Z0-9_]{0,79}$/.test(completed.code)
    )
      completionDiagnostics.responseCode = completed.code;
    assert.equal(completionResponse.status(), 200);
    assert.equal(completed.status, "complete");
    assert.equal(completed.signInRequired, true);
    assert.equal(
      JSON.parse(completionResponse.request().postData()).token,
      invitationToken,
    );
    stage = "completion-success-notice";
    await page
      .getByText(
        "Account activation completed. Use secure sign-in, then explicitly review and accept this invitation in Community.",
        { exact: true },
      )
      .waitFor();
    await provider.close();
    record(
      "Real provider return is pasted through the shipped fallback UI and verified with its retained original token; completion alone creates no application session or grant",
    );
    stage = "fresh-pkce-signin";
    await page.getByTestId("prepare-oidc-signin").click();
    await page.getByTestId("continue-oidc-signin").waitFor();
    const authWait = context.waitForEvent("page"),
      meWait = page.waitForResponse(
        (response) =>
          response.url().endsWith("/v1/me") &&
          response.request().method() === "GET",
      );
    await page.getByTestId("continue-oidc-signin").click();
    const login = await authWait;
    await login.locator("#username").fill(activation.username);
    await login.locator("#password").fill(password);
    await login.locator("#kc-login").click();
    stage = "pkce-popup-return";
    await eventually(
      () => Promise.resolve(login.isClosed()),
      "Actual PKCE browser return did not finish",
    );
    stage = "pkce-api-identity";
    const meResponse = await meWait;
    assert.equal(meResponse.status(), 200);
    const me = await meResponse.json();
    assert.equal(me.principal.accountId, activation.accountId);
    assert.equal(me.principal.identityClassification, "unclassified");
    assert.equal(me.principal.adultVerified, false);
    assert.deepEqual(me.memberships, []);
    stage = "membership-free-invitation-navigation";
    await page
      .getByRole("button", {
        name: "Review received season invitation",
        exact: true,
      })
      .click();
    await page.getByTestId("connected-invitations").waitFor();
    record(
      "A separate real PKCE browser sign-in produces the API-verified unclassified account with no membership or adult authority before acceptance",
    );
    stage = "review-explicit-acceptance";
    const invitations = page.getByTestId("connected-invitations");
    const received = invitations.getByRole("button", {
      name: "Use received invitation",
      exact: true,
    });
    if (await received.count()) await received.click();
    else
      await invitations.getByTestId("invitation-token").fill(invitationToken);
    await invitations.getByTestId("invitation-inspect").click();
    stage = "review-inspected-destination";
    await invitations.getByText(`Team: ${teamId}`, { exact: true }).waitFor();
    assert.equal(
      await invitations.getByTestId("invitation-accept").isDisabled(),
      true,
    );
    await invitations
      .getByRole("switch", {
        name: "Confirm the service-reviewed invitation destination",
        exact: true,
      })
      .click();
    const acceptWait = page.waitForResponse(
      (response) =>
        response.url().endsWith("/v1/spectator-invites/accept") &&
        response.request().method() === "POST",
    );
    const grantedIdentityWait = page.waitForResponse(
      (response) =>
        response.url().endsWith("/v1/me") &&
        response.request().method() === "GET",
    );
    stage = "explicit-invitation-acceptance";
    await invitations.getByTestId("invitation-accept").click();
    const acceptResponse = await acceptWait;
    assert.equal(acceptResponse.status(), 200);
    const accepted = await acceptResponse.json();
    assert.equal(accepted.teamId, teamId);
    assert.equal(accepted.seasonId, seasonId);
    stage = "accepted-spectator-workspace";
    const grantedIdentityResponse = await grantedIdentityWait;
    assert.equal(grantedIdentityResponse.status(), 200);
    const grantedIdentity = await grantedIdentityResponse.json();
    assert.equal(grantedIdentity.principal.accountId, activation.accountId);
    assert.equal(
      grantedIdentity.principal.identityClassification,
      "unclassified",
    );
    assert.ok(
      grantedIdentity.memberships.some(
        (membership) =>
          membership.role === "spectator" &&
          membership.teamId === teamId &&
          membership.seasonId === seasonId,
      ),
    );
    await page.getByTestId("workspace-context-ready").waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      true,
    );
    assert.deepEqual(pageErrors, []);
    stage = "app-storage-secret-check";
    const completionProof = new URLSearchParams(
      new URL(returnUrl).hash.slice(1),
    ).get("completionProof");
    const accessToken = (
      await meResponse.request().allHeaders()
    ).authorization?.replace(/^Bearer /, "");
    assert.ok(accessToken && accessToken.length > 100);
    const persisted = await page.evaluate(
      async (secrets) => {
        const contains = (value) => {
          const text = JSON.stringify(value);
          return (
            typeof text === "string" &&
            secrets.some((secret) => text.includes(secret))
          );
        };
        for (const storage of [localStorage, sessionStorage])
          for (let i = 0; i < storage.length; i++)
            if (contains(storage.getItem(storage.key(i)))) return true;
        for (const info of await indexedDB.databases()) {
          if (!info.name) continue;
          const db = await new Promise((done, reject) => {
            const request = indexedDB.open(info.name);
            request.onsuccess = () => done(request.result);
            request.onerror = () => reject(new Error("Storage read failed"));
          });
          try {
            for (const name of Array.from(db.objectStoreNames)) {
              const rows = await new Promise((done, reject) => {
                const request = db
                  .transaction(name, "readonly")
                  .objectStore(name)
                  .getAll();
                request.onsuccess = () => done(request.result);
                request.onerror = () =>
                  reject(new Error("Storage read failed"));
              });
              if (contains(rows)) return true;
            }
          } finally {
            db.close();
          }
        }
        return false;
      },
      [invitationToken, completionProof, accessToken, password].filter(
        (value) => typeof value === "string" && value.length > 0,
      ),
    );
    assert.equal(persisted, false);
    record(
      "Read-only inspection finds none of the original invitation, provider proof, password or current bearer in this app origin's local/session storage or IndexedDB records",
    );
    record(
      "The unassigned account can inspect the actual destination and must explicitly confirm before the UI accepts only that team-season spectator grant at 320px",
    );
    await mkdir(output, { recursive: true });
    await page.screenshot({
      path: resolve(output, "spectator-activation-320.png"),
      fullPage: true,
    });
    const evidence = {
      verifiedAt: new Date().toISOString(),
      actualBrowser: await browser.version(),
      width: 320,
      checks,
      actualOidcPkce: true,
      actualProviderCredentialUi: true,
      providerReturnMode:
        "explicit shipped paste fallback for isolated provider callback",
      certificateValidationDisabled: false,
      privateVaultInjected: false,
      rawSecretWrittenByHarness: false,
      appStorageContainedTestSecrets: false,
      physicalDeviceTested: false,
      systemBrowserTested: false,
      adultAuthorityCreated: false,
      liveOnboardingApproved: false,
      productionProviderSelected: false,
    };
    await writeFile(
      resolve(output, "evidence.json"),
      JSON.stringify(evidence, null, 2),
    );
    return evidence;
  } catch (error) {
    await mkdir(output, { recursive: true });
    await writeFile(
      resolve(output, "failure.json"),
      JSON.stringify(
        {
          verifiedAt: new Date().toISOString(),
          stage,
          errorType: ["TimeoutError", "AssertionError", "Error"].includes(
            error?.name,
          )
            ? error.name
            : "Other",
          completedChecks: checks.length,
          pageErrorCount: pageErrors.length,
          completionDiagnostics,
          returnInputCount: await page
            .getByLabel("Provider activation return link", { exact: true })
            .count()
            .catch(() => null),
          verifyButtonCount: await page
            .getByRole("button", {
              name: "Verify provider completion",
              exact: true,
            })
            .count()
            .catch(() => null),
          privateDetailsSuppressed: true,
        },
        null,
        2,
      ),
    );
    throw new Error(
      `Spectator browser proof failed at ${stage}; private browser details suppressed.`,
    );
  } finally {
    await context.close();
  }
}

if (process.argv[1] === resolve(import.meta.filename)) {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 16_000)
      throw new Error("Bounded fictional browser input required.");
  }
  const browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    await reviewSpectatorActivationJourney({ ...JSON.parse(input), browser });
  } catch (error) {
    console.error(
      error instanceof Error &&
        error.message.startsWith("Spectator browser proof failed at ")
        ? error.message
        : "Spectator browser proof failed; private details suppressed.",
    );
    process.exitCode = 1;
  } finally {
    input = "";
    await browser.close();
  }
}
