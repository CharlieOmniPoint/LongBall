import { applyTrainingSeries, type TrainingSeriesPayload } from './training-series';

/** Team preparation is a serializable local projection; authentication belongs to the application boundary. */
export type LogoChoice = "roundel" | "shield" | "ball";
export type PositionCode =
  | "GK"
  | "CB"
  | "LB"
  | "RB"
  | "CM"
  | "LW"
  | "RW"
  | "ST";
export const positionCodes: PositionCode[] = [
  "GK",
  "CB",
  "LB",
  "RB",
  "CM",
  "LW",
  "RW",
  "ST",
];
export type AvailabilityResponse =
  | "available"
  | "unavailable"
  | "unsure"
  | "no_reply";
export type PreparationAttendance = "present" | "absent" | "not_recorded";
export interface PreparationSeason {
  id: string;
  label: string;
  startYear: number;
  startDate: string;
  endDate: string;
  spectatorRenewalRequired: true;
}
export interface PlayerProfile {
  id: string;
  playerId: string;
  seasonId: string;
  displayName: string;
  initials: string;
  shirtNumber: number | null;
  foot: "left" | "right" | "both" | "not_recorded";
  preferences: PositionCode[];
  eligiblePositions: PositionCode[];
  active: boolean;
}
export interface FormationSlot {
  id: string;
  position: PositionCode;
  label: string;
  x: number;
  y: number;
}
export interface PreparationFormation {
  id: string;
  name: string;
  format: number;
  version: number;
  slots: FormationSlot[];
}
export interface FixtureDraft {
  id: string;
  seasonId: string;
  opponent: string;
  playedDate: string;
  kickoff: string | null;
  arrival: string | null;
  venue: string;
  homeAway: "home" | "away";
  format: number;
  plannedHalfDurationMs: number;
}
export interface PreparationFixture extends FixtureDraft {
  status: "scheduled" | "postponed" | "cancelled";
  selectedProfileIds: string[];
  responses: Record<string, AvailabilityResponse>;
  attendance: Record<string, PreparationAttendance>;
  history: {
    revision: number;
    action: string;
    playedDate: string;
    kickoff: string | null;
    status: PreparationFixture["status"];
  }[];
}
export interface TrainingDraft {
  id: string;
  seasonId: string;
  date: string;
  time: string;
  venue: string;
  recurrenceGroupId: string | null;
  expectedProfileIds: string[];
}
export interface PreparationTraining extends TrainingDraft {
  status: "scheduled" | "held" | "cancelled";
  responses: Record<string, AvailabilityResponse>;
  attendance: Record<string, PreparationAttendance>;
}
export interface PreparedFixtureSnapshot {
  id: string;
  fixtureId: string;
  seasonId: string;
  preparedRevision: number;
  fixture: FixtureDraft;
  formation: PreparationFormation;
  profiles: PlayerProfile[];
  selectedPlayerIds: string[];
  attendance: Record<string, PreparationAttendance>;
}
export interface PreparationState {
  version: 1;
  synthetic: true;
  revision: number;
  club: { id: string; name: string; logo: LogoChoice | null };
  team: {
    id: string;
    name: string;
    ageGroup: string;
    defaultPitchPlaces: number;
    defaultHalfDurationMs: number;
    logo: LogoChoice | null;
  };
  activeSeasonId: string;
  seasons: PreparationSeason[];
  profiles: PlayerProfile[];
  formations: PreparationFormation[];
  fixtures: PreparationFixture[];
  training: PreparationTraining[];
  snapshots: PreparedFixtureSnapshot[];
  appliedCommands: Record<string, string>;
  audit: { id: string; revision: number; type: string }[];
}
interface PreparationCommandBase {
  id: string;
  expectedRevision: number;
}
export type PreparationCommand = PreparationCommandBase &
  (
    | { type: "club.updated"; name: string; logo: LogoChoice | null }
    | {
        type: "team.updated";
        name: string;
        ageGroup: string;
        defaultPitchPlaces: number;
        defaultHalfDurationMs: number;
        logo: LogoChoice | null;
      }
    | {
        type: "season.rolled_over";
        idForSeason: string;
        startYear: number;
        copyPlayers: boolean;
        confirmSpectatorRenewal: true;
      }
    | { type: "profile.saved"; profile: PlayerProfile }
    | {
        type: "roster.imported";
        profiles: PlayerProfile[];
        confirmNewPlayers: true;
      }
    | { type: "profile.archived"; profileId: string }
    | {
        type: "formation.saved";
        formation: Omit<PreparationFormation, "version">;
      }
    | { type: "fixture.saved"; fixture: FixtureDraft }
    | {
        type: "fixture.status_changed";
        fixtureId: string;
        status: PreparationFixture["status"];
      }
    | {
        type: "fixture.response_recorded";
        fixtureId: string;
        profileId: string;
        response: AvailabilityResponse;
      }
    | {
        type: "fixture.selection_saved";
        fixtureId: string;
        selectedProfileIds: string[];
      }
    | {
        type: "fixture.attendance_recorded";
        fixtureId: string;
        profileId: string;
        attendance: PreparationAttendance;
      }
    | { type: "fixture.prepared"; fixtureId: string; formationId: string }
    | TrainingSeriesPayload
    | { type: "training.saved"; training: TrainingDraft }
    | {
        type: "training.status_changed";
        trainingId: string;
        status: PreparationTraining["status"];
      }
    | {
        type: "training.response_recorded";
        trainingId: string;
        profileId: string;
        response: AvailabilityResponse;
      }
    | {
        type: "training.attendance_recorded";
        trainingId: string;
        profileId: string;
        attendance: PreparationAttendance;
      }
  );

