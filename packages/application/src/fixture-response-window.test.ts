import { describe, expect, it } from 'vitest';
import { canPlayerReplyToFixture } from './fixture-response-window';

const fixture = (playedDate: string, status = 'scheduled') => ({ playedDate, status });
describe('prospective player match replies', () => {
  it('closes past London dates without inventing a result or ending an unplayed same-day game', () => {
    const now = Date.parse('2026-10-24T18:00:00Z');
    expect(canPlayerReplyToFixture(fixture('2026-10-23'), now)).toBe(false);
    const sameDayWithElapsedPlannedKickoff = { ...fixture('2026-10-24'), kickoff: '10:00' };
    expect(canPlayerReplyToFixture(sameDayWithElapsedPlannedKickoff, now)).toBe(true);
    expect(canPlayerReplyToFixture(fixture('2026-10-31'), now, { recordedStatus: 'preparation' })).toBe(true);
    for (const status of ['cancelled', 'postponed']) expect(canPlayerReplyToFixture(fixture('2026-10-31', status), now)).toBe(false);
  });
  it('closes any known started, finished or abandoned record, including the same day', () => {
    const now = Date.parse('2026-10-24T10:00:00Z');
    for (const recordedStatus of ['first_half_running', 'first_half_paused', 'half_time', 'second_half_running', 'second_half_paused', 'completed', 'abandoned', 'incomplete']) {
      expect(canPlayerReplyToFixture(fixture('2026-10-24'), now, { recordedStatus })).toBe(false);
    }
    expect(canPlayerReplyToFixture(fixture('2026-10-24'), now)).toBe(true);
  });
  it('uses London midnight across both summer-time transitions', () => {
    expect(canPlayerReplyToFixture(fixture('2026-10-24'), Date.parse('2026-10-24T22:59:59Z'))).toBe(true);
    expect(canPlayerReplyToFixture(fixture('2026-10-24'), Date.parse('2026-10-24T23:00:00Z'))).toBe(false);
    expect(canPlayerReplyToFixture(fixture('2026-10-25'), Date.parse('2026-10-25T23:59:59Z'))).toBe(true);
    expect(canPlayerReplyToFixture(fixture('2026-10-25'), Date.parse('2026-10-26T00:00:00Z'))).toBe(false);
    expect(canPlayerReplyToFixture(fixture('2026-03-29'), Date.parse('2026-03-29T22:59:59Z'))).toBe(true);
    expect(canPlayerReplyToFixture(fixture('2026-03-29'), Date.parse('2026-03-29T23:00:00Z'))).toBe(false);
  });
  it('fails closed for malformed/impossible fixture dates and observation times', () => {
    const now = Date.parse('2026-10-24T10:00:00Z');
    for (const date of ['', '2026-2-3', '2026-02-30', 'not-a-date', '0000-01-01']) expect(canPlayerReplyToFixture(fixture(date), now)).toBe(false);
    for (const invalid of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER]) expect(canPlayerReplyToFixture(fixture('2026-10-24'), invalid)).toBe(false);
  });
});
