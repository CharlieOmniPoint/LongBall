import { romaFixture } from "@longball/testing";
import {
  applyTrainingSeries,
  type TrainingSeriesPayload,
} from "./training-series";
import {
  activePositionCodes,
  allowedProfilePosition,
  archiveTeamPosition,
  assertActiveFormationPositions,
  CORE_POSITION_CODES,
  defaultPositionCatalogue,
  saveTeamPosition,
  type TeamPosition,
} from "./position-catalogue";

import {
  applyMatchPlan,
  saveMatchPlan,
  validateFixtureMatchPlan,
  type FixtureMatchPlanDraft,
  type MatchPlanApplyInput,
  type MatchPlanContext,
  type MatchPlanSaveInput,
  type ReusableMatchPlan,
} from "./match-plans";
import {
  applyLineupTemplate,
  archiveLineupTemplate,
  saveLineupTemplate,
  validateFixtureLineupTemplate,
  type SavedLineupTemplate,
  type FixtureLineupDraft,
  type LineupTemplateSaveInput,
  type LineupTemplateArchiveInput,
  type LineupTemplateApplyInput,
} from "./lineup-templates";
export {
  activePositionCodes,
  assertActiveFormationPositions,
  positionCatalogueFor,
} from "./position-catalogue";
/** Team preparation is a serializable local projection; authentication belongs to the application boundary. */
export type LogoChoice = "roundel" | "shield" | "ball";
export type PositionCode = string;
/** Original defaults for legacy consumers. New choices use activePositionCodes(state). */
export const positionCodes: PositionCode[] = [...CORE_POSITION_CODES];
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
  /** Private team identifier; never used as an account or permission identity. */
  faPlayerId?: string | null;
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
  lineupTemplateDraft?: FixtureLineupDraft;
  matchPlanDraft?: FixtureMatchPlanDraft;
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
  lineupTemplateDraft?: FixtureLineupDraft;
  matchPlanDraft?: FixtureMatchPlanDraft;
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
    league?: string;
    defaultPitchPlaces: number;
    defaultHalfDurationMs: number;
    logo: LogoChoice | null;
  };
  substitutionAlerts?: {
    enabled: boolean;
    leadSeconds: number;
    volume: number;
  };
  activeSeasonId: string;
  seasons: PreparationSeason[];
  profiles: PlayerProfile[];
  positionCatalogue?: TeamPosition[];
  formations: PreparationFormation[];
  fixtures: PreparationFixture[];
  training: PreparationTraining[];
  snapshots: PreparedFixtureSnapshot[];
  matchPlans?: ReusableMatchPlan[];
  lineupTemplates?: SavedLineupTemplate[];
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
    | { type: "position.saved"; position: TeamPosition }
    | { type: "position.archived"; code: string }
    | { type: "team.league_updated"; league: string }
    | {
        type: "team.alerts_updated";
        substitutionAlerts: {
          enabled: boolean;
          leadSeconds: number;
          volume: number;
        };
      }
    | { type: "profile.saved"; profile: PlayerProfile }
    | {
        type: "roster.proforma_imported";
        profiles: PlayerProfile[];
        confirmChanges: true;
      }
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
    | ({ type: "lineup_template.saved" } & LineupTemplateSaveInput)
    | ({ type: "lineup_template.archived" } & LineupTemplateArchiveInput)
    | ({ type: "lineup_template.applied" } & LineupTemplateApplyInput)
    | { type: "lineup_template.cleared"; fixtureId: string }
    | TrainingSeriesPayload
    | ({ type: "match_plan.saved" } & MatchPlanSaveInput)
    | ({ type: "match_plan.applied" } & MatchPlanApplyInput)
    | { type: "match_plan.cleared"; fixtureId: string }
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
    "Choose one of the sample badges.",
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

