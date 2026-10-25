import type { Principal } from "../../../packages/application/src/access";
import type { PgDatabase } from "./pg";
import type { PushRepository, PushRow } from "./push-repository";
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
export class PostgresPushRepository implements PushRepository {
  constructor(readonly database: PgDatabase) {}
  transaction<T>(work: () => Promise<T>) {
    return this.database.transaction(work);
  }
  async enrolled(principal: Principal, deviceId: string) {
    return (
      (
        await this.database.query<{ platform: "ios" | "android" }>(
          "SELECT platform FROM longball.native_app_devices WHERE device_id=$1 AND account_id=$2 AND issuer=$3",
          [deviceId, principal.accountId, principal.issuer],
        )
      ).rows[0] ?? null
    );
  }
  async current(principal: Principal, deviceId: string) {
    return (
      ((
        await this.database.query(
          "SELECT * FROM longball.push_registrations WHERE account_id=$1 AND issuer=$2 AND device_id=$3 FOR UPDATE",
          [principal.accountId, principal.issuer, deviceId],
        )
      ).rows[0] as PushRow | undefined) ?? null
    );
  }
  async list(principal: Principal) {
    return (
      await this.database.query(
        "SELECT * FROM longball.push_registrations WHERE account_id=$1 AND issuer=$2 ORDER BY device_id",
        [principal.accountId, principal.issuer],
      )
    ).rows as PushRow[];
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
        (
          await this.database.query(
            `INSERT INTO longball.push_registrations(${fields.join(",")}) VALUES(${fields.map((_, index) => `$${index + 1}`).join(",")}) ON CONFLICT(account_id,device_id) DO NOTHING`,
            values,
          )
        ).rowCount === 1
      );
    const updated = fields.filter(
      (field) => !["account_id", "issuer", "device_id"].includes(field),
    );
    return (
      (
        await this.database.query(
          `UPDATE longball.push_registrations SET ${updated.map((field, index) => `${field}=$${index + 1}`).join(",")} WHERE account_id=$${updated.length + 1} AND issuer=$${updated.length + 2} AND device_id=$${updated.length + 3} AND revision=$${updated.length + 4}`,
          [
            ...updated.map((field) => row[field]),
            principal.accountId,
            principal.issuer,
            row.device_id,
            expectedRevision,
          ],
        )
      ).rowCount === 1
    );
  }
  async deliveryTargets(accountId: string) {
    return (
      await this.database.query(
        "SELECT * FROM longball.push_targets_for_current_job($1)",
        [accountId],
      )
    ).rows as PushRow[];
  }
}
