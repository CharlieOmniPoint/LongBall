import { assertCanManageTeam, type Membership, type Principal } from './access';

export interface ControllerIdentity { accountId: string; principal: Principal; memberships: Membership[] }
export interface ControllerCacheScope {
  baseUrl: string; accountId: string; issuer: string; teamId: string; seasonId: string; matchId: string; deviceId: string;
}
/** The browser journal is fictional review storage; real controller data requires native encryption. */
export function controllerCachePlatformAllowed(mode: 'oidc' | 'synthetic', platform: string): boolean {
  return mode === 'synthetic' || platform === 'ios' || platform === 'android';
}
class ControllerScopeDenied extends Error { readonly code = 'CONTROLLER_SCOPE_DENIED'; }
export function controllerAuthorityWasDenied(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const detail = error as { code?: unknown; status?: unknown };
  return detail.code === 'CONTROLLER_SCOPE_DENIED' || [401, 403, 404].includes(typeof detail.status === 'number' ? detail.status : 0);
}

/** Call only with the authenticated /me response, before reading a controller cache. */
export function controllerCacheScope(identity: ControllerIdentity, target: Omit<ControllerCacheScope, 'accountId' | 'issuer'>, now: number): ControllerCacheScope {
  if (!identity?.principal || identity.accountId !== identity.principal.accountId || !identity.principal.issuer || !Array.isArray(identity.memberships)) throw new ControllerScopeDenied('The authenticated service identity is inconsistent.');
  for (const key of ['teamId', 'seasonId', 'matchId', 'deviceId'] as const) if (!target[key]?.trim()) throw new Error(`Select an explicit ${key} before opening a controller cache.`);
  assertCanManageTeam(identity.principal, identity.memberships, target.teamId, target.seasonId, now);
  return { ...target, accountId: identity.principal.accountId, issuer: identity.principal.issuer };
}

/** JSON tuple encoding keeps distinct principals/scopes distinct without hash collisions. */
export function controllerCacheDocumentId(scope: ControllerCacheScope): string {
  return `connected-authorized-v2:${JSON.stringify([scope.baseUrl, scope.issuer, scope.accountId, scope.teamId, scope.seasonId, scope.matchId, scope.deviceId])}`;
}

export function assertControllerDownloadScope(scope: ControllerCacheScope, download: { matchId: string; teamId?: string; seasonId?: string }): void {
  if (download.matchId !== scope.matchId || download.teamId !== scope.teamId || download.seasonId !== scope.seasonId) throw new ControllerScopeDenied('Downloaded match does not belong to the selected controller team and season. Cached records were retained.');
}

export interface ControllerSessionGate {
  accountId: string; issuer: string; locked: boolean; expired: boolean;
  identityClassification: Principal['identityClassification']; adultVerified: boolean; strongAuth: boolean; memberships: Membership[];
}
export function controllerSessionAllowsCache(scope: ControllerCacheScope, session: ControllerSessionGate | null, now: number): boolean {
  if (!session || session.accountId !== scope.accountId || session.issuer !== scope.issuer || session.locked || session.expired || session.identityClassification !== 'adult_individual' || !session.adultVerified || !session.strongAuth) return false;
  return session.memberships.some(item => item.accountId === scope.accountId && item.teamId === scope.teamId && item.seasonId === scope.seasonId && item.role === 'manager' && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > now));
}
