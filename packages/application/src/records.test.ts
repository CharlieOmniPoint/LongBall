import { describe, expect, it } from 'vitest';
import { createMatch, reduceMatch, type MatchEvent, type MatchState } from '@longball/domain';
import { romaFixture } from '@longball/testing';
import { createRecordsSeed, reduceRecords, selectMatchReport, selectParticipationReport, selectSeasonResults, snapshotLiveMatch,
  type HistoricalResultInput, type MatchRecord, type RecordsCommand, type RecordsState } from './records';

const at = '2026-10-21T12:00:00Z';
let counter = 0;
const key = () => `record-test-${++counter}`;
const manager = { actor: 'manager' as const };
function correction(state: RecordsState, record: MatchRecord, changes: Partial<HistoricalResultInput>): RecordsState {
  return reduceRecords(state, { type: 'historical.correct', actor: 'manager', commandId: key(), at, recordId: record.id,
    expectedRevision: record.revision, input: { ...record, ...changes }, reason: 'Checked the original score record.' });
}
function completeMatch(withGoal = false): MatchState {
  let state = createMatch({ matchId: 'synthetic-roma-maple-2026-10-24', players: romaFixture.players,
    selectedPlayerIds: romaFixture.players.slice(0, 9).map(player => player.id), pitchPlaces: 7, plannedHalfDurationMs: 1_500_000,
    fixedKeeperId: romaFixture.players[0].id });
  const send = (command: Omit<MatchEvent, 'id' | 'sample'>, ms: number) => {
    state = reduceMatch(state, { ...command, id: key(), sample: { monotonicMs: ms, sessionId: 'records-test-clock', wallTimeMs: 1_800_000_000_000 + ms } } as MatchEvent);
  };
  for (const playerId of state.config.selectedPlayerIds) send({ type: 'attendance.recorded', playerId, status: 'present' } as Omit<MatchEvent, 'id' | 'sample'>, 0);
  send({ type: 'lineup.staged', lineup: ['GK', 'CB', 'CB', 'CM', 'LW', 'RW', 'ST'].map((position, index) => ({ position, slotId: `slot-${index}`, playerId: state.config.selectedPlayerIds[index] })) } as Omit<MatchEvent, 'id' | 'sample'>, 0);
  send({ type: 'half.started' }, 0);
  if (withGoal) send({ type: 'goal.recorded', beneficiary: 'us', scorerPlayerId: romaFixture.players[1].id, goalType: 'free_kick' } as Omit<MatchEvent, 'id' | 'sample'>, 30_000);
  send({ type: 'half.ended' }, 60_000);
  send({ type: 'half.started' }, 120_000);
  send({ type: 'half.ended' }, 180_000);
  return state;
}

