import { SqliteTeamPrivilegeRepository } from './team-privileges-repository';
import { createHash } from 'node:crypto';
import { AccessError, type Principal } from '../../../packages/application/src/access';
import type { CommunityState } from '../../../packages/application/src/community';
import { pendingInvitation } from '../../../packages/application/src/invitation-credentials';
import { retireLegacyInvitationCredentials, redactRetainedInvitationResponse } from '../../../packages/application/src/invitation-redaction';
import { DevelopmentStore } from './store';
import type { RuntimeStore } from './runtime-store';
import { assertInvitationMirror, invitationChangedRows, invitationGrantProjection, type InvitationReceipt, type InvitationRepository, type InvitationSession } from './invitation-service';

export const SQLITE_INVITATIONS_DDL = `CREATE TABLE IF NOT EXISTS spectator_invitations(
 id TEXT PRIMARY KEY,club_id TEXT NOT NULL,team_id TEXT NOT NULL REFERENCES teams(id),season_id TEXT NOT NULL,inviter_account_id TEXT NOT NULL REFERENCES accounts(id),
 credential_kind TEXT NOT NULL CHECK(credential_kind IN('sha256','legacy_retired')),credential_version INTEGER NOT NULL DEFAULT 1,
 token_hash TEXT UNIQUE,legacy_fingerprint TEXT,retired_at INTEGER,requires_reissue INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,accepted_by TEXT REFERENCES accounts(id),accepted_at INTEGER,revoked_at INTEGER,
 reissued_from_invitation_id TEXT REFERENCES spectator_invitations(id),policy_version TEXT,
 CHECK((credential_kind='sha256' AND token_hash IS NOT NULL AND policy_version IS NOT NULL) OR(credential_kind='legacy_retired' AND token_hash IS NULL)),
 CHECK((accepted_by IS NULL)=(accepted_at IS NULL)),CHECK(expires_at>created_at));`;
