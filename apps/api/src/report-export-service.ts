import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { AccessError, type Principal } from '../../../packages/application/src/access';
import { parseReportExportRequest, REPORT_EXPORT_MAX_BYTES, type ReportExportRequest, type ReportExportStatus } from '../../../packages/application/src/report-export';
import type { RecordsViewer } from '../../../packages/application/src/records';
import type { DevelopmentStore } from './store';
import { PostgresStore } from './postgres-store';
import type { ReportExportOptions } from './report-export-config';
import { ReportExportRepository, type ExportClaim, type ExportRow } from './report-export-repository';
import { generateReportPdf, type ReportPdfDocument } from './report-export-pdf';

interface ExportDocument { schemaVersion: 1; title: string; metadata: Record<string, unknown>; sections: { title: string; value: unknown }[] }
const titles: Record<ReportExportRequest['kind'], string> = { own_participation: 'My participation', team_participation: 'Team participation', attendance: 'Attendance', match_summary: 'Match summary', season_results: 'Season results' };
function fail(code: string, status: number, message: string): never { throw new AccessError(code, status, message); }
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function encrypted(key: Uint8Array, aad: string, bytes: Uint8Array): string {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return JSON.stringify({ v: 1, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), bytes: ciphertext.toString('base64') });
}
function decrypted(key: Uint8Array, aad: string, encoded: string): Buffer {
  if (encoded.length > REPORT_EXPORT_MAX_BYTES * 1.5 + 1024) fail('EXPORT_TOO_LARGE', 413, 'This report exceeds the supported export size.');
  const value: unknown = JSON.parse(encoded);
  if (!object(value) || Object.keys(value).some(field => !['v', 'nonce', 'tag', 'bytes'].includes(field)) || value.v !== 1 || typeof value.nonce !== 'string' || typeof value.tag !== 'string' || typeof value.bytes !== 'string') throw new Error('EXPORT_CIPHER_INVALID');
  const nonce = Buffer.from(value.nonce, 'base64'), tag = Buffer.from(value.tag, 'base64'), bytes = Buffer.from(value.bytes, 'base64');
  if (nonce.length !== 12 || tag.length !== 16 || bytes.length > REPORT_EXPORT_MAX_BYTES) throw new Error('EXPORT_CIPHER_INVALID');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce); decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(bytes), decipher.final()]);
}
const aad = (row: Pick<ExportRow, 'id' | 'account_id' | 'role'>, kind: 'snapshot' | 'artifact') => JSON.stringify(['longball.report-export/1', kind, row.id, row.account_id, row.role]);
function bounded(bytes: Uint8Array): Uint8Array { if (bytes.byteLength > REPORT_EXPORT_MAX_BYTES) fail('EXPORT_TOO_LARGE', 413, 'This report exceeds the five MiB export limit. Choose a smaller report.'); return bytes; }
function flatten(value: unknown, prefix = '', depth = 0): { label: string; value: unknown }[] {
  if (depth > 30) fail('EXPORT_DOCUMENT_INVALID', 422, 'The report data exceeds the supported structure.');
  if (Array.isArray(value)) return value.length ? value.flatMap((item, index) => flatten(item, `${prefix}[${index + 1}]`, depth + 1)) : [{ label: prefix, value: 'No records' }];
  if (object(value)) return Object.keys(value).sort().flatMap(key => flatten(value[key], prefix ? `${prefix}.${key}` : key, depth + 1));
  return [{ label: prefix, value }];
}
function renderCsv(document: ExportDocument): Uint8Array {
  const cell = (value: unknown) => {
    let text = value === null || value === undefined ? 'Not recorded' : String(value);
    text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    if (/^[\t\r ]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const rows: unknown[][] = [['section', 'field', 'value'], ...flatten(document.metadata).map(item => ['metadata', item.label, item.value])];
  for (const section of document.sections) for (const item of flatten(section.value)) rows.push([section.title, item.label, item.value]);
  return bounded(Buffer.from('\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n')));
}
function disclosed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(disclosed);
  if (!object(value)) return value;
  const masked = typeof value.suppressionReason === 'string' && value.suppressionReason.length > 0;
  const fields = ['score', 'halfTimeScore', 'goals', 'unassignedGoalsFor', 'unassignedGoalsAgainst', 'totals', 'scorerTotals', 'form', 'withheldResultCount', 'dataCoverage'];
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, masked && fields.includes(key) ? 'Withheld by competition policy' : disclosed(item)]));
}
function asPdf(document: ExportDocument): ReportPdfDocument { return { title: document.title, metadata: document.metadata, sections: document.sections.map(section => ({ title: section.title, rows: flatten(section.value) })) }; }
export function reportExportRevision(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^"(?:0|[1-9]\d{0,14})"$/.test(value) || !Number.isSafeInteger(Number(value.slice(1, -1)))) fail('INVALID_REQUEST', 400, 'Use the exact quoted report projection revision in If-Match.');
  return Number(value.slice(1, -1));
}

