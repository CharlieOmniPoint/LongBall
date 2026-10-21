import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  getConnectedSessionSummary,
  subscribeConnectedSessionChanges,
  type ConnectedSessionSummary,
} from "./platform/auth/client";
import { openJournal } from "./platform/journal";
import type { Journal } from "./platform/types";
import { AccountSecurityScreen } from "./features/AccountSecurityScreen";
import { ConnectedWorkspace } from "./features/ConnectedWorkspace";
import { Button, colors, Notice } from "./ui";

/** Production builds enter verified connected journeys and never seed fictional accounts. */
export function ConnectedApplication() {
  const [session, setSession] = useState<ConnectedSessionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [account, setAccount] = useState(false);
  const [storage, setStorage] = useState<{
    journal: Journal;
    deviceId: string;
    identity: string;
  } | null>(null);
  const insets = useSafeAreaInsets();
  const [error, setError] = useState<string | null>(null);
  const [storageAttempt, setStorageAttempt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const loaded = await getConnectedSessionSummary();
        if (active) {
          setSession(loaded);
          setForeground(AppState.currentState === "active");
        }
      } catch (failure) {
        if (active) {
          setSession(null);
          setError(
            failure instanceof Error
              ? failure.message
              : "Secure sign-in could not be restored.",
          );
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    void refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      setForeground(false);
      if (state === "active") void refresh();
    });
    const unsubscribe = subscribeConnectedSessionChanges(() => {
      setSession(null);
      void refresh();
    });
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      active = false;
      subscription.remove();
      unsubscribe();
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!session || session.expiresAtMs <= Date.now()) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(2_147_483_647, session.expiresAtMs - Date.now() + 1),
    );
    return () => clearTimeout(timer);
  }, [session]);

  const identity =
    session && !session.locked && !session.expired && session.expiresAtMs > now
      ? JSON.stringify([session.issuer, session.accountId, session.sessionId])
      : null;
  useEffect(() => {
    if (!identity) return;
    let active = true;
    let opened: Journal | null = null;
    void (async () => {
      try {
        opened = await openJournal();
        const info = await opened.getDiagnostics();
        if (!active) {
          await opened.close();
          opened = null;
          return;
        }
        setStorage({ journal: opened, deviceId: info.deviceId, identity });
        setError(null);
      } catch (failure) {
        if (active)
          setError(
            failure instanceof Error
              ? failure.message
              : "Protected recording storage could not be opened. Existing records were retained.",
          );
        if (opened) {
          await opened.close();
          opened = null;
        }
      }
    })();
    return () => {
      active = false;
      if (opened) void opened.close();
    };
  }, [identity, storageAttempt]);

  return (
    <ScrollView
      contentContainerStyle={[
        styles.page,
        {
          paddingTop: Math.max(20, insets.top + 12),
          paddingBottom: insets.bottom + 24,
        },
      ]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.header}>
        <Text style={styles.brand}>LongBall</Text>
        {identity && (
          <Button
            label={account ? "Back to team" : "Account and security"}
            variant="quiet"
            onPress={() => setAccount(!account)}
          />
        )}
      </View>
      {error && <Notice tone="error">{error}</Notice>}
      {!foreground ? (
        <Notice>
          Unlock your account to continue when LongBall is active.
        </Notice>
      ) : loading ? (
        <ActivityIndicator color={colors.brand} />
      ) : !identity || account ? (
        <AccountSecurityScreen
          onSessionChange={(next) => {
            setSession(next);
            if (next && !next.locked && !next.expired) setAccount(false);
          }}
        />
      ) : !storage || storage.identity !== identity ? (
        <>
          {error ? (
            <Button
              label="Retry protected storage"
              onPress={() => setStorageAttempt((value) => value + 1)}
            />
          ) : (
            <ActivityIndicator color={colors.brand} />
          )}
        </>
      ) : (
        <ConnectedWorkspace
          key={identity}
          journal={storage.journal}
          deviceId={storage.deviceId}
          allowSynthetic={false}
        />
      )}
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  page: {
    padding: 20,
    paddingTop: 48,
    paddingBottom: 48,
    gap: 16,
    backgroundColor: colors.canvas,
    flexGrow: 1,
  },
  header: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  brand: {
    fontSize: 28,
    lineHeight: 36,
    fontWeight: "800",
    color: colors.brand,
  },
});
