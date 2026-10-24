import { useEffect, useState } from "react";
import { AppState, Text, View } from "react-native";
import type { AccountPushStatus } from "@longball/application/push-registrations";
import type { ConnectedSessionSummary } from "../platform/auth/client";
import {
  connectedNativePushClient,
  subscribeNativePushRotation,
} from "../platform/push-registration";
import { Button, Card, Notice } from "../ui/Button";
import { typography } from "../ui/tokens";
export function PushRegistrationPanel({
  session,
}: {
  session: ConnectedSessionSummary;
}) {
  const [status, setStatus] = useState<AccountPushStatus | null>(null),
    [deviceId, setDeviceId] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (session.locked || session.expired) return;
    let active = true;
    const refresh = () => {
      void connectedNativePushClient(session)
        .then(async (client) => ({
          value: await client.reconcile(),
          deviceId: client.deviceId,
        }))
        .then(({ value, deviceId }) => {
          if (active) {
            setStatus(value);
            setDeviceId(deviceId);
            setError(null);
          }
        })
        .catch(() => {
          if (active)
            setError(
              "Team push status is not confirmed. A retained protected update can be retried with this account unlocked.",
            );
        });
    };
    refresh();
    const removeRotation = subscribeNativePushRotation(refresh),
      appState = AppState.addEventListener("change", (state) => {
        if (state === "active") refresh();
      });
    return () => {
      active = false;
      removeRotation();
      appState.remove();
    };
  }, [
    session.issuer,
    session.accountId,
    session.sessionId,
    session.config.apiBaseUrl,
    session.locked,
    session.expired,
    session,
  ]);
  const run = async (action: "enable" | "disable" | "retry") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const client = await connectedNativePushClient(session);
      setStatus(await client[action]());
      setDeviceId(client.deviceId);
    } catch {
      setError(
        "Push registration was not confirmed. Existing records remain; retry the protected update while this account is unlocked.",
      );
    } finally {
      setBusy(false);
    }
  };
  const current = status?.devices.find(
    (device) => device.deviceId === deviceId,
  );
  return (
    <Card>
      <Text style={typography.section}>Team notifications on this phone</Text>
      <Text style={typography.body}>
        {status
          ? status.registrationConfigured
            ? current?.state === "registered"
              ? `This phone is registered (${current.permission}). Registration does not prove delivery.`
              : "This phone is not registered for remote team updates."
            : "Remote push registration is not configured for this service. Local match reminders remain separate."
          : "Checking this account’s push registration…"}
      </Text>
      {status && !status.deliveryConfigured && (
        <Text style={typography.muted}>
          A remote delivery provider has not been configured. No delivery is
          claimed.
        </Text>
      )}
      {error && <Notice tone="warning">{error}</Notice>}
      <View style={{ gap: 8 }}>
        <Button
          label={
            busy
              ? "Checking notification registration…"
              : "Enable team notifications"
          }
          disabled={
            busy ||
            session.locked ||
            session.expired ||
            !status?.registrationConfigured
          }
          onPress={() => {
            void run("enable");
          }}
        />
        <Button
          label="Stop team notifications on this phone"
          variant="secondary"
          disabled={busy || session.locked || session.expired}
          onPress={() => {
            void run("disable");
          }}
        />
        <Button
          label="Refresh / retry protected notification update"
          variant="quiet"
          disabled={busy || session.locked || session.expired}
          onPress={() => {
            void run("retry");
          }}
        />
      </View>
      <Text style={typography.muted}>
        Your OS controls notification permission. Schedule, match, photo and
        award preferences stay in your team settings. Browser review cannot
        register a phone token.
      </Text>
    </Card>
  );
}
