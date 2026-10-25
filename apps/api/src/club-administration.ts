import { randomUUID } from "node:crypto";
import {
  AccessError,
  type Principal,
} from "../../../packages/application/src/access";
import {
  assertClubAdministration,
  emptyTeamDocuments,
  parseClubAdministrationCommand,
  type ClubAdministrationDto,
} from "../../../packages/application/src/club-administration";
import type { DevelopmentStore } from "./store";
import type { PostgresStore } from "./postgres-store";
import { demoAccountLabels } from "../../../packages/testing/src/index";

export const ADMINISTRATION_SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS administration_grants(account_id TEXT NOT NULL REFERENCES accounts(id),scope_key TEXT NOT NULL,level TEXT NOT NULL CHECK(level IN('super','club')),club_id TEXT,PRIMARY KEY(account_id,scope_key),CHECK((level='super' AND club_id IS NULL AND scope_key='*') OR (level='club' AND club_id=scope_key)));
CREATE TABLE IF NOT EXISTS administrative_memberships(account_id TEXT NOT NULL,team_id TEXT NOT NULL,season_id TEXT NOT NULL,role TEXT NOT NULL,PRIMARY KEY(account_id,team_id,season_id,role),FOREIGN KEY(account_id,team_id,season_id,role) REFERENCES memberships(account_id,team_id,season_id,role) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS directory_clubs(id TEXT PRIMARY KEY,name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS directory_teams(team_id TEXT PRIMARY KEY REFERENCES teams(id),club_id TEXT NOT NULL REFERENCES directory_clubs(id),age_group TEXT NOT NULL);
`;
type Source = DevelopmentStore | PostgresStore;
const isPg = (source: Source): source is PostgresStore => "db" in source;
/** Label-only adapter after authorisation; known review identities do not define production names. */
export function administrationDisplayLabels(value: ClubAdministrationDto, principal: Pick<Principal, 'issuer'>): ClubAdministrationDto {
  if (principal.issuer !== 'urn:longball:synthetic') return value;
  return { ...value, candidates: value.candidates.map(candidate => ({ ...candidate, label: Object.hasOwn(demoAccountLabels, candidate.accountId) ? demoAccountLabels[candidate.accountId] : candidate.label })).sort((left, right) => left.label.localeCompare(right.label, 'en-GB') || left.accountId.localeCompare(right.accountId)) };
}
export function sqliteAdministration(
  source: DevelopmentStore,
  accountId: string,
): Principal["administration"] {
  const grants = source.database
    .prepare(
      "SELECT level,club_id FROM administration_grants WHERE account_id=?",
    )
    .all(accountId) as { level: "super" | "club"; club_id: string | null }[];
  return !grants.length
    ? undefined
    : {
        level: grants.some((g) => g.level === "super") ? "super" : "club",
        clubIds: grants.flatMap((g) => (g.club_id ? [g.club_id] : [])),
      };
}
export function syncSqliteAdministration(source: DevelopmentStore): void {
  const db = source.database;
  db.exec(
    `DELETE FROM memberships WHERE EXISTS(SELECT 1 FROM administrative_memberships a WHERE a.account_id=memberships.account_id AND a.team_id=memberships.team_id AND a.season_id=memberships.season_id AND a.role=memberships.role);`,
  );
  const desired = db
    .prepare(
      `SELECT DISTINCT g.account_id,d.team_id,d.season_id,r.role FROM administration_grants g JOIN (SELECT DISTINCT team_id,season_id FROM documents) d JOIN directory_teams t ON t.team_id=d.team_id JOIN (SELECT 'administrator' role UNION ALL SELECT 'manager')r WHERE g.level='super' OR g.club_id=t.club_id`,
    )
    .all() as {
    account_id: string;
    team_id: string;
    season_id: string;
    role: string;
  }[];
  for (const row of desired) {
    const result = db
      .prepare(
        "INSERT INTO memberships(account_id,team_id,season_id,role) VALUES(?,?,?,?) ON CONFLICT(account_id,team_id,season_id,role) DO NOTHING",
      )
      .run(row.account_id, row.team_id, row.season_id, row.role);
    if (result.changes)
      db.prepare(
        "INSERT INTO administrative_memberships(account_id,team_id,season_id,role) VALUES(?,?,?,?)",
      ).run(row.account_id, row.team_id, row.season_id, row.role);
  }
  db.exec(
    `UPDATE controller_grants SET frozen=1 WHERE NOT EXISTS(SELECT 1 FROM memberships m WHERE m.account_id=controller_grants.account_id AND m.team_id=(SELECT team_id FROM matches WHERE id=controller_grants.match_id) AND m.season_id=(SELECT season_id FROM matches WHERE id=controller_grants.match_id) AND m.role='manager' AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>${source.now()}));`,
  );
}
export class ClubAdministrationService {
  constructor(private readonly source: Source) {}
  async view(principal: Principal): Promise<ClubAdministrationDto> {
    assertClubAdministration(principal, undefined, false, this.source.now());
    if (isPg(this.source)) {
      const row = await this.source.one(
        "SELECT longball.administration_directory() AS value",
      );
      if (!row?.value)
        throw new AccessError(
          "NOT_FOUND",
          404,
          "Club administration is unavailable.",
        );
      return administrationDisplayLabels(typeof row.value === "string"
        ? JSON.parse(row.value)
        : (row.value as ClubAdministrationDto), principal);
    }
    const db = this.source.database,
      scope = sqliteAdministration(this.source, principal.accountId);
    if (!scope)
      throw new AccessError(
        "NOT_FOUND",
        404,
        "Club administration is unavailable.",
      );
    const clubs = (
      db
        .prepare("SELECT id,name FROM directory_clubs ORDER BY name,id")
        .all() as { id: string; name: string }[]
    ).filter((c) => scope.level === "super" || scope.clubIds.includes(c.id));
    const ids = new Set(clubs.map((c) => c.id));
    const teams = (
      db
        .prepare(
          `SELECT t.id,COALESCE(json_extract(s.value_json,'$.team.name'),t.name) name,d.club_id clubId,COALESCE(json_extract(s.value_json,'$.team.ageGroup'),d.age_group) ageGroup,s.season_id seasonId,COALESCE(json_extract(s.value_json,'$.seasons[0].label'),s.season_id) seasonLabel,COALESCE(json_extract(s.value_json,'$.team.league'),'') leagueName FROM directory_teams d JOIN teams t ON t.id=d.team_id JOIN documents s ON s.team_id=t.id AND s.kind='preparation' ORDER BY d.age_group,t.name,t.id`,
        )
        .all() as unknown as ClubAdministrationDto["teams"]
    ).filter((t) => ids.has(t.clubId));
    const administrators = (
      db
        .prepare(
          "SELECT account_id accountId,level,club_id clubId FROM administration_grants ORDER BY account_id,scope_key",
        )
        .all() as ClubAdministrationDto["administrators"]
    ).filter(
      (g) =>
        scope.level === "super" || (g.clubId !== null && ids.has(g.clubId)),
    );
    const candidates =
      scope.level === "super"
        ? (db
            .prepare(
              "SELECT id accountId,subject label FROM accounts WHERE status='active' AND classification='adult_individual' AND adult_verified=1 AND strong_auth_enrolled=1 ORDER BY subject",
            )
            .all() as ClubAdministrationDto["candidates"])
        : [];
    return administrationDisplayLabels({
      kind: "club-administration",
      administration: scope,
      clubs,
      teams,
      administrators,
      candidates,
    }, principal);
  }
  async authorizeCommand(principal: Principal, input: unknown): Promise<void> {
    const fresh = await this.source.principal({
      issuer: principal.issuer,
      subject: principal.subject,
      strongAuth: principal.strongAuth,
      authenticatedAt: principal.authenticatedAt,
    });
    const command = parseClubAdministrationCommand(input);
    assertClubAdministration(
      fresh,
      command.type === "team.create" ? command.clubId : undefined,
      command.type !== "team.create",
      this.source.now(),
    );
  }
  async command(
    principal: Principal,
    input: unknown,
  ): Promise<ClubAdministrationDto> {
    principal = await this.source.principal({
      issuer: principal.issuer,
      subject: principal.subject,
      strongAuth: principal.strongAuth,
      authenticatedAt: principal.authenticatedAt,
    });
    const command = parseClubAdministrationCommand(input);
    assertClubAdministration(
      principal,
      command.type === "team.create" ? command.clubId : undefined,
      command.type !== "team.create",
      this.source.now(),
    );
    const id = randomUUID();
    if (isPg(this.source)) {
      if (
        command.type === "administrator.grant" ||
        command.type === "administrator.revoke"
      ) {
        const directory = await this.view(principal);
        if (
          !directory.candidates.some((c) => c.accountId === command.accountId)
        )
          throw new AccessError(
            "ADULT_AUTHORITY_REQUIRED",
            403,
            "Choose an existing verified adult administrator account.",
          );
        if (
          command.clubId &&
          !directory.clubs.some((c) => c.id === command.clubId)
        )
          throw new AccessError("NOT_FOUND", 404, "The club is unavailable.");
        if (
          command.type === "administrator.revoke" &&
          command.level === "super" &&
          directory.administrators.filter((a) => a.level === "super").length <=
            1
        )
          throw new AccessError(
            "LAST_SUPER_ADMIN",
            409,
            "Keep at least one Super Admin.",
          );
      }
      let documents: ReturnType<typeof emptyTeamDocuments> | null = null;
      if (command.type === "team.create") {
        const view = await this.view(principal),
          club = view.clubs.find((c) => c.id === command.clubId);
        if (!club)
          throw new AccessError("NOT_FOUND", 404, "The club is unavailable.");
        documents = emptyTeamDocuments({
          club,
          teamId: id,
          ...command,
          nowMs: this.source.now(),
        });
      }
      await this.source.execute(
        "SELECT longball.administration_command($1::jsonb,$2::text,$3::jsonb)",
        [JSON.stringify(command), id, JSON.stringify(documents)],
      );
      return this.view(principal);
    }
    const source = this.source,
      db = source.database;
    if (command.type === "club.create")
      db.prepare("INSERT INTO directory_clubs(id,name) VALUES(?,?)").run(
        id,
        command.name,
      );
    else if (command.type === "team.create") {
      const club = db
        .prepare("SELECT id,name FROM directory_clubs WHERE id=?")
        .get(command.clubId) as { id: string; name: string } | undefined;
      if (!club)
        throw new AccessError("NOT_FOUND", 404, "The club is unavailable.");
      const docs = emptyTeamDocuments({
        club,
        teamId: id,
        ...command,
        nowMs: source.now(),
      });
      db.prepare("INSERT INTO teams(id,name) VALUES(?,?)").run(
        id,
        command.name,
      );
      db.prepare(
        "INSERT INTO directory_teams(team_id,club_id,age_group) VALUES(?,?,?)",
      ).run(id, club.id, command.ageGroup);
      for (const kind of ["preparation", "records", "community"] as const)
        source.saveDocument(id, docs.seasonId, kind, docs[kind]);
    } else {
      const target = db
        .prepare("SELECT * FROM accounts WHERE id=?")
        .get(command.accountId) as
        | {
            classification: string;
            adult_verified: number;
            strong_auth_enrolled: number;
            status: string;
          }
        | undefined;
      if (
        !target ||
        target.classification !== "adult_individual" ||
        target.adult_verified !== 1 ||
        target.strong_auth_enrolled !== 1 ||
        target.status !== "active"
      )
        throw new AccessError(
          "ADULT_AUTHORITY_REQUIRED",
          403,
          "Choose an existing verified adult administrator account.",
        );
      if (
        command.clubId &&
        !db
          .prepare("SELECT id FROM directory_clubs WHERE id=?")
          .get(command.clubId)
      )
        throw new AccessError("NOT_FOUND", 404, "The club is unavailable.");
      if (command.type === "administrator.grant")
        db.prepare(
          "INSERT INTO administration_grants(account_id,scope_key,level,club_id) VALUES(?,?,?,?) ON CONFLICT(account_id,scope_key) DO NOTHING",
        ).run(
          command.accountId,
          command.clubId ?? "*",
          command.level,
          command.clubId,
        );
      else {
        if (
          command.level === "super" &&
          Number(
            (
              db
                .prepare(
                  "SELECT count(*) n FROM administration_grants WHERE level='super'",
                )
                .get() as { n: number }
            ).n,
          ) <= 1
        )
          throw new AccessError(
            "LAST_SUPER_ADMIN",
            409,
            "Keep at least one Super Admin.",
          );
        db.prepare(
          "DELETE FROM administration_grants WHERE account_id=? AND scope_key=?",
        ).run(command.accountId, command.clubId ?? "*");
      }
    }
    syncSqliteAdministration(source);
    source.audit(
      principal,
      command.type,
      command.type === "team.create" || command.type === "club.create"
        ? id
        : command.accountId,
      "accepted",
    );
    return this.view({
      ...principal,
      administration: sqliteAdministration(source, principal.accountId),
    });
  }
  async reports(principal: Principal, clubId: string) {
    assertClubAdministration(principal, clubId, false, this.source.now());
    if (isPg(this.source)) {
      const row = await this.source.one(
        "SELECT longball.club_report($1) value",
        [clubId],
      );
      if (!row?.value)
        throw new AccessError(
          "NOT_FOUND",
          404,
          "The requested club report is unavailable.",
        );
      return typeof row.value === "string" ? JSON.parse(row.value) : row.value;
    }
    const view = await this.view(principal),
      club = view.clubs.find((c) => c.id === clubId);
    if (!club)
      throw new AccessError("NOT_FOUND", 404, "The club is unavailable.");
    const teams = view.teams
      .filter((t) => t.clubId === clubId)
      .map((t) => {
        const p = this.source as DevelopmentStore;
        const prep = p.document<
          import("../../../packages/application/src/preparation").PreparationState
        >(t.id, t.seasonId, "preparation");
        const records = p.document<
          import("../../../packages/application/src/records").RecordsState
        >(t.id, t.seasonId, "records");
        const combined = new Map(
          records.results.map((r) => [
            r.id,
            {
              status: r.status,
              finalScore: r.finalScore,
              sourceRevision: r.sourceMatchRevision,
            },
          ]),
        );
        for (const row of p.database
          .prepare(
            "SELECT id,state_json FROM matches WHERE team_id=? AND season_id=?",
          )
          .all(t.id, t.seasonId) as { id: string; state_json: string }[]) {
          const state = JSON.parse(
            row.state_json,
          ) as import("../../../packages/domain/src/types").MatchState;
          const prior = combined.get(row.id);
          if (
            ["completed", "abandoned"].includes(state.status) &&
            (!prior || state.revision >= (prior.sourceRevision ?? 0))
          )
            combined.set(row.id, {
              status: state.status === "completed" ? "completed" : "abandoned",
              finalScore: state.status === "completed" ? state.score : null,
              sourceRevision: state.revision,
            });
        }
        const results = [...combined.values()].filter(
            (r) => r.status === "completed",
          ),
          scored = results.filter((r) => r.finalScore !== null);
        return {
          ...t,
          players: prep.profiles.filter(
            (p) => p.active && p.seasonId === t.seasonId,
          ).length,
          completedGames: results.length,
          scoredGames: scored.length,
          wins: scored.filter((r) => r.finalScore!.for > r.finalScore!.against)
            .length,
          draws: scored.filter(
            (r) => r.finalScore!.for === r.finalScore!.against,
          ).length,
          losses: scored.filter(
            (r) => r.finalScore!.for < r.finalScore!.against,
          ).length,
          goalsFor: scored.reduce((n, r) => n + r.finalScore!.for, 0),
          goalsAgainst: scored.reduce((n, r) => n + r.finalScore!.against, 0),
        };
      });
    return { kind: "club-report", club, teams };
  }
}
