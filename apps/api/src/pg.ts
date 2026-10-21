import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, types, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { readFile } from 'node:fs/promises';

export interface PgQuery {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
}
export type PgMigrationMode = 'apply' | 'verify';
export type PgApplicationContext =
  | { kind: 'identity'; issuer: string; subject: string; nowMs: number }
  | { kind: 'actor'; accountId: string; issuer: string; subject: string; strongAuth: boolean; authenticatedAtMs: number;
      requestedRole?: 'administrator' | 'manager' | 'player' | 'spectator' | 'default'; clubId?: string; teamId?: string; seasonId?: string;
      matchId?: string; operation?: string; nowMs: number; provisionAccountId?: string; staffTargetAccountId?: string; newSeasonId?: string; invitationTokenHash?: string }
  | { kind: 'activation_token'; tokenHash: string; activationId?: string; completionVerified?: true; nowMs: number }
  | { kind: 'invitation_activation'; tokenHash: string; activationId?: string; provisionAccountId?: string; completionVerified?: true; nowMs: number }
  | { kind: 'worker_claim'; jobKind: 'award.finalise' | 'notification.dispatch' | 'report.export'; nowMs: number }
  | { kind: 'worker_job'; jobId: string; leaseToken: string; clubId: string; teamId: string; seasonId: string; nowMs: number };
interface ApplicationFrame { value: Readonly<PgApplicationContext>; active: boolean; key: string; parent?: ApplicationFrame }
interface TransactionFrame { client: PoolClient; applicationKey: string | null; active: boolean; writeLock: 'none' | 'global' | 'team' }
const contextKey = (context: PgApplicationContext) => JSON.stringify(Object.entries(context).sort(([a], [b]) => a.localeCompare(b)));
function matchWriteTeam(context: Readonly<PgApplicationContext> | undefined): string | null {
  if(context?.kind!=='actor'||context.operation!=='match.manage'||!['manager','default'].includes(context.requestedRole??''))return null;
  const ids=[context.clubId,context.teamId,context.seasonId,context.matchId];
  if(ids.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,150}$/.test(id)))return null;
  // The resolved club/team pair deliberately covers every season and match of a team.
  return JSON.stringify([context.clubId,context.teamId]);
}
function validateContext(context: PgApplicationContext): void {
  if (!context || typeof context !== 'object' || !Number.isSafeInteger(context.nowMs) || context.nowMs < 0) throw new Error('Invalid PostgreSQL application context.');
  const required: Record<PgApplicationContext['kind'], string[]> = {
    identity: ['issuer', 'subject'], actor: ['accountId', 'issuer', 'subject'], activation_token: ['tokenHash'], invitation_activation: ['tokenHash'], worker_claim: ['jobKind'], worker_job: ['jobId', 'leaseToken', 'clubId', 'teamId', 'seasonId'],
  };
  if (!Object.hasOwn(required, context.kind) || required[context.kind].some(name => typeof (context as unknown as Record<string, unknown>)[name] !== 'string' || !(context as unknown as Record<string, string>)[name] || (context as unknown as Record<string, string>)[name].length > 2048)) throw new Error('Invalid PostgreSQL application context.');
  if (context.kind === 'actor' && (typeof context.strongAuth !== 'boolean' || !Number.isSafeInteger(context.authenticatedAtMs) || context.authenticatedAtMs < 0 || (context.requestedRole !== undefined && !['administrator', 'manager', 'player', 'spectator', 'default'].includes(context.requestedRole)))) throw new Error('Invalid PostgreSQL actor context.');
  if (['activation_token','invitation_activation'].includes(context.kind) && 'tokenHash' in context && (!/^[a-f0-9]{64}$/.test(context.tokenHash) || ('completionVerified' in context && context.completionVerified !== undefined && context.completionVerified !== true))) throw new Error('Invalid PostgreSQL activation context.');
  if (context.kind === 'worker_claim' && !['award.finalise', 'notification.dispatch', 'report.export'].includes(context.jobKind)) throw new Error('Invalid PostgreSQL job context.');
  if (context.kind === 'worker_job' && !/^[a-f0-9]{64}$/.test(context.leaseToken)) throw new Error('Invalid PostgreSQL job capability.');
}
function isNarrowing(parent: PgApplicationContext, child: PgApplicationContext): boolean {
  if (parent.kind === 'identity' && child.kind === 'actor') return parent.issuer === child.issuer && parent.subject === child.subject;
  if (parent.kind !== child.kind) return false;
  for (const [name, value] of Object.entries(parent)) {
    if (name === 'nowMs') continue;
    if ((child as unknown as Record<string, unknown>)[name] !== value) return false;
  }
  return child.nowMs >= parent.nowMs;
}


