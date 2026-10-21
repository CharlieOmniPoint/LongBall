import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as imageProcess from "./image-process";
import { createApi } from "./server";
import { createPostgresApi } from "./postgres-server";
import { PostgresStore } from "./postgres-store";
import { PgDatabase } from "./pg";
import { PgMediaService } from "./postgres-media";
import { PostgresActivationService } from "./postgres-activation";
import { applyRuntimeGrants } from "./runtime-grants";
import { EVENT_CONTRACT_VERSION, SYNTHETIC_IDS } from "./store";
import type { CommunityState } from "../../../packages/application/src/community";
import type { TeamPrivilegesView } from "../../../packages/application/src/team-privileges";

const configured = process.env.LONGBALL_POSTGRES_TEST_URL;
const now = 1_800_000_000_000;
const teamId = SYNTHETIC_IDS.teamId,
  seasonId = SYNTHETIC_IDS.seasonId;
const target = (number = "01") => `synthetic-account-player-${number}`;
const path = (
  section: string,
  season: string = seasonId,
  team: string = teamId,
) =>
  `/v1/teams/${team}/${section}${section.includes("?") ? "&" : "?"}seasonId=${season}`;
const png = () =>
  sharp({
    create: { width: 32, height: 16, channels: 3, background: "#176b45" },
  })
    .png()
    .toBuffer();
