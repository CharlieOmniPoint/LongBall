import { describe, expect, it } from "vitest";
import type { Membership, Principal } from "./access";
import {
  attachWorkspaceValue,
  readWorkspaceValue,
  workspaceSessionAllows,
  type WorkspaceBinding,
  type WorkspaceSessionAccess,
} from "./workspace-boundary";

const now = 1_800_000_000_000;
const principal: Principal = {
  accountId: "child",
  issuer: "https://issuer.example",
  subject: "subject-1",
  identityClassification: "child_shared",
  adultVerified: false,
  strongAuth: false,
  authenticatedAt: now,
  status: "active",
};
const memberships: Membership[] = [
  {
    accountId: "child",
    teamId: "team-a",
    seasonId: "2026-27",
    role: "player",
    playerId: "player-01",
    expiresAt: now + 100,
  },
  {
    accountId: "child",
    teamId: "team-b",
    seasonId: "2026-27",
    role: "player",
    playerId: "player-02",
  },
];
const binding: WorkspaceBinding = {
  generation: 1,
  apiBaseUrl: "https://api.example",
  accountId: "child",
  issuer: principal.issuer,
  subject: principal.subject,
  teamId: "team-a",
  seasonId: "2026-27",
  role: "player",
  playerId: "player-01",
};
const session: WorkspaceSessionAccess = {
  sessionId: "connected-session",
  accountId: "child",
  issuer: principal.issuer,
  subject: principal.subject,
  config: { apiBaseUrl: binding.apiBaseUrl },
  expiresAtMs: now + 100,
  expired: false,
  locked: false,
};

describe("connected workspace response and private-cache boundary", () => {
  it("discards delayed old-team and old-refresh replies while keeping the current team's reply", async () => {
    let resolveOld!: (value: { ownAttendance: string }) => void;
    const oldReply = new Promise<{ ownAttendance: string }>((resolve) => {
      resolveOld = resolve;
    });
    let current = binding;
    const delayed = oldReply.then((value) =>
      attachWorkspaceValue(
        binding,
        current,
        principal,
        memberships,
        now,
        value,
      ),
    );
    current = {
      ...binding,
      generation: 2,
      teamId: "team-b",
      playerId: "player-02",
    };
    const fresh = attachWorkspaceValue(
      current,
      current,
      principal,
      memberships,
      now,
      { ownAttendance: "team-b-only" },
    );
    resolveOld({ ownAttendance: "private-old-team" });
    expect(await delayed).toBeNull();
    expect(
      readWorkspaceValue(fresh, current, principal, memberships, now),
    ).toEqual({ ownAttendance: "team-b-only" });
    expect(
      attachWorkspaceValue(
        binding,
        { ...binding, generation: 3 },
        principal,
        memberships,
        now,
        "old refresh",
      ),
    ).toBeNull();
  });
  it("hides cached own-player data exactly when membership expires or its player binding changes", () => {
    const cached = attachWorkspaceValue(
      binding,
      binding,
      principal,
      memberships,
      now,
      { ownAttendance: "present", preferences: ["GK", "CM", "CB"] },
    );
    expect(
      readWorkspaceValue(cached, binding, principal, memberships, now + 99),
    ).not.toBeNull();
    expect(
      readWorkspaceValue(cached, binding, principal, memberships, now + 100),
    ).toBeNull();
    expect(
      readWorkspaceValue(
        cached,
        binding,
        principal,
        [{ ...memberships[0], playerId: "other-player" }],
        now,
      ),
    ).toBeNull();
    expect(
      readWorkspaceValue(
        cached,
        binding,
        { ...principal, status: "disabled" },
        memberships,
        now,
      ),
    ).toBeNull();
  });
  it("rejects cross-account, issuer, API, role and season cache attachment", () => {
    for (const changed of [
      { accountId: "another-account" },
      { issuer: "https://other.example" },
      { apiBaseUrl: "https://other-api.example" },
      { role: "manager" as const },
      { seasonId: "2027-28" },
    ]) {
      expect(
        attachWorkspaceValue(
          binding,
          { ...binding, ...changed },
          principal,
          memberships,
          now,
          "private",
        ),
      ).toBeNull();
    }
    expect(
      attachWorkspaceValue(
        binding,
        binding,
        { ...principal, subject: "another-subject" },
        memberships,
        now,
        "private",
      ),
    ).toBeNull();
  });
  it("requires a currently unlocked same-API OIDC session independently of a previously successful fetch", () => {
    expect(workspaceSessionAllows(session, "https://api.example/", now)).toBe(
      true,
    );
    expect(
      workspaceSessionAllows(session, "https://api.example", now + 100),
    ).toBe(false);
    expect(
      workspaceSessionAllows(
        { ...session, locked: true },
        binding.apiBaseUrl,
        now,
      ),
    ).toBe(false);
    expect(
      workspaceSessionAllows(
        { ...session, expired: true },
        binding.apiBaseUrl,
        now,
      ),
    ).toBe(false);
    expect(workspaceSessionAllows(null, binding.apiBaseUrl, now)).toBe(false);
    expect(workspaceSessionAllows(session, "https://other.example", now)).toBe(
      false,
    );
    expect(
      workspaceSessionAllows(
        session,
        "https://api.example/unrelated-service",
        now,
      ),
    ).toBe(false);
  });
});
