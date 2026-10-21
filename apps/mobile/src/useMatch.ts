import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { randomUUID } from "./platform/id";
import {
  createMatch,
  ENGINE_VERSION,
  readClock as deriveClock,
  reduceMatch,
  upgradeMatchState,
  type Allocation,
  type ClockSample,
  type MatchConfig,
  type MatchEvent,
  type MatchState,
} from "@longball/domain";
import { romaFixture } from "@longball/testing";
import { createPreparationState } from "@longball/application/preparation";
import { openJournal } from "./platform/journal";
import { readClock } from "./platform/clock";
import {
  LocalConflictError,
  type CommitInput,
  type Journal,
  type JournalDiagnostics,
} from "./platform/types";

export const matchId = "synthetic-roma-maple-2026-10-24";
export const slots = [
  { slotId: "gk", position: "GK" },
  { slotId: "cb-left", position: "CB" },
  { slotId: "cb-right", position: "CB" },
  { slotId: "cm", position: "CM" },
  { slotId: "lw", position: "LW" },
  { slotId: "rw", position: "RW" },
  { slotId: "st", position: "ST" },
];
export const initialConfig = {
  matchId,
  players: romaFixture.players,
  selectedPlayerIds: romaFixture.players
    .filter((player) => player.available)
    .map((player) => player.id),
  pitchPlaces: romaFixture.pitchPlaces,
  plannedHalfDurationMs: romaFixture.plannedHalfDurationMs,
  fixedKeeperId: romaFixture.players[0].id,
  slots,
  profileSnapshot: createPreparationState().profiles.map((profile) => ({
    playerId: profile.playerId,
    preferences: [...profile.preferences],
    eligiblePositions: [...profile.eligiblePositions],
    initials: profile.initials,
  })),
};
export function sampleClock(): ClockSample {
  const clock = readClock();
  return {
    monotonicMs: clock.monotonicMs,
    sessionId: clock.continuityId,
    wallTimeMs: Date.now(),
  };
}
type Command = MatchEvent extends infer E
  ? E extends MatchEvent
    ? Omit<E, "id" | "sample">
    : never
  : never;

/** Local versioned experiment envelope, not a remote OpenAPI event. */
function localEnvelope(command: unknown) {
  return { schemaVersion: 1, engineVersion: ENGINE_VERSION, command };
}
function failureMessage(failure: unknown, fallback: string): string {
  return failure instanceof Error ? failure.message : fallback;
}

export function suggestedStartingLineup(state: MatchState): Allocation[] {
  const eligible = state.config.selectedPlayerIds.filter(
    (id) => state.attendance[id] === "present" && state.availability[id],
  );
  const keeper =
    state.config.fixedKeeperId ??
    state.config.players.find(
      (player) =>
        eligible.includes(player.id) &&
        [1, 2].includes(player.goalkeeperChoice),
    )?.id;
  if (!keeper || !eligible.includes(keeper)) return [];
  const positions = state.config.slots ?? slots;
  const used = new Set<string>();
  const result: Allocation[] = [];
  // Small bipartite matching avoids a greedy early choice stealing the only eligible cover.
  function place(index: number): boolean {
    if (index === positions.length) return true;
    const slot = positions[index];
    const candidates =
      slot.position === "GK"
        ? [keeper!]
        : eligible.filter((id) => id !== state.config.fixedKeeperId);
    for (const playerId of candidates) {
      if (used.has(playerId)) continue;
      const profile = state.config.profileSnapshot?.find(
        (item) => item.playerId === playerId,
      );
      if (profile && !profile.eligiblePositions.includes(slot.position))
        continue;
      used.add(playerId);
      result.push({ slotId: slot.slotId, position: slot.position, playerId });
      if (place(index + 1)) return true;
      used.delete(playerId);
      result.pop();
    }
    return false;
  }
  return place(0) ? result : [];
}

