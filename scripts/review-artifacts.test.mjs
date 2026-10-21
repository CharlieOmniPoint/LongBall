import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureReviewArtifacts, assertReviewArtifactsUnchanged, assertReviewApiPortAvailable } from './review-artifacts.mjs';

test('frozen artifact evidence hashes served bytes and detects a changed bundle', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'longball-review-artifacts-'));
  const apiEntry = path.join(directory, 'api.mjs');
  await writeFile(apiEntry, 'fictional-api-artifact');
  let bytes = 'fictional-web-artifact';
  const server = createServer((request, response) => response.end(request.url === '/' ? '<script src="/_expo/static/js/web/index-example.js"></script>' : bytes));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const initial = await captureReviewArtifacts(origin, apiEntry);
    assert.equal(initial.web.sha256, createHash('sha256').update(bytes).digest('hex'));
    await assertReviewArtifactsUnchanged(initial, origin, apiEntry);
    bytes = 'changed-web-artifact';
    await assert.rejects(assertReviewArtifactsUnchanged(initial, origin, apiEntry), /artifacts changed/);
    bytes = 'fictional-web-artifact';
    await writeFile(apiEntry, 'changed-api-artifact');
    await assert.rejects(assertReviewArtifactsUnchanged(initial, origin, apiEntry), /artifacts changed/);
    await assert.rejects(assertReviewApiPortAvailable(origin), /occupied or unavailable/);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
});

test('API guard rejects non-loopback, credentials, and relative paths without exposing values', async () => {
  for (const url of ['https://example.com:4399', 'http://private:secret@127.0.0.1:4399', 'http://127.0.0.1:4399/v1']) {
    await assert.rejects(assertReviewApiPortAvailable(url), /explicit uncredentialed loopback/);
  }
});
