/** Calendar values stay ISO in storage; only presentation uses UK short years. */
export const UK_TIME_ZONE = 'Europe/London';

export function formatUkDate(value: string | null | undefined): string {
  if (!value) return 'Date to confirm';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Date to confirm';
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: UK_TIME_ZONE }).format(date);
}

export function formatUkDateTime(value: string | number | null | undefined, options?: { seconds?: boolean }): string {
  if (value == null) return 'Time to confirm';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Time to confirm';
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', ...(options?.seconds ? { second: '2-digit' as const } : {}), hourCycle: 'h23', timeZone: UK_TIME_ZONE }).format(date);
}

export function formatUkSeasonLabel(value: string): string {
  return value.replace(/\b(?:19|20)(\d{2})\b/g, '$1');
}

export function londonDateKey(now: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: UK_TIME_ZONE }).formatToParts(new Date(now));
  const part = (kind: string) => parts.find(item => item.type === kind)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
