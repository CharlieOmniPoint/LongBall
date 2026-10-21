import { describe, expect, it } from 'vitest';
import { createMatch } from '../../domain/src/index';
import { assertCanAssignManager, assertCanManageTeam, assertTeamRole, filterMatchForPrincipal, UNAPPROVED_SHARING_POLICY, type Membership, type Principal } from './access';

const now = 1_800_000_000_000;
const principal = (accountId: string, patch: Partial<Principal> = {}): Principal => ({ accountId, issuer: 'synthetic', subject: accountId, identityClassification: 'adult_individual', adultVerified: true, strongAuth: true, authenticatedAt: now, status: 'active', ...patch });
const member = (accountId: string, role: Membership['role'], patch: Partial<Membership> = {}): Membership => ({ accountId, teamId: 'roma', seasonId: '26', role, ...patch });
describe('SEC07–09 current server authority', () => {
  it('counts an administrator-manager toward four and refuses a fifth', () => {
    const memberships = [member('admin', 'administrator'), member('admin', 'manager'), ...['m2', 'm3', 'm4'].map(id => member(id, 'manager'))];
    expect(() => assertCanAssignManager(principal('admin'), principal('m5'), memberships, 'roma', '26', now)).toThrow('at most four');
    expect(() => assertCanAssignManager(principal('admin'), principal('m4'), memberships, 'roma', '26', now)).not.toThrow();
    memberships[3].seasonId = '25';
    expect(() => assertCanAssignManager(principal('admin'), principal('m5'), memberships, 'roma', '26', now)).toThrow('at most four');
  });
  it('never promotes a child through MFA or a supplied manager membership', () => {
    const child = principal('child', { identityClassification: 'child_shared' });
    expect(() => assertCanManageTeam(child, [member('child', 'manager')], 'roma', '26', now)).toThrow('verified adult');
    expect(() => assertCanAssignManager(principal('admin'), child, [member('admin', 'administrator')], 'roma', '26', now)).toThrow('verified adult');
  });
  it('denies other teams, expired grants, revoked access and disabled accounts', () => {
    for (const memberships of [[member('viewer', 'spectator', { teamId: 'other' })], [member('viewer', 'spectator', { expiresAt: now })], [member('viewer', 'spectator', { revokedAt: now - 1 })]]) {
      expect(() => assertTeamRole(principal('viewer'), memberships, 'roma', '26', ['spectator'], now)).toThrow('unavailable');
    }
    expect(() => assertTeamRole(principal('viewer', { status: 'disabled' }), [member('viewer', 'player')], 'roma', '26', ['player'], now)).toThrow();
  });
});
describe('SEC10–12 allowlisted DTOs and Q21 default', () => {
  const state = createMatch({ matchId: 'game', players: [{ id: 'p1', displayName: 'One', goalkeeperChoice: 1 }, { id: 'p2', displayName: 'Two', goalkeeperChoice: 0 }], selectedPlayerIds: ['p1', 'p2'], pitchPlaces: 7, plannedHalfDurationMs: 1_500_000, fixedKeeperId: 'p1' });
  state.score = { for: 3, against: 1 };
  state.attendance = { p1: 'present', p2: 'absent' };
  state.intervals = [ { playerId: 'p1', state: 'playing', position: 'GK', slotId: 'gk', startMs: 0, endMs: 60_000, half: 1 }, { playerId: 'p2', state: 'unavailable', position: null, slotId: null, startMs: 0, endMs: 60_000, half: 1 } ];
  it('a child receives only their own named record and no unapproved score/derived disclosure', () => {
    const dto = filterMatchForPrincipal({ principal: principal('child', { identityClassification: 'child_shared' }), memberships: [member('child', 'player', { playerId: 'p1' })], teamId: 'roma', seasonId: '26', state, policy: UNAPPROVED_SHARING_POLICY, lastSyncAt: now - 60_000, now });
    expect(dto.score).toBeNull();
    expect(dto.freshness).toBe('updates_delayed');
    expect(JSON.stringify(dto)).not.toContain('p2');
    expect(dto).not.toHaveProperty('state');
    expect(dto).not.toHaveProperty('lineup');
    expect(dto.ownRecord).toMatchObject({ playingMs: 60_000, attendance: 'present' });
  });
  it('spectators receive no participation even when sharing is explicitly allowed', () => {
    const dto = filterMatchForPrincipal({ principal: principal('viewer'), memberships: [member('viewer', 'spectator')], teamId: 'roma', seasonId: '26', state, policy: { version: 'reviewed-1', approvedAt: now, approvedBy: 'owner', shareScores: true, shareDerivedResults: false }, lastSyncAt: now, now });
    expect(dto.score).toEqual({ for: 3, against: 1 });
    expect(dto).not.toHaveProperty('ownRecord');
    expect(JSON.stringify(dto)).not.toContain('p1');
    expect(JSON.stringify(dto)).not.toContain('absent');
  });
});
