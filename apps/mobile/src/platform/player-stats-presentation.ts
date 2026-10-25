import type { PositionStats } from "@longball/application/player-stats";

/** Current declared preferences, separate from accepted historical playing time. */
export interface PlayerStatsCorePositions {
  playerId: string;
  primary: string | null;
  secondary: string | null;
}
export type StatsPositionPreference = "primary" | "secondary" | null;

/** Keep small positive shares visibly distinct from a true zero. */
export function formatStatsPositionPercentage(
  percentage: number | null | undefined,
  unavailable = "—",
): string {
  if (percentage == null || !Number.isFinite(percentage)) return unavailable;
  return percentage > 0 && percentage < 0.1
    ? "<0.1%"
    : `${percentage.toFixed(1)}%`;
}

/** A rounded display value is insufficient evidence that a position has no time. */
export function isRecordedZeroPosition(
  position: Pick<PositionStats, "playingMs" | "percentage"> | undefined,
): boolean {
  return position?.playingMs === 0 && position.percentage === 0;
}

export function statsPositionPreference(
  code: string,
  core: PlayerStatsCorePositions | undefined,
): StatsPositionPreference {
  if (code && core?.primary === code) return "primary";
  if (code && core?.secondary === code) return "secondary";
  return null;
}

export function statsCorePositionsOutsideLayout(
  core: PlayerStatsCorePositions | undefined,
  codes: ReadonlySet<string>,
): { rank: Exclude<StatsPositionPreference, null>; code: string }[] {
  if (!core) return [];
  const missing: {
    rank: Exclude<StatsPositionPreference, null>;
    code: string;
  }[] = [];
  for (const rank of ["primary", "secondary"] as const) {
    const code = core[rank];
    if (code && !codes.has(code) && !missing.some((row) => row.code === code))
      missing.push({ rank, code });
  }
  return missing;
}
