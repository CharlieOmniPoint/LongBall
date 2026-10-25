import { formatUkSeasonLabel } from "@longball/application/uk-display";
import { useEffect, useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import type {
  InviteDirectoryTeam,
  InviteRequestInput,
} from "@longball/application/spectator-pin";
import {
  inviteDirectory,
  requestTeamInvite,
} from "../platform/spectator-access-client";
import { randomUUID } from "../platform/id";
import { Button, Card, Notice, colors, typography } from "../ui";

type InvitationRequestProps = {
  apiBaseUrl: string;
  onBack: () => void;
};
export function InvitationRequestEntry(props: InvitationRequestProps) {
  return <InvitationRequestSession key={props.apiBaseUrl} {...props} />;
}
function InvitationRequestSession({
  apiBaseUrl,
  onBack,
}: InvitationRequestProps) {
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
    [loading, setLoading] = useState(true),
    [loadAttempt, setLoadAttempt] = useState(0),
    [loadError, setLoadError] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null),
    [retained, setRetained] = useState<InviteRequestInput | null>(null),
    [confirmLeaving, setConfirmLeaving] = useState(false),
    [sent, setSent] = useState(false);
  const requestId = useRef(randomUUID()),
    active = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 20_000);
    active.current = controller;
    void Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) return null;
        setLoading(true);
        setLoadError(null);
        return inviteDirectory(apiBaseUrl, controller.signal);
      })
      .then((value) => {
        if (value && !controller.signal.aborted) {
          setDirectory(value);
          setClubId((current) =>
            value.some((item) => item.clubId === current) ? current : "",
          );
          setTeam((current) =>
            current
              ? (value.find(
                  (item) =>
                    item.clubId === current.clubId &&
                    item.teamId === current.teamId &&
                    item.seasonId === current.seasonId,
                ) ?? null)
              : null,
          );
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted || timedOut)
          setLoadError(
            timedOut
              ? "Loading clubs and teams took too long. Retry when connected."
              : "We could not load clubs and teams. Retry when connected.",
          );
      })
      .finally(() => {
        clearTimeout(deadline);
        if (active.current === controller) {
          active.current = null;
          setLoading(false);
        }
      });
    return () => {
      clearTimeout(deadline);
      controller.abort();
      active.current?.abort();
      if (active.current === controller) active.current = null;
    };
  }, [apiBaseUrl, loadAttempt]);
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
  const controlsLocked = busy || Boolean(retained);
  const submit = async () => {
    if (!team || busy || loading || loadError || active.current) return;
    if (!retained && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Enter a valid contact email before requesting an invitation.");
      return;
    }
    const submitted = retained ?? {
      requestId: requestId.current,
      clubId: team.clubId,
      teamId: team.teamId,
      seasonId: team.seasonId,
      requestedRole: role,
      name: name.trim(),
      email: email.trim(),
    };
    const controller = new AbortController();
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 20_000);
    active.current = controller;
    setRetained(submitted);
    setBusy(true);
    setError(null);
    try {
      await requestTeamInvite(apiBaseUrl, submitted, controller.signal);
      if (!controller.signal.aborted) {
        setSent(true);
        setRetained(null);
        setName("");
        setEmail("");
      }
    } catch {
      if (!controller.signal.aborted || timedOut)
        setError(
          "Your request was not confirmed. Retry the original request to check it; your details have been kept unchanged.",
        );
    } finally {
      clearTimeout(deadline);
      if (active.current === controller) active.current = null;
      if (!controller.signal.aborted || timedOut) setBusy(false);
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
          {loading && (
            <Text
              style={typography.muted}
              accessibilityLiveRegion="polite"
              testID="invite-directory-loading"
            >
              Loading clubs and teams…
            </Text>
          )}
          {loadError && <Notice tone="warning">{loadError}</Notice>}
          {loadError && (
            <View style={{ alignSelf: "flex-start" }}>
              <Button
                label="Retry clubs and teams"
                testID="invite-directory-retry"
                compact
                variant="secondary"
                disabled={loading || busy}
                onPress={() => setLoadAttempt((attempt) => attempt + 1)}
              />
            </View>
          )}
          <TextInput
            accessibilityLabel="Search clubs"
            placeholder="Search clubs"
            value={clubSearch}
            onChangeText={setClubSearch}
            editable={!controlsLocked}
            style={input}
          />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {clubs.slice(0, 12).map((club) => (
              <Button
                key={club.id}
                compact
                label={club.name}
                disabled={loading || controlsLocked || Boolean(loadError)}
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
                editable={!controlsLocked}
                style={input}
              />
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {teams.slice(0, 12).map((item) => (
                  <Button
                    key={`${item.teamId}:${item.seasonId}`}
                    compact
                    label={`${item.teamName} ${item.ageGroup} · ${formatUkSeasonLabel(item.seasonLabel)}`}
                    disabled={loading || controlsLocked || Boolean(loadError)}
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
          {loaded && !loading && !loadError && !directory.length && (
            <Notice>No teams are available for invitation requests yet.</Notice>
          )}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {(["spectator", "player"] as const).map((item) => (
              <Button
                key={item}
                compact
                label={item === "player" ? "Player" : "Spectator"}
                disabled={controlsLocked}
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
            editable={!controlsLocked}
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
            editable={!controlsLocked}
            style={input}
          />
          {error && <Notice tone="warning">{error}</Notice>}
          <Button
            label={
              busy
                ? "Sending request…"
                : retained
                  ? "Retry original request"
                  : "Request invitation"
            }
            testID="submit-invite-request"
            disabled={
              busy ||
              loading ||
              Boolean(loadError) ||
              !team ||
              name.trim().length < 2 ||
              !email.trim()
            }
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
        onPress={() => (retained ? setConfirmLeaving(true) : onBack())}
      />
      {confirmLeaving && retained && (
        <View style={{ gap: 8 }} testID="invite-request-leave-confirmation">
          <Notice tone="warning">
            The team may already have received your request. Leaving closes the
            retry details on this device; it does not withdraw the request.
          </Notice>
          <Button
            label="Stay and retry"
            compact
            variant="secondary"
            onPress={() => setConfirmLeaving(false)}
          />
          <Button
            label="Leave without confirmation"
            compact
            variant="quiet"
            testID="invite-request-leave-unconfirmed"
            onPress={onBack}
          />
        </View>
      )}
    </Card>
  );
}
