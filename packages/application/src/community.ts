import { demoAccountLabels, romaFixture } from '@longball/testing';
import { createDemoCompletedMatches } from './demo-season';
/**
 * Serializable community rules shared by the synthetic native and web journeys.
 * Actors must come from an authenticated service in a connected pilot. This module
 * does not turn a role selector, a review code or local persistence into identity.
 */
import { isInvitationTokenHash, pendingInvitation, publicInvitation, type CredentialInvitation, type InvitationCredential } from './invitation-credentials';
export type CommunityRole = 'manager' | 'player' | 'spectator';
export interface CommunityActor {
  role: CommunityRole;
  accountId: string;
  teamId: string;
  seasonId: string;
  playerId?: string;
}
export interface CommunityAccount {
  id: string;
  label: string;
  classification: 'adult_individual' | 'child_shared' | 'spectator';
  adultVerified: boolean;
}
export interface CommunityMembership {
  accountId: string;
  teamId: string;
  seasonId: string;
  role: 'manager' | 'player';
  playerId?: string;
  active: boolean;
}
export interface CommunitySeason {
  id: string;
  teamId: string;
  label: string;
  teamLabel: string;
  /** Explicit Europe/London season boundary, supplied as an absolute instant. */
  accessEndsAtMs: number;
}
export type SpectatorInvite = Omit<CredentialInvitation, 'credential'> & (
  | { credential: Exclude<InvitationCredential, { kind: 'fictional_review' }>; reviewCode?: never }
  | { credential: Extract<InvitationCredential, { kind: 'fictional_review' }>; reviewCode: string }
);
export interface SpectatorGrant {
  id: string;
  invitationId: string;
  accountId: string;
  teamId: string;
  seasonId: string;
  startsAtMs: number;
  expiresAtMs: number;
  revokedAtMs: number | null;
}
export interface CommunityMatch {
  id: string;
  teamId: string;
  seasonId: string;
  label: string;
  playedAtMs: number;
  selectedPlayerIds: string[];
  presentPlayerIds: string[];
  playedPlayerIds: string[];
  actualFullTimeAtMs: number | null;
  finishQuality: 'trusted' | 'review_required' | 'conflicted';
  voteCutoffAtMs: number | null;
  cutoffSource: 'unresolved' | 'explicit_fictional_setting' | 'manager_early_close';
  /** This is deliberately separate from receipt/report time and the voting cutoff. */
  finalisationDeadlineAtMs: number | null;
  sharing: 'manager_only' | 'fictional_review_only';
  policyVersion: number;
}
export interface BallotRevision {
  id: string;
  matchId: string;
  voterAccountId: string;
  voterPlayerId: string;
  candidatePlayerId: string;
  receivedAtMs: number;
  revision: number;
}
export interface PlayersAward {
  matchId: string;
  winnerPlayerIds: string[];
  result: 'winners' | 'no_valid_votes';
  voteCutoffAtMs: number;
  finalisationDeadlineAtMs: number;
  finalisedAtMs: number;
  deadlineMissed: boolean;
}
export type FictionalArt = 'pitch' | 'ball' | 'cones';
export type PhotoRevisionStatus = 'draft' | 'pending' | 'published' | 'rejected' | 'withdrawn';
export interface PhotoRevision {
  version: number;
  art: FictionalArt;
  caption: string;
  status: PhotoRevisionStatus;
  createdAtMs: number;
  reviewedAtMs: number | null;
  reviewerAccountId: string | null;
  rejectionReason: string | null;
  /** There is no raw upload or claimed production scanner in this rehearsal. */
  processing: 'synthetic_derivative_ready';
}
export interface CommunityPhoto {
  id: string;
  matchId: string;
  teamId: string;
  seasonId: string;
  uploaderAccountId: string;
  uploaderRole: 'manager' | 'player';
  currentRevision: number;
  publishedRevision: number | null;
  removedAtMs: number | null;
  revisions: PhotoRevision[];
}
export interface ContentConcern {
  id: string;
  teamId: string;
  seasonId: string;
  reporterAccountId: string;
  targetType: 'photo' | 'uploader';
  targetId: string;
  photoRevision: number | null;
  uploaderAccountId: string;
  category: 'privacy' | 'inappropriate' | 'other';
  explanation: string;
  status: 'submitted' | 'under_review' | 'resolved' | 'escalation_required';
  createdAtMs: number;
}
export interface CommunityPreferences {
  schedule: boolean;
  match: boolean;
  awards: boolean;
  photos: boolean;
  quietStart: string | null;
  quietEnd: string | null;
}
export interface PrivacyRequestDraft {
  id: string;
  accountId: string;
  type: 'export' | 'delete_global_account';
  status: 'verification_needed' | 'cancelled';
  createdAtMs: number;
  /** No submitted/completed claim before an authorised connected verification flow. */
  delivery: 'local_draft';
}
export interface CommunityState {
  schemaVersion: 1;
  synthetic: true;
  revision: number;
  accounts: CommunityAccount[];
  memberships: CommunityMembership[];
  seasons: CommunitySeason[];
  invitations: SpectatorInvite[];
  grants: SpectatorGrant[];
  matches: CommunityMatch[];
  ballots: BallotRevision[];
  awards: PlayersAward[];
  photos: CommunityPhoto[];
  concerns: ContentConcern[];
  hiddenUploaders: { accountId: string; uploaderAccountId: string }[];
  preferences: Record<string, CommunityPreferences>;
  privacyRequests: PrivacyRequestDraft[];
  audit: { id: string; actorAccountId: string | null; action: string; atMs: number; origin?: 'account' | 'award_worker' }[];
  appliedCommands: Record<string, string>;
}
interface CommandBase { id: string; expectedRevision?: number }
export type CommunityCommand = CommandBase & (
  | { type: 'invite.created'; invitationId: string; reviewCode: string; expiresAtMs: number }
  | { type: 'invite.accepted'; reviewCode: string }
  | { type: 'invite.revoked'; invitationId: string }
  | { type: 'grant.revoked'; grantId: string }
  | { type: 'match.registered'; match: Omit<CommunityMatch, 'voteCutoffAtMs' | 'cutoffSource' | 'finalisationDeadlineAtMs'> }
  | { type: 'award.cutoffConfigured'; matchId: string; minutesAfterFullTime: number }
  | { type: 'ballot.cast'; matchId: string; candidatePlayerId: string }
  | { type: 'award.finalised'; matchId: string }
  | { type: 'photo.submitted'; photoId: string; matchId: string; art: FictionalArt; caption: string; policyAcknowledged: true }
  | { type: 'photo.revised'; photoId: string; sourceRevision: number; art: FictionalArt; caption: string; policyAcknowledged: true }
  | { type: 'photo.reviewed'; photoId: string; sourceRevision: number; decision: 'approve' | 'reject'; reason?: string }
  | { type: 'photo.published'; photoId: string; sourceRevision: number; policyAcknowledged: true }
  | { type: 'photo.withdrawn'; photoId: string; sourceRevision: number }
  | { type: 'photo.removed'; photoId: string }
  | { type: 'concern.submitted'; concernId: string; targetType: 'photo' | 'uploader'; targetId: string; category: ContentConcern['category']; explanation: string }
  | { type: 'concern.updated'; concernId: string; status: 'under_review' | 'resolved' }
  | { type: 'uploader.hidden'; uploaderAccountId: string; hidden: boolean }
  | { type: 'preferences.changed'; preferences: CommunityPreferences }
  | { type: 'privacy.drafted'; requestId: string; requestType: PrivacyRequestDraft['type'] }
  | { type: 'privacy.cancelled'; requestId: string }
);

