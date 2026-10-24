import { PostgresStore } from './postgres-store';
import { PgMediaService } from './postgres-media';
import { PostgresActivationService } from './postgres-activation';
import { readDatabaseUrl } from './database-config';
import { applyRuntimeGrants } from './runtime-grants';

const connectionString = readDatabaseUrl(process.env, 'LONGBALL_MIGRATION_DATABASE_URL');
if (!connectionString) throw new Error('Configure the dedicated LONGBALL_MIGRATION_DATABASE_URL or mounted URL secret.');
if (process.env.LONGBALL_DATABASE_URL || process.env.LONGBALL_DATABASE_URL_FILE) throw new Error('The migrator must not receive runtime database credentials.');
const store = await PostgresStore.open(connectionString, Date.now, { migrationMode: 'apply' });
try {
  await PgMediaService.open({ directory: process.env.LONGBALL_MEDIA_DIRECTORY ?? '/data/media', database: store.db });
  await new PostgresActivationService({ store }).initialize();
  // The schema owner grants only the table operations used by these two processes.
  // Role creation/passwords belong to the database bootstrap administrator, not this job.
  await applyRuntimeGrants(store.db);
  console.log('LongBall PostgreSQL schema and restricted runtime grants are ready. No production policy approvals were created.');
} finally { await store.close(); }
