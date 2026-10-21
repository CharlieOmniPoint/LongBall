import { describe, expect, it } from "vitest";
import { parseInvitationProviderSetup } from "./spectator-activation-core";
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