const unavailable = (): never => { throw new AccessError('INVITATION_UNAVAILABLE', 404, 'The invitation is unavailable.'); };
/** Explicit fictional adapter. It never claims PostgreSQL row-security or a configured identity provider. */
export class SqliteInvitationRepository implements InvitationRepository {
  constructor(private readonly source: DevelopmentStore, private readonly runtime: RuntimeStore) { source.database.exec(SQLITE_INVITATIONS_DDL); }
  transaction<T>(work: () => Promise<T>): Promise<T> { return this.runtime.transaction(work); }
  actor(session: InvitationSession, accepting = false) { return this.runtime.communityActor(session.principal, session.teamId, session.seasonId, session.role, accepting); }
  invitationAllowed(session: InvitationSession) { return new SqliteTeamPrivilegeRepository(this.source,this.runtime).own(session,'invitations'); }
  async state(teamId: string, seasonId: string) {
    const state = await this.runtime.communityState(teamId, seasonId);
    const rows = this.source.database.prepare('SELECT * FROM spectator_invitations WHERE team_id=? AND season_id=?').all(teamId, seasonId);
    for (const row of rows) assertInvitationMirror(state.invitations.find(invite => invite.id === row.id), row);
    if (rows.length !== state.invitations.length) throw new AccessError('INVITATION_RECONCILIATION_REQUIRED', 409, 'Retained invitation evidence differs. Preserve it for authorised review.');
    return state;
  }
  async initialize(): Promise<void> {
    await this.transaction(async () => {
      const docs = this.source.database.prepare("SELECT team_id,season_id FROM documents WHERE kind='community'").all() as { team_id: string; season_id: string }[];
      const digest = (input: string) => createHash('sha256').update(input).digest('hex');
      for (const doc of docs) {
        const state = await this.runtime.document<CommunityState>(doc.team_id, doc.season_id, 'community');
        const retired = retireLegacyInvitationCredentials(state, this.source.now(), digest);
        if (retired.state !== state) await this.runtime.saveDocument(doc.team_id, doc.season_id, 'community', retired.state);
        // Existing secure rows keep their recorded policy; retirement never invents one.
        for (const invite of retired.state.invitations) {
          if (invite.credential.kind !== 'legacy_retired') continue;
          const club = (await this.runtime.document<{ club: { id: string } }>(doc.team_id, doc.season_id, 'preparation')).club.id;
          this.source.database.prepare('INSERT INTO spectator_invitations(id,club_id,team_id,season_id,inviter_account_id,credential_kind,legacy_fingerprint,retired_at,requires_reissue,created_at,expires_at,accepted_by,accepted_at,revoked_at,reissued_from_invitation_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING').run(invite.id, club, invite.teamId, invite.seasonId, invite.inviterAccountId, 'legacy_retired', invite.credential.fingerprint, invite.credential.redactedAtMs, Number(invite.credential.requiresReissue), invite.createdAtMs, invite.expiresAtMs, invite.acceptedBy, invite.acceptedAtMs, invite.revokedAtMs, invite.reissuedFromInvitationId);
        }
      }
      const receipts = this.source.database.prepare('SELECT account_id,operation,key,response_json FROM idempotency').all() as { account_id: string; operation: string; key: string; response_json: string }[];
      for (const row of receipts) {
        const safe = redactRetainedInvitationResponse(JSON.parse(row.response_json), this.source.now(), digest);
        this.source.database.prepare('UPDATE idempotency SET response_json=? WHERE account_id=? AND operation=? AND key=?').run(JSON.stringify(safe), row.account_id, row.operation, row.key);
      }
    });
  }
  async save(session: InvitationSession, state: CommunityState, changedIds: string[], policyVersion: string | null): Promise<void> {
    const club = (await this.runtime.document<{ club: { id: string } }>(session.teamId, session.seasonId, 'preparation')).club.id;
    await this.runtime.saveDocument(session.teamId, session.seasonId, 'community', state);
    for (const invite of invitationChangedRows(state, changedIds)) {
      const existing = this.source.database.prepare('SELECT id FROM spectator_invitations WHERE id=?').get(invite.id);
      if (existing) this.source.database.prepare('UPDATE spectator_invitations SET accepted_by=?,accepted_at=?,revoked_at=?,requires_reissue=? WHERE id=?').run(invite.acceptedBy, invite.acceptedAtMs, invite.revokedAtMs, invite.credential.kind === 'legacy_retired' ? Number(invite.credential.requiresReissue) : 0, invite.id);
      else {
        if (invite.credential.kind !== 'sha256' || !policyVersion) throw new Error('INVITATION_POLICY_REQUIRED');
        this.source.database.prepare("INSERT INTO spectator_invitations(id,club_id,team_id,season_id,inviter_account_id,credential_kind,token_hash,created_at,expires_at,accepted_by,accepted_at,revoked_at,reissued_from_invitation_id,policy_version) VALUES(?,?,?,?,?,'sha256',?,?,?,?,?,?,?,?)").run(invite.id, club, invite.teamId, invite.seasonId, invite.inviterAccountId, invite.credential.tokenHash, invite.createdAtMs, invite.expiresAtMs, invite.acceptedBy, invite.acceptedAtMs, invite.revokedAtMs, invite.reissuedFromInvitationId, policyVersion);
      }
    }
    await this.runtime.synchronizeSpectatorMemberships(invitationGrantProjection(state, changedIds));
  }
  async receipt(accountId: string, operation: string, key: string): Promise<InvitationReceipt | null> {
    const row = this.source.database.prepare('SELECT signature,response_json FROM idempotency WHERE account_id=? AND operation=? AND key=?').get(accountId, operation, key) as { signature: string; response_json: string } | undefined;
    return row ? { signature: row.signature, response: JSON.parse(row.response_json) } : null;
  }
  async saveReceipt(accountId: string, operation: string, key: string, receipt: InvitationReceipt): Promise<void> { this.source.database.prepare('INSERT INTO idempotency(account_id,operation,key,signature,response_json) VALUES(?,?,?,?,?)').run(accountId, operation, key, receipt.signature, JSON.stringify(receipt.response)); }
  async resolve(principal: Principal, tokenHash: string) {
    const row = this.source.database.prepare('SELECT id,team_id,season_id FROM spectator_invitations WHERE token_hash=?').get(tokenHash) as { id: string; team_id: string; season_id: string } | undefined;
    if (!row) return null;
    const state = await this.state(row.team_id, row.season_id), now = this.source.now();
    const invite = state.invitations.find(item => item.id === row.id);
    if (!invite || invite.credential.kind !== 'sha256' || invite.credential.tokenHash !== tokenHash || invite.revokedAtMs !== null) return null;
    const ownAccepted = invite.acceptedBy === principal.accountId && state.grants.some(grant => grant.invitationId === invite.id && grant.accountId === principal.accountId && grant.revokedAtMs === null && grant.expiresAtMs > now);
    if (!pendingInvitation(state, tokenHash, now) && !ownAccepted) return null;
    return { invitationId: invite.id, teamId: invite.teamId, seasonId: invite.seasonId, expiresAt: new Date(invite.expiresAtMs).toISOString() };
  }
  async audit(principal: Principal, action: string, objectId: string): Promise<void> { if (principal.status !== 'active') unavailable(); await this.runtime.audit(principal, action, objectId, 'accepted'); }
}
