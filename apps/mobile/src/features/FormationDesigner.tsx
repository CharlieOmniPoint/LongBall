import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import {
  activePositionCodes,
  type PreparationCommand,
  type PreparationFormation,
  type PreparationState,
} from "@longball/application/preparation";
import {
  patternFromFormation,
  TRADITIONAL_FORMATIONS,
} from "@longball/application/formation-pattern";
import { Button, Card, colors, Notice, Pitch, Pill, typography } from "../ui";
import { useWorkspaceLayout, WorkspaceColumns } from "../ui/WorkspaceLayout";
import { randomUUID } from "../platform/id";
import {
  formationDraftFingerprint,
  previewFormationDraft,
  type FormationDraftSource,
} from "../platform/formation-draft";

export interface FormationDesignerProps {
  state: PreparationState;
  onChange: (command: PreparationCommand) => Promise<boolean> | boolean;
  busy?: boolean;
  error?: string | null;
  onDraftChange?: (dirty: boolean) => void;
}
interface FormationEditorDraft {
  source: FormationDraftSource | null;
  format: number;
  pattern: string;
  name: string;
  id: string;
  slotOverrides: Record<string, string>;
  revision: number;
  fingerprint: string;
}
/** Uses the same revisioned preparation command as the advanced template editor. */
export function FormationDesigner(props: FormationDesignerProps) {
  return (
    <FormationDesignerDraft
      key={`${props.state.club.id}:${props.state.team.id}:${props.state.activeSeasonId}`}
      {...props}
    />
  );
}
function FormationDesignerDraft({
  state,
  onChange,
  busy = false,
  error,
  onDraftChange,
}: FormationDesignerProps) {
  const { wide } = useWorkspaceLayout();
  const initialFormat = state.team.defaultPitchPlaces;
  const [format, setFormat] = useState(initialFormat);
  const [pattern, setPattern] = useState(
    TRADITIONAL_FORMATIONS[initialFormat]?.[0] ?? "2-3-1",
  );
  const [name, setName] = useState("");
  const [id, setId] = useState(randomUUID);
  const [sourceRevision, setSourceRevision] = useState(state.revision);
  const [sourceFormation, setSourceFormation] =
    useState<FormationDraftSource | null>(null);
  const [slotOverrides, setSlotOverrides] = useState<Record<string, string>>(
    {},
  );
  const [showSaved, setShowSaved] = useState(false),
    [showCodes, setShowCodes] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const active = activePositionCodes(state);
  const stale = sourceRevision !== state.revision;
  const preview = useMemo(() => {
    try {
      return {
        ...previewFormationDraft({
          source: sourceFormation,
          pattern,
          format,
          id,
          name,
          slotOverrides,
        }),
        error: null,
      };
    } catch (cause) {
      return {
        formation: null,
        customLayout: false,
        preservesSavedLayout: false,
        error: cause instanceof Error ? cause.message : "Check the formation.",
      };
    }
  }, [sourceFormation, pattern, format, id, name, slotOverrides]);
  const inactive = [
    ...new Set(
      preview.formation?.slots
        .filter((slot) => !active.includes(slot.position))
        .map((slot) => slot.position) ?? [],
    ),
  ];
  const keeperSlotId = preview.preservesSavedLayout
    ? sourceFormation?.slots.find((slot) => slot.position === "GK")?.id
    : "gk-1";
  const roleError =
    preview.formation &&
    preview.formation.slots.filter((slot) => slot.position === "GK").length !==
      1
      ? "Keep exactly one goalkeeper. Use another active two-letter position for the outfield places."
      : null;
  const [cleanDraft, setCleanDraft] = useState<FormationEditorDraft>(() => ({
    source: sourceFormation,
    format,
    pattern,
    name,
    id,
    slotOverrides: {},
    revision: sourceRevision,
    fingerprint: preview.formation
      ? formationDraftFingerprint(preview.formation)
      : "invalid-initial-formation",
  }));
  const [switchIntent, setSwitchIntent] = useState<
    { type: "new" } | { type: "saved"; id: string } | null
  >(null);
  const fingerprint = preview.formation
    ? formationDraftFingerprint(preview.formation)
    : JSON.stringify({
        invalid: true,
        format,
        pattern,
        name,
        id,
        slotOverrides,
      });
  const dirty = fingerprint !== cleanDraft.fingerprint;
  const draftChange = useRef(onDraftChange);
  useLayoutEffect(() => {
    draftChange.current = onDraftChange;
    onDraftChange?.(dirty);
  }, [onDraftChange, dirty]);
  useLayoutEffect(() => () => draftChange.current?.(false), []);
  const locked = busy || saving || switchIntent !== null;
  const loadDraft = (next: FormationEditorDraft) => {
    setFormat(next.format);
    setPattern(next.pattern);
    setName(next.name);
    setId(next.id);
    setSourceRevision(next.revision);
    setSourceFormation(next.source);
    setSlotOverrides({ ...next.slotOverrides });
    setSwitchIntent(null);
    setLocalError(null);
    setNotice(null);
  };
  const switchDraft = (intent: NonNullable<typeof switchIntent>) => {
    const saved =
      intent.type === "saved"
        ? state.formations.find((formation) => formation.id === intent.id)
        : null;
    if (intent.type === "saved" && !saved) {
      setSwitchIntent(null);
      setLocalError(
        "That saved formation is no longer available. Your current draft is retained.",
      );
      return;
    }
    const nextFormat = saved?.format ?? state.team.defaultPitchPlaces;
    const next = {
      source: saved ?? null,
      format: nextFormat,
      pattern: saved
        ? (patternFromFormation(saved) ?? "")
        : TRADITIONAL_FORMATIONS[nextFormat][0],
      name: saved?.name ?? "",
      id: saved?.id ?? randomUUID(),
      slotOverrides: {},
      revision: state.revision,
    };
    const clean = {
      ...next,
      fingerprint: formationDraftFingerprint(
        previewFormationDraft(next).formation,
      ),
    };
    loadDraft(clean);
    setCleanDraft(clean);
  };
  const requestSwitch = (intent: NonNullable<typeof switchIntent>) => {
    if (dirty) setSwitchIntent(intent);
    else switchDraft(intent);
  };
  const save = async () => {
    if (!preview.formation || stale || locked || inactive.length || roleError)
      return;
    setSaving(true);
    setLocalError(null);
    setNotice(null);
    try {
      const saved = await onChange({
        id: randomUUID(),
        expectedRevision: sourceRevision,
        type: "formation.saved",
        formation: preview.formation,
      });
      if (saved) {
        const clean = {
          source: preview.formation,
          format,
          pattern,
          name: preview.formation.name,
          id,
          slotOverrides: {},
          revision: sourceRevision + 1,
          fingerprint: formationDraftFingerprint(preview.formation),
        };
        loadDraft(clean);
        setCleanDraft(clean);
        setNotice("Formation saved. Choose it when preparing a match.");
      }
    } catch (cause) {
      setLocalError(
        cause instanceof Error
          ? cause.message
          : "The formation could not be saved. Your draft is retained.",
      );
    } finally {
      setSaving(false);
    }
  };
  if (dirty && !saving && state.revision > sourceRevision) {
    const current = state.formations.find((formation) => formation.id === id);
    if (current && formationDraftFingerprint(current) === fingerprint) {
      // A later authoritative read can confirm the original save after its receipt was lost.
      setSourceFormation(current);
      setName(current.name);
      setSlotOverrides({});
      setSourceRevision(state.revision);
      setCleanDraft({
        source: current,
        format,
        pattern,
        name: current.name,
        id,
        slotOverrides: {},
        revision: state.revision,
        fingerprint,
      });
      setNotice("The current saved formation matches this draft.");
    }
  }
  return (
    <View style={styles.stack} testID="formation-designer">
      <View style={styles.heading}>
        <Text accessibilityRole="header" style={typography.section}>
          Formation
        </Text>
        <Pill tone="muted">Positions only</Pill>
      </View>
      <Text style={typography.body}>
        Enter the outfield lines from defence to attack. We add one goalkeeper,
        so 4-4-2 is 11-a-side and 3-2-1 is 7-a-side.
      </Text>
      {switchIntent && (
        <View style={styles.stack} testID="formation-draft-switch-review">
          <Notice tone="warning">
            You have unsaved formation changes. Keep editing, or discard this
            draft before{" "}
            {switchIntent.type === "new"
              ? "starting a new formation"
              : "opening another saved formation"}
            .
          </Notice>
          <View style={styles.row}>
            <Button
              label="Keep editing formation"
              variant="secondary"
              disabled={busy || saving}
              onPress={() => setSwitchIntent(null)}
            />
            <Button
              label={
                switchIntent.type === "new"
                  ? "Discard draft and start new"
                  : "Discard draft and open formation"
              }
              variant="danger"
              disabled={busy || saving}
              onPress={() => switchDraft(switchIntent)}
            />
          </View>
        </View>
      )}
      {state.formations.length > 0 && (
        <View style={styles.stack}>
          {wide ? (
            <Text style={typography.label}>Saved formations</Text>
          ) : (
            <Button
              label={
                showSaved
                  ? "Hide saved formations"
                  : `Choose a saved formation (${state.formations.length})`
              }
              variant="quiet"
              compact
              accessibilityState={{ expanded: showSaved }}
              disabled={locked}
              onPress={() => setShowSaved((value) => !value)}
            />
          )}
          {(wide || showSaved) && (
            <View style={styles.row}>
              {state.formations.map((formation) => (
                <Button
                  key={formation.id}
                  label={`${formation.name} · ${formation.format}-a-side`}
                  compact
                  variant={formation.id === id ? "primary" : "secondary"}
                  disabled={locked}
                  onPress={() =>
                    requestSwitch({ type: "saved", id: formation.id })
                  }
                />
              ))}
            </View>
          )}
          <Button
            label="New formation"
            variant="quiet"
            disabled={locked}
            onPress={() => requestSwitch({ type: "new" })}
          />
        </View>
      )}
      <WorkspaceColumns testID="formation-designer-columns">
        <Card>
          <Text style={typography.label}>
            Players a side, including goalkeeper
          </Text>
          <View style={styles.row}>
            {[5, 6, 7, 8, 9, 10, 11].map((value) => (
              <Button
                key={value}
                compact
                label={String(value)}
                variant={value === format ? "primary" : "secondary"}
                disabled={locked}
                onPress={() => {
                  setFormat(value);
                  setPattern(TRADITIONAL_FORMATIONS[value][0]);
                  setSlotOverrides({});
                  setNotice(null);
                }}
              />
            ))}
          </View>
          <Text style={typography.label}>Formation</Text>
          <TextInput
            accessibilityLabel="Formation pattern"
            testID="formation-pattern-input"
            value={pattern}
            editable={!locked}
            onChangeText={(value) => {
              setPattern(value);
              setSlotOverrides({});
              setNotice(null);
            }}
            placeholder={
              format === 11 ? "4-4-2" : TRADITIONAL_FORMATIONS[format][0]
            }
            maxLength={32}
            style={styles.input}
            autoCorrect={false}
          />
          {preview.customLayout && (
            <Notice>
              Saved custom layout. Keep it as it is, or enter a formation
              pattern to replace its layout.
            </Notice>
          )}
          <View style={styles.row}>
            {TRADITIONAL_FORMATIONS[format].map((value) => (
              <Button
                key={value}
                compact
                label={value}
                variant={value === pattern ? "primary" : "secondary"}
                disabled={locked}
                onPress={() => {
                  setPattern(value);
                  setSlotOverrides({});
                  setNotice(null);
                }}
              />
            ))}
          </View>
          <Text style={typography.label}>Name · optional</Text>
          <TextInput
            accessibilityLabel="Formation template name"
            value={name}
            editable={!locked}
            onChangeText={(value) => {
              setName(value);
              setNotice(null);
            }}
            placeholder="Uses the formation if left blank"
            maxLength={40}
            style={styles.input}
          />
          {preview.error && <Notice tone="warning">{preview.error}</Notice>}
          {inactive.length > 0 && (
            <Notice tone="warning">
              Activate {inactive.join(", ")} under Team positions or change the
              role codes below before saving.
            </Notice>
          )}
          {roleError && <Notice tone="warning">{roleError}</Notice>}
          {preview.formation && (
            <>
              {!wide && (
                <Button
                  label={
                    showCodes ? "Hide position codes" : "Edit position codes"
                  }
                  variant="quiet"
                  compact
                  accessibilityState={{ expanded: showCodes }}
                  disabled={locked}
                  onPress={() => setShowCodes((value) => !value)}
                />
              )}
              {(wide || showCodes) && (
                <>
                  <Text style={typography.label}>Position codes</Text>
                  <Text style={typography.muted}>
                    Keep the suggested roles or use an active two-letter team
                    position. GK stays in goal.
                  </Text>
                  <View style={styles.row}>
                    {preview.formation.slots
                      .filter((slot) => slot.id !== keeperSlotId)
                      .map((slot) => (
                        <View key={slot.id} style={styles.code}>
                          <Text style={typography.muted}>
                            {slot.id.replace("line-", "")}
                          </Text>
                          <TextInput
                            accessibilityLabel={`Position code ${slot.id}`}
                            value={slot.position}
                            editable={!locked}
                            maxLength={2}
                            autoCapitalize="characters"
                            autoCorrect={false}
                            onChangeText={(value) => {
                              setSlotOverrides((previous) => ({
                                ...previous,
                                [slot.id]: value.toUpperCase().trim(),
                              }));
                              setNotice(null);
                            }}
                            style={styles.input}
                          />
                        </View>
                      ))}
                  </View>
                </>
              )}
            </>
          )}
          {stale && (
            <Notice tone="warning">
              Team settings changed while this draft was open. Review them
              before saving.
              <Button
                label="Use current team version; keep draft"
                variant="secondary"
                disabled={locked}
                onPress={() => setSourceRevision(state.revision)}
              />
            </Notice>
          )}
          {(localError || error) && (
            <Notice tone="error">{localError ?? error}</Notice>
          )}
          {notice && <Notice>{notice}</Notice>}
          <Button
            label={saving ? "Saving formation…" : "Save formation"}
            testID="formation-pattern-save"
            disabled={
              locked ||
              stale ||
              !preview.formation ||
              inactive.length > 0 ||
              Boolean(roleError)
            }
            onPress={() => {
              void save();
            }}
          />
          {dirty && !switchIntent && (
            <Button
              label="Discard formation draft"
              testID="formation-draft-discard"
              variant="quiet"
              disabled={locked}
              onPress={() => {
                loadDraft(cleanDraft);
                setNotice("Unsaved formation changes discarded.");
              }}
            />
          )}
        </Card>
        <Card>
          {preview.formation ? (
            <FormationDiagram
              formation={{ ...preview.formation, version: 0 }}
            />
          ) : (
            <Text style={typography.muted}>
              The pitch appears when the formation totals {format - 1} outfield
              players.
            </Text>
          )}
        </Card>
      </WorkspaceColumns>
    </View>
  );
}

export function FormationDiagram({
  formation,
}: {
  formation: PreparationFormation;
}) {
  return (
    <View testID="formation-pattern-pitch">
      <Pitch
        lineup={[]}
        players={[]}
        positionsOnly
        formationName={`${formation.name} · ${formation.format}-a-side`}
        slots={formation.slots.map((slot) => ({
          id: slot.id,
          label: slot.label,
          name: `${slot.label}, ${slot.position}`,
          x: slot.x * 100,
          y: slot.y * 100,
        }))}
      />
    </View>
  );
}
const styles = StyleSheet.create({
  stack: { gap: 12 },
  heading: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
    alignItems: "center",
  },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  code: { width: 70, gap: 4 },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.controlBorder,
    borderRadius: 8,
    padding: 10,
    fontSize: 16,
    color: colors.ink,
    backgroundColor: colors.surface,
  },
});
