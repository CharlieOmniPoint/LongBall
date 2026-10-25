import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { enterFictionalReview } from "./review-entry.mjs";

const baseURL =
  process.env.LONGBALL_PAGES_REVIEW_URL ?? "http://127.0.0.1:4176/LongBall/";
const directory = path.resolve(".local/pages-review-proof");
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.LONGBALL_CHROMIUM_PATH ??
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  reducedMotion: "reduce",
});
const errors = [],
  failures = [];
page.setDefaultTimeout(20_000);
page.on("pageerror", (error) => errors.push(error.message));
page.on("response", (response) => {
  if (response.status() >= 400)
    failures.push({ url: response.url(), status: response.status() });
});
try {
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await enterFictionalReview(page);
  await page.getByTestId("prepare-match").click();
  await page.getByTestId("check-in-all").click();
  await page.getByTestId("continue-lineup").click();
  await page.getByTestId("place-seven").click();
  await page.getByTestId("start-half").click();
  await page.getByTestId("pause-resume").click();
  assert.equal(
    await page.getByTestId("pause-resume").innerText(),
    "Resume clock",
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
  const script = await page.locator("script[src]").getAttribute("src");
  assert(script?.startsWith(new URL(baseURL).pathname));
  await page.screenshot({
    path: path.join(directory, "phone-paused.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Back to team; clock continues", exact: true }).click();
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: "Service and controller", exact: true }).click();
  const apiInput = page.getByLabel("Workspace API URL", { exact: true });
  assert.equal(await apiInput.inputValue(), "", "Static review must not suggest its host is an API.");
  await page.getByRole("button", { name: "Demo API review", exact: true }).click();
  for (const address of ["", "/", new URL(baseURL).origin]) {
    await apiInput.fill(address);
    await page.getByTestId("workspace-connect").click();
    const message = address.startsWith("http")
      ? "This address is the static review host, which has no API. Use the separately supplied service address or temporary full-API review link."
      : "This static review link has no connected API. Paste the separate absolute HTTP(S) service address.";
    await page.getByText(message, { exact: true }).waitFor();
    assert.equal(await page.getByTestId("workspace-session").count(), 0);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, [], "Invalid static API addresses must be rejected before network requests.");
  await page.screenshot({ path: path.join(directory, "separate-api-required.png"), fullPage: true });
  const report = {
    status: "passed",
    checkedAt: new Date().toISOString(),
    baseURL,
    script,
    viewport: "390×844",
    synthetic: true,
    checks: [
      "Subpath HTML and JavaScript load without failed responses",
      "Actual check-in → starting lineup → start → pause",
      "Static workspace starts without an API and rejects blank, relative and same-host addresses before network access",
      "No horizontal overflow or browser exceptions",
    ],
    hostedDeploymentProved: !new URL(baseURL).hostname.match(
      /^(127\.0\.0\.1|localhost)$/,
    ),
    nativeDeviceEvidence: false,
  };
  await writeFile(
    path.join(directory, "summary.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page
    .screenshot({
      path: path.join(directory, "failed.png"),
      animations: "disabled",
    })
    .catch(() => {});
  throw error;
} finally {
  await browser.close();
}
