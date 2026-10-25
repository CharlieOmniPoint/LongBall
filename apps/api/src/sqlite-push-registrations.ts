import type { DatabaseSync } from "node:sqlite";
import type { Principal } from "../../../packages/application/src/access";
import type { PushRepository, PushRow } from "./push-repository";
export const PUSH_SQLITE_MIGRATION = `
CREATE TABLE push_registrations(
 account_id TEXT NOT NULL REFERENCES accounts(id),issuer TEXT NOT NULL,device_id TEXT NOT NULL REFERENCES native_app_devices(device_id),platform TEXT NOT NULL CHECK(platform IN('ios','android')),
 transport TEXT CHECK(transport IN('apns','fcm','expo')),provider_config_id TEXT,token_ciphertext TEXT,token_digest TEXT,
 permission TEXT NOT NULL CHECK(permission IN('granted','provisional','denied')),state TEXT NOT NULL CHECK(state IN('registered','revoked')),revision INTEGER NOT NULL CHECK(revision>=1),
 app_build TEXT NOT NULL,registered_at INTEGER,updated_at INTEGER NOT NULL,revoked_at INTEGER,last_operation_id TEXT NOT NULL,
 PRIMARY KEY(account_id,device_id),CHECK((state='registered' AND token_ciphertext IS NOT NULL AND token_digest IS NOT NULL AND transport IS NOT NULL AND provider_config_id IS NOT NULL AND permission<>'denied' AND registered_at IS NOT NULL AND revoked_at IS NULL) OR(state='revoked' AND token_ciphertext IS NULL AND token_digest IS NULL AND revoked_at IS NOT NULL)));
CREATE TRIGGER push_registration_identity BEFORE UPDATE ON push_registrations WHEN NEW.account_id<>OLD.account_id OR NEW.issuer<>OLD.issuer OR NEW.device_id<>OLD.device_id OR NEW.revision<>OLD.revision+1 OR NEW.registered_at IS NOT OLD.registered_at AND OLD.registered_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'Immutable push binding or stale revision'); END;
CREATE TRIGGER push_registration_enrolment_insert BEFORE INSERT ON push_registrations WHEN NOT EXISTS(SELECT 1 FROM native_app_devices d WHERE d.device_id=NEW.device_id AND d.account_id=NEW.account_id AND d.issuer=NEW.issuer AND d.platform=NEW.platform) BEGIN SELECT RAISE(ABORT,'Enrolled push device required'); END;
CREATE TRIGGER push_registration_enrolment_update BEFORE UPDATE ON push_registrations WHEN NOT EXISTS(SELECT 1 FROM native_app_devices d WHERE d.device_id=NEW.device_id AND d.account_id=NEW.account_id AND d.issuer=NEW.issuer AND d.platform=NEW.platform) BEGIN SELECT RAISE(ABORT,'Enrolled push device required'); END;`;
const fields = [
  "account_id",
  "issuer",
  "device_id",
  "platform",
  "transport",
  "provider_config_id",
  "token_ciphertext",
  "token_digest",
  "permission",
  "state",
  "revision",
  "app_build",
  "registered_at",
  "updated_at",
  "revoked_at",
  "last_operation_id",
] as const;
export class SqlitePushRepository implements PushRepository {
  constructor(
    readonly database: DatabaseSync,
    readonly transaction: PushRepository["transaction"],
  ) {}
  async enrolled(principal: Principal, deviceId: string) {
    return (
      (this.database
        .prepare(
          "SELECT platform FROM native_app_devices WHERE device_id=? AND account_id=? AND issuer=?",
        )
        .get(deviceId, principal.accountId, principal.issuer) as
        | { platform: "ios" | "android" }
        | undefined) ?? null
    );
  }
  async current(principal: Principal, deviceId: string) {
    return (
      (this.database
        .prepare(
          "SELECT * FROM push_registrations WHERE account_id=? AND issuer=? AND device_id=?",
        )
        .get(
          principal.accountId,
          principal.issuer,
          deviceId,
        ) as unknown as PushRow) ?? null
    );
  }
  async list(principal: Principal) {
    return this.database
      .prepare(
        "SELECT * FROM push_registrations WHERE account_id=? AND issuer=? ORDER BY device_id",
      )
      .all(principal.accountId, principal.issuer) as unknown as PushRow[];
  }
  async save(principal: Principal, row: PushRow, expectedRevision: number) {
    if (
      row.account_id !== principal.accountId ||
      row.issuer !== principal.issuer
    )
      throw new Error("PUSH_ACCOUNT_SCOPE_REQUIRED");
    const values = fields.map((field) => row[field]);
    if (expectedRevision === 0)
      return (
        Number(
          this.database
            .prepare(
              `INSERT INTO push_registrations(${fields.join(",")}) VALUES(${fields.map(() => "?").join(",")}) ON CONFLICT(account_id,device_id) DO NOTHING`,
            )
            .run(...values).changes,
        ) === 1
      );
    const updated = fields.filter(
      (field) => !["account_id", "issuer", "device_id"].includes(field),
    );
    return (
      Number(
        this.database
          .prepare(
            `UPDATE push_registrations SET ${updated.map((field) => `${field}=?`).join(",")} WHERE account_id=? AND issuer=? AND device_id=? AND revision=?`,
          )
          .run(
            ...updated.map((field) => row[field]),
            principal.accountId,
            principal.issuer,
            row.device_id,
            expectedRevision,
          ).changes,
      ) === 1
    );
  }
  async deliveryTargets(accountId: string) {
    return this.database
      .prepare(
        "SELECT p.* FROM push_registrations p JOIN native_app_devices d ON d.device_id=p.device_id AND d.account_id=p.account_id AND d.issuer=p.issuer AND d.platform=p.platform JOIN accounts a ON a.id=p.account_id AND a.issuer=p.issuer AND a.status='active' WHERE p.account_id=? AND p.state='registered' AND p.permission IN('granted','provisional') ORDER BY p.device_id",
      )
      .all(accountId) as unknown as PushRow[];
  }
}
