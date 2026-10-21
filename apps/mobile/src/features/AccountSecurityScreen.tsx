import { useEffect, useRef, useState } from "react";
import { Platform, StyleSheet, Text, TextInput, View } from "react-native";
import type { OidcClientConfig } from "@longball/application/security";
import type {
  ActivationCompletionDestination,
  ChildActivationDestination,
} from "@longball/application/deep-links";
import { ActivationPanel } from "./ActivationPanel";
import { AccountRequestsScreen } from "./AccountRequestsScreen";
import {
  defaultAuthRedirect,
  enrollLocalPin,
  getConnectedSessionSummary,
  lockConnectedSession,
  prepareConnectedSignIn,
  removeLocalPin,
  renewConnectedSession,
  signOutConnected,
  unlockConnectedSession,
  type ConnectedSessionSummary,
  type PreparedSignIn,
} from "../platform/auth/client";
import { Button, Card, colors, Notice, Pill } from "../ui";

export interface AccountSecurityScreenProps {
  onSessionChange?: (session: ConnectedSessionSummary | null) => void;
  onEnterFictionalReview?: () => void;
  initialConfig?: Partial<OidcClientConfig>;
  childActivationDestination?: ChildActivationDestination | null;
  activationCompletion?: ActivationCompletionDestination | null;
  onActivationCompletionConsumed?: () => void;
}
export function AccountSecurityScreen({
  onSessionChange,
  onEnterFictionalReview,
  initialConfig,
  childActivationDestination,
  activationCompletion,
  onActivationCompletionConsumed,
}: AccountSecurityScreenProps) {
  const [config, setConfig] = useState<OidcClientConfig>(() => ({
    issuer: initialConfig?.issuer ?? process.env.EXPO_PUBLIC_OIDC_ISSUER ?? "",
    clientId:
      initialConfig?.clientId ?? process.env.EXPO_PUBLIC_OIDC_CLIENT_ID ?? "",
    apiBaseUrl:
      initialConfig?.apiBaseUrl ?? process.env.EXPO_PUBLIC_API_BASE_URL ?? "",
    redirectUri: initialConfig?.redirectUri ?? defaultAuthRedirect(),
  }));
  const [session, setSession] = useState<ConnectedSessionSummary | null>(null);
  const [prepared, setPrepared] = useState<PreparedSignIn | null>(null);
  const [pin, setPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showRecovery, setShowRecovery] = useState(false);
  const [showRequests, setShowRequests] = useState(false);
  const sessionCallback = useRef(onSessionChange);
  useEffect(() => {
    sessionCallback.current = onSessionChange;
  }, [onSessionChange]);
  useEffect(() => {
    let active = true;
    void getConnectedSessionSummary()
      .then((value) => {
        if (active) {
          setSession(value);
          sessionCallback.current?.(value);
          if (value) setConfig(value.config);
        }
      })
      .catch(() => {
        if (active)
          setError(
            "The remembered sign-in could not be opened. The match journal was retained. Use full sign-in.",
          );
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!session || session.expired) return;
    const timeout = setTimeout(
      () => {
        void getConnectedSessionSummary().then((value) => {
          setSession(value);
          sessionCallback.current?.(value);
        });
      },
      Math.min(
        Math.max(0, session.expiresAtMs - Date.now() + 1),
        2_147_483_647,
      ),
    );
    return () => clearTimeout(timeout);
  }, [session]);
  const updateSession = (value: ConnectedSessionSummary | null) => {
    setSession(value);
    onSessionChange?.(value);
  };
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "This account action could not finish. Try again.",
      );
    } finally {
      setBusy(false);
      setPin("");
      setNewPin("");
    }
  };
  const change = (key: keyof OidcClientConfig, value: string) => {
    setConfig((previous) => ({ ...previous, [key]: value }));
    setPrepared(null);
  };
  const connected = Boolean(session && !session.expired && !session.locked);

  return (
    <View style={s.stack}>
      <Text style={s.eyebrow}>ACCOUNT · SIGN-IN & DEVICE SECURITY</Text>
      <Text accessibilityRole="header" style={s.title}>
        Sign-in & security
      </Text>
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice tone="info">{notice}</Notice>}
      <Card>
        <View style={s.between}>
          <Text style={s.section}>Connected sign-in</Text>
          <Pill tone={connected ? "brand" : "muted"}>
            {session?.expired
              ? "Expired"
              : session?.locked
                ? "Locally locked"
                : connected
                  ? "API verified"
                  : "Not connected"}
          </Pill>
        </View>
        {session ? (
          <>
            <Text style={s.body}>Account {session.accountId}</Text>
            <Text style={s.small}>
              {session.identityClassification === "child_shared"
                ? "Player / shared household account"
                : session.identityClassification === "adult_individual"
                  ? "Adult account"
                  : "Classification not verified"}
            </Text>
            <Text style={s.small}>
              {session.strongAuth
                ? "Stronger authentication verified by the API"
                : "Standard authentication · manager authority unavailable"}
            </Text>
            <Text style={s.small}>
              {session.adultVerified
                ? "Adult eligibility verified by the application"
                : "No verified adult authority"}
            </Text>
            <Text style={s.small}>
              Session expires{" "}
              {new Intl.DateTimeFormat("en-GB", {
                timeZone: "Europe/London",
                dateStyle: "short",
                timeStyle: "short",
              }).format(new Date(session.expiresAtMs))}
            </Text>
            <Text style={s.small}>
              {session.storage === "secure-native"
                ? "Credentials held in platform secure storage"
                : "Browser credentials stay in memory and disappear on reload"}
            </Text>
            <Text style={s.small}>
              {session.memberships.length} current application membership
              {session.memberships.length === 1 ? "" : "s"} · role access is
              checked again by the API
            </Text>
          </>
        ) : (
          <Text style={s.body}>
            Use the configured sign-in provider and LongBall service for your
            team. Issued household activation can be completed in the section
            below when that service has an explicitly configured activation
            process.
          </Text>
        )}
        {session?.expired && (
          <Notice tone="warning">
            This session expired. A local PIN cannot renew it. An unlocked
            remembered session can ask its provider to renew access, or use full
            sign-in.
          </Notice>
        )}
        {session && !session.locked && (
          <Button
            label="Recheck and renew with provider"
            variant="secondary"
            disabled={busy}
            onPress={() => {
              void run(async () => {
                updateSession(await renewConnectedSession());
                setNotice(
                  "Provider renewal and current API identity checks completed. Local PIN failures were retained.",
                );
              });
            }}
          />
        )}
        {session && (
          <Button
            label="Sign out of connected session"
            variant="secondary"
            disabled={busy}
            onPress={() => {
              void run(async () => {
                const result = await signOutConnected();
                updateSession(null);
                setPrepared(null);
                setNotice(
                  result.providerRevocation === "confirmed"
                    ? "Local credentials removed and provider token revocation acknowledged. The match journal is retained."
                    : "Local credentials removed. Provider revocation was not confirmed; its browser session may remain active. The match journal is retained.",
                );
              });
            }}
          />
        )}
      </Card>
      {session && Platform.OS !== "web" && (
        <Card>
          <Text style={s.section}>Optional local PIN</Text>
          <Text style={s.small}>
            A four-digit PIN unlocks this already enrolled session. It is
            separate from the random database key and cannot obtain server
            access or extend an expired session.
          </Text>
          <Notice tone="warning">
            Device experiment: five failed guesses require a fresh strong
            sign-in, with a 30-second retry delay. This proposed convenience
            policy still needs pilot review and phone testing.
          </Notice>
          {session.pinFailures > 0 && (
            <Text style={s.small}>
              {session.pinFailures} failed attempts retained on this device
            </Text>
          )}
          {session.locked ? (
            <>
              <Field
                label="Local unlock PIN"
                value={pin}
                onChange={setPin}
                secure
              />
              <Button
                label="Unlock enrolled session"
                icon="shield"
                disabled={busy || session.expired}
                onPress={() => {
                  void run(async () =>
                    updateSession(await unlockConnectedSession(pin)),
                  );
                }}
              />
            </>
          ) : (
            <>
              <Field
                label={
                  session.pinConfigured
                    ? "Replace local PIN"
                    : "Choose optional local PIN"
                }
                value={newPin}
                onChange={setNewPin}
                secure
              />
              <Button
                label={
                  session.pinConfigured
                    ? "Replace enrolled PIN"
                    : "Enable local PIN"
                }
                icon="shield"
                disabled={busy || session.expired}
                onPress={() => {
                  void run(async () => {
                    updateSession(await enrollLocalPin(newPin));
                    setNotice(
                      "Local PIN enrolled for this existing session. Database encryption key unchanged.",
                    );
                  });
                }}
              />
              {session.pinConfigured && (
                <>
                  <Button
                    label="Lock connected session"
                    variant="secondary"
                    disabled={busy}
                    onPress={() => {
                      void run(async () =>
                        updateSession(await lockConnectedSession()),
                      );
                    }}
                  />
                  <Button
                    label="Remove local PIN"
                    variant="quiet"
                    disabled={busy}
                    onPress={() => {
                      void run(async () => {
                        updateSession(await removeLocalPin());
                        setNotice(
                          "The local PIN was removed after verified strong authentication.",
                        );
                      });
                    }}
                  />
                </>
              )}
            </>
          )}
        </Card>
      )}
      <Card>
        <Text style={s.section}>Account data and membership requests</Text>
        <Text style={s.body}>
          Request your global account data export or account deletion, or
          request to leave one selected team and season. Verification and the
          agreed policy are required; submission does not erase data or remove
          access.
        </Text>
        {!connected && (
          <Notice>
            Sign in and unlock this account to submit or review its own service
            requests. This route is available in the native app and browser.
          </Notice>
        )}
        <Button
          label={
            showRequests
              ? "Hide account requests"
              : "Review account data and membership requests"
          }
          variant="secondary"
          disabled={busy || !connected}
          onPress={() => setShowRequests((value) => !value)}
          testID="open-account-requests"
        />
      </Card>
      {showRequests && session && connected && (
        <AccountRequestsScreen
          session={session}
          onClose={() => setShowRequests(false)}
        />
      )}
      <Text style={s.section}>Configure secure sign-in</Text>
      <Field
        label="OIDC issuer (HTTPS)"
        value={config.issuer}
        onChange={(value) => change("issuer", value)}
        placeholder="https://identity.example/realms/longball"
      />
      <Field
        label="Public client identifier"
        value={config.clientId}
        onChange={(value) => change("clientId", value)}
        placeholder="longball-mobile"
      />
      <Field
        label="LongBall API base URL (HTTPS)"
        value={config.apiBaseUrl}
        onChange={(value) => change("apiBaseUrl", value)}
        placeholder="https://api.example"
      />
      <Field
        label="Exact registered redirect URI"
        value={config.redirectUri}
        onChange={(value) => change("redirectUri", value)}
      />
      <Notice tone="info">
        The public client uses authorization code + PKCE S256 in the system
        browser. State, nonce, issuer, audience and expiry are checked. Current
        account authority comes from the authenticated API.
      </Notice>
      <Button
        label="Prepare secure sign-in"
        icon="shield"
        disabled={busy}
        onPress={() => {
          void run(async () => {
            setPrepared(await prepareConnectedSignIn(config));
            setNotice(
              "Sign-in request prepared. Continue with the browser button.",
            );
          });
        }}
        testID="prepare-oidc-signin"
      />
      {prepared && (
        <Card>
          <Text style={s.section}>Continue with your provider</Text>
          <Text style={s.small}>{prepared.issuer}</Text>
          <Text style={s.small}>Return to {prepared.redirectUri}</Text>
          <Button
            label="Continue in system browser"
            icon="arrow"
            disabled={busy}
            onPress={() => {
              void run(async () => {
                const value = await prepared.continueInBrowser();
                updateSession(value);
                setPrepared(null);
                setNotice(
                  "The API verified this account and its current memberships.",
                );
              });
            }}
            testID="continue-oidc-signin"
          />
        </Card>
      )}
      <ActivationPanel
        config={config}
        session={session}
        childDestination={childActivationDestination}
        completion={activationCompletion}
        onCompletionConsumed={(verified) => {
          if (verified)
            setNotice(
              "Provider completion verified. Use full secure sign-in to obtain a separate application session.",
            );
          onActivationCompletionConsumed?.();
        }}
      />
      <Card>
        <Text style={s.section}>Activation and recovery</Text>
        <Text style={s.body}>
          Account activation needs an issued invitation. Household recovery
          needs the approved verification authority and an operational identity
          service.
        </Text>
        <Button
          label="Recovery requirements"
          variant="secondary"
          onPress={() => setShowRecovery(!showRecovery)}
        />
        {showRecovery && (
          <Notice tone="warning">
            Q05 remains open: who verifies household recovery and what evidence
            they use must be agreed. A manager cannot take over an existing
            global child account or reset its credential from this review. No
            request is submitted by opening these requirements. A pending
            verification request never resets a credential.
          </Notice>
        )}
      </Card>
      {onEnterFictionalReview && (
        <Card>
          <Pill tone="muted">FICTIONAL REVIEW</Pill>
          <Text style={s.section}>Review Roma without sign-in</Text>
          <Text style={s.body}>
            The fictional team journey stays separate from connected identity. A
            review role selector never grants access to a real account.
          </Text>
          <Button
            label="Continue fictional Roma review"
            variant="secondary"
            onPress={onEnterFictionalReview}
          />
        </Card>
      )}
      <Text style={s.footnote}>
        Native device checks remain required for registered redirects,
        credential storage, PIN interruption, backups and sign-in recovery.
      </Text>
    </View>
  );
}
function Field({
  label,
  value,
  onChange,
  placeholder,
  secure = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  secure?: boolean;
}) {
  return (
    <View style={s.field}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={secure}
        maxLength={secure ? 4 : 2048}
        keyboardType={secure ? "number-pad" : "url"}
        style={s.input}
      />
    </View>
  );
}
const s = StyleSheet.create({
  stack: { gap: 16 },
  between: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
  },
  field: { gap: 8 },
  title: { fontSize: 26, lineHeight: 32, fontWeight: "700", color: colors.ink },
  section: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: "600",
    color: colors.ink,
  },
  body: { fontSize: 16, lineHeight: 24, color: colors.ink },
  small: { fontSize: 14, lineHeight: 20, color: colors.inkMuted },
  footnote: { fontSize: 12, lineHeight: 18, color: colors.inkMuted },
  label: { fontSize: 14, lineHeight: 20, fontWeight: "600", color: colors.ink },
  eyebrow: {
    fontSize: 11,
    lineHeight: 18,
    letterSpacing: 1.2,
    fontWeight: "700",
    color: colors.brand,
  },
  input: {
    minHeight: 52,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.controlBorder,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    lineHeight: 24,
    color: colors.ink,
  },
});
