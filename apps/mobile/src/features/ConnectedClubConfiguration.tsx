import { useState, type ReactNode } from "react";
import { Text, TextInput, View } from "react-native";
import type {
  PreparationCommand,
  PreparationState,
} from "@longball/application/preparation";
import { randomUUID } from "../platform/id";
import { acknowledgeConfigurationDraft, configurationDraft, configurationNeedsReview, refreshConfigurationDraft, reviewConfigurationDraft, type ConfigurationFields, type ConfigurationSection } from "../platform/configuration-draft";
import { Button, Card, colors, Notice } from "../ui";
import { typography } from "../ui/tokens";
import {
  ConnectedStaffPanel,
  type ConnectedStaffDto,
  type ConnectedStaffCommand,
} from "./ConnectedStaffPanel";

export type ConnectedConfigurationDto = Pick<
  PreparationState,
  "version" | "revision" | "club" | "team" | "activeSeasonId" | "seasons"
>;
export function ConnectedClubConfiguration({
  value,
  disabled,
  onChange,
  staff,
  onStaffChange,
  brandingPanel,
}: {
  brandingPanel?: ReactNode;
  value: ConnectedConfigurationDto;
  disabled: boolean;
  onChange: (command: PreparationCommand) => Promise<boolean>;
  staff: ConnectedStaffDto | null;
  onStaffChange: (command: ConnectedStaffCommand) => Promise<boolean>;
}) {
  const source = { revision: value.revision, clubName: value.club.name, teamName: value.team.name, ageGroup: value.team.ageGroup, places: value.team.defaultPitchPlaces, minutes: String(value.team.defaultHalfDurationMs / 60_000) };
  const [draft, setDraft] = useState(() => configurationDraft(source));
  const [acknowledged, setAcknowledged] = useState<{ section: ConfigurationSection; submitted: ConfigurationFields; sourceRevision: number } | null>(null);
  let nextDraft = JSON.stringify(draft.source) !== JSON.stringify(source) ? refreshConfigurationDraft(draft, source) : draft;
  if (acknowledged && source.revision > acknowledged.sourceRevision) {
    nextDraft = acknowledgeConfigurationDraft(nextDraft, acknowledged.section, acknowledged.submitted);
    setAcknowledged(null);
  }
  if (nextDraft !== draft) setDraft(nextDraft);
  const { clubName, teamName, ageGroup, places, minutes } = draft.fields;
  const change = <K extends keyof ConfigurationFields,>(key: K, updated: ConfigurationFields[K]) => setDraft(current => ({ ...current, fields: { ...current.fields, [key]: updated } }));
  const clubReview = configurationNeedsReview(draft, 'club'), teamReview = configurationNeedsReview(draft, 'team');
  const save = async (section: ConfigurationSection) => {
    const submitted = { ...draft.fields, clubName: clubName.trim(), teamName: teamName.trim(), ageGroup: ageGroup.trim(), minutes: String(Number(minutes)) };
    setDraft(current => ({ ...current, fields: { ...current.fields, ...(section === 'club' ? { clubName: submitted.clubName } : { teamName: submitted.teamName, ageGroup: submitted.ageGroup, places: submitted.places, minutes: submitted.minutes }) } }));
    const saved = await onChange(section === 'club' ? {
      id: randomUUID(), expectedRevision: draft.clubRevision, type: 'club.updated', name: submitted.clubName, logo: value.club.logo,
    } : {
      id: randomUUID(), expectedRevision: draft.teamRevision, type: 'team.updated', name: submitted.teamName, ageGroup: submitted.ageGroup, logo: value.team.logo, defaultPitchPlaces: places, defaultHalfDurationMs: Number(minutes) * 60_000,
    });
    if (saved) setAcknowledged({ section, submitted, sourceRevision: draft.source.revision });
  };
  const review = (section: ConfigurationSection) => <>
    <Notice tone="warning">The service configuration changed while you were editing. Your draft is retained. Compare the latest values before saving.</Notice>
    <Text style={typography.body}>{section === 'club' ? `Current club name: ${source.clubName}` : `Current team: ${source.teamName} · ${source.ageGroup} · ${source.places} a side · ${source.minutes} minutes per half`}</Text>
    <Button label={`I have reviewed the latest ${section} configuration; keep my draft`} variant="secondary" disabled={disabled} onPress={() => setDraft(current => reviewConfigurationDraft(current, section))} />
  </>;
  const input = (
    label: string,
    text: string,
    change: (text: string) => void,
  ) => (
    <View style={{ gap: 6 }}>
      <Text style={typography.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={text}
        onChangeText={change}
        editable={!disabled}
        style={{
          minHeight: 52,
          padding: 12,
          borderWidth: 1,
          borderColor: colors.controlBorder,
          borderRadius: 8,
          color: colors.ink,
          backgroundColor: colors.surface,
          fontSize: 16,
        }}
      />
    </View>
  );
  return (
    <View style={{ gap: 12 }} testID="administrator-configuration">
      {brandingPanel}
      <Card>
        <Text style={typography.section}>Club configuration</Text>
        <Notice>
          This administrator view receives club, team and season configuration
          only. Private player profiles, minutes and attendance require a
          separate manager assignment.
        </Notice>
        {input("Club name", clubName, updated => change('clubName', updated))}
        {clubReview && review('club')}
        <Button
          label="Save administrator club configuration"
          disabled={disabled || clubReview || !clubName.trim()}
          onPress={() => { void save('club'); }}
        />
      </Card>
      <Card>
        <Text style={typography.section}>Team defaults and identity</Text>
        {input("Team name", teamName, updated => change('teamName', updated))}
        {input("Age group", ageGroup, updated => change('ageGroup', updated))}
        <Text style={typography.label}>Default format</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {[5, 6, 7, 8, 9, 10, 11].map((number) => (
            <Button
              key={number}
              label={`${number} a side`}
              variant={places === number ? "primary" : "secondary"}
              disabled={disabled}
              onPress={() => change('places', number)}
            />
          ))}
        </View>
        {input("Default half duration in minutes", minutes, updated => change('minutes', updated))}
        <Text style={typography.muted}>
          These defaults apply to future fixture preparation. Existing match
          snapshots and fixture overrides stay preserved.
        </Text>
        {teamReview && review('team')}
        <Button
          label="Save administrator team configuration"
          disabled={
            disabled ||
            teamReview ||
            !teamName.trim() ||
            !ageGroup.trim() ||
            !/^\d{1,2}$/.test(minutes) ||
            Number(minutes) < 1 ||
            Number(minutes) > 90
          }
          onPress={() => { void save('team'); }}
        />
      </Card>
      {staff ? (
        <ConnectedStaffPanel
          key={`${staff.teamId}:${staff.seasonId}:${staff.revision}`}
          value={staff}
          disabled={disabled}
          onChange={onStaffChange}
        />
      ) : (
        <Notice>
          The staff roster is unavailable. Refresh this authorised administrator
          context to read the current service response.
        </Notice>
      )}
    </View>
  );
}
