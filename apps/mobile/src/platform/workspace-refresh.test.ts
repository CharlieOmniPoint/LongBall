import { describe, expect, it } from 'vitest';
import type { Membership, Principal } from '@longball/application/access';
import type { WorkspaceBinding } from '@longball/application/workspace-boundary';
import { rebindWorkspaceRefresh, workspaceMutationRefreshResources } from './workspace-refresh';

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

describe('accepted preparation refresh dependencies', () => {
  const command = { id: 'reply-1', expectedRevision: 4, type: 'fixture.response_recorded', fixtureId: 'game', profileId: 'player:2026', response: 'available' };
  const request = { source: previous, path: '/v1/teams/roma/preparation?seasonId=2026', bodyJson: JSON.stringify({ command }) };
  const resources = ['preparation', 'records', 'player-stats'];

  it('reloads RSVP/attendance evidence and its statistics revision for all four frequent commands', () => {
    expect(workspaceMutationRefreshResources(request, previous, next)).toEqual(resources);
    for (const type of ['fixture.attendance_recorded', 'training.response_recorded', 'training.attendance_recorded']) {
      const target = type.startsWith('training.') ? { trainingId: 'practice' } : { fixtureId: 'game' };
      const value = type.endsWith('response_recorded') ? { response: 'unsure' } : { attendance: 'present' };
      expect(workspaceMutationRefreshResources({ ...request, bodyJson: JSON.stringify({ command: { id: 'attendance-1', expectedRevision: 5, type, ...target, profileId: 'player:2026', ...value } }) }, previous, next)).toEqual(resources);
    }
  });

  it('requires full refresh for missing, stale or changed identity/role/team/season/player bindings', () => {
    expect(workspaceMutationRefreshResources(undefined, previous, next)).toBeNull();
    expect(workspaceMutationRefreshResources({ ...request, source: null }, previous, next)).toBeNull();
    expect(workspaceMutationRefreshResources(request, null, next)).toBeNull();
    expect(workspaceMutationRefreshResources(request, { ...previous, generation: 0 }, next)).toBeNull();
    for (const changed of [{ accountId: 'other' }, { issuer: 'https://other.test' }, { subject: 'other' }, { apiBaseUrl: 'https://other.test' }, { teamId: 'other' }, { seasonId: '2027' }, { role: 'player' as const }, { playerId: 'other' }]) expect(workspaceMutationRefreshResources(request, previous, { ...next, ...changed })).toBeNull();
    for (const generation of [0, 1, NaN]) expect(workspaceMutationRefreshResources(request, previous, { ...next, generation })).toBeNull();
    const admin = { ...previous, role: 'administrator' as const };
    expect(workspaceMutationRefreshResources({ ...request, source: admin }, admin, { ...admin, generation: 2 })).toBeNull();
  });

  it('never narrows unknown endpoint, query, command or extra command-field effects', () => {
    for (const path of ['/v1/teams/other/preparation?seasonId=2026', '/v1/teams/roma/preparation?seasonId=2027', '/v1/teams/roma/preparation/own?seasonId=2026', '/v1/teams/roma/preparation?seasonId=2026&seasonId=2026', '/v1/teams/roma/preparation?seasonId=2026&extra=1', '/v1/teams/roma/preparation?seasonId=2026#other', 'https://other.test/v1/teams/roma/preparation?seasonId=2026']) expect(workspaceMutationRefreshResources({ ...request, path }, previous, next)).toBeNull();
    for (const bodyJson of ['not json', 'null', '[]', JSON.stringify({ command, extra: true }), JSON.stringify({ command: { ...command, type: 'fixture.selection_saved' } }), JSON.stringify({ command: { ...command, extra: true } }), JSON.stringify({ command: { ...command, response: 'made_up' } }), JSON.stringify({ command: { ...command, expectedRevision: -1 } })]) expect(workspaceMutationRefreshResources({ ...request, bodyJson }, previous, next)).toBeNull();
  });
});
