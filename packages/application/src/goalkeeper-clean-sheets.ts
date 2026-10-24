/** A clean sheet belongs to a player's recorded goalkeeper stints, not the team's final score. */
export interface GoalkeeperOutcome {
  playerId: string;
  outcome: 'clean_sheet' | 'conceded' | 'unknown';
}
export interface GoalkeeperInterval {
  playerId: string;
  state: string;
  position: string | null;
  startMs: number;
  endMs: number;
}
export function goalkeeperCleanSheetOutcomes(input: {
  completed: boolean;
  reviewRequired: boolean;
  activeDurationMs: number;
  intervals: readonly GoalkeeperInterval[];
  oppositionGoals: readonly { atMs: number | null }[];
  recordedOppositionScore: number | null;
}): GoalkeeperOutcome[] {
  const validMs = (value: number) => Number.isSafeInteger(value) && value >= 0;
  const keepers = [...new Set(input.intervals.filter(row => row.state === 'playing' && row.position === 'GK' && row.endMs > row.startMs).map(row => row.playerId))];
  const valid = input.completed && !input.reviewRequired && validMs(input.activeDurationMs) && input.activeDurationMs > 0
    && input.recordedOppositionScore === input.oppositionGoals.length
    && input.intervals.every(row => validMs(row.startMs) && validMs(row.endMs) && row.endMs >= row.startMs && row.endMs <= input.activeDurationMs)
    && input.oppositionGoals.every(goal => goal.atMs !== null && validMs(goal.atMs) && goal.atMs <= input.activeDurationMs);
  if (!valid) return keepers.map(playerId => ({ playerId, outcome: 'unknown' }));
  const stints = keepers.flatMap(playerId => {
    const rows = input.intervals.filter(row => row.playerId === playerId && row.state === 'playing' && row.position === 'GK' && row.endMs > row.startMs).sort((a,b) => a.startMs - b.startMs);
    const merged: {playerId:string;startMs:number;endMs:number}[] = [];
    for (const row of rows) {
      const last = merged.at(-1);
      if (last && row.startMs <= last.endMs) last.endMs = Math.max(last.endMs, row.endMs);
      else merged.push({playerId,startMs:row.startMs,endMs:row.endMs});
    }
    return merged;
  });
  const conceded = new Set<string>(), uncertain = new Set<string>();
  for (const goal of input.oppositionGoals) {
    // Inclusive candidates preserve a goal recorded exactly at the final whistle.
    // At a keeper-change boundary with no event-order evidence, neither player
    // receives an invented clean sheet; the two affected stints remain unknown.
    const candidates = [...new Set(stints.filter(row => row.startMs <= goal.atMs! && row.endMs >= goal.atMs!).map(row => row.playerId))];
    if (candidates.length === 1) conceded.add(candidates[0]);
    else if (candidates.length > 1) for (const playerId of candidates) uncertain.add(playerId);
    else for (const playerId of keepers) uncertain.add(playerId);
  }
  return keepers.map(playerId => ({playerId,outcome:conceded.has(playerId) ? 'conceded' : uncertain.has(playerId) ? 'unknown' : 'clean_sheet'}));
}
