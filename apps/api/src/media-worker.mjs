// Separate short-lived decoder process. It receives only private local paths,
// never remote URLs. The API enforces process timeout and V8 heap limits.
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { decodeHeic } from './heic-worker.mjs';

sharp.cache({ memory: 16, files: 0, items: 10 });
sharp.concurrency(1);
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({ operation: ['VipsForeignLoadJpegBuffer', 'VipsForeignLoadPngBuffer'] });
try {
  const [inputPath, displayPath, thumbnailPath, expectedMime, kind = 'photo'] = process.argv.slice(2);
  if (!['photo', 'logo'].includes(kind)) throw new Error();
  let input = readFileSync(inputPath);
  const decodedHeic=expectedMime==='image/heic'?await decodeHeic(inputPath,displayPath+'.heic-rgba'):null;
  if(decodedHeic)input=decodedHeic.bytes;
  const options = { failOn: 'warning', limitInputPixels: 40_000_000, limitInputChannels: 4, sequentialRead: true, animated: false,
    ...(decodedHeic?{raw:{width:decodedHeic.width,height:decodedHeic.height,channels:4}}:{}) };
  const metadata = await sharp(input, options).metadata();
  const expected = decodedHeic?'raw':expectedMime === 'image/jpeg' ? 'jpeg' : 'png';
  if (metadata.format !== expected || !metadata.width || !metadata.height || metadata.width * metadata.height > 40_000_000 || (metadata.pages ?? 1) > 1) throw new Error();
  // Applying orientation precedes metadata stripping. No keepMetadata/withMetadata
  // call is made: sharp removes EXIF/GPS/ICC/comments from both new derivatives.
  const displayPipeline = sharp(input, options).autoOrient().resize({ width: kind === 'logo' ? 1024 : 2048, height: kind === 'logo' ? 1024 : 2048, fit: 'inside', withoutEnlargement: true });
  const display = await (kind === 'logo' ? displayPipeline.png() : displayPipeline.flatten({ background: '#FFFFFF' }).jpeg({ quality: 85, progressive: false })).toBuffer({ resolveWithObject: true });
  const thumbnailPipeline = sharp(display.data, {failOn:'warning',limitInputPixels:40_000_000,limitInputChannels:4,sequentialRead:true,animated:false}).resize({ width: kind === 'logo' ? 256 : 480, height: kind === 'logo' ? 256 : 480, fit: 'inside', withoutEnlargement: true });
  const thumbnail = await (kind === 'logo' ? thumbnailPipeline.png() : thumbnailPipeline.jpeg({ quality: 80, progressive: false })).toBuffer();
  if (display.data.length > 8 * 1024 * 1024 || thumbnail.length > 1024 * 1024) throw new Error();
  writeFileSync(displayPath, display.data, { flag: 'wx', mode: 0o600 });
  writeFileSync(thumbnailPath, thumbnail, { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify({ width: display.info.width, height: display.info.height }));
} catch {
  process.stderr.write('IMAGE_DECODE_REJECTED');
  process.exitCode = 1;
}
