import { describe, expect, it } from 'vitest';
import type { Membership, Principal } from './access';
import { isSamePendingPrivacyRequest, parseAccountPrivacyRequestsDto, parsePrivacyRequestDto, parsePrivacyRequestInput, prepareAccountPrivacyRequest, privacyRequestBusinessKey, projectAccountPrivacyRequests, type PrivacyRequestRecord } from './privacy-requests';

const nowMs = 1_800_000_000_000;
const principal: Principal = { accountId: 'own-account', issuer: 'https://identity.example', subject: 'own-subject', identityClassification: 'child_shared', adultVerified: false, strongAuth: false, authenticatedAt: nowMs, status: 'active' };
const memberships: Membership[] = [
  { accountId: principal.accountId, teamId: 'roma', seasonId: '2026-27', role: 'player', playerId: 'own-player' },
  { accountId: principal.accountId, teamId: 'willow', seasonId: '2025-26', role: 'spectator', expiresAt: nowMs },
  { accountId: principal.accountId, teamId: 'maple', seasonId: '2026-27', role: 'spectator', revokedAt: nowMs - 1 },
  { accountId: 'another-account', teamId: 'secret-team', seasonId: 'secret-season', role: 'manager' },
];
const globalInput = { kind: 'delete_account', scope: 'all_memberships', confirmAllMemberships: true } as const;
function record(changes: Partial<PrivacyRequestRecord> = {}): PrivacyRequestRecord {
  const planned = prepareAccountPrivacyRequest({ principal, memberships, input: globalInput, nowMs });
  return { requestId: 'request-1', accountId: principal.accountId, kind: planned.kind, scope: planned.scope, affectedMemberships: planned.affectedMemberships, status: planned.status, createdAtMs: nowMs, ...changes };
}
describe('own account privacy request boundaries', () => {
  it('requires explicit global confirmation and rejects caller identity, ambiguous leave and fulfilment fields', () => {
    for (const value of [{ kind: 'delete_account' }, { ...globalInput, confirmAllMemberships: false }, { ...globalInput, accountId: 'another-account' }, { ...globalInput, erased: true }, { kind: 'leave_team', teamId: 'roma' }, { kind: 'leave_team', teamId: 'roma', seasonId: '2026-27', confirmLeave: false }, { ...globalInput, teamId: 'roma' }]) expect(() => parsePrivacyRequestInput(value)).toThrow();
    expect(parsePrivacyRequestInput(globalInput)).toEqual(globalInput);
    expect(() => prepareAccountPrivacyRequest({ principal: { ...principal, status: 'disabled' }, memberships, input: globalInput, nowMs })).toThrow();
  });
  it('captures all own memberships including old/revoked ones without changing any authority or another account', () => {
    const before = JSON.stringify(memberships);
    const planned = prepareAccountPrivacyRequest({ principal, memberships, input: globalInput, nowMs });
    expect(planned.affectedMemberships.map(item => item.status).sort()).toEqual(['active', 'expired', 'revoked']);
    expect(JSON.stringify(planned)).not.toContain('secret-team');
    expect(planned).toMatchObject({ status: 'pending_verification_and_policy', verificationRequired: true, erased: false, fulfilled: false, scope: { type: 'all_memberships' } });
    expect(JSON.stringify(memberships)).toBe(before);
    expect(planned.businessKey).toBe(JSON.stringify([principal.accountId, 'delete_account', 'all_memberships']));
  });
  it('requires a current selected own team-season membership and never scopes leave across other teams', () => {
    const input = { kind: 'leave_team', teamId: 'roma', seasonId: '2026-27', confirmLeave: true } as const;
    const planned = prepareAccountPrivacyRequest({ principal, memberships, input, nowMs });
    expect(planned.affectedMemberships).toEqual([{ teamId: 'roma', seasonId: '2026-27', role: 'player', playerId: 'own-player', status: 'active' }]);
    expect(planned.businessKey).toBe(JSON.stringify([principal.accountId, 'leave_team', 'team_season', 'roma', '2026-27']));
    for (const change of [{ teamId: 'secret-team', seasonId: 'secret-season' }, { teamId: 'willow', seasonId: '2025-26' }, { teamId: 'maple', seasonId: '2026-27' }, { seasonId: 'other-season' }]) expect(() => prepareAccountPrivacyRequest({ principal, memberships, input: { ...input, ...change }, nowMs })).toThrow();
  });
  it('uses collision-free stable account/kind/scope keys independent of request IDs and membership changes', () => {
    const first = prepareAccountPrivacyRequest({ principal, memberships, input: globalInput, nowMs });
    expect(prepareAccountPrivacyRequest({ principal, memberships: [], input: globalInput, nowMs: nowMs + 1 }).businessKey).toBe(first.businessKey);
    for (const key of [privacyRequestBusinessKey('another-account', 'delete_account', first.scope), privacyRequestBusinessKey(principal.accountId, 'export', first.scope), privacyRequestBusinessKey(principal.accountId, 'leave_team', { type: 'team_season', teamId: 'roma', seasonId: '2026-27' })]) expect(key).not.toBe(first.businessKey);
  });
  it('retains legacy duplicate rows and original snapshots, flags later duplicates without inventing fulfilment', () => {
    const first = record(), later = record({ requestId: 'request-2', createdAtMs: nowMs + 1 });
    const dto = projectAccountPrivacyRequests({ principal, memberships: [], records: [later, record({ accountId: 'another-account', requestId: 'hidden-request' }), first], nowMs });
    expect(dto.items.map(item => item.requestId)).toEqual(['request-1', 'request-2']);
    expect(dto.items[0].affectedMemberships).toEqual(first.affectedMemberships); expect(dto.memberships).toEqual([]);
    expect(dto.items[1]).toMatchObject({ status: 'pending_verification_and_policy', reviewStatus: 'duplicate_requires_review', duplicateOfRequestId: first.requestId, erased: false, fulfilled: false });
    expect(isSamePendingPrivacyRequest(dto.items[0], globalInput)).toBe(true); expect(isSamePendingPrivacyRequest(dto.items[1], globalInput)).toBe(false);
    expect(JSON.stringify(dto)).not.toContain('another-account');
  });
  it('does not guess a legacy leave scope and validates own response DTOs without private extras', () => {
    const dto = projectAccountPrivacyRequests({ principal, memberships, records: [record({ kind: 'leave_team', scope: null, affectedMemberships: null, status: 'needs_scope' })], nowMs });
    expect(dto.items[0]).toMatchObject({ scope: null, affectedMemberships: null, scopeStatus: 'needs_scope', reviewStatus: 'needs_scope', fulfilled: false });
    expect(parseAccountPrivacyRequestsDto(JSON.parse(JSON.stringify(dto)))).toEqual(dto);
    expect(() => parsePrivacyRequestDto({ ...dto.items[0], erased: true })).toThrow();
    expect(() => parseAccountPrivacyRequestsDto({ ...dto, anotherAccount: 'private' })).toThrow();
    expect(() => parsePrivacyRequestDto({ ...dto.items[0], status: 'fulfilled' })).toThrow();
  });
});
