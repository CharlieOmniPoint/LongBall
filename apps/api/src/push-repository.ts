import type { Principal } from "../../../packages/application/src/access";
import type {
  PushPermission,
  PushPlatform,
  PushTransport,
} from "../../../packages/application/src/push-registrations";
export interface PushRow {
  account_id: string;
  issuer: string;
  device_id: string;
  platform: PushPlatform;
  transport: PushTransport | null;
  provider_config_id: string | null;
  token_ciphertext: string | null;
  token_digest: string | null;
  permission: PushPermission;
  state: "registered" | "revoked";
  revision: number;
  app_build: string;
  registered_at: number | null;
  updated_at: number;
  revoked_at: number | null;
  last_operation_id: string;
}
export interface PushRepository {
  transaction<T>(work: () => Promise<T>): Promise<T>;
  enrolled(
    principal: Principal,
    deviceId: string,
  ): Promise<{ platform: PushPlatform } | null>;
  current(principal: Principal, deviceId: string): Promise<PushRow | null>;
  list(principal: Principal): Promise<PushRow[]>;
  save(
    principal: Principal,
    row: PushRow,
    expectedRevision: number,
  ): Promise<boolean>;
  /** Called only inside the current notification worker's protected job context. */
  deliveryTargets(accountId: string): Promise<PushRow[]>;
}
