import { randomBytes } from 'node:crypto';
import { chownSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
// Explicit one-time operator command for a private Docker volume. No key is logged.
if (process.getuid?.() !== 0 || process.env.LONGBALL_EXPORT_KEY_INITIALIZE !== '1') throw new Error('Use only the explicit export-key initialization service.');
const directory = '/data/export-key';
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700); chownSync(directory, 1000, 1000);
const path = `${directory}/key`;
writeFileSync(path, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
chownSync(path, 1000, 1000);
console.log('Created the private report export key. Existing keys are never overwritten.');
