import { createHash, randomBytes, scryptSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DEMO_SCRYPT_OPTIONS, DemoSessions, type DemoAccountOptions } from "./demo-sessions";
import { SpectatorAccessService, type SpectatorAccessRepository } from "./spectator-access";
import type { SessionFailureObservation } from "./session-observation";

const passcode = randomBytes(18).toString("base64url"), salt = randomBytes(16).toString("base64url");
const options: DemoAccountOptions = { version: 1, sessionTtlSeconds: 600, accounts: [{ username: "review.manager", accountId: "synthetic-account-manager", salt, hash: scryptSync(passcode, Buffer.from(salt, "base64url"), 32, DEMO_SCRYPT_OPTIONS).toString("hex") }] };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

describe("privacy-minimised credential session observations", () => {
  it("returns independent non-secret demo session correlations only for valid unexpired sessions", async () => {
    let now = 1000;
    const failures: SessionFailureObservation[] = [];
    const service = new DemoSessions(options, () => now, event => { failures.push(event); });
    const one = await service.login({ username: "review.manager", passcode }, "private-address");
    const two = await service.login({ username: "review.manager", passcode }, "private-address");
    const metadata = service.sessionObservation(one.accessToken);
    expect(metadata).toEqual({ accountId: "synthetic-account-manager", provider: "demo", sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/), issuedAtMs: 1000, expiresAtMs: 601_000 });
    expect(metadata.sessionId).not.toBe(service.sessionObservation(two.accessToken).sessionId);
    expect(metadata.sessionId).not.toBe(one.accessToken);
    expect(metadata.sessionId).not.toBe(digest(one.accessToken));
    expect(one).not.toHaveProperty("sessionId");
    expect(failures).toEqual([]);
    metadata.accountId = "changed-caller-copy";
    expect(service.sessionObservation(one.accessToken).accountId).toBe("synthetic-account-manager");
    service.revoke(one.accessToken);
    expect(() => service.sessionObservation(one.accessToken)).toThrow("valid authenticated session");
    now = 601_000;
    expect(() => service.sessionObservation(two.accessToken)).toThrow("valid authenticated session");
    service.close();
  });

  it("awaits demo failure reporting without attributing unknown or mistyped credentials to an account", async () => {
    const failures: SessionFailureObservation[] = [];
    const service = new DemoSessions(options, () => 1000, async event => { await Promise.resolve(); failures.push(event); });
    const wrong = randomBytes(18).toString("base64url");
    for (const username of ["private-unknown-name", "review.manager"])
      await expect(service.login({ username, passcode: wrong }, "private-address")).rejects.toMatchObject({ code: "INVALID_DEMO_CREDENTIALS", status: 401 });
    expect(failures).toEqual(Array.from({ length: 2 }, () => ({ kind: "login_failure", provider: "demo", at: 1000, reason: "invalid_credentials" })));
    const serialized = JSON.stringify(failures);
    for (const privateValue of ["private-unknown-name", "review.manager", "private-address", wrong, passcode, salt, options.accounts[0].hash, "synthetic-account-manager"])
      expect(serialized).not.toContain(privateValue);
    service.close();
  });

  it("keeps existing demo rate limits and safe auth errors even when the observer rejects", async () => {
    const observer = vi.fn(async (_event: Readonly<SessionFailureObservation>) => { throw new Error("private reporting failure"); });
    const service = new DemoSessions(options, () => 1000, observer);
    for (let i = 0; i < 20; i++) await expect(service.login({}, "private-address")).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
    await expect(service.login({ username: "review.manager", passcode }, "private-address")).rejects.toMatchObject({ code: "RATE_LIMIT", status: 429, message: "Please retry after the current request window." });
    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenLastCalledWith({ kind: "login_failure", provider: "demo", at: 1000, reason: "rate_limited" });
    service.close();
  });

  it("provides PIN session metadata and records only generic failed or locked attempts", async () => {
    let now = 1000, lockedUntil = 0;
    const pin = "4729", accountId = "review-only-spectator", verifier = scryptSync(pin, Buffer.from(salt, "base64url"), 32, DEMO_SCRYPT_OPTIONS).toString("hex");
    const repository = { credential: async (username: string) => username === "review.supporter" ? { accountId, salt, verifier, lockedUntil } : null, loginAttempt: vi.fn(async () => {}) } as unknown as SpectatorAccessRepository;
    const failures: SessionFailureObservation[] = [];
    const service = new SpectatorAccessService(repository, () => now, {}, undefined, async event => { await Promise.resolve(); failures.push(event); });
    const session = await service.login({ username: "REVIEW.SUPPORTER", passcode: pin }, "private-address");
    const metadata = service.sessionObservation(session.accessToken);
    expect(metadata).toEqual({ accountId, provider: "spectator_pin", sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/), issuedAtMs: now, expiresAtMs: now + 21_600_000 });
    expect(session).not.toHaveProperty("sessionId");
    expect(metadata.sessionId).not.toBe(digest(session.accessToken));
    lockedUntil = now + 900_000;
    await expect(service.login({ username: "review.supporter", passcode: pin }, "other-address")).rejects.toMatchObject({ code: "INVALID_SPECTATOR_CREDENTIALS", status: 401 });
    await expect(service.login({ username: "private-unknown-name", passcode: pin }, "other-address")).rejects.toMatchObject({ code: "INVALID_SPECTATOR_CREDENTIALS", status: 401 });
    expect(failures).toEqual([{ kind: "login_failure", provider: "spectator_pin", at: 1000, reason: "locked" }, { kind: "login_failure", provider: "spectator_pin", at: 1000, reason: "invalid_credentials" }]);
    for (const event of failures) expect(Object.keys(event).sort()).toEqual(["at", "kind", "provider", "reason"]);
    const serialized = JSON.stringify(failures);
    for (const privateValue of [accountId, "review.supporter", "private-unknown-name", "private-address", pin, salt, verifier, session.accessToken, digest(session.accessToken)]) expect(serialized).not.toContain(privateValue);
    service.logout(session.accessToken);
    expect(() => service.sessionObservation(session.accessToken)).toThrow("Sign in again");
    lockedUntil = 0;
    const again = await service.login({ username: "review.supporter", passcode: pin }, "fresh-address");
    now += 21_600_000;
    expect(() => service.sessionObservation(again.accessToken)).toThrow("Sign in again");
    service.close();
  });

  it("preserves PIN rate limits and safe failures when reporting is unavailable", async () => {
    const repository = {} as SpectatorAccessRepository;
    const observer = vi.fn(async (_event: Readonly<SessionFailureObservation>) => { throw new Error("private reporting failure"); });
    const service = new SpectatorAccessService(repository, () => 1000, {}, undefined, observer);
    for (let i = 0; i < 20; i++) await expect(service.login({}, "private-address")).rejects.toMatchObject({ code: "INVALID_SPECTATOR_CREDENTIALS", status: 401 });
    await expect(service.login({}, "private-address")).rejects.toMatchObject({ code: "RATE_LIMIT", status: 429, message: "Please wait before trying again." });
    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenLastCalledWith({ kind: "login_failure", provider: "spectator_pin", at: 1000, reason: "rate_limited" });
    service.close();
  });
});
