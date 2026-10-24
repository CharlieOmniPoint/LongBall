import { describe, expect, it } from "vitest";
import {
  parseLongBallDestination,
  sameActivationCompletion,
} from "./deep-links";

describe("LongBall destinations are memory-only routing input, never authority", () => {
  it("supports an exact static-host base path without accepting a service origin from the link", () => {
    const entry = "https://owner.example/LongBall/",
      link = `${entry}#longballInvite=1&teamId=t&seasonId=s&code=${"a".repeat(42)}A`;
    expect(
      parseLongBallDestination(link, { httpsEntryUrls: [entry] })?.kind,
    ).toBe("invitation");
    expect(
      parseLongBallDestination(link, {
        httpsOrigins: ["https://owner.example"],
      }),
    ).toBeNull();
    expect(
      parseLongBallDestination(link.replace("/LongBall/", "/other/"), {
        httpsEntryUrls: [entry],
      }),
    ).toBeNull();
    expect(
      parseLongBallDestination(link + "&apiBaseUrl=https://evil.example", {
        httpsEntryUrls: [entry],
      }),
    ).toBeNull();
  });
  it("routes exact completion metadata on a trusted static entry while refusing injected fields", () => {
    const entry = "https://owner.example/LongBall/",
      activationId = "81e52847-672d-4500-b009-21414a90677b",
      link = `${entry}#longballActivation=${activationId}&completionProof=${"a".repeat(43)}`;
    expect(
      sameActivationCompletion(
        parseLongBallDestination(link, { httpsEntryUrls: [entry] }),
        activationId,
      ),
    ).toBe(true);
    expect(parseLongBallDestination(link)).toBeNull();
    expect(
      parseLongBallDestination(link + "&token=secret", {
        httpsEntryUrls: [entry],
      }),
    ).toBeNull();
  });
  it("allows HTTP only for the exact localhost page under an explicit fictional-trial policy", () => {
    const entry = "http://localhost:4174/",
      link = `${entry}#longballInvite=1&teamId=t&seasonId=s&code=${"a".repeat(42)}A`;
    expect(parseLongBallDestination(link)).toBeNull();
    expect(
      parseLongBallDestination(link, { developmentHttpEntryUrls: [entry] })
        ?.kind,
    ).toBe("invitation");
    expect(
      parseLongBallDestination(link.replace("localhost", "192.0.2.1"), {
        developmentHttpEntryUrls: ["http://192.0.2.1:4174/"],
      }),
    ).toBeNull();
  });
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
