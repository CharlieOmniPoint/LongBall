import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { createKeycloakActivationProvider } from "../apps/api/src/keycloak-activation-provider.ts";
import { createOidcVerifier } from "../apps/api/src/oidc.ts";
import {
  createAccountRequestsClient,
  accountRequestConfirmation,
} from "../apps/mobile/src/platform/account-requests-core.ts";
import {
  configureTrial,
  bootstrapToken,
  trialDirectory,
  trialJson,
  identityTrialAppUrl,
} from "./identity-trial-support.mjs";
import { resolve } from "node:path";

// Real Keycloak HTTPS requests with normal Node CA validation. Chromium is an offline
// DOM parser only: no browser trust/system-browser/physical-device proof is asserted.
const { config, headers, adminBase } = await configureTrial();
const apiProof = process.env.LONGBALL_IDENTITY_TRIAL_API_PROOF === "1";
const schemaSmoke = process.env.LONGBALL_IDENTITY_TRIAL_SCHEMA_SMOKE === "1";
const spectatorProof =
  process.env.LONGBALL_IDENTITY_TRIAL_SPECTATOR_PROOF === "1";
if (spectatorProof && !apiProof)
  throw new Error("Spectator proof requires the real configured API journey");
if (schemaSmoke && !apiProof)
  throw new Error("Schema smoke requires the actual configured API journey");
const spectatorUiOnly =
  process.env.LONGBALL_IDENTITY_TRIAL_SPECTATOR_UI_ONLY === "1";
const appBaseUrl = identityTrialAppUrl();
if (spectatorUiOnly && (!apiProof || !schemaSmoke || !spectatorProof))
  throw new Error(
    "UI-only proof requires the configured schema/API/spectator trial flags",
  );
