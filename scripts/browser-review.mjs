import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { enterFictionalReview } from "./review-entry.mjs";

/**
 * Synthetic browser journey against a built, locally served application.
 * Run `pnpm build:web`, `pnpm preview:web`, then `pnpm test:e2e`.
 * Browser evidence supplements the native M0 device test matrix.
 */
const baseURL = process.env.LONGBALL_REVIEW_BASE_URL ?? "http://127.0.0.1:4173";
const outputDirectory = path.resolve(".local/review");
const matchId = "synthetic-roma-maple-2026-10-24";
const executablePath =
  process.env.LONGBALL_CHROMIUM_PATH ??
  (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--no-sandbox"],
});
const consoleErrors = [];
const checks = [];
await mkdir(outputDirectory, { recursive: true });

// Application preparation and each fixture share one journal document. Sequences
// are reserved per match/device, so identical sequence numbers in other scopes are valid.
function scopedEntries(record) {
  return Object.entries(record?.events ?? {}).filter(([, event]) => event.matchId === matchId);
}
function scopedIds(record) { return scopedEntries(record).map(([eventId]) => eventId); }

async function snapshot(page) {
  return page.evaluate(async (requestedMatchId) => {
    // IndexedDB is the browser journal's transaction boundary. Inspect real saved
    // records without relying on UI text or injecting application state.
    const databases = await indexedDB.databases();
    for (const metadata of databases) {
      if (!metadata.name?.includes("longball")) continue;
      const records = await new Promise((resolve, reject) => {
        const request = indexedDB.open(metadata.name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const names = Array.from(database.objectStoreNames);
          if (!names.length) {
            database.close();
            resolve([]);
            return;
          }
          const transaction = database.transaction(names, "readonly");
          const found = [];
          for (const name of names) {
            const query = transaction.objectStore(name).getAll();
            query.onsuccess = () => found.push(...query.result);
          }
          transaction.oncomplete = () => {
            database.close();
            resolve(found);
          };
          transaction.onerror = () => {
            database.close();
            reject(transaction.error);
          };
        };
      });
      const record = records.find(
        (value) => value?.projections?.[requestedMatchId],
      );
      if (record) return record;
    }
    const local = localStorage.getItem("longball.synthetic.m0.v1");
    return local ? JSON.parse(local) : null;
  }, matchId);
}

async function savedState(page) {
  const record = await snapshot(page);
  assert(
    record?.projections?.[matchId],
    "The browser must retain the match projection.",
  );
  return record.projections[matchId];
}

async function waitState(page, predicate, message) {
  const deadline = Date.now() + 10_000;
  let state;
  do {
    state = await savedState(page);
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 40));
  } while (Date.now() < deadline);
  assert.fail(
    `${message}; latest status=${state?.status}, revision=${state?.revision}`,
  );
}

async function screenshot(page, name) {
  await page.screenshot({
    path: path.join(outputDirectory, `${name}.png`),
    animations: "disabled",
  });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  assert.equal(
    overflow,
    false,
    `${name}: the phone page must not overflow horizontally.`,
  );
}

async function assertActionVisible(page, testId, viewportHeight = 844) {
  const bounds = await page.getByTestId(testId).boundingBox();
  assert(
    bounds && bounds.y >= 0 && bounds.y + bounds.height <= viewportHeight,
    `${testId} must remain visible without scrolling.`,
  );
  assert(
    bounds.width >= 48 && bounds.height >= 48,
    `${testId} must retain a minimum 48-unit touch target.`,
  );
}

async function openReview(context) {
  const page = await context.newPage();
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await enterFictionalReview(page);
  await page.getByTestId("prepare-match").waitFor();
  return page;
}

