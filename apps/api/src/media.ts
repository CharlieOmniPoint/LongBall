import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { AccessError } from '../../../packages/application/src/access';
import { authorizeCommunityMedia, communityCanAccess, type CommunityActor, type CommunityCommand, type CommunityState } from '../../../packages/application/src/community';

export const MEDIA_LIMITS = { maxBytes: 15 * 1024 * 1024, maxPixels: 40_000_000, displayEdge: 2048, thumbnailEdge: 480,
  uploadWindowMs: 15 * 60_000, uploadTimeoutMs: 60_000, decodeTimeoutMs: 12_000, scannerTimeoutMs: 20_000 } as const;
export interface MediaScanner {
  scan(bytes: Buffer, context: { mimeType: string; sha256: string }): Promise<{ verdict: 'clean' | 'rejected' | 'unavailable'; engine: string }>;
}
export interface MediaPrepareInput {
  requestId: string;
  matchId: string;
  byteSize: number;
  mimeType: string;
  sha256: string;
  caption: string;
  policyAcknowledged: true;
  /** A replacement creates a new immutable revision and preserves the approved one. */
  photoId?: string;
  sourceRevision?: number;
}
export interface PreparedMediaUpload { uploadId: string; photoId: string; uploadToken: string; expiresAtMs: number; maxBytes: number; displayRevision: number }
interface UploadRow {
  id: string; request_id: string; request_signature: string; owner_id: string; team_id: string; season_id: string; match_id: string;
  photo_id: string; source_revision: number | null; display_revision: number; status: string; expected_bytes: number;
  expected_sha: string; declared_mime: string; caption: string; token_hash: string; expires_at: number; created_at: number;
  original_key: string | null; display_key: string | null; thumbnail_key: string | null; width: number | null; height: number | null;
  scanner_engine: string | null; failure_code: string | null; attempt: string | null; lease_until: number | null;
}
const executeFile = promisify(execFile);
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,150}$/.test(value);
function fail(code: string, status: number, message: string): never { throw new AccessError(code, status, message); }
function auth(state: CommunityState, actor: CommunityActor, now: number, upload = false) {
  if (!communityCanAccess(state, actor, now) || (upload && actor.role === 'spectator')) fail('NOT_FOUND', 404, 'The requested media operation is unavailable.');
}
function sameToken(expectedHash: string, token: string) {
  return typeof token === 'string' && token.length <= 256 && timingSafeEqual(Buffer.from(expectedHash, 'hex'), Buffer.from(hash(token), 'hex'));
}
async function bounded<T>(promise: Promise<T>, milliseconds: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AccessError(code, 503, 'Media processing is unavailable. The private upload is retained for a safe retry.')), Math.max(1, milliseconds)); })]);
  } finally { if (timer) clearTimeout(timer); }
}
function actualMime(bytes: Buffer): 'image/jpeg' | 'image/png' | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  return null;
}
function rejectAnimatedPng(bytes: Buffer) {
  if (actualMime(bytes) !== 'image/png') return;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) fail('INVALID_IMAGE', 415, 'The image is incomplete or unsupported.');
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    if (kind === 'acTL') fail('ANIMATED_IMAGE_UNSUPPORTED', 415, 'Animated images are not supported.');
    offset += length + 12;
    if (kind === 'IEND') break;
  }
}

