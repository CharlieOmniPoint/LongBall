import type { MatchState } from '../../domain/src/types';
import type { getCommunityView } from './community';
import { activePositionCodes, type PreparationFixture, type PreparationState } from './preparation';
import type { selectSeasonResults } from './records';

export type ManagerHomeResults = Pick<ReturnType<typeof selectSeasonResults>, 'teamId' | 'seasonId' | 'visibilityScope' | 'rows'>;
export interface ManagerHomeRecords { results: ManagerHomeResults; activeMatch?: MatchState | null }
export type ManagerHomeCommunity = Pick<ReturnType<typeof getCommunityView>, 'allowed' | 'reviewQueue' | 'reviewConcerns'>;
export interface ManagerHomeEvent {
  id: string;
  kind: 'match' | 'training';
  title: string;
  date: string | null;
  time: string | null;
  venue: string | null;
  selectedCount: number;
  unansweredReplies: number;
  unrecordedCheckIns: number;
  prepared: boolean;
}
export type ManagerHomeResult = ManagerHomeResults['rows'][number];
const validTime = (value: string | null | undefined): value is string => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
function dayInTeamTime(nowMs: number, timeZone: string): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('A valid observation time is required for the manager home.');
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs));
  return `${parts.find(item => item.type === 'year')!.value}-${parts.find(item => item.type === 'month')!.value}-${parts.find(item => item.type === 'day')!.value}`;
}
function countMissing(expected: string[], values: Record<string, string>): number {
  return new Set(expected.filter(id => !values[id] || values[id] === 'no_reply')).size;
}
function missingAttendance(expected: string[], values: Record<string, string>): number {
  return new Set(expected.filter(id => !values[id] || values[id] === 'not_recorded')).size;
}
function fixtureEvent(fixture: PreparationFixture, state: PreparationState, activeIds: string[]): ManagerHomeEvent {
  return {
    id: fixture.id, kind: 'match', title: fixture.opponent ? `vs ${fixture.opponent}` : 'Match · opposition not recorded',
    date: validDate(fixture.playedDate) ? fixture.playedDate : null,
    time: validTime(fixture.kickoff) ? fixture.kickoff : null,
    venue: fixture.venue.trim() || null, selectedCount: new Set(fixture.selectedProfileIds).size,
    unansweredReplies: countMissing(activeIds, fixture.responses), unrecordedCheckIns: missingAttendance(fixture.selectedProfileIds, fixture.attendance),
    prepared: state.snapshots.some(item => item.fixtureId === fixture.id && item.seasonId === fixture.seasonId),
  };
}
function sameDayOrderUnknown(rows: ManagerHomeResult[]): boolean {
  return rows.some((row, index) => rows.some((other, otherIndex) => index !== otherIndex && row.playedDate === other.playedDate &&
    !(row.recordedKickoff && other.recordedKickoff) && (row.sameDayOrder === null || other.sameDayOrder === null || row.sameDayOrder === other.sameDayOrder)));
}
function recentResults(rows: ManagerHomeResult[], today: string): ManagerHomeResult[] {
  const completed = rows.filter(item => item.status === 'completed' && validDate(item.playedDate) && item.playedDate <= today);
  return [...completed].sort((left, right) => right.playedDate.localeCompare(left.playedDate) ||
    (left.recordedKickoff && right.recordedKickoff ? Date.parse(right.recordedKickoff) - Date.parse(left.recordedKickoff) : (right.sameDayOrder ?? 0) - (left.sameDayOrder ?? 0)) || left.id.localeCompare(right.id));
}
/** Selects already-authorised manager data. It never creates a date, attendance fact or sharing permission. */
export function selectManagerHome(input: { state: PreparationState; records: ManagerHomeRecords | null; community: ManagerHomeCommunity | null; nowMs: number; timeZone?: string }) {
  const { state } = input;
  const timeZone = input.timeZone ?? 'Europe/London';
  const today = dayInTeamTime(input.nowMs, timeZone);
  const seasonId = state.activeSeasonId;
  const activePlayers = state.profiles.filter(item => item.seasonId === seasonId && item.active);
  const activeIds = activePlayers.map(item => item.id);
  const records = input.records?.results.visibilityScope === 'manager' && input.records.results.teamId === state.team.id && input.records.results.seasonId === seasonId ? input.records : null;
  const completedIds = new Set(records?.results.rows.filter(item => ['completed', 'abandoned', 'cancelled'].includes(item.status)).map(item => item.id) ?? []);
  const active = records?.activeMatch;
  const resumable = active && !['preparation', 'completed', 'abandoned'].includes(active.status)
    ? { matchId: active.config.matchId, status: active.status, score: { ...active.score } } : null;
  const fixtures = state.fixtures.filter(item => item.seasonId === seasonId && item.status === 'scheduled' && !completedIds.has(item.id));
  const training = state.training.filter(item => item.seasonId === seasonId && item.status === 'scheduled');
  const events: ManagerHomeEvent[] = [
    ...fixtures.map(item => fixtureEvent(item, state, activeIds)),
    ...training.map(item => ({
      id: item.id, kind: 'training' as const, title: 'Team training', date: validDate(item.date) ? item.date : null,
      time: validTime(item.time) ? item.time : null, venue: item.venue.trim() || null,
      selectedCount: new Set(item.expectedProfileIds).size, unansweredReplies: countMissing(item.expectedProfileIds, item.responses),
      unrecordedCheckIns: missingAttendance(item.expectedProfileIds, item.attendance), prepared: false,
    })),
  ];
  const upcoming = events.filter(item => item.date !== null && item.date >= today && item.id !== resumable?.matchId)
    .sort((left, right) => left.date!.localeCompare(right.date!) || (left.time && right.time ? left.time.localeCompare(right.time) : 0));
  const earliest = upcoming[0]?.date;
  const sameDay = earliest ? upcoming.filter(item => item.date === earliest) : [];
  const unknownTime = sameDay.some(item => item.time === null);
  const firstTime = unknownTime ? null : sameDay[0]?.time;
  const nextCandidates = unknownTime ? sameDay : sameDay.filter(item => item.time === firstTime);
  const next = nextCandidates.length === 1 ? nextCandidates[0] : null;
  const needsOrdering = nextCandidates.length > 1;
  const undated = events.filter(item => item.date === null);
  const olderUnresolved = events.filter(item => item.date !== null && item.date < today && item.id !== resumable?.matchId);
  const repliesDue = [...upcoming, ...undated].reduce((sum, item) => sum + item.unansweredReplies, 0);
  const fixtureCheckInsDue = fixtures.filter(item => validDate(item.playedDate) && item.playedDate <= today)
    .reduce((sum, item) => sum + missingAttendance(item.selectedProfileIds, item.attendance), 0);
  const trainingCheckInsDue = state.training.filter(item => item.seasonId === seasonId && item.status === 'held')
    .reduce((sum, item) => sum + missingAttendance(item.expectedProfileIds, item.attendance), 0);
  const activePositions = activePositionCodes(state);
  const missingPreferences = activePlayers.filter(item => item.preferences.length !== 3 || new Set(item.preferences).size !== 3 || item.preferences.some(position => !activePositions.includes(position))).length;
  const recent = recentResults(records?.results.rows ?? [], today);
  const latestDay = recent[0]?.playedDate;
  const latestDayRows = latestDay ? recent.filter(item => item.playedDate === latestDay) : [];
  const recentOrderUnknown = sameDayOrderUnknown(latestDayRows);
  const recentVisible = recentOrderUnknown ? latestDayRows : recent.slice(0, 3);
  return {
    today, timeZone, next, nextCandidates, needsOrdering, upcoming, undated, olderUnresolved,
    resumable, repliesDue, attendanceToRecord: fixtureCheckInsDue + trainingCheckInsDue, missingPreferences,
    photoReviews: input.community?.allowed ? input.community.reviewQueue.length : null,
    concernsToReview: input.community?.allowed ? input.community.reviewConcerns.filter(item => ['submitted', 'under_review'].includes(item.status)).length : null,
    recordsAvailable: records !== null, recentResults: recentVisible, recentOrderUnknown,
  };
}
