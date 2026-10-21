import type { OidcClientConfig } from "@longball/application/security";
export interface InvitationProviderSetup {
  accountId: string;
  username: string;
  activationId: string;
  providerSetupUrl: string;
  expiresAt: number;
}
/** The only permitted setup metadata is one nonsecret UUID fragment on the configured provider URL. */
export function parseInvitationProviderSetup(
  value: unknown,
  config: OidcClientConfig,
  nowMs: number,
): InvitationProviderSetup {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid invitation setup response.");
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).length !== 4 ||
    Object.keys(body).some(
      (key) =>
        !["accountId", "username", "identityActionUrl", "expiresAt"].includes(
          key,
        ),
    ) ||
    typeof body.accountId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(body.accountId) ||
    typeof body.username !== "string" ||
    !/^LB[A-HJ-NP-Z2-9]{12}$/.test(body.username) ||
    typeof body.identityActionUrl !== "string" ||
    typeof body.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(body.expiresAt)) ||
    Date.parse(body.expiresAt) <= nowMs
  )
    throw new Error("Invalid invitation setup fields.");
  const url = new URL(body.identityActionUrl),
    issuer = new URL(config.issuer),
    params = new URLSearchParams(url.hash.slice(1)),
    activationId = params.get("longballActivation");
  if (
    url.protocol !== "https:" ||
    url.origin !== issuer.origin ||
    url.username ||
    url.password ||
    !url.pathname.startsWith(
      issuer.pathname.replace(/\/$/, "") + "/login-actions/",
    ) ||
    Array.from(params.keys()).length !== 1 ||
    params.getAll("longballActivation").length !== 1 ||
    !activationId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      activationId,
    )
  )
    throw new Error("Untrusted invitation credential setup.");
  url.hash = "";
  return {
    accountId: body.accountId,
    username: body.username,
    activationId,
    providerSetupUrl: url.href,
    expiresAt: Date.parse(body.expiresAt),
  };
}
