import {
  parseAccountPushStatus,
  parsePushRegistrationInput,
  type AccountPushStatus,
  type PushPlatform,
  type PushPlatformPolicy,
  type PushRegistrationInput,
} from "@longball/application/push-registrations";
export type NativePushPermission =
  | "granted"
  | "provisional"
  | "denied"
  | "not_requested";
export type PendingPushUpdate = {
  version: 1;
  requestId: string;
  expectedRevision: number;
} & (
  | { kind: "register"; body: PushRegistrationInput }
  | { kind: "revoke"; deviceId: string }
);
export interface ProtectedPushPendingStore {
  load(): Promise<PendingPushUpdate | null>;
  save(value: PendingPushUpdate): Promise<void>;
  clear(): Promise<void>;
}
export interface PushClientPorts {
  accountId: string;
  deviceId: string;
  platform: PushPlatform;
  appBuild: string;
  assertCurrent(): Promise<void>;
  enrol(): Promise<void>;
  request(path: string, init?: RequestInit): Promise<Response>;
  permission(request: boolean): Promise<NativePushPermission>;
  token(
    policy: PushPlatformPolicy,
  ): Promise<{ transport: PushRegistrationInput["transport"]; token: string }>;
  pending: ProtectedPushPendingStore;
  nextId(): string;
  serialize?<T>(work: () => Promise<T>): Promise<T>;
}
export class PushClientError extends Error {
  constructor(
    readonly code:
      | "PUSH_STATUS_UNAVAILABLE"
      | "PUSH_UPDATE_PENDING"
      | "PUSH_NOT_CONFIGURED"
      | "PUSH_CONTEXT_CHANGED"
      | "PUSH_PENDING_INVALID",
    message: string,
  ) {
    super(message);
  }
}
function validatePending(
  value: PendingPushUpdate,
  deviceId: string,
): PendingPushUpdate {
  if (
    !value ||
    value.version !== 1 ||
    !/^[A-Za-z0-9_-]{8,150}$/.test(value.requestId) ||
    !Number.isSafeInteger(value.expectedRevision) ||
    value.expectedRevision < 0 ||
    !["register", "revoke"].includes(value.kind) ||
    (value.kind === "register"
      ? parsePushRegistrationInput(value.body).deviceId
      : value.deviceId) !== deviceId
  )
    throw new PushClientError(
      "PUSH_PENDING_INVALID",
      "The protected push update could not be read. It was retained without sending.",
    );
  return value;
}
/** Serial exact retries survive process loss in the injected OS-protected pending store. */
export function createNativePushClient(ports: PushClientPorts) {
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>) => {
    if (ports.serialize) return ports.serialize(work);
    const next = queue.catch(() => {}).then(work);
    queue = next;
    return next;
  };
  const read = async (): Promise<AccountPushStatus> => {
    await ports.assertCurrent();
    const response = await ports.request("/me/push-registrations");
    await ports.assertCurrent();
    if (response.status !== 200)
      throw new PushClientError(
        "PUSH_STATUS_UNAVAILABLE",
        "This account's push status could not be confirmed.",
      );
    const status = parseAccountPushStatus(
      await response.json(),
      ports.accountId,
    );
    await ports.assertCurrent();
    return status;
  };
  const sendPending = async (): Promise<AccountPushStatus> => {
    await ports.assertCurrent();
    const saved = await ports.pending.load();
    await ports.assertCurrent();
    if (!saved) return read();
    const pending = validatePending(saved, ports.deviceId);
    const path =
      pending.kind === "register"
        ? "/me/push-registrations"
        : `/me/push-registrations/${encodeURIComponent(pending.deviceId)}`;
    try {
      const response = await ports.request(path, {
        method: pending.kind === "register" ? "POST" : "DELETE",
        headers: {
          "content-type": "application/json",
          "idempotency-key": pending.requestId,
          "if-match": `"${pending.expectedRevision}"`,
          "x-api-contract-version": "longball.events/1.1",
        },
        ...(pending.kind === "register"
          ? { body: JSON.stringify(pending.body) }
          : {}),
      });
      await ports.assertCurrent();
      const receipt = (await response.json()) as Record<string, unknown>;
      if (
        response.status === 409 &&
        receipt.code === "PUSH_REGISTRATION_CHANGED"
      ) {
        const status = await read(),
          current = status.devices.find(
            (item) => item.deviceId === ports.deviceId,
          );
        if (current && current.revision > pending.expectedRevision) {
          await ports.assertCurrent();
          await ports.pending.clear();
          return status;
        }
      }
      if (
        pending.kind === "register"
          ? response.status !== 200 ||
            receipt.id !== ports.deviceId ||
            !Number.isSafeInteger(receipt.revision) ||
            Number(receipt.revision) < Math.max(1, pending.expectedRevision)
          : response.status !== 202 ||
            receipt.operationId !== pending.requestId ||
            receipt.status !== "completed"
      )
        throw new Error();
      // A mutation receipt describes its own transaction. The fresh read supplies current state.
      const status = await read();
      await ports.assertCurrent();
      await ports.pending.clear();
      return status;
    } catch {
      throw new PushClientError(
        "PUSH_UPDATE_PENDING",
        "Push registration is not confirmed. The exact protected update remains on this phone; retry with this account unlocked.",
      );
    }
  };
  const stage = async (
    value:
      | Omit<
          Extract<PendingPushUpdate, { kind: "register" }>,
          "version" | "requestId"
        >
      | Omit<
          Extract<PendingPushUpdate, { kind: "revoke" }>,
          "version" | "requestId"
        >,
  ) => {
    await ports.assertCurrent();
    if (await ports.pending.load())
      throw new PushClientError(
        "PUSH_UPDATE_PENDING",
        "Resolve the retained push update before another change.",
      );
    const pending = {
      version: 1 as const,
      requestId: ports.nextId(),
      ...value,
    } as PendingPushUpdate;
    validatePending(pending, ports.deviceId);
    await ports.assertCurrent();
    await ports.pending.save(pending);
    await ports.assertCurrent();
    return sendPending();
  };
  const currentState = (status: AccountPushStatus) =>
    status.devices.find((item) => item.deviceId === ports.deviceId);
  const register = async (
    status: AccountPushStatus,
    permission: "granted" | "provisional",
  ) => {
    const policy = status.platforms[ports.platform];
    if (!status.registrationConfigured || !policy)
      throw new PushClientError(
        "PUSH_NOT_CONFIGURED",
        "Team push registration is not configured for this app platform. No processor was selected automatically.",
      );
    const destination = await ports.token(policy);
    await ports.assertCurrent();
    if (destination.transport !== policy.transport)
      throw new PushClientError(
        "PUSH_NOT_CONFIGURED",
        "The native token does not match the configured processor.",
      );
    return stage({
      kind: "register",
      expectedRevision: currentState(status)?.revision ?? 0,
      body: {
        deviceId: ports.deviceId,
        platform: ports.platform,
        transport: destination.transport,
        token: destination.token,
        appBuild: ports.appBuild,
        permission,
      },
    });
  };
  return {
    deviceId: ports.deviceId,
    read: () => serialized(read),
    retry: () => serialized(sendPending),
    hasPending: () =>
      serialized(async () => Boolean(await ports.pending.load())),
    enable: () =>
      serialized(async () => {
        await ports.assertCurrent();
        await ports.enrol();
        await ports.assertCurrent();
        await sendPending();
        const status = await read();
        if (!status.registrationConfigured || !status.platforms[ports.platform])
          throw new PushClientError(
            "PUSH_NOT_CONFIGURED",
            "Team push registration is not configured for this app platform. No processor was selected automatically.",
          );
        const permission = await ports.permission(true);
        await ports.assertCurrent();
        if (permission !== "granted" && permission !== "provisional")
          return stage({
            kind: "revoke",
            deviceId: ports.deviceId,
            expectedRevision: currentState(status)?.revision ?? 0,
          });
        return register(status, permission);
      }),
    disable: () =>
      serialized(async () => {
        await ports.assertCurrent();
        await ports.enrol();
        await sendPending();
        const status = await read();
        return stage({
          kind: "revoke",
          deviceId: ports.deviceId,
          expectedRevision: currentState(status)?.revision ?? 0,
        });
      }),
    reconcile: () =>
      serialized(async () => {
        await ports.assertCurrent();
        await ports.enrol();
        const status = await sendPending(),
          current = currentState(status);
        // Existing local reminders or an OS grant alone never opt this account into remote updates.
        if (!current || current.state !== "registered") return status;
        const permission = await ports.permission(false);
        await ports.assertCurrent();
        if (permission !== "granted" && permission !== "provisional")
          return stage({
            kind: "revoke",
            deviceId: ports.deviceId,
            expectedRevision: current.revision,
          });
        return register(status, permission);
      }),
  };
}
