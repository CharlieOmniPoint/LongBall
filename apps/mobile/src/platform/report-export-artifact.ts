import { REPORT_EXPORT_MAX_BYTES } from '@longball/application/report-export';

export type ReportArtifact = { fileName: string; contentType: string } & ({ body: string; bytes?: never } | { bytes: Uint8Array; body?: never });
/** File type, size and bytes are checked before any private cache/share side effect. */
export function reportArtifactBytes(artifact: ReportArtifact): { bytes: Uint8Array<ArrayBuffer>; extension: 'json' | 'csv' | 'pdf'; mimeType: string } {
  if (!artifact || typeof artifact.fileName !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,109}\.(json|csv|pdf)$/.test(artifact.fileName) || typeof artifact.contentType !== 'string') throw new Error('The service export file is invalid.');
  const extension = artifact.fileName.split('.').at(-1) as 'json' | 'csv' | 'pdf';
  const mimeType = artifact.contentType.split(';')[0].trim().toLowerCase();
  const expected = { json: 'application/json', csv: 'text/csv', pdf: 'application/pdf' }[extension];
  if (mimeType !== expected || typeof artifact.body === 'string' && artifact.bytes !== undefined || artifact.body === undefined && !(artifact.bytes instanceof Uint8Array) || extension === 'pdf' && typeof artifact.body === 'string') throw new Error('The service export file is invalid.');
  if (artifact.bytes instanceof Uint8Array && artifact.bytes.byteLength > REPORT_EXPORT_MAX_BYTES || typeof artifact.body === 'string' && artifact.body.length > REPORT_EXPORT_MAX_BYTES) throw new Error('The service export file is invalid.');
  const bytes = artifact.bytes instanceof Uint8Array ? new Uint8Array(artifact.bytes) : new TextEncoder().encode(artifact.body!);
  if (!bytes.byteLength || bytes.byteLength > REPORT_EXPORT_MAX_BYTES) throw new Error('The service export file is invalid.');
  if (extension === 'pdf' && (String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-' || !new TextDecoder().decode(bytes.slice(-32)).includes('%%EOF'))) throw new Error('The service PDF file is invalid.');
  return { bytes, extension, mimeType };
}
