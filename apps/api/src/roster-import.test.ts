import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "./server";
import { EVENT_CONTRACT_VERSION, SYNTHETIC_IDS } from "./store";
import {
  previewRosterImport,
  ROSTER_CSV_TEMPLATE,
} from "../../../packages/application/src/roster-import";
import type { PreparationState } from "../../../packages/application/src/preparation";
const running: ReturnType<typeof createApi>[] = [],
  directories: string[] = [];
const path = `/v1/teams/${SYNTHETIC_IDS.teamId}/preparation?seasonId=${SYNTHETIC_IDS.seasonId}`;
async function start() {
  const directory = mkdtempSync(join(tmpdir(), "longball-roster-import-"));
  directories.push(directory);
  const api = createApi({
    databasePath: join(directory, "service.sqlite"),
    syntheticAuth: true,
  });
  running.push(api);
  await new Promise<void>((resolve) =>
    api.server.listen(0, "127.0.0.1", resolve),
  );
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const call = async (
    command?: unknown,
    token = "synthetic-manager-2",
    key = randomUUID(),
  ) => {
    const reply = await fetch(base + path, {
      method: command ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Longball-Role":
          token === "synthetic-manager-2" ? "manager" : "player",
        ...(command
          ? {
              "Content-Type": "application/json",
              "Idempotency-Key": key,
              "X-Api-Contract-Version": EVENT_CONTRACT_VERSION,
            }
          : {}),
      },
      ...(command ? { body: JSON.stringify({ command }) } : {}),
    });
    return {
      status: reply.status,
      body: (await reply.json()) as PreparationState,
    };
  };
  return { api, call };
}
afterEach(async () => {
  for (const api of running.splice(0)) {
    api.server.closeAllConnections();
    await api.close();
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
describe("actual HTTP roster import", () => {
  it("atomically imports, projects current roster labels and retries exactly once without creating access", async () => {
    const { api, call } = await start(),
      before = (await call()).body as PreparationState;
    const memberships = api.store.memberships(),
      accounts = api.store.database
        .prepare("SELECT COUNT(*) AS count FROM accounts")
        .get();
    const profiles = previewRosterImport(
      ROSTER_CSV_TEMPLATE + "\nOther,OP,21,left,CM,CB,ST,CM|CB|ST",
      before,
      randomUUID,
    ).profiles;
    const id = randomUUID(),
      command = {
        id,
        type: "roster.imported",
        expectedRevision: before.revision,
        profiles,
        confirmNewPlayers: true,
      };
    const saved = await call(command, "synthetic-manager-2", id);
    expect(saved.status).toBe(200);
    expect(saved.body.revision).toBe(before.revision + 1);
    expect(saved.body.profiles).toHaveLength(before.profiles.length + 2);
    expect((await call(command, "synthetic-manager-2", id)).body).toEqual(
      saved.body,
    );
    expect(api.store.memberships()).toEqual(memberships);
    expect(
      api.store.database
        .prepare("SELECT COUNT(*) AS count FROM accounts")
        .get(),
    ).toEqual(accounts);
    const records = api.store.document<{ players: { id: string }[] }>(
      SYNTHETIC_IDS.teamId,
      SYNTHETIC_IDS.seasonId,
      "records",
    );
    expect(
      records.players.some((player) => player.id === profiles[0].playerId),
    ).toBe(true);
    expect(saved.body.snapshots).toEqual(before.snapshots);
    expect(saved.body.fixtures).toEqual(before.fixtures);
  });
  it("retains the whole original roster on a late bad row and refuses player escalation or a stale revision", async () => {
    const { call } = await start(),
      before = (await call()).body as PreparationState;
    const profile = previewRosterImport(ROSTER_CSV_TEMPLATE, before, randomUUID)
      .profiles[0];
    const command = {
      id: randomUUID(),
      type: "roster.imported",
      expectedRevision: before.revision,
      profiles: [
        profile,
        { ...profile, id: randomUUID(), playerId: randomUUID() },
      ],
      confirmNewPlayers: true,
    };
    expect((await call(command)).status).toBe(422);
    expect((await call()).body).toEqual(before);
    expect(
      (
        await call(
          { ...command, profiles: [profile] },
          "synthetic-account-player-01",
        )
      ).status,
    ).toBe(404);
    expect(
      (await call({ ...command, expectedRevision: 99, profiles: [profile] }))
        .status,
    ).toBe(422);
    expect((await call()).body).toEqual(before);
  });
});
