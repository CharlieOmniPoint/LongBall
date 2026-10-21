import { dirname, join } from 'node:path';
import { createRuntimeApi, type ApiOptions } from './server';
import { PostgresStore } from './postgres-store';
import { PgMediaService } from './postgres-media';
import { PostgresActivationService } from './postgres-activation';
import type { RuntimeStore } from './runtime-store';

export async function createPostgresApi(options: ApiOptions & { connectionString: string; migrationMode?:'apply'|'verify' }) {
  const store = await PostgresStore.open(options.connectionString, options.now, {migrationMode:options.migrationMode});
  try {
    if (options.syntheticAuth) await store.seedSynthetic();
    const media = await PgMediaService.open({ directory: options.mediaDirectory ?? join(dirname(options.databasePath), 'media'), database: store.db, scanner: options.mediaScanner, now: options.now });
    const activation = await new PostgresActivationService({ store, provider: options.activationProvider, policy: options.activationPolicy }).initialize();
    const port: RuntimeStore = store;
    return createRuntimeApi(options, store, port, media, activation);
  } catch (error) { await store.close(); throw error; }
}
