import { useLayoutEffect, useRef, useState } from "react";

/** For editors that already maintain a revisioned baseline or an explicit discard. */
export function useDraftSignal(
  dirty: boolean,
  onChange?: (dirty: boolean) => void,
): void {
  const callback = useRef(onChange);
  useLayoutEffect(() => {
    callback.current = onChange;
    onChange?.(dirty);
  }, [onChange, dirty]);
  useLayoutEffect(() => () => callback.current?.(false), []);
}

/** Signals local JSON-shaped form edits without persisting the form or its contents. */
export function useUnsavedDraft(
  value: unknown,
  onChange?: (dirty: boolean) => void,
  scopeKey = "draft",
): boolean {
  const fingerprint = JSON.stringify(value);
  const [baseline, setBaseline] = useState({ scopeKey, fingerprint });
  const current =
    baseline.scopeKey === scopeKey ? baseline : { scopeKey, fingerprint };
  if (current !== baseline) setBaseline(current);
  const dirty = current.fingerprint !== fingerprint;
  useDraftSignal(dirty, onChange);
  return dirty;
}
