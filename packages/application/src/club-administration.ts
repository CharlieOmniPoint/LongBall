import { AccessError, assertAdultAuthority, type Principal } from "./access";
import { createPreparationState, type PreparationState } from "./preparation";
import { createRecordsSeed } from "./records";
import { createCommunityState } from "./community";

export interface ClubDirectoryClub {
  id: string;
  name: string;
}
export interface ClubDirectoryTeam {
  id: string;
  clubId: string;
  name: string;
  ageGroup: string;
  seasonId: string;
  seasonLabel: string;
  leagueName: string;
}
export interface ClubAdministrationDto {
  kind: "club-administration";
  administration: NonNullable<Principal["administration"]>;
  clubs: ClubDirectoryClub[];
  teams: ClubDirectoryTeam[];
  administrators: {
    accountId: string;
    level: "super" | "club";
    clubId: string | null;
  }[];
  candidates: { accountId: string; label: string }[];
}
export type ClubAdministrationCommand =
  | { type: "club.create"; name: string }
  | {
      type: "team.create";
      clubId: string;
      name: string;
      ageGroup: string;
      format: number;
      seasonStartYear: number;
    }
  | {
      type: "administrator.grant";
      accountId: string;
      level: "super" | "club";
      clubId: string | null;
    }
  | {
      type: "administrator.revoke";
      accountId: string;
      level: "super" | "club";
      clubId: string | null;
    };
const text = (value: unknown, max = 100): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(value);
export function parseClubAdministrationCommand(
  value: unknown,
): ClubAdministrationCommand {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AccessError(
      "INVALID_REQUEST",
      400,
      "Choose a club administration operation.",
    );
  const v = value as Record<string, unknown>;
  const fields =
    v.type === "club.create"
      ? ["type", "name"]
      : v.type === "team.create"
        ? ["type", "clubId", "name", "ageGroup", "format", "seasonStartYear"]
        : ["type", "accountId", "level", "clubId"];
  if (
    Object.keys(v).length !== fields.length ||
    Object.keys(v).some((k) => !fields.includes(k))
  )
    throw new AccessError(
      "INVALID_REQUEST",
      400,
      "Use only the documented club administration fields.",
    );
  if (v.type === "club.create" && text(v.name))
    return { type: v.type, name: v.name.trim() };
  if (
    v.type === "team.create" &&
    text(v.clubId, 150) &&
    text(v.name) &&
    typeof v.ageGroup === "string" &&
    /^U(?:[5-9]|1[0-9]|2[01])$/.test(v.ageGroup) &&
    Number.isInteger(v.format) &&
    Number(v.format) >= 5 &&
    Number(v.format) <= 11 &&
    Number.isInteger(v.seasonStartYear) &&
    Number(v.seasonStartYear) >= 2000 &&
    Number(v.seasonStartYear) <= 2100
  )
    return {
      ...v,
      name: v.name.trim(),
    } as unknown as ClubAdministrationCommand;
  if (
    ["administrator.grant", "administrator.revoke"].includes(String(v.type)) &&
    text(v.accountId, 150) &&
    ((v.level === "super" && v.clubId === null) ||
      (v.level === "club" && text(v.clubId, 150)))
  )
    return v as unknown as ClubAdministrationCommand;
  throw new AccessError(
    "INVALID_REQUEST",
    400,
    "Enter a club/team name, U5–U21 age group and valid team format.",
  );
}
export function assertClubAdministration(
  principal: Principal,
  clubId?: string,
  superOnly = false,
  now = Date.now(),
): void {
  assertAdultAuthority(principal, superOnly, now);
  const scope = principal.administration;
  if (
    !scope ||
    (superOnly && scope.level !== "super") ||
    (clubId && scope.level !== "super" && !scope.clubIds.includes(clubId))
  )
    throw new AccessError(
      "NOT_FOUND",
      404,
      "The requested club administration scope is unavailable.",
    );
}
export function administrationLabel(
  principal: Principal,
): "Super Admin" | "Club Admin" {
  return principal.administration?.level === "super"
    ? "Super Admin"
    : "Club Admin";
}
/** A new team starts empty; no Roma children, matches, grants or publication approvals leak into it. */
export function emptyTeamDocuments(input: {
  club: ClubDirectoryClub;
  teamId: string;
  name: string;
  ageGroup: string;
  format: number;
  seasonStartYear: number;
  nowMs: number;
}) {
  const base = createPreparationState(),
    year = input.seasonStartYear,
    seasonId = `season-${year}-${year + 1}`,
    label = `${year}/${String(year + 1).slice(-2)}`;
  const preparation: PreparationState = {
    ...base,
    club: { id: input.club.id, name: input.club.name, logo: null },
    team: {
      ...base.team,
      id: input.teamId,
      name: input.name,
      ageGroup: input.ageGroup,
      defaultPitchPlaces: input.format,
      logo: null,
    },
    activeSeasonId: seasonId,
    seasons: [
      {
        id: seasonId,
        label,
        startYear: year,
        startDate: `${year}-09-01`,
        endDate: `${year + 1}-08-31`,
        spectatorRenewalRequired: true,
      },
    ],
    profiles: [],
    fixtures: [],
    training: [],
    snapshots: [],
    matchPlans: [],
    lineupTemplates: [],
    appliedCommands: {},
    audit: [],
  };
  const r = createRecordsSeed();
  const records = {
    ...r,
    clubId: input.club.id,
    teamId: input.teamId,
    seasonId,
    seasonLabel: label,
    startsOn: `${year}-09-01`,
    endsOn: `${year + 1}-08-31`,
    players: [],
    results: [],
    trainingAttendance: [],
    gamePreparation: [],
    audit: [],
    appliedCommands: {},
    liveMatch: {
      matchId: `unprepared-${input.teamId}`,
      playedDate: `${year}-09-01`,
      opponent: "",
      homeAway: "home" as const,
      fixtureClass: "unclassified" as const,
    },
  };
  const c = createCommunityState(input.nowMs);
  const community = {
    ...c,
    accounts: [],
    memberships: [],
    seasons: [
      {
        id: seasonId,
        teamId: input.teamId,
        label,
        teamLabel: `${input.name} ${input.ageGroup}`,
        accessEndsAtMs: Date.parse(`${year + 1}-08-31T23:00:00Z`),
      },
    ],
    invitations: [],
    grants: [],
    matches: [],
    ballots: [],
    awards: [],
    photos: [],
    concerns: [],
    hiddenUploaders: [],
    preferences: {},
    privacyRequests: [],
    audit: [],
    appliedCommands: {},
  };
  return { seasonId, label, preparation, records, community };
}

export interface ClubReportRow extends ClubDirectoryTeam {
  players: number;
  completedGames: number;
  scoredGames: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
}
export interface ClubReportDto {
  kind: "club-report";
  club: ClubDirectoryClub;
  teams: ClubReportRow[];
}
