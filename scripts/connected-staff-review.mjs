import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { chromium } from "playwright";
import { changeWorkspaceContext, enterFictionalReview, openWorkspaceTab, selectWorkspaceContext } from "./review-entry.mjs";

// Real HTTP commands prepare a fictional award/report; browser actions perform staff writes and album navigation.
const baseURL = process.env.LONGBALL_REVIEW_BASE_URL ?? "http://127.0.0.1:4173";
const api =
  process.env.LONGBALL_STAFF_REVIEW_API_URL ?? "http://127.0.0.1:4316";
const directory = path.resolve(".local/connected-staff-review");
const teamId = "synthetic-roma-u10",
  seasonId = "synthetic-season-2026-27";
const willow = "synthetic-community-willow";
const runId = new Date().toISOString().replaceAll(/[^0-9]/g, "");
const checks = [],
  pageErrors = [];
let server, stream, browser, page;
await mkdir(directory, { recursive: true });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function poll(read, accepts, label) {
  let value;
  const end = Date.now() + 30_000;
  do {
    value = await read();
    if (accepts(value)) return value;
    await delay(300);
  } while (Date.now() < end);
  assert.fail(label);
}
const scoped = (section) =>
  `/v1/teams/${teamId}/${section}?seasonId=${seasonId}`;
