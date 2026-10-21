import * as AuthSession from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import * as Crypto from "expo-crypto";
import { Platform } from "react-native";
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
  reservePinAttempt,
  sessionIsCurrent,
  sessionLoadsUnlocked,
  validateDiscovery,
  validateOidcConfig,
  type AuthorizationTransaction,
  type ConnectedSession,
  type OidcClientConfig,
  type OidcDiscovery,
  type PinRecord,
} from "@longball/application/security";
import * as vault from "./vault";

if (Platform.OS === "web") WebBrowser.maybeCompleteAuthSession();
let activeSession: ConnectedSession | null = null;
let loaded = false;
let unlocked = false;
let authorityGeneration = 0;
let allowAutomaticUnlock = true;
let loadingCredential: Promise<void> | null = null;
let renewal: Promise<ConnectedSessionSummary> | null = null;
let queue: Promise<unknown> = Promise.resolve();
const sessionListeners = new Set<() => void>();
export function subscribeConnectedSessionChanges(
  listener: () => void,
): () => void {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}
function announceSessionChange() {
  for (const listener of sessionListeners) {
    try {
      listener();
    } catch {
      /* A view listener cannot interrupt credential state transitions. */
    }
  }
}
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work, work);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
export interface ConnectedSessionSummary {
  sessionId: string;
  config: OidcClientConfig;
  accountId: string;
  issuer: string;
  subject: string;
  expiresAtMs: number;
  identityClassification: ConnectedSession["principal"]["identityClassification"];
  adultVerified: boolean;
  strongAuth: boolean;
  memberships: ConnectedSession["memberships"];
  locked: boolean;
  expired: boolean;
  storage: "secure-native" | "memory-browser";
  pinConfigured: boolean;
  pinFailures: number;
}
export interface PreparedSignIn {
  issuer: string;
  redirectUri: string;
  expiresAtMs: number;
  continueInBrowser: () => Promise<ConnectedSessionSummary>;
}
function safeFailure(failure: unknown, fallback: string): string {
  return failure instanceof Error && failure.message.length < 300
    ? failure.message
    : fallback;
}
async function providerDeadline<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "The identity provider request timed out. Use a new sign-in or retry after checking the connection.",
              ),
            ),
          15_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function requestJson(
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? "The authenticated service rejected this session. Sign in again."
          : `The configured service could not complete sign-in (HTTP ${response.status}).`,
      );
    const value = await response.text();
    if (value.length > 128_000)
      throw new Error(
        "The authentication service response exceeded the allowed size.",
      );
    return JSON.parse(value) as unknown;
  } finally {
    clearTimeout(timer);
  }
}
async function discoveryFor(config: OidcClientConfig): Promise<OidcDiscovery> {
  validateOidcConfig(config);
  return validateDiscovery(
    config,
    await requestJson(
      `${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
      { headers: { accept: "application/json" } },
    ),
  );
}
function apiMeUrl(config: OidcClientConfig): string {
  const base = config.apiBaseUrl.replace(/\/$/, "");
  return `${base}${base.endsWith("/v1") ? "" : "/v1"}/me`;
}
async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  if (!loadingCredential) {
    const startedGeneration = authorityGeneration;
    loadingCredential = (async () => {
      const credential = await vault.readCredential();
      const pin = credential
        ? await vault.readPin(credential.principal.accountId)
        : null;
      activeSession = credential;
      unlocked =
        allowAutomaticUnlock &&
        startedGeneration === authorityGeneration &&
        sessionLoadsUnlocked(credential, pin);
      loaded = true;
    })().finally(() => {
      loadingCredential = null;
    });
  }
  await loadingCredential;
}
async function summarize(): Promise<ConnectedSessionSummary | null> {
  await ensureLoaded();
  const session = activeSession;
  if (!session) return null;
  const pin = await vault.readPin(session.principal.accountId);
  if (activeSession !== session) return null;
  return {
    sessionId: session.sessionId,
    config: session.config,
    accountId: session.principal.accountId,
    issuer: session.config.issuer,
    subject: session.principal.subject,
    expiresAtMs: session.expiresAtMs,
    identityClassification: session.principal.identityClassification,
    adultVerified: session.principal.adultVerified,
    strongAuth: session.principal.strongAuth,
    memberships: session.memberships,
    locked: !unlocked,
    expired: !sessionIsCurrent(session, Date.now()),
    storage: vault.credentialStorage,
    pinConfigured: Boolean(pin && pin.sessionId === session.sessionId),
    pinFailures: pin?.failedAttempts ?? 0,
  };
}
export function getConnectedSessionSummary(): Promise<ConnectedSessionSummary | null> {
  return summarize();
}
export function defaultAuthRedirect(): string {
  return Platform.OS === "web"
    ? `${globalThis.location.origin}/`
    : AuthSession.makeRedirectUri({
        scheme: "longball",
        path: "auth/callback",
      });
}

/** Prepare before the explicit browser button, so web popup opening remains inside a user gesture. */
export async function prepareConnectedSignIn(
  config: OidcClientConfig,
): Promise<PreparedSignIn> {
  if (Platform.OS === "web") {
    const redirect = new URL(config.redirectUri);
    if (
      redirect.origin !== globalThis.location.origin ||
      redirect.pathname !== globalThis.location.pathname
    )
      throw new Error(
        "For this browser build, register the exact current page URL as the redirect so the same-origin callback can finish.",
      );
  }
  const discovery = await discoveryFor(config);
  const state = base64Url(await Crypto.getRandomBytesAsync(32));
  const nonce = base64Url(await Crypto.getRandomBytesAsync(32));
  const request = new AuthSession.AuthRequest({
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    responseType: AuthSession.ResponseType.Code,
    usePKCE: true,
    codeChallengeMethod: AuthSession.CodeChallengeMethod.S256,
    state,
    scopes: ["openid", "profile"],
    prompt: AuthSession.Prompt.Login,
    extraParams: { nonce, max_age: "0" },
  });
  await request.makeAuthUrlAsync(discovery);
  if (!request.codeVerifier || !request.codeChallenge)
    throw new Error("PKCE setup failed. No sign-in was started.");
  const createdAtMs = Date.now();
  const transaction: AuthorizationTransaction = {
    state,
    nonce,
    codeVerifier: request.codeVerifier,
    redirectUri: config.redirectUri,
    issuer: config.issuer,
    clientId: config.clientId,
    createdAtMs,
    expiresAtMs: createdAtMs + 300_000,
  };
  let consumed = false;
  return {
    issuer: config.issuer,
    redirectUri: config.redirectUri,
    expiresAtMs: transaction.expiresAtMs,
    continueInBrowser: () => {
      if (consumed)
        return Promise.reject(
          new Error(
            "This sign-in request was already used. Prepare a new request.",
          ),
        );
      consumed = true;
      const signInGeneration = authorityGeneration;
      // No network/storage await before promptAsync: the browser opens from the user's tap.
      const prompt = request.promptAsync(discovery);
      return prompt
        .then(async (result) => {
          if (result.type !== "success")
            throw new Error(
              result.type === "cancel" || result.type === "dismiss"
                ? "Sign-in was cancelled. No connected session was created."
                : "The provider did not complete sign-in. Prepare a new request.",
            );
          assertAuthorizationReturn(transaction, result.params, Date.now());
          const token = await providerDeadline(
            AuthSession.exchangeCodeAsync(
              {
                clientId: config.clientId,
                code: result.params.code,
                redirectUri: config.redirectUri,
                extraParams: { code_verifier: transaction.codeVerifier },
              },
              discovery,
            ),
          ).catch(() => {
            throw new Error(
              "The identity provider rejected the code exchange. Prepare a new sign-in.",
            );
          });
          if (
            !token.idToken ||
            !token.accessToken ||
            typeof token.tokenType !== "string" ||
            token.tokenType.toLowerCase() !== "bearer" ||
            !token.expiresIn ||
            token.expiresIn <= 0
          )
            throw new Error(
              "The issuer did not return the required expiring OpenID session.",
            );
          const identity = bindIdToken(token.idToken, transaction, Date.now());
          if (authorityGeneration !== signInGeneration)
            throw new Error(
              "Sign-in was cancelled by a local lock or sign-out.",
            );
          const api = bindApiIdentity(
            identity,
            await requestJson(apiMeUrl(config), {
              headers: {
                authorization: `Bearer ${token.accessToken}`,
                accept: "application/json",
              },
            }),
          );
          const expiresAtMs = Math.min(
            identity.expiresAtMs,
            (token.issuedAt + token.expiresIn) * 1000,
          );
          const session: ConnectedSession = {
            version: 1,
            sessionId: Crypto.randomUUID(),
            source: "oidc_code_pkce",
            config,
            accessToken: token.accessToken,
            identityNonce: transaction.nonce,
            ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
            expiresAtMs,
            verifiedAtMs: api.serverTimeMs,
            principal: api.principal,
            memberships: api.memberships,
          };
          if (!sessionIsCurrent(session, Date.now()))
            throw new Error(
              "The device time and verified session expiry need checking before local access.",
            );
          return serialize(async () => {
            await ensureLoaded();
            if (authorityGeneration !== signInGeneration)
              throw new Error(
                "Sign-in was cancelled by a local lock or sign-out. Prepare a new sign-in.",
              );
            // Counters are not reset by a PIN or a role selector. A successful fresh strong sign-in may reset its own record.
            const previous = await vault.readPin(session.principal.accountId);
            assertPinSignInAllowed(session, previous);
            if (
              previous &&
              session.principal.strongAuth &&
              session.principal.authenticatedAt >=
                (previous.lastAttemptAtMs ?? 0)
            )
              await vault.writePin({
                ...previous,
                sessionId: session.sessionId,
                failedAttempts: 0,
                blockedUntilMs: 0,
                lastAttemptAtMs: null,
                requireStrongSignIn: false,
              });
            await vault.writeCredential(session);
            if (authorityGeneration !== signInGeneration) {
              await vault.clearCredential();
              throw new Error(
                "Sign-in was cancelled by a local lock or sign-out.",
              );
            }
            ++authorityGeneration;
            activeSession = session;
            loaded = true;
            unlocked = true;
            announceSessionChange();
            return (await summarize())!;
          });
        })
        .catch((failure) => {
          throw new Error(
            safeFailure(
              failure,
              "Sign-in could not complete. No credentials were exposed.",
            ),
          );
        });
    },
  };
}

function renewFromProvider(): Promise<ConnectedSessionSummary> {
  if (renewal) return renewal;
  const request = performRenewal();
  renewal = request;
  const clear = () => {
    if (renewal === request) renewal = null;
  };
  void request.then(clear, clear);
  return request;
}
/** Network I/O never holds the credential queue; only snapshot and guarded storage commits do. */
async function performRenewal(): Promise<ConnectedSessionSummary> {
  const context = await serialize(async () => {
    await ensureLoaded();
    const existing = activeSession;
    if (!unlocked || !existing?.refreshToken)
      throw new Error(
        "An unlocked enrolled session with a provider refresh credential is required. Use full sign-in.",
      );
    return { existing, generation: authorityGeneration };
  });
  const { existing } = context;
  const discovery = await discoveryFor(existing.config);
  const token = await providerDeadline(
    AuthSession.refreshAsync(
      {
        clientId: existing.config.clientId,
        refreshToken: existing.refreshToken,
      },
      discovery,
    ),
  ).catch(() => {
    throw new Error(
      "The provider did not renew this session. Use full sign-in.",
    );
  });
  if (
    !token.accessToken ||
    !token.expiresIn ||
    token.expiresIn <= 0 ||
    typeof token.tokenType !== "string" ||
    token.tokenType.toLowerCase() !== "bearer"
  )
    throw new Error(
      "The provider did not return a valid expiring refreshed session.",
    );
  const candidateExpiry = (token.issuedAt + token.expiresIn) * 1000;
  if (
    authorityGeneration !== context.generation ||
    activeSession !== existing ||
    !unlocked
  )
    throw new Error(
      "The session was closed while its provider request was pending. No renewed credential was adopted.",
    );
  const identity = token.idToken
    ? bindRefreshedIdToken(token.idToken, existing, Date.now())
    : {
        issuer: existing.config.issuer,
        subject: existing.principal.subject,
        expiresAtMs: candidateExpiry,
        nonce: existing.identityNonce,
      };
  const api = bindApiIdentity(
    identity,
    await requestJson(apiMeUrl(existing.config), {
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        accept: "application/json",
      },
    }),
  );
  const renewed: ConnectedSession = {
    ...existing,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken ?? existing.refreshToken,
    expiresAtMs: Math.min(candidateExpiry, identity.expiresAtMs),
    verifiedAtMs: api.serverTimeMs,
    principal: api.principal,
    memberships: api.memberships,
  };
  if (!sessionIsCurrent(renewed, Date.now()))
    throw new Error(
      "The renewed session time needs checking. Use full sign-in.",
    );
  return serialize(async () => {
    if (
      authorityGeneration !== context.generation ||
      activeSession !== existing ||
      !unlocked
    )
      throw new Error(
        "The refresh completed after this session was locked, signed out or replaced. It was not adopted.",
      );
    await vault.writeCredential(renewed);
    if (authorityGeneration !== context.generation || !unlocked) {
      await vault.clearCredential();
      throw new Error(
        "The renewed credential was closed by a local lock or sign-out.",
      );
    }
    activeSession = renewed;
    announceSessionChange();
    // Refresh rotates remote credentials; it never clears local PIN failures or creates a new authority assignment.
    return (await summarize())!;
  });
}
export function renewConnectedSession(): Promise<ConnectedSessionSummary> {
  return renewFromProvider();
}
export async function getConnectedAccessToken(): Promise<string | null> {
  const needsRenewal = await serialize(async () => {
    await ensureLoaded();
    return Boolean(
      unlocked &&
        activeSession?.refreshToken &&
        !sessionIsCurrent(activeSession, Date.now()),
    );
  });
  if (needsRenewal) {
    try {
      await renewFromProvider();
    } catch {
      return null;
    }
  }
  return serialize(async () => {
    if (!unlocked) return null;
    return sessionIsCurrent(activeSession, Date.now())
      ? activeSession.accessToken
      : null;
  });
}
export async function connectedFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  await getConnectedAccessToken();
  const context = await serialize(async () => {
    await ensureLoaded();
    const session = activeSession;
    if (!unlocked || !sessionIsCurrent(session, Date.now()))
      throw new Error("An active unlocked connected session is required.");
    const target = new URL(url),
      configured = new URL(session.config.apiBaseUrl);
    if (
      target.origin !== configured.origin ||
      !target.pathname.startsWith(configured.pathname.replace(/\/$/, "") + "/")
    )
      throw new Error(
        "Connected credentials can be sent only to the configured LongBall API.",
      );
    return { session, generation: authorityGeneration };
  });
  const stillAuthorized = () =>
    unlocked &&
    authorityGeneration === context.generation &&
    activeSession === context.session &&
    sessionIsCurrent(context.session, Date.now());
  if (!stillAuthorized())
    throw new Error(
      "The connected session changed before this request could be sent.",
    );
  const controller = new AbortController();
  const timer = init.signal
    ? null
    : setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      ...init,
      signal: init.signal ?? controller.signal,
      redirect: "error",
      headers: {
        ...Object.fromEntries(new Headers(init.headers).entries()),
        authorization: `Bearer ${context.session.accessToken}`,
      },
    });
    if (!stillAuthorized())
      throw new Error(
        "The response arrived after this session was locked, expired or replaced. Private response data was discarded.",
      );
    return response;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function pinDigest(
  pin: string,
  salt: string,
  accountId: string,
): Promise<string> {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `${salt}:${accountId}:${pin}`,
  );
}
export function enrollLocalPin(pin: string): Promise<ConnectedSessionSummary> {
  return serialize(async () => {
    await ensureLoaded();
    if (Platform.OS === "web")
      throw new Error(
        "Browser review does not offer a durable local PIN. Use a native build.",
      );
    if (!unlocked)
      throw new Error(
        "Unlock the enrolled session or complete a full sign-in before changing the local PIN.",
      );
    const previous = activeSession
      ? await vault.readPin(activeSession.principal.accountId)
      : null;
    assertPinEnrollment(activeSession, pin, Date.now(), previous);
    const salt = base64Url(await Crypto.getRandomBytesAsync(32));
    const record: PinRecord = {
      version: 1,
      accountId: activeSession.principal.accountId,
      sessionId: activeSession.sessionId,
      salt,
      verifier: await pinDigest(pin, salt, activeSession.principal.accountId),
      failedAttempts: 0,
      lastAttemptAtMs: null,
      blockedUntilMs: 0,
      requireStrongSignIn: false,
    };
    await vault.writePin(record);
    announceSessionChange();
    return (await summarize())!;
  });
}
export function lockConnectedSession(): Promise<ConnectedSessionSummary | null> {
  ++authorityGeneration;
  allowAutomaticUnlock = false;
  unlocked = false;
  announceSessionChange();
  return summarize();
}
export function unlockConnectedSession(
  pin: string,
): Promise<ConnectedSessionSummary> {
  const unlockGeneration = authorityGeneration;
  return serialize(async () => {
    await ensureLoaded();
    if (!activeSession)
      throw new Error(
        "A local PIN cannot create a connected session. Sign in first.",
      );
    const previous = await vault.readPin(activeSession.principal.accountId);
    if (!previous)
      throw new Error("No local PIN is enrolled for this account.");
    const reserved = reservePinAttempt(previous, activeSession, Date.now());
    await vault.writePin(reserved);
    const matched =
      /^\d{4}$/.test(pin) &&
      constantTimeEqual(
        await pinDigest(pin, previous.salt, previous.accountId),
        previous.verifier,
      );
    await vault.writePin(completePinAttempt(previous, reserved, matched));
    announceSessionChange();
    if (!matched)
      throw new Error(
        reserved.requireStrongSignIn
          ? "Five PIN attempts failed. Use a newly verified strong sign-in."
          : "PIN not accepted. Wait 30 seconds before another attempt.",
      );
    if (authorityGeneration !== unlockGeneration)
      throw new Error(
        "The PIN attempt completed after a new local lock or sign-out. The session remains closed.",
      );
    unlocked = true;
    announceSessionChange();
    return (await summarize())!;
  });
}
export function removeLocalPin(): Promise<ConnectedSessionSummary> {
  return serialize(async () => {
    await ensureLoaded();
    if (
      !unlocked ||
      !sessionIsCurrent(activeSession, Date.now()) ||
      !activeSession.principal.strongAuth
    )
      throw new Error(
        "Removing a local PIN requires an active unlocked strong sign-in.",
      );
    const previous = await vault.readPin(activeSession.principal.accountId);
    if (
      previous &&
      previous.failedAttempts > 0 &&
      activeSession.principal.authenticatedAt < (previous.lastAttemptAtMs ?? 0)
    )
      throw new Error(
        "A fresh strong sign-in is required before removing a PIN with failed attempts.",
      );
    await vault.clearPin(activeSession.principal.accountId);
    announceSessionChange();
    return (await summarize())!;
  });
}
export async function signOutConnected(): Promise<{
  providerRevocation: "confirmed" | "not_available" | "failed";
}> {
  ++authorityGeneration;
  allowAutomaticUnlock = false;
  unlocked = false;
  announceSessionChange();
  const session = await serialize(async () => {
    await ensureLoaded();
    const previous = activeSession;
    await vault.clearCredential();
    activeSession = null;
    loaded = true;
    announceSessionChange();
    return previous;
  });
  let providerRevocation: "confirmed" | "not_available" | "failed" =
    "not_available";
  if (session) {
    try {
      const discovery = await discoveryFor(session.config);
      if (discovery.revocationEndpoint) {
        const revoked = await providerDeadline(
          AuthSession.revokeAsync(
            {
              clientId: session.config.clientId,
              token: session.refreshToken ?? session.accessToken,
            },
            discovery,
          ),
        );
        providerRevocation = revoked ? "confirmed" : "failed";
      }
    } catch {
      providerRevocation = "failed";
    }
  }
  // Keep PIN failure records; logout must not erase a throttle. The match database key/journal are untouched.
  return { providerRevocation };
}
