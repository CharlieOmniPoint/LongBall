import {
  AccessError,
  type Principal,
} from "../../../packages/application/src/access";
import {
  applyTeamPrivilegeCommand,
  parseTeamPrivilegeCommand,
  teamPrivilegeAllowed,
  type OwnTeamPrivileges,
  type TeamPrivilege,
  type TeamPrivilegeCommand,
  type TeamPrivilegeState,
  type TeamPrivilegesView,
} from "../../../packages/application/src/team-privileges";
import type { CommunityActor } from "../../../packages/application/src/community";

export interface TeamPrivilegeSession {
  principal: Principal;
  teamId: string;
  seasonId: string;
  role?: string;
}
export interface TeamPrivilegeDecision {
  command: TeamPrivilegeCommand;
  actorId: string;
  createdAtMs: number;
}
export interface TeamPrivilegeRepository {
  transaction<T>(work: () => Promise<T>): Promise<T>;
  actor(session: TeamPrivilegeSession): Promise<CommunityActor>;
  state(
    session: TeamPrivilegeSession,
    lock?: boolean,
  ): Promise<TeamPrivilegeState>;
  targets(
    session: TeamPrivilegeSession,
  ): Promise<{ accountId: string; label: string }[]>;
  own(
    session: TeamPrivilegeSession,
    privilege: TeamPrivilege,
    lock?: boolean,
  ): Promise<boolean>;
  save(
    session: TeamPrivilegeSession,
    state: TeamPrivilegeState,
    decision: TeamPrivilegeDecision,
  ): Promise<void>;
}
export class TeamPrivilegeService {
  constructor(
    private readonly repository: TeamPrivilegeRepository,
    private readonly now: () => number = Date.now,
  ) {}
  private async manager(session: TeamPrivilegeSession): Promise<void> {
    const actor = await this.repository.actor(session);
    if (actor.role !== "manager")
      throw new AccessError(
        "NOT_FOUND",
        404,
        "The requested team operation is unavailable.",
      );
  }
  async own(session: TeamPrivilegeSession): Promise<OwnTeamPrivileges> {
    const actor = await this.repository.actor(session);
    const eligible = actor.role === "manager" || actor.role === "player";
    return {
      kind: "own-team-privileges",
      teamId: session.teamId,
      seasonId: session.seasonId,
      uploadsAllowed:
        eligible && (await this.repository.own(session, "uploads")),
      invitationsAllowed:
        eligible && (await this.repository.own(session, "invitations")),
    };
  }
  async assertAllowed(
    session: TeamPrivilegeSession,
    privilege: TeamPrivilege,
    lock = false,
  ): Promise<void> {
    const actor = await this.repository.actor(session);
    if (!["manager", "player"].includes(actor.role))
      throw new AccessError(
        "NOT_FOUND",
        404,
        "The requested team operation is unavailable.",
      );
    if (!(await this.repository.own(session, privilege, lock)))
      throw new AccessError(
        privilege === "uploads"
          ? "TEAM_UPLOADS_SUSPENDED"
          : "TEAM_INVITATIONS_SUSPENDED",
        403,
        privilege === "uploads"
          ? "Photo contributions are suspended in this team. Existing private uploads are retained; contact the team manager."
          : "Creating or reissuing invitations is suspended in this team. Existing grants and invitations retain their separate recorded status.",
      );
  }
  async view(session: TeamPrivilegeSession): Promise<TeamPrivilegesView> {
    await this.manager(session);
    const state = await this.repository.state(session),
      targets = await this.repository.targets(session);
    return {
      kind: "team-privileges",
      teamId: session.teamId,
      seasonId: session.seasonId,
      revision: state.revision,
      own: await this.own(session),
      targets: targets.map((target) => ({
        ...target,
        uploadsSuspended: !teamPrivilegeAllowed(
          state,
          target.accountId,
          "uploads",
        ),
        invitationsSuspended: !teamPrivilegeAllowed(
          state,
          target.accountId,
          "invitations",
        ),
      })),
    };
  }
  async command(
    session: TeamPrivilegeSession,
    raw: unknown,
  ): Promise<{
    kind: "team-privilege-receipt";
    commandId: string;
    teamId: string;
    revision: number;
  }> {
    const command = parseTeamPrivilegeCommand(raw);
    return this.repository.transaction(async () => {
      await this.manager(session);
      const state = await this.repository.state(session, true);
      if (
        !(await this.repository.targets(session)).some(
          (target) => target.accountId === command.targetAccountId,
        )
      )
        throw new AccessError(
          "NOT_FOUND",
          404,
          "The requested team account is unavailable.",
        );
      const next = applyTeamPrivilegeCommand(state, command);
      await this.repository.save(session, next, {
        command,
        actorId: session.principal.accountId,
        createdAtMs: this.now(),
      });
      return {
        kind: "team-privilege-receipt",
        commandId: command.id,
        teamId: session.teamId,
        revision: next.revision,
      };
    });
  }
}