/** Real optional scanner adapter. Missing/unavailable databases never become a clean verdict. */
export function createClamAvScanner(executable: string, options: { timeoutMs?: number } = {}): MediaScanner {
  if (!isAbsolute(executable)) fail('SCANNER_CONFIGURATION_INVALID', 503, 'Configure an absolute path to the maintained ClamAV scanner.');
  const timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? 15_000, 20_000));
  let versionCheck: Promise<string | null> | null = null;
  const identify = async () => {
    try {
      const result = await executeFile(executable, ['--version'], { timeout: Math.min(timeoutMs, 3000), maxBuffer: 8192, windowsHide: true });
      return /^ClamAV\s+([0-9][0-9A-Za-z.+_-]*)/.exec(result.stdout.trim())?.[1] ?? null;
    } catch { return null; }
  };
  return {
    scan: async bytes => {
      const version = await (versionCheck ??= identify());
      if (!version) return { verdict: 'unavailable', engine: 'clamav_unverified' };
      return new Promise(resolveVerdict => {
      const child = spawn(executable, ['--no-summary', '--stdout', '--max-filesize=16M', '--max-scansize=16M', '--max-files=1', '--max-recursion=1', '--alert-exceeds-max=yes', '-'], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
      let finished = false;
      let outputBytes = 0;
      let scanOutput = '';
      const finish = (verdict: 'clean' | 'rejected' | 'unavailable') => {
        if (finished) return;
        finished = true; clearTimeout(timer); resolveVerdict({ verdict, engine: `clamav:${version}` });
      };
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish('unavailable'); }, timeoutMs);
      const consume = (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes > 64 * 1024) { child.kill('SIGKILL'); finish('unavailable'); } };
      child.stdout.on('data', (chunk: Buffer) => { consume(chunk); if (outputBytes <= 64 * 1024) scanOutput += chunk.toString('utf8'); }); child.stderr.on('data', consume);
      child.on('error', () => finish('unavailable'));
      child.stdin.on('error', () => { /* Exit/error determines the verdict; never log scan output. */ });
      child.on('close', code => finish(code === 0 && /^stdin:\s+OK\s*$/m.test(scanOutput) ? 'clean' : code === 1 ? 'rejected' : 'unavailable'));
      child.stdin.end(bytes);
      });
    },
  };
}

