import type { DatabaseSync } from 'node:sqlite';
import type { BrandKind, BrandSlot, BrandingContext } from '../../../packages/application/src/branding';
import { AccessError,currentMemberships,assertTeamRole,type Membership,type Principal,type Role } from '../../../packages/application/src/access';

export interface BrandingAuthority { context:BrandingContext;club:{id:string;name:string};team:{id:string;name:string;ageGroup:string} }
export function brandSelectedRole(principal:Principal,memberships:Membership[],teamId:string,seasonId:string,role:string|undefined,nowMs:number):Role{
  const own=currentMemberships(principal,memberships,nowMs).filter(member=>member.teamId===teamId&&member.seasonId===seasonId);
  const chosen=role??(['manager','player','spectator','administrator'] as Role[]).find(candidate=>own.some(member=>member.role===candidate));
  if(!chosen||!['manager','player','spectator','administrator'].includes(chosen))throw new AccessError('NOT_FOUND',404,'The requested branding is unavailable.');
  assertTeamRole(principal,memberships,teamId,seasonId,[chosen as Role],nowMs);return chosen as Role;
}
export interface BrandAssetRow {
  id:string;asset_id:string;revision:number;kind:BrandKind;club_id:string;team_id:string|null;owner_id:string;
  request_id:string;request_signature:string;status:'prepared'|'uploading'|'uploaded'|'processing'|'processed'|'linked'|'rejected';
  expected_bytes:number;expected_sha:string;declared_mime:string;token_hash:string;expires_at:number;created_at:number;processed_at:number|null;
  original_key:string|null;display_key:string|null;thumbnail_key:string|null;width:number|null;height:number|null;scanner_engine:string|null;
  failure_code:string|null;attempt:string|null;lease_until:number|null;
}
export interface BrandRepository {
  transaction<T>(work:()=>Promise<T>):Promise<T>;
  ensureScope(authority:BrandingAuthority):Promise<void>;
  byRequest(ownerId:string,requestId:string):Promise<BrandAssetRow|undefined>;
  upload(id:string):Promise<BrandAssetRow|undefined>;
  asset(assetId:string,revision:number):Promise<BrandAssetRow|undefined>;
  own(ownerId:string,clubId:string,teamId:string):Promise<BrandAssetRow[]>;
  create(row:BrandAssetRow):Promise<void>;
  rotateToken(id:string,hash:string):Promise<boolean>;
  lease(id:string,stage:'uploading'|'processing',attempt:string,nowMs:number):Promise<boolean>;
  uploaded(id:string,attempt:string,key:string):Promise<boolean>;
  processed(id:string,attempt:string,value:{displayKey:string;thumbnailKey:string;width:number;height:number;scannerEngine:string;at:number}):Promise<boolean>;
  failed(id:string,attempt:string,stage:'uploading'|'processing',code:string,retryable:boolean):Promise<void>;
  slot(kind:BrandKind,clubId:string,teamId:string|null):Promise<BrandSlot|undefined>;
  setSlot(slot:BrandSlot,expectedVersion:number):Promise<boolean>;
  linked(id:string):Promise<void>;
}
export const mapBrandSlot=(row:Record<string,unknown>):BrandSlot=>({kind:row.kind as BrandKind,clubId:String(row.club_id),teamId:row.team_id===null?null:String(row.team_id),version:Number(row.version),assetId:row.asset_id===null?null:String(row.asset_id),assetRevision:row.asset_revision===null?null:Number(row.asset_revision),reviewedRevision:row.reviewed_revision===null?null:Number(row.reviewed_revision),policyVersion:row.policy_version===null?null:String(row.policy_version),confirmedBy:row.confirmed_by===null?null:String(row.confirmed_by),confirmedAt:row.confirmed_at===null?null:Number(row.confirmed_at)});

