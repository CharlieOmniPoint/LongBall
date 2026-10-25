import type { AvailabilityResponse } from './preparation';
import type { getCommunityView } from './community';

export interface PlayerHomeOwn {
  team: { id: string };
  season: { id: string };
  profile: { id: string; playerId?: string };
  fixtures: { id: string; opponent: string; playedDate: string; kickoff: string | null; venue: string; status: string; response: AvailabilityResponse }[];
  training: { id: string; date: string; time: string | null; venue: string; status: string; response: AvailabilityResponse; expected: boolean }[];
}
export interface PlayerHomeMatch {
  matchId: string;
  audience: string;
  teamId?: string;
  seasonId?: string;
  ownRecord?: { playerId?: string };
  status?: string;
  sharingRestricted?: boolean;
  score?: { for: number; against: number } | null;
  fixture?: { opponent?: string };
  opponent?: string;
  playedDate?: string;
  lastRecorderSyncAt: number | null;
}
export interface PlayerHomeEvent { id: string; kind: 'match' | 'training'; title: string; date: string | null; time: string | null; venue: string | null; response: AvailabilityResponse }
export interface PlayerHomeAward {
  matchId: string; label: string; status: 'awaiting_result' | 'review_required' | 'final';
  cutoffAtMs: number | null; deadlineAtMs: number | null; deadlineMissed: boolean;
  result: 'winners' | 'no_valid_votes' | null; winnerLabels: string[];
}
export type PlayerHomeCommunity = Pick<ReturnType<typeof getCommunityView>, 'allowed' | 'matches' | 'gallery'>;
const validDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validTime = (value: string | null): boolean => value !== null && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const safeTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const activeStatuses = ['first_half_running', 'first_half_paused', 'half_time', 'second_half_running', 'second_half_paused'];
function londonDay(nowMs: number): string {
  if (!safeTime(nowMs)) throw new Error('A valid observation time is required.');
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs));
  return `${parts.find(item => item.type === 'year')!.value}-${parts.find(item => item.type === 'month')!.value}-${parts.find(item => item.type === 'day')!.value}`;
}
/** Consumes own-player and server-filtered DTOs only. It never reads a manager's raw match state. */
export function selectPlayerHome(input: { own: PlayerHomeOwn | null; community: PlayerHomeCommunity | null; matches: PlayerHomeMatch[]; scope: { teamId: string; seasonId: string; playerId: string }; nowMs: number }) {
  const { own, scope } = input;
  const today = londonDay(input.nowMs);
  const ownAvailable = Boolean(own && own.team.id === scope.teamId && own.season.id === scope.seasonId && (own.profile.playerId ?? own.profile.id) === scope.playerId);
  const accepted = input.matches.filter(item => item.audience === 'player' && item.teamId === scope.teamId && item.seasonId === scope.seasonId && item.ownRecord?.playerId === scope.playerId);
  const recordedIds = new Set(accepted.filter(item => activeStatuses.includes(item.status ?? '') || ['completed', 'abandoned'].includes(item.status ?? '')).map(item => item.matchId));
  const events: PlayerHomeEvent[] = !ownAvailable || !own ? [] : [
    ...own.fixtures.filter(item => item.status === 'scheduled' && !recordedIds.has(item.id)).map(item => ({ id: item.id, kind: 'match' as const, title: item.opponent ? `vs ${item.opponent}` : 'Match · opposition not recorded', date: validDate(item.playedDate) ? item.playedDate : null, time: validTime(item.kickoff) ? item.kickoff : null, venue: item.venue.trim() || null, response: item.response })),
    ...own.training.filter(item => item.status === 'scheduled' && item.expected).map(item => ({ id: item.id, kind: 'training' as const, title: 'Team training', date: validDate(item.date) ? item.date : null, time: validTime(item.time) ? item.time : null, venue: item.venue.trim() || null, response: item.response })),
  ];
  const upcoming = events.filter(item => item.date !== null && item.date >= today).sort((left, right) => left.date!.localeCompare(right.date!) || (left.time && right.time ? left.time.localeCompare(right.time) : 0));
  const sameDay = upcoming[0] ? upcoming.filter(item => item.date === upcoming[0].date) : [];
  const nextCandidates = sameDay.some(item => item.time === null) ? sameDay : sameDay.filter(item => item.time === sameDay[0]?.time);
  const active = accepted.filter(item => activeStatuses.includes(item.status ?? ''));
  const live = active.length === 1 ? active[0] : null;
  const score = live?.score;
  const liveMatch = live?.sharingRestricted === false && score && safeTime(score.for) && safeTime(score.against)
    ? { matchId: live.matchId, status: live.status!, score: { for: score.for, against: score.against }, opponent: live.fixture?.opponent ?? live.opponent ?? null, playedDate: live.playedDate && validDate(live.playedDate) ? live.playedDate : null, lastRecorderSyncAt: safeTime(live.lastRecorderSyncAt) ? live.lastRecorderSyncAt : null } : null;
  const allowed = input.community?.allowed === true ? input.community : null;
  const votes = allowed?.matches.filter(item => item.sharingAllowed && item.mayVote && !item.award && item.finishQuality === 'trusted' && item.cutoffSource !== 'unresolved' &&
    safeTime(item.cutoffAtMs) && input.nowMs < item.cutoffAtMs && safeTime(item.deadlineAtMs) && input.nowMs < item.deadlineAtMs) ?? [];
  // UI05 keeps the post-match outcome visible after the vote action closes. Use
  // only this role-filtered DTO, and never carry candidates/ballots into a result.
  const closed = allowed?.matches.filter(item => item.sharingAllowed && safeTime(item.playedAtMs) &&
    (item.award || safeTime(item.fullTimeAtMs) && (item.finishQuality !== 'trusted' || item.cutoffSource === 'unresolved' || safeTime(item.cutoffAtMs) && input.nowMs >= item.cutoffAtMs))) ?? [];
  const latestClosed = [...closed].sort((left, right) => right.playedAtMs! - left.playedAtMs! || left.id.localeCompare(right.id))[0];
  let award: PlayerHomeAward | null = null;
  if (latestClosed) {
    const final = latestClosed.award;
    const validFinal = final && final.matchId === latestClosed.id &&
      ['winners', 'no_valid_votes'].includes(final.result) &&
      [final.voteCutoffAtMs, final.finalisationDeadlineAtMs, final.finalisedAtMs].every(safeTime) &&
      final.voteCutoffAtMs <= final.finalisationDeadlineAtMs &&
      final.deadlineMissed === (final.finalisedAtMs > final.finalisationDeadlineAtMs) &&
      Array.isArray(final.winnerLabels) && final.winnerLabels.every(label => typeof label === 'string' && label.trim().length > 0 && label.length <= 120) &&
      (final.result === 'no_valid_votes' ? final.winnerLabels.length === 0 : final.winnerLabels.length > 0);
    award = {
      matchId: latestClosed.id, label: latestClosed.label,
      status: validFinal ? 'final' : final || latestClosed.finishQuality !== 'trusted' || latestClosed.cutoffSource === 'unresolved' ? 'review_required' : 'awaiting_result',
      cutoffAtMs: safeTime(latestClosed.cutoffAtMs) ? latestClosed.cutoffAtMs : null,
      deadlineAtMs: safeTime(latestClosed.deadlineAtMs) ? latestClosed.deadlineAtMs : null,
      deadlineMissed: validFinal ? final.deadlineMissed : safeTime(latestClosed.deadlineAtMs) && input.nowMs > latestClosed.deadlineAtMs,
      result: validFinal ? final.result : null,
      winnerLabels: validFinal ? [...final.winnerLabels] : [],
    };
  }
  const gallery = allowed?.gallery.filter(item => safeTime(item.playedAtMs) && Number.isSafeInteger(item.version) && item.version > 0) ?? [];
  const latestPhoto = [...gallery].sort((left, right) => right.playedAtMs - left.playedAtMs)[0] ?? null;
  return {
    today, ownAvailable, next: nextCandidates.length === 1 ? nextCandidates[0] : null, nextCandidates,
    needsOrdering: nextCandidates.length > 1, undated: events.filter(item => item.date === null),
    liveMatch, multipleActiveMatches: active.length > 1, vote: votes[0] ?? null, eligibleVoteCount: votes.length, award, latestPhoto,
  };
}
