import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { changeWorkspaceContext, enterFictionalReview, openWorkspaceTab, selectWorkspaceContext } from "./review-entry.mjs";

// UI commands exercise the real scan/derivative/publication service. The API calls below are GET only.
const baseURL = process.env.LONGBALL_REVIEW_BASE_URL ?? "http://127.0.0.1:4173";
const api =
  process.env.LONGBALL_BRAND_REVIEW_API_URL ?? "http://127.0.0.1:4349";
const teamId = "synthetic-roma-u10",
  seasonId = "synthetic-season-2026-27";
const runId = new Date().toISOString().replace(/[^0-9]/g, "");
const directory = path.resolve(
  process.env.LONGBALL_BRAND_REVIEW_DIRECTORY ??
    `.local/brand-ui-review/${runId}`,
);
const checks = [],
  pageErrors = [],
  writes = [],
  accountBudgetPauses = [];
let accountWindowStartedAt = null;
let browser, page, context;
await mkdir(directory, { recursive: true });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function poll(read, accepts, label, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (accepts(value)) return value;
    await delay(150);
  } while (Date.now() < deadline);
  assert.fail(label);
}
async function readService(section, role = "manager") {
  const started = Date.now();
  if (accountWindowStartedAt === null || started - accountWindowStartedAt >= 60_000)
    accountWindowStartedAt = started;
  const response = await fetch(
    `${api}/v1/teams/${teamId}/${section}?seasonId=${seasonId}`,
    {
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: "Bearer synthetic-manager-1",
        "X-Longball-Role": role,
        "X-Api-Contract-Version": "longball.events/1.1",
      },
    },
  );
  const body = await response.json();
  assert(
    response.ok,
    `${section} read HTTP${response.status} ${body.code ?? ""}`,
  );
  return body;
}
async function freshAccountWindow(phase) {
  const began = Date.now();
  const until = (accountWindowStartedAt ?? began) + 60_500;
  const evidence = { phase, plannedWaitMs: Math.max(0, until - began), waitedMs: 0, ordinaryLimit: 120, mutationLimit: 60, pendingCommandRetried: false };
  accountBudgetPauses.push(evidence);
  if (evidence.plannedWaitMs) console.log(JSON.stringify({ reviewBudgetPause: phase, waitMs: evidence.plannedWaitMs }));
  // Only pause after accepted publication and completed reads. Never retry,
  // rebase or regenerate a mutation to work around the service's request limit.
  while (Date.now() < until) await delay(Math.min(1000, until - Date.now()));
  evidence.waitedMs = Date.now() - began;
  accountWindowStartedAt = Date.now();
}
const click = (name) => page.getByRole("button", { name, exact: true }).click();
async function settled() {
  await poll(
    // This dual-role context control stays visible outside More and shares the
    // workspace's busy, retained-capability and current-read admission gate.
    () => page.getByTestId("workspace-change-context").isEnabled(),
    Boolean,
    "Service receipt/local refresh must settle",
  );
}
async function picture(label, width = 390) {
  await page.setViewportSize({ width, height: 844 });
  if (label.startsWith("exact-revision")) {
    await page
      .getByText("Review team logo publication", { exact: true })
      .evaluate((element) =>
        element.parentElement.scrollIntoView({
          block: "start",
          inline: "nearest",
        }),
      );
  } else {
    await page
      .getByTestId("brand-logos")
      .evaluate((element) =>
        element.scrollIntoView({ block: "start", inline: "nearest" }),
      );
  }
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    `No horizontal overflow at ${width}px`,
  );
  await page.screenshot({
    path: path.join(directory, `${label}-${width}.png`),
    animations: "disabled",
  });
}
async function assertLoadedBadge(source) {
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const badge = page.getByRole("img", {
      name: `Roma current ${source} badge`,
      exact: true,
    });
    await poll(
      () =>
        badge.evaluate((element) => {
          const images =
            element instanceof HTMLImageElement
              ? [element]
              : Array.from(element.querySelectorAll("img"));
          return images.some(
            (image) =>
              image.complete &&
              image.naturalWidth > 0 &&
              image.src.startsWith("data:image/png;base64,"),
          );
        }),
      Boolean,
      `Current published ${source} badge must display authenticated PNG pixels at ${width}px`,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
}
async function generatedUpload(kind, { gate = false } = {}) {
  const previous = new Set(
    (
      await readService(
        "branding",
        kind === "club_logo" ? "administrator" : "manager",
      )
    ).assets.map((asset) => asset.assetId),
  );
  await page.getByTestId("brand-generated-image").click();
  await page
    .getByRole("switch", {
      name: "Logo upload policy acknowledgement",
      exact: true,
    })
    .check();
  let release,
    held = false;
  const pattern = `**/branding/${kind}/uploads/prepare?*`;
  const route = async (route) => {
    const response = await route.fetch();
    held = true;
    await new Promise((resolve) => {
      release = resolve;
    });
    await route.fulfill({ response });
  };
  if (gate) await page.route(pattern, route, { times: 1 });
  try {
    await page.getByTestId("brand-upload").click();
    if (gate) {
      await poll(
        () => held,
        Boolean,
        "Real prepare response is held after service commit",
      );
      assert.equal(
        await page.getByTestId("workspace-connect").isEnabled(),
        false,
        "Outer reconnect blocked while private upload capability retained",
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Oliver Bennett · Player", exact: true })
          .isEnabled(),
        false,
        "Outer account switch blocked while retained",
      );
      assert.equal(
        await page
          .getByLabel("Workspace API URL", { exact: true })
          .isEditable(),
        false,
        "API destination cannot change while retained",
      );
      release();
      checks.push(
        "Private upload retains original scope and disables outer reconnect/account/API edits",
      );
    }
    await page.getByTestId("workspace-change-context").waitFor();
    await settled();
    const value = await readService(
      "branding",
      kind === "club_logo" ? "administrator" : "manager",
    );
    const assets = value.assets.filter(
      (asset) =>
        asset.kind === kind &&
        asset.status === "processed" &&
        !previous.has(asset.assetId),
    );
    assert(
      assets.length > 0,
      "Actual safety scanner and derivative processing must complete before review",
    );
    const asset = assets.at(-1);
    assert.equal(asset.kind, kind);
    assert.equal(asset.teamId, kind === "club_logo" ? null : teamId);
    assert.equal("seasonId" in asset, false);
    assert.equal("matchId" in asset, false);
    assert(asset.width > 0 && asset.height > 0);
    return { value, asset };
  } finally {
    release?.();
    if (gate) await page.unroute(pattern, route);
  }
}
async function publish(asset, { gateImage = false } = {}) {
  const before = await readService(
    "branding",
    asset.kind === "club_logo" ? "administrator" : "manager",
  );
  let release,
    held = false;
  const pattern = `**/branding/assets/${asset.assetId}/revisions/${asset.revision}/display?*mode=own*`;
  const route = async (route) => {
    const response = await route.fetch();
    assert.equal(
      response.status(),
      200,
      "Authenticated processed derivative exists",
    );
    held = true;
    await new Promise((resolve) => {
      release = resolve;
    });
    await route.fulfill({ response });
  };
  if (gateImage) await page.route(pattern, route, { times: 1 });
  try {
    await page
      .getByTestId(`brand-review-${asset.assetId}-${asset.revision}`)
      .click();
    const confirm = page.getByTestId("brand-confirm"),
      rights = page.getByRole("switch", {
        name: "Logo rights and exact revision reviewed",
        exact: true,
      });
    assert.equal(
      await confirm.isEnabled(),
      false,
      "No implicit rights acknowledgement",
    );
    if (gateImage) {
      await poll(() => held, Boolean, "Own exact revision image response held");
      await rights.check();
      assert.equal(
        await confirm.isEnabled(),
        false,
        "Checking rights cannot bypass exact derivative onLoad",
      );
      await picture("exact-revision-not-yet-loaded");
      release();
    } else await rights.check();
    await poll(
      () => confirm.isEnabled(),
      Boolean,
      "Loaded exact derivative + rights must enable explicit publication",
    );
    await rights.uncheck();
    assert.equal(
      await confirm.isEnabled(),
      false,
      "Rights remain required after image is loaded",
    );
    await rights.check();
    const reviewed = await readService(
      "branding",
      asset.kind === "club_logo" ? "administrator" : "manager",
    );
    assert.equal(
      reviewed[asset.kind === "club_logo" ? "club" : "team"].slotVersion,
      before[asset.kind === "club_logo" ? "club" : "team"].slotVersion,
      "Review has no publication side effect",
    );
    await confirm.click();
    await settled();
    const value = await readService(
      "branding",
      asset.kind === "club_logo" ? "administrator" : "manager",
    );
    const owner = value[asset.kind === "club_logo" ? "club" : "team"];
    assert.equal(
      owner.slotVersion,
      before[asset.kind === "club_logo" ? "club" : "team"].slotVersion + 1,
    );
    assert.equal(owner.logo.assetId, asset.assetId);
    assert.equal(owner.logo.revision, asset.revision);
    return value;
  } finally {
    release?.();
    if (gateImage) await page.unroute(pattern, route);
  }
}
async function settings(role) {
  await changeWorkspaceContext(page, role);
  await settled();
  await openWorkspaceTab(page, "settings");
  await page.getByTestId("brand-logos").waitFor();
  await settled();
}
try {
  const health = await (
    await fetch(`${api}/health`, { signal: AbortSignal.timeout(10_000) })
  ).json();
  assert.equal(
    health.syntheticOnly,
    true,
    "Public fictional identities are restricted to explicit synthetic API",
  );
  const initial = await readService("branding");
  assert.equal(
    initial.effective.source,
    "neutral",
    "Use a fresh isolated fictional API for this bounded proof",
  );
  assert(
    Number.isSafeInteger(initial.club.slotVersion) &&
      initial.club.slotVersion >= 0,
  );
  assert(
    Number.isSafeInteger(initial.team.slotVersion) &&
      initial.team.slotVersion >= 0,
  );
  const preparationBefore = await readService("preparation");
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH ?? "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    hasTouch: true,
    isMobile: true,
  });
  page = await context.newPage();
  page.setDefaultTimeout(45_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (request.method() !== "POST" || !request.url().includes("/branding/"))
      return;
    const body = request.postDataJSON();
    const endpoint = new URL(request.url()).pathname;
    if (body?.command)
      writes.push({
        endpoint,
        type: body.command.type,
        kind: body.command.kind,
        commandId: body.command.id,
        expectedSlotVersion: body.command.expectedSlotVersion,
        assetId: body.command.assetId ?? null,
        reviewedRevision: body.command.reviewedRevision ?? null,
      });
    else if (endpoint.endsWith("/prepare"))
      writes.push({
        endpoint,
        kind: body.kind,
        clubId: body.clubId ?? null,
        teamId: body.teamId ?? null,
        mimeType: body.mimeType,
        byteSize: body.byteSize,
      });
  });
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await enterFictionalReview(page);
  await page.getByTestId("prepare-match").waitFor();
  await click("More");
  await click("Service and controller");
  await page.getByLabel("Workspace API URL", { exact: true }).fill(api);
  await click("Demo API review");
  await click("Alex Morgan · Manager");
  await page.getByTestId("workspace-connect").click();
  await selectWorkspaceContext(page);
  await openWorkspaceTab(page, "schedule");
  await page.getByTestId("preparation-create-event").waitFor();
  await settled();
  await openWorkspaceTab(page, "settings");
  await page.getByTestId("brand-logos").waitFor();
  assert.equal(await page.getByTestId("brand-kind-club_logo").count(), 0);
  assert.equal(await page.getByTestId("brand-kind-team_logo").count(), 1);
  await picture("manager-neutral", 390);
  await picture("manager-neutral", 320);
  await page.setViewportSize({ width: 390, height: 844 });
  const { asset: team } = await generatedUpload("team_logo", { gate: true });
  let value = await readService("branding");
  assert.equal(value.team.logo, null);
  assert.equal(value.effective.source, "neutral");
  value = await publish(team, { gateImage: true });
  assert.equal(value.effective.source, "team");
  await assertLoadedBadge("team");
  checks.push(
    "Manager-only team logo: real private upload + scanner + derivative; no pointer change until exact image load, rights and explicit publication",
  );
  await picture("published-team", 390);
  await settings("administrator");
  value = await readService("branding", "administrator");
  assert.equal(value.canWriteClub, true);
  assert.equal(value.canWriteTeam, false);
  assert.equal(await page.getByTestId("brand-kind-team_logo").count(), 0);
  assert.equal(await page.getByTestId("brand-kind-club_logo").count(), 1);
  const { asset: club } = await generatedUpload("club_logo");
  value = await publish(club);
  assert.equal(value.effective.source, "team");
  assert.equal(value.team.logo.assetId, team.assetId);
  checks.push(
    "Selected administrator publishes only seasonless club logo; existing team override remains effective",
  );
  await freshAccountWindow("after-completed-team-and-club-publication");
  await picture("administrator-club-published-team-kept", 320);
  await page.setViewportSize({ width: 390, height: 844 });
  await settings("manager");
  await page.getByTestId("brand-remove-team_logo").click();
  value = await readService("branding");
  assert.equal(
    value.team.logo.assetId,
    team.assetId,
    "Remove review has no write side effect",
  );
  await page.getByTestId("brand-confirm").click();
  await settled();
  value = await readService("branding");
  assert.equal(value.team.logo, null);
  assert.equal(value.effective.source, "club");
  assert.equal(value.effective.logo.assetId, club.assetId);
  await page
    .getByText("Inherits the current club logo", { exact: true })
    .waitFor();
  await assertLoadedBadge("club");
  checks.push(
    "Current published team and inherited club badges display authenticated PNG pixels at both 390 and 320 pixels",
  );
  checks.push(
    "Explicit team override removal restores the current club asset without deleting either retained asset",
  );
  await picture("restored-club-inheritance", 390);
  await picture("restored-club-inheritance", 320);
  await page.setViewportSize({ width: 390, height: 844 });
  await settings("administrator");
  await page.getByTestId("brand-remove-club_logo").click();
  await page.getByTestId("brand-confirm").click();
  await settled();
  value = await readService("branding", "administrator");
  assert.equal(value.club.logo, null);
  assert.equal(value.effective.source, "neutral");
  assert(
    value.assets.every(
      (asset) => asset.kind === "club_logo" && asset.teamId === null,
    ),
  );
  const preparationAfter = await readService("preparation");
  assert.deepEqual(
    preparationAfter,
    preparationBefore,
    "Logo changes cannot change player profiles, attendance, lineups, fixtures or preparation state",
  );
  checks.push(
    "Club reference removal returns neutral badge; all prior assets retained and preparation/players unchanged",
  );
  await picture("neutral-restored", 390);
  assert.deepEqual(pageErrors, [], "No uncaught browser exceptions");
  const index = await readFile("apps/mobile/dist-web/index.html", "utf8"),
    bundle = index.match(/src="([^"]+\.js)"/)?.[1];
  const bundlePath = bundle
    ? path.join("apps/mobile/dist-web", bundle.replace(/^\//, ""))
    : null;
  const evidence = {
    runId,
    completedAt: new Date().toISOString(),
    status: "passed",
    scope:
      "Uncommitted development candidate browser evidence; no physical device or release-readiness claim",
    baseURL,
    api,
    health,
    viewportWidths: [390, 320],
    initialSlotVersions: {
      club: initial.club.slotVersion,
      team: initial.team.slotVersion,
    },
    finalSlotVersions: {
      club: value.club.slotVersion,
      team: value.team.slotVersion,
    },
    webBundle: bundle,
    webSha256: bundlePath
      ? createHash("sha256")
          .update(await readFile(bundlePath))
          .digest("hex")
      : null,
    apiSnapshotSha256: process.env.LONGBALL_BRAND_REVIEW_API_SHA ?? null,
    checks,
    writes,
    accountBudgetPauses,
    pageErrors,
    nativeTestingPending: [
      "iPhone/Android image picker including original HEIC selection",
      "Native image decode and foreground recovery on physical phones",
    ],
  };
  await writeFile(
    path.join(directory, "evidence.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      status: "passed",
      checks: checks.length,
      directory,
      webBundle: bundle,
    }),
  );
} catch (error) {
  if (page)
    await page
      .screenshot({
        path: path.join(directory, "failed.png"),
        animations: "disabled",
      })
      .catch(() => {});
  await writeFile(
    path.join(directory, "failure.json"),
    JSON.stringify(
      {
        runId,
        status: "failed",
        message: error.message,
        checks,
        writes,
        accountBudgetPauses,
        pageErrors,
        visibleText: page
          ? await page
              .locator("body")
              .innerText()
              .catch(() => null)
          : null,
      },
      null,
      2,
    ) + "\n",
  );
  throw error;
} finally {
  await context?.close();
  await browser?.close();
}
