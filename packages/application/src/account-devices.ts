export interface RecognizedAppDevice {
  deviceId: string;
  source: "native_app_enrolment" | "match_controller_enrolment";
  label: string | null;
  platform: "ios" | "android" | null;
  platformVerified: false;
  registeredAt: string | null;
  lastSeenAt: string | null;
}
export interface AccountDevicesDto {
  kind: "recognised-devices";
  accountId: string;
  asOf: string;
  devices: RecognizedAppDevice[];
  remoteRevocationAvailable: false;
}
const object = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === "object" && !Array.isArray(v));
const opaque = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(v);
const iso = (v: unknown): v is string =>
  typeof v === "string" &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
function fields(value: Record<string, unknown>, keys: string[]) {
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error("Invalid own device inventory fields.");
}
export function parseAccountDevicesDto(value: unknown): AccountDevicesDto {
  if (!object(value)) throw new Error("Invalid own device inventory.");
  fields(value, [
    "kind",
    "accountId",
    "asOf",
    "devices",
    "remoteRevocationAvailable",
  ]);
  if (
    value.kind !== "recognised-devices" ||
    !opaque(value.accountId) ||
    !iso(value.asOf) ||
    !Array.isArray(value.devices) ||
    value.remoteRevocationAvailable !== false
  )
    throw new Error("Invalid own device inventory.");
  const seen = new Set<string>();
  const devices = value.devices.map((item): RecognizedAppDevice => {
    if (!object(item)) throw new Error("Invalid device entry.");
    fields(item, [
      "deviceId",
      "source",
      "label",
      "platform",
      "platformVerified",
      "registeredAt",
      "lastSeenAt",
    ]);
    if (
      !opaque(item.deviceId) ||
      seen.has(item.deviceId) ||
      !["native_app_enrolment", "match_controller_enrolment"].includes(
        item.source as string,
      ) ||
      item.label !== null ||
      ![null, "ios", "android"].includes(item.platform as null) ||
      item.platformVerified !== false ||
      (item.registeredAt !== null && !iso(item.registeredAt)) ||
      (item.lastSeenAt !== null && !iso(item.lastSeenAt))
    )
      throw new Error("Invalid device entry metadata.");
    if (
      item.source === "native_app_enrolment" &&
      (item.platform === null ||
        item.registeredAt === null ||
        item.lastSeenAt === null)
    )
      throw new Error("Native enrolment requires actual service timestamps.");
    if (
      item.source === "match_controller_enrolment" &&
      (item.platform !== null ||
        item.registeredAt !== null ||
        item.lastSeenAt !== null)
    )
      throw new Error("Legacy recorder metadata is unknown.");
    if (
      item.registeredAt &&
      item.lastSeenAt &&
      Date.parse(item.lastSeenAt as string) <
        Date.parse(item.registeredAt as string)
    )
      throw new Error("Device timestamps are inconsistent.");
    seen.add(item.deviceId);
    return item as unknown as RecognizedAppDevice;
  });
  return {
    kind: "recognised-devices",
    accountId: value.accountId,
    asOf: value.asOf,
    devices,
    remoteRevocationAvailable: false,
  };
}
