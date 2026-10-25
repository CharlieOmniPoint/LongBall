import { AccessError, assertAdultAuthority, currentMemberships } from '../../../packages/application/src/access';
import type { OppositionReviewCommand, OppositionReviewGame, OppositionReviewReceipt } from '../../../packages/application/src/opposition-review';
import type { RecordsState } from '../../../packages/application/src/records';
import type { MatchState } from '../../../packages/domain/src/types';
import { DevelopmentStore } from './store';
import { PostgresStore } from './postgres-store';
import type { RuntimeStore } from './runtime-store';
import type { OppositionReviewActor, OppositionReviewRepositoryPort, OppositionReviewRow, OppositionReviewSession } from './opposition-review-service';

const denied=()=>new AccessError('NOT_FOUND',404,'The requested opposition reviews are unavailable.');
const fields=['team_id','season_id','match_id','rating','note','revision','updated_by','updated_at'] as const;
export class OppositionReviewRepository implements OppositionReviewRepositoryPort {
  constructor(private readonly source:DevelopmentStore|PostgresStore,private readonly runtime:RuntimeStore){}
  transaction<T>(work:()=>Promise<T>):Promise<T>{return this.runtime.transaction(work);}
  async initialize():Promise<void>{
    if(this.source instanceof PostgresStore)return;
    await this.transaction(async()=>{
      if(!(this.source instanceof DevelopmentStore))return;
      this.source.database.exec(`CREATE TABLE IF NOT EXISTS opposition_reviews(team_id TEXT NOT NULL REFERENCES teams(id),season_id TEXT NOT NULL,match_id TEXT NOT NULL,rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),note TEXT CHECK(note IS NULL OR length(note)<=256),revision INTEGER NOT NULL CHECK(revision>=1),updated_by TEXT NOT NULL REFERENCES accounts(id),updated_at INTEGER NOT NULL,PRIMARY KEY(team_id,season_id,match_id));
      CREATE TABLE IF NOT EXISTS opposition_review_receipts(account_id TEXT NOT NULL REFERENCES accounts(id),command_id TEXT NOT NULL,team_id TEXT NOT NULL,season_id TEXT NOT NULL,signature TEXT NOT NULL,receipt_json TEXT NOT NULL,PRIMARY KEY(account_id,command_id));`);
    });
  }
  async now():Promise<number>{
    if(this.source instanceof DevelopmentStore)return this.source.now();
    const row=await this.source.one('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms');
    if(!Number.isSafeInteger(row?.now_ms))throw new Error('The opposition review clock is unavailable.');
    return Number(row!.now_ms);
  }
  async actor(session:OppositionReviewSession):Promise<OppositionReviewActor>{
    const principal=await this.runtime.principal({issuer:session.principal.issuer,subject:session.principal.subject,strongAuth:session.principal.strongAuth,authenticatedAt:session.principal.authenticatedAt});
    if(principal.accountId!==session.principal.accountId || session.role && !['manager','administrator','player'].includes(session.role))throw denied();
    const now=await this.now(),memberships=currentMemberships(principal,await this.runtime.memberships(),now).filter(item=>item.teamId===session.teamId&&item.seasonId===session.seasonId);
    const chosen=session.role?memberships.find(item=>item.role===session.role):memberships.find(item=>item.role==='manager')??memberships.find(item=>item.role==='administrator')??memberships.find(item=>item.role==='player');
    if(!chosen||!['manager','administrator','player'].includes(chosen.role))throw denied();
    if(chosen.role!=='player')assertAdultAuthority(principal,false,now);
    return {principal,role:chosen.role as OppositionReviewActor['role']};
  }
  async games(session:OppositionReviewSession):Promise<Omit<OppositionReviewGame,'review'>[]>{
    if(this.source instanceof PostgresStore){
      const row=await this.source.one('SELECT longball.opposition_completed_games($1,$2) AS value',[session.teamId,session.seasonId]);
      const value=typeof row?.value==='string'?JSON.parse(row.value):row?.value;
      if(!Array.isArray(value))throw denied();
      return value as Omit<OppositionReviewGame,'review'>[];
    }
    const results=new Map<string,{matchId:string;opponent:string;playedDate:string;completed:boolean}>();
    const document=this.source.database.prepare("SELECT value_json FROM documents WHERE team_id=? AND season_id=? AND kind='records'").get(session.teamId,session.seasonId) as {value_json:string}|undefined;
    for(const record of document?(JSON.parse(document.value_json) as RecordsState).results:[]){
      if(record.teamId===session.teamId&&record.seasonId===session.seasonId)results.set(record.id,{matchId:record.id,opponent:record.opponent,playedDate:record.playedDate,completed:record.status==='completed'});
    }
    const matches=this.source.database.prepare('SELECT state_json FROM matches WHERE team_id=? AND season_id=?').all(session.teamId,session.seasonId) as unknown as {state_json:string}[];
    for(const row of matches){const state=JSON.parse(row.state_json) as MatchState,fixture=state.config.fixture;
      if(state.status==='preparation'||!fixture||fixture.teamId!==session.teamId||fixture.seasonId!==session.seasonId)continue;
      results.set(state.config.matchId,{matchId:state.config.matchId,opponent:fixture.opponent,playedDate:fixture.playedDate,completed:state.status==='completed'});
    }
    return [...results.values()].filter(game=>game.completed).map(({matchId,opponent,playedDate})=>({matchId,opponent,playedDate})).sort((a,b)=>b.playedDate.localeCompare(a.playedDate)||a.matchId.localeCompare(b.matchId));
  }
  async rows(session:OppositionReviewSession):Promise<OppositionReviewRow[]>{
    if(this.source instanceof PostgresStore)return await this.source.many(`SELECT ${fields.join(',')} FROM opposition_reviews WHERE team_id=$1 AND season_id=$2 ORDER BY match_id`,[session.teamId,session.seasonId]) as unknown as OppositionReviewRow[];
    return this.source.database.prepare(`SELECT ${fields.join(',')} FROM opposition_reviews WHERE team_id=? AND season_id=? ORDER BY match_id`).all(session.teamId,session.seasonId) as unknown as OppositionReviewRow[];
  }
  async receipt(session:OppositionReviewSession,id:string):Promise<{signature:string;receipt_json:string}|null>{
    const row=this.source instanceof PostgresStore?await this.source.one('SELECT signature,receipt_json FROM opposition_review_receipts WHERE account_id=$1 AND command_id=$2 AND team_id=$3 AND season_id=$4',[session.principal.accountId,id,session.teamId,session.seasonId]):this.source.database.prepare('SELECT signature,receipt_json FROM opposition_review_receipts WHERE account_id=? AND command_id=? AND team_id=? AND season_id=?').get(session.principal.accountId,id,session.teamId,session.seasonId);
    return row as unknown as {signature:string;receipt_json:string}|null??null;
  }
  async save(session:OppositionReviewSession,row:OppositionReviewRow,command:OppositionReviewCommand,signature:string,receipt:OppositionReviewReceipt):Promise<void>{
    const actor=await this.actor(session);if(actor.role==='player'||actor.principal.accountId!==row.updated_by)throw denied();
    if(!(await this.games(session)).some(game=>game.matchId===row.match_id))throw denied();
    try{
      let changed:number;
      if(this.source instanceof PostgresStore){
        if(command.expectedRevision===0)changed=(await this.source.execute(`INSERT INTO opposition_reviews(${fields.join(',')}) VALUES(${fields.map((_key,index)=>`$${index+1}`).join(',')})`,fields.map(key=>row[key]))).changes;
        else changed=(await this.source.execute('UPDATE opposition_reviews SET rating=$1,note=$2,revision=$3,updated_by=$4,updated_at=$5 WHERE team_id=$6 AND season_id=$7 AND match_id=$8 AND revision=$9',[row.rating,row.note,row.revision,row.updated_by,row.updated_at,row.team_id,row.season_id,row.match_id,command.expectedRevision])).changes;
        if(changed!==1)throw new AccessError('OPPOSITION_REVIEW_CONFLICT',409,'The opposition review changed. Refresh before saving.');
        await this.source.execute('INSERT INTO opposition_review_receipts(account_id,command_id,team_id,season_id,signature,receipt_json) VALUES($1,$2,$3,$4,$5,$6)',[row.updated_by,command.id,row.team_id,row.season_id,signature,JSON.stringify(receipt)]);
      }else{
        if(command.expectedRevision===0)changed=Number(this.source.database.prepare(`INSERT INTO opposition_reviews(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`).run(...fields.map(key=>row[key])).changes);
        else changed=Number(this.source.database.prepare('UPDATE opposition_reviews SET rating=?,note=?,revision=?,updated_by=?,updated_at=? WHERE team_id=? AND season_id=? AND match_id=? AND revision=?').run(row.rating,row.note,row.revision,row.updated_by,row.updated_at,row.team_id,row.season_id,row.match_id,command.expectedRevision).changes);
        if(changed!==1)throw new AccessError('OPPOSITION_REVIEW_CONFLICT',409,'The opposition review changed. Refresh before saving.');
        this.source.database.prepare('INSERT INTO opposition_review_receipts(account_id,command_id,team_id,season_id,signature,receipt_json) VALUES(?,?,?,?,?,?)').run(row.updated_by,command.id,row.team_id,row.season_id,signature,JSON.stringify(receipt));
      }
    }catch(error){if(error instanceof AccessError)throw error;if(error&&typeof error==='object'&&'code' in error&&(error.code==='23505'||error.code==='ERR_SQLITE_ERROR'&&error instanceof Error&&/UNIQUE constraint/.test(error.message)))throw new AccessError('OPPOSITION_REVIEW_CONFLICT',409,'The opposition review changed. Refresh before saving.');throw error;}
  }
}