/** Private local object store for development; later buckets use the same gateway. */
export class DevelopmentMediaService {
  readonly database: DatabaseSync;
  readonly directory: string;
  readonly now: () => number;
  readonly scanner?: MediaScanner;
  private readonly ownDatabase: boolean;
  constructor(options: { directory: string; database?: DatabaseSync; scanner?: MediaScanner; now?: () => number }) {
    this.directory = resolve(options.directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 }); chmodSync(this.directory, 0o700);
    for (const name of ['quarantine', 'derivatives']) { mkdirSync(join(this.directory, name), { recursive: true, mode: 0o700 }); chmodSync(join(this.directory, name), 0o700); }
    this.ownDatabase = !options.database;
    this.database = options.database ?? new DatabaseSync(join(this.directory, 'media.sqlite'));
    if (this.ownDatabase) chmodSync(join(this.directory, 'media.sqlite'), 0o600);
    this.now = options.now ?? Date.now;
    this.scanner = options.scanner;
    this.database.exec(`CREATE TABLE IF NOT EXISTS media_uploads(
      id TEXT PRIMARY KEY,request_id TEXT NOT NULL,request_signature TEXT NOT NULL,owner_id TEXT NOT NULL,team_id TEXT NOT NULL,season_id TEXT NOT NULL,match_id TEXT NOT NULL,
      photo_id TEXT NOT NULL,source_revision INTEGER,display_revision INTEGER NOT NULL,status TEXT NOT NULL,expected_bytes INTEGER NOT NULL,expected_sha TEXT NOT NULL,
      declared_mime TEXT NOT NULL,caption TEXT NOT NULL,token_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,
      original_key TEXT,display_key TEXT,thumbnail_key TEXT,width INTEGER,height INTEGER,scanner_engine TEXT,failure_code TEXT,attempt TEXT,lease_until INTEGER,
      UNIQUE(owner_id,request_id));
      CREATE UNIQUE INDEX IF NOT EXISTS media_linked_revision ON media_uploads(photo_id,display_revision) WHERE status='linked';`);
  }
  close() { if (this.ownDatabase) this.database.close(); }
  private path(key: string): string {
    const path = resolve(this.directory, key);
    if (!path.startsWith(this.directory + sep)) fail('MEDIA_STORE_INVALID', 503, 'The private media object is unavailable.');
    return path;
  }
  private row(state: CommunityState, actor: CommunityActor, uploadId: string, token?: string): UploadRow {
    auth(state, actor, this.now(), true);
    if (!id(uploadId)) fail('NOT_FOUND', 404, 'The requested upload is unavailable.');
    const row = this.database.prepare('SELECT * FROM media_uploads WHERE id=? AND owner_id=? AND team_id=? AND season_id=?').get(uploadId, actor.accountId, actor.teamId, actor.seasonId) as UploadRow | undefined;
    if (!row || (token !== undefined && !sameToken(row.token_hash, token))) fail('NOT_FOUND', 404, 'The requested upload is unavailable.');
    return row;
  }
  prepare(state: CommunityState, actor: CommunityActor, input: MediaPrepareInput): PreparedMediaUpload {
    auth(state, actor, this.now(), true);
    const allowedKeys = ['requestId', 'matchId', 'byteSize', 'mimeType', 'sha256', 'caption', 'policyAcknowledged', 'photoId', 'sourceRevision'];
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !allowedKeys.includes(key)) || !id(input.requestId) || !id(input.matchId) ||
      !Number.isSafeInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > MEDIA_LIMITS.maxBytes ||
      !['image/jpeg', 'image/png'].includes(input.mimeType) || typeof input.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(input.sha256) ||
      typeof input.caption !== 'string' || input.caption.trim().length > 160 || input.policyAcknowledged !== true) {
      fail('INVALID_MEDIA_PREPARATION', 422, 'Use a JPEG or PNG up to 15 MiB with a valid size, SHA-256 and policy acknowledgement. HEIC is not enabled until its decoder is validated.');
    }
    const match = state.matches.find(item => item.id === input.matchId && item.teamId === actor.teamId && item.seasonId === actor.seasonId);
    if (!match) fail('NOT_FOUND', 404, 'The requested match is unavailable.');
    const signature = hash(JSON.stringify([input.matchId, input.byteSize, input.mimeType, input.sha256.toLowerCase(), input.caption.trim(), input.policyAcknowledged, input.photoId ?? null, input.sourceRevision ?? null]));
    const existing = this.database.prepare('SELECT * FROM media_uploads WHERE owner_id=? AND request_id=?').get(actor.accountId, input.requestId) as UploadRow | undefined;
    const token = randomBytes(32).toString('base64url');
    if (existing) {
      if (existing.request_signature !== signature || existing.team_id !== actor.teamId || existing.season_id !== actor.seasonId) fail('IDEMPOTENCY_CONFLICT', 409, 'This upload request identity was already used for different content.');
      if (existing.expires_at <= this.now() && ['prepared', 'uploading'].includes(existing.status)) fail('UPLOAD_EXPIRED', 410, 'The upload window expired. Prepare a new upload without discarding the previous private record.');
      this.database.prepare('UPDATE media_uploads SET token_hash=? WHERE id=?').run(hash(token), existing.id);
      return { uploadId: existing.id, photoId: existing.photo_id, uploadToken: token, expiresAtMs: existing.expires_at, maxBytes: MEDIA_LIMITS.maxBytes, displayRevision: existing.display_revision };
    }
    let sourceRevision: number | null = null;
    let photoId = `media-${randomUUID()}`;
    if (input.photoId !== undefined || input.sourceRevision !== undefined) {
      const photo = state.photos.find(item => item.id === input.photoId && item.matchId === match.id && item.teamId === actor.teamId && item.seasonId === actor.seasonId && item.uploaderAccountId === actor.accountId && item.uploaderRole === actor.role && item.removedAtMs === null);
      if (!photo || !Number.isSafeInteger(input.sourceRevision) || photo.currentRevision !== input.sourceRevision) fail('MEDIA_REVISION_CONFLICT', 409, 'The photo changed. Review its current revision before replacing it.');
      sourceRevision = photo.currentRevision; photoId = photo.id;
    }
    const uploadId = randomUUID();
    const expiresAtMs = this.now() + MEDIA_LIMITS.uploadWindowMs;
    this.database.prepare(`INSERT INTO media_uploads(id,request_id,request_signature,owner_id,team_id,season_id,match_id,photo_id,source_revision,display_revision,status,expected_bytes,expected_sha,declared_mime,caption,token_hash,expires_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,'prepared',?,?,?,?,?,?,?)`).run(uploadId, input.requestId, signature, actor.accountId, actor.teamId, actor.seasonId, match.id, photoId,
      sourceRevision, (sourceRevision ?? 0) + 1, input.byteSize, input.sha256.toLowerCase(), input.mimeType, input.caption.trim(), hash(token), expiresAtMs, this.now());
    return { uploadId, photoId, uploadToken: token, expiresAtMs, maxBytes: MEDIA_LIMITS.maxBytes, displayRevision: (sourceRevision ?? 0) + 1 };
  }
  async upload(state: CommunityState, actor: CommunityActor, uploadId: string, token: string, source: AsyncIterable<Uint8Array>) {
    const row = this.row(state, actor, uploadId, token);
    const duplicate = ['uploaded', 'processed', 'linked'].includes(row.status);
    if (!duplicate && row.expires_at <= this.now()) fail('UPLOAD_EXPIRED', 410, 'The write-only upload window expired.');
    if (!duplicate && row.status !== 'prepared' && !(row.status === 'uploading' && (row.lease_until ?? 0) < this.now())) fail('UPLOAD_BUSY', 409, 'This upload is already running or cannot be changed.');
    const attempt = randomUUID();
    const key = `quarantine/${row.id}-${attempt}.upload`;
    const temporary = this.path(key + '.part');
    if (!duplicate) {
      const updated = this.database.prepare("UPDATE media_uploads SET status='uploading',attempt=?,lease_until=?,failure_code=NULL WHERE id=? AND (status='prepared' OR (status='uploading' AND lease_until<?))").run(attempt, this.now() + 65_000, row.id, this.now());
      if (!updated.changes) fail('UPLOAD_BUSY', 409, 'This upload is already running.');
    }
    const destination = duplicate ? null : await open(temporary, 'wx', 0o600);
    const digest = createHash('sha256');
    let received = 0;
    const began = performance.now();
    const iterator = source[Symbol.asyncIterator]();
    try {
      while (true) {
        const item = await bounded(iterator.next(), MEDIA_LIMITS.uploadTimeoutMs - (performance.now() - began), 'UPLOAD_TIMEOUT');
        if (item.done) break;
        const chunk = Buffer.from(item.value);
        received += chunk.length;
        if (received > row.expected_bytes || received > MEDIA_LIMITS.maxBytes) fail('UPLOAD_TOO_LARGE', 413, 'The image exceeds its declared upload size.');
        digest.update(chunk);
        if (destination) await destination.writeFile(chunk);
      }
      if (received !== row.expected_bytes || digest.digest('hex') !== row.expected_sha) fail('UPLOAD_INTEGRITY_FAILED', 422, 'The uploaded size or SHA-256 does not match. The private partial upload was not accepted.');
      if (destination) {
        await destination.sync(); await destination.close();
        await rename(temporary, this.path(key));
        const changed = this.database.prepare("UPDATE media_uploads SET status='uploaded',original_key=?,lease_until=NULL,failure_code=NULL WHERE id=? AND attempt=? AND status='uploading'").run(key, row.id, attempt);
        if (!changed.changes) fail('UPLOAD_LEASE_CHANGED', 409, 'The upload lease changed. The private branch is retained for review.');
      }
      return { uploadId, status: 'uploaded' as const, byteSize: received };
    } catch (error) {
      if (destination) { await destination.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); }
      if (!duplicate) this.database.prepare("UPDATE media_uploads SET status='prepared',failure_code='UPLOAD_INCOMPLETE',lease_until=NULL WHERE id=? AND attempt=? AND status='uploading'").run(row.id, attempt);
      if (iterator.return) void Promise.resolve(iterator.return()).catch(() => undefined);
      throw error;
    }
  }
  private completion(row: UploadRow) {
    const base = { id: `media-${row.id}-completed`, photoId: row.photo_id, art: 'pitch' as const, caption: row.caption, policyAcknowledged: true as const };
    const command: CommunityCommand = row.source_revision === null
      ? { ...base, type: 'photo.submitted', matchId: row.match_id }
      : { ...base, type: 'photo.revised', sourceRevision: row.source_revision };
    return { command, receipt: { uploadId: row.id, photoId: row.photo_id, status: 'processed' as const, width: row.width!, height: row.height!, displayRevision: row.display_revision } };
  }
  async complete(state: CommunityState, actor: CommunityActor, uploadId: string, token: string) {
    const row = this.row(state, actor, uploadId, token);
    if (row.status === 'processed' || row.status === 'linked') return this.completion(row);
    if (row.status !== 'uploaded' && !(row.status === 'processing' && (row.lease_until ?? 0) < this.now())) fail('UPLOAD_NOT_READY', 409, 'Finish the private upload before completion; an active processing lease cannot be duplicated.');
    if (!row.original_key) fail('UPLOAD_NOT_READY', 409, 'The private original is unavailable.');
    const attempt = randomUUID();
    const leased = this.database.prepare("UPDATE media_uploads SET status='processing',attempt=?,lease_until=?,failure_code=NULL WHERE id=? AND (status='uploaded' OR (status='processing' AND lease_until<?))").run(attempt, this.now() + 60_000, row.id, this.now());
    if (!leased.changes) fail('UPLOAD_BUSY', 409, 'This image is already processing.');
    try {
      const original = await readFile(this.path(row.original_key));
      if (original.length !== row.expected_bytes || hash(original) !== row.expected_sha) fail('UPLOAD_INTEGRITY_FAILED', 422, 'The private original does not match its recorded size and hash.');
      const mimeType = actualMime(original);
      if (!mimeType || mimeType !== row.declared_mime) fail('MEDIA_TYPE_MISMATCH', 415, 'Decoded image type must match its bytes. Only JPEG and PNG are enabled.');
      rejectAnimatedPng(original);
      if (!this.scanner) fail('SCANNER_REQUIRED', 503, 'Image safety scanning is not configured. The original remains private; no reviewable or published image was created.');
      const scan = await bounded(this.scanner.scan(original, { mimeType, sha256: row.expected_sha }), MEDIA_LIMITS.scannerTimeoutMs, 'SCANNER_UNAVAILABLE');
      if (scan.verdict === 'unavailable') fail('SCANNER_UNAVAILABLE', 503, 'Image scanning is unavailable. The original remains private for a safe retry.');
      if (scan.verdict !== 'clean') fail('IMAGE_SCAN_REJECTED', 422, 'The image did not pass safety scanning and remains unpublished.');
      const displayKey = `derivatives/${row.photo_id}-v${row.display_revision}-${attempt}-display.jpg`;
      const thumbnailKey = `derivatives/${row.photo_id}-v${row.display_revision}-${attempt}-thumbnail.jpg`;
      let decoded: { width: number; height: number };
      try {
        const result = await executeFile(process.execPath, ['--max-old-space-size=128', fileURLToPath(new URL('./media-worker.mjs', import.meta.url)),
          this.path(row.original_key), this.path(displayKey), this.path(thumbnailKey), mimeType], { timeout: MEDIA_LIMITS.decodeTimeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true });
        decoded = JSON.parse(result.stdout) as { width: number; height: number };
        if (!Number.isSafeInteger(decoded.width) || !Number.isSafeInteger(decoded.height) || decoded.width < 1 || decoded.height < 1 || decoded.width > MEDIA_LIMITS.displayEdge || decoded.height > MEDIA_LIMITS.displayEdge) throw new Error();
      } catch { fail('IMAGE_DECODE_REJECTED', 415, 'The image could not be safely decoded within the supported format, pixel and processing limits.'); }
      const saved = this.database.prepare("UPDATE media_uploads SET status='processed',display_key=?,thumbnail_key=?,width=?,height=?,scanner_engine=?,failure_code=NULL,lease_until=NULL WHERE id=? AND attempt=? AND status='processing'").run(displayKey, thumbnailKey, decoded.width, decoded.height, scan.engine.slice(0, 100), row.id, attempt);
      if (!saved.changes) fail('PROCESSING_LEASE_CHANGED', 409, 'The processing lease changed. No publication was performed.');
      return this.completion(this.row(state, actor, uploadId));
    } catch (error) {
      const code = error instanceof AccessError ? error.code : 'MEDIA_PROCESSING_FAILED';
      const retryable = ['SCANNER_REQUIRED', 'SCANNER_UNAVAILABLE', 'MEDIA_PROCESSING_FAILED'].includes(code);
      this.database.prepare('UPDATE media_uploads SET status=?,failure_code=?,lease_until=NULL WHERE id=? AND attempt=? AND status=\'processing\'').run(retryable ? 'uploaded' : 'rejected', code, row.id, attempt);
      throw error instanceof AccessError ? error : new AccessError('MEDIA_PROCESSING_FAILED', 503, 'Image processing is unavailable. No image was published.');
    }
  }
  /** Call in the same SQLite transaction as applying and saving completion.command. */
  link(uploadId: string, state?: CommunityState): void {
    const row = this.database.prepare('SELECT * FROM media_uploads WHERE id=?').get(uploadId) as UploadRow | undefined;
    if (!row || !['processed', 'linked'].includes(row.status)) fail('MEDIA_NOT_PROCESSED', 409, 'The image has not completed private processing.');
    if (state && !state.photos.some(photo => photo.id === row.photo_id && photo.teamId === row.team_id && photo.seasonId === row.season_id &&
      photo.uploaderAccountId === row.owner_id && photo.revisions.some(revision => revision.version === row.display_revision))) fail('MEDIA_LINK_CONFLICT', 409, 'The matching community revision was not committed.');
    this.database.prepare("UPDATE media_uploads SET status='linked' WHERE id=?").run(uploadId);
  }
  gateway(state: CommunityState, actor: CommunityActor, photoId: string, variant: 'display' | 'thumbnail', mode: 'gallery' | 'own' | 'review' = 'gallery', revision?: number) {
    if (!['display', 'thumbnail'].includes(variant)) fail('NOT_FOUND', 404, 'The media variant is unavailable.');
    const decision = authorizeCommunityMedia(state, actor, photoId, this.now(), mode, revision);
    if (!decision.allowed) fail('NOT_FOUND', 404, 'The requested image is unavailable.');
    const row = this.database.prepare("SELECT * FROM media_uploads WHERE photo_id=? AND display_revision=? AND status='linked'").get(photoId, decision.revision.version) as UploadRow | undefined;
    if (!row || row.team_id !== actor.teamId || row.season_id !== actor.seasonId) fail('NOT_FOUND', 404, 'The requested image is unavailable.');
    const key = variant === 'display' ? row.display_key : row.thumbnail_key;
    if (!key) fail('NOT_FOUND', 404, 'The requested image is unavailable.');
    let body: Buffer;
    try { body = readFileSync(this.path(key)); } catch { fail('NOT_FOUND', 404, 'The requested image is unavailable.'); }
    return { body, headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': String(body.length) } };
  }
  listOwn(state: CommunityState, actor: CommunityActor) {
    auth(state, actor, this.now(), true);
    const rows = this.database.prepare('SELECT id,photo_id,status,expected_bytes,display_revision,width,height,failure_code,expires_at FROM media_uploads WHERE owner_id=? AND team_id=? AND season_id=? ORDER BY created_at DESC LIMIT 100').all(actor.accountId, actor.teamId, actor.seasonId) as unknown as Pick<UploadRow, 'id' | 'photo_id' | 'status' | 'expected_bytes' | 'display_revision' | 'width' | 'height' | 'failure_code' | 'expires_at'>[];
    return rows.map(row => ({ uploadId: row.id, photoId: row.photo_id, status: row.status, byteSize: row.expected_bytes, displayRevision: row.display_revision,
      width: row.width, height: row.height, failureCode: row.failure_code, expiresAtMs: row.expires_at }));
  }
}
