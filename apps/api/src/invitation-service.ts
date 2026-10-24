import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AccessError, type Principal } from '../../../packages/application/src/access';
import { applyCommunityCommand, applyVerifiedInvitationCommand, type CommunityActor, type CommunityState, type SpectatorInvite } from '../../../packages/application/src/community';
import { invitationTokenHashInput, pendingInvitation, redactInviteCreated, type InviteCreated, type RedactedInviteReceipt } from '../../../packages/application/src/invitation-credentials';
import { publicInvitation } from '../../../packages/application/src/invitation-credentials';
import type { InvitationContext } from '../../../packages/application/src/invitation-context';

export interface InvitationSession { principal: Principal; teamId: string; seasonId: string; role?: string }
export interface InvitationResolved { invitationId: string; teamId: string; seasonId: string; tokenHash: string; expiresAt: string; context: InvitationContext }
export interface InvitationAccepted { invitationId: string; teamId: string; seasonId: string; expiresAt: string }
export interface InvitationSummary { id: string; teamId: string; seasonId: string; expiresAt: string; status: 'pending'|'accepted'|'revoked'|'expired'|'requires_reissue'; canReissue: boolean; canRevoke: boolean }
export interface InvitationList { kind: 'spectator-invitations'; teamId: string; seasonId: string; revision: number; invitations: InvitationSummary[] }
export interface InvitationReceipt { signature: string; response: RedactedInviteReceipt | InvitationAccepted | { invitationId: string; revoked: true } }
export interface InvitationRepository {
  transaction<T>(work: () => Promise<T>): Promise<T>;
  actor(session: InvitationSession, accepting?: boolean): Promise<CommunityActor>;
  invitationAllowed(session: InvitationSession, lock?: boolean): Promise<boolean>;
  state(teamId: string, seasonId: string, lock?: boolean): Promise<CommunityState>;
  save(session: InvitationSession, state: CommunityState, changedIds: string[], policyVersion: string | null): Promise<void>;
  receipt(accountId: string, operation: string, key: string): Promise<InvitationReceipt | null>;
  saveReceipt(accountId: string, operation: string, key: string, receipt: InvitationReceipt): Promise<void>;
  resolve(principal: Principal, tokenHash: string): Promise<Omit<InvitationResolved, 'tokenHash'> | null>;
  audit(principal: Principal, action: string, objectId: string): Promise<void>;
}
const unavailable = (): never => { throw new AccessError('INVITATION_UNAVAILABLE', 404, 'The invitation is unavailable for this account and current team season.'); };
const invalid = (): never => { throw new AccessError('INVALID_REQUEST', 400, 'Use the exact invitation fields and an explicit expiry from 1 to 48 hours.'); };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const id = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 150 && !/[^A-Za-z0-9_-]/.test(value);
export function invitationVerifier(token: unknown): string {
  try { return createHash('sha256').update(invitationTokenHashInput(token as string)).digest('hex'); }
  catch { return unavailable(); }
}
export function parseInvitationAccept(value: unknown): { token: string } {
  if (!object(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'token')) return invalid();
  invitationVerifier(value.token);
  return { token: value.token as string };
}
export function parseInvitationWrite(value: unknown, defaultHours?: number): { seasonId: string; expiresInHours: number } {
  if (!object(value) || Object.keys(value).some(key => !['seasonId', 'expiresInHours'].includes(key)) || !id(value.seasonId)) return invalid();
  const hours = value.expiresInHours ?? defaultHours;
  if (!Number.isInteger(hours) || Number(hours) < 1 || Number(hours) > 48) return invalid();
  return { seasonId: value.seasonId, expiresInHours: Number(hours) };
}
/** Raw entropy exists only on this call's stack and first response. Stored receipts contain no credential. */
export class SpectatorInvitationService {
  private readonly now: () => number;
  constructor(private readonly options: { repository: InvitationRepository; publicAppEntryUrl?: string; invitationPolicyVersion?: string; defaultInviteExpiryHours?: number; now?: () => number }) { this.now = options.now ?? Date.now; }
  private operation(action: string, session: InvitationSession, source?: string): string { return JSON.stringify(['invitation', action, session.teamId, session.seasonId, session.role ?? 'default', source ?? null]); }
  private identity(session: InvitationSession, key?: string): void {
    if (session.principal.status !== 'active' || !id(session.teamId) || !id(session.seasonId)) unavailable();
    if (key !== undefined && (key.length < 8 || key.length > 150 || /[^A-Za-z0-9_-]/.test(key))) invalid();
  }
  private async prior(session: InvitationSession, operation: string, key: string, payload: unknown) {
    const signature = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const prior = await this.options.repository.receipt(session.principal.accountId, operation, key);
    if (prior && prior.signature !== signature) throw new AccessError('IDEMPOTENCY_CONFLICT', 409, 'The invitation request identity was already used with different content.');
    return { signature, prior };
  }
  private configuration(): { entry: URL; policy: string } {
    let entry: URL;
    try { entry = new URL(this.options.publicAppEntryUrl ?? ''); }
    catch { throw new AccessError('INVITATION_NOT_CONFIGURED', 503, 'Configure the owned application entry URL and invitation policy before issuing invitations.'); }
    const policy = this.options.invitationPolicyVersion;
    if ((entry.protocol !== 'https:' && !(entry.protocol === 'http:' && entry.hostname === 'localhost')) || entry.username || entry.password || entry.search || entry.hash || !policy || policy.length > 150 || /[\u0000-\u001f\u007f]/.test(policy)) throw new AccessError('INVITATION_NOT_CONFIGURED', 503, 'Configure the owned application entry URL and invitation policy before issuing invitations.');
    return { entry, policy };
  }
  async list(session: InvitationSession): Promise<InvitationList> {
    this.identity(session);
    const actor = await this.options.repository.actor(session);
    if (!['manager', 'player', 'spectator'].includes(actor.role)) unavailable();
    const state = await this.options.repository.state(session.teamId, session.seasonId), now = this.now();
    const invitationAllowed = await this.options.repository.invitationAllowed(session);
    return { kind: 'spectator-invitations', teamId: session.teamId, seasonId: session.seasonId, revision: state.revision, invitations: state.invitations.filter(invite => invite.teamId === session.teamId && invite.seasonId === session.seasonId && (actor.role === 'manager' || invite.inviterAccountId === actor.accountId)).map((invite): InvitationSummary => {
      const view = publicInvitation(invite, now);
      const pending = invite.acceptedBy === null && invite.acceptedAtMs === null && (invite.revokedAtMs === null || invite.credential.kind === 'legacy_retired' && invite.credential.requiresReissue);
      const season = state.seasons.find(item => item.id === session.seasonId && item.teamId === session.teamId);
      return { id: invite.id, teamId: invite.teamId, seasonId: invite.seasonId, expiresAt: new Date(invite.expiresAtMs).toISOString(), status: view.requiresReissue ? 'requires_reissue' : view.state as InvitationSummary['status'], canReissue: Boolean(invitationAllowed && pending && season && season.accessEndsAtMs > now && !state.invitations.some(other => other.reissuedFromInvitationId === invite.id)), canRevoke: actor.role === 'manager' && invite.revokedAtMs === null };
    }) };
  }
  async issue(session: InvitationSession, key: string, value: unknown, sourceInvitationId?: string): Promise<{ status: 200|201; body: InviteCreated|RedactedInviteReceipt }> {
    this.identity(session, key);
    const input = parseInvitationWrite(value, this.options.defaultInviteExpiryHours);
    if (input.seasonId !== session.seasonId || sourceInvitationId !== undefined && !id(sourceInvitationId)) return invalid();
    const { entry, policy } = this.configuration(), repo = this.options.repository;
    return repo.transaction(async () => {
      const actor = await repo.actor(session);
      if (!['manager', 'player', 'spectator'].includes(actor.role)) unavailable();
      const state = await repo.state(session.teamId, session.seasonId, true);
      const operation = this.operation(sourceInvitationId ? 'reissue' : 'issue', session, sourceInvitationId);
      const { prior, signature } = await this.prior(session, operation, key, input);
      if (prior) return { status: 200, body: prior.response as RedactedInviteReceipt };
      if (!await repo.invitationAllowed(session, true)) throw new AccessError('TEAM_INVITATIONS_SUSPENDED',403,'Creating or reissuing invitations is suspended in this team. Existing invitations and grants retain their separate recorded status.');
      const now = this.now(), season = state.seasons.find(item => item.id === session.seasonId && item.teamId === session.teamId);
      if (!season || season.accessEndsAtMs <= now) return unavailable();
      const expiresAtMs = Math.min(now + input.expiresInHours * 3_600_000, season.accessEndsAtMs);
      const token = randomBytes(32).toString('base64url'), tokenHash = invitationVerifier(token), invitationId = randomUUID();
      const base = { id: key, invitationId, tokenHash, expiresAtMs };
      const next = applyVerifiedInvitationCommand(state, actor, sourceInvitationId ? { ...base, type: 'invite.reissued', sourceInvitationId } : { ...base, type: 'invite.issued' }, now);
      entry.hash = new URLSearchParams({ longballInvite: '1', teamId: session.teamId, seasonId: session.seasonId, code: token }).toString();
      const receipt: InviteCreated = { id: invitationId, shareUrl: entry.href, expiresAt: new Date(expiresAtMs).toISOString(), teamId: session.teamId, seasonId: session.seasonId };
      await repo.save(session, next, sourceInvitationId ? [sourceInvitationId, invitationId] : [invitationId], policy);
      await repo.saveReceipt(session.principal.accountId, operation, key, { signature, response: redactInviteCreated(receipt) });
      await repo.audit(session.principal, sourceInvitationId ? 'invite.reissued' : 'invite.issued', invitationId);
      return { status: 201, body: receipt };
    });
  }
  async resolve(principal: Principal, value: unknown): Promise<InvitationResolved> {
    if (principal.status !== 'active') return unavailable();
    const { token } = parseInvitationAccept(value), tokenHash = invitationVerifier(token);
    const found = await this.options.repository.resolve(principal, tokenHash);
    if (!found) return unavailable();
    return { ...found, tokenHash };
  }
  async inspect(principal: Principal, value: unknown): Promise<Omit<InvitationResolved, 'tokenHash'>> {
    const { invitationId, teamId, seasonId, expiresAt, context } = await this.resolve(principal, value);
    return { invitationId, teamId, seasonId, expiresAt, context };
  }
  async accept(session: InvitationSession, key: string, value: unknown): Promise<{ status: 200; body: InvitationAccepted }> {
    this.identity(session, key);
    const { token } = parseInvitationAccept(value), tokenHash = invitationVerifier(token), repo = this.options.repository;
    return repo.transaction(async () => {
      const actor = await repo.actor(session, true), state = await repo.state(session.teamId, session.seasonId, true);
      const operation = this.operation('accept', session), { prior, signature } = await this.prior(session, operation, key, { tokenHash });
      if (prior) return { status: 200, body: prior.response as InvitationAccepted };
      const now = this.now(), existing = state.invitations.find(invite => invite.credential.kind === 'sha256' && invite.credential.tokenHash === tokenHash && invite.teamId === session.teamId && invite.seasonId === session.seasonId);
      if (!existing || existing.revokedAtMs !== null || existing.acceptedBy !== null && existing.acceptedBy !== actor.accountId) return unavailable();
      let next = state;
      if (existing.acceptedBy === null) {
        if (!pendingInvitation(state, tokenHash, now, session)) return unavailable();
        next = applyVerifiedInvitationCommand(state, actor, { id: key, type: 'invite.accepted_verified', invitationId: existing.id, tokenHash }, now);
      }
      const grant = next.grants.find(item => item.invitationId === existing.id && item.accountId === actor.accountId && item.revokedAtMs === null && item.expiresAtMs > now);
      if (!grant) return unavailable();
      const receipt = { invitationId: existing.id, teamId: session.teamId, seasonId: session.seasonId, expiresAt: new Date(grant.expiresAtMs).toISOString() };
      if (next !== state) await repo.save(session, next, [existing.id], null);
      await repo.saveReceipt(session.principal.accountId, operation, key, { signature, response: receipt });
      if (next !== state) await repo.audit(session.principal, 'invite.accepted', existing.id);
      return { status: 200, body: receipt };
    });
  }
  async revoke(session: InvitationSession, key: string, invitationId: string): Promise<{ status: 200; body: { invitationId: string; revoked: true } }> {
    this.identity(session, key); if (!id(invitationId)) return invalid();
    const repo = this.options.repository;
    return repo.transaction(async () => {
      const actor = await repo.actor(session); if (actor.role !== 'manager') return unavailable();
      const state = await repo.state(session.teamId, session.seasonId, true), operation = this.operation('revoke', session, invitationId);
      const { prior, signature } = await this.prior(session, operation, key, { invitationId });
      if (prior) return { status: 200, body: prior.response as { invitationId: string; revoked: true } };
      const invite = state.invitations.find(item => item.id === invitationId && item.teamId === session.teamId && item.seasonId === session.seasonId);
      if (!invite) return unavailable();
      const next = invite.revokedAtMs === null ? applyCommunityCommand(state, actor, { id: key, type: 'invite.revoked', invitationId }, this.now()) : state;
      if (next !== state) await repo.save(session, next, [invitationId], null);
      const receipt = { invitationId, revoked: true as const };
      await repo.saveReceipt(session.principal.accountId, operation, key, { signature, response: receipt });
      if (next !== state) await repo.audit(session.principal, 'invite.revoked', invitationId);
      return { status: 200, body: receipt };
    });
  }
}
export function invitationChangedRows(state: CommunityState, ids: string[]): SpectatorInvite[] { return ids.map(id => { const invite = state.invitations.find(item => item.id === id); if (!invite) throw new Error('INVITATION_PROJECTION_MISSING'); return invite; }); }
/** Recompute the full union only for affected accounts, never attempt unrelated membership writes. */
export function invitationGrantProjection(state: CommunityState, changedIds: string[]): CommunityState {
  const affected = new Set(state.grants.filter(grant => changedIds.includes(grant.invitationId)).map(grant => JSON.stringify([grant.accountId, grant.teamId, grant.seasonId])));
  return { ...state, grants: state.grants.filter(grant => affected.has(JSON.stringify([grant.accountId, grant.teamId, grant.seasonId]))) };
}
/** Refuse retained mirror drift; never repair authority or choose between conflicting histories during a request. */
export function assertInvitationMirror(invite: SpectatorInvite | undefined, row: Record<string, unknown>): void {
  if (!invite || invite.credential.kind === 'fictional_review') throw new AccessError('INVITATION_RECONCILIATION_REQUIRED', 409, 'Retained invitation evidence differs. Preserve it for authorised review.');
  const credential = invite.credential;
  const compatible =
    JSON.stringify([invite.id, invite.teamId, invite.seasonId, invite.inviterAccountId, invite.createdAtMs, invite.expiresAtMs, invite.acceptedBy, invite.acceptedAtMs, invite.revokedAtMs, invite.reissuedFromInvitationId, credential.kind, credential.version]) ===
    JSON.stringify([row.id, row.team_id, row.season_id, row.inviter_account_id, Number(row.created_at), Number(row.expires_at), row.accepted_by, row.accepted_at === null ? null : Number(row.accepted_at), row.revoked_at === null ? null : Number(row.revoked_at), row.reissued_from_invitation_id, row.credential_kind, Number(row.credential_version)]) &&
    (credential.kind === 'sha256' ? credential.tokenHash === row.token_hash : credential.fingerprint === row.legacy_fingerprint && credential.redactedAtMs === Number(row.retired_at) && credential.requiresReissue === Boolean(row.requires_reissue));
  if (!compatible) throw new AccessError('INVITATION_RECONCILIATION_REQUIRED', 409, 'Retained invitation evidence differs. Preserve it for authorised review; no invitation or grant was changed.');
}
