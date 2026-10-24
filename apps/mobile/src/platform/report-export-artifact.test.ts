import { describe, expect, it } from 'vitest';
import { reportArtifactBytes } from './report-export-artifact';
describe('report byte/file boundary', () => {
  it('measures encoded bytes, preserves UTF-8 and keeps a private copy of the validated source', () => {
    const source = new TextEncoder().encode('%PDF-1.7\nreport\n%%EOF\n');
    const parsed = reportArtifactBytes({ fileName: 'longball-report.pdf', contentType: 'application/pdf', bytes: source }); source[0] = 0;
    expect(parsed.bytes[0]).toBe('%'.charCodeAt(0)); expect(parsed.mimeType).toBe('application/pdf');
    const text = reportArtifactBytes({ fileName: 'longball-report.csv', contentType: 'text/csv; charset=utf-8', body: '"José","Léon"' });
    expect(new TextDecoder().decode(text.bytes)).toBe('"José","Léon"');
    expect(() => reportArtifactBytes({ fileName: 'longball-report.csv', contentType: 'text/csv', body: 'é'.repeat(3_000_000) })).toThrow('invalid');
  });
  it('rejects traversal, mixed types, empty files and text masquerading as PDF', () => {
    for (const artifact of [
      { fileName: '../private.csv', contentType: 'text/csv', body: 'a' }, { fileName: 'report.csv', contentType: 'application/pdf', body: 'a' },
      { fileName: 'report.pdf', contentType: 'application/pdf', body: '%PDF-1.7\n%%EOF' }, { fileName: 'report.csv', contentType: 'text/csv', body: '' },
    ]) expect(() => reportArtifactBytes(artifact)).toThrow('invalid');
  });
});
