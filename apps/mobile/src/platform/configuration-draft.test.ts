import { describe, expect, it } from 'vitest';
import { acknowledgeConfigurationDraft, configurationDraft, configurationNeedsReview, refreshConfigurationDraft, reviewConfigurationDraft, type ConfigurationSource } from './configuration-draft';

const initial: ConfigurationSource = { revision: 2, clubName: 'Roma Club', teamName: 'Roma', ageGroup: 'U10', places: 7, minutes: '25' };
describe('administrator configuration drafts', () => {
  it('refreshes pristine fields while preserving dirty sibling values and their original CAS', () => {
    const state = configurationDraft(initial); state.fields.teamName = 'Roma draft';
    const refreshed = refreshConfigurationDraft(state, { ...initial, revision: 3, clubName: 'New club', ageGroup: 'U11' });
    expect(refreshed.fields).toMatchObject({ teamName: 'Roma draft', clubName: 'New club', ageGroup: 'U11' });
    expect(refreshed.teamRevision).toBe(2); expect(configurationNeedsReview(refreshed, 'team')).toBe(true);
    expect(configurationNeedsReview(refreshed, 'club')).toBe(false);
  });
  it('after an acknowledged club save retains the unsaved team draft without claiming it was saved', () => {
    const state = configurationDraft(initial); state.fields.teamName = 'Roma draft'; state.fields.clubName = 'New club';
    const source = { ...initial, revision: 3, clubName: 'New club' };
    const next = acknowledgeConfigurationDraft(refreshConfigurationDraft(state, source), 'club', { ...state.fields });
    expect(next.fields.teamName).toBe('Roma draft'); expect(next.baseline.teamName).toBe('Roma');
    expect(next.teamRevision).toBe(3); expect(configurationNeedsReview(next, 'team')).toBe(false);
    expect(next.baseline.clubName).toBe('New club');
  });
  it('requires explicit review when an external change conflicts with an edited name', () => {
    const state = configurationDraft(initial); state.fields.teamName = 'My draft'; state.fields.clubName = 'New club';
    const source = { ...initial, revision: 4, clubName: 'New club', teamName: 'Another manager name' };
    const acknowledged = acknowledgeConfigurationDraft(refreshConfigurationDraft(state, source), 'club', state.fields);
    expect(acknowledged.fields.teamName).toBe('My draft'); expect(acknowledged.baseline.teamName).toBe('Roma');
    expect(acknowledged.teamRevision).toBe(2); expect(configurationNeedsReview(acknowledged, 'team')).toBe(true);
    const reviewed = reviewConfigurationDraft(acknowledged, 'team');
    expect(reviewed.fields.teamName).toBe('My draft'); expect(reviewed.baseline.teamName).toBe('Another manager name');
    expect(reviewed.teamRevision).toBe(4); expect(configurationNeedsReview(reviewed, 'team')).toBe(false);
  });
  it('does not convert a refused command or a different newer value into an acknowledgement', () => {
    const state = configurationDraft(initial); state.fields.clubName = 'My requested club';
    const next = refreshConfigurationDraft(state, { ...initial, revision: 3, clubName: 'Another club' });
    expect(acknowledgeConfigurationDraft(next, 'club', state.fields)).toBe(next);
    expect(next.fields.clubName).toBe('My requested club'); expect(next.clubRevision).toBe(2);
  });
  it('does not discard a newer queued field edit when an earlier save is acknowledged', () => {
    const state = configurationDraft(initial); state.fields.clubName = 'Submitted club';
    const submitted = { ...state.fields };
    const refreshed = refreshConfigurationDraft(state, { ...initial, revision: 3, clubName: 'Submitted club' });
    const newerDraft = { ...refreshed, fields: { ...refreshed.fields, clubName: 'Newer unsaved club' } };
    expect(acknowledgeConfigurationDraft(newerDraft, 'club', submitted)).toBe(newerDraft);
    expect(newerDraft.fields.clubName).toBe('Newer unsaved club');
    expect(newerDraft.clubRevision).toBe(2); expect(configurationNeedsReview(newerDraft, 'club')).toBe(true);
  });
});
