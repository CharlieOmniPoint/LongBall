import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { AccessError } from '../../../packages/application/src/access';

export interface VerifiedIdentity { issuer: string; subject: string; strongAuth: boolean; authenticatedAt: number }
export interface OidcOptions {
  issuer: string;
  audience: string;
  jwksUri: string;
  mfaAcrValues?: string[];
  now?: () => number;
  /** Test/controlled transport seam; production uses HTTPS fetch with bounded timeout. */
  fetchJwks?: () => Promise<{ keys: JsonWebKey[] }>;
}
export function createOidcVerifier(options: OidcOptions): (token: string) => Promise<VerifiedIdentity> {
  if (!options.issuer || !options.audience || new URL(options.issuer).protocol !== 'https:' || new URL(options.jwksUri).protocol !== 'https:') throw new Error('OIDC requires explicitly configured HTTPS issuer, audience and JWKS URI.');
  const now = options.now ?? Date.now;
  let cache: { keys: JsonWebKey[]; expires: number } | null = null;
  let lastRefreshAt = -Infinity;
  let fetching: Promise<{ keys: JsonWebKey[] }> | null = null;
  const load = async (refresh: boolean) => {
    if (!refresh && cache && cache.expires > now()) return cache.keys;
    if (refresh && cache && now() - lastRefreshAt < 30_000) return cache.keys;
    fetching ??= (options.fetchJwks ?? (async () => {
      const response = await fetch(options.jwksUri, { signal: AbortSignal.timeout(5_000), redirect: 'error', headers: { accept: 'application/json' } });
      if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 128_000) throw new Error('OIDC key retrieval failed.');
      const text = await response.text();
      if (text.length > 128_000) throw new Error('OIDC key response is too large.');
      return JSON.parse(text) as { keys: JsonWebKey[] };
    }))();
    try {
      const document = await fetching;
      if (!Array.isArray(document.keys) || document.keys.length > 100) throw new Error('OIDC key document is invalid.');
      cache = { keys: document.keys, expires: now() + 300_000 };
      lastRefreshAt = now();
      return document.keys;
    } finally { fetching = null; }
  };
  return async token => {
    try {
      if (typeof token !== 'string' || token.length > 16_384) throw new Error();
      const segments = token.split('.');
      if (segments.length !== 3 || segments.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
      const header = JSON.parse(Buffer.from(segments[0], 'base64url').toString('utf8')) as Record<string, unknown>;
      const claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')) as Record<string, unknown>;
      if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.kid.length > 200 || header.crit !== undefined) throw new Error();
      let keys = await load(false);
      let jwk = keys.find(key => key.kid === header.kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'));
      if (!jwk) { keys = await load(true); jwk = keys.find(key => key.kid === header.kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig')); }
      if (!jwk || jwk.d) throw new Error();
      const signingKey = createPublicKey({ key: jwk, format: 'jwk' });
      if ((signingKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 || !verify('RSA-SHA256', Buffer.from(`${segments[0]}.${segments[1]}`), signingKey, Buffer.from(segments[2], 'base64url'))) throw new Error();
      const seconds = now() / 1_000;
      const audience = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
      if (claims.iss !== options.issuer || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 || !Array.isArray(audience) || !audience.every(value => typeof value === 'string') || !audience.includes(options.audience)) throw new Error();
      if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= seconds) throw new Error();
      if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf) || claims.nbf > seconds)) throw new Error();
      if (claims.iat !== undefined && (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat) || claims.iat > seconds + 30)) throw new Error();
      const authTime = typeof claims.auth_time === 'number' && Number.isFinite(claims.auth_time) && claims.auth_time >= 0 ? claims.auth_time * 1_000 : 0;
      if (authTime > now() + 30_000) throw new Error();
      const amr = Array.isArray(claims.amr) ? claims.amr.filter(value => typeof value === 'string') : [];
      const strongAuth = amr.includes('mfa') || amr.includes('pwd') && amr.includes('otp') || (typeof claims.acr === 'string' && (options.mfaAcrValues ?? []).includes(claims.acr));
      return { issuer: claims.iss, subject: claims.sub, strongAuth, authenticatedAt: authTime };
    } catch {
      throw new AccessError('INVALID_SESSION', 401, 'A valid authenticated session is required.');
    }
  };
}
