import { cloneValue } from './live-events';
import type { ActiveMatchPolicy, Allocation, MatchConfig, MatchEvent, MatchPolicyPayload, MatchPolicyProposal, MatchPolicyRecord, MatchState, PolicyChangeDetails, PolicyEffectiveTime } from './types';

function fail(message: string): never { throw new Error(message); }
function keys(value: unknown, fields: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))) fail(`Use the exact versioned ${label} fields.`);
}
function nonnegative(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(`${label} must be a nonnegative safe integer.`);
}
function keeperRank(config: MatchConfig, playerId: string): number {
  const saved = config.profileSnapshot?.find(profile => profile.playerId === playerId);
  return saved ? saved.preferences.indexOf('GK') + 1 : config.players.find(player => player.id === playerId)?.goalkeeperChoice ?? 0;
}

export function initialKeeperPolicy(config: MatchConfig): Pick<MatchPolicyPayload, 'keeperMode' | 'fixedKeeperPlayerSeasonId'> {
  return { keeperMode: config.fixedKeeperId ? 'sole_fixed' : 'common_pool', fixedKeeperPlayerSeasonId: config.fixedKeeperId };
}

/** D22 preferences are soft. This schema cannot silently promote them or approve Q07. */
export function assertMatchPolicyProposal(value: unknown, config: MatchConfig): asserts value is MatchPolicyProposal {
  keys(value, ['payload', 'applicability', 'softPreferences'], 'match policy proposal');
  const payload = value.payload;
  keys(payload, ['keeperMode', 'fixedKeeperPlayerSeasonId', 'minimumStintMs', 'batchLimit', 'scoreLeadThreshold', 'returnToNormalEnabled'], 'canonical policy payload');
  if (!['sole_fixed', 'common_pool'].includes(String(payload.keeperMode))) fail('Choose an explicit supported goalkeeper policy.');
  if (payload.keeperMode === 'common_pool' && payload.fixedKeeperPlayerSeasonId !== null) fail('Common-pool policy cannot create a fixed-keeper exemption.');
  if (payload.keeperMode === 'sole_fixed' && (typeof payload.fixedKeeperPlayerSeasonId !== 'string' || !config.selectedPlayerIds.includes(payload.fixedKeeperPlayerSeasonId) || ![1, 2].includes(keeperRank(config, payload.fixedKeeperPlayerSeasonId)))) fail('The fixed keeper must be a selected first- or second-choice goalkeeper.');
  nonnegative(payload.minimumStintMs, 'Preferred minimum stint');
  if (!Number.isSafeInteger(payload.batchLimit) || Number(payload.batchLimit) < 1 || Number(payload.batchLimit) > 11) fail('Choose a batch preference from one to eleven.');
  if (!Number.isSafeInteger(payload.scoreLeadThreshold) || Number(payload.scoreLeadThreshold) < 1 || typeof payload.returnToNormalEnabled !== 'boolean') fail('Choose a positive score threshold and an explicit return-to-normal option.');
  keys(value.applicability, ['minimumStint', 'batchLimit', 'q07'], 'policy applicability');
  if (value.applicability.minimumStint !== 'soft_preference' || value.applicability.batchLimit !== 'soft_preference' || value.applicability.q07 !== 'unapproved') fail('Ordinary stint and batch settings remain soft. This command cannot approve Q07 or introduce a mandatory constraint.');
  keys(value.softPreferences, ['halfBufferFraction'], 'soft preferences');
  const fraction = value.softPreferences.halfBufferFraction;
  if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 0.49) fail('The soft half buffer must be between zero and 0.49.');
}

/** Review proposals do not infer actual attendance and never become staged allocations here. */
export function assertInitialLineupProposal(config: MatchConfig, value: unknown): asserts value is Allocation[] {
  if (!Array.isArray(value) || value.length !== config.pitchPlaces || new Set(value.map(item => item?.playerId)).size !== value.length || new Set(value.map(item => item?.slotId)).size !== value.length) fail('A starting-lineup proposal needs distinct selected players and slots for the saved format.');
  for (const allocation of value) {
    keys(allocation, ['slotId', 'position', 'playerId'], 'lineup proposal');
    if (typeof allocation.playerId !== 'string' || !config.selectedPlayerIds.includes(allocation.playerId) || typeof allocation.slotId !== 'string' || !allocation.slotId || typeof allocation.position !== 'string' || !allocation.position) fail('Starting-lineup proposals must use the selected saved match squad.');
    if (config.slots && !config.slots.some(slot => slot.slotId === allocation.slotId && slot.position === allocation.position)) fail('Starting-lineup proposals must use the saved formation slots and roles.');
    const saved = config.profileSnapshot?.find(profile => profile.playerId === allocation.playerId);
    if (saved && !saved.eligiblePositions.includes(allocation.position)) fail('A proposed role is outside the saved player eligibility.');
  }
  const keepers = value.filter(allocation => allocation.position === 'GK');
  if (keepers.length !== 1 || ![1, 2].includes(keeperRank(config, keepers[0].playerId)) || config.fixedKeeperId && keepers[0].playerId !== config.fixedKeeperId) fail('A lineup proposal needs one qualifying keeper consistent with its explicit policy.');
}

