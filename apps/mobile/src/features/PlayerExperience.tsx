import { StyleSheet, Text, View } from "react-native";
import {
  positionCodes,
  type AvailabilityResponse,
  type PreparationCommand,
  type PreparationState,
} from "@longball/application/preparation";
import { Button, Card, colors, Notice, Pill } from "../ui";
import { randomUUID } from "../platform/id";

export function PlayerExperience({
  state,
  playerId,
  view,
  onChange,
  onReports,
  onAwards,
  busy,
}: {
  state: PreparationState;
  playerId: string;
  view: "home" | "schedule";
  onChange: (command: PreparationCommand) => Promise<boolean>;
  onReports: () => void;
  onAwards: () => void;
  busy: boolean;
}) {
  const profile = state.profiles.find(
    (item) =>
      item.playerId === playerId &&
      item.seasonId === state.activeSeasonId &&
      item.active,
  );
  if (!profile)
    return (
      <Notice>
        No active player membership is available in this season. Choose an
        authorised team context.
      </Notice>
    );
  const fixtures = state.fixtures
    .filter((item) => item.seasonId === state.activeSeasonId)
    .sort((a, b) => a.playedDate.localeCompare(b.playedDate));
  const training = state.training
    .filter((item) => item.seasonId === state.activeSeasonId)
    .sort((a, b) => a.date.localeCompare(b.date));
  const choices: [AvailabilityResponse, string][] = [
    ["available", "Available"],
    ["unavailable", "Unavailable"],
    ["unsure", "Unsure"],
  ];
  return (
    <View style={styles.stack}>
      <Text style={styles.eyebrow}>
        {profile.displayName} · {state.team.name} {state.team.ageGroup}
      </Text>
      <Text accessibilityRole="header" style={styles.title}>
        {view === "home" ? "Your football" : "Your schedule"}
      </Text>
      {view === "home" && (
        <Card>
          <Text style={styles.heading}>My game</Text>
          <Text style={styles.body}>
            Your playing time, positions and attendance stay in your own view.
            Parent use shares this player account and one ballot.
          </Text>
          <Button label="View my game and reports" onPress={onReports} />
          <Button
            label="Players’ award"
            variant="secondary"
            onPress={onAwards}
          />
        </Card>
      )}
      {fixtures.length === 0 && (
        <Notice>No fixtures have been added for this season.</Notice>
      )}
      {(view === "home" ? fixtures.slice(0, 1) : fixtures).map((fixture) => (
        <Card key={fixture.id}>
          <Pill tone={fixture.status === "scheduled" ? "brand" : "warning"}>
            {fixture.status}
          </Pill>
          <Text style={styles.heading}>
            {state.team.name} vs {fixture.opponent}
          </Text>
          <Text style={styles.body}>
            {fixture.playedDate} · {fixture.kickoff ?? "Time not recorded"} ·{" "}
            {fixture.homeAway}
          </Text>
          <Text style={styles.body}>
            {fixture.venue || "Venue not recorded"}
          </Text>
          <Text style={styles.body}>
            Your response:{" "}
            {(fixture.responses[profile.id] ?? "no_reply").replaceAll("_", " ")}
          </Text>
          {fixture.status === "scheduled" && (
            <View style={styles.stack}>
              {choices.map(([response, label]) => (
                <Button
                  key={response}
                  label={label}
                  variant={
                    fixture.responses[profile.id] === response
                      ? "primary"
                      : "secondary"
                  }
                  disabled={busy}
                  onPress={() => {
                    void onChange({
                      type: "fixture.response_recorded",
                      id: randomUUID(),
                      expectedRevision: state.revision,
                      fixtureId: fixture.id,
                      profileId: profile.id,
                      response,
                    });
                  }}
                />
              ))}
            </View>
          )}
          <Text style={styles.muted}>
            A reply does not mark attendance or start your playing time.
          </Text>
        </Card>
      ))}
      {view === "schedule" &&
        training.map((session) => (
          <Card key={session.id}>
            <Pill tone={session.status === "cancelled" ? "warning" : "brand"}>
              Training · {session.status}
            </Pill>
            <Text style={styles.heading}>
              {session.date} · {session.time}
            </Text>
            <Text style={styles.body}>{session.venue}</Text>
            <Text style={styles.body}>
              Your attendance:{" "}
              {(session.attendance[profile.id] ?? "not_recorded").replaceAll(
                "_",
                " ",
              )}
            </Text>
            <Text style={styles.body}>
              Your response:{" "}
              {(session.responses[profile.id] ?? "no_reply").replaceAll(
                "_",
                " ",
              )}
            </Text>
            {session.status === "scheduled" &&
              choices.map(([response, label]) => (
                <Button
                  key={response}
                  label={`Training: ${label}`}
                  variant={
                    session.responses[profile.id] === response
                      ? "primary"
                      : "secondary"
                  }
                  disabled={busy}
                  onPress={() => {
                    void onChange({
                      type: "training.response_recorded",
                      id: randomUUID(),
                      expectedRevision: state.revision,
                      trainingId: session.id,
                      profileId: profile.id,
                      response,
                    });
                  }}
                />
              ))}
          </Card>
        ))}
    </View>
  );
}
const styles = StyleSheet.create({
  stack: { gap: 12 },
  eyebrow: {
    color: colors.brand,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: "700",
  },
  title: { color: colors.ink, fontSize: 30, lineHeight: 37, fontWeight: "700" },
  heading: {
    color: colors.ink,
    fontSize: 20,
    lineHeight: 27,
    fontWeight: "700",
  },
  body: { color: colors.ink, fontSize: 15, lineHeight: 22 },
  muted: { color: colors.inkMuted, fontSize: 13, lineHeight: 20 },
});

