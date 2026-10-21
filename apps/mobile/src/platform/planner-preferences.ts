import { controllerCacheDocumentId, type ControllerCacheScope } from '@longball/application/connected-scope';
import { selectMatchPositionMode } from '@longball/domain/planner';
import type { Journal, JournalDiagnostics } from './types';

export interface ConfirmedPlannerSettings {
  batchPreference: number;
  leadThreshold: number;
  returnToNormal: boolean;
}

export type PlannerPreferenceBinding = { kind: 'fictional-local' } | {
  kind: 'connected';
  mode: 'synthetic' | 'oidc';
  controllerScope: ControllerCacheScope;
};

export interface PlannerPreferenceScope {
  kind: PlannerPreferenceBinding['kind'];
  matchId: string;
  journalDeviceId: string;
  serviceMode: 'synthetic' | 'oidc';
  controllerCacheId: string | null;
}

/** Separate local projection: never a canonical match command or a service acknowledgement. */
export interface PlannerPreferences {
  kind: 'longball-planner-preferences';
  schemaVersion: 1;
  revision: number;
  scope: PlannerPreferenceScope;
  settings: ConfirmedPlannerSettings | null;
  positionMode: 'normal' | 'adventurous';
  manualResetAtSourceRevision: number | null;
}

function required(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw new Error(`Planner ${label} is unavailable; retained settings were not opened.`);
}

export function plannerPreferenceScope(matchId: string, journalDeviceId: string, binding: PlannerPreferenceBinding): PlannerPreferenceScope {
  required(matchId, 'match'); required(journalDeviceId, 'device');
  if (binding.kind === 'fictional-local') return { kind: binding.kind, matchId, journalDeviceId, serviceMode: 'synthetic', controllerCacheId: null };
  for (const key of ['baseUrl', 'issuer', 'accountId', 'teamId', 'seasonId', 'matchId', 'deviceId'] as const) required(binding.controllerScope[key], key);
  if (binding.controllerScope.matchId !== matchId) throw new Error('Planner controller scope belongs to another match; retained settings were not opened.');
  return { kind: 'connected', matchId, journalDeviceId, serviceMode: binding.mode, controllerCacheId: controllerCacheDocumentId(binding.controllerScope) };
}

export function plannerPreferenceDocumentId(scope: PlannerPreferenceScope): string {
  return `planner-preferences.v1:${JSON.stringify([scope.kind, scope.matchId, scope.journalDeviceId, scope.serviceMode, scope.controllerCacheId])}`;
}

/** Check before loading a projection, including when a browser has a fictional journal open. */
export function assertPlannerJournalAccess(diagnostics: JournalDiagnostics, scope: PlannerPreferenceScope): void {
  if (!['encrypted-native', 'synthetic-browser'].includes(diagnostics.mode)) throw new Error('Planner journal protection could not be established.');
  if (diagnostics.deviceId !== scope.journalDeviceId) throw new Error('Planner journal belongs to another device; retained settings were not opened.');
  if (scope.serviceMode === 'oidc' && diagnostics.mode !== 'encrypted-native') throw new Error('Real-account planner settings require the native encrypted journal. No private planner cache is opened in this browser.');
  if (diagnostics.mode === 'encrypted-native' && (!diagnostics.cipherVersion?.trim() || !diagnostics.backupExcluded)) throw new Error('The encrypted planner journal and backup exclusion must be established before saving settings.');
}

export async function authorizePlannerPreferences(journal: Journal, scope: PlannerPreferenceScope): Promise<void> {
  assertPlannerJournalAccess(await journal.getDiagnostics(), scope);
}

export function assertConfirmedPlannerSettings(value: unknown): asserts value is ConfirmedPlannerSettings {
  if (!value || typeof value !== 'object') throw new Error('Saved planner settings are invalid; existing records were retained.');
  const settings = value as ConfirmedPlannerSettings;
  if (!Number.isSafeInteger(settings.batchPreference) || settings.batchPreference < 1 || settings.batchPreference > 11 || !Number.isSafeInteger(settings.leadThreshold) || settings.leadThreshold <= 0 || typeof settings.returnToNormal !== 'boolean') throw new Error('Choose a positive whole-number lead threshold, a batch preference and an explicit return-to-normal option.');
}

export function createPlannerPreferences(scope: PlannerPreferenceScope): PlannerPreferences {
  return { kind: 'longball-planner-preferences', schemaVersion: 1, revision: 0, scope: { ...scope }, settings: null, positionMode: 'normal', manualResetAtSourceRevision: null };
}

export function assertPlannerPreferences(value: unknown, expectedScope: PlannerPreferenceScope): asserts value is PlannerPreferences {
  const preferences = value as PlannerPreferences | null;
  if (!preferences || preferences.kind !== 'longball-planner-preferences' || preferences.schemaVersion !== 1 || !Number.isSafeInteger(preferences.revision) || preferences.revision < 0) throw new Error('Saved planner settings have an unsupported or invalid version. Existing records were retained.');
  if (!preferences.scope || !(['kind', 'matchId', 'journalDeviceId', 'serviceMode', 'controllerCacheId'] as const).every(key => preferences.scope[key] === expectedScope[key])) throw new Error('Saved planner settings belong to another account, device, team, season or match. Existing records were retained.');
  if (preferences.settings !== null) assertConfirmedPlannerSettings(preferences.settings);
  if (!['normal', 'adventurous'].includes(preferences.positionMode) || preferences.settings === null && preferences.positionMode !== 'normal' || preferences.manualResetAtSourceRevision !== null && (!Number.isSafeInteger(preferences.manualResetAtSourceRevision) || preferences.manualResetAtSourceRevision < 0)) throw new Error('Saved planner mode is invalid. Existing records were retained.');
}

export function confirmPlannerPreferences(current: PlannerPreferences, settings: ConfirmedPlannerSettings): PlannerPreferences {
  assertConfirmedPlannerSettings(settings);
  return { ...current, settings: { ...settings } };
}

/** A manual reset remains effective on reload of the same accepted/local checkpoint. */
export function resetPlannerPositionMode(current: PlannerPreferences, sourceRevision: number): PlannerPreferences {
  if (!current.settings || !Number.isSafeInteger(sourceRevision) || sourceRevision < 0) throw new Error('Confirm settings and open a valid match checkpoint before resetting position mode.');
  return { ...current, positionMode: 'normal', manualResetAtSourceRevision: sourceRevision };
}

export function plannerPreferencesAtDecision(current: PlannerPreferences, match: { matchId: string; revision: number; ourScore: number; oppositionScore: number }): PlannerPreferences {
  if (match.matchId !== current.scope.matchId || !current.settings) throw new Error('Confirm settings for this match before planning.');
  const next = selectMatchPositionMode({ matchId: current.scope.matchId, mode: current.positionMode }, { ...match, leadThreshold: current.settings.leadThreshold, returnToNormal: current.settings.returnToNormal, manualReset: current.manualResetAtSourceRevision === match.revision });
  return next.mode === current.positionMode ? current : { ...current, positionMode: next.mode };
}
