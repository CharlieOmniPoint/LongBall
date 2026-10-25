import * as Notifications from "expo-notifications";
import { IosAuthorizationStatus } from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { Platform } from "react-native";
import {
  connectedFetch,
  getConnectedSessionSummary,
  type ConnectedSessionSummary,
} from "./auth/client";
import { accountDeviceId } from "./auth/account-device-id";
import { connectedAccountDevicesClient } from "./account-devices";
import {
  createNativePushClient,
  type NativePushPermission,
} from "./push-registration-core";
import { createProtectedPushPendingStore } from "./push-pending-store";
import appConfiguration from "../../app.json";
const scopeQueues = new Map<string, Promise<unknown>>();

export async function connectedNativePushClient(
  session: ConnectedSessionSummary,
) {
  if (Platform.OS !== "ios" && Platform.OS !== "android")
    throw new Error(
      "Native push registration is unavailable in browser review.",
    );
  const platform = Platform.OS,
    base = session.config.apiBaseUrl.replace(/\/$/, ""),
    deviceId = await accountDeviceId(session.issuer, session.accountId);
  const assertCurrent = async () => {
    const current = await getConnectedSessionSummary();
    if (
      !current ||
      current.issuer !== session.issuer ||
      current.accountId !== session.accountId ||
      current.sessionId !== session.sessionId ||
      current.config.apiBaseUrl !== session.config.apiBaseUrl ||
      current.locked ||
      current.expired ||
      current.expiresAtMs <= Date.now()
    )
      throw new Error("PUSH_CONTEXT_CHANGED");
  };
  await assertCurrent();
  const scope = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    JSON.stringify([session.issuer, session.accountId, deviceId, base]),
  );
  const protectedOptions = {
    keychainService: "longball-push-pending",
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  };
  const pending = createProtectedPushPendingStore(
    {
      get: (key) => SecureStore.getItemAsync(key, protectedOptions),
      set: (key, value) =>
        SecureStore.setItemAsync(key, value, protectedOptions),
      remove: (key) => SecureStore.deleteItemAsync(key, protectedOptions),
    },
    `longball.push.${scope}`,
    Crypto.randomUUID,
  );
  return createNativePushClient({
    accountId: session.accountId,
    deviceId,
    platform,
    appBuild:
      process.env.EXPO_PUBLIC_APP_BUILD ?? appConfiguration.expo.version,
    assertCurrent,
    enrol: async () => {
      await connectedAccountDevicesClient(session).registerCurrent();
    },
    nextId: Crypto.randomUUID,
    pending,
    serialize: (work) => {
      const next = (scopeQueues.get(scope) ?? Promise.resolve())
        .catch(() => {})
        .then(work);
      scopeQueues.set(scope, next);
      void next
        .finally(() => {
          if (scopeQueues.get(scope) === next) scopeQueues.delete(scope);
        })
        .catch(() => {});
      return next;
    },
    request: (path, init) =>
      connectedFetch(
        `${base}${base.endsWith("/v1") ? "" : "/v1"}${path}`,
        init,
      ),
    permission: async (request) => {
      if (request && platform === "android")
        await Notifications.setNotificationChannelAsync(
          "longball-team-updates",
          { name: "LongBall team updates", importance: 3 },
        );
      const permission = request
        ? await Notifications.requestPermissionsAsync({
            ios: { allowAlert: true, allowBadge: false, allowSound: true },
          })
        : await Notifications.getPermissionsAsync();
      const value: NativePushPermission =
        permission.ios?.status === IosAuthorizationStatus.PROVISIONAL
          ? "provisional"
          : permission.granted
            ? "granted"
            : permission.status === "undetermined"
              ? "not_requested"
              : "denied";
      return value;
    },
    token: async (policy) => {
      if (platform === "android")
        await Notifications.setNotificationChannelAsync(
          "longball-team-updates",
          { name: "LongBall team updates", importance: 3 },
        );
      await assertCurrent();
      try {
        if (policy.transport === "expo") {
          if (!policy.projectId) throw new Error("PUSH_NOT_CONFIGURED");
          const token = await Notifications.getExpoPushTokenAsync({
            projectId: policy.projectId,
          });
          await assertCurrent();
          return { transport: "expo", token: token.data };
        }
        const token = await Notifications.getDevicePushTokenAsync();
        await assertCurrent();
        if (token.type !== platform || typeof token.data !== "string")
          throw new Error("PUSH_NATIVE_TOKEN_UNAVAILABLE");
        return {
          transport: platform === "ios" ? "apns" : "fcm",
          token: token.data,
        };
      } catch {
        throw new Error("PUSH_NATIVE_TOKEN_UNAVAILABLE");
      }
    },
  });
}
export function subscribeNativePushRotation(listener: () => void) {
  const subscription = Notifications.addPushTokenListener(() => listener());
  return () => subscription.remove();
}
