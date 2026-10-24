import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
// This operational check executes from /app inside the production image.
const { Pool } = createRequire(resolve('package.json'))('pg');

const kind = process.argv[2];
if (!['api', 'worker'].includes(kind)) throw new Error('Choose api or worker.');
const connectionString = readFileSync(process.env.LONGBALL_DATABASE_URL_FILE, 'utf8').trim();
const pool = new Pool({ connectionString });
const client = await pool.connect();
const checks = [];
async function denied(name, sql) {
  await client.query('SAVEPOINT permission_check');
  let rejected = false;
  try { await client.query(sql); } catch (error) { rejected = error.code === '42501'; }
  await client.query('ROLLBACK TO SAVEPOINT permission_check');
  if (!rejected) throw new Error(`${name} was not denied by PostgreSQL.`);
  checks.push(name);
}
try {
  await client.query('BEGIN');
  const { rows: [role] } = await client.query("SELECT current_user AS name,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,has_schema_privilege(current_user,'longball','CREATE') AS schema_create,has_database_privilege(current_user,current_database(),'CREATE') AS database_create FROM pg_roles WHERE rolname=current_user");
  if (role.name !== `longball_${kind}` || Object.entries(role).some(([key, value]) => key !== 'name' && value !== false)) throw new Error('Unexpected elevated runtime role.');
  checks.push('restricted_role_attributes');
  await denied('cannot_create_schema_objects', 'CREATE TABLE longball.runtime_must_not_create(id text)');
  await denied('cannot_create_public_objects', 'CREATE TABLE public.runtime_must_not_create(id text)');
  await denied('cannot_alter_schema', 'ALTER TABLE longball.jobs ADD COLUMN runtime_must_not_add text');
  await denied('cannot_change_migration_version', 'UPDATE longball.schema_migrations SET version=version');
  const versions = (await client.query('SELECT version FROM longball.schema_migrations ORDER BY version')).rows.map(row => row.version);
  if (JSON.stringify(versions) !== '[2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20]') throw new Error('Expected runtime migration versions 2 through 20.');
  checks.push('schema20_verified');
  const purpose=(await client.query('SELECT longball.runtime_purpose() AS value')).rows[0]?.value;
  if(purpose!==kind)throw new Error('Runtime login purpose does not match its command.');
  const protectedTables=(await client.query("SELECT count(*)::integer AS value FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='longball' AND c.relrowsecurity")).rows[0]?.value;
  if(protectedTables<38)throw new Error('Expected core, privilege, push and feature row security.');
  for(const table of ['accounts','matches','documents','jobs','report_exports'])if((await client.query(`SELECT * FROM longball.${table}`)).rowCount!==0)throw new Error('Context-free data access was not denied.');
  checks.push('login_purpose_and_context_free_rls');
  if (kind === 'api') {
    await denied('api_cannot_delete_domain_rows', "DELETE FROM longball.teams WHERE id='runtime-permission-proof'");
    await denied('api_cannot_rewrite_audit', 'UPDATE longball.audit SET outcome=outcome');
    await client.query('SELECT version FROM longball.media_schema_migrations');
    const mediaVersions=(await client.query('SELECT version FROM longball.media_schema_migrations ORDER BY version')).rows.map(row=>row.version);
    if(JSON.stringify(mediaVersions)!=='[1,2,3,4]')throw new Error('Expected media security migrations 1 through 4.');
    await client.query('SELECT version FROM longball.lb_activation_schema');
    await client.query('SELECT team_id,season_id,affected_memberships_json FROM longball.privacy_requests WHERE false');
    await client.query("INSERT INTO longball.privacy_pending_keys(business_key,request_id) SELECT 'permission-proof','permission-proof' WHERE false");
    await client.query('UPDATE longball.privacy_pending_keys SET business_key=business_key WHERE false');
    checks.push('api_scoped_request_schema_and_key_access');
    checks.push('api_feature_verification_and_request_schema');
    await denied('api_cannot_purge_report_exports', 'SELECT longball.purge_report_exports()');
    await denied('api_cannot_resolve_raw_report_source', "SELECT longball.report_export_fingerprint_raw('permission-proof','permission-proof')");
    await denied('api_cannot_claim_worker_job', "SELECT * FROM longball.claim_due_job('award.finalise',0,repeat('a',64))");
    for(const table of ['brand_assets','brand_slots','spectator_invitations','lb_spectator_activation_accounts','lb_spectator_activation_attempts','native_app_devices','team_privilege_states','team_privilege_decisions','push_registrations'])if((await client.query(`SELECT * FROM longball.${table}`)).rowCount!==0)throw new Error('Context-free branding/identity/privilege/push data access was not denied.');
    checks.push('api_context_free_branding_and_identity_denied');
    await denied('api_cannot_resolve_worker_push_destinations', "SELECT * FROM longball.push_targets_for_current_job('runtime-permission-proof')");
  } else {
    await client.query('SELECT id FROM longball.jobs');
    await client.query('UPDATE longball.jobs SET attempts=attempts WHERE false');
    await client.query('UPDATE longball.documents SET revision=revision WHERE false');
    await client.query('SELECT id FROM longball.accounts');
    await denied('worker_cannot_insert_unscoped_job', "INSERT INTO longball.jobs(id,business_key,kind,payload_json,due_at) VALUES('permission-proof','permission-proof','notification.dispatch','{}',0)");
    await client.query("SELECT set_config('longball.context',$1,true)",[JSON.stringify({kind:'identity',issuer:'urn:longball:synthetic',subject:'synthetic-account-manager',nowMs:Date.now()})]);
    if((await client.query('SELECT * FROM longball.accounts')).rowCount!==0)throw new Error('Worker forged identity escaped its login purpose.');
    checks.push('worker_cannot_forge_api_identity');
    await denied('worker_cannot_change_accounts', 'UPDATE longball.accounts SET status=status');
    await denied('worker_cannot_read_private_media_manifests', 'SELECT id FROM longball.media_uploads');
    await denied('worker_cannot_read_privacy_requests', 'SELECT id FROM longball.privacy_requests');
    await denied('worker_cannot_read_privacy_pending_keys', 'SELECT request_id FROM longball.privacy_pending_keys');
    await denied('worker_cannot_read_brand_assets','SELECT id FROM longball.brand_assets');
    await denied('worker_cannot_read_invitation_verifiers','SELECT token_hash FROM longball.spectator_invitations');
    await denied('worker_cannot_read_native_devices','SELECT device_id FROM longball.native_app_devices');
    await denied('worker_cannot_read_team_privilege_states','SELECT team_id FROM longball.team_privilege_states');
    await denied('worker_cannot_read_team_privilege_decisions','SELECT target_account_id FROM longball.team_privilege_decisions');
    await denied('worker_cannot_read_push_registrations','SELECT token_ciphertext FROM longball.push_registrations');
    if((await client.query("SELECT * FROM longball.push_targets_for_current_job('runtime-permission-proof')")).rowCount!==0)throw new Error('A worker without the exact claimed job resolved push destinations.');
    checks.push('worker_push_destinations_require_exact_lease');
    await denied('worker_cannot_resolve_raw_report_source', "SELECT longball.report_export_fingerprint_raw('permission-proof','permission-proof')");
    await denied('worker_cannot_insert_report_exports', "INSERT INTO longball.report_exports(id) VALUES('permission-proof')");
    await denied('worker_cannot_delete_jobs', "DELETE FROM longball.jobs WHERE id='permission-proof'");
    checks.push('worker_job_and_document_operations');
  }
  await client.query('ROLLBACK');
  console.log(JSON.stringify({ role: `longball_${kind}`, versions, passed: checks }));
} finally { client.release(); await pool.end(); }
