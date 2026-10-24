import { AccessError } from './access';

export interface MatchFeedbackEntry {
  playerId: string;
  playerLabel: string;
  rating: number;
  text: string | null;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
}
export type MatchFeedbackStatus = 'open' | 'closed' | 'review_required';
export interface MatchFeedbackMatch {
  matchId: string;
  label: string;
  playedDate: string | null;
  completedAtMs: number | null;
  closesAtMs: number | null;
  status: MatchFeedbackStatus;
  eligible: boolean;
  canEdit: boolean;
  own: MatchFeedbackEntry | null;
  /** Present only for an assigned manager. Never returned to another player or administrator. */
  entries?: MatchFeedbackEntry[];
}
export interface MatchFeedbackView {
  kind: 'match-feedback';
  accountId: string;
  playerId: string | null;
  teamId: string;
  seasonId: string;
  audience: 'player' | 'manager';
  serverNowMs: number;
  matches: MatchFeedbackMatch[];
}
export interface MatchFeedbackCommand {
  id: string;
  type: 'feedback.saved';
  matchId: string;
  expectedRevision: number;
  rating: number;
  text: string | null;
}
export interface MatchFeedbackReceipt {
  kind: 'match-feedback-receipt';
  commandId: string;
  teamId: string;
  seasonId: string;
  matchId: string;
  revision: number;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const matchIdentifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,150}$/.test(value);
export function parseMatchFeedbackCommand(raw: unknown): MatchFeedbackCommand {
  if (!record(raw) || Object.keys(raw).some(key => !['id', 'type', 'matchId', 'expectedRevision', 'rating', 'text'].includes(key)) || raw.type !== 'feedback.saved' || typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{8,150}$/.test(raw.id) || !matchIdentifier(raw.matchId) || !Number.isSafeInteger(raw.expectedRevision) || (raw.expectedRevision as number) < 0 || !Number.isInteger(raw.rating) || (raw.rating as number) < 1 || (raw.rating as number) > 5 || !(raw.text === null || typeof raw.text === 'string' && Array.from(raw.text).length <= 256 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw.text))) throw new AccessError('INVALID_FEEDBACK', 400, 'Choose a rating from 1 to 5 and an optional note of at most 256 characters.');
  return { id: raw.id, type: 'feedback.saved', matchId: raw.matchId, expectedRevision: raw.expectedRevision as number, rating: raw.rating as number, text: typeof raw.text === 'string' ? raw.text.trim() || null : null };
}
/** Exclusive end of the actual completion's calendar day in Europe/London, including 23/25-hour DST days. */
export function matchFeedbackClosesAt(completedAtMs: number): number {
  if (!Number.isSafeInteger(completedAtMs) || completedAtMs < 0) throw new AccessError('FEEDBACK_FINISH_UNVERIFIED', 409, 'A verified original game completion time is required.');
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
  const day = formatter.format(completedAtMs);
  let before = completedAtMs, after = completedAtMs + 27 * 60 * 60_000;
  while (after - before > 1) { const middle = Math.floor((before + after) / 2); if (formatter.format(middle) === day) before = middle; else after = middle; }
  return after;
}
export function matchFeedbackWindow(completedAtMs: number, serverNowMs: number): 'open' | 'closed' {
  if (!Number.isSafeInteger(serverNowMs) || serverNowMs < completedAtMs) throw new AccessError('FEEDBACK_FINISH_UNVERIFIED', 409, 'The accepted game completion time needs review.');
  return serverNowMs < matchFeedbackClosesAt(completedAtMs) ? 'open' : 'closed';
}

export interface MatchFeedbackBinding { accountId: string; teamId: string; seasonId: string; role: 'manager' | 'player'; playerId?: string | null }
/** Reject a foreign account/scope, extra private fields, or a player's teammate-feedback projection before rendering. */
export function assertMatchFeedbackView(value: unknown, binding: MatchFeedbackBinding): asserts value is MatchFeedbackView {
  const invalid = (): never => { throw new Error('The private match feedback view differs from the current account, player or team scope.'); };
  const exact = (row: Record<string, unknown>, names: readonly string[]) => Object.keys(row).length === names.length && Object.keys(row).every(name => names.includes(name));
  const identifier = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,150}$/.test(id);
  const time = (number: unknown): number is number => typeof number === 'number' && Number.isSafeInteger(number) && number >= 0;
  const note = (text: unknown) => text === null || typeof text === 'string' && Array.from(text).length <= 256 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
  const validEntry = (row: unknown): row is MatchFeedbackEntry => record(row) && exact(row, ['playerId', 'playerLabel', 'rating', 'text', 'revision', 'createdAtMs', 'updatedAtMs']) && identifier(row.playerId) && typeof row.playerLabel === 'string' && row.playerLabel.length > 0 && row.playerLabel.length <= 150 && Number.isInteger(row.rating) && (row.rating as number) >= 1 && (row.rating as number) <= 5 && note(row.text) && time(row.revision) && row.revision >= 1 && time(row.createdAtMs) && time(row.updatedAtMs) && row.updatedAtMs >= row.createdAtMs;
  if (!record(value)) return invalid();
  if (!exact(value, ['kind', 'accountId', 'playerId', 'teamId', 'seasonId', 'audience', 'serverNowMs', 'matches']) || value.kind !== 'match-feedback' || value.accountId !== binding.accountId || value.teamId !== binding.teamId || value.seasonId !== binding.seasonId || value.audience !== binding.role || !time(value.serverNowMs) || !Array.isArray(value.matches) || (binding.role === 'player' ? !identifier(binding.playerId) || value.playerId !== binding.playerId : value.playerId !== null)) invalid();
  const matches = value.matches as unknown[];
  const ids = new Set<string>();
  for (const item of matches) {
    if (!record(item) || !exact(item, ['matchId', 'label', 'playedDate', 'completedAtMs', 'closesAtMs', 'status', 'eligible', 'canEdit', 'own', ...(binding.role === 'manager' ? ['entries'] : [])]) || !matchIdentifier(item.matchId) || ids.has(item.matchId) || typeof item.label !== 'string' || !item.label || item.label.length > 300 || !(item.playedDate === null || typeof item.playedDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.playedDate)) || !['open', 'closed', 'review_required'].includes(String(item.status)) || typeof item.eligible !== 'boolean' || typeof item.canEdit !== 'boolean' || !(item.completedAtMs === null && item.closesAtMs === null || time(item.completedAtMs) && time(item.closesAtMs) && item.closesAtMs > item.completedAtMs)) invalid();
    const match = item as unknown as MatchFeedbackMatch;
    ids.add(match.matchId);
    if (match.status !== 'review_required' && (match.completedAtMs === null || match.closesAtMs === null)) invalid();
    if (match.status === 'open' && !(match.closesAtMs! > (value.serverNowMs as number)) || match.status === 'closed' && !(match.closesAtMs! <= (value.serverNowMs as number))) invalid();
    if (binding.role === 'player') {
      if (match.own !== null && (!validEntry(match.own) || match.own.playerId !== binding.playerId)) invalid();
      if (match.canEdit !== (match.eligible && match.status === 'open')) invalid();
    } else {
      if (match.own !== null || match.canEdit || match.eligible || !Array.isArray(match.entries) || match.entries.some(entry => !validEntry(entry)) || new Set(match.entries.map(entry => entry.playerId)).size !== match.entries.length) invalid();
    }
  }
}
