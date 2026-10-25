import { AccessError, assertAdultAuthority, currentMemberships } from '../../../packages/application/src/access';
import type { CommunityState } from '../../../packages/application/src/community';
import type { MatchFeedbackCommand, MatchFeedbackReceipt } from '../../../packages/application/src/match-feedback';
import type { MatchState } from '../../../packages/domain/src/types';
import { DevelopmentStore } from './store';
import { PostgresStore } from './postgres-store';
import type { RuntimeStore } from './runtime-store';
import type { MatchFeedbackActor, MatchFeedbackEvidence, MatchFeedbackRepositoryPort, MatchFeedbackRow, MatchFeedbackSession, MatchFeedbackStoredReceipt } from './match-feedback-service';

const denied = () => new AccessError('NOT_FOUND', 404, 'The requested private feedback is unavailable.');
const fields = ['team_id', 'season_id', 'match_id', 'account_id', 'player_id', 'rating', 'note', 'revision', 'completed_at', 'closes_at', 'created_at', 'updated_at'] as const;
/** Dedicated private storage: no feedback values enter generic documents, records, exports or statistics. */
export class MatchFeedbackRepository implements MatchFeedbackRepositoryPort {
  constructor(private readonly source: DevelopmentStore | PostgresStore, private readonly runtime: RuntimeStore) {}
  transaction<T>(work: () => Promise<T>): Promise<T> { return this.runtime.transaction(work); }
  async initialize(): Promise<void> {
    if (this.source instanceof PostgresStore) return;
    await this.transaction(async () => {
      if (!(this.source instanceof DevelopmentStore)) return;
      this.source.database.exec(`CREATE TABLE IF NOT EXISTS match_feedback (
        team_id TEXT NOT NULL REFERENCES teams(id),season_id TEXT NOT NULL,match_id TEXT NOT NULL REFERENCES matches(id),account_id TEXT NOT NULL REFERENCES accounts(id),player_id TEXT NOT NULL,
        rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),note TEXT CHECK(note IS NULL OR length(note)<=256),revision INTEGER NOT NULL CHECK(revision>=1),
        completed_at INTEGER NOT NULL,closes_at INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
        PRIMARY KEY(match_id,account_id),UNIQUE(match_id,player_id),CHECK(completed_at>=0 AND closes_at>completed_at AND created_at>=completed_at AND updated_at>=created_at AND updated_at<closes_at)
      );CREATE INDEX IF NOT EXISTS match_feedback_scope ON match_feedback(team_id,season_id,match_id);
      CREATE TABLE IF NOT EXISTS match_feedback_receipts (
        account_id TEXT NOT NULL REFERENCES accounts(id),command_id TEXT NOT NULL,team_id TEXT NOT NULL REFERENCES teams(id),season_id TEXT NOT NULL,match_id TEXT NOT NULL REFERENCES matches(id),player_id TEXT NOT NULL,
        signature TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(account_id,command_id)
      );`);
    });
  }
  async now(): Promise<number> {
    if (this.source instanceof DevelopmentStore) return this.source.now();
    const row = await this.source.one('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms');
    if (!Number.isSafeInteger(row?.now_ms)) throw new Error('The authoritative feedback clock is unavailable.');
    return Number(row!.now_ms);
  }
  async actor(session: MatchFeedbackSession): Promise<MatchFeedbackActor> {
    const principal = await this.runtime.principal({ issuer: session.principal.issuer, subject: session.principal.subject, strongAuth: session.principal.strongAuth, authenticatedAt: session.principal.authenticatedAt });
    if (principal.accountId !== session.principal.accountId || session.role && !['manager', 'player'].includes(session.role)) throw denied();
    const now = await this.now();
    const memberships = currentMemberships(principal, await this.runtime.memberships(), now).filter(item => item.teamId === session.teamId && item.seasonId === session.seasonId);
    const chosen = session.role ? memberships.find(item => item.role === session.role) : memberships.find(item => item.role === 'manager') ?? memberships.find(item => item.role === 'player');
    if (!chosen || !['manager', 'player'].includes(chosen.role) || chosen.role === 'player' && !chosen.playerId) throw denied();
    if (chosen.role === 'player' && new Set(memberships.filter(item => item.role === 'player').map(item => item.playerId)).size !== 1) throw denied();
    if (chosen.role === 'manager') assertAdultAuthority(principal, false, now);
    return { principal, role: chosen.role as 'manager' | 'player', playerId: chosen.role === 'player' ? chosen.playerId! : null };
  }
  async matches(session: MatchFeedbackSession): Promise<MatchFeedbackEvidence[]> {
    let matches: { state_json: string }[], document: { value_json: string } | undefined;
    if (this.source instanceof PostgresStore) {
      matches = await this.source.many('SELECT state_json FROM matches WHERE team_id=$1 AND season_id=$2 ORDER BY id', [session.teamId, session.seasonId]) as unknown as { state_json: string }[];
      document = await this.source.one("SELECT value_json FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='community'", [session.teamId, session.seasonId]) as { value_json: string } | undefined;
    } else {
      matches = this.source.database.prepare('SELECT state_json FROM matches WHERE team_id=? AND season_id=? ORDER BY id').all(session.teamId, session.seasonId) as unknown as { state_json: string }[];
      document = this.source.database.prepare("SELECT value_json FROM documents WHERE team_id=? AND season_id=? AND kind='community'").get(session.teamId, session.seasonId) as { value_json: string } | undefined;
    }
    const contexts = document ? (JSON.parse(document.value_json) as CommunityState).matches : [];
    return matches.map(row => { const state = JSON.parse(row.state_json) as MatchState; return { state, context: contexts.find(item => item.id === state.config.matchId && item.teamId === session.teamId && item.seasonId === session.seasonId) ?? null }; });
  }
  async entries(session: MatchFeedbackSession, actor: MatchFeedbackActor): Promise<MatchFeedbackRow[]> {
    const own = actor.role === 'player';
    if (this.source instanceof PostgresStore) return await this.source.many(`SELECT ${fields.join(',')} FROM match_feedback WHERE team_id=$1 AND season_id=$2${own ? ' AND account_id=$3 AND player_id=$4' : ''} ORDER BY match_id,player_id`, own ? [session.teamId, session.seasonId, actor.principal.accountId, actor.playerId] : [session.teamId, session.seasonId]) as unknown as MatchFeedbackRow[];
    return this.source.database.prepare(`SELECT ${fields.join(',')} FROM match_feedback WHERE team_id=? AND season_id=?${own ? ' AND account_id=? AND player_id=?' : ''} ORDER BY match_id,player_id`).all(...(own ? [session.teamId, session.seasonId, actor.principal.accountId, actor.playerId!] : [session.teamId, session.seasonId])) as unknown as MatchFeedbackRow[];
  }
  async receipt(session: MatchFeedbackSession, commandId: string, playerId: string): Promise<MatchFeedbackStoredReceipt | null> {
    const row = this.source instanceof PostgresStore
      ? await this.source.one('SELECT signature,receipt_json FROM match_feedback_receipts WHERE account_id=$1 AND command_id=$2 AND team_id=$3 AND season_id=$4 AND player_id=$5', [session.principal.accountId, commandId, session.teamId, session.seasonId, playerId])
      : this.source.database.prepare('SELECT signature,receipt_json FROM match_feedback_receipts WHERE account_id=? AND command_id=? AND team_id=? AND season_id=? AND player_id=?').get(session.principal.accountId, commandId, session.teamId, session.seasonId, playerId);
    return row as unknown as MatchFeedbackStoredReceipt | null ?? null;
  }
  async save(session: MatchFeedbackSession, row: MatchFeedbackRow, command: MatchFeedbackCommand, signature: string, receipt: MatchFeedbackReceipt): Promise<void> {
    // Recheck current account/linkage in the same write transaction immediately before SQL.
    const actor = await this.actor(session);
    if (actor.role !== 'player' || actor.playerId !== row.player_id || actor.principal.accountId !== row.account_id) throw denied();
    if (await this.now() >= row.closes_at) throw new AccessError('FEEDBACK_WINDOW_CLOSED', 409, 'The feedback editing window has closed.');
    try {
      let changed: number;
      if (this.source instanceof PostgresStore) {
        const values = fields.map(key => row[key]);
        if (command.expectedRevision === 0) changed = (await this.source.execute(`INSERT INTO match_feedback(${fields.join(',')}) VALUES(${fields.map((_key, index) => `$${index + 1}`).join(',')})`, values)).changes;
        else changed = (await this.source.execute('UPDATE match_feedback SET rating=$1,note=$2,revision=$3,updated_at=$4 WHERE match_id=$5 AND account_id=$6 AND player_id=$7 AND team_id=$8 AND season_id=$9 AND revision=$10', [row.rating, row.note, row.revision, row.updated_at, row.match_id, row.account_id, row.player_id, row.team_id, row.season_id, command.expectedRevision])).changes;
        if (changed !== 1) throw new AccessError('FEEDBACK_REVISION_CONFLICT', 409, 'Your feedback changed. Refresh and review before saving.');
        await this.source.execute('INSERT INTO match_feedback_receipts(account_id,command_id,team_id,season_id,match_id,player_id,signature,receipt_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [row.account_id, command.id, row.team_id, row.season_id, row.match_id, row.player_id, signature, JSON.stringify(receipt), row.updated_at]);
      } else {
        if (command.expectedRevision === 0) changed = Number(this.source.database.prepare(`INSERT INTO match_feedback(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`).run(...fields.map(key => row[key])).changes);
        else changed = Number(this.source.database.prepare('UPDATE match_feedback SET rating=?,note=?,revision=?,updated_at=? WHERE match_id=? AND account_id=? AND player_id=? AND team_id=? AND season_id=? AND revision=?').run(row.rating, row.note, row.revision, row.updated_at, row.match_id, row.account_id, row.player_id, row.team_id, row.season_id, command.expectedRevision).changes);
        if (changed !== 1) throw new AccessError('FEEDBACK_REVISION_CONFLICT', 409, 'Your feedback changed. Refresh and review before saving.');
        this.source.database.prepare('INSERT INTO match_feedback_receipts(account_id,command_id,team_id,season_id,match_id,player_id,signature,receipt_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(row.account_id, command.id, row.team_id, row.season_id, row.match_id, row.player_id, signature, JSON.stringify(receipt), row.updated_at);
      }
    } catch (error) {
      if (error instanceof AccessError) throw error;
      if (error && typeof error === 'object' && 'code' in error && (error.code === '23505' || error.code === 'ERR_SQLITE_ERROR' && error instanceof Error && /UNIQUE constraint/.test(error.message))) throw new AccessError('FEEDBACK_REVISION_CONFLICT', 409, 'The feedback record changed or is already linked. Refresh before saving.');
      throw error;
    }
  }
}
