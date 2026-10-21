import { describe, expect, it } from 'vitest';
import { groupPreparationEvents, normalisedPitchPoint } from './preparation-presentation';
interface Event { id: string; date: string | null; time: string | null; kind?: 'match' | 'training' }
const options = { date: (event: Event) => event.date, time: (event: Event) => event.time, today: '2026-10-21', period: 'upcoming' as const };
const row = (id: string, date: string | null, time: string | null = null): Event => ({ id, date, time });
const ids = (groups: ReturnType<typeof groupPreparationEvents<Event>>) => groups.map(group => [group.date, group.events.map(event => event.id)]);

describe('recorded schedule grouping', () => {
  it('groups both event kinds and retains today as upcoming even when its recorded time has elapsed', () => {
    const events: Event[] = [{ ...row('training', '2026-10-21', '00:01'), kind: 'training' }, { ...row('match', '2026-10-22', '10:00'), kind: 'match' }, row('old', '2026-10-20', '23:59')];
    expect(ids(groupPreparationEvents(events, options))).toEqual([['2026-10-21', ['training']], ['2026-10-22', ['match']]]);
    expect(ids(groupPreparationEvents(events, { ...options, period: 'past' }))).toEqual([['2026-10-20', ['old']]]);
  });
  it('orders upcoming dates and known times ascending, with unknown times last and stable identity ties', () => {
    const events = [row('z', '2026-10-22'), row('b', '2026-10-21', '10:00'), row('a', '2026-10-21', '10:00'), row('early', '2026-10-21', '09:00'), row('unknown', '2026-10-21'), row('invalid', '2026-10-21', '25:99')];
    expect(ids(groupPreparationEvents(events, options))).toEqual([['2026-10-21', ['early', 'a', 'b', 'invalid', 'unknown']], ['2026-10-22', ['z']]]);
  });
  it('orders past dates and known times descending while keeping unknown times last', () => {
    const events = [row('old', '2026-10-18', '21:00'), row('unknown', '2026-10-20'), row('early', '2026-10-20', '09:00'), row('late', '2026-10-20', '18:00'), row('a', '2026-10-20', '18:00')];
    expect(ids(groupPreparationEvents(events, { ...options, period: 'past' }))).toEqual([['2026-10-20', ['a', 'late', 'early', 'unknown']], ['2026-10-18', ['old']]]);
  });
  it('keeps missing, malformed and impossible calendar dates explicitly undated in either period', () => {
    const events = [row('missing', null, '11:00'), row('invalid', '2026-02-30', '10:00'), row('malformed', '21/10/2026'), row('known', '2026-10-22', '08:00')];
    const upcoming = groupPreparationEvents(events, options);
    expect(upcoming.map(group => group.date)).toEqual(['2026-10-22', null]);
    expect(upcoming[1].events.map(event => event.id)).toEqual(['invalid', 'missing', 'malformed']);
    const past = groupPreparationEvents(events, { ...options, period: 'past' });
    expect(past).toHaveLength(1);
    expect(past[0].date).toBeNull();
    expect(past[0].events.map(event => event.id)).toEqual(['missing', 'invalid', 'malformed']);
  });
  it('does not mutate source arrays/records and preserves duplicate-ID stable source order', () => {
    const first = Object.freeze({ ...row('duplicate', '2026-10-21', '10:00'), note: 'first' });
    const second = Object.freeze({ ...first, note: 'second' });
    const events = Object.freeze([first, second]);
    const groups = groupPreparationEvents(events, options);
    expect(groups[0].events).toEqual([first, second]);
    expect(groups[0].events[0]).toBe(first);
    expect(events).toEqual([first, second]);
  });
  it('uses the injected date across London midnight and leap days without reading a clock', () => {
    const events = [row('yesterday', '2026-10-20'), row('today', '2026-10-21')];
    expect(groupPreparationEvents(events, { ...options, today: '2026-10-20' })).toHaveLength(2);
    expect(groupPreparationEvents(events, { ...options, today: '2026-10-21' })).toHaveLength(1);
    expect(groupPreparationEvents([row('leap', '2028-02-29')], { ...options, today: '2028-02-29' })[0].date).toBe('2028-02-29');
    expect(() => groupPreparationEvents(events, { ...options, today: '2026-02-30' })).toThrow();
  });
});

describe('normalised formation placement', () => {
  it('maps a measured point to inclusive pitch coordinates without rounding', () => {
    expect(normalisedPitchPoint(37.5, 60, 150, 240)).toEqual({ x: 0.25, y: 0.25 });
    expect(normalisedPitchPoint(0, 240, 150, 240)).toEqual({ x: 0, y: 1 });
  });
  it('clamps outside positions to the measured pitch boundaries', () => {
    expect(normalisedPitchPoint(-2, 250, 150, 240)).toEqual({ x: 0, y: 1 });
    expect(normalisedPitchPoint(151, -2, 150, 240)).toEqual({ x: 1, y: 0 });
  });
  it('rejects unavailable or invalid measured geometry and nonfinite input', () => {
    for (const values of [[0, 0, 0, 10], [0, 0, 10, -1], [Number.NaN, 1, 10, 10], [1, Number.POSITIVE_INFINITY, 10, 10], [1, 1, Number.POSITIVE_INFINITY, 10]]) expect(normalisedPitchPoint(...values as [number, number, number, number])).toBeNull();
  });
});
