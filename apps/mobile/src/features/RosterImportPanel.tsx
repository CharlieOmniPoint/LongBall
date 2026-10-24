import { useState } from "react";
import { StyleSheet, Switch, Text, TextInput, View } from "react-native";
import {
  previewRosterImport,
  ROSTER_CSV_TEMPLATE,
  type RosterImportPreview,
} from "@longball/application/roster-import";
import type {
  PlayerProfile,
  PreparationState,
} from "@longball/application/preparation";
import { randomUUID } from "../platform/id";
import {
  createRosterXls,
  previewRosterXls,
  rosterXlsFileName,
  ROSTER_XLS_MIME,
} from "@longball/application/roster-xls";
import { deliverTeamFile, pickTeamFile } from "../platform/team-files";
import { Button, Card, Notice, Pill } from "../ui";
import { colors, typography } from "../ui/tokens";

export function RosterImportPanel({
  state,
  busy = false,
  onImport,
  onProformaImport,
}: {
  state: PreparationState;
  busy?: boolean;
  onImport: (profiles: PlayerProfile[]) => Promise<boolean>;
  onProformaImport?: (profiles: PlayerProfile[]) => Promise<boolean>;
}) {
  const [excel, setExcel] = useState(false);
  const [open, setOpen] = useState(false),
    [csv, setCsv] = useState(""),
    [preview, setPreview] = useState<RosterImportPreview | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [saving, setSaving] = useState(false),
    [status, setStatus] = useState<string | null>(null);
  const disabled = busy || saving;
  const close = () => {
    setOpen(false);
    setExcel(false);
    setCsv("");
    setPreview(null);
    setConfirmed(false);
  };
  return (
    <Card>
      <Text style={typography.section}>Import player profiles</Text>
      <Text style={typography.muted}>
        Download the Excel proforma, fill in or update player details, then
        import it for review. Existing identities are retained. This creates no
        accounts or access.
      </Text>
      {status && <Notice>{status}</Notice>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button
          label="Download player XLS"
          testID="roster-xls-download"
          compact
          variant="secondary"
          disabled={disabled}
          onPress={() => {
            void deliverTeamFile({
              name: rosterXlsFileName(state),
              bytes: createRosterXls(state),
              mimeType: ROSTER_XLS_MIME,
            })
              .then(() =>
                setStatus(
                  "Excel proforma downloaded. Keep the identity cells for existing players; leave both blank for new players.",
                ),
              )
              .catch((error) =>
                setStatus(
                  error instanceof Error
                    ? error.message
                    : "The proforma could not be downloaded.",
                ),
              );
          }}
        />
        <Button
          label="Import player XLS"
          testID="roster-xls-import"
          compact
          variant="secondary"
          disabled={disabled}
          onPress={() => {
            setSaving(true);
            setStatus(null);
            void pickTeamFile("xls")
              .then((file) => {
                if (!file) return;
                const checked = previewRosterXls(file.bytes, state, randomUUID);
                if (
                  !onProformaImport &&
                  checked.profiles.some((profile) =>
                    state.profiles.some(
                      (existing) => existing.id === profile.id,
                    ),
                  )
                )
                  checked.errors.push(
                    "This screen cannot update existing rows. Open the connected team roster to import this proforma.",
                  );
                setExcel(true);
                setOpen(true);
                setPreview(checked);
                setConfirmed(false);
              })
              .catch((error) =>
                setStatus(
                  error instanceof Error
                    ? error.message
                    : "The Excel file could not be read.",
                ),
              )
              .finally(() => setSaving(false));
          }}
        />
      </View>
      {!open ? (
        <Button
          label="Import roster CSV"
          testID="roster-import-open"
          variant="secondary"
          disabled={disabled}
          onPress={() => {
            setStatus(null);
            setExcel(false);
            setOpen(true);
          }}
        />
      ) : (
        <View style={styles.stack}>
          {!excel && (
            <>
              <Text style={typography.body}>
                Use the template headers. Separate eligible positions with |.
                Include three distinct preferences and explicitly approved
                eligible positions; goalkeeper eligibility is never guessed. At
                most 200 rows and 65,536 characters.
              </Text>
              <Button
                label="Use demo CSV example"
                testID="roster-import-example"
                variant="quiet"
                disabled={disabled}
                onPress={() => {
                  setCsv(ROSTER_CSV_TEMPLATE);
                  setPreview(null);
                  setConfirmed(false);
                }}
              />
              <TextInput
                accessibilityLabel="Roster CSV"
                testID="roster-import-csv"
                multiline
                maxLength={65_536}
                value={csv}
                editable={!disabled}
                onChangeText={(value) => {
                  setCsv(value);
                  setPreview(null);
                  setConfirmed(false);
                }}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
                placeholder="Paste CSV including the header row"
              />
              <Button
                label="Preview roster import"
                testID="roster-import-preview"
                disabled={disabled || !csv.trim()}
                onPress={() => {
                  setPreview(previewRosterImport(csv, state, randomUUID));
                  setConfirmed(false);
                }}
              />
            </>
          )}
          {preview && (
            <View style={styles.stack} testID="roster-import-review">
              <Text style={typography.section}>
                {preview.profiles.length} valid{" "}
                {excel ? "new or updated" : "new"} player rows
              </Text>
              {preview.errors.map((error, index) => (
                <Notice key={index} tone="error">
                  {error}
                </Notice>
              ))}
              {preview.warnings.map((warning, index) => (
                <Notice key={index} tone="warning">
                  {warning}
                </Notice>
              ))}
              {preview.profiles.map((profile) => (
                <View key={profile.id} style={styles.row}>
                  <Pill>{profile.shirtNumber ?? profile.initials}</Pill>
                  <Text style={typography.label}>{profile.displayName}</Text>
                  <Text style={typography.body}>
                    {profile.preferences.join(" → ")} · foot:{" "}
                    {profile.foot.replaceAll("_", " ")}
                  </Text>
                  <Text style={typography.muted}>
                    Eligible: {profile.eligiblePositions.join(", ")}
                  </Text>
                </View>
              ))}
              {preview.revision !== state.revision && (
                <Notice tone="warning">
                  The roster changed. Preview this CSV again before importing.
                </Notice>
              )}
              <View style={styles.confirm}>
                <Switch
                  accessibilityLabel="Confirm distinct new players and eligibility"
                  value={confirmed}
                  disabled={disabled}
                  onValueChange={setConfirmed}
                />
                <Text style={[typography.body, styles.flex]}>
                  {excel
                    ? "I checked the new and updated details, identities, preferences and eligibility."
                    : "Every row represents a distinct new player. I checked the names, preferences and eligibility."}
                </Text>
              </View>
              <Button
                label="Confirm and import all players"
                testID="roster-import-confirm"
                disabled={
                  disabled ||
                  !confirmed ||
                  preview.errors.length > 0 ||
                  preview.profiles.length === 0 ||
                  preview.revision !== state.revision ||
                  preview.seasonId !== state.activeSeasonId
                }
                onPress={() => {
                  if (disabled) return;
                  setSaving(true);
                  void (
                    excel && onProformaImport
                      ? onProformaImport(preview.profiles)
                      : onImport(preview.profiles)
                  )
                    .then((saved) => {
                      if (saved) {
                        setStatus(
                          "All reviewed player rows were saved together. Match history and account access were preserved.",
                        );
                        close();
                      } else
                        setStatus(
                          "The import has not been confirmed. Review any retained request before trying again.",
                        );
                    })
                    .catch(() =>
                      setStatus(
                        "The import could not be confirmed. Your preview is retained.",
                      ),
                    )
                    .finally(() => setSaving(false));
                }}
              />
            </View>
          )}
          <Button
            label="Close roster import"
            variant="quiet"
            disabled={disabled}
            onPress={close}
          />
        </View>
      )}
    </Card>
  );
}
const styles = StyleSheet.create({
  stack: { gap: 12 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 12,
    color: colors.ink,
    fontSize: 16,
    minHeight: 160,
    textAlignVertical: "top",
  },
  row: {
    gap: 6,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 12,
  },
  confirm: { flexDirection: "row", alignItems: "center", gap: 12 },
  flex: { flex: 1 },
});
