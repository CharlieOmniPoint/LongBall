import { formatUkDateTime } from "@longball/application/uk-display";
import { useState } from "react";
import type { ManagerRosterDto } from "@longball/application/staff";
import { Text, TextInput, View } from "react-native";
import { Button, Card, Notice, Pill } from "../ui";
import { colors, typography } from "../ui/tokens";
import { randomUUID } from "../platform/id";
import { accountChoiceLabel } from "../platform/account-choice-labels";
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
export function ConnectedStaffPanel(props: {
  value: ConnectedStaffDto;
  disabled: boolean;
  onChange: (command: ConnectedStaffCommand) => Promise<boolean>;
}) {
  return (
    <ScopedConnectedStaffPanel
      key={`${props.value.teamId}:${props.value.seasonId}`}
      {...props}
    />
  );
}

function ScopedConnectedStaffPanel({
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
  const [accountSearch, setAccountSearch] = useState("");
  const [candidateLimit, setCandidateLimit] = useState(20);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [detailsAccountId, setDetailsAccountId] = useState<string | null>(null);
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
  const allAccounts = [...value.managers, ...value.candidates];
  const targetLabel = (id: string) => {
    const account = allAccounts.find((person) => person.accountId === id);
    return account ? accountChoiceLabel(account, allAccounts) : id;
  };
  const availableCandidates = value.candidates.filter(
    (person) => !person.currentManager,
  );
  const matchingCandidates = availableCandidates.filter((person) =>
    `${person.label} ${person.accountId}`
      .toLocaleLowerCase("en-GB")
      .includes(accountSearch.trim().toLocaleLowerCase("en-GB")),
  );
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
        {review.expectedRevision !== value.revision && (
          <Notice tone="warning">
            The manager roster changed while this review was open. Return to
            editing and review the latest roster before confirming.
          </Notice>
        )}
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
                setReferenceOpen(false);
                setAccountSearch("");
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
            {value.activeTeamManagerCount} of {value.maximumManagers} appointed
            manager places
          </Pill>
          <Text style={typography.body}>
            Appointed managers count across this team’s active seasons. Club and
            Super Admin management access is inherited separately.
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
              <Text style={typography.label}>
                {targetLabel(person.accountId)}
              </Text>
              <Pill tone={person.status === "active" ? "brand" : "muted"}>
                {person.status}
              </Pill>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                <Button
                  compact
                  label="Account details"
                  accessibilityLabel={`Account details for ${targetLabel(person.accountId)}`}
                  variant="quiet"
                  accessibilityState={{
                    expanded: detailsAccountId === person.accountId,
                  }}
                  disabled={disabled}
                  onPress={() =>
                    setDetailsAccountId((current) =>
                      current === person.accountId ? null : person.accountId,
                    )
                  }
                />
                {person.revokedAt === null && person.status !== "revoked" && (
                  <Button
                    compact
                    label="Review removal"
                    accessibilityLabel={`Review revoking ${targetLabel(person.accountId)} manager access`}
                    variant="secondary"
                    disabled={locked}
                    onPress={() => {
                      setRevoke(person);
                      setReason("");
                    }}
                  />
                )}
              </View>
              {detailsAccountId === person.accountId && (
                <>
                  <Text selectable style={typography.muted}>
                    Account reference: {person.accountId}
                  </Text>
                  <Text style={typography.muted}>{date(person.expiresAt)}</Text>
                  {person.otherActiveSeasonIds.length > 0 && (
                    <Text style={typography.muted}>
                      Also active in {person.otherActiveSeasonIds.length} other
                      season
                      {person.otherActiveSeasonIds.length === 1 ? "" : "s"}.
                      Revoking this assignment alone may leave the team-wide
                      account count unchanged.
                    </Text>
                  )}
                </>
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
              Reason for revoking {targetLabel(revoke.accountId)}
            </Text>
            <Text style={typography.body}>
              Review the account reference and this season before confirming.
              Give a brief reason of 5–500 characters. The service retains an
              audit entry.
            </Text>
            <TextInput
              accessibilityLabel="Manager revocation reason"
              value={reason}
              onChangeText={setReason}
              multiline
              maxLength={500}
              editable={!locked}
              style={inputStyle}
            />
            <Text style={typography.muted}>{reason.length}/500 characters</Text>
            <Button
              label="Review this-season manager revocation"
              testID="staff-review-revoke"
              disabled={
                locked || reason.trim().length < 5 || reason.trim().length > 500
              }
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
              Choose a verified adult already associated with this team. The
              service checks their eligibility and available manager places
              again when you confirm.
            </Text>
            <TextInput
              accessibilityLabel="Search manager candidates"
              placeholder="Find an adult account"
              value={accountSearch}
              onChangeText={(text) => {
                setAccountSearch(text);
                setCandidateLimit(20);
              }}
              editable={!locked}
              style={inputStyle}
            />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {matchingCandidates.slice(0, candidateLimit).map((person) => (
                <Button
                  compact
                  key={person.accountId}
                  label={`Select ${targetLabel(person.accountId)} for manager review`}
                  variant={
                    accountId === person.accountId ? "primary" : "secondary"
                  }
                  disabled={locked}
                  accessibilityState={{
                    selected: accountId === person.accountId,
                  }}
                  onPress={() => {
                    setAccountId(person.accountId);
                    setReferenceOpen(false);
                  }}
                />
              ))}
            </View>
            {matchingCandidates.length > candidateLimit && (
              <Button
                compact
                variant="quiet"
                label="Show more manager candidates"
                disabled={locked}
                onPress={() => setCandidateLimit((current) => current + 20)}
              />
            )}
            {!matchingCandidates.length && (
              <Text style={typography.muted}>
                {availableCandidates.length
                  ? "No adult accounts match this search."
                  : "No additional verified adult accounts are associated with this team."}
              </Text>
            )}
            {accountId && (
              <Text style={typography.label}>
                Selected:{" "}
                {referenceOpen
                  ? "Account reference entered"
                  : targetLabel(accountId)}
              </Text>
            )}
            <Button
              compact
              variant="quiet"
              label={
                referenceOpen
                  ? "Hide account reference"
                  : "Enter an account reference"
              }
              accessibilityState={{ expanded: referenceOpen }}
              disabled={locked}
              onPress={() => setReferenceOpen((value) => !value)}
            />
            {referenceOpen && (
              <>
                <Text style={typography.muted}>
                  Use an existing adult account reference supplied by the
                  account service. A player profile, email address or typed age
                  does not establish adult authority.
                </Text>
                <TextInput
                  accessibilityLabel="Existing adult account reference"
                  maxLength={80}
                  value={accountId}
                  onChangeText={setAccountId}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!locked}
                  style={inputStyle}
                />
              </>
            )}
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
