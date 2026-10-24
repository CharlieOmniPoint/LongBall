import { describe, expect, it } from 'vitest';
import type { Membership, Principal } from '@longball/application/access';
import type { WorkspaceBinding } from '@longball/application/workspace-boundary';
import { rebindWorkspaceRefresh } from './workspace-refresh';

const principal: Principal = { accountId: 'adult', issuer: 'https://identity.test', subject: 'person-1', identityClassification: 'adult_individual', adultVerified: true, strongAuth: true, authenticatedAt: 10, status: 'active' };
const previous: WorkspaceBinding = { generation: 1, apiBaseUrl: 'https://api.test', accountId: principal.accountId, issuer: principal.issuer, subject: principal.subject, teamId: 'roma', seasonId: '2026', role: 'manager', playerId: null };
const next = { ...previous, generation: 2 };
const memberships: Membership[] = [{ accountId: principal.accountId, teamId: 'roma', seasonId: '2026', role: 'manager' }];
const cached = { binding: previous, value: { revision: 4, privateDraftSource: 'same object' } };

describe('same-context workspace refresh', () => {
  it('retains the same DTO object under a new generation after current authority is checked', () => {
    const result = rebindWorkspaceRefresh(cached, previous, next, principal, memberships, 100);
    expect(result?.value).toBe(cached.value);
    expect(result?.binding).toBe(next);
    expect(result?.binding.generation).not.toBe(previous.generation);
  });
  it('never rebinds an old DTO across identity, API, team, season, role or player boundaries', () => {
    for (const changed of [{ accountId: 'other' }, { issuer: 'https://other.test' }, { subject: 'other' }, { apiBaseUrl: 'https://other-api.test' }, { teamId: 'other' }, { seasonId: '2027' }, { role: 'administrator' as const }, { playerId: 'other-child' }]) expect(rebindWorkspaceRefresh(cached, previous, { ...next, ...changed }, principal, memberships, 100)).toBeNull();
    expect(rebindWorkspaceRefresh({ ...cached, binding: { ...previous, generation: 0 } }, previous, next, principal, memberships, 100)).toBeNull();
    expect(rebindWorkspaceRefresh(cached, null, next, principal, memberships, 100)).toBeNull();
    for (const generation of [0, 1, NaN]) expect(rebindWorkspaceRefresh(cached, previous, { ...next, generation }, principal, memberships, 100)).toBeNull();
  });
  it('drops data for a disabled identity, revoked/expired membership or lost adult authority', () => {
    for (const changed of [{ status: 'disabled' as const }, { accountId: 'another' }, { adultVerified: false }, { strongAuth: false }, { identityClassification: 'child_shared' as const }]) expect(rebindWorkspaceRefresh(cached, previous, next, { ...principal, ...changed }, memberships, 100)).toBeNull();
    for (const rows of [[], [{ ...memberships[0], revokedAt: 99 }], [{ ...memberships[0], expiresAt: 100 }]]) expect(rebindWorkspaceRefresh(cached, previous, next, principal, rows, 100)).toBeNull();
  });
});
