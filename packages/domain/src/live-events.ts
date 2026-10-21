import type { EffectiveMatchTime, GoalDetails, GoalRecord, MatchState } from './types';

export function cloneValue<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function duration(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer.`);
}

/** Effective time is an explicit active-play coordinate, independent of entry wall time. */
export function effectiveTime(state: MatchState, requested?: EffectiveMatchTime): EffectiveMatchTime {
  if (state.half !== 1 && state.half !== 2) throw new Error('An effective match event requires a started half.');
  const time = requested ?? { half: state.half, halfElapsedMs: state.halfActiveMs, matchElapsedMs: state.matchActiveMs };
  if (time.half !== 1 && time.half !== 2) throw new Error('Effective half must be one or two.');
  duration(time.halfElapsedMs, 'Effective half time');
  duration(time.matchElapsedMs, 'Effective match time');
  if (time.half > state.half) throw new Error('Effective time cannot refer to a half that has not started.');
  const firstHalf = state.firstHalfDurationMs;
  if (time.half === 2 && firstHalf === null) throw new Error('Second-half time requires the recorded actual first-half duration.');
  const expected = (time.half === 2 ? firstHalf ?? 0 : 0) + time.halfElapsedMs;
  if (expected !== time.matchElapsedMs) throw new Error('Effective cumulative time must use actual first-half duration and exclude half-time.');
  const maximum = time.half === 1 && firstHalf !== null ? firstHalf : state.halfActiveMs;
  if (time.halfElapsedMs > maximum || time.matchElapsedMs > state.matchActiveMs) throw new Error('Effective time cannot invent future active play.');
  return { ...time };
}

function wasOnPitch(state: MatchState, playerId: string, time: EffectiveMatchTime): boolean {
  if (time.matchElapsedMs === state.matchActiveMs && time.half === state.half && state.lineup.some(item => item.playerId === playerId)) return true;
  // A goal captured exactly at a change boundary can belong to the just-closed spell.
  return state.intervals.some(interval => interval.playerId === playerId && interval.state === 'playing' &&
    interval.half === time.half && interval.startMs <= time.matchElapsedMs && interval.endMs >= time.matchElapsedMs);
}

export function goalRecord(state: MatchState, details: GoalDetails, eventId: string, recordedAtMs: number): GoalRecord {
  if (details.beneficiary !== 'us' && details.beneficiary !== 'opposition') throw new Error('Goal beneficiary is invalid.');
  if (details.isOwnGoal !== undefined && typeof details.isOwnGoal !== 'boolean') throw new Error('Own-goal classification must be explicit.');
  const isOwnGoal = details.isOwnGoal ?? false;
  const scorerPlayerId = details.scorerPlayerId ?? null;
  const goalType = details.goalType ?? 'not_recorded';
  if (!['open_play', 'free_kick', 'penalty', 'not_recorded'].includes(goalType)) throw new Error('Goal type is invalid.');
  const effective = effectiveTime(state, details.effective);
  if (scorerPlayerId !== null) {
    if (!state.config.selectedPlayerIds.includes(scorerPlayerId)) throw new Error('A scorer must belong to this selected match squad.');
    if ((details.beneficiary === 'us' && isOwnGoal) || (details.beneficiary === 'opposition' && !isOwnGoal)) {
      throw new Error('An opposition scorer or opposition own goal cannot credit a team player.');
    }
    if (!wasOnPitch(state, scorerPlayerId, effective)) throw new Error('The scorer has no recorded on-pitch evidence at the effective goal time. Correct participation separately before attributing this goal.');
  }
  return { eventId, latestEventId: eventId, beneficiary: details.beneficiary, isOwnGoal, scorerPlayerId, goalType, effective, recordedAtMs, voided: false };
}

export function scoresFromGoals(state: MatchState, goals: GoalRecord[]): Pick<MatchState, 'score' | 'halfTimeScore'> {
  const active = goals.filter(goal => !goal.voided);
  const sum = (values: GoalRecord[]) => ({
    for: values.filter(goal => goal.beneficiary === 'us').length,
    against: values.filter(goal => goal.beneficiary === 'opposition').length,
  });
  return {
    score: sum(active),
    halfTimeScore: state.firstHalfDurationMs === null ? state.halfTimeScore : sum(active.filter(goal => goal.effective.half === 1)),
  };
}
