import { createHash } from 'node:crypto';
import { AccessError, type Principal } from '../../../packages/application/src/access';
import { matchFeedbackClosesAt, parseMatchFeedbackCommand, type MatchFeedbackCommand, type MatchFeedbackEntry, type MatchFeedbackMatch, type MatchFeedbackReceipt, type MatchFeedbackView } from '../../../packages/application/src/match-feedback';
import type { CommunityMatch } from '../../../packages/application/src/community';
import type { MatchState } from '../../../packages/domain/src/types';

export interface MatchFeedbackSession { principal: Principal; teamId: string; seasonId: string; role?: string }
export interface MatchFeedbackActor { principal: Principal; role: 'manager' | 'player'; playerId: string | null }
export interface MatchFeedbackEvidence { state: MatchState; context: CommunityMatch | null }
export interface MatchFeedbackRow { team_id: string; season_id: string; match_id: string; account_id: string; player_id: string; rating: number; note: string | null; revision: number; completed_at: number; closes_at: number; created_at: number; updated_at: number }
export interface MatchFeedbackStoredReceipt { signature: string; receipt_json: string }
export interface MatchFeedbackRepositoryPort {
  transaction<T>(work: () => Promise<T>): Promise<T>;
  now(): Promise<number>;
  actor(session: MatchFeedbackSession): Promise<MatchFeedbackActor>;
  matches(session: MatchFeedbackSession): Promise<MatchFeedbackEvidence[]>;
  entries(session: MatchFeedbackSession, actor: MatchFeedbackActor): Promise<MatchFeedbackRow[]>;
  receipt(session: MatchFeedbackSession, commandId: string, playerId: string): Promise<MatchFeedbackStoredReceipt | null>;
  save(session: MatchFeedbackSession, row: MatchFeedbackRow, command: MatchFeedbackCommand, signature: string, receipt: MatchFeedbackReceipt): Promise<void>;
}
const unavailable = () => new AccessError('NOT_FOUND', 404, 'The requested private feedback is unavailable.');
function trustedCompletion(evidence: MatchFeedbackEvidence, session: MatchFeedbackSession, now: number): number | null {
  const { state, context } = evidence;
  if (!context || state.status !== 'completed' || state.recoveryRequired || context.id !== state.config.matchId || context.teamId !== session.teamId || context.seasonId !== session.seasonId || context.finishQuality !== 'trusted' || !Number.isSafeInteger(context.actualFullTimeAtMs) || context.actualFullTimeAtMs! < 0 || context.actualFullTimeAtMs! > now) return null;
  const selected = [...state.config.selectedPlayerIds];
  const present = selected.filter(id => state.attendance[id] === 'present');
  const played = selected.filter(id => state.intervals.some(interval => interval.playerId === id && interval.state === 'playing' && interval.endMs > interval.startMs));
  const same = (left: readonly string[], right: readonly string[]) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
  if (played.some(id => !present.includes(id)) || !same(selected, context.selectedPlayerIds) || !same(present, context.presentPlayerIds) || !same(played, context.playedPlayerIds)) return null;
  return context.actualFullTimeAtMs;
}
const entry = (row: MatchFeedbackRow, evidence: MatchFeedbackEvidence): MatchFeedbackEntry => ({ playerId: row.player_id, playerLabel: evidence.state.config.players.find(player => player.id === row.player_id)?.displayName ?? row.player_id, rating: row.rating, text: row.note, revision: row.revision, createdAtMs: row.created_at, updatedAtMs: row.updated_at });