try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
  });
  const page = await openReview(context);
  let state = await savedState(page);
  assert.equal(state.status, "preparation");
  assert.equal(state.config.selectedPlayerIds.length, 9);
  assert.equal(state.config.players.length, 13);
  assert.equal(
    Object.values(state.attendance).filter((value) => value === "present")
      .length,
    0,
  );
  assert.equal(state.intervals.length, 0);
  await screenshot(page, "01-phone-home");
  checks.push(
    "Home: 13 fictional roster records, nine selected, zero inferred attendance.",
  );

  await page.getByTestId("prepare-match").click();
  await page
    .getByRole("radio", { name: "Oliver Bennett, Absent", exact: true })
    .click();
  state = await waitState(
    page,
    (value) => value.attendance["synthetic-player-01"] === "absent",
    "Attendance was not saved",
  );
  assert.equal(
    state.availability["synthetic-player-01"],
    true,
    "Attendance is separate from selected-match availability.",
  );
  await page.getByTestId("check-in-all").click();
  state = await waitState(
    page,
    (value) =>
      Object.values(value.attendance).filter((status) => status === "present")
        .length === 9,
    "Bulk check-in did not finish",
  );
  assert.equal(
    state.intervals.length,
    0,
    "Check-in cannot create participation.",
  );
  checks.push(
    "Attendance: explicit absent/present change and bulk check-in preserve separate availability.",
  );

  await page.getByTestId("continue-lineup").click();
  assert.equal(
    await page.getByTestId("start-half").isDisabled(),
    true,
    "An empty lineup must not start.",
  );
  await page.getByTestId("place-seven").click();
  state = await waitState(
    page,
    (value) => value.stagedLineup.length === 7,
    "Seven starters were not staged",
  );
  assert.equal(
    new Set(state.stagedLineup.map((item) => item.playerId)).size,
    7,
  );
  await page.getByRole("button", { name: /^Goalkeeper, Oliver Bennett,/ }).click();
  await page.getByRole("button", { name: "Choose Noah Patel", exact: true }).click();
  await page.getByText(/Goalkeeper cover requires a first- or second-choice eligible keeper/).waitFor();
  const rejectedKeeperState = await savedState(page);
  assert.equal(rejectedKeeperState.revision, state.revision, "An invalid keeper assignment cannot change the saved draft.");
  assert.equal(rejectedKeeperState.stagedLineup.find(item => item.slotId === "gk").playerId, "synthetic-player-01");
  assert.equal(rejectedKeeperState.intervals.length, 0);
  await page.getByRole("button", { name: /^Left wing, Oscar Evans,/ }).click();
  await page
    .getByRole("button", { name: "Choose Freddie Lewis", exact: true })
    .click();
  state = await waitState(
    page,
    (value) =>
      value.stagedLineup.some(
        (item) =>
          item.slotId === "lw" && item.playerId === "synthetic-player-08",
      ),
    "The bench swap was not staged",
  );
  assert.equal(
    state.lineup.length,
    0,
    "A staged pre-match swap cannot become actual participation.",
  );
  assert.equal(state.intervals.length, 0);
  await assertActionVisible(page, "start-half");
  await screenshot(page, "02-phone-lineup");
  checks.push(
    "Lineup: empty start blocked, ineligible keeper change rejected with an error, seven unique places and a bench swap remain drafts.",
  );

  const fixedTime = new Date("2026-10-24T09:00:00.000Z");
  // Install before the pause target so protocol scheduling cannot put that
  // target in the past on a busy review host.
  await page.clock.install({ time: new Date(fixedTime.getTime() - 3_600_000) });
  await page.clock.pauseAt(fixedTime);
  await page.getByTestId("start-half").click();
  state = await waitState(
    page,
    (value) => value.status === "first_half_running",
    "First half did not start",
  );
  await assertActionVisible(page, "pause-resume");
  await assertActionVisible(page, "end-half");
  assert.equal(
    state.lineup.find((item) => item.slotId === "lw").playerId,
    "synthetic-player-08",
  );
  const firstHalfAnchor = state.anchor.sample.monotonicMs;
  await page.clock.fastForward(720_000);
  await page.getByTestId("pause-resume").click();
  const paused = await waitState(
    page,
    (value) => value.status === "first_half_paused",
    "Pause did not commit",
  );
  assert(
    Math.abs(paused.halfActiveMs - 720_000) < 1000,
    "Elapsed time must derive from anchors across skipped UI ticks.",
  );
  await page.clock.fastForward(180_000);
  assert.equal((await savedState(page)).halfActiveMs, paused.halfActiveMs);
  await screenshot(page, "03-phone-paused");
  await page.getByTestId("pause-resume").click();
  await waitState(
    page,
    (value) => value.status === "first_half_running",
    "Resume did not commit",
  );
  await page
    .getByRole("button", { name: "Back to team; clock continues", exact: true })
    .click();
  await page.clock.fastForward(30_000);
  assert.equal(
    (await savedState(page)).status,
    "first_half_running",
    "Navigation cannot pause the half.",
  );
  await page.getByTestId("prepare-match").click();
  await page.clock.fastForward(1_420_000 - paused.halfActiveMs - 30_000);
  await screenshot(page, "04-phone-live");
  await page.getByTestId("end-half").click();
  await page.getByRole("button", { name: "Keep playing", exact: true }).click();
  assert.equal(
    (await savedState(page)).status,
    "first_half_running",
    "End confirmation cancellation cannot end play.",
  );
  await page.getByTestId("end-half").click();
  await page.getByTestId("confirm-end").click();
  state = await waitState(
    page,
    (value) => value.status === "half_time",
    "End first half did not commit",
  );
  assert(
    Math.abs(state.firstHalfDurationMs - 1_420_000) < 1000,
    "The first half should preserve its actual 23:40.",
  );
  assert.equal(state.halfActiveMs, state.firstHalfDurationMs);
  assert(state.anchor === null);
  checks.push(
    "Clock: skipped render ticks retain time; pause excludes three minutes; navigation never pauses; manual first-half ending preserves 23:40.",
  );

  const halfTimeDuration = state.matchActiveMs;
  const firstHalfIntervals = JSON.stringify(state.intervals);
  const firstActualLineup = JSON.stringify(state.lineup);
  await page.getByTestId("prepare-second-half").click();
  await page.getByRole("button", { name: /^Right wing, Ethan Brooks,/ }).click();
  await page
    .getByRole("button", { name: "Choose Arthur James", exact: true })
    .click();
  await waitState(
    page,
    (value) =>
      value.stagedLineup.some(
        (item) =>
          item.slotId === "rw" && item.playerId === "synthetic-player-09",
      ),
    "Half-time changes were not staged",
  );
  await page.clock.fastForward(420_000);
  state = await savedState(page);
  assert.equal(
    state.matchActiveMs,
    halfTimeDuration,
    "A seven-minute break cannot accrue active time.",
  );
  assert.equal(
    JSON.stringify(state.intervals),
    firstHalfIntervals,
    "Half-time drafts must preserve earlier participation.",
  );
  assert.equal(
    JSON.stringify(state.lineup),
    firstActualLineup,
    "Half-time drafts apply only on restart.",
  );
  await screenshot(page, "05-phone-half-time");
  await assertActionVisible(page, "start-half");
  await page.getByTestId("start-half").click();
  state = await waitState(
    page,
    (value) => value.status === "second_half_running",
    "Second half did not start",
  );
  assert.equal(state.halfActiveMs, 0);
  assert.equal(state.matchActiveMs, halfTimeDuration);
  assert.equal(
    state.lineup.find((item) => item.slotId === "rw").playerId,
    "synthetic-player-09",
  );
  assert.equal(
    state.config.plannedHalfDurationMs,
    1_500_000,
    "An early first half cannot shorten the second.",
  );
  checks.push(
    "Half-time: seven-minute break and lineup staging add no time; the second half restarts at 25:00 with one committed lineup.",
  );

  await page.clock.fastForward(300_000);
  const journalBeforeReload = await snapshot(page);
  const eventIdsBeforeReload = scopedIds(journalBeforeReload);
  await page.reload({ waitUntil: "networkidle" });
  await enterFictionalReview(page);
  await page.getByTestId("prepare-match").click();
  await page
    .getByRole("button", { name: "Check the match clock", exact: true })
    .click();
  await page
    .getByRole("textbox", {
      name: "Confirmed elapsed time in minutes and seconds",
      exact: true,
    })
    .fill("05:00");
  await page
    .getByRole("textbox", {
      name: "Clock correction source and reason",
      exact: true,
    })
    .fill("Synthetic rehearsal checked against the referee clock");
  await page
    .getByRole("switch", {
      name: "Lineup and availability stayed unchanged since checkpoint",
      exact: true,
    })
    .click();
  await screenshot(page, "06-phone-clock-recovery");
  await page
    .getByRole("button", { name: "Record confirmed time", exact: true })
    .click();
  state = await waitState(
    page,
    (value) =>
      value.status === "second_half_running" && value.halfActiveMs === 300_000,
    "Reviewed clock recovery did not commit",
  );
  const journalAfterRecovery = await snapshot(page);
  for (const eventId of eventIdsBeforeReload)
    assert(
      journalAfterRecovery.events[eventId],
      "Reload/recovery must preserve every previous event.",
    );
  assert.equal(state.recoveryRequired, false);
  assert.equal(state.recoveryReason, null);
  checks.push(
    "Recovery: reload retains the journal and requires explicit referee time plus unchanged-lineup confirmation.",
  );

  const previousWallTime = await page.evaluate(() => Date.now());
  await page.clock.setFixedTime(new Date(previousWallTime - 1_200_000));
  await page.clock.fastForward(1_272_000);
  await page.getByText("+01:12 added time", { exact: true }).waitFor();
  assert.equal(
    (await savedState(page)).status,
    "second_half_running",
    "Countdown zero must never end the half automatically.",
  );
  await page.getByTestId("end-half").click();
  await page.getByTestId("confirm-end").click();
  state = await waitState(
    page,
    (value) => value.status === "completed",
    "Full-time confirmation did not commit",
  );
  assert(Math.abs(state.halfActiveMs - 1_572_000) < 1000);
  assert(Math.abs(state.matchActiveMs - 2_992_000) < 1000);
  const actualPitchTime = state.intervals
    .filter((item) => item.state === "playing")
    .reduce((total, item) => total + item.endMs - item.startMs, 0);
  assert.equal(
    actualPitchTime,
    state.matchActiveMs * 7,
    "Seven occupied places must reconcile with recorded participation.",
  );
  const journal = await snapshot(page);
  const events = scopedEntries(journal).map(([, event]) => event).sort(
    (a, b) => a.sequence - b.sequence,
  );
  assert.equal(
    new Set(events.map((event) => event.sequence)).size,
    events.length,
    "Saved sequence numbers must remain unique.",
  );
  events.forEach((event, index) => {
    assert.equal(event.sequence, index + 1);
    assert.equal(
      event.previousEventId,
      index === 0
        ? null
        : scopedEntries(journal).find(
            ([, prior]) => prior.sequence === index,
          )?.[0],
    );
  });
  await screenshot(page, "07-phone-full-time");
  checks.push(
    "Full time: wall-clock rollback leaves active time intact; added time keeps running; manual finish totals 49:52 and exact seven-place participation.",
  );
  checks.push(
    "Persistence: event IDs survive reload; sequence and predecessor chain remain complete and unique.",
  );

  const failureContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const failurePage = await openReview(failureContext);
  await failurePage.getByTestId("prepare-match").click();
  const beforeFailure = await snapshot(failurePage);
  await failurePage.evaluate(({ requestedMatchId, previousIds }) => {
    globalThis.__longballFailReviewWrite = true;
    const rejectFirstWrite = (value) => {
      if (!globalThis.__longballFailReviewWrite) return;
      if (!Object.entries(value?.events ?? {}).some(([eventId, event]) =>
        event.matchId === requestedMatchId && !previousIds.includes(eventId))) return;
      globalThis.__longballFailReviewWrite = false;
      globalThis.__longballAttemptedRecord = value;
      throw new DOMException(
        "Synthetic review write failure",
        "QuotaExceededError",
      );
    };
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (this.name === "journal") rejectFirstWrite(value);
      return originalPut.call(this, value, ...args);
    };
    const originalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "longball.synthetic.m0.v1")
        rejectFirstWrite(JSON.parse(value));
      return originalSet.call(this, key, value);
    };
  }, { requestedMatchId: matchId, previousIds: scopedIds(beforeFailure) });
  await failurePage
    .getByRole("radio", { name: "Oliver Bennett, Present", exact: true })
    .click();
  await failurePage
    .getByRole("button", { name: "Retry unsaved action", exact: true })
    .waitFor();
  assert.equal(
    (await savedState(failurePage)).attendance["synthetic-player-01"],
    "not_recorded",
    "A rejected write cannot appear saved.",
  );
  assert.deepEqual(
    scopedIds(await snapshot(failurePage)),
    scopedIds(beforeFailure),
    "A failed write must retain original history.",
  );
  const attemptedEventId = await failurePage.evaluate(
    ({ previousIds, requestedMatchId }) =>
      Object.entries(globalThis.__longballAttemptedRecord.events).find(
        ([id, event]) => event.matchId === requestedMatchId && !previousIds.includes(id),
      )?.[0],
    { previousIds: scopedIds(beforeFailure), requestedMatchId: matchId },
  );
  assert(
    attemptedEventId,
    "The injected failure must capture the prepared event identity.",
  );
  await screenshot(failurePage, "08-phone-write-failure");
  await failurePage
    .getByRole("button", { name: "Retry unsaved action", exact: true })
    .click();
  await waitState(
    failurePage,
    (value) => value.attendance["synthetic-player-01"] === "present",
    "Retry did not save the original action",
  );
  const afterRetry = await snapshot(failurePage);
  assert.equal(
    scopedIds(afterRetry).length,
    scopedIds(beforeFailure).length + 1,
  );
  assert(
    afterRetry.events[attemptedEventId],
    "Retry must retain the original event identity.",
  );
  checks.push(
    "Storage failure: injected quota failure shows unsaved state, preserves history, and retries the same event exactly once.",
  );
  await failureContext.close();

  const concurrentContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const firstTab = await openReview(concurrentContext);
  const secondTab = await openReview(concurrentContext);
  await firstTab.getByTestId("prepare-match").click();
  await secondTab.getByTestId("prepare-match").click();
  await firstTab
    .getByRole("radio", { name: "Oliver Bennett, Present", exact: true })
    .click();
  await waitState(
    firstTab,
    (value) => value.attendance["synthetic-player-01"] === "present",
    "First-tab action did not save",
  );
  await secondTab
    .getByRole("radio", { name: "Noah Patel, Present", exact: true })
    .click();
  const conflictDeadline = Date.now() + 10_000;
  let concurrentJournal;
  do {
    concurrentJournal = await snapshot(secondTab);
    if (
      scopedEntries(concurrentJournal).map(([, event]) => event).some(
        (event) => event.disposition === "quarantined",
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 40));
  } while (Date.now() < conflictDeadline);
  const concurrentState = await savedState(secondTab);
  assert.equal(concurrentState.attendance["synthetic-player-01"], "present");
  assert.equal(
    concurrentState.attendance["synthetic-player-02"],
    "not_recorded",
    "A stale tab cannot overwrite a newer projection.",
  );
  assert.equal(
    scopedIds(concurrentJournal).length,
    3,
    "The stale branch must remain in the journal alongside the winning action.",
  );
  const [quarantinedId, quarantined] =
    scopedEntries(concurrentJournal).find(
      ([, event]) => event.disposition === "quarantined",
    ) ?? [];
  assert(quarantined, "The rejected branch must be quarantined.");
  assert.equal(
    quarantined.sequence,
    3,
    "A rejected branch reserves its sequence number.",
  );
  assert.equal(
    quarantined.rejectedProjection.attendance["synthetic-player-02"],
    "present",
  );
  await secondTab.reload({ waitUntil: "networkidle" });
  await enterFictionalReview(secondTab);
  await secondTab.getByTestId("prepare-match").click();
  await secondTab
    .getByRole("radio", { name: "Noah Patel, Present", exact: true })
    .click();
  await waitState(
    secondTab,
    (value) => value.attendance["synthetic-player-02"] === "present",
    "A refreshed tab could not apply its new action",
  );
  concurrentJournal = await snapshot(secondTab);
  const fourth = scopedEntries(concurrentJournal).map(([, event]) => event).find(
    (event) => event.sequence === 4,
  );
  assert(fourth, "New writes cannot reuse a rejected sequence.");
  assert.equal(fourth.previousEventId, quarantinedId);
  assert.equal(
    concurrentJournal.events[quarantinedId].disposition,
    "quarantined",
  );
  assert.equal(
    (await savedState(secondTab)).attendance["synthetic-player-01"],
    "present",
  );
  checks.push(
    "Concurrent tabs: stale projection stays quarantined with its reserved sequence; reloaded writes retain the winning action and predecessor chain.",
  );
  await concurrentContext.close();

  const small = await browser.newContext({
    viewport: { width: 320, height: 740 },
    reducedMotion: "reduce",
  });
  const smallPage = await openReview(small);
  await screenshot(smallPage, "09-small-phone-home");
  await smallPage.getByTestId("prepare-match").click();
  await smallPage.getByTestId("check-in-all").click();
  await waitState(
    smallPage,
    (value) =>
      Object.values(value.attendance).filter((status) => status === "present")
        .length === 9,
    "Small-phone check-in did not finish",
  );
  await smallPage.getByTestId("continue-lineup").click();
  await smallPage.getByTestId("place-seven").click();
  await waitState(
    smallPage,
    (value) => value.stagedLineup.length === 7,
    "Small-phone lineup was not staged",
  );
  await assertActionVisible(smallPage, "start-half", 740);
  await screenshot(smallPage, "10-small-phone-lineup");
  await small.close();

  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const desktopPage = await openReview(desktop);
  await screenshot(desktopPage, "11-desktop-home");
  await desktop.close();
  assert.equal(
    consoleErrors.length,
    0,
    `Browser runtime errors: ${consoleErrors.join("; ")}`,
  );
  const result = {
    status: "passed",
    baseURL,
    browser: await browser.version(),
    viewport: "390×844",
    synthetic: true,
    firstHalfAnchor,
    checks,
    savedRecords: events.length,
    finalActiveDurationMs: state.matchActiveMs,
    nativeDeviceEvidence: false,
  };
  await writeFile(
    path.join(outputDirectory, "browser-results.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(JSON.stringify(result, null, 2));
  await context.close();
} catch (error) {
  await writeFile(
    path.join(outputDirectory, "browser-results.json"),
    `${JSON.stringify({ status: "failed", checks, error: String(error), consoleErrors }, null, 2)}\n`,
  );
  throw error;
} finally {
  await browser.close();
}
