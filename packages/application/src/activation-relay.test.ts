import { describe, expect, it } from "vitest";
import {
  activationRelayChannelName,
  parseActivationRelayMessage,
} from "./activation-relay";
const completion = {
  activationId: "81e52847-672d-4500-b009-21414a90677b",
  completionProof: "a".repeat(43),
};
describe("same-origin activation completion relay", () => {
  it("carries only exact attempt and completion proof without the original capability", () => {
    expect(parseActivationRelayMessage(completion)).toEqual(completion);
    expect(
      parseActivationRelayMessage({ ...completion, token: "secret" }),
    ).toBeNull();
    expect(
      parseActivationRelayMessage({
        ...completion,
        apiBaseUrl: "https://evil.example",
      }),
    ).toBeNull();
    expect(
      parseActivationRelayMessage({ ...completion, activationId: "ambiguous" }),
    ).toBeNull();
  });
  it("namespaces routing to the exact static entry path", () => {
    expect(
      activationRelayChannelName("https://owner.example/LongBall/"),
    ).not.toBe(activationRelayChannelName("https://owner.example/other/"));
    expect(() =>
      activationRelayChannelName(
        "https://owner.example/LongBall/#token=secret",
      ),
    ).toThrow();
  });
});
