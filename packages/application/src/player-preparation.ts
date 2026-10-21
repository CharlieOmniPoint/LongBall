import {
  positionCodes,
  type AvailabilityResponse,
  type PlayerProfile,
  type PreparationAttendance,
  type PreparationFixture,
  type PreparationSeason,
  type PreparationState,
} from "./preparation";

export type PlayerFixtureDetails = {
  arrival: string | null;
  kickoff: string | null;
  format: number | null;
  plannedHalfDurationMs: number | null;
};
export type OwnPlayerPreparation = {
  kind: "player-preparation";
  revision: number;
  team: { id: string; name: string; ageGroup: string };
  season: PreparationSeason;
  profile: PlayerProfile;
  fixtures: (PlayerFixtureDetails & {
    id: string;
    opponent: string;
    playedDate: string;
    venue: string;
    homeAway: "home" | "away";
    status: PreparationFixture["status"];
    response: AvailabilityResponse;
    selected: boolean;
    attendance: PreparationAttendance;
  })[];
  training: {
    id: string;
    date: string;
    time: string | null;
    venue: string;
    status: "scheduled" | "held" | "cancelled";
    expected: boolean;
    response: AvailabilityResponse;
    attendance: PreparationAttendance;
  }[];
};
const time = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const format = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 5 && Number(value) <= 11;
const half = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  Number(value) > 0 &&
  Number(value) % 1000 === 0;
/** Call only after the service has verified the current own-player membership. Never project roster maps or manager plans. */
export function projectOwnPlayerPreparation(
  state: PreparationState,
  profile: PlayerProfile,
  seasonId: string,
): OwnPlayerPreparation {
  const season = state.seasons.find((item) => item.id === seasonId);
  if (
    !season ||
    !profile.active ||
    profile.seasonId !== seasonId ||
    !state.profiles.some(
      (item) =>
        item.id === profile.id &&
        item.playerId === profile.playerId &&
        item.seasonId === seasonId &&
        item.active,
    )
  )
    throw new Error("The authorised own-player preparation is unavailable.");
  return {
    kind: "player-preparation",
    revision: state.revision,
    team: {
      id: state.team.id,
      name: state.team.name,
      ageGroup: state.team.ageGroup,
    },
    season: {
      id: season.id,
      label: season.label,
      startYear: season.startYear,
      startDate: season.startDate,
      endDate: season.endDate,
      spectatorRenewalRequired: true,
    },
    profile: {
      id: profile.id,
      playerId: profile.playerId,
      seasonId: profile.seasonId,
      displayName: profile.displayName,
      initials: profile.initials,
      shirtNumber: profile.shirtNumber,
      foot: profile.foot,
      preferences: [...profile.preferences],
      eligiblePositions: [...profile.eligiblePositions],
      active: profile.active,
    },
    fixtures: state.fixtures
      .filter((item) => item.seasonId === seasonId)
      .map((item) => ({
        id: item.id,
        opponent: item.opponent,
        playedDate: item.playedDate,
        kickoff: time(item.kickoff) ? item.kickoff : null,
        arrival: time(item.arrival) ? item.arrival : null,
        venue: item.venue,
        homeAway: item.homeAway,
        status: item.status,
        format: format(item.format) ? item.format : null,
        plannedHalfDurationMs: half(item.plannedHalfDurationMs)
          ? item.plannedHalfDurationMs
          : null,
        response: item.responses[profile.id] ?? "no_reply",
        selected: item.selectedProfileIds.includes(profile.id),
        attendance: item.attendance[profile.id] ?? "not_recorded",
      })),
    training: state.training
      .filter((item) => item.seasonId === seasonId)
      .map((item) => ({
        id: item.id,
        date: item.date,
        time: time(item.time) ? item.time : null,
        venue: item.venue,
        status: item.status,
        expected: item.expectedProfileIds.includes(profile.id),
        response: item.responses[profile.id] ?? "no_reply",
        attendance: item.attendance[profile.id] ?? "not_recorded",
      })),
  };
}
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const text = (value: unknown): value is string => typeof value === "string";
const member = (value: unknown, values: readonly string[]) =>
  typeof value === "string" && values.includes(value);
