// Separate short-lived decoder process. It receives only private local paths,
// never remote URLs. The API enforces process timeout and V8 heap limits.
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { decodeHeic } from './heic-worker.mjs';

sharp.cache({ memory: 16, files: 0, items: 10 });
sharp.concurrency(1);
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({ operation: ['VipsForeignLoadJpegBuffer', 'VipsForeignLoadPngBuffer'] });
let failure = 'MEDIA_PROCESSING_FAILED';
try {
  const [inputPath, displayPath, thumbnailPath, expectedMime, kind = 'photo'] = process.argv.slice(2);
  if (!['photo', 'logo'].includes(kind)) throw new Error();
  let input = readFileSync(inputPath);
  let decodedHeic=null;
  if(expectedMime==='image/heic'){
    try{decodedHeic=await decodeHeic(inputPath,displayPath+'.heic-rgba');}
    catch(error){
      if(error?.code===1&&error?.signal==null&&error?.killed!==true&&typeof error?.stderr==='string'&&error.stderr.trim()==='HEIC_DECODE_REJECTED')failure='IMAGE_DECODE_REJECTED';
      throw error;
    }
  }
  if(decodedHeic)input=decodedHeic.bytes;
  const options = { failOn: 'warning', limitInputPixels: 40_000_000, limitInputChannels: 4, sequentialRead: true, animated: false,
    ...(decodedHeic?{raw:{width:decodedHeic.width,height:decodedHeic.height,channels:4}}:{}) };
  failure = 'IMAGE_DECODE_REJECTED';
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
  failure = 'MEDIA_PROCESSING_FAILED';
  writeFileSync(displayPath, display.data, { flag: 'wx', mode: 0o600 });
  writeFileSync(thumbnailPath, thumbnail, { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify({ width: display.info.width, height: display.info.height }));
} catch(error) {
  // Local filesystem/resource errors are availability failures, never a verdict
  // that supplied image bytes are invalid. Signals/startup failures have no marker.
  if(error&&typeof error==='object'&&typeof error.code==='string')failure='MEDIA_PROCESSING_FAILED';
  process.stderr.write(failure);
  process.exitCode = failure==='IMAGE_DECODE_REJECTED'?1:2;
}
