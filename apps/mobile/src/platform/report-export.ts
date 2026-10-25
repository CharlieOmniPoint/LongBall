import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { randomUUID } from "./id";

import { reportArtifactBytes, type ReportArtifact } from "./report-export-artifact";
export type { ReportArtifact } from "./report-export-artifact";
export async function deliverReportExport(
  artifact: ReportArtifact,
  assertAccess: () => Promise<void>,
): Promise<string> {
  const { bytes, extension, mimeType } = reportArtifactBytes(artifact);
  if (!(await Sharing.isAvailableAsync()))
    throw new Error("This device has no available file-sharing destination.");
  await assertAccess();
  const directory = new Directory(Paths.cache, "longball-report-exports");
  directory.create({ idempotent: true });
  const file = new File(directory, `report-${randomUUID()}.${extension}`);
  try {
    file.create();
    await file.write(bytes);
    await assertAccess();
    await Sharing.shareAsync(file.uri, {
      dialogTitle: "Export permitted LongBall report",
      mimeType,
      UTI: extension === "pdf" ? "com.adobe.pdf" : extension === "csv" ? "public.comma-separated-values-text" : "public.json",
    });
    return "The share sheet closed. The app’s temporary export was removed; any copy you saved is outside LongBall.";
  } finally {
    if (file.exists) file.delete();
  }
}
