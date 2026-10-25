import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { normaliseFaPlayerId } from "@longball/application/preparation";
import { Button, Notice, typography, colors } from "../ui";
import { useDraftSignal } from "../platform/use-unsaved-draft";
import {
  acknowledgeRevisionedValueDraft,
  refreshRevisionedValueDraft,
  reviewRevisionedValueDraft,
  revisionedValueDraft,
  revisionedValueNeedsReview,
} from "../platform/revisioned-value-draft";
function OptionalDetail({
  value,
  label,
  maxLength,
  onSave,
  disabled,
  numeric = false,
  testID,
  onDraftChange,
}: {
  value: string;
  label: string;
  maxLength: number;
  onSave: (value: string) => Promise<boolean>;
  disabled?: boolean;
  numeric?: boolean;
  testID: string;
  onDraftChange?: (dirty: boolean) => void;
}) {
  const [model, setModel] = useState(() => revisionedValueDraft(value, 0)),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState<string | null>(null);
  if (model.source !== value) {
    setModel(
      model.value === value
        ? revisionedValueDraft(value, model.revision + 1)
        : refreshRevisionedValueDraft(model, value, model.revision + 1),
    );
  }
  const draft = model.value;
  const needsReview = revisionedValueNeedsReview(model);
  const dirty = draft !== model.source;
  useDraftSignal(dirty, onDraftChange);
  return (
    <View style={{ gap: 8 }}>
      <Text style={typography.label}>{label} (optional)</Text>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <TextInput
          style={[
            typography.body,
            {
              minWidth: 0,
              flex: 1,
              borderColor: colors.border,
              borderWidth: 1,
              borderRadius: 8,
              padding: 10,
            },
          ]}
          accessibilityLabel={label}
          testID={testID}
          value={draft}
          editable={!disabled && !busy}
          keyboardType={numeric ? "number-pad" : "default"}
          maxLength={maxLength}
          onChangeText={(next) =>
            setModel((current) => ({ ...current, value: next }))
          }
        />
        <Button
          label="Save"
          compact
          disabled={disabled || busy || needsReview || draft === value}
          testID={`${testID}-save`}
          onPress={() => {
            try {
              if (numeric) normaliseFaPlayerId(draft);
              const submitted = draft.trim();
              setModel((current) => ({ ...current, value: submitted }));
              setBusy(true);
              void onSave(submitted)
                .then((saved) => {
                  if (saved)
                    setModel((current) =>
                      acknowledgeRevisionedValueDraft(current, submitted),
                    );
                  setMessage(
                    saved
                      ? "Saved."
                      : "The change was not confirmed. Review and try again.",
                  );
                })
                .catch((error) =>
                  setMessage(
                    error instanceof Error
                      ? error.message
                      : "The change was not saved.",
                  ),
                )
                .finally(() => setBusy(false));
            } catch (error) {
              setMessage(
                error instanceof Error ? error.message : "Check this value.",
              );
            }
          }}
        />
      </View>
      {needsReview && (
        <View style={{ gap: 8 }}>
          <Notice tone="warning">
            The saved {label.toLowerCase()} changed to {value || "blank"}. Your
            draft is retained. Review the current value before replacing it.
          </Notice>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Button
              label="Reviewed current value; keep draft"
              compact
              variant="secondary"
              disabled={disabled || busy}
              onPress={() =>
                setModel((current) => reviewRevisionedValueDraft(current))
              }
            />
            <Button
              label="Use saved value"
              compact
              variant="quiet"
              disabled={disabled || busy}
              onPress={() =>
                setModel(revisionedValueDraft(value, model.revision))
              }
            />
          </View>
        </View>
      )}
      {dirty && !needsReview && (
        <Button
          label={`Discard ${label.toLowerCase()} changes`}
          testID={`${testID}-discard`}
          compact
          variant="quiet"
          disabled={disabled || busy}
          onPress={() => {
            setModel(revisionedValueDraft(value, model.revision));
            setMessage("Unsaved changes discarded.");
          }}
        />
      )}
      {message && <Notice>{message}</Notice>}
    </View>
  );
}
export function FaPlayerIdEditor({
  value,
  onSave,
  disabled,
  onDraftChange,
}: {
  value?: string | null;
  onSave: (value: string | null) => Promise<boolean>;
  disabled?: boolean;
  onDraftChange?: (dirty: boolean) => void;
}) {
  return (
    <OptionalDetail
      value={value ?? ""}
      label="FA player ID"
      maxLength={20}
      numeric
      onSave={(draft) => onSave(normaliseFaPlayerId(draft))}
      disabled={disabled}
      testID="fa-player-id"
      onDraftChange={onDraftChange}
    />
  );
}
export function TeamLeagueEditor({
  value,
  onSave,
  disabled,
  onDraftChange,
}: {
  value?: string;
  onSave: (value: string) => Promise<boolean>;
  disabled?: boolean;
  onDraftChange?: (dirty: boolean) => void;
}) {
  return (
    <OptionalDetail
      value={value ?? ""}
      label="League"
      maxLength={120}
      onSave={onSave}
      disabled={disabled}
      testID="team-league"
      onDraftChange={onDraftChange}
    />
  );
}
