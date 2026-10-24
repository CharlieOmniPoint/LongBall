import { useEffect, useMemo, useState } from "react";
import { Platform, Text, View } from "react-native";
import type { AccountDevicesDto } from "@longball/application/account-devices";
import type { ConnectedSessionSummary } from "../platform/auth/client";
import { connectedAccountDevicesClient } from "../platform/account-devices";
import { Button, Card, Notice, colors } from "../ui";
export function RecognizedDevicesPanel({
  session,
}: {
  session: ConnectedSessionSummary;
}) {
  const client = useMemo(
    () => connectedAccountDevicesClient(session),
    [session],
  );
  const [data, setData] = useState<AccountDevicesDto | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void client
      .load()
      .then((value) => {
        if (active) setData(value);
      })
      .catch(() => {
        if (active)
          setError(
            "Known app devices could not be refreshed. No registration or removal was confirmed.",
          );
      });
    return () => {
      active = false;
    };
  }, [client]);
  async function refresh(register: boolean) {
    setBusy(true);
    setError(null);
    try {
      setData(await (register ? client.registerCurrent() : client.load()));
    } catch {
      setError(
        "The service could not confirm this device inventory change. Refresh before retrying.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <Text style={{ fontSize: 18, fontWeight: "700", color: colors.ink }}>
        Recognized app devices
      </Text>
      <Text>
        These are app registrations known to LongBall for this account, not a
        complete provider session or phone inventory. Registration grants no
        role or recording control.
      </Text>
      {error && <Notice tone="warning">{error}</Notice>}
      {data && (
        <>
          <Text>Service checked {data.asOf}</Text>
          {data.devices.length === 0 && (
            <Text>No app devices registered for this account.</Text>
          )}
          {data.devices.map((device) => (
            <View key={device.deviceId} style={{ gap: 5, paddingVertical: 10 }}>
              <Text>
                {device.source === "native_app_enrolment"
                  ? "Native app registration"
                  : "Match recorder registration"}
              </Text>
              <Text>{device.deviceId}</Text>
              <Text>
                {device.platform
                  ? `${device.platform} · reported by app; not independently verified`
                  : "Platform unknown"}
              </Text>
              <Text>
                Registered:{" "}
                {device.registeredAt ??
                  "Unknown for this older recorder registration"}
              </Text>
              <Text>
              Last app registration check-in: {device.lastSeenAt ?? "Unknown"}
              </Text>
            </View>
          ))}
        </>
      )}
      <Button
        label="Refresh known app devices"
        variant="secondary"
        disabled={busy}
        onPress={() => {
          void refresh(false);
        }}
      />
      {Platform.OS !== "web" && (
        <Button
          label="Register or update this native app device"
          variant="secondary"
          disabled={busy}
          onPress={() => {
            void refresh(true);
          }}
        />
      )}
      <Text>Remote device revocation is not available here.</Text>
    </Card>
  );
}
