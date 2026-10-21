import { describe, expect, it } from 'vitest';
import { createPreparationState, reducePreparation, trainingAttendanceEvidence, type PreparationCommand, type PreparationState, type TrainingDraft } from './preparation';
import { weeklyTrainingDates, type TrainingSeriesPayload } from './training-series';
function create(state: PreparationState, group = 'new-weekly-series', dates = ['2026-11-01', '2026-11-08', '2026-11-15', '2026-11-22']): TrainingSeriesPayload {
  return { type: 'training.series_created', seasonId: state.activeSeasonId, recurrenceGroupId: group, confirmOccurrences: true,
    occurrences: dates.map((date, index) => ({ id: `${group}-${index}`, seasonId: state.activeSeasonId, date, time: '18:00', venue: 'Fictional training pitch', recurrenceGroupId: group, expectedProfileIds: state.profiles.slice(0, 2).map(item => item.id) })) };
}
function apply(state: PreparationState, payload: Omit<PreparationCommand, 'id' | 'expectedRevision'> | TrainingSeriesPayload | Record<string, unknown>): PreparationState {
  return reducePreparation(state, { ...payload, id: `series-command-${state.revision}`, expectedRevision: state.revision } as PreparationCommand);
}
function base() { let state = createPreparationState(); state = apply(state, create(state)); return state; }

describe('explicit recurring training occurrences', () => {
  it('previews weekly calendar dates across both clock changes without inventing offsets or rolling dates', () => {
    const season = { startDate: '2026-09-01', endDate: '2027-08-31' };
    expect(weeklyTrainingDates('2026-10-18', 3, season)).toEqual(['2026-10-18', '2026-10-25', '2026-11-01']);
    expect(weeklyTrainingDates('2027-03-21', 3, season)).toEqual(['2027-03-21', '2027-03-28', '2027-04-04']);
    for (const date of ['2026-02-30', '2026-9-1', 'not-a-date']) expect(() => weeklyTrainingDates(date, 3, season)).toThrow();
    for (const count of [1, 53, 2.5, NaN]) expect(() => weeklyTrainingDates('2026-11-01', count, season)).toThrow();
    expect(() => weeklyTrainingDates('2027-08-25', 2, season)).toThrow(/season/);
  });
  it('creates stable independent dated occurrences atomically, with an exact replay and no default attendance', () => {
    const original = createPreparationState(), payload = create(original);
    const command = { ...payload, id: 'stable-series-command', expectedRevision: original.revision };
    const state = reducePreparation(original, command);
    expect(state.training.slice(-4).map(item => item.id)).toEqual(['new-weekly-series-0', 'new-weekly-series-1', 'new-weekly-series-2', 'new-weekly-series-3']);
    expect(state.training.slice(-4).every(item => Object.keys(item.responses).length === 0 && Object.keys(item.attendance).length === 0)).toBe(true);
    expect(reducePreparation(state, command)).toBe(state);
    expect(() => reducePreparation(state, { ...command, confirmOccurrences: false } as unknown as PreparationCommand)).toThrow(/different content/);
    expect(() => reducePreparation(state, { ...command, id: 'stale-new-command' })).toThrow(/changed/);
    expect(original.training).toHaveLength(2);
  });
  it('rejects duplicate identities, mixed scopes, reused groups and unconfirmed batches without partial mutation', () => {
    const state = createPreparationState(), before = JSON.stringify(state), payload = create(state);
    if (payload.type !== 'training.series_created') throw new Error('fixture');
    for (const changed of [
      { ...payload, confirmOccurrences: false },
      { ...payload, occurrences: [{ ...payload.occurrences[0], id: state.training[0].id }, ...payload.occurrences.slice(1)] },
      { ...payload, occurrences: payload.occurrences.map((item, index) => index === 3 ? { ...item, seasonId: 'another-season' } : item) },
      { ...payload, occurrences: payload.occurrences.map((item, index) => index === 3 ? { ...item, expectedProfileIds: ['foreign-player'] } : item) },
    ]) expect(() => apply(state, changed)).toThrow();
    expect(JSON.stringify(state)).toBe(before);
    const saved = apply(state, payload);
    expect(() => apply(saved, create(saved))).toThrow(/already exists/);
  });
  it('edits only the exact scheduled series while retaining held/cancelled evidence, dates, replies and attendance', () => {
    let state = base(); const ids = state.training.slice(-4).map(item => item.id), profileId = state.profiles[0].id;
    state = apply(state, { type: 'training.status_changed', trainingId: ids[0], status: 'held' });
    state = apply(state, { type: 'training.attendance_recorded', trainingId: ids[0], profileId, attendance: 'present' });
    state = apply(state, { type: 'training.status_changed', trainingId: ids[1], status: 'cancelled' });
    state = apply(state, { type: 'training.response_recorded', trainingId: ids[2], profileId, response: 'available' });
    const old = structuredClone(state);
    state = apply(state, { type: 'training.series_updated', seasonId: state.activeSeasonId, recurrenceGroupId: 'new-weekly-series', occurrenceIds: ids.slice(2), changes: { time: '19:15', venue: 'Fictional east pitch', expectedProfileIds: [profileId] }, confirmOccurrences: true });
    expect(state.training.slice(-4, -2)).toEqual(old.training.slice(-4, -2));
    expect(state.training.slice(-2).map(item => [item.id, item.date])).toEqual(old.training.slice(-2).map(item => [item.id, item.date]));
    expect(state.training.at(-2)?.responses[profileId]).toBe('available');
    expect(state.training.at(-2)?.attendance).toEqual({});
    expect(() => apply(state, { type: 'training.series_cancelled', seasonId: state.activeSeasonId, recurrenceGroupId: 'new-weekly-series', occurrenceIds: ids.slice(1), confirmOccurrences: true })).toThrow(/scheduled series changed/);
  });
  it('cancels one occurrence independently and then explicitly cancels the remaining scheduled list without erasure', () => {
    let state = base(); const ids = state.training.slice(-4).map(item => item.id), before = structuredClone(state.training);
    state = apply(state, { type: 'training.status_changed', trainingId: ids[0], status: 'cancelled' });
    expect(state.training.filter(item => item.id !== ids[0])).toEqual(before.filter(item => item.id !== ids[0]));
    state = apply(state, { type: 'training.series_cancelled', seasonId: state.activeSeasonId, recurrenceGroupId: 'new-weekly-series', occurrenceIds: ids.slice(1), confirmOccurrences: true });
    expect(state.training).toHaveLength(before.length);
    expect(trainingAttendanceEvidence(state).slice(-4).every(item => item.eventStatus === 'cancelled' && Object.keys(item.attendance).length === 0)).toBe(true);
  });
  it('keeps individual edits in the same series and preserves saved replies', () => {
    let state = base(); const trainingId = state.training.at(-1)!.id, profileId = state.profiles[0].id;
    state = apply(state, { type: 'training.response_recorded', trainingId, profileId, response: 'unavailable' });
    const draft: TrainingDraft = { ...state.training.at(-1)!, date: '2026-11-23' };
    const next = apply(state, { type: 'training.saved', training: draft });
    expect(next.training.at(-1)?.responses[profileId]).toBe('unavailable');
    expect(next.training.at(-1)?.id).toBe(trainingId);
    expect(() => apply(state, { type: 'training.saved', training: { ...draft, recurrenceGroupId: 'different-group' } })).toThrow(/retained/);
  });
});
