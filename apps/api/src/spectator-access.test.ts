import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { DevelopmentStore, SYNTHETIC_IDS } from "./store";
import { sqliteRuntimeStore } from "./runtime-store";
import { SpectatorInvitationService } from "./invitation-service";
import { SqliteInvitationRepository } from "./invitation-repository";
import { SpectatorAccessService } from "./spectator-access";
import { PersistedSpectatorAccessRepository } from "./spectator-access-repository";
import type { CommunityState } from "../../../packages/application/src/community";

describe("invitation-backed spectator PIN accounts using persisted SQLite", () => {
  let source: DevelopmentStore,
    service: SpectatorAccessService,
    invitations: SpectatorInvitationService,
    repo: PersistedSpectatorAccessRepository,
    now: number;
  const { teamId, seasonId } = SYNTHETIC_IDS;
  const manager = () =>
    source.principal({
      issuer: "urn:longball:synthetic",
      subject: "synthetic-account-manager",
      strongAuth: true,
      authenticatedAt: now,
    });
  const issue = async () => {
    const response = await invitations.issue(
      { principal: manager(), teamId, seasonId, role: "manager" },
      crypto.randomUUID(),
      { seasonId, expiresInHours: 2 },
    );
    if (!("shareUrl" in response.body))
      throw new Error("Expected fresh invite");
    return new URLSearchParams(
      new URL(response.body.shareUrl).hash.slice(1),
    ).get("code")!;
  };
  const registration = (token: string, username = "robin.park") => ({
    token,
    username,
    passcode: "4729",
    requestId: crypto.randomUUID(),
  });
  beforeEach(async () => {
    now = Date.parse("2026-10-24T09:00:00Z");
    source = new DevelopmentStore(":memory:", () => now);
    source.seedSynthetic({ demoSharing: true });
    const runtime = sqliteRuntimeStore(source).store;
    const invites = new SqliteInvitationRepository(source, runtime);
    await invites.initialize();
    invitations = new SpectatorInvitationService({
      repository: invites,
      publicAppEntryUrl: "https://example.invalid/LongBall/",
      invitationPolicyVersion: "test-invite-v1",
      now: () => now,
    });
    repo = new PersistedSpectatorAccessRepository(source, runtime);
    service = new SpectatorAccessService(repo, () => now);
  });
  afterEach(() => {
    service.close();
    source.close();
  });
  it("requires an invitation and consumes it atomically into spectator-only authority with hashed PIN", async () => {
    const token = await issue(),
      input = registration(token),
      preview = await service.preview({ token }, "a");
    expect(preview).toMatchObject({
      teamId,
      seasonId,
      context: { teamName: "Roma" },
    });
    const result = await service.register(input, "a");
    const identity = service.identity(result.accessToken),
      principal = source.principal(identity);
    expect(identity).toMatchObject({
      issuer: "urn:longball:spectator-pin",
      strongAuth: false,
    });
    expect(principal.identityClassification).toBe("unclassified");
    expect(principal.adultVerified).toBe(false);
    expect(source.myMemberships(principal)).toEqual([
      expect.objectContaining({ teamId, seasonId, role: "spectator" }),
    ]);
    const saved = source.database
      .prepare("SELECT * FROM spectator_pin_credentials")
      .get()!;
    expect(saved.verifier).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(saved)).not.toContain(input.passcode);
    expect(saved).not.toHaveProperty("passcode");
    expect(
      source
        .document<CommunityState>(teamId, seasonId, "community")
        .grants.filter((g) => g.accountId === result.accountId),
    ).toHaveLength(1);
    await expect(
      service.register(registration(token, "another.name"), "b"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.register({ ...input, token: "invalid" }, "b"),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      source.database.prepare("SELECT * FROM spectator_pin_credentials").all(),
    ).toHaveLength(1);
  });
  it("rejects weak PINs and tampered registration fields without consuming a valid invite", async () => {
    const token = await issue();
    for (const passcode of [
      "1111",
      "1234",
      "4321",
      "7890",
      "1212",
      "1122",
      "2580",
      "abcd",
    ])
      await expect(
        service.register({ ...registration(token), passcode }, "a"),
      ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.register({ ...registration(token), role: "manager" }, "a"),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      source.database.prepare("SELECT * FROM spectator_pin_credentials").all(),
    ).toHaveLength(0);
    expect(await service.preview({ token }, "a")).toMatchObject({ teamId });
  });
  it("locks a username after five failed attempts across addresses and permits a fresh login after cooldown", async () => {
    const created = await service.register(registration(await issue()), "a");
    for (let i = 0; i < 5; i++)
      await expect(
        service.login(
          { username: "robin.park", passcode: "5826" },
          `other-${i}`,
        ),
      ).rejects.toMatchObject({ status: 401 });
    await expect(
      service.login({ username: "robin.park", passcode: "4729" }, "fresh"),
    ).rejects.toMatchObject({ status: 401 });
    now += 900001;
    const session = await service.login(
      { username: "ROBIN.PARK", passcode: "4729" },
      "fresh",
    );
    expect(session.accountId).toBe(created.accountId);
    service.logout(session.accessToken);
    expect(() => service.identity(session.accessToken)).toThrow();
    const restart = new SpectatorAccessService(repo, () => now);
    const again = await restart.login(
      { username: "robin.park", passcode: "4729" },
      "new",
    );
    expect(again.accountId).toBe(created.accountId);
    restart.close();
  });
  it("can issue an additional spectator invitation as a currently granted spectator, with own list only", async () => {
    const created = await service.register(registration(await issue()), "a"),
      principal = source.principal(service.identity(created.accessToken));
    const response = await invitations.issue(
      { principal, teamId, seasonId, role: "spectator" },
      crypto.randomUUID(),
      { seasonId, expiresInHours: 1 },
    );
    expect(response.status).toBe(201);
    expect(
      (
        await invitations.list({
          principal,
          teamId,
          seasonId,
          role: "spectator",
        })
      ).invitations,
    ).toHaveLength(1);
    source.database
      .prepare("UPDATE memberships SET revoked_at=? WHERE account_id=?")
      .run(now, created.accountId);
    await expect(
      invitations.issue(
        { principal, teamId, seasonId, role: "spectator" },
        crypto.randomUUID(),
        { seasonId, expiresInHours: 1 },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("keeps request contact details private to team staff and never grants a requested Player role", async () => {
    const directory = await service.directory();
    expect(directory[0]).toMatchObject({
      teamId,
      clubId: "synthetic-richmond-rovers",
    });
    const input = {
      requestId: crypto.randomUUID(),
      clubId: directory[0].clubId,
      teamId,
      seasonId,
      requestedRole: "player" as const,
      name: "Robin Park",
      email: "robin@example.invalid",
    };
    const before = source.database
      .prepare("SELECT count(*) count FROM memberships")
      .get();
    expect(await service.request(input, "a")).toMatchObject({
      status: "pending",
    });
    expect(await service.request(input, "a")).toMatchObject({
      status: "pending",
    });
    expect(
      source.database.prepare("SELECT count(*) count FROM memberships").get(),
    ).toEqual(before);
    expect(await repo.requests(manager(), teamId, seasonId, "manager")).toEqual(
      [
        expect.objectContaining({
          email: input.email,
          requestedRole: "player",
          status: "pending",
        }),
      ],
    );
    const player = source.principal({
      issuer: "urn:longball:synthetic",
      subject: "synthetic-account-player-01",
      strongAuth: false,
      authenticatedAt: now,
    });
    await expect(
      repo.requests(player, teamId, seasonId, "player"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.request(
        { ...input, requestId: crypto.randomUUID(), clubId: "another-club" },
        "a",
      ),
    ).rejects.toMatchObject({ status: 404 });
    await repo.decide(
      manager(),
      teamId,
      seasonId,
      "manager",
      input.requestId,
      "handled",
    );
    expect(
      (await repo.requests(manager(), teamId, seasonId, "manager"))[0].status,
    ).toBe("handled");
  });
  it("expires sessions and refuses a disabled account without returning distinguishing login details", async () => {
    const created = await service.register(registration(await issue()), "a");
    source.database
      .prepare("UPDATE accounts SET status='disabled' WHERE id=?")
      .run(created.accountId);
    await expect(
      service.login({ username: "robin.park", passcode: "4729" }, "a"),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      service.login({ username: "unknown.name", passcode: "4729" }, "a"),
    ).rejects.toMatchObject({ status: 401 });
    now += 21_600_001;
    expect(() => service.identity(created.accessToken)).toThrow();
  });
  it("keeps the normal request limit at five but permits thirty in an explicit isolated review", async () => {
    const team = (await service.directory()).find(
      (team) => team.teamId === teamId,
    )!;
    const input = () => ({
      requestId: crypto.randomUUID(),
      clubId: team.clubId,
      teamId,
      seasonId,
      requestedRole: "spectator" as const,
      name: "Alex Parent",
      email: "alex@example.invalid",
    });
    for (let i = 0; i < 5; i++)
      await service.request(input(), "shared-review-address");
    await expect(
      service.request(input(), "shared-review-address"),
    ).rejects.toMatchObject({ status: 429 });
    const review = new SpectatorAccessService(repo, () => now, {
      isolatedDemo: true,
    });
    try {
      for (let i = 0; i < 30; i++)
        await review.request(input(), "shared-review-address");
      await expect(
        review.request(input(), "shared-review-address"),
      ).rejects.toMatchObject({ status: 429 });
    } finally {
      review.close();
    }
  });
});
