import { FormationDesigner } from "./FormationDesigner";
import { FormationAdvice } from "./FormationAdvice";
import { TeamLeagueEditor } from "./TeamDetailsEditors";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type KeyDownEvent,
} from "react-native";
import {
  defaultFormation,
  effectiveLogo,
  goalkeeperChoice,
  activePositionCodes,
  positionCatalogueFor,
  seasonPlayers,
  type AvailabilityResponse,
  type FixtureDraft,
  type LogoChoice,
  type PlayerProfile,
  type PreparationAttendance,
  type PreparationCommand,
  type PreparationFixture,
  type PreparationFormation,
  type PreparationState,
  type PreparationTraining,
  type TrainingDraft,
} from "@longball/application/preparation";
import {
  validPositionCode,
  type TeamPosition,
} from "@longball/application/position-catalogue";
import {
  formatUkDate,
  formatUkSeasonLabel,
} from "@longball/application/uk-display";
import {
  groupPreparationEvents,
  preparationEditorSaveRevision,
  retainedPreparationPlayers,
} from "@longball/application/preparation-presentation";
import { fixtureScheduleStatus } from "@longball/application/fixture-schedule-status";
import { TrainingSeriesEditor } from "./TrainingSeriesEditor";
import { RosterImportPanel } from "./RosterImportPanel";
import { CalendarExportPanel } from "./CalendarExportPanel";
import {
  buildCalendarExport,
  calendarEventsFromSchedule,
} from "@longball/application/calendar-export";
import { deliverCalendarExport } from "../platform/calendar-export";
import { FormationPositionEditor } from "./FormationPositionEditor";
import { ReusableMatchPlans } from "./ReusableMatchPlans";
import { SavedLineups } from "./SavedLineups";
import { useWorkspaceLayout, WorkspaceColumns } from "../ui/WorkspaceLayout";
import { randomUUID } from "../platform/id";
import { useDraftSignal, useUnsavedDraft } from "../platform/use-unsaved-draft";
import { Button, Card, colors, Icon, Notice, Pill } from "../ui";

export interface PreparationScreensProps {
  brandingPanel?: ReactNode;
  renderScheduledGameManagement?: (
    fixtureId: string,
    onDraftChange?: (dirty: boolean) => void,
  ) => ReactNode;
  initialFixtureId?: string;
  initialTrainingId?: string;
  initialScheduleFilter?: "matches" | "training";
  onDraftChange?: (dirty: boolean) => void;
  createFixtureId?: () => string;
  state: PreparationState;
  onChange: (command: PreparationCommand) => Promise<boolean> | boolean;
  view: "schedule" | "team" | "settings";
  onOpenMatch?: (fixtureId: string) => void;
  onOpenReport?: (fixtureId: string) => void;
  completedFixtureIds?: ReadonlySet<string>;
  acceptedFixtureIds?: ReadonlySet<string>;
  busy?: boolean;
  error?: string | null;
  storage?: "journal" | "service";
  onExportCalendar?: (selectedKeys: string[]) => Promise<string>;
  onPrepareRollover?: () => void;
  onPrepareChildActivation?: (playerId: string) => void;
}
type Payload = PreparationCommand extends infer Command
  ? Command extends PreparationCommand
    ? Omit<Command, "id" | "expectedRevision">
    : never
  : never;
type Editor =
  | { type: "profile"; value: PlayerProfile }
  | { type: "fixture"; value: FixtureDraft }
  | { type: "training"; value: TrainingDraft }
  | { type: "training_series"; value: TrainingDraft; mode: "create" | "manage" }
  | { type: "formation"; value: PreparationFormation }
  | { type: "club" | "team" | "rollover" | "positions" }
  | null;