type Reply = { status: number; body: Record<string, unknown> };
for (const kind of ["SQLite", "PostgreSQL"] as const)
  describe.skipIf(kind === "PostgreSQL" && !configured)(
    `${kind} SEC17 actual HTTP boundaries`,
    () => {
      let api:
        | ReturnType<typeof createApi>
        | Awaited<ReturnType<typeof createPostgresApi>>;
      let directory: string,
        base: string,
        owner: PgDatabase | null = null,
        admin: Pool | null = null,
        database = "";
      let bytes: Buffer;
      const scannerFixtures = new Set<string>();
      let useCurrentClock = false;
      let scanGate: { entered: () => void; wait: Promise<void> } | null = null;
      const roles: string[] = [];
      const query = async (sql: string, values: unknown[] = []) => {
        if (owner) return (await owner.query(sql, values)).rows;
        const source = api.store;
        if (!("database" in source))
          throw new Error("Expected fictional SQLite fixture");
        const args: unknown[] = [];
        const converted = sql.replace(/\$(\d+)/g, (_, position: string) => {
          args.push(values[Number(position) - 1]);
          return "?";
        });
        return source.database
          .prepare(converted)
          .all(...(args as (string | number | null)[]));
      };
      const call = async (
        section: string,
        options: {
          account?: string;
          role?: string;
          body?: unknown;
          key?: string;
          method?: string;
          season?: string;
          team?: string;
          token?: string;
          raw?: Buffer;
        } = {},
      ): Promise<Reply> => {
        const key = options.key ?? randomUUID();
        const headers: Record<string, string> = {
          Authorization: `Bearer ${options.account ?? "synthetic-manager-1"}`,
          "X-Longball-Role": options.role ?? "manager",
        };
        const method =
          options.method ??
          (options.body === undefined && !options.raw ? "GET" : "POST");
        if (method !== "GET") {
          headers["Idempotency-Key"] = key;
          headers["X-Api-Contract-Version"] = EVENT_CONTRACT_VERSION;
        }
        if (options.body !== undefined)
          headers["Content-Type"] = "application/json";
        if (options.raw) headers["Content-Type"] = "application/octet-stream";
        if (options.token) headers["X-Media-Upload-Token"] = options.token;
        const response = await fetch(
          `${base}${path(section, options.season, options.team)}`,
          {
            method,
            headers,
            body: options.raw
              ? new Uint8Array(options.raw)
              : options.body === undefined
                ? undefined
                : JSON.stringify(options.body),
          },
        );
        return {
          status: response.status,
          body: (await response.json()) as Record<string, unknown>,
        };
      };
      const view = async () => {
        const reply = await call("privileges");
        expect(reply.status).toBe(200);
        return reply.body as unknown as TeamPrivilegesView;
      };
      const decision = async (
        accountId: string,
        privilege: "uploads" | "invitations",
        suspended: boolean,
        extra: Record<string, unknown> = {},
        request: Parameters<typeof call>[1] = {},
      ) => {
        const id = randomUUID();
        return call("privileges", {
          ...request,
          key: id,
          body: {
            command: {
              id,
              type: suspended ? "privilege.suspended" : "privilege.reinstated",
              expectedRevision: (await view()).revision,
              targetAccountId: accountId,
              privilege,
              reasonCode: "explicit_test_review",
              privateNote: "restricted-note-never-returned-to-target",
              confirm: true,
              ...extra,
            },
          },
        });
      };
      let uploadInput = () => ({
        matchId: "synthetic-2026-27-fixture-ravens",
        byteSize: bytes.length,
        mimeType: "image/png",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        caption: "Fictional geometric test image",
        policyAcknowledged: true,
      });
      beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), `longball-sec17-${kind}-`));
        bytes = await png();
        scannerFixtures.add(createHash("sha256").update(bytes).digest("hex"));
        const options = {
          databasePath: join(directory, "service.sqlite"),
          syntheticAuth: true,
          now: () => (useCurrentClock ? Date.now() : now),
          publicAppEntryUrl: "https://example.invalid/LongBall/",
          invitationPolicyVersion: "explicit-fictional-test-policy",
          mediaScanner: {
            scan: async (input: Buffer) => {
              const gate = scanGate;
              if (gate) {
                gate.entered();
                await gate.wait;
              }
              return {
                verdict: scannerFixtures.has(
                  createHash("sha256").update(input).digest("hex"),
                )
                  ? ("clean" as const)
                  : ("rejected" as const),
                engine: "known-fictional-image-test-only",
              };
            },
          },
        };
        if (kind === "SQLite") api = createApi(options);
        else {
          admin = new Pool({ connectionString: configured!, max: 2 });
          const suffix = randomUUID().replaceAll("-", "");
          database = `lb_sec17_${suffix}`;
          for (const purpose of ["owner", "api", "worker"]) {
            const role = `lb_sec17_${purpose}_${suffix}`;
            roles.push(role);
            await admin.query(
              `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
            );
          }
          await admin.query(`CREATE DATABASE "${database}"`);
          const url = new URL(configured!);
          url.pathname = `/${database}`;
          const bootstrap = new Pool({ connectionString: url.href });
          try {
            await bootstrap.query(
              `CREATE SCHEMA longball AUTHORIZATION "${roles[0]}"`,
            );
          } finally {
            await bootstrap.end();
          }
          url.username = roles[0];
          url.password = "";
          owner = new PgDatabase(url.href, { migrationMode: "apply" });
          await owner.migrate();
          const seed = new PostgresStore(owner, () => now);
          await seed.seedSynthetic();
          await PgMediaService.open({
            directory: join(directory, "media"),
            database: owner,
          });
          await new PostgresActivationService({ store: seed }).initialize();
          await applyRuntimeGrants(owner, {
            apiRole: roles[1],
            workerRole: roles[2],
          });
          url.username = roles[1];
          api = await createPostgresApi({
            ...options,
            connectionString: url.href,
            seedSynthetic: false,
            migrationMode: "verify",
          });
        }
        await new Promise<void>((resolve) =>
          api.server.listen(0, "127.0.0.1", resolve),
        );
        base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
        const rawCommunity = (
          await query(
            "SELECT value_json FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='community'",
            [teamId, seasonId],
          )
        )[0].value_json;
        const community = (
          typeof rawCommunity === "string"
            ? JSON.parse(rawCommunity)
            : rawCommunity
        ) as CommunityState;
        // Match identity comes from the retained fictional seed rather than a caller-invented trusted finish.
        uploadInput = () => ({
          matchId: community.matches[0].id,
          byteSize: bytes.length,
          mimeType: "image/png",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          caption: "Fictional geometric test image",
          policyAcknowledged: true,
        });
      });
      afterAll(async () => {
        if (api) await api.close();
        await owner?.close();
        if (database)
          await admin?.query(`DROP DATABASE "${database}" WITH(FORCE)`);
        for (const role of roles) await admin?.query(`DROP ROLE "${role}"`);
        await admin?.end();
        if (directory) await rm(directory, { recursive: true, force: true });
      });
      it("denies players, spectators, administrator-only accounts, forged roles and other-team managers", async () => {
        for (const account of [
          "synthetic-account-player-01",
          "synthetic-spectator",
          "synthetic-admin",
          "synthetic-other-manager",
        ]) {
          expect(
            (await call("privileges", { account, role: "manager" })).status,
          ).toBe(404);
          const reply = await decision(
            target(),
            "uploads",
            true,
            {},
            { account, role: "manager" },
          );
          expect([403, 404]).toContain(reply.status);
        }
        expect(
          (await decision("synthetic-account-other-manager", "uploads", true))
            .status,
        ).toBe(404);
        expect((await view()).revision).toBe(0);
        expect(
          await call("privileges/own", {
            account: "synthetic-spectator",
            role: "spectator",
          }),
        ).toMatchObject({
          status: 200,
          body: { uploadsAllowed: false, invitationsAllowed: false },
        });
      });
      it("commits a reasoned suspension once, rejects stale/changed duplicates and keeps restricted audit out of all DTOs", async () => {
        const before = await view(),
          id = randomUUID();
        const command = {
          id,
          type: "privilege.suspended",
          expectedRevision: before.revision,
          targetAccountId: target(),
          privilege: "invitations",
          reasonCode: "invitation_review",
          privateNote: "restricted-note-never-returned-to-target",
          confirm: true,
        };
        const first = await call("privileges", { key: id, body: { command } }),
          duplicate = await call("privileges", { key: id, body: { command } });
        expect(first.status).toBe(200);
        expect(duplicate).toEqual(first);
        expect((await view()).revision).toBe(before.revision + 1);
        expect(
          (
            await call("privileges", {
              key: id,
              body: { command: { ...command, reasonCode: "changed" } },
            })
          ).status,
        ).toBe(409);
        const staleId = randomUUID();
        expect(
          (
            await call("privileges", {
              key: staleId,
              body: {
                command: {
                  ...command,
                  id: staleId,
                  targetAccountId: target("02"),
                },
              },
            })
          ).status,
        ).toBe(409);
        expect(
          await query(
            "SELECT * FROM team_privilege_decisions WHERE team_id=$1",
            [teamId],
          ),
        ).toHaveLength(1);
        const own = await call("privileges/own", {
          account: target(),
          role: "player",
        });
        expect(own).toMatchObject({
          status: 200,
          body: { invitationsAllowed: false, uploadsAllowed: true },
        });
        expect(JSON.stringify([own.body, await view()])).not.toMatch(
          /restricted-note|invitation_review|privateNote|reasonCode/,
        );
        expect((await decision(target(), "invitations", false)).status).toBe(
          200,
        );
        const currentRevision = (await view()).revision;
        expect(
          await call("privileges", { key: id, body: { command } }),
        ).toEqual(first);
        expect((await view()).revision).toBe(currentRevision);
        expect(
          (await call("privileges/own", { account: target(), role: "player" }))
            .body.invitationsAllowed,
        ).toBe(true);
        await expect(
          query(
            "UPDATE team_privilege_decisions SET reason_code='rewritten' WHERE team_id=$1 AND revision=1",
            [teamId],
          ),
        ).rejects.toThrow(/Immutable team privilege decision/);
      });
      it("blocks future issue/reissue, preserves pending invitations and explicitly reinstates without removing history", async () => {
        const account = target("03"),
          role = "player";
        const issued = await call("spectator-invites", {
          account,
          role,
          body: { seasonId, expiresInHours: 1 },
        });
        expect(issued.status).toBe(201);
        expect((await decision(account, "invitations", true)).status).toBe(200);
        expect(
          (
            await call("spectator-invites", {
              account,
              role,
              body: { seasonId, expiresInHours: 1 },
            })
          ).status,
        ).toBe(403);
        expect(
          (
            await call(`spectator-invites/${issued.body.id}/reissue`, {
              account,
              role,
              body: { seasonId, expiresInHours: 1 },
            })
          ).status,
        ).toBe(403);
        const list = await call("spectator-invites", { account, role });
        expect(list.status).toBe(200);
        const item = (list.body.invitations as Record<string, unknown>[]).find(
          (row) => row.id === issued.body.id,
        );
        expect(item).toMatchObject({ status: "pending", canReissue: false });
        const token = new URLSearchParams(
          new URL(String(issued.body.shareUrl)).hash.slice(1),
        ).get("code")!;
        const invitationAction = async (action: string) => {
          const response = await fetch(
            `${base}/v1/spectator-invites/${action}`,
            {
              method: "POST",
              headers: {
                Authorization: "Bearer synthetic-account-invitee",
                "Content-Type": "application/json",
                "X-Api-Contract-Version": EVENT_CONTRACT_VERSION,
                "Idempotency-Key": randomUUID(),
              },
              body: JSON.stringify({ token }),
            },
          );
          return {
            status: response.status,
            body: (await response.json()) as Record<string, unknown>,
          };
        };
        expect((await invitationAction("inspect")).status).toBe(200);
        expect((await invitationAction("accept")).status).toBe(200);
        expect(
          (
            await query(
              "SELECT revoked_at FROM memberships WHERE account_id='synthetic-account-invitee' AND team_id=$1 AND season_id=$2 AND role='spectator'",
              [teamId, seasonId],
            )
          )[0].revoked_at,
        ).toBeNull();
        expect((await decision(account, "invitations", false)).status).toBe(
          200,
        );
        expect(
          (
            await call("spectator-invites", {
              account,
              role,
              body: { seasonId, expiresInHours: 1 },
            })
          ).status,
        ).toBe(201);
        const rows = await query(
          "SELECT * FROM team_privilege_decisions WHERE team_id=$1 AND target_account_id=$2",
          [teamId, account],
        );
        expect(rows).toHaveLength(2);
      });
      it("denies old prepared upload tokens and completion, retains the private manifest and resumes only after explicit reinstatement", async () => {
        const account = target("04"),
          role = "player";
        const prepared = await call("media/uploads/prepare", {
          account,
          role,
          body: uploadInput(),
        });
        expect(prepared.status).toBe(200);
        const uploadId = String(prepared.body.uploadId),
          token = String(prepared.body.uploadToken);
        expect((await decision(account, "uploads", true)).status).toBe(200);
        expect(
          (
            await call("media/uploads/prepare", {
              account,
              role,
              body: uploadInput(),
            })
          ).status,
        ).toBe(403);
        expect(
          (
            await call(`media/uploads/${uploadId}`, {
              account,
              role,
              method: "PUT",
              token,
              raw: bytes,
            })
          ).status,
        ).toBe(403);
        expect(
          (
            await call(`media/uploads/${uploadId}/complete`, {
              account,
              role,
              token,
              body: {},
            })
          ).status,
        ).toBe(403);
        const manifests = await call("media/uploads", { account, role });
        expect(manifests.status).toBe(200);
        expect(JSON.stringify(manifests.body)).toContain(uploadId);
        expect(JSON.stringify(manifests.body)).not.toContain(token);
        expect((await decision(account, "uploads", false)).status).toBe(200);
        expect(
          (
            await call(`media/uploads/${uploadId}`, {
              account,
              role,
              method: "PUT",
              token,
              raw: bytes,
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await call(`media/uploads/${uploadId}/complete`, {
              account,
              role,
              token,
              body: {},
            })
          ).status,
        ).toBe(200);
        const community = await call("community", { account, role });
        expect(community.status).toBe(200);
        expect(JSON.stringify(community.body)).toContain(
          String(prepared.body.photoId),
        );
      });
      it("retains the same private upload and capability after decoder timeout, crash or startup failure", async () => {
        const account = target("09"),
          role = "player";
        for (const error of [
          Object.assign(new Error("controlled timeout"), {
            killed: true,
            signal: "SIGKILL",
          }),
          Object.assign(new Error("controlled crash"), {
            code: null,
            signal: "SIGABRT",
          }),
          Object.assign(new Error("controlled startup failure"), {
            code: "ENOENT",
          }),
        ]) {
          const prepared = await call("media/uploads/prepare", {
            account,
            role,
            body: uploadInput(),
          });
          expect(prepared.status).toBe(200);
          const uploadId = String(prepared.body.uploadId),
            token = String(prepared.body.uploadToken),
            photoId = String(prepared.body.photoId),
            key = randomUUID();
          expect(
            (
              await call(`media/uploads/${uploadId}`, {
                account,
                role,
                method: "PUT",
                token,
                raw: bytes,
              })
            ).status,
          ).toBe(200);
          const decoder = vi
            .spyOn(imageProcess, "executeImageDecoder")
            .mockRejectedValueOnce(error);
          try {
            const unavailable = await call(
              `media/uploads/${uploadId}/complete`,
              { account, role, token, key, body: {} },
            );
            expect(unavailable).toMatchObject({
              status: 503,
              body: { code: "MEDIA_PROCESSING_FAILED" },
            });
            expect(decoder.mock.calls[0][1]).toBe(12_000);
          } finally {
            decoder.mockRestore();
          }
          const rows = await query(
            "SELECT status,original_key,display_key,thumbnail_key,failure_code,token_hash FROM media_uploads WHERE id=$1",
            [uploadId],
          );
          expect(rows[0]).toMatchObject({
            status: "uploaded",
            original_key: expect.any(String),
            display_key: null,
            thumbnail_key: null,
            failure_code: "MEDIA_PROCESSING_FAILED",
            token_hash: createHash("sha256").update(token).digest("hex"),
          });
          expect(
            JSON.stringify((await call("community", { account, role })).body),
          ).not.toContain(photoId);
          for (const variant of ["display", "thumbnail"]) {
            const response = await fetch(
              `${base}${path(`media/photos/${photoId}/revisions/1/${variant}`)}&mode=own`,
              {
                headers: {
                  Authorization: `Bearer ${account}`,
                  "X-Longball-Role": role,
                },
              },
            );
            expect(response.status).toBe(404);
          }
          expect(
            (
              await call(`media/uploads/${uploadId}/complete`, {
                account,
                role,
                token: "wrong-capability",
                key,
                body: {},
              })
            ).status,
          ).toBe(404);
          expect(
            (
              await call(`media/uploads/${uploadId}/complete`, {
                account,
                role,
                token,
                key,
                body: {},
              })
            ).status,
          ).toBe(200);
          expect(
            (
              await query("SELECT status FROM media_uploads WHERE id=$1", [
                uploadId,
              ])
            )[0].status,
          ).toBe("linked");
        }
      });
      it("keeps confirmed malformed image rejection terminal and unpublished through HTTP", async () => {
        const account = target("10"),
          role = "player",
          invalid = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
        scannerFixtures.add(createHash("sha256").update(invalid).digest("hex"));
        const prepared = await call("media/uploads/prepare", {
          account,
          role,
          body: {
            ...uploadInput(),
            byteSize: invalid.length,
            sha256: createHash("sha256").update(invalid).digest("hex"),
          },
        });
        expect(prepared.status).toBe(200);
        const uploadId = String(prepared.body.uploadId),
          token = String(prepared.body.uploadToken),
          photoId = String(prepared.body.photoId);
        expect(
          (
            await call(`media/uploads/${uploadId}`, {
              account,
              role,
              method: "PUT",
              token,
              raw: invalid,
            })
          ).status,
        ).toBe(200);
        expect(
          await call(`media/uploads/${uploadId}/complete`, {
            account,
            role,
            token,
            body: {},
          }),
        ).toMatchObject({
          status: 415,
          body: { code: "IMAGE_DECODE_REJECTED" },
        });
        expect(
          (
            await query(
              "SELECT status,display_key,thumbnail_key,failure_code FROM media_uploads WHERE id=$1",
              [uploadId],
            )
          )[0],
        ).toEqual({
          status: "rejected",
          display_key: null,
          thumbnail_key: null,
          failure_code: "IMAGE_DECODE_REJECTED",
        });
        expect(
          (
            await call(`media/uploads/${uploadId}/complete`, {
              account,
              role,
              token,
              body: {},
            })
          ).status,
        ).toBe(409);
        expect(
          JSON.stringify((await call("community", { account, role })).body),
        ).not.toContain(photoId);
      });
      it("keeps the decision across a second explicit season while leaving another team unaffected", async () => {
        const account = target("07"),
          secondSeason = "explicit-test-second-season";
        const raw = (
          await query(
            "SELECT value_json FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='community'",
            [teamId, seasonId],
          )
        )[0].value_json;
        const original = (
          typeof raw === "string" ? JSON.parse(raw) : raw
        ) as CommunityState;
        const community: CommunityState = {
          ...original,
          revision: 0,
          memberships: original.memberships.map((member) => ({
            ...member,
            seasonId: secondSeason,
          })),
          seasons: [
            {
              ...original.seasons.find((season) => season.id === seasonId)!,
              id: secondSeason,
            },
          ],
          matches: [],
          invitations: [],
          grants: [],
          photos: [],
          ballots: [],
          awards: [],
          concerns: [],
          audit: [],
          appliedCommands: {},
        };
        if (owner) {
          const club = (
            await query("SELECT club_id FROM teams WHERE id=$1", [teamId])
          )[0].club_id;
          await query(
            "INSERT INTO team_seasons(club_id,team_id,season_id,label) VALUES($1,$2,$3,'Explicit fictional test season')",
            [club, teamId, secondSeason],
          );
          await query(
            "INSERT INTO memberships(account_id,club_id,team_id,season_id,role,player_id) SELECT account_id,club_id,team_id,$1,role,player_id FROM memberships WHERE team_id=$2 AND season_id=$3 AND account_id=$4",
            [secondSeason, teamId, seasonId, account],
          );
          await query(
            "INSERT INTO documents(club_id,team_id,season_id,kind,revision,value_json) VALUES($1,$2,$3,'community',0,$4)",
            [club, teamId, secondSeason, JSON.stringify(community)],
          );
          const other = (
            await query(
              "SELECT club_id FROM teams WHERE id='synthetic-other-team'",
            )
          )[0].club_id;
          await query(
            "INSERT INTO memberships(account_id,club_id,team_id,season_id,role,player_id) VALUES($1,$2,'synthetic-other-team',$3,'player','player-07')",
            [account, other, seasonId],
          );
        } else {
          await query(
            "INSERT INTO memberships(account_id,team_id,season_id,role,player_id) SELECT account_id,team_id,$1,role,player_id FROM memberships WHERE team_id=$2 AND season_id=$3 AND account_id=$4",
            [secondSeason, teamId, seasonId, account],
          );
          await query(
            "INSERT INTO documents(team_id,season_id,kind,revision,value_json) VALUES($1,$2,'community',0,$3)",
            [teamId, secondSeason, JSON.stringify(community)],
          );
          await query(
            "INSERT INTO memberships(account_id,team_id,season_id,role,player_id) VALUES($1,'synthetic-other-team',$2,'player','player-07')",
            [account, seasonId],
          );
        }
        expect((await decision(account, "uploads", true)).status).toBe(200);
        expect(
          (
            await call("privileges/own", {
              account,
              role: "player",
              season: secondSeason,
            })
          ).body.uploadsAllowed,
        ).toBe(false);
        expect(
          (
            await call("privileges/own", {
              account,
              role: "player",
              team: "synthetic-other-team",
            })
          ).body.uploadsAllowed,
        ).toBe(true);
        expect((await decision(account, "uploads", false)).status).toBe(200);
        expect(
          (
            await call("privileges/own", {
              account,
              role: "player",
              season: secondSeason,
            })
          ).body.uploadsAllowed,
        ).toBe(true);
      });
      if (kind === "PostgreSQL")
        it("rechecks a suspension accepted during scanning before linking and retries the same completion only after reinstatement", async () => {
          const account = target("06"),
            role = "player";
          const prepared = await call("media/uploads/prepare", {
            account,
            role,
            body: uploadInput(),
          });
          expect(prepared.status).toBe(200);
          const uploadId = String(prepared.body.uploadId),
            token = String(prepared.body.uploadToken);
          expect(
            (
              await call(`media/uploads/${uploadId}`, {
                account,
                role,
                method: "PUT",
                token,
                raw: bytes,
              })
            ).status,
          ).toBe(200);
          let entered!: () => void, release!: () => void;
          const started = new Promise<void>((resolve) => {
            entered = resolve;
          });
          scanGate = {
            entered: () => entered(),
            wait: new Promise<void>((resolve) => {
              release = resolve;
            }),
          };
          const key = randomUUID(),
            completion = call(`media/uploads/${uploadId}/complete`, {
              account,
              role,
              key,
              token,
              body: {},
            });
          try {
            await started;
            expect((await decision(account, "uploads", true)).status).toBe(200);
          } finally {
            scanGate = null;
            release();
          }
          const held = await completion;
          expect(held).toMatchObject({
            status: 403,
            body: { code: "TEAM_UPLOADS_SUSPENDED" },
          });
          const manifest = (
            await query("SELECT status FROM media_uploads WHERE id=$1", [
              uploadId,
            ])
          )[0];
          expect(manifest.status).toBe("processed");
          for (const variant of ["display", "thumbnail"])
            expect(
              (
                await call(
                  `media/photos/${prepared.body.photoId}/${variant}?mode=own&revision=1`,
                  { account, role },
                )
              ).status,
            ).toBe(404);
          const current = await call("community", { account, role });
          expect(JSON.stringify(current.body)).not.toContain(
            String(prepared.body.photoId),
          );
          expect((await decision(account, "uploads", false)).status).toBe(200);
          expect(
            (
              await call(`media/uploads/${uploadId}/complete`, {
                account,
                role,
                key,
                token,
                body: {},
              })
            ).status,
          ).toBe(200);
          expect(
            (
              await query("SELECT status FROM media_uploads WHERE id=$1", [
                uploadId,
              ])
            )[0].status,
          ).toBe("linked");
        });
      it("keeps already published images readable while holding new manager contributions", async () => {
        const prepared = await call("media/uploads/prepare", {
          body: uploadInput(),
        });
        expect(prepared.status).toBe(200);
        const uploadId = String(prepared.body.uploadId),
          token = String(prepared.body.uploadToken),
          photoId = String(prepared.body.photoId);
        expect(
          (
            await call(`media/uploads/${uploadId}`, {
              method: "PUT",
              token,
              raw: bytes,
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await call(`media/uploads/${uploadId}/complete`, {
              token,
              body: {},
            })
          ).status,
        ).toBe(200);
        const community = await call("community"),
          id = randomUUID();
        expect(
          (
            await call("community", {
              key: id,
              body: {
                command: {
                  id,
                  type: "photo.published",
                  photoId,
                  sourceRevision: 1,
                  policyAcknowledged: true,
                  expectedRevision: community.body.revision,
                },
              },
            })
          ).status,
        ).toBe(200);
        expect(
          (await decision("synthetic-account-manager", "uploads", true)).status,
        ).toBe(200);
        expect(
          (await call("media/uploads/prepare", { body: uploadInput() })).status,
        ).toBe(403);
        for (const variant of ["display", "thumbnail"]) {
          const response = await fetch(
            `${base}${path(`media/photos/${photoId}/${variant}?mode=own&revision=1`)}`,
            {
              headers: {
                Authorization: "Bearer synthetic-manager-1",
                "X-Longball-Role": "manager",
              },
            },
          );
          expect(response.status).toBe(200);
          expect(response.headers.get("cache-control")).toMatch(/no-store/);
          await response.arrayBuffer();
        }
        expect(
          (await decision("synthetic-account-manager", "uploads", false))
            .status,
        ).toBe(200);
      });
      if (kind === "PostgreSQL")
        it("stamps immutable audit evidence at actual current database time through restricted HTTP", async () => {
          useCurrentClock = true;
          try {
            const before = await view(),
              id = randomUUID(),
              accountId = target("07");
            const command = {
              id,
              type: "privilege.suspended",
              expectedRevision: before.revision,
              targetAccountId: accountId,
              privilege: "uploads",
              reasonCode: "current_clock_review",
              privateNote: "restricted_current_clock_note",
              confirm: true,
            };
            const databaseBefore = Number(
              (
                await query(
                  "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms",
                )
              )[0].now_ms,
            );
            expect(Math.abs(api.store.now() - Date.now())).toBeLessThan(1000);
            const accepted = await call("privileges", {
              key: id,
              body: { command },
            });
            expect(accepted).toMatchObject({
              status: 200,
              body: {
                kind: "team-privilege-receipt",
                commandId: id,
                teamId,
                revision: before.revision + 1,
              },
            });
            const databaseAfter = Number(
              (
                await query(
                  "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms",
                )
              )[0].now_ms,
            );
            const rows = await query(
              "SELECT * FROM team_privilege_decisions WHERE command_id=$1",
              [id],
            );
            expect(rows).toHaveLength(1);
            expect(rows[0]).toEqual({
              team_id: teamId,
              club_id: "synthetic-richmond-rovers",
              revision: before.revision + 1,
              command_id: id,
              actor_id: "synthetic-account-manager",
              target_account_id: accountId,
              privilege: "uploads",
              suspended: true,
              reason_code: "current_clock_review",
              private_note: "restricted_current_clock_note",
              created_at: expect.any(Number),
            });
            expect(Number(rows[0].created_at)).toBeGreaterThanOrEqual(
              databaseBefore,
            );
            expect(Number(rows[0].created_at)).toBeLessThanOrEqual(
              databaseAfter,
            );
            expect(
              await call("privileges", { key: id, body: { command } }),
            ).toEqual(accepted);
            expect(
              await query(
                "SELECT * FROM team_privilege_decisions WHERE command_id=$1",
                [id],
              ),
            ).toEqual(rows);
            const staleId = randomUUID();
            expect(
              (
                await call("privileges", {
                  key: staleId,
                  body: {
                    command: {
                      ...command,
                      id: staleId,
                      targetAccountId: target("06"),
                    },
                  },
                })
              ).status,
            ).toBe(409);
            expect(
              (
                await call("privileges", {
                  account: accountId,
                  role: "manager",
                  key: id,
                  body: { command },
                })
              ).status,
            ).toBe(404);
            const forgedTimestampId = randomUUID();
            expect(
              (
                await call("privileges", {
                  key: forgedTimestampId,
                  body: {
                    command: {
                      ...command,
                      id: forgedTimestampId,
                      expectedRevision: before.revision + 1,
                      createdAtMs: 0,
                    },
                  },
                })
              ).status,
            ).toBe(400);
            expect(
              JSON.stringify([
                await view(),
                (
                  await call("privileges/own", {
                    account: accountId,
                    role: "player",
                  })
                ).body,
              ]),
            ).not.toMatch(
              /restricted_current_clock_note|current_clock_review|privateNote|reasonCode/,
            );
            const restored = await decision(accountId, "uploads", false);
            expect(restored.status).toBe(200);
            await expect(
              query(
                "UPDATE team_privilege_decisions SET created_at=0 WHERE command_id=$1",
                [id],
              ),
            ).rejects.toThrow(/Immutable team privilege decision/);
          } finally {
            useCurrentClock = false;
          }
        });
      if (kind === "PostgreSQL")
        it("expands schema14 without rewriting audit rows and rolls back a failed audit-clock installation", async () => {
          if (!owner) throw new Error("Expected PostgreSQL migration fixture");
          await query(
            "DROP TRIGGER team_privilege_decision_received ON team_privilege_decisions",
          );
          await query(
            "DROP FUNCTION longball.stamp_team_privilege_decision_received()",
          );
          await query(
            "ALTER POLICY team_privilege_decision_insert ON team_privilege_decisions WITH CHECK(longball.team_privilege_manager(club_id,team_id) AND longball.context_json()->>'operation'='privileges.write' AND actor_id=longball.context_json()->>'accountId' AND longball.team_privilege_target(club_id,team_id,target_account_id) AND created_at=longball.context_now())",
          );
          await query("DELETE FROM schema_migrations WHERE version=15");
          const snapshot = async () => {
            const tables = await query(
                "SELECT tablename FROM pg_tables WHERE schemaname='longball' AND tablename<>'schema_migrations' ORDER BY tablename",
              ),
              result: Record<string, unknown> = {};
            for (const row of tables) {
              const name = String(row.tablename);
              expect(name).toMatch(/^[a-z0-9_]+$/);
              result[name] = await query(
                `SELECT to_jsonb(t) AS value FROM longball."${name}" t ORDER BY to_jsonb(t)::text`,
              );
            }
            return result;
          };
          const before = await snapshot();
          await query(
            "CREATE FUNCTION longball.stamp_team_privilege_decision_received() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
          );
          await expect(owner.migrate()).rejects.toMatchObject({
            code: "42723",
          });
          expect(
            await query(
              "SELECT version FROM schema_migrations WHERE version=15",
            ),
          ).toEqual([]);
          expect(
            await query(
              "SELECT tgname FROM pg_trigger WHERE tgname='team_privilege_decision_received'",
            ),
          ).toEqual([]);
          expect(await snapshot()).toEqual(before);
          await query(
            "DROP FUNCTION longball.stamp_team_privilege_decision_received()",
          );
          await owner.migrate();
          expect(
            await query(
              "SELECT version FROM schema_migrations ORDER BY version",
            ),
          ).toEqual(
            Array.from({ length: 15 }, (_, index) => ({ version: index + 2 })),
          );
          expect(await snapshot()).toEqual(before);
          await owner.migrate();
          if (!(api.store instanceof PostgresStore))
            throw new Error("Expected restricted PostgreSQL runtime");
          await api.store.db.migrate();
          expect(await snapshot()).toEqual(before);
        });
      it("rolls back the decision and audit if its receipt cannot commit, then accepts the exact retained retry", async () => {
        const before = (await view()).revision,
          id = randomUUID();
        const command = {
          id,
          type: "privilege.suspended",
          expectedRevision: before,
          targetAccountId: target("08"),
          privilege: "uploads",
          reasonCode: "content_review",
          privateNote: null,
          confirm: true,
        };
        if (owner) {
          await query(
            "CREATE FUNCTION refuse_sec17_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test receipt refusal'; END $$",
          );
          await query(
            "CREATE TRIGGER refuse_sec17_receipt BEFORE INSERT ON idempotency FOR EACH ROW EXECUTE FUNCTION refuse_sec17_receipt()",
          );
        } else
          await query(
            "CREATE TRIGGER refuse_sec17_receipt BEFORE INSERT ON idempotency BEGIN SELECT RAISE(ABORT,'test receipt refusal'); END",
          );
        try {
          expect(
            (await call("privileges", { key: id, body: { command } })).status,
          ).toBe(422);
        } finally {
          await query(
            "DROP TRIGGER refuse_sec17_receipt" +
              (owner ? " ON idempotency" : ""),
          );
          if (owner) await query("DROP FUNCTION refuse_sec17_receipt()");
        }
        expect((await view()).revision).toBe(before);
        expect(
          await query(
            "SELECT command_id FROM team_privilege_decisions WHERE command_id=$1",
            [id],
          ),
        ).toEqual([]);
        expect(
          (await call("privileges", { key: id, body: { command } })).status,
        ).toBe(200);
        expect((await view()).revision).toBe(before + 1);
      });
      it("does not expose a reason or permit new actions after team membership expires", async () => {
        const account = target("05");
        expect(
          (await call("privileges/own", { account, role: "player" })).status,
        ).toBe(200);
        await query(
          "UPDATE memberships SET expires_at=$1 WHERE account_id=$2 AND team_id=$3 AND season_id=$4",
          [now - 1, account, teamId, seasonId],
        );
        expect(
          (await call("privileges/own", { account, role: "player" })).status,
        ).toBe(404);
        expect(
          (
            await call("media/uploads/prepare", {
              account,
              role: "player",
              body: uploadInput(),
            })
          ).status,
        ).toBe(404);
      });
    },
  );
