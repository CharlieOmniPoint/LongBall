import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { generateReportPdf, MAX_REPORT_EXPORT_BYTES, type ReportPdfDocument } from './report-export-pdf';

const document = (): ReportPdfDocument => ({ title: 'Roma U10 · Match report', metadata: { generatedAt: '2026-10-21T12:00:00Z', visibility: 'Own player', coverage: 'Known records only' }, sections: [{ title: 'Authorised participation', rows: [{ label: 'Player', value: 'Élodie García · Radosław · Māori · Ω' }, { label: 'Half-time score', value: null }, { label: 'Known playing time', value: 0 }, { label: 'Score', value: 'Withheld by competition policy' }] }] });

/** Decode standard text streams through the PDF's own ToUnicode map, independently
 * of the generator's wrapping and input formatters. Reader tools use this mapping. */
function textContent(pdf: PDFDocument): string {
  const streams = pdf.context.enumerateIndirectObjects().flatMap(([, value]) => value instanceof PDFRawStream ? [Buffer.from(decodePDFRawStream(value).decode()).toString('utf8')] : []);
  const map = new Map<string, string>();
  for (const stream of streams.filter(value => value.includes('beginbfchar'))) {
    for (const block of stream.matchAll(/beginbfchar\s+([\s\S]*?)\s+endbfchar/g))
      for (const match of block[1].matchAll(/<([\da-f]+)>\s*<([\da-f]+)>/gi)) {
        const encoded = Buffer.from(match[2], 'hex');
        map.set(match[1].toUpperCase(), encoded.swap16().toString('utf16le'));
      }
  }
  return streams.filter(value => !value.includes('beginbfchar')).flatMap(stream => [...stream.matchAll(/<([\da-f]+)>\s*Tj/gi)].map(match => match[1].toUpperCase().match(/.{4}/g)!.map(glyph => map.get(glyph) ?? '').join(''))).join('\n');
}

describe('canonical report PDF export', () => {
  it('creates a readable Unicode text PDF with embedded fonts and honest unknown, zero and withheld values', async () => {
    const bytes = await generateReportPdf(document());
    expect(Buffer.from(bytes).subarray(0, 8).toString()).toBe('%PDF-1.7');
    expect(bytes.byteLength).toBeLessThan(MAX_REPORT_EXPORT_BYTES);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getTitle()).toBe('Roma U10 · Match report');
    expect(pdf.getCreationDate()?.toISOString()).toBe('2026-10-21T12:00:00.000Z');
    const text = textContent(pdf);
    expect(text).toContain('Élodie García · Radosław · Māori · Ω');
    expect(text).toContain('Half-time score: Not recorded');
    expect(text).toContain('Known playing time: 0');
    expect(text).toContain('Score: Withheld by competition policy');
    expect(text).toContain('Page 1 of 1');
    expect(pdf.context.enumerateIndirectObjects().some(([, value]) => value.toString().includes('/FontFile2'))).toBe(true);
  });

  it('keeps PDF-looking input literal, strips controls and exposes unsupported glyphs without actions or silent loss', async () => {
    const value = document();
    value.sections[0].rows = [{ label: 'Caption', value: ') Tj /OpenAction << /S /JavaScript /JS (alert(1)) >> (\u0000safe\ttext\u202E\u{1F9D1}' }];
    const pdf = await PDFDocument.load(await generateReportPdf(value));
    expect(pdf.catalog.has(PDFName.of('OpenAction'))).toBe(false);
    expect(pdf.catalog.has(PDFName.of('AA'))).toBe(false);
    const text = textContent(pdf);
    expect(text).toContain('/JavaScript /JS (alert(1))');
    expect(text).toContain('safe text[U+202E][U+1F9D1]');
    expect(text).not.toContain('\u0000');
    expect(text).not.toContain('\u202E');
    expect(text).toContain('Characters outside the embedded font');
  });

  it('wraps long opaque IDs and paginates without dropping the final authorised row', async () => {
    const value = document();
    value.sections[0].rows = Array.from({ length: 120 }, (_, index) => ({ label: `Match ${index + 1}`, value: `${'opaque'.repeat(35)} · ${index === 119 ? 'LAST ROW PRESERVED' : 'known participation'}` }));
    const pdf = await PDFDocument.load(await generateReportPdf(value));
    expect(pdf.getPageCount()).toBeGreaterThan(3);
    expect(textContent(pdf)).toContain('LAST ROW PRESERVED');
    expect(textContent(pdf)).toContain(`Page ${pdf.getPageCount()} of ${pdf.getPageCount()}`);
  });

  it('enforces the five-MiB ceiling and rejects unbounded or non-JSON document data before rendering', async () => {
    expect(MAX_REPORT_EXPORT_BYTES).toBe(5 * 1024 * 1024);
    await expect(generateReportPdf(document(), { maximumBytes: 1024 })).rejects.toMatchObject({ code: 'EXPORT_TOO_LARGE' });
    await expect(generateReportPdf(document(), { maximumBytes: MAX_REPORT_EXPORT_BYTES + 1 })).rejects.toMatchObject({ code: 'EXPORT_DOCUMENT_INVALID' });
    const large = document(); large.sections[0].rows[0].value = 'x'.repeat(1_000_001);
    await expect(generateReportPdf(large)).rejects.toMatchObject({ code: 'EXPORT_TOO_LARGE' });
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const recursive = document(); recursive.sections[0].rows[0].value = cyclic;
    await expect(generateReportPdf(recursive)).rejects.toMatchObject({ code: 'EXPORT_DOCUMENT_INVALID' });
    const nonfinite = document(); nonfinite.sections[0].rows[0].value = Infinity;
    await expect(generateReportPdf(nonfinite)).rejects.toMatchObject({ code: 'EXPORT_DOCUMENT_INVALID' });
    let getterRead = false;
    const unsafe = document(); unsafe.sections[0].rows[0].value = Object.defineProperty({}, 'hidden', { enumerable: true, get: () => { getterRead = true; return 'not JSON'; } });
    await expect(generateReportPdf(unsafe)).rejects.toMatchObject({ code: 'EXPORT_DOCUMENT_INVALID' });
    expect(getterRead).toBe(false);
  });
});
