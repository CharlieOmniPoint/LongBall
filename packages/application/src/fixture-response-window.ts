import { londonDateKey } from './uk-display';

/** RSVP is prospective. A planned kick-off never proves that play has started. */
export function canPlayerReplyToFixture(
  fixture: { playedDate: string; status: string },
  nowMs: number,
  context: { recordedStatus?: string | null } = {},
): boolean {
  if (fixture.status !== 'scheduled' || !Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isFinite(new Date(nowMs).getTime())) return false;
  if (context.recordedStatus != null && context.recordedStatus !== 'preparation') return false;
  const date = fixture.playedDate;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000-')) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return false;
  return date >= londonDateKey(nowMs);
}
