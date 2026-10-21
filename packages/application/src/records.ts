import { currentTargets, goalRecords, playerMinutes, rationalToNumber, withinTargetBand, type Attendance, type MatchState } from '@longball/domain';
import { romaFixture } from '@longball/testing';

/** Local rehearsal projections. These selectors do not replace server authorisation. */
export type RecordsActor = 'manager' | 'player' | 'spectator';
export type FixtureClass = 'development' | 'friendly' | 'trophy' | 'unclassified';
export interface RecordsViewer { actor: RecordsActor; playerId?: string; teamId?: string; seasonId?: string }
export interface RecordedScore { for: number; against: number }
export interface RecordPlayer { id: string; label: string }
export interface ResultPublicationPolicy {
  id: string;
  version: number;
  fixtureClass: FixtureClass;
  confirmed: boolean;
  confirmationReference: string | null;
  allowedRoles: ('player' | 'spectator')[];
}
export interface RecordedGoal {
  id: string;
  beneficiary: 'us' | 'opposition';
  isOwnGoal: boolean;
  scorerPlayerId: string | null;
  goalType: 'open_play' | 'free_kick' | 'penalty' | null;
  half: 1 | 2 | null;
  halfElapsedMs: number | null;
}
export interface HistoricalResultInput {
  playedDate: string;
  recordedKickoff: string | null;
  sameDayOrder: number | null;
  opponent: string;
  homeAway: 'home' | 'away' | 'neutral';
  fixtureClass: FixtureClass;
  status: 'completed' | 'abandoned' | 'cancelled' | 'postponed' | 'incomplete';
  specialOutcome: 'ordinary' | 'awarded' | 'forfeit' | 'shootout';
  finalScore: RecordedScore | null;
  halfTimeScore: RecordedScore | null;
  goals: RecordedGoal[];
}
export interface RecordedPlayerParticipation {
  playerId: string;
  playedMs: number;
  availableBenchMs: number;
  unavailableMs: number;
  positionMs: Record<string, number>;
  /** Match-time evidence; later preference edits cannot reclassify old goalkeeper time. */
  primaryWasGoalkeeper: boolean | null;
  preferenceMs?: Record<'first' | 'second' | 'backup' | 'other' | 'unknown', number>;
  intervals?: { half: 1 | 2; startMs: number; endMs: number; state: 'playing' | 'available_bench' | 'unavailable'; position: string | null }[];
  target?: { targetMs: number; lowerMs: number; upperMs: number; withinBand: boolean; deviationRatio: number | null; exceptionReason: string | null };
}
export interface MatchRecord extends HistoricalResultInput {
  id: string;
  teamId: string;
  seasonId: string;
  recordMode: 'historical_summary' | 'detailed_live';
  detailCompleteness: 'summary_only' | 'complete' | 'review_required';
  publication: ResultPublicationPolicy;
  classificationVersion: number;
  selectedPlayerIds: string[] | null;
  attendance: Record<string, Attendance> | null;
  participation: RecordedPlayerParticipation[] | null;
  actualActiveDurationMs: number | null;
  keeperPolicy: 'sole_fixed_keeper' | 'rotating_or_unfixed' | null;
  sourceMatchRevision: number | null;
  enteredAt: string;
  updatedAt: string;
  revision: number;
  /** Historical recording never starts an award window or creates an award. */
  awardStatus: 'not_recorded';
}
export interface TrainingAttendanceEvidence {
  sourcePreparationRevision?: number;
  sourceCommandId?: string | null;
  sessionId: string;
  playedDate: string;
  eventStatus: 'held' | 'cancelled' | 'scheduled';
  expectedPlayerIds: string[];
  attendance: Record<string, 'present' | 'absent' | 'excused' | 'not_recorded'>;
  responses?: Record<string, 'available' | 'unavailable' | 'unsure' | 'no_reply'>;
}
export interface GamePreparationEvidence {
  matchId: string;
  responses: Record<string, 'available' | 'unavailable' | 'unsure' | 'no_reply'>;
  sourcePreparationRevision: number;
  sourceCommandId: string;
}
export interface LiveMatchDetails {
  matchId: string;
  playedDate: string;
  opponent: string;
  homeAway: 'home' | 'away' | 'neutral';
  fixtureClass: FixtureClass;
}
export interface RecordsAuditEntry {
  commandId: string;
  action: string;
  matchId: string | null;
  at: string;
  reason: string;
  before: MatchRecord | null;
  after: MatchRecord | null;
}
export interface RecordsState {
  schemaVersion: 1;
  clubId: string;
  teamId: string;
  seasonId: string;
  seasonLabel: string;
  startsOn: string;
  endsOn: string;
  players: RecordPlayer[];
  liveMatch: LiveMatchDetails;
  /** Server-seeded approval for the first projection only; never inferred from a score or team role. */
  initialLivePublication?: { matchId: string; fixtureClass: FixtureClass; publication: ResultPublicationPolicy };
  results: MatchRecord[];
  trainingAttendance: TrainingAttendanceEvidence[];
  /** Optional on retained earlier documents; absent evidence remains unknown. */
  gamePreparation?: GamePreparationEvidence[];
  audit: RecordsAuditEntry[];
  revision: number;
  appliedCommands: Record<string, string>;
}
interface CommandBase { commandId: string; at: string; actor: RecordsActor }
export type RecordsCommand = CommandBase & (
  | { type: 'historical.add'; recordId: string; input: HistoricalResultInput; acknowledgePossibleDuplicate?: boolean }
  | { type: 'historical.correct'; recordId: string; expectedRevision: number; input: HistoricalResultInput; reason: string }
  | { type: 'live.archive'; match: MatchState; reason?: string }
  | { type: 'live.context.set'; details: LiveMatchDetails }
  | { type: 'publication.set'; recordId: string; expectedRevision: number; policy: ResultPublicationPolicy; reason: string }
  | { type: 'training.evidence.replace'; evidence: TrainingAttendanceEvidence[] }
  | { type: 'game.evidence.replace'; evidence: GamePreparationEvidence[] }
  | { type: 'participation.exception.noted'; recordId: string; expectedRevision: number; playerId: string; reason: string }
);

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function signature(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(signature).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${signature(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function nonnegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative whole number.`);
}
function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function validInstant(value: string): boolean { return Number.isFinite(Date.parse(value)) && /(?:Z|[+-]\d\d:\d\d)$/.test(value); }
function validateScore(value: RecordedScore | null): void {
  if (value) { nonnegative(value.for, 'Our score'); nonnegative(value.against, 'Opposition score'); }
}
export function managerOnlyPublication(fixtureClass: FixtureClass): ResultPublicationPolicy {
  return { id: 'unconfirmed-competition-policy', version: 1, fixtureClass, confirmed: false, confirmationReference: null, allowedRoles: [] };
}
function validateInput(state: RecordsState, input: HistoricalResultInput): void {
  if (!validDate(input.playedDate) || input.playedDate < state.startsOn || input.playedDate > state.endsOn) throw new Error('Choose a real played date within this team season.');
  if (!input.opponent.trim()) throw new Error('Record the opposition.');
  if (input.recordedKickoff !== null && !validInstant(input.recordedKickoff)) throw new Error('Known kick-off must include its timezone; otherwise leave it not recorded.');
  if (input.sameDayOrder !== null) nonnegative(input.sameDayOrder, 'Same-day order');
  validateScore(input.finalScore); validateScore(input.halfTimeScore);
  if (input.halfTimeScore && input.finalScore && (input.halfTimeScore.for > input.finalScore.for || input.halfTimeScore.against > input.finalScore.against)) throw new Error('Half-time goals cannot exceed the final score.');
  if (new Set(input.goals.map(goal => goal.id)).size !== input.goals.length) throw new Error('Known goals need distinct identifiers.');
  for (const goal of input.goals) {
    if (!goal.id) throw new Error('A known goal needs an identifier.');
    if (goal.scorerPlayerId && !state.players.some(player => player.id === goal.scorerPlayerId)) throw new Error('The scorer must belong to this archived team-season roster.');
    if ((goal.beneficiary === 'opposition' && !goal.isOwnGoal || goal.beneficiary === 'us' && goal.isOwnGoal) && goal.scorerPlayerId !== null) throw new Error('An opposition scorer cannot be credited to one of our players.');
    if (goal.halfElapsedMs !== null) {
      nonnegative(goal.halfElapsedMs, 'Known goal time');
      if (goal.half === null) throw new Error('A known goal time needs its half.');
    }
  }
  if (input.finalScore && (input.goals.filter(goal => goal.beneficiary === 'us').length > input.finalScore.for || input.goals.filter(goal => goal.beneficiary === 'opposition').length > input.finalScore.against)) throw new Error('Known goal attribution cannot exceed the recorded score.');
}
function historicalRecord(state: RecordsState, id: string, input: HistoricalResultInput, at: string): MatchRecord {
  validateInput(state, input);
  return {
    ...clone(input), opponent: input.opponent.trim(), id, teamId: state.teamId, seasonId: state.seasonId,
    recordMode: 'historical_summary', detailCompleteness: 'summary_only', publication: managerOnlyPublication(input.fixtureClass), classificationVersion: 1,
    selectedPlayerIds: null, attendance: null, participation: null, actualActiveDurationMs: null, keeperPolicy: null,
    sourceMatchRevision: null, enteredAt: at, updatedAt: at, revision: 1, awardStatus: 'not_recorded',
  };
}

export function createRecordsSeed(options: { demoSharing?: boolean } = {}): RecordsState {
  const state: RecordsState = {
    schemaVersion: 1, clubId: 'synthetic-richmond-rovers', teamId: romaFixture.teamId, seasonId: 'synthetic-season-2026-27', seasonLabel: '26/27',
    startsOn: '2026-09-01', endsOn: '2027-08-31',
    players: romaFixture.players.map(player => ({ id: player.id, label: player.displayName })),
    liveMatch: { matchId: 'synthetic-roma-maple-2026-10-24', playedDate: '2026-10-24', opponent: 'Maple FC', homeAway: 'home', fixtureClass: 'development' },
    results: [], trainingAttendance: [], audit: [], revision: 0, appliedCommands: {},
  };
  const examples = [
    { id: 'synthetic-history-maple', date: '2026-10-03', opponent: 'Maple FC', score: { for: 3, against: 1 }, fixtureClass: 'development' as const },
    { id: 'synthetic-history-oak', date: '2026-10-10', opponent: 'Oak FC', score: { for: 2, against: 2 }, fixtureClass: 'friendly' as const },
    { id: 'synthetic-history-hill', date: '2026-10-17', opponent: 'Hill FC', score: { for: 0, against: 1 }, fixtureClass: 'development' as const },
  ];
  state.results = examples.map((example, index) => historicalRecord(state, example.id, {
    playedDate: example.date, recordedKickoff: null, sameDayOrder: null, opponent: example.opponent,
    homeAway: index === 1 ? 'away' : 'home', fixtureClass: example.fixtureClass, status: 'completed', specialOutcome: 'ordinary',
    finalScore: example.score, halfTimeScore: null,
    goals: index === 0 ? [{ id: 'synthetic-history-known-goal', beneficiary: 'us', isOwnGoal: false, scorerPlayerId: romaFixture.players[1].id, goalType: null, half: null, halfElapsedMs: null }] : [],
  }, '2026-10-20T12:00:00Z'));
  if (options.demoSharing) {
    state.initialLivePublication = { matchId: state.liveMatch.matchId, fixtureClass: state.liveMatch.fixtureClass, publication: {
      id: 'demo-simulated-scores-v1', version: 1, fixtureClass: state.liveMatch.fixtureClass,
      confirmed: true, confirmationReference: 'Generated test scenario only; no competition or real-data approval.', allowedRoles: ['player', 'spectator'],
    } };
    state.results = state.results.map((record) => ({ ...record, publication: {
      id: 'demo-simulated-scores-v1', version: 1, fixtureClass: record.fixtureClass,
      confirmed: true, confirmationReference: 'Generated test scenario only; no competition or real-data approval.', allowedRoles: ['player', 'spectator'],
    } }));
  }
  return state;
}

/** Capture only observed intervals. An active console is a checkpoint, not a fabricated live remote clock. */
export function snapshotLiveMatch(state: RecordsState, match: MatchState, at: string): MatchRecord {
  if (match.config.matchId !== state.liveMatch.matchId) throw new Error('Set this match’s recorded fixture details before reporting it.');
  const previousRecord = state.results.find(record => record.id === match.config.matchId);
  const sameClassification = previousRecord?.fixtureClass === state.liveMatch.fixtureClass;
  const initial = state.initialLivePublication;
  const initialPublication = !previousRecord && initial?.matchId === match.config.matchId &&
    initial.fixtureClass === state.liveMatch.fixtureClass && initial.publication.fixtureClass === state.liveMatch.fixtureClass
      ? initial.publication : null;
  const sample = match.anchor?.sample ?? { monotonicMs: 0, sessionId: 'records-checkpoint', wallTimeMs: 0 };
  const started = match.status !== 'preparation';
  const targets = started ? currentTargets(match, sample) : [];
  const input: HistoricalResultInput = {
    ...state.liveMatch, recordedKickoff: null, sameDayOrder: null,
    status: match.status === 'completed' ? 'completed' : match.status === 'abandoned' ? 'abandoned' : 'incomplete', specialOutcome: 'ordinary',
    finalScore: started ? { ...match.score } : null, halfTimeScore: match.halfTimeScore ? { ...match.halfTimeScore } : null,
    goals: started ? goalRecords(match).filter(goal => !goal.voided).map(goal => ({
      id: goal.eventId, beneficiary: goal.beneficiary, isOwnGoal: goal.isOwnGoal,
      scorerPlayerId: goal.scorerPlayerId, goalType: goal.goalType === 'not_recorded' ? null : goal.goalType,
      half: goal.effective.half, halfElapsedMs: goal.effective.halfElapsedMs,
    })) : [],
  };
  validateInput(state, input);
  return {
    ...input, id: match.config.matchId, teamId: state.teamId, seasonId: state.seasonId,
    recordMode: 'detailed_live', detailCompleteness: match.recoveryRequired ? 'review_required' : 'complete',
    publication: sameClassification ? clone(previousRecord!.publication) : initialPublication ? clone(initialPublication) : managerOnlyPublication(state.liveMatch.fixtureClass),
    classificationVersion: previousRecord ? previousRecord.classificationVersion + Number(!sameClassification) : 1,
    selectedPlayerIds: [...match.config.selectedPlayerIds], attendance: { ...match.attendance },
    participation: started ? playerMinutes(match, sample).map(player => {
      const saved = match.config.players.find(item => item.id === player.playerId);
      const target = targets.find(item => item.playerId === player.playerId);
      const targetMs = target ? rationalToNumber(target.target) : null;
      const priorEntry = state.results.find(record => record.id === match.config.matchId)?.participation?.find(item => item.playerId === player.playerId);
      const exceptionReason = priorEntry?.playedMs === player.playingMs && priorEntry.target?.targetMs === targetMs ? priorEntry.target.exceptionReason : null;
      const preferences = match.config.profileSnapshot?.find(item => item.playerId === player.playerId)?.preferences ?? saved?.positionPreferences ?? [];
      const preferenceMs = { first: 0, second: 0, backup: 0, other: 0, unknown: 0 };
      for (const [position, duration] of Object.entries(player.positionMs)) {
        const index = preferences.indexOf(position);
        const category = preferences.length === 0 ? 'unknown' : index === 0 ? 'first' : index === 1 ? 'second' : index >= 2 ? 'backup' : 'other';
        preferenceMs[category] += duration;
      }
      return {
        playerId: player.playerId, playedMs: player.playingMs, availableBenchMs: player.benchMs,
        unavailableMs: player.unavailableMs, positionMs: { ...player.positionMs }, preferenceMs,
        target: target && targetMs !== null ? { targetMs, lowerMs: rationalToNumber(target.lower), upperMs: rationalToNumber(target.upper), withinBand: withinTargetBand(player.playingMs, target), deviationRatio: targetMs === 0 ? null : (player.playingMs - targetMs) / targetMs, exceptionReason } : undefined,
        intervals: match.intervals.filter(item => item.playerId === player.playerId).map(item => ({ half: item.half, startMs: item.startMs, endMs: item.endMs, state: item.state, position: item.position })),
        primaryWasGoalkeeper: preferences.length ? preferences[0] === 'GK' : saved?.goalkeeperChoice ? saved.goalkeeperChoice === 1 : null,
      };
    }) : null,
    actualActiveDurationMs: started ? match.matchActiveMs : null, keeperPolicy: match.config.fixedKeeperId ? 'sole_fixed_keeper' : 'rotating_or_unfixed', sourceMatchRevision: match.revision,
    enteredAt: at, updatedAt: at, revision: 1, awardStatus: 'not_recorded',
  };
}

/** Append-only correction audit and idempotency for the local fictional records store. */
export function reduceRecords(previous: RecordsState, command: RecordsCommand): RecordsState {
  if (command.actor !== 'manager') throw new Error('Only the assigned manager rehearsal can change records.');
  if (!command.commandId || !validInstant(command.at)) throw new Error('A record command needs an identifier and an explicit timestamp.');
  const encoded = signature(command);
  if (previous.appliedCommands[command.commandId]) {
    if (previous.appliedCommands[command.commandId] !== encoded) throw new Error('Command identifier conflicts with previously recorded content.');
    return previous;
  }
  let state = previous;
  let before: MatchRecord | null = null;
  let after: MatchRecord | null = null;
  let reason = '';
  switch (command.type) {
    case 'historical.add': {
      if (!command.recordId.trim()) throw new Error('This historical match needs an identifier.');
      if (state.results.some(record => record.id === command.recordId)) throw new Error('This match identifier already exists. Open its correction route.');
      if (!command.acknowledgePossibleDuplicate && state.results.some(record => record.playedDate === command.input.playedDate && record.opponent.toLowerCase() === command.input.opponent.trim().toLowerCase())) throw new Error('A match against this opponent on this date already exists. Review it or acknowledge that these were separate games.');
      after = historicalRecord(state, command.recordId, command.input, command.at);
      state = { ...state, results: [...state.results, after] };
      reason = 'Historical summary entered; unknown detail retained.';
      break;
    }
    case 'historical.correct': {
      before = state.results.find(record => record.id === command.recordId) ?? null;
      if (!before || before.recordMode !== 'historical_summary') throw new Error('Use the live event correction route for a detailed match.');
      if (before.revision !== command.expectedRevision) throw new Error('This result changed. Review its latest revision before correcting.');
      if (!command.reason.trim()) throw new Error('Record a reason for the correction.');
      after = { ...historicalRecord(state, before.id, command.input, command.at), enteredAt: before.enteredAt, revision: before.revision + 1,
        classificationVersion: before.classificationVersion + Number(command.input.fixtureClass !== before.fixtureClass),
        publication: command.input.fixtureClass === before.fixtureClass ? clone(before.publication) : managerOnlyPublication(command.input.fixtureClass) };
      state = { ...state, results: state.results.map(record => record.id === before?.id ? after! : record) };
      reason = command.reason.trim();
      break;
    }
    case 'live.archive': {
      if (command.match.status !== 'completed' || command.match.recoveryRequired) throw new Error('Finish the match and resolve clock uncertainty before archiving a final participation record.');
      before = state.results.find(record => record.id === command.match.config.matchId) ?? null;
      if (before?.recordMode === 'historical_summary') throw new Error('A historical summary already uses this match identifier; explicit reconciliation is required.');
      if (before && ((before.sourceMatchRevision ?? -1) > command.match.revision || before.sourceMatchRevision === command.match.revision && before.fixtureClass === state.liveMatch.fixtureClass)) throw new Error('This match revision is already archived.');
      after = { ...snapshotLiveMatch(state, command.match, command.at), enteredAt: before?.enteredAt ?? command.at, revision: (before?.revision ?? 0) + 1 };
      state = { ...state, results: [...state.results.filter(record => record.id !== after?.id), after] };
      reason = command.reason?.trim() || 'Local completed match captured from recorded intervals.';
      break;
    }
    case 'live.context.set': {
      if (!validDate(command.details.playedDate) || command.details.playedDate < state.startsOn || command.details.playedDate > state.endsOn || !command.details.opponent.trim()) throw new Error('Choose valid fixture details in this season.');
      state = { ...state, liveMatch: clone(command.details) };
      before = state.results.find(record => record.id === command.details.matchId) ?? null;
      if (before && before.fixtureClass !== command.details.fixtureClass) {
        after = { ...before, publication: managerOnlyPublication(before.fixtureClass), revision: before.revision + 1, updatedAt: command.at };
        state = { ...state, results: state.results.map(record => record.id === after!.id ? after! : record) };
      }
      // A changed classification invalidates the initial approval permanently.
      // Returning to the old class cannot silently restore the discarded decision.
      if (state.initialLivePublication?.matchId === command.details.matchId && state.initialLivePublication.fixtureClass !== command.details.fixtureClass)
        delete state.initialLivePublication;
      reason = 'Current fixture context recorded.';
      break;
    }
    case 'publication.set': {
      before = state.results.find(record => record.id === command.recordId) ?? null;
      if (!before || before.revision !== command.expectedRevision) throw new Error('Review the latest result before changing its publication policy.');
      if (!command.reason.trim() || !command.policy.confirmationReference?.trim() || !command.policy.confirmed) throw new Error('A confirmed competition decision and audit reason are required before sharing.');
      if (before.fixtureClass === 'unclassified' || command.policy.fixtureClass !== before.fixtureClass || command.policy.version <= before.publication.version) throw new Error('Classify the fixture and provide a newer policy version that matches its class.');
      after = { ...before, publication: clone(command.policy), updatedAt: command.at, revision: before.revision + 1 };
      state = { ...state, results: state.results.map(record => record.id === before?.id ? after! : record) };
      reason = command.reason.trim();
      break;
    }
    case 'training.evidence.replace': {
      const ids = command.evidence.map(item => item.sessionId);
      if (new Set(ids).size !== ids.length || command.evidence.some(item => !validDate(item.playedDate) || item.playedDate < state.startsOn || item.playedDate > state.endsOn || new Set(item.expectedPlayerIds).size !== item.expectedPlayerIds.length)) throw new Error('Training evidence needs distinct sessions, unique expected players and dates in this season.');
      state = { ...state, trainingAttendance: clone(command.evidence) };
      reason = 'Training evidence updated from the local schedule; cancelled sessions remain excluded.';
      break;
    }
    case 'game.evidence.replace': {
      const ids = command.evidence.map(item => item.matchId);
      if (new Set(ids).size !== ids.length || command.evidence.some(item => !item.matchId || !Number.isSafeInteger(item.sourcePreparationRevision) || item.sourcePreparationRevision < 0 || !item.sourceCommandId || Object.entries(item.responses).some(([playerId, response]) => !state.players.some(player => player.id === playerId) || !['available', 'unavailable', 'unsure', 'no_reply'].includes(response)))) throw new Error('Game preparation evidence needs distinct fixtures, known season players and a recorded source revision.');
      state = { ...state, gamePreparation: clone(command.evidence) };
      reason = 'Game responses projected separately from actual attendance and active availability.';
      break;
    }
    case 'participation.exception.noted': {
      before = state.results.find(record => record.id === command.recordId) ?? null;
      if (!before || before.revision !== command.expectedRevision) throw new Error('Review the latest archived match before explaining an exception.');
      const item = before.participation?.find(entry => entry.playerId === command.playerId);
      if (!item?.target || item.target.withinBand) throw new Error('An exception note requires recorded participation outside its target band.');
      if (!command.reason.trim()) throw new Error('Record the reason for this target exception.');
      after = { ...before, participation: before.participation!.map(entry => entry.playerId === command.playerId ? { ...entry, target: { ...entry.target!, exceptionReason: command.reason.trim() } } : entry), updatedAt: command.at, revision: before.revision + 1 };
      state = { ...state, results: state.results.map(record => record.id === before?.id ? after! : record) };
      reason = command.reason.trim();
      break;
    }
  }
  return { ...state, revision: previous.revision + 1,
    audit: [...state.audit, { commandId: command.commandId, action: command.type, matchId: after?.id ?? before?.id ?? null, at: command.at, reason, before: clone(before), after: clone(after) }],
    appliedCommands: { ...state.appliedCommands, [command.commandId]: encoded } };
}

function inScope(state: RecordsState, viewer: RecordsViewer): boolean {
  return (!viewer.teamId || viewer.teamId === state.teamId) && (!viewer.seasonId || viewer.seasonId === state.seasonId);
}
function canShare(record: MatchRecord, actor: RecordsActor): boolean {
  return actor === 'manager' || record.fixtureClass !== 'unclassified' && record.publication.confirmed && Boolean(record.publication.confirmationReference) && record.publication.fixtureClass === record.fixtureClass && record.publication.allowedRoles.includes(actor);
}
function ordinaryCompleted(record: MatchRecord): boolean { return record.status === 'completed' && record.specialOutcome === 'ordinary' && record.finalScore !== null; }
function chronological(left: MatchRecord, right: MatchRecord): number {
  return left.playedDate.localeCompare(right.playedDate) ||
    (left.recordedKickoff && right.recordedKickoff ? Date.parse(left.recordedKickoff) - Date.parse(right.recordedKickoff) : (left.sameDayOrder ?? 0) - (right.sameDayOrder ?? 0)) || left.id.localeCompare(right.id);
}
export function resultOutcome(score: RecordedScore): 'W' | 'D' | 'L' { return score.for > score.against ? 'W' : score.for < score.against ? 'L' : 'D'; }
function publicResult(record: MatchRecord) {
  const included = ordinaryCompleted(record);
  const outcome = included ? resultOutcome(record.finalScore!) : null;
  return {
    id: record.id, playedDate: record.playedDate, recordedKickoff: record.recordedKickoff, sameDayOrder: record.sameDayOrder,
    opponent: record.opponent, homeAway: record.homeAway, fixtureClass: record.fixtureClass, status: record.status,
    recordMode: record.recordMode, detailCompleteness: record.detailCompleteness,
    finalScore: record.finalScore ? { ...record.finalScore } : null, halfTimeScore: record.halfTimeScore ? { ...record.halfTimeScore } : null,
    goals: clone(record.goals), unassignedGoalsFor: record.finalScore ? record.finalScore.for - record.goals.filter(goal => goal.beneficiary === 'us').length : null,
    unassignedGoalsAgainst: record.finalScore ? record.finalScore.against - record.goals.filter(goal => goal.beneficiary === 'opposition').length : null,
    outcome, points: outcome === 'W' ? 3 : outcome === 'D' ? 1 : outcome === 'L' ? 0 : null, revision: record.revision,
  };
}
export interface SeasonResultTotals { played: number; wins: number; draws: number; losses: number; goalsFor: number; goalsAgainst: number; goalDifference: number; points: number }
export function selectSeasonResults(state: RecordsState, viewer: RecordsViewer) {
  const scoped = inScope(state, viewer) ? state.results.filter(record => record.teamId === state.teamId && record.seasonId === state.seasonId) : [];
  const visible = scoped.filter(record => canShare(record, viewer.actor)).sort(chronological);
  const withheld = scoped.length - visible.length;
  const denied = !inScope(state, viewer) || withheld > 0;
  const included = visible.filter(ordinaryCompleted);
  const totals: SeasonResultTotals = { played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0 };
  for (const record of included) {
    const outcome = resultOutcome(record.finalScore!);
    totals.played += 1; totals.wins += Number(outcome === 'W'); totals.draws += Number(outcome === 'D'); totals.losses += Number(outcome === 'L');
    totals.goalsFor += record.finalScore!.for; totals.goalsAgainst += record.finalScore!.against;
  }
  totals.goalDifference = totals.goalsFor - totals.goalsAgainst; totals.points = totals.wins * 3 + totals.draws;
  const scorerCounts = new Map<string, number>();
  for (const record of included) for (const goal of record.goals) {
    if (goal.beneficiary === 'us' && !goal.isOwnGoal && goal.scorerPlayerId) scorerCounts.set(goal.scorerPlayerId, (scorerCounts.get(goal.scorerPlayerId) ?? 0) + 1);
  }
  const ambiguous = included.some((record, index) => included.some((other, otherIndex) => index !== otherIndex && other.playedDate === record.playedDate && !(other.recordedKickoff && record.recordedKickoff) && (other.sameDayOrder === null || record.sameDayOrder === null || other.sameDayOrder === record.sameDayOrder)));
  return {
    clubId: state.clubId, teamId: state.teamId, seasonId: state.seasonId, projectionVersion: state.revision, visibilityScope: viewer.actor,
    generatedAt: new Date().toISOString(), reportType: 'season_results' as const, appliedFilters: { teamId: state.teamId, seasonId: state.seasonId },
    asOf: latestRecordTime(state), competitionPolicies: visible.map(record => ({ matchId: record.id, policyId: record.publication.id, policyVersion: record.publication.version, fixtureClass: record.fixtureClass, classificationVersion: record.classificationVersion })),
    sharing: denied ? 'withheld_policy' as const : 'permitted' as const,
    suppressionReason: denied ? 'Scores and derived totals are not shared for this competition or scope.' : null,
    withheldResultCount: viewer.actor === 'manager' ? withheld : null, rows: visible.map(publicResult), totals: denied ? null : totals,
    scorerTotals: denied ? null : state.players.filter(player => scorerCounts.has(player.id)).map(player => ({ playerId: player.id, label: player.label, knownGoals: scorerCounts.get(player.id)! })),
    form: denied || ambiguous ? null : included.slice(-5).map(record => ({ matchId: record.id, outcome: resultOutcome(record.finalScore!) })),
    formChronologyState: ambiguous ? 'same_day_order_unknown' as const : 'known' as const,
    unknownScoreCount: visible.filter(record => record.status === 'completed' && record.finalScore === null).length,
    excludedExceptionalMatches: visible.filter(record => record.specialOutcome !== 'ordinary' || record.status === 'abandoned').length,
    dataCoverage: { totalRecordedMatches: denied ? null : scoped.length, knownOrdinaryResults: denied ? null : included.length, summaryOnlyCount: denied ? null : visible.filter(record => record.recordMode === 'historical_summary').length },
  };
}

function reportRecords(state: RecordsState, match: MatchState | null): MatchRecord[] {
  const scoped = state.results.filter(record => record.teamId === state.teamId && record.seasonId === state.seasonId);
  if (!match || match.config.matchId !== state.liveMatch.matchId || match.status === 'preparation') return scoped;
  // These timestamps describe the latest known local recording, never an invented kick-off.
  const current = snapshotLiveMatch(state, match, observedMatchTime(match) ?? latestRecordTime(state) ?? state.startsOn + 'T00:00:00Z');
  return [...scoped.filter(record => record.id !== current.id), current];
}
function observedMatchTime(match: MatchState | null): string | null {
  const value = match?.eventHistory?.at(-1)?.sample.wallTimeMs ?? match?.anchor?.sample.wallTimeMs ?? match?.completedAtMs;
  return value === null || value === undefined ? null : new Date(value).toISOString();
}
function latestRecordTime(state: RecordsState): string | null {
  const times = [...state.results.map(record => record.updatedAt), ...state.audit.map(entry => entry.at)].sort((a, b) => Date.parse(a) - Date.parse(b));
  return times.at(-1) ?? null;
}
export interface AttendanceSummary {
  eligibleEventCount: number;
  attendanceRecordedCount: number;
  attendedCount: number;
  knownAbsentCount: number;
  unknownAttendanceCount: number;
  excusedCount: number;
  knownRecordAttendanceRate: number | null;
  completenessRatio: number | null;
  policy: 'proposed_known_records_excused_included';
}
function attendanceSummary(values: Attendance[]): AttendanceSummary {
  const attended = values.filter(value => value === 'present').length;
  const absent = values.filter(value => value === 'absent' || value === 'excused').length;
  const recorded = attended + absent;
  return {
    eligibleEventCount: values.length, attendanceRecordedCount: recorded, attendedCount: attended, knownAbsentCount: absent,
    unknownAttendanceCount: values.length - recorded, excusedCount: values.filter(value => value === 'excused').length,
    knownRecordAttendanceRate: recorded ? attended / recorded : null, completenessRatio: values.length ? recorded / values.length : null,
    policy: 'proposed_known_records_excused_included',
  };
}
export interface ParticipationReportRow {
  playerId: string;
  label: string;
  matchesSelected: number;
  unknownHistoricalSelectionCount: number;
  matchesWithParticipationRecorded: number;
  matchesWithAttendanceRecorded: number;
  matchesPlayed: number;
  matchesAttended: number;
  playingMs: number;
  goalkeeperMs: number;
  outfieldMs: number;
  nonPrimaryGoalkeeperMs: number;
  goalkeeperMsWithUnknownPrimaryPreference: number;
  goalkeeperMsWithKnownPrimaryPreference: number;
  positionMs: Record<string, number>;
  preferenceMs: Record<'first' | 'second' | 'backup' | 'other' | 'unknown', number>;
  minutesPerPlayedAppearance: number | null;
  games: AttendanceSummary;
  training: AttendanceSummary;
  gameRecords: { eventId: string; eventType: 'game'; heldDate: string; eventStatus: MatchRecord['status']; selection: 'selected'; actualAttendance: Attendance; excusedStatus: 'excused' | null; availabilityResponse: 'available' | 'unavailable' | 'unsure' | 'no_reply' | null; correctionProvenance: { recordRevision: number; sourceMatchRevision: number | null; updatedAt: string; sourcePreparationRevision: number | null; sourcePreparationCommandId: string | null } }[];
  trainingRecords: { eventId: string; eventType: 'training'; heldDate: string; eventStatus: 'held'; expected: true; actualAttendance: Attendance; excusedStatus: 'excused' | null; availabilityResponse: 'available' | 'unavailable' | 'unsure' | 'no_reply' | null; correctionProvenance: { sourcePreparationRevision: number | null; sourcePreparationCommandId: string | null } }[];
  coverageLabel: string;
  evidenceState: 'complete' | 'partial' | 'review_required';
}
export function selectParticipationReport(state: RecordsState, match: MatchState | null, viewer: RecordsViewer) {
  const recordedAt = [latestRecordTime(state), observedMatchTime(match)].filter((item): item is string => item !== null).sort((a, b) => Date.parse(a) - Date.parse(b));
  const metadata = { reportType: 'season_participation' as const, clubId: state.clubId, teamId: state.teamId, seasonId: state.seasonId, generatedAt: new Date().toISOString(), asOf: recordedAt.at(-1) ?? null, projectionVersion: state.revision, sourceMatchRevision: match?.revision ?? null, visibilityScope: viewer.actor, appliedFilters: { playerId: viewer.actor === 'player' ? viewer.playerId ?? null : null } };
  if (!inScope(state, viewer) || viewer.actor === 'spectator' || viewer.actor === 'player' && (!viewer.playerId || !state.players.some(player => player.id === viewer.playerId))) return { ...metadata, access: 'denied' as const, reason: 'Named participation and attendance are unavailable for this viewer.', rows: [] as ParticipationReportRow[] };
  const records = reportRecords(state, match).filter(record => record.status === 'completed' || record.recordMode === 'detailed_live' && (record.status === 'incomplete' || record.status === 'abandoned'));
  const players = viewer.actor === 'player' ? state.players.filter(player => player.id === viewer.playerId) : state.players;
  return { ...metadata, access: 'permitted' as const, reason: null, rows: players.map(player => {
    const selected = records.filter(record => record.selectedPlayerIds?.includes(player.id) && record.attendance?.[player.id] !== 'not_selected');
    const evidence = selected.flatMap(record => record.participation?.filter(item => item.playerId === player.id) ?? []);
    const positionMs: Record<string, number> = {};
    for (const entry of evidence) for (const [position, duration] of Object.entries(entry.positionMs)) positionMs[position] = (positionMs[position] ?? 0) + duration;
    const preferenceMs = { first: 0, second: 0, backup: 0, other: 0, unknown: 0 };
    for (const entry of evidence) {
      if (entry.preferenceMs) for (const category of Object.keys(preferenceMs) as (keyof typeof preferenceMs)[]) preferenceMs[category] += entry.preferenceMs[category];
      else preferenceMs.unknown += entry.playedMs;
    }
    const playingMs = evidence.reduce((sum, entry) => sum + entry.playedMs, 0);
    const goalkeeperMs = positionMs.GK ?? 0;
    const games = attendanceSummary(selected.map(record => record.attendance?.[player.id] ?? 'not_recorded'));
    const trainingEvidence = state.trainingAttendance.filter(item => item.eventStatus === 'held' && item.expectedPlayerIds.includes(player.id));
    const training = attendanceSummary(trainingEvidence.map(item => item.attendance[player.id] ?? 'not_recorded'));
    const matchesPlayed = evidence.filter(entry => entry.playedMs > 0).length;
    const unknown = records.filter(record => record.selectedPlayerIds === null).length;
    return {
      playerId: player.id, label: player.label, matchesSelected: selected.length,
      unknownHistoricalSelectionCount: unknown, matchesWithParticipationRecorded: evidence.length, matchesWithAttendanceRecorded: games.attendanceRecordedCount, matchesPlayed,
      matchesAttended: games.attendedCount, playingMs, goalkeeperMs, outfieldMs: playingMs - goalkeeperMs,
      nonPrimaryGoalkeeperMs: evidence.filter(entry => entry.primaryWasGoalkeeper === false).reduce((sum, entry) => sum + (entry.positionMs.GK ?? 0), 0),
      goalkeeperMsWithUnknownPrimaryPreference: evidence.filter(entry => entry.primaryWasGoalkeeper === null).reduce((sum, entry) => sum + (entry.positionMs.GK ?? 0), 0),
      goalkeeperMsWithKnownPrimaryPreference: evidence.filter(entry => entry.primaryWasGoalkeeper !== null).reduce((sum, entry) => sum + (entry.positionMs.GK ?? 0), 0),
      positionMs, preferenceMs, minutesPerPlayedAppearance: matchesPlayed ? playingMs / matchesPlayed / 60_000 : null, games, training,
      gameRecords: selected.map(record => {
        const preparation = state.gamePreparation?.find(item => item.matchId === record.id);
        const actualAttendance = record.attendance?.[player.id] ?? 'not_recorded';
        return { eventId: record.id, eventType: 'game' as const, heldDate: record.playedDate, eventStatus: record.status, selection: 'selected' as const, actualAttendance, excusedStatus: actualAttendance === 'excused' ? 'excused' as const : null, availabilityResponse: preparation?.responses[player.id] ?? null,
          correctionProvenance: { recordRevision: record.revision, sourceMatchRevision: record.sourceMatchRevision, updatedAt: record.updatedAt, sourcePreparationRevision: preparation?.sourcePreparationRevision ?? null, sourcePreparationCommandId: preparation?.sourceCommandId ?? null } };
      }),
      trainingRecords: trainingEvidence.map(item => ({ eventId: item.sessionId, eventType: 'training' as const, heldDate: item.playedDate, eventStatus: 'held' as const, expected: true as const, actualAttendance: item.attendance[player.id] ?? 'not_recorded', excusedStatus: item.attendance[player.id] === 'excused' ? 'excused' as const : null, availabilityResponse: item.responses?.[player.id] ?? null, correctionProvenance: { sourcePreparationRevision: item.sourcePreparationRevision ?? null, sourcePreparationCommandId: item.sourceCommandId ?? null } })),
      coverageLabel: `Minutes recorded for ${evidence.length} of ${records.length} recorded games; ${unknown} historical squad${unknown === 1 ? '' : 's'} not recorded.`,
      evidenceState: selected.some(record => record.detailCompleteness === 'review_required') ? 'review_required' as const : unknown || selected.length !== evidence.length ? 'partial' as const : 'complete' as const,
    };
  }) };
}

export function selectMatchReport(state: RecordsState, matchId: string, viewer: RecordsViewer, currentMatch: MatchState | null = null) {
  if (!inScope(state, viewer)) return null;
  const record = reportRecords(state, currentMatch).find(item => item.id === matchId);
  if (!record) return null;
  const shared = canShare(record, viewer.actor);
  const base = {
    matchId: record.id, playedDate: record.playedDate, opponent: record.opponent, status: record.status,
    clubId: state.clubId, teamId: state.teamId, seasonId: state.seasonId, projectionVersion: state.revision, sourceMatchRevision: record.sourceMatchRevision,
    asOf: currentMatch?.config.matchId === matchId ? observedMatchTime(currentMatch) : record.updatedAt, generatedAt: new Date().toISOString(), reportType: 'match' as const,
    policyId: record.publication.id, policyVersion: record.publication.version, classificationVersion: record.classificationVersion, fixtureClass: record.fixtureClass,
    appliedFilters: { matchId, playerId: viewer.actor === 'player' ? viewer.playerId ?? null : null }, visibilityScope: viewer.actor,
    recordMode: record.recordMode, detailCompleteness: record.detailCompleteness, revision: record.revision,
    score: shared ? clone(record.finalScore) : null, halfTimeScore: shared ? clone(record.halfTimeScore) : null,
    goals: shared ? clone(record.goals) : [],
    unassignedGoalsFor: shared && record.finalScore ? record.finalScore.for - record.goals.filter(goal => goal.beneficiary === 'us').length : null,
    unassignedGoalsAgainst: shared && record.finalScore ? record.finalScore.against - record.goals.filter(goal => goal.beneficiary === 'opposition').length : null,
    suppressionReason: shared ? null : 'Scores are not shared for this competition.', awardStatus: record.awardStatus,
  };
  if (viewer.actor === 'spectator') return base;
  const eligible = viewer.actor === 'manager' ? state.players.map(player => player.id) : viewer.playerId ? [viewer.playerId] : [];
  return { ...base, actualActiveDurationMs: record.actualActiveDurationMs,
    keeperPolicy: record.keeperPolicy,
    participation: record.participation?.filter(item => eligible.includes(item.playerId)).map(clone) ?? null,
    attendance: record.attendance ? Object.fromEntries(Object.entries(record.attendance).filter(([id]) => eligible.includes(id))) : null,
  };
}
