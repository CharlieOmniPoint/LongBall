import { afterEach, describe, expect, it } from 'vitest';
import { DevelopmentStore,SYNTHETIC_IDS } from './store';
import { sqliteRuntimeStore } from './runtime-store';
import { OppositionReviewRepository } from './opposition-review-repository';
import { OppositionReviewService,type OppositionReviewSession } from './opposition-review-service';
import { assertOppositionReviewView } from '../../../packages/application/src/opposition-review';

const stores:DevelopmentStore[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();});
async function fixture(){
  const now=Date.parse('2026-10-24T12:00:00Z'),source=new DevelopmentStore(':memory:',()=>now);stores.push(source);source.seedSynthetic({demoSharing:true});
  const runtime=sqliteRuntimeStore(source).store,repository=new OppositionReviewRepository(source,runtime);await repository.initialize();const service=new OppositionReviewService(repository);
  const session=(name='manager',role=name.startsWith('manager')?'manager':name==='admin'?'administrator':name==='spectator'?'spectator':'player'):OppositionReviewSession=>({principal:source.principal({issuer:'urn:longball:synthetic',subject:`synthetic-account-${name}`,strongAuth:role==='manager'||role==='administrator',authenticatedAt:now}),teamId:SYNTHETIC_IDS.teamId,seasonId:SYNTHETIC_IDS.seasonId,role});
  const games=(await service.view(session())).games;expect(games.length).toBeGreaterThan(0);
  const command=(extra={})=>({id:'opposition-test-0001',type:'opposition.review.saved',matchId:games[0].matchId,expectedRevision:0,rating:4,note:'Strong passing and disciplined defending.',...extra});
  return{source,runtime,repository,service,session,command};
}
describe('opposition notes persisted in actual SQLite',()=>{
  it('allows manager/admin writes and player reads, retains CAS and exact receipt retries',async()=>{
    const f=await fixture(),manager=f.session();const receipt=await f.service.command(manager,f.command());expect(receipt.revision).toBe(1);
    expect(await f.service.command(manager,f.command())).toEqual(receipt);
    await expect(f.service.command(manager,f.command({note:'changed'}))).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    await expect(f.service.command(manager,f.command({id:'opposition-stale-0002'}))).rejects.toMatchObject({code:'OPPOSITION_REVIEW_CONFLICT'});
    await f.service.command(f.session('admin'),f.command({id:'opposition-update-0002',expectedRevision:1,rating:3,note:null}));
    const player=f.session('player-01'),value=await f.service.view(player);assertOppositionReviewView(value,{teamId:player.teamId,seasonId:player.seasonId,role:'player'});
    expect(value.canEdit).toBe(false);expect(value.games[0].review).toMatchObject({rating:3,note:null,revision:2});expect(JSON.stringify(value)).not.toContain('updated_by');
  });
  it('denies spectators, cross-team/season actors, revoked actors, player writes and unfinished games',async()=>{
    const f=await fixture();for(const session of [f.session('spectator'),{...f.session(),teamId:'synthetic-other-team'},{...f.session(),seasonId:'other-season'}])await expect(f.service.view(session)).rejects.toMatchObject({status:404});
    await expect(f.service.command(f.session('player-01'),f.command())).rejects.toMatchObject({status:404});
    await expect(f.service.command(f.session(),f.command({matchId:SYNTHETIC_IDS.matchId}))).rejects.toMatchObject({code:'MATCH_NOT_COMPLETED'});
    f.source.database.prepare("UPDATE memberships SET revoked_at=? WHERE account_id=? AND role='manager'").run(Date.now(),f.session().principal.accountId);
    await expect(f.service.view(f.session())).rejects.toMatchObject({status:404});
    expect(f.source.database.prepare('SELECT count(*) AS n FROM opposition_reviews').get()?.n).toBe(0);
  });
  it('bounds ratings and Unicode text and rolls back the note if its durable receipt fails',async()=>{
    const f=await fixture();for(const extra of [{rating:0},{rating:6},{note:'x'.repeat(257)},{note:'bad\u0000text'}])await expect(f.service.command(f.session(),f.command(extra))).rejects.toMatchObject({code:'INVALID_OPPOSITION_REVIEW'});
    f.source.database.exec("CREATE TRIGGER refuse_opposition_receipt BEFORE INSERT ON opposition_review_receipts BEGIN SELECT RAISE(ABORT,'receipt failed');END");
    await expect(f.service.command(f.session(),f.command({note:'😀'.repeat(256)}))).rejects.toThrow('receipt failed');
    expect(f.source.database.prepare('SELECT count(*) AS n FROM opposition_reviews').get()?.n).toBe(0);
  });
});
