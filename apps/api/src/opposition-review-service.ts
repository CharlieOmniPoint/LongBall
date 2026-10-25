import { createHash } from 'node:crypto';
import { AccessError, type Principal } from '../../../packages/application/src/access';
import { parseOppositionReviewCommand, type OppositionReviewCommand, type OppositionReviewGame, type OppositionReviewReceipt, type OppositionReviewView } from '../../../packages/application/src/opposition-review';

export interface OppositionReviewSession { principal:Principal; teamId:string; seasonId:string; role?:string }
export interface OppositionReviewActor { principal:Principal; role:'manager'|'administrator'|'player' }
export interface OppositionReviewRow { team_id:string; season_id:string; match_id:string; rating:number; note:string|null; revision:number; updated_by:string; updated_at:number }
export interface OppositionReviewRepositoryPort {
  transaction<T>(work:()=>Promise<T>):Promise<T>;
  actor(session:OppositionReviewSession):Promise<OppositionReviewActor>;
  now():Promise<number>;
  games(session:OppositionReviewSession):Promise<Omit<OppositionReviewGame,'review'>[]>;
  rows(session:OppositionReviewSession):Promise<OppositionReviewRow[]>;
  receipt(session:OppositionReviewSession,id:string):Promise<{signature:string;receipt_json:string}|null>;
  save(session:OppositionReviewSession,row:OppositionReviewRow,command:OppositionReviewCommand,signature:string,receipt:OppositionReviewReceipt):Promise<void>;
}
export class OppositionReviewService {
  constructor(private readonly repository:OppositionReviewRepositoryPort) {}
  async view(session:OppositionReviewSession):Promise<OppositionReviewView> {
    return this.repository.transaction(async()=>{
      const actor=await this.repository.actor(session),games=await this.repository.games(session),rows=await this.repository.rows(session);
      return {kind:'opposition-reviews',teamId:session.teamId,seasonId:session.seasonId,canEdit:actor.role!=='player',games:games.map(game=>{const row=rows.find(item=>item.match_id===game.matchId);return {...game,review:row ? {rating:row.rating,note:row.note,revision:row.revision,updatedAtMs:row.updated_at} : null};})};
    });
  }
  async command(session:OppositionReviewSession,raw:unknown):Promise<OppositionReviewReceipt> {
    const command=parseOppositionReviewCommand(raw),signature=createHash('sha256').update(JSON.stringify(command)).digest('hex');
    return this.repository.transaction(async()=>{
      const actor=await this.repository.actor(session);
      if(actor.role==='player')throw new AccessError('NOT_FOUND',404,'The requested opposition review operation is unavailable.');
      const prior=await this.repository.receipt(session,command.id);
      if(prior){if(prior.signature!==signature)throw new AccessError('IDEMPOTENCY_CONFLICT',409,'This request identity was already used for different content.');return JSON.parse(prior.receipt_json) as OppositionReviewReceipt;}
      const game=(await this.repository.games(session)).find(item=>item.matchId===command.matchId);
      if(!game)throw new AccessError('MATCH_NOT_COMPLETED',409,'An opposition review can be saved only after this team has a recorded completed game.');
      const existing=(await this.repository.rows(session)).find(row=>row.match_id===command.matchId);
      if((existing?.revision??0)!==command.expectedRevision)throw new AccessError('OPPOSITION_REVIEW_CONFLICT',409,'This opposition review changed. Refresh and review before saving.');
      const receipt:OppositionReviewReceipt={kind:'opposition-review-receipt',commandId:command.id,teamId:session.teamId,seasonId:session.seasonId,matchId:command.matchId,revision:command.expectedRevision+1};
      await this.repository.save(session,{team_id:session.teamId,season_id:session.seasonId,match_id:command.matchId,rating:command.rating,note:command.note,revision:receipt.revision,updated_by:actor.principal.accountId,updated_at:await this.repository.now()},command,signature,receipt);
      return receipt;
    });
  }
}
