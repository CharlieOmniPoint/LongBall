import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, ".local/quality/inventory");
mkdirSync(join(output, "licenses"), { recursive: true });
function command(program, args) {
  const result = spawnSync(program, args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Inventory command failed: ${program} ${args.join(" ")}`);
  return result.stdout;
}
const tree = JSON.parse(command("pnpm", ["list", "--recursive", "--depth", "Infinity", "--json"]));
const sourceCommit = command("git", ["rev-parse", "HEAD"]).trim();
const lockSha256 = createHash("sha256").update(readFileSync(join(root, "pnpm-lock.yaml"))).digest("hex");
const entries = new Map();
function visit(name, entry) {
  let version = entry.version;
  if (version.startsWith("link:")) version = JSON.parse(readFileSync(join(entry.path, "package.json"), "utf8")).version;
  const key = `${name}@${version}`;
  if (!entries.has(key)) {
    entries.set(key, { name, version, resolved: entry.resolved, path: entry.path });
    for (const group of ["dependencies", "devDependencies", "optionalDependencies"])
      for (const [child, dependency] of Object.entries(entry[group] ?? {})) visit(child, dependency);
  }
}
for (const workspace of tree)
  for (const group of ["dependencies", "devDependencies", "optionalDependencies"])
    for (const [name, entry] of Object.entries(workspace[group] ?? {})) visit(name, entry);
const licenses = [], packages = [];
for (const [key, entry] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
  const id = `SPDXRef-Package-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(entry.path, "package.json"), "utf8")); }
  catch { /* Optional packages for other platforms may be resolved but uninstalled. */ }
  const declared = typeof manifest?.license === "string" ? manifest.license : "NOASSERTION";
  const retained = [];
  if (manifest) {
    for (const name of readdirSync(entry.path).sort()) {
      if (!/^(licen[cs]e|copying|copyright|notice)([._-]|$)/i.test(name)) continue;
      const file = join(entry.path, name), info = lstatSync(file);
      if (!info.isFile() || info.size > 4 * 1024 * 1024) continue;
      const bytes = readFileSync(file), target = join("licenses", id, name);
      mkdirSync(dirname(join(output, target)), { recursive: true });
      writeFileSync(join(output, target), bytes);
      retained.push({ file: target, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
    }
  }
  const resolved = typeof entry.resolved === "string" && /^https:\/\//.test(entry.resolved) && !new URL(entry.resolved).username ? entry.resolved : "NOASSERTION";
  licenses.push({ name: entry.name, version: entry.version, declaredLicense: declared, installed: Boolean(manifest), retained });
  packages.push({
    SPDXID: id, name: entry.name, versionInfo: entry.version,
    downloadLocation: resolved, filesAnalyzed: false,
    licenseConcluded: "NOASSERTION", licenseDeclared: "NOASSERTION", copyrightText: "NOASSERTION",
    licenseComments: `Package metadata declares: ${declared}. See retained licence inventory; no legal approval is inferred.`,
    externalRefs: [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: `pkg:npm/${entry.name.startsWith("@") ? `%40${entry.name.slice(1)}` : entry.name}@${encodeURIComponent(entry.version)}` }],
  });
}
const observedAt = new Date().toISOString();
const workingTreeDirty = command("git", ["status", "--porcelain"]).trim().length > 0;
const document = {
  spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", SPDXID: "SPDXRef-DOCUMENT",
  name: `LongBall resolved JavaScript dependency inventory ${sourceCommit}`,
  documentNamespace: `https://github.com/CharlieOmniPoint/LongBall/spdxdocs/${sourceCommit}-${lockSha256}`,
  creationInfo: { created: observedAt.replace(/\.\d{3}Z$/, "Z"), creators: ["Tool: LongBall-quality-inventory-1"] },
  comment: `Resolved pnpm workspace dependency inventory, including development and optional platform packages. Working tree dirty: ${workingTreeDirty}. This is not a native OS/image SBOM, vulnerability result, shipped-artifact attestation or licence approval.`,
  packages,
  relationships: packages.map((entry) => ({ spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: entry.SPDXID })),
};
writeFileSync(join(output, "sbom.spdx.json"), JSON.stringify(document, null, 2) + "\n");
writeFileSync(join(output, "licenses.json"), JSON.stringify({ observedAt, sourceCommit, workingTreeDirty, lockSha256, packages: licenses }, null, 2) + "\n");
writeFileSync(join(output, "summary.json"), JSON.stringify({ observedAt, sourceCommit, workingTreeDirty, lockSha256, packageCount: packages.length, retainedLicenseFiles: licenses.reduce((sum, entry) => sum + entry.retained.length, 0), sbom: "sbom.spdx.json", licenses: "licenses.json", scope: "Resolved JavaScript workspace only; optional uninstalled packages have no retained licence text. Native/image inventories remain separate." }, null, 2) + "\n");
console.log(`Recorded ${packages.length} resolved packages and ${licenses.reduce((sum, entry) => sum + entry.retained.length, 0)} licence files in ${relative(root, output)}.`);
