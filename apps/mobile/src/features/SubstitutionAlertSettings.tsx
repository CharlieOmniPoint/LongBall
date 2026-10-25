import { useState } from "react";
import { Switch, Text, TextInput, View } from "react-native";
import {
  assertSubstitutionAlertSettings,
  DEFAULT_SUBSTITUTION_ALERTS,
  type SubstitutionAlertSettings as Settings,
} from "@longball/application/substitution-alerts";
import { Button, Card, Notice, typography, colors } from "../ui";
import {
  playSubstitutionAudio,
  prepareSubstitutionAudio,
  substitutionAudioCapability,
} from "../platform/substitution-audio";
import {
  acknowledgeRevisionedValueDraft,
  refreshRevisionedValueDraft,
  reviewRevisionedValueDraft,
  revisionedValueDraft,
  revisionedValueNeedsReview,
} from "../platform/revisioned-value-draft";
import { useDraftSignal } from "../platform/use-unsaved-draft";

type SettingsProps = {
  value?: Settings;
  scopeKey?: string;
  disabled: boolean;
  onSave: (settings: Settings) => Promise<boolean>;
  onDraftChange?: (dirty: boolean) => void;
};
const fields = (value: Settings) => ({
  enabled: value.enabled,
  lead: String(value.leadSeconds),
  volume: String(Math.round(value.volume * 100)),
});
const same = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

export function SubstitutionAlertSettings(props: SettingsProps) {
  return (
    <SubstitutionAlertSettingsDraft key={props.scopeKey ?? "team"} {...props} />
  );
}
function SubstitutionAlertSettingsDraft({
  value,
  disabled,
  onSave,
  onDraftChange,
}: SettingsProps) {
  const source = fields(value ?? DEFAULT_SUBSTITUTION_ALERTS);
  const [model, setModel] = useState(() => revisionedValueDraft(source, 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (!same(model.source, source)) {
    setModel(
      same(model.value, source)
        ? revisionedValueDraft(source, model.revision + 1)
        : refreshRevisionedValueDraft(model, source, model.revision + 1),
    );
  }
  const { enabled, lead, volume } = model.value;
  const needsReview = revisionedValueNeedsReview(model);
  const dirty = !same(model.value, model.source);
  useDraftSignal(dirty, onDraftChange);
  const change = (patch: Partial<typeof model.value>) =>
    setModel((current) => ({
      ...current,
      value: { ...current.value, ...patch },
    }));
  const settings = () => {
    if (!lead.trim() || !volume.trim())
      throw new Error("Enter the warning time and volume.");
    const next = {
      enabled,
      leadSeconds: Number(lead),
      volume: Number(volume) / 100,
    };
    assertSubstitutionAlertSettings(next);
    return next;
  };
  const run = async (save: boolean) => {
    if (disabled || busy || (save && needsReview)) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = settings();
      if (save) {
        const submitted = fields(next);
        setModel((current) => ({ ...current, value: submitted }));
        const accepted = await onSave(next);
        if (accepted)
          setModel((current) =>
            acknowledgeRevisionedValueDraft(current, submitted),
          );
        setMessage(
          accepted
            ? "Team substitution alerts saved. Enable audio on each match-day device."
            : "The save was not confirmed. Your draft is retained.",
        );
      } else {
        await prepareSubstitutionAudio();
        await playSubstitutionAudio(next.volume);
        setMessage(
          "Test tone played. Device volume and mute settings still apply.",
        );
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Alert settings could not be applied.",
      );
    } finally {
      setBusy(false);
    }
  };
  const input = {
    borderWidth: 1,
    borderColor: colors.controlBorder,
    borderRadius: 8,
    padding: 10,
    color: colors.ink,
    backgroundColor: colors.surface,
    fontSize: 16,
    minHeight: 44,
    width: 100,
  };
  return (
    <Card>
      <Text style={typography.section}>Substitution audio</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Switch
          accessibilityLabel="Enable team substitution audio"
          value={enabled}
          disabled={disabled || busy}
          onValueChange={(next) => change({ enabled: next })}
        />
        <Text style={typography.body}>Sound before the next change</Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
        <View style={{ gap: 4 }}>
          <Text style={typography.label}>Seconds before · 0–300</Text>
          <TextInput
            accessibilityLabel="Substitution audio seconds before"
            keyboardType="number-pad"
            maxLength={3}
            editable={!disabled && !busy}
            value={lead}
            onChangeText={(next) => change({ lead: next })}
            style={input}
          />
        </View>
        <View style={{ gap: 4 }}>
          <Text style={typography.label}>Volume · 0–100%</Text>
          <TextInput
            accessibilityLabel="Substitution audio volume percent"
            keyboardType="number-pad"
            maxLength={3}
            editable={!disabled && !busy}
            value={volume}
            onChangeText={(next) => change({ volume: next })}
            style={input}
          />
        </View>
      </View>
      {needsReview && (
        <Notice tone="warning">
          Saved team alert settings changed while you were editing. Your draft
          is retained. Current settings:{" "}
          {source.enabled ? "sound enabled" : "sound disabled"}, {source.lead}{" "}
          seconds before, {source.volume}% volume.
          <Button
            label="Reviewed saved alerts; keep draft"
            compact
            variant="secondary"
            disabled={disabled || busy}
            onPress={() =>
              setModel((current) => reviewRevisionedValueDraft(current))
            }
          />
        </Notice>
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button
          label="Save team alerts"
          compact
          disabled={disabled || busy || needsReview || !dirty}
          testID="save-substitution-alerts"
          onPress={() => {
            void run(true);
          }}
        />
        <Button
          label="Test sound"
          compact
          variant="secondary"
          disabled={disabled || busy}
          onPress={() => {
            void run(false);
          }}
        />
        {dirty && (
          <Button
            label="Discard alert changes"
            testID="substitution-alerts-discard"
            compact
            variant="quiet"
            disabled={disabled || busy}
            onPress={() => {
              setModel(revisionedValueDraft(source, model.revision));
              setError(null);
              setMessage("Unsaved alert changes discarded.");
            }}
          />
        )}
      </View>
      <Text style={typography.muted}>
        Only the current Manager recording an active game receives the tone.
        Pausing, clock recovery or losing control cancels it. Each device must
        enable its own audio.
      </Text>
      <Text style={typography.muted}>{substitutionAudioCapability}</Text>
      {error && <Notice tone="warning">{error}</Notice>}
      {message && <Notice>{message}</Notice>}
    </Card>
  );
}
