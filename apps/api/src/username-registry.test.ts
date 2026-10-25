import { afterEach, describe, expect, it } from "vitest";
import { DevelopmentStore } from "./store";
import {
  initializeSqliteUsernameRegistry,
  reserveConfiguredUsernames,
} from "./username-registry";

const stores: DevelopmentStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function legacyStore() {
  const source = new DevelopmentStore(":memory:");
  stores.push(source);
  source.seedSynthetic();
  // These upgrade fixtures retain the canonical username/account columns. No
  // provider credentials or new account authority are supplied by a migration.
  source.database
    .exec(`CREATE TABLE lb_activation_children(account_id TEXT PRIMARY KEY REFERENCES accounts(id),username TEXT NOT NULL);
    CREATE TABLE spectator_pin_credentials(account_id TEXT PRIMARY KEY REFERENCES accounts(id),username TEXT NOT NULL);`);
  return source;
}
describe("private global username namespace upgrade", () => {
  it("backfills existing identities without changing usernames and denies another route claiming them with different case", () => {
    const source = legacyStore();
    source.database
      .prepare("INSERT INTO lb_activation_children VALUES(?,?)")
      .run("synthetic-account-player-01", "Roma.ThomasA");
    initializeSqliteUsernameRegistry(source);
    initializeSqliteUsernameRegistry(source);
    expect(
      source.database
        .prepare("SELECT username FROM lb_activation_children")
        .get(),
    ).toMatchObject({ username: "Roma.ThomasA" });
    expect(() =>
      source.database
        .prepare("INSERT INTO spectator_pin_credentials VALUES(?,?)")
        .run("synthetic-account-spectator", "ROMA.THOMASA"),
    ).toThrow("GLOBAL_USERNAME_CONFLICT");
    expect(
      source.database
        .prepare("SELECT count(*) AS count FROM spectator_pin_credentials")
        .get(),
    ).toMatchObject({ count: 0 });
    expect(
      source.database
        .prepare(
          "SELECT account_id FROM global_usernames WHERE normalized_username='roma.thomasa'",
        )
        .get(),
    ).toMatchObject({ account_id: "synthetic-account-player-01" });
  });
  it("refuses an already conflicting upgrade atomically and leaves both old identities intact for reconciliation", () => {
    const source = legacyStore();
    source.database
      .prepare("INSERT INTO lb_activation_children VALUES(?,?)")
      .run("synthetic-account-player-01", "Roma.Existing");
    source.database
      .prepare("INSERT INTO spectator_pin_credentials VALUES(?,?)")
      .run("synthetic-account-spectator", "ROMA.EXISTING");
    expect(() => initializeSqliteUsernameRegistry(source)).toThrow(
      "Existing usernames conflict",
    );
    expect(
      source.database
        .prepare("SELECT username FROM lb_activation_children")
        .get(),
    ).toMatchObject({ username: "Roma.Existing" });
    expect(
      source.database
        .prepare("SELECT username FROM spectator_pin_credentials")
        .get(),
    ).toMatchObject({ username: "ROMA.EXISTING" });
    expect(
      source.database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='global_usernames'",
        )
        .get(),
    ).toBeUndefined();
  });
  it("retains configured names idempotently and rolls back an attempted case-insensitive takeover or rename", async () => {
    const source = legacyStore();
    const configured = [
      { username: "Roma.Manager", accountId: "synthetic-account-manager" },
    ];
    await reserveConfiguredUsernames(source, configured);
    await reserveConfiguredUsernames(source, configured);
    await expect(
      reserveConfiguredUsernames(source, [
        { username: "roma.manager", accountId: "synthetic-account-spectator" },
      ]),
    ).rejects.toThrow("Existing usernames conflict");
    source.database
      .prepare("INSERT INTO spectator_pin_credentials VALUES(?,?)")
      .run("synthetic-account-spectator", "Roma.Supporter");
    expect(() =>
      source.database
        .prepare("UPDATE spectator_pin_credentials SET username='ROMA.MANAGER'")
        .run(),
    ).toThrow("GLOBAL_USERNAME_CONFLICT");
    expect(
      source.database
        .prepare("SELECT username FROM spectator_pin_credentials")
        .get(),
    ).toMatchObject({ username: "Roma.Supporter" });
    expect(
      source.database
        .prepare("SELECT count(*) AS count FROM global_usernames")
        .get(),
    ).toMatchObject({ count: 2 });
  });
  it("preserves the configured demo's established 64-character username limit when reserving legacy logins", async () => {
    const source = legacyStore();
    const username = "r".repeat(64);
    await reserveConfiguredUsernames(source, [
      { username, accountId: "synthetic-account-manager" },
    ]);
    expect(
      source.database
        .prepare("SELECT normalized_username FROM global_usernames")
        .get(),
    ).toMatchObject({ normalized_username: username });
    await expect(
      reserveConfiguredUsernames(source, [
        { username: "r".repeat(65), accountId: "synthetic-account-spectator" },
      ]),
    ).rejects.toThrow("established credential configuration format");
  });
});
