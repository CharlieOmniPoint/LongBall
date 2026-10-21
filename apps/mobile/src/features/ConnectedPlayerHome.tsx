import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  selectPlayerHome,
  type PlayerHomeOwn,
  type PlayerHomeMatch,
} from "@longball/application/player-home";
import type { AvailabilityResponse } from "@longball/application/preparation";
import type { getCommunityView } from "@longball/application/community";
import { Button, Card, Notice, Pill } from "../ui";
import { colors, typography } from "../ui/tokens";

type Community = Pick<
  ReturnType<typeof getCommunityView>,
  "allowed" | "matches" | "gallery"
>;
export interface ConnectedPlayerHomeProps {
  own: PlayerHomeOwn;
  community: Community | null;
  matches: PlayerHomeMatch[];
  scope: { teamId: string; seasonId: string; playerId: string };
  nowMs: number;
  disabled: boolean;
  displayName: string;
  onOpenSchedule: () => void;
  onOpenProfile: () => void;
  onOpenGame: () => void;
  onOpenVote: () => void;
  onOpenAlbum: (matchId: string) => void;
  onReply: (
    event: { id: string; kind: "match" | "training" },
    response: AvailabilityResponse,
  ) => void;
  renderPhoto: (photo: Community["gallery"][number]) => ReactNode;
}
const responses = {
  available: "Available",
  unavailable: "Unavailable",
  unsure: "Unsure",
  no_reply: "No reply yet",
};
function dateLabel(date: string | null): string {
  return date
    ? new Intl.DateTimeFormat("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      }).format(new Date(`${date}T12:00:00Z`))
    : "Date to confirm";
}
/** UI05 consumes only the current player's authorised service views. */
export function ConnectedPlayerHome(props: ConnectedPlayerHomeProps) {
  const home = selectPlayerHome(props);
  if (!home.ownAvailable)
    return (
      <Notice>
        Your current player assignment could not be verified in this home view.
        Refresh your workspace before opening private details.
      </Notice>
    );
  const event = home.next;
  return (
    <View style={s.stack} testID="workspace-player-home">
      <View style={s.greeting}>
        <Text accessibilityRole="header" style={typography.title}>
          Your team, {props.displayName}
        </Text>
        <Button
          label="My profile"
          variant="quiet"
          icon="users"
          onPress={props.onOpenProfile}
        />
      </View>
      <Card>
        <Text accessibilityRole="header" style={typography.section}>
          {home.needsOrdering ? "Next events" : "Next up"}
        </Text>
        {event ? (
          <>
            <Pill>{event.kind === "match" ? "Match" : "Training"}</Pill>
            <Text style={typography.section}>{event.title}</Text>
            <Text style={typography.body}>
              {dateLabel(event.date)} · {event.time ?? "Time to confirm"}
            </Text>
            <Text style={typography.muted}>
              {event.venue ?? "Venue to confirm"}
            </Text>
            <Text style={typography.label}>
              Your reply: {responses[event.response]}
            </Text>
            <View style={s.responses}>
              {(["available", "unavailable", "unsure"] as const).map(
                (response) => (
                  <Button
                    key={response}
                    label={responses[response]}
                    variant={
                      event.response === response ? "primary" : "secondary"
                    }
                    disabled={props.disabled}
                    testID={`player-home-reply-${response}`}
                    onPress={() => props.onReply(event, response)}
                  />
                ),
              )}
            </View>
            <Text style={typography.muted}>
              Your reply is availability. Selection and actual attendance are
              recorded separately.
            </Text>
          </>
        ) : home.needsOrdering ? (
          <>
            <Notice>
              The recorded dates or times do not establish one next event. Check
              your schedule.
            </Notice>
            {home.nextCandidates.map((item) => (
              <Text key={`${item.kind}:${item.id}`} style={typography.body}>
                {item.title} · {dateLabel(item.date)} ·{" "}
                {item.time ?? "Time to confirm"}
              </Text>
            ))}
          </>
        ) : (
          <Text style={typography.body}>
            No upcoming dated match or training is recorded.
          </Text>
        )}
        {home.undated.length > 0 && (
          <Text style={typography.muted}>
            {home.undated.length} event(s) have a date to confirm.
          </Text>
        )}
        <Button
          label="Open my schedule"
          icon="calendar"
          variant="quiet"
          testID="player-home-schedule"
          onPress={props.onOpenSchedule}
        />
      </Card>
      <Card>
        <Text accessibilityRole="header" style={typography.section}>
          My game
        </Text>
        {home.liveMatch ? (
          <>
            <Text style={s.score}>
              {home.liveMatch.score!.for}–{home.liveMatch.score!.against}
            </Text>
            <Text style={typography.body}>
              {home.liveMatch.opponent ?? "Current team match"} ·{" "}
              {home.liveMatch.status?.replaceAll("_", " ")}
            </Text>
            <Text style={typography.muted}>
              Last accepted update. The recording phone may have newer events.
            </Text>
          </>
        ) : home.multipleActiveMatches ? (
          <Text style={typography.muted}>
            More than one accepted game is in progress. Choose the correct match
            in My game.
          </Text>
        ) : (
          <Text style={typography.muted}>
            Open My game for the current updates your team has shared.
          </Text>
        )}
        <Button
          label="Open my game"
          icon="ball"
          variant="secondary"
          testID="player-home-game"
          onPress={props.onOpenGame}
        />
      </Card>
      {home.vote && (
        <Card>
          <Text accessibilityRole="header" style={typography.section}>
            Player of the match
          </Text>
          <Text style={typography.body}>
            Your private choice is available for {home.vote.label}.
          </Text>
          <Button
            label={
              home.vote.ownChoice
                ? "Review my choice"
                : "Choose player of the match"
            }
            icon="trophy"
            variant="secondary"
            testID="player-home-vote"
            onPress={props.onOpenVote}
          />
          <Text style={typography.muted}>
            Review and confirm on the next screen. Your vote counts only after
            the service accepts it before the cutoff.
          </Text>
        </Card>
      )}
      <Card>
        <Text accessibilityRole="header" style={typography.section}>
          Team photos
        </Text>
        {home.latestPhoto ? (
          <>
            <Text style={typography.label}>{home.latestPhoto.matchLabel}</Text>
            <Text style={typography.muted}>From the latest permitted game</Text>
            {props.renderPhoto(home.latestPhoto)}
            {home.latestPhoto.caption && (
              <Text style={typography.body}>{home.latestPhoto.caption}</Text>
            )}
            <Button
              label="Open this game’s photos"
              icon="photo"
              variant="quiet"
              testID="player-home-album"
              onPress={() => props.onOpenAlbum(home.latestPhoto!.matchId)}
            />
          </>
        ) : (
          <Text style={typography.muted}>
            No published team photo is currently available to your account.
          </Text>
        )}
      </Card>
    </View>
  );
}
const s = StyleSheet.create({
  stack: { gap: 16 },
  greeting: { gap: 4 },
  responses: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  score: {
    fontSize: 32,
    lineHeight: 38,
    fontWeight: "700",
    color: colors.brand,
    fontVariant: ["tabular-nums"],
  },
});
