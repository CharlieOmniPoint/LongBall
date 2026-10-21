import { describe, expect, it } from 'vitest';
import { BRAND_POLICY_VERSION } from './branding';
import type { Membership, Principal } from './access';
import type { WorkspaceBinding, WorkspaceSessionAccess } from './workspace-boundary';
import { authorizeWorkspaceReplay, createWorkspaceOutbox, enqueueWorkspaceRequest, recordWorkspaceOutcome, retireLegacyWorkspaceInvitation, validateWorkspaceOutbox, workspaceOutboxDocumentId, workspaceOutboxStorageAllowed, type WorkspaceOutboxAuthorization, type WorkspaceOutboxState } from './workspace-outbox';

const now = 1_800_000_000_000;
const binding: WorkspaceBinding = { generation: 1, apiBaseUrl: 'https://api.example', accountId: 'child-account', issuer: 'https://issuer.example', subject: 'subject-1', teamId: 'roma-u10', seasonId: '2026-27', role: 'player', playerId: 'player-01' };
const principal: Principal = { accountId: binding.accountId, issuer: binding.issuer, subject: binding.subject, identityClassification: 'child_shared', adultVerified: false, strongAuth: false, authenticatedAt: now, status: 'active' };
const memberships: Membership[] = [{ accountId: binding.accountId, teamId: binding.teamId, seasonId: binding.seasonId, role: binding.role, playerId: binding.playerId!, expiresAt: now + 60_000 }];
const session: WorkspaceSessionAccess = { sessionId: 'connected-session', accountId: binding.accountId, issuer: binding.issuer, subject: binding.subject, config: { apiBaseUrl: binding.apiBaseUrl }, expiresAtMs: now + 60_000, locked: false, expired: false };
const auth: WorkspaceOutboxAuthorization = { binding, principal, memberships, verifiedAtMs: now, nowMs: now, synthetic: false, session };
const request = { path: '/v1/teams/roma-u10/community?seasonId=2026-27', key: 'same-request-0001', label: 'Community change', body: { command: { id: 'same-request-0001', expectedRevision: 7, type: 'ballot.cast', matchId: 'match-01', candidatePlayerId: 'player-02' } } };
const queued = () => enqueueWorkspaceRequest(createWorkspaceOutbox(binding), binding, request, now);
const reopened = (state: WorkspaceOutboxState): WorkspaceOutboxState => JSON.parse(JSON.stringify(state)) as WorkspaceOutboxState;

