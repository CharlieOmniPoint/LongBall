import { readFile } from 'node:fs/promises';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

export const MAX_REPORT_EXPORT_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_CHARACTERS = 1_000_000;
const MAX_PAGES = 250;
const PAGE = { width: 595.28, height: 841.89, margin: 44 };
export interface ReportPdfDocument {
  title: string;
  metadata: Record<string, unknown>;
  sections: { title: string; rows: { label: string; value: unknown }[] }[];
}
export class ReportPdfError extends Error {
  constructor(readonly code: 'EXPORT_TOO_LARGE' | 'EXPORT_DOCUMENT_INVALID' | 'EXPORT_FONT_UNAVAILABLE', message: string) { super(message); }
}
const invalid = (): never => { throw new ReportPdfError('EXPORT_DOCUMENT_INVALID', 'The authorised report cannot be represented as a PDF.'); };
const tooLarge = (): never => { throw new ReportPdfError('EXPORT_TOO_LARGE', 'The report exceeds the bounded PDF export size. Narrow the report and request it again.'); };
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** Only already-authorised JSON data enters this formatter. No HTML, URLs or PDF operators are interpreted. */
function valueText(value: unknown, depth = 0, ancestors = new Set<object>()): string {
  if (depth > 16) return tooLarge();
  if (value === null || value === undefined) return 'Not recorded';
  if (typeof value === 'string') { if (value.length > MAX_CHARACTERS) return tooLarge(); return value; }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : invalid();
  if (!Array.isArray(value) && !plain(value)) return invalid();
  if (ancestors.has(value)) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length || Object.entries(descriptors).some(([key, property]) => key !== 'length' && (!('value' in property) || !property.enumerable))) return invalid();
  if (Object.keys(value).length > MAX_ROWS) return tooLarge();
  ancestors.add(value);
  try {
    const strings = Array.isArray(value)
      ? Array.from({ length: value.length }, (_, index) => { if (!Object.hasOwn(value, index)) return invalid(); return valueText(descriptors[String(index)].value, depth + 1, ancestors); })
      : Object.entries(descriptors).map(([key, property]) => `${key}: ${valueText(property.value, depth + 1, ancestors)}`);
    if (strings.reduce((sum, item) => sum + item.length, 0) > MAX_CHARACTERS) return tooLarge();
    return strings.length ? strings.join('; ') : 'No entries recorded';
  } finally { ancestors.delete(value); }
}

function inputLines(document: ReportPdfDocument): { title: string; metadata: { label: string; value: string }[]; sections: { title: string; rows: { label: string; value: string }[] }[] } {
  if (!plain(document) || typeof document.title !== 'string' || !document.title.trim() || document.title.length > 300 || !plain(document.metadata) || !Array.isArray(document.sections) || document.sections.length > 64 || Object.keys(document.metadata).length > 100) return invalid();
  let characters = document.title.length, rows = 0;
  const row = (label: unknown, value: unknown) => {
    if (typeof label !== 'string' || !label.trim() || label.length > 300) return invalid();
    const text = valueText(value);
    characters += label.length + text.length;
    if (++rows > MAX_ROWS || characters > MAX_CHARACTERS) return tooLarge();
    return { label, value: text };
  };
  return { title: document.title,
    metadata: Object.entries(document.metadata).map(([label, value]) => row(label, value)),
    sections: document.sections.map(section => {
      if (!plain(section) || typeof section.title !== 'string' || !section.title.trim() || section.title.length > 300 || !Array.isArray(section.rows)) return invalid();
      characters += section.title.length;
      return { title: section.title, rows: section.rows.map(item => { if (!plain(item)) return invalid(); return row(item.label, item.value); }) };
    }),
  };
}

let fontBytes: Promise<Uint8Array> | undefined;
async function loadFont(): Promise<Uint8Array> {
  try { return await (fontBytes ??= readFile(new URL('./assets/fonts/DejaVuSans.ttf', import.meta.url))); }
  catch { fontBytes = undefined; throw new ReportPdfError('EXPORT_FONT_UNAVAILABLE', 'The report font is unavailable. The private export can be retried after configuration is repaired.'); }
}