export function policyAtBoundary(state: MatchState, half: 0 | 1 | 2, activeMs: number, maximumRevision = Infinity): MatchPolicyRecord | null {
  const matching = (state.policyHistory ?? []).filter(policy => policy.revision <= maximumRevision && policy.effective.half <= half && policy.effective.matchElapsedMs <= activeMs);
  return matching.length ? matching[matching.length - 1] : null;
}
export function fixedKeeperAtBoundary(state: MatchState, half: 0 | 1 | 2, activeMs: number, maximumRevision = Infinity): string | null {
  const policy = policyAtBoundary(state, half, activeMs, maximumRevision);
  return policy ? policy.payload.keeperMode === 'sole_fixed' ? policy.payload.fixedKeeperPlayerSeasonId : null : state.config.fixedKeeperId;
}
export function currentFixedKeeper(state: MatchState): string | null {
  return state.activePolicy ? state.activePolicy.payload.keeperMode === 'sole_fixed' ? state.activePolicy.payload.fixedKeeperPlayerSeasonId : null : state.config.fixedKeeperId;
}

export function assertPolicyBoundary(state: MatchState, time: PolicyEffectiveTime): void {
  keys(time, ['half', 'halfElapsedMs', 'matchElapsedMs'], 'policy boundary');
  nonnegative(time.halfElapsedMs, 'Policy half time'); nonnegative(time.matchElapsedMs, 'Policy match time');
  if (time.half !== state.half || ![0, 1, 2].includes(time.half)) fail('Policy changes must use the current preparation or half boundary.');
  const expected = (time.half === 2 ? state.firstHalfDurationMs ?? fail('The actual first-half duration is required.') : 0) + time.halfElapsedMs;
  if (expected !== time.matchElapsedMs || time.matchElapsedMs !== state.matchActiveMs || time.halfElapsedMs !== state.halfActiveMs) fail('Policy changes are prospective only; the captured boundary must match the current continuous checkpoint.');
}

export function applyPolicyChange(state: MatchState, event: Extract<MatchEvent, { type: 'policy.changed' }>, previousRevision: number): MatchState {
  const allowed = ['id', 'sample', 'actorId', 'type', 'policySchemaVersion', 'policyVersion', 'previousPolicyVersion', 'sourceRevision', 'effective', 'reason', 'payload', 'applicability', 'softPreferences', 'resetPositionMode'];
  if (Object.keys(event).some(key => !allowed.includes(key))) fail('Use only the documented versioned policy command fields.');
  nonnegative(event.policyVersion, 'Policy version'); nonnegative(event.previousPolicyVersion, 'Previous policy version'); nonnegative(event.sourceRevision, 'Policy source revision');
  assertMatchPolicyProposal({ payload: event.payload, applicability: event.applicability, softPreferences: event.softPreferences }, state.config);
  if (event.policySchemaVersion !== 1 || event.sourceRevision !== previousRevision || event.previousPolicyVersion !== (state.activePolicy?.policyVersion ?? 0) || event.policyVersion !== event.previousPolicyVersion + 1) fail('The policy source or version changed. Review the current match before confirming again.');
  if (typeof event.reason !== 'string' || event.reason.trim().length < 5 || event.reason.length > 500) fail('Record a concise reason for this prospective settings change.');
  if (event.resetPositionMode !== undefined && typeof event.resetPositionMode !== 'boolean') fail('A position-mode reset must be explicit.');
  assertPolicyBoundary(state, event.effective);
  const previous = state.activePolicy?.payload ?? initialKeeperPolicy(state.config);
  if (event.payload.keeperMode !== previous.keeperMode || event.payload.fixedKeeperPlayerSeasonId !== previous.fixedKeeperPlayerSeasonId) fail('Q07 goalkeeper-policy transitions are unapproved. This service has no explicit experimental transition gate; retain the proposal for policy review.');
  const details: PolicyChangeDetails = { policySchemaVersion: 1, policyVersion: event.policyVersion, previousPolicyVersion: event.previousPolicyVersion, sourceRevision: event.sourceRevision, effective: cloneValue(event.effective), reason: event.reason, payload: cloneValue(event.payload), applicability: cloneValue(event.applicability), softPreferences: cloneValue(event.softPreferences), ...(event.resetPositionMode === undefined ? {} : { resetPositionMode: event.resetPositionMode }) };
  const record: MatchPolicyRecord = { ...details, eventId: event.id, revision: previousRevision + 1, recordedAtMs: event.sample.wallTimeMs, actorId: event.actorId ?? null };
  const activePolicy: ActiveMatchPolicy = { ...cloneValue(record), positionMode: event.resetPositionMode ? 'normal' : state.activePolicy?.positionMode ?? 'normal', manualResetAtSourceRevision: event.resetPositionMode ? previousRevision + 1 : null };
  return { ...state, activePolicy, policyHistory: [...state.policyHistory ?? [], record] };
}

/** Persisted derived state makes a sticky score mode reproducible after accepted controller handover. */
export function updatePolicyPositionMode(state: MatchState, nextRevision: number): MatchState {
  const policy = state.activePolicy;
  if (!policy || policy.manualResetAtSourceRevision === nextRevision) return state;
  const leading = state.score.for - state.score.against >= policy.payload.scoreLeadThreshold;
  const mode = leading ? 'adventurous' : policy.payload.returnToNormalEnabled ? 'normal' : policy.positionMode;
  return mode === policy.positionMode ? state : { ...state, activePolicy: { ...policy, positionMode: mode } };
}
