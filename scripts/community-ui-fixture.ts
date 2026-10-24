/** Disposable loopback fixture only. No production sharing decision or existing database is changed. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { createApi } from "../apps/api/src/server";
import { createClamAvDaemonScanner } from "../apps/api/src/media";
import { SYNTHETIC_IDS } from "../apps/api/src/store";
import type { CommunityState } from "../packages/application/src/community";

assert.equal(
  process.env.LONGBALL_COMMUNITY_UI_FIXTURE,
  "1",
  "Explicit disposable fixture selection required",
);
const directory = resolve(process.argv[2] ?? ""),
  port = Number(process.argv[3]),
  origin = process.argv[4];
assert(
  directory.startsWith(resolve(".local/community-ui-review") + sep),
  "Use only the isolated community review directory",
);
assert(
  Number.isInteger(port) && port >= 4359 && port <= 4369,
  "Use a dedicated loopback review port",
);
const browser = new URL(origin);
assert(
  ["localhost", "127.0.0.1"].includes(browser.hostname) &&
    browser.protocol === "http:",
  "Use only the local browser export",
);
const databasePath = resolve(directory, "service.sqlite");
assert(
  !existsSync(databasePath),
  "Refuse to reset or reuse an existing database",
);
const api = createApi({
  databasePath,
  syntheticAuth: true,
  allowedOrigins: [browser.origin],
  mediaDirectory: resolve(directory, "media"),
  mediaScanner: createClamAvDaemonScanner({
    host: "127.0.0.1",
    port: Number(process.env.LONGBALL_CLAMD_PORT ?? 53310),
  }),
});
// BEFORE listen: this fixture explicitly permits fictional community sharing only.
// The independently stored official-match Q21 policy remains unapproved.
const state = api.store.document<CommunityState>(
  SYNTHETIC_IDS.teamId,
  SYNTHETIC_IDS.seasonId,
  "community",
);
assert.equal(state.synthetic, true);
assert.equal(state.revision, 0);
const fullTime = Date.now() - 60_000;
state.matches = state.matches.map((match) => ({
  ...match,
  label: "Roma v Willow FC · explicit fictional sharing fixture",
  sharing: "fictional_review_only",
  actualFullTimeAtMs: fullTime,
  playedAtMs: fullTime - 3_600_000,
  finishQuality: "trusted",
  voteCutoffAtMs: fullTime + 30 * 60_000,
  cutoffSource: "explicit_fictional_setting",
  finalisationDeadlineAtMs: fullTime + 60 * 60_000,
}));
// Remove only fresh placeholder illustrations; the caller creates a real processed upload over HTTP.
state.photos = [];
api.store.saveDocument(
  SYNTHETIC_IDS.teamId,
  SYNTHETIC_IDS.seasonId,
  "community",
  state,
);
api.server.listen(port, "127.0.0.1", () =>
  console.log("Disposable fictional community UI fixture ready"),
);
let closing = false;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    api.server.closeAllConnections();
    void api.close().then(() => process.exit(0));
  });
