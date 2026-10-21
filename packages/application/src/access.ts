import type { MatchState } from '../../domain/src/types';

export type Role = 'administrator' | 'manager' | 'player' | 'spectator';
export interface Principal {
  accountId: string;
  issuer: string;
  subject: string;
  identityClassification: 'child_shared' | 'adult_individual' | 'unclassified';
  adultVerified: boolean;
  strongAuth: boolean;
  authenticatedAt: number;
  status: 'active' | 'disabled';
}
export interface Membership {
  accountId: string;
  teamId: string;
  seasonId: string;
  role: Role;
  playerId?: string;
  expiresAt?: number | null;
  revokedAt?: number | null;
}
export class AccessError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message);
    this.name = 'AccessError';
  }
}
export function currentMemberships(principal: Principal, memberships: Membership[], now: number): Membership[] {
  if (principal.status !== 'active') return [];
  return memberships.filter(item => item.accountId === principal.accountId && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > now));
}
export function assertTeamRole(principal: Principal, memberships: Membership[], teamId: string, seasonId: string, roles: Role[], now = Date.now()): Membership {
  const match = currentMemberships(principal, memberships, now).find(item => item.teamId === teamId && item.seasonId === seasonId && roles.includes(item.role));
  if (!match) throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
  return match;
}
export function assertAdultAuthority(principal: Principal, recent = false, now = Date.now()): void {
  if (principal.status !== 'active' || principal.identityClassification !== 'adult_individual' || !principal.adultVerified || !principal.strongAuth) {
    throw new AccessError('ADULT_AUTHORITY_REQUIRED', 403, 'A verified adult account with stronger authentication is required.');
  }
  if (recent && (principal.authenticatedAt > now + 30_000 || now - principal.authenticatedAt > 300_000)) {
    throw new AccessError('RECENT_AUTHENTICATION_REQUIRED', 403, 'Recent stronger authentication is required.');
  }
}
export function assertCanManageTeam(principal: Principal, memberships: Membership[], teamId: string, seasonId: string, now = Date.now()): void {
  assertTeamRole(principal, memberships, teamId, seasonId, ['manager'], now);
  assertAdultAuthority(principal, false, now);
}
/** Call inside the same transaction as the assignment; a UI role toggle has no authority. */
export function assertCanAssignManager(actor: Principal, target: Principal, memberships: Membership[], teamId: string, seasonId: string, now = Date.now()): void {
  assertTeamRole(actor, memberships, teamId, seasonId, ['administrator'], now);
  assertAdultAuthority(actor, true, now);
  assertAdultAuthority(target, false, now);
  const managers = memberships.filter(item => item.teamId === teamId && item.role === 'manager' && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > now));
  if (!managers.some(item => item.accountId === target.accountId) && new Set(managers.map(item => item.accountId)).size >= 4) {
    throw new AccessError('MANAGER_LIMIT', 409, 'A team can have at most four active managers, including administrators who also manage.');
  }
}
export interface SharingPolicy {
  version: string;
  approvedBy: string | null;
  approvedAt: number | null;
  shareScores: boolean;
  shareDerivedResults: boolean;
}
export const UNAPPROVED_SHARING_POLICY: SharingPolicy = {
  version: 'q21-unapproved', approvedBy: null, approvedAt: null, shareScores: false, shareDerivedResults: false,
};
/** Construct allowlisted DTOs on the server. Never send manager data and hide it in the UI. */
export function filterMatchForPrincipal(input: {
  principal: Principal; memberships: Membership[]; teamId: string; seasonId: string;
  state: MatchState; policy: SharingPolicy; lastSyncAt: number | null; now?: number;
  requestedRole?: string;
}): Record<string, unknown> {
  const now = input.now ?? Date.now();
  const current = currentMemberships(input.principal, input.memberships, now);
  const available = current.filter(item => item.teamId === input.teamId && item.seasonId === input.seasonId && ['manager','player','spectator'].includes(item.role));
  const chosen = input.requestedRole ? available.find(item => item.role === input.requestedRole) : available.find(item => item.role === 'manager') ?? available.find(item => item.role === 'player') ?? available[0];
  if (!chosen) throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
  const role = assertTeamRole(input.principal, input.memberships, input.teamId, input.seasonId, [chosen.role], now);
  if (role.role === 'manager') {
    assertAdultAuthority(input.principal, false, now);
    return { matchId: input.state.config.matchId, teamId: input.teamId, seasonId: input.seasonId, audience: 'manager', revision: input.state.revision, state: input.state, lastRecorderSyncAt: input.lastSyncAt };
  }
  const scoresAllowed = input.policy.approvedBy !== null && input.policy.approvedAt !== null && input.policy.shareScores;
  const dto: Record<string, unknown> = {
    matchId: input.state.config.matchId, teamId: input.teamId, seasonId: input.seasonId,
    audience: role.role, revision: input.state.revision, status: input.state.status,
    score: scoresAllowed ? input.state.score : null,
    halfTimeScore: scoresAllowed ? input.state.halfTimeScore : null,
    sharingPolicyVersion: input.policy.version,
    sharingRestricted: !scoresAllowed,
    lastRecorderSyncAt: input.lastSyncAt,
    ...(input.state.config.fixture ? { opponent: input.state.config.fixture.opponent, playedDate: input.state.config.fixture.playedDate, homeAway: input.state.config.fixture.homeAway } : {}),
    freshness: input.lastSyncAt !== null && now - input.lastSyncAt <= 15_000 ? 'last_synced' : 'updates_delayed',
  };
  // Do not extrapolate a live clock or expose event payloads, teammate records, votes or injury reasons.
  if (role.role === 'player' && role.playerId) {
    const ownIntervals = input.state.intervals.filter(item => item.playerId === role.playerId);
    dto.ownRecord = {
      playerId: role.playerId, attendance: input.state.attendance[role.playerId] ?? 'not_recorded',
      playingMs: ownIntervals.filter(item => item.state === 'playing').reduce((sum, item) => sum + item.endMs - item.startMs, 0),
      intervals: ownIntervals,
      completeness: input.state.recoveryRequired ? 'review_required' : 'recorded_to_last_sync',
    };
  }
  return dto;
}
