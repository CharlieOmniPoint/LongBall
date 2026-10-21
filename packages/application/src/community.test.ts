import { describe, expect, it } from 'vitest';
import {
  applyCommunityCommand, authorizeCommunityMedia, communityCanAccess, createCommunityState,
  finalizeDueCommunityAwards, getCommunityView, getOwnCommunityBallot, ownCommunityExport,
  syntheticCommunityActors, parseCommunityCommand, type CommunityActor, type CommunityCommand, type CommunityState,
} from './community';

const now = Date.parse('2026-10-21T10:00:00Z');
type Payload = CommunityCommand extends infer C ? C extends CommunityCommand ? Omit<C, 'id' | 'expectedRevision'> : never : never;
function setup() {
  let state = createCommunityState(now);
  const actors = syntheticCommunityActors(state);
  let sequence = 0;
  return {
    actors,
    get state() { return state; },
    set state(value: CommunityState) { state = value; },
    send(actor: CommunityActor, payload: Payload, at = now) {
      state = applyCommunityCommand(state, actor, { ...payload, id: `test-command-${++sequence}`, expectedRevision: state.revision } as CommunityCommand, at);
      return state;
    },
    configure() {
      state = applyCommunityCommand(state, actors.manager, { id: `test-command-${++sequence}`, type: 'award.cutoffConfigured', matchId: state.matches[0].id, minutesAfterFullTime: 30 }, now);
    },
  };
}

describe('season-scoped individual spectator access', () => {
  it('lets a player invite without approval and reuses the existing invitee identity', () => {
    const lab = setup();
    const accounts = lab.state.accounts.length;
    lab.send(lab.actors.player, { type: 'invite.created', invitationId: 'invite-1', reviewCode: 'DEMO-INDIVIDUAL', expiresAtMs: now + 3_600_000 });
    expect(lab.state.invitations[0].acceptedBy).toBeNull();
    expect(communityCanAccess(lab.state, lab.actors.invitee, now)).toBe(false);
    lab.send(lab.actors.invitee, { type: 'invite.accepted', reviewCode: 'DEMO-INDIVIDUAL' });
    expect(lab.state.accounts).toHaveLength(accounts);
    expect(communityCanAccess(lab.state, lab.actors.invitee, now)).toBe(true);
    expect(lab.state.grants.at(-1)?.expiresAtMs).toBe(Date.parse('2027-08-31T23:00:00Z'));
    expect(() => lab.send(lab.actors.spectator, { type: 'invite.accepted', reviewCode: 'DEMO-INDIVIDUAL' })).toThrow(/accepted or revoked/);
  });

  it('denies expired, revoked and cross-team invitations without destroying other roles', () => {
    const lab = setup();
    lab.send(lab.actors.manager, { type: 'invite.created', invitationId: 'invite-1', reviewCode: 'DEMO-SHORT', expiresAtMs: now + 1000 });
    expect(() => lab.send(lab.actors.invitee, { type: 'invite.accepted', reviewCode: 'DEMO-SHORT' }, now + 1000)).toThrow(/expired/);
    expect(() => lab.send({ ...lab.actors.invitee, teamId: 'different-team' }, { type: 'invite.accepted', reviewCode: 'DEMO-SHORT' })).toThrow(/not valid for this team/);
    lab.send(lab.actors.manager, { type: 'invite.revoked', invitationId: 'invite-1' });
    expect(() => lab.send(lab.actors.invitee, { type: 'invite.accepted', reviewCode: 'DEMO-SHORT' })).toThrow(/revoked/);
    lab.state.grants.push({ ...lab.state.grants[0], id: 'manager-spectator-grant', accountId: lab.actors.manager.accountId, expiresAtMs: now + 1000 });
    expect(communityCanAccess(lab.state, { ...lab.actors.manager, role: 'spectator' }, now + 1000)).toBe(false);
    expect(communityCanAccess(lab.state, lab.actors.manager, now + 1000)).toBe(true);
    expect(lab.state.memberships.find(item => item.accountId === lab.actors.manager.accountId)?.active).toBe(true);
  });

  it('revocation immediately denies existing media links and does not rely on hidden UI', () => {
    const lab = setup();
    expect(authorizeCommunityMedia(lab.state, lab.actors.spectator, 'synthetic-published-pitch', now).allowed).toBe(true);
    lab.send(lab.actors.manager, { type: 'grant.revoked', grantId: 'synthetic-demo-grant' });
    expect(authorizeCommunityMedia(lab.state, lab.actors.spectator, 'synthetic-published-pitch', now).allowed).toBe(false);
    expect(getCommunityView(lab.state, lab.actors.spectator, now).gallery).toHaveLength(0);
    expect(getCommunityView(lab.state, lab.actors.spectator, now).matches).toHaveLength(0);
    expect(() => lab.send({ ...lab.actors.player, role: 'manager' }, { type: 'grant.revoked', grantId: 'synthetic-demo-grant' })).toThrow(/access is unavailable/);
    expect(() => lab.send(lab.actors.spectator, { type: 'invite.created', invitationId: 'forbidden', reviewCode: 'DEMO-FORBIDDEN', expiresAtMs: now + 1000 })).toThrow();
  });

  it('shows only the player’s own invitations and leaves the previous season unrenewed', () => {
    const lab = setup();
    lab.send(lab.actors.player, { type: 'invite.created', invitationId: 'first', reviewCode: 'DEMO-FIRST', expiresAtMs: now + 1000 });
    lab.send(lab.actors.secondPlayer, { type: 'invite.created', invitationId: 'second', reviewCode: 'DEMO-SECOND', expiresAtMs: now + 1000 });
    expect(getCommunityView(lab.state, lab.actors.player, now).invitations.map(item => item.id)).toEqual(['first']);
    expect(getCommunityView(lab.state, lab.actors.manager, now).invitations).toHaveLength(2);
    expect(communityCanAccess(lab.state, { ...lab.actors.spectator, seasonId: 'synthetic-season-2027-28' }, now)).toBe(false);
  });
});