export class CommunityError extends Error {
  constructor(public code: 'forbidden' | 'invalid' | 'conflict' | 'expired' | 'closed' | 'policy_needed', message: string) {
    super(message);
    this.name = 'CommunityError';
  }
}
function requireRule(condition: unknown, code: CommunityError['code'], message: string): asserts condition {
  if (!condition) throw new CommunityError(code, message);
}
function validTime(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function unique(values: string[]): boolean { return new Set(values).size === values.length; }
function account(state: CommunityState, actor: CommunityActor) {
  const found = state.accounts.find(item => item.id === actor.accountId);
  requireRule(found, 'forbidden', 'The account is not recognised.');
  return found;
}
export function communityCanAccess(state: CommunityState, actor: CommunityActor, nowMs: number): boolean {
  const person = state.accounts.find(item => item.id === actor.accountId);
  if (!person) return false;
  if (actor.role === 'spectator') return state.grants.some(grant =>
    grant.accountId === actor.accountId && grant.teamId === actor.teamId && grant.seasonId === actor.seasonId &&
    grant.revokedAtMs === null && grant.startsAtMs <= nowMs && nowMs < grant.expiresAtMs);
  if (actor.role === 'manager' && (person.classification !== 'adult_individual' || !person.adultVerified)) return false;
  const memberships = state.memberships.filter(member => member.active && member.accountId === actor.accountId &&
    member.teamId === actor.teamId && member.seasonId === actor.seasonId && member.role === actor.role);
  // Corrupt/duplicate account-to-player mappings cannot create another ballot.
  if (actor.role === 'player') return memberships.length === 1 && memberships[0].playerId === actor.playerId;
  return memberships.length > 0;
}
function assertAccess(state: CommunityState, actor: CommunityActor, nowMs: number) {
  requireRule(communityCanAccess(state, actor, nowMs), 'forbidden', 'Team access is unavailable or the season grant has expired. Other account memberships remain intact.');
}
function assertManager(state: CommunityState, actor: CommunityActor, nowMs: number) {
  assertAccess(state, actor, nowMs);
  requireRule(actor.role === 'manager', 'forbidden', 'Only an assigned verified adult manager can do this.');
}
function scopedMatch(state: CommunityState, actor: CommunityActor, id: string) {
  const match = state.matches.find(item => item.id === id);
  requireRule(match && match.teamId === actor.teamId && match.seasonId === actor.seasonId, 'forbidden', 'That match is outside this team and season.');
  return match;
}
function scopedPhoto(state: CommunityState, actor: CommunityActor, id: string) {
  const photo = state.photos.find(item => item.id === id);
  requireRule(photo && photo.teamId === actor.teamId && photo.seasonId === actor.seasonId, 'forbidden', 'That photo is outside this team and season.');
  return photo;
}
function currentPhoto(photo: CommunityPhoto, version?: number) {
  if (version !== undefined) requireRule(version === photo.currentRevision, 'conflict', 'This photo changed. Review its current revision before continuing.');
  requireRule(photo.removedAtMs === null, 'closed', 'This photo has been removed.');
  const revision = photo.revisions.find(item => item.version === photo.currentRevision);
  requireRule(revision, 'invalid', 'The photo revision is missing.');
  return revision;
}
function labelForPlayer(state: CommunityState, playerId: string): string {
  const membership = state.memberships.find(item => item.playerId === playerId);
  return state.accounts.find(item => item.id === membership?.accountId)?.label ?? 'Player';
}
function labelForAccount(state: CommunityState, accountId: string): string {
  return state.accounts.find(item => item.id === accountId)?.label ?? 'Team member';
}
function sharedAllowed(state: CommunityState, actor: CommunityActor, match: CommunityMatch): boolean {
  return actor.role === 'manager' || (state.synthetic && match.sharing === 'fictional_review_only');
}
function eligibleVoter(match: CommunityMatch, playerId: string | undefined): playerId is string {
  return Boolean(playerId && match.selectedPlayerIds.includes(playerId) && match.presentPlayerIds.includes(playerId));
}
function latestBallots(state: CommunityState, matchId: string): BallotRevision[] {
  const latest = new Map<string, BallotRevision>();
  for (const ballot of state.ballots) if (ballot.matchId === matchId) {
    const previous = latest.get(ballot.voterPlayerId);
    if (!previous || ballot.revision > previous.revision) latest.set(ballot.voterPlayerId, ballot);
  }
  return [...latest.values()];
}
function sealAward(state: CommunityState, match: CommunityMatch, nowMs: number) {
  requireRule(match.voteCutoffAtMs !== null && match.finalisationDeadlineAtMs !== null, 'invalid', 'The award timing evidence is missing.');
  const counts = new Map<string, number>();
  for (const ballot of latestBallots(state, match.id)) if ((ballot.receivedAtMs < match.voteCutoffAtMs ||
    (match.cutoffSource === 'manager_early_close' && ballot.receivedAtMs === match.voteCutoffAtMs)) &&
    eligibleVoter(match, ballot.voterPlayerId) && ballot.voterPlayerId !== ballot.candidatePlayerId && match.playedPlayerIds.includes(ballot.candidatePlayerId)) {
    counts.set(ballot.candidatePlayerId, (counts.get(ballot.candidatePlayerId) ?? 0) + 1);
  }
  const highest = Math.max(0, ...counts.values());
  const winners = [...counts].filter(([, count]) => count === highest).map(([id]) => id).sort();
  state.awards.push({ matchId: match.id, winnerPlayerIds: winners, result: highest === 0 ? 'no_valid_votes' : 'winners',
    voteCutoffAtMs: match.voteCutoffAtMs, finalisationDeadlineAtMs: match.finalisationDeadlineAtMs,
    finalisedAtMs: nowMs, deadlineMissed: nowMs > match.finalisationDeadlineAtMs });
}
function validateArt(art: FictionalArt, caption: string) {
  requireRule(['pitch', 'ball', 'cones'].includes(art), 'invalid', 'Choose a demo review illustration. Arbitrary URLs and raw image uploads are not supported here.');
  requireRule(typeof caption === 'string' && caption.trim().length <= 160, 'invalid', 'Keep the caption within 160 characters.');
}
export function defaultCommunityPreferences(): CommunityPreferences {
  return { schedule: true, match: true, awards: true, photos: true, quietStart: null, quietEnd: null };
}

export function applyCommunityCommand(state: CommunityState, actor: CommunityActor, command: CommunityCommand, nowMs: number): CommunityState {
  requireRule(validTime(nowMs), 'invalid', 'A valid receipt time is required.');
  account(state, actor);
  requireRule(command.id.trim(), 'invalid', 'A command identity is required.');
  const fingerprint = JSON.stringify([actor, command]);
  const prior = state.appliedCommands[command.id];
  if (prior !== undefined) {
    requireRule(prior === fingerprint, 'conflict', 'This command identity was already used for different content.');
    return state;
  }
  requireRule(command.expectedRevision === undefined || command.expectedRevision === state.revision, 'conflict', 'Community records changed. Reload the saved record before retrying.');
  const next: CommunityState = JSON.parse(JSON.stringify(state));
  const personal = ['preferences.changed', 'privacy.drafted', 'privacy.cancelled'].includes(command.type) ||
    (command.type === 'uploader.hidden' && !command.hidden);
  if (!personal && command.type !== 'invite.accepted') assertAccess(next, actor, nowMs);
  switch (command.type) {
    case 'invite.created': {
      requireRule(next.synthetic === true, 'forbidden', 'Review codes are available only in the local demo journey.');
      requireRule(actor.role !== 'spectator', 'forbidden', 'Spectators cannot invite other spectators.');
      const season = next.seasons.find(item => item.id === actor.seasonId && item.teamId === actor.teamId);
      requireRule(season, 'invalid', 'The team season is missing.');
      requireRule(validTime(command.expiresAtMs) && nowMs < command.expiresAtMs && command.expiresAtMs <= season.accessEndsAtMs, 'invalid', 'Choose an invitation expiry after now and before the season ends.');
      requireRule(command.reviewCode.trim().length >= 6 && !next.invitations.some(item => item.reviewCode === command.reviewCode || item.id === command.invitationId), 'invalid', 'The demo invitation identity/code must be unique.');
      next.invitations.push({ id: command.invitationId, teamId: actor.teamId, seasonId: actor.seasonId,
        inviterAccountId: actor.accountId, reviewCode: command.reviewCode, credential: { kind: 'fictional_review', version: 1, code: command.reviewCode }, createdAtMs: nowMs, expiresAtMs: command.expiresAtMs,
        acceptedBy: null, acceptedAtMs: null, revokedAtMs: null, reissuedFromInvitationId: null });
      break;
    }
    case 'invite.accepted': {
      requireRule(next.synthetic === true, 'forbidden', 'Review codes are available only in the local demo journey.');
      const invite = next.invitations.find(item => item.credential?.kind === 'fictional_review' && item.credential.code === command.reviewCode && item.reviewCode === command.reviewCode);
      requireRule(invite && invite.teamId === actor.teamId && invite.seasonId === actor.seasonId, 'forbidden', 'That invitation is not valid for this team and season.');
      requireRule(invite.revokedAtMs === null && invite.acceptedBy === null, 'closed', 'That invitation has already been accepted or revoked.');
      requireRule(nowMs < invite.expiresAtMs, 'expired', 'This invitation has expired. Ask for a new individual invitation.');
      const season = next.seasons.find(item => item.id === invite.seasonId && item.teamId === invite.teamId);
      requireRule(season && nowMs < season.accessEndsAtMs, 'expired', 'The invited season has ended. Renewal is explicit.');
      invite.acceptedBy = actor.accountId;
      invite.acceptedAtMs = nowMs;
      next.grants.push({ id: `grant:${invite.id}`, invitationId: invite.id, accountId: actor.accountId,
        teamId: invite.teamId, seasonId: invite.seasonId, startsAtMs: nowMs, expiresAtMs: season.accessEndsAtMs, revokedAtMs: null });
      break;
    }
    case 'invite.revoked': {
      assertManager(next, actor, nowMs);
      const invite = next.invitations.find(item => item.id === command.invitationId && item.teamId === actor.teamId && item.seasonId === actor.seasonId);
      requireRule(invite, 'forbidden', 'That invitation is outside this team and season.');
      invite.revokedAtMs = nowMs;
      for (const grant of next.grants) if (grant.invitationId === invite.id) grant.revokedAtMs = nowMs;
      break;
    }
    case 'grant.revoked': {
      assertManager(next, actor, nowMs);
      const grant = next.grants.find(item => item.id === command.grantId && item.teamId === actor.teamId && item.seasonId === actor.seasonId);
      requireRule(grant, 'forbidden', 'That grant is outside this team and season.');
      grant.revokedAtMs = nowMs;
      break;
    }
    case 'match.registered': {
      assertManager(next, actor, nowMs);
      const match = command.match;
      requireRule(match.teamId === actor.teamId && match.seasonId === actor.seasonId, 'forbidden', 'A match must belong to the active team and season.');
      requireRule(!next.matches.some(item => item.id === match.id), 'conflict', 'This match is already registered. A corrected finish requires an audited exception process and never reopens an award.');
      requireRule(validTime(match.playedAtMs) && unique(match.selectedPlayerIds) && unique(match.presentPlayerIds) && unique(match.playedPlayerIds), 'invalid', 'The match evidence is invalid.');
      requireRule(match.presentPlayerIds.every(id => match.selectedPlayerIds.includes(id)) && match.playedPlayerIds.every(id => match.presentPlayerIds.includes(id)), 'invalid', 'Played and present evidence must belong to the selected squad.');
      requireRule(match.selectedPlayerIds.every(id => next.memberships.some(member => member.playerId === id && member.teamId === actor.teamId && member.seasonId === actor.seasonId)), 'invalid', 'Every selected player needs a membership in this team and season.');
      requireRule(match.actualFullTimeAtMs === null || (validTime(match.actualFullTimeAtMs) && match.actualFullTimeAtMs <= nowMs), 'invalid', 'Actual full time cannot be in the future.');
      next.matches.push({ ...match, voteCutoffAtMs: null, cutoffSource: 'unresolved',
        finalisationDeadlineAtMs: match.actualFullTimeAtMs === null ? null : match.actualFullTimeAtMs + 3_600_000 });
      break;
    }
    case 'award.cutoffConfigured': {
      assertManager(next, actor, nowMs);
      const match = scopedMatch(next, actor, command.matchId);
      requireRule(match.actualFullTimeAtMs !== null && match.finishQuality === 'trusted', 'policy_needed', 'Trustworthy original full-time evidence is required first.');
      requireRule(!next.awards.some(item => item.matchId === match.id) && match.cutoffSource === 'unresolved', 'closed', 'A configured/closed award cannot be reopened by changing its cutoff.');
      requireRule(Number.isSafeInteger(command.minutesAfterFullTime) && command.minutesAfterFullTime > 0 && command.minutesAfterFullTime < 60, 'invalid', 'Choose an explicit demo cutoff from 1 to 59 minutes. This does not approve a production default.');
      match.voteCutoffAtMs = match.actualFullTimeAtMs + command.minutesAfterFullTime * 60_000;
      match.cutoffSource = 'explicit_fictional_setting';
      break;
    }
    case 'ballot.cast': {
      const match = scopedMatch(next, actor, command.matchId);
      requireRule(actor.role === 'player' && eligibleVoter(match, actor.playerId), 'forbidden', 'Only a present selected player may cast their own ballot. Parent use shares the same account and vote.');
      requireRule(sharedAllowed(next, actor, match), 'policy_needed', 'This match award is not shared under the current competition policy.');
      requireRule(match.finishQuality === 'trusted', 'policy_needed', 'The finish/eligibility evidence requires review before voting.');
      requireRule(!next.awards.some(item => item.matchId === match.id), 'closed', 'Voting is closed.');
      if (match.actualFullTimeAtMs !== null) {
        requireRule(match.voteCutoffAtMs !== null, 'policy_needed', 'The automatic ballot cutoff is unresolved (Q15). A manager must set an explicit demo cutoff or close deliberately.');
        requireRule(nowMs < match.voteCutoffAtMs && nowMs < match.finalisationDeadlineAtMs!, 'closed', 'Voting is closed at its original cutoff, even if finalisation is delayed.');
      }
      requireRule(command.candidatePlayerId !== actor.playerId && match.playedPlayerIds.includes(command.candidatePlayerId), 'invalid', 'Choose a teammate who actually played. Self-votes are not permitted.');
      const revisions = next.ballots.filter(item => item.matchId === match.id && item.voterPlayerId === actor.playerId);
      next.ballots.push({ id: command.id, matchId: match.id, voterAccountId: actor.accountId, voterPlayerId: actor.playerId,
        candidatePlayerId: command.candidatePlayerId, receivedAtMs: nowMs, revision: revisions.length + 1 });
      break;
    }
    case 'award.finalised': {
      assertManager(next, actor, nowMs);
      const match = scopedMatch(next, actor, command.matchId);
      requireRule(match.actualFullTimeAtMs !== null && match.finalisationDeadlineAtMs !== null && nowMs >= match.actualFullTimeAtMs, 'invalid', 'A manager may close only after actual full time.');
      requireRule(match.finishQuality === 'trusted', 'policy_needed', 'Contradictory or uncertain finish/eligibility evidence blocks finalisation. Retain it for audited review.');
      requireRule(!next.awards.some(item => item.matchId === match.id), 'closed', 'This final award is already sealed. Report edits never reopen it.');
      if (match.voteCutoffAtMs === null || nowMs < match.voteCutoffAtMs) {
        match.voteCutoffAtMs = Math.min(nowMs, match.finalisationDeadlineAtMs);
        match.cutoffSource = 'manager_early_close';
      }
      sealAward(next, match, nowMs);
      break;
    }
    case 'photo.submitted': {
      requireRule(actor.role !== 'spectator', 'forbidden', 'Spectators cannot upload photos.');
      const match = scopedMatch(next, actor, command.matchId);
      requireRule(command.policyAcknowledged === true, 'invalid', 'Review the photo policy before submission.');
      validateArt(command.art, command.caption);
      requireRule(!next.photos.some(item => item.id === command.photoId), 'conflict', 'That photo identity is already in use.');
      next.photos.push({ id: command.photoId, matchId: match.id, teamId: match.teamId, seasonId: match.seasonId,
        uploaderAccountId: actor.accountId, uploaderRole: actor.role, currentRevision: 1, publishedRevision: null, removedAtMs: null,
        revisions: [{ version: 1, art: command.art, caption: command.caption.trim(), status: actor.role === 'player' ? 'pending' : 'draft',
          createdAtMs: nowMs, reviewedAtMs: null, reviewerAccountId: null, rejectionReason: null, processing: 'synthetic_derivative_ready' }] });
      break;
    }
    case 'photo.revised': {
      const photo = scopedPhoto(next, actor, command.photoId);
      currentPhoto(photo, command.sourceRevision);
      requireRule(photo.uploaderAccountId === actor.accountId && actor.role === photo.uploaderRole, 'forbidden', 'Only the uploader may revise their submission.');
      requireRule(command.policyAcknowledged === true, 'invalid', 'Review the photo policy before resubmission.');
      validateArt(command.art, command.caption);
      photo.currentRevision += 1;
      photo.revisions.push({ version: photo.currentRevision, art: command.art, caption: command.caption.trim(),
        status: actor.role === 'player' ? 'pending' : 'draft', createdAtMs: nowMs, reviewedAtMs: null,
        reviewerAccountId: null, rejectionReason: null, processing: 'synthetic_derivative_ready' });
      break;
    }
    case 'photo.reviewed': {
      assertManager(next, actor, nowMs);
      const photo = scopedPhoto(next, actor, command.photoId);
      const revision = currentPhoto(photo, command.sourceRevision);
      requireRule(photo.uploaderRole === 'player' && revision.status === 'pending', 'invalid', 'Only a current pending player submission enters this review queue.');
      requireRule(photo.uploaderAccountId !== actor.accountId, 'forbidden', 'A conflicted reviewer cannot approve their own submission.');
      requireRule(command.decision !== 'reject' || Boolean(command.reason?.trim()), 'invalid', 'Give a private reason for rejection.');
      revision.status = command.decision === 'approve' ? 'published' : 'rejected';
      revision.reviewedAtMs = nowMs;
      revision.reviewerAccountId = actor.accountId;
      revision.rejectionReason = command.decision === 'reject' ? command.reason!.trim().slice(0, 240) : null;
      if (command.decision === 'approve') photo.publishedRevision = revision.version;
      break;
    }
    case 'photo.published': {
      assertManager(next, actor, nowMs);
      const photo = scopedPhoto(next, actor, command.photoId);
      const revision = currentPhoto(photo, command.sourceRevision);
      requireRule(photo.uploaderAccountId === actor.accountId && photo.uploaderRole === 'manager' && revision.status === 'draft', 'forbidden', 'Managers explicitly publish their own current draft; player photos need review.');
      requireRule(command.policyAcknowledged === true, 'invalid', 'Review the exact photo and content policy before Publish.');
      revision.status = 'published';
      revision.reviewedAtMs = nowMs;
      revision.reviewerAccountId = actor.accountId;
      photo.publishedRevision = revision.version;
      break;
    }
    case 'photo.withdrawn': {
      const photo = scopedPhoto(next, actor, command.photoId);
      const revision = currentPhoto(photo, command.sourceRevision);
      requireRule(photo.uploaderAccountId === actor.accountId, 'forbidden', 'Only the uploader can withdraw a submission.');
      requireRule(revision.status === 'pending' || revision.status === 'draft', 'closed', 'Only an unpublished submission can be withdrawn.');
      revision.status = 'withdrawn';
      break;
    }
    case 'photo.removed': {
      assertManager(next, actor, nowMs);
      const photo = scopedPhoto(next, actor, command.photoId);
      currentPhoto(photo);
      photo.removedAtMs = nowMs;
      photo.publishedRevision = null;
      break;
    }
    case 'concern.submitted': {
      requireRule(!next.concerns.some(item => item.id === command.concernId), 'conflict', 'That concern reference is already used.');
      let uploaderAccountId: string;
      let photoRevision: number | null = null;
      if (command.targetType === 'photo') {
        const photo = scopedPhoto(next, actor, command.targetId);
        const decision = authorizeCommunityMedia(next, actor, photo.id, nowMs);
        requireRule(decision.allowed, 'forbidden', 'Only a photo you may view can be reported here.');
        photoRevision = decision.revision.version;
        uploaderAccountId = photo.uploaderAccountId;
      } else {
        requireRule(next.photos.some(photo => photo.uploaderAccountId === command.targetId && authorizeCommunityMedia(next, actor, photo.id, nowMs).allowed), 'forbidden', 'Report an uploader through a photo you may view.');
        uploaderAccountId = command.targetId;
      }
      requireRule(command.explanation.length <= 500, 'invalid', 'Keep the explanation under 500 characters and avoid unnecessary personal details.');
      next.concerns.push({ id: command.concernId, teamId: actor.teamId, seasonId: actor.seasonId,
        reporterAccountId: actor.accountId, targetType: command.targetType, targetId: command.targetId, photoRevision, uploaderAccountId,
        category: command.category, explanation: command.explanation.trim(),
        status: next.memberships.some(item => item.accountId === uploaderAccountId && item.role === 'manager' && item.active && item.teamId === actor.teamId)
          ? 'escalation_required' : 'submitted', createdAtMs: nowMs });
      break;
    }
    case 'concern.updated': {
      assertManager(next, actor, nowMs);
      const concern = next.concerns.find(item => item.id === command.concernId && item.teamId === actor.teamId && item.seasonId === actor.seasonId);
      requireRule(concern && concern.uploaderAccountId !== actor.accountId && concern.status !== 'escalation_required', 'forbidden', 'A conflicted manager cannot review this concern. Operator escalation is required.');
      concern.status = command.status;
      break;
    }
    case 'uploader.hidden': {
      requireRule(command.uploaderAccountId !== actor.accountId && next.accounts.some(item => item.id === command.uploaderAccountId), 'invalid', 'Choose a different uploader.');
      const alreadyHidden = next.hiddenUploaders.some(item => item.accountId === actor.accountId && item.uploaderAccountId === command.uploaderAccountId);
      requireRule(alreadyHidden || (command.hidden && next.photos.some(photo => photo.uploaderAccountId === command.uploaderAccountId &&
        authorizeCommunityMedia(next, actor, photo.id, nowMs).allowed)), 'forbidden', 'Choose an uploader through a published photo you may view.');
      next.hiddenUploaders = next.hiddenUploaders.filter(item => !(item.accountId === actor.accountId && item.uploaderAccountId === command.uploaderAccountId));
      if (command.hidden) next.hiddenUploaders.push({ accountId: actor.accountId, uploaderAccountId: command.uploaderAccountId });
      break;
    }
    case 'preferences.changed': {
      const preferences = command.preferences;
      requireRule(['schedule', 'match', 'awards', 'photos'].every(key => typeof preferences[key as keyof CommunityPreferences] === 'boolean'), 'invalid', 'Notification choices must be on or off.');
      const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
      requireRule((preferences.quietStart === null && preferences.quietEnd === null) ||
        (typeof preferences.quietStart === 'string' && typeof preferences.quietEnd === 'string' && time.test(preferences.quietStart) && time.test(preferences.quietEnd)), 'invalid', 'Use HH:MM for both quiet-hour boundaries, or leave both empty.');
      requireRule(preferences.quietStart === null || preferences.quietStart !== preferences.quietEnd, 'invalid', 'Quiet hours need distinct boundaries; use channel switches to pause all day.');
      next.preferences[actor.accountId] = { ...preferences };
      break;
    }
    case 'privacy.drafted': {
      requireRule(!next.privacyRequests.some(item => item.id === command.requestId), 'conflict', 'That request reference is already used.');
      next.privacyRequests.push({ id: command.requestId, accountId: actor.accountId, type: command.requestType,
        status: 'verification_needed', createdAtMs: nowMs, delivery: 'local_draft' });
      break;
    }
    case 'privacy.cancelled': {
      const request = next.privacyRequests.find(item => item.id === command.requestId && item.accountId === actor.accountId);
      requireRule(request, 'forbidden', 'That request belongs to another account.');
      requireRule(request.status === 'verification_needed', 'closed', 'That draft is already cancelled.');
      request.status = 'cancelled';
      break;
    }
    default: {
      const exhaustive: never = command;
      throw new CommunityError('invalid', `Unsupported community action: ${String((exhaustive as { type?: unknown }).type)}`);
    }
  }
  next.revision += 1;
  next.appliedCommands[command.id] = fingerprint;
  // No ballot selection, private rejection reason or concern text enters this audit.
  next.audit.push({ id: command.id, actorAccountId: actor.accountId, action: command.type, atMs: nowMs, origin: 'account' });
  return next;
}

export type VerifiedInvitationCommand = CommandBase &
  (
    | {
        type: "invite.issued";
        invitationId: string;
        tokenHash: string;
        expiresAtMs: number;
      }
    | {
        type: "invite.reissued";
        sourceInvitationId: string;
        invitationId: string;
        tokenHash: string;
        expiresAtMs: number;
      }
    | {
        type: "invite.accepted_verified";
        invitationId: string;
        tokenHash: string;
      }
  );
function validInvitationIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 200 &&
    !/[^A-Za-z0-9_.:-]/.test(value)
  );
}
/** A verified service must generate raw entropy and hash it before invoking this function. */
export function applyVerifiedInvitationCommand(
  state: CommunityState,
  actor: CommunityActor,
  command: VerifiedInvitationCommand,
  nowMs: number,
): CommunityState {
  requireRule(
    validTime(nowMs),
    "invalid",
    "A valid invitation receipt time is required.",
  );
  account(state, actor);
  const fields: Record<VerifiedInvitationCommand["type"], string[]> = {
    "invite.issued": ["invitationId", "tokenHash", "expiresAtMs"],
    "invite.reissued": [
      "sourceInvitationId",
      "invitationId",
      "tokenHash",
      "expiresAtMs",
    ],
    "invite.accepted_verified": ["invitationId", "tokenHash"],
  };
  requireRule(
    command && Object.hasOwn(fields, command.type),
    "invalid",
    "The internal invitation operation is unavailable.",
  );
  requireRule(
    Object.keys(command).every((key) =>
      ["id", "type", "expectedRevision", ...fields[command.type]].includes(key),
    ) &&
      Object.keys(actor).every((key) =>
        ["role", "accountId", "teamId", "seasonId", "playerId"].includes(key),
      ),
    "invalid",
    "Unexpected invitation data is not retained.",
  );
  requireRule(
    validInvitationIdentity(command.id) &&
      validInvitationIdentity(command.invitationId) &&
      isInvitationTokenHash(command.tokenHash) &&
      (command.expectedRevision === undefined ||
        validTime(command.expectedRevision)),
    "invalid",
    "The invitation identity and verifier must be canonical.",
  );
  const fingerprint = JSON.stringify([actor, command]);
  const prior = state.appliedCommands[command.id];
  if (prior !== undefined) {
    requireRule(
      prior === fingerprint,
      "conflict",
      "This command identity was already used for different content.",
    );
    return state;
  }
  requireRule(
    command.expectedRevision === undefined ||
      command.expectedRevision === state.revision,
    "conflict",
    "Community records changed. Reload before retrying.",
  );
  const next: CommunityState = JSON.parse(JSON.stringify(state));
  if (command.type === "invite.accepted_verified") {
    const invite = pendingInvitation(next, command.tokenHash, nowMs, actor);
    requireRule(
      invite && invite.id === command.invitationId,
      "forbidden",
      "The invitation is unavailable for this team and season.",
    );
    const saved = next.invitations.find((item) => item.id === invite.id)!;
    const season = next.seasons.find(
      (item) => item.id === invite.seasonId && item.teamId === invite.teamId,
    )!;
    saved.acceptedBy = actor.accountId;
    saved.acceptedAtMs = nowMs;
    requireRule(
      !next.grants.some(
        (grant) =>
          grant.id === `grant:${invite.id}` || grant.invitationId === invite.id,
      ),
      "conflict",
      "This invitation already has a retained grant.",
    );
    next.grants.push({
      id: `grant:${invite.id}`,
      invitationId: invite.id,
      accountId: actor.accountId,
      teamId: invite.teamId,
      seasonId: invite.seasonId,
      startsAtMs: nowMs,
      expiresAtMs: season.accessEndsAtMs,
      revokedAtMs: null,
    });
  } else {
    assertAccess(next, actor, nowMs);
    requireRule(
      actor.role === "manager" || actor.role === "player",
      "forbidden",
      "Only a current player or manager can issue invitations.",
    );
    const season = next.seasons.find(
      (item) => item.id === actor.seasonId && item.teamId === actor.teamId,
    );
    requireRule(
      season && nowMs < season.accessEndsAtMs,
      "expired",
      "The invited season has ended. Renewal is explicit.",
    );
    requireRule(
      validTime(command.expiresAtMs) &&
        nowMs < command.expiresAtMs &&
        command.expiresAtMs - nowMs <= 48 * 3_600_000 &&
        command.expiresAtMs <= season.accessEndsAtMs,
      "invalid",
      "Choose an explicit invitation expiry within 48 hours and the current season.",
    );
    requireRule(
      !next.invitations.some(
        (item) =>
          item.id === command.invitationId ||
          (item.credential?.kind === "sha256" &&
            item.credential.tokenHash === command.tokenHash),
      ),
      "conflict",
      "Invitation identities and verifiers cannot be reused.",
    );
    let sourceId: string | null = null;
    if (command.type === "invite.reissued") {
      requireRule(
        validInvitationIdentity(command.sourceInvitationId),
        "invalid",
        "The source invitation identity is unavailable.",
      );
      const source = next.invitations.find(
        (item) =>
          item.id === command.sourceInvitationId &&
          item.teamId === actor.teamId &&
          item.seasonId === actor.seasonId,
      );
      requireRule(
        source && source.acceptedBy === null && source.acceptedAtMs === null,
        "closed",
        "An accepted invitation or grant cannot be replaced by reissue.",
      );
      requireRule(
        source.credential?.kind === "sha256" ||
          source.credential?.kind === "legacy_retired",
        "closed",
        "Retire legacy invitation credentials before issuing their replacement.",
      );
      requireRule(
        actor.role === "manager" || source.inviterAccountId === actor.accountId,
        "forbidden",
        "Only the original current inviter or a current manager can reissue this pending invitation.",
      );
      requireRule(
        source.revokedAtMs === null ||
          (source.credential?.kind === "legacy_retired" &&
            source.credential.requiresReissue),
        "closed",
        "A revoked invitation cannot be reissued.",
      );
      requireRule(
        !next.invitations.some(
          (item) => item.reissuedFromInvitationId === source.id,
        ),
        "closed",
        "This invitation already has a replacement. Reissue the retained replacement explicitly.",
      );
      source.revokedAtMs ??= nowMs;
      if (source.credential?.kind === "legacy_retired")
        source.credential.requiresReissue = false;
      sourceId = source.id;
    }
    next.invitations.push({
      id: command.invitationId,
      teamId: actor.teamId,
      seasonId: actor.seasonId,
      inviterAccountId: actor.accountId,
      credential: { kind: "sha256", version: 1, tokenHash: command.tokenHash },
      createdAtMs: nowMs,
      expiresAtMs: command.expiresAtMs,
      acceptedBy: null,
      acceptedAtMs: null,
      revokedAtMs: null,
      reissuedFromInvitationId: sourceId,
    });
  }
  next.revision += 1;
  next.appliedCommands[command.id] = fingerprint;
  next.audit.push({
    id: command.id,
    actorAccountId: actor.accountId,
    action: command.type,
    atMs: nowMs,
    origin: "account",
  });
  return next;
}

