import {
  isCanonicalInvitationToken,
  type InviteCreated,
  type RedactedInviteReceipt,
} from "./invitation-credentials";
import type { HttpFetch } from "./sync";

export type InvitationClientResult =
  | { kind: "issued"; receipt: InviteCreated }
  | { kind: "redacted"; receipt: RedactedInviteReceipt }
  | { kind: "accepted"; receipt: InvitationAccepted }
  | { kind: "revoked"; receipt: InvitationRevoked };
export interface InvitationAccepted {
  invitationId: string;
  teamId: string;
  seasonId: string;
  expiresAt: string;
}
export interface InvitationRevoked {
  invitationId: string;
  revoked: true;
}
export interface InvitationSummary {
  id: string;
  teamId: string;
  seasonId: string;
  expiresAt: string;
  status: "pending" | "accepted" | "revoked" | "expired" | "requires_reissue";
  canReissue: boolean;
  canRevoke: boolean;
}
export interface InvitationList {
  kind: "spectator-invitations";
  teamId: string;
  seasonId: string;
  revision: number;
  invitations: InvitationSummary[];
}
export interface InvitationClientOptions {
  baseUrl: string;
  authenticatedFetch: HttpFetch;
  /** Must reject if account/API/issuer/team/season/session changed or access was withdrawn. */
  assertCurrent: () => void;
  requestTimeoutMs?: number;
}
interface MemoryRequest {
  kind: "issue" | "reissue" | "accept" | "revoke";
  method: "POST" | "DELETE";
  path: string;
  key: string;
  bodyJson?: string;
  scope?: { teamId: string; seasonId: string };
  invitationId?: string;
}
export class InvitationClientError extends Error {
  constructor(
    readonly code: string,
    readonly status = 0,
    readonly retryable = false,
  ) {
    super(
      code === "INVITATION_REQUEST_PENDING"
        ? "Retry or explicitly close the retained invitation request before another action."
        : code === "INVITATION_REQUEST_TIMEOUT" ||
            code === "INVITATION_NETWORK_UNCERTAIN"
          ? "The invitation response is uncertain. Its exact request is retained only in this session for retry."
          : "The invitation service request could not be completed. No credential was saved or logged.",
    );
    this.name = "InvitationClientError";
  }
}
const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 200 &&
  !/[^A-Za-z0-9_.:-]/.test(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, fields: string[]) =>
  Object.keys(value).length === fields.length &&
  fields.every((key) => Object.hasOwn(value, key));
const validExpiry = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 40 &&
  Number.isFinite(Date.parse(value));
