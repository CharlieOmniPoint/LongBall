import { currentMemberships, type Membership, type Principal } from "./access";

export interface WorkspaceBinding {
  generation: number;
  apiBaseUrl: string;
  accountId: string;
  issuer: string;
  subject: string;
  teamId: string;
  seasonId: string;
  role: "administrator" | "manager" | "player" | "spectator";
  playerId: string | null;
}
export interface BoundWorkspaceValue<T> {
  binding: WorkspaceBinding;
  value: T;
}
export interface WorkspaceSessionAccess {
  sessionId: string;
  accountId: string;
  issuer: string;
  subject: string;
  expiresAtMs: number;
  expired: boolean;
  locked: boolean;
  config: { apiBaseUrl: string };
}
function apiIdentity(url: string): string {
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error("Invalid API identity.");
  return `${parsed.origin}${parsed.pathname.replace(/\/$/, "").replace(/\/v1$/, "")}`;
}
export function workspaceSessionAllows(
  session: WorkspaceSessionAccess | null,
  apiBaseUrl: string,
  nowMs: number,
): boolean {
  try {
    return Boolean(
      session &&
        !session.locked &&
        !session.expired &&
        Number.isFinite(nowMs) &&
        nowMs < session.expiresAtMs &&
        session.accountId &&
        session.issuer &&
        session.subject &&
        session.sessionId &&
        apiIdentity(session.config.apiBaseUrl) === apiIdentity(apiBaseUrl),
    );
  } catch {
    return false;
  }
}
export function sameWorkspaceBinding(
  left: WorkspaceBinding | null,
  right: WorkspaceBinding | null,
): boolean {
  return Boolean(
    left &&
      right &&
      (Object.keys(left) as (keyof WorkspaceBinding)[]).every(
        (key) => left[key] === right[key],
      ),
  );
}
export function workspaceBindingIsCurrent(
  binding: WorkspaceBinding | null,
  principal: Principal | null,
  memberships: Membership[],
  nowMs: number,
): boolean {
  if (
    !binding ||
    !principal ||
    principal.accountId !== binding.accountId ||
    principal.issuer !== binding.issuer ||
    principal.subject !== binding.subject
  )
    return false;
  const membership = currentMemberships(principal, memberships, nowMs).find(
    (item) =>
      item.teamId === binding.teamId &&
      item.seasonId === binding.seasonId &&
      item.role === binding.role &&
      (binding.role !== "player" ||
        (Boolean(binding.playerId) && item.playerId === binding.playerId)),
  );
  if (!membership) return false;
  return (
    !["manager", "administrator"].includes(binding.role) ||
    (principal.identityClassification === "adult_individual" &&
      principal.adultVerified &&
      principal.strongAuth)
  );
}
/** Invitation acceptance has no prior scoped outbox: never await an outbox that cannot exist yet. */
export function workspaceNeedsProtectedOutbox(
  protectedStorage: boolean,
  binding: WorkspaceBinding | null,
  principal: Principal | null,
  memberships: Membership[],
  nowMs: number,
): boolean {
  return (
    protectedStorage &&
    workspaceBindingIsCurrent(binding, principal, memberships, nowMs)
  );
}
/** Used at response attachment and again at render; a late reply cannot change its original identity/scope. */
export function attachWorkspaceValue<T>(
  binding: WorkspaceBinding,
  current: WorkspaceBinding | null,
  principal: Principal | null,
  memberships: Membership[],
  nowMs: number,
  value: T,
): BoundWorkspaceValue<T> | null {
  return sameWorkspaceBinding(binding, current) &&
    workspaceBindingIsCurrent(binding, principal, memberships, nowMs)
    ? { binding, value }
    : null;
}
export function readWorkspaceValue<T>(
  cached: BoundWorkspaceValue<T> | null,
  expected: WorkspaceBinding | null,
  principal: Principal | null,
  memberships: Membership[],
  nowMs: number,
): T | null {
  return cached &&
    sameWorkspaceBinding(cached.binding, expected) &&
    workspaceBindingIsCurrent(cached.binding, principal, memberships, nowMs)
    ? cached.value
    : null;
}
