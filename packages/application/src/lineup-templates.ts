import type { Allocation } from '@longball/domain';
import type { PreparationState, PreparationFormation, PreparationFixture } from './preparation';
import { assertActiveFormationPositions } from './position-catalogue';

/** Simple named team setup; contains neither match policy nor actual attendance. */
export interface SavedLineupTemplate {
  id: string;
  version: number;
  teamId: string;
  seasonId: string;
  name: string;
  active: boolean;
  formation: PreparationFormation;
  selectedPlayerIds: string[];
  allocations: Allocation[];
}
export interface FixtureLineupDraft {
  templateId: string;
  templateVersion: number;
  appliedRevision: number;
  formation: PreparationFormation;
  selectedPlayerIds: string[];
  allocations: Allocation[];
}
export interface LineupTemplateSaveInput {
  templateId: string;
  expectedTemplateVersion: number;
  name: string;
  formationId: string;
  selectedPlayerIds: string[];
  allocations: Allocation[];
}
export interface LineupTemplateArchiveInput { templateId: string; expectedTemplateVersion: number }
export interface LineupTemplateApplyInput { templateId: string; templateVersion: number; fixtureId: string; previewKey: string; confirm: true }
export interface LineupTemplateContext { nowMs?: number; protectedFixtureIds?: readonly string[] }
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function requireThat(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function id(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,150}$/.test(value); }
function version(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function latest(state: PreparationState): SavedLineupTemplate[] {
  const rows = new Map<string, SavedLineupTemplate>();
  for (const item of state.lineupTemplates ?? []) if (item.teamId === state.team.id && item.seasonId === state.activeSeasonId && (!rows.has(item.id) || rows.get(item.id)!.version < item.version)) rows.set(item.id, item);
  return [...rows.values()];
}
export function latestLineupTemplates(state: PreparationState): SavedLineupTemplate[] { return latest(state).filter(item => item.active).map(copy); }
function validateSetup(state: PreparationState, formation: PreparationFormation, selectedIds: readonly string[], allocations: readonly Allocation[]) {
  assertActiveFormationPositions(state, formation);
  requireThat(formation.format >= 5 && formation.format <= 11 && formation.slots.length === formation.format && formation.slots.filter(slot => slot.position === 'GK').length === 1 && new Set(formation.slots.map(slot => slot.id)).size === formation.format, 'Choose a complete saved formation with one goalkeeper place.');
  requireThat(Array.isArray(selectedIds) && selectedIds.length >= formation.format && selectedIds.length <= 100 && new Set(selectedIds).size === selectedIds.length, 'Choose a distinct squad with enough players for this setup.');
  const profiles = selectedIds.map(playerId => state.profiles.find(profile => profile.playerId === playerId && profile.seasonId === state.activeSeasonId && profile.active));
  requireThat(profiles.every(Boolean), 'The setup contains an archived or unavailable season player. Review its squad.');
  requireThat(Array.isArray(allocations) && allocations.length === formation.format && new Set(allocations.map(row => row.slotId)).size === formation.format && new Set(allocations.map(row => row.playerId)).size === formation.format, 'Assign one distinct player to every formation place.');
  for (const row of allocations) {
    const slot = formation.slots.find(item => item.id === row.slotId), profile = profiles.find(item => item?.playerId === row.playerId);
    requireThat(slot && slot.position === row.position && profile && profile.eligiblePositions.includes(slot.position), 'Every assigned player must be in the selected squad and eligible for that saved place.');
    requireThat(slot.position !== 'GK' || profile.preferences.slice(0, 2).includes('GK'), 'The goalkeeper must be eligible with goalkeeper as a first or second preference.');
  }
}
export function saveLineupTemplate(state: PreparationState, input: LineupTemplateSaveInput): SavedLineupTemplate {
  requireThat(id(input.templateId) && version(input.expectedTemplateVersion), 'Use a stable setup identity and reviewed version.');
  const existing = latest(state).find(item => item.id === input.templateId);
  requireThat((existing?.version ?? 0) === input.expectedTemplateVersion, 'This setup changed. Open its latest version before saving.');
  requireThat(existing?.active || latestLineupTemplates(state).length < 3, 'This team already has three saved setups. Edit one or archive a setup before adding another.');
  requireThat(typeof input.name === 'string' && input.name.trim().length > 0 && input.name.trim().length <= 60 && !/[\u0000-\u001f\u007f]/.test(input.name), 'Give this setup a name of at most 60 characters.');
  const formation = state.formations.find(item => item.id === input.formationId);
  requireThat(formation, 'Choose a saved team formation.');
  validateSetup(state, formation, input.selectedPlayerIds, input.allocations);
  return copy({ id: input.templateId, version: (existing?.version ?? 0) + 1, teamId: state.team.id, seasonId: state.activeSeasonId, name: input.name.trim(), active: true, formation, selectedPlayerIds: input.selectedPlayerIds, allocations: input.allocations });
}
export function archiveLineupTemplate(state: PreparationState, input: LineupTemplateArchiveInput): SavedLineupTemplate {
  const existing = latest(state).find(item => item.id === input.templateId && item.active);
  requireThat(existing && version(input.expectedTemplateVersion) && existing.version === input.expectedTemplateVersion, 'Open the latest saved setup before archiving it.');
  return copy({ ...existing, version: existing.version + 1, active: false });
}
function today(nowMs: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs));
  return `${parts.find(item => item.type === 'year')!.value}-${parts.find(item => item.type === 'month')!.value}-${parts.find(item => item.type === 'day')!.value}`;
}
export function previewLineupTemplate(state: PreparationState, templateId: string, fixtureId: string, context: LineupTemplateContext = {}) {
  const template = latestLineupTemplates(state).find(item => item.id === templateId), fixture = state.fixtures.find(item => item.id === fixtureId && item.seasonId === state.activeSeasonId);
  const blockers: string[] = [], warnings: string[] = [];
  if (!template) blockers.push('This saved setup is unavailable.');
  if (!fixture || fixture.status !== 'scheduled' || fixture.playedDate < today(context.nowMs ?? Date.now())) blockers.push('Choose a scheduled current or future fixture.');
  if (context.protectedFixtureIds?.includes(fixtureId)) blockers.push('This fixture has recording or control history. Its saved setup cannot be replaced.');
  if (template && fixture) {
    if (template.formation.format !== fixture.format) blockers.push('The setup and fixture must use the same number of pitch places.');
    try { validateSetup(state, template.formation, template.selectedPlayerIds, template.allocations); } catch (error) { blockers.push(error instanceof Error ? error.message : 'Review the current squad and eligible positions.'); }
    for (const playerId of template.selectedPlayerIds) { const profile = state.profiles.find(item => item.playerId === playerId && item.seasonId === fixture.seasonId); if (profile && fixture.responses[profile.id] === 'unavailable') warnings.push(`${profile.displayName} has replied Unavailable. Applying a draft does not change that reply or check anyone in.`); }
  }
  return { ready: blockers.length === 0, template, fixtureId, sourceRevision: state.revision, previewKey: JSON.stringify([state.team.id, state.activeSeasonId, state.revision, templateId, template?.version ?? null, fixtureId]), blockers, warnings };
}
export function applyLineupTemplate(state: PreparationState, input: LineupTemplateApplyInput, context: LineupTemplateContext = {}): FixtureLineupDraft {
  const preview = previewLineupTemplate(state, input.templateId, input.fixtureId, context);
  requireThat(input.confirm === true && preview.ready && preview.template && preview.template.version === input.templateVersion && input.previewKey === preview.previewKey, preview.blockers.join(' ') || 'This setup preview changed. Review the latest fixture and squad before applying it.');
  return copy({ templateId: preview.template.id, templateVersion: preview.template.version, appliedRevision: state.revision + 1, formation: { ...preview.template.formation, id: `lineup-template:${preview.template.id}:${preview.template.version}`, name: preview.template.name }, selectedPlayerIds: preview.template.selectedPlayerIds, allocations: preview.template.allocations });
}
export function validateFixtureLineupTemplate(state: PreparationState, fixture: PreparationFixture): void {
  const draft = fixture.lineupTemplateDraft;
  requireThat(draft, 'No saved setup is applied to this fixture.');
  requireThat(draft.formation.format === fixture.format, 'The saved setup no longer matches this fixture format. Clear it and review another setup.');
  const selected = fixture.selectedProfileIds.map(profileId => state.profiles.find(profile => profile.id === profileId)?.playerId);
  requireThat(selected.length === draft.selectedPlayerIds.length && selected.every(playerId => playerId !== undefined && draft.selectedPlayerIds.includes(playerId)), 'The selected squad changed after applying this setup. Clear the draft and review it again.');
  validateSetup(state, draft.formation, draft.selectedPlayerIds, draft.allocations);
}