const responses = ["available", "unavailable", "unsure", "no_reply"];
const attendance = ["present", "absent", "not_recorded"];
/** Reject private extras and a response from another team/season/player before attaching it to the current UI. */
export function parseOwnPlayerPreparation(
  value: unknown,
  scope: { teamId: string; seasonId: string; playerId: string },
): OwnPlayerPreparation {
  const fail = (): never => {
    throw new Error(
      "The saved player schedule does not match this authorised own-player view.",
    );
  };
  if (
    !object(value) ||
    !exact(value, [
      "kind",
      "revision",
      "team",
      "season",
      "profile",
      "fixtures",
      "training",
    ]) ||
    value.kind !== "player-preparation" ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0
  )
    return fail();
  const { team, season, profile } = value;
  if (
    !object(team) ||
    !exact(team, ["id", "name", "ageGroup"]) ||
    team.id !== scope.teamId ||
    !text(team.name) ||
    !text(team.ageGroup)
  )
    return fail();
  if (
    !object(season) ||
    !exact(season, [
      "id",
      "label",
      "startYear",
      "startDate",
      "endDate",
      "spectatorRenewalRequired",
    ]) ||
    season.id !== scope.seasonId ||
    !text(season.label) ||
    !Number.isInteger(season.startYear) ||
    !text(season.startDate) ||
    !text(season.endDate) ||
    season.spectatorRenewalRequired !== true
  )
    return fail();
  if (
    !object(profile) ||
    !exact(profile, [
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
    ]) ||
    !text(profile.id) ||
    profile.playerId !== scope.playerId ||
    profile.seasonId !== scope.seasonId ||
    profile.active !== true ||
    !text(profile.displayName) ||
    !text(profile.initials) ||
    (profile.shirtNumber !== null &&
      (!Number.isSafeInteger(profile.shirtNumber) ||
        Number(profile.shirtNumber) < 1)) ||
    !member(profile.foot, ["left", "right", "both", "not_recorded"]) ||
    ![profile.preferences, profile.eligiblePositions].every(
      (items) =>
        Array.isArray(items) &&
        items.every((item) => member(item, positionCodes)),
    )
  )
    return fail();
  if (!Array.isArray(value.fixtures) || !Array.isArray(value.training))
    return fail();
  for (const item of value.fixtures) {
    if (
      !object(item) ||
      !exact(item, [
        "id",
        "opponent",
        "playedDate",
        "kickoff",
        "arrival",
        "venue",
        "homeAway",
        "status",
        "format",
        "plannedHalfDurationMs",
        "response",
        "selected",
        "attendance",
      ]) ||
      ![item.id, item.opponent, item.playedDate, item.venue].every(text) ||
      !member(item.homeAway, ["home", "away"]) ||
      !member(item.status, ["scheduled", "postponed", "cancelled"]) ||
      !member(item.response, responses) ||
      !member(item.attendance, attendance) ||
      typeof item.selected !== "boolean" ||
      (item.kickoff !== null && !time(item.kickoff)) ||
      (item.arrival !== null && !time(item.arrival)) ||
      (item.format !== null && !format(item.format)) ||
      (item.plannedHalfDurationMs !== null && !half(item.plannedHalfDurationMs))
    )
      return fail();
  }
  for (const item of value.training) {
    if (
      !object(item) ||
      !exact(item, [
        "id",
        "date",
        "time",
        "venue",
        "status",
        "expected",
        "response",
        "attendance",
      ]) ||
      ![item.id, item.date, item.venue].every(text) ||
      (item.time !== null && !time(item.time)) ||
      !member(item.status, ["scheduled", "held", "cancelled"]) ||
      !member(item.response, responses) ||
      !member(item.attendance, attendance) ||
      typeof item.expected !== "boolean"
    )
      return fail();
  }
  if (
    new Set(value.fixtures.map((item) => item.id)).size !==
      value.fixtures.length ||
    new Set(value.training.map((item) => item.id)).size !==
      value.training.length
  )
    return fail();
  return value as OwnPlayerPreparation;
}
/** Only recorded fixture values are shown; team defaults never fill missing historic fields. */
export function playerFixtureDetailLabels(
  details: Partial<PlayerFixtureDetails>,
) {
  const duration = half(details.plannedHalfDurationMs)
    ? details.plannedHalfDurationMs / 1000
    : null;
  const durationText =
    duration === null
      ? null
      : `${Math.floor(duration / 60)} min${duration % 60 ? ` ${duration % 60} sec` : ""}`;
  return {
    arrival: `Arrival: ${time(details.arrival) ? details.arrival : "Not recorded"}`,
    kickoff: `Kick-off: ${time(details.kickoff) ? details.kickoff : "Not recorded"}`,
    format: `Format: ${format(details.format) ? `${details.format}-a-side` : "Not recorded"}`,
    duration: `Planned duration: ${durationText === null ? "Not recorded" : `2 × ${durationText}`}`,
  };
}
