import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Explicitly local preparation. Existing credentials are never overwritten.
const directory = resolve('.local/runtime/deployment-secrets');
// These public repository configs are read by different container UIDs.
for (const file of ['infra/runtime/bootstrap.sql', 'infra/runtime/clamd.conf']) chmodSync(resolve(file), 0o644);
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
const write = (name, value) => {
  const path = join(directory, name);
  writeFileSync(path, `${value}\n`, { flag: 'wx', mode: 0o400 });
  // Docker secret bind mounts retain file permissions. PostgreSQL and Node use
  // different container UIDs; the host parent directory remains private.
  chmodSync(path, 0o444);
};
const passwords = Object.fromEntries(['postgres', 'migrator', 'api', 'worker'].map(name => [name, randomBytes(32).toString('hex')]));
for (const [name, password] of Object.entries(passwords)) write(`${name}_password`, password);
for (const name of ['migrator', 'api', 'worker']) write(`${name}_url`, `postgresql://longball_${name}:${passwords[name]}@database:5432/longball`);
console.log('Created local deployment secret files under the private .local/runtime/deployment-secrets directory. Values were not logged.');
