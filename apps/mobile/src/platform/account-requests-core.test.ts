import { describe, expect, it } from "vitest";
import type {
  AccountPrivacyRequestsDto,
  PrivacyRequestDto,
  PrivacyRequestInput,
} from "@longball/application/privacy-requests";
import {
  accountRequestConfirmation,
  createAccountRequestsClient,
} from "./account-requests-core";
const exportRequest: PrivacyRequestInput = {
  kind: "export",
  scope: "all_memberships",
  confirmAllMemberships: true,
};
const leaveRequest: PrivacyRequestInput = {
  kind: "leave_team",
  teamId: "team-a",
  seasonId: "season-1",
  confirmLeave: true,
};
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function fixture() {
  const snapshot: AccountPrivacyRequestsDto = {
    accountId: "account-a",
    memberships: [
      {
        teamId: "team-a",
        seasonId: "season-1",
        role: "player",
        playerId: "player-a",
        status: "active",
      },
      {
        teamId: "team-b",
        seasonId: "season-2",
        role: "spectator",
        playerId: null,
        status: "revoked",
      },
    ],
    items: [],
  };
  const calls: { idempotencyKey: string | null; body: string }[] = [];
  let current = true;
  let counter = 0;
  let handler: (init: RequestInit) => Promise<Response> = async (init) => {
    const saved = record(
      JSON.parse(init.body as string) as PrivacyRequestInput,
    );
    snapshot.items.push(saved);
    return json(saved);
  };
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { status: 200 });
  function record(
    input: PrivacyRequestInput,
    requestId = "request-a",
  ): PrivacyRequestDto {
    return {
      requestId,
      kind: input.kind,
      status: "pending_verification_and_policy",
      scope:
        input.kind === "leave_team"
          ? {
              type: "team_season",
              teamId: input.teamId,
              seasonId: input.seasonId,
            }
          : { type: "all_memberships" },
      affectedMemberships: copy(
        input.kind === "leave_team"
          ? snapshot.memberships.filter(
              (item) =>
                item.teamId === input.teamId &&
                item.seasonId === input.seasonId &&
                item.status === "active",
            )
          : snapshot.memberships,
      ),
      createdAtMs: 1000,
      verificationRequired: true,
      erased: false,
      fulfilled: false,
      scopeStatus: "recorded",
      reviewStatus: "pending_verification_and_policy",
      duplicateOfRequestId: null,
    };
  }
  const client = createAccountRequestsClient({
    accountId: snapshot.accountId,
    newId: () => `stable-request-${++counter}`,
    assertCurrent: async () => {
      if (!current) throw new Error("session closed");
    },
    request: async (init = {}) => {
      if (!init.method) return json(snapshot);
      calls.push({
        idempotencyKey: new Headers(init.headers).get("idempotency-key"),
        body: init.body as string,
      });
      return handler(init);
    },
  });
  return {
    client,
    snapshot,
    calls,
    record,
    json,
    replacePost: (next: typeof handler) => {
      handler = next;
    },
    closeSession: () => {
      current = false;
    },
  };
}
describe("online account requests with uncertain response retention", () => {
  it("resolves a committed but lost response by fresh status without sending another POST", async () => {
    const f = fixture();
    await f.client.refresh();
    f.replacePost(async (init) => {
      f.snapshot.items.push(f.record(JSON.parse(init.body as string)));
      throw new Error("response lost");
    });
    await expect(
      f.client.submit(
        exportRequest,
        accountRequestConfirmation(f.snapshot, exportRequest),
      ),
    ).rejects.toMatchObject({ code: "UNCERTAIN_SUBMISSION" });
    expect(f.client.getState().pending?.phase).toBe("uncertain");
    const resolved = await f.client.refresh();
    expect(resolved.pending).toBeNull();
    expect(resolved.resolvedRequest?.requestId).toBe("request-a");
    expect(resolved.resolvedRequest).toMatchObject({
      fulfilled: false,
      erased: false,
    });
    expect(f.calls).toHaveLength(1);
  });
  it("blocks blind retry, then reuses the original exact body and idempotency key after a fresh missing-status check", async () => {
    const f = fixture();
    await f.client.refresh();
    f.replacePost(async () => {
      throw new Error("connection failed before write");
    });
    await expect(
      f.client.submit(
        leaveRequest,
        accountRequestConfirmation(f.snapshot, leaveRequest),
      ),
    ).rejects.toMatchObject({ code: "UNCERTAIN_SUBMISSION" });
    await expect(
      f.client.retry(accountRequestConfirmation(f.snapshot, leaveRequest)),
    ).rejects.toMatchObject({ code: "REFRESH_REQUIRED" });
    expect(f.calls).toHaveLength(1);
    const checked = await f.client.refresh();
    expect(checked.pending?.phase).toBe("ready_to_retry");
    f.replacePost(async () => f.json(f.record(leaveRequest)));
    await f.client.retry(accountRequestConfirmation(f.snapshot, leaveRequest));
    expect(f.calls[1]).toEqual(f.calls[0]);
    expect(f.client.getState().pending).toBeNull();
  });
  it("requires renewed confirmation when global memberships change before submission", async () => {
    const f = fixture();
    await f.client.refresh();
    const confirmation = accountRequestConfirmation(f.snapshot, exportRequest);
    f.snapshot.memberships.push({
      teamId: "team-c",
      seasonId: "season-3",
      role: "manager",
      playerId: null,
      status: "active",
    });
    await expect(
      f.client.submit(exportRequest, confirmation),
    ).rejects.toMatchObject({ code: "SCOPE_CHANGED" });
    expect(f.calls).toHaveLength(0);
    expect(f.client.getState().pending).toBeNull();
    await f.client.submit(
      exportRequest,
      accountRequestConfirmation(f.snapshot, exportRequest),
    );
    expect(
      f.client.getState().resolvedRequest?.affectedMemberships,
    ).toHaveLength(3);
  });
  it("preserves the original uncertain candidate and requires re-confirmation if retry scope changes", async () => {
    const f = fixture();
    await f.client.refresh();
    f.replacePost(async () => {
      throw new Error("network unavailable");
    });
    await expect(
      f.client.submit(
        leaveRequest,
        accountRequestConfirmation(f.snapshot, leaveRequest),
      ),
    ).rejects.toThrow();
    await f.client.refresh();
    const confirmation = accountRequestConfirmation(f.snapshot, leaveRequest);
    f.snapshot.memberships.push({
      teamId: "team-a",
      seasonId: "season-1",
      role: "spectator",
      playerId: null,
      status: "active",
    });
    await expect(f.client.retry(confirmation)).rejects.toMatchObject({
      code: "SCOPE_CHANGED",
    });
    expect(f.calls).toHaveLength(1);
    expect(f.client.getState().pending?.idempotencyKey).toBe(
      "stable-request-1",
    );
  });
  it("reuses a known canonical pending business request and distinguishes other kinds and team scopes", async () => {
    const f = fixture();
    f.snapshot.items.push(
      f.record(
        {
          kind: "leave_team",
          teamId: "team-c",
          seasonId: "season-3",
          confirmLeave: true,
        },
        "other-scope",
      ),
      f.record(exportRequest, "known-export"),
    );
    await f.client.refresh();
    const saved = await f.client.submit(
      exportRequest,
      accountRequestConfirmation(f.snapshot, exportRequest),
    );
    expect(saved.resolvedRequest?.requestId).toBe("known-export");
    expect(f.calls).toHaveLength(0);
    await f.client.submit(
      leaveRequest,
      accountRequestConfirmation(f.snapshot, leaveRequest),
    );
    expect(f.calls).toHaveLength(1);
  });
  it("does not treat an unknown legacy leave scope as confirmation of a new scoped request", async () => {
    const f = fixture();
    f.snapshot.items.push({
      ...f.record(leaveRequest),
      requestId: "legacy",
      status: "needs_scope",
      scope: null,
      scopeStatus: "needs_scope",
      reviewStatus: "needs_scope",
      affectedMemberships: null,
    });
    await f.client.refresh();
    await f.client.submit(
      leaveRequest,
      accountRequestConfirmation(f.snapshot, leaveRequest),
    );
    expect(f.calls).toHaveLength(1);
    expect(
      f.client
        .getState()
        .snapshot?.items.some((item) => item.requestId === "legacy"),
    ).toBe(true);
  });
  it("discards private projection when authority closes during a response and retains no success claim", async () => {
    const f = fixture();
    await f.client.refresh();
    f.replacePost(async () => {
      f.closeSession();
      return f.json(f.record(exportRequest));
    });
    await expect(
      f.client.submit(
        exportRequest,
        accountRequestConfirmation(f.snapshot, exportRequest),
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_CHANGED" });
    expect(f.client.getState().snapshot).toBeNull();
    expect(f.client.getState().resolvedRequest).toBeNull();
    expect(f.client.getState().pending?.phase).toBe("uncertain");
  });
  it("treats a response for another scope as uncertain rather than acknowledging the wrong request", async () => {
    const f = fixture();
    await f.client.refresh();
    f.replacePost(async () => f.json(f.record(leaveRequest)));
    await expect(
      f.client.submit(
        exportRequest,
        accountRequestConfirmation(f.snapshot, exportRequest),
      ),
    ).rejects.toMatchObject({ code: "UNCERTAIN_SUBMISSION" });
    expect(f.client.getState().resolvedRequest).toBeNull();
    expect(f.client.getState().pending?.body).toEqual(exportRequest);
  });
});
