import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { PostgresStore } from '../apps/api/src/postgres-store';
import { PgMediaService } from '../apps/api/src/postgres-media';
import { PostgresActivationService } from '../apps/api/src/postgres-activation';
import { applyRuntimeGrants } from '../apps/api/src/runtime-grants';

const { Pool } = createRequire(resolve('apps/api/package.json'))('pg') as typeof import('pg');
async function bootstrap(): Promise<void> {
  if (process.env.LONGBALL_IDENTITY_TRIAL_BOOTSTRAP !== '1') throw new Error('EXPLICIT_DISPOSABLE_BOOTSTRAP_REQUIRED');
  const source = process.env.LONGBALL_POSTGRES_TEST_URL;
  if (!source) throw new Error('DISPOSABLE_RUNTIME_SELECTOR_REQUIRED');
  const adminUrl = new URL(source);
  if (!['postgres:', 'postgresql:'].includes(adminUrl.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(adminUrl.hostname) || adminUrl.pathname !== '/longball_runtime_test' || adminUrl.password) throw new Error('DISPOSABLE_LOOPBACK_RUNTIME_REQUIRED');
  const database = 'longball_identity_trial';
  const roles = { migrator: 'longball_identity_trial_migrator', api: 'longball_identity_trial_api', worker: 'longball_identity_trial_worker' };
  const directory = resolve('.local/identity/database');
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  if (['migration.url', 'runtime.url', 'worker.url', 'database.env'].some(name => existsSync(join(directory, name)))) throw new Error('EXISTING_TRIAL_SELECTORS_PRESERVED');
  const passwords = Object.fromEntries(Object.keys(roles).map(kind => [kind, randomBytes(32).toString('hex')]));
  const admin = new Pool({ connectionString: adminUrl.toString() });
  try {
    const existing = await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [database]);
    const existingRoles = await admin.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])', [Object.values(roles)]);
    if (existing.rowCount || existingRoles.rowCount) throw new Error('EXISTING_TRIAL_DATABASE_OR_ROLES_PRESERVED');
    for (const [kind, role] of Object.entries(roles)) {
      const command = await admin.query<{ statement: string }>("SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',$1::text,$2::text) AS statement", [role, passwords[kind]]);
      await admin.query(command.rows[0].statement);
    }
    await admin.query('CREATE DATABASE longball_identity_trial');
  } finally { await admin.end(); }
  const target = new URL(adminUrl); target.pathname = `/${database}`;
  const owner = new Pool({ connectionString: target.toString() });
  try {
    await owner.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await owner.query('REVOKE ALL ON DATABASE longball_identity_trial FROM PUBLIC');
    await owner.query('GRANT CONNECT ON DATABASE longball_identity_trial TO longball_identity_trial_migrator,longball_identity_trial_api,longball_identity_trial_worker');
    await owner.query('CREATE SCHEMA longball AUTHORIZATION longball_identity_trial_migrator');
    await owner.query('REVOKE ALL ON SCHEMA longball FROM PUBLIC');
  } finally { await owner.end(); }
  const urls = Object.fromEntries(Object.entries(roles).map(([kind, role]) => {
    const value = new URL(target); value.username = role; value.password = passwords[kind]; return [kind, value.toString()];
  }));
  const store = await PostgresStore.open(urls.migrator, Date.now, { migrationMode: 'apply' });
  const mediaDirectory = join(directory, 'media');
  try {
    await PgMediaService.open({ directory: mediaDirectory, database: store.db });
    await new PostgresActivationService({ store }).initialize();
    await applyRuntimeGrants(store.db, { apiRole: roles.api, workerRole: roles.worker });
  } finally { await store.close(); }
  for (const [name, value] of [['migration.url', urls.migrator], ['runtime.url', urls.api], ['worker.url', urls.worker]]) writeFileSync(join(directory, name), `${value}\n`, { flag: 'wx', mode: 0o600 });
  const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(join(directory, 'database.env'), [
    `export LONGBALL_IDENTITY_TRIAL_MIGRATION_DATABASE_URL_FILE=${shell(join(directory, 'migration.url'))}`,
    `export LONGBALL_IDENTITY_TRIAL_RUNTIME_DATABASE_URL_FILE=${shell(join(directory, 'runtime.url'))}`,
    `export LONGBALL_IDENTITY_TRIAL_WORKER_DATABASE_URL_FILE=${shell(join(directory, 'worker.url'))}`,
    `export LONGBALL_IDENTITY_TRIAL_MEDIA_DIRECTORY=${shell(mediaDirectory)}`,
    '',
  ].join('\n'), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: 'ready', database, roleCount: 3, servingSuperuser: false, fixtureSeeded: false, selectorFile: '.local/identity/database/database.env' }));
}
await bootstrap().catch(error => {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'BOOTSTRAP_FAILED';
  console.error(JSON.stringify({ status: 'failed', code })); process.exitCode = 1;
});
