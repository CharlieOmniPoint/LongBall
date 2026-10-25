import { describe, expect, it } from 'vitest';
import type { Membership, Principal } from './access';
import { managerRoster, type StaffAccountEvidence } from './staff';
const nowMs = 1_800_000_000_000;
function fixture() {
  const principal: Principal = { accountId: 'admin', issuer: 'https://identity.example', subject: 'admin', identityClassification: 'adult_individual', adultVerified: true, strongAuth: true, authenticatedAt: nowMs, status: 'active' };
  const memberships: Membership[] = [{ accountId: 'admin', teamId: 'roma', seasonId: '2026-27', role: 'administrator' }, { accountId: 'manager', teamId: 'roma', seasonId: '2026-27', role: 'manager' }, { accountId: 'manager', teamId: 'roma', seasonId: '2025-26', role: 'manager' }, { accountId: 'candidate', teamId: 'roma', seasonId: '2026-27', role: 'spectator' }, { accountId: 'child', teamId: 'roma', seasonId: '2026-27', role: 'player', playerId: 'child-player' }];
  const adult = (accountId: string): StaffAccountEvidence => ({ accountId, label: `Label ${accountId}`, identityClassification: 'adult_individual', adultVerified: true, strongAuthEnrolled: true, status: 'active' });
  const accounts: StaffAccountEvidence[] = [adult('admin'), adult('manager'), adult('candidate'), adult('other-private-account'), { ...adult('child'), identityClassification: 'child_shared', label: 'PRIVATE CHILD LABEL' }];
  return { principal, memberships, accounts, teamId: 'roma', seasonId: '2026-27', nowMs, revision: 8, requestedRole: 'administrator' };
}
describe('scoped existing-account manager roster', () => {
  it('exposes only scoped verified adult candidates and counts distinct managers across seasons', () => {
    const input = fixture(), before = JSON.stringify(input), dto = managerRoster(input);
    expect(dto).toMatchObject({ revision: 8, maximumManagers: 4, activeTeamManagerCount: 1, canMutate: true });
    expect(dto.managers[0]).toMatchObject({ accountId: 'manager', status: 'active', otherActiveSeasonIds: ['2025-26'] });
    expect(dto.candidates.map(item => item.accountId).sort()).toEqual(['admin', 'candidate', 'manager']);
    expect(JSON.stringify(dto)).not.toContain('PRIVATE CHILD'); expect(JSON.stringify(dto)).not.toContain('other-private');
    expect(JSON.stringify(input)).toBe(before);
  });
  it('requires selected current administrator stronger adult authority and labels old strong sessions read-only', () => {
    const input = fixture();
    for (const changed of [{ requestedRole: 'manager' }, { principal: { ...input.principal, strongAuth: false } }, { principal: { ...input.principal, identityClassification: 'child_shared' as const } }, { memberships: input.memberships.filter(item => item.accountId !== 'admin') }, { memberships: input.memberships.map(item => ({ ...item, expiresAt: nowMs })) }]) expect(() => managerRoster({ ...input, ...changed })).toThrow();
    expect(managerRoster({ ...input, principal: { ...input.principal, authenticatedAt: nowMs - 300_001 } }).canMutate).toBe(false);
    expect(managerRoster({ ...input, principal: { ...input.principal, authenticatedAt: nowMs + 30_001 } }).canMutate).toBe(false);
  });
  it('retains disabled/expired/revoked rows and does not silently free a disabled manager assignment', () => {
    const input = fixture(); input.accounts.find(item => item.accountId === 'manager')!.status = 'disabled';
    input.memberships.push({ accountId: 'expired', teamId: 'roma', seasonId: '2026-27', role: 'manager', expiresAt: nowMs }, { accountId: 'revoked', teamId: 'roma', seasonId: '2026-27', role: 'manager', revokedAt: nowMs });
    const evidence = input.accounts.find(item => item.accountId === 'admin')!; input.accounts.push({ ...evidence, accountId: 'expired', label: 'Expired manager' }, { ...evidence, accountId: 'revoked', label: 'Revoked manager' });
    const dto = managerRoster(input); expect(dto.activeTeamManagerCount).toBe(1);
    expect(dto.managers.map(item => item.status).sort()).toEqual(['disabled', 'expired', 'revoked']);
    expect(dto.candidates.some(item => item.accountId === 'manager')).toBe(false);
    input.memberships.filter(item => item.accountId === 'manager').forEach(item => { item.revokedAt = nowMs; });
    expect(managerRoster(input).activeTeamManagerCount).toBe(0);
  });
  it('does not expose a child label through a corrupt manager row or a revoked candidate association', () => {
    const input = fixture(); input.memberships.push({ accountId: 'child', teamId: 'roma', seasonId: '2026-27', role: 'manager' });
    input.memberships.find(item => item.accountId === 'candidate')!.revokedAt = nowMs;
    const dto = managerRoster(input); expect(dto.candidates.some(item => item.accountId === 'candidate')).toBe(false);
    expect(dto.managers.find(item => item.accountId === 'child')).toMatchObject({ label: 'Unavailable manager account', status: 'disabled' });
    expect(JSON.stringify(dto)).not.toContain('PRIVATE CHILD LABEL');
  });
  it('does not offer inherited managers as new appointments or count them as appointed seats', () => {
    const input = fixture();
    input.memberships.push({ accountId: 'admin', teamId: 'roma', seasonId: '2026-27', role: 'manager', administrativeInheritance: true });
    const dto = managerRoster(input);
    expect(dto.candidates.find(item => item.accountId === 'admin')?.currentManager).toBe(true);
    expect(dto.managers.map(item => item.accountId)).toEqual(['manager']);
    expect(dto.activeTeamManagerCount).toBe(1);
    input.memberships.push({ accountId: 'candidate', teamId: 'other-team', seasonId: '2026-27', role: 'manager', administrativeInheritance: true });
    expect(managerRoster(input).candidates.find(item => item.accountId === 'candidate')?.currentManager).toBe(false);
    input.memberships.find(item => item.accountId === 'admin' && item.role === 'manager')!.revokedAt = nowMs;
    expect(managerRoster(input).candidates.find(item => item.accountId === 'admin')?.currentManager).toBe(false);
  });

});
