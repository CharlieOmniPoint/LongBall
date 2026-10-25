import { describe, expect, it } from "vitest";
import { selectedRoleHeaders } from "./request-headers";
describe("selected workspace HTTP role header", () => {
  it("replaces either casing and duplicate values with one explicit selected role", () => {
    for (const headers of [
      { "X-Longball-Role": "manager" },
      { "x-longball-role": "manager" },
      { "x-longball-role": "manager", "X-Longball-Role": "spectator" },
    ] as Record<string, string>[]) {
      const normalized = selectedRoleHeaders(headers, "administrator");
      expect(new Headers(normalized).get("X-Longball-Role")).toBe(
        "administrator",
      );
      expect(
        Object.keys(normalized).filter(
          (key) => key.toLowerCase() === "x-longball-role",
        ),
      ).toHaveLength(1);
    }
  });
  it("retains explicit caller role when no workspace role is selected and preserves other headers", () => {
    const normalized = selectedRoleHeaders(
      { "X-Longball-Role": "manager", "Idempotency-Key": "exact-request" },
      null,
    );
    expect(normalized).toEqual({
      "idempotency-key": "exact-request",
      "x-longball-role": "manager",
    });
  });
  it("forwards the validated default experience when there is no explicit role choice", () => {
    const result = selectedRoleHeaders(
      { "X-Longball-Role": "administrator" },
      null,
      "manager",
    );
    expect(new Headers(result).get("X-Longball-Role")).toBe("manager");
    expect(
      Object.keys(result).filter(
        (key) => key.toLowerCase() === "x-longball-role",
      ),
    ).toHaveLength(1);
  });
  it("uses an explicit experience over the prior binding and never fabricates a role without either", () => {
    expect(
      new Headers(
        selectedRoleHeaders(undefined, "administrator", "manager"),
      ).get("X-Longball-Role"),
    ).toBe("administrator");
    expect(
      new Headers(selectedRoleHeaders(undefined, null, null)).has(
        "X-Longball-Role",
      ),
    ).toBe(false);
  });
});