/** Standard text operators, embedded Unicode font and ToUnicode mapping; never rasterised text. */
export async function generateReportPdf(document: ReportPdfDocument, options: { maximumBytes?: number } = {}): Promise<Uint8Array> {
  const maximum = options.maximumBytes ?? MAX_REPORT_EXPORT_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_REPORT_EXPORT_BYTES) return invalid();
  const data = inputLines(document);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(await loadFont(), { subset: true });
  const characters = new Set(font.getCharacterSet());
  let escapedCharacters = false;
  const printable = (text: string) => Array.from(text.replace(/\r\n?/g, '\n'), character => {
    const point = character.codePointAt(0)!;
    if (character === '\n') return '\n';
    if (character === '\t' || point < 32 || point >= 0x7f && point <= 0x9f) return ' ';
    // Make unsupported glyphs and direction controls explicit instead of silently
    // losing characters or allowing a name to change the direction of its label.
    if (!characters.has(point) || point >= 0x202a && point <= 0x202e || point >= 0x2066 && point <= 0x2069) {
      escapedCharacters = true; return `[U+${point.toString(16).toUpperCase().padStart(4, '0')}]`;
    }
    return character;
  }).join('');
  const title = printable(data.title);
  pdf.setTitle(title); pdf.setCreator('LongBall'); pdf.setProducer('LongBall report export');
  const observedGeneration = document.metadata.generatedAt;
  if (typeof observedGeneration === 'string' && Number.isFinite(Date.parse(observedGeneration))) {
    const generatedAt = new Date(observedGeneration);
    pdf.setCreationDate(generatedAt); pdf.setModificationDate(generatedAt);
  }
  let page: PDFPage, y = 0;
  const ink = rgb(0.08, 0.15, 0.12), green = rgb(0.04, 0.39, 0.25), muted = rgb(0.33, 0.38, 0.35);
  const addPage = () => {
    if (pdf.getPageCount() >= MAX_PAGES) return tooLarge();
    page = pdf.addPage([PAGE.width, PAGE.height]);
    page.drawText('LongBall', { x: PAGE.margin, y: PAGE.height - 38, size: 12, font, color: green });
    page.drawLine({ start: { x: PAGE.margin, y: PAGE.height - 47 }, end: { x: PAGE.width - PAGE.margin, y: PAGE.height - 47 }, thickness: 0.7, color: rgb(0.77, 0.83, 0.79) });
    y = PAGE.height - 73;
  };
  const write = (text: string, size = 10, color = ink, gap = 3) => {
    for (const line of wrap(printable(text), font, size, PAGE.width - PAGE.margin * 2)) {
      if (y < PAGE.margin + 25) addPage();
      page.drawText(line || ' ', { x: PAGE.margin, y, size, font, color });
      y -= size * 1.4;
    }
    y -= gap;
  };
  addPage(); write(title, 18, green, 10);
  if (data.metadata.length) {
    write('Report details', 12, green, 4);
    for (const item of data.metadata) write(`${item.label}: ${item.value}`, 9, muted);
    y -= 6;
  }
  for (const section of data.sections) {
    if (y < PAGE.margin + 65) addPage();
    write(section.title, 12, green, 5);
    if (!section.rows.length) write('No rows supplied. See report coverage and visibility.', 10, muted);
    for (const item of section.rows) write(`${item.label}: ${item.value}`);
    y -= 7;
  }
  if (escapedCharacters) write('Characters outside the embedded font and direction controls are shown by their Unicode code point, for example [U+1F3C6].', 8, muted);
  const pages = pdf.getPages();
  for (let index = 0; index < pages.length; index++) {
    pages[index].drawText(`Page ${index + 1} of ${pages.length}`, { x: PAGE.margin, y: 25, size: 8, font, color: muted });
  }
  const bytes = await pdf.save({ useObjectStreams: false, addDefaultPage: false });
  if (bytes.byteLength > maximum) return tooLarge();
  return bytes;
}

/** Width-based word wrapping keeps long opaque IDs inside the printable page. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [], glyphWidths = new Map<string, number>();
  const glyphWidth = (character: string) => {
    if (!glyphWidths.has(character)) glyphWidths.set(character, font.widthOfTextAtSize(character, size));
    return glyphWidths.get(character)!;
  };
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.trim().split(/\s+/u)) {
      if (!word) continue;
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width) { line = candidate; continue; }
      if (line) lines.push(line);
      if (font.widthOfTextAtSize(word, size) <= width) { line = word; continue; }
      line = ''; let used = 0;
      for (const character of word) {
        const nextWidth = glyphWidth(character);
        if (line && used + nextWidth > width - 2) { lines.push(line); line = ''; used = 0; }
        line += character; used += nextWidth;
      }
    }
    lines.push(line);
  }
  return lines;
}
