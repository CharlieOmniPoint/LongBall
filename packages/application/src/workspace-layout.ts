import type { Role } from "./access";

export type WorkspaceLayoutPreference = "auto" | "phone" | "tablet";
export type WorkspaceLayoutMode = "phone" | "tablet";
export function parseWorkspaceLayoutPreference(
  value: unknown,
): WorkspaceLayoutPreference {
  return value === "phone" || value === "tablet" ? value : "auto";
}
export const staffLayoutRole = (
  role: Role | null | undefined,
): role is "manager" | "administrator" =>
  role === "manager" || role === "administrator";
/** Presentation only: a saved preference is never evidence of a role or permission. */
export function resolveWorkspaceLayout(input: {
  role: Role | null;
  preference: WorkspaceLayoutPreference;
  width: number;
  height: number;
  fontScale?: number;
  contentWidth?: number;
}) {
  const width = Math.max(0, Number.isFinite(input.width) ? input.width : 0);
  const height = Math.max(0, Number.isFinite(input.height) ? input.height : 0);
  const fontScale = Math.max(
    1,
    Number.isFinite(input.fontScale) ? input.fontScale! : 1,
  );
  const staff = staffLayoutRole(input.role);
  const autoTablet = width >= 768 && Math.min(width, height) >= 600;
  const mode: WorkspaceLayoutMode =
    staff &&
    (input.preference === "tablet" ||
      (input.preference === "auto" && autoTablet))
      ? "tablet"
      : "phone";
  const rail =
    mode === "tablet" && width >= 1024 && height >= 600 && fontScale < 1.5;
  const shellWidth = Math.min(width, mode === "tablet" ? 1440 : 632);
  const estimated = Math.max(0, shellWidth - 32 - (rail ? 168 : 0));
  const contentWidth = Math.max(0, input.contentWidth ?? estimated);
  const wide =
    mode === "tablet" &&
    height >= 480 &&
    contentWidth >= 700 * Math.min(fontScale, 1.5);
  return {
    mode,
    preference: input.preference,
    staff,
    rail,
    wide,
    contentWidth,
    shellWidth,
    viewportWidth: width,
    viewportHeight: height,
    fontScale,
  };
}
