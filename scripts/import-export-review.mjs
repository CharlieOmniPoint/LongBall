import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { chromium } from "playwright";
import { REVIEW_STATUS_REQUEST, enterFictionalReview, openWorkspaceTab } from "./review-entry.mjs";

const baseURL = process.env.LONGBALL_REVIEW_BASE_URL ?? "http://127.0.0.1:4384",
  api = process.env.LONGBALL_IMPORT_EXPORT_API_URL ?? "http://127.0.0.1:4385",
  tunnel = "https://longball-import-export-review.trycloudflare.com";
const directory = path.resolve(
  process.env.LONGBALL_REVIEW_OUTPUT_DIRECTORY ?? ".local/import-export-review",
  `${Date.now()}-${randomUUID().slice(0, 8)}`,
);
await mkdir(directory, { recursive: true });
const apiLog = createWriteStream(path.join(directory, "api.log"));
const server = spawn(
  process.execPath,
  process.env.LONGBALL_REVIEW_API_BUNDLE ? [process.env.LONGBALL_REVIEW_API_BUNDLE] : ["--import", "tsx", "apps/api/src/main.ts"],
  {
    env: {
      ...process.env,
      NODE_ENV: "development",
      LONGBALL_SYNTHETIC_AUTH: "1",
      LONGBALL_DEMO_SCENARIO: "0",
      LONGBALL_DATABASE_URL: "",
      LONGBALL_DATABASE_URL_FILE: "",
      LONGBALL_API_HOST: "127.0.0.1",
      LONGBALL_API_PORT: new URL(api).port,
      LONGBALL_API_DATABASE: path.join(directory, "service.sqlite"),
      LONGBALL_MEDIA_DIRECTORY: path.join(directory, "media"),
      LONGBALL_API_ORIGINS: baseURL,
      LONGBALL_CLAMD_HOST: "",
      LONGBALL_CLAMD_PORT: "",
      LONGBALL_CLAMD_SOCKET: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
server.stdout.pipe(apiLog);
server.stderr.pipe(apiLog);
const staticServer = spawn(
  "python3",
  [
    "-m",
    "http.server",
    new URL(baseURL).port,
    "--bind",
    "127.0.0.1",
    "--directory",
    process.env.LONGBALL_REVIEW_WEB_DIRECTORY ?? ".local/import-export-web",
  ],
  { stdio: "ignore" },
);
let browser, activePage;
const checks = [],
  errors = [];
const team = "synthetic-roma-u10",
  season = "synthetic-season-2026-27";
const route = `/v1/teams/${team}/preparation?seasonId=${season}`;
async function service(command) {
  const id = command?.id ?? randomUUID();
  const reply = await fetch(api + route, {
    method: command ? "POST" : "GET",
    signal: AbortSignal.timeout(20_000),
    headers: {
      Authorization: "Bearer synthetic-manager-2",
      "X-Longball-Role": "manager",
      ...(command
        ? {
            "Content-Type": "application/json",
            "X-Api-Contract-Version": "longball.events/1.1",
            "Idempotency-Key": id,
          }
        : {}),
    },
    ...(command
      ? { body: JSON.stringify({ command: { ...command, id } }) }
      : {}),
  });
  assert.equal(reply.status, 200, "Actual manager preparation HTTP succeeds");
  return reply.json();
}
async function poll(read, accepts, label) {
  const until = Date.now() + 45_000;
  do {
    const value = await read();
    if (accepts(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < until);
  assert.fail(label);
}
async function context(role, width) {
  const context = await browser.newContext({
    viewport: { width, height: 844 },
    hasTouch: true,
    isMobile: true,
    acceptDownloads: true,
  });
  await context.route(
    REVIEW_STATUS_REQUEST,
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
    const response = await route.fetch({
      url: api + route.request().url().slice(tunnel.length),
    });
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        "access-control-allow-origin": baseURL,
      },
    });
  });
  const page = await context.newPage();
  activePage = page;
  page.setDefaultTimeout(45_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await enterFictionalReview(page, role, "connected");
  await page.getByTestId("workspace-context-ready").waitFor();
  return { page, context };
}
async function capture(page, name) {
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    "No horizontal phone overflow",
  );
  await page.screenshot({
    path: path.join(directory, `${name}.png`),
    animations: "disabled",
  });
}
async function download(page, keys) {
  await page.getByTestId("calendar-export-open").click();
  assert.equal(
    await page.getByTestId("calendar-export-confirm").isEnabled(),
    false,
    "No event is selected implicitly",
  );
  for (const key of keys)
    await page.getByTestId(`calendar-event-${key}`).click();
  const downloading = page.waitForEvent("download");
  await page.getByTestId("calendar-export-confirm").click();
  const file = await downloading;
  assert.equal(file.suggestedFilename(), "longball-calendar.ics");
  return readFile(await file.path(), "utf8");
}
try {
  await poll(
    async () => {
      try {
        return (await fetch(api + "/health")).ok && (await fetch(baseURL)).ok;
      } catch {
        return false;
      }
    },
    Boolean,
    "Owned isolated web and HTTP services start",
  );
  let preparation = await service();
  const unknown = {
    ...preparation.fixtures[0],
    id: "fictional-calendar-unknown",
    playedDate: "2026-10-26",
    kickoff: null,
    arrival: null,
    opponent: "Fictional calendar FC",
  };
  const {
    selectedProfileIds: _selection,
    responses: _responses,
    attendance: _attendance,
    status: _status,
    history: _history,
    ...fixture
  } = unknown;
  preparation = await service({
    type: "fixture.saved",
    expectedRevision: preparation.revision,
    fixture,
  });
  const before = preparation.profiles.length;
  browser = await chromium.launch({
    headless: true,
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  const manager = await context("manager", 320),
    page = manager.page;
  let importPosts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.postDataJSON()?.command?.type === "roster.imported"
    )
      importPosts += 1;
  });
  await openWorkspaceTab(page, "team");
  await page.getByTestId("roster-import-open").click();
  const header =
    "displayName,initials,shirtNumber,foot,preference1,preference2,preference3,eligiblePositions";
  await page
    .getByTestId("roster-import-csv")
    .fill(header + "\nInvalid,FP,1,left,CM,CB,ST,CM|CB|ST");
  await page.getByTestId("roster-import-preview").click();
  assert.equal(
    await page.getByTestId("roster-import-confirm").isEnabled(),
    false,
  );
  assert.equal((await service()).profiles.length, before);
  await page
    .getByTestId("roster-import-csv")
    .fill(
      header +
        "\nFictional CSV One,FP,20,left,CM,CB,ST,CM|CB|ST\nFictional CSV Two,FP,21,both,GK,CM,CB,GK|CM|CB",
    );
  await page.getByTestId("roster-import-preview").click();
  assert.equal(importPosts, 0, "Preview has no mutation");
  assert.equal((await service()).profiles.length, before);
  await page
    .getByRole("switch", {
      name: "Confirm distinct new players and eligibility",
      exact: true,
    })
    .check();
  await capture(page, "roster-preview-320");
  await page.getByTestId("roster-import-confirm").click();
  preparation = await poll(
    service,
    (value) => value.profiles.length === before + 2,
    "Both reviewed profiles are committed",
  );
  await poll(
    () => page.getByTestId("roster-import-open").isEnabled(),
    Boolean,
    "The service receipt settles",
  );
  assert.equal(importPosts, 1);
  checks.push(
    "320px manager: invalid row blocked, preview inert, explicit confirmation imports two distinct same-initial profiles atomically",
  );
  await openWorkspaceTab(page, "schedule");
  const managerCalendar = await download(page, [
    `match:${preparation.fixtures[0].id}`,
    "match:fictional-calendar-unknown",
  ]);
  assert.equal(managerCalendar.match(/BEGIN:VEVENT/g)?.length, 2);
  assert(managerCalendar.includes("DTSTART;VALUE=DATE:20261026"));
  assert(
    !/Fictional CSV|synthetic-player|SCORE|DTEND|DURATION/.test(
      managerCalendar,
    ),
  );
  await capture(page, "calendar-selection-manager-320");
  checks.push(
    "320px manager: explicit event selection downloads standards ICS with unknown kickoff kept date-only and no roster/results",
  );
  await manager.context.close();
  const player = await context("player", 390);
  await openWorkspaceTab(player.page, "schedule");
  assert.equal(await player.page.getByTestId("roster-import-open").count(), 0);
  const playerCalendar = await download(player.page, [
    "match:fictional-calendar-unknown",
  ]);
  assert.equal(playerCalendar.match(/BEGIN:VEVENT/g)?.length, 1);
  assert(playerCalendar.includes("DTSTART;VALUE=DATE:20261026"));
  await capture(player.page, "calendar-selection-player-390");
  checks.push(
    "390px player: own authorized schedule exports without manager import or teammate details",
  );
  await player.context.close();
  activePage = null;
  assert.deepEqual(errors, []);
  const html = await readFile(path.join(process.env.LONGBALL_REVIEW_WEB_DIRECTORY ?? ".local/import-export-web", "index.html"), "utf8"),
    bundle = html.match(/src="([^"]+\.js)"/)?.[1];
  const report = {
    status: "passed",
    completedAt: new Date().toISOString(),
    checks,
    pageErrors: errors,
    webBundle: bundle,
    webSha256: bundle
      ? createHash("sha256")
          .update(
            await readFile(
              path.join(process.env.LONGBALL_REVIEW_WEB_DIRECTORY ?? ".local/import-export-web", bundle.replace(/^\//, "")),
            ),
          )
          .digest("hex")
      : null,
    api: `Actual isolated HTTP service at ${api}; new sample SQLite database, no projection injection`,
    limitations: [
      "Public fictional identities, not production authentication proof",
      "Native Sharing and accessibility require physical iPhone/Android checks",
      "Exported calendar copies do not update automatically",
    ],
  };
  await writeFile(
    path.join(directory, "evidence.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({ status: "passed", checks: checks.length, directory }),
  );
} catch (error) {
  await activePage
    ?.screenshot({ path: path.join(directory, "failed.png") })
    .catch(() => {});
  await writeFile(
    path.join(directory, "failure.json"),
    JSON.stringify({ message: error.message, checks, errors }, null, 2),
  );
  throw error;
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  staticServer.kill("SIGTERM");
  apiLog.end();
}
