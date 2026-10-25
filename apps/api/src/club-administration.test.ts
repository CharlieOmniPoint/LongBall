import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "./server";
import { EVENT_CONTRACT_VERSION, SYNTHETIC_IDS } from "./store";
import type { ClubAdministrationDto } from "../../../packages/application/src/club-administration";
import { administrationDisplayLabels } from './club-administration';

describe("club and application administration through real SQLite HTTP", () => {
  let api: ReturnType<typeof createApi> | undefined;
  let directory: string;
  afterEach(async () => {
    api?.server.closeAllConnections();
    await api?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  async function setup() {
    directory = mkdtempSync(join(tmpdir(), "longball-admin-"));
    api = createApi({
      databasePath: join(directory, "db.sqlite"),
      syntheticAuth: true,
      demoScenario: true,
    });
    await new Promise<void>((resolve) =>
      api!.server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
    return async (
      route: string,
      account = "synthetic-admin",
      command?: unknown,
      role?: string,
    ) => {
      const response = await fetch(base + route, {
        method: command ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${account}`,
          ...(role ? { "X-Longball-Role": role } : {}),
          ...(command
            ? {
                "Content-Type": "application/json",
                "X-Api-Contract-Version": EVENT_CONTRACT_VERSION,
                "Idempotency-Key": randomUUID(),
              }
            : {}),
        },
        body: command ? JSON.stringify({ command }) : undefined,
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    };
  }
  it("keeps Club Admin within their club, creates empty scoped teams, and preserves the four appointed coach places", async () => {
    const call = await setup();
    const admin = await call("/v1/administration");
    expect(admin.status).toBe(200);
    expect(
      (admin.body as unknown as ClubAdministrationDto).administration.level,
    ).toBe("super");
    expect((admin.body as unknown as ClubAdministrationDto).clubs).toHaveLength(
      2,
    );
    expect((admin.body as unknown as ClubAdministrationDto).candidates.find(candidate => candidate.accountId === 'synthetic-account-manager-2')?.label).toBe('Priya Shah');
    expect((admin.body as unknown as ClubAdministrationDto).candidates.some(candidate => candidate.accountId.startsWith('synthetic-account-player-'))).toBe(false);
    const club = await call("/v1/administration", "synthetic-club-admin");
    expect(club.status).toBe(200);
    expect(
      (club.body as unknown as ClubAdministrationDto).clubs.map((c) => c.id),
    ).toEqual(["synthetic-richmond-rovers"]);
    expect(
      (
        await call("/v1/administration", "synthetic-club-admin", {
          type: "club.create",
          name: "Unauthorized club",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("/v1/administration", "synthetic-club-admin", {
          type: "team.create",
          clubId: "synthetic-other-club",
          name: "Denied",
          ageGroup: "U11",
          format: 9,
          seasonStartYear: 2026,
        })
      ).status,
    ).toBe(404);
    const create = await call("/v1/administration", "synthetic-club-admin", {
      type: "team.create",
      clubId: "synthetic-richmond-rovers",
      name: "Roma Lions",
      ageGroup: "U21",
      format: 11,
      seasonStartYear: 2026,
    });
    expect(create.status).toBe(200);
    const team = (create.body as unknown as ClubAdministrationDto).teams.find(
      (t) => t.name === "Roma Lions",
    )!;
    expect(team).toBeDefined();
    const prep = await call(
      `/v1/teams/${team.id}/preparation?seasonId=${team.seasonId}`,
      "synthetic-club-admin",
      undefined,
      "manager",
    );
    expect(prep.status).toBe(200);
    expect(prep.body.profiles).toEqual([]);
    expect(prep.body.fixtures).toEqual([]);
    const peer = await call(
      `/v1/teams/${team.id}/preparation?seasonId=${team.seasonId}`,
      "synthetic-manager-1",
      undefined,
      "manager",
    );
    expect(peer.status).toBe(404);
    const staff = await call(
      `/v1/teams/${SYNTHETIC_IDS.teamId}/managers?seasonId=${SYNTHETIC_IDS.seasonId}`,
      "synthetic-admin",
      undefined,
      "administrator",
    );
    expect(staff.status).toBe(200);
    expect(staff.body.activeTeamManagerCount).toBe(4);
    expect(
      (
        await call(
          "/v1/clubs/synthetic-other-club/reports",
          "synthetic-club-admin",
        )
      ).status,
    ).toBe(404);
    const report = await call(
      "/v1/clubs/synthetic-richmond-rovers/reports",
      "synthetic-club-admin",
    );
    expect(report.status).toBe(200);
    expect(JSON.stringify(report.body)).not.toContain("synthetic-player-");
    const original = api!.store.document<
      import("../../../packages/application/src/preparation").PreparationState
    >(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, "preparation");
    expect(
      (
        await call(
          `/v1/teams/${SYNTHETIC_IDS.teamId}/configuration?seasonId=${SYNTHETIC_IDS.seasonId}`,
          "synthetic-club-admin",
          {
            id: randomUUID(),
            expectedRevision: original.revision,
            type: "team.updated",
            name: "Roma Rangers",
            ageGroup: "U12",
            defaultPitchPlaces: 7,
            defaultHalfDurationMs: 1500000,
            logo: null,
          },
          "administrator",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          `/v1/teams/${SYNTHETIC_IDS.teamId}/configuration?seasonId=${SYNTHETIC_IDS.seasonId}`,
          "synthetic-club-admin",
          {
            id: randomUUID(),
            expectedRevision: original.revision + 1,
            type: "club.updated",
            name: "Richmond Athletic",
            logo: null,
          },
          "administrator",
        )
      ).status,
    ).toBe(200);
    const updated = await call("/v1/administration", "synthetic-club-admin");
    expect(
      (updated.body as unknown as ClubAdministrationDto).clubs[0].name,
    ).toBe("Richmond Athletic");
    expect(
      (updated.body as unknown as ClubAdministrationDto).teams.find(
        (t) => t.id === SYNTHETIC_IDS.teamId,
      ),
    ).toMatchObject({ name: "Roma Rangers", ageGroup: "U12" });
    const inheritedTeam = api!.store.document<
      import("../../../packages/application/src/preparation").PreparationState
    >(team.id, team.seasonId, "preparation");
    expect(inheritedTeam.club.name).toBe("Richmond Athletic");
    const rawRecords = api!.store.document<
      import("../../../packages/application/src/records").RecordsState
    >(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, "records");
    const emptyRecords: import("../../../packages/application/src/records").RecordsState =
      { ...rawRecords, results: [] };
    api!.store.saveDocument(
      SYNTHETIC_IDS.teamId,
      SYNTHETIC_IDS.seasonId,
      "records",
      emptyRecords,
    );
    const canonicalReport = await call(
      "/v1/clubs/synthetic-richmond-rovers/reports",
      "synthetic-club-admin",
    );
    expect(
      (
        canonicalReport.body.teams as { id: string; completedGames: number }[]
      ).find((t) => t.id === SYNTHETIC_IDS.teamId)?.completedGames,
    ).toBe(2);
  });
  it("rejects child promotion, blocks non-admin directory access and revokes only inherited rights", async () => {
    const call = await setup();
    for (const account of [
      "synthetic-account-player-01",
      "synthetic-spectator",
      "synthetic-manager-1",
    ])
      expect((await call("/v1/administration", account)).status).not.toBe(200);
    expect(
      (
        await call("/v1/administration", "synthetic-admin", {
          type: "administrator.grant",
          accountId: "synthetic-account-player-01",
          level: "club",
          clubId: "synthetic-richmond-rovers",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call("/v1/administration", "synthetic-admin", {
          type: "administrator.grant",
          accountId: "synthetic-account-manager",
          level: "club",
          clubId: "synthetic-richmond-rovers",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call("/v1/administration", "synthetic-admin", {
          type: "administrator.revoke",
          accountId: "synthetic-account-manager",
          level: "club",
          clubId: "synthetic-richmond-rovers",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          `/v1/teams/${SYNTHETIC_IDS.teamId}/preparation?seasonId=${SYNTHETIC_IDS.seasonId}`,
          "synthetic-manager-1",
          undefined,
          "manager",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call("/v1/administration", "synthetic-admin", {
          type: "administrator.revoke",
          accountId: "synthetic-account-club-admin",
          level: "club",
          clubId: "synthetic-richmond-rovers",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          `/v1/teams/${SYNTHETIC_IDS.teamId}/preparation?seasonId=${SYNTHETIC_IDS.seasonId}`,
          "synthetic-club-admin",
          undefined,
          "manager",
        )
      ).status,
    ).toBe(404);
  });
});

describe('administration display labels', () => {
  it('uses known review labels only in the verified review issuer and leaves other labels untouched', () => {
    const value: ClubAdministrationDto = { kind: 'club-administration', administration: { level: 'super', clubIds: [] }, clubs: [], teams: [], administrators: [], candidates: [{ accountId: 'synthetic-account-manager-2', label: 'provider-specific-reference' }, { accountId: 'unknown-review-adult', label: 'Existing adult label' }, { accountId: 'toString', label: 'Unmapped adult reference' }] };
    const review = administrationDisplayLabels(value, { issuer: 'urn:longball:synthetic' });
    expect(review.candidates.find(candidate => candidate.accountId === 'synthetic-account-manager-2')?.label).toBe('Priya Shah');
    expect(review.candidates.find(candidate => candidate.accountId === 'unknown-review-adult')?.label).toBe('Existing adult label');
    expect(review.candidates.find(candidate => candidate.accountId === 'toString')?.label).toBe('Unmapped adult reference');
    expect(administrationDisplayLabels(value, { issuer: 'https://identity.example/real-club' })).toBe(value);
    expect(value.candidates[0].label).toBe('provider-specific-reference');
  });
});
