import { useCallback, useEffect, useRef, useState } from "react";
import { randomUUID } from "./platform/id";
import {
  LocalConflictError,
  type CommitInput,
  type Journal,
} from "./platform/types";

/** A second projection in the existing encrypted journal; no second key lifecycle. */
export function useDocument<T extends { revision: number }>(
  journal: Journal | null,
  deviceId: string | null,
  documentId: string,
  seed: () => T,
  validate: (value: T) => void,
) {
  const [state, setState] = useState<T | null>(null);
  const [loadedFrom, setLoadedFrom] = useState<{
    journal: Journal;
    documentId: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [retryPending, setRetryPending] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const stateRef = useRef<T | null>(null);
  const pending = useRef<CommitInput<T> | null>(null);
  const writing = useRef(false);
  const generation = useRef(0);
  const seedRef = useRef(seed);
  const validateRef = useRef(validate);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    stateRef.current = null;
    if (!journal || !deviceId) return;
    let active = true;
    void (async () => {
      try {
        let loaded = await journal.load<T>(documentId);
        if (!loaded) {
          loaded = seedRef.current();
          validateRef.current(loaded);
          const input: CommitInput<T> = {
            eventId: randomUUID(),
            matchId: documentId,
            deviceId,
            controllerEpoch: 0,
            baseRevision: 0,
            expectedLocalRevision: -1,
            event: { type: "application.initialized", schemaVersion: 1 },
            projection: loaded,
          };
          try {
            await journal.commit(input);
          } catch (failure) {
            if (!(failure instanceof LocalConflictError)) throw failure;
            const existing = await journal.load<T>(documentId);
            if (!existing) throw failure;
            loaded = existing;
          }
        }
        validateRef.current(loaded);
        if (active && generation.current === currentGeneration) {
          stateRef.current = loaded;
          setState(loaded);
          setLoadedFrom({ journal, documentId });
          setError(null);
        }
      } catch (failure) {
        if (active)
          setError(
            failure instanceof Error
              ? failure.message
              : "Application records could not be opened. Existing records were retained.",
          );
      }
    })();
    return () => {
      active = false;
    };
  }, [journal, deviceId, documentId, loadAttempt]);

  const persist = useCallback(
    async (input: CommitInput<T>) => {
      if (!journal || writing.current || conflict) return false;
      if (input.matchId !== documentId || input.deviceId !== deviceId) {
        setError(
          "The pending action belongs to a different local context. Return to that context to retry it.",
        );
        return false;
      }
      writing.current = true;
      setBusy(true);
      pending.current = input;
      setRetryPending(true);
      const currentGeneration = generation.current;
      try {
        await journal.commit(input);
        if (currentGeneration !== generation.current) return true;
        stateRef.current = input.projection;
        setState(input.projection);
        pending.current = null;
        setRetryPending(false);
        setError(null);
        return true;
      } catch (failure) {
        if (currentGeneration === generation.current) {
          if (failure instanceof LocalConflictError) {
            setConflict(true);
            setRetryPending(false);
          }
          setError(
            failure instanceof Error
              ? failure.message
              : "Records were not saved. Retry the same action.",
          );
        }
        return false;
      } finally {
        writing.current = false;
        setBusy(false);
      }
    },
    [journal, conflict, documentId, deviceId],
  );

  const change = useCallback(
    async (update: (current: T) => T, action: string) => {
      const current = stateRef.current;
      if (
        !current ||
        !deviceId ||
        writing.current ||
        conflict ||
        pending.current
      ) {
        if (pending.current && !conflict)
          setError("Retry the unsaved action before making another change.");
        return false;
      }
      try {
        const proposed = update(current);
        const next = { ...proposed, revision: current.revision + 1 };
        validateRef.current(next);
        return persist({
          eventId: randomUUID(),
          matchId: documentId,
          deviceId,
          controllerEpoch: 0,
          baseRevision: 0,
          expectedLocalRevision: current.revision,
          event: {
            type: action,
            schemaVersion: 1,
            sourceRevision: current.revision,
          },
          projection: next,
        });
      } catch (failure) {
        setError(
          failure instanceof Error
            ? failure.message
            : "This change is invalid.",
        );
        return false;
      }
    },
    [deviceId, conflict, documentId, persist],
  );

  return {
    state:
      loadedFrom?.journal === journal && loadedFrom.documentId === documentId
        ? state
        : null,
    busy,
    error,
    conflict,
    retryPending,
    change,
    retry: () =>
      pending.current && !conflict
        ? persist(pending.current)
        : Promise.resolve(false),
    reload: () => {
      if (writing.current || (pending.current && !conflict)) return;
      // Conflicting candidates were committed to quarantine by the journal adapter.
      pending.current = null;
      setConflict(false);
      setRetryPending(false);
      setError(null);
      setLoadAttempt((value) => value + 1);
    },
  };
}
