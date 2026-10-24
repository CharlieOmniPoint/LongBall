import type { SharedMatchRefreshItem } from './shared-match-refresh';
import type { TeamOverviewDto } from './team-overview-service';

/** Use only a current, authorised complete overview. History pages alone cannot prove deletion. */
export function visibleScheduledMatches<T extends SharedMatchRefreshItem>(matches: readonly T[], overview: TeamOverviewDto | null): T[] {
  if (!overview) return [...matches];
  const games = new Map(overview.games.map(game => [game.id, game]));
  return matches.filter(match => {
    const game = games.get(match.matchId);
    if (game && ['cancelled','postponed'].includes(game.status)) return false;
    // Recorded history cannot be removed by schedule management. Preserve legacy
    // history with missing fixture metadata; an absent unplayed item is removed.
    return game !== undefined || (match.status ?? match.state?.status) !== 'preparation';
  });
}
