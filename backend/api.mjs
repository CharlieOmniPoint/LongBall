// apps/api/src/server.ts
import { createServer } from "node:http";
import { randomUUID as randomUUID4 } from "node:crypto";
import { readFileSync as readFileSync2, realpathSync, statSync } from "node:fs";
import { dirname as dirname2, extname, join as join2, sep as sep2 } from "node:path";

// packages/application/src/access.ts
var AccessError = class extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "AccessError";
  }
  code;
  status;
};
function currentMemberships(principal, memberships, now) {
  if (principal.status !== "active") return [];
  return memberships.filter((item) => item.accountId === principal.accountId && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > now));
}
function assertTeamRole(principal, memberships, teamId, seasonId, roles, now = Date.now()) {
  const match = currentMemberships(principal, memberships, now).find((item) => item.teamId === teamId && item.seasonId === seasonId && roles.includes(item.role));
  if (!match) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
  return match;
}
function assertAdultAuthority(principal, recent = false, now = Date.now()) {
  if (principal.status !== "active" || principal.identityClassification !== "adult_individual" || !principal.adultVerified || !principal.strongAuth) {
    throw new AccessError("ADULT_AUTHORITY_REQUIRED", 403, "A verified adult account with stronger authentication is required.");
  }
  if (recent && (principal.authenticatedAt > now + 3e4 || now - principal.authenticatedAt > 3e5)) {
    throw new AccessError("RECENT_AUTHENTICATION_REQUIRED", 403, "Recent stronger authentication is required.");
  }
}
function assertCanManageTeam(principal, memberships, teamId, seasonId, now = Date.now()) {
  assertTeamRole(principal, memberships, teamId, seasonId, ["manager"], now);
  assertAdultAuthority(principal, false, now);
}
function assertCanAssignManager(actor, target, memberships, teamId, seasonId, now = Date.now()) {
  assertTeamRole(actor, memberships, teamId, seasonId, ["administrator"], now);
  assertAdultAuthority(actor, true, now);
  assertAdultAuthority(target, false, now);
  const managers = memberships.filter((item) => item.teamId === teamId && item.role === "manager" && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > now));
  if (!managers.some((item) => item.accountId === target.accountId) && new Set(managers.map((item) => item.accountId)).size >= 4) {
    throw new AccessError("MANAGER_LIMIT", 409, "A team can have at most four active managers, including administrators who also manage.");
  }
}
var UNAPPROVED_SHARING_POLICY = {
  version: "q21-unapproved",
  approvedBy: null,
  approvedAt: null,
  shareScores: false,
  shareDerivedResults: false
};
function filterMatchForPrincipal(input) {
  const now = input.now ?? Date.now();
  const role = assertTeamRole(input.principal, input.memberships, input.teamId, input.seasonId, ["manager", "player", "spectator"], now);
  const current = currentMemberships(input.principal, input.memberships, now);
  const manager = current.some((item) => item.teamId === input.teamId && item.seasonId === input.seasonId && item.role === "manager");
  if (manager) {
    assertAdultAuthority(input.principal, false, now);
    return { matchId: input.state.config.matchId, teamId: input.teamId, seasonId: input.seasonId, audience: "manager", revision: input.state.revision, state: input.state, lastRecorderSyncAt: input.lastSyncAt };
  }
  const scoresAllowed = input.policy.approvedBy !== null && input.policy.approvedAt !== null && input.policy.shareScores;
  const dto = {
    matchId: input.state.config.matchId,
    teamId: input.teamId,
    seasonId: input.seasonId,
    audience: role.role,
    revision: input.state.revision,
    status: input.state.status,
    score: scoresAllowed ? input.state.score : null,
    halfTimeScore: scoresAllowed ? input.state.halfTimeScore : null,
    sharingPolicyVersion: input.policy.version,
    sharingRestricted: !scoresAllowed,
    lastRecorderSyncAt: input.lastSyncAt,
    freshness: input.lastSyncAt !== null && now - input.lastSyncAt <= 15e3 ? "last_synced" : "updates_delayed"
  };
  if (role.role === "player" && role.playerId) {
    const ownIntervals = input.state.intervals.filter((item) => item.playerId === role.playerId);
    dto.ownRecord = {
      playerId: role.playerId,
      attendance: input.state.attendance[role.playerId] ?? "not_recorded",
      playingMs: ownIntervals.filter((item) => item.state === "playing").reduce((sum, item) => sum + item.endMs - item.startMs, 0),
      intervals: ownIntervals,
      completeness: input.state.recoveryRequired ? "review_required" : "recorded_to_last_sync"
    };
  }
  return dto;
}

