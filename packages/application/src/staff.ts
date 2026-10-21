import { AccessError, assertAdultAuthority, assertTeamRole, type Membership, type Principal } from './access';

export interface StaffAccountEvidence { accountId: string; label: string; status: Principal['status']; identityClassification: Principal['identityClassification']; adultVerified: boolean; strongAuthEnrolled: boolean }
export interface ManagerRosterDto {
  kind: 'manager-roster'; revision: number; teamId: string; seasonId: string; asOf: string; maximumManagers: 4; activeTeamManagerCount: number; canMutate: boolean;
  managers: { accountId: string; label: string; status: 'active' | 'expired' | 'revoked' | 'disabled'; expiresAt: number | null; revokedAt: number | null; otherActiveSeasonIds: string[] }[];
  candidates: { accountId: string; label: string; currentManager: boolean }[];
}
const current = (item: Membership, nowMs: number) => item.revokedAt == null && (item.expiresAt == null || item.expiresAt > nowMs);
const eligible = (account: StaffAccountEvidence) => account.status === 'active' && account.identityClassification === 'adult_individual' && account.adultVerified && account.strongAuthEnrolled;
/** A scoped staff DTO has no child profiles, credentials or global account directory. */
export function managerRoster(input: { principal: Principal; memberships: Membership[]; accounts: StaffAccountEvidence[]; teamId: string; seasonId: string; nowMs: number; revision: number; requestedRole?: string }): ManagerRosterDto {
  const { principal, memberships, accounts, teamId, seasonId, nowMs } = input;
  if (input.requestedRole && input.requestedRole !== 'administrator') throw new AccessError('NOT_FOUND', 404, 'Choose the current administrator context for staff management.');
  assertTeamRole(principal, memberships, teamId, seasonId, ['administrator'], nowMs); assertAdultAuthority(principal, false, nowMs);
  if (!Number.isSafeInteger(input.revision) || input.revision < 0 || !Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('Use the authoritative staff revision and current service time.');
  const associated = new Set(memberships.filter(item => item.teamId === teamId && current(item, nowMs)).map(item => item.accountId));
  // Match the authoritative assignment cap: a disabled account's place remains occupied until explicitly revoked.
  const liveManagers = memberships.filter(item => item.teamId === teamId && item.role === 'manager' && current(item, nowMs));
  const managers = memberships.filter(item => item.teamId === teamId && item.seasonId === seasonId && item.role === 'manager').map(item => {
    const account = accounts.find(account => account.accountId === item.accountId);
    return { accountId: item.accountId, label: account && account.identityClassification === 'adult_individual' && account.adultVerified ? account.label : 'Unavailable manager account', status: !account || !eligible(account) ? 'disabled' as const : item.revokedAt != null ? 'revoked' as const : item.expiresAt != null && item.expiresAt <= nowMs ? 'expired' as const : 'active' as const,
      expiresAt: item.expiresAt ?? null, revokedAt: item.revokedAt ?? null, otherActiveSeasonIds: [...new Set(liveManagers.filter(other => other.accountId === item.accountId && other.seasonId !== seasonId).map(other => other.seasonId))].sort() };
  }).sort((a, b) => a.label.localeCompare(b.label) || a.accountId.localeCompare(b.accountId));
  const candidates = accounts.filter(account => associated.has(account.accountId) && eligible(account)).map(account => ({ accountId: account.accountId, label: account.label, currentManager: liveManagers.some(item => item.accountId === account.accountId && item.seasonId === seasonId) })).sort((a, b) => a.label.localeCompare(b.label) || a.accountId.localeCompare(b.accountId));
  return { kind: 'manager-roster', revision: input.revision, teamId, seasonId, asOf: new Date(nowMs).toISOString(), maximumManagers: 4, activeTeamManagerCount: new Set(liveManagers.map(item => item.accountId)).size, canMutate: principal.authenticatedAt <= nowMs + 30_000 && nowMs - principal.authenticatedAt <= 300_000, managers, candidates };
}
