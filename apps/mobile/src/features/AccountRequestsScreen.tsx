import { formatUkDateTime } from "@longball/application/uk-display";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type {
  PrivacyAffectedMembership,
  PrivacyRequestDto,
  PrivacyRequestInput,
  PrivacyRequestKind,
} from "@longball/application/privacy-requests";
import type { ConnectedSessionSummary } from "../platform/auth/client";
import { connectedAccountRequestsClient } from "../platform/account-requests";
import {
  AccountRequestsError,
  accountRequestConfirmation,
  requestMemberships,
  type AccountRequestsState,
} from "../platform/account-requests-core";
import { Button, Card, colors, Notice, Pill } from "../ui";

const label = (kind: PrivacyRequestKind) =>
  kind === "export"
    ? "Account data export"
    : kind === "delete_account"
      ? "Delete global LongBall account"
      : "Leave selected team and season";
export function AccountRequestsScreen({
  session,
  onClose,
}: {
  session: ConnectedSessionSummary;
  onClose?: () => void;
}) {
  return (
    <AccountRequestsContent
      key={JSON.stringify([
        session.issuer,
        session.accountId,
        session.sessionId,
        session.locked,
        session.expired,
        session.config.apiBaseUrl,
      ])}
      session={session}
      onClose={onClose}
    />
  );
}
function AccountRequestsContent({
  session,
  onClose,
}: {
  session: ConnectedSessionSummary;
  onClose?: () => void;
}) {
  const [client] = useState(() => connectedAccountRequestsClient(session));
  return (
    <AccountRequestsPanel
      client={client}
      locked={session.locked || session.expired}
      identityClassification={session.identityClassification}
      onClose={onClose}
    />
  );
}
export function AccountRequestsPanel({
  client,
  locked = false,
  identityClassification = "unclassified",
  onClose,
  onRetainedChange,
  membershipLabels,
}: {
  client: ReturnType<typeof connectedAccountRequestsClient>;
  locked?: boolean;
  identityClassification?: "child_shared" | "adult_individual" | "unclassified";
  onClose?: () => void;
  onRetainedChange?: (retained: boolean) => void;
  membershipLabels?: Readonly<Record<string, string>>;
}) {
  const [showReferences, setShowReferences] = useState(false);
  const [state, setState] = useState<AccountRequestsState>(() =>
    client.getState(),
  );
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [kind, setKind] = useState<PrivacyRequestKind | null>(null);
  const [selected, setSelected] = useState<{
    teamId: string;
    seasonId: string;
  } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const running = useRef(false);
  useLayoutEffect(() => {
    onRetainedChange?.(busy || Boolean(state.pending));
  }, [onRetainedChange, state.pending, busy]);
  useEffect(() => {
    let active = true;
    void client
      .refresh()
      .then((next) => {
        if (active) setState(next);
      })
      .catch((failure) => {
        if (!active) return;
        setError(
          failure instanceof Error
            ? failure.message
            : "Current account requests could not be read.",
        );
        setState(client.getState());
        if (
          failure instanceof AccountRequestsError &&
          failure.code === "AUTHORITY_CHANGED"
        )
          setBlocked(true);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [client]);
  async function run(work: () => Promise<AccountRequestsState>) {
    if (busy || running.current) return;
    running.current = true;
    onRetainedChange?.(true);
    setBusy(true);
    setError(null);
    setNotice(null);
    setConfirmed(false);
    try {
      const next = await work();
      setBlocked(false);
      setState(next);
      if (next.resolvedRequest)
        setNotice(
          "The service confirms this request is recorded and still pending verification and policy. Nothing has been fulfilled or erased.",
        );
      else if (next.pending)
        setNotice(
          "Fresh service status does not show a matching recorded request. Review the scope again before retrying the original submission.",
        );
    } catch (failure) {
      setState(client.getState());
      setError(
        failure instanceof Error
          ? failure.message
          : "The service did not confirm this account operation.",
      );
      if (
        failure instanceof AccountRequestsError &&
        failure.code === "AUTHORITY_CHANGED"
      )
        setBlocked(true);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  const input: PrivacyRequestInput | null =
    state.pending?.body ??
    (kind === "leave_team"
      ? selected
        ? { kind: "leave_team", ...selected, confirmLeave: true }
        : null
      : kind
        ? { kind, scope: "all_memberships", confirmAllMemberships: true }
        : null);
  const snapshot = state.snapshot;
  const affected = snapshot && input ? requestMemberships(snapshot, input) : [];
  const choices = Array.from(
    new Map(
      (snapshot?.memberships ?? [])
        .filter((item) => item.status === "active")
        .map((item) => [
          JSON.stringify([item.teamId, item.seasonId]),
          { teamId: item.teamId, seasonId: item.seasonId },
        ]),
    ).values(),
  );
  return (
    <View style={s.stack} testID="account-requests-screen">
      <View style={s.between}>
        <Text accessibilityRole="header" style={s.title}>
          Account data and membership requests
        </Text>
        {onClose && (
          <Button
            label="Close account requests"
            variant="quiet"
            disabled={busy || Boolean(state.pending)}
            onPress={onClose}
          />
        )}
      </View>
      <Notice>
        Online service requests only. Export delivery, identity verification,
        account deletion and membership changes require the agreed process. This
        screen does not approve a policy or erase anything.
      </Notice>
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      {blocked || locked ? (
        <View style={s.stack}>
          <Notice tone="warning">
            Unlock or sign in again to review this account’s requests. Private
            request data is hidden.
          </Notice>
          {!locked && (
            <Button
              label="Check current account access"
              testID="account-requests-recheck"
              disabled={busy}
              onPress={() => void run(() => client.refresh())}
            />
          )}
        </View>
      ) : (
        <>
          <Button
            label={
              busy
                ? "Checking current request status…"
                : "Refresh request status from service"
            }
            variant="secondary"
            disabled={busy}
            onPress={() => void run(() => client.refresh())}
            testID="refresh-account-requests"
          />
          {snapshot && (
            <>
              <Card>
                <Text style={s.section}>Your account</Text>
                <Button
                  label={
                    showReferences
                      ? "Hide technical references"
                      : "Show technical references"
                  }
                  compact
                  variant="quiet"
                  accessibilityState={{ expanded: showReferences }}
                  onPress={() => setShowReferences((value) => !value)}
                />
                {showReferences && (
                  <Text selectable style={s.small}>
                    {snapshot.accountId}
                  </Text>
                )}
                {identityClassification === "child_shared" && (
                  <Notice>
                    This is a shared household/player account. A request is
                    attributed to this account; LongBall does not identify which
                    household member is making it.
                  </Notice>
                )}
                <Text style={s.small}>
                  All memberships recorded for this account, including expired
                  and revoked access:
                </Text>
                <Memberships
                  memberships={snapshot.memberships}
                  labels={membershipLabels}
                  showReferences={showReferences || !membershipLabels}
                />
              </Card>
              <Card>
                <Text style={s.section}>
                  {state.pending
                    ? "Uncertain submission retained in this screen"
                    : "Choose a request"}
                </Text>
                {!state.pending && (
                  <>
                    {(["export", "delete_account", "leave_team"] as const).map(
                      (choice) => (
                        <Button
                          key={choice}
                          label={`${kind === choice ? "Selected: " : ""}${label(choice)}`}
                          variant={kind === choice ? "primary" : "secondary"}
                          accessibilityState={{ selected: kind === choice }}
                          disabled={busy}
                          onPress={() => {
                            setKind(choice);
                            setSelected(null);
                            setConfirmed(false);
                            setNotice(null);
                          }}
                          testID={`choose-account-${choice}`}
                        />
                      ),
                    )}
                    {kind === "leave_team" && (
                      <>
                        <Text style={s.small}>
                          Choose the exact current team and season. Other
                          memberships and the global account are separate.
                        </Text>
                        {choices.length ? (
                          choices.map((choice) => (
                            <Button
                              key={JSON.stringify(choice)}
                              label={`${selected?.teamId === choice.teamId && selected.seasonId === choice.seasonId ? "Selected: " : ""}${membershipLabels?.[`${choice.teamId}:${choice.seasonId}`] ?? (showReferences || !membershipLabels ? `${choice.teamId} · ${choice.seasonId}` : "Team and season details unavailable")}`}
                              variant="secondary"
                              accessibilityState={{
                                selected:
                                  selected?.teamId === choice.teamId &&
                                  selected.seasonId === choice.seasonId,
                              }}
                              disabled={busy}
                              onPress={() => {
                                setSelected(choice);
                                setConfirmed(false);
                              }}
                            />
                          ))
                        ) : (
                          <Notice>
                            No current memberships are available for a leave
                            request.
                          </Notice>
                        )}
                      </>
                    )}
                  </>
                )}
                {input && (
                  <>
                    <Text style={s.section}>{label(input.kind)}</Text>
                    <Text style={s.body}>
                      {input.kind === "leave_team"
                        ? `Scope: ${membershipLabels?.[`${input.teamId}:${input.seasonId}`] ?? (showReferences || !membershipLabels ? `${input.teamId} · ${input.seasonId}` : "the selected team and season")}. This request covers only the current memberships shown below. It does not delete the global account or remove access elsewhere.`
                        : "Scope: this global LongBall account across every team and season, including the recorded memberships below. Leaving one team or removing one spectator access grant is a separate action."}
                    </Text>
                    <Memberships
                      memberships={affected}
                      labels={membershipLabels}
                      showReferences={showReferences || !membershipLabels}
                    />
                    <Notice tone="warning">
                      {input.kind === "export"
                        ? "An account rights export needs identity verification and third-party review. No export file is generated or delivered by submitting this request."
                        : input.kind === "delete_account"
                          ? "Deletion is not immediate. Verification, lawful retention, backups, processors and controller handover remain to be resolved. Do not remove unsynchronised match records from this phone."
                          : "Memberships remain unchanged while this request is pending. Controller handover and unsynchronised records must be resolved before any later access removal."}
                    </Notice>
                    <Pressable
                      accessibilityRole="checkbox"
                      accessibilityState={{
                        checked: confirmed,
                        disabled: busy,
                      }}
                      aria-checked={confirmed}
                      aria-disabled={busy}
                      disabled={busy}
                      onPress={() => setConfirmed((value) => !value)}
                      style={s.confirm}
                      testID="confirm-account-request-scope"
                    >
                      <Text style={s.body}>
                        {confirmed ? "☑" : "☐"}{" "}
                        {input.kind === "leave_team"
                          ? "I confirm this exact team and season request."
                          : "I confirm this is a global account request covering all memberships."}
                      </Text>
                    </Pressable>
                    {state.pending ? (
                      <>
                        <Text style={s.small}>
                          The original request identity and body are held in
                          this screen’s memory. Nothing is queued in the match
                          journal. Closing or reloading requires a fresh service
                          status read; the service also prevents duplicate
                          pending business requests.
                        </Text>
                        <Button
                          label="Retry original account request"
                          disabled={
                            busy ||
                            !confirmed ||
                            state.pending.phase !== "ready_to_retry" ||
                            (input.kind === "leave_team" && !affected.length)
                          }
                          onPress={() =>
                            void run(() =>
                              client.retry(
                                accountRequestConfirmation(snapshot, input),
                              ),
                            )
                          }
                          testID="retry-account-request"
                        />
                        {state.pending.phase === "uncertain" && (
                          <Notice>
                            Refresh request status before any retry. A missing
                            response is not proof that submission failed.
                          </Notice>
                        )}
                        {input.kind === "leave_team" && !affected.length && (
                          <Notice>
                            This membership is no longer current. The original
                            uncertain request is retained; refresh service
                            status or use the agreed support process.
                          </Notice>
                        )}
                      </>
                    ) : (
                      <Button
                        label="Submit confirmed request to service"
                        disabled={
                          busy ||
                          !confirmed ||
                          (input.kind === "leave_team" && !affected.length)
                        }
                        onPress={() =>
                          void run(() =>
                            client.submit(
                              input,
                              accountRequestConfirmation(snapshot, input),
                            ),
                          )
                        }
                        testID="submit-account-request"
                      />
                    )}
                  </>
                )}
              </Card>
              <Text style={s.section}>Recorded request status</Text>
              {snapshot.items.length ? (
                [...snapshot.items]
                  .reverse()
                  .map((request) => (
                    <Request
                      key={request.requestId}
                      value={request}
                      labels={membershipLabels}
                      showReferences={showReferences || !membershipLabels}
                    />
                  ))
              ) : (
                <Notice>
                  No account requests were returned by the service.
                </Notice>
              )}
            </>
          )}
        </>
      )}
    </View>
  );
}
function Memberships({
  memberships,
  labels,
  showReferences = true,
}: {
  memberships: PrivacyAffectedMembership[] | null;
  labels?: Readonly<Record<string, string>>;
  showReferences?: boolean;
}) {
  return memberships === null ? (
    <Notice>
      The original affected-membership snapshot was not recorded. Current
      memberships are not substituted for historical evidence.
    </Notice>
  ) : memberships.length ? (
    <View style={s.stack}>
      {memberships.map((membership, index) => (
        <View
          key={JSON.stringify([
            membership.teamId,
            membership.seasonId,
            membership.role,
            membership.playerId,
            index,
          ])}
          style={s.membership}
        >
          <Text style={s.body}>
            {labels?.[`${membership.teamId}:${membership.seasonId}`] ??
              (showReferences
                ? `${membership.teamId} · ${membership.seasonId}`
                : "Earlier team or season")}
          </Text>
          <Text style={s.small}>
            {membership.role} · {membership.status}
          </Text>
        </View>
      ))}
    </View>
  ) : (
    <Text style={s.small}>No memberships in this recorded scope.</Text>
  );
}
function Request({
  value,
  labels,
  showReferences = true,
}: {
  value: PrivacyRequestDto;
  labels?: Readonly<Record<string, string>>;
  showReferences?: boolean;
}) {
  return (
    <Card>
      <View style={s.between}>
        <Text style={s.section}>{label(value.kind)}</Text>
        <Pill tone="muted">Pending</Pill>
      </View>
      {showReferences && (
        <Text selectable style={s.small}>
          Reference {value.requestId}
        </Text>
      )}
      <Text style={s.small}>
        Recorded {formatUkDateTime(value.createdAtMs)}
      </Text>
      <Text style={s.body}>
        {value.reviewStatus === "needs_scope"
          ? "Scope needs verification: this earlier request did not retain a known team and season. No scope has been guessed or approved."
          : value.reviewStatus === "duplicate_requires_review"
            ? `Retained duplicate history requires service review.${showReferences ? ` Related reference ${value.duplicateOfRequestId}.` : ""}`
            : "Pending identity verification and the agreed data policy."}
      </Text>
      <Text style={s.small}>
        {value.scope?.type === "team_season"
          ? `Selected team and season: ${labels?.[`${value.scope.teamId}:${value.scope.seasonId}`] ?? (showReferences ? `${value.scope.teamId} · ${value.scope.seasonId}` : "Earlier team or season")}`
          : value.scope?.type === "all_memberships"
            ? "Global account scope: all memberships"
            : "Original scope not recorded"}
      </Text>
      <Memberships
        memberships={value.affectedMemberships}
        labels={labels}
        showReferences={showReferences}
      />
      <Text style={s.small}>
        Fulfilment has not occurred. Nothing has been erased and memberships
        remain unchanged by this request.
      </Text>
    </Card>
  );
}
const s = StyleSheet.create({
  stack: { gap: 12 },
  between: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 10,
  },
  title: { fontSize: 24, lineHeight: 32, fontWeight: "700", color: colors.ink },
  section: {
    fontSize: 18,
    lineHeight: 26,
    fontWeight: "600",
    color: colors.ink,
  },
  body: { fontSize: 15, lineHeight: 24, color: colors.ink, flexShrink: 1 },
  small: { fontSize: 13, lineHeight: 21, color: colors.inkMuted },
  membership: {
    borderLeftWidth: 3,
    borderLeftColor: colors.controlBorder,
    paddingLeft: 10,
    gap: 3,
  },
  confirm: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.controlBorder,
    borderRadius: 8,
    backgroundColor: colors.surface,
    padding: 12,
    justifyContent: "center",
  },
});
