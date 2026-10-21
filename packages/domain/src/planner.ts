import { calculateTargets, rational, rationalToNumber, withinTargetBand } from './index';
import type { Allocation, Rational, TargetInterval, TargetResult } from './types';

export const PLANNER_VERSION = 'longball-planner-1';
export interface PlannerPlayer {
  id: string;
  goalkeeperChoice: number;
  /** Eligibility is an explicit manager decision; preference alone never enables a position. */
  eligiblePositions: string[];
  /** Distinct position types, in first/second/third order. */
  preferences: string[];
}
export interface PlannerSlot { slotId: string; position: string }
export type KeeperPolicy =
  | { kind: 'fixed'; playerId: string }
  | { kind: 'shared'; eligibleKeeperIds: string[] }
  | { kind: 'approved_cover'; playerIds: string[]; approvalReference: string };
export interface PastTargetSegment extends TargetInterval { keeperIds: string[] }
export interface FutureSegment {
  startMs: number;
  endMs: number;
  half: 1 | 2;
  halfStartMs: number;
  plannedHalfMs: number;
  availablePlayerIds: string[];
  goalkeeperPolicy: KeeperPolicy;
  availabilityBasis: 'confirmed' | 'expected';
  /** Explicit competition/manager authorisation; never a universal minimum rule. */
  underStrengthApproval: string | null;
}
export interface PlannerLock { playerId: string; slotId: string; startMs: number; endMs: number }
export interface PlannerSettings {
  /** Q07 interval/keeper policy is experimental until separately approved. */
  policyStatus: 'synthetic_experiment' | 'accepted_for_match';
  preferredMinSpellMs: number;
  preferredBufferFraction: number;
  preferredBatchSize: number;
  hardMinSpellMs: number | null;
  hardBufferFraction: number | null;
  hardBatchCap: number | null;
  hardSubstitutionGridMs: number | null;
  /** Explicit accepted position weights: rank 1, rank 2, rank 3, approved unranked cover. */
  normalPositionCosts: [number, number, number, number];
  adventurousPositionCosts: [number, number, number, number];
  positionMode: 'normal' | 'adventurous';
  /** Deterministic operation budget; callers also measure actual device execution time. */
  maxWork: number;
}
export interface PlannerInput {
  planId: string;
  planVersion: number;
  sourceRevision: number;
  seed: string;
  nowMs: number;
  players: PlannerPlayer[];
  slots: PlannerSlot[];
  currentLineup: Allocation[];
  currentSpellStartedMs: Record<string, number>;
  actual: Record<string, { playingMs: number; goalkeeperMs: number }>;
  pastTargetSegments: PastTargetSegment[];
  futureSegments: FutureSegment[];
  locks: PlannerLock[];
  settings: PlannerSettings;
}
export interface ScheduledLineup {
  startMs: number;
  endMs: number;
  half: 1 | 2;
  lineup: Allocation[];
  requiresConfirmation: true;
}
export interface PlannerPlayerResult {
  playerId: string;
  actualMs: number;
  projectedMs: number;
  target: Rational;
  lower: Rational;
  upper: Rational;
  withinBand: boolean;
  goalkeeperTarget: Rational;
  projectedGoalkeeperMs: number;
}
export interface PlannerChange {
  dueMatchActiveMs: number;
  half: 1 | 2;
  outgoingPlayerIds: string[];
  incomingPlayerIds: string[];
  lineup: Allocation[];
  requiresConfirmation: true;
  explanation: string;
  exceptions: string[];
}
export interface PlannerProof {
  kind: 'invalid_input' | 'missing_keeper' | 'position_capacity' | 'past_excess' | 'insufficient_opportunity' | 'strict_grid_capacity' | 'keeper_history';
  detail: string;
  playerIds: string[];
}
export interface PlannerResult {
  status: 'feasible' | 'infeasible' | 'indeterminate';
  planId: string;
  planVersion: number;
  sourceRevision: number;
  engineVersion: string;
  seed: string;
  schedule: ScheduledLineup[];
  /** A suggestion never changes actual state, even when due. */
  nextChange: PlannerChange | null;
  players: PlannerPlayerResult[];
  proof: PlannerProof | null;
  explanations: string[];
  assumptions: string[];
  diagnostics: { work: number; budgetExhausted: boolean; strategiesTried: number; fairBands: boolean; equalKeeperDuties: boolean };
}

