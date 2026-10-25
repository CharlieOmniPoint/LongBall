import { describe, expect, it, vi } from "vitest";
import { createKeycloakActivationProvider } from "./keycloak-activation-provider";
import { DEFAULT_SIGN_IN_RULES } from "../../../packages/application/src/identity-policy";
const issuer = "https://identity.example/realms/fictional";
const operationId = "activation:81e52847-672d-4500-b009-21414a90677b";
function fixture(outputs: unknown[]) {
  const request = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(outputs.shift()), { status: 200 }),
  );
  const provider = createKeycloakActivationProvider({
    issuer,
    serviceClientId: "longball-activation-service",
    serviceClientSecret: async () => "fixture-service-secret",
    publicClientId: "public-mobile",
    completionRedirectUri: "longball://activation/callback",
    fetch: request,
    now: () => 10_000,
  });
  return { request, provider };
}
describe("Keycloak activation HTTP adapter (transport fixtures, not provider proof)", () => {
  it("applies the exact complete revisioned sign-in rules through the trusted service boundary", async () => {
    const { provider, request } = fixture([
      { access_token: "fixture-bearer", token_type: "Bearer", expires_in: 60 },
      { revision: 0, enforced: true },
    ]);
    await expect(provider.applySignInRules!({ revision: 0, rules: DEFAULT_SIGN_IN_RULES })).resolves.toEqual({ revision: 0, enforced: true });
    expect(request.mock.calls[1][0]).toBe(`${issuer}/longball-activation/sign-in-rules`);
    expect(request.mock.calls[1][1]).toMatchObject({ redirect: "error", headers: { authorization: "Bearer fixture-bearer" } });
    expect(JSON.parse(request.mock.calls[1][1]!.body as string)).toEqual({ revision: 0, rules: DEFAULT_SIGN_IN_RULES });
  });
  it("refuses missing or substituted provider policy acknowledgement", async () => {
    for (const acknowledgement of [{ revision: 8, enforced: true }, { revision: 7 }, { revision: 7, enforced: false }]) {
      const { provider } = fixture([
        { access_token: "fixture-bearer", token_type: "Bearer", expires_in: 60 },
        acknowledgement,
      ]);
      await expect(provider.applySignInRules!({ revision: 7, rules: DEFAULT_SIGN_IN_RULES })).rejects.toThrow("configured identity provider");
    }
  });
  it("rejects unbounded rule input before any provider request", async () => {
    const { provider, request } = fixture([]);
    await expect(provider.applySignInRules!({ revision: -1, rules: DEFAULT_SIGN_IN_RULES })).rejects.toThrow("configured identity provider");
    await expect(provider.applySignInRules!({ revision: 1, rules: { ...DEFAULT_SIGN_IN_RULES, password: { ...DEFAULT_SIGN_IN_RULES.password, minLength: 4 } } })).rejects.toThrow("sign-in rules");
    expect(request).not.toHaveBeenCalled();
  });
  it("uses client credentials only on the configured token endpoint and binds provisioned subject", async () => {
    const { provider, request } = fixture([
      { access_token: "fixture-bearer", token_type: "Bearer", expires_in: 60 },
      {
        issuer,
        subject: "account-uuid",
        username: "LBAAAAAAAAAAAA",
        pending: true,
        credentialConfigured: false,
      },
    ]);
    await provider.provisionPending({
      operationId: "pending:account-uuid",
      accountId: "account-uuid",
      username: "LBAAAAAAAAAAAA",
      classification: "child_shared",
      emailRequired: false,
    });
    expect(request.mock.calls[0][0]).toBe(
      `${issuer}/protocol/openid-connect/token`,
    );
    const form = new URLSearchParams(request.mock.calls[0][1]!.body as string);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.has("password")).toBe(false);
    expect(request.mock.calls[1][1]).toMatchObject({
      redirect: "error",
      headers: { authorization: "Bearer fixture-bearer" },
    });
  });
  it("retains exact configured redirect/client and rejects a substituted setup URL", async () => {
    const { provider, request } = fixture([
      { access_token: "fixture-bearer", token_type: "Bearer", expires_in: 60 },
      {
        flowId: operationId.slice("activation:".length),
        setupUrl: "https://evil.example/stolen",
        expiresAt: 20_000,
      },
    ]);
    await expect(
      provider.beginCredentialSetup({
        operationId,
        accountId: "account",
        issuer,
        subject: "subject",
        username: "username",
        expiresAt: 20_000,
      }),
    ).rejects.toThrow("configured identity provider");
    expect(JSON.parse(request.mock.calls[1][1]!.body as string)).toMatchObject({
      clientId: "public-mobile",
      redirectUri: "longball://activation/callback",
    });
  });
  it("does not expose provider response text or service secrets on failure", async () => {
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response("private provider trace fixture-secret", { status: 500 }),
    );
    const provider = createKeycloakActivationProvider({
      issuer,
      serviceClientId: "longball-activation-service",
      serviceClientSecret: async () => "fixture-secret",
      publicClientId: "public-mobile",
      completionRedirectUri: "longball://activation/callback",
      fetch: request,
    });
    await expect(
      provider.cancelCredentialSetup({
        operationId,
        issuer,
        subject: "subject",
      }),
    ).rejects.toThrow(/^The configured identity provider/);
  });
  it("requires verified completion with exact issuer, subject, flow and credential evidence", async () => {
    const { provider } = fixture([
      { access_token: "fixture-bearer", token_type: "Bearer", expires_in: 60 },
      {
        issuer,
        subject: "wrong-subject",
        flowId: "flow",
        completedAt: 9_000,
        credentialConfigured: true,
        recoveryMaterialIssued: true,
      },
    ]);
    await expect(
      provider.verifyCredentialSetup({
        operationId,
        issuer,
        subject: "subject",
        flowId: "flow",
        completionProof: "fixture-proof",
      }),
    ).rejects.toThrow("configured identity provider");
  });
});
