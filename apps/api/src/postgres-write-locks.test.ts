import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PgDatabase, type PgApplicationContext } from './pg';
import { PostgresStore, SYNTHETIC_IDS } from './postgres-store';
import { applyRuntimeGrants } from './runtime-grants';
import { PgMediaService } from './postgres-media';
import { PostgresActivationService } from './postgres-activation';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Principal } from '../../../packages/application/src/access';
import type { MatchConfig } from '../../../packages/domain/src/index';

const configured=process.env.LONGBALL_POSTGRES_TEST_URL;
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};}
describe.skipIf(!configured)('hierarchical match write locks on independent PostgreSQL instances',()=>{
  let admin:Pool,owner:PostgresStore,database:string,directory:string,principal:Principal,other:Principal;
  let roles:{owner:string;apiRole:string;workerRole:string};
  const stores:PostgresStore[]=[],names=new Map<PostgresStore,string>();let serial=0;
  const holds:{release:()=>void;finished:Promise<unknown>}[]=[];
  afterEach(async()=>{for(const hold of holds)hold.release();await Promise.allSettled(holds.splice(0).map(hold=>hold.finished));});
  const matchB='lock-other-team-match',matchPrior='lock-prior-season-match',priorSeason='lock-prior-season';
  const identity=(accountId:string)=>({issuer:'urn:longball:synthetic',subject:accountId,strongAuth:true,authenticatedAt:Date.now()});
  let connection:(role:string)=>string;
  async function instance(role?:string){const name=`lock-proof-${serial++}-${randomUUID()}`;const db=new PgDatabase(connection(role??roles.apiRole),{migrationMode:'verify',maximumConnections:1,applicationName:name});await db.migrate();const store=new PostgresStore(db);stores.push(store);names.set(store,name);return store;}
  beforeAll(async()=>{
    const suffix=randomUUID().replaceAll('-','');database=`lb_write_lock_${suffix}`;roles={owner:`lb_lock_owner_${suffix}`,apiRole:`lb_lock_api_${suffix}`,workerRole:`lb_lock_worker_${suffix}`};
    admin=new Pool({connectionString:configured,max:1});for(const role of Object.values(roles))await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);await admin.query(`CREATE DATABASE "${database}"`);
    const url=new URL(configured!);url.pathname=`/${database}`;const bootstrap=new Pool({connectionString:url.href});try{await bootstrap.query(`CREATE SCHEMA longball AUTHORIZATION "${roles.owner}"`);}finally{await bootstrap.end();}
    connection=role=>{const target=new URL(url);target.username=role;target.password='';return target.href;};
    owner=await PostgresStore.open(connection(roles.owner));await owner.seedSynthetic();directory=await mkdtemp(join(tmpdir(),'longball-lock-proof-'));
    await PgMediaService.open({directory,database:owner.db});await new PostgresActivationService({store:owner}).initialize();
    const config=JSON.parse((await owner.match(SYNTHETIC_IDS.matchId)).config_json) as MatchConfig;
    await owner.insertMatch({...config,matchId:matchB,fixture:{...config.fixture!,teamId:'synthetic-other-team'}},'synthetic-other-team',SYNTHETIC_IDS.seasonId);
    await owner.execute('INSERT INTO team_seasons(club_id,team_id,season_id) VALUES($1,$2,$3)',['synthetic-richmond-rovers',SYNTHETIC_IDS.teamId,priorSeason]);
    await owner.execute("INSERT INTO memberships(account_id,team_id,season_id,role) VALUES('synthetic-account-manager',$1,$2,'manager')",[SYNTHETIC_IDS.teamId,priorSeason]);
    await owner.insertMatch({...config,matchId:matchPrior,fixture:{...config.fixture!,seasonId:priorSeason}},SYNTHETIC_IDS.teamId,priorSeason);
    await applyRuntimeGrants(owner.db,roles);
    const api=await instance();await api.assertRuntimeRole('api');principal=await api.withIdentityContext(identity('synthetic-account-manager'),()=>api.principal(identity('synthetic-account-manager')));other=await api.withIdentityContext(identity('synthetic-account-other-manager'),()=>api.principal(identity('synthetic-account-other-manager')));
  });
  afterAll(async()=>{for(const store of stores.reverse())await store.close();if(owner)await owner.close();if(database)await admin.query(`DROP DATABASE "${database}" WITH(FORCE)`);for(const role of Object.values(roles??{}))await admin.query(`DROP ROLE "${role}"`);if(admin)await admin.end();if(directory)await rm(directory,{recursive:true,force:true});});
  async function waiting(store:PostgresStore){
    const until=Date.now()+5_000;
    while(Date.now()<until){const row=(await admin.query("SELECT count(*)::integer AS n FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory'",[names.get(store)])).rows[0];if(Number(row?.n)>0)return;await new Promise(resolve=>setTimeout(resolve,10));}
    throw new Error('Expected an actual PostgreSQL advisory lock wait.');
  }
  function matchHold(store:PostgresStore,who:Principal,matchId:string,rollback=false){
    const entered=deferred(),release=deferred();let inside=false;
    const finished=store.withActorContext(who,{matchId,operation:'match.manage',requestedRole:'manager'},()=>store.transaction(async()=>{
      await store.managerMatch(who,matchId);inside=true;entered.resolve();await release.promise;
      await store.execute('UPDATE matches SET last_sync_at=$1 WHERE id=$2',[Date.now(),matchId]);
      if(rollback)throw new Error('Deliberate lock rollback.');
    }));void finished.catch(()=>undefined);
    const hold={entered:Promise.race([entered.promise,finished.then(()=>{throw new Error('Transaction ended before entering its work.');})]),release:release.resolve,finished,isInside:()=>inside};
    void hold.entered.catch(()=>undefined);holds.push(hold);return hold;
  }
  function globalHold(store:PostgresStore,context?:PgApplicationContext,work?:()=>Promise<void>){
    const entered=deferred(),release=deferred();let inside=false;
    const transaction=()=>store.transaction(async()=>{inside=true;entered.resolve();await release.promise;await work?.();});
    const finished=context?store.db.withContext(context,transaction):transaction();void finished.catch(()=>undefined);
    const hold={entered:Promise.race([entered.promise,finished.then(()=>{throw new Error('Transaction ended before entering its work.');})]),release:release.resolve,finished,isInside:()=>inside};
    void hold.entered.catch(()=>undefined);holds.push(hold);return hold;
  }
  const full=(changes:Partial<Extract<PgApplicationContext,{kind:'actor'}>>={}):Extract<PgApplicationContext,{kind:'actor'}>=>({kind:'actor',accountId:principal.accountId,issuer:principal.issuer,subject:principal.subject,strongAuth:true,authenticatedAtMs:Date.now(),nowMs:Date.now(),operation:'match.manage',requestedRole:'manager',clubId:'synthetic-richmond-rovers',teamId:SYNTHETIC_IDS.teamId,seasonId:SYNTHETIC_IDS.seasonId,matchId:SYNTHETIC_IDS.matchId,...changes});
  it('allows a different team while serializing the same team across seasons',async()=>{
    const first=await instance(),same=await instance(),different=await instance();const a=matchHold(first,principal,SYNTHETIC_IDS.matchId);await a.entered;
    const b=matchHold(same,principal,matchPrior),c=matchHold(different,other,matchB);
    try{await waiting(same);expect(b.isInside()).toBe(false);await c.entered;expect(c.isInside()).toBe(true);c.release();await c.finished;a.release();await a.finished;await b.entered;}
    finally{a.release();b.release();c.release();await Promise.allSettled([a.finished,b.finished,c.finished]);}
  });
  it('interlocks with legacy global-exclusive writers in both directions',async()=>{
    const first=await instance(),global=await instance(),different=await instance();const a=matchHold(first,principal,SYNTHETIC_IDS.matchId);await a.entered;
    // An unscoped transaction retains exactly the old exclusive bigint barrier.
    const g=globalHold(global);await waiting(global);const b=matchHold(different,other,matchB);
    try{await waiting(different);expect(g.isInside()).toBe(false);expect(b.isInside()).toBe(false);a.release();await a.finished;await g.entered;expect(b.isInside()).toBe(false);g.release();await g.finished;await b.entered;}
    finally{a.release();g.release();b.release();await Promise.allSettled([a.finished,g.finished,b.finished]);}
  });
  it('releases both hierarchy locks on rollback and keeps same-context nested transactions on the held lock',async()=>{
    const first=await instance(),second=await instance(),before=(await owner.match(SYNTHETIC_IDS.matchId)).last_sync_at;
    const a=matchHold(first,principal,SYNTHETIC_IDS.matchId,true);await a.entered;const b=matchHold(second,principal,SYNTHETIC_IDS.matchId);
    try{await waiting(second);a.release();await expect(a.finished).rejects.toThrow('Deliberate lock rollback.');await b.entered;expect((await owner.match(SYNTHETIC_IDS.matchId)).last_sync_at).toBe(before);b.release();await b.finished;
      await first.withActorContext(principal,{matchId:SYNTHETIC_IDS.matchId,operation:'match.manage',requestedRole:'manager'},()=>first.transaction(()=>first.transaction(async()=>{expect(await first.one('SELECT 1 AS n')).toEqual({n:1});})));
    }finally{a.release();b.release();await Promise.allSettled([a.finished,b.finished]);}
  });
  it('keeps other operations, incomplete scopes, lower roles, worker and migration contexts globally exclusive',async()=>{
    const exclusive=await instance(),different=await instance(),worker=await instance(roles.workerRole);
    const incomplete=full();delete incomplete.matchId;
    const cases:{store:PostgresStore;context?:PgApplicationContext}[]=[
      {store:exclusive,context:full({operation:'records.write'})},{store:exclusive,context:incomplete},{store:exclusive,context:full({requestedRole:'player'})},
      {store:exclusive,context:full({requestedRole:'administrator'})},{store:exclusive,context:full({requestedRole:undefined})},
      {store:worker,context:{kind:'worker_claim',jobKind:'notification.dispatch',nowMs:Date.now()}},{store:worker,context:{kind:'worker_job',jobId:'not-a-capability',leaseToken:'a'.repeat(64),clubId:'synthetic-richmond-rovers',teamId:SYNTHETIC_IDS.teamId,seasonId:SYNTHETIC_IDS.seasonId,nowMs:Date.now()}},{store:exclusive},
    ];
    for(const item of cases){const g=globalHold(item.store,item.context);await g.entered;const b=matchHold(different,other,matchB);try{await waiting(different);expect(b.isInside()).toBe(false);}finally{g.release();await g.finished;await b.entered;b.release();await b.finished;}}
  });
  it('rechecks current revocation after waiting behind a global authority change',async()=>{
    const team=await instance();
    // The isolated schema owner applies the authority change behind the legacy
    // exclusive global barrier while the queued match still holds its old principal.
    const ownerGate=deferred(),ownerEntered=deferred();const authority=owner.transaction(async()=>{ownerEntered.resolve();await ownerGate.promise;await owner.execute('UPDATE memberships SET revoked_at=$1 WHERE account_id=$2 AND team_id=$3 AND season_id=$4',[Date.now(),principal.accountId,SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId]);});await ownerEntered.promise;
    const candidate=matchHold(team,principal,SYNTHETIC_IDS.matchId);
    try{await waiting(team);ownerGate.resolve();await authority;await expect(candidate.finished).rejects.toMatchObject({code:'NOT_FOUND'});expect(candidate.isInside()).toBe(false);}
    finally{ownerGate.resolve();candidate.release();await Promise.allSettled([authority,candidate.finished]);await owner.execute('UPDATE memberships SET revoked_at=NULL WHERE account_id=$1 AND team_id=$2 AND season_id=$3',[principal.accountId,SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId]);}
  });
});
