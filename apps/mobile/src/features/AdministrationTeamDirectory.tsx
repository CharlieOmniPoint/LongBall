import { useMemo, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import type {
  ClubDirectoryClub,
  ClubDirectoryTeam,
} from "@longball/application/club-administration";
import { formatUkSeasonLabel } from "@longball/application/uk-display";
import { Button, Card, colors, typography } from "../ui";

export type AdministrationTeamOpenMode = "overview" | "manage";
export interface AdministrationTeamDirectoryProps {
  clubs: readonly ClubDirectoryClub[];
  teams: readonly ClubDirectoryTeam[];
  clubId: string;
  disabled: boolean;
  onSelectClub: (clubId: string) => void;
  onOpenTeam?: (
    team: ClubDirectoryTeam,
    mode: AdministrationTeamOpenMode,
  ) => void;
  canManageTeam?: (team: ClubDirectoryTeam) => boolean;
  onCreateTeam?: () => void;
  createTeamOpen?: boolean;
}

/** Only the already-authorised directory is searched; controls create no grants. */
export function AdministrationTeamDirectory(
  props: AdministrationTeamDirectoryProps,
) {
  return <AdministrationTeamDirectoryContent key={props.clubId} {...props} />;
}

function AdministrationTeamDirectoryContent({
  clubs,
  teams,
  clubId,
  disabled,
  onSelectClub,
  onOpenTeam,
  canManageTeam,
  onCreateTeam,
  createTeamOpen = false,
}: AdministrationTeamDirectoryProps) {
  const [clubSearch, setClubSearch] = useState("");
  const [search, setSearch] = useState("");
  const [age, setAge] = useState("All");
  const [season, setSeason] = useState("All");
  const [clubLimit, setClubLimit] = useState(12);
  const [teamLimit, setTeamLimit] = useState(20);
  const club = clubs.find((item) => item.id === clubId);
  const clubTeams = useMemo(
    () => teams.filter((team) => team.clubId === clubId),
    [teams, clubId],
  );
  const ages = [...new Set(clubTeams.map((team) => team.ageGroup))].sort(
    (a, b) => Number(a.slice(1)) - Number(b.slice(1)),
  );
  const seasons = [...new Set(clubTeams.map((team) => team.seasonLabel))].sort(
    (a, b) => b.localeCompare(a),
  );
  const matchingClubs = clubs.filter((item) =>
    item.name
      .toLocaleLowerCase("en-GB")
      .includes(clubSearch.trim().toLocaleLowerCase("en-GB")),
  );
  const matchingTeams = clubTeams
    .filter(
      (team) =>
        (age === "All" || team.ageGroup === age) &&
        (season === "All" || team.seasonLabel === season) &&
        `${team.name} ${team.ageGroup} ${team.seasonLabel} ${formatUkSeasonLabel(team.seasonLabel)} ${team.leagueName}`
          .toLocaleLowerCase("en-GB")
          .includes(search.trim().toLocaleLowerCase("en-GB")),
    )
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, "en-GB") ||
        Number(a.ageGroup.slice(1)) - Number(b.ageGroup.slice(1)) ||
        b.seasonLabel.localeCompare(a.seasonLabel),
    );
  const clearFilters = () => {
    setSearch("");
    setAge("All");
    setSeason("All");
    setTeamLimit(20);
  };
  return (
    <Card testID="administration-team-directory">
      <View style={styles.row}>
        <Text accessibilityRole="header" style={typography.section}>
          Clubs and teams
        </Text>
        {onCreateTeam && club && (
          <Button
            compact
            label={createTeamOpen ? "Hide team form" : "Add team"}
            variant="secondary"
            testID="admin-team-form-toggle"
            disabled={disabled}
            accessibilityState={{ expanded: createTeamOpen }}
            onPress={onCreateTeam}
          />
        )}
      </View>
      {clubs.length > 1 ? (
        <>
          {clubs.length > 6 && (
            <TextInput
              accessibilityLabel="Search authorised clubs"
              placeholder="Find a club"
              value={clubSearch}
              onChangeText={(value) => {
                setClubSearch(value);
                setClubLimit(12);
              }}
              editable={!disabled}
              style={styles.input}
            />
          )}
          <View style={styles.row}>
            {matchingClubs.slice(0, clubLimit).map((item) => (
              <Button
                key={item.id}
                compact
                label={item.name}
                variant={clubId === item.id ? "primary" : "secondary"}
                accessibilityState={{ selected: clubId === item.id }}
                disabled={disabled}
                onPress={() => onSelectClub(item.id)}
              />
            ))}
          </View>
          {matchingClubs.length > clubLimit && (
            <Button
              compact
              variant="quiet"
              label={`Show more clubs (${matchingClubs.length - clubLimit} remaining)`}
              disabled={disabled}
              onPress={() => setClubLimit((value) => value + 12)}
            />
          )}
          {!matchingClubs.length && (
            <Text style={typography.muted}>
              No authorised clubs match this search.
            </Text>
          )}
        </>
      ) : club ? (
        <Text style={typography.label}>{club.name}</Text>
      ) : (
        <Text style={typography.muted}>No authorised club is available.</Text>
      )}
      {club && (
        <>
          <TextInput
            accessibilityLabel="Search club teams"
            placeholder="Find a team, age group or league"
            value={search}
            onChangeText={(value) => {
              setSearch(value);
              setTeamLimit(20);
            }}
            editable={!disabled}
            style={styles.input}
          />
          {ages.length > 1 && (
            <View style={styles.row}>
              {["All", ...ages].map((value) => (
                <Button
                  compact
                  key={value}
                  label={value === "All" ? "All ages" : value}
                  testID={`admin-team-age-${value}`}
                  variant={age === value ? "primary" : "secondary"}
                  accessibilityState={{ selected: age === value }}
                  disabled={disabled}
                  onPress={() => {
                    setAge(value);
                    setTeamLimit(20);
                  }}
                />
              ))}
            </View>
          )}
          {seasons.length > 1 && (
            <View style={styles.row}>
              {["All", ...seasons].map((value) => (
                <Button
                  compact
                  key={value}
                  label={
                    value === "All" ? "All seasons" : formatUkSeasonLabel(value)
                  }
                  variant={season === value ? "primary" : "secondary"}
                  accessibilityState={{ selected: season === value }}
                  disabled={disabled}
                  onPress={() => {
                    setSeason(value);
                    setTeamLimit(20);
                  }}
                />
              ))}
            </View>
          )}
          <View style={styles.row}>
            <Text style={typography.muted}>
              {matchingTeams.length} of {clubTeams.length} team-season
              {clubTeams.length === 1 ? "" : "s"}
            </Text>
            {(search || age !== "All" || season !== "All") && (
              <Button
                compact
                variant="quiet"
                label="Clear team filters"
                disabled={disabled}
                onPress={clearFilters}
              />
            )}
          </View>
          {!matchingTeams.length && (
            <Text style={typography.body}>
              {clubTeams.length
                ? "No teams match these filters."
                : "This club has no teams yet. Add a team to get started."}
            </Text>
          )}
          {matchingTeams.slice(0, teamLimit).map((team) => (
            <View
              key={`${team.id}:${team.seasonId}`}
              style={styles.team}
              testID={`admin-directory-team-${team.id}-${team.seasonId}`}
            >
              <View style={styles.teamIdentity}>
                <Text style={typography.label}>
                  {team.name} · {team.ageGroup}
                </Text>
                <Text style={typography.muted}>
                  {formatUkSeasonLabel(team.seasonLabel)}
                  {team.leagueName ? ` · ${team.leagueName}` : ""}
                </Text>
              </View>
              {onOpenTeam && (
                <View style={styles.row}>
                  <Button
                    compact
                    label="Open team"
                    accessibilityLabel={`Open ${team.name} ${team.ageGroup}, ${formatUkSeasonLabel(team.seasonLabel)}`}
                    testID={`admin-open-team-${team.id}-${team.seasonId}`}
                    variant="secondary"
                    disabled={disabled}
                    onPress={() => onOpenTeam(team, "overview")}
                  />
                  {canManageTeam?.(team) && (
                    <Button
                      compact
                      label="Manage team"
                      accessibilityLabel={`Manage ${team.name} ${team.ageGroup}, ${formatUkSeasonLabel(team.seasonLabel)}`}
                      testID={`admin-manage-team-${team.id}-${team.seasonId}`}
                      disabled={disabled}
                      onPress={() => onOpenTeam(team, "manage")}
                    />
                  )}
                </View>
              )}
            </View>
          ))}
          {matchingTeams.length > teamLimit && (
            <Button
              compact
              variant="secondary"
              label={`Show more teams (${matchingTeams.length - teamLimit} remaining)`}
              disabled={disabled}
              onPress={() => setTeamLimit((value) => value + 20)}
            />
          )}
        </>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  team: {
    gap: 8,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  teamIdentity: { flexGrow: 1, flexBasis: 180, minWidth: 0, gap: 4 },
  input: {
    ...typography.body,
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.controlBorder,
    borderRadius: 8,
    padding: 12,
    backgroundColor: colors.surface,
  },
});
