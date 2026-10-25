import { formatUkDateTime } from "@longball/application/uk-display";
import { useState } from "react";
import { Text, View } from "react-native";
import type { ReportCommunityComposition } from "@longball/application/report-community";
import { Button, Card, Notice, Pill, typography } from "../ui";

/** Only the composed, server-filtered final award and published album reference enter this view. */
export function ReportCommunityCard({
  matchId,
  value,
  onOpenAlbum,
  disabled = false,
}: {
  matchId: string;
  value?: ReportCommunityComposition | null;
  onOpenAlbum?: (matchId: string) => void;
  disabled?: boolean;
}) {
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const showDetails = detailsFor === matchId;
  const compatible =
    value &&
    (!value.award || value.award.matchId === matchId) &&
    (!value.publishedAlbum || value.publishedAlbum.matchId === matchId);
  if (!compatible || value.communityStatus === "unavailable")
    return (
      <Card>
        <Text style={typography.section}>Award and game photos</Text>
        <Notice>
          The award and photos are unavailable. Refresh this game to check
          again.
        </Notice>
      </Card>
    );
  if (value.communityStatus === "withheld")
    return (
      <Card>
        <Text style={typography.section}>Award and game photos</Text>
        <Notice>
          Awards and game photos are not shared for this competition.
        </Notice>
      </Card>
    );
  if (value.communityStatus === "not_recorded")
    return (
      <Card>
        <Text style={typography.section}>Award and game photos</Text>
        <Text style={typography.body}>
          No award or published photos are recorded for this game.
        </Text>
      </Card>
    );
  const award = value.award,
    album = value.publishedAlbum;
  return (
    <Card>
      <View style={{ gap: 10 }} testID="report-community-card">
        <Text style={typography.section}>Players’ award</Text>
        {award ? (
          <>
            <Text style={typography.body} testID="report-community-award">
              {award.result === "no_valid_votes"
                ? "No valid votes"
                : `${award.winnerLabels.length > 1 ? "Joint winners" : "Winner"}: ${award.winnerLabels.join(" · ")}`}
            </Text>
            <Pill tone={award.deadlineMissed ? "warning" : "brand"}>
              {award.deadlineMissed
                ? "Award recorded after the deadline"
                : "Final award recorded"}
            </Pill>
            <View style={{ alignSelf: "flex-start" }}>
              <Button
                compact
                variant="quiet"
                label={showDetails ? "Hide award details" : "Award details"}
                testID={`report-award-details-${matchId}`}
                accessibilityState={{ expanded: showDetails }}
                disabled={disabled}
                onPress={() => setDetailsFor(showDetails ? null : matchId)}
              />
            </View>
            {showDetails && (
              <Text style={typography.muted}>
                Finalised {formatUkDateTime(award.finalisedAtMs)} · original
                result deadline{" "}
                {formatUkDateTime(award.finalisationDeadlineAtMs)} · UK time
              </Text>
            )}
          </>
        ) : (
          <Text style={typography.body}>No final award recorded.</Text>
        )}
        <Text style={typography.section}>Game photos</Text>
        <Text style={typography.body} testID="report-community-album">
          {album && album.photoCount > 0
            ? `${album.photoCount} published ${album.photoCount === 1 ? "photo" : "photos"}.`
            : "No published photos for this game yet."}
        </Text>
        {album && album.photoCount > 0 && onOpenAlbum && (
          <Button
            compact
            label="View game photos"
            testID={`report-open-album-${matchId}`}
            variant="secondary"
            disabled={disabled}
            onPress={() => onOpenAlbum(album.matchId)}
          />
        )}
      </View>
    </Card>
  );
}
