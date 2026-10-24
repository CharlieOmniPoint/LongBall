import { readFile } from 'node:fs/promises';
import type { PgDatabase } from './pg';

async function install(database: PgDatabase, name: 'media' | 'activation'): Promise<void> {
  if (database.migrationMode !== 'apply') throw new Error('Security migration requires the separate schema-owner migrator.');
  const sql = await readFile(new URL(`../migrations/postgresql/005_${name}_security.sql`, import.meta.url), 'utf8');
  await database.transaction(() => database.query(sql));
}
async function verify(database: PgDatabase, tables: readonly string[]): Promise<void> {
  const result = await database.query<{ relname: string; relrowsecurity: boolean; policies: number }>(
    `SELECT c.relname,c.relrowsecurity,(SELECT count(*)::integer FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid) AS policies
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='longball' AND c.relname=ANY($1::text[])`, [tables]);
  if (result.rows.length !== tables.length || result.rows.some(row => !row.relrowsecurity || row.policies < 2)) throw new Error('PostgreSQL feature row security is missing. Run the separate migrator before starting runtime.');
}
export const installMediaSecurity = (database: PgDatabase) => install(database, 'media');
export const installActivationSecurity = (database: PgDatabase) => install(database, 'activation');
export const verifyMediaSecurity = async (database: PgDatabase) => {
  await verify(database,['media_uploads']);
  const policies=await database.query("SELECT policyname FROM pg_catalog.pg_policies WHERE schemaname='longball' AND policyname=ANY($1::text[])",[['media_team_privilege_insert','media_team_privilege_link','documents_player_media_insert','documents_player_media_update']]);
  if(policies.rows.length!==4)throw new Error('Current media contribution row security is missing. Run the separate migrator.');
};
export const verifyActivationSecurity = (database: PgDatabase) => verify(database, ['lb_activation_children', 'lb_activation_issues', 'lb_activation_tokens', 'lb_activation_verification_requests']);
export async function installHeicMedia(database:PgDatabase):Promise<void>{
  if(database.migrationMode!=='apply')throw new Error('Media migration requires the separate schema-owner migrator.');
  const sql=await readFile(new URL('../migrations/postgresql/media_003_heic.sql',import.meta.url),'utf8');
  await database.transaction(()=>database.query(sql));
}

export async function installTeamPrivilegeMedia(database:PgDatabase):Promise<void>{
  if(database.migrationMode!=='apply')throw new Error('Media migration requires the separate schema-owner migrator.');
  const sql=await readFile(new URL('../migrations/postgresql/media_004_team_privileges.sql',import.meta.url),'utf8');
  await database.transaction(()=>database.query(sql));
}
