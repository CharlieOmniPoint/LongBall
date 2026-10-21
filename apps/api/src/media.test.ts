import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { applyCommunityCommand, createCommunityState, syntheticCommunityActors, type CommunityActor } from '../../../packages/application/src/community';
import { createClamAvScanner, DevelopmentMediaService, MEDIA_LIMITS, type MediaPrepareInput, type MediaScanner } from './media';

const at = Date.parse('2026-10-21T10:00:00Z');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function png(color = '#176B45') {
  return sharp({ create: { width: 64, height: 32, channels: 3, background: color } }).png().toBuffer();
}
async function* chunks(bytes: Buffer) {
  yield bytes.subarray(0, Math.min(20, bytes.length));
  yield bytes.subarray(Math.min(20, bytes.length));
}
async function lab(bytes: Buffer, scanner: MediaScanner | null = null, useFixtureScanner = true) {
  const directory = await mkdtemp(join(tmpdir(), 'longball-media-'));
  const allowedFixtures = new Set([digest(bytes)]);
  // Deliberately limited test fixture allowlist, not a pretend antivirus service.
  const fixtureScanner: MediaScanner = { scan: async input => ({ verdict: allowedFixtures.has(digest(input)) ? 'clean' : 'rejected', engine: 'known-fictional-fixture-test-only' }) };
  let clock = at;
  let state = createCommunityState(clock);
  let service = new DevelopmentMediaService({ directory, now: () => clock, scanner: scanner ?? (useFixtureScanner ? fixtureScanner : undefined) });
  const actors = syntheticCommunityActors(state);
  cleanups.push(async () => { service.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    actors, directory, allowedFixtures,
    get service() { return service; },
    get state() { return state; },
    setClock(value: number) { clock = value; },
    apply(actor: CommunityActor, command: Parameters<typeof applyCommunityCommand>[2]) { state = applyCommunityCommand(state, actor, command, clock); },
    reopen() { service.close(); service = new DevelopmentMediaService({ directory, now: () => clock, scanner: scanner ?? (useFixtureScanner ? fixtureScanner : undefined) }); },
    input(inputBytes = bytes, extra: Partial<MediaPrepareInput> = {}): MediaPrepareInput {
      return { requestId: randomUUID(), matchId: state.matches[0].id, byteSize: inputBytes.length, mimeType: 'image/png',
        sha256: digest(inputBytes), caption: 'Fictional test image, no people', policyAcknowledged: true, ...extra };
    },
    async prepareUpload(actor = actors.manager, inputBytes = bytes, extra: Partial<MediaPrepareInput> = {}) {
      const prepared = service.prepare(state, actor, this.input(inputBytes, extra));
      await service.upload(state, actor, prepared.uploadId, prepared.uploadToken, chunks(inputBytes));
      return prepared;
    },
    async complete(prepared: Awaited<ReturnType<DevelopmentMediaService['prepare']>>, actor = actors.manager) {
      const processed = await service.complete(state, actor, prepared.uploadId, prepared.uploadToken);
      state = applyCommunityCommand(state, actor, processed.command, clock);
      service.link(prepared.uploadId, state);
      return processed;
    },
  };
}

describe('private image ingestion', () => {
  it('decodes/re-encodes a fictional PNG and requires explicit manager Publish before gateway retrieval', async () => {
    const review = await lab(await png());
    const prepared = await review.prepareUpload();
    const result = await review.complete(prepared);
    expect(result.receipt).toMatchObject({ status: 'processed', width: 64, height: 32, displayRevision: 1 });
    expect(() => review.service.gateway(review.state, review.actors.spectator, prepared.photoId, 'display')).toThrow(/unavailable/);
    const own = review.service.gateway(review.state, review.actors.manager, prepared.photoId, 'display', 'own');
    expect((await sharp(own.body).metadata()).format).toBe('jpeg');
    expect(own.headers).toMatchObject({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'image/jpeg' });
    review.apply(review.actors.manager, { id: randomUUID(), type: 'photo.published', photoId: prepared.photoId, sourceRevision: 1, policyAcknowledged: true });
    expect(review.service.gateway(review.state, review.actors.spectator, prepared.photoId, 'thumbnail').body.length).toBeGreaterThan(0);
    expect(statSync(review.directory).mode & 0o777).toBe(0o700);
  });

  it('preserves orientation while stripping EXIF, ICC and other metadata from both derivatives', async () => {
    const bytes = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#DDCC66' } })
      .withMetadata({ orientation: 6 }).withExif({ IFD0: { Artist: 'FICTIONAL_FIXTURE_ONLY' } }).jpeg().toBuffer();
    expect((await sharp(bytes).metadata()).orientation).toBe(6);
    const review = await lab(bytes);
    const prepared = await review.prepareUpload(review.actors.manager, bytes, { mimeType: 'image/jpeg' });
    const result = await review.complete(prepared);
    expect(result.receipt).toMatchObject({ width: 32, height: 64 });
    for (const variant of ['display', 'thumbnail'] as const) {
      const body = review.service.gateway(review.state, review.actors.manager, prepared.photoId, variant, 'own').body;
      const metadata = await sharp(body).metadata();
      expect(metadata.exif).toBeUndefined(); expect(metadata.icc).toBeUndefined(); expect(metadata.xmp).toBeUndefined(); expect(metadata.orientation).toBeUndefined();
      expect(body.includes(Buffer.from('FICTIONAL_FIXTURE_ONLY'))).toBe(false);
    }
  });

  it('keeps all bytes private when a real scanner is not configured', async () => {
    const review = await lab(await png(), null, false);
    const prepared = await review.prepareUpload(review.actors.player);
    await expect(review.service.complete(review.state, review.actors.player, prepared.uploadId, prepared.uploadToken)).rejects.toMatchObject({ code: 'SCANNER_REQUIRED', status: 503 });
    expect(review.state.photos.some(photo => photo.id === prepared.photoId)).toBe(false);
    expect(review.service.listOwn(review.state, review.actors.player)[0]).toMatchObject({ status: 'uploaded', failureCode: 'SCANNER_REQUIRED' });
    expect(() => review.service.gateway(review.state, review.actors.manager, prepared.photoId, 'display', 'review')).toThrow();
  });

  it('fails closed on scanner rejection and unavailable verdicts', async () => {
    for (const verdict of ['rejected', 'unavailable'] as const) {
      const review = await lab(await png(), { scan: async () => ({ verdict, engine: 'test-verdict-only' }) });
      const prepared = await review.prepareUpload();
      await expect(review.service.complete(review.state, review.actors.manager, prepared.uploadId, prepared.uploadToken)).rejects.toMatchObject({ code: verdict === 'rejected' ? 'IMAGE_SCAN_REJECTED' : 'SCANNER_UNAVAILABLE' });
      expect(review.state.photos).toHaveLength(2);
    }
  });

  it('rejects spoofed SVG/HTML/GIF bytes before the decoder and rejects unsupported HEIC preparation', async () => {
    const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.invalid/private"/></svg>');
    const review = await lab(bytes);
    const prepared = await review.prepareUpload();
    await expect(review.service.complete(review.state, review.actors.manager, prepared.uploadId, prepared.uploadToken)).rejects.toMatchObject({ code: 'MEDIA_TYPE_MISMATCH', status: 415 });
    expect(() => review.service.prepare(review.state, review.actors.manager, review.input(bytes, { mimeType: 'image/heic' }))).toThrow(/HEIC is not enabled/);
  });

  it('rejects animated PNG and invalid/oversized dimensions while keeping no community publication', async () => {
    const original = await png();
    const animationChunk = Buffer.alloc(12); animationChunk.write('acTL', 4, 'ascii');
    const animated = Buffer.concat([original.subarray(0, 33), animationChunk, original.subarray(33)]);
    const review = await lab(animated);
    const prepared = await review.prepareUpload();
    await expect(review.service.complete(review.state, review.actors.manager, prepared.uploadId, prepared.uploadToken)).rejects.toMatchObject({ code: 'ANIMATED_IMAGE_UNSUPPORTED' });
    const maliciousHeader = Buffer.from(original); maliciousHeader.writeUInt32BE(50_000, 16); maliciousHeader.writeUInt32BE(50_000, 20);
    const other = await lab(maliciousHeader);
    const otherPrepared = await other.prepareUpload();
    await expect(other.service.complete(other.state, other.actors.manager, otherPrepared.uploadId, otherPrepared.uploadToken)).rejects.toMatchObject({ code: 'IMAGE_DECODE_REJECTED' });
    expect(other.state.photos).toHaveLength(2);
  });

  it('checks declared size and SHA, bounds the stream and permits a safe same-upload retry', async () => {
    const bytes = await png(); const review = await lab(bytes);
    expect(() => review.service.prepare(review.state, review.actors.manager, review.input(bytes, { byteSize: MEDIA_LIMITS.maxBytes + 1 }))).toThrow(/15 MiB/);
    const prepared = review.service.prepare(review.state, review.actors.manager, review.input());
    await expect(review.service.upload(review.state, review.actors.manager, prepared.uploadId, prepared.uploadToken, chunks(Buffer.concat([bytes, Buffer.from('excess')])))).rejects.toMatchObject({ code: 'UPLOAD_TOO_LARGE', status: 413 });
    const wrong = Buffer.from(bytes); wrong[wrong.length - 1] ^= 1;
    await expect(review.service.upload(review.state, review.actors.manager, prepared.uploadId, prepared.uploadToken, chunks(wrong))).rejects.toMatchObject({ code: 'UPLOAD_INTEGRITY_FAILED' });
    expect((await review.service.upload(review.state, review.actors.manager, prepared.uploadId, prepared.uploadToken, chunks(bytes))).status).toBe('uploaded');
    expect((await review.service.upload(review.state, review.actors.manager, prepared.uploadId, prepared.uploadToken, chunks(bytes))).byteSize).toBe(bytes.length);
  });

  it('persists private manifests across restart and retries completion with the same command identity', async () => {
    const review = await lab(await png());
    const prepared = await review.prepareUpload();
    review.reopen();
    const first = await review.complete(prepared);
    review.reopen();
    const second = await review.service.complete(review.state, review.actors.manager, prepared.uploadId, prepared.uploadToken);
    expect(second.command).toEqual(first.command);
    const duplicate = applyCommunityCommand(review.state, review.actors.manager, second.command, at + 1000);
    expect(duplicate).toBe(review.state);
    expect(review.service.listOwn(review.state, review.actors.manager)[0]).toMatchObject({ status: 'linked' });
    expect(JSON.stringify(review.service.listOwn(review.state, review.actors.manager))).not.toContain(prepared.uploadToken);
    expect(JSON.stringify(review.service.listOwn(review.state, review.actors.manager))).not.toContain('quarantine');
  });

  it('rotates only the write capability on an idempotent prepare without extending the deadline', async () => {
    const review = await lab(await png()); const input = review.input();
    const first = review.service.prepare(review.state, review.actors.manager, input);
    review.setClock(at + 1000);
    const second = review.service.prepare(review.state, review.actors.manager, { ...input });
    expect(second.uploadId).toBe(first.uploadId); expect(second.expiresAtMs).toBe(first.expiresAtMs); expect(second.uploadToken).not.toBe(first.uploadToken);
    await expect(review.service.upload(review.state, review.actors.manager, first.uploadId, first.uploadToken, chunks(await png()))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(() => review.service.prepare(review.state, review.actors.manager, { ...input, caption: 'different' })).toThrow(/different content/);
    review.setClock(first.expiresAtMs);
    await expect(review.service.upload(review.state, review.actors.manager, second.uploadId, second.uploadToken, chunks(await png()))).rejects.toMatchObject({ code: 'UPLOAD_EXPIRED' });
  });

  it('enforces owner, role, team and season before upload or status disclosure', async () => {
    const review = await lab(await png()); const prepared = await review.prepareUpload(review.actors.player);
    await expect(review.service.complete(review.state, review.actors.secondPlayer, prepared.uploadId, prepared.uploadToken)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(() => review.service.prepare(review.state, review.actors.spectator, review.input())).toThrow(/unavailable/);
    expect(() => review.service.listOwn(review.state, { ...review.actors.manager, teamId: 'other-team' })).toThrow(/unavailable/);
    expect(review.service.listOwn(review.state, review.actors.secondPlayer)).toEqual([]);
  });
});

describe('current authenticated image gateway', () => {
  it('uses the same strict permission decision for thumbnails/full images, exact revisions and removal', async () => {
    const review = await lab(await png()); const prepared = await review.prepareUpload(review.actors.player);
    await review.complete(prepared, review.actors.player);
    for (const variant of ['display', 'thumbnail'] as const) {
      expect(() => review.service.gateway(review.state, review.actors.secondPlayer, prepared.photoId, variant)).toThrow();
      expect(review.service.gateway(review.state, review.actors.player, prepared.photoId, variant, 'own').body.length).toBeGreaterThan(0);
      expect(review.service.gateway(review.state, review.actors.manager, prepared.photoId, variant, 'review').body.length).toBeGreaterThan(0);
    }
    review.apply(review.actors.manager, { id: randomUUID(), type: 'photo.reviewed', photoId: prepared.photoId, sourceRevision: 1, decision: 'approve' });
    expect(review.service.gateway(review.state, review.actors.spectator, prepared.photoId, 'display').body.length).toBeGreaterThan(0);
    review.apply(review.actors.manager, { id: randomUUID(), type: 'photo.removed', photoId: prepared.photoId });
    for (const variant of ['display', 'thumbnail'] as const) expect(() => review.service.gateway(review.state, review.actors.spectator, prepared.photoId, variant)).toThrow();
  });

  it('keeps the old approved binary during replacement and denies stale URLs after new approval', async () => {
    const bytes = await png(); const replacement = await png('#CC7722');
    const review = await lab(bytes); review.allowedFixtures.add(digest(replacement));
    const first = await review.prepareUpload(review.actors.player); await review.complete(first, review.actors.player);
    review.apply(review.actors.manager, { id: randomUUID(), type: 'photo.reviewed', photoId: first.photoId, sourceRevision: 1, decision: 'approve' });
    const oldBody = review.service.gateway(review.state, review.actors.spectator, first.photoId, 'display').body;
    const next = await review.prepareUpload(review.actors.player, replacement, { photoId: first.photoId, sourceRevision: 1 }); await review.complete(next, review.actors.player);
    expect(review.service.gateway(review.state, review.actors.spectator, first.photoId, 'display').body).toEqual(oldBody);
    expect(() => review.service.gateway(review.state, review.actors.spectator, first.photoId, 'display', 'gallery', 2)).toThrow();
    review.apply(review.actors.manager, { id: randomUUID(), type: 'photo.reviewed', photoId: first.photoId, sourceRevision: 2, decision: 'approve' });
    expect(review.service.gateway(review.state, review.actors.spectator, first.photoId, 'display').body).not.toEqual(oldBody);
    expect(() => review.service.gateway(review.state, review.actors.spectator, first.photoId, 'display', 'gallery', 1)).toThrow();
  });

  it('checks policy, hidden uploaders and grant revocation on every binary request', async () => {
    const review = await lab(await png()); const prepared = await review.prepareUpload(); await review.complete(prepared);
    review.apply(review.actors.manager, { id: randomUUID(), type: 'photo.published', photoId: prepared.photoId, sourceRevision: 1, policyAcknowledged: true });
    review.apply(review.actors.spectator, { id: randomUUID(), type: 'uploader.hidden', uploaderAccountId: review.actors.manager.accountId, hidden: true });
    expect(() => review.service.gateway(review.state, review.actors.spectator, prepared.photoId, 'thumbnail')).toThrow();
    review.apply(review.actors.spectator, { id: randomUUID(), type: 'uploader.hidden', uploaderAccountId: review.actors.manager.accountId, hidden: false });
    review.state.matches[0].sharing = 'manager_only';
    expect(() => review.service.gateway(review.state, review.actors.spectator, prepared.photoId, 'display')).toThrow();
    review.state.matches[0].sharing = 'fictional_review_only';
    review.apply(review.actors.manager, { id: randomUUID(), type: 'grant.revoked', grantId: 'synthetic-demo-grant' });
    expect(() => review.service.gateway(review.state, review.actors.spectator, prepared.photoId, 'display')).toThrow();
    expect(review.service.gateway(review.state, review.actors.manager, prepared.photoId, 'display').body.length).toBeGreaterThan(0);
  });
});

describe('ClamAV executable adapter contract', () => {
  it('maps controlled process exits and timeout safely; this does not validate a live ClamAV database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'longball-scanner-contract-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    for (const [exitCode, verdict] of [[0, 'clean'], [1, 'rejected'], [2, 'unavailable']] as const) {
      const executable = join(directory, `scanner-exit-${exitCode}`);
      await writeFile(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'ClamAV 1.0.0-test'; exit 0; fi\ncat >/dev/null\necho 'stdin: OK'\nexit ${exitCode}\n`, { mode: 0o700 });
      expect((await createClamAvScanner(executable).scan(Buffer.from('fictional fixture'), { mimeType: 'image/png', sha256: 'unused' })).verdict).toBe(verdict);
    }
    const absent = createClamAvScanner(join(directory, 'not-installed'));
    expect((await absent.scan(Buffer.from('fictional fixture'), { mimeType: 'image/png', sha256: 'unused' })).verdict).toBe('unavailable');
  });

  it('does not mistake an arbitrary successful executable for a configured scanner', async () => {
    const executable = process.platform === 'win32' ? 'C:\\not-a-scanner.exe' : '/bin/true';
    expect((await createClamAvScanner(executable).scan(Buffer.from('fictional fixture'), { mimeType: 'image/png', sha256: 'unused' })).verdict).toBe('unavailable');
  });
});