function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function text(value: string, label: string, maximum = 80): string {
  requireThat(
    typeof value === "string" &&
      value.trim().length > 0 &&
      value.trim().length <= maximum,
    `${label} is required and must be at most ${maximum} characters.`,
  );
  return value.trim();
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function validDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}
function validTime(value: string | null): boolean {
  return value === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
function validateFormat(format: number) {
  requireThat(
    Number.isInteger(format) && format >= 5 && format <= 11,
    "Choose a format from five to eleven players.",
  );
}
function validateHalf(duration: number) {
  requireThat(
    Number.isSafeInteger(duration) && duration > 0 && duration % 1000 === 0,
    "Each planned half must be a positive whole number of seconds.",
  );
}
function validateLogo(logo: LogoChoice | null) {
  requireThat(
    logo === null || ["roundel", "shield", "ball"].includes(logo),
    "Choose one of the original fictional badges.",
  );
}
function activeSeason(state: PreparationState, seasonId: string) {
  const season = state.seasons.find((item) => item.id === seasonId);
  requireThat(season, "Season not found.");
  requireThat(
    seasonId === state.activeSeasonId,
    "Past seasons are read-only here. Their records are retained unchanged.",
  );
  return season;
}
function dateInSeason(state: PreparationState, seasonId: string, date: string) {
  const season = activeSeason(state, seasonId);
  requireThat(
    validDate(date) && date >= season.startDate && date <= season.endDate,
    "Choose a valid date within the selected September-to-August season.",
  );
}
function checkProfile(
  state: PreparationState,
  profileId: string,
  seasonId: string,
) {
  const profile = state.profiles.find(
    (item) =>
      item.id === profileId && item.seasonId === seasonId && item.active,
  );
  requireThat(profile, "Choose an active player from this team and season.");
  return profile;
}
function validResponse(value: string) {
  requireThat(
    ["available", "unavailable", "unsure", "no_reply"].includes(value),
    "Choose an availability response.",
  );
}
function validAttendance(value: string) {
  requireThat(
    ["present", "absent", "not_recorded"].includes(value),
    "Choose Present, Absent or Not recorded.",
  );
}
function unique(ids: string[]) {
  requireThat(
    new Set(ids).size === ids.length,
    "Each player or slot can appear only once.",
  );
}

function validateTraining(state: PreparationState, training: TrainingDraft): void {
  text(training.id, "Training identity", 150);
  dateInSeason(state, training.seasonId, training.date);
  requireThat(validTime(training.time) && training.time !== null, "Use a 24-hour HH:MM training time.");
  requireThat(typeof training.venue === "string" && training.venue.length <= 200, "Use a training venue of at most 200 characters.");
  requireThat(training.recurrenceGroupId === null || typeof training.recurrenceGroupId === "string" && training.recurrenceGroupId.trim().length > 0 && training.recurrenceGroupId.length <= 150, "Use a valid training series identity.");
  requireThat(Array.isArray(training.expectedProfileIds), "Choose the expected players explicitly.");
  unique(training.expectedProfileIds);
  training.expectedProfileIds.forEach(id => checkProfile(state, id, training.seasonId));
}

export function seasonBounds(startYear: number) {
  requireThat(
    Number.isInteger(startYear) && startYear >= 2000 && startYear <= 2100,
    "Choose a season start year between 2000 and 2100.",
  );
  return {
    startDate: `${startYear}-09-01`,
    endDate: `${startYear + 1}-08-31`,
    label: `${startYear}/${String(startYear + 1).slice(-2)}`,
  };
}
export function seasonPlayers(
  state: PreparationState,
  seasonId = state.activeSeasonId,
) {
  return state.profiles.filter(
    (profile) => profile.seasonId === seasonId && profile.active,
  );
}
export function effectiveLogo(state: PreparationState): LogoChoice {
  return state.team.logo ?? state.club.logo ?? "roundel";
}
export function goalkeeperChoice(profile: PlayerProfile): number {
  const rank = profile.preferences.indexOf("GK") + 1;
  return profile.eligiblePositions.includes("GK") && (rank === 1 || rank === 2)
    ? rank
    : 0;
}
export function defaultFormation(format: number): PreparationFormation {
  validateFormat(format);
  const roles: Record<number, PositionCode[]> = {
    5: ["GK", "CB", "CB", "CM", "ST"],
    6: ["GK", "CB", "CB", "LW", "RW", "ST"],
    7: ["GK", "CB", "CB", "CM", "LW", "RW", "ST"],
    8: ["GK", "LB", "CB", "RB", "CM", "LW", "RW", "ST"],
    9: ["GK", "LB", "CB", "CB", "RB", "CM", "LW", "RW", "ST"],
    10: ["GK", "LB", "CB", "CB", "RB", "CM", "CM", "LW", "RW", "ST"],
    11: ["GK", "LB", "CB", "CB", "RB", "CM", "CM", "LW", "RW", "ST", "ST"],
  };
  const count: Partial<Record<PositionCode, number>> = {};
  const row = (position: PositionCode) =>
    position === "GK"
      ? 0.9
      : ["CB", "LB", "RB"].includes(position)
        ? 0.72
        : position === "CM"
          ? 0.5
          : ["LW", "RW"].includes(position)
            ? 0.32
            : 0.13;
  return {
    id: `formation-${format}`,
    name: `${format}-a-side`,
    format,
    version: 1,
    slots: roles[format].map((position) => {
      const ordinal = (count[position] = (count[position] ?? 0) + 1);
      const peers = roles[format].filter((role) => row(role) === row(position));
      const index = roles[format]
        .slice(
          0,
          roles[format].findIndex(
            (role, i) =>
              role === position &&
              roles[format].slice(0, i + 1).filter((p) => p === position)
                .length === ordinal,
          ),
        )
        .filter((role) => row(role) === row(position)).length;
      return {
        id: `${position.toLowerCase()}-${ordinal}`,
        position,
        label: `${position}${roles[format].filter((role) => role === position).length > 1 ? ordinal : ""}`,
        x: (index + 1) / (peers.length + 1),
        y: row(position),
      };
    }),
  };
}

export function prepareFixtureSnapshot(
  state: PreparationState,
  fixtureId: string,
  formationId?: string,
): PreparedFixtureSnapshot {
  const fixture = state.fixtures.find((item) => item.id === fixtureId);
  requireThat(
    fixture && fixture.status === "scheduled",
    "Only a scheduled match can be prepared.",
  );
  activeSeason(state, fixture.seasonId);
  const formation = state.formations.find(
    (item) => item.id === (formationId ?? `formation-${fixture.format}`),
  );
  requireThat(
    formation && formation.format === fixture.format,
    "Choose a saved formation for this match format.",
  );
  requireThat(
    fixture.selectedProfileIds.length >= fixture.format,
    "Select enough players for the match format.",
  );
  const profiles = fixture.selectedProfileIds.map((id) =>
    checkProfile(state, id, fixture.seasonId),
  );
  requireThat(
    profiles.some((profile) => goalkeeperChoice(profile) > 0),
    "Select a first- or second-choice eligible goalkeeper.",
  );
  const {
    responses: _responses,
    attendance: _attendance,
    selectedProfileIds: _selected,
    history: _history,
    status: _status,
    ...draft
  } = fixture;
  return clone({
    id: `${fixture.id}@${state.revision + 1}`,
    fixtureId,
    seasonId: fixture.seasonId,
    preparedRevision: state.revision + 1,
    fixture: draft,
    formation,
    profiles,
    selectedPlayerIds: profiles.map((profile) => profile.playerId),
    attendance: Object.fromEntries(
      profiles.map((profile) => [
        profile.playerId,
        fixture.attendance[profile.id] ?? "not_recorded",
      ]),
    ),
  });
}

/** Shared validation preserves profile identities and never rewrites match snapshots. */
function saveProfile(
  state: PreparationState,
  source: PlayerProfile,
): PlayerProfile {
  const profile = clone(source);
  activeSeason(state, profile.seasonId);
  text(profile.id, "Profile identity", 150);
  text(profile.playerId, "Player identity", 150);
  const existing = state.profiles.find((item) => item.id === profile.id);
  if (existing)
    requireThat(
      existing.playerId === profile.playerId &&
        existing.seasonId === profile.seasonId,
      "Profile identity and season cannot be reassigned.",
    );
  requireThat(
    !state.profiles.some(
      (item) =>
        item.id !== profile.id &&
        item.seasonId === profile.seasonId &&
        item.playerId === profile.playerId,
    ),
    "That player already has a profile in this season.",
  );
  profile.displayName = text(profile.displayName, "Display name", 60);
  requireThat(
    typeof profile.initials === "string" &&
      /^[A-Za-z0-9]{1,2}$/.test(profile.initials),
    "Use one or two letters or digits for the pitch label.",
  );
  profile.initials = profile.initials.toUpperCase();
  requireThat(
    profile.shirtNumber === null ||
      (Number.isInteger(profile.shirtNumber) &&
        profile.shirtNumber >= 1 &&
        profile.shirtNumber <= 99),
    "Shirt number must be one to 99 or not recorded.",
  );
  requireThat(
    !state.profiles.some(
      (item) =>
        item.id !== profile.id &&
        item.seasonId === profile.seasonId &&
        item.active &&
        profile.active &&
        profile.shirtNumber !== null &&
        item.shirtNumber === profile.shirtNumber,
    ),
    "Another active player already has that shirt number.",
  );
  requireThat(
    profile.preferences.length === 3 &&
      new Set(profile.preferences).size === 3 &&
      profile.preferences.every((position) => positionCodes.includes(position)),
    "Choose three different ranked positions.",
  );
  requireThat(
    profile.eligiblePositions.length > 0 &&
      new Set(profile.eligiblePositions).size ===
        profile.eligiblePositions.length &&
      profile.eligiblePositions.every((position) =>
        positionCodes.includes(position),
      ),
    "Choose distinct manager-approved eligible positions.",
  );
  requireThat(
    ["left", "right", "both", "not_recorded"].includes(profile.foot),
    "Choose a preferred foot or Not recorded.",
  );
  state.profiles = state.profiles.filter((item) => item.id !== profile.id);
  state.profiles.push(profile);
  return profile;
}

/** New identities only: a roster import never updates or merges an existing player. */
export function validateRosterImport(
  state: PreparationState,
  profiles: PlayerProfile[],
): PlayerProfile[] {
  requireThat(
    Array.isArray(profiles) && profiles.length > 0 && profiles.length <= 200,
    "Import between one and 200 new player profiles.",
  );
  const candidate = clone(state);
  return Array.from(profiles).map((profile) => {
    requireThat(
      profile &&
        typeof profile === "object" &&
        Object.keys(profile).length === 10 &&
        Object.keys(profile).every((key) =>
          [
            "id",
            "playerId",
            "seasonId",
            "displayName",
            "initials",
            "shirtNumber",
            "foot",
            "preferences",
            "eligiblePositions",
            "active",
          ].includes(key),
        ),
      "Use only the documented player profile fields; accounts, contacts and dates of birth cannot be imported.",
    );
    requireThat(
      Array.isArray(profile.preferences) &&
        Array.isArray(profile.eligiblePositions),
      "Provide ranked preferences and explicit eligible positions.",
    );
    requireThat(
      typeof profile.initials === "string" &&
        profile.initials.length >= 1 &&
        profile.initials.length <= 2 &&
        !/[^A-Za-z0-9]/.test(profile.initials),
      "Use one or two letters or digits for the pitch label.",
    );
    requireThat(
      profile.active === true && profile.seasonId === state.activeSeasonId,
      "Import active players into the current season only.",
    );
    for (const id of [profile.id, profile.playerId])
      requireThat(
        typeof id === "string" &&
          id.length >= 1 &&
          id.length <= 150 &&
          !/[^A-Za-z0-9_.:-]/.test(id),
        "Use a valid opaque player/profile identity of at most 150 characters.",
      );
    requireThat(
      !candidate.profiles.some(
        (existing) =>
          existing.id === profile.id || existing.playerId === profile.playerId,
      ),
      "A player or profile identity already exists. Import never merges identities; edit that player separately.",
    );
    return saveProfile(candidate, profile);
  });
}

export function reducePreparation(
  previous: PreparationState,
  command: PreparationCommand,
): PreparationState {
  requireThat(
    command.id && typeof command.id === "string",
    "A stable command identity is required.",
  );
  const signature = canonical(command);
  if (previous.appliedCommands[command.id]) {
    requireThat(
      previous.appliedCommands[command.id] === signature,
      "This command identity already belongs to different content.",
    );
    return previous;
  }
  requireThat(
    command.expectedRevision === previous.revision,
    "Preparation changed on another screen. Reload the saved version before applying this change.",
  );
  const state = clone(previous);
  const revision = state.revision + 1;
  switch (command.type) {
    case "club.updated":
      validateLogo(command.logo);
      state.club = {
        ...state.club,
        name: text(command.name, "Club name"),
        logo: command.logo,
      };
      break;
    case "team.updated":
      validateLogo(command.logo);
      validateFormat(command.defaultPitchPlaces);
      validateHalf(command.defaultHalfDurationMs);
      state.team = {
        ...state.team,
        name: text(command.name, "Team name"),
        ageGroup: text(command.ageGroup, "Age group", 12),
        defaultPitchPlaces: command.defaultPitchPlaces,
        defaultHalfDurationMs: command.defaultHalfDurationMs,
        logo: command.logo,
      };
      break;
    case "season.rolled_over": {
      requireThat(
        command.confirmSpectatorRenewal === true,
        "Confirm that spectator access must be renewed explicitly.",
      );
      const old = state.seasons.find(
        (item) => item.id === state.activeSeasonId,
      )!;
      requireThat(
        command.startYear === old.startYear + 1,
        "Rollover creates the immediately following September-to-August season.",
      );
      requireThat(
        !state.seasons.some(
          (item) =>
            item.id === command.idForSeason ||
            item.startYear === command.startYear,
        ),
        "That season already exists.",
      );
      const season: PreparationSeason = {
        id: text(command.idForSeason, "Season identity"),
        startYear: command.startYear,
        ...seasonBounds(command.startYear),
        spectatorRenewalRequired: true,
      };
      if (command.copyPlayers)
        state.profiles.push(
          ...seasonPlayers(state).map((profile) => ({
            ...clone(profile),
            id: `${profile.playerId}:${season.id}`,
            seasonId: season.id,
          })),
        );
      state.seasons.push(season);
      state.activeSeasonId = season.id;
      break;
    }
    case "profile.saved":
      saveProfile(state, command.profile);
      break;
    case "roster.imported": {
      requireThat(
        command.id.length <= 150 && !/[^A-Za-z0-9_.:-]/.test(command.id),
        "Use a valid stable roster import identity.",
      );
      requireThat(
        command.confirmNewPlayers === true,
        "Confirm that every imported row creates a new player; no accounts or access are granted.",
      );
      requireThat(
        Object.keys(command).every((key) =>
          [
            "id",
            "type",
            "expectedRevision",
            "profiles",
            "confirmNewPlayers",
          ].includes(key),
        ),
        "Use the documented roster import command.",
      );
      state.profiles.push(...validateRosterImport(state, command.profiles));
      break;
    }
    case "profile.archived": {
      const profile = state.profiles.find(
        (item) => item.id === command.profileId,
      );
      requireThat(profile, "Player profile not found.");
      activeSeason(state, profile.seasonId);
      profile.active = false;
      break;
    }
    case "formation.saved": {
      const formation = clone(command.formation);
      validateFormat(formation.format);
      formation.name = text(formation.name, "Formation name", 40);
      requireThat(
        formation.slots.length === formation.format &&
          formation.slots.filter((slot) => slot.position === "GK").length === 1,
        "A formation needs the chosen number of slots and exactly one goalkeeper.",
      );
      unique(formation.slots.map((slot) => slot.id));
      for (const slot of formation.slots) {
        requireThat(
          slot.id.length > 0 && positionCodes.includes(slot.position),
          "Each slot needs an identity and position type.",
        );
        slot.label = text(slot.label, "Slot label", 16);
        requireThat(
          Number.isFinite(slot.x) &&
            slot.x >= 0 &&
            slot.x <= 1 &&
            Number.isFinite(slot.y) &&
            slot.y >= 0 &&
            slot.y <= 1,
          "Formation coordinates must be between zero and one.",
        );
      }
      const version =
        (state.formations.find((item) => item.id === formation.id)?.version ??
          0) + 1;
      state.formations = state.formations.filter(
        (item) => item.id !== formation.id,
      );
      state.formations.push({ ...formation, version });
      break;
    }
    case "fixture.saved": {
      const fixture = clone(command.fixture);
      dateInSeason(state, fixture.seasonId, fixture.playedDate);
      validateFormat(fixture.format);
      validateHalf(fixture.plannedHalfDurationMs);
      fixture.opponent = text(fixture.opponent, "Opposition");
      requireThat(
        validTime(fixture.kickoff) && validTime(fixture.arrival),
        "Use 24-hour HH:MM times, or leave time not recorded.",
      );
      requireThat(
        ["home", "away"].includes(fixture.homeAway),
        "Choose home or away.",
      );
      const existing = state.fixtures.find((item) => item.id === fixture.id);
      if (existing)
        requireThat(
          existing.seasonId === fixture.seasonId &&
            existing.status !== "cancelled",
          "Cancelled matches must be restored explicitly before rescheduling.",
        );
      const status = "scheduled" as const;
      const updated: PreparationFixture = {
        ...fixture,
        status,
        selectedProfileIds: existing?.selectedProfileIds ?? [],
        responses: existing?.responses ?? {},
        attendance: existing?.attendance ?? {},
        history: [
          ...(existing?.history ?? []),
          {
            revision,
            action: existing ? "rescheduled" : "created",
            playedDate: fixture.playedDate,
            kickoff: fixture.kickoff,
            status,
          },
        ],
      };
      state.fixtures = state.fixtures.filter((item) => item.id !== fixture.id);
      state.fixtures.push(updated);
      break;
    }
    case "fixture.status_changed": {
      const fixture = state.fixtures.find(
        (item) => item.id === command.fixtureId,
      );
      requireThat(fixture, "Match not found.");
      activeSeason(state, fixture.seasonId);
      requireThat(
        ["scheduled", "postponed", "cancelled"].includes(command.status),
        "Choose a valid fixture state.",
      );
      fixture.status = command.status;
      fixture.history.push({
        revision,
        action: command.status,
        playedDate: fixture.playedDate,
        kickoff: fixture.kickoff,
        status: command.status,
      });
      break;
    }
    case "fixture.response_recorded":
    case "fixture.selection_saved":
    case "fixture.attendance_recorded": {
      const fixture = state.fixtures.find(
        (item) => item.id === command.fixtureId,
      );
      requireThat(fixture, "Match not found.");
      activeSeason(state, fixture.seasonId);
      requireThat(
        fixture.status === "scheduled",
        "Only a scheduled match can collect responses, selection or attendance.",
      );
      if (command.type === "fixture.selection_saved") {
        unique(command.selectedProfileIds);
        command.selectedProfileIds.forEach((id) =>
          checkProfile(state, id, fixture.seasonId),
        );
        fixture.selectedProfileIds = [...command.selectedProfileIds];
      } else {
        checkProfile(state, command.profileId, fixture.seasonId);
        if (command.type === "fixture.response_recorded") {
          validResponse(command.response);
          fixture.responses[command.profileId] = command.response;
        } else {
          validAttendance(command.attendance);
          requireThat(
            fixture.selectedProfileIds.includes(command.profileId),
            "Only selected match players can be checked in.",
          );
          fixture.attendance[command.profileId] = command.attendance;
        }
      }
      break;
    }
    case "fixture.prepared": {
      const snapshot = prepareFixtureSnapshot(
        state,
        command.fixtureId,
        command.formationId,
      );
      state.snapshots.push(snapshot);
      break;
    }
    case "training.series_created":
    case "training.series_updated":
    case "training.series_cancelled": {
      applyTrainingSeries(state, command, draft => validateTraining(state, draft));
      break;
    }
    case "training.saved": {
      const training = clone(command.training);
      validateTraining(state, training);
      const existing = state.training.find((item) => item.id === training.id);
      if (existing)
        requireThat(
          existing.seasonId === training.seasonId &&
            existing.recurrenceGroupId === training.recurrenceGroupId &&
            existing.status === "scheduled",
          "Held or cancelled training records are retained; create or restore a scheduled occurrence first.",
        );
      state.training = state.training.filter((item) => item.id !== training.id);
      state.training.push({
        ...training,
        status: "scheduled",
        responses: existing?.responses ?? {},
        attendance: existing?.attendance ?? {},
      });
      break;
    }
    case "training.status_changed": {
      const training = state.training.find(
        (item) => item.id === command.trainingId,
      );
      requireThat(training, "Training occurrence not found.");
      activeSeason(state, training.seasonId);
      requireThat(
        ["scheduled", "held", "cancelled"].includes(command.status),
        "Choose a valid training state.",
      );
      training.status = command.status;
      break;
    }
    case "training.response_recorded":
    case "training.attendance_recorded": {
      const training = state.training.find(
        (item) => item.id === command.trainingId,
      );
      requireThat(training, "Training occurrence not found.");
      activeSeason(state, training.seasonId);
      checkProfile(state, command.profileId, training.seasonId);
      requireThat(
        training.expectedProfileIds.includes(command.profileId),
        "Only expected players belong to this attendance occurrence.",
      );
      if (command.type === "training.response_recorded") {
        requireThat(
          training.status !== "cancelled",
          "Cancelled training cannot collect availability.",
        );
        validResponse(command.response);
        training.responses[command.profileId] = command.response;
      } else {
        requireThat(
          training.status === "held",
          "Mark this occurrence as held before recording actual attendance. Cancelled training is excluded.",
        );
        validAttendance(command.attendance);
        training.attendance[command.profileId] = command.attendance;
      }
      break;
    }
    default:
      throw new Error(
        "This preparation command is not supported. No saved records were changed.",
      );
  }
  state.revision = revision;
  state.appliedCommands[command.id] = signature;
  state.audit.push({ id: command.id, revision, type: command.type });
  return state;
}

export function trainingAttendanceEvidence(state: PreparationState) {
  return state.training.map((session) => ({
    sessionId: session.id,
    playedDate: session.date,
    eventStatus: session.status,
    expectedPlayerIds: session.expectedProfileIds
      .map(
        (id) => state.profiles.find((profile) => profile.id === id)?.playerId,
      )
      .filter((id): id is string => Boolean(id)),
    attendance: Object.fromEntries(
      Object.entries(session.attendance).flatMap(([id, attendance]) => {
        const profile = state.profiles.find((item) => item.id === id);
        return profile ? [[profile.playerId, attendance]] : [];
      }),
    ),
    responses: Object.fromEntries(
      Object.entries(session.responses).flatMap(([id, response]) => {
        const profile = state.profiles.find((item) => item.id === id);
        return profile ? [[profile.playerId, response]] : [];
      }),
    ),
  }));
}

export function createPreparationState(): PreparationState {
  const seasonId = "synthetic-season-2026-27";
  const profiles: PlayerProfile[] = Array.from({ length: 13 }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    const preferred: PositionCode =
      index === 0
        ? "GK"
        : ([
            "CB",
            "CB",
            "CM",
            "LW",
            "RW",
            "ST",
            "LW",
            "RW",
            "CM",
            "CB",
            "ST",
            "CM",
          ][index - 1] as PositionCode);
    const preferences = [
      preferred,
      ...(["CM", "CB", "ST", "LW"] as PositionCode[]).filter(
        (position) => position !== preferred,
      ),
    ].slice(0, 3);
    return {
      id: `synthetic-player-${number}:${seasonId}`,
      playerId: `synthetic-player-${number}`,
      seasonId,
      displayName: `Player ${number}`,
      initials: number,
      shirtNumber: index + 1,
      foot: "not_recorded",
      preferences,
      eligiblePositions:
        index === 0
          ? ["GK", "CB", "ST"]
          : ["CB", "LB", "RB", "CM", "LW", "RW", "ST"],
      active: true,
    };
  });
  const fixture: PreparationFixture = {
    id: "synthetic-roma-maple-2026-10-24",
    seasonId,
    opponent: "Maple FC",
    playedDate: "2026-10-24",
    kickoff: "10:00",
    arrival: "09:30",
    venue: "Roma recreation ground",
    homeAway: "home",
    format: 7,
    plannedHalfDurationMs: 1_500_000,
    status: "scheduled",
    selectedProfileIds: profiles.slice(0, 9).map((profile) => profile.id),
    responses: Object.fromEntries(
      profiles.slice(0, 9).map((profile) => [profile.id, "available"]),
    ),
    attendance: {},
    history: [
      {
        revision: 0,
        action: "created",
        playedDate: "2026-10-24",
        kickoff: "10:00",
        status: "scheduled",
      },
    ],
  };
  const training = ["2026-10-22", "2026-10-29"].map(
    (date, index): PreparationTraining => ({
      id: `synthetic-training-${index + 1}`,
      seasonId,
      date,
      time: "18:00",
      venue: "Roma recreation ground",
      recurrenceGroupId: "synthetic-thursday-training",
      expectedProfileIds: profiles.map((profile) => profile.id),
      status: "scheduled",
      responses: {},
      attendance: {},
    }),
  );
  return {
    version: 1,
    synthetic: true,
    revision: 0,
    club: {
      id: "synthetic-richmond-rovers",
      name: "Richmond Rovers",
      logo: "roundel",
    },
    team: {
      id: "synthetic-roma-u10",
      name: "Roma",
      ageGroup: "U10",
      defaultPitchPlaces: 7,
      defaultHalfDurationMs: 1_500_000,
      logo: null,
    },
    activeSeasonId: seasonId,
    seasons: [
      {
        id: seasonId,
        ...seasonBounds(2026),
        startYear: 2026,
        spectatorRenewalRequired: true,
      },
    ],
    profiles,
    formations: Array.from({ length: 7 }, (_, index) =>
      defaultFormation(index + 5),
    ),
    fixtures: [fixture],
    training,
    snapshots: [],
    appliedCommands: {},
    audit: [],
  };
}
