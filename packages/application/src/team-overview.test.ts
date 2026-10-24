import { describe, expect, it } from 'vitest';
import { selectTeamOverviewGame, teamOverviewLondonDate, teamOverviewStatusLabel, type TeamOverviewGame } from './team-overview';
const game = (id: string, playedDate: string, status = 'scheduled', kickoff: string | null = '10:00'): TeamOverviewGame => ({ id, playedDate, status, kickoff, opponent: `${id} FC` });
describe('safe team overview game selection', () => {
  it('prefers an active recorded game today over another scheduled game or future fixture', () => {
    const active = game('active', '2026-10-24', 'first_half_paused');
    expect(selectTeamOverviewGame([game('future', '2026-10-31'), game('scheduled', '2026-10-24'), active], '2026-10-24')).toMatchObject({ game: active, reason: 'active_today' });
    expect(teamOverviewStatusLabel(active)).toBe('Last recorded: first half paused');
  });
  it('uses a scheduled game today without requiring accepted match rows or guessing it has finished', () => {
    const fixture = game('maple', '2026-10-24');
    expect(selectTeamOverviewGame([fixture], '2026-10-24')).toMatchObject({ game: fixture, reason: 'scheduled_today' });
    expect(teamOverviewStatusLabel(fixture)).toBe('Scheduled');
  });
  it('picks the next eligible future fixture and excludes cancelled, deleted and completed records', () => {
    const future = game('oak', '2026-10-31');
    const rows = [game('old-active', '2026-10-23', 'first_half_running'), game('cancelled', '2026-10-24', 'cancelled'), game('deleted', '2026-10-25', 'deleted'), game('completed', '2026-10-26', 'completed'), future];
    expect(selectTeamOverviewGame(rows, '2026-10-24')).toMatchObject({ game: future, reason: 'next_fixture' });
  });
  it('keeps missing times and postponed status explicit without mutating safe summaries', () => {
    const postponed = game('postponed', '2026-10-25', 'postponed', null), before = structuredClone(postponed);
    expect(selectTeamOverviewGame([postponed], '2026-10-24')).toMatchObject({ game: postponed, uncertain: true, notice: expect.stringContaining('postponed') });
    expect(selectTeamOverviewGame([game('unknown-time', '2026-10-24', 'scheduled', null)], '2026-10-24').notice).toContain('not been recorded');
    expect(postponed).toEqual(before);
    expect(selectTeamOverviewGame([game('future-active', '2026-10-31', 'first_half_running')], '2026-10-24')).toMatchObject({ reason: 'next_fixture', uncertain: true, notice: expect.stringContaining('another date') });
  });
  it('uses deterministic kickoff ordering and reports conflicting summaries rather than reviving a cancelled game', () => {
    const early = game('early', '2026-10-24', 'scheduled', '09:00');
    expect(selectTeamOverviewGame([game('late', '2026-10-24', 'scheduled', '11:00'), early], '2026-10-24').game?.id).toBe('early');
    const result = selectTeamOverviewGame([game('same', '2026-10-24'), game('same', '2026-10-24', 'cancelled'), game('next', '2026-10-31')], '2026-10-24');
    expect(result.game?.id).toBe('next'); expect(result.uncertain).toBe(true);
  });
  it('does not invent a date or next game and follows the London date across midnight and DST', () => {
    expect(selectTeamOverviewGame([game('invalid', '2026-02-30')], '2026-10-24')).toMatchObject({ game: null, reason: 'none', uncertain: true });
    expect(selectTeamOverviewGame([], '2026-10-24')).toMatchObject({ game: null, reason: 'none' });
    expect(teamOverviewLondonDate(Date.parse('2026-10-23T23:30:00Z'))).toBe('2026-10-24');
    expect(teamOverviewLondonDate(Date.parse('2026-10-25T23:30:00Z'))).toBe('2026-10-25');
  });
});
