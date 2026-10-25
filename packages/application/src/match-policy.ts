import { readClock, type ClockSample, type MatchPolicyProposal, type MatchState, type PolicyChangeDetails } from '../../domain/src/index';
import { assertMatchPolicyProposal, initialKeeperPolicy } from '../../domain/src/policy';

export interface ConfirmedMatchPlannerSettings { batchPreference: number; leadThreshold: number; returnToNormal: boolean; minimumStintMs: number; halfBufferFraction: number }
/** Older saved review settings contain only three values; missing soft fields remain explicit review defaults. */
export type MatchPlannerSettingsDraft = Pick<ConfirmedMatchPlannerSettings, 'batchPreference' | 'leadThreshold' | 'returnToNormal'> & Partial<Pick<ConfirmedMatchPlannerSettings, 'minimumStintMs' | 'halfBufferFraction'>>;
export type PolicyChangeCommand = { type: 'policy.changed' } & PolicyChangeDetails;

export function matchPlannerSettings(state: MatchState): ConfirmedMatchPlannerSettings | null {
  const payload = state.activePolicy?.payload;
  return payload ? { batchPreference: payload.batchLimit, leadThreshold: payload.scoreLeadThreshold, returnToNormal: payload.returnToNormalEnabled, minimumStintMs: payload.minimumStintMs, halfBufferFraction: state.activePolicy!.softPreferences.halfBufferFraction } : null;
}
/** Prepared/legacy values prefill a review. This helper does not confirm or install them. */
export function proposedMatchPolicy(state: MatchState, settings: MatchPlannerSettingsDraft): MatchPolicyProposal {
  const prior = state.activePolicy ?? state.config.initialPolicyProposal;
  const proposal: MatchPolicyProposal = {
    payload: { ...(prior?.payload ?? { ...initialKeeperPolicy(state.config), minimumStintMs: 300_000, batchLimit: settings.batchPreference, scoreLeadThreshold: settings.leadThreshold, returnToNormalEnabled: settings.returnToNormal }), minimumStintMs: settings.minimumStintMs ?? prior?.payload.minimumStintMs ?? 300_000, batchLimit: settings.batchPreference, scoreLeadThreshold: settings.leadThreshold, returnToNormalEnabled: settings.returnToNormal },
    applicability: prior?.applicability ? { ...prior.applicability } : { minimumStint: 'soft_preference', batchLimit: 'soft_preference', q07: 'unapproved' },
    softPreferences: { halfBufferFraction: settings.halfBufferFraction ?? prior?.softPreferences.halfBufferFraction ?? 0.15 },
  };
  assertMatchPolicyProposal(proposal, state.config);
  return proposal;
}
/** Capture before awaited journal work; the reducer checks this revision and continuous boundary again. */
export function makePolicyChangeCommand(state: MatchState, sample: ClockSample, settings: MatchPlannerSettingsDraft, reason: string, resetPositionMode = false): PolicyChangeCommand {
  if (state.status === 'completed' || state.status === 'abandoned') throw new Error('Completed match settings are retained. A new policy cannot alter past play.');
  const clock = readClock(state, sample);
  if (clock.recoveryRequired) throw new Error('Confirm the clock before capturing a prospective policy boundary.');
  if (typeof reason !== 'string' || reason.trim().length < 5 || reason.length > 500) throw new Error('Record a concise reason for confirming these future match settings.');
  const previousPolicyVersion = state.activePolicy?.policyVersion ?? 0;
  return { type: 'policy.changed', policySchemaVersion: 1, policyVersion: previousPolicyVersion + 1, previousPolicyVersion, sourceRevision: state.revision, reason, effective: { half: state.half, halfElapsedMs: clock.halfActiveMs, matchElapsedMs: clock.matchActiveMs }, ...proposedMatchPolicy(state, settings), ...(resetPositionMode ? { resetPositionMode: true } : {}) };
}
