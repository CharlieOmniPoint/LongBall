import { describe, expect, it } from 'vitest';
import { assertControllerDownloadScope, controllerAuthorityWasDenied, controllerCacheDocumentId, controllerCachePlatformAllowed, controllerCacheScope, controllerSessionAllowsCache, type ControllerIdentity, type ControllerSessionGate } from './connected-scope';

const identity: ControllerIdentity = { accountId: 'adult-a', principal: { accountId: 'adult-a', issuer: 'https://issuer.test', subject: 'a', status: 'active', identityClassification: 'adult_individual', adultVerified: true, strongAuth: true, authenticatedAt: 100 }, memberships: [{ accountId: 'adult-a', teamId: 'team-a', seasonId: 'season-a', role: 'manager' }] };
const target = { baseUrl: 'https://api.test', teamId: 'team-a', seasonId: 'season-a', matchId: 'match-a', deviceId: 'device-a' };
const session: ControllerSessionGate = { accountId: 'adult-a', issuer: 'https://issuer.test', locked: false, expired: false, identityClassification: 'adult_individual', adultVerified: true, strongAuth: true, memberships: identity.memberships };
describe('controller cache authorization boundary', () => {
  it('never mounts a real account controller cache in unencrypted browser review storage', () => {
    expect(controllerCachePlatformAllowed('oidc', 'web')).toBe(false);
    expect(controllerCachePlatformAllowed('oidc', 'unknown')).toBe(false);
    expect(controllerCachePlatformAllowed('oidc', 'ios')).toBe(true);
    expect(controllerCachePlatformAllowed('oidc', 'android')).toBe(true);
    expect(controllerCachePlatformAllowed('synthetic', 'web')).toBe(true);
  });
  it('binds every document dimension, including account and issuer, without tuple collisions', () => {
    const scope = controllerCacheScope(identity, target, 100);
    const first = controllerCacheDocumentId(scope);
    for (const key of ['baseUrl', 'accountId', 'issuer', 'teamId', 'seasonId', 'matchId', 'deviceId'] as const) expect(controllerCacheDocumentId({ ...scope, [key]: `${scope[key]}-other` })).not.toBe(first);
    expect(controllerCacheDocumentId({ ...scope, accountId: 'a|b', teamId: 'c' })).not.toBe(controllerCacheDocumentId({ ...scope, accountId: 'a', teamId: 'b|c' }));
  });
  it('refuses cache selection for child, spectator, expired/revoked or wrong-scope membership', () => {
    expect(() => controllerCacheScope({ ...identity, principal: { ...identity.principal, identityClassification: 'child_shared', adultVerified: false } }, target, 100)).toThrow();
    for (const membership of [{ ...identity.memberships[0], role: 'spectator' as const }, { ...identity.memberships[0], expiresAt: 100 }, { ...identity.memberships[0], revokedAt: 90 }, { ...identity.memberships[0], seasonId: 'elsewhere' }]) expect(() => controllerCacheScope({ ...identity, memberships: [membership] }, target, 100)).toThrow();
    expect(() => controllerCacheScope({ ...identity, accountId: 'claimed-other-account' }, target, 100)).toThrow();
    expect(() => controllerCacheScope(identity, { ...target, matchId: '' }, 100)).toThrow();
  });
  it('unmounts a manager cache after shared-device account switch, lock, expiry or membership loss', () => {
    const scope = controllerCacheScope(identity, target, 100);
    expect(controllerSessionAllowsCache(scope, session, 100)).toBe(true);
    for (const change of [{ accountId: 'child-b' }, { issuer: 'https://other-issuer.test' }, { locked: true }, { expired: true }, { strongAuth: false }, { memberships: [] }, { memberships: [{ ...identity.memberships[0], expiresAt: 100 }] }]) expect(controllerSessionAllowsCache(scope, { ...session, ...change }, 100)).toBe(false);
    expect(controllerSessionAllowsCache(scope, null, 100)).toBe(false);
  });
  it('binds the authenticated downloaded match to the selected team and season before exposing it', () => {
    const scope = controllerCacheScope(identity, target, 100);
    expect(() => assertControllerDownloadScope(scope, target)).not.toThrow();
    expect(() => assertControllerDownloadScope(scope, { ...target, teamId: 'another-managed-team' })).toThrow();
    expect(() => assertControllerDownloadScope(scope, { ...target, seasonId: 'previous-season' })).toThrow();
    expect(() => assertControllerDownloadScope(scope, { matchId: target.matchId })).toThrow();
  });
  it('closes private cached views after an authoritative denial while retaining network uncertainty', () => {
    for (const status of [401, 403, 404]) expect(controllerAuthorityWasDenied(Object.assign(new Error('Service denied access'), { status }))).toBe(true);
    expect(controllerAuthorityWasDenied(new Error('Failed to fetch'))).toBe(false);
    expect(controllerAuthorityWasDenied({ status: 503, code: 'HTTP_FAILURE' })).toBe(false);
    try { controllerCacheScope({ ...identity, memberships: [] }, target, 100); throw new Error('Expected denial'); } catch (error) { expect(controllerAuthorityWasDenied(error)).toBe(true); }
    try { assertControllerDownloadScope(controllerCacheScope(identity, target, 100), { ...target, teamId: 'another-team' }); throw new Error('Expected mismatch'); } catch (error) { expect(controllerAuthorityWasDenied(error)).toBe(true); }
  });
});
