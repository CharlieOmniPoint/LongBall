import type { getCommunityView } from './community';
import type { RecordsActor } from './records';

type CommunityView = ReturnType<typeof getCommunityView>;
export interface ReportCommunitySource {
  accountId: string; teamId: string; seasonId: string; audience: RecordsActor; playerId: string | null; revision: number;
  /** Already authorised server projections only: never raw ballots, moderation or submissions. */
  view: Pick<CommunityView, 'allowed' | 'matches' | 'gallery'>;
}
export interface ReportAwardSummary {
  matchId: string; result: 'winners' | 'no_valid_votes'; winnerLabels: string[];
  voteCutoffAtMs: number; finalisationDeadlineAtMs: number; finalisedAtMs: number; deadlineMissed: boolean;
}
export interface ReportCommunityComposition {
  communityStatus: 'available' | 'not_recorded' | 'withheld' | 'unavailable'; communityRevision: number | null;
  award: ReportAwardSummary | null; publishedAlbum: { matchId: string; photoCount: number } | null;
}
export interface CommunityReportBoundary {
  matchId: string; teamId: string; seasonId: string; visibilityScope: RecordsActor; suppressionReason: string | null;
  appliedFilters: { playerId: string | null };
}
const empty = (communityStatus: ReportCommunityComposition['communityStatus'], communityRevision: number | null = null): ReportCommunityComposition => ({ communityStatus, communityRevision, award: null, publishedAlbum: null });
/** Join both permitted projections; neither a visible award nor a photo overrides a withheld report. */
export function composeReportCommunity(report: CommunityReportBoundary, accountId: string, source?: ReportCommunitySource | null): ReportCommunityComposition {
  if (report.suppressionReason) return empty('withheld');
  if (!source || source.accountId !== accountId || source.teamId !== report.teamId || source.seasonId !== report.seasonId || source.audience !== report.visibilityScope || (report.visibilityScope === 'player' && source.playerId !== report.appliedFilters.playerId) || !Number.isSafeInteger(source.revision) || source.revision < 0 || !source.view.allowed) return empty('unavailable');
  const contexts = source.view.matches.filter(item => item.id === report.matchId);
  if (contexts.length > 1) return empty('unavailable');
  if (contexts.length === 0) return empty('not_recorded', source.revision);
  const match = contexts[0];
  if (match.sharingAllowed !== true) return empty('withheld', source.revision);
  const award = match.award;
  const times = award ? [award.voteCutoffAtMs, award.finalisationDeadlineAtMs, award.finalisedAtMs] : [];
  if (award && (award.matchId !== report.matchId || !['winners', 'no_valid_votes'].includes(award.result) || !times.every(time => Number.isSafeInteger(time) && time >= 0) || award.finalisationDeadlineAtMs < award.voteCutoffAtMs || award.deadlineMissed !== (award.finalisedAtMs > award.finalisationDeadlineAtMs) || !Array.isArray(award.winnerLabels) || award.winnerLabels.some(label => typeof label !== 'string' || !label.trim() || label.length > 120) || (award.result === 'no_valid_votes' ? award.winnerLabels.length !== 0 : award.winnerLabels.length === 0))) return empty('unavailable');
  // Deduplicate published IDs; count only the already-filtered gallery for this exact game.
  const photos = new Set(source.view.gallery.filter(photo => photo.matchId === report.matchId && typeof photo.id === 'string' && photo.id.length > 0).map(photo => photo.id));
  return { communityStatus: 'available', communityRevision: source.revision,
    award: award ? { matchId: report.matchId, result: award.result, winnerLabels: [...award.winnerLabels], voteCutoffAtMs: award.voteCutoffAtMs, finalisationDeadlineAtMs: award.finalisationDeadlineAtMs, finalisedAtMs: award.finalisedAtMs, deadlineMissed: award.deadlineMissed } : null,
    publishedAlbum: { matchId: report.matchId, photoCount: photos.size } };
}
