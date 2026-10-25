import { PostgresTeamPrivilegeRepository } from './postgres-team-privileges';
import type { Principal } from '../../../packages/application/src/access';
import { parseInvitationContext } from '../../../packages/application/src/invitation-context';
import type { CommunityState } from '../../../packages/application/src/community';
import { assertInvitationMirror, invitationChangedRows, invitationGrantProjection, type InvitationReceipt, type InvitationRepository, type InvitationSession } from './invitation-service';
import type { PostgresStore } from './postgres-store';

/** All SQL runs under the caller's current actor intent; no scope widening or owner credential. */
export class PostgresInvitationRepository implements InvitationRepository {
  constructor(private readonly store: PostgresStore) {}
  transaction<T>(work: () => Promise<T>): Promise<T> { return this.store.transaction(work); }
  actor(session: InvitationSession, accepting = false) { return this.store.communityActor(session.principal, session.teamId, session.seasonId, session.role, accepting); }
  invitationAllowed(session: InvitationSession,lock=false) { return new PostgresTeamPrivilegeRepository(this.store).own(session,'invitations',lock); }
  async state(teamId: string, seasonId: string, lock = false): Promise<CommunityState> {
    if (lock) await this.store.one("SELECT team_id FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='community' FOR UPDATE", [teamId, seasonId]);
    const state = await this.store.communityState(teamId, seasonId);
    const rows = await this.store.many('SELECT * FROM spectator_invitations WHERE team_id=$1 AND season_id=$2', [teamId, seasonId]);
    for (const row of rows) assertInvitationMirror(state.invitations.find(invite => invite.id === row.id), row);
    return state;
  }
  async save(session: InvitationSession, state: CommunityState, changedIds: string[], policyVersion: string | null): Promise<void> {
    await this.store.saveDocument(session.teamId, session.seasonId, 'community', state);
    for (const invite of invitationChangedRows(state, changedIds)) {
      const existing = await this.store.one('SELECT id FROM spectator_invitations WHERE id=$1 FOR UPDATE', [invite.id]);
      if (existing) {
        const result = await this.store.execute('UPDATE spectator_invitations SET accepted_by=$1,accepted_at=$2,revoked_at=$3,requires_reissue=$4 WHERE id=$5', [invite.acceptedBy, invite.acceptedAtMs, invite.revokedAtMs, invite.credential.kind === 'legacy_retired' && invite.credential.requiresReissue, invite.id]);
        if (result.changes !== 1) throw new Error('INVITATION_WRITE_NOT_CONFIRMED');
      } else {
        if (invite.credential.kind !== 'sha256' || !policyVersion) throw new Error('INVITATION_POLICY_REQUIRED');
        const row = await this.store.one('SELECT club_id FROM teams WHERE id=$1', [session.teamId]);
        if (!row?.club_id) throw new Error('INVITATION_ANCESTRY_UNAVAILABLE');
        await this.store.execute("INSERT INTO spectator_invitations(id,club_id,team_id,season_id,inviter_account_id,credential_kind,token_hash,created_at,expires_at,accepted_by,accepted_at,revoked_at,reissued_from_invitation_id,policy_version) VALUES($1,$2,$3,$4,$5,'sha256',$6,$7,$8,$9,$10,$11,$12,$13)", [invite.id, row.club_id, invite.teamId, invite.seasonId, invite.inviterAccountId, invite.credential.tokenHash, invite.createdAtMs, invite.expiresAtMs, invite.acceptedBy, invite.acceptedAtMs, invite.revokedAtMs, invite.reissuedFromInvitationId, policyVersion]);
      }
    }
    await this.store.synchronizeSpectatorMemberships(invitationGrantProjection(state, changedIds));
  }
  async receipt(accountId: string, operation: string, key: string): Promise<InvitationReceipt | null> {
    const row = await this.store.one('SELECT signature,response_json FROM idempotency WHERE account_id=$1 AND operation=$2 AND key=$3', [accountId, operation, key]);
    return row ? { signature: String(row.signature), response: JSON.parse(String(row.response_json)) } : null;
  }
  async saveReceipt(accountId: string, operation: string, key: string, receipt: InvitationReceipt): Promise<void> { await this.store.execute('INSERT INTO idempotency(account_id,operation,key,signature,response_json) VALUES($1,$2,$3,$4,$5)', [accountId, operation, key, receipt.signature, JSON.stringify(receipt.response)]); }
  async resolve(_principal: Principal, tokenHash: string) {
    const row = await this.store.one('SELECT * FROM invitation_accept_scope($1)', [tokenHash]);
    if (!row) return null;
    const names = await this.store.one('SELECT * FROM invitation_preview_context($1)', [tokenHash]);
    if (!names) return null;
    const context = parseInvitationContext({ clubName: names.club_name, teamName: names.team_name, ageGroup: names.age_group, seasonLabel: names.season_label, inviterLabel: names.inviter_label });
    return { invitationId: String(row.id), teamId: String(row.team_id), seasonId: String(row.season_id), expiresAt: new Date(Number(row.expires_at)).toISOString(), context };
  }
  audit(principal: Principal, action: string, objectId: string): Promise<void> { return this.store.audit(principal, action, objectId, 'accepted'); }
}
