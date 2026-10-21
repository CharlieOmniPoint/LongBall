// Bounded readiness proof before advertising the fictional upload review.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createConnection } from 'node:net';
import { execFileSync } from 'node:child_process';
const host=process.env.LONGBALL_CLAMD_HOST??'127.0.0.1',port=Number(process.env.LONGBALL_CLAMD_PORT??53310);
function exchange(command,bytes){return new Promise((resolve,reject)=>{const socket=createConnection({host,port});let result='';socket.setTimeout(5000,()=>socket.destroy(new Error('Scanner readiness timed out.')));socket.on('error',reject);socket.on('data',chunk=>{result+=chunk.toString('utf8');if(result.length>16384)socket.destroy(new Error('Scanner reply exceeds readiness bound.'));if(result.includes('\0')){socket.end();resolve(result.replace(/\0.*$/s,'').trim());}});socket.on('end',()=>resolve(result.trim()));socket.on('connect',()=>{socket.write(`z${command}\0`);if(bytes){const length=Buffer.alloc(4);length.writeUInt32BE(bytes.length);socket.write(length);socket.write(bytes);socket.write(Buffer.alloc(4));}});});}
assert.equal(await exchange('PING'),'PONG');
const version=await exchange('VERSION'),match=/^ClamAV ([\w.+-]+)\/(\d+)\/(.+)$/.exec(version);assert(match,'Unverified scanner identity.');const databaseAt=Date.parse(match[3]);assert(Number.isFinite(databaseAt)&&databaseAt<=Date.now()+300000&&databaseAt>=Date.now()-7*86400000,'Scanner signature database must be within seven days.');
assert.equal(await exchange('INSTREAM',Buffer.from('Fictional LongBall review readiness; no people.')),'stream: OK');
const eicar=Buffer.from('WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=','base64');
// Standard harmless antivirus probe; never sent to the public app.
assert.match(await exchange('INSTREAM',eicar),/^stream: .+ FOUND$/);
const decoder=execFileSync(process.env.LONGBALL_HEIC_DECODER_FILE,['--version'],{encoding:'utf8',timeout:10000,env:{PATH:'/usr/bin:/bin',LANG:'C'}}).trim();assert.equal(decoder,'libheif:1.23.6/libde265');
console.log(JSON.stringify({status:'passed',scanner:match[1],database:match[2],databaseAt:new Date(databaseAt).toISOString(),decoder,cleanAndStandardAntivirusProbe:true}));
