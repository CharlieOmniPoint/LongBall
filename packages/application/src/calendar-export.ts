/** Calendar files contain selected schedule fields only, never roster or results. */
export interface CalendarEvent {
  id: string;
  kind: "match" | "training";
  date: string;
  time: string | null;
  venue: string;
}
export interface CalendarSchedule {
  fixtures: {
    id: string;
    seasonId?: string;
    playedDate: string;
    kickoff: string | null;
    venue: string;
    status: string;
  }[];
  training: {
    id: string;
    seasonId?: string;
    date: string;
    time: string | null;
    venue: string;
    status: string;
  }[];
}
export interface CalendarArtifact {
  fileName: string;
  contentType: "text/calendar; charset=utf-8";
  body: string;
}
const dateValid = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(new Date(`${value}T00:00:00Z`).getTime()) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export function londonDate(nowMs: number): string {
  if (!Number.isFinite(nowMs)) throw new Error("A current time is required.");
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(nowMs);
  return `${parts.find((part) => part.type === "year")!.value}-${parts.find((part) => part.type === "month")!.value}-${parts.find((part) => part.type === "day")!.value}`;
}
function utcInstant(date: string, time: string): number {
  if (!dateValid(date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw new Error("An event has an invalid date or time.");
  const wall = Date.parse(`${date}T${time}:00Z`);
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const matches = [wall, wall - 3_600_000].filter((instant) => {
    const parts = formatter.formatToParts(instant),
      part = (name: Intl.DateTimeFormatPartTypes) =>
        parts.find((item) => item.type === name)?.value;
    return (
      `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}` ===
      `${date}T${time}`
    );
  });
  if (matches.length !== 1)
    throw new Error(
      "This local time falls in a daylight-saving clock change. Review the event time before exporting it.",
    );
  return matches[0];
}
export function calendarEventsFromSchedule(
  schedule: CalendarSchedule,
  seasonId: string,
  nowMs: number,
): CalendarEvent[] {
  const today = londonDate(nowMs);
  const events: CalendarEvent[] = [
    ...schedule.fixtures
      .filter(
        (item) =>
          (!item.seasonId || item.seasonId === seasonId) &&
          item.status === "scheduled",
      )
      .map((item) => ({
        id: item.id,
        kind: "match" as const,
        date: item.playedDate,
        time: item.kickoff,
        venue: item.venue,
      })),
    ...schedule.training
      .filter(
        (item) =>
          (!item.seasonId || item.seasonId === seasonId) &&
          item.status === "scheduled",
      )
      .map((item) => ({
        id: item.id,
        kind: "training" as const,
        date: item.date,
        time: item.time,
        venue: item.venue,
      })),
  ];
  return events
    .filter(
      (event) =>
        dateValid(event.date) &&
        event.date >= today &&
        (event.time === null ||
          (() => {
            try {
              return utcInstant(event.date, event.time) >= nowMs;
            } catch {
              return true;
            }
          })()),
    )
    .sort(
      (left, right) =>
        left.date.localeCompare(right.date) ||
        (left.time ?? "99:99").localeCompare(right.time ?? "99:99") ||
        left.id.localeCompare(right.id),
    );
}
export const calendarEventKey = (event: Pick<CalendarEvent, "kind" | "id">) =>
  `${event.kind}:${event.id}`;
const text = (value: string) =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
const bytes = (value: string) =>
  [...value].reduce(
    (size, character) =>
      size +
      (character.codePointAt(0)! <= 0x7f
        ? 1
        : character.codePointAt(0)! <= 0x7ff
          ? 2
          : character.codePointAt(0)! <= 0xffff
            ? 3
            : 4),
    0,
  );
function fold(value: string): string {
  const lines: string[] = [];
  let line = "";
  for (const character of value) {
    if (bytes(line + character) > 75) {
      lines.push(line);
      line = " ";
    }
    line += character;
  }
  lines.push(line);
  return lines.join("\r\n");
}
const instant = (value: number) =>
  new Date(value)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
export function buildCalendarExport(input: {
  teamId: string;
  seasonId: string;
  events: CalendarEvent[];
  selectedKeys: string[];
  nowMs: number;
}): CalendarArtifact {
  if (
    !input.teamId ||
    !input.seasonId ||
    input.events.length > 1000 ||
    input.selectedKeys.length < 1 ||
    input.selectedKeys.length > 200 ||
    new Set(input.selectedKeys).size !== input.selectedKeys.length ||
    !Number.isFinite(input.nowMs)
  )
    throw new Error("Select between one and 200 current schedule events.");
  const available = new Map(
    input.events.map((event) => [calendarEventKey(event), event]),
  );
  if (available.size !== input.events.length)
    throw new Error(
      "The schedule contains duplicate event identities. Refresh before exporting.",
    );
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//LongBall//Selected schedule//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  for (const key of input.selectedKeys) {
    const event = available.get(key);
    if (
      !event ||
      !dateValid(event.date) ||
      event.date < londonDate(input.nowMs) ||
      !["match", "training"].includes(event.kind) ||
      typeof event.venue !== "string" ||
      event.venue.length > 300
    )
      throw new Error(
        "A selected event is no longer available. Refresh and select it again.",
      );
    const start =
      event.time === null
        ? `DTSTART;VALUE=DATE:${event.date.replace(/-/g, "")}`
        : `DTSTART:${instant(utcInstant(event.date, event.time))}`;
    if (event.time !== null && utcInstant(event.date, event.time) < input.nowMs)
      throw new Error(
        "A selected event has already started. Refresh your selection.",
      );
    const uid = `${encodeURIComponent(input.teamId)}:${encodeURIComponent(input.seasonId)}:${encodeURIComponent(key)}@longball.invalid`;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${instant(input.nowMs)}`,
      start,
      `SUMMARY:${event.kind === "match" ? "Team match" : "Team training"}`,
      `LOCATION:${text(event.venue)}`,
      `DESCRIPTION:${text(`${event.time === null ? "Time not recorded. Date-only entry." : "Scheduled time recorded in Europe/London. End time not recorded."} Exported LongBall copy; future changes do not update this file automatically.`)}`,
      "STATUS:CONFIRMED",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return {
    fileName: "longball-calendar.ics",
    contentType: "text/calendar; charset=utf-8",
    body: lines.map(fold).join("\r\n") + "\r\n",
  };
}
