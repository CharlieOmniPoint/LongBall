import { File, Directory, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { randomUUID } from "./id";
export interface PickedTeamFile {
  name: string;
  bytes: Uint8Array;
  mimeType: string;
}
export async function pickTeamFile(
  kind: "xls" | "pdf",
): Promise<PickedTeamFile | null> {
  const chosen = await File.pickFileAsync(
    undefined,
    kind === "xls" ? "application/vnd.ms-excel" : "application/pdf",
  );
  const file = Array.isArray(chosen) ? chosen[0] : chosen;
  if (!file) return null;
  if (file.size > (kind === "xls" ? 2 : 5) * 1024 * 1024)
    throw new Error("The selected file is too large.");
  return {
    name: file.name,
    bytes: await file.bytes(),
    mimeType: kind === "xls" ? "application/vnd.ms-excel" : "application/pdf",
  };
}
export async function deliverTeamFile(file: PickedTeamFile): Promise<void> {
  if (!(await Sharing.isAvailableAsync()))
    throw new Error("File sharing is unavailable on this device.");
  const directory = new Directory(Paths.cache, "longball-team-files");
  directory.create({ idempotent: true });
  const target = new File(
    directory,
    `${randomUUID()}-${file.name.replace(/[^A-Za-z0-9_.-]/g, "-")}`,
  );
  try {
    target.create();
    target.write(file.bytes);
    await Sharing.shareAsync(target.uri, {
      mimeType: file.mimeType,
      dialogTitle: "LongBall team file",
    });
  } finally {
    if (target.exists) target.delete();
  }
}