/** SQLite cannot alter a CHECK. Preserve rows, current pointers and any extra indexes atomically. */
function migrateHeicBrandAssets(database:DatabaseSync):void{
  const definition=database.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='brand_assets'").get()?.sql;
  if(typeof definition!=='string'||definition.includes("'image/heic'"))return;
  if(!definition.includes("'image/jpeg','image/png'"))throw new Error('UNKNOWN_BRAND_ASSET_SCHEMA');
  const foreignKeys=Number(database.prepare('PRAGMA foreign_keys').get()?.foreign_keys)===1;
  const extras=database.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name='brand_assets' AND type IN('index','trigger') AND sql IS NOT NULL").all();
  const columns=database.prepare('PRAGMA table_xinfo(brand_assets)').all().filter(column=>Number(column.hidden)===0).map(column=>`"${String(column.name).replaceAll('"','""')}"`).join(',');
  database.exec('PRAGMA foreign_keys=OFF');
  if(Number(database.prepare('PRAGMA foreign_keys').get()?.foreign_keys)!==0)throw new Error('BRAND_MIGRATION_REQUIRES_IDLE_DATABASE');
  let began=false;
  try{
    database.exec('BEGIN IMMEDIATE');began=true;
    database.exec(definition.replace(/CREATE TABLE(?: IF NOT EXISTS)?\s+"?brand_assets"?/i,'CREATE TABLE brand_assets_heic').replace("'image/jpeg','image/png'","'image/jpeg','image/png','image/heic'"));
    database.exec(`INSERT INTO brand_assets_heic(${columns}) SELECT ${columns} FROM brand_assets`);
    database.exec('DROP TABLE brand_assets; ALTER TABLE brand_assets_heic RENAME TO brand_assets');
    for(const extra of extras)database.exec(String(extra.sql));
    if(database.prepare('PRAGMA foreign_key_check').all().length)throw new Error('BRAND_MIGRATION_ANCESTRY_FAILED');
    database.exec('COMMIT');began=false;
  }catch(error){if(began)database.exec('ROLLBACK');throw error;}
  finally{if(foreignKeys)database.exec('PRAGMA foreign_keys=ON');}
}