async function service(
  section,
  {
    method = "GET",
    command,
    role = "manager",
    token = "synthetic-manager-1",
    expectedStatus,
  } = {},
) {
  const key = command?.id ?? command?.commandId;
  const reply = await fetch(`${api}${scoped(section)}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Longball-Role": role,
      "X-Api-Contract-Version": "longball.events/1.1",
      ...(command
        ? { "Content-Type": "application/json", "Idempotency-Key": key }
        : {}),
    },
    ...(command ? { body: JSON.stringify({ command }) } : {}),
  });
  const body = await reply.json();
  if (expectedStatus) {
    assert.equal(reply.status, expectedStatus);
    return body;
  }
  assert(
    reply.ok,
    `${section}: HTTP${reply.status} ${body.code ?? ""} ${body.message ?? ""}`,
  );
  return body;
}
const click = (name) =>
  page.getByRole("button", { name, exact: true }).click({ noWaitAfter: true });
async function settled() {
  const refresh = page.getByRole("button", {
    name: "Refresh service views",
    exact: true,
  });
  await refresh.waitFor();
  await poll(
    () => refresh.isEnabled(),
    Boolean,
    "Service receipt and local refresh settled",
  );
}
async function picture(name) {
  await page.screenshot({
    path: path.join(directory, `${name}.png`),
    animations: "disabled",
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    "No phone horizontal overflow",
  );
}
async function launchAPI() {
  if (process.env.LONGBALL_REVIEW_EXTERNAL_API === "1") return;
  const address = new URL(api);
  assert(["127.0.0.1", "localhost"].includes(address.hostname));
  stream = createWriteStream(path.join(directory, "api.log"));
  server = spawn(process.execPath, ["apps/api/dist/api.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "development",
      LONGBALL_SYNTHETIC_AUTH: "1",
      LONGBALL_API_HOST: "127.0.0.1",
      LONGBALL_API_PORT: address.port,
      LONGBALL_API_DATABASE: path.join(directory, `${runId}.sqlite`),
      LONGBALL_MEDIA_DIRECTORY: path.join(directory, `${runId}-media`),
      LONGBALL_API_ORIGINS: new URL(baseURL).origin,
      LONGBALL_CLAMSCAN_PATH: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.pipe(stream);
  server.stderr.pipe(stream);
  await poll(
    async () => {
      if (server.exitCode !== null)
        throw new Error("Isolated API exited; see api.log");
      try {
        return (await fetch(`${api}/health`)).ok;
      } catch {
        return false;
      }
    },
    Boolean,
    "Isolated API started",
  );
}
try {
  await launchAPI();
  // Create a report for the already-recorded fictional community game through the public command boundary.
  let community = await service("community");
  await service("community", {
    method: "POST",
    command: {
      id: randomUUID(),
      expectedRevision: community.revision,
      type: "award.cutoffConfigured",
      matchId: willow,
      minutesAfterFullTime: 59,
    },
  });
  community = await service("community", {
    token: "synthetic-account-player-01",
    role: "player",
  });
  const refusedBallot = await service("community", {
    method: "POST",
    token: "synthetic-account-player-01",
    role: "player",
    expectedStatus: 422,
    command: {
      id: randomUUID(),
      expectedRevision: community.revision,
      type: "ballot.cast",
      matchId: willow,
      candidatePlayerId: "synthetic-player-02",
    },
  });
  assert.equal(refusedBallot.code, "POLICY_NEEDED");
  community = await service("community");
  await service("community", {
    method: "POST",
    command: {
      id: randomUUID(),
      expectedRevision: community.revision,
      type: "award.finalised",
      matchId: willow,
    },
  });
  community = await service("community");
  const match = community.matches.find((item) => item.id === willow);
  assert.equal(match.award.result, "no_valid_votes");
  assert.deepEqual(match.award.winnerLabels, []);
  await service("records", {
    method: "POST",
    command: {
      type: "historical.add",
      commandId: randomUUID(),
      recordId: willow,
      at: new Date().toISOString(),
      actor: "manager",
      input: {
        playedDate: new Date(match.playedAtMs).toISOString().slice(0, 10),
        recordedKickoff: null,
        sameDayOrder: null,
        opponent: "Willow FC",
        homeAway: "home",
        fixtureClass: "friendly",
        status: "completed",
        specialOutcome: "ordinary",
        finalScore: { for: 2, against: 1 },
        halfTimeScore: null,
        goals: [],
      },
    },
  });
  browser = await chromium.launch({
    executablePath:
      process.env.LONGBALL_CHROMIUM_PATH ??
      (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
  });
  page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await enterFictionalReview(page);
  await page.getByTestId("prepare-match").waitFor();
  await click("More");
  await click("Service and controller");
  await page.getByLabel("Workspace API URL", { exact: true }).fill(api);
  await click("Fictional API review");
  await click("Alex Morgan · Manager");
  await page.getByTestId("workspace-connect").click();
  await selectWorkspaceContext(page);
  await page.getByTestId("preparation-create-event").waitFor();
  await settled();
  await changeWorkspaceContext(page, "administrator");
  await openWorkspaceTab(page, "people");
  await page.getByTestId("connected-staff").waitFor();
  await settled();
  let roster = await service("managers", { role: "administrator" });
  assert.equal(roster.activeTeamManagerCount, 4);
  assert.equal(roster.revision, 0);
  const writes = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/managers(?:\/revoke)?\?/.test(request.url())
    )
      writes.push({
        body: request.postDataJSON(),
        key: request.headers()["idempotency-key"],
      });
  });
  await page
    .getByLabel("Existing adult account reference", { exact: true })
    .fill("synthetic-account-manager-5");
  await page.getByTestId("staff-review-assign").click();
  assert.equal(
    (await service("managers", { role: "administrator" })).revision,
    0,
    "Review has no write side effect",
  );
  await page.getByTestId("staff-confirm").click();
  await page
    .getByText(
      /at most four active managers|four distinct active manager|maximum of four|manager limit/i,
    )
    .first()
    .waitFor();
  await settled();
  assert.equal(
    (await service("managers", { role: "administrator" })).revision,
    0,
    "Fifth manager is rejected transactionally",
  );
  await click("Edit staff review");
  const departed = roster.managers.find(
    (person) => person.accountId === "synthetic-account-manager-4",
  );
  await click(`Review revoking ${departed.label} manager access`);
  await page
    .getByLabel("Manager revocation reason", { exact: true })
    .fill(
      "Fictional coach departed this season; reviewed account and team scope.",
    );
  await page.getByTestId("staff-review-revoke").click();
  assert.equal(
    (await service("managers", { role: "administrator" })).revision,
    0,
    "Revocation review has no write side effect",
  );
  await page.getByTestId("staff-confirm").click();
  roster = await poll(
    () => service("managers", { role: "administrator" }),
    (value) => value.revision === 1,
    "Explicit reasoned revocation saved",
  );
  assert.equal(roster.activeTeamManagerCount, 3);
  assert.equal(
    roster.managers.find((person) => person.accountId === departed.accountId)
      .status,
    "revoked",
  );
  await settled();
  await page
    .getByLabel("Existing adult account reference", { exact: true })
    .fill("synthetic-account-manager-5");
  await page.getByTestId("staff-review-assign").click();
  await page.getByTestId("staff-confirm").click();
  roster = await poll(
    () => service("managers", { role: "administrator" }),
    (value) => value.revision === 2,
    "Replacement existing adult assignment saved",
  );
  assert.equal(roster.activeTeamManagerCount, 4);
  assert.equal(
    roster.managers.find(
      (person) => person.accountId === "synthetic-account-manager-5",
    ).status,
    "active",
  );
  await settled();
  assert.equal(writes.length, 3);
  for (const { body, key } of writes) {
    assert.equal(body.command.id, key);
    assert(Number.isSafeInteger(body.command.expectedRevision));
  }
  assert.equal(writes[1].body.command.confirmRevocation, true);
  assert.match(writes[1].body.command.reason, /departed this season/);
  await picture("01-staff-explicit-revoke-and-assign");
  checks.push({
    name: "staff-existing-adult-assignment-revocation-and-four-account-limit",
    status: "passed",
    requestKeysAndRevisions: true,
    managerCount: roster.activeTeamManagerCount,
    finalRevision: roster.revision,
  });
  console.log("PASSED staff assignment/revocation");
  await changeWorkspaceContext(page, "manager");
  await page.getByTestId("preparation-create-event").waitFor();
  await settled();
  await openWorkspaceTab(page, "reports");
  const records = await service("records");
  const report = records.matches.find((item) => item.matchId === willow);
  assert.equal(report.award.result, "no_valid_votes");
  assert.equal(report.publishedAlbum.photoCount, 1);
  await page.getByTestId(`records-result-${willow}`).click();
  await page.getByTestId("report-community-card").waitFor();
  assert.match(
    await page.getByTestId("report-community-award").innerText(),
    /No valid votes/,
  );
  assert.match(
    await page.getByTestId("report-community-album").innerText(),
    /1 published photo/,
  );
  await page.getByTestId("report-community-card").scrollIntoViewIfNeeded();
  await picture("02-match-report-award-and-published-album");
  await page.getByTestId(`report-open-album-${willow}`).click();
  await page.getByTestId("album-selected-game").waitFor();
  assert.match(
    await page.getByTestId("album-selected-game").innerText(),
    /Willow FC/,
  );
  await page.getByTestId("album-photo-synthetic-published-pitch").click();
  await page.getByTestId("album-photo-viewer").waitFor();
  assert.match(
    await page.getByTestId("album-photo-viewer").innerText(),
    /No children or real photographs/,
  );
  await page.getByTestId("album-photo-viewer").scrollIntoViewIfNeeded();
  await picture("03-report-opens-exact-scoped-game-album");
  checks.push({
    name: "filtered-report-final-award-and-exact-published-game-album-navigation",
    status: "passed",
    award: "no_valid_votes",
    unapprovedChildBallotRefused: true,
    publishedPhotos: 1,
    bytesServed: false,
  });
  console.log("PASSED F18 award and album navigation");
  assert.deepEqual(pageErrors, []);
  const webHtml = await (await fetch(baseURL)).text();
  const bundleName = webHtml.match(/index-[a-f0-9]+\.js/)?.[0] ?? null;
  const apiHash = createHash("sha256")
    .update(await readFile("apps/api/dist/api.mjs"))
    .digest("hex");
  await writeFile(
    path.join(directory, "summary.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        viewport: { width: 390, height: 844 },
        webBundle: bundleName,
        apiBundleSha256: apiHash,
        checks,
        pageErrors,
        syntheticOnly: true,
        sourceCandidate:
          "uncommitted development source; native/provider acceptance unproved",
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (page)
    await page
      .screenshot({ path: path.join(directory, "failure.png") })
      .catch(() => {});
  throw error;
} finally {
  await browser?.close();
  server?.kill("SIGTERM");
  stream?.end();
}
