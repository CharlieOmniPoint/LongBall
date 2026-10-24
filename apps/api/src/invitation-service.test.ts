import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '../../../packages/application/src/access';
import type { CommunityState } from '../../../packages/application/src/community';
import type { PreparationState } from '../../../packages/application/src/preparation';
import { DevelopmentStore, SYNTHETIC_IDS } from './store';
import { sqliteRuntimeStore } from './runtime-store';
import { SqliteInvitationRepository } from './invitation-repository';
import { invitationVerifier, SpectatorInvitationService, type InvitationSession } from './invitation-service';

describe('server-issued invitations through actual fictional SQLite transactions', () => {
  let source: DevelopmentStore, repo: SqliteInvitationRepository, service: SpectatorInvitationService, now: number;
  const teamId = SYNTHETIC_IDS.teamId, seasonId = SYNTHETIC_IDS.seasonId;
  const principal = (accountId: string): Principal => source.principal({ issuer: 'urn:longball:synthetic', subject: accountId, strongAuth: accountId.includes('manager'), authenticatedAt: now });
  const session = (name = 'manager', role = name.startsWith('player') ? 'player' : 'manager'): InvitationSession => ({ principal: principal(`synthetic-account-${name}`), teamId, seasonId, role });
  const input = { seasonId, expiresInHours: 1 };
  const issued = async (key = 'request-issued-001', owner = session()) => {
    const result = await service.issue(owner, key, input);
    if (!('shareUrl' in result.body)) throw new Error('FIRST_CREDENTIAL_REQUIRED');
    return { ...result.body, token: new URLSearchParams(new URL(result.body.shareUrl).hash.slice(1)).get('code')! };
  };
  beforeEach(async () => {
    now = Date.parse('2026-10-21T10:00:00Z'); source = new DevelopmentStore(':memory:', () => now); source.seedSynthetic();
    repo = new SqliteInvitationRepository(source, sqliteRuntimeStore(source).store); await repo.initialize();
    service = new SpectatorInvitationService({ repository: repo, publicAppEntryUrl: 'https://example.invalid/LongBall/', invitationPolicyVersion: 'explicit-test-policy', now: () => now });
  });
  afterEach(() => source.close());
  it('issues a CSPRNG credential once for a player without approval and persists only its verifier and redacted receipt', async () => {
    const owner = session('player-01'), first = await issued('request-issued-001', owner);
    expect(first.token).toHaveLength(43); expect(first.shareUrl).toMatch(/^https:\/\/example.invalid\/LongBall\/#longballInvite=1&teamId=/);
    const rows = source.database.prepare('SELECT * FROM spectator_invitations').all();
    expect(rows).toHaveLength(1); expect(rows[0].token_hash).toBe(invitationVerifier(first.token));
    const saved = JSON.stringify([rows, source.database.prepare('SELECT * FROM documents').all(), source.database.prepare('SELECT * FROM idempotency').all(), source.database.prepare('SELECT * FROM audit').all()]);
    expect(saved).not.toContain(first.token); expect(saved).not.toContain(first.shareUrl);
    expect((await service.issue(owner, 'request-issued-001', input))).toEqual({ status: 200, body: { id: first.id, expiresAt: first.expiresAt, teamId, seasonId, credentialAvailable: false, requiresReissue: true } });
    await expect(service.issue(owner, 'request-issued-001', { ...input, expiresInHours: 2 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const list = await service.list(owner); expect(list.invitations[0]).toMatchObject({ id: first.id, canReissue: true, canRevoke: false });
    expect(JSON.stringify(list)).not.toMatch(/tokenHash|credential|shareUrl|reviewCode/);
    expect((await service.list(session('player-02'))).invitations).toEqual([]);
  });
  it('requires explicit bounded expiry and configured owned entry URL without accepting caller credential or scope metadata', async () => {
    for (const value of [{ seasonId }, { ...input, expiresInHours: 0 }, { ...input, expiresInHours: 49 }, { ...input, expiresInHours: 1.2 }, { ...input, tokenHash: 'a'.repeat(64) }, { ...input, reviewCode: 'caller-secret' }, { ...input, seasonId: 'other-season' }]) await expect(service.issue(session(), 'request-invalid-01', value)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const unconfigured = new SpectatorInvitationService({ repository: repo, now: () => now });
    await expect(unconfigured.issue(session(), 'request-invalid-02', input)).rejects.toMatchObject({ code: 'INVITATION_NOT_CONFIGURED' });
    expect(source.database.prepare('SELECT * FROM spectator_invitations').all()).toHaveLength(0);
  });
  it('inspects the possessed token without writing and accepts once into the authenticated account, with season-bound grant', async () => {
    const first = await issued(), invitee = session('invitee', 'spectator'), before = source.database.prepare('SELECT COUNT(*) AS count FROM memberships').get();
    expect(await service.inspect(invitee.principal, { token: first.token })).toEqual({ invitationId: first.id, teamId, seasonId, expiresAt: first.expiresAt, context: { clubName: 'Richmond Rovers', teamName: 'Roma', ageGroup: 'U10', seasonLabel: '2026/27', inviterLabel: 'Team manager' } });
    expect(source.database.prepare('SELECT COUNT(*) AS count FROM memberships').get()).toEqual(before);
    const accepted = await service.accept(invitee, 'request-accept-01', { token: first.token });
    const season = (source.document<CommunityState>(teamId, seasonId, 'community')).seasons.find(item => item.id === seasonId)!;
    expect(accepted.body).toEqual({ invitationId: first.id, teamId, seasonId, expiresAt: new Date(season.accessEndsAtMs).toISOString() });
    expect((await service.accept(invitee, 'request-accept-01', { token: first.token }))).toEqual(accepted);
    expect((await service.accept(invitee, 'request-accept-02', { token: first.token }))).toEqual(accepted);
    expect(source.document<CommunityState>(teamId, seasonId, 'community').grants.filter(item => item.invitationId === first.id)).toHaveLength(1);
    await expect(service.accept(session('player-02', 'spectator'), 'request-accept-03', { token: first.token })).rejects.toMatchObject({ code: 'INVITATION_UNAVAILABLE' });
    await expect(service.inspect(session().principal, { token: invitationVerifier(first.token) })).rejects.toMatchObject({ code: 'INVITATION_UNAVAILABLE' });
    await expect(service.inspect(session().principal, { token: first.token, accountId: 'other' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
  it('returns only exact-token current readable context, reflects configuration renames, and refuses forged scope and labels', async () => {
    const first = await issued('context-issued-01', session('player-01')), invitee = session('invitee', 'spectator');
    const before = source.document<PreparationState>(teamId, seasonId, 'preparation');
    const renamed: PreparationState = { ...before, revision: before.revision + 1, club: { ...before.club, name: 'Riverside Juniors' }, team: { ...before.team, name: 'Falcons', ageGroup: 'U11' }, seasons: before.seasons.map(season => season.id === seasonId ? { ...season, label: 'Autumn 2026' } : season) };
    source.saveDocument(teamId, seasonId, 'preparation', renamed);
    const preview = await service.inspect(invitee.principal, { token: first.token });
    expect(preview.context).toEqual({ clubName: 'Riverside Juniors', teamName: 'Falcons', ageGroup: 'U11', seasonLabel: 'Autumn 2026', inviterLabel: 'Team member' });
    expect(Object.keys(preview.context).sort()).toEqual(['ageGroup', 'clubName', 'inviterLabel', 'seasonLabel', 'teamName']);
    expect(JSON.stringify(preview)).not.toMatch(/profiles|players|accountId|shirtNumber|tokenHash|preferences/);
    await expect(service.inspect(invitee.principal, { token: first.token, teamId: 'other', context: preview.context })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const foreign: PreparationState = { ...renamed, team: { ...renamed.team, id: 'another-team' } };
    source.saveDocument(teamId, seasonId, 'preparation', foreign);
    await expect(service.inspect(invitee.principal, { token: first.token })).rejects.toMatchObject({ status: 404 });
    source.saveDocument(teamId, seasonId, 'preparation', renamed);
    now += 3_600_000;
    await expect(service.inspect(invitee.principal, { token: first.token })).rejects.toMatchObject({ status: 404 });
  });
  it('reissues only an original current player pending link or manager and never rotates an accepted grant', async () => {
    const owner = session('player-01'), first = await issued('request-issued-001', owner);
    await expect(service.issue(session('player-02'), 'request-reissue-01', input, first.id)).rejects.toThrow(/original current inviter/);
    const replacement = await service.issue(owner, 'request-reissue-02', input, first.id); expect(replacement.status).toBe(201);
    await expect(service.inspect(session().principal, { token: first.token })).rejects.toMatchObject({ code: 'INVITATION_UNAVAILABLE' });
    expect((await service.list(owner)).invitations.find(item => item.id === first.id)).toMatchObject({ status: 'revoked', canReissue: false });
    if (!('shareUrl' in replacement.body)) throw new Error('FIRST_CREDENTIAL_REQUIRED');
    const token = new URLSearchParams(new URL(replacement.body.shareUrl).hash.slice(1)).get('code')!;
    await service.accept(session('invitee', 'spectator'), 'request-accept-01', { token });
    await expect(service.issue(session(), 'request-reissue-03', input, replacement.body.id)).rejects.toThrow(/accepted invitation/);
  });
  it('revokes a grant without touching unrelated roles or another still-current invitation grant', async () => {
    const account = session('player-01', 'spectator'), first = await issued(), second = await issued('request-issued-002');
    await service.accept(account, 'request-accept-01', { token: first.token }); await service.accept(account, 'request-accept-02', { token: second.token });
    await expect(service.revoke(session('player-01'), 'request-revoke-01', first.id)).rejects.toMatchObject({ code: 'INVITATION_UNAVAILABLE' });
    await service.revoke(session(), 'request-revoke-02', first.id);
    expect(source.database.prepare("SELECT revoked_at FROM memberships WHERE account_id=? AND role='spectator'").get(account.principal.accountId)?.revoked_at).toBe(null);
    await service.revoke(session(), 'request-revoke-03', second.id);
    expect(source.database.prepare("SELECT revoked_at FROM memberships WHERE account_id=? AND role='spectator'").get(account.principal.accountId)?.revoked_at).toBe(now);
    expect(source.database.prepare("SELECT revoked_at FROM memberships WHERE account_id=? AND role='player'").get(account.principal.accountId)?.revoked_at).toBe(null);
    await expect(service.inspect(account.principal, { token: first.token })).rejects.toMatchObject({ code: 'INVITATION_UNAVAILABLE' });
  });
  it('rolls back mirror, document, grant and audit when durable receipt storage fails', async () => {
    const before = JSON.stringify(source.document(teamId, seasonId, 'community'));
    source.database.exec("CREATE TRIGGER refusal BEFORE INSERT ON idempotency BEGIN SELECT RAISE(ABORT,'test receipt refusal'); END;");
    await expect(issued()).rejects.toThrow(/test receipt refusal/);
    expect(source.database.prepare('SELECT * FROM spectator_invitations').all()).toHaveLength(0);
    expect(JSON.stringify(source.document(teamId, seasonId, 'community'))).toBe(before);
    expect(source.database.prepare("SELECT * FROM audit WHERE action='invite.issued'").all()).toHaveLength(0);
  });
  it('keeps retained legacy evidence retired and allows an explicit replacement without restamping its retirement', async () => {
    const state = source.document<CommunityState>(teamId, seasonId, 'community');
    state.invitations.push({ id: 'retired-pending', teamId, seasonId, inviterAccountId: session('player-01').principal.accountId, credential: { kind: 'fictional_review', version: 1, code: 'OLD-PLAINTEXT' }, reviewCode: 'OLD-PLAINTEXT', createdAtMs: now - 1000, expiresAtMs: now + 3_600_000, acceptedBy: null, acceptedAtMs: null, revokedAtMs: null, reissuedFromInvitationId: null });
    source.saveDocument(teamId, seasonId, 'community', state); await repo.initialize();
    const retirement = source.document<CommunityState>(teamId, seasonId, 'community').invitations[0].revokedAtMs;
    now += 500; await service.issue(session('player-01'), 'request-legacy-01', input, 'retired-pending');
    const after = source.document<CommunityState>(teamId, seasonId, 'community');
    expect(after.invitations[0].revokedAtMs).toBe(retirement); expect(JSON.stringify(after)).not.toContain('OLD-PLAINTEXT');
    expect(source.database.prepare("SELECT requires_reissue FROM spectator_invitations WHERE id='retired-pending'").get()?.requires_reissue).toBe(0);
  });
  it('denies expired credentials, current authority loss and client digests without leaking lookup scope', async () => {
    const first = await issued('request-issued-001', session('player-01'));
    source.database.prepare("UPDATE memberships SET revoked_at=? WHERE account_id='synthetic-account-player-01' AND role='player'").run(now);
    await expect(service.issue(session('player-01'), 'request-issued-001', input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    now += 3_600_000;
    await expect(service.inspect(session().principal, { token: first.token })).rejects.toMatchObject({ code: 'INVITATION_UNAVAILABLE' });
    await expect(service.inspect(session().principal, { token: randomBytes(32).toString('base64url') })).rejects.toMatchObject({ code: 'INVITATION_UNAVAILABLE' });
  });
  it('recovers an already accepted own acknowledgement after link expiry without renewing its grant', async () => {
    const first = await issued(), invitee = session('invitee', 'spectator');
    const accepted = await service.accept(invitee, 'request-accept-01', { token: first.token });
    now += 3_600_001;
    const before = JSON.stringify(source.document(teamId, seasonId, 'community'));
    expect(await service.inspect(invitee.principal, { token: first.token })).toMatchObject({ invitationId: first.id });
    expect(await service.accept(invitee, 'request-accept-02', { token: first.token })).toEqual(accepted);
    expect(JSON.stringify(source.document(teamId, seasonId, 'community'))).toBe(before);
    await expect(service.inspect(session('player-02').principal, { token: first.token })).rejects.toMatchObject({ status: 404 });
  });
  it('refuses normalized revocation or verifier drift while preserving both retained copies', async () => {
    const first = await issued();
    source.database.prepare('UPDATE spectator_invitations SET revoked_at=? WHERE id=?').run(now, first.id);
    const before = JSON.stringify(source.document(teamId, seasonId, 'community'));
    await expect(service.inspect(session('invitee', 'spectator').principal, { token: first.token })).rejects.toMatchObject({ code: 'INVITATION_RECONCILIATION_REQUIRED' });
    await expect(service.revoke(session(), 'request-revoke-01', first.id)).rejects.toMatchObject({ code: 'INVITATION_RECONCILIATION_REQUIRED' });
    expect(JSON.stringify(source.document(teamId, seasonId, 'community'))).toBe(before);
    source.database.prepare('UPDATE spectator_invitations SET revoked_at=NULL,token_hash=? WHERE id=?').run('a'.repeat(64), first.id);
    await expect(service.list(session())).rejects.toMatchObject({ code: 'INVITATION_RECONCILIATION_REQUIRED' });
    expect(JSON.stringify(source.document(teamId, seasonId, 'community'))).toBe(before);
  });
});
