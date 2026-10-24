import { describe, expect, it } from "vitest";
import {
  parseAccountPushStatus,
  parsePushPlatformPolicies,
  parsePushRegistrationInput,
} from "./push-registrations";
const input = {
  deviceId: "device-a",
  platform: "android",
  transport: "fcm",
  token: "opaque-destination-metadata",
  appBuild: "1.0.0",
  permission: "granted",
};
const device = {
  deviceId: "device-a",
  platform: "android",
  transport: "fcm",
  permission: "granted",
  state: "registered",
  revision: 1,
  appBuild: "1.0.0",
  registeredAt: "2026-10-21T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
  revokedAt: null,
  lastOperationId: "request-a",
};
const status = {
  accountId: "account-a",
  registrationConfigured: true,
  deliveryConfigured: false,
  platforms: {
    android: { transport: "fcm", providerConfigId: "explicit-project" },
  },
  devices: [device],
};
describe("push metadata contract boundary", () => {
  it("accepts opaque destination bounds without making tokens authentication fields", () => {
    expect(parsePushRegistrationInput(input)).toEqual(input);
    expect(
      parsePushRegistrationInput({ ...input, token: "a".repeat(4096) }).token,
    ).toHaveLength(4096);
    for (const candidate of [
      { ...input, token: "short" },
      { ...input, token: "a".repeat(4097) },
      { ...input, token: input.token + "\n" },
      { ...input, accountId: "other" },
      { ...input, providerUrl: "https://untrusted.example" },
    ])
      expect(() => parsePushRegistrationInput(candidate)).toThrow();
  });
  it("requires explicit platform-compatible processor/project choices", () => {
    expect(parsePushPlatformPolicies({})).toEqual({});
    for (const candidate of [
      { ios: { transport: "fcm", providerConfigId: "wrong" } },
      { android: { transport: "apns", providerConfigId: "wrong" } },
      { android: { transport: "expo", providerConfigId: "explicit" } },
      {
        android: {
          transport: "fcm",
          providerConfigId: "explicit",
          projectId: "not-applicable",
        },
      },
      {
        android: {
          transport: "fcm",
          providerConfigId: "explicit",
          providerUrl: "https://untrusted.example",
        },
      },
    ])
      expect(() => parsePushPlatformPolicies(candidate)).toThrow();
    expect(
      parsePushPlatformPolicies({
        android: {
          transport: "expo",
          providerConfigId: "explicit",
          projectId: "9019cd9c-d484-4f83-a492-f1c0406338b9",
        },
      }),
    ).toMatchObject({ android: { transport: "expo" } });
  });
  it("rejects account substitution and any private token material in account status", () => {
    expect(parseAccountPushStatus(status, "account-a")).toEqual(status);
    for (const candidate of [
      { ...status, accountId: "other" },
      { ...status, token: "private" },
      { ...status, devices: [{ ...device, token: "private" }] },
      { ...status, devices: [{ ...device, token_digest: "private" }] },
      { ...status, devices: [{ ...device, token_ciphertext: "private" }] },
    ])
      expect(() => parseAccountPushStatus(candidate, "account-a")).toThrow();
  });
  it("rejects duplicate devices and false registered/revoked permission evidence", () => {
    for (const devices of [
      [device, device],
      [{ ...device, permission: "denied" }],
      [{ ...device, state: "revoked", revokedAt: null }],
      [{ ...device, state: "revoked", revokedAt: device.updatedAt }],
      [{ ...device, revision: 0 }],
      [{ ...device, registeredAt: null }],
    ])
      expect(() =>
        parseAccountPushStatus({ ...status, devices }, "account-a"),
      ).toThrow();
    expect(
      parseAccountPushStatus(
        {
          ...status,
          devices: [
            {
              ...device,
              state: "revoked",
              permission: "denied",
              revokedAt: device.updatedAt,
            },
          ],
        },
        "account-a",
      ).devices[0].state,
    ).toBe("revoked");
  });
});
