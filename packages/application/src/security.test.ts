import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertAuthorizationReturn,
  assertPinEnrollment,
  assertPinSignInAllowed,
  base64Url,
  bindApiIdentity,
  bindIdToken,
  bindRefreshedIdToken,
  completePinAttempt,
  constantTimeEqual,
  PIN_RETRY_DELAY_MS,
  pkceS256,
  reservePinAttempt,
  sessionCanManage,
  sessionIsCurrent,
  sessionLoadsUnlocked,
  validateDiscovery,
  validateOidcConfig,
  type AuthorizationTransaction,
  type ConnectedSession,
  type OidcClientConfig,
  type PinRecord,
} from "./security";

const now = 1_800_000_000_000;
const config: OidcClientConfig = {
  issuer: "https://identity.example/realms/longball",
  clientId: "longball-native",
  redirectUri: "longball://auth/callback",
  apiBaseUrl: "https://api.example",
};
const transaction: AuthorizationTransaction = {
  state: "state-material-must-match",
  nonce: "independent-random-nonce",
  codeVerifier: "verifier-".repeat(8),
  issuer: config.issuer,
  clientId: config.clientId,
  redirectUri: config.redirectUri,
  createdAtMs: now,
  expiresAtMs: now + 300_000,
};
const claims = {
  iss: config.issuer,
  sub: "opaque-identity-subject",
  aud: config.clientId,
  nonce: transaction.nonce,
  iat: now / 1000,
  exp: (now + 120_000) / 1000,
};
const token = (changes: Record<string, unknown> = {}) =>
  `${Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString("base64url")}.${Buffer.from(JSON.stringify({ ...claims, ...changes })).toString("base64url")}.signature`;
function session(): ConnectedSession {
  return {
    version: 1,
    sessionId: "enrolled-session",
    config,
    source: "oidc_code_pkce",
    identityNonce: transaction.nonce,
    accessToken: "test-credential-not-a-real-token",
    expiresAtMs: now + 120_000,
    verifiedAtMs: now,
    principal: {
      accountId: "account-1",
      issuer: config.issuer,
      subject: claims.sub,
      identityClassification: "adult_individual",
      adultVerified: true,
      strongAuth: true,
      authenticatedAt: now,
      status: "active",
    },
    memberships: [
      {
        accountId: "account-1",
        teamId: "roma",
        seasonId: "2026-27",
        role: "manager",
      },
    ],
  };
}
const pinRecord = (): PinRecord => ({
  version: 1,
  accountId: "account-1",
  sessionId: "enrolled-session",
  salt: "independent-native-random-salt",
  verifier: "stored-salted-digest",
  failedAttempts: 0,
  lastAttemptAtMs: null,
  blockedUntilMs: 0,
  requireStrongSignIn: false,
});

describe("retained PIN lockout across remote sessions", () => {
  it("rejects a new weak or stale strong session before adopting its credential", () => {
    const locked = {
      ...pinRecord(),
      failedAttempts: 5,
      requireStrongSignIn: true,
      lastAttemptAtMs: now + 1_000,
    };
    const fresh = {
      ...session(),
      sessionId: "new-provider-session",
      principal: { ...session().principal, authenticatedAt: now + 2_000 },
    };
    expect(() =>
      assertPinSignInAllowed(
        {
          ...fresh,
          principal: { ...fresh.principal, strongAuth: false },
        },
        locked,
      ),
    ).toThrow(/newly verified strong sign-in/);
    expect(() =>
      assertPinSignInAllowed(
        {
          ...fresh,
          principal: { ...fresh.principal, authenticatedAt: now },
        },
        locked,
      ),
    ).toThrow(/newly verified strong sign-in/);
    expect(() => assertPinSignInAllowed(fresh, locked)).not.toThrow();
    expect(sessionLoadsUnlocked(fresh, locked)).toBe(false);
    expect(sessionLoadsUnlocked(session(), pinRecord())).toBe(false);
    expect(sessionLoadsUnlocked(fresh, null)).toBe(true);
  });
});

