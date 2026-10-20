import { useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import {
  playerMinutes,
  validateLineup,
  type Allocation,
  type Attendance,
} from "@longball/domain";
import { romaFixture } from "@longball/testing";
import { Button, Card, colors, Icon, Notice, Pill, Pitch } from "./src/ui";
import type { IconName } from "./src/ui/Icon";
import {
  formatTime,
  slots,
  suggestedStartingLineup,
  useMatch,
} from "./src/useMatch";
import {
  requestAlertPermission,
  replaceLocalWarnings,
} from "./src/platform/alerts";

type Screen =
  | "home"
  | "attendance"
  | "lineup"
  | "live"
  | "schedule"
  | "team"
  | "reports"
  | "more";
const nav: { screen: Screen; label: string; icon: IconName }[] = [
  { screen: "home", label: "Home", icon: "home" },
  { screen: "schedule", label: "Schedule", icon: "calendar" },
  { screen: "team", label: "Team", icon: "users" },
  { screen: "reports", label: "Reports", icon: "chart" },
  { screen: "more", label: "More", icon: "more" },
];
export default function App() {
  return (
    <SafeAreaProvider>
      <LongBall />
    </SafeAreaProvider>
  );
}

function LongBall() {
  const model = useMatch();
  const { state, clock, busy, send } = model;
  const [screen, setScreen] = useState<Screen>("home");
  const [slot, setSlot] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    lineup: Allocation[];
    revision: number;
  } | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [recoveryTime, setRecoveryTime] = useState("");
  const [reason, setReason] = useState("");
  const [unchanged, setUnchanged] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [probe, setProbe] = useState<string | null>(null);
  const [alertStatus, setAlertStatus] = useState<string | null>(null);
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const desktop = Platform.OS === "web" && width >= 980;
  const selected = state?.config.selectedPlayerIds ?? [];
  const present = selected.filter(
    (id) => state?.attendance[id] === "present",
  ).length;
  const started = Boolean(state && state.status !== "preparation");
  const halfTime = state?.status === "half_time";
  const completed = state?.status === "completed";
  const running = state?.status.endsWith("_running") ?? false;
  const matchMode = ["live", "lineup", "attendance"].includes(screen);
  const allocation = state
    ? halfTime || !started
      ? state.stagedLineup
      : state.lineup
    : [];
  const bench = selected.filter(
    (id) =>
      state?.attendance[id] === "present" &&
      state.availability[id] &&
      !allocation.some((item) => item.playerId === id),
  );
  const validation = state ? validateLineup(state, allocation) : [];
  const name = (id: string) =>
    romaFixture.players.find((player) => player.id === id)?.displayName ??
    "Unassigned";
  const navigate = (value: Screen) => {
    setLocalError(null);
    setScreen(value);
  };
  const prepare = () =>
    navigate(
      started
        ? halfTime
          ? "lineup"
          : "live"
        : present < 7
          ? "attendance"
          : "lineup",
    );
  const testNotification = async () => {
    try {
      const permission = await requestAlertPermission();
      await replaceLocalWarnings({
        revision: "disposable-lab-probe",
        dueInMs: 10_000,
        running: true,
      });
      setAlertStatus(
        `${permission} A synthetic reminder was requested for 10 seconds from now. No match event is changed.`,
      );
    } catch (failure) {
      setAlertStatus(
        failure instanceof Error
          ? failure.message
          : "The notification experiment failed.",
      );
    }
  };
  const checkInAll = async () => {
    if (!state || bulkBusy) return;
    setBulkBusy(true);
    for (const id of selected)
      if (
        state.attendance[id] !== "present" &&
        !(await send({
          type: "attendance.recorded",
          playerId: id,
          status: "present",
        }))
      )
        break;
    setBulkBusy(false);
  };
  const choosePlayer = async (playerId: string) => {
    if (!state || !slot) return;
    const target = slots.find((item) => item.slotId === slot)!;
    const old = allocation.find((item) => item.slotId === slot);
    const existing = allocation.find((item) => item.playerId === playerId);
    const next = allocation.filter(
      (item) => item.slotId !== slot && item.playerId !== playerId,
    );
    next.push({ ...target, playerId });
    if (existing && old && existing.slotId !== slot)
      next.push({ ...existing, playerId: old.playerId });
    setSlot(null);
    if (!started || halfTime)
      await send({ type: "lineup.staged", lineup: next });
    else setDraft({ lineup: next, revision: state.revision });
  };
  const recover = async () => {
    const value = /^(\d{1,3}):([0-5]\d)$/.exec(recoveryTime.trim());
    if (!value || !reason.trim() || !unchanged) {
      setLocalError(
        "Enter the referee’s time as MM:SS, a reason, and confirm the unchanged lineup.",
      );
      return;
    }
    if (
      await send({
        type: "clock.corrected",
        halfActiveMs: (Number(value[1]) * 60 + Number(value[2])) * 1000,
        reason: reason.trim(),
        confirmUnchangedLineup: true,
      })
    ) {
      setRecovery(false);
      setLocalError(null);
    }
  };
  const localStatus = (
    <View style={s.saveStatus}>
      <View style={s.statusDot} />
      <Text style={s.footnote}>
        {Platform.OS === "web"
          ? "Saved in this browser"
          : "Saved on this phone"}{" "}
        · {model.diagnostics?.pendingCount ?? 0} pending
      </Text>
    </View>
  );
  const fixtureView = (
    <View style={s.fixtureHeading}>
      <Text style={s.fixtureTitle}>
        Roma <Text style={s.vs}>vs</Text> Maple FC
      </Text>
      <Text style={s.muted}>Sat 24 Oct · 10:00 · Home</Text>
    </View>
  );
  const benchView = (
    <View style={s.bench}>
      <Text style={s.label}>Bench · {bench.length}</Text>
      <View style={s.benchPlayers}>
        {bench.map((id) => (
          <View key={id} style={s.row}>
            <View style={s.miniDisc}>
              <Text style={s.discText}>{id.slice(-2)}</Text>
            </View>
            <Text style={s.small}>{name(id)}</Text>
          </View>
        ))}
        {!bench.length && (
          <Text style={s.small}>No available bench players</Text>
        )}
      </View>
    </View>
  );
  const scoreView = (
    <View style={s.scoreRow}>
      <View style={s.scoreTeam}>
        <View style={s.badge}>
          <Text style={s.badgeText}>RR</Text>
        </View>
        <Text style={s.label}>Roma</Text>
      </View>
      <Text style={s.score}>
        {state?.score.for ?? 0} : {state?.score.against ?? 0}
      </Text>
      <View style={s.scoreTeam}>
        <Icon name="shield" size={35} color={colors.inkMuted} />
        <Text style={s.label}>Maple FC</Text>
      </View>
    </View>
  );

  return (
    <View style={s.outer}>
      <StatusBar style="dark" />
      {desktop && (
        <View style={s.aside}>
          <View style={s.row}>
            <Icon name="ball" size={35} color={colors.brand} />
            <Text style={s.reviewBrand}>LongBall</Text>
          </View>
          <Text style={s.eyebrow}>THE MATCHDAY COMPANION</Text>
          <Text style={s.reviewTitle}>
            Less on your phone.{"\n"}More in the game.
          </Text>
          <Text style={s.reviewBody}>
            From the first check-in to the final whistle. A calmer matchday for
            Roma U10.
          </Text>
          <View style={s.steps}>
            {[
              "Check in your team",
              "Prepare the starting seven",
              "Keep the real match time",
            ].map((label, i) => (
              <View key={label} style={s.row}>
                <View style={s.stepNumber}>
                  <Text style={s.stepText}>0{i + 1}</Text>
                </View>
                <Text style={s.body}>{label}</Text>
              </View>
            ))}
          </View>
          <View style={s.reviewNote}>
            <Pill tone="muted">M0 · FICTIONAL REVIEW</Pill>
            <Text style={s.small}>
              Shared interface and match rules with the native app. Browser
              storage is for synthetic review. Native device checks remain open.
            </Text>
          </View>
        </View>
      )}
      <View style={[s.app, { paddingTop: insets.top }]}>
        {!state ? (
          <View style={s.loading}>
            <Icon name="ball" size={48} color={colors.brand} />
            <Text style={s.title}>LongBall</Text>
            {model.error ? (
              <>
                <Notice tone="error">{model.error}</Notice>
                <Button label="Retry opening match" onPress={model.retryLoad} />
              </>
            ) : (
              <>
                <ActivityIndicator color={colors.brand} />
                <Text style={s.muted}>Opening the local Roma fixture…</Text>
              </>
            )}
          </View>
        ) : (
          <>
            {matchMode ? (
              <View style={s.matchHeader}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Back to team; clock continues"
                  onPress={() => navigate("home")}
                  style={s.back}
                >
                  <Icon name="left" size={23} />
                  <Text style={s.label}>Back to team</Text>
                </Pressable>
                <Pill tone="muted">Fictional fixture</Pill>
              </View>
            ) : (
              <View style={s.header}>
                <View style={s.row}>
                  <View style={s.badge}>
                    <Text style={s.badgeText}>RR</Text>
                  </View>
                  <View>
                    <Text style={s.team}>Roma U10</Text>
                    <Text style={s.footnote}>Richmond Rovers · 26/27</Text>
                  </View>
                </View>
                <View style={s.brand}>
                  <Icon name="ball" size={20} color={colors.brand} />
                  <Text style={s.wordmark}>LongBall</Text>
                </View>
              </View>
            )}
            <ScrollView
              key={screen}
              contentContainerStyle={s.content}
              keyboardShouldPersistTaps="handled"
            >
              {model.conflict && (
                <>
                  <Notice tone="error">{model.conflict}</Notice>
                  <Button
                    label="Reload saved match; retain rejected branch"
                    variant="secondary"
                    onPress={model.reloadAfterConflict}
                  />
                </>
              )}
              {(model.error || localError) && (
                <>
                  <Notice tone="error">{model.error || localError}</Notice>
                  {model.pendingRetry && (
                    <Button
                      label="Retry unsaved action"
                      variant="secondary"
                      onPress={() => {
                        void model.retry();
                      }}
                    />
                  )}
                </>
              )}
              {screen === "home" && (
                <>
                  <View style={s.intro}>
                    <Text style={s.eyebrow}>YOUR TEAM, READY TO PLAY</Text>
                    <Text accessibilityRole="header" style={s.heroTitle}>
                      Matchday
                    </Text>
                    <Text style={s.muted}>
                      A little preparation. A lot of football.
                    </Text>
                  </View>
                  <Card style={s.nextGame}>
                    <View style={s.between}>
                      <View style={s.row}>
                        <View style={s.iconTile}>
                          <Icon name="calendar" color={colors.brand} />
                        </View>
                        <Text style={s.date}>SAT 24 OCT · 10:00</Text>
                      </View>
                      <Pill tone="brand">HOME</Pill>
                    </View>
                    <Text style={s.matchTitle}>Roma vs Maple FC</Text>
                    <Text style={s.muted}>7-a-side · 2 × 25 minutes</Text>
                    <View style={s.stats}>
                      {[
                        { n: selected.length, label: "Selected" },
                        { n: present, label: "Checked in" },
                        { n: `${allocation.length}/7`, label: "Lineup" },
                      ].map((item) => (
                        <View key={item.label} style={s.statCell}>
                          <Text style={s.stat}>{item.n}</Text>
                          <Text style={s.small}>{item.label}</Text>
                        </View>
                      ))}
                    </View>
                    <Button
                      label={
                        completed
                          ? "Review match"
                          : started
                            ? "Resume match"
                            : "Prepare match"
                      }
                      icon="arrow"
                      onPress={completed ? () => navigate("reports") : prepare}
                      testID="prepare-match"
                    />
                  </Card>
                  <Text style={s.section}>Before the whistle</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Match attendance"
                    onPress={() => navigate("attendance")}
                  >
                    <Card style={s.task}>
                      <View style={s.iconTile}>
                        <Icon name="users" color={colors.brand} />
                      </View>
                      <View style={s.flex}>
                        <Text style={s.cardTitle}>Match attendance</Text>
                        <Text style={s.small}>
                          {present} of {selected.length} selected players
                          checked in
                        </Text>
                      </View>
                      <Icon name="chevron" size={20} />
                    </Card>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Starting lineup"
                    onPress={prepare}
                  >
                    <Card style={s.task}>
                      <View style={s.iconTile}>
                        <Icon name="shield" color={colors.brand} />
                      </View>
                      <View style={s.flex}>
                        <Text style={s.cardTitle}>
                          {halfTime ? "Second-half lineup" : "Starting lineup"}
                        </Text>
                        <Text style={s.small}>
                          {allocation.length === 7
                            ? "Seven places prepared · 2–3–1"
                            : "Set your seven · 2–3–1 formation"}
                        </Text>
                      </View>
                      <Icon name="chevron" size={20} />
                    </Card>
                  </Pressable>
                  <View style={s.homeFooter}>
                    <View style={s.row}>
                      <Icon name="shield" size={18} color={colors.brand} />
                      <Text style={s.small}>
                        13 fictional players · Season 26/27
                      </Text>
                    </View>
                    <Text style={s.footnote}>
                      Local manager review · no live team data
                    </Text>
                  </View>
                </>
              )}
              {(screen === "attendance" || screen === "team") && (
                <>
                  <Text style={s.eyebrow}>ROMA U10 · MATCH SQUAD</Text>
                  <Text accessibilityRole="header" style={s.title}>
                    {screen === "team" ? "Your team" : "Who’s here?"}
                  </Text>
                  <Text style={s.muted}>Roma vs Maple FC · 24 October</Text>
                  <View style={s.between}>
                    <View>
                      <Text style={s.stat}>
                        {present} / {selected.length}
                      </Text>
                      <Text style={s.small}>selected players present</Text>
                    </View>
                    <Pill tone={present >= 7 ? "brand" : "warning"}>
                      {present >= 7 ? "Ready to prepare" : "Check-in open"}
                    </Pill>
                  </View>
                  <Notice tone="info">
                    Availability replies are plans. Record who is actually here
                    separately.
                  </Notice>
                  {!started && (
                    <Button
                      label={`Mark ${selected.length} selected players present`}
                      variant="secondary"
                      icon="check"
                      disabled={busy || bulkBusy}
                      onPress={() => {
                        void checkInAll();
                      }}
                      testID="check-in-all"
                    />
                  )}
                  <View style={s.roster}>
                    {romaFixture.players.map((player, index) => {
                      const inSquad = selected.includes(player.id);
                      return (
                        <View key={player.id} style={s.rosterRow}>
                          <View style={s.row}>
                            <View
                              style={[
                                s.numberBadge,
                                index === 0 && s.keeperBadge,
                              ]}
                            >
                              <Text style={s.discText}>
                                {String(index + 1).padStart(2, "0")}
                              </Text>
                            </View>
                            <View style={s.flex}>
                              <Text style={s.cardTitle}>
                                {player.displayName}
                                {index === 0 ? " · GK" : ""}
                              </Text>
                              <Text style={s.small}>
                                {inSquad
                                  ? "Reply: Available · Selected"
                                  : "Not selected for this fixture"}
                              </Text>
                            </View>
                          </View>
                          {inSquad ? (
                            <View style={s.choices}>
                              {(
                                [
                                  { value: "present", label: "Present" },
                                  { value: "absent", label: "Absent" },
                                  {
                                    value: "not_recorded",
                                    label: "Not recorded",
                                  },
                                ] as const
                              ).map((choice) => (
                                <Pressable
                                  key={choice.value}
                                  accessibilityRole="radio"
                                  accessibilityState={{
                                    checked:
                                      state.attendance[player.id] ===
                                      choice.value,
                                    disabled: started,
                                  }}
                                  accessibilityLabel={`${player.displayName}, ${choice.label}`}
                                  disabled={started || busy || bulkBusy}
                                  onPress={() => {
                                    void send({
                                      type: "attendance.recorded",
                                      playerId: player.id,
                                      status: choice.value as Attendance,
                                    });
                                  }}
                                  style={[
                                    s.choice,
                                    state.attendance[player.id] ===
                                      choice.value && s.choiceSelected,
                                  ]}
                                >
                                  <Text
                                    style={[
                                      s.choiceText,
                                      state.attendance[player.id] ===
                                        choice.value && s.choiceSelectedText,
                                    ]}
                                  >
                                    {choice.label}
                                  </Text>
                                </Pressable>
                              ))}
                            </View>
                          ) : (
                            <Text style={s.footnote}>
                              Not recorded · outside match squad
                            </Text>
                          )}
                        </View>
                      );
                    })}
                  </View>
                  {!started && (
                    <Button
                      label="Continue to lineup"
                      icon="arrow"
                      onPress={() => navigate("lineup")}
                      disabled={present < 7 || busy}
                      testID="continue-lineup"
                    />
                  )}
                  {present < 7 && (
                    <Text style={s.small}>
                      Confirm seven present players, including Player 01 in
                      goal.
                    </Text>
                  )}
                </>
              )}
              {screen === "lineup" && (
                <>
                  <View style={s.between}>
                    <Text accessibilityRole="header" style={s.title}>
                      {halfTime ? "Half-time" : "Prepare the lineup"}
                    </Text>
                    <Pill tone="warning">Pending start</Pill>
                  </View>
                  {fixtureView}
                  {halfTime && (
                    <Card>
                      {scoreView}
                      <View style={s.between}>
                        <View>
                          <Text style={s.small}>First half played</Text>
                          <Text style={s.section}>
                            {formatTime(state.firstHalfDurationMs ?? 0)}
                          </Text>
                        </View>
                        <View>
                          <Text style={s.small}>Second half planned</Text>
                          <Text style={s.section}>25:00</Text>
                        </View>
                      </View>
                    </Card>
                  )}
                  <View style={s.between}>
                    <Text style={s.label}>
                      {present} present · {allocation.length} on pitch ·{" "}
                      {bench.length} bench
                    </Text>
                    <Text style={s.small}>2–3–1</Text>
                  </View>
                  {allocation.length === 0 && (
                    <Button
                      label="Place the first seven"
                      variant="secondary"
                      icon="users"
                      onPress={() => {
                        void send({
                          type: "lineup.staged",
                          lineup: suggestedStartingLineup(state),
                        });
                      }}
                      disabled={present < 7 || busy}
                      testID="place-seven"
                    />
                  )}
                  <Pitch
                    lineup={allocation}
                    players={state.config.players}
                    onSlotPress={setSlot}
                    selectedSlot={slot ?? undefined}
                  />
                  {benchView}
                  <Text style={s.centerSmall}>
                    Tap a place to choose or swap a player
                  </Text>
                  <Notice tone="warning">
                    Changes take effect when you start the{" "}
                    {halfTime ? "second" : "first"} half. Setup adds no playing
                    time.
                  </Notice>
                  <Card>
                    <View style={s.row}>
                      <Icon name="shield" color={colors.brand} />
                      <View style={s.flex}>
                        <Text style={s.cardTitle}>One fixed keeper</Text>
                        <Text style={s.small}>
                          Player 01 · first-choice goalkeeper
                        </Text>
                      </View>
                    </View>
                  </Card>
                  {validation.length > 0 && (
                    <Notice tone="info">
                      Choose seven present, available players with one eligible
                      goalkeeper before starting.
                    </Notice>
                  )}

                  {!started && (
                    <Button
                      label="Review attendance"
                      variant="quiet"
                      onPress={() => navigate("attendance")}
                    />
                  )}
                </>
              )}
              {screen === "live" && clock && (
                <>
                  <View style={s.between}>
                    <Text accessibilityRole="header" style={s.title}>
                      {completed
                        ? "Full time"
                        : halfTime
                          ? "Half-time"
                          : "Match live"}
                    </Text>
                    <Pill tone={running ? "brand" : "muted"}>
                      {running ? "Recording" : "Clock stopped"}
                    </Pill>
                  </View>
                  {localStatus}
                  {scoreView}
                  {clock.recoveryRequired ? (
                    <>
                      <Notice tone="error">
                        Time needs checking. Last secure checkpoint:{" "}
                        {formatTime(state.halfActiveMs)}. Confirm elapsed time
                        with the referee.
                      </Notice>
                      <Button
                        label="Check the match clock"
                        icon="clock"
                        onPress={() => {
                          setRecovery(true);
                          setRecoveryTime(formatTime(state.halfActiveMs));
                        }}
                      />
                    </>
                  ) : (
                    <View style={s.clockBlock}>
                      <Text style={s.muted}>
                        {completed
                          ? "Total active play"
                          : halfTime
                            ? "First half played"
                            : `${state.half === 1 ? "1st" : "2nd"} half${running ? "" : " · Paused"}`}
                      </Text>
                      <Text style={s.clock}>
                        {formatTime(
                          completed
                            ? clock.matchActiveMs
                            : halfTime
                              ? (state.firstHalfDurationMs ?? 0)
                              : clock.remainingMs,
                        )}
                      </Text>
                      {!completed && !halfTime && (
                        <Text style={s.label}>
                          {clock.addedMs > 0
                            ? `+${formatTime(clock.addedMs)} added time`
                            : "remaining"}
                        </Text>
                      )}
                      <Text style={s.small}>
                        {!completed &&
                          `${formatTime(clock.halfActiveMs)} played this half · `}
                        {formatTime(clock.matchActiveMs)} match active
                      </Text>
                    </View>
                  )}
                  {halfTime ? (
                    <>
                      <Notice tone="warning">
                        The break adds no minutes. Prepare changes, then start a
                        fresh 25-minute second half.
                      </Notice>
                      <Button
                        label="Prepare second half"
                        icon="arrow"
                        onPress={() => navigate("lineup")}
                        testID="prepare-second-half"
                      />
                    </>
                  ) : (
                    <>
                      {running &&
                        !clock.recoveryRequired &&
                        clock.remainingMs === 0 && (
                          <Notice tone="warning">
                            Planned half time reached. Keep recording until the
                            referee’s whistle, then end the half manually.
                          </Notice>
                        )}
                      <Pitch
                        lineup={state.lineup}
                        players={state.config.players}
                        compact
                        onSlotPress={
                          completed || clock.recoveryRequired
                            ? undefined
                            : setSlot
                        }
                      />
                      {benchView}
                    </>
                  )}
                  {completed && (
                    <>
                      <Notice tone="info">
                        Rehearsal complete. The journal and minutes are
                        retained. Awards and server sync are later milestones.
                      </Notice>
                      <Button
                        label="View local match record"
                        icon="chart"
                        onPress={() => navigate("reports")}
                      />
                    </>
                  )}
                  <Text style={s.footnote}>
                    Local synthetic controller · no server connection configured
                  </Text>
                </>
              )}
              {screen === "schedule" && (
                <>
                  <Text style={s.eyebrow}>SEASON 26/27</Text>
                  <Text accessibilityRole="header" style={s.title}>
                    Schedule
                  </Text>
                  <Text style={s.muted}>Your next football day.</Text>
                  <Card>
                    <View style={s.between}>
                      <Text style={s.date}>SATURDAY 24 OCTOBER</Text>
                      <Pill tone="brand">Home</Pill>
                    </View>
                    {fixtureView}
                    <Text style={s.muted}>Arrival 09:30 · Kick-off 10:00</Text>
                    <Text style={s.small}>
                      7-a-side · 50 planned minutes · fictional fixture
                    </Text>
                    <Button
                      label={
                        completed
                          ? "View match record"
                          : started
                            ? "Resume match"
                            : "Prepare match"
                      }
                      onPress={completed ? () => navigate("reports") : prepare}
                      icon="arrow"
                    />
                  </Card>
                  <Notice tone="info">
                    This review contains one fictional fixture. Fixture editing
                    and training remain in the next preparation milestones.
                  </Notice>
                </>
              )}
              {screen === "reports" && (
                <>
                  <Text style={s.eyebrow}>ROMA U10 · THIS REHEARSAL</Text>
                  <Text accessibilityRole="header" style={s.title}>
                    Match record
                  </Text>
                  {fixtureView}
                  <Card>
                    {scoreView}
                    <View style={s.between}>
                      <Text style={s.muted}>
                        {completed
                          ? "Final active duration"
                          : "Current active duration"}
                      </Text>
                      <Text style={s.section}>
                        {formatTime(clock?.matchActiveMs ?? 0)}
                      </Text>
                    </View>
                    <Text style={s.small}>
                      {completed
                        ? "Local completed match"
                        : "In progress · not a final report"}{" "}
                      · Manager view
                    </Text>
                  </Card>
                  <Text style={s.section}>Actual participation</Text>
                  {playerMinutes(state, model.sample).map((item) => (
                    <View key={item.playerId} style={s.reportRow}>
                      <View style={s.flex}>
                        <Text style={s.cardTitle}>{name(item.playerId)}</Text>
                        <Text style={s.small}>
                          {state.attendance[item.playerId] === "present"
                            ? "Present"
                            : state.attendance[item.playerId] === "absent"
                              ? "Known absent"
                              : "Attendance not recorded"}{" "}
                          ·{" "}
                          {Object.entries(item.positionMs)
                            .map(
                              ([position, duration]) =>
                                `${position} ${formatTime(duration)}`,
                            )
                            .join(" · ") || "No recorded position time"}
                        </Text>
                      </View>
                      <Text style={s.reportTime}>
                        {formatTime(item.playingMs)}
                      </Text>
                    </View>
                  ))}
                  <Notice tone="info">
                    Minutes derive from recorded active intervals. The full
                    fair-time planner, season reports and corrections remain to
                    be implemented.
                  </Notice>
                  {localStatus}
                </>
              )}
              {screen === "more" && (
                <>
                  <Text style={s.eyebrow}>SYNTHETIC DEVELOPMENT BUILD</Text>
                  <Text accessibilityRole="header" style={s.title}>
                    Feasibility lab
                  </Text>
                  <Text style={s.muted}>
                    M0 evidence, with device checks still open.
                  </Text>
                  <Card>
                    <Text style={s.section}>Local recording</Text>
                    <Text style={s.body}>
                      Storage:{" "}
                      {model.diagnostics?.mode === "encrypted-native"
                        ? "SQLCipher journal"
                        : "Synthetic browser storage"}
                    </Text>
                    <Text style={s.body}>
                      Saved records: {model.diagnostics?.savedCount ?? 0}
                    </Text>
                    <Text style={s.body}>
                      Pending sync: {model.diagnostics?.pendingCount ?? 0}
                    </Text>
                    <Text style={s.body}>
                      Retained conflicts:{" "}
                      {model.diagnostics?.conflictCount ?? 0}
                    </Text>
                    <Text style={s.body}>
                      Cipher:{" "}
                      {model.diagnostics?.cipherVersion ??
                        "Unavailable in browser"}
                    </Text>
                    <Text style={s.small}>
                      Actions stay local. Server identity, controller grants and
                      synchronisation are not connected.
                    </Text>
                  </Card>
                  <Notice tone="warning">
                    Physical device tests are required for encryption, wrong-key
                    refusal, key loss, backups, lock, process kill, reboot and
                    notifications.
                  </Notice>
                  <Button
                    label="Run journal encryption probe"
                    variant="secondary"
                    disabled={busy || Platform.OS === "web"}
                    onPress={() => {
                      void model.runCipherProbe().then(setProbe);
                    }}
                  />
                  {probe && <Notice tone="info">{probe}</Notice>}
                  {model.diagnosticsWarning && (
                    <Notice tone="warning">{model.diagnosticsWarning}</Notice>
                  )}
                  <Card>
                    <Text style={s.section}>
                      Native notification experiment
                    </Text>
                    <Text style={s.small}>
                      Requests local notification permission and one synthetic
                      reminder. Test foreground, lock, Focus and denied
                      permission on each phone. Delivery is not guaranteed.
                    </Text>
                    <Button
                      label="Test notification in 10 seconds"
                      variant="secondary"
                      disabled={Platform.OS === "web"}
                      onPress={() => {
                        void testNotification();
                      }}
                    />
                    <Button
                      label="Cancel test notification"
                      variant="quiet"
                      disabled={Platform.OS === "web"}
                      onPress={() => {
                        void replaceLocalWarnings({
                          revision: "lab-cancelled",
                          dueInMs: 0,
                          running: false,
                        })
                          .then(() =>
                            setAlertStatus("Test notifications cancelled."),
                          )
                          .catch(() =>
                            setAlertStatus(
                              "Unable to cancel the test. Open system notification settings.",
                            ),
                          );
                      }}
                    />
                    {alertStatus && <Notice tone="info">{alertStatus}</Notice>}
                  </Card>
                  <Card>
                    <Text style={s.section}>Try the journey</Text>
                    {[
                      "Check in the selected squad.",
                      "Place seven starters and swap a pitch piece.",
                      "Start, pause and resume the first half.",
                      "End early; stage changes during the break.",
                      "Start a fresh 25-minute second half.",
                      "Reload a running browser session to check recovery.",
                    ].map((text, i) => (
                      <Text key={text} style={s.body}>
                        {i + 1}. {text}
                      </Text>
                    ))}
                  </Card>
                  <Text style={s.footnote}>
                    F01–F28 remain the integrated pilot scope. Fictional Roma
                    U10 data only. No paid infrastructure provisioned.
                  </Text>
                </>
              )}
            </ScrollView>
            {screen === "lineup" && (
              <View
                style={[
                  s.liveRail,
                  { paddingBottom: Math.max(12, insets.bottom) },
                ]}
              >
                <Button
                  label={`Start ${halfTime ? "second" : "first"} half · 25:00`}
                  icon="play"
                  onPress={() => {
                    void send({ type: "half.started" }).then((ok) => {
                      if (ok) setScreen("live");
                    });
                  }}
                  disabled={
                    validation.length > 0 ||
                    busy ||
                    Boolean(clock?.recoveryRequired)
                  }
                  testID="start-half"
                />
                <Text style={s.centerSmall}>
                  {validation.length
                    ? "Complete seven valid places, including the goalkeeper."
                    : "All staged positions commit together on Start."}
                </Text>
              </View>
            )}
            {screen === "live" && clock && !completed && !halfTime && (
              <View
                style={[
                  s.liveRail,
                  { paddingBottom: Math.max(12, insets.bottom) },
                ]}
              >
                <View style={s.between}>
                  <Text style={s.label}>
                    {state.half === 1 ? "1st" : "2nd"} half
                    {running ? "" : " · Paused"}
                  </Text>
                  <Text style={s.railTime}>
                    {clock.recoveryRequired
                      ? "Time needs checking"
                      : clock.addedMs > 0
                        ? `+${formatTime(clock.addedMs)} added`
                        : `${formatTime(clock.remainingMs)} remaining`}
                  </Text>
                </View>
                <View style={s.actions}>
                  <View style={s.flex}>
                    <Button
                      label="Change lineup"
                      icon="swap"
                      disabled={busy || clock.recoveryRequired}
                      onPress={() => setSlot("lw")}
                    />
                  </View>
                  <View style={s.flex}>
                    <Button
                      label={running ? "Pause clock" : "Resume clock"}
                      icon={running ? "pause" : "play"}
                      variant="secondary"
                      disabled={busy || clock.recoveryRequired}
                      onPress={() => {
                        void send({
                          type: running ? "half.paused" : "half.resumed",
                        });
                      }}
                      testID="pause-resume"
                    />
                  </View>
                </View>
                <View style={s.railEnd}>
                  <Text style={[s.footnote, s.flex]}>
                    End manually at the whistle.{"\n"}Zero keeps counting.
                  </Text>
                  <Button
                    label={state.half === 1 ? "End first half" : "End match"}
                    variant="quiet"
                    disabled={busy || clock.recoveryRequired}
                    onPress={() => setConfirmEnd(true)}
                    testID="end-half"
                  />
                </View>
              </View>
            )}
            {!matchMode && (
              <View
                style={[s.nav, { paddingBottom: Math.max(8, insets.bottom) }]}
              >
                {nav.map((item) => (
                  <Pressable
                    key={item.screen}
                    accessibilityRole="button"
                    accessibilityState={{ selected: screen === item.screen }}
                    accessibilityLabel={item.label}
                    onPress={() => navigate(item.screen)}
                    style={s.navItem}
                  >
                    <Icon
                      name={item.icon}
                      size={23}
                      color={
                        screen === item.screen ? colors.brand : colors.inkMuted
                      }
                    />
                    <Text
                      style={[
                        s.navLabel,
                        screen === item.screen && s.navSelected,
                      ]}
                    >
                      {item.label}
                    </Text>
                    {screen === item.screen && <View style={s.navIndicator} />}
                  </Pressable>
                ))}
              </View>
            )}
          </>
        )}
      </View>
      <Sheet
        visible={slot !== null}
        onClose={() => setSlot(null)}
        title="Choose a player"
      >
        <Text style={s.muted}>
          {slots.find((item) => item.slotId === slot)?.position} ·{" "}
          {started && !halfTime ? "Review before applying" : "Pending start"}
        </Text>
        <Text style={s.small}>
          Choose a bench player, or swap two occupied places.
        </Text>
        {selected
          .filter(
            (id) =>
              state?.attendance[id] === "present" && state.availability[id],
          )
          .map((id) => (
            <Pressable
              key={id}
              accessibilityRole="button"
              accessibilityLabel={`Choose ${name(id)}`}
              disabled={busy}
              onPress={() => {
                void choosePlayer(id);
              }}
              style={s.playerOption}
            >
              <View style={s.numberBadge}>
                <Text style={s.discText}>{id.slice(-2)}</Text>
              </View>
              <Text style={[s.cardTitle, s.flex]}>{name(id)}</Text>
              <Text style={s.small}>
                {allocation.find((item) => item.playerId === id)?.position ??
                  "Bench"}
              </Text>
              <Icon name="chevron" size={18} />
            </Pressable>
          ))}
        <Button label="Cancel" variant="quiet" onPress={() => setSlot(null)} />
      </Sheet>
      <Sheet
        visible={draft !== null}
        onClose={() => setDraft(null)}
        title="Review lineup change"
      >
        <Notice tone="warning">
          Nothing changes until you confirm. The match clock continues.
        </Notice>
        {draft &&
          state &&
          draft.lineup
            .filter(
              (item) =>
                state.lineup.find((old) => old.slotId === item.slotId)
                  ?.playerId !== item.playerId,
            )
            .map((item) => (
              <Card key={item.slotId}>
                <Text style={s.small}>{item.position}</Text>
                <Text style={s.cardTitle}>
                  {name(
                    state.lineup.find((old) => old.slotId === item.slotId)
                      ?.playerId ?? "",
                  )}{" "}
                  off
                </Text>
                <Text style={s.cardTitle}>{name(item.playerId)} on</Text>
              </Card>
            ))}
        <Text style={s.small}>Applied together at the time you confirm.</Text>
        {model.error && <Notice tone="error">{model.error}</Notice>}
        <Button
          label="Confirm now"
          icon="check"
          disabled={busy}
          onPress={() => {
            if (draft)
              void send({
                type: "lineup.committed",
                lineup: draft.lineup,
                sourceRevision: draft.revision,
              }).then((ok) => {
                if (ok) setDraft(null);
              });
          }}
          testID="confirm-lineup"
        />
        <Button
          label="Keep current lineup"
          variant="secondary"
          onPress={() => setDraft(null)}
        />
      </Sheet>
      <Sheet
        visible={confirmEnd}
        onClose={() => setConfirmEnd(false)}
        title={state?.half === 1 ? "End the first half?" : "End the match?"}
      >
        <Text style={s.body}>
          {state?.half === 1 ? "First" : "Second"} half ·{" "}
          {formatTime(clock?.halfActiveMs ?? 0)} played
        </Text>
        <Text style={s.section}>
          Roma {state?.score.for} : {state?.score.against} Maple FC
        </Text>
        <Notice tone="warning">
          Confirm at the referee’s whistle.{" "}
          {state?.half === 1
            ? "The second half will still start at 25:00."
            : "The local match record will become read-only."}
        </Notice>
        {model.error && <Notice tone="error">{model.error}</Notice>}
        <Button
          label={
            state?.half === 1 ? "Confirm end first half" : "Confirm full time"
          }
          icon="check"
          disabled={busy}
          onPress={() => {
            void send({ type: "half.ended" }).then((ok) => {
              if (ok) {
                setConfirmEnd(false);
                setScreen("live");
              }
            });
          }}
          testID="confirm-end"
        />
        <Button
          label="Keep playing"
          variant="secondary"
          onPress={() => setConfirmEnd(false)}
        />
      </Sheet>
      <Sheet
        visible={recovery}
        onClose={() => setRecovery(false)}
        title="Check the match clock"
      >
        <Text style={s.body}>
          Last secure checkpoint: {formatTime(state?.halfActiveMs ?? 0)} in this
          half. Use the referee’s active elapsed time.
        </Text>
        <Text style={s.label}>Confirmed elapsed time (MM:SS)</Text>
        <TextInput
          accessibilityLabel="Confirmed elapsed time in minutes and seconds"
          value={recoveryTime}
          onChangeText={setRecoveryTime}
          placeholder="12:30"
          style={s.input}
          keyboardType="numbers-and-punctuation"
        />
        <Text style={s.label}>Source and reason</Text>
        <TextInput
          accessibilityLabel="Clock correction source and reason"
          value={reason}
          onChangeText={setReason}
          placeholder="Checked with the referee"
          style={s.input}
        />
        <View style={s.row}>
          <Switch
            accessibilityLabel="Lineup and availability stayed unchanged since checkpoint"
            value={unchanged}
            onValueChange={setUnchanged}
          />
          <Text style={[s.small, s.flex]}>
            Lineup and availability stayed unchanged since the checkpoint.
          </Text>
        </View>
        <Notice tone="warning">
          If players changed during the gap, retain the journal for later
          reconciliation. This slice cannot reconstruct those changes.
        </Notice>
        {(localError || model.error) && (
          <Notice tone="error">{localError || model.error}</Notice>
        )}
        <Button
          label="Record confirmed time"
          disabled={!unchanged || busy}
          onPress={() => {
            void recover();
          }}
        />
        <Button
          label="Keep recovery open"
          variant="quiet"
          onPress={() => setRecovery(false)}
        />
      </Sheet>
    </View>
  );
}
function Sheet({
  visible,
  onClose,
  title,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
    >
      <View style={s.scrim}>
        <View accessibilityViewIsModal style={s.sheet}>
          <View style={s.sheetTop}>
            <Text accessibilityRole="header" style={[s.title, s.flex]}>
              {title}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close dialog"
              style={s.close}
              onPress={onClose}
            >
              <Text style={s.closeText}>×</Text>
            </Pressable>
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={s.sheetContent}
          >
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
const s = StyleSheet.create({
  outer: {
    flex: 1,
    backgroundColor: "#EAF0EC",
    flexDirection: "row",
    justifyContent: "center",
  },
  app: {
    flex: 1,
    maxWidth: 480,
    backgroundColor: colors.canvas,
    borderColor: colors.border,
    borderLeftWidth: Platform.OS === "web" ? 1 : 0,
    borderRightWidth: Platform.OS === "web" ? 1 : 0,
  },
  header: {
    padding: 20,
    paddingTop: 24,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    borderBottomWidth: 1,
    borderColor: "#E5EAE7",
  },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  between: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    flexWrap: "wrap",
  },
  flex: { flex: 1 },
  brand: { flexDirection: "row", alignItems: "center", gap: 5 },
  wordmark: {
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: -0.6,
    color: colors.ink,
  },
  badge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: colors.brand,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#EDF3EF",
  },
  badgeText: { fontWeight: "700", color: colors.brand, fontSize: 15 },
  team: { fontSize: 16, fontWeight: "700", color: colors.ink },
  content: { padding: 20, paddingBottom: 28, gap: 16 },
  intro: { gap: 8, paddingTop: 5, marginBottom: 5 },
  eyebrow: {
    color: colors.brand,
    letterSpacing: 1.6,
    fontSize: 11,
    fontWeight: "700",
    lineHeight: 18,
  },
  heroTitle: {
    color: colors.ink,
    fontSize: 36,
    lineHeight: 42,
    fontWeight: "700",
    letterSpacing: -1.2,
  },
  title: {
    fontSize: 24,
    lineHeight: 30,
    fontWeight: "700",
    letterSpacing: -0.5,
    color: colors.ink,
  },
  body: { fontSize: 16, lineHeight: 24, color: colors.ink },
  muted: { fontSize: 16, lineHeight: 24, color: colors.inkMuted },
  small: { fontSize: 14, lineHeight: 20, color: colors.inkMuted },
  footnote: { fontSize: 12, lineHeight: 18, color: colors.inkMuted },
  label: { fontSize: 14, lineHeight: 20, fontWeight: "600", color: colors.ink },
  section: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: "600",
    color: colors.ink,
  },
  cardTitle: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: "600",
    color: colors.ink,
  },
  nextGame: {
    gap: 18,
    padding: 20,
    borderTopWidth: 3,
    borderTopColor: colors.brand,
  },
  iconTile: {
    width: 42,
    height: 42,
    backgroundColor: "#EDF3EF",
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
  },
  date: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.5,
    color: colors.ink,
  },
  matchTitle: {
    fontSize: 27,
    lineHeight: 34,
    fontWeight: "700",
    letterSpacing: -0.8,
    color: colors.ink,
    marginBottom: -12,
  },
  stats: {
    flexDirection: "row",
    backgroundColor: "#F3F6F4",
    borderRadius: 8,
    paddingVertical: 16,
  },
  statCell: { flex: 1, alignItems: "center", gap: 4 },
  stat: { fontSize: 28, lineHeight: 32, fontWeight: "700", color: colors.ink },
  task: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16 },
  homeFooter: { gap: 8, alignItems: "center", paddingVertical: 12 },
  nav: {
    flexDirection: "row",
    backgroundColor: "#FFFFFF",
    borderTopWidth: 1,
    borderColor: "#E1E8E3",
    paddingTop: 10,
  },
  navItem: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 56,
    gap: 4,
  },
  navLabel: { color: colors.inkMuted, fontSize: 11, lineHeight: 16 },
  navSelected: { color: colors.brand, fontWeight: "700" },
  navIndicator: {
    position: "absolute",
    bottom: -7,
    height: 3,
    width: 25,
    backgroundColor: colors.brand,
    borderRadius: 2,
  },
  matchHeader: {
    minHeight: 64,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  back: { flexDirection: "row", alignItems: "center", gap: 5, minHeight: 48 },
  fixtureHeading: { gap: 4 },
  fixtureTitle: {
    fontSize: 22,
    lineHeight: 28,
    color: colors.ink,
    fontWeight: "700",
  },
  vs: { color: colors.inkMuted, fontSize: 16, fontWeight: "400" },
  roster: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    overflow: "hidden",
  },
  rosterRow: {
    padding: 14,
    gap: 12,
    borderBottomWidth: 1,
    borderColor: "#E6EBE8",
  },
  numberBadge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#EDF3EF",
    alignItems: "center",
    justifyContent: "center",
  },
  keeperBadge: { backgroundColor: colors.selection },
  discText: { fontSize: 15, fontWeight: "700", color: colors.ink },
  choices: { flexDirection: "row", gap: 6 },
  choice: {
    flex: 1,
    minHeight: 48,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.controlBorder,
    alignItems: "center",
    justifyContent: "center",
    padding: 4,
  },
  choiceSelected: { backgroundColor: colors.brand, borderColor: colors.brand },
  choiceText: {
    fontSize: 12,
    lineHeight: 17,
    color: colors.ink,
    textAlign: "center",
  },
  choiceSelectedText: { color: "#FFFFFF", fontWeight: "600" },
  bench: {
    backgroundColor: colors.bench,
    borderRadius: 8,
    padding: 12,
    gap: 10,
  },
  benchPlayers: { flexDirection: "row", gap: 18, flexWrap: "wrap" },
  miniDisc: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "white",
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  centerSmall: {
    fontSize: 12,
    lineHeight: 18,
    textAlign: "center",
    color: colors.inkMuted,
  },
  saveStatus: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    marginTop: -8,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.brand,
  },
  scoreRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    gap: 12,
    paddingVertical: 8,
  },
  scoreTeam: { alignItems: "center", gap: 5, flex: 1 },
  score: {
    fontSize: 36,
    lineHeight: 44,
    fontWeight: "700",
    color: colors.ink,
    fontVariant: ["tabular-nums"],
  },
  clockBlock: { alignItems: "center", gap: 2, paddingBottom: 4 },
  clock: {
    fontSize: 48,
    lineHeight: 56,
    fontWeight: "700",
    letterSpacing: -1.5,
    color: colors.ink,
    fontVariant: ["tabular-nums"],
  },
  actions: { flexDirection: "row", gap: 10 },
  liveRail: {
    padding: 16,
    gap: 10,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  railTime: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "700",
    color: colors.ink,
    fontVariant: ["tabular-nums"],
  },
  railEnd: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderTopWidth: 1,
    borderColor: colors.border,
    paddingTop: 4,
  },
  endSection: {
    borderTopWidth: 1,
    borderColor: colors.border,
    paddingTop: 20,
    gap: 10,
    marginTop: 4,
  },
  reportRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  reportTime: {
    fontSize: 18,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
    color: colors.ink,
  },
  scrim: {
    flex: 1,
    backgroundColor: "rgba(10,28,19,0.48)",
    alignItems: "center",
    justifyContent: "flex-end",
  },
  sheet: {
    width: "100%",
    maxWidth: 480,
    maxHeight: "92%",
    backgroundColor: colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: 32,
  },
  sheetTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 16,
  },
  sheetContent: { gap: 16, paddingBottom: 20 },
  close: {
    minWidth: 48,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  closeText: { fontSize: 30, color: colors.inkMuted },
  playerOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 58,
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.controlBorder,
    borderRadius: 8,
    padding: 14,
    fontSize: 18,
    color: colors.ink,
    minHeight: 52,
  },
  loading: {
    flex: 1,
    padding: 24,
    alignItems: "center",
    justifyContent: "center",
    gap: 20,
  },
  aside: {
    width: 440,
    justifyContent: "center",
    padding: 48,
    gap: 24,
    marginRight: 32,
  },
  reviewBrand: {
    color: colors.ink,
    fontWeight: "800",
    fontSize: 34,
    letterSpacing: -1,
  },
  reviewTitle: {
    color: colors.ink,
    fontSize: 37,
    lineHeight: 45,
    fontWeight: "700",
    letterSpacing: -1.2,
  },
  reviewBody: { color: colors.inkMuted, fontSize: 17, lineHeight: 27 },
  steps: { gap: 18, marginVertical: 8 },
  stepNumber: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: "#C3D5C9",
    justifyContent: "center",
    alignItems: "center",
  },
  stepText: { fontSize: 11, fontWeight: "700", color: colors.brand },
  reviewNote: {
    gap: 14,
    paddingTop: 30,
    borderTopWidth: 1,
    borderColor: "#CAD8CF",
  },
});
