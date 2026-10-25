import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = join(root, ".local/quality"), tools = join(directory, "bin");
mkdirSync(tools, { recursive: true });
if (process.platform !== "linux" || process.arch !== "x64") throw new Error("This pinned scanner runner targets Linux x64; use the CI workflow on other systems.");
const version = "8.24.3", archiveSha = "9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c";
const binary = join(tools, "gitleaks"), binarySha = "e18325d568268b6efb6cd0cc721f8bea5667f4cd1c8d03618ab61987f41269ad";
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
function command(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000, ...options });
  if (result.error || result.status !== 0) throw new Error(`Required scanner command failed: ${program}`);
  return result.stdout;
}
if (!existsSync(binary) || hash(binary) !== binarySha) {
  const archive = join(tools, `gitleaks-${version}.tar.gz`);
  command("curl", ["--fail", "--silent", "--show-error", "--location", `https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_linux_x64.tar.gz`, "--output", archive]);
  if (hash(archive) !== archiveSha) throw new Error("Pinned gitleaks archive checksum mismatch.");
  command("tar", ["-xzf", archive, "-C", tools, "gitleaks"]);
  if (hash(binary) !== binarySha) throw new Error("Pinned gitleaks executable checksum mismatch.");
}
const temporary = mkdtempSync(join(tmpdir(), "longball-secret-scan-"));
const snapshot = join(temporary, "source"), rawReport = join(temporary, "report.json");
mkdirSync(snapshot);
const paths = command("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
const reviewed = JSON.parse(readFileSync(join(root, "infra/ci/secret-scan-reviewed.json"), "utf8"));
if (reviewed.version !== 1 || !Array.isArray(reviewed.entries)) throw new Error("Reviewed secret-scan metadata is invalid.");
let scannedFiles = 0;
const sourceTreeHash = createHash("sha256");
const skippedSymlinks = [];
try {
  for (const path of [...new Set(paths)].sort()) {
    const source = resolve(root, path);
    if (!source.startsWith(root + sep)) throw new Error("Scanner source escaped repository.");
    if (!existsSync(source)) continue; // Deleted worktree files are not shipped.
    if (lstatSync(source).isSymbolicLink()) { skippedSymlinks.push(path); continue; }
    const target = join(snapshot, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    sourceTreeHash.update(path + "\0" + hash(source) + "\n");
    scannedFiles++;
  }
  const result = spawnSync(binary, ["dir", snapshot, "--no-banner", "--redact=100", "--ignore-gitleaks-allow", "--report-format", "json", "--report-path", rawReport], { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 120_000 });
  const findings = existsSync(rawReport) ? JSON.parse(readFileSync(rawReport, "utf8")) : null;
  const valid = !result.error && Array.isArray(findings) && [0, 1].includes(result.status);
  // Persist only an allowlist of finding metadata. Never publish matched bytes,
  // even if a future scanner changes its redaction/report implementation.
  const safeFindings = Array.isArray(findings) ? findings.map((entry) => ({ ruleId: entry.RuleID, description: entry.Description, file: String(entry.File).replace(snapshot + sep, ""), startLine: entry.StartLine, endLine: entry.EndLine })) : [];
  const unexpected = [], accepted = [];
  for (const finding of safeFindings) {
    const lines = readFileSync(join(snapshot, finding.file), "utf8").split(/\r?\n/).slice(finding.startLine - 1, finding.endLine).join("\n");
    const lineDigest = createHash("sha256").update(lines).digest("hex");
    const approved = reviewed.entries.find((entry) => entry.ruleId === finding.ruleId && entry.file === finding.file && entry.startLine === finding.startLine && entry.endLine === finding.endLine && entry.lineDigest === lineDigest);
    if (approved) accepted.push({ ...finding, reason: approved.reason });
    else unexpected.push(finding);
  }
  const passed = valid && unexpected.length === 0 && skippedSymlinks.length === 0;
  writeFileSync(join(directory, "secrets.json"), JSON.stringify({ observedAt: new Date().toISOString(), sourceCommit: command("git", ["rev-parse", "HEAD"]).trim(), workingTreeDirty: command("git", ["status", "--porcelain"]).trim().length > 0, sourceTreeSha256: sourceTreeHash.digest("hex"), scanner: `gitleaks ${version}`, archiveSha256: archiveSha, executableSha256: binarySha, scope: "Current tracked and nonignored untracked repository files; history is not scanned. Built-in rules; no inline allow comments honored. Only exact reviewed source-line false positives accepted.", scannedFiles, skippedSymlinks, passed, executionValid: valid, rawFindingCount: safeFindings.length, reviewedFalsePositives: accepted, findings: unexpected }, null, 2) + "\n");
  console.log(`Secret scan: ${passed ? "passed" : "failed"}; ${scannedFiles} files, ${unexpected.length} unexpected findings and ${accepted.length} exact reviewed false positives. Safe metadata: .local/quality/secrets.json.`);
  if (!passed) process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
