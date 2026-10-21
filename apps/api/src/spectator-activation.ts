import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AccessError } from "../../../packages/application/src/access";
import { invitationTokenHashInput } from "../../../packages/application/src/invitation-credentials";
import type { ActivationPolicy, ActivationProvider } from "./activation";
export interface SpectatorInvitationCapability {
  id: string;
  clubId: string;
  teamId: string;
  seasonId: string;
  expiresAt: number;
  policyVersion: string;
}
export interface SpectatorActivationAccount {
  accountId: string;
  invitationId: string;
  username: string;
  state: "provisioning" | "pending_activation" | "active";
  issuer: string | null;
  subject: string | null;
}
export interface SpectatorActivationAttempt {
  id: string;
  accountId: string;
  deviceId: string;
  flowId: string | null;
  expiresAt: number;
  createdAt: number;
  state: "provisioning" | "pending_activation" | "completed" | "cancelled";
}
export interface SpectatorActivationRepository {
  withCapability<T>(
    input: {
      tokenHash: string;
      activationId?: string;
      provisionAccountId?: string;
      completionVerified?: true;
      nowMs: number;
    },
    work: () => Promise<T>,
  ): Promise<T>;
  invitation(tokenHash: string): Promise<SpectatorInvitationCapability | null>;
  reserveAccount(input: {
    invitation: SpectatorInvitationCapability;
    tokenHash: string;
    accountId: string;
    username: string;
    requestId: string;
    signature: string;
    nowMs: number;
  }): Promise<SpectatorActivationAccount>;
  bindProvider(
    accountId: string,
    issuer: string,
    subject: string,
  ): Promise<SpectatorActivationAccount>;
  reserveAttempt(input: {
    accountId: string;
    id: string;
    requestId: string;
    signature: string;
    deviceId: string;
    expiresAt: number;
    nowMs: number;
  }): Promise<SpectatorActivationAttempt>;
  bindFlow(
    attemptId: string,
    flowId: string,
    expiresAt: number,
  ): Promise<SpectatorActivationAttempt>;
  findAttempt(
    tokenHash: string,
    activationId?: string,
  ): Promise<{
    account: SpectatorActivationAccount;
    attempt: SpectatorActivationAttempt;
  } | null>;
  complete(input: {
    tokenHash: string;
    invitation: SpectatorInvitationCapability;
    account: SpectatorActivationAccount;
    attempt: SpectatorActivationAttempt;
    nowMs: number;
  }): Promise<void>;
}
export interface SpectatorActivationResponse {
  accountId: string;
  username: string;
  identityActionUrl: string;
  expiresAt: string;
}
const opaque = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(v);
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
function unavailable(): never {
  throw new AccessError(
    "ACTIVATION_UNAVAILABLE",
    410,
    "This invitation cannot be activated. Ask its issuer for a current invitation or sign in with an existing account.",
  );
}
export function spectatorInvitationHash(token: string): string {
  try {
    return createHash("sha256")
      .update(invitationTokenHashInput(token))
      .digest("hex");
  } catch {
    return unavailable();
  }
}
function username() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return `LB${Array.from(randomBytes(12), (byte) => alphabet[byte & 31]).join("")}`;
}
/** Token-bound username-only provisioning. No membership or adult eligibility is created here. */
export class SpectatorActivationService {
  readonly configured: boolean;
  constructor(
    private readonly options: {
      repository: SpectatorActivationRepository;
      provider?: ActivationProvider;
      policy?: ActivationPolicy;
      now?: () => number;
    },
  ) {
    const { provider, policy } = options;
    if (
      policy &&
      (!opaque(policy.version) ||
        policy.fictionalOnly !== true ||
        !Number.isSafeInteger(policy.activationTtlMs) ||
        policy.activationTtlMs <= 0)
    )
      throw new Error(
        "Configure an explicit versioned fictional activation policy and positive lifetime.",
      );
    if (provider) {
      const issuer = new URL(provider.issuer);
      if (
        issuer.protocol !== "https:" ||
        issuer.username ||
        issuer.password ||
        issuer.hash ||
        issuer.search ||
        !provider.credentialSetupOrigins.length ||
        provider.credentialSetupOrigins.some((origin) => {
          const url = new URL(origin);
          return url.protocol !== "https:" || url.origin !== origin;
        })
      )
        throw new Error("Configure exact trusted HTTPS credential origins.");
    }
    this.configured = Boolean(provider && policy);
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private enabled() {
    if (!this.options.provider || !this.options.policy)
      throw new AccessError(
        "ACTIVATION_NOT_CONFIGURED",
        503,
        "Invitation activation requires an explicitly configured provider and policy.",
      );
    return { provider: this.options.provider, policy: this.options.policy };
  }
  private async available(hash: string) {
    const invitation = await this.options.repository.invitation(hash);
    if (
      !invitation ||
      invitation.expiresAt <= this.now() ||
      invitation.policyVersion !== this.enabled().policy.version
    )
      unavailable();
    return invitation;
  }
  async preflight(input: { token: string }) {
    this.enabled();
    const tokenHash = spectatorInvitationHash(input.token);
    return this.options.repository.withCapability(
      { tokenHash, nowMs: this.now() },
      async () => {
        const invitation = await this.available(tokenHash);
        return {
          invitationId: invitation.id,
          expiresAt: new Date(invitation.expiresAt).toISOString(),
          policyVersion: invitation.policyVersion,
        };
      },
    );
  }
  async ownsActivationToken(token: string, activationId?: string) {
    if (!this.configured || !uuid(activationId)) return false;
    let tokenHash: string;
    try {
      tokenHash = spectatorInvitationHash(token);
    } catch {
      return false;
    }
    return this.options.repository.withCapability(
      { tokenHash, activationId, nowMs: this.now() },
      async () =>
        Boolean(
          await this.options.repository.findAttempt(tokenHash, activationId),
        ),
    );
  }
  async activate(input: {
    token: string;
    deviceId: string;
    policyVersion: string;
    requestId: string;
  }): Promise<SpectatorActivationResponse> {
    const { provider, policy } = this.enabled();
    if (
      !opaque(input.deviceId) ||
      !opaque(input.requestId) ||
      input.policyVersion !== policy.version
    )
      unavailable();
    const tokenHash = spectatorInvitationHash(input.token),
      candidateId = randomUUID();
    const signature = createHash("sha256")
      .update(JSON.stringify([input.deviceId, input.policyVersion]))
      .digest("hex");
    let account = await this.options.repository.withCapability(
      { tokenHash, provisionAccountId: candidateId, nowMs: this.now() },
      async () =>
        this.options.repository.reserveAccount({
          invitation: await this.available(tokenHash),
          tokenHash,
          accountId: candidateId,
          username: username(),
          requestId: input.requestId,
          signature,
          nowMs: this.now(),
        }),
    );
    if (account.state === "active") unavailable();
    if (!account.issuer || !account.subject) {
      const provision = await this.providerCall(() =>
        provider.provisionPending({
          operationId: `pending:${account.accountId}`,
          accountId: account.accountId,
          username: account.username,
          classification: "unclassified",
          emailRequired: false,
        }),
      );
      if (
        provision.issuer !== provider.issuer ||
        provision.username.toLowerCase() !== account.username.toLowerCase() ||
        !provision.subject ||
        provision.pending !== true ||
        provision.credentialConfigured !== false
      )
        unavailable();
      account = await this.options.repository.withCapability(
        { tokenHash, provisionAccountId: account.accountId, nowMs: this.now() },
        async () => {
          await this.available(tokenHash);
          return this.options.repository.bindProvider(
            account.accountId,
            provision.issuer,
            provision.subject,
          );
        },
      );
    }
    const attempt = await this.options.repository.withCapability(
      { tokenHash, nowMs: this.now() },
      async () => {
        const invitation = await this.available(tokenHash);
        return this.options.repository.reserveAttempt({
          accountId: account.accountId,
          id: randomUUID(),
          requestId: input.requestId,
          signature,
          deviceId: input.deviceId,
          expiresAt: Math.min(
            invitation.expiresAt,
            this.now() + policy.activationTtlMs,
          ),
          nowMs: this.now(),
        });
      },
    );
    const flow = await this.providerCall(() =>
      provider.beginCredentialSetup({
        operationId: `activation:${attempt.id}`,
        accountId: account.accountId,
        issuer: account.issuer!,
        subject: account.subject!,
        username: account.username,
        expiresAt: attempt.expiresAt,
      }),
    );
    const url = new URL(flow.setupUrl);
    if (
      !provider.credentialSetupOrigins.includes(url.origin) ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      !url.pathname.includes("/login-actions/") ||
      flow.flowId !== attempt.id ||
      !Number.isSafeInteger(flow.expiresAt) ||
      flow.expiresAt > attempt.expiresAt ||
      flow.expiresAt <= this.now()
    )
      unavailable();
    const bound = await this.options.repository.withCapability(
      { tokenHash, activationId: attempt.id, nowMs: this.now() },
      async () => {
        await this.available(tokenHash);
        return this.options.repository.bindFlow(
          attempt.id,
          flow.flowId,
          flow.expiresAt,
        );
      },
    );
    // Nonsecret metadata is stripped by the trusted client before opening the provider URL.
    url.hash = new URLSearchParams({
      longballActivation: attempt.id,
    }).toString();
    return {
      accountId: account.accountId,
      username: account.username,
      identityActionUrl: url.href,
      expiresAt: new Date(bound.expiresAt).toISOString(),
    };
  }
  async completeActivation(input: {
    activationId: string;
    token: string;
    completionProof: string;
  }): Promise<{ status: "complete"; signInRequired: true }> {
    const { provider } = this.enabled();
    if (
      !uuid(input.activationId) ||
      typeof input.completionProof !== "string" ||
      input.completionProof.length < 32 ||
      input.completionProof.length > 16384
    )
      unavailable();
    const tokenHash = spectatorInvitationHash(input.token);
    const source = await this.options.repository.withCapability(
      { tokenHash, activationId: input.activationId, nowMs: this.now() },
      async () => {
        await this.available(tokenHash);
        const found = await this.options.repository.findAttempt(
          tokenHash,
          input.activationId,
        );
        if (
          !found ||
          !["pending_activation", "completed"].includes(found.attempt.state) ||
          !found.attempt.flowId ||
          found.attempt.expiresAt <= this.now() ||
          !found.account.issuer ||
          !found.account.subject
        )
          unavailable();
        return found;
      },
    );
    const { account, attempt } = source;
    const proof = await this.providerCall(() =>
      provider.verifyCredentialSetup({
        operationId: `activation:${attempt.id}`,
        flowId: attempt.flowId!,
        issuer: account.issuer!,
        subject: account.subject!,
        completionProof: input.completionProof,
      }),
    );
    if (
      proof.issuer !== account.issuer ||
      proof.subject !== account.subject ||
      proof.flowId !== attempt.flowId ||
      proof.credentialConfigured !== true ||
      proof.recoveryMaterialIssued !== true ||
      !Number.isSafeInteger(proof.completedAt) ||
      proof.completedAt < attempt.createdAt ||
      proof.completedAt >= attempt.expiresAt ||
      proof.completedAt > this.now() + 30_000
    )
      unavailable();
    await this.options.repository.withCapability(
      {
        tokenHash,
        activationId: attempt.id,
        completionVerified: true,
        nowMs: this.now(),
      },
      async () => {
        const invitation = await this.available(tokenHash);
        await this.options.repository.complete({
          tokenHash,
          invitation,
          account,
          attempt,
          nowMs: this.now(),
        });
      },
    );
    return { status: "complete", signInRequired: true };
  }
  private async providerCall<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch {
      throw new AccessError(
        "PROVIDER_FLOW_UNAVAILABLE",
        503,
        "Provider activation is incomplete. Retain this invitation and retry; no membership was granted.",
      );
    }
  }
}