/** Purpose-scoped worker operation: never impersonates a manager or chooses Q15. */
export function finalizeDueCommunityAwards(state: CommunityState, nowMs: number): CommunityState {
  requireRule(validTime(nowMs), 'invalid', 'A valid worker receipt time is required.');
  const due = state.matches.filter(match => match.finishQuality === 'trusted' && match.actualFullTimeAtMs !== null &&
    match.voteCutoffAtMs !== null && match.cutoffSource !== 'unresolved' && nowMs >= match.voteCutoffAtMs &&
    !state.awards.some(award => award.matchId === match.id));
  if (due.length === 0) return state;
  const next: CommunityState = JSON.parse(JSON.stringify(state));
  for (const source of due) {
    const match = next.matches.find(item => item.id === source.id)!;
    sealAward(next, match, nowMs);
    next.audit.push({ id: `worker:award-finalise:${match.id}:${match.voteCutoffAtMs}`, actorAccountId: null,
      action: 'award.finalised', atMs: nowMs, origin: 'award_worker' });
  }
  next.revision += 1;
  return next;
}

export type CommunityMediaDecision = { allowed: true; revision: PhotoRevision; photo: Pick<CommunityPhoto, 'id' | 'matchId' | 'uploaderAccountId'>; cacheControl: 'private, no-store' } | { allowed: false; reason: string };
/** Apply the same access decision to display and thumbnail delivery on every request. */
export function authorizeCommunityMedia(state: CommunityState, actor: CommunityActor, photoId: string, nowMs: number, mode: 'gallery' | 'own' | 'review' = 'gallery', requestedRevision?: number): CommunityMediaDecision {
  if (!communityCanAccess(state, actor, nowMs)) return { allowed: false, reason: 'Access unavailable or expired' };
  const photo = state.photos.find(item => item.id === photoId && item.teamId === actor.teamId && item.seasonId === actor.seasonId);
  if (!photo || photo.removedAtMs !== null) return { allowed: false, reason: 'Photo unavailable' };
  const match = state.matches.find(item => item.id === photo.matchId);
  if (!match) return { allowed: false, reason: 'Photo context unavailable' };
  const number = mode === 'gallery' ? photo.publishedRevision : photo.currentRevision;
  if (number === null || (requestedRevision !== undefined && number !== requestedRevision)) return { allowed: false, reason: 'Photo revision is not available to this audience' };
  const revision = photo.revisions.find(item => item.version === number);
  if (!revision) return { allowed: false, reason: 'Photo revision unavailable' };
  if (mode === 'gallery') {
    if (revision.status !== 'published' || !sharedAllowed(state, actor, match)) return { allowed: false, reason: 'Publication policy does not permit this photo' };
    if (state.hiddenUploaders.some(item => item.accountId === actor.accountId && item.uploaderAccountId === photo.uploaderAccountId)) return { allowed: false, reason: 'Uploader hidden for this gallery' };
  } else if (mode === 'own') {
    if (photo.uploaderAccountId !== actor.accountId || !['pending', 'draft', 'published'].includes(revision.status)) return { allowed: false, reason: 'This submission is private' };
  } else if (actor.role !== 'manager' || photo.uploaderRole !== 'player' || revision.status !== 'pending') return { allowed: false, reason: 'Review permission required' };
  return { allowed: true, revision: { ...revision }, photo: { id: photo.id, matchId: photo.matchId, uploaderAccountId: photo.uploaderAccountId }, cacheControl: 'private, no-store' };
}

