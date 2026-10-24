import { goalkeeperChoice, type PlayerProfile, type PreparationFormation } from './preparation';
import { formationFromPattern, TRADITIONAL_FORMATIONS } from './formation-pattern';

export interface FormationAdvicePlayer {
  profileId: string;
  playerId: string;
  label: string;
  /** Fractions of this player's projected playing time, not of the whole match. */
  primary: number;
  secondary: number;
  other: number;
  playingShare: number;
  unallocatedShare: number;
  positions: Record<string, number>;
  fixedGoalkeeper: boolean;
}
export interface FormationAssessment {
  formation: PreparationFormation;
  /** Capacity can cover each player's equal-time target with approved positions. */
  feasible: boolean;
  targetFit: number;
  shortfall: number;
  players: FormationAdvicePlayer[];
  notes: string[];
}
interface Edge { to: number; reverse: number; capacity: number; cost: number; initial: number }
const EPSILON = 1e-8;

/** Continuous player-time allocation, not a timed lineup or a substitution instruction. */
export function assessFormation(input: {
  profiles: readonly PlayerProfile[];
  formation: PreparationFormation;
}): FormationAssessment {
  const profiles = [...input.profiles].sort((a, b) => a.playerId.localeCompare(b.playerId));
  const formation = input.formation;
  if (profiles.length < formation.format || profiles.length > 200 || new Set(profiles.map(p => p.playerId)).size !== profiles.length)
    throw new Error('Choose a unique available squad with at least one player for each pitch place, up to 200 players.');
  if (formation.slots.length !== formation.format || formation.slots.filter(slot => slot.position === 'GK').length !== 1)
    throw new Error('The formation must have its stated number of places and exactly one goalkeeper.');
  const keepers = profiles.filter(profile => goalkeeperChoice(profile) > 0);
  const fixedKeeper = keepers.length === 1 ? keepers[0].playerId : null;
  const positions = [...new Set(formation.slots.map(slot => slot.position))].sort();
  const source = 0, playerStart = 1, positionStart = playerStart + profiles.length, sink = positionStart + positions.length;
  const graph: Edge[][] = Array.from({ length: sink + 1 }, () => []);
  const addEdge = (from: number, to: number, capacity: number, cost: number) => {
    const edge: Edge = { to, reverse: graph[to].length, capacity, cost, initial: capacity };
    graph[from].push(edge);
    graph[to].push({ to: from, reverse: graph[from].length - 1, capacity: 0, cost: -cost, initial: 0 });
    return edge;
  };
  const target = profiles.map(profile => fixedKeeper
    ? profile.playerId === fixedKeeper ? 1 : (formation.format - 1) / (profiles.length - 1)
    : formation.format / profiles.length);
  const tracked: { player: number; position: string; edge: Edge }[] = [];
  for (const [index, profile] of profiles.entries()) {
    addEdge(source, playerStart + index, target[index], 0);
    const isFixed = profile.playerId === fixedKeeper;
    for (const [positionIndex, position] of positions.entries()) {
      if (!profile.eligiblePositions.includes(position) || isFixed && position !== 'GK' || !isFixed && position === 'GK' && (fixedKeeper !== null || goalkeeperChoice(profile) === 0)) continue;
      const rank = profile.preferences.indexOf(position);
      const desired = isFixed ? target[index] : target[index] * (rank === 0 ? 0.65 : rank === 1 ? 0.35 : 0);
      if (desired > 0) tracked.push({ player: index, position, edge: addEdge(playerStart + index, positionStart + positionIndex, desired, 0) });
      tracked.push({ player: index, position, edge: addEdge(playerStart + index, positionStart + positionIndex, target[index], isFixed ? 0 : rank === 0 || rank === 1 ? 1 : 4) });
    }
  }
  for (const [index, position] of positions.entries())
    addEdge(positionStart + index, sink, formation.slots.filter(slot => slot.position === position).length, 0);
  let sent = 0;
  // Successive shortest augmenting paths retain reverse edges so a later player
  // can displace an earlier assignment. A greedy rank-first placement cannot do this.
  for (let iteration = 0; iteration < 4000; iteration++) {
    const distance = Array<number>(graph.length).fill(Infinity), previousNode = Array<number>(graph.length).fill(-1), previousEdge = Array<number>(graph.length).fill(-1);
    const queue = [source], queued = Array<boolean>(graph.length).fill(false);
    distance[source] = 0; queued[source] = true;
    for (let head = 0; head < queue.length; head++) {
      const node = queue[head]; queued[node] = false;
      for (const [edgeIndex, edge] of graph[node].entries()) {
        if (edge.capacity <= EPSILON || distance[edge.to] <= distance[node] + edge.cost + EPSILON) continue;
        distance[edge.to] = distance[node] + edge.cost;
        previousNode[edge.to] = node; previousEdge[edge.to] = edgeIndex;
        if (!queued[edge.to]) { queue.push(edge.to); queued[edge.to] = true; }
      }
    }
    if (!Number.isFinite(distance[sink])) break;
    let amount = Infinity;
    for (let node = sink; node !== source; node = previousNode[node]) amount = Math.min(amount, graph[previousNode[node]][previousEdge[node]].capacity);
    for (let node = sink; node !== source; node = previousNode[node]) {
      const edge = graph[previousNode[node]][previousEdge[node]];
      edge.capacity -= amount; graph[node][edge.reverse].capacity += amount;
    }
    sent += amount;
    if (sent >= formation.format - EPSILON) break;
    if (iteration === 3999) throw new Error('This squad exceeded the formation advice work limit. Reduce the selected squad and try again.');
  }
  const players: FormationAdvicePlayer[] = profiles.map((profile, index) => {
    const allocation: Record<string, number> = {};
    for (const item of tracked.filter(item => item.player === index)) allocation[item.position] = (allocation[item.position] ?? 0) + Math.max(0, item.edge.initial - item.edge.capacity);
    const primary = (allocation[profile.preferences[0]] ?? 0) / target[index];
    const secondary = (allocation[profile.preferences[1]] ?? 0) / target[index];
    const allocated = Object.values(allocation).reduce((sum, value) => sum + value, 0);
    return {
      profileId: profile.id, playerId: profile.playerId, label: profile.displayName,
      primary, secondary, other: Math.max(0, allocated / target[index] - primary - secondary),
      playingShare: target[index], unallocatedShare: Math.max(0, target[index] - allocated),
      positions: allocation, fixedGoalkeeper: profile.playerId === fixedKeeper,
    };
  });
  const mobile = players.filter(player => !player.fixedGoalkeeper);
  const fit = mobile.length ? mobile.reduce((sum, player) => sum + Math.min(0.65, player.primary) + Math.min(0.35, player.secondary), 0) / mobile.length : 1;
  const residual = Math.max(0, formation.format - sent);
  const shortfall = residual <= EPSILON ? 0 : residual;
  const notes = ['Capacity estimate for the whole match; actual spells, attendance, locks and match events may change the achievable split. Review the live playing-time plan and confirm every substitution.'];
  if (!keepers.length) notes.push('No available player has goalkeeper as an approved first or second position. Choose goalkeeper cover before using this formation.');
  if (fixedKeeper) notes.push('The sole qualifying goalkeeper is estimated to play the whole match in goal. The 65%/35% aim applies to the remaining players.');
  if (profiles.some(profile => profile.playerId !== fixedKeeper && (!profile.preferences[1] || !profile.eligiblePositions.includes(profile.preferences[1])))) notes.push('Some players have no approved secondary position. Add or review their preferences to make a 65%/35% split possible.');
  if (shortfall > EPSILON) notes.push('Approved positions cannot cover equal playing-time targets in this formation. Review eligibility or choose another formation; no unapproved position has been assigned.');
  return { formation, feasible: shortfall <= EPSILON, targetFit: fit, shortfall, players, notes };
}

export function recommendFormations(input: {
  profiles: readonly PlayerProfile[];
  format: number;
  formations?: readonly PreparationFormation[];
  activePositions?: readonly string[];
}): FormationAssessment[] {
  const candidates = [...(input.formations ?? []).filter(formation => formation.format === input.format && (!input.activePositions || formation.slots.every(slot => input.activePositions!.includes(slot.position))))];
  for (const pattern of TRADITIONAL_FORMATIONS[input.format] ?? []) {
    try {
      const formation = formationFromPattern({ pattern, format: input.format, id: `suggested-${input.format}-${pattern}`, activePositions: input.activePositions });
      candidates.push({ ...formation, version: 0 });
    } catch { /* An inactive team position cannot be silently re-enabled by advice. */ }
  }
  const unique = candidates.filter((formation, index) => candidates.findIndex(other => other.slots.map(slot => `${slot.position}:${slot.x}:${slot.y}`).join('|') === formation.slots.map(slot => `${slot.position}:${slot.x}:${slot.y}`).join('|')) === index);
  return unique.map(formation => assessFormation({ profiles: input.profiles, formation }))
    .sort((left, right) => left.shortfall - right.shortfall || right.targetFit - left.targetFit || left.formation.name.localeCompare(right.formation.name));
}
