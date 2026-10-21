import { afterEach, describe, expect, it, vi } from 'vitest';
import { startForegroundRefresh } from './foreground-refresh';
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
afterEach(() => vi.useRealTimers());
describe('API06 foreground shared-match refresh', () => {
  it('polls accepted reads every three seconds and related awards/reports on a slower bounded cadence', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const related: boolean[] = [], read = vi.fn(async (_signal: AbortSignal, includeRelated: boolean) => { related.push(includeRelated); });
    const poll = startForegroundRefresh({ read });
    await vi.advanceTimersByTimeAsync(2_999); expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(18_001);
    expect(read).toHaveBeenCalledTimes(7); expect(related).toEqual([true, false, false, false, false, true, false]);
    poll.stop(); await vi.advanceTimersByTimeAsync(60_000); expect(read).toHaveBeenCalledTimes(7);
  });
  it('never overlaps a slow read and aborts it when hidden, without reporting a cancellation as a failure', async () => {
    vi.useFakeTimers(); let release!: () => void; let signal!: AbortSignal;
    const read = vi.fn(async (input: AbortSignal) => { signal = input; await new Promise<void>(resolve => { release = resolve; }); }), failure = vi.fn();
    const poll = startForegroundRefresh({ read, onFailure: failure });
    await vi.advanceTimersByTimeAsync(3_000); await vi.advanceTimersByTimeAsync(60_000); expect(read).toHaveBeenCalledTimes(1);
    poll.setForeground(false); expect(signal.aborted).toBe(true); release(); await settle();
    await vi.advanceTimersByTimeAsync(60_000); expect(read).toHaveBeenCalledTimes(1); expect(failure).not.toHaveBeenCalled();
    poll.setForeground(true); await vi.advanceTimersByTimeAsync(0); expect(read).toHaveBeenCalledTimes(2);
    poll.stop(); release(); await settle();
  });
  it('backs off transient failures to thirty seconds and resumes the healthy cadence after success', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const stamps: number[] = [];
    const read = vi.fn(async () => { stamps.push(Date.now()); if (stamps.length < 6) throw new Error('offline'); });
    const poll = startForegroundRefresh({ read, onFailure: () => 'retry' });
    await vi.advanceTimersByTimeAsync(105_000);
    expect(stamps).toEqual([3_000, 9_000, 21_000, 45_000, 75_000, 105_000]);
    await vi.advanceTimersByTimeAsync(3_000); expect(stamps.at(-1)).toBe(108_000); poll.stop();
  });
  it('stops permanently on an authority failure and does not start while backgrounded', async () => {
    vi.useFakeTimers(); const read = vi.fn(async () => { throw new Error('access expired'); });
    const poll = startForegroundRefresh({ read, onFailure: () => 'stop' }, false);
    await vi.advanceTimersByTimeAsync(60_000); expect(read).not.toHaveBeenCalled();
    poll.setForeground(true); await vi.advanceTimersByTimeAsync(0); expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000); poll.setForeground(false); poll.setForeground(true); await vi.advanceTimersByTimeAsync(10_000); expect(read).toHaveBeenCalledTimes(1);
  });
});
