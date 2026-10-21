import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InvitationMemoryClient } from "../../../packages/application/src/invitation-client";
import { invitationTokenHashInput } from "../../../packages/application/src/invitation-credentials";
import type { HttpFetch } from "../../../packages/application/src/sync";
import { createApi } from "./server";
import { EVENT_CONTRACT_VERSION, SYNTHETIC_IDS } from "./store";

const active: ReturnType<typeof createApi>[] = [],
  directories: string[] = [];
const now = Date.parse("2026-10-21T10:00:00Z");
const { teamId, seasonId, matchId } = SYNTHETIC_IDS;
async function start() {
  const directory = mkdtempSync(join(tmpdir(), "longball-invitation-http-"));
  directories.push(directory);
  const api = createApi({
    databasePath: join(directory, "service.sqlite"),
    syntheticAuth: true,
    now: () => now,
    publicAppEntryUrl: "https://example.invalid/LongBall/",
    invitationPolicyVersion: "explicit-fictional-http-test",
  });
  active.push(api);
  await new Promise<void>((resolve) =>
    api.server.listen(0, "127.0.0.1", resolve),
  );
  const baseUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const calls: {
    path: string;
    body: string | undefined;
    key: string | undefined;
  }[] = [];
  const client = (account: string, loseResponse?: (path: string) => boolean) =>
    new InvitationMemoryClient({
      baseUrl,
      assertCurrent: () => undefined,
      authenticatedFetch: async (url, options) => {
        const path = new URL(url).pathname;
        calls.push({
          path,
          body: options.body,
          key: options.headers["Idempotency-Key"],
        });
        const response = await fetch(url, {
          ...options,
          headers: { ...options.headers, Authorization: `Bearer ${account}` },
        });
        if (loseResponse?.(path)) {
          await response.arrayBuffer();
          throw new Error(
            "The fictional test drops the response only after the real service completes.",
          );
        }
        return response;
      },
    } satisfies {
      baseUrl: string;
      assertCurrent: () => void;
      authenticatedFetch: HttpFetch;
    });
  return { api, baseUrl, calls, client };
}
afterEach(async () => {
  for (const api of active.splice(0)) {
    api.server.closeAllConnections();
    await api.close();
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("canonical invitation client through actual fictional HTTP and SQLite", () => {
  it("recovers lost create and accept replies exactly, explicitly reissues, and never persists the raw capability", async () => {
    const lab = await start();
    let dropIssue = true;
    const player = lab.client(
      "synthetic-account-player-01",
      (path) =>
        path.endsWith("/spectator-invites") &&
        dropIssue &&
        ((dropIssue = false), true),
    );
    const issueKey = randomUUID();
    await expect(
      player.issue(teamId, { seasonId, expiresInHours: 1 }, issueKey),
    ).rejects.toMatchObject({ code: "INVITATION_NETWORK_UNCERTAIN" });
    expect(
      lab.api.store.database
        .prepare("SELECT id FROM spectator_invitations")
        .all(),
    ).toHaveLength(1);
    const replay = await player.retry();
    expect(replay.kind).toBe("redacted");
    if (replay.kind !== "redacted")
      throw new Error("Expected a redacted exact replay.");
    expect(replay.receipt.requiresReissue).toBe(true);
    expect(JSON.stringify(replay)).not.toMatch(/shareUrl|tokenHash|reviewCode/);
    const firstCalls = lab.calls.filter((call) => call.key === issueKey);
    expect(firstCalls).toHaveLength(2);
    expect(firstCalls[1]).toEqual(firstCalls[0]);
    const replacement = await player.reissue(
      teamId,
      replay.receipt.id,
      { seasonId, expiresInHours: 1 },
      randomUUID(),
    );
    if (replacement.kind !== "issued")
      throw new Error("Expected the explicitly requested replacement.");
    const token = new URLSearchParams(
      new URL(replacement.receipt.shareUrl).hash.slice(1),
    ).get("code")!;
    const rows = lab.api.store.database
      .prepare(
        "SELECT id,token_hash,revoked_at FROM spectator_invitations ORDER BY created_at,id",
      )
      .all();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === replay.receipt.id)?.revoked_at).toBe(
      now,
    );
    expect(
      rows.find((row) => row.id === replacement.receipt.id)?.token_hash,
    ).toBe(
      createHash("sha256")
        .update(invitationTokenHashInput(token))
        .digest("hex"),
    );
    let dropAccept = true;
    const invitee = lab.client(
      "synthetic-account-invitee",
      (path) =>
        path.endsWith("/accept") && dropAccept && ((dropAccept = false), true),
    );
    const beforeMembership = lab.api.store.database
      .prepare(
        "SELECT * FROM memberships WHERE account_id='synthetic-account-invitee'",
      )
      .all();
    expect(await invitee.inspect(token)).toEqual({
      invitationId: replacement.receipt.id,
      teamId,
      seasonId,
      expiresAt: replacement.receipt.expiresAt,
      context: { clubName: 'Richmond Rovers', teamName: 'Roma', ageGroup: 'U10', seasonLabel: '2026/27', inviterLabel: 'Team member' },
    });
    expect(
      lab.api.store.database
        .prepare(
          "SELECT * FROM memberships WHERE account_id='synthetic-account-invitee'",
        )
        .all(),
    ).toEqual(beforeMembership);
    const acceptKey = randomUUID();
    await expect(invitee.accept(token, acceptKey)).rejects.toMatchObject({
      code: "INVITATION_NETWORK_UNCERTAIN",
    });
    expect(await invitee.retry()).toMatchObject({
      kind: "accepted",
      receipt: { invitationId: replacement.receipt.id, teamId, seasonId },
    });
    expect(lab.calls.filter((call) => call.key === acceptKey)).toHaveLength(2);
    expect(lab.calls.filter((call) => call.key === acceptKey)[1]).toEqual(
      lab.calls.filter((call) => call.key === acceptKey)[0],
    );
    const membership = lab.api.store.database
      .prepare(
        "SELECT * FROM memberships WHERE account_id='synthetic-account-invitee' AND role='spectator' AND revoked_at IS NULL",
      )
      .all();
    expect(membership).toHaveLength(1);
    const stored = JSON.stringify([
      lab.api.store.database.prepare("SELECT * FROM documents").all(),
      lab.api.store.database
        .prepare("SELECT * FROM spectator_invitations")
        .all(),
      lab.api.store.database.prepare("SELECT * FROM idempotency").all(),
      lab.api.store.database.prepare("SELECT * FROM audit").all(),
    ]);
    expect(stored.includes(token)).toBe(false);
    expect(stored.includes(replacement.receipt.shareUrl)).toBe(false);
    expect(JSON.stringify(invitee).includes(token)).toBe(false);
    const manager = lab.client("synthetic-manager-1");
    expect(
      await manager.revoke(
        teamId,
        replacement.receipt.id,
        seasonId,
        randomUUID(),
      ),
    ).toEqual({ invitationId: replacement.receipt.id, revoked: true });
    expect(
      (
        await fetch(`${lab.baseUrl}/v1/matches/${matchId}`, {
          headers: { Authorization: "Bearer synthetic-account-invitee" },
        })
      ).status,
    ).toBe(404);
  });
  it("refuses old plaintext and JSON-only revoke endpoints and inspects the actual destination despite altered link hints", async () => {
    const lab = await start(),
      manager = lab.client("synthetic-manager-1");
    for (const command of [
      {
        type: "invite.created",
        invitationId: "caller-chosen",
        reviewCode: "LEGACY-FICTIONAL-CODE",
        expiresAtMs: now + 1000,
      },
      { type: "invite.accepted", reviewCode: "LEGACY-FICTIONAL-CODE" },
      { type: "invite.revoked", invitationId: "caller-chosen" },
    ]) {
      const response = await fetch(
        `${lab.baseUrl}/v1/teams/${teamId}/community?seasonId=${seasonId}`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer synthetic-manager-1",
            "Content-Type": "application/json",
            "X-Api-Contract-Version": EVENT_CONTRACT_VERSION,
            "Idempotency-Key": randomUUID(),
          },
          body: JSON.stringify({ command: { id: randomUUID(), ...command } }),
        },
      );
      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe(
        "CANONICAL_INVITATION_REQUIRED",
      );
    }
    const created = await manager.issue(
      teamId,
      { seasonId, expiresInHours: 1 },
      randomUUID(),
    );
    if (created.kind !== "issued") throw new Error("Expected first issue.");
    const tamperedHint = new URL(created.receipt.shareUrl);
    const fields = new URLSearchParams(tamperedHint.hash.slice(1));
    fields.set("teamId", "forged-link-team");
    tamperedHint.hash = fields.toString();
    const token = new URLSearchParams(tamperedHint.hash.slice(1)).get("code")!;
    const invitee = lab.client("synthetic-account-invitee");
    expect(await invitee.inspect(token)).toEqual({
      invitationId: created.receipt.id,
      teamId,
      seasonId,
      expiresAt: created.receipt.expiresAt,
      context: { clubName: 'Richmond Rovers', teamName: 'Roma', ageGroup: 'U10', seasonLabel: '2026/27', inviterLabel: 'Team manager' },
    });
    expect(
      lab.api.store.database
        .prepare(
          "SELECT * FROM memberships WHERE account_id='synthetic-account-invitee' AND role='spectator'",
        )
        .all(),
    ).toHaveLength(0);
    expect(
      JSON.stringify(
        lab.api.store.database.prepare("SELECT * FROM documents").all(),
      ).includes("LEGACY-FICTIONAL-CODE"),
    ).toBe(false);
  });
});
