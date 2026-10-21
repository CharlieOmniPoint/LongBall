import { AccessError } from "../../../packages/application/src/access";
import {
  validateTeamPrivilegeState,
  type TeamPrivilege,
  type TeamPrivilegeState,
} from "../../../packages/application/src/team-privileges";
import type { PostgresStore } from "./postgres-store";
import type {
  TeamPrivilegeDecision,
  TeamPrivilegeRepository,
  TeamPrivilegeSession,
} from "./team-privileges-service";

export class PostgresTeamPrivilegeRepository
  implements TeamPrivilegeRepository
{
  constructor(private readonly store: PostgresStore) {}
  transaction<T>(work: () => Promise<T>): Promise<T> {
    return this.store.transaction(work);
  }
  actor(session: TeamPrivilegeSession) {
    return this.store.communityActor(
      session.principal,
      session.teamId,
      session.seasonId,
      session.role,
    );
  }
  async state(
    session: TeamPrivilegeSession,
    lock = false,
  ): Promise<TeamPrivilegeState> {
    const row = await this.store.one(
      `SELECT revision,state_json FROM team_privilege_states WHERE team_id=$1${lock ? " FOR UPDATE" : ""}`,
      [session.teamId],
    );
    if (!row)
      throw new AccessError(
        "TEAM_PRIVILEGES_UNAVAILABLE",
        503,
        "Current team privileges are unavailable.",
      );
    const state: unknown =
      typeof row.state_json === "string"
        ? JSON.parse(row.state_json)
        : row.state_json;
    validateTeamPrivilegeState(state);
    if (
      state.teamId !== session.teamId ||
      state.revision !== Number(row.revision)
    )
      throw new AccessError(
        "TEAM_PRIVILEGES_RECONCILIATION_REQUIRED",
        409,
        "Retain the team privilege record for authorised reconciliation.",
      );
    return state;
  }
  async targets(session: TeamPrivilegeSession) {
    const rows = await this.store.many(
      "SELECT DISTINCT m.account_id FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.team_id=$1 AND m.season_id=$2 AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>$3) AND a.status='active' ORDER BY m.account_id",
      [session.teamId, session.seasonId, this.store.now()],
    );
    const community = await this.store.communityState(
      session.teamId,
      session.seasonId,
    );
    return rows.map((row) => ({
      accountId: String(row.account_id),
      label:
        community.accounts.find((account) => account.id === row.account_id)
          ?.label ?? `Account ${row.account_id}`,
    }));
  }
  async own(
    session: TeamPrivilegeSession,
    privilege: TeamPrivilege,
    lock = false,
  ): Promise<boolean> {
    const row = await this.store.one(
      "SELECT longball.team_privilege_allowed($1,$2,$3,$4) AS allowed",
      [session.teamId, session.principal.accountId, privilege, lock],
    );
    return row?.allowed === true;
  }
  async save(
    session: TeamPrivilegeSession,
    state: TeamPrivilegeState,
    decision: TeamPrivilegeDecision,
  ) {
    const team = await this.store.one("SELECT club_id FROM teams WHERE id=$1", [
      session.teamId,
    ]);
    const changed = await this.store.execute(
      "UPDATE team_privilege_states SET revision=$1,state_json=$2 WHERE team_id=$3 AND revision=$4",
      [
        state.revision,
        JSON.stringify(state),
        session.teamId,
        state.revision - 1,
      ],
    );
    if (changed.changes !== 1)
      throw new AccessError(
        "TEAM_PRIVILEGE_REVISION_CONFLICT",
        409,
        "Team privileges changed. Refresh before confirming.",
      );
    const command = decision.command;
    if (!team?.club_id)
      throw new AccessError(
        "TEAM_PRIVILEGES_UNAVAILABLE",
        503,
        "Current team privileges are unavailable.",
      );
    await this.store.execute(
      "INSERT INTO team_privilege_decisions(team_id,club_id,revision,command_id,actor_id,target_account_id,privilege,suspended,reason_code,private_note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        session.teamId,
        team.club_id,
        state.revision,
        command.id,
        decision.actorId,
        command.targetAccountId,
        command.privilege,
        command.type === "privilege.suspended",
        command.reasonCode,
        command.privateNote,
      ],
    );
    await this.store.audit(
      session.principal,
      command.type,
      session.teamId,
      "team_scoped_privilege_accepted",
    );
  }
}
