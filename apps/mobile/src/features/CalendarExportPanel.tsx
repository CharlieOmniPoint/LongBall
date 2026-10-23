import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  calendarEventKey,
  type CalendarEvent,
} from "@longball/application/calendar-export";
import { Button, Card, Notice } from "../ui";
import { colors, typography } from "../ui/tokens";

export function CalendarExportPanel({
  events,
  busy = false,
  onExport,
}: {
  events: CalendarEvent[];
  busy?: boolean;
  onExport: (selectedKeys: string[]) => Promise<string>;
}) {
  const [open, setOpen] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [saving, setSaving] = useState(false),
    [status, setStatus] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null);
  const current = selected.filter((key) =>
    events.some((event) => calendarEventKey(event) === key),
  );
  return (
    <Card>
      <Text style={typography.section}>Calendar copy</Text>
      {!open ? (
        <Button
          label="Export selected events"
          testID="calendar-export-open"
          variant="secondary"
          disabled={busy}
          onPress={() => setOpen(true)}
        />
      ) : (
        <View style={styles.stack}>
          <Text style={typography.body}>
            Select upcoming matches or training to save as an ICS file. Only
            date, recorded time and venue are included. Missing times stay
            date-only; end times are not invented.
          </Text>
          <Notice>
            The copy is outside LongBall and will not update automatically.
            Rescheduling or cancelling an event later does not change a file you
            already saved. This does not write to an external calendar.
          </Notice>
          {events.length === 0 && (
            <Text style={typography.muted}>
              No upcoming scheduled events are available in this account’s
              current view.
            </Text>
          )}
          {events.map((event) => {
            const key = calendarEventKey(event),
              checked = current.includes(key);
            return (
              <Pressable
                key={key}
                accessibilityRole="checkbox"
                accessibilityState={{ checked, disabled: busy || saving }}
                aria-checked={checked}
                aria-disabled={busy || saving}
                accessibilityLabel={`${event.kind === "match" ? "Match" : "Training"}, ${event.date}, ${event.time ?? "time not recorded"}`}
                testID={`calendar-event-${key}`}
                disabled={busy || saving}
                style={[styles.choice, checked && styles.selected]}
                onPress={() =>
                  setSelected((previous) =>
                    previous.includes(key)
                      ? previous.filter((item) => item !== key)
                      : [...previous, key],
                  )
                }
              >
                <Text style={typography.label}>
                  {checked ? "✓ " : "○ "}
                  {event.kind === "match" ? "Match" : "Training"} · {event.date}
                </Text>
                <Text style={typography.body}>
                  {event.time
                    ? `${event.time} · Europe/London`
                    : "Time not recorded · date-only"}
                </Text>
                {!!event.venue && (
                  <Text style={typography.muted}>{event.venue}</Text>
                )}
              </Pressable>
            );
          })}
          {current.length > 200 && (
            <Notice tone="warning">
              Select at most 200 events per calendar file.
            </Notice>
          )}
          <Button
            label={`Download or share ${current.length} selected events`}
            testID="calendar-export-confirm"
            disabled={
              busy || saving || current.length === 0 || current.length > 200
            }
            onPress={() => {
              setSaving(true);
              setError(null);
              setStatus(null);
              void onExport(current)
                .then(setStatus)
                .catch((cause) =>
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "The calendar could not be exported.",
                  ),
                )
                .finally(() => setSaving(false));
            }}
          />
          <Button
            label="Close calendar selection"
            variant="quiet"
            disabled={saving}
            onPress={() => {
              setOpen(false);
              setSelected([]);
              setError(null);
            }}
          />
        </View>
      )}
      {status && <Notice>{status}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
    </Card>
  );
}
const styles = StyleSheet.create({
  stack: { gap: 12 },
  choice: {
    minHeight: 56,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 12,
    gap: 5,
  },
  selected: { borderColor: colors.brand, backgroundColor: colors.canvas },
});
