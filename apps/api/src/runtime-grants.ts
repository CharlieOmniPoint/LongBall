import type { PgDatabase } from './pg';

/** Schema-owner operation, shared by deployment and explicitly disposable trials. */
export async function applyRuntimeGrants(database: PgDatabase, roles: { apiRole: string; workerRole: string } = { apiRole: 'longball_api', workerRole: 'longball_worker' }): Promise<void> {
  const identifier = (name: string) => {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error('Invalid runtime database role name.');
    return `"${name}"`;
  };
  const api = identifier(roles.apiRole), worker = identifier(roles.workerRole);
  await database.transaction(async () => {
    await database.query("INSERT INTO longball.runtime_roles(role_name,purpose) VALUES($1,'api'),($2,'worker') ON CONFLICT(role_name) DO UPDATE SET purpose=EXCLUDED.purpose", [roles.apiRole,roles.workerRole]);
    await database.query('REVOKE ALL ON SCHEMA longball FROM PUBLIC');
    await database.query(`GRANT USAGE ON SCHEMA longball TO ${api},${worker}`);
    await database.query(`REVOKE ALL ON ALL TABLES IN SCHEMA longball FROM ${api},${worker}`);
    await database.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA longball FROM PUBLIC,${api},${worker}`);
    const apiTables = ['clubs','teams','team_seasons','game_contexts','accounts','memberships','matches','documents','devices','controller_grants','controller_history','events','streams','conflicting_submissions','transfers','clock_challenges','clock_mappings','reconciliation_proposals','audit','idempotency','privacy_requests','privacy_pending_keys','jobs','media_uploads','lb_activation_children','lb_activation_issues','lb_activation_tokens','lb_activation_verification_requests'];
    await database.query(`GRANT SELECT,INSERT,UPDATE ON ${apiTables.map(table => `longball.${table}`).join(',')} TO ${api}`);
    await database.query(`GRANT SELECT ON longball.schema_migrations,longball.media_schema_migrations,longball.lb_activation_schema TO ${api},${worker}`);
    await database.query(`REVOKE UPDATE ON longball.events,longball.audit,longball.controller_history,longball.reconciliation_proposals,longball.clock_mappings FROM ${api}`);
    await database.query(`GRANT SELECT ON longball.clubs,longball.teams,longball.team_seasons,longball.game_contexts,longball.accounts,longball.memberships,longball.matches TO ${worker}`);
    await database.query(`GRANT SELECT,INSERT,UPDATE ON longball.jobs,longball.documents TO ${worker}`);
    const helpers = ['runtime_purpose()','context_json()','context_now()','actor_valid()','context_matches(text,text,text)','actor_role(text,text,text)','actor_admin(text,text,text)','actor_manager(text,text,text)','invite_capability(text,text,text)','worker_job_valid(text,text,text)','worker_kind()','worker_account(text,text,text,text)','spectator_grant_active(text,text,text,text)','activation_account(text,boolean)','account_visible(text)','document_write(text,text,text,text)','worker_match(text,text,text,text)'];
    await database.query(`GRANT EXECUTE ON FUNCTION ${helpers.map(name => `longball.${name}`).join(',')} TO ${api},${worker}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.media_gallery_allowed(text,integer,text,text,text,text,text) TO ${api}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.claim_due_job(text,bigint,text),longball.enqueue_award_notification(text,text,jsonb,bigint) TO ${worker}`);
  });
}
