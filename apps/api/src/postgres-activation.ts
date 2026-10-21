import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  AccessError,
  assertCanManageTeam,
  type Principal,
} from "../../../packages/application/src/access";
import type { PostgresStore } from "./postgres-store";
import {
  installActivationSecurity,
  verifyActivationSecurity,
} from "./postgres-security";
/** Explicit experiment policy; no proposed expiry or live-onboarding authority is assumed. */
export interface ActivationPolicy {
  version: string;
  activationTtlMs: number;
  fictionalOnly: true;
}
export interface ActivationProvider {
  issuer: string;
  credentialSetupOrigins: readonly string[];
  /** Idempotent by operationId; creates a disabled username-only child, never adopts another user. */
  provisionPending(input: {
    operationId: string;
    accountId: string;
    username: string;
    classification: "child_shared";
    emailRequired: false;
  }): Promise<{
    issuer: string;
    subject: string;
    username: string;
    pending: true;
    credentialConfigured: false;
  }>;
  /** Idempotent operation. Credentials and recovery material are handled solely by the provider UI. */
  beginCredentialSetup(input: {
    operationId: string;
    accountId: string;
    issuer: string;
    subject: string;
    username: string;
    expiresAt: number;
  }): Promise<{
    flowId: string;
    setupUrl: string;
    expiresAt: number;
  }>;
  /** Cancellation must tombstone operationId, including before begin completes, preventing a late flow. */
  cancelCredentialSetup(input: {
    operationId: string;
    issuer: string;
    subject: string;
  }): Promise<void>;
  /** Verify a provider-generated completion proof, not claims supplied by a manager/client. */
  verifyCredentialSetup(input: {
    operationId: string;
    flowId: string;
    issuer: string;
    subject: string;
    completionProof: string;
  }): Promise<{
    issuer: string;
    subject: string;
    flowId: string;
    completedAt: number;
    credentialConfigured: true;
    recoveryMaterialIssued: true;
  }>;
}
export interface PendingChildInput {
  requestId: string;
  teamId: string;
  seasonId: string;
  playerId: string;
}
export interface IssueActivationInput {
  requestId: string;
  teamId: string;
  seasonId: string;
  accountId: string;
}
export interface PendingChildReceipt {
  accountId: string;
  username: string;
  classification: "child_shared";
  status: "pending_activation" | "active";
  signInEnabled: boolean;
}
export interface ActivationReceipt {
  activationId: string;
  token: string;
  expiresAt: number;
  policyVersion: string;
  delivery: "verified_household_process_required";
}
export interface ActivationSetupReceipt {
  activationId: string;
  providerSetupUrl: string;
  expiresAt: number;
  status: "provider_credential_setup_required";
}
export interface PendingVerificationReceipt {
  requestId: string;
  status: "pending_independent_verification";
  completed: false;
}
interface ChildRow {
  account_id: string;
  club_id: string;
  username: string;
  team_id: string;
  season_id: string;
  player_id: string;
  request_id: string;
  request_signature: string;
  state: "provisioning" | "pending_activation" | "active";
  provider_issuer: string | null;
  provider_subject: string | null;
  activation_generation: number;
}
interface TokenRow {
  id: string;
  account_id: string;
  token_hash: string;
  expires_at: number;
  created_at: number;
  state: "issued" | "redeeming" | "completed" | "revoked";
  redemption_id: string | null;
  flow_id: string | null;
  flow_expires_at: number | null;
  cancelled_at: number | null;
}
interface IssueRow {
  request_id: string;
  signature: string;
  generation: number;
  state: "preparing" | "issued";
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(value);
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function unavailable(): never {
  throw new AccessError(
    "ACTIVATION_UNAVAILABLE",
    410,
    "This activation cannot be used. Request a new activation through the agreed household process.",
  );
}
function invalid(): never {
  throw new AccessError(
    "INVALID_REQUEST",
    400,
    "Use the documented activation request fields.",
  );
}
function conflict(): never {
  throw new AccessError(
    "REQUEST_CONFLICT",
    409,
    "The request identifier was already used for another operation.",
  );
}
function fields(
  value: unknown,
  names: string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !names.includes(key)) ||
    names.some((key) => !(key in value))
  )
    invalid();
}
function fingerprint(actor: string, input: object): string {
  return hash(
    JSON.stringify([
      actor,
      ...Object.entries(input).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ]),
  );
}
function username(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  // A mask is unbiased for this 32-symbol alphabet.
  return `LB${Array.from(randomBytes(12), (byte) => alphabet[byte & 31]).join("")}`;
}
/** Async PostgreSQL activation repository; provider operations remain outside committed transactions. */
export class PostgresActivationService {
  private readonly ready: Promise<void>;
  async initialize(): Promise<this> {
    await this.ready;
    return this;
  }
  readonly configured: boolean;
  private readonly store: PostgresStore;
  private readonly provider?: ActivationProvider;
  private readonly policy?: ActivationPolicy;
  constructor(options: {
    store: PostgresStore;
    provider?: ActivationProvider;
    policy?: ActivationPolicy;
  }) {
    this.store = options.store;
    this.provider = options.provider;
    this.policy = options.policy;
    if (
      options.policy &&
      (options.policy.fictionalOnly !== true ||
        !id(options.policy.version) ||
        !Number.isSafeInteger(options.policy.activationTtlMs) ||
        options.policy.activationTtlMs <= 0)
    )
      throw new Error(
        "An explicit versioned fictional activation policy and positive expiry are required.",
      );
    if (options.provider) {
      const issuer = new URL(options.provider.issuer);
      if (
        issuer.protocol !== "https:" ||
        issuer.username ||
        issuer.password ||
        issuer.search ||
        issuer.hash ||
        !options.provider.credentialSetupOrigins.length
      )
        throw new Error(
          "Activation requires a configured HTTPS provider and credential origins.",
        );
      for (const origin of options.provider.credentialSetupOrigins) {
        const parsed = new URL(origin);
        if (parsed.protocol !== "https:" || parsed.origin !== origin)
          throw new Error(
            "Credential setup origins must be exact HTTPS origins.",
          );
      }
    }
    this.configured = Boolean(options.provider && options.policy);
    this.ready = this.migrate();
  }
  private async enabled(): Promise<{
    provider: ActivationProvider;
    policy: ActivationPolicy;
  }> {
    if (!this.provider || !this.policy)
      throw new AccessError(
        "ACTIVATION_NOT_CONFIGURED",
        503,
        "Activation requires an explicitly configured provider flow and expiry policy.",
      );
    return { provider: this.provider, policy: this.policy };
  }
  private async migrate(): Promise<void> {
    if (this.store.db.migrationMode === "verify") {
      const version = await this.store.one(
        "SELECT version FROM lb_activation_schema WHERE singleton=1",
      );
      if (!version || version.version !== 2)
        throw new Error(
          "Activation schema is missing or unsupported. Run the privileged migration command; preserve the database.",
        );
      await verifyActivationSecurity(this.store.db);
      return;
    }
    await this.store.transaction(async () => {
      await this.store.db.query(
        "CREATE TABLE IF NOT EXISTS lb_activation_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL)",
      );
      const version = (await this.store.one(
        "SELECT version FROM lb_activation_schema WHERE singleton=1",
        [],
      )) as
        | {
            version: number;
          }
        | undefined;
      if (version && ![1, 2].includes(version.version))
        throw new Error(
          "Unsupported activation feature schema; preserve the database.",
        );
      if (version?.version === 2) {
        await verifyActivationSecurity(this.store.db);
        return;
      }
      if (!version)
        await this.store.db.query(`
        CREATE TABLE lb_activation_children(
          account_id TEXT PRIMARY KEY REFERENCES accounts(id),username TEXT NOT NULL,
          team_id TEXT NOT NULL REFERENCES teams(id),season_id TEXT NOT NULL,player_id TEXT NOT NULL,
          request_id TEXT NOT NULL UNIQUE,request_signature TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('provisioning','pending_activation','active')),
          provider_issuer TEXT,provider_subject TEXT,activation_generation INTEGER NOT NULL DEFAULT 0,
          created_by TEXT NOT NULL REFERENCES accounts(id),created_at BIGINT NOT NULL,
          UNIQUE(team_id,season_id,player_id),UNIQUE(provider_issuer,provider_subject));
        CREATE TABLE lb_activation_issues(request_id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES lb_activation_children(account_id),signature TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('preparing','issued')),created_at BIGINT NOT NULL);
        CREATE TABLE lb_activation_tokens(
          id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES lb_activation_children(account_id),token_hash TEXT NOT NULL UNIQUE,
          issue_request_id TEXT NOT NULL UNIQUE REFERENCES lb_activation_issues(request_id),issued_by TEXT NOT NULL REFERENCES accounts(id),
          expires_at BIGINT NOT NULL,created_at BIGINT NOT NULL,policy_version TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('issued','redeeming','completed','revoked')),
          redemption_id TEXT,flow_id TEXT,flow_expires_at BIGINT,cancelled_at BIGINT,completed_at BIGINT);
        CREATE INDEX lb_activation_account_tokens ON lb_activation_tokens(account_id,state);
        CREATE TABLE lb_activation_verification_requests(
          request_id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('link','recovery')),actor_id TEXT NOT NULL REFERENCES accounts(id),
          team_id TEXT NOT NULL REFERENCES teams(id),season_id TEXT NOT NULL,player_id TEXT,target_account_id TEXT NOT NULL,
          signature TEXT NOT NULL,status TEXT NOT NULL CHECK(status='pending_independent_verification'),policy_version TEXT NOT NULL,created_at BIGINT NOT NULL);
        CREATE UNIQUE INDEX lb_activation_username_casefold ON lb_activation_children(lower(username));
CREATE FUNCTION lb_activation_immutable_child_guard() RETURNS trigger LANGUAGE plpgsql AS $longball$ BEGIN IF NEW.classification <> 'child_shared' AND EXISTS(SELECT 1 FROM lb_activation_children WHERE account_id=OLD.id) THEN RAISE EXCEPTION 'Child account classification is immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END; $longball$;
CREATE TRIGGER lb_activation_immutable_child BEFORE UPDATE OF classification ON accounts FOR EACH ROW EXECUTE FUNCTION lb_activation_immutable_child_guard();
        INSERT INTO lb_activation_schema VALUES(1,1);
      `);
      await installActivationSecurity(this.store.db);
      await this.store.execute(
        "UPDATE lb_activation_schema SET version=2 WHERE singleton=1",
      );
    });
  }
  private async manager(
    principal: Principal,
    teamId: string,
    seasonId: string,
  ): Promise<void> {
    // Re-read account state after asynchronous provider calls; caller-held claims are not authority.
    const fresh = await this.store.principal({
      issuer: principal.issuer,
      subject: principal.subject,
      strongAuth: principal.strongAuth,
      authenticatedAt: principal.authenticatedAt,
    });
    if (fresh.accountId !== principal.accountId)
      throw new AccessError(
        "NOT_FOUND",
        404,
        "The requested object is unavailable.",
      );
    assertCanManageTeam(
      fresh,
      await this.store.memberships(),
      teamId,
      seasonId,
      this.store.now(),
    );
  }
  private async child(
    principal: Principal,
    accountId: string,
    teamId: string,
    seasonId: string,
  ): Promise<ChildRow> {
    await this.manager(principal, teamId, seasonId);
    const row = (await this.store.one(
      "SELECT * FROM lb_activation_children WHERE account_id=$1 AND team_id=$2 AND season_id=$3",
      [accountId, teamId, seasonId],
    )) as unknown as ChildRow | undefined;
    if (!row)
      throw new AccessError(
        "NOT_FOUND",
        404,
        "The requested object is unavailable.",
      );
    return row;
  }
  private async receipt(child: ChildRow): Promise<PendingChildReceipt> {
    return {
      accountId: child.account_id,
      username: child.username,
      classification: "child_shared",
      status: child.state === "active" ? "active" : "pending_activation",
      signInEnabled: child.state === "active",
    };
  }
  private async providerCall<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch {
      throw new AccessError(
        "PROVIDER_FLOW_UNAVAILABLE",
        503,
        "The identity operation is incomplete. Retry the same request; pending evidence has been retained.",
      );
    }
  }
  private async withProvisionedAccount<T>(
    accountId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const current = this.store.db.applicationContext;
    // Owner-only migration/tests have no actor context. Runtime SQL without authority remains denied by RLS.
    return current?.kind === "actor"
      ? this.store.db.withContext(
          { ...current, provisionAccountId: accountId },
          work,
        )
      : work();
  }
  async createPendingChild(
    principal: Principal,
    input: PendingChildInput,
  ): Promise<PendingChildReceipt> {
    await this.ready;
    const { provider } = await this.enabled();
    fields(input, ["requestId", "teamId", "seasonId", "playerId"]);
    if (
      ![input.requestId, input.teamId, input.seasonId, input.playerId].every(id)
    )
      invalid();
    const signature = fingerprint(principal.accountId, input);
    const candidateAccountId = randomUUID();
    const row = await this.withProvisionedAccount(candidateAccountId, () =>
      this.store.transaction(async () => {
        await this.manager(principal, input.teamId, input.seasonId);
        const existing = (await this.store.one(
          "SELECT * FROM lb_activation_children WHERE request_id=$1",
          [input.requestId],
        )) as unknown as ChildRow | undefined;
        if (existing) {
          if (existing.request_signature !== signature) conflict();
          return existing;
        }
        const profile = (
          await this.store.preparation(principal, input.teamId, input.seasonId)
        ).profiles.find(
          (item) =>
            item.playerId === input.playerId &&
            item.seasonId === input.seasonId &&
            item.active,
        );
        if (!profile)
          throw new AccessError(
            "NOT_FOUND",
            404,
            "The requested object is unavailable.",
          );
        if (
          (await this.store.memberships()).some(
            (item) =>
              item.teamId === input.teamId &&
              item.seasonId === input.seasonId &&
              item.playerId === input.playerId &&
              item.role === "player" &&
              item.revokedAt == null,
          )
        )
          throw new AccessError(
            "PLAYER_ACCOUNT_EXISTS",
            409,
            "This player already has an account assignment. Use the verified exact-account linking process.",
          );
        const accountId = candidateAccountId;
        let chosen = username();
        for (
          let tries = 0;
          await this.store.one(
            "SELECT 1 FROM lb_activation_children WHERE lower(username)=lower($1)",
            [chosen],
          );
          tries++
        ) {
          if (tries >= 10)
            throw new AccessError(
              "IDENTITY_ALLOCATION_UNAVAILABLE",
              503,
              "A unique username could not be allocated.",
            );
          chosen = username();
        }
        await this.store.execute(
          "INSERT INTO accounts(id,issuer,subject,classification,adult_verified,strong_auth_enrolled,status) VALUES($1,$2,$3,$4,0,0,$5)",
          [
            accountId,
            "urn:longball:pending-activation",
            accountId,
            "child_shared",
            "disabled",
          ],
        );
        await this.store.execute(
          "INSERT INTO lb_activation_children(account_id,username,team_id,season_id,player_id,request_id,request_signature,state,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'provisioning',$8,$9)",
          [
            accountId,
            chosen,
            input.teamId,
            input.seasonId,
            input.playerId,
            input.requestId,
            signature,
            principal.accountId,
            this.store.now(),
          ],
        );
        await this.store.execute(
          "INSERT INTO memberships(account_id,team_id,season_id,role,player_id) VALUES($1,$2,$3,'player',$4)",
          [accountId, input.teamId, input.seasonId, input.playerId],
        );
        await this.store.audit(
          principal,
          "identity.child_reserved",
          accountId,
          "pending_provider",
        );
        return await this.child(
          principal,
          accountId,
          input.teamId,
          input.seasonId,
        );
      }),
    );
    if (row.state !== "provisioning") return await this.receipt(row);
    const result = await this.providerCall(() =>
      provider.provisionPending({
        operationId: `pending:${row.account_id}`,
        accountId: row.account_id,
        username: row.username,
        classification: "child_shared",
        emailRequired: false,
      }),
    );
    if (
      result.issuer !== provider.issuer ||
      typeof result.subject !== "string" ||
      !result.subject ||
      result.subject.length > 255 ||
      typeof result.username !== "string" ||
      result.username.toUpperCase() !== row.username.toUpperCase() ||
      result.pending !== true ||
      result.credentialConfigured !== false
    )
      throw new AccessError(
        "PROVIDER_BINDING_REJECTED",
        502,
        "The pending provider identity could not be safely bound.",
      );
    return await this.withProvisionedAccount(row.account_id, () =>
      this.store.transaction(async () => {
        const fresh = await this.child(
          principal,
          row.account_id,
          input.teamId,
          input.seasonId,
        );
        if (fresh.state !== "provisioning") {
          if (
            fresh.provider_issuer !== result.issuer ||
            fresh.provider_subject !== result.subject
          )
            throw new AccessError(
              "PROVIDER_BINDING_REJECTED",
              409,
              "The provider identity requires reconciliation.",
            );
          return await this.receipt(fresh);
        }
        const binding = await this.store.one(
          "SELECT id FROM accounts WHERE issuer=$1 AND subject=$2 AND id!=$3",
          [result.issuer, result.subject, row.account_id],
        );
        if (binding)
          throw new AccessError(
            "PROVIDER_BINDING_REJECTED",
            409,
            "The provider identity requires reconciliation.",
          );
        await this.store.execute(
          "UPDATE accounts SET issuer=$1,subject=$2 WHERE id=$3 AND status='disabled'",
          [result.issuer, result.subject, row.account_id],
        );
        await this.store.execute(
          "UPDATE lb_activation_children SET provider_issuer=$1,provider_subject=$2,state='pending_activation' WHERE account_id=$3",
          [result.issuer, result.subject, row.account_id],
        );
        await this.store.audit(
          principal,
          "identity.child_provisioned",
          row.account_id,
          "pending_activation",
        );
        return await this.receipt(
          await this.child(
            principal,
            row.account_id,
            input.teamId,
            input.seasonId,
          ),
        );
      }),
    ).catch((error: unknown) => {
      // An out-of-scope issuer/subject collision remains hidden; the unique constraint still refuses adoption.
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "23505"
      ) {
        throw new AccessError(
          "PROVIDER_BINDING_REJECTED",
          409,
          "The provider identity requires reconciliation.",
        );
      }
      throw error;
    });
  }
  async issueActivation(
    principal: Principal,
    input: IssueActivationInput,
  ): Promise<ActivationReceipt> {
    await this.ready;
    const { provider, policy } = await this.enabled();
    fields(input, ["requestId", "teamId", "seasonId", "accountId"]);
    if (
      ![input.requestId, input.teamId, input.seasonId].every(id) ||
      !uuid(input.accountId)
    )
      invalid();
    const signature = fingerprint(principal.accountId, input);
    const preparation = await this.store.transaction(async () => {
      const child = await this.child(
        principal,
        input.accountId,
        input.teamId,
        input.seasonId,
      );
      if (child.state !== "pending_activation")
        throw new AccessError(
          "ACTIVATION_NOT_PENDING",
          409,
          "This account is not awaiting activation.",
        );
      let issue = (await this.store.one(
        "SELECT * FROM lb_activation_issues WHERE request_id=$1",
        [input.requestId],
      )) as unknown as IssueRow | undefined;
      if (issue && issue.signature !== signature) conflict();
      if (issue?.state === "issued")
        throw new AccessError(
          "ACTIVATION_ALREADY_ISSUED",
          409,
          "The secret was issued once and cannot be retrieved. Explicitly reissue using a new request identifier.",
        );
      if (!issue) {
        const generation = child.activation_generation + 1;
        await this.store.execute(
          "UPDATE lb_activation_children SET activation_generation=$1 WHERE account_id=$2",
          [generation, child.account_id],
        );
        await this.store.execute(
          "INSERT INTO lb_activation_issues(request_id,account_id,signature,generation,state,created_at) VALUES($1,$2,$3,$4,'preparing',$5)",
          [
            input.requestId,
            child.account_id,
            signature,
            generation,
            this.store.now(),
          ],
        );
        await this.store.execute(
          "UPDATE lb_activation_tokens SET state='revoked' WHERE account_id=$1 AND state IN ('issued','redeeming')",
          [child.account_id],
        );
        issue = {
          request_id: input.requestId,
          signature,
          generation,
          state: "preparing",
        };
      }
      const obsolete = (await this.store.many(
        "SELECT * FROM lb_activation_tokens WHERE account_id=$1 AND state='revoked' AND redemption_id IS NOT NULL AND cancelled_at IS NULL",
        [child.account_id],
      )) as unknown as TokenRow[];
      return { child, issue, obsolete };
    });
    for (const old of preparation.obsolete) {
      await this.providerCall(() =>
        provider.cancelCredentialSetup({
          operationId: `activation:${old.id}`,
          issuer: preparation.child.provider_issuer!,
          subject: preparation.child.provider_subject!,
        }),
      );
      await this.store.transaction(
        async () =>
          await this.store.execute(
            "UPDATE lb_activation_tokens SET cancelled_at=$1 WHERE id=$2 AND state='revoked'",
            [this.store.now(), old.id],
          ),
      );
    }
    return await this.store.transaction(async () => {
      const child = await this.child(
        principal,
        input.accountId,
        input.teamId,
        input.seasonId,
      );
      const issue = (await this.store.one(
        "SELECT * FROM lb_activation_issues WHERE request_id=$1",
        [input.requestId],
      )) as unknown as IssueRow;
      if (issue.state === "issued")
        throw new AccessError(
          "ACTIVATION_ALREADY_ISSUED",
          409,
          "The secret was issued once. Explicitly reissue if its response was lost.",
        );
      if (
        child.state !== "pending_activation" ||
        child.activation_generation !== issue.generation
      )
        throw new AccessError(
          "ACTIVATION_SUPERSEDED",
          409,
          "Another activation request superseded this operation.",
        );
      const token = randomBytes(32).toString("base64url");
      const activationId = randomUUID();
      const expiresAt = this.store.now() + policy.activationTtlMs;
      if (!Number.isSafeInteger(expiresAt))
        throw new AccessError(
          "ACTIVATION_POLICY_INVALID",
          503,
          "The configured expiry is outside the supported range.",
        );
      await this.store.execute(
        "INSERT INTO lb_activation_tokens(id,account_id,token_hash,issue_request_id,issued_by,expires_at,created_at,policy_version,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'issued')",
        [
          activationId,
          child.account_id,
          hash(token),
          input.requestId,
          principal.accountId,
          expiresAt,
          this.store.now(),
          policy.version,
        ],
      );
      await this.store.execute(
        "UPDATE lb_activation_issues SET state='issued' WHERE request_id=$1",
        [input.requestId],
      );
      await this.store.audit(
        principal,
        "identity.activation_issued",
        activationId,
        "verified_household_delivery_required",
      );
      return {
        activationId,
        token,
        expiresAt,
        policyVersion: policy.version,
        delivery: "verified_household_process_required",
      };
    });
  }
  async redeemActivation(input: {
    token: string;
    requestId: string;
  }): Promise<ActivationSetupReceipt> {
    await this.ready;
    fields(input, ["token", "requestId"]);
    if (
      typeof input.token !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.token) ||
      !id(input.requestId)
    )
      unavailable();
    return this.store.db.withContext(
      {
        kind: "activation_token",
        tokenHash: hash(input.token),
        nowMs: this.store.now(),
      },
      () => this.redeemWithCapability(input),
    );
  }
  private async redeemWithCapability(input: {
    token: string;
    requestId: string;
  }): Promise<ActivationSetupReceipt> {
    await this.ready;
    const { provider } = await this.enabled();
    fields(input, ["token", "requestId"]);
    if (
      typeof input.token !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.token) ||
      !id(input.requestId)
    )
      unavailable();
    const reserved = await this.store.transaction(async () => {
      const token = (await this.store.one(
        "SELECT * FROM lb_activation_tokens WHERE token_hash=$1",
        [hash(input.token)],
      )) as unknown as TokenRow | undefined;
      if (
        !token ||
        token.expires_at <= this.store.now() ||
        token.state === "revoked" ||
        token.state === "completed" ||
        (token.state === "redeeming" && token.redemption_id !== input.requestId)
      )
        unavailable();
      const child = (await this.store.one(
        "SELECT * FROM lb_activation_children WHERE account_id=$1",
        [token.account_id],
      )) as unknown as ChildRow;
      if (
        child.state !== "pending_activation" ||
        !child.provider_issuer ||
        !child.provider_subject
      )
        unavailable();
      await this.store.execute(
        "UPDATE lb_activation_tokens SET state='redeeming',redemption_id=$1 WHERE id=$2",
        [input.requestId, token.id],
      );
      return { token, child };
    });
    const result = await this.providerCall(() =>
      provider.beginCredentialSetup({
        operationId: `activation:${reserved.token.id}`,
        accountId: reserved.child.account_id,
        issuer: reserved.child.provider_issuer!,
        subject: reserved.child.provider_subject!,
        username: reserved.child.username,
        expiresAt: reserved.token.expires_at,
      }),
    );
    let setup: URL;
    try {
      setup = new URL(result.setupUrl);
    } catch {
      throw new AccessError(
        "PROVIDER_FLOW_REJECTED",
        502,
        "The provider credential flow could not be safely opened.",
      );
    }
    if (
      setup.protocol !== "https:" ||
      setup.username ||
      setup.password ||
      !provider.credentialSetupOrigins.includes(setup.origin) ||
      result.setupUrl.includes(input.token) ||
      !id(result.flowId) ||
      !Number.isSafeInteger(result.expiresAt) ||
      result.expiresAt > reserved.token.expires_at ||
      result.expiresAt <= this.store.now()
    )
      throw new AccessError(
        "PROVIDER_FLOW_REJECTED",
        502,
        "The provider credential flow could not be safely opened.",
      );
    return await this.store.transaction(async () => {
      const fresh = (await this.store.one(
        "SELECT * FROM lb_activation_tokens WHERE id=$1",
        [reserved.token.id],
      )) as unknown as TokenRow;
      if (
        fresh.state !== "redeeming" ||
        fresh.redemption_id !== input.requestId ||
        fresh.expires_at <= this.store.now() ||
        (fresh.flow_id && fresh.flow_id !== result.flowId)
      )
        unavailable();
      await this.store.execute(
        "UPDATE lb_activation_tokens SET flow_id=$1,flow_expires_at=$2 WHERE id=$3",
        [result.flowId, result.expiresAt, fresh.id],
      );
      return {
        activationId: fresh.id,
        providerSetupUrl: setup.href,
        expiresAt: result.expiresAt,
        status: "provider_credential_setup_required",
      };
    });
  }
  async completeActivation(input: {
    activationId: string;
    token: string;
    completionProof: string;
  }): Promise<{ status: "complete"; signInRequired: true }> {
    await this.ready;
    fields(input, ["activationId", "token", "completionProof"]);
    if (
      !uuid(input.activationId) ||
      typeof input.token !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.token) ||
      typeof input.completionProof !== "string" ||
      !input.completionProof ||
      input.completionProof.length > 16_384
    )
      unavailable();
    return this.store.db.withContext(
      {
        kind: "activation_token",
        tokenHash: hash(input.token),
        activationId: input.activationId,
        nowMs: this.store.now(),
      },
      () => this.completeWithCapability(input),
    );
  }
  private async completeWithCapability(input: {
    activationId: string;
    token: string;
    completionProof: string;
  }): Promise<{
    status: "complete";
    signInRequired: true;
  }> {
    await this.ready;
    const { provider } = await this.enabled();
    fields(input, ["activationId", "token", "completionProof"]);
    if (
      !uuid(input.activationId) ||
      typeof input.token !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.token) ||
      typeof input.completionProof !== "string" ||
      !input.completionProof ||
      input.completionProof.length > 16384
    )
      unavailable();
    const token = (await this.store.one(
      "SELECT * FROM lb_activation_tokens WHERE id=$1 AND token_hash=$2",
      [input.activationId, hash(input.token)],
    )) as unknown as TokenRow | undefined;
    if (
      !token ||
      !["redeeming", "completed"].includes(token.state) ||
      !token.flow_id ||
      !token.flow_expires_at ||
      token.flow_expires_at <= this.store.now()
    )
      unavailable();
    const child = (await this.store.one(
      "SELECT * FROM lb_activation_children WHERE account_id=$1",
      [token.account_id],
    )) as unknown as ChildRow;
    const proof = await this.providerCall(() =>
      provider.verifyCredentialSetup({
        operationId: `activation:${token.id}`,
        flowId: token.flow_id!,
        issuer: child.provider_issuer!,
        subject: child.provider_subject!,
        completionProof: input.completionProof,
      }),
    );
    if (
      proof.issuer !== child.provider_issuer ||
      proof.subject !== child.provider_subject ||
      proof.flowId !== token.flow_id ||
      proof.credentialConfigured !== true ||
      proof.recoveryMaterialIssued !== true ||
      !Number.isSafeInteger(proof.completedAt) ||
      proof.completedAt < token.created_at ||
      proof.completedAt > this.store.now() + 30000 ||
      proof.completedAt >= token.flow_expires_at
    )
      unavailable();
    // Only independent provider verification may open the final activation write boundary.
    return await this.store.db.withContext(
      {
        kind: "activation_token",
        tokenHash: hash(input.token),
        activationId: input.activationId,
        nowMs: this.store.now(),
        completionVerified: true,
      },
      async () => {
        return await this.store.transaction(async () => {
          const fresh = (await this.store.one(
            "SELECT * FROM lb_activation_tokens WHERE id=$1",
            [token.id],
          )) as unknown as TokenRow;
          if (
            !["redeeming", "completed"].includes(fresh.state) ||
            fresh.flow_expires_at! <= this.store.now()
          )
            unavailable();
          const account = (await this.store.one(
            "SELECT classification,status FROM accounts WHERE id=$1",
            [child.account_id],
          )) as {
            classification: string;
            status: string;
          };
          if (account.classification !== "child_shared") unavailable();
          if (fresh.state === "completed") {
            if (account.status !== "active") unavailable();
            return { status: "complete", signInRequired: true };
          }
          if (account.status !== "disabled") unavailable();
          await this.store.execute(
            "UPDATE accounts SET status='active' WHERE id=$1 AND classification='child_shared'",
            [child.account_id],
          );
          await this.store.execute(
            "UPDATE lb_activation_children SET state='active' WHERE account_id=$1",
            [child.account_id],
          );
          await this.store.execute(
            "UPDATE lb_activation_tokens SET state='completed',completed_at=$1 WHERE id=$2",
            [this.store.now(), token.id],
          );
          await this.store.execute(
            "INSERT INTO audit(id,actor_id,action,object_id,outcome,created_at,club_id,team_id,season_id,context_operation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
            [
              randomUUID(),
              child.account_id,
              "identity.activation_completed",
              child.account_id,
              "provider_verified_sign_in_required",
              this.store.now(),
              child.club_id,
              child.team_id,
              child.season_id,
              "activation.complete",
            ],
          );
          return { status: "complete", signInRequired: true };
        });
      },
    );
  }
  async requestExistingAccountLink(
    principal: Principal,
    input: {
      requestId: string;
      teamId: string;
      seasonId: string;
      playerId: string;
      existingAccountId: string;
    },
  ): Promise<PendingVerificationReceipt> {
    await this.ready;
    fields(input, [
      "requestId",
      "teamId",
      "seasonId",
      "playerId",
      "existingAccountId",
    ]);
    if (!id(input.playerId) || !uuid(input.existingAccountId)) invalid();
    return await this.verificationRequest(
      principal,
      "link",
      input,
      input.existingAccountId,
      input.playerId,
    );
  }
  async requestRecovery(
    principal: Principal,
    input: {
      requestId: string;
      teamId: string;
      seasonId: string;
      accountId: string;
    },
  ): Promise<PendingVerificationReceipt> {
    await this.ready;
    fields(input, ["requestId", "teamId", "seasonId", "accountId"]);
    if (!uuid(input.accountId)) invalid();
    return await this.verificationRequest(
      principal,
      "recovery",
      input,
      input.accountId,
      null,
    );
  }
  private async verificationRequest(
    principal: Principal,
    kind: "link" | "recovery",
    input: {
      requestId: string;
      teamId: string;
      seasonId: string;
    },
    target: string,
    playerId: string | null,
  ): Promise<PendingVerificationReceipt> {
    const { policy } = await this.enabled();
    if (![input.requestId, input.teamId, input.seasonId].every(id)) invalid();
    const signature = fingerprint(principal.accountId, { ...input, kind });
    return await this.store.transaction(async () => {
      await this.manager(principal, input.teamId, input.seasonId);
      if (
        playerId &&
        !(
          await this.store.preparation(principal, input.teamId, input.seasonId)
        ).profiles.some(
          (item) =>
            item.playerId === playerId &&
            item.seasonId === input.seasonId &&
            item.active,
        )
      )
        throw new AccessError(
          "NOT_FOUND",
          404,
          "The requested object is unavailable.",
        );
      const previous = (await this.store.one(
        "SELECT signature FROM lb_activation_verification_requests WHERE request_id=$1",
        [input.requestId],
      )) as
        | {
            signature: string;
          }
        | undefined;
      if (previous && previous.signature !== signature) conflict();
      if (!previous) {
        // Deliberately do not look up the global target or expose its other memberships.
        await this.store.execute(
          "INSERT INTO lb_activation_verification_requests(request_id,kind,actor_id,team_id,season_id,player_id,target_account_id,signature,status,policy_version,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [
            input.requestId,
            kind,
            principal.accountId,
            input.teamId,
            input.seasonId,
            playerId,
            target,
            signature,
            "pending_independent_verification",
            policy.version,
            this.store.now(),
          ],
        );
        await this.store.audit(
          principal,
          `identity.${kind}_requested`,
          input.requestId,
          "pending_independent_verification",
        );
      }
      return {
        requestId: input.requestId,
        status: "pending_independent_verification",
        completed: false,
      };
    });
  }
}
