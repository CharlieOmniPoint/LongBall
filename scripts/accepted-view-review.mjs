import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { captureReviewArtifacts, assertReviewArtifactsUnchanged, assertReviewApiPortAvailable } from "./review-artifacts.mjs";
import {
  REVIEW_STATUS_REQUEST,
  enterFictionalReview,
  openWorkspaceTab,
  selectWorkspaceContext,
} from "./review-entry.mjs";

const baseURL = process.env.LONGBALL_REVIEW_BASE_URL ?? "http://127.0.0.1:4384",
  api = process.env.LONGBALL_REVIEW_API_URL ?? "http://127.0.0.1:4385",
  tunnel = "https://longball-accepted-view-review.trycloudflare.com";
const matchId = "synthetic-roma-maple-2026-10-24",
  teamId = "synthetic-roma-u10",
  seasonId = "synthetic-season-2026-27",
  aliasA = "accepted-view-phone-a";
const apiEntry = process.env.LONGBALL_REVIEW_API_ENTRY ?? "apps/api/dist/api.mjs";
const directory = path.resolve(process.env.LONGBALL_REVIEW_OUTPUT ?? path.join(".local/accepted-view-review", `${Date.now()}-${randomUUID().slice(0, 8)}`));
await assertReviewApiPortAvailable(api);
if (!process.env.LONGBALL_REVIEW_BASE_URL) await assertReviewApiPortAvailable(baseURL);
await mkdir(directory, { recursive: true });
const log = createWriteStream(path.join(directory, "api.log"));
const server = spawn(
  process.execPath,
  [apiEntry],
  {
    env: {
      ...process.env,
      NODE_ENV: "development",
      LONGBALL_SYNTHETIC_AUTH: "1",
      LONGBALL_DATABASE_URL: "",
      LONGBALL_DATABASE_URL_FILE: "",
      LONGBALL_API_HOST: "127.0.0.1",
      LONGBALL_API_PORT: new URL(api).port,
      LONGBALL_API_DATABASE: path.join(directory, "service.sqlite"),
      LONGBALL_API_ORIGINS: new URL(baseURL).origin,
      LONGBALL_CLAMD_HOST: "",
      LONGBALL_CLAMD_SOCKET: "",
      LONGBALL_CLAMD_PORT: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
server.stdout.pipe(log);
server.stderr.pipe(log);
const staticServer = process.env.LONGBALL_REVIEW_BASE_URL ? null : spawn(
  "python3",
  [
    "-m",
    "http.server",
    "4384",
    "--bind",
    "127.0.0.1",
    "--directory",
    ".local/accepted-view-web",
  ],
  { stdio: "ignore" },
);
let browser, activePage, artifacts;
const checks = [],
  errors = [];
async function poll(read, accepts, label) {
  const until = Date.now() + 45_000;
  do {
    const value = await read();
    if (accepts(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 300));
  } while (Date.now() < until);
  assert.fail(label);
}
async function http(
  route,
  { token = "synthetic-manager-1", body, key = randomUUID() } = {},
) {
  const reply = await fetch(api + route, {
    method: body ? "POST" : "GET",
    signal: AbortSignal.timeout(20_000),
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Longball-Role": "manager",
      ...(body
        ? {
            "Content-Type": "application/json",
            "X-Api-Contract-Version": "longball.events/1.1",
            "Idempotency-Key": key,
          }
        : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: reply.status, body: await reply.json() };
}
async function stored(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("longball-synthetic-m0");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            transaction = db.transaction("journal", "readonly"),
            read = transaction.objectStore("journal").get("record");
          transaction.oncomplete = () => {
            db.close();
            resolve(read.result ?? null);
          };
          transaction.onerror = () => {
            db.close();
            reject(transaction.error);
          };
        };
      }),
  );
}
async function document(page, predicate) {
  return (
    Object.values((await stored(page))?.projections ?? {}).find(
      (value) =>
        value?.kind === "longball-canonical-connected-v1" &&
        value.matchId === matchId &&
        predicate(value),
    ) ?? null
  );
}
const click = (page, label) =>
  page.getByRole("button", { name: label, exact: true }).click();
async function createContext(width) {
  const context = await browser.newContext({
    viewport: { width, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  activePage = page;
  page.setDefaultTimeout(45_000);
  page.on("pageerror", (error) => errors.push(error.message));
  return { context, page };
}
async function picture(page, name) {
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    "No horizontal overflow",
  );
  await page.screenshot({
    path: path.join(directory, `${name}.png`),
    animations: "disabled",
  });
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
    "Owned isolated services start",
  );
  artifacts = await captureReviewArtifacts(baseURL, apiEntry);
  const preparationPath = `/v1/teams/${teamId}/preparation?seasonId=${seasonId}`,
    preparation = (await http(preparationPath)).body;
  assert.equal(
    (
      await http(preparationPath, {
        body: {
          command: {
            id: randomUUID(),
            expectedRevision: preparation.revision,
            type: "fixture.prepared",
            fixtureId: matchId,
            formationId: "formation-7",
          },
        },
      })
    ).status,
    200,
  );
  browser = await chromium.launch({
    headless: true,
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  const a = await createContext(390),
    pa = a.page;
  await pa.goto(baseURL, { waitUntil: "networkidle" });
  await enterFictionalReview(pa, "manager", "local");
  await pa.getByTestId("prepare-match").waitFor();
  await click(pa, "More");
  await click(pa, "Service and controller");
  await pa.getByLabel("Workspace API URL", { exact: true }).fill(api);
  await click(pa, "Fictional API review");
  await click(pa, "Fictional manager");
  await pa.getByTestId("workspace-connect").click();
  await selectWorkspaceContext(pa, "manager");
  await openWorkspaceTab(pa, "controller");
  await pa
    .getByLabel("Connected match identifier", { exact: true })
    .fill(matchId);
  await pa.getByLabel("LongBall service URL", { exact: true }).fill(api);
  await click(pa, "Manager A");
  await pa
    .getByLabel("Rehearsal device identifier", { exact: true })
    .fill(aliasA);
  await click(pa, "Open this service connection");
  await click(pa, "Download accepted service match");
  await poll(
    () => document(pa, (value) => value.deviceId === aliasA),
    Boolean,
    "Manager A downloaded checkpoint",
  );
  await click(pa, "Acquire controller for this device");
  await poll(
    () => document(pa, (value) => value.deviceId === aliasA),
    (value) =>
      value?.controllerConfirmed &&
      !value.authoritativeDownloadRequired &&
      !value.pendingRequest,
    "Manager A has actual capability and downloaded checkpoint",
  );
  await click(pa, "Record fictional squad present");
  await poll(
    () => document(pa, (value) => value.deviceId === aliasA),
    (value) =>
      value?.localState.config.selectedPlayerIds.every(
        (id) => value.localState.attendance[id] === "present",
      ),
    "Explicit attendance recorded",
  );
  await click(pa, "Stage first seven present players");
  await poll(
    () => document(pa, (value) => value.deviceId === aliasA),
    (value) => value?.localState.stagedLineup.length === 7,
    "Saved lineup prepared",
  );
  await click(pa, "Upload pending canonical events");
  const acceptedA = await poll(
    () => document(pa, (value) => value.deviceId === aliasA),
    (value) =>
      value?.outbox.every((event) => event.disposition === "accepted") &&
      !value.authoritativeDownloadRequired &&
      !value.pendingRequest,
    "Actual HTTP upload acknowledged",
  );
  checks.push(
    "Manager A prepared attendance and lineup through existing local/HTTP controller primitives before kick-off",
  );
  const b = await createContext(320),
    pb = b.page;
  await b.context.route(
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
  await b.context.route(`${tunnel}/**`, async (route) => {
    const response = await route.fetch({
      url: api + route.request().url().slice(tunnel.length),
    });
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        "access-control-allow-origin": new URL(baseURL).origin,
      },
    });
  });
  await pb.goto(baseURL, { waitUntil: "networkidle" });
  await enterFictionalReview(pb, "manager", "connected");
  await pb.getByTestId("workspace-context-ready").waitFor();
  await openWorkspaceTab(pb, "controller");
  await pb
    .getByLabel("Connected match identifier", { exact: true })
    .fill(matchId);
  await pb.getByTestId("accepted-position-list").waitFor();
  await pb.getByTestId("accepted-bench").waitFor();
  assert.equal(await pb.getByTestId("recording-acquire").count(), 0);
  assert.equal(await pb.getByTestId("connected-match-lineup").count(), 0);
  const clock = await pb.getByTestId("accepted-half-clock").textContent();
  await pb.waitForTimeout(1800);
  assert.equal(
    await pb.getByTestId("accepted-half-clock").textContent(),
    clock,
    "Viewer never extrapolates another phone clock",
  );
  let posts = 0;
  pb.on("request", (request) => {
    if (request.method() === "POST") posts += 1;
  });
  await pb.getByTestId("accepted-request-handover").click();
  assert.equal(
    posts,
    0,
    "Request handover is local instructions, not a pretend message",
  );
  const accountB = (
      await pb.getByTestId("accepted-handover-account").textContent()
    ).replace("Manager account: ", ""),
    deviceB = (
      await pb.getByTestId("accepted-handover-device").textContent()
    ).replace("This phone: ", "");
  assert.equal(accountB, "synthetic-account-manager-2");
  assert(deviceB.length > 0);
  await picture(pb, "viewing-request-320");
  const forbidden = structuredClone(acceptedA.outbox[0].envelope);
  forbidden.eventId = randomUUID();
  forbidden.command.id = forbidden.eventId;
  forbidden.deviceId = deviceB;
  forbidden.clientSequence = 1;
  forbidden.previousEventId = null;
  forbidden.baseRevision = acceptedA.acceptedRevision;
  const denied = await http(`/v1/matches/${matchId}/events`, {
    token: "synthetic-manager-2",
    body: { events: [forbidden] },
  });
  assert.equal(denied.status, 403);
  assert.equal(
    (
      await http(`/v1/matches/${matchId}/download?deviceId=inspection-b`, {
        token: "synthetic-manager-2",
      })
    ).body.acceptedRevision,
    acceptedA.acceptedRevision,
  );
  checks.push(
    "320px non-controller manager sees accepted pitch/list/bench and static checkpoint; local request panel sends no POST; forbidden write is denied by actual HTTP without changing accepted state",
  );
  await pa
    .getByLabel("Handover target account", { exact: true })
    .fill(accountB);
  await pa.getByLabel("Handover target device", { exact: true }).fill(deviceB);
  await click(pa, "Offer control to the named manager/device");
  const offered = await poll(
    () => document(pa, (value) => value.deviceId === aliasA),
    (value) => value?.lastTransferId && !value.pendingRequest,
    "Addressed offer acknowledged",
  );
  const wrong = await http(
    `/v1/matches/${matchId}/handover/${offered.lastTransferId}/accept`,
    { token: "synthetic-manager-2", body: { deviceId: "wrong-phone" } },
  );
  assert.equal(wrong.status, 404);
  await pb
    .getByTestId("accepted-handover-reference")
    .fill(offered.lastTransferId);
  await pb.getByTestId("accepted-handover-accept").click();
  const acceptedB = await poll(
    () => document(pb, (value) => value.deviceId === deviceB),
    (value) =>
      value?.controllerConfirmed &&
      value.grant?.epoch === 2 &&
      !value.authoritativeDownloadRequired &&
      !value.pendingRequest,
    "Actual addressed acceptance and authoritative checkpoint",
  );
  assert.equal(acceptedB.acceptedRevision, acceptedA.acceptedRevision);
  assert.equal(await pb.getByTestId("accepted-match-view").count(), 0);
  await pb.getByTestId("connected-match-lineup").waitFor();
  checks.push(
    "Before-kickoff addressed offer/accept works with exact account/device; wrong device is denied and only confirmed recipient epoch2 unlocks recording",
  );
  await click(pa, "Download accepted service match");
  await pa.getByTestId("accepted-match-view").waitFor();
  assert.equal(
    await pa
      .getByRole("button", {
        name: "Record fictional squad present",
        exact: true,
      })
      .count(),
    0,
  );
  await picture(pa, "former-recorder-viewing-390");
  checks.push(
    "390px former recorder refreshes to Viewing after transfer, without editing controls or changes to the accepted lineup",
  );
  assert.deepEqual(errors, []);
  await assertReviewArtifactsUnchanged(artifacts, baseURL, apiEntry);
  const report = {
    status: "passed",
    completedAt: new Date().toISOString(),
    checks,
    errors,
    artifacts,
    webBundle: artifacts.web.entry,
    webSha256: artifacts.web.sha256,
    limitations: [
      "Fictional browser controller storage and public identities; not native storage or real authentication proof",
      "No running transfer, referee clock pause, message or notification was introduced",
      "Request panel stores no capability; only normal existing addressed accept/offer operations grant authority",
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
    JSON.stringify({ artifacts, message: error.message, checks, errors }, null, 2),
  );
  throw error;
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  staticServer?.kill("SIGTERM");
  log.end();
}
