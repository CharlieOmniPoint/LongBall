import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import type {
  LogoChoice,
  PreparationCommand,
  PreparationState,
} from "@longball/application/preparation";
import { randomUUID } from "../platform/id";
import { Button, Card, colors, Icon, Notice } from "../ui";
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
}: {
  value: ConnectedConfigurationDto;
  disabled: boolean;
  onChange: (command: PreparationCommand) => Promise<boolean>;
  staff: ConnectedStaffDto | null;
  onStaffChange: (command: ConnectedStaffCommand) => Promise<boolean>;
}) {
  const [clubName, setClubName] = useState(value.club.name),
    [teamName, setTeamName] = useState(value.team.name),
    [ageGroup, setAgeGroup] = useState(value.team.ageGroup);
  const [clubLogo, setClubLogo] = useState<LogoChoice | null>(value.club.logo),
    [teamLogo, setTeamLogo] = useState<LogoChoice | null>(value.team.logo);
  const [places, setPlaces] = useState(value.team.defaultPitchPlaces),
    [minutes, setMinutes] = useState(
      String(value.team.defaultHalfDurationMs / 60_000),
    );
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
  const logos = (
    kind: "club" | "team",
    selected: LogoChoice | null,
    change: (value: LogoChoice | null) => void,
  ) => (
    <View style={{ gap: 8 }}>
      <Text style={typography.label}>
        {kind === "team" ? "Team logo override" : "Club badge"}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {([null, "roundel", "shield", "ball"] as const).map((option) => (
          <Button
            key={option ?? "inherit"}
            label={
              option ?? (kind === "team" ? "Inherit club" : "Neutral badge")
            }
            variant={selected === option ? "primary" : "secondary"}
            disabled={disabled}
            onPress={() => change(option)}
          />
        ))}
      </View>
    </View>
  );
  return (
    <View style={{ gap: 12 }} testID="administrator-configuration">
      <Card>
        <Text style={typography.section}>Club configuration</Text>
        <Notice>
          This administrator view receives club, team and season configuration
          only. Private player profiles, minutes and attendance require a
          separate manager assignment.
        </Notice>
        {input("Club name", clubName, setClubName)}
        {logos("club", clubLogo, setClubLogo)}
        <Button
          label="Save administrator club configuration"
          disabled={disabled || !clubName.trim()}
          onPress={() => {
            void onChange({
              id: randomUUID(),
              expectedRevision: value.revision,
              type: "club.updated",
              name: clubName.trim(),
              logo: clubLogo,
            });
          }}
        />
      </Card>
      <Card>
        <Text style={typography.section}>Team defaults and identity</Text>
        <Icon
          name={(teamLogo ?? clubLogo) === "ball" ? "ball" : "shield"}
          size={36}
        />
        {input("Team name", teamName, setTeamName)}
        {input("Age group", ageGroup, setAgeGroup)}
        {logos("team", teamLogo, setTeamLogo)}
        <Text style={typography.label}>Default format</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {[5, 6, 7, 8, 9, 10, 11].map((number) => (
            <Button
              key={number}
              label={`${number} a side`}
              variant={places === number ? "primary" : "secondary"}
              disabled={disabled}
              onPress={() => setPlaces(number)}
            />
          ))}
        </View>
        {input("Default half duration in minutes", minutes, setMinutes)}
        <Text style={typography.muted}>
          These defaults apply to future fixture preparation. Existing match
          snapshots and fixture overrides stay preserved.
        </Text>
        <Button
          label="Save administrator team configuration"
          disabled={
            disabled ||
            !teamName.trim() ||
            !ageGroup.trim() ||
            !/^\d{1,2}$/.test(minutes) ||
            Number(minutes) < 1 ||
            Number(minutes) > 90
          }
          onPress={() => {
            void onChange({
              id: randomUUID(),
              expectedRevision: value.revision,
              type: "team.updated",
              name: teamName.trim(),
              ageGroup: ageGroup.trim(),
              logo: teamLogo,
              defaultPitchPlaces: places,
              defaultHalfDurationMs: Number(minutes) * 60_000,
            });
          }}
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
