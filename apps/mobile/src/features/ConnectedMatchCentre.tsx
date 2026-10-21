import { useState } from "react";
import { Text, View } from "react-native";
import type { MatchState } from "@longball/domain";
import { Button, Card, Notice, Pill } from "../ui";
import { typography } from "../ui/tokens";

export interface ConnectedMatchCentreDto {
  matchId: string;
  audience: "manager" | "player" | "spectator";
  revision: number;
  status?: string;
  score?: { for: number; against: number } | null;
  halfTimeScore?: { for: number; against: number } | null;
  sharingRestricted?: boolean;
  sharingPolicyVersion?: string;
  lastRecorderSyncAt: number | null;
  freshness?: "last_synced" | "updates_delayed";
  fixture?: { opponent?: string; playedDate?: string; homeAway?: string };
  opponent?: string;
  playedDate?: string;
  ownRecord?: {
    playerId: string;
    attendance: string;
    playingMs: number;
    intervals: {
      half: number;
      startMs: number;
      endMs: number;
      state: string;
      position?: string | null;
    }[];
    completeness: string;
  };
  state?: MatchState;
}
const time = (value: number) =>
  `${Math.floor(value / 60_000)}:${String(Math.floor((value % 60_000) / 1000)).padStart(2, "0")}`;
export function ConnectedMatchCentre({
  matches,
  observedAtMs,
  audience,
  onRefresh,
  onReports,
  onPhotos,
  busy,
}: {
  matches: ConnectedMatchCentreDto[];
  observedAtMs: number;
  audience: ConnectedMatchCentreDto["audience"];
  onRefresh: () => void;
  onReports: () => void;
  onPhotos: () => void;
  busy: boolean;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <View style={{ gap: 12 }} testID="workspace-match-centre">
      <Card>
        <Text style={typography.section}>Match centre</Text>
        <Text style={typography.body}>
          These are accepted service updates. A recorder may have newer events
          waiting on its phone.
        </Text>
        <Button
          label="Refresh accepted match updates"
          variant="secondary"
          disabled={busy}
          onPress={onRefresh}
        />
      </Card>
      {!matches.length && (
        <Notice>
          No matches are available in this authorised team and season.
        </Notice>
      )}
      {matches.map((match) => {
        const manager = audience === "manager" && match.audience === "manager";
        const score = manager
          ? (match.state?.score ?? null)
          : (match.score ?? null);
        const half = manager
          ? (match.state?.halfTimeScore ?? null)
          : (match.halfTimeScore ?? null);
        const status = manager
          ? (match.state?.status ?? "unknown")
          : (match.status ?? "unknown");
        const own =
          audience === "player" && match.audience === "player"
            ? match.ownRecord
            : undefined;
        const fresh =
          match.lastRecorderSyncAt !== null &&
          observedAtMs >= match.lastRecorderSyncAt &&
          observedAtMs - match.lastRecorderSyncAt <= 15_000;
        return (
          <Card key={match.matchId}>
            <Text style={typography.section}>
              {match.fixture?.opponent ??
                match.opponent ??
                match.state?.config.fixture?.opponent ??
                "Team match"}
            </Text>
            <Text style={typography.muted}>
              {match.fixture?.playedDate ??
                match.playedDate ??
                match.state?.config.fixture?.playedDate ??
                "Date unavailable"}{" "}
              · {status.replaceAll("_", " ")}
            </Text>
            {match.sharingRestricted && !manager ? (
              <Notice tone="warning">
                Scores and derived results are not shared for this competition.
                An invitation does not override the applicable sharing policy.
              </Notice>
            ) : (
              <>
                <Text
                  style={{
                    ...typography.section,
                    fontSize: 32,
                    lineHeight: 40,
                  }}
                >
                  {score
                    ? `${score.for} – ${score.against}`
                    : "Score not recorded"}
                </Text>
                <Text style={typography.body}>
                  Half time:{" "}
                  {half ? `${half.for} – ${half.against}` : "Not recorded"}
                </Text>
              </>
            )}
            <Pill tone={fresh ? "brand" : "warning"}>
              {fresh ? "Last accepted update" : "Updates delayed"}
            </Pill>
            <Text style={typography.muted}>
              Recorder last synchronised:{" "}
              {match.lastRecorderSyncAt === null
                ? "Not recorded"
                : new Date(match.lastRecorderSyncAt).toLocaleString("en-GB", {
                    timeZone: "Europe/London",
                  })}{" "}
              · revision {match.revision}
            </Text>
            {own && (
              <>
                <Text style={typography.label}>My recorded game</Text>
                <Text style={typography.body}>
                  Attendance: {own.attendance.replaceAll("_", " ")} · playing
                  time {time(own.playingMs)} through the last accepted boundary.
                </Text>
                <Text style={typography.muted}>
                  {own.completeness.replaceAll("_", " ")}. The service does not
                  extrapolate this phone’s live clock.
                </Text>
                <Button
                  label={
                    expanded === match.matchId
                      ? "Hide my accepted intervals"
                      : "Show my accepted intervals"
                  }
                  variant="quiet"
                  onPress={() =>
                    setExpanded((value) =>
                      value === match.matchId ? null : match.matchId,
                    )
                  }
                />
                {expanded === match.matchId &&
                  own.intervals.map((interval, index) => (
                    <Text key={index} style={typography.muted}>
                      Half {interval.half} · {time(interval.startMs)}–
                      {time(interval.endMs)} ·{" "}
                      {interval.state.replaceAll("_", " ")}
                      {interval.position ? ` · ${interval.position}` : ""}
                    </Text>
                  ))}
              </>
            )}
            <Button
              label={
                audience === "player"
                  ? "Open my reports"
                  : "Open permitted team reports"
              }
              variant="secondary"
              onPress={onReports}
            />
            <Button
              label="Open published game albums"
              variant="quiet"
              onPress={onPhotos}
            />
          </Card>
        );
      })}
      {audience === "spectator" && (
        <Notice>
          Spectator access includes permitted team updates and published photos.
          Named attendance, minutes, private submissions and ballots stay
          outside this view.
        </Notice>
      )}
    </View>
  );
}
