import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createApi } from './server';
import { EVENT_CONTRACT_VERSION, SYNTHETIC_IDS } from './store';
import type { MatchConfig } from '../../../packages/domain/src/index';

const close: (() => Promise<void>)[] = [];
afterEach(async () => { for (const work of close.splice(0).reverse()) await work(); });
async function start() {
  const directory = mkdtempSync(join(tmpdir(), 'longball-fastify-'));
  close.push(async () => rmSync(directory, { recursive: true, force: true }));
  const site = join(directory, 'site'); mkdirSync(site); writeFileSync(join(site, 'index.html'), '<title>LongBall transport</title>');
  const api = createApi({ databasePath: join(directory, 'api.sqlite'), syntheticAuth: true, staticDirectory: site });
  const observed = { requests: 0, validated: 0, responses: 0, closed: false, parsedBody: null as unknown };
  api.framework.addHook('onRequest', async () => { observed.requests++; });
  api.framework.addHook('preValidation', async request => { observed.validated++; observed.parsedBody = request.body; });
  api.framework.addHook('onResponse', async () => { observed.responses++; });
  api.framework.addHook('onClose', async () => { observed.closed = true; });
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve));
  close.push(async () => { api.server.closeAllConnections(); await api.close(); });
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const headers = { Authorization: 'Bearer synthetic-manager-1', 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), 'X-Api-Contract-Version': EVENT_CONTRACT_VERSION };
  return { api, observed, base, headers };
}
describe('Fastify5 transport lifecycle and security', () => {
  it('boots before native server requests and traverses Fastify hooks, secure parsing and shutdown', async () => {
    const client = await start(); expect(client.api.framework.version).toBe('5.12.7');
    expect(client.api.server.requestTimeout).toBe(65_000); expect(client.api.server.headersTimeout).toBe(10_000);
    const response = await fetch(client.base + '/v1/identity/devices', { method: 'POST', headers: { ...client.headers, 'X-Request-Id': 'framework-journey-1' }, body: JSON.stringify({ deviceId: 'framework-device-1', platform: 'android' }) });
    expect(response.status).toBe(200); expect(response.headers.get('X-Request-Id')).toBe('framework-journey-1'); await response.json();
    expect(client.observed).toMatchObject({ requests: 1, validated: 1, responses: 1, parsedBody: { deviceId: 'framework-device-1', platform: 'android' } });
    await client.api.framework.close(); expect(client.observed.closed).toBe(true); expect(client.api.server.listening).toBe(false);
  });
  it.each(['{broken', '[]', 'null', '"object required"', '{"nested":{"__proto__":{"polluted":true}}}', '{"nested":{"constructor":{"prototype":{"polluted":true}}}}'])('rejects malformed, nonobject and poisoning JSON before canonical dispatch: %s', async body => {
    const client = await start(), response = await fetch(client.base + '/v1/identity/devices', { method: 'POST', headers: { ...client.headers, Origin: 'http://localhost:4173', 'X-Request-Id': 'parser-rejection' }, body });
    expect(response.status).toBe(400); expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:4173');
    expect(await response.json()).toMatchObject({ code: 'INVALID_JSON', requestId: 'parser-rejection', retryable: false });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(client.api.store.database.prepare('SELECT * FROM native_app_devices').all()).toHaveLength(0);
  });
  it('enforces byte limits on declared and chunked JSON before dispatch without breaking subsequent requests', async () => {
    const client = await start(), body = JSON.stringify({ deviceId: 'large', padding: 'x'.repeat(256 * 1024) });
    for (const content of [body, Readable.from([body.slice(0, 150_000), body.slice(150_000)])]) {
      const response = await fetch(client.base + '/v1/identity/devices', { method: 'POST', headers: client.headers, body: content, ...(typeof content === 'string' ? {} : { duplex: 'half' as const }) });
      expect(response.status).toBe(413); expect(await response.json()).toMatchObject({ code: 'REQUEST_TOO_LARGE', retryable: false });
    }
    expect(client.observed.validated).toBe(0); expect((await fetch(client.base + '/health')).status).toBe(200);
  });
  it('rejects unsupported command content types, preserves CORS preflight and denies unexpected methods with safe envelopes', async () => {
    const client = await start();
    for (const type of ['text/plain', 'application/jsonp', 'image/png']) {
      const response = await fetch(client.base + '/v1/identity/devices', { method: 'POST', headers: { ...client.headers, 'Content-Type': type }, body: '{}' });
      expect(response.status).toBe(415); expect(await response.json()).toMatchObject({ code: 'JSON_REQUIRED', retryable: false });
    }
    const preflight = await fetch(client.base + '/v1/exports', { method: 'OPTIONS', headers: { Origin: 'http://localhost:4173', 'Content-Type': 'application/json' } });
    expect(preflight.status).toBe(204); expect(await preflight.text()).toBe(''); expect(preflight.headers.get('Access-Control-Expose-Headers')).toContain('Content-Disposition');
    const denied = await fetch(client.base + '/v1/me', { method: 'PATCH', headers: client.headers, body: '{}' });
    expect(denied.status).toBe(404); expect(await denied.json()).toMatchObject({ code: 'NOT_FOUND', retryable: false });
  });
  it('dispatches full paths containing a valid 150-character match ID beyond the per-parameter cap', async () => {
    const client=await start(), matchId='m'.repeat(150);
    const config=JSON.parse(client.api.store.match(SYNTHETIC_IDS.matchId).config_json) as MatchConfig;
    client.api.store.insertMatch({...config,matchId},SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId);
    for(const path of [`/v1/matches/${matchId}`,`/v1/matches/${matchId}/download?deviceId=long-path-device`]){
      expect(path.length).toBeGreaterThan(150);const response=await fetch(client.base+path,{headers:{Authorization:'Bearer synthetic-manager-1'}});
      expect(response.status).toBe(200);const body=await response.json() as {matchId?:string;state?:{config?:{matchId?:string}}};expect(body.matchId??body.state?.config?.matchId).toBe(matchId);
    }
    expect(client.observed.validated).toBe(2);
  });
  it('uses a safe framework envelope for malformed route encoding', async () => {
    const client=await start(), response=await fetch(client.base+'/v1/%ZZ?token=private-value');
    expect(response.status).toBe(400);const body=await response.json() as {requestId?:string};expect(body).toMatchObject({code:'INVALID_REQUEST',retryable:false});expect(JSON.stringify(body)).not.toContain('private-value');expect(body.requestId).toEqual(expect.any(String));
  });
  it('keeps explicit static GET/HEAD behavior and rejects disallowed origins before parsing', async () => {
    const client = await start(), page = await fetch(client.base + '/'); expect(page.status).toBe(200); expect(await page.text()).toContain('LongBall transport');
    const head = await fetch(client.base + '/', { method: 'HEAD' }); expect(head.status).toBe(200); expect(await head.text()).toBe('');
    expect((await fetch(client.base + '/missing')).status).toBe(404);
    const denied = await fetch(client.base + '/v1/identity/devices', { method: 'POST', headers: { ...client.headers, Origin: 'https://unrelated.invalid' }, body: '{invalid' });
    expect(denied.status).toBe(403); expect(await denied.json()).toMatchObject({ code: 'ORIGIN_DENIED' }); expect(client.observed.parsedBody).toBeUndefined();
  });
});
