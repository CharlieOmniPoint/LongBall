import { describe, expect, it } from 'vitest';
import { acceptedCompletedFixtureIds, fixtureScheduleStatus } from './fixture-schedule-status';

describe('accepted fixture schedule presentation', () => {
  it('uses only current team and season accepted completed evidence', () => {
    const completed = acceptedCompletedFixtureIds([
      { matchId: 'played', teamId: 'roma', seasonId: '2026-27', status: 'completed' },
      { matchId: 'manager-played', teamId: 'roma', seasonId: '2026-27', state: { status: 'completed' } },
      { matchId: 'future', teamId: 'roma', seasonId: '2026-27', status: 'preparation' },
      { matchId: 'other-team', teamId: 'other', seasonId: '2026-27', status: 'completed' },
      { matchId: 'other-season', teamId: 'roma', seasonId: '2025-26', status: 'completed' },
      { matchId: 'unscoped', status: 'completed' },
    ], { teamId: 'roma', seasonId: '2026-27' });
    expect([...completed]).toEqual(['played', 'manager-played']);
    expect([...acceptedCompletedFixtureIds(null, {})]).toEqual([]);
  });
  it('never infers a completed game from its date or conceals cancellation/postponement', () => {
    const fixture = { id: 'played', status: 'scheduled' as const, playedDate: '2026-10-17' };
    expect(fixtureScheduleStatus(fixture, new Set(), '2026-10-22')).toBe('Past fixture');
    expect(fixtureScheduleStatus(fixture, new Set(['played']), '2026-10-22')).toBe('Completed');
    expect(fixtureScheduleStatus({ ...fixture, status: 'postponed' }, new Set(['played']), '2026-10-22')).toBe('Postponed');
    expect(fixtureScheduleStatus({ ...fixture, status: 'cancelled' }, new Set(['played']), '2026-10-22')).toBe('Cancelled');
    expect(fixtureScheduleStatus({ ...fixture, playedDate: '2026-10-24' }, new Set(), '2026-10-22')).toBe('Scheduled');
  });
});
