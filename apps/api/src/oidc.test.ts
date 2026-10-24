import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createOidcVerifier } from './oidc';

const now = 1_800_000_000_000;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const verifier = () => createOidcVerifier({ issuer: 'https://identity.example.invalid/realm', audience: 'longball-api', jwksUri: 'https://identity.example.invalid/jwks', now: () => now, fetchJwks: async () => ({ keys: [key] }) });
function token(patch: Record<string, unknown> = {}, keyToSign = privateKey, kid = 'test-key'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: 'https://identity.example.invalid/realm', sub: 'subject-1', aud: 'longball-api', exp: now / 1_000 + 300, nbf: now / 1_000 - 1, auth_time: now / 1_000 - 10, amr: ['pwd', 'otp'], ...patch })).toString('base64url');
  return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), keyToSign).toString('base64url')}`;
}
describe('SEC03 configured OIDC signature and claim validation', () => {
  it('verifies a signed issuer/audience and derives authentication strength without trusting app-role claims', async () => {
    const result = await verifier()(token({ identityClassification: 'adult_individual', role: 'administrator' }));
    expect(result).toEqual({ issuer: 'https://identity.example.invalid/realm', subject: 'subject-1', strongAuth: true, authenticatedAt: now - 10_000 });
    expect(result).not.toHaveProperty('role');
    expect(result).not.toHaveProperty('identityClassification');
  });
  it.each([{ iss: 'https://another.example.invalid' }, { aud: 'other-app' }, { exp: now / 1_000 }, { nbf: now / 1_000 + 1 }, { sub: '' }])('refuses invalid claims %j', async patch => {
    await expect(verifier()(token(patch))).rejects.toMatchObject({ status: 401 });
  });
  it('refuses forged signatures and unsigned tokens', async () => {
    const forged = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await expect(verifier()(token({}, forged.privateKey))).rejects.toMatchObject({ status: 401 });
    await expect(verifier()(`${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.x`)).rejects.toMatchObject({ status: 401 });
  });
  it('does not assume a password-only session meets adult stronger-authentication policy', async () => {
    expect((await verifier()(token({ amr: ['pwd'], auth_time: undefined }))).strongAuth).toBe(false);
    expect((await verifier()(token({ amr: ['pwd'], auth_time: undefined }))).authenticatedAt).toBe(0);
  });
  it('requires configured user-verifying assurance instead of treating a hardware-key label as MFA', async () => {
    expect((await verifier()(token({ amr: ['hwk'], acr: 'unapproved-passkey-assurance' }))).strongAuth).toBe(false);
    const configured = createOidcVerifier({ issuer: 'https://identity.example.invalid/realm', audience: 'longball-api', jwksUri: 'https://identity.example.invalid/jwks', mfaAcrValues: ['approved-user-verifying-passkey'], now: () => now, fetchJwks: async () => ({ keys: [key] }) });
    expect((await configured(token({ amr: ['hwk'], acr: 'approved-user-verifying-passkey' }))).strongAuth).toBe(true);
  });
  it('bounds unknown-key refreshes while accepting a configured provider key rotation', async () => {
    let clock = now; let calls = 0;
    const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rotatedJwk = { ...rotated.publicKey.export({ format: 'jwk' }), kid: 'rotated-key', alg: 'RS256', use: 'sig' };
    const verifyRotating = createOidcVerifier({ issuer: 'https://identity.example.invalid/realm', audience: 'longball-api', jwksUri: 'https://identity.example.invalid/jwks', now: () => clock, fetchJwks: async () => ({ keys: ++calls === 1 ? [key] : [key, rotatedJwk] }) });
    await expect(verifyRotating(token())).resolves.toHaveProperty('subject', 'subject-1');
    await expect(verifyRotating(token({}, rotated.privateKey, 'rotated-key'))).rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(1);
    clock += 31_000;
    await expect(verifyRotating(token({}, rotated.privateKey, 'rotated-key'))).resolves.toHaveProperty('subject', 'subject-1');
    expect(calls).toBe(2);
  });
});
