import { useRef, useState } from "react";
import { Text } from "react-native";
import {
  validateOidcConfig,
  type OidcClientConfig,
} from "@longball/application/security";
import type {
  ActivationCompletionDestination,
  SpectatorInvitationDestination,
} from "@longball/application/deep-links";
import { WIRE_CONTRACT_VERSION } from "@longball/application/sync";
import { isCanonicalInvitationToken } from "@longball/application/invitation-credentials";
import {
  parseInvitationProviderSetup,
  type InvitationProviderSetup,
} from "../platform/spectator-activation-core";
import { randomUUID } from "../platform/id";
import { ActivationPanel } from "./ActivationPanel";
import { Button, Card, Notice } from "../ui";
export function SpectatorActivationPanel({
  config,
  invitation,
  completion,
  onCompletionConsumed,
}: {
  config: OidcClientConfig;
  invitation: SpectatorInvitationDestination;
  completion?: ActivationCompletionDestination | null;
  onCompletionConsumed?: () => void;
}) {
  const [setup, setSetup] = useState<InvitationProviderSetup | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [finished, setFinished] = useState(false);
  const requestId = useRef<string | null>(null),
    deviceId = useRef<string | null>(null);
  async function begin() {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      validateOidcConfig(config);
      if (!isCanonicalInvitationToken(invitation.code))
        throw new Error("Invitation needs reissue.");
      requestId.current ??= randomUUID();
      deviceId.current ??= randomUUID();
      const base = config.apiBaseUrl.replace(/\/$/, "");
      async function post(path: string, body: object) {
        const controller = new AbortController(),
          timer = setTimeout(() => controller.abort(), 20_000);
        try {
          const response = await fetch(
            `${base}${base.endsWith("/v1") ? "" : "/v1"}/spectator-invites/${path}`,
            {
              method: "POST",
              redirect: "error",
              signal: controller.signal,
              headers: {
                "content-type": "application/json",
                "x-api-contract-version": WIRE_CONTRACT_VERSION,
                "idempotency-key": requestId.current!,
              },
              body: JSON.stringify(body),
            },
          );
          if (!response.ok) throw new Error("Unavailable");
          const text = await response.text();
          if (text.length > 32_000) throw new Error("Response too large");
          return JSON.parse(text) as Record<string, unknown>;
        } finally {
          clearTimeout(timer);
        }
      }
      const info = await post("activation-info", { token: invitation.code });
      if (
        Object.keys(info).length !== 3 ||
        typeof info.invitationId !== "string" ||
        typeof info.expiresAt !== "string" ||
        Date.parse(info.expiresAt) <= Date.now() ||
        typeof info.policyVersion !== "string"
      )
        throw new Error("Unavailable");
      setSetup(
        parseInvitationProviderSetup(
          await post("activate", {
            token: invitation.code,
            deviceId: deviceId.current,
            policyVersion: info.policyVersion,
          }),
          config,
          Date.now(),
        ),
      );
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Card>
        <Text style={{ fontSize: 18, fontWeight: "700" }}>
          Received spectator invitation
        </Text>
        <Text>
          Already have an account? Use secure sign-in above, then review and
          accept the invitation in Community. A new invitee can create a
          username-only account with the configured provider below.
        </Text>
        <Text>
          This link selects team {invitation.teamId}, season{" "}
          {invitation.seasonId}; the service validates its actual scope. It
          cannot configure your API or identity provider.
        </Text>
        {error && (
          <Notice tone="warning">
            Invitation setup is unavailable or incomplete. Keep the original
            invitation and retry the same action, or ask its issuer for a
            current link. No membership was granted.
          </Notice>
        )}
        {finished ? (
          <Notice>
            Account activation completed. Use secure sign-in, then explicitly
            review and accept this invitation in Community.
          </Notice>
        ) : (
          <Button
            label={
              setup
                ? "Retry invitation credential setup"
                : "Create sign-in for this invitation"
            }
            disabled={busy}
            onPress={() => {
              void begin();
            }}
          />
        )}
      </Card>
      {setup && !finished && (
        <ActivationPanel
          config={config}
          session={null}
          invitationSetup={{ ...setup, token: invitation.code }}
          completion={completion}
          onCompletionConsumed={(verified) => {
            onCompletionConsumed?.();
            if (verified) {
              setSetup(null);
              setFinished(true);
              requestId.current = null;
              deviceId.current = null;
            }
          }}
        />
      )}
    </>
  );
}
