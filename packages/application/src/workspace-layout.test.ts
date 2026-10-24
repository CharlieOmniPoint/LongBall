import { describe, expect, it } from "vitest";
import {
  parseWorkspaceLayoutPreference,
  resolveWorkspaceLayout,
} from "./workspace-layout";

describe("staff workspace layout presentation", () => {
  it("adapts actual tablet windows in both orientations and keeps short landscape phones compact", () => {
    for (const [width, height] of [
      [768, 1024],
      [820, 1180],
      [1024, 768],
      [1180, 820],
      [1366, 1024],
    ])
      expect(
        resolveWorkspaceLayout({
          role: "manager",
          preference: "auto",
          width,
          height,
        }).mode,
      ).toBe("tablet");
    for (const [width, height] of [
      [320, 844],
      [390, 844],
      [844, 390],
      [915, 412],
      [540, 720],
    ])
      expect(
        resolveWorkspaceLayout({
          role: "manager",
          preference: "auto",
          width,
          height,
        }).mode,
      ).toBe("phone");
  });
  it("honours explicit staff choices without overflowing a narrow or magnified window", () => {
    expect(
      resolveWorkspaceLayout({
        role: "administrator",
        preference: "phone",
        width: 1366,
        height: 1024,
      }),
    ).toMatchObject({
      mode: "phone",
      wide: false,
      rail: false,
      contentWidth: 600,
    });
    expect(
      resolveWorkspaceLayout({
        role: "manager",
        preference: "tablet",
        width: 390,
        height: 844,
      }),
    ).toMatchObject({ mode: "tablet", wide: false });
    expect(
      resolveWorkspaceLayout({
        role: "manager",
        preference: "tablet",
        width: 1024,
        height: 768,
        contentWidth: 380,
      }),
    ).toMatchObject({ mode: "tablet", wide: false });
    expect(
      resolveWorkspaceLayout({
        role: "manager",
        preference: "auto",
        width: 1024,
        height: 768,
        fontScale: 2,
      }),
    ).toMatchObject({ mode: "tablet", wide: false, rail: false });
  });
  it("never lets saved tablet settings change player, spectator or unverified-role presentation", () => {
    for (const role of ["player", "spectator", null] as const)
      expect(
        resolveWorkspaceLayout({
          role,
          preference: "tablet",
          width: 1366,
          height: 1024,
        }),
      ).toMatchObject({
        mode: "phone",
        wide: false,
        rail: false,
        staff: false,
      });
    expect(parseWorkspaceLayoutPreference("manager")).toBe("auto");
    expect(parseWorkspaceLayoutPreference({ role: "administrator" })).toBe(
      "auto",
    );
    expect(parseWorkspaceLayoutPreference("tablet")).toBe("tablet");
  });
});
