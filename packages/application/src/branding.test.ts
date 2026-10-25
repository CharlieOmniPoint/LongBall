import { describe, expect, it } from 'vitest';
import { BRAND_POLICY_VERSION, assertBrandAuthority, assertLogoPrepareScope, authorizeBrandAsset, brandingView, emptyBrandSlot, parseBrandingCommand, parseLogoPrepareInput, planBrandingCommand, resolveBranding, type BrandAssetRecord, type BrandingCommand, type BrandingContext } from './branding';

const at = Date.parse('2026-10-21T12:00:00Z');
function fixture() {
  const context: BrandingContext = { principal: { accountId: 'adult', issuer: 'urn:fixture', subject: 'adult', status: 'active', identityClassification: 'adult_individual', adultVerified: true, strongAuth: true, authenticatedAt: at }, memberships: [{ accountId: 'adult', teamId: 'roma', seasonId: '26', role: 'administrator' }, { accountId: 'adult', teamId: 'roma', seasonId: '26', role: 'manager' }], selectedRole: 'administrator', clubId: 'rovers', teamId: 'roma', authoritySeasonId: '26', nowMs: at };
  const asset: BrandAssetRecord = { assetId: 'logo-1', revision: 1, kind: 'club_logo', clubId: 'rovers', teamId: null, ownerId: 'adult', status: 'processed', byteSize: 99, width: 120, height: 100, createdAt: at - 2000, processedAt: at - 1000, scannerClean: true };
  const command: BrandingCommand = { id: 'publish-1', type: 'logo.published', kind: 'club_logo', expectedSlotVersion: 0, assetId: asset.assetId, reviewedRevision: 1, confirmRightsToUse: true, policyVersion: BRAND_POLICY_VERSION };
  return { context, asset, command, club: emptyBrandSlot(context, 'club_logo'), team: emptyBrandSlot(context, 'team_logo') };
}
describe('F01/D20 supplied club/team logos', () => {
  it('enforces kind-specific ancestry without invented game or season fields', () => {
    const { context: administrator } = fixture();
    const context = { ...administrator, selectedRole: 'manager' as const };
    const input = { kind: 'team_logo' as const, teamId: 'roma', byteSize: 99, mimeType: 'image/png' as const, sha256: 'A'.repeat(64), policyAcknowledged: true as const };
    expect(parseLogoPrepareInput(input).sha256).toBe('a'.repeat(64));
    for (const mimeType of ['image/jpeg', 'image/png', 'image/heic'] as const) expect(parseLogoPrepareInput({ ...input, mimeType }).mimeType).toBe(mimeType);
    expect(assertLogoPrepareScope(context, input)).toEqual({ kind: 'team_logo', clubId: 'rovers', teamId: 'roma' });
    for (const patch of [{ requestId: 'forged-request' }, { matchId: 'fake-game' }, { seasonId: '26' }, { clubId: 'other-club' }, { ownerId: 'another' }, { teamId: 'roma\n' }, { sha256: `${'a'.repeat(64)}\n` }, { mimeType: 'image/svg+xml' }, { mimeType: 'image/heif' }]) expect(() => parseLogoPrepareInput({ ...input, ...patch })).toThrow();
    expect(() => assertLogoPrepareScope(context, { ...input, teamId: 'other' })).toThrow('unavailable');
    expect(() => parseLogoPrepareInput({ ...input, kind: 'club_logo', clubId: 'rovers' })).toThrow('Unexpected');
  });
  it('keeps an override through club replacement and resolves live inheritance on removal', () => {
    const { context, asset, command, club, team } = fixture();
    const frozenHistory = [{ playerId: 'child', label: 'Saved child', preferences: ['GK', 'CB'], matchId: 'old' }];
    const before = JSON.stringify([club, team, frozenHistory]);
    const club1 = planBrandingCommand(context, club, asset, command).slot;
    const teamAsset = { ...asset, assetId: 'team-logo', kind: 'team_logo' as const, teamId: 'roma' };
    const team1 = planBrandingCommand({ ...context, selectedRole: 'manager' }, team, teamAsset, { ...command, id: 'team-publish', kind: 'team_logo', assetId: teamAsset.assetId }).slot;
    const club2 = planBrandingCommand(context, club1, { ...asset, assetId: 'new-club-logo' }, { ...command, id: 'club-replace', assetId: 'new-club-logo', expectedSlotVersion: 1 }).slot;
    expect(resolveBranding(context, club2, team1)).toMatchObject({ source: 'team', logo: { assetId: 'team-logo' } });
    const removed = planBrandingCommand({ ...context, selectedRole: 'manager' }, team1, null, { id: 'remove-team', type: 'logo.removed', kind: 'team_logo', expectedSlotVersion: 1 }).slot;
    expect(resolveBranding(context, club2, removed)).toMatchObject({ source: 'club', logo: { assetId: 'new-club-logo' } });
    expect(resolveBranding(context, club, removed)).toEqual({ source: 'neutral', logo: null });
    expect(JSON.stringify([club, team, frozenHistory])).toBe(before);
  });
  it('keeps club administrator and team manager media authority distinct', () => {
    const { context } = fixture();
    const administrator = { ...context, memberships: context.memberships.filter(item => item.role === 'administrator') };
    expect(() => assertBrandAuthority(administrator, 'club_logo')).not.toThrow();
    expect(() => assertBrandAuthority(administrator, 'team_logo')).toThrow('unavailable');
    expect(() => assertBrandAuthority(context, 'team_logo')).toThrow('unavailable');
    const manager = { ...context, selectedRole: 'manager' as const };
    expect(() => assertBrandAuthority(manager, 'club_logo')).toThrow('unavailable');
    expect(() => assertBrandAuthority(manager, 'team_logo')).not.toThrow();
    for (const principal of [{ ...context.principal, identityClassification: 'child_shared' as const }, { ...context.principal, adultVerified: false }, { ...context.principal, strongAuth: false }, { ...context.principal, status: 'disabled' as const }]) expect(() => assertBrandAuthority({ ...context, principal, selectedRole: 'manager' }, 'team_logo')).toThrow();
    for (const memberships of [[], context.memberships.map(item => ({ ...item, revokedAt: at })), context.memberships.map(item => ({ ...item, expiresAt: at })), context.memberships.map(item => ({ ...item, teamId: 'other' }))]) expect(() => assertBrandAuthority({ ...context, memberships }, 'club_logo')).toThrow();
  });
  it('publishes only the exact clean owned revision with explicit rights, current policy and slot version', () => {
    const { context, asset, command, club } = fixture();
    const result = planBrandingCommand(context, club, asset, command);
    expect(result.slot).toMatchObject({ version: 1, assetId: asset.assetId, reviewedRevision: 1, confirmedBy: 'adult', confirmedAt: at });
    expect(result.asset?.status).toBe('published');
    expect(result.audit).toMatchObject({ action: 'logo.published', before: null, after: { assetId: asset.assetId } });
    for (const patch of [{ scannerClean: false }, { status: 'processing' as const }, { revision: 2 }, { processedAt: null }, { width: 0 }, { kind: 'team_logo' as const, teamId: 'roma' }, { clubId: 'other' }, { ownerId: 'another' }]) expect(() => planBrandingCommand(context, club, { ...asset, ...patch }, command)).toThrow();
    expect(() => planBrandingCommand(context, result.slot, asset, command)).toThrow('changed');
    expect(() => planBrandingCommand(context, club, asset, { ...command, policyVersion: 'invented-policy' })).toThrow('current');
    expect(() => parseBrandingCommand({ ...command, confirmRightsToUse: false })).toThrow('Review');
    expect(() => parseBrandingCommand({ ...command, seasonId: '26' })).toThrow('Unexpected');
  });
  it('projects only current-author scoped pending assets without raw processing, owner or storage details', () => {
    const { context, asset, command, club, team } = fixture();
    const published = planBrandingCommand(context, club, asset, command).slot;
    const view = brandingView({ context, club: { id: 'rovers', name: 'Rovers' }, team: { id: 'roma', name: 'Roma', ageGroup: 'U10' }, clubSlot: published, teamSlot: team, assets: [asset, { ...asset, assetId: 'private-other', ownerId: 'other' }, { ...asset, assetId: 'cross-club', clubId: 'other' }] });
    expect(view.assets.map(item => item.assetId)).toEqual(['logo-1']);
    expect(view).toMatchObject({ canWriteClub: true, canWriteTeam: false, effective: { source: 'club' } });
    expect(JSON.stringify(view)).not.toMatch(/ownerId|scannerClean|private-other|cross-club/);
  });
  it('requires current membership/grants and the current published pointer for every derivative', () => {
    const { context, asset, command, club, team } = fixture();
    const published = planBrandingCommand(context, club, asset, command);
    const viewer = { ...context, selectedRole: 'spectator' as const, spectatorGrantActive: true, memberships: [{ accountId: 'adult', teamId: 'roma', seasonId: '26', role: 'spectator' as const }] };
    expect(authorizeBrandAsset({ context: viewer, asset: published.asset!, slot: published.slot, revision: 1, mode: 'published' })).toMatchObject({ assetId: 'logo-1' });
    const view = brandingView({ context: viewer, club: { id: 'rovers', name: 'Rovers' }, team: { id: 'roma', name: 'Roma', ageGroup: 'U10' }, clubSlot: published.slot, teamSlot: team, assets: [asset] });
    expect(view.assets).toEqual([]); expect(view.canWriteTeam).toBe(false);
    expect(() => authorizeBrandAsset({ context: viewer, asset, slot: published.slot, revision: 1, mode: 'own' })).toThrow();
    expect(() => authorizeBrandAsset({ context: { ...viewer, spectatorGrantActive: false }, asset: published.asset!, slot: published.slot, revision: 1, mode: 'published' })).toThrow();
    expect(() => authorizeBrandAsset({ context: viewer, asset: published.asset!, slot: club, revision: 1, mode: 'published' })).toThrow();
    expect(() => authorizeBrandAsset({ context, asset: published.asset!, slot: published.slot, revision: 2, mode: 'own' })).toThrow();
  });
});
