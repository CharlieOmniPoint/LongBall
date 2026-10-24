import { describe, expect, it } from 'vitest';
import { formatUkDate, formatUkDateTime, formatUkSeasonLabel, londonDateKey } from './uk-display';

describe('UK display calendar', () => {
  it('shortens presentation without altering an ISO input', () => {
    const stored = '2026-10-24';
    expect(formatUkDate(stored)).toBe('24/10/26');
    expect(stored).toBe('2026-10-24');
    expect(formatUkSeasonLabel('Season 2026–2027')).toBe('Season 26–27');
  });
  it('uses British summer time and returns to GMT at the autumn boundary', () => {
    expect(formatUkDateTime('2026-10-25T00:30:00Z')).toContain('01:30');
    expect(formatUkDateTime('2026-10-25T01:30:00Z')).toContain('01:30');
    expect(formatUkDateTime('2026-03-29T01:30:00Z')).toContain('02:30');
    expect(londonDateKey(Date.parse('2026-07-01T23:30:00Z'))).toBe('2026-07-02');
    expect(londonDateKey(Date.parse('2026-12-01T23:30:00Z'))).toBe('2026-12-01');
  });
  it('keeps missing or invalid dates legible', () => {
    expect(formatUkDate(null)).toBe('Date to confirm');
    expect(formatUkDateTime('invalid')).toBe('Time to confirm');
  });
});
