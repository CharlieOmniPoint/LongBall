import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import type {
  ScheduledGameCommand,
  ScheduledGameManagementDto,
} from "@longball/application/fixture-management";
import { randomUUID } from "../platform/id";
import { useDraftSignal } from "../platform/use-unsaved-draft";
import { Button, Card, Notice, Pill, colors, typography } from "../ui";
import { formatUkDate } from "@longball/application/uk-display";
import { useWorkspaceLayout } from "../ui/WorkspaceLayout";

export function ScheduledGameManagement({
  value,
  busy = false,
  onCommand,
  fixtureId,
  onDraftChange,
}: {
  value: ScheduledGameManagementDto;
  busy?: boolean;
  fixtureId?: string;
  onCommand: (command: ScheduledGameCommand) => Promise<boolean>;
  onDraftChange?: (dirty: boolean) => void;
}) {
  const { wide } = useWorkspaceLayout();
  const [availableWidth, setAvailableWidth] = useState(0);
  const [review, setReview] = useState<{
    command: ScheduledGameCommand;
    opponent: string;
    sealed: boolean;
  } | null>(null);
  const [saving, setSaving] = useState(false),
    [error, setError] = useState<string | null>(null);
  const disabled = busy || saving;
  const dirty = review !== null && review.command.reason.length > 0;
  useDraftSignal(dirty, onDraftChange);
  const fixtures = value.fixtures.filter(
    (item) => !fixtureId || item.id === fixtureId,
  );
  const columns =
    wide && !fixtureId && availableWidth >= 640
      ? availableWidth >= 1100
        ? 3
        : 2
      : 1;
  const cardWidth =
    columns > 1 ? (availableWidth - (columns - 1) * 16) / columns : undefined;
  const start = (id: string, type: ScheduledGameCommand["type"]) => {
    const fixture = fixtures.find((item) => item.id === id);
    if (!fixture) return;
    setError(null);
    setReview({
      opponent: fixture.opponent,
      sealed: false,
      command: {
        id: randomUUID(),
        expectedRevision: value.revision,
        fixtureId: id,
        type,
        reason: "",
        confirm: true,
      },
    });
  };
  const stale =
    review !== null && review.command.expectedRevision !== value.revision;
  return (
    <View
      style={{ gap: 12 }}
      testID="scheduled-game-management"
      onLayout={(event) => {
        const width = event.nativeEvent.layout.width;
        if (width > 0)
          setAvailableWidth((previous) =>
            Math.abs(previous - width) > 1 ? width : previous,
          );
      }}
    >
      {!fixtureId && (
        <Text accessibilityRole="header" style={typography.section}>
          Scheduled games
        </Text>
      )}
      {fixtures.length === 0 && (
        <Notice>
          No schedule items are available in this current team and season.
        </Notice>
      )}
      <View
        style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}
        testID="scheduled-games-grid"
      >
        {fixtures.map((fixture) => (
          <Card
            key={fixture.id}
            style={{ width: cardWidth ?? "100%", minWidth: 0 }}
          >
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <Text style={typography.body}>
                {fixture.opponent} · {formatUkDate(fixture.playedDate)}
              </Text>
              <Pill>
                {fixture.status === "cancelled"
                  ? "Cancelled"
                  : fixture.status === "postponed"
                    ? "Postponed"
                    : "Scheduled"}
              </Pill>
            </View>
            {!fixtureId && (
              <Text style={typography.muted}>
                {fixture.kickoff ?? "Time to confirm"} ·{" "}
                {fixture.venue || "Venue to confirm"}
              </Text>
            )}
            {fixture.blockedReason && (
              <Notice>
                This game has recording authority or saved match history. It
                cannot be cancelled or deleted here.
              </Notice>
            )}
            {!fixture.blockedReason && (
              <View style={{ flexDirection: "row", gap: 8 }}>
                {fixture.canCancel && (
                  <Button
                    label="Cancel game"
                    style={{ flex: 1, minHeight: 44, paddingHorizontal: 8 }}
                    variant="secondary"
                    testID={`scheduled-game-cancel-${fixture.id}`}
                    disabled={disabled || review !== null}
                    onPress={() => start(fixture.id, "fixture.cancelled")}
                  />
                )}
                {fixture.canDelete && (
                  <Button
                    label="Delete item"
                    style={{ flex: 1, minHeight: 44, paddingHorizontal: 8 }}
                    variant="quiet"
                    testID={`scheduled-game-delete-${fixture.id}`}
                    disabled={disabled || review !== null}
                    onPress={() => start(fixture.id, "fixture.deleted")}
                  />
                )}
              </View>
            )}
          </Card>
        ))}
      </View>
      {review && (
        <View testID="scheduled-game-review">
          <Card>
            <Text style={typography.section}>
              {review.command.type === "fixture.cancelled"
                ? "Cancel"
                : "Delete"}{" "}
              {review.opponent}?
            </Text>
            <Notice tone="warning">
              {review.command.type === "fixture.cancelled"
                ? "The game will stay in Schedule marked Cancelled. Its replies and previous records remain retained."
                : "This unplayed game will be removed from Schedule. Its audit remains retained. Recorded games cannot be deleted here."}
            </Notice>
            <Text style={typography.label}>Reason for this decision</Text>
            <TextInput
              accessibilityLabel="Reason for scheduled-game decision"
              testID="scheduled-game-reason"
              value={review.command.reason}
              multiline
              editable={!disabled && !review.sealed}
              maxLength={500}
              onChangeText={(reason) =>
                setReview((current) =>
                  current
                    ? { ...current, command: { ...current.command, reason } }
                    : null,
                )
              }
              style={{
                minHeight: 88,
                padding: 12,
                borderWidth: 1,
                borderColor: colors.controlBorder,
                borderRadius: 10,
                color: colors.ink,
                fontSize: 16,
              }}
            />
            {stale && (
              <Notice tone="warning">
                The saved schedule changed while this review was open. Close
                this review, refresh, and review the current game before
                deciding.
              </Notice>
            )}
            {error && <Notice tone="warning">{error}</Notice>}
            <Button
              label={
                review.command.type === "fixture.cancelled"
                  ? "Confirm cancellation"
                  : "Confirm deletion from Schedule"
              }
              testID="scheduled-game-confirm"
              disabled={
                disabled ||
                stale ||
                review.sealed ||
                review.command.reason.trim().length < 5
              }
              onPress={() => {
                const command = {
                  ...review.command,
                  reason: review.command.reason.trim(),
                };
                setReview((current) =>
                  current ? { ...current, sealed: true, command } : null,
                );
                setSaving(true);
                setError(null);
                void onCommand(command)
                  .then((saved) => {
                    if (saved) setReview(null);
                    else
                      setError(
                        "This decision was not confirmed. Check the service message before preparing another decision.",
                      );
                  })
                  .catch(() =>
                    setError(
                      "This decision could not be confirmed. Its reviewed request must be checked before another change.",
                    ),
                  )
                  .finally(() => setSaving(false));
              }}
            />
            <Button
              label={
                review.sealed
                  ? "Close reviewed decision"
                  : dirty
                    ? "Discard reason and close review"
                    : "Close review"
              }
              variant="quiet"
              testID="scheduled-game-close-review"
              disabled={disabled}
              onPress={() => {
                setReview(null);
                setError(null);
              }}
            />
          </Card>
        </View>
      )}
    </View>
  );
}
