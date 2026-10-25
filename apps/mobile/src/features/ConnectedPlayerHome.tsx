import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  selectPlayerHome,
  type PlayerHomeOwn,
  type PlayerHomeMatch,
} from "@longball/application/player-home";
import type { AvailabilityResponse } from "@longball/application/preparation";
import type { getCommunityView } from "@longball/application/community";
import { formatUkDate, formatUkDateTime } from "@longball/application/uk-display";
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
  /** Supplied only when this player can currently leave feedback on a played game. */
  onOpenFeedback?: () => void;
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
  return formatUkDate(date);
}
/** UI05 consumes only the current player's authorised service views. */
export function ConnectedPlayerHome(props: ConnectedPlayerHomeProps) {
  const home = selectPlayerHome(props);
  if (!home.ownAvailable)
    return (
      <Notice>
        Your player access could not be confirmed. Refresh your team view.
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
          compact
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
            <Text style={typography.label} accessibilityLiveRegion="polite" testID="player-home-reply-status">
              Your reply: {responses[event.response]}
            </Text>
            <View style={s.responses}>
              {(["available", "unavailable", "unsure"] as const).map(
                (response) => (
                  <Button
                    key={response}
                    label={responses[response]}
                    compact
                    variant={
                      event.response === response ? "primary" : "secondary"
                    }
                    accessibilityState={{ selected: event.response === response }}
                    disabled={props.disabled}
                    testID={`player-home-reply-${response}`}
                    onPress={() => props.onReply(event, response)}
                  />
                ),
              )}
            </View>
            <Text style={typography.muted}>
              Your reply does not select the squad or record attendance.
            </Text>
          </>
        ) : home.needsOrdering ? (
          <>
            <Notice>
              Check your schedule: the next event’s date or time needs confirming.
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
          compact
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
            <Pill tone={home.liveMatch.lastRecorderSyncAt !== null && props.nowMs >= home.liveMatch.lastRecorderSyncAt && props.nowMs - home.liveMatch.lastRecorderSyncAt <= 15_000 ? "brand" : "warning"}>
              {home.liveMatch.lastRecorderSyncAt !== null && props.nowMs >= home.liveMatch.lastRecorderSyncAt && props.nowMs - home.liveMatch.lastRecorderSyncAt <= 15_000 ? "Latest team update" : "Updates delayed"}
            </Pill>
            <Text style={typography.muted}>
              Last shared update: {formatUkDateTime(home.liveMatch.lastRecorderSyncAt)} · UK time.
              Your manager may have newer updates.
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
          compact
          icon="ball"
          variant="secondary"
          testID="player-home-game"
          onPress={props.onOpenGame}
        />
        {props.onOpenFeedback && <View style={s.feedback}>
          <Button label="How was the game?" compact icon="ball" variant="quiet" testID="player-home-feedback" onPress={props.onOpenFeedback} />
          <Text style={typography.muted}>Rate it and add a private note for your manager.</Text>
        </View>}
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
            compact
            variant="secondary"
            testID="player-home-vote"
            onPress={props.onOpenVote}
          />
          <Text style={typography.muted}>
            Your private choice counts once saved before voting closes.
          </Text>
        </Card>
      )}
      {!home.vote && home.award && (
        <Card>
          <View style={s.stack} testID="player-home-award">
            <Text accessibilityRole="header" style={typography.section}>
              Players’ player of the match
            </Text>
            <Text style={typography.label}>{home.award.label}</Text>
            {home.award.status === "final" ? (
              <>
                <Text style={typography.body} testID="player-home-award-result">
                  {home.award.result === "no_valid_votes"
                    ? "No valid votes"
                    : `${home.award.winnerLabels.length > 1 ? "Joint winners" : "Winner"}: ${home.award.winnerLabels.join(" · ")}`}
                </Text>
                <Pill tone={home.award.deadlineMissed ? "warning" : "brand"}>
                  {home.award.deadlineMissed
                    ? "Finalised after the original deadline"
                    : "Final award recorded"}
                </Pill>
              </>
            ) : (
              <Notice tone={home.award.status === "review_required" || home.award.deadlineMissed ? "warning" : "info"}>
                {home.award.status === "review_required"
                  ? "The result needs review. Match timing or award details have not been confirmed."
                  : home.award.deadlineMissed
                    ? "Voting is closed. The result is delayed beyond its original deadline."
                    : "Voting is closed. The result is being prepared."}
              </Notice>
            )}
            {home.award.deadlineAtMs !== null && (
              <Text style={typography.muted}>
                Result due: {formatUkDateTime(home.award.deadlineAtMs)} · UK time.
              </Text>
            )}
            <Button
              label="View match award"
              compact
              variant="secondary"
              icon="trophy"
              testID="player-home-award-open"
              onPress={props.onOpenVote}
            />
          </View>
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
              compact
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
  feedback: { gap: 6, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border },
  score: {
    fontSize: 32,
    lineHeight: 38,
    fontWeight: "700",
    color: colors.brand,
    fontVariant: ["tabular-nums"],
  },
});
