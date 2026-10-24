import { formatUkDateTime } from "@longball/application/uk-display";
import { useState } from "react";
import type { ManagerRosterDto } from "@longball/application/staff";
import { Text, TextInput, View } from "react-native";
import { Button, Card, Notice, Pill } from "../ui";
import { colors, typography } from "../ui/tokens";
import { randomUUID } from "../platform/id";
import { useWorkspaceLayout } from "../ui/WorkspaceLayout";

export type ConnectedStaffDto = ManagerRosterDto;
export type ConnectedStaffCommand = { id: string; expectedRevision: number } & (
  | { type: "manager.assigned"; accountId: string }
  | {
      type: "manager.revoked";
      accountId: string;
      reason: string;
      confirmRevocation: true;
    }
);
const date = (value: number | null) =>
  value === null ? "No recorded expiry" : formatUkDateTime(value);
export function ConnectedStaffPanel({
  value,
  disabled,
  onChange,
}: {
  value: ConnectedStaffDto;
  disabled: boolean;
  onChange: (command: ConnectedStaffCommand) => Promise<boolean>;
}) {
  const { wide } = useWorkspaceLayout();
  const [accountId, setAccountId] = useState("");
  const [review, setReview] = useState<ConnectedStaffCommand | null>(null);
  const [revoke, setRevoke] = useState<
    ConnectedStaffDto["managers"][number] | null
  >(null);
  const [reason, setReason] = useState("");
  const locked = disabled || !value.canMutate;
  const inputStyle = {
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.controlBorder,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    color: colors.ink,
    backgroundColor: colors.surface,
  };
  const targetLabel = (id: string) =>
    value.managers.find((person) => person.accountId === id)?.label ??
    value.candidates.find((person) => person.accountId === id)?.label ??
    id;
  if (review)
    return (
      <Card>
        <Text style={typography.section}>
          {review.type === "manager.assigned"
            ? "Review manager assignment"
            : "Review manager revocation"}
        </Text>
        <Text style={typography.label}>{targetLabel(review.accountId)}</Text>
        <Text selectable style={typography.muted}>
          {review.accountId} · season {value.seasonId}
        </Text>
        {review.type === "manager.assigned" ? (
          <Notice>
            This gives manager access in this season. The service checks the
            existing account’s verified adult individual status, stronger
            sign-in enrolment, current administrator authority and the team-wide
            limit again.
          </Notice>
        ) : (
          <>
            <Notice tone="warning">
              This removes this season’s manager access. Other seasons and other
              roles retain their separate assignments. Accepted match records
              remain available under their existing policies. Transfer active
              match control first if the service requires it.
            </Notice>
            <Text style={typography.body}>
              Recorded reason: {review.reason}
            </Text>
          </>
        )}
        <Button
          label={
            review.type === "manager.assigned"
              ? "Confirm this-season manager assignment"
              : "Confirm this-season manager revocation"
          }
          testID="staff-confirm"
          variant={review.type === "manager.revoked" ? "danger" : "primary"}
          disabled={locked || review.expectedRevision !== value.revision}
          onPress={() => {
            void onChange(review).then((saved) => {
              if (saved) {
                setReview(null);
                setAccountId("");
                setRevoke(null);
                setReason("");
              }
            });
          }}
        />
        <Button
          label="Edit staff review"
          variant="secondary"
          disabled={disabled}
          onPress={() => setReview(null)}
        />
      </Card>
    );
  return (
    <View
      style={{
        gap: 16,
        flexDirection: wide ? "row" : "column",
        alignItems: "flex-start",
      }}
      testID="connected-staff"
    >
      <View
        style={{ minWidth: 0, ...(wide ? { flex: 1 } : { width: "100%" }) }}
        testID="staff-roster-panel"
      >
        <Card>
          <Text style={typography.section}>Season managers</Text>
          <Pill>
            {value.activeTeamManagerCount} of {value.maximumManagers} distinct
            active team manager accounts
          </Pill>
          <Text style={typography.body}>
            The limit includes every active season for this team. An
            administrator assignment is separate from a manager assignment.
          </Text>
          <Text style={typography.muted}>
            Current authorised roster · {formatUkDateTime(value.asOf)} ·
            revision {value.revision}
          </Text>
          {!value.canMutate && (
            <Notice tone="warning">
              A current team administrator with recent stronger sign-in must
              confirm staff changes. Sign in again before assigning or revoking
              access.
            </Notice>
          )}
          {!value.managers.length && (
            <Text style={typography.body}>
              No manager assignments are recorded in this season.
            </Text>
          )}
          {value.managers.map((person) => (
            <View
              key={person.accountId}
              style={{
                gap: 8,
                borderTopWidth: 1,
                borderTopColor: colors.border,
                paddingTop: 12,
              }}
            >
              <Text style={typography.label}>{person.label}</Text>
              <Pill tone={person.status === "active" ? "brand" : "muted"}>
                {person.status}
              </Pill>
              <Text selectable style={typography.muted}>
                Account reference: {person.accountId}
              </Text>
              <Text style={typography.muted}>{date(person.expiresAt)}</Text>
              {person.otherActiveSeasonIds.length > 0 && (
                <Text style={typography.muted}>
                  Also active in {person.otherActiveSeasonIds.length} other
                  season
                  {person.otherActiveSeasonIds.length === 1 ? "" : "s"}.
                  Revoking this assignment alone may leave the team-wide account
                  count unchanged.
                </Text>
              )}
              {person.revokedAt === null && person.status !== "revoked" && (
                <Button
                  label={`Review revoking ${person.label} manager access`}
                  variant="secondary"
                  disabled={locked}
                  onPress={() => {
                    setRevoke(person);
                    setReason("");
                  }}
                />
              )}
            </View>
          ))}
        </Card>
      </View>
      <View
        style={{ minWidth: 0, ...(wide ? { flex: 1 } : { width: "100%" }) }}
        testID="staff-edit-panel"
      >
        {revoke ? (
          <Card>
            <Text style={typography.section}>
              Reason for revoking {revoke.label}
            </Text>
            <Text style={typography.body}>
              Review the account reference and this season before confirming.
              The service retains an audit entry.
            </Text>
            <TextInput
              accessibilityLabel="Manager revocation reason"
              value={reason}
              onChangeText={setReason}
              multiline
              editable={!locked}
              style={inputStyle}
            />
            <Button
              label="Review this-season manager revocation"
              testID="staff-review-revoke"
              disabled={locked || !reason.trim() || reason.trim().length > 500}
              onPress={() =>
                setReview({
                  id: randomUUID(),
                  expectedRevision: value.revision,
                  type: "manager.revoked",
                  accountId: revoke.accountId,
                  reason: reason.trim(),
                  confirmRevocation: true,
                })
              }
            />
            <Button
              label="Keep manager assignment"
              variant="quiet"
              disabled={disabled}
              onPress={() => setRevoke(null)}
            />
          </Card>
        ) : (
          <Card>
            <Text style={typography.section}>
              Assign an existing adult account
            </Text>
            <Text style={typography.body}>
              Select an associated verified adult or enter an existing opaque
              account reference supplied through the account service. A player
              profile or typed age does not establish adult authority.
            </Text>
            {value.candidates
              .filter((person) => !person.currentManager)
              .map((person) => (
                <Button
                  key={person.accountId}
                  label={`Select ${person.label} for manager review`}
                  variant={
                    accountId === person.accountId ? "primary" : "secondary"
                  }
                  disabled={locked}
                  onPress={() => setAccountId(person.accountId)}
                />
              ))}
            <TextInput
              accessibilityLabel="Existing adult account reference"
              value={accountId}
              onChangeText={setAccountId}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!locked}
              style={inputStyle}
            />
            {value.activeTeamManagerCount >= value.maximumManagers && (
              <Notice tone="warning">
                The team has reached its distinct active-manager limit. Adding
                another distinct account requires an explicit eligible
                revocation first. Renewing an account already active in another
                season remains a service decision.
              </Notice>
            )}
            <Button
              label="Review this-season manager assignment"
              testID="staff-review-assign"
              disabled={
                locked || !/^[A-Za-z0-9_-]{1,80}$/.test(accountId.trim())
              }
              onPress={() =>
                setReview({
                  id: randomUUID(),
                  expectedRevision: value.revision,
                  type: "manager.assigned",
                  accountId: accountId.trim(),
                })
              }
            />
          </Card>
        )}
      </View>
    </View>
  );
}