export function getOwnCommunityBallot(state: CommunityState, actor: CommunityActor, matchId: string, nowMs: number): BallotRevision | null {
  assertAccess(state, actor, nowMs);
  scopedMatch(state, actor, matchId);
  requireRule(actor.role === 'player' && actor.playerId, 'forbidden', 'Only the player account can read its own current choice. Managers cannot inspect ballots.');
  const ballot = latestBallots(state, matchId).find(item => item.voterAccountId === actor.accountId && item.voterPlayerId === actor.playerId);
  return ballot ? { ...ballot } : null;
}
export function ownCommunityExport(state: CommunityState, actor: CommunityActor) {
  const person = account(state, actor);
  return {
    kind: 'fictional_local_own_account_export' as const,
    account: { ...person },
    memberships: state.memberships.filter(item => item.accountId === actor.accountId).map(item => ({ ...item })),
    spectatorGrants: state.grants.filter(item => item.accountId === actor.accountId).map(item => ({ ...item })),
    ownBallots: state.ballots.filter(item => item.voterAccountId === actor.accountId).map(item => ({ ...item })),
    ownSubmissions: state.photos.filter(item => item.uploaderAccountId === actor.accountId).map(item => ({ ...item, revisions: item.revisions.map(revision => ({ ...revision })) })),
    ownConcerns: state.concerns.filter(item => item.reporterAccountId === actor.accountId).map(item => ({ ...item })),
    preferences: { ...(state.preferences[actor.accountId] ?? defaultCommunityPreferences()) },
    requests: state.privacyRequests.filter(item => item.accountId === actor.accountId).map(item => ({ ...item })),
  };
}
export function getCommunityView(state: CommunityState, actor: CommunityActor, nowMs: number) {
  const allowed = communityCanAccess(state, actor, nowMs);
  const season = state.seasons.find(item => item.id === actor.seasonId && item.teamId === actor.teamId);
  const person = account(state, actor);
  const scoped = <T extends { teamId: string; seasonId: string }>(items: T[]) => items.filter(item => item.teamId === actor.teamId && item.seasonId === actor.seasonId);
  const gallery = allowed ? scoped(state.photos).flatMap(photo => {
    const decision = authorizeCommunityMedia(state, actor, photo.id, nowMs);
    if (!decision.allowed) return [];
    const match = state.matches.find(item => item.id === photo.matchId)!;
    return [{ id: photo.id, matchId: photo.matchId, matchLabel: match.label, playedAtMs: match.playedAtMs,
      uploaderAccountId: photo.uploaderAccountId, uploaderLabel: labelForAccount(state, photo.uploaderAccountId),
      version: decision.revision.version, art: decision.revision.art, caption: decision.revision.caption }];
  }).sort((a, b) => b.playedAtMs - a.playedAtMs || a.id.localeCompare(b.id)) : [];
  return {
    allowed,
    accessMessage: allowed ? null : 'Team access has expired or is unavailable. Ask for a new invitation; unrelated account memberships are unchanged.',
    teamLabel: season?.teamLabel ?? 'Team', seasonLabel: season?.label ?? 'Season', accountLabel: person.label,
    memberships: state.memberships.filter(item => item.accountId === actor.accountId).map(item => ({ ...item })),
    preferences: { ...(state.preferences[actor.accountId] ?? defaultCommunityPreferences()) },
    invitations: allowed && actor.role !== 'spectator' ? scoped(state.invitations).filter(item => actor.role === 'manager' || item.inviterAccountId === actor.accountId).map(item => ({ ...publicInvitation(item, nowMs), reviewCode: item.credential?.kind === 'fictional_review' && state.synthetic === true ? item.credential.code : undefined })) : [],
    grants: allowed && actor.role === 'manager' ? scoped(state.grants).map(item => ({ ...item, accountLabel: labelForAccount(state, item.accountId) })) : [],
    matches: allowed ? scoped(state.matches).map(match => {
      const share = sharedAllowed(state, actor, match);
      const award = state.awards.find(item => item.matchId === match.id);
      const own = actor.role === 'player' ? latestBallots(state, match.id).find(item => item.voterAccountId === actor.accountId && item.voterPlayerId === actor.playerId) : null;
      const mayVote = share && actor.role === 'player' && eligibleVoter(match, actor.playerId) && match.finishQuality === 'trusted' && !award &&
        (match.actualFullTimeAtMs === null || (match.voteCutoffAtMs !== null && nowMs < match.voteCutoffAtMs && nowMs < match.finalisationDeadlineAtMs!));
      return { id: match.id, label: share ? match.label : 'Match context withheld by competition policy', playedAtMs: share ? match.playedAtMs : null,
        sharingAllowed: share, fullTimeAtMs: share ? match.actualFullTimeAtMs : null, finishQuality: match.finishQuality,
        cutoffAtMs: share ? match.voteCutoffAtMs : null, cutoffSource: match.cutoffSource,
        deadlineAtMs: share ? match.finalisationDeadlineAtMs : null, mayVote, ownChoice: own?.candidatePlayerId ?? null,
        candidates: mayVote ? match.playedPlayerIds.filter(id => id !== actor.playerId).map(id => ({ id, label: labelForPlayer(state, id) })) : [],
        award: share && award ? { ...award, winnerLabels: award.winnerPlayerIds.map(id => labelForPlayer(state, id)) } : null };
    }) : [],
    gallery,
    submissions: allowed && actor.role !== 'spectator' ? scoped(state.photos).filter(item => item.uploaderAccountId === actor.accountId).map(photo => {
      const revision = photo.revisions.find(item => item.version === photo.currentRevision)!;
      return { id: photo.id, matchId: photo.matchId, version: photo.currentRevision, status: photo.removedAtMs !== null ? 'removed' as const : revision.status,
        art: photo.removedAtMs !== null || ['rejected', 'withdrawn'].includes(revision.status) ? null : revision.art, caption: revision.caption, rejectionReason: revision.rejectionReason,
        previousPublishedVersion: photo.publishedRevision !== photo.currentRevision ? photo.publishedRevision : null };
    }) : [],
    reviewQueue: allowed && actor.role === 'manager' ? scoped(state.photos).flatMap(photo => {
      const decision = authorizeCommunityMedia(state, actor, photo.id, nowMs, 'review');
      return decision.allowed ? [{ id: photo.id, version: decision.revision.version, art: decision.revision.art, caption: decision.revision.caption,
        uploaderLabel: labelForAccount(state, photo.uploaderAccountId) }] : [];
    }) : [],
    ownConcerns: state.concerns.filter(item => item.reporterAccountId === actor.accountId).map(item => ({ id: item.id, status: item.status, targetType: item.targetType, createdAtMs: item.createdAtMs })),
    reviewConcerns: allowed && actor.role === 'manager' ? scoped(state.concerns).filter(item => item.uploaderAccountId !== actor.accountId && item.status !== 'escalation_required').map(item =>
      ({ id: item.id, targetType: item.targetType, targetId: item.targetId, category: item.category, explanation: item.explanation, status: item.status })) : [],
    hiddenUploaders: state.hiddenUploaders.filter(item => item.accountId === actor.accountId).map(item => ({ id: item.uploaderAccountId, label: labelForAccount(state, item.uploaderAccountId) })),
    privacyRequests: state.privacyRequests.filter(item => item.accountId === actor.accountId).map(item => ({ ...item })),
  };
}

