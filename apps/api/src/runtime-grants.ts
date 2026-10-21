import type { PgDatabase } from './pg';

/** Schema-owner operation, shared by deployment and explicitly disposable trials. */
export async function applyRuntimeGrants(database: PgDatabase, roles: { apiRole: string; workerRole: string } = { apiRole: 'longball_api', workerRole: 'longball_worker' }): Promise<void> {
  const identifier = (name: string) => {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error('Invalid runtime database role name.');
    return `"${name}"`;
  };
  const api = identifier(roles.apiRole), worker = identifier(roles.workerRole);
  await database.transaction(async () => {
    await database.query('REVOKE ALL ON SCHEMA longball FROM PUBLIC');
    await database.query(`GRANT USAGE ON SCHEMA longball TO ${api},${worker}`);
    await database.query(`REVOKE ALL ON ALL TABLES IN SCHEMA longball FROM ${api},${worker}`);
    await database.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA longball TO ${api}`);
    await database.query(`REVOKE INSERT,UPDATE,DELETE ON longball.schema_migrations,longball.media_schema_migrations,longball.lb_activation_schema FROM ${api}`);
    await database.query(`REVOKE UPDATE ON longball.events,longball.audit,longball.controller_history,longball.reconciliation_proposals,longball.clock_mappings FROM ${api}`);
    await database.query(`GRANT SELECT ON longball.schema_migrations TO ${worker}`);
    await database.query(`GRANT SELECT ON longball.accounts,longball.memberships,longball.matches TO ${worker}`);
    await database.query(`GRANT SELECT,INSERT,UPDATE ON longball.jobs,longball.documents TO ${worker}`);
  });
}
