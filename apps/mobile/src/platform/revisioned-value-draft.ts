export interface RevisionedValueDraft<T> { source: T; revision: number; baseline: T; value: T; expectedRevision: number }
const equal = <T,>(left: T, right: T) => JSON.stringify(left) === JSON.stringify(right);
export function revisionedValueDraft<T>(source: T, revision: number): RevisionedValueDraft<T> { return { source, revision, baseline: source, value: source, expectedRevision: revision }; }
/** Pristine fields follow refreshes. Dirty values keep the revision the user originally edited. */
export function refreshRevisionedValueDraft<T>(current: RevisionedValueDraft<T>, source: T, revision: number): RevisionedValueDraft<T> {
  return equal(current.value, current.baseline) ? revisionedValueDraft(source, revision) : { ...current, source, revision };
}
export function revisionedValueNeedsReview<T>(current: RevisionedValueDraft<T>): boolean { return current.expectedRevision !== current.revision && !equal(current.value, current.baseline); }
export function reviewRevisionedValueDraft<T>(current: RevisionedValueDraft<T>): RevisionedValueDraft<T> { return { ...current, baseline: current.source, expectedRevision: current.revision }; }
/** Only an actual accepted command, matching the latest source, acknowledges a submitted draft. */
export function acknowledgeRevisionedValueDraft<T>(current: RevisionedValueDraft<T>, submitted: T): RevisionedValueDraft<T> { return equal(current.source, submitted) && equal(current.value, submitted) ? revisionedValueDraft(current.source, current.revision) : current; }
