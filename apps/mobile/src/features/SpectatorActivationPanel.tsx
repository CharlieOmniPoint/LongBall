import { formatUkDateTime } from '@longball/application/uk-display';
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
import { invitationTeamLabel } from '@longball/application/invitation-context';
import {
  parseInvitationProviderSetup,
  parseInvitationActivationInfo,
  type InvitationActivationInfo,
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
    [info, setInfo] = useState<InvitationActivationInfo | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [finished, setFinished] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const requestId = useRef<string | null>(null),
    deviceId = useRef<string | null>(null);
  async function post(path: string, body: object) {
    validateOidcConfig(config);
    const base = config.apiBaseUrl.replace(/\/$/, ''), controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    requestId.current ??= randomUUID();
    try {
      const response = await fetch(`${base}${base.endsWith('/v1') ? '' : '/v1'}/spectator-invites/${path}`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json', 'x-api-contract-version': WIRE_CONTRACT_VERSION, 'idempotency-key': requestId.current },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error('Unavailable');
      const text = await response.text();
      if (text.length > 32_000) throw new Error('Response too large');
      return JSON.parse(text) as Record<string, unknown>;
    } finally { clearTimeout(timer); }
  }
  async function review() {
    if (busy) return;
    setBusy(true); setError(false); setNotice(null); setInfo(null);
    try {
      if (!isCanonicalInvitationToken(invitation.code)) throw new Error('Invitation needs reissue.');
      setInfo(parseInvitationActivationInfo(await post('activation-info', { token: invitation.code }), Date.now()));
    } catch { setError(true); }
    finally { setBusy(false); }
  }
  async function begin() {
    if (busy || !info) return;
    setBusy(true);
    setError(false);
    try {
      validateOidcConfig(config);
      if (!isCanonicalInvitationToken(invitation.code))
        throw new Error("Invitation needs reissue.");
      requestId.current ??= randomUUID();
      deviceId.current ??= randomUUID();
      const fresh = parseInvitationActivationInfo(await post('activation-info', { token: invitation.code }), Date.now());
      if (fresh.invitationId !== info.invitationId || fresh.teamId !== info.teamId || fresh.seasonId !== info.seasonId || fresh.policyVersion !== info.policyVersion || JSON.stringify(fresh.context) !== JSON.stringify(info.context)) {
        setInfo(fresh); setNotice('The invitation details changed. Review the current destination before creating an account.'); return;
      }
      setSetup(
        parseInvitationProviderSetup(
          await post("activate", {
            token: invitation.code,
            deviceId: deviceId.current,
            policyVersion: fresh.policyVersion,
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
        <Text>Review the service-verified club, team and season before creating an account.</Text>
        {info && <>
          <Text testID="activation-invitation-context">{invitationTeamLabel(info.context)} · {info.context.clubName} · {info.context.seasonLabel ?? 'Season label unavailable'}</Text>
          <Text>Invited by: {info.context.inviterLabel}</Text>
          <Text>Link expires {formatUkDateTime(info.expiresAt)}.</Text>
          <Text selectable>References: team {info.teamId} · season {info.seasonId}</Text>
        </>}
        {notice && <Notice>{notice}</Notice>}
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
        ) : !info ? (
          <Button label="Review invitation destination" testID="activation-invitation-inspect" disabled={busy} onPress={() => { void review(); }} />
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