describe('private ballots and original award timing', () => {
  it('keeps Q15 unresolved until an explicit fictional cutoff is chosen', () => {
    const lab = setup();
    expect(lab.state.matches[0].voteCutoffAtMs).toBeNull();
    expect(() => lab.send(lab.actors.player, { type: 'ballot.cast', matchId: lab.state.matches[0].id, candidatePlayerId: 'synthetic-player-02' })).toThrow(/Q15/);
    expect(() => lab.send(lab.actors.manager, { type: 'award.cutoffConfigured', matchId: lab.state.matches[0].id, minutesAfterFullTime: 60 })).toThrow(/1 to 59/);
    expect(finalizeDueCommunityAwards(lab.state, now + 4_000_000)).toBe(lab.state);
    lab.configure();
    expect(lab.state.matches[0].voteCutoffAtMs).toBe(lab.state.matches[0].actualFullTimeAtMs! + 1_800_000);
    expect(lab.state.matches[0].cutoffSource).toBe('explicit_fictional_setting');
  });

  it('rejects self-votes, absent voters, unplayed candidates and manager impersonation', () => {
    const lab = setup(); lab.configure();
    const matchId = lab.state.matches[0].id;
    expect(() => lab.send(lab.actors.player, { type: 'ballot.cast', matchId, candidatePlayerId: 'synthetic-player-01' })).toThrow(/Self-votes/);
    expect(() => lab.send(lab.actors.player, { type: 'ballot.cast', matchId, candidatePlayerId: 'synthetic-player-13' })).toThrow(/actually played/);
    expect(() => lab.send(lab.actors.manager, { type: 'ballot.cast', matchId, candidatePlayerId: 'synthetic-player-02' })).toThrow(/present selected player/);
    const absent = { ...lab.actors.player, accountId: 'synthetic-account-player-13', playerId: 'synthetic-player-13' };
    expect(() => lab.send(absent, { type: 'ballot.cast', matchId, candidatePlayerId: 'synthetic-player-02' })).toThrow(/present selected player/);
    expect(() => lab.send({ ...lab.actors.player, playerId: 'synthetic-player-02' }, { type: 'ballot.cast', matchId, candidatePlayerId: 'synthetic-player-03' })).toThrow(/access is unavailable/);
  });

  it('counts only each child account’s latest selection and never exposes other choices', () => {
    const lab = setup(); lab.configure();
    const matchId = lab.state.matches[0].id;
    lab.send(lab.actors.player, { type: 'ballot.cast', matchId, candidatePlayerId: 'synthetic-player-02' });
    lab.send(lab.actors.player, { type: 'ballot.cast', matchId, candidatePlayerId: 'synthetic-player-03' }, now + 1);
    lab.send(lab.actors.secondPlayer, { type: 'ballot.cast', matchId, candidatePlayerId: 'synthetic-player-03' }, now + 2);
    expect(getOwnCommunityBallot(lab.state, lab.actors.player, matchId, now + 2)?.candidatePlayerId).toBe('synthetic-player-03');
    expect(() => getOwnCommunityBallot(lab.state, lab.actors.manager, matchId, now)).toThrow(/Managers cannot inspect/);
    expect(JSON.stringify(getCommunityView(lab.state, lab.actors.manager, now))).not.toContain('candidatePlayerId');
    expect(getCommunityView(lab.state, lab.actors.manager, now).matches[0].ownChoice).toBeNull();
    expect(getCommunityView(lab.state, lab.actors.spectator, now).matches[0].candidates).toEqual([]);
    lab.send(lab.actors.manager, { type: 'award.finalised', matchId }, now + 3);
    expect(lab.state.awards[0].winnerPlayerIds).toEqual(['synthetic-player-03']);
    expect(lab.state.ballots).toHaveLength(3); // audit revisions survive; one current choice counts
    expect(lab.state.audit.every(entry => !JSON.stringify(entry).includes('candidatePlayerId'))).toBe(true);
    expect(() => lab.send(lab.actors.player, { type: 'ballot.cast', matchId, candidatePlayerId: 'synthetic-player-02' }, now + 4)).toThrow(/closed/);
  });

  it('publishes joint winners equally, and the worker seals once without a fake manager', () => {
    const lab = setup(); lab.configure();
    const matchId = lab.state.matches[0].id;
    lab.send(lab.actors.player, { type: 'ballot.cast', matchId, candidatePlayerId: 'synthetic-player-02' });
    lab.send(lab.actors.secondPlayer, { type: 'ballot.cast', matchId, candidatePlayerId: 'synthetic-player-03' }, now + 1);
    const cutoff = lab.state.matches[0].voteCutoffAtMs!;
    expect(() => lab.send(lab.actors.player, { type: 'ballot.cast', matchId, candidatePlayerId: 'synthetic-player-03' }, cutoff)).toThrow(/closed at its original cutoff/);
    const final = finalizeDueCommunityAwards(lab.state, cutoff);
    expect(final.awards[0].winnerPlayerIds).toEqual(['synthetic-player-02', 'synthetic-player-03']);
    expect(final.awards[0].deadlineMissed).toBe(false);
    expect(final.audit.at(-1)).toMatchObject({ actorAccountId: null, origin: 'award_worker' });
    expect(finalizeDueCommunityAwards(final, cutoff + 1000)).toBe(final);
    expect(getCommunityView(final, lab.actors.spectator, cutoff).matches[0].award?.winnerLabels).toEqual(['Noah Patel', 'Leo Martin']);
  });

  it('counts a committed ballot before a deliberate close in the same millisecond', () => {
    const lab = setup(); lab.configure();
    const matchId = lab.state.matches[0].id;
    lab.send(lab.actors.player, { type: 'ballot.cast', matchId, candidatePlayerId: 'synthetic-player-02' }, now);
    lab.send(lab.actors.manager, { type: 'award.finalised', matchId }, now);
    expect(lab.state.awards[0].winnerPlayerIds).toEqual(['synthetic-player-02']);
  });

  it('refuses a corrupt second player mapping on one global account', () => {
    const lab = setup(); lab.configure();
    lab.state.memberships.push({ accountId: lab.actors.player.accountId, playerId: 'synthetic-player-02', teamId: lab.actors.player.teamId,
      seasonId: lab.actors.player.seasonId, role: 'player', active: true });
    expect(() => lab.send(lab.actors.player, { type: 'ballot.cast', matchId: lab.state.matches[0].id, candidatePlayerId: 'synthetic-player-03' })).toThrow(/access is unavailable/);
    expect(() => lab.send({ ...lab.actors.player, playerId: 'synthetic-player-02' }, { type: 'ballot.cast', matchId: lab.state.matches[0].id, candidatePlayerId: 'synthetic-player-03' })).toThrow(/access is unavailable/);
  });

  it('retains original full-time deadlines on a 75-minute delayed receipt and flags late finalisation', () => {
    const lab = setup();
    const original = now - 75 * 60_000;
    const { voteCutoffAtMs: _cutoff, cutoffSource: _source, finalisationDeadlineAtMs: _deadline, ...match } = lab.state.matches[0];
    lab.send(lab.actors.manager, { type: 'match.registered', match: { ...match, id: 'late-finish', actualFullTimeAtMs: original, playedAtMs: original - 3_600_000 } });
    lab.send(lab.actors.manager, { type: 'award.cutoffConfigured', matchId: 'late-finish', minutesAfterFullTime: 30 });
    const final = finalizeDueCommunityAwards(lab.state, now);
    expect(final.awards.find(item => item.matchId === 'late-finish')).toMatchObject({ voteCutoffAtMs: original + 30 * 60_000,
      finalisationDeadlineAtMs: original + 60 * 60_000, finalisedAtMs: now, deadlineMissed: true, result: 'no_valid_votes' });
    expect(() => lab.send(lab.actors.manager, { type: 'match.registered', match: { ...match, id: 'late-finish', actualFullTimeAtMs: now } })).toThrow(/never reopens/);
  });

  it('does not finalise conflicted finish evidence or silently reconfigure a cutoff', () => {
    const lab = setup(); lab.configure();
    expect(() => lab.send(lab.actors.manager, { type: 'award.cutoffConfigured', matchId: lab.state.matches[0].id, minutesAfterFullTime: 45 })).toThrow(/cannot be reopened/);
    lab.state.matches[0].finishQuality = 'conflicted';
    expect(finalizeDueCommunityAwards(lab.state, now + 9_000_000)).toBe(lab.state);
    expect(() => lab.send(lab.actors.manager, { type: 'award.finalised', matchId: lab.state.matches[0].id })).toThrow(/Contradictory/);
  });

  it('makes exact retries idempotent after expiry but rejects reused identities and stale writes', () => {
    const lab = setup(); lab.configure();
    const command: CommunityCommand = { id: 'stable-retry-id', expectedRevision: lab.state.revision, type: 'ballot.cast', matchId: lab.state.matches[0].id, candidatePlayerId: 'synthetic-player-02' };
    const saved = applyCommunityCommand(lab.state, lab.actors.player, command, now);
    expect(applyCommunityCommand(saved, lab.actors.player, command, now + 4_000_000)).toBe(saved);
    expect(saved.ballots).toHaveLength(1);
    expect(() => applyCommunityCommand(saved, lab.actors.player, { ...command, candidatePlayerId: 'synthetic-player-03' }, now)).toThrow(/different content/);
    expect(() => applyCommunityCommand(saved, lab.actors.secondPlayer, { ...command, id: 'new-stale-command' }, now)).toThrow(/records changed/);
    expect(lab.state.ballots).toHaveLength(0);
  });
});

