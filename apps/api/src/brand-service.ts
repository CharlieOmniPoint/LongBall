import { randomBytes,randomUUID,createHash,timingSafeEqual } from 'node:crypto';
import { chmodSync,mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve,join,sep } from 'node:path';
import { AccessError,type Principal } from '../../../packages/application/src/access';
import { assertBrandAuthority,assertLogoPrepareScope,authorizeBrandAsset,brandingView,emptyBrandSlot,parseBrandingCommand,parseLogoPrepareInput,planBrandingCommand,type BrandAssetRecord,type BrandKind,type BrandReference,type BrandSlot,type BrandingDto } from '../../../packages/application/src/branding';
import { MEDIA_LIMITS,processPrivateImage,receivePrivateImage,type MediaScanner } from './image-bytes';
import type { BrandAssetRow,BrandRepository,BrandingAuthority } from './brand-repository';

export interface BrandSession {principal:Principal;teamId:string;seasonId:string;role?:string}
export interface PreparedLogoUpload {kind:'prepared-logo-upload';uploadId:string;asset:BrandReference;uploadToken:string;expiresAtMs:number;maxBytes:number}
export interface ProcessedLogoUpload {kind:'processed-logo-upload';uploadId:string;asset:BrandReference;status:'processed';width:number;height:number}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,150}$/.test(value);
function unavailable():never{throw new AccessError('NOT_FOUND',404,'The requested branding is unavailable.');}
function fail(code:string,status:number,message:string):never{throw new AccessError(code,status,message);}
const reference=(row:BrandAssetRow):BrandReference=>({assetId:row.asset_id,revision:row.revision,kind:row.kind,clubId:row.club_id,teamId:row.team_id});
const sameScope=(authority:BrandingAuthority,row:BrandAssetRow)=>row.club_id===authority.context.clubId&&row.team_id===(row.kind==='club_logo'?null:authority.context.teamId);