export function createCommunityState(nowMs = Date.now(), options: { demoScenario?: boolean } = {}): CommunityState {
  const teamId = 'synthetic-roma-u10';
  const seasonId = 'synthetic-season-2026-27';
  const playerIds = Array.from({ length: 13 }, (_, index) => `synthetic-player-${String(index + 1).padStart(2, '0')}`);
  const accounts: CommunityAccount[] = [
    { id: 'synthetic-account-manager', label: demoAccountLabels['synthetic-account-manager'], classification: 'adult_individual', adultVerified: true },
    ...playerIds.map((id, index): CommunityAccount => ({ id: `synthetic-account-player-${String(index + 1).padStart(2, '0')}`, label: romaFixture.players[index].displayName, classification: 'child_shared', adultVerified: false })),
    { id: 'synthetic-account-spectator', label: demoAccountLabels['synthetic-account-spectator'], classification: 'spectator', adultVerified: false },
    { id: 'synthetic-account-invitee', label: demoAccountLabels['synthetic-account-invitee'], classification: 'spectator', adultVerified: false },
  ];
  const memberships: CommunityMembership[] = [{ accountId: accounts[0].id, teamId, seasonId, role: 'manager', active: true },
    ...playerIds.map((playerId, index): CommunityMembership => ({ accountId: accounts[index + 1].id, playerId, teamId, seasonId, role: 'player', active: true }))];
  const fullTime = Math.max(0, nowMs - 600_000);
  const match: CommunityMatch = { id: 'synthetic-community-willow', teamId, seasonId, label: 'Roma v Willow FC · Practice match',
    playedAtMs: Math.max(0, fullTime - 3_600_000), selectedPlayerIds: playerIds.slice(0, 9), presentPlayerIds: playerIds.slice(0, 9), playedPlayerIds: playerIds.slice(0, 9),
    actualFullTimeAtMs: fullTime, finishQuality: 'trusted', voteCutoffAtMs: null, cutoffSource: 'unresolved', finalisationDeadlineAtMs: fullTime + 3_600_000,
    sharing: 'fictional_review_only', policyVersion: 1 };
  let state: CommunityState = { schemaVersion: 1, synthetic: true, revision: 0, accounts, memberships,
    seasons: [{ id: seasonId, teamId, label: '2026/27', teamLabel: 'Roma U10', accessEndsAtMs: Date.parse('2027-08-31T23:00:00Z') }],
    invitations: [], grants: [{ id: 'synthetic-demo-grant', invitationId: 'synthetic-seeded-invitation', accountId: 'synthetic-account-spectator', teamId, seasonId,
      startsAtMs: Math.max(0, nowMs - 86_400_000), expiresAtMs: Date.parse('2027-08-31T23:00:00Z'), revokedAtMs: null }],
    matches: [match], ballots: [], awards: [], photos: [], concerns: [], hiddenUploaders: [], preferences: {}, privacyRequests: [], audit: [], appliedCommands: {} };
  // A deliberately public sample illustration, plus one private player item,
  // makes both the gallery and moderation journey reviewable without child photos.
  state.photos.push({ id: 'synthetic-published-pitch', matchId: match.id, teamId, seasonId, uploaderAccountId: 'synthetic-account-manager', uploaderRole: 'manager',
    currentRevision: 1, publishedRevision: 1, removedAtMs: null, revisions: [{ version: 1, art: 'pitch', caption: 'Matchday at Rovers Sports Ground · illustration',
      status: 'published', createdAtMs: fullTime, reviewedAtMs: fullTime, reviewerAccountId: 'synthetic-account-manager', rejectionReason: null, processing: 'synthetic_derivative_ready' }] });
  state.photos.push({ id: 'synthetic-pending-ball', matchId: match.id, teamId, seasonId, uploaderAccountId: 'synthetic-account-player-01', uploaderRole: 'player',
    currentRevision: 1, publishedRevision: null, removedAtMs: null, revisions: [{ version: 1, art: 'ball', caption: 'Saturday football · illustration awaiting review',
      status: 'pending', createdAtMs: fullTime, reviewedAtMs: null, reviewerAccountId: null, rejectionReason: null, processing: 'synthetic_derivative_ready' }] });
  if (options.demoScenario) {
    state.matches = createDemoCompletedMatches().map((completed): CommunityMatch => ({
      id: completed.config.matchId, teamId, seasonId,
      label: `Roma ${completed.config.fixture!.homeAway === 'home' ? 'v' : 'at'} ${completed.config.fixture!.opponent}`,
      playedAtMs: Date.parse(`${completed.config.fixture!.playedDate}T${completed.config.fixture!.kickoff}:00+01:00`),
      selectedPlayerIds: [...completed.config.selectedPlayerIds], presentPlayerIds: [...completed.config.selectedPlayerIds],
      playedPlayerIds: [...completed.config.selectedPlayerIds], actualFullTimeAtMs: completed.completedAtMs,
      // Explicitly generated timing evidence for this isolated demo only.
      finishQuality: 'trusted', voteCutoffAtMs: completed.completedAtMs! + 45 * 60_000,
      cutoffSource: 'explicit_fictional_setting', finalisationDeadlineAtMs: completed.completedAtMs! + 60 * 60_000,
      sharing: 'fictional_review_only', policyVersion: 1,
    })).sort((left, right) => right.playedAtMs - left.playedAtMs);
    const latest = state.matches[0];
    state.photos = state.photos.map(photo => ({ ...photo, matchId: latest.id,
      revisions: photo.revisions.map(revision => ({ ...revision, createdAtMs: latest.actualFullTimeAtMs! + 5 * 60_000,
        reviewedAtMs: revision.reviewedAtMs === null ? null : latest.actualFullTimeAtMs! + 10 * 60_000 })) }));
    // These sample ballots were submitted during the recorded historical window;
    // sealed results do not reopen voting just because the demo is restarted.
    for (const completed of [...state.matches].sort((left, right) => left.playedAtMs - right.playedAtMs)) {
      for (const playerId of completed.selectedPlayerIds) {
        const suffix = playerId.slice(-2), candidatePlayerId = playerId === completed.selectedPlayerIds[1] ? completed.selectedPlayerIds[2] : completed.selectedPlayerIds[1];
        state = applyCommunityCommand(state, { role: 'player', accountId: `synthetic-account-player-${suffix}`, playerId, teamId, seasonId },
          { id: `${completed.id}-demo-vote-${suffix}`, type: 'ballot.cast', matchId: completed.id, candidatePlayerId }, completed.actualFullTimeAtMs! + 10 * 60_000);
      }
      state = finalizeDueCommunityAwards(state, completed.voteCutoffAtMs! + 60_000);
    }
  }
  return state;
}
export function syntheticCommunityActors(state = createCommunityState()) {
  const season = state.seasons[0];
  const scope = { teamId: season.teamId, seasonId: season.id };
  return {
    manager: { ...scope, role: 'manager', accountId: 'synthetic-account-manager' } as CommunityActor,
    player: { ...scope, role: 'player', accountId: 'synthetic-account-player-01', playerId: 'synthetic-player-01' } as CommunityActor,
    secondPlayer: { ...scope, role: 'player', accountId: 'synthetic-account-player-02', playerId: 'synthetic-player-02' } as CommunityActor,
    spectator: { ...scope, role: 'spectator', accountId: 'synthetic-account-spectator' } as CommunityActor,
    invitee: { ...scope, role: 'spectator', accountId: 'synthetic-account-invitee' } as CommunityActor,
  };
}

