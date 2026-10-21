import { readFileSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export interface ReportExportOptions { encryptionKey: Uint8Array; ttlMs: number }
/** Export retention and a private encryption key are explicit operator configuration. */
export function readReportExportOptions(environment: Record<string, string | undefined>): ReportExportOptions | undefined {
  const path = environment.LONGBALL_EXPORT_ENCRYPTION_KEY_FILE;
  const rawTtl = environment.LONGBALL_EXPORT_TTL_MS;
  if (!path && !rawTtl) return undefined;
  if (!path || !rawTtl || !isAbsolute(path) || !/^\d+$/.test(rawTtl)) throw new Error('Configure the private report-export key file and explicit expiry together.');
  const ttlMs = Number(rawTtl);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 86_400_000) throw new Error('Report-export expiry must be explicitly bounded between one second and one day.');
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 100) throw new Error();
    const encoded = readFileSync(path, 'utf8').trim();
    if (!/^[a-fA-F0-9]{64}$/.test(encoded)) throw new Error();
    return { encryptionKey: Buffer.from(encoded, 'hex'), ttlMs };
  } catch { throw new Error('The private report-export key file is unavailable or invalid.'); }
}
