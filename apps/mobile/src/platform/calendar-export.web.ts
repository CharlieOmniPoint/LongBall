import type { CalendarArtifact } from "@longball/application/calendar-export";

export async function deliverCalendarExport(
  artifact: CalendarArtifact,
  assertAccess: () => Promise<void>,
): Promise<string> {
  if (
    artifact.fileName !== "longball-calendar.ics" ||
    artifact.contentType !== "text/calendar; charset=utf-8" ||
    artifact.body.length > 1_000_000 ||
    !artifact.body.startsWith("BEGIN:VCALENDAR\r\n") ||
    !artifact.body.endsWith("END:VCALENDAR\r\n")
  )
    throw new Error("The calendar file is invalid.");
  await assertAccess();
  const url = URL.createObjectURL(
    new Blob([artifact.body], { type: artifact.contentType }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = artifact.fileName;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return "The selected calendar download started. Your saved copy is outside LongBall and does not update automatically.";
}
