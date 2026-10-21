import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  getConnectedSessionSummary,
  subscribeConnectedSessionChanges,
  type ConnectedSessionSummary,
} from "./platform/auth/client";
import { openJournal } from "./platform/journal";
import { connectedAccountDevicesClient } from "./platform/account-devices";
import type { Journal } from "./platform/types";
import { AccountSecurityScreen } from "./features/AccountSecurityScreen";
import { ConnectedWorkspace } from "./features/ConnectedWorkspace";
import { LongBallWordmark } from "./features/EntryScreens";
import { Button, colors, Notice } from "./ui";
import {
  parseLongBallDestination,
  type LongBallDestination,
  type ActivationCompletionDestination,
  type ChildActivationDestination,
  type SpectatorInvitationDestination,
} from "@longball/application/deep-links";
import { activationRelayChannelName } from "@longball/application/activation-relay";

export interface ConnectedApplicationProps {
  visible?: boolean;
  onBackToWelcome?: () => void;
  initialIntent?: "sign-in" | "activate";
  intentRevision?: number;
  initialDestination?: LongBallDestination | null;
  onEnterFictionalReview?: () => void;
}
/** Connected journeys keep one memory boundary through welcome/account navigation. */
export function ConnectedApplication({
  visible = true,
  onBackToWelcome,
  initialIntent = "sign-in",
  intentRevision = 0,
  initialDestination,
  onEnterFictionalReview,
}: ConnectedApplicationProps = {}) {
  const [session, setSession] = useState<ConnectedSessionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [account, setAccount] = useState(initialIntent === "activate");
  const [intent, setIntent] = useState(initialIntent);
  const [seenIntent, setSeenIntent] = useState({
    initialIntent,
    intentRevision,
  });
  if (
    seenIntent.initialIntent !== initialIntent ||
    seenIntent.intentRevision !== intentRevision
  ) {
    setSeenIntent({ initialIntent, intentRevision });
    setIntent(initialIntent);
    if (initialIntent === "activate") setAccount(true);
  }
  const parentDestination = useRef<LongBallDestination | null>(null);
  const relayedCompletions = useRef(new Set<string>());
  const navigationGuard = useRef<((leave: () => void) => void) | null>(null);
  const setNavigationGuard = useCallback(
    (guard: ((leave: () => void) => void) | null) => {
      navigationGuard.current = guard;
    },
    [],
  );
  const [invitation, setInvitation] =
    useState<SpectatorInvitationDestination | null>(null);
  const [childActivation, setChildActivation] =
    useState<ChildActivationDestination | null>(null);
  const [activationCompletion, setActivationCompletion] =
    useState<ActivationCompletionDestination | null>(null);
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
  const receiveDestination = useCallback(
    (destination: LongBallDestination, relay: boolean) => {
      setIntent("activate");
      if (destination.kind === "invitation") {
        setInvitation(destination.invitation);
        setAccount(false);
        return;
      }
      if (destination.kind === "activation-completion") {
        setActivationCompletion(destination.completion);
        if (
          relay &&
          Platform.OS === "web" &&
          typeof window !== "undefined" &&
          typeof BroadcastChannel !== "undefined"
        ) {
          const key = JSON.stringify(destination.completion);
          if (!relayedCompletions.current.has(key)) {
            try {
              const channel = new BroadcastChannel(
                activationRelayChannelName(
                  `${window.location.origin}${window.location.pathname}`,
                ),
              );
              channel.postMessage(destination.completion);
              relayedCompletions.current.add(key);
              setTimeout(() => channel.close(), 500);
            } catch {
              /* The retained original capability and manual return fallback remain necessary. */
            }
          }
        }
      }
      setAccount(true);
    },
    [],
  );
  useEffect(() => {
    if (!initialDestination || parentDestination.current === initialDestination)
      return;
    parentDestination.current = initialDestination;
    // EntryApplication already validated the destination and removed its fragment.
    // Relay only the same-origin attempt/proof metadata, never the original capability.
    receiveDestination(initialDestination, true);
  }, [initialDestination, receiveDestination]);
  useEffect(() => {
    const receive = (url: string) => {
      const destination = parseLongBallDestination(url, {
        httpsEntryUrls: [
          ...(process.env.EXPO_PUBLIC_LINK_ENTRY_URLS ?? "")
            .split(",")
            .map((value: string) => value.trim())
            .filter(Boolean),
          ...(typeof window !== "undefined" &&
          window.location.protocol === "https:"
            ? [`${window.location.origin}${window.location.pathname}`]
            : []),
        ],
        developmentHttpEntryUrls:
          typeof window !== "undefined" &&
          window.location.hostname === "localhost" &&
          process.env.EXPO_PUBLIC_FICTIONAL_IDENTITY_TRIAL === "1"
            ? [`${window.location.origin}${window.location.pathname}`]
            : [],
        httpsOrigins: (process.env.EXPO_PUBLIC_LINK_ORIGINS ?? "")
          .split(",")
          .map((value: string) => value.trim())
          .filter(Boolean),
      });
      if (!destination) return;
      receiveDestination(
        destination,
        typeof window !== "undefined" && window.location.href === url,
      );
      // Capture only in memory, then remove capabilities from the current browser address.
      if (
        typeof window !== "undefined" &&
        window.location.href === url &&
        window.location.hash
      )
        window.history.replaceState(
          null,
          "",
          window.location.pathname + window.location.search,
        );
    };
    let active = true;
    void Linking.getInitialURL().then((url) => {
      if (active && url) receive(url);
    });
    const subscription = Linking.addEventListener("url", (event) =>
      receive(event.url),
    );
    const browserChange = () => receive(window.location.href);
    if (typeof window !== "undefined")
      window.addEventListener("hashchange", browserChange);
    return () => {
      active = false;
      subscription.remove();
      if (typeof window !== "undefined")
        window.removeEventListener("hashchange", browserChange);
    };
  }, [receiveDestination]);

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
    if (!foreground || !identity || !session || Platform.OS === "web") return;
    // connectedFetch rechecks the bound session generation before and after network I/O.
    // An unconfirmed metadata registration must never block a valid sign-in.
    void connectedAccountDevicesClient(session)
      .registerCurrent()
      .catch(() => undefined);
  }, [identity, foreground, session]);
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

  const workspaceApi = session?.config.apiBaseUrl;
  const workspaceAccount = session?.accountId;
  const workspaceConnection = useMemo(
    () =>
      identity && workspaceApi && workspaceAccount
        ? {
            baseUrl: workspaceApi,
            mode: "oidc" as const,
            account: workspaceAccount,
          }
        : undefined,
    [identity, workspaceApi, workspaceAccount],
  );
  const requestWelcome = () => {
    if (!onBackToWelcome) return;
    if (navigationGuard.current) {
      setAccount(false);
      navigationGuard.current(onBackToWelcome);
    } else onBackToWelcome();
  };
  const showAccount = !identity || account;

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
    <ScrollView
      style={{ flex: 1, display: showAccount || !foreground || loading || !storage || storage.identity !== identity ? "flex" : "none" }}
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
        <LongBallWordmark compact />
        <View style={styles.headerActions}>
          {onBackToWelcome && (
            <Button
              label="Back to welcome"
              variant="quiet"
              onPress={requestWelcome}
              testID="back-to-welcome"
            />
          )}
          {identity && (
            <Button
              label={account ? "Back to team" : "My account"}
              variant="quiet"
              onPress={() => setAccount(!account)}
              testID="connected-account"
            />
          )}
        </View>
      </View>
      {error && <Notice tone="error">{error}</Notice>}
      {!loading && (
        <View
          style={{ display: foreground && showAccount ? "flex" : "none" }}
          accessibilityElementsHidden={!foreground || !showAccount}
          importantForAccessibility={
            foreground && showAccount ? "auto" : "no-hide-descendants"
          }
        >
          <AccountSecurityScreen
            initialIntent={intent}
            intentRevision={intentRevision}
            onEnterFictionalReview={onEnterFictionalReview}
            invitationDestination={invitation}
            childActivationDestination={childActivation}
            activationCompletion={activationCompletion}
            onActivationCompletionConsumed={() => setActivationCompletion(null)}
            onSessionChange={(next) => {
              if (
                session &&
                (!next ||
                  session.issuer !== next.issuer ||
                  session.accountId !== next.accountId)
              )
                setChildActivation(null);
              if (
                next &&
                !next.locked &&
                !next.expired &&
                (!session ||
                  session.locked ||
                  session.expired ||
                  session.sessionId !== next.sessionId)
              )
                setAccount(false);
              setSession(next);
            }}
          />
        </View>
      )}
      {!foreground ? (
        <Notice>
          Unlock your account to continue when LongBall is active.
        </Notice>
      ) : loading ? (
        <ActivityIndicator color={colors.brand} />
      ) : !identity || account ? null : !storage ||
        storage.identity !== identity ? (
        error ? (
          <Button
            label="Retry protected storage"
            onPress={() => setStorageAttempt((value) => value + 1)}
          />
        ) : (
          <ActivityIndicator color={colors.brand} />
        )
      ) : null}
    </ScrollView>
      {identity && storage?.identity === identity && (
        <View
          style={{ flex: 1, display: foreground && !showAccount ? "flex" : "none" }}
          accessibilityElementsHidden={!foreground || showAccount}
          importantForAccessibility={
            foreground && !showAccount ? "auto" : "no-hide-descendants"
          }
        >
          <ConnectedWorkspace
            active={visible && foreground && !showAccount}
            key={identity}
            journal={storage.journal}
            deviceId={storage.deviceId}
            allowSynthetic={false}
            initialConnection={workspaceConnection}
            invitationDestination={invitation ?? undefined}
            onNavigationGuardChange={setNavigationGuard}
            onLeaveWorkspace={onBackToWelcome}
            onOpenAccount={() => {
              setIntent("sign-in");
              setAccount(true);
            }}
            onPrepareChildActivation={(destination) => {
              setChildActivation(destination);
              setIntent("activate");
              setAccount(true);
            }}
          />
        </View>
      )}
    </View>
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
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
  },
});
