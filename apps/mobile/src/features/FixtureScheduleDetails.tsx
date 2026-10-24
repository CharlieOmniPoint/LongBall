import { Text, View } from "react-native";
import {
  playerFixtureDetailLabels,
  type PlayerFixtureDetails,
} from "@longball/application/player-preparation";
import { typography } from "../ui/tokens";
/** Shared UI07 recorded fixture details, for the authorised player view and fictional review. */
export function FixtureScheduleDetails({
  fixture,
}: {
  fixture: Partial<PlayerFixtureDetails>;
}) {
  const labels = playerFixtureDetailLabels(fixture);
  return (
    <View style={{ gap: 4 }} testID="player-fixture-schedule-details">
      <Text style={typography.body}>
        {labels.arrival} · {labels.kickoff}
      </Text>
      <Text style={typography.body}>
        {labels.format} · {labels.duration}
      </Text>
    </View>
  );
}
