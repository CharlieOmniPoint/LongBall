/** Local synthetic M0 domain. Commands are not the remote OpenAPI event envelope. */
export interface Player {
  id: string;
  displayName: string;
  goalkeeperChoice: number;
  /** Ordered match-time position preferences; later profile edits must not rewrite them. */
  positionPreferences?: string[];
  profileVersion?: string;
}
export type Attendance = 'present' | 'absent' | 'excused' | 'not_selected' | 'not_recorded';
export type MatchStatus = 'preparation' | 'first_half_running' | 'first_half_paused' | 'half_time' | 'second_half_running' | 'second_half_paused' | 'completed' | 'abandoned';
export interface Allocation { slotId: string; position: string; playerId: string }
/** The supplied canonical PolicyPayload. Applicability is explicit in the runtime extension below. */
export interface MatchPolicyPayload {
  keeperMode: 'sole_fixed' | 'common_pool';
  fixedKeeperPlayerSeasonId: string | null;
  minimumStintMs: number;
  batchLimit: number;
  scoreLeadThreshold: number;
  returnToNormalEnabled: boolean;
}
export interface MatchPolicyApplicability {
  minimumStint: 'soft_preference';
  batchLimit: 'soft_preference';
  q07: 'unapproved';
}
/** A reusable plan may propose settings; only an explicit controller event activates them. */
export interface MatchPolicyProposal {
  payload: MatchPolicyPayload;
  applicability: MatchPolicyApplicability;
  softPreferences: { halfBufferFraction: number };
}
export interface PolicyEffectiveTime { half: 0 | 1 | 2; halfElapsedMs: number; matchElapsedMs: number }
export interface PolicyChangeDetails extends MatchPolicyProposal {
  policySchemaVersion: 1;
  policyVersion: number;
  previousPolicyVersion: number;
  sourceRevision: number;
  effective: PolicyEffectiveTime;
  reason: string;
  /** A deliberate reset is a new prospective policy event, never an edit to a prior event. */
  resetPositionMode?: boolean;
}
export interface MatchPolicyRecord extends PolicyChangeDetails {
  eventId: string;
  revision: number;
  recordedAtMs: number;
  actorId: string | null;
}
export interface ActiveMatchPolicy extends MatchPolicyRecord {
  /** Derived from confirmed policy/score history; never a player movement. */
  positionMode: 'normal' | 'adventurous';
  manualResetAtSourceRevision: number | null;
}
export interface MatchConfig {
  matchId: string;
  players: Player[];
  selectedPlayerIds: string[];
  pitchPlaces: number;
  plannedHalfDurationMs: number;
  /** Explicit synthetic experiment policy; never inferred from a pitch drag. */
  fixedKeeperId: string | null;
  /** Prepared proposals remain inactive until reviewed; they infer neither attendance nor a lineup. */
  initialPolicyProposal?: MatchPolicyProposal;
  initialLineupProposal?: Allocation[];
  /** Explicit manager check-in copied at preparation; never inferred from RSVP. */
  initialAttendance?: Record<string, Attendance>;
  slots?: { slotId: string; position: string; x?: number; y?: number; label?: string }[];
  fixture?: { opponent: string; playedDate: string; kickoff: string | null; homeAway: 'home' | 'away'; seasonId: string; teamId: string; teamName: string; clubName: string };
  profileSnapshot?: { playerId: string; preferences: string[]; eligiblePositions: string[]; initials: string }[];
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
  /** Absent on earlier accepted history; never backfilled or silently relabelled. */
  policyVersion?: number;
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
  abandonedAtMs?: number | null;
  abandonReason?: 'weather' | 'safety' | 'insufficient_players' | 'other' | null;
  /** Checkpoint is deliberately retained when continuity is unproved. */
  recoveryReason: string | null;
  appliedEvents: Record<string, string>;
  /** Optional for old M0 projections; upgradeMatchState replays their retained command signatures. */
  schemaVersion?: 2;
  goals?: GoalRecord[];
  availabilityHistory?: AvailabilityRecord[];
  eventHistory?: MatchEvent[];
  audit?: MatchAuditEntry[];
  /** Optional so historical projections without EV05 remain byte-for-byte replay compatible. */
  activePolicy?: ActiveMatchPolicy;
  policyHistory?: MatchPolicyRecord[];
}
export interface EffectiveMatchTime { half: 1 | 2; halfElapsedMs: number; matchElapsedMs: number }
export type GoalType = 'open_play' | 'free_kick' | 'penalty' | 'not_recorded';
export interface GoalDetails {
  beneficiary: 'us' | 'opposition';
  isOwnGoal?: boolean;
  scorerPlayerId?: string | null;
  goalType?: GoalType;
  effective?: EffectiveMatchTime;
}
export interface GoalRecord {
  /** The original goal remains the logical identity through corrections. */
  eventId: string;
  latestEventId: string;
  beneficiary: 'us' | 'opposition';
  isOwnGoal: boolean;
  scorerPlayerId: string | null;
  goalType: GoalType;
  effective: EffectiveMatchTime;
  recordedAtMs: number;
  voided: boolean;
}
export type AvailabilityReason = 'arrival' | 'departure' | 'injury' | 'return' | 'other';
export interface AvailabilityDetails {
  playerId: string;
  available: boolean;
  reason?: AvailabilityReason;
  effective?: EffectiveMatchTime;
  /** A complete, deliberately confirmed replacement batch at the same boundary. */
  replacementLineup?: Allocation[];
}
export interface AvailabilityRecord {
  eventId: string;
  latestEventId: string;
  playerId: string;
  available: boolean;
  previousAvailability: boolean;
  reason: AvailabilityReason;
  effective: EffectiveMatchTime | null;
  recordedAtMs: number;
}
export interface MatchAuditEntry {
  eventId: string;
  type: MatchEvent['type'];
  revision: number;
  recordedAtMs: number;
  actorId: string | null;
  effective: EffectiveMatchTime | null;
  targetEventId: string | null;
  reason: string | null;
  priorValue: unknown;
  value: unknown;
}
interface EventBase { id: string; sample: ClockSample; actorId?: string }
export type MatchEvent = EventBase & (
  | { type: 'attendance.recorded'; playerId: string; status: Attendance }
  | ({ type: 'availability.changed'; sourceRevision?: number; lateEntryReason?: string } & AvailabilityDetails)
  | { type: 'lineup.staged'; lineup: Allocation[] }
  | { type: 'half.started' }
  | { type: 'half.paused' }
  | { type: 'half.resumed' }
  | { type: 'half.ended' }
  | ({ type: 'policy.changed' } & PolicyChangeDetails)
  | { type: 'match.abandoned'; reason: 'weather' | 'safety' | 'insufficient_players' | 'other'; note?: string }
  | { type: 'lineup.committed'; lineup: Allocation[]; sourceRevision: number; effective?: EffectiveMatchTime; lateEntryReason?: string }
  | ({ type: 'goal.recorded'; lateEntryReason?: string } & GoalDetails)
  | { type: 'event.corrected'; targetEventId: string; reason: string; restoreVoided?: boolean;
      /** A retrospective participation draft must still refer to the reviewed history revision. */
      sourceRevision?: number;
      replacement: ({ type: 'goal.recorded' } & GoalDetails) | ({ type: 'availability.changed' } & AvailabilityDetails)
        | { type: 'lineup.committed'; lineup: Allocation[]; effective: EffectiveMatchTime } }
  | { type: 'event.voided'; targetEventId: string; reason: string; sourceRevision?: number }
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