const checks = [];
const record = (description) => {
  checks.push(description);
  console.log(`PASS ${description}`);
};
const browser = await chromium.launch({
  executablePath: process.env.LONGBALL_CHROMIUM_PATH ?? "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
const provider = createKeycloakActivationProvider({
  issuer: config.issuer,
  serviceClientId: config.serviceClientId,
  serviceClientSecret: async () => config.serviceClientSecret,
  publicClientId: config.publicClientId,
  completionRedirectUri: config.completionRedirectUri,
});
class ProtocolSession {
  cookies = new Map();
  url = null;
  callback = null;
  async initialize() {
    this.page = await browser.newPage();
    await this.page.route("**/*", (route) => route.abort());
    return this;
  }
  async visit(url, init = {}) {
    for (let attempt = 0; attempt < 15; attempt++) {
      const parsed = new URL(url);
      if (
        ["/activation/callback", "/oidc/callback"].includes(parsed.pathname)
      ) {
        this.callback = parsed;
        return;
      }
      assert.equal(
        parsed.origin,
        "https://localhost:8443",
        "Trial redirects must stay at the configured provider",
      );
      const cookie = Array.from(this.cookies.values())
        .filter((item) => parsed.pathname.startsWith(item.path))
        .map((item) => `${item.name}=${item.value}`)
        .join("; ");
      const result = await fetch(parsed, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
        headers: { ...init.headers, ...(cookie ? { cookie } : {}) },
      });
      for (const raw of result.headers.getSetCookie()) {
        const [pair, ...attributes] = raw.split(";");
        const separator = pair.indexOf("="),
          name = pair.slice(0, separator),
          value = pair.slice(separator + 1);
        const path =
          attributes
            .find((item) => /^\s*path=/i.test(item))
            ?.split("=")
            .slice(1)
            .join("=") ?? "/";
        const maxAge = attributes
          .find((item) => /^\s*max-age=/i.test(item))
          ?.split("=")[1];
        if (maxAge === "0") this.cookies.delete(`${name}:${path}`);
        else this.cookies.set(`${name}:${path}`, { name, value, path });
      }
      if (result.status >= 300 && result.status < 400) {
        url = new URL(result.headers.get("location"), parsed).href;
        init = {};
        continue;
      }
      this.url = parsed.href;
      const html = await result.text();
      await this.page.setContent(html, { waitUntil: "domcontentloaded" });
      this.status = result.status;
      return;
    }
    throw new Error("Provider redirect loop; private state suppressed.");
  }
  async submit(formId, values = {}) {
    assert.equal(
      await this.page.locator(`#${formId}`).count(),
      1,
      `Expected provider form ${formId}, HTTP ${this.status}`,
    );
    const { action, entries } = await this.page
      .locator(`#${formId}`)
      .evaluate((form) => ({
        action: form.getAttribute("action"),
        entries: Array.from(new FormData(form).entries()).filter(
          ([, value]) => typeof value === "string",
        ),
      }));
    const body = new URLSearchParams(entries);
    for (const [key, value] of Object.entries(values)) body.set(key, value);
    await this.visit(new URL(action, this.url).href, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  }
  async close() {
    await this.page.close();
    this.cookies.clear();
  }
}
const session = () => new ProtocolSession().initialize();
const user = async (subject) =>
  trialJson(`${adminBase}/users/${subject}`, {
    headers: {
      ...headers,
      authorization: `Bearer ${await bootstrapToken(config)}`,
    },
  });
async function pending() {
  const accountId = randomUUID();
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const username = `LB${Array.from(randomBytes(12), (byte) => alphabet[byte & 31]).join("")}`;
  const result = await provider.provisionPending({
    operationId: `pending:${accountId}`,
    accountId,
    username,
    classification: "child_shared",
    emailRequired: false,
  });
  return {
    accountId,
    subject: result.subject,
    username,
    issuer: config.issuer,
  };
}
async function begin(child) {
  const activationId = randomUUID();
  const operationId = `activation:${activationId}`;
  const receipt = await provider.beginCredentialSetup({
    ...child,
    operationId,
    expiresAt: Date.now() + config.policy.activationTtlMs,
  });
  return { ...child, operationId, activationId, receipt };
}
function totp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of secret.replace(/\s|=/g, "").toUpperCase())
    bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
  const bytes = Buffer.from(
    (bits.match(/.{8}/g) ?? []).map((value) => parseInt(value, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", bytes).update(counter).digest(),
    offset = digest[19] & 15;
  return String(
    (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000,
  ).padStart(6, "0");
}
async function authorize(protocol, credentials, otpSecret) {
  const verifier = randomBytes(32).toString("base64url"),
    state = randomBytes(24).toString("base64url"),
    nonce = randomBytes(24).toString("base64url");
  const authorizeUrl = new URL(`${config.issuer}/protocol/openid-connect/auth`);
  authorizeUrl.search = new URLSearchParams({
    client_id: config.publicClientId,
    redirect_uri: "https://localhost:8443/oidc/callback",
    response_type: "code",
    scope: "openid",
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    state,
    nonce,
    prompt: "login",
  }).toString();
  await protocol.visit(authorizeUrl.href);
  await protocol.submit("kc-form-login", {
    username: credentials.username,
    password: credentials.password,
  });
  let newOtp = otpSecret;
  if (await protocol.page.locator("#kc-totp-settings-form").count()) {
    // Keycloak exposes the same generated secret in its trusted setup form; never persist/print it.
    const manual = await protocol.page
      .locator("#mode-manual")
      .getAttribute("href");
    await protocol.visit(new URL(manual, protocol.url).href);
    newOtp = await protocol.page.locator("#kc-totp-secret-key").innerText();
    await protocol.submit("kc-totp-settings-form", {
      totp: totp(newOtp),
      userLabel: "Isolated protocol test authenticator",
    });
  }
  if (await protocol.page.locator("#kc-recovery-codes-settings-form").count()) {
    assert.ok(
      (await protocol.page.locator("#kc-recovery-codes-list li").count()) > 0,
    );
    await protocol.submit("kc-recovery-codes-settings-form");
  }
  if (await protocol.page.locator("#kc-otp-login-form").count()) {
    assert.ok(newOtp, "OTP must be required for the adult fixture");
    await protocol.submit("kc-otp-login-form", { otp: totp(newOtp) });
  }
  if (!protocol.callback)
    console.error("Provider flow stopped", {
      formIds: await protocol.page
        .locator("form")
        .evaluateAll((forms) => forms.map((form) => form.id)),
      inputNames: await protocol.page
        .locator("input[name]")
        .evaluateAll((inputs) => inputs.map((input) => input.name)),
    });
  assert.ok(protocol.callback, "Expected exact registered OIDC callback");
  assert.equal(protocol.callback.searchParams.get("state"), state);
  const code = protocol.callback.searchParams.get("code");
  assert.ok(code);
  return { verifier, state, nonce, code, otpSecret: newOtp };
}
async function exchange(code, verifier) {
  return fetch(`${config.issuer}/protocol/openid-connect/token`, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.publicClientId,
      redirect_uri: "https://localhost:8443/oidc/callback",
      code,
      code_verifier: verifier,
    }),
  });
}
try {
  const discovery = await trialJson(
    `${config.issuer}/.well-known/openid-configuration`,
  );
  assert.equal(discovery.issuer, config.issuer);
  assert.ok(discovery.code_challenge_methods_supported.includes("S256"));
  record("Actual pinned provider discovery over verified HTTPS");
  const verify = createOidcVerifier({
    issuer: config.issuer,
    audience: "longball-api",
    jwksUri: discovery.jwks_uri,
  });
  const denied = await fetch(`${config.issuer}/longball-activation/pending`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(denied.status, 403);
  record("Provider extension refuses unauthenticated provisioning");

  if (!schemaSmoke) {
    const child = await pending();
    assert.deepEqual(
      await provider.provisionPending({
        operationId: `pending:${child.accountId}`,
        accountId: child.accountId,
        username: child.username,
        classification: "child_shared",
        emailRequired: false,
      }),
      {
        issuer: child.issuer,
        subject: child.subject,
        username: child.username,
        pending: true,
        credentialConfigured: false,
      },
    );
    const before = await user(child.subject);
    assert.equal(before.enabled, false);
    assert.ok(!before.email);
    const active = await begin(child);
    const protocol = await session();
    await protocol.visit(active.receipt.setupUrl);
    const password = randomBytes(32).toString("base64url");
    await protocol.submit("kc-passwd-update-form", {
      "password-new": password,
      "password-confirm": password,
    });
    assert.ok(
      (await protocol.page.locator("#kc-recovery-codes-list li").count()) > 0,
      "Provider must issue actual recovery codes",
    );
    await protocol.submit("kc-recovery-codes-settings-form");
    await protocol.submit("longball-activation-finish");
    if (!protocol.callback) {
      const link = protocol.page.locator('a[href*="completionProof="]');
      assert.equal(
        await link.count(),
        1,
        "Provider must offer the registered completion return",
      );
      await protocol.visit(await link.getAttribute("href"));
    }
    assert.equal(protocol.callback.pathname, "/activation/callback");
    assert.equal(
      protocol.callback.hash.includes(
        `longballActivation=${active.activationId}`,
      ),
      true,
    );
    const proof = new URLSearchParams(protocol.callback.hash.slice(1)).get(
      "completionProof",
    );
    assert.ok(proof);
    const verified = await provider.verifyCredentialSetup({
      operationId: active.operationId,
      flowId: active.receipt.flowId,
      issuer: child.issuer,
      subject: child.subject,
      completionProof: proof,
    });
    assert.equal(verified.credentialConfigured, true);
    assert.equal(verified.recoveryMaterialIssued, true);
    await assert.rejects(
      provider.verifyCredentialSetup({
        operationId: active.operationId,
        flowId: active.receipt.flowId,
        issuer: child.issuer,
        subject: child.subject,
        completionProof: "wrong-proof",
      }),
    );
    const after = await user(child.subject);
    assert.ok(!after.email);
    assert.equal(
      after.attributes["longball.classification"][0],
      "child_shared",
    );
    assert.notEqual(
      after.attributes["longball.activation.proofHash"][0],
      proof,
    );
    record(
      "Actual username-only provider password + recovery-code setup, hashed completion proof and wrong-proof refusal",
    );
    const replay = await session();
    await replay.visit(active.receipt.setupUrl);
    assert.equal(
      await replay.page.locator("#kc-passwd-update-form").count(),
      0,
    );
    await replay.close();
    await protocol.close();
    record("Consumed action-token replay cannot reopen credential setup");

    const cancellation = await begin(await pending());
    const interrupted = await session();
    await interrupted.visit(cancellation.receipt.setupUrl);
    assert.equal(
      await interrupted.page.locator("#kc-passwd-update-form").count(),
      1,
    );
    await provider.cancelCredentialSetup({
      operationId: cancellation.operationId,
      issuer: cancellation.issuer,
      subject: cancellation.subject,
    });
    assert.equal((await user(cancellation.subject)).enabled, false);
    const replacement = await begin({
      accountId: cancellation.accountId,
      issuer: cancellation.issuer,
      subject: cancellation.subject,
      username: cancellation.username,
    });
    await interrupted.submit("kc-passwd-update-form", {
      "password-new": password,
      "password-confirm": password,
    });
    const cancelled = await user(cancellation.subject);
    assert.equal(
      cancelled.attributes["longball.activation.operation"][0],
      replacement.operationId,
    );
    const credentials = await trialJson(
      `${adminBase}/users/${cancellation.subject}/credentials`,
      { headers },
    );
    assert.equal(
      credentials.some((item) => item.type === "password"),
      false,
    );
    await interrupted.close();
    await provider.cancelCredentialSetup({
      operationId: replacement.operationId,
      issuer: replacement.issuer,
      subject: replacement.subject,
    });
    record(
      "Cancellation plus reissue blocks stale credential submission from an already-open provider form",
    );

    const childLogin = await session();
    const childAuth = await authorize(childLogin, {
      username: child.username,
      password,
    });
    const childTokenResponse = await exchange(
      childAuth.code,
      childAuth.verifier,
    );
    assert.equal(childTokenResponse.status, 200);
    const childTokens = await childTokenResponse.json();
    const childIdentity = await verify(childTokens.access_token);
    assert.equal(childIdentity.subject, child.subject);
    assert.equal(childIdentity.strongAuth, false);
    assert.equal(
      JSON.parse(Buffer.from(childTokens.id_token.split(".")[1], "base64url"))
        .nonce,
      childAuth.nonce,
    );

    await childLogin.close();
    record(
      "Actual child authorization code + PKCE S256, signed API token, nonce and code replay refusal",
    );
    const wrongPkce = await session();
    const wrongAuthorization = await authorize(wrongPkce, {
      username: child.username,
      password,
    });
    assert.equal(
      (
        await exchange(
          wrongAuthorization.code,
          randomBytes(32).toString("base64url"),
        )
      ).status,
      400,
    );
    await wrongPkce.close();
    const refreshResponse = await fetch(
      `${config.issuer}/protocol/openid-connect/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: config.publicClientId,
          refresh_token: childTokens.refresh_token,
        }),
      },
    );
    assert.equal(refreshResponse.status, 200);
    const refreshed = await refreshResponse.json();
    assert.equal((await verify(refreshed.access_token)).subject, child.subject);
    const revoked = await fetch(
      `${config.issuer}/protocol/openid-connect/revoke`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.publicClientId,
          token: refreshed.refresh_token,
          token_type_hint: "refresh_token",
        }),
      },
    );
    assert.equal(revoked.status, 200);
    const revokedRefresh = await fetch(
      `${config.issuer}/protocol/openid-connect/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: config.publicClientId,
          refresh_token: refreshed.refresh_token,
        }),
      },
    );
    assert.equal(revokedRefresh.status, 400);
    const replayCode = await exchange(childAuth.code, childAuth.verifier);
    assert.equal(replayCode.status, 400);
    record("Actual wrong-PKCE refusal, refresh and refresh-token revocation");
  }

  const adultFixture = apiProof
    ? {
        subject: config.adultSubject,
        username: config.adultUsername,
        password: config.adultPassword,
      }
    : {
        subject: randomUUID(),
        username: `fictional.protocol.${randomBytes(8).toString("hex")}`,
        password: randomBytes(32).toString("base64url"),
      };
  if (!apiProof)
    await trialJson(`${adminBase}/users`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: adultFixture.subject,
        username: adultFixture.username,
        enabled: true,
        requiredActions: ["CONFIGURE_TOTP", "CONFIGURE_RECOVERY_AUTHN_CODES"],
        credentials: [
          { type: "password", value: adultFixture.password, temporary: false },
        ],
      }),
    });
  if (apiProof) {
    assert.equal(
      config.issuer,
      "https://localhost:8443/realms/longball-fictional",
    );
    const fixtureUser = await user(adultFixture.subject);
    assert.equal(fixtureUser.username, "fictional.manager");
    assert.equal(
      fixtureUser.attributes["longball.classification"][0],
      "adult_individual",
    );
    // Explicit isolated fixture reset, never a real household/global recovery authority.
    const fixtureCredentials = await trialJson(
      `${adminBase}/users/${adultFixture.subject}/credentials`,
      { headers },
    );
    for (const credential of fixtureCredentials)
      if (credential.type === "otp" || credential.type.startsWith("recovery"))
        await trialJson(
          `${adminBase}/users/${adultFixture.subject}/credentials/${credential.id}`,
          { method: "DELETE", headers },
        );
    await trialJson(`${adminBase}/users/${adultFixture.subject}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        requiredActions: ["CONFIGURE_TOTP", "CONFIGURE_RECOVERY_AUTHN_CODES"],
      }),
    });
  }
  const createdAdults = await trialJson(
    `${adminBase}/users?username=${encodeURIComponent(adultFixture.username)}&exact=true`,
    { headers },
  );
  assert.equal(createdAdults.length, 1);
  adultFixture.subject = createdAdults[0].id;
  const adultRole = await trialJson(`${adminBase}/roles/trial-adult-mfa`, {
    headers,
  });
  await trialJson(
    `${adminBase}/users/${adultFixture.subject}/role-mappings/realm`,
    { method: "POST", headers, body: JSON.stringify([adultRole]) },
  );
  const adult = await session();
  const enrolled = await authorize(adult, {
    username: adultFixture.username,
    password: adultFixture.password,
  });
  assert.ok(enrolled.otpSecret, "Provider must enroll adult TOTP");
  await adult.close();
  // Keycloak prevents reuse of the setup OTP. Obtain the next real time-window code.
  await new Promise((resolve) =>
    setTimeout(resolve, 31_000 - (Date.now() % 30_000)),
  );
  const freshAdult = await session();
  const adultAuth = await authorize(
    freshAdult,
    { username: adultFixture.username, password: adultFixture.password },
    enrolled.otpSecret,
  );
  const adultResponse = await exchange(adultAuth.code, adultAuth.verifier);
  assert.equal(adultResponse.status, 200);
  const adultTokens = await adultResponse.json();
  const adultIdentity = await verify(adultTokens.access_token);
  assert.equal(adultIdentity.subject, adultFixture.subject);
  assert.equal(adultIdentity.strongAuth, true);
  await freshAdult.close();
  if (!apiProof)
    await trialJson(`${adminBase}/users/${adultFixture.subject}`, {
      method: "DELETE",
      headers,
    });
  record(
    "Actual adult TOTP enrollment and fresh password+OTP AMR verified by application verifier",
  );
  if (apiProof) {
    const fixture = JSON.parse(
      await readFile(resolve(trialDirectory, "api-fixture.json"), "utf8"),
    );
    assert.equal(fixture.fictionalOnly, true);
    assert.equal(fixture.apiBaseUrl, "https://localhost:8444");
    const api = async (
      path,
      bearer,
      body,
      expectedStatus = 200,
      requestId = randomUUID(),
    ) => {
      console.log(`API proof ${body ? "POST" : "GET"} ${path.split("?")[0]}`);
      const response = await fetch(`${fixture.apiBaseUrl}/v1${path}`, {
        method: body ? "POST" : "GET",
        redirect: "error",
        signal: AbortSignal.timeout(45_000),
        headers: {
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(body
            ? {
                "content-type": "application/json",
                "x-api-contract-version": "longball.events/1.1",
                "idempotency-key": requestId,
              }
            : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal(
        response.status,
        expectedStatus,
        `Actual provider/API request failed at ${path.split("?")[0]}`,
      );
      return response.json();
    };
    const managerIdentity = await api("/me", adultTokens.access_token);
    assert.equal(managerIdentity.principal.accountId, fixture.accountId);
    assert.equal(managerIdentity.principal.strongAuth, true);
    assert.equal(
      managerIdentity.principal.identityClassification,
      "adult_individual",
    );
    assert.equal(managerIdentity.syntheticOnly, false);
    const scoped = `/teams/${fixture.teamId}`;
    async function runSpectatorUi() {
      const uiInvite = await api(
        `${scoped}/spectator-invites`,
        adultTokens.access_token,
        { seasonId: fixture.seasonId, expiresInHours: 1 },
        201,
      );
      const uiToken = new URLSearchParams(
        new URL(uiInvite.shareUrl).hash.slice(1),
      ).get("code");
      assert.ok(uiToken);
      const root = resolve(import.meta.dirname, ".."),
        output = resolve(root, ".local/identity/spectator-browser-review"),
        nss = resolve(root, ".local/identity/spectator-browser-nss");
      await mkdir(output, { recursive: true, mode: 0o700 });
      await mkdir(nss, { recursive: true, mode: 0o700 });
      const dockerEnvironment = { ...process.env };
      for (const key of [
        "DOCKER_HOST",
        "DOCKER_CONTEXT",
        "DOCKER_TLS",
        "DOCKER_TLS_VERIFY",
        "DOCKER_CERT_PATH",
      ])
        delete dockerEnvironment[key];
      const args = [
        "--host=unix:///var/run/docker.sock",
        "run",
        "--rm",
        "--interactive",
        "--network=host",
        "--memory=2g",
        "--cpus=2",
        "--mount",
        `type=bind,src=${root},dst=/work,readonly`,
        "--tmpfs",
        "/work/.local:rw,size=128m,mode=1777",
        "--mount",
        `type=bind,src=${root}/.local/identity/trial/ca.crt,dst=/work/.local/identity/trial/ca.crt,readonly`,
        "--mount",
        `type=bind,src=${output},dst=/work/.local/identity/spectator-browser-review`,
        "--mount",
        `type=bind,src=${nss},dst=/root/.local/share/pki/nssdb`,
        "--env",
        "NODE_EXTRA_CA_CERTS=/work/.local/identity/trial/ca.crt",
        "--entrypoint",
        "sh",
        "longball-identity-browser:local",
        "-euc",
        'if [ ! -f /root/.local/share/pki/nssdb/cert9.db ]; then certutil -N -d sql:/root/.local/share/pki/nssdb --empty-password; fi; certutil -D -d sql:/root/.local/share/pki/nssdb -n LongBallLocalTrialCA 2>/dev/null || true; certutil -A -d sql:/root/.local/share/pki/nssdb -n LongBallLocalTrialCA -t "C,," -i /work/.local/identity/trial/ca.crt; exec node scripts/spectator-activation-ui-review.mjs',
      ];
      await new Promise((done, reject) => {
        const child = spawn("docker", args, {
          env: dockerEnvironment,
          stdio: ["pipe", "inherit", "inherit"],
          timeout: 180_000,
        });
        child.once("error", () =>
          reject(
            new Error(
              "Trusted isolated spectator browser could not start; private details suppressed.",
            ),
          ),
        );
        child.once("exit", (code) =>
          code === 0
            ? done()
            : reject(
                new Error(
                  "Actual spectator browser journey failed; see bounded stage evidence.",
                ),
              ),
        );
        child.stdin.end(
          JSON.stringify({
            baseUrl: appBaseUrl,
            fixture: {
              issuer: config.issuer,
              publicClientId: config.publicClientId,
              apiBaseUrl: fixture.apiBaseUrl,
            },
            invitationToken: uiToken,
            teamId: fixture.teamId,
            seasonId: fixture.seasonId,
          }),
        );
      });
      record(
        "Actual trusted 320px production UI completes new-invitee provider credential setup, explicit return verification, separate PKCE and reviewed spectator acceptance without vault injection",
      );
    }
    if (spectatorUiOnly) {
      await runSpectatorUi();
    } else {
      const preparation = await api(
        `${scoped}/preparation?seasonId=${fixture.seasonId}`,
        adultTokens.access_token,
      );
      const playerId = randomUUID();
      await api(
        `${scoped}/preparation?seasonId=${fixture.seasonId}`,
        adultTokens.access_token,
        {
          command: {
            type: "profile.saved",
            id: randomUUID(),
            expectedRevision: preparation.revision,
            profile: {
              ...preparation.profiles[0],
              id: randomUUID(),
              playerId,
              displayName: "Fictional provider API test player",
              shirtNumber: null,
            },
          },
        },
      );
      const childReceipt = await api(
        `${scoped}/activation/pending-child?seasonId=${fixture.seasonId}`,
        adultTokens.access_token,
        { playerId },
      );
      const capability = await api(
        `${scoped}/activation/issue?seasonId=${fixture.seasonId}`,
        adultTokens.access_token,
        { accountId: childReceipt.accountId },
      );
      const setup = await api("/activation/redeem", null, {
        token: capability.token,
      });
      const household = await session();
      const householdPassword = randomBytes(32).toString("base64url");
      await household.visit(setup.providerSetupUrl);
      await household.submit("kc-passwd-update-form", {
        "password-new": householdPassword,
        "password-confirm": householdPassword,
      });
      assert.ok(
        (await household.page.locator("#kc-recovery-codes-list li").count()) >
          0,
      );
      await household.submit("kc-recovery-codes-settings-form");
      await household.submit("longball-activation-finish");
      if (!household.callback)
        await household.visit(
          await household.page
            .locator('a[href*="completionProof="]')
            .getAttribute("href"),
        );
      const returned = new URLSearchParams(household.callback.hash.slice(1));
      assert.equal(returned.get("longballActivation"), setup.activationId);
      const completion = {
        activationId: setup.activationId,
        token: capability.token,
        completionProof: returned.get("completionProof"),
      };
      const wrongCapability = await api(
        "/activation/complete",
        null,
        { ...completion, token: randomBytes(32).toString("base64url") },
        410,
      );
      assert.equal(wrongCapability.code, "ACTIVATION_UNAVAILABLE");
      const wrongActivation = await api(
        "/activation/complete",
        null,
        { ...completion, activationId: randomUUID() },
        410,
      );
      assert.equal(wrongActivation.code, "ACTIVATION_UNAVAILABLE");
      await api(
        "/activation/complete",
        null,
        {
          activationId: completion.activationId,
          completionProof: completion.completionProof,
        },
        400,
      );
      record(
        "Actual activation completion refuses missing or mismatched original capability before accepting the independent provider proof",
      );
      const completed = await api("/activation/complete", null, {
        activationId: setup.activationId,
        token: capability.token,
        completionProof: returned.get("completionProof"),
      });
      assert.equal(completed.status, "complete");
      assert.equal(completed.signInRequired, true);
      await household.close();
      const householdSignIn = await session();
      const householdAuthorization = await authorize(householdSignIn, {
        username: childReceipt.username,
        password: householdPassword,
      });
      const householdResponse = await exchange(
        householdAuthorization.code,
        householdAuthorization.verifier,
      );
      assert.equal(householdResponse.status, 200);
      const householdTokens = await householdResponse.json();
      const householdIdentity = await api("/me", householdTokens.access_token);
      assert.equal(
        householdIdentity.principal.accountId,
        childReceipt.accountId,
      );
      assert.equal(
        householdIdentity.principal.identityClassification,
        "child_shared",
      );
      assert.equal(householdIdentity.principal.adultVerified, false);
      assert.equal(householdIdentity.principal.strongAuth, false);
      assert.ok(
        householdIdentity.memberships.some(
          (membership) =>
            membership.role === "player" && membership.playerId === playerId,
        ),
      );
      if (process.env.LONGBALL_IDENTITY_TRIAL_ACCOUNT_REQUESTS_PROOF === "1") {
        const checks = [];
        let loseResponse = true;
        let posts = 0;
        const requestClient = createAccountRequestsClient({
          accountId: childReceipt.accountId,
          newId: randomUUID,
          assertCurrent: async () => {
            const current = await api("/me", householdTokens.access_token);
            assert.equal(current.accountId, childReceipt.accountId);
          },
          request: async (init) => {
            if (init?.method === "POST") posts += 1;
            const response = await fetch(
              `${fixture.apiBaseUrl}/v1/privacy/requests`,
              {
                ...init,
                redirect: "error",
                signal: AbortSignal.timeout(30_000),
                headers: {
                  ...Object.fromEntries(new Headers(init?.headers).entries()),
                  authorization: `Bearer ${householdTokens.access_token}`,
                },
              },
            );
            if (init?.method === "POST" && loseResponse) {
              loseResponse = false;
              assert.equal(response.status, 200);
              await response.text();
              throw new Error(
                "Intentional fixture response loss after real API commit",
              );
            }
            return response;
          },
        });
        const exportInput = {
          kind: "export",
          scope: "all_memberships",
          confirmAllMemberships: true,
        };
        const firstStatus = await requestClient.refresh();
        assert.equal(firstStatus.snapshot.accountId, childReceipt.accountId);
        await assert.rejects(
          requestClient.submit(
            exportInput,
            accountRequestConfirmation(firstStatus.snapshot, exportInput),
          ),
          (error) => error.code === "UNCERTAIN_SUBMISSION",
        );
        const resolved = await requestClient.refresh();
        assert.equal(resolved.pending, null);
        assert.ok(resolved.resolvedRequest);
        assert.equal(posts, 1);
        assert.equal(resolved.resolvedRequest.fulfilled, false);
        assert.equal(resolved.resolvedRequest.erased, false);
        checks.push(
          "Real child JWT account export request: lost committed response resolved by fresh status without a second client POST",
        );
        const duplicate = await api(
          "/privacy/requests",
          householdTokens.access_token,
          exportInput,
        );
        assert.equal(duplicate.requestId, resolved.resolvedRequest.requestId);
        checks.push(
          "A new idempotency key for the same pending global business request returns the original service reference",
        );
        const leaveInput = {
          kind: "leave_team",
          teamId: fixture.teamId,
          seasonId: fixture.seasonId,
          confirmLeave: true,
        };
        const leave = await requestClient.submit(
          leaveInput,
          accountRequestConfirmation(resolved.snapshot, leaveInput),
        );
        assert.equal(leave.resolvedRequest.scope.type, "team_season");
        assert.equal(leave.resolvedRequest.scope.teamId, fixture.teamId);
        assert.equal(leave.resolvedRequest.scope.seasonId, fixture.seasonId);
        assert.ok(
          leave.resolvedRequest.affectedMemberships.every(
            (membership) =>
              membership.teamId === fixture.teamId &&
              membership.seasonId === fixture.seasonId,
          ),
        );
        const unchanged = await api("/me", householdTokens.access_token);
        assert.deepEqual(unchanged.memberships, householdIdentity.memberships);
        checks.push(
          "Separate exact team-season leave request stays pending and leaves real API memberships unchanged",
        );
        const deletion = await api(
          "/privacy/requests",
          householdTokens.access_token,
          {
            kind: "delete_account",
            scope: "all_memberships",
            confirmAllMemberships: true,
          },
        );
        assert.equal(deletion.scope.type, "all_memberships");
        assert.equal(deletion.erased, false);
        assert.equal(deletion.fulfilled, false);
        assert.equal(
          (await api("/me", householdTokens.access_token)).principal.status,
          "active",
        );
        checks.push(
          "Global account deletion request records verification/policy pending without credential removal, erasure or account deactivation",
        );
        await writeFile(
          resolve(trialDirectory, "account-requests-evidence.json"),
          JSON.stringify(
            {
              verifiedAt: new Date().toISOString(),
              provider: "Keycloak",
              providerVersion: "26.8.1",
              actualProviderJwt: true,
              database: "PostgreSQL",
              runtimeRole: "restricted API role",
              checks,
              policiesApproved: false,
              fulfilled: false,
              erased: false,
              systemBrowserTested: false,
              physicalDeviceTested: false,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        for (const check of checks) console.log(`PASS ${check}`);
      }
      const deniedManagerView = await fetch(
        `${fixture.apiBaseUrl}/v1${scoped}/preparation?seasonId=${fixture.seasonId}`,
        {
          headers: { authorization: `Bearer ${householdTokens.access_token}` },
        },
      );
      assert.ok([403, 404].includes(deniedManagerView.status));
      const deniedAlias = await fetch(`${fixture.apiBaseUrl}/v1/me`, {
        headers: { authorization: "Bearer synthetic-manager-1" },
      });
      assert.equal(deniedAlias.status, 401);
      if (spectatorProof) {
        const spectatorChecks = [];
        const createKey = randomUUID();
        const invite = await api(
          `${scoped}/spectator-invites`,
          adultTokens.access_token,
          { seasonId: fixture.seasonId, expiresInHours: 1 },
          201,
          createKey,
        );
        assert.deepEqual(Object.keys(invite).sort(), [
          "expiresAt",
          "id",
          "seasonId",
          "shareUrl",
          "teamId",
        ]);
        const link = new URL(invite.shareUrl),
          params = new URLSearchParams(link.hash.slice(1)),
          invitationToken = params.get("code");
        assert.equal(link.origin, "https://charlieomnipoint.github.io");
        assert.equal(link.pathname, "/LongBall/");
        assert.equal(link.search, "");
        assert.equal(params.get("longballInvite"), "1");
        assert.equal(invitationToken?.length, 43);
        const lostRetry = await api(
          `${scoped}/spectator-invites`,
          adultTokens.access_token,
          { seasonId: fixture.seasonId, expiresInHours: 1 },
          200,
          createKey,
        );
        assert.equal(lostRetry.id, invite.id);
        assert.equal(lostRetry.credentialAvailable, false);
        assert.equal(lostRetry.requiresReissue, true);
        assert.equal(Object.hasOwn(lostRetry, "shareUrl"), false);
        spectatorChecks.push(
          "Real strongly authenticated manager issues one 256-bit fragment capability; exact response-loss retry is redacted and requires explicit reissue",
        );
        const info = await api("/spectator-invites/activation-info", null, {
          token: invitationToken,
        });
        assert.deepEqual(Object.keys(info).sort(), [
          "expiresAt",
          "invitationId",
          "policyVersion",
        ]);
        assert.equal(info.invitationId, invite.id);
        const activationBody = {
          token: invitationToken,
          deviceId: randomUUID(),
          policyVersion: info.policyVersion,
        };
        const activation = await api(
          "/spectator-invites/activate",
          null,
          activationBody,
        );
        const action = new URL(activation.identityActionUrl),
          attemptParams = new URLSearchParams(action.hash.slice(1)),
          activationId = attemptParams.get("longballActivation");
        assert.equal(Array.from(attemptParams.keys()).length, 1);
        assert.ok(activationId);
        action.hash = "";
        assert.equal(action.href.includes(invitationToken), false);
        const beforeUser = await user(activation.accountId);
        assert.equal(beforeUser.enabled, true);
        assert.equal(
          beforeUser.attributes["longball.classification"][0],
          "unclassified",
        );
        assert.ok(!beforeUser.email);
        const trialPassword = randomBytes(32).toString("base64url"),
          invitee = await session();
        await invitee.visit(action.href);
        await invitee.submit("kc-passwd-update-form", {
          "password-new": trialPassword,
          "password-confirm": trialPassword,
        });
        assert.ok(
          (await invitee.page.locator("#kc-recovery-codes-list li").count()) >
            0,
        );
        await invitee.submit("kc-recovery-codes-settings-form");
        await invitee.submit("longball-activation-finish");
        if (!invitee.callback)
          await invitee.visit(
            await invitee.page
              .locator('a[href*="completionProof="]')
              .getAttribute("href"),
          );
        const completedParams = new URLSearchParams(
          invitee.callback.hash.slice(1),
        );
        assert.equal(completedParams.get("longballActivation"), activationId);
        const completion = {
          activationId,
          token: invitationToken,
          completionProof: completedParams.get("completionProof"),
        };
        await api(
          "/activation/complete",
          null,
          { ...completion, token: randomBytes(32).toString("base64url") },
          410,
        );
        await api(
          "/activation/complete",
          null,
          { ...completion, activationId: randomUUID() },
          410,
        );
        const result = await api("/activation/complete", null, completion);
        assert.equal(result.status, "complete");
        assert.equal(result.signInRequired, true);
        await invitee.close();
        spectatorChecks.push(
          "Actual pinned provider provisions a username-only unclassified identity and handles password plus recovery setup; original invitation and exact attempt are required for independently verified completion",
        );
        const inviteeSignIn = await session(),
          auth = await authorize(inviteeSignIn, {
            username: activation.username,
            password: trialPassword,
          }),
          tokensResponse = await exchange(auth.code, auth.verifier);
        assert.equal(tokensResponse.status, 200);
        const tokens = await tokensResponse.json(),
          me = await api("/me", tokens.access_token);
        assert.equal(me.principal.accountId, activation.accountId);
        assert.equal(me.principal.identityClassification, "unclassified");
        assert.equal(me.principal.adultVerified, false);
        assert.equal(me.principal.strongAuth, false);
        assert.deepEqual(me.memberships, []);
        spectatorChecks.push(
          "Separate actual authorization-code PKCE sign-in verifies the new global account has no membership or adult authority before explicit invitation acceptance",
        );
        const registered = await api("/identity/devices", tokens.access_token, {
          deviceId: randomUUID(),
          platform: "ios",
        });
        assert.equal(registered.accountId, activation.accountId);
        assert.equal(registered.remoteRevocationAvailable, false);
        assert.equal(registered.devices.length, 1);
        assert.equal(registered.devices[0].source, "native_app_enrolment");
        assert.equal(registered.devices[0].platformVerified, false);
        assert.ok(registered.devices[0].registeredAt);
        assert.ok(registered.devices[0].lastSeenAt);
        const accepted = await api(
          "/spectator-invites/accept",
          tokens.access_token,
          { token: invitationToken },
        );
        assert.ok(accepted);
        const after = await api("/me", tokens.access_token);
        assert.ok(
          after.memberships.some(
            (m) =>
              m.role === "spectator" &&
              m.teamId === fixture.teamId &&
              m.seasonId === fixture.seasonId,
          ),
        );
        assert.equal(after.principal.adultVerified, false);
        const denied = await fetch(
          `${fixture.apiBaseUrl}/v1${scoped}/preparation?seasonId=${fixture.seasonId}`,
          { headers: { authorization: `Bearer ${tokens.access_token}` } },
        );
        assert.ok([403, 404].includes(denied.status));
        await inviteeSignIn.close();
        spectatorChecks.push(
          "Authenticated explicit acceptance creates only the exact team-season spectator grant; native-app metadata enrollment works for the new role and manager preparation remains denied",
        );
        await writeFile(
          resolve(trialDirectory, "spectator-activation-evidence.json"),
          JSON.stringify(
            {
              verifiedAt: new Date().toISOString(),
              provider: "Keycloak",
              providerVersion: "26.8.1",
              database: "PostgreSQL",
              verifiedRuntimeSchema: { core: 11, activation: 2 },
              actualProviderJwt: true,
              runtimeRole: "restricted API role",
              httpsCertificateVerified: true,
              checks: spectatorChecks,
              chromiumUse: "offline DOM parser only",
              systemBrowserTested: false,
              physicalDeviceTested: false,
              devicePlatformProof: false,
              liveOnboardingApproved: false,
              productionProviderSelected: false,
              policiesApproved: false,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        for (const check of spectatorChecks) record(check);
        if (process.env.LONGBALL_IDENTITY_TRIAL_SPECTATOR_UI_PROOF === "1")
          await runSpectatorUi();
      }
      await householdSignIn.close();
      record(
        "Actual strongly authenticated provider manager → restricted-role PostgreSQL API → username-only activation → independent child PKCE sign-in, child manager-denial and synthetic-alias refusal",
      );
    }
  }

  await writeFile(
    resolve(
      trialDirectory,
      spectatorUiOnly ? "spectator-ui-run-evidence.json" : "evidence.json",
    ),
    JSON.stringify(
      {
        provider: "Keycloak",
        version: "26.8.1",
        verifiedAt: new Date().toISOString(),
        checks,
        httpsCertificateVerified: true,
        actualProviderRequests: true,
        actualProviderApiJourney: apiProof,
        activationCompletionRequiresOriginalCapability: apiProof,
        spectatorUiOnly,
        verifiedRuntimeSchema: apiProof ? { core: 11, activation: 2 } : null,
        schemaUpgradeSmokeOnly: schemaSmoke,
        chromiumUse: "offline DOM parser only",
        systemBrowserTested: false,
        physicalDeviceTested: false,
        liveOnboardingApproved: false,
        productionProviderSelected: false,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
} finally {
  await browser.close();
}
