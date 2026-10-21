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
  await assertAccess();
  const blob = new Blob([artifact.body], { type: artifact.contentType });
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
