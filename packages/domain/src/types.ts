/** Local synthetic M0 domain. Commands are not the remote OpenAPI event envelope. */
export interface Player {
  id: string;
  displayName: string;
  goalkeeperChoice: number;
}
export type Attendance = 'present' | 'absent' | 'excused' | 'not_selected' | 'not_recorded';
export type MatchStatus = 'preparation' | 'first_half_running' | 'first_half_paused' | 'half_time' | 'second_half_running' | 'second_half_paused' | 'completed';
export interface Allocation { slotId: string; position: string; playerId: string }
export interface MatchConfig {
  matchId: string;
  players: Player[];
  selectedPlayerIds: string[];
  pitchPlaces: number;
  plannedHalfDurationMs: number;
  /** Explicit synthetic experiment policy; never inferred from a pitch drag. */
  fixedKeeperId: string | null;
}
/** sessionId proves continuity only within this running process/browser session. */
export interface ClockSample { monotonicMs: number; sessionId: string; wallTimeMs: number }
export interface ClockAnchor { sample: ClockSample; halfActiveMs: number; matchActiveMs: number }
export interface ParticipationInterval {
  playerId: string;
  state: 'playing' | 'available_bench' | 'unavailable';
  position: string | null;
  slotId: string | null;
  startMs: number;
  endMs: number;
  half: 1 | 2;
}
export interface TargetInterval {
  durationMs: number;
  availablePlayerIds: string[];
  pitchPlaces: number;
  fixedKeeperId: string | null;
}
export interface MatchState {
  config: MatchConfig;
  status: MatchStatus;
  revision: number;
  attendance: Record<string, Attendance>;
  availability: Record<string, boolean>;
  stagedLineup: Allocation[];
  lineup: Allocation[];
  half: 0 | 1 | 2;
  halfActiveMs: number;
  matchActiveMs: number;
  firstHalfDurationMs: number | null;
  anchor: ClockAnchor | null;
  recoveryRequired: boolean;
  intervals: ParticipationInterval[];
  targetIntervals: TargetInterval[];
  score: { for: number; against: number };
  halfTimeScore: { for: number; against: number } | null;
  /** Estimated device wall time only; not a trusted award-deadline anchor. */
  completedAtMs: number | null;
  completedTimeQuality: 'reviewRequired' | null;
  /** Checkpoint is deliberately retained when continuity is unproved. */
  recoveryReason: string | null;
  appliedEvents: Record<string, string>;
}
interface EventBase { id: string; sample: ClockSample }
export type MatchEvent = EventBase & (
  | { type: 'attendance.recorded'; playerId: string; status: Attendance }
  | { type: 'availability.changed'; playerId: string; available: boolean }
  | { type: 'lineup.staged'; lineup: Allocation[] }
  | { type: 'half.started' }
  | { type: 'half.paused' }
  | { type: 'half.resumed' }
  | { type: 'half.ended' }
  | { type: 'lineup.committed'; lineup: Allocation[]; sourceRevision: number }
  | { type: 'goal.recorded'; beneficiary: 'us' | 'opposition' }
  | { type: 'clock.recovery_required'; reason: string }
  | { type: 'clock.corrected'; halfActiveMs: number; reason: string; confirmUnchangedLineup: true }
);
export interface ClockReading {
  halfActiveMs: number;
  matchActiveMs: number;
  remainingMs: number;
  addedMs: number;
  recoveryRequired: boolean;
}
export interface PlayerMinutes {
  playerId: string;
  playingMs: number;
  benchMs: number;
  unavailableMs: number;
  positionMs: Record<string, number>;
}
export interface Rational { numerator: bigint; denominator: bigint }
export interface TargetResult {
  playerId: string;
  target: Rational;
  lower: Rational;
  upper: Rational;
}
