import { describe, expect, it } from 'vitest';
import { createPreparationState } from './preparation';
import { createRecordsSeed, reduceRecords, selectParticipationReport, type RecordsCommand } from './records';
import { gamePreparationEvidence } from './game-preparation-evidence';

describe('REP02 game responses remain separate from attendance', () => {
  it('binds profile responses to season players and never includes a different season or unknown profile', () => {
    const preparation = createPreparationState();
    const first = preparation.fixtures[0];
    first.responses = { [preparation.profiles[0].id]: 'available', [preparation.profiles[1].id]: 'unavailable', outsider: 'unsure' };
    preparation.fixtures.push({ ...first, id: 'other-season-game', seasonId: 'other-season' });
    const evidence = gamePreparationEvidence(preparation, preparation.activeSeasonId, 'source-response-command');
    expect(evidence.find(item => item.matchId === first.id)).toEqual({ matchId: first.id, responses: { [preparation.profiles[0].playerId]: 'available', [preparation.profiles[1].playerId]: 'unavailable' }, sourcePreparationRevision: preparation.revision, sourceCommandId: 'source-response-command' });
    expect(evidence.some(item => item.matchId === 'other-season-game')).toBe(false);
    expect(JSON.stringify(evidence)).not.toContain('outsider');
  });

  it('reports received responses, explicit no-reply and missing evidence without inferring actual attendance', () => {
    const original = createRecordsSeed();
    const ids = original.players.slice(0, 3).map(player => player.id);
    const record = { ...original.results[0], selectedPlayerIds: ids, attendance: { [ids[0]]: 'not_recorded' as const, [ids[1]]: 'present' as const, [ids[2]]: 'excused' as const } };
    const command: RecordsCommand = { type: 'game.evidence.replace', commandId: 'report-game-source', at: '2026-10-21T12:00:00Z', actor: 'manager', evidence: [{ matchId: record.id, responses: { [ids[0]]: 'available', [ids[1]]: 'no_reply' }, sourcePreparationRevision: 8, sourceCommandId: 'fixture-response-8' }] };
    const state = reduceRecords({ ...original, results: [record] }, command);
    const rows = selectParticipationReport(state, null, { actor: 'manager' }).rows;
    expect(rows[0].gameRecords[0]).toMatchObject({ eventType: 'game', availabilityResponse: 'available', actualAttendance: 'not_recorded', excusedStatus: null, correctionProvenance: { sourcePreparationRevision: 8, sourcePreparationCommandId: 'fixture-response-8' } });
    expect(rows[0].games.attendanceRecordedCount).toBe(0);
    expect(rows[1].gameRecords[0]).toMatchObject({ availabilityResponse: 'no_reply', actualAttendance: 'present' });
    expect(rows[2].gameRecords[0]).toMatchObject({ availabilityResponse: null, actualAttendance: 'excused', excusedStatus: 'excused' });
    expect(reduceRecords(state, command)).toBe(state);
    expect(() => reduceRecords(state, { ...command, evidence: [] })).toThrow('conflicts');
    const own = selectParticipationReport(state, null, { actor: 'player', playerId: ids[0] });
    expect(own.rows).toHaveLength(1);
    expect(JSON.stringify(own)).not.toContain(ids[1]);
    expect(selectParticipationReport(state, null, { actor: 'spectator' }).rows).toEqual([]);
    expect(selectParticipationReport({ ...original, results: [record] }, null, { actor: 'manager' }).rows[0].gameRecords[0].availabilityResponse).toBeNull();
  });

  it('refuses response evidence for unknown season players', () => {
    const original = createRecordsSeed();
    expect(() => reduceRecords(original, { type: 'game.evidence.replace', commandId: 'unknown-response', at: '2026-10-21T12:00:00Z', actor: 'manager', evidence: [{ matchId: 'game', responses: { outsider: 'available' }, sourcePreparationRevision: 0, sourceCommandId: 'source' }] })).toThrow('known season players');
  });
});
