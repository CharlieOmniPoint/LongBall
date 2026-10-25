import {
  AccessError,
  type Principal,
} from "../../../packages/application/src/access";
import {
  parsePushRegistrationInput,
  parsePushPlatformPolicies,
  type AccountPushStatus,
  type PushPlatformPolicies,
  type PushDeviceStatus,
} from "../../../packages/application/src/push-registrations";
import type { PushRepository, PushRow } from "./push-repository";
import { pushTokenDigest, type PushTokenCipher } from "./push-token-crypto";
export interface PushOptions {
  pushPlatforms?: PushPlatformPolicies;
  pushTokenCipher?: PushTokenCipher;
  pushDeliveryConfigured?: boolean;
}
const conflict = () =>
  new AccessError(
    "PUSH_REGISTRATION_CHANGED",
    409,
    "The saved push registration changed. Refresh its status before another update.",
  );
export function pushRevision(value: string | undefined): number {
  if (!value)
    throw new AccessError(
      "PUSH_REVISION_REQUIRED",
      428,
      "Read push status and send its quoted revision in If-Match; use zero for a new registration.",
    );
  if (
    !/^"(?:0|[1-9]\d{0,14})"$/.test(value) ||
    !Number.isSafeInteger(Number(value.slice(1, -1)))
  )
    throw new AccessError(
      "INVALID_REQUEST",
      400,
      "Use the exact quoted push revision.",
    );
  return Number(value.slice(1, -1));
}
function status(row: PushRow): PushDeviceStatus {
  return {
    deviceId: row.device_id,
    platform: row.platform,
    transport: row.transport,
    permission: row.permission,
    state: row.state,
    revision: row.revision,
    appBuild: row.app_build,
    registeredAt:
      row.registered_at === null
        ? null
        : new Date(row.registered_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    revokedAt:
      row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
    lastOperationId: row.last_operation_id,
  };
}
export class PushRegistrationService {
  readonly platforms: PushPlatformPolicies;
  constructor(
    readonly repository: PushRepository,
    readonly options: PushOptions,
    readonly now = Date.now,
  ) {
    this.platforms = parsePushPlatformPolicies(options.pushPlatforms ?? {});
  }
  get configured() {
    return Boolean(
      this.options.pushTokenCipher && Object.keys(this.platforms).length,
    );
  }
  async assertEnrolled(principal: Principal, deviceId: string) {
    if (principal.status !== "active")
      throw new AccessError(
        "INVALID_SESSION",
        401,
        "An active signed-in account is required.",
      );
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(deviceId))
      throw new AccessError(
        "INVALID_REQUEST",
        400,
        "Use the enrolled app-device identity.",
      );
    const device = await this.repository.enrolled(principal, deviceId);
    if (!device)
      throw new AccessError(
        "PUSH_DEVICE_UNAVAILABLE",
        404,
        "This account's enrolled native device is unavailable.",
      );
    return device;
  }
  async read(principal: Principal): Promise<AccountPushStatus> {
    const rows = await this.repository.list(principal);
    if (
      rows.length > 1000 ||
      rows.some(
        (row) =>
          row.account_id !== principal.accountId ||
          row.issuer !== principal.issuer,
      )
    )
      throw new Error("PUSH_ACCOUNT_SCOPE_REQUIRED");
    return {
      accountId: principal.accountId,
      registrationConfigured: this.configured,
      deliveryConfigured: this.options.pushDeliveryConfigured === true,
      platforms: this.configured ? this.platforms : {},
      devices: rows.map(status),
    };
  }
  async validateRegistration(principal: Principal, body: unknown) {
    let input;
    try {
      input = parsePushRegistrationInput(body);
    } catch {
      throw new AccessError(
        "INVALID_REQUEST",
        400,
        "Use the exact push registration fields; tokens are never authentication.",
      );
    }
    const device = await this.assertEnrolled(principal, input.deviceId);
    if (device.platform !== input.platform)
      throw new AccessError(
        "PUSH_DEVICE_UNAVAILABLE",
        404,
        "This account's enrolled native device is unavailable.",
      );
    const policy = this.platforms[input.platform];
    if (!this.configured || !policy)
      throw new AccessError(
        "PUSH_NOT_CONFIGURED",
        503,
        "Push registration needs an approved processor and deployment encryption key.",
      );
    if (input.transport !== policy.transport)
      throw new AccessError(
        "PUSH_PROCESSOR_UNAVAILABLE",
        409,
        "This transport is not configured for this app platform.",
      );
    if (input.permission === "denied")
      throw new AccessError(
        "PUSH_PERMISSION_DENIED",
        409,
        "Remove the device registration when notification permission is denied.",
      );
    return { input, policy };
  }
  async register(
    principal: Principal,
    body: unknown,
    expectedRevision: number,
    operationId: string,
  ) {
    const { input, policy } = await this.validateRegistration(principal, body);
    return this.repository.transaction(async () => {
      const previous = await this.repository.current(principal, input.deviceId);
      if ((previous?.revision ?? 0) !== expectedRevision) throw conflict();
      const digest = pushTokenDigest(input.token),
        at = this.now();
      if (
        previous?.state === "registered" &&
        previous.token_digest === digest &&
        previous.token_ciphertext !== null &&
        this.options.pushTokenCipher!.usesActiveKey(
          previous.token_ciphertext,
        ) &&
        previous.transport === input.transport &&
        previous.provider_config_id === policy.providerConfigId &&
        previous.permission === input.permission &&
        previous.app_build === input.appBuild
      )
        return {
          id: input.deviceId,
          revision: previous.revision,
          serverTime: new Date(at).toISOString(),
        };
      const row: PushRow = {
        account_id: principal.accountId,
        issuer: principal.issuer,
        device_id: input.deviceId,
        platform: input.platform,
        transport: input.transport,
        provider_config_id: policy.providerConfigId,
        token_ciphertext: this.options.pushTokenCipher!.encrypt(input.token, {
          accountId: principal.accountId,
          issuer: principal.issuer,
          deviceId: input.deviceId,
          transport: input.transport,
          providerConfigId: policy.providerConfigId,
        }),
        token_digest: digest,
        permission: input.permission,
        state: "registered",
        revision: expectedRevision + 1,
        app_build: input.appBuild,
        registered_at: previous?.registered_at ?? at,
        updated_at: at,
        revoked_at: null,
        last_operation_id: operationId,
      };
      if (!(await this.repository.save(principal, row, expectedRevision)))
        throw conflict();
      return {
        id: input.deviceId,
        revision: row.revision,
        serverTime: new Date(at).toISOString(),
      };
    });
  }
  async revoke(
    principal: Principal,
    deviceId: string,
    expectedRevision: number,
    operationId: string,
  ) {
    const device = await this.assertEnrolled(principal, deviceId);
    return this.repository.transaction(async () => {
      const previous = await this.repository.current(principal, deviceId);
      if ((previous?.revision ?? 0) !== expectedRevision) throw conflict();
      const at = this.now();
      const row: PushRow = {
        account_id: principal.accountId,
        issuer: principal.issuer,
        device_id: deviceId,
        platform: device.platform,
        transport: previous?.transport ?? null,
        provider_config_id: previous?.provider_config_id ?? null,
        token_ciphertext: null,
        token_digest: null,
        permission: "denied",
        state: "revoked",
        revision: expectedRevision + 1,
        app_build: previous?.app_build ?? "",
        registered_at: previous?.registered_at ?? null,
        updated_at: at,
        revoked_at: at,
        last_operation_id: operationId,
      };
      if (!(await this.repository.save(principal, row, expectedRevision)))
        throw conflict();
      return {
        operationId,
        status: "completed" as const,
        serverTime: new Date(at).toISOString(),
      };
    });
  }
}
