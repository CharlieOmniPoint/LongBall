import type { Role } from '@longball/application/access';
import { REPORT_EXPORT_MAX_BYTES, type ReportExportRequest, type ReportExportStatus } from '@longball/application/report-export';
import { ServiceError, WIRE_CONTRACT_VERSION } from '@longball/application/sync';
import type { ReportArtifact } from './report-export-artifact';
import { reportArtifactBytes } from './report-export-artifact';

export interface ReportExportJobPort {
  create: (request: ReportExportRequest, projectionVersion: number, key: string, signal: AbortSignal) => Promise<ReportExportStatus>;
  read: (exportId: string, signal: AbortSignal) => Promise<ReportExportStatus>;
  download: (exportId: string, format: 'csv' | 'pdf', signal: AbortSignal) => Promise<string>;
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && value.length <= 40 && Number.isFinite(Date.parse(value));
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function cancelled(): Error { const error = new Error('The export operation was cancelled.'); error.name = 'AbortError'; return error; }
async function readBoundedReportBody(response: Response, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (signal.aborted) throw cancelled();
  // Some native fetch implementations provide arrayBuffer without a reader.
  // Validate those bytes before the file adapter can create a private tempfile.
  if (!response.body || typeof response.body.getReader !== 'function') {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (signal.aborted) throw cancelled();
    if (bytes.byteLength > REPORT_EXPORT_MAX_BYTES) throw new Error('The protected export is too large. No file was opened.');
    return bytes;
  }
  const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0, stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw cancelled();
      const part = await reader.read();
      if (signal.aborted) throw cancelled();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > REPORT_EXPORT_MAX_BYTES) throw new Error('The protected export is too large. No file was opened.');
      chunks.push(Uint8Array.from(part.value));
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (cause) {
    stop();
    throw cause;
  } finally {
    signal.removeEventListener('abort', stop);
    reader.releaseLock();
  }
}
export function parseReportExportStatus(value: unknown, expectedId?: string): ReportExportStatus {
  const fields = ['id', 'status', 'downloadPath', 'expiresAt', 'failureCode', 'publicationPolicyVersions', 'generatedAt'];
  if (!object(value) || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key)) || !uuid(value.id) || expectedId !== undefined && value.id !== expectedId || !['queued', 'working', 'ready', 'failed', 'expired'].includes(value.status as string) || !(value.expiresAt === null || date(value.expiresAt)) || !(value.generatedAt === null || date(value.generatedAt)) || !(value.failureCode === null || typeof value.failureCode === 'string' && /^[A-Z0-9_]{1,80}$/.test(value.failureCode)) || !Array.isArray(value.publicationPolicyVersions) || value.publicationPolicyVersions.length > 10_000 || value.publicationPolicyVersions.some(policy => !object(policy) || Object.keys(policy).length !== 2 || !['policyId', 'version'].every(key => Object.hasOwn(policy, key)) || typeof policy.policyId !== 'string' || !policy.policyId.length || policy.policyId.length > 150 || !Number.isSafeInteger(policy.version) || Number(policy.version) < 1)) throw new Error('The service export status is invalid.');
  if (value.status === 'ready' ? value.downloadPath !== `/v1/exports/${value.id}/download` || !date(value.expiresAt) || !date(value.generatedAt) || value.failureCode !== null : value.downloadPath !== null) throw new Error('The service export status is invalid.');
  return { ...value, publicationPolicyVersions: value.publicationPolicyVersions.map(policy => ({ ...policy })) } as ReportExportStatus;
}

