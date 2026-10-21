import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, join, sep } from 'node:path';
import { AccessError, assertAdultAuthority, assertCanManageTeam, assertTeamRole, type Principal } from '../../../packages/application/src/access';
import type { PreparationCommand } from '../../../packages/application/src/preparation';
import { applyCommunityCommand, parseCommunityCommand, type CommunityCommand } from '../../../packages/application/src/community';
import type { RecordsCommand } from '../../../packages/application/src/records';
import { createOidcVerifier, type VerifiedIdentity } from './oidc';
import { DevelopmentStore, EVENT_CONTRACT_VERSION, SYNTHETIC_IDS, type OwnPreparationCommand } from './store';
import eventContract from '../contracts/events-v1.1.schema.json' with { type: 'json' };
import { DevelopmentMediaService, type MediaPrepareInput, type MediaScanner } from './media';
import { DevelopmentActivationService, type ActivationPolicy, type ActivationProvider } from './activation';

export interface ApiOptions {
  databasePath: string;
  syntheticAuth?: boolean;
  verifyIdentity?: (token: string) => Promise<VerifiedIdentity>;
  oidc?: { issuer: string; audience: string; jwksUri: string; mfaAcrValues?: string[] };
  now?: () => number;
  allowedOrigins?: string[];
  /** Explicit browser export only. Unknown routes do not fall back to index.html. */
  staticDirectory?: string;
  browserConnectOrigins?: string[];
  mediaDirectory?: string;
  mediaScanner?: MediaScanner;
  /** Isolated fictional provider experiment only; the CLI never configures this implicitly. */
  activationProvider?: ActivationProvider;
  activationPolicy?: ActivationPolicy;
}
const header = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name]; return typeof value === 'string' ? value : undefined;
};
const loopback = (address: string | undefined): boolean => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
function syntheticIdentity(token: string, now: number): VerifiedIdentity {
  const aliases: Record<string, string> = {
    'synthetic-manager-1': 'synthetic-account-manager', 'synthetic-account-manager-1': 'synthetic-account-manager',
    'synthetic-manager-2': 'synthetic-account-manager-2', 'synthetic-manager-3': 'synthetic-account-manager-3',
    'synthetic-manager-4': 'synthetic-account-manager-4', 'synthetic-manager-5': 'synthetic-account-manager-5',
    'synthetic-admin': 'synthetic-account-admin', 'synthetic-spectator': 'synthetic-account-spectator',
    'synthetic-other-manager': 'synthetic-account-other-manager',
  };
  const accountId = aliases[token] ?? token;
  if (!/^synthetic-account-(?:manager(?:-[2-5])?|admin|player-(?:0[1-9]|1[0-3])|spectator|invitee|other-manager)$/.test(accountId)) throw new AccessError('INVALID_SESSION', 401, 'A valid authenticated session is required.');
  return { issuer: 'urn:longball:synthetic', subject: accountId, strongAuth: /manager|admin/.test(accountId), authenticatedAt: now };
}
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!header(request, 'content-type')?.startsWith('application/json')) throw new AccessError('JSON_REQUIRED', 415, 'Use application/json for this command.');
  let length = 0; const chunks: Buffer[] = [];
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
    length += chunk.length;
    if (length > 256 * 1024) throw new AccessError('REQUEST_TOO_LARGE', 413, 'The request exceeds the 256 KiB limit.');
    chunks.push(chunk);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new AccessError('INVALID_JSON', 400, 'A JSON object is required.'); }
}
export function createApi(options: ApiOptions) {
  if ((options.activationProvider || options.activationPolicy) && !options.syntheticAuth) throw new Error('The fictional activation experiment requires isolated synthetic authentication.');
  const now = options.now ?? Date.now;
  const store = new DevelopmentStore(options.databasePath, now);
  if (options.syntheticAuth) store.seedSynthetic();
  const verifyIdentity = options.verifyIdentity ?? (options.oidc ? createOidcVerifier({ ...options.oidc, now }) : null);
  const media = new DevelopmentMediaService({ directory: options.mediaDirectory ?? join(dirname(options.databasePath), 'media'), database: store.database, scanner: options.mediaScanner, now });
  const activation = new DevelopmentActivationService({ store, provider: options.activationProvider, policy: options.activationPolicy });
  const windows = new Map<string, { begins: number; ordinary: number; mutation: number }>();
  const staticRoot = options.staticDirectory ? realpathSync(options.staticDirectory) : null;
  const configuredConnect = [...(options.oidc ? [options.oidc.issuer, options.oidc.jwksUri] : []), ...(options.browserConnectOrigins ?? [])].map(value => {
    const url = new URL(value);
    if (url.protocol !== 'https:') throw new Error('Additional browser connect origins must use explicitly configured HTTPS.');
    return url.origin;
  });
  const connectPolicy = [...new Set(configuredConnect)].join(' ');
  const response = (reply: ServerResponse, status: number, value: unknown, requestId: string) => {
    reply.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Request-Id': requestId });
    reply.end(JSON.stringify(value));
  };
  const server = createServer(async (request, reply) => {
    const rawRequestId = header(request, 'x-request-id');
    const requestId = rawRequestId && /^[a-zA-Z0-9_-]{1,100}$/.test(rawRequestId) ? rawRequestId : randomUUID();
    try {
      const origin = header(request, 'origin');
      if (origin) {
        let sameOrigin = false;
        try { const parsed = new URL(origin); sameOrigin = staticRoot !== null && ['http:', 'https:'].includes(parsed.protocol) && parsed.host === header(request, 'host'); } catch { /* Reject malformed Origin below. */ }
        if (!sameOrigin && !(options.allowedOrigins ?? ['http://localhost:8081', 'http://localhost:4173', 'http://127.0.0.1:4173']).includes(origin)) throw new AccessError('ORIGIN_DENIED', 403, 'This origin is not configured for API access.');
        reply.setHeader('Access-Control-Allow-Origin', origin); reply.setHeader('Vary', 'Origin');
        reply.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, X-Controller-Token, X-Media-Upload-Token, X-Longball-Role, X-Api-Contract-Version, If-Match, X-Request-Id');
        reply.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
      }
      if (request.method === 'OPTIONS') { reply.writeHead(204); reply.end(); return; }
      const url = new URL(request.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (url.pathname === '/health') { response(reply, 200, { status: 'ok', service: 'longball-development-api', contractVersion: EVENT_CONTRACT_VERSION, syntheticOnly: true }, requestId); return; }
      if (staticRoot && parts[0] !== 'v1' && ['GET', 'HEAD'].includes(request.method ?? '')) {
        if (parts.some(part => part.startsWith('.') || part.includes('/') || part.includes('\\'))) throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
        const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2' };
        const path = join(staticRoot, ...(parts.length ? parts : ['index.html']));
        let resolved: string;
        try { resolved = realpathSync(path); } catch { throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.'); }
        if (!resolved.startsWith(`${staticRoot}${sep}`) || !statSync(resolved).isFile() || !contentTypes[extname(resolved)]) throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
        reply.writeHead(200, { 'Content-Type': contentTypes[extname(resolved)], 'Cache-Control': extname(resolved) === '.html' ? 'no-store' : 'public, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ${connectPolicy}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`, 'X-Request-Id': requestId });
        reply.end(request.method === 'HEAD' ? undefined : readFileSync(resolved)); return;
      }
      if (options.syntheticAuth && !loopback(request.socket.remoteAddress)) throw new AccessError('SYNTHETIC_LOCAL_ONLY', 403, 'Synthetic authentication is restricted to loopback clients.');
      const requireContract = () => {
        if (header(request, 'x-api-contract-version') !== EVENT_CONTRACT_VERSION) throw new AccessError('CONTRACT_VERSION_REQUIRED', 409, `Use X-Api-Contract-Version: ${EVENT_CONTRACT_VERSION}.`);
        const key = header(request, 'idempotency-key');
        if (!key || !/^[A-Za-z0-9_-]{8,150}$/.test(key)) throw new AccessError('IDEMPOTENCY_KEY_REQUIRED', 400, 'Use a stable Idempotency-Key for mutations.');
        return key;
      };
      const activationFields = (value: Record<string, unknown>, names: string[]) => {
        if (Object.keys(value).some(key => !names.includes(key)) || names.some(key => !(key in value))) throw new AccessError('INVALID_REQUEST', 400, 'Use the documented activation request fields.');
      };
      if (request.method === 'POST' && ['/v1/activation/redeem', '/v1/activation/complete'].includes(url.pathname)) {
        // These bearer-capability endpoints create no application session. Secrets never enter generic receipts.
        const rateKey = `activation:${request.socket.remoteAddress ?? 'unknown'}`;
        const prior = windows.get(rateKey);
        const limit = prior && now() - prior.begins < 60_000 ? prior : { begins: now(), ordinary: 0, mutation: 0 };
        limit.mutation += 1; windows.set(rateKey, limit);
        if (limit.mutation > 20) { reply.setHeader('Retry-After', '60'); throw new AccessError('RATE_LIMIT', 429, 'Please retry after the current request window.'); }
        const key = requireContract(); const input = await readJson(request);
        let result: unknown;
        if (url.pathname === '/v1/activation/redeem') {
          activationFields(input, ['token']);
          result = await activation.redeemActivation({ token: input.token as string, requestId: key });
        } else {
          activationFields(input, ['activationId', 'completionProof']);
          result = await activation.completeActivation({ activationId: input.activationId as string, completionProof: input.completionProof as string });
        }
        response(reply, 200, result, requestId); return;
      }
      if (!options.syntheticAuth && !verifyIdentity) throw new AccessError('IDENTITY_NOT_CONFIGURED', 503, 'Configure the trusted OIDC issuer, audience and JWKS verifier before accepting requests.');
      const authorization = header(request, 'authorization');
      if (!authorization?.startsWith('Bearer ') || authorization.length > 17_000) throw new AccessError('INVALID_SESSION', 401, 'A valid authenticated session is required.');
      const token = authorization.slice(7);
      const identity = options.syntheticAuth ? syntheticIdentity(token, now()) : await verifyIdentity!(token);
      const principal = store.principal(identity);
      const rate = windows.get(principal.accountId);
      const count = rate && now() - rate.begins < 60_000 ? rate : { begins: now(), ordinary: 0, mutation: 0 };
      count.ordinary += 1; if (request.method !== 'GET') count.mutation += 1;
      windows.set(principal.accountId, count);
      if (count.ordinary > 120 || count.mutation > 60) { reply.setHeader('Retry-After', '60'); throw new AccessError('RATE_LIMIT', 429, 'Please retry after the current request window.'); }
      const role = header(request, 'x-longball-role');
      const controllerToken = header(request, 'x-controller-token');
      const seasonId = url.searchParams.get('seasonId') ?? SYNTHETIC_IDS.seasonId;
      const scopedOperation = (operation: string) => parts[1] === 'teams' ? JSON.stringify([operation, parts[2], seasonId, role ?? 'default']) : operation;
      const body = request.method === 'POST' ? await readJson(request) : null;
      if (body && parts[1] === 'teams' && parts[3] === 'community') {
        if (body.command && typeof body.command === 'object' && 'type' in body.command && body.command.type === 'match.registered') throw new AccessError('POLICY_APPROVAL_REQUIRED', 503, 'Connected award/sharing context requires accepted match evidence, verified finish-time anchors and independently approved policy.');
        body.command = parseCommunityCommand(body.command);
      }
      const mutate = <T>(operation: string, work: () => T): T => {
        requireContract();
        // Re-check current permissions even when an old idempotency result exists.
        if (parts[1] === 'matches' && parts[2]) store.managerMatch(principal, parts[2]);
        if (parts[1] === 'teams' && parts[2]) {
          if (parts[3] === 'community') store.communityActor(principal, parts[2], seasonId, role, (body!.command as CommunityCommand | undefined)?.type === 'invite.accepted');
          else if (parts[3] === 'preparation' && parts[4] === 'own') assertTeamRole(principal, store.memberships(), parts[2], seasonId, ['player'], now());
          else if (parts[3] === 'managers' || parts[3] === 'preparation' && (body!.command as PreparationCommand | undefined)?.type === 'club.updated') {
            assertTeamRole(principal, store.memberships(), parts[2], seasonId, ['administrator'], now()); assertAdultAuthority(principal, true, now());
          } else assertCanManageTeam(principal, store.memberships(), parts[2], seasonId, now());
        }
        return store.idempotent(principal, scopedOperation(operation), header(request, 'idempotency-key') ?? '', body, work);
      };
      let result: unknown;
      if (request.method === 'GET' && url.pathname === '/v1/me') result = { accountId: principal.accountId, identityClassification: principal.identityClassification, principal, memberships: store.myMemberships(principal), serverTime: new Date(now()).toISOString(), syntheticOnly: true };
      else if (request.method === 'GET' && url.pathname === '/v1/contracts/events') result = eventContract;
      else if (request.method === 'GET' && url.pathname === '/v1/privacy/requests') result = { items: store.privacyRequests(principal) };
      else if (request.method === 'POST' && url.pathname === '/v1/privacy/requests') result = mutate(url.pathname, () => store.privacyRequest(principal, body!.kind as 'export' | 'delete_account' | 'leave_team', typeof body!.policyVersion === 'string' ? body!.policyVersion : null));
      else if (request.method === 'POST' && ['/v1/accounts/link-requests', '/v1/accounts/recovery-requests'].includes(url.pathname)) {
        const key = requireContract();
        if (url.pathname === '/v1/accounts/link-requests') {
          activationFields(body!, ['teamId', 'seasonId', 'playerId', 'existingAccountId']);
          result = activation.requestExistingAccountLink(principal, { ...body, requestId: key } as Parameters<typeof activation.requestExistingAccountLink>[1]);
        } else {
          activationFields(body!, ['teamId', 'seasonId', 'accountId']);
          result = activation.requestRecovery(principal, { ...body, requestId: key } as Parameters<typeof activation.requestRecovery>[1]);
        }
      }
      else if (parts[0] === 'v1' && parts[1] === 'matches' && parts[2]) {
        const matchId = parts[2];
        if (request.method === 'GET' && parts.length === 3) result = store.matchDto(principal, matchId);
        else if (request.method === 'GET' && parts[3] === 'download') result = store.download(principal, matchId, url.searchParams.get('deviceId') ?? '');
        else if (request.method === 'GET' && parts[3] === 'quarantine') result = { items: store.quarantine(principal, matchId) };
        else if (request.method === 'POST' && parts[3] === 'controller') result = mutate(url.pathname, () => store.acquire(principal, matchId, String(body!.deviceId ?? '')));
        else if (request.method === 'POST' && parts[3] === 'events') result = mutate(url.pathname, () => store.upload(principal, matchId, controllerToken, body!.events as unknown[]));
        else if (request.method === 'POST' && parts[3] === 'handover' && !parts[4]) result = mutate(url.pathname, () => store.offerHandover(principal, matchId, controllerToken, String(body!.toAccountId ?? ''), String(body!.toDeviceId ?? ''), Number(body!.baseRevision)));
        else if (request.method === 'POST' && parts[3] === 'handover' && parts[4] && parts[5] === 'accept') result = mutate(url.pathname, () => store.acceptHandover(principal, matchId, parts[4], String(body!.deviceId ?? '')));
        else if (request.method === 'POST' && parts[3] === 'recover') result = mutate(url.pathname, () => {
          if (body!.confirmUnsynchronisedRisk !== true) throw new AccessError('RECOVERY_CONFIRMATION_REQUIRED', 422, 'Confirm the possibility of unsynchronised old-device records before recovery.');
          return store.recover(principal, matchId, String(body!.deviceId ?? ''), String(body!.reason ?? ''));
        });
        else throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
      } else if (parts[0] === 'v1' && parts[1] === 'teams' && parts[2]) {
        const teamId = parts[2];
        if (request.method === 'POST' && parts[3] === 'activation' && parts.length === 5 && ['pending-child', 'issue'].includes(parts[4])) {
          const requestId = requireContract();
          assertCanManageTeam(principal, store.memberships(), teamId, seasonId, now());
          if (parts[4] === 'pending-child') {
            activationFields(body!, ['playerId']);
            result = await activation.createPendingChild(principal, { requestId, teamId, seasonId, playerId: body!.playerId as string });
          } else {
            activationFields(body!, ['accountId']);
            result = await activation.issueActivation(principal, { requestId, teamId, seasonId, accountId: body!.accountId as string });
          }
        } else if (parts[3] === 'media') {
          const actor = store.communityActor(principal, teamId, seasonId, role);
          const community = () => store.communityState(teamId, seasonId);
          if (request.method === 'GET' && parts[4] === 'uploads' && !parts[5]) result = { items: media.listOwn(community(), actor) };
          else if (request.method === 'POST' && parts[4] === 'uploads' && parts[5] === 'prepare') {
            const key = requireContract();
            // The media manifest hashes/rotates the write token; never store it in generic response receipts.
            result = store.transaction(() => media.prepare(community(), actor, { ...body, requestId: key } as MediaPrepareInput));
          } else if (request.method === 'PUT' && parts[4] === 'uploads' && parts[5]) {
            requireContract();
            result = await media.upload(community(), actor, parts[5], header(request, 'x-media-upload-token') ?? '', request);
          } else if (request.method === 'POST' && parts[4] === 'uploads' && parts[5] && parts[6] === 'complete') {
            const key = requireContract();
            const processed = await media.complete(community(), actor, parts[5], header(request, 'x-media-upload-token') ?? '');
            result = store.idempotent(principal, scopedOperation(url.pathname), key, body, () => {
              const freshActor = store.communityActor(principal, teamId, seasonId, role);
              const next = applyCommunityCommand(community(), freshActor, processed.command, now());
              store.saveDocument(teamId, seasonId, 'community', next);
              media.link(parts[5], next);
              store.audit(principal, 'media.processed', processed.receipt.photoId, 'private_review_required');
              return processed.receipt;
            });
          } else if (request.method === 'GET' && parts[4] === 'photos' && parts[5] && parts[6]) {
            const mode = url.searchParams.get('mode') ?? 'gallery';
            if (!['gallery', 'own', 'review'].includes(mode) || !['display', 'thumbnail'].includes(parts[6])) throw new AccessError('NOT_FOUND', 404, 'The requested image is unavailable.');
            const rawRevision = url.searchParams.get('revision'); const revision = rawRevision === null ? undefined : Number(rawRevision);
            if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new AccessError('NOT_FOUND', 404, 'The requested image is unavailable.');
            const image = media.gateway(community(), actor, parts[5], parts[6] as 'display' | 'thumbnail', mode as 'gallery' | 'own' | 'review', revision);
            reply.writeHead(200, { ...image.headers, 'X-Request-Id': requestId }); reply.end(image.body); return;
          } else throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
        }
        else if (request.method === 'GET' && parts[3] === 'matches') result = { items: store.teamMatches(principal, teamId, seasonId), nextCursor: null, serverTime: new Date(now()).toISOString() };
        else if (request.method === 'POST' && parts[3] === 'managers') result = mutate(url.pathname, () => store.assignManager(principal, teamId, seasonId, String(body!.accountId ?? '')));
        else if (request.method === 'GET' && parts[3] === 'preparation' && parts[4] === 'own') result = store.ownPreparation(principal, teamId, seasonId);
        else if (request.method === 'POST' && parts[3] === 'preparation' && parts[4] === 'own') result = mutate(url.pathname, () => store.ownPreparationCommand(principal, teamId, seasonId, body!.command as OwnPreparationCommand));
        else if (request.method === 'GET' && parts[3] === 'preparation') result = store.preparation(principal, teamId, seasonId);
        else if (request.method === 'POST' && parts[3] === 'preparation') result = mutate(url.pathname, () => store.preparationCommand(principal, teamId, seasonId, body!.command as PreparationCommand));
        else if (request.method === 'GET' && parts[3] === 'community' && parts[4] === 'media' && parts[5]) result = store.media(principal, teamId, seasonId, parts[5], (url.searchParams.get('mode') ?? 'gallery') as 'gallery' | 'own' | 'review', role);
        else if (request.method === 'GET' && parts[3] === 'community') result = store.community(principal, teamId, seasonId, role);
        else if (request.method === 'POST' && parts[3] === 'community') {
          mutate(url.pathname, () => store.communityCommand(principal, teamId, seasonId, body!.command as CommunityCommand, role));
          // A cached receipt never bypasses a current grant check or returns an old private view.
          result = store.community(principal, teamId, seasonId, role);
        }
        else if (request.method === 'GET' && parts[3] === 'records') result = store.records(principal, teamId, seasonId, role);
        else if (request.method === 'POST' && parts[3] === 'records') result = mutate(url.pathname, () => store.recordsCommand(principal, teamId, seasonId, body!.command as RecordsCommand));
        else throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
      } else throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
      const pendingReview = typeof result === 'object' && result !== null && 'pendingReview' in result && result.pendingReview === true;
      response(reply, pendingReview ? 409 : 200, result, requestId);
    } catch (error) {
      const domainCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : null;
      const status = error instanceof AccessError ? error.status : domainCode === 'forbidden' ? 403 : domainCode === 'expired' ? 410 : domainCode === 'conflict' || domainCode === 'closed' ? 409 : 422;
      const code = error instanceof AccessError ? error.code : domainCode && ['forbidden', 'invalid', 'conflict', 'expired', 'closed', 'policy_needed'].includes(domainCode) ? domainCode.toUpperCase() : 'COMMAND_REJECTED';
      const safeMessage = error instanceof AccessError ? error.message : 'The command could not be applied. Check the current saved state and request fields.';
      response(reply, status, { code, message: safeMessage, requestId, retryable: status === 429 || status === 503 }, requestId);
    }
  });
  server.requestTimeout = 65_000;
  server.headersTimeout = 10_000;
  return { server, store, media, activation, close: () => new Promise<void>((resolve, reject) => server.close(error => { try { media.close(); store.close(); if (error) reject(error); else resolve(); } catch (closeError) { reject(closeError); } })) };
}
export type { Principal };
