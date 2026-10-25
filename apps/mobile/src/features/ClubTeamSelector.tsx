import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import type {
  WorkspaceContextChoice,
  WorkspaceContextSelection,
} from "@longball/application/workspace-context";
import { workspaceContextKey } from "@longball/application/workspace-context";
import type { Principal } from "@longball/application/access";
import { formatUkSeasonLabel } from "@longball/application/uk-display";
import { Button, Card, typography, colors } from "../ui";
import { accountRoleLabel } from "../ui/RoleTheme";

/** Filters display choices only. Each selection is still checked against fresh server membership. */
export function ClubTeamSelector({
  choices,
  selected,
  principal,
  disabled,
  onSelect,
}: {
  choices: WorkspaceContextChoice[];
  selected: WorkspaceContextSelection | null;
  principal: Principal;
  disabled: boolean;
  onSelect: (choice: WorkspaceContextChoice) => void;
}) {
  const [club, setClub] = useState("");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(20);
  const clubs = [
    ...new Set(choices.map((choice) => choice.clubLabel ?? "My club")),
  ];
  const search = query.trim().toLocaleLowerCase("en-GB");
  const filtered = choices.filter(
    (choice) =>
      (!club || (choice.clubLabel ?? "My club") === club) &&
      (!search ||
        `${choice.teamLabel} ${choice.clubLabel ?? ""} ${choice.seasonLabel} ${choice.roleLabel}`
          .toLocaleLowerCase("en-GB")
          .includes(search)),
  );
  return (
    <View style={{ gap: 12 }} testID="workspace-context-choices">
      <Text accessibilityRole="header" style={typography.section}>
        Choose club and team
      </Text>
      <Text style={typography.muted}>
        Choose the team and access you want to use. Your last valid choice is
        remembered on this device.
      </Text>
      {(clubs.length > 1 || choices.length > 6) && (
        <>
          <TextInput
            accessibilityLabel="Find club, team or age group"
            testID="workspace-team-search"
            placeholder="Find team or age group, e.g. U10"
            value={query}
            onChangeText={(value) => {
              setQuery(value);
              setLimit(20);
            }}
            editable={!disabled}
            style={{
              minHeight: 48,
              borderWidth: 1,
              borderColor: colors.controlBorder,
              borderRadius: 8,
              padding: 12,
              fontSize: 16,
              color: colors.ink,
              backgroundColor: colors.surface,
            }}
          />
          {clubs.length > 1 && (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {["", ...clubs].map((name) => (
                <Button
                  key={name}
                  label={name || "All clubs"}
                  compact
                  variant={club === name ? "primary" : "secondary"}
                  disabled={disabled}
                  onPress={() => {
                    setClub(name);
                    setLimit(20);
                  }}
                />
              ))}
            </View>
          )}
        </>
      )}
      {filtered.slice(0, limit).map((choice) => (
        <Card key={workspaceContextKey(choice)}>
          <Text style={typography.label}>
            {choice.clubLabel ?? "My club"} · {choice.teamLabel}
          </Text>
          <Text style={typography.muted}>
            {formatUkSeasonLabel(choice.seasonLabel)} ·{" "}
            {accountRoleLabel(principal, choice.role)}
          </Text>
          <Button
            label={`Open ${accountRoleLabel(principal, choice.role)} · ${choice.teamLabel} · ${formatUkSeasonLabel(choice.seasonLabel)}`}
            testID={`workspace-context-${choice.role}-${choice.teamId}-${choice.seasonId}-${choice.playerId ?? "none"}`}
            compact
            disabled={disabled}
            variant={
              selected &&
              workspaceContextKey(selected) === workspaceContextKey(choice)
                ? "secondary"
                : "primary"
            }
            onPress={() => onSelect(choice)}
          />
        </Card>
      ))}
      {filtered.length === 0 && (
        <Text style={typography.muted}>
          No invited teams match this search.
        </Text>
      )}
      {filtered.length > limit && (
        <Button
          label={`Show more teams (${filtered.length - limit} remaining)`}
          compact
          variant="secondary"
          disabled={disabled}
          onPress={() => setLimit((value) => value + 20)}
        />
      )}
    </View>
  );
}
