import type { Membership, Principal } from "./access";

export interface OidcClientConfig {
  issuer: string;
  clientId: string;
  redirectUri: string;
  apiBaseUrl: string;
}
export interface OidcDiscovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  revocationEndpoint?: string;
}
export interface AuthorizationTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  issuer: string;
  clientId: string;
  createdAtMs: number;
  expiresAtMs: number;
}
export interface BoundIdClaims {
  issuer: string;
  subject: string;
  expiresAtMs: number;
  nonce: string;
}
export interface ConnectedSession {
  version: 1;
  sessionId: string;
  config: OidcClientConfig;
  accessToken: string;
  refreshToken?: string;
  identityNonce: string;
  expiresAtMs: number;
  verifiedAtMs: number;
  principal: Principal;
  memberships: Membership[];
  /** API identity is signature-verified server-side; this client never grants roles from decoded token claims. */
  source: "oidc_code_pkce";
}
export interface PinRecord {
  version: 1;
  accountId: string;
  sessionId: string;
  salt: string;
  verifier: string;
  failedAttempts: number;
  lastAttemptAtMs: number | null;
  blockedUntilMs: number;
  requireStrongSignIn: boolean;
}
export const PIN_FAILURE_LIMIT = 5;
/** SEC05's five-attempt convenience policy remains a documented pilot proposal, not a remote credential policy. */
export const PIN_RETRY_DELAY_MS = 30_000;
function requireThat(condition: unknown, text: string): asserts condition {
  if (!condition) throw new Error(text);
}
function https(value: unknown, label: string): string {
  requireThat(
    typeof value === "string" && value.length <= 2048,
    `${label} must be a configured HTTPS URL.`,
  );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a configured HTTPS URL.`);
  }
  requireThat(
    url.protocol === "https:" && !url.username && !url.password && !url.hash,
    `${label} must use HTTPS without credentials or a fragment.`,
  );
  return value;
}
export function validateOidcConfig(config: OidcClientConfig): void {
  https(config.issuer, "OIDC issuer");
  https(config.apiBaseUrl, "LongBall API");
  requireThat(
    !new URL(config.issuer).search && !new URL(config.apiBaseUrl).search,
    "Issuer and API base URLs cannot contain a query.",
  );
  requireThat(
    config.clientId.trim().length > 0 && config.clientId.length <= 200,
    "Configure the public OIDC client identifier.",
  );
  let redirect: URL;
  try {
    redirect = new URL(config.redirectUri);
  } catch {
    throw new Error("Configure the exact registered sign-in redirect.");
  }
  requireThat(
    !redirect.username &&
      !redirect.password &&
      !redirect.hash &&
      !redirect.search &&
      !["javascript:", "data:", "file:"].includes(redirect.protocol),
    "Use an exact registered application or HTTPS redirect without query or fragment.",
  );
  requireThat(
    redirect.protocol !== "http:" ||
      ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname),
    "HTTP redirects are limited to the local browser development origin.",
  );
}
export function validateDiscovery(
  config: OidcClientConfig,
  value: unknown,
): OidcDiscovery {
  validateOidcConfig(config);
  requireThat(
    value && typeof value === "object" && !Array.isArray(value),
    "The issuer discovery document is invalid.",
  );
  const document = value as Record<string, unknown>;
  requireThat(
    document.issuer === config.issuer,
    "The discovered issuer does not match the configured issuer.",
  );
  requireThat(
    Array.isArray(document.code_challenge_methods_supported) &&
      document.code_challenge_methods_supported.includes("S256"),
    "This issuer must explicitly support PKCE S256.",
  );
  requireThat(
    !Array.isArray(document.response_types_supported) ||
      document.response_types_supported.includes("code"),
    "The issuer does not support authorization code sign-in.",
  );
  return {
    issuer: config.issuer,
    authorizationEndpoint: https(
      document.authorization_endpoint,
      "Authorization endpoint",
    ),
    tokenEndpoint: https(document.token_endpoint, "Token endpoint"),
    jwksUri: https(document.jwks_uri, "JWKS endpoint"),
    ...(document.revocation_endpoint
      ? {
          revocationEndpoint: https(
            document.revocation_endpoint,
            "Revocation endpoint",
          ),
        }
      : {}),
  };
}
export function base64Url(bytes: Uint8Array): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index],
      b = bytes[index + 1],
      c = bytes[index + 2];
    const bits = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    encoded += alphabet[(bits >>> 18) & 63] + alphabet[(bits >>> 12) & 63];
    if (b !== undefined) encoded += alphabet[(bits >>> 6) & 63];
    if (c !== undefined) encoded += alphabet[bits & 63];
  }
  return encoded;
}
export async function pkceS256(
  verifier: string,
  hash: (value: string) => Promise<Uint8Array>,
): Promise<string> {
  requireThat(
    /^[A-Za-z0-9._~-]{43,128}$/.test(verifier),
    "PKCE requires a random verifier of 43–128 allowed characters.",
  );
  const digest = await hash(verifier);
  requireThat(digest.length === 32, "PKCE S256 requires a 256-bit digest.");
  return base64Url(digest);
}
export function assertAuthorizationReturn(
  transaction: AuthorizationTransaction,
  result: { state?: string; code?: string; error?: string },
  nowMs: number,
) {
  requireThat(
    nowMs >= transaction.createdAtMs - 30_000 &&
      nowMs < transaction.expiresAtMs,
    "The sign-in request expired or its time changed. Prepare a new sign-in.",
  );
  requireThat(
    !result.error &&
      typeof result.state === "string" &&
      constantTimeEqual(result.state, transaction.state),
    "Sign-in state did not match. No session was created.",
  );
  requireThat(
    typeof result.code === "string" &&
      result.code.length > 0 &&
      result.code.length <= 8192,
    "The provider did not return a valid authorization code.",
  );
}
function decodeJwtPayload(token: string): Record<string, unknown> {
  requireThat(
    typeof token === "string" && token.length <= 32_768,
    "The identity token is invalid.",
  );
  const segments = token.split(".");
  requireThat(
    segments.length === 3 &&
      segments.every((segment) => /^[A-Za-z0-9_-]+$/.test(segment)),
    "The identity token is malformed.",
  );
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let bits = 0,
    count = 0;
  const bytes: number[] = [];
  for (const character of segments[1]) {
    bits = (bits << 6) | alphabet.indexOf(character);
    count += 6;
    if (count >= 8) {
      count -= 8;
      bytes.push((bits >>> count) & 255);
    }
  }
  try {
    const value: unknown = JSON.parse(
      decodeURIComponent(
        bytes.map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join(""),
      ),
    );
    requireThat(
      value && typeof value === "object" && !Array.isArray(value),
      "The identity claims are invalid.",
    );
    return value as Record<string, unknown>;
  } catch {
    throw new Error("The identity claims could not be read.");
  }
}
/** Nonce/audience binding only. API-side signature verification remains mandatory for authority. */
function bindTokenClaims(
  token: string,
  transaction: AuthorizationTransaction,
  nowMs: number,
  allowOmittedRefreshNonce = false,
): BoundIdClaims {
  const claims = decodeJwtPayload(token);
  const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
  requireThat(
    claims.iss === transaction.issuer &&
      typeof claims.sub === "string" &&
      claims.sub.length > 0,
    "The identity token issuer or subject did not match.",
  );
  requireThat(
    Array.isArray(audiences) &&
      audiences.every((value) => typeof value === "string") &&
      audiences.includes(transaction.clientId),
    "The identity token has a different audience.",
  );
  requireThat(
    audiences.length === 1 || claims.azp === transaction.clientId,
    "A multi-audience identity token must identify this authorized client.",
  );
  requireThat(
    claims.azp === undefined || claims.azp === transaction.clientId,
    "The identity token names a different authorized client.",
  );
  requireThat(
    (allowOmittedRefreshNonce && claims.nonce === undefined) ||
      (typeof claims.nonce === "string" &&
        constantTimeEqual(claims.nonce, transaction.nonce)),
    "The identity token nonce did not match.",
  );
  requireThat(
    typeof claims.exp === "number" &&
      Number.isFinite(claims.exp) &&
      claims.exp * 1000 > nowMs,
    "The identity token expired.",
  );
  requireThat(
    typeof claims.iat === "number" &&
      Number.isFinite(claims.iat) &&
      claims.iat >= 0 &&
      claims.iat * 1000 <= nowMs + 30_000,
    "The identity token issue time is invalid.",
  );
  if (claims.nbf !== undefined)
    requireThat(
      typeof claims.nbf === "number" && claims.nbf * 1000 <= nowMs,
      "The identity token is not active yet.",
    );
  return {
    issuer: claims.iss,
    subject: claims.sub,
    expiresAtMs: claims.exp * 1000,
    nonce: transaction.nonce,
  };
}
export function bindIdToken(
  token: string,
  transaction: AuthorizationTransaction,
  nowMs: number,
): BoundIdClaims {
  return bindTokenClaims(token, transaction, nowMs);
}
export function bindRefreshedIdToken(
  token: string,
  session: ConnectedSession,
  nowMs: number,
): BoundIdClaims {
  const identity = bindTokenClaims(
    token,
    {
      issuer: session.config.issuer,
      clientId: session.config.clientId,
      nonce: session.identityNonce,
    } as AuthorizationTransaction,
    nowMs,
    true,
  );
  requireThat(
    identity.subject === session.principal.subject,
    "Refresh returned a different account subject. Sign in again.",
  );
  return identity;
}
export function bindApiIdentity(
  identity: BoundIdClaims,
  value: unknown,
): { principal: Principal; memberships: Membership[]; serverTimeMs: number } {
  requireThat(
    value && typeof value === "object" && !Array.isArray(value),
    "The API identity response is invalid.",
  );
  const response = value as Record<string, unknown>;
  const principal = response.principal as Principal | undefined;
  requireThat(
    principal &&
      principal.issuer === identity.issuer &&
      principal.subject === identity.subject &&
      typeof principal.accountId === "string" &&
      principal.accountId.length > 0 &&
      principal.status === "active",
    "The API could not bind the current application account to this identity.",
  );
  requireThat(
    ["child_shared", "adult_individual", "unclassified"].includes(
      principal.identityClassification,
    ) &&
      typeof principal.adultVerified === "boolean" &&
      typeof principal.strongAuth === "boolean",
    "The API did not return verified account classification and authentication strength.",
  );
  requireThat(
    typeof principal.authenticatedAt === "number" &&
      Number.isFinite(principal.authenticatedAt) &&
      principal.authenticatedAt >= 0,
    "The API did not provide a valid authentication time.",
  );
  requireThat(
    Array.isArray(response.memberships) &&
      response.memberships.every(
        (membership) =>
          membership &&
          typeof membership === "object" &&
          (membership as Membership).accountId === principal.accountId &&
          typeof (membership as Membership).teamId === "string" &&
          typeof (membership as Membership).seasonId === "string" &&
          ["manager", "player", "spectator", "administrator"].includes(
            (membership as Membership).role,
          ),
      ),
    "The API memberships are invalid for this account.",
  );
  const serverTimeMs =
    typeof response.serverTime === "string"
      ? Date.parse(response.serverTime)
      : NaN;
  requireThat(
    Number.isFinite(serverTimeMs),
    "The API must supply its current verification time.",
  );
  requireThat(
    principal.authenticatedAt <= serverTimeMs + 30_000,
    "The API authentication time is unexpectedly in the future.",
  );
  requireThat(
    identity.expiresAtMs > serverTimeMs,
    "The identity expired before the API verified it.",
  );
  return {
    principal,
    memberships: response.memberships as Membership[],
    serverTimeMs,
  };
}
export function sessionIsCurrent(
  session: ConnectedSession | null,
  nowMs: number,
): session is ConnectedSession {
  return Boolean(
    session &&
      session.source === "oidc_code_pkce" &&
      session.principal.status === "active" &&
      nowMs >= session.verifiedAtMs - 30_000 &&
      nowMs < session.expiresAtMs,
  );
}
export function sessionCanManage(
  session: ConnectedSession,
  teamId: string,
  seasonId: string,
  nowMs: number,
): boolean {
  return (
    sessionIsCurrent(session, nowMs) &&
    session.principal.identityClassification === "adult_individual" &&
    session.principal.adultVerified &&
    session.principal.strongAuth &&
    session.memberships.some(
      (item) =>
        item.accountId === session.principal.accountId &&
        item.teamId === teamId &&
        item.seasonId === seasonId &&
        item.role === "manager" &&
        item.revokedAt == null &&
        (item.expiresAt == null || item.expiresAt > nowMs),
    )
  );
}
/** A new password-only session cannot bypass a retained device PIN lockout. */
export function assertPinSignInAllowed(
  session: ConnectedSession,
  previous: PinRecord | null,
): void {
  if (!previous) return;
  requireThat(
    previous.accountId === session.principal.accountId,
    "The retained PIN belongs to a different application account.",
  );
  if (
    previous.requireStrongSignIn ||
    previous.failedAttempts >= PIN_FAILURE_LIMIT
  )
    requireThat(
      session.principal.strongAuth &&
        session.principal.authenticatedAt >= (previous.lastAttemptAtMs ?? 0),
      "Five failed PIN attempts require a newly verified strong sign-in before this account can unlock on this device.",
    );
}
/** Any retained PIN starts locked after process launch, including a mismatched old binding. */
export function sessionLoadsUnlocked(
  session: ConnectedSession | null,
  previous: PinRecord | null,
): boolean {
  return Boolean(session && !previous);
}
export function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1)
    difference |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return difference === 0;
}
export function assertPinEnrollment(
  session: ConnectedSession | null,
  pin: string,
  nowMs: number,
  previous: PinRecord | null,
): asserts session is ConnectedSession {
  requireThat(
    sessionIsCurrent(session, nowMs),
    "Sign in to an active application session before enabling a local PIN.",
  );
  requireThat(
    /^\d{4}$/.test(pin),
    "Choose exactly four digits for the optional local unlock PIN.",
  );
  requireThat(
    !previous ||
      previous.failedAttempts === 0 ||
      (session.principal.strongAuth &&
        session.principal.authenticatedAt >= (previous.lastAttemptAtMs ?? 0)),
    "Resetting failed PIN attempts requires a newly verified strong sign-in.",
  );
}
/** Reserve durably before checking a PIN, so a process kill cannot erase an attempted guess. */
export function reservePinAttempt(
  record: PinRecord,
  session: ConnectedSession | null,
  nowMs: number,
): PinRecord {
  requireThat(
    sessionIsCurrent(session, nowMs) &&
      session.sessionId === record.sessionId &&
      session.principal.accountId === record.accountId,
    "A local PIN cannot create, renew or extend a remote session. Sign in again.",
  );
  requireThat(
    !record.requireStrongSignIn && record.failedAttempts < PIN_FAILURE_LIMIT,
    "A full strong sign-in is required after five failed PIN attempts.",
  );
  requireThat(
    record.lastAttemptAtMs === null || nowMs >= record.lastAttemptAtMs,
    "The device clock changed. Use full sign-in before another PIN attempt.",
  );
  requireThat(
    nowMs >= record.blockedUntilMs,
    "Wait for the local PIN retry delay before trying again.",
  );
  const failedAttempts = record.failedAttempts + 1;
  return {
    ...record,
    failedAttempts,
    lastAttemptAtMs: nowMs,
    blockedUntilMs: nowMs + PIN_RETRY_DELAY_MS,
    requireStrongSignIn: failedAttempts >= PIN_FAILURE_LIMIT,
  };
}
export function completePinAttempt(
  previous: PinRecord,
  reserved: PinRecord,
  matched: boolean,
): PinRecord {
  requireThat(
    reserved.sessionId === previous.sessionId &&
      reserved.failedAttempts === previous.failedAttempts + 1,
    "The PIN attempt sequence is invalid.",
  );
  return matched
    ? {
        ...reserved,
        failedAttempts: previous.failedAttempts,
        blockedUntilMs: 0,
        requireStrongSignIn: previous.requireStrongSignIn,
      }
    : reserved;
}