/** Private post-game feedback never shares through community, records exports or administrator statistics. */
export class MatchFeedbackService {
  constructor(private readonly repository: MatchFeedbackRepositoryPort) {}
  async view(session: MatchFeedbackSession): Promise<MatchFeedbackView> {
    return this.repository.transaction(async () => {
      const actor = await this.repository.actor(session), now = await this.repository.now();
      const [matches, rows] = await Promise.all([this.repository.matches(session), this.repository.entries(session, actor)]);
      const visible: MatchFeedbackMatch[] = [];
      for (const evidence of matches) {
        const matchId = evidence.state.config.matchId;
        const entries = rows.filter(row => row.match_id === matchId);
        if (evidence.state.status !== 'completed' && entries.length === 0) continue;
        const own = actor.role === 'player' ? entries.find(row => row.account_id === actor.principal.accountId && row.player_id === actor.playerId) ?? null : null;
        const completion = trustedCompletion(evidence, session, now);
        const verified = completion !== null && (!own || own.completed_at === completion && own.closes_at === matchFeedbackClosesAt(completion));
        const completedAtMs = own?.completed_at ?? completion;
        const closesAtMs = own?.closes_at ?? (completion === null ? null : matchFeedbackClosesAt(completion));
        const eligible = actor.role === 'player' && completion !== null && evidence.context!.playedPlayerIds.includes(actor.playerId!);
        const status = !verified ? 'review_required' : now < closesAtMs! ? 'open' : 'closed';
        visible.push({ matchId, label: evidence.context?.label ?? `${evidence.state.config.fixture?.teamName ?? 'Team'} v ${evidence.state.config.fixture?.opponent ?? 'opponent'}`, playedDate: evidence.state.config.fixture?.playedDate ?? null, completedAtMs, closesAtMs, status, eligible, canEdit: actor.role === 'player' && eligible && status === 'open', own: own ? entry(own, evidence) : null, ...(actor.role === 'manager' ? { entries: entries.map(row => entry(row, evidence)) } : {}) });
      }
      return { kind: 'match-feedback', accountId: actor.principal.accountId, playerId: actor.playerId, teamId: session.teamId, seasonId: session.seasonId, audience: actor.role, serverNowMs: now, matches: visible };
    });
  }
  async command(session: MatchFeedbackSession, raw: unknown): Promise<MatchFeedbackReceipt> {
    const command = parseMatchFeedbackCommand(raw);
    const signature = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    return this.repository.transaction(async () => {
      const actor = await this.repository.actor(session);
      if (actor.role !== 'player' || !actor.playerId) throw unavailable();
      const prior = await this.repository.receipt(session, command.id, actor.playerId);
      if (prior) {
        if (prior.signature !== signature) throw new AccessError('IDEMPOTENCY_CONFLICT', 409, 'This feedback request identity was already used for different content.');
        return JSON.parse(prior.receipt_json) as MatchFeedbackReceipt;
      }
      const evidence = (await this.repository.matches(session)).find(match => match.state.config.matchId === command.matchId);
      if (!evidence) throw unavailable();
      const now = await this.repository.now(), completion = trustedCompletion(evidence, session, now);
      if (completion === null) throw new AccessError('FEEDBACK_FINISH_UNVERIFIED', 409, 'The accepted completion or participation evidence needs review. Feedback has not been saved.');
      if (!evidence.context!.playedPlayerIds.includes(actor.playerId)) throw unavailable();
      const closesAtMs = matchFeedbackClosesAt(completion);
      if (now >= closesAtMs) throw new AccessError('FEEDBACK_WINDOW_CLOSED', 409, 'Feedback editing closed at midnight Europe/London on the game completion day. Existing feedback remains readable.');
      const existing = (await this.repository.entries(session, actor)).find(row => row.match_id === command.matchId && row.account_id === actor.principal.accountId && row.player_id === actor.playerId);
      if (existing && (existing.completed_at !== completion || existing.closes_at !== closesAtMs)) throw new AccessError('FEEDBACK_FINISH_UNVERIFIED', 409, 'The original feedback completion window is retained and needs review.');
      if ((existing?.revision ?? 0) !== command.expectedRevision) throw new AccessError('FEEDBACK_REVISION_CONFLICT', 409, 'Your feedback changed. Refresh and review before confirming another save.');
      // Read the authoritative clock again immediately before persistence; expiry during awaited reads cannot extend the window.
      const receivedAt = await this.repository.now();
      if (receivedAt < completion || receivedAt >= closesAtMs) throw new AccessError('FEEDBACK_WINDOW_CLOSED', 409, 'The feedback editing window has closed. Your submitted draft was not saved.');
      const receipt: MatchFeedbackReceipt = { kind: 'match-feedback-receipt', commandId: command.id, teamId: session.teamId, seasonId: session.seasonId, matchId: command.matchId, revision: (existing?.revision ?? 0) + 1 };
      await this.repository.save(session, { team_id: session.teamId, season_id: session.seasonId, match_id: command.matchId, account_id: actor.principal.accountId, player_id: actor.playerId, rating: command.rating, note: command.text, revision: receipt.revision, completed_at: completion, closes_at: closesAtMs, created_at: existing?.created_at ?? receivedAt, updated_at: receivedAt }, command, signature, receipt);
      return receipt;
    });
  }
}
