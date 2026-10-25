// Executes through stdin inside the exact production image, as its node user.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { connect } from "node:net";

const require = createRequire(resolve("package.json"));
const sharp = require("sharp");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(process.getuid(), 1000, "Image checks must run as the unprivileged node user.");
const health = await fetch("http://127.0.0.1:4310/health");
assert.equal(health.status, 200);
const privateResponse = await fetch("http://127.0.0.1:4310/v1/me");
assert.equal(privateResponse.status, 503, "An unconfigured identity verifier must keep private routes unavailable.");
const privateError = await privateResponse.json();
assert.equal(privateError.code, "IDENTITY_NOT_CONFIGURED");
assert.deepEqual(Object.keys(privateError).sort(), ["code", "message", "requestId", "retryable"]);
assert.equal(typeof privateError.message, "string");
assert.equal(typeof privateError.requestId, "string");
assert.equal(typeof privateError.retryable, "boolean");

const reportPdfResult = await promisify(execFile)(process.execPath,
  ["--max-old-space-size=128", "/app/backend/report-pdf-probe.mjs"],
  { timeout: 15_000, maxBuffer: 8192 });
const reportPdf = JSON.parse(reportPdfResult.stdout);
assert.equal(reportPdf.passed, true);
assert.equal(reportPdf.pages, 1);
assert.ok(reportPdf.bytes > 0 && reportPdf.bytes <= 5 * 1024 * 1024);
assert.equal(reportPdf.magic, "%PDF-1.7");
assert.equal(reportPdf.embeddedFont, true);
assert.equal(reportPdf.unicodeReadable, true);
assert.equal(reportPdf.unknownAndZeroDistinct, true);

async function scan(bytes) {
  return new Promise((yes, no) => {
    const socket = connect(3310, "scanner"), chunks = [];
    socket.setTimeout(15_000, () => socket.destroy(new Error("Image scanner probe timed out.")));
    socket.on("error", no);
    socket.on("data", (bytes) => chunks.push(bytes));
    socket.on("end", () => yes(Buffer.concat(chunks).toString("utf8")));
    socket.on("connect", () => {
      const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
      socket.end(Buffer.concat([Buffer.from("zINSTREAM\0"), size, bytes, Buffer.alloc(4)]));
    });
  });
}
const original = await readFile("/run/longball-image-fixture.heic");
assert.match(await scan(original), /: OK\x00?$/);
const eicar = Buffer.from("WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=", "base64");
assert.match(await scan(eicar), /FOUND\x00?$/);
const directory = await mkdtemp("/tmp/longball-image-heic-");
let decoder;
try {
  const display = join(directory, "display.jpg"), thumbnail = join(directory, "thumb.jpg");
  const result = await promisify(execFile)(process.execPath, ["--max-old-space-size=64", "/app/backend/media-worker.mjs", "/run/longball-image-fixture.heic", display, thumbnail, "image/heic"], { timeout: 15_000, maxBuffer: 8192 });
  const bytes = await readFile(display), metadata = await sharp(bytes).metadata(), thumb = await sharp(await readFile(thumbnail)).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, 32); assert.equal(metadata.height, 64);
  for (const key of ["exif", "icc", "xmp", "orientation"]) {
    assert.equal(metadata[key], undefined); assert.equal(thumb[key], undefined);
  }
  decoder = { originalSha256: sha(original), displaySha256: sha(bytes), dimensions: [metadata.width, metadata.height], worker: JSON.parse(result.stdout), orientationAppliedOnce: true, metadataStripped: true };
} finally { await rm(directory, { recursive: true, force: true }); }
console.log(JSON.stringify({ passed: true, observedAt: new Date().toISOString(), uid: process.getuid(), healthStatus: health.status, unconfiguredPrivateStatus: privateResponse.status, actualScannerCleanAndEicar: true, decoder, reportPdf, apiSha256: sha(await readFile("/app/backend/api.mjs")), workerSha256: sha(await readFile("/app/backend/worker.mjs")), reportPdfProbeSha256: sha(await readFile("/app/backend/report-pdf-probe.mjs")), sharp: sharp.versions.sharp, limitations: ["Isolated image/runtime/decoder/PDF proof only. No identity provider, production hosting, actual push, physical device, operational signature-update SLA or paired restore was exercised in this check."] }));
