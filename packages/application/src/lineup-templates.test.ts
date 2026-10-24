import { describe, expect, it } from 'vitest';
import { createMatch } from '@longball/domain';
import { autoFillLineup } from './lineup-autofill';
import { createPreparationState, prepareFixtureSnapshot, reducePreparation } from './preparation';
import { fixtureMatchConfig } from './application';
import { retainedPreparationPlayers } from './preparation-presentation';
import { applyLineupTemplate, archiveLineupTemplate, latestLineupTemplates, previewLineupTemplate, saveLineupTemplate, validateFixtureLineupTemplate } from './lineup-templates';

const nowMs = Date.parse('2026-10-23T12:00:00Z');
function scenario() {
  const state = createPreparationState({ demoScenario: true }), formation = state.formations.find(row => row.id === 'formation-7')!, profiles = state.profiles.slice(0, 9);
  const filled = autoFillLineup({ slots: formation.slots.map(slot => ({ slotId: slot.id, position: slot.position })), players: profiles.map(profile => ({ id: profile.playerId, preferences: profile.preferences, eligiblePositions: profile.eligiblePositions, goalkeeperChoice: profile.preferences.indexOf('GK') + 1, available: true })) });
  if (filled.status !== 'complete') throw new Error(filled.reason);
  return { state, input: { templateId: 'setup-1', expectedTemplateVersion: 0, name: 'Saturday starters', formationId: formation.id, selectedPlayerIds: profiles.map(profile => profile.playerId), allocations: filled.allocations }, fixtureId: 'synthetic-roma-maple-2026-10-24' };
}
describe('simple saved team setups', () => {
  it('saves before any fixture preparation or policy exists, versions edits, and limits the team to three active setups', () => {
    const { state, input } = scenario(), first = saveLineupTemplate(state, input);
    expect(first).toMatchObject({ name: 'Saturday starters', version: 1, active: true });
    expect(state.snapshots).toEqual([]); expect(first).not.toHaveProperty('settings');
    state.lineupTemplates = [first, saveLineupTemplate(state, { ...input, templateId: 'setup-2', name: 'Alternative' }), saveLineupTemplate(state, { ...input, templateId: 'setup-3', name: 'Development' })];
    expect(() => saveLineupTemplate(state, { ...input, templateId: 'setup-4' })).toThrow('three saved setups');
    const edited = saveLineupTemplate(state, { ...input, expectedTemplateVersion: 1, name: 'Updated starters' });
    state.lineupTemplates.push(edited);
    expect(latestLineupTemplates(state)).toHaveLength(3); expect(first.name).toBe('Saturday starters');
    expect(() => saveLineupTemplate(state, input)).toThrow('latest version');
    state.lineupTemplates.push(archiveLineupTemplate(state, { templateId: 'setup-2', expectedTemplateVersion: 1 }));
    expect(saveLineupTemplate(state, { ...input, templateId: 'setup-4' }).version).toBe(1);
  });
  it('applies only a reviewed future draft, retains attendance/replies, and stages nothing automatically', () => {
    let { state, input, fixtureId } = scenario();
    state = reducePreparation(state, { id: 'save-setup', expectedRevision: state.revision, type: 'lineup_template.saved', ...input });
    const before = structuredClone(state.fixtures.find(row => row.id === fixtureId)!);
    const preview = previewLineupTemplate(state, input.templateId, fixtureId, { nowMs });
    state = reducePreparation(state, { id: 'apply-setup', expectedRevision: state.revision, type: 'lineup_template.applied', templateId: input.templateId, templateVersion: 1, fixtureId, previewKey: preview.previewKey, confirm: true }, { nowMs });
    const fixture = state.fixtures.find(row => row.id === fixtureId)!;
    expect(fixture.responses).toEqual(before.responses); expect(fixture.attendance).toEqual(before.attendance);
    expect(fixture.lineupTemplateDraft?.allocations).toEqual(input.allocations);
    const snapshot = prepareFixtureSnapshot(state, fixtureId, fixture.lineupTemplateDraft!.formation.id), config = fixtureMatchConfig(state, snapshot), match = createMatch(config);
    expect(config.initialLineupProposal).toEqual(input.allocations); expect(config).not.toHaveProperty('initialPolicyProposal');
    expect(match.status).toBe('preparation'); expect(match.stagedLineup).toEqual([]); expect(Object.values(match.attendance).every(status => status === 'not_recorded')).toBe(true);
  });
  it('refuses stale preview, archived players, incompatible formats, past and protected matches', () => {
    const { state, input, fixtureId } = scenario(); state.lineupTemplates = [saveLineupTemplate(state, input)];
    const preview = previewLineupTemplate(state, input.templateId, fixtureId, { nowMs });
    expect(() => applyLineupTemplate({ ...state, revision: 1 }, { templateId: input.templateId, templateVersion: 1, fixtureId, previewKey: preview.previewKey, confirm: true }, { nowMs })).toThrow('preview changed');
    expect(previewLineupTemplate(state, input.templateId, fixtureId, { nowMs, protectedFixtureIds: [fixtureId] }).ready).toBe(false);
    expect(previewLineupTemplate(state, input.templateId, 'synthetic-history-hill', { nowMs }).ready).toBe(false);
    const different = structuredClone(state); different.fixtures.find(row => row.id === fixtureId)!.format = 9;
    expect(previewLineupTemplate(different, input.templateId, fixtureId, { nowMs }).blockers.join(' ')).toContain('same number');
    state.profiles.find(profile => profile.playerId === input.selectedPlayerIds[0])!.active = false;
    expect(previewLineupTemplate(state, input.templateId, fixtureId, { nowMs }).ready).toBe(false);
  });
  it('does not silently reclassify applied or previously prepared snapshots after later profile/template edits', () => {
    const { state, input, fixtureId } = scenario(); state.lineupTemplates = [saveLineupTemplate(state, input)];
    const preview = previewLineupTemplate(state, input.templateId, fixtureId, { nowMs }), draft = applyLineupTemplate(state, { templateId: input.templateId, templateVersion: 1, fixtureId, previewKey: preview.previewKey, confirm: true }, { nowMs });
    const fixture = state.fixtures.find(row => row.id === fixtureId)!; fixture.lineupTemplateDraft = draft;
    validateFixtureLineupTemplate(state, fixture);
    const before = structuredClone(draft);
    state.lineupTemplates.push(saveLineupTemplate(state, { ...input, expectedTemplateVersion: 1, name: 'Another name' }));
    expect(draft).toEqual(before);
    fixture.selectedProfileIds = fixture.selectedProfileIds.slice(1);
    expect(() => validateFixtureLineupTemplate(state, fixture)).toThrow('squad changed');
  });
  it('retains saved custom-position copies but refuses to apply an archived team position', () => {
    const { state, input, fixtureId } = scenario();
    state.positionCatalogue!.push({ code: 'DM', label: 'Defensive midfield', active: true });
    const formation = structuredClone(state.formations.find(row => row.id === input.formationId)!);
    formation.id = 'holding-midfield'; formation.slots.find(slot => slot.position === 'CM')!.position = 'DM';
    state.formations.push(formation);
    const midfielder = state.profiles.find(profile => profile.playerId === input.allocations.find(row => row.position === 'CM')!.playerId)!;
    midfielder.eligiblePositions.push('DM'); midfielder.preferences = ['DM', 'CM', 'CB'];
    const allocations = input.allocations.map(row => row.position === 'CM' ? { ...row, position: 'DM' } : row);
    const saved = saveLineupTemplate(state, { ...input, formationId: formation.id, allocations });
    state.lineupTemplates = [saved];
    expect(previewLineupTemplate(state, saved.id, fixtureId, { nowMs }).ready).toBe(true);
    state.positionCatalogue!.find(position => position.code === 'DM')!.active = false;
    expect(previewLineupTemplate(state, saved.id, fixtureId, { nowMs }).blockers.join(' ')).toContain('active team positions');
    expect(saved.formation.slots.some(slot => slot.position === 'DM')).toBe(true);
  });
  it('retains archived setup players for explicit editing and saves a revised active squad without rewriting the original', () => {
    const { state, input } = scenario(), original = saveLineupTemplate(state, input);
    state.lineupTemplates = [original];
    const archived = state.profiles.find(profile => profile.playerId === input.selectedPlayerIds[1])!;
    archived.active = false;
    const rows = retainedPreparationPlayers(state, state.activeSeasonId, state.profiles.filter(profile => original.selectedPlayerIds.includes(profile.playerId)).map(profile => profile.id));
    expect(rows.find(profile => profile.playerId === archived.playerId)?.active).toBe(false);
    expect(() => saveLineupTemplate(state, { ...input, expectedTemplateVersion: 1 })).toThrow('archived');
    const selectedPlayerIds = original.selectedPlayerIds.filter(id => id !== archived.playerId), formation = state.formations.find(item => item.id === input.formationId)!;
    const filled = autoFillLineup({ slots: formation.slots.map(slot => ({ slotId: slot.id, position: slot.position })), players: state.profiles.filter(profile => selectedPlayerIds.includes(profile.playerId)).map(profile => ({ id: profile.playerId, preferences: profile.preferences, eligiblePositions: profile.eligiblePositions, goalkeeperChoice: profile.preferences.indexOf('GK') + 1, available: profile.active })) });
    expect(filled.status).toBe('complete');
    if (filled.status === 'complete') {
      const updated = saveLineupTemplate(state, { ...input, expectedTemplateVersion: 1, selectedPlayerIds, allocations: filled.allocations });
      expect(updated.version).toBe(2); expect(updated.selectedPlayerIds).not.toContain(archived.playerId);
    }
    expect(original.selectedPlayerIds).toContain(archived.playerId); expect(original.version).toBe(1);
  });
});
