import { randomUUID } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import type { Principal } from '../../../packages/application/src/access';
import { goalkeeperCleanSheetOutcomes } from '../../../packages/application/src/goalkeeper-clean-sheets';
import type { MatchState } from '../../../packages/domain/src/types';
import { PgDatabase } from './pg';
import { PostgresStore,SYNTHETIC_IDS } from './postgres-store';
import { PgMediaService } from './postgres-media';
import { PostgresActivationService } from './postgres-activation';
import { applyRuntimeGrants } from './runtime-grants';
import { OppositionReviewRepository } from './opposition-review-repository';
import { OppositionReviewService,type OppositionReviewSession } from './opposition-review-service';

const configured=process.env.LONGBALL_POSTGRES_TEST_URL;
describe.skipIf(!configured)('actual restricted PostgreSQL opposition reviews and clean sheets',()=>{
  let admin:Pool,maintenance:Pool,owner:PgDatabase,api:PgDatabase,worker:PgDatabase,store:PostgresStore,service:OppositionReviewService,database='',directory='',matchId='';
  const pools:PgDatabase[]=[],roles:Record<string,string>={},rolePasswords:Record<string,string>={},principals:Record<string,Principal>={};
  const teamId=SYNTHETIC_IDS.teamId,seasonId=SYNTHETIC_IDS.seasonId;
  const session=(name='manager-2',role=name.startsWith('manager')?'manager':name==='admin'?'administrator':name==='spectator'?'spectator':'player'):OppositionReviewSession=>({principal:principals[name],teamId,seasonId,role});
  const run=<T>(actor:OppositionReviewSession,operation:string,work:()=>Promise<T>)=>store.withActorContext(actor.principal,{operation,requestedRole:actor.role as 'manager'|'administrator'|'player'|'spectator',teamId:actor.teamId,seasonId:actor.seasonId},work);
  const command=(extra={})=>({id:'postgres-opposition-0001',type:'opposition.review.saved',matchId,expectedRevision:0,rating:4,note:'Quick passing and patient build-up.',...extra});
  beforeAll(async()=>{
    admin=new Pool({connectionString:configured,max:2});admin.on('error',()=>undefined);const suffix=randomUUID().replaceAll('-','');database=`lb_opposition_${suffix}`;
    for(const purpose of ['owner','api','worker']){roles[purpose]=`lb_opposition_${purpose}_${suffix}`;rolePasswords[purpose]=randomUUID();await admin.query(`CREATE ROLE "${roles[purpose]}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${rolePasswords[purpose]}'`);}
    await admin.query(`CREATE DATABASE "${database}"`);const base=new URL(configured!);base.pathname=`/${database}`;maintenance=new Pool({connectionString:base.href,max:2});maintenance.on('error',()=>undefined);await maintenance.query(`CREATE SCHEMA longball AUTHORIZATION "${roles.owner}"`);
    const connect=(purpose:string,migrationMode:'apply'|'verify')=>{const url=new URL(base);url.username=roles[purpose];url.password=rolePasswords[purpose];const db=new PgDatabase(url.href,{migrationMode,maximumConnections:1});pools.push(db);return db;};
    owner=connect('owner','apply');await owner.migrate();const seed=new PostgresStore(owner);await seed.seedSynthetic({demoSharing:true});
    directory=await mkdtemp(join(tmpdir(),'longball-opposition-'));await PgMediaService.open({directory,database:owner});await new PostgresActivationService({store:seed}).initialize();await applyRuntimeGrants(owner,{apiRole:roles.api,workerRole:roles.worker});
    api=connect('api','verify');worker=connect('worker','verify');await api.migrate();store=new PostgresStore(api);
    for(const name of ['manager-2','admin','player-01','spectator'])principals[name]=await seed.principal({issuer:'urn:longball:synthetic',subject:`synthetic-account-${name}`,strongAuth:name==='admin'||name.startsWith('manager'),authenticatedAt:Date.now()});
    service=new OppositionReviewService(new OppositionReviewRepository(store,store));const manager=session();matchId=(await run(manager,'opposition.read',()=>service.view(manager))).games[0].matchId;
  });
  afterAll(async()=>{for(const db of pools)await db.close();await maintenance?.end();if(database)await admin.query(`DROP DATABASE "${database}" WITH(FORCE)`);for(const role of Object.values(roles))await admin.query(`DROP ROLE "${role}"`);if(directory)await rm(directory,{recursive:true,force:true});await admin?.end();});
  it('persists staff notes, exposes them to players, rejects player writes and replays exact receipts',async()=>{
    const manager=session(),receipt=await run(manager,'opposition.write',()=>service.command(manager,command()));expect(receipt.revision).toBe(1);expect(await run(manager,'opposition.write',()=>service.command(manager,command()))).toEqual(receipt);
    const player=session('player-01');expect((await run(player,'opposition.read',()=>service.view(player))).games.find(game=>game.matchId===matchId)?.review?.note).toBe('Quick passing and patient build-up.');
    await expect(run(player,'opposition.write',()=>service.command(player,command({id:'postgres-player-write'})))).rejects.toMatchObject({status:404});
    const administrator=session('admin');await run(administrator,'opposition.write',()=>service.command(administrator,command({id:'postgres-admin-update',expectedRevision:1,rating:3,note:null})));
    await expect(run(manager,'opposition.write',()=>service.command(manager,command({id:'postgres-stale-update'})))).rejects.toMatchObject({code:'OPPOSITION_REVIEW_CONFLICT'});
  });
  it('RLS denies spectator, unscoped, wrong-operation and worker reads and direct unfinished-game insertion',async()=>{
    const spectator=session('spectator');await expect(run(spectator,'opposition.read',()=>service.view(spectator))).rejects.toMatchObject({status:404});
    expect((await run(spectator,'opposition.read',()=>api.query('SELECT * FROM opposition_reviews'))).rows).toEqual([]);
    expect((await api.query('SELECT * FROM opposition_reviews')).rows).toEqual([]);
    const manager=session();expect((await run(manager,'records.read',()=>api.query('SELECT * FROM opposition_reviews'))).rows).toEqual([]);
    await expect(worker.query('SELECT * FROM opposition_reviews')).rejects.toMatchObject({code:'42501'});
    await expect(run(manager,'opposition.write',()=>api.query('INSERT INTO opposition_reviews(team_id,season_id,match_id,rating,note,revision,updated_by,updated_at) VALUES($1,$2,$3,4,NULL,1,$4,0)',[teamId,seasonId,SYNTHETIC_IDS.matchId,manager.principal.accountId]))).rejects.toMatchObject({code:'42501'});
    expect((await maintenance.query('SELECT count(*)::integer AS n FROM longball.opposition_reviews')).rows[0].n).toBe(1);
  });
  it('uses the same interval and goal rules in the narrow admin aggregate as the shared projection',async()=>{
    const matches=(await owner.query('SELECT state_json FROM matches WHERE team_id=$1 AND season_id=$2',[teamId,seasonId])).rows.map(row=>JSON.parse(row.state_json) as MatchState).filter(state=>state.status==='completed');expect(matches.length).toBeGreaterThan(0);
    for(const state of matches){const expected=goalkeeperCleanSheetOutcomes({completed:true,reviewRequired:state.recoveryRequired||state.schemaVersion!==2,activeDurationMs:state.matchActiveMs,intervals:state.intervals,oppositionGoals:(state.goals??[]).filter(goal=>!goal.voided&&goal.beneficiary==='opposition').map(goal=>({atMs:goal.effective.matchElapsedMs})),recordedOppositionScore:state.score.against});const raw=(await owner.query('SELECT longball.stats_keeper_outcomes($1::jsonb) AS value',[JSON.stringify(state)])).rows[0].value;expect(JSON.parse(raw).sort((a:{playerId:string},b:{playerId:string})=>a.playerId.localeCompare(b.playerId))).toEqual(expected.sort((a,b)=>a.playerId.localeCompare(b.playerId)));}
    const administrator=session('admin'),value=await run(administrator,'stats.read',()=>store.playerStats(administrator.principal,teamId,seasonId,'administrator'));expect(value.kind).toBe('team-player-stats');if(value.kind==='team-player-stats')expect(value.players.every(player=>Number.isInteger(player.knownCleanSheets))).toBe(true);
    await expect(api.query('SELECT longball.admin_player_stats_source_v19($1,$2)',[teamId,seasonId])).rejects.toMatchObject({code:'42501'});
  });
});
