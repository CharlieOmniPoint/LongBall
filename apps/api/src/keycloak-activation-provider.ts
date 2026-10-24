import type { ActivationProvider } from "./activation";

/** Server-only adapter for the pinned, explicit fictional Keycloak extension trial. */
export interface KeycloakActivationProviderOptions {
  issuer: string;
  serviceClientId: "longball-activation-service";
  serviceClientSecret: () => Promise<string>;
  publicClientId: string;
  completionRedirectUri: string;
  fetch?: typeof fetch;
  now?: () => number;
}
function unavailable(): never {
  // Never expose provider response text, setup URLs, proof or service credentials in errors.
  throw new Error(
    "The configured identity provider could not complete activation. Retain the request and retry through the agreed process.",
  );
}
export function createKeycloakActivationProvider(
  options: KeycloakActivationProviderOptions,
): ActivationProvider {
  const issuer = new URL(options.issuer);
  const redirect = new URL(options.completionRedirectUri);
  if (
    issuer.protocol !== "https:" ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash ||
    issuer.pathname.endsWith("/") ||
    !/^\/realms\/[^/]+$/.test(issuer.pathname) ||
    !options.publicClientId ||
    options.serviceClientId !== "longball-activation-service" ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash ||
    !["https:", "longball:"].includes(redirect.protocol)
  )
    throw new Error(
      "Configure exact HTTPS Keycloak issuer, public client and registered activation return URI.",
    );
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let serviceToken: { value: string; until: number } | null = null;
  let pendingToken: Promise<string> | null = null;
  async function json(
    url: string,
    init: RequestInit,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await request(url, {
        ...init,
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) unavailable();
      const body = await response.text();
      if (body.length > 32_000) unavailable();
      const parsed: unknown = JSON.parse(body);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        unavailable();
      return parsed as Record<string, unknown>;
    } catch {
      return unavailable();
    } finally {
      clearTimeout(timer);
    }
  }
  async function token(): Promise<string> {
    if (serviceToken && serviceToken.until > now()) return serviceToken.value;
    if (!pendingToken)
      pendingToken = (async () => {
        const secret = await options.serviceClientSecret();
        if (!secret || secret.length > 4096) unavailable();
        const value = await json(
          `${issuer.href}/protocol/openid-connect/token`,
          {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "client_credentials",
              client_id: options.serviceClientId,
              client_secret: secret,
            }).toString(),
          },
        );
        if (
          typeof value.access_token !== "string" ||
          typeof value.expires_in !== "number" ||
          value.expires_in <= 0 ||
          value.token_type !== "Bearer"
        )
          unavailable();
        serviceToken = {
          value: value.access_token,
          until: now() + Math.max(0, value.expires_in * 1000 - 10_000),
        };
        return serviceToken.value;
      })().finally(() => {
        pendingToken = null;
      });
    return pendingToken;
  }
  async function call(
    path: string,
    input: object,
  ): Promise<Record<string, unknown>> {
    try {
      const bearer = await token();
      return await json(`${issuer.href}/longball-activation/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify(input),
      });
    } catch {
      return unavailable();
    }
  }
  const provider: ActivationProvider = {
    issuer: issuer.href,
    credentialSetupOrigins: [issuer.origin],
    async provisionPending(input) {
      const value = await call("pending", input);
      if (
        value.issuer !== issuer.href ||
        value.subject !== input.accountId ||
        typeof value.username !== "string" ||
        value.username.toLowerCase() !== input.username.toLowerCase() ||
        value.pending !== true ||
        value.credentialConfigured !== false
      )
        unavailable();
      return {
        issuer: issuer.href,
        subject: input.accountId,
        username: input.username,
        pending: true,
        credentialConfigured: false,
      };
    },
    async beginCredentialSetup(input) {
      if (input.issuer !== issuer.href) unavailable();
      const value = await call("begin", {
        ...input,
        redirectUri: options.completionRedirectUri,
        clientId: options.publicClientId,
      });
      if (
        typeof value.flowId !== "string" ||
        value.flowId !== input.operationId.slice("activation:".length) ||
        typeof value.setupUrl !== "string" ||
        typeof value.expiresAt !== "number" ||
        !Number.isSafeInteger(value.expiresAt) ||
        value.expiresAt > input.expiresAt ||
        value.expiresAt <= now()
      )
        unavailable();
      const url = new URL(value.setupUrl);
      if (
        url.origin !== issuer.origin ||
        url.pathname !== `${issuer.pathname}/login-actions/action-token` ||
        url.username ||
        url.password ||
        url.hash
      )
        unavailable();
      return {
        flowId: value.flowId,
        setupUrl: value.setupUrl,
        expiresAt: value.expiresAt,
      };
    },
    async cancelCredentialSetup(input) {
      if (input.issuer !== issuer.href) unavailable();
      const value = await call("cancel", input);
      if (value.cancelled !== true) unavailable();
    },
    async verifyCredentialSetup(input) {
      if (input.issuer !== issuer.href) unavailable();
      const value = await call("verify", input);
      if (
        value.issuer !== issuer.href ||
        value.subject !== input.subject ||
        value.flowId !== input.flowId ||
        typeof value.completedAt !== "number" ||
        !Number.isSafeInteger(value.completedAt) ||
        value.completedAt > now() ||
        value.credentialConfigured !== true ||
        value.recoveryMaterialIssued !== true
      )
        unavailable();
      return {
        issuer: issuer.href,
        subject: input.subject,
        flowId: input.flowId,
        completedAt: value.completedAt,
        credentialConfigured: true,
        recoveryMaterialIssued: true,
      };
    },
  };
  return provider;
}
