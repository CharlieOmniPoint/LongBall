/**
 * Bounded QL04 loopback proof: 50 distinct sessions, ten live games and a real
 * non-owner PostgreSQL API role. Source scripts/dev-env.sh and the existing
 * disposable .local/runtime/runtime.env, then run:
 * node --import tsx scripts/performance-review.mjs --run
 *
 * Creates only a new random database and three random roles; retains no token,
 * credential, raw response or connection URL in its report. Existing databases
 * and fixtures are not changed. This is not production capacity or device proof.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, totalmem, freemem, platform, release } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createPostgresApi } from '../apps/api/src/postgres-server.ts';
import { PostgresStore } from '../apps/api/src/postgres-store.ts';
import { PgMediaService } from '../apps/api/src/postgres-media.ts';
import { PostgresActivationService } from '../apps/api/src/postgres-activation.ts';
import { applyRuntimeGrants } from '../apps/api/src/runtime-grants.ts';
import { createCommunityState } from '../packages/application/src/community.ts';
import { effectiveEventTime, WIRE_CONTRACT_VERSION as EVENT_CONTRACT_VERSION } from '../packages/application/src/sync.ts';
import { createMatch, reduceMatch, ENGINE_VERSION } from '../packages/domain/src/index.ts';
import { romaFixture } from '../packages/testing/src/index.ts';

const { Pool } = createRequire(resolve('apps/api/package.json'))('pg');
if (!process.argv.includes('--run')) throw new Error('Use --run for the explicitly disposable performance proof.');
const selector = process.env.LONGBALL_POSTGRES_TEST_URL;
assert(selector, 'Source the existing disposable PostgreSQL runtime selector first.');
const configured = new URL(selector);
assert(['postgres:', 'postgresql:'].includes(configured.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(configured.hostname) && configured.pathname === '/longball_runtime_test' && !configured.password, 'Only the existing password-free disposable loopback test selector is accepted.');
assert(process.env.NODE_ENV !== 'production', 'The disposable performance proof cannot run as production.');
const output = resolve(process.env.LONGBALL_PERFORMANCE_OUTPUT ?? `.local/performance-review/${Date.now()}`);
assert(output.startsWith(`${resolve('.local/performance-review')}/`), 'Use a fresh private performance-review output directory.');
await mkdir(output, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(tmpdir(), 'longball-performance-'));
const suffix = randomUUID().replaceAll('-', '');
const database = `lb_perf_${suffix}`;
const roles = { owner: `lb_perf_owner_${suffix}`, apiRole: `lb_perf_api_${suffix}`, workerRole: `lb_perf_worker_${suffix}` };
const issuer = 'urn:longball:disposable-performance';
const startedAt = new Date().toISOString();
const started = performance.now();
const samples = { reads: [], commands: [], warmup: [], fixtureVerifier: [] };
const observedStatuses = {};
const failures = [];
let active = 0, peakActive = 0, api, owner, databaseCreated = false;
const rolesCreated = [];
const adminUrl = new URL(configured); adminUrl.pathname = '/postgres';
const admin = new Pool({ connectionString: adminUrl.href, max: 2 });
const urlFor = role => { const value = new URL(configured); value.pathname = `/${database}`; value.username = role; value.password = ''; return value.href; };
const distribution = values => {
  if (!values.length) return { count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = q => Number(sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)].toFixed(3));
  return { count: values.length, minMs: at(0), medianMs: at(0.5), p95Ms: at(0.95), maxMs: at(1) };
};
async function fingerprint() {
  const files = [];
  async function walk(path) { for (const entry of await readdir(path, { withFileTypes: true })) { const file = join(path, entry.name); if (entry.isDirectory()) await walk(file); else if (/\.(?:ts|json|sql)$/.test(file) && !file.includes('.test.')) files.push(file); } }
  for (const path of ['apps/api/src', 'apps/api/migrations', 'packages/application/src', 'packages/domain/src', 'packages/testing/src']) await walk(path);
  files.push('fixtures/roma.synthetic.json', 'package.json', 'pnpm-lock.yaml', 'scripts/performance-review.mjs');
  const result = [];
  for (const file of files.sort()) result.push({ path: file, sha256: createHash('sha256').update(await readFile(file)).digest('hex') });
  return { sha256: createHash('sha256').update(JSON.stringify(result)).digest('hex'), files: result };
}
const source = await fingerprint();
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const games = Array.from({ length: 10 }, (_, i) => {
  const number = String(i + 1).padStart(2, '0');
  const teamId = `perf-team-${number}`, seasonId = `perf-season-${number}`, matchId = `perf-live-${number}`;
  const sessions = Array.from({ length: 5 }, (_, j) => ({ accountId: `perf-account-${number}-${j}`, token: randomUUID(), role: j === 0 ? 'manager' : 'spectator', teamId, seasonId, matchId }));
  const players = romaFixture.players.map(player => ({ ...player, id: `${teamId}-${player.id}` }));
  const selectedPlayerIds = players.filter(player => player.available).map(player => player.id);
  const positions = ['GK', 'CB', 'CB', 'CM', 'LW', 'RW', 'ST'];
  const slots = positions.map((position, index) => ({ slotId: `slot-${index}`, position }));
  const config = { matchId, players, selectedPlayerIds, pitchPlaces: 7, plannedHalfDurationMs: 1_500_000, fixedKeeperId: players[0].id, slots, fixture: { opponent: `Demo visitors ${number}`, playedDate: '2026-10-21', kickoff: null, homeAway: 'home', teamId, seasonId, teamName: `Roma review ${number}`, clubName: 'Richmond Rovers demo' } };
  return { teamId, seasonId, matchId, config, sessions, manager: sessions[0], deviceId: `perf-device-${number}`, state: createMatch(config), sequence: 0, previousEventId: null, controller: null };
});
const sessions = games.flatMap(game => game.sessions);
assert.equal(new Set(sessions.map(session => session.accountId)).size, 50);
const byToken = new Map(sessions.map(session => [session.token, session]));
let requestBase;
async function call(session, path, body, group, controller) {
  const headers = { Authorization: `Bearer ${session.token}`, 'X-Longball-Role': session.role };
  if (body !== undefined) Object.assign(headers, { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), 'X-Api-Contract-Version': EVENT_CONTRACT_VERSION });
  if (controller) headers['X-Controller-Token'] = controller;
  active++; peakActive = Math.max(peakActive, active);
  const begins = performance.now();
  try {
    const response = await fetch(`${requestBase}${path}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const value = await response.json();
    const duration = performance.now() - begins;
    observedStatuses[response.status] = (observedStatuses[response.status] ?? 0) + 1;
    if (group) samples[group].push(duration);
    if (response.status !== 200) { failures.push({ phase: group ?? 'bootstrap', status: response.status, code: /^[A-Z0-9_]+$/.test(value.code ?? '') ? value.code : 'REQUEST_REFUSED' }); throw new Error('PERFORMANCE_HTTP_REFUSED'); }
    return value;
  } finally { active--; }
}
const monotonicStart = performance.now();
function envelope(game, details) {
  const id = randomUUID();
  const monotonicMs = performance.now() - monotonicStart;
  const command = { id, sample: { monotonicMs, sessionId: `performance-${game.matchId}`, wallTimeMs: Date.now() }, ...details };
  const next = reduceMatch(game.state, command);
  const effective = effectiveEventTime(game.state, next, command);
  const event = { contractVersion: EVENT_CONTRACT_VERSION, schemaVersion: 1, engineVersion: ENGINE_VERSION, eventId: id, matchId: game.matchId, deviceId: game.deviceId, controllerEpoch: 1, clientSequence: ++game.sequence, previousEventId: game.previousEventId, baseRevision: game.state.revision, effectiveHalf: effective.half, halfElapsedMs: effective.halfElapsedMs, matchElapsedMs: effective.matchElapsedMs, effectiveAt: null, recordedAt: new Date().toISOString(), timeQuality: 'reviewRequired', clockEvidence: { monotonicMs, anchorId: `untrusted-${game.matchId}`, continuityId: `performance-${game.matchId}` }, command };
  game.previousEventId = id; game.state = next;
  return event;
}
let report;
try {
  for (const role of Object.values(roles)) { await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`); rolesCreated.push(role); }
  await admin.query(`CREATE DATABASE "${database}"`); databaseCreated = true;
  await admin.query(`REVOKE ALL ON DATABASE "${database}" FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE "${database}" TO "${roles.owner}","${roles.apiRole}","${roles.workerRole}"`);
  const setup = new Pool({ connectionString: new URL(`/${database}`, configured).href, max: 1 });
  try { await setup.query(`CREATE SCHEMA longball AUTHORIZATION "${roles.owner}"`); await setup.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC'); } finally { await setup.end(); }
  owner = await PostgresStore.open(urlFor(roles.owner));
  await PgMediaService.open({ directory, database: owner.db });
  await new PostgresActivationService({ store: owner }).initialize();
  await owner.transaction(async () => {
    await owner.execute('INSERT INTO clubs(id,name) VALUES($1,$2)', ['perf-club', 'Richmond Rovers demo']);
    for (const game of games) {
      await owner.execute("INSERT INTO teams(id,name,club_id,scope_status) VALUES($1,$2,$3,'resolved')", [game.teamId, game.config.fixture.teamName, 'perf-club']);
      await owner.execute('INSERT INTO team_seasons(club_id,team_id,season_id,label,start_year,start_date,end_date) VALUES($1,$2,$3,$4,$5,$6,$7)', ['perf-club', game.teamId, game.seasonId, '2026/27', 2026, '2026-09-01', '2027-08-31']);
      const community = { ...createCommunityState(), accounts: [], memberships: [], seasons: [{ id: game.seasonId, teamId: game.teamId, label: '2026/27', teamLabel: game.config.fixture.teamName, accessEndsAtMs: Date.now() + 3_600_000 }], invitations: [], grants: [], matches: [], ballots: [], awards: [], photos: [], concerns: [], hiddenUploaders: [], preferences: {}, privacyRequests: [], audit: [], appliedCommands: {} };
      for (const session of game.sessions) {
        await owner.execute('INSERT INTO accounts(id,issuer,subject,classification,adult_verified,strong_auth_enrolled) VALUES($1,$2,$1,$3,$4,$4)', [session.accountId, issuer, 'adult_individual', session.role === 'manager' ? 1 : 0]);
        await owner.execute('INSERT INTO memberships(account_id,team_id,season_id,role) VALUES($1,$2,$3,$4)', [session.accountId, game.teamId, game.seasonId, session.role]);
        community.accounts.push({ id: session.accountId, label: 'Demo reviewer', classification: session.role === 'manager' ? 'adult_individual' : 'spectator', adultVerified: session.role === 'manager' });
        if (session.role === 'manager') community.memberships.push({ accountId: session.accountId, teamId: game.teamId, seasonId: game.seasonId, role: 'manager', active: true });
        else community.grants.push({ id: `grant-${session.accountId}`, invitationId: `consumed-${session.accountId}`, accountId: session.accountId, teamId: game.teamId, seasonId: game.seasonId, startsAtMs: Date.now() - 60_000, expiresAtMs: Date.now() + 3_600_000, revokedAtMs: null });
      }
      await owner.saveDocument(game.teamId, game.seasonId, 'community', community);
      await owner.insertMatch(game.config, game.teamId, game.seasonId);
      await owner.execute('UPDATE matches SET sharing_policy_json=$1 WHERE id=$2', [JSON.stringify({ version: 'disposable-performance-only-v1', approvedBy: 'generated-benchmark-fixture', approvedAt: Date.now(), shareScores: true, shareDerivedResults: true }), game.matchId]);
    }
  });
  await applyRuntimeGrants(owner.db, roles);
  const postgresVersion = await owner.one('SELECT version() AS version');
  const protectedTables = await owner.one("SELECT count(*)::integer AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='longball' AND c.relrowsecurity");
  await owner.close(); owner = null;
  api = await createPostgresApi({ connectionString: urlFor(roles.apiRole), migrationMode: 'verify', seedSynthetic: false, databasePath: join(directory, 'unused.sqlite'), mediaDirectory: directory, syntheticAuth: false, verifyIdentity: async token => {
    const begins = performance.now(), session = byToken.get(token);
    if (!session) throw new Error('DISPOSABLE_SESSION_REQUIRED');
    const identity = { issuer, subject: session.accountId, strongAuth: session.role === 'manager', authenticatedAt: Date.now() };
    samples.fixtureVerifier.push(performance.now() - begins);
    return identity;
  } });
  await api.store.assertRuntimeRole('api');
  const role = await api.store.one('SELECT r.rolsuper,r.rolbypassrls,longball.runtime_purpose() AS purpose FROM pg_roles r WHERE rolname=current_user');
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false, purpose: 'api' });
  assert.equal((await api.store.many('SELECT * FROM accounts')).length, 0, 'Context-free restricted reads must stay empty.');
  await new Promise(resolveListen => api.server.listen(0, '127.0.0.1', resolveListen));
  requestBase = `http://127.0.0.1:${api.server.address().port}`;
  for (const game of games) {
    const grant = await call(game.manager, `/v1/matches/${game.matchId}/controller`, { deviceId: game.deviceId }); game.controller = grant.controllerToken;
    const events = game.config.selectedPlayerIds.map(playerId => envelope(game, { type: 'attendance.recorded', playerId, status: 'present' }));
    events.push(envelope(game, { type: 'lineup.staged', lineup: game.config.slots.map((slot, index) => ({ ...slot, playerId: game.config.selectedPlayerIds[index] })) }), envelope(game, { type: 'half.started' }));
    const result = await call(game.manager, `/v1/matches/${game.matchId}/events`, { events }, undefined, game.controller);
    assert.equal(result.revision, game.state.revision); assert(result.results.every(item => item.disposition === 'accepted'));
  }
  for (const game of games) assert.equal((await call(game.manager, `/v1/matches/${game.matchId}`)).state.status, 'first_half_running');
  await Promise.all(sessions.map(session => call(session, `/v1/matches/${session.matchId}`, undefined, 'warmup')));
  const measuredStart = performance.now();
  for (let round = 0; round < 20; round++) {
    const results = await Promise.allSettled(sessions.map(async session => {
      const game = games.find(item => item.matchId === session.matchId);
      if (session.role === 'manager') {
        const event = envelope(game, { type: round % 2 === 0 ? 'half.paused' : 'half.resumed' });
        const result = await call(session, `/v1/matches/${game.matchId}/events`, { events: [event] }, 'commands', game.controller);
        assert.equal(result.revision, game.state.revision); assert.equal(result.results[0].disposition, 'accepted');
      } else {
        const value = await call(session, `/v1/matches/${game.matchId}`, undefined, 'reads');
        assert.equal(value.audience, 'spectator'); assert.equal(value.sharingRestricted, false); assert(value.score);
        assert.equal(Object.hasOwn(value, 'state'), false, 'Viewer response must not contain private manager state.');
      }
    }));
    if (results.some(result => result.status === 'rejected')) throw new Error('PERFORMANCE_COHORT_FAILED');
  }
  const measuredMs = performance.now() - measuredStart;
  const after = await fingerprint(); assert.equal(after.sha256, source.sha256, 'Runtime source changed during measurement.');
  const reads = distribution(samples.reads), commands = distribution(samples.commands);
  report = { status: failures.length === 0 && reads.p95Ms < 500 && commands.p95Ms < 500 ? 'passed-local-ql04-scope' : 'target-not-met', checkedAt: new Date().toISOString(), startedAt, sourceCommit: head, sourceFingerprint: source.sha256, sourceUnchangedDuringRun: true, execution: 'Actual HTTP on loopback, real PostgreSQL, non-owner non-bypass runtime role, fixture identity verifier', environment: { platform: platform(), release: release(), node: process.version, cpuModel: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), freeMemoryBytesAtReport: freemem(), postgres: postgresVersion.version, foregroundDevice: false, hostedProductionImage: false }, dataset: { teams: 10, games: 10, allGamesStartedOverCanonicalHttp: true, allGamesRemainUnfinished: true, rosterPerGame: 13, selectedPerGame: games[0].config.selectedPlayerIds.length, managers: 10, spectators: 40, distinctAccounts: 50, concurrentSessionSlots: 50, measuredCohorts: 20, peakInFlight: peakActive, requests: samples.reads.length + samples.commands.length, readCommandMix: '40 accepted-summary reads and ten canonical pause/resume mutations per cohort' }, restrictedDatabase: { runtimeRole: role, protectedTables: protectedTables.count, contextFreeAccountsDenied: true, schemaOwnerClosedBeforeHttp: true, existingDataMutated: false, disposableRandomDatabaseOnly: true }, timing: { measurementMs: Number(measuredMs.toFixed(3)), totalElapsedMs: Number((performance.now() - started).toFixed(3)), reads, commands, warmupExcluded: distribution(samples.warmup), fixtureIdentityVerification: distribution(samples.fixtureVerifier), serverTargetMs: 500, readsP95UnderTarget: reads.p95Ms < 500, commandsP95UnderTarget: commands.p95Ms < 500, authenticationProviderMeasured: false, latencyDefinition: 'Client-observed loopback HTTP through response JSON, including local transit and fixture verification; not pure server instrumentation.' }, httpStatuses: observedStatuses, failures, limits: ['Local shared execution host; no production deployment, remote network or capacity/SLA proof.', 'Explicit in-memory fixture session verifier measured separately; no OIDC login, JWT signature/JWKS or provider performance claim.', 'Warmup precedes measured cohorts; nearest-rank p95 is reported for 800 reads and 200 commands.', 'Clock evidence is review-required session evidence. No native clock continuity, device durability, background behavior or phone responsiveness claim.', 'QL03 requires supported lower-end Android hardware; QL02, QL07 and QL11 remain physical-device gates.', 'QL09 offsite recovery objectives and QL10 monthly availability require operating evidence, not this bounded rehearsal.'] };
  await writeFile(join(output, 'source-manifest.json'), JSON.stringify(source, null, 2) + '\n', { mode: 0o600 });
} catch (error) {
  report = { status: 'failed', checkedAt: new Date().toISOString(), sourceCommit: head, sourceFingerprint: source.sha256, code: /^[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : /^[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'PERFORMANCE_REVIEW_FAILED', observedStatuses, measurements: { reads: distribution(samples.reads), commands: distribution(samples.commands) }, failures, limits: ['Failed run; no capacity target is established.'] };
  process.exitCode = 1;
} finally {
  if (api) { api.server.closeAllConnections(); await api.close(); }
  if (owner) await owner.close();
  if (databaseCreated) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  for (const role of rolesCreated.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
  await rm(directory, { recursive: true, force: true });
  report.cleanup = { disposableDatabaseDropped: databaseCreated, createdRolesDropped: rolesCreated.length, temporaryMediaRemoved: true };
  await writeFile(join(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, output, timing: report.timing, cleanup: report.cleanup, code: report.code }));
  if (report.status !== 'passed-local-ql04-scope') process.exitCode = 1;
}
