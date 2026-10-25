// Only the maintained native helper parses HEIC. Sharp receives bounded decoded RGBA.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile,stat,unlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
const execute=promisify(execFile);
export async function decodeHeic(inputPath,rawPath){
 const decoder=process.env.LONGBALL_HEIC_DECODER_FILE??'/opt/longball-heic/bin/longball-heic';
 if(!isAbsolute(decoder)||decoder.length>4096)throw new Error('HEIC_DECODER_REQUIRED');
 try{
  const result=await execute(decoder,[inputPath,rawPath],{timeout:9000,killSignal:'SIGKILL',maxBuffer:16384,windowsHide:true,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'}});
  const metadata=JSON.parse(result.stdout);
  if(!Number.isSafeInteger(metadata.width)||!Number.isSafeInteger(metadata.height)||metadata.width<1||metadata.height<1||metadata.width*metadata.height>40_000_000||metadata.channels!==4)throw new Error();
  const length=metadata.width*metadata.height*4,info=await stat(rawPath);if(!info.isFile()||info.size!==length)throw new Error();
  const bytes=await readFile(rawPath);if(bytes.length!==length)throw new Error();
  return{bytes,width:metadata.width,height:metadata.height,decoder:metadata.decoder};
 }finally{await unlink(rawPath).catch(()=>undefined);}
}
