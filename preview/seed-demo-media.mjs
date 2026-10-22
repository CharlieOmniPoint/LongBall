/** Seed original, people-free demo artwork through the normal authenticated scanner/processing/moderation pipeline. */
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const team = '/v1/teams/synthetic-roma-u10';
const seasonId = 'synthetic-season-2026-27';
const matchId = 'synthetic-history-hill';
const contract = 'longball.events/1.1';
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function chunk(type, bytes) {
  const name = Buffer.from(type), value = Buffer.concat([name, bytes]);
  let crc = 0xffffffff;
  for (const byte of value) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, value, checksum]);
}
export function demoArtwork(kind) {
  const width = 960, height = 600, stride = width * 3 + 1;
  const raster = Buffer.alloc(height * stride);
  const point = (x, y, color) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = Math.floor(y) * stride + Math.floor(x) * 3 + 1;
    raster[offset] = color[0]; raster[offset + 1] = color[1]; raster[offset + 2] = color[2];
  };
  const rect = (x, y, w, h, color) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) point(xx, yy, color); };
  const circle = (cx, cy, radius, color, thickness = null) => {
    for (let y = cy - radius; y <= cy + radius; y++) for (let x = cx - radius; x <= cx + radius; x++) {
      const distance = (x - cx) ** 2 + (y - cy) ** 2;
      if (distance <= radius ** 2 && (thickness === null || distance >= (radius - thickness) ** 2)) point(x, y, color);
    }
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) point(x, y, [28, 112 + (Math.floor(x / 120) % 2) * 12, 71]);
  const white = [243, 249, 243];
  if (kind === 'pitch') {
    rect(55, 45, 850, 4, white); rect(55, 550, 850, 4, white); rect(55, 45, 4, 509, white); rect(901, 45, 4, 509, white);
    rect(478, 45, 4, 509, white); circle(480, 300, 85, white, 4); circle(480, 300, 6, white);
    for (const x of [55, 765]) { rect(x, 175, 140, 4, white); rect(x, 425, 140, 4, white); rect(x === 55 ? 191 : 765, 175, 4, 254, white); }
    circle(700, 400, 21, white); circle(700, 400, 8, [27, 42, 36]);
  } else if (kind === 'cones') {
    rect(0, 500, width, 5, white);
    for (const cx of [160, 370, 580, 790]) {
      for (let y = 260; y < 440; y++) {
        const half = Math.round((y - 260) * 0.3);
        rect(cx - half, y, half * 2 + 1, 1, y > 340 && y < 370 ? white : [244, 132, 49]);
      }
      rect(cx - 70, 440, 140, 12, [239, 124, 39]);
    }
  } else {
    circle(480, 300, 175, white); circle(480, 300, 54, [30, 45, 38]);
    for (const [x, y] of [[390, 190], [590, 195], [355, 360], [605, 365], [480, 443]]) circle(x, y, 30, [30, 45, 38]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raster)), chunk('IEND', Buffer.alloc(0))]);
}

export async function seedDemoMedia(baseURL) {
  const base = new URL(baseURL);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Demo media bootstrap requires an explicit loopback API.');
  const request = async (route, { account = 'synthetic-account-manager', role = 'manager', method = 'GET', body, token, key } = {}) => {
    const response = await fetch(new URL(route, base), { method, headers: {
      Authorization: `Bearer ${account}`, 'X-Longball-Role': role,
      ...(method !== 'GET' ? { 'X-Api-Contract-Version': contract, 'Idempotency-Key': key, 'Content-Type': body instanceof Uint8Array ? 'image/png' : 'application/json' } : {}),
      ...(token ? { 'X-Media-Upload-Token': token } : {}),
    }, ...(body !== undefined ? { body: body instanceof Uint8Array ? body : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(35_000) });
    if (!response.ok) throw new Error(`Demo media bootstrap failed at ${route.split('?')[0]}: HTTP ${response.status}.`);
    return response.json();
  };
  const health = await request('/health');
  if (health.syntheticOnly !== true || health.demoScenario !== true) throw new Error('Demo media bootstrap is available only in the explicit generated-demo scenario.');
  const examples = [
    { id: 'pitch', kind: 'pitch', account: 'synthetic-account-manager', role: 'manager', caption: 'Saturday at Rovers Sports Ground · sample illustration', publish: true },
    { id: 'cones', kind: 'cones', account: 'synthetic-account-manager', role: 'manager', caption: 'Ready for the next training session · sample illustration', publish: true },
    { id: 'ball', kind: 'ball', account: 'synthetic-account-player-01', role: 'player', caption: 'Oliver’s matchday football · sample illustration', publish: false },
  ];
  let processed = 0;
  for (const example of examples) {
    const connection = { account: example.account, role: example.role };
    const current = await request(`${team}/community?seasonId=${seasonId}`, connection);
    if ([...current.gallery, ...current.submissions].some((photo) => photo.caption === example.caption)) continue;
    const bytes = demoArtwork(example.kind), key = `demo-media-${example.id}-v1`;
    const prepared = await request(`${team}/media/uploads/prepare?seasonId=${seasonId}`, { ...connection, method: 'POST', key, body: {
      matchId, byteSize: bytes.length, mimeType: 'image/png', sha256: createHash('sha256').update(bytes).digest('hex'), caption: example.caption, policyAcknowledged: true,
    } });
    await request(`${team}/media/uploads/${prepared.uploadId}?seasonId=${seasonId}`, { ...connection, method: 'PUT', key: `${key}-upload`, token: prepared.uploadToken, body: bytes });
    const receipt = await request(`${team}/media/uploads/${prepared.uploadId}/complete?seasonId=${seasonId}`, { ...connection, method: 'POST', key: `${key}-complete`, token: prepared.uploadToken, body: {} });
    if (receipt.status !== 'processed') throw new Error('Demo artwork did not finish private scanning and processing.');
    if (example.publish) await request(`${team}/community?seasonId=${seasonId}`, { ...connection, method: 'POST', key: `${key}-publish`, body: { command: { id: `${key}-publish`, type: 'photo.published', photoId: prepared.photoId, sourceRevision: receipt.displayRevision, policyAcknowledged: true } } });
    processed++;
  }
  return { processed, publishedExamples: 2, pendingPlayerExamples: 1, throughNormalMediaPipeline: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await seedDemoMedia(process.argv[2] ?? 'http://127.0.0.1:4173')));
}
