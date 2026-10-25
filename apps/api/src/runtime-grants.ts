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
    const apiTables = ['clubs','teams','team_seasons','game_contexts','accounts','memberships','matches','documents','devices','controller_grants','controller_history','events','streams','conflicting_submissions','transfers','clock_challenges','clock_mappings','reconciliation_proposals','audit','idempotency','privacy_requests','privacy_pending_keys','jobs','media_uploads','lb_activation_children','lb_activation_issues','lb_activation_tokens','lb_activation_verification_requests','brand_assets','brand_slots','spectator_invitations','lb_spectator_activation_accounts','lb_spectator_activation_attempts','native_app_devices','team_privilege_states','team_privilege_decisions','push_registrations','report_exports','match_feedback','team_documents','opposition_reviews'];
    await database.query(`GRANT SELECT,INSERT,UPDATE ON ${apiTables.map(table => `longball.${table}`).join(',')} TO ${api}`);
    await database.query(`GRANT SELECT,INSERT ON longball.match_feedback_receipts TO ${api}`);
    await database.query(`GRANT SELECT ON longball.administrative_memberships TO ${api},${worker}`);
    await database.query(`GRANT SELECT,INSERT ON longball.opposition_review_receipts TO ${api}`);
    await database.query(`GRANT SELECT,UPDATE ON longball.invite_requests TO ${api}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.sign_in_rules_read(),longball.sign_in_rules_provider_confirm(bigint),longball.sign_in_rules_lock(),longball.sign_in_rules_save(bigint,jsonb,bigint),longball.claim_configured_demo_username(text,text) TO ${api}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.team_document_staff(text,text),longball.opposition_completed_games(text,text),longball.spectator_pin_preview(text,bigint),longball.spectator_pin_register(text,text,text,text,text,text,bigint),longball.spectator_pin_credential(text),longball.spectator_pin_login_attempt(text,boolean,bigint),longball.spectator_invite_directory(),longball.spectator_connection_catalog(text,text),longball.spectator_invite_request(text,text,text,text,text,text,text,bigint) TO ${api}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.feedback_player(text,text,text,text,text),longball.feedback_reader(text,text,text,text,text) TO ${api}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.scheduled_games(text,text),longball.manage_scheduled_game(text,text,jsonb),longball.admin_player_stats_source(text,text),longball.team_overview_source(text,text) TO ${api}`);
    await database.query(`GRANT SELECT ON longball.schema_migrations,longball.media_schema_migrations,longball.lb_activation_schema TO ${api},${worker}`);
    await database.query(`REVOKE UPDATE ON longball.events,longball.audit,longball.controller_history,longball.reconciliation_proposals,longball.clock_mappings,longball.team_privilege_decisions FROM ${api}`);
    await database.query(`GRANT SELECT ON longball.clubs,longball.teams,longball.team_seasons,longball.game_contexts,longball.accounts,longball.memberships,longball.matches TO ${worker}`);
    // Worker membership reads resolve the inherited marker relation under a deny-all-to-worker RLS policy; scope metadata helpers return NULL for worker purpose.
    await database.query(`GRANT EXECUTE ON FUNCTION longball.administration_scope(text) TO ${worker}`);
    await database.query(`GRANT SELECT,INSERT,UPDATE ON longball.jobs,longball.documents TO ${worker}`);
    await database.query(`GRANT SELECT,UPDATE ON longball.report_exports TO ${worker}`);
    // PostgreSQL must resolve every helper referenced by the accounts policies,
    // including API-only predicates that return false for a worker login.
    const helpers = ['runtime_purpose()','context_json()','context_now()','actor_valid()','context_matches(text,text,text)','actor_role(text,text,text)','actor_admin(text,text,text)','actor_manager(text,text,text)','inherited_admin_manager(text,text,text)','invite_capability(text,text,text)','worker_job_valid(text,text,text)','worker_kind()','worker_account(text,text,text,text)','spectator_grant_active(text,text,text,text)','activation_account(text,boolean)','spectator_activation_account(text,boolean)','invitation_live(text,text)','account_visible(text)','document_write(text,text,text,text)','worker_match(text,text,text,text)','report_export_actor(text,text,text,text,text,text)','report_export_worker(text,text,text,text,text)'];
    await database.query(`GRANT EXECUTE ON FUNCTION ${helpers.map(name => `longball.${name}`).join(',')} TO ${api},${worker}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.media_completion_write(text,text,text,text) TO ${api},${worker}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.media_gallery_allowed(text,integer,text,text,text,text,text) TO ${api}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.branding_member(text,text),longball.branding_authority(text,text,text),longball.branding_context(text,text) TO ${api}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.team_privilege_manager(text,text),longball.team_privilege_target(text,text,text),longball.team_privilege_allowed(text,text,text,boolean) TO ${api}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.invitation_live(text,text),longball.invitation_preflight(text),longball.invitation_accept_scope(text),longball.spectator_activation_account(text,boolean) TO ${api}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.invitation_preview_context(text) TO ${api}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.workspace_membership_names() TO ${api}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.inherited_admin_manager(text,text,text),longball.sync_club_configuration(text,text),longball.inherit_administration_for_season(text,text),longball.administration_scope(text),longball.administration_directory(),longball.administration_command(jsonb,text,jsonb),longball.club_report(text) TO ${api}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.report_export_source(text,text) TO ${api}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.report_export_current(text) TO ${api},${worker}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.purge_report_exports() TO ${worker}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.claim_due_job(text,bigint,text),longball.enqueue_award_notification(text,text,jsonb,bigint),longball.push_targets_for_current_job(text) TO ${worker}`);
  });
}
