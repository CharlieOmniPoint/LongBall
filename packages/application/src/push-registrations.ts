/** Push destinations are delivery metadata; these values never authenticate an account. */
export type PushTransport = "apns" | "fcm" | "expo";
export type PushPlatform = "ios" | "android";
export type PushPermission = "granted" | "provisional" | "denied";
export interface PushRegistrationInput {
  deviceId: string;
  platform: PushPlatform;
  transport: PushTransport;
  token: string;
  appBuild: string;
  permission: PushPermission;
}
export interface PushPlatformPolicy {
  transport: PushTransport;
  providerConfigId: string;
  /** Public Expo project UUID, only when that processor is explicitly configured. */
  projectId?: string;
}
export type PushPlatformPolicies = Partial<
  Record<PushPlatform, PushPlatformPolicy>
>;
export interface PushDeviceStatus {
  deviceId: string;
  platform: PushPlatform;
  transport: PushTransport | null;
  permission: PushPermission;
  state: "registered" | "revoked";
  revision: number;
  appBuild: string;
  registeredAt: string | null;
  updatedAt: string;
  revokedAt: string | null;
  lastOperationId: string;
}
export interface AccountPushStatus {
  accountId: string;
  registrationConfigured: boolean;
  deliveryConfigured: boolean;
  platforms: PushPlatformPolicies;
  devices: PushDeviceStatus[];
}
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key)) &&
  keys.every((key) => Object.hasOwn(value, key));
const opaque = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(value);
const instant = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
export function parsePushRegistrationInput(
  value: unknown,
): PushRegistrationInput {
  if (
    !object(value) ||
    !exact(value, [
      "deviceId",
      "platform",
      "transport",
      "token",
      "appBuild",
      "permission",
    ]) ||
    !opaque(value.deviceId) ||
    value.deviceId.length > 120 ||
    !["ios", "android"].includes(String(value.platform)) ||
    !["apns", "fcm", "expo"].includes(String(value.transport)) ||
    typeof value.token !== "string" ||
    value.token.length < 20 ||
    value.token.length > 4096 ||
    /[\s\x00-\x1f\x7f]/u.test(value.token) ||
    typeof value.appBuild !== "string" ||
    value.appBuild.length > 60 ||
    /[\x00-\x1f\x7f]/u.test(value.appBuild) ||
    !["granted", "provisional", "denied"].includes(String(value.permission))
  )
    throw new Error("Use the exact enrolled-device push registration fields.");
  return {
    deviceId: value.deviceId,
    platform: value.platform as PushPlatform,
    transport: value.transport as PushTransport,
    token: value.token,
    appBuild: value.appBuild,
    permission: value.permission as PushPermission,
  };
}
export function parsePushPlatformPolicies(
  value: unknown,
): PushPlatformPolicies {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !["ios", "android"].includes(key))
  )
    throw new Error("Invalid push platform configuration.");
  const result: PushPlatformPolicies = {};
  for (const platform of ["ios", "android"] as const) {
    const item = value[platform];
    if (item === undefined) continue;
    if (
      !object(item) ||
      Object.keys(item).some(
        (key) => !["transport", "providerConfigId", "projectId"].includes(key),
      ) ||
      !opaque(item.providerConfigId) ||
      !["apns", "fcm", "expo"].includes(String(item.transport)) ||
      (item.transport === "apns" && platform !== "ios") ||
      (item.transport === "fcm" && platform !== "android") ||
      (item.transport === "expo" &&
        (typeof item.projectId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            item.projectId,
          ))) ||
      (item.transport !== "expo" && item.projectId !== undefined)
    )
      throw new Error(
        "Configure an approved processor and project for this platform.",
      );
    result[platform] = {
      transport: item.transport as PushTransport,
      providerConfigId: item.providerConfigId,
      ...(item.transport === "expo"
        ? { projectId: item.projectId as string }
        : {}),
    };
  }
  return result;
}
export function parseAccountPushStatus(
  value: unknown,
  accountId: string,
): AccountPushStatus {
  if (
    !object(value) ||
    !exact(value, [
      "accountId",
      "registrationConfigured",
      "deliveryConfigured",
      "platforms",
      "devices",
    ]) ||
    value.accountId !== accountId ||
    typeof value.registrationConfigured !== "boolean" ||
    typeof value.deliveryConfigured !== "boolean" ||
    !Array.isArray(value.devices) ||
    value.devices.length > 1000
  )
    throw new Error("Push status does not match this account.");
  const devices: PushDeviceStatus[] = value.devices.map((item) => {
    if (
      !object(item) ||
      !exact(item, [
        "deviceId",
        "platform",
        "transport",
        "permission",
        "state",
        "revision",
        "appBuild",
        "registeredAt",
        "updatedAt",
        "revokedAt",
        "lastOperationId",
      ]) ||
      !opaque(item.deviceId) ||
      !opaque(item.lastOperationId) ||
      !["ios", "android"].includes(String(item.platform)) ||
      (item.transport !== null &&
        !["apns", "fcm", "expo"].includes(String(item.transport))) ||
      !["granted", "provisional", "denied"].includes(String(item.permission)) ||
      !["registered", "revoked"].includes(String(item.state)) ||
      !Number.isSafeInteger(item.revision) ||
      Number(item.revision) < 1 ||
      typeof item.appBuild !== "string" ||
      item.appBuild.length > 60 ||
      !instant(item.updatedAt) ||
      (item.registeredAt !== null && !instant(item.registeredAt)) ||
      (item.revokedAt !== null && !instant(item.revokedAt)) ||
      (item.state === "registered" &&
        (item.transport === null ||
          item.registeredAt === null ||
          item.revokedAt !== null ||
          item.permission === "denied")) ||
      (item.state === "revoked" &&
        (item.revokedAt === null || item.permission !== "denied"))
    )
      throw new Error("Invalid private push status fields.");
    return { ...item } as unknown as PushDeviceStatus;
  });
  if (new Set(devices.map((item) => item.deviceId)).size !== devices.length)
    throw new Error("Duplicate push device status.");
  return {
    accountId,
    registrationConfigured: value.registrationConfigured,
    deliveryConfigured: value.deliveryConfigured,
    platforms: parsePushPlatformPolicies(value.platforms),
    devices,
  };
}
