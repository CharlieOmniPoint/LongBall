import { AccessError } from "../../../packages/application/src/access";
import {
  teamPrivilegeAllowed,
  validateTeamPrivilegeState,
  type TeamPrivilege,
  type TeamPrivilegeState,
} from "../../../packages/application/src/team-privileges";
import type { DevelopmentStore } from "./store";
import type { RuntimeStore } from "./runtime-store";
import type {
  TeamPrivilegeDecision,
  TeamPrivilegeRepository,
  TeamPrivilegeSession,
} from "./team-privileges-service";

/** Explicit fictional SQLite adapter; no production row-security claim. */
export class SqliteTeamPrivilegeRepository implements TeamPrivilegeRepository {
  constructor(
    private readonly source: DevelopmentStore,
    private readonly runtime: RuntimeStore,
  ) {}
  transaction<T>(work: () => Promise<T>): Promise<T> {
    return this.runtime.transaction(work);
  }
  actor(session: TeamPrivilegeSession) {
    return this.runtime.communityActor(
      session.principal,
      session.teamId,
      session.seasonId,
      session.role,
    );
  }
  async state(session: TeamPrivilegeSession): Promise<TeamPrivilegeState> {
    const row = this.source.database
      .prepare(
        "SELECT revision,state_json FROM team_privilege_states WHERE team_id=?",
      )
      .get(session.teamId) as
      | { revision: number; state_json: string }
      | undefined;
    if (!row)
      throw new AccessError(
        "TEAM_PRIVILEGES_UNAVAILABLE",
        503,
        "Current team privileges are unavailable.",
      );
    const state: unknown = JSON.parse(row.state_json);
    validateTeamPrivilegeState(state);
    if (state.teamId !== session.teamId || state.revision !== row.revision)
      throw new AccessError(
        "TEAM_PRIVILEGES_RECONCILIATION_REQUIRED",
        409,
        "Retain the team privilege record for authorised reconciliation.",
      );
    return state;
  }
  async targets(session: TeamPrivilegeSession) {
    const rows = this.source.database
      .prepare(
        "SELECT DISTINCT m.account_id FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.team_id=? AND m.season_id=? AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>?) AND a.status='active' ORDER BY m.account_id",
      )
      .all(session.teamId, session.seasonId, this.source.now()) as {
      account_id: string;
    }[];
    const community = await this.runtime.communityState(
      session.teamId,
      session.seasonId,
    );
    return rows.map((row) => ({
      accountId: row.account_id,
      label:
        community.accounts.find((account) => account.id === row.account_id)
          ?.label ?? `Account ${row.account_id}`,
    }));
  }
  async own(
    session: TeamPrivilegeSession,
    privilege: TeamPrivilege,
  ): Promise<boolean> {
    return teamPrivilegeAllowed(
      await this.state(session),
      session.principal.accountId,
      privilege,
    );
  }
  async save(
    session: TeamPrivilegeSession,
    state: TeamPrivilegeState,
    decision: TeamPrivilegeDecision,
  ) {
    const changed = this.source.database
      .prepare(
        "UPDATE team_privilege_states SET revision=?,state_json=? WHERE team_id=? AND revision=?",
      )
      .run(
        state.revision,
        JSON.stringify(state),
        session.teamId,
        state.revision - 1,
      );
    if (changed.changes !== 1)
      throw new AccessError(
        "TEAM_PRIVILEGE_REVISION_CONFLICT",
        409,
        "Team privileges changed. Refresh before confirming.",
      );
    const command = decision.command;
    this.source.database
      .prepare(
        "INSERT INTO team_privilege_decisions(team_id,revision,command_id,actor_id,target_account_id,privilege,suspended,reason_code,private_note,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        session.teamId,
        state.revision,
        command.id,
        decision.actorId,
        command.targetAccountId,
        command.privilege,
        Number(command.type === "privilege.suspended"),
        command.reasonCode,
        command.privateNote,
        decision.createdAtMs,
      );
    await this.runtime.audit(
      session.principal,
      command.type,
      session.teamId,
      "team_scoped_privilege_accepted",
    );
  }
}
