import type {
  Allocation, ClockReading, ClockSample, MatchConfig, MatchEvent, MatchState,
  PlayerMinutes, Rational, TargetInterval, TargetResult,
} from './types';
export type * from './types';

export const ENGINE_VERSION = 'm0-experiment-1';

function integer(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer.`);
}
function assertSample(sample: ClockSample): void {
  if (!Number.isFinite(sample.monotonicMs) || sample.monotonicMs < 0 || !sample.sessionId) throw new Error('Clock sample is invalid.');
  integer(sample.wallTimeMs, 'Wall time');
}
function isRunning(state: MatchState): boolean {
  return state.status === 'first_half_running' || state.status === 'second_half_running';
}
function isPaused(state: MatchState): boolean {
  return state.status === 'first_half_paused' || state.status === 'second_half_paused';
}
function available(state: MatchState, id: string): boolean {
  return state.availability[id] === true && state.attendance[id] === 'present';
}
function selectedPlayer(state: MatchState, id: string): void {
  if (!state.config.selectedPlayerIds.includes(id)) throw new Error('Player is outside this selected match squad.');
}
function cloneLineup(lineup: Allocation[]): Allocation[] { return lineup.map(item => ({ ...item })); }

export function createMatch(config: MatchConfig): MatchState {
  if (!config.matchId || config.pitchPlaces < 5 || config.pitchPlaces > 11 || !Number.isInteger(config.pitchPlaces)) throw new Error('Match format must have 5–11 pitch places.');
  integer(config.plannedHalfDurationMs, 'Planned half duration');
  if (config.plannedHalfDurationMs < 30_000) throw new Error('Planned half duration must be at least 30 seconds.');
  const ids = config.players.map(player => player.id);
  if (new Set(ids).size !== ids.length || new Set(config.selectedPlayerIds).size !== config.selectedPlayerIds.length) throw new Error('Player identifiers must be unique.');
  if (config.selectedPlayerIds.some(id => !ids.includes(id))) throw new Error('Selected players must belong to this roster.');
  if (config.fixedKeeperId !== null && !config.players.some(player => player.id === config.fixedKeeperId && config.selectedPlayerIds.includes(player.id) && (player.goalkeeperChoice === 1 || player.goalkeeperChoice === 2))) throw new Error('Fixed keeper must be a selected first- or second-choice goalkeeper.');
  return {
    config: { ...config, players: config.players.map(player => ({ ...player })), selectedPlayerIds: [...config.selectedPlayerIds] },
    status: 'preparation', revision: 0,
    attendance: Object.fromEntries(ids.map(id => [id, 'not_recorded'])),
    availability: Object.fromEntries(ids.map(id => [id, config.selectedPlayerIds.includes(id)])),
    stagedLineup: [], lineup: [], half: 0, halfActiveMs: 0, matchActiveMs: 0,
    firstHalfDurationMs: null, anchor: null, recoveryRequired: false,
    intervals: [], targetIntervals: [], score: { for: 0, against: 0 }, halfTimeScore: null,
    completedAtMs: null, completedTimeQuality: null, recoveryReason: null, appliedEvents: {},
  };
}

/** Validation is strict for the initial journey; under-strength exceptions need Q07. */
export function validateLineup(state: MatchState, lineup: Allocation[], requireComplete = true): string[] {
  const errors: string[] = [];
  if (lineup.length > state.config.pitchPlaces || (requireComplete && lineup.length !== state.config.pitchPlaces)) errors.push(`Choose exactly ${state.config.pitchPlaces} pitch players.`);
  if (new Set(lineup.map(item => item.playerId)).size !== lineup.length) errors.push('A player can occupy only one pitch place.');
  if (new Set(lineup.map(item => item.slotId)).size !== lineup.length) errors.push('Each pitch slot must be unique.');
  for (const item of lineup) {
    if (!item.slotId || !item.position) errors.push('Every allocation needs a slot and position.');
    if (!state.config.selectedPlayerIds.includes(item.playerId)) errors.push('Only selected match-squad players can start.');
    else {
      if (state.attendance[item.playerId] !== 'present') errors.push(`${item.playerId}: confirm actual attendance first.`);
      if (!state.availability[item.playerId]) errors.push(`${item.playerId}: player is unavailable.`);
    }
  }
  const keepers = lineup.filter(item => item.position === 'GK');
  if (requireComplete && keepers.length !== 1) errors.push('Choose exactly one goalkeeper.');
  if (keepers.length > 1) errors.push('Only one goalkeeper place is allowed.');
  for (const keeper of keepers) {
    const player = state.config.players.find(item => item.id === keeper.playerId);
    if (!player || (player.goalkeeperChoice !== 1 && player.goalkeeperChoice !== 2)) errors.push('Goalkeeper cover requires a first- or second-choice eligible keeper.');
    if (state.config.fixedKeeperId && keeper.playerId !== state.config.fixedKeeperId) errors.push('The fixed keeper policy cannot be changed by moving a pitch piece.');
  }
  const qualifying = state.config.players.filter(player => available(state, player.id) && (player.goalkeeperChoice === 1 || player.goalkeeperChoice === 2));
  if (state.config.fixedKeeperId && qualifying.length > 1) errors.push('Multiple qualifying available keepers require a reviewed shared-keeper policy.');
  return [...new Set(errors)];
}

/** Rendering never increments a timer and never guesses elapsed time from UTC. */
export function readClock(state: MatchState, sample: ClockSample): ClockReading {
  assertSample(sample);
  let halfActiveMs = state.halfActiveMs;
  let matchActiveMs = state.matchActiveMs;
  let recoveryRequired = state.recoveryRequired;
  if (isRunning(state)) {
    const anchor = state.anchor;
    if (!anchor || anchor.sample.sessionId !== sample.sessionId || sample.monotonicMs < anchor.sample.monotonicMs) recoveryRequired = true;
    if (!recoveryRequired && anchor) {
      const delta = Math.floor(sample.monotonicMs) - Math.floor(anchor.sample.monotonicMs);
      halfActiveMs = anchor.halfActiveMs + delta;
      matchActiveMs = anchor.matchActiveMs + delta;
    }
  }
  return {
    halfActiveMs, matchActiveMs,
    remainingMs: Math.max(0, state.config.plannedHalfDurationMs - halfActiveMs),
    addedMs: Math.max(0, halfActiveMs - state.config.plannedHalfDurationMs),
    recoveryRequired,
  };
}

function accrue(state: MatchState, sample: ClockSample): MatchState {
  const clock = readClock(state, sample);
  if (clock.recoveryRequired) throw new Error('Time needs checking. Confirm the clock against a referee or trusted source.');
  const durationMs = clock.matchActiveMs - state.matchActiveMs;
  if (!isRunning(state) || durationMs === 0) return state;
  if (state.half !== 1 && state.half !== 2) throw new Error('No active half.');
  const intervals = state.config.selectedPlayerIds.map(playerId => {
    const allocation = state.lineup.find(item => item.playerId === playerId);
    const eligible = available(state, playerId);
    return {
      playerId, state: allocation ? 'playing' as const : eligible ? 'available_bench' as const : 'unavailable' as const,
      position: allocation?.position ?? null, slotId: allocation?.slotId ?? null,
      startMs: state.matchActiveMs, endMs: clock.matchActiveMs, half: state.half as 1 | 2,
    };
  });
  return {
    ...state, halfActiveMs: clock.halfActiveMs, matchActiveMs: clock.matchActiveMs,
    anchor: { sample: { ...sample }, halfActiveMs: clock.halfActiveMs, matchActiveMs: clock.matchActiveMs },
    intervals: [...state.intervals, ...intervals],
    targetIntervals: [...state.targetIntervals, {
      durationMs, availablePlayerIds: state.config.selectedPlayerIds.filter(id => available(state, id)),
      pitchPlaces: state.config.pitchPlaces,
      fixedKeeperId: state.config.fixedKeeperId && available(state, state.config.fixedKeeperId) ? state.config.fixedKeeperId : null,
    }],
  };
}
function ensureLive(state: MatchState): void {
  if (!isRunning(state) && !isPaused(state)) throw new Error('This command requires an active half.');
}
function assertLineup(state: MatchState, lineup: Allocation[]): void {
  const errors = validateLineup(state, lineup);
  if (errors.length) throw new Error(errors.join(' '));
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Local experiment command reducer. Persist event and returned projection atomically. */
export function reduceMatch(previous: MatchState, event: MatchEvent): MatchState {
  if (!event.id) throw new Error('Event id is required.');
  const signature = canonical(event);
  if (previous.appliedEvents[event.id]) {
    if (previous.appliedEvents[event.id] !== signature) throw new Error('Event id was reused with different content.');
    return previous;
  }
  assertSample(event.sample);
  if (previous.status === 'completed') throw new Error('Completed match is read-only; audited corrections are not implemented in M0.');
  let state = previous;
  if (event.type !== 'clock.recovery_required' && event.type !== 'clock.corrected') state = accrue(previous, event.sample);
  switch (event.type) {
    case 'attendance.recorded': {
      selectedPlayer(state, event.playerId);
      state = { ...state, attendance: { ...state.attendance, [event.playerId]: event.status } };
      if (event.status !== 'present') state = { ...state, lineup: state.lineup.filter(item => item.playerId !== event.playerId), stagedLineup: state.stagedLineup.filter(item => item.playerId !== event.playerId) };
      break;
    }
    case 'availability.changed': {
      selectedPlayer(state, event.playerId);
      state = { ...state, availability: { ...state.availability, [event.playerId]: event.available } };
      if (!event.available) state = { ...state, lineup: state.lineup.filter(item => item.playerId !== event.playerId), stagedLineup: state.stagedLineup.filter(item => item.playerId !== event.playerId) };
      break;
    }
    case 'lineup.staged': {
      if (state.status !== 'preparation' && state.status !== 'half_time') throw new Error('Only preparation and half-time have a staged lineup.');
      const errors = validateLineup(state, event.lineup, false);
      if (errors.length) throw new Error(errors.join(' '));
      state = { ...state, stagedLineup: cloneLineup(event.lineup) };
      break;
    }
    case 'half.started': {
      if (state.status !== 'preparation' && state.status !== 'half_time') throw new Error('A half can start only from preparation or half-time.');
      assertLineup(state, state.stagedLineup);
      const half = state.status === 'preparation' ? 1 : 2;
      state = {
        ...state, half, status: half === 1 ? 'first_half_running' : 'second_half_running',
        lineup: cloneLineup(state.stagedLineup), halfActiveMs: 0,
        anchor: { sample: { ...event.sample }, halfActiveMs: 0, matchActiveMs: state.matchActiveMs },
      };
      break;
    }
    case 'half.paused': {
      if (!isRunning(state)) throw new Error('Only a running half can pause.');
      state = { ...state, status: state.half === 1 ? 'first_half_paused' : 'second_half_paused', anchor: null };
      break;
    }
    case 'half.resumed': {
      if (!isPaused(state)) throw new Error('Only a paused half can resume.');
      assertLineup(state, state.lineup);
      state = { ...state, status: state.half === 1 ? 'first_half_running' : 'second_half_running', anchor: { sample: { ...event.sample }, halfActiveMs: state.halfActiveMs, matchActiveMs: state.matchActiveMs } };
      break;
    }
    case 'half.ended': {
      ensureLive(state);
      if (state.half === 1) state = { ...state, status: 'half_time', anchor: null, firstHalfDurationMs: state.halfActiveMs, halfTimeScore: { ...state.score }, stagedLineup: cloneLineup(state.lineup) };
      else state = { ...state, status: 'completed', anchor: null, completedAtMs: event.sample.wallTimeMs, completedTimeQuality: 'reviewRequired' };
      break;
    }
    case 'lineup.committed': {
      ensureLive(state);
      if (event.sourceRevision !== previous.revision) throw new Error('Lineup draft is stale. Review against the current match revision.');
      assertLineup(state, event.lineup);
      state = { ...state, lineup: cloneLineup(event.lineup) };
      break;
    }
    case 'goal.recorded': {
      ensureLive(state);
      state = { ...state, score: { for: state.score.for + (event.beneficiary === 'us' ? 1 : 0), against: state.score.against + (event.beneficiary === 'opposition' ? 1 : 0) } };
      break;
    }
    case 'clock.recovery_required': {
      if (!isRunning(state)) throw new Error('Only a running clock needs continuity recovery.');
      if (!event.reason.trim()) throw new Error('A recovery reason is required.');
      state = { ...state, recoveryRequired: true, recoveryReason: event.reason };
      break;
    }
    case 'clock.corrected': {
      ensureLive(state);
      if (!isRunning(state) || !(state.recoveryRequired || readClock(state, event.sample).recoveryRequired)) throw new Error('Clock correction is only available for an uncertain running-clock recovery.');
      if (event.confirmUnchangedLineup !== true) throw new Error('Confirm unchanged lineup and availability since the secure checkpoint, or reconcile history separately.');
      if (!event.reason.trim()) throw new Error('Record the referee/trusted-source reason for a clock correction.');
      integer(event.halfActiveMs, 'Corrected active half time');
      if (event.halfActiveMs < state.halfActiveMs) throw new Error('Backdated clock correction needs audited history reconciliation, outside this M0 slice.');
      const newMatchMs = (state.half === 2 ? state.firstHalfDurationMs ?? 0 : 0) + event.halfActiveMs;
      if (newMatchMs < state.matchActiveMs) throw new Error('Clock correction cannot discard recorded participation.');
      // A controller-confirmed forward correction fills the unchanged last secure lineup only.
      // No wall-clock inference is involved; original command remains in the journal.
      if (isRunning(state) && newMatchMs > state.matchActiveMs) {
        const syntheticSample = { ...event.sample, sessionId: 'explicit-referee-correction', monotonicMs: newMatchMs - state.matchActiveMs };
        state = accrue({ ...state, recoveryRequired: false, anchor: { sample: { ...syntheticSample, monotonicMs: 0 }, halfActiveMs: state.halfActiveMs, matchActiveMs: state.matchActiveMs } }, syntheticSample);
      }
      state = { ...state, halfActiveMs: event.halfActiveMs, matchActiveMs: newMatchMs, recoveryRequired: false, recoveryReason: null, anchor: isRunning(state) ? { sample: { ...event.sample }, halfActiveMs: event.halfActiveMs, matchActiveMs: newMatchMs } : null };
      break;
    }
  }
  return { ...state, revision: previous.revision + 1, appliedEvents: { ...previous.appliedEvents, [event.id]: signature } };
}

export function replayMatch(config: MatchConfig, events: MatchEvent[]): MatchState {
  return events.reduce(reduceMatch, createMatch(config));
}

export function playerMinutes(state: MatchState, sample: ClockSample): PlayerMinutes[] {
  // An unproved source contributes no invented post-checkpoint duration.
  const clock = readClock(state, sample);
  const projected = clock.recoveryRequired ? state : accrue(state, sample);
  return state.config.selectedPlayerIds.map(playerId => {
    const result: PlayerMinutes = { playerId, playingMs: 0, benchMs: 0, unavailableMs: 0, positionMs: {} };
    for (const interval of projected.intervals.filter(item => item.playerId === playerId)) {
      const durationMs = interval.endMs - interval.startMs;
      if (interval.state === 'playing') {
        result.playingMs += durationMs;
        if (interval.position) result.positionMs[interval.position] = (result.positionMs[interval.position] ?? 0) + durationMs;
      } else if (interval.state === 'available_bench') result.benchMs += durationMs;
      else result.unavailableMs += durationMs;
    }
    return result;
  });
}

function gcd(left: bigint, right: bigint): bigint { return right === 0n ? left : gcd(right, left % right); }
export function rational(numerator: bigint, denominator = 1n): Rational {
  if (denominator <= 0n || numerator < 0n) throw new Error('Rational target must be nonnegative with a positive denominator.');
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}
function add(left: Rational, right: Rational): Rational { return rational(left.numerator * right.denominator + right.numerator * left.denominator, left.denominator * right.denominator); }
function scale(value: Rational, numerator: bigint, denominator: bigint): Rational { return rational(value.numerator * numerator, value.denominator * denominator); }
export function rationalToNumber(value: Rational): number { return Number(value.numerator) / Number(value.denominator); }
export function withinTargetBand(actualMs: number, target: TargetResult): boolean {
  integer(actualMs, 'Actual playing time');
  const actual = BigInt(actualMs);
  return actual * target.lower.denominator >= target.lower.numerator && actual * target.upper.denominator <= target.upper.numerator;
}

/** Exact ME20 arithmetic experiment. Q07 policy acceptance and a solver remain open. */
export function calculateTargets(intervals: TargetInterval[], allPlayerIds: string[] = []): TargetResult[] {
  const totals = new Map<string, Rational>(allPlayerIds.map(id => [id, rational(0n)]));
  for (const interval of intervals) {
    integer(interval.durationMs, 'Target interval duration');
    integer(interval.pitchPlaces, 'Target pitch capacity');
    const ids = interval.availablePlayerIds;
    if (new Set(ids).size !== ids.length) throw new Error('Target interval repeats an available player.');
    if (interval.fixedKeeperId && !ids.includes(interval.fixedKeeperId)) throw new Error('Fixed keeper is not available in this target interval.');
    const count = ids.length;
    const capacity = Math.min(interval.pitchPlaces, count);
    if (capacity === 0) continue;
    for (const playerId of ids) {
      let contribution: Rational;
      if (playerId === interval.fixedKeeperId) contribution = rational(BigInt(interval.durationMs));
      else if (interval.fixedKeeperId) contribution = rational(BigInt(interval.durationMs) * BigInt(capacity - 1), BigInt(count - 1));
      else contribution = rational(BigInt(interval.durationMs) * BigInt(capacity), BigInt(count));
      totals.set(playerId, add(totals.get(playerId) ?? rational(0n), contribution));
    }
  }
  return [...totals].map(([playerId, target]) => ({ playerId, target, lower: scale(target, 9n, 10n), upper: scale(target, 11n, 10n) }));
}

export function currentTargets(state: MatchState, sample: ClockSample): TargetResult[] {
  const clock = readClock(state, sample);
  const projected = clock.recoveryRequired ? state : accrue(state, sample);
  return calculateTargets(projected.targetIntervals, state.config.selectedPlayerIds);
}

export interface GridCapacityProof {
  status: 'proved_infeasible_under_grid';
  reason: string;
  requiredOutfieldMs: number;
  minimumAllowedPerPlayerMs: number;
  maximumAllowedPerPlayerMs: number;
}

/**
 * Narrow FV06 arithmetic certificate for uniform availability and one fixed keeper.
 * Returning null means no capacity contradiction was proved; it does not prove a plan.
 */
export function proveFixedKeeperGridContradiction(input: {
  actualDurationMs: number;
  pitchPlaces: number;
  outfieldPlayerCount: number;
  gridMs: number;
}): GridCapacityProof | null {
  for (const [key, value] of Object.entries(input)) integer(value, key);
  if (input.outfieldPlayerCount === 0 || input.gridMs === 0 || input.pitchPlaces < 2) throw new Error('Grid proof requires outfield players, capacity and a positive grid.');
  const duration = BigInt(input.actualDurationMs);
  const places = BigInt(Math.min(input.pitchPlaces - 1, input.outfieldPlayerCount));
  const count = BigInt(input.outfieldPlayerCount);
  const grid = BigInt(input.gridMs);
  const required = duration * places;
  const lowerNumerator = required * 9n;
  const upperNumerator = required * 11n;
  const bandDenominator = count * 10n;
  const minimum = ((lowerNumerator + bandDenominator * grid - 1n) / (bandDenominator * grid)) * grid;
  const maximum = (upperNumerator / (bandDenominator * grid)) * grid;
  if (minimum <= maximum && minimum * count <= required && maximum * count >= required) return null;
  return {
    status: 'proved_infeasible_under_grid',
    reason: `Strict grid permits ${Number(minimum) / 60_000}–${Number(maximum) / 60_000} minutes per outfielder; that cannot fill ${Number(required) / 60_000} outfield player-minutes inside every individual ±10% band.`,
    requiredOutfieldMs: Number(required),
    minimumAllowedPerPlayerMs: Number(minimum),
    maximumAllowedPerPlayerMs: Number(maximum),
  };
}

/** Projection assumes current confirmed attendance/availability and fixed policy continue. */
export function projectedTargets(state: MatchState, sample: ClockSample): TargetResult[] {
  const clock = readClock(state, sample);
  if (clock.recoveryRequired) throw new Error('Time needs checking before projecting remaining opportunity.');
  const checkpoint = accrue(state, sample);
  let futureMs = 0;
  if (state.status === 'preparation') futureMs = state.config.plannedHalfDurationMs * 2;
  else if (state.status === 'half_time') futureMs = state.config.plannedHalfDurationMs;
  else if (isRunning(state) || isPaused(state)) futureMs = Math.max(0, state.config.plannedHalfDurationMs - clock.halfActiveMs) + (state.half === 1 ? state.config.plannedHalfDurationMs : 0);
  const future: TargetInterval = {
    durationMs: futureMs,
    availablePlayerIds: state.config.selectedPlayerIds.filter(id => available(state, id)),
    pitchPlaces: state.config.pitchPlaces,
    fixedKeeperId: state.config.fixedKeeperId && available(state, state.config.fixedKeeperId) ? state.config.fixedKeeperId : null,
  };
  return calculateTargets([...checkpoint.targetIntervals, future], state.config.selectedPlayerIds);
}
