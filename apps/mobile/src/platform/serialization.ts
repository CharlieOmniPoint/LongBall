/** Stable retry comparisons without conflating changes in object-key order. */
export function canonicalJson(value: unknown): string {
  function ordered(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(ordered);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, ordered(item)]));
    }
    return input;
  }
  const result = JSON.stringify(ordered(value));
  if (result === undefined) throw new Error('Journal content must be serializable.');
  return result;
}

export function assertLocalRevision(expected: number | undefined, projection: unknown): void {
  if (expected === undefined) return;
  const revision = projection && typeof projection === 'object' && 'revision' in projection ?
    (projection as { revision?: unknown }).revision : -1;
  if (revision !== expected) {
    throw new Error('This review is stale because another controller changed the saved match. Reload the saved match before continuing; no history was overwritten.');
  }
}
