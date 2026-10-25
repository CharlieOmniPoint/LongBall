import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createConnection } from 'node:net';
import test from 'node:test';
import { demoArtwork } from '../infra/cloud-preview/seed-demo-media.mjs';
import { startPersonaMediaFixture } from './persona-media-fixture.mjs';

function exchange(fixture, bytes) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: fixture.env.LONGBALL_CLAMD_HOST, port: Number(fixture.env.LONGBALL_CLAMD_PORT) });
    let response = Buffer.alloc(0), done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Bounded fixture response did not arrive.')), 3000);
    socket.on('error', error => finish(error));
    socket.once('connect', () => socket.write(bytes));
    socket.on('data', chunk => {
      response = Buffer.concat([response, chunk]);
      if (response.length > 8192) return finish(new Error('Unexpected oversized fixture response.'));
      const end = response.indexOf(0);
      if (end >= 0) finish(null, response.subarray(0, end).toString('utf8'));
    });
  });
}
function stream(bytes) {
  const midpoint = Math.floor(bytes.length / 2);
  const frames = [Buffer.from('zINSTREAM\0')];
  for (const chunk of [bytes.subarray(0, midpoint), bytes.subarray(midpoint)]) {
    const size = Buffer.alloc(4); size.writeUInt32BE(chunk.length); frames.push(size, chunk);
  }
  frames.push(Buffer.alloc(4)); return Buffer.concat(frames);
}

test('UI scanner fixture accepts only exact generated artwork, including framed chunks', async () => {
  const fixture = await startPersonaMediaFixture();
  try {
    assert.equal(fixture.boundary.antivirusProof, false);
    assert.match(await exchange(fixture, Buffer.from('zVERSION\0')), /persona-ui-fixture/);
    for (const kind of ['pitch', 'cones', 'ball']) assert.equal(await exchange(fixture, stream(demoArtwork(kind))), 'stream: OK');
    const changed = Buffer.from(demoArtwork('pitch')); changed[changed.length - 1] ^= 1;
    assert.match(await exchange(fixture, stream(changed)), /FOUND$/);
    assert.match(await exchange(fixture, stream(Buffer.from('any other image bytes'))), /FOUND$/);
  } finally { await fixture.close(); }
});

test('UI scanner fixture rejects oversized framing, empty streams and unknown commands', async () => {
  const fixture = await startPersonaMediaFixture();
  try {
    const size = Buffer.alloc(4); size.writeUInt32BE(fixture.boundary.maxBytes + 1);
    assert.match(await exchange(fixture, Buffer.concat([Buffer.from('zINSTREAM\0'), size])), /ERROR$/);
    assert.match(await exchange(fixture, Buffer.concat([Buffer.from('zINSTREAM\0'), Buffer.alloc(4)])), /ERROR$/);
    assert.match(await exchange(fixture, Buffer.from('zUNKNOWN\0')), /ERROR$/);
    assert.match(await exchange(fixture, Buffer.from('zVERSION\0extra')), /ERROR$/);
  } finally { await fixture.close(); }
});

test('media seeding refuses external destinations and missing verified session tokens before HTTP', async () => {
  const fixture = await startPersonaMediaFixture();
  try {
    await assert.rejects(fixture.seed('https://example.invalid/'), /owned loopback/);
    await assert.rejects(fixture.seed('http://127.0.0.1:1/'), /actual verified generated/);
  } finally { await fixture.close(); }
});
