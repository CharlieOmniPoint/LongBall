import { SpectatorAccessService } from './spectator-access';
import { PersistedSpectatorAccessRepository } from './spectator-access-repository';
import { TeamDocumentService } from './team-document-service';
import { OppositionReviewRepository } from './opposition-review-repository';
import { OppositionReviewService } from './opposition-review-service';
import { ClubAdministrationService } from './club-administration';
import type { ReportExportOptions } from './report-export-config';
import { ReportExportRepository } from './report-export-repository';
import { ReportExportService, reportExportRevision } from './report-export-service';
import { parseMatchPageQuery } from './match-pagination';
import { TeamPrivilegeService } from './team-privileges-service';
import { SqliteTeamPrivilegeRepository } from './team-privileges-repository';
import { parseTeamPrivilegeCommand } from '../../../packages/application/src/team-privileges';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { createFastifyTransport } from './fastify-transport';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, join, sep } from 'node:path';
import { AccessError, assertAdultAuthority, assertCanManageTeam, assertTeamRole, type Principal } from '../../../packages/application/src/access';
import type { PreparationCommand } from '../../../packages/application/src/preparation';
import { applyCommunityCommand, parseCommunityCommand, type CommunityCommand } from '../../../packages/application/src/community';
import type { RecordsExportRequest, RecordsServiceCommand } from '../../../packages/application/src/records-service';
import type { SeasonRolloverCommand } from '../../../packages/application/src/season-service';
import { createOidcVerifier, type VerifiedIdentity } from './oidc';
import { DevelopmentStore, EVENT_CONTRACT_VERSION, SYNTHETIC_IDS, type OwnPreparationCommand } from './store';
import eventContract from '../contracts/events-v1.1.schema.json' with { type: 'json' };
import { DevelopmentMediaService, type MediaPrepareInput, type MediaScanner } from './media';
import { sqliteRuntimeStore, type RuntimeStore } from './runtime-store';
import { DevelopmentActivationService, type ActivationPolicy, type ActivationProvider } from './activation';
import type { TrustedTimePolicy } from './trusted-time';
import { Q08_RECONCILIATION_POLICY, type ReconciliationProposalInput } from '../../../packages/application/src/reconciliation';
import { prepareAccountPrivacyRequest } from '../../../packages/application/src/privacy-requests';
import { requestDatabaseScope } from './request-context';
import { BrandMediaService } from './brand-service';
import { SqliteBrandRepository,type BrandRepository } from './brand-repository';
import { assertBrandAuthority,parseBrandingCommand } from '../../../packages/application/src/branding';
import type { SpectatorActivationService } from './spectator-activation';
import { SpectatorInvitationService,invitationVerifier,parseInvitationAccept } from './invitation-service';
import { SqliteInvitationRepository } from './invitation-repository';
import { PushRegistrationService,pushRevision,type PushOptions } from './push-registrations';
import { SqlitePushRepository } from './sqlite-push-registrations';
import { DemoSessions, type DemoAccountOptions } from './demo-sessions';
import { MatchFeedbackRepository } from './match-feedback-repository';
import { MatchFeedbackService } from './match-feedback-service';
import { parseMatchFeedbackCommand } from '../../../packages/application/src/match-feedback';
import { parseScheduledGameCommand, type FixtureManagementRole } from '../../../packages/application/src/fixture-management';

