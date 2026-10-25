import { AccessError } from "../../../packages/application/src/access";
import type { DevelopmentStore } from "./store";
import { PostgresStore } from "./postgres-store";

const usernameTables = [
  "lb_activation_children",
  "lb_spectator_activation_accounts",
  "spectator_pin_credentials",
] as const;

/** A private, durable case-insensitive namespace. It is never exposed as a user directory. */
export function initializeSqliteUsernameRegistry(
  source: DevelopmentStore,
): void {
  const install = () => {
    source.database.exec(`CREATE TABLE IF NOT EXISTS global_usernames(
      normalized_username TEXT PRIMARY KEY CHECK(normalized_username=lower(normalized_username)),
      account_id TEXT NOT NULL REFERENCES accounts(id));`);
    for (const table of usernameTables) {
      if (
        !source.database
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(table)
      )
        continue;
      // Do not rename or silently merge previously claimed identities during an upgrade.
      const existing = source.database
        .prepare(`SELECT username,account_id FROM ${table}`)
        .all();
      for (const row of existing)
        claimSqliteUsername(
          source,
          String(row.username),
          String(row.account_id),
        );
      for (const event of [
        "INSERT",
        "UPDATE OF username,account_id",
      ] as const) {
        const suffix = event === "INSERT" ? "insert" : "update";
        source.database
          .exec(`CREATE TRIGGER IF NOT EXISTS ${table}_global_username_${suffix}
          BEFORE ${event} ON ${table} BEGIN
          INSERT OR IGNORE INTO global_usernames(normalized_username,account_id) VALUES(lower(NEW.username),NEW.account_id);
          SELECT CASE WHEN EXISTS(SELECT 1 FROM global_usernames WHERE normalized_username=lower(NEW.username) AND account_id<>NEW.account_id)
            THEN RAISE(ABORT,'GLOBAL_USERNAME_CONFLICT') END;
          END;`);
      }
    }
  };
  if (source.database.isTransaction) install();
  else source.transaction(install);
}

function claimSqliteUsername(
  source: DevelopmentStore,
  username: string,
  accountId: string,
): void {
  const row = source.database
    .prepare(
      "SELECT account_id FROM global_usernames WHERE normalized_username=lower(?)",
    )
    .get(username);
  if (row && row.account_id !== accountId)
    throw new Error(
      "Existing usernames conflict; preserve the database and reconcile the identities.",
    );
  source.database
    .prepare(
      "INSERT OR IGNORE INTO global_usernames(normalized_username,account_id) VALUES(lower(?),?)",
    )
    .run(username, accountId);
}

/** Called once before accepting demo logins. Configured credentials keep their existing names. */
export async function reserveConfiguredUsernames(
  source: DevelopmentStore | PostgresStore,
  accounts: readonly { username: string; accountId: string }[],
): Promise<void> {
  if (!accounts.length) return;
  if (
    accounts.some(
      (account) => !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(account.username),
    )
  )
    throw new Error(
      "A configured demo username does not match the established credential configuration format.",
    );
  if (source instanceof PostgresStore) {
    await source.transaction(async () => {
      for (const account of accounts) {
        await source.execute("SELECT claim_configured_demo_username($1,$2)", [
          account.username,
          account.accountId,
        ]);
      }
    });
  } else {
    initializeSqliteUsernameRegistry(source);
    source.transaction(() => {
      for (const account of accounts) {
        const row = source.database
          .prepare(
            "SELECT 1 FROM accounts WHERE id=? AND issuer='urn:longball:synthetic'",
          )
          .get(account.accountId);
        if (!row)
          throw new Error(
            "A configured demo username requires an existing demo account.",
          );
        claimSqliteUsername(source, account.username, account.accountId);
      }
    });
  }
}

export function isUsernameCollision(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    code?: string;
    constraint?: string;
    message?: string;
  };
  return (
    (value.code === "23505" && value.constraint === "global_username") ||
    (value.code === "ERR_SQLITE_ERROR" &&
      /GLOBAL_USERNAME_CONFLICT/.test(value.message ?? ""))
  );
}
export function usernameAllocationUnavailable(): never {
  throw new AccessError(
    "IDENTITY_ALLOCATION_UNAVAILABLE",
    503,
    "A unique username could not be allocated. Try a different name.",
  );
}

/** The feature tables are installed separately from core PostgreSQL migrations. */
export async function installPostgresChildUsernameRegistry(
  source: PostgresStore,
): Promise<void> {
  if (source.db.migrationMode !== "apply") return;
  await source.execute("SELECT install_child_username_registry()");
}
