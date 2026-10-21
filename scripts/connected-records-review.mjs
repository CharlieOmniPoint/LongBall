import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { changeWorkspaceContext, enterFictionalReview, openWorkspaceTab, selectWorkspaceContext } from "./review-entry.mjs";

/** Phone browser + real isolated HTTP API; no application projection is injected.
 * Read-only service/IndexedDB inspection verifies persisted commands and unknown data.
 */
const baseURL = process.env.LONGBALL_REVIEW_BASE_URL ?? "http://127.0.0.1:4173";
const api =
  process.env.LONGBALL_RECORDS_REVIEW_API_URL ?? "http://127.0.0.1:4314";
const teamId = "synthetic-roma-u10",
  seasonId = "synthetic-season-2026-27";
const matchId = "synthetic-roma-maple-2026-10-24",
  alias = "connected-records-review-phone";
const directory = path.resolve(".local/connected-records-review");
const runId = new Date().toISOString().replaceAll(/[^0-9]/g, "");
const checks = [],
  errors = [];
let server, stream, browser, context, page;
let inspectionWindowStartedAt = null;
await mkdir(directory, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function poll(read, predicate, label) {
  const deadline = Date.now() + 25_000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await sleep(250);
  } while (Date.now() < deadline);
  assert.fail(
    `${label}; latest revision ${value?.revision ?? value?.acceptedRevision ?? "unavailable"}`,
  );
}
const scoped = (section, season = seasonId) =>
  `/v1/teams/${teamId}/${section}?seasonId=${encodeURIComponent(season)}`;
async function json(route, { token = "synthetic-manager-1", role } = {}) {
  inspectionWindowStartedAt ??= Date.now();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${api}${route}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(role ? { "X-Longball-Role": role } : {}),
      },
    });
    if (response.status === 429 && attempt === 0) {
      const delayMs = Math.min(
        60_000,
        Math.max(
          1_000,
          Number(response.headers.get("retry-after") ?? 60) * 1000,
        ),
      );
      await response.text();
      console.log(
        `Respecting API Retry-After for read-only inspection (${delayMs}ms).`,
      );
      await sleep(delayMs);
      continue;
    }
    assert.equal(response.ok, true, `${route}: HTTP${response.status}`);
    return response.json();
  }
}

const button = (name, root = page) =>
  root.getByRole("button", { name, exact: true }).click({ noWaitAfter: true });
const input = (name, value) =>
  page.getByLabel(name, { exact: true }).fill(value);
const tab = (name) => openWorkspaceTab(page, name);
async function settleWorkspace() {
  const refresh = page.getByRole("button", {name: "Refresh service views", exact: true});
  await refresh.waitFor();
  await poll(() => refresh.isEnabled(), Boolean, "The local receipt and refreshed service views settled");
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
    `${name}: no phone horizontal overflow`,
  );
}
async function startAPI() {
  if (process.env.LONGBALL_REVIEW_EXTERNAL_API === "1") return;
  const url = new URL(api);
  assert(["127.0.0.1", "localhost"].includes(url.hostname));
  stream = createWriteStream(path.join(directory, "api.log"));
  server = spawn(process.execPath, ["apps/api/dist/api.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "development",
      LONGBALL_SYNTHETIC_AUTH: "1",
      LONGBALL_API_HOST: "127.0.0.1",
      LONGBALL_API_PORT: url.port,
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
        throw new Error(`Isolated API exited ${server.exitCode}; see api.log`);
      try {
        return (await fetch(`${api}/health`)).ok;
      } catch {
        return false;
      }
    },
    Boolean,
    "Start isolated fictional API",
  );
}
async function stored() {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("longball-synthetic-m0");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction("journal", "readonly");
          const read = transaction.objectStore("journal").get("record");
          transaction.oncomplete = () => {
            db.close();
            resolve(read.result ?? null);
          };
          transaction.onabort = () => {
            db.close();
            reject(transaction.error);
          };
        };
      }),
  );
}
async function controller() {
  return Object.values((await stored())?.projections ?? {}).find(
    (doc) =>
      doc?.kind === "longball-canonical-connected-v1" &&
      doc.deviceId === alias &&
      doc.baseUrl === api,
  );
}
const waitController = (predicate, label) =>
  poll(controller, (value) => value && predicate(value), label);
