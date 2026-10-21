import { describe, expect, it } from "vitest";
import {
  parseLongBallDestination,
  sameActivationCompletion,
} from "./deep-links";

describe("LongBall destinations are memory-only routing input, never authority", () => {
  it("parses exact native invitation destination without an API origin", () => {
    expect(
      parseLongBallDestination(
        "longball://invite#teamId=team-1&seasonId=season-2&code=opaque_code_123",
      ),
    ).toEqual({
      kind: "invitation",
      invitation: {
        teamId: "team-1",
        seasonId: "season-2",
        code: "opaque_code_123",
      },
    });
  });
  it("requires explicitly owned HTTPS origins and fragment-only secrets", () => {
    const link =
      "https://longball.example/invite#teamId=t&seasonId=s&code=opaque_code_123";
    expect(parseLongBallDestination(link)).toBeNull();
    expect(
      parseLongBallDestination(link, {
        httpsOrigins: ["https://longball.example"],
      })?.kind,
    ).toBe("invitation");
    expect(
      parseLongBallDestination(link.replace("#", "?"), {
        httpsOrigins: ["https://longball.example"],
      }),
    ).toBeNull();
  });
  it.each([
    "longball://invite#teamId=t&seasonId=s&code=opaque_code_123&apiBaseUrl=https://evil.example",
    "longball://invite#teamId=t&teamId=x&seasonId=s&code=opaque_code_123",
    "longball://invite#teamId=../x&seasonId=s&code=opaque_code_123",
    "longball://activate#token=raw_activation_secret",
    "longball://auth/callback?code=oidc_code&state=oidc_state",
    "longball://user@invite#teamId=t&seasonId=s&code=opaque_code_123",
    "http://longball.example/activate",
  ])("rejects injection, ambiguous fields and OAuth callbacks: %s", (link) => {
    expect(parseLongBallDestination(link)).toBeNull();
  });
  it("binds provider completion to the exact expected activation without signing in", () => {
    const activationId = "81e52847-672d-4500-b009-21414a90677b";
    const result = parseLongBallDestination(
      `longball://activation/callback#longballActivation=${activationId}&completionProof=${"a".repeat(43)}`,
    );
    expect(sameActivationCompletion(result, activationId)).toBe(true);
    expect(sameActivationCompletion(result, "another-flow")).toBe(false);
    expect(parseLongBallDestination("longball://activate")).toEqual({
      kind: "activation",
    });
  });
});
