import { describe, expect, it } from "vitest";
import {
  formatStatsPositionPercentage,
  isRecordedZeroPosition,
  statsCorePositionsOutsideLayout,
  statsPositionPreference,
} from "./player-stats-presentation";

describe("recorded position emphasis", () => {
  it("distinguishes small positive shares from zero without filling unknown values", () => {
    expect(formatStatsPositionPercentage(0)).toBe("0.0%");
    expect(formatStatsPositionPercentage(0.00001)).toBe("<0.1%");
    expect(formatStatsPositionPercentage(0.0999)).toBe("<0.1%");
    expect(formatStatsPositionPercentage(0.1)).toBe("0.1%");
    expect(formatStatsPositionPercentage(65)).toBe("65.0%");
    expect(formatStatsPositionPercentage(null)).toBe("—");
    expect(formatStatsPositionPercentage(undefined)).toBe("—");
    expect(formatStatsPositionPercentage(null, "Not recorded")).toBe(
      "Not recorded",
    );
  });
  it("mutes only a true recorded zero, preserving unknown and tiny positive time", () => {
    expect(isRecordedZeroPosition({ playingMs: 0, percentage: 0 })).toBe(true);
    expect(isRecordedZeroPosition(undefined)).toBe(false);
    expect(isRecordedZeroPosition({ playingMs: 0, percentage: null })).toBe(
      false,
    );
    expect(isRecordedZeroPosition({ playingMs: 1, percentage: 0.00001 })).toBe(
      false,
    );
    expect(isRecordedZeroPosition({ playingMs: 1, percentage: 0 })).toBe(false);
    expect(isRecordedZeroPosition({ playingMs: 1, percentage: 1 })).toBe(false);
  });
});

describe("declared core positions", () => {
  const core = { playerId: "player", primary: "LW", secondary: "CM" };
  it("identifies declared ranks without deriving preferences from playing time", () => {
    expect(statsPositionPreference("LW", core)).toBe("primary");
    expect(statsPositionPreference("CM", core)).toBe("secondary");
    expect(statsPositionPreference("GK", core)).toBeNull();
    expect(statsPositionPreference("LW", undefined)).toBeNull();
    expect(
      statsPositionPreference("LW", {
        ...core,
        primary: null,
        secondary: null,
      }),
    ).toBeNull();
    expect(statsPositionPreference("LW", { ...core, secondary: "LW" })).toBe(
      "primary",
    );
  });
  it("reports preferences absent from a layout without inventing a map slot", () => {
    expect(
      statsCorePositionsOutsideLayout(core, new Set(["GK", "CM", "ST"])),
    ).toEqual([{ rank: "primary", code: "LW" }]);
    expect(
      statsCorePositionsOutsideLayout(core, new Set(["LW", "CM"])),
    ).toEqual([]);
    expect(statsCorePositionsOutsideLayout(undefined, new Set())).toEqual([]);
    expect(
      statsCorePositionsOutsideLayout({ ...core, secondary: "LW" }, new Set()),
    ).toEqual([{ rank: "primary", code: "LW" }]);
    expect(
      statsCorePositionsOutsideLayout(
        { ...core, primary: null, secondary: null },
        new Set(),
      ),
    ).toEqual([]);
  });
});
