import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';

const sharp = createRequire(resolve('package.json'))('sharp');
const directory = await mkdtemp('/tmp/longball-decoder-proof-');
try {
  const input = join(directory, 'input.jpg'), display = join(directory, 'display.jpg'), thumbnail = join(directory, 'thumb.jpg');
  const bytes = await sharp({ create: { width: 32, height: 16, channels: 3, background: '#176B45' } })
    .withMetadata({ orientation: 6 }).withExif({ IFD0: { Artist: 'FICTIONAL_RUNTIME_PROOF' } }).jpeg().toBuffer();
  await writeFile(input, bytes, { mode: 0o600 });
  const result = await promisify(execFile)(process.execPath, ['--max-old-space-size=64', '/app/backend/media-worker.mjs', input, display, thumbnail, 'image/jpeg'], { timeout: 15_000, maxBuffer: 8192 });
  const metadata = await sharp(await readFile(display)).metadata(), thumb = await sharp(await readFile(thumbnail)).metadata();
  if (metadata.width !== 16 || metadata.height !== 32 || metadata.exif || metadata.icc || metadata.orientation || thumb.exif || thumb.icc) throw new Error('Runtime derivative assertion failed.');
  console.log(JSON.stringify({ runtime: 'production-image', user: 'node', sharp: sharp.versions.sharp, isolatedWorkerExecuted: true, dimensions: [metadata.width, metadata.height], metadataStripped: true, workerResult: JSON.parse(result.stdout) }));
} finally { await rm(directory, { recursive: true, force: true }); }
