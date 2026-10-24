import { describe, expect, it } from 'vitest';
import { acknowledgeRevisionedValueDraft, refreshRevisionedValueDraft, reviewRevisionedValueDraft, revisionedValueDraft, revisionedValueNeedsReview } from './revisioned-value-draft';

describe('revisioned player preference draft', () => {
  it('updates pristine values while retaining unsaved preferences across unrelated service revisions', () => {
    const initial = revisionedValueDraft(['GK', 'CB', 'ST'], 3);
    expect(refreshRevisionedValueDraft(initial, ['CB', 'GK', 'ST'], 4).value).toEqual(['CB', 'GK', 'ST']);
    const dirty = { ...initial, value: ['CB', 'ST', 'GK'] };
    const refreshed = refreshRevisionedValueDraft(dirty, initial.source, 4);
    expect(refreshed.value).toEqual(dirty.value); expect(refreshed.expectedRevision).toBe(3);
    expect(revisionedValueNeedsReview(refreshed)).toBe(true);
  });
  it('requires an explicit comparison before retrying over a changed source', () => {
    const draft = { ...revisionedValueDraft(['GK', 'CB', 'ST'], 3), value: ['CB', 'ST', 'GK'] };
    const refreshed = refreshRevisionedValueDraft(draft, ['ST', 'GK', 'CB'], 5);
    const reviewed = reviewRevisionedValueDraft(refreshed);
    expect(reviewed.value).toEqual(draft.value); expect(reviewed.baseline).toEqual(refreshed.source);
    expect(reviewed.expectedRevision).toBe(5); expect(revisionedValueNeedsReview(reviewed)).toBe(false);
    expect(acknowledgeRevisionedValueDraft(refreshed, draft.value)).toBe(refreshed);
  });
  it('recognises its own accepted source without discarding a newer draft', () => {
    const desired = ['CB', 'ST', 'GK'];
    const initial = { ...revisionedValueDraft(['GK', 'CB', 'ST'], 3), value: desired };
    const accepted = refreshRevisionedValueDraft(initial, desired, 4);
    expect(acknowledgeRevisionedValueDraft(accepted, desired).expectedRevision).toBe(4);
    const newerDraft = { ...accepted, value: ['ST', 'CB', 'GK'] };
    expect(acknowledgeRevisionedValueDraft(newerDraft, desired)).toBe(newerDraft);
  });
});
