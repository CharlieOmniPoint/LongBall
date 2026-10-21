import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "../../../packages/application/src/access";
import {
  DevelopmentActivationService,
  type ActivationPolicy,
  type ActivationProvider,
  type PendingChildInput,
} from "./activation";
import { DevelopmentStore, SYNTHETIC_IDS } from "./store";

const at = Date.parse("2026-10-21T10:00:00Z");
// A deliberately named test-only policy, not acceptance of the proposed 48-hour expiry.
const policy: ActivationPolicy = {
  version: "fictional-test-policy",
  activationTtlMs: 60_000,
  fictionalOnly: true,
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** In-memory contract fixture. It is not an implementation of a real identity provider. */
function fixtureProvider() {
  const users = new Map<
    string,
    {
      issuer: string;
      subject: string;
      username: string;
      pending: true;
      credentialConfigured: false;
    }
  >();
  const flows = new Map<
    string,
    { flowId: string; setupUrl: string; expiresAt: number }
  >();
  const cancelled = new Set<string>();
  let failProvisionAfterCreation = false;
  let failBeginAfterCreation = false;
  let failCancellation = false;
  let beforeBegin: (() => Promise<void>) | null = null;
  let proofPatch: Record<string, unknown> = {};
  const provider: ActivationProvider = {
    issuer: "https://identity.example.invalid/realms/longball",
    credentialSetupOrigins: ["https://identity.example.invalid"],
    async provisionPending(input) {
      expect(input.emailRequired).toBe(false);
      expect(input.classification).toBe("child_shared");
      expect(input).not.toHaveProperty("password");
      let result = users.get(input.operationId);
      if (!result) {
        result = {
          issuer: provider.issuer,
          subject: randomUUID(),
          username: input.username,
          pending: true,
          credentialConfigured: false,
        };
        users.set(input.operationId, result);
      }
      if (failProvisionAfterCreation) {
        failProvisionAfterCreation = false;
        throw new Error("Uncertain provider response; retain operation");
      }
      return result;
    },
    async beginCredentialSetup(input) {
      if (beforeBegin) await beforeBegin();
      if (cancelled.has(input.operationId))
        throw new Error("Operation was cancelled before it could complete");
      let result = flows.get(input.operationId);
      if (!result) {
        const flowId = `flow-${randomUUID()}`;
        result = {
          flowId,
          setupUrl: `https://identity.example.invalid/setup/${flowId}?ticket=fictional-one-time-ticket`,
          expiresAt: input.expiresAt,
        };
        flows.set(input.operationId, result);
      }
      if (failBeginAfterCreation) {
        failBeginAfterCreation = false;
        throw new Error("Uncertain required-action response");
      }
      return result;
    },
    async cancelCredentialSetup(input) {
      if (failCancellation)
        throw new Error("Provider cancellation unavailable");
      cancelled.add(input.operationId);
      flows.delete(input.operationId);
    },
    async verifyCredentialSetup(input) {
      const flow = flows.get(input.operationId);
      if (
        !flow ||
        cancelled.has(input.operationId) ||
        input.completionProof !== `fixture-proof:${flow.flowId}`
      )
        throw new Error("Invalid provider completion proof");
      return {
        issuer: input.issuer,
        subject: input.subject,
        flowId: flow.flowId,
        completedAt: at,
        credentialConfigured: true,
        recoveryMaterialIssued: true,
        ...proofPatch,
      };
    },
  };
  return {
    provider,
    users,
    flows,
    cancelled,
    uncertainProvision() {
      failProvisionAfterCreation = true;
    },
    uncertainBegin() {
      failBeginAfterCreation = true;
    },
    setCancellationFailure(value: boolean) {
      failCancellation = value;
    },
    setBeginHook(value: (() => Promise<void>) | null) {
      beforeBegin = value;
    },
    patchProof(value: Record<string, unknown>) {
      proofPatch = value;
    },
    proof(activationId: string) {
      return `fixture-proof:${flows.get(`activation:${activationId}`)!.flowId}`;
    },
  };
}

function lab(durable = false) {
  let clock = at;
  const directory = durable
    ? mkdtempSync(join(tmpdir(), "longball-activation-"))
    : null;
  let store = new DevelopmentStore(
    directory ? join(directory, "domain.sqlite") : ":memory:",
    () => clock,
  );
  store.seedSynthetic();
  const manager = store.principal({
    issuer: "urn:longball:synthetic",
    subject: "synthetic-account-manager",
    strongAuth: true,
    authenticatedAt: clock,
  });
  const otherManager = store.principal({
    issuer: "urn:longball:synthetic",
    subject: "synthetic-account-other-manager",
    strongAuth: true,
    authenticatedAt: clock,
  });
  const fixture = fixtureProvider();
  let service = new DevelopmentActivationService({
    store,
    provider: fixture.provider,
    policy,
  });
  const playerId = `fictional-player-${randomUUID()}`;
  const current = store.preparation(
    manager,
    SYNTHETIC_IDS.teamId,
    SYNTHETIC_IDS.seasonId,
  );
  store.preparationCommand(
    manager,
    SYNTHETIC_IDS.teamId,
    SYNTHETIC_IDS.seasonId,
    {
      type: "profile.saved",
      id: randomUUID(),
      expectedRevision: current.revision,
      profile: {
        ...current.profiles[0],
        id: `fictional-profile-${randomUUID()}`,
        playerId,
        displayName: "Fictional pending player",
        shirtNumber: null,
        seasonId: SYNTHETIC_IDS.seasonId,
      },
    },
  );
  const input: PendingChildInput = {
    requestId: randomUUID(),
    teamId: SYNTHETIC_IDS.teamId,
    seasonId: SYNTHETIC_IDS.seasonId,
    playerId,
  };
  cleanups.push(() => {
    store.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  return {
    fixture,
    manager,
    otherManager,
    input,
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    setClock(value: number) {
      clock = value;
    },
    reopen() {
      if (!directory) throw new Error("Use a durable fixture");
      store.close();
      store = new DevelopmentStore(
        join(directory, "domain.sqlite"),
        () => clock,
      );
      service = new DevelopmentActivationService({
        store,
        provider: fixture.provider,
        policy,
      });
    },
    async pending() {
      return service.createPendingChild(manager, input);
    },
    async issued() {
      const pending = await service.createPendingChild(manager, input);
      const issue = {
        requestId: randomUUID(),
        teamId: input.teamId,
        seasonId: input.seasonId,
        accountId: pending.accountId,
      };
      return {
        pending,
        issue,
        activation: await service.issueActivation(manager, issue),
      };
    },
  };
}

describe("F05 pending child activation", () => {
  it("requires an explicit fictional policy and provider, without adopting 48 hours or a bootstrap account", async () => {
    const test = lab();
    const absent = new DevelopmentActivationService({ store: test.store });
    expect(absent.configured).toBe(false);
    await expect(
      absent.createPendingChild(test.manager, test.input),
    ).rejects.toMatchObject({ code: "ACTIVATION_NOT_CONFIGURED", status: 503 });
    expect(
      () =>
        new DevelopmentActivationService({
          store: test.store,
          provider: test.fixture.provider,
          policy: {
            ...policy,
            fictionalOnly: false,
          } as unknown as ActivationPolicy,
        }),
    ).toThrow("fictional");
    expect(
      () =>
        new DevelopmentActivationService({
          store: test.store,
          policy: { ...policy, activationTtlMs: 0 },
        }),
    ).toThrow("expiry");
    expect(
      test.store.database
        .prepare("SELECT id FROM accounts WHERE id='admin'")
        .get(),
    ).toBeUndefined();
  });
  it("allocates a case-insensitive unique username, binds a disabled provider identity and preserves immutable child classification", async () => {
    const test = lab();
    const child = await test.pending();
    expect(child).toMatchObject({
      classification: "child_shared",
      status: "pending_activation",
      signInEnabled: false,
    });
    expect(child.username).toMatch(/^LB[A-HJ-NP-Z2-9]{12}$/);
    expect(
      test.store.database
        .prepare(
          "SELECT account_id FROM lb_activation_children WHERE username=? COLLATE NOCASE",
        )
        .get(child.username.toLowerCase()),
    ).toMatchObject({ account_id: child.accountId });
    const account = test.store.database
      .prepare("SELECT * FROM accounts WHERE id=?")
      .get(child.accountId)!;
    expect(account).toMatchObject({
      classification: "child_shared",
      adult_verified: 0,
      strong_auth_enrolled: 0,
      status: "disabled",
    });
    expect(() =>
      test.store.principal({
        issuer: String(account.issuer),
        subject: String(account.subject),
        strongAuth: true,
        authenticatedAt: at,
      }),
    ).toThrow("not active");
    expect(() =>
      test.store.database
        .prepare(
          "UPDATE accounts SET classification='adult_individual' WHERE id=?",
        )
        .run(child.accountId),
    ).toThrow("immutable");
    await expect(
      test.service.createPendingChild(test.manager, {
        ...test.input,
        classification: "adult_individual",
        password: "never-accepted",
      } as PendingChildInput),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await test.pending()).toEqual(child);
    expect(test.fixture.users.size).toBe(1);
  });
  it("checks team scope and current adult authority before reserving or issuing, including spoofed child claims", async () => {
    const test = lab();
    await expect(
      test.service.createPendingChild(test.otherManager, test.input),
    ).rejects.toMatchObject({ status: 404 });
    const childPrincipal = test.store.principal({
      issuer: "urn:longball:synthetic",
      subject: "synthetic-account-player-01",
      strongAuth: true,
      authenticatedAt: at,
    });
    const forged: Principal = {
      ...childPrincipal,
      identityClassification: "adult_individual",
      adultVerified: true,
    };
    await expect(
      test.service.createPendingChild(forged, test.input),
    ).rejects.toMatchObject({ status: 404 });
    const { pending, issue } = await test.issued();
    await expect(
      test.service.issueActivation(test.otherManager, issue),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      test.store.database
        .prepare("SELECT state FROM lb_activation_children WHERE account_id=?")
        .get(pending.accountId),
    ).toMatchObject({ state: "pending_activation" });
  });
  it("retries uncertain external provisioning after restart with one account, one username and one provider operation", async () => {
    const test = lab(true);
    test.fixture.uncertainProvision();
    await expect(test.pending()).rejects.toMatchObject({
      code: "PROVIDER_FLOW_UNAVAILABLE",
    });
    const before = test.store.database
      .prepare("SELECT account_id,username,state FROM lb_activation_children")
      .get();
    expect(before).toMatchObject({ state: "provisioning" });
    test.reopen();
    const child = await test.pending();
    expect(child.accountId).toBe(before!.account_id);
    expect(child.username).toBe(before!.username);
    expect(test.fixture.users.size).toBe(1);
    await expect(
      test.service.createPendingChild(test.manager, {
        ...test.input,
        playerId: "another-player",
      }),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    expect(test.store.integrity()).toBe("ok");
  });
  it("preserves the pending provider operation when binding fails and rolls back issuance before returning a secret", async () => {
    const test = lab();
    test.store.database.exec(
      "CREATE TRIGGER fixture_fail_binding BEFORE UPDATE OF state ON lb_activation_children WHEN NEW.state='pending_activation' BEGIN SELECT RAISE(ABORT,'fixture binding failure'); END",
    );
    await expect(test.pending()).rejects.toThrow("fixture binding failure");
    expect(
      test.store.database
        .prepare("SELECT state FROM lb_activation_children")
        .get(),
    ).toMatchObject({ state: "provisioning" });
    expect(
      test.store.database
        .prepare(
          "SELECT status,issuer FROM accounts WHERE issuer='urn:longball:pending-activation'",
        )
        .get(),
    ).toMatchObject({ status: "disabled" });
    test.store.database.exec("DROP TRIGGER fixture_fail_binding");
    const child = await test.pending();
    expect(test.fixture.users.size).toBe(1);
    const issue = {
      requestId: randomUUID(),
      teamId: test.input.teamId,
      seasonId: test.input.seasonId,
      accountId: child.accountId,
    };
    test.store.database.exec(
      "CREATE TRIGGER fixture_fail_issuance BEFORE UPDATE OF state ON lb_activation_issues WHEN NEW.state='issued' BEGIN SELECT RAISE(ABORT,'fixture issuance failure'); END",
    );
    await expect(
      test.service.issueActivation(test.manager, issue),
    ).rejects.toThrow("fixture issuance failure");
    expect(
      test.store.database
        .prepare("SELECT COUNT(*) AS count FROM lb_activation_tokens")
        .get(),
    ).toMatchObject({ count: 0 });
    expect(
      test.store.database
        .prepare("SELECT state FROM lb_activation_issues")
        .get(),
    ).toMatchObject({ state: "preparing" });
    test.store.database.exec("DROP TRIGGER fixture_fail_issuance");
    expect(
      (await test.service.issueActivation(test.manager, issue)).token,
    ).toHaveLength(43);
    expect(
      test.store.database
        .prepare("SELECT COUNT(*) AS count FROM lb_activation_tokens")
        .get(),
    ).toMatchObject({ count: 1 });
  });
  it("stores only a cryptographic token hash, returns the plaintext once and reissue invalidates the previous token", async () => {
    const test = lab();
    const { issue, activation } = await test.issued();
    expect(Buffer.from(activation.token, "base64url").length).toBe(32);
    expect(activation.expiresAt).toBe(at + policy.activationTtlMs);
    const stored = test.store.database
      .prepare("SELECT * FROM lb_activation_tokens WHERE id=?")
      .get(activation.activationId)!;
    expect(stored.token_hash).toBe(
      createHash("sha256").update(activation.token).digest("hex"),
    );
    expect(
      JSON.stringify(
        test.store.database.prepare("SELECT * FROM lb_activation_tokens").all(),
      ),
    ).not.toContain(activation.token);
    expect(
      JSON.stringify(test.store.database.prepare("SELECT * FROM audit").all()),
    ).not.toContain(activation.token);
    await expect(
      test.service.issueActivation(test.manager, issue),
    ).rejects.toMatchObject({ code: "ACTIVATION_ALREADY_ISSUED" });
    const next = await test.service.issueActivation(test.manager, {
      ...issue,
      requestId: randomUUID(),
    });
    await expect(
      test.service.redeemActivation({
        token: activation.token,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "ACTIVATION_UNAVAILABLE" });
    expect(next.token).not.toBe(activation.token);
    expect(
      test.store.database
        .prepare("SELECT state FROM lb_activation_tokens WHERE id=?")
        .get(activation.activationId),
    ).toMatchObject({ state: "revoked" });
  });
  it("makes redemption one operation across retry, rejects another redeemer and requires verified credential/recovery completion before sign-in", async () => {
    const test = lab();
    const { activation, pending } = await test.issued();
    const redeem = { token: activation.token, requestId: randomUUID() };
    test.fixture.uncertainBegin();
    await expect(test.service.redeemActivation(redeem)).rejects.toMatchObject({
      code: "PROVIDER_FLOW_UNAVAILABLE",
    });
    const setup = await test.service.redeemActivation(redeem);
    expect(await test.service.redeemActivation(redeem)).toEqual(setup);
    expect(test.fixture.flows.size).toBe(1);
    await expect(
      test.service.redeemActivation({ ...redeem, requestId: randomUUID() }),
    ).rejects.toMatchObject({ code: "ACTIVATION_UNAVAILABLE" });
    expect(
      test.store.database
        .prepare("SELECT status FROM accounts WHERE id=?")
        .get(pending.accountId),
    ).toMatchObject({ status: "disabled" });
    await expect(
      test.service.completeActivation({
        activationId: activation.activationId,
        completionProof: "client-says-complete",
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_FLOW_UNAVAILABLE" });
    test.fixture.patchProof({ recoveryMaterialIssued: false });
    await expect(
      test.service.completeActivation({
        activationId: activation.activationId,
        completionProof: test.fixture.proof(activation.activationId),
      }),
    ).rejects.toMatchObject({ code: "ACTIVATION_UNAVAILABLE" });
    test.fixture.patchProof({});
    const completed = {
      activationId: activation.activationId,
      completionProof: test.fixture.proof(activation.activationId),
    };
    expect(await test.service.completeActivation(completed)).toEqual({
      status: "complete",
      signInRequired: true,
    });
    expect(await test.service.completeActivation(completed)).toEqual({
      status: "complete",
      signInRequired: true,
    });
    expect(
      test.store.database
        .prepare(
          "SELECT status,classification,adult_verified FROM accounts WHERE id=?",
        )
        .get(pending.accountId),
    ).toMatchObject({
      status: "active",
      classification: "child_shared",
      adult_verified: 0,
    });
    expect(
      test.store.database
        .prepare(
          "SELECT COUNT(*) AS count FROM audit WHERE action='identity.activation_completed'",
        )
        .get(),
    ).toMatchObject({ count: 1 });
    await expect(test.service.redeemActivation(redeem)).rejects.toMatchObject({
      code: "ACTIVATION_UNAVAILABLE",
    });
    test.store.database
      .prepare("UPDATE accounts SET status='disabled' WHERE id=?")
      .run(pending.accountId);
    await expect(
      test.service.completeActivation(completed),
    ).rejects.toMatchObject({ code: "ACTIVATION_UNAVAILABLE" });
    expect(
      test.store.database
        .prepare("SELECT status FROM accounts WHERE id=?")
        .get(pending.accountId),
    ).toMatchObject({ status: "disabled" });
  });
  it("expires exactly at the configured boundary and gives unknown, expired and revoked secrets the same public error", async () => {
    const test = lab();
    const { activation } = await test.issued();
    const invalidToken = randomUUID().replaceAll("-", "").padEnd(43, "A");
    const rejection = (token: string) =>
      test.service
        .redeemActivation({ token, requestId: randomUUID() })
        .catch((error) => ({
          code: error.code,
          status: error.status,
          message: error.message,
        }));
    const unknown = await rejection(invalidToken);
    test.setClock(activation.expiresAt);
    expect(await rejection(activation.token)).toEqual(unknown);
    expect(unknown).toMatchObject({
      code: "ACTIVATION_UNAVAILABLE",
      status: 410,
    });
    expect(test.fixture.flows.size).toBe(0);
  });
  it("rejects a completion for another identity and refuses completion after the provider-flow expiry", async () => {
    const test = lab();
    const { activation, pending } = await test.issued();
    const setup = await test.service.redeemActivation({
      token: activation.token,
      requestId: randomUUID(),
    });
    const completion = {
      activationId: activation.activationId,
      completionProof: test.fixture.proof(activation.activationId),
    };
    test.fixture.patchProof({ subject: randomUUID() });
    await expect(
      test.service.completeActivation(completion),
    ).rejects.toMatchObject({ code: "ACTIVATION_UNAVAILABLE" });
    test.fixture.patchProof({});
    test.setClock(setup.expiresAt);
    await expect(
      test.service.completeActivation(completion),
    ).rejects.toMatchObject({ code: "ACTIVATION_UNAVAILABLE" });
    expect(
      test.store.database
        .prepare("SELECT status FROM accounts WHERE id=?")
        .get(pending.accountId),
    ).toMatchObject({ status: "disabled" });
  });
  it("revokes a claimed token before reissue and blocks replacement until provider cancellation succeeds", async () => {
    const test = lab();
    const { issue, activation } = await test.issued();
    await test.service.redeemActivation({
      token: activation.token,
      requestId: randomUUID(),
    });
    const replacement = { ...issue, requestId: randomUUID() };
    test.fixture.setCancellationFailure(true);
    await expect(
      test.service.issueActivation(test.manager, replacement),
    ).rejects.toMatchObject({ code: "PROVIDER_FLOW_UNAVAILABLE" });
    expect(
      test.store.database
        .prepare("SELECT state FROM lb_activation_tokens WHERE id=?")
        .get(activation.activationId),
    ).toMatchObject({ state: "revoked" });
    await expect(
      test.service.completeActivation({
        activationId: activation.activationId,
        completionProof: test.fixture.proof(activation.activationId),
      }),
    ).rejects.toMatchObject({ code: "ACTIVATION_UNAVAILABLE" });
    test.fixture.setCancellationFailure(false);
    const renewed = await test.service.issueActivation(
      test.manager,
      replacement,
    );
    expect(
      test.fixture.cancelled.has(`activation:${activation.activationId}`),
    ).toBe(true);
    expect(renewed.token).not.toBe(activation.token);
    await expect(
      test.service.issueActivation(test.manager, replacement),
    ).rejects.toMatchObject({ code: "ACTIVATION_ALREADY_ISSUED" });
  });
  it("cancels an in-flight provider begin without allowing its late response to activate the account", async () => {
    const test = lab();
    const { issue, activation, pending } = await test.issued();
    let entered!: () => void;
    let resume!: () => void;
    const began = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    test.fixture.setBeginHook(async () => {
      entered();
      await resumed;
    });
    const original = test.service.redeemActivation({
      token: activation.token,
      requestId: randomUUID(),
    });
    await began;
    const replacement = await test.service.issueActivation(test.manager, {
      ...issue,
      requestId: randomUUID(),
    });
    resume();
    await expect(original).rejects.toMatchObject({
      code: "PROVIDER_FLOW_UNAVAILABLE",
    });
    test.fixture.setBeginHook(null);
    expect(
      (
        await test.service.redeemActivation({
          token: replacement.token,
          requestId: randomUUID(),
        })
      ).activationId,
    ).toBe(replacement.activationId);
    expect(
      test.store.database
        .prepare("SELECT status FROM accounts WHERE id=?")
        .get(pending.accountId),
    ).toMatchObject({ status: "disabled" });
  });
  it("retains exact-ID link/recovery requests without exposing account existence, linking records or resetting credentials", async () => {
    const test = lab();
    const { pending } = await test.issued();
    const otherAccount = randomUUID();
    const link = {
      requestId: randomUUID(),
      teamId: test.input.teamId,
      seasonId: test.input.seasonId,
      playerId: test.input.playerId,
      existingAccountId: otherAccount,
    };
    const result = test.service.requestExistingAccountLink(test.manager, link);
    expect(test.service.requestExistingAccountLink(test.manager, link)).toEqual(
      result,
    );
    const known = test.service.requestRecovery(test.manager, {
      requestId: randomUUID(),
      teamId: link.teamId,
      seasonId: link.seasonId,
      accountId: pending.accountId,
    });
    const unknown = test.service.requestRecovery(test.manager, {
      requestId: randomUUID(),
      teamId: link.teamId,
      seasonId: link.seasonId,
      accountId: randomUUID(),
    });
    expect({ ...known, requestId: "same" }).toEqual({
      ...unknown,
      requestId: "same",
    });
    expect(result).toMatchObject({
      status: "pending_independent_verification",
      completed: false,
    });
    expect(() =>
      test.service.requestExistingAccountLink(test.otherManager, {
        ...link,
        requestId: randomUUID(),
      }),
    ).toThrow("unavailable");
    expect(() =>
      test.service.requestExistingAccountLink(test.manager, {
        ...link,
        existingAccountId: "Fictional Name",
      }),
    ).toThrow("documented");
    expect(() =>
      test.service.requestExistingAccountLink(test.manager, {
        ...link,
        existingAccountId: pending.accountId,
      }),
    ).toThrow("already used");
    expect(
      test.store.database
        .prepare("SELECT status FROM accounts WHERE id=?")
        .get(pending.accountId),
    ).toMatchObject({ status: "disabled" });
    expect(
      test.store.database
        .prepare(
          "SELECT COUNT(*) AS count FROM lb_activation_verification_requests",
        )
        .get(),
    ).toMatchObject({ count: 3 });
    expect(
      test.store.database
        .prepare("SELECT account_id FROM memberships WHERE account_id=?")
        .get(otherAccount),
    ).toBeUndefined();
  });
  it("rechecks manager revocation after external provisioning and keeps the pending operation disabled", async () => {
    const test = lab();
    const provision = test.fixture.provider.provisionPending;
    test.fixture.provider.provisionPending = async (input) => {
      const result = await provision(input);
      test.store.database
        .prepare(
          "UPDATE memberships SET revoked_at=? WHERE account_id=? AND role='manager'",
        )
        .run(at, test.manager.accountId);
      return result;
    };
    await expect(test.pending()).rejects.toMatchObject({ status: 404 });
    expect(
      test.store.database
        .prepare("SELECT state FROM lb_activation_children")
        .get(),
    ).toMatchObject({ state: "provisioning" });
    expect(
      test.store.database
        .prepare(
          "SELECT status FROM accounts WHERE issuer='urn:longball:pending-activation'",
        )
        .get(),
    ).toMatchObject({ status: "disabled" });
    expect(test.fixture.users.size).toBe(1);
  });
});