class BudgetExceeded extends Error {}
class WorkBudget {
  used = 0;
  constructor(readonly maximum: number) {}
  spend(units = 1) { this.used += units; if (this.used > this.maximum) throw new BudgetExceeded(); }
}
function integer(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative integer.`);
}
function add(left: Rational, right: Rational): Rational {
  return rational(left.numerator * right.denominator + right.numerator * left.denominator, left.denominator * right.denominator);
}
function fractionCompare(integerValue: number, value: Rational): number {
  const difference = BigInt(integerValue) * value.denominator - value.numerator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
function seededRank(seed: string, id: string): number {
  let hash = 2166136261;
  for (const character of `${seed}\0${id}`) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}
function sortedIds(input: PlannerInput, ids: string[]): string[] {
  return [...ids].sort((left, right) => seededRank(input.seed, left) - seededRank(input.seed, right) || (left < right ? -1 : left > right ? 1 : 0));
}
function policyKeepers(segment: FutureSegment): string[] {
  const policy = segment.goalkeeperPolicy;
  return policy.kind === 'fixed' ? [policy.playerId] : policy.kind === 'shared' ? policy.eligibleKeeperIds : policy.playerIds;
}
function fixedKeeper(segment: FutureSegment): string | null { return segment.goalkeeperPolicy.kind === 'fixed' ? segment.goalkeeperPolicy.playerId : null; }
function totalTargets(input: PlannerInput): TargetResult[] {
  return calculateTargets([...input.pastTargetSegments, ...input.futureSegments.map(segment => ({
    durationMs: segment.endMs - segment.startMs, availablePlayerIds: segment.availablePlayerIds,
    pitchPlaces: input.slots.length, fixedKeeperId: fixedKeeper(segment),
  }))], input.players.map(player => player.id));
}
function keeperTargets(input: PlannerInput): Record<string, Rational> {
  const totals = Object.fromEntries(input.players.map(player => [player.id, rational(0n)]));
  for (const segment of input.pastTargetSegments) {
    const ids = segment.fixedKeeperId ? [segment.fixedKeeperId] : segment.keeperIds;
    if (!ids.length && segment.durationMs) continue;
    for (const id of ids) totals[id] = add(totals[id] ?? rational(0n), rational(BigInt(segment.durationMs), BigInt(ids.length)));
  }
  for (const segment of input.futureSegments) {
    const ids = policyKeepers(segment);
    for (const id of ids) totals[id] = add(totals[id], rational(BigInt(segment.endMs - segment.startMs), BigInt(ids.length)));
  }
  return totals;
}
function opportunity(input: PlannerInput, playerId: string, afterMs: number, role: 'any' | 'keeper' = 'any'): number {
  let total = 0;
  for (const segment of input.futureSegments) {
    if (segment.endMs <= afterMs || !segment.availablePlayerIds.includes(playerId)) continue;
    if (role === 'keeper' && !policyKeepers(segment).includes(playerId)) continue;
    total += segment.endMs - Math.max(segment.startMs, afterMs);
  }
  return total;
}
function sameLineup(left: Allocation[], right: Allocation[]): boolean {
  return left.length === right.length && left.every(item => right.some(other => other.slotId === item.slotId && other.position === item.position && other.playerId === item.playerId));
}
function playersOn(lineup: Allocation[]) { return new Set(lineup.map(item => item.playerId)); }
function changedPlayers(left: Allocation[], right: Allocation[]) {
  const before = playersOn(left); const after = playersOn(right);
  return { outgoing: [...before].filter(id => !after.has(id)), incoming: [...after].filter(id => !before.has(id)) };
}

function validateInput(input: PlannerInput): PlannerProof | null {
  try {
    integer(input.nowMs, 'Current active time'); integer(input.settings.maxWork, 'Work budget');
    integer(input.planVersion, 'Plan version'); integer(input.sourceRevision, 'Source revision');
    if (!input.planId || !input.seed) throw new Error('Plan id and stored deterministic seed are required.');
    if (input.slots.length < 5 || input.slots.length > 11 || new Set(input.slots.map(slot => slot.slotId)).size !== input.slots.length || input.slots.filter(slot => slot.position === 'GK').length !== 1) throw new Error('Use 5–11 distinct slots with exactly one goalkeeper slot.');
    const ids = input.players.map(player => player.id);
    if (new Set(ids).size !== ids.length || ids.some(id => !id || id.startsWith('vacant-'))) throw new Error('Player ids must be distinct and nonempty.');
    for (const player of input.players) {
      if (new Set(player.eligiblePositions).size !== player.eligiblePositions.length) throw new Error('Position eligibility contains duplicate types.');
      if (player.preferences.length > 3) throw new Error('Use at most three position preferences.');
      integer(input.actual[player.id]?.playingMs ?? 0, 'Actual playing time');
      integer(input.actual[player.id]?.goalkeeperMs ?? 0, 'Actual goalkeeper time');
      if ((input.actual[player.id]?.playingMs ?? 0) > input.nowMs) throw new Error('Actual playing time exceeds known active match time.');
      if ((input.actual[player.id]?.goalkeeperMs ?? 0) > (input.actual[player.id]?.playingMs ?? 0)) throw new Error('Actual goalkeeper time exceeds actual playing time.');
    }
    for (const segment of input.pastTargetSegments) {
      integer(segment.durationMs, 'Historical target duration'); integer(segment.pitchPlaces, 'Historical pitch capacity');
      if (segment.pitchPlaces < 5 || segment.pitchPlaces > 11 || new Set(segment.availablePlayerIds).size !== segment.availablePlayerIds.length || segment.availablePlayerIds.some(id => !ids.includes(id))) throw new Error('Historical target interval contains an invalid capacity or available-player set.');
      if (new Set(segment.keeperIds).size !== segment.keeperIds.length || segment.keeperIds.some(id => !segment.availablePlayerIds.includes(id)) || segment.fixedKeeperId && !segment.availablePlayerIds.includes(segment.fixedKeeperId)) throw new Error('Historical keeper evidence is invalid.');
      if (segment.durationMs && !segment.fixedKeeperId && !segment.keeperIds.length) throw new Error('Historical goalkeeper-sharing evidence is missing; do not infer it from current profiles.');
    }
    if (input.players.reduce((sum, player) => sum + (input.actual[player.id]?.goalkeeperMs ?? 0), 0) > input.nowMs) throw new Error('Recorded goalkeeper intervals overlap in aggregate.');
    if (input.pastTargetSegments.reduce((sum, segment) => sum + segment.durationMs, 0) !== input.nowMs) throw new Error('Known target history must cover all actual active time; incomplete history requires review.');
    let cursor = input.nowMs;
    for (const segment of input.futureSegments) {
      integer(segment.startMs, 'Segment start'); integer(segment.endMs, 'Segment end'); integer(segment.halfStartMs, 'Half start'); integer(segment.plannedHalfMs, 'Half duration');
      if (segment.startMs !== cursor || segment.endMs <= segment.startMs || segment.halfStartMs > segment.startMs || segment.plannedHalfMs === 0) throw new Error('Future active-time segments must be contiguous and nonempty with a valid half anchor.');
      if (new Set(segment.availablePlayerIds).size !== segment.availablePlayerIds.length || segment.availablePlayerIds.some(id => !ids.includes(id))) throw new Error('Future availability contains duplicate or unknown players.');
      const qualifying = segment.availablePlayerIds.filter(id => input.players.some(player => player.id === id && (player.goalkeeperChoice === 1 || player.goalkeeperChoice === 2) && player.eligiblePositions.includes('GK')));
      const keepers = policyKeepers(segment);
      if (!keepers.length) return { kind: 'missing_keeper', detail: 'No approved eligible goalkeeper covers a future interval. Ask for explicit willing cover.', playerIds: [] };
      if (new Set(keepers).size !== keepers.length || keepers.some(id => !segment.availablePlayerIds.includes(id) || !input.players.find(player => player.id === id)?.eligiblePositions.includes('GK'))) return { kind: 'missing_keeper', detail: 'Goalkeeper policy names an unavailable or ineligible player.', playerIds: keepers };
      if (segment.goalkeeperPolicy.kind === 'fixed' && (qualifying.length !== 1 || qualifying[0] !== segment.goalkeeperPolicy.playerId)) throw new Error('A fixed exemption requires exactly one qualifying available goalkeeper.');
      if (segment.goalkeeperPolicy.kind === 'shared' && (qualifying.length < 2 || qualifying.length !== keepers.length || qualifying.some(id => !keepers.includes(id)))) throw new Error('All qualifying available keepers must share duties in the common total-minute pool.');
      if (segment.goalkeeperPolicy.kind === 'approved_cover' && (qualifying.length || !segment.goalkeeperPolicy.approvalReference.trim())) throw new Error('Temporary cover needs explicit approval and cannot silently replace the normal qualifying pool.');
      if (segment.availablePlayerIds.length < input.slots.length && !segment.underStrengthApproval?.trim()) throw new Error('Under-strength play requires explicit competition/manager approval.');
      cursor = segment.endMs;
    }
    const settings = input.settings;
    for (const [key, value] of Object.entries({ preferredMinSpellMs: settings.preferredMinSpellMs, preferredBatchSize: settings.preferredBatchSize })) integer(value, key);
    if (!settings.preferredBatchSize || settings.preferredBufferFraction < 0 || settings.preferredBufferFraction >= 0.5) throw new Error('Substitution preferences must be explicit valid values.');
    for (const value of [settings.hardMinSpellMs, settings.hardSubstitutionGridMs, settings.hardBatchCap]) if (value !== null) integer(value, 'Hard constraint');
    if (settings.hardSubstitutionGridMs === 0 || settings.hardBufferFraction !== null && (settings.hardBufferFraction < 0 || settings.hardBufferFraction >= 0.5)) throw new Error('Hard timing constraint is invalid.');
    for (const costs of [settings.normalPositionCosts, settings.adventurousPositionCosts]) if (costs.length !== 4 || costs.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Position weights must be explicit nonnegative finite values.');
    for (const lock of input.locks) if (!ids.includes(lock.playerId) || !input.slots.some(slot => slot.slotId === lock.slotId) || lock.startMs < input.nowMs || lock.endMs <= lock.startMs) throw new Error('Manager lock is invalid.');
    for (const allocation of input.currentLineup) {
      if (!ids.includes(allocation.playerId) || !input.slots.some(slot => slot.slotId === allocation.slotId && slot.position === allocation.position)) throw new Error('Current lineup has an unknown allocation.');
      if (input.settings.hardMinSpellMs !== null && input.currentSpellStartedMs[allocation.playerId] === undefined) throw new Error('Hard minimum spells need the actual current spell-start evidence.');
    }
    if (new Set(input.currentLineup.map(item => item.playerId)).size !== input.currentLineup.length || new Set(input.currentLineup.map(item => item.slotId)).size !== input.currentLineup.length) throw new Error('Current lineup duplicates a player or slot.');
    return null;
  } catch (error) { return { kind: 'invalid_input', detail: error instanceof Error ? error.message : 'Invalid planner input.', playerIds: [] }; }
}

const FORBIDDEN = 1e12;
/** Rectangular minimum-cost bipartite assignment; no inferred player ability. */
function assign(costs: number[][], budget: WorkBudget): number[] | null {
  const rows = costs.length; const columns = costs[0]?.length ?? 0;
  if (columns < rows) return null;
  const u = Array(rows + 1).fill(0) as number[]; const v = Array(columns + 1).fill(0) as number[];
  const p = Array(columns + 1).fill(0) as number[]; const way = Array(columns + 1).fill(0) as number[];
  for (let row = 1; row <= rows; row++) {
    p[0] = row; let column = 0;
    const min = Array(columns + 1).fill(Infinity) as number[];
    const used = Array(columns + 1).fill(false) as boolean[];
    do {
      used[column] = true; const currentRow = p[column]; let delta = Infinity; let next = 0;
      for (let candidate = 1; candidate <= columns; candidate++) {
        budget.spend();
        if (used[candidate]) continue;
        const reduced = costs[currentRow - 1][candidate - 1] - u[currentRow] - v[candidate];
        if (reduced < min[candidate]) { min[candidate] = reduced; way[candidate] = column; }
        if (min[candidate] < delta) { delta = min[candidate]; next = candidate; }
      }
      if (!Number.isFinite(delta)) return null;
      for (let candidate = 0; candidate <= columns; candidate++) if (used[candidate]) { u[p[candidate]] += delta; v[candidate] -= delta; } else min[candidate] -= delta;
      column = next;
    } while (p[column] !== 0);
    do { const previous = way[column]; p[column] = p[previous]; column = previous; } while (column !== 0);
  }
  const result = Array(rows).fill(-1) as number[];
  for (let column = 1; column <= columns; column++) if (p[column]) result[p[column] - 1] = column - 1;
  return result.some((column, row) => column < 0 || costs[row][column] >= FORBIDDEN / 2) ? null : result;
}

function activeLocks(input: PlannerInput, time: number): PlannerLock[] { return input.locks.filter(lock => lock.startMs <= time && lock.endMs > time); }
function outsideBuffer(segment: FutureSegment, time: number, fraction: number): boolean {
  const halfElapsed = time - segment.halfStartMs;
  return halfElapsed !== 0 && (halfElapsed < segment.plannedHalfMs * fraction || halfElapsed > segment.plannedHalfMs * (1 - fraction));
}
function keeperRounding(input: PlannerInput, targets: Record<string, Rational>): Record<string, number> {
  const ids = sortedIds(input, input.players.map(player => player.id));
  const result: Record<string, number> = {};
  let allocated = 0;
  let targetTotal = 0;
  for (const id of ids) { const value = rationalToNumber(targets[id]); result[id] = Math.floor(value / 1000) * 1000; allocated += result[id]; targetTotal += value; }
  // Exactly one one-second lattice residual is allocated deterministically; no percentage tolerance.
  let remaining = Math.round(targetTotal) - allocated;
  const remainderOrder = [...ids].sort((left, right) => (rationalToNumber(targets[right]) - result[right]) - (rationalToNumber(targets[left]) - result[left]) || ids.indexOf(left) - ids.indexOf(right));
  for (const id of remainderOrder) { const extra = Math.min(1000, remaining); if (extra > 0) { result[id] += extra; remaining -= extra; } }
  return result;
}

function keeperRoleBounds(target: Rational, actualMs: number): { minimum: number; maximum: number } {
  const exactSecondTarget = target.numerator % (target.denominator * 1000n) === 0n && actualMs % 1000 === 0;
  if (exactSecondTarget) { const exact = Number(target.numerator / target.denominator); return { minimum: exact, maximum: exact }; }
  const oneSecond = 1000n * target.denominator;
  const minimum = target.numerator >= oneSecond ? Number((target.numerator - oneSecond) / target.denominator) + 1 : 0;
  const maximum = Number((target.numerator + oneSecond + target.denominator - 1n) / target.denominator) - 1;
  return { minimum, maximum };
}
function hardProof(input: PlannerInput, targets: TargetResult[], roleTargets: Record<string, Rational>, budget: WorkBudget): PlannerProof | null {
  for (const target of targets) {
    const played = input.actual[target.playerId]?.playingMs ?? 0;
    if (fractionCompare(played, target.upper) > 0) return { kind: 'past_excess', detail: 'Recorded actual playing time already exceeds the individual upper band; no future substitution can undo it.', playerIds: [target.playerId] };
    if (fractionCompare(played + opportunity(input, target.playerId, input.nowMs), target.lower) < 0) return { kind: 'insufficient_opportunity', detail: 'Even playing every remaining available millisecond cannot reach the individual lower band. Preserve actual history.', playerIds: [target.playerId] };
  }
  for (const segment of input.futureSegments) {
    const ids = sortedIds(input, segment.availablePlayerIds);
    const dummyCount = Math.max(0, input.slots.length - ids.length);
    const allIds = [...ids, ...Array.from({ length: dummyCount }, (_, index) => `vacant-${index}`)];
    const times = [...new Set([segment.startMs, ...input.locks.flatMap(lock => [lock.startMs, lock.endMs]).filter(time => time > segment.startMs && time < segment.endMs)])];
    for (const time of times) {
      const locks = activeLocks(input, time);
      const costs = input.slots.map(slot => allIds.map(id => {
        budget.spend();
        if (id.startsWith('vacant-')) return slot.position === 'GK' || locks.some(lock => lock.slotId === slot.slotId) ? FORBIDDEN : 0;
        const player = input.players.find(item => item.id === id)!;
        return !player.eligiblePositions.includes(slot.position) || slot.position === 'GK' && !policyKeepers(segment).includes(id) || locks.some(lock => lock.slotId === slot.slotId && lock.playerId !== id || lock.playerId === id && lock.slotId !== slot.slotId) ? FORBIDDEN : 0;
      }));
      if (!assign(costs, budget)) return { kind: 'position_capacity', detail: 'No simultaneous distinct-player assignment covers the required formation and explicit eligibility/manager locks in this interval.', playerIds: ids };
    }
  }
  // Uniform strict-grid certificate is valid only when every historical/future boundary is on that lattice.
  const grid = input.settings.hardSubstitutionGridMs;
  if (grid && input.nowMs === 0 && input.futureSegments.length && input.futureSegments.every(segment => segment.goalkeeperPolicy.kind === 'fixed' && sameIds(segment.availablePlayerIds, input.futureSegments[0].availablePlayerIds) && segment.startMs % grid === 0 && segment.endMs % grid === 0)) {
    let minTotal = 0n; let maxTotal = 0n;
    for (const target of targets) {
      const step = BigInt(grid);
      const minimum = ((target.lower.numerator + target.lower.denominator * step - 1n) / (target.lower.denominator * step)) * step;
      const maximum = (target.upper.numerator / (target.upper.denominator * step)) * step;
      if (minimum > maximum) return { kind: 'strict_grid_capacity', detail: 'No strict-grid total lies within an individual exact target band.', playerIds: [target.playerId] };
      minTotal += minimum; maxTotal += maximum;
    }
    const required = BigInt(input.futureSegments.reduce((sum, segment) => sum + (segment.endMs - segment.startMs) * Math.min(input.slots.length, segment.availablePlayerIds.length), 0));
    if (required < minTotal || required > maxTotal) return { kind: 'strict_grid_capacity', detail: 'The sum of all strict-grid totals inside individual bands cannot fill the required pitch-player capacity (ME44). Relax the grid or acknowledge an unfair exception.', playerIds: targets.map(target => target.playerId) };
  }
  for (const player of input.players) {
    const target = targets.find(item => item.playerId === player.id)!;
    const actual = input.actual[player.id]?.goalkeeperMs ?? 0;
    const bounds = keeperRoleBounds(roleTargets[player.id], actual);
    if (!input.slots.some(slot => slot.position !== 'GK' && player.eligiblePositions.includes(slot.position)) && fractionCompare(bounds.maximum, target.lower) < 0) return { kind: 'insufficient_opportunity', detail: 'Equal goalkeeper duties alone cannot meet this common-pool total-minute band, and the player has no approved outfield position. Request explicit eligible outfield cover or acknowledge the conflict; do not count bench time as play.', playerIds: [player.id] };
    if (actual > bounds.maximum || actual + opportunity(input, player.id, input.nowMs, 'keeper') < bounds.minimum) return { kind: 'keeper_history', detail: 'Recorded goalkeeper duties and remaining eligible opportunity cannot meet the equal-share role target. A keeper exception needs an explained manager acknowledgement; actual history stays unchanged.', playerIds: [player.id] };
  }
  return null;
}
function sameIds(left: string[], right: string[]): boolean { return left.length === right.length && left.every(id => right.includes(id)); }

function selectKeeper(input: PlannerInput, segment: FutureSegment, time: number, chunkMs: number, previous: Allocation[], keeperTotals: Record<string, number>, roleFinal: Record<string, number>): string {
  const ids = sortedIds(input, policyKeepers(segment));
  if (segment.goalkeeperPolicy.kind === 'fixed') return ids[0];
  const current = previous.find(item => item.position === 'GK')?.playerId;
  const need = (id: string) => roleFinal[id] - keeperTotals[id];
  const urgent = ids.filter(id => need(id) > opportunity(input, id, time + chunkMs, 'keeper'));
  if (urgent.length) return urgent.sort((left, right) => (need(right) - opportunity(input, right, time + chunkMs, 'keeper')) - (need(left) - opportunity(input, left, time + chunkMs, 'keeper')) || ids.indexOf(left) - ids.indexOf(right))[0];
  if (current && ids.includes(current) && need(current) > 0) return current;
  return ids.sort((left, right) => need(right) / Math.max(1, opportunity(input, right, time, 'keeper')) - need(left) / Math.max(1, opportunity(input, left, time, 'keeper')) || seededRank(input.seed, left) - seededRank(input.seed, right))[0];
}

function attemptSchedule(input: PlannerInput, targets: TargetResult[], roleFinal: Record<string, number>, stepMs: number, budget: WorkBudget): ScheduledLineup[] | null {
  const playing = Object.fromEntries(input.players.map(player => [player.id, input.actual[player.id]?.playingMs ?? 0]));
  const goalkeeper = Object.fromEntries(input.players.map(player => [player.id, input.actual[player.id]?.goalkeeperMs ?? 0]));
  const targetMap = new Map(targets.map(target => [target.playerId, target]));
  const spellStart = { ...input.currentSpellStartedMs };
  let previous = input.currentLineup.map(item => ({ ...item }));
  const schedule: ScheduledLineup[] = [];
  for (const segment of input.futureSegments) {
    let time = segment.startMs;
    while (time < segment.endMs) {
      budget.spend();
      let duration = Math.min(stepMs, segment.endMs - time);
      const nextLockBoundary = input.locks.flatMap(lock => [lock.startMs, lock.endMs]).filter(boundary => boundary > time).sort((left, right) => left - right)[0];
      if (nextLockBoundary !== undefined) duration = Math.min(duration, nextLockBoundary - time);
      if (input.settings.hardSubstitutionGridMs) {
        const grid = input.settings.hardSubstitutionGridMs;
        const halfElapsed = time - segment.halfStartMs;
        duration = Math.min(duration, (Math.floor(halfElapsed / grid) + 1) * grid - halfElapsed);
      }
      const keeper = selectKeeper(input, segment, time, duration, previous, goalkeeper, roleFinal);
      if (segment.goalkeeperPolicy.kind !== 'fixed') {
        const keeperNeed = roleFinal[keeper] - goalkeeper[keeper];
        if (keeperNeed > 0 && keeperNeed < duration && !input.settings.hardSubstitutionGridMs) {
          // Routine executable changes are whole seconds within the actual half.
          const roundedBoundary = segment.halfStartMs + Math.ceil((time + keeperNeed - segment.halfStartMs) / 1000) * 1000;
          duration = Math.min(duration, Math.max(1, roundedBoundary - time));
        }
      }
      const availableIds = sortedIds(input, segment.availablePlayerIds);
      const dummyCount = Math.max(0, input.slots.length - availableIds.length);
      const ids = [...availableIds, ...Array.from({ length: dummyCount }, (_, index) => `vacant-${index}`)];
      const locks = activeLocks(input, time);
      const previousIds = playersOn(previous);
      const noChange = input.settings.hardBufferFraction !== null && outsideBuffer(segment, time, input.settings.hardBufferFraction) || input.settings.hardSubstitutionGridMs !== null && (time - segment.halfStartMs) % input.settings.hardSubstitutionGridMs !== 0;
      const mandatory = new Set<string>();
      for (const id of availableIds) {
        const target = targetMap.get(id)!;
        if (fractionCompare(playing[id] + opportunity(input, id, time + duration), target.lower) < 0) mandatory.add(id);
        if (input.settings.hardMinSpellMs !== null && previousIds.has(id) && time - (spellStart[id] ?? input.nowMs) < input.settings.hardMinSpellMs) mandatory.add(id);
      }
      const forcedSlots = new Map<string, string>();
      const buildCosts = () => input.slots.map(slot => ids.map(id => {
        budget.spend();
        if (id.startsWith('vacant-')) return slot.position === 'GK' || locks.some(lock => lock.slotId === slot.slotId) || forcedSlots.has(slot.slotId) ? FORBIDDEN : 1e7;
        const player = input.players.find(item => item.id === id)!;
        const target = targetMap.get(id)!;
        if (!player.eligiblePositions.includes(slot.position) || slot.position === 'GK' && id !== keeper || slot.position !== 'GK' && id === keeper ||
            locks.some(lock => lock.slotId === slot.slotId && lock.playerId !== id || lock.playerId === id && lock.slotId !== slot.slotId) ||
            noChange && !previous.some(item => item.slotId === slot.slotId && item.playerId === id) ||
            forcedSlots.has(slot.slotId) && forcedSlots.get(slot.slotId) !== id ||
            [...forcedSlots].some(([lockedSlot, lockedId]) => lockedId === id && lockedSlot !== slot.slotId) ||
            fractionCompare(playing[id] + duration, target.upper) > 0) return FORBIDDEN;
        const futureKeeper = Math.max(0, roleFinal[id] - goalkeeper[id]);
        const targetNeed = Math.max(0, rationalToNumber(target.target) - playing[id] - (slot.position === 'GK' ? 0 : futureKeeper));
        const remainingOpportunity = Math.max(1, opportunity(input, id, time) - (slot.position === 'GK' ? 0 : futureKeeper));
        const deficitCost = -100_000 * targetNeed / remainingOpportunity;
        const costs = input.settings.positionMode === 'normal' ? input.settings.normalPositionCosts : input.settings.adventurousPositionCosts;
        const preferences = [...new Set(player.preferences)];
        const rank = preferences.indexOf(slot.position);
        const positionCost = costs[rank >= 0 ? rank : 3];
        const wasPlaying = previousIds.has(id);
        const currentSpell = time - (spellStart[id] ?? time);
        const shortSpellBenefit = wasPlaying && currentSpell < input.settings.preferredMinSpellMs ? -25_000 : 0;
        const bufferBenefit = wasPlaying && outsideBuffer(segment, time, input.settings.preferredBufferFraction) ? -5_000 : 0;
        const sameSlotBenefit = previous.some(item => item.playerId === id && item.slotId === slot.slotId) ? -0.25 : 0;
        return deficitCost + positionCost + shortSpellBenefit + bufferBenefit + sameSlotBenefit - (mandatory.has(id) ? 1e9 : 0);
      }));
      let assignment = assign(buildCosts(), budget);
      if (!assignment) return null;
      const toLineup = (chosen: number[]) => input.slots.flatMap((slot, index) => ids[chosen[index]].startsWith('vacant-') ? [] : [{ ...slot, playerId: ids[chosen[index]] }]);
      let lineup = toLineup(assignment);
      const cap = input.settings.hardBatchCap;
      if (cap !== null && time !== segment.halfStartMs) {
        for (let repairs = 0; changedPlayers(previous, lineup).outgoing.length > cap && repairs < previous.length; repairs++) {
          const outgoing = sortedIds(input, changedPlayers(previous, lineup).outgoing).find(id => availableIds.includes(id) && previous.some(item => item.playerId === id && !forcedSlots.has(item.slotId)));
          const item = previous.find(item => item.playerId === outgoing);
          if (!item) return null;
          forcedSlots.set(item.slotId, item.playerId);
          assignment = assign(buildCosts(), budget);
          if (!assignment) return null;
          lineup = toLineup(assignment);
        }
        if (changedPlayers(previous, lineup).outgoing.length > cap) return null;
      }
      if ([...mandatory].some(id => !lineup.some(item => item.playerId === id))) return null;
      const on = playersOn(lineup);
      for (const id of on) {
        if (!previousIds.has(id)) spellStart[id] = time;
        playing[id] += duration;
      }
      const goalkeeperId = lineup.find(item => item.position === 'GK')!.playerId;
      goalkeeper[goalkeeperId] += duration;
      const last = schedule[schedule.length - 1];
      if (last && last.endMs === time && last.half === segment.half && sameLineup(last.lineup, lineup) && last.startMs >= segment.startMs) last.endMs += duration;
      else schedule.push({ startMs: time, endMs: time + duration, half: segment.half, lineup, requiresConfirmation: true });
      previous = lineup;
      time += duration;
    }
  }
  return schedule;
}

export interface ScheduleValidation {
  legal: boolean;
  complete: boolean;
  allWithinBands: boolean;
  equalKeeperDuties: boolean;
  players: PlannerPlayerResult[];
  errors: string[];
}
/** Independent validation of proposed schedules; never accepts a search result on trust. */
export function validatePlannerSchedule(input: PlannerInput, schedule: ScheduledLineup[]): ScheduleValidation {
  const invalid = validateInput(input);
  if (invalid) return { legal: false, complete: false, allWithinBands: false, equalKeeperDuties: false, players: [], errors: [invalid.detail] };
  const errors: string[] = [];
  const totals = Object.fromEntries(input.players.map(player => [player.id, input.actual[player.id]?.playingMs ?? 0]));
  const keeperTotals = Object.fromEntries(input.players.map(player => [player.id, input.actual[player.id]?.goalkeeperMs ?? 0]));
  const targets = totalTargets(input); const roles = keeperTargets(input);
  let cursor = input.nowMs; let previous = input.currentLineup;
  const spells = { ...input.currentSpellStartedMs };
  for (const slice of schedule) {
    if (slice.requiresConfirmation !== true) errors.push('Every suggested allocation requires explicit manager confirmation.');
    if (!Number.isSafeInteger(slice.startMs) || !Number.isSafeInteger(slice.endMs) || slice.startMs !== cursor || slice.endMs <= slice.startMs) errors.push('Schedule has an overlap, gap, noninteger time or nonpositive slice.');
    const segment = input.futureSegments.find(item => item.startMs <= slice.startMs && item.endMs >= slice.endMs && item.half === slice.half);
    if (!segment) { errors.push('Schedule crosses an availability/policy/half boundary without validation.'); continue; }
    const expectedCount = Math.min(input.slots.length, segment.availablePlayerIds.length);
    if (slice.lineup.length !== expectedCount || expectedCount < input.slots.length && !segment.underStrengthApproval) errors.push('Incorrect occupied pitch capacity or unapproved under-strength play.');
    if (new Set(slice.lineup.map(item => item.playerId)).size !== slice.lineup.length || new Set(slice.lineup.map(item => item.slotId)).size !== slice.lineup.length) errors.push('Duplicate player or slot in proposed lineup.');
    const keeper = slice.lineup.filter(item => item.position === 'GK');
    if (keeper.length !== 1 || !policyKeepers(segment).includes(keeper[0]?.playerId)) errors.push('Goalkeeper coverage violates the explicit interval policy.');
    for (const allocation of slice.lineup) {
      const player = input.players.find(item => item.id === allocation.playerId);
      if (!player || !segment.availablePlayerIds.includes(allocation.playerId) || !player.eligiblePositions.includes(allocation.position) || !input.slots.some(slot => slot.slotId === allocation.slotId && slot.position === allocation.position)) errors.push('Unavailable, unknown, position-ineligible or malformed allocation.');
      if (player) totals[player.id] += slice.endMs - slice.startMs;
    }
    if (keeper.length === 1 && keeperTotals[keeper[0].playerId] !== undefined) keeperTotals[keeper[0].playerId] += slice.endMs - slice.startMs;
    for (const lock of input.locks.filter(lock => lock.startMs < slice.endMs && lock.endMs > slice.startMs)) if (!slice.lineup.some(item => item.slotId === lock.slotId && item.playerId === lock.playerId)) errors.push('Proposed lineup violates a manager lock.');
    const changes = changedPlayers(previous, slice.lineup);
    const changed = !sameLineup(previous, slice.lineup);
    if (changed && slice.startMs !== segment.halfStartMs) {
      if (input.settings.hardBufferFraction !== null && outsideBuffer(segment, slice.startMs, input.settings.hardBufferFraction)) errors.push('Lineup change violates a mandatory half buffer.');
      if (input.settings.hardSubstitutionGridMs !== null && (slice.startMs - segment.halfStartMs) % input.settings.hardSubstitutionGridMs !== 0) errors.push('Lineup change violates a mandatory substitution grid.');
      if (input.settings.hardBatchCap !== null && changes.outgoing.length > input.settings.hardBatchCap) errors.push('Substitution batch exceeds the explicit hard cap.');
    }
    for (const id of changes.outgoing) if (input.settings.hardMinSpellMs !== null && slice.startMs - (spells[id] ?? input.nowMs) < input.settings.hardMinSpellMs) errors.push('A mandatory continuous playing spell was shortened.');
    for (const id of changes.incoming) spells[id] = slice.startMs;
    previous = slice.lineup;
    cursor = slice.endMs;
  }
  const complete = cursor === (input.futureSegments.at(-1)?.endMs ?? input.nowMs);
  if (!complete) errors.push('Proposed schedule does not cover the full projected future.');
  const players = targets.map(target => ({
    playerId: target.playerId, actualMs: input.actual[target.playerId]?.playingMs ?? 0, projectedMs: totals[target.playerId],
    target: target.target, lower: target.lower, upper: target.upper,
    withinBand: withinTargetBand(totals[target.playerId], target), goalkeeperTarget: roles[target.playerId], projectedGoalkeeperMs: keeperTotals[target.playerId],
  }));
  const equalKeeperDuties = players.every(player => {
    const bounds = keeperRoleBounds(roles[player.playerId], input.actual[player.playerId]?.goalkeeperMs ?? 0);
    return player.projectedGoalkeeperMs >= bounds.minimum && player.projectedGoalkeeperMs <= bounds.maximum;
  });
  return { legal: errors.length === 0, complete, allWithinBands: players.every(player => player.withinBand), equalKeeperDuties, players, errors };
}

function softExceptions(input: PlannerInput, segment: FutureSegment, atMs: number, before: Allocation[], after: Allocation[], spellStarts: Record<string, number>): string[] {
  const changes = changedPlayers(before, after); const notes: string[] = [];
  if (outsideBuffer(segment, atMs, input.settings.preferredBufferFraction)) notes.push('Outside the preferred half window; review this timing for fairness or keeper sharing.');
  if (changes.outgoing.length > input.settings.preferredBatchSize) notes.push(`Batch of ${changes.outgoing.length} exceeds the preferred ${input.settings.preferredBatchSize}; the preference is not a hard maximum.`);
  if (changes.outgoing.some(id => atMs - (spellStarts[id] ?? input.nowMs) < input.settings.preferredMinSpellMs)) notes.push('A preferred continuous playing spell is shortened; manager confirmation is required.');
  return notes;
}
function nextChange(input: PlannerInput, schedule: ScheduledLineup[]): PlannerChange | null {
  let previous = input.currentLineup; const spells = { ...input.currentSpellStartedMs };
  for (const slice of schedule) {
    if (!sameLineup(previous, slice.lineup)) {
      const changes = changedPlayers(previous, slice.lineup);
      const segment = input.futureSegments.find(item => item.startMs <= slice.startMs && item.endMs > slice.startMs)!;
      return {
        dueMatchActiveMs: slice.startMs, half: slice.half,
        outgoingPlayerIds: changes.outgoing, incomingPlayerIds: changes.incoming,
        lineup: slice.lineup.map(item => ({ ...item })), requiresConfirmation: true,
        explanation: `Suggested ${slice.half === 2 && slice.startMs === segment.halfStartMs ? 'half-time lineup, effective only on second-half Start' : 'lineup change at the stated active time'}. Confirm what actually happens; a delay requires a new plan. Individual targets use availability and the goalkeeper policy, with separate 90–110% bands.`,
        exceptions: softExceptions(input, segment, slice.startMs, previous, slice.lineup, spells),
      };
    }
    for (const id of changedPlayers(previous, slice.lineup).incoming) spells[id] = slice.startMs;
    previous = slice.lineup;
  }
  return null;
}

/** Deterministic bounded scheduling. A failed search is never an infeasibility proof. */
export function planMatch(input: PlannerInput): PlannerResult {
  const budget = new WorkBudget(input.settings.maxWork);
  const assumptions = [
    input.settings.policyStatus === 'synthetic_experiment' ? 'Q07 interval-weighted targets and changing keeper policy are synthetic experiments, not silently approved product defaults.' : 'Interval and keeper policy use the explicit match acceptance supplied by the caller.',
    'Projection assumes the supplied future availability; expected arrivals still require actual manager confirmation.',
    'Every proposed lineup/substitution requires manager confirmation; actual recorded history is unchanged.',
  ];
  const base = (): PlannerResult => ({ status: 'indeterminate', planId: input.planId, planVersion: input.planVersion, sourceRevision: input.sourceRevision, engineVersion: PLANNER_VERSION, seed: input.seed, schedule: [], nextChange: null, players: [], proof: null, explanations: [], assumptions, diagnostics: { work: budget.used, budgetExhausted: false, strategiesTried: 0, fairBands: false, equalKeeperDuties: false } });
  const invalid = validateInput(input);
  if (invalid) return { ...base(), status: invalid.kind === 'invalid_input' ? 'indeterminate' : 'infeasible', proof: invalid.kind === 'invalid_input' ? null : invalid, explanations: [invalid.detail] };
  let strategiesTried = 0;
  let bestSchedule: ScheduledLineup[] = [];
  let bestValidation: ScheduleValidation | null = null;
  try {
    budget.spend();
    const targets = totalTargets(input); const roleTargets = keeperTargets(input);
    const proof = hardProof(input, targets, roleTargets, budget);
    if (proof) return { ...base(), status: 'infeasible', proof, players: validatePlannerSchedule(input, []).players, explanations: [proof.detail], diagnostics: { ...base().diagnostics, work: budget.used } };
    const roundedRoles = keeperRounding(input, roleTargets);
    const horizonMs = input.futureSegments.reduce((sum, segment) => sum + segment.endMs - segment.startMs, 0);
    const first = input.futureSegments[0];
    const uniform = first && input.futureSegments.every(segment => sameIds(segment.availablePlayerIds, first.availablePlayerIds) && JSON.stringify(segment.goalkeeperPolicy) === JSON.stringify(first.goalkeeperPolicy));
    const mobilePool = first ? first.availablePlayerIds.length - (fixedKeeper(first) ? 1 : 0) : 0;
    const mobileCapacity = input.slots.length - (first && fixedKeeper(first) ? 1 : 0);
    const analyticStep = uniform && mobilePool > mobileCapacity ? Math.max(1000, Math.round(horizonMs * (mobilePool - mobileCapacity) / mobilePool / 1000) * 1000) : Math.max(1000, input.settings.preferredMinSpellMs);
    const steps = input.settings.hardSubstitutionGridMs ? [input.settings.hardSubstitutionGridMs] : [...new Set([analyticStep, Math.max(1000, Math.round(input.settings.preferredMinSpellMs / 1000) * 1000), 60_000, 1000])];
    for (const step of steps) {
      strategiesTried++;
      const schedule = attemptSchedule(input, targets, roundedRoles, step, budget);
      if (!schedule) continue;
      const validation = validatePlannerSchedule(input, schedule);
      if (validation.legal && validation.complete) {
        bestSchedule = schedule; bestValidation = validation;
        if (validation.allWithinBands && validation.equalKeeperDuties) {
          return { ...base(), status: 'feasible', schedule, nextChange: nextChange(input, schedule), players: validation.players,
            explanations: ['Validated every slot, availability boundary, lock, actual-history total and individual exact 90–110% band.', 'Goalkeeper duties are validated separately from total playing time; only an unavoidable whole-second residual is quantised.', 'Preferred windows, spells, batch sizes and position weights are explicit settings, not competition rules. Candidate search does not claim a global soft-preference optimum.'],
            diagnostics: { work: budget.used, budgetExhausted: false, strategiesTried, fairBands: true, equalKeeperDuties: true } };
        }
      }
    }
  } catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error;
    return { ...base(), schedule: bestSchedule, players: bestValidation?.players ?? [], explanations: ['Planning incomplete: deterministic work budget exhausted. Retain the validated manual lineup; no impossible/fair claim was established.'], diagnostics: { work: budget.used, budgetExhausted: true, strategiesTried, fairBands: bestValidation?.allWithinBands ?? false, equalKeeperDuties: bestValidation?.equalKeeperDuties ?? false } };
  }
  return { ...base(), schedule: bestSchedule, players: bestValidation?.players ?? [], explanations: ['Planning incomplete: bounded candidate search did not establish a schedule meeting every band and equal keeper duties. No infeasibility proof exists; keep the validated manual lineup or review explicit constraints.'], diagnostics: { work: budget.used, budgetExhausted: false, strategiesTried, fairBands: bestValidation?.allWithinBands ?? false, equalKeeperDuties: bestValidation?.equalKeeperDuties ?? false } };
}

export interface AlertPlan { planId: string; planVersion: number; sourceRevision: number; dueMatchActiveMs: number }
export type AlertThresholdSeconds = 90 | 60 | 30 | 0;
export interface PlanAlertState {
  planKey: string | null;
  firedThresholds: AlertThresholdSeconds[];
  lastActiveMs: number;
}
export interface PlanAlertInput {
  plan: AlertPlan | null;
  activeMs: number;
  sourceRevision: number;
  status: 'running' | 'paused' | 'half_time' | 'terminal';
  hasControl: boolean;
  timeCertain: boolean;
  /** Resume skips missed advance warnings and emits only a single current due state. */
  resuming: boolean;
  previous: PlanAlertState | null;
}
export interface PlanAlertUpdate {
  state: PlanAlertState;
  cancelPrevious: boolean;
  schedule: { thresholdSeconds: AlertThresholdSeconds; dueMatchActiveMs: number }[];
  fireNow: AlertThresholdSeconds[];
  visual: 'none' | 'upcoming' | 'due' | 'overdue';
  reason: string | null;
  /** The adapter must test permission, sound/Focus, sleep, force-stop and cancellation on both phones. */
  requiresNativeDeviceTesting: true;
}
const THRESHOLDS: AlertThresholdSeconds[] = [90, 60, 30, 0];
/** Pure current-plan scheduling. It never performs a substitution or promises an OS alarm. */
export function updatePlanAlerts(input: PlanAlertInput): PlanAlertUpdate {
  integer(input.activeMs, 'Alert active time');
  const plan = input.plan;
  const key = plan ? `${plan.planId}:${plan.planVersion}:${plan.sourceRevision}` : null;
  const samePlan = key !== null && input.previous?.planKey === key;
  const fired = samePlan ? [...input.previous!.firedThresholds] : [];
  const empty = (reason: string, preserve = false): PlanAlertUpdate => ({
    state: { planKey: preserve ? key : null, firedThresholds: preserve ? fired : [], lastActiveMs: input.activeMs },
    cancelPrevious: true, schedule: [], fireNow: [], visual: 'none', reason, requiresNativeDeviceTesting: true,
  });
  if (!plan) return empty('No current substitution plan.');
  integer(plan.dueMatchActiveMs, 'Plan due time'); integer(plan.planVersion, 'Plan version'); integer(plan.sourceRevision, 'Plan source revision');
  if (!input.hasControl) return empty('Controller authority lost; cancel local schedules.');
  if (!input.timeCertain || samePlan && input.activeMs < input.previous!.lastActiveMs) return empty('Time needs checking; cancel schedules until recovery.');
  if (plan.sourceRevision !== input.sourceRevision) return empty('Source match revision changed; replan before scheduling.');
  if (input.status !== 'running') return empty(`Match ${input.status}; active substitution alerts cancelled.`, input.status === 'paused');
  const fireNow: AlertThresholdSeconds[] = [];
  const schedule: { thresholdSeconds: AlertThresholdSeconds; dueMatchActiveMs: number }[] = [];
  const previousActive = samePlan ? input.previous!.lastActiveMs : input.activeMs;
  for (const threshold of THRESHOLDS) {
    if (fired.includes(threshold)) continue;
    const at = plan.dueMatchActiveMs - threshold * 1000;
    if (at > input.activeMs) schedule.push({ thresholdSeconds: threshold, dueMatchActiveMs: at });
    else {
      const crossed = samePlan && previousActive < at && at <= input.activeMs;
      if (threshold === 0 || !input.resuming && (crossed || at === input.activeMs)) fireNow.push(threshold);
      // Missed thresholds are sealed as skipped, never replayed after resume/replan.
      fired.push(threshold);
    }
  }
  const due = input.activeMs - plan.dueMatchActiveMs;
  // A delayed rendering tick must not replay several obsolete warnings in a burst.
  const currentFire = fireNow.length > 1 ? [fireNow[fireNow.length - 1]] : fireNow;
  return {
    state: { planKey: key, firedThresholds: fired, lastActiveMs: input.activeMs },
    cancelPrevious: !samePlan || input.resuming,
    schedule, fireNow: currentFire,
    visual: due > 0 ? 'overdue' : due === 0 ? 'due' : 'upcoming',
    reason: null, requiresNativeDeviceTesting: true,
  };
}

/** Call only at a decision point; a score change itself never moves players. */
export function selectPositionMode(input: {
  previousMode: 'normal' | 'adventurous';
  ourScore: number;
  oppositionScore: number;
  leadThreshold: number;
  returnToNormal: boolean;
  manualReset: boolean;
}): 'normal' | 'adventurous' {
  integer(input.ourScore, 'Our score'); integer(input.oppositionScore, 'Opposition score');
  if (!Number.isInteger(input.leadThreshold) || input.leadThreshold <= 0) throw new Error('Manager lead threshold must be a positive whole number.');
  if (input.manualReset) return 'normal';
  if (input.ourScore - input.oppositionScore >= input.leadThreshold) return 'adventurous';
  return input.previousMode === 'adventurous' && !input.returnToNormal ? 'adventurous' : 'normal';
}


/** Sticky adventurous mode belongs to one match only, including when return-to-normal is off. */
export function selectMatchPositionMode(previous: { matchId: string | null; mode: 'normal' | 'adventurous' }, input: {
  matchId: string; ourScore: number; oppositionScore: number; leadThreshold: number; returnToNormal: boolean; manualReset: boolean;
}): { matchId: string; mode: 'normal' | 'adventurous' } {
  return { matchId: input.matchId, mode: selectPositionMode({ ...input, previousMode: previous.matchId === input.matchId ? previous.mode : 'normal' }) };
}