/** The selected workspace supplies identity and access checks; status paths never grant access. */
export class ReportExportJobsClient {
  private readonly baseUrl: string;
  constructor(private readonly options: {
    baseUrl: string; role: Role; teamId: string; seasonId: string;
    fetch: (url: string, options: RequestInit) => Promise<Response>;
    assertAccess: () => Promise<void>;
    onAccessDenied?: () => void;
    deliver: (artifact: ReportArtifact, assertAccess: () => Promise<void>) => Promise<string>;
    timeoutMs?: number;
  }) {
    const supplied = options.baseUrl.trim();
    if (supplied === '/' || supplied === '') this.baseUrl = '';
    else {
      const url = new URL(supplied);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use a configured API origin for report exports.');
      this.baseUrl = supplied.replace(/\/$/, '').replace(/\/v1$/, '');
    }
  }
  private async exchange<T>(path: string, init: RequestInit, signal: AbortSignal, accept: (response: Response, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (signal.aborted) throw cancelled();
    await this.options.assertAccess();
    if (signal.aborted) throw cancelled();
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectCancellation: ((error: Error) => void) | undefined;
    const cancellation = new Promise<never>((_, reject) => { rejectCancellation = reject; });
    const abort = () => { rejectCancellation?.(cancelled()); controller.abort(); };
    signal.addEventListener('abort', abort, { once: true });
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new ServiceError('REQUEST_TIMEOUT', 0, 'The export request timed out. Retry the same request to check whether it was accepted.', true)); controller.abort(); }, this.options.timeoutMs ?? 15_000); });
    try {
      const result = await Promise.race([(async () => {
        const response = await this.options.fetch(`${this.baseUrl}${path}`, { ...init, signal: controller.signal, redirect: 'error', credentials: 'omit', headers: { Accept: 'application/json', 'X-Api-Contract-Version': WIRE_CONTRACT_VERSION, 'X-Longball-Role': this.options.role, ...init.headers } });
        if (signal.aborted) throw cancelled();
        if (!response.ok) {
          if ([401, 403, 404].includes(response.status)) this.options.onAccessDenied?.();
          const body = await response.json().catch(() => null);
          throw new ServiceError(object(body) && typeof body.code === 'string' ? body.code : 'EXPORT_FAILED', response.status, object(body) && typeof body.message === 'string' && body.message.length <= 400 ? body.message : 'The permitted export is unavailable. Refresh its status before retrying.', response.status >= 500 || response.status === 429);
        }
        const result = await accept(response, controller.signal);
        if (signal.aborted) throw cancelled();
        await this.options.assertAccess();
        if (signal.aborted) throw cancelled();
        return result;
      })(), timeout, cancellation]);
      return result;
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
  async create(request: ReportExportRequest, projectionVersion: number, key: string, signal: AbortSignal): Promise<ReportExportStatus> {
    const kinds = ['own_participation', 'team_participation', 'attendance', 'match_summary', 'season_results'];
    const permitted = this.options.role === 'manager' ? request.kind !== 'own_participation' : this.options.role === 'player' ? request.kind !== 'team_participation' : this.options.role === 'spectator' ? ['match_summary', 'season_results'].includes(request.kind) : false;
    if (!uuid(key) || !Number.isSafeInteger(projectionVersion) || projectionVersion < 0 || request.teamId !== this.options.teamId || request.seasonId !== this.options.seasonId || !['csv', 'pdf'].includes(request.format) || !kinds.includes(request.kind) || !permitted || request.kind === 'match_summary' && (typeof request.matchId !== 'string' || !request.matchId.length) || request.kind !== 'match_summary' && request.matchId != null) throw new Error('The export request differs from the current report scope.');
    const captured = { kind: request.kind, teamId: request.teamId, seasonId: request.seasonId, ...(request.matchId !== undefined ? { matchId: request.matchId } : {}), format: request.format };
    return this.exchange('/v1/exports', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, 'If-Match': `"${projectionVersion}"` }, body: JSON.stringify(captured) }, signal, async response => {
      if (response.status !== 202) throw new Error('The service did not acknowledge an export job. Retry the captured request.');
      return parseReportExportStatus(await response.json());
    });
  }
  read(exportId: string, signal: AbortSignal): Promise<ReportExportStatus> {
    if (!uuid(exportId)) throw new Error('The export reference is invalid.');
    return this.exchange(`/v1/exports/${exportId}`, { method: 'GET' }, signal, async response => parseReportExportStatus(await response.json(), exportId));
  }
  async download(exportId: string, format: 'csv' | 'pdf', signal: AbortSignal): Promise<string> {
    const status = await this.read(exportId, signal);
    if (status.status !== 'ready' || !status.downloadPath) throw new Error(status.status === 'expired' ? 'This export expired. Prepare a new report.' : 'This export is not ready to download.');
    const expectedName = `longball-report-${exportId}.${format}`, expectedMime = format === 'pdf' ? 'application/pdf' : 'text/csv';
    const artifact = await this.exchange(status.downloadPath, { method: 'GET', headers: { Accept: expectedMime } }, signal, async (response, bodySignal) => {
      const mime = response.headers.get('content-type') ?? '', disposition = response.headers.get('content-disposition') ?? '', cache = response.headers.get('cache-control') ?? '', size = response.headers.get('content-length'), encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
      // Fetch returns decoded bytes and CORS may hide Content-Encoding. Enforce
      // wire-length equality only when the response explicitly declares identity.
      const identityEncoding = encoding === 'identity';
      const declaredSize = size === null ? null : /^\d+$/.test(size) && Number.isSafeInteger(Number(size)) ? Number(size) : NaN;
      if (response.status !== 200 || mime.split(';')[0].trim().toLowerCase() !== expectedMime || disposition !== `attachment; filename="${expectedName}"` || cache.toLowerCase().replaceAll(/\s/g, '') !== 'private,no-store' || declaredSize !== null && (!Number.isFinite(declaredSize) || identityEncoding && (declaredSize === 0 || declaredSize > REPORT_EXPORT_MAX_BYTES))) throw new Error('The protected export response is invalid. No file was opened.');
      const bytes = await readBoundedReportBody(response, bodySignal);
      if (identityEncoding && declaredSize !== null && bytes.byteLength !== declaredSize) throw new Error('The protected export is incomplete. No file was opened.');
      const artifact: ReportArtifact = { fileName: expectedName, contentType: mime, bytes };
      reportArtifactBytes(artifact); return artifact;
    });
    if (signal.aborted) throw cancelled();
    return this.options.deliver(artifact, async () => { if (signal.aborted) throw cancelled(); await this.options.assertAccess(); if (signal.aborted) throw cancelled(); });
  }
}
