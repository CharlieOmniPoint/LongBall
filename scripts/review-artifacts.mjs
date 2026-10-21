import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';

// These checks describe the artifacts actually exercised. A source label is supplied
// by the build owner before the run; the helper never infers it from a later HEAD.
export async function captureReviewArtifacts(baseURL, apiEntry) {
  const base = new URL(baseURL);
  assert(!base.username && !base.password && !base.search && !base.hash, 'Review web URL must not contain credentials or query/fragment data.');
  const sourceRevision = process.env.LONGBALL_REVIEW_SOURCE_REVISION ?? null;
  assert(sourceRevision === null || /^[a-f0-9]{40}$/.test(sourceRevision), 'Review source revision must be an explicit full commit hash.');
  const response = await fetch(base, { signal: AbortSignal.timeout(15_000) });
  assert(response.ok, 'Review web entry must be available.');
  const html = await response.text();
  const entry = /src=["']([^"']*\/index-[^"']+\.js)["']/.exec(html)?.[1];
  assert(entry, 'Review web entry must identify its compiled application bundle.');
  const bundleURL = new URL(entry, base);
  assert(bundleURL.origin === base.origin && !bundleURL.search && !bundleURL.hash, 'Review bundle must be a same-origin static artifact.');
  const bundle = await fetch(bundleURL, { signal: AbortSignal.timeout(15_000) });
  assert(bundle.ok, 'Review application bundle must be available.');
  return {
    sourceRevision,
    web: { entry: bundleURL.pathname, sha256: createHash('sha256').update(Buffer.from(await bundle.arrayBuffer())).digest('hex') },
    api: { entry: path.relative(process.cwd(), path.resolve(apiEntry)), sha256: createHash('sha256').update(await readFile(apiEntry)).digest('hex') },
  };
}

export async function assertReviewArtifactsUnchanged(expected, baseURL, apiEntry) {
  assert.deepEqual(await captureReviewArtifacts(baseURL, apiEntry), expected, 'Review artifacts changed during the run; retain diagnostics without claiming a frozen-build pass.');
}

export async function assertReviewApiPortAvailable(api) {
  const url = new URL(api);
  assert(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash, 'Review API must use an explicit uncredentialed loopback HTTP origin and port.');
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', () => reject(new Error('Requested review API port is occupied or unavailable. Preserve the listener and choose another isolated port.')));
    probe.listen({ host: url.hostname, port: Number(url.port), exclusive: true }, () => probe.close(resolve));
  });
}
