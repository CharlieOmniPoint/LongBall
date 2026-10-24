import { beforeEach, describe, expect, it, vi } from "vitest";
import { replaceLocalWarnings } from "./alerts";

const native = vi.hoisted(() => ({
  requests: new Map<
    string,
    { identifier: string; content: { data?: Record<string, unknown> } }
  >(),
  cancelled: [] as string[],
  failAfter: -1,
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-notifications", () => ({
  setNotificationHandler: vi.fn(),
  getPermissionsAsync: async () => ({ granted: true }),
  getAllScheduledNotificationsAsync: async () => [...native.requests.values()],
  cancelScheduledNotificationAsync: async (identifier: string) => {
    native.cancelled.push(identifier);
    native.requests.delete(identifier);
  },
  scheduleNotificationAsync: async (request: {
    identifier: string;
    content: { data?: Record<string, unknown> };
  }) => {
    if (native.failAfter === 0) throw new Error("Native scheduling failed");
    if (native.failAfter > 0) native.failAfter--;
    native.requests.set(request.identifier, request);
  },
  SchedulableTriggerInputTypes: { TIME_INTERVAL: "timeInterval" },
}));

beforeEach(() => {
  native.requests.clear();
  native.cancelled.length = 0;
  native.failAfter = -1;
});
const plan = (owner: string, revision = "revision-one") => ({
  owner,
  revision,
  dueInMs: 120_000,
  running: true,
});
const owned = (owner: string) =>
  [...native.requests.values()].filter(
    (request) => request.content.data?.longballOwner === owner,
  );

describe("native match reminder ownership", () => {
  it("keeps local, connected and another match reminders separate when one planner pauses or replans", async () => {
    await replaceLocalWarnings(plan("local-planner-roma"));
    await replaceLocalWarnings(plan("connected-planner-roma"));
    await replaceLocalWarnings(plan("connected-planner-other-fixture"));
    expect(native.requests.size).toBe(12);
    await replaceLocalWarnings({
      owner: "local-planner-roma",
      revision: "pause",
      dueInMs: 0,
      running: false,
    });
    expect(owned("local-planner-roma")).toHaveLength(0);
    expect(owned("connected-planner-roma")).toHaveLength(4);
    expect(owned("connected-planner-other-fixture")).toHaveLength(4);
    const otherIds = owned("connected-planner-other-fixture").map(
      (request) => request.identifier,
    );
    await replaceLocalWarnings(
      plan("connected-planner-roma", "new-projection"),
    );
    expect(owned("connected-planner-roma")).toHaveLength(4);
    expect(
      owned("connected-planner-other-fixture").map(
        (request) => request.identifier,
      ),
    ).toEqual(otherIds);
  });
  it("cancels only its own partial schedule after failure and permits the next queued owner to proceed", async () => {
    await replaceLocalWarnings(plan("local-planner-roma"));
    native.failAfter = 1;
    await expect(
      replaceLocalWarnings(plan("connected-planner-roma")),
    ).rejects.toThrow("scheduling failed");
    expect(owned("connected-planner-roma")).toHaveLength(0);
    expect(owned("local-planner-roma")).toHaveLength(4);
    native.failAfter = -1;
    await replaceLocalWarnings(plan("connected-planner-roma"));
    expect(native.requests.size).toBe(8);
  });
  it("limits legacy unowned cancellation to default m0 and retains unrelated notifications", async () => {
    native.requests.set("legacy", {
      identifier: "legacy",
      content: { data: { longballM0: true } },
    });
    native.requests.set("unrelated", {
      identifier: "unrelated",
      content: { data: { longballM0: false } },
    });
    await replaceLocalWarnings({
      ...plan("connected-planner-roma"),
      running: false,
    });
    expect(native.requests.has("legacy")).toBe(true);
    await replaceLocalWarnings({
      revision: "old-default",
      dueInMs: 0,
      running: false,
    });
    expect(native.requests.has("legacy")).toBe(false);
    expect(native.requests.has("unrelated")).toBe(true);
  });
  it("uses distinct native identifiers even when owner/revision contain the same separator pattern", async () => {
    await replaceLocalWarnings(plan("a-b", "c"));
    await replaceLocalWarnings(plan("a", "b-c"));
    expect(native.requests.size).toBe(8);
    expect(new Set([...native.requests.keys()]).size).toBe(8);
    await expect(replaceLocalWarnings(plan(""))).rejects.toThrow("owner");
    expect(native.requests.size).toBe(8);
  });
});
