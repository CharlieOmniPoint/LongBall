import { describe, expect, it } from 'vitest';
import { groupPreparationEvents, normalisedPitchPoint, preparationEditorSaveRevision, retainedPreparationPlayers } from './preparation-presentation';
import { createPreparationState, reducePreparation, seasonPlayers, trainingAttendanceEvidence } from './preparation';
interface Event { id: string; date: string | null; time: string | null; kind?: 'match' | 'training' }
const options = { date: (event: Event) => event.date, time: (event: Event) => event.time, today: '2026-10-21', period: 'upcoming' as const };
const row = (id: string, date: string | null, time: string | null = null): Event => ({ id, date, time });
const ids = (groups: ReturnType<typeof groupPreparationEvents<Event>>) => groups.map(group => [group.date, group.events.map(event => event.id)]);

describe('preparation editor source revision', () => {
  it('blocks an old profile draft after an independent save and preserves the newer fields', () => {
    const opened = createPreparationState({ demoScenario: true });
    const profile = opened.profiles[1];
    const draft = { ...profile, displayName: 'Noah Review' };
    const latestFoot = profile.foot === 'left' ? 'right' : 'left';
    const current = reducePreparation(opened, { id: 'external-profile-change', expectedRevision: opened.revision, type: 'profile.saved', profile: { ...profile, foot: latestFoot } });
    const before = structuredClone(current);
    expect(() => reducePreparation(current, { id: 'stale-editor-save', expectedRevision: preparationEditorSaveRevision(opened.revision, current.revision), type: 'profile.saved', profile: draft })).toThrow('Preparation changed since this editor opened');
    expect(current).toEqual(before);
    expect(current.profiles.find(item => item.id === profile.id)).toMatchObject({ displayName: profile.displayName, foot: latestFoot });
  });

  it('lets a reopened editor save from the latest profile without reverting an independent change', () => {
    const original = createPreparationState({ demoScenario: true });
    const profile = original.profiles[1];
    const latestFoot = profile.foot === 'left' ? 'right' : 'left';
    const current = reducePreparation(original, { id: 'external-profile-change', expectedRevision: original.revision, type: 'profile.saved', profile: { ...profile, foot: latestFoot } });
    const reopenedDraft = { ...current.profiles.find(item => item.id === profile.id)!, displayName: 'Noah Review' };
    const saved = reducePreparation(current, { id: 'reopened-editor-save', expectedRevision: preparationEditorSaveRevision(current.revision, current.revision), type: 'profile.saved', profile: reopenedDraft });
    expect(saved.profiles.find(item => item.id === profile.id)).toMatchObject({ displayName: 'Noah Review', foot: latestFoot });
    expect(saved.revision).toBe(current.revision + 1);
  });

  it('cannot approve a stale editor by attaching the current reviewed revision, or reuse a stale reviewed command', () => {
    const original = createPreparationState({ demoScenario: true });
    const current = reducePreparation(original, { id: 'external-defaults-change', expectedRevision: original.revision, type: 'team.updated', name: original.team.name, ageGroup: original.team.ageGroup, logo: original.team.logo, defaultPitchPlaces: original.team.defaultPitchPlaces, defaultHalfDurationMs: 20 * 60_000 });
    expect(() => preparationEditorSaveRevision(original.revision, current.revision, current.revision)).toThrow('Preparation changed since this editor opened');
    expect(() => preparationEditorSaveRevision(current.revision, current.revision, original.revision)).toThrow('different source revision');
    const saved = reducePreparation(current, { id: 'current-reviewed-profile-change', expectedRevision: preparationEditorSaveRevision(current.revision, current.revision, current.revision), type: 'profile.saved', profile: { ...current.profiles[1], displayName: 'Noah Review' } });
    expect(saved.team.defaultHalfDurationMs).toBe(20 * 60_000);
    expect(saved.profiles.find(profile => profile.id === current.profiles[1].id)?.displayName).toBe('Noah Review');
  });

  it('rejects invalid opened, current and reviewed revisions rather than coercing them', () => {
    for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => preparationEditorSaveRevision(invalid, 0)).toThrow('valid nonnegative preparation revisions');
      expect(() => preparationEditorSaveRevision(0, invalid)).toThrow('valid nonnegative preparation revisions');
      expect(() => preparationEditorSaveRevision(0, 0, invalid)).toThrow('valid nonnegative preparation revisions');
    }
    expect(preparationEditorSaveRevision(0, 0, 0)).toBe(0);
    expect(preparationEditorSaveRevision(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('retained preparation player references', () => {
  it('keeps an archived selected player visible without silently changing the squad', () => {
    const original = createPreparationState({ demoScenario: true });
    const noah = original.profiles.find(profile => profile.displayName === 'Ralph Barrett')!;
    const archived = reducePreparation(original, { id: 'archive-noah', expectedRevision: original.revision, type: 'profile.archived', profileId: noah.id });
    const fixture = archived.fixtures.find(item => item.id === 'synthetic-roma-oak-2026-10-31')!;
    expect(seasonPlayers(archived).filter(profile => fixture.selectedProfileIds.includes(profile.id))).toHaveLength(7);
    const rows = retainedPreparationPlayers(archived, fixture.seasonId, fixture.selectedProfileIds);
    expect(rows.filter(profile => fixture.selectedProfileIds.includes(profile.id))).toHaveLength(8);
    expect(rows.find(profile => profile.id === noah.id)?.active).toBe(false);
    expect(fixture.selectedProfileIds).toContain(noah.id);
    expect(original.profiles.find(profile => profile.id === noah.id)?.active).toBe(true);
  });

  it('allows atomic removal of multiple archived squad players while retaining historical participation evidence', () => {
    let original = createPreparationState({ demoScenario: true });
    const coverId = `test-cover:${original.activeSeasonId}`;
    const cover = { ...original.profiles[3], id: coverId, playerId: 'test-cover', displayName: 'Test cover', initials: 'TC', shirtNumber: 99 };
    original = reducePreparation(original, { id: 'add-test-cover', expectedRevision: original.revision, type: 'profile.saved', profile: cover });
    const future = original.fixtures.find(item => item.id === 'synthetic-roma-oak-2026-10-31')!;
    original = reducePreparation(original, { id: 'select-test-cover', expectedRevision: original.revision, type: 'fixture.selection_saved', fixtureId: future.id, selectedProfileIds: [...future.selectedProfileIds, coverId] });
    const noah = original.profiles.find(profile => profile.displayName === 'Ralph Barrett')!;
    const leo = original.profiles.find(profile => profile.displayName === 'Conor Kyne')!;
    const archivedIds = new Set([noah.id, leo.id]);
    const historicalFixtures = original.fixtures.filter(fixture => fixture.playedDate < '2026-10-22');
    const heldEvidence = (state: typeof original) => trainingAttendanceEvidence(state).filter(session => session.eventStatus === 'held').map(({ sessionId, expectedPlayerIds, attendance, responses }) => ({ sessionId, expectedPlayerIds, attendance, responses }));
    let state = reducePreparation(original, { id: 'archive-noah', expectedRevision: original.revision, type: 'profile.archived', profileId: noah.id });
    state = reducePreparation(state, { id: 'archive-leo', expectedRevision: state.revision, type: 'profile.archived', profileId: leo.id });
    const fixture = state.fixtures.find(item => item.id === 'synthetic-roma-oak-2026-10-31')!;
    expect(() => reducePreparation(state, { id: 'blocked-prepare', expectedRevision: state.revision, type: 'fixture.prepared', fixtureId: fixture.id, formationId: 'formation-7' })).toThrow('active player');
    expect(() => reducePreparation(state, { id: 'incomplete-removal', expectedRevision: state.revision, type: 'fixture.selection_saved', fixtureId: fixture.id, selectedProfileIds: fixture.selectedProfileIds.filter(id => id !== noah.id) })).toThrow('active player');
    state = reducePreparation(state, { id: 'remove-archived-selection', expectedRevision: state.revision, type: 'fixture.selection_saved', fixtureId: fixture.id, selectedProfileIds: fixture.selectedProfileIds.filter(id => !archivedIds.has(id)) });
    state = reducePreparation(state, { id: 'prepare-revised-squad', expectedRevision: state.revision, type: 'fixture.prepared', fixtureId: fixture.id, formationId: 'formation-7' });
    const prepared = state.snapshots.at(-1)!;
    expect(prepared.profiles).toHaveLength(7);
    expect(prepared.selectedPlayerIds).not.toContain(noah.playerId);
    expect(prepared.selectedPlayerIds).not.toContain(leo.playerId);
    expect(state.fixtures.filter(item => item.playedDate < '2026-10-22')).toEqual(historicalFixtures);
    expect(heldEvidence(state)).toEqual(heldEvidence(original));
    expect(heldEvidence(state).every(session => [noah.playerId, leo.playerId].every(playerId => session.expectedPlayerIds.includes(playerId) && Object.hasOwn(session.attendance, playerId)))).toBe(true);
  });

  it('retains an archived expected player until explicitly removed from a training draft', () => {
    const original = createPreparationState({ demoScenario: true });
    const noah = original.profiles.find(profile => profile.displayName === 'Ralph Barrett')!;
    const state = reducePreparation(original, { id: 'archive-noah', expectedRevision: 0, type: 'profile.archived', profileId: noah.id });
    const training = state.training.find(session => session.status === 'scheduled')!;
    const references = [...training.expectedProfileIds];
    expect(retainedPreparationPlayers(state, training.seasonId, references).find(profile => profile.id === noah.id)?.active).toBe(false);
    expect(training.expectedProfileIds).toEqual(references);
    const kept = references.filter(id => id !== noah.id);
    expect(retainedPreparationPlayers(state, training.seasonId, kept).some(profile => profile.id === noah.id)).toBe(false);
    const { status: _status, responses: _responses, attendance: _attendance, ...draft } = training;
    const updated = reducePreparation(state, { id: 'save-training-without-archived-player', expectedRevision: state.revision, type: 'training.saved', training: { ...draft, expectedProfileIds: kept, venue: 'Rovers training pitch' } });
    expect(updated.training.find(session => session.id === training.id)?.expectedProfileIds).toEqual(kept);
    expect(state.training.find(session => session.id === training.id)?.expectedProfileIds).toContain(noah.id);
  });

  it('preserves stable profile order, deduplicates IDs and excludes unreferenced archived or foreign-season profiles without mutation', () => {
    const state = createPreparationState({ demoScenario: true });
    const initialOrder = state.profiles.map(profile => profile.id);
    const noah = state.profiles[1], leo = state.profiles[2];
    state.profiles = [{ ...noah, seasonId: 'other-season' }, state.profiles[0], { ...noah, active: false }, { ...leo, active: false }, ...state.profiles.slice(3), { ...noah, active: false }];
    const before = structuredClone(state);
    const refs = Object.freeze([noah.id, noah.id, 'missing-profile']);
    const rows = retainedPreparationPlayers(state, state.activeSeasonId, refs);
    expect(rows.map(profile => profile.id)).toEqual(initialOrder.filter(id => id !== leo.id));
    expect(rows.filter(profile => profile.id === noah.id)).toHaveLength(1);
    expect(rows.every(profile => profile.seasonId === state.activeSeasonId)).toBe(true);
    expect(state).toEqual(before);
    expect(refs).toEqual([noah.id, noah.id, 'missing-profile']);
  });
});

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
