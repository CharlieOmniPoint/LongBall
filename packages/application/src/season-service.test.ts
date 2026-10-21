import { describe, expect, it } from 'vitest';
import type { Membership, Principal } from './access';
import { createCommunityState } from './community';
import { createPreparationState } from './preparation';
import { createRecordsSeed } from './records';
import { applyConfigurationServiceCommand, configurationServiceView, planSeasonRollover, seasonAccessEndsAtMs, seasonRolloverOptions, type SeasonRolloverCommand, type SeasonRolloverContext } from './season-service';

const now = Date.parse('2026-10-21T12:00:00Z');
function fixture() {
  const preparation = createPreparationState(), records = createRecordsSeed(), community = createCommunityState(now);
  const principal: Principal = { accountId: 'manager-1', issuer: 'https://identity.example', subject: 'm1', identityClassification: 'adult_individual', adultVerified: true, strongAuth: true, authenticatedAt: now, status: 'active' };
  const memberships: Membership[] = [{ accountId: principal.accountId, teamId: records.teamId, seasonId: records.seasonId, role: 'administrator' }, { accountId: principal.accountId, teamId: records.teamId, seasonId: records.seasonId, role: 'manager' }, { accountId: 'child-1', teamId: records.teamId, seasonId: records.seasonId, role: 'player', playerId: records.players[0].id }, { accountId: 'spectator-1', teamId: records.teamId, seasonId: records.seasonId, role: 'spectator' }];
  const context: SeasonRolloverContext = { principal, memberships, preparation, records, community, existingSeasons: [{ teamId: records.teamId, id: records.seasonId, startYear: 2026 }], nowMs: now, accounts: [
    { accountId: principal.accountId, label: 'Manager 1', status: 'active', identityClassification: 'adult_individual', adultVerified: true, strongAuthEnrolled: true },
    { accountId: 'child-1', label: 'Player 01', status: 'active', identityClassification: 'child_shared', adultVerified: false, strongAuthEnrolled: false },
    { accountId: 'spectator-1', label: 'Spectator', status: 'active', identityClassification: 'adult_individual', adultVerified: false, strongAuthEnrolled: false },
  ] };
  const command: SeasonRolloverCommand = { id: 'rollover-command-1', type: 'season.rolled_over', expectedPreparationRevision: preparation.revision, idForSeason: 'season-2027-28', startYear: 2027, copyPlayers: true, managerAccountIds: ['manager-1'], administratorAccountIds: ['manager-1'], playerAssignments: [{ accountId: 'child-1', playerId: records.players[0].id }], confirmSpectatorRenewal: true };
  return { context, command };
}
describe('connected season rollover plan', () => {
  it('creates new scope from explicit assignments without changing old records, snapshots or spectator grants', () => {
    const { context, command } = fixture();
    const original = JSON.stringify(context);
    const result = planSeasonRollover({ ...context, command });
    expect(JSON.stringify(context)).toBe(original);
    expect(result.preparation.activeSeasonId).toBe(command.idForSeason);
    expect(result.preparation.seasons).toHaveLength(1);
    expect(result.preparation.profiles).toHaveLength(13);
    expect(result.preparation.profiles.every(profile => profile.seasonId === command.idForSeason)).toBe(true);
    expect(result.preparation.snapshots).toEqual([]); expect(result.preparation.training).toEqual([]); expect(result.preparation.fixtures).toEqual([]);
    expect(result.records.results).toEqual([]); expect(result.records.trainingAttendance).toEqual([]); expect(result.records.liveMatch.matchId).toBe('');
    expect(result.memberships.map(item => item.role)).toEqual(['manager', 'administrator', 'player']);
    expect(result.community.grants).toEqual([]); expect(result.community.invitations).toEqual([]); expect(result.community.photos).toEqual([]); expect(result.community.ballots).toEqual([]);
    expect(context.community.grants).not.toHaveLength(0);
    result.preparation.profiles[0].displayName = 'New-season label';
    expect(JSON.stringify(context)).toBe(original);
  });
  it('permits an empty new roster but never assigns an account to an uncopied profile', () => {
    const { context, command } = fixture();
    const empty = planSeasonRollover({ ...context, command: { ...command, copyPlayers: false, playerAssignments: [] } });
    expect(empty.preparation.profiles).toEqual([]); expect(empty.records.players).toEqual([]);
    expect(() => planSeasonRollover({ ...context, command: { ...command, copyPlayers: false } })).toThrow('Copy');
  });
  it('requires current administrator and recent strong adult authority for assignments', () => {
    const { context, command } = fixture();
    for (const change of [
      { memberships: context.memberships.filter(item => item.role !== 'administrator') },
      { principal: { ...context.principal, strongAuth: false } },
      { principal: { ...context.principal, adultVerified: false } },
      { principal: { ...context.principal, authenticatedAt: now - 300_001 } },
    ]) expect(() => planSeasonRollover({ ...context, ...change, command })).toThrow();
    expect(seasonRolloverOptions({ ...context, principal: { ...context.principal, authenticatedAt: now - 300_001 } }).canRollover).toBe(false);
    expect(() => seasonRolloverOptions({ ...context, principal: { ...context.principal, strongAuth: false } })).toThrow('stronger authentication');
  });
  it('preserves account/player bindings and refuses self-created administrator or child-manager authority', () => {
    const { context, command } = fixture();
    for (const change of [
      { managerAccountIds: ['child-1'] }, { administratorAccountIds: ['child-1'] },
      { playerAssignments: [{ accountId: 'child-1', playerId: context.records.players[1].id }] },
      { playerAssignments: [...command.playerAssignments, ...command.playerAssignments] },
      { managerAccountIds: ['unknown-account'] },
      { confirmSpectatorRenewal: false },
    ]) expect(() => planSeasonRollover({ ...context, command: { ...command, ...change } as SeasonRolloverCommand })).toThrow();
  });
  it('counts distinct active manager accounts across team seasons and requires an explicit prior revocation before a fifth', () => {
    const { context, command } = fixture();
    for (let index = 2; index <= 5; index++) {
      context.accounts.push({ ...context.accounts[0], accountId: `manager-${index}`, label: `Manager ${index}` });
      context.memberships.push({ accountId: `manager-${index}`, teamId: context.records.teamId, seasonId: context.records.seasonId, role: index <= 4 ? 'manager' : 'player', playerId: index === 5 ? 'unused-player' : undefined });
    }
    expect(() => planSeasonRollover({ ...context, command: { ...command, managerAccountIds: ['manager-1', 'manager-5'] } })).toThrow('four active');
    context.memberships.find(item => item.accountId === 'manager-4')!.revokedAt = now;
    expect(planSeasonRollover({ ...context, command: { ...command, managerAccountIds: ['manager-1', 'manager-5'] } }).receipt.managerAccountIds).toEqual(['manager-1', 'manager-5']);
  });
  it('rejects stale source revision, duplicate destination and skipped season', () => {
    const { context, command } = fixture();
    for (const change of [{ expectedPreparationRevision: context.preparation.revision + 1 }, { idForSeason: context.records.seasonId }, { startYear: 2028 }]) expect(() => planSeasonRollover({ ...context, command: { ...command, ...change } })).toThrow();
    context.existingSeasons.push({ teamId: context.records.teamId, id: 'another-new-season-id', startYear: 2027 });
    expect(() => planSeasonRollover({ ...context, command })).toThrow('year already exists');
    expect(seasonRolloverOptions(context)).toMatchObject({ canRollover: false, existingNextSeasonId: 'another-new-season-id' });
  });
  it('uses the Europe/London September boundary and exposes no unrelated account candidates', () => {
    const { context } = fixture();
    context.accounts.push({ ...context.accounts[0], accountId: 'other-team-private-account', label: 'Other private label' });
    const options = seasonRolloverOptions(context);
    expect(JSON.stringify(options)).not.toContain('other-team-private');
    expect(seasonAccessEndsAtMs(2027)).toBe(Date.parse('2028-08-31T23:00:00Z'));
    expect(options.spectatorRenewal).toBe('individual_explicit_invitation_only');
  });
  it('permits administrator-only configuration without returning private preparation or consuming a manager slot', () => {
    const { context, command } = fixture();
    context.memberships = context.memberships.filter(item => item.role !== 'manager');
    const config = configurationServiceView({ ...context, seasonId: context.records.seasonId });
    for (const field of ['profiles', 'fixtures', 'training', 'snapshots', 'responses', 'attendance']) expect(config).not.toHaveProperty(field);
    const team = context.preparation.team;
    const updated = applyConfigurationServiceCommand({ ...context, seasonId: context.records.seasonId, command: { id: 'admin-team-settings', expectedRevision: context.preparation.revision, type: 'team.updated', name: 'Approved team name', ageGroup: team.ageGroup, defaultPitchPlaces: team.defaultPitchPlaces, defaultHalfDurationMs: team.defaultHalfDurationMs, logo: team.logo } });
    expect(updated.team.name).toBe('Approved team name'); expect(context.preparation.team.name).not.toBe(updated.team.name);
    expect(seasonRolloverOptions(context).activeManagerAccountIds).toEqual([]);
    expect(() => applyConfigurationServiceCommand({ ...context, seasonId: context.records.seasonId, command: { id: 'admin-profile-write', expectedRevision: 0, type: 'profile.archived', profileId: context.preparation.profiles[0].id } })).toThrow('only club or team');
    expect(() => planSeasonRollover({ ...context, command: { ...command, managerAccountIds: [] } })).toThrow('one to four');
  });
});
