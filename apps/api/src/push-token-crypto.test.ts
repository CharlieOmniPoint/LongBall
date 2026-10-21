import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPushTokenCipher, pushTokenDigest } from "./push-token-crypto";
const binding = {
  accountId: "test-account",
  issuer: "https://issuer.example",
  deviceId: "test-device",
  transport: "fcm",
  providerConfigId: "approved-test-project",
};
const token = "fictional-push-destination-metadata";
describe("push token encryption boundary", () => {
  it("uses randomized authenticated encryption and cannot move ciphertext across account/device/provider bindings", () => {
    const cipher = createPushTokenCipher(
        "key-a",
        new Map([["key-a", randomBytes(32)]]),
      ),
      encrypted = cipher.encrypt(token, binding);
    expect(cipher.encrypt(token, binding)).not.toBe(encrypted);
    expect(encrypted).not.toContain(token);
    expect(cipher.decrypt(encrypted, binding)).toBe(token);
    for (const field of [
      "accountId",
      "issuer",
      "deviceId",
      "transport",
      "providerConfigId",
    ] as const)
      expect(() =>
        cipher.decrypt(encrypted, { ...binding, [field]: "other" }),
      ).toThrow("PUSH_TOKEN_UNAVAILABLE");
    const modified = JSON.parse(encrypted);
    modified.ciphertext = "bad";
    expect(() => cipher.decrypt(JSON.stringify(modified), binding)).toThrow(
      "PUSH_TOKEN_UNAVAILABLE",
    );
  });
  it("supports explicitly retained key rotation and refuses missing/wrong keys without replacing them", () => {
    const old = randomBytes(32),
      current = randomBytes(32),
      encrypted = createPushTokenCipher("old", new Map([["old", old]])).encrypt(
        token,
        binding,
      );
    const rotated = createPushTokenCipher(
      "current",
      new Map([
        ["old", old],
        ["current", current],
      ]),
    );
    expect(rotated.decrypt(encrypted, binding)).toBe(token);
    expect(rotated.usesActiveKey(encrypted)).toBe(false);
    expect(rotated.usesActiveKey(rotated.encrypt(token, binding))).toBe(true);
    expect(JSON.parse(rotated.encrypt(token, binding)).keyId).toBe("current");
    expect(() =>
      createPushTokenCipher("current", new Map([["current", current]])).decrypt(
        encrypted,
        binding,
      ),
    ).toThrow("PUSH_TOKEN_UNAVAILABLE");
    expect(() =>
      createPushTokenCipher("old", new Map([["old", randomBytes(32)]])).decrypt(
        encrypted,
        binding,
      ),
    ).toThrow("PUSH_TOKEN_UNAVAILABLE");
    expect(pushTokenDigest(token)).toMatch(/^[a-f0-9]{64}$/);
  });
});