describe('Results and historical completeness (F27/F28, REP01/REP07)', () => {
  it('includes ordinary friendlies and computes the specified 3/1/0 example', () => {
    const state = createRecordsSeed();
    expect(state.results[1].fixtureClass).toBe('friendly');
    const report = selectSeasonResults(state, manager);
    expect(report.totals).toEqual({ played: 3, wins: 1, draws: 1, losses: 1, goalsFor: 5, goalsAgainst: 4, goalDifference: 1, points: 4 });
    expect(report.form?.map(item => item.outcome)).toEqual(['W', 'D', 'L']);
    expect(report.rows[0].unassignedGoalsFor).toBe(2);
    expect(report.scorerTotals).toEqual([{ playerId: 'synthetic-player-02', label: 'Ralph Barrett', knownGoals: 1 }]);
  });
  it('corrects totals, chronology and scorer evidence while preserving old values in audit', () => {
    const before = createRecordsSeed();
    const state = correction(before, before.results[1], { finalScore: { for: 2, against: 3 } });
    expect(selectSeasonResults(state, manager).totals).toEqual({ played: 3, wins: 1, draws: 0, losses: 2, goalsFor: 5, goalsAgainst: 5, goalDifference: 0, points: 3 });
    expect(selectSeasonResults(state, manager).form?.map(item => item.outcome)).toEqual(['W', 'L', 'L']);
    expect(state.audit[0].before?.finalScore).toEqual({ for: 2, against: 2 });
    expect(state.audit[0].after?.finalScore).toEqual({ for: 2, against: 3 });
    expect(before.results[1].finalScore).toEqual({ for: 2, against: 2 });
  });
  it('keeps historical gaps unknown and never invents a clock, attendance or award', () => {
    const state = createRecordsSeed();
    const report = selectMatchReport(state, state.results[0].id, manager);
    expect(report).toMatchObject({ recordMode: 'historical_summary', detailCompleteness: 'summary_only', halfTimeScore: null, actualActiveDurationMs: null, participation: null, attendance: null, awardStatus: 'not_recorded' });
    expect(report?.goals[0]).toMatchObject({ goalType: null, half: null, halfElapsedMs: null });
    expect(state.results[0].recordedKickoff).toBeNull();
  });
  it('unknown scores are not draws; abandoned and exceptional outcomes do not receive ordinary points', () => {
    let state = createRecordsSeed();
    state = correction(state, state.results[0], { finalScore: null });
    state = correction(state, state.results[1], { status: 'abandoned' });
    state = correction(state, state.results[2], { specialOutcome: 'forfeit' });
    const report = selectSeasonResults(state, manager);
    expect(report.totals?.played).toBe(0);
    expect(report.totals?.draws).toBe(0);
    expect(report.rows.every(row => row.points === null)).toBe(true);
    expect(report.unknownScoreCount).toBe(1);
    expect(report.excludedExceptionalMatches).toBe(2);
  });
  it('rejects excess attribution, out-of-season dates, accidental duplicate games and stale corrections', () => {
    const state = createRecordsSeed();
    expect(() => correction(state, state.results[0], { finalScore: { for: 0, against: 1 } })).toThrow('attribution');
    expect(() => correction(state, state.results[0], { playedDate: '2027-09-01' })).toThrow('season');
    expect(() => reduceRecords(state, { type: 'historical.add', actor: 'manager', commandId: key(), at, recordId: key(), input: state.results[0] })).toThrow('already exists');
    expect(() => reduceRecords(state, { type: 'historical.correct', actor: 'manager', commandId: key(), at, recordId: state.results[0].id, expectedRevision: 99, reason: 'Correction', input: state.results[0] })).toThrow('latest revision');
  });
  it('retains exact retry identity and refuses nonmanager writes', () => {
    const original = createRecordsSeed();
    const command: RecordsCommand = { type: 'historical.correct', actor: 'manager', commandId: key(), at, recordId: original.results[0].id, expectedRevision: 1, reason: 'Date checked', input: { ...original.results[0], playedDate: '2026-10-02' } };
    const updated = reduceRecords(original, command);
    expect(reduceRecords(updated, command)).toBe(updated);
    expect(() => reduceRecords(updated, { ...command, reason: 'Different content' })).toThrow('conflicts');
    expect(() => reduceRecords(original, { ...command, commandId: key(), actor: 'player' })).toThrow('manager');
  });
  it('does not invent same-day match order for form', () => {
    const original = createRecordsSeed();
    const state = correction(original, original.results[1], { playedDate: original.results[0].playedDate });
    const report = selectSeasonResults(state, manager);
    expect(report.form).toBeNull();
    expect(report.formChronologyState).toBe('same_day_order_unknown');
    expect(report.totals?.played).toBe(3);
  });
  it('orders known kick-offs by their UTC instant across explicit offsets', () => {
    let state = createRecordsSeed();
    state = correction(state, state.results[0], { recordedKickoff: '2026-10-03T11:00:00+02:00' });
    state = correction(state, state.results[1], { playedDate: '2026-10-03', recordedKickoff: '2026-10-03T10:30:00Z' });
    expect(selectSeasonResults(state, manager).form?.map(item => item.outcome)).toEqual(['W', 'D', 'L']);
  });
});