export function OwnProfile({
  state,
  playerId,
  onChange,
  busy,
}: {
  state: PreparationState;
  playerId: string;
  onChange: (command: PreparationCommand) => Promise<boolean>;
  busy: boolean;
}) {
  const profile = state.profiles.find(
    (item) =>
      item.playerId === playerId &&
      item.seasonId === state.activeSeasonId &&
      item.active,
  );
  if (!profile)
    return <Notice>No own player profile is available for this season.</Notice>;
  return (
    <View style={styles.stack}>
      <Text accessibilityRole="header" style={styles.title}>
        My profile
      </Text>
      <Card>
        <Text style={styles.heading}>{profile.displayName}</Text>
        <Text style={styles.body}>
          {state.team.name} {state.team.ageGroup} ·{" "}
          {
            state.seasons.find((season) => season.id === state.activeSeasonId)
              ?.label
          }
        </Text>
        <Notice>
          Preferences affect future preparation. A saved or running match keeps
          its original profile snapshot. Your manager controls position
          eligibility.
        </Notice>
        {profile.preferences.map((position, rank) => (
          <View key={rank} style={styles.stack}>
            <Text style={styles.heading}>
              Choice {rank + 1} · {position}
            </Text>
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              {positionCodes.map((value) => (
                <Button
                  key={value}
                  label={value}
                  disabled={busy}
                  variant={position === value ? "primary" : "secondary"}
                  onPress={() => {
                    const preferences = [...profile.preferences];
                    const other = preferences.indexOf(value);
                    if (other >= 0) preferences[other] = position;
                    preferences[rank] = value;
                    void onChange({
                      type: "profile.saved",
                      id: randomUUID(),
                      expectedRevision: state.revision,
                      profile: { ...profile, preferences },
                    });
                  }}
                />
              ))}
            </View>
          </View>
        ))}
        <Text style={styles.heading}>Preferred foot</Text>
        {(["left", "right", "both", "not_recorded"] as const).map((foot) => (
          <Button
            key={foot}
            label={foot.replaceAll("_", " ")}
            disabled={busy}
            variant={profile.foot === foot ? "primary" : "secondary"}
            onPress={() => {
              void onChange({
                type: "profile.saved",
                id: randomUUID(),
                expectedRevision: state.revision,
                profile: { ...profile, foot },
              });
            }}
          />
        ))}
      </Card>
    </View>
  );
}