describe("F05 OIDC code flow and identity boundaries", () => {
  it("matches the RFC7636 S256 challenge without padding and rejects weak verifiers", async () => {
    const challenge = await pkceS256(
      "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      async (value) =>
        new Uint8Array(createHash("sha256").update(value).digest()),
    );
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(base64Url(new Uint8Array([255, 254, 253]))).toBe("__79");
    await expect(
      pkceS256("1234", async () => new Uint8Array(32)),
    ).rejects.toThrow(/43–128/);
  });
  it("rejects issuer mix-up, plaintext token/API endpoints and missing S256 support", () => {
    const document = {
      issuer: config.issuer,
      authorization_endpoint: "https://identity.example/authorize",
      token_endpoint: "https://identity.example/token",
      jwks_uri: "https://identity.example/keys",
      code_challenge_methods_supported: ["S256"],
      response_types_supported: ["code"],
    };
    expect(validateDiscovery(config, document).issuer).toBe(config.issuer);
    expect(() =>
      validateDiscovery(config, {
        ...document,
        issuer: "https://other.example",
      }),
    ).toThrow(/does not match/);
    expect(() =>
      validateDiscovery(config, {
        ...document,
        token_endpoint: "http://identity.example/token",
      }),
    ).toThrow(/HTTPS/);
    expect(() =>
      validateDiscovery(config, {
        ...document,
        code_challenge_methods_supported: ["plain"],
      }),
    ).toThrow(/S256/);
    expect(() =>
      validateOidcConfig({ ...config, apiBaseUrl: "http://api.example" }),
    ).toThrow(/HTTPS/);
    expect(() =>
      validateOidcConfig({
        ...config,
        redirectUri: "https://app.example/return?access_token=value",
      }),
    ).toThrow(/without query/);
  });
  it("requires matching state and a live single authorization transaction before exchange", () => {
    expect(() =>
      assertAuthorizationReturn(
        transaction,
        { state: transaction.state, code: "one-time-code" },
        now + 1000,
      ),
    ).not.toThrow();
    expect(() =>
      assertAuthorizationReturn(
        transaction,
        { state: "foreign-state", code: "one-time-code" },
        now + 1000,
      ),
    ).toThrow(/state/);
    expect(() =>
      assertAuthorizationReturn(
        transaction,
        { state: transaction.state, code: "one-time-code" },
        now + 300_000,
      ),
    ).toThrow(/expired/);
    expect(() =>
      assertAuthorizationReturn(
        transaction,
        { state: transaction.state, code: "one-time-code" },
        now - 60_000,
      ),
    ).toThrow(/time changed/);
  });
  it("checks issuer, client audience, nonce, expiry and authorized-party binding", () => {
    expect(bindIdToken(token(), transaction, now).subject).toBe(claims.sub);
    expect(() =>
      bindIdToken(token({ iss: "https://other.example" }), transaction, now),
    ).toThrow(/issuer/);
    expect(() =>
      bindIdToken(token({ nonce: "old-request" }), transaction, now),
    ).toThrow(/nonce/);
    expect(() =>
      bindIdToken(token({ exp: now / 1000 }), transaction, now),
    ).toThrow(/expired/);
    expect(() =>
      bindIdToken(token({ aud: "another-client" }), transaction, now),
    ).toThrow(/audience/);
    expect(() =>
      bindIdToken(
        token({ aud: [config.clientId, "other-client"] }),
        transaction,
        now,
      ),
    ).toThrow(/authorized client/);
    expect(() =>
      bindIdToken(token({ azp: "another-client" }), transaction, now),
    ).toThrow(/authorized client/);
  });
  it("binds account authority only to the API principal and never a token role or profile age", () => {
    const identity = bindIdToken(
      token({ role: "administrator", adultVerified: true, age: 99 }),
      transaction,
      now,
    );
    const verified = session();
    const response = {
      principal: {
        ...verified.principal,
        identityClassification: "child_shared",
        adultVerified: false,
        strongAuth: true,
      },
      memberships: verified.memberships,
      serverTime: new Date(now).toISOString(),
    };
    const result = bindApiIdentity(identity, response);
    const childSession = {
      ...verified,
      principal: result.principal,
      memberships: result.memberships,
    };
    expect(sessionCanManage(childSession, "roma", "2026-27", now)).toBe(false);
    expect(() =>
      bindApiIdentity(identity, {
        ...response,
        principal: { ...response.principal, subject: "someone-else" },
      }),
    ).toThrow(/bind/);
    expect(() =>
      bindApiIdentity(identity, {
        ...response,
        memberships: [
          { ...verified.memberships[0], accountId: "another-account" },
        ],
      }),
    ).toThrow(/memberships/);
  });
  it("cannot extend expiry or manager scope using a role selector or cached expired membership", () => {
    const connected = session();
    expect(sessionCanManage(connected, "roma", "2026-27", now)).toBe(true);
    expect(sessionCanManage(connected, "another-team", "2026-27", now)).toBe(
      false,
    );
    expect(sessionCanManage(connected, "roma", "2027-28", now)).toBe(false);
    expect(
      sessionCanManage(
        {
          ...connected,
          principal: { ...connected.principal, strongAuth: false },
        },
        "roma",
        "2026-27",
        now,
      ),
    ).toBe(false);
    expect(
      sessionCanManage(
        {
          ...connected,
          memberships: [{ ...connected.memberships[0], revokedAt: now }],
        },
        "roma",
        "2026-27",
        now,
      ),
    ).toBe(false);
    expect(sessionIsCurrent(connected, connected.expiresAtMs)).toBe(false);
    expect(sessionIsCurrent(connected, now - 60_000)).toBe(false);
  });
  it("accepts a refresh identity without a new nonce but rejects changed subjects or conflicting nonce", () => {
    expect(
      bindRefreshedIdToken(token({ nonce: undefined }), session(), now).subject,
    ).toBe(claims.sub);
    expect(() =>
      bindRefreshedIdToken(token({ nonce: "different-nonce" }), session(), now),
    ).toThrow(/nonce/);
    expect(() =>
      bindRefreshedIdToken(token({ sub: "another-subject" }), session(), now),
    ).toThrow(/different account/);
  });
});

