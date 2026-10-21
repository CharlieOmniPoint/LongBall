import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import type { CalendarArtifact } from "@longball/application/calendar-export";
import { randomUUID } from "./id";

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
  if (!(await Sharing.isAvailableAsync()))
    throw new Error("This device has no available file-sharing destination.");
  await assertAccess();
  const directory = new Directory(Paths.cache, "longball-calendar-exports");
  directory.create({ idempotent: true });
  const file = new File(directory, `calendar-${randomUUID()}.ics`);
  try {
    file.create();
    await file.write(artifact.body);
    await assertAccess();
    await Sharing.shareAsync(file.uri, {
      dialogTitle: "Export selected LongBall events",
      mimeType: "text/calendar",
      UTI: "com.apple.ical.ics",
    });
    return "The share sheet closed. The app’s temporary calendar was removed; any copy you saved is outside LongBall and does not update automatically.";
  } finally {
    if (file.exists) file.delete();
  }
}