describe('private media revision and moderation boundaries', () => {
  it('does not disclose a pending photo or count through gallery, thumbnail or direct ID', () => {
    const lab = setup();
    expect(getCommunityView(lab.state, lab.actors.spectator, now).gallery).toHaveLength(1);
    expect(authorizeCommunityMedia(lab.state, lab.actors.player, 'synthetic-pending-ball', now).allowed).toBe(false);
    expect(authorizeCommunityMedia(lab.state, lab.actors.secondPlayer, 'synthetic-pending-ball', now, 'own').allowed).toBe(false);
    expect(authorizeCommunityMedia(lab.state, lab.actors.player, 'synthetic-pending-ball', now, 'own').allowed).toBe(true);
    expect(authorizeCommunityMedia(lab.state, lab.actors.manager, 'synthetic-pending-ball', now, 'review').allowed).toBe(true);
    expect(getCommunityView(lab.state, lab.actors.spectator, now).reviewQueue).toEqual([]);
    expect(getCommunityView(lab.state, lab.actors.secondPlayer, now).submissions).toEqual([]);
    expect(() => lab.send(lab.actors.spectator, { type: 'photo.submitted', photoId: 'forbidden', matchId: lab.state.matches[0].id, art: 'ball', caption: '', policyAcknowledged: true })).toThrow(/cannot upload/);
  });

  it('requires an explicit manager Publish after preparation, without a second reviewer', () => {
    const lab = setup();
    lab.send(lab.actors.manager, { type: 'photo.submitted', photoId: 'manager-draft', matchId: lab.state.matches[0].id, art: 'cones', caption: 'Fictional cones', policyAcknowledged: true });
    expect(authorizeCommunityMedia(lab.state, lab.actors.spectator, 'manager-draft', now).allowed).toBe(false);
    expect(() => lab.send(lab.actors.player, { type: 'photo.published', photoId: 'manager-draft', sourceRevision: 1, policyAcknowledged: true })).toThrow(/Only an assigned/);
    lab.send(lab.actors.manager, { type: 'photo.published', photoId: 'manager-draft', sourceRevision: 1, policyAcknowledged: true });
    const decision = authorizeCommunityMedia(lab.state, lab.actors.spectator, 'manager-draft', now);
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.cacheControl).toBe('private, no-store');
  });

  it('reviews exactly one immutable revision and preserves the old approved revision during replacement', () => {
    const lab = setup();
    lab.send(lab.actors.manager, { type: 'photo.reviewed', photoId: 'synthetic-pending-ball', sourceRevision: 1, decision: 'approve' });
    lab.send(lab.actors.player, { type: 'photo.revised', photoId: 'synthetic-pending-ball', sourceRevision: 1, art: 'cones', caption: 'Revised fictional art', policyAcknowledged: true });
    const old = authorizeCommunityMedia(lab.state, lab.actors.spectator, 'synthetic-pending-ball', now);
    expect(old.allowed && old.revision.version).toBe(1);
    expect(authorizeCommunityMedia(lab.state, lab.actors.spectator, 'synthetic-pending-ball', now, 'gallery', 2).allowed).toBe(false);
    expect(() => lab.send(lab.actors.manager, { type: 'photo.reviewed', photoId: 'synthetic-pending-ball', sourceRevision: 1, decision: 'approve' })).toThrow(/photo changed/);
    lab.send(lab.actors.manager, { type: 'photo.reviewed', photoId: 'synthetic-pending-ball', sourceRevision: 2, decision: 'approve' });
    const current = authorizeCommunityMedia(lab.state, lab.actors.spectator, 'synthetic-pending-ball', now);
    expect(current.allowed && current.revision.version).toBe(2);
    expect(authorizeCommunityMedia(lab.state, lab.actors.spectator, 'synthetic-pending-ball', now, 'gallery', 1).allowed).toBe(false);
  });

  it('retains private rejection metadata and blocks removed/rejected derivatives', () => {
    const lab = setup();
    lab.send(lab.actors.manager, { type: 'photo.reviewed', photoId: 'synthetic-pending-ball', sourceRevision: 1, decision: 'reject', reason: 'Private fictional review reason' });
    expect(authorizeCommunityMedia(lab.state, lab.actors.player, 'synthetic-pending-ball', now, 'own').allowed).toBe(false);
    expect(getCommunityView(lab.state, lab.actors.player, now).submissions[0]).toMatchObject({ art: null, rejectionReason: 'Private fictional review reason' });
    expect(JSON.stringify(getCommunityView(lab.state, lab.actors.secondPlayer, now))).not.toContain('Private fictional review reason');
    lab.send(lab.actors.manager, { type: 'photo.removed', photoId: 'synthetic-published-pitch' });
    expect(authorizeCommunityMedia(lab.state, lab.actors.manager, 'synthetic-published-pitch', now, 'own').allowed).toBe(false);
    expect(authorizeCommunityMedia(lab.state, lab.actors.spectator, 'synthetic-published-pitch', now).allowed).toBe(false);
    expect(lab.state.photos.find(item => item.id === 'synthetic-published-pitch')?.removedAtMs).toBe(now);
  });

  it('hides only a requesting account’s gallery and leaves awards/moderation intact', () => {
    const lab = setup();
    const matches = getCommunityView(lab.state, lab.actors.spectator, now).matches;
    lab.send(lab.actors.spectator, { type: 'uploader.hidden', uploaderAccountId: lab.actors.manager.accountId, hidden: true });
    expect(getCommunityView(lab.state, lab.actors.spectator, now).gallery).toHaveLength(0);
    expect(getCommunityView(lab.state, lab.actors.spectator, now).matches).toEqual(matches);
    expect(getCommunityView(lab.state, lab.actors.secondPlayer, now).gallery).toHaveLength(1);
    lab.send(lab.actors.manager, { type: 'photo.reviewed', photoId: 'synthetic-pending-ball', sourceRevision: 1, decision: 'approve' });
    lab.send(lab.actors.player, { type: 'photo.revised', photoId: 'synthetic-pending-ball', sourceRevision: 1, art: 'ball', caption: 'Pending new revision', policyAcknowledged: true });
    lab.send(lab.actors.manager, { type: 'uploader.hidden', uploaderAccountId: lab.actors.player.accountId, hidden: true });
    expect(getCommunityView(lab.state, lab.actors.manager, now).reviewQueue).toHaveLength(1);
    lab.send(lab.actors.spectator, { type: 'uploader.hidden', uploaderAccountId: lab.actors.manager.accountId, hidden: false });
    expect(getCommunityView(lab.state, lab.actors.spectator, now).gallery).toHaveLength(2);
  });

  it('keeps concern reporter identity private and excludes an implicated manager from review', () => {
    const lab = setup();
    lab.send(lab.actors.player, { type: 'concern.submitted', concernId: 'manager-concern', targetType: 'photo', targetId: 'synthetic-published-pitch', category: 'privacy', explanation: 'Fictional concern' });
    expect(lab.state.concerns[0]).toMatchObject({ status: 'escalation_required', photoRevision: 1 });
    expect(getCommunityView(lab.state, lab.actors.manager, now).reviewConcerns).toEqual([]);
    expect(getCommunityView(lab.state, lab.actors.secondPlayer, now).ownConcerns).toEqual([]);
    expect(() => lab.send(lab.actors.manager, { type: 'concern.updated', concernId: 'manager-concern', status: 'resolved' })).toThrow(/conflicted manager/);
    lab.send(lab.actors.manager, { type: 'photo.reviewed', photoId: 'synthetic-pending-ball', sourceRevision: 1, decision: 'approve' });
    lab.send(lab.actors.secondPlayer, { type: 'concern.submitted', concernId: 'player-concern', targetType: 'uploader', targetId: lab.actors.player.accountId, category: 'other', explanation: 'Fictional uploader concern' });
    const review = getCommunityView(lab.state, lab.actors.manager, now).reviewConcerns[0];
    expect(review).toMatchObject({ id: 'player-concern', explanation: 'Fictional uploader concern' });
    expect('reporterAccountId' in review).toBe(false);
    lab.send(lab.actors.manager, { type: 'concern.updated', concernId: 'player-concern', status: 'resolved' });
    expect(getCommunityView(lab.state, lab.actors.secondPlayer, now).ownConcerns[0].status).toBe('resolved');
  });

  it('applies manager-only competition policy to published gallery and final recognition', () => {
    const lab = setup(); lab.state.matches[0].sharing = 'manager_only';
    lab.send(lab.actors.manager, { type: 'award.finalised', matchId: lab.state.matches[0].id });
    const spectator = getCommunityView(lab.state, lab.actors.spectator, now);
    expect(spectator.gallery).toEqual([]);
    expect(spectator.matches[0]).toMatchObject({ award: null, fullTimeAtMs: null, deadlineAtMs: null, label: 'Match context withheld by competition policy' });
    expect(getCommunityView(lab.state, lab.actors.manager, now).gallery).toHaveLength(1);
  });
});

