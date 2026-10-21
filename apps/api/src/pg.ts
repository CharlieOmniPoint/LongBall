import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, types, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { readFile } from 'node:fs/promises';

export interface PgQuery {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
}
export type PgMigrationMode = 'apply' | 'verify';

/** Actual PostgreSQL connections. A transaction pins every awaited repository call to one client. */
export class PgDatabase implements PgQuery {
  readonly pool: Pool;
  readonly migrationMode: PgMigrationMode;
  private readonly context = new AsyncLocalStorage<PoolClient>();
  constructor(connectionString: string, options: { maximumConnections?: number; applicationName?: string; migrationMode?: PgMigrationMode } = {}) {
    let url: URL;
    try { url = new URL(connectionString); } catch { throw new Error('A valid PostgreSQL connection URL is required.'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('A PostgreSQL connection URL is required.');
    this.migrationMode = options.migrationMode ?? 'apply';
    this.pool = new Pool({ connectionString, max: options.maximumConnections ?? 10, application_name: options.applicationName ?? 'longball-api',
      connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000,
      options: '-c search_path=longball,pg_catalog -c statement_timeout=15000 -c lock_timeout=10000',
      types: { getTypeParser: (oid, format) => {
        // Domain documents stay serialized at the repository boundary; physical columns are JSONB.
        if (oid === 114 || oid === 3802) return (value: string) => value;
        if (oid === 20) return (value: string) => { const parsed = Number(value); if (!Number.isSafeInteger(parsed)) throw new Error('PostgreSQL integer exceeds the application range.'); return parsed; };
        return types.getTypeParser(oid, format);
      } },
    });
    // Pool failures contain connection details; expose only a bounded code to operators.
    this.pool.on('error', () => { console.error('LONGBALL_POSTGRES_IDLE_CONNECTION_ERROR'); });
  }
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values: readonly unknown[] = []): Promise<QueryResult<T>> {
    return (this.context.getStore() ?? this.pool).query<T>(sql, [...values]);
  }
  async transaction<T>(work: () => Promise<T> | T): Promise<T> {
    if (this.context.getStore()) return work();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Conservative initial deployment: serialize domain mutations across API and worker processes.
      // This is a real transaction advisory lock, not an in-process mutex or a production load claim.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('longball:domain-write:v1', 0))");
      const result = await this.context.run(client, work);
      await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async migrate(): Promise<void> {
    if (this.migrationMode === 'verify') {
      const versions = await this.query<{ version: number }>('SELECT version FROM longball.schema_migrations ORDER BY version');
      if (versions.rows.some(row => row.version > 4)) throw new Error('This PostgreSQL schema is newer than the application. Preserve it and use a compatible build.');
      if (![2, 3, 4].every(version => versions.rows.some(row => row.version === version))) throw new Error('PostgreSQL migrations are required. Run the separate migrator before starting the runtime.');
      return;
    }
    const migration = await readFile(new URL('../migrations/postgresql/002_runtime.sql', import.meta.url), 'utf8');
    const clockReviewMigration = await readFile(new URL('../migrations/postgresql/003_clock_review.sql', import.meta.url), 'utf8');
    const accountRequestsMigration = await readFile(new URL('../migrations/postgresql/004_account_requests.sql', import.meta.url), 'utf8');
    await this.transaction(async () => {
      const schema = await this.query<{ namespace: string | null }>("SELECT to_regnamespace('longball')::text AS namespace");
      if (!schema.rows[0]?.namespace) await this.query('CREATE SCHEMA longball');
      await this.query('CREATE TABLE IF NOT EXISTS longball.schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      const versions = await this.query<{ version: number }>('SELECT version FROM longball.schema_migrations ORDER BY version');
      if (versions.rows.some(row => row.version > 4)) throw new Error('This PostgreSQL schema is newer than the application. Preserve it and use a compatible build.');
      if (!versions.rows.some(row => row.version === 2)) {
        await this.query(migration);
        await this.query('INSERT INTO longball.schema_migrations(version) VALUES(2)');
      }
      if (!versions.rows.some(row => row.version === 3)) { await this.query(clockReviewMigration); await this.query('INSERT INTO longball.schema_migrations(version) VALUES(3)'); }
      if (!versions.rows.some(row => row.version === 4)) { await this.query(accountRequestsMigration); await this.query('INSERT INTO longball.schema_migrations(version) VALUES(4)'); }
    });
  }
  async close(): Promise<void> { await this.pool.end(); }
}
