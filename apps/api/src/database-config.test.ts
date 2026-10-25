import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { readDatabaseUrl } from './database-config';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
it('reads a mounted URL secret without requiring it in the environment', () => {
  const directory = mkdtempSync(join(tmpdir(), 'longball-url-')); directories.push(directory);
  const file = join(directory, 'url'); writeFileSync(file, 'postgresql://api:fictional@database/longball\n', { mode: 0o600 });
  expect(readDatabaseUrl({ LONGBALL_DATABASE_URL_FILE: file })).toBe('postgresql://api:fictional@database/longball');
  expect(readDatabaseUrl({ LONGBALL_MIGRATION_DATABASE_URL_FILE: file }, 'LONGBALL_MIGRATION_DATABASE_URL')).toBe('postgresql://api:fictional@database/longball');
});
it('rejects ambiguous credentials and invalid selectors without echoing credential text', () => {
  expect(() => readDatabaseUrl({ LONGBALL_DATABASE_URL: 'postgresql://api@database/longball', LONGBALL_DATABASE_URL_FILE: '/unread' })).toThrow('exactly one');
  expect(() => readDatabaseUrl({ LONGBALL_DATABASE_URL: 'invalid-private-credential' })).toThrow(/^A valid PostgreSQL connection URL is required\.$/);
  expect(() => readDatabaseUrl({ LONGBALL_DATABASE_URL: 'https://api:fictional@database' })).toThrow('PostgreSQL');
  expect(readDatabaseUrl({})).toBeUndefined();
});
