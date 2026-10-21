import { createHash } from 'node:crypto';
import { access, open, readFile, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { executeImageDecoder, imageProcessRejected } from './image-process';
import { AccessError } from '../../../packages/application/src/access';
import { originalImageMime } from '../../../packages/application/src/image-formats';

export const MEDIA_LIMITS = { maxBytes: 15 * 1024 * 1024, maxPixels: 40_000_000, displayEdge: 2048, thumbnailEdge: 480,
  uploadWindowMs: 15 * 60_000, uploadTimeoutMs: 60_000, decodeTimeoutMs: 12_000, scannerTimeoutMs: 20_000 } as const;
export interface MediaScanner {
  scan(bytes: Buffer, context: { mimeType: string; sha256: string }): Promise<{ verdict: 'clean' | 'rejected' | 'unavailable'; engine: string }>;
}
function fail(code:string,status:number,message:string):never{throw new AccessError(code,status,message);}
export async function bounded<T>(promise:Promise<T>,milliseconds:number,code:string):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new AccessError(code,503,'Media processing is unavailable. The private upload is retained for a safe retry.')),Math.max(1,milliseconds));})]);}
  finally{if(timer)clearTimeout(timer);}
}
export function actualMime(bytes:Buffer):'image/jpeg'|'image/png'|'image/heic'|null{
  if(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return'image/png';
  if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return'image/jpeg';
  try{return originalImageMime(bytes)==='image/heic'?'image/heic':null;}catch{return null;}
}
export function rejectAnimatedPng(bytes:Buffer):void{
  if(actualMime(bytes)!=='image/png')return;
  let offset=8;
  while(offset+12<=bytes.length){
    const length=bytes.readUInt32BE(offset);
    if(length>bytes.length-offset-12)fail('INVALID_IMAGE',415,'The image is incomplete or unsupported.');
    const kind=bytes.toString('ascii',offset+4,offset+8);
    if(kind==='acTL')fail('ANIMATED_IMAGE_UNSUPPORTED',415,'Animated images are not supported.');
    offset+=length+12;if(kind==='IEND')break;
  }
}

/** Shared bounded byte receiver. Paths are private, server-generated repository paths. */
export async function receivePrivateImage(input:{source:AsyncIterable<Uint8Array>;expectedBytes:number;expectedSha:string;temporaryPath?:string;destinationPath?:string}):Promise<number>{
  const destination=input.temporaryPath?await open(input.temporaryPath,'wx',0o600):null;
  const digest=createHash('sha256'),began=performance.now(),iterator=input.source[Symbol.asyncIterator]();let received=0;
  try{
    while(true){
      const item=await bounded(iterator.next(),MEDIA_LIMITS.uploadTimeoutMs-(performance.now()-began),'UPLOAD_TIMEOUT');if(item.done)break;
      const chunk=Buffer.from(item.value);received+=chunk.length;
      if(received>input.expectedBytes||received>MEDIA_LIMITS.maxBytes)fail('UPLOAD_TOO_LARGE',413,'The image exceeds its declared upload size.');
      digest.update(chunk);if(destination)await destination.writeFile(chunk);
    }
    if(received!==input.expectedBytes||digest.digest('hex')!==input.expectedSha)fail('UPLOAD_INTEGRITY_FAILED',422,'The uploaded size or SHA-256 does not match. The private partial upload was not accepted.');
    if(destination){await destination.sync();await destination.close();await rename(input.temporaryPath!,input.destinationPath!);}
    return received;
  }catch(error){
    if(destination){await destination.close().catch(()=>undefined);await unlink(input.temporaryPath!).catch(()=>undefined);}
    if(iterator.return)void Promise.resolve(iterator.return()).catch(()=>undefined);
    throw error;
  }
}

/** Malware scan and bounded isolated decoder, shared by game photos and supplied logos. */
export async function processPrivateImage(input:{originalPath:string;displayPath:string;thumbnailPath:string;expectedBytes:number;expectedSha:string;declaredMime:string;scanner?:MediaScanner;kind?:'photo'|'logo'}):Promise<{width:number;height:number;scannerEngine:string;contentType:'image/jpeg'|'image/png'}>{
  const original=await readFile(input.originalPath);
  if(original.length!==input.expectedBytes||createHash('sha256').update(original).digest('hex')!==input.expectedSha)fail('UPLOAD_INTEGRITY_FAILED',422,'The private original does not match its recorded size and hash.');
  const mimeType=actualMime(original);
  if(!mimeType||mimeType!==input.declaredMime)fail('MEDIA_TYPE_MISMATCH',415,'The image type must match its original JPEG, PNG or supported still HEIC bytes.');
  rejectAnimatedPng(original);
  if(!input.scanner)fail('SCANNER_REQUIRED',503,'Image safety scanning is not configured. The original remains private; no reviewable or published image was created.');
  const scan=await bounded(input.scanner.scan(original,{mimeType,sha256:input.expectedSha}),MEDIA_LIMITS.scannerTimeoutMs,'SCANNER_UNAVAILABLE');
  if(scan.verdict==='unavailable')fail('SCANNER_UNAVAILABLE',503,'Image scanning is unavailable. The original remains private for a safe retry.');
  if(scan.verdict!=='clean')fail('IMAGE_SCAN_REJECTED',422,'The image did not pass safety scanning and remains unpublished.');
  if(mimeType==='image/heic'){
    const decoder=process.env.LONGBALL_HEIC_DECODER_FILE??'/opt/longball-heic/bin/longball-heic';
    if(!isAbsolute(decoder)||decoder.length>4096)fail('HEIC_DECODER_REQUIRED',503,'The private HEIC decoder is not configured. The original remains private for retry.');
    try{await access(decoder,constants.X_OK);}catch{fail('HEIC_DECODER_REQUIRED',503,'The private HEIC decoder is unavailable. The original remains private for retry.');}
  }
  let decoded:{width:number;height:number};
  try{
    const result=await executeImageDecoder(['--max-old-space-size=128',fileURLToPath(new URL('./media-worker.mjs',import.meta.url)),input.originalPath,input.displayPath,input.thumbnailPath,mimeType,input.kind??'photo'],MEDIA_LIMITS.decodeTimeoutMs);
    decoded=JSON.parse(result.stdout) as {width:number;height:number};
    const edge=input.kind==='logo'?1024:MEDIA_LIMITS.displayEdge;
    if(!Number.isSafeInteger(decoded.width)||!Number.isSafeInteger(decoded.height)||decoded.width<1||decoded.height<1||decoded.width>edge||decoded.height>edge)throw new Error();
  }catch(error){
    if(imageProcessRejected(error))fail('IMAGE_DECODE_REJECTED',415,'The image was rejected by the supported format, pixel and content checks.');
    fail('MEDIA_PROCESSING_FAILED',503,'The bounded image processor is unavailable. The private upload is retained for a safe retry; no image was published.');
  }
  finally{if(mimeType==='image/heic')await unlink(input.displayPath+'.heic-rgba').catch(()=>undefined);}
  return{...decoded,scannerEngine:scan.engine.slice(0,100),contentType:input.kind==='logo'?'image/png':'image/jpeg'};
}
