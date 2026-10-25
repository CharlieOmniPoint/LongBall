import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SIGN_IN_RULES } from "@longball/application/identity-policy";
import {
  loadSpectatorSignInRules,
  signInSpectatorPin,
} from "./spectator-access-client";
vi.mock("./id", () => ({ randomUUID: () => "test-only-request-key" }));

const now = Date.parse("2026-10-25T10:00:00Z"),
  base = "https://longball-demo.trycloudflare.com",
  accountId = "review-spectator-account",
  token = `spectator_${"a".repeat(43)}`;
const session = {
  accountId,
  accessToken: token,
  expiresAt: new Date(now + 3_600_000).toISOString(),
  role: "spectator",
};
const identity = {
  syntheticOnly: true,
  principal: { accountId, status: "active" },
  memberships: [
    { accountId, teamId: "roma", seasonId: "2026-27", role: "spectator" },
  ],
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const registration = () => ({
  apiBaseUrl: base,
  username: " Roma.SebL ",
  passcode: "4729",
  token: "test-only-invitation-token",
  requestId: "test-only-registration-request",
  register: true,
  rules: structuredClone(DEFAULT_SIGN_IN_RULES),
  signal: new AbortController().signal,
});
afterEach(() => vi.restoreAllMocks());

describe("Spectator sign-in rules and team usernames", () => {
  it("loads only validated current public rules without a credential or account lookup", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({
        kind: "sign-in-rules",
        revision: 2,
        rules: DEFAULT_SIGN_IN_RULES,
        provider: {
          status: "not_configured",
          detail: "Provider not connected.",
        },
      }),
    );
    await expect(
      loadSpectatorSignInRules(base, undefined, fetch),
    ).resolves.toEqual(DEFAULT_SIGN_IN_RULES);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]).toEqual([
      `${base}/v1/sign-in-rules`,
      expect.objectContaining({
        method: "GET",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
      }),
    ]);
    const options = fetch.mock.calls[0][1] as RequestInit;
    expect(options.body).toBeUndefined();
    expect(options.headers).not.toHaveProperty("Authorization");
  });
  it("refuses malformed rule responses instead of guessing a registration policy", async () => {
    for (const value of [
      { kind: "other", revision: 1, rules: DEFAULT_SIGN_IN_RULES },
      { kind: "sign-in-rules", revision: -1, rules: DEFAULT_SIGN_IN_RULES },
      { kind: "sign-in-rules", revision: 1.5, rules: DEFAULT_SIGN_IN_RULES },
      {
        kind: "sign-in-rules",
        revision: 1,
        rules: {
          ...DEFAULT_SIGN_IN_RULES,
          spectatorPin: { blockSimpleCodes: "false" },
        },
      },
      {
        kind: "sign-in-rules",
        revision: 1,
        rules: { ...DEFAULT_SIGN_IN_RULES, extra: "private diagnostic" },
      },
    ])
      await expect(
        loadSpectatorSignInRules(base, undefined, async () => json(value)),
      ).rejects.toThrow("could not be verified");
  });
  it("normalizes a suggested username and sends only the documented registration fields", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(json(identity));
    const result = await signInSpectatorPin({ ...registration(), fetch });
    expect(result).toMatchObject({
      accountId,
      role: "spectator",
      accessToken: token,
    });
    expect(fetch.mock.calls[0]).toEqual([
      `${base}/v1/spectator-access/register`,
      expect.objectContaining({
        body: JSON.stringify({
          username: "roma.sebl",
          passcode: "4729",
          token: "test-only-invitation-token",
          requestId: "test-only-registration-request",
        }),
      }),
    ]);
    expect(fetch.mock.calls[1][0]).toBe(`${base}/v1/me`);
    expect(result).not.toHaveProperty("username");
    expect(result).not.toHaveProperty("passcode");
    expect(result).not.toHaveProperty("rules");
  });
  it("validates new username and PIN choices against the current Super Admin rules", async () => {
    const fetch = vi.fn();
    for (const input of [
      {
        ...registration(),
        rules: {
          ...DEFAULT_SIGN_IN_RULES,
          username: { ...DEFAULT_SIGN_IN_RULES.username, minLength: 15 },
        },
      },
      {
        ...registration(),
        rules: {
          ...DEFAULT_SIGN_IN_RULES,
          username: {
            ...DEFAULT_SIGN_IN_RULES.username,
            allowSeparators: false,
          },
        },
      },
      {
        ...registration(),
        username: "Roma.Seb2",
        rules: {
          ...DEFAULT_SIGN_IN_RULES,
          username: { ...DEFAULT_SIGN_IN_RULES.username, allowNumbers: false },
        },
      },
      { ...registration(), passcode: "1111" },
    ])
      await expect(signInSpectatorPin({ ...input, fetch })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("honours the configured simple-code option only for newly chosen PINs", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(json(identity));
    await expect(
      signInSpectatorPin({
        ...registration(),
        passcode: "1111",
        rules: {
          ...DEFAULT_SIGN_IN_RULES,
          spectatorPin: { blockSimpleCodes: false },
        },
        fetch,
      }),
    ).resolves.toMatchObject({ accountId });
    expect(JSON.parse(fetch.mock.calls[0][1].body).passcode).toBe("1111");
  });
  it("keeps existing logins valid when new-account username or PIN rules become stricter", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(json(identity));
    const result = await signInSpectatorPin({
      ...registration(),
      username: "old.name",
      passcode: "1111",
      register: false,
      token: undefined,
      rules: {
        ...DEFAULT_SIGN_IN_RULES,
        username: {
          ...DEFAULT_SIGN_IN_RULES.username,
          minLength: 20,
          allowSeparators: false,
        },
      },
      fetch,
    });
    expect(result.role).toBe("spectator");
    expect(fetch.mock.calls[0][0]).toBe(`${base}/v1/spectator-access/login`);
  });
  it("does not adopt a session or expose server diagnostics after an atomic username collision", async () => {
    const fetch = vi.fn(async () =>
      json(
        { code: "USERNAME_UNAVAILABLE", message: "private account diagnostic" },
        409,
      ),
    );
    await expect(
      signInSpectatorPin({ ...registration(), fetch }),
    ).rejects.toThrow("choose another username");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
