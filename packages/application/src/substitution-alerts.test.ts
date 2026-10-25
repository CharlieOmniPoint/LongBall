import { describe, expect, it } from 'vitest';
import { assertSubstitutionAlertSettings, DEFAULT_SUBSTITUTION_ALERTS, substitutionCountdownLabel, substitutionToneAtCheckpoint, type SubstitutionToneInput } from './substitution-alerts';
const base: SubstitutionToneInput = { plan: { key: 'match-a:plan-1', dueActiveMs: 120000, sourceRevision: 7 }, activeMs: 59000, sourceRevision: 7, running: true, hasControl: true, timeCertain: true, foreground: true, settings: { enabled: true, leadSeconds: 60, volume: 0.7 }, previous: null };
describe('manager substitution tone crossings', () => {
  it('sounds once at the selected warning with one batch covering multiple changes', () => {
    const first = substitutionToneAtCheckpoint(base);
    const crossing = substitutionToneAtCheckpoint({ ...base, activeMs: 60000, previous: first.checkpoint });
    expect(crossing.play).toBe(true);
    expect(substitutionToneAtCheckpoint({ ...base, activeMs: 60000, previous: crossing.checkpoint }).play).toBe(false);
    expect(substitutionToneAtCheckpoint({ ...base, activeMs: 61000, previous: crossing.checkpoint }).play).toBe(false);
  });
  it('does not replay warnings when mounted late, replanned late, resumed, backgrounded or clock moves backwards', () => {
    expect(substitutionToneAtCheckpoint({ ...base, activeMs: 61000 }).play).toBe(false);
    const first = substitutionToneAtCheckpoint(base);
    const paused = substitutionToneAtCheckpoint({ ...base, activeMs: 61000, running: false, previous: first.checkpoint });
    expect(substitutionToneAtCheckpoint({ ...base, activeMs: 61000, previous: paused.checkpoint }).play).toBe(false);
    const background = substitutionToneAtCheckpoint({ ...base, activeMs: 61000, foreground: false, previous: first.checkpoint });
    expect(substitutionToneAtCheckpoint({ ...base, activeMs: 62000, previous: background.checkpoint }).play).toBe(false);
    const beforeBackground = substitutionToneAtCheckpoint({ ...base, foreground: false, previous: first.checkpoint });
    expect(substitutionToneAtCheckpoint({ ...base, activeMs: 62000, previous: beforeBackground.checkpoint }).play).toBe(false);
    const backwards = substitutionToneAtCheckpoint({ ...base, activeMs: 58000, previous: first.checkpoint });
    expect(substitutionToneAtCheckpoint({ ...base, activeMs: 60000, previous: backwards.checkpoint }).play).toBe(false);
    expect(substitutionToneAtCheckpoint({ ...base, plan: { ...base.plan!, key: 'new-plan' }, activeMs: 61000, previous: first.checkpoint }).play).toBe(false);
  });
  it('refuses stale, uncertain, unowned, muted, disabled and overdue tones', () => {
    const previous = substitutionToneAtCheckpoint(base).checkpoint;
    for (const patch of [{ sourceRevision: 8 }, { timeCertain: false }, { hasControl: false }, { foreground: false }, { running: false }, { settings: { ...base.settings, enabled: false } }, { settings: { ...base.settings, volume: 0 } }, { activeMs: 121000 }]) expect(substitutionToneAtCheckpoint({ ...base, activeMs: 60000, previous, ...patch }).play).toBe(false);
    const lost = substitutionToneAtCheckpoint({ ...base, activeMs: 60000, previous, hasControl: false });
    expect(substitutionToneAtCheckpoint({ ...base, activeMs: 61000, previous: lost.checkpoint }).play).toBe(false);
  });
  it('validates bounded settings and makes paused/due/unknown countdowns explicit', () => {
    expect(() => assertSubstitutionAlertSettings(DEFAULT_SUBSTITUTION_ALERTS)).not.toThrow();
    for (const patch of [{ leadSeconds: -1 }, { leadSeconds: 301 }, { leadSeconds: 0.5 }, { volume: NaN }, { volume: 2 }, { enabled: 1 }]) expect(() => assertSubstitutionAlertSettings({ ...base.settings, ...patch })).toThrow();
    expect(substitutionCountdownLabel(61001, 'running')).toEqual({ label: 'Next substitution', time: '01:02' });
    expect(substitutionCountdownLabel(-1000, 'running')).toEqual({ label: 'Substitution due', time: '+00:01' });
    expect(substitutionCountdownLabel(5000, 'paused').label).toContain('paused');
    expect(substitutionCountdownLabel(null, 'unavailable').time).toBeNull();
  });
});
