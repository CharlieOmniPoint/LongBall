import { createApi } from './server';
import { createClamAvScanner } from './media';

const syntheticAuth = process.env.LONGBALL_SYNTHETIC_AUTH === '1';
const host = process.env.LONGBALL_API_HOST ?? '127.0.0.1';
if (syntheticAuth && !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Synthetic development authentication may only bind to loopback.');
if (process.env.NODE_ENV === 'production' && syntheticAuth) throw new Error('Synthetic authentication is disabled in production.');
const issuer = process.env.LONGBALL_OIDC_ISSUER;
const audience = process.env.LONGBALL_OIDC_AUDIENCE;
const jwksUri = process.env.LONGBALL_OIDC_JWKS_URI;
const api = createApi({ databasePath: process.env.LONGBALL_API_DATABASE ?? '.local/api/longball.sqlite', syntheticAuth,
  oidc: issuer && audience && jwksUri ? { issuer, audience, jwksUri, mfaAcrValues: process.env.LONGBALL_OIDC_MFA_ACR?.split(',').filter(Boolean) } : undefined,
  allowedOrigins: process.env.LONGBALL_API_ORIGINS?.split(',').filter(Boolean), staticDirectory: process.env.LONGBALL_STATIC_DIRECTORY, browserConnectOrigins: process.env.LONGBALL_OIDC_CONNECT_ORIGINS?.split(',').filter(Boolean),
  mediaDirectory: process.env.LONGBALL_MEDIA_DIRECTORY, mediaScanner: process.env.LONGBALL_CLAMSCAN_PATH ? createClamAvScanner(process.env.LONGBALL_CLAMSCAN_PATH) : undefined });
const port = Number(process.env.LONGBALL_API_PORT ?? 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Configure a valid API port.');
api.server.listen(port, host, () => { console.log(`LongBall development API http://${host}:${port} · ${syntheticAuth ? 'isolated fictional authentication' : 'OIDC required'} · SQLite development store`); });
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { if (!closing) { closing = true; void api.close().then(() => process.exit(0)); } });
