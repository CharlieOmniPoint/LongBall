import { describe, expect, it, vi } from "vitest";
import {
  InvitationClientError,
  InvitationMemoryClient,
} from "./invitation-client";
import type { HttpFetch, HttpResponse } from "./sync";

const token = "A".repeat(43);
const key = "12345678-1234-4234-8234-123456789012";
const nextKey = "12345678-1234-4234-8234-123456789013";
const issued = {
  id: "invite",
  teamId: "team",
  seasonId: "season",
  expiresAt: "2026-10-21T12:00:00.000Z",
  shareUrl: `https://app.example/#longballInvite=1&teamId=team&seasonId=season&code=${token}`,
};
const redacted = {
  id: issued.id,
  teamId: issued.teamId,
  seasonId: issued.seasonId,
  expiresAt: issued.expiresAt,
  credentialAvailable: false,
  requiresReissue: true,
};
const accepted = {
  invitationId: issued.id,
  teamId: issued.teamId,
  seasonId: issued.seasonId,
  expiresAt: "2027-08-31T23:00:00.000Z",
};
const context = { clubName: 'Richmond Rovers', teamName: 'Roma', ageGroup: 'U10', seasonLabel: '2026/27', inviterLabel: 'Team manager' };
const inspection = { ...accepted, expiresAt: issued.expiresAt, context };
const reply = (status: number, body: unknown): HttpResponse => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});
function fixture(responses: (HttpResponse | Error)[]) {
  const calls: { url: string; options: Parameters<HttpFetch>[1] }[] = [];
  const fetch: HttpFetch = async (url, options) => {
    calls.push({ url, options });
    const response = responses.shift();
    if (!response) throw new Error("No fake response configured");
    if (response instanceof Error) throw response;
    return response;
  };
  return {
    calls,
    client: new InvitationMemoryClient({
      baseUrl: "https://api.example/",
      authenticatedFetch: fetch,
      assertCurrent: () => undefined,
    }),
  };
}

