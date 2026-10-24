import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "./server";
import { EVENT_CONTRACT_VERSION, SYNTHETIC_IDS } from "./store";
function responseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON response object.");
  return value as Record<string, unknown>;
}
function responseText(value: unknown, key: string): string {
  const field = responseObject(value)[key];
  if (typeof field !== "string")
    throw new Error(`Expected response field ${key} to be text.`);
  return field;
}
function responseRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected a JSON response list.");
  return value.map(responseObject);
}
describe("connected invitation/PIN/request HTTP journey", () => {
  let app: ReturnType<typeof createApi>, directory: string, base: string;
  const { teamId, seasonId } = SYNTHETIC_IDS;
  const call = async (
    path: string,
    body?: object,
    token?: string,
    role?: string,
    method = body ? "POST" : "GET",
  ) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(role ? { "X-Longball-Role": role } : {}),
        ...(body
          ? {
              "Content-Type": "application/json",
              "X-Api-Contract-Version": EVENT_CONTRACT_VERSION,
              "Idempotency-Key": randomUUID(),
            }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  };
  const teamPath = (feature: string) =>
    `/v1/teams/${teamId}/${feature}?seasonId=${seasonId}`;
  const issue = async (token = "synthetic-manager-1", role = "manager") => {
    const response = await call(
      teamPath("spectator-invites"),
      { seasonId, expiresInHours: 1 },
      token,
      role,
    );
    expect(response.status).toBe(201);
    return new URLSearchParams(
      new URL(responseText(response.body, "shareUrl")).hash.slice(1),
    ).get("code")!;
  };
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "longball-pin-http-"));
    app = createApi({
      databasePath: join(directory, "db.sqlite"),
      syntheticAuth: true,
      demoScenario: true,
      publicAppEntryUrl: "https://example.invalid/LongBall/",
      invitationPolicyVersion: "pin-http-v1",
      now: () => Date.parse("2026-10-24T09:00:00Z"),
    });
    await new Promise<void>((resolve) =>
      app.server.listen(0, "127.0.0.1", resolve),
    );
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    app.server.closeAllConnections();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  it("creates a spectator from a scoped link, signs in with PIN and supports invitations/following without staff access", async () => {
    await issue("synthetic-admin", "administrator");
    await issue("synthetic-club-admin", "administrator");
    await issue("synthetic-account-player-01", "player");
    const token = await issue();
    expect(
      (await call("/v1/spectator-access/preview", { token })).body,
    ).toMatchObject({ teamId, seasonId, context: { teamName: "Roma" } });
    expect(
      (
        await call("/v1/spectator-access/register", {
          token,
          username: "robin.park",
          passcode: "1234",
          requestId: randomUUID(),
        })
      ).status,
    ).toBe(400);
    const created = await call("/v1/spectator-access/register", {
      token,
      username: "robin.park",
      passcode: "4729",
      requestId: randomUUID(),
    });
    expect(created.status).toBe(201);
    const access = responseText(created.body, "accessToken");
    const me = await call("/v1/me", undefined, access);
    expect(me.status).toBe(200);
    expect(responseObject(me.body).memberships).toEqual([
      expect.objectContaining({ role: "spectator", teamId, seasonId }),
    ]);
    expect(
      (await call(teamPath("preparation"), undefined, access, "manager"))
        .status,
    ).toBe(404);
    const choices = await call(
      teamPath("spectator-connections"),
      undefined,
      access,
      "spectator",
    );
    expect(choices.status).toBe(200);
    const players = responseRows(responseObject(choices.body).players);
    expect(players).toHaveLength(13);
    expect(Object.keys(players[0]).sort()).toEqual(["id", "label"]);
    expect(
      responseObject(
        (
          await call(
            teamPath("spectator-connections"),
            { playerId: responseText(players[0], "id") },
            access,
            "spectator",
          )
        ).body,
      ).followedPlayerId,
    ).toBe(responseText(players[0], "id"));
    expect(
      (
        await call(
          teamPath("spectator-connections"),
          { playerId: "another-team-player" },
          access,
          "spectator",
        )
      ).status,
    ).toBe(400);
    await issue(access, "spectator");
    const login = await call("/v1/spectator-access/login", {
      username: "robin.park",
      passcode: "4729",
    });
    expect(login.status).toBe(201);
    expect(responseText(login.body, "accountId")).toBe(
      responseText(created.body, "accountId"),
    );
    expect(
      (
        await call(
          "/v1/spectator-access/session",
          undefined,
          responseText(login.body, "accessToken"),
          undefined,
          "DELETE",
        )
      ).status,
    ).toBe(204);
    expect(
      (await call("/v1/me", undefined, responseText(login.body, "accessToken")))
        .status,
    ).toBe(401);
  });
  it("accepts a second invitation into an existing PIN account using the canonical route", async () => {
    const login = await call("/v1/spectator-access/login", {
        username: "robin.park",
        passcode: "4729",
      }),
      token = await issue();
    const access = responseText(login.body, "accessToken");
    expect(
      (await call("/v1/spectator-invites/inspect", { token }, access)).status,
    ).toBe(200);
    expect(
      (await call("/v1/spectator-invites/accept", { token }, access)).status,
    ).toBe(200);
    expect(
      responseRows(
        responseObject((await call("/v1/me", undefined, access)).body)
          .memberships,
      ).filter((m) => m.role === "spectator"),
    ).toHaveLength(1);
  });
  it("provides a minimal directory and private pending request for staff without granting the requested role", async () => {
    const dir = await call("/v1/spectator-access/directory");
    expect(dir.status).toBe(200);
    const team = responseRows(dir.body).find((t) => t.teamId === teamId);
    if (!team)
      throw new Error(
        "Expected the scoped team in the public metadata directory.",
      );
    expect(team).not.toHaveProperty("profiles");
    const request = await call("/v1/spectator-access/requests", {
      requestId: randomUUID(),
      clubId: responseText(team, "clubId"),
      teamId,
      seasonId,
      requestedRole: "player",
      name: "Alex Parent",
      email: "alex@example.invalid",
    });
    expect(request.status).toBe(202);
    const list = await call(
      teamPath("invite-requests"),
      undefined,
      "synthetic-manager-1",
      "manager",
    );
    expect(list.status).toBe(200);
    for (const token of ["synthetic-admin", "synthetic-club-admin"])
      expect(
        (
          await call(
            teamPath("invite-requests"),
            undefined,
            token,
            "administrator",
          )
        ).status,
      ).toBe(200);
    expect(list.body).toEqual([
      expect.objectContaining({
        requestedRole: "player",
        email: "alex@example.invalid",
        status: "pending",
      }),
    ]);
    expect(
      (
        await call(
          teamPath("invite-requests"),
          undefined,
          "synthetic-account-player-01",
          "player",
        )
      ).status,
    ).toBe(404);
    const decision = await call(
      `/v1/teams/${teamId}/invite-requests/${responseText(request.body, "requestId")}/decision?seasonId=${seasonId}`,
      { status: "handled" },
      "synthetic-manager-1",
      "manager",
    );
    expect(decision.status).toBe(200);
  });
});
