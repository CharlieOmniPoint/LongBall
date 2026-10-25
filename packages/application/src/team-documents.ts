export interface TeamDocumentMetadata {
  fileName: string;
  byteLength: number;
  sha256: string;
  updatedAtMs: number;
}
export interface TeamDocumentView {
  kind: "team-document";
  teamId: string;
  revision: number;
  document: TeamDocumentMetadata | null;
}
export interface TeamDocumentDownload extends TeamDocumentView {
  base64: string;
}
export type TeamDocumentCommand = { id: string; expectedRevision: number } & (
  | { type: "team_sheet.uploaded"; fileName: string; base64: string }
  | { type: "team_sheet.removed" }
);
export function assertTeamDocumentView(
  value: unknown,
  teamId: string,
): asserts value is TeamDocumentView {
  if (!value || typeof value !== "object")
    throw new Error("The team sheet response is unavailable.");
  const v = value as TeamDocumentView;
  if (
    v.kind !== "team-document" ||
    v.teamId !== teamId ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 0
  )
    throw new Error("The team sheet response does not match this team.");
  if (
    v.document &&
    (typeof v.document.fileName !== "string" ||
      v.document.fileName.length > 120 ||
      !Number.isSafeInteger(v.document.byteLength) ||
      v.document.byteLength < 1 ||
      v.document.byteLength > 5 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(v.document.sha256) ||
      !Number.isSafeInteger(v.document.updatedAtMs))
  )
    throw new Error("The saved team sheet metadata is invalid.");
}