const validKey = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length === 36 &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
function invalid(): never {
  throw new InvitationClientError("INVITATION_INVALID_RESPONSE");
}
function expiry(hours: number): void {
  if (!Number.isInteger(hours) || hours < 1 || hours > 48)
    throw new InvitationClientError("INVITATION_EXPLICIT_EXPIRY_REQUIRED");
}
function issuedReceipt(value: unknown): InviteCreated {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["id", "shareUrl", "expiresAt", "teamId", "seasonId"]) ||
    !validId(value.id) ||
    !validId(value.teamId) ||
    !validId(value.seasonId) ||
    !validExpiry(value.expiresAt) ||
    typeof value.shareUrl !== "string" ||
    value.shareUrl.length > 4096
  )
    return invalid();
  try {
    const url = new URL(value.shareUrl);
    const fragment = new URLSearchParams(url.hash.slice(1));
    if (
      !["https:", "http:", "longball:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.searchParams.has("code") ||
      url.searchParams.has("token") ||
      fragment.getAll("code").length !== 1 ||
      !isCanonicalInvitationToken(fragment.get("code")) ||
      fragment.get("teamId") !== value.teamId ||
      fragment.get("seasonId") !== value.seasonId
    )
      return invalid();
  } catch {
    return invalid();
  }
  return {
    id: value.id,
    shareUrl: value.shareUrl,
    expiresAt: value.expiresAt,
    teamId: value.teamId,
    seasonId: value.seasonId,
  };
}
function redactedReceipt(value: unknown): RedactedInviteReceipt {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "id",
      "expiresAt",
      "teamId",
      "seasonId",
      "credentialAvailable",
      "requiresReissue",
    ]) ||
    !validId(value.id) ||
    !validId(value.teamId) ||
    !validId(value.seasonId) ||
    !validExpiry(value.expiresAt) ||
    value.credentialAvailable !== false ||
    value.requiresReissue !== true
  )
    return invalid();
  return {
    id: value.id,
    expiresAt: value.expiresAt,
    teamId: value.teamId,
    seasonId: value.seasonId,
    credentialAvailable: false,
    requiresReissue: true,
  };
}
function acceptedReceipt(value: unknown): InvitationAccepted {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["invitationId", "expiresAt", "teamId", "seasonId"]) ||
    !validId(value.invitationId) ||
    !validId(value.teamId) ||
    !validId(value.seasonId) ||
    !validExpiry(value.expiresAt)
  )
    return invalid();
  return {
    invitationId: value.invitationId,
    expiresAt: value.expiresAt,
    teamId: value.teamId,
    seasonId: value.seasonId,
  };
}
function revokedReceipt(value: unknown): InvitationRevoked {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["invitationId", "revoked"]) ||
    !validId(value.invitationId) ||
    value.revoked !== true
  )
    return invalid();
  return { invitationId: value.invitationId, revoked: true };
}
function listReceipt(
  value: unknown,
  teamId: string,
  seasonId: string,
): InvitationList {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "kind",
      "teamId",
      "seasonId",
      "revision",
      "invitations",
    ]) ||
    value.kind !== "spectator-invitations" ||
    value.teamId !== teamId ||
    value.seasonId !== seasonId ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Array.isArray(value.invitations)
  )
    return invalid();
  const ids = new Set<string>();
  const invitations = value.invitations.map((item): InvitationSummary => {
    if (
      !isRecord(item) ||
      !exactKeys(item, [
        "id",
        "teamId",
        "seasonId",
        "expiresAt",
        "status",
        "canReissue",
        "canRevoke",
      ]) ||
      !validId(item.id) ||
      ids.has(item.id) ||
      item.teamId !== teamId ||
      item.seasonId !== seasonId ||
      !validExpiry(item.expiresAt) ||
      typeof item.status !== "string" ||
      ![
        "pending",
        "accepted",
        "revoked",
        "expired",
        "requires_reissue",
      ].includes(item.status) ||
      typeof item.canReissue !== "boolean" ||
      typeof item.canRevoke !== "boolean"
    )
      return invalid();
    ids.add(item.id);
    return {
      id: item.id,
      teamId,
      seasonId,
      expiresAt: item.expiresAt,
      status: item.status as InvitationSummary["status"],
      canReissue: item.canReissue,
      canRevoke: item.canRevoke,
    };
  });
  return {
    kind: "spectator-invitations",
    teamId,
    seasonId,
    revision: value.revision as number,
    invitations,
  };
}