describe('protected workspace acknowledgement outbox', () => {
  it('retains exact team privilege decisions only in their manager scope and rejects alternate-route authority',()=>{
    const manager={...binding,role:'manager' as const,playerId:null};
    const command={id:'privilege-decision-001',type:'privilege.suspended',expectedRevision:2,targetAccountId:'target-account',privilege:'uploads',reasonCode:'content_review',privateNote:'restricted operational note',confirm:true};
    const input={path:'/v1/teams/roma-u10/privileges?seasonId=2026-27',key:command.id,label:'Team privilege decision',body:{command}};
    const next=enqueueWorkspaceRequest(createWorkspaceOutbox(manager),manager,input,now);
    expect(next.pending?.bodyJson).toBe(JSON.stringify(input.body));validateWorkspaceOutbox(reopened(next));
    for(const role of ['player','spectator','administrator'] as const){const outsider={...binding,role};expect(()=>enqueueWorkspaceRequest(createWorkspaceOutbox(outsider),outsider,input,now)).toThrow();}
    expect(()=>enqueueWorkspaceRequest(createWorkspaceOutbox(manager),manager,{...input,path:'/v1/teams/roma-u10/community?seasonId=2026-27'},now)).toThrow();
    expect(()=>enqueueWorkspaceRequest(createWorkspaceOutbox(manager),manager,{...input,body:{command:{...command,role:'manager'}}},now)).toThrow();
  });
  it('restores legacy invitation evidence but refuses replay without changing its exact retained request', () => {
    const legacy = { ...request, body: { command: { id: request.key, expectedRevision: 7, type: 'invite.created', invitationId: 'legacy-invite', reviewCode: 'fictional-old-code', expiresAtMs: now + 1000 } } };
    expect(() => enqueueWorkspaceRequest(createWorkspaceOutbox(binding), binding, legacy, now)).toThrow();
    const state = reopened(queued());
    state.pending!.bodyJson = JSON.stringify(legacy.body);
    const before = JSON.stringify(state);
    expect(() => validateWorkspaceOutbox(state)).not.toThrow();
    expect(() => authorizeWorkspaceReplay(state, auth)).toThrow(/retained legacy invitation cannot be sent/);
    expect(JSON.stringify(state)).toBe(before);
    expect(state.pending?.bodyJson).toBe(JSON.stringify(legacy.body));
  });
  it('retires only an explicitly confirmed scoped legacy invitation locally, retaining exact bytes without a false server acknowledgement', () => {
    const legacy = { ...request, body: { command: { id: request.key, expectedRevision: 7, type: 'invite.created', invitationId: 'legacy-invite', reviewCode: 'fictional-old-code', expiresAtMs: now + 1000 } } };
    const state = reopened(queued());
    state.pending!.bodyJson = JSON.stringify(legacy.body);
    const before = JSON.stringify(state), retired = retireLegacyWorkspaceInvitation(state, auth, request.key, true, now);
    expect(JSON.stringify(state)).toBe(before); expect(retired.pending).toBeNull();
    expect(retired.lastSettled?.request.bodyJson).toBe(state.pending?.bodyJson);
    expect(retired.lastSettled?.outcome).toEqual({ kind: 'locally_retired', reason: 'legacy_invitation_protocol_retired', serverAcknowledged: false });
    expect(() => validateWorkspaceOutbox(reopened(retired))).not.toThrow();
    expect(enqueueWorkspaceRequest(retired, binding, { ...request, key: 'new-safe-request-0002', body: { command: { ...request.body.command, id: 'new-safe-request-0002' } } }, now).pending?.key).toBe('new-safe-request-0002');
    for (const change of [{ binding: { ...binding, teamId: 'other-team' } }, { memberships: [] }, { session: { ...session, locked: true } }]) expect(() => retireLegacyWorkspaceInvitation(state, { ...auth, ...change }, request.key, true, now)).toThrow();
    expect(() => retireLegacyWorkspaceInvitation(state, auth, 'different-request-key', true, now)).toThrow();
    expect(() => retireLegacyWorkspaceInvitation(state, auth, request.key, false as true, now)).toThrow();
    expect(() => retireLegacyWorkspaceInvitation(queued(), auth, request.key, true, now)).toThrow();
    const legacyAccept = reopened(state); legacyAccept.pending!.bodyJson = JSON.stringify({ command: { id: request.key, expectedRevision: 7, type: 'invite.accepted', reviewCode: 'retained-original-code' } });
    expect(() => validateWorkspaceOutbox(legacyAccept)).not.toThrow();
    expect(() => authorizeWorkspaceReplay(legacyAccept, auth)).toThrow(/retained legacy/);
    expect(retireLegacyWorkspaceInvitation(legacyAccept, auth, request.key, true, now).lastSettled?.request.bodyJson).toBe(legacyAccept.pending!.bodyJson);
    expect(() => enqueueWorkspaceRequest(createWorkspaceOutbox(binding), binding, { ...request, body: JSON.parse(legacyAccept.pending!.bodyJson) }, now)).toThrow();
  });
  it('retains exact logo publication bytes and separates club administrator from assigned team manager replay', () => {
    const adult: Principal = { ...principal, identityClassification: 'adult_individual', adultVerified: true, strongAuth: true };
    for (const kind of ['club_logo', 'team_logo'] as const) {
      const role = kind === 'club_logo' ? 'administrator' as const : 'manager' as const;
      const owner = { ...binding, role, playerId: null };
      const input = { key: 'logo-publish-0001', path: `/v1/teams/roma-u10/branding/${kind}/publish?seasonId=2026-27`, label: 'Publish reviewed logo', body: { command: { id: 'logo-publish-0001', type: 'logo.published', kind, expectedSlotVersion: 4, assetId: 'asset-1', reviewedRevision: 2, confirmRightsToUse: true, policyVersion: BRAND_POLICY_VERSION } } };
      const queued = enqueueWorkspaceRequest(createWorkspaceOutbox(owner), owner, input, now);
      const uncertain = reopened(recordWorkspaceOutcome(queued, input.key, { kind: 'unconfirmed', reason: 'network' }, now));
      const authorization = { ...auth, binding: owner, principal: adult, memberships: [{ ...memberships[0], role, playerId: undefined }] };
      expect(authorizeWorkspaceReplay(uncertain, authorization).bodyJson).toBe(JSON.stringify(input.body));
      expect(() => authorizeWorkspaceReplay(uncertain, { ...authorization, memberships: [] })).toThrow();
      expect(() => authorizeWorkspaceReplay(uncertain, { ...authorization, principal: { ...adult, strongAuth: false } })).toThrow();
      const otherRole = { ...owner, role: role === 'manager' ? 'administrator' as const : 'manager' as const };
      expect(() => enqueueWorkspaceRequest(createWorkspaceOutbox(otherRole), otherRole, input, now)).toThrow();
      expect(() => enqueueWorkspaceRequest(createWorkspaceOutbox(owner), owner, { ...input, path: '/v1/teams/roma-u10/community?seasonId=2026-27' }, now)).toThrow();
      expect(() => enqueueWorkspaceRequest(createWorkspaceOutbox(owner), owner, { ...input, body: { command: { ...input.body.command, reviewedRevision: 3, expectedSlotVersion: -1 } } }, now)).toThrow();
    }
  });
  it('binds logo removal to the matching kind, action and current pointer version', () => {
    const owner = { ...binding, role: 'manager' as const, playerId: null };
    const input = { key: 'logo-remove-0001', path: '/v1/teams/roma-u10/branding/team_logo/remove?seasonId=2026-27', label: 'Restore club logo inheritance', body: { command: { id: 'logo-remove-0001', type: 'logo.removed', kind: 'team_logo', expectedSlotVersion: 2 } } };
    expect(enqueueWorkspaceRequest(createWorkspaceOutbox(owner), owner, input, now).pending?.bodyJson).toBe(JSON.stringify(input.body));
    for (const patch of [{ path: input.path.replace('/remove?', '/publish?') }, { body: { command: { ...input.body.command, kind: 'club_logo' } } }, { body: { command: { ...input.body.command, assetId: 'unexpected' } } }]) expect(() => enqueueWorkspaceRequest(createWorkspaceOutbox(owner), owner, { ...input, ...patch }, now)).toThrow();
  });
  it('retains exact staff assignments and rechecks selected administrator plus recent strong authority before replay', () => {
    const adminBinding = { ...binding, role: 'administrator' as const, playerId: null };
    const adminPrincipal: Principal = { ...principal, identityClassification: 'adult_individual', adultVerified: true, strongAuth: true };
    const adminMemberships: Membership[] = [{ ...memberships[0], role: 'administrator', playerId: undefined }];
    const input = { key: 'staff-request-0001', path: '/v1/teams/roma-u10/managers?seasonId=2026-27', label: 'Assign existing verified adult', body: { command: { id: 'staff-request-0001', expectedRevision: 8, type: 'manager.assigned', accountId: 'existing-adult' } } };
    const state = enqueueWorkspaceRequest(createWorkspaceOutbox(adminBinding), adminBinding, input, now);
    const uncertain = reopened(recordWorkspaceOutcome(state, input.key, { kind: 'unconfirmed', reason: 'network' }, now));
    const context = { ...auth, binding: adminBinding, principal: adminPrincipal, memberships: adminMemberships };
    expect(authorizeWorkspaceReplay(uncertain, context).bodyJson).toBe(JSON.stringify(input.body));
    for (const changes of [{ principal: { ...adminPrincipal, authenticatedAt: now - 300_001 } }, { principal: { ...adminPrincipal, strongAuth: false } }, { memberships: [] }]) expect(() => authorizeWorkspaceReplay(uncertain, { ...context, ...changes })).toThrow();
    const managerBinding = { ...adminBinding, role: 'manager' as const };
    expect(() => enqueueWorkspaceRequest(createWorkspaceOutbox(managerBinding), managerBinding, input, now)).toThrow();
    expect(() => enqueueWorkspaceRequest(createWorkspaceOutbox(adminBinding), adminBinding, { ...input, path: '/v1/teams/roma-u10/configuration?seasonId=2026-27' }, now)).toThrow();
    expect(() => enqueueWorkspaceRequest(createWorkspaceOutbox(adminBinding), adminBinding, { ...input, body: { command: { ...input.body.command, expectedRevision: -1 } } }, now)).toThrow();
  });
  it('binds staff revocation to its specific path, original reason, revision and explicit confirmation', () => {
    const adminBinding = { ...binding, role: 'administrator' as const, playerId: null };
    const input = { key: 'staff-request-0002', path: '/v1/teams/roma-u10/managers/revoke?seasonId=2026-27', label: 'Revoke this season manager role', body: { command: { id: 'staff-request-0002', expectedRevision: 9, type: 'manager.revoked', accountId: 'existing-adult', reason: 'Reviewed departure from the club', confirmRevocation: true } } };
    const state = enqueueWorkspaceRequest(createWorkspaceOutbox(adminBinding), adminBinding, input, now);
    expect(reopened(state).pending?.bodyJson).toBe(JSON.stringify(input.body));
    expect(() => enqueueWorkspaceRequest(createWorkspaceOutbox(adminBinding), adminBinding, { ...input, path: '/v1/teams/roma-u10/managers?seasonId=2026-27' }, now)).toThrow();
    expect(() => enqueueWorkspaceRequest(createWorkspaceOutbox(adminBinding), adminBinding, { ...input, body: { command: { ...input.body.command, confirmRevocation: false } } }, now)).toThrow();
    expect(() => enqueueWorkspaceRequest(createWorkspaceOutbox(adminBinding), adminBinding, { ...input, body: { command: { ...input.body.command, reason: 'no' } } }, now)).toThrow();
  });
  it('retains the exact key, command bytes and revision across uncertainty and close/reopen', () => {
    const first = queued();
    const uncertain = recordWorkspaceOutcome(first, request.key, { kind: 'unconfirmed', reason: 'network' }, now + 1);
    const restored = reopened(uncertain);
    validateWorkspaceOutbox(restored);
    const retry = authorizeWorkspaceReplay(restored, { ...auth, binding: { ...binding, generation: 99 }, nowMs: now + 2 });
    expect(retry.bodyJson).toBe(JSON.stringify(request.body));
    expect(retry.key).toBe(request.key);
    expect(retry.status).toBe('uncertain');
    expect(JSON.parse(retry.bodyJson).command.expectedRevision).toBe(7);
    expect(restored.pending).toEqual(uncertain.pending);
  });

  it('copies mutable input into exact wire bytes and blocks another action until resolution', () => {
    const input = structuredClone(request);
    const state = enqueueWorkspaceRequest(createWorkspaceOutbox(binding), binding, input, now);
    input.body.command.candidatePlayerId = 'player-03';
    expect(JSON.parse(state.pending!.bodyJson).command.candidatePlayerId).toBe('player-02');
    expect(enqueueWorkspaceRequest(state, binding, request, now + 2)).toBe(state);
    expect(() => enqueueWorkspaceRequest(state, binding, input, now + 2)).toThrow();
    expect(() => enqueueWorkspaceRequest(state, binding, { ...request, key: 'new-request-0002', body: { command: { ...request.body.command, id: 'new-request-0002' } } }, now + 2)).toThrow();
    expect(state.pending!.bodyJson).toBe(JSON.stringify(request.body));
  });

  it('separates account/API/issuer/subject/team/season/role/player namespaces and ignores refresh generation', () => {
    const id = workspaceOutboxDocumentId(binding);
    expect(workspaceOutboxDocumentId({ ...binding, generation: 99, apiBaseUrl: 'https://api.example/v1/' })).toBe(id);
    for (const change of [{ apiBaseUrl: 'https://other.example' }, { accountId: 'other' }, { issuer: 'https://other-issuer.example' }, { subject: 'other-subject' }, { teamId: 'roma-u11' }, { seasonId: '2027-28' }, { role: 'manager' as const, playerId: null }, { playerId: 'player-02' }]) {
      const other = { ...binding, ...change };
      expect(workspaceOutboxDocumentId(other)).not.toBe(id);
      expect(() => authorizeWorkspaceReplay(queued(), { ...auth, binding: other })).toThrow();
    }
    expect(() => workspaceOutboxDocumentId({ ...binding, apiBaseUrl: 'https://password:secret@api.example' })).toThrow();
    expect(() => workspaceOutboxDocumentId({ ...binding, apiBaseUrl: 'https://api.example?token=secret' })).toThrow();
  });

  it('requires fresh authenticated identity, unlocked sign-in and current own-player membership before every replay', () => {
    const state = queued();
    const denied: WorkspaceOutboxAuthorization[] = [
      { ...auth, principal: { ...principal, status: 'disabled' } },
      { ...auth, principal: { ...principal, subject: 'other-subject' } },
      { ...auth, memberships: [] },
      { ...auth, memberships: [{ ...memberships[0], revokedAt: now }] },
      { ...auth, memberships: [{ ...memberships[0], expiresAt: now }] },
      { ...auth, memberships: [{ ...memberships[0], playerId: 'player-02' }] },
      { ...auth, verifiedAtMs: now - 30_001 },
      { ...auth, verifiedAtMs: now + 1 },
      { ...auth, session: null },
      { ...auth, session: { ...session, locked: true } },
      { ...auth, session: { ...session, expiresAtMs: now } },
      { ...auth, session: { ...session, config: { apiBaseUrl: 'https://other.example' } } },
      { ...auth, session: { ...session, accountId: 'other' } },
    ];
    for (const context of denied) expect(() => authorizeWorkspaceReplay(state, context)).toThrow();
    expect(state.pending!.key).toBe(request.key);
    expect(authorizeWorkspaceReplay(state, auth).key).toBe(request.key);
  });

  it('checks verified adult stronger authentication again for a manager replay', () => {
    const managerBinding = { ...binding, role: 'manager' as const, playerId: null };
    const managerPrincipal: Principal = { ...principal, identityClassification: 'adult_individual', adultVerified: true, strongAuth: true };
    const managerMemberships: Membership[] = [{ ...memberships[0], role: 'manager', playerId: undefined }];
    const state = enqueueWorkspaceRequest(createWorkspaceOutbox(managerBinding), managerBinding, request, now);
    const context = { ...auth, binding: managerBinding, principal: managerPrincipal, memberships: managerMemberships };
    expect(authorizeWorkspaceReplay(state, context).key).toBe(request.key);
    expect(() => authorizeWorkspaceReplay(state, { ...context, principal: { ...managerPrincipal, strongAuth: false } })).toThrow();
    expect(() => authorizeWorkspaceReplay(state, { ...context, principal: { ...managerPrincipal, adultVerified: false } })).toThrow();
  });

  it('retains authentication, access, unreadable and retryable failures without counting a ballot or inventing a server receipt', () => {
    for (const outcome of [
      { kind: 'unconfirmed' as const, reason: 'unreadable' as const },
      { kind: 'unconfirmed' as const, reason: 'retryable_service' as const, httpStatus: 503, code: 'SERVICE_UNAVAILABLE' },
      { kind: 'unconfirmed' as const, reason: 'authentication' as const, httpStatus: 401, code: 'SESSION_EXPIRED' },
      { kind: 'unconfirmed' as const, reason: 'access' as const, httpStatus: 403, code: 'NOT_FOUND' },
    ]) {
      const state = recordWorkspaceOutcome(queued(), request.key, outcome, now + 1);
      expect(state.pending!.bodyJson).toBe(JSON.stringify(request.body));
      expect(state.lastSettled).toBeNull();
      expect(authorizeWorkspaceReplay(reopened(state), auth).key).toBe(request.key);
    }
    for (const httpStatus of [401, 403, 404, 408, 425, 429, 503]) expect(() => recordWorkspaceOutcome(queued(), request.key, { kind: 'refused', httpStatus, code: 'TEMPORARY' }, now)).toThrow();
  });

  it('settles only the matching confirmed request and preserves the full refused candidate', () => {
    const state = queued();
    expect(() => recordWorkspaceOutcome(state, 'other-request-0002', { kind: 'accepted', httpStatus: 200 }, now)).toThrow();
    expect(state.pending).not.toBeNull();
    const refused = recordWorkspaceOutcome(state, request.key, { kind: 'refused', httpStatus: 409, code: 'REVISION_CONFLICT', serverRequestId: 'server-request-001' }, now + 1);
    expect(refused.pending).toBeNull();
    expect(refused.lastSettled?.request.bodyJson).toBe(JSON.stringify(request.body));
    expect(refused.lastSettled?.outcome.kind).toBe('refused');
    expect(() => enqueueWorkspaceRequest(refused, binding, request, now + 2)).toThrow();
    const accepted = recordWorkspaceOutcome(state, request.key, { kind: 'accepted', httpStatus: 200, serverRevision: 8, serverRequestId: 'server-request-001' }, now + 1);
    validateWorkspaceOutbox(reopened(accepted));
    expect(accepted.pending).toBeNull();
    expect(accepted.lastSettled?.outcome).toEqual({ kind: 'accepted', httpStatus: 200, serverRevision: 8, serverRequestId: 'server-request-001' });
  });

  it('recognises only explicit unimplemented-policy 503 replies as definitive refusals', () => {
    for (const code of ['POLICY_APPROVAL_REQUIRED', 'SEASON_ASSIGNMENT_REQUIRED']) {
      const state = recordWorkspaceOutcome(queued(), request.key, { kind: 'refused', httpStatus: 503, code }, now);
      expect(state.pending).toBeNull();
      expect(state.lastSettled?.outcome.kind).toBe('refused');
      expect(state.lastSettled?.request.bodyJson).toBe(JSON.stringify(request.body));
    }
    for (const code of ['IDENTITY_NOT_CONFIGURED', 'SERVICE_UNAVAILABLE', 'DATABASE_UNAVAILABLE']) {
      expect(() => recordWorkspaceOutcome(queued(), request.key, { kind: 'refused', httpStatus: 503, code }, now)).toThrow();
    }
  });

  it('never stores raw response DTOs, headers or error messages in the receipt', () => {
    const outcome = { kind: 'accepted' as const, httpStatus: 200, serverRevision: 8, headers: { Authorization: 'Bearer private-token' }, ballots: ['private-ballot'], message: 'sensitive reason' };
    const state = recordWorkspaceOutcome(queued(), request.key, outcome, now);
    const encoded = JSON.stringify(state);
    expect(encoded).not.toContain('private-token');
    expect(encoded).not.toContain('private-ballot');
    expect(encoded).not.toContain('sensitive reason');
  });

  it('refuses credentials, cross-team paths, non-JSON values and oversized data before journalling', () => {
    for (const field of ['Authorization', 'headers', 'cookie', 'password', 'pin', 'secret', 'accessToken', 'refresh_token', 'id_token', 'uploadToken', 'controllerToken', 'token']) {
      const body = { command: { ...request.body.command, [field]: 'never-persist' } };
      expect(() => enqueueWorkspaceRequest(createWorkspaceOutbox(binding), binding, { ...request, body }, now)).toThrow();
    }
    for (const change of [
      { path: '/v1/teams/other/community?seasonId=2026-27' },
      { path: '/v1/teams/roma-u10/community?seasonId=2027-28' },
      { path: 'https://hostile.example/v1/teams/roma-u10/community?seasonId=2026-27' },
      { path: '/v1/teams/roma-u10/managers?seasonId=2026-27' },
      { body: { command: { ...request.body.command, id: 'other-request-0002' } } },
      { body: { command: { ...request.body.command, unexpected: Number.POSITIVE_INFINITY } } },
      { body: { command: { ...request.body.command, caption: '😀'.repeat(70_000) } } },
      { body: { command: { id: request.key, type: 'invite.accepted', reviewCode: 'invitation-secret' } } },
    ]) expect(() => enqueueWorkspaceRequest(createWorkspaceOutbox(binding), binding, { ...request, ...change }, now)).toThrow();
  });

  it('allows all four normal routes under their current scopes and no manager route for a player', () => {
    const manager = { ...binding, role: 'manager' as const, playerId: null };
    for (const section of ['preparation', 'preparation/own', 'community', 'records']) {
      const candidate = { ...request, path: `/v1/teams/roma-u10/${section}?seasonId=2026-27` };
      expect(enqueueWorkspaceRequest(createWorkspaceOutbox(manager), manager, candidate, now).pending).not.toBeNull();
    }
    expect(enqueueWorkspaceRequest(createWorkspaceOutbox(binding), binding, { ...request, path: '/v1/teams/roma-u10/preparation/own?seasonId=2026-27' }, now).pending).not.toBeNull();
    expect(() => enqueueWorkspaceRequest(createWorkspaceOutbox(binding), binding, { ...request, path: '/v1/teams/roma-u10/records?seasonId=2026-27' }, now)).toThrow();
  });

  it('fails closed on damaged restored state without silently reseeding or changing the original', () => {
    const state = queued();
    for (const change of [{ schemaVersion: 2 }, { revision: -1 }, { scope: { ...state.scope, seasonId: '2027-28' } }, { pending: { ...state.pending, bodyJson: '{broken' } }, { pending: { ...state.pending, bodyJson: JSON.stringify({ command: { ...request.body.command, token: 'secret' } }) } }]) {
      expect(() => validateWorkspaceOutbox({ ...state, ...change } as WorkspaceOutboxState)).toThrow();
    }
    expect(state.pending!.bodyJson).toBe(JSON.stringify(request.body));
    const settled = recordWorkspaceOutcome(state, request.key, { kind: 'accepted', httpStatus: 200 }, now);
    expect(() => validateWorkspaceOutbox({ ...settled, token: 'unexpected-secret' } as WorkspaceOutboxState)).toThrow();
    expect(() => validateWorkspaceOutbox({ ...settled, lastSettled: { ...settled.lastSettled, outcome: { kind: 'unconfirmed', reason: 'network' } } } as unknown as WorkspaceOutboxState)).toThrow();
  });

  it('permits only verified native protected storage or explicitly fictional browser storage', () => {
    const diagnostics = { mode: 'encrypted-native', cipherVersion: 'SQLCipher 4', wrongKeyProbe: 'passed', backupExcluded: true };
    expect(workspaceOutboxStorageAllowed({ platform: 'native', synthetic: false, diagnostics })).toBe(true);
    for (const change of [{ cipherVersion: null }, { wrongKeyProbe: 'not-run' }, { wrongKeyProbe: 'failed' }, { backupExcluded: false }, { mode: 'synthetic-browser' }]) {
      expect(workspaceOutboxStorageAllowed({ platform: 'native', synthetic: false, diagnostics: { ...diagnostics, ...change } })).toBe(false);
    }
    expect(workspaceOutboxStorageAllowed({ platform: 'web', synthetic: false, diagnostics })).toBe(false);
    expect(workspaceOutboxStorageAllowed({ platform: 'web', synthetic: false, diagnostics: { ...diagnostics, mode: 'synthetic-browser' } })).toBe(false);
    expect(workspaceOutboxStorageAllowed({ platform: 'web', synthetic: true, diagnostics: { ...diagnostics, mode: 'synthetic-browser', cipherVersion: null, wrongKeyProbe: 'unsupported', backupExcluded: false } })).toBe(true);
  });
  it('retains administrator configuration/rollover requests separately and requires fresh explicit administrator authority', () => {
    const adminBinding = { ...binding, role: 'administrator' as const, playerId: null };
    const adminPrincipal: Principal = { ...principal, identityClassification: 'adult_individual', adultVerified: true, strongAuth: true };
    const adminMemberships: Membership[] = [{ ...memberships[0], role: 'administrator', playerId: undefined }];
    const rollover = { ...request, path: '/v1/teams/roma-u10/seasons?seasonId=2026-27', body: { command: { id: request.key, type: 'season.rolled_over' } } };
    const state = enqueueWorkspaceRequest(createWorkspaceOutbox(adminBinding), adminBinding, rollover, now);
    const context = { ...auth, binding: adminBinding, principal: adminPrincipal, memberships: adminMemberships };
    expect(authorizeWorkspaceReplay(state, context).key).toBe(request.key);
    expect(() => authorizeWorkspaceReplay(state, { ...context, principal: { ...adminPrincipal, authenticatedAt: now - 300_001 } })).toThrow('Recent');
    expect(() => authorizeWorkspaceReplay(state, { ...context, memberships: [] })).toThrow();
    expect(() => enqueueWorkspaceRequest(createWorkspaceOutbox(adminBinding), adminBinding, request, now)).toThrow();
    const configuration = { ...rollover, path: '/v1/teams/roma-u10/configuration?seasonId=2026-27' };
    expect(enqueueWorkspaceRequest(createWorkspaceOutbox(adminBinding), adminBinding, configuration, now).pending).not.toBeNull();
  });
});