type CommunityFieldRule = { accepts: (value: unknown) => boolean; optional?: boolean };
function communityObjectShape(value: unknown, fields: Record<string, CommunityFieldRule>): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return Object.keys(object).every(key => Object.hasOwn(fields, key)) &&
    Object.entries(fields).every(([key, rule]) => Object.hasOwn(object, key) ? rule.accepts(object[key]) : Boolean(rule.optional));
}
const communityText = (maximum: number, nonempty = true): CommunityFieldRule => ({ accepts: value => typeof value === 'string' && value.length <= maximum && (!nonempty || value.trim().length > 0) });
const communityInteger = (minimum = 0): CommunityFieldRule => ({ accepts: value => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum });
const communityEnum = (...values: string[]): CommunityFieldRule => ({ accepts: value => typeof value === 'string' && values.includes(value) });
const communityTrue: CommunityFieldRule = { accepts: value => value === true };
const communityBoolean: CommunityFieldRule = { accepts: value => typeof value === 'boolean' };
const communityNullable = (rule: CommunityFieldRule): CommunityFieldRule => ({ accepts: value => value === null || rule.accepts(value) });
const communityOptional = (rule: CommunityFieldRule): CommunityFieldRule => ({ ...rule, optional: true });
const communityId = communityText(200);
const communityIds: CommunityFieldRule = { accepts: value => Array.isArray(value) && value.length <= 1000 && value.every(item => communityId.accepts(item)) };
const communityMatchRule: CommunityFieldRule = { accepts: value => communityObjectShape(value, {
  id: communityId, teamId: communityId, seasonId: communityId, label: communityText(200), playedAtMs: communityInteger(),
  selectedPlayerIds: communityIds, presentPlayerIds: communityIds, playedPlayerIds: communityIds,
  actualFullTimeAtMs: communityNullable(communityInteger()), finishQuality: communityEnum('trusted', 'review_required', 'conflicted'),
  sharing: communityEnum('manager_only', 'fictional_review_only'), policyVersion: communityInteger(1),
}) };
const communityPreferencesRule: CommunityFieldRule = { accepts: value => communityObjectShape(value, {
  schedule: communityBoolean, match: communityBoolean, awards: communityBoolean, photos: communityBoolean,
  quietStart: communityNullable(communityText(5)), quietEnd: communityNullable(communityText(5)),
}) };
const communityCommandFields: Record<CommunityCommand['type'], Record<string, CommunityFieldRule>> = {
  'invite.created': { invitationId: communityId, reviewCode: communityText(128), expiresAtMs: communityInteger() },
  'invite.accepted': { reviewCode: communityText(128) },
  'invite.revoked': { invitationId: communityId },
  'grant.revoked': { grantId: communityId },
  'match.registered': { match: communityMatchRule },
  'award.cutoffConfigured': { matchId: communityId, minutesAfterFullTime: communityInteger(1) },
  'ballot.cast': { matchId: communityId, candidatePlayerId: communityId },
  'award.finalised': { matchId: communityId },
  'photo.submitted': { photoId: communityId, matchId: communityId, art: communityEnum('pitch', 'ball', 'cones'), caption: communityText(160, false), policyAcknowledged: communityTrue },
  'photo.revised': { photoId: communityId, sourceRevision: communityInteger(1), art: communityEnum('pitch', 'ball', 'cones'), caption: communityText(160, false), policyAcknowledged: communityTrue },
  'photo.reviewed': { photoId: communityId, sourceRevision: communityInteger(1), decision: communityEnum('approve', 'reject'), reason: communityOptional(communityText(240)) },
  'photo.published': { photoId: communityId, sourceRevision: communityInteger(1), policyAcknowledged: communityTrue },
  'photo.withdrawn': { photoId: communityId, sourceRevision: communityInteger(1) },
  'photo.removed': { photoId: communityId },
  'concern.submitted': { concernId: communityId, targetType: communityEnum('photo', 'uploader'), targetId: communityId,
    category: communityEnum('privacy', 'inappropriate', 'other'), explanation: communityText(500, false) },
  'concern.updated': { concernId: communityId, status: communityEnum('under_review', 'resolved') },
  'uploader.hidden': { uploaderAccountId: communityId, hidden: communityBoolean },
  'preferences.changed': { preferences: communityPreferencesRule },
  'privacy.drafted': { requestId: communityId, requestType: communityEnum('export', 'delete_global_account') },
  'privacy.cancelled': { requestId: communityId },
};

/** Strict JSON boundary. Errors never echo ballot choices, captions or review codes. */
export function parseCommunityCommand(input: unknown, options: { allowServiceOwnedCommands?: boolean } = {}): CommunityCommand {
  requireRule(input !== null && typeof input === 'object' && !Array.isArray(input), 'invalid', 'Invalid community command.');
  const object = input as Record<string, unknown>;
  requireRule(typeof object.type === 'string' && Object.hasOwn(communityCommandFields, object.type), 'invalid', 'Invalid community command.');
  requireRule(object.type !== 'match.registered' || options.allowServiceOwnedCommands === true, 'forbidden', 'Match publication and finish evidence must be assigned by the service, not a public community command.');
  const fields = communityCommandFields[object.type as CommunityCommand['type']];
  requireRule(communityObjectShape(input, { id: communityId, type: communityEnum(object.type), expectedRevision: communityOptional(communityInteger()), ...fields }),
    'invalid', 'Invalid community command fields.');
  return JSON.parse(JSON.stringify(input)) as CommunityCommand;
}
