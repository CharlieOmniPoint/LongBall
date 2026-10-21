import { describe, expect, it } from 'vitest';
import { createMatch, type MatchConfig } from './index';

describe('explicit prepared attendance', () => {
  const players = Array.from({ length: 7 }, (_, index) => ({ id: `fictional-${index}`, displayName: `Player ${index}`, goalkeeperChoice: index === 0 ? 1 : 0 }));
  const config: MatchConfig = { matchId: 'fictional-prepared-attendance', players, selectedPlayerIds: players.map(player => player.id), pitchPlaces: 7, plannedHalfDurationMs: 1_500_000, fixedKeeperId: players[0].id };
  it('carries check-in without generating playing time or inferring unchecked players', () => {
    const initialAttendance = { 'fictional-0': 'present', 'fictional-1': 'absent' } as const;
    const state = createMatch({ ...config, initialAttendance });
    expect(state.attendance).toMatchObject({ 'fictional-0': 'present', 'fictional-1': 'absent', 'fictional-2': 'not_recorded' });
    expect(state.intervals).toEqual([]);
    expect(state.stagedLineup).toEqual([]);
    expect(state.matchActiveMs).toBe(0);
  });
  it('refuses unrelated or malformed imported check-in', () => {
    expect(() => createMatch({ ...config, initialAttendance: { 'other-child': 'present' } })).toThrow(/selected squad/);
    expect(() => createMatch({ ...config, initialAttendance: { 'fictional-0': 'available' } as never })).toThrow(/selected squad/);
  });
});
