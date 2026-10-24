import { formatUkDateTime } from '@longball/application/uk-display';
import { useEffect, useRef, useState } from "react";
import { Platform, StyleSheet, Text, TextInput, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import type { OidcClientConfig } from "@longball/application/security";
import { validateOidcConfig } from "@longball/application/security";
import { WIRE_CONTRACT_VERSION } from "@longball/application/sync";
import {
  activationRelayChannelName,
  parseActivationRelayMessage,
} from "@longball/application/activation-relay";
import {
  parseLongBallDestination,
  sameActivationCompletion,
  type ActivationCompletionDestination,
  type ChildActivationDestination,
} from "@longball/application/deep-links";
import {
  connectedFetch,
  type ConnectedSessionSummary,
} from "../platform/auth/client";
import { randomUUID } from "../platform/id";
import { Button, Card, colors, Notice } from "../ui";

interface Setup {
  activationId: string;
  providerSetupUrl: string;
  expiresAt: number;
}
interface Issue {
  activationId: string;
  token: string;
  expiresAt: number;
  policyVersion: string;
}
interface Pending {
  accountId: string;
  username: string;
  status: string;
}
export interface ActivationPanelProps {
  config: OidcClientConfig;
  session: ConnectedSessionSummary | null;
  childDestination?: ChildActivationDestination | null;
  completion?: ActivationCompletionDestination | null;
  onCompletionConsumed?: (verified: boolean) => void;
  invitationSetup?: {
    activationId: string;
    token: string;
    providerSetupUrl: string;
    expiresAt: number;
  } | null;
}
/** Capabilities remain in component memory. Neither passwords nor activation secrets enter the journal. */
export function ActivationPanel(props: ActivationPanelProps) {
  const session = props.session;
  const key = JSON.stringify([
    session?.issuer,
    session?.accountId,
    session?.sessionId,
    session?.locked,
    session?.expired,
    props.config.issuer,
    props.config.apiBaseUrl,
    props.childDestination,
    props.invitationSetup?.activationId,
  ]);
  return <ActivationPanelContent key={key} {...props} />;
}
function ActivationPanelContent({
  config,
  session,
  childDestination,
  completion,
  onCompletionConsumed,
  invitationSetup,
}: ActivationPanelProps) {
  const [token, setToken] = useState("");
  const [providerReturn, setProviderReturn] = useState("");
  const [globalAccountId, setGlobalAccountId] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [issue, setIssue] = useState<Issue | null>(null);
  const [setup, setSetup] = useState<Setup | null>(invitationSetup ?? null);
  const [localProof, setProof] =
    useState<ActivationCompletionDestination | null>(null);
  const [consumedCompletion, setConsumedCompletion] = useState<string | null>(
    null,
  );
  const completionKey = completion ? JSON.stringify(completion) : null;
  const incomingProof =
    completion && completionKey !== consumedCompletion ? completion : null;
  const proof = incomingProof === null ? localProof : incomingProof;
  const [retainedCapability, setRetainedCapability] = useState<{
    activationId: string;
    token: string;
  } | null>(
    invitationSetup
      ? {
          activationId: invitationSetup.activationId,
          token: invitationSetup.token,
        }
      : null,
  );
  const completionToken =
    proof && retainedCapability?.activationId === proof.activationId
      ? retainedCapability.token
      : token;
  useEffect(() => {
    if (
      Platform.OS !== "web" ||
      !setup ||
      retainedCapability?.activationId !== setup.activationId ||
      typeof window === "undefined" ||
      typeof BroadcastChannel === "undefined"
    )
      return;
    const entry = new URL(config.redirectUri);
    if (
      entry.origin !== window.location.origin ||
      entry.pathname !== window.location.pathname
    )
      return;
    let channel: BroadcastChannel;
    try {
      channel = new BroadcastChannel(
        activationRelayChannelName(config.redirectUri),
      );
    } catch {
      return;
    }
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const returned = parseActivationRelayMessage(event.data);
      if (
        returned?.activationId === setup.activationId &&
        setup.expiresAt > Date.now()
      ) {
        setProof(returned);
        setConsumedCompletion(completionKey);
      }
    };
    return () => channel.close();
  }, [setup, retainedCapability, config.redirectUri, completionKey]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const operations = useRef(new Map<string, string>());
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      await work();
    } catch {
      setError(
        "This activation could not finish. The configured service may be unavailable, the capability may have expired, or current authority may be missing. Retained requests can be retried; no account recovery was approved.",
      );
    } finally {
      setBusy(false);
    }
  };
  async function post(
    path: string,
    body: object,
    authenticated: boolean,
    operation: string,
  ): Promise<Record<string, unknown>> {
    validateOidcConfig(config);
    const base = config.apiBaseUrl.replace(/\/$/, "");
    const target = `${base}${base.endsWith("/v1") ? "" : "/v1"}${path}`;
    let requestId = operations.current.get(operation);
    if (!requestId) {
      requestId = randomUUID();
      operations.current.set(operation, requestId);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const request = authenticated ? connectedFetch : fetch;
      const response = await request(target, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-contract-version": WIRE_CONTRACT_VERSION,
          "idempotency-key": requestId,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error("Activation unavailable");
      const text = await response.text();
      if (text.length > 32_000) throw new Error("Invalid activation receipt");
      const result: unknown = JSON.parse(text);
      if (!result || typeof result !== "object" || Array.isArray(result))
        throw new Error("Invalid activation receipt");
      return result as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
    }
  }
  async function issuePending(forceNew: boolean) {
    if (!pending || !childDestination) return;
    if (forceNew) {
      operations.current.delete(`issue:${pending.accountId}`);
      setIssue(null);
    }
    const result = await post(
      `/teams/${encodeURIComponent(childDestination.teamId)}/activation/issue?seasonId=${encodeURIComponent(childDestination.seasonId)}`,
      { accountId: pending.accountId },
      true,
      `issue:${pending.accountId}`,
    );
    if (
      typeof result.activationId !== "string" ||
      typeof result.token !== "string" ||
      typeof result.expiresAt !== "number" ||
      typeof result.policyVersion !== "string"
    )
      throw new Error("Invalid issue receipt");
    setIssue(result as unknown as Issue);
  }
  const canManage =
    session &&
    !session.locked &&
    !session.expired &&
    session.expiresAtMs > now &&
    session.identityClassification === "adult_individual" &&
    session.adultVerified &&
    session.strongAuth &&
    childDestination &&
    session.memberships.some(
      (membership) =>
        membership.teamId === childDestination.teamId &&
        membership.seasonId === childDestination.seasonId &&
        membership.role === "manager" &&
        membership.revokedAt == null &&
        (membership.expiresAt == null || membership.expiresAt > now),
    );
  return (
    <Card>
      <Text style={styles.title}>
        {invitationSetup
          ? "Invitation account credential setup"
          : "Activation and household sign-in"}
      </Text>
      <Notice>
        {invitationSetup ? (
          "The configured provider handles password and recovery setup. Completion activates only this account; sign in separately and explicitly accept the invitation. No team grant or adult authority is created here."
        ) : (
          <>
            Activation uses an explicitly configured demo provider trial.
            Q05 household delivery, linking and recovery authority remain
            unapproved. A manager cannot see or set the household password.
          </>
        )}
      </Notice>
      {error && <Notice tone="error">{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      {childDestination && (
        <>
          <Text style={styles.body}>
            Selected player {childDestination.playerId} · team{" "}
            {childDestination.teamId} · season {childDestination.seasonId}
          </Text>
          {!canManage ? (
            <Notice tone="warning">
              Use a current, strongly authenticated adult manager assigned to
              this exact team and season.
            </Notice>
          ) : (
            <>
              <Text style={styles.body}>
                If a household already has a global account, use its exact UUID.
                A request below records a need for independent verification; it
                does not link accounts or reset credentials.
              </Text>
              <TextInput
                accessibilityLabel="Existing global account UUID"
                value={globalAccountId}
                onChangeText={setGlobalAccountId}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={36}
                style={styles.input}
              />
              <Button
                label="Request independently verified existing-account link"
                variant="secondary"
                disabled={
                  busy ||
                  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                    globalAccountId,
                  )
                }
                onPress={() =>
                  void run(async () => {
                    const result = await post(
                      "/accounts/link-requests",
                      {
                        ...childDestination,
                        existingAccountId: globalAccountId,
                      },
                      true,
                      `link:${JSON.stringify(childDestination)}:${globalAccountId}`,
                    );
                    if (
                      result.status !== "pending_independent_verification" ||
                      result.completed !== false
                    )
                      throw new Error("Invalid pending verification receipt");
                    setMessage(
                      "The exact-ID link request is recorded for independent verification. Existing account presence was not disclosed and no link was applied.",
                    );
                  })
                }
              />
              <Button
                label="Record household recovery verification request"
                variant="quiet"
                disabled={
                  busy ||
                  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                    globalAccountId,
                  )
                }
                onPress={() =>
                  void run(async () => {
                    const result = await post(
                      "/accounts/recovery-requests",
                      {
                        teamId: childDestination.teamId,
                        seasonId: childDestination.seasonId,
                        accountId: globalAccountId,
                      },
                      true,
                      `recovery:${childDestination.teamId}:${childDestination.seasonId}:${globalAccountId}`,
                    );
                    if (
                      result.status !== "pending_independent_verification" ||
                      result.completed !== false
                    )
                      throw new Error("Invalid pending verification receipt");
                    setMessage(
                      "The recovery verification request is recorded. Q05 authority remains undecided; no password reset or account takeover occurred.",
                    );
                  })
                }
              />
              <Button
                label="Prepare username-only pending identity"
                disabled={busy}
                onPress={() =>
                  void run(async () => {
                    const result = await post(
                      `/teams/${encodeURIComponent(childDestination.teamId)}/activation/pending-child?seasonId=${encodeURIComponent(childDestination.seasonId)}`,
                      { playerId: childDestination.playerId },
                      true,
                      `pending:${JSON.stringify(childDestination)}`,
                    );
                    if (
                      typeof result.accountId !== "string" ||
                      typeof result.username !== "string" ||
                      !["active", "pending_activation"].includes(
                        String(result.status),
                      )
                    )
                      throw new Error("Invalid pending receipt");
                    setPending({
                      accountId: result.accountId,
                      username: result.username,
                      status: String(result.status),
                    });
                  })
                }
              />
              {pending && (
                <>
                  <Text selectable style={styles.body}>
                    Username {pending.username} · global account{" "}
                    {pending.accountId}
                  </Text>
                  {pending.status === "active" ? (
                    <Notice>
                      This account is already active. No credential reset or
                      takeover is available here.
                    </Notice>
                  ) : (
                    <View style={styles.stack}>
                      <Button
                        label="Issue or retry single-use activation"
                        disabled={busy}
                        onPress={() => void run(() => issuePending(false))}
                      />
                      <Button
                        label="Explicitly reissue and revoke earlier activation"
                        variant="secondary"
                        disabled={busy}
                        onPress={() => void run(() => issuePending(true))}
                      />
                    </View>
                  )}
                </>
              )}
              {issue && (
                <View style={styles.stack}>
                  <Notice tone="warning">
                    One-time capability. Deliver only using the agreed verified
                    household process. Shown in memory until this screen closes;
                    it cannot be recovered from the app database.
                  </Notice>
                  <Text
                    selectable
                    accessibilityLabel="One-time activation capability"
                    style={styles.secret}
                  >
                    {issue.token}
                  </Text>
                  <Text style={styles.body}>
                    Expires {formatUkDateTime(issue.expiresAt)} ·
                    experiment policy {issue.policyVersion}
                  </Text>
                  <Button
                    label="Hide activation capability"
                    variant="quiet"
                    onPress={() => setIssue(null)}
                  />
                </View>
              )}
            </>
          )}
        </>
      )}
      {!invitationSetup && (
        <>
          <Text style={styles.body}>
            Household: paste the capability issued through the verified process.
            The provider browser handles your password and recovery material.
          </Text>
          <TextInput
            accessibilityLabel="Single-use activation capability"
            value={token}
            onChangeText={setToken}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            maxLength={128}
            style={styles.input}
          />
          <Button
            label="Redeem activation with configured service"
            disabled={busy || !token}
            onPress={() =>
              void run(async () => {
                const result = await post(
                  "/activation/redeem",
                  { token },
                  false,
                  `redeem:${token}`,
                );
                if (
                  typeof result.activationId !== "string" ||
                  typeof result.providerSetupUrl !== "string" ||
                  typeof result.expiresAt !== "number"
                )
                  throw new Error("Invalid setup receipt");
                const url = new URL(result.providerSetupUrl),
                  issuer = new URL(config.issuer);
                if (
                  url.origin !== issuer.origin ||
                  url.protocol !== "https:" ||
                  url.username ||
                  url.password ||
                  url.hash ||
                  !url.pathname.startsWith(
                    issuer.pathname.replace(/\/$/, "") + "/login-actions/",
                  )
                )
                  throw new Error("Untrusted credential origin");
                setSetup(result as unknown as Setup);
                setRetainedCapability({
                  activationId: result.activationId,
                  token,
                });
                setProof(null);
                setConsumedCompletion(completionKey);
                setToken("");
                setMessage(
                  "Provider setup is ready. Continue explicitly in its browser.",
                );
              })
            }
          />
        </>
      )}
      {setup && (
        <>
          <Button
            label="Set credentials with identity provider"
            disabled={busy}
            onPress={() =>
              void run(async () => {
                if (setup.expiresAt <= Date.now())
                  throw new Error("Activation expired");
                if (Platform.OS === "web") {
                  await WebBrowser.openBrowserAsync(setup.providerSetupUrl);
                  setMessage(
                    "Finish in the identity provider. Open its return link in LongBall; completing setup does not sign you in.",
                  );
                } else {
                  const result = await WebBrowser.openAuthSessionAsync(
                    setup.providerSetupUrl,
                    "longball://activation/callback",
                  );
                  if (result.type !== "success") {
                    setMessage(
                      "Provider setup was interrupted. The activation stays pending until verified completion.",
                    );
                    return;
                  }
                  const destination = parseLongBallDestination(result.url);
                  if (
                    !sameActivationCompletion(destination, setup.activationId)
                  )
                    throw new Error("Activation return mismatch");
                  setProof(destination.completion);
                }
              })
            }
          />
        </>
      )}
      {setup && Platform.OS === "web" && (
        <>
          <Text style={styles.body}>
            After provider setup, copy its complete return link into this
            original LongBall window. The original invitation or household
            capability stays only in this window’s memory; the service
            independently verifies completion.
          </Text>
          <TextInput
            accessibilityLabel="Provider activation return link"
            value={providerReturn}
            onChangeText={setProviderReturn}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            maxLength={4096}
            style={styles.input}
          />
          <Button
            label="Review provider return link"
            variant="secondary"
            disabled={busy || !providerReturn}
            onPress={() => {
              void run(async () => {
                const destination = parseLongBallDestination(providerReturn, {
                  httpsOrigins: [new URL(config.issuer).origin],
                  httpsEntryUrls: [config.redirectUri],
                });
                if (!sameActivationCompletion(destination, setup.activationId))
                  throw new Error("Activation return mismatch");
                setProof(destination.completion);
                setConsumedCompletion(completionKey);
                setProviderReturn("");
              });
            }}
          />
        </>
      )}
      {proof && (
        <>
          <Text style={styles.body}>
            A provider completion return is ready for activation{" "}
            {proof.activationId}. Verify it with the configured LongBall API.
            Completion requires the original household capability as well as the
            provider proof.
          </Text>
          {retainedCapability?.activationId !== proof.activationId && (
            <>
              <Notice>
                The original activation capability was not saved on this device.
                Paste it again to verify this return.
              </Notice>
              <TextInput
                accessibilityLabel="Original activation capability for completion"
                value={token}
                onChangeText={setToken}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                maxLength={43}
                style={styles.input}
              />
            </>
          )}
          <Button
            label="Discard this unverified completion return"
            variant="quiet"
            disabled={busy}
            onPress={() => {
              setProof(null);
              setConsumedCompletion(completionKey);
              onCompletionConsumed?.(false);
            }}
          />
          <Button
            label="Verify provider completion"
            disabled={busy || !/^[A-Za-z0-9_-]{43}$/.test(completionToken)}
            onPress={() =>
              void run(async () => {
                const result = await post(
                  "/activation/complete",
                  { ...proof, token: completionToken },
                  false,
                  `complete:${proof.activationId}`,
                );
                if (
                  result.status !== "complete" ||
                  result.signInRequired !== true
                )
                  throw new Error("Unverified completion");
                setProof(null);
                setConsumedCompletion(completionKey);
                setSetup(null);
                setRetainedCapability(null);
                setProviderReturn("");
                setToken("");
                operations.current.clear();
                onCompletionConsumed?.(true);
                setMessage(
                  "The provider completion was verified. Use full secure sign-in above to obtain a separate application session.",
                );
              })
            }
          />
        </>
      )}
    </Card>
  );
}
const styles = StyleSheet.create({
  title: { fontSize: 20, lineHeight: 26, fontWeight: "600", color: colors.ink },
  body: { fontSize: 14, lineHeight: 22, color: colors.inkMuted },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.controlBorder,
    backgroundColor: colors.surface,
    borderRadius: 8,
    padding: 12,
    color: colors.ink,
  },
  stack: { gap: 12 },
  secret: {
    color: colors.ink,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 15,
    lineHeight: 24,
  },
});