// packages/application/src/community.ts
var CommunityError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "CommunityError";
  }
  code;
};
function requireRule(condition, code, message) {
  if (!condition) throw new CommunityError(code, message);
}
function validTime(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function unique(values) {
  return new Set(values).size === values.length;
}
function account(state, actor) {
  const found = state.accounts.find((item) => item.id === actor.accountId);
  requireRule(found, "forbidden", "The account is not recognised.");
  return found;
}
function communityCanAccess(state, actor, nowMs) {
  const person = state.accounts.find((item) => item.id === actor.accountId);
  if (!person) return false;
  if (actor.role === "spectator") return state.grants.some((grant) => grant.accountId === actor.accountId && grant.teamId === actor.teamId && grant.seasonId === actor.seasonId && grant.revokedAtMs === null && grant.startsAtMs <= nowMs && nowMs < grant.expiresAtMs);
  if (actor.role === "manager" && (person.classification !== "adult_individual" || !person.adultVerified)) return false;
  const memberships = state.memberships.filter((member) => member.active && member.accountId === actor.accountId && member.teamId === actor.teamId && member.seasonId === actor.seasonId && member.role === actor.role);
  if (actor.role === "player") return memberships.length === 1 && memberships[0].playerId === actor.playerId;
  return memberships.length > 0;
}
function assertAccess(state, actor, nowMs) {
  requireRule(communityCanAccess(state, actor, nowMs), "forbidden", "Team access is unavailable or the season grant has expired. Other account memberships remain intact.");
}
function assertManager(state, actor, nowMs) {
  assertAccess(state, actor, nowMs);
  requireRule(actor.role === "manager", "forbidden", "Only an assigned verified adult manager can do this.");
}
function scopedMatch(state, actor, id3) {
  const match = state.matches.find((item) => item.id === id3);
  requireRule(match && match.teamId === actor.teamId && match.seasonId === actor.seasonId, "forbidden", "That match is outside this team and season.");
  return match;
}
function scopedPhoto(state, actor, id3) {
  const photo = state.photos.find((item) => item.id === id3);
  requireRule(photo && photo.teamId === actor.teamId && photo.seasonId === actor.seasonId, "forbidden", "That photo is outside this team and season.");
  return photo;
}
function currentPhoto(photo, version) {
  if (version !== void 0) requireRule(version === photo.currentRevision, "conflict", "This photo changed. Review its current revision before continuing.");
  requireRule(photo.removedAtMs === null, "closed", "This photo has been removed.");
  const revision = photo.revisions.find((item) => item.version === photo.currentRevision);
  requireRule(revision, "invalid", "The photo revision is missing.");
  return revision;
}
function labelForPlayer(state, playerId) {
  const membership = state.memberships.find((item) => item.playerId === playerId);
  return state.accounts.find((item) => item.id === membership?.accountId)?.label ?? "Player";
}
function labelForAccount(state, accountId) {
  return state.accounts.find((item) => item.id === accountId)?.label ?? "Team member";
}
function sharedAllowed(state, actor, match) {
  return actor.role === "manager" || state.synthetic && match.sharing === "fictional_review_only";
}
function eligibleVoter(match, playerId) {
  return Boolean(playerId && match.selectedPlayerIds.includes(playerId) && match.presentPlayerIds.includes(playerId));
}
function latestBallots(state, matchId) {
  const latest = /* @__PURE__ */ new Map();
  for (const ballot of state.ballots) if (ballot.matchId === matchId) {
    const previous = latest.get(ballot.voterPlayerId);
    if (!previous || ballot.revision > previous.revision) latest.set(ballot.voterPlayerId, ballot);
  }
  return [...latest.values()];
}
function sealAward(state, match, nowMs) {
  requireRule(match.voteCutoffAtMs !== null && match.finalisationDeadlineAtMs !== null, "invalid", "The award timing evidence is missing.");
  const counts = /* @__PURE__ */ new Map();
  for (const ballot of latestBallots(state, match.id)) if ((ballot.receivedAtMs < match.voteCutoffAtMs || match.cutoffSource === "manager_early_close" && ballot.receivedAtMs === match.voteCutoffAtMs) && eligibleVoter(match, ballot.voterPlayerId) && ballot.voterPlayerId !== ballot.candidatePlayerId && match.playedPlayerIds.includes(ballot.candidatePlayerId)) {
    counts.set(ballot.candidatePlayerId, (counts.get(ballot.candidatePlayerId) ?? 0) + 1);
  }
  const highest = Math.max(0, ...counts.values());
  const winners = [...counts].filter(([, count]) => count === highest).map(([id3]) => id3).sort();
  state.awards.push({
    matchId: match.id,
    winnerPlayerIds: winners,
    result: highest === 0 ? "no_valid_votes" : "winners",
    voteCutoffAtMs: match.voteCutoffAtMs,
    finalisationDeadlineAtMs: match.finalisationDeadlineAtMs,
    finalisedAtMs: nowMs,
    deadlineMissed: nowMs > match.finalisationDeadlineAtMs
  });
}
function validateArt(art, caption) {
  requireRule(["pitch", "ball", "cones"].includes(art), "invalid", "Choose a fictional review illustration. Arbitrary URLs and raw image uploads are not supported here.");
  requireRule(typeof caption === "string" && caption.trim().length <= 160, "invalid", "Keep the caption within 160 characters.");
}
function defaultCommunityPreferences() {
  return { schedule: true, match: true, awards: true, photos: true, quietStart: null, quietEnd: null };
}
function applyCommunityCommand(state, actor, command, nowMs) {
  requireRule(validTime(nowMs), "invalid", "A valid receipt time is required.");
  account(state, actor);
  requireRule(command.id.trim(), "invalid", "A command identity is required.");
  const fingerprint2 = JSON.stringify([actor, command]);
  const prior = state.appliedCommands[command.id];
  if (prior !== void 0) {
    requireRule(prior === fingerprint2, "conflict", "This command identity was already used for different content.");
    return state;
  }
  requireRule(command.expectedRevision === void 0 || command.expectedRevision === state.revision, "conflict", "Community records changed. Reload the saved record before retrying.");
  const next = JSON.parse(JSON.stringify(state));
  const personal = ["preferences.changed", "privacy.drafted", "privacy.cancelled"].includes(command.type) || command.type === "uploader.hidden" && !command.hidden;
  if (!personal && command.type !== "invite.accepted") assertAccess(next, actor, nowMs);
  switch (command.type) {
    case "invite.created": {
      requireRule(actor.role !== "spectator", "forbidden", "Spectators cannot invite other spectators.");
      const season = next.seasons.find((item) => item.id === actor.seasonId && item.teamId === actor.teamId);
      requireRule(season, "invalid", "The team season is missing.");
      requireRule(validTime(command.expiresAtMs) && nowMs < command.expiresAtMs && command.expiresAtMs <= season.accessEndsAtMs, "invalid", "Choose an invitation expiry after now and before the season ends.");
      requireRule(command.reviewCode.trim().length >= 6 && !next.invitations.some((item) => item.reviewCode === command.reviewCode || item.id === command.invitationId), "invalid", "The fictional invitation identity/code must be unique.");
      next.invitations.push({
        id: command.invitationId,
        teamId: actor.teamId,
        seasonId: actor.seasonId,
        inviterAccountId: actor.accountId,
        reviewCode: command.reviewCode,
        createdAtMs: nowMs,
        expiresAtMs: command.expiresAtMs,
        acceptedBy: null,
        acceptedAtMs: null,
        revokedAtMs: null
      });
      break;
    }
    case "invite.accepted": {
      const invite = next.invitations.find((item) => item.reviewCode === command.reviewCode);
      requireRule(invite && invite.teamId === actor.teamId && invite.seasonId === actor.seasonId, "forbidden", "That invitation is not valid for this team and season.");
      requireRule(invite.revokedAtMs === null && invite.acceptedBy === null, "closed", "That invitation has already been accepted or revoked.");
      requireRule(nowMs < invite.expiresAtMs, "expired", "This invitation has expired. Ask for a new individual invitation.");
      const season = next.seasons.find((item) => item.id === invite.seasonId && item.teamId === invite.teamId);
      requireRule(season && nowMs < season.accessEndsAtMs, "expired", "The invited season has ended. Renewal is explicit.");
      invite.acceptedBy = actor.accountId;
      invite.acceptedAtMs = nowMs;
      next.grants.push({
        id: `grant:${invite.id}`,
        invitationId: invite.id,
        accountId: actor.accountId,
        teamId: invite.teamId,
        seasonId: invite.seasonId,
        startsAtMs: nowMs,
        expiresAtMs: season.accessEndsAtMs,
        revokedAtMs: null
      });
      break;
    }
    case "invite.revoked": {
      assertManager(next, actor, nowMs);
      const invite = next.invitations.find((item) => item.id === command.invitationId && item.teamId === actor.teamId && item.seasonId === actor.seasonId);
      requireRule(invite, "forbidden", "That invitation is outside this team and season.");
      invite.revokedAtMs = nowMs;
      for (const grant of next.grants) if (grant.invitationId === invite.id) grant.revokedAtMs = nowMs;
      break;
    }
    case "grant.revoked": {
      assertManager(next, actor, nowMs);
      const grant = next.grants.find((item) => item.id === command.grantId && item.teamId === actor.teamId && item.seasonId === actor.seasonId);
      requireRule(grant, "forbidden", "That grant is outside this team and season.");
      grant.revokedAtMs = nowMs;
      break;
    }
    case "match.registered": {
      assertManager(next, actor, nowMs);
      const match = command.match;
      requireRule(match.teamId === actor.teamId && match.seasonId === actor.seasonId, "forbidden", "A match must belong to the active team and season.");
      requireRule(!next.matches.some((item) => item.id === match.id), "conflict", "This match is already registered. A corrected finish requires an audited exception process and never reopens an award.");
      requireRule(validTime(match.playedAtMs) && unique(match.selectedPlayerIds) && unique(match.presentPlayerIds) && unique(match.playedPlayerIds), "invalid", "The match evidence is invalid.");
      requireRule(match.presentPlayerIds.every((id3) => match.selectedPlayerIds.includes(id3)) && match.playedPlayerIds.every((id3) => match.presentPlayerIds.includes(id3)), "invalid", "Played and present evidence must belong to the selected squad.");
      requireRule(match.selectedPlayerIds.every((id3) => next.memberships.some((member) => member.playerId === id3 && member.teamId === actor.teamId && member.seasonId === actor.seasonId)), "invalid", "Every selected player needs a membership in this team and season.");
      requireRule(match.actualFullTimeAtMs === null || validTime(match.actualFullTimeAtMs) && match.actualFullTimeAtMs <= nowMs, "invalid", "Actual full time cannot be in the future.");
      next.matches.push({
        ...match,
        voteCutoffAtMs: null,
        cutoffSource: "unresolved",
        finalisationDeadlineAtMs: match.actualFullTimeAtMs === null ? null : match.actualFullTimeAtMs + 36e5
      });
      break;
    }
    case "award.cutoffConfigured": {
      assertManager(next, actor, nowMs);
      const match = scopedMatch(next, actor, command.matchId);
      requireRule(match.actualFullTimeAtMs !== null && match.finishQuality === "trusted", "policy_needed", "Trustworthy original full-time evidence is required first.");
      requireRule(!next.awards.some((item) => item.matchId === match.id) && match.cutoffSource === "unresolved", "closed", "A configured/closed award cannot be reopened by changing its cutoff.");
      requireRule(Number.isSafeInteger(command.minutesAfterFullTime) && command.minutesAfterFullTime > 0 && command.minutesAfterFullTime < 60, "invalid", "Choose an explicit fictional cutoff from 1 to 59 minutes. This does not approve a production default.");
      match.voteCutoffAtMs = match.actualFullTimeAtMs + command.minutesAfterFullTime * 6e4;
      match.cutoffSource = "explicit_fictional_setting";
      break;
    }
    case "ballot.cast": {
      const match = scopedMatch(next, actor, command.matchId);
      requireRule(actor.role === "player" && eligibleVoter(match, actor.playerId), "forbidden", "Only a present selected player may cast their own ballot. Parent use shares the same account and vote.");
      requireRule(sharedAllowed(next, actor, match), "policy_needed", "This match award is not shared under the current competition policy.");
      requireRule(match.finishQuality === "trusted", "policy_needed", "The finish/eligibility evidence requires review before voting.");
      requireRule(!next.awards.some((item) => item.matchId === match.id), "closed", "Voting is closed.");
      if (match.actualFullTimeAtMs !== null) {
        requireRule(match.voteCutoffAtMs !== null, "policy_needed", "The automatic ballot cutoff is unresolved (Q15). A manager must set an explicit fictional rehearsal cutoff or close deliberately.");
        requireRule(nowMs < match.voteCutoffAtMs && nowMs < match.finalisationDeadlineAtMs, "closed", "Voting is closed at its original cutoff, even if finalisation is delayed.");
      }
      requireRule(command.candidatePlayerId !== actor.playerId && match.playedPlayerIds.includes(command.candidatePlayerId), "invalid", "Choose a teammate who actually played. Self-votes are not permitted.");
      const revisions = next.ballots.filter((item) => item.matchId === match.id && item.voterPlayerId === actor.playerId);
      next.ballots.push({
        id: command.id,
        matchId: match.id,
        voterAccountId: actor.accountId,
        voterPlayerId: actor.playerId,
        candidatePlayerId: command.candidatePlayerId,
        receivedAtMs: nowMs,
        revision: revisions.length + 1
      });
      break;
    }
    case "award.finalised": {
      assertManager(next, actor, nowMs);
      const match = scopedMatch(next, actor, command.matchId);
      requireRule(match.actualFullTimeAtMs !== null && match.finalisationDeadlineAtMs !== null && nowMs >= match.actualFullTimeAtMs, "invalid", "A manager may close only after actual full time.");
      requireRule(match.finishQuality === "trusted", "policy_needed", "Contradictory or uncertain finish/eligibility evidence blocks finalisation. Retain it for audited review.");
      requireRule(!next.awards.some((item) => item.matchId === match.id), "closed", "This final award is already sealed. Report edits never reopen it.");
      if (match.voteCutoffAtMs === null || nowMs < match.voteCutoffAtMs) {
        match.voteCutoffAtMs = Math.min(nowMs, match.finalisationDeadlineAtMs);
        match.cutoffSource = "manager_early_close";
      }
      sealAward(next, match, nowMs);
      break;
    }
    case "photo.submitted": {
      requireRule(actor.role !== "spectator", "forbidden", "Spectators cannot upload photos.");
      const match = scopedMatch(next, actor, command.matchId);
      requireRule(command.policyAcknowledged === true, "invalid", "Review the photo policy before submission.");
      validateArt(command.art, command.caption);
      requireRule(!next.photos.some((item) => item.id === command.photoId), "conflict", "That photo identity is already in use.");
      next.photos.push({
        id: command.photoId,
        matchId: match.id,
        teamId: match.teamId,
        seasonId: match.seasonId,
        uploaderAccountId: actor.accountId,
        uploaderRole: actor.role,
        currentRevision: 1,
        publishedRevision: null,
        removedAtMs: null,
        revisions: [{
          version: 1,
          art: command.art,
          caption: command.caption.trim(),
          status: actor.role === "player" ? "pending" : "draft",
          createdAtMs: nowMs,
          reviewedAtMs: null,
          reviewerAccountId: null,
          rejectionReason: null,
          processing: "synthetic_derivative_ready"
        }]
      });
      break;
    }
    case "photo.revised": {
      const photo = scopedPhoto(next, actor, command.photoId);
      currentPhoto(photo, command.sourceRevision);
      requireRule(photo.uploaderAccountId === actor.accountId && actor.role === photo.uploaderRole, "forbidden", "Only the uploader may revise their submission.");
      requireRule(command.policyAcknowledged === true, "invalid", "Review the photo policy before resubmission.");
      validateArt(command.art, command.caption);
      photo.currentRevision += 1;
      photo.revisions.push({
        version: photo.currentRevision,
        art: command.art,
        caption: command.caption.trim(),
        status: actor.role === "player" ? "pending" : "draft",
        createdAtMs: nowMs,
        reviewedAtMs: null,
        reviewerAccountId: null,
        rejectionReason: null,
        processing: "synthetic_derivative_ready"
      });
      break;
    }
    case "photo.reviewed": {
      assertManager(next, actor, nowMs);
      const photo = scopedPhoto(next, actor, command.photoId);
      const revision = currentPhoto(photo, command.sourceRevision);
      requireRule(photo.uploaderRole === "player" && revision.status === "pending", "invalid", "Only a current pending player submission enters this review queue.");
      requireRule(photo.uploaderAccountId !== actor.accountId, "forbidden", "A conflicted reviewer cannot approve their own submission.");
      requireRule(command.decision !== "reject" || Boolean(command.reason?.trim()), "invalid", "Give a private reason for rejection.");
      revision.status = command.decision === "approve" ? "published" : "rejected";
      revision.reviewedAtMs = nowMs;
      revision.reviewerAccountId = actor.accountId;
      revision.rejectionReason = command.decision === "reject" ? command.reason.trim().slice(0, 240) : null;
      if (command.decision === "approve") photo.publishedRevision = revision.version;
      break;
    }
    case "photo.published": {
      assertManager(next, actor, nowMs);
      const photo = scopedPhoto(next, actor, command.photoId);
      const revision = currentPhoto(photo, command.sourceRevision);
      requireRule(photo.uploaderAccountId === actor.accountId && photo.uploaderRole === "manager" && revision.status === "draft", "forbidden", "Managers explicitly publish their own current draft; player photos need review.");
      requireRule(command.policyAcknowledged === true, "invalid", "Review the exact photo and content policy before Publish.");
      revision.status = "published";
      revision.reviewedAtMs = nowMs;
      revision.reviewerAccountId = actor.accountId;
      photo.publishedRevision = revision.version;
      break;
    }
    case "photo.withdrawn": {
      const photo = scopedPhoto(next, actor, command.photoId);
      const revision = currentPhoto(photo, command.sourceRevision);
      requireRule(photo.uploaderAccountId === actor.accountId, "forbidden", "Only the uploader can withdraw a submission.");
      requireRule(revision.status === "pending" || revision.status === "draft", "closed", "Only an unpublished submission can be withdrawn.");
      revision.status = "withdrawn";
      break;
    }
    case "photo.removed": {
      assertManager(next, actor, nowMs);
      const photo = scopedPhoto(next, actor, command.photoId);
      currentPhoto(photo);
      photo.removedAtMs = nowMs;
      photo.publishedRevision = null;
      break;
    }
    case "concern.submitted": {
      requireRule(!next.concerns.some((item) => item.id === command.concernId), "conflict", "That concern reference is already used.");
      let uploaderAccountId;
      let photoRevision = null;
      if (command.targetType === "photo") {
        const photo = scopedPhoto(next, actor, command.targetId);
        const decision = authorizeCommunityMedia(next, actor, photo.id, nowMs);
        requireRule(decision.allowed, "forbidden", "Only a photo you may view can be reported here.");
        photoRevision = decision.revision.version;
        uploaderAccountId = photo.uploaderAccountId;
      } else {
        requireRule(next.photos.some((photo) => photo.uploaderAccountId === command.targetId && authorizeCommunityMedia(next, actor, photo.id, nowMs).allowed), "forbidden", "Report an uploader through a photo you may view.");
        uploaderAccountId = command.targetId;
      }
      requireRule(command.explanation.length <= 500, "invalid", "Keep the explanation under 500 characters and avoid unnecessary personal details.");
      next.concerns.push({
        id: command.concernId,
        teamId: actor.teamId,
        seasonId: actor.seasonId,
        reporterAccountId: actor.accountId,
        targetType: command.targetType,
        targetId: command.targetId,
        photoRevision,
        uploaderAccountId,
        category: command.category,
        explanation: command.explanation.trim(),
        status: next.memberships.some((item) => item.accountId === uploaderAccountId && item.role === "manager" && item.active && item.teamId === actor.teamId) ? "escalation_required" : "submitted",
        createdAtMs: nowMs
      });
      break;
    }
    case "concern.updated": {
      assertManager(next, actor, nowMs);
      const concern = next.concerns.find((item) => item.id === command.concernId && item.teamId === actor.teamId && item.seasonId === actor.seasonId);
      requireRule(concern && concern.uploaderAccountId !== actor.accountId && concern.status !== "escalation_required", "forbidden", "A conflicted manager cannot review this concern. Operator escalation is required.");
      concern.status = command.status;
      break;
    }
    case "uploader.hidden": {
      requireRule(command.uploaderAccountId !== actor.accountId && next.accounts.some((item) => item.id === command.uploaderAccountId), "invalid", "Choose a different uploader.");
      const alreadyHidden = next.hiddenUploaders.some((item) => item.accountId === actor.accountId && item.uploaderAccountId === command.uploaderAccountId);
      requireRule(alreadyHidden || command.hidden && next.photos.some((photo) => photo.uploaderAccountId === command.uploaderAccountId && authorizeCommunityMedia(next, actor, photo.id, nowMs).allowed), "forbidden", "Choose an uploader through a published photo you may view.");
      next.hiddenUploaders = next.hiddenUploaders.filter((item) => !(item.accountId === actor.accountId && item.uploaderAccountId === command.uploaderAccountId));
      if (command.hidden) next.hiddenUploaders.push({ accountId: actor.accountId, uploaderAccountId: command.uploaderAccountId });
      break;
    }
    case "preferences.changed": {
      const preferences = command.preferences;
      requireRule(["schedule", "match", "awards", "photos"].every((key) => typeof preferences[key] === "boolean"), "invalid", "Notification choices must be on or off.");
      const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
      requireRule(preferences.quietStart === null && preferences.quietEnd === null || typeof preferences.quietStart === "string" && typeof preferences.quietEnd === "string" && time.test(preferences.quietStart) && time.test(preferences.quietEnd), "invalid", "Use HH:MM for both quiet-hour boundaries, or leave both empty.");
      next.preferences[actor.accountId] = { ...preferences };
      break;
    }
    case "privacy.drafted": {
      requireRule(!next.privacyRequests.some((item) => item.id === command.requestId), "conflict", "That request reference is already used.");
      next.privacyRequests.push({
        id: command.requestId,
        accountId: actor.accountId,
        type: command.requestType,
        status: "verification_needed",
        createdAtMs: nowMs,
        delivery: "local_draft"
      });
      break;
    }
    case "privacy.cancelled": {
      const request = next.privacyRequests.find((item) => item.id === command.requestId && item.accountId === actor.accountId);
      requireRule(request, "forbidden", "That request belongs to another account.");
      requireRule(request.status === "verification_needed", "closed", "That draft is already cancelled.");
      request.status = "cancelled";
      break;
    }
    default: {
      const exhaustive = command;
      throw new CommunityError("invalid", `Unsupported community action: ${String(exhaustive.type)}`);
    }
  }
  next.revision += 1;
  next.appliedCommands[command.id] = fingerprint2;
  next.audit.push({ id: command.id, actorAccountId: actor.accountId, action: command.type, atMs: nowMs, origin: "account" });
  return next;
}
function authorizeCommunityMedia(state, actor, photoId, nowMs, mode = "gallery", requestedRevision) {
  if (!communityCanAccess(state, actor, nowMs)) return { allowed: false, reason: "Access unavailable or expired" };
  const photo = state.photos.find((item) => item.id === photoId && item.teamId === actor.teamId && item.seasonId === actor.seasonId);
  if (!photo || photo.removedAtMs !== null) return { allowed: false, reason: "Photo unavailable" };
  const match = state.matches.find((item) => item.id === photo.matchId);
  if (!match) return { allowed: false, reason: "Photo context unavailable" };
  const number = mode === "gallery" ? photo.publishedRevision : photo.currentRevision;
  if (number === null || requestedRevision !== void 0 && number !== requestedRevision) return { allowed: false, reason: "Photo revision is not available to this audience" };
  const revision = photo.revisions.find((item) => item.version === number);
  if (!revision) return { allowed: false, reason: "Photo revision unavailable" };
  if (mode === "gallery") {
    if (revision.status !== "published" || !sharedAllowed(state, actor, match)) return { allowed: false, reason: "Publication policy does not permit this photo" };
    if (state.hiddenUploaders.some((item) => item.accountId === actor.accountId && item.uploaderAccountId === photo.uploaderAccountId)) return { allowed: false, reason: "Uploader hidden for this gallery" };
  } else if (mode === "own") {
    if (photo.uploaderAccountId !== actor.accountId || !["pending", "draft", "published"].includes(revision.status)) return { allowed: false, reason: "This submission is private" };
  } else if (actor.role !== "manager" || photo.uploaderRole !== "player" || revision.status !== "pending") return { allowed: false, reason: "Review permission required" };
  return { allowed: true, revision: { ...revision }, photo: { id: photo.id, matchId: photo.matchId, uploaderAccountId: photo.uploaderAccountId }, cacheControl: "private, no-store" };
}
function getCommunityView(state, actor, nowMs) {
  const allowed = communityCanAccess(state, actor, nowMs);
  const season = state.seasons.find((item) => item.id === actor.seasonId && item.teamId === actor.teamId);
  const person = account(state, actor);
  const scoped = (items) => items.filter((item) => item.teamId === actor.teamId && item.seasonId === actor.seasonId);
  const gallery = allowed ? scoped(state.photos).flatMap((photo) => {
    const decision = authorizeCommunityMedia(state, actor, photo.id, nowMs);
    if (!decision.allowed) return [];
    const match = state.matches.find((item) => item.id === photo.matchId);
    return [{
      id: photo.id,
      matchId: photo.matchId,
      matchLabel: match.label,
      playedAtMs: match.playedAtMs,
      uploaderAccountId: photo.uploaderAccountId,
      uploaderLabel: labelForAccount(state, photo.uploaderAccountId),
      version: decision.revision.version,
      art: decision.revision.art,
      caption: decision.revision.caption
    }];
  }).sort((a, b) => b.playedAtMs - a.playedAtMs || a.id.localeCompare(b.id)) : [];
  return {
    allowed,
    accessMessage: allowed ? null : "Team access has expired or is unavailable. Ask for a new invitation; unrelated account memberships are unchanged.",
    teamLabel: season?.teamLabel ?? "Team",
    seasonLabel: season?.label ?? "Season",
    accountLabel: person.label,
    memberships: state.memberships.filter((item) => item.accountId === actor.accountId).map((item) => ({ ...item })),
    preferences: { ...state.preferences[actor.accountId] ?? defaultCommunityPreferences() },
    invitations: allowed && actor.role !== "spectator" ? scoped(state.invitations).filter((item) => actor.role === "manager" || item.inviterAccountId === actor.accountId).map((item) => ({ ...item })) : [],
    grants: allowed && actor.role === "manager" ? scoped(state.grants).map((item) => ({ ...item, accountLabel: labelForAccount(state, item.accountId) })) : [],
    matches: allowed ? scoped(state.matches).map((match) => {
      const share = sharedAllowed(state, actor, match);
      const award = state.awards.find((item) => item.matchId === match.id);
      const own = actor.role === "player" ? latestBallots(state, match.id).find((item) => item.voterAccountId === actor.accountId && item.voterPlayerId === actor.playerId) : null;
      const mayVote = share && actor.role === "player" && eligibleVoter(match, actor.playerId) && match.finishQuality === "trusted" && !award && (match.actualFullTimeAtMs === null || match.voteCutoffAtMs !== null && nowMs < match.voteCutoffAtMs && nowMs < match.finalisationDeadlineAtMs);
      return {
        id: match.id,
        label: share ? match.label : "Match context withheld by competition policy",
        playedAtMs: share ? match.playedAtMs : null,
        sharingAllowed: share,
        fullTimeAtMs: share ? match.actualFullTimeAtMs : null,
        finishQuality: match.finishQuality,
        cutoffAtMs: share ? match.voteCutoffAtMs : null,
        cutoffSource: match.cutoffSource,
        deadlineAtMs: share ? match.finalisationDeadlineAtMs : null,
        mayVote,
        ownChoice: own?.candidatePlayerId ?? null,
        candidates: mayVote ? match.playedPlayerIds.filter((id3) => id3 !== actor.playerId).map((id3) => ({ id: id3, label: labelForPlayer(state, id3) })) : [],
        award: share && award ? { ...award, winnerLabels: award.winnerPlayerIds.map((id3) => labelForPlayer(state, id3)) } : null
      };
    }) : [],
    gallery,
    submissions: allowed && actor.role !== "spectator" ? scoped(state.photos).filter((item) => item.uploaderAccountId === actor.accountId).map((photo) => {
      const revision = photo.revisions.find((item) => item.version === photo.currentRevision);
      return {
        id: photo.id,
        matchId: photo.matchId,
        version: photo.currentRevision,
        status: photo.removedAtMs !== null ? "removed" : revision.status,
        art: photo.removedAtMs !== null || ["rejected", "withdrawn"].includes(revision.status) ? null : revision.art,
        caption: revision.caption,
        rejectionReason: revision.rejectionReason,
        previousPublishedVersion: photo.publishedRevision !== photo.currentRevision ? photo.publishedRevision : null
      };
    }) : [],
    reviewQueue: allowed && actor.role === "manager" ? scoped(state.photos).flatMap((photo) => {
      const decision = authorizeCommunityMedia(state, actor, photo.id, nowMs, "review");
      return decision.allowed ? [{
        id: photo.id,
        version: decision.revision.version,
        art: decision.revision.art,
        caption: decision.revision.caption,
        uploaderLabel: labelForAccount(state, photo.uploaderAccountId)
      }] : [];
    }) : [],
    ownConcerns: state.concerns.filter((item) => item.reporterAccountId === actor.accountId).map((item) => ({ id: item.id, status: item.status, targetType: item.targetType, createdAtMs: item.createdAtMs })),
    reviewConcerns: allowed && actor.role === "manager" ? scoped(state.concerns).filter((item) => item.uploaderAccountId !== actor.accountId && item.status !== "escalation_required").map((item) => ({ id: item.id, targetType: item.targetType, targetId: item.targetId, category: item.category, explanation: item.explanation, status: item.status })) : [],
    hiddenUploaders: state.hiddenUploaders.filter((item) => item.accountId === actor.accountId).map((item) => ({ id: item.uploaderAccountId, label: labelForAccount(state, item.uploaderAccountId) })),
    privacyRequests: state.privacyRequests.filter((item) => item.accountId === actor.accountId).map((item) => ({ ...item }))
  };
}
function createCommunityState(nowMs = Date.now()) {
  const teamId = "synthetic-roma-u10";
  const seasonId = "synthetic-season-2026-27";
  const playerIds = Array.from({ length: 13 }, (_, index) => `synthetic-player-${String(index + 1).padStart(2, "0")}`);
  const accounts = [
    { id: "synthetic-account-manager", label: "Fictional manager", classification: "adult_individual", adultVerified: true },
    ...playerIds.map((id3, index) => ({ id: `synthetic-account-player-${String(index + 1).padStart(2, "0")}`, label: `Player ${id3.slice(-2)}`, classification: "child_shared", adultVerified: false })),
    { id: "synthetic-account-spectator", label: "Fictional spectator", classification: "spectator", adultVerified: false },
    { id: "synthetic-account-invitee", label: "Fictional invited spectator", classification: "spectator", adultVerified: false }
  ];
  const memberships = [
    { accountId: accounts[0].id, teamId, seasonId, role: "manager", active: true },
    ...playerIds.map((playerId, index) => ({ accountId: accounts[index + 1].id, playerId, teamId, seasonId, role: "player", active: true }))
  ];
  const fullTime = Math.max(0, nowMs - 6e5);
  const match = {
    id: "synthetic-community-willow",
    teamId,
    seasonId,
    label: "Roma vs Willow FC \xB7 fictional review",
    playedAtMs: Math.max(0, fullTime - 36e5),
    selectedPlayerIds: playerIds.slice(0, 9),
    presentPlayerIds: playerIds.slice(0, 9),
    playedPlayerIds: playerIds.slice(0, 9),
    actualFullTimeAtMs: fullTime,
    finishQuality: "trusted",
    voteCutoffAtMs: null,
    cutoffSource: "unresolved",
    finalisationDeadlineAtMs: fullTime + 36e5,
    sharing: "fictional_review_only",
    policyVersion: 1
  };
  const state = {
    schemaVersion: 1,
    synthetic: true,
    revision: 0,
    accounts,
    memberships,
    seasons: [{ id: seasonId, teamId, label: "2026/27", teamLabel: "Roma U10", accessEndsAtMs: Date.parse("2027-08-31T23:00:00Z") }],
    invitations: [],
    grants: [{
      id: "synthetic-demo-grant",
      invitationId: "synthetic-seeded-invitation",
      accountId: "synthetic-account-spectator",
      teamId,
      seasonId,
      startsAtMs: Math.max(0, nowMs - 864e5),
      expiresAtMs: Date.parse("2027-08-31T23:00:00Z"),
      revokedAtMs: null
    }],
    matches: [match],
    ballots: [],
    awards: [],
    photos: [],
    concerns: [],
    hiddenUploaders: [],
    preferences: {},
    privacyRequests: [],
    audit: [],
    appliedCommands: {}
  };
  state.photos.push({
    id: "synthetic-published-pitch",
    matchId: match.id,
    teamId,
    seasonId,
    uploaderAccountId: "synthetic-account-manager",
    uploaderRole: "manager",
    currentRevision: 1,
    publishedRevision: 1,
    removedAtMs: null,
    revisions: [{
      version: 1,
      art: "pitch",
      caption: "A fictional matchday illustration. No children or real photographs.",
      status: "published",
      createdAtMs: fullTime,
      reviewedAtMs: fullTime,
      reviewerAccountId: "synthetic-account-manager",
      rejectionReason: null,
      processing: "synthetic_derivative_ready"
    }]
  });
  state.photos.push({
    id: "synthetic-pending-ball",
    matchId: match.id,
    teamId,
    seasonId,
    uploaderAccountId: "synthetic-account-player-01",
    uploaderRole: "player",
    currentRevision: 1,
    publishedRevision: null,
    removedAtMs: null,
    revisions: [{
      version: 1,
      art: "ball",
      caption: "Fictional football illustration awaiting review.",
      status: "pending",
      createdAtMs: fullTime,
      reviewedAtMs: null,
      reviewerAccountId: null,
      rejectionReason: null,
      processing: "synthetic_derivative_ready"
    }]
  });
  return state;
}
function communityObjectShape(value, fields2) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value;
  return Object.keys(object).every((key) => Object.hasOwn(fields2, key)) && Object.entries(fields2).every(([key, rule]) => Object.hasOwn(object, key) ? rule.accepts(object[key]) : Boolean(rule.optional));
}
var communityText = (maximum, nonempty = true) => ({ accepts: (value) => typeof value === "string" && value.length <= maximum && (!nonempty || value.trim().length > 0) });
var communityInteger = (minimum = 0) => ({ accepts: (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum });
var communityEnum = (...values) => ({ accepts: (value) => typeof value === "string" && values.includes(value) });
var communityTrue = { accepts: (value) => value === true };
var communityBoolean = { accepts: (value) => typeof value === "boolean" };
var communityNullable = (rule) => ({ accepts: (value) => value === null || rule.accepts(value) });
var communityOptional = (rule) => ({ ...rule, optional: true });
var communityId = communityText(200);
var communityIds = { accepts: (value) => Array.isArray(value) && value.length <= 1e3 && value.every((item) => communityId.accepts(item)) };
var communityMatchRule = { accepts: (value) => communityObjectShape(value, {
  id: communityId,
  teamId: communityId,
  seasonId: communityId,
  label: communityText(200),
  playedAtMs: communityInteger(),
  selectedPlayerIds: communityIds,
  presentPlayerIds: communityIds,
  playedPlayerIds: communityIds,
  actualFullTimeAtMs: communityNullable(communityInteger()),
  finishQuality: communityEnum("trusted", "review_required", "conflicted"),
  sharing: communityEnum("manager_only", "fictional_review_only"),
  policyVersion: communityInteger(1)
}) };
var communityPreferencesRule = { accepts: (value) => communityObjectShape(value, {
  schedule: communityBoolean,
  match: communityBoolean,
  awards: communityBoolean,
  photos: communityBoolean,
  quietStart: communityNullable(communityText(5)),
  quietEnd: communityNullable(communityText(5))
}) };
var communityCommandFields = {
  "invite.created": { invitationId: communityId, reviewCode: communityText(128), expiresAtMs: communityInteger() },
  "invite.accepted": { reviewCode: communityText(128) },
  "invite.revoked": { invitationId: communityId },
  "grant.revoked": { grantId: communityId },
  "match.registered": { match: communityMatchRule },
  "award.cutoffConfigured": { matchId: communityId, minutesAfterFullTime: communityInteger(1) },
  "ballot.cast": { matchId: communityId, candidatePlayerId: communityId },
  "award.finalised": { matchId: communityId },
  "photo.submitted": { photoId: communityId, matchId: communityId, art: communityEnum("pitch", "ball", "cones"), caption: communityText(160, false), policyAcknowledged: communityTrue },
  "photo.revised": { photoId: communityId, sourceRevision: communityInteger(1), art: communityEnum("pitch", "ball", "cones"), caption: communityText(160, false), policyAcknowledged: communityTrue },
  "photo.reviewed": { photoId: communityId, sourceRevision: communityInteger(1), decision: communityEnum("approve", "reject"), reason: communityOptional(communityText(240)) },
  "photo.published": { photoId: communityId, sourceRevision: communityInteger(1), policyAcknowledged: communityTrue },
  "photo.withdrawn": { photoId: communityId, sourceRevision: communityInteger(1) },
  "photo.removed": { photoId: communityId },
  "concern.submitted": {
    concernId: communityId,
    targetType: communityEnum("photo", "uploader"),
    targetId: communityId,
    category: communityEnum("privacy", "inappropriate", "other"),
    explanation: communityText(500, false)
  },
  "concern.updated": { concernId: communityId, status: communityEnum("under_review", "resolved") },
  "uploader.hidden": { uploaderAccountId: communityId, hidden: communityBoolean },
  "preferences.changed": { preferences: communityPreferencesRule },
  "privacy.drafted": { requestId: communityId, requestType: communityEnum("export", "delete_global_account") },
  "privacy.cancelled": { requestId: communityId }
};
function parseCommunityCommand(input, options = {}) {
  requireRule(input !== null && typeof input === "object" && !Array.isArray(input), "invalid", "Invalid community command.");
  const object = input;
  requireRule(typeof object.type === "string" && Object.hasOwn(communityCommandFields, object.type), "invalid", "Invalid community command.");
  requireRule(object.type !== "match.registered" || options.allowServiceOwnedCommands === true, "forbidden", "Match publication and finish evidence must be assigned by the service, not a public community command.");
  const fields2 = communityCommandFields[object.type];
  requireRule(
    communityObjectShape(input, { id: communityId, type: communityEnum(object.type), expectedRevision: communityOptional(communityInteger()), ...fields2 }),
    "invalid",
    "Invalid community command fields."
  );
  return JSON.parse(JSON.stringify(input));
}

// apps/api/src/oidc.ts
import { createPublicKey, verify } from "node:crypto";
function createOidcVerifier(options) {
  if (!options.issuer || !options.audience || new URL(options.issuer).protocol !== "https:" || new URL(options.jwksUri).protocol !== "https:") throw new Error("OIDC requires explicitly configured HTTPS issuer, audience and JWKS URI.");
  const now = options.now ?? Date.now;
  let cache = null;
  let lastRefreshAt = -Infinity;
  let fetching = null;
  const load = async (refresh) => {
    if (!refresh && cache && cache.expires > now()) return cache.keys;
    if (refresh && cache && now() - lastRefreshAt < 3e4) return cache.keys;
    fetching ??= (options.fetchJwks ?? (async () => {
      const response = await fetch(options.jwksUri, { signal: AbortSignal.timeout(5e3), redirect: "error", headers: { accept: "application/json" } });
      if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 128e3) throw new Error("OIDC key retrieval failed.");
      const text2 = await response.text();
      if (text2.length > 128e3) throw new Error("OIDC key response is too large.");
      return JSON.parse(text2);
    }))();
    try {
      const document = await fetching;
      if (!Array.isArray(document.keys) || document.keys.length > 100) throw new Error("OIDC key document is invalid.");
      cache = { keys: document.keys, expires: now() + 3e5 };
      lastRefreshAt = now();
      return document.keys;
    } finally {
      fetching = null;
    }
  };
  return async (token) => {
    try {
      if (typeof token !== "string" || token.length > 16384) throw new Error();
      const segments = token.split(".");
      if (segments.length !== 3 || segments.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
      const header2 = JSON.parse(Buffer.from(segments[0], "base64url").toString("utf8"));
      const claims = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
      if (header2.alg !== "RS256" || typeof header2.kid !== "string" || !header2.kid || header2.kid.length > 200 || header2.crit !== void 0) throw new Error();
      let keys = await load(false);
      let jwk = keys.find((key) => key.kid === header2.kid && key.kty === "RSA" && (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig"));
      if (!jwk) {
        keys = await load(true);
        jwk = keys.find((key) => key.kid === header2.kid && key.kty === "RSA" && (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig"));
      }
      if (!jwk || jwk.d) throw new Error();
      const signingKey = createPublicKey({ key: jwk, format: "jwk" });
      if ((signingKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 || !verify("RSA-SHA256", Buffer.from(`${segments[0]}.${segments[1]}`), signingKey, Buffer.from(segments[2], "base64url"))) throw new Error();
      const seconds = now() / 1e3;
      const audience2 = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
      if (claims.iss !== options.issuer || typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255 || !Array.isArray(audience2) || !audience2.every((value) => typeof value === "string") || !audience2.includes(options.audience)) throw new Error();
      if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= seconds) throw new Error();
      if (claims.nbf !== void 0 && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > seconds)) throw new Error();
      if (claims.iat !== void 0 && (typeof claims.iat !== "number" || !Number.isFinite(claims.iat) || claims.iat > seconds + 30)) throw new Error();
      const authTime = typeof claims.auth_time === "number" && Number.isFinite(claims.auth_time) && claims.auth_time >= 0 ? claims.auth_time * 1e3 : 0;
      if (authTime > now() + 3e4) throw new Error();
      const amr = Array.isArray(claims.amr) ? claims.amr.filter((value) => typeof value === "string") : [];
      const strongAuth = amr.includes("mfa") || amr.includes("pwd") && amr.includes("otp") || typeof claims.acr === "string" && (options.mfaAcrValues ?? []).includes(claims.acr);
      return { issuer: claims.iss, subject: claims.sub, strongAuth, authenticatedAt: authTime };
    } catch {
      throw new AccessError("INVALID_SESSION", 401, "A valid authenticated session is required.");
    }
  };
}

// apps/api/src/store.ts
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

// packages/domain/src/live-events.ts
function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}
function duration(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer.`);
}
function effectiveTime(state, requested) {
  if (state.half !== 1 && state.half !== 2) throw new Error("An effective match event requires a started half.");
  const time = requested ?? { half: state.half, halfElapsedMs: state.halfActiveMs, matchElapsedMs: state.matchActiveMs };
  if (time.half !== 1 && time.half !== 2) throw new Error("Effective half must be one or two.");
  duration(time.halfElapsedMs, "Effective half time");
  duration(time.matchElapsedMs, "Effective match time");
  if (time.half > state.half) throw new Error("Effective time cannot refer to a half that has not started.");
  const firstHalf = state.firstHalfDurationMs;
  if (time.half === 2 && firstHalf === null) throw new Error("Second-half time requires the recorded actual first-half duration.");
  const expected = (time.half === 2 ? firstHalf ?? 0 : 0) + time.halfElapsedMs;
  if (expected !== time.matchElapsedMs) throw new Error("Effective cumulative time must use actual first-half duration and exclude half-time.");
  const maximum = time.half === 1 && firstHalf !== null ? firstHalf : state.halfActiveMs;
  if (time.halfElapsedMs > maximum || time.matchElapsedMs > state.matchActiveMs) throw new Error("Effective time cannot invent future active play.");
  return { ...time };
}
function wasOnPitch(state, playerId, time) {
  if (time.matchElapsedMs === state.matchActiveMs && time.half === state.half && state.lineup.some((item) => item.playerId === playerId)) return true;
  return state.intervals.some((interval) => interval.playerId === playerId && interval.state === "playing" && interval.half === time.half && interval.startMs <= time.matchElapsedMs && interval.endMs >= time.matchElapsedMs);
}
function goalRecord(state, details, eventId, recordedAtMs) {
  if (details.beneficiary !== "us" && details.beneficiary !== "opposition") throw new Error("Goal beneficiary is invalid.");
  if (details.isOwnGoal !== void 0 && typeof details.isOwnGoal !== "boolean") throw new Error("Own-goal classification must be explicit.");
  const isOwnGoal = details.isOwnGoal ?? false;
  const scorerPlayerId = details.scorerPlayerId ?? null;
  const goalType = details.goalType ?? "not_recorded";
  if (!["open_play", "free_kick", "penalty", "not_recorded"].includes(goalType)) throw new Error("Goal type is invalid.");
  const effective = effectiveTime(state, details.effective);
  if (scorerPlayerId !== null) {
    if (!state.config.selectedPlayerIds.includes(scorerPlayerId)) throw new Error("A scorer must belong to this selected match squad.");
    if (details.beneficiary === "us" && isOwnGoal || details.beneficiary === "opposition" && !isOwnGoal) {
      throw new Error("An opposition scorer or opposition own goal cannot credit a team player.");
    }
    if (!wasOnPitch(state, scorerPlayerId, effective)) throw new Error("The scorer has no recorded on-pitch evidence at the effective goal time. Correct participation separately before attributing this goal.");
  }
  return { eventId, latestEventId: eventId, beneficiary: details.beneficiary, isOwnGoal, scorerPlayerId, goalType, effective, recordedAtMs, voided: false };
}
function scoresFromGoals(state, goals) {
  const active = goals.filter((goal) => !goal.voided);
  const sum = (values) => ({
    for: values.filter((goal) => goal.beneficiary === "us").length,
    against: values.filter((goal) => goal.beneficiary === "opposition").length
  });
  return {
    score: sum(active),
    halfTimeScore: state.firstHalfDurationMs === null ? state.halfTimeScore : sum(active.filter((goal) => goal.effective.half === 1))
  };
}

// packages/domain/src/index.ts
var ENGINE_VERSION = "synthetic-live-2";
function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer.`);
}
function assertSample(sample) {
  if (!Number.isFinite(sample.monotonicMs) || sample.monotonicMs < 0 || !sample.sessionId) throw new Error("Clock sample is invalid.");
  integer(sample.wallTimeMs, "Wall time");
}
function isRunning(state) {
  return state.status === "first_half_running" || state.status === "second_half_running";
}
function isPaused(state) {
  return state.status === "first_half_paused" || state.status === "second_half_paused";
}
function available(state, id3) {
  return state.availability[id3] === true && state.attendance[id3] === "present";
}
function selectedPlayer(state, id3) {
  if (!state.config.selectedPlayerIds.includes(id3)) throw new Error("Player is outside this selected match squad.");
}
function cloneLineup(lineup) {
  return lineup.map((item) => ({ ...item }));
}
function keeperChoice(config, playerId) {
  const snapshot = config.profileSnapshot?.find((profile) => profile.playerId === playerId);
  if (snapshot?.preferences.length) return snapshot.preferences.indexOf("GK") + 1;
  return config.players.find((player) => player.id === playerId)?.goalkeeperChoice ?? 0;
}
function createMatch(config) {
  if (!config.matchId || config.pitchPlaces < 5 || config.pitchPlaces > 11 || !Number.isInteger(config.pitchPlaces)) throw new Error("Match format must have 5\u201311 pitch places.");
  integer(config.plannedHalfDurationMs, "Planned half duration");
  if (config.plannedHalfDurationMs < 3e4) throw new Error("Planned half duration must be at least 30 seconds.");
  const ids = config.players.map((player) => player.id);
  if (new Set(ids).size !== ids.length || new Set(config.selectedPlayerIds).size !== config.selectedPlayerIds.length) throw new Error("Player identifiers must be unique.");
  if (config.selectedPlayerIds.some((id3) => !ids.includes(id3))) throw new Error("Selected players must belong to this roster.");
  if (config.initialAttendance && Object.entries(config.initialAttendance).some(([id3, status]) => !config.selectedPlayerIds.includes(id3) || !["present", "absent", "excused", "not_selected", "not_recorded"].includes(status))) throw new Error("Initial attendance must be explicit valid check-in for the selected squad.");
  if (config.slots && (config.slots.length !== config.pitchPlaces || new Set(config.slots.map((slot) => slot.slotId)).size !== config.slots.length || config.slots.filter((slot) => slot.position === "GK").length !== 1 || config.slots.some((slot) => !slot.slotId || !slot.position))) throw new Error("Saved formation needs one distinct slot per pitch place and exactly one goalkeeper.");
  if (config.profileSnapshot && (new Set(config.profileSnapshot.map((profile) => profile.playerId)).size !== config.profileSnapshot.length || config.profileSnapshot.some((profile) => !ids.includes(profile.playerId) || profile.preferences.length > 3 || new Set(profile.preferences).size !== profile.preferences.length || new Set(profile.eligiblePositions).size !== profile.eligiblePositions.length))) throw new Error("Match profile snapshots must belong to distinct roster players with distinct preferences and eligibility.");
  if (config.fixedKeeperId !== null && (!config.selectedPlayerIds.includes(config.fixedKeeperId) || ![1, 2].includes(keeperChoice(config, config.fixedKeeperId)))) throw new Error("Fixed keeper must be a selected first- or second-choice goalkeeper.");
  return {
    config: cloneValue(config),
    status: "preparation",
    revision: 0,
    attendance: Object.fromEntries(ids.map((id3) => [id3, config.initialAttendance?.[id3] ?? "not_recorded"])),
    availability: Object.fromEntries(ids.map((id3) => [id3, config.selectedPlayerIds.includes(id3)])),
    stagedLineup: [],
    lineup: [],
    half: 0,
    halfActiveMs: 0,
    matchActiveMs: 0,
    firstHalfDurationMs: null,
    anchor: null,
    recoveryRequired: false,
    intervals: [],
    targetIntervals: [],
    score: { for: 0, against: 0 },
    halfTimeScore: null,
    completedAtMs: null,
    completedTimeQuality: null,
    abandonedAtMs: null,
    abandonReason: null,
    recoveryReason: null,
    appliedEvents: {},
    schemaVersion: 2,
    goals: [],
    availabilityHistory: [],
    eventHistory: [],
    audit: []
  };
}
function upgradeMatchState(previous) {
  if (previous.schemaVersion === 2 && previous.goals && previous.availabilityHistory && previous.eventHistory && previous.audit) return previous;
  let events;
  try {
    events = Object.values(previous.appliedEvents).map((signature2) => JSON.parse(signature2));
  } catch {
    throw new Error("Legacy command history cannot be read. Preserve the journal and reconcile it before continuing.");
  }
  const replayed = replayMatch(previous.config, events);
  for (const field of ["status", "revision", "half", "halfActiveMs", "matchActiveMs", "firstHalfDurationMs", "completedAtMs", "completedTimeQuality", "recoveryRequired", "recoveryReason", "attendance", "availability", "anchor", "score", "halfTimeScore", "lineup", "stagedLineup", "intervals", "targetIntervals"]) {
    if (canonical(replayed[field]) !== canonical(previous[field])) throw new Error(`Legacy replay differs at ${field}. Preserve the original journal for explicit reconciliation.`);
  }
  return replayed;
}
function validateLineup(state, lineup, requireComplete = true) {
  const errors = [];
  if (lineup.length > state.config.pitchPlaces || requireComplete && lineup.length !== state.config.pitchPlaces) errors.push(`Choose exactly ${state.config.pitchPlaces} pitch players.`);
  if (new Set(lineup.map((item) => item.playerId)).size !== lineup.length) errors.push("A player can occupy only one pitch place.");
  if (new Set(lineup.map((item) => item.slotId)).size !== lineup.length) errors.push("Each pitch slot must be unique.");
  for (const item of lineup) {
    if (!item.slotId || !item.position) errors.push("Every allocation needs a slot and position.");
    if (!state.config.selectedPlayerIds.includes(item.playerId)) errors.push("Only selected match-squad players can start.");
    else {
      if (state.attendance[item.playerId] !== "present") errors.push(`${item.playerId}: confirm actual attendance first.`);
      if (!state.availability[item.playerId]) errors.push(`${item.playerId}: player is unavailable.`);
    }
    if (state.config.slots && !state.config.slots.some((slot) => slot.slotId === item.slotId && slot.position === item.position)) errors.push("Allocation must use its saved formation slot and position.");
    const profile = state.config.profileSnapshot?.find((snapshot) => snapshot.playerId === item.playerId);
    if (profile && !profile.eligiblePositions.includes(item.position)) errors.push(`${item.playerId}: position is outside the saved match eligibility.`);
  }
  const keepers = lineup.filter((item) => item.position === "GK");
  if (requireComplete && keepers.length !== 1) errors.push("Choose exactly one goalkeeper.");
  if (keepers.length > 1) errors.push("Only one goalkeeper place is allowed.");
  for (const keeper of keepers) {
    const player = state.config.players.find((item) => item.id === keeper.playerId);
    if (!player || ![1, 2].includes(keeperChoice(state.config, keeper.playerId))) errors.push("Goalkeeper cover requires a first- or second-choice eligible keeper.");
    if (state.config.fixedKeeperId && keeper.playerId !== state.config.fixedKeeperId) errors.push("The fixed keeper policy cannot be changed by moving a pitch piece.");
  }
  const qualifying = state.config.players.filter((player) => available(state, player.id) && [1, 2].includes(keeperChoice(state.config, player.id)));
  if (state.config.fixedKeeperId && qualifying.length > 1) errors.push("Multiple qualifying available keepers require a reviewed shared-keeper policy.");
  return [...new Set(errors)];
}
function readClock(state, sample) {
  assertSample(sample);
  let halfActiveMs = state.halfActiveMs;
  let matchActiveMs = state.matchActiveMs;
  let recoveryRequired = state.recoveryRequired;
  if (isRunning(state)) {
    const anchor = state.anchor;
    if (!anchor || anchor.sample.sessionId !== sample.sessionId || sample.monotonicMs < anchor.sample.monotonicMs) recoveryRequired = true;
    if (!recoveryRequired && anchor) {
      const delta = Math.floor(sample.monotonicMs) - Math.floor(anchor.sample.monotonicMs);
      halfActiveMs = anchor.halfActiveMs + delta;
      matchActiveMs = anchor.matchActiveMs + delta;
    }
  }
  return {
    halfActiveMs,
    matchActiveMs,
    remainingMs: Math.max(0, state.config.plannedHalfDurationMs - halfActiveMs),
    addedMs: Math.max(0, halfActiveMs - state.config.plannedHalfDurationMs),
    recoveryRequired
  };
}
function accrue(state, sample) {
  const clock = readClock(state, sample);
  if (clock.recoveryRequired) throw new Error("Time needs checking. Confirm the clock against a referee or trusted source.");
  const durationMs = clock.matchActiveMs - state.matchActiveMs;
  if (!isRunning(state) || durationMs === 0) return state;
  if (state.half !== 1 && state.half !== 2) throw new Error("No active half.");
  const intervals = state.config.selectedPlayerIds.map((playerId) => {
    const allocation = state.lineup.find((item) => item.playerId === playerId);
    const eligible = available(state, playerId);
    return {
      playerId,
      state: allocation ? "playing" : eligible ? "available_bench" : "unavailable",
      position: allocation?.position ?? null,
      slotId: allocation?.slotId ?? null,
      startMs: state.matchActiveMs,
      endMs: clock.matchActiveMs,
      half: state.half
    };
  });
  return {
    ...state,
    halfActiveMs: clock.halfActiveMs,
    matchActiveMs: clock.matchActiveMs,
    anchor: { sample: { ...sample }, halfActiveMs: clock.halfActiveMs, matchActiveMs: clock.matchActiveMs },
    intervals: [...state.intervals, ...intervals],
    targetIntervals: [...state.targetIntervals, {
      durationMs,
      availablePlayerIds: state.config.selectedPlayerIds.filter((id3) => available(state, id3)),
      pitchPlaces: state.config.pitchPlaces,
      fixedKeeperId: state.config.fixedKeeperId && available(state, state.config.fixedKeeperId) ? state.config.fixedKeeperId : null
    }]
  };
}
function ensureLive(state) {
  if (!isRunning(state) && !isPaused(state)) throw new Error("This command requires an active half.");
}
function assertLineup(state, lineup) {
  const errors = validateLineup(state, lineup);
  if (errors.length) throw new Error(errors.join(" "));
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== void 0).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function reduceMatch(previous, event) {
  previous = upgradeMatchState(previous);
  if (!event.id) throw new Error("Event id is required.");
  const signature2 = canonical(event);
  if (previous.appliedEvents[event.id]) {
    if (previous.appliedEvents[event.id] !== signature2) throw new Error("Event id was reused with different content.");
    return previous;
  }
  assertSample(event.sample);
  if ((previous.status === "completed" || previous.status === "abandoned") && event.type !== "event.corrected" && event.type !== "event.voided" && event.type !== "goal.recorded") throw new Error("Completed or abandoned play is read-only. Use an audited correction without reopening the clock.");
  let state = previous;
  let auditEffective;
  let auditPrior = null;
  let auditValue = event;
  if (event.type === "availability.changed" && event.effective) {
    if (previous.half === 0) throw new Error("Preparation availability has no active-time boundary.");
    const latest = accrue(previous, event.sample);
    const boundary = effectiveTime(latest, event.effective);
    if (boundary.half !== previous.half || boundary.matchElapsedMs < previous.matchActiveMs) throw new Error("Historical availability crosses a recorded boundary. Preserve actual intervals and use explicit history reconciliation; no minutes were changed.");
    if (!isRunning(previous) && boundary.matchElapsedMs !== previous.matchActiveMs) throw new Error("Paused or half-time availability must use the current active-time boundary.");
    if (isRunning(previous)) {
      if (!previous.anchor) throw new Error("A continuous anchor is required for an effective availability boundary.");
      const boundarySample = { ...event.sample, monotonicMs: Math.floor(previous.anchor.sample.monotonicMs) + boundary.matchElapsedMs - previous.anchor.matchActiveMs };
      state = accrue(previous, boundarySample);
    } else state = latest;
    auditEffective = boundary;
  } else if (event.type !== "clock.recovery_required" && event.type !== "clock.corrected") state = accrue(previous, event.sample);
  switch (event.type) {
    case "attendance.recorded": {
      selectedPlayer(state, event.playerId);
      if (!["present", "absent", "excused", "not_selected", "not_recorded"].includes(event.status)) throw new Error("Attendance status is invalid.");
      state = { ...state, attendance: { ...state.attendance, [event.playerId]: event.status } };
      if (event.status !== "present") state = { ...state, lineup: state.lineup.filter((item) => item.playerId !== event.playerId), stagedLineup: state.stagedLineup.filter((item) => item.playerId !== event.playerId) };
      break;
    }
    case "availability.changed": {
      selectedPlayer(state, event.playerId);
      if (typeof event.available !== "boolean") throw new Error("Availability must be explicitly true or false.");
      const reason = event.reason ?? "other";
      if (!["arrival", "departure", "injury", "return", "other"].includes(reason)) throw new Error("Availability reason must be an approved category.");
      if ((reason === "arrival" || reason === "return") && !event.available) throw new Error("Arrival or return requires confirmed availability.");
      if ((reason === "departure" || reason === "injury") && event.available) throw new Error("Injury or departure requires unavailable status.");
      const record = {
        eventId: event.id,
        latestEventId: event.id,
        playerId: event.playerId,
        available: event.available,
        previousAvailability: state.availability[event.playerId],
        reason,
        effective: auditEffective ?? (state.half === 0 ? null : effectiveTime(state)),
        recordedAtMs: event.sample.wallTimeMs
      };
      auditPrior = { available: record.previousAvailability, lineup: cloneLineup(state.lineup) };
      state = { ...state, availability: { ...state.availability, [event.playerId]: event.available } };
      if (!event.available) state = { ...state, lineup: state.lineup.filter((item) => item.playerId !== event.playerId), stagedLineup: state.stagedLineup.filter((item) => item.playerId !== event.playerId) };
      if (event.replacementLineup) {
        ensureLive(state);
        assertLineup(state, event.replacementLineup);
        state = { ...state, lineup: cloneLineup(event.replacementLineup) };
      }
      state = { ...state, availabilityHistory: [...state.availabilityHistory ?? [], record] };
      auditEffective = record.effective;
      auditValue = record;
      state = accrue(state, event.sample);
      break;
    }
    case "lineup.staged": {
      if (state.status !== "preparation" && state.status !== "half_time") throw new Error("Only preparation and half-time have a staged lineup.");
      const errors = validateLineup(state, event.lineup, false);
      if (errors.length) throw new Error(errors.join(" "));
      state = { ...state, stagedLineup: cloneLineup(event.lineup) };
      break;
    }
    case "half.started": {
      if (state.status !== "preparation" && state.status !== "half_time") throw new Error("A half can start only from preparation or half-time.");
      assertLineup(state, state.stagedLineup);
      const half = state.status === "preparation" ? 1 : 2;
      state = {
        ...state,
        half,
        status: half === 1 ? "first_half_running" : "second_half_running",
        lineup: cloneLineup(state.stagedLineup),
        halfActiveMs: 0,
        anchor: { sample: { ...event.sample }, halfActiveMs: 0, matchActiveMs: state.matchActiveMs }
      };
      break;
    }
    case "half.paused": {
      if (!isRunning(state)) throw new Error("Only a running half can pause.");
      state = { ...state, status: state.half === 1 ? "first_half_paused" : "second_half_paused", anchor: null };
      break;
    }
    case "half.resumed": {
      if (!isPaused(state)) throw new Error("Only a paused half can resume.");
      assertLineup(state, state.lineup);
      state = { ...state, status: state.half === 1 ? "first_half_running" : "second_half_running", anchor: { sample: { ...event.sample }, halfActiveMs: state.halfActiveMs, matchActiveMs: state.matchActiveMs } };
      break;
    }
    case "half.ended": {
      ensureLive(state);
      if (state.half === 1) state = { ...state, status: "half_time", anchor: null, firstHalfDurationMs: state.halfActiveMs, halfTimeScore: { ...state.score }, stagedLineup: cloneLineup(state.lineup) };
      else state = { ...state, status: "completed", anchor: null, completedAtMs: event.sample.wallTimeMs, completedTimeQuality: "reviewRequired" };
      break;
    }
    case "match.abandoned": {
      if (state.half === 0) throw new Error("Only a started match can be abandoned; cancel an unplayed fixture separately.");
      if (!["weather", "safety", "insufficient_players", "other"].includes(event.reason) || (event.note?.length ?? 0) > 200) throw new Error("Abandonment requires an approved reason category and a note of at most 200 characters.");
      state = { ...state, status: "abandoned", anchor: null, abandonedAtMs: event.sample.wallTimeMs, abandonReason: event.reason };
      break;
    }
    case "lineup.committed": {
      ensureLive(state);
      if (event.sourceRevision !== previous.revision) throw new Error("Lineup draft is stale. Review against the current match revision.");
      assertLineup(state, event.lineup);
      state = { ...state, lineup: cloneLineup(event.lineup) };
      break;
    }
    case "goal.recorded": {
      const recorded = goalRecord(state, event, event.id, event.sample.wallTimeMs);
      if (!isRunning(state) && !isPaused(state) || recorded.effective.half !== state.half) {
        if (!event.effective || !event.lateEntryReason?.trim()) throw new Error("A goal entered outside its active half needs its actual effective time and a late-entry reason.");
      }
      const goals = [...state.goals ?? [], recorded];
      state = { ...state, goals, ...scoresFromGoals(state, goals) };
      auditEffective = recorded.effective;
      auditValue = recorded;
      break;
    }
    case "event.corrected": {
      if (!event.reason.trim() || event.reason.length > 500) throw new Error("An audited correction needs a reason of 1\u2013500 characters.");
      const goal = state.goals?.find((item) => item.eventId === event.targetEventId || item.latestEventId === event.targetEventId);
      if (goal) {
        if (event.replacement.type !== "goal.recorded") throw new Error("A correction cannot change the original event family.");
        if (goal.voided && event.restoreVoided !== true) throw new Error("Restoring a voided goal requires explicit restoreVoided confirmation.");
        const corrected = goalRecord(state, { ...goal, ...event.replacement, effective: event.replacement.effective ?? goal.effective }, goal.eventId, goal.recordedAtMs);
        const replacement = { ...corrected, latestEventId: event.id };
        const goals = state.goals.map((item) => item.eventId === goal.eventId ? replacement : item);
        state = { ...state, goals, ...scoresFromGoals(state, goals) };
        auditEffective = replacement.effective;
        auditPrior = goal;
        auditValue = replacement;
        break;
      }
      const availability = state.availabilityHistory?.find((item) => item.eventId === event.targetEventId || item.latestEventId === event.targetEventId);
      if (availability) {
        if (event.replacement.type !== "availability.changed") throw new Error("A correction cannot change the original event family.");
        const replacement = event.replacement;
        if (replacement.playerId !== availability.playerId || replacement.available !== availability.available || replacement.replacementLineup || replacement.effective && canonical(replacement.effective) !== canonical(availability.effective)) {
          throw new Error("Historical availability or lineup correction needs explicit interval reconciliation. Actual participation was retained unchanged.");
        }
        const reason = replacement.reason ?? availability.reason;
        if (!["arrival", "departure", "injury", "return", "other"].includes(reason) || (reason === "arrival" || reason === "return") && !availability.available || (reason === "injury" || reason === "departure") && availability.available) throw new Error("Corrected availability reason conflicts with its recorded state.");
        const corrected = { ...availability, reason, latestEventId: event.id };
        state = { ...state, availabilityHistory: state.availabilityHistory.map((item) => item.eventId === availability.eventId ? corrected : item) };
        auditEffective = corrected.effective;
        auditPrior = availability;
        auditValue = corrected;
        break;
      }
      if (state.eventHistory?.some((item) => item.id === event.targetEventId)) throw new Error("This historical interval or half transition needs explicit reconciliation of the affected play. No recorded minutes were changed.");
      throw new Error("Correction target was not found in this match history.");
    }
    case "event.voided": {
      if (!event.reason.trim() || event.reason.length > 500) throw new Error("Voiding an event needs an audited reason of 1\u2013500 characters.");
      const goal = state.goals?.find((item) => item.eventId === event.targetEventId || item.latestEventId === event.targetEventId);
      if (!goal) {
        if (state.eventHistory?.some((item) => item.id === event.targetEventId)) throw new Error("Voiding a participation or half event requires explicit interval reconciliation. Original history was retained.");
        throw new Error("Void target was not found in this match history.");
      }
      if (goal.voided) throw new Error("This goal is already voided.");
      const replacement = { ...goal, voided: true, latestEventId: event.id };
      const goals = state.goals.map((item) => item.eventId === goal.eventId ? replacement : item);
      state = { ...state, goals, ...scoresFromGoals(state, goals) };
      auditEffective = replacement.effective;
      auditPrior = goal;
      auditValue = replacement;
      break;
    }
    case "clock.recovery_required": {
      if (!isRunning(state)) throw new Error("Only a running clock needs continuity recovery.");
      if (!event.reason.trim()) throw new Error("A recovery reason is required.");
      state = { ...state, recoveryRequired: true, recoveryReason: event.reason };
      break;
    }
    case "clock.corrected": {
      ensureLive(state);
      if (!isRunning(state) || !(state.recoveryRequired || readClock(state, event.sample).recoveryRequired)) throw new Error("Clock correction is only available for an uncertain running-clock recovery.");
      if (event.confirmUnchangedLineup !== true) throw new Error("Confirm unchanged lineup and availability since the secure checkpoint, or reconcile history separately.");
      if (!event.reason.trim()) throw new Error("Record the referee/trusted-source reason for a clock correction.");
      integer(event.halfActiveMs, "Corrected active half time");
      if (event.halfActiveMs < state.halfActiveMs) throw new Error("Backdated clock correction needs audited history reconciliation, outside this M0 slice.");
      const newMatchMs = (state.half === 2 ? state.firstHalfDurationMs ?? 0 : 0) + event.halfActiveMs;
      if (newMatchMs < state.matchActiveMs) throw new Error("Clock correction cannot discard recorded participation.");
      if (isRunning(state) && newMatchMs > state.matchActiveMs) {
        const syntheticSample = { ...event.sample, sessionId: "explicit-referee-correction", monotonicMs: newMatchMs - state.matchActiveMs };
        state = accrue({ ...state, recoveryRequired: false, anchor: { sample: { ...syntheticSample, monotonicMs: 0 }, halfActiveMs: state.halfActiveMs, matchActiveMs: state.matchActiveMs } }, syntheticSample);
      }
      state = { ...state, halfActiveMs: event.halfActiveMs, matchActiveMs: newMatchMs, recoveryRequired: false, recoveryReason: null, anchor: isRunning(state) ? { sample: { ...event.sample }, halfActiveMs: event.halfActiveMs, matchActiveMs: newMatchMs } : null };
      break;
    }
    default:
      throw new Error("Unsupported match command type.");
  }
  const audit = {
    eventId: event.id,
    type: event.type,
    revision: previous.revision + 1,
    recordedAtMs: event.sample.wallTimeMs,
    actorId: event.actorId ?? null,
    effective: auditEffective === void 0 ? state.half === 0 ? null : effectiveTime(state) : auditEffective,
    targetEventId: "targetEventId" in event ? event.targetEventId : null,
    reason: "reason" in event ? event.reason ?? null : event.type === "goal.recorded" ? event.lateEntryReason ?? null : null,
    priorValue: cloneValue(auditPrior),
    value: cloneValue(auditValue)
  };
  return {
    ...state,
    revision: previous.revision + 1,
    appliedEvents: { ...previous.appliedEvents, [event.id]: signature2 },
    eventHistory: [...previous.eventHistory ?? [], cloneValue(event)],
    audit: [...previous.audit ?? [], audit]
  };
}
function replayMatch(config, events) {
  return events.reduce(reduceMatch, createMatch(config));
}
function goalRecords(state) {
  return cloneValue(upgradeMatchState(state).goals ?? []);
}
function playerMinutes(state, sample) {
  const clock = readClock(state, sample);
  const projected = clock.recoveryRequired ? state : accrue(state, sample);
  return state.config.selectedPlayerIds.map((playerId) => {
    const result = { playerId, playingMs: 0, benchMs: 0, unavailableMs: 0, positionMs: {} };
    for (const interval of projected.intervals.filter((item) => item.playerId === playerId)) {
      const durationMs = interval.endMs - interval.startMs;
      if (interval.state === "playing") {
        result.playingMs += durationMs;
        if (interval.position) result.positionMs[interval.position] = (result.positionMs[interval.position] ?? 0) + durationMs;
      } else if (interval.state === "available_bench") result.benchMs += durationMs;
      else result.unavailableMs += durationMs;
    }
    return result;
  });
}
function gcd(left, right) {
  return right === 0n ? left : gcd(right, left % right);
}
function rational(numerator, denominator = 1n) {
  if (denominator <= 0n || numerator < 0n) throw new Error("Rational target must be nonnegative with a positive denominator.");
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}
function add(left, right) {
  return rational(left.numerator * right.denominator + right.numerator * left.denominator, left.denominator * right.denominator);
}
function scale(value, numerator, denominator) {
  return rational(value.numerator * numerator, value.denominator * denominator);
}
function rationalToNumber(value) {
  return Number(value.numerator) / Number(value.denominator);
}
function withinTargetBand(actualMs, target) {
  integer(actualMs, "Actual playing time");
  const actual = BigInt(actualMs);
  return actual * target.lower.denominator >= target.lower.numerator && actual * target.upper.denominator <= target.upper.numerator;
}
function calculateTargets(intervals, allPlayerIds = []) {
  const totals = new Map(allPlayerIds.map((id3) => [id3, rational(0n)]));
  for (const interval of intervals) {
    integer(interval.durationMs, "Target interval duration");
    integer(interval.pitchPlaces, "Target pitch capacity");
    const ids = interval.availablePlayerIds;
    if (new Set(ids).size !== ids.length) throw new Error("Target interval repeats an available player.");
    if (interval.fixedKeeperId && !ids.includes(interval.fixedKeeperId)) throw new Error("Fixed keeper is not available in this target interval.");
    const count = ids.length;
    const capacity = Math.min(interval.pitchPlaces, count);
    if (capacity === 0) continue;
    for (const playerId of ids) {
      let contribution;
      if (playerId === interval.fixedKeeperId) contribution = rational(BigInt(interval.durationMs));
      else if (interval.fixedKeeperId) contribution = rational(BigInt(interval.durationMs) * BigInt(capacity - 1), BigInt(count - 1));
      else contribution = rational(BigInt(interval.durationMs) * BigInt(capacity), BigInt(count));
      totals.set(playerId, add(totals.get(playerId) ?? rational(0n), contribution));
    }
  }
  return [...totals].map(([playerId, target]) => ({ playerId, target, lower: scale(target, 9n, 10n), upper: scale(target, 11n, 10n) }));
}
function currentTargets(state, sample) {
  const clock = readClock(state, sample);
  const projected = clock.recoveryRequired ? state : accrue(state, sample);
  return calculateTargets(projected.targetIntervals, state.config.selectedPlayerIds);
}

// fixtures/roma.synthetic.json
var roma_synthetic_default = {
  synthetic: true,
  teamId: "synthetic-roma-u10",
  season: "2026/27",
  timeZone: "Europe/London",
  pitchPlaces: 7,
  plannedHalfDurationMs: 15e5,
  players: [
    {
      id: "synthetic-player-01",
      displayName: "Player 01",
      available: true,
      goalkeeperChoice: 1
    },
    {
      id: "synthetic-player-02",
      displayName: "Player 02",
      available: true,
      goalkeeperChoice: 0
    },
    {
      id: "synthetic-player-03",
      displayName: "Player 03",
      available: true,
      goalkeeperChoice: 0
    },
    {
      id: "synthetic-player-04",
      displayName: "Player 04",
      available: true,
      goalkeeperChoice: 0
    },
    {
      id: "synthetic-player-05",
      displayName: "Player 05",
      available: true,
      goalkeeperChoice: 0
    },
    {
      id: "synthetic-player-06",
      displayName: "Player 06",
      available: true,
      goalkeeperChoice: 0
    },
    {
      id: "synthetic-player-07",
      displayName: "Player 07",
      available: true,
      goalkeeperChoice: 0
    },
    {
      id: "synthetic-player-08",
      displayName: "Player 08",
      available: true,
      goalkeeperChoice: 0
    },
    {
      id: "synthetic-player-09",
      displayName: "Player 09",
      available: true,
      goalkeeperChoice: 0
    },
    {
      id: "synthetic-player-10",
      displayName: "Player 10",
      available: false,
      goalkeeperChoice: 0
    },
    {
      id: "synthetic-player-11",
      displayName: "Player 11",
      available: false,
      goalkeeperChoice: 0
    },
    {
      id: "synthetic-player-12",
      displayName: "Player 12",
      available: false,
      goalkeeperChoice: 0
    },
    {
      id: "synthetic-player-13",
      displayName: "Player 13",
      available: false,
      goalkeeperChoice: 0
    }
  ]
};

// packages/testing/src/index.ts
var romaFixture = roma_synthetic_default;

// packages/application/src/preparation.ts
var positionCodes = [
  "GK",
  "CB",
  "LB",
  "RB",
  "CM",
  "LW",
  "RW",
  "ST"
];
function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}
var clone = (value) => JSON.parse(JSON.stringify(value));
function text(value, label, maximum = 80) {
  requireThat(
    typeof value === "string" && value.trim().length > 0 && value.trim().length <= maximum,
    `${label} is required and must be at most ${maximum} characters.`
  );
  return value.trim();
}
function canonical2(value) {
  if (Array.isArray(value)) return `[${value.map(canonical2).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical2(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function validDate(value) {
  const date = /* @__PURE__ */ new Date(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validTime2(value) {
  return value === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
function validateFormat(format) {
  requireThat(
    Number.isInteger(format) && format >= 5 && format <= 11,
    "Choose a format from five to eleven players."
  );
}
function validateHalf(duration2) {
  requireThat(
    Number.isSafeInteger(duration2) && duration2 > 0 && duration2 % 1e3 === 0,
    "Each planned half must be a positive whole number of seconds."
  );
}
function validateLogo(logo) {
  requireThat(
    logo === null || ["roundel", "shield", "ball"].includes(logo),
    "Choose one of the original fictional badges."
  );
}
function activeSeason(state, seasonId) {
  const season = state.seasons.find((item) => item.id === seasonId);
  requireThat(season, "Season not found.");
  requireThat(
    seasonId === state.activeSeasonId,
    "Past seasons are read-only here. Their records are retained unchanged."
  );
  return season;
}
function dateInSeason(state, seasonId, date) {
  const season = activeSeason(state, seasonId);
  requireThat(
    validDate(date) && date >= season.startDate && date <= season.endDate,
    "Choose a valid date within the selected September-to-August season."
  );
}
function checkProfile(state, profileId, seasonId) {
  const profile = state.profiles.find(
    (item) => item.id === profileId && item.seasonId === seasonId && item.active
  );
  requireThat(profile, "Choose an active player from this team and season.");
  return profile;
}
function validResponse(value) {
  requireThat(
    ["available", "unavailable", "unsure", "no_reply"].includes(value),
    "Choose an availability response."
  );
}
function validAttendance(value) {
  requireThat(
    ["present", "absent", "not_recorded"].includes(value),
    "Choose Present, Absent or Not recorded."
  );
}
function unique2(ids) {
  requireThat(
    new Set(ids).size === ids.length,
    "Each player or slot can appear only once."
  );
}
function seasonBounds(startYear) {
  requireThat(
    Number.isInteger(startYear) && startYear >= 2e3 && startYear <= 2100,
    "Choose a season start year between 2000 and 2100."
  );
  return {
    startDate: `${startYear}-09-01`,
    endDate: `${startYear + 1}-08-31`,
    label: `${startYear}/${String(startYear + 1).slice(-2)}`
  };
}
function seasonPlayers(state, seasonId = state.activeSeasonId) {
  return state.profiles.filter(
    (profile) => profile.seasonId === seasonId && profile.active
  );
}
function goalkeeperChoice(profile) {
  const rank = profile.preferences.indexOf("GK") + 1;
  return profile.eligiblePositions.includes("GK") && (rank === 1 || rank === 2) ? rank : 0;
}
function defaultFormation(format) {
  validateFormat(format);
  const roles = {
    5: ["GK", "CB", "CB", "CM", "ST"],
    6: ["GK", "CB", "CB", "LW", "RW", "ST"],
    7: ["GK", "CB", "CB", "CM", "LW", "RW", "ST"],
    8: ["GK", "LB", "CB", "RB", "CM", "LW", "RW", "ST"],
    9: ["GK", "LB", "CB", "CB", "RB", "CM", "LW", "RW", "ST"],
    10: ["GK", "LB", "CB", "CB", "RB", "CM", "CM", "LW", "RW", "ST"],
    11: ["GK", "LB", "CB", "CB", "RB", "CM", "CM", "LW", "RW", "ST", "ST"]
  };
  const count = {};
  const row = (position) => position === "GK" ? 0.9 : ["CB", "LB", "RB"].includes(position) ? 0.72 : position === "CM" ? 0.5 : ["LW", "RW"].includes(position) ? 0.32 : 0.13;
  return {
    id: `formation-${format}`,
    name: `${format}-a-side`,
    format,
    version: 1,
    slots: roles[format].map((position) => {
      const ordinal = count[position] = (count[position] ?? 0) + 1;
      const peers = roles[format].filter((role) => row(role) === row(position));
      const index = roles[format].slice(
        0,
        roles[format].findIndex(
          (role, i) => role === position && roles[format].slice(0, i + 1).filter((p) => p === position).length === ordinal
        )
      ).filter((role) => row(role) === row(position)).length;
      return {
        id: `${position.toLowerCase()}-${ordinal}`,
        position,
        label: `${position}${roles[format].filter((role) => role === position).length > 1 ? ordinal : ""}`,
        x: (index + 1) / (peers.length + 1),
        y: row(position)
      };
    })
  };
}
function prepareFixtureSnapshot(state, fixtureId, formationId) {
  const fixture = state.fixtures.find((item) => item.id === fixtureId);
  requireThat(
    fixture && fixture.status === "scheduled",
    "Only a scheduled match can be prepared."
  );
  activeSeason(state, fixture.seasonId);
  const formation = state.formations.find(
    (item) => item.id === (formationId ?? `formation-${fixture.format}`)
  );
  requireThat(
    formation && formation.format === fixture.format,
    "Choose a saved formation for this match format."
  );
  requireThat(
    fixture.selectedProfileIds.length >= fixture.format,
    "Select enough players for the match format."
  );
  const profiles = fixture.selectedProfileIds.map(
    (id3) => checkProfile(state, id3, fixture.seasonId)
  );
  requireThat(
    profiles.some((profile) => goalkeeperChoice(profile) > 0),
    "Select a first- or second-choice eligible goalkeeper."
  );
  const {
    responses: _responses,
    attendance: _attendance,
    selectedProfileIds: _selected,
    history: _history,
    status: _status,
    ...draft
  } = fixture;
  return clone({
    id: `${fixture.id}@${state.revision + 1}`,
    fixtureId,
    seasonId: fixture.seasonId,
    preparedRevision: state.revision + 1,
    fixture: draft,
    formation,
    profiles,
    selectedPlayerIds: profiles.map((profile) => profile.playerId),
    attendance: Object.fromEntries(
      profiles.map((profile) => [
        profile.playerId,
        fixture.attendance[profile.id] ?? "not_recorded"
      ])
    )
  });
}
function reducePreparation(previous, command) {
  requireThat(
    command.id && typeof command.id === "string",
    "A stable command identity is required."
  );
  const signature2 = canonical2(command);
  if (previous.appliedCommands[command.id]) {
    requireThat(
      previous.appliedCommands[command.id] === signature2,
      "This command identity already belongs to different content."
    );
    return previous;
  }
  requireThat(
    command.expectedRevision === previous.revision,
    "Preparation changed on another screen. Reload the saved version before applying this change."
  );
  const state = clone(previous);
  const revision = state.revision + 1;
  switch (command.type) {
    case "club.updated":
      validateLogo(command.logo);
      state.club = {
        ...state.club,
        name: text(command.name, "Club name"),
        logo: command.logo
      };
      break;
    case "team.updated":
      validateLogo(command.logo);
      validateFormat(command.defaultPitchPlaces);
      validateHalf(command.defaultHalfDurationMs);
      state.team = {
        ...state.team,
        name: text(command.name, "Team name"),
        ageGroup: text(command.ageGroup, "Age group", 12),
        defaultPitchPlaces: command.defaultPitchPlaces,
        defaultHalfDurationMs: command.defaultHalfDurationMs,
        logo: command.logo
      };
      break;
    case "season.rolled_over": {
      requireThat(
        command.confirmSpectatorRenewal === true,
        "Confirm that spectator access must be renewed explicitly."
      );
      const old = state.seasons.find(
        (item) => item.id === state.activeSeasonId
      );
      requireThat(
        command.startYear === old.startYear + 1,
        "Rollover creates the immediately following September-to-August season."
      );
      requireThat(
        !state.seasons.some(
          (item) => item.id === command.idForSeason || item.startYear === command.startYear
        ),
        "That season already exists."
      );
      const season = {
        id: text(command.idForSeason, "Season identity"),
        startYear: command.startYear,
        ...seasonBounds(command.startYear),
        spectatorRenewalRequired: true
      };
      if (command.copyPlayers)
        state.profiles.push(
          ...seasonPlayers(state).map((profile) => ({
            ...clone(profile),
            id: `${profile.playerId}:${season.id}`,
            seasonId: season.id
          }))
        );
      state.seasons.push(season);
      state.activeSeasonId = season.id;
      break;
    }
    case "profile.saved": {
      const profile = clone(command.profile);
      activeSeason(state, profile.seasonId);
      text(profile.id, "Profile identity");
      text(profile.playerId, "Player identity");
      const existing = state.profiles.find((item) => item.id === profile.id);
      if (existing)
        requireThat(
          existing.playerId === profile.playerId && existing.seasonId === profile.seasonId,
          "Profile identity and season cannot be reassigned."
        );
      requireThat(
        !state.profiles.some(
          (item) => item.id !== profile.id && item.seasonId === profile.seasonId && item.playerId === profile.playerId
        ),
        "That player already has a profile in this season."
      );
      profile.displayName = text(profile.displayName, "Display name", 60);
      requireThat(
        typeof profile.initials === "string" && /^[A-Za-z0-9]{1,2}$/.test(profile.initials),
        "Use one or two letters or digits for the pitch label."
      );
      profile.initials = profile.initials.toUpperCase();
      requireThat(
        profile.shirtNumber === null || Number.isInteger(profile.shirtNumber) && profile.shirtNumber >= 1 && profile.shirtNumber <= 99,
        "Shirt number must be one to 99 or not recorded."
      );
      requireThat(
        !state.profiles.some(
          (item) => item.id !== profile.id && item.seasonId === profile.seasonId && item.active && profile.active && profile.shirtNumber !== null && item.shirtNumber === profile.shirtNumber
        ),
        "Another active player already has that shirt number."
      );
      requireThat(
        profile.preferences.length === 3 && new Set(profile.preferences).size === 3 && profile.preferences.every(
          (position) => positionCodes.includes(position)
        ),
        "Choose three different ranked positions."
      );
      requireThat(
        profile.eligiblePositions.length > 0 && new Set(profile.eligiblePositions).size === profile.eligiblePositions.length && profile.eligiblePositions.every(
          (position) => positionCodes.includes(position)
        ),
        "Choose distinct manager-approved eligible positions."
      );
      requireThat(
        ["left", "right", "both", "not_recorded"].includes(profile.foot),
        "Choose a preferred foot or Not recorded."
      );
      state.profiles = state.profiles.filter((item) => item.id !== profile.id);
      state.profiles.push(profile);
      break;
    }
    case "profile.archived": {
      const profile = state.profiles.find(
        (item) => item.id === command.profileId
      );
      requireThat(profile, "Player profile not found.");
      activeSeason(state, profile.seasonId);
      profile.active = false;
      break;
    }
    case "formation.saved": {
      const formation = clone(command.formation);
      validateFormat(formation.format);
      formation.name = text(formation.name, "Formation name", 40);
      requireThat(
        formation.slots.length === formation.format && formation.slots.filter((slot) => slot.position === "GK").length === 1,
        "A formation needs the chosen number of slots and exactly one goalkeeper."
      );
      unique2(formation.slots.map((slot) => slot.id));
      for (const slot of formation.slots) {
        requireThat(
          slot.id.length > 0 && positionCodes.includes(slot.position),
          "Each slot needs an identity and position type."
        );
        slot.label = text(slot.label, "Slot label", 16);
        requireThat(
          Number.isFinite(slot.x) && slot.x >= 0 && slot.x <= 1 && Number.isFinite(slot.y) && slot.y >= 0 && slot.y <= 1,
          "Formation coordinates must be between zero and one."
        );
      }
      const version = (state.formations.find((item) => item.id === formation.id)?.version ?? 0) + 1;
      state.formations = state.formations.filter(
        (item) => item.id !== formation.id
      );
      state.formations.push({ ...formation, version });
      break;
    }
    case "fixture.saved": {
      const fixture = clone(command.fixture);
      dateInSeason(state, fixture.seasonId, fixture.playedDate);
      validateFormat(fixture.format);
      validateHalf(fixture.plannedHalfDurationMs);
      fixture.opponent = text(fixture.opponent, "Opposition");
      requireThat(
        validTime2(fixture.kickoff) && validTime2(fixture.arrival),
        "Use 24-hour HH:MM times, or leave time not recorded."
      );
      requireThat(
        ["home", "away"].includes(fixture.homeAway),
        "Choose home or away."
      );
      const existing = state.fixtures.find((item) => item.id === fixture.id);
      if (existing)
        requireThat(
          existing.seasonId === fixture.seasonId && existing.status !== "cancelled",
          "Cancelled matches must be restored explicitly before rescheduling."
        );
      const status = "scheduled";
      const updated = {
        ...fixture,
        status,
        selectedProfileIds: existing?.selectedProfileIds ?? [],
        responses: existing?.responses ?? {},
        attendance: existing?.attendance ?? {},
        history: [
          ...existing?.history ?? [],
          {
            revision,
            action: existing ? "rescheduled" : "created",
            playedDate: fixture.playedDate,
            kickoff: fixture.kickoff,
            status
          }
        ]
      };
      state.fixtures = state.fixtures.filter((item) => item.id !== fixture.id);
      state.fixtures.push(updated);
      break;
    }
    case "fixture.status_changed": {
      const fixture = state.fixtures.find(
        (item) => item.id === command.fixtureId
      );
      requireThat(fixture, "Match not found.");
      activeSeason(state, fixture.seasonId);
      requireThat(
        ["scheduled", "postponed", "cancelled"].includes(command.status),
        "Choose a valid fixture state."
      );
      fixture.status = command.status;
      fixture.history.push({
        revision,
        action: command.status,
        playedDate: fixture.playedDate,
        kickoff: fixture.kickoff,
        status: command.status
      });
      break;
    }
    case "fixture.response_recorded":
    case "fixture.selection_saved":
    case "fixture.attendance_recorded": {
      const fixture = state.fixtures.find(
        (item) => item.id === command.fixtureId
      );
      requireThat(fixture, "Match not found.");
      activeSeason(state, fixture.seasonId);
      requireThat(
        fixture.status === "scheduled",
        "Only a scheduled match can collect responses, selection or attendance."
      );
      if (command.type === "fixture.selection_saved") {
        unique2(command.selectedProfileIds);
        command.selectedProfileIds.forEach(
          (id3) => checkProfile(state, id3, fixture.seasonId)
        );
        fixture.selectedProfileIds = [...command.selectedProfileIds];
      } else {
        checkProfile(state, command.profileId, fixture.seasonId);
        if (command.type === "fixture.response_recorded") {
          validResponse(command.response);
          fixture.responses[command.profileId] = command.response;
        } else {
          validAttendance(command.attendance);
          requireThat(
            fixture.selectedProfileIds.includes(command.profileId),
            "Only selected match players can be checked in."
          );
          fixture.attendance[command.profileId] = command.attendance;
        }
      }
      break;
    }
    case "fixture.prepared": {
      const snapshot = prepareFixtureSnapshot(
        state,
        command.fixtureId,
        command.formationId
      );
      state.snapshots.push(snapshot);
      break;
    }
    case "training.saved": {
      const training = clone(command.training);
      dateInSeason(state, training.seasonId, training.date);
      requireThat(
        validTime2(training.time),
        "Use a 24-hour HH:MM training time."
      );
      unique2(training.expectedProfileIds);
      training.expectedProfileIds.forEach(
        (id3) => checkProfile(state, id3, training.seasonId)
      );
      const existing = state.training.find((item) => item.id === training.id);
      if (existing)
        requireThat(
          existing.seasonId === training.seasonId && existing.status === "scheduled",
          "Held or cancelled training records are retained; create or restore a scheduled occurrence first."
        );
      state.training = state.training.filter((item) => item.id !== training.id);
      state.training.push({
        ...training,
        status: "scheduled",
        responses: existing?.responses ?? {},
        attendance: existing?.attendance ?? {}
      });
      break;
    }
    case "training.status_changed": {
      const training = state.training.find(
        (item) => item.id === command.trainingId
      );
      requireThat(training, "Training occurrence not found.");
      activeSeason(state, training.seasonId);
      requireThat(
        ["scheduled", "held", "cancelled"].includes(command.status),
        "Choose a valid training state."
      );
      training.status = command.status;
      break;
    }
    case "training.response_recorded":
    case "training.attendance_recorded": {
      const training = state.training.find(
        (item) => item.id === command.trainingId
      );
      requireThat(training, "Training occurrence not found.");
      activeSeason(state, training.seasonId);
      checkProfile(state, command.profileId, training.seasonId);
      requireThat(
        training.expectedProfileIds.includes(command.profileId),
        "Only expected players belong to this attendance occurrence."
      );
      if (command.type === "training.response_recorded") {
        requireThat(
          training.status !== "cancelled",
          "Cancelled training cannot collect availability."
        );
        validResponse(command.response);
        training.responses[command.profileId] = command.response;
      } else {
        requireThat(
          training.status === "held",
          "Mark this occurrence as held before recording actual attendance. Cancelled training is excluded."
        );
        validAttendance(command.attendance);
        training.attendance[command.profileId] = command.attendance;
      }
      break;
    }
    default:
      throw new Error(
        "This preparation command is not supported. No saved records were changed."
      );
  }
  state.revision = revision;
  state.appliedCommands[command.id] = signature2;
  state.audit.push({ id: command.id, revision, type: command.type });
  return state;
}
function trainingAttendanceEvidence(state) {
  return state.training.map((session) => ({
    sessionId: session.id,
    playedDate: session.date,
    eventStatus: session.status,
    expectedPlayerIds: session.expectedProfileIds.map(
      (id3) => state.profiles.find((profile) => profile.id === id3)?.playerId
    ).filter((id3) => Boolean(id3)),
    attendance: Object.fromEntries(
      Object.entries(session.attendance).flatMap(([id3, attendance]) => {
        const profile = state.profiles.find((item) => item.id === id3);
        return profile ? [[profile.playerId, attendance]] : [];
      })
    ),
    responses: Object.fromEntries(
      Object.entries(session.responses).flatMap(([id3, response]) => {
        const profile = state.profiles.find((item) => item.id === id3);
        return profile ? [[profile.playerId, response]] : [];
      })
    )
  }));
}
function createPreparationState() {
  const seasonId = "synthetic-season-2026-27";
  const profiles = Array.from({ length: 13 }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    const preferred = index === 0 ? "GK" : [
      "CB",
      "CB",
      "CM",
      "LW",
      "RW",
      "ST",
      "LW",
      "RW",
      "CM",
      "CB",
      "ST",
      "CM"
    ][index - 1];
    const preferences = [
      preferred,
      ...["CM", "CB", "ST", "LW"].filter(
        (position) => position !== preferred
      )
    ].slice(0, 3);
    return {
      id: `synthetic-player-${number}:${seasonId}`,
      playerId: `synthetic-player-${number}`,
      seasonId,
      displayName: `Player ${number}`,
      initials: number,
      shirtNumber: index + 1,
      foot: "not_recorded",
      preferences,
      eligiblePositions: index === 0 ? ["GK", "CB", "ST"] : ["CB", "LB", "RB", "CM", "LW", "RW", "ST"],
      active: true
    };
  });
  const fixture = {
    id: "synthetic-roma-maple-2026-10-24",
    seasonId,
    opponent: "Maple FC",
    playedDate: "2026-10-24",
    kickoff: "10:00",
    arrival: "09:30",
    venue: "Roma recreation ground",
    homeAway: "home",
    format: 7,
    plannedHalfDurationMs: 15e5,
    status: "scheduled",
    selectedProfileIds: profiles.slice(0, 9).map((profile) => profile.id),
    responses: Object.fromEntries(
      profiles.slice(0, 9).map((profile) => [profile.id, "available"])
    ),
    attendance: {},
    history: [
      {
        revision: 0,
        action: "created",
        playedDate: "2026-10-24",
        kickoff: "10:00",
        status: "scheduled"
      }
    ]
  };
  const training = ["2026-10-22", "2026-10-29"].map(
    (date, index) => ({
      id: `synthetic-training-${index + 1}`,
      seasonId,
      date,
      time: "18:00",
      venue: "Roma recreation ground",
      recurrenceGroupId: "synthetic-thursday-training",
      expectedProfileIds: profiles.map((profile) => profile.id),
      status: "scheduled",
      responses: {},
      attendance: {}
    })
  );
  return {
    version: 1,
    synthetic: true,
    revision: 0,
    club: {
      id: "synthetic-richmond-rovers",
      name: "Richmond Rovers",
      logo: "roundel"
    },
    team: {
      id: "synthetic-roma-u10",
      name: "Roma",
      ageGroup: "U10",
      defaultPitchPlaces: 7,
      defaultHalfDurationMs: 15e5,
      logo: null
    },
    activeSeasonId: seasonId,
    seasons: [
      {
        id: seasonId,
        ...seasonBounds(2026),
        startYear: 2026,
        spectatorRenewalRequired: true
      }
    ],
    profiles,
    formations: Array.from(
      { length: 7 },
      (_, index) => defaultFormation(index + 5)
    ),
    fixtures: [fixture],
    training,
    snapshots: [],
    appliedCommands: {},
    audit: []
  };
}

// packages/application/src/records.ts
function clone2(value) {
  return JSON.parse(JSON.stringify(value));
}
function signature(value) {
  if (Array.isArray(value)) return `[${value.map(signature).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== void 0).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${signature(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function nonnegative(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative whole number.`);
}
function validDate2(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && (/* @__PURE__ */ new Date(`${value}T00:00:00Z`)).toISOString().slice(0, 10) === value;
}
function validInstant(value) {
  return Number.isFinite(Date.parse(value)) && /(?:Z|[+-]\d\d:\d\d)$/.test(value);
}
function validateScore(value) {
  if (value) {
    nonnegative(value.for, "Our score");
    nonnegative(value.against, "Opposition score");
  }
}
function managerOnlyPublication(fixtureClass) {
  return { id: "unconfirmed-competition-policy", version: 1, fixtureClass, confirmed: false, confirmationReference: null, allowedRoles: [] };
}
function validateInput(state, input) {
  if (!validDate2(input.playedDate) || input.playedDate < state.startsOn || input.playedDate > state.endsOn) throw new Error("Choose a real played date within this team season.");
  if (!input.opponent.trim()) throw new Error("Record the opposition.");
  if (input.recordedKickoff !== null && !validInstant(input.recordedKickoff)) throw new Error("Known kick-off must include its timezone; otherwise leave it not recorded.");
  if (input.sameDayOrder !== null) nonnegative(input.sameDayOrder, "Same-day order");
  validateScore(input.finalScore);
  validateScore(input.halfTimeScore);
  if (input.halfTimeScore && input.finalScore && (input.halfTimeScore.for > input.finalScore.for || input.halfTimeScore.against > input.finalScore.against)) throw new Error("Half-time goals cannot exceed the final score.");
  if (new Set(input.goals.map((goal) => goal.id)).size !== input.goals.length) throw new Error("Known goals need distinct identifiers.");
  for (const goal of input.goals) {
    if (!goal.id) throw new Error("A known goal needs an identifier.");
    if (goal.scorerPlayerId && !state.players.some((player) => player.id === goal.scorerPlayerId)) throw new Error("The scorer must belong to this archived team-season roster.");
    if ((goal.beneficiary === "opposition" && !goal.isOwnGoal || goal.beneficiary === "us" && goal.isOwnGoal) && goal.scorerPlayerId !== null) throw new Error("An opposition scorer cannot be credited to one of our players.");
    if (goal.halfElapsedMs !== null) {
      nonnegative(goal.halfElapsedMs, "Known goal time");
      if (goal.half === null) throw new Error("A known goal time needs its half.");
    }
  }
  if (input.finalScore && (input.goals.filter((goal) => goal.beneficiary === "us").length > input.finalScore.for || input.goals.filter((goal) => goal.beneficiary === "opposition").length > input.finalScore.against)) throw new Error("Known goal attribution cannot exceed the recorded score.");
}
function historicalRecord(state, id3, input, at) {
  validateInput(state, input);
  return {
    ...clone2(input),
    opponent: input.opponent.trim(),
    id: id3,
    teamId: state.teamId,
    seasonId: state.seasonId,
    recordMode: "historical_summary",
    detailCompleteness: "summary_only",
    publication: managerOnlyPublication(input.fixtureClass),
    classificationVersion: 1,
    selectedPlayerIds: null,
    attendance: null,
    participation: null,
    actualActiveDurationMs: null,
    keeperPolicy: null,
    sourceMatchRevision: null,
    enteredAt: at,
    updatedAt: at,
    revision: 1,
    awardStatus: "not_recorded"
  };
}
function createRecordsSeed() {
  const state = {
    schemaVersion: 1,
    clubId: "synthetic-richmond-rovers",
    teamId: romaFixture.teamId,
    seasonId: "synthetic-season-2026-27",
    seasonLabel: "26/27",
    startsOn: "2026-09-01",
    endsOn: "2027-08-31",
    players: romaFixture.players.map((player) => ({ id: player.id, label: player.displayName })),
    liveMatch: { matchId: "synthetic-roma-maple-2026-10-24", playedDate: "2026-10-24", opponent: "Maple FC", homeAway: "home", fixtureClass: "development" },
    results: [],
    trainingAttendance: [],
    audit: [],
    revision: 0,
    appliedCommands: {}
  };
  const examples = [
    { id: "synthetic-history-maple", date: "2026-10-03", opponent: "Maple FC", score: { for: 3, against: 1 }, fixtureClass: "development" },
    { id: "synthetic-history-oak", date: "2026-10-10", opponent: "Oak FC", score: { for: 2, against: 2 }, fixtureClass: "friendly" },
    { id: "synthetic-history-hill", date: "2026-10-17", opponent: "Hill FC", score: { for: 0, against: 1 }, fixtureClass: "development" }
  ];
  state.results = examples.map((example, index) => historicalRecord(state, example.id, {
    playedDate: example.date,
    recordedKickoff: null,
    sameDayOrder: null,
    opponent: example.opponent,
    homeAway: "home",
    fixtureClass: example.fixtureClass,
    status: "completed",
    specialOutcome: "ordinary",
    finalScore: example.score,
    halfTimeScore: null,
    goals: index === 0 ? [{ id: "synthetic-history-known-goal", beneficiary: "us", isOwnGoal: false, scorerPlayerId: romaFixture.players[1].id, goalType: null, half: null, halfElapsedMs: null }] : []
  }, "2026-10-20T12:00:00Z"));
  return state;
}
function snapshotLiveMatch(state, match, at) {
  if (match.config.matchId !== state.liveMatch.matchId) throw new Error("Set this match\u2019s recorded fixture details before reporting it.");
  const sample = match.anchor?.sample ?? { monotonicMs: 0, sessionId: "records-checkpoint", wallTimeMs: 0 };
  const started = match.status !== "preparation";
  const targets = started ? currentTargets(match, sample) : [];
  const input = {
    ...state.liveMatch,
    recordedKickoff: null,
    sameDayOrder: null,
    status: match.status === "completed" ? "completed" : match.status === "abandoned" ? "abandoned" : "incomplete",
    specialOutcome: "ordinary",
    finalScore: started ? { ...match.score } : null,
    halfTimeScore: match.halfTimeScore ? { ...match.halfTimeScore } : null,
    goals: started ? goalRecords(match).filter((goal) => !goal.voided).map((goal) => ({
      id: goal.eventId,
      beneficiary: goal.beneficiary,
      isOwnGoal: goal.isOwnGoal,
      scorerPlayerId: goal.scorerPlayerId,
      goalType: goal.goalType === "not_recorded" ? null : goal.goalType,
      half: goal.effective.half,
      halfElapsedMs: goal.effective.halfElapsedMs
    })) : []
  };
  validateInput(state, input);
  return {
    ...input,
    id: match.config.matchId,
    teamId: state.teamId,
    seasonId: state.seasonId,
    recordMode: "detailed_live",
    detailCompleteness: match.recoveryRequired ? "review_required" : "complete",
    publication: state.results.find((record) => record.id === match.config.matchId)?.publication ?? managerOnlyPublication(state.liveMatch.fixtureClass),
    classificationVersion: state.results.find((record) => record.id === match.config.matchId)?.classificationVersion ?? 1,
    selectedPlayerIds: [...match.config.selectedPlayerIds],
    attendance: { ...match.attendance },
    participation: started ? playerMinutes(match, sample).map((player) => {
      const saved = match.config.players.find((item) => item.id === player.playerId);
      const target = targets.find((item) => item.playerId === player.playerId);
      const targetMs = target ? rationalToNumber(target.target) : null;
      const priorEntry = state.results.find((record) => record.id === match.config.matchId)?.participation?.find((item) => item.playerId === player.playerId);
      const exceptionReason = priorEntry?.playedMs === player.playingMs && priorEntry.target?.targetMs === targetMs ? priorEntry.target.exceptionReason : null;
      const preferences = match.config.profileSnapshot?.find((item) => item.playerId === player.playerId)?.preferences ?? saved?.positionPreferences ?? [];
      const preferenceMs = { first: 0, second: 0, backup: 0, other: 0, unknown: 0 };
      for (const [position, duration2] of Object.entries(player.positionMs)) {
        const index = preferences.indexOf(position);
        const category = preferences.length === 0 ? "unknown" : index === 0 ? "first" : index === 1 ? "second" : index >= 2 ? "backup" : "other";
        preferenceMs[category] += duration2;
      }
      return {
        playerId: player.playerId,
        playedMs: player.playingMs,
        availableBenchMs: player.benchMs,
        unavailableMs: player.unavailableMs,
        positionMs: { ...player.positionMs },
        preferenceMs,
        target: target && targetMs !== null ? { targetMs, lowerMs: rationalToNumber(target.lower), upperMs: rationalToNumber(target.upper), withinBand: withinTargetBand(player.playingMs, target), deviationRatio: targetMs === 0 ? null : (player.playingMs - targetMs) / targetMs, exceptionReason } : void 0,
        intervals: match.intervals.filter((item) => item.playerId === player.playerId).map((item) => ({ half: item.half, startMs: item.startMs, endMs: item.endMs, state: item.state, position: item.position })),
        primaryWasGoalkeeper: preferences.length ? preferences[0] === "GK" : saved?.goalkeeperChoice ? saved.goalkeeperChoice === 1 : null
      };
    }) : null,
    actualActiveDurationMs: started ? match.matchActiveMs : null,
    keeperPolicy: match.config.fixedKeeperId ? "sole_fixed_keeper" : "rotating_or_unfixed",
    sourceMatchRevision: match.revision,
    enteredAt: at,
    updatedAt: at,
    revision: 1,
    awardStatus: "not_recorded"
  };
}
function reduceRecords(previous, command) {
  if (command.actor !== "manager") throw new Error("Only the assigned manager rehearsal can change records.");
  if (!command.commandId || !validInstant(command.at)) throw new Error("A record command needs an identifier and an explicit timestamp.");
  const encoded = signature(command);
  if (previous.appliedCommands[command.commandId]) {
    if (previous.appliedCommands[command.commandId] !== encoded) throw new Error("Command identifier conflicts with previously recorded content.");
    return previous;
  }
  let state = previous;
  let before = null;
  let after = null;
  let reason = "";
  switch (command.type) {
    case "historical.add": {
      if (!command.recordId.trim()) throw new Error("This historical match needs an identifier.");
      if (state.results.some((record) => record.id === command.recordId)) throw new Error("This match identifier already exists. Open its correction route.");
      if (!command.acknowledgePossibleDuplicate && state.results.some((record) => record.playedDate === command.input.playedDate && record.opponent.toLowerCase() === command.input.opponent.trim().toLowerCase())) throw new Error("A match against this opponent on this date already exists. Review it or acknowledge that these were separate games.");
      after = historicalRecord(state, command.recordId, command.input, command.at);
      state = { ...state, results: [...state.results, after] };
      reason = "Historical summary entered; unknown detail retained.";
      break;
    }
    case "historical.correct": {
      before = state.results.find((record) => record.id === command.recordId) ?? null;
      if (!before || before.recordMode !== "historical_summary") throw new Error("Use the live event correction route for a detailed match.");
      if (before.revision !== command.expectedRevision) throw new Error("This result changed. Review its latest revision before correcting.");
      if (!command.reason.trim()) throw new Error("Record a reason for the correction.");
      after = {
        ...historicalRecord(state, before.id, command.input, command.at),
        enteredAt: before.enteredAt,
        revision: before.revision + 1,
        classificationVersion: before.classificationVersion + Number(command.input.fixtureClass !== before.fixtureClass),
        publication: command.input.fixtureClass === before.fixtureClass ? clone2(before.publication) : managerOnlyPublication(command.input.fixtureClass)
      };
      state = { ...state, results: state.results.map((record) => record.id === before?.id ? after : record) };
      reason = command.reason.trim();
      break;
    }
    case "live.archive": {
      if (command.match.status !== "completed" || command.match.recoveryRequired) throw new Error("Finish the match and resolve clock uncertainty before archiving a final participation record.");
      before = state.results.find((record) => record.id === command.match.config.matchId) ?? null;
      if (before?.recordMode === "historical_summary") throw new Error("A historical summary already uses this match identifier; explicit reconciliation is required.");
      if (before && (before.sourceMatchRevision ?? -1) >= command.match.revision) throw new Error("This match revision is already archived.");
      after = { ...snapshotLiveMatch(state, command.match, command.at), enteredAt: before?.enteredAt ?? command.at, revision: (before?.revision ?? 0) + 1 };
      state = { ...state, results: [...state.results.filter((record) => record.id !== after?.id), after] };
      reason = command.reason?.trim() || "Local completed match captured from recorded intervals.";
      break;
    }
    case "live.context.set": {
      if (!validDate2(command.details.playedDate) || command.details.playedDate < state.startsOn || command.details.playedDate > state.endsOn || !command.details.opponent.trim()) throw new Error("Choose valid fixture details in this season.");
      state = { ...state, liveMatch: clone2(command.details) };
      reason = "Current fixture context recorded.";
      break;
    }
    case "publication.set": {
      before = state.results.find((record) => record.id === command.recordId) ?? null;
      if (!before || before.revision !== command.expectedRevision) throw new Error("Review the latest result before changing its publication policy.");
      if (!command.reason.trim() || !command.policy.confirmationReference?.trim() || !command.policy.confirmed) throw new Error("A confirmed competition decision and audit reason are required before sharing.");
      if (before.fixtureClass === "unclassified" || command.policy.fixtureClass !== before.fixtureClass || command.policy.version <= before.publication.version) throw new Error("Classify the fixture and provide a newer policy version that matches its class.");
      after = { ...before, publication: clone2(command.policy), updatedAt: command.at, revision: before.revision + 1 };
      state = { ...state, results: state.results.map((record) => record.id === before?.id ? after : record) };
      reason = command.reason.trim();
      break;
    }
    case "training.evidence.replace": {
      const ids = command.evidence.map((item) => item.sessionId);
      if (new Set(ids).size !== ids.length || command.evidence.some((item) => !validDate2(item.playedDate) || item.playedDate < state.startsOn || item.playedDate > state.endsOn || new Set(item.expectedPlayerIds).size !== item.expectedPlayerIds.length)) throw new Error("Training evidence needs distinct sessions, unique expected players and dates in this season.");
      state = { ...state, trainingAttendance: clone2(command.evidence) };
      reason = "Training evidence updated from the local schedule; cancelled sessions remain excluded.";
      break;
    }
    case "participation.exception.noted": {
      before = state.results.find((record) => record.id === command.recordId) ?? null;
      if (!before || before.revision !== command.expectedRevision) throw new Error("Review the latest archived match before explaining an exception.");
      const item = before.participation?.find((entry) => entry.playerId === command.playerId);
      if (!item?.target || item.target.withinBand) throw new Error("An exception note requires recorded participation outside its target band.");
      if (!command.reason.trim()) throw new Error("Record the reason for this target exception.");
      after = { ...before, participation: before.participation.map((entry) => entry.playerId === command.playerId ? { ...entry, target: { ...entry.target, exceptionReason: command.reason.trim() } } : entry), updatedAt: command.at, revision: before.revision + 1 };
      state = { ...state, results: state.results.map((record) => record.id === before?.id ? after : record) };
      reason = command.reason.trim();
      break;
    }
  }
  return {
    ...state,
    revision: previous.revision + 1,
    audit: [...state.audit, { commandId: command.commandId, action: command.type, matchId: after?.id ?? before?.id ?? null, at: command.at, reason, before: clone2(before), after: clone2(after) }],
    appliedCommands: { ...state.appliedCommands, [command.commandId]: encoded }
  };
}
function inScope(state, viewer) {
  return (!viewer.teamId || viewer.teamId === state.teamId) && (!viewer.seasonId || viewer.seasonId === state.seasonId);
}
function canShare(record, actor) {
  return actor === "manager" || record.fixtureClass !== "unclassified" && record.publication.confirmed && Boolean(record.publication.confirmationReference) && record.publication.fixtureClass === record.fixtureClass && record.publication.allowedRoles.includes(actor);
}
function ordinaryCompleted(record) {
  return record.status === "completed" && record.specialOutcome === "ordinary" && record.finalScore !== null;
}
function chronological(left, right) {
  return left.playedDate.localeCompare(right.playedDate) || (left.recordedKickoff && right.recordedKickoff ? Date.parse(left.recordedKickoff) - Date.parse(right.recordedKickoff) : (left.sameDayOrder ?? 0) - (right.sameDayOrder ?? 0)) || left.id.localeCompare(right.id);
}
function resultOutcome(score) {
  return score.for > score.against ? "W" : score.for < score.against ? "L" : "D";
}
function publicResult(record) {
  const included = ordinaryCompleted(record);
  const outcome = included ? resultOutcome(record.finalScore) : null;
  return {
    id: record.id,
    playedDate: record.playedDate,
    recordedKickoff: record.recordedKickoff,
    sameDayOrder: record.sameDayOrder,
    opponent: record.opponent,
    homeAway: record.homeAway,
    fixtureClass: record.fixtureClass,
    status: record.status,
    recordMode: record.recordMode,
    detailCompleteness: record.detailCompleteness,
    finalScore: record.finalScore ? { ...record.finalScore } : null,
    halfTimeScore: record.halfTimeScore ? { ...record.halfTimeScore } : null,
    goals: clone2(record.goals),
    unassignedGoalsFor: record.finalScore ? record.finalScore.for - record.goals.filter((goal) => goal.beneficiary === "us").length : null,
    unassignedGoalsAgainst: record.finalScore ? record.finalScore.against - record.goals.filter((goal) => goal.beneficiary === "opposition").length : null,
    outcome,
    points: outcome === "W" ? 3 : outcome === "D" ? 1 : outcome === "L" ? 0 : null,
    revision: record.revision
  };
}
function selectSeasonResults(state, viewer) {
  const scoped = inScope(state, viewer) ? state.results.filter((record) => record.teamId === state.teamId && record.seasonId === state.seasonId) : [];
  const visible = scoped.filter((record) => canShare(record, viewer.actor)).sort(chronological);
  const withheld = scoped.length - visible.length;
  const denied = !inScope(state, viewer) || withheld > 0;
  const included = visible.filter(ordinaryCompleted);
  const totals = { played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0 };
  for (const record of included) {
    const outcome = resultOutcome(record.finalScore);
    totals.played += 1;
    totals.wins += Number(outcome === "W");
    totals.draws += Number(outcome === "D");
    totals.losses += Number(outcome === "L");
    totals.goalsFor += record.finalScore.for;
    totals.goalsAgainst += record.finalScore.against;
  }
  totals.goalDifference = totals.goalsFor - totals.goalsAgainst;
  totals.points = totals.wins * 3 + totals.draws;
  const scorerCounts = /* @__PURE__ */ new Map();
  for (const record of included) for (const goal of record.goals) {
    if (goal.beneficiary === "us" && !goal.isOwnGoal && goal.scorerPlayerId) scorerCounts.set(goal.scorerPlayerId, (scorerCounts.get(goal.scorerPlayerId) ?? 0) + 1);
  }
  const ambiguous = included.some((record, index) => included.some((other, otherIndex) => index !== otherIndex && other.playedDate === record.playedDate && !(other.recordedKickoff && record.recordedKickoff) && (other.sameDayOrder === null || record.sameDayOrder === null || other.sameDayOrder === record.sameDayOrder)));
  return {
    clubId: state.clubId,
    teamId: state.teamId,
    seasonId: state.seasonId,
    projectionVersion: state.revision,
    visibilityScope: viewer.actor,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    reportType: "season_results",
    appliedFilters: { teamId: state.teamId, seasonId: state.seasonId },
    asOf: latestRecordTime(state),
    competitionPolicies: visible.map((record) => ({ matchId: record.id, policyId: record.publication.id, policyVersion: record.publication.version, fixtureClass: record.fixtureClass, classificationVersion: record.classificationVersion })),
    sharing: denied ? "withheld_policy" : "permitted",
    suppressionReason: denied ? "Scores and derived totals are not shared for this competition or scope." : null,
    withheldResultCount: viewer.actor === "manager" ? withheld : null,
    rows: visible.map(publicResult),
    totals: denied ? null : totals,
    scorerTotals: denied ? null : state.players.filter((player) => scorerCounts.has(player.id)).map((player) => ({ playerId: player.id, label: player.label, knownGoals: scorerCounts.get(player.id) })),
    form: denied || ambiguous ? null : included.slice(-5).map((record) => ({ matchId: record.id, outcome: resultOutcome(record.finalScore) })),
    formChronologyState: ambiguous ? "same_day_order_unknown" : "known",
    unknownScoreCount: visible.filter((record) => record.status === "completed" && record.finalScore === null).length,
    excludedExceptionalMatches: visible.filter((record) => record.specialOutcome !== "ordinary" || record.status === "abandoned").length,
    dataCoverage: { totalRecordedMatches: denied ? null : scoped.length, knownOrdinaryResults: denied ? null : included.length, summaryOnlyCount: denied ? null : visible.filter((record) => record.recordMode === "historical_summary").length }
  };
}
function reportRecords(state, match) {
  const scoped = state.results.filter((record) => record.teamId === state.teamId && record.seasonId === state.seasonId);
  if (!match || match.config.matchId !== state.liveMatch.matchId || match.status === "preparation") return scoped;
  const current = snapshotLiveMatch(state, match, observedMatchTime(match) ?? latestRecordTime(state) ?? state.startsOn + "T00:00:00Z");
  return [...scoped.filter((record) => record.id !== current.id), current];
}
function observedMatchTime(match) {
  const value = match?.eventHistory?.at(-1)?.sample.wallTimeMs ?? match?.anchor?.sample.wallTimeMs ?? match?.completedAtMs;
  return value === null || value === void 0 ? null : new Date(value).toISOString();
}
function latestRecordTime(state) {
  const times = [...state.results.map((record) => record.updatedAt), ...state.audit.map((entry) => entry.at)].sort((a, b) => Date.parse(a) - Date.parse(b));
  return times.at(-1) ?? null;
}
function attendanceSummary(values) {
  const attended = values.filter((value) => value === "present").length;
  const absent = values.filter((value) => value === "absent" || value === "excused").length;
  const recorded = attended + absent;
  return {
    eligibleEventCount: values.length,
    attendanceRecordedCount: recorded,
    attendedCount: attended,
    knownAbsentCount: absent,
    unknownAttendanceCount: values.length - recorded,
    excusedCount: values.filter((value) => value === "excused").length,
    knownRecordAttendanceRate: recorded ? attended / recorded : null,
    completenessRatio: values.length ? recorded / values.length : null,
    policy: "proposed_known_records_excused_included"
  };
}
function selectParticipationReport(state, match, viewer) {
  const recordedAt = [latestRecordTime(state), observedMatchTime(match)].filter((item) => item !== null).sort((a, b) => Date.parse(a) - Date.parse(b));
  const metadata = { reportType: "season_participation", clubId: state.clubId, teamId: state.teamId, seasonId: state.seasonId, generatedAt: (/* @__PURE__ */ new Date()).toISOString(), asOf: recordedAt.at(-1) ?? null, projectionVersion: state.revision, sourceMatchRevision: match?.revision ?? null, visibilityScope: viewer.actor, appliedFilters: { playerId: viewer.actor === "player" ? viewer.playerId ?? null : null } };
  if (!inScope(state, viewer) || viewer.actor === "spectator" || viewer.actor === "player" && (!viewer.playerId || !state.players.some((player) => player.id === viewer.playerId))) return { ...metadata, access: "denied", reason: "Named participation and attendance are unavailable for this viewer.", rows: [] };
  const records = reportRecords(state, match).filter((record) => record.status === "completed" || record.recordMode === "detailed_live" && (record.status === "incomplete" || record.status === "abandoned"));
  const players = viewer.actor === "player" ? state.players.filter((player) => player.id === viewer.playerId) : state.players;
  return { ...metadata, access: "permitted", reason: null, rows: players.map((player) => {
    const selected = records.filter((record) => record.selectedPlayerIds?.includes(player.id) && record.attendance?.[player.id] !== "not_selected");
    const evidence = selected.flatMap((record) => record.participation?.filter((item) => item.playerId === player.id) ?? []);
    const positionMs = {};
    for (const entry of evidence) for (const [position, duration2] of Object.entries(entry.positionMs)) positionMs[position] = (positionMs[position] ?? 0) + duration2;
    const preferenceMs = { first: 0, second: 0, backup: 0, other: 0, unknown: 0 };
    for (const entry of evidence) {
      if (entry.preferenceMs) for (const category of Object.keys(preferenceMs)) preferenceMs[category] += entry.preferenceMs[category];
      else preferenceMs.unknown += entry.playedMs;
    }
    const playingMs = evidence.reduce((sum, entry) => sum + entry.playedMs, 0);
    const goalkeeperMs = positionMs.GK ?? 0;
    const games = attendanceSummary(selected.map((record) => record.attendance?.[player.id] ?? "not_recorded"));
    const trainingEvidence = state.trainingAttendance.filter((item) => item.eventStatus === "held" && item.expectedPlayerIds.includes(player.id));
    const training = attendanceSummary(trainingEvidence.map((item) => item.attendance[player.id] ?? "not_recorded"));
    const matchesPlayed = evidence.filter((entry) => entry.playedMs > 0).length;
    const unknown = records.filter((record) => record.selectedPlayerIds === null).length;
    return {
      playerId: player.id,
      label: player.label,
      matchesSelected: selected.length,
      unknownHistoricalSelectionCount: unknown,
      matchesWithParticipationRecorded: evidence.length,
      matchesWithAttendanceRecorded: games.attendanceRecordedCount,
      matchesPlayed,
      matchesAttended: games.attendedCount,
      playingMs,
      goalkeeperMs,
      outfieldMs: playingMs - goalkeeperMs,
      nonPrimaryGoalkeeperMs: evidence.filter((entry) => entry.primaryWasGoalkeeper === false).reduce((sum, entry) => sum + (entry.positionMs.GK ?? 0), 0),
      goalkeeperMsWithUnknownPrimaryPreference: evidence.filter((entry) => entry.primaryWasGoalkeeper === null).reduce((sum, entry) => sum + (entry.positionMs.GK ?? 0), 0),
      goalkeeperMsWithKnownPrimaryPreference: evidence.filter((entry) => entry.primaryWasGoalkeeper !== null).reduce((sum, entry) => sum + (entry.positionMs.GK ?? 0), 0),
      positionMs,
      preferenceMs,
      minutesPerPlayedAppearance: matchesPlayed ? playingMs / matchesPlayed / 6e4 : null,
      games,
      training,
      gameRecords: selected.map((record) => ({ eventId: record.id, heldDate: record.playedDate, eventStatus: record.status, selection: "selected", actualAttendance: record.attendance?.[player.id] ?? "not_recorded", availabilityResponse: null })),
      trainingRecords: trainingEvidence.map((item) => ({ eventId: item.sessionId, heldDate: item.playedDate, eventStatus: "held", expected: true, actualAttendance: item.attendance[player.id] ?? "not_recorded", availabilityResponse: item.responses?.[player.id] ?? null })),
      coverageLabel: `Minutes recorded for ${evidence.length} of ${records.length} recorded games; ${unknown} historical squad${unknown === 1 ? "" : "s"} not recorded.`,
      evidenceState: selected.some((record) => record.detailCompleteness === "review_required") ? "review_required" : unknown || selected.length !== evidence.length ? "partial" : "complete"
    };
  }) };
}
function selectMatchReport(state, matchId, viewer, currentMatch = null) {
  if (!inScope(state, viewer)) return null;
  const record = reportRecords(state, currentMatch).find((item) => item.id === matchId);
  if (!record) return null;
  const shared = canShare(record, viewer.actor);
  const base = {
    matchId: record.id,
    playedDate: record.playedDate,
    opponent: record.opponent,
    status: record.status,
    clubId: state.clubId,
    teamId: state.teamId,
    seasonId: state.seasonId,
    projectionVersion: state.revision,
    sourceMatchRevision: record.sourceMatchRevision,
    asOf: currentMatch?.config.matchId === matchId ? observedMatchTime(currentMatch) : record.updatedAt,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    reportType: "match",
    policyId: record.publication.id,
    policyVersion: record.publication.version,
    classificationVersion: record.classificationVersion,
    fixtureClass: record.fixtureClass,
    appliedFilters: { matchId, playerId: viewer.actor === "player" ? viewer.playerId ?? null : null },
    visibilityScope: viewer.actor,
    recordMode: record.recordMode,
    detailCompleteness: record.detailCompleteness,
    revision: record.revision,
    score: shared ? clone2(record.finalScore) : null,
    halfTimeScore: shared ? clone2(record.halfTimeScore) : null,
    goals: shared ? clone2(record.goals) : [],
    unassignedGoalsFor: shared && record.finalScore ? record.finalScore.for - record.goals.filter((goal) => goal.beneficiary === "us").length : null,
    unassignedGoalsAgainst: shared && record.finalScore ? record.finalScore.against - record.goals.filter((goal) => goal.beneficiary === "opposition").length : null,
    suppressionReason: shared ? null : "Scores are not shared for this competition.",
    awardStatus: record.awardStatus
  };
  if (viewer.actor === "spectator") return base;
  const eligible = viewer.actor === "manager" ? state.players.map((player) => player.id) : viewer.playerId ? [viewer.playerId] : [];
  return {
    ...base,
    actualActiveDurationMs: record.actualActiveDurationMs,
    keeperPolicy: record.keeperPolicy,
    participation: record.participation?.filter((item) => eligible.includes(item.playerId)).map(clone2) ?? null,
    attendance: record.attendance ? Object.fromEntries(Object.entries(record.attendance).filter(([id3]) => eligible.includes(id3))) : null
  };
}

// packages/application/src/sync.ts
function effectiveEventTime(previous, next, event) {
  let effective;
  if (event.type === "goal.recorded" || event.type === "availability.changed") effective = event.effective;
  if (event.type === "event.corrected") effective = event.replacement.effective;
  if ((event.type === "event.corrected" || event.type === "event.voided") && !effective) {
    const goal = previous.goals?.find((record) => record.eventId === event.targetEventId || record.latestEventId === event.targetEventId);
    const availability = previous.availabilityHistory?.find((record) => record.eventId === event.targetEventId || record.latestEventId === event.targetEventId);
    effective = goal?.effective ?? availability?.effective;
  }
  return effective ? { half: effective.half, halfElapsedMs: effective.halfElapsedMs, matchElapsedMs: effective.matchElapsedMs } : { half: next.half, halfElapsedMs: next.halfActiveMs, matchElapsedMs: next.matchActiveMs };
}

// packages/application/src/application.ts
function fixtureMatchConfig(preparation, snapshot) {
  const keepers = snapshot.profiles.filter(
    (player) => goalkeeperChoice(player) > 0
  );
  return {
    matchId: snapshot.fixtureId,
    players: snapshot.profiles.map((player) => ({
      id: player.playerId,
      displayName: player.displayName,
      goalkeeperChoice: goalkeeperChoice(player)
    })),
    selectedPlayerIds: [...snapshot.selectedPlayerIds],
    pitchPlaces: snapshot.fixture.format,
    plannedHalfDurationMs: snapshot.fixture.plannedHalfDurationMs,
    fixedKeeperId: keepers.length === 1 ? keepers[0].playerId : null,
    initialAttendance: { ...snapshot.attendance },
    slots: snapshot.formation.slots.map((slot) => ({
      slotId: slot.id,
      position: slot.position,
      x: slot.x,
      y: slot.y,
      label: slot.label
    })),
    profileSnapshot: snapshot.profiles.map((profile) => ({
      playerId: profile.playerId,
      preferences: [...profile.preferences],
      eligiblePositions: [...profile.eligiblePositions],
      initials: profile.initials
    })),
    fixture: {
      opponent: snapshot.fixture.opponent,
      playedDate: snapshot.fixture.playedDate,
      kickoff: snapshot.fixture.kickoff,
      homeAway: snapshot.fixture.homeAway,
      seasonId: snapshot.seasonId,
      teamId: preparation.team.id,
      teamName: preparation.team.name,
      clubName: preparation.club.name
    }
  };
}
var defaultPlayerId = romaFixture.players[0].id;

// apps/api/src/store.ts
var EVENT_CONTRACT_VERSION = "longball.events/1.1";
var SYNTHETIC_IDS = { teamId: "synthetic-roma-u10", seasonId: "synthetic-season-2026-27", matchId: "synthetic-roma-maple-2026-10-24" };
function canonical3(value) {
  if (Array.isArray(value)) return `[${value.map(canonical3).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical3(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
var digest = (value) => createHash("sha256").update(value).digest("hex");
var validId = (value) => typeof value === "string" && value.length > 0 && value.length <= 150 && /^[a-zA-Z0-9_-]+$/.test(value);
var validDeviceId = (value) => validId(value) && value.length <= 120;
var nonnegative2 = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function bad(message) {
  throw new AccessError("INVALID_REQUEST", 400, message);
}
function validateEnvelope(value, matchId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) bad("An event envelope is required.");
  const item = value;
  if (!validId(item.eventId) || !validDeviceId(item.deviceId) || item.matchId !== matchId || !nonnegative2(item.clientSequence) || item.clientSequence < 1 || !nonnegative2(item.controllerEpoch) || item.controllerEpoch < 1 || !nonnegative2(item.baseRevision)) bad("Invalid event identity, scope or sequence.");
  if (!(item.previousEventId === null || validId(item.previousEventId))) bad("Invalid previous event identifier.");
  if (item.contractVersion !== EVENT_CONTRACT_VERSION || item.schemaVersion !== 1 || item.engineVersion !== ENGINE_VERSION) return item;
  const fields2 = ["contractVersion", "schemaVersion", "engineVersion", "eventId", "matchId", "deviceId", "controllerEpoch", "clientSequence", "previousEventId", "baseRevision", "effectiveHalf", "halfElapsedMs", "matchElapsedMs", "effectiveAt", "recordedAt", "timeQuality", "clockEvidence", "command"];
  if (Object.keys(item).some((key) => !fields2.includes(key))) bad("Unknown event envelope fields are not accepted.");
  if (!nonnegative2(item.halfElapsedMs) || !nonnegative2(item.matchElapsedMs) || ![0, 1, 2].includes(item.effectiveHalf)) bad("Invalid effective playing-time boundary.");
  if (!["anchored", "estimated", "reviewRequired"].includes(item.timeQuality) || !Number.isFinite(Date.parse(item.recordedAt)) || !(item.effectiveAt === null || Number.isFinite(Date.parse(item.effectiveAt)))) bad("Invalid event time evidence.");
  const command = item.command;
  if (!command || typeof command !== "object" || command.id !== item.eventId || !command.sample || !Number.isFinite(command.sample.monotonicMs) || command.sample.monotonicMs < 0 || !validId(command.sample.sessionId) || !nonnegative2(command.sample.wallTimeMs)) bad("Invalid versioned match command.");
  if (!item.clockEvidence || item.clockEvidence.monotonicMs !== command.sample.monotonicMs || !validId(item.clockEvidence.anchorId) || !(item.clockEvidence.continuityId === null || validId(item.clockEvidence.continuityId))) bad("Explicit clock evidence is required.");
  const commandTypes = ["attendance.recorded", "availability.changed", "lineup.staged", "half.started", "half.paused", "half.resumed", "half.ended", "lineup.committed", "goal.recorded", "clock.recovery_required", "clock.corrected", "event.corrected", "event.voided", "policy.changed", "match.abandoned"];
  if (!commandTypes.includes(command.type)) bad("Unsupported match command.");
  if (command.type === "goal.recorded" && !["us", "opposition"].includes(command.beneficiary)) bad("Invalid goal side.");
  if (command.type === "attendance.recorded" && (!validId(command.playerId) || !["present", "absent", "excused", "not_selected", "not_recorded"].includes(command.status))) bad("Invalid attendance.");
  if (command.type === "availability.changed" && (!validId(command.playerId) || typeof command.available !== "boolean")) bad("Invalid availability.");
  if ((command.type === "lineup.staged" || command.type === "lineup.committed") && (!Array.isArray(command.lineup) || command.lineup.length > 11 || command.lineup.some((item2) => !validId(item2.playerId) || !validId(item2.slotId) || typeof item2.position !== "string" || item2.position.length > 30))) bad("Invalid lineup allocations.");
  return item;
}
var DevelopmentStore = class {
  constructor(path, now = Date.now) {
    this.path = path;
    this.now = now;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 448 });
    this.database = new DatabaseSync(path);
    try {
      if (path !== ":memory:") chmodSync(path, 384);
      this.database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
      this.migrate();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }
  path;
  now;
  database;
  close() {
    this.database.close();
  }
  transaction(work) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  migrate() {
    this.transaction(() => {
      const version = Number(this.database.prepare("PRAGMA user_version").get().user_version);
      if (version > 5) throw new Error("This store version is newer than this application; preserve it and use a compatible build.");
      if (version === 0) this.database.exec(`
      CREATE TABLE accounts(id TEXT PRIMARY KEY,issuer TEXT NOT NULL,subject TEXT NOT NULL,classification TEXT NOT NULL CHECK(classification IN ('child_shared','adult_individual','unclassified')),adult_verified INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'active',UNIQUE(issuer,subject));
      CREATE TABLE teams(id TEXT PRIMARY KEY,name TEXT NOT NULL);
      CREATE TABLE memberships(account_id TEXT NOT NULL REFERENCES accounts(id),team_id TEXT NOT NULL REFERENCES teams(id),season_id TEXT NOT NULL,role TEXT NOT NULL,player_id TEXT,expires_at INTEGER,revoked_at INTEGER,PRIMARY KEY(account_id,team_id,season_id,role));
      CREATE TABLE matches(id TEXT PRIMARY KEY,team_id TEXT NOT NULL REFERENCES teams(id),season_id TEXT NOT NULL,config_json TEXT NOT NULL,state_json TEXT NOT NULL,sharing_policy_json TEXT NOT NULL,last_sync_at INTEGER);
      CREATE TABLE controller_grants(match_id TEXT PRIMARY KEY REFERENCES matches(id),epoch INTEGER NOT NULL,account_id TEXT NOT NULL REFERENCES accounts(id),device_id TEXT NOT NULL,capability_hash TEXT NOT NULL,frozen INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE controller_history(id TEXT PRIMARY KEY,match_id TEXT NOT NULL,epoch INTEGER NOT NULL,actor_id TEXT NOT NULL,from_device TEXT,to_device TEXT NOT NULL,kind TEXT NOT NULL,reason TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE events(event_id TEXT PRIMARY KEY,match_id TEXT NOT NULL REFERENCES matches(id),device_id TEXT NOT NULL,client_sequence INTEGER NOT NULL,envelope_json TEXT NOT NULL,signature TEXT NOT NULL,disposition TEXT NOT NULL,reason TEXT,revision INTEGER,received_at INTEGER NOT NULL,UNIQUE(match_id,device_id,client_sequence));
      CREATE TABLE streams(match_id TEXT NOT NULL REFERENCES matches(id),device_id TEXT NOT NULL,sequence INTEGER NOT NULL,previous_event_id TEXT NOT NULL,PRIMARY KEY(match_id,device_id));
      CREATE TABLE conflicting_submissions(id TEXT PRIMARY KEY,match_id TEXT NOT NULL,actor_id TEXT NOT NULL,original_json TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE transfers(id TEXT PRIMARY KEY,match_id TEXT NOT NULL REFERENCES matches(id),from_epoch INTEGER NOT NULL,to_account_id TEXT NOT NULL,to_device_id TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE idempotency(account_id TEXT NOT NULL,operation TEXT NOT NULL,key TEXT NOT NULL,signature TEXT NOT NULL,response_json TEXT NOT NULL,PRIMARY KEY(account_id,operation,key));
      CREATE TABLE audit(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,action TEXT NOT NULL,object_id TEXT NOT NULL,outcome TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE privacy_requests(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),kind TEXT NOT NULL,status TEXT NOT NULL,policy_version TEXT,verified_at INTEGER,created_at INTEGER NOT NULL);
      CREATE TABLE jobs(id TEXT PRIMARY KEY,business_key TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,payload_json TEXT NOT NULL,due_at INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,lease_until INTEGER,last_error_code TEXT);
      CREATE INDEX pending_jobs ON jobs(state,due_at);
      CREATE INDEX match_event_order ON events(match_id,revision);
      PRAGMA user_version=1;
    `);
      if (version < 2) this.database.exec(`
      CREATE TABLE documents(team_id TEXT NOT NULL REFERENCES teams(id),season_id TEXT NOT NULL,kind TEXT NOT NULL,revision INTEGER NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(team_id,season_id,kind));
      PRAGMA user_version=2;
    `);
      if (version < 3) this.database.exec("ALTER TABLE accounts ADD COLUMN strong_auth_enrolled INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=3;");
      if (version < 4) this.database.exec("CREATE TABLE devices(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id)); PRAGMA user_version=4;");
      if (version < 5) this.database.exec("ALTER TABLE events ADD COLUMN actor_id TEXT REFERENCES accounts(id); PRAGMA user_version=5;");
    });
  }
  async backup(destination) {
    mkdirSync(dirname(destination), { recursive: true, mode: 448 });
    await backup(this.database, destination);
    chmodSync(destination, 384);
  }
  integrity() {
    return String(this.database.prepare("PRAGMA integrity_check").get().integrity_check);
  }
  seedSynthetic() {
    this.transaction(() => {
      if (this.database.prepare("SELECT id FROM teams LIMIT 1").get()) return;
      this.database.prepare("INSERT INTO teams(id,name) VALUES(?,?)").run(SYNTHETIC_IDS.teamId, "Roma U10 \xB7 fictional");
      this.database.prepare("INSERT INTO teams(id,name) VALUES(?,?)").run("synthetic-other-team", "Other fictional team");
      const add2 = (id3, classification, adult) => this.database.prepare("INSERT INTO accounts(id,issuer,subject,classification,adult_verified,strong_auth_enrolled) VALUES(?,?,?,?,?,?)").run(id3, "urn:longball:synthetic", id3, classification, Number(adult), Number(adult));
      const membership = (id3, role, playerId = null, teamId = SYNTHETIC_IDS.teamId) => this.database.prepare("INSERT INTO memberships(account_id,team_id,season_id,role,player_id) VALUES(?,?,?,?,?)").run(id3, teamId, SYNTHETIC_IDS.seasonId, role, playerId);
      add2("synthetic-account-admin", "adult_individual", true);
      membership("synthetic-account-admin", "administrator");
      for (let number = 1; number <= 5; number++) {
        const id3 = number === 1 ? "synthetic-account-manager" : `synthetic-account-manager-${number}`;
        add2(id3, "adult_individual", true);
        if (number <= 4) membership(id3, "manager");
        if (number === 1) membership(id3, "administrator");
      }
      for (let number = 1; number <= 13; number++) {
        const suffix = String(number).padStart(2, "0");
        const id3 = `synthetic-account-player-${suffix}`;
        add2(id3, "child_shared", false);
        membership(id3, "player", `synthetic-player-${suffix}`);
      }
      add2("synthetic-account-spectator", "adult_individual", false);
      membership("synthetic-account-spectator", "spectator");
      add2("synthetic-account-invitee", "adult_individual", false);
      add2("synthetic-account-other-manager", "adult_individual", true);
      membership("synthetic-account-other-manager", "manager", null, "synthetic-other-team");
      const config = { matchId: SYNTHETIC_IDS.matchId, players: romaFixture.players, selectedPlayerIds: romaFixture.players.filter((player) => player.available).map((player) => player.id), pitchPlaces: 7, plannedHalfDurationMs: 15e5, fixedKeeperId: romaFixture.players[0].id };
      this.insertMatch(config, SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId);
      const community = createCommunityState(this.now());
      community.matches = community.matches.map((match) => ({ ...match, sharing: "manager_only" }));
      for (let number = 2; number <= 4; number++) {
        const id3 = `synthetic-account-manager-${number}`;
        community.accounts.push({ id: id3, label: `Fictional manager ${number}`, classification: "adult_individual", adultVerified: true });
        community.memberships.push({ accountId: id3, teamId: SYNTHETIC_IDS.teamId, seasonId: SYNTHETIC_IDS.seasonId, role: "manager", active: true });
      }
      this.saveDocument(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, "preparation", createPreparationState());
      this.saveDocument(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, "community", community);
      this.saveDocument(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, "records", createRecordsSeed());
    });
  }
  insertMatch(config, teamId, seasonId) {
    this.database.prepare("INSERT INTO matches(id,team_id,season_id,config_json,state_json,sharing_policy_json) VALUES(?,?,?,?,?,?)").run(config.matchId, teamId, seasonId, JSON.stringify(config), JSON.stringify(createMatch(config)), JSON.stringify(UNAPPROVED_SHARING_POLICY));
  }
  principal(identity) {
    const account2 = this.database.prepare("SELECT * FROM accounts WHERE issuer=? AND subject=?").get(identity.issuer, identity.subject);
    if (!account2 || account2.status !== "active") throw new AccessError("ACCOUNT_UNAVAILABLE", 403, "The account is not active for this service.");
    return { accountId: account2.id, issuer: account2.issuer, subject: account2.subject, identityClassification: account2.classification, adultVerified: Boolean(account2.adult_verified), strongAuth: identity.strongAuth, authenticatedAt: identity.authenticatedAt, status: account2.status };
  }
  memberships() {
    const rows = this.database.prepare("SELECT * FROM memberships").all().map((row) => ({ accountId: row.account_id, teamId: row.team_id, seasonId: row.season_id, role: row.role, playerId: row.player_id ?? void 0, expiresAt: row.expires_at, revokedAt: row.revoked_at }));
    const communities = this.database.prepare("SELECT team_id,season_id,value_json FROM documents WHERE kind='community'").all().map((row) => ({ ...row, state: JSON.parse(row.value_json) }));
    return rows.map((row) => {
      if (row.role !== "spectator") return row;
      const scope = communities.find((document) => document.team_id === row.teamId && document.season_id === row.seasonId);
      const granted = scope?.state.grants.some((grant) => grant.accountId === row.accountId && grant.teamId === row.teamId && grant.seasonId === row.seasonId && grant.revokedAtMs === null && grant.startsAtMs <= this.now() && grant.expiresAtMs > this.now());
      return scope && !granted ? { ...row, revokedAt: row.revokedAt ?? Math.max(1, this.now()) } : row;
    });
  }
  myMemberships(principal) {
    return currentMemberships(principal, this.memberships(), this.now());
  }
  match(matchId) {
    const row = this.database.prepare("SELECT * FROM matches WHERE id=?").get(matchId);
    if (!row) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    return row;
  }
  managerMatch(principal, matchId) {
    const row = this.match(matchId);
    assertCanManageTeam(principal, this.memberships(), row.team_id, row.season_id, this.now());
    return row;
  }
  matchDto(principal, matchId) {
    const row = this.match(matchId);
    return filterMatchForPrincipal({ principal, memberships: this.memberships(), teamId: row.team_id, seasonId: row.season_id, state: JSON.parse(row.state_json), policy: JSON.parse(row.sharing_policy_json), lastSyncAt: row.last_sync_at, now: this.now() });
  }
  download(principal, matchId, deviceId) {
    const row = this.managerMatch(principal, matchId);
    if (!validDeviceId(deviceId)) bad("A device identifier of at most 120 canonical characters is required.");
    const stream = this.database.prepare("SELECT sequence,previous_event_id FROM streams WHERE match_id=? AND device_id=?").get(matchId, deviceId);
    const grant = this.database.prepare("SELECT epoch,account_id,device_id,frozen FROM controller_grants WHERE match_id=?").get(matchId);
    return { contractVersion: EVENT_CONTRACT_VERSION, schemaVersion: 1, engineVersion: ENGINE_VERSION, matchId, teamId: row.team_id, seasonId: row.season_id, state: JSON.parse(row.state_json), acceptedRevision: JSON.parse(row.state_json).revision, deviceCheckpoint: { clientSequence: stream?.sequence ?? 0, previousEventId: stream?.previous_event_id ?? null }, controller: grant ?? null, downloadedAt: new Date(this.now()).toISOString(), clockAnchor: { serverTime: new Date(this.now()).toISOString(), quality: "observation_only", continuousMappingEstablished: false }, syntheticOnly: true };
  }
  audit(principal, action, objectId, outcome) {
    this.database.prepare("INSERT INTO audit(id,actor_id,action,object_id,outcome,created_at) VALUES(?,?,?,?,?,?)").run(randomUUID(), principal.accountId, action, objectId, outcome, this.now());
  }
  idempotent(principal, operation, key, payload, work) {
    if (!validId(key) || key.length < 8) bad("A stable Idempotency-Key is required for mutations.");
    const signature2 = digest(canonical3(payload));
    return this.transaction(() => {
      const prior = this.database.prepare("SELECT signature,response_json FROM idempotency WHERE account_id=? AND operation=? AND key=?").get(principal.accountId, operation, key);
      if (prior) {
        if (prior.signature !== signature2) throw new AccessError("IDEMPOTENCY_CONFLICT", 409, "The idempotency key was already used with different content.");
        return JSON.parse(prior.response_json);
      }
      const response = work();
      this.database.prepare("INSERT INTO idempotency(account_id,operation,key,signature,response_json) VALUES(?,?,?,?,?)").run(principal.accountId, operation, key, signature2, JSON.stringify(response));
      return response;
    });
  }
  acquire(principal, matchId, deviceId) {
    this.managerMatch(principal, matchId);
    if (!validDeviceId(deviceId)) bad("A device identifier of at most 120 canonical characters is required.");
    const prior = this.database.prepare("SELECT * FROM controller_grants WHERE match_id=?").get(matchId);
    if (prior) throw new AccessError("CONTROLLER_EXISTS", 409, "This match already has a controller. Use handover or audited recovery.");
    this.bindDevice(principal, deviceId);
    const token = randomBytes(32).toString("base64url");
    this.database.prepare("INSERT INTO controller_grants(match_id,epoch,account_id,device_id,capability_hash) VALUES(?,?,?,?,?)").run(matchId, 1, principal.accountId, deviceId, digest(token));
    this.audit(principal, "controller.acquired", matchId, "accepted");
    return { epoch: 1, deviceId, controllerToken: token, checkpoint: this.download(principal, matchId, deviceId).deviceCheckpoint };
  }
  assertController(principal, matchId, token) {
    this.managerMatch(principal, matchId);
    const grant = this.database.prepare("SELECT * FROM controller_grants WHERE match_id=?").get(matchId);
    if (!grant || grant.account_id !== principal.accountId || !token || digest(token) !== grant.capability_hash) throw new AccessError("CONTROLLER_REQUIRED", 409, "Only the selected manager and enrolled device may write this match.");
    return grant;
  }
  upload(principal, matchId, token, values) {
    const row = this.managerMatch(principal, matchId);
    if (!Array.isArray(values) || values.length === 0 || values.length > 100) bad("Upload between one and 100 ordered events.");
    const grant = this.database.prepare("SELECT * FROM controller_grants WHERE match_id=?").get(matchId);
    const currentCapability = !!grant && grant.account_id === principal.accountId && !!token && digest(token) === grant.capability_hash;
    let state = JSON.parse(row.state_json);
    const results = [];
    for (const value of values) {
      const event = validateEnvelope(value, matchId);
      const device = this.database.prepare("SELECT account_id FROM devices WHERE id=?").get(event.deviceId);
      if (!device || device.account_id !== principal.accountId) throw new AccessError("DEVICE_BINDING_REQUIRED", 403, "This event device is not enrolled to the authenticated account.");
      const signature2 = digest(canonical3(event));
      const previous = this.database.prepare("SELECT * FROM events WHERE event_id=?").get(event.eventId);
      if (previous) {
        if (previous.match_id !== matchId || previous.signature !== signature2) {
          this.database.prepare("INSERT INTO conflicting_submissions VALUES(?,?,?,?,?,?)").run(randomUUID(), matchId, principal.accountId, JSON.stringify(value), "EVENT_ID_CONFLICT", this.now());
          results.push({ eventId: event.eventId, clientSequence: event.clientSequence, disposition: "quarantined", reason: "EVENT_ID_CONFLICT", revision: null, duplicate: false });
        } else results.push({ eventId: previous.event_id, clientSequence: previous.client_sequence, disposition: previous.disposition, reason: previous.reason, revision: previous.revision, duplicate: true });
        continue;
      }
      const stream = this.database.prepare("SELECT sequence,previous_event_id FROM streams WHERE match_id=? AND device_id=?").get(matchId, event.deviceId);
      if (event.clientSequence !== (stream?.sequence ?? 0) + 1 || event.previousEventId !== (stream?.previous_event_id ?? null)) {
        this.database.prepare("INSERT INTO conflicting_submissions VALUES(?,?,?,?,?,?)").run(randomUUID(), matchId, principal.accountId, JSON.stringify(value), "SEQUENCE_GAP_OR_REUSE", this.now());
        results.push({ eventId: event.eventId, clientSequence: event.clientSequence, disposition: "quarantined", reason: "SEQUENCE_GAP_OR_REUSE", revision: null, duplicate: false });
        continue;
      }
      let reason = null;
      if (event.contractVersion !== EVENT_CONTRACT_VERSION || event.schemaVersion !== 1 || event.engineVersion !== ENGINE_VERSION) reason = "UNSUPPORTED_EVENT_VERSION";
      else if (!grant || !currentCapability || event.controllerEpoch !== grant.epoch || event.deviceId !== grant.device_id) reason = "STALE_CONTROLLER";
      else if (grant.frozen) reason = "HANDOVER_WRITES_FROZEN";
      else if (event.baseRevision !== state.revision) reason = "STALE_REVISION";
      if (!reason) {
        try {
          const next = reduceMatch(state, { ...event.command, actorId: principal.accountId });
          const effective = effectiveEventTime(state, next, event.command);
          if (effective.half !== event.effectiveHalf || effective.halfElapsedMs !== event.halfElapsedMs || effective.matchElapsedMs !== event.matchElapsedMs) throw new Error("Effective playing-time evidence differs from the command.");
          state = next;
        } catch {
          reason = "INVALID_MATCH_TRANSITION";
        }
      }
      const disposition = reason ? "quarantined" : "accepted";
      const revision = reason ? null : state.revision;
      this.database.prepare("INSERT INTO events(event_id,match_id,device_id,client_sequence,envelope_json,signature,disposition,reason,revision,received_at,actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(event.eventId, matchId, event.deviceId, event.clientSequence, JSON.stringify(event), signature2, disposition, reason, revision, this.now(), principal.accountId);
      this.database.prepare("INSERT INTO streams(match_id,device_id,sequence,previous_event_id) VALUES(?,?,?,?) ON CONFLICT(match_id,device_id) DO UPDATE SET sequence=excluded.sequence,previous_event_id=excluded.previous_event_id").run(matchId, event.deviceId, event.clientSequence, event.eventId);
      results.push({ eventId: event.eventId, clientSequence: event.clientSequence, disposition, reason, revision, duplicate: false });
    }
    if (results.some((item) => item.disposition === "accepted" && !item.duplicate)) this.database.prepare("UPDATE matches SET state_json=?,last_sync_at=? WHERE id=?").run(JSON.stringify(state), this.now(), matchId);
    this.audit(principal, "events.uploaded", matchId, results.some((item) => item.disposition === "quarantined") ? "review_required" : "accepted");
    return { results, revision: state.revision, pendingReview: results.some((item) => item.disposition === "quarantined") };
  }
  quarantine(principal, matchId) {
    this.managerMatch(principal, matchId);
    return [...this.database.prepare("SELECT event_id,device_id,client_sequence,envelope_json,reason,received_at FROM events WHERE match_id=? AND disposition='quarantined' ORDER BY received_at,client_sequence").all(matchId), ...this.database.prepare("SELECT id,original_json,reason,created_at FROM conflicting_submissions WHERE match_id=? ORDER BY created_at").all(matchId)];
  }
  offerHandover(principal, matchId, token, toAccountId, toDeviceId, baseRevision) {
    const row = this.managerMatch(principal, matchId);
    const grant = this.assertController(principal, matchId, token);
    if (grant.frozen) throw new AccessError("TRANSFER_PENDING", 409, "A controller transfer is already pending.");
    const state = JSON.parse(row.state_json);
    if (state.revision !== baseRevision) throw new AccessError("STALE_REVISION", 409, "Synchronise the accepted checkpoint before handover.");
    if (state.status.endsWith("_running")) throw new AccessError("CLOCK_ANCHOR_REQUIRED", 409, "Running handover requires a verified UTC/device clock exchange. This development service supports handover while the match clock is already paused, at half-time or before kick-off; it never silently pauses play.");
    if (!validId(toAccountId) || !validDeviceId(toDeviceId)) bad("A target account and canonical device identifier of at most 120 characters are required.");
    const target = this.database.prepare("SELECT * FROM accounts WHERE id=?").get(toAccountId);
    if (!target) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    const targetPrincipal = { accountId: target.id, issuer: target.issuer, subject: target.subject, identityClassification: target.classification, adultVerified: !!target.adult_verified, strongAuth: !!target.strong_auth_enrolled, authenticatedAt: this.now(), status: target.status };
    assertCanManageTeam(targetPrincipal, this.memberships(), row.team_id, row.season_id, this.now());
    const id3 = randomUUID();
    this.database.prepare("INSERT INTO transfers VALUES(?,?,?,?,?,?,?)").run(id3, matchId, grant.epoch, toAccountId, toDeviceId, "pending", this.now());
    this.database.prepare("UPDATE controller_grants SET frozen=1 WHERE match_id=?").run(matchId);
    this.audit(principal, "controller.transfer_offered", matchId, "pending");
    return { transferId: id3, state: "pending", acceptedRevision: state.revision };
  }
  acceptHandover(principal, matchId, transferId, deviceId) {
    this.managerMatch(principal, matchId);
    assertAdultAuthority(principal, false, this.now());
    const transfer = this.database.prepare("SELECT * FROM transfers WHERE id=? AND match_id=?").get(transferId, matchId);
    const grant = this.database.prepare("SELECT * FROM controller_grants WHERE match_id=?").get(matchId);
    if (!transfer || transfer.to_account_id !== principal.accountId || transfer.to_device_id !== deviceId) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    if (transfer.state !== "pending" || !grant || grant.epoch !== transfer.from_epoch || !grant.frozen) throw new AccessError("TRANSFER_CONFLICT", 409, "Check the authoritative transfer status before retrying.");
    this.bindDevice(principal, deviceId);
    const capability = randomBytes(32).toString("base64url");
    const epoch = grant.epoch + 1;
    this.database.prepare("UPDATE controller_grants SET epoch=?,account_id=?,device_id=?,capability_hash=?,frozen=0 WHERE match_id=?").run(epoch, principal.accountId, deviceId, digest(capability), matchId);
    this.database.prepare("UPDATE transfers SET state='accepted' WHERE id=?").run(transferId);
    this.database.prepare("INSERT INTO controller_history VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), matchId, epoch, principal.accountId, grant.device_id, deviceId, "transferred", null, this.now());
    this.audit(principal, "controller.transferred", matchId, "accepted");
    return { epoch, deviceId, controllerToken: capability, checkpoint: this.download(principal, matchId, deviceId).deviceCheckpoint, acceptedRevision: JSON.parse(this.match(matchId).state_json).revision };
  }
  recover(principal, matchId, deviceId, reason) {
    const row = this.managerMatch(principal, matchId);
    assertAdultAuthority(principal, true, this.now());
    if (!validDeviceId(deviceId) || typeof reason !== "string" || reason.trim().length < 5 || reason.length > 500) bad("Recovery needs a target canonical device identifier of at most 120 characters and a concise audit reason.");
    this.bindDevice(principal, deviceId);
    const old = this.database.prepare("SELECT * FROM controller_grants WHERE match_id=?").get(matchId);
    const capability = randomBytes(32).toString("base64url");
    const epoch = (old?.epoch ?? 0) + 1;
    const state = JSON.parse(row.state_json);
    if (state.status.endsWith("_running")) {
      state.recoveryRequired = true;
      state.recoveryReason = "Controller recovery: reconcile the referee clock and any unsynchronised old-device events.";
      this.database.prepare("UPDATE matches SET state_json=? WHERE id=?").run(JSON.stringify(state), matchId);
    }
    this.database.prepare("INSERT INTO controller_grants(match_id,epoch,account_id,device_id,capability_hash,frozen) VALUES(?,?,?,?,?,0) ON CONFLICT(match_id) DO UPDATE SET epoch=excluded.epoch,account_id=excluded.account_id,device_id=excluded.device_id,capability_hash=excluded.capability_hash,frozen=0").run(matchId, epoch, principal.accountId, deviceId, digest(capability));
    this.database.prepare("UPDATE transfers SET state='superseded' WHERE match_id=? AND state='pending'").run(matchId);
    this.database.prepare("INSERT INTO controller_history VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), matchId, epoch, principal.accountId, old?.device_id ?? null, deviceId, "recovered", reason.trim(), this.now());
    this.audit(principal, "controller.recovered", matchId, "reconciliation_required");
    return { epoch, deviceId, controllerToken: capability, reconciliationRequired: true, checkpoint: this.download(principal, matchId, deviceId).deviceCheckpoint };
  }
  assignManager(actor, teamId, seasonId, accountId) {
    const account2 = this.database.prepare("SELECT * FROM accounts WHERE id=?").get(accountId);
    if (!account2) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    const target = { accountId: account2.id, issuer: account2.issuer, subject: account2.subject, identityClassification: account2.classification, adultVerified: !!account2.adult_verified, strongAuth: !!account2.strong_auth_enrolled, authenticatedAt: this.now(), status: account2.status };
    assertCanAssignManager(actor, target, this.memberships(), teamId, seasonId, this.now());
    this.database.prepare("INSERT INTO memberships(account_id,team_id,season_id,role) VALUES(?,?,?,'manager') ON CONFLICT(account_id,team_id,season_id,role) DO UPDATE SET revoked_at=NULL,expires_at=NULL").run(accountId, teamId, seasonId);
    this.audit(actor, "manager.assigned", teamId, "accepted");
    return { accountId, teamId, seasonId, role: "manager" };
  }
  privacyRequest(principal, kind, policyVersion) {
    if (!["export", "delete_account", "leave_team"].includes(kind)) bad("Unsupported privacy request.");
    const id3 = randomUUID();
    this.database.prepare("INSERT INTO privacy_requests VALUES(?,?,?,?,?,?,?)").run(id3, principal.accountId, kind, "pending_verification_and_policy", policyVersion, null, this.now());
    this.audit(principal, "privacy.requested", id3, "pending_verification_and_policy");
    return { requestId: id3, kind, status: "pending_verification_and_policy", verificationRequired: true, erased: false };
  }
  privacyRequests(principal) {
    return this.database.prepare("SELECT id,kind,status,policy_version,verified_at,created_at FROM privacy_requests WHERE account_id=? ORDER BY created_at").all(principal.accountId);
  }
  /** Explicit setup seam: an authorised operator imports verified provider-to-account mappings; no token creates authority. */
  bindIdentity(accountId, issuer2, subject) {
    this.database.prepare("UPDATE accounts SET issuer=?,subject=? WHERE id=?").run(issuer2, subject, accountId);
  }
  bindDevice(principal, deviceId) {
    const device = this.database.prepare("SELECT account_id FROM devices WHERE id=?").get(deviceId);
    if (device && device.account_id !== principal.accountId) throw new AccessError("DEVICE_ACCOUNT_CONFLICT", 409, "Enrol a separate device identity for this account.");
    this.database.prepare("INSERT INTO devices(id,account_id) VALUES(?,?) ON CONFLICT(id) DO NOTHING").run(deviceId, principal.accountId);
  }
  teamMatches(principal, teamId, seasonId) {
    assertTeamRole(principal, this.memberships(), teamId, seasonId, ["manager", "player", "spectator"], this.now());
    return this.database.prepare("SELECT id FROM matches WHERE team_id=? AND season_id=? ORDER BY id LIMIT 100").all(teamId, seasonId).map((row) => this.matchDto(principal, row.id));
  }
  document(teamId, seasonId, kind) {
    const row = this.database.prepare("SELECT value_json FROM documents WHERE team_id=? AND season_id=? AND kind=?").get(teamId, seasonId, kind);
    if (!row) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    return JSON.parse(row.value_json);
  }
  saveDocument(teamId, seasonId, kind, state) {
    this.database.prepare("INSERT INTO documents(team_id,season_id,kind,revision,value_json) VALUES(?,?,?,?,?) ON CONFLICT(team_id,season_id,kind) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json").run(teamId, seasonId, kind, state.revision, JSON.stringify(state));
  }
  preparation(principal, teamId, seasonId) {
    assertCanManageTeam(principal, this.memberships(), teamId, seasonId, this.now());
    return this.document(teamId, seasonId, "preparation");
  }
  /** Called inside the preparation mutation transaction; current labels never rewrite saved match evidence. */
  projectPreparationRecords(teamId, seasonId, preparation, sourceCommandId) {
    const previous = this.document(teamId, seasonId, "records");
    const labels = new Map(previous.players.map((player) => [player.id, player]));
    for (const profile of preparation.profiles.filter((profile2) => profile2.seasonId === seasonId)) labels.set(profile.playerId, { id: profile.playerId, label: profile.displayName });
    const players = [...labels.values()];
    const evidence = trainingAttendanceEvidence({ ...preparation, training: preparation.training.filter((session) => session.seasonId === seasonId) });
    let records = previous;
    const at = new Date(this.now()).toISOString();
    if (canonical3(players) !== canonical3(previous.players)) records = {
      ...records,
      players,
      revision: records.revision + 1,
      audit: [...records.audit, { commandId: `preparation-roster-${sourceCommandId}`, action: "preparation.roster.projected", matchId: null, at, reason: "Current season roster labels updated from preparation; saved match snapshots preserved.", before: null, after: null }]
    };
    if (canonical3(evidence) !== canonical3(previous.trainingAttendance)) records = reduceRecords(records, { type: "training.evidence.replace", commandId: `preparation-training-${sourceCommandId}`, at, actor: "manager", evidence });
    if (records !== previous) this.saveDocument(teamId, seasonId, "records", records);
  }
  preparationCommand(principal, teamId, seasonId, command) {
    const previous = this.preparation(principal, teamId, seasonId);
    const types = ["club.updated", "team.updated", "season.rolled_over", "profile.saved", "profile.archived", "formation.saved", "fixture.saved", "fixture.status_changed", "fixture.response_recorded", "fixture.selection_saved", "fixture.attendance_recorded", "fixture.prepared", "training.saved", "training.status_changed", "training.response_recorded", "training.attendance_recorded"];
    if (!command || !types.includes(command.type)) bad("Unsupported preparation command.");
    if (command.type === "season.rolled_over") throw new AccessError("SEASON_ASSIGNMENT_REQUIRED", 503, "A connected new season requires approved manager/player assignments and explicit spectator renewal. The local rehearsal supports rollover; this service will not save an inaccessible new season or silently copy authority.");
    if (command.type === "club.updated") {
      assertTeamRole(principal, this.memberships(), teamId, seasonId, ["administrator"], this.now());
      assertAdultAuthority(principal, true, this.now());
    }
    const state = reducePreparation(previous, command);
    if (command.type === "fixture.prepared") {
      const snapshot = state.snapshots.find((snapshot2) => snapshot2.fixtureId === command.fixtureId && snapshot2.preparedRevision === command.expectedRevision + 1);
      if (!snapshot) throw new AccessError("PREPARATION_SNAPSHOT_REQUIRED", 409, "The immutable prepared fixture snapshot is unavailable.");
      assertCanManageTeam(principal, this.memberships(), teamId, snapshot.seasonId, this.now());
      const config = fixtureMatchConfig(state, snapshot);
      const existing = this.database.prepare("SELECT * FROM matches WHERE id=?").get(config.matchId);
      if (!existing) this.insertMatch(config, teamId, snapshot.seasonId);
      else {
        if (existing.team_id !== teamId || existing.season_id !== snapshot.seasonId) throw new AccessError("MATCH_SCOPE_CONFLICT", 409, "That fixture identity already belongs to another match scope.");
        if (canonical3(JSON.parse(existing.config_json)) !== canonical3(config)) {
          const matchState = JSON.parse(existing.state_json);
          const claimed = this.database.prepare("SELECT match_id FROM controller_grants WHERE match_id=?").get(config.matchId);
          const history = this.database.prepare("SELECT event_id FROM events WHERE match_id=? LIMIT 1").get(config.matchId);
          if (claimed || history || matchState.revision !== 0 || matchState.status !== "preparation") throw new AccessError("MATCH_HISTORY_EXISTS", 409, "This match already has a controller or recorded history. Preserve its saved snapshot and reconcile changes explicitly.");
          this.database.prepare("UPDATE matches SET config_json=?,state_json=? WHERE id=?").run(JSON.stringify(config), JSON.stringify(createMatch(config)), config.matchId);
        }
      }
    }
    if (command.type.startsWith("training.") || command.type.startsWith("profile.")) this.projectPreparationRecords(teamId, seasonId, state, command.id);
    this.saveDocument(teamId, seasonId, "preparation", state);
    this.audit(principal, command.type, teamId, "accepted");
    return state;
  }
  ownPreparation(principal, teamId, seasonId) {
    const membership = assertTeamRole(principal, this.memberships(), teamId, seasonId, ["player"], this.now());
    const state = this.document(teamId, seasonId, "preparation");
    const profiles = state.profiles.filter((profile2) => profile2.playerId === membership.playerId && profile2.seasonId === seasonId && profile2.active);
    if (profiles.length !== 1) throw new AccessError("NOT_FOUND", 404, "The requested own-player profile is unavailable.");
    const profile = profiles[0];
    return {
      kind: "player-preparation",
      revision: state.revision,
      team: { id: state.team.id, name: state.team.name, ageGroup: state.team.ageGroup },
      season: state.seasons.find((season) => season.id === seasonId),
      profile,
      fixtures: state.fixtures.filter((fixture) => fixture.seasonId === seasonId).map((fixture) => ({ id: fixture.id, opponent: fixture.opponent, playedDate: fixture.playedDate, kickoff: fixture.kickoff, venue: fixture.venue, homeAway: fixture.homeAway, status: fixture.status, response: fixture.responses[profile.id] ?? "no_reply", selected: fixture.selectedProfileIds.includes(profile.id), attendance: fixture.attendance[profile.id] ?? "not_recorded" })),
      training: state.training.filter((session) => session.seasonId === seasonId).map((session) => ({ id: session.id, date: session.date, time: session.time, venue: session.venue, status: session.status, expected: session.expectedProfileIds.includes(profile.id), response: session.responses[profile.id] ?? "no_reply", attendance: session.attendance[profile.id] ?? "not_recorded" }))
    };
  }
  ownPreparationCommand(principal, teamId, seasonId, command) {
    const membership = assertTeamRole(principal, this.memberships(), teamId, seasonId, ["player"], this.now());
    if (!command || !validId(command.id) || !nonnegative2(command.expectedRevision) || !["own.preferences_saved", "own.fixture_response_recorded", "own.training_response_recorded"].includes(command.type)) bad("A valid own-player command and source revision are required.");
    const allowed = command.type === "own.preferences_saved" ? ["id", "expectedRevision", "type", "preferences"] : command.type === "own.fixture_response_recorded" ? ["id", "expectedRevision", "type", "fixtureId", "response"] : ["id", "expectedRevision", "type", "trainingId", "response"];
    if (Object.keys(command).some((key) => !allowed.includes(key))) bad("Own-player commands cannot change another profile or manager-controlled fields.");
    const state = this.document(teamId, seasonId, "preparation");
    const profiles = state.profiles.filter((profile2) => profile2.playerId === membership.playerId && profile2.seasonId === seasonId && profile2.active);
    if (profiles.length !== 1) throw new AccessError("NOT_FOUND", 404, "The requested own-player profile is unavailable.");
    const profile = profiles[0];
    const base = { id: command.id, expectedRevision: command.expectedRevision };
    const bound = command.type === "own.preferences_saved" ? { ...base, type: "profile.saved", profile: { ...profile, preferences: command.preferences } } : command.type === "own.fixture_response_recorded" ? { ...base, type: "fixture.response_recorded", fixtureId: command.fixtureId, profileId: profile.id, response: command.response } : { ...base, type: "training.response_recorded", trainingId: command.trainingId, profileId: profile.id, response: command.response };
    const updated = reducePreparation(state, bound);
    if (bound.type.startsWith("training.") || bound.type.startsWith("profile.")) this.projectPreparationRecords(teamId, seasonId, updated, command.id);
    this.saveDocument(teamId, seasonId, "preparation", updated);
    this.audit(principal, command.type, teamId, "accepted");
    return this.ownPreparation(principal, teamId, seasonId);
  }
  /** SQL account/membership records remain the authority; the serializable model is a projection. */
  communityState(teamId, seasonId) {
    const state = this.document(teamId, seasonId, "community");
    const accounts = this.database.prepare("SELECT * FROM accounts WHERE status='active'").all();
    const memberships = this.memberships();
    return {
      ...state,
      accounts: accounts.map((account2) => ({ id: account2.id, label: state.accounts.find((person) => person.id === account2.id)?.label ?? "Verified account", classification: account2.classification === "unclassified" ? "spectator" : account2.classification, adultVerified: !!account2.adult_verified })),
      memberships: memberships.filter((item) => item.role === "manager" || item.role === "player").map((item) => ({ accountId: item.accountId, teamId: item.teamId, seasonId: item.seasonId, role: item.role, playerId: item.playerId, active: item.revokedAt == null && (item.expiresAt == null || item.expiresAt > this.now()) }))
    };
  }
  communityActor(principal, teamId, seasonId, requestedRole, invitationAcceptance = false) {
    const memberships = this.memberships();
    if (invitationAcceptance) return { accountId: principal.accountId, teamId, seasonId, role: "spectator" };
    const allowed = currentMemberships(principal, memberships, this.now()).filter((item) => item.teamId === teamId && item.seasonId === seasonId && ["manager", "player", "spectator"].includes(item.role));
    const chosen = requestedRole ? allowed.find((item) => item.role === requestedRole) : allowed.find((item) => item.role === "manager") ?? allowed[0];
    if (!chosen) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    if (chosen.role === "manager") assertAdultAuthority(principal, false, this.now());
    const actor = { accountId: principal.accountId, teamId, seasonId, role: chosen.role, playerId: chosen.playerId };
    const document = this.database.prepare("SELECT team_id FROM documents WHERE team_id=? AND season_id=? AND kind='community'").get(teamId, seasonId);
    if (document && !communityCanAccess(this.communityState(teamId, seasonId), actor, this.now())) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    return actor;
  }
  community(principal, teamId, seasonId, role) {
    const actor = this.communityActor(principal, teamId, seasonId, role);
    const state = this.communityState(teamId, seasonId);
    return { ...getCommunityView(state, actor, this.now()), revision: state.revision };
  }
  communityCommand(principal, teamId, seasonId, command, role) {
    if (!command || !validId(command.id) || typeof command.type !== "string") bad("A typed community command with a stable identity is required.");
    if (command.type === "concern.updated" && !["under_review", "resolved"].includes(command.status)) bad("Invalid concern status.");
    if (command.type === "concern.submitted" && (!["photo", "uploader"].includes(command.targetType) || !["privacy", "inappropriate", "other"].includes(command.category))) bad("Invalid concern category.");
    if (command.type === "uploader.hidden" && typeof command.hidden !== "boolean") bad("Choose whether to hide the uploader.");
    if (command.type === "privacy.drafted" && !["export", "delete_global_account"].includes(command.requestType)) bad("Invalid privacy request type.");
    if (command.type === "match.registered") throw new AccessError("POLICY_APPROVAL_REQUIRED", 503, "Connected award and sharing context must be derived from accepted match evidence, a verified finish-time anchor and independently approved competition policy. Caller-supplied trusted finish or sharing policy is not accepted.");
    const actor = this.communityActor(principal, teamId, seasonId, role, command.type === "invite.accepted");
    const previous = this.communityState(teamId, seasonId);
    const state = applyCommunityCommand(previous, actor, command, this.now());
    this.saveDocument(teamId, seasonId, "community", state);
    if (["invite.accepted", "invite.revoked", "grant.revoked"].includes(command.type)) this.synchronizeSpectatorMemberships(state);
    for (const match of state.matches.filter((match2) => match2.voteCutoffAtMs !== null && match2.finishQuality === "trusted" && !state.awards.some((award) => award.matchId === match2.id))) {
      const key = `award:${teamId}:${seasonId}:${match.id}:${match.voteCutoffAtMs}`;
      this.database.prepare("INSERT INTO jobs(id,business_key,kind,payload_json,due_at) VALUES(?,?,?,?,?) ON CONFLICT(business_key) DO NOTHING").run(randomUUID(), key, "award.finalise", JSON.stringify({ teamId, seasonId, matchId: match.id }), match.voteCutoffAtMs);
    }
    this.audit(principal, command.type, teamId, "accepted");
    return { ...getCommunityView(state, actor, this.now()), revision: state.revision };
  }
  synchronizeSpectatorMemberships(state) {
    const scopes = /* @__PURE__ */ new Map();
    for (const grant of state.grants) scopes.set(JSON.stringify([grant.accountId, grant.teamId, grant.seasonId]), { accountId: grant.accountId, teamId: grant.teamId, seasonId: grant.seasonId });
    for (const scope of scopes.values()) {
      const grants = state.grants.filter((grant) => grant.accountId === scope.accountId && grant.teamId === scope.teamId && grant.seasonId === scope.seasonId);
      const active = grants.filter((grant) => grant.revokedAtMs === null && grant.startsAtMs <= this.now() && grant.expiresAtMs > this.now());
      const expiresAt = Math.max(...(active.length ? active : grants).map((grant) => grant.expiresAtMs));
      const revokedAt = active.length ? null : Math.max(1, this.now());
      this.database.prepare("INSERT INTO memberships(account_id,team_id,season_id,role,expires_at,revoked_at) VALUES(?,?,?,'spectator',?,?) ON CONFLICT(account_id,team_id,season_id,role) DO UPDATE SET expires_at=excluded.expires_at,revoked_at=excluded.revoked_at").run(scope.accountId, scope.teamId, scope.seasonId, expiresAt, revokedAt);
    }
  }
  media(principal, teamId, seasonId, photoId, mode, role) {
    const actor = this.communityActor(principal, teamId, seasonId, role);
    const result = authorizeCommunityMedia(this.communityState(teamId, seasonId), actor, photoId, this.now(), mode);
    if (!result.allowed) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    return result;
  }
  recordsViewer(principal, teamId, seasonId, role) {
    const actor = this.communityActor(principal, teamId, seasonId, role);
    return { actor: actor.role, playerId: actor.playerId, teamId, seasonId };
  }
  records(principal, teamId, seasonId, role) {
    const viewer = this.recordsViewer(principal, teamId, seasonId, role);
    const state = this.document(teamId, seasonId, "records");
    const matchRow = this.database.prepare("SELECT state_json FROM matches WHERE id=? AND team_id=? AND season_id=?").get(state.liveMatch.matchId, teamId, seasonId);
    const match = matchRow ? JSON.parse(matchRow.state_json) : null;
    return { revision: state.revision, results: selectSeasonResults(state, viewer), participation: selectParticipationReport(state, match, viewer), matches: state.results.map((record) => selectMatchReport(state, record.id, viewer, match)), ...viewer.actor === "manager" ? { editableState: state } : {} };
  }
  recordsCommand(principal, teamId, seasonId, command) {
    assertCanManageTeam(principal, this.memberships(), teamId, seasonId, this.now());
    const previous = this.document(teamId, seasonId, "records");
    if (!command || !["historical.add", "historical.correct", "live.archive", "live.context.set", "publication.set", "training.evidence.replace"].includes(command.type)) bad("Unsupported records command.");
    let bound = { ...command, actor: "manager", at: new Date(this.now()).toISOString() };
    if (command.type === "live.archive") {
      const match = this.managerMatch(principal, command.match.config.matchId);
      if (match.team_id !== teamId || match.season_id !== seasonId) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
      bound = { ...bound, match: JSON.parse(match.state_json) };
    }
    if (command.type === "publication.set" && command.policy.confirmed) throw new AccessError("POLICY_APPROVAL_REQUIRED", 503, "The competition sharing policy requires an independently approved operator record; a manager command cannot approve open Q21.");
    const state = reduceRecords(previous, bound);
    this.saveDocument(teamId, seasonId, "records", state);
    this.audit(principal, command.type, teamId, "accepted");
    return this.records(principal, teamId, seasonId, "manager");
  }
};

// apps/api/contracts/events-v1.1.schema.json
var events_v1_1_schema_default = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://longball.invalid/contracts/events-v1.1.schema.json",
  title: "LongBall incremental command envelope 1.1",
  description: "Deliberate C-001 companion: engineVersion is required immutable provenance. This incremental command transport adapts the shared reducer, including local preparation commands, and does not claim that the archived v0.1 OpenAPI Event variants accept an added property. Original archived artifacts remain unchanged. The service assigns receipt time and accepted revision. Unknown versions are retained in quarantine. Real controller handover, identity and release gates remain separately documented.",
  type: "object",
  additionalProperties: false,
  required: ["contractVersion", "schemaVersion", "engineVersion", "eventId", "matchId", "deviceId", "controllerEpoch", "clientSequence", "previousEventId", "baseRevision", "effectiveHalf", "halfElapsedMs", "matchElapsedMs", "effectiveAt", "recordedAt", "timeQuality", "clockEvidence", "command"],
  properties: {
    contractVersion: { const: "longball.events/1.1" },
    schemaVersion: { const: 1 },
    engineVersion: { type: "string", minLength: 1, maxLength: 80 },
    eventId: { $ref: "#/$defs/id" },
    matchId: { $ref: "#/$defs/id" },
    deviceId: { type: "string", pattern: "^[A-Za-z0-9_-]+$", minLength: 1, maxLength: 120 },
    controllerEpoch: { type: "integer", minimum: 1 },
    clientSequence: { type: "integer", minimum: 1 },
    previousEventId: { oneOf: [{ $ref: "#/$defs/id" }, { type: "null" }] },
    baseRevision: { type: "integer", minimum: 0 },
    effectiveHalf: { type: "integer", enum: [0, 1, 2] },
    halfElapsedMs: { type: "integer", minimum: 0 },
    matchElapsedMs: { type: "integer", minimum: 0 },
    effectiveAt: { type: ["string", "null"], format: "date-time" },
    recordedAt: { type: "string", format: "date-time" },
    timeQuality: { enum: ["anchored", "estimated", "reviewRequired"] },
    clockEvidence: {
      type: "object",
      additionalProperties: false,
      required: ["monotonicMs", "anchorId", "continuityId"],
      properties: {
        monotonicMs: { type: "number", minimum: 0 },
        anchorId: { $ref: "#/$defs/id" },
        continuityId: { oneOf: [{ $ref: "#/$defs/id" }, { type: "null" }] }
      }
    },
    command: {
      type: "object",
      required: ["id", "type", "sample"],
      properties: {
        id: { $ref: "#/$defs/id" },
        type: { enum: ["attendance.recorded", "availability.changed", "lineup.staged", "half.started", "half.paused", "half.resumed", "half.ended", "lineup.committed", "goal.recorded", "clock.recovery_required", "clock.corrected", "event.corrected", "event.voided", "policy.changed", "match.abandoned"] },
        sample: {
          type: "object",
          additionalProperties: false,
          required: ["monotonicMs", "sessionId", "wallTimeMs"],
          properties: { monotonicMs: { type: "number", minimum: 0 }, sessionId: { $ref: "#/$defs/id" }, wallTimeMs: { type: "integer", minimum: 0 } }
        }
      },
      description: "Type-specific fields are checked by the selected versioned deterministic reducer. This schema describes the transport boundary; it is not evidence of complete production OpenAPI endpoint coverage."
    }
  },
  $defs: { id: { type: "string", pattern: "^[A-Za-z0-9_-]+$", minLength: 1, maxLength: 150 } }
};

// apps/api/src/media.ts
import { createHash as createHash2, randomBytes as randomBytes2, randomUUID as randomUUID2, timingSafeEqual } from "node:crypto";
import { chmodSync as chmodSync2, mkdirSync as mkdirSync2, readFileSync } from "node:fs";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
var MEDIA_LIMITS = {
  maxBytes: 15 * 1024 * 1024,
  maxPixels: 4e7,
  displayEdge: 2048,
  thumbnailEdge: 480,
  uploadWindowMs: 15 * 6e4,
  uploadTimeoutMs: 6e4,
  decodeTimeoutMs: 12e3,
  scannerTimeoutMs: 2e4
};
var executeFile = promisify(execFile);
var hash = (value) => createHash2("sha256").update(value).digest("hex");
var id = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,150}$/.test(value);
function fail(code, status, message) {
  throw new AccessError(code, status, message);
}
function auth(state, actor, now, upload = false) {
  if (!communityCanAccess(state, actor, now) || upload && actor.role === "spectator") fail("NOT_FOUND", 404, "The requested media operation is unavailable.");
}
function sameToken(expectedHash, token) {
  return typeof token === "string" && token.length <= 256 && timingSafeEqual(Buffer.from(expectedHash, "hex"), Buffer.from(hash(token), "hex"));
}
async function bounded(promise, milliseconds, code) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new AccessError(code, 503, "Media processing is unavailable. The private upload is retained for a safe retry.")), Math.max(1, milliseconds));
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function actualMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  return null;
}
function rejectAnimatedPng(bytes) {
  if (actualMime(bytes) !== "image/png") return;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) fail("INVALID_IMAGE", 415, "The image is incomplete or unsupported.");
    const kind = bytes.toString("ascii", offset + 4, offset + 8);
    if (kind === "acTL") fail("ANIMATED_IMAGE_UNSUPPORTED", 415, "Animated images are not supported.");
    offset += length + 12;
    if (kind === "IEND") break;
  }
}
function createClamAvScanner(executable, options = {}) {
  if (!isAbsolute(executable)) fail("SCANNER_CONFIGURATION_INVALID", 503, "Configure an absolute path to the maintained ClamAV scanner.");
  const timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? 15e3, 2e4));
  let versionCheck = null;
  const identify = async () => {
    try {
      const result = await executeFile(executable, ["--version"], { timeout: Math.min(timeoutMs, 3e3), maxBuffer: 8192, windowsHide: true });
      return /^ClamAV\s+([0-9][0-9A-Za-z.+_-]*)/.exec(result.stdout.trim())?.[1] ?? null;
    } catch {
      return null;
    }
  };
  return {
    scan: async (bytes) => {
      const version = await (versionCheck ??= identify());
      if (!version) return { verdict: "unavailable", engine: "clamav_unverified" };
      return new Promise((resolveVerdict) => {
        const child = spawn(executable, ["--no-summary", "--stdout", "--max-filesize=16M", "--max-scansize=16M", "--max-files=1", "--max-recursion=1", "--alert-exceeds-max=yes", "-"], { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
        let finished = false;
        let outputBytes = 0;
        let scanOutput = "";
        const finish = (verdict) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolveVerdict({ verdict, engine: `clamav:${version}` });
        };
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish("unavailable");
        }, timeoutMs);
        const consume = (chunk) => {
          outputBytes += chunk.length;
          if (outputBytes > 64 * 1024) {
            child.kill("SIGKILL");
            finish("unavailable");
          }
        };
        child.stdout.on("data", (chunk) => {
          consume(chunk);
          if (outputBytes <= 64 * 1024) scanOutput += chunk.toString("utf8");
        });
        child.stderr.on("data", consume);
        child.on("error", () => finish("unavailable"));
        child.stdin.on("error", () => {
        });
        child.on("close", (code) => finish(code === 0 && /^stdin:\s+OK\s*$/m.test(scanOutput) ? "clean" : code === 1 ? "rejected" : "unavailable"));
        child.stdin.end(bytes);
      });
    }
  };
}
var DevelopmentMediaService = class {
  database;
  directory;
  now;
  scanner;
  ownDatabase;
  constructor(options) {
    this.directory = resolve(options.directory);
    mkdirSync2(this.directory, { recursive: true, mode: 448 });
    chmodSync2(this.directory, 448);
    for (const name of ["quarantine", "derivatives"]) {
      mkdirSync2(join(this.directory, name), { recursive: true, mode: 448 });
      chmodSync2(join(this.directory, name), 448);
    }
    this.ownDatabase = !options.database;
    this.database = options.database ?? new DatabaseSync2(join(this.directory, "media.sqlite"));
    if (this.ownDatabase) chmodSync2(join(this.directory, "media.sqlite"), 384);
    this.now = options.now ?? Date.now;
    this.scanner = options.scanner;
    this.database.exec(`CREATE TABLE IF NOT EXISTS media_uploads(
      id TEXT PRIMARY KEY,request_id TEXT NOT NULL,request_signature TEXT NOT NULL,owner_id TEXT NOT NULL,team_id TEXT NOT NULL,season_id TEXT NOT NULL,match_id TEXT NOT NULL,
      photo_id TEXT NOT NULL,source_revision INTEGER,display_revision INTEGER NOT NULL,status TEXT NOT NULL,expected_bytes INTEGER NOT NULL,expected_sha TEXT NOT NULL,
      declared_mime TEXT NOT NULL,caption TEXT NOT NULL,token_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,
      original_key TEXT,display_key TEXT,thumbnail_key TEXT,width INTEGER,height INTEGER,scanner_engine TEXT,failure_code TEXT,attempt TEXT,lease_until INTEGER,
      UNIQUE(owner_id,request_id));
      CREATE UNIQUE INDEX IF NOT EXISTS media_linked_revision ON media_uploads(photo_id,display_revision) WHERE status='linked';`);
  }
  close() {
    if (this.ownDatabase) this.database.close();
  }
  path(key) {
    const path = resolve(this.directory, key);
    if (!path.startsWith(this.directory + sep)) fail("MEDIA_STORE_INVALID", 503, "The private media object is unavailable.");
    return path;
  }
  row(state, actor, uploadId, token) {
    auth(state, actor, this.now(), true);
    if (!id(uploadId)) fail("NOT_FOUND", 404, "The requested upload is unavailable.");
    const row = this.database.prepare("SELECT * FROM media_uploads WHERE id=? AND owner_id=? AND team_id=? AND season_id=?").get(uploadId, actor.accountId, actor.teamId, actor.seasonId);
    if (!row || token !== void 0 && !sameToken(row.token_hash, token)) fail("NOT_FOUND", 404, "The requested upload is unavailable.");
    return row;
  }
  prepare(state, actor, input) {
    auth(state, actor, this.now(), true);
    const allowedKeys = ["requestId", "matchId", "byteSize", "mimeType", "sha256", "caption", "policyAcknowledged", "photoId", "sourceRevision"];
    if (!input || typeof input !== "object" || Object.keys(input).some((key) => !allowedKeys.includes(key)) || !id(input.requestId) || !id(input.matchId) || !Number.isSafeInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > MEDIA_LIMITS.maxBytes || !["image/jpeg", "image/png"].includes(input.mimeType) || typeof input.sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(input.sha256) || typeof input.caption !== "string" || input.caption.trim().length > 160 || input.policyAcknowledged !== true) {
      fail("INVALID_MEDIA_PREPARATION", 422, "Use a JPEG or PNG up to 15 MiB with a valid size, SHA-256 and policy acknowledgement. HEIC is not enabled until its decoder is validated.");
    }
    const match = state.matches.find((item) => item.id === input.matchId && item.teamId === actor.teamId && item.seasonId === actor.seasonId);
    if (!match) fail("NOT_FOUND", 404, "The requested match is unavailable.");
    const signature2 = hash(JSON.stringify([input.matchId, input.byteSize, input.mimeType, input.sha256.toLowerCase(), input.caption.trim(), input.policyAcknowledged, input.photoId ?? null, input.sourceRevision ?? null]));
    const existing = this.database.prepare("SELECT * FROM media_uploads WHERE owner_id=? AND request_id=?").get(actor.accountId, input.requestId);
    const token = randomBytes2(32).toString("base64url");
    if (existing) {
      if (existing.request_signature !== signature2 || existing.team_id !== actor.teamId || existing.season_id !== actor.seasonId) fail("IDEMPOTENCY_CONFLICT", 409, "This upload request identity was already used for different content.");
      if (existing.expires_at <= this.now() && ["prepared", "uploading"].includes(existing.status)) fail("UPLOAD_EXPIRED", 410, "The upload window expired. Prepare a new upload without discarding the previous private record.");
      this.database.prepare("UPDATE media_uploads SET token_hash=? WHERE id=?").run(hash(token), existing.id);
      return { uploadId: existing.id, photoId: existing.photo_id, uploadToken: token, expiresAtMs: existing.expires_at, maxBytes: MEDIA_LIMITS.maxBytes, displayRevision: existing.display_revision };
    }
    let sourceRevision = null;
    let photoId = `media-${randomUUID2()}`;
    if (input.photoId !== void 0 || input.sourceRevision !== void 0) {
      const photo = state.photos.find((item) => item.id === input.photoId && item.matchId === match.id && item.teamId === actor.teamId && item.seasonId === actor.seasonId && item.uploaderAccountId === actor.accountId && item.uploaderRole === actor.role && item.removedAtMs === null);
      if (!photo || !Number.isSafeInteger(input.sourceRevision) || photo.currentRevision !== input.sourceRevision) fail("MEDIA_REVISION_CONFLICT", 409, "The photo changed. Review its current revision before replacing it.");
      sourceRevision = photo.currentRevision;
      photoId = photo.id;
    }
    const uploadId = randomUUID2();
    const expiresAtMs = this.now() + MEDIA_LIMITS.uploadWindowMs;
    this.database.prepare(`INSERT INTO media_uploads(id,request_id,request_signature,owner_id,team_id,season_id,match_id,photo_id,source_revision,display_revision,status,expected_bytes,expected_sha,declared_mime,caption,token_hash,expires_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,'prepared',?,?,?,?,?,?,?)`).run(
      uploadId,
      input.requestId,
      signature2,
      actor.accountId,
      actor.teamId,
      actor.seasonId,
      match.id,
      photoId,
      sourceRevision,
      (sourceRevision ?? 0) + 1,
      input.byteSize,
      input.sha256.toLowerCase(),
      input.mimeType,
      input.caption.trim(),
      hash(token),
      expiresAtMs,
      this.now()
    );
    return { uploadId, photoId, uploadToken: token, expiresAtMs, maxBytes: MEDIA_LIMITS.maxBytes, displayRevision: (sourceRevision ?? 0) + 1 };
  }
  async upload(state, actor, uploadId, token, source) {
    const row = this.row(state, actor, uploadId, token);
    const duplicate = ["uploaded", "processed", "linked"].includes(row.status);
    if (!duplicate && row.expires_at <= this.now()) fail("UPLOAD_EXPIRED", 410, "The write-only upload window expired.");
    if (!duplicate && row.status !== "prepared" && !(row.status === "uploading" && (row.lease_until ?? 0) < this.now())) fail("UPLOAD_BUSY", 409, "This upload is already running or cannot be changed.");
    const attempt = randomUUID2();
    const key = `quarantine/${row.id}-${attempt}.upload`;
    const temporary = this.path(key + ".part");
    if (!duplicate) {
      const updated = this.database.prepare("UPDATE media_uploads SET status='uploading',attempt=?,lease_until=?,failure_code=NULL WHERE id=? AND (status='prepared' OR (status='uploading' AND lease_until<?))").run(attempt, this.now() + 65e3, row.id, this.now());
      if (!updated.changes) fail("UPLOAD_BUSY", 409, "This upload is already running.");
    }
    const destination = duplicate ? null : await open(temporary, "wx", 384);
    const digest2 = createHash2("sha256");
    let received = 0;
    const began = performance.now();
    const iterator = source[Symbol.asyncIterator]();
    try {
      while (true) {
        const item = await bounded(iterator.next(), MEDIA_LIMITS.uploadTimeoutMs - (performance.now() - began), "UPLOAD_TIMEOUT");
        if (item.done) break;
        const chunk = Buffer.from(item.value);
        received += chunk.length;
        if (received > row.expected_bytes || received > MEDIA_LIMITS.maxBytes) fail("UPLOAD_TOO_LARGE", 413, "The image exceeds its declared upload size.");
        digest2.update(chunk);
        if (destination) await destination.writeFile(chunk);
      }
      if (received !== row.expected_bytes || digest2.digest("hex") !== row.expected_sha) fail("UPLOAD_INTEGRITY_FAILED", 422, "The uploaded size or SHA-256 does not match. The private partial upload was not accepted.");
      if (destination) {
        await destination.sync();
        await destination.close();
        await rename(temporary, this.path(key));
        const changed = this.database.prepare("UPDATE media_uploads SET status='uploaded',original_key=?,lease_until=NULL,failure_code=NULL WHERE id=? AND attempt=? AND status='uploading'").run(key, row.id, attempt);
        if (!changed.changes) fail("UPLOAD_LEASE_CHANGED", 409, "The upload lease changed. The private branch is retained for review.");
      }
      return { uploadId, status: "uploaded", byteSize: received };
    } catch (error) {
      if (destination) {
        await destination.close().catch(() => void 0);
        await unlink(temporary).catch(() => void 0);
      }
      if (!duplicate) this.database.prepare("UPDATE media_uploads SET status='prepared',failure_code='UPLOAD_INCOMPLETE',lease_until=NULL WHERE id=? AND attempt=? AND status='uploading'").run(row.id, attempt);
      if (iterator.return) void Promise.resolve(iterator.return()).catch(() => void 0);
      throw error;
    }
  }
  completion(row) {
    const base = { id: `media-${row.id}-completed`, photoId: row.photo_id, art: "pitch", caption: row.caption, policyAcknowledged: true };
    const command = row.source_revision === null ? { ...base, type: "photo.submitted", matchId: row.match_id } : { ...base, type: "photo.revised", sourceRevision: row.source_revision };
    return { command, receipt: { uploadId: row.id, photoId: row.photo_id, status: "processed", width: row.width, height: row.height, displayRevision: row.display_revision } };
  }
  async complete(state, actor, uploadId, token) {
    const row = this.row(state, actor, uploadId, token);
    if (row.status === "processed" || row.status === "linked") return this.completion(row);
    if (row.status !== "uploaded" && !(row.status === "processing" && (row.lease_until ?? 0) < this.now())) fail("UPLOAD_NOT_READY", 409, "Finish the private upload before completion; an active processing lease cannot be duplicated.");
    if (!row.original_key) fail("UPLOAD_NOT_READY", 409, "The private original is unavailable.");
    const attempt = randomUUID2();
    const leased = this.database.prepare("UPDATE media_uploads SET status='processing',attempt=?,lease_until=?,failure_code=NULL WHERE id=? AND (status='uploaded' OR (status='processing' AND lease_until<?))").run(attempt, this.now() + 6e4, row.id, this.now());
    if (!leased.changes) fail("UPLOAD_BUSY", 409, "This image is already processing.");
    try {
      const original = await readFile(this.path(row.original_key));
      if (original.length !== row.expected_bytes || hash(original) !== row.expected_sha) fail("UPLOAD_INTEGRITY_FAILED", 422, "The private original does not match its recorded size and hash.");
      const mimeType = actualMime(original);
      if (!mimeType || mimeType !== row.declared_mime) fail("MEDIA_TYPE_MISMATCH", 415, "Decoded image type must match its bytes. Only JPEG and PNG are enabled.");
      rejectAnimatedPng(original);
      if (!this.scanner) fail("SCANNER_REQUIRED", 503, "Image safety scanning is not configured. The original remains private; no reviewable or published image was created.");
      const scan = await bounded(this.scanner.scan(original, { mimeType, sha256: row.expected_sha }), MEDIA_LIMITS.scannerTimeoutMs, "SCANNER_UNAVAILABLE");
      if (scan.verdict === "unavailable") fail("SCANNER_UNAVAILABLE", 503, "Image scanning is unavailable. The original remains private for a safe retry.");
      if (scan.verdict !== "clean") fail("IMAGE_SCAN_REJECTED", 422, "The image did not pass safety scanning and remains unpublished.");
      const displayKey = `derivatives/${row.photo_id}-v${row.display_revision}-${attempt}-display.jpg`;
      const thumbnailKey = `derivatives/${row.photo_id}-v${row.display_revision}-${attempt}-thumbnail.jpg`;
      let decoded;
      try {
        const result = await executeFile(process.execPath, [
          "--max-old-space-size=128",
          fileURLToPath(new URL("./media-worker.mjs", import.meta.url)),
          this.path(row.original_key),
          this.path(displayKey),
          this.path(thumbnailKey),
          mimeType
        ], { timeout: MEDIA_LIMITS.decodeTimeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024, windowsHide: true });
        decoded = JSON.parse(result.stdout);
        if (!Number.isSafeInteger(decoded.width) || !Number.isSafeInteger(decoded.height) || decoded.width < 1 || decoded.height < 1 || decoded.width > MEDIA_LIMITS.displayEdge || decoded.height > MEDIA_LIMITS.displayEdge) throw new Error();
      } catch {
        fail("IMAGE_DECODE_REJECTED", 415, "The image could not be safely decoded within the supported format, pixel and processing limits.");
      }
      const saved = this.database.prepare("UPDATE media_uploads SET status='processed',display_key=?,thumbnail_key=?,width=?,height=?,scanner_engine=?,failure_code=NULL,lease_until=NULL WHERE id=? AND attempt=? AND status='processing'").run(displayKey, thumbnailKey, decoded.width, decoded.height, scan.engine.slice(0, 100), row.id, attempt);
      if (!saved.changes) fail("PROCESSING_LEASE_CHANGED", 409, "The processing lease changed. No publication was performed.");
      return this.completion(this.row(state, actor, uploadId));
    } catch (error) {
      const code = error instanceof AccessError ? error.code : "MEDIA_PROCESSING_FAILED";
      const retryable = ["SCANNER_REQUIRED", "SCANNER_UNAVAILABLE", "MEDIA_PROCESSING_FAILED"].includes(code);
      this.database.prepare("UPDATE media_uploads SET status=?,failure_code=?,lease_until=NULL WHERE id=? AND attempt=? AND status='processing'").run(retryable ? "uploaded" : "rejected", code, row.id, attempt);
      throw error instanceof AccessError ? error : new AccessError("MEDIA_PROCESSING_FAILED", 503, "Image processing is unavailable. No image was published.");
    }
  }
  /** Call in the same SQLite transaction as applying and saving completion.command. */
  link(uploadId, state) {
    const row = this.database.prepare("SELECT * FROM media_uploads WHERE id=?").get(uploadId);
    if (!row || !["processed", "linked"].includes(row.status)) fail("MEDIA_NOT_PROCESSED", 409, "The image has not completed private processing.");
    if (state && !state.photos.some((photo) => photo.id === row.photo_id && photo.teamId === row.team_id && photo.seasonId === row.season_id && photo.uploaderAccountId === row.owner_id && photo.revisions.some((revision) => revision.version === row.display_revision))) fail("MEDIA_LINK_CONFLICT", 409, "The matching community revision was not committed.");
    this.database.prepare("UPDATE media_uploads SET status='linked' WHERE id=?").run(uploadId);
  }
  gateway(state, actor, photoId, variant, mode = "gallery", revision) {
    if (!["display", "thumbnail"].includes(variant)) fail("NOT_FOUND", 404, "The media variant is unavailable.");
    const decision = authorizeCommunityMedia(state, actor, photoId, this.now(), mode, revision);
    if (!decision.allowed) fail("NOT_FOUND", 404, "The requested image is unavailable.");
    const row = this.database.prepare("SELECT * FROM media_uploads WHERE photo_id=? AND display_revision=? AND status='linked'").get(photoId, decision.revision.version);
    if (!row || row.team_id !== actor.teamId || row.season_id !== actor.seasonId) fail("NOT_FOUND", 404, "The requested image is unavailable.");
    const key = variant === "display" ? row.display_key : row.thumbnail_key;
    if (!key) fail("NOT_FOUND", 404, "The requested image is unavailable.");
    let body;
    try {
      body = readFileSync(this.path(key));
    } catch {
      fail("NOT_FOUND", 404, "The requested image is unavailable.");
    }
    return { body, headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Length": String(body.length) } };
  }
  listOwn(state, actor) {
    auth(state, actor, this.now(), true);
    const rows = this.database.prepare("SELECT id,photo_id,status,expected_bytes,display_revision,width,height,failure_code,expires_at FROM media_uploads WHERE owner_id=? AND team_id=? AND season_id=? ORDER BY created_at DESC LIMIT 100").all(actor.accountId, actor.teamId, actor.seasonId);
    return rows.map((row) => ({
      uploadId: row.id,
      photoId: row.photo_id,
      status: row.status,
      byteSize: row.expected_bytes,
      displayRevision: row.display_revision,
      width: row.width,
      height: row.height,
      failureCode: row.failure_code,
      expiresAtMs: row.expires_at
    }));
  }
};

// apps/api/src/activation.ts
import { createHash as createHash3, randomBytes as randomBytes3, randomUUID as randomUUID3 } from "node:crypto";
var hash2 = (value) => createHash3("sha256").update(value).digest("hex");
var id2 = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(value);
var uuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function unavailable() {
  throw new AccessError(
    "ACTIVATION_UNAVAILABLE",
    410,
    "This activation cannot be used. Request a new activation through the agreed household process."
  );
}
function invalid() {
  throw new AccessError(
    "INVALID_REQUEST",
    400,
    "Use the documented activation request fields."
  );
}
function conflict() {
  throw new AccessError(
    "REQUEST_CONFLICT",
    409,
    "The request identifier was already used for another operation."
  );
}
function fields(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !names.includes(key)) || names.some((key) => !(key in value)))
    invalid();
}
function fingerprint(actor, input) {
  return hash2(
    JSON.stringify([
      actor,
      ...Object.entries(input).sort(
        ([left], [right]) => left.localeCompare(right)
      )
    ])
  );
}
function username() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return `LB${Array.from(randomBytes3(12), (byte) => alphabet[byte & 31]).join("")}`;
}
var DevelopmentActivationService = class {
  configured;
  store;
  provider;
  policy;
  constructor(options) {
    this.store = options.store;
    this.provider = options.provider;
    this.policy = options.policy;
    if (options.policy && (options.policy.fictionalOnly !== true || !id2(options.policy.version) || !Number.isSafeInteger(options.policy.activationTtlMs) || options.policy.activationTtlMs <= 0))
      throw new Error(
        "An explicit versioned fictional activation policy and positive expiry are required."
      );
    if (options.provider) {
      const issuer2 = new URL(options.provider.issuer);
      if (issuer2.protocol !== "https:" || issuer2.username || issuer2.password || issuer2.search || issuer2.hash || !options.provider.credentialSetupOrigins.length)
        throw new Error(
          "Activation requires a configured HTTPS provider and credential origins."
        );
      for (const origin of options.provider.credentialSetupOrigins) {
        const parsed = new URL(origin);
        if (parsed.protocol !== "https:" || parsed.origin !== origin)
          throw new Error(
            "Credential setup origins must be exact HTTPS origins."
          );
      }
    }
    this.configured = Boolean(options.provider && options.policy);
    this.migrate();
  }
  enabled() {
    if (!this.provider || !this.policy)
      throw new AccessError(
        "ACTIVATION_NOT_CONFIGURED",
        503,
        "Activation requires an explicitly configured provider flow and expiry policy."
      );
    return { provider: this.provider, policy: this.policy };
  }
  migrate() {
    this.store.transaction(() => {
      this.store.database.exec(
        "CREATE TABLE IF NOT EXISTS lb_activation_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL)"
      );
      const version = this.store.database.prepare("SELECT version FROM lb_activation_schema WHERE singleton=1").get();
      if (version && version.version !== 1)
        throw new Error(
          "Unsupported activation feature schema; preserve the database."
        );
      if (version) return;
      this.store.database.exec(`
        CREATE TABLE lb_activation_children(
          account_id TEXT PRIMARY KEY REFERENCES accounts(id),username TEXT NOT NULL COLLATE NOCASE UNIQUE,
          team_id TEXT NOT NULL REFERENCES teams(id),season_id TEXT NOT NULL,player_id TEXT NOT NULL,
          request_id TEXT NOT NULL UNIQUE,request_signature TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('provisioning','pending_activation','active')),
          provider_issuer TEXT,provider_subject TEXT,activation_generation INTEGER NOT NULL DEFAULT 0,
          created_by TEXT NOT NULL REFERENCES accounts(id),created_at INTEGER NOT NULL,
          UNIQUE(team_id,season_id,player_id),UNIQUE(provider_issuer,provider_subject));
        CREATE TABLE lb_activation_issues(request_id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES lb_activation_children(account_id),signature TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('preparing','issued')),created_at INTEGER NOT NULL);
        CREATE TABLE lb_activation_tokens(
          id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES lb_activation_children(account_id),token_hash TEXT NOT NULL UNIQUE,
          issue_request_id TEXT NOT NULL UNIQUE REFERENCES lb_activation_issues(request_id),issued_by TEXT NOT NULL REFERENCES accounts(id),
          expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,policy_version TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('issued','redeeming','completed','revoked')),
          redemption_id TEXT,flow_id TEXT,flow_expires_at INTEGER,cancelled_at INTEGER,completed_at INTEGER);
        CREATE INDEX lb_activation_account_tokens ON lb_activation_tokens(account_id,state);
        CREATE TABLE lb_activation_verification_requests(
          request_id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('link','recovery')),actor_id TEXT NOT NULL REFERENCES accounts(id),
          team_id TEXT NOT NULL REFERENCES teams(id),season_id TEXT NOT NULL,player_id TEXT,target_account_id TEXT NOT NULL,
          signature TEXT NOT NULL,status TEXT NOT NULL CHECK(status='pending_independent_verification'),policy_version TEXT NOT NULL,created_at INTEGER NOT NULL);
        CREATE TRIGGER lb_activation_immutable_child BEFORE UPDATE OF classification ON accounts
          WHEN NEW.classification != 'child_shared' AND EXISTS(SELECT 1 FROM lb_activation_children WHERE account_id=OLD.id)
          BEGIN SELECT RAISE(ABORT,'Child account classification is immutable'); END;
        INSERT INTO lb_activation_schema VALUES(1,1);
      `);
    });
  }
  manager(principal, teamId, seasonId) {
    const fresh = this.store.principal({
      issuer: principal.issuer,
      subject: principal.subject,
      strongAuth: principal.strongAuth,
      authenticatedAt: principal.authenticatedAt
    });
    if (fresh.accountId !== principal.accountId)
      throw new AccessError(
        "NOT_FOUND",
        404,
        "The requested object is unavailable."
      );
    assertCanManageTeam(
      fresh,
      this.store.memberships(),
      teamId,
      seasonId,
      this.store.now()
    );
  }
  child(principal, accountId, teamId, seasonId) {
    this.manager(principal, teamId, seasonId);
    const row = this.store.database.prepare(
      "SELECT * FROM lb_activation_children WHERE account_id=? AND team_id=? AND season_id=?"
    ).get(accountId, teamId, seasonId);
    if (!row)
      throw new AccessError(
        "NOT_FOUND",
        404,
        "The requested object is unavailable."
      );
    return row;
  }
  receipt(child) {
    return {
      accountId: child.account_id,
      username: child.username,
      classification: "child_shared",
      status: child.state === "active" ? "active" : "pending_activation",
      signInEnabled: child.state === "active"
    };
  }
  async providerCall(work) {
    try {
      return await work();
    } catch {
      throw new AccessError(
        "PROVIDER_FLOW_UNAVAILABLE",
        503,
        "The identity operation is incomplete. Retry the same request; pending evidence has been retained."
      );
    }
  }
  async createPendingChild(principal, input) {
    const { provider } = this.enabled();
    fields(input, ["requestId", "teamId", "seasonId", "playerId"]);
    if (![input.requestId, input.teamId, input.seasonId, input.playerId].every(id2))
      invalid();
    const signature2 = fingerprint(principal.accountId, input);
    const row = this.store.transaction(() => {
      this.manager(principal, input.teamId, input.seasonId);
      const existing = this.store.database.prepare("SELECT * FROM lb_activation_children WHERE request_id=?").get(input.requestId);
      if (existing) {
        if (existing.request_signature !== signature2) conflict();
        return existing;
      }
      const profile = this.store.preparation(principal, input.teamId, input.seasonId).profiles.find(
        (item) => item.playerId === input.playerId && item.seasonId === input.seasonId && item.active
      );
      if (!profile)
        throw new AccessError(
          "NOT_FOUND",
          404,
          "The requested object is unavailable."
        );
      if (this.store.memberships().some(
        (item) => item.teamId === input.teamId && item.seasonId === input.seasonId && item.playerId === input.playerId && item.role === "player" && item.revokedAt == null
      ))
        throw new AccessError(
          "PLAYER_ACCOUNT_EXISTS",
          409,
          "This player already has an account assignment. Use the verified exact-account linking process."
        );
      const accountId = randomUUID3();
      let chosen = username();
      for (let tries = 0; this.store.database.prepare(
        "SELECT 1 FROM lb_activation_children WHERE username=? COLLATE NOCASE"
      ).get(chosen); tries++) {
        if (tries >= 10)
          throw new AccessError(
            "IDENTITY_ALLOCATION_UNAVAILABLE",
            503,
            "A unique username could not be allocated."
          );
        chosen = username();
      }
      this.store.database.prepare(
        "INSERT INTO accounts(id,issuer,subject,classification,adult_verified,strong_auth_enrolled,status) VALUES(?,?,?,?,0,0,?)"
      ).run(
        accountId,
        "urn:longball:pending-activation",
        accountId,
        "child_shared",
        "disabled"
      );
      this.store.database.prepare(
        "INSERT INTO lb_activation_children(account_id,username,team_id,season_id,player_id,request_id,request_signature,state,created_by,created_at) VALUES(?,?,?,?,?,?,?,'provisioning',?,?)"
      ).run(
        accountId,
        chosen,
        input.teamId,
        input.seasonId,
        input.playerId,
        input.requestId,
        signature2,
        principal.accountId,
        this.store.now()
      );
      this.store.database.prepare(
        "INSERT INTO memberships(account_id,team_id,season_id,role,player_id) VALUES(?,?,?,'player',?)"
      ).run(accountId, input.teamId, input.seasonId, input.playerId);
      this.store.audit(
        principal,
        "identity.child_reserved",
        accountId,
        "pending_provider"
      );
      return this.child(principal, accountId, input.teamId, input.seasonId);
    });
    if (row.state !== "provisioning") return this.receipt(row);
    const result = await this.providerCall(
      () => provider.provisionPending({
        operationId: `pending:${row.account_id}`,
        accountId: row.account_id,
        username: row.username,
        classification: "child_shared",
        emailRequired: false
      })
    );
    if (result.issuer !== provider.issuer || typeof result.subject !== "string" || !result.subject || result.subject.length > 255 || typeof result.username !== "string" || result.username.toUpperCase() !== row.username.toUpperCase() || result.pending !== true || result.credentialConfigured !== false)
      throw new AccessError(
        "PROVIDER_BINDING_REJECTED",
        502,
        "The pending provider identity could not be safely bound."
      );
    return this.store.transaction(() => {
      const fresh = this.child(
        principal,
        row.account_id,
        input.teamId,
        input.seasonId
      );
      if (fresh.state !== "provisioning") {
        if (fresh.provider_issuer !== result.issuer || fresh.provider_subject !== result.subject)
          throw new AccessError(
            "PROVIDER_BINDING_REJECTED",
            409,
            "The provider identity requires reconciliation."
          );
        return this.receipt(fresh);
      }
      const binding = this.store.database.prepare(
        "SELECT id FROM accounts WHERE issuer=? AND subject=? AND id!=?"
      ).get(result.issuer, result.subject, row.account_id);
      if (binding)
        throw new AccessError(
          "PROVIDER_BINDING_REJECTED",
          409,
          "The provider identity requires reconciliation."
        );
      this.store.database.prepare(
        "UPDATE accounts SET issuer=?,subject=? WHERE id=? AND status='disabled'"
      ).run(result.issuer, result.subject, row.account_id);
      this.store.database.prepare(
        "UPDATE lb_activation_children SET provider_issuer=?,provider_subject=?,state='pending_activation' WHERE account_id=?"
      ).run(result.issuer, result.subject, row.account_id);
      this.store.audit(
        principal,
        "identity.child_provisioned",
        row.account_id,
        "pending_activation"
      );
      return this.receipt(
        this.child(principal, row.account_id, input.teamId, input.seasonId)
      );
    });
  }
  async issueActivation(principal, input) {
    const { provider, policy } = this.enabled();
    fields(input, ["requestId", "teamId", "seasonId", "accountId"]);
    if (![input.requestId, input.teamId, input.seasonId].every(id2) || !uuid(input.accountId))
      invalid();
    const signature2 = fingerprint(principal.accountId, input);
    const preparation = this.store.transaction(() => {
      const child = this.child(
        principal,
        input.accountId,
        input.teamId,
        input.seasonId
      );
      if (child.state !== "pending_activation")
        throw new AccessError(
          "ACTIVATION_NOT_PENDING",
          409,
          "This account is not awaiting activation."
        );
      let issue = this.store.database.prepare("SELECT * FROM lb_activation_issues WHERE request_id=?").get(input.requestId);
      if (issue && issue.signature !== signature2) conflict();
      if (issue?.state === "issued")
        throw new AccessError(
          "ACTIVATION_ALREADY_ISSUED",
          409,
          "The secret was issued once and cannot be retrieved. Explicitly reissue using a new request identifier."
        );
      if (!issue) {
        const generation = child.activation_generation + 1;
        this.store.database.prepare(
          "UPDATE lb_activation_children SET activation_generation=? WHERE account_id=?"
        ).run(generation, child.account_id);
        this.store.database.prepare(
          "INSERT INTO lb_activation_issues VALUES(?,?,?,?,'preparing',?)"
        ).run(
          input.requestId,
          child.account_id,
          signature2,
          generation,
          this.store.now()
        );
        this.store.database.prepare(
          "UPDATE lb_activation_tokens SET state='revoked' WHERE account_id=? AND state IN ('issued','redeeming')"
        ).run(child.account_id);
        issue = {
          request_id: input.requestId,
          signature: signature2,
          generation,
          state: "preparing"
        };
      }
      const obsolete = this.store.database.prepare(
        "SELECT * FROM lb_activation_tokens WHERE account_id=? AND state='revoked' AND redemption_id IS NOT NULL AND cancelled_at IS NULL"
      ).all(child.account_id);
      return { child, issue, obsolete };
    });
    for (const old of preparation.obsolete) {
      await this.providerCall(
        () => provider.cancelCredentialSetup({
          operationId: `activation:${old.id}`,
          issuer: preparation.child.provider_issuer,
          subject: preparation.child.provider_subject
        })
      );
      this.store.transaction(
        () => this.store.database.prepare(
          "UPDATE lb_activation_tokens SET cancelled_at=? WHERE id=? AND state='revoked'"
        ).run(this.store.now(), old.id)
      );
    }
    return this.store.transaction(() => {
      const child = this.child(
        principal,
        input.accountId,
        input.teamId,
        input.seasonId
      );
      const issue = this.store.database.prepare("SELECT * FROM lb_activation_issues WHERE request_id=?").get(input.requestId);
      if (issue.state === "issued")
        throw new AccessError(
          "ACTIVATION_ALREADY_ISSUED",
          409,
          "The secret was issued once. Explicitly reissue if its response was lost."
        );
      if (child.state !== "pending_activation" || child.activation_generation !== issue.generation)
        throw new AccessError(
          "ACTIVATION_SUPERSEDED",
          409,
          "Another activation request superseded this operation."
        );
      const token = randomBytes3(32).toString("base64url");
      const activationId = randomUUID3();
      const expiresAt = this.store.now() + policy.activationTtlMs;
      if (!Number.isSafeInteger(expiresAt))
        throw new AccessError(
          "ACTIVATION_POLICY_INVALID",
          503,
          "The configured expiry is outside the supported range."
        );
      this.store.database.prepare(
        "INSERT INTO lb_activation_tokens(id,account_id,token_hash,issue_request_id,issued_by,expires_at,created_at,policy_version,state) VALUES(?,?,?,?,?,?,?,?,'issued')"
      ).run(
        activationId,
        child.account_id,
        hash2(token),
        input.requestId,
        principal.accountId,
        expiresAt,
        this.store.now(),
        policy.version
      );
      this.store.database.prepare(
        "UPDATE lb_activation_issues SET state='issued' WHERE request_id=?"
      ).run(input.requestId);
      this.store.audit(
        principal,
        "identity.activation_issued",
        activationId,
        "verified_household_delivery_required"
      );
      return {
        activationId,
        token,
        expiresAt,
        policyVersion: policy.version,
        delivery: "verified_household_process_required"
      };
    });
  }
  async redeemActivation(input) {
    const { provider } = this.enabled();
    fields(input, ["token", "requestId"]);
    if (typeof input.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.token) || !id2(input.requestId))
      unavailable();
    const reserved = this.store.transaction(() => {
      const token = this.store.database.prepare("SELECT * FROM lb_activation_tokens WHERE token_hash=?").get(hash2(input.token));
      if (!token || token.expires_at <= this.store.now() || token.state === "revoked" || token.state === "completed" || token.state === "redeeming" && token.redemption_id !== input.requestId)
        unavailable();
      const child = this.store.database.prepare("SELECT * FROM lb_activation_children WHERE account_id=?").get(token.account_id);
      if (child.state !== "pending_activation" || !child.provider_issuer || !child.provider_subject)
        unavailable();
      this.store.database.prepare(
        "UPDATE lb_activation_tokens SET state='redeeming',redemption_id=? WHERE id=?"
      ).run(input.requestId, token.id);
      return { token, child };
    });
    const result = await this.providerCall(
      () => provider.beginCredentialSetup({
        operationId: `activation:${reserved.token.id}`,
        accountId: reserved.child.account_id,
        issuer: reserved.child.provider_issuer,
        subject: reserved.child.provider_subject,
        username: reserved.child.username,
        expiresAt: reserved.token.expires_at
      })
    );
    let setup;
    try {
      setup = new URL(result.setupUrl);
    } catch {
      throw new AccessError(
        "PROVIDER_FLOW_REJECTED",
        502,
        "The provider credential flow could not be safely opened."
      );
    }
    if (setup.protocol !== "https:" || setup.username || setup.password || !provider.credentialSetupOrigins.includes(setup.origin) || result.setupUrl.includes(input.token) || !id2(result.flowId) || !Number.isSafeInteger(result.expiresAt) || result.expiresAt > reserved.token.expires_at || result.expiresAt <= this.store.now())
      throw new AccessError(
        "PROVIDER_FLOW_REJECTED",
        502,
        "The provider credential flow could not be safely opened."
      );
    return this.store.transaction(() => {
      const fresh = this.store.database.prepare("SELECT * FROM lb_activation_tokens WHERE id=?").get(reserved.token.id);
      if (fresh.state !== "redeeming" || fresh.redemption_id !== input.requestId || fresh.expires_at <= this.store.now() || fresh.flow_id && fresh.flow_id !== result.flowId)
        unavailable();
      this.store.database.prepare(
        "UPDATE lb_activation_tokens SET flow_id=?,flow_expires_at=? WHERE id=?"
      ).run(result.flowId, result.expiresAt, fresh.id);
      return {
        activationId: fresh.id,
        providerSetupUrl: setup.href,
        expiresAt: result.expiresAt,
        status: "provider_credential_setup_required"
      };
    });
  }
  async completeActivation(input) {
    const { provider } = this.enabled();
    fields(input, ["activationId", "completionProof"]);
    if (!uuid(input.activationId) || typeof input.completionProof !== "string" || !input.completionProof || input.completionProof.length > 16384)
      unavailable();
    const token = this.store.database.prepare("SELECT * FROM lb_activation_tokens WHERE id=?").get(input.activationId);
    if (!token || !["redeeming", "completed"].includes(token.state) || !token.flow_id || !token.flow_expires_at || token.flow_expires_at <= this.store.now())
      unavailable();
    const child = this.store.database.prepare("SELECT * FROM lb_activation_children WHERE account_id=?").get(token.account_id);
    const proof = await this.providerCall(
      () => provider.verifyCredentialSetup({
        operationId: `activation:${token.id}`,
        flowId: token.flow_id,
        issuer: child.provider_issuer,
        subject: child.provider_subject,
        completionProof: input.completionProof
      })
    );
    if (proof.issuer !== child.provider_issuer || proof.subject !== child.provider_subject || proof.flowId !== token.flow_id || proof.credentialConfigured !== true || proof.recoveryMaterialIssued !== true || !Number.isSafeInteger(proof.completedAt) || proof.completedAt < token.created_at || proof.completedAt > this.store.now() + 3e4 || proof.completedAt >= token.flow_expires_at)
      unavailable();
    return this.store.transaction(() => {
      const fresh = this.store.database.prepare("SELECT * FROM lb_activation_tokens WHERE id=?").get(token.id);
      if (!["redeeming", "completed"].includes(fresh.state) || fresh.flow_expires_at <= this.store.now())
        unavailable();
      const account2 = this.store.database.prepare("SELECT classification,status FROM accounts WHERE id=?").get(child.account_id);
      if (account2.classification !== "child_shared") unavailable();
      if (fresh.state === "completed") {
        if (account2.status !== "active") unavailable();
        return { status: "complete", signInRequired: true };
      }
      if (account2.status !== "disabled") unavailable();
      this.store.database.prepare(
        "UPDATE accounts SET status='active' WHERE id=? AND classification='child_shared'"
      ).run(child.account_id);
      this.store.database.prepare(
        "UPDATE lb_activation_children SET state='active' WHERE account_id=?"
      ).run(child.account_id);
      this.store.database.prepare(
        "UPDATE lb_activation_tokens SET state='completed',completed_at=? WHERE id=?"
      ).run(this.store.now(), token.id);
      this.store.database.prepare("INSERT INTO audit VALUES(?,?,?,?,?,?)").run(
        randomUUID3(),
        child.account_id,
        "identity.activation_completed",
        child.account_id,
        "provider_verified_sign_in_required",
        this.store.now()
      );
      return { status: "complete", signInRequired: true };
    });
  }
  requestExistingAccountLink(principal, input) {
    fields(input, [
      "requestId",
      "teamId",
      "seasonId",
      "playerId",
      "existingAccountId"
    ]);
    if (!id2(input.playerId) || !uuid(input.existingAccountId)) invalid();
    return this.verificationRequest(
      principal,
      "link",
      input,
      input.existingAccountId,
      input.playerId
    );
  }
  requestRecovery(principal, input) {
    fields(input, ["requestId", "teamId", "seasonId", "accountId"]);
    if (!uuid(input.accountId)) invalid();
    return this.verificationRequest(
      principal,
      "recovery",
      input,
      input.accountId,
      null
    );
  }
  verificationRequest(principal, kind, input, target, playerId) {
    const { policy } = this.enabled();
    if (![input.requestId, input.teamId, input.seasonId].every(id2)) invalid();
    const signature2 = fingerprint(principal.accountId, { ...input, kind });
    return this.store.transaction(() => {
      this.manager(principal, input.teamId, input.seasonId);
      if (playerId && !this.store.preparation(principal, input.teamId, input.seasonId).profiles.some(
        (item) => item.playerId === playerId && item.seasonId === input.seasonId && item.active
      ))
        throw new AccessError(
          "NOT_FOUND",
          404,
          "The requested object is unavailable."
        );
      const previous = this.store.database.prepare(
        "SELECT signature FROM lb_activation_verification_requests WHERE request_id=?"
      ).get(input.requestId);
      if (previous && previous.signature !== signature2) conflict();
      if (!previous) {
        this.store.database.prepare(
          "INSERT INTO lb_activation_verification_requests VALUES(?,?,?,?,?,?,?,?,?,?,?)"
        ).run(
          input.requestId,
          kind,
          principal.accountId,
          input.teamId,
          input.seasonId,
          playerId,
          target,
          signature2,
          "pending_independent_verification",
          policy.version,
          this.store.now()
        );
        this.store.audit(
          principal,
          `identity.${kind}_requested`,
          input.requestId,
          "pending_independent_verification"
        );
      }
      return {
        requestId: input.requestId,
        status: "pending_independent_verification",
        completed: false
      };
    });
  }
};

