import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ENGINE_VERSION, reduceMatch, type MatchEvent, type MatchState } from '../../../packages/domain/src/index';
import { createApi, type ApiOptions } from './server';
import { DevelopmentStore, EVENT_CONTRACT_VERSION, SYNTHETIC_IDS, type EventEnvelope } from './store';
import { effectiveEventTime } from '../../../packages/application/src/sync';
import type { ActivationProvider } from './activation';
import type { RecordsState } from '../../../packages/application/src/records';

const now = 1_800_000_000_000;
type Reply = { status: number; body: Record<string, unknown> };
const running: ReturnType<typeof createApi>[] = [];
const directories: string[] = [];
async function start(options: Partial<ApiOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'longball-api-test-')); directories.push(directory);
  const api = createApi({ databasePath: join(directory, 'service.sqlite'), syntheticAuth: true, now: () => now, ...options });
  running.push(api);
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const call = async (path: string, options: { token?: string | null; method?: string; body?: unknown; key?: string; controller?: string; role?: string } = {}): Promise<Reply> => {
    const headers: Record<string, string> = {};
    if (options.token !== null) headers.Authorization = `Bearer ${options.token ?? 'synthetic-manager-1'}`;
    if (options.body !== undefined) { headers['Content-Type'] = 'application/json'; headers['Idempotency-Key'] = options.key ?? randomUUID(); headers['X-Api-Contract-Version'] = EVENT_CONTRACT_VERSION; }
    if (options.controller) headers['X-Controller-Token'] = options.controller;
    if (options.role) headers['X-Longball-Role'] = options.role;
    const reply = await fetch(`${base}${path}`, { method: options.method ?? (options.body === undefined ? 'GET' : 'POST'), headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    return { status: reply.status, body: await reply.json() as Record<string, unknown> };
  };
  return { api, call, directory };
}
afterEach(async () => { for (const api of running.splice(0)) { api.server.closeAllConnections(); await api.close(); } for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const matchUrl = `/v1/matches/${SYNTHETIC_IDS.matchId}`;
const teamUrl = `/v1/teams/${SYNTHETIC_IDS.teamId}`;
class Chain {
  previousId: string | null = null;
  sequence = 0;
  constructor(public state: MatchState, readonly deviceId: string, public epoch = 1) {}
  event(details: Record<string, unknown>, monotonicMs = 0): EventEnvelope {
    const id = randomUUID();
    const command = { id, sample: { monotonicMs, sessionId: `session-${this.deviceId}`, wallTimeMs: now + monotonicMs }, ...details } as MatchEvent;
    const next = reduceMatch(this.state, command);
    const effective = effectiveEventTime(this.state, next, command);
    const envelope: EventEnvelope = { contractVersion: EVENT_CONTRACT_VERSION, schemaVersion: 1, engineVersion: ENGINE_VERSION, eventId: id, matchId: SYNTHETIC_IDS.matchId, deviceId: this.deviceId, controllerEpoch: this.epoch, clientSequence: ++this.sequence, previousEventId: this.previousId, baseRevision: this.state.revision, effectiveHalf: effective.half, halfElapsedMs: effective.halfElapsedMs, matchElapsedMs: effective.matchElapsedMs, effectiveAt: new Date(now + monotonicMs).toISOString(), recordedAt: new Date(now + monotonicMs).toISOString(), timeQuality: 'reviewRequired', clockEvidence: { monotonicMs, anchorId: `anchor-${this.deviceId}`, continuityId: `session-${this.deviceId}` }, command };
    this.previousId = id; this.state = next; return envelope;
  }
  prepare(): EventEnvelope[] {
    const events = this.state.config.selectedPlayerIds.map(playerId => this.event({ type: 'attendance.recorded', playerId, status: 'present' }));
    const lineup = this.state.config.selectedPlayerIds.slice(0, 7).map((playerId, index) => ({ playerId, slotId: `slot-${index}`, position: index === 0 ? 'GK' : 'CM' }));
    events.push(this.event({ type: 'lineup.staged', lineup }), this.event({ type: 'half.started' }));
    return events;
  }
}
async function controller(client: Awaited<ReturnType<typeof start>>, deviceId: string, token = 'synthetic-manager-1') {
  const grant = await client.call(`${matchUrl}/controller`, { token, body: { deviceId } });
  expect(grant.status).toBe(200);
  const download = await client.call(`${matchUrl}/download?deviceId=${deviceId}`, { token });
  return { token: grant.body.controllerToken as string, chain: new Chain(download.body.state as MatchState, deviceId) };
}
describe('typed HTTP authority and filtered responses', () => {
  it('fails closed without OIDC and refuses missing/invalid synthetic credentials', async () => {
    const prod = await start({ syntheticAuth: false });
    expect((await prod.call('/v1/me')).status).toBe(503);
    const client = await start();
    expect((await client.call('/v1/me', { token: null })).status).toBe(401);
    expect((await client.call('/v1/me', { token: 'forged-manager' })).status).toBe(401);
    expect((await client.call('/v1/me')).body.accountId).toBe('synthetic-account-manager');
  });
  it('enforces object/team isolation and sends no teammate records or unapproved scores', async () => {
    const client = await start();
    expect((await client.call(matchUrl, { token: 'synthetic-other-manager' })).status).toBe(404);
    expect((await client.call(`${matchUrl}/download?deviceId=child-device`, { token: 'synthetic-account-player-01' })).status).toBe(404);
    const own = await client.call(matchUrl, { token: 'synthetic-account-player-01' });
    expect(own.status).toBe(200); expect(own.body.score).toBeNull(); expect(own.body).not.toHaveProperty('state');
    expect(JSON.stringify(own.body)).not.toContain('synthetic-player-02');
    const spectator = await client.call(`${teamUrl}/records`, { token: 'synthetic-spectator' });
    expect(spectator.status).toBe(200);
    expect(spectator.body).not.toHaveProperty('editableState');
    expect(spectator.body.results).toMatchObject({ totals: null, form: null, sharing: 'withheld_policy' });
  });
  it('transactionally rejects the fifth manager, child promotion and a role-header escalation', async () => {
    const client = await start();
    const fifth = await client.call(`${teamUrl}/managers`, { token: 'synthetic-admin', body: { accountId: 'synthetic-account-manager-5' } });
    expect(fifth.status).toBe(409); expect(fifth.body.code).toBe('MANAGER_LIMIT');
    expect((await client.call(`${teamUrl}/managers`, { token: 'synthetic-admin', body: { accountId: 'synthetic-account-player-01' } })).status).toBe(403);
    expect((await client.call(`${teamUrl}/preparation`, { token: 'synthetic-account-player-01', role: 'manager' })).status).toBe(404);
    expect(client.api.store.memberships().filter(item => item.role === 'manager')).toHaveLength(5); // four Roma + other-team manager
  });
  it('uses current SQL authority for a newly assigned manager instead of stale shadow memberships', async () => {
    const client = await start();
    client.api.store.database.prepare("UPDATE memberships SET revoked_at=? WHERE account_id='synthetic-account-manager-4' AND role='manager'").run(now);
    expect((await client.call(`${teamUrl}/managers`, { token: 'synthetic-admin', body: { accountId: 'synthetic-account-manager-5' } })).status).toBe(200);
    for (const path of [`${teamUrl}/preparation`, `${teamUrl}/community`, `${teamUrl}/records`]) expect((await client.call(path, { token: 'synthetic-manager-5' })).status).toBe(200);
    expect((await client.call(`${teamUrl}/community`, { token: 'synthetic-manager-4' })).status).toBe(404);
  });
  it('accepts canonical account-scoped device identifiers with the same 120-character limit prepared for PostgreSQL', async () => {
    const client = await start();
    expect((await client.call(`${matchUrl}/controller`, { body: { deviceId: 'a'.repeat(121) } })).status).toBe(400);
    expect((await client.call(`${matchUrl}/controller`, { body: { deviceId: 'account-' + 'a'.repeat(112) } })).status).toBe(200);
    expect((await client.call(`${matchUrl}/download?deviceId=${'a'.repeat(121)}`)).status).toBe(400);
  });
});
describe('provider activation HTTP boundary', () => {
  it('keeps activation explicitly unconfigured and denies child-issued activation', async () => {
    const client = await start();
    const unconfigured = await client.call(`${teamUrl}/activation/pending-child`, { body: { playerId: 'synthetic-player-01' } });
    expect(unconfigured.status).toBe(503); expect(unconfigured.body.code).toBe('ACTIVATION_NOT_CONFIGURED');
    expect((await client.call(`${teamUrl}/activation/pending-child`, { token: 'synthetic-account-player-01', body: { playerId: 'synthetic-player-01' } })).status).toBe(404);
    const redeem = await client.call('/v1/activation/redeem', { token: null, body: { token: 'fictional-invalid-token' } });
    expect(redeem.status).toBe(503); expect(redeem.body.code).toBe('ACTIVATION_NOT_CONFIGURED');
    expect(client.api.store.database.prepare('SELECT COUNT(*) AS n FROM lb_activation_children').get()).toEqual({ n: 0 });
  });
  it('runs the isolated provider port without caching a secret or creating a session from activation', async () => {
    const subject = randomUUID(); const flows = new Map<string, { flowId: string; expiresAt: number }>();
    const provider: ActivationProvider = {
      issuer: 'https://identity.example.invalid/realms/fictional', credentialSetupOrigins: ['https://identity.example.invalid'],
      async provisionPending(input) { return { issuer: provider.issuer, subject, username: input.username, pending: true, credentialConfigured: false }; },
      async beginCredentialSetup(input) { const flow = { flowId: 'fictional-provider-flow', expiresAt: input.expiresAt }; flows.set(input.operationId, flow); return { ...flow, setupUrl: 'https://identity.example.invalid/credential-setup' }; },
      async cancelCredentialSetup(input) { flows.delete(input.operationId); },
      async verifyCredentialSetup(input) {
        const flow = flows.get(input.operationId);
        if (!flow || input.completionProof !== 'fictional-provider-proof') throw new Error('Proof invalid');
        return { issuer: provider.issuer, subject, flowId: flow.flowId, completedAt: now, credentialConfigured: true, recoveryMaterialIssued: true };
      },
    };
    const client = await start({ activationProvider: provider, activationPolicy: { version: 'fictional-http-test', activationTtlMs: 60_000, fictionalOnly: true } });
    const playerId = 'fictional-pending-player';
    const manager = client.api.store.principal({ issuer: 'urn:longball:synthetic', subject: 'synthetic-account-manager', strongAuth: true, authenticatedAt: now });
    const preparation = client.api.store.preparation(manager, SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId);
    client.api.store.preparationCommand(manager, SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, { type: 'profile.saved', id: randomUUID(), expectedRevision: preparation.revision, profile: { ...preparation.profiles[0], id: 'fictional-pending-profile', playerId, displayName: 'Fictional pending child', shirtNumber: null } });
    const pending = await client.call(`${teamUrl}/activation/pending-child`, { body: { playerId } });
    expect(pending.status).toBe(200); expect(pending.body).toMatchObject({ classification: 'child_shared', status: 'pending_activation', signInEnabled: false });
    expect((await client.call(`${teamUrl}/activation/pending-child`, { body: { playerId, password: 'never-accepted' } })).status).toBe(400);
    const key = randomUUID();
    const issued = await client.call(`${teamUrl}/activation/issue`, { key, body: { accountId: pending.body.accountId } });
    expect(issued.status).toBe(200); expect(issued.body.delivery).toBe('verified_household_process_required');
    expect((await client.call(`${teamUrl}/activation/issue`, { key, body: { accountId: pending.body.accountId } })).body.code).toBe('ACTIVATION_ALREADY_ISSUED');
    const token = issued.body.token as string;
    expect(JSON.stringify(client.api.store.database.prepare('SELECT * FROM idempotency').all())).not.toContain(token);
    expect(JSON.stringify(client.api.store.database.prepare('SELECT * FROM lb_activation_tokens').all())).not.toContain(token);
    const opened = await client.call('/v1/activation/redeem', { token: null, body: { token } });
    expect(opened.status).toBe(200); expect(opened.body.status).toBe('provider_credential_setup_required');
    expect((await client.call('/v1/activation/complete', { token: null, body: { activationId: issued.body.activationId, completionProof: 'forged' } })).status).toBe(503);
    const completed = await client.call('/v1/activation/complete', { token: null, body: { activationId: issued.body.activationId, completionProof: 'fictional-provider-proof' } });
    expect(completed.body).toEqual({ status: 'complete', signInRequired: true }); expect(completed.status).toBe(200);
    expect(completed.body).not.toHaveProperty('accessToken');
    expect((await client.call('/v1/me', { token: null })).status).toBe(401);
    const account = client.api.store.database.prepare('SELECT classification,adult_verified,status FROM accounts WHERE id=?').get(pending.body.accountId as string);
    expect(account).toEqual({ classification: 'child_shared', adult_verified: 0, status: 'active' });
    const link = await client.call('/v1/accounts/link-requests', { body: { teamId: SYNTHETIC_IDS.teamId, seasonId: SYNTHETIC_IDS.seasonId, playerId, existingAccountId: pending.body.accountId } });
    expect(link.status).toBe(200); expect(link.body).toMatchObject({ status: 'pending_independent_verification', completed: false });
    const recovery = await client.call('/v1/accounts/recovery-requests', { body: { teamId: SYNTHETIC_IDS.teamId, seasonId: SYNTHETIC_IDS.seasonId, accountId: pending.body.accountId } });
    expect(recovery.status).toBe(200); expect(recovery.body).toMatchObject({ status: 'pending_independent_verification', completed: false });
  });
});
describe('ME50–54 durable ordered event upload and controller fencing', () => {
  it('retries one offline batch without duplicating starts, intervals or scores', async () => {
    const client = await start(); const granted = await controller(client, 'phone-a');
    const events = granted.chain.prepare(); events.push(granted.chain.event({ type: 'goal.recorded', beneficiary: 'us', isOwnGoal: false, scorerPlayerId: 'synthetic-player-02', goalType: 'open_play' }, 60_000));
    const key = randomUUID();
    const first = await client.call(`${matchUrl}/events`, { body: { events }, key, controller: granted.token });
    expect(first.status).toBe(200); expect(first.body.revision).toBe(events.length);
    expect(await client.call(`${matchUrl}/events`, { body: { events }, key, controller: granted.token })).toEqual(first);
    const retry = await client.call(`${matchUrl}/events`, { body: { events }, controller: granted.token });
    expect(retry.status).toBe(200); expect((retry.body.results as { duplicate: boolean }[]).every(item => item.duplicate)).toBe(true);
    const stored = JSON.parse(client.api.store.match(SYNTHETIC_IDS.matchId).state_json) as MatchState;
    expect(stored.score).toEqual({ for: 1, against: 0 }); expect(stored.status).toBe('first_half_running');
    expect(client.api.store.database.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: events.length });
    expect((await client.call(`${matchUrl}/events`, { body: { events: [] }, key, controller: granted.token })).status).toBe(409);
  });
  it('retains an unknown engine version and reserves its device sequence', async () => {
    const client = await start(); const granted = await controller(client, 'phone-a');
    const event = granted.chain.event({ type: 'attendance.recorded', playerId: 'synthetic-player-01', status: 'present' });
    const future = { ...event, engineVersion: 'future-engine' };
    const rejected = await client.call(`${matchUrl}/events`, { body: { events: [future] }, controller: granted.token });
    expect(rejected.status).toBe(409); expect(rejected.body.revision).toBe(0);
    expect((rejected.body.results as { reason: string }[])[0].reason).toBe('UNSUPPORTED_EVENT_VERSION');
    const download = await client.call(`${matchUrl}/download?deviceId=phone-a`);
    expect(download.body.deviceCheckpoint).toEqual({ clientSequence: 1, previousEventId: event.eventId });
    expect(JSON.stringify((await client.call(`${matchUrl}/quarantine`)).body)).toContain('future-engine');
  });
  it('preserves a late goal effective boundary separately from its recording checkpoint', async () => {
    const client = await start(); const granted = await controller(client, 'phone-a');
    expect((await client.call(`${matchUrl}/events`, { body: { events: granted.chain.prepare() }, controller: granted.token })).status).toBe(200);
    const late = granted.chain.event({ type: 'goal.recorded', beneficiary: 'us', scorerPlayerId: 'synthetic-player-02', effective: { half: 1, halfElapsedMs: 120_000, matchElapsedMs: 120_000 }, lateEntryReason: 'Recorded after coaching; effective referee time confirmed' }, 600_000);
    expect(late.halfElapsedMs).toBe(120_000);
    const uploaded = await client.call(`${matchUrl}/events`, { body: { events: [late] }, controller: granted.token });
    expect(uploaded.status).toBe(200);
    const accepted = JSON.parse(client.api.store.match(SYNTHETIC_IDS.matchId).state_json) as MatchState;
    expect(accepted.halfActiveMs).toBe(600_000);
    expect(accepted.goals?.[0].effective.halfElapsedMs).toBe(120_000);
    expect(accepted.eventHistory?.at(-1)?.actorId).toBe('synthetic-account-manager');
  });
  it('fences the old branch and resumes device A sequence across handover away and back', async () => {
    const client = await start(); const a = await controller(client, 'phone-a');
    const first = a.chain.event({ type: 'attendance.recorded', playerId: 'synthetic-player-01', status: 'present' });
    expect((await client.call(`${matchUrl}/events`, { body: { events: [first] }, controller: a.token })).status).toBe(200);
    const offer = await client.call(`${matchUrl}/handover`, { body: { toAccountId: 'synthetic-account-manager-2', toDeviceId: 'phone-b', baseRevision: 1 }, controller: a.token });
    const accepted = await client.call(`${matchUrl}/handover/${offer.body.transferId}/accept`, { token: 'synthetic-manager-2', body: { deviceId: 'phone-b' } });
    expect(accepted.body.epoch).toBe(2);
    const stale = a.chain.event({ type: 'attendance.recorded', playerId: 'synthetic-player-02', status: 'present' });
    const fenced = await client.call(`${matchUrl}/events`, { body: { events: [stale] }, controller: a.token });
    expect(fenced.status).toBe(409); expect((fenced.body.results as { reason: string }[])[0].reason).toBe('STALE_CONTROLLER');
    const backOffer = await client.call(`${matchUrl}/handover`, { token: 'synthetic-manager-2', controller: accepted.body.controllerToken as string, body: { toAccountId: 'synthetic-account-manager', toDeviceId: 'phone-a', baseRevision: 1 } });
    const returned = await client.call(`${matchUrl}/handover/${backOffer.body.transferId}/accept`, { body: { deviceId: 'phone-a' } });
    expect(returned.body.epoch).toBe(3); expect(returned.body.checkpoint).toEqual({ clientSequence: 2, previousEventId: stale.eventId });
    a.chain.state = JSON.parse(client.api.store.match(SYNTHETIC_IDS.matchId).state_json) as MatchState; a.chain.epoch = 3;
    const next = a.chain.event({ type: 'attendance.recorded', playerId: 'synthetic-player-03', status: 'present' });
    const uploaded = await client.call(`${matchUrl}/events`, { body: { events: [next] }, controller: returned.body.controllerToken as string });
    expect(uploaded.status).toBe(200); expect(uploaded.body.revision).toBe(2);
    expect((await client.call(`${matchUrl}/quarantine`)).body.items).toHaveLength(1);
  });
  it('refuses a running handover without verified clock mapping and preserves recovery history', async () => {
    const client = await start(); const a = await controller(client, 'phone-a');
    expect((await client.call(`${matchUrl}/events`, { body: { events: a.chain.prepare() }, controller: a.token })).status).toBe(200);
    const transfer = await client.call(`${matchUrl}/handover`, { body: { toAccountId: 'synthetic-account-manager-2', toDeviceId: 'phone-b', baseRevision: a.chain.state.revision }, controller: a.token });
    expect(transfer.status).toBe(409); expect(transfer.body.code).toBe('CLOCK_ANCHOR_REQUIRED');
    const recovered = await client.call(`${matchUrl}/recover`, { token: 'synthetic-manager-2', body: { deviceId: 'phone-b', reason: 'Old phone unreachable; referee reconciliation required', confirmUnsynchronisedRisk: true } });
    expect(recovered.status).toBe(200); expect(recovered.body.reconciliationRequired).toBe(true);
    const state = JSON.parse(client.api.store.match(SYNTHETIC_IDS.matchId).state_json) as MatchState;
    expect(state.status).toBe('first_half_running'); expect(state.recoveryRequired).toBe(true); expect(state.matchActiveMs).toBe(0);
    expect(client.api.store.database.prepare('SELECT COUNT(*) AS n FROM controller_history').get()).toEqual({ n: 1 });
  });
  it('rolls back events, projection, sequence and idempotency together on an injected write failure', async () => {
    const client = await start(); const a = await controller(client, 'phone-a');
    const event = a.chain.event({ type: 'attendance.recorded', playerId: 'synthetic-player-01', status: 'present' });
    client.api.store.database.exec("CREATE TEMP TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'synthetic fault injection'); END;");
    const key = randomUUID();
    expect((await client.call(`${matchUrl}/events`, { body: { events: [event] }, key, controller: a.token })).status).toBe(422);
    expect(client.api.store.database.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 });
    expect(client.api.store.database.prepare('SELECT COUNT(*) AS n FROM streams').get()).toEqual({ n: 0 });
    expect((JSON.parse(client.api.store.match(SYNTHETIC_IDS.matchId).state_json) as MatchState).revision).toBe(0);
    client.api.store.database.exec('DROP TRIGGER reject_event;');
    expect((await client.call(`${matchUrl}/events`, { body: { events: [event] }, key, controller: a.token })).status).toBe(200);
  });
});
describe('explicit static browser export alongside the API', () => {
  it('serves the root and allowed assets, with no traversal, symlink escape or arbitrary route fallback', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'longball-static-test-')); directories.push(directory);
    const exported = join(directory, 'browser'); mkdirSync(exported);
    writeFileSync(join(exported, 'index.html'), '<!doctype html><title>LongBall review</title>');
    writeFileSync(join(exported, 'app.js'), 'globalThis.longballReview=true;');
    writeFileSync(join(directory, 'private.txt'), 'must not be served');
    symlinkSync(join(directory, 'private.txt'), join(exported, 'escape.js'));
    const client = await start({ staticDirectory: exported });
    const address = client.api.server.address() as AddressInfo; const base = `http://127.0.0.1:${address.port}`;
    const index = await fetch(base); expect(index.status).toBe(200); expect(await index.text()).toContain('LongBall review');
    expect(index.headers.get('cache-control')).toBe('no-store');
    expect((await fetch(`${base}/app.js`)).status).toBe(200);
    for (const path of ['/missing', '/.git/config', '/%2e%2e/private.txt', '/escape.js']) expect((await fetch(`${base}${path}`)).status).toBe(404);
    expect((await client.call('/v1/me', { token: null })).status).toBe(401);
  });
});
describe('actual private image pipeline over HTTP', () => {
  async function prepareAndUpload(client: Awaited<ReturnType<typeof start>>) {
    const { default: sharp } = await import('sharp');
    const bytes = await sharp({ create: { width: 16, height: 12, channels: 3, background: '#126946' } }).png().toBuffer();
    const prepared = await client.call(`${teamUrl}/media/uploads/prepare`, { token: 'synthetic-account-player-01', body: { matchId: 'synthetic-community-willow', byteSize: bytes.length, mimeType: 'image/png', sha256: createHash('sha256').update(bytes).digest('hex'), caption: 'Fictional generated pitch illustration', policyAcknowledged: true } });
    expect(prepared.status).toBe(200);
    const base = `http://127.0.0.1:${(client.api.server.address() as AddressInfo).port}`;
    const uploaded = await fetch(`${base}${teamUrl}/media/uploads/${prepared.body.uploadId}`, { method: 'PUT', headers: { Authorization: 'Bearer synthetic-account-player-01', 'Content-Type': 'image/png', 'X-Media-Upload-Token': prepared.body.uploadToken as string, 'X-Api-Contract-Version': EVENT_CONTRACT_VERSION, 'Idempotency-Key': randomUUID() }, body: bytes });
    expect(uploaded.status).toBe(200); expect(await uploaded.json()).toMatchObject({ status: 'uploaded', byteSize: bytes.length });
    return { prepared: prepared.body, base };
  }
  it('keeps a real uploaded file private when no safety scanner is configured', async () => {
    const client = await start(); const upload = await prepareAndUpload(client);
    const complete = await fetch(`${upload.base}${teamUrl}/media/uploads/${upload.prepared.uploadId}/complete`, { method: 'POST', headers: { Authorization: 'Bearer synthetic-account-player-01', 'Content-Type': 'application/json', 'X-Media-Upload-Token': upload.prepared.uploadToken as string, 'X-Api-Contract-Version': EVENT_CONTRACT_VERSION, 'Idempotency-Key': randomUUID() }, body: '{}' });
    expect(complete.status).toBe(503); expect(await complete.json()).toMatchObject({ code: 'SCANNER_REQUIRED' });
    const image = await fetch(`${upload.base}${teamUrl}/media/photos/${upload.prepared.photoId}/thumbnail`, { headers: { Authorization: 'Bearer synthetic-spectator' } });
    expect(image.status).toBe(404);
    const list = await client.call(`${teamUrl}/media/uploads`, { token: 'synthetic-account-player-01' });
    expect(list.status).toBe(200); expect(JSON.stringify(list.body)).not.toContain('original_key'); expect(JSON.stringify(list.body)).not.toContain('uploadToken');
  });
  it('processes real bytes, atomically links a pending revision, re-checks review/policy and never serves an original', async () => {
    const client = await start({ mediaScanner: { scan: async () => ({ verdict: 'clean', engine: 'test-double-only' }) } });
    const upload = await prepareAndUpload(client);
    const complete = await fetch(`${upload.base}${teamUrl}/media/uploads/${upload.prepared.uploadId}/complete`, { method: 'POST', headers: { Authorization: 'Bearer synthetic-account-player-01', 'Content-Type': 'application/json', 'X-Media-Upload-Token': upload.prepared.uploadToken as string, 'X-Api-Contract-Version': EVENT_CONTRACT_VERSION, 'Idempotency-Key': randomUUID() }, body: '{}' });
    expect(complete.status).toBe(200); expect(await complete.json()).toMatchObject({ status: 'processed', width: 16, height: 12 });
    const fetchImage = (who: string, mode = 'gallery', variant = 'thumbnail') => fetch(`${upload.base}${teamUrl}/media/photos/${upload.prepared.photoId}/${variant}?mode=${mode}`, { headers: { Authorization: `Bearer ${who}` } });
    expect((await fetchImage('synthetic-account-player-02')).status).toBe(404);
    const own = await fetchImage('synthetic-account-player-01', 'own');
    expect(own.status).toBe(200); expect(own.headers.get('content-type')).toBe('image/jpeg'); expect(own.headers.get('cache-control')).toBe('private, no-store');
    expect((await fetchImage('synthetic-manager-1', 'review')).status).toBe(200);
    const reviewed = await client.call(`${teamUrl}/community`, { body: { command: { id: randomUUID(), type: 'photo.reviewed', photoId: upload.prepared.photoId, sourceRevision: 1, decision: 'approve' } } });
    expect(reviewed.status).toBe(200);
    expect((await fetchImage('synthetic-manager-1')).status).toBe(200);
    expect((await fetchImage('synthetic-spectator')).status).toBe(404); // Q21 remains manager only.
    expect((await fetchImage('synthetic-manager-1', 'gallery', 'original')).status).toBe(404);
    const removed = await client.call(`${teamUrl}/community`, { body: { command: { id: randomUUID(), type: 'photo.removed', photoId: upload.prepared.photoId } } });
    expect(removed.status).toBe(200); expect((await fetchImage('synthetic-manager-1')).status).toBe(404);
  });
});
describe('durable preparation, records, community and own privacy requests', () => {
  it('persists preparation commands and refuses stale document edits', async () => {
    const client = await start();
    const command = { id: randomUUID(), expectedRevision: 0, type: 'team.updated', name: 'Roma review', ageGroup: 'U10', defaultPitchPlaces: 7, defaultHalfDurationMs: 1_500_000, logo: null };
    const saved = await client.call(`${teamUrl}/preparation`, { body: { command } });
    expect(saved.status).toBe(200); expect(saved.body.team).toMatchObject({ name: 'Roma review' });
    expect((await client.call(`${teamUrl}/preparation`, { body: { command: { ...command, id: randomUUID(), name: 'Stale overwrite' } } })).status).toBe(422);
    const restored = new DevelopmentStore(client.api.store.path, () => now);
    expect(restored.document<{ revision: number }>(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'preparation').revision).toBe(1); restored.close();
  });
  it('keeps idempotency receipts scoped to the requested season after another-season membership is revoked', async () => {
    const client = await start(); const secondSeason = 'synthetic-season-2027-28';
    const state = client.api.store.preparation(client.api.store.principal({ issuer: 'urn:longball:synthetic', subject: 'synthetic-account-manager', strongAuth: true, authenticatedAt: now }), SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId);
    const second = structuredClone(state); second.activeSeasonId = secondSeason;
    second.seasons = [{ id: secondSeason, label: '2027/28', startYear: 2027, startDate: '2027-09-01', endDate: '2028-08-31', spectatorRenewalRequired: true }];
    second.profiles = []; second.fixtures = []; second.training = []; second.snapshots = [];
    client.api.store.saveDocument(SYNTHETIC_IDS.teamId, secondSeason, 'preparation', second);
    client.api.store.database.prepare("INSERT INTO memberships(account_id,team_id,season_id,role) VALUES(?,?,?,'manager')").run('synthetic-account-manager', SYNTHETIC_IDS.teamId, secondSeason);
    const key = randomUUID(); const command = { id: randomUUID(), type: 'team.updated', expectedRevision: 0, name: 'Rehearsal name', ageGroup: 'U10', defaultPitchPlaces: 7, defaultHalfDurationMs: 1_500_000, logo: null };
    const first = await client.call(`${teamUrl}/preparation`, { body: { command }, key });
    expect(first.status).toBe(200); expect(first.body.activeSeasonId).toBe(SYNTHETIC_IDS.seasonId);
    client.api.store.database.prepare('UPDATE memberships SET revoked_at=? WHERE account_id=? AND season_id=?').run(now, 'synthetic-account-manager', SYNTHETIC_IDS.seasonId);
    const next = await client.call(`${teamUrl}/preparation?seasonId=${secondSeason}`, { body: { command }, key });
    expect(next.status).toBe(200); expect(next.body.activeSeasonId).toBe(secondSeason);
    expect(next.body.profiles).toEqual([]); expect(next.body.revision).toBe(1);
    expect((await client.call(`${teamUrl}/preparation`)).status).toBe(404);
  });
  it('lets a player answer only for their server-linked profile without changing attendance or manager fields', async () => {
    const client = await start();
    const own = await client.call(`${teamUrl}/preparation/own`, { token: 'synthetic-account-player-01' });
    expect(own.status).toBe(200); expect(own.body.kind).toBe('player-preparation');
    expect(JSON.stringify(own.body)).not.toContain('synthetic-player-02'); expect(own.body).not.toHaveProperty('profiles');
    const response = await client.call(`${teamUrl}/preparation/own`, { token: 'synthetic-account-player-01', body: { command: { id: randomUUID(), expectedRevision: 0, type: 'own.fixture_response_recorded', fixtureId: SYNTHETIC_IDS.matchId, response: 'unavailable' } } });
    expect(response.status).toBe(200);
    expect((response.body.fixtures as { response: string; attendance: string }[])[0]).toMatchObject({ response: 'unavailable', attendance: 'not_recorded' });
    const preference = await client.call(`${teamUrl}/preparation/own`, { token: 'synthetic-account-player-01', body: { command: { id: randomUUID(), expectedRevision: 1, type: 'own.preferences_saved', preferences: ['CB', 'GK', 'ST'] } } });
    expect(preference.status).toBe(200); expect(preference.body.profile).toMatchObject({ playerId: 'synthetic-player-01', preferences: ['CB', 'GK', 'ST'], shirtNumber: 1 });
    const injected = await client.call(`${teamUrl}/preparation/own`, { token: 'synthetic-account-player-01', body: { command: { id: randomUUID(), expectedRevision: 2, type: 'own.preferences_saved', preferences: ['CB', 'GK', 'ST'], profileId: `synthetic-player-02:${SYNTHETIC_IDS.seasonId}`, shirtNumber: 99 } } });
    expect(injected.status).toBe(400);
    expect((await client.call(`${teamUrl}/preparation/own`, { token: 'synthetic-spectator' })).status).toBe(404);
  });
  it('creates a new canonical match from its prepared snapshot and never overwrites a claimed stream', async () => {
    const client = await start(); let revision = 0;
    const profileIds = Array.from({ length: 9 }, (_, index) => `synthetic-player-${String(index + 1).padStart(2, '0')}:${SYNTHETIC_IDS.seasonId}`);
    const fixtureId = 'synthetic-new-fixture';
    const apply = async (command: Record<string, unknown>) => {
      const response = await client.call(`${teamUrl}/preparation`, { body: { command: { id: randomUUID(), expectedRevision: revision, ...command } } });
      if (response.status === 200) revision = response.body.revision as number;
      return response;
    };
    expect((await apply({ type: 'fixture.saved', fixture: { id: fixtureId, seasonId: SYNTHETIC_IDS.seasonId, opponent: 'Fictional New FC', playedDate: '2026-11-07', kickoff: '10:00', arrival: '09:30', venue: 'Fictional pitch', homeAway: 'home', format: 7, plannedHalfDurationMs: 1_500_000 } })).status).toBe(200);
    expect((await apply({ type: 'fixture.selection_saved', fixtureId, selectedProfileIds: profileIds })).status).toBe(200);
    expect((await apply({ type: 'fixture.attendance_recorded', fixtureId, profileId: profileIds[0], attendance: 'present' })).status).toBe(200);
    expect((await apply({ type: 'fixture.attendance_recorded', fixtureId, profileId: profileIds[1], attendance: 'absent' })).status).toBe(200);
    expect((await apply({ type: 'fixture.response_recorded', fixtureId, profileId: profileIds[2], response: 'available' })).status).toBe(200);
    expect((await apply({ type: 'fixture.prepared', fixtureId, formationId: 'formation-7' })).status).toBe(200);
    const path = `/v1/matches/${fixtureId}`;
    const download = await client.call(`${path}/download?deviceId=new-phone`);
    expect(download.status).toBe(200);
    const match = download.body.state as MatchState;
    expect(match.config.fixture).toMatchObject({ opponent: 'Fictional New FC', teamId: SYNTHETIC_IDS.teamId });
    expect(match.config.slots).toHaveLength(7);
    expect(match.attendance).toMatchObject({ 'synthetic-player-01': 'present', 'synthetic-player-02': 'absent', 'synthetic-player-03': 'not_recorded' });
    expect((await client.call(`${path}/controller`, { body: { deviceId: 'new-phone' } })).status).toBe(200);
    const prepared = await client.call(`${teamUrl}/preparation`);
    const profile = (prepared.body.profiles as { id: string; displayName: string }[]).find(profile => profile.id === profileIds[2])!;
    expect((await apply({ type: 'profile.saved', profile: { ...profile, displayName: 'Changed for the next preparation' } })).status).toBe(200);
    const changed = await apply({ type: 'fixture.prepared', fixtureId, formationId: 'formation-7' });
    expect(changed.status).toBe(409); expect(changed.body.code).toBe('MATCH_HISTORY_EXISTS');
    expect((JSON.parse(client.api.store.match(fixtureId).config_json) as MatchState['config']).players.find(player => player.id === 'synthetic-player-03')?.displayName).toBe('Player 03');
  });
  it('projects held training evidence using stable player IDs, keeps RSVP separate, and excludes cancelled sessions atomically', async () => {
    const client = await start(); let revision = 0;
    const profileId = `synthetic-player-01:${SYNTHETIC_IDS.seasonId}`;
    const apply = async (command: Record<string, unknown>, token?: string) => {
      const response = await client.call(`${teamUrl}/preparation${token ? '/own' : ''}`, { token, body: { command: { id: randomUUID(), expectedRevision: revision, ...command } } });
      if (response.status === 200) revision = response.body.revision as number;
      return response;
    };
    const report = async () => {
      const response = await client.call(`${teamUrl}/records`, { token: 'synthetic-account-player-01' });
      expect(response.status).toBe(200);
      return (response.body.participation as { rows: { playerId: string; training: Record<string, number>; trainingRecords: { actualAttendance: string; availabilityResponse: string }[] }[] }).rows[0];
    };
    expect((await apply({ type: 'training.saved', training: { id: 'fictional-report-training', seasonId: SYNTHETIC_IDS.seasonId, date: '2026-11-04', time: '18:00', venue: 'Fictional training pitch', recurrenceGroupId: null, expectedProfileIds: [profileId] } })).status).toBe(200);
    expect((await apply({ type: 'training.status_changed', trainingId: 'fictional-report-training', status: 'held' })).status).toBe(200);
    expect((await apply({ type: 'own.training_response_recorded', trainingId: 'fictional-report-training', response: 'available' }, 'synthetic-account-player-01')).status).toBe(200);
    expect(await report()).toMatchObject({ playerId: 'synthetic-player-01', training: { eligibleEventCount: 1, attendanceRecordedCount: 0, unknownAttendanceCount: 1 }, trainingRecords: [{ actualAttendance: 'not_recorded', availabilityResponse: 'available' }] });
    expect((await apply({ type: 'training.attendance_recorded', trainingId: 'fictional-report-training', profileId, attendance: 'present' })).status).toBe(200);
    expect(await report()).toMatchObject({ training: { eligibleEventCount: 1, attendanceRecordedCount: 1, attendedCount: 1 } });
    expect((await apply({ type: 'training.status_changed', trainingId: 'fictional-report-training', status: 'cancelled' })).status).toBe(200);
    expect(await report()).toMatchObject({ training: { eligibleEventCount: 0, attendanceRecordedCount: 0, attendedCount: 0 }, trainingRecords: [] });
    const before = (await client.call(`${teamUrl}/preparation`)).body;
    const beforeRecords = client.api.store.document<RecordsState>(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'records');
    expect(beforeRecords.trainingAttendance.find(session => session.sessionId === 'fictional-report-training')).toMatchObject({ eventStatus: 'cancelled', expectedPlayerIds: ['synthetic-player-01'], attendance: { 'synthetic-player-01': 'present' } });
    client.api.store.database.exec("CREATE TEMP TRIGGER reject_training_projection BEFORE UPDATE ON documents WHEN NEW.kind='records' BEGIN SELECT RAISE(ABORT,'fictional projection failure'); END;");
    expect((await apply({ type: 'training.status_changed', trainingId: 'fictional-report-training', status: 'held' })).status).toBe(422);
    expect((await client.call(`${teamUrl}/preparation`)).body).toEqual(before);
    expect(client.api.store.document<RecordsState>(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'records')).toEqual(beforeRecords);
  });
  it('updates current report roster labels while preserving archived participation and the live match snapshot', async () => {
    const client = await start(); const granted = await controller(client, 'archive-phone');
    const events = granted.chain.prepare();
    events.push(granted.chain.event({ type: 'half.ended' }, 1_500_000), granted.chain.event({ type: 'half.started' }, 1_500_000), granted.chain.event({ type: 'half.ended' }, 3_000_000));
    expect((await client.call(`${matchUrl}/events`, { body: { events }, controller: granted.token })).status).toBe(200);
    const archived = await client.call(`${teamUrl}/records`, { body: { command: { type: 'live.archive', commandId: randomUUID(), at: new Date(now).toISOString(), actor: 'manager', match: granted.chain.state } } });
    expect(archived.status).toBe(200);
    const before = client.api.store.document<RecordsState>(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'records').results;
    expect(before.find(record => record.id === SYNTHETIC_IDS.matchId)?.participation?.[0]).toHaveProperty('primaryWasGoalkeeper');
    const matchConfigBefore = client.api.store.match(SYNTHETIC_IDS.matchId).config_json;
    const preparation = await client.call(`${teamUrl}/preparation`);
    const profile = (preparation.body.profiles as { id: string; playerId: string; displayName: string }[]).find(profile => profile.playerId === 'synthetic-player-01')!;
    const renamed = await client.call(`${teamUrl}/preparation`, { body: { command: { id: randomUUID(), expectedRevision: preparation.body.revision, type: 'profile.saved', profile: { ...profile, displayName: 'Renamed fictional player', preferences: ['ST', 'CB', 'GK'] } } } });
    expect(renamed.status).toBe(200);
    const added = await client.call(`${teamUrl}/preparation`, { body: { command: { id: randomUUID(), expectedRevision: renamed.body.revision, type: 'profile.saved', profile: { ...profile, id: 'fictional-new-roster-profile', playerId: 'fictional-new-roster-player', displayName: 'New fictional roster player', shirtNumber: null } } } });
    expect(added.status).toBe(200);
    const report = await client.call(`${teamUrl}/records`);
    const rows = (report.body.participation as { rows: { playerId: string; label: string }[] }).rows;
    expect(rows.find(row => row.playerId === 'synthetic-player-01')?.label).toBe('Renamed fictional player');
    expect(rows.find(row => row.playerId === 'fictional-new-roster-player')?.label).toBe('New fictional roster player');
    expect(client.api.store.document<RecordsState>(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'records').results).toEqual(before);
    expect(client.api.store.match(SYNTHETIC_IDS.matchId).config_json).toBe(matchConfigBefore);
  });
  it('records no inaccessible connected rollover before manager and player assignments are approved', async () => {
    const client = await start();
    const before = await client.call(`${teamUrl}/preparation`);
    const response = await client.call(`${teamUrl}/preparation`, { body: { command: { id: randomUUID(), expectedRevision: before.body.revision, type: 'season.rolled_over', idForSeason: 'fictional-unassigned-season', startYear: 2027, copyPlayers: true, confirmSpectatorRenewal: true } } });
    expect(response.status).toBe(503); expect(response.body.code).toBe('SEASON_ASSIGNMENT_REQUIRED');
    expect((await client.call(`${teamUrl}/preparation`)).body).toEqual(before.body);
    expect(client.api.store.memberships().some(membership => membership.seasonId === 'fictional-unassigned-season')).toBe(false);
  });
  it('keeps pending media private, ballots private and rejects an expired grant even on retry', async () => {
    const client = await start();
    expect((await client.call(`${teamUrl}/community/media/synthetic-pending-ball`, { token: 'synthetic-spectator' })).status).toBe(404);
    expect((await client.call(`${teamUrl}/community/media/synthetic-pending-ball?mode=own`, { token: 'synthetic-account-player-01' })).status).toBe(200);
    expect((await client.call(`${teamUrl}/community/media/synthetic-pending-ball?mode=own`, { token: 'synthetic-account-player-02' })).status).toBe(404);
    const key = randomUUID(); const command = { id: randomUUID(), type: 'preferences.changed', preferences: { schedule: true, match: true, awards: false, photos: false, quietStart: null, quietEnd: null } };
    expect((await client.call(`${teamUrl}/community`, { token: 'synthetic-spectator', key, body: { command } })).status).toBe(200);
    client.api.store.database.prepare("UPDATE memberships SET expires_at=? WHERE account_id='synthetic-account-spectator'").run(now);
    expect((await client.call(`${teamUrl}/community`, { token: 'synthetic-spectator', key, body: { command } })).status).toBe(404);
    const manager = await client.call(`${teamUrl}/community`);
    expect(manager.status).toBe(200); expect(manager.body).not.toHaveProperty('ballots');
    expect(JSON.stringify(manager.body)).not.toContain('voterPlayerId');
  });
  it('revoking an accepted invitation denies all match routes and preserves another independently active grant', async () => {
    const client = await start();
    const createInvite = (invitationId: string, reviewCode: string) => client.call(`${teamUrl}/community`, { body: { command: { id: randomUUID(), type: 'invite.created', invitationId, reviewCode, expiresAtMs: now + 86_400_000 } } });
    const acceptInvite = (reviewCode: string) => client.call(`${teamUrl}/community`, { token: 'synthetic-account-invitee', body: { command: { id: randomUUID(), type: 'invite.accepted', reviewCode } } });
    const revokeInvite = (invitationId: string) => client.call(`${teamUrl}/community`, { body: { command: { id: randomUUID(), type: 'invite.revoked', invitationId } } });
    expect((await createInvite('invitation-one', 'FICTIONAL-ONE')).status).toBe(200);
    expect((await acceptInvite('FICTIONAL-ONE')).status).toBe(200);
    expect((await client.call(matchUrl, { token: 'synthetic-account-invitee' })).status).toBe(200);
    expect((await revokeInvite('invitation-one')).status).toBe(200);
    for (const path of [matchUrl, `${teamUrl}/matches`, `${teamUrl}/records`, `${teamUrl}/community`]) expect((await client.call(path, { token: 'synthetic-account-invitee' })).status).toBe(404);
    expect((await createInvite('invitation-two', 'FICTIONAL-TWO')).status).toBe(200);
    expect((await acceptInvite('FICTIONAL-TWO')).status).toBe(200);
    expect((await createInvite('invitation-three', 'FICTIONAL-THREE')).status).toBe(200);
    expect((await acceptInvite('FICTIONAL-THREE')).status).toBe(200);
    expect((await revokeInvite('invitation-three')).status).toBe(200);
    expect((await client.call(matchUrl, { token: 'synthetic-account-invitee' })).status).toBe(200);
    expect((await client.call(`${teamUrl}/matches`, { token: 'synthetic-account-invitee' })).status).toBe(200);
    expect((await revokeInvite('invitation-two')).status).toBe(200);
    expect((await client.call(matchUrl, { token: 'synthetic-account-invitee' })).status).toBe(404);
  });
  it('rejects caller-manufactured trusted finish evidence and competition sharing policy', async () => {
    const client = await start();
    const forged = await client.call(`${teamUrl}/community`, { body: { command: { id: randomUUID(), type: 'match.registered', match: { id: 'manufactured-finish', teamId: SYNTHETIC_IDS.teamId, seasonId: SYNTHETIC_IDS.seasonId, label: 'Forged sharing approval', playedAtMs: now - 3_600_000, selectedPlayerIds: ['synthetic-player-01'], presentPlayerIds: ['synthetic-player-01'], playedPlayerIds: ['synthetic-player-01'], actualFullTimeAtMs: now, finishQuality: 'trusted', sharing: 'fictional_review_only', policyVersion: 99 } } } });
    expect(forged.status).toBe(503); expect(forged.body.code).toBe('POLICY_APPROVAL_REQUIRED');
    const stored = client.api.store.document<{ matches: { id: string }[] }>(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'community');
    expect(stored.matches.some(match => match.id === 'manufactured-finish')).toBe(false);
  });
  it('captures own export/deletion requests without erasing records or approving retention', async () => {
    const client = await start();
    const requested = await client.call('/v1/privacy/requests', { token: 'synthetic-account-player-01', body: { kind: 'delete_account' } });
    expect(requested.status).toBe(200); expect(requested.body).toMatchObject({ status: 'pending_verification_and_policy', erased: false, verificationRequired: true });
    expect((await client.call('/v1/privacy/requests', { token: 'synthetic-account-player-02' })).body.items).toHaveLength(0);
    expect(client.api.store.database.prepare("SELECT status FROM accounts WHERE id='synthetic-account-player-01'").get()).toEqual({ status: 'active' });
  });
  it('backs up and restores real SQLite state without claiming PostgreSQL or device backup proof', async () => {
    const client = await start(); const a = await controller(client, 'phone-a');
    const event = a.chain.event({ type: 'attendance.recorded', playerId: 'synthetic-player-01', status: 'present' });
    expect((await client.call(`${matchUrl}/events`, { body: { events: [event] }, controller: a.token })).status).toBe(200);
    const destination = join(client.directory, 'restore.sqlite'); await client.api.store.backup(destination);
    const restored = new DevelopmentStore(destination, () => now);
    expect(restored.integrity()).toBe('ok'); expect(restored.match(SYNTHETIC_IDS.matchId).state_json).toEqual(client.api.store.match(SYNTHETIC_IDS.matchId).state_json);
    expect(restored.database.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 });
    restored.close();
  });
});