/** Saves the exact event and projection before exposing success to the interface. */
export function useMatch(config: MatchConfig = initialConfig) {
  const matchId = config.matchId;
  const [storage, setStorage] = useState<{
    journal: Journal;
    deviceId: string;
  } | null>(null);
  const [state, setState] = useState<MatchState | null>(null);
  const [diagnostics, setDiagnostics] = useState<JournalDiagnostics | null>(
    null,
  );
  const [diagnosticsWarning, setDiagnosticsWarning] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingRetry, setPendingRetry] = useState(false);
  const [sample, setSample] = useState(sampleClock);
  const stateRef = useRef<MatchState | null>(null);
  const journalRef = useRef<Journal | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  const writing = useRef(false);
  const retryRef = useRef<CommitInput<MatchState> | null>(null);
  const bootstrapRef = useRef<CommitInput<MatchState> | null>(null);
  const durableConflictRef = useRef<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    let opened: Journal | null = null;
    let startupFinished = false;
    const closeOpened = async () => {
      const closing = opened;
      opened = null;
      if (closing) {
        try {
          await closing.close();
        } catch {
          /* Preserve the original startup failure. */
        }
      }
    };
    stateRef.current = null;
    journalRef.current = null;
    deviceIdRef.current = null;
    void (async () => {
      try {
        opened = await openJournal();
        if (active) {
          setStorage(null);
          setState(null);
        }
        if (!active) {
          await closeOpened();
          return;
        }
        const journal = opened;
        const info = await journal.getDiagnostics();
        let loaded = await journal.load<MatchState>(matchId);
        if (!active) {
          await closeOpened();
          return;
        }
        if (!loaded) {
          loaded = createMatch(config);
          const seed = (bootstrapRef.current?.matchId === matchId
            ? bootstrapRef.current
            : null) ?? {
            eventId: randomUUID(),
            matchId,
            deviceId: info.deviceId,
            controllerEpoch: 1,
            baseRevision: 0,
            expectedLocalRevision: -1,
            event: localEnvelope({ type: "synthetic.match.prepared", config }),
            projection: loaded,
          };
          bootstrapRef.current = seed;
          try {
            await journal.commit(seed);
          } catch (failure) {
            if (!(failure instanceof LocalConflictError) || !active)
              throw failure;
            // Another tab won bootstrap. Keep our rejected candidate and show its saved projection.
            const winner = await journal.load<MatchState>(matchId);
            if (!winner) throw failure;
            loaded = winner;
            retryRef.current = seed;
            durableConflictRef.current = failure.eventId;
            if (active) {
              setConflict(failure.message);
              setPendingRetry(false);
            }
          }
          if (bootstrapRef.current === seed) bootstrapRef.current = null;
        }
        if (!active) {
          await closeOpened();
          return;
        }
        loaded = upgradeMatchState(loaded);
        journalRef.current = journal;
        deviceIdRef.current = info.deviceId;
        stateRef.current = loaded;
        setStorage({ journal, deviceId: info.deviceId });
        setState(loaded);
        setDiagnostics(info);
        setSample(sampleClock());
        setError(null);
        // Failure to refresh counts cannot turn a committed seed into a failed save.
        try {
          const refreshed = await journal.getDiagnostics();
          if (active) setDiagnostics(refreshed);
        } catch (failure) {
          if (active)
            setDiagnosticsWarning(
              failureMessage(
                failure,
                "The match opened, but diagnostic counts could not be refreshed.",
              ),
            );
        }
      } catch (failure) {
        if (active) {
          journalRef.current = null;
          deviceIdRef.current = null;
          stateRef.current = null;
          setStorage(null);
          setState(null);
          setError(
            failureMessage(failure, "The local match could not be opened."),
          );
        }
        await closeOpened();
      } finally {
        startupFinished = true;
        if (!active) await closeOpened();
      }
    })();
    return () => {
      active = false;
      journalRef.current = null;
      deviceIdRef.current = null;
      // Let a startup transaction settle before closing its connection.
      if (startupFinished) void closeOpened();
    };
  }, [loadAttempt, matchId, config]);

  useEffect(() => {
    const interval = setInterval(() => setSample(sampleClock()), 250);
    const subscription = AppState.addEventListener("change", (value) => {
      if (value === "active") setSample(sampleClock());
    });
    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, []);

  const refreshDiagnostics = useCallback(
    async (journal: Journal): Promise<void> => {
      try {
        const refreshed = await journal.getDiagnostics();
        if (journalRef.current === journal) {
          setDiagnostics(refreshed);
          setDiagnosticsWarning(null);
        }
      } catch (failure) {
        if (journalRef.current === journal)
          setDiagnosticsWarning(
            failureMessage(
              failure,
              "Diagnostic counts could not be refreshed. The committed match remains saved.",
            ),
          );
      }
    },
    [],
  );

  const savePrepared = useCallback(
    async (input: CommitInput<MatchState>): Promise<boolean> => {
      const journal = journalRef.current;
      if (!journal || writing.current || durableConflictRef.current)
        return false;
      writing.current = true;
      setBusy(true);
      // Keep the complete original transaction, not a regenerated timestamp or projection.
      retryRef.current = input;
      setPendingRetry(true);
      try {
        await journal.commit(input);
        if (journalRef.current !== journal) return true;
        stateRef.current = input.projection;
        setState(input.projection);
        retryRef.current = null;
        setPendingRetry(false);
        setSample(sampleClock());
        setError(null);
        await refreshDiagnostics(journal);
        return true;
      } catch (failure) {
        if (journalRef.current === journal) {
          if (
            failure instanceof LocalConflictError &&
            failure.eventId === input.eventId
          ) {
            // The adapter throws only after committing this rejected branch to quarantine.
            durableConflictRef.current = failure.eventId;
            setConflict(failure.message);
            setPendingRetry(false);
            setError(null);
            await refreshDiagnostics(journal);
          } else
            setError(
              failureMessage(
                failure,
                "Action not saved. Please retry the same action.",
              ),
            );
        }
        return false;
      } finally {
        writing.current = false;
        setBusy(false);
      }
    },
    [refreshDiagnostics],
  );

  const send = useCallback(
    async (command: Command): Promise<boolean> => {
      if (durableConflictRef.current) return false;
      if (retryRef.current) {
        setError("Retry the unsaved action before making another change.");
        return false;
      }
      const current = stateRef.current;
      const deviceId = deviceIdRef.current;
      if (!current || !journalRef.current || !deviceId || writing.current)
        return false;
      const event = {
        ...command,
        id: randomUUID(),
        sample: sampleClock(),
      } as MatchEvent;
      let next: MatchState;
      try {
        next = reduceMatch(current, event);
      } catch (failure) {
        setError(
          failureMessage(
            failure,
            "The action is not valid in the current match state.",
          ),
        );
        return false;
      }
      return savePrepared({
        eventId: event.id,
        matchId,
        deviceId,
        controllerEpoch: 1,
        // This experiment has no accepted server stream. Local revision is separate.
        baseRevision: 0,
        expectedLocalRevision: current.revision,
        event: localEnvelope(event),
        projection: next,
      });
    },
    [savePrepared, matchId],
  );

  const runCipherProbe = useCallback(async (): Promise<string> => {
    const journal = journalRef.current;
    if (!journal)
      return "Open the local journal before running the encryption probe.";
    if (writing.current || retryRef.current)
      return "Finish or retry the pending match action before running the encryption probe.";
    writing.current = true;
    setBusy(true);
    try {
      const result = await journal.runCipherProbe();
      await refreshDiagnostics(journal);
      return `${result.status}: ${result.detail}`;
    } catch (failure) {
      await refreshDiagnostics(journal);
      return `failed: ${failureMessage(failure, "The disposable encryption probe could not complete.")}`;
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }, [refreshDiagnostics]);

  const reloadAfterConflict = useCallback(() => {
    const retainedEventId = durableConflictRef.current;
    // Only an explicitly durably quarantined candidate may be dismissed this way.
    if (
      writing.current ||
      !retainedEventId ||
      retryRef.current?.eventId !== retainedEventId
    )
      return;
    retryRef.current = null;
    bootstrapRef.current = null;
    durableConflictRef.current = null;
    setPendingRetry(false);
    setConflict(null);
    setError(null);
    setState(null);
    setDiagnostics(null);
    setDiagnosticsWarning(null);
    setLoadAttempt((value) => value + 1);
  }, []);

  return {
    journal:
      state?.config.matchId === matchId ? (storage?.journal ?? null) : null,
    deviceId:
      state?.config.matchId === matchId ? (storage?.deviceId ?? null) : null,
    state,
    diagnostics,
    diagnosticsWarning,
    error,
    conflict,
    busy,
    sample,
    clock: state ? deriveClock(state, sample) : null,
    send,
    runCipherProbe,
    reloadAfterConflict,
    retry: () =>
      durableConflictRef.current
        ? Promise.resolve(false)
        : retryRef.current
          ? savePrepared(retryRef.current)
          : (setError(null), Promise.resolve(true)),
    retryLoad: () => {
      if (!writing.current && !durableConflictRef.current) {
        setError(null);
        setState(null);
        setDiagnostics(null);
        setDiagnosticsWarning(null);
        setLoadAttempt((value) => value + 1);
      }
    },
    pendingRetry,
  };
}

export function formatTime(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
