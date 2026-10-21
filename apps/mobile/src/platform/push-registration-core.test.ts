import { describe, expect, it, vi } from "vitest";
import type {
  AccountPushStatus,
  PushDeviceStatus,
} from "@longball/application/push-registrations";
import {
  createNativePushClient,
  type NativePushPermission,
  type PendingPushUpdate,
  type PushClientPorts,
} from "./push-registration-core";
import { createProtectedPushPendingStore } from "./push-pending-store";
const at = new Date(1_800_000_000_000).toISOString();
const clone = <T>(value: T): T => structuredClone(value);
function harness() {
  let pending: PendingPushUpdate | null = null,
    id = 0,
    valid = true,
    permission: NativePushPermission = "granted",
    row: PushDeviceStatus | undefined;
  let destination = "fictional-native-token-never-a-credential",
    loseResponse = false,
    failSave = false,
    serverToken: string | null = null;
  const receipts = new Map<string, unknown>(),
    sent: {
      method: string;
      key: string;
      body: string | undefined;
      revision: string | null;
    }[] = [];
  const status = (): AccountPushStatus => ({
    accountId: "account-a",
    registrationConfigured: true,
    deliveryConfigured: false,
    platforms: {
      android: { transport: "fcm", providerConfigId: "approved-test-project" },
    },
    devices: row ? [clone(row)] : [],
  });
  const ports: PushClientPorts = {
    accountId: "account-a",
    deviceId: "device-a",
    platform: "android",
    appBuild: "fixture-build",
    nextId: () => `exact-push-key-${++id}`,
    assertCurrent: vi.fn(async () => {
      if (!valid) throw new Error("session changed");
    }),
    enrol: vi.fn(async () => {}),
    permission: vi.fn(async () => permission),
    token: vi.fn(async () => ({
      transport: "fcm" as const,
      token: destination,
    })),
    pending: {
      load: async () => pending && clone(pending),
      save: async (value) => {
        if (failSave) throw new Error("protected storage unavailable");
        pending = clone(value);
      },
      clear: vi.fn(async () => {
        pending = null;
      }),
    },
    request: vi.fn(async (_path, init) => {
      if (!init || init.method === "GET") return Response.json(status());
      const headers = new Headers(init.headers),
        key = headers.get("idempotency-key")!;
      sent.push({
        method: init.method!,
        key,
        body: init.body as string | undefined,
        revision: headers.get("if-match"),
      });
      if (receipts.has(key))
        return Response.json(receipts.get(key), {
          status: init.method === "DELETE" ? 202 : 200,
        });
      if (
        Number(headers.get("if-match")?.replaceAll('"', "")) !==
        (row?.revision ?? 0)
      )
        return Response.json(
          { code: "PUSH_REGISTRATION_CHANGED" },
          { status: 409 },
        );
      const revision = (row?.revision ?? 0) + 1;
      row = {
        deviceId: "device-a",
        platform: "android",
        transport: "fcm",
        permission: init.method === "DELETE" ? "denied" : "granted",
        state: init.method === "DELETE" ? "revoked" : "registered",
        revision,
        appBuild: "fixture-build",
        registeredAt: init.method === "DELETE" && !row ? null : at,
        updatedAt: at,
        revokedAt: init.method === "DELETE" ? at : null,
        lastOperationId: key,
      };
      serverToken =
        init.method === "DELETE" ? null : JSON.parse(init.body as string).token;
      const receipt =
        init.method === "DELETE"
          ? { operationId: key, status: "completed", serverTime: at }
          : { id: "device-a", revision, serverTime: at };
      receipts.set(key, receipt);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("reply lost");
      }
      return Response.json(receipt, {
        status: init.method === "DELETE" ? 202 : 200,
      });
    }),
  };
  return {
    ports,
    sent,
    status,
    get pending() {
      return pending;
    },
    get serverToken() {
      return serverToken;
    },
    client: () => createNativePushClient(ports),
    setPermission: (value: NativePushPermission) => {
      permission = value;
    },
    changeToken: () => {
      destination += "-rotated";
    },
    loseReply: () => {
      loseResponse = true;
    },
    failProtectedSave: () => {
      failSave = true;
    },
    changeAccount: () => {
      valid = false;
    },
    advanceServerRevision: () => {
      row!.revision++;
      row!.lastOperationId = "another-confirmed-key";
    },
  };
}
describe("native push registration orchestration (no device/delivery proof)", () => {
  it("does not opt in from local notification permission, and never chooses an unconfigured processor", async () => {
    const h = harness();
    await h.client().reconcile();
    expect(h.ports.token).not.toHaveBeenCalled();
    expect(h.ports.permission).not.toHaveBeenCalled();
    h.ports.request = vi.fn(async () =>
      Response.json({
        ...h.status(),
        registrationConfigured: false,
        platforms: {},
      }),
    );
    await expect(h.client().enable()).rejects.toMatchObject({
      code: "PUSH_NOT_CONFIGURED",
    });
    expect(h.ports.permission).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
  });
  it("persists before sending and retries the same operation/body/CAS after process loss", async () => {
    const h = harness();
    h.loseReply();
    await expect(h.client().enable()).rejects.toMatchObject({
      code: "PUSH_UPDATE_PENDING",
    });
    expect(h.pending).toMatchObject({ kind: "register", expectedRevision: 0 });
    const original = clone(h.sent[0]);
    const result = await h.client().retry();
    expect(h.sent[1]).toEqual(original);
    expect(result.devices[0]).toMatchObject({
      state: "registered",
      revision: 1,
    });
    expect(h.pending).toBeNull();
  });
  it("never sends or claims success after protected pending storage fails", async () => {
    const h = harness();
    h.failProtectedSave();
    await expect(h.client().enable()).rejects.toThrow();
    expect(h.sent).toEqual([]);
    expect(h.serverToken).toBeNull();
  });
  it("rejects an account switch after the OS prompt before acquiring/storing a destination", async () => {
    const h = harness();
    h.ports.permission = vi.fn(async () => {
      h.changeAccount();
      return "granted" as const;
    });
    await expect(h.client().enable()).rejects.toThrow();
    expect(h.ports.token).not.toHaveBeenCalled();
    expect(h.pending).toBeNull();
    expect(h.sent).toEqual([]);
  });
  it("does not adopt a response or clear retained evidence after its account session changes", async () => {
    const h = harness(),
      request = h.ports.request;
    h.ports.request = async (path, input) => {
      const response = await request(path, input);
      if (input?.method === "POST") h.changeAccount();
      return response;
    };
    await expect(h.client().enable()).rejects.toMatchObject({
      code: "PUSH_UPDATE_PENDING",
    });
    expect(h.pending).not.toBeNull();
    expect(h.ports.pending.clear).not.toHaveBeenCalled();
  });
  it("rotates an existing token and withdraws registration when OS permission is removed, without another prompt", async () => {
    const h = harness();
    await h.client().enable();
    h.changeToken();
    await h.client().reconcile();
    expect(h.serverToken).toMatch(/-rotated$/);
    h.setPermission("denied");
    const result = await h.client().reconcile();
    expect(result.devices[0].state).toBe("revoked");
    expect(h.serverToken).toBeNull();
    expect(h.ports.permission).toHaveBeenLastCalledWith(false);
  });
  it("resolves a retained registration before durable revoke and preserves ordering", async () => {
    const h = harness();
    h.loseReply();
    await expect(h.client().enable()).rejects.toThrow();
    const result = await h.client().disable();
    expect(h.sent.map((item) => item.method)).toEqual([
      "POST",
      "POST",
      "DELETE",
    ]);
    expect(h.sent[0]).toEqual(h.sent[1]);
    expect(result.devices[0].state).toBe("revoked");
    expect(h.pending).toBeNull();
  });
  it("clears a rejected old operation only after a fresh revision proves it can no longer overwrite the current row", async () => {
    const h = harness();
    h.loseReply();
    await expect(h.client().enable()).rejects.toThrow();
    h.advanceServerRevision();
    // Simulate a server receipt that was not retained but a newer CAS generation now exists.
    const request = h.ports.request;
    h.ports.request = async (path, input) =>
      input?.method === "POST"
        ? Response.json({ code: "PUSH_REGISTRATION_CHANGED" }, { status: 409 })
        : request(path, input);
    expect((await h.client().retry()).devices[0].revision).toBe(2);
    expect(h.pending).toBeNull();
  });
});
describe("OS-protected push pending chunk commit", () => {
  it("keeps a maximum-size opaque token exact while every OS value remains bounded", async () => {
    const values = new Map<string, string>(),
      store = createProtectedPushPendingStore(
        {
          get: async (key) => values.get(key) ?? null,
          set: async (key, value) => {
            expect(value.length).toBeLessThanOrEqual(1500);
            values.set(key, value);
          },
          remove: async (key) => {
            values.delete(key);
          },
        },
        "scope-a",
        () => "protected-generation-a",
      );
    const value: PendingPushUpdate = {
      version: 1,
      kind: "register",
      requestId: "retained-request-a",
      expectedRevision: 3,
      body: {
        deviceId: "device-a",
        platform: "android",
        transport: "fcm",
        token: "a".repeat(4096),
        permission: "granted",
        appBuild: "test",
      },
    };
    await store.save(value);
    expect(await store.load()).toEqual(value);
    await store.clear();
    expect(values.size).toBe(0);
  });
  it("does not publish a partial write or silently replace an unreadable retained manifest", async () => {
    const values = new Map<string, string>(),
      store = createProtectedPushPendingStore(
        {
          get: async (key) => values.get(key) ?? null,
          set: async (key, value) => {
            if (key.endsWith(".manifest")) throw new Error("keychain failure");
            values.set(key, value);
          },
          remove: async (key) => {
            values.delete(key);
          },
        },
        "scope-a",
        () => "protected-generation-a",
      );
    await expect(
      store.save({
        version: 1,
        kind: "revoke",
        requestId: "retained-request-a",
        expectedRevision: 1,
        deviceId: "device-a",
      }),
    ).rejects.toThrow("PUSH_PENDING_NOT_SAVED");
    expect(await store.load()).toBeNull();
    values.set("scope-a.manifest", JSON.stringify({ version: 99 }));
    await expect(store.load()).rejects.toThrow();
    await expect(
      store.save({
        version: 1,
        kind: "revoke",
        requestId: "retained-request-b",
        expectedRevision: 1,
        deviceId: "device-a",
      }),
    ).rejects.toThrow();
    expect(values.get("scope-a.manifest")).toContain("99");
  });
  it("recovers a manifest write that committed before the OS reported an error", async () => {
    const values = new Map<string, string>();
    const store = createProtectedPushPendingStore(
      {
        get: async (key) => values.get(key) ?? null,
        set: async (key, text) => {
          values.set(key, text);
          if (key.endsWith(".manifest"))
            throw new Error("uncertain native write");
        },
        remove: async (key) => {
          values.delete(key);
        },
      },
      "scope-a",
      () => "protected-generation-a",
    );
    const pending: PendingPushUpdate = {
      version: 1,
      kind: "revoke",
      requestId: "retained-request-a",
      expectedRevision: 2,
      deviceId: "device-a",
    };
    await store.save(pending);
    expect(await store.load()).toEqual(pending);
  });
  it("retains uncertain chunks until a later protected read can establish the manifest", async () => {
    const values = new Map<string, string>();
    let unavailable = false;
    const store = createProtectedPushPendingStore(
      {
        get: async (key) => {
          if (unavailable) throw new Error("locked native store");
          return values.get(key) ?? null;
        },
        set: async (key, text) => {
          values.set(key, text);
          if (key.endsWith(".manifest")) {
            unavailable = true;
            throw new Error("uncertain native write");
          }
        },
        remove: async (key) => {
          values.delete(key);
        },
      },
      "scope-a",
      () => "protected-generation-a",
    );
    const pending: PendingPushUpdate = {
      version: 1,
      kind: "revoke",
      requestId: "retained-request-a",
      expectedRevision: 2,
      deviceId: "device-a",
    };
    await expect(store.save(pending)).rejects.toThrow(
      "PUSH_PENDING_SAVE_UNCERTAIN",
    );
    unavailable = false;
    expect(await store.load()).toEqual(pending);
  });
});
