import { describe, expect, it } from 'vitest';
import { demoSessionDeadline, demoSessionExpired } from './demo-session-deadline';

describe('demo auth-view deadline', () => {
  it('expires at either observed wall or in-process deadline, including a sleeping/hidden view', () => {
    const deadline = demoSessionDeadline(7_000, 1_000, 50);
    expect(demoSessionExpired(deadline, 6_999, 6_049)).toBe(false);
    expect(demoSessionExpired(deadline, 7_000, 100)).toBe(true);
    expect(demoSessionExpired(deadline, 6_500, 6_050)).toBe(true);
  });
  it('fails closed for a rolled-back wall clock, clock continuity loss or malformed lifetime', () => {
    const deadline = demoSessionDeadline(10_000, 5_000, 100);
    expect(demoSessionExpired(deadline, 3_999, 101)).toBe(true);
    expect(demoSessionExpired(deadline, 5_001, 99)).toBe(true);
    expect(demoSessionExpired(deadline, NaN, 101)).toBe(true);
    expect(demoSessionExpired(demoSessionDeadline(5_000, 5_000, 100), 5_000, 100)).toBe(true);
  });
});