async function confirm(name, status) {
  await button(name);
  await button("Confirm the actual event now");
  return waitController((doc) => doc.localState.status === status, name);
}
async function exportFile(id) {
  const event = page.waitForEvent("download");
  await page.getByTestId(id).click();
  const download = await event;
  const destination = path.join(directory, download.suggestedFilename());
  await download.saveAs(destination);
  return readFile(destination, "utf8");
}
async function enter(account = "Fictional manager") {
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await enterFictionalReview(page);
  await page.getByTestId("prepare-match").waitFor();
  await button("More");
  await button("Service and controller");
  await input("Workspace API URL", api);
  await button("Fictional API review");
  await button(account);
  await page.getByTestId("workspace-connect").click();
  if (account !== "Fictional invite recipient") await selectWorkspaceContext(page);
  await page.getByTestId("workspace-tab-reports").waitFor();
  if (account === "Fictional manager")
    await page.getByTestId("preparation-create-event").waitFor();
}
async function scenario(name, action) {
  const detail = await action();
  checks.push({ name, status: "passed", detail });
  console.log(`PASSED ${name}`);
}
try {
  await startAPI();
  const initial = await json(
    `/v1/matches/${matchId}/download?deviceId=initial-probe`,
  );
  assert.equal(
    initial.acceptedRevision,
    0,
    "This rehearsal must use a fresh isolated API; never reset an existing stream.",
  );
  browser = await chromium.launch({
    executablePath:
      process.env.LONGBALL_CHROMIUM_PATH ??
      (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    headless: true,
    args: ["--no-sandbox"],
  });
  context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
    acceptDownloads: true,
  });
  page = await context.newPage();
  page.setDefaultTimeout(25_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await enter();

  await scenario(
    "01-rich-history-audited-correction-and-unknown-coverage",
    async () => {
      await tab("reports");
      await page.getByTestId("records-add-past").click();
      await page.getByTestId("records-past-date").fill("2026-09-20");
      await page
        .getByTestId("records-past-opponent")
        .fill("Connected Cedar history");
      await page.getByTestId("records-past-for").fill("3");
      await page.getByTestId("records-past-against").fill("1");
      await page.getByRole("radio", { name: "friendly", exact: true }).click();
      await page.getByTestId("records-past-review-button").click();
      assert.match(
        await page.getByTestId("records-past-review").innerText(),
        /No minutes, attendance, clock, award window or historical notification is created/,
      );
      await page.getByTestId("records-past-save").click();
      let value = await poll(
        () => json(scoped("records")),
        (dto) =>
          dto.editableState?.results.some(
            (row) => row.opponent === "Connected Cedar history",
          ),
        "Historical result saved",
      );
      const result = value.editableState.results.find(
        (row) => row.opponent === "Connected Cedar history",
      );
      assert.equal(result.participation, null);
      assert.equal(result.actualActiveDurationMs, null);
      assert.equal(result.goals.length, 0);
      await page.getByTestId(`records-result-${result.id}`).click();
      await page.getByTestId("records-correct").click();
      await page.getByTestId("records-past-for").fill("4");
      await page
        .getByTestId("records-correction-reason")
        .fill("Checked the fictional paper result against the original entry.");
      await page.getByTestId("records-past-review-button").click();
      await page.getByTestId("records-past-save").click();
      value = await poll(
        () => json(scoped("records")),
        (dto) =>
          dto.editableState?.results.find((row) => row.id === result.id)
            ?.finalScore?.for === 4,
        "Audited correction persisted",
      );
      const corrected = value.editableState.results.find(
        (row) => row.id === result.id,
      );
      assert.equal(corrected.revision, result.revision + 1);
      assert.equal(
        value.editableState.results.filter((row) => row.id === result.id)
          .length,
        1,
      );
      assert(
        value.editableState.audit.some((entry) =>
          JSON.stringify(entry).includes("Checked the fictional paper result"),
        ),
      );
      const knownTotals = { ...value.results.totals };
      await tab("reports");
      await page.getByTestId("records-add-past").click();
      await page.getByTestId("records-past-date").fill("2026-09-27");
      await page
        .getByTestId("records-past-opponent")
        .fill("Connected Ash unknown score");
      await page.getByLabel("Final score is known", { exact: true }).uncheck();
      await page.getByTestId("records-past-review-button").click();
      await page.getByTestId("records-past-save").click();
      value = await poll(
        () => json(scoped("records")),
        (dto) => dto.results.unknownScoreCount === 1,
        "Unknown score retained",
      );
      assert.deepEqual(
        value.results.totals,
        knownTotals,
        "An unknown score cannot add a draw, played denominator or points.",
      );
      assert(
        value.participation.rows.every(
          (row) => row.matchesWithParticipationRecorded === 0,
        ),
      );
      await page.getByTestId("records-tab-participation").click();
      assert.match(
        await page
          .getByTestId("records-participation-synthetic-player-01")
          .innerText(),
        /Not recorded/,
      );
      await picture("01-historical-unknown-participation");
      return {
        historicalId: result.id,
        correctedRevision: corrected.revision,
        historicalMinutesInvented: false,
        unknownScoreExcludedFromDraws: true,
      };
    },
  );

  await scenario("02-accepted-match-context-archive-and-exports", async () => {
    await tab("controller");
    await input("Connected match identifier", matchId);
    await input("LongBall service URL", api);
    await button("Manager A");
    await input("Rehearsal device identifier", alias);
    await button("Open this service connection");
    await waitController(() => true, "Scoped controller storage");
    await button("Download accepted service match");
    await waitController(
      (doc) => Boolean(doc.localState),
      "Download canonical accepted match",
    );
    await button("Acquire controller for this device");
    await waitController(
      (doc) => doc.controllerConfirmed && !doc.authoritativeDownloadRequired,
      "Confirmed controller",
    );
    await button("Record fictional squad present");
    await waitController(
      (doc) =>
        doc.localState.config.selectedPlayerIds.every(
          (id) => doc.localState.attendance[id] === "present",
        ),
      "Attendance saved",
    );
    await button("Stage first seven present players");
    await waitController(
      (doc) => doc.localState.stagedLineup?.length === 7,
      "Stage valid lineup",
    );
    const date = new Date();
    await page.clock.install({ time: date });
    await page.clock.pauseAt(new Date(date.getTime() + 60_000));
    await confirm("Review kickoff", "first_half_running");
    await page.clock.fastForward(30_000);
    await button("Record fictional team goal");
    await waitController(
      (doc) => doc.localState.goals.length === 1,
      "Actual accepted goal pending upload",
    );
    await confirm("Review manual half-time", "half_time");
    await confirm("Review second-half start", "second_half_running");
    await page.clock.fastForward(20_000);
    await confirm("Review manual full-time", "completed");
    await button("Upload pending canonical events");
    await waitController(
      (doc) =>
        !doc.pendingRequest &&
        !doc.authoritativeDownloadRequired &&
        doc.acceptedState?.status === "completed",
      "Completed canonical match accepted",
    );
    await page.clock.resume();
    await button("Refresh service views");
    await tab("reports");
    let value = await json(scoped("records"));
    const offered = value.contexts.find((row) => row.matchId === matchId);
    assert(offered);
    await button(
      `${offered.opponent} · ${offered.playedDate} · ${offered.status.replaceAll("_", " ")}`,
    );
    await button("friendly");
    await button("Use this accepted match for reports");
    value = await poll(
      () => json(scoped("records")),
      (dto) => dto.editableState.liveMatch.fixtureClass === "friendly",
      "Explicit context saved",
    );
    await page.getByTestId("records-archive-match").click();
    value = await poll(
      () => json(scoped("records")),
      (dto) => dto.editableState.results.some((row) => row.id === matchId),
      "Accepted match archived",
    );
    const archived = value.editableState.results.find(
      (row) => row.id === matchId,
    );
    assert.equal(archived.sourceMatchRevision, value.activeMatch.revision);
    assert.equal(archived.actualActiveDurationMs, 50_000);
    assert.equal(
      archived.participation.length,
      value.activeMatch.config.selectedPlayerIds.length,
    );
    assert.equal(
      archived.participation.filter((row) => row.playedMs === 50_000).length,
      7,
    );
    const document = JSON.parse(await exportFile("records-export-json"));
    assert.equal(document.audience, "manager");
    assert.equal(document.seasonId, seasonId);
    assert.equal(document.projectionVersion, value.revision);
    assert.equal(
      document.dataCoverage.includesInventedHistoricalMinutes,
      false,
    );
    assert.equal(document.results.unknownScoreCount, 1);
    assert(document.policyFingerprint);
    const csv = await exportFile("records-export-csv");
    assert.match(csv, /"projectionVersion"/);
    assert.match(csv, /"Not recorded"/);
    await button("Match report");
    await button(`${archived.opponent} · ${archived.playedDate}`);
    const matchExport = JSON.parse(await exportFile("records-export-json"));
    assert.equal(matchExport.reportType, "match");
    assert.equal(matchExport.matches.length, 1);
    assert.equal(matchExport.matches[0].matchId, matchId);
    await picture("02-accepted-archive-and-exports");
    return {
      archivedSourceRevision: archived.sourceMatchRevision,
      recordedActiveMs: archived.actualActiveDurationMs,
      explicitContext: true,
      browserJsonCsvDownloads: true,
      nativeShareTested: false,
    };
  });

  await scenario(
    "03-administrator-configuration-explicit-rollover-preserves-source",
    async () => {
      // Automated proof reads are additional traffic beyond phone interaction.
      // Begin this burst in a fresh ordinary120/minute window; never bypass
      // or change the service's rate policy for this rehearsal.
      const waitMs = Math.max(
        0,
        (inspectionWindowStartedAt ?? Date.now()) + 60_500 - Date.now(),
      );
      if (waitMs) {
        console.log(
          `Respecting the API request window before rollover (${waitMs}ms).`,
        );
        await sleep(Math.min(waitMs, 60_000));
      }
      await changeWorkspaceContext(page, "administrator");
      await openWorkspaceTab(page, "settings");
      await page.getByTestId("administrator-configuration").waitFor();
      assert.equal(await page.getByTestId("workspace-tab-reports").count(), 0);
      assert.equal(await page.getByTestId("workspace-tab-team").count(), 0);
      const safe = await json(scoped("configuration"), {
        role: "administrator",
      });
      assert.equal(safe.profiles, undefined);
      assert.equal(safe.fixtures, undefined);
      await input("Club name", "Roma Community · fictional review");
      await button("Save administrator club configuration");
      await poll(
        () => json(scoped("configuration"), { role: "administrator" }),
        (dto) => dto.club.name === "Roma Community · fictional review",
        "Safe club configuration saved",
      );
      await settleWorkspace();
      await input("Team name", "Roma Juniors");
      await input("Age group", "U10");
      await input("Default half duration in minutes", "24");
      await button("Save administrator team configuration");
      await poll(
        () => json(scoped("configuration"), { role: "administrator" }),
        (dto) =>
          dto.team.name === "Roma Juniors" &&
          dto.team.ageGroup === "U10" &&
          dto.team.defaultHalfDurationMs === 1_440_000,
        "Safe team configuration saved",
      );
      await settleWorkspace();
      const sourcePrep = await json(scoped("preparation"));
      const sourceRecords = await json(scoped("records"));
      const sourceCommunity = await json(scoped("community"));
      const options = await json(scoped("seasons/rollover-options"), {
        role: "administrator",
      });
      assert.equal(options.canRollover, true);
      assert.equal(options.existingNextSeasonId, null);
      await tab("seasons");
      await page.getByTestId("connected-season-rollover").waitFor();
      assert.equal(
        await page.getByTestId("season-rollover-review").isDisabled(),
        true,
        "Assignments never silently preapprove roles.",
      );
      const manager = options.managerCandidates.find(
        (person) => person.accountId === "synthetic-account-manager",
      );
      assert(manager?.administrator);
      await button(`${manager.label} · current manager`);
      await button(`${manager.label} · retain administrator?`);
      const player = options.playerCandidates.find(
        (person) => person.playerId === "synthetic-player-01",
      );
      assert(player);
      await button(player.label);
      await button("Acknowledge individual spectator renewal");
      await page.getByTestId("season-rollover-review").click();
      assert.match(
        await page
          .getByText(/explicit existing player-account links/)
          .innerText(),
        /1 explicit/,
      );
      await picture("03-explicit-season-assignments");
      await page.getByTestId("season-rollover-confirm").click();
      const identity = await poll(
        () => json("/v1/me"),
        (dto) =>
          dto.memberships.some(
            (item) => item.teamId === teamId && item.seasonId !== seasonId,
          ),
        "Explicit next-season memberships",
      );
      const destination = identity.memberships.find(
        (item) => item.teamId === teamId && item.seasonId !== seasonId,
      ).seasonId;
      const nextPrep = await json(scoped("preparation", destination));
      const nextRecords = await json(scoped("records", destination));
      const nextCommunity = await json(scoped("community", destination));
      assert.equal(nextPrep.seasons[0].startDate, "2027-09-01");
      assert.equal(nextPrep.seasons[0].endDate, "2028-08-31");
      assert.equal(
        nextPrep.profiles.length,
        sourcePrep.profiles.filter((row) => row.active).length,
      );
      assert.equal(nextPrep.fixtures.length, 0);
      assert.equal(nextPrep.snapshots.length, 0);
      assert.equal(nextRecords.editableState.results.length, 0);
      assert.equal(nextCommunity.grants.length, 0);
      assert.equal(nextCommunity.invitations.length, 0);
      assert.deepEqual(await json(scoped("preparation")), sourcePrep);
      assert.deepEqual(
        (await json(scoped("records"))).editableState,
        sourceRecords.editableState,
      );
      assert.deepEqual(
        (await json(scoped("community"))).grants,
        sourceCommunity.grants,
      );
      const unchangedMatch = (await json(`/v1/matches/${matchId}`)).state;
      assert.equal(unchangedMatch.status, "completed");
      assert.equal(
        unchangedMatch.config.plannedHalfDurationMs,
        1_500_000,
        "New defaults cannot rewrite an existing match snapshot.",
      );
      const own = await json(scoped("preparation/own", destination), {
        token: "synthetic-account-player-01",
      });
      assert.equal(own.profile.playerId, "synthetic-player-01");
      const notRenewed = await fetch(
        `${api}${scoped("community", destination)}`,
        { headers: { Authorization: "Bearer synthetic-spectator" } },
      );
      assert.equal(notRenewed.status, 404);
      await page.getByTestId("preparation-create-event").waitFor();
      await settleWorkspace();
      await button(`${teamId} · ${seasonId}`);
      await settleWorkspace();
      await tab("seasons");
      await page.getByText(/The next season already exists/).waitFor();
      assert.equal(
        await page.getByTestId("season-rollover-review").isDisabled(),
        true,
      );
      await picture("03-created-season-cannot-duplicate");
      return {
        destinationSeasonId: destination,
        sourcePreparationRecordsMembershipsPreserved: true,
        ongoingMatchUnchanged: true,
        explicitPlayerLinkCount: 1,
        spectatorGrantsCopied: 0,
        duplicateNextSeasonBlocked: true,
      };
    },
  );
  await scenario(
    "04-delayed-scope-denial-closes-parallel-private-replies",
    async () => {
      await tab("team");
      await page
        .getByRole("button", { name: "Edit Player 01", exact: true })
        .waitFor();
      let release = () => {};
      let responseHeld = false;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      const matchRecords = (url) =>
        url.origin === new URL(api).origin &&
        url.pathname === `/v1/teams/${teamId}/records` &&
        url.searchParams.get("seasonId") === seasonId;
      const deny = async (route) => {
        if (route.request().method() !== "GET") {
          await route.continue();
          return;
        }
        const actual = await route.fetch();
        assert.equal(
          actual.ok(),
          true,
          "The transport fixture does not claim the real membership was revoked.",
        );
        responseHeld = true;
        await held;
        await route.fulfill({
          status: 403,
          headers: {
            "Access-Control-Allow-Origin": new URL(baseURL).origin,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            code: "NOT_FOUND",
            message: "Transport-only authority refusal fixture.",
          }),
        });
      };
      await page.route(matchRecords, deny);
      try {
        await button("Refresh service views");
        await poll(
          async () => responseHeld,
          Boolean,
          "Records response held while parallel private preparation loads",
        );
        await page
          .getByRole("button", { name: "Edit Player 01", exact: true })
          .waitFor();
        release();
        await page
          .getByText(
            /Private workspace views were closed because the service refused this scope/,
          )
          .waitFor();
        assert.equal(
          await page
            .getByRole("button", { name: "Edit Player 01", exact: true })
            .count(),
          0,
        );
        assert.equal(await page.getByTestId("workspace-reports").count(), 0);
        await picture("04-scoped-denial-private-views-closed");
      } finally {
        release();
        await page.unroute(matchRecords, deny);
      }
      let freshIdentities = 0;
      const observe = (request) => {
        if (request.method() === "GET" && request.url() === `${api}/v1/me`)
          freshIdentities += 1;
      };
      page.on("request", observe);
      await button("Refresh service views");
      await page
        .getByRole("button", { name: "Edit Player 01", exact: true })
        .waitFor();
      page.off("request", observe);
      assert(
        freshIdentities > 0,
        "Private views reopen only after a new-generation authoritative identity read.",
      );
      return {
        delayed403Fixture: true,
        realMembershipRevocationTested: false,
        parallelPrivateRepliesClosed: true,
        freshIdentityRequiredToReopen: true,
      };
    },
  );

  await scenario(
    "05-new-account-invitation-remains-online-and-usable",
    async () => {
      await tab("community");
      await button("Acknowledge sharing a limited season invitation");
      await button("Create service invitation code");
      const invitations = await poll(
        () => json(scoped("community")),
        (value) =>
          value.invitations.some(
            (item) => !item.revokedAtMs && !item.acceptedBy,
          ),
        "Create actual source-season invitation",
      );
      const invitation = invitations.invitations.find(
        (item) => !item.revokedAtMs && !item.acceptedBy,
      );
      await context.close();
      context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        reducedMotion: "reduce",
      });
      page = await context.newPage();
      page.setDefaultTimeout(25_000);
      page.on("pageerror", (error) => errors.push(error.message));
      const before = await json("/v1/me", {
        token: "synthetic-account-invitee",
      });
      assert.equal(before.memberships.length, 0);
      await enter("Fictional invite recipient");
      await tab("community");
      await input("Invitation team identifier", teamId);
      await input("Invitation season identifier", seasonId);
      await input("Service invitation code", invitation.reviewCode);
      await button("Accept service invitation");
      const after = await poll(
        () => json("/v1/me", { token: "synthetic-account-invitee" }),
        (value) =>
          value.memberships.some(
            (item) =>
              item.teamId === teamId &&
              item.seasonId === seasonId &&
              item.role === "spectator",
          ),
        "Invitation acceptance with no prior membership",
      );
      assert(
        after.memberships.every(
          (item) => item.role === "spectator" && item.seasonId === seasonId,
        ),
      );
      await settleWorkspace();
      await tab("community");
      await page.getByTestId("workspace-community").waitFor();
      assert.doesNotMatch(
        await page.getByTestId("workspace-community").innerText(),
        /Player 01|Player 02/,
      );
      assert.equal(
        JSON.stringify(await stored()).includes(invitation.reviewCode),
        false,
        "Acceptance code is not persisted in the invitation recipient's browser journal.",
      );
      await picture("05-new-account-invitation-accepted");
      return {
        priorMembershipCount: 0,
        explicitlyAddressedSeason: seasonId,
        grantedRole: "spectator",
        acceptanceCodePersisted: false,
      };
    },
  );
  assert.deepEqual(errors, [], "No uncaught browser runtime exceptions");
} catch (error) {
  checks.push({
    name: "active-journey",
    status: "failed",
    error: error.message,
  });
  await page
    ?.screenshot({
      path: path.join(directory, "failure.png"),
      animations: "disabled",
    })
    .catch(() => {});
  console.error(error.stack ?? error);
} finally {
  await writeFile(
    path.join(directory, "summary.json"),
    JSON.stringify(
      {
        baseURL,
        api,
        viewport: { width: 390, height: 844 },
        checks,
        browserErrors: errors,
        nativeDeviceTested: false,
      },
      null,
      2,
    ),
  );
  await context?.close();
  await browser?.close();
  if (server) {
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
  }
  stream?.end();
}
if (checks.some((check) => check.status !== "passed")) process.exitCode = 1;
console.log(
  `Connected records review: ${checks.filter((check) => check.status === "passed").length} passed; evidence ${directory}`,
);