describe('global own-account support surfaces', () => {
  it('exports only the requester’s choices and requests while keeping other ballots private', () => {
    const lab = setup(); lab.configure();
    lab.send(lab.actors.player, { type: 'ballot.cast', matchId: lab.state.matches[0].id, candidatePlayerId: 'synthetic-player-02' });
    lab.send(lab.actors.secondPlayer, { type: 'ballot.cast', matchId: lab.state.matches[0].id, candidatePlayerId: 'synthetic-player-03' });
    const first = ownCommunityExport(lab.state, lab.actors.player);
    expect(first.ownBallots).toHaveLength(1);
    expect(first.ownBallots.every(ballot => ballot.voterAccountId === lab.actors.player.accountId)).toBe(true);
    expect(ownCommunityExport(lab.state, lab.actors.manager).ownBallots).toEqual([]);
    expect(first.memberships.every(member => member.accountId === lab.actors.player.accountId)).toBe(true);
  });

  it('persists per-account preferences and verification-needed deletion drafts without deleting journals', () => {
    const lab = setup();
    const before = lab.state.matches;
    lab.send(lab.actors.player, { type: 'preferences.changed', preferences: { schedule: false, match: true, awards: false, photos: true, quietStart: '22:30', quietEnd: '07:15' } });
    expect(getCommunityView(lab.state, lab.actors.secondPlayer, now).preferences.schedule).toBe(true);
    expect(getCommunityView(lab.state, lab.actors.player, now).preferences.quietStart).toBe('22:30');
    lab.send(lab.actors.player, { type: 'privacy.drafted', requestId: 'global-delete-draft', requestType: 'delete_global_account' });
    expect(lab.state.matches).toEqual(before);
    expect(lab.state.accounts).toHaveLength(16);
    expect(lab.state.privacyRequests[0]).toMatchObject({ accountId: lab.actors.player.accountId, status: 'verification_needed', delivery: 'local_draft' });
    expect(() => lab.send(lab.actors.manager, { type: 'privacy.cancelled', requestId: 'global-delete-draft' })).toThrow(/belongs to another/);
    lab.send(lab.actors.player, { type: 'privacy.cancelled', requestId: 'global-delete-draft' });
    expect(lab.state.privacyRequests[0].status).toBe('cancelled');
  });
});

