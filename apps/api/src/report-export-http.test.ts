import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { createApi, type ApiOptions } from './server';
import { createPostgresApi } from './postgres-server';
import { PostgresStore } from './postgres-store';
import { PgMediaService } from './postgres-media';
import { PostgresActivationService } from './postgres-activation';
import { applyRuntimeGrants } from './runtime-grants';
import { DevelopmentStore, EVENT_CONTRACT_VERSION, SYNTHETIC_IDS } from './store';
import { runDueReportExports } from '../../worker/src/report-export-jobs';
import type { ReportExportOptions } from './report-export-config';

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const scope = { teamId: SYNTHETIC_IDS.teamId, seasonId: SYNTHETIC_IDS.seasonId };
const teamPath = `/v1/teams/${scope.teamId}/records?seasonId=${scope.seasonId}`;
const testUrl = process.env.LONGBALL_POSTGRES_TEST_URL;
function pdfText(pdf: PDFDocument): string {
  const streams = pdf.context.enumerateIndirectObjects().flatMap(([, value]) => value instanceof PDFRawStream ? [Buffer.from(decodePDFRawStream(value).decode()).toString('utf8')] : []);
  const characters = new Map<string, string>();
  for (const stream of streams.filter(value => value.includes('beginbfchar'))) {
    for (const block of stream.matchAll(/beginbfchar\s+([\s\S]*?)\s+endbfchar/g)) {
      for (const match of block[1].matchAll(/<([\da-f]+)>\s*<([\da-f]+)>/gi)) characters.set(match[1].toUpperCase(), Buffer.from(match[2], 'hex').swap16().toString('utf16le'));
    }
  }
  return streams.filter(value => !value.includes('beginbfchar')).flatMap(stream => [...stream.matchAll(/<([\da-f]+)>\s*Tj/gi)].map(match => (match[1].toUpperCase().match(/.{4}/g) ?? []).map(glyph => characters.get(glyph) ?? '').join(''))).join('\n');
}
async function start(kind: 'sqlite' | 'postgres', configured = true, ttlMs = 3_600_000) {
  const directory = mkdtempSync(join(tmpdir(), 'longball-report-jobs-'));
  closes.push(async () => rmSync(directory, { recursive: true, force: true }));
  const options: ReportExportOptions = { encryptionKey: randomBytes(32), ttlMs };
  const settings: ApiOptions = { databasePath: join(directory, 'service.sqlite'), mediaDirectory: join(directory, 'media'), syntheticAuth: true, reportExports: configured ? options : undefined };
  let api: ReturnType<typeof createApi> | Awaited<ReturnType<typeof createPostgresApi>>;
  let worker: DevelopmentStore | PostgresStore, owner: DevelopmentStore | PostgresStore;
  if (kind === 'postgres') {
    const admin = new Pool({ connectionString: testUrl!, max: 1 }), suffix = randomUUID().replaceAll('-', ''), database = `lb_reports_${suffix}`;
    const roles = { apiRole: `lb_reports_api_${suffix}`, workerRole: `lb_reports_worker_${suffix}` };
    await admin.query(`CREATE DATABASE "${database}"`);
    for (const role of Object.values(roles)) await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    closes.push(async () => { await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`); for (const role of Object.values(roles)) await admin.query(`DROP ROLE "${role}"`); await admin.end(); });
    const ownerUrl = new URL(testUrl!); ownerUrl.pathname = `/${database}`;
    owner = await PostgresStore.open(ownerUrl.href); await owner.seedSynthetic();
    closes.push(() => Promise.resolve(owner.close()));
    const media = await PgMediaService.open({ directory: settings.mediaDirectory!, database: owner.db }); closes.push(() => media.close());
    await new PostgresActivationService({ store: owner }).initialize(); await applyRuntimeGrants(owner.db, roles);
    const apiUrl = new URL(ownerUrl); apiUrl.username = roles.apiRole; apiUrl.password = '';
    api = await createPostgresApi({ ...settings, connectionString: apiUrl.href, migrationMode: 'verify', seedSynthetic: false });
    const workerUrl = new URL(ownerUrl); workerUrl.username = roles.workerRole; workerUrl.password = '';
    worker = await PostgresStore.open(workerUrl.href, Date.now, { migrationMode: 'verify' }); await worker.assertRuntimeRole('worker');
  } else { api = createApi(settings); owner = api.store; worker = new DevelopmentStore(settings.databasePath); }
  closes.push(() => Promise.resolve(worker.close()));
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve));
  closes.push(async () => { api.server.closeAllConnections(); await api.close(); });
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const call = (path: string, args: { token?: string; role?: string; body?: unknown; key?: string; revision?: string; origin?: string } = {}) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${args.token ?? 'synthetic-manager-1'}` };
    if (args.role) headers['X-Longball-Role'] = args.role;
    if (args.revision !== undefined) headers['If-Match'] = args.revision;
    if (args.origin) headers.Origin = args.origin;
    if (args.body !== undefined) Object.assign(headers, { 'Content-Type': 'application/json', 'X-Api-Contract-Version': EVENT_CONTRACT_VERSION, 'Idempotency-Key': args.key ?? randomUUID() });
    return fetch(base + path, { method: args.body === undefined ? 'GET' : 'POST', headers, body: args.body === undefined ? undefined : JSON.stringify(args.body), signal: AbortSignal.timeout(15_000) });
  };
  const json = async (path: string, args: Parameters<typeof call>[1] = {}) => { const response = await call(path, args); return { status: response.status, body: await response.json() as Record<string, unknown> }; };
  const execute = async (sql: string, values: (string | number | null)[]) => owner instanceof PostgresStore ? owner.execute(sql.replaceAll('?', (_match: string, offset: number) => `$${(sql.slice(0, offset).match(/\?/g)?.length ?? 0) + 1}`), values) : owner.database.prepare(sql).run(...values);
  return { api, owner, worker, options, call, json, execute };
}
for (const kind of ['sqlite', 'postgres'] as const) describe.skipIf(kind === 'postgres' && !testUrl)(`canonical report exports on ${kind}`, () => {
  it('queues idempotently, generates outside HTTP, stores encrypted bytes and downloads current own CSV with cross-origin headers', async () => {
    const client = await start(kind), body = { ...scope, kind: 'own_participation', format: 'csv' }, args = { token: 'synthetic-account-player-01', role: 'player', body, key: randomUUID() };
    const report = await client.json(teamPath, args.token ? { token: args.token, role: 'player' } : {});
    const revision = `"${report.body.revision}"`;
    const first = await client.json('/v1/exports', { ...args, revision }); expect(first.status).toBe(202); expect(first.body).toMatchObject({ status: 'queued', downloadPath: null, generatedAt: null });
    expect(await client.json('/v1/exports', { ...args, revision })).toEqual(first);
    expect((await client.json('/v1/exports', { ...args, body: { ...body, format: 'pdf' }, revision })).status).toBe(409);
    expect((await client.json('/v1/exports', { ...args, revision: '"999"' })).status).toBe(409);
    const path = `/v1/exports/${first.body.id}`;
    expect((await client.json(path + '/download', args)).status).toBe(404); // A POST is never a download.
    const viewer = { token: args.token, role: args.role };
    expect((await client.json(path, viewer)).body.status).toBe('queued');
    expect(await runDueReportExports(client.worker, client.options)).toMatchObject({ completed: 1 });
    expect((await client.json(path, viewer)).body).toMatchObject({ status: 'ready', downloadPath: path + '/download' });
    const download = await client.call(path + '/download', { ...viewer, origin: 'http://localhost:4173' }); expect(download.status).toBe(200);
    expect(download.headers.get('Content-Disposition')).toBe(`attachment; filename="longball-report-${first.body.id}.csv"`);
    expect(download.headers.get('Access-Control-Expose-Headers')).toContain('Content-Disposition');
    expect(download.headers.get('Cache-Control')).toBe('private, no-store');
    const bytes = new Uint8Array(await download.arrayBuffer()), text = Buffer.from(bytes).toString('utf8');
    expect(Number(download.headers.get('Content-Length'))).toBe(bytes.length); expect(text).toContain('synthetic-player-01'); expect(text).not.toContain('synthetic-player-02'); expect(text).not.toContain('editableState');
    const saved = client.owner instanceof PostgresStore ? await client.owner.one('SELECT * FROM report_exports WHERE id=$1', [first.body.id]) : client.owner.database.prepare('SELECT * FROM report_exports WHERE id=?').get(first.body.id as string);
    expect(saved).toMatchObject({ status: 'ready', snapshot_ciphertext: null }); expect(JSON.stringify(saved)).not.toContain('Ralph Barrett'); expect(JSON.stringify(saved)).not.toContain('playingMs');
    expect((await client.json(path, { token: 'synthetic-account-player-02', role: 'player' })).status).toBe(404);
    expect((await client.json(path, { token: args.token, role: 'spectator' })).status).toBe(404);
    await client.execute('UPDATE memberships SET revoked_at=? WHERE account_id=? AND role=?', [Date.now(), 'synthetic-account-player-01', 'player']);
    expect((await client.json(path + '/download', viewer)).status).toBe(404);
  });
  it('supports canonical PDF without mandatory If-Match and preserves policy withholding, unknown values and current scope invalidation', async () => {
    const client = await start(kind), viewer = { token: 'synthetic-spectator', role: 'spectator' };
    const reports=await client.json(teamPath,viewer), matchId=(reports.body.matches as {matchId:string}[])[0].matchId;
    const body = { ...scope, kind: 'match_summary', matchId, format: 'pdf' };
    const first = await client.json('/v1/exports', { ...viewer, body }); expect(first.status).toBe(202);
    expect(await runDueReportExports(client.worker, client.options)).toMatchObject({ completed: 1 });
    const path = `/v1/exports/${first.body.id}`, download = await client.call(path + '/download', viewer); expect(download.status).toBe(200); expect(download.headers.get('Content-Type')).toBe('application/pdf');
    const bytes = await download.arrayBuffer(), pdf = await PDFDocument.load(bytes); expect(pdf.getPageCount()).toBeGreaterThan(0); expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe('%PDF-');
    const text = pdfText(pdf);
    expect(text).toContain('Team: Roma U10'); expect(text).toContain('Season: 2026/27'); expect(text).toContain('Club: Richmond Rovers');
    expect(text).toContain('Withheld by competition policy'); expect(text).toContain('Not recorded');
    expect(text).not.toContain('halfTimeScore'); expect(text).not.toContain('policyFingerprint'); expect(text).not.toContain('synthetic-player-02');
    await client.execute('UPDATE documents SET revision=revision+1 WHERE team_id=? AND season_id=? AND kind=?', [scope.teamId, scope.seasonId, 'records']);
    expect((await client.json(path, viewer)).body).toMatchObject({ status: 'failed', failureCode: 'EXPORT_SOURCE_CHANGED' });
    expect((await client.json(path + '/download', viewer)).status).toBe(409);
  });
  it('formats an own-player PDF with human labels and refuses old names after actual configuration renaming', async () => {
    const client = await start(kind), viewer = { token: 'synthetic-account-player-01', role: 'player' };
    const body = { ...scope, kind: 'own_participation', format: 'pdf' };
    const report = await client.json(teamPath, viewer);
    const ownRows = (report.body.participation as { rows: { playingMs: number }[] }).rows;
    expect(ownRows).toHaveLength(1);
    const first = await client.json('/v1/exports', { ...viewer, body }); expect(first.status).toBe(202);
    expect(await runDueReportExports(client.worker, client.options)).toMatchObject({ completed: 1 });
    const path = `/v1/exports/${first.body.id}`, response = await client.call(path + '/download', viewer); expect(response.status).toBe(200);
    const pdf = await PDFDocument.load(await response.arrayBuffer()), text = pdfText(pdf);
    expect(text).toContain('Team: Roma U10'); expect(text).toContain('Season: 2026/27'); expect(text).toContain('Club: Richmond Rovers');
    expect(text).toContain('Audience: Player and parent — own records');
    expect(text).toContain(`Player 1 · Playing time (ms): ${ownRows[0].playingMs}`);
    expect(text).not.toContain('Player 2'); expect(text).not.toContain('synthetic-player-02');
    expect(text).not.toMatch(/rows\[1\]|playingMs|policyFingerprint|schemaVersion|generatedAt|synthetic-roma-u10/);
    expect(text.match(/Prepared:/g)).toHaveLength(1);
    expect(pdf.getCreationDate()).toBeInstanceOf(Date);
    const configurationPath = `/v1/teams/${scope.teamId}/configuration?seasonId=${scope.seasonId}`;
    const initial = await client.json(configurationPath, { role: 'administrator' }); expect(initial.status).toBe(200);
    const team = initial.body.team as { defaultPitchPlaces: number; defaultHalfDurationMs: number };
    const renamedTeam = await client.json(configurationPath, { role: 'administrator', body: { command: { id: randomUUID(), expectedRevision: initial.body.revision, type: 'team.updated', name: 'Roma Academy U10', ageGroup: 'U10', defaultPitchPlaces: team.defaultPitchPlaces, defaultHalfDurationMs: team.defaultHalfDurationMs, logo: null } } });
    expect(renamedTeam.status).toBe(200);
    const renamedClub = await client.json(configurationPath, { role: 'administrator', body: { command: { id: randomUUID(), expectedRevision: renamedTeam.body.revision, type: 'club.updated', name: 'Richmond Athletic', logo: null } } });
    expect(renamedClub.status).toBe(200);
    expect((await client.json(path, viewer)).body).toMatchObject({ status: 'failed', failureCode: 'EXPORT_SOURCE_CHANGED' });
    expect((await client.json(path + '/download', viewer)).status).toBe(409);
    const fresh = await client.json('/v1/exports', { ...viewer, body }); expect(fresh.status).toBe(202);
    expect(await runDueReportExports(client.worker, client.options)).toMatchObject({ completed: 1 });
    const current = await client.call(`/v1/exports/${fresh.body.id}/download`, viewer); expect(current.status).toBe(200);
    const renamedText = pdfText(await PDFDocument.load(await current.arrayBuffer()));
    expect(renamedText).toContain('Team: Roma Academy U10'); expect(renamedText).not.toContain('U10 U10');
    expect(renamedText).toContain('Club: Richmond Athletic'); expect(renamedText).toContain('Season: 2026/27');
    expect(renamedText).not.toContain('synthetic-player-02'); expect(renamedText).not.toContain('Player 2');
  });
  it('rejects illegal kind/role and stale review revisions and fails closed across private-key rotation', async () => {
    const client = await start(kind), body = { ...scope, kind: 'team_participation', format: 'csv' };
    expect((await client.json('/v1/exports', { body, token: 'synthetic-account-player-01', role: 'player' })).status).toBe(404);
    expect((await client.json('/v1/exports', { body: { ...body, kind: 'attendance' }, token: 'synthetic-spectator', role: 'spectator' })).status).toBe(404);
    expect((await client.json('/v1/exports', { body: { ...body, format: 'json' } })).status).toBe(400);
    expect((await client.json('/v1/exports', { body, revision: '17' })).status).toBe(400);
    expect((await client.json('/v1/exports', { body, revision: '"999"' })).status).toBe(409);
    const first = await client.json('/v1/exports', { body }); expect(first.status).toBe(202);
    expect(await runDueReportExports(client.worker, { ...client.options, encryptionKey: randomBytes(32) })).toMatchObject({ failed: 1 });
    expect((await client.json(`/v1/exports/${first.body.id}`)).body).toMatchObject({ status: 'failed', failureCode: 'EXPORT_KEY_CHANGED' });
  });
  it('separates selected-role receipts, generates manager attendance without minutes and audits successful downloads', async () => {
    const client = await start(kind), body = { ...scope, kind: 'attendance', format: 'csv' }, key=randomUUID();
    const first=await client.json('/v1/exports',{body,key}), selected=await client.json('/v1/exports',{body,key,role:'manager'});
    expect(first.status).toBe(202);expect(selected.status).toBe(202);expect(selected.body.id).not.toBe(first.body.id);
    expect((await client.json('/v1/exports',{body:{...body,format:['pdf']}})).status).toBe(400);
    expect(await runDueReportExports(client.worker,client.options)).toMatchObject({completed:2});
    const response=await client.call(`/v1/exports/${selected.body.id}/download`,{role:'manager'});expect(response.status).toBe(200);
    const csv=await response.text();expect(csv).toContain('actualAttendance');expect(csv).toContain('availabilityResponse');expect(csv).not.toContain('playingMs');expect(csv).not.toContain('goalkeeperMs');
    const audit=client.owner instanceof PostgresStore?await client.owner.one("SELECT action,object_id,team_id,season_id FROM audit WHERE action='export.download' AND object_id=$1",[selected.body.id]):client.owner.database.prepare("SELECT action,object_id FROM audit WHERE action='export.download' AND object_id=?").get(selected.body.id as string);
    expect(audit).toMatchObject({action:'export.download',object_id:selected.body.id});
    if(client.owner instanceof PostgresStore)expect(audit).toMatchObject({team_id:scope.teamId,season_id:scope.seasonId});
  });
  it('clears expired bytes using the actual expiry and leaves startup usable when exports are unconfigured', async () => {
    const disabled = await start(kind, false), body = { ...scope, kind: 'season_results', format: 'csv' };
    expect((await disabled.json('/v1/me')).status).toBe(200); expect((await disabled.json('/v1/exports', { body })).status).toBe(503);
    const client = await start(kind, true, 1_000), first = await client.json('/v1/exports', { body }); expect(first.status).toBe(202);
    await new Promise(resolve => setTimeout(resolve, 1_100));
    expect((await client.json(`/v1/exports/${first.body.id}`)).body.status).toBe('expired');
    expect((await client.json(`/v1/exports/${first.body.id}/download`)).status).toBe(410);
    expect(await runDueReportExports(client.worker, client.options)).toMatchObject({ completed: 0 });
  });
});
