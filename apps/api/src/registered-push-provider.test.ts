import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createRegisteredPushProvider } from "./registered-push-provider";
import { createPushTokenCipher, pushTokenDigest } from "./push-token-crypto";
import type { PushRepository, PushRow } from "./push-repository";
import {
  TEAM_NOTIFICATION_BODY,
  type TeamNotificationProvider,
} from "../../../packages/application/src/team-notifications";
const token = "fictional-sensitive-destination-metadata",
  binding = {
    accountId: "account-a",
    issuer: "https://issuer.example",
    deviceId: "device-a",
    transport: "fcm",
    providerConfigId: "explicit-config",
  };
const cipher = createPushTokenCipher(
  "test-key",
  new Map([["test-key", randomBytes(32)]]),
);
const row: PushRow = {
  account_id: binding.accountId,
  issuer: binding.issuer,
  device_id: binding.deviceId,
  platform: "android",
  transport: "fcm",
  provider_config_id: binding.providerConfigId,
  token_ciphertext: cipher.encrypt(token, binding),
  token_digest: pushTokenDigest(token),
  permission: "granted",
  state: "registered",
  revision: 1,
  app_build: "test",
  registered_at: 1,
  updated_at: 1,
  revoked_at: null,
  last_operation_id: "request-a",
};
const repository = (rows: PushRow[]) =>
  ({ deliveryTargets: async () => rows }) as unknown as PushRepository;
const input: Parameters<TeamNotificationProvider["send"]>[0] = {
  accountId: "account-a",
  idempotencyKey: "notification-a",
  payload: { body: TEAM_NOTIFICATION_BODY, data: { entityId: "fixture-a" } },
  signal: new AbortController().signal,
};
const options = {
  pushTokenCipher: cipher,
  pushPlatforms: {
    android: {
      transport: "fcm" as const,
      providerConfigId: binding.providerConfigId,
    },
  },
};
describe("registered processor private destination boundary", () => {
  it("never retains a token reflected in a processor acknowledgement", async () => {
    const send = vi.fn(async () => ({
      status: "accepted" as const,
      receiptId: token,
    }));
    const provider = createRegisteredPushProvider(repository([row]), options, {
      configured: true,
      idempotency: "provider",
      send,
    });
    await expect(provider.send(input)).rejects.toThrow(
      "PUSH_PROVIDER_RECEIPT_UNAVAILABLE",
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(input)).not.toContain(token);
  });
  it("refuses a different recipient and a changed processor without sending", async () => {
    const send = vi.fn(async () => ({
      status: "accepted" as const,
      receiptId: "receipt-a",
    }));
    const sender = { configured: true, idempotency: "provider" as const, send };
    await expect(
      createRegisteredPushProvider(
        repository([{ ...row, account_id: "other" }]),
        options,
        sender,
      ).send(input),
    ).rejects.toThrow("PUSH_RECIPIENT_SCOPE_REQUIRED");
    expect(
      await createRegisteredPushProvider(
        repository([row]),
        {
          ...options,
          pushPlatforms: {
            android: { transport: "fcm", providerConfigId: "changed-config" },
          },
        },
        sender,
      ).send(input),
    ).toEqual({ status: "rejected", code: "DEVICE_UNREGISTERED" });
    expect(send).not.toHaveBeenCalled();
  });
  it("does not invent a provider or replace ciphertext when its key is unavailable", async () => {
    const send = vi.fn(async () => ({
      status: "accepted" as const,
      receiptId: "receipt-a",
    }));
    const before = JSON.stringify(row),
      sender = { configured: true, idempotency: "provider" as const, send };
    const disabled = createRegisteredPushProvider(
      repository([row]),
      options,
      null,
    );
    expect(disabled.configured).toBe(false);
    expect(await disabled.send(input)).toEqual({
      status: "rejected",
      code: "PROVIDER_UNCONFIGURED",
    });
    await expect(
      createRegisteredPushProvider(
        repository([row]),
        {
          ...options,
          pushTokenCipher: createPushTokenCipher(
            "new-key",
            new Map([["new-key", randomBytes(32)]]),
          ),
        },
        sender,
      ).send(input),
    ).rejects.toThrow("PUSH_TOKEN_UNAVAILABLE");
    expect(JSON.stringify(row)).toBe(before);
    expect(send).not.toHaveBeenCalled();
  });
});
