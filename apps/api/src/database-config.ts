import { readFileSync } from 'node:fs';

/** A mounted secret avoids putting a database password in the container environment. */
export function readDatabaseUrl(env: NodeJS.ProcessEnv, key = 'LONGBALL_DATABASE_URL'): string | undefined {
  const inline = env[key];
  const file = env[`${key}_FILE`];
  if (inline && file) throw new Error(`Configure exactly one of ${key} and ${key}_FILE.`);
  const value = file ? readFileSync(file, 'utf8').trim() : inline;
  if (!value) return undefined;
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('A valid PostgreSQL connection URL is required.'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('A PostgreSQL connection URL is required.');
  return value;
}