type OpenEditor = Exclude<Editor, null> & { sourceRevision: number };
const responseOptions: { value: AvailabilityResponse; label: string }[] = [
  { value: "available", label: "Available" },
  { value: "unavailable", label: "Unavailable" },
  { value: "unsure", label: "Unsure" },
  { value: "no_reply", label: "No reply" },
];
const attendanceOptions: { value: PreparationAttendance; label: string }[] = [
  { value: "present", label: "Present" },
  { value: "absent", label: "Absent" },
  { value: "not_recorded", label: "Not recorded" },
];
function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "This change could not be saved. Your draft is retained.";
}
function dateLabel(date: string) {
  return formatUkDate(date);
}
function todayInLondon() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Europe/London",
  }).formatToParts(new Date());
  return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}-${parts.find((part) => part.type === "day")?.value}`;
}
function nextDate(state: PreparationState) {
  const season = state.seasons.find(
    (item) => item.id === state.activeSeasonId,
  )!;
  const date = todayInLondon();
  return date >= season.startDate && date <= season.endDate
    ? date
    : season.startDate;
}

async function exportLocalPreparationCalendar(
  state: PreparationState,
  seasonId: string,
  storage: "journal" | "service",
  selectedKeys: string[],
): Promise<string> {
  if (storage !== "journal")
    throw new Error("Connect a current authorised calendar export first.");
  const nowMs = Date.now();
  return deliverCalendarExport(
    buildCalendarExport({
      teamId: state.team.id,
      seasonId,
      events: calendarEventsFromSchedule(state, seasonId, nowMs),
      selectedKeys,
      nowMs,
    }),
    async () => {},
  );
}

/** Complete editable local preparation screens. Domain authority is checked by the owning application store. */
export function PreparationScreens(props: PreparationScreensProps) {
  return (
    <PreparationContent
      key={`${props.state.club.id}:${props.state.team.id}:${props.view}:${props.state.activeSeasonId}`}
      {...props}
    />
  );
}
function PreparationContent({
  state,
  onChange,
  view,
  onOpenMatch,
  onOpenReport,
  completedFixtureIds = new Set<string>(),
  acceptedFixtureIds = new Set<string>(),
  busy = false,
  error,
  storage = "journal",
  onPrepareRollover,
  onPrepareChildActivation,
  brandingPanel,
  onExportCalendar,
  renderScheduledGameManagement,
  initialFixtureId,
  initialTrainingId,
  initialScheduleFilter,
  onDraftChange,
  createFixtureId,
}: PreparationScreensProps) {
  const [observedAt] = useState(() => Date.now());
  const [editor, setOpenEditor] = useState<OpenEditor | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<{
    kind: "match" | "training";
    id: string;
  } | null>(() =>
    initialTrainingId &&
    state.training.some(
      (training) =>
        training.id === initialTrainingId &&
        training.seasonId === state.activeSeasonId,
    )
      ? { kind: "training", id: initialTrainingId }
      : initialFixtureId &&
          state.fixtures.some(
            (fixture) =>
              fixture.id === initialFixtureId &&
              fixture.seasonId === state.activeSeasonId,
          )
        ? { kind: "match", id: initialFixtureId }
        : null,
  );
  const routeScope = JSON.stringify([state.team.id, state.activeSeasonId]);
  const previousRouteScope = useRef(routeScope),
    handledOverviewRoute = useRef<string | null>(null);
  const routedFixtureExists = Boolean(
    initialFixtureId &&
      state.fixtures.some(
        (fixture) =>
          fixture.id === initialFixtureId &&
          fixture.seasonId === state.activeSeasonId,
      ),
  );
  const routedTrainingExists = Boolean(
    initialTrainingId &&
      state.training.some(
        (training) =>
          training.id === initialTrainingId &&
          training.seasonId === state.activeSeasonId,
      ),
  );
  const [tab, setTab] = useState<"matches" | "training">(
    initialScheduleFilter ?? (initialTrainingId ? "training" : "matches"),
  );
  useEffect(() => {
    if (previousRouteScope.current !== routeScope) {
      previousRouteScope.current = routeScope;
      setSelectedEvent(null);
    }
    const target =
      routedTrainingExists && initialTrainingId
        ? { kind: "training" as const, id: initialTrainingId }
        : routedFixtureExists && initialFixtureId
          ? { kind: "match" as const, id: initialFixtureId }
          : null;
    if (!target) {
      handledOverviewRoute.current = null;
      return;
    }
    const route = JSON.stringify([routeScope, target.kind, target.id]);
    if (handledOverviewRoute.current !== route) {
      handledOverviewRoute.current = route;
      setSelectedEvent(target);
      setTab(target.kind === "training" ? "training" : "matches");
    }
  }, [
    routeScope,
    initialFixtureId,
    initialTrainingId,
    routedFixtureExists,
    routedTrainingExists,
  ]);
  const [period, setPeriod] = useState<"upcoming" | "past">("upcoming");
  const [localError, setLocalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [squadTools, setSquadTools] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false),
    [formationDirty, setFormationDirty] = useState(false);
  const [setupsDirty, setSetupsDirty] = useState(false),
    [rosterDirty, setRosterDirty] = useState(false),
    [fixtureDirty, setFixtureDirty] = useState(false),
    [leagueDirty, setLeagueDirty] = useState(false),
    [scheduledDirty, setScheduledDirty] = useState(false);
  const anyDirty =
    editorDirty ||
    formationDirty ||
    setupsDirty ||
    rosterDirty ||
    fixtureDirty ||
    leagueDirty ||
    scheduledDirty;
  const setEditor = (value: Editor) => {
    if (value && anyDirty) {
      setLocalError(
        "Save or discard the current draft before opening another editor.",
      );
      return;
    }
    setOpenEditor(value ? { ...value, sourceRevision: state.revision } : null);
  };
  const draftChange = useRef(onDraftChange);
  useLayoutEffect(() => {
    draftChange.current = onDraftChange;
    onDraftChange?.(anyDirty);
  }, [onDraftChange, anyDirty]);
  useLayoutEffect(() => () => draftChange.current?.(false), []);
  const players = seasonPlayers(state);
  const season = state.seasons.find(
    (item) => item.id === state.activeSeasonId,
  )!;
  const disabled = busy || saving;
  const editorSourceChanged =
    editor !== null && editor.sourceRevision !== state.revision;
  const formDisabled = disabled || editorSourceChanged;
  const scheduleGroups = groupPreparationEvents<
    PreparationFixture | PreparationTraining
  >(
    (tab === "matches" ? state.fixtures : state.training).filter(
      (event) => event.seasonId === season.id,
    ),
    {
      date: (event) => ("playedDate" in event ? event.playedDate : event.date),
      time: (event) => ("kickoff" in event ? event.kickoff : event.time),
      period,
      today: todayInLondon(),
    },
  );
  const commit = async (
    payload: Payload,
    closeEditor = false,
    reviewed?: { id: string; expectedRevision: number },
  ): Promise<boolean> => {
    if (disabled) return false;
    setSaving(true);
    setLocalError(null);
    try {
      const expectedRevision =
        closeEditor && editor
          ? preparationEditorSaveRevision(
              editor.sourceRevision,
              state.revision,
              reviewed?.expectedRevision,
            )
          : (reviewed?.expectedRevision ?? state.revision);
      const saved = await onChange({
        ...payload,
        id: reviewed?.id ?? randomUUID(),
        expectedRevision,
      } as PreparationCommand);
      if (saved && closeEditor) setEditor(null);
      return saved;
    } catch (failure) {
      setLocalError(message(failure));
      return false;
    } finally {
      setSaving(false);
    }
  };
  const close = () => {
    setEditor(null);
    setLocalError(null);
  };
  const selectedFixture =
    selectedEvent?.kind === "match"
      ? state.fixtures.find((item) => item.id === selectedEvent.id)
      : undefined;
  const selectedTraining =
    selectedEvent?.kind === "training"
      ? state.training.find((item) => item.id === selectedEvent.id)
      : undefined;
  const newFixture = (): FixtureDraft => ({
    id: createFixtureId?.() ?? randomUUID(),
    seasonId: season.id,
    opponent: "",
    playedDate: nextDate(state),
    kickoff: "10:00",
    arrival: "09:30",
    venue: "",
    homeAway: "home",
    format: state.team.defaultPitchPlaces,
    plannedHalfDurationMs: state.team.defaultHalfDurationMs,
  });
  const newTraining = (): TrainingDraft => ({
    id: randomUUID(),
    seasonId: season.id,
    date: nextDate(state),
    time: "18:00",
    venue: "",
    recurrenceGroupId: null,
    expectedProfileIds: players.map((profile) => profile.id),
  });
  const { wide } = useWorkspaceLayout();
  const hasScheduleDetail = Boolean(
    editor || selectedFixture || selectedTraining,
  );
  const scheduleList = (
    <View style={s.stack} testID="preparation-schedule-list">
      {(editor || anyDirty) && (
        <Text style={s.small}>
          Finish or close this draft before choosing another event.
        </Text>
      )}
      <Text style={s.muted}>
        Matches and training, with replies and attendance kept separate.
      </Text>
      {tab === "training" && (
        <Button
          label="Create weekly training series"
          testID="training-series-create"
          variant="secondary"
          disabled={disabled || Boolean(editor) || anyDirty}
          onPress={() =>
            setEditor({
              type: "training_series",
              value: newTraining(),
              mode: "create",
            })
          }
        />
      )}

      <CalendarExportPanel
        events={calendarEventsFromSchedule(state, season.id, observedAt)}
        busy={disabled}
        onExport={
          onExportCalendar ??
          ((selectedKeys) =>
            exportLocalPreparationCalendar(
              state,
              season.id,
              storage,
              selectedKeys,
            ))
        }
      />
      <Choice
        label="Schedule period"
        value={period}
        options={[
          { value: "upcoming", label: "Upcoming" },
          { value: "past", label: "Past" },
        ]}
        onChange={setPeriod}
      />
      <Text style={s.small}>
        Dates use Europe/London. Today stays Upcoming; a missing time is never
        treated as midnight. Undated events stay separate.
      </Text>
      <Choice
        label="Event type"
        value={tab}
        options={[
          { value: "matches", label: "Matches" },
          { value: "training", label: "Training" },
        ]}
        onChange={setTab}
      />
      <Button
        label={tab === "matches" ? "Create fixture" : "Add training occurrence"}
        icon="calendar"
        disabled={disabled || Boolean(editor) || anyDirty}
        onPress={() =>
          setEditor(
            tab === "matches"
              ? { type: "fixture", value: newFixture() }
              : { type: "training", value: newTraining() },
          )
        }
        testID="preparation-create-event"
      />
      {scheduleGroups.map((group) => (
        <View key={group.date ?? "undated"} style={s.stack}>
          <Text accessibilityRole="header" style={s.section}>
            {group.date ? dateLabel(group.date) : "Date not recorded"}
          </Text>
          {group.events.map((event) =>
            "opponent" in event ? (
              <Pressable
                key={event.id}
                accessibilityRole="button"
                accessibilityState={{
                  disabled: disabled || Boolean(editor) || anyDirty,
                }}
                disabled={disabled || Boolean(editor) || anyDirty}
                accessibilityLabel={`Open fixture ${event.opponent}, ${dateLabel(event.playedDate)}`}
                onPress={() =>
                  setSelectedEvent({ kind: "match", id: event.id })
                }
              >
                <Card>
                  <View style={s.between}>
                    <Text style={s.label}>
                      {event.kickoff || "Time not recorded"}
                    </Text>
                    <Pill
                      tone={event.status === "scheduled" ? "brand" : "warning"}
                    >
                      {fixtureScheduleStatus(
                        event,
                        completedFixtureIds,
                        todayInLondon(),
                      )}
                    </Pill>
                  </View>
                  <Text style={s.section}>
                    {state.team.name} vs {event.opponent}
                  </Text>
                  <Text style={s.muted}>
                    {event.homeAway === "home" ? "Home" : "Away"} ·{" "}
                    {event.format}-a-side · 2 ×{" "}
                    {event.plannedHalfDurationMs / 60_000} min
                  </Text>
                  <View style={s.between}>
                    <Text style={s.small}>
                      {event.selectedProfileIds.length} selected ·{" "}
                      {
                        Object.values(event.responses).filter(
                          (response) => response === "available",
                        ).length
                      }{" "}
                      available replies
                    </Text>
                    <Icon name="chevron" size={20} />
                  </View>
                </Card>
              </Pressable>
            ) : (
              <Pressable
                key={event.id}
                accessibilityRole="button"
                accessibilityState={{
                  disabled: disabled || Boolean(editor) || anyDirty,
                }}
                disabled={disabled || Boolean(editor) || anyDirty}
                accessibilityLabel={`Open training ${dateLabel(event.date)}`}
                onPress={() =>
                  setSelectedEvent({ kind: "training", id: event.id })
                }
              >
                <Card>
                  <View style={s.between}>
                    <Text style={s.label}>
                      {event.time || "Time not recorded"}
                    </Text>
                    <Pill
                      tone={event.status === "cancelled" ? "warning" : "brand"}
                    >
                      {event.status}
                    </Pill>
                  </View>
                  <Text style={s.section}>Team training</Text>
                  <Text style={s.muted}>
                    {event.venue || "Location not recorded"}
                  </Text>
                  <Text style={s.small}>
                    {event.expectedProfileIds.length} expected ·{" "}
                    {
                      Object.values(event.attendance).filter(
                        (attendance) => attendance === "present",
                      ).length
                    }{" "}
                    recorded present
                  </Text>
                </Card>
              </Pressable>
            ),
          )}
        </View>
      ))}
      {scheduleGroups.length === 0 && (
        <Notice tone="info">
          No {period} {tab === "matches" ? "fixtures" : "training occurrences"}{" "}
          in this season. Choose the other period or add an event above.
        </Notice>
      )}
    </View>
  );
  const heading = editor
    ? "Edit preparation"
    : selectedEvent
      ? "Event details"
      : view === "settings"
        ? "Team settings"
        : view === "team"
          ? "Your team"
          : "Schedule";

  return (
    <View style={s.stack}>
      <Text style={s.eyebrow}>
        {state.club.name.toUpperCase()} · {state.team.name.toUpperCase()}{" "}
        {state.team.ageGroup} · {formatUkSeasonLabel(season.label)}
      </Text>
      <View style={s.between}>
        <Text accessibilityRole="header" style={s.title}>
          {heading}
        </Text>
        <Badge choice={effectiveLogo(state)} label={state.team.name} />
      </View>
      {(localError || error) && (
        <Notice tone="error">{localError || error}</Notice>
      )}
      <WorkspaceColumns ratio={0.65} testID="preparation-workspace-panels">
        {view === "schedule" && (
          <View
            style={[
              s.scheduleRail,
              !wide && hasScheduleDetail && s.hiddenPanel,
            ]}
          >
            {scheduleList}
          </View>
        )}
        <View
          style={[
            s.stack,
            s.detailPanel,
            view === "schedule" && !wide && !hasScheduleDetail && s.hiddenPanel,
          ]}
        >
          {editor ? (
            <>
              {editorSourceChanged && (
                <>
                  <Notice tone="warning">
                    Saved preparation changed while this form was open. Your
                    draft is still here, but saving is blocked to protect newer
                    changes. Copy any values you want to keep, then discard this
                    draft and reopen the form to edit the latest saved values.
                  </Notice>
                  <Button
                    label="Discard draft and close"
                    variant="secondary"
                    disabled={disabled}
                    onPress={close}
                    testID="preparation-discard-stale-draft"
                  />
                </>
              )}
              {editor.type === "profile" && (
                <ProfileForm
                  onDraftChange={setEditorDirty}
                  state={state}
                  profile={editor.value}
                  disabled={formDisabled}
                  onSubmit={(profile) =>
                    commit({ type: "profile.saved", profile }, true)
                  }
                  onClose={close}
                />
              )}
              {editor.type === "fixture" && (
                <FixtureForm
                  onDraftChange={setEditorDirty}
                  fixture={editor.value}
                  disabled={formDisabled}
                  onSubmit={(fixture) =>
                    commit({ type: "fixture.saved", fixture }, true)
                  }
                  onClose={close}
                />
              )}
              {editor.type === "training" && (
                <TrainingForm
                  onDraftChange={setEditorDirty}
                  training={editor.value}
                  players={retainedPreparationPlayers(
                    state,
                    editor.value.seasonId,
                    editor.value.expectedProfileIds,
                  )}
                  disabled={formDisabled}
                  onSubmit={(training) =>
                    commit({ type: "training.saved", training }, true)
                  }
                  onClose={close}
                />
              )}
              {editor.type === "training_series" && (
                <TrainingSeriesEditor
                  onDraftChange={setEditorDirty}
                  state={state}
                  training={editor.value}
                  mode={editor.mode}
                  disabled={disabled}
                  sourceChanged={editorSourceChanged}
                  onSubmit={(command) => commit(command, true, command)}
                  onClose={close}
                />
              )}
              {editor.type === "formation" && (
                <FormationForm
                  onDraftChange={setEditorDirty}
                  state={state}
                  formation={editor.value}
                  disabled={formDisabled}
                  onSubmit={(formation) =>
                    commit({ type: "formation.saved", formation }, true)
                  }
                  onClose={close}
                />
              )}
              {editor.type === "positions" && (
                <PositionCatalogueForm
                  onDraftChange={setEditorDirty}
                  state={state}
                  disabled={formDisabled}
                  onSave={(position) =>
                    commit({ type: "position.saved", position }, true)
                  }
                  onArchive={(code) =>
                    commit({ type: "position.archived", code }, true)
                  }
                  onClose={close}
                />
              )}
              {editor.type === "club" && (
                <ClubForm
                  onDraftChange={setEditorDirty}
                  state={state}
                  disabled={formDisabled}
                  onSubmit={(name, logo) =>
                    commit({ type: "club.updated", name, logo }, true)
                  }
                  onClose={close}
                />
              )}
              {editor.type === "team" && (
                <TeamForm
                  onDraftChange={setEditorDirty}
                  state={state}
                  disabled={formDisabled}
                  allowPresetLogo={storage !== "service"}
                  onSubmit={(payload) => commit(payload, true)}
                  onClose={close}
                />
              )}
              {editor.type === "rollover" && (
                <RolloverForm
                  onDraftChange={setEditorDirty}
                  state={state}
                  disabled={formDisabled}
                  onSubmit={(payload) => commit(payload, true)}
                  onClose={close}
                />
              )}
            </>
          ) : selectedFixture ? (
            <>
              <Button
                label="Back to schedule"
                icon="left"
                variant="quiet"
                disabled={disabled || anyDirty}
                onPress={() => setSelectedEvent(null)}
              />
              <FixtureDetail
                onDraftChange={setFixtureDirty}
                scheduledGameManagement={renderScheduledGameManagement?.(
                  selectedFixture.id,
                  setScheduledDirty,
                )}
                fixture={selectedFixture}
                state={state}
                disabled={disabled}
                completed={completedFixtureIds.has(selectedFixture.id)}
                accepted={acceptedFixtureIds.has(selectedFixture.id)}
                canLookUpSavedMatch={storage === "service"}
                statusLabel={fixtureScheduleStatus(
                  selectedFixture,
                  completedFixtureIds,
                  todayInLondon(),
                )}
                onCommand={commit}
                onEdit={() =>
                  setEditor({ type: "fixture", value: selectedFixture })
                }
                onOpenMatch={onOpenMatch}
                onOpenReport={onOpenReport}
              />
            </>
          ) : selectedTraining ? (
            <>
              <Button
                label="Back to schedule"
                icon="left"
                variant="quiet"
                disabled={disabled || anyDirty}
                onPress={() => setSelectedEvent(null)}
              />
              <TrainingDetail
                training={selectedTraining}
                players={retainedPreparationPlayers(
                  state,
                  selectedTraining.seasonId,
                  selectedTraining.expectedProfileIds,
                )}
                disabled={disabled}
                onCommand={commit}
                onEditSeries={
                  selectedTraining.recurrenceGroupId
                    ? () =>
                        setEditor({
                          type: "training_series",
                          value: selectedTraining,
                          mode: "manage",
                        })
                    : undefined
                }
                onEdit={() =>
                  setEditor({ type: "training", value: selectedTraining })
                }
              />
            </>
          ) : view === "schedule" ? (
            <Notice>
              Choose a match or training session to see its details.
            </Notice>
          ) : view === "team" ? (
            <>
              <View style={s.between}>
                <Text style={s.muted}>{players.length} active players</Text>
                <Pill tone="muted">Season profiles</Pill>
              </View>
              <Text style={s.small}>
                Preferences guide future plans. Saved match profiles stay
                unchanged.
              </Text>
              <SavedLineups
                onDraftChange={setSetupsDirty}
                state={state}
                busy={disabled}
                onCommand={(command) => commit(command, false, command)}
              />
              <Button
                label={
                  squadTools
                    ? "Hide squad tools"
                    : "Squad tools and Excel import"
                }
                variant="quiet"
                disabled={disabled || rosterDirty}
                onPress={() => setSquadTools((value) => !value)}
                testID="squad-tools-toggle"
              />
              {squadTools && (
                <RosterImportPanel
                  onDraftChange={setRosterDirty}
                  state={state}
                  busy={disabled}
                  onProformaImport={(profiles) =>
                    commit({
                      type: "roster.proforma_imported",
                      profiles,
                      confirmChanges: true,
                    })
                  }
                  onImport={(profiles) =>
                    commit({
                      type: "roster.imported",
                      profiles,
                      confirmNewPlayers: true,
                    })
                  }
                />
              )}
              <Button
                label={
                  storage === "service"
                    ? "Add player profile"
                    : "Add player profile"
                }
                icon="users"
                disabled={disabled}
                onPress={() => {
                  const playerId = randomUUID();
                  setEditor({
                    type: "profile",
                    value: {
                      id: `${playerId}:${season.id}`,
                      playerId,
                      seasonId: season.id,
                      displayName: `Player ${players.length + 1}`,
                      initials: "NP",
                      shirtNumber: null,
                      foot: "not_recorded",
                      preferences: [
                        ...new Set(
                          [
                            "CM",
                            "CB",
                            "ST",
                            ...activePositionCodes(state),
                          ].filter((code) =>
                            activePositionCodes(state).includes(code),
                          ),
                        ),
                      ].slice(0, 3),
                      eligiblePositions: [
                        ...new Set(
                          [
                            "CM",
                            "CB",
                            "ST",
                            ...activePositionCodes(state),
                          ].filter((code) =>
                            activePositionCodes(state).includes(code),
                          ),
                        ),
                      ].slice(0, 3),
                      active: true,
                    },
                  });
                }}
              />
              <View
                style={[s.rosterGrid, wide && s.rosterGridWide]}
                testID="preparation-roster-grid"
              >
                {players.map((profile) => (
                  <Card
                    key={profile.id}
                    style={[
                      s.compactCard,
                      wide ? s.rosterCardWide : s.rosterCardPhone,
                    ]}
                  >
                    <View style={s.row}>
                      <View
                        style={[
                          s.shirt,
                          goalkeeperChoice(profile) > 0 && s.keeper,
                        ]}
                      >
                        <Text style={s.shirtText}>
                          {profile.shirtNumber ?? profile.initials}
                        </Text>
                      </View>
                      <View style={s.flex}>
                        <Text style={s.label}>{profile.displayName}</Text>
                        <Text style={s.small}>
                          {profile.preferences.join(" → ")}
                          {goalkeeperChoice(profile) > 0
                            ? " · Eligible keeper"
                            : ""}
                        </Text>
                      </View>
                    </View>
                    <View style={s.actionPair}>
                      <Button
                        label="Edit"
                        accessibilityLabel={`Edit ${profile.displayName}`}
                        icon="settings"
                        variant="secondary"
                        style={s.pairedAction}
                        disabled={disabled}
                        onPress={() =>
                          setEditor({ type: "profile", value: profile })
                        }
                      />
                      <Button
                        label="Archive"
                        accessibilityLabel={`Archive ${profile.displayName}`}
                        variant="quiet"
                        style={s.pairedAction}
                        disabled={disabled}
                        onPress={() => {
                          void commit({
                            type: "profile.archived",
                            profileId: profile.id,
                          });
                        }}
                      />
                    </View>
                    {squadTools && onPrepareChildActivation && (
                      <Button
                        label={`Prepare sign-in activation for ${profile.displayName}`}
                        variant="secondary"
                        disabled={disabled}
                        onPress={() =>
                          onPrepareChildActivation(profile.playerId)
                        }
                      />
                    )}
                  </Card>
                ))}
              </View>
              <Text style={s.small}>
                A player profile does not create a sign-in account. Account
                activation is managed separately.
              </Text>
              {state.profiles.some(
                (profile) => profile.seasonId === season.id && !profile.active,
              ) && (
                <Card>
                  <Text style={s.section}>Archived this season</Text>
                  {state.profiles
                    .filter(
                      (profile) =>
                        profile.seasonId === season.id && !profile.active,
                    )
                    .map((profile) => (
                      <View key={profile.id} style={s.stack}>
                        <Text style={s.muted}>
                          {profile.displayName} · retained in saved history
                        </Text>
                        <Button
                          label={`Restore ${profile.displayName}`}
                          variant="secondary"
                          disabled={disabled}
                          onPress={() => {
                            void commit({
                              type: "profile.saved",
                              profile: { ...profile, active: true },
                            });
                          }}
                        />
                      </View>
                    ))}
                </Card>
              )}
            </>
          ) : (
            <>
              {storage === "service" && brandingPanel}
              <TeamLeagueEditor
                value={state.team.league}
                disabled={disabled}
                onDraftChange={setLeagueDirty}
                onSave={(league) =>
                  commit({ type: "team.league_updated", league })
                }
              />
              <FormationDesigner
                state={state}
                onChange={onChange}
                busy={disabled}
                error={error}
                onDraftChange={setFormationDirty}
              />
              <Card>
                <View style={s.between}>
                  <View style={s.flex}>
                    <Text style={s.section}>{state.club.name}</Text>
                    <Text style={s.small}>Club identity</Text>
                  </View>
                  {storage !== "service" && (
                    <Badge choice={state.club.logo ?? "roundel"} label="Club" />
                  )}
                </View>
                {storage !== "service" && (
                  <Button
                    label="Edit club and badge"
                    icon="settings"
                    variant="secondary"
                    disabled={disabled}
                    onPress={() => setEditor({ type: "club" })}
                  />
                )}
              </Card>
              <Card>
                <View style={s.between}>
                  <View style={s.flex}>
                    <Text style={s.section}>
                      {state.team.name} {state.team.ageGroup}
                    </Text>
                    <Text style={s.small}>
                      {storage === "service"
                        ? "Uploaded logos are managed above"
                        : state.team.logo
                          ? "Team badge override"
                          : "Inherits the club badge"}
                    </Text>
                  </View>
                  {storage !== "service" && (
                    <Badge choice={effectiveLogo(state)} label="Team" />
                  )}
                </View>
                <Text style={s.muted}>
                  {state.team.defaultPitchPlaces}-a-side · 2 ×{" "}
                  {state.team.defaultHalfDurationMs / 60_000} minutes by default
                </Text>
                <Button
                  label="Edit team defaults"
                  icon="settings"
                  variant="secondary"
                  disabled={disabled}
                  onPress={() => setEditor({ type: "team" })}
                />
              </Card>
              <Card>
                <Text style={s.section}>Team positions</Text>
                <Text style={s.small}>
                  {activePositionCodes(state).join(" · ")}
                </Text>
                <Button
                  label="Manage team positions"
                  variant="secondary"
                  disabled={disabled}
                  onPress={() => setEditor({ type: "positions" })}
                  testID="team-positions-manage"
                />
              </Card>
              <Text style={s.section}>Reusable formations</Text>
              {[...state.formations]
                .sort((a, b) => a.format - b.format)
                .map((formation) => (
                  <Card key={formation.id}>
                    <View style={s.between}>
                      <Text style={s.section}>{formation.name}</Text>
                      <Pill tone="muted">v{formation.version}</Pill>
                    </View>
                    <Text style={s.small}>
                      {formation.slots.map((slot) => slot.label).join(" · ")}
                    </Text>
                    <Button
                      label={`Edit ${formation.name}`}
                      variant="secondary"
                      onPress={() =>
                        setEditor({ type: "formation", value: formation })
                      }
                    />
                  </Card>
                ))}
              <Button
                label="Create formation template"
                icon="shield"
                onPress={() => {
                  const template = defaultFormation(
                    state.team.defaultPitchPlaces,
                  );
                  setEditor({
                    type: "formation",
                    value: {
                      ...template,
                      id: randomUUID(),
                      name: "Custom formation",
                    },
                  });
                }}
              />
              <Text style={s.section}>Seasons</Text>
              {state.seasons.map((item) => (
                <Card key={item.id}>
                  <View style={s.between}>
                    <Text style={s.section}>
                      {formatUkSeasonLabel(item.label)}
                    </Text>
                    <Pill tone={item.id === season.id ? "brand" : "muted"}>
                      {item.id === season.id ? "Current" : "Retained"}
                    </Pill>
                  </View>
                  <Text style={s.small}>
                    {dateLabel(item.startDate)} – {dateLabel(item.endDate)}
                  </Text>
                </Card>
              ))}
              <Button
                label="Prepare the next season"
                icon="calendar"
                variant="secondary"
                disabled={disabled}
                onPress={() =>
                  onPrepareRollover
                    ? onPrepareRollover()
                    : setEditor({ type: "rollover" })
                }
              />
              <Notice tone="warning">
                Rollover preserves past team-season records. Spectator access
                needs a new explicit season grant.
              </Notice>
            </>
          )}
        </View>
      </WorkspaceColumns>
      <Text style={s.footnote}>
        {storage === "service"
          ? "Service preparation · Europe/London · saved by the connected service."
          : "Local preparation · Europe/London · changes are saved through the application journal."}
      </Text>
    </View>
  );
}

function Field({
  label,
  value,
  onChange,
  numeric = false,
  placeholder,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  numeric?: boolean;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <View style={s.field}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        editable={!disabled}
        onChangeText={onChange}
        keyboardType={numeric ? "decimal-pad" : "default"}
        autoCapitalize="none"
        placeholder={placeholder}
        style={s.input}
      />
    </View>
  );
}
function Choice<Value extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  compact = false,
  visibleLabel,
}: {
  label: string;
  value: Value;
  options: { value: Value; label: string }[];
  onChange: (value: Value) => void;
  disabled?: boolean;
  compact?: boolean;
  visibleLabel?: string;
}) {
  return (
    <View style={[s.field, compact && s.compactChoiceField]}>
      <Text style={s.label}>{visibleLabel ?? label}</Text>
      <View style={[s.choices, compact && s.compactChoices]}>
        {options.map((option) => (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={`${label}: ${option.label}`}
            accessibilityState={{ checked: value === option.value, disabled }}
            aria-checked={value === option.value}
            aria-disabled={disabled}
            disabled={disabled}
            onPress={() => onChange(option.value)}
            {...(Platform.OS === "web"
              ? {
                  onKeyDown: (event: KeyDownEvent) => {
                    // RN Web activates radio roles with Enter, but leaves Space to scrolling.
                    const { key, repeat } = event.nativeEvent;
                    if (key !== " " && key !== "Spacebar") return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (!disabled && !repeat) onChange(option.value);
                  },
                }
              : {})}
            style={[
              s.choice,
              compact && s.compactChoice,
              value === option.value && s.choiceSelected,
            ]}
          >
            <Text
              style={[
                s.choiceText,
                compact && s.compactChoiceText,
                value === option.value && s.choiceSelectedText,
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
function Toggle({
  label,
  value,
  onChange,
  disabled = false,
  visibleLabel,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  visibleLabel?: string;
}) {
  return (
    <View style={[s.row, { minHeight: 48 }]}>
      <Switch
        hitSlop={8}
        accessibilityLabel={label}
        value={value}
        onValueChange={onChange}
        disabled={disabled}
      />
      <Text style={[s.body, s.flex]}>{visibleLabel ?? label}</Text>
    </View>
  );
}
function Badge({ choice, label }: { choice: LogoChoice; label: string }) {
  return (
    <View
      accessibilityLabel={`${label}: original ${choice} badge`}
      style={[s.badge, choice === "shield" && { borderRadius: 10 }]}
    >
      {choice === "roundel" ? (
        <Text style={s.badgeText}>RR</Text>
      ) : (
        <Icon
          name={choice === "ball" ? "ball" : "shield"}
          color={colors.brand}
          size={27}
        />
      )}
    </View>
  );
}
function LogoPicker({
  value,
  onChange,
  inherit = false,
  disabled = false,
}: {
  value: LogoChoice | null;
  onChange: (value: LogoChoice | null) => void;
  inherit?: boolean;
  disabled?: boolean;
}) {
  return (
    <Choice
      label="Badge"
      disabled={disabled}
      value={value ?? "none"}
      options={[
        {
          value: "none",
          label: inherit ? "Use club badge" : "Neutral fallback",
        },
        { value: "roundel", label: "Roundel" },
        { value: "shield", label: "Shield" },
        { value: "ball", label: "Football" },
      ]}
      onChange={(choice) =>
        onChange(choice === "none" ? null : (choice as LogoChoice))
      }
    />
  );
}
function FormActions({
  label = "Save changes",
  disabled,
  saveDisabled = false,
  onSave,
  onClose,
}: {
  label?: string;
  disabled: boolean;
  saveDisabled?: boolean;
  onSave: () => void;
  onClose: () => void;
}) {
  const { wide } = useWorkspaceLayout();
  return (
    <View style={[s.compactStack, wide && s.formActionsWide]}>
      <Button
        label={label}
        icon="check"
        disabled={disabled || saveDisabled}
        onPress={onSave}
        testID="preparation-save"
      />
      <Button
        label="Close without saving"
        variant="quiet"
        disabled={disabled}
        onPress={onClose}
      />
    </View>
  );
}
function ClubForm({
  state,
  disabled,
  onSubmit,
  onClose,
  onDraftChange,
}: {
  state: PreparationState;
  disabled: boolean;
  onSubmit: (name: string, logo: LogoChoice | null) => Promise<boolean>;
  onClose: () => void;
  onDraftChange?: (dirty: boolean) => void;
}) {
  const [name, setName] = useState(state.club.name);
  const [logo, setLogo] = useState(state.club.logo);
  useUnsavedDraft({ name, logo }, onDraftChange);
  return (
    <>
      <Field
        label="Club name"
        value={name}
        disabled={disabled}
        onChange={setName}
      />
      <LogoPicker value={logo} disabled={disabled} onChange={setLogo} />
      <Notice tone="info">
        Team badge overrides are preserved when the club badge changes.
      </Notice>
      <FormActions
        disabled={disabled}
        onSave={() => {
          void onSubmit(name, logo);
        }}
        onClose={onClose}
      />
    </>
  );
}
function TeamForm({
  state,
  disabled,
  allowPresetLogo = true,
  onSubmit,
  onClose,
  onDraftChange,
}: {
  state: PreparationState;
  disabled: boolean;
  allowPresetLogo?: boolean;
  onSubmit: (
    payload: Extract<Payload, { type: "team.updated" }>,
  ) => Promise<boolean>;
  onClose: () => void;
  onDraftChange?: (dirty: boolean) => void;
}) {
  const [name, setName] = useState(state.team.name);
  const [ageGroup, setAgeGroup] = useState(state.team.ageGroup);
  const [logo, setLogo] = useState(state.team.logo);
  const [format, setFormat] = useState(String(state.team.defaultPitchPlaces));
  const [minutes, setMinutes] = useState(
    String(state.team.defaultHalfDurationMs / 60_000),
  );
  useUnsavedDraft({ name, ageGroup, logo, format, minutes }, onDraftChange);
  return (
    <>
      <WorkspaceColumns testID="team-default-editor-columns">
        <View style={s.stack}>
          <Field
            label="Team name"
            value={name}
            disabled={disabled}
            onChange={setName}
          />
          <Field
            label="Age group"
            value={ageGroup}
            disabled={disabled}
            onChange={setAgeGroup}
          />
          {allowPresetLogo && (
            <LogoPicker
              value={logo}
              disabled={disabled}
              onChange={setLogo}
              inherit
            />
          )}
        </View>
        <View style={s.stack}>
          <Choice
            label="Default pitch places"
            disabled={disabled}
            value={format}
            options={Array.from({ length: 7 }, (_, i) => ({
              value: String(i + 5),
              label: String(i + 5),
            }))}
            onChange={setFormat}
          />
          <Field
            label="Default minutes per half"
            disabled={disabled}
            numeric
            value={minutes}
            onChange={setMinutes}
          />
        </View>
      </WorkspaceColumns>
      <Notice tone="info">
        Defaults apply to new fixtures. Existing match durations and saved
        formations stay unchanged.
      </Notice>
      <FormActions
        disabled={disabled}
        onSave={() => {
          void onSubmit({
            type: "team.updated",
            name,
            ageGroup,
            logo,
            defaultPitchPlaces: Number(format),
            defaultHalfDurationMs: Number(minutes) * 60_000,
          });
        }}
        onClose={onClose}
      />
    </>
  );
}
function RolloverForm({
  state,
  disabled,
  onSubmit,
  onClose,
  onDraftChange,
}: {
  state: PreparationState;
  disabled: boolean;
  onSubmit: (
    payload: Extract<Payload, { type: "season.rolled_over" }>,
  ) => Promise<boolean>;
  onClose: () => void;
  onDraftChange?: (dirty: boolean) => void;
}) {
  const season = state.seasons.find(
    (item) => item.id === state.activeSeasonId,
  )!;
  const year = season.startYear + 1;
  const [copyPlayers, setCopyPlayers] = useState(true);
  const [renewal, setRenewal] = useState(false);
  useUnsavedDraft({ copyPlayers, renewal }, onDraftChange);
  return (
    <>
      <Card>
        <Text style={s.section}>
          1 September {year} – 31 August {year + 1}
        </Text>
        <Text style={s.muted}>
          Create season {year}/{String(year + 1).slice(-2)}
        </Text>
      </Card>
      <Toggle
        label="Copy active player profiles into the new season"
        disabled={disabled}
        value={copyPlayers}
        onChange={setCopyPlayers}
      />
      <Toggle
        label="I understand spectators need explicit access for the new season"
        disabled={disabled}
        value={renewal}
        onChange={setRenewal}
      />
      <Notice tone="warning">
        Old profiles, fixtures, attendance and match snapshots are retained. No
        match results, attendance or spectator grants are copied.
      </Notice>
      <FormActions
        label="Create next season"
        disabled={disabled}
        saveDisabled={!renewal}
        onSave={() => {
          if (renewal)
            void onSubmit({
              type: "season.rolled_over",
              idForSeason: `synthetic-season-${year}-${String(year + 1).slice(-2)}`,
              startYear: year,
              copyPlayers,
              confirmSpectatorRenewal: true,
            });
        }}
        onClose={onClose}
      />
    </>
  );
}
function PositionCatalogueForm({
  state,
  disabled,
  onSave,
  onArchive,
  onClose,
  onDraftChange,
}: {
  state: PreparationState;
  disabled: boolean;
  onSave: (position: TeamPosition) => Promise<boolean>;
  onArchive: (code: string) => Promise<boolean>;
  onClose: () => void;
  onDraftChange?: (dirty: boolean) => void;
}) {
  const catalogue = positionCatalogueFor(state);
  const [draft, setDraft] = useState<TeamPosition>({
    code: "",
    label: "",
    active: true,
  });
  const [existing, setExisting] = useState(false);
  const [draftScope, setDraftScope] = useState("new");
  const dirty = useUnsavedDraft(draft, onDraftChange, draftScope);
  return (
    <View style={s.compactStack} testID="team-position-catalogue">
      <Text style={s.section}>Team positions</Text>
      <Text style={s.small}>
        Use two-letter codes in profiles, formations and future lineups.
        Inactive positions remain in saved history. Goalkeeper always stays
        active.
      </Text>
      <Choice
        label="Edit a team position"
        value={draft.code}
        disabled={disabled || dirty}
        options={catalogue.map((position) => ({
          value: position.code,
          label: `${position.code}${position.active ? "" : " · inactive"}`,
        }))}
        onChange={(code) => {
          setDraft({
            ...catalogue.find((position) => position.code === code)!,
          });
          setExisting(true);
          setDraftScope(`position:${code}`);
        }}
      />
      <Button
        label="Add a position"
        variant="secondary"
        disabled={disabled || dirty}
        onPress={() => {
          setDraft({ code: "", label: "", active: true });
          setExisting(false);
          setDraftScope("new");
        }}
      />
      {dirty && (
        <Text style={s.small}>
          Save or close this draft before choosing another team position.
        </Text>
      )}
      <Field
        label="Two-letter position code"
        value={draft.code}
        disabled={disabled || existing}
        onChange={(code) =>
          setDraft((value) => ({ ...value, code: code.toUpperCase() }))
        }
      />
      <Field
        label="Position name"
        value={draft.label}
        disabled={disabled}
        onChange={(label) => setDraft((value) => ({ ...value, label }))}
      />
      <Toggle
        label="Active for future preparation"
        value={draft.active}
        disabled={disabled || draft.code === "GK"}
        onChange={(active) => setDraft((value) => ({ ...value, active }))}
      />
      <FormActions
        label={existing ? "Save position" : "Add team position"}
        disabled={disabled}
        saveDisabled={
          !validPositionCode(draft.code) ||
          !draft.label.trim() ||
          (!existing &&
            catalogue.some((position) => position.code === draft.code))
        }
        onSave={() => {
          void onSave(draft);
        }}
        onClose={onClose}
      />
      {existing && draft.code !== "GK" && draft.active && (
        <Button
          label={`Make ${draft.code} inactive`}
          variant="quiet"
          disabled={disabled}
          onPress={() => {
            void onArchive(draft.code);
          }}
        />
      )}
    </View>
  );
}

function ProfileForm({
  state,
  profile,
  disabled,
  onSubmit,
  onClose,
  onDraftChange,
}: {
  state: PreparationState;
  profile: PlayerProfile;
  disabled: boolean;
  onSubmit: (profile: PlayerProfile) => Promise<boolean>;
  onClose: () => void;
  onDraftChange?: (dirty: boolean) => void;
}) {
  const { wide } = useWorkspaceLayout();
  const [draft, setDraft] = useState({
    ...profile,
    preferences: [...profile.preferences],
    eligiblePositions: [...profile.eligiblePositions],
  });
  const [shirt, setShirt] = useState(
    profile.shirtNumber === null ? "" : String(profile.shirtNumber),
  );
  const [section, setSection] = useState<"details" | "positions">("details");
  useUnsavedDraft({ draft, shirt }, onDraftChange);
  const [rank, setRank] = useState("0");
  const catalogue = positionCatalogueFor(state),
    active = activePositionCodes(state);
  const change = <Key extends keyof PlayerProfile>(
    key: Key,
    value: PlayerProfile[Key],
  ) => {
    setSection(
      key === "preferences" || key === "eligiblePositions"
        ? "positions"
        : "details",
    );
    setDraft((previous) => ({ ...previous, [key]: value }));
  };
  return (
    <View style={s.compactStack} testID="player-profile-editor">
      <View style={wide ? s.hiddenPanel : undefined}>
        <Choice
          label="Player editor section"
          value={section}
          options={[
            { value: "details", label: "Details" },
            { value: "positions", label: "Positions" },
          ]}
          onChange={setSection}
          disabled={disabled}
        />
      </View>
      <WorkspaceColumns testID="player-editor-columns">
        <View
          style={[
            s.compactStack,
            !wide && section !== "details" && s.hiddenPanel,
          ]}
        >
          <Text style={[s.section, !wide && s.hiddenPanel]}>
            Player details
          </Text>
          <Field
            label="Player display name"
            value={draft.displayName}
            disabled={disabled}
            onChange={(value) => change("displayName", value)}
          />
          <View style={s.formColumns}>
            <View style={s.formColumn}>
              <Field
                label="Pitch initials or label (1–2 characters)"
                value={draft.initials}
                disabled={disabled}
                onChange={(value) => change("initials", value)}
              />
            </View>
            <View style={s.formColumn}>
              <Field
                label="Shirt number (blank if not recorded)"
                numeric
                value={shirt}
                disabled={disabled}
                onChange={(value) => {
                  setSection("details");
                  setShirt(value);
                }}
              />
            </View>
          </View>
          <Field
            label="FA player ID (optional)"
            numeric
            value={draft.faPlayerId ?? ""}
            disabled={disabled}
            onChange={(value) => change("faPlayerId", value.trim() || null)}
          />
          <Choice
            label="Preferred foot"
            value={draft.foot}
            options={[
              { value: "not_recorded", label: "Not recorded" },
              { value: "left", label: "Left" },
              { value: "right", label: "Right" },
              { value: "both", label: "Both" },
            ]}
            onChange={(value) => change("foot", value)}
            disabled={disabled}
          />
        </View>
        <View
          style={[
            s.compactStack,
            !wide && section !== "positions" && s.hiddenPanel,
          ]}
        >
          <Text style={[s.section, !wide && s.hiddenPanel]}>
            Positions and eligibility
          </Text>
          <Choice
            label="Editing ranked preference"
            value={rank}
            options={draft.preferences.map((position, index) => ({
              value: String(index),
              label: `${index + 1} · ${position}`,
            }))}
            onChange={(value) => {
              setSection("positions");
              setRank(value);
            }}
            disabled={disabled}
          />
          <Choice
            label={`Position preference ${Number(rank) + 1}`}
            value={draft.preferences[Number(rank)]}
            options={catalogue
              .filter(
                (position) =>
                  position.active ||
                  position.code === draft.preferences[Number(rank)],
              )
              .map((position) => ({
                value: position.code,
                label: `${position.code}${position.active ? "" : " · inactive"}`,
              }))}
            disabled={disabled}
            onChange={(value) => {
              const preferences = [...draft.preferences],
                other = preferences.indexOf(value);
              if (other >= 0) preferences[other] = preferences[Number(rank)];
              preferences[Number(rank)] = value;
              change("preferences", preferences);
            }}
          />
          <View style={s.between}>
            <Text style={s.label}>Manager-approved eligibility</Text>
            <Button
              label="Select all"
              accessibilityLabel="Select all active eligible positions"
              testID="profile-eligibility-select-all"
              variant="quiet"
              disabled={disabled}
              onPress={() =>
                change("eligiblePositions", [
                  ...new Set([...draft.eligiblePositions, ...active]),
                ])
              }
            />
          </View>
          <Text style={s.small}>
            Preferences do not grant eligibility. GK needs approved eligibility
            and a first or second preference.
          </Text>
          <View style={s.choices}>
            {catalogue
              .filter(
                (position) =>
                  position.active ||
                  draft.eligiblePositions.includes(position.code),
              )
              .map((position) => (
                <Pressable
                  key={position.code}
                  accessibilityRole="checkbox"
                  accessibilityLabel={`Eligible for ${position.code}`}
                  accessibilityState={{
                    checked: draft.eligiblePositions.includes(position.code),
                    disabled,
                  }}
                  aria-checked={draft.eligiblePositions.includes(position.code)}
                  disabled={disabled}
                  style={[
                    s.choice,
                    draft.eligiblePositions.includes(position.code) &&
                      s.choiceSelected,
                  ]}
                  onPress={() =>
                    change(
                      "eligiblePositions",
                      draft.eligiblePositions.includes(position.code)
                        ? draft.eligiblePositions.filter(
                            (value) => value !== position.code,
                          )
                        : [...draft.eligiblePositions, position.code],
                    )
                  }
                >
                  <Text
                    style={[
                      s.choiceText,
                      draft.eligiblePositions.includes(position.code) &&
                        s.choiceSelectedText,
                    ]}
                  >
                    {position.code}
                    {position.active ? "" : " · inactive"}
                  </Text>
                </Pressable>
              ))}
          </View>
        </View>
      </WorkspaceColumns>
      <Text style={s.small}>
        Changes apply to future preparation. Saved match profiles keep their
        original values.
      </Text>
      <FormActions
        disabled={disabled}
        onSave={() => {
          void onSubmit({
            ...draft,
            shirtNumber: shirt.trim() ? Number(shirt) : null,
          });
        }}
        onClose={onClose}
      />
    </View>
  );
}
function FixtureForm({
  fixture,
  disabled,
  onSubmit,
  onClose,
  onDraftChange,
}: {
  fixture: FixtureDraft;
  disabled: boolean;
  onSubmit: (fixture: FixtureDraft) => Promise<boolean>;
  onClose: () => void;
  onDraftChange?: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState({ ...fixture });
  const [minutes, setMinutes] = useState(
    String(fixture.plannedHalfDurationMs / 60_000),
  );
  useUnsavedDraft({ draft, minutes }, onDraftChange);
  const change = <Key extends keyof FixtureDraft>(
    key: Key,
    value: FixtureDraft[Key],
  ) => setDraft((previous) => ({ ...previous, [key]: value }));
  return (
    <>
      <WorkspaceColumns testID="fixture-editor-columns">
        <View style={s.stack}>
          <Field
            label="Opposition"
            disabled={disabled}
            value={draft.opponent}
            onChange={(value) => change("opponent", value)}
          />
          <Field
            label="Match date (YYYY-MM-DD)"
            disabled={disabled}
            value={draft.playedDate}
            onChange={(value) => change("playedDate", value)}
          />
          <Field
            label="Kick-off (HH:MM, blank if not recorded)"
            disabled={disabled}
            value={draft.kickoff ?? ""}
            onChange={(value) => change("kickoff", value.trim() || null)}
          />
          <Field
            label="Arrival (HH:MM, blank if not recorded)"
            disabled={disabled}
            value={draft.arrival ?? ""}
            onChange={(value) => change("arrival", value.trim() || null)}
          />
        </View>
        <View style={s.stack}>
          <Field
            label="Venue"
            disabled={disabled}
            value={draft.venue}
            onChange={(value) => change("venue", value)}
          />
          <Choice
            label="Home or away"
            disabled={disabled}
            value={draft.homeAway}
            options={[
              { value: "home", label: "Home" },
              { value: "away", label: "Away" },
            ]}
            onChange={(value) => change("homeAway", value)}
          />
          <Choice
            label="Pitch places"
            disabled={disabled}
            value={String(draft.format)}
            options={Array.from({ length: 7 }, (_, i) => ({
              value: String(i + 5),
              label: String(i + 5),
            }))}
            onChange={(value) => change("format", Number(value))}
          />
          <Field
            label="Minutes per half for this match"
            disabled={disabled}
            numeric
            value={minutes}
            onChange={setMinutes}
          />
        </View>
      </WorkspaceColumns>
      <Notice tone="info">
        Times use Europe/London. Duration changes apply to this fixture only.
        Rescheduling preserves its identity, replies and history.
      </Notice>
      <FormActions
        label="Save fixture"
        disabled={disabled}
        onSave={() => {
          void onSubmit({
            ...draft,
            plannedHalfDurationMs: Number(minutes) * 60_000,
          });
        }}
        onClose={onClose}
      />
    </>
  );
}
function TrainingForm({
  training,
  players,
  disabled,
  onSubmit,
  onClose,
  onDraftChange,
}: {
  training: TrainingDraft;
  players: PlayerProfile[];
  disabled: boolean;
  onSubmit: (training: TrainingDraft) => Promise<boolean>;
  onClose: () => void;
  onDraftChange?: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState({
    ...training,
    expectedProfileIds: [...training.expectedProfileIds],
  });
  useUnsavedDraft(draft, onDraftChange);
  return (
    <>
      <WorkspaceColumns testID="training-editor-columns">
        <View style={s.stack}>
          <Field
            label="Training date (YYYY-MM-DD)"
            disabled={disabled}
            value={draft.date}
            onChange={(date) => setDraft((previous) => ({ ...previous, date }))}
          />
          <Field
            label="Training time (HH:MM)"
            disabled={disabled}
            value={draft.time}
            onChange={(time) => setDraft((previous) => ({ ...previous, time }))}
          />
          <Field
            label="Training venue"
            disabled={disabled}
            value={draft.venue}
            onChange={(venue) =>
              setDraft((previous) => ({ ...previous, venue }))
            }
          />
        </View>
        <View style={s.stack}>
          <Text style={s.section}>Expected players</Text>
          {players.map((profile) =>
            profile.active ? (
              <Toggle
                key={profile.id}
                label={profile.displayName}
                value={draft.expectedProfileIds.includes(profile.id)}
                disabled={disabled}
                onChange={(selected) =>
                  setDraft((previous) => ({
                    ...previous,
                    expectedProfileIds: selected
                      ? [...previous.expectedProfileIds, profile.id]
                      : previous.expectedProfileIds.filter(
                          (id) => id !== profile.id,
                        ),
                  }))
                }
              />
            ) : (
              <Card key={profile.id}>
                <View style={s.between}>
                  <Text style={s.body}>{profile.displayName}</Text>
                  <Pill>Archived</Pill>
                </View>
                {draft.expectedProfileIds.includes(profile.id) ? (
                  <>
                    <Text style={s.small}>
                      Still expected in this saved occurrence. Remove this
                      archived player before saving future training changes.
                    </Text>
                    <Button
                      label={`Remove ${profile.displayName} from expected players`}
                      variant="secondary"
                      disabled={disabled}
                      onPress={() =>
                        setDraft((previous) => ({
                          ...previous,
                          expectedProfileIds:
                            previous.expectedProfileIds.filter(
                              (id) => id !== profile.id,
                            ),
                        }))
                      }
                    />
                  </>
                ) : (
                  <Text style={s.small}>
                    Removed from the draft for this occurrence. Past attendance
                    stays unchanged.
                  </Text>
                )}
              </Card>
            ),
          )}
          <Notice tone="info">
            This edits one occurrence. Other dates in the series remain
            unchanged.
          </Notice>
        </View>
      </WorkspaceColumns>
      <FormActions
        label="Save training occurrence"
        disabled={disabled}
        onSave={() => {
          void onSubmit(draft);
        }}
        onClose={onClose}
      />
    </>
  );
}
function FormationForm({
  state,
  formation,
  disabled,
  onSubmit,
  onClose,
  onDraftChange,
}: {
  state: PreparationState;
  formation: PreparationFormation;
  disabled: boolean;
  onSubmit: (
    formation: Omit<PreparationFormation, "version">,
  ) => Promise<boolean>;
  onClose: () => void;
  onDraftChange?: (dirty: boolean) => void;
}) {
  const { wide } = useWorkspaceLayout();
  const [draft, setDraft] = useState({
    ...formation,
    slots: formation.slots.map((slot) => ({ ...slot })),
  });
  const [advanced, setAdvanced] = useState(false);
  const [coordinates, setCoordinates] = useState(
    () =>
      Object.fromEntries(
        formation.slots.map((slot) => [
          slot.id,
          { x: String(slot.x), y: String(slot.y) },
        ]),
      ) as Record<string, { x: string; y: string }>,
  );
  useUnsavedDraft({ draft, coordinates }, onDraftChange);
  const validCoordinate = (value: string) =>
    value.trim() !== "" &&
    Number.isFinite(Number(value)) &&
    Number(value) >= 0 &&
    Number(value) <= 1;
  const coordinatesValid = draft.slots.every(
    (slot) =>
      coordinates[slot.id] &&
      validCoordinate(coordinates[slot.id].x) &&
      validCoordinate(coordinates[slot.id].y),
  );
  const previewSlots = draft.slots.map((slot) => {
    const point = coordinates[slot.id];
    return point && validCoordinate(point.x) && validCoordinate(point.y)
      ? { ...slot, x: Number(point.x), y: Number(point.y) }
      : slot;
  });
  const changeSlot = (
    id: string,
    changes: Partial<PreparationFormation["slots"][number]>,
  ) =>
    setDraft((previous) => ({
      ...previous,
      slots: previous.slots.map((slot) =>
        slot.id === id ? { ...slot, ...changes } : slot,
      ),
    }));
  return (
    <>
      <Field
        label="Formation name"
        disabled={disabled}
        value={draft.name}
        onChange={(name) => setDraft((previous) => ({ ...previous, name }))}
      />
      <Choice
        label="Formation pitch places"
        disabled={disabled}
        value={String(draft.format)}
        options={Array.from({ length: 7 }, (_, i) => ({
          value: String(i + 5),
          label: String(i + 5),
        }))}
        onChange={(value) => {
          const template = defaultFormation(Number(value));
          setCoordinates(
            Object.fromEntries(
              template.slots.map((slot) => [
                slot.id,
                { x: String(slot.x), y: String(slot.y) },
              ]),
            ),
          );
          setDraft((previous) => ({
            ...previous,
            format: template.format,
            slots: template.slots,
          }));
        }}
      />
      <FormationPositionEditor
        positionOrder={positionCatalogueFor(state).map(
          (position) => position.code,
        )}
        slots={previewSlots}
        name={draft.name}
        disabled={disabled}
        onMove={(slotId, point) => {
          changeSlot(slotId, point);
          setCoordinates((previous) => ({
            ...previous,
            [slotId]: { x: String(point.x), y: String(point.y) },
          }));
        }}
      />
      {draft.slots.some(
        (slot) => !activePositionCodes(state).includes(slot.position),
      ) && (
        <Notice tone="warning">
          This version uses an inactive position. Replace inactive slots with
          active team positions before saving or preparing a new match. Saved
          match versions stay unchanged.
        </Notice>
      )}
      <Button
        label={
          advanced
            ? "Hide advanced position coordinates"
            : "Advanced position coordinates"
        }
        variant="secondary"
        disabled={disabled}
        onPress={() => setAdvanced((value) => !value)}
      />
      <Notice tone="info">
        Each place has its own stable slot. Two CB places remain distinct while
        sharing the CB reporting type. Coordinates run from 0 to 1.
      </Notice>
      <View
        style={[s.rosterGrid, wide && s.rosterGridWide]}
        testID="formation-slot-editor-grid"
      >
        {draft.slots.map((slot) => (
          <Card
            key={slot.id}
            style={wide ? s.rosterCardWide : s.rosterCardPhone}
          >
            <Text style={s.small}>Slot {slot.id}</Text>
            <Field
              label={`Label for ${slot.id}`}
              disabled={disabled}
              value={slot.label}
              onChange={(label) => changeSlot(slot.id, { label })}
            />
            <Choice
              label={`Position for ${slot.id}`}
              value={slot.position}
              options={positionCatalogueFor(state)
                .filter(
                  (position) =>
                    position.active || position.code === slot.position,
                )
                .map((position) => ({
                  value: position.code,
                  label: `${position.code}${position.active ? "" : " · inactive"}`,
                }))}
              disabled={disabled}
              onChange={(position) => changeSlot(slot.id, { position })}
            />
            {advanced && (
              <View style={s.row}>
                <View style={s.flex}>
                  <Field
                    label={`X for ${slot.id}`}
                    disabled={disabled}
                    numeric
                    value={coordinates[slot.id]?.x ?? String(slot.x)}
                    onChange={(value) =>
                      setCoordinates((previous) => ({
                        ...previous,
                        [slot.id]: {
                          x: value,
                          y: previous[slot.id]?.y ?? String(slot.y),
                        },
                      }))
                    }
                  />
                </View>
                <View style={s.flex}>
                  <Field
                    label={`Y for ${slot.id}`}
                    disabled={disabled}
                    numeric
                    value={coordinates[slot.id]?.y ?? String(slot.y)}
                    onChange={(value) =>
                      setCoordinates((previous) => ({
                        ...previous,
                        [slot.id]: {
                          x: previous[slot.id]?.x ?? String(slot.x),
                          y: value,
                        },
                      }))
                    }
                  />
                </View>
              </View>
            )}
          </Card>
        ))}
      </View>
      {!coordinatesValid && (
        <Notice tone="warning">
          Enter a number between 0 and 1 for every position coordinate before
          saving. Your typed values are retained.
        </Notice>
      )}
      <FormActions
        label="Save formation version"
        disabled={disabled}
        saveDisabled={!coordinatesValid}
        onSave={() => {
          const { version: _version, ...value } = draft;
          void onSubmit({
            ...value,
            slots: value.slots.map((slot) => ({
              ...slot,
              x: Number(coordinates[slot.id].x),
              y: Number(coordinates[slot.id].y),
            })),
          });
        }}
        onClose={onClose}
      />
    </>
  );
}
function FixtureDetail({
  onDraftChange,
  scheduledGameManagement,
  fixture,
  state,
  disabled,
  onCommand,
  onEdit,
  onOpenMatch,
  onOpenReport,
  completed,
  accepted,
  canLookUpSavedMatch,
  statusLabel,
}: {
  onDraftChange?: (dirty: boolean) => void;
  scheduledGameManagement?: ReactNode;
  fixture: PreparationFixture;
  state: PreparationState;
  disabled: boolean;
  onCommand: (
    payload: Payload,
    closeEditor?: boolean,
    reviewed?: { id: string; expectedRevision: number },
  ) => Promise<boolean>;
  onEdit: () => void;
  onOpenMatch?: (fixtureId: string) => void;
  onOpenReport?: (fixtureId: string) => void;
  completed: boolean;
  accepted: boolean;
  canLookUpSavedMatch: boolean;
  statusLabel: string;
}) {
  const layout = useWorkspaceLayout();
  const wide =
    layout.mode === "tablet" &&
    layout.viewportHeight >= 480 &&
    layout.contentWidth >= 460 * Math.min(layout.fontScale, 1.5);
  const [setupDirty, setSetupDirty] = useState(false),
    [planDirty, setPlanDirty] = useState(false);
  useDraftSignal(setupDirty || planDirty, onDraftChange);
  const players = retainedPreparationPlayers(state, fixture.seasonId, [
    ...fixture.selectedProfileIds,
    ...Object.keys(fixture.responses),
    ...Object.keys(fixture.attendance),
  ]);
  const archivedSelected = players.filter(
    (profile) =>
      !profile.active && fixture.selectedProfileIds.includes(profile.id),
  );
  const scheduled = fixture.status === "scheduled" && !completed;
  const [formationId, setFormationId] = useState(
    fixture.lineupTemplateDraft?.formation.id ??
      fixture.matchPlanDraft?.formation.id ??
      `formation-${fixture.format}`,
  );
  const availableFormations = [
    ...(fixture.lineupTemplateDraft
      ? [fixture.lineupTemplateDraft.formation]
      : []),
    ...(fixture.matchPlanDraft ? [fixture.matchPlanDraft.formation] : []),
    ...state.formations,
  ];
  const formation =
    availableFormations.find(
      (item) => item.id === formationId && item.format === fixture.format,
    ) ?? availableFormations.find((item) => item.format === fixture.format);
  return (
    <>
      <Card>
        <View style={s.between}>
          <Text style={s.section}>
            {state.team.name} vs {fixture.opponent}
          </Text>
          <Pill tone={scheduled || completed ? "brand" : "warning"}>
            {statusLabel}
          </Pill>
        </View>
        <Text style={s.muted}>
          {dateLabel(fixture.playedDate)} ·{" "}
          {fixture.kickoff ?? "Time not recorded"}
        </Text>
        <Text style={s.small}>
          {fixture.venue || "Venue not recorded"} · {fixture.format}-a-side · 2
          × {fixture.plannedHalfDurationMs / 60_000} min
        </Text>
        {fixture.status !== "cancelled" && !completed && (
          <Button
            label="Edit or reschedule fixture"
            icon="calendar"
            variant="secondary"
            disabled={disabled}
            onPress={onEdit}
          />
        )}
        {!completed && (
          <View style={s.stack}>
            {scheduled ? (
              <>
                <Button
                  label="Postpone fixture"
                  variant="quiet"
                  disabled={disabled}
                  onPress={() => {
                    void onCommand({
                      type: "fixture.status_changed",
                      fixtureId: fixture.id,
                      status: "postponed",
                    });
                  }}
                />
                {!scheduledGameManagement && (
                  <Button
                    label="Cancel fixture"
                    variant="quiet"
                    disabled={disabled}
                    onPress={() => {
                      void onCommand({
                        type: "fixture.status_changed",
                        fixtureId: fixture.id,
                        status: "cancelled",
                      });
                    }}
                  />
                )}
              </>
            ) : (
              <Button
                label="Restore as scheduled"
                variant="secondary"
                disabled={disabled}
                onPress={() => {
                  void onCommand({
                    type: "fixture.status_changed",
                    fixtureId: fixture.id,
                    status: "scheduled",
                  });
                }}
              />
            )}
          </View>
        )}
      </Card>
      {scheduledGameManagement}
      {completed && (
        <Notice>
          This match is completed. The Schedule selections, replies and check-in
          below use current season names. Open the match report for recorded
          attendance, play and corrections.
        </Notice>
      )}
      {completed && onOpenReport && (
        <Button
          label="Open match report"
          disabled={disabled}
          onPress={() => onOpenReport(fixture.id)}
        />
      )}
      {!scheduled && !completed && (
        <Notice tone="warning">
          {fixture.status === "cancelled" ? "Cancelled" : "Postponed"} matches
          do not create attendance absences. Existing replies and records are
          retained.
        </Notice>
      )}
      <Notice tone="info">
        A reply is a plan. Selection chooses the squad. Actual check-in is
        recorded separately.
      </Notice>
      <Text style={s.section}>
        {completed ? "Schedule selections" : "Match squad"} ·{" "}
        {fixture.selectedProfileIds.length} selected
        {completed ? " · current season names" : ""}
      </Text>
      {scheduled && archivedSelected.length > 0 && (
        <>
          <Notice tone="warning">
            Archived players are still selected:{" "}
            {archivedSelected.map((profile) => profile.displayName).join(", ")}.
            Remove these selections before changing or preparing the current
            squad. Their past records stay unchanged.
          </Notice>
          <Button
            label={
              archivedSelected.length === 1
                ? `Remove ${archivedSelected[0].displayName} from match squad`
                : `Remove ${archivedSelected.length} archived players from match squad`
            }
            variant="secondary"
            disabled={disabled}
            onPress={() => {
              const archivedIds = new Set(
                archivedSelected.map((profile) => profile.id),
              );
              void onCommand({
                type: "fixture.selection_saved",
                fixtureId: fixture.id,
                selectedProfileIds: fixture.selectedProfileIds.filter(
                  (id) => !archivedIds.has(id),
                ),
              });
            }}
            testID="preparation-remove-archived-selection"
          />
        </>
      )}
      <View
        style={[s.rosterGrid, wide && s.rosterGridWide]}
        testID="fixture-squad-grid"
      >
        {players.map((profile) => {
          const selected = fixture.selectedProfileIds.includes(profile.id);
          return (
            <Card
              key={profile.id}
              style={[
                s.compactCard,
                wide ? s.rosterCardWide : s.rosterCardPhone,
              ]}
            >
              {profile.active ? (
                <Toggle
                  label={`Select ${profile.displayName}`}
                  visibleLabel={profile.displayName}
                  value={selected}
                  disabled={
                    disabled || !scheduled || archivedSelected.length > 0
                  }
                  onChange={(value) => {
                    void onCommand({
                      type: "fixture.selection_saved",
                      fixtureId: fixture.id,
                      selectedProfileIds: value
                        ? [...fixture.selectedProfileIds, profile.id]
                        : fixture.selectedProfileIds.filter(
                            (id) => id !== profile.id,
                          ),
                    });
                  }}
                />
              ) : (
                <>
                  <View style={s.between}>
                    <Text style={s.section}>{profile.displayName}</Text>
                    <Pill>Archived</Pill>
                  </View>
                  <Text style={s.small}>
                    {selected
                      ? completed
                        ? "Selected in Schedule."
                        : "Selected in the saved squad."
                      : "Not selected. Saved replies and attendance are retained."}
                  </Text>
                </>
              )}
              <Choice
                label={`${profile.displayName} availability reply`}
                visibleLabel="Reply"
                compact
                value={fixture.responses[profile.id] ?? "no_reply"}
                options={responseOptions}
                disabled={disabled || !scheduled || !profile.active}
                onChange={(response) => {
                  void onCommand({
                    type: "fixture.response_recorded",
                    fixtureId: fixture.id,
                    profileId: profile.id,
                    response,
                  });
                }}
              />
              {selected && (
                <Choice
                  label={`${profile.displayName} actual attendance`}
                  visibleLabel="Check-in"
                  compact
                  value={fixture.attendance[profile.id] ?? "not_recorded"}
                  options={attendanceOptions}
                  disabled={disabled || !scheduled || !profile.active}
                  onChange={(attendance) => {
                    void onCommand({
                      type: "fixture.attendance_recorded",
                      fixtureId: fixture.id,
                      profileId: profile.id,
                      attendance,
                    });
                  }}
                />
              )}
            </Card>
          );
        })}
      </View>
      {scheduled && onOpenMatch && (
        <>
          {(accepted || canLookUpSavedMatch) && (
            <>
              <Notice>
                {accepted
                  ? "This match has a saved squad, formation and player positions. Open the saved preparation to continue with them."
                  : "If this fixture was already prepared on another device, open its saved preparation. Otherwise use Open match preparation below to prepare the current squad."}{" "}
                Once a manager has taken control, preparing current changes
                cannot replace the saved match.
              </Notice>
              <Button
                label="Open saved match preparation"
                icon="play"
                variant="secondary"
                disabled={disabled}
                onPress={() => onOpenMatch(fixture.id)}
                testID="preparation-open-saved-match"
              />
            </>
          )}
          <FormationAdvice
            state={state}
            fixtureId={fixture.id}
            disabled={disabled}
            onChooseFormation={setFormationId}
            onChange={(command) => onCommand(command, false, command)}
          />
          <Choice
            label="Saved formation for this match"
            value={formation?.id ?? ""}
            options={availableFormations
              .filter((item) => item.format === fixture.format)
              .map((item) => ({
                value: item.id,
                label: `${item.name} · v${item.version}`,
              }))}
            disabled={disabled}
            onChange={setFormationId}
          />
          <Button
            label="Open match preparation"
            icon="play"
            disabled={
              disabled ||
              setupDirty ||
              planDirty ||
              !formation ||
              archivedSelected.length > 0
            }
            onPress={() => {
              if (formation)
                void onCommand({
                  type: "fixture.prepared",
                  fixtureId: fixture.id,
                  formationId: formation.id,
                }).then((saved) => {
                  if (saved) onOpenMatch(fixture.id);
                });
            }}
            testID="preparation-open-match"
          />
        </>
      )}
      {!completed && (
        <SavedLineups
          onDraftChange={setSetupDirty}
          state={state}
          fixture={fixture}
          busy={disabled}
          onCommand={(command) => onCommand(command, false, command)}
          onApplied={setFormationId}
        />
      )}
      {!completed && (
        <ReusableMatchPlans
          onDraftChange={setPlanDirty}
          key={fixture.id}
          state={state}
          fixture={fixture}
          busy={disabled}
          onCommand={async (command) => {
            const saved = await onCommand(command);
            if (saved && command.type === "match_plan.applied")
              setFormationId(
                `match-plan:${command.planId}:${command.planVersion}`,
              );
            if (saved && command.type === "match_plan.cleared")
              setFormationId(`formation-${fixture.format}`);
            return saved;
          }}
          onPrepare={() =>
            formation
              ? onCommand({
                  type: "fixture.prepared",
                  fixtureId: fixture.id,
                  formationId: formation.id,
                })
              : Promise.resolve(false)
          }
        />
      )}
      <Text style={s.section}>Fixture history</Text>
      {fixture.history.map((item) => (
        <Text key={`${item.revision}-${item.action}`} style={s.small}>
          {item.action} · {dateLabel(item.playedDate)} ·{" "}
          {item.kickoff ?? "Time not recorded"} · revision {item.revision}
        </Text>
      ))}
    </>
  );
}
function TrainingDetail({
  training,
  players,
  disabled,
  onCommand,
  onEdit,
  onEditSeries,
}: {
  training: PreparationTraining;
  players: PlayerProfile[];
  disabled: boolean;
  onCommand: (payload: Payload) => Promise<boolean>;
  onEdit: () => void;
  onEditSeries?: () => void;
}) {
  const layout = useWorkspaceLayout();
  const wide =
    layout.mode === "tablet" &&
    layout.viewportHeight >= 480 &&
    layout.contentWidth >= 460 * Math.min(layout.fontScale, 1.5);
  return (
    <>
      <Card>
        <View style={s.between}>
          <Text style={s.section}>Team training</Text>
          <Pill tone={training.status === "cancelled" ? "warning" : "brand"}>
            {training.status}
          </Pill>
        </View>
        <Text style={s.muted}>
          {dateLabel(training.date)} · {training.time}
        </Text>
        <Text style={s.small}>{training.venue || "Venue not recorded"}</Text>
        {training.status === "scheduled" && (
          <Button
            label="Edit this occurrence"
            icon="calendar"
            variant="secondary"
            disabled={disabled}
            onPress={onEdit}
          />
        )}
        {onEditSeries && (
          <Button
            label="Edit or cancel scheduled series occurrences"
            testID="training-series-manage"
            variant="secondary"
            disabled={disabled}
            onPress={onEditSeries}
          />
        )}
        <Choice
          label="Occurrence status"
          value={training.status}
          options={[
            { value: "scheduled", label: "Scheduled" },
            { value: "held", label: "Held" },
            { value: "cancelled", label: "Cancelled" },
          ]}
          disabled={disabled}
          onChange={(status) => {
            void onCommand({
              type: "training.status_changed",
              trainingId: training.id,
              status,
            });
          }}
        />
      </Card>
      <Notice tone={training.status === "cancelled" ? "warning" : "info"}>
        {training.status === "cancelled"
          ? "This cancelled occurrence is excluded from held-session attendance. Other series dates are unchanged."
          : training.status === "held"
            ? "Record attendance only from what happened. Available replies do not check players in."
            : "Record availability now. Mark this occurrence as held before entering actual attendance."}
      </Notice>
      <View
        style={[s.rosterGrid, wide && s.rosterGridWide]}
        testID="training-squad-grid"
      >
        {players
          .filter((profile) => training.expectedProfileIds.includes(profile.id))
          .map((profile) => (
            <Card
              key={profile.id}
              style={[
                s.compactCard,
                wide ? s.rosterCardWide : s.rosterCardPhone,
              ]}
            >
              <View style={s.between}>
                <Text style={s.section}>{profile.displayName}</Text>
                {!profile.active && <Pill>Archived</Pill>}
              </View>
              <Choice
                label={`${profile.displayName} training reply`}
                visibleLabel="Reply"
                compact
                value={training.responses[profile.id] ?? "no_reply"}
                options={responseOptions}
                disabled={
                  disabled || training.status === "cancelled" || !profile.active
                }
                onChange={(response) => {
                  void onCommand({
                    type: "training.response_recorded",
                    trainingId: training.id,
                    profileId: profile.id,
                    response,
                  });
                }}
              />
              <Choice
                label={`${profile.displayName} training attendance`}
                visibleLabel="Attendance"
                compact
                value={training.attendance[profile.id] ?? "not_recorded"}
                options={attendanceOptions}
                disabled={
                  disabled || training.status !== "held" || !profile.active
                }
                onChange={(attendance) => {
                  void onCommand({
                    type: "training.attendance_recorded",
                    trainingId: training.id,
                    profileId: profile.id,
                    attendance,
                  });
                }}
              />
            </Card>
          ))}
      </View>
    </>
  );
}

const s = StyleSheet.create({
  hiddenPanel: { display: "none" },
  scheduleRail: { gap: 16, minWidth: 0 },
  detailPanel: { minWidth: 0 },
  formActionsWide: { maxWidth: 520, width: "100%", alignSelf: "flex-end" },
  rosterGrid: { gap: 12 },
  rosterGridWide: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "stretch",
  },
  rosterCardWide: { width: "48%", minWidth: 0 },
  rosterCardPhone: { width: "100%" },
  compactStack: { gap: 12 },
  compactCard: { padding: 12, gap: 8 },
  actionPair: { flexDirection: "row", gap: 8 },
  pairedAction: {
    flex: 1,
    minHeight: 48,
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  formColumns: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  formColumn: { flexGrow: 1, flexBasis: 120, minWidth: 110 },
  stack: { gap: 16 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  between: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 12,
  },
  flex: { flex: 1 },
  title: { fontSize: 26, lineHeight: 32, fontWeight: "700", color: colors.ink },
  section: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: "600",
    color: colors.ink,
  },
  body: { fontSize: 16, lineHeight: 24, color: colors.ink },
  muted: { fontSize: 16, lineHeight: 24, color: colors.inkMuted },
  small: { fontSize: 14, lineHeight: 20, color: colors.inkMuted },
  footnote: { fontSize: 12, lineHeight: 18, color: colors.inkMuted },
  eyebrow: {
    fontSize: 12,
    lineHeight: 18,
    fontWeight: "700",
    letterSpacing: 1.2,
    color: colors.brand,
  },
  label: { fontSize: 14, lineHeight: 20, fontWeight: "600", color: colors.ink },
  field: { gap: 8 },
  input: {
    minHeight: 52,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.controlBorder,
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
    lineHeight: 24,
    color: colors.ink,
  },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  compactChoiceField: { gap: 4 },
  compactChoices: { gap: 6 },
  compactChoice: {
    minWidth: 44,
    minHeight: 44,
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  compactChoiceText: { fontSize: 13, lineHeight: 18 },
  choice: {
    minWidth: 48,
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.controlBorder,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  choiceSelected: { backgroundColor: colors.brand, borderColor: colors.brand },
  choiceText: { fontSize: 14, lineHeight: 20, color: colors.ink },
  choiceSelectedText: { color: colors.surface, fontWeight: "600" },
  badge: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: colors.brand,
    backgroundColor: "#E8F1EB",
    justifyContent: "center",
    alignItems: "center",
  },
  badgeText: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "700",
    color: colors.brand,
  },
  shirt: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.bench,
    justifyContent: "center",
    alignItems: "center",
  },
  keeper: { backgroundColor: colors.selection },
  shirtText: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "700",
    color: colors.ink,
  },
  pitch: {
    height: 280,
    borderRadius: 10,
    backgroundColor: colors.pitch,
    overflow: "hidden",
  },
  pitchBoundary: {
    position: "absolute",
    top: 9,
    right: 9,
    bottom: 9,
    left: 9,
    borderWidth: 1,
    borderColor: colors.surface,
  },
  pitchHalf: {
    position: "absolute",
    top: "50%",
    left: 9,
    right: 9,
    borderTopWidth: 1,
    borderColor: colors.surface,
  },
  pitchCircle: {
    width: 58,
    height: 58,
    borderRadius: 29,
    borderWidth: 1,
    borderColor: colors.surface,
    position: "absolute",
    top: "50%",
    left: "50%",
    marginLeft: -29,
    marginTop: -29,
  },
  previewSlot: {
    position: "absolute",
    width: 44,
    minHeight: 32,
    marginLeft: -22,
    marginTop: -16,
    borderRadius: 20,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    padding: 4,
  },
  previewLabel: {
    fontSize: 12,
    lineHeight: 18,
    fontWeight: "600",
    color: colors.ink,
  },
});
