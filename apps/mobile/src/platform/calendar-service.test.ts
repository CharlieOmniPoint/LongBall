import { describe, expect, it, vi } from "vitest";
import type { Membership, Principal } from "@longball/application/access";
import type { WorkspaceBinding } from "@longball/application/workspace-boundary";
import {
  CalendarAccessDeniedError,
  exportScopedCalendar,
} from "./calendar-service";
const nowMs = Date.parse("2026-10-21T12:00:00Z");
const source: WorkspaceBinding = {
  generation: 1,
  apiBaseUrl: "https://api.example",
  accountId: "account",
  issuer: "https://identity.example",
  subject: "subject",
  teamId: "team",
  seasonId: "season",
  role: "manager",
  playerId: null,
};
const principal: Principal = {
  accountId: "account",
  issuer: source.issuer,
  subject: source.subject,
  identityClassification: "adult_individual",
  adultVerified: true,
  strongAuth: true,
  authenticatedAt: nowMs,
  status: "active",
};
const membership: Membership = {
  accountId: "account",
  teamId: "team",
  seasonId: "season",
  role: "manager",
  expiresAt: nowMs + 60_000,
};
const schedule = {
  team: { id: "team" },
  activeSeasonId: "season",
  fixtures: [
    {
      id: "fixture",
      playedDate: "2026-10-24",
      kickoff: "10:00",
      venue: "Fictional field",
      status: "scheduled",
    },
  ],
  training: [],
};
function setup() {
  const identity = { principal, memberships: [membership] };
  return {
    source,
    currentBinding: () => source,
    readIdentity: vi.fn(async () => identity),
    readSchedule: vi.fn(async () => schedule),
    session: null,
    selectedKeys: ["match:fixture"],
    nowMs: () => nowMs,
    deliver: vi.fn(async (_artifact, verify) => {
      await verify();
      return "downloaded";
    }),
  } satisfies Parameters<typeof exportScopedCalendar>[0];
}
describe("current calendar service boundary", () => {
  it("reads fresh own-authorized schedule and verifies fresh access again at file delivery", async () => {
    const input = setup();
    expect(await exportScopedCalendar(input)).toBe("downloaded");
    expect(input.readIdentity).toHaveBeenCalledTimes(3);
    expect(input.readSchedule).toHaveBeenCalledOnce();
    expect(input.deliver.mock.calls[0][0].body).toContain(
      "DTSTART:20261024T090000Z",
    );
  });
  it("discards a delayed old-team identity reply rather than opening its artifact", async () => {
    const input = setup();
    let binding: WorkspaceBinding | null = source;
    let resolve!: (value: {
      principal: Principal;
      memberships: Membership[];
    }) => void;
    input.readIdentity.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const exporting = exportScopedCalendar({
      ...input,
      currentBinding: () => binding,
    });
    binding = { ...source, teamId: "another-team", generation: 2 };
    resolve({ principal, memberships: [membership] });
    await expect(exporting).rejects.toThrow(/context changed/);
    expect(input.deliver).not.toHaveBeenCalled();
    expect(input.readSchedule).not.toHaveBeenCalled();
  });
  it("withholds an artifact if access is revoked after schedule read or at delivery", async () => {
    for (const call of [2, 3]) {
      const input = setup();
      let reads = 0;
      input.readIdentity.mockImplementation(async () => ({
        principal,
        memberships: ++reads >= call ? [] : [membership],
      }));
      await expect(exportScopedCalendar(input)).rejects.toBeInstanceOf(
        CalendarAccessDeniedError,
      );
      if (call === 2) expect(input.deliver).not.toHaveBeenCalled();
    }
  });
  it("does not export another season or a removed/postponed event and gives spectators no schedule right", async () => {
    const input = setup();
    input.readSchedule.mockResolvedValueOnce({
      ...schedule,
      activeSeasonId: "other-season",
    });
    await expect(exportScopedCalendar(input)).rejects.toThrow(/differs/);
    input.readSchedule.mockResolvedValueOnce({
      ...schedule,
      fixtures: [{ ...schedule.fixtures[0], status: "postponed" }],
    });
    await expect(exportScopedCalendar(input)).rejects.toThrow(
      /no longer available/,
    );
    await expect(
      exportScopedCalendar({
        ...input,
        source: { ...source, role: "spectator" },
      }),
    ).rejects.toThrow(/manager or own-player/);
    expect(input.deliver).not.toHaveBeenCalled();
  });
});
