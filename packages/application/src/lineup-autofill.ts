import { currentFixedKeeper, validateLineup, type Allocation, type MatchState } from '@longball/domain';

export interface AutoFillPlayer {
  id: string;
  preferences: readonly string[];
  eligiblePositions: readonly string[];
  goalkeeperChoice: number;
  available: boolean;
}
export interface AutoFillInput {
  slots: readonly { slotId: string; position: string }[];
  players: readonly AutoFillPlayer[];
  fixedKeeperId?: string | null;
}
export type AutoFillResult =
  | { status: 'complete'; allocations: Allocation[]; preferenceCost: number }
  | { status: 'infeasible'; reason: string; unfilledSlotIds: string[] };

/** Complete matching across saved slots. Availability is supplied explicitly by the caller. */
export function autoFillLineup(input: AutoFillInput): AutoFillResult {
  const fail = (reason: string): AutoFillResult => ({ status: 'infeasible', reason, unfilledSlotIds: input.slots.map(slot => slot.slotId) });
  if (input.slots.length < 1 || input.slots.length > 11 || input.players.length > 100 || input.slots.filter(slot => slot.position === 'GK').length !== 1 || new Set(input.slots.map(slot => slot.slotId)).size !== input.slots.length || input.slots.some(slot => !slot.slotId || !slot.position) || new Set(input.players.map(player => player.id)).size !== input.players.length || input.players.some(player => !player.id)) return fail('Review the saved places and distinct player identities before filling a lineup.');
  const players = input.players.filter(player => player.available).slice().sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (players.length < input.slots.length) return fail(`Only ${players.length} available players can fill ${input.slots.length} places. Record actual availability or choose a different planning squad.`);
  type Candidate = { cost: number; assigned: (string | null)[]; key: string };
  const count = 1 << input.slots.length;
  let states: (Candidate | undefined)[] = new Array(count);
  states[0] = { cost: 0, assigned: input.slots.map(() => null), key: '' };
  for (const player of players) {
    const next = states.slice();
    for (let mask = 0; mask < count; mask++) {
      const previous = states[mask];
      if (!previous) continue;
      for (let place = 0; place < input.slots.length; place++) {
        const slot = input.slots[place], bit = 1 << place;
        if (mask & bit || !player.eligiblePositions.includes(slot.position)) continue;
        if (slot.position === 'GK' && (![1, 2].includes(player.goalkeeperChoice) || !player.preferences.slice(0, 2).includes('GK') || input.fixedKeeperId && input.fixedKeeperId !== player.id)) continue;
        if (slot.position !== 'GK' && input.fixedKeeperId === player.id) continue;
        const rank = player.preferences.indexOf(slot.position), cost = previous.cost + (rank >= 0 && rank <= 2 ? rank : 4);
        const assigned = previous.assigned.slice(); assigned[place] = player.id;
        const key = JSON.stringify(assigned), existing = next[mask | bit];
        if (!existing || cost < existing.cost || cost === existing.cost && key < existing.key) next[mask | bit] = { cost, assigned, key };
      }
    }
    states = next;
  }
  const result = states[count - 1];
  if (!result) return fail('No complete eligible lineup is available for these places. Review goalkeeper cover, approved positions and actual availability; no partial lineup was staged.');
  return { status: 'complete', preferenceCost: result.cost, allocations: input.slots.map((slot, index) => ({ slotId: slot.slotId, position: slot.position, playerId: result.assigned[index]! })) };
}

/** Match-day candidates come only from actual saved check-in/availability and match-time eligibility. */
export function autoFillMatchLineup(match: MatchState): AutoFillResult {
  const slots = match.config.slots ?? [];
  if (match.status === 'completed' || match.status === 'abandoned') return { status: 'infeasible', reason: 'Recorded completed or abandoned play cannot be auto-filled.', unfilledSlotIds: slots.map(slot => slot.slotId) };
  const result = autoFillLineup({ slots, fixedKeeperId: currentFixedKeeper(match), players: match.config.players.filter(player => match.config.selectedPlayerIds.includes(player.id)).map(player => {
    const profile = match.config.profileSnapshot?.find(item => item.playerId === player.id);
    return { id: player.id, preferences: profile?.preferences ?? player.positionPreferences ?? [], eligiblePositions: profile?.eligiblePositions ?? [], goalkeeperChoice: profile ? profile.preferences.indexOf('GK') + 1 : player.goalkeeperChoice, available: match.attendance[player.id] === 'present' && match.availability[player.id] === true };
  }) });
  if (result.status === 'infeasible') return result;
  const errors = validateLineup(match, result.allocations);
  return errors.length ? { status: 'infeasible', reason: errors.join(' '), unfilledSlotIds: slots.map(slot => slot.slotId) } : result;
}