/** Ephemeral by design: never pass requests/results to a journal, generic outbox, logger or receipt history. */
export class InvitationMemoryClient {
  #pendingRequest: MemoryRequest | null = null;
  private busy = false;
  private closed = false;
  #inspection: { token: string; destination: InvitationAccepted } | null = null;
  #inspectionGeneration = 0;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  constructor(private readonly options: InvitationClientOptions) {
    const base = options.baseUrl.trim().replace(/\/$/, "");
    if (base && base !== "/") {
      const url = new URL(base);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new InvitationClientError("INVITATION_INVALID_API");
    }
    this.baseUrl = base === "/" ? "" : base;
    this.timeoutMs = options.requestTimeoutMs ?? 15_000;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 120_000
    )
      throw new InvitationClientError("INVITATION_INVALID_TIMEOUT");
  }
  /** Safe for presentation; excludes the acceptance token and serialized request. */
  get pending(): { kind: MemoryRequest["kind"] } | null {
    return this.#pendingRequest ? { kind: this.#pendingRequest.kind } : null;
  }
  /** Accidental serialization cannot turn this in-memory capability into a retained outbox. */
  toJSON(): {
    kind: "ephemeral_invitation_client";
    pending: { kind: MemoryRequest["kind"] } | null;
  } {
    return { kind: "ephemeral_invitation_client", pending: this.pending };
  }
  private current(): void {
    if (this.closed)
      throw new InvitationClientError("INVITATION_SESSION_CLOSED");
    this.options.assertCurrent();
  }
  async list(teamId: string, seasonId: string): Promise<InvitationList> {
    this.current();
    if (!validId(teamId) || !validId(seasonId))
      throw new InvitationClientError("INVITATION_INVALID_REQUEST");
    const response = await this.bounded((signal) =>
      this.send(
        {
          path: `/v1/teams/${encodeURIComponent(teamId)}/spectator-invites?seasonId=${encodeURIComponent(seasonId)}`,
          method: "GET",
        },
        signal,
      ),
    );
    if (response.status !== 200) return invalid();
    return listReceipt(response.value, teamId, seasonId);
  }
  async inspect(token: string): Promise<InvitationAccepted> {
    this.current();
    if (!isCanonicalInvitationToken(token))
      throw new InvitationClientError("INVITATION_INVALID_CREDENTIAL");
    this.#inspection = null;
    const generation = ++this.#inspectionGeneration;
    const response = await this.bounded((signal) =>
      this.send(
        {
          path: "/v1/spectator-invites/inspect",
          method: "POST",
          bodyJson: JSON.stringify({ token }),
        },
        signal,
      ),
    );
    if (response.status !== 200) return invalid();
    if (generation !== this.#inspectionGeneration)
      throw new InvitationClientError("INVITATION_REVIEW_CHANGED");
    const destination = acceptedReceipt(response.value);
    this.#inspection = { token, destination };
    return { ...destination };
  }
  issue(
    teamId: string,
    body: { seasonId: string; expiresInHours: number },
    key: string,
  ): Promise<InvitationClientResult> {
    expiry(body.expiresInHours);
    if (
      !validId(teamId) ||
      !validId(body.seasonId) ||
      !exactKeys(body, ["seasonId", "expiresInHours"])
    )
      throw new InvitationClientError("INVITATION_INVALID_REQUEST");
    return this.begin({
      kind: "issue",
      method: "POST",
      path: `/v1/teams/${encodeURIComponent(teamId)}/spectator-invites`,
      key,
      scope: { teamId, seasonId: body.seasonId },
      bodyJson: JSON.stringify({
        seasonId: body.seasonId,
        expiresInHours: body.expiresInHours,
      }),
    });
  }
  reissue(
    teamId: string,
    invitationId: string,
    body: { seasonId: string; expiresInHours: number },
    key: string,
  ): Promise<InvitationClientResult> {
    expiry(body.expiresInHours);
    if (
      !validId(teamId) ||
      !validId(invitationId) ||
      !validId(body.seasonId) ||
      !exactKeys(body, ["seasonId", "expiresInHours"])
    )
      throw new InvitationClientError("INVITATION_INVALID_REQUEST");
    return this.begin({
      kind: "reissue",
      method: "POST",
      path: `/v1/teams/${encodeURIComponent(teamId)}/spectator-invites/${encodeURIComponent(invitationId)}/reissue`,
      key,
      scope: { teamId, seasonId: body.seasonId },
      bodyJson: JSON.stringify({
        seasonId: body.seasonId,
        expiresInHours: body.expiresInHours,
      }),
    });
  }
  accept(token: string, key: string): Promise<InvitationClientResult> {
    this.current();
    if (!isCanonicalInvitationToken(token))
      throw new InvitationClientError("INVITATION_INVALID_CREDENTIAL");
    if (!this.#inspection || this.#inspection.token !== token)
      throw new InvitationClientError("INVITATION_DESTINATION_REVIEW_REQUIRED");
    return this.begin({
      kind: "accept",
      method: "POST",
      path: "/v1/spectator-invites/accept",
      key,
      scope: {
        teamId: this.#inspection.destination.teamId,
        seasonId: this.#inspection.destination.seasonId,
      },
      invitationId: this.#inspection.destination.invitationId,
      bodyJson: JSON.stringify({ token }),
    });
  }
  revoke(
    teamId: string,
    invitationId: string,
    seasonId: string,
    key: string,
  ): Promise<InvitationRevoked> {
    if (!validId(teamId) || !validId(invitationId) || !validId(seasonId))
      throw new InvitationClientError("INVITATION_INVALID_REQUEST");
    return this.begin({
      kind: "revoke",
      method: "DELETE",
      path: `/v1/teams/${encodeURIComponent(teamId)}/spectator-invites/${encodeURIComponent(invitationId)}?seasonId=${encodeURIComponent(seasonId)}`,
      key,
      invitationId,
    }).then((result) =>
      result.kind === "revoked" ? result.receipt : invalid(),
    );
  }
  private begin(request: MemoryRequest): Promise<InvitationClientResult> {
    this.current();
    if (this.#pendingRequest || this.busy)
      throw new InvitationClientError("INVITATION_REQUEST_PENDING");
    if (!validKey(request.key))
      throw new InvitationClientError("INVITATION_INVALID_KEY");
    this.#pendingRequest = Object.freeze(request);
    return this.retry();
  }
  async retry(): Promise<InvitationClientResult> {
    this.current();
    if (!this.#pendingRequest || this.busy)
      throw new InvitationClientError("INVITATION_REQUEST_PENDING");
    this.busy = true;
    const request = this.#pendingRequest;
    try {
      const result = await this.bounded((signal) =>
        this.exchange(request, signal),
      );
      this.current();
      this.#pendingRequest = null;
      if (result.kind === "accepted") this.#inspection = null;
      return result;
    } finally {
      this.busy = false;
    }
  }
  private async bounded<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new InvitationClientError("INVITATION_REQUEST_TIMEOUT", 0, true),
        );
      }, this.timeoutMs);
    });
    try {
      const result = await Promise.race([
        operation(controller.signal),
        timeout,
      ]);
      this.current();
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
  private async exchange(
    request: MemoryRequest,
    signal: AbortSignal,
  ): Promise<InvitationClientResult> {
    const { status, value } = await this.send(request, signal);
    if (request.kind === "revoke") {
      if (status !== 200) return invalid();
      const receipt = revokedReceipt(value);
      if (receipt.invitationId !== request.invitationId) return invalid();
      return { kind: "revoked", receipt };
    }
    if (request.kind === "accept") {
      if (status !== 200) return invalid();
      const receipt = acceptedReceipt(value);
      if (
        receipt.invitationId !== request.invitationId ||
        receipt.teamId !== request.scope?.teamId ||
        receipt.seasonId !== request.scope?.seasonId
      )
        return invalid();
      return { kind: "accepted", receipt };
    }
    const receipt =
      status === 201
        ? issuedReceipt(value)
        : status === 200
          ? redactedReceipt(value)
          : invalid();
    if (
      receipt.teamId !== request.scope?.teamId ||
      receipt.seasonId !== request.scope?.seasonId
    )
      return invalid();
    return status === 201
      ? { kind: "issued", receipt: receipt as InviteCreated }
      : { kind: "redacted", receipt: receipt as RedactedInviteReceipt };
  }
  private async send(
    request: { path: string; method: string; key?: string; bodyJson?: string },
    signal: AbortSignal,
  ): Promise<{ status: number; value: unknown }> {
    let response;
    try {
      response = await this.options.authenticatedFetch(
        this.baseUrl + request.path,
        {
          method: request.method,
          headers: {
            Accept: "application/json",
            ...(request.bodyJson ? { "Content-Type": "application/json" } : {}),
            "X-Api-Contract-Version": "longball.events/1.1",
            ...(request.key ? { "Idempotency-Key": request.key } : {}),
          },
          body: request.bodyJson,
          signal,
        },
      );
    } catch {
      throw new InvitationClientError("INVITATION_NETWORK_UNCERTAIN", 0, true);
    }
    this.current();
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new InvitationClientError(
        "INVITATION_INVALID_RESPONSE",
        response.status,
        true,
      );
    }
    this.current();
    if (!response.ok) {
      // Do not echo server error strings: an upstream error may accidentally contain a token.
      throw new InvitationClientError(
        "INVITATION_HTTP_REFUSED",
        response.status,
        response.status >= 500 || response.status === 429,
      );
    }
    return { status: response.status, value };
  }
  /** User-confirmed release after an uncertain response; never revokes or reverses the remote operation. */
  closePending(): void {
    if (this.busy)
      throw new InvitationClientError("INVITATION_REQUEST_PENDING");
    this.#pendingRequest = null;
    this.#inspection = null;
    this.#inspectionGeneration += 1;
  }
  /** Explicitly releases memory only; does not undo a possibly accepted request or revoke any grant. */
  close(): void {
    this.closed = true;
    this.#pendingRequest = null;
    this.#inspection = null;
    this.#inspectionGeneration += 1;
  }
}
