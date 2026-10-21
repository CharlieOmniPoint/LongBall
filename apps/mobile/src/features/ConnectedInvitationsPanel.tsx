import { useEffect, useRef, useState } from "react";
import { StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { randomUUID } from "expo-crypto";
import {
  InvitationClientError,
  type InvitationClientResult,
  type InvitationMemoryClient,
} from "@longball/application/invitation-client";
import { isCanonicalInvitationToken } from "@longball/application/invitation-credentials";
import { Button, Card, colors, Notice, Pill, typography } from "../ui";

type InvitationList = Awaited<ReturnType<InvitationMemoryClient["list"]>>;
type InvitationSummary = InvitationList["invitations"][number];
type Inspection = Awaited<ReturnType<InvitationMemoryClient["inspect"]>>;
export interface ConnectedInvitationsPanelProps {
  client: InvitationMemoryClient;
  /** Includes the account, API, session, selected role and current destination. */
  scopeKey: string;
  active: boolean;
  assertCurrent: () => void;
  disabled?: boolean;
  teamId: string | null;
  seasonId: string | null;
  canIssue: boolean;
  contributionsAllowed?: boolean;
  invitationDestination?: { teamId: string; seasonId: string; code: string };
  onChanged: (acceptedDestination?: {
    teamId: string;
    seasonId: string;
  }) => void | Promise<void>;
  onRetainedChange?: (retained: boolean, scopeKey: string) => void;
}
const when = (value: string) => new Date(value).toLocaleString();
const hoursValue = (value: string): number | null => {
  if (!/^(?:[1-9]|[1-3][0-9]|4[0-8])$/.test(value)) return null;
  return Number(value);
};

/** Credentials live only in this keyed view and its ephemeral HTTP client. */
export function ConnectedInvitationsPanel(
  props: ConnectedInvitationsPanelProps,
) {
  return <InvitationSession key={props.scopeKey} {...props} />;
}
function InvitationSession(props: ConnectedInvitationsPanelProps) {
  const {
    client,
    scopeKey,
    active,
    assertCurrent,
    disabled = false,
    teamId,
    seasonId,
    canIssue,
  } = props;
  const [hours, setHours] = useState("");
  const [token, setToken] = useState(props.invitationDestination?.code ?? "");
  const [list, setList] = useState<InvitationList | null>(null);
  const [inspection, setInspection] = useState<{
    token: string;
    value: Inspection;
  } | null>(null);
  const [acceptedReview, setAcceptedReview] = useState(false);
  const [result, setResult] = useState<InvitationClientResult | null>(null);
  const [review, setReview] = useState<{
    kind: "reissue" | "revoke";
    invitation: InvitationSummary;
  } | null>(null);
  const [closeReview, setCloseReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const live = useRef({
    mounted: true,
    client,
    scopeKey,
    active,
    assertCurrent,
  });
  const retainedCallback = useRef(props.onRetainedChange);
  const disclosure = useRef(false);
  const [owner] = useState(() => client);
  useEffect(() => {
    retainedCallback.current = props.onRetainedChange;
    live.current = { mounted: true, client, scopeKey, active, assertCurrent };
  }, [client, scopeKey, active, assertCurrent, props.onRetainedChange]);
  const same = (owner = client, key = scopeKey) => {
    const current = live.current;
    if (
      !current.mounted ||
      !current.active ||
      current.client !== owner ||
      current.scopeKey !== key
    )
      return false;
    try {
      current.assertCurrent();
      return true;
    } catch {
      return false;
    }
  };
  const retained = () =>
    retainedCallback.current?.(
      client.pending !== null || disclosure.current,
      scopeKey,
    );
  const showError = (failure: unknown) =>
    setError(
      failure instanceof InvitationClientError
        ? failure.message
        : "This action could not be confirmed. Check current access and retry any retained request before starting another.",
    );
  useEffect(() => {
    live.current.mounted = true;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      live.current.mounted = false;
      clearInterval(timer);
      retainedCallback.current?.(false, scopeKey);
    };
  }, [scopeKey]);
  useEffect(() => {
    if (!active || !canIssue || !teamId || !seasonId) return;
    let mounted = true;
    const sourceClient = client,
      sourceKey = scopeKey;
    void client
      .list(teamId, seasonId)
      .then((value) => {
        if (
          mounted &&
          live.current.mounted &&
          live.current.active &&
          live.current.client === sourceClient &&
          live.current.scopeKey === sourceKey
        ) {
          live.current.assertCurrent();
          setList(value);
        }
      })
      .catch(() => {
        if (
          mounted &&
          live.current.active &&
          live.current.client === sourceClient &&
          live.current.scopeKey === sourceKey
        )
          setError(
            "The invitation list could not be refreshed. No new link was created.",
          );
      });
    return () => {
      mounted = false;
    };
  }, [active, canIssue, client, scopeKey, teamId, seasonId]);

  const refresh = async () => {
    if (!canIssue || !teamId || !seasonId || !same()) return;
    const owner = client,
      key = scopeKey;
    const value = await client.list(teamId, seasonId);
    if (same(owner, key)) setList(value);
  };
  const changed = (value: InvitationClientResult) => {
    void refresh().catch(() => {
      if (same())
        setNotice(
          "The action was confirmed. Refresh the list to check its current status.",
        );
    });
    // A reload must not discard a link that can only be shown once.
    if (value.kind === "issued" || value.kind === "redacted") return;
    const destination =
      value.kind === "accepted"
        ? { teamId: value.receipt.teamId, seasonId: value.receipt.seasonId }
        : undefined;
    void Promise.resolve()
      .then(() => {
        if (same()) return props.onChanged(destination);
      })
      .catch(() => {
        if (same())
          setNotice(
            "The action was confirmed. Refresh team access when the connection is available.",
          );
      });
  };
  const perform = async (work: () => Promise<InvitationClientResult>) => {
    if (busy || !same()) return;
    const owner = client,
      key = scopeKey;
    setBusy(true);
    setError(null);
    setNotice(null);
    setReview(null);
    try {
      assertCurrent();
      const response = work();
      retained();
      const value = await response;
      if (!same(owner, key)) return;
      setResult(value);
      disclosure.current = value.kind === "issued";
      if (value.kind === "accepted") {
        setToken("");
        setInspection(null);
        setAcceptedReview(false);
        setNotice(
          `Spectator access accepted for ${value.receipt.teamId}, ${value.receipt.seasonId}. Access ends ${when(value.receipt.expiresAt)}.`,
        );
      } else if (value.kind === "revoked") {
        setNotice("The invitation link was revoked.");
      }
      changed(value);
    } catch (failure) {
      if (same(owner, key)) showError(failure);
    } finally {
      if (same(owner, key)) {
        setBusy(false);
        retained();
      }
    }
  };
  const inspect = async () => {
    if (
      busy ||
      disabled ||
      client.pending ||
      !same() ||
      !isCanonicalInvitationToken(token)
    )
      return;
    const owner = client,
      key = scopeKey,
      exactToken = token;
    setBusy(true);
    setError(null);
    setInspection(null);
    setAcceptedReview(false);
    try {
      const value = await client.inspect(exactToken);
      if (same(owner, key)) setInspection({ token: exactToken, value });
    } catch (failure) {
      if (same(owner, key)) showError(failure);
    } finally {
      if (same(owner, key)) setBusy(false);
    }
  };
  const pending = client.pending;
  let current = active && owner === client;
  if (current) {
    try {
      assertCurrent();
    } catch {
      current = false;
    }
  }
  const blocked = !current || busy || disabled || pending !== null;
  const selectedHours = hoursValue(hours);
  const issued = result?.kind === "issued" ? result.receipt : null;
  const currentInspection =
    inspection &&
    inspection.token === token &&
    Date.parse(inspection.value.expiresAt) > now
      ? inspection.value
      : null;
  if (!current)
    return (
      <Notice>Open an unlocked, current sign-in to review invitations.</Notice>
    );
  return (
    <View style={styles.stack} testID="connected-invitations">
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      {pending && (
        <Card>
          <Pill tone="warning">
            Invitation request retained in this session
          </Pill>
          <Text style={typography.body}>
            The response may have been lost after the service accepted the
            request. Retry uses the same request and key.
          </Text>
          <Button
            label="Retry exact invitation request"
            testID="invitation-retry"
            disabled={busy || disabled}
            onPress={() => {
              void perform(() => client.retry());
            }}
          />
          {closeReview ? (
            <>
              <Notice tone="warning">
                Closing releases these retry details. The service may already
                have accepted the request; refresh its status before creating or
                reissuing a link.
              </Notice>
              <Button
                label="Close invitation retry details"
                testID="invitation-confirm-close"
                variant="danger"
                disabled={busy}
                onPress={() => {
                  client.closePending();
                  setCloseReview(false);
                  setToken("");
                  setInspection(null);
                  setAcceptedReview(false);
                  setError(null);
                  retained();
                  setNotice(
                    "Retry details were closed. Refresh invitation status before another action.",
                  );
                  void refresh().catch(() => undefined);
                }}
              />
              <Button
                label="Keep invitation retry details"
                variant="quiet"
                disabled={busy}
                onPress={() => setCloseReview(false)}
              />
            </>
          ) : (
            <Button
              label="Review closing invitation retry details"
              variant="quiet"
              disabled={busy}
              onPress={() => setCloseReview(true)}
            />
          )}
        </Card>
      )}
      {issued && (
        <Card>
          <Text style={typography.section}>Invitation link ready</Text>
          <Notice>
            Keep this link before closing this display. Its one-time code cannot
            be retrieved from the invitation list.
          </Notice>
          {Date.parse(issued.expiresAt) > now ? (
            <Text
              selectable
              accessibilityLabel="One-time spectator invitation link"
              style={styles.link}
            >
              {issued.shareUrl}
            </Text>
          ) : (
            <Notice tone="warning">This invitation link has expired.</Notice>
          )}
          <Text style={typography.muted}>
            Expires {when(issued.expiresAt)}. Choose whether and how to share
            it.
          </Text>
          <Button
            label="Close this link display"
            testID="invitation-close-link"
            variant="secondary"
            disabled={busy}
            onPress={() => {
              disclosure.current = false;
              setResult(null);
              retained();
              void Promise.resolve()
                .then(() => {
                  if (same()) return props.onChanged();
                })
                .catch(() => {
                  if (same())
                    setNotice(
                      "The link display was closed. Refresh invitation status when connected.",
                    );
                });
            }}
          />
        </Card>
      )}
      {result?.kind === "redacted" && (
        <Card>
          <Text style={typography.section}>Invitation already created</Text>
          <Notice tone="warning">
            The service confirmed the earlier request, but its one-time code is
            no longer available. Review a reissue to cancel that link and create
            a new one.
          </Notice>
          <Text style={typography.muted}>
            Invitation {result.receipt.id} · expires{" "}
            {when(result.receipt.expiresAt)}
          </Text>
        </Card>
      )}
      {canIssue && teamId && seasonId && (
        <Card>
          <Text style={typography.section}>Spectator invitations</Text>
          <Text style={typography.body}>
            Invite someone to this team and season. They sign in to an existing
            account or set up their invited account, then explicitly accept.
          </Text>
          {props.contributionsAllowed === false && (
            <Notice tone="warning">
              Creating or reissuing invitations is currently held or awaiting a
              current privilege check. Existing invitations can still be
              reviewed and revoked.
            </Notice>
          )}
          <Text style={typography.label}>Link lifetime in hours</Text>
          <TextInput
            accessibilityLabel="Invitation link lifetime in hours"
            testID="invitation-hours"
            style={styles.input}
            value={hours}
            onChangeText={setHours}
            keyboardType="number-pad"
            editable={!blocked && !issued}
            placeholder="Choose 1–48 hours"
          />
          <Text style={typography.muted}>
            Choose a whole number from 1 to 48 for this link.
          </Text>
          <Button
            label="Create one-time spectator link"
            testID="invitation-create"
            disabled={
              blocked ||
              !!issued ||
              selectedHours === null ||
              props.contributionsAllowed === false
            }
            onPress={() => {
              if (selectedHours !== null)
                void perform(() =>
                  client.issue(
                    teamId,
                    { seasonId, expiresInHours: selectedHours },
                    randomUUID(),
                  ),
                );
            }}
          />
          {list?.invitations.map((invitation) => (
            <View key={invitation.id} style={styles.row}>
              <Text style={typography.label}>Invitation {invitation.id}</Text>
              <Text style={typography.muted}>
                {invitation.status.replaceAll("_", " ")} · expires{" "}
                {when(invitation.expiresAt)}
              </Text>
              {invitation.canReissue && (
                <Button
                  label="Review reissuing this invitation"
                  testID={`invitation-reissue-${invitation.id}`}
                  variant="secondary"
                  disabled={
                    blocked ||
                    !!issued ||
                    selectedHours === null ||
                    props.contributionsAllowed === false
                  }
                  onPress={() => setReview({ kind: "reissue", invitation })}
                />
              )}
              {invitation.canRevoke && (
                <Button
                  label="Review revoking this invitation"
                  testID={`invitation-revoke-${invitation.id}`}
                  variant="quiet"
                  disabled={blocked || !!issued}
                  onPress={() => setReview({ kind: "revoke", invitation })}
                />
              )}
            </View>
          ))}
          {!list && (
            <Text style={typography.muted}>
              Refresh to read current invitation status.
            </Text>
          )}
          <Button
            label="Refresh invitation status"
            testID="invitation-refresh"
            variant="secondary"
            disabled={blocked}
            onPress={() => {
              void refresh().catch((failure) => {
                if (same()) showError(failure);
              });
            }}
          />
          {review && (
            <View style={styles.row}>
              <Notice tone="warning">
                {review.kind === "reissue"
                  ? "Reissuing cancels this invitation’s current link and creates a new one."
                  : "This cancels the invitation link. Review accepted spectator access separately."}
              </Notice>
              <Button
                label={
                  review.kind === "reissue"
                    ? "Confirm reissue and cancel old link"
                    : "Confirm revocation of this link"
                }
                testID="invitation-confirm-change"
                variant={review.kind === "revoke" ? "danger" : "primary"}
                disabled={
                  blocked ||
                  (review.kind === "reissue" && selectedHours === null)
                }
                onPress={() => {
                  const item = review;
                  if (item.kind === "reissue" && selectedHours !== null)
                    void perform(() =>
                      client.reissue(
                        teamId,
                        item.invitation.id,
                        { seasonId, expiresInHours: selectedHours },
                        randomUUID(),
                      ),
                    );
                  else if (item.kind === "revoke")
                    void perform(async () => ({
                      kind: "revoked",
                      receipt: await client.revoke(
                        teamId,
                        item.invitation.id,
                        seasonId,
                        randomUUID(),
                      ),
                    }));
                }}
              />
              <Button
                label="Keep the current invitation"
                variant="quiet"
                disabled={busy}
                onPress={() => setReview(null)}
              />
            </View>
          )}
        </Card>
      )}
      <Card>
        <Text style={typography.section}>Accept a spectator invitation</Text>
        <Text style={typography.body}>
          Use your existing account. The service checks the invitation’s actual
          team and season before you confirm access.
        </Text>
        {props.invitationDestination && (
          <Button
            label="Use received invitation"
            variant="secondary"
            disabled={blocked || !!issued}
            onPress={() => {
              setToken(props.invitationDestination!.code);
              setInspection(null);
              setAcceptedReview(false);
            }}
          />
        )}
        <TextInput
          accessibilityLabel="Spectator invitation code"
          testID="invitation-token"
          style={styles.input}
          value={token}
          onChangeText={(value) => {
            setToken(value);
            setInspection(null);
            setAcceptedReview(false);
          }}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          editable={!blocked && !issued}
        />
        <Button
          label="Review invitation destination"
          testID="invitation-inspect"
          variant="secondary"
          disabled={blocked || !!issued || !isCanonicalInvitationToken(token)}
          onPress={() => {
            void inspect();
          }}
        />
        {currentInspection && (
          <View style={styles.row}>
            <Text style={typography.label}>
              Team: {currentInspection.teamId}
            </Text>
            <Text style={typography.body}>
              Season: {currentInspection.seasonId}
            </Text>
            <Text style={typography.muted}>
              Link expires {when(currentInspection.expiresAt)}
            </Text>
            <View style={styles.acknowledgement}>
              <Switch
                accessibilityLabel="Confirm the service-reviewed invitation destination"
                value={acceptedReview}
                disabled={blocked}
                onValueChange={setAcceptedReview}
              />
              <Text style={[typography.body, styles.flex]}>
                I want spectator access to this team and season.
              </Text>
            </View>
            <Button
              label="Accept reviewed invitation"
              testID="invitation-accept"
              disabled={blocked || !acceptedReview || !!issued}
              onPress={() => {
                if (inspection?.token === token)
                  void perform(() =>
                    client.accept(inspection.token, randomUUID()),
                  );
              }}
            />
          </View>
        )}
      </Card>
    </View>
  );
}
const styles = StyleSheet.create({
  stack: { gap: 14 },
  row: {
    gap: 10,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  acknowledgement: { flexDirection: "row", alignItems: "center", gap: 10 },
  flex: { flex: 1 },
  input: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    minHeight: 48,
    padding: 12,
    backgroundColor: "white",
    color: colors.ink,
    fontSize: 16,
  },
  link: { color: colors.ink, fontSize: 15, lineHeight: 22, flexShrink: 1 },
});
