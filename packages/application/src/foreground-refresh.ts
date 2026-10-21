/** Foreground, read-only polling. The recorder's timestamps are never replaced by fetch time. */
export interface ForegroundRefreshPort {
  read: (signal: AbortSignal, refreshRelated: boolean) => Promise<void>;
  onFailure?: (error: unknown) => 'retry' | 'stop';
  onSuccess?: () => void;
  /** Tests may inject a controlled clock; production uses wall time only for network cadence. */
  now?: () => number;
}
export interface ForegroundRefresh {
  setForeground: (foreground: boolean) => void;
  stop: () => void;
}
export const SHARED_MATCH_REFRESH_MS = 3_000;
export const SHARED_RELATED_REFRESH_MS = 15_000;
export const SHARED_REFRESH_MAX_BACKOFF_MS = 30_000;
/** At most one read is in flight. Hidden/background views abort and never run timers. */
export function startForegroundRefresh(port: ForegroundRefreshPort, initiallyForeground = true): ForegroundRefresh {
  let stopped = false, foreground = initiallyForeground, pending = false, failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | null = null;
  let relatedAt: number | null = null;
  const now = port.now ?? Date.now;
  const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const schedule = (delay: number) => {
    clear(); if (stopped || !foreground || pending) return;
    timer = setTimeout(() => { timer = undefined; void tick(); }, delay);
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
      if (!stopped && foreground) schedule(failures ? Math.min(SHARED_REFRESH_MAX_BACKOFF_MS, SHARED_MATCH_REFRESH_MS * 2 ** failures) : SHARED_MATCH_REFRESH_MS);
    }
  };
  schedule(SHARED_MATCH_REFRESH_MS);
  return {
    setForeground(value) {
      if (stopped || foreground === value) return;
      foreground = value; clear();
      if (!foreground) controller?.abort();
      else { failures = 0; relatedAt = null; schedule(0); }
    },
    stop() { stopped = true; clear(); controller?.abort(); },
  };
}
