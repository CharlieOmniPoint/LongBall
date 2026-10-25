import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { demoArtwork, seedDemoMedia } from '../infra/cloud-preview/seed-demo-media.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/**
 * Controlled UI fixture, never an antivirus engine. The clamd wire response is
 * simulated for three exact, original, people-free images and rejects every
 * other input. Production scanner configuration and verdicts are untouched.
 */
export async function startPersonaMediaFixture() {
  const examples = ['pitch', 'cones', 'ball'].map(kind => demoArtwork(kind));
  const allowed = new Set(examples.map(sha256));
  const maxBytes = Math.max(...examples.map(bytes => bytes.length));
  const sockets = new Set();
  const counts = { accepted: 0, rejected: 0, malformed: 0 };
  const boundary = {
    kind: 'exact-generated-artwork-clamd-wire-ui-fixture',
    antivirusProof: false,
    allowedImageKinds: ['pitch', 'cones', 'ball'],
    acceptedImageCount: allowed.size,
    maxBytes,
    description: 'Only the exact demoArtwork PNG hashes receive a controlled clean response. All other bytes are rejected. Actual HTTP upload, decoding, authorization and moderation run in the application; malware detection and real antivirus database acceptance are not established.',
  };
  let closed = false;
  const server = createServer(socket => {
    if (closed || sockets.size >= 8) return socket.destroy();
    sockets.add(socket);
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0), command = null, bytesSeen = 0, frames = 0, ended = false;
    const hash = createHash('sha256');
    const finish = message => {
      if (ended) return;
      ended = true;
      socket.end(`${message}\0`);
    };
    const malformed = () => { counts.malformed++; finish('INSTREAM malformed UI fixture request. ERROR'); };
    socket.on('data', chunk => {
      if (ended) return;
      if (pending.length + chunk.length > maxBytes + 4 * 32 + 32) return malformed();
      pending = Buffer.concat([pending, chunk]);
      if (!command) {
        const end = pending.indexOf(0);
        if (end < 0) {
          if (pending.length > 16) malformed();
          return;
        }
        command = pending.subarray(0, end).toString('utf8');
        pending = pending.subarray(end + 1);
        if (command === 'zVERSION') {
          if (pending.length) return malformed();
          return finish(`ClamAV 0.0.0-persona-ui-fixture/1/${new Date().toUTCString()}`);
        }
        if (command !== 'zINSTREAM') return malformed();
      }
      while (pending.length >= 4) {
        const length = pending.readUInt32BE(0);
        if (length > 64 * 1024 || bytesSeen + length > maxBytes || frames >= 32) return malformed();
        if (pending.length < length + 4) return;
        pending = pending.subarray(4);
        frames++;
        if (length === 0) {
          if (pending.length || bytesSeen === 0) return malformed();
          const accepted = allowed.has(hash.digest('hex'));
          counts[accepted ? 'accepted' : 'rejected']++;
          return finish(accepted ? 'stream: OK' : 'stream: PersonaExactArtworkOnly FOUND');
        }
        hash.update(pending.subarray(0, length));
        pending = pending.subarray(length);
        bytesSeen += length;
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    env: { LONGBALL_CLAMD_HOST: '127.0.0.1', LONGBALL_CLAMD_PORT: String(address.port) },
    boundary,
    async seed(baseURL, { accessTokens } = {}) {
      const base = new URL(baseURL);
      assert(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) && base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash, 'Use only the owned loopback persona API.');
      assert(accessTokens && ['manager', 'player'].every(role => typeof accessTokens[role] === 'string' && /^demo_[A-Za-z0-9_-]{43}$/.test(accessTokens[role])), 'Use actual verified generated Manager and Player demo sessions for media setup.');
      const tokens = new Map([
        ['Bearer synthetic-account-manager', accessTokens.manager],
        ['Bearer synthetic-account-player-01', accessTokens.player],
      ]);
      const result = await seedDemoMedia(base.href, { fetch: async (input, options) => {
        const url = new URL(input);
        assert(url.origin === base.origin && (url.pathname === '/health' || url.pathname.startsWith('/v1/teams/synthetic-roma-u10/')), 'Fixture seeding cannot forward to another origin or arbitrary account route.');
        const headers = new Headers(options.headers), token = tokens.get(headers.get('Authorization'));
        assert(token, 'Only the two known artwork bootstrap identities are mapped.');
        headers.set('Authorization', `Bearer ${token}`);
        return fetch(url, { ...options, headers, redirect: 'error' });
      } });
      return { ...result, boundary, fixtureScans: { ...counts } };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