describe("ephemeral canonical invitation HTTP client", () => {
  it("loads only the exact requested team and season summary without accepting credential fields", async () => {
    const summary = {
      id: "invite",
      teamId: "team",
      seasonId: "season",
      expiresAt: issued.expiresAt,
      status: "pending",
      canReissue: true,
      canRevoke: true,
    };
    const body = {
      kind: "spectator-invitations",
      teamId: "team",
      seasonId: "season",
      revision: 2,
      invitations: [summary],
    };
    const { calls, client } = fixture([
      reply(200, body),
      reply(200, { ...body, invitations: [{ ...summary, teamId: "other" }] }),
      reply(200, {
        ...body,
        invitations: [{ ...summary, tokenHash: "f".repeat(64) }],
      }),
    ]);
    expect(await client.list("team", "season")).toEqual(body);
    expect(calls[0].url).toBe(
      "https://api.example/v1/teams/team/spectator-invites?seasonId=season",
    );
    expect(calls[0].options.method).toBe("GET");
    expect(calls[0].options.body).toBeUndefined();
    await expect(client.list("team", "season")).rejects.toMatchObject({
      code: "INVITATION_INVALID_RESPONSE",
    });
    await expect(client.list("team", "season")).rejects.toMatchObject({
      code: "INVITATION_INVALID_RESPONSE",
    });
  });
  it("requires server inspection of the exact credential before acceptance and rejects a mismatched accepted scope", async () => {
    const { client, calls } = fixture([
      reply(200, inspection),
      reply(200, { ...accepted, teamId: "other" }),
    ]);
    expect(() => client.accept(token, key)).toThrow(InvitationClientError);
    expect(calls).toHaveLength(0);
    expect(await client.inspect(token)).toEqual({
      ...accepted,
      expiresAt: issued.expiresAt,
      context,
    });
    expect(calls[0].url).toBe(
      "https://api.example/v1/spectator-invites/inspect",
    );
    expect(() => client.accept("B".repeat(42) + "A", key)).toThrow(
      InvitationClientError,
    );
    await expect(client.accept(token, key)).rejects.toMatchObject({
      code: "INVITATION_INVALID_RESPONSE",
    });
  });
  it("retries revocation as an identical scoped DELETE and exposes only the revocation receipt", async () => {
    const receipt = { invitationId: "invite", revoked: true };
    const { client, calls } = fixture([
      new Error("lost response"),
      reply(200, receipt),
    ]);
    await expect(
      client.revoke("team", "invite", "season", key),
    ).rejects.toMatchObject({ code: "INVITATION_NETWORK_UNCERTAIN" });
    expect(client.pending).toEqual({ kind: "revoke" });
    expect(await client.retry()).toEqual({ kind: "revoked", receipt });
    expect(calls[0].url).toBe(
      "https://api.example/v1/teams/team/spectator-invites/invite?seasonId=season",
    );
    expect(calls[0].options.method).toBe("DELETE");
    expect(calls[0].options.body).toBeUndefined();
    expect(calls[1].options.headers).toEqual(calls[0].options.headers);
  });
  it('refuses incomplete/private invitation labels and keeps the server-reviewed scope independent of returned display objects', async () => {
    const { client } = fixture([
      reply(200, { ...inspection, context: { ...context, privateRoster: ['Child name'] } }),
      reply(200, { ...inspection, context: { ...context, inviterLabel: 'Named child' } }),
      reply(200, inspection), reply(200, accepted),
    ]);
    await expect(client.inspect(token)).rejects.toMatchObject({ code: 'INVITATION_INVALID_RESPONSE' });
    await expect(client.inspect(token)).rejects.toMatchObject({ code: 'INVITATION_INVALID_RESPONSE' });
    const reviewed = await client.inspect(token); reviewed.teamId = 'changed-display'; reviewed.context.teamName = 'Changed display';
    await expect(client.accept(token, key)).resolves.toEqual({ kind: 'accepted', receipt: accepted });
  });
  it("explicitly closes only pending memory and allows a separate new action with a new identity", async () => {
    const { client, calls } = fixture([
      new Error("lost response"),
      reply(201, issued),
    ]);
    await expect(
      client.issue("team", { seasonId: "season", expiresInHours: 1 }, key),
    ).rejects.toMatchObject({ code: "INVITATION_NETWORK_UNCERTAIN" });
    client.closePending();
    expect(client.pending).toBeNull();
    expect(
      await client.issue(
        "team",
        { seasonId: "season", expiresInHours: 2 },
        nextKey,
      ),
    ).toEqual({ kind: "issued", receipt: issued });
    expect(calls).toHaveLength(2);
    expect(calls[1].options.headers["Idempotency-Key"]).toBe(nextKey);
    // No remote undo, revoke or automatic replacement was sent by closePending.
    expect(calls.every((call) => call.options.method === "POST")).toBe(true);
  });
  it("issues only an explicit bounded request and returns the first share URL only to its caller", async () => {
    const { calls, client } = fixture([reply(201, issued)]);
    expect(
      await client.issue(
        "team",
        { seasonId: "season", expiresInHours: 2 },
        key,
      ),
    ).toEqual({ kind: "issued", receipt: issued });
    expect(calls[0].url).toBe(
      "https://api.example/v1/teams/team/spectator-invites",
    );
    expect(calls[0].options.body).toBe(
      '{"seasonId":"season","expiresInHours":2}',
    );
    expect(calls[0].options.headers["Idempotency-Key"]).toBe(key);
    expect(calls[0].options.body).not.toMatch(/token|hash|reviewCode/);
    expect(client.pending).toBeNull();
    expect(JSON.stringify(client)).not.toContain(token);
    expect(JSON.stringify(client)).not.toContain(issued.shareUrl);
  });
  it("retries lost issue responses with identical bytes and key, then surfaces redacted receipt without automatic reissue", async () => {
    const { calls, client } = fixture([
      new Error("response lost after acceptance"),
      reply(200, redacted),
    ]);
    await expect(
      client.issue("team", { seasonId: "season", expiresInHours: 1 }, key),
    ).rejects.toMatchObject({
      code: "INVITATION_NETWORK_UNCERTAIN",
      retryable: true,
    });
    expect(client.pending).toEqual({ kind: "issue" });
    expect(() =>
      client.issue("team", { seasonId: "season", expiresInHours: 2 }, nextKey),
    ).toThrow(/retained invitation request/);
    expect(await client.retry()).toEqual({
      kind: "redacted",
      receipt: redacted,
    });
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe(calls[0].url);
    expect(calls[1].options.body).toBe(calls[0].options.body);
    expect(calls[1].options.headers).toEqual(calls[0].options.headers);
    expect(client.pending).toBeNull();
  });
  it("requires another explicit action and new key for pending invitation reissue", async () => {
    const { calls, client } = fixture([reply(201, issued)]);
    await client.reissue(
      "team",
      "old-invitation",
      { seasonId: "season", expiresInHours: 3 },
      nextKey,
    );
    expect(calls[0].url).toBe(
      "https://api.example/v1/teams/team/spectator-invites/old-invitation/reissue",
    );
    expect(calls[0].options.body).toBe(
      '{"seasonId":"season","expiresInHours":3}',
    );
  });
  it("keeps acceptance credentials only in memory for exact retry and returns a secret-free grant receipt", async () => {
    const { calls, client } = fixture([
      reply(200, inspection),
      new Error("network down"),
      reply(200, accepted),
    ]);
    await client.inspect(token);
    await expect(client.accept(token, key)).rejects.toMatchObject({
      code: "INVITATION_NETWORK_UNCERTAIN",
    });
    expect(client.pending).toEqual({ kind: "accept" });
    expect(JSON.stringify(client)).not.toContain(token);
    expect(await client.retry()).toEqual({
      kind: "accepted",
      receipt: accepted,
    });
    expect(calls[0].options.headers).not.toHaveProperty("Idempotency-Key");
    expect(calls[1].options.body).toBe(JSON.stringify({ token }));
    expect(calls[2].options.body).toBe(calls[1].options.body);
    expect(calls[2].options.headers).toEqual(calls[1].options.headers);
    expect(client.pending).toBeNull();
  });
  it("rejects malformed token/digest-as-token, missing expiry, out-of-range expiry, secret extras and malformed keys before transport", () => {
    const { calls, client } = fixture([]);
    for (const credential of ["f".repeat(64), `${token}\n`, "OLD-REVIEW-CODE"])
      expect(() => client.accept(credential, key)).toThrow(
        InvitationClientError,
      );
    for (const expiresInHours of [undefined, 0, 49, 1.5])
      expect(() =>
        client.issue(
          "team",
          { seasonId: "season", expiresInHours } as {
            seasonId: string;
            expiresInHours: number;
          },
          key,
        ),
      ).toThrow(InvitationClientError);
    expect(() =>
      client.issue(
        "team",
        { seasonId: "season", expiresInHours: 1, reviewCode: "unsafe" } as {
          seasonId: string;
          expiresInHours: number;
        },
        key,
      ),
    ).toThrow(InvitationClientError);
    expect(() => client.accept(token, `${key}\n`)).toThrow(
      InvitationClientError,
    );
    expect(calls).toHaveLength(0);
  });
  it("does not trust a stale async response after the account, issuer or season scope changes", async () => {
    let current = true;
    let resolve: (value: HttpResponse) => void = () => undefined;
    const client = new InvitationMemoryClient({
      baseUrl: "/",
      authenticatedFetch: () =>
        new Promise((done) => {
          resolve = done;
        }),
      assertCurrent: () => {
        if (!current) throw new Error("Account or scope changed");
      },
    });
    const response = client.issue(
      "team",
      { seasonId: "season", expiresInHours: 1 },
      key,
    );
    current = false;
    resolve(reply(201, issued));
    await expect(response).rejects.toThrow(/scope changed/);
    expect(() => client.accept(token, nextKey)).toThrow(/scope changed/);
    client.close();
    expect(client.pending).toBeNull();
    await expect(client.retry()).rejects.toMatchObject({
      code: "INVITATION_SESSION_CLOSED",
    });
  });
  it("covers both fetch and stalled response-body reads with a bounded timeout and preserves the original request", async () => {
    vi.useFakeTimers();
    try {
      let count = 0;
      const bodies: string[] = [];
      const client = new InvitationMemoryClient({
        baseUrl: "/",
        requestTimeoutMs: 10,
        assertCurrent: () => undefined,
        authenticatedFetch: async (_url, options) => {
          bodies.push(options.body!);
          count += 1;
          return count === 1
            ? {
                status: 201,
                ok: true,
                json: () => new Promise(() => undefined),
              }
            : reply(200, redacted);
        },
      });
      const assertion = expect(
        client.issue("team", { seasonId: "season", expiresInHours: 1 }, key),
      ).rejects.toMatchObject({
        code: "INVITATION_REQUEST_TIMEOUT",
        retryable: true,
      });
      await vi.advanceTimersByTimeAsync(10);
      await assertion;
      expect(client.pending).toEqual({ kind: "issue" });
      expect(await client.retry()).toEqual({
        kind: "redacted",
        receipt: redacted,
      });
      expect(bodies[1]).toBe(bodies[0]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("never echoes a credential-bearing HTTP error or accepts a secret in a redacted replay DTO", async () => {
    const { client } = fixture([
      reply(200, inspection),
      reply(403, { code: token, message: `Rejected ${token}` }),
      reply(200, { ...redacted, shareUrl: issued.shareUrl }),
    ]);
    await client.inspect(token);
    const error = await client.accept(token, key).catch((value) => value);
    expect(error).toMatchObject({
      code: "INVITATION_HTTP_REFUSED",
      status: 403,
    });
    expect(JSON.stringify(error)).not.toContain(token);
    expect(error.message).not.toContain(token);
    await expect(client.retry()).rejects.toMatchObject({
      code: "INVITATION_INVALID_RESPONSE",
    });
    expect(JSON.stringify(client)).not.toContain(token);
  });
  it("rejects a first response with scope-mismatched share URL and closes pending memory without changing any remote grant", async () => {
    const { client, calls } = fixture([
      reply(201, {
        ...issued,
        shareUrl: issued.shareUrl.replace("teamId=team", "teamId=other"),
      }),
    ]);
    await expect(
      client.issue("team", { seasonId: "season", expiresInHours: 1 }, key),
    ).rejects.toMatchObject({ code: "INVITATION_INVALID_RESPONSE" });
    client.close();
    expect(client.pending).toBeNull();
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(client)).not.toContain(token);
  });
});
