import { reportArtifactBytes, type ReportArtifact } from "./report-export-artifact";
export type { ReportArtifact } from "./report-export-artifact";
export async function deliverReportExport(
  artifact: ReportArtifact,
  assertAccess: () => Promise<void>,
): Promise<string> {
  const { bytes, mimeType } = reportArtifactBytes(artifact);
  await assertAccess();
  const blob = new Blob([bytes.buffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = artifact.fileName;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
  return "The permitted report download started. The saved copy is outside LongBall.";
}
