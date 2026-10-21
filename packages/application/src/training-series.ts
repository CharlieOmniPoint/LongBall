import type { PreparationState, PreparationTraining, TrainingDraft } from './preparation';

export const maximumTrainingOccurrences = 52;
export type TrainingSeriesPayload =
  | { type: 'training.series_created'; seasonId: string; recurrenceGroupId: string; occurrences: TrainingDraft[]; confirmOccurrences: true }
  | { type: 'training.series_updated'; seasonId: string; recurrenceGroupId: string; occurrenceIds: string[]; changes: Pick<TrainingDraft, 'time' | 'venue' | 'expectedProfileIds'>; confirmOccurrences: true }
  | { type: 'training.series_cancelled'; seasonId: string; recurrenceGroupId: string; occurrenceIds: string[]; confirmOccurrences: true };

function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function calendarDate(value: string): Date {
  requireThat(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'Use a complete YYYY-MM-DD training date.');
  const result = new Date(`${value}T00:00:00Z`);
  requireThat(Number.isFinite(result.getTime()) && result.toISOString().slice(0, 10) === value, 'Use a valid training calendar date.');
  return result;
}

/** Calendar arithmetic only: these dates and HH:MM values are not inferred UTC instants. */
export function weeklyTrainingDates(firstDate: string, count: number, season: { startDate: string; endDate: string }): string[] {
  const date = calendarDate(firstDate);
  requireThat(Number.isSafeInteger(count) && count >= 2 && count <= maximumTrainingOccurrences, 'Choose between 2 and 52 weekly occurrences.');
  const dates: string[] = [];
  for (let index = 0; index < count; index++) {
    const value = date.toISOString().slice(0, 10);
    requireThat(value >= season.startDate && value <= season.endDate, 'Every occurrence must fit within this season; reduce the count or change the first date.');
    dates.push(value);
    date.setUTCDate(date.getUTCDate() + 7);
  }
  return dates;
}

export function trainingSeriesOccurrences(state: PreparationState, seasonId: string, recurrenceGroupId: string): PreparationTraining[] {
  requireThat(typeof recurrenceGroupId === 'string' && recurrenceGroupId.trim().length > 0 && recurrenceGroupId.length <= 150, 'A stable training series identity is required.');
  requireThat(seasonId === state.activeSeasonId, 'Choose the current season before editing a training series.');
  const occurrences = state.training.filter(item => item.recurrenceGroupId === recurrenceGroupId);
  requireThat(occurrences.every(item => item.seasonId === seasonId), 'The training series belongs to a different season.');
  return [...occurrences].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
}

/** Runs inside the preparation reducer's cloned projection and one versioned command. */
export function applyTrainingSeries(state: PreparationState, command: TrainingSeriesPayload, validate: (draft: TrainingDraft) => void): void {
  requireThat(command.confirmOccurrences === true, 'Review and explicitly confirm the listed training occurrences.');
  const series = trainingSeriesOccurrences(state, command.seasonId, command.recurrenceGroupId);
  if (command.type === 'training.series_created') {
    requireThat(series.length === 0, 'That training series already exists; use its scheduled-occurrence editor.');
    requireThat(Array.isArray(command.occurrences) && command.occurrences.length >= 2 && command.occurrences.length <= maximumTrainingOccurrences, 'A series needs between 2 and 52 explicit occurrences.');
    const ids = new Set<string>(), dates = new Set<string>();
    for (const draft of command.occurrences) {
      requireThat(draft.seasonId === command.seasonId && draft.recurrenceGroupId === command.recurrenceGroupId, 'Every occurrence must belong to the confirmed series and season.');
      requireThat(!ids.has(draft.id) && !state.training.some(item => item.id === draft.id), 'Each occurrence must have a new stable identity.');
      requireThat(!dates.has(draft.date), 'Each series occurrence must have a distinct calendar date.');
      validate(draft); ids.add(draft.id); dates.add(draft.date);
    }
    state.training.push(...command.occurrences.map(draft => ({ ...draft, expectedProfileIds: [...draft.expectedProfileIds], status: 'scheduled' as const, responses: {}, attendance: {} })));
    return;
  }
  const scheduled = series.filter(item => item.status === 'scheduled');
  requireThat(Array.isArray(command.occurrenceIds) && command.occurrenceIds.length > 0 && command.occurrenceIds.length <= maximumTrainingOccurrences && new Set(command.occurrenceIds).size === command.occurrenceIds.length, 'Review a nonempty list of distinct scheduled occurrences.');
  requireThat(command.occurrenceIds.length === scheduled.length && scheduled.every(item => command.occurrenceIds.includes(item.id)), 'The scheduled series changed; review its exact occurrence list again. Held and cancelled occurrences cannot be edited as scheduled sessions.');
  if (command.type === 'training.series_updated') {
    for (const occurrence of scheduled) validate({ ...occurrence, ...command.changes });
    const ids = new Set(command.occurrenceIds);
    state.training = state.training.map(item => ids.has(item.id) ? { ...item, time: command.changes.time, venue: command.changes.venue, expectedProfileIds: [...command.changes.expectedProfileIds] } : item);
  } else {
    const ids = new Set(command.occurrenceIds);
    state.training = state.training.map(item => ids.has(item.id) ? { ...item, status: 'cancelled' } : item);
  }
}
