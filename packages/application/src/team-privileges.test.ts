import { describe, expect, it } from "vitest";
import {
  applyTeamPrivilegeCommand,
  assertOwnTeamPrivileges,
  assertTeamPrivilegesView,
  createTeamPrivilegeState,
  parseTeamPrivilegeCommand,
  teamPrivilegeAllowed,
  validateTeamPrivilegeState,
} from "./team-privileges";
const command = {
  id: "decision-1",
  type: "privilege.suspended" as const,
  expectedRevision: 0,
  targetAccountId: "account-1",
  privilege: "uploads" as const,
  reasonCode: "moderation_review",
  privateNote: "Restricted operational note",
  confirm: true as const,
};
describe("team-wide contribution privileges", () => {
  it("suspends exactly one account privilege without mutating its source or exposing its reason in the projection", () => {
    const original = createTeamPrivilegeState("team-1"),
      before = JSON.stringify(original);
    const next = applyTeamPrivilegeCommand(original, command);
    expect(JSON.stringify(original)).toBe(before);
    expect(next.revision).toBe(1);
    expect(teamPrivilegeAllowed(next, "account-1", "uploads")).toBe(false);
    expect(teamPrivilegeAllowed(next, "account-1", "invitations")).toBe(true);
    expect(teamPrivilegeAllowed(next, "other-account", "uploads")).toBe(true);
    expect(JSON.stringify(next)).not.toMatch(
      /Restricted|moderation_review|reasonCode|privateNote/,
    );
  });
  it("requires the current team revision for an explicit reasoned reinstatement", () => {
    const held = applyTeamPrivilegeCommand(
      createTeamPrivilegeState("team-1"),
      command,
    );
    expect(() =>
      applyTeamPrivilegeCommand(held, {
        ...command,
        id: "decision-2",
        type: "privilege.reinstated",
      }),
    ).toThrow(/changed/);
    const next = applyTeamPrivilegeCommand(held, {
      ...command,
      id: "decision-2",
      type: "privilege.reinstated",
      expectedRevision: 1,
      reasonCode: "review_complete",
    });
    expect(next.revision).toBe(2);
    expect(teamPrivilegeAllowed(next, "account-1", "uploads")).toBe(true);
  });
  it("does not turn redundant fresh decisions into duplicate audit-worthy changes", () => {
    const held = applyTeamPrivilegeCommand(
      createTeamPrivilegeState("team-1"),
      command,
    );
    expect(() =>
      applyTeamPrivilegeCommand(held, { ...command, expectedRevision: 1 }),
    ).toThrow(/already/);
    expect(() =>
      applyTeamPrivilegeCommand(createTeamPrivilegeState("team-1"), {
        ...command,
        type: "privilege.reinstated",
      }),
    ).toThrow(/already/);
  });
  it.each([
    { ...command, role: "manager" },
    { ...command, teamId: "forged" },
    { ...command, confirm: false },
    { ...command, reasonCode: "" },
    { ...command, reasonCode: "names or report details" },
    { ...command, expectedRevision: 0.5 },
    { ...command, targetAccountId: "../other" },
    { ...command, privateNote: "x".repeat(1001) },
  ])(
    "rejects unsafe and caller-supplied authority fields without echoing submitted details",
    (input) => {
      expect(() => parseTeamPrivilegeCommand(input)).toThrow(/exact confirmed/);
      try {
        parseTeamPrivilegeCommand(input);
      } catch (error) {
        expect(String(error)).not.toContain("names or report details");
      }
    },
  );
  it("rejects cross-scope status and unexpected private decision fields before displaying a response",()=>{
    const own={kind:'own-team-privileges',teamId:'team-1',seasonId:'season-1',uploadsAllowed:false,invitationsAllowed:true};
    expect(()=>assertOwnTeamPrivileges(own,'team-1','season-1')).not.toThrow();
    expect(()=>assertOwnTeamPrivileges(own,'team-2','season-1')).toThrow(/outside/);
    expect(()=>assertOwnTeamPrivileges({...own,privateNote:'restricted'},'team-1','season-1')).toThrow(/outside/);
    const view={kind:'team-privileges',teamId:'team-1',seasonId:'season-1',revision:1,own,targets:[{accountId:'account-1',label:'Fictional account',uploadsSuspended:true,invitationsSuspended:false}]};
    expect(()=>assertTeamPrivilegesView(view,'team-1','season-1')).not.toThrow();
    expect(()=>assertTeamPrivilegesView({...view,targets:[{...view.targets[0],privateNote:'restricted'}]},'team-1','season-1')).toThrow(/outside/);
    expect(()=>assertTeamPrivilegesView(view,'team-1','season-2')).toThrow(/outside/);
  });
  it("fails closed for duplicate or malformed retained projection rows", () => {
    const state = applyTeamPrivilegeCommand(
      createTeamPrivilegeState("team-1"),
      command,
    );
    expect(() =>
      validateTeamPrivilegeState({
        ...state,
        restrictions: [...state.restrictions, ...state.restrictions],
      }),
    ).toThrow(/reconciliation/);
    expect(() =>
      validateTeamPrivilegeState({
        ...state,
        restrictions: [
          { accountId: "account-1", privilege: "uploads", suspended: "false" },
        ],
      }),
    ).toThrow(/reconciliation/);
  });
});
