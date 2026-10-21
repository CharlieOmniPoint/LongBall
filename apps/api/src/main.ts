import { readReportExportOptions } from './report-export-config';
import { createApi, type ApiOptions } from './server';
import { createPostgresApi } from './postgres-server';
import { createClamAvDaemonScanner, createClamAvScanner } from './media';
import { issueClockChallenge, type TrustedTimePolicy } from './trusted-time';
import { readDatabaseUrl } from './database-config';
import { readPushOptions } from './push-config';

const syntheticAuth = process.env.LONGBALL_SYNTHETIC_AUTH === '1';
const demoScenario = process.env.LONGBALL_DEMO_SCENARIO === '1';
const host = process.env.LONGBALL_API_HOST ?? '127.0.0.1';
if (syntheticAuth && !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Synthetic development authentication may only bind to loopback.');
if (process.env.NODE_ENV === 'production' && syntheticAuth) throw new Error('Synthetic authentication is disabled in production.');
const issuer = process.env.LONGBALL_OIDC_ISSUER;
const audience = process.env.LONGBALL_OIDC_AUDIENCE;
const jwksUri = process.env.LONGBALL_OIDC_JWKS_URI;
const connectionString = readDatabaseUrl(process.env);
if (!connectionString && !syntheticAuth) throw new Error('Configure LONGBALL_DATABASE_URL for the PostgreSQL runtime. SQLite is available only with explicit fictional authentication.');
const daemonSocket = process.env.LONGBALL_CLAMD_SOCKET;
const daemonHost = process.env.LONGBALL_CLAMD_HOST;
const mediaScanner = daemonSocket || daemonHost ? createClamAvDaemonScanner({ socketPath: daemonSocket, host: daemonHost, port: process.env.LONGBALL_CLAMD_PORT ? Number(process.env.LONGBALL_CLAMD_PORT) : undefined }) : process.env.LONGBALL_CLAMSCAN_PATH ? createClamAvScanner(process.env.LONGBALL_CLAMSCAN_PATH) : undefined;
let clockPolicy:TrustedTimePolicy|undefined;
if(process.env.LONGBALL_FICTIONAL_CLOCK_POLICY){
  if(process.env.NODE_ENV==='production')throw new Error('The fictional clock policy is not production authority. Configure reviewed deployment evidence before enabling production anchors.');
  clockPolicy=JSON.parse(process.env.LONGBALL_FICTIONAL_CLOCK_POLICY) as TrustedTimePolicy;
  issueClockChallenge({accountId:'configuration-check',deviceId:'configuration-check',matchId:'configuration-check',controllerEpoch:1,continuityId:'configuration-check'},'configuration-check',Date.now(),clockPolicy);
}
const options: ApiOptions = { ...readPushOptions(process.env), reportExports:readReportExportOptions(process.env), databasePath: process.env.LONGBALL_API_DATABASE ?? '.local/api/longball.sqlite', syntheticAuth, demoScenario,
  oidc: issuer && audience && jwksUri ? { issuer, audience, jwksUri, mfaAcrValues: process.env.LONGBALL_OIDC_MFA_ACR?.split(',').filter(Boolean) } : undefined,
  allowedOrigins: process.env.LONGBALL_API_ORIGINS?.split(',').filter(Boolean), staticDirectory: process.env.LONGBALL_STATIC_DIRECTORY, browserConnectOrigins: process.env.LONGBALL_OIDC_CONNECT_ORIGINS?.split(',').filter(Boolean),
  mediaDirectory: process.env.LONGBALL_MEDIA_DIRECTORY, mediaScanner, clockPolicy,
  publicAppEntryUrl:process.env.LONGBALL_PUBLIC_APP_ENTRY_URL,invitationPolicyVersion:process.env.LONGBALL_INVITATION_POLICY_VERSION,
  defaultInviteExpiryHours:process.env.LONGBALL_DEFAULT_INVITE_EXPIRY_HOURS?Number(process.env.LONGBALL_DEFAULT_INVITE_EXPIRY_HOURS):undefined };
const migrationMode=process.env.LONGBALL_DATABASE_MIGRATION_MODE??(syntheticAuth?'apply':'verify');
if(!['apply','verify'].includes(migrationMode)||process.env.NODE_ENV==='production'&&migrationMode!=='verify')throw new Error('The serving API uses verify-only schema mode in production; apply migrations with the dedicated operator command.');
const api = connectionString ? await createPostgresApi({ ...options, connectionString, seedSynthetic:false, migrationMode:migrationMode as 'apply'|'verify' }) : createApi(options);
const port = Number(process.env.LONGBALL_API_PORT ?? 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Configure a valid API port.');
api.server.listen(port, host, () => { console.log(`LongBall API http://${host}:${port} · ${syntheticAuth ? 'isolated fictional authentication' : 'verified OIDC'} · ${connectionString ? 'PostgreSQL runtime' : 'fictional SQLite store'}`); });
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { if (!closing) { closing = true; void api.close().then(() => process.exit(0)); } });
