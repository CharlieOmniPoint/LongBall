// Separate short-lived decoder process. It receives only private local paths,
// never remote URLs. The API enforces process timeout and V8 heap limits.
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

sharp.cache({ memory: 16, files: 0, items: 10 });
sharp.concurrency(1);
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({ operation: ['VipsForeignLoadJpegBuffer', 'VipsForeignLoadPngBuffer'] });
try {
  const [inputPath, displayPath, thumbnailPath, expectedMime] = process.argv.slice(2);
  const input = readFileSync(inputPath);
  const options = { failOn: 'warning', limitInputPixels: 40_000_000, limitInputChannels: 4, sequentialRead: true, animated: false };
  const metadata = await sharp(input, options).metadata();
  const expected = expectedMime === 'image/jpeg' ? 'jpeg' : 'png';
  if (metadata.format !== expected || !metadata.width || !metadata.height || metadata.width * metadata.height > 40_000_000 || (metadata.pages ?? 1) > 1) throw new Error();
  // Applying orientation precedes metadata stripping. No keepMetadata/withMetadata
  // call is made: sharp removes EXIF/GPS/ICC/comments from both new derivatives.
  const display = await sharp(input, options).autoOrient().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#FFFFFF' }).jpeg({ quality: 85, progressive: false }).toBuffer({ resolveWithObject: true });
  const thumbnail = await sharp(display.data, options).resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80, progressive: false }).toBuffer();
  if (display.data.length > 8 * 1024 * 1024 || thumbnail.length > 1024 * 1024) throw new Error();
  writeFileSync(displayPath, display.data, { flag: 'wx', mode: 0o600 });
  writeFileSync(thumbnailPath, thumbnail, { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify({ width: display.info.width, height: display.info.height }));
} catch {
  process.stderr.write('IMAGE_DECODE_REJECTED');
  process.exitCode = 1;
}