export interface ApiOptions extends PushOptions {
  databasePath: string;
  reportExports?: ReportExportOptions;
  syntheticAuth?: boolean;
  /** Generated review scores/media only; requires synthetic authentication and a nonproduction process. */
  demoScenario?: boolean;
  /** Verifier-only, preauthorised demo login; when configured, static synthetic bearer aliases are refused. */
  demoAccounts?: DemoAccountOptions;
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
  clockPolicy?: TrustedTimePolicy;
  publicAppEntryUrl?:string;
  invitationPolicyVersion?:string;
  defaultInviteExpiryHours?:number;
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
    'synthetic-admin': 'synthetic-account-admin', 'synthetic-club-admin':'synthetic-account-club-admin', 'synthetic-spectator': 'synthetic-account-spectator',
    'synthetic-other-manager': 'synthetic-account-other-manager',
  };
  const accountId = aliases[token] ?? token;
  if (!/^synthetic-account-(?:manager(?:-[2-5])?|admin|club-admin|player-(?:0[1-9]|1[0-3])|spectator|invitee|other-manager)$/.test(accountId)) throw new AccessError('INVALID_SESSION', 401, 'A valid authenticated session is required.');
  return { issuer: 'urn:longball:synthetic', subject: accountId, strongAuth: /manager|admin/.test(accountId), authenticatedAt: now };
}
function readJson(request: IncomingMessage, value: unknown): Record<string, unknown> {
  if (!header(request, 'content-type')?.toLowerCase().startsWith('application/json')) throw new AccessError('JSON_REQUIRED', 415, 'Use application/json for this command.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AccessError('INVALID_JSON', 400, 'A JSON object is required.');
  return value as Record<string, unknown>;
}

function staffCommand(body:Record<string,unknown>,kind:'manager.assigned'|'manager.revoked',key:string):{accountId:string;reason:string;confirmRevocation:true;expectedRevision?:number;commandId:string}{
  const wrapped=Object.hasOwn(body,'command');
  if(wrapped&&Object.keys(body).some(field=>field!=='command'))throw new AccessError('INVALID_REQUEST',400,'Only the captured staff command is accepted.');
  const value=wrapped?body.command:body;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new AccessError('INVALID_REQUEST',400,'A staff command is required.');
  const input=value as Record<string,unknown>;
  const fields=wrapped?['id','type','expectedRevision','accountId',...(kind==='manager.revoked'?['reason','confirmRevocation']:[])]:['accountId',...(kind==='manager.revoked'?['reason','confirmRevocation']:[])];
  if(Object.keys(input).some(field=>!fields.includes(field))||wrapped&&(input.id!==key||input.type!==kind)||typeof input.accountId!=='string'||wrapped&&input.expectedRevision!==undefined&&(!Number.isSafeInteger(input.expectedRevision)||Number(input.expectedRevision)<0))throw new AccessError('INVALID_REQUEST',400,'Use an exact staff command and its matching idempotency key.');
  return {accountId:input.accountId,reason:input.reason as string,confirmRevocation:input.confirmRevocation as true,expectedRevision:input.expectedRevision as number|undefined,commandId:wrapped?input.id as string:key};
}

type AwaitablePort<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args:A)=>Awaited<R>|Promise<Awaited<R>> : T[K] };
export type RuntimeMedia = AwaitablePort<Pick<DevelopmentMediaService,'prepare'|'upload'|'complete'|'link'|'gateway'|'listOwn'|'close'>>;
export type RuntimeActivation = AwaitablePort<Pick<DevelopmentActivationService,'configured'|'createPendingChild'|'issueActivation'|'redeemActivation'|'completeActivation'|'ownsActivationToken'|'requestExistingAccountLink'|'requestRecovery'>>;
export type RuntimeSpectatorActivation=AwaitablePort<Pick<SpectatorActivationService,'configured'|'preflight'|'activate'|'ownsActivationToken'|'completeActivation'>>;
export function createBrandMedia(options:ApiOptions,store:RuntimeStore,repository:BrandRepository){
  return new BrandMediaService({repository,directory:options.mediaDirectory??join(dirname(options.databasePath),'media'),scanner:options.mediaScanner,now:options.now,load:async session=>{
    const fresh=await store.principal({issuer:session.principal.issuer,subject:session.principal.subject,strongAuth:session.principal.strongAuth,authenticatedAt:session.principal.authenticatedAt});
    return store.brandingContext(fresh,session.teamId,session.seasonId,session.role);
  },audit:(principal,action,objectId,outcome)=>store.audit(principal,action,objectId,outcome)});
}
export function assertDemoScenarioOptions(options: Pick<ApiOptions, "demoScenario" | "syntheticAuth" | "demoAccounts">): void {
 if(options.demoScenario && (!options.syntheticAuth || process.env.NODE_ENV === "production")) throw new Error("The demo scenario requires isolated synthetic authentication outside production.");
 if(options.demoAccounts && (!options.demoScenario || !options.syntheticAuth || process.env.NODE_ENV === 'production')) throw new Error('Demo account login requires an explicitly isolated nonproduction demo.');
}
export function createApi(options:ApiOptions) {
 assertDemoScenarioOptions(options);
 if((options.activationProvider||options.activationPolicy)&&!options.syntheticAuth) throw new Error('The test activation setup requires isolated demo authentication.');
 const now=options.now??Date.now;const source=new DevelopmentStore(options.databasePath,now);
 if(options.syntheticAuth)source.seedSynthetic({demoSharing:options.demoScenario===true});
 const runtime=sqliteRuntimeStore(source);
 const media=new DevelopmentMediaService({directory:options.mediaDirectory??join(dirname(options.databasePath),'media'),database:source.database,scanner:options.mediaScanner,now});
 const activation=new DevelopmentActivationService({store:source,provider:options.activationProvider,policy:options.activationPolicy});
 const branding=createBrandMedia(options,runtime.store,new SqliteBrandRepository(source.database,runtime.store.transaction));
 const repository=new SqliteInvitationRepository(source,runtime.store);
 const exportsRepository=new ReportExportRepository(source,runtime.store.transaction);
 const reports=new ReportExportService(exportsRepository,source,options.reportExports,now);
 const feedbackRepository=new MatchFeedbackRepository(source,runtime.store);
 const feedback=new MatchFeedbackService(feedbackRepository);
 const teamDocuments=new TeamDocumentService(source,runtime.store);
 const oppositionRepository=new OppositionReviewRepository(source,runtime.store);const opposition=new OppositionReviewService(oppositionRepository);
 const spectatorAccess=new SpectatorAccessService(new PersistedSpectatorAccessRepository(source,runtime.store),now,options.demoScenario===true&&options.syntheticAuth===true?{isolatedDemo:true}:undefined);
 const ready=runtime.serialize(async()=>{await repository.initialize();await exportsRepository.initialize();await feedbackRepository.initialize();await teamDocuments.initialize();await oppositionRepository.initialize();});void ready.catch(()=>undefined);
 const invitations=new SpectatorInvitationService({...options,repository,now});
 const privileges=new TeamPrivilegeService(new SqliteTeamPrivilegeRepository(source,runtime.store),now);
 const push=new PushRegistrationService(new SqlitePushRepository(source.database,runtime.store.transaction),options,now);
 return createRuntimeApi(options,source,runtime.store,media,activation,work=>ready.then(()=>runtime.serialize(work)),{branding,invitations,privileges,push,reports,feedback,teamDocuments,opposition,spectatorAccess});
}
export function createRuntimeApi<T>(options:ApiOptions,source:T,store:RuntimeStore,media:RuntimeMedia,activation:RuntimeActivation,serialize:<R>(work:()=>Promise<R>)=>Promise<R> = work=>work(),services:{branding?:BrandMediaService;spectator?:RuntimeSpectatorActivation;invitations?:SpectatorInvitationService;privileges?:TeamPrivilegeService;push?:PushRegistrationService;reports?:ReportExportService;feedback?:MatchFeedbackService;teamDocuments?:TeamDocumentService;opposition?:OppositionReviewService;spectatorAccess?:SpectatorAccessService}={}) {
 const now=options.now??Date.now;
 assertDemoScenarioOptions(options);
 const demoSessions=options.demoAccounts?new DemoSessions(options.demoAccounts,now):null;
 const privilegeService=()=>{if(!services.privileges)throw new AccessError('TEAM_PRIVILEGES_UNAVAILABLE',503,'Current team privileges are unavailable.');return services.privileges;};
 const verifyIdentity=options.verifyIdentity??(options.oidc?createOidcVerifier({...options.oidc,now}):null);
const windows = new Map<string, {
        begins: number;
        ordinary: number;
        mutation: number;
    }>();
    const staticRoot = options.staticDirectory ? realpathSync(options.staticDirectory) : null;
    const configuredConnect = [...(options.oidc ? [options.oidc.issuer, options.oidc.jwksUri] : []), ...(options.browserConnectOrigins ?? [])].map(value => {
        const url = new URL(value);
        if (url.protocol !== 'https:')
            throw new Error('Additional browser connect origins must use explicitly configured HTTPS.');
        return url.origin;
    });
    const connectPolicy = [...new Set(configuredConnect)].join(' ');
    const response = (reply: ServerResponse, status: number, value: unknown, requestId: string) => {
        reply.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Request-Id': requestId });
        reply.end(JSON.stringify(value));
    };
    const beforeParsing = (request: IncomingMessage, reply: ServerResponse) => {
            const origin = header(request, 'origin');
            if (origin) {
                let sameOrigin = false;
                try {
                    const parsed = new URL(origin);
                    sameOrigin = staticRoot !== null && ['http:', 'https:'].includes(parsed.protocol) && parsed.host === header(request, 'host');
                }
                catch { /* Reject malformed Origin below. */ }
                if (!sameOrigin && !(options.allowedOrigins ?? ['http://localhost:8081', 'http://localhost:4173', 'http://127.0.0.1:4173']).includes(origin))
                    throw new AccessError('ORIGIN_DENIED', 403, 'This origin is not configured for API access.');
                reply.setHeader('Access-Control-Allow-Origin', origin);
                reply.setHeader('Vary', 'Origin');
                reply.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, X-Controller-Token, X-Media-Upload-Token, X-Longball-Role, X-Api-Contract-Version, If-Match, X-Request-Id');
                reply.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
                reply.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Type, Cache-Control');
            }
    };
    const framework = createFastifyTransport({ beforeParsing, dispatch: (request, reply, parsedBody, requestId) => serialize(async () => {
        try {
            if (request.method === 'OPTIONS') {
                reply.writeHead(204);
                reply.end();
                return;
            }
            const url = new URL(request.url ?? '/', 'http://localhost');
            const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
            if (url.pathname === '/health') {
                response(reply, 200, { status: 'ok', service: 'longball-api', contractVersion: EVENT_CONTRACT_VERSION, backend: source instanceof DevelopmentStore ? 'fictional-sqlite' : 'postgresql', syntheticOnly: Boolean(options.syntheticAuth), demoScenario: options.demoScenario === true, ...(demoSessions?{demoAccountLogin:true}:{}) }, requestId);
                return;
            }
            if (staticRoot && parts[0] !== 'v1' && ['GET', 'HEAD'].includes(request.method ?? '')) {
                if (parts.some(part => part.startsWith('.') || part.includes('/') || part.includes('\\')))
                    throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
                const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2' };
                const path = join(staticRoot, ...(parts.length ? parts : ['index.html']));
                let resolved: string;
                try {
                    resolved = realpathSync(path);
                }
                catch {
                    throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
                }
                if (!resolved.startsWith(`${staticRoot}${sep}`) || !statSync(resolved).isFile() || !contentTypes[extname(resolved)])
                    throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
                reply.writeHead(200, { 'Content-Type': contentTypes[extname(resolved)], 'Cache-Control': extname(resolved) === '.html' ? 'no-store' : 'public, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ${connectPolicy}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`, 'X-Request-Id': requestId });
                reply.end(request.method === 'HEAD' ? undefined : readFileSync(resolved));
                return;
            }
            if (options.syntheticAuth && !loopback(request.socket.remoteAddress))
                throw new AccessError('SYNTHETIC_LOCAL_ONLY', 403, 'Demo authentication is restricted to loopback clients.');
            if(parts[0]==='v1'&&parts[1]==='spectator-access'&&parts.length===3&&services.spectatorAccess){
                const access=services.spectatorAccess,address=request.socket.remoteAddress??'unknown';
                if(request.method==='GET'&&parts[2]==='directory'){response(reply,200,await access.repository.directory(),requestId);return;}
                if(request.method==='POST'&&['preview','register','login','requests'].includes(parts[2])){
                    const input=readJson(request,parsedBody);
                    const result=parts[2]==='preview'?await access.preview(input,address):parts[2]==='register'?await access.register(input,address):parts[2]==='login'?await access.login(input,address):await access.request(input,address);
                    response(reply,parts[2]==='requests'?202:parts[2]==='preview'?200:201,result,requestId);return;
                }
                if(request.method==='DELETE'&&parts[2]==='session'){
                    const authorization=header(request,'authorization');if(!authorization?.startsWith('Bearer '))throw new AccessError('INVALID_SESSION',401,'Sign in again.');
                    access.logout(authorization.slice(7));reply.writeHead(204,{'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Request-Id':requestId});reply.end();return;
                }
            }
            if(url.pathname==='/v1/demo/sessions'&&request.method==='POST'){
                if(!demoSessions)throw new AccessError('NOT_FOUND',404,'The requested object is unavailable.');
                const result=await demoSessions.login(readJson(request,parsedBody),request.socket.remoteAddress??'unknown');
                try{
                    const identity=demoSessions.identity(result.accessToken);
                    const principal=await store.withIdentityContext(identity,()=>store.principal(identity));
                    if(principal.accountId!==result.accountId)throw new AccessError('INVALID_SESSION',401,'A valid authenticated session is required.');
                }catch(error){demoSessions.revoke(result.accessToken);throw error;}
                response(reply,200,result,requestId);return;
            }
            if(url.pathname==='/v1/demo/sessions/current'&&request.method==='DELETE'){
                if(!demoSessions)throw new AccessError('NOT_FOUND',404,'The requested object is unavailable.');
                const authorization=header(request,'authorization');
                if(!authorization?.startsWith('Bearer ')||authorization.length>17000)throw new AccessError('INVALID_SESSION',401,'A valid authenticated session is required.');
                demoSessions.revoke(authorization.slice(7));
                reply.writeHead(204,{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Request-Id':requestId});reply.end();return;
            }
            const requireContract = () => {
                if (header(request, 'x-api-contract-version') !== EVENT_CONTRACT_VERSION)
                    throw new AccessError('CONTRACT_VERSION_REQUIRED', 409, `Use X-Api-Contract-Version: ${EVENT_CONTRACT_VERSION}.`);
                const key = header(request, 'idempotency-key');
                if (!key || !/^[A-Za-z0-9_-]{8,150}$/.test(key))
                    throw new AccessError('IDEMPOTENCY_KEY_REQUIRED', 400, 'Use a stable Idempotency-Key for mutations.');
                return key;
            };
            const activationFields = (value: Record<string, unknown>, names: string[]) => {
                if (Object.keys(value).some(key => !names.includes(key)) || names.some(key => !(key in value)))
                    throw new AccessError('INVALID_REQUEST', 400, 'Use the documented activation request fields.');
            };
            if (request.method === 'POST' && ['/v1/activation/redeem', '/v1/activation/complete','/v1/spectator-invites/activation-info','/v1/spectator-invites/activate'].includes(url.pathname)) {
                // These bearer-capability endpoints create no application session. Secrets never enter generic receipts.
                const rateKey = `activation:${request.socket.remoteAddress ?? 'unknown'}`;
                const prior = windows.get(rateKey);
                const limit = prior && now() - prior.begins < 60000 ? prior : { begins: now(), ordinary: 0, mutation: 0 };
                limit.mutation += 1;
                windows.set(rateKey, limit);
                if (limit.mutation > 20) {
                    reply.setHeader('Retry-After', '60');
                    throw new AccessError('RATE_LIMIT', 429, 'Please retry after the current request window.');
                }
                const key = requireContract();
                const input = readJson(request, parsedBody);
                let result: unknown;

                if(url.pathname.startsWith('/v1/spectator-invites/')){
                    if(!services.spectator)throw new AccessError('ACTIVATION_NOT_CONFIGURED',503,'Invitation activation requires a configured PostgreSQL provider boundary.');
                    if(url.pathname.endsWith('/activation-info')){activationFields(input,['token']);result=await services.spectator.preflight({token:input.token as string});}
                    else{activationFields(input,['token','deviceId','policyVersion']);result=await services.spectator.activate({token:input.token as string,deviceId:input.deviceId as string,policyVersion:input.policyVersion as string,requestId:key});}
                }
                else if (url.pathname === '/v1/activation/redeem') {
                    activationFields(input, ['token']);
                    result = await (await activation.redeemActivation({ token: input.token as string, requestId: key }));
                }
                else {
                    activationFields(input, ['activationId', 'token', 'completionProof']);
                    if(typeof input.activationId!=='string'||typeof input.token!=='string'||typeof input.completionProof!=='string')throw new AccessError('INVALID_REQUEST',400,'Use the original activation capability, identity and provider proof.');
                    if(!activation.configured&&!services.spectator?.configured)throw new AccessError('ACTIVATION_NOT_CONFIGURED',503,'Configure a provider and explicit activation policy before completion.');
                    const child=await activation.ownsActivationToken(input.token,input.activationId);
                    const spectator=services.spectator?await services.spectator.ownsActivationToken(input.token,input.activationId):false;
                    if(child===spectator)throw new AccessError('ACTIVATION_UNAVAILABLE',410,'This activation is unavailable. No session or membership was created.');
                    const completion={activationId:input.activationId,token:input.token,completionProof:input.completionProof};
                    result=child?await activation.completeActivation(completion):await services.spectator!.completeActivation(completion);
                }
                response(reply, 200, result, requestId);
                return;
            }
            if (!options.syntheticAuth && !verifyIdentity && !(services.spectatorAccess && header(request,'authorization')?.startsWith('Bearer spectator_')))
                throw new AccessError('IDENTITY_NOT_CONFIGURED', 503, 'Configure the trusted OIDC issuer, audience and JWKS verifier before accepting requests.');
            const authorization = header(request, 'authorization');
            if (!authorization?.startsWith('Bearer ') || authorization.length > 17000)
                throw new AccessError('INVALID_SESSION', 401, 'A valid authenticated session is required.');
            const token = authorization.slice(7);
            const identity = token.startsWith('spectator_')&&services.spectatorAccess?services.spectatorAccess.identity(token):options.syntheticAuth ? demoSessions?demoSessions.identity(token):syntheticIdentity(token, now()) : await verifyIdentity!(token);
            let principal = await store.withIdentityContext(identity,()=>store.principal(identity));
            const rate = windows.get(principal.accountId);
            const count = rate && now() - rate.begins < 60000 ? rate : { begins: now(), ordinary: 0, mutation: 0 };
            count.ordinary += 1;
            if (request.method !== 'GET')
                count.mutation += 1;
            windows.set(principal.accountId, count);
            if (count.ordinary > 120 || count.mutation > 60) {
                reply.setHeader('Retry-After', '60');
                throw new AccessError('RATE_LIMIT', 429, 'Please retry after the current request window.');
            }
            let role = header(request, 'x-longball-role');
            const controllerToken = header(request, 'x-controller-token');
            const body = request.method === 'POST' ? readJson(request, parsedBody) : null;
            if(request.method==='POST'&&parts[1]==='spectator-invites'&&['inspect','accept'].includes(parts[2])&&parts.length===3){
                const invitations=services.invitations;if(!invitations)throw new AccessError('INVITATION_NOT_CONFIGURED',503,'Invitation processing is unavailable.');
                if(header(request,'x-api-contract-version')!==EVENT_CONTRACT_VERSION)throw new AccessError('CONTRACT_VERSION_REQUIRED',409,`Use X-Api-Contract-Version: ${EVENT_CONTRACT_VERSION}.`);
                const key=parts[2]==='accept'?requireContract():undefined;const {token}=parseInvitationAccept(body);const tokenHash=invitationVerifier(token);
                const resolved=await store.withActorContext(principal,{operation:'invite.resolve',requestedRole:'default',invitationTokenHash:tokenHash},()=>invitations.resolve(principal,body));
                if(parts[2]==='inspect'){const {invitationId,teamId,seasonId,expiresAt,context}=resolved;response(reply,200,{invitationId,teamId,seasonId,expiresAt,context},requestId);return;}
                const accepted=await store.withActorContext(principal,{operation:'invite.accept',requestedRole:'default',teamId:resolved.teamId,seasonId:resolved.seasonId,invitationTokenHash:tokenHash},()=>invitations.accept({principal,teamId:resolved.teamId,seasonId:resolved.seasonId},key!,body));
                response(reply,accepted.status,accepted.body,requestId);return;
            }
            const invitationWrite=request.method==='POST'&&parts[1]==='teams'&&parts[3]==='spectator-invites';
            const bodySeason=invitationWrite?body?.seasonId:undefined;
            if(invitationWrite&&(typeof bodySeason!=='string'||url.searchParams.has('seasonId')&&url.searchParams.get('seasonId')!==bodySeason))throw new AccessError('INVALID_REQUEST',400,'Use the invitation body season without a contradictory query scope.');
            const seasonId = (typeof bodySeason==='string'?bodySeason:url.searchParams.get('seasonId')) ?? (options.syntheticAuth ? SYNTHETIC_IDS.seasonId : '');
            if (parts[1] === 'teams' && !seasonId) throw new AccessError('SEASON_REQUIRED',400,'Choose an explicit current team-season scope.');
            if(role==='administrator'&&parts[1]==='teams'&&['spectator-invites','invite-requests'].includes(parts[3])){
                const own=await store.withActorContext(principal,{operation:'account.read',requestedRole:'default'},()=>store.myMemberships(principal));
                assertTeamRole(principal,own,parts[2],seasonId,['administrator'],now());assertAdultAuthority(principal,false,now());
                assertTeamRole(principal,own,parts[2],seasonId,['manager'],now());
                // A checked Admin uses their inherited Manager invitation rights.
                // Keep the client-selected account role unchanged; resolve SQL intent here.
                role='manager';
            }
            const scopedOperation = (operation: string) => parts[1] === 'administration' ? JSON.stringify([operation,principal.administration?.level??null,[...(principal.administration?.clubIds??[])].sort()]) : parts[1] === 'teams' ? JSON.stringify([operation, parts[2], seasonId, role ?? 'default']) : parts[1] === 'exports' ? JSON.stringify([operation, body?.teamId, body?.seasonId, role ?? 'default']) : operation;
            await store.withActorContext(principal,requestDatabaseScope({method:request.method??'GET',parts,seasonId,role,body}),async()=>{
            if (body && parts[1] === 'teams' && parts[3] === 'community') {
                if(body.command&&typeof body.command==='object'&&'type' in body.command&&typeof body.command.type==='string'&&body.command.type.startsWith('invite.'))throw new AccessError('CANONICAL_INVITATION_REQUIRED',409,'Use the server-issued invitation endpoints; client credentials and JSON-only revocation are unavailable.');
                if (body.command && typeof body.command === 'object' && 'type' in body.command && body.command.type === 'match.registered')
                    throw new AccessError('POLICY_APPROVAL_REQUIRED', 503, 'Connected award/sharing context requires accepted match evidence, verified finish-time anchors and independently approved policy.');
                body.command = parseCommunityCommand(body.command);
            }
            const mutate = async <T>(operation: string, work: () => T | Promise<T>,beforeReplay?:()=>Promise<unknown>,signaturePayload:unknown=body): Promise<T> => store.transaction(async () => {
                requireContract();
                const fresh = await store.principal(identity);
                if (fresh.accountId !== principal.accountId) throw new AccessError('INVALID_SESSION', 401, 'The account binding changed. Sign in again.');
                principal = fresh;
                await beforeReplay?.();
                // Re-check current permissions even when an old idempotency result exists.
                if(url.pathname==='/v1/privacy/requests')prepareAccountPrivacyRequest({principal,memberships:await store.memberships(),input:body,nowMs:now()});
                if (parts[1] === 'matches' && parts[2])
                    (await store.managerMatch(principal, parts[2]));
                if (parts[1] === 'teams' && parts[2]) {
                    if (parts[3] === 'community')
                        (await store.communityActor(principal, parts[2], seasonId, role, (body!.command as CommunityCommand | undefined)?.type === 'invite.accepted'));
                    else if (parts[3] === 'preparation' && parts[4] === 'own')
                        assertTeamRole(principal, (await store.memberships()), parts[2], seasonId, ['player'], now());
                    else if(parts[3]==='configuration'){
                        const club=(body!.command as PreparationCommand|undefined)?.type==='club.updated';
                        assertTeamRole(principal,await store.memberships(),parts[2],seasonId,club?['administrator']:['administrator','manager'],now());assertAdultAuthority(principal,club,now());
                    }
                    else if(parts[3]==='scheduled-games'){
                        if(role!=='manager'&&role!=='administrator')throw new AccessError('NOT_FOUND',404,'Choose the current staff schedule context.');
                        assertTeamRole(principal,await store.memberships(),parts[2],seasonId,[role],now());assertAdultAuthority(principal,role==='administrator',now());
                    }
                    else if(parts[3]==='branding'){
                        const context=await store.brandingContext(principal,parts[2],seasonId,role);
                        assertBrandAuthority(context.context,(body!.command as {kind:'club_logo'|'team_logo'}).kind);
                    }
                    else if (parts[3] === 'managers' || parts[3] === 'seasons' || parts[3] === 'preparation' && (body!.command as PreparationCommand | undefined)?.type === 'club.updated') {
                        if(parts[3]==='managers'&&role&&role!=='administrator')throw new AccessError('NOT_FOUND',404,'Choose the current administrator context to manage staff.');
                        assertTeamRole(principal, (await store.memberships()), parts[2], seasonId, ['administrator'], now());
                        assertAdultAuthority(principal, true, now());
                    }
                    else
                        assertCanManageTeam(principal, (await store.memberships()), parts[2], seasonId, now());
                }
                return (await store.idempotent(principal, scopedOperation(operation), header(request, 'idempotency-key') ?? '', signaturePayload, work));
            });
            let result: unknown;
            const administration=new ClubAdministrationService(source as DevelopmentStore | import('./postgres-store').PostgresStore);
            if (request.method === 'GET' && url.pathname === '/v1/me')
                result = { accountId: principal.accountId, identityClassification: principal.identityClassification, principal, memberships: (await store.workspaceMemberships(principal)), serverTime: new Date(now()).toISOString(), syntheticOnly: Boolean(options.syntheticAuth) };
            else if(url.pathname==='/v1/administration'&&request.method==='GET')result=await administration.view(principal);
            else if(url.pathname==='/v1/administration'&&request.method==='POST'){
                if(Object.keys(body!).length!==1||!Object.hasOwn(body!,'command'))throw new AccessError('INVALID_REQUEST',400,'Use only the captured club administration command.');
                result=await mutate(url.pathname,()=>administration.command(principal,body?.command),()=>administration.authorizeCommand(principal,body?.command));
            }
            else if(parts[1]==='clubs'&&parts[3]==='reports'&&parts.length===4&&request.method==='GET')result=await administration.reports(principal,parts[2]);
            else if (request.method === 'GET' && url.pathname === '/v1/contracts/events')
                result = eventContract;
            else if(parts[1]==='exports'&&services.reports){
                const reports=services.reports;
                if(request.method==='POST'&&parts.length===2){
                    const revision=reportExportRevision(header(request,'if-match'));
                    const receipt=await mutate(url.pathname,()=>reports.create(principal,body,role,revision),()=>reports.authorize(principal,body,role),{body,revision:revision??null});
                    response(reply,202,receipt,requestId);return;
                }
                if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(parts[2]??''))throw new AccessError('NOT_FOUND',404,'The requested export is unavailable.');
                if(request.method==='GET'&&parts.length===3)result=await reports.status(principal,parts[2],role);
                else if(request.method==='GET'&&parts.length===4&&parts[3]==='download'){
                    const artifact=await reports.download(principal,parts[2],role);
                    reply.writeHead(200,{'Content-Type':artifact.contentType,'Content-Length':artifact.bytes.byteLength,'Content-Disposition':`attachment; filename="${artifact.filename}"`,'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Request-Id':requestId});
                    reply.end(artifact.bytes);return;
                }else throw new AccessError('NOT_FOUND',404,'The requested export is unavailable.');
            }
            else if(request.method==='GET'&&url.pathname==='/v1/identity/devices')result=await store.recognisedDevices(principal);
            else if(request.method==='POST'&&url.pathname==='/v1/identity/devices')result=await mutate(url.pathname,()=>store.enrolDevice(principal,body));
            else if(parts[1]==='me'&&parts[2]==='push-registrations'&&services.push){
                const push=services.push;
                if(request.method==='GET'&&parts.length===3)result=await push.read(principal);
                else if(request.method==='POST'&&parts.length===3){
                    const revision=pushRevision(header(request,'if-match')),key=requireContract();
                    result=await mutate(url.pathname,async()=>{const receipt=await push.register(principal,body,revision,key);await store.audit(principal,'push.register',receipt.id,'registered');return receipt;},()=>push.validateRegistration(principal,body),{body,revision});
                }
                else if(request.method==='DELETE'&&parts.length===4){
                    const deviceId=parts[3],revision=pushRevision(header(request,'if-match')),key=requireContract();
                    const receipt=await mutate(url.pathname,async()=>{const value=await push.revoke(principal,deviceId,revision,key);await store.audit(principal,'push.revoke',deviceId,'revoked');return value;},()=>push.assertEnrolled(principal,deviceId),{deviceId,revision});
                    response(reply,202,receipt,requestId);return;
                }else throw new AccessError('NOT_FOUND',404,'The requested object is unavailable.');
            }
            else if (request.method === 'GET' && url.pathname === '/v1/privacy/requests')
                result = await store.privacyRequests(principal);
            else if (request.method === 'POST' && url.pathname === '/v1/privacy/requests')
                result = await mutate(url.pathname,()=>store.privacyRequest(principal,body));
            else if (request.method === 'POST' && ['/v1/accounts/link-requests', '/v1/accounts/recovery-requests'].includes(url.pathname)) {
                const key = requireContract();
                if (url.pathname === '/v1/accounts/link-requests') {
                    activationFields(body!, ['teamId', 'seasonId', 'playerId', 'existingAccountId']);
                    result = (await activation.requestExistingAccountLink(principal, { ...body, requestId: key } as Parameters<typeof activation.requestExistingAccountLink>[1]));
                }
                else {
                    activationFields(body!, ['teamId', 'seasonId', 'accountId']);
                    result = (await activation.requestRecovery(principal, { ...body, requestId: key } as Parameters<typeof activation.requestRecovery>[1]));
                }
            }
            else if (parts[0] === 'v1' && parts[1] === 'matches' && parts[2]) {
                const matchId = parts[2];
                if (request.method === 'GET' && parts.length === 3)
                    result = (await store.matchDto(principal, matchId, role));
                else if (request.method === 'GET' && parts.length === 4 && (parts[3] === 'download' || parts[3] === 'offline-bundle')) {
                    if (url.searchParams.getAll('deviceId').length !== 1 || Array.from(url.searchParams.keys()).some(key => key !== 'deviceId')) throw new AccessError('INVALID_REQUEST',400,'Use one explicit deviceId for this snapshot.');
                    if (parts[3] === 'offline-bundle' && !controllerToken) throw new AccessError('CONTROLLER_REQUIRED',409,'Acquire the current controller capability before downloading its offline bundle.');
                    result = await store.download(principal, matchId, url.searchParams.get('deviceId') ?? '', Boolean(options.syntheticAuth), parts[3] === 'offline-bundle' ? controllerToken : undefined);
                }
                else if (request.method === 'GET' && parts[3] === 'quarantine')
                    result = { items: (await store.quarantine(principal, matchId)) };
                else if (request.method === 'GET' && parts[3] === 'reconciliation') result = await store.reconciliation(principal,matchId);
                else if (request.method === 'POST' && parts[3] === 'reconciliation' && parts[4] === 'proposals') result = await mutate(url.pathname,()=>store.proposeReconciliation(principal,matchId,body as unknown as ReconciliationProposalInput));
                else if (request.method === 'POST' && parts[3] === 'reconciliation' && parts[4] === 'apply') result = await mutate(url.pathname,()=>{throw new AccessError('Q08_AUTHORITY_UNAPPROVED',503,Q08_RECONCILIATION_POLICY.decisionRequired);});
                else if (request.method === 'GET' && parts[3] === 'clock' && parts[4] === 'policy') { await store.managerMatch(principal,matchId);result={status:options.clockPolicy?'configured_trial':'policy_required',policy:options.clockPolicy??null}; }
                else if (request.method === 'POST' && parts[3] === 'clock' && parts[4] === 'challenges' && !parts[5]) result = await mutate(url.pathname,()=>store.issueClockChallenge(principal,matchId,controllerToken,body as unknown as {deviceId:string;controllerEpoch:number;continuityId:string},options.clockPolicy));
                else if (request.method === 'POST' && parts[3] === 'clock' && parts[4] === 'challenges' && parts[5] && parts[6] === 'acknowledge') result = await mutate(url.pathname,()=>store.acknowledgeClockChallenge(principal,matchId,controllerToken,parts[5],body as unknown as {receivedMonotonicMs:number;sentMonotonicMs:number},options.clockPolicy));
                else if (request.method === 'POST' && parts[3] === 'controller')
                    result = (await mutate(url.pathname, async () => (await store.acquire(principal, matchId, String(body!.deviceId ?? '')))));
                else if (request.method === 'POST' && parts[3] === 'events')
                    result = await mutate(url.pathname,async()=>{const uploaded=await store.upload(principal,matchId,controllerToken,body!.events as unknown[]);const communityContext=await store.recordFinishedContext(principal,matchId,options.clockPolicy);return {...uploaded,communityContext};});
                else if (request.method === 'POST' && parts[3] === 'handover' && !parts[4])
                    result = (await mutate(url.pathname, async () => (await store.offerHandover(principal, matchId, controllerToken, String(body!.toAccountId ?? ''), String(body!.toDeviceId ?? ''), Number(body!.baseRevision)))));
                else if (request.method === 'POST' && parts[3] === 'handover' && parts[4] && parts[5] === 'accept')
                    result = (await mutate(url.pathname, async () => (await store.acceptHandover(principal, matchId, parts[4], String(body!.deviceId ?? '')))));
                else if (request.method === 'POST' && parts[3] === 'recover')
                    result = (await mutate(url.pathname, async () => {
                        if (body!.confirmUnsynchronisedRisk !== true)
                            throw new AccessError('RECOVERY_CONFIRMATION_REQUIRED', 422, 'Confirm the possibility of unsynchronised old-device records before recovery.');
                        const recovered=await store.recover(principal,matchId,String(body!.deviceId??''),String(body!.reason??''));await store.recordFinishedContext(principal,matchId,options.clockPolicy);return recovered;
                    }));
                else
                    throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
            }
            else if (parts[0] === 'v1' && parts[1] === 'teams' && parts[2]) {
                const teamId = parts[2];
                if(parts[3]==='spectator-connections'&&parts.length===4&&services.spectatorAccess){
                    const repository=services.spectatorAccess.repository;
                    if(request.method==='GET')result=await repository.connections(principal,teamId,seasonId,role);
                    else if(request.method==='POST'){
                      const key=requireContract();if(Object.keys(body!).length!==1||!Object.hasOwn(body!,'playerId'))throw new AccessError('INVALID_REQUEST',400,'Choose only a player connection.');
                      if(body!.playerId!==null&&typeof body!.playerId!=='string')throw new AccessError('INVALID_REQUEST',400,'Choose a player connection or clear the connection.');
                      result=await repository.follow(principal,teamId,seasonId,role,body!.playerId,key);
                    }else throw new AccessError('NOT_FOUND',404,'The requested player connection is unavailable.');
                }
                else if(parts[3]==='invite-requests'&&services.spectatorAccess){
                    const repository=services.spectatorAccess.repository;
                    if(request.method==='GET'&&parts.length===4)result=await repository.requests(principal,teamId,seasonId,role);
                    else if(request.method==='POST'&&parts.length===6&&parts[5]==='decision'){
                      requireContract();if(Object.keys(body!).length!==1||!['handled','declined'].includes(String(body!.status)))throw new AccessError('INVALID_REQUEST',400,'Choose the invitation request decision.');
                      result=await store.transaction(async()=>{await repository.decide(principal,teamId,seasonId,role,parts[4],body!.status as 'handled'|'declined');return {status:body!.status};});
                    }else throw new AccessError('NOT_FOUND',404,'The requested invitation requests are unavailable.');
                }
                else if(parts[3]==='scheduled-games'&&parts.length===4){
                    if(role!=='manager'&&role!=='administrator')throw new AccessError('NOT_FOUND',404,'Choose the current staff schedule context.');
                    const selected=role as FixtureManagementRole;
                    if(request.method==='GET')result=await store.scheduledGames(principal,teamId,seasonId,selected);
                    else if(request.method==='POST'){
                        if(Object.keys(body!).length!==1||!Object.hasOwn(body!,'command'))throw new AccessError('INVALID_REQUEST',400,'Use only the captured scheduled-game command.');
                        const command=parseScheduledGameCommand(body!.command);if(command.id!==requireContract())throw new AccessError('INVALID_REQUEST',400,'Use the captured command identity.');
                        result=await mutate(url.pathname,()=>store.scheduledGameCommand(principal,teamId,seasonId,command,selected));
                    }else throw new AccessError('NOT_FOUND',404,'The requested schedule operation is unavailable.');
                }
                else if(parts[3]==='team-overview'&&parts.length===4&&request.method==='GET')result=await store.teamOverview(principal,teamId,seasonId,role);
                else if(parts[3]==='player-stats'&&parts.length===4&&request.method==='GET')result=await store.playerStats(principal,teamId,seasonId,role);
                else if(parts[3]==='team-sheet'&&(parts.length===4||parts.length===5&&parts[4]==='download')){
                    const service=services.teamDocuments;if(!service)throw new AccessError('DOCUMENTS_UNAVAILABLE',503,'Team documents are unavailable.');
                    const session={principal,teamId,seasonId,role};
                    if(request.method==='GET')result=parts[4]==='download'?await service.download(session):await service.view(session);
                    else if(request.method==='POST'&&parts.length===4){
                      if(Object.keys(body!).length!==1||!Object.hasOwn(body!,'command'))throw new AccessError('INVALID_REQUEST',400,'Use only the captured team document command.');
                      const command=body!.command as {id?:string};if(command?.id!==requireContract())throw new AccessError('INVALID_REQUEST',400,'Use the captured command identity.');
                      result=await mutate(url.pathname,()=>service.command(session,command));
                    }else throw new AccessError('NOT_FOUND',404,'The requested team document is unavailable.');
                }
                else if(parts[3]==='opposition-reviews'&&parts.length===4){
                    const service=services.opposition;if(!service)throw new AccessError('REVIEWS_UNAVAILABLE',503,'Opposition reviews are unavailable.');
                    if(role!=='manager'&&role!=='administrator'&&role!=='player')throw new AccessError('NOT_FOUND',404,'The requested opposition reviews are unavailable.');
                    const session={principal,teamId,seasonId,role};
                    if(request.method==='GET')result=await service.view(session);
                    else if(request.method==='POST'){
                      if(Object.keys(body!).length!==1||!Object.hasOwn(body!,'command'))throw new AccessError('INVALID_REQUEST',400,'Use only the captured opposition review command.');
                      const command=body!.command as {id?:string};if(command?.id!==requireContract())throw new AccessError('INVALID_REQUEST',400,'Use the captured command identity.');
                      result=await service.command(session,command);
                    }else throw new AccessError('NOT_FOUND',404,'The requested opposition review operation is unavailable.');
                }
                else if(parts[3]==='match-feedback'&&parts.length===4){
                    if(role!=='manager'&&role!=='player')throw new AccessError('NOT_FOUND',404,'The requested private feedback is unavailable.');
                    const feedback=services.feedback;if(!feedback)throw new AccessError('FEEDBACK_UNAVAILABLE',503,'Private match feedback is unavailable.');
                    const session={principal,teamId,seasonId,role};
                    if(request.method==='GET')result=await feedback.view(session);
                    else if(request.method==='POST'){
                        if(role!=='player')throw new AccessError('NOT_FOUND',404,'Only the currently linked player can submit their own feedback.');
                        if(Object.keys(body!).length!==1||!Object.hasOwn(body!,'command'))throw new AccessError('INVALID_REQUEST',400,'Use only the captured private feedback command.');
                        const command=parseMatchFeedbackCommand(body!.command);if(command.id!==requireContract())throw new AccessError('INVALID_REQUEST',400,'Use the captured command identity.');
                        result=await feedback.command(session,command);
                    }else throw new AccessError('NOT_FOUND',404,'The requested private feedback operation is unavailable.');
                }
                else if(parts[3]==='privileges'){
                    const session={principal,teamId,seasonId,role};
                    if(request.method==='GET'&&parts.length===4)result=await privilegeService().view(session);
                    else if(request.method==='GET'&&parts[4]==='own'&&parts.length===5)result=await privilegeService().own(session);
                    else if(request.method==='POST'&&parts.length===4){
                      if(Object.keys(body!).length!==1||!Object.hasOwn(body!,'command'))throw new AccessError('INVALID_REQUEST',400,'Use only the captured team privilege command.');
                      const command=parseTeamPrivilegeCommand(body!.command);if(command.id!==requireContract())throw new AccessError('INVALID_REQUEST',400,'Use the captured command identity.');
                      result=await mutate(url.pathname,()=>privilegeService().command(session,command));
                    }else throw new AccessError('NOT_FOUND',404,'The requested team operation is unavailable.');
                }
                else if(['spectator-invites','invite-requests'].includes(parts[3])){
                    const invitations=services.invitations;if(!invitations)throw new AccessError('INVITATION_NOT_CONFIGURED',503,'Invitation processing is unavailable.');
                    const session={principal,teamId,seasonId,role};
                    if(request.method==='GET'&&parts.length===4)result=await invitations.list(session);
                    else if(request.method==='POST'&&parts.length===4){const receipt=await invitations.issue(session,requireContract(),body);response(reply,receipt.status,receipt.body,requestId);return;}
                    else if(request.method==='POST'&&parts.length===6&&parts[5]==='reissue'){const receipt=await invitations.issue(session,requireContract(),body,parts[4]);response(reply,receipt.status,receipt.body,requestId);return;}
                    else if(request.method==='DELETE'&&parts.length===5){const receipt=await invitations.revoke(session,requireContract(),parts[4]);response(reply,receipt.status,receipt.body,requestId);return;}
                    else throw new AccessError('NOT_FOUND',404,'The requested invitation is unavailable.');
                }
                else if(parts[3]==='branding'){
                    const branding=services.branding;if(!branding)throw new AccessError('BRANDING_NOT_CONFIGURED',503,'Supplied logo processing is unavailable.');
                    const session={principal,teamId,seasonId,role};
                    if(request.method==='GET'&&parts.length===4)result=await branding.get(session);
                    else if(request.method==='GET'&&parts[4]==='assets'&&parts[5]&&parts[6]==='revisions'&&parts[7]&&parts[8]&&parts.length===9){
                        const mode=url.searchParams.get('mode')??'published';if(!['own','published'].includes(mode)||!['display','thumbnail'].includes(parts[8]))throw new AccessError('NOT_FOUND',404,'The requested branding is unavailable.');
                        const image=await branding.gateway(session,parts[5],Number(parts[7]),parts[8] as 'display'|'thumbnail',mode as 'own'|'published');reply.writeHead(200,{...image.headers,'X-Request-Id':requestId});reply.end(image.body);return;
                    }
                    else{
                        if(!role||!['administrator','manager'].includes(role))throw new AccessError('NOT_FOUND',404,'Choose the current logo administrator or manager context.');
                        if(request.method==='PUT'&&parts[4]==='uploads'&&parts[5]&&parts.length===6){requireContract();result=await branding.upload(session,parts[5],header(request,'x-media-upload-token')??'',request);}
                        else if(request.method==='POST'&&parts[4]==='uploads'&&parts[5]&&parts[6]==='complete'&&parts.length===7){requireContract();if(Object.keys(body!).length)throw new AccessError('INVALID_REQUEST',400,'Logo completion accepts no reported processing evidence.');result=await branding.complete(session,parts[5],header(request,'x-media-upload-token')??'');}
                        else if(request.method==='POST'&&['club_logo','team_logo'].includes(parts[4])&&parts[5]==='uploads'&&parts[6]==='prepare'&&parts.length===7){const key=requireContract();if(body!.kind!==parts[4])throw new AccessError('INVALID_BRANDING',422,'Use the matching logo kind.');result=await branding.prepare(session,key,body);}
                        else if(request.method==='POST'&&['club_logo','team_logo'].includes(parts[4])&&['publish','remove'].includes(parts[5])&&parts.length===6){
                            if(Object.keys(body!).length!==1||!Object.hasOwn(body!,'command'))throw new AccessError('INVALID_REQUEST',400,'Use only the captured logo command.');
                            const command=parseBrandingCommand(body!.command,parts[4] as 'club_logo'|'team_logo');
                            if(command.id!==requireContract()||command.type!==(parts[5]==='publish'?'logo.published':'logo.removed'))throw new AccessError('INVALID_REQUEST',400,'Use the exact logo command and matching request identity.');
                            result=await mutate(url.pathname,()=>branding.command({...session,principal},command));
                        }else throw new AccessError('NOT_FOUND',404,'The requested branding is unavailable.');
                    }
                }
                else if (request.method === 'POST' && parts[3] === 'activation' && parts.length === 5 && ['pending-child', 'issue'].includes(parts[4])) {
                    const requestId = requireContract();
                    assertCanManageTeam(principal, (await store.memberships()), teamId, seasonId, now());
                    if (parts[4] === 'pending-child') {
                        activationFields(body!, ['playerId']);
                        result = await (await activation.createPendingChild(principal, { requestId, teamId, seasonId, playerId: body!.playerId as string }));
                    }
                    else {
                        activationFields(body!, ['accountId']);
                        result = await (await activation.issueActivation(principal, { requestId, teamId, seasonId, accountId: body!.accountId as string }));
                    }
                }
                else if (parts[3] === 'media') {
                    const actor = (await store.communityActor(principal, teamId, seasonId, role));
                    const privilegeSession={principal,teamId,seasonId,role};
                    if(request.method!=='GET')await privilegeService().assertAllowed(privilegeSession,'uploads');
                    const community = async () => (await store.communityState(teamId, seasonId));
                    if (request.method === 'GET' && parts[4] === 'uploads' && !parts[5])
                        result = { items: (await media.listOwn((await community()), actor)) };
                    else if (request.method === 'POST' && parts[4] === 'uploads' && parts[5] === 'prepare') {
                        const key = requireContract();
                        // The media manifest hashes/rotates the write token; never store it in generic response receipts.
                        result = await store.transaction(async () => { await privilegeService().assertAllowed(privilegeSession,'uploads',true);return media.prepare(await community(),actor,{...body,requestId:key} as MediaPrepareInput); });
                    }
                    else if (request.method === 'PUT' && parts[4] === 'uploads' && parts[5]) {
                        requireContract();
                        result = await (await media.upload((await community()), actor, parts[5], header(request, 'x-media-upload-token') ?? '', request));
                        await privilegeService().assertAllowed(privilegeSession,'uploads');
                    }
                    else if (request.method === 'POST' && parts[4] === 'uploads' && parts[5] && parts[6] === 'complete') {
                        const key = requireContract();
                        if(Object.keys(body!).length)throw new AccessError('INVALID_REQUEST',400,'Media completion accepts no caller-reported processing evidence.');
                        const processed = await (await media.complete((await community()), actor, parts[5], header(request, 'x-media-upload-token') ?? ''));
                        result = (await store.idempotent(principal, scopedOperation(url.pathname), key, body, async () => {
                            const freshActor = (await store.communityActor(principal, teamId, seasonId, role));
                            await privilegeService().assertAllowed(privilegeSession,'uploads',true);
                            const next = applyCommunityCommand((await community()), freshActor, processed.command, now());
                            (await store.saveDocument(teamId, seasonId, 'community', next));
                            (await media.link(parts[5], next));
                            (await store.audit(principal, 'media.processed', processed.receipt.photoId, 'private_review_required'));
                            return processed.receipt;
                        }));
                    }
                    else if (request.method === 'GET' && parts[4] === 'photos' && parts[5] && parts[6]) {
                        const mode = url.searchParams.get('mode') ?? 'gallery';
                        if (!['gallery', 'own', 'review'].includes(mode) || !['display', 'thumbnail'].includes(parts[6]))
                            throw new AccessError('NOT_FOUND', 404, 'The requested image is unavailable.');
                        const rawRevision = url.searchParams.get('revision');
                        const revision = rawRevision === null ? undefined : Number(rawRevision);
                        if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))
                            throw new AccessError('NOT_FOUND', 404, 'The requested image is unavailable.');
                        const image = (await media.gateway((await community()), actor, parts[5], parts[6] as 'display' | 'thumbnail', mode as 'gallery' | 'own' | 'review', revision));
                        reply.writeHead(200, { ...image.headers, 'X-Request-Id': requestId });
                        reply.end(image.body);
                        return;
                    }
                    else
                        throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
                }
                else if (request.method === 'GET' && parts[3] === 'matches' && !parts[4])
                    result = await store.teamMatches(principal, teamId, seasonId, role, parseMatchPageQuery(url.searchParams));
                else if(request.method==='GET'&&parts[3]==='managers'&&!parts[4])result=await store.managers(principal,teamId,seasonId,role);
                else if (request.method === 'POST' && parts[3] === 'managers' && parts[4] === 'revoke') result = await mutate(url.pathname,async()=>{const input=staffCommand(body!,'manager.revoked',header(request,'idempotency-key')??'');return {kind:'staff-command-receipt',commandId:input.commandId,...await store.revokeManager(principal,teamId,seasonId,{accountId:input.accountId,reason:input.reason,confirmRevocation:input.confirmRevocation},input.expectedRevision)};});
                else if (request.method === 'POST' && parts[3] === 'managers' && !parts[4])
                    result = await mutate(url.pathname,async()=>{const input=staffCommand(body!,'manager.assigned',header(request,'idempotency-key')??'');return {kind:'staff-command-receipt',commandId:input.commandId,...await store.assignManager(principal,teamId,seasonId,input.accountId,input.expectedRevision)};});
                else if (request.method === 'GET' && parts[3] === 'configuration') result = await store.configuration(principal, teamId, seasonId,role);
                else if (request.method === 'POST' && parts[3] === 'configuration') result = await mutate(url.pathname, () => store.configurationCommand(principal, teamId, seasonId, body!.command as PreparationCommand,role));
                else if (request.method === 'GET' && parts[3] === 'seasons' && parts[4] === 'rollover-options') result = await store.seasonOptions(principal, teamId, seasonId);
                else if (request.method === 'POST' && parts[3] === 'seasons') result = await mutate(url.pathname, () => store.createSeason(principal, teamId, seasonId, body!.command as SeasonRolloverCommand));
                else if (request.method === 'GET' && parts[3] === 'preparation' && parts[4] === 'own')
                    result = (await store.ownPreparation(principal, teamId, seasonId));
                else if (request.method === 'POST' && parts[3] === 'preparation' && parts[4] === 'own')
                    result = (await mutate(url.pathname, async () => (await store.ownPreparationCommand(principal, teamId, seasonId, body!.command as OwnPreparationCommand))));
                else if (request.method === 'GET' && parts[3] === 'preparation')
                    result = (await store.preparation(principal, teamId, seasonId));
                else if (request.method === 'POST' && parts[3] === 'preparation')
                    result = (await mutate(url.pathname, async () => (await store.preparationCommand(principal, teamId, seasonId, body!.command as PreparationCommand))));
                else if (request.method === 'GET' && parts[3] === 'community' && parts[4] === 'media' && parts[5])
                    result = (await store.media(principal, teamId, seasonId, parts[5], (url.searchParams.get('mode') ?? 'gallery') as 'gallery' | 'own' | 'review', role));
                else if (request.method === 'GET' && parts[3] === 'community')
                    result = (await store.community(principal, teamId, seasonId, role));
                else if (request.method === 'POST' && parts[3] === 'community') {
                    await mutate(url.pathname,async()=>{const command=body!.command as CommunityCommand;if(['photo.submitted','photo.revised','photo.published'].includes(command.type))await privilegeService().assertAllowed({principal,teamId,seasonId,role},'uploads',true);return store.communityCommand(principal,teamId,seasonId,command,role);});
                    // A cached receipt never bypasses a current grant check or returns an old private view.
                    result = (await store.community(principal, teamId, seasonId, role));
                }
                else if (request.method === 'GET' && parts[3] === 'records' && parts[4] === 'export') {
                    const expected = url.searchParams.get('expectedProjectionVersion');
                    if (expected !== null && (!/^[0-9]+$/.test(expected) || !Number.isSafeInteger(Number(expected)))) throw new AccessError('INVALID_REQUEST',400,'Use a valid projection version.');
                    const exportRequest: RecordsExportRequest = { kind: url.searchParams.get('kind') as RecordsExportRequest['kind'], format: url.searchParams.get('format') as RecordsExportRequest['format'], ...(url.searchParams.has('matchId') ? {matchId:url.searchParams.get('matchId')!}:{}), ...(expected === null ? {} : {expectedProjectionVersion:Number(expected)}), ...(url.searchParams.has('expectedPolicyFingerprint') ? {expectedPolicyFingerprint:url.searchParams.get('expectedPolicyFingerprint')!}:{}) };
                    result = await store.recordsExport(principal,teamId,seasonId,exportRequest,role);
                }
                else if (request.method === 'GET' && parts[3] === 'records')
                    result = (await store.records(principal, teamId, seasonId, role));
                else if (request.method === 'POST' && parts[3] === 'records')
                    result = (await mutate(url.pathname, async () => (await store.recordsCommand(principal, teamId, seasonId, body!.command as RecordsServiceCommand, role))));
                else
                    throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
            }
            else
                throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
            const pendingReview = typeof result === 'object' && result !== null && 'pendingReview' in result && result.pendingReview === true;
            response(reply, pendingReview ? 409 : 200, result, requestId);
            });
        }
        catch (error) {
            const domainCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : null;
            const unavailable = domainCode !== null && (/^(08|53|57|58)/.test(domainCode) || ['ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOTFOUND'].includes(domainCode));
            const status = error instanceof AccessError ? error.status : unavailable ? 503 : domainCode === 'forbidden' ? 403 : domainCode === 'expired' ? 410 : domainCode === 'conflict' || domainCode === 'closed' ? 409 : 422;
            const code = error instanceof AccessError ? error.code : unavailable ? 'STORAGE_UNAVAILABLE' : domainCode && ['forbidden', 'invalid', 'conflict', 'expired', 'closed', 'policy_needed'].includes(domainCode) ? domainCode.toUpperCase() : 'COMMAND_REJECTED';
            const safeMessage = error instanceof AccessError ? error.message : unavailable ? 'Storage is temporarily unavailable. Retain pending commands and retry the same request.' : 'The command could not be applied. Check the current saved state and request fields.';
            if(status===429)reply.setHeader('Retry-After','60');
            response(reply, status, { code, message: safeMessage, requestId, retryable: status === 429 || status === 503 }, requestId);
        }
    }) });
    const server = framework.server;
    return { server, framework, store: source, media, activation,branding:services.branding,spectator:services.spectator, close: async () => { demoSessions?.close();services.spectatorAccess?.close(); await framework.close(); await media.close(); await store.close(); } };
}
export type { Principal };