/** Supplied logos use private scanned bytes and explicit publication, independently of game albums. */
export class BrandMediaService {
  readonly directory:string;
  readonly now:()=>number;
  constructor(readonly options:{repository:BrandRepository;directory:string;load:(session:BrandSession)=>Promise<BrandingAuthority>;audit:(principal:Principal,action:string,objectId:string,outcome:string)=>Promise<void>;scanner?:MediaScanner;now?:()=>number}){
    this.directory=resolve(options.directory,'branding');this.now=options.now??Date.now;
    for(const directory of [this.directory,join(this.directory,'quarantine'),join(this.directory,'derivatives')]){mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);}
  }
  private path(key:string):string{const path=resolve(this.directory,key);if(!path.startsWith(this.directory+sep))throw new Error('PRIVATE_BRANDING_PATH_INVALID');return path;}
  private async slot(authority:BrandingAuthority,kind:BrandKind):Promise<BrandSlot>{return await this.options.repository.slot(kind,authority.context.clubId,kind==='club_logo'?null:authority.context.teamId)??emptyBrandSlot(authority.context,kind);}
  private record(row:BrandAssetRow,slot?:BrandSlot):BrandAssetRecord{
    const published=slot?.assetId===row.asset_id&&slot.assetRevision===row.revision&&slot.reviewedRevision===row.revision;
    const status=row.status==='linked'?(published?'published':'processed'):row.status==='uploading'?'prepared':row.status;
    return{...reference(row),ownerId:row.owner_id,status,byteSize:row.expected_bytes,width:row.width,height:row.height,createdAt:row.created_at,processedAt:row.processed_at,scannerClean:['processed','linked'].includes(row.status)&&Boolean(row.scanner_engine)&&row.processed_at!==null&&row.width!==null&&row.height!==null};
  }
  private async view(authority:BrandingAuthority):Promise<BrandingDto>{
    const clubSlot=await this.slot(authority,'club_logo'),teamSlot=await this.slot(authority,'team_logo');
    const rows=await this.options.repository.own(authority.context.principal.accountId,authority.context.clubId,authority.context.teamId);
    return brandingView({...authority,clubSlot,teamSlot,assets:rows.map(row=>this.record(row,row.kind==='club_logo'?clubSlot:teamSlot))});
  }
  async get(session:BrandSession):Promise<BrandingDto>{return this.view(await this.options.load(session));}
  private async row(session:BrandSession,uploadId:string,token?:string):Promise<{row:BrandAssetRow;authority:BrandingAuthority}>{
    if(!id(uploadId))unavailable();const authority=await this.options.load(session),row=await this.options.repository.upload(uploadId);
    if(!row||row.owner_id!==authority.context.principal.accountId||!sameScope(authority,row))unavailable();
    assertBrandAuthority(authority.context,row.kind);
    if(token!==undefined&&(typeof token!=='string'||token.length>256||!timingSafeEqual(Buffer.from(row.token_hash,'hex'),Buffer.from(hash(token),'hex'))))unavailable();
    return{row,authority};
  }
  async prepare(session:BrandSession,requestId:string,input:unknown):Promise<PreparedLogoUpload>{
    if(!id(requestId))fail('INVALID_REQUEST',400,'A stable upload request identity is required.');
    const parsed=parseLogoPrepareInput(input);
    return this.options.repository.transaction(async()=>{
      const authority=await this.options.load(session),scope=assertLogoPrepareScope(authority.context,parsed);
      await this.options.repository.ensureScope(authority);
      const signature=hash(JSON.stringify([scope.kind,scope.clubId,scope.teamId,parsed.byteSize,parsed.mimeType,parsed.sha256,parsed.policyAcknowledged]));
      const previous=await this.options.repository.byRequest(authority.context.principal.accountId,requestId),token=randomBytes(32).toString('base64url');
      if(previous){
        if(previous.request_signature!==signature||!sameScope(authority,previous))fail('IDEMPOTENCY_CONFLICT',409,'This request identity already belongs to another logo upload.');
        if(previous.expires_at<=this.now()&&['prepared','uploading'].includes(previous.status))fail('UPLOAD_EXPIRED',410,'The upload window expired. Prepare a new upload; the private history is retained.');
        if(!await this.options.repository.rotateToken(previous.id,hash(token)))unavailable();
        return{kind:'prepared-logo-upload',uploadId:previous.id,asset:reference(previous),uploadToken:token,expiresAtMs:previous.expires_at,maxBytes:MEDIA_LIMITS.maxBytes};
      }
      const row:BrandAssetRow={id:randomUUID(),asset_id:`logo-${randomUUID()}`,revision:1,kind:scope.kind,club_id:scope.clubId,team_id:scope.teamId,owner_id:authority.context.principal.accountId,request_id:requestId,request_signature:signature,status:'prepared',expected_bytes:parsed.byteSize,expected_sha:parsed.sha256,declared_mime:parsed.mimeType,token_hash:hash(token),expires_at:this.now()+MEDIA_LIMITS.uploadWindowMs,created_at:this.now(),processed_at:null,original_key:null,display_key:null,thumbnail_key:null,width:null,height:null,scanner_engine:null,failure_code:null,attempt:null,lease_until:null};
      await this.options.repository.create(row);
      return{kind:'prepared-logo-upload',uploadId:row.id,asset:reference(row),uploadToken:token,expiresAtMs:row.expires_at,maxBytes:MEDIA_LIMITS.maxBytes};
    });
  }
  async upload(session:BrandSession,uploadId:string,token:string,source:AsyncIterable<Uint8Array>){
    const{row}=await this.row(session,uploadId,token),duplicate=['uploaded','processed','linked'].includes(row.status);
    if(!duplicate&&row.expires_at<=this.now())fail('UPLOAD_EXPIRED',410,'The private upload window expired.');
    const attempt=randomUUID(),key=`quarantine/${row.id}-${attempt}.upload`;
    if(!duplicate&&!await this.options.repository.lease(row.id,'uploading',attempt,this.now()))fail('UPLOAD_BUSY',409,'The logo is already uploading or cannot be changed.');
    try{
      const byteSize=await receivePrivateImage({source,expectedBytes:row.expected_bytes,expectedSha:row.expected_sha,...(duplicate?{}:{temporaryPath:this.path(key+'.part'),destinationPath:this.path(key)})});
      await this.row(session,uploadId,token);
      if(!duplicate&&!await this.options.repository.uploaded(row.id,attempt,key))fail('UPLOAD_LEASE_CHANGED',409,'The logo upload lease changed. No publication was performed.');
      return{uploadId,status:'uploaded' as const,byteSize};
    }catch(error){if(!duplicate)await this.options.repository.failed(row.id,attempt,'uploading','UPLOAD_INCOMPLETE',true);throw error;}
  }
  private completion(row:BrandAssetRow):ProcessedLogoUpload{
    if(row.width===null||row.height===null)fail('UPLOAD_NOT_READY',409,'Finish private processing before reviewing this logo.');
    return{kind:'processed-logo-upload',uploadId:row.id,asset:reference(row),status:'processed',width:row.width,height:row.height};
  }
  async complete(session:BrandSession,uploadId:string,token:string):Promise<ProcessedLogoUpload>{
    const{row}=await this.row(session,uploadId,token);
    if(['processed','linked'].includes(row.status))return this.completion(row);
    if(!row.original_key)fail('UPLOAD_NOT_READY',409,'Finish the private upload before processing.');
    const attempt=randomUUID();if(!await this.options.repository.lease(row.id,'processing',attempt,this.now()))fail('UPLOAD_NOT_READY',409,'An active processing attempt cannot be duplicated.');
    try{
      const displayKey=`derivatives/${row.asset_id}-r${row.revision}-${attempt}-display.png`,thumbnailKey=`derivatives/${row.asset_id}-r${row.revision}-${attempt}-thumbnail.png`;
      const processed=await processPrivateImage({originalPath:this.path(row.original_key),displayPath:this.path(displayKey),thumbnailPath:this.path(thumbnailKey),expectedBytes:row.expected_bytes,expectedSha:row.expected_sha,declaredMime:row.declared_mime,scanner:this.options.scanner,kind:'logo'});
      const{authority}=await this.row(session,uploadId,token);
      if(!await this.options.repository.processed(row.id,attempt,{displayKey,thumbnailKey,width:processed.width,height:processed.height,scannerEngine:processed.scannerEngine,at:authority.context.nowMs}))fail('PROCESSING_LEASE_CHANGED',409,'The processing lease changed. No publication was performed.');
      return this.completion((await this.row(session,uploadId,token)).row);
    }catch(error){
      const code=error instanceof AccessError?error.code:'MEDIA_PROCESSING_FAILED',retryable=['SCANNER_REQUIRED','SCANNER_UNAVAILABLE','MEDIA_PROCESSING_FAILED','HEIC_DECODER_REQUIRED'].includes(code);
      await this.options.repository.failed(row.id,attempt,'processing',code,retryable);
      throw error instanceof AccessError?error:new AccessError('MEDIA_PROCESSING_FAILED',503,'Private logo processing is unavailable. No logo was published.');
    }
  }
  async command(session:BrandSession,input:unknown){
    const command=parseBrandingCommand(input);
    return this.options.repository.transaction(async()=>{
      const authority=await this.options.load(session);assertBrandAuthority(authority.context,command.kind);await this.options.repository.ensureScope(authority);
      const slot=await this.slot(authority,command.kind),row=command.type==='logo.published'?await this.options.repository.asset(command.assetId,command.reviewedRevision):undefined;
      const plan=planBrandingCommand(authority.context,slot,row?this.record(row,slot):null,command);
      if(!await this.options.repository.setSlot(plan.slot,slot.version))fail('STALE_REVISION',409,'The logo changed. Refresh and review its current revision.');
      if(row)await this.options.repository.linked(row.id);
      await this.options.audit(authority.context.principal,command.type,command.type==='logo.published'?command.assetId:command.kind,JSON.stringify(plan.audit));
      return{kind:'branding-command-receipt' as const,commandId:command.id,revision:plan.slot.version,acceptedAt:new Date(authority.context.nowMs).toISOString(),branding:await this.view(authority)};
    });
  }
  async gateway(session:BrandSession,assetId:string,revision:number,variant:'display'|'thumbnail',mode:'own'|'published'='published'){
    if(!id(assetId)||!Number.isSafeInteger(revision)||revision<1||!['display','thumbnail'].includes(variant)||!['own','published'].includes(mode))unavailable();
    const authority=await this.options.load(session),row=await this.options.repository.asset(assetId,revision);if(!row)unavailable();
    let slot=await this.slot(authority,row.kind);authorizeBrandAsset({context:authority.context,asset:this.record(row,slot),slot,revision,mode});
    const key=variant==='display'?row.display_key:row.thumbnail_key;if(!key)unavailable();
    let body:Buffer;try{body=await readFile(this.path(key));}catch{unavailable();}
    const fresh=await this.options.load(session);slot=await this.slot(fresh,row.kind);authorizeBrandAsset({context:fresh.context,asset:this.record(row,slot),slot,revision,mode});
    return{body,headers:{'Content-Type':'image/png','Content-Length':String(body.length),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}};
  }
}
