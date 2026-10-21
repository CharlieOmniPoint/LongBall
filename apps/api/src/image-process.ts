import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
export const IMAGE_REJECTION_MARKER = "IMAGE_DECODE_REJECTED";

/** Only a normal, explicit decoder rejection is evidence about the input. */
export function imageProcessRejected(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const result = error as {
    code?: unknown;
    signal?: unknown;
    killed?: unknown;
    stderr?: unknown;
  };
  return (
    result.code === 1 &&
    result.signal == null &&
    result.killed !== true &&
    typeof result.stderr === "string" &&
    result.stderr.trim() === IMAGE_REJECTION_MARKER
  );
}

/** Internal process seam. Callers supply only server-generated private paths. */
export function executeImageDecoder(
  args: readonly string[],
  timeoutMs: number,
) {
  return executeFile(process.execPath, [...args], {
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
}
