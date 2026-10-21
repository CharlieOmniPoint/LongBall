import type { CommunityActor } from '@longball/application/community';
import { WIRE_CONTRACT_VERSION } from '@longball/application/sync';

export interface LocalUploadImage { bytes: Uint8Array; mimeType: 'image/png' | 'image/jpeg'; label: string; uri: string }
export interface RemotePreparedUpload { uploadId: string; photoId: string; uploadToken: string; expiresAtMs: number; maxBytes: number; displayRevision: number }
export interface RemoteMediaReceipt { uploadId: string; photoId: string; status: 'processed'; width: number; height: number; displayRevision: number }
export interface RemoteOwnUpload { uploadId: string; photoId: string; status: string; byteSize: number; displayRevision: number; width: number | null; height: number | null; failureCode: string | null; expiresAtMs: number }
export type MediaAuthenticatedFetch = (url: string, init: RequestInit) => Promise<Response>;

export class MediaUploadClient {
  private readonly baseUrl: string;
  constructor(baseUrl: string, private readonly actor: CommunityActor, private readonly authenticatedFetch: MediaAuthenticatedFetch) {
    const supplied = baseUrl.trim();
    if (!supplied || /[\u0000-\u001F]/.test(supplied)) throw new Error('A valid LongBall API URL is required.');
    if (supplied !== '/') {
      const parsed = new URL(supplied);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Use an HTTP(S) API URL without credentials, query or fragment.');
    }
    this.baseUrl = supplied === '/' ? '' : supplied.replace(/\/$/, '').replace(/\/v1$/, '');
  }
  private url(path: string, query = '') {
    return `${this.baseUrl}/v1/teams/${encodeURIComponent(this.actor.teamId)}/media/${path}?seasonId=${encodeURIComponent(this.actor.seasonId)}${query}`;
  }
  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.authenticatedFetch(this.url(path), { ...init, signal: controller.signal, redirect: 'error', credentials: 'omit',
        headers: { Accept: 'application/json', 'X-Longball-Role': this.actor.role, 'X-Api-Contract-Version': WIRE_CONTRACT_VERSION, ...init.headers } });
      const text = await response.text();
      if (text.length > 128_000) throw new Error('The media service response exceeded its allowed size.');
      let body: unknown;
      try { body = JSON.parse(text); } catch { throw new Error(`The media API did not return a valid response (HTTP ${response.status}). Check the connected service URL.`); }
      if (!response.ok) {
        const failure = body && typeof body === 'object' && 'error' in body ? body.error : body;
        const message = failure && typeof failure === 'object' && 'message' in failure && typeof failure.message === 'string' && failure.message.length <= 400 ? failure.message : `Media request failed (HTTP ${response.status}).`;
        throw new Error(message);
      }
      return body as T;
    } finally { clearTimeout(timer); }
  }
  prepare(input: { requestId: string; matchId: string; image: LocalUploadImage; sha256: string; caption: string }) {
    return this.request<RemotePreparedUpload>('uploads/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': input.requestId },
      body: JSON.stringify({ matchId: input.matchId, byteSize: input.image.bytes.byteLength, mimeType: input.image.mimeType, sha256: input.sha256, caption: input.caption, policyAcknowledged: true }) });
  }
  upload(prepared: RemotePreparedUpload, image: LocalUploadImage, requestId: string) {
    return this.request<{ uploadId: string; status: 'uploaded'; byteSize: number }>(`uploads/${encodeURIComponent(prepared.uploadId)}`, {
      method: 'PUT', headers: { 'Content-Type': image.mimeType, 'Idempotency-Key': `${requestId}-upload`, 'X-Media-Upload-Token': prepared.uploadToken },
      body: Uint8Array.from(image.bytes).buffer,
    }, 60_000);
  }
  complete(prepared: RemotePreparedUpload, requestId: string) {
    return this.request<RemoteMediaReceipt>(`uploads/${encodeURIComponent(prepared.uploadId)}/complete`, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'Idempotency-Key': `${requestId}-complete`, 'X-Media-Upload-Token': prepared.uploadToken,
    }, body: '{}' }, 45_000);
  }
  async listOwn() { return (await this.request<{ items: RemoteOwnUpload[] }>('uploads')).items; }
  async image(photoId: string, revision: number, variant: 'thumbnail' | 'display' = 'display', mode: 'own' | 'gallery' | 'review' = 'own'): Promise<Uint8Array> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.authenticatedFetch(this.url(`photos/${encodeURIComponent(photoId)}/${variant}`, `&mode=${mode}&revision=${revision}`), {
        signal: controller.signal, redirect: 'error', credentials: 'omit', headers: { Accept: 'image/jpeg', 'X-Longball-Role': this.actor.role },
      });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/jpeg')) throw new Error('The private image is no longer available to this account.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('The private derivative exceeded its allowed size.');
      return bytes;
    } finally { clearTimeout(timer); }
  }
}