/** Explicit fictional SQLite repository; PostgreSQL has its own SQL and row security. */
export class SqliteBrandRepository implements BrandRepository {
  constructor(readonly database:DatabaseSync,readonly transaction:<T>(work:()=>Promise<T>)=>Promise<T>){
    database.exec(`CREATE TABLE IF NOT EXISTS branding_clubs(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS branding_teams(team_id TEXT PRIMARY KEY REFERENCES teams(id),club_id TEXT NOT NULL REFERENCES branding_clubs(id),UNIQUE(club_id,team_id));
      CREATE TABLE IF NOT EXISTS brand_assets(id TEXT PRIMARY KEY,asset_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),kind TEXT NOT NULL CHECK(kind IN('club_logo','team_logo')),club_id TEXT NOT NULL REFERENCES branding_clubs(id),team_id TEXT,season_id TEXT CHECK(season_id IS NULL),match_id TEXT CHECK(match_id IS NULL),owner_id TEXT NOT NULL REFERENCES accounts(id),request_id TEXT NOT NULL,request_signature TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('prepared','uploading','uploaded','processing','processed','linked','rejected')),expected_bytes INTEGER NOT NULL CHECK(expected_bytes BETWEEN 1 AND 15728640),expected_sha TEXT NOT NULL,declared_mime TEXT NOT NULL CHECK(declared_mime IN('image/jpeg','image/png','image/heic')),token_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,processed_at INTEGER,original_key TEXT,display_key TEXT,thumbnail_key TEXT,width INTEGER,height INTEGER,scanner_engine TEXT,failure_code TEXT,attempt TEXT,lease_until INTEGER,scope_key TEXT GENERATED ALWAYS AS (COALESCE(team_id,'')) STORED,
      CHECK((kind='club_logo' AND team_id IS NULL) OR(kind='team_logo' AND team_id IS NOT NULL)),UNIQUE(owner_id,request_id),UNIQUE(asset_id,revision),UNIQUE(asset_id,revision,kind,club_id,scope_key),FOREIGN KEY(club_id,team_id) REFERENCES branding_teams(club_id,team_id));
      CREATE TABLE IF NOT EXISTS brand_slots(kind TEXT NOT NULL CHECK(kind IN('club_logo','team_logo')),club_id TEXT NOT NULL REFERENCES branding_clubs(id),team_id TEXT,scope_key TEXT GENERATED ALWAYS AS(COALESCE(team_id,'')) STORED,version INTEGER NOT NULL CHECK(version>=0),asset_id TEXT,asset_revision INTEGER,reviewed_revision INTEGER,policy_version TEXT,confirmed_by TEXT REFERENCES accounts(id),confirmed_at INTEGER,
      CHECK((kind='club_logo' AND team_id IS NULL) OR(kind='team_logo' AND team_id IS NOT NULL)),CHECK((asset_id IS NULL AND asset_revision IS NULL AND reviewed_revision IS NULL) OR(asset_id IS NOT NULL AND asset_revision>0 AND reviewed_revision=asset_revision)),UNIQUE(kind,club_id,scope_key),FOREIGN KEY(club_id,team_id) REFERENCES branding_teams(club_id,team_id),FOREIGN KEY(asset_id,asset_revision,kind,club_id,scope_key) REFERENCES brand_assets(asset_id,revision,kind,club_id,scope_key));`);
    migrateHeicBrandAssets(database);
  }
  async ensureScope(authority:BrandingAuthority):Promise<void>{
    this.database.prepare('INSERT INTO branding_clubs(id) VALUES(?) ON CONFLICT DO NOTHING').run(authority.context.clubId);
    this.database.prepare('INSERT INTO branding_teams(team_id,club_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(authority.context.teamId,authority.context.clubId);
    const row=this.database.prepare('SELECT club_id FROM branding_teams WHERE team_id=?').get(authority.context.teamId);
    if(row?.club_id!==authority.context.clubId)throw new Error('BRANDING_ANCESTRY_CONFLICT');
  }
  async byRequest(owner:string,request:string){return this.database.prepare('SELECT * FROM brand_assets WHERE owner_id=? AND request_id=?').get(owner,request) as unknown as BrandAssetRow|undefined;}
  async upload(id:string){return this.database.prepare('SELECT * FROM brand_assets WHERE id=?').get(id) as unknown as BrandAssetRow|undefined;}
  async asset(id:string,revision:number){return this.database.prepare('SELECT * FROM brand_assets WHERE asset_id=? AND revision=?').get(id,revision) as unknown as BrandAssetRow|undefined;}
  async own(owner:string,club:string,team:string){return this.database.prepare('SELECT * FROM brand_assets WHERE owner_id=? AND club_id=? AND(team_id IS NULL OR team_id=?) ORDER BY created_at DESC,id').all(owner,club,team) as unknown as BrandAssetRow[];}
  async create(row:BrandAssetRow){const columns=Object.keys(row);this.database.prepare(`INSERT INTO brand_assets(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...Object.values(row));}
  async rotateToken(id:string,hash:string){return this.database.prepare('UPDATE brand_assets SET token_hash=? WHERE id=?').run(hash,id).changes===1;}
  async lease(id:string,stage:'uploading'|'processing',attempt:string,now:number){const from=stage==='uploading'?'prepared':'uploaded';return this.database.prepare('UPDATE brand_assets SET status=?,attempt=?,lease_until=?,failure_code=NULL WHERE id=? AND(status=? OR(status=? AND lease_until<?))').run(stage,attempt,now+65_000,id,from,stage,now).changes===1;}
  async uploaded(id:string,attempt:string,key:string){return this.database.prepare("UPDATE brand_assets SET status='uploaded',original_key=?,lease_until=NULL,failure_code=NULL WHERE id=? AND attempt=? AND status='uploading'").run(key,id,attempt).changes===1;}
  async processed(id:string,attempt:string,value:{displayKey:string;thumbnailKey:string;width:number;height:number;scannerEngine:string;at:number}){return this.database.prepare("UPDATE brand_assets SET status='processed',display_key=?,thumbnail_key=?,width=?,height=?,scanner_engine=?,processed_at=?,lease_until=NULL,failure_code=NULL WHERE id=? AND attempt=? AND status='processing'").run(value.displayKey,value.thumbnailKey,value.width,value.height,value.scannerEngine,value.at,id,attempt).changes===1;}
  async failed(id:string,attempt:string,stage:'uploading'|'processing',code:string,retryable:boolean){this.database.prepare('UPDATE brand_assets SET status=?,failure_code=?,lease_until=NULL WHERE id=? AND attempt=? AND status=?').run(retryable?(stage==='uploading'?'prepared':'uploaded'):'rejected',code,id,attempt,stage);}
  async slot(kind:BrandKind,club:string,team:string|null){const row=this.database.prepare('SELECT * FROM brand_slots WHERE kind=? AND club_id=? AND team_id IS ?').get(kind,club,team);return row?mapBrandSlot(row):undefined;}
  async setSlot(slot:BrandSlot,expected:number){this.database.prepare('INSERT INTO brand_slots(kind,club_id,team_id,version) VALUES(?,?,?,0) ON CONFLICT DO NOTHING').run(slot.kind,slot.clubId,slot.teamId);return this.database.prepare('UPDATE brand_slots SET version=?,asset_id=?,asset_revision=?,reviewed_revision=?,policy_version=?,confirmed_by=?,confirmed_at=? WHERE kind=? AND club_id=? AND team_id IS ? AND version=?').run(slot.version,slot.assetId,slot.assetRevision,slot.reviewedRevision,slot.policyVersion,slot.confirmedBy,slot.confirmedAt,slot.kind,slot.clubId,slot.teamId,expected).changes===1;}
  async linked(id:string){const updated=this.database.prepare("UPDATE brand_assets SET status='linked' WHERE id=? AND status IN('processed','linked')").run(id);if(updated.changes!==1)throw new Error('BRAND_LINK_CONFLICT');}
}
