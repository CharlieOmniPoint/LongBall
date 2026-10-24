import { describe, expect, it } from "vitest";
import {
  buildCalendarExport,
  calendarEventsFromSchedule,
  type CalendarEvent,
} from "./calendar-export";
const nowMs = Date.parse("2026-03-01T12:00:00Z");
const event: CalendarEvent = {
  id: "opaque-event",
  kind: "match",
  date: "2026-03-28",
  time: "10:00",
  venue: "Fictional field",
};
const build = (
  events = [event],
  selectedKeys = events.map((item) => `${item.kind}:${item.id}`),
) =>
  buildCalendarExport({
    teamId: "team",
    seasonId: "season",
    events,
    selectedKeys,
    nowMs,
  });
describe("selected calendar export", () => {
  it("exports UTC times with London DST rather than assuming a fixed offset", () => {
    const artifact = build([
      event,
      { ...event, id: "summer", date: "2026-03-30" },
      { ...event, id: "winter", date: "2026-10-26" },
    ]);
    expect(artifact.body).toContain("DTSTART:20260328T100000Z");
    expect(artifact.body).toContain("DTSTART:20260330T090000Z");
    expect(artifact.body).toContain("DTSTART:20261026T100000Z");
    expect(artifact.body).not.toMatch(/DTEND|DURATION/);
  });
  it("keeps unknown kickoff date-only and refuses ambiguous or nonexistent clock-change times", () => {
    expect(build([{ ...event, time: null }]).body).toContain(
      "DTSTART;VALUE=DATE:20260328",
    );
    for (const date of ["2026-03-29", "2026-10-25"])
      expect(() => build([{ ...event, date, time: "01:30" }])).toThrow(
        /daylight-saving/,
      );
  });
  it("escapes injected content and folds every UTF8 line within75 octets with CRLF only", () => {
    const artifact = build([
      { ...event, venue: "场".repeat(80) + "\nBEGIN:VEVENT;fake,test\\" },
    ]);
    expect(artifact.body).toContain("\\nBEGIN:VEVENT\\;fake\\,test\\\\");
    for (const line of artifact.body.split("\r\n"))
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    expect(artifact.body.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(artifact.fileName).toBe("longball-calendar.ics");
  });
  it("filters past, other-season, held/cancelled/postponed entries without touching replies or attendance", () => {
    const schedule = {
      fixtures: [event, { ...event, id: "past", date: "2026-02-01" }].map(
        (item) => ({
          ...item,
          seasonId: "season",
          playedDate: item.date,
          kickoff: item.time,
          status: "scheduled",
          childName: "PRIVATE CHILD",
          score: "99-0",
        }),
      ),
      training: [
        {
          id: "cancelled",
          seasonId: "season",
          date: "2026-04-01",
          time: "18:00",
          venue: "",
          status: "cancelled",
        },
      ],
    };
    const events = calendarEventsFromSchedule(schedule, "season", nowMs);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toMatch(
      /PRIVATE|99-0|response|attendance/,
    );
    expect(build(events).body).not.toMatch(/PRIVATE|99-0/);
    expect(() => build(events, ["match:missing"])).toThrow(
      /no longer available/,
    );
    expect(() => build(events, [])).toThrow(/Select/);
    expect(() => build([event, event], ["match:opaque-event"])).toThrow(
      /duplicate event/,
    );
  });
});
