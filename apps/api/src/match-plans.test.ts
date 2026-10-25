import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createApi } from "./server";
import { createPostgresApi } from "./postgres-server";
import {
  EVENT_CONTRACT_VERSION,
  SYNTHETIC_IDS,
  type EventEnvelope,
} from "./store";
import {
  ENGINE_VERSION,
  reduceMatch,
  type MatchEvent,
  type MatchState,
} from "../../../packages/domain/src/index";
import { effectiveEventTime } from "../../../packages/application/src/sync";
import {
  previewMatchPlan,
  type MatchPlanSettings,
} from "../../../packages/application/src/match-plans";
import type { PreparationState } from "../../../packages/application/src/preparation";
const now = Date.parse("2026-10-21T12:00:00Z"),
  teamPath = `/v1/teams/${SYNTHETIC_IDS.teamId}/preparation?seasonId=${SYNTHETIC_IDS.seasonId}`;
const postgres = process.env.LONGBALL_POSTGRES_TEST_URL;
for (const backend of ["sqlite", "postgres"] as const)
  describe.skipIf(backend === "postgres" && !postgres)(
    `${backend} reusable match-plan actual HTTP`,
    () => {
      it("saves/applies exact proposals and retries once while preserving check-in and refusing stale/claimed/played or unauthorised changes", async () => {
        const directory = mkdtempSync(join(tmpdir(), "longball-match-plans-"));
        let admin: Pool | null = null,
          database: string | null = null;
        let api:
          | ReturnType<typeof createApi>
          | Awaited<ReturnType<typeof createPostgresApi>>
          | null = null;
        try {
          if (backend === "postgres") {
            admin = new Pool({ connectionString: postgres, max: 1 });
            database = `longball_plans_${randomUUID().replaceAll("-", "")}`;
            await admin.query(`CREATE DATABASE "${database}"`);
            const url = new URL(postgres!);
            url.pathname = `/${database}`;
            api = await createPostgresApi({
              connectionString: url.href,
              databasePath: join(directory, "unused"),
              syntheticAuth: true,
              allowOwnerTestFixture: true,
              now: () => now,
            });
          } else
            api = createApi({
              databasePath: join(directory, "service.sqlite"),
              syntheticAuth: true,
              now: () => now,
            });
          const server = api.server;
          await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve),
          );
          const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
          const call = async (
            path: string,
            body?: unknown,
            key = randomUUID(),
            token = "synthetic-manager-1",
            controller?: string,
          ) => {
            const response = await fetch(base + path, {
              method: body === undefined ? "GET" : "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                ...(body === undefined
                  ? {}
                  : {
                      "content-type": "application/json",
                      "idempotency-key": key,
                      "x-api-contract-version": EVENT_CONTRACT_VERSION,
                    }),
                ...(controller ? { "x-controller-token": controller } : {}),
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            return {
              status: response.status,
              body: (await response.json()) as Record<string, unknown>,
            };
          };
          let state = (await call(teamPath))
            .body as unknown as PreparationState;
          const command = async (
            payload: Record<string, unknown>,
            key = randomUUID(),
          ) => {
            const response = await call(
              teamPath,
              {
                command: {
                  id: key,
                  expectedRevision: state.revision,
                  ...payload,
                },
              },
              key,
            );
            if (response.status === 200)
              state = response.body as unknown as PreparationState;
            return response;
          };
          expect(
            (
              await command({
                type: "fixture.prepared",
                fixtureId: SYNTHETIC_IDS.matchId,
                formationId: "formation-7",
              })
            ).status,
          ).toBe(200);
          const sourceSnapshot = structuredClone(state.snapshots.at(-1)!),
            sourceBefore = structuredClone(state.snapshots),
            selected = new Set<string>();
          const allocations = sourceSnapshot.formation.slots.map((slot) => {
            const player = sourceSnapshot.profiles.find(
              (profile) =>
                !selected.has(profile.playerId) &&
                profile.eligiblePositions.includes(slot.position) &&
                (slot.position !== "GK" ||
                  profile.preferences.slice(0, 2).includes("GK")),
            )!;
            selected.add(player.playerId);
            return {
              slotId: slot.id,
              position: slot.position,
              playerId: player.playerId,
            };
          });
          const settings: MatchPlanSettings = {
            payload: {
              keeperMode: "sole_fixed",
              fixedKeeperPlayerSeasonId: allocations.find(
                (row) => row.position === "GK",
              )!.playerId,
              minimumStintMs: 300_000,
              batchLimit: 2,
              scoreLeadThreshold: 4,
              returnToNormalEnabled: false,
            },
            applicability: {
              minimumStint: "soft_preference",
              batchLimit: "soft_preference",
              q07: "unapproved",
            },
            softPreferences: { halfBufferFraction: 0.15 },
          };
          const plan = {
            type: "match_plan.saved",
            planId: "http-plan",
            expectedPlanVersion: 0,
            name: "Private manager plan",
            description: "Reviewed template",
            sourceFixtureId: SYNTHETIC_IDS.matchId,
            sourceSnapshotId: sourceSnapshot.id,
            allocations,
            settings,
          };
          expect((await command(plan)).status).toBe(200);
          const other = await call(
            teamPath,
            {
              command: {
                ...plan,
                id: randomUUID(),
                expectedRevision: state.revision,
              },
            },
            randomUUID(),
            "synthetic-account-player-01",
          );
          expect(other.status).toBe(404);
          const own = await call(
            `/v1/teams/${SYNTHETIC_IDS.teamId}/preparation/own?seasonId=${SYNTHETIC_IDS.seasonId}`,
            undefined,
            randomUUID(),
            "synthetic-account-player-01",
          );
          expect(JSON.stringify(own.body)).not.toContain(
            "Private manager plan",
          );
          const destination = "http-future-fixture";
          expect(
            (
              await command({
                type: "fixture.saved",
                fixture: {
                  ...sourceSnapshot.fixture,
                  id: destination,
                  opponent: "Fictional Template FC",
                  playedDate: "2026-11-07",
                },
              })
            ).status,
          ).toBe(200);
          expect(
            (
              await command({
                type: "fixture.selection_saved",
                fixtureId: destination,
                selectedProfileIds: state.fixtures[0].selectedProfileIds,
              })
            ).status,
          ).toBe(200);
          expect(
            (
              await command({
                type: "fixture.response_recorded",
                fixtureId: destination,
                profileId: state.fixtures[0].selectedProfileIds[0],
                response: "available",
              })
            ).status,
          ).toBe(200);
          const beforeTarget = structuredClone(
            state.fixtures.find((row) => row.id === destination)!,
          );
          const preview = previewMatchPlan(state, "http-plan", destination, {
            nowMs: now,
          });
          expect(preview.ready).toBe(true);
          const key = randomUUID(),
            request = {
              command: {
                type: "match_plan.applied",
                id: key,
                expectedRevision: state.revision,
                fixtureId: destination,
                planId: "http-plan",
                planVersion: 1,
                previewKey: preview.previewKey,
                confirm: true,
              },
            };
          const accepted = await call(teamPath, request, key);
          expect(accepted.status).toBe(200);
          expect(await call(teamPath, request, key)).toEqual(accepted);
          state = (await call(teamPath)).body as unknown as PreparationState;
          const target = state.fixtures.find((row) => row.id === destination)!;
          expect(target).toMatchObject({
            responses: beforeTarget.responses,
            attendance: beforeTarget.attendance,
            selectedProfileIds: beforeTarget.selectedProfileIds,
            matchPlanDraft: { templateVersion: 1 },
          });
          expect(state.snapshots).toEqual(sourceBefore);
          const oldPreview = previewMatchPlan(state, "http-plan", destination, {
            nowMs: now,
          });
          expect(
            (
              await command({
                ...plan,
                expectedPlanVersion: 1,
                name: "Changed source template",
              })
            ).status,
          ).toBe(200);
          const refused = await command({
            type: "match_plan.applied",
            fixtureId: destination,
            planId: "http-plan",
            planVersion: 1,
            previewKey: oldPreview.previewKey,
            confirm: true,
          });
          expect(refused.status).toBe(422);
          expect(
            (
              await command({
                type: "fixture.prepared",
                fixtureId: destination,
                formationId: target.matchPlanDraft!.formation.id,
              })
            ).status,
          ).toBe(200);
          const matchPath = `/v1/matches/${destination}`,
            match = (await call(matchPath)).body.state as MatchState;
          expect(match.stagedLineup).toEqual([]);
          expect(
            Object.values(match.attendance).every(
              (value) => value === "not_recorded",
            ),
          ).toBe(true);
          expect(
            (
              match.config as MatchState["config"] & {
                initialPolicyProposal: MatchPlanSettings;
              }
            ).initialPolicyProposal,
          ).toEqual(settings);
          const grant = await call(`${matchPath}/controller`, {
            deviceId: "plan-phone",
          });
          expect(grant.status).toBe(200);
          const beforeClaimedRefusal = structuredClone(state);
          const claimedPreview = previewMatchPlan(
            state,
            "http-plan",
            destination,
            { nowMs: now },
          );
          expect(
            (
              await command({
                type: "match_plan.applied",
                fixtureId: destination,
                planId: "http-plan",
                planVersion: 2,
                previewKey: claimedPreview.previewKey,
                confirm: true,
              })
            ).status,
          ).toBe(422);
          expect((await call(teamPath)).body).toEqual(beforeClaimedRefusal);
          let projected = (
              await call(`${matchPath}/download?deviceId=plan-phone`)
            ).body.state as MatchState,
            previousId: string | null = null,
            sequence = 0;
          const events: EventEnvelope[] = [];
          const append = (payload: Record<string, unknown>) => {
            const id = randomUUID(),
              command = {
                ...payload,
                id,
                sample: {
                  monotonicMs: 0,
                  sessionId: "plan-session",
                  wallTimeMs: now,
                },
              } as MatchEvent;
            const next = reduceMatch(projected, command),
              effective = effectiveEventTime(projected, next, command);
            events.push({
              contractVersion: EVENT_CONTRACT_VERSION,
              schemaVersion: 1,
              engineVersion: ENGINE_VERSION,
              eventId: id,
              matchId: destination,
              deviceId: "plan-phone",
              controllerEpoch: 1,
              clientSequence: ++sequence,
              previousEventId: previousId,
              baseRevision: projected.revision,
              effectiveHalf: effective.half,
              halfElapsedMs: effective.halfElapsedMs,
              matchElapsedMs: effective.matchElapsedMs,
              effectiveAt: new Date(now).toISOString(),
              recordedAt: new Date(now).toISOString(),
              timeQuality: "reviewRequired",
              clockEvidence: {
                monotonicMs: 0,
                anchorId: "plan-anchor",
                continuityId: "plan-session",
              },
              command,
            });
            projected = next;
            previousId = id;
          };
          for (const row of allocations)
            append({
              type: "attendance.recorded",
              playerId: row.playerId,
              status: "present",
            });
          append({ type: "lineup.staged", lineup: allocations });
          append({ type: "half.started" });
          expect(
            (
              await call(
                `${matchPath}/events`,
                { events },
                randomUUID(),
                "synthetic-manager-1",
                grant.body.controllerToken as string,
              )
            ).status,
          ).toBe(200);
          const playedBefore = (await call(matchPath)).body;
          const playedPreview = previewMatchPlan(
            state,
            "http-plan",
            destination,
            { nowMs: now },
          );
          expect(
            (
              await command({
                type: "match_plan.applied",
                fixtureId: destination,
                planId: "http-plan",
                planVersion: 2,
                previewKey: playedPreview.previewKey,
                confirm: true,
              })
            ).status,
          ).toBe(422);
          expect((await call(matchPath)).body).toEqual(playedBefore);
        } finally {
          if (api) {
            api.server.closeAllConnections();
            await api.close();
          }
          if (admin) {
            if (database)
              await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
            await admin.end();
          }
          rmSync(directory, { recursive: true, force: true });
        }
      }, 30_000);
    },
  );
