import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, ".local/quality/dependencies");
mkdirSync(output, { recursive: true });
const sourceCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
const workingTreeDirty = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.trim().length > 0;
let failed = false;
for (const [name, cwd, program, args] of [
  ["workspace", root, "pnpm", ["audit", "--json", "--audit-level", "high"]],
  ["runtime", join(root, "infra/runtime/backend"), "npm", ["audit", "--package-lock-only", "--json", "--audit-level", "high"]],
  ["compiler", join(root, "infra/runtime/compiler"), "npm", ["audit", "--package-lock-only", "--json", "--audit-level", "high"]],
]) {
  const result = spawnSync(program, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
  let report;
  try { report = JSON.parse(result.stdout || "{}"); }
  catch { report = { error: "The registry audit did not return a JSON report." }; }
  const passed = result.status === 0 && !result.error && !report.error;
  const lock = name === "workspace" ? join(root, "pnpm-lock.yaml") : join(cwd, "package-lock.json");
  const lockSha256 = createHash("sha256").update(readFileSync(lock)).digest("hex");
  writeFileSync(join(output, `${name}.json`), JSON.stringify({ observedAt: new Date().toISOString(), sourceCommit, workingTreeDirty, lockSha256, passed, exitCode: result.status, report }, null, 2) + "\n");
  console.log(`${name}: ${passed ? "passed" : "failed or unavailable"} (high/critical gate; complete report retained).`);
  if (!passed) failed = true;
}
if (failed) process.exit(1);
