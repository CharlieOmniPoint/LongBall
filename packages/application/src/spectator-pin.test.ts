import { describe, expect, it } from "vitest";
import {
  normalizedSpectatorUsername,
  spectatorPinProblem,
} from "./spectator-pin";
describe("spectator passcodes", () => {
  it("rejects short, nonnumeric, repeated, consecutive, wrapped and common codes", () => {
    for (const code of [
      "123",
      "12345",
      " 4729",
      "abcd",
      "1111",
      "0000",
      "1234",
      "4321",
      "7890",
      "0987",
      "1212",
      "1122",
      "2580",
    ])
      expect(spectatorPinProblem(code), code).not.toBeNull();
  });
  it("accepts nontrivial four-digit codes including leading zeros", () => {
    for (const code of ["4729", "0368", "5826"])
      expect(spectatorPinProblem(code), code).toBeNull();
  });
  it("normalizes usernames but never converts contact details into login identities", () => {
    expect(normalizedSpectatorUsername("  Robin.Park ")).toBe("robin.park");
    for (const value of ["ab", "a@b.com", "a b", "x".repeat(41)])
      expect(() => normalizedSpectatorUsername(value)).toThrow();
  });
});
