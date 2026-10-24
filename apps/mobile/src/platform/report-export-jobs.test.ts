import { describe, expect, it, vi } from 'vitest';
import { ReportExportJobsClient, parseReportExportStatus } from './report-export-jobs';
import type { ReportExportRequest, ReportExportStatus } from '@longball/application/report-export';
import { REPORT_EXPORT_MAX_BYTES } from '@longball/application/report-export';
const id = '12345678-1234-4234-8234-123456789012', key = '87654321-4321-4321-8321-210987654321';
const request: ReportExportRequest = { kind: 'season_results', teamId: 'team-a', seasonId: '2026-27', format: 'pdf' };
const status = (state: ReportExportStatus['status'] = 'queued'): ReportExportStatus => ({ id, status: state, downloadPath: state === 'ready' ? `/v1/exports/${id}/download` : null, expiresAt: state === 'ready' ? '2026-10-22T00:00:00.000Z' : null, generatedAt: state === 'ready' ? '2026-10-21T23:00:00.000Z' : null, failureCode: state === 'failed' ? 'PREPARATION_FAILED' : null, publicationPolicyVersions: [{ policyId: 'approved-demo-policy', version: 1 }] });
const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code, headers: { 'content-type': 'application/json' } });
const pdf = new TextEncoder().encode('%PDF-1.7\nBinary report fixture\n%%EOF\n');
const bytesResponse = (bytes = pdf, headers: Record<string, string> = {}) => new Response(Uint8Array.from(bytes).buffer, { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="longball-report-${id}.pdf"`, 'cache-control': 'private, no-store', 'content-length': String(bytes.byteLength), 'content-encoding': 'identity', ...headers } });
function client(fetch: (url: string, options: RequestInit) => Promise<Response>, overrides: Partial<ConstructorParameters<typeof ReportExportJobsClient>[0]> = {}) {
  const deliver = vi.fn(async () => 'download started'), assertAccess = vi.fn(async () => {});
  const options = { baseUrl: 'https://api.example.test', role: 'manager' as const, teamId: request.teamId, seasonId: request.seasonId, fetch, assertAccess, deliver, ...overrides };
  return { service: new ReportExportJobsClient(options), deliver: options.deliver, assertAccess: options.assertAccess };
}
describe('canonical export job client', () => {
  it('keeps an uncertain creation retry on exactly the same key, body and reviewed projection; creation never downloads', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('connection lost')).mockResolvedValueOnce(json(status(), 202));
    const lab = client(fetch), signal = new AbortController().signal;
    await expect(lab.service.create(request, 12, key, signal)).rejects.toThrow('connection lost');
    expect(await lab.service.create(request, 12, key, signal)).toEqual(status());
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const call of fetch.mock.calls) {
      expect(call[0]).toBe('https://api.example.test/v1/exports');
      expect(call[1]).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', body: JSON.stringify(request), headers: { 'If-Match': '"12"', 'Idempotency-Key': key, 'X-Longball-Role': 'manager' } });
    }
    expect(lab.deliver).not.toHaveBeenCalled();
  });
  it('rejects cross-scope and role-inappropriate exports before contacting the service', async () => {
    const fetch = vi.fn(async () => json(status(), 202));
    for (const role of ['spectator', 'administrator'] as const) {
      const lab = client(fetch, { role });
      await expect(lab.service.create({ ...request, kind: 'team_participation' }, 1, key, new AbortController().signal)).rejects.toThrow('scope');
    }
    const lab = client(fetch);
    await expect(lab.service.create({ ...request, teamId: 'other' }, 1, key, new AbortController().signal)).rejects.toThrow('scope');
    await expect(lab.service.create({ ...request, kind: 'match_summary', matchId: null }, 1, key, new AbortController().signal)).rejects.toThrow('scope');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('allows only the exact private status/download path and refuses foreign references, public URLs or extra fields', () => {
    expect(parseReportExportStatus(status('ready'), id)).toEqual(status('ready'));
    for (const patch of [{ downloadPath: 'https://other.example/report.pdf' }, { downloadPath: `/v1/exports/${key}/download` }, { id: key }, { failureCode: 'password secret' }, { generatedAt: null }, { publicationPolicyVersions: [{ policyId: 'p', version: 0 }] }, { privateBallots: ['must not enter'] }]) expect(() => parseReportExportStatus({ ...status('ready'), ...patch }, id)).toThrow('invalid');
    expect(() => parseReportExportStatus({ ...status(), downloadPath: `/v1/exports/${id}/download` })).toThrow('invalid');
  });
  it('reads current status before an explicit protected PDF download and passes actual bytes to the file adapter', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(status('ready'))).mockResolvedValueOnce(bytesResponse());
    const lab = client(fetch);
    expect(await lab.service.download(id, 'pdf', new AbortController().signal)).toBe('download started');
    expect(fetch.mock.calls.map(call => call[0])).toEqual([`https://api.example.test/v1/exports/${id}`, `https://api.example.test/v1/exports/${id}/download`]);
    expect(lab.deliver).toHaveBeenCalledWith({ fileName: `longball-report-${id}.pdf`, contentType: 'application/pdf', bytes: pdf }, expect.any(Function));
    expect(lab.assertAccess).toHaveBeenCalledTimes(4);
  });
  it('refuses expired, incomplete, oversized, public, wrong MIME/filename and HTML-disguised PDF responses before any file is delivered', async () => {
    const expired = client(async () => json(status('expired')));
    await expect(expired.service.download(id, 'pdf', new AbortController().signal)).rejects.toThrow('expired');
    expect(expired.deliver).not.toHaveBeenCalled();
    for (const response of [
      bytesResponse(pdf, { 'content-type': 'text/html' }), bytesResponse(pdf, { 'content-disposition': 'attachment; filename="../private.pdf"' }),
      bytesResponse(pdf, { 'cache-control': 'public, max-age=3600' }), bytesResponse(pdf, { 'content-length': String(5 * 1024 * 1024 + 1) }),
      bytesResponse(pdf, { 'content-length': String(pdf.length + 1) }), bytesResponse(new TextEncoder().encode('<html>not a PDF</html>')),
    ]) {
      const lab = client(vi.fn().mockResolvedValueOnce(json(status('ready'))).mockResolvedValueOnce(response));
      await expect(lab.service.download(id, 'pdf', new AbortController().signal)).rejects.toThrow(/invalid|incomplete/);
      expect(lab.deliver).not.toHaveBeenCalled();
    }
  });
  it('discards the bytes if the workspace closes during the binary body read', async () => {
    let allowed = true;
    const response = new Response(new ReadableStream({ pull(controller) { allowed = false; controller.enqueue(pdf); controller.close(); } }, { highWaterMark: 0 }), { headers: bytesResponse().headers });
    const lab = client(vi.fn().mockResolvedValueOnce(json(status('ready'))).mockResolvedValueOnce(response), { assertAccess: async () => { if (!allowed) throw new Error('context changed'); } });
    await expect(lab.service.download(id, 'pdf', new AbortController().signal)).rejects.toThrow('context changed');
    expect(lab.deliver).not.toHaveBeenCalled();
  });
  it('accepts a chunked response without Content-Length while bounding actual decoded bytes', async () => {
    const headers = bytesResponse().headers; headers.delete('content-length');
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(pdf.slice(0, 8)); controller.enqueue(pdf.slice(8)); controller.close(); } }), { headers });
    const lab = client(vi.fn().mockResolvedValueOnce(json(status('ready'))).mockResolvedValueOnce(response));
    await expect(lab.service.download(id, 'pdf', new AbortController().signal)).resolves.toBe('download started');
    expect(lab.deliver).toHaveBeenCalledWith(expect.objectContaining({ bytes: pdf }), expect.any(Function));
  });
  it('accepts decoded compressed bytes when wire length differs or CORS hides encoding', async () => {
    for (const encoding of ['gzip', null]) {
      const response = bytesResponse(pdf, { 'content-length': String(pdf.byteLength - 4), 'content-encoding': 'gzip' });
      if (encoding === null) response.headers.delete('content-encoding');
      const lab = client(vi.fn().mockResolvedValueOnce(json(status('ready'))).mockResolvedValueOnce(response));
      await expect(lab.service.download(id, 'pdf', new AbortController().signal)).resolves.toBe('download started');
      expect(lab.deliver).toHaveBeenCalledWith(expect.objectContaining({ bytes: pdf }), expect.any(Function));
    }
  });
  it('cancels and unlocks an oversized stream before consuming or delivering its remaining bytes', async () => {
    const cancel = vi.fn(), headers = bytesResponse().headers; headers.delete('content-length');
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { reads += 1; controller.enqueue(new Uint8Array(REPORT_EXPORT_MAX_BYTES + 1)); }, cancel }, { highWaterMark: 0 });
    const lab = client(vi.fn().mockResolvedValueOnce(json(status('ready'))).mockResolvedValueOnce(new Response(stream, { headers })));
    await expect(lab.service.download(id, 'pdf', new AbortController().signal)).rejects.toThrow('too large');
    expect(reads).toBe(1); expect(cancel).toHaveBeenCalledOnce(); expect(stream.locked).toBe(false); expect(lab.deliver).not.toHaveBeenCalled();
  });
  it('cancels and unlocks a pending binary stream on caller abort without delivering a file', async () => {
    const cancel = vi.fn(), started = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull() { started(); return new Promise(() => {}); }, cancel }, { highWaterMark: 0 });
    const lab = client(vi.fn().mockResolvedValueOnce(json(status('ready'))).mockResolvedValueOnce(new Response(stream, { headers: bytesResponse().headers })));
    const controller = new AbortController(), pending = lab.service.download(id, 'pdf', controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    controller.abort(); await assertion;
    await vi.waitFor(() => { expect(cancel).toHaveBeenCalledOnce(); expect(stream.locked).toBe(false); });
    expect(lab.deliver).not.toHaveBeenCalled();
  });
  it('bounds the native arrayBuffer fallback before handing bytes to a file adapter', async () => {
    const response = bytesResponse(); Object.defineProperty(response, 'body', { value: null });
    response.headers.delete('content-length'); response.arrayBuffer = async () => new ArrayBuffer(REPORT_EXPORT_MAX_BYTES + 1);
    const lab = client(vi.fn().mockResolvedValueOnce(json(status('ready'))).mockResolvedValueOnce(response));
    await expect(lab.service.download(id, 'pdf', new AbortController().signal)).rejects.toThrow('too large'); expect(lab.deliver).not.toHaveBeenCalled();
  });
  it('cancels an in-flight status body without waiting for timeout or performing a download', async () => {
    const response = json(status()); response.json = async () => new Promise(() => {});
    let transport: AbortSignal | undefined; const fetch = vi.fn(async (_url: string, options: RequestInit) => { transport = options.signal as AbortSignal; return response; });
    const lab = client(fetch), controller = new AbortController();
    const pending = lab.service.read(id, controller.signal).catch(error => error);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort(); expect(await pending).toMatchObject({ name: 'AbortError' }); expect(transport?.aborted).toBe(true);
    expect(lab.deliver).not.toHaveBeenCalled();
  });
  it('reports a known server authority denial so the original protected workspace can close its views', async () => {
    const closed = vi.fn(), lab = client(async () => json({ code: 'NOT_FOUND', message: 'The requested object is unavailable.' }, 404), { onAccessDenied: closed });
    await expect(lab.service.read(id, new AbortController().signal)).rejects.toMatchObject({ status: 404 });
    expect(closed).toHaveBeenCalledOnce(); expect(lab.deliver).not.toHaveBeenCalled();
  });
  it('refuses a locked original account before requesting status or bytes', async () => {
    const fetch = vi.fn(async () => json(status('ready'))), lab = client(fetch, { assertAccess: async () => { throw new Error('session locked'); } });
    await expect(lab.service.read(id, new AbortController().signal)).rejects.toThrow('session locked'); expect(fetch).not.toHaveBeenCalled();
  });
});
