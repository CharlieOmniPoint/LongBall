/** Auth-view expiry only. This is never a match clock, continuous-clock anchor or server authority. */
export interface DemoSessionDeadline {
  expiresAtMs: number;
  observedWallMs: number;
  observedMonotonicMs: number;
  remainingMs: number;
}
export function demoSessionDeadline(expiresAtMs: number, wallMs: number, monotonicMs: number): DemoSessionDeadline {
  return { expiresAtMs, observedWallMs: wallMs, observedMonotonicMs: monotonicMs, remainingMs: expiresAtMs - wallMs };
}
/** A wall-clock rollback or a lost in-process clock closes the local view instead of extending it. */
export function demoSessionExpired(deadline: DemoSessionDeadline, wallMs: number, monotonicMs: number): boolean {
  const values = [deadline.expiresAtMs, deadline.observedWallMs, deadline.observedMonotonicMs, deadline.remainingMs, wallMs, monotonicMs];
  return values.some(value => !Number.isFinite(value)) || deadline.remainingMs <= 0 || wallMs < deadline.observedWallMs - 1000 || monotonicMs < deadline.observedMonotonicMs || wallMs >= deadline.expiresAtMs || monotonicMs - deadline.observedMonotonicMs >= deadline.remainingMs;
}
