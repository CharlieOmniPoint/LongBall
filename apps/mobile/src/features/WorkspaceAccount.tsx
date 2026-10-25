import { formatUkSeasonLabel } from '@longball/application/uk-display';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Text, View } from "react-native";
import type { Principal, Role } from "@longball/application/access";
import type { LongBallServiceClient } from "@longball/application/sync";
import { createAccountRequestsClient } from "../platform/account-requests-core";
import { randomUUID } from "../platform/id";
import { Button, Card, Notice, typography } from "../ui";
import { AccountRequestsPanel } from "./AccountRequestsScreen";

/** Account request intake reuses the real service; no recovery/fulfilment policy is invented. */
export function WorkspaceAccount({
  principal,
  role,
  roleLabel,
  teamLabel,
  seasonLabel,
  playerLabel,
  client,
  request,
  active,
  membershipLabels,
  onInvite,
  onSignOut,
  onVerifySignIn,
  onRetainedChange,
}: {
  principal: Principal;
  role: Role;
  roleLabel: string;
  teamLabel?: string;
  seasonLabel?: string;
  playerLabel?: string;
  client: LongBallServiceClient;
  request: (url: string, init: RequestInit) => Promise<Response>;
  active: boolean;
  membershipLabels: Readonly<Record<string, string>>;
  onInvite?: () => void;
  onSignOut?: () => void;
  onVerifySignIn?: () => void;
  onRetainedChange?: (active: boolean) => void;
}) {
  const [section, setSection] = useState<
    "summary" | "help" | "privacy" | "requests"
  >("summary");
  const accountId = principal.accountId,
    issuer = principal.issuer,
    subject = principal.subject;
  const binding = JSON.stringify([accountId, issuer, subject, client.baseUrl]);
  const current = useRef({ active, binding }),
    ports = useRef({ client, request });
  const [pending, setPending] = useState(false);
  useLayoutEffect(() => {
    current.current = { active, binding };
    ports.current = { client, request };
  }, [active, binding, client, request]);
  useLayoutEffect(
    () => () => {
      current.current.active = false;
    },
    [],
  );
  const [requests, setRequests] = useState<{
    binding: string;
    client: ReturnType<typeof createAccountRequestsClient>;
  } | null>(null);
  useEffect(() => {
    const instance = createAccountRequestsClient({
      accountId,
      newId: randomUUID,
      assertCurrent: async () => {
        if (!current.current.active || current.current.binding !== binding)
          throw new Error("Account view is not active.");
        const me = await ports.current.client.me<{ principal: Principal }>();
        if (
          !current.current.active ||
          current.current.binding !== binding ||
          me.principal.accountId !== accountId ||
          me.principal.issuer !== issuer ||
          me.principal.subject !== subject ||
          me.principal.status !== "active"
        )
          throw new Error("Account access changed. Sign in again.");
      },
      request: async (init) => {
        const controller = new AbortController(),
          timer = setTimeout(() => controller.abort(), 20_000);
        const base = ports.current.client.baseUrl.replace(/\/$/, "");
        try {
          return await ports.current.request(
            `${base}${base.endsWith("/v1") ? "" : "/v1"}/privacy/requests`,
            { ...init, signal: controller.signal },
          );
        } finally {
          clearTimeout(timer);
        }
      },
    });
    const timer = setTimeout(
      () => setRequests({ binding, client: instance }),
      0,
    );
    return () => clearTimeout(timer);
  }, [accountId, issuer, subject, binding]);
  const retained = useCallback(
    (value: boolean) => {
      setPending(value);
      onRetainedChange?.(value);
    },
    [onRetainedChange],
  );
  const change = (next: typeof section) => {
    if (!pending) setSection(next);
  };
  return (
    <View style={{ gap: 12 }} testID="workspace-account-panel">
      <Card>
        <Text accessibilityRole="header" style={typography.title}>
          Your account
        </Text>
        <Text style={typography.section}>{playerLabel ?? roleLabel}</Text>
        <Text style={typography.body}>
          {roleLabel}
          {teamLabel ? ` · ${teamLabel}` : ""}
          {seasonLabel ? ` · ${formatUkSeasonLabel(seasonLabel)}` : ""}
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {onInvite && (
            <Button
              label="Invite a spectator"
              compact
              icon="users"
              variant="secondary"
              testID="workspace-account-invite"
              disabled={pending}
              onPress={onInvite}
            />
          )}
          {onVerifySignIn && (
            <Button
              label="Verify sign-in again"
              compact
              icon="lock"
              variant="secondary"
              testID="account-verify-sign-in"
              onPress={onVerifySignIn}
            />
          )}
          {onSignOut && (
            <Button
              label="Sign out"
              compact
              icon="logout"
              variant="secondary"
              testID="account-sign-out"
              onPress={onSignOut}
            />
          )}
        </View>
      </Card>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {(
          [
            ["summary", "Account"],
            ["help", "Help"],
            ["privacy", "Privacy"],
            ["requests", "My data requests"],
          ] as const
        ).map(([id, label]) => (
          <Button
            key={id}
            label={label}
            compact
            variant={section === id ? "primary" : "secondary"}
            accessibilityState={{ selected: section === id }}
            testID={`account-section-${id}`}
            disabled={pending && section !== id}
            onPress={() => change(id)}
          />
        ))}
      </View>
      {section === "summary" && (
        <Card>
          <Text style={typography.section}>Your access</Text>
          <Text style={typography.body}>
            Your current account type is {roleLabel}. Use the team selector at
            the top to choose another team you have joined.
          </Text>
          <Text style={typography.muted}>
            For password or passcode help, contact the person who invited you. A
            team invitation does not grant Manager or administrator access.
          </Text>
        </Card>
      )}
      {section === "help" && (
        <Card testID="account-help">
          <Text accessibilityRole="header" style={typography.section}>
            Using LongBall
          </Text>
          <Text style={typography.body}>
            {role === "spectator"
              ? "Home shows your team and the next game. Scores has match updates; Results has recorded games. Photos contains pictures shared with your team."
              : role === "player"
                ? "Home shows your next event. Reply to upcoming games and training in Schedule. My Stats is about your own playing time and positions. After a game you played, you can rate it until midnight UK time; only you and your Managers can see your feedback."
                : "Choose the club and team first. Schedule holds games and training; team preparation holds player availability, selection and lineups. Match recording and substitutions remain manual."}
          </Text>
          <Text style={typography.body}>
            A saved confirmation means your change reached LongBall. If a
            request is awaiting confirmation, keep the page open and retry it
            before making a new request.
          </Text>
          <Text style={typography.muted}>
            Use Report a concern on a photo to ask for review. Hiding an
            uploader changes only your gallery.
          </Text>
        </Card>
      )}
      {section === "privacy" && (
        <Card testID="account-privacy">
          <Text accessibilityRole="header" style={typography.section}>
            Your privacy
          </Text>
          <Text style={typography.body}>
            Players see their own private records. Spectators see only the
            updates and photos shared with their team. Managers can see player
            feedback and manage their team.
          </Text>
          <Text style={typography.body}>
            You can record a request to export account data, leave a team or
            delete your account. Verification and fulfilment are awaiting the
            agreed club policy. Recording a request does not export or erase
            data or remove team access.
          </Text>
          <Notice>
            These requests remain pending review. No retention, recovery or
            support policy is approved by this screen.
          </Notice>
          <Button
            label="View my data requests"
            compact
            variant="secondary"
            onPress={() => change("requests")}
          />
        </Card>
      )}
      {section === "requests" &&
        (requests?.binding === binding ? (
          <AccountRequestsPanel
            client={requests.client}
            identityClassification={principal.identityClassification}
            locked={!active}
            membershipLabels={membershipLabels}
            onRetainedChange={retained}
          />
        ) : (
          <Notice>Preparing your account request access…</Notice>
        ))}
    </View>
  );
}
