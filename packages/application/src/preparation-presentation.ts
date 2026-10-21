/** UI06 compares recorded calendar dates with a caller-supplied London date. */
export interface PreparationEventGroup<T> { date: string | null; events: T[] }
export interface PreparationGroupingOptions<T> {
  date: (event: T) => string | null;
  time: (event: T) => string | null;
  period: 'upcoming' | 'past';
  today: string;
}
function calendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function minutes(value: string | null): number | null {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
export function groupPreparationEvents<T extends { id: string }>(events: readonly T[], options: PreparationGroupingOptions<T>): PreparationEventGroup<T>[] {
  if (!calendarDate(options.today)) throw new Error('Provide a valid current calendar date for schedule grouping.');
  if (!['upcoming', 'past'].includes(options.period)) throw new Error('Choose upcoming or past schedule grouping.');
  const direction = options.period === 'upcoming' ? 1 : -1;
  const groups = new Map<string | null, { event: T; order: number; time: number | null }[]>();
  events.forEach((event, order) => {
    const recorded = options.date(event);
    const date = calendarDate(recorded) ? recorded : null;
    if (date !== null && (options.period === 'upcoming' ? date < options.today : date >= options.today)) return;
    const group = groups.get(date) ?? [];
    group.push({ event, order, time: minutes(options.time(event)) });
    groups.set(date, group);
  });
  return [...groups.entries()]
    .sort(([left], [right]) => left === null ? right === null ? 0 : 1 : right === null ? -1 : direction * compareText(left, right))
    .map(([date, entries]) => ({ date, events: entries.sort((left, right) => {
      if (left.time === null && right.time !== null) return 1;
      if (right.time === null && left.time !== null) return -1;
      return (left.time !== null && right.time !== null ? direction * (left.time - right.time) : 0) || compareText(left.event.id, right.event.id) || left.order - right.order;
    }).map(item => item.event) }));
}

/** UI11 placement only; callers retain the existing named slot and role type. */
export function normalisedPitchPoint(x: number, y: number, width: number, height: number): { x: number; y: number } | null {
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  return { x: clamp(x / width), y: clamp(y / height) };
}
