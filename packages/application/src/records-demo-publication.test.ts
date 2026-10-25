import { describe, expect, it } from 'vitest';
import { createMatch, reduceMatch, type MatchEvent, type MatchState } from '@longball/domain';
import { romaFixture } from '@longball/testing';
import { createRecordsSeed, reduceRecords, selectMatchReport, snapshotLiveMatch, type RecordsState } from './records';

const at = '2026-10-21T18:00:00Z';
function liveMatch(): MatchState {
  let match = createMatch({ matchId: 'synthetic-roma-maple-2026-10-24', players: romaFixture.players,
    selectedPlayerIds: romaFixture.players.slice(0, 9).map(player => player.id), pitchPlaces: 7,
    plannedHalfDurationMs: 1_500_000, fixedKeeperId: romaFixture.players[0].id });
  let counter = 0;
  const send = (command: Omit<MatchEvent, 'id' | 'sample'>) => {
    match = reduceMatch(match, { ...command, id: `demo-live-${++counter}`, sample: { monotonicMs: counter, sessionId: 'demo-policy-test', wallTimeMs: Date.parse(at) + counter } } as MatchEvent);
  };
  for (const playerId of match.config.selectedPlayerIds) send({ type: 'attendance.recorded', playerId, status: 'present' } as Omit<MatchEvent, 'id' | 'sample'>);
  send({ type: 'lineup.staged', lineup: ['GK', 'CB', 'CB', 'CM', 'LW', 'RW', 'ST'].map((position, index) => ({ position, slotId: `slot-${index}`, playerId: match.config.selectedPlayerIds[index] })) } as Omit<MatchEvent, 'id' | 'sample'>);
  send({ type: 'half.started' });
  send({ type: 'goal.recorded', beneficiary: 'us', scorerPlayerId: null, goalType: 'open_play', isOwnGoal: false } as Omit<MatchEvent, 'id' | 'sample'>);
  return match;
}
const report = (state: RecordsState, match = liveMatch()) => selectMatchReport(state, match.config.matchId, { actor: 'spectator' }, match)!;

describe('explicit initial live demo publication', () => {
  it('keeps ordinary first live reports denied and never adds invented played history', () => {
    const state = createRecordsSeed();
    expect(state.initialLivePublication).toBeUndefined();
    expect(report(state)).toMatchObject({ score: null, policyId: 'unconfirmed-competition-policy' });
    expect(state.results).toHaveLength(3);
  });

  it('projects the explicit demo decision without inventing a result or relaxing match/class boundaries', () => {
    const state = createRecordsSeed({ demoSharing: true });
    expect(report(state)).toMatchObject({ score: { for: 1, against: 0 }, policyId: 'demo-simulated-scores-v1' });
    expect(state.results).toHaveLength(2);
    const wrongMatch = structuredClone(state); wrongMatch.initialLivePublication!.matchId = 'different-match';
    expect(report(wrongMatch).score).toBeNull();
    const wrongPolicyClass = structuredClone(state); wrongPolicyClass.initialLivePublication!.publication.fixtureClass = 'friendly';
    expect(report(wrongPolicyClass).score).toBeNull();
  });

  it('permanently discards initial approval on classification change, including change back', () => {
    const state = createRecordsSeed({ demoSharing: true });
    const friendly = reduceRecords(state, { type: 'live.context.set', actor: 'manager', commandId: 'change-class', at, details: { ...state.liveMatch, fixtureClass: 'friendly' } });
    expect(friendly.initialLivePublication).toBeUndefined();
    expect(report(friendly).score).toBeNull();
    const changedBack = reduceRecords(friendly, { type: 'live.context.set', actor: 'manager', commandId: 'change-back', at, details: { ...state.liveMatch } });
    expect(report(changedBack).score).toBeNull();
    expect(state.initialLivePublication).toBeDefined();
  });

  it('never restores an archived record policy from initial demo metadata', () => {
    const state = createRecordsSeed({ demoSharing: true }), match = liveMatch();
    const current = snapshotLiveMatch(state, match, at);
    const denied = { ...current, publication: { ...current.publication, confirmed: false, allowedRoles: [] } };
    expect(report({ ...state, results: [...state.results, denied] }, match).score).toBeNull();
  });
});