function validateTraining(
  state: PreparationState,
  training: TrainingDraft,
): void {
  text(training.id, "Training identity", 150);
  dateInSeason(state, training.seasonId, training.date);
  requireThat(
    validTime(training.time) && training.time !== null,
    "Use a 24-hour HH:MM training time.",
  );
  requireThat(
    typeof training.venue === "string" && training.venue.length <= 200,
    "Use a training venue of at most 200 characters.",
  );
  requireThat(
    training.recurrenceGroupId === null ||
      (typeof training.recurrenceGroupId === "string" &&
        training.recurrenceGroupId.trim().length > 0 &&
        training.recurrenceGroupId.length <= 150),
    "Use a valid training series identity.",
  );
  requireThat(
    Array.isArray(training.expectedProfileIds),
    "Choose the expected players explicitly.",
  );
  unique(training.expectedProfileIds);
  training.expectedProfileIds.forEach((id) =>
    checkProfile(state, id, training.seasonId),
  );
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
  if (
    fixture.lineupTemplateDraft &&
    fixture.lineupTemplateDraft.formation.id === formationId
  )
    validateFixtureLineupTemplate(state, fixture);
  if (
    fixture.matchPlanDraft &&
    fixture.matchPlanDraft.formation.id === formationId
  )
    validateFixtureMatchPlan(state, fixture);
  const formation =
    fixture.lineupTemplateDraft &&
    fixture.lineupTemplateDraft.formation.id === formationId
      ? fixture.lineupTemplateDraft.formation
      : fixture.matchPlanDraft &&
          fixture.matchPlanDraft.formation.id === formationId
        ? fixture.matchPlanDraft.formation
        : state.formations.find(
            (item) =>
              item.id === (formationId ?? `formation-${fixture.format}`),
          );
  requireThat(
    formation && formation.format === fixture.format,
    "Choose a saved formation for this match format.",
  );
  assertActiveFormationPositions(state, formation);
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
    matchPlanDraft: _planDraft,
    lineupTemplateDraft: _lineupDraft,
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
    ...(fixture.matchPlanDraft?.formation.id === formation.id
      ? { matchPlanDraft: fixture.matchPlanDraft }
      : {}),
    ...(fixture.lineupTemplateDraft?.formation.id === formation.id
      ? { lineupTemplateDraft: fixture.lineupTemplateDraft }
      : {}),
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
  if (profile.faPlayerId !== undefined)
    profile.faPlayerId = normaliseFaPlayerId(profile.faPlayerId);
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
      profile.preferences.every((position) =>
        allowedProfilePosition(state, position, existing?.preferences),
      ),
    "Choose three different ranked positions.",
  );
  requireThat(
    profile.eligiblePositions.length > 0 &&
      new Set(profile.eligiblePositions).size ===
        profile.eligiblePositions.length &&
      profile.eligiblePositions.every((position) =>
        allowedProfilePosition(state, position, existing?.eligiblePositions),
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
        (Object.keys(profile).length === 10 ||
          (Object.keys(profile).length === 11 &&
            Object.hasOwn(profile, "faPlayerId"))) &&
        Object.keys(profile).every((key) =>
          [
            "id",
            "playerId",
            "seasonId",
            "displayName",
            "initials",
            "shirtNumber",
            "faPlayerId",
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

/** FA identifiers preserve leading zeroes and are never login credentials. */
export function normaliseFaPlayerId(value: unknown): string | null {
  if (value === null || value === "") return null;
  requireThat(
    typeof value === "string" && /^[0-9]{1,20}$/.test(value.trim()),
    "Use an FA player ID of up to 20 digits, or leave it blank.",
  );
  return value.trim();
}
/** Atomic updates use explicit identities from the downloaded team proforma; names never merge players. */
export function validateRosterProformaImport(
  state: PreparationState,
  profiles: PlayerProfile[],
): PlayerProfile[] {
  requireThat(
    Array.isArray(profiles) && profiles.length > 0 && profiles.length <= 200,
    "Import between one and 200 player rows.",
  );
  const ids = new Set<string>(),
    players = new Set<string>();
  for (const profile of profiles) {
    requireThat(
      profile && typeof profile === "object" && !Array.isArray(profile),
      "Use a valid player profile.",
    );
    requireThat(
      Object.keys(profile).every((key) =>
        [
          "id",
          "playerId",
          "seasonId",
          "displayName",
          "initials",
          "shirtNumber",
          "faPlayerId",
          "foot",
          "preferences",
          "eligiblePositions",
          "active",
        ].includes(key),
      ),
      "Use only the documented proforma fields.",
    );
    requireThat(
      profile.active === true && profile.seasonId === state.activeSeasonId,
      "Import active players into the current season only.",
    );
    requireThat(
      !ids.has(profile.id) && !players.has(profile.playerId),
      "Each player may appear only once in a proforma.",
    );
    ids.add(profile.id);
    players.add(profile.playerId);
    for (const value of [profile.id, profile.playerId])
      requireThat(
        typeof value === "string" && /^[A-Za-z0-9_.:-]{1,150}$/.test(value),
        "Use a valid opaque player/profile identity.",
      );
    const byId = state.profiles.find((item) => item.id === profile.id);
    const byPlayer = state.profiles.find(
      (item) =>
        item.playerId === profile.playerId &&
        item.seasonId === state.activeSeasonId,
    );
    if (byId || byPlayer)
      requireThat(
        byId &&
          byPlayer &&
          byId.id === byPlayer.id &&
          byId.playerId === profile.playerId &&
          byId.seasonId === state.activeSeasonId &&
          byId.active,
        "An existing player must retain their downloaded profile and player identities.",
      );
    else
      requireThat(
        !state.profiles.some((item) => item.playerId === profile.playerId),
        "A new row cannot adopt a player identity from another season.",
      );
    requireThat(
      Array.isArray(profile.preferences) &&
        Array.isArray(profile.eligiblePositions),
      "Provide preferences and eligible positions.",
    );
  }
  const candidate = clone(state);
  candidate.profiles = candidate.profiles.filter((item) => !ids.has(item.id));
  return profiles.map((profile) => saveProfile(candidate, profile));
}

export function reducePreparation(
  previous: PreparationState,
  command: PreparationCommand,
  context: MatchPlanContext = {},
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
    case "position.saved":
      state.positionCatalogue = saveTeamPosition(state, command.position);
      break;
    case "position.archived":
      state.positionCatalogue = archiveTeamPosition(state, command.code);
      break;
    case "club.updated":
      validateLogo(command.logo);
      state.club = {
        ...state.club,
        name: text(command.name, "Club name"),
        logo: command.logo,
      };
      break;
    case "team.league_updated":
      requireThat(
        typeof command.league === "string" &&
          command.league.trim().length <= 120 &&
          !/[\u0000-\u001f]/.test(command.league),
        "Use a league name of at most 120 characters, or leave it blank.",
      );
      state.team.league = command.league.trim();
      break;
    case "team.alerts_updated": {
      const settings = command.substitutionAlerts;
      requireThat(
        settings &&
          typeof settings === "object" &&
          Object.keys(settings).length === 3 &&
          typeof settings.enabled === "boolean" &&
          Number.isInteger(settings.leadSeconds) &&
          settings.leadSeconds >= 0 &&
          settings.leadSeconds <= 300 &&
          Number.isFinite(settings.volume) &&
          settings.volume >= 0 &&
          settings.volume <= 1,
        "Use substitution alert lead time from zero to 300 seconds and volume from zero to 100%.",
      );
      state.substitutionAlerts = {
        enabled: settings.enabled,
        leadSeconds: settings.leadSeconds,
        volume: settings.volume,
      };
      break;
    }
    case "roster.proforma_imported": {
      requireThat(
        command.confirmChanges === true,
        "Review and confirm all new and updated player rows.",
      );
      const imported = validateRosterProformaImport(state, command.profiles);
      const ids = new Set(imported.map((profile) => profile.id));
      state.profiles = [
        ...state.profiles.filter((profile) => !ids.has(profile.id)),
        ...imported,
      ];
      break;
    }
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
      assertActiveFormationPositions(state, formation);
      for (const slot of formation.slots) {
        requireThat(
          slot.id.length > 0 &&
            activePositionCodes(state).includes(slot.position),
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
        ...(existing?.matchPlanDraft
          ? { matchPlanDraft: existing.matchPlanDraft }
          : {}),
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
      applyTrainingSeries(state, command, (draft) =>
        validateTraining(state, draft),
      );
      break;
    }
    case "lineup_template.saved":
      state.lineupTemplates = [
        ...(state.lineupTemplates ?? []),
        saveLineupTemplate(state, command),
      ];
      break;
    case "lineup_template.archived":
      state.lineupTemplates = [
        ...(state.lineupTemplates ?? []),
        archiveLineupTemplate(state, command),
      ];
      break;
    case "lineup_template.applied": {
      const draft = applyLineupTemplate(state, command, context);
      const fixture = state.fixtures.find(
        (item) => item.id === command.fixtureId,
      )!;
      fixture.lineupTemplateDraft = draft;
      fixture.selectedProfileIds = draft.selectedPlayerIds.map(
        (playerId) =>
          state.profiles.find(
            (profile) =>
              profile.playerId === playerId &&
              profile.seasonId === fixture.seasonId &&
              profile.active,
          )!.id,
      );
      delete fixture.matchPlanDraft;
      break;
    }
    case "lineup_template.cleared": {
      const fixture = state.fixtures.find(
        (item) => item.id === command.fixtureId,
      );
      requireThat(
        fixture &&
          fixture.seasonId === state.activeSeasonId &&
          fixture.status === "scheduled",
        "Choose a scheduled fixture in the current season.",
      );
      requireThat(
        !context.protectedFixtureIds?.includes(fixture.id),
        "A saved or recorded match keeps its prepared lineup.",
      );
      delete fixture.lineupTemplateDraft;
      break;
    }
    case "match_plan.saved": {
      const {
        type: _type,
        id: _id,
        expectedRevision: _revision,
        ...input
      } = command;
      const plan = saveMatchPlan(state, input);
      state.matchPlans = [...(state.matchPlans ?? []), plan];
      break;
    }
    case "match_plan.applied": {
      const {
        type: _type,
        id: _id,
        expectedRevision: _revision,
        ...input
      } = command;
      const draft = applyMatchPlan(state, input, context);
      state.fixtures.find(
        (item) => item.id === command.fixtureId,
      )!.matchPlanDraft = draft;
      delete state.fixtures.find((item) => item.id === command.fixtureId)!
        .lineupTemplateDraft;
      break;
    }
    case "match_plan.cleared": {
      const fixture = state.fixtures.find(
        (item) => item.id === command.fixtureId,
      );
      requireThat(
        fixture && fixture.seasonId === state.activeSeasonId,
        "Choose a fixture in the current season.",
      );
      delete fixture.matchPlanDraft;
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
    sourcePreparationRevision: state.revision,
    sourceCommandId: state.audit.at(-1)?.id ?? null,
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

export function createPreparationState(
  options: { demoScenario?: boolean } = {},
): PreparationState {
  const seasonId = "synthetic-season-2026-27";
  const profiles: PlayerProfile[] = Array.from({ length: 13 }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    const details = romaFixture.profiles.find(
      (profile) => profile.playerId === `synthetic-player-${number}`,
    )!;
    const preferences = [...details.preferences] as PositionCode[];
    return {
      id: `synthetic-player-${number}:${seasonId}`,
      playerId: `synthetic-player-${number}`,
      seasonId,
      displayName: romaFixture.players[index].displayName,
      initials: details.initials,
      shirtNumber: details.shirtNumber,
      foot: details.foot as PlayerProfile["foot"],
      preferences,
      eligiblePositions: [...details.eligiblePositions] as PositionCode[],
      active: true,
    };
  });
  const fixtures: PreparationFixture[] = romaFixture.fixtures.map(
    (item, index) => {
      const selected = options.demoScenario
        ? item.selectedPlayerIds.map(
            (playerId) =>
              profiles.find((profile) => profile.playerId === playerId)!,
          )
        : profiles.slice(0, item.selectedCount);
      const past = item.playedDate < romaFixture.demo.referenceDate;
      return {
        id: item.id,
        seasonId,
        opponent: item.opponent,
        playedDate: item.playedDate,
        kickoff: item.kickoff,
        arrival: item.arrival,
        venue: item.venue,
        homeAway: item.homeAway as PreparationFixture["homeAway"],
        format: 7,
        plannedHalfDurationMs: 1_500_000,
        status: item.status as PreparationFixture["status"],
        selectedProfileIds: selected.map((profile) => profile.id),
        responses: Object.fromEntries(
          profiles.flatMap(
            (profile, playerIndex): [string, AvailabilityResponse][] => {
              if (index === 0)
                return playerIndex < 9 ? [[profile.id, "available"]] : [];
              if (past)
                return [
                  [
                    profile.id,
                    selected.some((item) => item.id === profile.id)
                      ? "available"
                      : "unavailable",
                  ],
                ];
              return playerIndex < 6
                ? [[profile.id, "available"]]
                : playerIndex === 6
                  ? [[profile.id, "unsure"]]
                  : playerIndex === 10
                    ? [[profile.id, "unavailable"]]
                    : [];
            },
          ),
        ),
        attendance: past
          ? Object.fromEntries(
              selected.map((profile) => [profile.id, "present"]),
            )
          : {},
        history: [
          {
            revision: 0,
            action: "created",
            playedDate: item.playedDate,
            kickoff: item.kickoff,
            status: item.status as PreparationFixture["status"],
          },
        ],
      };
    },
  );
  const training: PreparationTraining[] = romaFixture.training.map(
    (item, sessionIndex) => ({
      ...item,
      seasonId,
      recurrenceGroupId: "synthetic-thursday-training",
      status: item.status as PreparationTraining["status"],
      expectedProfileIds: profiles.map((profile) => profile.id),
      responses:
        item.status === "held"
          ? Object.fromEntries(
              profiles.map((profile, index) => [
                profile.id,
                index === (sessionIndex + 3) % 13 ? "unavailable" : "available",
              ]),
            )
          : {},
      attendance:
        item.status === "held"
          ? Object.fromEntries(
              profiles.map((profile, index) => [
                profile.id,
                index === (sessionIndex + 3) % 13 ? "absent" : "present",
              ]),
            )
          : {},
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
    positionCatalogue: defaultPositionCatalogue(),
    formations: Array.from({ length: 7 }, (_, index) =>
      defaultFormation(index + 5),
    ),
    fixtures,
    training,
    snapshots: [],
    appliedCommands: {},
    audit: [],
  };
}
