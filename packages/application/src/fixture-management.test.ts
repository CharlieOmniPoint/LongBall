import { describe, expect, it } from 'vitest';
import { createPreparationState } from './preparation';
import { applyScheduledGameCommand, assertScheduledGameManagementDto, fixtureRecordingUnavailable, fixtureWasDeleted, parseScheduledGameCommand, scheduledGameManagementView, type FixtureManagementContext } from './fixture-management';

const now = Date.parse('2026-10-24T08:00:00Z');
function scenario(role: 'manager' | 'administrator' = 'manager') {
  const state = createPreparationState({ demoScenario: true });
  const context: FixtureManagementContext = { principal: { accountId: 'staff', issuer: 'test', subject: 'staff', identityClassification: 'adult_individual', adultVerified: true, strongAuth: true, authenticatedAt: now, status: 'active' }, memberships: [{ accountId: 'staff', teamId: state.team.id, seasonId: state.activeSeasonId, role }], role, seasonId: state.activeSeasonId, nowMs: now, protectedFixtureIds: ['synthetic-history-oak', 'synthetic-history-hill'] };
  const command = { id: 'cancel-command', expectedRevision: state.revision, fixtureId: state.fixtures[0].id, type: 'fixture.cancelled' as const, reason: 'Waterlogged pitch', confirm: true as const };
  return { state, context, command };
}
describe('staff scheduled-game decisions', () => {
  for (const role of ['manager', 'administrator'] as const) it(`${role} can cancel and delete only an unrecorded fixture with a retained audit`, () => {
    const { state, context, command } = scenario(role);
    const before = structuredClone(state.fixtures[0]);
    const cancelled = applyScheduledGameCommand(state, command, context);
    expect(cancelled.fixtures[0]).toMatchObject({ status: 'cancelled', responses: before.responses, attendance: before.attendance, selectedProfileIds: before.selectedProfileIds });
    expect(state.fixtures[0].status).toBe('scheduled');
    expect(fixtureRecordingUnavailable(cancelled, command.fixtureId)).toBe(true);
    const deleted = applyScheduledGameCommand(cancelled, { ...command, id: 'delete-command', expectedRevision: cancelled.revision, type: 'fixture.deleted' }, context);
    expect(deleted.fixtures.some(fixture => fixture.id === command.fixtureId)).toBe(false);
    expect(fixtureWasDeleted(deleted, command.fixtureId)).toBe(true);
    expect(deleted.fixtureManagement?.tombstones[0].fixture).toEqual(cancelled.fixtures[0]);
    expect(deleted.fixtureManagement?.actions.map(action => action.type)).toEqual(['fixture.cancelled', 'fixture.deleted']);
    expect(deleted.snapshots).toEqual(state.snapshots);
    expect(scheduledGameManagementView(deleted, context).fixtures).toHaveLength(3);
  });
  it('returns metadata without selected players, responses, check-in or private deletion reasons', () => {
    const { state, context, command } = scenario('administrator');
    const view = scheduledGameManagementView(applyScheduledGameCommand(state, command, context), context);
    const text = JSON.stringify(view);
    for (const privateValue of ['selectedProfileIds', 'responses', 'attendance', 'profiles', 'preferences', 'Waterlogged pitch', 'synthetic-player-01']) expect(text).not.toContain(privateValue);
    expect(view.fixtures.find(fixture => fixture.id === command.fixtureId)).toMatchObject({ status: 'cancelled', canCancel: false, canDelete: true });
    expect(view.fixtures.find(fixture => fixture.id === 'synthetic-history-oak')).toMatchObject({ canCancel: false, canDelete: false, blockedReason: 'recording_exists' });
  });
  it('rejects stale decisions, conflicting command reuse and protected play without changing history', () => {
    const { state, context, command } = scenario();
    expect(() => applyScheduledGameCommand(state, { ...command, expectedRevision: 10 }, context)).toThrow('schedule changed');
    const cancelled = applyScheduledGameCommand(state, command, context);
    expect(applyScheduledGameCommand(cancelled, command, context)).toBe(cancelled);
    expect(() => applyScheduledGameCommand(cancelled, { ...command, reason: 'Different reason' }, context)).toThrow('different schedule decision');
    for (const type of ['fixture.cancelled', 'fixture.deleted']) expect(() => applyScheduledGameCommand(state, { ...command, type, fixtureId: 'synthetic-history-oak' }, context)).toThrow('recording authority');
    expect(state.revision).toBe(0);
  });
  it('requires the exact current adult staff role, team and season', () => {
    const { state, context, command } = scenario();
    for (const changed of [{ ...context, role: 'administrator' as const }, { ...context, memberships: context.memberships.map(member => ({ ...member, teamId: 'another' })) }, { ...context, principal: { ...context.principal, status: 'disabled' as const } }, { ...context, principal: { ...context.principal, identityClassification: 'child_shared' as const } }]) expect(() => applyScheduledGameCommand(state, command, changed)).toThrow();
  });
  it('accepts only the bounded reviewed command shape', () => {
    const { command } = scenario();
    for (const changed of [{ ...command, confirm: false }, { ...command, reason: 'no' }, { ...command, reason: 'x'.repeat(501) }, { ...command, selectedProfileIds: [] }, { ...command, expectedRevision: -1 }]) expect(() => parseScheduledGameCommand(changed)).toThrow();
    expect(parseScheduledGameCommand({ ...command, reason: '  Pitch closed  ' }).reason).toBe('Pitch closed');
  });
  it('rejects private fields, wrong scope, duplicate fixture IDs and inconsistent action capabilities at the cache boundary', () => {
    const { state, context } = scenario('administrator'), dto = scheduledGameManagementView(state, context);
    const scope = { teamId: state.team.id, seasonId: state.activeSeasonId };
    expect(() => assertScheduledGameManagementDto(dto, scope)).not.toThrow();
    const unplayed = dto.fixtures.find(fixture => fixture.canDelete)!;
    for (const changed of [{ ...dto, profiles: state.profiles }, { ...dto, teamId: 'another-team' }, { ...dto, fixtures: [dto.fixtures[0], dto.fixtures[0]] }, { ...dto, fixtures: [{ ...dto.fixtures[0], attendance: {} }] }, { ...dto, fixtures: [{ ...unplayed, blockedReason: 'recording_exists' }] }]) expect(() => assertScheduledGameManagementDto(changed, scope)).toThrow();
  });
  it('retains legal imported entity IDs containing dots and colons without widening command IDs', () => {
    const { state, context, command } = scenario(); state.fixtures[0].id = 'csv.fixture:2026-27.01';
    const changed = { ...command, fixtureId: state.fixtures[0].id };
    expect(parseScheduledGameCommand(changed).fixtureId).toBe(changed.fixtureId);
    const cancelled = applyScheduledGameCommand(state, changed, context);
    expect(() => assertScheduledGameManagementDto(scheduledGameManagementView(cancelled, context), { teamId: state.team.id, seasonId: state.activeSeasonId })).not.toThrow();
    expect(() => parseScheduledGameCommand({ ...changed, id: 'command:with.dots' })).toThrow();
  });
});
