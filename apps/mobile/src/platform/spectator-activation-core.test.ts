import { describe, expect, it } from "vitest";
import { parseInvitationActivationInfo, parseInvitationProviderSetup } from "./spectator-activation-core";
const id = "81e52847-672d-4500-b009-21414a90677b";
const config = {
  issuer: "https://identity.example/realms/trial",
  apiBaseUrl: "https://api.example",
  clientId: "app",
  redirectUri: "longball://auth/callback",
};
const body = () => ({
  accountId: id,
  username: "LBABCDEFGHJK23",
  identityActionUrl: `${config.issuer}/login-actions/action-token?key=opaque#longballActivation=${id}`,
  expiresAt: "2026-10-21T12:00:00.000Z",
});
const info = () => ({ invitationId: 'invitation', teamId: 'actual-team', seasonId: 'actual-season', expiresAt: '2026-10-21T12:00:00.000Z', policyVersion: 'approved-policy', context: { clubName: 'Richmond Rovers', teamName: 'Roma', ageGroup: 'U10', seasonLabel: '2026/27', inviterLabel: 'Team manager' } });
describe('server-bound invitation preflight display context', () => {
  it('accepts only the exact reviewed metadata and copies labels without URL hint authority', () => {
    const original = info(), parsed = parseInvitationActivationInfo(original, 0);
    expect(parsed).toEqual(original); original.context.teamName = 'Changed externally'; expect(parsed.context.teamName).toBe('Roma');
  });
  it('refuses expired or malformed context, private person fields, unknown roles and extra destination fields', () => {
    for (const value of [{ ...info(), expiresAt: 'invalid' }, { ...info(), expiresAt: new Date(0).toISOString() }, { ...info(), context: { ...info().context, playerNames: ['Private child'] } }, { ...info(), context: { ...info().context, inviterLabel: 'Alex Smith' } }, { ...info(), context: { ...info().context, clubName: '' } }, { ...info(), providedUrlLabel: 'Different team' }]) expect(() => parseInvitationActivationInfo(value, 1)).toThrow();
  });
});
describe("invitation provider setup metadata", () => {
  it("strips the sole nonsecret attempt marker before opening the configured provider", () => {
    const parsed = parseInvitationProviderSetup(body(), config, 0);
    expect(parsed.activationId).toBe(id);
    expect(new URL(parsed.providerSetupUrl).hash).toBe("");
    expect(parsed).not.toHaveProperty("token");
  });
  it.each([
    "https://evil.example/login-actions/action-token#longballActivation=" + id,
    `${config.issuer}/untrusted#longballActivation=${id}`,
    `${config.issuer}/login-actions/action-token#longballActivation=${id}&longballActivation=${id}`,
    `${config.issuer}/login-actions/action-token#longballActivation=${id}&token=secret`,
  ])("rejects untrusted or ambiguous provider metadata", (url) =>
    expect(() =>
      parseInvitationProviderSetup(
        { ...body(), identityActionUrl: url },
        config,
        0,
      ),
    ).toThrow(),
  );
  it("rejects expired setup and unexpected response fields", () => {
    expect(() =>
      parseInvitationProviderSetup(
        body(),
        config,
        Date.parse(body().expiresAt),
      ),
    ).toThrow();
    expect(() =>
      parseInvitationProviderSetup(
        { ...body(), classification: "adult_individual" },
        config,
        0,
      ),
    ).toThrow();
  });
});
