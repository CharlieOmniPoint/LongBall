/** Internal production-image check. Trusted sample only; no HTTP listener or private data. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { generateReportPdf, MAX_REPORT_EXPORT_BYTES } from './report-export-pdf';

const title = 'LongBall report image check';
const player = 'Élodie García · Radosław · Māori · Ω';
const bytes = await generateReportPdf({
  title,
  metadata: { generatedAt: '2026-10-21T12:00:00Z', visibility: 'Internal sample' },
  sections: [{ title: 'Reader check', rows: [
    { label: 'Player', value: player },
    { label: 'Unknown', value: null },
    { label: 'Known', value: 0 },
  ] }],
});
const magic = Buffer.from(bytes.subarray(0, 8)).toString('ascii');
assert.equal(magic, '%PDF-1.7');
assert.ok(bytes.length > 0 && bytes.length <= MAX_REPORT_EXPORT_BYTES);
const pdf = await PDFDocument.load(bytes);
assert.equal(pdf.getPageCount(), 1);
assert.equal(pdf.getTitle(), title);
const objects = pdf.context.enumerateIndirectObjects();
const embeddedFont = objects.some(([, value]) => value.toString().includes('/FontFile2'));
assert.ok(embeddedFont, 'The packaged font must be embedded in the generated PDF.');

// Decode the generated text using the embedded ToUnicode map, as PDF readers do.
const streams = objects.flatMap(([, value]) => value instanceof PDFRawStream
  ? [Buffer.from(decodePDFRawStream(value).decode()).toString('utf8')] : []);
const map = new Map<string, string>();
for (const stream of streams.filter(value => value.includes('beginbfchar'))) {
  for (const block of stream.matchAll(/beginbfchar\s+([\s\S]*?)\s+endbfchar/g))
    for (const match of block[1].matchAll(/<([\da-f]+)>\s*<([\da-f]+)>/gi)) {
      const encoded = Buffer.from(match[2], 'hex');
      map.set(match[1].toUpperCase(), encoded.swap16().toString('utf16le'));
    }
}
const text = streams.filter(value => !value.includes('beginbfchar')).flatMap(stream =>
  [...stream.matchAll(/<([\da-f]+)>\s*Tj/gi)].map(match =>
    (match[1].toUpperCase().match(/.{4}/g) ?? []).map(glyph => map.get(glyph) ?? '').join(''),
  ),
).join('\n');
assert.ok(text.includes(`Player: ${player}`), 'Generated PDF Unicode must remain readable.');
assert.ok(text.includes('Unknown: Not recorded') && text.includes('Known: 0'), 'Unknown and zero values must remain distinct.');
console.log(JSON.stringify({
  passed: true, pages: pdf.getPageCount(), bytes: bytes.length, magic,
  embeddedFont, unicodeReadable: true, unknownAndZeroDistinct: true,
  pdfSha256: createHash('sha256').update(bytes).digest('hex'),
}));