describe('Publication and private reports (Q21/SEC11/CP-01)', () => {
  it('denies unconfirmed scores and all derived totals, form and scorer totals by default', () => {
    const state = createRecordsSeed();
    for (const actor of ['player', 'spectator'] as const) {
      const report = selectSeasonResults(state, { actor, playerId: 'synthetic-player-02' });
      expect(report).toMatchObject({ sharing: 'withheld_policy', rows: [], totals: null, form: null, scorerTotals: null, withheldResultCount: null, dataCoverage: { totalRecordedMatches: null, knownOrdinaryResults: null } });
      expect(selectMatchReport(state, state.results[0].id, { actor, playerId: 'synthetic-player-02' })).toMatchObject({ score: null, goals: [], unassignedGoalsFor: null });
    }
  });
  it('applies an explicit matching policy but never exposes hidden-game aggregates', () => {
    const original = createRecordsSeed();
    const first = original.results[0];
    const state = reduceRecords(original, { type: 'publication.set', actor: 'manager', commandId: key(), at, recordId: first.id, expectedRevision: first.revision,
      policy: { id: 'synthetic-reviewed-policy', version: 2, fixtureClass: first.fixtureClass, confirmed: true, confirmationReference: 'Fictional test policy only', allowedRoles: ['spectator'] }, reason: 'Synthetic access test' });
    const viewer = selectSeasonResults(state, { actor: 'spectator' });
    expect(viewer.rows).toHaveLength(1);
    expect(viewer.rows[0].finalScore).toEqual({ for: 3, against: 1 });
    expect(viewer.totals).toBeNull();
    expect(viewer.form).toBeNull();
    expect(viewer.scorerTotals).toBeNull();
    expect(state.audit[0].action).toBe('publication.set');
  });
  it('filters team/season scope before aggregation or lookup', () => {
    const state = createRecordsSeed();
    expect(selectSeasonResults(state, { actor: 'manager', teamId: 'other-team' })).toMatchObject({ rows: [], totals: null });
    expect(selectMatchReport(state, state.results[0].id, { actor: 'manager', seasonId: 'other-season' })).toBeNull();
    expect(selectParticipationReport(state, null, { actor: 'manager', teamId: 'other-team' }).access).toBe('denied');
  });
  it('invalidates confirmed sharing when a fixture is reclassified and retains versions', () => {
    const original = createRecordsSeed(); const first = original.results[0];
    const published = reduceRecords(original, { type: 'publication.set', actor: 'manager', commandId: key(), at, recordId: first.id, expectedRevision: first.revision,
      policy: { id: 'synthetic-policy', version: 2, fixtureClass: first.fixtureClass, confirmed: true, confirmationReference: 'Synthetic policy fixture', allowedRoles: ['spectator'] }, reason: 'Synthetic policy test' });
    const state = correction(published, published.results[0], { fixtureClass: 'trophy' });
    expect(state.results[0].classificationVersion).toBe(2);
    expect(state.results[0].publication.confirmed).toBe(false);
    expect(selectSeasonResults(state, { actor: 'spectator' }).rows).toHaveLength(0);
    expect(state.audit).toHaveLength(2);
  });
  it('returns only the named player’s rows and no spectator participation or attendance fields', () => {
    const state = createRecordsSeed();
    const match = completeMatch();
    const child = selectParticipationReport(state, match, { actor: 'player', playerId: 'synthetic-player-08' });
    expect(child.rows).toHaveLength(1);
    expect(child.rows[0].playerId).toBe('synthetic-player-08');
    expect(child.rows[0]).toMatchObject({ playingMs: 0, matchesAttended: 1, matchesPlayed: 0, matchesWithParticipationRecorded: 1 });
    expect(JSON.stringify(child)).not.toContain('synthetic-player-01');
    expect(selectParticipationReport(state, match, { actor: 'player' }).access).toBe('denied');
    expect(selectParticipationReport(state, match, { actor: 'spectator' })).toMatchObject({ access: 'denied', rows: [] });
    const spectator = selectMatchReport(state, match.config.matchId, { actor: 'spectator' }, match);
    expect(spectator).not.toHaveProperty('participation');
    expect(spectator).not.toHaveProperty('attendance');
    expect(spectator).not.toHaveProperty('actualActiveDurationMs');
  });
});

