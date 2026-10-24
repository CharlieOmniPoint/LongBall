import { describe, expect, it } from 'vitest';
import type { Membership, Principal, Role } from './access';
import { createWorkspaceContextPreference, resolveWorkspaceContext, workspaceContextChoices, workspaceContextKey, workspaceContextPreferenceKey, type NamedWorkspaceMembership, type WorkspaceContextSelection } from './workspace-context';

const now = 1_800_000_000_000;
const apiBaseUrl = 'https://api.example';
const principal: Principal = { accountId: 'adult', issuer: 'https://issuer.example', subject: 'subject-1', status: 'active', identityClassification: 'adult_individual', adultVerified: true, strongAuth: true, authenticatedAt: now };
const membership = (role: Role, teamId = 'team-a', seasonId = '2026-27'): Membership => ({ accountId: principal.accountId, teamId, seasonId, role, ...(role === 'player' ? { playerId: 'player-01' } : {}) });
const selection = (role: Role, teamId = 'team-a', seasonId = '2026-27'): WorkspaceContextSelection => ({ teamId, seasonId, role, playerId: role === 'player' ? 'player-01' : null });
const input = (memberships: Membership[]) => ({ apiBaseUrl, principal, memberships, nowMs: now });

describe('UI03 current service context selection', () => {
  it('requires an explicit choice when eligible roles or team-season contexts are multiple', () => {
    const memberships = [membership('administrator'), membership('manager')];
    const result = resolveWorkspaceContext(input(memberships));
    expect(result.choices.map(item => item.role)).toEqual(['administrator', 'manager']);
    expect(result.selected).toBeNull();
    expect(resolveWorkspaceContext(input([...memberships].reverse())).selected).toBeNull();
    expect(resolveWorkspaceContext(input([membership('manager'), membership('manager', 'team-b')])).selected).toBeNull();
    expect(resolveWorkspaceContext(input([membership('manager'), membership('manager', 'team-a', '2027-28')])).selected).toBeNull();
  });

  it('selects a sole current context without inventing a manager or a team', () => {
    expect(resolveWorkspaceContext(input([membership('administrator')])).selected?.role).toBe('administrator');
    expect(resolveWorkspaceContext(input([membership('player')])).selected?.playerId).toBe('player-01');
    expect(resolveWorkspaceContext(input([]))).toEqual({ choices: [], selected: null, preferenceValid: false });
    expect(resolveWorkspaceContext({ ...input([membership('player')]), initialRole: 'manager' }).selected).toBeNull();
  });

  it('navigation hints never choose a manager among multiple memberships or hide another eligible role', () => {
    const memberships = [membership('administrator'), membership('manager')];
    const result = resolveWorkspaceContext({ ...input(memberships), initialRole: 'manager', teamId: 'team-a', seasonId: '2026-27' });
    expect(result.selected).toBeNull();
    expect(result.choices).toHaveLength(2);
    expect(resolveWorkspaceContext({ ...input(memberships), initialRole: 'manager', selected: selection('administrator') }).selected?.role).toBe('administrator');
  });

  it('restores only an exact still-valid preference after fresh membership verification', () => {
    const memberships = [membership('administrator'), membership('manager')];
    const preference = createWorkspaceContextPreference(apiBaseUrl, principal, selection('administrator'));
    const result = resolveWorkspaceContext({ ...input(memberships), preference: JSON.parse(JSON.stringify(preference)) });
    expect(result.selected?.role).toBe('administrator');
    expect(result.preferenceValid).toBe(true);
    expect(resolveWorkspaceContext({ ...input([membership('manager')]), preference }).selected?.role).toBe('manager');
    expect(resolveWorkspaceContext({ ...input([membership('manager')]), preference }).preferenceValid).toBe(false);
    expect(resolveWorkspaceContext({ ...input(memberships), initialRole: 'manager', preference }).selected).toBeNull();
  });

  it('treats an explicitly invalid selection as unresolved, never a reason to fall back to another role', () => {
    const result = resolveWorkspaceContext({ ...input([membership('player')]), selected: selection('manager') });
    expect(result.selected).toBeNull();
    expect(result.choices.map(item => item.role)).toEqual(['player']);
    expect(resolveWorkspaceContext({ ...input([membership('player')]), selected: { ...selection('player'), playerId: 'player-02' } }).selected).toBeNull();
  });

  it('rejects expired, revoked, foreign and disabled authority without retaining grants in preferences', () => {
    const manager = membership('manager');
    const preference = createWorkspaceContextPreference(apiBaseUrl, principal, selection('manager'));
    for (const memberships of [[], [{ ...manager, expiresAt: now }], [{ ...manager, revokedAt: now }], [{ ...manager, accountId: 'other' }]]) {
      expect(resolveWorkspaceContext({ ...input(memberships), preference })).toMatchObject({ selected: null, preferenceValid: false });
    }
    expect(resolveWorkspaceContext({ ...input([manager]), principal: { ...principal, status: 'disabled' }, preference }).choices).toEqual([]);
    expect(resolveWorkspaceContext({ ...input([{ ...manager, expiresAt: now + 1 }]), preference }).selected?.role).toBe('manager');
  });

  it('binds preference API, account, issuer, subject and exact player identity independently', () => {
    const memberships = [membership('manager'), membership('player')];
    const preference = createWorkspaceContextPreference(apiBaseUrl, principal, selection('player'));
    for (const changed of [{ apiBaseUrl: 'https://another-api.example' }, { accountId: 'other' }, { issuer: 'https://another-issuer.example' }, { subject: 'other-subject' }]) {
      const altered = { ...preference, ...changed };
      expect(resolveWorkspaceContext({ ...input(memberships), preference: altered })).toMatchObject({ selected: null, preferenceValid: false });
    }
    expect(resolveWorkspaceContext({ ...input(memberships), preference: { ...preference, context: { ...preference.context, playerId: 'player-02' } } })).toMatchObject({ selected: null, preferenceValid: false });
  });

  it('requires stronger verified adult authority for manager and administrator choices every time', () => {
    const memberships = [membership('administrator'), membership('manager'), membership('player')];
    for (const changed of [{ strongAuth: false }, { adultVerified: false }, { identityClassification: 'child_shared' as const }]) {
      const choices = workspaceContextChoices({ ...principal, ...changed }, memberships, now);
      expect(choices.map(item => item.role)).toEqual(['player']);
    }
  });

  it('uses only safe supplied display labels and neutral names for an unrelated real team', () => {
    const named: NamedWorkspaceMembership = { ...membership('manager'), teamName: 'Example U11', seasonLabel: '2026–2027', clubName: 'Example Club' };
    expect(workspaceContextChoices(principal, [named], now)[0]).toMatchObject({ teamLabel: 'Example U11', seasonLabel: '2026–2027', clubLabel: 'Example Club', roleLabel: 'Manager' });
    const unknown = workspaceContextChoices(principal, [membership('manager', 'opaque-real-team')], now)[0];
    expect(unknown.teamLabel).toBe('Team opaque-real-team');
    expect(unknown.seasonLabel).toBe('Season 2026-27');
    expect(unknown.clubLabel).toBeNull();
    expect(JSON.stringify(unknown)).not.toContain('Roma');
    expect(workspaceContextChoices(principal, [{ ...named, teamName: 'unsafe\nname', clubName: 'x'.repeat(121) }], now)[0]).toMatchObject({ teamLabel: 'Team team-a', clubLabel: null });
  });

  it('deduplicates identical membership rows without preferring manager and keeps conflicting child bindings explicit', () => {
    expect(workspaceContextChoices(principal, [membership('manager'), membership('manager')], now)).toHaveLength(1);
    const memberships = [membership('player'), { ...membership('player'), playerId: 'player-02' }];
    expect(resolveWorkspaceContext(input(memberships)).selected).toBeNull();
    expect(resolveWorkspaceContext(input(memberships)).choices).toHaveLength(2);
    expect(workspaceContextKey(selection('administrator'))).not.toBe(workspaceContextKey(selection('manager')));
  });

  it('stores only preference identity/context fields and fails closed on credentials or extra authority', () => {
    const value = { ...selection('manager'), token: 'not-stored', memberships: [membership('administrator')], teamLabel: 'private label' };
    const preference = createWorkspaceContextPreference(apiBaseUrl, principal, value);
    expect(JSON.stringify(preference)).not.toContain('not-stored');
    expect(JSON.stringify(preference)).not.toContain('memberships');
    expect(JSON.stringify(preference)).not.toContain('private label');
    for (const malformed of [{ ...preference, token: 'bad' }, { ...preference, schemaVersion: 2 }, { ...preference, context: { ...preference.context, memberships: [membership('manager')] } }]) {
      expect(resolveWorkspaceContext({ ...input([membership('administrator'), membership('manager')]), preference: malformed })).toMatchObject({ selected: null, preferenceValid: false });
    }
  });

  it('normalizes equivalent API identities while rejecting credential-bearing/non-HTTP URLs', () => {
    const first = workspaceContextPreferenceKey('https://API.EXAMPLE/v1/', principal);
    expect(workspaceContextPreferenceKey(apiBaseUrl, principal)).toBe(first);
    expect(workspaceContextPreferenceKey('https://api.example/another', principal)).not.toBe(first);
    expect(workspaceContextPreferenceKey(apiBaseUrl, { ...principal, subject: 'another-subject' })).not.toBe(first);
    for (const value of ['https://username:password@api.example', 'https://api.example?token=private', 'https://api.example#fragment', 'javascript:alert(1)']) {
      expect(() => createWorkspaceContextPreference(value, principal, selection('manager'))).toThrow();
      expect(resolveWorkspaceContext({ ...input([membership('manager')]), apiBaseUrl: value })).toMatchObject({ choices: [], selected: null, preferenceValid: false });
    }
    expect(workspaceContextChoices(principal, [membership('manager')], Number.NaN)).toEqual([]);
  });
});
