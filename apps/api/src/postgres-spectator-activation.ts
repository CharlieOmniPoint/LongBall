import { randomUUID } from "node:crypto";
import { AccessError } from "../../../packages/application/src/access";
import type { PostgresStore } from "./postgres-store";
import { parseInvitationContext } from '../../../packages/application/src/invitation-context';
import type {
  SpectatorActivationRepository,
  SpectatorActivationAccount,
  SpectatorActivationAttempt,
  SpectatorInvitationCapability,
} from "./spectator-activation";
function refused(): never {
  throw new AccessError(
    "ACTIVATION_UNAVAILABLE",
    410,
    "This invitation activation is unavailable. No membership was granted.",
  );
}
function account(row: Record<string, unknown>): SpectatorActivationAccount {
  return {
    accountId: String(row.account_id),
    invitationId: String(row.invitation_id),
    username: String(row.username),
    state: row.state as SpectatorActivationAccount["state"],
    issuer: row.provider_issuer as string | null,
    subject: row.provider_subject as string | null,
  };
}
function attempt(row: Record<string, unknown>): SpectatorActivationAttempt {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    deviceId: String(row.device_id),
    flowId: row.flow_id as string | null,
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
    state: row.state as SpectatorActivationAttempt["state"],
  };
}
/** Core migration011 owns DDL/RLS. Runtime never creates tables or widens database grants. */
export class PostgresSpectatorActivationRepository
  implements SpectatorActivationRepository
{
  constructor(private readonly store: PostgresStore) {}
  withCapability<T>(
    input: {
      tokenHash: string;
      activationId?: string;
      provisionAccountId?: string;
      completionVerified?: true;
      nowMs: number;
    },
    work: () => Promise<T>,
  ): Promise<T> {
    return this.store.db.withContext(
      { kind: "invitation_activation", ...input },
      work,
    );
  }
  async invitation(tokenHash: string) {
    const row = await this.store.one("SELECT * FROM invitation_preflight($1)", [
      tokenHash,
    ]);
    const names = row ? await this.store.one('SELECT * FROM invitation_preview_context($1)', [tokenHash]) : null;
    return row && names
      ? {
          id: String(row.id),
          clubId: String(row.club_id),
          teamId: String(row.team_id),
          seasonId: String(row.season_id),
          expiresAt: Number(row.expires_at),
          policyVersion: String(row.policy_version),
          context: parseInvitationContext({ clubName: names.club_name, teamName: names.team_name, ageGroup: names.age_group, seasonLabel: names.season_label, inviterLabel: names.inviter_label }),
        }
      : null;
  }
  async reserveAccount(input: {
    invitation: SpectatorInvitationCapability;
    tokenHash: string;
    accountId: string;
    username: string;
    requestId: string;
    signature: string;
    nowMs: number;
  }) {
    return this.store.transaction(async () => {
      const invitation = await this.store.one(
        "SELECT id FROM spectator_invitations WHERE id=$1 AND token_hash=$2 FOR UPDATE",
        [input.invitation.id, input.tokenHash],
      );
      if (!invitation) refused();
      const existing = await this.store.one(
        "SELECT * FROM lb_spectator_activation_accounts WHERE invitation_id=$1",
        [input.invitation.id],
      );
      if (existing) return account(existing);
      await this.store.execute(
        "INSERT INTO accounts(id,issuer,subject,classification,adult_verified,strong_auth_enrolled,status) VALUES($1,'urn:longball:pending-activation',$1,'unclassified',0,0,'disabled')",
        [input.accountId],
      );
      await this.store.execute(
        "INSERT INTO lb_spectator_activation_accounts(account_id,invitation_id,invitation_token_hash,club_id,team_id,season_id,username,state,created_request_id,request_signature,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'provisioning',$8,$9,$10)",
        [
          input.accountId,
          input.invitation.id,
          input.tokenHash,
          input.invitation.clubId,
          input.invitation.teamId,
          input.invitation.seasonId,
          input.username,
          input.requestId,
          input.signature,
          input.nowMs,
        ],
      );
      const row = await this.store.one(
        "SELECT * FROM lb_spectator_activation_accounts WHERE account_id=$1",
        [input.accountId],
      );
      if (!row) refused();
      return account(row);
    });
  }
  async bindProvider(accountId: string, issuer: string, subject: string) {
    return this.store.transaction(async () => {
      const row = await this.store.one(
        "SELECT * FROM lb_spectator_activation_accounts WHERE account_id=$1 FOR UPDATE",
        [accountId],
      );
      if (!row || row.state === "active") refused();
      if (
        row.provider_subject &&
        (row.provider_subject !== subject || row.provider_issuer !== issuer)
      )
        refused();
      await this.store.execute(
        "UPDATE accounts SET issuer=$1,subject=$2 WHERE id=$3 AND classification='unclassified' AND status='disabled'",
        [issuer, subject, accountId],
      );
      await this.store.execute(
        "UPDATE lb_spectator_activation_accounts SET provider_issuer=$1,provider_subject=$2,state='pending_activation' WHERE account_id=$3",
        [issuer, subject, accountId],
      );
      return account({
        ...row,
        provider_issuer: issuer,
        provider_subject: subject,
        state: "pending_activation",
      });
    });
  }
  async reserveAttempt(input: {
    accountId: string;
    id: string;
    requestId: string;
    signature: string;
    deviceId: string;
    expiresAt: number;
    nowMs: number;
  }) {
    return this.store.transaction(async () => {
      const owner = await this.store.one(
        "SELECT * FROM lb_spectator_activation_accounts WHERE account_id=$1 FOR UPDATE",
        [input.accountId],
      );
      if (!owner || owner.state !== "pending_activation") refused();
      const existing = await this.store.one(
        "SELECT * FROM lb_spectator_activation_attempts WHERE account_id=$1 AND state IN('provisioning','pending_activation')",
        [input.accountId],
      );
      // Token possession permits exact flow continuation, never replacement of a live provider setup.
      if (existing) {
        if (
          Number(existing.expires_at) <= input.nowMs ||
          existing.device_id !== input.deviceId ||
          existing.request_signature !== input.signature
        )
          refused();
        return attempt(existing);
      }
      const generation = Number(
        (
          await this.store.one(
            "SELECT COALESCE(MAX(generation),0)+1 AS next FROM lb_spectator_activation_attempts WHERE account_id=$1",
            [input.accountId],
          )
        )?.next ?? 1,
      );
      await this.store.execute(
        "INSERT INTO lb_spectator_activation_attempts(id,account_id,request_id,request_signature,device_id,expires_at,created_at,state,generation) VALUES($1,$2,$3,$4,$5,$6,$7,'provisioning',$8)",
        [
          input.id,
          input.accountId,
          input.requestId,
          input.signature,
          input.deviceId,
          input.expiresAt,
          input.nowMs,
          generation,
        ],
      );
      return {
        id: input.id,
        accountId: input.accountId,
        deviceId: input.deviceId,
        flowId: null,
        expiresAt: input.expiresAt,
        createdAt: input.nowMs,
        state: "provisioning" as const,
      };
    });
  }
  async bindFlow(attemptId: string, flowId: string, expiresAt: number) {
    return this.store.transaction(async () => {
      const row = await this.store.one(
        "SELECT * FROM lb_spectator_activation_attempts WHERE id=$1 FOR UPDATE",
        [attemptId],
      );
      if (
        !row ||
        !["provisioning", "pending_activation"].includes(String(row.state)) ||
        expiresAt > Number(row.expires_at) ||
        (row.flow_id && row.flow_id !== flowId)
      )
        refused();
      await this.store.execute(
        "UPDATE lb_spectator_activation_attempts SET flow_id=$1,expires_at=$2,state='pending_activation' WHERE id=$3",
        [flowId, expiresAt, attemptId],
      );
      return attempt({
        ...row,
        flow_id: flowId,
        expires_at: expiresAt,
        state: "pending_activation",
      });
    });
  }
  async findAttempt(tokenHash: string, activationId?: string) {
    const row = await this.store.one(
      "SELECT * FROM lb_spectator_activation_accounts WHERE invitation_token_hash=$1",
      [tokenHash],
    );
    if (!row) return null;
    const found = await this.store.one(
      "SELECT * FROM lb_spectator_activation_attempts WHERE account_id=$1 AND ($2::text IS NULL OR id=$2) ORDER BY generation DESC LIMIT 1",
      [row.account_id, activationId ?? null],
    );
    return found ? { account: account(row), attempt: attempt(found) } : null;
  }
  async complete(input: {
    tokenHash: string;
    invitation: SpectatorInvitationCapability;
    account: SpectatorActivationAccount;
    attempt: SpectatorActivationAttempt;
    nowMs: number;
  }) {
    await this.store.transaction(async () => {
      const found = await this.findAttempt(input.tokenHash, input.attempt.id);
      if (
        !found ||
        found.attempt.expiresAt <= input.nowMs ||
        !["pending_activation", "completed"].includes(found.attempt.state)
      )
        refused();
      const owner = await this.store.one(
        "SELECT classification,status,adult_verified,strong_auth_enrolled FROM accounts WHERE id=$1 FOR UPDATE",
        [found.account.accountId],
      );
      if (
        !owner ||
        owner.classification !== "unclassified" ||
        Number(owner.adult_verified) !== 0 ||
        Number(owner.strong_auth_enrolled) !== 0
      )
        refused();
      if (found.attempt.state === "completed") {
        if (owner.status !== "active") refused();
        return;
      }
      if (owner.status !== "disabled") refused();
      await this.store.execute(
        "UPDATE accounts SET status='active' WHERE id=$1 AND classification='unclassified' AND status='disabled'",
        [found.account.accountId],
      );
      await this.store.execute(
        "UPDATE lb_spectator_activation_accounts SET state='active' WHERE account_id=$1",
        [found.account.accountId],
      );
      await this.store.execute(
        "UPDATE lb_spectator_activation_attempts SET state='completed',completed_at=$1 WHERE id=$2",
        [input.nowMs, found.attempt.id],
      );
      await this.store.execute(
        "INSERT INTO audit(id,actor_id,action,object_id,outcome,created_at,club_id,team_id,season_id,context_operation) VALUES($1,$2,'identity.spectator_activation_completed',$2,'provider_verified_sign_in_required',$3,$4,$5,$6,'spectator.activation.complete')",
        [
          randomUUID(),
          found.account.accountId,
          input.nowMs,
          input.invitation.clubId,
          input.invitation.teamId,
          input.invitation.seasonId,
        ],
      );
    });
  }
}
