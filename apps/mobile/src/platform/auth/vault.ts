import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import {
  validateOidcConfig,
  type ConnectedSession,
  type PinRecord,
} from "@longball/application/security";

const options: SecureStore.SecureStoreOptions = {
  keychainService: "longball-connected-identity",
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
const credentialKey = "longball.auth.connected-session.v1";
export const credentialStorage = "secure-native" as const;
async function pinKey(accountId: string) {
  return `longball.auth.local-pin.${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, accountId)}`;
}
export async function readCredential(): Promise<ConnectedSession | null> {
  const value = await SecureStore.getItemAsync(credentialKey, options);
  if (!value) return null;
  const parsed = JSON.parse(value) as ConnectedSession;
  if (
    parsed.version !== 1 ||
    parsed.source !== "oidc_code_pkce" ||
    !parsed.principal ||
    typeof parsed.principal.accountId !== "string" ||
    !Array.isArray(parsed.memberships) ||
    typeof parsed.accessToken !== "string" ||
    typeof parsed.identityNonce !== "string" ||
    parsed.identityNonce.length < 43 ||
    !Number.isFinite(parsed.expiresAtMs) ||
    !Number.isFinite(parsed.verifiedAtMs)
  )
    throw new Error(
      "The stored sign-in could not be read. The match journal was retained; sign in again.",
    );
  validateOidcConfig(parsed.config);
  return parsed;
}
export async function writeCredential(
  session: ConnectedSession,
): Promise<void> {
  await SecureStore.setItemAsync(
    credentialKey,
    JSON.stringify(session),
    options,
  );
}
export async function clearCredential(): Promise<void> {
  await SecureStore.deleteItemAsync(credentialKey, options);
}
export async function readPin(accountId: string): Promise<PinRecord | null> {
  const value = await SecureStore.getItemAsync(
    await pinKey(accountId),
    options,
  );
  if (!value) return null;
  const parsed = JSON.parse(value) as PinRecord;
  if (
    parsed.version !== 1 ||
    parsed.accountId !== accountId ||
    typeof parsed.sessionId !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(parsed.salt) ||
    !/^[a-f0-9]{64}$/.test(parsed.verifier) ||
    !Number.isInteger(parsed.failedAttempts) ||
    parsed.failedAttempts < 0 ||
    parsed.failedAttempts > 5 ||
    typeof parsed.requireStrongSignIn !== "boolean" ||
    !Number.isFinite(parsed.blockedUntilMs) ||
    parsed.blockedUntilMs < 0 ||
    (parsed.lastAttemptAtMs !== null &&
      (!Number.isFinite(parsed.lastAttemptAtMs) || parsed.lastAttemptAtMs < 0))
  )
    throw new Error(
      "The local unlock record needs a full sign-in. No match data was removed.",
    );
  return parsed;
}
export async function writePin(pin: PinRecord): Promise<void> {
  await SecureStore.setItemAsync(
    await pinKey(pin.accountId),
    JSON.stringify(pin),
    options,
  );
}
export async function clearPin(accountId: string): Promise<void> {
  await SecureStore.deleteItemAsync(await pinKey(accountId), options);
}
