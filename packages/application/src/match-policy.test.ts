import { describe, expect, it } from 'vitest';
import { createMatch, reduceMatch, type ClockSample, type MatchConfig, type MatchEvent } from '../../domain/src/index';
import { planMatch } from '../../domain/src/planner';
import { makePolicyChangeCommand, matchPlannerSettings, proposedMatchPolicy } from './match-policy';
import { plannerInputFromMatch } from './match-planner';

const ids = Array.from({ length: 9 }, (_, i) => `p${i + 1}`);
const slots = ['GK', 'CB', 'CB', 'CM', 'CM', 'ST', 'ST'].map((position, i) => ({ slotId: `slot-${i}`, position, x: i / 7, y: 0.5 }));
const config: MatchConfig = {
  matchId: 'policy-review', players: ids.map((id, i) => ({ id, displayName: `Player ${i + 1}`, goalkeeperChoice: i === 0 ? 1 : 0 })),
  selectedPlayerIds: ids, pitchPlaces: 7, plannedHalfDurationMs: 1_500_000, fixedKeeperId: 'p1', slots,
  profileSnapshot: ids.map((playerId, i) => ({ playerId, initials: `P${i + 1}`, eligiblePositions: i === 0 ? ['GK', 'CB', 'CM', 'ST'] : ['CB', 'CM', 'ST'], preferences: i === 0 ? ['GK', 'CB', 'CM'] : ['CM', 'CB', 'ST'] })),
};
const sample: ClockSample = { sessionId: 'policy-review-continuous', monotonicMs: 0, wallTimeMs: 1_800_000_000_000 };
const settings = { batchPreference: 3, leadThreshold: 2, returnToNormal: false, minimumStintMs: 180_000, halfBufferFraction: 0.1 };

describe('confirmed prospective planner settings', () => {
  it('uses explicit stint/buffer values in the canonical payload and real future planner, with no hard promotion', () => {
    let match = createMatch(config);
    for (const playerId of ids) match = reduceMatch(match, { id: `present-${playerId}`, type: 'attendance.recorded', playerId, status: 'present', sample });
    match = reduceMatch(match, { id: 'staged', type: 'lineup.staged', lineup: slots.map((slot, i) => ({ ...slot, playerId: ids[i] })), sample });
    const before = JSON.stringify(match);
    const command = makePolicyChangeCommand(match, sample, settings, 'Reviewed three-minute spells and ten-percent half buffers.');
    expect(JSON.stringify(match)).toBe(before);
    expect(command).toMatchObject({ sourceRevision: match.revision, policyVersion: 1, previousPolicyVersion: 0, payload: { minimumStintMs: 180_000, batchLimit: 3 }, softPreferences: { halfBufferFraction: 0.1 } });
    expect(matchPlannerSettings(match)).toBeNull();
    match = reduceMatch(match, { ...command, id: 'confirmed-policy', sample });
    const input = plannerInputFromMatch(match, sample, matchPlannerSettings(match)!, 4, 'normal');
    expect(input.settings).toMatchObject({ preferredMinSpellMs: 180_000, preferredBufferFraction: 0.1, preferredBatchSize: 3, hardMinSpellMs: null, hardBufferFraction: null, hardBatchCap: null, hardSubstitutionGridMs: null });
    expect(input.policyReference).toEqual({ eventId: 'confirmed-policy', policyVersion: 1, revision: match.revision, reason: command.reason });
    const result = planMatch(input);
    expect(result.policyReference).toEqual(input.policyReference);
    expect(result.status).toBe('feasible');
    expect(result.schedule.every(slice => slice.requiresConfirmation)).toBe(true);
    expect(match.intervals).toEqual([]); expect(match.targetIntervals).toEqual([]);
  });
  it('prefills prepared proposal values without copying policy authority or confirming a template', () => {
    const original = createMatch(config);
    const proposal = proposedMatchPolicy(original, settings);
    const prepared = createMatch({ ...config, initialPolicyProposal: proposal });
    const command = makePolicyChangeCommand(prepared, sample, { batchPreference: 2, leadThreshold: 4, returnToNormal: true }, 'Review prepared settings for this new fixture.');
    expect(command).toMatchObject({ sourceRevision: 0, previousPolicyVersion: 0, policyVersion: 1, payload: { minimumStintMs: 180_000, batchLimit: 2, scoreLeadThreshold: 4 }, softPreferences: { halfBufferFraction: 0.1 } });
    expect(prepared.activePolicy).toBeUndefined(); expect(prepared.policyHistory).toBeUndefined();
    expect(matchPlannerSettings(prepared)).toBeNull();
  });
  it('retains a differing keeper proposal for review but cannot activate an unapproved Q07 transition', () => {
    const proposal = proposedMatchPolicy(createMatch(config), settings);
    proposal.payload.keeperMode = 'common_pool'; proposal.payload.fixedKeeperPlayerSeasonId = null;
    const prepared = createMatch({ ...config, initialPolicyProposal: proposal });
    const command = makePolicyChangeCommand(prepared, sample, settings, 'Review a proposed common-pool keeper setting.');
    expect(command.payload.keeperMode).toBe('common_pool');
    expect(() => reduceMatch(prepared, { ...command, id: 'unapproved-policy', sample })).toThrow('Q07');
    expect(prepared.activePolicy).toBeUndefined();
  });
  it('refuses missing reason, noninteger stint, buffer boundaries and uncertain capture', () => {
    const match = createMatch(config);
    for (const invalid of [{ minimumStintMs: 0.5 }, { minimumStintMs: -1 }, { halfBufferFraction: 0.5 }, { halfBufferFraction: -0.1 }]) expect(() => makePolicyChangeCommand(match, sample, { ...settings, ...invalid }, 'Explicit manager review.')).toThrow();
    expect(() => makePolicyChangeCommand(match, sample, settings, ' ')).toThrow('reason');
    const uncertain = { ...match, recoveryRequired: true };
    expect(() => makePolicyChangeCommand(uncertain, sample, settings, 'Explicit manager review.')).toThrow('clock');
    expect(() => makePolicyChangeCommand({ ...match, status: 'completed' }, sample, settings, 'Explicit manager review.')).toThrow('Completed');
  });
  it('binds every later confirmation to the current source/version and keeps earlier event bytes', () => {
    const original = createMatch(config);
    const first: MatchEvent = { ...makePolicyChangeCommand(original, sample, settings, 'First reviewed prospective settings.'), id: 'first', sample };
    const match = reduceMatch(original, first), firstBytes = JSON.stringify(match.policyHistory?.[0]);
    const next = makePolicyChangeCommand(match, sample, { ...settings, minimumStintMs: 420_000, halfBufferFraction: 0.2 }, 'Longer preferred spells for subsequent planning.');
    const updated = reduceMatch(match, { ...next, id: 'second', sample });
    expect(next).toMatchObject({ sourceRevision: match.revision, previousPolicyVersion: 1, policyVersion: 2 });
    expect(matchPlannerSettings(updated)).toEqual({ ...settings, minimumStintMs: 420_000, halfBufferFraction: 0.2 });
    expect(JSON.stringify(updated.policyHistory?.[0])).toBe(firstBytes);
    expect(updated.eventHistory?.[0]).toEqual(first);
  });
});