/** Actual PostgreSQL connections. A transaction pins every awaited repository call to one client. */
export class PgDatabase implements PgQuery {
  readonly pool: Pool;
  readonly migrationMode: PgMigrationMode;
  private readonly transactions = new AsyncLocalStorage<TransactionFrame>();
  private readonly applications = new AsyncLocalStorage<ApplicationFrame>();
  get applicationContext(): Readonly<PgApplicationContext> | undefined {
    const frame = this.applications.getStore();
    for (let ancestor = frame; ancestor; ancestor = ancestor.parent) if (!ancestor.active) throw new Error('PostgreSQL application context has ended.');
    return frame?.value;
  }
  async withContext<T>(value: PgApplicationContext, work: () => Promise<T> | T): Promise<T> {
    validateContext(value);
    const immutable = Object.freeze({ ...value }) as Readonly<PgApplicationContext>;
    const parent = this.applicationContext;
    if (parent && !isNarrowing(parent, immutable)) throw new Error('PostgreSQL application context cannot widen an existing scope.');
    const key = contextKey(immutable);
    const transaction = this.transactions.getStore();
    if (transaction && !transaction.active) throw new Error('PostgreSQL transaction has ended.');
    if (transaction && transaction.applicationKey !== key) throw new Error('Narrow PostgreSQL application context before opening its SQL transaction.');
    const frame: ApplicationFrame = { value: immutable, active: true, key, parent: this.applications.getStore() };
    try { return await this.applications.run(frame, work); }
    finally { frame.active = false; }
  }
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
  async query<T extends QueryResultRow = QueryResultRow>(sql: string, values: readonly unknown[] = []): Promise<QueryResult<T>> {
    const application = this.applicationContext;
    const transaction = this.transactions.getStore();
    if (transaction) {
      if (!transaction.active) throw new Error('PostgreSQL transaction has ended.');
      if (transaction.applicationKey !== (application ? contextKey(application) : null)) throw new Error('PostgreSQL transaction context changed.');
      return transaction.client.query<T>(sql, [...values]);
    }
    if (!application) return this.pool.query<T>(sql, [...values]);
    return this.inTransaction(() => this.query<T>(sql, values), false);
  }
  async transaction<T>(work: () => Promise<T> | T): Promise<T> { return this.inTransaction(work, true); }
  private async inTransaction<T>(work: () => Promise<T> | T, lockWrites: boolean): Promise<T> {
    const application = this.applicationContext;
    const applicationKey = application ? contextKey(application) : null;
    const existing = this.transactions.getStore();
    if (existing) {
      if (!existing.active) throw new Error('PostgreSQL transaction has ended.');
      if (existing.applicationKey !== applicationKey) throw new Error('PostgreSQL transaction context changed.');
      if(lockWrites&&existing.writeLock==='none')throw new Error('An unlocked PostgreSQL transaction cannot be upgraded to a write transaction.');
      return work();
    }
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      if (application) await client.query("SELECT set_config('longball.context',$1,true)", [JSON.stringify(application)]);
      const team=lockWrites?matchWriteTeam(application):null;
      if(lockWrites){
        if(team!==null){
          // Shared legacy barrier first: old/global writers remain exclusive
          // against every match transaction, including those on independent teams.
          await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('longball:domain-write:v1', 0))");
          // Two-int advisory keys inhabit a separate namespace from the legacy
          // bigint key. Hash collisions only serialize extra teams; never bypass locks.
          await client.query("SELECT pg_advisory_xact_lock(hashtext('longball:team-write:v1'),hashtext($1))",[team]);
        }else await client.query("SELECT pg_advisory_xact_lock(hashtextextended('longball:domain-write:v1', 0))");
      }
      const transaction: TransactionFrame = { client, applicationKey, active: true, writeLock:lockWrites?(team===null?'global':'team'):'none' };
      let result: T;
      try { result = await this.transactions.run(transaction, work); }
      finally { transaction.active = false; }
      await client.query('COMMIT'); return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { discard = true; }
      throw error;
    } finally { client.release(discard); }
  }
  async migrate(): Promise<void> {
    if (this.migrationMode === 'verify') {
      const versions = await this.query<{ version: number }>('SELECT version FROM longball.schema_migrations ORDER BY version');
      if (versions.rows.some(row => row.version > 16)) throw new Error('This PostgreSQL schema is newer than the application. Preserve it and use a compatible build.');
      if (![2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].every(version => versions.rows.some(row => row.version === version))) throw new Error('PostgreSQL migrations are required. Run the separate migrator before starting the runtime.');
      const protectedTables = ['clubs','teams','team_seasons','game_contexts','accounts','memberships','matches','documents','devices','controller_grants','controller_history','events','streams','conflicting_submissions','transfers','clock_challenges','clock_mappings','reconciliation_proposals','audit','idempotency','privacy_requests','privacy_pending_keys','jobs','brand_assets','brand_slots','spectator_invitations','lb_spectator_activation_accounts','lb_spectator_activation_attempts','native_app_devices','team_privilege_states','team_privilege_decisions','push_registrations','report_exports'];
      const security = await this.query<{ relname: string; relrowsecurity: boolean; policies: number }>(`SELECT c.relname,c.relrowsecurity,(SELECT count(*)::integer FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid) AS policies FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='longball' AND c.relname=ANY($1::text[])`, [protectedTables]);
      if (security.rows.length !== protectedTables.length || security.rows.some(row => !row.relrowsecurity || row.policies < 1)) throw new Error('PostgreSQL row security is missing. Run the separate migrator before starting runtime.');
      return;
    }
    const migration = await readFile(new URL('../migrations/postgresql/002_runtime.sql', import.meta.url), 'utf8');
    const clockReviewMigration = await readFile(new URL('../migrations/postgresql/003_clock_review.sql', import.meta.url), 'utf8');
    const accountRequestsMigration = await readFile(new URL('../migrations/postgresql/004_account_requests.sql', import.meta.url), 'utf8');
    const scopeSecurityMigration = await readFile(new URL('../migrations/postgresql/005_scope_security.sql', import.meta.url), 'utf8');
    const awardNotificationsMigration = await readFile(new URL('../migrations/postgresql/006_award_notifications.sql', import.meta.url), 'utf8');
    const workerBoundariesMigration = await readFile(new URL('../migrations/postgresql/007_worker_boundaries.sql', import.meta.url), 'utf8');
    const controllerRevocationMigration = await readFile(new URL('../migrations/postgresql/008_controller_revocation.sql', import.meta.url), 'utf8');
    const dispatchClockMigration = await readFile(new URL('../migrations/postgresql/009_dispatch_database_clock.sql', import.meta.url), 'utf8');
    const brandAssetsMigration = await readFile(new URL('../migrations/postgresql/010_brand_assets.sql', import.meta.url), 'utf8');
    const spectatorCapabilitiesMigration = await readFile(new URL('../migrations/postgresql/011_spectator_capabilities.sql', import.meta.url), 'utf8');
    const heicMigration = await readFile(new URL('../migrations/postgresql/012_heic_support.sql', import.meta.url), 'utf8');
    const teamPrivilegesMigration = await readFile(new URL('../migrations/postgresql/013_team_privileges.sql', import.meta.url), 'utf8');
    const pushRegistrationMigration = await readFile(new URL('../migrations/postgresql/014_push_registrations.sql', import.meta.url), 'utf8');
    const privilegeAuditClockMigration = await readFile(new URL('../migrations/postgresql/015_team_privilege_audit_clock.sql', import.meta.url), 'utf8');
    const reportExportsMigration = await readFile(new URL('../migrations/postgresql/016_report_exports.sql', import.meta.url), 'utf8');
    await this.transaction(async () => {
      const schema = await this.query<{ namespace: string | null }>("SELECT to_regnamespace('longball')::text AS namespace");
      if (!schema.rows[0]?.namespace) await this.query('CREATE SCHEMA longball');
      await this.query('CREATE TABLE IF NOT EXISTS longball.schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      const versions = await this.query<{ version: number }>('SELECT version FROM longball.schema_migrations ORDER BY version');
      if (versions.rows.some(row => row.version > 16)) throw new Error('This PostgreSQL schema is newer than the application. Preserve it and use a compatible build.');
      if (!versions.rows.some(row => row.version === 2)) {
        await this.query(migration);
        await this.query('INSERT INTO longball.schema_migrations(version) VALUES(2)');
      }
      if (!versions.rows.some(row => row.version === 3)) { await this.query(clockReviewMigration); await this.query('INSERT INTO longball.schema_migrations(version) VALUES(3)'); }
      if (!versions.rows.some(row => row.version === 4)) { await this.query(accountRequestsMigration); await this.query('INSERT INTO longball.schema_migrations(version) VALUES(4)'); }
      if (!versions.rows.some(row => row.version === 5)) { await this.query(scopeSecurityMigration); await this.query('INSERT INTO longball.schema_migrations(version) VALUES(5)'); }
      if (!versions.rows.some(row => row.version === 6)) { await this.query(awardNotificationsMigration); await this.query('INSERT INTO longball.schema_migrations(version) VALUES(6)'); }
      if (!versions.rows.some(row => row.version === 7)) { await this.query(workerBoundariesMigration); await this.query('INSERT INTO longball.schema_migrations(version) VALUES(7)'); }
      if (!versions.rows.some(row => row.version === 8)) { await this.query(controllerRevocationMigration); await this.query('INSERT INTO longball.schema_migrations(version) VALUES(8)'); }
      if (!versions.rows.some(row => row.version === 9)) { await this.query(dispatchClockMigration); await this.query('INSERT INTO longball.schema_migrations(version) VALUES(9)'); }
      if (!versions.rows.some(row => row.version === 10)) { await this.query(brandAssetsMigration); await this.query('INSERT INTO longball.schema_migrations(version) VALUES(10)'); }
      if (!versions.rows.some(row => row.version === 11)) { await this.query(spectatorCapabilitiesMigration); await this.query('INSERT INTO longball.schema_migrations(version) VALUES(11)'); }
      if (!versions.rows.some(row => row.version === 12)) { await this.query(heicMigration); await this.query('INSERT INTO longball.schema_migrations(version) VALUES(12)'); }
      if (!versions.rows.some(row => row.version === 13)) { await this.query(teamPrivilegesMigration); await this.query('INSERT INTO longball.schema_migrations(version) VALUES(13)'); }
      if (!versions.rows.some(row => row.version === 14)) { await this.query(pushRegistrationMigration); await this.query('INSERT INTO longball.schema_migrations(version) VALUES(14)'); }
      if (!versions.rows.some(row => row.version === 15)) { await this.query(privilegeAuditClockMigration); await this.query('INSERT INTO longball.schema_migrations(version) VALUES(15)'); }
      if (!versions.rows.some(row => row.version === 16)) { await this.query(reportExportsMigration); await this.query('INSERT INTO longball.schema_migrations(version) VALUES(16)'); }
    });
  }
  async close(): Promise<void> { await this.pool.end(); }
}
