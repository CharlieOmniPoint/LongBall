import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConnectedSession,
  PinRecord,
} from "@longball/application/security";

const mocks = vi.hoisted(() => ({
  credential: null as ConnectedSession | null,
  pin: null as PinRecord | null,
  readCredential: vi.fn(),
  writeCredential: vi.fn(),
  clearCredential: vi.fn(),
  readPin: vi.fn(),
  writePin: vi.fn(),
  refresh: vi.fn(),
  revoke: vi.fn(),
  digest: vi.fn(),
}));
vi.mock("react-native", () => ({ Platform: { OS: "web" } }));
vi.mock("expo-web-browser", () => ({ maybeCompleteAuthSession: vi.fn() }));
vi.mock("expo-auth-session", () => ({
  refreshAsync: mocks.refresh,
  revokeAsync: mocks.revoke,
}));
vi.mock("expo-crypto", () => ({
  digestStringAsync: mocks.digest,
  CryptoDigestAlgorithm: { SHA256: "SHA256" },
}));
vi.mock("./vault", () => ({
  credentialStorage: "secure-native",
  readCredential: mocks.readCredential,
  writeCredential: mocks.writeCredential,
  clearCredential: mocks.clearCredential,
  readPin: mocks.readPin,
  writePin: mocks.writePin,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const issuer = "https://identity.example";
const api = "https://api.example";
const discovery = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  jwks_uri: `${issuer}/keys`,
  revocation_endpoint: `${issuer}/revoke`,
  code_challenge_methods_supported: ["S256"],
  response_types_supported: ["code"],
};
function credential(): ConnectedSession {
  const now = Date.now();
  return {
    version: 1,
    sessionId: "enrolled-test-session",
    source: "oidc_code_pkce",
    config: {
      issuer,
      clientId: "longball",
      apiBaseUrl: api,
      redirectUri: "longball://auth/callback",
    },
    accessToken: "fictional-unit-test-credential",
    refreshToken: "fictional-unit-test-refresh",
    identityNonce: "n".repeat(43),
    expiresAtMs: now + 120_000,
    verifiedAtMs: now,
    principal: {
      accountId: "unit-test-account",
      issuer,
      subject: "unit-test-subject",
      identityClassification: "adult_individual",
      adultVerified: true,
      strongAuth: true,
      authenticatedAt: now,
      status: "active",
    },
    memberships: [],
  };
}
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.credential = credential();
  mocks.pin = null;
  mocks.readCredential.mockImplementation(async () => mocks.credential);
  mocks.writeCredential.mockImplementation(async (value) => {
    mocks.credential = value;
  });
  mocks.clearCredential.mockImplementation(async () => {
    mocks.credential = null;
  });
  mocks.readPin.mockImplementation(async () => mocks.pin);
  mocks.writePin.mockImplementation(async (value) => {
    mocks.pin = value;
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("connected client network and local authority boundary", () => {
  it("renews a current session through the provider and API and continues ordinary authenticated requests", async () => {
    const previousRefresh = mocks.credential!.refreshToken;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith(issuer)
          ? Response.json(discovery)
          : Response.json({
              principal: mocks.credential!.principal,
              memberships: [],
              serverTime: new Date().toISOString(),
            }),
      ),
    );
    mocks.refresh.mockResolvedValue({
      accessToken: "fictional-rotated-unit-credential",
      refreshToken: "fictional-rotated-unit-refresh",
      tokenType: "Bearer",
      issuedAt: Math.floor(Date.now() / 1000),
      expiresIn: 120,
    });
    const client = await import("./client");
    const summary = await client.renewConnectedSession();
    expect(summary.locked).toBe(false);
    expect(summary.expired).toBe(false);
    expect(mocks.writeCredential).toHaveBeenCalledOnce();
    expect(mocks.credential?.refreshToken === previousRefresh).toBe(false);
    expect((await client.connectedFetch(`${api}/v1/private`)).ok).toBe(true);
  });
  it("locks and returns a closed summary while an API response is still unresolved, then discards that response", async () => {
    const started = deferred<void>(),
      response = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        started.resolve();
        return response.promise;
      }),
    );
    const client = await import("./client");
    const pending = client.connectedFetch(`${api}/v1/private`);
    await started.promise;
    const changed = vi.fn();
    client.subscribeConnectedSessionChanges(changed);
    expect((await client.lockConnectedSession())?.locked).toBe(true);
    expect((await client.getConnectedSessionSummary())?.locked).toBe(true);
    expect(await client.getConnectedAccessToken()).toBeNull();
    expect(changed).toHaveBeenCalledOnce();
    const rejected = expect(pending).rejects.toThrow(
      /locked|replaced|discarded/,
    );
    response.resolve(Response.json({ private: "must-not-attach" }));
    await rejected;
  });
  it("does not block locking behind a provider refresh or adopt its late credential", async () => {
    const started = deferred<void>(),
      refreshed = deferred<{
        accessToken: string;
        tokenType: string;
        issuedAt: number;
        expiresIn: number;
      }>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(discovery)),
    );
    mocks.refresh.mockImplementation(() => {
      started.resolve();
      return refreshed.promise;
    });
    const client = await import("./client");
    const pending = client.renewConnectedSession();
    await started.promise;
    expect((await client.lockConnectedSession())?.locked).toBe(true);
    expect((await client.getConnectedSessionSummary())?.locked).toBe(true);
    const rejected = expect(pending).rejects.toThrow(
      /closed|locked|not adopted/,
    );
    refreshed.resolve({
      accessToken: "fictional-rotated-unit-credential",
      tokenType: "Bearer",
      issuedAt: Math.floor(Date.now() / 1000),
      expiresIn: 120,
    });
    await rejected;
    expect(mocks.writeCredential).not.toHaveBeenCalled();
    expect((await client.getConnectedSessionSummary())?.locked).toBe(true);
  });
  it("clears the local credential before waiting on remote revocation", async () => {
    const started = deferred<void>(),
      revoked = deferred<boolean>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(discovery)),
    );
    mocks.revoke.mockImplementation(() => {
      started.resolve();
      return revoked.promise;
    });
    const client = await import("./client");
    const pending = client.signOutConnected();
    await started.promise;
    expect(mocks.clearCredential).toHaveBeenCalledOnce();
    expect(mocks.credential).toBeNull();
    expect(await client.getConnectedSessionSummary()).toBeNull();
    expect(await client.lockConnectedSession()).toBeNull();
    revoked.resolve(false);
    expect((await pending).providerRevocation).toBe("failed");
  });
  it("does not auto-unlock when an initial vault read finishes after an explicit lock", async () => {
    const reading = deferred<ConnectedSession | null>();
    mocks.readCredential.mockImplementation(() => reading.promise);
    const client = await import("./client");
    const initial = client.getConnectedSessionSummary();
    const locking = client.lockConnectedSession();
    reading.resolve(credential());
    expect((await locking)?.locked).toBe(true);
    expect((await initial)?.locked).toBe(true);
    expect(await client.getConnectedAccessToken()).toBeNull();
  });
  it("does not let a late successful PIN attempt reopen a newer lock or erase earlier failures", async () => {
    const hashing = deferred<string>(),
      started = deferred<void>();
    mocks.pin = {
      version: 1,
      accountId: mocks.credential!.principal.accountId,
      sessionId: mocks.credential!.sessionId,
      salt: "s".repeat(43),
      verifier: "a".repeat(64),
      failedAttempts: 2,
      lastAttemptAtMs: Date.now() - 60_000,
      blockedUntilMs: 0,
      requireStrongSignIn: false,
    };
    mocks.digest.mockImplementation(() => {
      started.resolve();
      return hashing.promise;
    });
    const client = await import("./client");
    const unlocking = client.unlockConnectedSession("1234");
    await started.promise;
    expect((await client.lockConnectedSession())?.locked).toBe(true);
    const rejected = expect(unlocking).rejects.toThrow(
      /new local lock|remains closed/,
    );
    hashing.resolve("a".repeat(64));
    await rejected;
    expect((await client.getConnectedSessionSummary())?.locked).toBe(true);
    expect(mocks.pin?.failedAttempts).toBe(2);
  });
});
