import type { BrandKind, BrandSlot } from '../../../packages/application/src/branding';
import type { PgDatabase } from './pg';
import { mapBrandSlot, type BrandAssetRow, type BrandRepository, type BrandingAuthority } from './brand-repository';

/** Native PostgreSQL parameterized queries; authority remains transaction-local RLS. */
export class PostgresBrandRepository implements BrandRepository {
  constructor(readonly database:PgDatabase){}
  transaction<T>(work:()=>Promise<T>):Promise<T>{return this.database.transaction(work);}
  async ensureScope(_authority:BrandingAuthority):Promise<void>{/* Explicit catalogue ancestry already exists; runtime never invents it. */}
  private async one(sql:string,values:readonly unknown[]):Promise<BrandAssetRow|undefined>{return(await this.database.query(sql,values)).rows[0] as BrandAssetRow|undefined;}
  async byRequest(owner:string,request:string){return this.one('SELECT * FROM brand_assets WHERE owner_id=$1 AND request_id=$2',[owner,request]);}
  async upload(id:string){return this.one('SELECT * FROM brand_assets WHERE id=$1',[id]);}
  async asset(id:string,revision:number){return this.one('SELECT * FROM brand_assets WHERE asset_id=$1 AND revision=$2',[id,revision]);}
  async own(owner:string,club:string,team:string){return(await this.database.query('SELECT * FROM brand_assets WHERE owner_id=$1 AND club_id=$2 AND(team_id IS NULL OR team_id=$3) ORDER BY created_at DESC,id',[owner,club,team])).rows as BrandAssetRow[];}
  async create(row:BrandAssetRow):Promise<void>{
    await this.database.query('INSERT INTO brand_assets(id,asset_id,revision,kind,club_id,team_id,owner_id,request_id,request_signature,status,expected_bytes,expected_sha,declared_mime,token_hash,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',[row.id,row.asset_id,row.revision,row.kind,row.club_id,row.team_id,row.owner_id,row.request_id,row.request_signature,row.status,row.expected_bytes,row.expected_sha,row.declared_mime,row.token_hash,row.expires_at,row.created_at]);
  }
  async rotateToken(id:string,hash:string){return(await this.database.query('UPDATE brand_assets SET token_hash=$1 WHERE id=$2',[hash,id])).rowCount===1;}
  async lease(id:string,stage:'uploading'|'processing',attempt:string,now:number){return(await this.database.query('UPDATE brand_assets SET status=$1,attempt=$2,lease_until=$3,failure_code=NULL WHERE id=$4 AND(status=$5 OR(status=$1 AND lease_until<$6))',[stage,attempt,now+65_000,id,stage==='uploading'?'prepared':'uploaded',now])).rowCount===1;}
  async uploaded(id:string,attempt:string,key:string){return(await this.database.query("UPDATE brand_assets SET status='uploaded',original_key=$1,lease_until=NULL,failure_code=NULL WHERE id=$2 AND attempt=$3 AND status='uploading'",[key,id,attempt])).rowCount===1;}
  async processed(id:string,attempt:string,value:{displayKey:string;thumbnailKey:string;width:number;height:number;scannerEngine:string;at:number}){return(await this.database.query("UPDATE brand_assets SET status='processed',display_key=$1,thumbnail_key=$2,width=$3,height=$4,scanner_engine=$5,processed_at=$6,lease_until=NULL,failure_code=NULL WHERE id=$7 AND attempt=$8 AND status='processing'",[value.displayKey,value.thumbnailKey,value.width,value.height,value.scannerEngine,value.at,id,attempt])).rowCount===1;}
  async failed(id:string,attempt:string,stage:'uploading'|'processing',code:string,retryable:boolean){await this.database.query('UPDATE brand_assets SET status=$1,failure_code=$2,lease_until=NULL WHERE id=$3 AND attempt=$4 AND status=$5',[retryable?(stage==='uploading'?'prepared':'uploaded'):'rejected',code,id,attempt,stage]);}
  async slot(kind:BrandKind,club:string,team:string|null){const row=(await this.database.query('SELECT * FROM brand_slots WHERE kind=$1 AND club_id=$2 AND team_id IS NOT DISTINCT FROM $3',[kind,club,team])).rows[0];return row?mapBrandSlot(row):undefined;}
  async setSlot(slot:BrandSlot,expected:number){await this.database.query('INSERT INTO brand_slots(kind,club_id,team_id,version) VALUES($1,$2,$3,0) ON CONFLICT DO NOTHING',[slot.kind,slot.clubId,slot.teamId]);return(await this.database.query('UPDATE brand_slots SET version=$1,asset_id=$2,asset_revision=$3,reviewed_revision=$4,policy_version=$5,confirmed_by=$6,confirmed_at=$7 WHERE kind=$8 AND club_id=$9 AND team_id IS NOT DISTINCT FROM $10 AND version=$11',[slot.version,slot.assetId,slot.assetRevision,slot.reviewedRevision,slot.policyVersion,slot.confirmedBy,slot.confirmedAt,slot.kind,slot.clubId,slot.teamId,expected])).rowCount===1;}
  async linked(id:string){if((await this.database.query("UPDATE brand_assets SET status='linked' WHERE id=$1 AND status IN('processed','linked')",[id])).rowCount!==1)throw new Error('BRAND_LINK_CONFLICT');}
}
