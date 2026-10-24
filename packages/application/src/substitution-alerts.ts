/** Team preferences affect reminders only; they never record or make substitutions. */
export interface SubstitutionAlertSettings {
  enabled: boolean;
  leadSeconds: number;
  /** Foreground tone amplitude. Device mute/Focus and media volume still apply. */
  volume: number;
}
export const DEFAULT_SUBSTITUTION_ALERTS: Readonly<SubstitutionAlertSettings> = {
  enabled: false, leadSeconds: 60, volume: 0.7,
};
export function assertSubstitutionAlertSettings(value: unknown): asserts value is SubstitutionAlertSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose valid substitution alert settings.');
  const settings = value as SubstitutionAlertSettings;
  if (Object.keys(settings).some(key => !['enabled', 'leadSeconds', 'volume'].includes(key)) || typeof settings.enabled !== 'boolean' || !Number.isInteger(settings.leadSeconds) || settings.leadSeconds < 0 || settings.leadSeconds > 300 || !Number.isFinite(settings.volume) || settings.volume < 0 || settings.volume > 1) throw new Error('Use a warning from 0 to 300 seconds and volume from 0 to 100%.');
}
export interface SubstitutionToneCheckpoint {
  key: string;
  activeMs: number;
  consumed: boolean;
  armed: boolean;
}
export interface SubstitutionToneInput {
  plan: { key: string; dueActiveMs: number; sourceRevision: number } | null;
  activeMs: number;
  sourceRevision: number;
  running: boolean;
  hasControl: boolean;
  timeCertain: boolean;
  foreground: boolean;
  settings: SubstitutionAlertSettings;
  previous: SubstitutionToneCheckpoint | null;
}
/** Only a live crossing sounds. Mounting/resuming late seals a missed warning without replaying it. */
export function substitutionToneAtCheckpoint(input: SubstitutionToneInput): { checkpoint: SubstitutionToneCheckpoint | null; play: boolean } {
  assertSubstitutionAlertSettings(input.settings);
  const { plan, previous } = input;
  if (!plan || !Number.isSafeInteger(input.activeMs) || input.activeMs < 0 || !Number.isSafeInteger(plan.dueActiveMs) || plan.dueActiveMs < 0 || plan.sourceRevision !== input.sourceRevision || !input.hasControl || !input.timeCertain) return { checkpoint: null, play: false };
  const key = JSON.stringify([plan.key, plan.dueActiveMs, input.settings.leadSeconds]);
  const same = previous?.key === key;
  const threshold = plan.dueActiveMs - input.settings.leadSeconds * 1000;
  if (!input.running || !input.foreground) return { checkpoint: { key, activeMs: input.activeMs, consumed: same ? previous.consumed || input.activeMs >= threshold : input.activeMs >= threshold, armed: false }, play: false };
  const backwards = same && input.activeMs < previous.activeMs;
  const crossed = same && previous.armed && !previous.consumed && previous.activeMs < threshold && input.activeMs >= threshold;
  const play = crossed && !backwards && input.settings.enabled && input.settings.volume > 0 && (input.settings.leadSeconds === 0 || input.activeMs <= plan.dueActiveMs);
  return { checkpoint: { key, activeMs: input.activeMs, consumed: backwards || (same && previous.consumed) || input.activeMs >= threshold, armed: true }, play };
}
export function substitutionCountdownLabel(ms: number | null, state: 'running' | 'paused' | 'half_time' | 'waiting' | 'unavailable'): { label: string; time: string | null } {
  if (state === 'unavailable') return { label: 'Substitution plan needs review', time: null };
  if (state === 'half_time') return { label: 'Next change after the next half starts', time: null };
  if (ms === null || !Number.isFinite(ms)) return { label: 'No substitution currently planned', time: null };
  const seconds = Math.ceil(Math.abs(ms) / 1000);
  const time = `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
  return { label: ms <= 0 ? 'Substitution due' : state === 'paused' ? 'Next substitution · clock paused' : state === 'waiting' ? 'Next substitution · waiting to start' : 'Next substitution', time: ms < 0 ? `+${time}` : time };
}