export class ReportExportService {
  readonly keyId: string | null;
  constructor(readonly repository: ReportExportRepository, readonly source: DevelopmentStore | PostgresStore, readonly options?: ReportExportOptions, readonly now = Date.now) {
    if (options && (options.encryptionKey.byteLength !== 32 || !Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1_000 || options.ttlMs > 86_400_000)) throw new Error('Report exports require a 32-byte encryption key and explicit bounded expiry.');
    this.keyId = options ? createHash('sha256').update(options.encryptionKey).digest('hex').slice(0, 32) : null;
  }
  get configured() { return Boolean(this.options); }
  async authorize(principal: Principal, value: unknown, role?: string): Promise<{ request: ReportExportRequest; viewer: RecordsViewer }> {
    let request: ReportExportRequest;
    try { request = parseReportExportRequest(value); } catch { return fail('INVALID_REQUEST', 400, 'Choose the exact report kind, team-season, optional match and CSV or PDF format.'); }
    const viewer = await this.source.recordsViewer(principal, request.teamId, request.seasonId, role);
    if (request.kind === 'own_participation' && viewer.actor !== 'player' || request.kind === 'team_participation' && viewer.actor !== 'manager' || request.kind === 'attendance' && viewer.actor === 'spectator') fail('NOT_FOUND', 404, 'That report is unavailable in the selected role.');
    return { request, viewer };
  }
  async create(principal: Principal, value: unknown, role?: string, expectedRevision?: number): Promise<ReportExportStatus> {
    if (!this.options || !this.keyId) fail('EXPORT_NOT_CONFIGURED', 503, 'Report exports need an explicitly configured private key and expiry.');
    const { request, viewer } = await this.authorize(principal, value, role);
    const legacy = await this.source.recordsExport(principal, request.teamId, request.seasonId, { kind: request.kind === 'match_summary' ? 'match' : 'season', format: 'json', ...(request.matchId ? { matchId: request.matchId } : {}), expectedProjectionVersion: expectedRevision }, viewer.actor);
    const body = JSON.parse(legacy.body) as Record<string, unknown>;
    const participation = object(body.participation) ? body.participation : null;
    let sections: ExportDocument['sections'];
    if (request.kind === 'own_participation' || request.kind === 'team_participation') {
      if (!participation || participation.access !== 'permitted') fail('NOT_FOUND', 404, 'Participation is unavailable in the selected role.');
      sections = [{ title: titles[request.kind], value: participation }];
    } else if (request.kind === 'attendance') {
      if (!participation || participation.access !== 'permitted' || !Array.isArray(participation.rows)) fail('NOT_FOUND', 404, 'Attendance is unavailable in the selected role.');
      const fields = ['playerId', 'label', 'games', 'training', 'gameRecords', 'trainingRecords', 'coverageLabel', 'evidenceState'];
      sections = [{ title: 'Attendance', value: { ...Object.fromEntries(Object.entries(participation).filter(([key]) => key !== 'rows')), rows: participation.rows.map(row => object(row) ? Object.fromEntries(Object.entries(row).filter(([key]) => fields.includes(key))) : null) } }];
    } else sections = [{ title: titles[request.kind], value: request.kind === 'match_summary' ? body.matches : body.results }];
    const metadata = Object.fromEntries(Object.entries(body).filter(([key]) => !['participation', 'results', 'matches'].includes(key)));
    const document: ExportDocument = { schemaVersion: 1, title: `LongBall · ${titles[request.kind]}`, metadata: { ...metadata, reportType: request.kind, asOf: body.asOf ?? null, requestedAt: new Date(this.now()).toISOString() }, sections: sections.map(section => ({ ...section, value: disclosed(section.value) })) };
    const bytes = bounded(Buffer.from(JSON.stringify(document)));
    const id = randomUUID(), at = this.now();
    const policies = [...(Array.isArray(body.policyVersions) ? body.policyVersions : []), ...(Array.isArray(body.matches) ? body.matches : []), ...(object(body.results) && Array.isArray(body.results.competitionPolicies) ? body.results.competitionPolicies : [])].filter(object);
    const publication = [...new Map(policies.filter(item => typeof item.policyId === 'string' && Number.isSafeInteger(item.policyVersion) && Number(item.policyVersion) >= 0).map(item => [JSON.stringify([item.policyId, item.policyVersion]), { policyId: String(item.policyId), version: Number(item.policyVersion) }])).values()];
    const row: ExportRow = { id, job_id: `report-export-${id}`, account_id: principal.accountId, issuer: principal.issuer, subject: principal.subject, team_id: request.teamId, season_id: request.seasonId, role: viewer.actor, player_id: viewer.playerId ?? null,
      request_json: JSON.stringify(request), status: 'queued', created_at: at, expires_at: at + this.options.ttlMs, generated_at: null, failure_code: null, publication_json: JSON.stringify(publication), source_fingerprint: await this.repository.sourceFingerprint(request.teamId, request.seasonId), snapshot_ciphertext: null, artifact_ciphertext: null, artifact_sha256: null, key_id: this.keyId, version: 0 };
    row.snapshot_ciphertext = encrypted(this.options.encryptionKey, aad(row, 'snapshot'), bytes);
    await this.repository.create(row);
    return this.dto(row);
  }
  dto(row: ExportRow): ReportExportStatus { return { id: row.id, status: row.status, downloadPath: row.status === 'ready' ? `/v1/exports/${encodeURIComponent(row.id)}/download` : null, expiresAt: new Date(row.expires_at).toISOString(), failureCode: row.failure_code, publicationPolicyVersions: JSON.parse(row.publication_json), generatedAt: row.generated_at === null ? null : new Date(row.generated_at).toISOString() }; }
  private async owned(principal: Principal, id: string, role?: string): Promise<ExportRow> {
    const row = await this.repository.get(id);
    if (!row || row.account_id !== principal.accountId || row.issuer !== principal.issuer || row.subject !== principal.subject || role && role !== row.role) fail('NOT_FOUND', 404, 'That export is unavailable in the current account and role.');
    if (this.source instanceof PostgresStore) {
      const context = this.source.db.applicationContext;
      if (context?.kind !== 'actor' || !['exports.read', 'exports.download'].includes(context.operation ?? '')) fail('NOT_FOUND', 404, 'That export is unavailable in the current request.');
      await this.source.withActorContext(principal, { operation: context.operation!, requestedRole: context.requestedRole ?? 'default', teamId: row.team_id, seasonId: row.season_id }, () => this.authorize(principal, JSON.parse(row.request_json), row.role));
    } else await this.authorize(principal, JSON.parse(row.request_json), row.role);
    return row;
  }
  async status(principal: Principal, id: string, role?: string): Promise<ReportExportStatus> {
    const row = await this.owned(principal, id, role);
    const current = await this.repository.current(row);
    if (!current.allowed) fail('NOT_FOUND', 404, 'That export is unavailable under the current team access.');
    if (current.nowMs >= row.expires_at) { await this.repository.expire(row); return this.dto({ ...row, status: 'expired', artifact_ciphertext: null, snapshot_ciphertext: null, failure_code: 'EXPORT_EXPIRED' }); }
    if (['queued', 'working', 'ready'].includes(row.status) && (row.key_id !== this.keyId || row.source_fingerprint !== current.sourceFingerprint)) {
      const code = row.key_id !== this.keyId ? 'EXPORT_KEY_CHANGED' : 'EXPORT_SOURCE_CHANGED';
      await this.repository.invalidate(row, code); return this.dto({ ...row, status: 'failed', failure_code: code, snapshot_ciphertext: null, artifact_ciphertext: null });
    }
    return this.dto(row);
  }
  async download(principal: Principal, id: string, role?: string): Promise<{ bytes: Uint8Array; contentType: string; filename: string }> {
    const state = await this.status(principal, id, role);
    if (state.status === 'expired') fail('EXPORT_EXPIRED', 410, 'This export expired. Request a fresh report.');
    if (state.status !== 'ready') fail(state.failureCode ?? 'EXPORT_NOT_READY', 409, 'This export is unavailable or changed. Request a fresh report.');
    const row = await this.owned(principal, id, role), current = await this.repository.current(row);
    if (!current.allowed) fail('NOT_FOUND', 404, 'That export is unavailable under the current access.');
    if (current.nowMs >= row.expires_at) { await this.repository.expire(row); fail('EXPORT_EXPIRED', 410, 'This export expired. Request a fresh report.'); }
    if (current.sourceFingerprint !== row.source_fingerprint) { await this.repository.invalidate(row, 'EXPORT_SOURCE_CHANGED'); fail('EXPORT_SOURCE_CHANGED', 409, 'This report changed. Request a fresh export.'); }
    if (!this.options || row.key_id !== this.keyId || !row.artifact_ciphertext || !row.artifact_sha256) fail('EXPORT_KEY_CHANGED', 409, 'This export cannot be opened with the current private key. Request a fresh report.');
    let bytes: Uint8Array;
    try { bytes = bounded(decrypted(this.options.encryptionKey, aad(row, 'artifact'), row.artifact_ciphertext)); }
    catch { await this.repository.invalidate(row, 'EXPORT_DECRYPTION_FAILED'); return fail('EXPORT_DECRYPTION_FAILED', 409, 'The encrypted export could not be verified. Request a fresh report.'); }
    if (createHash('sha256').update(bytes).digest('hex') !== row.artifact_sha256) { await this.repository.invalidate(row, 'EXPORT_INTEGRITY_FAILED'); fail('EXPORT_INTEGRITY_FAILED', 409, 'The export did not pass integrity verification. Request a fresh report.'); }
    const recordDownload = async () => {
      const latest = await this.repository.current(row);
      if (!latest.allowed) fail('NOT_FOUND', 404, 'That export is unavailable under the current access.');
      if (latest.nowMs >= row.expires_at) fail('EXPORT_EXPIRED', 410, 'This export expired. Request a fresh report.');
      if (latest.sourceFingerprint !== row.source_fingerprint) fail('EXPORT_SOURCE_CHANGED', 409, 'This report changed. Request a fresh export.');
      await this.source.audit(principal, 'export.download', row.id, 'delivered');
    };
    if (this.source instanceof PostgresStore) {
      const source = this.source, context = source.db.applicationContext;
      if (context?.kind !== 'actor' || context.operation !== 'exports.download') fail('NOT_FOUND', 404, 'That export is unavailable in the current request.');
      await source.withActorContext(principal, { operation: context.operation, requestedRole: context.requestedRole ?? 'default', teamId: row.team_id, seasonId: row.season_id }, () => source.transaction(recordDownload));
    } else await recordDownload();
    const request = parseReportExportRequest(JSON.parse(row.request_json));
    return { bytes, contentType: request.format === 'pdf' ? 'application/pdf' : 'text/csv; charset=utf-8', filename: `longball-report-${row.id}.${request.format}` };
  }
  async generate(claim: ExportClaim): Promise<{ artifactCiphertext: string; artifactSha256: string; generatedAtMs: number }> {
    const row = claim.row;
    if (!this.options || row.key_id !== this.keyId || !row.snapshot_ciphertext) fail('EXPORT_KEY_CHANGED', 409, 'The queued export cannot be opened with the current private key.');
    const current = await this.repository.withClaim(claim, () => this.repository.current(row));
    if (!current.allowed) fail('EXPORT_ACCESS_CHANGED', 403, 'The queued report no longer has authorised access.');
    if (current.nowMs >= row.expires_at) fail('EXPORT_EXPIRED', 410, 'The queued report expired.');
    if (current.sourceFingerprint !== row.source_fingerprint) fail('EXPORT_SOURCE_CHANGED', 409, 'The queued report changed. Request a fresh export.');
    let document: ExportDocument;
    try { document = JSON.parse(decrypted(this.options.encryptionKey, aad(row, 'snapshot'), row.snapshot_ciphertext).toString('utf8')) as ExportDocument; }
    catch { return fail('EXPORT_DECRYPTION_FAILED', 409, 'The queued report could not be decrypted.'); }
    if (document.schemaVersion !== 1 || !Array.isArray(document.sections) || !object(document.metadata)) fail('EXPORT_DOCUMENT_INVALID', 422, 'The queued report is incompatible.');
    const generatedAtMs = current.nowMs;
    document = copy(document); document.metadata.generatedAt = new Date(generatedAtMs).toISOString();
    const request = parseReportExportRequest(JSON.parse(row.request_json));
    const bytes = bounded(request.format === 'pdf' ? await generateReportPdf(asPdf(document)) : renderCsv(document));
    const fresh = await this.repository.withClaim(claim, () => this.repository.current(row));
    if (!fresh.allowed) fail('EXPORT_ACCESS_CHANGED', 403, 'The report lost authorised access while it was generated.');
    if (fresh.nowMs >= row.expires_at) fail('EXPORT_EXPIRED', 410, 'The report expired while it was generated.');
    if (fresh.sourceFingerprint !== row.source_fingerprint) fail('EXPORT_SOURCE_CHANGED', 409, 'The report changed during generation. Request a fresh export.');
    return { artifactCiphertext: encrypted(this.options.encryptionKey, aad(row, 'artifact'), bytes), artifactSha256: createHash('sha256').update(bytes).digest('hex'), generatedAtMs };
  }
}
