import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp,readFile,rm,stat,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { afterEach,describe,expect,it,vi } from 'vitest';
import sharp from 'sharp';
import { actualMime,processPrivateImage } from './image-bytes';
const directory=resolve('fixtures/media'),decoder=process.env.LONGBALL_HEIC_DECODER_FILE??'/opt/longball-heic/bin/longball-heic';
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
describe('HEIC original-byte format gate',()=>{
 it('recognizes maintained-encoder HEVC bytes and rejects sequence/AVIF brands and malformed ftyp lengths',async()=>{
  const bytes=await readFile(join(directory,'fictional.heic'));expect(actualMime(bytes)).toBe('image/heic');
  for(const brand of ['hevc','hevx','msf1','avif','avis']){const altered=Buffer.from(bytes);altered.write(brand,8,4,'ascii');expect(actualMime(altered)).toBe(null);}
  const oversized=Buffer.from(bytes);oversized.writeUInt32BE(4097,0);expect(actualMime(oversized)).toBe(null);
 });
});
describe.skipIf(!existsSync(decoder))('actual maintained HEVC native decoder and isolated derivatives',()=>{
 const temporary:string[]=[];afterEach(async()=>{for(const path of temporary.splice(0))await rm(path,{recursive:true,force:true});});
 const process=async(file:string,kind:'photo'|'logo'='photo',verdict:'clean'|'rejected'|'unavailable'='clean')=>{
  const bytes=await readFile(join(directory,file)),path=await mkdtemp(join(tmpdir(),'longball-heic-'));temporary.push(path);const original=join(path,'original.heic'),display=join(path,kind==='photo'?'display.jpg':'display.png'),thumbnail=join(path,kind==='photo'?'thumbnail.jpg':'thumbnail.png');await writeFile(original,bytes,{mode:0o600});
  const scanner={scan:vi.fn(async()=>({verdict,engine:'explicit-test-scanner'}))};
  const work=()=>processPrivateImage({originalPath:original,displayPath:display,thumbnailPath:thumbnail,expectedBytes:bytes.length,expectedSha:hash(bytes),declaredMime:'image/heic',kind,scanner});return{work,scanner,display,thumbnail};
 };
 it('applies actual container orientation and strips EXIF/GPS while producing existing JPEG photos and PNG logos',async()=>{
  for(const kind of ['photo','logo'] as const){const image=await process('fictional.heic',kind);const result=await image.work();expect(result).toMatchObject({width:32,height:64,contentType:kind==='photo'?'image/jpeg':'image/png'});const metadata=await sharp(image.display).metadata();expect(metadata.format).toBe(kind==='photo'?'jpeg':'png');for(const key of ['exif','xmp','icc','orientation'] as const)expect(metadata[key]).toBeUndefined();expect(image.scanner.scan).toHaveBeenCalledTimes(1);await expect(stat(image.display+'.heic-rgba')).rejects.toMatchObject({code:'ENOENT'});}
 });
 it('allows a valid hidden thumbnail while refusing an oversized hidden item and multiple top-level images',async()=>{
  await(await process('with-thumbnail.heic')).work();
  for(const name of ['hidden-oversize.heic','multiple.heic']){const image=await process(name);await expect(image.work()).rejects.toMatchObject({code:'IMAGE_DECODE_REJECTED',status:415});await expect(stat(image.display)).rejects.toMatchObject({code:'ENOENT'});await expect(stat(image.display+'.heic-rgba')).rejects.toMatchObject({code:'ENOENT'});}
 });
 it('requires the original scan verdict before native decoding or any derivative',async()=>{
  for(const [verdict,code] of [['rejected','IMAGE_SCAN_REJECTED'],['unavailable','SCANNER_UNAVAILABLE']] as const){const image=await process('fictional.heic','photo',verdict);await expect(image.work()).rejects.toMatchObject({code});await expect(stat(image.display)).rejects.toMatchObject({code:'ENOENT'});}
 });
});
