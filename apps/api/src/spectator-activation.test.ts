import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  SpectatorActivationService,
  spectatorInvitationHash,
  type SpectatorActivationRepository,
  type SpectatorActivationAccount,
  type SpectatorActivationAttempt,
} from "./spectator-activation";
import type { ActivationProvider } from "./activation";
let now = 1000;
function fixture() {
  const token = randomBytes(32).toString("base64url"),
    tokenHash = spectatorInvitationHash(token);
  let revoked = false,
    account: SpectatorActivationAccount | null = null,
    attempt: SpectatorActivationAttempt | null = null;
  const invitation = {
    id: "invite",
    clubId: "club",
    teamId: "team",
    seasonId: "season",
    expiresAt: 100_000,
    policyVersion: "explicit-fixture",
    context: { clubName: 'Richmond Rovers', teamName: 'Roma', ageGroup: 'U10', seasonLabel: '2026/27', inviterLabel: 'Team manager' as const },
  };
  let context: { tokenHash: string; completionVerified?: true } | null = null;
  const repository: SpectatorActivationRepository = {
    async withCapability(input, work) {
      context = input;
      try {
        return await work();
      } finally {
        context = null;
      }
    },
    async invitation(hash) {
      return !revoked && hash === tokenHash ? invitation : null;
    },
    async reserveAccount(input) {
      account ??= {
        accountId: input.accountId,
        invitationId: invitation.id,
        username: input.username,
        state: "provisioning",
        issuer: null,
        subject: null,
      };
      return { ...account };
    },
    async bindProvider(_id, issuer, subject) {
      account = { ...account!, issuer, subject, state: "pending_activation" };
      return { ...account };
    },
    async reserveAttempt(input) {
      if (attempt && attempt.deviceId !== input.deviceId)
        throw new Error("Different device");
      attempt ??= {
        id: input.id,
        accountId: input.accountId,
        deviceId: input.deviceId,
        flowId: null,
        expiresAt: input.expiresAt,
        createdAt: input.nowMs,
        state: "provisioning",
      };
      return { ...attempt };
    },
    async bindFlow(_id, flowId, expiresAt) {
      attempt = { ...attempt!, flowId, expiresAt, state: "pending_activation" };
      return { ...attempt };
    },
    async findAttempt(hash, id) {
      return hash === tokenHash &&
        account &&
        attempt &&
        (!id || id === attempt.id)
        ? { account: { ...account }, attempt: { ...attempt } }
        : null;
    },
    async complete() {
      if (context?.completionVerified !== true)
        throw new Error("Unverified context");
      account = { ...account!, state: "active" };
      attempt = { ...attempt!, state: "completed" };
    },
  };
  const provider: ActivationProvider = {
    issuer: "https://provider.example/realms/trial",
    credentialSetupOrigins: ["https://provider.example"],
    provisionPending: vi.fn<ActivationProvider["provisionPending"]>(
      async (input) => {
        expect(context).toBeNull();
        return {
          issuer: provider.issuer,
          subject: input.accountId,
          username: input.username,
          pending: true,
          credentialConfigured: false,
        };
      },
    ),
    beginCredentialSetup: vi.fn(async (input) => {
      expect(context).toBeNull();
      return {
        flowId: input.operationId.slice(11),
        setupUrl: `${provider.issuer}/login-actions/action-token?key=provider-only`,
        expiresAt: input.expiresAt,
      };
    }),
    cancelCredentialSetup: vi.fn(),
    verifyCredentialSetup: vi.fn<ActivationProvider["verifyCredentialSetup"]>(
      async (input) => {
        expect(context).toBeNull();
        if (input.completionProof !== "p".repeat(43))
          throw new Error("Unverified proof");
        return {
          issuer: input.issuer,
          subject: input.subject,
          flowId: input.flowId,
          completedAt: now,
          credentialConfigured: true,
          recoveryMaterialIssued: true,
        };
      },
    ),
  };
  const service = new SpectatorActivationService({
    repository,
    provider,
    policy: {
      version: "explicit-fixture",
      activationTtlMs: 90_000,
      fictionalOnly: true,
    },
    now: () => now,
  });
  const input = {
    token,
    deviceId: "fixture-device",
    policyVersion: "explicit-fixture",
    requestId: "request-one",
  };
  return {
    service,
    repository,
    provider,
    input,
    token,
    tokenHash,
    revoke: () => {
      revoked = true;
    },
    account: () => account,
    attempt: () => attempt,
  };
}
beforeEach(() => {
  now = 1000;
});
describe("invitation-bound username credential activation", () => {
  it("returns only minimal preflight and no account enumeration for invalid tokens", async () => {
    const f = fixture();
    expect(await f.service.preflight({ token: f.token })).toEqual({
      invitationId: "invite",
      teamId: 'team',
      seasonId: 'season',
      expiresAt: new Date(100_000).toISOString(),
      policyVersion: "explicit-fixture",
      context: { clubName: 'Richmond Rovers', teamName: 'Roma', ageGroup: 'U10', seasonLabel: '2026/27', inviterLabel: 'Team manager' },
    });
    await expect(
      f.service.preflight({ token: randomBytes(32).toString("base64url") }),
    ).rejects.toMatchObject({ code: "ACTIVATION_UNAVAILABLE" });
    expect(f.provider.provisionPending).not.toHaveBeenCalled();
  });
  it("reserves one unclassified identity and continues the same setup after lost response", async () => {
    const f = fixture();
    const first = await f.service.activate(f.input),
      again = await f.service.activate({
        ...f.input,
        requestId: "new-header-after-lost-response",
      });
    expect(again).toEqual(first);
    expect(f.provider.provisionPending).toHaveBeenCalledTimes(1);
    expect(f.provider.provisionPending).toHaveBeenCalledWith(
      expect.objectContaining({
        classification: "unclassified",
        emailRequired: false,
      }),
    );
    expect(f.account()?.state).toBe("pending_activation");
    expect(new URL(first.identityActionUrl).hash).toBe(
      `#longballActivation=${f.attempt()!.id}`,
    );
    expect(first.identityActionUrl).not.toContain(f.token);
    expect(Object.keys(first).sort()).toEqual([
      "accountId",
      "expiresAt",
      "identityActionUrl",
      "username",
    ]);
  });
  it("requires original token, exact attempt and independent provider completion before activation", async () => {
    const f = fixture();
    await f.service.activate(f.input);
    const activationId = f.attempt()!.id;
    expect(await f.service.ownsActivationToken(f.token, activationId)).toBe(
      true,
    );
    await expect(
      f.service.completeActivation({
        activationId,
        token: randomBytes(32).toString("base64url"),
        completionProof: "p".repeat(43),
      }),
    ).rejects.toMatchObject({ code: "ACTIVATION_UNAVAILABLE" });
    expect(f.provider.verifyCredentialSetup).not.toHaveBeenCalled();
    await expect(
      f.service.completeActivation({
        activationId,
        token: f.token,
        completionProof: "wrong".repeat(10),
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_FLOW_UNAVAILABLE" });
    expect(f.account()?.state).toBe("pending_activation");
    expect(
      await f.service.completeActivation({
        activationId,
        token: f.token,
        completionProof: "p".repeat(43),
      }),
    ).toEqual({ status: "complete", signInRequired: true });
    expect(f.account()?.state).toBe("active");
    expect(
      await f.service.completeActivation({
        activationId,
        token: f.token,
        completionProof: "p".repeat(43),
      }),
    ).toEqual({ status: "complete", signInRequired: true });
  });
  it("rechecks revocation after provider work and never activates a revoked invitation", async () => {
    const f = fixture();
    await f.service.activate(f.input);
    vi.mocked(f.provider.verifyCredentialSetup).mockImplementation(
      async (input) => {
        f.revoke();
        return {
          issuer: input.issuer,
          subject: input.subject,
          flowId: input.flowId,
          completedAt: now,
          credentialConfigured: true,
          recoveryMaterialIssued: true,
        };
      },
    );
    await expect(
      f.service.completeActivation({
        activationId: f.attempt()!.id,
        token: f.token,
        completionProof: "p".repeat(43),
      }),
    ).rejects.toMatchObject({ code: "ACTIVATION_UNAVAILABLE" });
    expect(f.account()?.state).toBe("pending_activation");
  });
  it("refuses expiry, absent policy and foreign provider subject evidence", async () => {
    const f = fixture();
    await f.service.activate(f.input);
    vi.mocked(f.provider.verifyCredentialSetup).mockImplementation(
      async (input) => ({
        issuer: input.issuer,
        subject: "other-subject",
        flowId: input.flowId,
        completedAt: now,
        credentialConfigured: true,
        recoveryMaterialIssued: true,
      }),
    );
    await expect(
      f.service.completeActivation({
        activationId: f.attempt()!.id,
        token: f.token,
        completionProof: "p".repeat(43),
      }),
    ).rejects.toMatchObject({ code: "ACTIVATION_UNAVAILABLE" });
    now = 100_000;
    await expect(f.service.preflight({ token: f.token })).rejects.toMatchObject(
      { code: "ACTIVATION_UNAVAILABLE" },
    );
    const absent = new SpectatorActivationService({ repository: f.repository });
    await expect(absent.preflight({ token: f.token })).rejects.toMatchObject({
      code: "ACTIVATION_NOT_CONFIGURED",
    });
  });
});