describe('Known participation and attendance (F19/REP02–REP04)', () => {
  it('keeps unknown historical squads out of attendance denominators, with coverage explicit', () => {
    const report = selectParticipationReport(createRecordsSeed(), null, manager);
    expect(report.rows[0]).toMatchObject({ games: { eligibleEventCount: 0, attendanceRecordedCount: 0, knownRecordAttendanceRate: null, completenessRatio: null }, unknownHistoricalSelectionCount: 3, evidenceState: 'partial' });
    expect(report.rows[0].coverageLabel).toContain('0 of 3');
  });
  it('excludes cancelled/non-expected training and retains unknown versus known absence', () => {
    const original = createRecordsSeed();
    const p = original.players[0].id;
    const state = reduceRecords(original, { type: 'training.evidence.replace', actor: 'manager', commandId: key(), at, evidence: [
      { sessionId: 'a', playedDate: '2026-10-01', eventStatus: 'held', expectedPlayerIds: [p], attendance: { [p]: 'present' } },
      { sessionId: 'b', playedDate: '2026-10-02', eventStatus: 'held', expectedPlayerIds: [p], attendance: {} },
      { sessionId: 'c', playedDate: '2026-10-03', eventStatus: 'held', expectedPlayerIds: [p], attendance: { [p]: 'absent' } },
      { sessionId: 'd', playedDate: '2026-10-04', eventStatus: 'cancelled', expectedPlayerIds: [p], attendance: { [p]: 'absent' } },
      { sessionId: 'e', playedDate: '2026-10-05', eventStatus: 'held', expectedPlayerIds: [], attendance: {} },
    ] });
    expect(selectParticipationReport(state, null, manager).rows[0].training).toMatchObject({ eligibleEventCount: 3, attendanceRecordedCount: 2, attendedCount: 1, knownAbsentCount: 1, unknownAttendanceCount: 1, knownRecordAttendanceRate: 0.5, completenessRatio: 2 / 3 });
  });
  it('archives completed intervals once, preserves position conservation and later preference snapshots', () => {
    const original = createRecordsSeed();
    const match = completeMatch();
    const captured = snapshotLiveMatch(original, match, at);
    expect(captured.actualActiveDurationMs).toBe(120_000);
    expect(captured.participation?.[0].playedMs).toBe(120_000);
    expect(captured.participation?.[0].primaryWasGoalkeeper).toBe(true);
    const state = reduceRecords(original, { type: 'live.archive', actor: 'manager', commandId: key(), at, match });
    const currentChanged = { ...match, config: { ...match.config, players: match.config.players.map(player => ({ ...player, goalkeeperChoice: 2 })) } };
    const historical = selectParticipationReport(state, null, manager).rows[0];
    expect(historical.nonPrimaryGoalkeeperMs).toBe(0);
    expect(historical.goalkeeperMs).toBe(120_000);
    expect(Object.values(historical.positionMs).reduce((sum, value) => sum + value, 0)).toBe(historical.playingMs);
    expect(selectParticipationReport(state, match, manager).rows[0].matchesWithParticipationRecorded).toBe(1);
    expect(() => reduceRecords(state, { type: 'live.archive', actor: 'manager', commandId: key(), at, match: currentChanged })).toThrow('already archived');
  });
  it('excludes explicit non-selection and keeps selected unknown and excused attendance distinct', () => {
    const original = createRecordsSeed(); const match = completeMatch();
    const record = snapshotLiveMatch(original, match, at);
    record.attendance![record.selectedPlayerIds![0]] = 'not_selected';
    record.attendance![record.selectedPlayerIds![1]] = 'not_recorded';
    record.attendance![record.selectedPlayerIds![2]] = 'excused';
    const state = { ...original, results: [record] };
    const rows = selectParticipationReport(state, null, manager).rows;
    expect(rows[0].games).toMatchObject({ eligibleEventCount: 0, knownRecordAttendanceRate: null });
    expect(rows[1].games).toMatchObject({ eligibleEventCount: 1, attendanceRecordedCount: 0, unknownAttendanceCount: 1, completenessRatio: 0, knownRecordAttendanceRate: null });
    expect(rows[2].games).toMatchObject({ eligibleEventCount: 1, attendanceRecordedCount: 1, knownAbsentCount: 1, excusedCount: 1, knownRecordAttendanceRate: 0 });
  });
  it('preserves unknown primary goalkeeper classification and preference coverage', () => {
    const original = createRecordsSeed(); const match = completeMatch();
    const record = snapshotLiveMatch(original, match, at);
    record.participation![0].primaryWasGoalkeeper = null;
    const row = selectParticipationReport({ ...original, results: [record] }, null, manager).rows[0];
    expect(row).toMatchObject({ goalkeeperMs: 120_000, nonPrimaryGoalkeeperMs: 0, goalkeeperMsWithKnownPrimaryPreference: 0, goalkeeperMsWithUnknownPrimaryPreference: 120_000, minutesPerPlayedAppearance: 2 });
    expect(Object.values(row.preferenceMs).reduce((sum, value) => sum + value, 0)).toBe(row.playingMs);
  });
  it('rebuilds archived score, form and scorer totals after an audited live goal correction', () => {
    const original = createRecordsSeed(); const match = completeMatch(true);
    const archived = reduceRecords(original, { type: 'live.archive', actor: 'manager', commandId: key(), at, match });
    const corrected = reduceMatch(match, { type: 'event.corrected', id: key(), targetEventId: match.goals![0].eventId, reason: 'Referee confirmed an opposition goal',
      replacement: { type: 'goal.recorded', beneficiary: 'opposition', scorerPlayerId: null, isOwnGoal: false, goalType: 'penalty' },
      sample: { monotonicMs: 0, sessionId: 'reopened-report', wallTimeMs: Date.parse(at) } });
    const state = reduceRecords(archived, { type: 'live.archive', actor: 'manager', commandId: key(), at, match: corrected, reason: 'Imported audited goal correction' });
    expect(selectSeasonResults(archived, manager).totals?.points).toBe(7);
    expect(selectSeasonResults(state, manager).totals?.points).toBe(4);
    expect(selectSeasonResults(state, manager).form?.at(-1)?.outcome).toBe('L');
    expect(selectSeasonResults(state, manager).scorerTotals?.[0].knownGoals).toBe(1);
    expect(state.audit.at(-1)?.before?.finalScore).toEqual({ for: 1, against: 0 });
    expect(state.audit.at(-1)?.after?.finalScore).toEqual({ for: 0, against: 1 });
    expect(corrected.completedAtMs).toBe(match.completedAtMs);
  });
  it('keeps report generation time separate from known evidence and exact target evidence serializable', () => {
    const state = createRecordsSeed(); const match = completeMatch();
    const report = selectMatchReport(state, match.config.matchId, manager, match);
    expect(report?.sourceMatchRevision).toBe(match.revision);
    expect(report?.asOf).toBe(new Date(match.eventHistory!.at(-1)!.sample.wallTimeMs).toISOString());
    expect(report?.generatedAt).toBeTypeOf('string');
    const record = snapshotLiveMatch(state, match, at);
    expect(record.participation?.[0].target).toMatchObject({ targetMs: 120_000, withinBand: true, deviationRatio: 0 });
    expect(() => JSON.stringify(record)).not.toThrow();
  });
  it('audits an explicit target exception without altering actual minutes or a known result', () => {
    const original = createRecordsSeed(); const match = completeMatch();
    const archived = reduceRecords(original, { type: 'live.archive', actor: 'manager', commandId: key(), at, match });
    const record = archived.results.at(-1)!; const bench = record.participation!.find(item => item.playedMs === 0)!;
    expect(bench.target?.withinBand).toBe(false);
    const state = reduceRecords(archived, { type: 'participation.exception.noted', actor: 'manager', commandId: key(), at, recordId: record.id, expectedRevision: record.revision, playerId: bench.playerId, reason: 'Fictional review: rotation not completed.' });
    expect(selectMatchReport(state, match.config.matchId, manager, match)).toHaveProperty('participation');
    expect(state.results.at(-1)?.participation?.find(item => item.playerId === bench.playerId)).toMatchObject({ playedMs: 0, target: { exceptionReason: 'Fictional review: rotation not completed.' } });
    expect(snapshotLiveMatch(state, match, at).participation?.find(item => item.playerId === bench.playerId)?.target?.exceptionReason).toBe('Fictional review: rotation not completed.');
    expect(state.audit.at(-1)?.before?.participation?.find(item => item.playerId === bench.playerId)?.target?.exceptionReason).toBeNull();
    expect(selectSeasonResults(state, manager).totals).toEqual(selectSeasonResults(archived, manager).totals);
    expect(() => reduceRecords(state, { type: 'participation.exception.noted', actor: 'manager', commandId: key(), at, recordId: record.id, expectedRevision: record.revision, playerId: bench.playerId, reason: 'Stale edit' })).toThrow('latest archived');
  });
});
