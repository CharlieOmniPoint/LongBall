/** M0 adapters. A local commit is never an acknowledgement from a service. */
export type JournalMode = 'encrypted-native' | 'synthetic-browser';

export interface CommitInput<T> {
  eventId: string;
  matchId: string;
  deviceId: string;
  controllerEpoch: number;
  /** Last accepted server revision; remains zero in the offline M0 experiment. */
  baseRevision: number;
  /** Optimistic LOCAL projection revision; -1 means no projection exists. Separate from server revision. */
  expectedLocalRevision?: number;
  event: unknown;
  projection: T;
}

export interface CommitResult {
  sequence: number;
  previousEventId: string | null;
  duplicate: boolean;
}

export interface CipherProbe {
  status: 'passed' | 'failed' | 'unsupported';
  detail: string;
}

export interface JournalDiagnostics {
  mode: JournalMode;
  cipherVersion: string | null;
  pendingCount: number;
  conflictCount: number;
  savedCount: number;
  backupExcluded: boolean;
  deviceId: string;
  wrongKeyProbe: 'not-run' | 'passed' | 'failed' | 'unsupported';
}

/** Thrown only after the rejected local candidate has been durably retained. */
export class LocalConflictError extends Error {
  readonly code = 'LOCAL_CONFLICT';
  constructor(readonly eventId: string, message: string) { super(message); this.name = 'LocalConflictError'; }
}

export interface Journal {
  load<T>(matchId: string): Promise<T | null>;
  commit<T>(input: CommitInput<T>): Promise<CommitResult>;
  getDiagnostics(): Promise<JournalDiagnostics>;
  runCipherProbe(): Promise<CipherProbe>;
  close(): Promise<void>;
}

export interface ClockReading {
  monotonicMs: number;
  /** Changes after reboot (native) or page reload (browser). No continuity if absent. */
  continuityId: string;
  source: string;
  verifiedContinuous: boolean;
}

export interface NativeCapabilities {
  readClock(): ClockReading;
  storageDirectory(): { directory: string; backupExcluded: boolean; existingJournal: boolean };
}
