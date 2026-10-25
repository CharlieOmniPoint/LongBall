import { describe, expect, it, vi } from "vitest";
import type { Membership, Principal } from "@longball/application/access";
import type {
  WorkspaceBinding,
  WorkspaceSessionAccess,
} from "@longball/application/workspace-boundary";
import { assertReportExportAccess } from "./report-export-access";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const now = 1_000_000;
const source: WorkspaceBinding = {
  generation: 3,
  apiBaseUrl: "https://api.example",
  accountId: "account-one",
  issuer: "https://identity.example",
  subject: "subject-one",
  teamId: "team-one",
  seasonId: "season-one",
  role: "manager",
  playerId: null,
};
const principal: Principal = {
  accountId: source.accountId,
  issuer: source.issuer,
  subject: source.subject,
  identityClassification: "adult_individual",
  adultVerified: true,
  strongAuth: true,
  authenticatedAt: now - 1000,
  status: "active",
};
const membership: Membership = {
  accountId: source.accountId,
  teamId: source.teamId,
  seasonId: source.seasonId,
  role: source.role,
  expiresAt: now + 10_000,
};
const session: WorkspaceSessionAccess = {
  sessionId: "session-one",
  accountId: source.accountId,
  issuer: source.issuer,
  subject: source.subject,
  expiresAtMs: now + 20_000,
  expired: false,
  locked: false,
  config: { apiBaseUrl: source.apiBaseUrl },
};

describe("permitted export authority after asynchronous session read", () => {
  it.each([
    { generation: 4 },
    { generation: 4, teamId: "team-two", seasonId: "season-two" },
    { generation: 4, role: "spectator" as const },
  ])(
    "discards the old artifact when scope changes while the native summary is pending (%j)",
    async (change) => {
      const reading = deferred<WorkspaceSessionAccess | null>();
      let binding: WorkspaceBinding | null = source;
      const openFile = vi.fn();
      const access = assertReportExportAccess({
        source,
        currentBinding: () => binding,
        principal,
        memberships: [membership],
        nowMs: () => now,
        session: {
          requiredSessionId: session.sessionId,
          read: () => reading.promise,
        },
      }).then(openFile);
      binding = { ...source, ...change };
      reading.resolve(session);
      await expect(access).rejects.toThrow(/context changed/);
      expect(openFile).not.toHaveBeenCalled();
    },
  );
  it("rechecks exact membership expiry after the session summary returns", async () => {
    const reading = deferred<WorkspaceSessionAccess | null>();
    let clock = now;
    const access = assertReportExportAccess({
      source,
      currentBinding: () => source,
      principal,
      memberships: [membership],
      nowMs: () => clock,
      session: {
        requiredSessionId: session.sessionId,
        read: () => reading.promise,
      },
    });
    clock = membership.expiresAt!;
    reading.resolve(session);
    await expect(access).rejects.toThrow(/context changed/);
  });
  it("refuses a locked or replaced identity and allows the unchanged current scope", async () => {
    const options = {
      source,
      currentBinding: () => source,
      principal,
      memberships: [membership],
      nowMs: () => now,
    };
    for (const reply of [
      { ...session, locked: true },
      { ...session, subject: "another-subject" },
      { ...session, sessionId: "another-session" },
    ]) {
      await expect(
        assertReportExportAccess({
          ...options,
          session: {
            requiredSessionId: session.sessionId,
            read: async () => reply,
          },
        }),
      ).rejects.toThrow(/session closed/);
    }
    await expect(
      assertReportExportAccess({
        ...options,
        session: {
          requiredSessionId: session.sessionId,
          read: async () => session,
        },
      }),
    ).resolves.toBeUndefined();
  });
});
