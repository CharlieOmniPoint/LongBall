import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import type {
  TeamPrivilege,
  TeamPrivilegeCommand,
  TeamPrivilegesView,
} from "@longball/application/team-privileges";
import { randomUUID } from "../platform/id";
import { Button, Card, Notice, Pill } from "../ui";
import { colors, typography } from "../ui/tokens";

export function TeamPrivilegesPanel({
  value,
  disabled,
  onChange,
}: {
  value: TeamPrivilegesView;
  disabled: boolean;
  onChange: (command: TeamPrivilegeCommand) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<{
    accountId: string;
    label: string;
    privilege: TeamPrivilege;
    suspended: boolean;
    revision: number;
  } | null>(null);
  const [reasonCode, setReasonCode] = useState("");
  const [privateNote, setPrivateNote] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const stale = draft !== null && draft.revision !== value.revision;
  const valid =
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(reasonCode.trim()) &&
    privateNote.length <= 1000;
  const review = (
    accountId: string,
    label: string,
    privilege: TeamPrivilege,
    suspended: boolean,
  ) => {
    setDraft({
      accountId,
      label,
      privilege,
      suspended,
      revision: value.revision,
    });
    setReasonCode("");
    setPrivateNote("");
    setFailed(false);
  };
  return (
    <View style={s.stack} testID="workspace-team-privileges">
      <Card>
        <Text accessibilityRole="header" style={typography.section}>
          Upload and invitation privileges
        </Text>
        <Text style={typography.body}>
          Manager decisions apply to this team across its seasons. Current
          membership is still required for every action.
        </Text>
        <Text style={typography.muted}>
          Existing invitations, grants and published photos keep their separate
          recorded status. Use revoke or remove when those actions are needed.
        </Text>
      </Card>
      {draft && (
        <Card>
          <Text accessibilityRole="header" style={typography.section}>
            Confirm {draft.suspended ? "suspension" : "reinstatement"}
          </Text>
          <Text style={typography.body}>
            {draft.label} ·{" "}
            {draft.privilege === "uploads"
              ? "photo contributions"
              : "creating and reissuing invitations"}
          </Text>
          <Notice tone={draft.suspended ? "warning" : "info"}>
            {draft.suspended
              ? `Future ${draft.privilege === "uploads" ? "uploads, replacements and completion of retained private uploads" : "invitation creation and reissue"} will be held in this team until a manager explicitly reinstates this privilege.`
              : `Future ${draft.privilege === "uploads" ? "photo contributions" : "invitation creation and reissue"} will be available again when the account has current access. Previously removed content or revoked invitations remain subject to their recorded decisions.`}
          </Notice>
          <Text style={typography.label}>Operational reason code</Text>
          <TextInput
            value={reasonCode}
            onChangeText={setReasonCode}
            editable={!disabled && !sending}
            maxLength={80}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Privilege decision reason code"
            testID="privilege-reason-code"
            placeholder="For example: content_review"
            style={s.input}
          />
          <Text style={typography.muted}>
            Use a short operational code with letters, numbers, underscores or
            hyphens. Do not name a reporter.
          </Text>
          <Text style={typography.label}>
            Restricted operational note · optional
          </Text>
          <TextInput
            value={privateNote}
            onChangeText={setPrivateNote}
            editable={!disabled && !sending}
            maxLength={1000}
            multiline
            accessibilityLabel="Restricted privilege decision note"
            testID="privilege-private-note"
            placeholder="Keep report details and reporter identity out of this note."
            style={[s.input, { minHeight: 80 }]}
          />
          <Text style={typography.muted}>
            The operational decision is retained in the restricted audit. The
            target account’s status and notifications do not reveal this note or
            a reporter.
          </Text>
          {stale && (
            <Notice tone="warning">
              Team privileges changed. Cancel this draft and review the current
              account status before deciding again.
            </Notice>
          )}
          {failed && (
            <Notice tone="warning">
              The service has not confirmed this decision. Review the service
              message or retained request before retrying.
            </Notice>
          )}
          <Button
            label={
              sending
                ? "Waiting for service receipt…"
                : `Confirm ${draft.suspended ? "suspend" : "reinstate"} ${draft.privilege}`
            }
            testID="privilege-confirm"
            disabled={disabled || sending || stale || !valid}
            onPress={() => {
              setSending(true);
              setFailed(false);
              void onChange({
                id: randomUUID(),
                type: draft.suspended
                  ? "privilege.suspended"
                  : "privilege.reinstated",
                expectedRevision: draft.revision,
                targetAccountId: draft.accountId,
                privilege: draft.privilege,
                reasonCode: reasonCode.trim(),
                privateNote: privateNote.trim() || null,
                confirm: true,
              })
                .then((accepted) => {
                  if (!mounted.current) return;
                  if (accepted) {
                    setDraft(null);
                    setReasonCode("");
                    setPrivateNote("");
                  } else setFailed(true);
                })
                .catch(() => {
                  if (mounted.current) setFailed(true);
                })
                .finally(() => {
                  if (mounted.current) setSending(false);
                });
            }}
          />
          <Button
            label="Cancel privilege decision"
            variant="quiet"
            disabled={sending}
            onPress={() => {
              setDraft(null);
              setReasonCode("");
              setPrivateNote("");
              setFailed(false);
            }}
          />
        </Card>
      )}
      {!value.targets.length && (
        <Notice>
          No current team accounts are available for a privilege decision.
        </Notice>
      )}
      {value.targets.map((target) => (
        <Card key={target.accountId}>
          <View
            testID={`privilege-account-${target.accountId}`}
            style={s.stack}
          >
            <Text accessibilityRole="header" style={typography.section}>
              {target.label}
            </Text>
            <Pill tone={target.uploadsSuspended ? "warning" : "brand"}>
              {target.uploadsSuspended
                ? "Photo contributions suspended"
                : "Photo contributions not suspended"}
            </Pill>
            <Button
              label={
                target.uploadsSuspended
                  ? "Review reinstating uploads"
                  : "Review suspending uploads"
              }
              testID={`privilege-${target.uploadsSuspended ? "reinstate" : "suspend"}-uploads-${target.accountId}`}
              variant="secondary"
              disabled={disabled || sending}
              onPress={() =>
                review(
                  target.accountId,
                  target.label,
                  "uploads",
                  !target.uploadsSuspended,
                )
              }
            />
            <Pill tone={target.invitationsSuspended ? "warning" : "brand"}>
              {target.invitationsSuspended
                ? "Invitation creation suspended"
                : "Invitation creation not suspended"}
            </Pill>
            <Button
              label={
                target.invitationsSuspended
                  ? "Review reinstating invitations"
                  : "Review suspending invitations"
              }
              testID={`privilege-${target.invitationsSuspended ? "reinstate" : "suspend"}-invitations-${target.accountId}`}
              variant="secondary"
              disabled={disabled || sending}
              onPress={() =>
                review(
                  target.accountId,
                  target.label,
                  "invitations",
                  !target.invitationsSuspended,
                )
              }
            />
          </View>
        </Card>
      ))}
    </View>
  );
}
const s = StyleSheet.create({
  stack: { gap: 12 },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.controlBorder,
    borderRadius: 8,
    padding: 12,
    color: colors.ink,
    backgroundColor: colors.surface,
    fontSize: 16,
  },
});
