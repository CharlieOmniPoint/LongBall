import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readReportExportOptions } from './report-export-config';

const directories: string[] = [];
const key = 'a1'.repeat(32);
function privateFile(contents = key, mode = 0o600): string {
  const directory = mkdtempSync(join(tmpdir(), 'longball-export-key-'));
  directories.push(directory);
  const path = join(directory, 'private-key');
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
  return path;
}
function configuration(path: string, ttl = '3600000'): Record<string, string> {
  return { LONGBALL_EXPORT_ENCRYPTION_KEY_FILE: path, LONGBALL_EXPORT_TTL_MS: ttl };
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('private report-export configuration', () => {
  it('leaves export jobs disabled until the operator configures a key and explicit expiry together', () => {
    expect(readReportExportOptions({})).toBeUndefined();
    const path = privateFile();
    expect(() => readReportExportOptions({ LONGBALL_EXPORT_ENCRYPTION_KEY_FILE: path })).toThrow('Configure the private report-export key file and explicit expiry together.');
    expect(() => readReportExportOptions({ LONGBALL_EXPORT_TTL_MS: '3600000' })).toThrow('Configure the private report-export key file and explicit expiry together.');
    expect(() => readReportExportOptions(configuration('relative/private-key'))).toThrow('Configure the private report-export key file and explicit expiry together.');
  });

  it('reads only a private regular hex key file and preserves the explicit expiry at both bounds', () => {
    for (const mode of [0o400, 0o600]) {
      const path = privateFile(`${key.toUpperCase()}\n`, mode);
      for (const ttl of ['1000', '3600000', '86400000']) {
        const options = readReportExportOptions(configuration(path, ttl));
        expect(options?.encryptionKey).toEqual(Buffer.from(key, 'hex'));
        expect(options?.encryptionKey.byteLength).toBe(32);
        expect(options?.ttlMs).toBe(Number(ttl));
      }
    }
  });

  it.each(['0', '999', '86400001', '9007199254740992', '-1000', '1e3', '1000.0', ' 1000', '1000\n', 'Infinity', 'NaN'])('rejects an invalid or unbounded expiry %j', ttl => {
    const path = privateFile();
    expect(() => readReportExportOptions(configuration(path, ttl))).toThrow(/Configure the private report-export key file and explicit expiry together|Report-export expiry must be explicitly bounded/);
  });

  it.each([0o640, 0o604, 0o644, 0o660])('rejects keys readable by a group or other users (%s)', mode => {
    expect(() => readReportExportOptions(configuration(privateFile(key, mode)))).toThrow('The private report-export key file is unavailable or invalid.');
  });

  it('rejects directories, symlinks and missing paths without leaking paths or key contents', () => {
    const path = privateFile();
    const directory = join(path, '..', 'directory');
    mkdirSync(directory, { mode: 0o700 });
    const link = join(path, '..', 'symlink');
    symlinkSync(path, link);
    for (const unsafePath of [directory, link, join(path, '..', 'missing')]) {
      let error: unknown;
      try { readReportExportOptions(configuration(unsafePath)); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('The private report-export key file is unavailable or invalid.');
      expect((error as Error).message).not.toContain(unsafePath);
      expect((error as Error).message).not.toContain(key);
    }
  });

  it.each(['', 'a1'.repeat(31), 'a1'.repeat(33), 'g1'.repeat(32), ' '.repeat(101) + key])('rejects malformed or oversized key file %j', contents => {
    expect(() => readReportExportOptions(configuration(privateFile(contents)))).toThrow('The private report-export key file is unavailable or invalid.');
  });
});
