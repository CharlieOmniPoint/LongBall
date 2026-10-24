import type { Membership, Principal } from '@longball/application/access';
import { attachWorkspaceValue, sameWorkspaceBinding, type BoundWorkspaceValue, type WorkspaceBinding } from '@longball/application/workspace-boundary';

/** Keep a same-context form mounted only after fresh authority validates its new request generation. */
export function rebindWorkspaceRefresh<T>(cached: BoundWorkspaceValue<T> | null, previous: WorkspaceBinding | null, next: WorkspaceBinding, principal: Principal, memberships: Membership[], nowMs: number): BoundWorkspaceValue<T> | null {
  if (!cached || !previous || !Number.isSafeInteger(next.generation) || next.generation <= previous.generation || !sameWorkspaceBinding(cached.binding, previous) || !sameWorkspaceBinding({ ...previous, generation: next.generation }, next)) return null;
  return attachWorkspaceValue(next, next, principal, memberships, nowMs, cached.value);
}
