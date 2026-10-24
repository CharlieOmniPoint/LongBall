import { formatUkSeasonLabel } from '@longball/application/uk-display';
import { useEffect, useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import type { InviteDirectoryTeam } from "@longball/application/spectator-pin";
import {
  inviteDirectory,
  requestTeamInvite,
} from "../platform/spectator-access-client";
import { randomUUID } from "../platform/id";
import { Button, Card, Notice, colors, typography } from "../ui";

export function InvitationRequestEntry({
  apiBaseUrl,
  onBack,
}: {
  apiBaseUrl: string;
  onBack: () => void;
}) {
  const [directory, setDirectory] = useState<InviteDirectoryTeam[]>([]),
    [clubId, setClubId] = useState(""),
    [team, setTeam] = useState<InviteDirectoryTeam | null>(null),
    [clubSearch, setClubSearch] = useState(""),
    [teamSearch, setTeamSearch] = useState(""),
    [role, setRole] = useState<"player" | "spectator">("spectator"),
    [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState<string | null>(null),
    [sent, setSent] = useState(false);
  const requestId = useRef(randomUUID()),
    active = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    void inviteDirectory(apiBaseUrl, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setDirectory(value);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            "The club and team list could not be loaded. Please try again.",
          );
      })
      .finally(() => {
        if (active.current === controller) active.current = null;
      });
    return () => {
      controller.abort();
      active.current?.abort();
    };
  }, [apiBaseUrl]);
  const clubs = [
    ...new Map(
      directory.map((item) => [
        item.clubId,
        { id: item.clubId, name: item.clubName },
      ]),
    ).values(),
  ].filter((c) => c.name.toLowerCase().includes(clubSearch.toLowerCase()));
  const teams = directory.filter(
    (item) =>
      item.clubId === clubId &&
      `${item.teamName} ${item.ageGroup} ${formatUkSeasonLabel(item.seasonLabel)}`
        .toLowerCase()
        .includes(teamSearch.toLowerCase()),
  );
  const input = {
    minHeight: 46,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    ...typography.body,
  };
  const submit = async () => {
    if (!team || busy || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError(null);
    try {
      await requestTeamInvite(
        apiBaseUrl,
        {
          requestId: requestId.current,
          clubId: team.clubId,
          teamId: team.teamId,
          seasonId: team.seasonId,
          requestedRole: role,
          name,
          email,
        },
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setSent(true);
        setName("");
        setEmail("");
      }
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "The request could not be sent.",
        );
    } finally {
      if (active.current === controller) active.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <Card testID="invite-request-entry">
      <Text style={typography.section}>Request a team invitation</Text>
      {sent ? (
        <Notice>
          Your request has been sent to the team staff. They will review it and
          contact you. No account or team access has been created yet.
        </Notice>
      ) : (
        <>
          <Text style={typography.body}>
            Choose your club and team. Ask to join as a Player or Spectator.
          </Text>
          <TextInput
            accessibilityLabel="Search clubs"
            placeholder="Search clubs"
            value={clubSearch}
            onChangeText={setClubSearch}
            style={input}
          />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {clubs.slice(0, 12).map((club) => (
              <Button
                key={club.id}
                compact
                label={club.name}
                variant={clubId === club.id ? "primary" : "secondary"}
                onPress={() => {
                  setClubId(club.id);
                  setTeam(null);
                  setTeamSearch("");
                }}
              />
            ))}
          </View>
          {clubs.length > 12 && (
            <Text style={typography.muted}>
              Type more of the club name to narrow the list.
            </Text>
          )}
          {clubId && (
            <>
              <TextInput
                accessibilityLabel="Search teams or age groups"
                placeholder="Team name or age group, e.g. U10"
                value={teamSearch}
                onChangeText={setTeamSearch}
                style={input}
              />
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {teams.slice(0, 12).map((item) => (
                  <Button
                    key={`${item.teamId}:${item.seasonId}`}
                    compact
                    label={`${item.teamName} ${item.ageGroup} · ${formatUkSeasonLabel(item.seasonLabel)}`}
                    variant={
                      team?.teamId === item.teamId &&
                      team.seasonId === item.seasonId
                        ? "primary"
                        : "secondary"
                    }
                    onPress={() => setTeam(item)}
                  />
                ))}
              </View>
              {teams.length > 12 && (
                <Text style={typography.muted}>
                  Search by team name or age group to narrow the list.
                </Text>
              )}
            </>
          )}
          {loaded && !directory.length && (
            <Notice>No teams are available for invitation requests yet.</Notice>
          )}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {(["spectator", "player"] as const).map((item) => (
              <Button
                key={item}
                compact
                label={item === "player" ? "Player" : "Spectator"}
                variant={role === item ? "primary" : "secondary"}
                onPress={() => setRole(item)}
              />
            ))}
          </View>
          <TextInput
            accessibilityLabel="Name for invitation request"
            placeholder="Your name"
            maxLength={80}
            value={name}
            onChangeText={setName}
            editable={!busy}
            style={input}
          />
          <TextInput
            accessibilityLabel="Invitation request contact email"
            placeholder="Contact email"
            maxLength={254}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            editable={!busy}
            style={input}
          />
          {error && <Notice tone="warning">{error}</Notice>}
          <Button
            label={busy ? "Sending request…" : "Request invitation"}
            testID="submit-invite-request"
            disabled={busy || !team || name.trim().length < 2 || !email.trim()}
            onPress={() => {
              void submit();
            }}
          />
        </>
      )}
      <Button
        label="Back to sign in"
        variant="quiet"
        disabled={busy}
        onPress={onBack}
      />
    </Card>
  );
}
