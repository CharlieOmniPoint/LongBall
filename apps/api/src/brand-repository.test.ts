import { DatabaseSync } from 'node:sqlite';
import { describe,expect,it } from 'vitest';
import { SqliteBrandRepository } from './brand-repository';

function legacyDatabase(){
  const database=new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON; CREATE TABLE teams(id TEXT PRIMARY KEY); CREATE TABLE accounts(id TEXT PRIMARY KEY); INSERT INTO teams VALUES(\'team\'); INSERT INTO accounts VALUES(\'owner\')');
  const open=()=>new SqliteBrandRepository(database,async work=>work());
  open();
  const schema=String(database.prepare("SELECT sql FROM sqlite_schema WHERE name='brand_assets'").get()?.sql);
  database.exec('PRAGMA foreign_keys=OFF; DROP TABLE brand_assets');
  database.exec(schema.replace(",'image/heic'",''));
  database.exec("PRAGMA foreign_keys=ON; INSERT INTO branding_clubs VALUES('club'); INSERT INTO branding_teams VALUES('team','club')");
  const insert=(id:string,mime='image/png',kind='team_logo')=>database.prepare(`INSERT INTO brand_assets(id,asset_id,revision,kind,club_id,team_id,owner_id,request_id,request_signature,status,expected_bytes,expected_sha,declared_mime,token_hash,expires_at,created_at,display_key) VALUES(?,?,1,?,'club','team','owner',?,'signature','linked',10,'original-sha',?,'capability-hash',100,1,'private/immutable.png')`).run(id,id,kind,id,mime);
  return{database,open,insert};
}

describe('fictional SQLite HEIC logo schema upgrade',()=>{
  it('retains linked bytes, current pointer and CAS revision while admitting HEIC and enforcing ancestry',()=>{
    const {database,open,insert}=legacyDatabase();
    try{
      insert('existing');
      database.exec("INSERT INTO brand_slots(kind,club_id,team_id,version,asset_id,asset_revision,reviewed_revision,policy_version,confirmed_by,confirmed_at) VALUES('team_logo','club','team',7,'existing',1,1,'actual-policy','owner',10)");
      const assets=database.prepare('SELECT * FROM brand_assets').all(),slots=database.prepare('SELECT * FROM brand_slots').all();
      expect(()=>insert('heic','image/heic')).toThrow();
      open();open();
      expect(database.prepare('SELECT * FROM brand_assets').all()).toEqual(assets);
      expect(database.prepare('SELECT * FROM brand_slots').all()).toEqual(slots);
      insert('heic','image/heic');
      expect(()=>insert('invalid','image/png','club_logo')).toThrow();
      expect(()=>database.exec("UPDATE brand_slots SET asset_id='unknown',version=8")).toThrow();
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(database.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    }finally{database.close();}
  });
  it('rolls back an invalid legacy row without replacing the original schema or disabling foreign keys',()=>{
    const {database,open,insert}=legacyDatabase();
    try{
      database.exec('PRAGMA ignore_check_constraints=ON');insert('invalid','image/png','club_logo');database.exec('PRAGMA ignore_check_constraints=OFF');
      const original=database.prepare("SELECT sql FROM sqlite_schema WHERE name='brand_assets'").get();
      expect(open).toThrow();
      expect(database.prepare("SELECT sql FROM sqlite_schema WHERE name='brand_assets'").get()).toEqual(original);
      expect(database.prepare('SELECT id FROM brand_assets').all()).toEqual([{id:'invalid'}]);
      expect(database.prepare("SELECT name FROM sqlite_schema WHERE name='brand_assets_heic'").all()).toEqual([]);
      expect(database.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    }finally{database.close();}
  });
});
