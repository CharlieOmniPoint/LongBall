import { describe, expect, it } from 'vitest';
import { visibleScheduledMatches } from './scheduled-match-visibility';
import type { TeamOverviewDto } from './team-overview-service';

describe('authoritative schedule changes and shared match caches', () => {
  const overview: TeamOverviewDto = {kind:'team-overview',teamId:'team',seasonId:'season',team:{name:'Roma',ageGroup:'U10',clubName:'Rovers',seasonLabel:'2026'},games:[{id:'next',opponent:'Maple',playedDate:'2026-10-24',status:'scheduled'},{id:'cancelled',opponent:'Oak',playedDate:'2026-10-31',status:'cancelled'},{id:'postponed',opponent:'Hill',playedDate:'2026-11-07',status:'postponed'}]};
  it('evicts cancelled, postponed and deleted preparation rows without dropping accepted history or the next game', () => {
    const rows = [{audience:'spectator' as const,matchId:'deleted',status:'preparation'},{audience:'spectator' as const,matchId:'cancelled',status:'preparation'},{audience:'spectator' as const,matchId:'postponed',status:'preparation'},{audience:'spectator' as const,matchId:'next',status:'preparation'},{audience:'spectator' as const,matchId:'legacy-completed',status:'completed'},{audience:'spectator' as const,matchId:'legacy-active',status:'first_half_running'}];
    expect(visibleScheduledMatches(rows,overview).map(row=>row.matchId)).toEqual(['next','legacy-completed','legacy-active']);
    expect(rows).toHaveLength(6);
  });
  it('does not infer absence from an unavailable overview or a partial history page', () => {
    expect(visibleScheduledMatches([{audience:'spectator' as const,matchId:'unconfirmed',status:'preparation'}],null)).toHaveLength(1);
  });
});
