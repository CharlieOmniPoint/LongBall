import { spawnSync } from "node:child_process";

// These suites create isolated databases and non-bypass roles. Never silently
// replace real PostgreSQL migration acceptance with skipped tests.
if (!process.env.LONGBALL_POSTGRES_TEST_URL) {
  console.error("Set LONGBALL_POSTGRES_TEST_URL to a disposable PostgreSQL administrator URL before checking migrations.");
  process.exit(1);
}
const result = spawnSync("pnpm", [
  "exec", "vitest", "run", "--config", "apps/api/vitest.config.ts",
  "apps/api/src/migration.test.ts",
  "apps/api/src/postgres-privacy-migration.test.ts",
  "apps/api/src/postgres-invitation-migration.test.ts",
], { stdio: "inherit" });
if (result.error) {
  console.error("The migration test runner could not start.");
  process.exit(1);
}
process.exit(result.status ?? 1);
