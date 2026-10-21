import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
export const trialDirectory = resolve(
  import.meta.dirname,
  "../.local/identity/trial",
);
/** Exact isolated browser entries only; this never selects a provider or API origin. */
export function identityTrialAppUrl() {
  const value =
    process.env.LONGBALL_IDENTITY_APP_URL ?? "http://localhost:4174";
  if (!["http://localhost:4174", "http://localhost:4175"].includes(value))
    throw new Error(
      "Use an exact configured localhost identity-trial app entry.",
    );
  return value;
}
export async function readTrial() {
  return JSON.parse(
    await readFile(resolve(trialDirectory, "configuration.json"), "utf8"),
  );
}
export async function trialJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new Error(
      `Identity trial HTTP request failed (${response.status}); response body suppressed.`,
    );
  const text = await response.text();
  if (text.length > 1_000_000)
    throw new Error("Identity trial response exceeded its bound.");
  return text ? JSON.parse(text) : null;
}
export async function bootstrapToken(config) {
  const result = await trialJson(
    "https://localhost:8443/realms/master/protocol/openid-connect/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: config.bootstrapClientId,
        client_secret: config.bootstrapClientSecret,
      }),
    },
  );
  if (typeof result.access_token !== "string")
    throw new Error("Temporary trial bootstrap service refused.");
  return result.access_token;
}
export async function configureTrial() {
  const config = await readTrial();
  const token = await bootstrapToken(config);
  const base = "https://localhost:8443/admin/realms/longball-fictional";
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const profile = await trialJson(`${base}/users/profile`, { headers });
  // Username-only fictional child: no invented email/first-name/last-name identity requirement.
  for (const attribute of profile.attributes)
    if (["email", "firstName", "lastName"].includes(attribute.name))
      delete attribute.required;
  profile.unmanagedAttributePolicy = "ADMIN_EDIT";
  await trialJson(`${base}/users/profile`, {
    method: "PUT",
    headers,
    body: JSON.stringify(profile),
  });
  return { config, token, adminBase: base, headers };
}
if (process.argv[1] === resolve(import.meta.filename)) {
  const trial = await configureTrial();
  if (process.argv.includes("--enable-browser-review")) {
    const { config, adminBase, headers } = trial;
    const clients = await trialJson(
      `${adminBase}/clients?clientId=${encodeURIComponent(config.publicClientId)}`,
      { headers },
    );
    if (
      clients.length !== 1 ||
      config.issuer !== "https://localhost:8443/realms/longball-fictional"
    )
      throw new Error("Use only the exact isolated fictional provider client.");
    const client = await trialJson(`${adminBase}/clients/${clients[0].id}`, {
      headers,
    });
    const origin = identityTrialAppUrl(),
      redirect = `${origin}/`;
    await trialJson(`${adminBase}/clients/${client.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        redirectUris: [...new Set([...client.redirectUris, redirect])],
        webOrigins: [...new Set([...client.webOrigins, origin])],
      }),
    });
    console.log(
      "Registered only the selected exact localhost callback and web origin for the isolated browser review.",
    );
  }
  if (process.argv.includes("--reenrol-fictional-manager")) {
    const { config, adminBase, headers } = trial;
    if (config.issuer !== "https://localhost:8443/realms/longball-fictional")
      throw new Error(
        "This command is restricted to the exact isolated fictional realm.",
      );
    const fixture = await trialJson(
      `${adminBase}/users/${config.adultSubject}`,
      { headers },
    );
    if (
      fixture.username !== "fictional.manager" ||
      fixture.attributes?.["longball.classification"]?.[0] !==
        "adult_individual"
    )
      throw new Error("Refusing to reset a different provider identity.");
    const credentials = await trialJson(
      `${adminBase}/users/${config.adultSubject}/credentials`,
      { headers },
    );
    for (const credential of credentials)
      if (credential.type === "otp" || credential.type.startsWith("recovery"))
        await trialJson(
          `${adminBase}/users/${config.adultSubject}/credentials/${credential.id}`,
          { method: "DELETE", headers },
        );
    await trialJson(`${adminBase}/users/${config.adultSubject}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        requiredActions: ["CONFIGURE_TOTP", "CONFIGURE_RECOVERY_AUTHN_CODES"],
      }),
    });
    console.log(
      "Only the locally generated fictional manager is ready to enroll a new authenticator. Read its private manager-fixture.json in an editor; credentials are not printed. No real household recovery was performed.",
    );
  }
  console.log(
    "Configured exact fictional realm username-only profile using temporary bootstrap service credentials. No secrets printed; recovery authority remains disabled.",
  );
}
