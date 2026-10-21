import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import type { acceptedMatchView } from "@longball/application/accepted-match-view";
import { Button, Card, Notice, Pill } from "../ui";
import { Pitch } from "../ui/Pitch";
import { colors, typography } from "../ui/tokens";

type AcceptedView = ReturnType<typeof acceptedMatchView>;
const duration = (ms: number) => {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
};
const statusLabels = {
  preparation: "Before kick-off",
  first_half_running: "First half",
  first_half_paused: "First half · paused",
  half_time: "Half-time",
  second_half_running: "Second half",
  second_half_paused: "Second half · paused",
  completed: "Full-time",
  abandoned: "Abandoned",
} as const;

/** Displays no capability or match-edit action; addressed acceptance uses the authenticated parent operation. */
export function AcceptedMatchView({
  view,
  accountId,
  deviceId,
  busy,
  pending,
  onRefresh,
  onOpenDetails,
  onAccept,
}: {
  view: AcceptedView;
  accountId: string;
  deviceId: string;
  busy: boolean;
  pending: boolean;
  onRefresh: () => void;
  onOpenDetails: () => void;
  onAccept: (transferId: string) => void;
}) {
  const [requestOpen, setRequestOpen] = useState(false),
    [reference, setReference] = useState("");
  const match = view?.match;
  const slots = match
    ? (
        match.config.slots ??
        Array.from({ length: match.config.pitchPlaces }, (_, index) => ({
          slotId: view!.lineup[index]?.slotId ?? `accepted-place-${index + 1}`,
          position: view!.lineup[index]?.position ?? `Place ${index + 1}`,
          label: undefined,
          x: undefined,
          y: undefined,
        }))
      ).map((slot, index) => ({
        id: slot.slotId,
        label: slot.label ?? slot.position,
        name: `${slot.label ?? slot.position} · place ${index + 1}`,
        x: (slot.x ?? ((index % 3) + 1) / 4) * 100,
        y: Math.min(
          82,
          Math.max(
            5,
            (slot.y ??
              (index === 0 ? 0.9 : 0.75 - Math.floor((index - 1) / 3) * 0.2)) *
              90,
          ),
        ),
      }))
    : [];
  return (
    <View style={styles.stack} testID="accepted-match-view">
      <Card>
        <Pill tone="info">Viewing · accepted match</Pill>
        <Text style={typography.section}>
          {match?.config.fixture?.teamName ?? "Team match"}
          {match?.config.fixture?.opponent
            ? ` v ${match.config.fixture.opponent}`
            : ""}
        </Text>
        {view ? (
          <>
            <Text style={typography.score} testID="accepted-match-score">
              {match!.score.for}–{match!.score.against}
            </Text>
            <Text style={typography.label}>
              {statusLabels[match!.status]} · accepted revision{" "}
              {match!.revision}
            </Text>
            <View style={styles.clock}>
              <Text style={typography.muted}>Saved half clock</Text>
              <Text style={typography.clock} testID="accepted-half-clock">
                {duration(view.halfActiveMs)}
              </Text>
              <Text style={typography.muted}>
                Remaining at this checkpoint: {duration(view.remainingMs)}
              </Text>
            </View>
            <Notice>
              This is the last accepted checkpoint. The recorder’s clock is not
              advanced on this phone. Refresh to read newly accepted changes.
            </Notice>
            <Text style={typography.muted} testID="accepted-match-freshness">
              {view.downloadedAt
                ? `Snapshot downloaded ${new Date(view.downloadedAt).toLocaleString("en-GB", { timeZone: "Europe/London" })} · Europe/London${view.downloadAgeMs === null ? "" : ` · ${Math.floor(view.downloadAgeMs / 1000)}s ago`}.`
                : "Download time not recorded."}{" "}
              This can lag behind the recorder.
            </Text>
            <Text style={typography.muted}>
              {view.recorder
                ? `Recorder at last refresh: ${view.recorder.accountId} · ${view.recorder.deviceId}${view.recorder.frozen ? " · handover pending" : ""}.`
                : "No current recorder was reported in this saved snapshot."}{" "}
              Display details do not grant control.
            </Text>
          </>
        ) : (
          <Notice>
            The current accepted checkpoint needs a refresh. Local candidates
            and retained requests are preserved separately.
          </Notice>
        )}
        <Button
          label="Refresh accepted match"
          testID="accepted-match-refresh"
          variant="secondary"
          disabled={busy || pending}
          onPress={onRefresh}
        />
        <Button
          label="Request handover"
          testID="accepted-request-handover"
          variant="secondary"
          disabled={busy}
          onPress={() => setRequestOpen((value) => !value)}
        />
        {requestOpen && (
          <View style={styles.stack} testID="accepted-handover-request">
            <Text style={typography.section}>Ask the current recorder</Text>
            <Text style={typography.body}>
              Give the current recorder these details so they can offer control
              to this exact manager account and phone. Opening this panel sends
              no message or notification.
            </Text>
            <Text
              selectable
              style={typography.label}
              testID="accepted-handover-account"
            >
              Manager account: {accountId}
            </Text>
            <Text
              selectable
              style={typography.label}
              testID="accepted-handover-device"
            >
              This phone: {deviceId}
            </Text>
            <Notice>
              Ordinary handover is available before kick-off, at half-time, or
              while the referee clock is already genuinely paused. Running
              transfer needs verified cross-device clock support. Keep following
              the actual referee clock.
            </Notice>
            <TextInput
              accessibilityLabel="Addressed handover reference"
              testID="accepted-handover-reference"
              value={reference}
              onChangeText={setReference}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
              placeholder="Reference supplied by the current recorder"
            />
            <Button
              label="Accept addressed handover"
              testID="accepted-handover-accept"
              disabled={
                busy ||
                pending ||
                reference.length > 150 ||
                !/^[A-Za-z0-9_-]+$/.test(reference)
              }
              onPress={() => onAccept(reference)}
            />
            <Text style={typography.muted}>
              Only an offer addressed to this authenticated account and device
              can succeed. Acceptance and its latest checkpoint must be
              confirmed by the service before recording is available.
            </Text>
            <Button
              label="Open handover and recovery actions"
              testID="accepted-handover-details"
              variant="quiet"
              onPress={onOpenDetails}
            />
            <Button
              label="Close handover request details"
              variant="quiet"
              disabled={busy}
              onPress={() => setRequestOpen(false)}
            />
          </View>
        )}
      </Card>
      {view && (
        <>
          <Card>
            <Text style={typography.section}>
              {view.preparation ? "Accepted prepared lineup" : "Accepted pitch"}
            </Text>
            <Pitch
              lineup={view.lineup}
              players={match!.config.players}
              slots={slots}
              formationName="Saved match positions"
              compact
            />
            <View style={styles.stack} testID="accepted-position-list">
              {slots.map((slot) => {
                const allocation = view.lineup.find(
                    (item) => item.slotId === slot.id,
                  ),
                  player = match!.config.players.find(
                    (item) => item.id === allocation?.playerId,
                  );
                return (
                  <Text key={slot.id} style={typography.body}>
                    {slot.name}: {player?.displayName ?? "Unfilled"}
                  </Text>
                );
              })}
            </View>
          </Card>
          {view.policy && (
            <Card>
              <Text style={typography.section}>
                Accepted match settings · version {view.policy.version}
              </Text>
              <Text style={typography.body}>
                Preferred minimum spell: {duration(view.policy.minimumStintMs)}{" "}
                · preferred batch: {view.policy.batchLimit}.
              </Text>
              <Text style={typography.body}>
                Half buffer: {view.policy.halfBufferFraction * 100}% · score
                lead threshold: {view.policy.scoreLeadThreshold} · return to
                normal:{" "}
                {view.policy.returnToNormalEnabled ? "enabled" : "disabled"}.
              </Text>
              <Text style={typography.muted}>
                These are saved soft preferences. Goalkeeper policy transitions
                still need approval. This viewing screen cannot change settings
                or move players.
              </Text>
            </Card>
          )}
          <Card>
            <Text style={typography.section}>
              Available bench · {view.bench.length}
            </Text>
            <View testID="accepted-bench" style={styles.stack}>
              {view.bench.length ? (
                view.bench.map((player) => (
                  <Text key={player.id} style={typography.body}>
                    {player.displayName}
                  </Text>
                ))
              ) : (
                <Text style={typography.muted}>
                  No checked-in available players are on the bench at this
                  checkpoint.
                </Text>
              )}
            </View>
            {view.unavailable.length > 0 && (
              <Text style={typography.muted}>
                Unavailable:{" "}
                {view.unavailable
                  .map((player) => player.displayName)
                  .join(", ")}
              </Text>
            )}
            {view.notCheckedIn.length > 0 && (
              <Text style={typography.muted}>
                {view.notCheckedIn.length} selected players are not checked in
                as present.
              </Text>
            )}
          </Card>
        </>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  stack: { gap: 12 },
  clock: { gap: 4, paddingVertical: 8 },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.controlBorder,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    color: colors.ink,
  },
});