// apps/api/src/server.ts
var header = (request, name) => {
  const value = request.headers[name];
  return typeof value === "string" ? value : void 0;
};
var loopback = (address) => address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
function syntheticIdentity(token, now) {
  const aliases = {
    "synthetic-manager-1": "synthetic-account-manager",
    "synthetic-account-manager-1": "synthetic-account-manager",
    "synthetic-manager-2": "synthetic-account-manager-2",
    "synthetic-manager-3": "synthetic-account-manager-3",
    "synthetic-manager-4": "synthetic-account-manager-4",
    "synthetic-manager-5": "synthetic-account-manager-5",
    "synthetic-admin": "synthetic-account-admin",
    "synthetic-spectator": "synthetic-account-spectator",
    "synthetic-other-manager": "synthetic-account-other-manager"
  };
  const accountId = aliases[token] ?? token;
  if (!/^synthetic-account-(?:manager(?:-[2-5])?|admin|player-(?:0[1-9]|1[0-3])|spectator|invitee|other-manager)$/.test(accountId)) throw new AccessError("INVALID_SESSION", 401, "A valid authenticated session is required.");
  return { issuer: "urn:longball:synthetic", subject: accountId, strongAuth: /manager|admin/.test(accountId), authenticatedAt: now };
}
async function readJson(request) {
  if (!header(request, "content-type")?.startsWith("application/json")) throw new AccessError("JSON_REQUIRED", 415, "Use application/json for this command.");
  let length = 0;
  const chunks = [];
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    length += chunk.length;
    if (length > 256 * 1024) throw new AccessError("REQUEST_TOO_LARGE", 413, "The request exceeds the 256 KiB limit.");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new AccessError("INVALID_JSON", 400, "A JSON object is required.");
  }
}
function createApi(options) {
  if ((options.activationProvider || options.activationPolicy) && !options.syntheticAuth) throw new Error("The fictional activation experiment requires isolated synthetic authentication.");
  const now = options.now ?? Date.now;
  const store = new DevelopmentStore(options.databasePath, now);
  if (options.syntheticAuth) store.seedSynthetic();
  const verifyIdentity = options.verifyIdentity ?? (options.oidc ? createOidcVerifier({ ...options.oidc, now }) : null);
  const media = new DevelopmentMediaService({ directory: options.mediaDirectory ?? join2(dirname2(options.databasePath), "media"), database: store.database, scanner: options.mediaScanner, now });
  const activation = new DevelopmentActivationService({ store, provider: options.activationProvider, policy: options.activationPolicy });
  const windows = /* @__PURE__ */ new Map();
  const staticRoot = options.staticDirectory ? realpathSync(options.staticDirectory) : null;
  const configuredConnect = [...options.oidc ? [options.oidc.issuer, options.oidc.jwksUri] : [], ...options.browserConnectOrigins ?? []].map((value) => {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("Additional browser connect origins must use explicitly configured HTTPS.");
    return url.origin;
  });
  const connectPolicy = [...new Set(configuredConnect)].join(" ");
  const response = (reply, status, value, requestId) => {
    reply.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Request-Id": requestId });
    reply.end(JSON.stringify(value));
  };
  const server = createServer(async (request, reply) => {
    const rawRequestId = header(request, "x-request-id");
    const requestId = rawRequestId && /^[a-zA-Z0-9_-]{1,100}$/.test(rawRequestId) ? rawRequestId : randomUUID4();
    try {
      const origin = header(request, "origin");
      if (origin) {
        let sameOrigin = false;
        try {
          const parsed = new URL(origin);
          sameOrigin = staticRoot !== null && ["http:", "https:"].includes(parsed.protocol) && parsed.host === header(request, "host");
        } catch {
        }
        if (!sameOrigin && !(options.allowedOrigins ?? ["http://localhost:8081", "http://localhost:4173", "http://127.0.0.1:4173"]).includes(origin)) throw new AccessError("ORIGIN_DENIED", 403, "This origin is not configured for API access.");
        reply.setHeader("Access-Control-Allow-Origin", origin);
        reply.setHeader("Vary", "Origin");
        reply.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key, X-Controller-Token, X-Media-Upload-Token, X-Longball-Role, X-Api-Contract-Version, If-Match, X-Request-Id");
        reply.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
      }
      if (request.method === "OPTIONS") {
        reply.writeHead(204);
        reply.end();
        return;
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (url.pathname === "/health") {
        response(reply, 200, { status: "ok", service: "longball-development-api", contractVersion: EVENT_CONTRACT_VERSION, syntheticOnly: true }, requestId);
        return;
      }
      if (staticRoot && parts[0] !== "v1" && ["GET", "HEAD"].includes(request.method ?? "")) {
        if (parts.some((part) => part.startsWith(".") || part.includes("/") || part.includes("\\"))) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
        const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".ttf": "font/ttf", ".woff": "font/woff", ".woff2": "font/woff2" };
        const path = join2(staticRoot, ...parts.length ? parts : ["index.html"]);
        let resolved;
        try {
          resolved = realpathSync(path);
        } catch {
          throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
        }
        if (!resolved.startsWith(`${staticRoot}${sep2}`) || !statSync(resolved).isFile() || !contentTypes[extname(resolved)]) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
        reply.writeHead(200, { "Content-Type": contentTypes[extname(resolved)], "Cache-Control": extname(resolved) === ".html" ? "no-store" : "public, max-age=300", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ${connectPolicy}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`, "X-Request-Id": requestId });
        reply.end(request.method === "HEAD" ? void 0 : readFileSync2(resolved));
        return;
      }
      if (options.syntheticAuth && !loopback(request.socket.remoteAddress)) throw new AccessError("SYNTHETIC_LOCAL_ONLY", 403, "Synthetic authentication is restricted to loopback clients.");
      const requireContract = () => {
        if (header(request, "x-api-contract-version") !== EVENT_CONTRACT_VERSION) throw new AccessError("CONTRACT_VERSION_REQUIRED", 409, `Use X-Api-Contract-Version: ${EVENT_CONTRACT_VERSION}.`);
        const key = header(request, "idempotency-key");
        if (!key || !/^[A-Za-z0-9_-]{8,150}$/.test(key)) throw new AccessError("IDEMPOTENCY_KEY_REQUIRED", 400, "Use a stable Idempotency-Key for mutations.");
        return key;
      };
      const activationFields = (value, names) => {
        if (Object.keys(value).some((key) => !names.includes(key)) || names.some((key) => !(key in value))) throw new AccessError("INVALID_REQUEST", 400, "Use the documented activation request fields.");
      };
      if (request.method === "POST" && ["/v1/activation/redeem", "/v1/activation/complete"].includes(url.pathname)) {
        const rateKey = `activation:${request.socket.remoteAddress ?? "unknown"}`;
        const prior = windows.get(rateKey);
        const limit = prior && now() - prior.begins < 6e4 ? prior : { begins: now(), ordinary: 0, mutation: 0 };
        limit.mutation += 1;
        windows.set(rateKey, limit);
        if (limit.mutation > 20) {
          reply.setHeader("Retry-After", "60");
          throw new AccessError("RATE_LIMIT", 429, "Please retry after the current request window.");
        }
        const key = requireContract();
        const input = await readJson(request);
        let result2;
        if (url.pathname === "/v1/activation/redeem") {
          activationFields(input, ["token"]);
          result2 = await activation.redeemActivation({ token: input.token, requestId: key });
        } else {
          activationFields(input, ["activationId", "completionProof"]);
          result2 = await activation.completeActivation({ activationId: input.activationId, completionProof: input.completionProof });
        }
        response(reply, 200, result2, requestId);
        return;
      }
      if (!options.syntheticAuth && !verifyIdentity) throw new AccessError("IDENTITY_NOT_CONFIGURED", 503, "Configure the trusted OIDC issuer, audience and JWKS verifier before accepting requests.");
      const authorization = header(request, "authorization");
      if (!authorization?.startsWith("Bearer ") || authorization.length > 17e3) throw new AccessError("INVALID_SESSION", 401, "A valid authenticated session is required.");
      const token = authorization.slice(7);
      const identity = options.syntheticAuth ? syntheticIdentity(token, now()) : await verifyIdentity(token);
      const principal = store.principal(identity);
      const rate = windows.get(principal.accountId);
      const count = rate && now() - rate.begins < 6e4 ? rate : { begins: now(), ordinary: 0, mutation: 0 };
      count.ordinary += 1;
      if (request.method !== "GET") count.mutation += 1;
      windows.set(principal.accountId, count);
      if (count.ordinary > 120 || count.mutation > 60) {
        reply.setHeader("Retry-After", "60");
        throw new AccessError("RATE_LIMIT", 429, "Please retry after the current request window.");
      }
      const role = header(request, "x-longball-role");
      const controllerToken = header(request, "x-controller-token");
      const seasonId = url.searchParams.get("seasonId") ?? SYNTHETIC_IDS.seasonId;
      const scopedOperation = (operation) => parts[1] === "teams" ? JSON.stringify([operation, parts[2], seasonId, role ?? "default"]) : operation;
      const body = request.method === "POST" ? await readJson(request) : null;
      if (body && parts[1] === "teams" && parts[3] === "community") {
        if (body.command && typeof body.command === "object" && "type" in body.command && body.command.type === "match.registered") throw new AccessError("POLICY_APPROVAL_REQUIRED", 503, "Connected award/sharing context requires accepted match evidence, verified finish-time anchors and independently approved policy.");
        body.command = parseCommunityCommand(body.command);
      }
      const mutate = (operation, work) => {
        requireContract();
        if (parts[1] === "matches" && parts[2]) store.managerMatch(principal, parts[2]);
        if (parts[1] === "teams" && parts[2]) {
          if (parts[3] === "community") store.communityActor(principal, parts[2], seasonId, role, body.command?.type === "invite.accepted");
          else if (parts[3] === "preparation" && parts[4] === "own") assertTeamRole(principal, store.memberships(), parts[2], seasonId, ["player"], now());
          else if (parts[3] === "managers" || parts[3] === "preparation" && body.command?.type === "club.updated") {
            assertTeamRole(principal, store.memberships(), parts[2], seasonId, ["administrator"], now());
            assertAdultAuthority(principal, true, now());
          } else assertCanManageTeam(principal, store.memberships(), parts[2], seasonId, now());
        }
        return store.idempotent(principal, scopedOperation(operation), header(request, "idempotency-key") ?? "", body, work);
      };
      let result;
      if (request.method === "GET" && url.pathname === "/v1/me") result = { accountId: principal.accountId, identityClassification: principal.identityClassification, principal, memberships: store.myMemberships(principal), serverTime: new Date(now()).toISOString(), syntheticOnly: true };
      else if (request.method === "GET" && url.pathname === "/v1/contracts/events") result = events_v1_1_schema_default;
      else if (request.method === "GET" && url.pathname === "/v1/privacy/requests") result = { items: store.privacyRequests(principal) };
      else if (request.method === "POST" && url.pathname === "/v1/privacy/requests") result = mutate(url.pathname, () => store.privacyRequest(principal, body.kind, typeof body.policyVersion === "string" ? body.policyVersion : null));
      else if (request.method === "POST" && ["/v1/accounts/link-requests", "/v1/accounts/recovery-requests"].includes(url.pathname)) {
        const key = requireContract();
        if (url.pathname === "/v1/accounts/link-requests") {
          activationFields(body, ["teamId", "seasonId", "playerId", "existingAccountId"]);
          result = activation.requestExistingAccountLink(principal, { ...body, requestId: key });
        } else {
          activationFields(body, ["teamId", "seasonId", "accountId"]);
          result = activation.requestRecovery(principal, { ...body, requestId: key });
        }
      } else if (parts[0] === "v1" && parts[1] === "matches" && parts[2]) {
        const matchId = parts[2];
        if (request.method === "GET" && parts.length === 3) result = store.matchDto(principal, matchId);
        else if (request.method === "GET" && parts[3] === "download") result = store.download(principal, matchId, url.searchParams.get("deviceId") ?? "");
        else if (request.method === "GET" && parts[3] === "quarantine") result = { items: store.quarantine(principal, matchId) };
        else if (request.method === "POST" && parts[3] === "controller") result = mutate(url.pathname, () => store.acquire(principal, matchId, String(body.deviceId ?? "")));
        else if (request.method === "POST" && parts[3] === "events") result = mutate(url.pathname, () => store.upload(principal, matchId, controllerToken, body.events));
        else if (request.method === "POST" && parts[3] === "handover" && !parts[4]) result = mutate(url.pathname, () => store.offerHandover(principal, matchId, controllerToken, String(body.toAccountId ?? ""), String(body.toDeviceId ?? ""), Number(body.baseRevision)));
        else if (request.method === "POST" && parts[3] === "handover" && parts[4] && parts[5] === "accept") result = mutate(url.pathname, () => store.acceptHandover(principal, matchId, parts[4], String(body.deviceId ?? "")));
        else if (request.method === "POST" && parts[3] === "recover") result = mutate(url.pathname, () => {
          if (body.confirmUnsynchronisedRisk !== true) throw new AccessError("RECOVERY_CONFIRMATION_REQUIRED", 422, "Confirm the possibility of unsynchronised old-device records before recovery.");
          return store.recover(principal, matchId, String(body.deviceId ?? ""), String(body.reason ?? ""));
        });
        else throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
      } else if (parts[0] === "v1" && parts[1] === "teams" && parts[2]) {
        const teamId = parts[2];
        if (request.method === "POST" && parts[3] === "activation" && parts.length === 5 && ["pending-child", "issue"].includes(parts[4])) {
          const requestId2 = requireContract();
          assertCanManageTeam(principal, store.memberships(), teamId, seasonId, now());
          if (parts[4] === "pending-child") {
            activationFields(body, ["playerId"]);
            result = await activation.createPendingChild(principal, { requestId: requestId2, teamId, seasonId, playerId: body.playerId });
          } else {
            activationFields(body, ["accountId"]);
            result = await activation.issueActivation(principal, { requestId: requestId2, teamId, seasonId, accountId: body.accountId });
          }
        } else if (parts[3] === "media") {
          const actor = store.communityActor(principal, teamId, seasonId, role);
          const community = () => store.communityState(teamId, seasonId);
          if (request.method === "GET" && parts[4] === "uploads" && !parts[5]) result = { items: media.listOwn(community(), actor) };
          else if (request.method === "POST" && parts[4] === "uploads" && parts[5] === "prepare") {
            const key = requireContract();
            result = store.transaction(() => media.prepare(community(), actor, { ...body, requestId: key }));
          } else if (request.method === "PUT" && parts[4] === "uploads" && parts[5]) {
            requireContract();
            result = await media.upload(community(), actor, parts[5], header(request, "x-media-upload-token") ?? "", request);
          } else if (request.method === "POST" && parts[4] === "uploads" && parts[5] && parts[6] === "complete") {
            const key = requireContract();
            const processed = await media.complete(community(), actor, parts[5], header(request, "x-media-upload-token") ?? "");
            result = store.idempotent(principal, scopedOperation(url.pathname), key, body, () => {
              const freshActor = store.communityActor(principal, teamId, seasonId, role);
              const next = applyCommunityCommand(community(), freshActor, processed.command, now());
              store.saveDocument(teamId, seasonId, "community", next);
              media.link(parts[5], next);
              store.audit(principal, "media.processed", processed.receipt.photoId, "private_review_required");
              return processed.receipt;
            });
          } else if (request.method === "GET" && parts[4] === "photos" && parts[5] && parts[6]) {
            const mode = url.searchParams.get("mode") ?? "gallery";
            if (!["gallery", "own", "review"].includes(mode) || !["display", "thumbnail"].includes(parts[6])) throw new AccessError("NOT_FOUND", 404, "The requested image is unavailable.");
            const rawRevision = url.searchParams.get("revision");
            const revision = rawRevision === null ? void 0 : Number(rawRevision);
            if (revision !== void 0 && (!Number.isSafeInteger(revision) || revision < 1)) throw new AccessError("NOT_FOUND", 404, "The requested image is unavailable.");
            const image = media.gateway(community(), actor, parts[5], parts[6], mode, revision);
            reply.writeHead(200, { ...image.headers, "X-Request-Id": requestId });
            reply.end(image.body);
            return;
          } else throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
        } else if (request.method === "GET" && parts[3] === "matches") result = { items: store.teamMatches(principal, teamId, seasonId), nextCursor: null, serverTime: new Date(now()).toISOString() };
        else if (request.method === "POST" && parts[3] === "managers") result = mutate(url.pathname, () => store.assignManager(principal, teamId, seasonId, String(body.accountId ?? "")));
        else if (request.method === "GET" && parts[3] === "preparation" && parts[4] === "own") result = store.ownPreparation(principal, teamId, seasonId);
        else if (request.method === "POST" && parts[3] === "preparation" && parts[4] === "own") result = mutate(url.pathname, () => store.ownPreparationCommand(principal, teamId, seasonId, body.command));
        else if (request.method === "GET" && parts[3] === "preparation") result = store.preparation(principal, teamId, seasonId);
        else if (request.method === "POST" && parts[3] === "preparation") result = mutate(url.pathname, () => store.preparationCommand(principal, teamId, seasonId, body.command));
        else if (request.method === "GET" && parts[3] === "community" && parts[4] === "media" && parts[5]) result = store.media(principal, teamId, seasonId, parts[5], url.searchParams.get("mode") ?? "gallery", role);
        else if (request.method === "GET" && parts[3] === "community") result = store.community(principal, teamId, seasonId, role);
        else if (request.method === "POST" && parts[3] === "community") {
          mutate(url.pathname, () => store.communityCommand(principal, teamId, seasonId, body.command, role));
          result = store.community(principal, teamId, seasonId, role);
        } else if (request.method === "GET" && parts[3] === "records") result = store.records(principal, teamId, seasonId, role);
        else if (request.method === "POST" && parts[3] === "records") result = mutate(url.pathname, () => store.recordsCommand(principal, teamId, seasonId, body.command));
        else throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
      } else throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
      const pendingReview = typeof result === "object" && result !== null && "pendingReview" in result && result.pendingReview === true;
      response(reply, pendingReview ? 409 : 200, result, requestId);
    } catch (error) {
      const domainCode = error && typeof error === "object" && "code" in error ? String(error.code) : null;
      const status = error instanceof AccessError ? error.status : domainCode === "forbidden" ? 403 : domainCode === "expired" ? 410 : domainCode === "conflict" || domainCode === "closed" ? 409 : 422;
      const code = error instanceof AccessError ? error.code : domainCode && ["forbidden", "invalid", "conflict", "expired", "closed", "policy_needed"].includes(domainCode) ? domainCode.toUpperCase() : "COMMAND_REJECTED";
      const safeMessage = error instanceof AccessError ? error.message : "The command could not be applied. Check the current saved state and request fields.";
      response(reply, status, { code, message: safeMessage, requestId, retryable: status === 429 || status === 503 }, requestId);
    }
  });
  server.requestTimeout = 65e3;
  server.headersTimeout = 1e4;
  return { server, store, media, activation, close: () => new Promise((resolve2, reject) => server.close((error) => {
    try {
      media.close();
      store.close();
      if (error) reject(error);
      else resolve2();
    } catch (closeError) {
      reject(closeError);
    }
  })) };
}

// apps/api/src/main.ts
var syntheticAuth = process.env.LONGBALL_SYNTHETIC_AUTH === "1";
var host = process.env.LONGBALL_API_HOST ?? "127.0.0.1";
if (syntheticAuth && !["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("Synthetic development authentication may only bind to loopback.");
if (process.env.NODE_ENV === "production" && syntheticAuth) throw new Error("Synthetic authentication is disabled in production.");
var issuer = process.env.LONGBALL_OIDC_ISSUER;
var audience = process.env.LONGBALL_OIDC_AUDIENCE;
var jwksUri = process.env.LONGBALL_OIDC_JWKS_URI;
var api = createApi({
  databasePath: process.env.LONGBALL_API_DATABASE ?? ".local/api/longball.sqlite",
  syntheticAuth,
  oidc: issuer && audience && jwksUri ? { issuer, audience, jwksUri, mfaAcrValues: process.env.LONGBALL_OIDC_MFA_ACR?.split(",").filter(Boolean) } : void 0,
  allowedOrigins: process.env.LONGBALL_API_ORIGINS?.split(",").filter(Boolean),
  staticDirectory: process.env.LONGBALL_STATIC_DIRECTORY,
  browserConnectOrigins: process.env.LONGBALL_OIDC_CONNECT_ORIGINS?.split(",").filter(Boolean),
  mediaDirectory: process.env.LONGBALL_MEDIA_DIRECTORY,
  mediaScanner: process.env.LONGBALL_CLAMSCAN_PATH ? createClamAvScanner(process.env.LONGBALL_CLAMSCAN_PATH) : void 0
});
var port = Number(process.env.LONGBALL_API_PORT ?? 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Configure a valid API port.");
api.server.listen(port, host, () => {
  console.log(`LongBall development API http://${host}:${port} \xB7 ${syntheticAuth ? "isolated fictional authentication" : "OIDC required"} \xB7 SQLite development store`);
});
var closing = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  if (!closing) {
    closing = true;
    void api.close().then(() => process.exit(0));
  }
});
