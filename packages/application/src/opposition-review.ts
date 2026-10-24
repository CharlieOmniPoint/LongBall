import { AccessError } from './access';

export interface OppositionReviewCommand {
  id: string;
  type: 'opposition.review.saved';
  matchId: string;
  expectedRevision: number;
  rating: number;
  note: string | null;
}
export interface OppositionReviewGame {
  matchId: string;
  opponent: string;
  playedDate: string;
  review: { rating: number; note: string | null; revision: number; updatedAtMs: number } | null;
}
export interface OppositionReviewView {
  kind: 'opposition-reviews';
  teamId: string;
  seasonId: string;
  canEdit: boolean;
  games: OppositionReviewGame[];
}
export interface OppositionReviewReceipt {
  kind: 'opposition-review-receipt';
  commandId: string;
  teamId: string;
  seasonId: string;
  matchId: string;
  revision: number;
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,150}$/.test(value);
const note = (value: unknown) => value === null || typeof value === 'string' && Array.from(value).length <= 256 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
export function parseOppositionReviewCommand(value: unknown): OppositionReviewCommand {
  if (!object(value) || Object.keys(value).length !== 6 || Object.keys(value).some(key => !['id','type','matchId','expectedRevision','rating','note'].includes(key)) || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{8,150}$/.test(value.id) || value.type !== 'opposition.review.saved' || !id(value.matchId) || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0 || !Number.isInteger(value.rating) || Number(value.rating) < 1 || Number(value.rating) > 5 || !note(value.note)) throw new AccessError('INVALID_OPPOSITION_REVIEW',400,'Choose an opposition capability rating from 1 to 5 and an optional note of at most 256 characters.');
  return {id:value.id,type:value.type,matchId:value.matchId,expectedRevision:Number(value.expectedRevision),rating:Number(value.rating),note:typeof value.note === 'string' ? value.note.trim() || null : null};
}
export function assertOppositionReviewView(value: unknown, scope: {teamId:string;seasonId:string;role:string}): asserts value is OppositionReviewView {
  if (!object(value) || !['manager','administrator','player'].includes(scope.role) || value.kind !== 'opposition-reviews' || value.teamId !== scope.teamId || value.seasonId !== scope.seasonId || value.canEdit !== ['manager','administrator'].includes(scope.role) || !Array.isArray(value.games)) throw new Error('The opposition reviews do not match the current team access.');
  const seen = new Set<string>();
  for (const game of value.games) {
    if (!object(game) || Object.keys(game).some(key => !['matchId','opponent','playedDate','review'].includes(key)) || !id(game.matchId) || seen.has(game.matchId) || typeof game.opponent !== 'string' || game.opponent.length > 150 || typeof game.playedDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(game.playedDate)) throw new Error('The opposition review list is invalid.');
    seen.add(game.matchId);
    if (game.review !== null && (!object(game.review) || Object.keys(game.review).length !== 4 || !Number.isInteger(game.review.rating) || Number(game.review.rating) < 1 || Number(game.review.rating) > 5 || !note(game.review.note) || !Number.isSafeInteger(game.review.revision) || Number(game.review.revision) < 1 || !Number.isSafeInteger(game.review.updatedAtMs) || Number(game.review.updatedAtMs) < 0)) throw new Error('The opposition review is invalid.');
  }
}