describe("SEC05 local PIN scope and durable throttling", () => {
  it("requires an existing active session and exactly four digits; PIN never acts as remote sign-in", () => {
    expect(() => assertPinEnrollment(null, "1234", now, null)).toThrow(
      /Sign in/,
    );
    expect(() => assertPinEnrollment(session(), "123", now, null)).toThrow(
      /four digits/,
    );
    expect(() => reservePinAttempt(pinRecord(), null, now)).toThrow(
      /cannot create/,
    );
    expect(() =>
      reservePinAttempt(pinRecord(), { ...session(), expiresAtMs: now }, now),
    ).toThrow(/cannot create/);
    expect(() =>
      reservePinAttempt(
        pinRecord(),
        { ...session(), sessionId: "different-enrollment" },
        now,
      ),
    ).toThrow(/cannot create/);
  });
  it("reserves attempts before checking, survives serialize/reload, and locks after five failures", () => {
    let record = pinRecord();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const time = now + attempt * PIN_RETRY_DELAY_MS;
      const reserved = reservePinAttempt(
        record,
        { ...session(), expiresAtMs: now + 600_000 },
        time,
      );
      record = JSON.parse(
        JSON.stringify(completePinAttempt(record, reserved, false)),
      ) as PinRecord;
      expect(record.failedAttempts).toBe(attempt + 1);
    }
    expect(record.requireStrongSignIn).toBe(true);
    expect(() =>
      reservePinAttempt(
        record,
        { ...session(), expiresAtMs: now + 600_000 },
        now + 150_000,
      ),
    ).toThrow(/strong sign-in/);
  });
  it("does not reset previous failures after a correct PIN and enforces retry delay and clock rollback", () => {
    const connected = session();
    const initial = pinRecord();
    const failed = completePinAttempt(
      initial,
      reservePinAttempt(initial, connected, now),
      false,
    );
    expect(() => reservePinAttempt(failed, connected, now + 1000)).toThrow(
      /retry delay/,
    );
    const reserved = reservePinAttempt(
      failed,
      connected,
      now + PIN_RETRY_DELAY_MS,
    );
    const successful = completePinAttempt(failed, reserved, true);
    expect(successful.failedAttempts).toBe(1);
    expect(successful.blockedUntilMs).toBe(0);
    expect(() =>
      reservePinAttempt(successful, connected, now + 10_000),
    ).toThrow(/clock changed/);
    expect(() =>
      assertPinEnrollment(
        {
          ...connected,
          principal: { ...connected.principal, strongAuth: false },
        },
        "4321",
        now + 40_000,
        successful,
      ),
    ).toThrow(/newly verified strong/);
  });
  it("compares verifier values without accepting prefixes or missing bytes", () => {
    expect(constantTimeEqual("digest-abc", "digest-abc")).toBe(true);
    expect(constantTimeEqual("digest-abc", "digest-ab")).toBe(false);
    expect(constantTimeEqual("digest-abc", "digest-abd")).toBe(false);
  });
});
