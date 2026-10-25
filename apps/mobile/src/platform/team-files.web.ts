export interface PickedTeamFile {
  name: string;
  bytes: Uint8Array;
  mimeType: string;
}
export async function pickTeamFile(
  kind: "xls" | "pdf",
): Promise<PickedTeamFile | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept =
      kind === "xls" ? ".xls,application/vnd.ms-excel" : ".pdf,application/pdf";
    input.oncancel = () => resolve(null);
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      if (file.size > (kind === "xls" ? 2 : 5) * 1024 * 1024) {
        reject(new Error("The selected file is too large."));
        return;
      }
      void file
        .arrayBuffer()
        .then((b) =>
          resolve({
            name: file.name,
            bytes: new Uint8Array(b),
            mimeType: file.type,
          }),
        )
        .catch(reject);
    };
    input.click();
  });
}
export async function deliverTeamFile(file: PickedTeamFile): Promise<void> {
  const url = URL.createObjectURL(
    new Blob([file.bytes.slice().buffer], { type: file.mimeType }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
