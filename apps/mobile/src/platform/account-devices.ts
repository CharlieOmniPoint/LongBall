import { Platform } from "react-native";
import { createAccountDevicesClient } from "./account-devices-core";
import { accountDeviceId } from "./auth/account-device-id";
import {
  connectedFetch,
  getConnectedSessionSummary,
  type ConnectedSessionSummary,
} from "./auth/client";
export function connectedAccountDevicesClient(
  session: ConnectedSessionSummary,
) {
  const base = session.config.apiBaseUrl.replace(/\/$/, "");
  const client = createAccountDevicesClient({
    accountId: session.accountId,
    request: (init) =>
      connectedFetch(
        `${base}${base.endsWith("/v1") ? "" : "/v1"}/identity/devices`,
        init,
      ),
    assertCurrent: async () => {
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
        throw new Error("Account session changed.");
    },
  });
  return {
    ...client,
    registerCurrent: async () => {
      if (Platform.OS !== "ios" && Platform.OS !== "android")
        throw new Error(
          "Only native app installations register here. Browser access remains in memory.",
        );
      return client.register(
        await accountDeviceId(session.issuer, session.accountId),
        Platform.OS,
      );
    },
  };
}
