import {
  isSamePendingPrivacyRequest,
  parseAccountPrivacyRequestsDto,
  parsePrivacyRequestDto,
  type PrivacyRequestInput,
  type PrivacyRequestDto,
  type PrivacyAffectedMembership,
} from "@longball/application/privacy-requests";

export type AccountRequestsSnapshot = ReturnType<
  typeof parseAccountPrivacyRequestsDto
>;
export interface PendingAccountRequest {
  readonly idempotencyKey: string;
  readonly body: PrivacyRequestInput;
  readonly phase: "uncertain" | "ready_to_retry";
}
export interface AccountRequestsState {
  snapshot: AccountRequestsSnapshot | null;
  pending: PendingAccountRequest | null;
  resolvedRequest: PrivacyRequestDto | null;
}
export class AccountRequestsError extends Error {
  constructor(
    readonly code:
      | "AUTHORITY_CHANGED"
      | "STATUS_UNAVAILABLE"
      | "SCOPE_CHANGED"
      | "UNCERTAIN_SUBMISSION"
      | "REFRESH_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "AccountRequestsError";
  }
}
export function requestMemberships(
  snapshot: AccountRequestsSnapshot,
  input: PrivacyRequestInput,
): PrivacyAffectedMembership[] {
  return input.kind === "leave_team"
    ? snapshot.memberships.filter(
        (item) =>
          item.teamId === input.teamId &&
          item.seasonId === input.seasonId &&
          item.status === "active",
      )
    : snapshot.memberships;
}
/** A comparison token for the confirmation screen only; never authentication or policy approval. */
export function accountRequestConfirmation(
  snapshot: AccountRequestsSnapshot,
  input: PrivacyRequestInput,
): string {
  return JSON.stringify([
    snapshot.accountId,
    input,
    requestMemberships(snapshot, input)
      .map((item) => [
        item.teamId,
        item.seasonId,
        item.role,
        item.playerId,
        item.status,
      ])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ]);
}
export interface AccountRequestsClientOptions {
  accountId: string;
  request: (init?: RequestInit) => Promise<Response>;
  assertCurrent: () => Promise<void>;
  newId: () => string;
}
/** Online-only controller. Pending request identity/body are held in this instance's memory, never a journal. */
export function createAccountRequestsClient(
  options: AccountRequestsClientOptions,
) {
  let snapshot: AccountRequestsSnapshot | null = null;
  let pending: PendingAccountRequest | null = null;
  let resolvedRequest: PrivacyRequestDto | null = null;
  let busy = false;
  const state = (): AccountRequestsState => ({
    snapshot,
    pending,
    resolvedRequest,
  });
  async function current() {
    try {
      await options.assertCurrent();
    } catch {
      snapshot = null;
      resolvedRequest = null;
      throw new AccountRequestsError(
        "AUTHORITY_CHANGED",
        "This account session was locked, expired or replaced. Sign in again before viewing requests.",
      );
    }
  }
  async function readResponse(response: Response): Promise<unknown> {
    if (!response.ok)
      throw new Error(
        "Account request service did not confirm this operation.",
      );
    const text = await response.text();
    if (text.length > 1_000_000)
      throw new Error("Account request response exceeded its bound.");
    return JSON.parse(text) as unknown;
  }
  async function fresh() {
    await current();
    try {
      const loaded = parseAccountPrivacyRequestsDto(
        await readResponse(await options.request()),
      );
      await current();
      if (loaded.accountId !== options.accountId)
        throw new Error("Wrong account response");
      snapshot = loaded;
      return loaded;
    } catch (failure) {
      if (failure instanceof AccountRequestsError) throw failure;
      throw new AccountRequestsError(
        "STATUS_UNAVAILABLE",
        "Current request status could not be read. No new submission can be sent until a fresh status check succeeds.",
      );
    }
  }
  function existing(input: PrivacyRequestInput) {
    return (
      snapshot?.items.find((item) =>
        isSamePendingPrivacyRequest(item, input),
      ) ?? null
    );
  }
  async function serial<T>(work: () => Promise<T>): Promise<T> {
    if (busy)
      throw new AccountRequestsError(
        "REFRESH_REQUIRED",
        "Wait for the current account request check to finish.",
      );
    busy = true;
    try {
      return await work();
    } finally {
      busy = false;
    }
  }
  async function post(candidate: PendingAccountRequest) {
    await current();
    try {
      const response = await options.request({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-contract-version": "longball.events/1.1",
          "idempotency-key": candidate.idempotencyKey,
        },
        body: JSON.stringify(candidate.body),
      });
      const saved = parsePrivacyRequestDto(await readResponse(response));
      await current();
      if (!isSamePendingPrivacyRequest(saved, candidate.body))
        throw new Error("Wrong request response");
      pending = null;
      resolvedRequest = saved;
      if (snapshot)
        snapshot = {
          ...snapshot,
          items: [
            ...snapshot.items.filter(
              (item) => item.requestId !== saved.requestId,
            ),
            saved,
          ],
        };
      return state();
    } catch (failure) {
      pending = { ...candidate, phase: "uncertain" };
      if (failure instanceof AccountRequestsError) throw failure;
      throw new AccountRequestsError(
        "UNCERTAIN_SUBMISSION",
        "The service did not confirm whether this request was recorded. Check fresh request status before retrying. The original request is retained only in this open screen.",
      );
    }
  }
  return {
    getState: state,
    refresh: () =>
      serial(async () => {
        await fresh();
        resolvedRequest = null;
        if (pending) {
          const match = existing(pending.body);
          if (match) {
            pending = null;
            resolvedRequest = match;
          } else pending = { ...pending, phase: "ready_to_retry" };
        }
        return state();
      }),
    submit: (input: PrivacyRequestInput, confirmation: string) =>
      serial(async () => {
        if (!snapshot || pending)
          throw new AccountRequestsError(
            "REFRESH_REQUIRED",
            "Read current status and resolve any uncertain submission first.",
          );
        const loaded = await fresh();
        if (accountRequestConfirmation(loaded, input) !== confirmation)
          throw new AccountRequestsError(
            "SCOPE_CHANGED",
            "The affected memberships changed. Review the fresh list and confirm the request again.",
          );
        const match = existing(input);
        if (match) {
          resolvedRequest = match;
          return state();
        }
        if (
          input.kind === "leave_team" &&
          !requestMemberships(loaded, input).length
        )
          throw new AccountRequestsError(
            "SCOPE_CHANGED",
            "This team and season no longer has a current membership. No new leave request was sent.",
          );
        const candidate: PendingAccountRequest = {
          idempotencyKey: options.newId(),
          body: Object.freeze(
            JSON.parse(JSON.stringify(input)) as PrivacyRequestInput,
          ),
          phase: "uncertain",
        };
        pending = candidate;
        return post(candidate);
      }),
    retry: (confirmation: string) =>
      serial(async () => {
        if (!pending || pending.phase !== "ready_to_retry")
          throw new AccountRequestsError(
            "REFRESH_REQUIRED",
            "Check fresh status before retrying the original request.",
          );
        const candidate = pending;
        const loaded = await fresh();
        const match = existing(candidate.body);
        if (match) {
          pending = null;
          resolvedRequest = match;
          return state();
        }
        if (
          candidate.body.kind === "leave_team" &&
          !requestMemberships(loaded, candidate.body).length
        )
          throw new AccountRequestsError(
            "SCOPE_CHANGED",
            "This membership is no longer current. The original uncertain request is retained; read service status or use the agreed support process.",
          );
        if (accountRequestConfirmation(loaded, candidate.body) !== confirmation)
          throw new AccountRequestsError(
            "SCOPE_CHANGED",
            "The affected memberships changed. Review the fresh list and confirm retry again.",
          );
        return post(candidate);
      }),
  };
}
