/** Foreground, read-only polling. The recorder's timestamps are never replaced by fetch time. */
export interface ForegroundRefreshPort {
  read: (signal: AbortSignal, refreshRelated: boolean) => Promise<void>;
  onFailure?: (error: unknown) => 'retry' | 'stop';
  onSuccess?: () => void;
  /** Tests may inject a controlled clock; production uses wall time only for network cadence. */
  now?: () => number;
  /** The next accepted read may change the cadence, e.g. discovering a live game. */
  intervalMs?: () => number;
}
export interface ForegroundRefresh {
  setForeground: (foreground: boolean) => void;
  stop: () => void;
}
export const SHARED_MATCH_REFRESH_MS = 3_000;
export const SHARED_IDLE_REFRESH_MS = 120_000;
export const SHARED_RELATED_REFRESH_MS = 15_000;
export const SHARED_REFRESH_MAX_BACKOFF_MS = 30_000;
/** At most one read is in flight. Hidden/background views abort and never run timers. */
export function startForegroundRefresh(port: ForegroundRefreshPort, initiallyForeground = true): ForegroundRefresh {
  let stopped = false, foreground = initiallyForeground, pending = false, failures = 0, resumeRequested = false;
  let timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | null = null;
  let relatedAt: number | null = null;
  const now = port.now ?? Date.now;
  const cadence = () => {
    const value = port.intervalMs?.() ?? SHARED_MATCH_REFRESH_MS;
    return Number.isFinite(value) && value >= 1_000 ? Math.min(value, 2_147_000_000) : SHARED_MATCH_REFRESH_MS;
  };
  const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const schedule = (delay: number) => {
    clear(); if (stopped || !foreground || pending) return;
    timer = setTimeout(() => { timer = undefined; void tick(); }, Math.min(delay, 2_147_000_000));
  };
  const tick = async () => {
    if (stopped || !foreground || pending) return;
    pending = true; controller = new AbortController();
    const active = controller, stamp = now();
    const related = relatedAt === null || stamp - relatedAt >= SHARED_RELATED_REFRESH_MS;
    try {
      await port.read(active.signal, related);
      if (stopped || !foreground || active.signal.aborted) return;
      failures = 0; if (related) relatedAt = now(); port.onSuccess?.();
    } catch (error) {
      if (stopped || !foreground || active.signal.aborted) return;
      failures = Math.min(failures + 1, 4);
      if (port.onFailure?.(error) === 'stop') stopped = true;
    } finally {
      pending = false; if (controller === active) controller = null;
      if (!stopped && foreground) {
        const interval = cadence();
        // An idle viewer must not retry more often than its healthy cadence.
        const immediate = resumeRequested; resumeRequested = false;
        schedule(immediate ? 0 : failures ? Math.min(Math.max(SHARED_REFRESH_MAX_BACKOFF_MS, interval * 4), interval * 2 ** failures) : interval);
      }
    }
  };
  schedule(cadence());
  return {
    setForeground(value) {
      if (stopped || foreground === value) return;
      foreground = value; clear();
      if (!foreground) { resumeRequested = false; controller?.abort(); }
      else { failures = 0; relatedAt = null; if (pending) resumeRequested = true; else schedule(0); }
    },
    stop() { stopped = true; clear(); controller?.abort(); },
  };
}
