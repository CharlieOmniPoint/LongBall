import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { randomUUID } from "./id";

export interface ReportArtifact {
  fileName: string;
  contentType: string;
  body: string;
}
export async function deliverReportExport(
  artifact: ReportArtifact,
  assertAccess: () => Promise<void>,
): Promise<string> {
  if (
    !/^[A-Za-z0-9_.-]{1,120}\.(json|csv)$/.test(artifact.fileName) ||
    artifact.body.length > 5_000_000 ||
    !["application/json", "text/csv"].includes(
      artifact.contentType.split(";")[0],
    )
  )
    throw new Error("The service export file is invalid.");
  if (!(await Sharing.isAvailableAsync()))
    throw new Error("This device has no available file-sharing destination.");
  await assertAccess();
  const directory = new Directory(Paths.cache, "longball-report-exports");
  directory.create({ idempotent: true });
  const extension = artifact.fileName.endsWith(".csv") ? "csv" : "json";
  const file = new File(directory, `report-${randomUUID()}.${extension}`);
  try {
    file.create();
    await file.write(artifact.body);
    await assertAccess();
    await Sharing.shareAsync(file.uri, {
      dialogTitle: "Export permitted LongBall report",
      mimeType: artifact.contentType.split(";")[0],
      UTI:
        extension === "csv"
          ? "public.comma-separated-values-text"
          : "public.json",
    });
    return "The share sheet closed. The app’s temporary export was removed; any copy you saved is outside LongBall.";
  } finally {
    if (file.exists) file.delete();
  }
}
