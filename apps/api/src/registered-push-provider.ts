import type {
  GenericTeamNotificationPayload,
  TeamNotificationProvider,
} from "../../../packages/application/src/team-notifications";
import type {
  PushPlatform,
  PushTransport,
} from "../../../packages/application/src/push-registrations";
import type { PushRepository } from "./push-repository";
import type { PushOptions } from "./push-registrations";
import {
  parsePushPlatformPolicies,
  parsePushRegistrationInput,
} from "../../../packages/application/src/push-registrations";
export interface RegisteredPushDestination {
  deviceId: string;
  revision: number;
  platform: PushPlatform;
  transport: PushTransport;
  providerConfigId: string;
  token: string;
}
/** Deployment-injected sender. Its provider/credentials are never selected by a client. */
export interface RegisteredPushSender {
  configured: boolean;
  idempotency: "provider" | "none";
  send(input: {
    idempotencyKey: string;
    destinations: RegisteredPushDestination[];
    payload: GenericTeamNotificationPayload;
    signal: AbortSignal;
  }): ReturnType<TeamNotificationProvider["send"]>;
}
/** Resolve only at dispatch time, inside the existing current recipient/lease boundary. */
export function createRegisteredPushProvider(
  repository: PushRepository,
  options: PushOptions,
  sender: RegisteredPushSender | null,
): TeamNotificationProvider {
  const platforms = parsePushPlatformPolicies(options.pushPlatforms ?? {});
  const prepareSend: NonNullable<
    TeamNotificationProvider["prepareSend"]
  > = async (input) => {
    const rejected = (code: string) => async () => ({
      status: "rejected" as const,
      code,
    });
    if (!sender?.configured || !options.pushTokenCipher)
      return rejected("PROVIDER_UNCONFIGURED");
    const rows = await repository.deliveryTargets(input.accountId),
      destinations: RegisteredPushDestination[] = [];
    for (const row of rows) {
      if (row.account_id !== input.accountId)
        throw new Error("PUSH_RECIPIENT_SCOPE_REQUIRED");
      const policy = platforms[row.platform];
      if (
        row.state !== "registered" ||
        row.permission === "denied" ||
        !row.token_ciphertext ||
        !policy ||
        row.transport !== policy.transport ||
        row.provider_config_id !== policy.providerConfigId
      )
        continue;
      const token = options.pushTokenCipher.decrypt(row.token_ciphertext, {
        accountId: row.account_id,
        issuer: row.issuer,
        deviceId: row.device_id,
        transport: row.transport,
        providerConfigId: row.provider_config_id,
      });
      parsePushRegistrationInput({
        deviceId: row.device_id,
        platform: row.platform,
        transport: row.transport,
        permission: row.permission,
        appBuild: row.app_build,
        token,
      });
      destinations.push({
        deviceId: row.device_id,
        revision: row.revision,
        platform: row.platform,
        transport: row.transport,
        providerConfigId: row.provider_config_id,
        token,
      });
    }
    if (!destinations.length) return rejected("DEVICE_UNREGISTERED");
    // Only this private closure retains destinations, outside the database context.
    return async () => {
      const reply = await sender.send({
        idempotencyKey: input.idempotencyKey,
        destinations,
        payload: input.payload,
        signal: input.signal,
      });
      // A processor receipt is retained by the generic queue. Refuse accidental
      // token reflection after an uncertain external outcome, never persist it.
      if (
        reply.status === "accepted" &&
        destinations.some((item) => reply.receiptId.includes(item.token))
      )
        throw new Error("PUSH_PROVIDER_RECEIPT_UNAVAILABLE");
      return reply;
    };
  };
  return {
    configured: Boolean(
      sender?.configured &&
        options.pushTokenCipher &&
        Object.keys(platforms).length,
    ),
    idempotency: sender?.idempotency ?? "none",
    prepareSend,
    async send(input) {
      return (await prepareSend(input))();
    },
  };
}