describe('community HTTP command JSON boundary', () => {
  it('accepts a complete command and clones nested data instead of keeping a mutable client object', () => {
    const input = { id: 'parse-preferences', type: 'preferences.changed', expectedRevision: 2,
      preferences: { schedule: true, match: false, awards: true, photos: false, quietStart: null, quietEnd: null } };
    const parsed = parseCommunityCommand(input);
    expect(parsed).toEqual(input);
    input.preferences.photos = true;
    expect(parsed.type === 'preferences.changed' && parsed.preferences.photos).toBe(false);
  });

  it('rejects unknown fields, wrong discriminators, invalid revisions and malformed nested payloads without echoing private text', () => {
    const sensitive = 'DO-NOT-ECHO-PRIVATE-REVIEW-CODE';
    const invalid: unknown[] = [null, [], { id: 'x', type: 'unknown', reviewCode: sensitive },
      { id: 'x', type: 'invite.accepted', reviewCode: sensitive, unknown: true },
      { id: 'x', type: 'invite.accepted', reviewCode: sensitive, expectedRevision: -1 },
      { id: 'x', type: 'invite.accepted', reviewCode: sensitive, expectedRevision: 0.5 },
      { id: 'x', type: 'photo.reviewed', photoId: 'photo', sourceRevision: 1, decision: 'publish-without-review' },
      { id: 'x', type: 'photo.submitted', photoId: 'photo', matchId: 'match', art: 'https://external.example/child.jpg', caption: '', policyAcknowledged: true },
      { id: 'x', type: 'preferences.changed', preferences: { schedule: true, match: true, awards: true, photos: true, quietStart: null, quietEnd: null, otherAccount: sensitive } },
      { id: 'x', type: 'photo.submitted', photoId: 'photo', matchId: 'match', art: 'pitch', caption: '', policyAcknowledged: 'true' },
    ];
    for (const input of invalid) {
      try { parseCommunityCommand(input); expect.fail('Invalid payload was accepted'); }
      catch (error) {
        expect(error).toMatchObject({ code: 'invalid' });
        expect((error as Error).message).not.toContain(sensitive);
      }
    }
  });

  it('does not accept publication-policy and trusted-finish authority through a public community command', () => {
    const lab = setup();
    const { voteCutoffAtMs: _cutoff, cutoffSource: _source, finalisationDeadlineAtMs: _deadline, ...match } = lab.state.matches[0];
    const payload = { id: 'forged-match-context', type: 'match.registered', match: { ...match, sharing: 'fictional_review_only', finishQuality: 'trusted' } };
    expect(() => parseCommunityCommand(payload)).toThrow(/assigned by the service/);
    expect(parseCommunityCommand(payload, { allowServiceOwnedCommands: true })).toEqual(payload);
  });
});
