import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { chromium } from "playwright";
import { runConnectedCommunityChecks } from "./connected-community-checks.mjs";

const baseURL = process.env.LONGBALL_REVIEW_BASE_URL ?? "http://127.0.0.1:4173";
const api = "http://127.0.0.1:4359",
  tunnel = "https://longball-community-ui-review.trycloudflare.com";
const runId =
  new Date().toISOString().replace(/[^0-9]/g, "") +
  "-" +
  randomUUID().slice(0, 8);
const directory = path.resolve(".local/community-ui-review", runId);
await mkdir(path.dirname(directory), { recursive: true });
await mkdir(directory, { recursive: false });
const log = createWriteStream(path.join(directory, "api.log"));
const server = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "scripts/community-ui-fixture.ts",
    directory,
    "4359",
    new URL(baseURL).origin,
  ],
  {
    env: { ...process.env, LONGBALL_COMMUNITY_UI_FIXTURE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
server.stdout.pipe(log);
server.stderr.pipe(log);
const team = "synthetic-roma-u10",
  season = "synthetic-season-2026-27";
const scoped = (section) => `/v1/teams/${team}/${section}?seasonId=${season}`;
const results = [],
  errors = [];
let browser, activePage;
const until = async (read, accepts, label) => {
  const deadline = Date.now() + 45_000;
  do {
    const value = await read();
    if (accepts(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  assert.fail(label);
};
async function service(
  section,
  {
    method = "GET",
    body,
    role = "player",
    token = "synthetic-account-player-01",
    key = randomUUID(),
    binary,
    headers = {},
  } = {},
) {
  const reply = await fetch(`${api}${scoped(section)}`, {
    signal: AbortSignal.timeout(45_000),
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Longball-Role": role,
      "X-Api-Contract-Version": "longball.events/1.1",
      ...(method !== "GET"
        ? {
            "Idempotency-Key": key,
            "Content-Type": binary ? "image/png" : "application/json",
          }
        : {}),
      ...headers,
    },
    ...(method !== "GET" ? { body: binary ?? JSON.stringify(body ?? {}) } : {}),
  });
  if (!reply.ok) {
    const failure = await reply.json().catch(() => ({}));
    throw Error(
      `Fictional ${section} service HTTP${reply.status} ${typeof failure.code === "string" ? failure.code : ""}`,
    );
  }
  return reply.json();
}
try {
  await until(
    async () => {
      if (server.exitCode !== null)
        throw Error("Disposable fixture exited; inspect its bounded local log");
      try {
        return (
          await fetch(`${api}/health`, { signal: AbortSignal.timeout(3000) })
        ).json();
      } catch {
        return null;
      }
    },
    (value) => value?.syntheticOnly === true,
    "Disposable loopback fixture should start",
  );
  const first = await service("community");
  assert(
    first.matches[0].mayVote,
    "Fixture permits only explicit fictional player ballot",
  );
  const original = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAYUlEQVRYhe2SQQkAQRDD6iKKqmb9/0/EPcJAIQLS0PB6mugGbED1iuxCvUt0AzagekV2od4lugEbUL0iu1DvEt2ADahekV2od4luwAZUr8gu1LtEN2ADqldkF+pdohv85AONejhbMcvf8gAAAABJRU5ErkJggg==",
    "base64",
  );
  const manager = { role: "manager", token: "synthetic-manager-2" };
  // These are actual HTTP upload/scanner/publication calls, not direct processed-media fixture rows.
  const prepared = await service("media/uploads/prepare", {
    ...manager,
    method: "POST",
    body: {
      matchId: first.matches[0].id,
      byteSize: original.length,
      mimeType: "image/png",
      sha256: createHash("sha256").update(original).digest("hex"),
      caption: "Fictional community safety illustration; no people",
      policyAcknowledged: true,
    },
  });
  await service(`media/uploads/${prepared.uploadId}`, {
    ...manager,
    method: "PUT",
    binary: original,
    headers: { "X-Media-Upload-Token": prepared.uploadToken },
  });
  const processed = await service(
    `media/uploads/${prepared.uploadId}/complete`,
    {
      ...manager,
      method: "POST",
      headers: { "X-Media-Upload-Token": prepared.uploadToken },
    },
  );
  let managerDto = await service("community", manager);
  const commandId = randomUUID();
  await service("community", {
    ...manager,
    method: "POST",
    key: commandId,
    body: {
      command: {
        id: commandId,
        expectedRevision: managerDto.revision,
        type: "photo.published",
        photoId: processed.photoId,
        sourceRevision: processed.displayRevision,
        policyAcknowledged: true,
      },
    },
  });
  const readable = await service("community");
  assert(
    readable.gallery.some((photo) => photo.id === processed.photoId),
    "Actual processed and published photo is permitted to the player",
  );
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH ?? "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  for (const width of [320, 390]) {
    if (results.length) {
      console.log(
        "First width passed; respecting the service's 60-second account request window before the next context",
      );
      // Each mutation refreshes several scoped DTOs. Preserve the real account
      // limit while running both complete journeys rather than relaxing it.
      for (let interval = 0; interval < 61; interval += 1)
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      hasTouch: true,
      isMobile: true,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    activePage = page;
    page.setDefaultTimeout(45_000);
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route(
      "https://raw.githubusercontent.com/CharlieOmniPoint/LongBall/preview/longball-m0/preview-status.json",
      (route) =>
        route.fulfill({
          headers: { "access-control-allow-origin": "*" },
          json: {
            state: "ready",
            url: tunnel,
            startedAt: new Date(Date.now() - 1000).toISOString(),
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            sourceRevision: "a".repeat(40),
          },
        }),
    );
    await context.route(`${tunnel}/**`, async (route) => {
      const request = route.request();
      const response = await route.fetch({
        url: api + request.url().slice(tunnel.length),
      });
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          "access-control-allow-origin": new URL(baseURL).origin,
        },
      });
    });
    await page.goto(baseURL, { waitUntil: "networkidle" });
    await page.getByTestId("welcome-review").click();
    await page.getByTestId("review-entry-player").click();
    await page.getByTestId("review-open-connected").click();
    await page.getByTestId("workspace-context-ready").waitFor();
    await page.getByTestId("workspace-tab-community").click();
    const result = await runConnectedCommunityChecks({
      page,
      readCommunity: () => service("community"),
      readOfficialRecords: () => service("records"),
      matchId: first.matches[0].id,
      photoId: processed.photoId,
      capture: async (label) => {
        await page
          .getByTestId("community-own-concerns")
          .evaluate((element) =>
            element.scrollIntoView({ block: "start", inline: "nearest" }),
          );
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
          `No horizontal overflow at${width}`,
        );
        await page.screenshot({
          path: path.join(directory, `${label}-${width}.png`),
          animations: "disabled",
        });
      },
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    results.push({ width, ...result });
    console.log(`Community acceptance passed at ${width}px`);
    await context.close();
    activePage = null;
  }
  assert.deepEqual(errors, []);
  const html = await readFile("apps/mobile/dist-web/index.html", "utf8"),
    bundle = html.match(/src="([^"]+\.js)"/)?.[1];
  const hashes = {};
  for (const file of [
    "apps/api/src/server.ts",
    "apps/api/src/store.ts",
    "apps/api/src/media.ts",
    "packages/application/src/community.ts",
    "scripts/community-ui-fixture.ts",
  ]) {
    hashes[file] = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  }
  const evidence = {
    status: "passed",
    runId,
    completedAt: new Date().toISOString(),
    baseURL,
    api,
    webBundle: bundle,
    webSha256: bundle
      ? createHash("sha256")
          .update(
            await readFile(
              path.join("apps/mobile/dist-web", bundle.replace(/^\//, "")),
            ),
          )
          .digest("hex")
      : null,
    apiRuntime:
      "Actual current TypeScript HTTP handler in a new disposable loopback SQLite fixture; no existing database reset",
    sourceHashes: hashes,
    fixturePolicy:
      "Explicit fictional_review_only community sharing and 30-minute test cutoff set before listen. The separate official-match Q21 sharing policy remains unapproved. No production policy accepted.",
    media:
      "Actual PNG prepare/PUT/ClamAV scan/complete/manager publication over HTTP",
    results,
    errors,
    limitations: [
      "Public synthetic identities, not a real-provider authentication proof",
      "Browser 320/390 behavior, not physical native accessibility/keyboard proof",
      "No production sharing or moderation policy approved",
    ],
  };
  await writeFile(
    path.join(directory, "evidence.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      status: "passed",
      widths: results.map((item) => item.width),
      groupsPerWidth: results.map((item) => item.checks.length),
      directory,
    }),
  );
} catch (error) {
  if (activePage)
    await activePage
      .screenshot({
        path: path.join(directory, "failed.png"),
        animations: "disabled",
      })
      .catch(() => {});
  await writeFile(
    path.join(directory, "failure.json"),
    JSON.stringify(
      {
        status: "failed",
        runId,
        message: error.message,
        errors,
        completedWidths: results.map((item) => item.width),
      },
      null,
      2,
    ) + "\n",
  );
  throw error;
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  log.end();
}
