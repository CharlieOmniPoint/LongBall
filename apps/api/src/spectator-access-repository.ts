import {
  AccessError,
  type Principal,
} from "../../../packages/application/src/access";
import { applyVerifiedInvitationCommand } from "../../../packages/application/src/community";
import { pendingInvitation } from "../../../packages/application/src/invitation-credentials";
import { parseInvitationContext } from "../../../packages/application/src/invitation-context";
import type { PreparationState } from "../../../packages/application/src/preparation";
import type {
  InviteDirectoryTeam,
  InviteRequest,
  InviteRequestInput,
} from "../../../packages/application/src/spectator-pin";
import type { DevelopmentStore } from "./store";
import { PostgresStore } from "./postgres-store";
import { initializeSqliteUsernameRegistry, isUsernameCollision } from "./username-registry";
import type { RuntimeStore } from "./runtime-store";
import { SqliteInvitationRepository } from "./invitation-repository";
import type {
  SpectatorAccessRepository,
  SpectatorAccessPreview,
  SpectatorCredential,
} from "./spectator-access";

export const SQLITE_SPECTATOR_ACCESS_DDL = `
CREATE TABLE IF NOT EXISTS spectator_pin_credentials(account_id TEXT PRIMARY KEY REFERENCES accounts(id),username TEXT NOT NULL UNIQUE,salt TEXT NOT NULL,verifier TEXT NOT NULL,created_request_id TEXT NOT NULL UNIQUE,failed_count INTEGER NOT NULL DEFAULT 0,locked_until INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS invite_requests(id TEXT PRIMARY KEY,club_id TEXT NOT NULL,team_id TEXT NOT NULL REFERENCES teams(id),season_id TEXT NOT NULL,requested_role TEXT NOT NULL CHECK(requested_role IN('player','spectator')),name TEXT NOT NULL,email TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','handled','declined')),created_at INTEGER NOT NULL,decided_by TEXT REFERENCES accounts(id),decided_at INTEGER);
`;
const unavailable = (): never => {
  throw new AccessError(
    "INVITATION_UNAVAILABLE",
    404,
    "This invitation is unavailable. Ask for a current team invitation.",
  );
};
const conflict = (): never => {
  throw new AccessError(
    "USERNAME_UNAVAILABLE",
    409,
    "That username is unavailable. Choose another username or sign in to an existing account.",
  );
};
export class PersistedSpectatorAccessRepository
  implements SpectatorAccessRepository
{
  constructor(
    private readonly source: DevelopmentStore | PostgresStore,
    private readonly runtime: RuntimeStore,
  ) {
    if (!(source instanceof PostgresStore)) {
      source.database.exec(SQLITE_SPECTATOR_ACCESS_DDL);
      initializeSqliteUsernameRegistry(source);
    }
  }
  private sqlite(): DevelopmentStore {
    if (this.source instanceof PostgresStore) throw new Error("SQLITE_ONLY");
    return this.source;
  }
  async preview(
    tokenHash: string,
    now: number,
  ): Promise<SpectatorAccessPreview> {
    if (this.source instanceof PostgresStore) {
      const row = await this.source.one(
        "SELECT * FROM spectator_pin_preview($1,$2)",
        [tokenHash, now],
      );
      if (!row) return unavailable();
      return {
        invitationId: String(row.invitation_id),
        clubId: String(row.club_id),
        teamId: String(row.team_id),
        seasonId: String(row.season_id),
        expiresAt: new Date(Number(row.expires_at)).toISOString(),
        context: parseInvitationContext({
          clubName: row.club_name,
          teamName: row.team_name,
          ageGroup: row.age_group,
          seasonLabel: row.season_label,
          inviterLabel: "Team member",
        }),
      };
    }
    const source = this.sqlite();
    const invite = source.database
      .prepare(
        "SELECT id,club_id,team_id,season_id FROM spectator_invitations WHERE token_hash=? AND accepted_by IS NULL AND revoked_at IS NULL AND expires_at>?",
      )
      .get(tokenHash, now) as
      | { id: string; club_id: string; team_id: string; season_id: string }
      | undefined;
    if (!invite) return unavailable();
    const state = source.communityState(invite.team_id, invite.season_id);
    if (
      !pendingInvitation(state, tokenHash, now, {
        teamId: invite.team_id,
        seasonId: invite.season_id,
      })
    )
      return unavailable();
    const preparation = source.document<PreparationState>(
        invite.team_id,
        invite.season_id,
        "preparation",
      ),
      season = preparation.seasons.find((item) => item.id === invite.season_id);
    if (
      !season ||
      preparation.club.id !== invite.club_id ||
      preparation.team.id !== invite.team_id
    )
      return unavailable();
    const entry = state.invitations.find((item) => item.id === invite.id)!;
    return {
      invitationId: invite.id,
      clubId: invite.club_id,
      teamId: invite.team_id,
      seasonId: invite.season_id,
      expiresAt: new Date(entry.expiresAtMs).toISOString(),
      context: parseInvitationContext({
        clubName: preparation.club.name,
        teamName: preparation.team.name,
        ageGroup: preparation.team.ageGroup || null,
        seasonLabel: season.label || null,
        inviterLabel: "Team member",
      }),
    };
  }
  async register(input: {
    tokenHash: string;
    username: string;
    salt: string;
    verifier: string;
    accountId: string;
    requestId: string;
    now: number;
  }) {
    try {
      if (this.source instanceof PostgresStore) {
        const row = await this.source.one(
          "SELECT spectator_pin_register($1,$2,$3,$4,$5,$6,$7) AS account_id",
          [
            input.tokenHash,
            input.username,
            input.salt,
            input.verifier,
            input.accountId,
            input.requestId,
            input.now,
          ],
        );
        if (!row?.account_id) return unavailable();
        return { accountId: String(row.account_id) };
      }
      return await this.runtime.transaction(async () => {
        const source = this.sqlite(),
          preview = await this.preview(input.tokenHash, input.now);
        if (
          source.database
            .prepare(
              "SELECT account_id FROM spectator_pin_credentials WHERE username=?",
            )
            .get(input.username)
        )
          return conflict();
        source.database
          .prepare(
            "INSERT INTO accounts(id,issuer,subject,classification,adult_verified,status,strong_auth_enrolled) VALUES(?,'urn:longball:spectator-pin',?,'unclassified',0,'active',0)",
          )
          .run(input.accountId, input.accountId);
        source.database
          .prepare(
            "INSERT INTO spectator_pin_credentials(account_id,username,salt,verifier,created_request_id) VALUES(?,?,?,?,?)",
          )
          .run(
            input.accountId,
            input.username,
            input.salt,
            input.verifier,
            input.requestId,
          );
        const principal = source.principal({
          issuer: "urn:longball:spectator-pin",
          subject: input.accountId,
          strongAuth: false,
          authenticatedAt: input.now,
        });
        const previous = source.communityState(
          preview.teamId,
          preview.seasonId,
        );
        const state = applyVerifiedInvitationCommand(
          previous,
          {
            accountId: input.accountId,
            teamId: preview.teamId,
            seasonId: preview.seasonId,
            role: "spectator",
          },
          {
            id: `pin-register-${input.requestId}`,
            type: "invite.accepted_verified",
            invitationId: preview.invitationId,
            tokenHash: input.tokenHash,
          },
          input.now,
        );
        await new SqliteInvitationRepository(source, this.runtime).save(
          {
            principal,
            teamId: preview.teamId,
            seasonId: preview.seasonId,
            role: "spectator",
          },
          state,
          [preview.invitationId],
          null,
        );
        source.audit(
          principal,
          "spectator.pin_registered",
          preview.invitationId,
          "accepted",
        );
        return { accountId: input.accountId };
      });
    } catch (error) {
      if (isUsernameCollision(error) || (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error.code === "23505" ||
          (error.code === "ERR_SQLITE_ERROR" &&
            error instanceof Error &&
            /UNIQUE constraint/.test(error.message)))
      ))
        return conflict();
      throw error;
    }
  }
  async credential(username: string): Promise<SpectatorCredential | null> {
    const row =
      this.source instanceof PostgresStore
        ? await this.source.one("SELECT * FROM spectator_pin_credential($1)", [
            username,
          ])
        : this.sqlite()
            .database.prepare(
              "SELECT p.* FROM spectator_pin_credentials p JOIN accounts a ON a.id=p.account_id WHERE p.username=? AND a.status='active' AND a.classification='unclassified' AND a.issuer='urn:longball:spectator-pin'",
            )
            .get(username);
    return row
      ? {
          accountId: String(row.account_id),
          salt: String(row.salt),
          verifier: String(row.verifier),
          lockedUntil: Number(row.locked_until),
        }
      : null;
  }
  async loginAttempt(username: string, success: boolean, now: number) {
    if (this.source instanceof PostgresStore) {
      await this.source.one("SELECT spectator_pin_login_attempt($1,$2,$3)", [
        username,
        success,
        now,
      ]);
      return;
    }
    this.sqlite()
      .database.prepare(
        `UPDATE spectator_pin_credentials SET failed_count=CASE WHEN ? THEN 0 WHEN locked_until>0 AND locked_until<=? THEN 1 ELSE failed_count+1 END,locked_until=CASE WHEN ? THEN 0 WHEN locked_until>? THEN locked_until WHEN locked_until>0 AND locked_until<=? THEN 0 WHEN failed_count+1>=5 THEN ?+900000 ELSE 0 END WHERE username=?`,
      )
      .run(Number(success), now, Number(success), now, now, now, username);
  }
  async directory(): Promise<InviteDirectoryTeam[]> {
    const rows =
      this.source instanceof PostgresStore
        ? await this.source.many("SELECT * FROM spectator_invite_directory()")
        : this.sqlite()
            .database.prepare(
              "SELECT json_extract(d.value_json,'$.club.id') club_id,json_extract(d.value_json,'$.club.name') club_name,d.team_id,json_extract(d.value_json,'$.team.name') team_name,json_extract(d.value_json,'$.team.ageGroup') age_group,d.season_id,(SELECT json_extract(s.value,'$.label') FROM json_each(d.value_json,'$.seasons')s WHERE json_extract(s.value,'$.id')=d.season_id) season_label FROM documents d WHERE kind='preparation' ORDER BY club_name,age_group,team_name LIMIT 5000",
            )
            .all();
    return rows.map((row) => ({
      clubId: String(row.club_id),
      clubName: String(row.club_name),
      teamId: String(row.team_id),
      teamName: String(row.team_name),
      ageGroup: String(row.age_group ?? ""),
      seasonId: String(row.season_id),
      seasonLabel: String(row.season_label ?? ""),
    }));
  }
  async request(
    input: InviteRequestInput,
    now: number,
  ): Promise<{ requestId: string; status: "pending" }> {
    if (this.source instanceof PostgresStore) {
      const row = await this.source.one(
        "SELECT spectator_invite_request($1,$2,$3,$4,$5,$6,$7,$8) AS id",
        [
          input.requestId,
          input.clubId,
          input.teamId,
          input.seasonId,
          input.requestedRole,
          input.name,
          input.email,
          now,
        ],
      );
      if (!row?.id) return unavailable();
      return { requestId: String(row.id), status: "pending" };
    }
    if (
      !(await this.directory()).some(
        (team) =>
          team.clubId === input.clubId &&
          team.teamId === input.teamId &&
          team.seasonId === input.seasonId,
      )
    )
      return unavailable();
    const source = this.sqlite(),
      prior = source.database
        .prepare("SELECT * FROM invite_requests WHERE id=?")
        .get(input.requestId);
    if (
      prior &&
      JSON.stringify([
        prior.club_id,
        prior.team_id,
        prior.season_id,
        prior.requested_role,
        prior.name,
        prior.email,
      ]) !==
        JSON.stringify([
          input.clubId,
          input.teamId,
          input.seasonId,
          input.requestedRole,
          input.name,
          input.email,
        ])
    )
      throw new AccessError(
        "IDEMPOTENCY_CONFLICT",
        409,
        "This request identity has already been used.",
      );
    source.database
      .prepare(
        "INSERT INTO invite_requests(id,club_id,team_id,season_id,requested_role,name,email,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
      )
      .run(
        input.requestId,
        input.clubId,
        input.teamId,
        input.seasonId,
        input.requestedRole,
        input.name,
        input.email,
        now,
      );
    return { requestId: input.requestId, status: "pending" };
  }
  async connections(
    principal: Principal,
    teamId: string,
    seasonId: string,
    role?: string,
  ): Promise<{
    players: { id: string; label: string }[];
    followedPlayerId: string | null;
  }> {
    const actor = await this.runtime.communityActor(
      principal,
      teamId,
      seasonId,
      role,
    );
    if (actor.role !== "spectator")
      throw new AccessError(
        "NOT_FOUND",
        404,
        "The spectator connection is unavailable.",
      );
    let players: { id: string; label: string }[];
    if (this.source instanceof PostgresStore) {
      const row = await this.source.one(
        "SELECT spectator_connection_catalog($1,$2) AS players",
        [teamId, seasonId],
      );
      if (!row?.players)
        throw new AccessError(
          "NOT_FOUND",
          404,
          "The spectator connection is unavailable.",
        );
      players = JSON.parse(String(row.players));
    } else {
      const preparation = this.sqlite().document<PreparationState>(
        teamId,
        seasonId,
        "preparation",
      );
      players = preparation.profiles
        .filter((profile) => profile.active && profile.seasonId === seasonId)
        .map((profile) => ({
          id: profile.playerId,
          label: profile.displayName,
        }));
    }
    const community = await this.runtime.communityState(teamId, seasonId),
      selected = community.preferences[principal.accountId]?.followedPlayerId;
    return {
      players,
      followedPlayerId: players.some((player) => player.id === selected)
        ? selected!
        : null,
    };
  }
  async follow(
    principal: Principal,
    teamId: string,
    seasonId: string,
    role: string | undefined,
    playerId: string | null,
    requestId: string,
  ) {
    const before = await this.connections(principal, teamId, seasonId, role);
    if (
      playerId !== null &&
      !before.players.some((player) => player.id === playerId)
    )
      throw new AccessError(
        "INVALID_REQUEST",
        400,
        "Choose a current player in this team.",
      );
    const community = await this.runtime.community(
      principal,
      teamId,
      seasonId,
      role,
    );
    await this.runtime.communityCommand(
      principal,
      teamId,
      seasonId,
      {
        id: requestId,
        expectedRevision: community.revision,
        type: "preferences.changed",
        preferences: { ...community.preferences, followedPlayerId: playerId },
      },
      role,
    );
    return { ...before, followedPlayerId: playerId };
  }
  private async staff(
    principal: Principal,
    teamId: string,
    seasonId: string,
    role?: string,
  ) {
    const actor = await this.runtime.communityActor(
      principal,
      teamId,
      seasonId,
      role,
    );
    if (actor.role !== "manager")
      throw new AccessError(
        "NOT_FOUND",
        404,
        "The invitation request is unavailable.",
      );
  }
  async requests(
    principal: Principal,
    teamId: string,
    seasonId: string,
    role?: string,
  ): Promise<InviteRequest[]> {
    await this.staff(principal, teamId, seasonId, role);
    const rows =
      this.source instanceof PostgresStore
        ? await this.source.many(
            "SELECT * FROM invite_requests WHERE team_id=$1 AND season_id=$2 ORDER BY created_at DESC,id LIMIT 200",
            [teamId, seasonId],
          )
        : this.sqlite()
            .database.prepare(
              "SELECT * FROM invite_requests WHERE team_id=? AND season_id=? ORDER BY created_at DESC,id LIMIT 200",
            )
            .all(teamId, seasonId);
    return rows.map((row) => ({
      requestId: String(row.id),
      clubId: String(row.club_id),
      teamId: String(row.team_id),
      seasonId: String(row.season_id),
      requestedRole: row.requested_role as "player" | "spectator",
      name: String(row.name),
      email: String(row.email),
      status: row.status as InviteRequest["status"],
      createdAt: new Date(Number(row.created_at)).toISOString(),
    }));
  }
  async decide(
    principal: Principal,
    teamId: string,
    seasonId: string,
    role: string | undefined,
    requestId: string,
    status: "handled" | "declined",
  ) {
    await this.staff(principal, teamId, seasonId, role);
    if (
      !/^[A-Za-z0-9_-]{1,150}$/.test(requestId) ||
      !["handled", "declined"].includes(status)
    )
      throw new AccessError(
        "INVALID_REQUEST",
        400,
        "Choose an invitation request and a decision.",
      );
    const now = this.runtime.now();
    const count =
      this.source instanceof PostgresStore
        ? (
            await this.source.execute(
              "UPDATE invite_requests SET status=$1,decided_by=$2,decided_at=$3 WHERE id=$4 AND team_id=$5 AND season_id=$6 AND status='pending'",
              [status, principal.accountId, now, requestId, teamId, seasonId],
            )
          ).changes
        : this.sqlite()
            .database.prepare(
              "UPDATE invite_requests SET status=?,decided_by=?,decided_at=? WHERE id=? AND team_id=? AND season_id=? AND status='pending'",
            )
            .run(status, principal.accountId, now, requestId, teamId, seasonId)
            .changes;
    if (count !== 1)
      throw new AccessError(
        "NOT_FOUND",
        404,
        "The pending invitation request is unavailable.",
      );
    await this.runtime.audit(
      principal,
      "invite.request_decided",
      requestId,
      status,
    );
  }
}
