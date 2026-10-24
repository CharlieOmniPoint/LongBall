export interface TeamOverviewGame {
  id: string;
  opponent: string;
  playedDate: string;
  kickoff?: string | null;
  venue?: string | null;
  status: string;
  active?: boolean;
}
export type TeamOverviewSelection = {
  game: TeamOverviewGame | null;
  reason: 'active_today' | 'scheduled_today' | 'next_fixture' | 'none';
  uncertain: boolean;
  notice: string | null;
};
const activeStatuses = new Set(['first_half_running', 'first_half_paused', 'half_time', 'second_half_running', 'second_half_paused']);
const excludedStatuses = new Set(['cancelled', 'canceled', 'deleted', 'completed', 'abandoned']);
const status = (game: TeamOverviewGame) => game.status.trim().toLowerCase();
function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function time(value: string | null | undefined): number {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : Number.POSITIVE_INFINITY;
}
export function teamOverviewLondonDate(nowMs: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs));
  return `${parts.find(part => part.type === 'year')!.value}-${parts.find(part => part.type === 'month')!.value}-${parts.find(part => part.type === 'day')!.value}`;
}
export function teamOverviewStatusLabel(game: TeamOverviewGame): string {
  const labels: Record<string, string> = { scheduled: 'Scheduled', preparation: 'Preparation', postponed: 'Postponed', first_half_running: 'Last recorded: first half', first_half_paused: 'Last recorded: first half paused', half_time: 'Last recorded: half-time', second_half_running: 'Last recorded: second half', second_half_paused: 'Last recorded: second half paused' };
  return labels[status(game)] ?? (game.active ? 'Active saved game' : 'Status to be confirmed');
}
/** Selects from safe team summaries; no date implies attendance, kickoff or a completed result. */
export function selectTeamOverviewGame(games: readonly TeamOverviewGame[], today: string): TeamOverviewSelection {
  if (!validDate(today)) throw new Error('Use a valid London calendar date for the team overview.');
  const rank = (game: TeamOverviewGame) => excludedStatuses.has(status(game)) ? 3 : game.active || activeStatuses.has(status(game)) ? 2 : 1;
  const unique = new Map<string, TeamOverviewGame>();
  let conflicting = false;
  for (const game of games) {
    if (!game.id || !game.opponent) continue;
    const previous = unique.get(game.id);
    if (previous && (previous.status !== game.status || previous.playedDate !== game.playedDate || previous.kickoff !== game.kickoff)) conflicting = true;
    if (!previous || rank(game) > rank(previous)) unique.set(game.id, game);
  }
  const eligible = [...unique.values()].filter(game => validDate(game.playedDate) && !excludedStatuses.has(status(game)));
  const compare = (a: TeamOverviewGame, b: TeamOverviewGame) => a.playedDate.localeCompare(b.playedDate) || time(a.kickoff) - time(b.kickoff) || a.id.localeCompare(b.id);
  const activeToday = eligible.filter(game => game.playedDate === today && (game.active === true || activeStatuses.has(status(game)))).sort(compare);
  const scheduledToday = eligible.filter(game => game.playedDate === today && ['scheduled', 'preparation'].includes(status(game))).sort(compare);
  const future = eligible.filter(game => game.playedDate > today).sort(compare);
  const game = activeToday[0] ?? scheduledToday[0] ?? future[0] ?? null;
  const reason = activeToday.length ? 'active_today' : scheduledToday.length ? 'scheduled_today' : game ? 'next_fixture' : 'none';
  let notice: string | null = null;
  if (conflicting || activeToday.length > 1) notice = 'Some saved game summaries disagree. Open the game to check its current details.';
  else if (game && game.playedDate !== today && (game.active || activeStatuses.has(status(game)))) notice = 'This game has an active saved status on another date. Confirm its fixture details.';
  else if (game && status(game) === 'postponed') notice = 'This fixture is postponed. Its date and time need confirmation.';
  else if (game && !activeStatuses.has(status(game)) && !['scheduled', 'preparation'].includes(status(game))) notice = 'The fixture status needs confirmation. Open the game for the latest details.';
  else if (game && !Number.isFinite(time(game.kickoff))) notice = 'Kick-off time has not been recorded.';
  else if (!game && games.some(item => !validDate(item.playedDate))) notice = 'Some games need a confirmed date before they can appear here.';
  return { game: game ? { ...game } : null, reason, uncertain: notice !== null, notice };
}
