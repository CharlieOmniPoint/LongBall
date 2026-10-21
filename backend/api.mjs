// apps/api/src/match-pagination.ts
import { createHash } from "node:crypto";
import { Buffer as Buffer2 } from "node:buffer";

// packages/application/src/access.ts
var AccessError = class extends Error {
  constructor(code, status2, message) {
    super(message);
    this.code = code;
    this.status = status2;
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
  const current3 = currentMemberships(input.principal, input.memberships, now);
  const available2 = current3.filter((item) => item.teamId === input.teamId && item.seasonId === input.seasonId && ["manager", "player", "spectator"].includes(item.role));
  const chosen = input.requestedRole ? available2.find((item) => item.role === input.requestedRole) : available2.find((item) => item.role === "manager") ?? available2.find((item) => item.role === "player") ?? available2[0];
  if (!chosen) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
  const role = assertTeamRole(input.principal, input.memberships, input.teamId, input.seasonId, [chosen.role], now);
  if (role.role === "manager") {
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
    ...input.state.config.fixture ? { opponent: input.state.config.fixture.opponent, playedDate: input.state.config.fixture.playedDate, homeAway: input.state.config.fixture.homeAway } : {},
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

// apps/api/src/match-pagination.ts
var invalid = () => {
  throw new AccessError("INVALID_PAGE", 400, "Use the original cursor for this account, team, season and selected role, with a page limit from 1 to 100.");
};
var validId = (value) => typeof value === "string" && value.length >= 1;
function parseMatchPageQuery(params) {
  for (const key of params.keys()) if (!["seasonId", "limit", "cursor"].includes(key) || params.getAll(key).length !== 1) invalid();
  const rawLimit = params.get("limit");
  if (rawLimit !== null && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit)) invalid();
  const cursor = params.get("cursor");
  if (cursor !== null && (!cursor.length || /[^A-Za-z0-9_-]/.test(cursor))) invalid();
  return { limit: rawLimit === null ? 25 : Number(rawLimit), cursor };
}
function matchPageAudience(principal, memberships, teamId, seasonId, requestedRole, nowMs) {
  const available2 = currentMemberships(principal, memberships, nowMs).filter((item) => item.teamId === teamId && item.seasonId === seasonId && ["manager", "player", "spectator"].includes(item.role));
  const chosen = requestedRole ? available2.find((item) => item.role === requestedRole) : available2.find((item) => item.role === "manager") ?? available2.find((item) => item.role === "player") ?? available2[0];
  if (!chosen) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
  if (chosen.role === "manager") assertAdultAuthority(principal, false, nowMs);
  return chosen;
}
var binding = (scope) => createHash("sha256").update(JSON.stringify(["longball.matches.id-asc.v1", scope.principal.accountId, scope.principal.issuer, scope.principal.subject, scope.teamId, scope.seasonId, scope.role, scope.playerId])).digest("base64url");
function matchPageCursor(scope, afterId) {
  if (!validId(afterId)) invalid();
  return Buffer2.from(JSON.stringify({ version: 1, binding: binding(scope), afterId })).toString("base64url");
}
function matchPagePosition(scope, query) {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) invalid();
  if (query.cursor === null) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(query.cursor)) invalid();
    const bytes = Buffer2.from(query.cursor, "base64url");
    if (bytes.toString("base64url") !== query.cursor) invalid();
    const cursor = JSON.parse(bytes.toString("utf8"));
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor) || Object.keys(cursor).sort().join(",") !== "afterId,binding,version" || cursor.version !== 1 || cursor.binding !== binding(scope) || !validId(cursor.afterId)) invalid();
    return cursor.afterId;
  } catch {
    return invalid();
  }
}

// packages/application/src/team-privileges.ts
var object = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
var id = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(value);
var integer = (value) => Number.isSafeInteger(value) && Number(value) >= 0;
var invalid2 = () => {
  throw new AccessError(
    "INVALID_TEAM_PRIVILEGE_COMMAND",
    400,
    "Use an exact confirmed privilege decision, current revision and operational reason code."
  );
};
function parseTeamPrivilegeCommand(value) {
  if (!object(value) || Object.keys(value).some(
    (key) => ![
      "id",
      "type",
      "expectedRevision",
      "targetAccountId",
      "privilege",
      "reasonCode",
      "privateNote",
      "confirm"
    ].includes(key)
  ) || !id(value.id) || !id(value.targetAccountId) || !integer(value.expectedRevision) || !["privilege.suspended", "privilege.reinstated"].includes(
    String(value.type)
  ) || !["uploads", "invitations"].includes(String(value.privilege)) || typeof value.reasonCode !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(value.reasonCode) || value.confirm !== true || !(value.privateNote === void 0 || value.privateNote === null || typeof value.privateNote === "string" && value.privateNote.length <= 1e3 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(
    value.privateNote
  )))
    return invalid2();
  return {
    id: value.id,
    type: value.type,
    expectedRevision: value.expectedRevision,
    targetAccountId: value.targetAccountId,
    privilege: value.privilege,
    reasonCode: value.reasonCode,
    privateNote: typeof value.privateNote === "string" ? value.privateNote.trim() || null : null,
    confirm: true
  };
}
function validateTeamPrivilegeState(value) {
  if (!object(value) || Object.keys(value).some(
    (key) => !["schemaVersion", "teamId", "revision", "restrictions"].includes(key)
  ) || value.schemaVersion !== 1 || !id(value.teamId) || !integer(value.revision) || !Array.isArray(value.restrictions) || value.restrictions.some(
    (row) => !object(row) || Object.keys(row).some(
      (key) => !["accountId", "privilege", "suspended"].includes(key)
    ) || !id(row.accountId) || !["uploads", "invitations"].includes(String(row.privilege)) || typeof row.suspended !== "boolean"
  ) || new Set(
    value.restrictions.map(
      (row) => JSON.stringify([row.accountId, row.privilege])
    )
  ).size !== value.restrictions.length)
    throw new AccessError(
      "TEAM_PRIVILEGES_RECONCILIATION_REQUIRED",
      409,
      "The team privilege record needs authorised reconciliation. Preserve the existing record."
    );
}
function teamPrivilegeAllowed(state, accountId, privilege) {
  validateTeamPrivilegeState(state);
  return !state.restrictions.some(
    (row) => row.accountId === accountId && row.privilege === privilege && row.suspended
  );
}
function applyTeamPrivilegeCommand(state, command) {
  validateTeamPrivilegeState(state);
  const input = parseTeamPrivilegeCommand(command);
  if (input.expectedRevision !== state.revision)
    throw new AccessError(
      "TEAM_PRIVILEGE_REVISION_CONFLICT",
      409,
      "Team privileges changed. Refresh and review before confirming this decision."
    );
  const suspended = input.type === "privilege.suspended";
  if (teamPrivilegeAllowed(state, input.targetAccountId, input.privilege) === !suspended)
    throw new AccessError(
      "TEAM_PRIVILEGE_ALREADY_SET",
      409,
      "This privilege already has the requested status. Refresh the current team decision."
    );
  const restrictions = state.restrictions.filter(
    (row) => row.accountId !== input.targetAccountId || row.privilege !== input.privilege
  );
  restrictions.push({
    accountId: input.targetAccountId,
    privilege: input.privilege,
    suspended
  });
  return {
    schemaVersion: 1,
    teamId: state.teamId,
    revision: state.revision + 1,
    restrictions
  };
}

// apps/api/src/team-privileges-service.ts
var TeamPrivilegeService = class {
  constructor(repository, now = Date.now) {
    this.repository = repository;
    this.now = now;
  }
  repository;
  now;
  async manager(session) {
    const actor = await this.repository.actor(session);
    if (actor.role !== "manager")
      throw new AccessError(
        "NOT_FOUND",
        404,
        "The requested team operation is unavailable."
      );
  }
  async own(session) {
    const actor = await this.repository.actor(session);
    const eligible2 = actor.role === "manager" || actor.role === "player";
    return {
      kind: "own-team-privileges",
      teamId: session.teamId,
      seasonId: session.seasonId,
      uploadsAllowed: eligible2 && await this.repository.own(session, "uploads"),
      invitationsAllowed: eligible2 && await this.repository.own(session, "invitations")
    };
  }
  async assertAllowed(session, privilege, lock = false) {
    const actor = await this.repository.actor(session);
    if (!["manager", "player"].includes(actor.role))
      throw new AccessError(
        "NOT_FOUND",
        404,
        "The requested team operation is unavailable."
      );
    if (!await this.repository.own(session, privilege, lock))
      throw new AccessError(
        privilege === "uploads" ? "TEAM_UPLOADS_SUSPENDED" : "TEAM_INVITATIONS_SUSPENDED",
        403,
        privilege === "uploads" ? "Photo contributions are suspended in this team. Existing private uploads are retained; contact the team manager." : "Creating or reissuing invitations is suspended in this team. Existing grants and invitations retain their separate recorded status."
      );
  }
  async view(session) {
    await this.manager(session);
    const state = await this.repository.state(session), targets = await this.repository.targets(session);
    return {
      kind: "team-privileges",
      teamId: session.teamId,
      seasonId: session.seasonId,
      revision: state.revision,
      own: await this.own(session),
      targets: targets.map((target) => ({
        ...target,
        uploadsSuspended: !teamPrivilegeAllowed(
          state,
          target.accountId,
          "uploads"
        ),
        invitationsSuspended: !teamPrivilegeAllowed(
          state,
          target.accountId,
          "invitations"
        )
      }))
    };
  }
  async command(session, raw) {
    const command = parseTeamPrivilegeCommand(raw);
    return this.repository.transaction(async () => {
      await this.manager(session);
      const state = await this.repository.state(session, true);
      if (!(await this.repository.targets(session)).some(
        (target) => target.accountId === command.targetAccountId
      ))
        throw new AccessError(
          "NOT_FOUND",
          404,
          "The requested team account is unavailable."
        );
      const next = applyTeamPrivilegeCommand(state, command);
      await this.repository.save(session, next, {
        command,
        actorId: session.principal.accountId,
        createdAtMs: this.now()
      });
      return {
        kind: "team-privilege-receipt",
        commandId: command.id,
        teamId: session.teamId,
        revision: next.revision
      };
    });
  }
};

// apps/api/src/team-privileges-repository.ts
var SqliteTeamPrivilegeRepository = class {
  constructor(source2, runtime) {
    this.source = source2;
    this.runtime = runtime;
  }
  source;
  runtime;
  transaction(work) {
    return this.runtime.transaction(work);
  }
  actor(session) {
    return this.runtime.communityActor(
      session.principal,
      session.teamId,
      session.seasonId,
      session.role
    );
  }
  async state(session) {
    const row = this.source.database.prepare(
      "SELECT revision,state_json FROM team_privilege_states WHERE team_id=?"
    ).get(session.teamId);
    if (!row)
      throw new AccessError(
        "TEAM_PRIVILEGES_UNAVAILABLE",
        503,
        "Current team privileges are unavailable."
      );
    const state = JSON.parse(row.state_json);
    validateTeamPrivilegeState(state);
    if (state.teamId !== session.teamId || state.revision !== row.revision)
      throw new AccessError(
        "TEAM_PRIVILEGES_RECONCILIATION_REQUIRED",
        409,
        "Retain the team privilege record for authorised reconciliation."
      );
    return state;
  }
  async targets(session) {
    const rows = this.source.database.prepare(
      "SELECT DISTINCT m.account_id FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.team_id=? AND m.season_id=? AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>?) AND a.status='active' ORDER BY m.account_id"
    ).all(session.teamId, session.seasonId, this.source.now());
    const community = await this.runtime.communityState(
      session.teamId,
      session.seasonId
    );
    return rows.map((row) => ({
      accountId: row.account_id,
      label: community.accounts.find((account3) => account3.id === row.account_id)?.label ?? `Account ${row.account_id}`
    }));
  }
  async own(session, privilege) {
    return teamPrivilegeAllowed(
      await this.state(session),
      session.principal.accountId,
      privilege
    );
  }
  async save(session, state, decision) {
    const changed = this.source.database.prepare(
      "UPDATE team_privilege_states SET revision=?,state_json=? WHERE team_id=? AND revision=?"
    ).run(
      state.revision,
      JSON.stringify(state),
      session.teamId,
      state.revision - 1
    );
    if (changed.changes !== 1)
      throw new AccessError(
        "TEAM_PRIVILEGE_REVISION_CONFLICT",
        409,
        "Team privileges changed. Refresh before confirming."
      );
    const command = decision.command;
    this.source.database.prepare(
      "INSERT INTO team_privilege_decisions(team_id,revision,command_id,actor_id,target_account_id,privilege,suspended,reason_code,private_note,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)"
    ).run(
      session.teamId,
      state.revision,
      command.id,
      decision.actorId,
      command.targetAccountId,
      command.privilege,
      Number(command.type === "privilege.suspended"),
      command.reasonCode,
      command.privateNote,
      decision.createdAtMs
    );
    await this.runtime.audit(
      session.principal,
      command.type,
      session.teamId,
      "team_scoped_privilege_accepted"
    );
  }
};

// apps/api/src/server.ts
import { createServer } from "node:http";
import { randomUUID as randomUUID7 } from "node:crypto";
import { readFileSync as readFileSync3, realpathSync, statSync } from "node:fs";
import { dirname as dirname2, extname, join as join3, sep as sep3 } from "node:path";

// packages/application/src/invitation-credentials.ts
var INVITATION_CREDENTIAL_DOMAIN = "longball.spectator-invitation.v1\0";
function isCanonicalInvitationToken(token) {
  return typeof token === "string" && token.length === 43 && !/[^A-Za-z0-9_-]/.test(token) && "AEIMQUYcgkosw048".includes(token[42]);
}
function invitationTokenHashInput(token) {
  if (!isCanonicalInvitationToken(token))
    throw new Error("The invitation credential is unavailable.");
  return INVITATION_CREDENTIAL_DOMAIN + token;
}
function isInvitationTokenHash(hash6) {
  return typeof hash6 === "string" && hash6.length === 64 && !/[^a-f0-9]/.test(hash6);
}
var validTime = (value) => Number.isSafeInteger(value) && value >= 0;
function sameHash(left, right) {
  let difference = 0;
  for (let index = 0; index < 64; index += 1)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
function pendingInvitation(state, tokenHash, nowMs, scope) {
  if (!isInvitationTokenHash(tokenHash) || !validTime(nowMs)) return null;
  const matches = state.invitations.filter(
    (invite2) => invite2.credential?.kind === "sha256" && invite2.credential.version === 1 && isInvitationTokenHash(invite2.credential.tokenHash) && sameHash(invite2.credential.tokenHash, tokenHash)
  );
  if (matches.length !== 1) return null;
  const invite = matches[0];
  if (scope && (invite.teamId !== scope.teamId || invite.seasonId !== scope.seasonId))
    return null;
  if (invite.acceptedBy !== null || invite.acceptedAtMs !== null || invite.revokedAtMs !== null || !validTime(invite.createdAtMs) || invite.createdAtMs > nowMs || !validTime(invite.expiresAtMs) || invite.expiresAtMs <= nowMs)
    return null;
  const seasons = state.seasons.filter(
    (season) => season.id === invite.seasonId && season.teamId === invite.teamId
  );
  if (seasons.length !== 1 || !validTime(seasons[0].accessEndsAtMs) || seasons[0].accessEndsAtMs <= nowMs || invite.expiresAtMs > seasons[0].accessEndsAtMs)
    return null;
  return invite;
}
function publicInvitation(invite, nowMs) {
  if (!validTime(nowMs))
    throw new Error("A valid invitation observation is required.");
  const legacy = !invite.credential || invite.credential.kind === "legacy_retired";
  const state = invite.revokedAtMs !== null ? "revoked" : invite.acceptedBy !== null ? "accepted" : legacy ? "requires_reissue" : invite.expiresAtMs <= nowMs ? "expired" : "pending";
  return {
    id: invite.id,
    teamId: invite.teamId,
    seasonId: invite.seasonId,
    inviterAccountId: invite.inviterAccountId,
    createdAtMs: invite.createdAtMs,
    expiresAtMs: invite.expiresAtMs,
    acceptedBy: invite.acceptedBy,
    acceptedAtMs: invite.acceptedAtMs,
    revokedAtMs: invite.revokedAtMs,
    reissuedFromInvitationId: invite.reissuedFromInvitationId ?? null,
    state,
    requiresReissue: !invite.credential ? invite.acceptedBy === null && invite.revokedAtMs === null : invite.credential.kind === "legacy_retired" && invite.credential.requiresReissue
  };
}
function redactInviteCreated(receipt) {
  return {
    id: receipt.id,
    expiresAt: receipt.expiresAt,
    teamId: receipt.teamId,
    seasonId: receipt.seasonId,
    credentialAvailable: false,
    requiresReissue: true
  };
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
function validTime2(value) {
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
function scopedMatch(state, actor, id9) {
  const match = state.matches.find((item) => item.id === id9);
  requireRule(match && match.teamId === actor.teamId && match.seasonId === actor.seasonId, "forbidden", "That match is outside this team and season.");
  return match;
}
function scopedPhoto(state, actor, id9) {
  const photo = state.photos.find((item) => item.id === id9);
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
  const winners = [...counts].filter(([, count]) => count === highest).map(([id9]) => id9).sort();
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
  requireRule(validTime2(nowMs), "invalid", "A valid receipt time is required.");
  account(state, actor);
  requireRule(command.id.trim(), "invalid", "A command identity is required.");
  const fingerprint3 = JSON.stringify([actor, command]);
  const prior = state.appliedCommands[command.id];
  if (prior !== void 0) {
    requireRule(prior === fingerprint3, "conflict", "This command identity was already used for different content.");
    return state;
  }
  requireRule(command.expectedRevision === void 0 || command.expectedRevision === state.revision, "conflict", "Community records changed. Reload the saved record before retrying.");
  const next = JSON.parse(JSON.stringify(state));
  const personal = ["preferences.changed", "privacy.drafted", "privacy.cancelled"].includes(command.type) || command.type === "uploader.hidden" && !command.hidden;
  if (!personal && command.type !== "invite.accepted") assertAccess(next, actor, nowMs);
  switch (command.type) {
    case "invite.created": {
      requireRule(next.synthetic === true, "forbidden", "Review codes are available only in the fictional local journey.");
      requireRule(actor.role !== "spectator", "forbidden", "Spectators cannot invite other spectators.");
      const season = next.seasons.find((item) => item.id === actor.seasonId && item.teamId === actor.teamId);
      requireRule(season, "invalid", "The team season is missing.");
      requireRule(validTime2(command.expiresAtMs) && nowMs < command.expiresAtMs && command.expiresAtMs <= season.accessEndsAtMs, "invalid", "Choose an invitation expiry after now and before the season ends.");
      requireRule(command.reviewCode.trim().length >= 6 && !next.invitations.some((item) => item.reviewCode === command.reviewCode || item.id === command.invitationId), "invalid", "The fictional invitation identity/code must be unique.");
      next.invitations.push({
        id: command.invitationId,
        teamId: actor.teamId,
        seasonId: actor.seasonId,
        inviterAccountId: actor.accountId,
        reviewCode: command.reviewCode,
        credential: { kind: "fictional_review", version: 1, code: command.reviewCode },
        createdAtMs: nowMs,
        expiresAtMs: command.expiresAtMs,
        acceptedBy: null,
        acceptedAtMs: null,
        revokedAtMs: null,
        reissuedFromInvitationId: null
      });
      break;
    }
    case "invite.accepted": {
      requireRule(next.synthetic === true, "forbidden", "Review codes are available only in the fictional local journey.");
      const invite = next.invitations.find((item) => item.credential?.kind === "fictional_review" && item.credential.code === command.reviewCode && item.reviewCode === command.reviewCode);
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
      requireRule(validTime2(match.playedAtMs) && unique(match.selectedPlayerIds) && unique(match.presentPlayerIds) && unique(match.playedPlayerIds), "invalid", "The match evidence is invalid.");
      requireRule(match.presentPlayerIds.every((id9) => match.selectedPlayerIds.includes(id9)) && match.playedPlayerIds.every((id9) => match.presentPlayerIds.includes(id9)), "invalid", "Played and present evidence must belong to the selected squad.");
      requireRule(match.selectedPlayerIds.every((id9) => next.memberships.some((member) => member.playerId === id9 && member.teamId === actor.teamId && member.seasonId === actor.seasonId)), "invalid", "Every selected player needs a membership in this team and season.");
      requireRule(match.actualFullTimeAtMs === null || validTime2(match.actualFullTimeAtMs) && match.actualFullTimeAtMs <= nowMs, "invalid", "Actual full time cannot be in the future.");
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
      const time3 = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
      requireRule(preferences.quietStart === null && preferences.quietEnd === null || typeof preferences.quietStart === "string" && typeof preferences.quietEnd === "string" && time3.test(preferences.quietStart) && time3.test(preferences.quietEnd), "invalid", "Use HH:MM for both quiet-hour boundaries, or leave both empty.");
      requireRule(preferences.quietStart === null || preferences.quietStart !== preferences.quietEnd, "invalid", "Quiet hours need distinct boundaries; use channel switches to pause all day.");
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
  next.appliedCommands[command.id] = fingerprint3;
  next.audit.push({ id: command.id, actorAccountId: actor.accountId, action: command.type, atMs: nowMs, origin: "account" });
  return next;
}
function validInvitationIdentity(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 200 && !/[^A-Za-z0-9_.:-]/.test(value);
}
function applyVerifiedInvitationCommand(state, actor, command, nowMs) {
  requireRule(
    validTime2(nowMs),
    "invalid",
    "A valid invitation receipt time is required."
  );
  account(state, actor);
  const fields8 = {
    "invite.issued": ["invitationId", "tokenHash", "expiresAtMs"],
    "invite.reissued": [
      "sourceInvitationId",
      "invitationId",
      "tokenHash",
      "expiresAtMs"
    ],
    "invite.accepted_verified": ["invitationId", "tokenHash"]
  };
  requireRule(
    command && Object.hasOwn(fields8, command.type),
    "invalid",
    "The internal invitation operation is unavailable."
  );
  requireRule(
    Object.keys(command).every(
      (key) => ["id", "type", "expectedRevision", ...fields8[command.type]].includes(key)
    ) && Object.keys(actor).every(
      (key) => ["role", "accountId", "teamId", "seasonId", "playerId"].includes(key)
    ),
    "invalid",
    "Unexpected invitation data is not retained."
  );
  requireRule(
    validInvitationIdentity(command.id) && validInvitationIdentity(command.invitationId) && isInvitationTokenHash(command.tokenHash) && (command.expectedRevision === void 0 || validTime2(command.expectedRevision)),
    "invalid",
    "The invitation identity and verifier must be canonical."
  );
  const fingerprint3 = JSON.stringify([actor, command]);
  const prior = state.appliedCommands[command.id];
  if (prior !== void 0) {
    requireRule(
      prior === fingerprint3,
      "conflict",
      "This command identity was already used for different content."
    );
    return state;
  }
  requireRule(
    command.expectedRevision === void 0 || command.expectedRevision === state.revision,
    "conflict",
    "Community records changed. Reload before retrying."
  );
  const next = JSON.parse(JSON.stringify(state));
  if (command.type === "invite.accepted_verified") {
    const invite = pendingInvitation(next, command.tokenHash, nowMs, actor);
    requireRule(
      invite && invite.id === command.invitationId,
      "forbidden",
      "The invitation is unavailable for this team and season."
    );
    const saved = next.invitations.find((item) => item.id === invite.id);
    const season = next.seasons.find(
      (item) => item.id === invite.seasonId && item.teamId === invite.teamId
    );
    saved.acceptedBy = actor.accountId;
    saved.acceptedAtMs = nowMs;
    requireRule(
      !next.grants.some(
        (grant) => grant.id === `grant:${invite.id}` || grant.invitationId === invite.id
      ),
      "conflict",
      "This invitation already has a retained grant."
    );
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
  } else {
    assertAccess(next, actor, nowMs);
    requireRule(
      actor.role === "manager" || actor.role === "player",
      "forbidden",
      "Only a current player or manager can issue invitations."
    );
    const season = next.seasons.find(
      (item) => item.id === actor.seasonId && item.teamId === actor.teamId
    );
    requireRule(
      season && nowMs < season.accessEndsAtMs,
      "expired",
      "The invited season has ended. Renewal is explicit."
    );
    requireRule(
      validTime2(command.expiresAtMs) && nowMs < command.expiresAtMs && command.expiresAtMs - nowMs <= 48 * 36e5 && command.expiresAtMs <= season.accessEndsAtMs,
      "invalid",
      "Choose an explicit invitation expiry within 48 hours and the current season."
    );
    requireRule(
      !next.invitations.some(
        (item) => item.id === command.invitationId || item.credential?.kind === "sha256" && item.credential.tokenHash === command.tokenHash
      ),
      "conflict",
      "Invitation identities and verifiers cannot be reused."
    );
    let sourceId = null;
    if (command.type === "invite.reissued") {
      requireRule(
        validInvitationIdentity(command.sourceInvitationId),
        "invalid",
        "The source invitation identity is unavailable."
      );
      const source2 = next.invitations.find(
        (item) => item.id === command.sourceInvitationId && item.teamId === actor.teamId && item.seasonId === actor.seasonId
      );
      requireRule(
        source2 && source2.acceptedBy === null && source2.acceptedAtMs === null,
        "closed",
        "An accepted invitation or grant cannot be replaced by reissue."
      );
      requireRule(
        source2.credential?.kind === "sha256" || source2.credential?.kind === "legacy_retired",
        "closed",
        "Retire legacy invitation credentials before issuing their replacement."
      );
      requireRule(
        actor.role === "manager" || source2.inviterAccountId === actor.accountId,
        "forbidden",
        "Only the original current inviter or a current manager can reissue this pending invitation."
      );
      requireRule(
        source2.revokedAtMs === null || source2.credential?.kind === "legacy_retired" && source2.credential.requiresReissue,
        "closed",
        "A revoked invitation cannot be reissued."
      );
      requireRule(
        !next.invitations.some(
          (item) => item.reissuedFromInvitationId === source2.id
        ),
        "closed",
        "This invitation already has a replacement. Reissue the retained replacement explicitly."
      );
      source2.revokedAtMs ??= nowMs;
      if (source2.credential?.kind === "legacy_retired")
        source2.credential.requiresReissue = false;
      sourceId = source2.id;
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
      reissuedFromInvitationId: sourceId
    });
  }
  next.revision += 1;
  next.appliedCommands[command.id] = fingerprint3;
  next.audit.push({
    id: command.id,
    actorAccountId: actor.accountId,
    action: command.type,
    atMs: nowMs,
    origin: "account"
  });
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
    invitations: allowed && actor.role !== "spectator" ? scoped(state.invitations).filter((item) => actor.role === "manager" || item.inviterAccountId === actor.accountId).map((item) => ({ ...publicInvitation(item, nowMs), reviewCode: item.credential?.kind === "fictional_review" && state.synthetic === true ? item.credential.code : void 0 })) : [],
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
        candidates: mayVote ? match.playedPlayerIds.filter((id9) => id9 !== actor.playerId).map((id9) => ({ id: id9, label: labelForPlayer(state, id9) })) : [],
        award: share && award ? { ...award, winnerLabels: award.winnerPlayerIds.map((id9) => labelForPlayer(state, id9)) } : null
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
    ...playerIds.map((id9, index) => ({ id: `synthetic-account-player-${String(index + 1).padStart(2, "0")}`, label: `Player ${id9.slice(-2)}`, classification: "child_shared", adultVerified: false })),
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
function communityObjectShape(value, fields8) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const object9 = value;
  return Object.keys(object9).every((key) => Object.hasOwn(fields8, key)) && Object.entries(fields8).every(([key, rule]) => Object.hasOwn(object9, key) ? rule.accepts(object9[key]) : Boolean(rule.optional));
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
function parseCommunityCommand(input, options2 = {}) {
  requireRule(input !== null && typeof input === "object" && !Array.isArray(input), "invalid", "Invalid community command.");
  const object9 = input;
  requireRule(typeof object9.type === "string" && Object.hasOwn(communityCommandFields, object9.type), "invalid", "Invalid community command.");
  requireRule(object9.type !== "match.registered" || options2.allowServiceOwnedCommands === true, "forbidden", "Match publication and finish evidence must be assigned by the service, not a public community command.");
  const fields8 = communityCommandFields[object9.type];
  requireRule(
    communityObjectShape(input, { id: communityId, type: communityEnum(object9.type), expectedRevision: communityOptional(communityInteger()), ...fields8 }),
    "invalid",
    "Invalid community command fields."
  );
  return JSON.parse(JSON.stringify(input));
}

// apps/api/src/oidc.ts
import { createPublicKey, verify } from "node:crypto";
function createOidcVerifier(options2) {
  if (!options2.issuer || !options2.audience || new URL(options2.issuer).protocol !== "https:" || new URL(options2.jwksUri).protocol !== "https:") throw new Error("OIDC requires explicitly configured HTTPS issuer, audience and JWKS URI.");
  const now = options2.now ?? Date.now;
  let cache = null;
  let lastRefreshAt = -Infinity;
  let fetching = null;
  const load = async (refresh) => {
    if (!refresh && cache && cache.expires > now()) return cache.keys;
    if (refresh && cache && now() - lastRefreshAt < 3e4) return cache.keys;
    fetching ??= (options2.fetchJwks ?? (async () => {
      const response = await fetch(options2.jwksUri, { signal: AbortSignal.timeout(5e3), redirect: "error", headers: { accept: "application/json" } });
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
      let keys2 = await load(false);
      let jwk = keys2.find((key) => key.kid === header2.kid && key.kty === "RSA" && (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig"));
      if (!jwk) {
        keys2 = await load(true);
        jwk = keys2.find((key) => key.kid === header2.kid && key.kty === "RSA" && (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig"));
      }
      if (!jwk || jwk.d) throw new Error();
      const signingKey = createPublicKey({ key: jwk, format: "jwk" });
      if ((signingKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 || !verify("RSA-SHA256", Buffer.from(`${segments[0]}.${segments[1]}`), signingKey, Buffer.from(segments[2], "base64url"))) throw new Error();
      const seconds = now() / 1e3;
      const audience2 = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
      if (claims.iss !== options2.issuer || typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255 || !Array.isArray(audience2) || !audience2.every((value) => typeof value === "string") || !audience2.includes(options2.audience)) throw new Error();
      if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= seconds) throw new Error();
      if (claims.nbf !== void 0 && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > seconds)) throw new Error();
      if (claims.iat !== void 0 && (typeof claims.iat !== "number" || !Number.isFinite(claims.iat) || claims.iat > seconds + 30)) throw new Error();
      const authTime = typeof claims.auth_time === "number" && Number.isFinite(claims.auth_time) && claims.auth_time >= 0 ? claims.auth_time * 1e3 : 0;
      if (authTime > now() + 3e4) throw new Error();
      const amr = Array.isArray(claims.amr) ? claims.amr.filter((value) => typeof value === "string") : [];
      const strongAuth = amr.includes("mfa") || amr.includes("pwd") && amr.includes("otp") || typeof claims.acr === "string" && (options2.mfaAcrValues ?? []).includes(claims.acr);
      return { issuer: claims.iss, subject: claims.sub, strongAuth, authenticatedAt: authTime };
    } catch {
      throw new AccessError("INVALID_SESSION", 401, "A valid authenticated session is required.");
    }
  };
}

// packages/application/src/training-series.ts
var maximumTrainingOccurrences = 52;
function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}
function trainingSeriesOccurrences(state, seasonId, recurrenceGroupId) {
  requireThat(typeof recurrenceGroupId === "string" && recurrenceGroupId.trim().length > 0 && recurrenceGroupId.length <= 150, "A stable training series identity is required.");
  requireThat(seasonId === state.activeSeasonId, "Choose the current season before editing a training series.");
  const occurrences = state.training.filter((item) => item.recurrenceGroupId === recurrenceGroupId);
  requireThat(occurrences.every((item) => item.seasonId === seasonId), "The training series belongs to a different season.");
  return [...occurrences].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
}
function applyTrainingSeries(state, command, validate) {
  requireThat(command.confirmOccurrences === true, "Review and explicitly confirm the listed training occurrences.");
  const series = trainingSeriesOccurrences(state, command.seasonId, command.recurrenceGroupId);
  if (command.type === "training.series_created") {
    requireThat(series.length === 0, "That training series already exists; use its scheduled-occurrence editor.");
    requireThat(Array.isArray(command.occurrences) && command.occurrences.length >= 2 && command.occurrences.length <= maximumTrainingOccurrences, "A series needs between 2 and 52 explicit occurrences.");
    const ids = /* @__PURE__ */ new Set(), dates = /* @__PURE__ */ new Set();
    for (const draft of command.occurrences) {
      requireThat(draft.seasonId === command.seasonId && draft.recurrenceGroupId === command.recurrenceGroupId, "Every occurrence must belong to the confirmed series and season.");
      requireThat(!ids.has(draft.id) && !state.training.some((item) => item.id === draft.id), "Each occurrence must have a new stable identity.");
      requireThat(!dates.has(draft.date), "Each series occurrence must have a distinct calendar date.");
      validate(draft);
      ids.add(draft.id);
      dates.add(draft.date);
    }
    state.training.push(...command.occurrences.map((draft) => ({ ...draft, expectedProfileIds: [...draft.expectedProfileIds], status: "scheduled", responses: {}, attendance: {} })));
    return;
  }
  const scheduled = series.filter((item) => item.status === "scheduled");
  requireThat(Array.isArray(command.occurrenceIds) && command.occurrenceIds.length > 0 && command.occurrenceIds.length <= maximumTrainingOccurrences && new Set(command.occurrenceIds).size === command.occurrenceIds.length, "Review a nonempty list of distinct scheduled occurrences.");
  requireThat(command.occurrenceIds.length === scheduled.length && scheduled.every((item) => command.occurrenceIds.includes(item.id)), "The scheduled series changed; review its exact occurrence list again. Held and cancelled occurrences cannot be edited as scheduled sessions.");
  if (command.type === "training.series_updated") {
    for (const occurrence of scheduled) validate({ ...occurrence, ...command.changes });
    const ids = new Set(command.occurrenceIds);
    state.training = state.training.map((item) => ids.has(item.id) ? { ...item, time: command.changes.time, venue: command.changes.venue, expectedProfileIds: [...command.changes.expectedProfileIds] } : item);
  } else {
    const ids = new Set(command.occurrenceIds);
    state.training = state.training.map((item) => ids.has(item.id) ? { ...item, status: "cancelled" } : item);
  }
}

// packages/domain/src/live-events.ts
function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}
function duration(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer.`);
}
function effectiveTime(state, requested) {
  if (state.half !== 1 && state.half !== 2) throw new Error("An effective match event requires a started half.");
  const time3 = requested ?? { half: state.half, halfElapsedMs: state.halfActiveMs, matchElapsedMs: state.matchActiveMs };
  if (time3.half !== 1 && time3.half !== 2) throw new Error("Effective half must be one or two.");
  duration(time3.halfElapsedMs, "Effective half time");
  duration(time3.matchElapsedMs, "Effective match time");
  if (time3.half > state.half) throw new Error("Effective time cannot refer to a half that has not started.");
  const firstHalf = state.firstHalfDurationMs;
  if (time3.half === 2 && firstHalf === null) throw new Error("Second-half time requires the recorded actual first-half duration.");
  const expected = (time3.half === 2 ? firstHalf ?? 0 : 0) + time3.halfElapsedMs;
  if (expected !== time3.matchElapsedMs) throw new Error("Effective cumulative time must use actual first-half duration and exclude half-time.");
  const maximum = time3.half === 1 && firstHalf !== null ? firstHalf : state.halfActiveMs;
  if (time3.halfElapsedMs > maximum || time3.matchElapsedMs > state.matchActiveMs) throw new Error("Effective time cannot invent future active play.");
  return { ...time3 };
}
function wasOnPitch(state, playerId, time3) {
  if (time3.matchElapsedMs === state.matchActiveMs && time3.half === state.half && state.lineup.some((item) => item.playerId === playerId)) return true;
  return state.intervals.some((interval) => interval.playerId === playerId && interval.state === "playing" && interval.half === time3.half && interval.startMs <= time3.matchElapsedMs && interval.endMs >= time3.matchElapsedMs);
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
  const active2 = goals.filter((goal) => !goal.voided);
  const sum = (values) => ({
    for: values.filter((goal) => goal.beneficiary === "us").length,
    against: values.filter((goal) => goal.beneficiary === "opposition").length
  });
  return {
    score: sum(active2),
    halfTimeScore: state.firstHalfDurationMs === null ? state.halfTimeScore : sum(active2.filter((goal) => goal.effective.half === 1))
  };
}

// packages/domain/src/policy.ts
function fail(message) {
  throw new Error(message);
}
function keys(value, fields8, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields8.includes(key)) || fields8.some((key) => !Object.hasOwn(value, key))) fail(`Use the exact versioned ${label} fields.`);
}
function nonnegative(value, label) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(`${label} must be a nonnegative safe integer.`);
}
function keeperRank(config, playerId) {
  const saved = config.profileSnapshot?.find((profile) => profile.playerId === playerId);
  return saved ? saved.preferences.indexOf("GK") + 1 : config.players.find((player) => player.id === playerId)?.goalkeeperChoice ?? 0;
}
function initialKeeperPolicy(config) {
  return { keeperMode: config.fixedKeeperId ? "sole_fixed" : "common_pool", fixedKeeperPlayerSeasonId: config.fixedKeeperId };
}
function assertMatchPolicyProposal(value, config) {
  keys(value, ["payload", "applicability", "softPreferences"], "match policy proposal");
  const payload = value.payload;
  keys(payload, ["keeperMode", "fixedKeeperPlayerSeasonId", "minimumStintMs", "batchLimit", "scoreLeadThreshold", "returnToNormalEnabled"], "canonical policy payload");
  if (!["sole_fixed", "common_pool"].includes(String(payload.keeperMode))) fail("Choose an explicit supported goalkeeper policy.");
  if (payload.keeperMode === "common_pool" && payload.fixedKeeperPlayerSeasonId !== null) fail("Common-pool policy cannot create a fixed-keeper exemption.");
  if (payload.keeperMode === "sole_fixed" && (typeof payload.fixedKeeperPlayerSeasonId !== "string" || !config.selectedPlayerIds.includes(payload.fixedKeeperPlayerSeasonId) || ![1, 2].includes(keeperRank(config, payload.fixedKeeperPlayerSeasonId)))) fail("The fixed keeper must be a selected first- or second-choice goalkeeper.");
  nonnegative(payload.minimumStintMs, "Preferred minimum stint");
  if (!Number.isSafeInteger(payload.batchLimit) || Number(payload.batchLimit) < 1 || Number(payload.batchLimit) > 11) fail("Choose a batch preference from one to eleven.");
  if (!Number.isSafeInteger(payload.scoreLeadThreshold) || Number(payload.scoreLeadThreshold) < 1 || typeof payload.returnToNormalEnabled !== "boolean") fail("Choose a positive score threshold and an explicit return-to-normal option.");
  keys(value.applicability, ["minimumStint", "batchLimit", "q07"], "policy applicability");
  if (value.applicability.minimumStint !== "soft_preference" || value.applicability.batchLimit !== "soft_preference" || value.applicability.q07 !== "unapproved") fail("Ordinary stint and batch settings remain soft. This command cannot approve Q07 or introduce a mandatory constraint.");
  keys(value.softPreferences, ["halfBufferFraction"], "soft preferences");
  const fraction = value.softPreferences.halfBufferFraction;
  if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 0.49) fail("The soft half buffer must be between zero and 0.49.");
}
function assertInitialLineupProposal(config, value) {
  if (!Array.isArray(value) || value.length !== config.pitchPlaces || new Set(value.map((item) => item?.playerId)).size !== value.length || new Set(value.map((item) => item?.slotId)).size !== value.length) fail("A starting-lineup proposal needs distinct selected players and slots for the saved format.");
  for (const allocation of value) {
    keys(allocation, ["slotId", "position", "playerId"], "lineup proposal");
    if (typeof allocation.playerId !== "string" || !config.selectedPlayerIds.includes(allocation.playerId) || typeof allocation.slotId !== "string" || !allocation.slotId || typeof allocation.position !== "string" || !allocation.position) fail("Starting-lineup proposals must use the selected saved match squad.");
    if (config.slots && !config.slots.some((slot) => slot.slotId === allocation.slotId && slot.position === allocation.position)) fail("Starting-lineup proposals must use the saved formation slots and roles.");
    const saved = config.profileSnapshot?.find((profile) => profile.playerId === allocation.playerId);
    if (saved && !saved.eligiblePositions.includes(allocation.position)) fail("A proposed role is outside the saved player eligibility.");
  }
  const keepers = value.filter((allocation) => allocation.position === "GK");
  if (keepers.length !== 1 || ![1, 2].includes(keeperRank(config, keepers[0].playerId)) || config.fixedKeeperId && keepers[0].playerId !== config.fixedKeeperId) fail("A lineup proposal needs one qualifying keeper consistent with its explicit policy.");
}
function policyAtBoundary(state, half2, activeMs, maximumRevision = Infinity) {
  const matching = (state.policyHistory ?? []).filter((policy) => policy.revision <= maximumRevision && policy.effective.half <= half2 && policy.effective.matchElapsedMs <= activeMs);
  return matching.length ? matching[matching.length - 1] : null;
}
function fixedKeeperAtBoundary(state, half2, activeMs, maximumRevision = Infinity) {
  const policy = policyAtBoundary(state, half2, activeMs, maximumRevision);
  return policy ? policy.payload.keeperMode === "sole_fixed" ? policy.payload.fixedKeeperPlayerSeasonId : null : state.config.fixedKeeperId;
}
function currentFixedKeeper(state) {
  return state.activePolicy ? state.activePolicy.payload.keeperMode === "sole_fixed" ? state.activePolicy.payload.fixedKeeperPlayerSeasonId : null : state.config.fixedKeeperId;
}
function assertPolicyBoundary(state, time3) {
  keys(time3, ["half", "halfElapsedMs", "matchElapsedMs"], "policy boundary");
  nonnegative(time3.halfElapsedMs, "Policy half time");
  nonnegative(time3.matchElapsedMs, "Policy match time");
  if (time3.half !== state.half || ![0, 1, 2].includes(time3.half)) fail("Policy changes must use the current preparation or half boundary.");
  const expected = (time3.half === 2 ? state.firstHalfDurationMs ?? fail("The actual first-half duration is required.") : 0) + time3.halfElapsedMs;
  if (expected !== time3.matchElapsedMs || time3.matchElapsedMs !== state.matchActiveMs || time3.halfElapsedMs !== state.halfActiveMs) fail("Policy changes are prospective only; the captured boundary must match the current continuous checkpoint.");
}
function applyPolicyChange(state, event, previousRevision) {
  const allowed = ["id", "sample", "actorId", "type", "policySchemaVersion", "policyVersion", "previousPolicyVersion", "sourceRevision", "effective", "reason", "payload", "applicability", "softPreferences", "resetPositionMode"];
  if (Object.keys(event).some((key) => !allowed.includes(key))) fail("Use only the documented versioned policy command fields.");
  nonnegative(event.policyVersion, "Policy version");
  nonnegative(event.previousPolicyVersion, "Previous policy version");
  nonnegative(event.sourceRevision, "Policy source revision");
  assertMatchPolicyProposal({ payload: event.payload, applicability: event.applicability, softPreferences: event.softPreferences }, state.config);
  if (event.policySchemaVersion !== 1 || event.sourceRevision !== previousRevision || event.previousPolicyVersion !== (state.activePolicy?.policyVersion ?? 0) || event.policyVersion !== event.previousPolicyVersion + 1) fail("The policy source or version changed. Review the current match before confirming again.");
  if (typeof event.reason !== "string" || event.reason.trim().length < 5 || event.reason.length > 500) fail("Record a concise reason for this prospective settings change.");
  if (event.resetPositionMode !== void 0 && typeof event.resetPositionMode !== "boolean") fail("A position-mode reset must be explicit.");
  assertPolicyBoundary(state, event.effective);
  const previous = state.activePolicy?.payload ?? initialKeeperPolicy(state.config);
  if (event.payload.keeperMode !== previous.keeperMode || event.payload.fixedKeeperPlayerSeasonId !== previous.fixedKeeperPlayerSeasonId) fail("Q07 goalkeeper-policy transitions are unapproved. This service has no explicit experimental transition gate; retain the proposal for policy review.");
  const details = { policySchemaVersion: 1, policyVersion: event.policyVersion, previousPolicyVersion: event.previousPolicyVersion, sourceRevision: event.sourceRevision, effective: cloneValue(event.effective), reason: event.reason, payload: cloneValue(event.payload), applicability: cloneValue(event.applicability), softPreferences: cloneValue(event.softPreferences), ...event.resetPositionMode === void 0 ? {} : { resetPositionMode: event.resetPositionMode } };
  const record2 = { ...details, eventId: event.id, revision: previousRevision + 1, recordedAtMs: event.sample.wallTimeMs, actorId: event.actorId ?? null };
  const activePolicy = { ...cloneValue(record2), positionMode: event.resetPositionMode ? "normal" : state.activePolicy?.positionMode ?? "normal", manualResetAtSourceRevision: event.resetPositionMode ? previousRevision + 1 : null };
  return { ...state, activePolicy, policyHistory: [...state.policyHistory ?? [], record2] };
}
function updatePolicyPositionMode(state, nextRevision) {
  const policy = state.activePolicy;
  if (!policy || policy.manualResetAtSourceRevision === nextRevision) return state;
  const leading = state.score.for - state.score.against >= policy.payload.scoreLeadThreshold;
  const mode = leading ? "adventurous" : policy.payload.returnToNormalEnabled ? "normal" : policy.positionMode;
  return mode === policy.positionMode ? state : { ...state, activePolicy: { ...policy, positionMode: mode } };
}

// packages/domain/src/participation-corrections.ts
var copyLineup = (lineup) => lineup.map((item) => ({ ...item }));
function policyStateAt(state, half2, activeMs, maximumRevision = Infinity) {
  const policy = policyAtBoundary(state, half2, activeMs, maximumRevision);
  return { ...state, activePolicy: policy ? { ...policy, positionMode: "normal", manualResetAtSourceRevision: null } : void 0 };
}
var compare = (left, right) => (left.effective?.half ?? 0) - (right.effective?.half ?? 0) || (left.effective?.matchElapsedMs ?? 0) - (right.effective?.matchElapsedMs ?? 0) || left.order - right.order;
function knownBoundary(state, eventId) {
  const audit = state.audit?.find((item) => item.eventId === eventId);
  if (!audit)
    throw new Error(
      "Original event boundary evidence is missing. Retain the history for explicit reconciliation."
    );
  return audit.effective ? effectiveTime(state, audit.effective) : null;
}
function initial(state) {
  return {
    attendance: Object.fromEntries(
      state.config.selectedPlayerIds.map((id9) => [
        id9,
        state.config.initialAttendance?.[id9] ?? "not_recorded"
      ])
    ),
    availability: Object.fromEntries(
      state.config.selectedPlayerIds.map((id9) => [id9, true])
    ),
    lineup: []
  };
}
function applyFact(current3, fact) {
  if (fact.voided) return;
  if (fact.type === "attendance.recorded") {
    current3.attendance[fact.playerId] = fact.status;
    if (fact.status !== "present")
      current3.lineup = current3.lineup.filter(
        (item) => item.playerId !== fact.playerId
      );
  } else if (fact.type === "availability.changed") {
    current3.availability[fact.playerId] = fact.available;
    if (!fact.available)
      current3.lineup = current3.lineup.filter(
        (item) => item.playerId !== fact.playerId
      );
    if (fact.lineup) current3.lineup = copyLineup(fact.lineup);
  } else current3.lineup = copyLineup(fact.lineup);
}
function factsAt(state, facts, half2, activeMs) {
  const current3 = initial(state);
  for (const fact of [...facts].sort(compare)) {
    if (fact.effective && (fact.effective.half > half2 || fact.effective.matchElapsedMs > activeMs))
      continue;
    applyFact(current3, fact);
  }
  return current3;
}
function replacementValue(state, fact, event) {
  if (fact.type !== "lineup.committed" && fact.type !== "availability.changed")
    throw new Error(
      "This correction requires a separate review of clock, halves or attendance evidence."
    );
  const next = {
    ...cloneValue(fact),
    latestEventId: event.id,
    aliases: [...fact.aliases, event.id]
  };
  if (event.type === "event.voided") {
    if (fact.voided)
      throw new Error("This participation event is already voided.");
    return { ...next, voided: true };
  }
  if (event.replacement.type !== fact.type)
    throw new Error("A correction cannot change the original event family.");
  if (fact.voided && event.restoreVoided !== true)
    throw new Error(
      "Restoring a voided participation event needs explicit confirmation."
    );
  const requested = event.replacement.effective ?? fact.effective;
  const boundary = requested ? effectiveTime(state, requested) : null;
  if ((boundary?.half ?? 0) !== (fact.effective?.half ?? 0))
    throw new Error(
      "A participation correction cannot move evidence into another half. Review both halves separately."
    );
  if (event.replacement.type === "lineup.committed") {
    if (!boundary)
      throw new Error(
        "A corrected lineup needs its actual active-time boundary."
      );
    return {
      ...next,
      effective: boundary,
      lineup: copyLineup(event.replacement.lineup),
      voided: false
    };
  }
  const replacement = event.replacement;
  if (replacement.playerId !== fact.playerId || !state.config.selectedPlayerIds.includes(replacement.playerId))
    throw new Error(
      "An availability correction must retain its selected player identity."
    );
  if (typeof replacement.available !== "boolean")
    throw new Error("Availability must be confirmed explicitly.");
  const reason = replacement.reason ?? fact.reason ?? "other";
  if (!["arrival", "departure", "injury", "return", "other"].includes(reason) || ["arrival", "return"].includes(reason) && !replacement.available || ["injury", "departure"].includes(reason) && replacement.available)
    throw new Error("Availability reason conflicts with the confirmed state.");
  return {
    ...next,
    effective: boundary,
    available: replacement.available,
    reason,
    lineup: replacement.replacementLineup ? copyLineup(replacement.replacementLineup) : fact.lineup ? copyLineup(fact.lineup) : void 0,
    voided: false
  };
}
function retainedParticipationFacts(state) {
  const facts = [];
  let staged = [];
  for (const [order, event] of (state.eventHistory ?? []).entries()) {
    const effective = knownBoundary(state, event.id);
    if (event.type === "lineup.staged") {
      staged = copyLineup(event.lineup);
      continue;
    }
    if (event.type === "half.ended" && effective?.half === 1) {
      staged = copyLineup(
        factsAt(state, facts, 1, effective.matchElapsedMs).lineup
      );
      continue;
    }
    if (event.type === "event.corrected" || event.type === "event.voided") {
      const index = facts.findIndex(
        (fact) => fact.aliases.includes(event.targetEventId)
      );
      if (index >= 0 && ["lineup.committed", "availability.changed"].includes(facts[index].type))
        facts[index] = replacementValue(state, facts[index], event);
      continue;
    }
    const base = {
      eventId: event.id,
      latestEventId: event.id,
      aliases: [event.id],
      order,
      effective,
      recordedAtMs: event.sample.wallTimeMs,
      voided: false
    };
    if (event.type === "half.started") {
      if (!effective)
        throw new Error("A half start is missing its actual active boundary.");
      facts.push({ ...base, type: event.type, lineup: copyLineup(staged) });
    } else if (event.type === "lineup.committed")
      facts.push({
        ...base,
        type: event.type,
        lineup: copyLineup(event.lineup)
      });
    else if (event.type === "attendance.recorded")
      facts.push({
        ...base,
        type: event.type,
        playerId: event.playerId,
        status: event.status
      });
    else if (event.type === "availability.changed")
      facts.push({
        ...base,
        type: event.type,
        playerId: event.playerId,
        available: event.available,
        reason: event.reason ?? "other",
        lineup: event.replacementLineup ? copyLineup(event.replacementLineup) : void 0
      });
  }
  return facts;
}
function reprojectParticipation(state, correction, validateLineup2) {
  if (correction.sourceRevision !== state.revision)
    throw new Error(
      "Participation correction draft is stale or lacks explicit interval reconciliation review. Review the current recorded history first."
    );
  const facts = retainedParticipationFacts(state);
  let prior = null;
  let changed;
  if (correction.type === "event.corrected" || correction.type === "event.voided") {
    const targetIndex = facts.findIndex(
      (fact) => fact.aliases.includes(correction.targetEventId)
    );
    if (targetIndex < 0)
      throw new Error(
        "The participation correction target has no complete original evidence in this match."
      );
    prior = cloneValue(facts[targetIndex]);
    changed = replacementValue(state, prior, correction);
    facts[targetIndex] = changed;
  } else {
    if (!correction.effective || !correction.lateEntryReason?.trim() || correction.lateEntryReason.length > 500)
      throw new Error(
        "A historical participation entry needs an explicit effective time and audited late-entry reason of 1\u2013500 characters."
      );
    const effective = effectiveTime(state, correction.effective);
    const base = {
      eventId: correction.id,
      latestEventId: correction.id,
      aliases: [correction.id],
      order: state.eventHistory?.length ?? 0,
      effective,
      recordedAtMs: correction.sample.wallTimeMs,
      voided: false
    };
    if (correction.type === "lineup.committed")
      changed = {
        ...base,
        type: correction.type,
        lineup: copyLineup(correction.lineup)
      };
    else {
      if (!state.config.selectedPlayerIds.includes(correction.playerId) || typeof correction.available !== "boolean")
        throw new Error(
          "Historical availability requires a selected player and explicit state."
        );
      const reason = correction.reason ?? "other";
      if (!["arrival", "departure", "injury", "return", "other"].includes(
        reason
      ) || ["arrival", "return"].includes(reason) && !correction.available || ["injury", "departure"].includes(reason) && correction.available)
        throw new Error(
          "Availability reason conflicts with the confirmed state."
        );
      changed = {
        ...base,
        type: correction.type,
        playerId: correction.playerId,
        available: correction.available,
        reason,
        lineup: correction.replacementLineup ? copyLineup(correction.replacementLineup) : void 0
      };
    }
    facts.push(changed);
  }
  const sorted = [...facts].sort(compare);
  const intervals = [];
  const targetIntervals = [];
  const availabilityHistory = [];
  const current3 = initial(state);
  let activeHalf = 0;
  for (const fact of sorted) {
    if (fact.voided) continue;
    if (fact.type === "availability.changed")
      availabilityHistory.push({
        eventId: fact.eventId,
        latestEventId: fact.latestEventId,
        playerId: fact.playerId,
        available: fact.available,
        previousAvailability: current3.availability[fact.playerId],
        reason: fact.reason ?? "other",
        effective: fact.effective,
        recordedAtMs: fact.recordedAtMs
      });
    applyFact(current3, fact);
    if (fact.effective) activeHalf = fact.effective.half;
    if (fact.type === "half.started" || fact.type === "lineup.committed" || fact.type === "availability.changed" && fact.lineup) {
      const errors = validateLineup2(
        {
          ...policyStateAt(state, fact.effective?.half ?? 0, fact.effective?.matchElapsedMs ?? 0, fact.order + 1),
          attendance: current3.attendance,
          availability: current3.availability
        },
        current3.lineup,
        true
      );
      if (errors.length)
        throw new Error(`Corrected allocation is invalid: ${errors.join(" ")}`);
    }
    if (activeHalf > state.half)
      throw new Error("Corrected evidence refers to an unstarted half.");
  }
  const firstEnd = state.firstHalfDurationMs ?? (state.half === 1 ? state.matchActiveMs : 0);
  for (const half2 of [1, 2]) {
    if (half2 > state.half) continue;
    const start = half2 === 1 ? 0 : firstEnd;
    const end = half2 === 1 ? firstEnd : state.matchActiveMs;
    const boundaries = [
      .../* @__PURE__ */ new Set([
        start,
        end,
        ...sorted.filter((fact) => !fact.voided && fact.effective?.half === half2).map((fact) => fact.effective.matchElapsedMs),
        ...(state.policyHistory ?? []).filter((policy) => policy.effective.half === half2).map((policy) => policy.effective.matchElapsedMs)
      ])
    ].sort((a, b) => a - b);
    for (let index = 0; index + 1 < boundaries.length; index++) {
      const from = boundaries[index], to = boundaries[index + 1];
      if (from < start || to > end || to <= from) continue;
      const actual = factsAt(state, sorted, half2, from);
      const errors = validateLineup2(
        {
          ...policyStateAt(state, half2, from),
          attendance: actual.attendance,
          availability: actual.availability
        },
        actual.lineup,
        false
      );
      if (errors.length)
        throw new Error(
          `Corrected participation is invalid: ${errors.join(" ")}`
        );
      for (const playerId of state.config.selectedPlayerIds) {
        const allocation = actual.lineup.find(
          (item) => item.playerId === playerId
        );
        const available2 = actual.attendance[playerId] === "present" && actual.availability[playerId];
        intervals.push({
          playerId,
          state: allocation ? "playing" : available2 ? "available_bench" : "unavailable",
          position: allocation?.position ?? null,
          slotId: allocation?.slotId ?? null,
          startMs: from,
          endMs: to,
          half: half2
        });
      }
      const availablePlayerIds = state.config.selectedPlayerIds.filter(
        (id9) => actual.attendance[id9] === "present" && actual.availability[id9]
      );
      const policy = policyAtBoundary(state, half2, from);
      const fixedKeeperId = fixedKeeperAtBoundary(state, half2, from);
      targetIntervals.push({
        durationMs: to - from,
        availablePlayerIds,
        pitchPlaces: state.config.pitchPlaces,
        fixedKeeperId: fixedKeeperId && availablePlayerIds.includes(fixedKeeperId) ? fixedKeeperId : null,
        ...policy ? { policyVersion: policy.policyVersion } : {}
      });
    }
  }
  const final = factsAt(state, sorted, state.half, state.matchActiveMs);
  const projected = {
    ...state,
    intervals,
    targetIntervals,
    lineup: final.lineup,
    attendance: { ...state.attendance, ...final.attendance },
    availability: { ...state.availability, ...final.availability },
    availabilityHistory
  };
  for (const goal of state.goals ?? [])
    if (!goal.voided) {
      try {
        goalRecord(projected, goal, goal.eventId, goal.recordedAtMs);
      } catch {
        throw new Error(
          `Goal ${goal.eventId} no longer has consistent on-pitch evidence. Review that goal explicitly before applying this participation correction.`
        );
      }
    }
  const oldTime = prior?.effective, newTime = changed.effective;
  const earliestAffected = oldTime && newTime ? oldTime.matchElapsedMs <= newTime.matchElapsedMs ? oldTime : newTime : oldTime ?? newTime;
  return {
    state: projected,
    priorValue: prior,
    value: changed,
    effective: changed.effective,
    earliestAffected
  };
}

// packages/domain/src/index.ts
var ENGINE_VERSION = "synthetic-live-4";
function integer2(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer.`);
}
function assertSample(sample) {
  if (!Number.isFinite(sample.monotonicMs) || sample.monotonicMs < 0 || !sample.sessionId) throw new Error("Clock sample is invalid.");
  integer2(sample.wallTimeMs, "Wall time");
}
function isRunning(state) {
  return state.status === "first_half_running" || state.status === "second_half_running";
}
function isPaused(state) {
  return state.status === "first_half_paused" || state.status === "second_half_paused";
}
function available(state, id9) {
  return state.availability[id9] === true && state.attendance[id9] === "present";
}
function selectedPlayer(state, id9) {
  if (!state.config.selectedPlayerIds.includes(id9)) throw new Error("Player is outside this selected match squad.");
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
  integer2(config.plannedHalfDurationMs, "Planned half duration");
  if (config.plannedHalfDurationMs < 3e4) throw new Error("Planned half duration must be at least 30 seconds.");
  const ids = config.players.map((player) => player.id);
  if (new Set(ids).size !== ids.length || new Set(config.selectedPlayerIds).size !== config.selectedPlayerIds.length) throw new Error("Player identifiers must be unique.");
  if (config.selectedPlayerIds.some((id9) => !ids.includes(id9))) throw new Error("Selected players must belong to this roster.");
  if (config.initialAttendance && Object.entries(config.initialAttendance).some(([id9, status2]) => !config.selectedPlayerIds.includes(id9) || !["present", "absent", "excused", "not_selected", "not_recorded"].includes(status2))) throw new Error("Initial attendance must be explicit valid check-in for the selected squad.");
  if (config.slots && (config.slots.length !== config.pitchPlaces || new Set(config.slots.map((slot) => slot.slotId)).size !== config.slots.length || config.slots.filter((slot) => slot.position === "GK").length !== 1 || config.slots.some((slot) => !slot.slotId || !slot.position))) throw new Error("Saved formation needs one distinct slot per pitch place and exactly one goalkeeper.");
  if (config.profileSnapshot && (new Set(config.profileSnapshot.map((profile) => profile.playerId)).size !== config.profileSnapshot.length || config.profileSnapshot.some((profile) => !ids.includes(profile.playerId) || profile.preferences.length > 3 || new Set(profile.preferences).size !== profile.preferences.length || new Set(profile.eligiblePositions).size !== profile.eligiblePositions.length))) throw new Error("Match profile snapshots must belong to distinct roster players with distinct preferences and eligibility.");
  if (config.fixedKeeperId !== null && (!config.selectedPlayerIds.includes(config.fixedKeeperId) || ![1, 2].includes(keeperChoice(config, config.fixedKeeperId)))) throw new Error("Fixed keeper must be a selected first- or second-choice goalkeeper.");
  if (config.initialPolicyProposal !== void 0) assertMatchPolicyProposal(config.initialPolicyProposal, config);
  if (config.initialLineupProposal !== void 0) assertInitialLineupProposal(config, config.initialLineupProposal);
  return {
    config: cloneValue(config),
    status: "preparation",
    revision: 0,
    attendance: Object.fromEntries(ids.map((id9) => [id9, config.initialAttendance?.[id9] ?? "not_recorded"])),
    availability: Object.fromEntries(ids.map((id9) => [id9, config.selectedPlayerIds.includes(id9)])),
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
  const fixedKeeperId = currentFixedKeeper(state);
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
  for (const keeper2 of keepers) {
    const player = state.config.players.find((item) => item.id === keeper2.playerId);
    if (!player || ![1, 2].includes(keeperChoice(state.config, keeper2.playerId))) errors.push("Goalkeeper cover requires a first- or second-choice eligible keeper.");
    if (fixedKeeperId && keeper2.playerId !== fixedKeeperId) errors.push("The fixed keeper policy cannot be changed by moving a pitch piece.");
  }
  const qualifying = state.config.players.filter((player) => available(state, player.id) && [1, 2].includes(keeperChoice(state.config, player.id)));
  if (fixedKeeperId && qualifying.length > 1) errors.push("Multiple qualifying available keepers require a reviewed shared-keeper policy.");
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
  const fixedKeeperId = currentFixedKeeper(state);
  if (!isRunning(state) || durationMs === 0) return state;
  if (state.half !== 1 && state.half !== 2) throw new Error("No active half.");
  const intervals = state.config.selectedPlayerIds.map((playerId) => {
    const allocation = state.lineup.find((item) => item.playerId === playerId);
    const eligible2 = available(state, playerId);
    return {
      playerId,
      state: allocation ? "playing" : eligible2 ? "available_bench" : "unavailable",
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
      availablePlayerIds: state.config.selectedPlayerIds.filter((id9) => available(state, id9)),
      pitchPlaces: state.config.pitchPlaces,
      fixedKeeperId: fixedKeeperId && available(state, fixedKeeperId) ? fixedKeeperId : null,
      ...state.activePolicy ? { policyVersion: state.activePolicy.policyVersion } : {}
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
  if ((previous.status === "completed" || previous.status === "abandoned") && event.type !== "event.corrected" && event.type !== "event.voided" && event.type !== "goal.recorded" && !((event.type === "lineup.committed" || event.type === "availability.changed") && event.effective && event.sourceRevision !== void 0 && event.lateEntryReason?.trim())) throw new Error("Completed or abandoned play is read-only. Use an audited correction without reopening the clock.");
  let state = previous;
  let auditEffective;
  let auditPrior = null;
  let auditValue = event;
  const reviewedParticipationEntry = (event.type === "lineup.committed" || event.type === "availability.changed") && event.effective !== void 0 && event.sourceRevision !== void 0 && Boolean(event.lateEntryReason?.trim());
  if (event.type === "policy.changed") {
    const latest = accrue(previous, event.sample);
    const boundary = event.effective;
    if (!boundary || boundary.half !== previous.half || !Number.isSafeInteger(boundary.matchElapsedMs) || boundary.matchElapsedMs < previous.matchActiveMs || boundary.matchElapsedMs > latest.matchActiveMs) throw new Error("A policy change must use its captured current continuous boundary, never earlier history or future play.");
    if (isRunning(previous)) {
      if (!previous.anchor) throw new Error("A continuous anchor is required for prospective policy changes.");
      const boundarySample = { ...event.sample, monotonicMs: Math.floor(previous.anchor.sample.monotonicMs) + boundary.matchElapsedMs - previous.anchor.matchActiveMs };
      state = accrue(previous, boundarySample);
    } else state = latest;
  } else if (event.type === "availability.changed" && event.effective && !reviewedParticipationEntry) {
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
    case "policy.changed": {
      auditPrior = state.activePolicy ?? null;
      state = applyPolicyChange(state, event, previous.revision);
      auditEffective = event.effective.half === 0 ? null : { ...event.effective, half: event.effective.half };
      auditValue = state.policyHistory?.at(-1);
      state = accrue(state, event.sample);
      break;
    }
    case "attendance.recorded": {
      selectedPlayer(state, event.playerId);
      if (!["present", "absent", "excused", "not_selected", "not_recorded"].includes(event.status)) throw new Error("Attendance status is invalid.");
      state = { ...state, attendance: { ...state.attendance, [event.playerId]: event.status } };
      if (event.status !== "present") state = { ...state, lineup: state.lineup.filter((item) => item.playerId !== event.playerId), stagedLineup: state.stagedLineup.filter((item) => item.playerId !== event.playerId) };
      break;
    }
    case "availability.changed": {
      if (reviewedParticipationEntry) {
        const corrected = reprojectParticipation(state, event, validateLineup);
        state = corrected.state;
        auditEffective = corrected.effective;
        auditPrior = corrected.priorValue;
        auditValue = { inserted: corrected.value, earliestAffected: corrected.earliestAffected };
        break;
      }
      selectedPlayer(state, event.playerId);
      if (typeof event.available !== "boolean") throw new Error("Availability must be explicitly true or false.");
      const reason = event.reason ?? "other";
      if (!["arrival", "departure", "injury", "return", "other"].includes(reason)) throw new Error("Availability reason must be an approved category.");
      if ((reason === "arrival" || reason === "return") && !event.available) throw new Error("Arrival or return requires confirmed availability.");
      if ((reason === "departure" || reason === "injury") && event.available) throw new Error("Injury or departure requires unavailable status.");
      const record2 = {
        eventId: event.id,
        latestEventId: event.id,
        playerId: event.playerId,
        available: event.available,
        previousAvailability: state.availability[event.playerId],
        reason,
        effective: auditEffective ?? (state.half === 0 ? null : effectiveTime(state)),
        recordedAtMs: event.sample.wallTimeMs
      };
      auditPrior = { available: record2.previousAvailability, lineup: cloneLineup(state.lineup) };
      state = { ...state, availability: { ...state.availability, [event.playerId]: event.available } };
      if (!event.available) state = { ...state, lineup: state.lineup.filter((item) => item.playerId !== event.playerId), stagedLineup: state.stagedLineup.filter((item) => item.playerId !== event.playerId) };
      if (event.replacementLineup) {
        ensureLive(state);
        assertLineup(state, event.replacementLineup);
        state = { ...state, lineup: cloneLineup(event.replacementLineup) };
      }
      state = { ...state, availabilityHistory: [...state.availabilityHistory ?? [], record2] };
      auditEffective = record2.effective;
      auditValue = record2;
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
      const half2 = state.status === "preparation" ? 1 : 2;
      state = {
        ...state,
        half: half2,
        status: half2 === 1 ? "first_half_running" : "second_half_running",
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
      if (event.effective) {
        const corrected = reprojectParticipation(state, event, validateLineup);
        state = corrected.state;
        auditEffective = corrected.effective;
        auditPrior = corrected.priorValue;
        auditValue = { inserted: corrected.value, earliestAffected: corrected.earliestAffected };
        break;
      }
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
          const corrected2 = reprojectParticipation(state, event, validateLineup);
          state = corrected2.state;
          auditEffective = corrected2.effective;
          auditPrior = corrected2.priorValue;
          auditValue = { correction: corrected2.value, earliestAffected: corrected2.earliestAffected };
          break;
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
      if (event.replacement.type === "lineup.committed" || event.replacement.type === "availability.changed" && event.sourceRevision !== void 0) {
        const corrected = reprojectParticipation(state, event, validateLineup);
        state = corrected.state;
        auditEffective = corrected.effective;
        auditPrior = corrected.priorValue;
        auditValue = { correction: corrected.value, earliestAffected: corrected.earliestAffected };
        break;
      }
      if (state.eventHistory?.some((item) => item.id === event.targetEventId)) throw new Error("This historical interval or half transition needs explicit reconciliation of the affected play. No recorded minutes were changed.");
      throw new Error("Correction target was not found in this match history.");
    }
    case "event.voided": {
      if (!event.reason.trim() || event.reason.length > 500) throw new Error("Voiding an event needs an audited reason of 1\u2013500 characters.");
      const goal = state.goals?.find((item) => item.eventId === event.targetEventId || item.latestEventId === event.targetEventId);
      if (!goal) {
        if (state.eventHistory?.some((item) => item.id === event.targetEventId && (item.type === "lineup.committed" || item.type === "availability.changed" || item.type === "event.corrected"))) {
          const corrected = reprojectParticipation(state, event, validateLineup);
          state = corrected.state;
          auditEffective = corrected.effective;
          auditPrior = corrected.priorValue;
          auditValue = { correction: corrected.value, earliestAffected: corrected.earliestAffected };
          break;
        }
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
      integer2(event.halfActiveMs, "Corrected active half time");
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
  state = updatePolicyPositionMode(state, previous.revision + 1);
  const audit = {
    eventId: event.id,
    type: event.type,
    revision: previous.revision + 1,
    recordedAtMs: event.sample.wallTimeMs,
    actorId: event.actorId ?? null,
    effective: auditEffective === void 0 ? state.half === 0 ? null : effectiveTime(state) : auditEffective,
    targetEventId: "targetEventId" in event ? event.targetEventId : null,
    reason: "lateEntryReason" in event && event.lateEntryReason?.trim() ? event.lateEntryReason : "reason" in event ? event.reason ?? null : null,
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
  integer2(actualMs, "Actual playing time");
  const actual = BigInt(actualMs);
  return actual * target.lower.denominator >= target.lower.numerator && actual * target.upper.denominator <= target.upper.numerator;
}
function calculateTargets(intervals, allPlayerIds = []) {
  const totals = new Map(allPlayerIds.map((id9) => [id9, rational(0n)]));
  for (const interval of intervals) {
    integer2(interval.durationMs, "Target interval duration");
    integer2(interval.pitchPlaces, "Target pitch capacity");
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

// packages/application/src/match-plans.ts
var copy = (value) => JSON.parse(JSON.stringify(value));
function assert(value, message) {
  if (!value) throw new Error(message);
}
function shape(value, keys2) {
  assert(
    value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => keys2.includes(key)),
    "Match-plan data contains unsupported fields."
  );
}
function required(value, maximum, label) {
  assert(
    typeof value === "string" && value.trim() && value.trim().length <= maximum && !/[\u0000-\u001f\u007f]/.test(value),
    `${label} is required and must be at most ${maximum} characters.`
  );
  return value.trim();
}
var canonical2 = (value) => Array.isArray(value) ? `[${value.map(canonical2).join(",")}]` : value && typeof value === "object" ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical2(item)}`).join(",")}}` : JSON.stringify(value);
function keeper(profile) {
  return profile.eligiblePositions.includes("GK") && ["GK"].includes(profile.preferences[0]) || profile.eligiblePositions.includes("GK") && profile.preferences[1] === "GK";
}
function latestMatchPlans(state) {
  const map = /* @__PURE__ */ new Map();
  for (const plan of state.matchPlans ?? [])
    if (!map.has(plan.id) || map.get(plan.id).version < plan.version)
      map.set(plan.id, plan);
  return [...map.values()].filter(
    (plan) => plan.teamId === state.team.id && plan.seasonId === state.activeSeasonId
  ).map(copy);
}
function validateMatchPlanSettings(settings) {
  shape(settings, ["payload", "applicability", "softPreferences"]);
  shape(settings.payload, [
    "keeperMode",
    "fixedKeeperPlayerSeasonId",
    "minimumStintMs",
    "batchLimit",
    "scoreLeadThreshold",
    "returnToNormalEnabled"
  ]);
  shape(settings.applicability, ["minimumStint", "batchLimit", "q07"]);
  shape(settings.softPreferences, ["halfBufferFraction"]);
  const p = settings.payload;
  assert(
    ["sole_fixed", "common_pool"].includes(p.keeperMode) && (p.fixedKeeperPlayerSeasonId === null || typeof p.fixedKeeperPlayerSeasonId === "string" && p.fixedKeeperPlayerSeasonId.length > 0),
    "Choose a known keeper proposal."
  );
  assert(
    p.keeperMode === "sole_fixed" === (p.fixedKeeperPlayerSeasonId !== null),
    "Fixed keeper identity must agree with the keeper proposal."
  );
  assert(
    Number.isSafeInteger(p.minimumStintMs) && p.minimumStintMs >= 0 && Number.isSafeInteger(p.batchLimit) && p.batchLimit >= 1 && p.batchLimit <= 11 && Number.isSafeInteger(p.scoreLeadThreshold) && p.scoreLeadThreshold >= 1 && typeof p.returnToNormalEnabled === "boolean",
    "Review minimum spell, batch preference, threshold and explicit return choice."
  );
  assert(
    settings.applicability.minimumStint === "soft_preference" && settings.applicability.batchLimit === "soft_preference" && settings.applicability.q07 === "unapproved",
    "A saved plan cannot approve Q07 or convert preferences into hard rules."
  );
  assert(
    Number.isFinite(settings.softPreferences.halfBufferFraction) && settings.softPreferences.halfBufferFraction >= 0 && settings.softPreferences.halfBufferFraction <= 0.49,
    "Half buffer must be a fraction between zero and 0.49."
  );
}
function validateProposal(state, fixture, formation, allocations, settings) {
  assert(
    formation.format === fixture.format && formation.slots.length === fixture.format && formation.slots.filter((slot) => slot.position === "GK").length === 1,
    "The saved formation must match this fixture format and include one goalkeeper."
  );
  assert(
    Array.isArray(allocations) && allocations.length === fixture.format && new Set(allocations.map((row) => row.slotId)).size === fixture.format && new Set(allocations.map((row) => row.playerId)).size === fixture.format,
    "Review one distinct player for every saved place."
  );
  const selected = fixture.selectedProfileIds.map(
    (id9) => state.profiles.find(
      (profile) => profile.id === id9 && profile.seasonId === fixture.seasonId && profile.active
    )
  ).filter(
    (profile) => Boolean(profile)
  );
  for (const allocation of allocations) {
    shape(allocation, ["slotId", "position", "playerId"]);
    const slot = formation.slots.find(
      (value) => value.id === allocation.slotId
    );
    const profile = selected.find(
      (value) => value.playerId === allocation.playerId
    );
    assert(
      slot && slot.position === allocation.position && profile && profile.eligiblePositions.includes(slot.position),
      "A proposed player is missing, unselected, archived or no longer eligible. Review the squad and places first."
    );
    if (slot.position === "GK")
      assert(
        keeper(profile),
        "The proposed goalkeeper must remain a first- or second-choice eligible keeper."
      );
  }
  validateMatchPlanSettings(settings);
  const qualifying = selected.filter(keeper);
  assert(
    settings.payload.minimumStintMs <= fixture.plannedHalfDurationMs,
    "The preferred spell exceeds this fixture\u2019s planned half."
  );
  assert(
    settings.payload.keeperMode === "sole_fixed" ? qualifying.length === 1 && qualifying[0].playerId === settings.payload.fixedKeeperPlayerSeasonId && allocations.some(
      (row) => row.position === "GK" && row.playerId === qualifying[0].playerId
    ) : qualifying.length >= 2,
    "The saved keeper proposal does not match this selected squad. Review current keeper coverage; no exemption is inferred."
  );
}
function saveMatchPlan(state, input) {
  shape(input, [
    "planId",
    "expectedPlanVersion",
    "name",
    "description",
    "sourceFixtureId",
    "sourceSnapshotId",
    "allocations",
    "settings"
  ]);
  const fixture = state.fixtures.find(
    (row) => row.id === input.sourceFixtureId && row.seasonId === state.activeSeasonId
  );
  const snapshot = state.snapshots.find(
    (row) => row.id === input.sourceSnapshotId && row.fixtureId === input.sourceFixtureId
  );
  assert(
    fixture && snapshot && snapshot.seasonId === state.activeSeasonId,
    "Review an explicit saved preparation for this team and season."
  );
  const latestSnapshot = state.snapshots.filter((row) => row.fixtureId === fixture.id).at(-1);
  const {
    status: _status,
    selectedProfileIds: _selection,
    responses: _responses,
    attendance: _attendance,
    history: _history,
    matchPlanDraft: _draft,
    ...fixtureDetails
  } = fixture;
  assert(
    latestSnapshot?.id === snapshot.id && canonical2(snapshot.fixture) === canonical2(fixtureDetails) && canonical2(snapshot.selectedPlayerIds.slice().sort()) === canonical2(
      fixture.selectedProfileIds.map(
        (id9) => state.profiles.find((profile) => profile.id === id9)?.playerId
      ).sort()
    ),
    "Source preparation changed. Prepare and review its latest snapshot before saving a plan."
  );
  const previous = latestMatchPlans(state).find(
    (row) => row.id === input.planId
  );
  assert(
    input.expectedPlanVersion === (previous?.version ?? 0),
    "The reusable plan changed. Refresh and review its current version."
  );
  validateProposal(
    state,
    fixture,
    snapshot.formation,
    input.allocations,
    input.settings
  );
  assert(
    typeof input.description === "string" && input.description.length <= 300 && !/[\u0000-\u001f\u007f]/.test(input.description),
    "Use a short non-sensitive description, at most300 characters."
  );
  return {
    id: required(input.planId, 150, "Plan identity"),
    version: (previous?.version ?? 0) + 1,
    teamId: state.team.id,
    seasonId: fixture.seasonId,
    name: required(input.name, 40, "Plan name"),
    description: input.description.trim(),
    sourceFixtureId: fixture.id,
    sourceSnapshotId: snapshot.id,
    sourcePreparedRevision: snapshot.preparedRevision,
    formation: copy(snapshot.formation),
    allocations: copy(input.allocations),
    settings: copy(input.settings)
  };
}
function today(now) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(now));
}
function previewMatchPlan(state, planId, fixtureId, context = {}) {
  const plan = latestMatchPlans(state).find((row) => row.id === planId);
  const fixture = state.fixtures.find(
    (row) => row.id === fixtureId && row.seasonId === state.activeSeasonId
  );
  const issues = [];
  try {
    assert(
      plan && fixture,
      "Choose an existing plan and target fixture in this team and season."
    );
    assert(
      fixture.id !== plan.sourceFixtureId,
      "Choose another fixture; saving a template never overwrites its source."
    );
    assert(
      fixture.status === "scheduled" && fixture.playedDate >= today(context.nowMs ?? Date.now()) && !context.protectedFixtureIds?.includes(fixture.id),
      "Only a prospective, unrecorded and unclaimed fixture can receive a match plan."
    );
    validateProposal(
      state,
      fixture,
      plan.formation,
      plan.allocations,
      plan.settings
    );
  } catch (error) {
    issues.push(
      error instanceof Error ? error.message : "This plan is not applicable."
    );
  }
  const previewKey = plan && fixture ? canonical2([
    state.revision,
    plan,
    fixture,
    state.profiles.filter(
      (profile) => fixture.selectedProfileIds.includes(profile.id)
    ).map((profile) => [
      profile.id,
      profile.playerId,
      profile.active,
      profile.eligiblePositions,
      profile.preferences
    ])
  ]) : "";
  return {
    ready: issues.length === 0,
    issues,
    previewKey,
    plan: plan ? copy(plan) : null,
    fixture: fixture ? copy(fixture) : null
  };
}
function applyMatchPlan(state, input, context = {}) {
  shape(input, ["planId", "planVersion", "fixtureId", "previewKey", "confirm"]);
  const preview = previewMatchPlan(
    state,
    input.planId,
    input.fixtureId,
    context
  );
  assert(
    input.confirm === true && preview.ready && preview.plan && input.planVersion === preview.plan.version && input.previewKey === preview.previewKey,
    preview.issues[0] ?? "The preview or plan changed. Review this fixture again before explicitly confirming."
  );
  const plan = preview.plan;
  return {
    templateId: plan.id,
    templateVersion: plan.version,
    appliedRevision: state.revision + 1,
    formation: {
      ...copy(plan.formation),
      id: `match-plan:${plan.id}:${plan.version}`,
      name: plan.name
    },
    allocations: copy(plan.allocations),
    settings: copy(plan.settings)
  };
}
function validateFixtureMatchPlan(state, fixture) {
  if (fixture.matchPlanDraft)
    validateProposal(
      state,
      fixture,
      fixture.matchPlanDraft.formation,
      fixture.matchPlanDraft.allocations,
      fixture.matchPlanDraft.settings
    );
}

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
function requireThat2(condition, message) {
  if (!condition) throw new Error(message);
}
var clone = (value) => JSON.parse(JSON.stringify(value));
function text(value, label, maximum = 80) {
  requireThat2(
    typeof value === "string" && value.trim().length > 0 && value.trim().length <= maximum,
    `${label} is required and must be at most ${maximum} characters.`
  );
  return value.trim();
}
function canonical3(value) {
  if (Array.isArray(value)) return `[${value.map(canonical3).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical3(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function validDate(value) {
  const date = /* @__PURE__ */ new Date(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validTime3(value) {
  return value === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
function validateFormat(format2) {
  requireThat2(
    Number.isInteger(format2) && format2 >= 5 && format2 <= 11,
    "Choose a format from five to eleven players."
  );
}
function validateHalf(duration2) {
  requireThat2(
    Number.isSafeInteger(duration2) && duration2 > 0 && duration2 % 1e3 === 0,
    "Each planned half must be a positive whole number of seconds."
  );
}
function validateLogo(logo) {
  requireThat2(
    logo === null || ["roundel", "shield", "ball"].includes(logo),
    "Choose one of the original fictional badges."
  );
}
function activeSeason(state, seasonId) {
  const season = state.seasons.find((item) => item.id === seasonId);
  requireThat2(season, "Season not found.");
  requireThat2(
    seasonId === state.activeSeasonId,
    "Past seasons are read-only here. Their records are retained unchanged."
  );
  return season;
}
function dateInSeason(state, seasonId, date) {
  const season = activeSeason(state, seasonId);
  requireThat2(
    validDate(date) && date >= season.startDate && date <= season.endDate,
    "Choose a valid date within the selected September-to-August season."
  );
}
function checkProfile(state, profileId, seasonId) {
  const profile = state.profiles.find(
    (item) => item.id === profileId && item.seasonId === seasonId && item.active
  );
  requireThat2(profile, "Choose an active player from this team and season.");
  return profile;
}
function validResponse(value) {
  requireThat2(
    ["available", "unavailable", "unsure", "no_reply"].includes(value),
    "Choose an availability response."
  );
}
function validAttendance(value) {
  requireThat2(
    ["present", "absent", "not_recorded"].includes(value),
    "Choose Present, Absent or Not recorded."
  );
}
function unique2(ids) {
  requireThat2(
    new Set(ids).size === ids.length,
    "Each player or slot can appear only once."
  );
}
function validateTraining(state, training) {
  text(training.id, "Training identity", 150);
  dateInSeason(state, training.seasonId, training.date);
  requireThat2(validTime3(training.time) && training.time !== null, "Use a 24-hour HH:MM training time.");
  requireThat2(typeof training.venue === "string" && training.venue.length <= 200, "Use a training venue of at most 200 characters.");
  requireThat2(training.recurrenceGroupId === null || typeof training.recurrenceGroupId === "string" && training.recurrenceGroupId.trim().length > 0 && training.recurrenceGroupId.length <= 150, "Use a valid training series identity.");
  requireThat2(Array.isArray(training.expectedProfileIds), "Choose the expected players explicitly.");
  unique2(training.expectedProfileIds);
  training.expectedProfileIds.forEach((id9) => checkProfile(state, id9, training.seasonId));
}
function seasonBounds(startYear) {
  requireThat2(
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
function defaultFormation(format2) {
  validateFormat(format2);
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
    id: `formation-${format2}`,
    name: `${format2}-a-side`,
    format: format2,
    version: 1,
    slots: roles[format2].map((position) => {
      const ordinal = count[position] = (count[position] ?? 0) + 1;
      const peers = roles[format2].filter((role) => row(role) === row(position));
      const index = roles[format2].slice(
        0,
        roles[format2].findIndex(
          (role, i) => role === position && roles[format2].slice(0, i + 1).filter((p) => p === position).length === ordinal
        )
      ).filter((role) => row(role) === row(position)).length;
      return {
        id: `${position.toLowerCase()}-${ordinal}`,
        position,
        label: `${position}${roles[format2].filter((role) => role === position).length > 1 ? ordinal : ""}`,
        x: (index + 1) / (peers.length + 1),
        y: row(position)
      };
    })
  };
}
function prepareFixtureSnapshot(state, fixtureId, formationId) {
  const fixture = state.fixtures.find((item) => item.id === fixtureId);
  requireThat2(
    fixture && fixture.status === "scheduled",
    "Only a scheduled match can be prepared."
  );
  activeSeason(state, fixture.seasonId);
  if (fixture.matchPlanDraft && fixture.matchPlanDraft.formation.id === formationId) validateFixtureMatchPlan(state, fixture);
  const formation = fixture.matchPlanDraft && fixture.matchPlanDraft.formation.id === formationId ? fixture.matchPlanDraft.formation : state.formations.find(
    (item) => item.id === (formationId ?? `formation-${fixture.format}`)
  );
  requireThat2(
    formation && formation.format === fixture.format,
    "Choose a saved formation for this match format."
  );
  requireThat2(
    fixture.selectedProfileIds.length >= fixture.format,
    "Select enough players for the match format."
  );
  const profiles = fixture.selectedProfileIds.map(
    (id9) => checkProfile(state, id9, fixture.seasonId)
  );
  requireThat2(
    profiles.some((profile) => goalkeeperChoice(profile) > 0),
    "Select a first- or second-choice eligible goalkeeper."
  );
  const {
    responses: _responses,
    attendance: _attendance,
    selectedProfileIds: _selected,
    history: _history,
    status: _status,
    matchPlanDraft: _planDraft,
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
    ),
    ...fixture.matchPlanDraft?.formation.id === formation.id ? { matchPlanDraft: fixture.matchPlanDraft } : {}
  });
}
function saveProfile(state, source2) {
  const profile = clone(source2);
  activeSeason(state, profile.seasonId);
  text(profile.id, "Profile identity", 150);
  text(profile.playerId, "Player identity", 150);
  const existing = state.profiles.find((item) => item.id === profile.id);
  if (existing)
    requireThat2(
      existing.playerId === profile.playerId && existing.seasonId === profile.seasonId,
      "Profile identity and season cannot be reassigned."
    );
  requireThat2(
    !state.profiles.some(
      (item) => item.id !== profile.id && item.seasonId === profile.seasonId && item.playerId === profile.playerId
    ),
    "That player already has a profile in this season."
  );
  profile.displayName = text(profile.displayName, "Display name", 60);
  requireThat2(
    typeof profile.initials === "string" && /^[A-Za-z0-9]{1,2}$/.test(profile.initials),
    "Use one or two letters or digits for the pitch label."
  );
  profile.initials = profile.initials.toUpperCase();
  requireThat2(
    profile.shirtNumber === null || Number.isInteger(profile.shirtNumber) && profile.shirtNumber >= 1 && profile.shirtNumber <= 99,
    "Shirt number must be one to 99 or not recorded."
  );
  requireThat2(
    !state.profiles.some(
      (item) => item.id !== profile.id && item.seasonId === profile.seasonId && item.active && profile.active && profile.shirtNumber !== null && item.shirtNumber === profile.shirtNumber
    ),
    "Another active player already has that shirt number."
  );
  requireThat2(
    profile.preferences.length === 3 && new Set(profile.preferences).size === 3 && profile.preferences.every((position) => positionCodes.includes(position)),
    "Choose three different ranked positions."
  );
  requireThat2(
    profile.eligiblePositions.length > 0 && new Set(profile.eligiblePositions).size === profile.eligiblePositions.length && profile.eligiblePositions.every(
      (position) => positionCodes.includes(position)
    ),
    "Choose distinct manager-approved eligible positions."
  );
  requireThat2(
    ["left", "right", "both", "not_recorded"].includes(profile.foot),
    "Choose a preferred foot or Not recorded."
  );
  state.profiles = state.profiles.filter((item) => item.id !== profile.id);
  state.profiles.push(profile);
  return profile;
}
function validateRosterImport(state, profiles) {
  requireThat2(
    Array.isArray(profiles) && profiles.length > 0 && profiles.length <= 200,
    "Import between one and 200 new player profiles."
  );
  const candidate = clone(state);
  return Array.from(profiles).map((profile) => {
    requireThat2(
      profile && typeof profile === "object" && Object.keys(profile).length === 10 && Object.keys(profile).every(
        (key) => [
          "id",
          "playerId",
          "seasonId",
          "displayName",
          "initials",
          "shirtNumber",
          "foot",
          "preferences",
          "eligiblePositions",
          "active"
        ].includes(key)
      ),
      "Use only the documented player profile fields; accounts, contacts and dates of birth cannot be imported."
    );
    requireThat2(
      Array.isArray(profile.preferences) && Array.isArray(profile.eligiblePositions),
      "Provide ranked preferences and explicit eligible positions."
    );
    requireThat2(
      typeof profile.initials === "string" && profile.initials.length >= 1 && profile.initials.length <= 2 && !/[^A-Za-z0-9]/.test(profile.initials),
      "Use one or two letters or digits for the pitch label."
    );
    requireThat2(
      profile.active === true && profile.seasonId === state.activeSeasonId,
      "Import active players into the current season only."
    );
    for (const id9 of [profile.id, profile.playerId])
      requireThat2(
        typeof id9 === "string" && id9.length >= 1 && id9.length <= 150 && !/[^A-Za-z0-9_.:-]/.test(id9),
        "Use a valid opaque player/profile identity of at most 150 characters."
      );
    requireThat2(
      !candidate.profiles.some(
        (existing) => existing.id === profile.id || existing.playerId === profile.playerId
      ),
      "A player or profile identity already exists. Import never merges identities; edit that player separately."
    );
    return saveProfile(candidate, profile);
  });
}
function reducePreparation(previous, command, context = {}) {
  requireThat2(
    command.id && typeof command.id === "string",
    "A stable command identity is required."
  );
  const signature2 = canonical3(command);
  if (previous.appliedCommands[command.id]) {
    requireThat2(
      previous.appliedCommands[command.id] === signature2,
      "This command identity already belongs to different content."
    );
    return previous;
  }
  requireThat2(
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
      requireThat2(
        command.confirmSpectatorRenewal === true,
        "Confirm that spectator access must be renewed explicitly."
      );
      const old = state.seasons.find(
        (item) => item.id === state.activeSeasonId
      );
      requireThat2(
        command.startYear === old.startYear + 1,
        "Rollover creates the immediately following September-to-August season."
      );
      requireThat2(
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
    case "profile.saved":
      saveProfile(state, command.profile);
      break;
    case "roster.imported": {
      requireThat2(
        command.id.length <= 150 && !/[^A-Za-z0-9_.:-]/.test(command.id),
        "Use a valid stable roster import identity."
      );
      requireThat2(
        command.confirmNewPlayers === true,
        "Confirm that every imported row creates a new player; no accounts or access are granted."
      );
      requireThat2(
        Object.keys(command).every(
          (key) => [
            "id",
            "type",
            "expectedRevision",
            "profiles",
            "confirmNewPlayers"
          ].includes(key)
        ),
        "Use the documented roster import command."
      );
      state.profiles.push(...validateRosterImport(state, command.profiles));
      break;
    }
    case "profile.archived": {
      const profile = state.profiles.find(
        (item) => item.id === command.profileId
      );
      requireThat2(profile, "Player profile not found.");
      activeSeason(state, profile.seasonId);
      profile.active = false;
      break;
    }
    case "formation.saved": {
      const formation = clone(command.formation);
      validateFormat(formation.format);
      formation.name = text(formation.name, "Formation name", 40);
      requireThat2(
        formation.slots.length === formation.format && formation.slots.filter((slot) => slot.position === "GK").length === 1,
        "A formation needs the chosen number of slots and exactly one goalkeeper."
      );
      unique2(formation.slots.map((slot) => slot.id));
      for (const slot of formation.slots) {
        requireThat2(
          slot.id.length > 0 && positionCodes.includes(slot.position),
          "Each slot needs an identity and position type."
        );
        slot.label = text(slot.label, "Slot label", 16);
        requireThat2(
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
      requireThat2(
        validTime3(fixture.kickoff) && validTime3(fixture.arrival),
        "Use 24-hour HH:MM times, or leave time not recorded."
      );
      requireThat2(
        ["home", "away"].includes(fixture.homeAway),
        "Choose home or away."
      );
      const existing = state.fixtures.find((item) => item.id === fixture.id);
      if (existing)
        requireThat2(
          existing.seasonId === fixture.seasonId && existing.status !== "cancelled",
          "Cancelled matches must be restored explicitly before rescheduling."
        );
      const status2 = "scheduled";
      const updated = {
        ...fixture,
        status: status2,
        selectedProfileIds: existing?.selectedProfileIds ?? [],
        responses: existing?.responses ?? {},
        attendance: existing?.attendance ?? {},
        ...existing?.matchPlanDraft ? { matchPlanDraft: existing.matchPlanDraft } : {},
        history: [
          ...existing?.history ?? [],
          {
            revision,
            action: existing ? "rescheduled" : "created",
            playedDate: fixture.playedDate,
            kickoff: fixture.kickoff,
            status: status2
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
      requireThat2(fixture, "Match not found.");
      activeSeason(state, fixture.seasonId);
      requireThat2(
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
      requireThat2(fixture, "Match not found.");
      activeSeason(state, fixture.seasonId);
      requireThat2(
        fixture.status === "scheduled",
        "Only a scheduled match can collect responses, selection or attendance."
      );
      if (command.type === "fixture.selection_saved") {
        unique2(command.selectedProfileIds);
        command.selectedProfileIds.forEach(
          (id9) => checkProfile(state, id9, fixture.seasonId)
        );
        fixture.selectedProfileIds = [...command.selectedProfileIds];
      } else {
        checkProfile(state, command.profileId, fixture.seasonId);
        if (command.type === "fixture.response_recorded") {
          validResponse(command.response);
          fixture.responses[command.profileId] = command.response;
        } else {
          validAttendance(command.attendance);
          requireThat2(
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
    case "training.series_created":
    case "training.series_updated":
    case "training.series_cancelled": {
      applyTrainingSeries(state, command, (draft) => validateTraining(state, draft));
      break;
    }
    case "match_plan.saved": {
      const { type: _type, id: _id, expectedRevision: _revision, ...input } = command;
      const plan = saveMatchPlan(state, input);
      state.matchPlans = [...state.matchPlans ?? [], plan];
      break;
    }
    case "match_plan.applied": {
      const { type: _type, id: _id, expectedRevision: _revision, ...input } = command;
      const draft = applyMatchPlan(state, input, context);
      state.fixtures.find((item) => item.id === command.fixtureId).matchPlanDraft = draft;
      break;
    }
    case "match_plan.cleared": {
      const fixture = state.fixtures.find((item) => item.id === command.fixtureId);
      requireThat2(fixture && fixture.seasonId === state.activeSeasonId, "Choose a fixture in the current season.");
      delete fixture.matchPlanDraft;
      break;
    }
    case "training.saved": {
      const training = clone(command.training);
      validateTraining(state, training);
      const existing = state.training.find((item) => item.id === training.id);
      if (existing)
        requireThat2(
          existing.seasonId === training.seasonId && existing.recurrenceGroupId === training.recurrenceGroupId && existing.status === "scheduled",
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
      requireThat2(training, "Training occurrence not found.");
      activeSeason(state, training.seasonId);
      requireThat2(
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
      requireThat2(training, "Training occurrence not found.");
      activeSeason(state, training.seasonId);
      checkProfile(state, command.profileId, training.seasonId);
      requireThat2(
        training.expectedProfileIds.includes(command.profileId),
        "Only expected players belong to this attendance occurrence."
      );
      if (command.type === "training.response_recorded") {
        requireThat2(
          training.status !== "cancelled",
          "Cancelled training cannot collect availability."
        );
        validResponse(command.response);
        training.responses[command.profileId] = command.response;
      } else {
        requireThat2(
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
      (id9) => state.profiles.find((profile) => profile.id === id9)?.playerId
    ).filter((id9) => Boolean(id9)),
    attendance: Object.fromEntries(
      Object.entries(session.attendance).flatMap(([id9, attendance]) => {
        const profile = state.profiles.find((item) => item.id === id9);
        return profile ? [[profile.playerId, attendance]] : [];
      })
    ),
    responses: Object.fromEntries(
      Object.entries(session.responses).flatMap(([id9, response]) => {
        const profile = state.profiles.find((item) => item.id === id9);
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

// packages/application/src/player-preparation.ts
var time = (value) => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
var format = (value) => Number.isInteger(value) && Number(value) >= 5 && Number(value) <= 11;
var half = (value) => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) % 1e3 === 0;
function projectOwnPlayerPreparation(state, profile, seasonId) {
  const season = state.seasons.find((item) => item.id === seasonId);
  if (!season || !profile.active || profile.seasonId !== seasonId || !state.profiles.some(
    (item) => item.id === profile.id && item.playerId === profile.playerId && item.seasonId === seasonId && item.active
  ))
    throw new Error("The authorised own-player preparation is unavailable.");
  return {
    kind: "player-preparation",
    revision: state.revision,
    team: {
      id: state.team.id,
      name: state.team.name,
      ageGroup: state.team.ageGroup
    },
    season: {
      id: season.id,
      label: season.label,
      startYear: season.startYear,
      startDate: season.startDate,
      endDate: season.endDate,
      spectatorRenewalRequired: true
    },
    profile: {
      id: profile.id,
      playerId: profile.playerId,
      seasonId: profile.seasonId,
      displayName: profile.displayName,
      initials: profile.initials,
      shirtNumber: profile.shirtNumber,
      foot: profile.foot,
      preferences: [...profile.preferences],
      eligiblePositions: [...profile.eligiblePositions],
      active: profile.active
    },
    fixtures: state.fixtures.filter((item) => item.seasonId === seasonId).map((item) => ({
      id: item.id,
      opponent: item.opponent,
      playedDate: item.playedDate,
      kickoff: time(item.kickoff) ? item.kickoff : null,
      arrival: time(item.arrival) ? item.arrival : null,
      venue: item.venue,
      homeAway: item.homeAway,
      status: item.status,
      format: format(item.format) ? item.format : null,
      plannedHalfDurationMs: half(item.plannedHalfDurationMs) ? item.plannedHalfDurationMs : null,
      response: item.responses[profile.id] ?? "no_reply",
      selected: item.selectedProfileIds.includes(profile.id),
      attendance: item.attendance[profile.id] ?? "not_recorded"
    })),
    training: state.training.filter((item) => item.seasonId === seasonId).map((item) => ({
      id: item.id,
      date: item.date,
      time: time(item.time) ? item.time : null,
      venue: item.venue,
      status: item.status,
      expected: item.expectedProfileIds.includes(profile.id),
      response: item.responses[profile.id] ?? "no_reply",
      attendance: item.attendance[profile.id] ?? "not_recorded"
    }))
  };
}

// apps/api/src/offline-bundle.ts
import { randomUUID } from "node:crypto";

// node_modules/.pnpm/@noble+hashes@2.4.0/node_modules/@noble/hashes/_u64.js
var fromNumH = (n) => n / 2 ** 32 | 0;
var fromNumL = (n) => n >>> 0;
function setU64FromNum(view, byteOffset, n, isLE) {
  const h = fromNumH(n);
  const l = fromNumL(n);
  view.setUint32(byteOffset, isLE ? l : h, isLE);
  view.setUint32(byteOffset + 4, isLE ? h : l, isLE);
}

// node_modules/.pnpm/@noble+hashes@2.4.0/node_modules/@noble/hashes/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
}
var atitle = (title) => title ? `"${title}" ` : "";
function anumber(n, title = "") {
  if (typeof n !== "number")
    throw new TypeError(atitle(title) + "expected number, got " + typeof n);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(atitle(title) + "expected integer >= 0, got " + n);
  return n;
}
function abytes(value, length, title = "") {
  if (isBytes(value) && (length === void 0 || value.length === length))
    return value;
  if (length !== void 0)
    anumber(length, "length");
  const bytes = isBytes(value);
  const ofLen = length !== void 0 ? ` of length ${length}` : "";
  const got = bytes ? `length=${value.length}` : `type=${typeof value}`;
  const message = atitle(title) + "expected Uint8Array" + ofLen + ", got " + got;
  if (!bytes)
    throw new TypeError(message);
  throw new RangeError(message);
}
var aobject = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError((label === "object" ? "" : `"${label}" `) + "expected object, got type=" + typeof value);
};
var aopts = (value, label) => {
  aobject(value, label);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw new TypeError(`"${label}" expected plain object`);
  if (Object.hasOwn(value, "__proto__"))
    throw new TypeError(`"${label}.__proto__" is not allowed`);
};
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("hash was destroyed");
  if (checkFinished && instance.finished)
    throw new Error("digest() was already called");
}
function aoutput(out, instance) {
  abytes(out, void 0, "output");
  const min = instance.outputLen;
  if (!(out.length >= min)) {
    throw new RangeError('"output" expected length >= ' + min);
  }
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
function checkOpts(defaults, opts, title = "opts") {
  aopts(defaults, "defaults");
  if (opts !== void 0)
    aopts(opts, title);
  const merged = Object.assign(/* @__PURE__ */ Object.create(null), defaults, opts);
  return merged;
}
function createHasher(hashCons, info = {}) {
  if (typeof hashCons !== "function")
    throw new TypeError('"hashCons" expected function, got type=' + typeof hashCons);
  info = checkOpts({}, info, "info");
  const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
  const tmp = hashCons(void 0);
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.canXOF = tmp.canXOF;
  hashC.create = (opts) => hashCons(opts);
  Object.assign(hashC, info);
  return Object.freeze(hashC);
}
var oidNist = (suffix) => ({
  // Current NIST hashAlgs suffixes used here fit in one DER subidentifier octet.
  // Larger suffix values would need base-128 OID encoding and a different length byte.
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, suffix])
});

// node_modules/.pnpm/@noble+hashes@2.4.0/node_modules/@noble/hashes/_md.js
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD = class {
  blockLen;
  outputLen;
  canXOF = false;
  padOffset;
  isLE;
  // For partial updates less than block size
  buffer;
  view;
  finished = false;
  length = 0;
  pos = 0;
  destroyed = false;
  constructor(blockLen, outputLen, padOffset, isLE) {
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    abytes(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    let processed = false;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        processed = true;
        continue;
      }
      buffer.set(pos === 0 && take === len ? data : data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
        processed = true;
      }
    }
    this.length += data.length;
    if (processed)
      this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    buffer.fill(0, pos);
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      buffer.fill(0);
    }
    setU64FromNum(view, blockLen - 8, this.length * 8, isLE);
    this.process(view, 0);
    this.roundClean();
    const oview = out === buffer ? view : createView(out);
    const len = this.outputLen;
    const outLen = len / 4;
    const state = this.get();
    if (len % 4 || outLen > state.length)
      throw new Error("invalid outputLen");
    for (let i = 0; i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneIntoMeta(to) {
    const { buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (pos)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);

// node_modules/.pnpm/@noble+hashes@2.4.0/node_modules/@noble/hashes/sha2.js
var SHA256_K = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
var SHA2_32B = class extends HashMD {
  // We cannot use array here since array allows indexing by variable
  // which means optimizer/compiler cannot use registers.
  // Numeric initializers matter: starting the fields as `undefined` changes
  // V8's field representation and makes sha256 3x slower (measured).
  A = 0;
  B = 0;
  C = 0;
  D = 0;
  E = 0;
  F = 0;
  G = 0;
  H = 0;
  constructor(outputLen, IV) {
    super(64, outputLen, 8, false);
    this.A = IV[0] | 0;
    this.B = IV[1] | 0;
    this.C = IV[2] | 0;
    this.D = IV[3] | 0;
    this.E = IV[4] | 0;
    this.F = IV[5] | 0;
    this.G = IV[6] | 0;
    this.H = IV[7] | 0;
  }
  get() {
    const { A, B, C, D, E, F, G, H } = this;
    return [A, B, C, D, E, F, G, H];
  }
  // prettier-ignore
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G | 0;
    this.H = H | 0;
  }
  _cloneInto(to) {
    (to ||= new this.constructor()).set(...this.get());
    return this._cloneIntoMeta(to);
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4)
      SHA256_W[i] = view.getUint32(offset, false);
    for (let i = 16; i < 64; i++) {
      const W15 = SHA256_W[i - 15];
      const W2 = SHA256_W[i - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let i = 0; i < 64; i++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma0 + Maj(A, B, C) | 0;
      H = G;
      G = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C = C + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G = G + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C, D, E, F, G, H);
  }
  roundClean() {
    clean(SHA256_W);
  }
  destroy() {
    this.destroyed = true;
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean(this.buffer);
  }
};
var _SHA256 = class extends SHA2_32B {
  constructor() {
    super(32, SHA256_IV);
  }
};
var sha256 = /* @__PURE__ */ createHasher(
  () => new _SHA256(),
  /* @__PURE__ */ oidNist(1)
);

// packages/application/src/offline-bundle.ts
var OFFLINE_SNAPSHOT_SCHEMA = 1;
var OFFLINE_CHECKSUM_SERIALIZATION = "longball.canonical-json/1";
var MAX_OFFLINE_EVENTS = 1e4;
function* canonicalTokens(value) {
  const ancestors = /* @__PURE__ */ new Set();
  function* encode(input, depth) {
    if (depth > 100) throw new Error("Offline snapshot nesting exceeds the supported bound.");
    if (input === null || typeof input === "string" || typeof input === "boolean") {
      yield JSON.stringify(input);
      return;
    }
    if (typeof input === "number" && Number.isFinite(input)) {
      yield JSON.stringify(input);
      return;
    }
    if (typeof input !== "object" || !input || ancestors.has(input) || ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(input))) throw new Error("Offline snapshot must contain finite JSON values only.");
    ancestors.add(input);
    try {
      if (Object.getOwnPropertySymbols(input).length) throw new Error("Offline snapshot cannot contain symbolic fields.");
      const descriptors = Object.getOwnPropertyDescriptors(input);
      if (Array.isArray(input)) {
        if (Object.keys(input).length !== input.length || Object.entries(descriptors).some(([key, item]) => key !== "length" && (!("value" in item) || !item.enumerable)) || Array.from({ length: input.length }, (_, index) => index).some((index) => !Object.hasOwn(input, index))) throw new Error("Offline snapshot arrays must be dense JSON arrays.");
        yield "[";
        for (let index = 0; index < input.length; index++) {
          if (index) yield ",";
          yield* encode(input[index], depth + 1);
        }
        yield "]";
        return;
      }
      if (Object.values(descriptors).some((item) => !("value" in item) || !item.enumerable)) throw new Error("Offline snapshot cannot contain accessors or hidden fields.");
      yield "{";
      let separator = "";
      for (const key of Object.keys(input).sort()) {
        yield separator;
        separator = ",";
        yield JSON.stringify(key);
        yield ":";
        yield* encode(descriptors[key].value, depth + 1);
      }
      yield "}";
    } finally {
      ancestors.delete(input);
    }
  }
  yield* encode(value, 0);
}
function canonicalOfflineJson(value) {
  return Array.from(canonicalTokens(value)).join("");
}
function offlineUtf8(value) {
  let length = 0;
  for (const character of value) {
    const code = character.codePointAt(0);
    length += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code < 128) bytes[offset++] = code;
    else if (code < 2048) {
      bytes[offset++] = 192 | code >> 6;
      bytes[offset++] = 128 | code & 63;
    } else if (code < 65536) {
      bytes[offset++] = 224 | code >> 12;
      bytes[offset++] = 128 | code >> 6 & 63;
      bytes[offset++] = 128 | code & 63;
    } else {
      bytes[offset++] = 240 | code >> 18;
      bytes[offset++] = 128 | code >> 12 & 63;
      bytes[offset++] = 128 | code >> 6 & 63;
      bytes[offset++] = 128 | code & 63;
    }
  }
  return bytes;
}
function offlineChecksum(payload) {
  const hash6 = sha256.create();
  let chunk = "";
  for (const token of canonicalTokens(payload)) {
    chunk += token;
    if (chunk.length >= 16384) {
      hash6.update(offlineUtf8(chunk));
      chunk = "";
    }
  }
  if (chunk) hash6.update(offlineUtf8(chunk));
  return Array.from(hash6.digest(), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function sealOfflineSnapshot(payload) {
  const unsigned = { ...payload };
  delete unsigned.checksumSha256;
  return { ...unsigned, checksumSha256: offlineChecksum(unsigned) };
}
var natural = (value) => Number.isSafeInteger(value) && Number(value) >= 0;
var identifier = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,150}$/.test(value);
var iso = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
var equal = (left, right) => canonicalOfflineJson(left) === canonicalOfflineJson(right);
var only = (value, fields8) => Object.keys(value).every((key) => fields8.includes(key));
function assertOfflineSnapshot(download, scope) {
  const fail8 = () => {
    throw new Error("Offline snapshot is incomplete, inconsistent or unsupported. Existing journal retained; download a fresh verified bundle.");
  };
  if (!download || download.snapshotSchemaVersion !== OFFLINE_SNAPSHOT_SCHEMA || download.checksumSerialization !== OFFLINE_CHECKSUM_SERIALIZATION || !identifier(download.bundleId) || !identifier(download.teamId) || !identifier(download.seasonId) || scope.teamId !== void 0 && scope.teamId !== download.teamId || scope.seasonId !== void 0 && scope.seasonId !== download.seasonId || download.deviceId !== scope.deviceId || download.matchId !== scope.matchId || !iso(download.downloadedAt) || !/^[0-9a-f]{64}$/.test(download.checksumSha256 ?? "")) fail8();
  if (!only(download, ["contractVersion", "schemaVersion", "engineVersion", "bundleId", "snapshotSchemaVersion", "checksumSerialization", "checksumSha256", "matchId", "teamId", "seasonId", "deviceId", "state", "acceptedRevision", "deviceCheckpoint", "controller", "publication", "acceptedEvents", "controllerTransitions", "downloadedAt", "clockAnchor", "syntheticOnly"]) || download.controller && !only(download.controller, ["epoch", "account_id", "device_id", "frozen"])) fail8();
  if (!Array.isArray(download.acceptedEvents) || !Array.isArray(download.controllerTransitions) || download.acceptedEvents.length > MAX_OFFLINE_EVENTS || download.controllerTransitions.length > MAX_OFFLINE_EVENTS) fail8();
  const { checksumSha256, ...payload } = download;
  if (offlineChecksum(payload) !== checksumSha256) fail8();
  const state = download.state;
  if (!state?.config || state.config.matchId !== scope.matchId || !natural(state.revision) || state.revision !== download.acceptedRevision || !Array.isArray(state.config.players) || state.config.players.length > 100 || !Array.isArray(state.config.selectedPlayerIds) || state.config.selectedPlayerIds.length > 100 || new Set(state.config.players.map((player) => player.id)).size !== state.config.players.length || state.config.fixture && (state.config.fixture.teamId !== download.teamId || state.config.fixture.seasonId !== download.seasonId)) fail8();
  if (!only(state.config, ["matchId", "players", "selectedPlayerIds", "pitchPlaces", "plannedHalfDurationMs", "fixedKeeperId", "initialPolicyProposal", "initialLineupProposal", "initialAttendance", "slots", "fixture", "profileSnapshot"]) || state.config.players.some((player) => !only(player, ["id", "displayName", "goalkeeperChoice", "positionPreferences", "profileVersion", "available"])) || state.config.profileSnapshot?.some((profile) => !only(profile, ["playerId", "preferences", "eligiblePositions", "initials"]))) fail8();
  if (!download.publication || !Object.hasOwn(download.publication, "fixtureClass") || !Object.hasOwn(download.publication, "classificationVersion") || !Object.hasOwn(download.publication, "resultPolicy") || !download.publication.sharingPolicy || typeof download.publication.sharingPolicy.shareScores !== "boolean" || typeof download.publication.sharingPolicy.shareDerivedResults !== "boolean") fail8();
  if (!Array.isArray(download.acceptedEvents) || !Array.isArray(download.controllerTransitions) || download.acceptedEvents.length > MAX_OFFLINE_EVENTS || download.controllerTransitions.length > MAX_OFFLINE_EVENTS || download.acceptedEvents.length !== state.revision) fail8();
  const ids = /* @__PURE__ */ new Set();
  for (const [index, record2] of download.acceptedEvents.entries()) {
    const event = record2.event;
    if (record2.serverSequence !== index + 1 || !iso(record2.receivedAt) || !event || event.matchId !== scope.matchId || event.baseRevision !== index || !identifier(event.eventId) || !identifier(event.deviceId) || !natural(event.clientSequence) || event.clientSequence < 1 || !natural(event.controllerEpoch) || event.controllerEpoch < 1 || !event.engineVersion || event.command?.id !== event.eventId || ids.has(event.eventId)) fail8();
    ids.add(event.eventId);
  }
  if (state.eventHistory && (state.eventHistory.length !== download.acceptedEvents.length || !state.eventHistory.every((event, index) => event.id === download.acceptedEvents[index].event.eventId && equal({ ...download.acceptedEvents[index].event.command, ...event.actorId === void 0 ? {} : { actorId: event.actorId } }, event)))) fail8();
  const checkpoint = download.deviceCheckpoint;
  if (!checkpoint || !natural(checkpoint.clientSequence) || !(checkpoint.previousEventId === null || identifier(checkpoint.previousEventId)) || checkpoint.clientSequence === 0 !== (checkpoint.previousEventId === null)) fail8();
  for (const record2 of download.acceptedEvents) if (record2.event.deviceId === scope.deviceId && record2.event.clientSequence > checkpoint.clientSequence) fail8();
  for (const transition of download.controllerTransitions) if (!identifier(transition.id) || !natural(transition.epoch) || transition.epoch < 1 || !identifier(transition.actorId) || !identifier(transition.toDevice) || !(transition.fromDevice === null || identifier(transition.fromDevice)) || !iso(transition.createdAt) || typeof transition.kind !== "string" || !(transition.reason === null || typeof transition.reason === "string")) fail8();
  if (!download.clockAnchor || download.clockAnchor.serverTime !== download.downloadedAt || download.clockAnchor.quality !== "observation_only" || download.clockAnchor.continuousMappingEstablished !== false || typeof download.syntheticOnly !== "boolean") fail8();
}

// apps/api/src/offline-bundle.ts
function offlinePublication(matchId, sharingPolicy, records) {
  const result = records?.results.find((item) => item.id === matchId);
  const policy = result?.publication;
  return {
    fixtureClass: result?.fixtureClass ?? (records?.liveMatch.matchId === matchId ? records.liveMatch.fixtureClass : null),
    classificationVersion: result?.classificationVersion ?? null,
    resultPolicy: policy ? { id: policy.id, version: policy.version, fixtureClass: policy.fixtureClass, confirmed: policy.confirmed, confirmationReference: policy.confirmationReference, allowedRoles: [...policy.allowedRoles] } : null,
    sharingPolicy: { version: sharingPolicy.version, approvedBy: sharingPolicy.approvedBy, approvedAt: sharingPolicy.approvedAt, shareScores: sharingPolicy.shareScores, shareDerivedResults: sharingPolicy.shareDerivedResults }
  };
}
function buildOfflineDownload(input) {
  if (input.events.length > MAX_OFFLINE_EVENTS || input.transitions.length > MAX_OFFLINE_EVENTS) throw new AccessError("OFFLINE_BUNDLE_UNSUPPORTED", 422, "The pilot requires complete accepted/control history within 10000 records in each stream. Nothing was truncated.");
  const downloadedAt = new Date(input.nowMs).toISOString();
  const controllerTransitions = input.transitions.map((row) => ({ id: row.id, epoch: row.epoch, actorId: row.actor_id, fromDevice: row.from_device, toDevice: row.to_device, kind: row.kind, reason: row.reason, createdAt: new Date(row.created_at).toISOString() }));
  try {
    const bundle = sealOfflineSnapshot({
      contractVersion: "longball.events/1.1",
      schemaVersion: 1,
      engineVersion: ENGINE_VERSION,
      bundleId: randomUUID(),
      snapshotSchemaVersion: OFFLINE_SNAPSHOT_SCHEMA,
      checksumSerialization: OFFLINE_CHECKSUM_SERIALIZATION,
      matchId: input.matchId,
      teamId: input.teamId,
      seasonId: input.seasonId,
      deviceId: input.deviceId,
      state: input.state,
      acceptedRevision: input.state.revision,
      deviceCheckpoint: input.checkpoint,
      controller: input.controller,
      publication: input.publication,
      acceptedEvents: input.events.map((row) => ({ serverSequence: row.revision, receivedAt: new Date(row.received_at).toISOString(), event: JSON.parse(row.envelope_json) })),
      controllerTransitions,
      downloadedAt,
      clockAnchor: { serverTime: downloadedAt, quality: "observation_only", continuousMappingEstablished: false },
      syntheticOnly: input.syntheticOnly
    });
    assertOfflineSnapshot(bundle, input);
    return bundle;
  } catch {
    throw new AccessError("OFFLINE_BUNDLE_UNSUPPORTED", 422, "The complete snapshot failed structural or full-history validation. The previous device bundle remains usable; no partial replacement was returned.");
  }
}

// apps/api/src/store.ts
import { createHash as createHash2, randomBytes, randomUUID as randomUUID2 } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

// apps/api/src/team-privilege-schema.ts
var SQLITE_TEAM_PRIVILEGES_DDL = `
CREATE TABLE team_privilege_states(team_id TEXT PRIMARY KEY REFERENCES teams(id),revision INTEGER NOT NULL CHECK(revision>=0),state_json TEXT NOT NULL CHECK(json_valid(state_json)));
CREATE TABLE team_privilege_decisions(team_id TEXT NOT NULL REFERENCES teams(id),revision INTEGER NOT NULL CHECK(revision>0),command_id TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES accounts(id),target_account_id TEXT NOT NULL REFERENCES accounts(id),privilege TEXT NOT NULL CHECK(privilege IN('uploads','invitations')),suspended INTEGER NOT NULL CHECK(suspended IN(0,1)),reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 80),private_note TEXT CHECK(length(private_note)<=1000),created_at INTEGER NOT NULL,PRIMARY KEY(team_id,revision),UNIQUE(team_id,actor_id,command_id));
INSERT INTO team_privilege_states(team_id,revision,state_json) SELECT id,0,json_object('schemaVersion',1,'teamId',id,'revision',0,'restrictions',json('[]')) FROM teams;
CREATE TRIGGER team_privileges_new_team AFTER INSERT ON teams BEGIN INSERT INTO team_privilege_states(team_id,revision,state_json) VALUES(NEW.id,0,json_object('schemaVersion',1,'teamId',NEW.id,'revision',0,'restrictions',json('[]'))); END;
CREATE TRIGGER team_privilege_state_identity BEFORE UPDATE ON team_privilege_states WHEN NEW.team_id<>OLD.team_id OR NEW.revision<>OLD.revision+1 OR json_extract(NEW.state_json,'$.teamId')<>NEW.team_id OR json_extract(NEW.state_json,'$.revision')<>NEW.revision BEGIN SELECT RAISE(ABORT,'Invalid team privilege revision'); END;
CREATE TRIGGER team_privilege_decision_immutable_update BEFORE UPDATE ON team_privilege_decisions BEGIN SELECT RAISE(ABORT,'Immutable team privilege decision'); END;
CREATE TRIGGER team_privilege_decision_immutable_delete BEFORE DELETE ON team_privilege_decisions BEGIN SELECT RAISE(ABORT,'Immutable team privilege decision'); END;
`;

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

// packages/application/src/records.ts
function clone2(value) {
  return JSON.parse(JSON.stringify(value));
}
function signature(value) {
  if (Array.isArray(value)) return `[${value.map(signature).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== void 0).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${signature(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function nonnegative2(value, label) {
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
    nonnegative2(value.for, "Our score");
    nonnegative2(value.against, "Opposition score");
  }
}
function managerOnlyPublication(fixtureClass) {
  return { id: "unconfirmed-competition-policy", version: 1, fixtureClass, confirmed: false, confirmationReference: null, allowedRoles: [] };
}
function validateInput(state, input) {
  if (!validDate2(input.playedDate) || input.playedDate < state.startsOn || input.playedDate > state.endsOn) throw new Error("Choose a real played date within this team season.");
  if (!input.opponent.trim()) throw new Error("Record the opposition.");
  if (input.recordedKickoff !== null && !validInstant(input.recordedKickoff)) throw new Error("Known kick-off must include its timezone; otherwise leave it not recorded.");
  if (input.sameDayOrder !== null) nonnegative2(input.sameDayOrder, "Same-day order");
  validateScore(input.finalScore);
  validateScore(input.halfTimeScore);
  if (input.halfTimeScore && input.finalScore && (input.halfTimeScore.for > input.finalScore.for || input.halfTimeScore.against > input.finalScore.against)) throw new Error("Half-time goals cannot exceed the final score.");
  if (new Set(input.goals.map((goal) => goal.id)).size !== input.goals.length) throw new Error("Known goals need distinct identifiers.");
  for (const goal of input.goals) {
    if (!goal.id) throw new Error("A known goal needs an identifier.");
    if (goal.scorerPlayerId && !state.players.some((player) => player.id === goal.scorerPlayerId)) throw new Error("The scorer must belong to this archived team-season roster.");
    if ((goal.beneficiary === "opposition" && !goal.isOwnGoal || goal.beneficiary === "us" && goal.isOwnGoal) && goal.scorerPlayerId !== null) throw new Error("An opposition scorer cannot be credited to one of our players.");
    if (goal.halfElapsedMs !== null) {
      nonnegative2(goal.halfElapsedMs, "Known goal time");
      if (goal.half === null) throw new Error("A known goal time needs its half.");
    }
  }
  if (input.finalScore && (input.goals.filter((goal) => goal.beneficiary === "us").length > input.finalScore.for || input.goals.filter((goal) => goal.beneficiary === "opposition").length > input.finalScore.against)) throw new Error("Known goal attribution cannot exceed the recorded score.");
}
function historicalRecord(state, id9, input, at) {
  validateInput(state, input);
  return {
    ...clone2(input),
    opponent: input.opponent.trim(),
    id: id9,
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
  const previousRecord = state.results.find((record2) => record2.id === match.config.matchId);
  const sameClassification = previousRecord?.fixtureClass === state.liveMatch.fixtureClass;
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
    publication: sameClassification ? clone2(previousRecord.publication) : managerOnlyPublication(state.liveMatch.fixtureClass),
    classificationVersion: previousRecord ? previousRecord.classificationVersion + Number(!sameClassification) : 1,
    selectedPlayerIds: [...match.config.selectedPlayerIds],
    attendance: { ...match.attendance },
    participation: started ? playerMinutes(match, sample).map((player) => {
      const saved = match.config.players.find((item) => item.id === player.playerId);
      const target = targets.find((item) => item.playerId === player.playerId);
      const targetMs = target ? rationalToNumber(target.target) : null;
      const priorEntry = state.results.find((record2) => record2.id === match.config.matchId)?.participation?.find((item) => item.playerId === player.playerId);
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
      if (state.results.some((record2) => record2.id === command.recordId)) throw new Error("This match identifier already exists. Open its correction route.");
      if (!command.acknowledgePossibleDuplicate && state.results.some((record2) => record2.playedDate === command.input.playedDate && record2.opponent.toLowerCase() === command.input.opponent.trim().toLowerCase())) throw new Error("A match against this opponent on this date already exists. Review it or acknowledge that these were separate games.");
      after = historicalRecord(state, command.recordId, command.input, command.at);
      state = { ...state, results: [...state.results, after] };
      reason = "Historical summary entered; unknown detail retained.";
      break;
    }
    case "historical.correct": {
      before = state.results.find((record2) => record2.id === command.recordId) ?? null;
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
      state = { ...state, results: state.results.map((record2) => record2.id === before?.id ? after : record2) };
      reason = command.reason.trim();
      break;
    }
    case "live.archive": {
      if (command.match.status !== "completed" || command.match.recoveryRequired) throw new Error("Finish the match and resolve clock uncertainty before archiving a final participation record.");
      before = state.results.find((record2) => record2.id === command.match.config.matchId) ?? null;
      if (before?.recordMode === "historical_summary") throw new Error("A historical summary already uses this match identifier; explicit reconciliation is required.");
      if (before && ((before.sourceMatchRevision ?? -1) > command.match.revision || before.sourceMatchRevision === command.match.revision && before.fixtureClass === state.liveMatch.fixtureClass)) throw new Error("This match revision is already archived.");
      after = { ...snapshotLiveMatch(state, command.match, command.at), enteredAt: before?.enteredAt ?? command.at, revision: (before?.revision ?? 0) + 1 };
      state = { ...state, results: [...state.results.filter((record2) => record2.id !== after?.id), after] };
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
      before = state.results.find((record2) => record2.id === command.recordId) ?? null;
      if (!before || before.revision !== command.expectedRevision) throw new Error("Review the latest result before changing its publication policy.");
      if (!command.reason.trim() || !command.policy.confirmationReference?.trim() || !command.policy.confirmed) throw new Error("A confirmed competition decision and audit reason are required before sharing.");
      if (before.fixtureClass === "unclassified" || command.policy.fixtureClass !== before.fixtureClass || command.policy.version <= before.publication.version) throw new Error("Classify the fixture and provide a newer policy version that matches its class.");
      after = { ...before, publication: clone2(command.policy), updatedAt: command.at, revision: before.revision + 1 };
      state = { ...state, results: state.results.map((record2) => record2.id === before?.id ? after : record2) };
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
      before = state.results.find((record2) => record2.id === command.recordId) ?? null;
      if (!before || before.revision !== command.expectedRevision) throw new Error("Review the latest archived match before explaining an exception.");
      const item = before.participation?.find((entry) => entry.playerId === command.playerId);
      if (!item?.target || item.target.withinBand) throw new Error("An exception note requires recorded participation outside its target band.");
      if (!command.reason.trim()) throw new Error("Record the reason for this target exception.");
      after = { ...before, participation: before.participation.map((entry) => entry.playerId === command.playerId ? { ...entry, target: { ...entry.target, exceptionReason: command.reason.trim() } } : entry), updatedAt: command.at, revision: before.revision + 1 };
      state = { ...state, results: state.results.map((record2) => record2.id === before?.id ? after : record2) };
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
function canShare(record2, actor) {
  return actor === "manager" || record2.fixtureClass !== "unclassified" && record2.publication.confirmed && Boolean(record2.publication.confirmationReference) && record2.publication.fixtureClass === record2.fixtureClass && record2.publication.allowedRoles.includes(actor);
}
function ordinaryCompleted(record2) {
  return record2.status === "completed" && record2.specialOutcome === "ordinary" && record2.finalScore !== null;
}
function chronological(left, right) {
  return left.playedDate.localeCompare(right.playedDate) || (left.recordedKickoff && right.recordedKickoff ? Date.parse(left.recordedKickoff) - Date.parse(right.recordedKickoff) : (left.sameDayOrder ?? 0) - (right.sameDayOrder ?? 0)) || left.id.localeCompare(right.id);
}
function resultOutcome(score2) {
  return score2.for > score2.against ? "W" : score2.for < score2.against ? "L" : "D";
}
function publicResult(record2) {
  const included = ordinaryCompleted(record2);
  const outcome = included ? resultOutcome(record2.finalScore) : null;
  return {
    id: record2.id,
    playedDate: record2.playedDate,
    recordedKickoff: record2.recordedKickoff,
    sameDayOrder: record2.sameDayOrder,
    opponent: record2.opponent,
    homeAway: record2.homeAway,
    fixtureClass: record2.fixtureClass,
    status: record2.status,
    recordMode: record2.recordMode,
    detailCompleteness: record2.detailCompleteness,
    finalScore: record2.finalScore ? { ...record2.finalScore } : null,
    halfTimeScore: record2.halfTimeScore ? { ...record2.halfTimeScore } : null,
    goals: clone2(record2.goals),
    unassignedGoalsFor: record2.finalScore ? record2.finalScore.for - record2.goals.filter((goal) => goal.beneficiary === "us").length : null,
    unassignedGoalsAgainst: record2.finalScore ? record2.finalScore.against - record2.goals.filter((goal) => goal.beneficiary === "opposition").length : null,
    outcome,
    points: outcome === "W" ? 3 : outcome === "D" ? 1 : outcome === "L" ? 0 : null,
    revision: record2.revision
  };
}
function selectSeasonResults(state, viewer) {
  const scoped = inScope(state, viewer) ? state.results.filter((record2) => record2.teamId === state.teamId && record2.seasonId === state.seasonId) : [];
  const visible = scoped.filter((record2) => canShare(record2, viewer.actor)).sort(chronological);
  const withheld = scoped.length - visible.length;
  const denied = !inScope(state, viewer) || withheld > 0;
  const included = visible.filter(ordinaryCompleted);
  const totals = { played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0 };
  for (const record2 of included) {
    const outcome = resultOutcome(record2.finalScore);
    totals.played += 1;
    totals.wins += Number(outcome === "W");
    totals.draws += Number(outcome === "D");
    totals.losses += Number(outcome === "L");
    totals.goalsFor += record2.finalScore.for;
    totals.goalsAgainst += record2.finalScore.against;
  }
  totals.goalDifference = totals.goalsFor - totals.goalsAgainst;
  totals.points = totals.wins * 3 + totals.draws;
  const scorerCounts = /* @__PURE__ */ new Map();
  for (const record2 of included) for (const goal of record2.goals) {
    if (goal.beneficiary === "us" && !goal.isOwnGoal && goal.scorerPlayerId) scorerCounts.set(goal.scorerPlayerId, (scorerCounts.get(goal.scorerPlayerId) ?? 0) + 1);
  }
  const ambiguous = included.some((record2, index) => included.some((other, otherIndex) => index !== otherIndex && other.playedDate === record2.playedDate && !(other.recordedKickoff && record2.recordedKickoff) && (other.sameDayOrder === null || record2.sameDayOrder === null || other.sameDayOrder === record2.sameDayOrder)));
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
    competitionPolicies: visible.map((record2) => ({ matchId: record2.id, policyId: record2.publication.id, policyVersion: record2.publication.version, fixtureClass: record2.fixtureClass, classificationVersion: record2.classificationVersion })),
    sharing: denied ? "withheld_policy" : "permitted",
    suppressionReason: denied ? "Scores and derived totals are not shared for this competition or scope." : null,
    withheldResultCount: viewer.actor === "manager" ? withheld : null,
    rows: visible.map(publicResult),
    totals: denied ? null : totals,
    scorerTotals: denied ? null : state.players.filter((player) => scorerCounts.has(player.id)).map((player) => ({ playerId: player.id, label: player.label, knownGoals: scorerCounts.get(player.id) })),
    form: denied || ambiguous ? null : included.slice(-5).map((record2) => ({ matchId: record2.id, outcome: resultOutcome(record2.finalScore) })),
    formChronologyState: ambiguous ? "same_day_order_unknown" : "known",
    unknownScoreCount: visible.filter((record2) => record2.status === "completed" && record2.finalScore === null).length,
    excludedExceptionalMatches: visible.filter((record2) => record2.specialOutcome !== "ordinary" || record2.status === "abandoned").length,
    dataCoverage: { totalRecordedMatches: denied ? null : scoped.length, knownOrdinaryResults: denied ? null : included.length, summaryOnlyCount: denied ? null : visible.filter((record2) => record2.recordMode === "historical_summary").length }
  };
}
function reportRecords(state, match) {
  const scoped = state.results.filter((record2) => record2.teamId === state.teamId && record2.seasonId === state.seasonId);
  if (!match || match.config.matchId !== state.liveMatch.matchId || match.status === "preparation") return scoped;
  const current3 = snapshotLiveMatch(state, match, observedMatchTime(match) ?? latestRecordTime(state) ?? state.startsOn + "T00:00:00Z");
  return [...scoped.filter((record2) => record2.id !== current3.id), current3];
}
function observedMatchTime(match) {
  const value = match?.eventHistory?.at(-1)?.sample.wallTimeMs ?? match?.anchor?.sample.wallTimeMs ?? match?.completedAtMs;
  return value === null || value === void 0 ? null : new Date(value).toISOString();
}
function latestRecordTime(state) {
  const times = [...state.results.map((record2) => record2.updatedAt), ...state.audit.map((entry) => entry.at)].sort((a, b) => Date.parse(a) - Date.parse(b));
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
  const records = reportRecords(state, match).filter((record2) => record2.status === "completed" || record2.recordMode === "detailed_live" && (record2.status === "incomplete" || record2.status === "abandoned"));
  const players = viewer.actor === "player" ? state.players.filter((player) => player.id === viewer.playerId) : state.players;
  return { ...metadata, access: "permitted", reason: null, rows: players.map((player) => {
    const selected = records.filter((record2) => record2.selectedPlayerIds?.includes(player.id) && record2.attendance?.[player.id] !== "not_selected");
    const evidence = selected.flatMap((record2) => record2.participation?.filter((item) => item.playerId === player.id) ?? []);
    const positionMs = {};
    for (const entry of evidence) for (const [position, duration2] of Object.entries(entry.positionMs)) positionMs[position] = (positionMs[position] ?? 0) + duration2;
    const preferenceMs = { first: 0, second: 0, backup: 0, other: 0, unknown: 0 };
    for (const entry of evidence) {
      if (entry.preferenceMs) for (const category of Object.keys(preferenceMs)) preferenceMs[category] += entry.preferenceMs[category];
      else preferenceMs.unknown += entry.playedMs;
    }
    const playingMs = evidence.reduce((sum, entry) => sum + entry.playedMs, 0);
    const goalkeeperMs = positionMs.GK ?? 0;
    const games = attendanceSummary(selected.map((record2) => record2.attendance?.[player.id] ?? "not_recorded"));
    const trainingEvidence = state.trainingAttendance.filter((item) => item.eventStatus === "held" && item.expectedPlayerIds.includes(player.id));
    const training = attendanceSummary(trainingEvidence.map((item) => item.attendance[player.id] ?? "not_recorded"));
    const matchesPlayed = evidence.filter((entry) => entry.playedMs > 0).length;
    const unknown = records.filter((record2) => record2.selectedPlayerIds === null).length;
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
      gameRecords: selected.map((record2) => ({ eventId: record2.id, heldDate: record2.playedDate, eventStatus: record2.status, selection: "selected", actualAttendance: record2.attendance?.[player.id] ?? "not_recorded", availabilityResponse: null })),
      trainingRecords: trainingEvidence.map((item) => ({ eventId: item.sessionId, heldDate: item.playedDate, eventStatus: "held", expected: true, actualAttendance: item.attendance[player.id] ?? "not_recorded", availabilityResponse: item.responses?.[player.id] ?? null })),
      coverageLabel: `Minutes recorded for ${evidence.length} of ${records.length} recorded games; ${unknown} historical squad${unknown === 1 ? "" : "s"} not recorded.`,
      evidenceState: selected.some((record2) => record2.detailCompleteness === "review_required") ? "review_required" : unknown || selected.length !== evidence.length ? "partial" : "complete"
    };
  }) };
}
function selectMatchReport(state, matchId, viewer, currentMatch = null) {
  if (!inScope(state, viewer)) return null;
  const record2 = reportRecords(state, currentMatch).find((item) => item.id === matchId);
  if (!record2) return null;
  const shared = canShare(record2, viewer.actor);
  const base = {
    matchId: record2.id,
    playedDate: record2.playedDate,
    opponent: record2.opponent,
    status: record2.status,
    clubId: state.clubId,
    teamId: state.teamId,
    seasonId: state.seasonId,
    projectionVersion: state.revision,
    sourceMatchRevision: record2.sourceMatchRevision,
    asOf: currentMatch?.config.matchId === matchId ? observedMatchTime(currentMatch) : record2.updatedAt,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    reportType: "match",
    policyId: record2.publication.id,
    policyVersion: record2.publication.version,
    classificationVersion: record2.classificationVersion,
    fixtureClass: record2.fixtureClass,
    appliedFilters: { matchId, playerId: viewer.actor === "player" ? viewer.playerId ?? null : null },
    visibilityScope: viewer.actor,
    recordMode: record2.recordMode,
    detailCompleteness: record2.detailCompleteness,
    revision: record2.revision,
    score: shared ? clone2(record2.finalScore) : null,
    halfTimeScore: shared ? clone2(record2.halfTimeScore) : null,
    goals: shared ? clone2(record2.goals) : [],
    unassignedGoalsFor: shared && record2.finalScore ? record2.finalScore.for - record2.goals.filter((goal) => goal.beneficiary === "us").length : null,
    unassignedGoalsAgainst: shared && record2.finalScore ? record2.finalScore.against - record2.goals.filter((goal) => goal.beneficiary === "opposition").length : null,
    suppressionReason: shared ? null : "Scores are not shared for this competition.",
    awardStatus: record2.awardStatus
  };
  if (viewer.actor === "spectator") return base;
  const eligible2 = viewer.actor === "manager" ? state.players.map((player) => player.id) : viewer.playerId ? [viewer.playerId] : [];
  return {
    ...base,
    actualActiveDurationMs: record2.actualActiveDurationMs,
    keeperPolicy: record2.keeperPolicy,
    participation: record2.participation?.filter((item) => eligible2.includes(item.playerId)).map(clone2) ?? null,
    attendance: record2.attendance ? Object.fromEntries(Object.entries(record2.attendance).filter(([id9]) => eligible2.includes(id9))) : null
  };
}

// packages/application/src/sync.ts
function effectiveEventTime(previous, next, event) {
  if (event.type === "policy.changed") return { ...event.effective };
  let effective;
  if (event.type === "goal.recorded" || event.type === "availability.changed" || event.type === "lineup.committed") effective = event.effective;
  if (event.type === "event.corrected") effective = event.replacement.effective;
  if ((event.type === "event.corrected" || event.type === "event.voided") && !effective) {
    const goal = previous.goals?.find((record2) => record2.eventId === event.targetEventId || record2.latestEventId === event.targetEventId);
    const availability = previous.availabilityHistory?.find((record2) => record2.eventId === event.targetEventId || record2.latestEventId === event.targetEventId);
    effective = goal?.effective ?? availability?.effective;
    if (!effective) {
      const target = previous.audit?.find((record2) => record2.eventId === event.targetEventId);
      effective = target?.effective;
    }
  }
  return effective ? { half: effective.half, halfElapsedMs: effective.halfElapsedMs, matchElapsedMs: effective.matchElapsedMs } : { half: next.half, halfElapsedMs: next.halfActiveMs, matchElapsedMs: next.matchActiveMs };
}

// packages/application/src/application.ts
function fixtureMatchConfig(preparation, snapshot) {
  const keepers = snapshot.profiles.filter(
    (player) => goalkeeperChoice(player) > 0
  );
  const config = {
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
    ...snapshot.matchPlanDraft ? { initialPolicyProposal: snapshot.matchPlanDraft.settings, initialLineupProposal: snapshot.matchPlanDraft.allocations.map((row) => ({ ...row })) } : {},
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
  return config;
}
var defaultPlayerId = romaFixture.players[0].id;

// packages/application/src/season-service.ts
var copy2 = (value) => JSON.parse(JSON.stringify(value));
var fail2 = (message, code = "INVALID_REQUEST", status2 = 422) => {
  throw new AccessError(code, status2, message);
};
function requireThat3(value, message) {
  if (!value) fail2(message);
}
function validId2(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}
function current(item, nowMs) {
  return item.revokedAt == null && (item.expiresAt == null || item.expiresAt > nowMs);
}
function source(context) {
  const { preparation, records } = context;
  requireThat3(Number.isSafeInteger(context.nowMs) && context.nowMs >= 0, "A trusted server time is required.");
  requireThat3(preparation.team.id === records.teamId && preparation.club.id === records.clubId, "Preparation and reports must belong to the same club and team.");
  const season = preparation.seasons.find((item) => item.id === records.seasonId);
  requireThat3(season, "The source season is unavailable.");
  requireThat3(context.community.seasons.some((item) => item.teamId === records.teamId && item.id === season.id), "The source community scope is inconsistent.");
  return season;
}
function visibleAccounts(context) {
  const season = source(context);
  const permitted = new Set(context.memberships.filter((item) => item.teamId === context.records.teamId && item.seasonId === season.id && current(item, context.nowMs)).map((item) => item.accountId));
  return context.accounts.filter((account3) => permitted.has(account3.accountId) && account3.status === "active");
}
function verifiedAdult(account3) {
  return account3.status === "active" && account3.identityClassification === "adult_individual" && account3.adultVerified && account3.strongAuthEnrolled;
}
function activeManagers(context) {
  return [...new Set(context.memberships.filter((item) => item.teamId === context.records.teamId && item.role === "manager" && current(item, context.nowMs) && context.accounts.find((account3) => account3.accountId === item.accountId)?.status !== "disabled").map((item) => item.accountId))];
}
function seasonAccessEndsAtMs(startYear) {
  const midnightUtc = Date.UTC(startYear + 1, 8, 1);
  const offset = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", timeZoneName: "shortOffset" }).formatToParts(midnightUtc).find((part) => part.type === "timeZoneName")?.value;
  const match = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(offset ?? "");
  requireThat3(match, "The season boundary timezone is unavailable.");
  const minutes = match[1] ? (match[1] === "+" ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3] ?? 0)) : 0;
  return midnightUtc - minutes * 6e4;
}
function seasonRolloverOptions(context) {
  const season = source(context), { principal, memberships, records, preparation, nowMs } = context;
  assertTeamRole(principal, memberships, records.teamId, season.id, ["administrator", "manager"], nowMs);
  assertAdultAuthority(principal, false, nowMs);
  const accounts = visibleAccounts(context);
  const currentRows = memberships.filter((item) => item.teamId === records.teamId && item.seasonId === season.id && current(item, nowMs));
  const administrator = currentRows.some((item) => item.accountId === principal.accountId && item.role === "administrator");
  const existingNextSeasonId = context.existingSeasons.find((item) => item.teamId === records.teamId && item.startYear === season.startYear + 1)?.id ?? null;
  return {
    revision: preparation.revision,
    sourceSeasonId: season.id,
    sourceSeason: copy2(season),
    canRollover: administrator && principal.strongAuth && !existingNextSeasonId && principal.authenticatedAt <= nowMs + 3e4 && nowMs - principal.authenticatedAt <= 3e5,
    existingNextSeasonId,
    requiredAuthority: "administrator_with_recent_stronger_sign_in",
    nextSeason: { startYear: season.startYear + 1, ...seasonBounds(season.startYear + 1) },
    activeManagerAccountIds: activeManagers(context),
    managerCandidates: accounts.filter(verifiedAdult).map((account3) => ({ accountId: account3.accountId, label: account3.label, currentManager: currentRows.some((item) => item.accountId === account3.accountId && item.role === "manager"), administrator: currentRows.some((item) => item.accountId === account3.accountId && item.role === "administrator") })),
    playerCandidates: currentRows.filter((item) => item.role === "player" && item.playerId && accounts.some((account3) => account3.accountId === item.accountId)).flatMap((item) => {
      const profile = preparation.profiles.find((profile2) => profile2.seasonId === season.id && profile2.playerId === item.playerId && profile2.active);
      return profile ? [{ accountId: item.accountId, playerId: profile.playerId, label: profile.displayName }] : [];
    }),
    spectatorRenewal: "individual_explicit_invitation_only"
  };
}
function configurationServiceView(input) {
  assertTeamRole(input.principal, input.memberships, input.preparation.team.id, input.seasonId, ["administrator", "manager"], input.nowMs);
  assertAdultAuthority(input.principal, false, input.nowMs);
  const { version, revision, club, team, activeSeasonId, seasons } = input.preparation;
  return copy2({ version, revision, club, team, activeSeasonId, seasons });
}
function applyConfigurationServiceCommand(input) {
  const { principal, memberships, preparation, seasonId, nowMs, command } = input;
  requireThat3(command?.type === "club.updated" || command?.type === "team.updated", "Configuration accepts only club or team settings.");
  assertTeamRole(principal, memberships, preparation.team.id, seasonId, command.type === "club.updated" ? ["administrator"] : ["administrator", "manager"], nowMs);
  assertAdultAuthority(principal, command.type === "club.updated", nowMs);
  return reducePreparation(preparation, command);
}
function planSeasonRollover(context) {
  const old = source(context), { principal, memberships, accounts, preparation, records, community, command, nowMs } = context;
  assertTeamRole(principal, memberships, records.teamId, old.id, ["administrator"], nowMs);
  requireThat3(Number.isSafeInteger(principal.authenticatedAt) && principal.authenticatedAt >= 0, "Verified authentication time is required.");
  assertAdultAuthority(principal, true, nowMs);
  requireThat3(command?.type === "season.rolled_over" && validId2(command.id) && validId2(command.idForSeason), "Use valid command and season identifiers.");
  requireThat3(command.expectedPreparationRevision === preparation.revision, "The source preparation changed. Refresh before creating its next season.");
  requireThat3(command.startYear === old.startYear + 1 && command.startYear <= 2100 && command.startYear >= 2020, "Create the immediately following September-to-August season.");
  requireThat3(command.idForSeason !== old.id && !preparation.seasons.some((item) => item.id === command.idForSeason || item.startYear === command.startYear) && !memberships.some((item) => item.teamId === records.teamId && item.seasonId === command.idForSeason), "That destination season already exists.");
  requireThat3(!context.existingSeasons.some((item) => item.teamId === records.teamId && (item.id === command.idForSeason || item.startYear === command.startYear)), "That destination season or season year already exists.");
  requireThat3(command.confirmSpectatorRenewal === true && typeof command.copyPlayers === "boolean", "Acknowledge that spectators receive no automatic new-season access.");
  requireThat3(Array.isArray(command.managerAccountIds) && Array.isArray(command.administratorAccountIds) && Array.isArray(command.playerAssignments), "Explicit manager, administrator and player assignments are required.");
  requireThat3(command.playerAssignments.length <= 2e3 && command.playerAssignments.every((item) => item && typeof item === "object" && validId2(item.accountId) && validId2(item.playerId)), "Player assignments must be a bounded list of known identities.");
  const unique3 = (items) => items.every(validId2) && new Set(items).size === items.length;
  requireThat3(command.managerAccountIds.length >= 1 && command.managerAccountIds.length <= 4 && unique3(command.managerAccountIds), "Select one to four distinct verified adult managers.");
  requireThat3(command.administratorAccountIds.length >= 1 && unique3(command.administratorAccountIds), "Explicitly retain at least one current verified administrator.");
  const options2 = seasonRolloverOptions(context);
  for (const id9 of command.managerAccountIds) requireThat3(options2.managerCandidates.some((account3) => account3.accountId === id9), "Each manager must be an active verified adult with stronger authentication already enrolled in this team.");
  for (const id9 of command.administratorAccountIds) requireThat3(options2.managerCandidates.some((account3) => account3.accountId === id9 && account3.administrator), "Only a current verified administrator can retain administrator authority in the new season.");
  if ((/* @__PURE__ */ new Set([...activeManagers(context), ...command.managerAccountIds])).size > 4) fail2("A team can have at most four active manager accounts. Revoke departed manager authority explicitly before adding another account.", "MANAGER_LIMIT", 409);
  requireThat3(new Set(command.playerAssignments.map((item) => item.accountId)).size === command.playerAssignments.length && new Set(command.playerAssignments.map((item) => item.playerId)).size === command.playerAssignments.length, "Player assignments must retain one distinct known account for each player.");
  requireThat3(command.copyPlayers || command.playerAssignments.length === 0, "Copy the relevant player profiles before assigning their existing accounts.");
  for (const assignment of command.playerAssignments) requireThat3(validId2(assignment.accountId) && validId2(assignment.playerId) && options2.playerCandidates.some((item) => item.accountId === assignment.accountId && item.playerId === assignment.playerId), "New player membership must preserve the source account/player binding. Use activation for new identity links.");
  const season = { id: command.idForSeason, startYear: command.startYear, ...seasonBounds(command.startYear), spectatorRenewalRequired: true };
  const newMemberships = [
    ...command.managerAccountIds.map((accountId) => ({ accountId, teamId: records.teamId, seasonId: season.id, role: "manager" })),
    ...command.administratorAccountIds.map((accountId) => ({ accountId, teamId: records.teamId, seasonId: season.id, role: "administrator" })),
    ...command.playerAssignments.map((item) => ({ ...item, teamId: records.teamId, seasonId: season.id, role: "player" }))
  ];
  const sourceProfiles = preparation.profiles.filter((profile) => profile.seasonId === old.id && profile.active);
  requireThat3(sourceProfiles.length <= 2e3 && new Set(sourceProfiles.map((profile) => profile.playerId)).size === sourceProfiles.length, "The source roster must have one distinct active profile for each player.");
  const profiles = command.copyPlayers ? sourceProfiles.map((profile, index) => ({ ...copy2(profile), id: `profile-${season.id.slice(0, 60)}-${String(index + 1).padStart(4, "0")}`, seasonId: season.id })) : [];
  const nextPreparation = { ...copy2(preparation), revision: 0, activeSeasonId: season.id, seasons: [season], profiles, fixtures: [], training: [], snapshots: [], matchPlans: [], appliedCommands: {}, audit: [{ id: command.id, revision: 0, type: "season.created_from_explicit_assignments" }] };
  const nextRecords = {
    ...copy2(records),
    revision: 0,
    seasonId: season.id,
    seasonLabel: season.label,
    startsOn: season.startDate,
    endsOn: season.endDate,
    players: profiles.map((profile) => ({ id: profile.playerId, label: profile.displayName })),
    liveMatch: { matchId: "", playedDate: season.startDate, opponent: "", homeAway: "home", fixtureClass: "unclassified" },
    results: [],
    trainingAttendance: [],
    audit: [],
    appliedCommands: {}
  };
  const assignedIds = new Set(newMemberships.map((item) => item.accountId));
  const nextCommunity = {
    ...copy2(community),
    revision: 0,
    accounts: accounts.filter((account3) => assignedIds.has(account3.accountId)).map((account3) => ({ id: account3.accountId, label: account3.label, classification: account3.identityClassification === "child_shared" ? "child_shared" : "adult_individual", adultVerified: account3.adultVerified })),
    memberships: newMemberships.filter((item) => item.role === "manager" || item.role === "player").map((item) => ({ accountId: item.accountId, teamId: item.teamId, seasonId: item.seasonId, role: item.role, ...item.playerId ? { playerId: item.playerId } : {}, active: true })),
    seasons: [{ id: season.id, teamId: records.teamId, label: season.label, teamLabel: preparation.team.name, accessEndsAtMs: seasonAccessEndsAtMs(command.startYear) }],
    invitations: [],
    grants: [],
    matches: [],
    ballots: [],
    awards: [],
    photos: [],
    concerns: [],
    privacyRequests: [],
    appliedCommands: {},
    hiddenUploaders: community.hiddenUploaders.filter((item) => assignedIds.has(item.accountId)).map(copy2),
    preferences: Object.fromEntries(Object.entries(community.preferences).filter(([accountId]) => assignedIds.has(accountId)).map(([id9, value]) => [id9, copy2(value)])),
    audit: [{ id: command.id, actorAccountId: principal.accountId, action: "season.created_from_explicit_assignments", atMs: nowMs }]
  };
  return {
    preparation: nextPreparation,
    records: nextRecords,
    community: nextCommunity,
    memberships: newMemberships,
    receipt: { revision: 0, seasonId: season.id, season, sourceSeasonId: old.id, commandId: command.id, managerAccountIds: [...command.managerAccountIds], administratorAccountIds: [...command.administratorAccountIds], playerAssignmentCount: command.playerAssignments.length, spectatorGrantCount: 0, spectatorRenewal: "individual_explicit_invitation_only" }
  };
}

// packages/application/src/report-community.ts
var empty = (communityStatus, communityRevision = null) => ({ communityStatus, communityRevision, award: null, publishedAlbum: null });
function composeReportCommunity(report, accountId, source2) {
  if (report.suppressionReason) return empty("withheld");
  if (!source2 || source2.accountId !== accountId || source2.teamId !== report.teamId || source2.seasonId !== report.seasonId || source2.audience !== report.visibilityScope || report.visibilityScope === "player" && source2.playerId !== report.appliedFilters.playerId || !Number.isSafeInteger(source2.revision) || source2.revision < 0 || !source2.view.allowed) return empty("unavailable");
  const contexts = source2.view.matches.filter((item) => item.id === report.matchId);
  if (contexts.length > 1) return empty("unavailable");
  if (contexts.length === 0) return empty("not_recorded", source2.revision);
  const match = contexts[0];
  if (match.sharingAllowed !== true) return empty("withheld", source2.revision);
  const award = match.award;
  const times = award ? [award.voteCutoffAtMs, award.finalisationDeadlineAtMs, award.finalisedAtMs] : [];
  if (award && (award.matchId !== report.matchId || !["winners", "no_valid_votes"].includes(award.result) || !times.every((time3) => Number.isSafeInteger(time3) && time3 >= 0) || award.finalisationDeadlineAtMs < award.voteCutoffAtMs || award.deadlineMissed !== award.finalisedAtMs > award.finalisationDeadlineAtMs || !Array.isArray(award.winnerLabels) || award.winnerLabels.some((label) => typeof label !== "string" || !label.trim() || label.length > 120) || (award.result === "no_valid_votes" ? award.winnerLabels.length !== 0 : award.winnerLabels.length === 0))) return empty("unavailable");
  const photos = new Set(source2.view.gallery.filter((photo) => photo.matchId === report.matchId && typeof photo.id === "string" && photo.id.length > 0).map((photo) => photo.id));
  return {
    communityStatus: "available",
    communityRevision: source2.revision,
    award: award ? { matchId: report.matchId, result: award.result, winnerLabels: [...award.winnerLabels], voteCutoffAtMs: award.voteCutoffAtMs, finalisationDeadlineAtMs: award.finalisationDeadlineAtMs, finalisedAtMs: award.finalisedAtMs, deadlineMissed: award.deadlineMissed } : null,
    publishedAlbum: { matchId: report.matchId, photoCount: photos.size }
  };
}

// packages/application/src/records-service.ts
var copy3 = (value) => JSON.parse(JSON.stringify(value));
function fail3(message, code = "INVALID_REQUEST", status2 = 422) {
  throw new AccessError(code, status2, message);
}
function requireThat4(value, message) {
  if (!value) fail3(message);
}
function object2(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function string(value, max = 150) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function fields(value, permitted) {
  requireThat4(Object.keys(value).every((key) => permitted.includes(key)), "The request includes unsupported fields.");
}
function integer3(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
var fixtureClasses = ["development", "friendly", "trophy", "unclassified"];
function score(value) {
  if (value === null) return null;
  requireThat4(object2(value), "Provide a known score or explicitly leave it not recorded.");
  fields(value, ["for", "against"]);
  requireThat4(integer3(value.for, 999) && integer3(value.against, 999), "Scores must be nonnegative whole goals.");
  return { for: value.for, against: value.against };
}
function parseHistoricalResultInput(value) {
  requireThat4(object2(value), "Historical details are required.");
  fields(value, ["playedDate", "recordedKickoff", "sameDayOrder", "opponent", "homeAway", "fixtureClass", "status", "specialOutcome", "finalScore", "halfTimeScore", "goals"]);
  requireThat4(string(value.playedDate, 10) && string(value.opponent, 120), "A played date and opposition are required.");
  requireThat4(value.recordedKickoff === null || string(value.recordedKickoff, 50), "Known kickoff needs a timestamp; use null for unknown.");
  requireThat4(value.sameDayOrder === null || integer3(value.sameDayOrder, 100), "Same-day ordering must be a whole number or unknown.");
  requireThat4(["home", "away", "neutral"].includes(value.homeAway) && fixtureClasses.includes(value.fixtureClass), "Choose a valid venue side and fixture class.");
  requireThat4(["completed", "abandoned", "cancelled", "postponed", "incomplete"].includes(value.status) && ["ordinary", "awarded", "forfeit", "shootout"].includes(value.specialOutcome), "Choose a known match status and outcome category.");
  requireThat4(Array.isArray(value.goals) && value.goals.length <= 1e3, "Known goal attribution must be a bounded list.");
  const goals = value.goals.map((item) => {
    requireThat4(object2(item), "A known goal must be an object.");
    fields(item, ["id", "beneficiary", "isOwnGoal", "scorerPlayerId", "goalType", "half", "halfElapsedMs"]);
    requireThat4(string(item.id) && ["us", "opposition"].includes(item.beneficiary) && typeof item.isOwnGoal === "boolean", "Known goals require identity, beneficiary and explicit own-goal classification.");
    requireThat4(item.scorerPlayerId === null || string(item.scorerPlayerId), "Use a saved player identity or unknown scorer.");
    requireThat4(item.goalType === null || ["open_play", "free_kick", "penalty"].includes(item.goalType), "Use a known goal type or unknown.");
    requireThat4(item.half === null || item.half === 1 || item.half === 2, "Use a known half or unknown.");
    requireThat4(item.halfElapsedMs === null || integer3(item.halfElapsedMs, 864e5), "Known active goal time must be nonnegative whole milliseconds.");
    return { id: item.id, beneficiary: item.beneficiary, isOwnGoal: item.isOwnGoal, scorerPlayerId: item.scorerPlayerId, goalType: item.goalType, half: item.half, halfElapsedMs: item.halfElapsedMs };
  });
  return { playedDate: value.playedDate, recordedKickoff: value.recordedKickoff, sameDayOrder: value.sameDayOrder, opponent: value.opponent.trim(), homeAway: value.homeAway, fixtureClass: value.fixtureClass, status: value.status, specialOutcome: value.specialOutcome, finalScore: score(value.finalScore), halfTimeScore: score(value.halfTimeScore), goals };
}
function recordsServiceViewer(input) {
  const { principal, memberships, state, nowMs, requestedRole } = input;
  requireThat4(Number.isSafeInteger(nowMs) && nowMs >= 0, "Trusted server time is required.");
  if (requestedRole && !["manager", "player", "spectator"].includes(requestedRole)) fail3("Unknown report audience.");
  const permitted = memberships.filter((item) => item.accountId === principal.accountId && item.teamId === state.teamId && item.seasonId === state.seasonId && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > nowMs));
  const preferred = requestedRole ?? (permitted.some((item) => item.role === "manager") ? "manager" : permitted.some((item) => item.role === "player") ? "player" : "spectator");
  const membership = assertTeamRole(principal, memberships, state.teamId, state.seasonId, [preferred], nowMs);
  if (preferred === "manager") assertAdultAuthority(principal, false, nowMs);
  if (preferred === "player" && !membership.playerId) fail3("The current membership has no own-player binding.", "NOT_FOUND", 404);
  return { actor: preferred, ...preferred === "player" ? { playerId: membership.playerId } : {}, teamId: state.teamId, seasonId: state.seasonId };
}
function accepted(input, matchId) {
  const row = input.acceptedMatches.find((item) => item.teamId === input.state.teamId && item.seasonId === input.state.seasonId && item.match.config.matchId === matchId);
  if (!row) return null;
  if (row.match.config.fixture && (row.match.config.fixture.teamId !== row.teamId || row.match.config.fixture.seasonId !== row.seasonId)) fail3("Accepted fixture scope is inconsistent.", "NOT_FOUND", 404);
  return row.match;
}
function contextFor(state, match, fixtureClass) {
  const fixture = match.config.fixture;
  if (!fixture) return state.liveMatch.matchId === match.config.matchId ? { ...state.liveMatch, fixtureClass: fixtureClass ?? state.liveMatch.fixtureClass } : null;
  return { matchId: match.config.matchId, playedDate: fixture.playedDate, opponent: fixture.opponent, homeAway: fixture.homeAway, fixtureClass: fixtureClass ?? state.results.find((record2) => record2.id === match.config.matchId)?.fixtureClass ?? "unclassified" };
}
function recordsServiceView(input) {
  const viewer = recordsServiceViewer(input), { state, nowMs } = input;
  const activeMatch = accepted(input, state.liveMatch.matchId);
  const generatedAt = new Date(nowMs).toISOString();
  const stamp = (value) => ({ ...value, generatedAt });
  const ids = new Set(state.results.map((record2) => record2.id));
  for (const row of input.acceptedMatches)
    if (row.teamId === state.teamId && row.seasonId === state.seasonId && row.match.status !== "preparation") ids.add(row.match.config.matchId);
  const reports = [...ids].map((id9) => {
    const match = accepted(input, id9);
    const details = match ? contextFor(state, match, id9 === state.liveMatch.matchId ? state.liveMatch.fixtureClass : void 0) : null;
    return selectMatchReport(details ? { ...state, liveMatch: details } : state, id9, viewer, match);
  }).filter((item) => item !== null);
  const common = { revision: state.revision, results: stamp(selectSeasonResults(state, viewer)), participation: stamp(selectParticipationReport(state, activeMatch, viewer)), matches: reports.map((report) => stamp({ ...report, ...composeReportCommunity(report, input.principal.accountId, input.community), goals: report.goals.map((goal) => ({ ...goal, scorerLabel: goal.scorerPlayerId ? state.players.find((player) => player.id === goal.scorerPlayerId)?.label ?? null : null })) })) };
  if (viewer.actor !== "manager") return common;
  return {
    ...common,
    editableState: copy3(state),
    activeMatch: activeMatch ? copy3(activeMatch) : null,
    contexts: input.acceptedMatches.filter((row) => row.teamId === state.teamId && row.seasonId === state.seasonId).flatMap((row) => {
      const match = accepted(input, row.match.config.matchId);
      const details = contextFor(state, match, state.liveMatch.matchId === match.config.matchId ? state.liveMatch.fixtureClass : void 0);
      return details ? [{ ...details, status: match.status, sourceMatchRevision: match.revision, archivedSourceMatchRevision: state.results.find((record2) => record2.id === match.config.matchId)?.sourceMatchRevision ?? null }] : [];
    })
  };
}
function applyRecordsServiceCommand(input) {
  const { state, command, principal, memberships, nowMs } = input;
  assertCanManageTeam(principal, memberships, state.teamId, state.seasonId, nowMs);
  if (input.requestedRole && input.requestedRole !== "manager") fail3("The selected audience cannot edit manager records.", "NOT_FOUND", 404);
  requireThat4(command && typeof command === "object" && string(command.commandId) && /^[A-Za-z0-9_-]+$/.test(command.commandId), "A stable record command identity is required.");
  let bound;
  const base = { commandId: command.commandId, at: new Date(nowMs).toISOString(), actor: "manager" };
  switch (command.type) {
    case "historical.add":
      requireThat4(string(command.recordId), "A historical match identity is required.");
      bound = { ...base, type: command.type, recordId: command.recordId, input: parseHistoricalResultInput(command.input), acknowledgePossibleDuplicate: command.acknowledgePossibleDuplicate === true };
      break;
    case "historical.correct":
      requireThat4(string(command.recordId) && integer3(command.expectedRevision) && string(command.reason, 500), "Review the current record revision and provide a correction reason.");
      bound = { ...base, type: command.type, recordId: command.recordId, expectedRevision: command.expectedRevision, reason: command.reason.trim(), input: parseHistoricalResultInput(command.input) };
      break;
    case "live.context.set": {
      requireThat4(command.details && typeof command.details === "object" && string(command.details.matchId) && fixtureClasses.includes(command.details.fixtureClass), "Choose a prepared match and an explicit fixture class.");
      const match = accepted(input, command.details.matchId);
      if (!match) fail3("The prepared match is outside this team and season.", "NOT_FOUND", 404);
      const details = contextFor(state, match, command.details.fixtureClass);
      requireThat4(details && details.playedDate === command.details.playedDate && details.opponent === command.details.opponent && details.homeAway === command.details.homeAway, "Match report context must retain the accepted fixture date, opponent and home/away side.");
      bound = { ...base, type: command.type, details };
      break;
    }
    case "live.archive": {
      const matchId = "matchId" in command ? command.matchId : command.match?.config?.matchId;
      const expectedRevision = "expectedSourceMatchRevision" in command ? command.expectedSourceMatchRevision : command.match?.revision;
      requireThat4(string(matchId) && integer3(expectedRevision), "Archive the reviewed accepted match identity and source revision.");
      const match = accepted(input, matchId);
      if (!match) fail3("The accepted match is outside this team and season.", "NOT_FOUND", 404);
      if (match.revision !== expectedRevision) fail3("The accepted match changed. Refresh its report before archiving.", "STALE_REVISION", 409);
      const old = state.results.find((record2) => record2.id === matchId);
      if (old && old.fixtureClass !== state.liveMatch.fixtureClass) requireThat4(string(command.reason, 500), "Explain the changed fixture classification before re-archiving.");
      bound = { ...base, type: command.type, match, ...command.reason ? { reason: command.reason } : {} };
      break;
    }
    case "participation.exception.noted":
      requireThat4(string(command.recordId) && string(command.playerId) && integer3(command.expectedRevision) && string(command.reason, 500), "Review the saved participation and explain the exception.");
      bound = { ...base, type: command.type, recordId: command.recordId, playerId: command.playerId, expectedRevision: command.expectedRevision, reason: command.reason.trim() };
      break;
    case "publication.set":
      fail3("A manager request cannot approve the unresolved competition policy. Independent operator evidence is required.", "POLICY_APPROVAL_REQUIRED", 503);
      break;
    case "training.evidence.replace":
      fail3("Training report evidence is projected from the authorised preparation service.", "SERVICE_OWNED_PROJECTION", 403);
      break;
    default:
      fail3("Unsupported record command.");
  }
  return reduceRecords(state, bound);
}
function policyFingerprint(state) {
  const source2 = JSON.stringify(state.results.map((record2) => [record2.id, record2.classificationVersion, record2.fixtureClass, record2.publication]));
  let hash6 = 2166136261;
  for (const character of source2) hash6 = Math.imul(hash6 ^ character.charCodeAt(0), 16777619) >>> 0;
  return `policy-v1-${hash6.toString(16).padStart(8, "0")}`;
}
function recordsServiceExport(input) {
  const viewer = recordsServiceViewer(input), view = recordsServiceView(input), { request, state, nowMs } = input;
  requireThat4(request && ["season", "match"].includes(request.kind) && ["json", "csv"].includes(request.format), "Choose a report and supported export format.");
  const fingerprint3 = policyFingerprint(state);
  if (request.expectedProjectionVersion !== void 0 && request.expectedProjectionVersion !== state.revision || request.expectedPolicyFingerprint !== void 0 && request.expectedPolicyFingerprint !== fingerprint3) fail3("This report or audience policy changed. Refresh before exporting.", "STALE_PROJECTION", 409);
  const matches = request.kind === "match" ? view.matches.filter((report) => report.matchId === request.matchId) : view.matches;
  if (request.kind === "match" && matches.length !== 1) fail3("That permitted match report is unavailable.", "NOT_FOUND", 404);
  const generatedAt = new Date(nowMs).toISOString();
  const document = {
    schemaVersion: 1,
    reportType: request.kind,
    teamId: state.teamId,
    seasonId: state.seasonId,
    audience: viewer.actor,
    appliedFilters: { matchId: request.kind === "match" ? request.matchId : null, playerId: viewer.actor === "player" ? viewer.playerId : null },
    generatedAt,
    asOf: request.kind === "match" ? matches[0].asOf : view.participation.asOf,
    projectionVersion: state.revision,
    policyFingerprint: fingerprint3,
    policyVersions: state.results.filter((record2) => request.kind === "season" || matches.some((report) => report.matchId === record2.id)).map((record2) => ({ matchId: record2.id, policyId: record2.publication.id, policyVersion: record2.publication.version, classificationVersion: record2.classificationVersion })),
    dataCoverage: { participationAccess: view.participation.access, attendancePolicy: view.participation.rows[0]?.games.policy ?? "proposed_known_records_excused_included", includesInventedHistoricalMinutes: false },
    ...request.kind === "season" ? { results: view.results, ...viewer.actor !== "spectator" ? { participation: view.participation } : {} } : {},
    matches
  };
  const csvCell = (value) => {
    let text2 = value === null || value === void 0 ? "Not recorded" : typeof value === "object" ? JSON.stringify(value) : String(value);
    if (/^[\t\r ]*[=+\-@]/.test(text2)) text2 = `'${text2}`;
    return `"${text2.replaceAll('"', '""')}"`;
  };
  const rows = [["section", "identity", "field", "value"], ["metadata", "report", "teamId", state.teamId], ["metadata", "report", "seasonId", state.seasonId], ["metadata", "report", "audience", viewer.actor], ["metadata", "report", "projectionVersion", state.revision], ["metadata", "report", "policyFingerprint", fingerprint3], ["metadata", "report", "generatedAt", generatedAt], ["metadata", "report", "asOf", document.asOf], ["metadata", "report", "attendancePolicy", document.dataCoverage.attendancePolicy]];
  if (request.kind === "season") for (const [field, value] of Object.entries(view.results)) rows.push(["results", "season", field, value]);
  if (request.kind === "season" && viewer.actor !== "spectator") for (const row of view.participation.rows) for (const [field, value] of Object.entries(row)) rows.push(["participation", row.playerId, field, value]);
  for (const report of matches) for (const [field, value] of Object.entries(report)) rows.push(["match", report.matchId, field, value]);
  const body = request.format === "json" ? JSON.stringify(document, null, 2) : "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  return { kind: "records-export", format: request.format, contentType: request.format === "json" ? "application/json" : "text/csv; charset=utf-8", fileName: `longball-${state.teamId.replace(/[^A-Za-z0-9_-]/g, "_")}-${state.seasonId.replace(/[^A-Za-z0-9_-]/g, "_")}-${request.kind}.${request.format}`, body, teamId: state.teamId, seasonId: state.seasonId, audience: viewer.actor, projectionVersion: state.revision, policyFingerprint: fingerprint3, generatedAt };
}

// apps/api/src/trusted-time.ts
var integer4 = (value) => Number.isSafeInteger(value) && value >= 0;
var continuous = (value) => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
function checkPolicy(policy) {
  if (!policy.id || ![
    policy.serverClockUncertaintyMs,
    policy.maximumRoundTripMs,
    policy.maximumMappingAgeMs,
    policy.maximumUncertaintyMs,
    policy.maximumDriftPpm
  ].every(integer4) || !policy.maximumRoundTripMs || !policy.maximumMappingAgeMs) {
    throw new Error("A versioned, explicit trusted-time policy is required.");
  }
}
function issueClockChallenge(scope, id9, issuedAtMs, policy) {
  checkPolicy(policy);
  if (!id9 || !scope.accountId || !scope.deviceId || !scope.matchId || !scope.continuityId || !integer4(issuedAtMs) || !integer4(scope.controllerEpoch) || scope.controllerEpoch === 0) {
    throw new Error(
      "The clock challenge requires a current controller and continuous-clock identity."
    );
  }
  return {
    ...scope,
    id: id9,
    issuedAtMs,
    expiresAtMs: issuedAtMs + policy.maximumRoundTripMs,
    policyId: policy.id
  };
}
function acknowledgeClockChallenge(challenge, sample, serverReceivedAtMs, policy) {
  checkPolicy(policy);
  const { receivedMonotonicMs, sentMonotonicMs } = sample;
  if (challenge.policyId !== policy.id || !integer4(serverReceivedAtMs) || !continuous(receivedMonotonicMs) || !continuous(sentMonotonicMs) || sentMonotonicMs < receivedMonotonicMs || serverReceivedAtMs < challenge.issuedAtMs || serverReceivedAtMs > challenge.expiresAtMs || sentMonotonicMs - receivedMonotonicMs > serverReceivedAtMs - challenge.issuedAtMs) {
    throw new Error(
      "The clock exchange expired or its continuous-clock evidence is inconsistent."
    );
  }
  const mapping = {
    accountId: challenge.accountId,
    deviceId: challenge.deviceId,
    matchId: challenge.matchId,
    controllerEpoch: challenge.controllerEpoch,
    continuityId: challenge.continuityId,
    challengeId: challenge.id,
    policyId: policy.id,
    establishedAtMs: serverReceivedAtMs,
    sampleMonotonicMs: sentMonotonicMs,
    offsetMinimumMs: challenge.issuedAtMs - receivedMonotonicMs - policy.serverClockUncertaintyMs,
    offsetMaximumMs: serverReceivedAtMs - sentMonotonicMs + policy.serverClockUncertaintyMs,
    validUntilMs: serverReceivedAtMs + policy.maximumMappingAgeMs
  };
  if ((mapping.offsetMaximumMs - mapping.offsetMinimumMs) / 2 > policy.maximumUncertaintyMs)
    throw new Error(
      "The clock exchange exceeds the approved uncertainty bound."
    );
  return mapping;
}
function mapContinuousInstant(mapping, scope, monotonicMs, serverNowMs, policy) {
  checkPolicy(policy);
  if (mapping.policyId !== policy.id || [
    "accountId",
    "deviceId",
    "matchId",
    "controllerEpoch",
    "continuityId"
  ].some((key) => scope[key] !== mapping[key])) {
    return {
      quality: "review_required",
      reason: "The clock mapping belongs to another controller, device, match or continuity session."
    };
  }
  if (!continuous(monotonicMs) || !integer4(serverNowMs) || serverNowMs < mapping.establishedAtMs)
    return {
      quality: "review_required",
      reason: "The server or continuous-clock observation is invalid."
    };
  const distance = Math.abs(monotonicMs - mapping.sampleMonotonicMs);
  if (distance > policy.maximumMappingAgeMs)
    return {
      quality: "review_required",
      reason: "The event exceeds the approved extrapolation duration."
    };
  const minimum = monotonicMs + mapping.offsetMinimumMs;
  const maximum = monotonicMs + mapping.offsetMaximumMs;
  if (minimum < mapping.establishedAtMs - policy.maximumRoundTripMs || maximum > mapping.validUntilMs || minimum > serverNowMs) {
    return {
      quality: "review_required",
      reason: "The event lies outside the original mapping lifetime or in the future."
    };
  }
  const utcMs = Math.round((minimum + maximum) / 2);
  const uncertaintyMs = Math.ceil(
    Math.max(utcMs - minimum, maximum - utcMs) + distance * policy.maximumDriftPpm / 1e6
  );
  if (uncertaintyMs > policy.maximumUncertaintyMs)
    return {
      quality: "review_required",
      reason: "Propagated clock uncertainty exceeds the approved bound."
    };
  return {
    quality: "trusted",
    utcMs,
    uncertaintyMs,
    mappingId: mapping.challengeId,
    policyId: mapping.policyId
  };
}

// packages/application/src/reconciliation.ts
var Q08_RECONCILIATION_POLICY = {
  status: "unapproved",
  policyId: "q08-reconciliation-authority-unapproved",
  decisionRequired: "Confirm who may approve unresolved history reconciliation: importing old-device evidence, marking submissions duplicate, or retaining a disputed history. Define the reviewer authority and required evidence; assigned-manager access alone does not approve this policy."
};
var identifier2 = /^[a-zA-Z0-9_-]{1,120}$/;
function canonicalReviewJson(value) {
  if (Array.isArray(value))
    return `[${value.map(canonicalReviewJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value).filter(([, item]) => item !== void 0).sort(([left], [right]) => left.localeCompare(right)).map(
      ([key, item]) => `${JSON.stringify(key)}:${canonicalReviewJson(item)}`
    ).join(",")}}`;
  return JSON.stringify(value);
}
function checkpointSample(state, recordedAtMs) {
  return state.anchor ? { ...state.anchor.sample } : {
    monotonicMs: 0,
    sessionId: "review-preview-only",
    wallTimeMs: recordedAtMs
  };
}
function reconciliationSummary(state) {
  const minutes = playerMinutes(state, checkpointSample(state, 0));
  const occupiedPlayerMs = minutes.reduce(
    (sum, item) => sum + item.playingMs,
    0
  );
  const capacityPlayerMs = state.config.pitchPlaces * state.matchActiveMs;
  return {
    revision: state.revision,
    status: state.status,
    half: state.half,
    halfActiveMs: state.halfActiveMs,
    matchActiveMs: state.matchActiveMs,
    firstHalfDurationMs: state.firstHalfDurationMs,
    score: { ...state.score },
    halfTimeScore: state.halfTimeScore ? { ...state.halfTimeScore } : null,
    playerMinutes: minutes,
    occupiedPlayerMs,
    capacityPlayerMs,
    vacancyPlayerMs: capacityPlayerMs - occupiedPlayerMs
  };
}
function assertParticipationConservation(state) {
  const selected = new Set(state.config.selectedPlayerIds);
  const firstEnd = state.firstHalfDurationMs ?? (state.half === 1 ? state.matchActiveMs : 0);
  for (const interval of state.intervals) {
    if (!selected.has(interval.playerId) || !Number.isSafeInteger(interval.startMs) || !Number.isSafeInteger(interval.endMs) || interval.startMs < 0 || interval.endMs <= interval.startMs || interval.endMs > state.matchActiveMs || interval.half === 1 && interval.endMs > firstEnd || interval.half === 2 && interval.startMs < firstEnd)
      throw new Error(
        "Participation contains invalid coordinates, identity or half boundaries."
      );
    if (interval.state === "playing" !== Boolean(interval.position && interval.slotId))
      throw new Error(
        "Playing intervals need one saved position and occupied slot; bench/unavailable intervals cannot occupy a place."
      );
  }
  for (const playerId of selected) {
    const intervals = state.intervals.filter((item) => item.playerId === playerId).sort((a, b) => a.startMs - b.startMs || a.half - b.half);
    let end = 0;
    for (const interval of intervals) {
      if (interval.startMs !== end)
        throw new Error(
          `Participation for ${playerId} has an overlap or uncovered active time.`
        );
      end = interval.endMs;
    }
    if (end !== state.matchActiveMs)
      throw new Error(
        `Participation for ${playerId} does not partition the actual match time.`
      );
  }
  const boundaries = [
    .../* @__PURE__ */ new Set([
      0,
      state.matchActiveMs,
      ...state.intervals.flatMap((item) => [item.startMs, item.endMs])
    ])
  ].sort((a, b) => a - b);
  for (let index = 0; index + 1 < boundaries.length; index++) {
    const active2 = state.intervals.filter(
      (item) => item.state === "playing" && item.startMs <= boundaries[index] && item.endMs >= boundaries[index + 1]
    );
    if (active2.length > state.config.pitchPlaces || new Set(active2.map((item) => item.slotId)).size !== active2.length || new Set(active2.map((item) => item.playerId)).size !== active2.length)
      throw new Error(
        "Participation occupies a player/slot twice or exceeds pitch capacity."
      );
  }
  const summary = reconciliationSummary(state);
  if (summary.vacancyPlayerMs < 0 || summary.playerMinutes.some(
    (item) => item.playingMs + item.benchMs + item.unavailableMs !== state.matchActiveMs || Object.values(item.positionMs).reduce(
      (sum, value) => sum + value,
      0
    ) !== item.playingMs
  ))
    throw new Error(
      "Player/position participation totals do not conserve active time."
    );
  if (state.targetIntervals.reduce((sum, item) => sum + item.durationMs, 0) !== state.matchActiveMs)
    throw new Error(
      "Availability target intervals do not partition the actual match time."
    );
}
function validateCommandIntent(command) {
  if (!command || typeof command !== "object" || [
    "id",
    "sample",
    "actorId",
    "controllerEpoch",
    "clientSequence",
    "controllerToken"
  ].some((field) => field in command))
    throw new Error(
      "Reviewed command intents cannot supply identity, clock evidence or controller authority."
    );
  if (command.type === "goal.recorded" || command.type === "availability.changed" || command.type === "lineup.committed") {
    if (!command.effective || !command.lateEntryReason?.trim())
      throw new Error(
        "Import each historical event with an explicit active-time boundary and late-entry evidence reason."
      );
    if (command.type !== "goal.recorded" && command.sourceRevision === void 0)
      throw new Error(
        "Historical participation imports need the exact reviewed source revision."
      );
  } else if (!["event.corrected", "event.voided"].includes(command.type))
    throw new Error(
      "Clock, half, attendance and controller transitions need a separate evidence review. No time or authority is inferred from a quarantined device."
    );
}
function previewReviewedCommands(state, commands, context) {
  const before = reconciliationSummary(state), issues = [];
  let projected = state;
  let earliestAffected = null;
  if (!identifier2.test(context.previewId) || !context.actorId || !Number.isSafeInteger(context.recordedAtMs) || context.recordedAtMs < 0)
    issues.push(
      "Preview context requires a bounded ID, verified actor and valid entry timestamp."
    );
  if (!Array.isArray(commands) || commands.length < 1 || commands.length > 100)
    issues.push("Review between1 and100 explicit commands.");
  if (issues.length)
    return {
      valid: false,
      issues,
      before,
      after: null,
      earliestAffected,
      projectedState: null
    };
  try {
    assertParticipationConservation(state);
    for (const [index, command] of commands.entries()) {
      validateCommandIntent(command);
      const event = {
        ...command,
        id: `${context.previewId}-preview-${index}`,
        sample: checkpointSample(projected, context.recordedAtMs),
        actorId: context.actorId
      };
      projected = reduceMatch(projected, event);
      const boundary = projected.audit?.at(-1)?.effective;
      const auditValue = projected.audit?.at(-1)?.value;
      const affected = auditValue?.earliestAffected ?? boundary;
      if (affected && (!earliestAffected || affected.matchElapsedMs < earliestAffected.matchElapsedMs))
        earliestAffected = affected;
      assertParticipationConservation(projected);
    }
    if (projected.matchActiveMs !== state.matchActiveMs || projected.halfActiveMs !== state.halfActiveMs || projected.half !== state.half || projected.firstHalfDurationMs !== state.firstHalfDurationMs || projected.status !== state.status || projected.completedAtMs !== state.completedAtMs || canonicalReviewJson(projected.config) !== canonicalReviewJson(state.config))
      throw new Error(
        "A history proposal cannot change the current clock, actual half lengths, lifecycle, completion anchor or immutable match preparation."
      );
    return {
      valid: true,
      issues: [],
      before,
      after: reconciliationSummary(projected),
      earliestAffected,
      projectedState: projected
    };
  } catch (error) {
    issues.push(
      error instanceof Error ? error.message : "The proposed history could not be validated."
    );
  }
  return {
    valid: false,
    issues,
    before,
    after: null,
    earliestAffected,
    projectedState: null
  };
}
function previewReconciliation(state, input, submissions, context) {
  const before = reconciliationSummary(state), issues = [];
  if (!input || typeof input !== "object")
    return {
      valid: false,
      issues: ["A typed immutable proposal is required."],
      before,
      after: null,
      earliestAffected: null,
      projectedState: null
    };
  if (!identifier2.test(input.proposalId) || !Number.isSafeInteger(input.baseRevision) || input.baseRevision !== state.revision)
    issues.push(
      "The proposal ID or reviewed accepted revision is invalid/stale. Download and review again without rebasing the proposal silently."
    );
  if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 500)
    issues.push("Record an evidence reason of1\u2013500 characters.");
  if (!Array.isArray(input.sourceSubmissionIds) || input.sourceSubmissionIds.length < 1 || input.sourceSubmissionIds.length > 100 || new Set(input.sourceSubmissionIds).size !== input.sourceSubmissionIds.length || input.sourceSubmissionIds.some(
    (id9) => !submissions.some(
      (item) => item.submissionId === id9 && item.matchId === state.config.matchId && Boolean(item.originalDigest)
    )
  ))
    issues.push(
      "Select unique retained submissions from this same match with immutable source digests."
    );
  if (!["duplicate", "retain_conflict", "import_confirmed_events"].includes(
    input.resolution
  ))
    issues.push("Choose a supported explicit review disposition.");
  if (!Array.isArray(input.commands) || input.resolution !== "import_confirmed_events" && input.commands.length !== 0)
    issues.push(
      "Duplicate/disputed dispositions cannot also alter accepted play."
    );
  if (issues.length)
    return {
      valid: false,
      issues,
      before,
      after: null,
      earliestAffected: null,
      projectedState: null
    };
  if (input.resolution === "import_confirmed_events")
    return previewReviewedCommands(state, input.commands, {
      ...context,
      previewId: input.proposalId
    });
  try {
    assertParticipationConservation(state);
  } catch (error) {
    return {
      valid: false,
      issues: [
        error instanceof Error ? error.message : "Invalid accepted participation."
      ],
      before,
      after: null,
      earliestAffected: null,
      projectedState: null
    };
  }
  return {
    valid: true,
    issues: [],
    before,
    after: before,
    earliestAffected: null,
    projectedState: state
  };
}

// apps/api/src/finished-match-context.ts
function eligibilityEvidence(state) {
  const selected = [...state.config.selectedPlayerIds];
  const present = selected.filter((id9) => state.attendance[id9] === "present");
  const played = selected.filter(
    (id9) => state.intervals.some(
      (interval) => interval.playerId === id9 && interval.state === "playing" && interval.endMs > interval.startMs
    )
  );
  return {
    selected,
    present,
    played,
    contradictory: played.some((id9) => !present.includes(id9))
  };
}
function finishEligibilityChanged(state, original) {
  const evidence = eligibilityEvidence(state);
  const equal2 = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
  return evidence.contradictory || !equal2(evidence.selected, original.selectedPlayerIds) || !equal2(evidence.present, original.presentPlayerIds) || !equal2(evidence.played, original.playedPlayerIds);
}
function deriveFinishedMatchContext(input) {
  const { state, acceptedFinish: finish } = input;
  if (state.status !== "completed")
    throw new Error(
      "Only an explicitly completed match can establish full-time award context."
    );
  const retainedFinish = state.eventHistory?.filter((event) => event.type === "half.ended").at(-1);
  const matchesAcceptedFinish = finish?.command.type === "half.ended" && finish.eventId === retainedFinish?.id && finish.matchId === state.config.matchId && finish.controllerEpoch === input.currentControllerEpoch && finish.command.sample.monotonicMs === retainedFinish.sample.monotonicMs && finish.command.sample.sessionId === retainedFinish.sample.sessionId && finish.clockEvidence.monotonicMs === finish.command.sample.monotonicMs && finish.command.sample.sessionId === finish.clockEvidence.continuityId && input.acceptedFinishActorId !== null;
  const instant = matchesAcceptedFinish && input.mapping && input.policy && finish ? mapContinuousInstant(
    input.mapping,
    {
      accountId: input.acceptedFinishActorId,
      deviceId: finish.deviceId,
      matchId: finish.matchId,
      controllerEpoch: finish.controllerEpoch,
      continuityId: finish.command.sample.sessionId
    },
    finish.command.sample.monotonicMs,
    input.serverNowMs,
    input.policy
  ) : null;
  const trusted = !input.unresolvedConflicts && !state.recoveryRequired && instant?.quality === "trusted" && instant.utcMs <= input.serverNowMs;
  const eligibility = eligibilityEvidence(state);
  const present = eligibility.present;
  const history = state.eventHistory ?? [];
  const finishIndex = history.findIndex(
    (event) => event.id === retainedFinish?.id
  );
  let changedAfterFinish = false;
  if (finishIndex >= 0 && finishIndex < history.length - 1) {
    const atFinish = eligibilityEvidence(
      replayMatch(state.config, history.slice(0, finishIndex + 1))
    );
    changedAfterFinish = finishEligibilityChanged(state, {
      selectedPlayerIds: atFinish.selected,
      presentPlayerIds: atFinish.present,
      playedPlayerIds: atFinish.played
    });
  }
  return {
    id: state.config.matchId,
    teamId: input.teamId,
    seasonId: input.seasonId,
    label: state.config.fixture ? `${state.config.fixture.teamName} v ${state.config.fixture.opponent}` : state.config.matchId,
    // No device wall clock or upload receipt establishes the original finish.
    playedAtMs: input.scheduledAtMs,
    selectedPlayerIds: [...state.config.selectedPlayerIds],
    presentPlayerIds: present,
    playedPlayerIds: present.filter(
      (id9) => state.intervals.some(
        (interval) => interval.playerId === id9 && interval.state === "playing" && interval.endMs > interval.startMs
      )
    ),
    actualFullTimeAtMs: trusted ? instant.utcMs : null,
    finishQuality: input.unresolvedConflicts ? "conflicted" : trusted && !eligibility.contradictory && !changedAfterFinish ? "trusted" : "review_required",
    sharing: input.sharing,
    policyVersion: input.sharingPolicyVersion
  };
}

// packages/application/src/team-notifications.ts
var TEAM_NOTIFICATION_TIME_ZONE = "Europe/London";
function assert2(value, message) {
  if (!value) throw new Error(message);
}
var time2 = (value) => Number.isSafeInteger(value) && value >= 0;
var opaque = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
function createTeamNotificationJob(input) {
  assert2(input && ["id", "businessKey", "accountId", "teamId", "seasonId", "entityId"].every((field) => opaque(input[field])), "Notifications require bounded opaque identities.");
  assert2(["manager", "player", "spectator"].includes(input.audience) && ["schedule", "match", "awards", "photos"].includes(input.category) && time2(input.dueAtMs), "Invalid notification scope, category or due time.");
  assert2(input.audience === "player" ? input.playerId !== null && opaque(input.playerId) : input.playerId === null, "Player notifications require their original own-player binding.");
  return {
    id: input.id,
    businessKey: input.businessKey,
    accountId: input.accountId,
    teamId: input.teamId,
    seasonId: input.seasonId,
    audience: input.audience,
    playerId: input.playerId,
    category: input.category,
    entityId: input.entityId,
    dueAtMs: input.dueAtMs,
    schemaVersion: 1,
    revision: 0,
    state: "pending",
    attempts: 0,
    deliveryAttempts: 0,
    lease: null,
    lastCode: null,
    providerReceiptId: null,
    acceptedAtMs: null
  };
}
var londonClock = new Intl.DateTimeFormat("en-GB", { timeZone: TEAM_NOTIFICATION_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

// apps/api/src/sqlite-push-registrations.ts
var PUSH_SQLITE_MIGRATION = `
CREATE TABLE push_registrations(
 account_id TEXT NOT NULL REFERENCES accounts(id),issuer TEXT NOT NULL,device_id TEXT NOT NULL REFERENCES native_app_devices(device_id),platform TEXT NOT NULL CHECK(platform IN('ios','android')),
 transport TEXT CHECK(transport IN('apns','fcm','expo')),provider_config_id TEXT,token_ciphertext TEXT,token_digest TEXT,
 permission TEXT NOT NULL CHECK(permission IN('granted','provisional','denied')),state TEXT NOT NULL CHECK(state IN('registered','revoked')),revision INTEGER NOT NULL CHECK(revision>=1),
 app_build TEXT NOT NULL,registered_at INTEGER,updated_at INTEGER NOT NULL,revoked_at INTEGER,last_operation_id TEXT NOT NULL,
 PRIMARY KEY(account_id,device_id),CHECK((state='registered' AND token_ciphertext IS NOT NULL AND token_digest IS NOT NULL AND transport IS NOT NULL AND provider_config_id IS NOT NULL AND permission<>'denied' AND registered_at IS NOT NULL AND revoked_at IS NULL) OR(state='revoked' AND token_ciphertext IS NULL AND token_digest IS NULL AND revoked_at IS NOT NULL)));
CREATE TRIGGER push_registration_identity BEFORE UPDATE ON push_registrations WHEN NEW.account_id<>OLD.account_id OR NEW.issuer<>OLD.issuer OR NEW.device_id<>OLD.device_id OR NEW.revision<>OLD.revision+1 OR NEW.registered_at IS NOT OLD.registered_at AND OLD.registered_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'Immutable push binding or stale revision'); END;
CREATE TRIGGER push_registration_enrolment_insert BEFORE INSERT ON push_registrations WHEN NOT EXISTS(SELECT 1 FROM native_app_devices d WHERE d.device_id=NEW.device_id AND d.account_id=NEW.account_id AND d.issuer=NEW.issuer AND d.platform=NEW.platform) BEGIN SELECT RAISE(ABORT,'Enrolled push device required'); END;
CREATE TRIGGER push_registration_enrolment_update BEFORE UPDATE ON push_registrations WHEN NOT EXISTS(SELECT 1 FROM native_app_devices d WHERE d.device_id=NEW.device_id AND d.account_id=NEW.account_id AND d.issuer=NEW.issuer AND d.platform=NEW.platform) BEGIN SELECT RAISE(ABORT,'Enrolled push device required'); END;`;
var fields2 = [
  "account_id",
  "issuer",
  "device_id",
  "platform",
  "transport",
  "provider_config_id",
  "token_ciphertext",
  "token_digest",
  "permission",
  "state",
  "revision",
  "app_build",
  "registered_at",
  "updated_at",
  "revoked_at",
  "last_operation_id"
];
var SqlitePushRepository = class {
  constructor(database, transaction) {
    this.database = database;
    this.transaction = transaction;
  }
  database;
  transaction;
  async enrolled(principal, deviceId) {
    return this.database.prepare(
      "SELECT platform FROM native_app_devices WHERE device_id=? AND account_id=? AND issuer=?"
    ).get(deviceId, principal.accountId, principal.issuer) ?? null;
  }
  async current(principal, deviceId) {
    return this.database.prepare(
      "SELECT * FROM push_registrations WHERE account_id=? AND issuer=? AND device_id=?"
    ).get(
      principal.accountId,
      principal.issuer,
      deviceId
    ) ?? null;
  }
  async list(principal) {
    return this.database.prepare(
      "SELECT * FROM push_registrations WHERE account_id=? AND issuer=? ORDER BY device_id"
    ).all(principal.accountId, principal.issuer);
  }
  async save(principal, row, expectedRevision) {
    if (row.account_id !== principal.accountId || row.issuer !== principal.issuer)
      throw new Error("PUSH_ACCOUNT_SCOPE_REQUIRED");
    const values = fields2.map((field) => row[field]);
    if (expectedRevision === 0)
      return Number(
        this.database.prepare(
          `INSERT INTO push_registrations(${fields2.join(",")}) VALUES(${fields2.map(() => "?").join(",")}) ON CONFLICT(account_id,device_id) DO NOTHING`
        ).run(...values).changes
      ) === 1;
    const updated = fields2.filter(
      (field) => !["account_id", "issuer", "device_id"].includes(field)
    );
    return Number(
      this.database.prepare(
        `UPDATE push_registrations SET ${updated.map((field) => `${field}=?`).join(",")} WHERE account_id=? AND issuer=? AND device_id=? AND revision=?`
      ).run(
        ...updated.map((field) => row[field]),
        principal.accountId,
        principal.issuer,
        row.device_id,
        expectedRevision
      ).changes
    ) === 1;
  }
  async deliveryTargets(accountId) {
    return this.database.prepare(
      "SELECT p.* FROM push_registrations p JOIN native_app_devices d ON d.device_id=p.device_id AND d.account_id=p.account_id AND d.issuer=p.issuer AND d.platform=p.platform JOIN accounts a ON a.id=p.account_id AND a.issuer=p.issuer AND a.status='active' WHERE p.account_id=? AND p.state='registered' AND p.permission IN('granted','provisional') ORDER BY p.device_id"
    ).all(accountId);
  }
};

// packages/application/src/staff.ts
var current2 = (item, nowMs) => item.revokedAt == null && (item.expiresAt == null || item.expiresAt > nowMs);
var eligible = (account3) => account3.status === "active" && account3.identityClassification === "adult_individual" && account3.adultVerified && account3.strongAuthEnrolled;
function managerRoster(input) {
  const { principal, memberships, accounts, teamId, seasonId, nowMs } = input;
  if (input.requestedRole && input.requestedRole !== "administrator") throw new AccessError("NOT_FOUND", 404, "Choose the current administrator context for staff management.");
  assertTeamRole(principal, memberships, teamId, seasonId, ["administrator"], nowMs);
  assertAdultAuthority(principal, false, nowMs);
  if (!Number.isSafeInteger(input.revision) || input.revision < 0 || !Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Use the authoritative staff revision and current service time.");
  const associated = new Set(memberships.filter((item) => item.teamId === teamId && current2(item, nowMs)).map((item) => item.accountId));
  const liveManagers = memberships.filter((item) => item.teamId === teamId && item.role === "manager" && current2(item, nowMs));
  const managers = memberships.filter((item) => item.teamId === teamId && item.seasonId === seasonId && item.role === "manager").map((item) => {
    const account3 = accounts.find((account4) => account4.accountId === item.accountId);
    return {
      accountId: item.accountId,
      label: account3 && account3.identityClassification === "adult_individual" && account3.adultVerified ? account3.label : "Unavailable manager account",
      status: !account3 || !eligible(account3) ? "disabled" : item.revokedAt != null ? "revoked" : item.expiresAt != null && item.expiresAt <= nowMs ? "expired" : "active",
      expiresAt: item.expiresAt ?? null,
      revokedAt: item.revokedAt ?? null,
      otherActiveSeasonIds: [...new Set(liveManagers.filter((other) => other.accountId === item.accountId && other.seasonId !== seasonId).map((other) => other.seasonId))].sort()
    };
  }).sort((a, b) => a.label.localeCompare(b.label) || a.accountId.localeCompare(b.accountId));
  const candidates = accounts.filter((account3) => associated.has(account3.accountId) && eligible(account3)).map((account3) => ({ accountId: account3.accountId, label: account3.label, currentManager: liveManagers.some((item) => item.accountId === account3.accountId && item.seasonId === seasonId) })).sort((a, b) => a.label.localeCompare(b.label) || a.accountId.localeCompare(b.accountId));
  return { kind: "manager-roster", revision: input.revision, teamId, seasonId, asOf: new Date(nowMs).toISOString(), maximumManagers: 4, activeTeamManagerCount: new Set(liveManagers.map((item) => item.accountId)).size, canMutate: principal.authenticatedAt <= nowMs + 3e4 && nowMs - principal.authenticatedAt <= 3e5, managers, candidates };
}

// packages/application/src/privacy-requests.ts
var object3 = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
var opaque2 = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(value);
function requireThat5(condition, message) {
  if (!condition) throw new AccessError("INVALID_REQUEST", 400, message);
}
function fields3(value, names) {
  requireThat5(Object.keys(value).length === names.length && Object.keys(value).every((key) => names.includes(key)), "Use only the documented account request fields.");
}
function active(principal) {
  if (principal.status !== "active") throw new AccessError("ACCOUNT_UNAVAILABLE", 403, "Use an active signed-in account to review or submit its own requests.");
}
function validTime4(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function parsePrivacyRequestInput(value) {
  requireThat5(object3(value), "Choose a scoped account request.");
  if (value.kind === "leave_team") {
    fields3(value, ["kind", "teamId", "seasonId", "confirmLeave"]);
    requireThat5(opaque2(value.teamId) && opaque2(value.seasonId) && value.confirmLeave === true, "Explicitly confirm the selected team and season leave request.");
    return { kind: "leave_team", teamId: value.teamId, seasonId: value.seasonId, confirmLeave: true };
  }
  fields3(value, ["kind", "scope", "confirmAllMemberships"]);
  requireThat5((value.kind === "export" || value.kind === "delete_account") && value.scope === "all_memberships" && value.confirmAllMemberships === true, "Explicitly confirm that this global account request covers every membership.");
  return { kind: value.kind, scope: "all_memberships", confirmAllMemberships: true };
}
function parseScope(value) {
  if (value === null) return null;
  requireThat5(object3(value), "Invalid retained account request scope.");
  if (value.type === "all_memberships") {
    fields3(value, ["type"]);
    return { type: "all_memberships" };
  }
  fields3(value, ["type", "teamId", "seasonId"]);
  requireThat5(value.type === "team_season" && opaque2(value.teamId) && opaque2(value.seasonId), "Invalid retained team and season scope.");
  return { type: "team_season", teamId: value.teamId, seasonId: value.seasonId };
}
function privacyRequestBusinessKey(accountId, kind2, scope) {
  requireThat5(opaque2(accountId) && ["export", "delete_account", "leave_team"].includes(kind2), "A stable own-account request scope is required.");
  const checked = parseScope(scope);
  requireThat5(kind2 === "leave_team" ? checked.type === "team_season" : checked.type === "all_memberships", "The request kind and scope differ.");
  return JSON.stringify(checked.type === "team_season" ? [accountId, kind2, checked.type, checked.teamId, checked.seasonId] : [accountId, kind2, checked.type]);
}
function ownPrivacyMemberships(principal, memberships, nowMs) {
  active(principal);
  requireThat5(validTime4(nowMs), "Use the current service time.");
  return memberships.filter((item) => item.accountId === principal.accountId).map((item) => ({
    teamId: item.teamId,
    seasonId: item.seasonId,
    role: item.role,
    playerId: item.playerId ?? null,
    status: item.revokedAt != null ? "revoked" : item.expiresAt != null && item.expiresAt <= nowMs ? "expired" : "active"
  })).sort((a, b) => a.teamId.localeCompare(b.teamId) || a.seasonId.localeCompare(b.seasonId) || a.role.localeCompare(b.role));
}
function prepareAccountPrivacyRequest(input) {
  const command = parsePrivacyRequestInput(input.input), own = ownPrivacyMemberships(input.principal, input.memberships, input.nowMs);
  const scope = command.kind === "leave_team" ? { type: "team_season", teamId: command.teamId, seasonId: command.seasonId } : { type: "all_memberships" };
  const affectedMemberships = scope.type === "all_memberships" ? own : own.filter((item) => item.teamId === scope.teamId && item.seasonId === scope.seasonId && item.status === "active");
  if (scope.type === "team_season" && !affectedMemberships.length) throw new AccessError("NOT_FOUND", 404, "The selected current own membership is unavailable.");
  return {
    accountId: input.principal.accountId,
    kind: command.kind,
    scope,
    businessKey: privacyRequestBusinessKey(input.principal.accountId, command.kind, scope),
    affectedMemberships,
    status: "pending_verification_and_policy",
    verificationRequired: true,
    erased: false,
    fulfilled: false
  };
}
function parseMembership(value) {
  requireThat5(object3(value), "Invalid affected membership.");
  fields3(value, ["teamId", "seasonId", "role", "playerId", "status"]);
  requireThat5(opaque2(value.teamId) && opaque2(value.seasonId) && ["administrator", "manager", "player", "spectator"].includes(value.role) && (value.playerId === null || opaque2(value.playerId)) && ["active", "expired", "revoked"].includes(value.status), "Invalid affected membership fields.");
  return { teamId: value.teamId, seasonId: value.seasonId, role: value.role, playerId: value.playerId, status: value.status };
}
function parsePrivacyRequestDto(value) {
  requireThat5(object3(value), "Invalid account request response.");
  fields3(value, ["requestId", "kind", "status", "scope", "affectedMemberships", "createdAtMs", "verificationRequired", "erased", "fulfilled", "scopeStatus", "reviewStatus", "duplicateOfRequestId"]);
  requireThat5(opaque2(value.requestId) && ["export", "delete_account", "leave_team"].includes(value.kind) && ["pending_verification_and_policy", "needs_scope"].includes(value.status) && validTime4(value.createdAtMs), "Invalid account request status or identity.");
  requireThat5(value.verificationRequired === true && value.erased === false && value.fulfilled === false && (value.duplicateOfRequestId === null || opaque2(value.duplicateOfRequestId)), "A pending request never establishes fulfilment or deletion.");
  const scope = parseScope(value.scope), kind2 = value.kind;
  requireThat5(scope === null || (kind2 === "leave_team" ? scope.type === "team_season" : scope.type === "all_memberships"), "The account request kind and scope differ.");
  requireThat5(value.scopeStatus === (scope === null ? "needs_scope" : "recorded") && value.reviewStatus === (scope === null || value.status === "needs_scope" ? "needs_scope" : value.duplicateOfRequestId === null ? "pending_verification_and_policy" : "duplicate_requires_review"), "The account request review status is inconsistent.");
  requireThat5(value.affectedMemberships === null || Array.isArray(value.affectedMemberships), "The confirmed membership snapshot is missing or invalid.");
  const affectedMemberships = value.affectedMemberships === null ? null : value.affectedMemberships.map(parseMembership);
  requireThat5(scope?.type !== "team_season" || affectedMemberships === null || affectedMemberships.every((item) => item.teamId === scope.teamId && item.seasonId === scope.seasonId), "The affected membership snapshot crosses the selected leave scope.");
  return { requestId: value.requestId, kind: kind2, status: value.status, scope, affectedMemberships, createdAtMs: value.createdAtMs, verificationRequired: true, erased: false, fulfilled: false, scopeStatus: value.scopeStatus, reviewStatus: value.reviewStatus, duplicateOfRequestId: value.duplicateOfRequestId };
}
function projectAccountPrivacyRequests(input) {
  const memberships = ownPrivacyMemberships(input.principal, input.memberships, input.nowMs), canonical6 = /* @__PURE__ */ new Map();
  const items = input.records.filter((item) => item.accountId === input.principal.accountId).sort((a, b) => a.createdAtMs - b.createdAtMs || a.requestId.localeCompare(b.requestId)).map((record2) => {
    const scope = parseScope(record2.scope);
    const key = scope && record2.status === "pending_verification_and_policy" ? privacyRequestBusinessKey(record2.accountId, record2.kind, scope) : null;
    const duplicateOfRequestId = key ? canonical6.get(key) ?? null : null;
    if (key && !canonical6.has(key)) canonical6.set(key, record2.requestId);
    return parsePrivacyRequestDto({
      requestId: record2.requestId,
      kind: record2.kind,
      status: record2.status,
      scope,
      affectedMemberships: record2.affectedMemberships,
      createdAtMs: record2.createdAtMs,
      verificationRequired: true,
      erased: false,
      fulfilled: false,
      scopeStatus: scope === null ? "needs_scope" : "recorded",
      duplicateOfRequestId,
      reviewStatus: scope === null || record2.status === "needs_scope" ? "needs_scope" : duplicateOfRequestId ? "duplicate_requires_review" : "pending_verification_and_policy"
    });
  });
  return { accountId: input.principal.accountId, memberships, items };
}

// apps/api/src/brand-repository.ts
function brandSelectedRole(principal, memberships, teamId, seasonId, role, nowMs) {
  const own = currentMemberships(principal, memberships, nowMs).filter((member) => member.teamId === teamId && member.seasonId === seasonId);
  const chosen = role ?? ["manager", "player", "spectator", "administrator"].find((candidate) => own.some((member) => member.role === candidate));
  if (!chosen || !["manager", "player", "spectator", "administrator"].includes(chosen)) throw new AccessError("NOT_FOUND", 404, "The requested branding is unavailable.");
  assertTeamRole(principal, memberships, teamId, seasonId, [chosen], nowMs);
  return chosen;
}
var mapBrandSlot = (row) => ({ kind: row.kind, clubId: String(row.club_id), teamId: row.team_id === null ? null : String(row.team_id), version: Number(row.version), assetId: row.asset_id === null ? null : String(row.asset_id), assetRevision: row.asset_revision === null ? null : Number(row.asset_revision), reviewedRevision: row.reviewed_revision === null ? null : Number(row.reviewed_revision), policyVersion: row.policy_version === null ? null : String(row.policy_version), confirmedBy: row.confirmed_by === null ? null : String(row.confirmed_by), confirmedAt: row.confirmed_at === null ? null : Number(row.confirmed_at) });
function migrateHeicBrandAssets(database) {
  const definition = database.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='brand_assets'").get()?.sql;
  if (typeof definition !== "string" || definition.includes("'image/heic'")) return;
  if (!definition.includes("'image/jpeg','image/png'")) throw new Error("UNKNOWN_BRAND_ASSET_SCHEMA");
  const foreignKeys = Number(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys) === 1;
  const extras = database.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name='brand_assets' AND type IN('index','trigger') AND sql IS NOT NULL").all();
  const columns = database.prepare("PRAGMA table_xinfo(brand_assets)").all().filter((column) => Number(column.hidden) === 0).map((column) => `"${String(column.name).replaceAll('"', '""')}"`).join(",");
  database.exec("PRAGMA foreign_keys=OFF");
  if (Number(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys) !== 0) throw new Error("BRAND_MIGRATION_REQUIRES_IDLE_DATABASE");
  let began = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    began = true;
    database.exec(definition.replace(/CREATE TABLE(?: IF NOT EXISTS)?\s+"?brand_assets"?/i, "CREATE TABLE brand_assets_heic").replace("'image/jpeg','image/png'", "'image/jpeg','image/png','image/heic'"));
    database.exec(`INSERT INTO brand_assets_heic(${columns}) SELECT ${columns} FROM brand_assets`);
    database.exec("DROP TABLE brand_assets; ALTER TABLE brand_assets_heic RENAME TO brand_assets");
    for (const extra of extras) database.exec(String(extra.sql));
    if (database.prepare("PRAGMA foreign_key_check").all().length) throw new Error("BRAND_MIGRATION_ANCESTRY_FAILED");
    database.exec("COMMIT");
    began = false;
  } catch (error) {
    if (began) database.exec("ROLLBACK");
    throw error;
  } finally {
    if (foreignKeys) database.exec("PRAGMA foreign_keys=ON");
  }
}
var SqliteBrandRepository = class {
  constructor(database, transaction) {
    this.database = database;
    this.transaction = transaction;
    database.exec(`CREATE TABLE IF NOT EXISTS branding_clubs(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS branding_teams(team_id TEXT PRIMARY KEY REFERENCES teams(id),club_id TEXT NOT NULL REFERENCES branding_clubs(id),UNIQUE(club_id,team_id));
      CREATE TABLE IF NOT EXISTS brand_assets(id TEXT PRIMARY KEY,asset_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),kind TEXT NOT NULL CHECK(kind IN('club_logo','team_logo')),club_id TEXT NOT NULL REFERENCES branding_clubs(id),team_id TEXT,season_id TEXT CHECK(season_id IS NULL),match_id TEXT CHECK(match_id IS NULL),owner_id TEXT NOT NULL REFERENCES accounts(id),request_id TEXT NOT NULL,request_signature TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('prepared','uploading','uploaded','processing','processed','linked','rejected')),expected_bytes INTEGER NOT NULL CHECK(expected_bytes BETWEEN 1 AND 15728640),expected_sha TEXT NOT NULL,declared_mime TEXT NOT NULL CHECK(declared_mime IN('image/jpeg','image/png','image/heic')),token_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,processed_at INTEGER,original_key TEXT,display_key TEXT,thumbnail_key TEXT,width INTEGER,height INTEGER,scanner_engine TEXT,failure_code TEXT,attempt TEXT,lease_until INTEGER,scope_key TEXT GENERATED ALWAYS AS (COALESCE(team_id,'')) STORED,
      CHECK((kind='club_logo' AND team_id IS NULL) OR(kind='team_logo' AND team_id IS NOT NULL)),UNIQUE(owner_id,request_id),UNIQUE(asset_id,revision),UNIQUE(asset_id,revision,kind,club_id,scope_key),FOREIGN KEY(club_id,team_id) REFERENCES branding_teams(club_id,team_id));
      CREATE TABLE IF NOT EXISTS brand_slots(kind TEXT NOT NULL CHECK(kind IN('club_logo','team_logo')),club_id TEXT NOT NULL REFERENCES branding_clubs(id),team_id TEXT,scope_key TEXT GENERATED ALWAYS AS(COALESCE(team_id,'')) STORED,version INTEGER NOT NULL CHECK(version>=0),asset_id TEXT,asset_revision INTEGER,reviewed_revision INTEGER,policy_version TEXT,confirmed_by TEXT REFERENCES accounts(id),confirmed_at INTEGER,
      CHECK((kind='club_logo' AND team_id IS NULL) OR(kind='team_logo' AND team_id IS NOT NULL)),CHECK((asset_id IS NULL AND asset_revision IS NULL AND reviewed_revision IS NULL) OR(asset_id IS NOT NULL AND asset_revision>0 AND reviewed_revision=asset_revision)),UNIQUE(kind,club_id,scope_key),FOREIGN KEY(club_id,team_id) REFERENCES branding_teams(club_id,team_id),FOREIGN KEY(asset_id,asset_revision,kind,club_id,scope_key) REFERENCES brand_assets(asset_id,revision,kind,club_id,scope_key));`);
    migrateHeicBrandAssets(database);
  }
  database;
  transaction;
  async ensureScope(authority) {
    this.database.prepare("INSERT INTO branding_clubs(id) VALUES(?) ON CONFLICT DO NOTHING").run(authority.context.clubId);
    this.database.prepare("INSERT INTO branding_teams(team_id,club_id) VALUES(?,?) ON CONFLICT DO NOTHING").run(authority.context.teamId, authority.context.clubId);
    const row = this.database.prepare("SELECT club_id FROM branding_teams WHERE team_id=?").get(authority.context.teamId);
    if (row?.club_id !== authority.context.clubId) throw new Error("BRANDING_ANCESTRY_CONFLICT");
  }
  async byRequest(owner, request) {
    return this.database.prepare("SELECT * FROM brand_assets WHERE owner_id=? AND request_id=?").get(owner, request);
  }
  async upload(id9) {
    return this.database.prepare("SELECT * FROM brand_assets WHERE id=?").get(id9);
  }
  async asset(id9, revision) {
    return this.database.prepare("SELECT * FROM brand_assets WHERE asset_id=? AND revision=?").get(id9, revision);
  }
  async own(owner, club, team) {
    return this.database.prepare("SELECT * FROM brand_assets WHERE owner_id=? AND club_id=? AND(team_id IS NULL OR team_id=?) ORDER BY created_at DESC,id").all(owner, club, team);
  }
  async create(row) {
    const columns = Object.keys(row);
    this.database.prepare(`INSERT INTO brand_assets(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...Object.values(row));
  }
  async rotateToken(id9, hash6) {
    return this.database.prepare("UPDATE brand_assets SET token_hash=? WHERE id=?").run(hash6, id9).changes === 1;
  }
  async lease(id9, stage, attempt2, now) {
    const from = stage === "uploading" ? "prepared" : "uploaded";
    return this.database.prepare("UPDATE brand_assets SET status=?,attempt=?,lease_until=?,failure_code=NULL WHERE id=? AND(status=? OR(status=? AND lease_until<?))").run(stage, attempt2, now + 65e3, id9, from, stage, now).changes === 1;
  }
  async uploaded(id9, attempt2, key) {
    return this.database.prepare("UPDATE brand_assets SET status='uploaded',original_key=?,lease_until=NULL,failure_code=NULL WHERE id=? AND attempt=? AND status='uploading'").run(key, id9, attempt2).changes === 1;
  }
  async processed(id9, attempt2, value) {
    return this.database.prepare("UPDATE brand_assets SET status='processed',display_key=?,thumbnail_key=?,width=?,height=?,scanner_engine=?,processed_at=?,lease_until=NULL,failure_code=NULL WHERE id=? AND attempt=? AND status='processing'").run(value.displayKey, value.thumbnailKey, value.width, value.height, value.scannerEngine, value.at, id9, attempt2).changes === 1;
  }
  async failed(id9, attempt2, stage, code, retryable) {
    this.database.prepare("UPDATE brand_assets SET status=?,failure_code=?,lease_until=NULL WHERE id=? AND attempt=? AND status=?").run(retryable ? stage === "uploading" ? "prepared" : "uploaded" : "rejected", code, id9, attempt2, stage);
  }
  async slot(kind2, club, team) {
    const row = this.database.prepare("SELECT * FROM brand_slots WHERE kind=? AND club_id=? AND team_id IS ?").get(kind2, club, team);
    return row ? mapBrandSlot(row) : void 0;
  }
  async setSlot(slot, expected) {
    this.database.prepare("INSERT INTO brand_slots(kind,club_id,team_id,version) VALUES(?,?,?,0) ON CONFLICT DO NOTHING").run(slot.kind, slot.clubId, slot.teamId);
    return this.database.prepare("UPDATE brand_slots SET version=?,asset_id=?,asset_revision=?,reviewed_revision=?,policy_version=?,confirmed_by=?,confirmed_at=? WHERE kind=? AND club_id=? AND team_id IS ? AND version=?").run(slot.version, slot.assetId, slot.assetRevision, slot.reviewedRevision, slot.policyVersion, slot.confirmedBy, slot.confirmedAt, slot.kind, slot.clubId, slot.teamId, expected).changes === 1;
  }
  async linked(id9) {
    const updated = this.database.prepare("UPDATE brand_assets SET status='linked' WHERE id=? AND status IN('processed','linked')").run(id9);
    if (updated.changes !== 1) throw new Error("BRAND_LINK_CONFLICT");
  }
};

// packages/application/src/account-devices.ts
var object4 = (v) => Boolean(v && typeof v === "object" && !Array.isArray(v));
var opaque3 = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(v);
var iso2 = (v) => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
function fields4(value, keys2) {
  if (Object.keys(value).length !== keys2.length || Object.keys(value).some((key) => !keys2.includes(key)))
    throw new Error("Invalid own device inventory fields.");
}
function parseAccountDevicesDto(value) {
  if (!object4(value)) throw new Error("Invalid own device inventory.");
  fields4(value, [
    "kind",
    "accountId",
    "asOf",
    "devices",
    "remoteRevocationAvailable"
  ]);
  if (value.kind !== "recognised-devices" || !opaque3(value.accountId) || !iso2(value.asOf) || !Array.isArray(value.devices) || value.remoteRevocationAvailable !== false)
    throw new Error("Invalid own device inventory.");
  const seen = /* @__PURE__ */ new Set();
  const devices = value.devices.map((item) => {
    if (!object4(item)) throw new Error("Invalid device entry.");
    fields4(item, [
      "deviceId",
      "source",
      "label",
      "platform",
      "platformVerified",
      "registeredAt",
      "lastSeenAt"
    ]);
    if (!opaque3(item.deviceId) || seen.has(item.deviceId) || !["native_app_enrolment", "match_controller_enrolment"].includes(
      item.source
    ) || item.label !== null || ![null, "ios", "android"].includes(item.platform) || item.platformVerified !== false || item.registeredAt !== null && !iso2(item.registeredAt) || item.lastSeenAt !== null && !iso2(item.lastSeenAt))
      throw new Error("Invalid device entry metadata.");
    if (item.source === "native_app_enrolment" && (item.platform === null || item.registeredAt === null || item.lastSeenAt === null))
      throw new Error("Native enrolment requires actual service timestamps.");
    if (item.source === "match_controller_enrolment" && (item.platform !== null || item.registeredAt !== null || item.lastSeenAt !== null))
      throw new Error("Legacy recorder metadata is unknown.");
    if (item.registeredAt && item.lastSeenAt && Date.parse(item.lastSeenAt) < Date.parse(item.registeredAt))
      throw new Error("Device timestamps are inconsistent.");
    seen.add(item.deviceId);
    return item;
  });
  return {
    kind: "recognised-devices",
    accountId: value.accountId,
    asOf: value.asOf,
    devices,
    remoteRevocationAvailable: false
  };
}

// apps/api/src/devices.ts
function parseNativeDeviceInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AccessError("INVALID_REQUEST", 400, "Use the reported native installation identity and platform.");
  const item = value;
  if (Object.keys(item).length !== 2 || Object.keys(item).some((key) => !["deviceId", "platform"].includes(key)) || typeof item.deviceId !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(item.deviceId) || !["ios", "android"].includes(String(item.platform))) throw new AccessError("INVALID_REQUEST", 400, "Use a canonical installation identity and reported iOS or Android platform.");
  return { deviceId: item.deviceId, platform: item.platform };
}
function ownDevicesDto(principal, legacy, native, nowMs) {
  if (legacy.some((row) => row.account_id !== principal.accountId) || native.some((row) => row.account_id !== principal.accountId || row.issuer !== principal.issuer)) throw new Error("OWN_DEVICE_SCOPE_REQUIRED");
  const nativeIds = new Set(native.map((row) => row.device_id));
  return parseAccountDevicesDto({ kind: "recognised-devices", accountId: principal.accountId, asOf: new Date(nowMs).toISOString(), devices: [...native.map((row) => ({ deviceId: row.device_id, source: "native_app_enrolment", label: null, platform: row.platform, platformVerified: false, registeredAt: new Date(row.registered_at).toISOString(), lastSeenAt: new Date(row.last_seen_at).toISOString() })), ...legacy.filter((row) => !nativeIds.has(row.id)).map((row) => ({ deviceId: row.id, source: "match_controller_enrolment", label: null, platform: null, platformVerified: false, registeredAt: null, lastSeenAt: null }))], remoteRevocationAvailable: false });
}

// apps/api/src/store.ts
var EVENT_CONTRACT_VERSION = "longball.events/1.1";
var SYNTHETIC_IDS = { teamId: "synthetic-roma-u10", seasonId: "synthetic-season-2026-27", matchId: "synthetic-roma-maple-2026-10-24" };
function canonical4(value) {
  if (Array.isArray(value)) return `[${value.map(canonical4).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical4(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
var digest = (value) => createHash2("sha256").update(value).digest("hex");
var validId3 = (value) => typeof value === "string" && value.length > 0 && value.length <= 150 && /^[a-zA-Z0-9_-]+$/.test(value);
var validDeviceId = (value) => validId3(value) && value.length <= 120;
var nonnegative3 = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function bad(message) {
  throw new AccessError("INVALID_REQUEST", 400, message);
}
function validateEnvelope(value, matchId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) bad("An event envelope is required.");
  const item = value;
  if (!validId3(item.eventId) || !validDeviceId(item.deviceId) || item.matchId !== matchId || !nonnegative3(item.clientSequence) || item.clientSequence < 1 || !nonnegative3(item.controllerEpoch) || item.controllerEpoch < 1 || !nonnegative3(item.baseRevision)) bad("Invalid event identity, scope or sequence.");
  if (!(item.previousEventId === null || validId3(item.previousEventId))) bad("Invalid previous event identifier.");
  if (item.contractVersion !== EVENT_CONTRACT_VERSION || item.schemaVersion !== 1 || item.engineVersion !== ENGINE_VERSION) return item;
  const fields8 = ["contractVersion", "schemaVersion", "engineVersion", "eventId", "matchId", "deviceId", "controllerEpoch", "clientSequence", "previousEventId", "baseRevision", "effectiveHalf", "halfElapsedMs", "matchElapsedMs", "effectiveAt", "recordedAt", "timeQuality", "clockEvidence", "command"];
  if (Object.keys(item).some((key) => !fields8.includes(key))) bad("Unknown event envelope fields are not accepted.");
  if (!nonnegative3(item.halfElapsedMs) || !nonnegative3(item.matchElapsedMs) || ![0, 1, 2].includes(item.effectiveHalf)) bad("Invalid effective playing-time boundary.");
  if (!["anchored", "estimated", "reviewRequired"].includes(item.timeQuality) || !Number.isFinite(Date.parse(item.recordedAt)) || !(item.effectiveAt === null || Number.isFinite(Date.parse(item.effectiveAt)))) bad("Invalid event time evidence.");
  const command = item.command;
  if (!command || typeof command !== "object" || command.id !== item.eventId || !command.sample || !Number.isFinite(command.sample.monotonicMs) || command.sample.monotonicMs < 0 || !validId3(command.sample.sessionId) || !nonnegative3(command.sample.wallTimeMs)) bad("Invalid versioned match command.");
  if (!item.clockEvidence || item.clockEvidence.monotonicMs !== command.sample.monotonicMs || !validId3(item.clockEvidence.anchorId) || !(item.clockEvidence.continuityId === null || validId3(item.clockEvidence.continuityId))) bad("Explicit clock evidence is required.");
  const commandTypes = ["attendance.recorded", "availability.changed", "lineup.staged", "half.started", "half.paused", "half.resumed", "half.ended", "lineup.committed", "goal.recorded", "clock.recovery_required", "clock.corrected", "event.corrected", "event.voided", "policy.changed", "match.abandoned"];
  if (!commandTypes.includes(command.type)) bad("Unsupported match command.");
  if (command.type === "goal.recorded" && !["us", "opposition"].includes(command.beneficiary)) bad("Invalid goal side.");
  if (command.type === "attendance.recorded" && (!validId3(command.playerId) || !["present", "absent", "excused", "not_selected", "not_recorded"].includes(command.status))) bad("Invalid attendance.");
  if (command.type === "availability.changed" && (!validId3(command.playerId) || typeof command.available !== "boolean")) bad("Invalid availability.");
  if ((command.type === "lineup.staged" || command.type === "lineup.committed") && (!Array.isArray(command.lineup) || command.lineup.length > 11 || command.lineup.some((item2) => !validId3(item2.playerId) || !validId3(item2.slotId) || typeof item2.position !== "string" || item2.position.length > 30))) bad("Invalid lineup allocations.");
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
      if (version > 10) throw new Error("This store version is newer than this application; preserve it and use a compatible build.");
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
      if (version < 6) this.database.exec(`
      CREATE TABLE clock_challenges(id TEXT PRIMARY KEY,match_id TEXT NOT NULL REFERENCES matches(id),account_id TEXT NOT NULL REFERENCES accounts(id),challenge_json TEXT NOT NULL,consumed_at INTEGER);
      CREATE TABLE clock_mappings(challenge_id TEXT PRIMARY KEY REFERENCES clock_challenges(id),match_id TEXT NOT NULL REFERENCES matches(id),mapping_json TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE reconciliation_proposals(id TEXT PRIMARY KEY,match_id TEXT NOT NULL REFERENCES matches(id),actor_id TEXT NOT NULL REFERENCES accounts(id),signature TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at INTEGER NOT NULL);
      PRAGMA user_version=6;
    `);
      if (version < 7) this.database.exec(`
      ALTER TABLE privacy_requests ADD COLUMN team_id TEXT REFERENCES teams(id);
      ALTER TABLE privacy_requests ADD COLUMN season_id TEXT;
      ALTER TABLE privacy_requests ADD COLUMN affected_memberships_json TEXT;
      UPDATE privacy_requests SET status='needs_scope' WHERE kind='leave_team' AND status='pending_verification_and_policy' AND (team_id IS NULL OR season_id IS NULL);
      CREATE TABLE privacy_pending_keys(business_key TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE REFERENCES privacy_requests(id));
      INSERT INTO privacy_pending_keys(business_key,request_id)
        SELECT json_array(account_id,kind,'all_memberships'),id FROM (
          SELECT id,account_id,kind,ROW_NUMBER() OVER(PARTITION BY account_id,kind ORDER BY created_at,id) AS n
          FROM privacy_requests WHERE status='pending_verification_and_policy' AND kind IN ('export','delete_account')
        ) WHERE n=1;
      PRAGMA user_version=7;
    `);
      if (version < 8) this.database.exec(`CREATE TABLE native_app_devices(device_id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),issuer TEXT NOT NULL,platform TEXT NOT NULL CHECK(platform IN('ios','android')),registered_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL CHECK(last_seen_at>=registered_at));
      CREATE TRIGGER native_device_identity_immutable BEFORE UPDATE ON native_app_devices WHEN NEW.device_id<>OLD.device_id OR NEW.account_id<>OLD.account_id OR NEW.issuer<>OLD.issuer OR NEW.registered_at<>OLD.registered_at BEGIN SELECT RAISE(ABORT,'Immutable native device identity'); END;
      PRAGMA user_version=8;`);
      if (version < 9) this.database.exec(SQLITE_TEAM_PRIVILEGES_DDL + "PRAGMA user_version=9;");
      if (version < 10) this.database.exec(PUSH_SQLITE_MIGRATION + "PRAGMA user_version=10;");
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
      const add2 = (id9, classification, adult) => this.database.prepare("INSERT INTO accounts(id,issuer,subject,classification,adult_verified,strong_auth_enrolled) VALUES(?,?,?,?,?,?)").run(id9, "urn:longball:synthetic", id9, classification, Number(adult), Number(adult));
      const membership = (id9, role, playerId = null, teamId = SYNTHETIC_IDS.teamId) => this.database.prepare("INSERT INTO memberships(account_id,team_id,season_id,role,player_id) VALUES(?,?,?,?,?)").run(id9, teamId, SYNTHETIC_IDS.seasonId, role, playerId);
      add2("synthetic-account-admin", "adult_individual", true);
      membership("synthetic-account-admin", "administrator");
      for (let number = 1; number <= 5; number++) {
        const id9 = number === 1 ? "synthetic-account-manager" : `synthetic-account-manager-${number}`;
        add2(id9, "adult_individual", true);
        if (number <= 4) membership(id9, "manager");
        if (number === 1) membership(id9, "administrator");
      }
      for (let number = 1; number <= 13; number++) {
        const suffix = String(number).padStart(2, "0");
        const id9 = `synthetic-account-player-${suffix}`;
        add2(id9, "child_shared", false);
        membership(id9, "player", `synthetic-player-${suffix}`);
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
        const id9 = `synthetic-account-manager-${number}`;
        community.accounts.push({ id: id9, label: `Fictional manager ${number}`, classification: "adult_individual", adultVerified: true });
        community.memberships.push({ accountId: id9, teamId: SYNTHETIC_IDS.teamId, seasonId: SYNTHETIC_IDS.seasonId, role: "manager", active: true });
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
    const account3 = this.database.prepare("SELECT * FROM accounts WHERE issuer=? AND subject=?").get(identity.issuer, identity.subject);
    if (!account3 || account3.status !== "active") throw new AccessError("ACCOUNT_UNAVAILABLE", 403, "The account is not active for this service.");
    return { accountId: account3.id, issuer: account3.issuer, subject: account3.subject, identityClassification: account3.classification, adultVerified: Boolean(account3.adult_verified), strongAuth: identity.strongAuth, authenticatedAt: identity.authenticatedAt, status: account3.status };
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
  recognisedDevices(principal) {
    const legacy = this.database.prepare("SELECT id,account_id FROM devices WHERE account_id=? ORDER BY id").all(principal.accountId);
    const native = this.database.prepare("SELECT * FROM native_app_devices WHERE account_id=? AND issuer=? ORDER BY registered_at,device_id").all(principal.accountId, principal.issuer);
    return ownDevicesDto(principal, legacy, native, this.now());
  }
  enrolDevice(principal, input) {
    const parsed = parseNativeDeviceInput(input);
    if (this.database.prepare("SELECT id FROM devices WHERE id=? AND account_id=?").get(parsed.deviceId, principal.accountId)) throw new AccessError("DEVICE_ID_CONFLICT", 409, "Use a separate installation identity for sign-in recognition.");
    const previous = this.database.prepare("SELECT account_id,issuer FROM native_app_devices WHERE device_id=?").get(parsed.deviceId);
    if (previous && (previous.account_id !== principal.accountId || previous.issuer !== principal.issuer)) throw new AccessError("DEVICE_ID_CONFLICT", 409, "This installation identity is unavailable.");
    this.database.prepare("INSERT INTO native_app_devices(device_id,account_id,issuer,platform,registered_at,last_seen_at) VALUES(?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET platform=excluded.platform,last_seen_at=MAX(native_app_devices.last_seen_at,excluded.last_seen_at)").run(parsed.deviceId, principal.accountId, principal.issuer, parsed.platform, this.now(), this.now());
    return this.recognisedDevices(principal);
  }
  brandingContext(principal, teamId, seasonId, role) {
    const memberships = this.memberships(), nowMs = this.now(), selectedRole = brandSelectedRole(principal, memberships, teamId, seasonId, role, nowMs);
    const preparation = this.document(teamId, seasonId, "preparation");
    if (preparation.team.id !== teamId) throw new AccessError("NOT_FOUND", 404, "The requested branding is unavailable.");
    return { context: { principal, memberships, selectedRole, clubId: preparation.club.id, teamId, authoritySeasonId: seasonId, nowMs, spectatorGrantActive: selectedRole === "spectator" }, club: { id: preparation.club.id, name: preparation.club.name }, team: { id: teamId, name: preparation.team.name, ageGroup: preparation.team.ageGroup } };
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
  matchDto(principal, matchId, requestedRole) {
    const row = this.match(matchId);
    return filterMatchForPrincipal({ principal, memberships: this.memberships(), teamId: row.team_id, seasonId: row.season_id, state: JSON.parse(row.state_json), policy: JSON.parse(row.sharing_policy_json), lastSyncAt: row.last_sync_at, now: this.now(), requestedRole });
  }
  download(principal, matchId, deviceId, syntheticOnly = false, controllerToken) {
    const read = () => {
      const row = this.managerMatch(principal, matchId);
      if (!validDeviceId(deviceId)) bad("A device identifier of at most 120 canonical characters is required.");
      if (controllerToken !== void 0) {
        const authority = this.assertController(principal, matchId, controllerToken);
        if (authority.device_id !== deviceId || authority.frozen) throw new AccessError("CONTROLLER_REQUIRED", 409, "Use the current unfrozen controller device and capability.");
      }
      const stream = this.database.prepare("SELECT sequence,previous_event_id FROM streams WHERE match_id=? AND device_id=?").get(matchId, deviceId);
      const controller = this.database.prepare("SELECT epoch,account_id,device_id,frozen FROM controller_grants WHERE match_id=?").get(matchId);
      const events = this.database.prepare("SELECT revision,received_at,envelope_json FROM events WHERE match_id=? AND disposition='accepted' ORDER BY revision LIMIT 10001").all(matchId);
      const transitions = this.database.prepare("SELECT id,epoch,actor_id,from_device,to_device,kind,reason,created_at FROM controller_history WHERE match_id=? ORDER BY epoch,created_at,id LIMIT 10001").all(matchId);
      const saved = this.database.prepare("SELECT value_json FROM documents WHERE team_id=? AND season_id=? AND kind='records'").get(row.team_id, row.season_id);
      return buildOfflineDownload({ matchId, teamId: row.team_id, seasonId: row.season_id, deviceId, state: JSON.parse(row.state_json), checkpoint: { clientSequence: stream?.sequence ?? 0, previousEventId: stream?.previous_event_id ?? null }, controller: controller ?? null, events, transitions, publication: offlinePublication(matchId, JSON.parse(row.sharing_policy_json), saved ? JSON.parse(saved.value_json) : null), nowMs: this.now(), syntheticOnly });
    };
    return this.database.isTransaction ? read() : this.transaction(read);
  }
  audit(principal, action, objectId, outcome) {
    this.database.prepare("INSERT INTO audit(id,actor_id,action,object_id,outcome,created_at) VALUES(?,?,?,?,?,?)").run(randomUUID2(), principal.accountId, action, objectId, outcome, this.now());
  }
  idempotent(principal, operation, key, payload, work) {
    if (!validId3(key) || key.length < 8) bad("A stable Idempotency-Key is required for mutations.");
    const signature2 = digest(canonical4(payload));
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
  issueClockChallenge(principal, matchId, token, input, policy) {
    const grant = this.assertController(principal, matchId, token);
    if (!policy) throw new AccessError("CLOCK_POLICY_REQUIRED", 503, "An explicitly configured trusted-time policy is required before establishing an anchor.");
    if (!input || Object.keys(input).some((key) => !["deviceId", "controllerEpoch", "continuityId"].includes(key)) || !validDeviceId(input.deviceId) || !validId3(input.continuityId) || input.deviceId !== grant.device_id || input.controllerEpoch !== grant.epoch || grant.frozen) throw new AccessError("CLOCK_SCOPE_CONFLICT", 409, "Use the current unfrozen controller device, epoch and continuous-clock identity.");
    const challenge = issueClockChallenge({ accountId: principal.accountId, deviceId: grant.device_id, matchId, controllerEpoch: grant.epoch, continuityId: input.continuityId }, randomUUID2(), this.now(), policy);
    this.database.prepare("INSERT INTO clock_challenges(id,match_id,account_id,challenge_json) VALUES(?,?,?,?)").run(challenge.id, matchId, principal.accountId, JSON.stringify(challenge));
    return challenge;
  }
  acknowledgeClockChallenge(principal, matchId, token, challengeId, sample, policy) {
    const grant = this.assertController(principal, matchId, token);
    if (!policy) throw new AccessError("CLOCK_POLICY_REQUIRED", 503, "An explicitly configured trusted-time policy is required before establishing an anchor.");
    if (!sample || Object.keys(sample).some((key) => !["receivedMonotonicMs", "sentMonotonicMs"].includes(key))) bad("Use the documented continuous-clock receipt and send observations.");
    const row = this.database.prepare("SELECT challenge_json,consumed_at FROM clock_challenges WHERE id=? AND match_id=? AND account_id=?").get(challengeId, matchId, principal.accountId);
    if (!row) throw new AccessError("NOT_FOUND", 404, "That challenge is unavailable.");
    const challenge = JSON.parse(row.challenge_json);
    if (row.consumed_at !== null) throw new AccessError("CLOCK_CHALLENGE_CONSUMED", 409, "That clock exchange was consumed. Retrying the same request key returns its receipt.");
    if (challenge.controllerEpoch !== grant.epoch || challenge.deviceId !== grant.device_id || grant.frozen) throw new AccessError("CLOCK_SCOPE_CONFLICT", 409, "The controller changed before the clock exchange completed.");
    let mapping;
    try {
      mapping = acknowledgeClockChallenge(challenge, sample, this.now(), policy);
    } catch {
      throw new AccessError("CLOCK_EXCHANGE_REJECTED", 422, "The clock exchange expired or its evidence exceeds the configured uncertainty bounds.");
    }
    this.database.prepare("UPDATE clock_challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL").run(this.now(), challengeId);
    this.database.prepare("INSERT INTO clock_mappings(challenge_id,match_id,mapping_json,created_at) VALUES(?,?,?,?)").run(challengeId, matchId, JSON.stringify(mapping), this.now());
    this.audit(principal, "clock.mapping_established", matchId, policy.id);
    return mapping;
  }
  reconciliation(principal, matchId) {
    const row = this.managerMatch(principal, matchId);
    const state = JSON.parse(row.state_json);
    const events = this.database.prepare("SELECT event_id,device_id,client_sequence,envelope_json,reason,received_at FROM events WHERE match_id=? AND disposition='quarantined' ORDER BY received_at,client_sequence").all(matchId);
    const conflicts = this.database.prepare("SELECT id,original_json,reason,created_at FROM conflicting_submissions WHERE match_id=? ORDER BY created_at,id").all(matchId);
    const submissions = [...events.map((event) => {
      const original = JSON.parse(event.envelope_json);
      return { submissionId: event.event_id, matchId, eventId: event.event_id, deviceId: event.device_id, clientSequence: event.client_sequence, controllerEpoch: original.controllerEpoch ?? null, reason: event.reason, original, originalDigest: digest(canonical4(original)), receivedAt: new Date(event.received_at).toISOString() };
    }), ...conflicts.map((conflict4) => {
      const original = JSON.parse(conflict4.original_json);
      return { submissionId: conflict4.id, matchId, eventId: typeof original.eventId === "string" ? original.eventId : null, deviceId: typeof original.deviceId === "string" ? original.deviceId : null, clientSequence: typeof original.clientSequence === "number" ? original.clientSequence : null, controllerEpoch: typeof original.controllerEpoch === "number" ? original.controllerEpoch : null, reason: conflict4.reason, original, originalDigest: digest(canonical4(original)), receivedAt: new Date(conflict4.created_at).toISOString() };
    })];
    const proposals = this.database.prepare("SELECT receipt_json FROM reconciliation_proposals WHERE match_id=? ORDER BY created_at,id").all(matchId).map((item) => JSON.parse(item.receipt_json));
    return { matchId, acceptedRevision: state.revision, submissions, proposals, policy: Q08_RECONCILIATION_POLICY };
  }
  proposeReconciliation(principal, matchId, input) {
    const row = this.managerMatch(principal, matchId);
    const state = JSON.parse(row.state_json);
    if (!input || Object.keys(input).some((key) => !["proposalId", "baseRevision", "sourceSubmissionIds", "reason", "resolution", "commands"].includes(key))) bad("Use only the documented immutable reconciliation proposal fields.");
    const signature2 = digest(canonical4(input));
    const existing = this.database.prepare("SELECT signature,receipt_json FROM reconciliation_proposals WHERE id=? AND match_id=? AND actor_id=?").get(input.proposalId, matchId, principal.accountId);
    if (existing) {
      if (existing.signature !== signature2) throw new AccessError("RECONCILIATION_PROPOSAL_CONFLICT", 409, "That proposal identity already preserves different review evidence.");
      return JSON.parse(existing.receipt_json);
    }
    const snapshot = this.reconciliation(principal, matchId);
    const preview = previewReconciliation(state, input, snapshot.submissions, { actorId: principal.accountId, recordedAtMs: this.now() });
    if (!preview.valid) throw new AccessError("RECONCILIATION_PREVIEW_REJECTED", 422, preview.issues.join(" ").slice(0, 1500));
    const { projectedState: discarded, ...savedPreview } = preview;
    void discarded;
    const receipt = { input, matchId, actorId: principal.accountId, createdAt: new Date(this.now()).toISOString(), sourceDigests: input.sourceSubmissionIds.map((id9) => ({ submissionId: id9, originalDigest: snapshot.submissions.find((item) => item.submissionId === id9).originalDigest })), acceptedStateDigest: digest(canonical4(state)), preview: savedPreview, status: "prepared", appliedRevision: null };
    this.database.prepare("INSERT INTO reconciliation_proposals(id,match_id,actor_id,signature,receipt_json,created_at) VALUES(?,?,?,?,?,?)").run(input.proposalId, matchId, principal.accountId, signature2, JSON.stringify(receipt), this.now());
    this.audit(principal, "reconciliation.proposal_prepared", matchId, "q08_authority_unapproved");
    return receipt;
  }
  recordFinishedContext(principal, matchId, policy) {
    const row = this.managerMatch(principal, matchId);
    const state = JSON.parse(row.state_json);
    if (state.status !== "completed") return { status: "not_finished" };
    this.refreshDetailedArchive(row, state);
    const community = this.communityState(row.team_id, row.season_id);
    const existing = community.matches.find((item) => item.id === matchId);
    const quarantine = this.database.prepare("SELECT event_id FROM events WHERE match_id=? AND disposition='quarantined' LIMIT 1").get(matchId);
    const conflict4 = this.database.prepare("SELECT id FROM conflicting_submissions WHERE match_id=? LIMIT 1").get(matchId);
    const unresolved = Boolean(quarantine || conflict4);
    if (existing) {
      const retainedFinishId = state.eventHistory?.filter((event) => event.type === "half.ended").at(-1)?.id;
      const retainedFinish = retainedFinishId ? this.database.prepare("SELECT envelope_json FROM events WHERE event_id=? AND match_id=? AND disposition='accepted'").get(retainedFinishId, matchId) : void 0;
      const currentGrant = this.database.prepare("SELECT epoch FROM controller_grants WHERE match_id=?").get(matchId);
      const sourceEpoch = retainedFinish ? JSON.parse(retainedFinish.envelope_json).controllerEpoch : null;
      const quality = unresolved ? "conflicted" : state.recoveryRequired || sourceEpoch !== currentGrant?.epoch || finishEligibilityChanged(state, existing) ? "review_required" : existing.finishQuality;
      if (quality !== existing.finishQuality) {
        const next2 = { ...community, revision: community.revision + 1, matches: community.matches.map((match) => match.id === matchId ? { ...match, finishQuality: quality } : match), audit: [...community.audit, { id: randomUUID2(), actorAccountId: null, action: "service.finish_evidence_flagged_without_reopening", atMs: this.now() }] };
        this.saveDocument(row.team_id, row.season_id, "community", next2);
      }
      return { status: "original_context_preserved", finishQuality: quality };
    }
    const finishId = state.eventHistory?.filter((event) => event.type === "half.ended").at(-1)?.id;
    const finishRow = finishId ? this.database.prepare("SELECT envelope_json,actor_id FROM events WHERE event_id=? AND match_id=? AND disposition='accepted'").get(finishId, matchId) : void 0;
    const finish = finishRow ? JSON.parse(finishRow.envelope_json) : null;
    const mappingRow = finish ? this.database.prepare("SELECT mapping_json FROM clock_mappings WHERE challenge_id=? AND match_id=?").get(finish.clockEvidence.anchorId, matchId) : void 0;
    const grant = this.database.prepare("SELECT epoch FROM controller_grants WHERE match_id=?").get(matchId);
    const preparation = this.document(row.team_id, row.season_id, "preparation");
    const fixture = preparation.fixtures.find((item) => item.id === matchId && item.seasonId === row.season_id);
    const playedDate = state.config.fixture?.playedDate ?? fixture?.playedDate;
    if (!playedDate) return { status: "accepted_fixture_date_required" };
    const scheduledAtMs = Date.parse(`${playedDate}T00:00:00Z`);
    const context = deriveFinishedMatchContext({ state, acceptedFinish: finish, acceptedFinishActorId: finishRow?.actor_id ?? null, teamId: row.team_id, seasonId: row.season_id, currentControllerEpoch: grant?.epoch ?? 0, unresolvedConflicts: unresolved, mapping: mappingRow ? JSON.parse(mappingRow.mapping_json) : null, policy: policy ?? null, serverNowMs: this.now(), scheduledAtMs, sharing: "manager_only", sharingPolicyVersion: 0 });
    const next = { ...community, revision: community.revision + 1, matches: [...community.matches, { ...context, voteCutoffAtMs: null, cutoffSource: "unresolved", finalisationDeadlineAtMs: context.actualFullTimeAtMs === null ? null : context.actualFullTimeAtMs + 36e5 }], audit: [...community.audit, { id: randomUUID2(), actorAccountId: null, action: "service.accepted_finish_registered_manager_only", atMs: this.now() }] };
    this.saveDocument(row.team_id, row.season_id, "community", next);
    return { status: "registered_from_accepted_history", finishQuality: context.finishQuality };
  }
  refreshDetailedArchive(row, match) {
    const saved = this.database.prepare("SELECT value_json FROM documents WHERE team_id=? AND season_id=? AND kind='records'").get(row.team_id, row.season_id);
    if (!saved) return;
    const records = JSON.parse(saved.value_json);
    const archived = records.results.find((item) => item.id === match.config.matchId && item.recordMode === "detailed_live");
    if (!archived || (archived.sourceMatchRevision ?? -1) >= match.revision) return;
    if (match.recoveryRequired) {
      if (archived.detailCompleteness !== "review_required") {
        const reviewed = { ...records, revision: records.revision + 1, results: records.results.map((item) => item.id === archived.id ? { ...item, detailCompleteness: "review_required", revision: item.revision + 1 } : item) };
        this.saveDocument(row.team_id, row.season_id, "records", reviewed);
      }
      return;
    }
    const context = { matchId: archived.id, playedDate: archived.playedDate, opponent: archived.opponent, homeAway: archived.homeAway, fixtureClass: archived.fixtureClass };
    const updated = reduceRecords({ ...records, liveMatch: context }, { type: "live.archive", commandId: `accepted-archive-${digest(canonical4([archived.id, match.revision]))}`, at: new Date(this.now()).toISOString(), actor: "manager", match, reason: "Existing detailed archive refreshed from the newer accepted canonical match revision; original source events and prior archive audit remain retained." });
    const projected = { ...updated, liveMatch: records.liveMatch };
    this.saveDocument(row.team_id, row.season_id, "records", projected);
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
      const signature2 = digest(canonical4(event));
      const previous = this.database.prepare("SELECT * FROM events WHERE event_id=?").get(event.eventId);
      if (previous) {
        if (previous.match_id !== matchId || previous.signature !== signature2) {
          this.database.prepare("INSERT INTO conflicting_submissions VALUES(?,?,?,?,?,?)").run(randomUUID2(), matchId, principal.accountId, JSON.stringify(value), "EVENT_ID_CONFLICT", this.now());
          results.push({ eventId: event.eventId, clientSequence: event.clientSequence, disposition: "quarantined", reason: "EVENT_ID_CONFLICT", revision: null, duplicate: false });
        } else results.push({ eventId: previous.event_id, clientSequence: previous.client_sequence, disposition: previous.disposition, reason: previous.reason, revision: previous.revision, duplicate: true });
        continue;
      }
      const stream = this.database.prepare("SELECT sequence,previous_event_id FROM streams WHERE match_id=? AND device_id=?").get(matchId, event.deviceId);
      if (event.clientSequence !== (stream?.sequence ?? 0) + 1 || event.previousEventId !== (stream?.previous_event_id ?? null)) {
        this.database.prepare("INSERT INTO conflicting_submissions VALUES(?,?,?,?,?,?)").run(randomUUID2(), matchId, principal.accountId, JSON.stringify(value), "SEQUENCE_GAP_OR_REUSE", this.now());
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
    if (results.some((item) => item.disposition === "accepted" && !item.duplicate)) this.enqueueNotifications(row.team_id, row.season_id, "match", matchId, `accepted-revision-${state.revision}`);
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
    if (!validId3(toAccountId) || !validDeviceId(toDeviceId)) bad("A target account and canonical device identifier of at most 120 characters are required.");
    const target = this.database.prepare("SELECT * FROM accounts WHERE id=?").get(toAccountId);
    if (!target) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    const targetPrincipal = { accountId: target.id, issuer: target.issuer, subject: target.subject, identityClassification: target.classification, adultVerified: !!target.adult_verified, strongAuth: !!target.strong_auth_enrolled, authenticatedAt: this.now(), status: target.status };
    assertCanManageTeam(targetPrincipal, this.memberships(), row.team_id, row.season_id, this.now());
    const id9 = randomUUID2();
    this.database.prepare("INSERT INTO transfers VALUES(?,?,?,?,?,?,?)").run(id9, matchId, grant.epoch, toAccountId, toDeviceId, "pending", this.now());
    this.database.prepare("UPDATE controller_grants SET frozen=1 WHERE match_id=?").run(matchId);
    this.audit(principal, "controller.transfer_offered", matchId, "pending");
    return { transferId: id9, state: "pending", acceptedRevision: state.revision };
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
    this.database.prepare("INSERT INTO controller_history VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID2(), matchId, epoch, principal.accountId, grant.device_id, deviceId, "transferred", null, this.now());
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
    this.database.prepare("INSERT INTO controller_history VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID2(), matchId, epoch, principal.accountId, old?.device_id ?? null, deviceId, "recovered", reason.trim(), this.now());
    this.audit(principal, "controller.recovered", matchId, "reconciliation_required");
    return { epoch, deviceId, controllerToken: capability, reconciliationRequired: true, checkpoint: this.download(principal, matchId, deviceId).deviceCheckpoint };
  }
  staffRevision(teamId, seasonId) {
    const row = this.database.prepare("SELECT revision FROM documents WHERE team_id=? AND season_id=? AND kind='staff'").get(teamId, seasonId);
    return row?.revision ?? 0;
  }
  bumpStaffRevision(teamId, seasonId) {
    const revision = this.staffRevision(teamId, seasonId) + 1;
    this.saveDocument(teamId, seasonId, "staff", { revision });
    return revision;
  }
  managers(principal, teamId, seasonId, requestedRole) {
    assertTeamRole(principal, this.memberships(), teamId, seasonId, ["administrator"], this.now());
    assertAdultAuthority(principal, false, this.now());
    const accounts = this.database.prepare("SELECT * FROM accounts WHERE id IN (SELECT account_id FROM memberships WHERE team_id=?)").all(teamId);
    const community = this.document(teamId, seasonId, "community");
    const evidence = accounts.map((account3) => ({ accountId: account3.id, label: community.accounts.find((item) => item.id === account3.id)?.label ?? "Verified adult account", status: account3.status, identityClassification: account3.classification, adultVerified: Boolean(account3.adult_verified), strongAuthEnrolled: Boolean(account3.strong_auth_enrolled) }));
    return managerRoster({ principal, memberships: this.memberships(), accounts: evidence, teamId, seasonId, nowMs: this.now(), revision: this.staffRevision(teamId, seasonId), requestedRole });
  }
  assignManager(actor, teamId, seasonId, accountId, expectedRevision) {
    assertTeamRole(actor, this.memberships(), teamId, seasonId, ["administrator"], this.now());
    assertAdultAuthority(actor, true, this.now());
    if (!validId3(accountId)) bad("A canonical account identifier is required.");
    if (expectedRevision !== void 0 && (!nonnegative3(expectedRevision) || expectedRevision !== this.staffRevision(teamId, seasonId))) throw new AccessError("STALE_REVISION", 409, "Refresh the current staff assignments before changing them.");
    const account3 = this.database.prepare("SELECT * FROM accounts WHERE id=?").get(accountId);
    if (!account3) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    const target = { accountId: account3.id, issuer: account3.issuer, subject: account3.subject, identityClassification: account3.classification, adultVerified: !!account3.adult_verified, strongAuth: !!account3.strong_auth_enrolled, authenticatedAt: this.now(), status: account3.status };
    assertCanAssignManager(actor, target, this.memberships(), teamId, seasonId, this.now());
    const alreadyActive = this.memberships().some((item) => item.accountId === accountId && item.teamId === teamId && item.seasonId === seasonId && item.role === "manager" && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > this.now()));
    if (!alreadyActive) {
      this.database.prepare("INSERT INTO memberships(account_id,team_id,season_id,role) VALUES(?,?,?,'manager') ON CONFLICT(account_id,team_id,season_id,role) DO UPDATE SET revoked_at=NULL,expires_at=NULL").run(accountId, teamId, seasonId);
      this.bumpStaffRevision(teamId, seasonId);
      this.audit(actor, "manager.assigned", teamId, "accepted");
    }
    return { accountId, teamId, seasonId, role: "manager", revision: this.staffRevision(teamId, seasonId), acceptedAt: new Date(this.now()).toISOString() };
  }
  revokeManager(actor, teamId, seasonId, input, expectedRevision) {
    assertTeamRole(actor, this.memberships(), teamId, seasonId, ["administrator"], this.now());
    assertAdultAuthority(actor, true, this.now());
    if (!input || Object.keys(input).some((key) => !["accountId", "reason", "confirmRevocation"].includes(key)) || !validId3(input.accountId) || input.confirmRevocation !== true || typeof input.reason !== "string" || input.reason.trim().length < 5 || input.reason.length > 500) bad("Confirm a scoped manager revocation and record its evidence reason.");
    if (expectedRevision !== void 0 && (!nonnegative3(expectedRevision) || expectedRevision !== this.staffRevision(teamId, seasonId))) throw new AccessError("STALE_REVISION", 409, "Refresh the current staff assignments before changing them.");
    const member = this.database.prepare("SELECT account_id,revoked_at FROM memberships WHERE account_id=? AND team_id=? AND season_id=? AND role='manager'").get(input.accountId, teamId, seasonId);
    if (!member) throw new AccessError("NOT_FOUND", 404, "That manager assignment is outside this scope.");
    if (member.revoked_at === null) {
      this.database.prepare("UPDATE memberships SET revoked_at=? WHERE account_id=? AND team_id=? AND season_id=? AND role='manager'").run(this.now(), input.accountId, teamId, seasonId);
      this.database.prepare("UPDATE controller_grants SET frozen=1 WHERE account_id=? AND match_id IN (SELECT id FROM matches WHERE team_id=? AND season_id=?)").run(input.accountId, teamId, seasonId);
      this.bumpStaffRevision(teamId, seasonId);
      this.audit(actor, "manager.assignment_revoked", input.accountId, input.reason.trim());
    }
    return { accountId: input.accountId, teamId, seasonId, role: "manager", revision: this.staffRevision(teamId, seasonId), acceptedAt: new Date(this.now()).toISOString(), revoked: true, controllerFrozen: true, otherSeasonAssignmentsRetained: true, remainingActiveTeamSeasons: this.memberships().filter((item) => item.accountId === input.accountId && item.teamId === teamId && item.role === "manager" && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > this.now())).map((item) => item.seasonId) };
  }
  privacyRecords(principal) {
    const rows = this.database.prepare("SELECT id,account_id,kind,status,team_id,season_id,affected_memberships_json,created_at FROM privacy_requests WHERE account_id=? ORDER BY created_at,id").all(principal.accountId);
    return rows.map((row) => ({ requestId: row.id, accountId: row.account_id, kind: row.kind, status: row.status, scope: row.kind === "leave_team" ? row.team_id && row.season_id ? { type: "team_season", teamId: row.team_id, seasonId: row.season_id } : null : { type: "all_memberships" }, affectedMemberships: row.affected_memberships_json === null ? null : JSON.parse(row.affected_memberships_json), createdAtMs: row.created_at }));
  }
  privacyRequest(principal, input) {
    const plan = prepareAccountPrivacyRequest({ principal, memberships: this.memberships(), input, nowMs: this.now() });
    const pending = this.database.prepare("SELECT p.id FROM privacy_pending_keys k JOIN privacy_requests p ON p.id=k.request_id WHERE k.business_key=? AND p.account_id=? AND p.status='pending_verification_and_policy'").get(plan.businessKey, principal.accountId);
    let requestId = pending?.id;
    if (!requestId) {
      const retained = plan.scope.type === "team_season" ? this.database.prepare("SELECT id FROM privacy_requests WHERE account_id=? AND kind=? AND team_id=? AND season_id=? AND status='pending_verification_and_policy' ORDER BY created_at,id LIMIT 1").get(principal.accountId, plan.kind, plan.scope.teamId, plan.scope.seasonId) : this.database.prepare("SELECT id FROM privacy_requests WHERE account_id=? AND kind=? AND team_id IS NULL AND season_id IS NULL AND status='pending_verification_and_policy' ORDER BY created_at,id LIMIT 1").get(principal.accountId, plan.kind);
      requestId = retained?.id;
    }
    if (!requestId) {
      requestId = randomUUID2();
      this.database.prepare("INSERT INTO privacy_requests(id,account_id,kind,status,policy_version,verified_at,created_at,team_id,season_id,affected_memberships_json) VALUES(?,?,?,?,NULL,NULL,?,?,?,?)").run(requestId, principal.accountId, plan.kind, plan.status, this.now(), plan.scope.type === "team_season" ? plan.scope.teamId : null, plan.scope.type === "team_season" ? plan.scope.seasonId : null, JSON.stringify(plan.affectedMemberships));
      this.audit(principal, "privacy.requested", requestId, "pending_verification_and_policy");
    }
    this.database.prepare("INSERT INTO privacy_pending_keys(business_key,request_id) VALUES(?,?) ON CONFLICT(business_key) DO UPDATE SET request_id=excluded.request_id").run(plan.businessKey, requestId);
    return this.privacyRequests(principal).items.find((item) => item.requestId === requestId);
  }
  privacyRequests(principal) {
    return projectAccountPrivacyRequests({ principal, memberships: this.memberships(), records: this.privacyRecords(principal), nowMs: this.now() });
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
  teamMatches(principal, teamId, seasonId, requestedRole, query = { limit: 25, cursor: null }) {
    const memberships = this.memberships();
    const audience2 = matchPageAudience(principal, memberships, teamId, seasonId, requestedRole, this.now());
    const scope = { principal, teamId, seasonId, role: audience2.role, playerId: audience2.playerId ?? null }, afterId = matchPagePosition(scope, query);
    const rows = this.database.prepare("SELECT id,state_json,sharing_policy_json,last_sync_at FROM matches WHERE team_id=? AND season_id=? AND (? IS NULL OR id > ?) ORDER BY id COLLATE BINARY LIMIT ?").all(teamId, seasonId, afterId, afterId, query.limit + 1);
    const visible = rows.slice(0, query.limit);
    return { items: visible.map((row) => filterMatchForPrincipal({ principal, memberships, teamId, seasonId, state: JSON.parse(row.state_json), policy: JSON.parse(row.sharing_policy_json), lastSyncAt: row.last_sync_at, requestedRole, now: this.now() })), nextCursor: rows.length > query.limit ? matchPageCursor(scope, visible[visible.length - 1].id) : null, serverTime: new Date(this.now()).toISOString() };
  }
  document(teamId, seasonId, kind2) {
    const row = this.database.prepare("SELECT value_json FROM documents WHERE team_id=? AND season_id=? AND kind=?").get(teamId, seasonId, kind2);
    if (!row) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    return JSON.parse(row.value_json);
  }
  saveDocument(teamId, seasonId, kind2, state) {
    this.database.prepare("INSERT INTO documents(team_id,season_id,kind,revision,value_json) VALUES(?,?,?,?,?) ON CONFLICT(team_id,season_id,kind) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json").run(teamId, seasonId, kind2, state.revision, JSON.stringify(state));
  }
  enqueueNotifications(teamId, seasonId, category, entityId, sourceId) {
    const recipients = /* @__PURE__ */ new Map();
    const priority = { manager: 3, player: 2, spectator: 1, administrator: 0 };
    for (const member of this.memberships().filter((item) => item.teamId === teamId && item.seasonId === seasonId && ["manager", "player", "spectator"].includes(item.role) && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > this.now()))) {
      const current3 = recipients.get(member.accountId);
      if (!current3 || priority[member.role] > priority[current3.role]) recipients.set(member.accountId, member);
    }
    let inserted = 0;
    for (const member of recipients.values()) {
      if (member.role === "administrator" || member.role === "player" && !member.playerId) continue;
      const businessKey = `notify:${digest(canonical4([teamId, seasonId, category, entityId, sourceId, member.accountId, member.role]))}`;
      const job = createTeamNotificationJob({ id: randomUUID2(), businessKey, accountId: member.accountId, teamId, seasonId, audience: member.role, playerId: member.role === "player" ? member.playerId : null, category, entityId, dueAtMs: this.now() });
      const result = this.database.prepare("INSERT INTO jobs(id,business_key,kind,payload_json,due_at) VALUES(?,?,'notification.dispatch',?,?) ON CONFLICT(business_key) DO NOTHING").run(job.id, businessKey, JSON.stringify(job), job.dueAtMs);
      inserted += Number(result.changes);
    }
    return inserted;
  }
  preparation(principal, teamId, seasonId) {
    assertCanManageTeam(principal, this.memberships(), teamId, seasonId, this.now());
    return this.document(teamId, seasonId, "preparation");
  }
  configuration(principal, teamId, seasonId, role) {
    if (role) assertTeamRole(principal, this.memberships(), teamId, seasonId, role === "manager" || role === "administrator" ? [role] : [], this.now());
    const state = this.document(teamId, seasonId, "preparation");
    return configurationServiceView({ principal, memberships: this.memberships(), preparation: state, seasonId, nowMs: this.now() });
  }
  configurationCommand(principal, teamId, seasonId, command, role) {
    this.configuration(principal, teamId, seasonId, role);
    if (!command || !["club.updated", "team.updated"].includes(command.type)) bad("Only club or team configuration can be changed in this context.");
    if (role && command.type === "club.updated" && role !== "administrator") throw new AccessError("NOT_FOUND", 404, "Choose the current administrator context to administer the club.");
    const state = applyConfigurationServiceCommand({ principal, memberships: this.memberships(), preparation: this.document(teamId, seasonId, "preparation"), seasonId, nowMs: this.now(), command });
    this.saveDocument(teamId, seasonId, "preparation", state);
    this.audit(principal, command.type, teamId, "administrator_configuration_accepted");
    return this.configuration(principal, teamId, seasonId, role);
  }
  seasonContext(principal, teamId, seasonId) {
    const community = this.communityState(teamId, seasonId);
    const accounts = this.database.prepare("SELECT * FROM accounts").all();
    const preparationDocuments = this.database.prepare("SELECT value_json FROM documents WHERE team_id=? AND kind='preparation'").all(teamId);
    const existingSeasons = preparationDocuments.flatMap((row) => JSON.parse(row.value_json).seasons.map((season) => ({ teamId, id: season.id, startYear: season.startYear })));
    return {
      principal,
      memberships: this.memberships(),
      existingSeasons,
      nowMs: this.now(),
      preparation: this.document(teamId, seasonId, "preparation"),
      records: this.document(teamId, seasonId, "records"),
      community,
      accounts: accounts.map((account3) => ({ accountId: account3.id, label: community.accounts.find((item) => item.id === account3.id)?.label ?? "Verified account", status: account3.status, identityClassification: account3.classification, adultVerified: Boolean(account3.adult_verified), strongAuthEnrolled: Boolean(account3.strong_auth_enrolled) }))
    };
  }
  seasonOptions(principal, teamId, seasonId) {
    return seasonRolloverOptions(this.seasonContext(principal, teamId, seasonId));
  }
  createSeason(principal, teamId, seasonId, command) {
    const context = this.seasonContext(principal, teamId, seasonId);
    const plan = planSeasonRollover({ ...context, command });
    if (this.database.prepare("SELECT kind FROM documents WHERE team_id=? AND season_id=? LIMIT 1").get(teamId, plan.receipt.seasonId)) throw new AccessError("SEASON_EXISTS", 409, "That destination season already has saved documents.");
    for (const member of plan.memberships) this.database.prepare("INSERT INTO memberships(account_id,team_id,season_id,role,player_id,expires_at,revoked_at) VALUES(?,?,?,?,?,?,?)").run(member.accountId, member.teamId, member.seasonId, member.role, member.playerId ?? null, member.expiresAt ?? null, member.revokedAt ?? null);
    this.saveDocument(teamId, plan.receipt.seasonId, "preparation", plan.preparation);
    this.saveDocument(teamId, plan.receipt.seasonId, "records", plan.records);
    this.saveDocument(teamId, plan.receipt.seasonId, "community", plan.community);
    this.audit(principal, "season.created_from_explicit_assignments", plan.receipt.seasonId, "accepted_no_spectator_renewal");
    return plan.receipt;
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
    if (canonical4(players) !== canonical4(previous.players)) records = {
      ...records,
      players,
      revision: records.revision + 1,
      audit: [...records.audit, { commandId: `preparation-roster-${sourceCommandId}`, action: "preparation.roster.projected", matchId: null, at, reason: "Current season roster labels updated from preparation; saved match snapshots preserved.", before: null, after: null }]
    };
    if (canonical4(evidence) !== canonical4(previous.trainingAttendance)) records = reduceRecords(records, { type: "training.evidence.replace", commandId: `preparation-training-${sourceCommandId}`, at, actor: "manager", evidence });
    if (records !== previous) this.saveDocument(teamId, seasonId, "records", records);
  }
  preparationCommand(principal, teamId, seasonId, command) {
    const previous = this.preparation(principal, teamId, seasonId);
    const types2 = ["club.updated", "team.updated", "season.rolled_over", "profile.saved", "roster.imported", "profile.archived", "formation.saved", "fixture.saved", "fixture.status_changed", "fixture.response_recorded", "fixture.selection_saved", "fixture.attendance_recorded", "fixture.prepared", "match_plan.saved", "match_plan.applied", "match_plan.cleared", "training.series_created", "training.series_updated", "training.series_cancelled", "training.saved", "training.status_changed", "training.response_recorded", "training.attendance_recorded"];
    if (!command || !types2.includes(command.type)) bad("Unsupported preparation command.");
    if (command.type === "season.rolled_over") throw new AccessError("SEASON_ASSIGNMENT_REQUIRED", 503, "A connected new season requires approved manager/player assignments and explicit spectator renewal. The local rehearsal supports rollover; this service will not save an inaccessible new season or silently copy authority.");
    if (command.type === "club.updated") {
      assertTeamRole(principal, this.memberships(), teamId, seasonId, ["administrator"], this.now());
      assertAdultAuthority(principal, true, this.now());
    }
    const protectedFixtureIds = [];
    if (command.type === "match_plan.applied") {
      const match = this.database.prepare("SELECT state_json FROM matches WHERE id=? AND team_id=? AND season_id=?").get(command.fixtureId, teamId, seasonId);
      if (match) {
        const accepted2 = JSON.parse(match.state_json);
        if (accepted2.status !== "preparation" || accepted2.revision !== 0 || this.database.prepare("SELECT match_id FROM controller_grants WHERE match_id=?").get(command.fixtureId) || this.database.prepare("SELECT event_id FROM events WHERE match_id=? LIMIT 1").get(command.fixtureId)) protectedFixtureIds.push(command.fixtureId);
      }
    }
    const state = reducePreparation(previous, command, { nowMs: this.now(), protectedFixtureIds });
    if (command.type === "fixture.prepared") {
      const snapshot = state.snapshots.find((snapshot2) => snapshot2.fixtureId === command.fixtureId && snapshot2.preparedRevision === command.expectedRevision + 1);
      if (!snapshot) throw new AccessError("PREPARATION_SNAPSHOT_REQUIRED", 409, "The immutable prepared fixture snapshot is unavailable.");
      assertCanManageTeam(principal, this.memberships(), teamId, snapshot.seasonId, this.now());
      const config = fixtureMatchConfig(state, snapshot);
      const existing = this.database.prepare("SELECT * FROM matches WHERE id=?").get(config.matchId);
      if (!existing) this.insertMatch(config, teamId, snapshot.seasonId);
      else {
        if (existing.team_id !== teamId || existing.season_id !== snapshot.seasonId) throw new AccessError("MATCH_SCOPE_CONFLICT", 409, "That fixture identity already belongs to another match scope.");
        if (canonical4(JSON.parse(existing.config_json)) !== canonical4(config)) {
          const matchState = JSON.parse(existing.state_json);
          const claimed = this.database.prepare("SELECT match_id FROM controller_grants WHERE match_id=?").get(config.matchId);
          const history = this.database.prepare("SELECT event_id FROM events WHERE match_id=? LIMIT 1").get(config.matchId);
          if (claimed || history || matchState.revision !== 0 || matchState.status !== "preparation") throw new AccessError("MATCH_HISTORY_EXISTS", 409, "This match already has a controller or recorded history. Preserve its saved snapshot and reconcile changes explicitly.");
          this.database.prepare("UPDATE matches SET config_json=?,state_json=? WHERE id=?").run(JSON.stringify(config), JSON.stringify(createMatch(config)), config.matchId);
        }
      }
    }
    if (command.type.startsWith("training.") || command.type.startsWith("profile.") || command.type === "roster.imported") this.projectPreparationRecords(teamId, seasonId, state, command.id);
    this.saveDocument(teamId, seasonId, "preparation", state);
    this.audit(principal, command.type, teamId, "accepted");
    if (command.type === "fixture.saved") this.enqueueNotifications(teamId, seasonId, "schedule", command.fixture.id, command.id);
    else if (command.type === "fixture.status_changed" || command.type === "fixture.selection_saved") this.enqueueNotifications(teamId, seasonId, "schedule", command.fixtureId, command.id);
    else if (command.type === "training.saved") this.enqueueNotifications(teamId, seasonId, "schedule", command.training.id, command.id);
    else if (command.type === "training.status_changed") this.enqueueNotifications(teamId, seasonId, "schedule", command.trainingId, command.id);
    else if (command.type === "training.series_created") for (const occurrence of command.occurrences) this.enqueueNotifications(teamId, seasonId, "schedule", occurrence.id, command.id);
    else if (command.type === "training.series_updated" || command.type === "training.series_cancelled") for (const id9 of command.occurrenceIds) this.enqueueNotifications(teamId, seasonId, "schedule", id9, command.id);
    return state;
  }
  ownPreparation(principal, teamId, seasonId) {
    const membership = assertTeamRole(principal, this.memberships(), teamId, seasonId, ["player"], this.now());
    const state = this.document(teamId, seasonId, "preparation");
    const profiles = state.profiles.filter((profile2) => profile2.playerId === membership.playerId && profile2.seasonId === seasonId && profile2.active);
    if (profiles.length !== 1) throw new AccessError("NOT_FOUND", 404, "The requested own-player profile is unavailable.");
    const profile = profiles[0];
    return projectOwnPlayerPreparation(state, profile, seasonId);
  }
  ownPreparationCommand(principal, teamId, seasonId, command) {
    const membership = assertTeamRole(principal, this.memberships(), teamId, seasonId, ["player"], this.now());
    if (!command || !validId3(command.id) || !nonnegative3(command.expectedRevision) || !["own.preferences_saved", "own.fixture_response_recorded", "own.training_response_recorded"].includes(command.type)) bad("A valid own-player command and source revision are required.");
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
      accounts: accounts.map((account3) => ({ id: account3.id, label: state.accounts.find((person) => person.id === account3.id)?.label ?? "Verified account", classification: account3.classification === "unclassified" ? "spectator" : account3.classification, adultVerified: !!account3.adult_verified })),
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
    if (!command || !validId3(command.id) || typeof command.type !== "string") bad("A typed community command with a stable identity is required.");
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
      this.database.prepare("INSERT INTO jobs(id,business_key,kind,payload_json,due_at) VALUES(?,?,?,?,?) ON CONFLICT(business_key) DO NOTHING").run(randomUUID2(), key, "award.finalise", JSON.stringify({ teamId, seasonId, matchId: match.id }), match.voteCutoffAtMs);
    }
    this.audit(principal, command.type, teamId, "accepted");
    if (command.type === "photo.submitted" || command.type === "photo.revised" || command.type === "photo.published" || command.type === "photo.reviewed" && command.decision === "approve") this.enqueueNotifications(teamId, seasonId, "photos", command.photoId, command.id);
    if (command.type === "award.finalised") this.enqueueNotifications(teamId, seasonId, "awards", command.matchId, command.id);
    return { ...getCommunityView(state, actor, this.now()), revision: state.revision };
  }
  synchronizeSpectatorMemberships(state) {
    const scopes = /* @__PURE__ */ new Map();
    for (const grant of state.grants) scopes.set(JSON.stringify([grant.accountId, grant.teamId, grant.seasonId]), { accountId: grant.accountId, teamId: grant.teamId, seasonId: grant.seasonId });
    for (const scope of scopes.values()) {
      const grants = state.grants.filter((grant) => grant.accountId === scope.accountId && grant.teamId === scope.teamId && grant.seasonId === scope.seasonId);
      const active2 = grants.filter((grant) => grant.revokedAtMs === null && grant.startsAtMs <= this.now() && grant.expiresAtMs > this.now());
      const expiresAt = Math.max(...(active2.length ? active2 : grants).map((grant) => grant.expiresAtMs));
      const revokedAt = active2.length ? null : Math.max(1, this.now());
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
  recordsContext(principal, teamId, seasonId, role) {
    const viewer = this.recordsViewer(principal, teamId, seasonId, role);
    const rows = this.database.prepare("SELECT state_json FROM matches WHERE team_id=? AND season_id=? ORDER BY id").all(teamId, seasonId);
    const community = this.communityState(teamId, seasonId);
    const actor = this.communityActor(principal, teamId, seasonId, viewer.actor);
    const filtered = getCommunityView(community, actor, this.now());
    return { principal, memberships: this.memberships(), nowMs: this.now(), requestedRole: viewer.actor, state: this.document(teamId, seasonId, "records"), acceptedMatches: rows.map((row) => ({ teamId, seasonId, match: JSON.parse(row.state_json) })), community: { accountId: principal.accountId, teamId, seasonId, audience: viewer.actor, playerId: viewer.playerId ?? null, revision: community.revision, view: { allowed: filtered.allowed, matches: filtered.matches, gallery: filtered.gallery } } };
  }
  records(principal, teamId, seasonId, role) {
    return recordsServiceView(this.recordsContext(principal, teamId, seasonId, role));
  }
  recordsExport(principal, teamId, seasonId, request, role) {
    return recordsServiceExport({ ...this.recordsContext(principal, teamId, seasonId, role), request });
  }
  recordsCommand(principal, teamId, seasonId, command, role) {
    const state = applyRecordsServiceCommand({ ...this.recordsContext(principal, teamId, seasonId, role), command });
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
  description: "Deliberate C-001 companion: engineVersion is required immutable provenance. This incremental command transport adapts the shared reducer, including local preparation commands, and does not claim that the archived v0.1 OpenAPI Event variants accept an added property. Original archived artifacts remain unchanged. The service assigns receipt time and accepted revision. The current accepting engine is synthetic-live-4; archived v2/v3 envelopes keep their original versions. Unknown versions are retained in quarantine. Real controller handover, identity and release gates remain separately documented.",
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
import { createHash as createHash4, randomBytes as randomBytes2, randomUUID as randomUUID3, timingSafeEqual } from "node:crypto";
import { chmodSync as chmodSync2, mkdirSync as mkdirSync2, readFileSync } from "node:fs";
import { open as open2, rename as rename2, unlink as unlink2 } from "node:fs/promises";
import { isAbsolute as isAbsolute2, join, resolve, sep } from "node:path";
import { execFile as execFile2, spawn } from "node:child_process";
import { promisify as promisify2 } from "node:util";
import { performance as performance2 } from "node:perf_hooks";
import { Socket } from "node:net";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";

// apps/api/src/image-bytes.ts
import { createHash as createHash3 } from "node:crypto";
import { access, open, readFile, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

// apps/api/src/image-process.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var executeFile = promisify(execFile);
var IMAGE_REJECTION_MARKER = "IMAGE_DECODE_REJECTED";
function imageProcessRejected(error) {
  if (!error || typeof error !== "object") return false;
  const result = error;
  return result.code === 1 && result.signal == null && result.killed !== true && typeof result.stderr === "string" && result.stderr.trim() === IMAGE_REJECTION_MARKER;
}
function executeImageDecoder(args, timeoutMs) {
  return executeFile(process.execPath, [...args], {
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
    windowsHide: true
  });
}

// packages/application/src/image-formats.ts
var MAX_ORIGINAL_IMAGE_BYTES = 15 * 1024 * 1024;
var pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
var read32 = (bytes, at) => bytes[at] * 16777216 + bytes[at + 1] * 65536 + bytes[at + 2] * 256 + bytes[at + 3];
var four = (bytes, at) => String.fromCharCode(...bytes.subarray(at, at + 4));
var unsupported = () => new Error(
  "Choose a still JPEG, PNG or supported single-image HEIC. Animated images, HEIC sequences and other formats are not supported."
);
function originalImageMime(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_ORIGINAL_IMAGE_BYTES)
    throw new Error("Choose a JPEG, PNG or HEIC no larger than 15 MiB.");
  if (pngSignature.every((byte, index) => bytes[index] === byte)) {
    for (let offset = 8; offset + 12 <= bytes.length; ) {
      const length = read32(bytes, offset), type = four(bytes, offset + 4);
      if (type === "acTL") throw unsupported();
      if (length > bytes.length - offset - 12) break;
      offset += length + 12;
      if (type === "IEND") break;
    }
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (bytes.length >= 16 && four(bytes, 4) === "ftyp") {
    const size = read32(bytes, 0);
    if (size < 16 || size > 4096 || size > bytes.length || size % 4 !== 0)
      throw unsupported();
    const major = four(bytes, 8);
    if (!["heic", "heix", "mif1"].includes(major)) throw unsupported();
    const brands = [major];
    for (let offset = 16; offset < size; offset += 4)
      brands.push(four(bytes, offset));
    if (brands.some(
      (brand) => ["hevc", "hevx", "msf1", "avif", "avis"].includes(brand)
    ) || !brands.some((brand) => brand === "heic" || brand === "heix"))
      throw unsupported();
    return "image/heic";
  }
  throw unsupported();
}

// apps/api/src/image-bytes.ts
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
function fail4(code, status2, message) {
  throw new AccessError(code, status2, message);
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
  try {
    return originalImageMime(bytes) === "image/heic" ? "image/heic" : null;
  } catch {
    return null;
  }
}
function rejectAnimatedPng(bytes) {
  if (actualMime(bytes) !== "image/png") return;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) fail4("INVALID_IMAGE", 415, "The image is incomplete or unsupported.");
    const kind2 = bytes.toString("ascii", offset + 4, offset + 8);
    if (kind2 === "acTL") fail4("ANIMATED_IMAGE_UNSUPPORTED", 415, "Animated images are not supported.");
    offset += length + 12;
    if (kind2 === "IEND") break;
  }
}
async function receivePrivateImage(input) {
  const destination = input.temporaryPath ? await open(input.temporaryPath, "wx", 384) : null;
  const digest3 = createHash3("sha256"), began = performance.now(), iterator = input.source[Symbol.asyncIterator]();
  let received = 0;
  try {
    while (true) {
      const item = await bounded(iterator.next(), MEDIA_LIMITS.uploadTimeoutMs - (performance.now() - began), "UPLOAD_TIMEOUT");
      if (item.done) break;
      const chunk = Buffer.from(item.value);
      received += chunk.length;
      if (received > input.expectedBytes || received > MEDIA_LIMITS.maxBytes) fail4("UPLOAD_TOO_LARGE", 413, "The image exceeds its declared upload size.");
      digest3.update(chunk);
      if (destination) await destination.writeFile(chunk);
    }
    if (received !== input.expectedBytes || digest3.digest("hex") !== input.expectedSha) fail4("UPLOAD_INTEGRITY_FAILED", 422, "The uploaded size or SHA-256 does not match. The private partial upload was not accepted.");
    if (destination) {
      await destination.sync();
      await destination.close();
      await rename(input.temporaryPath, input.destinationPath);
    }
    return received;
  } catch (error) {
    if (destination) {
      await destination.close().catch(() => void 0);
      await unlink(input.temporaryPath).catch(() => void 0);
    }
    if (iterator.return) void Promise.resolve(iterator.return()).catch(() => void 0);
    throw error;
  }
}
async function processPrivateImage(input) {
  const original = await readFile(input.originalPath);
  if (original.length !== input.expectedBytes || createHash3("sha256").update(original).digest("hex") !== input.expectedSha) fail4("UPLOAD_INTEGRITY_FAILED", 422, "The private original does not match its recorded size and hash.");
  const mimeType = actualMime(original);
  if (!mimeType || mimeType !== input.declaredMime) fail4("MEDIA_TYPE_MISMATCH", 415, "The image type must match its original JPEG, PNG or supported still HEIC bytes.");
  rejectAnimatedPng(original);
  if (!input.scanner) fail4("SCANNER_REQUIRED", 503, "Image safety scanning is not configured. The original remains private; no reviewable or published image was created.");
  const scan = await bounded(input.scanner.scan(original, { mimeType, sha256: input.expectedSha }), MEDIA_LIMITS.scannerTimeoutMs, "SCANNER_UNAVAILABLE");
  if (scan.verdict === "unavailable") fail4("SCANNER_UNAVAILABLE", 503, "Image scanning is unavailable. The original remains private for a safe retry.");
  if (scan.verdict !== "clean") fail4("IMAGE_SCAN_REJECTED", 422, "The image did not pass safety scanning and remains unpublished.");
  if (mimeType === "image/heic") {
    const decoder = process.env.LONGBALL_HEIC_DECODER_FILE ?? "/opt/longball-heic/bin/longball-heic";
    if (!isAbsolute(decoder) || decoder.length > 4096) fail4("HEIC_DECODER_REQUIRED", 503, "The private HEIC decoder is not configured. The original remains private for retry.");
    try {
      await access(decoder, constants.X_OK);
    } catch {
      fail4("HEIC_DECODER_REQUIRED", 503, "The private HEIC decoder is unavailable. The original remains private for retry.");
    }
  }
  let decoded;
  try {
    const result = await executeImageDecoder(["--max-old-space-size=128", fileURLToPath(new URL("./media-worker.mjs", import.meta.url)), input.originalPath, input.displayPath, input.thumbnailPath, mimeType, input.kind ?? "photo"], MEDIA_LIMITS.decodeTimeoutMs);
    decoded = JSON.parse(result.stdout);
    const edge = input.kind === "logo" ? 1024 : MEDIA_LIMITS.displayEdge;
    if (!Number.isSafeInteger(decoded.width) || !Number.isSafeInteger(decoded.height) || decoded.width < 1 || decoded.height < 1 || decoded.width > edge || decoded.height > edge) throw new Error();
  } catch (error) {
    if (imageProcessRejected(error)) fail4("IMAGE_DECODE_REJECTED", 415, "The image was rejected by the supported format, pixel and content checks.");
    fail4("MEDIA_PROCESSING_FAILED", 503, "The bounded image processor is unavailable. The private upload is retained for a safe retry; no image was published.");
  } finally {
    if (mimeType === "image/heic") await unlink(input.displayPath + ".heic-rgba").catch(() => void 0);
  }
  return { ...decoded, scannerEngine: scan.engine.slice(0, 100), contentType: input.kind === "logo" ? "image/png" : "image/jpeg" };
}

// apps/api/src/media.ts
var executeFile2 = promisify2(execFile2);
var hash = (value) => createHash4("sha256").update(value).digest("hex");
var id2 = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,150}$/.test(value);
function fail5(code, status2, message) {
  throw new AccessError(code, status2, message);
}
function auth(state, actor, now, upload = false) {
  if (!communityCanAccess(state, actor, now) || upload && actor.role === "spectator") fail5("NOT_FOUND", 404, "The requested media operation is unavailable.");
}
function sameToken(expectedHash, token) {
  return typeof token === "string" && token.length <= 256 && timingSafeEqual(Buffer.from(expectedHash, "hex"), Buffer.from(hash(token), "hex"));
}
function createClamAvScanner(executable, options2 = {}) {
  if (!isAbsolute2(executable)) fail5("SCANNER_CONFIGURATION_INVALID", 503, "Configure an absolute path to the maintained ClamAV scanner.");
  const timeoutMs = Math.max(100, Math.min(options2.timeoutMs ?? 15e3, 2e4));
  let versionCheck = null;
  const identify = async () => {
    try {
      const result = await executeFile2(executable, ["--version"], { timeout: Math.min(timeoutMs, 3e3), maxBuffer: 8192, windowsHide: true });
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
        const child = spawn(executable, ["--no-summary", "--stdout", "--max-filesize=16M", "--max-scansize=16M", "--max-files=32", "--max-recursion=4", "--alert-exceeds-max=yes", "-"], { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
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
function createClamAvDaemonScanner(options2) {
  const timeoutMs = Math.max(100, Math.min(options2.timeoutMs ?? 15e3, MEDIA_LIMITS.scannerTimeoutMs));
  if (options2.socketPath ? !isAbsolute2(options2.socketPath) || Boolean(options2.host || options2.port) : typeof options2.host !== "string" || !options2.host.trim() || options2.host.length > 253 || !Number.isInteger(options2.port) || options2.port < 1 || options2.port > 65535) {
    fail5("SCANNER_CONFIGURATION_INVALID", 503, "Configure one explicit private ClamAV daemon endpoint.");
  }
  const exchange = (command, bytes) => new Promise((resolveReply) => {
    const socket = new Socket();
    let received = Buffer.alloc(0);
    let finished = false;
    const finish = (reply) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolveReply(reply);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
    socket.on("data", (chunk) => {
      if (received.length + chunk.length > 8192) return finish(null);
      received = Buffer.concat([received, chunk]);
      const ending = received.indexOf(0);
      if (ending >= 0) finish(ending === received.length - 1 ? received.subarray(0, ending).toString("utf8") : null);
    });
    socket.once("connect", () => {
      socket.write(`z${command}\0`);
      if (command === "INSTREAM") {
        for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
          const chunk = bytes.subarray(offset, offset + 64 * 1024);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length);
          socket.write(size);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4));
      }
    });
    if (options2.socketPath) socket.connect(options2.socketPath);
    else socket.connect({ host: options2.host, port: options2.port });
  });
  return { scan: async (bytes) => {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MEDIA_LIMITS.maxBytes) return { verdict: "unavailable", engine: "clamav_unverified" };
    const versionReply = await exchange("VERSION");
    const version = versionReply && /^ClamAV ([0-9][0-9A-Za-z.+_-]*)\/([0-9]+)\/(.+)$/.exec(versionReply);
    if (!version || !Number.isFinite(Date.parse(version[3]))) return { verdict: "unavailable", engine: "clamav_unverified" };
    const engine = `clamav:${version[1]}/db:${version[2]}`;
    const reply = await exchange("INSTREAM", bytes);
    return { verdict: reply === "stream: OK" ? "clean" : /^stream: [^\r\n]+ FOUND$/.test(reply ?? "") ? "rejected" : "unavailable", engine };
  } };
}
var mediaInternals = { executeFile: executeFile2, hash, id: id2, fail: fail5, auth, sameToken, bounded, actualMime, rejectAnimatedPng };
var DevelopmentMediaService = class {
  database;
  directory;
  now;
  scanner;
  ownDatabase;
  constructor(options2) {
    this.directory = resolve(options2.directory);
    mkdirSync2(this.directory, { recursive: true, mode: 448 });
    chmodSync2(this.directory, 448);
    for (const name of ["quarantine", "derivatives"]) {
      mkdirSync2(join(this.directory, name), { recursive: true, mode: 448 });
      chmodSync2(join(this.directory, name), 448);
    }
    this.ownDatabase = !options2.database;
    this.database = options2.database ?? new DatabaseSync2(join(this.directory, "media.sqlite"));
    if (this.ownDatabase) chmodSync2(join(this.directory, "media.sqlite"), 384);
    this.now = options2.now ?? Date.now;
    this.scanner = options2.scanner;
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
    if (!path.startsWith(this.directory + sep)) fail5("MEDIA_STORE_INVALID", 503, "The private media object is unavailable.");
    return path;
  }
  row(state, actor, uploadId, token) {
    auth(state, actor, this.now(), true);
    if (!id2(uploadId)) fail5("NOT_FOUND", 404, "The requested upload is unavailable.");
    const row = this.database.prepare("SELECT * FROM media_uploads WHERE id=? AND owner_id=? AND team_id=? AND season_id=?").get(uploadId, actor.accountId, actor.teamId, actor.seasonId);
    if (!row || token !== void 0 && !sameToken(row.token_hash, token)) fail5("NOT_FOUND", 404, "The requested upload is unavailable.");
    return row;
  }
  prepare(state, actor, input) {
    auth(state, actor, this.now(), true);
    const allowedKeys = ["requestId", "matchId", "byteSize", "mimeType", "sha256", "caption", "policyAcknowledged", "photoId", "sourceRevision"];
    if (!input || typeof input !== "object" || Object.keys(input).some((key) => !allowedKeys.includes(key)) || !id2(input.requestId) || !id2(input.matchId) || !Number.isSafeInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > MEDIA_LIMITS.maxBytes || !["image/jpeg", "image/png", "image/heic"].includes(input.mimeType) || typeof input.sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(input.sha256) || typeof input.caption !== "string" || input.caption.trim().length > 160 || input.policyAcknowledged !== true) {
      fail5("INVALID_MEDIA_PREPARATION", 422, "Use an original JPEG, PNG or supported still HEIC up to 15 MiB with a valid size, SHA-256 and policy acknowledgement.");
    }
    const match = state.matches.find((item) => item.id === input.matchId && item.teamId === actor.teamId && item.seasonId === actor.seasonId);
    if (!match) fail5("NOT_FOUND", 404, "The requested match is unavailable.");
    const signature2 = hash(JSON.stringify([input.matchId, input.byteSize, input.mimeType, input.sha256.toLowerCase(), input.caption.trim(), input.policyAcknowledged, input.photoId ?? null, input.sourceRevision ?? null]));
    const existing = this.database.prepare("SELECT * FROM media_uploads WHERE owner_id=? AND request_id=?").get(actor.accountId, input.requestId);
    const token = randomBytes2(32).toString("base64url");
    if (existing) {
      if (existing.request_signature !== signature2 || existing.team_id !== actor.teamId || existing.season_id !== actor.seasonId) fail5("IDEMPOTENCY_CONFLICT", 409, "This upload request identity was already used for different content.");
      if (existing.expires_at <= this.now() && ["prepared", "uploading"].includes(existing.status)) fail5("UPLOAD_EXPIRED", 410, "The upload window expired. Prepare a new upload without discarding the previous private record.");
      this.database.prepare("UPDATE media_uploads SET token_hash=? WHERE id=?").run(hash(token), existing.id);
      return { uploadId: existing.id, photoId: existing.photo_id, uploadToken: token, expiresAtMs: existing.expires_at, maxBytes: MEDIA_LIMITS.maxBytes, displayRevision: existing.display_revision };
    }
    let sourceRevision = null;
    let photoId = `media-${randomUUID3()}`;
    if (input.photoId !== void 0 || input.sourceRevision !== void 0) {
      const photo = state.photos.find((item) => item.id === input.photoId && item.matchId === match.id && item.teamId === actor.teamId && item.seasonId === actor.seasonId && item.uploaderAccountId === actor.accountId && item.uploaderRole === actor.role && item.removedAtMs === null);
      if (!photo || !Number.isSafeInteger(input.sourceRevision) || photo.currentRevision !== input.sourceRevision) fail5("MEDIA_REVISION_CONFLICT", 409, "The photo changed. Review its current revision before replacing it.");
      sourceRevision = photo.currentRevision;
      photoId = photo.id;
    }
    const uploadId = randomUUID3();
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
  async upload(state, actor, uploadId, token, source2) {
    const row = this.row(state, actor, uploadId, token);
    const duplicate = ["uploaded", "processed", "linked"].includes(row.status);
    if (!duplicate && row.expires_at <= this.now()) fail5("UPLOAD_EXPIRED", 410, "The write-only upload window expired.");
    if (!duplicate && row.status !== "prepared" && !(row.status === "uploading" && (row.lease_until ?? 0) < this.now())) fail5("UPLOAD_BUSY", 409, "This upload is already running or cannot be changed.");
    const attempt2 = randomUUID3();
    const key = `quarantine/${row.id}-${attempt2}.upload`;
    const temporary = this.path(key + ".part");
    if (!duplicate) {
      const updated = this.database.prepare("UPDATE media_uploads SET status='uploading',attempt=?,lease_until=?,failure_code=NULL WHERE id=? AND (status='prepared' OR (status='uploading' AND lease_until<?))").run(attempt2, this.now() + 65e3, row.id, this.now());
      if (!updated.changes) fail5("UPLOAD_BUSY", 409, "This upload is already running.");
    }
    const destination = duplicate ? null : await open2(temporary, "wx", 384);
    const digest3 = createHash4("sha256");
    let received = 0;
    const began = performance2.now();
    const iterator = source2[Symbol.asyncIterator]();
    try {
      while (true) {
        const item = await bounded(iterator.next(), MEDIA_LIMITS.uploadTimeoutMs - (performance2.now() - began), "UPLOAD_TIMEOUT");
        if (item.done) break;
        const chunk = Buffer.from(item.value);
        received += chunk.length;
        if (received > row.expected_bytes || received > MEDIA_LIMITS.maxBytes) fail5("UPLOAD_TOO_LARGE", 413, "The image exceeds its declared upload size.");
        digest3.update(chunk);
        if (destination) await destination.writeFile(chunk);
      }
      if (received !== row.expected_bytes || digest3.digest("hex") !== row.expected_sha) fail5("UPLOAD_INTEGRITY_FAILED", 422, "The uploaded size or SHA-256 does not match. The private partial upload was not accepted.");
      if (destination) {
        await destination.sync();
        await destination.close();
        await rename2(temporary, this.path(key));
        const changed = this.database.prepare("UPDATE media_uploads SET status='uploaded',original_key=?,lease_until=NULL,failure_code=NULL WHERE id=? AND attempt=? AND status='uploading'").run(key, row.id, attempt2);
        if (!changed.changes) fail5("UPLOAD_LEASE_CHANGED", 409, "The upload lease changed. The private branch is retained for review.");
      }
      return { uploadId, status: "uploaded", byteSize: received };
    } catch (error) {
      if (destination) {
        await destination.close().catch(() => void 0);
        await unlink2(temporary).catch(() => void 0);
      }
      if (!duplicate) this.database.prepare("UPDATE media_uploads SET status='prepared',failure_code='UPLOAD_INCOMPLETE',lease_until=NULL WHERE id=? AND attempt=? AND status='uploading'").run(row.id, attempt2);
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
    if (row.status !== "uploaded" && !(row.status === "processing" && (row.lease_until ?? 0) < this.now())) fail5("UPLOAD_NOT_READY", 409, "Finish the private upload before completion; an active processing lease cannot be duplicated.");
    if (!row.original_key) fail5("UPLOAD_NOT_READY", 409, "The private original is unavailable.");
    const attempt2 = randomUUID3();
    const leased = this.database.prepare("UPDATE media_uploads SET status='processing',attempt=?,lease_until=?,failure_code=NULL WHERE id=? AND (status='uploaded' OR (status='processing' AND lease_until<?))").run(attempt2, this.now() + 6e4, row.id, this.now());
    if (!leased.changes) fail5("UPLOAD_BUSY", 409, "This image is already processing.");
    try {
      const displayKey = `derivatives/${row.photo_id}-v${row.display_revision}-${attempt2}-display.jpg`;
      const thumbnailKey = `derivatives/${row.photo_id}-v${row.display_revision}-${attempt2}-thumbnail.jpg`;
      const decoded = await processPrivateImage({ originalPath: this.path(row.original_key), displayPath: this.path(displayKey), thumbnailPath: this.path(thumbnailKey), expectedBytes: row.expected_bytes, expectedSha: row.expected_sha, declaredMime: row.declared_mime, scanner: this.scanner });
      const saved = this.database.prepare("UPDATE media_uploads SET status='processed',display_key=?,thumbnail_key=?,width=?,height=?,scanner_engine=?,failure_code=NULL,lease_until=NULL WHERE id=? AND attempt=? AND status='processing'").run(displayKey, thumbnailKey, decoded.width, decoded.height, decoded.scannerEngine, row.id, attempt2);
      if (!saved.changes) fail5("PROCESSING_LEASE_CHANGED", 409, "The processing lease changed. No publication was performed.");
      return this.completion(this.row(state, actor, uploadId));
    } catch (error) {
      const code = error instanceof AccessError ? error.code : "MEDIA_PROCESSING_FAILED";
      const retryable = ["SCANNER_REQUIRED", "SCANNER_UNAVAILABLE", "MEDIA_PROCESSING_FAILED", "HEIC_DECODER_REQUIRED"].includes(code);
      this.database.prepare("UPDATE media_uploads SET status=?,failure_code=?,lease_until=NULL WHERE id=? AND attempt=? AND status='processing'").run(retryable ? "uploaded" : "rejected", code, row.id, attempt2);
      throw error instanceof AccessError ? error : new AccessError("MEDIA_PROCESSING_FAILED", 503, "Image processing is unavailable. No image was published.");
    }
  }
  /** Call in the same SQLite transaction as applying and saving completion.command. */
  link(uploadId, state) {
    const row = this.database.prepare("SELECT * FROM media_uploads WHERE id=?").get(uploadId);
    if (!row || !["processed", "linked"].includes(row.status)) fail5("MEDIA_NOT_PROCESSED", 409, "The image has not completed private processing.");
    if (state && !state.photos.some((photo) => photo.id === row.photo_id && photo.teamId === row.team_id && photo.seasonId === row.season_id && photo.uploaderAccountId === row.owner_id && photo.revisions.some((revision) => revision.version === row.display_revision))) fail5("MEDIA_LINK_CONFLICT", 409, "The matching community revision was not committed.");
    this.database.prepare("UPDATE media_uploads SET status='linked' WHERE id=?").run(uploadId);
  }
  gateway(state, actor, photoId, variant, mode = "gallery", revision) {
    if (!["display", "thumbnail"].includes(variant)) fail5("NOT_FOUND", 404, "The media variant is unavailable.");
    const decision = authorizeCommunityMedia(state, actor, photoId, this.now(), mode, revision);
    if (!decision.allowed) fail5("NOT_FOUND", 404, "The requested image is unavailable.");
    const row = this.database.prepare("SELECT * FROM media_uploads WHERE photo_id=? AND display_revision=? AND status='linked'").get(photoId, decision.revision.version);
    if (!row || row.team_id !== actor.teamId || row.season_id !== actor.seasonId) fail5("NOT_FOUND", 404, "The requested image is unavailable.");
    const key = variant === "display" ? row.display_key : row.thumbnail_key;
    if (!key) fail5("NOT_FOUND", 404, "The requested image is unavailable.");
    let body;
    try {
      body = readFileSync(this.path(key));
    } catch {
      fail5("NOT_FOUND", 404, "The requested image is unavailable.");
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

// apps/api/src/runtime-store.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash as createHash5 } from "node:crypto";
function sqliteRuntimeStore(source2) {
  const transactionContext = new AsyncLocalStorage();
  const facade = { now: source2.now };
  for (const name of Object.getOwnPropertyNames(DevelopmentStore.prototype)) {
    if (name === "constructor") continue;
    const method = source2[name];
    if (typeof method === "function") facade[name] = async (...args) => method.apply(source2, args);
  }
  const transaction = async (work) => {
    if (transactionContext.getStore()) return work();
    source2.database.exec("BEGIN IMMEDIATE");
    try {
      const result = await transactionContext.run(true, work);
      source2.database.exec("COMMIT");
      return result;
    } catch (error) {
      source2.database.exec("ROLLBACK");
      throw error;
    }
  };
  facade.transaction = transaction;
  facade.withIdentityContext = async (_identity, work) => work();
  facade.withActorContext = async (_principal, _scope, work) => work();
  facade.idempotent = async (principal, operation, key, payload, work) => {
    if (!/^[A-Za-z0-9_-]{8,150}$/.test(key)) throw new AccessError("INVALID_REQUEST", 400, "A stable Idempotency-Key is required for mutations.");
    const signature2 = createHash5("sha256").update(canonical4(payload)).digest("hex");
    return transaction(async () => {
      const prior = source2.database.prepare("SELECT signature,response_json FROM idempotency WHERE account_id=? AND operation=? AND key=?").get(principal.accountId, operation, key);
      if (prior) {
        if (prior.signature !== signature2) throw new AccessError("IDEMPOTENCY_CONFLICT", 409, "The idempotency key was already used with different content.");
        return JSON.parse(prior.response_json);
      }
      const result = await work();
      source2.database.prepare("INSERT INTO idempotency(account_id,operation,key,signature,response_json) VALUES(?,?,?,?,?)").run(principal.accountId, operation, key, signature2, JSON.stringify(result));
      return result;
    });
  };
  let tail = Promise.resolve();
  return {
    store: facade,
    serialize(work) {
      const result = tail.then(work);
      tail = result.catch(() => void 0);
      return result;
    }
  };
}

// apps/api/src/activation.ts
import { createHash as createHash6, randomBytes as randomBytes3, randomUUID as randomUUID4 } from "node:crypto";
var hash2 = (value) => createHash6("sha256").update(value).digest("hex");
var id3 = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(value);
var uuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function unavailable() {
  throw new AccessError(
    "ACTIVATION_UNAVAILABLE",
    410,
    "This activation cannot be used. Request a new activation through the agreed household process."
  );
}
function invalid3() {
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
function fields5(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !names.includes(key)) || names.some((key) => !(key in value)))
    invalid3();
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
  ownsActivationToken(token, activationId) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    return Boolean(this.store.database.prepare("SELECT id FROM lb_activation_tokens WHERE token_hash=? AND (? IS NULL OR id=?)").get(hash2(token), activationId ?? null, activationId ?? null));
  }
  configured;
  store;
  provider;
  policy;
  constructor(options2) {
    this.store = options2.store;
    this.provider = options2.provider;
    this.policy = options2.policy;
    if (options2.policy && (options2.policy.fictionalOnly !== true || !id3(options2.policy.version) || !Number.isSafeInteger(options2.policy.activationTtlMs) || options2.policy.activationTtlMs <= 0))
      throw new Error(
        "An explicit versioned fictional activation policy and positive expiry are required."
      );
    if (options2.provider) {
      const issuer2 = new URL(options2.provider.issuer);
      if (issuer2.protocol !== "https:" || issuer2.username || issuer2.password || issuer2.search || issuer2.hash || !options2.provider.credentialSetupOrigins.length)
        throw new Error(
          "Activation requires a configured HTTPS provider and credential origins."
        );
      for (const origin of options2.provider.credentialSetupOrigins) {
        const parsed = new URL(origin);
        if (parsed.protocol !== "https:" || parsed.origin !== origin)
          throw new Error(
            "Credential setup origins must be exact HTTPS origins."
          );
      }
    }
    this.configured = Boolean(options2.provider && options2.policy);
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
    fields5(input, ["requestId", "teamId", "seasonId", "playerId"]);
    if (![input.requestId, input.teamId, input.seasonId, input.playerId].every(id3))
      invalid3();
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
      const accountId = randomUUID4();
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
      const binding2 = this.store.database.prepare(
        "SELECT id FROM accounts WHERE issuer=? AND subject=? AND id!=?"
      ).get(result.issuer, result.subject, row.account_id);
      if (binding2)
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
    fields5(input, ["requestId", "teamId", "seasonId", "accountId"]);
    if (![input.requestId, input.teamId, input.seasonId].every(id3) || !uuid(input.accountId))
      invalid3();
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
      const activationId = randomUUID4();
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
    fields5(input, ["token", "requestId"]);
    if (typeof input.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.token) || !id3(input.requestId))
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
    if (setup.protocol !== "https:" || setup.username || setup.password || !provider.credentialSetupOrigins.includes(setup.origin) || result.setupUrl.includes(input.token) || !id3(result.flowId) || !Number.isSafeInteger(result.expiresAt) || result.expiresAt > reserved.token.expires_at || result.expiresAt <= this.store.now())
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
    fields5(input, ["activationId", "token", "completionProof"]);
    if (!uuid(input.activationId) || typeof input.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.token) || typeof input.completionProof !== "string" || !input.completionProof || input.completionProof.length > 16384)
      unavailable();
    const token = this.store.database.prepare("SELECT * FROM lb_activation_tokens WHERE id=? AND token_hash=?").get(input.activationId, hash2(input.token));
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
      const account3 = this.store.database.prepare("SELECT classification,status FROM accounts WHERE id=?").get(child.account_id);
      if (account3.classification !== "child_shared") unavailable();
      if (fresh.state === "completed") {
        if (account3.status !== "active") unavailable();
        return { status: "complete", signInRequired: true };
      }
      if (account3.status !== "disabled") unavailable();
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
        randomUUID4(),
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
    fields5(input, [
      "requestId",
      "teamId",
      "seasonId",
      "playerId",
      "existingAccountId"
    ]);
    if (!id3(input.playerId) || !uuid(input.existingAccountId)) invalid3();
    return this.verificationRequest(
      principal,
      "link",
      input,
      input.existingAccountId,
      input.playerId
    );
  }
  requestRecovery(principal, input) {
    fields5(input, ["requestId", "teamId", "seasonId", "accountId"]);
    if (!uuid(input.accountId)) invalid3();
    return this.verificationRequest(
      principal,
      "recovery",
      input,
      input.accountId,
      null
    );
  }
  verificationRequest(principal, kind2, input, target, playerId) {
    const { policy } = this.enabled();
    if (![input.requestId, input.teamId, input.seasonId].every(id3)) invalid3();
    const signature2 = fingerprint(principal.accountId, { ...input, kind: kind2 });
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
          kind2,
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
          `identity.${kind2}_requested`,
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

// apps/api/src/request-context.ts
var object5 = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
var opaque4 = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(value);
function requestDatabaseScope(input) {
  const { method, parts, body } = input;
  if (input.role && !["administrator", "manager", "player", "spectator"].includes(input.role)) throw new AccessError("NOT_FOUND", 404, "The requested role context is unavailable.");
  const scope = { operation: "unavailable", requestedRole: input.role ?? "default" };
  const command = object5(body?.command) ? body.command : null;
  if (parts[0] !== "v1") return scope;
  if (parts[1] === "me") scope.operation = parts[2] === "push-registrations" ? method === "GET" ? "push.read" : method === "POST" ? "push.register" : method === "DELETE" ? "push.revoke" : "unavailable" : "account.read";
  else if (parts[1] === "identity" && parts[2] === "devices") scope.operation = method === "GET" ? "identity.devices" : "identity.enrol";
  else if (parts[1] === "contracts") scope.operation = "contracts.read";
  else if (parts[1] === "privacy" && parts[2] === "requests") scope.operation = method === "GET" ? "privacy.read" : "privacy.request";
  else if (parts[1] === "accounts" && ["link-requests", "recovery-requests"].includes(parts[2])) {
    scope.operation = parts[2] === "link-requests" ? "account.link_request" : "account.recovery_request";
    if (opaque4(body?.teamId) && opaque4(body?.seasonId)) {
      scope.teamId = body.teamId;
      scope.seasonId = body.seasonId;
    }
  } else if (parts[1] === "matches" && opaque4(parts[2])) {
    scope.matchId = parts[2];
    scope.operation = method === "GET" && parts.length === 3 ? "match.read" : "match.manage";
    if (scope.operation === "match.manage" && input.role && input.role !== "manager") throw new AccessError("NOT_FOUND", 404, "Choose the current manager context for match recording.");
  } else if (parts[1] === "teams" && opaque4(parts[2])) {
    scope.teamId = parts[2];
    scope.seasonId = input.seasonId;
    switch (parts[3]) {
      case "matches":
        scope.operation = "match.read";
        break;
      case "managers": {
        scope.operation = method === "GET" ? "staff.read" : parts[4] === "revoke" ? "staff.revoke" : "staff.assign";
        const target = command?.accountId ?? body?.accountId;
        if (opaque4(target)) scope.staffTargetAccountId = target;
        break;
      }
      case "configuration":
        scope.operation = method === "GET" ? "configuration.read" : "configuration.write";
        break;
      case "seasons":
        scope.operation = method === "GET" ? "season.options" : "season.create";
        if (method === "POST" && opaque4(command?.idForSeason)) scope.newSeasonId = command.idForSeason;
        break;
      case "preparation":
        scope.operation = `preparation.${parts[4] === "own" ? "own." : ""}${method === "GET" ? "read" : "write"}`;
        break;
      case "records":
        scope.operation = method === "GET" ? parts[4] === "export" ? "records.export" : "records.read" : "records.write";
        break;
      case "privileges":
        scope.operation = method === "GET" ? parts[4] === "own" ? "privileges.own" : "privileges.read" : "privileges.write";
        break;
      case "community":
        scope.operation = method === "GET" ? "community.read" : "community.write";
        break;
      case "spectator-invites":
        scope.operation = method === "GET" ? "invite.list" : method === "DELETE" ? "invite.revoke" : parts[5] === "reissue" ? "invite.reissue" : "invite.issue";
        break;
      case "media":
        scope.operation = parts[4] === "photos" ? "media.gateway" : method === "GET" ? "media.list" : method === "PUT" ? "media.upload" : parts[5] === "prepare" ? "media.prepare" : "media.complete";
        break;
      case "activation":
        scope.operation = parts[4] === "pending-child" ? "activation.pending_child" : "activation.issue";
        break;
      case "branding":
        scope.operation = method === "GET" ? parts[4] === "assets" ? "branding.gateway" : "branding.read" : method === "PUT" ? "branding.upload" : parts[4] === "uploads" ? "branding.complete" : parts[5] === "uploads" ? "branding.prepare" : parts[5] === "publish" ? "branding.publish" : "branding.remove";
        break;
    }
  }
  if (!input.role && (scope.operation.startsWith("staff.") || scope.operation === "season.create" || scope.operation === "configuration.write" && command?.type === "club.updated")) scope.requestedRole = "administrator";
  return scope;
}

// apps/api/src/brand-service.ts
import { randomBytes as randomBytes4, randomUUID as randomUUID5, createHash as createHash7, timingSafeEqual as timingSafeEqual2 } from "node:crypto";
import { chmodSync as chmodSync3, mkdirSync as mkdirSync3 } from "node:fs";
import { readFile as readFile2 } from "node:fs/promises";
import { resolve as resolve2, join as join2, sep as sep2 } from "node:path";

// packages/application/src/branding.ts
var BRAND_POLICY_VERSION = "logo-rights-v1";
var object6 = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
var id4 = (value) => typeof value === "string" && value.length >= 1 && value.length <= 150 && !/[^A-Za-z0-9_-]/.test(value);
var integer5 = (value) => Number.isSafeInteger(value) && Number(value) >= 0;
function requireThat6(value, message) {
  if (!value) throw new AccessError("INVALID_BRANDING", 422, message);
}
function unavailable2() {
  throw new AccessError("NOT_FOUND", 404, "The requested branding is unavailable.");
}
function strict(value, keys2) {
  requireThat6(Object.keys(value).every((key) => keys2.includes(key)), "Unexpected branding fields. Asset ancestry is assigned by the service.");
}
function kind(value) {
  return value === "club_logo" || value === "team_logo";
}
function validateContext(context) {
  requireThat6(id4(context.clubId) && id4(context.teamId) && id4(context.authoritySeasonId) && integer5(context.nowMs), "Use the current verified branding scope.");
  assertTeamRole(context.principal, context.memberships, context.teamId, context.authoritySeasonId, [context.selectedRole], context.nowMs);
  if (context.selectedRole === "administrator" || context.selectedRole === "manager") assertAdultAuthority(context.principal, false, context.nowMs);
  if (context.selectedRole === "spectator" && context.spectatorGrantActive !== true) unavailable2();
}
function brandScope(context, assetKind) {
  requireThat6(kind(assetKind), "Choose a club or team logo.");
  return { kind: assetKind, clubId: context.clubId, teamId: assetKind === "club_logo" ? null : context.teamId };
}
function assertBrandAuthority(context, assetKind) {
  requireThat6(kind(assetKind), "Choose a club or team logo.");
  validateContext(context);
  if (assetKind === "club_logo" ? context.selectedRole !== "administrator" : context.selectedRole !== "manager") unavailable2();
  assertAdultAuthority(context.principal, false, context.nowMs);
}
function sameScope(context, value) {
  return kind(value.kind) && value.clubId === context.clubId && value.teamId === (value.kind === "club_logo" ? null : context.teamId);
}
function emptyBrandSlot(context, assetKind) {
  return { ...brandScope(context, assetKind), version: 0, assetId: null, assetRevision: null, reviewedRevision: null, policyVersion: null, confirmedBy: null, confirmedAt: null };
}
function reference(context, slot) {
  requireThat6(sameScope(context, slot) && integer5(slot.version), "The saved logo slot has inconsistent ancestry.");
  if (slot.assetId === null) {
    requireThat6(slot.assetRevision === null && slot.reviewedRevision === null, "An empty logo slot cannot retain an asset revision.");
    return null;
  }
  requireThat6(id4(slot.assetId) && integer5(slot.assetRevision) && slot.assetRevision > 0 && slot.reviewedRevision === slot.assetRevision && id4(slot.confirmedBy) && integer5(slot.confirmedAt) && id4(slot.policyVersion), "The published logo must match its reviewed revision and recorded publication.");
  return { assetId: slot.assetId, revision: slot.assetRevision, ...brandScope(context, slot.kind) };
}
function resolveBranding(context, club, team) {
  requireThat6(club.kind === "club_logo" && team.kind === "team_logo", "Use separate club and team logo slots.");
  const clubLogo = reference(context, club), teamLogo = reference(context, team);
  return teamLogo ? { source: "team", logo: teamLogo } : clubLogo ? { source: "club", logo: clubLogo } : { source: "neutral", logo: null };
}
function brandingView(input) {
  const { context, club, team, clubSlot, teamSlot } = input;
  validateContext(context);
  requireThat6(club.id === context.clubId && team.id === context.teamId, "The branding labels belong to another scope.");
  const writable = (assetKind) => {
    try {
      assertBrandAuthority(context, assetKind);
      return true;
    } catch {
      return false;
    }
  };
  return {
    kind: "team-branding",
    teamId: context.teamId,
    clubId: context.clubId,
    authoritySeasonId: context.authoritySeasonId,
    policyVersion: context.policyVersion ?? BRAND_POLICY_VERSION,
    club: { ...club, slotVersion: clubSlot.version, logo: reference(context, clubSlot) },
    team: { ...team, slotVersion: teamSlot.version, logo: reference(context, teamSlot) },
    effective: resolveBranding(context, clubSlot, teamSlot),
    canWriteClub: writable("club_logo"),
    canWriteTeam: writable("team_logo"),
    assets: input.assets.filter((asset) => asset.ownerId === context.principal.accountId && sameScope(context, asset) && writable(asset.kind)).map((asset) => ({ assetId: asset.assetId, revision: asset.revision, kind: asset.kind, clubId: asset.clubId, teamId: asset.teamId, status: asset.status, byteSize: asset.byteSize, width: asset.width, height: asset.height, createdAt: asset.createdAt, processedAt: asset.processedAt }))
  };
}
function parseLogoPrepareInput(value) {
  requireThat6(object6(value) && kind(value.kind), "Choose an explicit club or team logo.");
  strict(value, ["kind", value.kind === "club_logo" ? "clubId" : "teamId", "byteSize", "mimeType", "sha256", "policyAcknowledged"]);
  requireThat6(id4(value.kind === "club_logo" ? value.clubId : value.teamId), "Use a valid logo-scope identifier.");
  requireThat6(integer5(value.byteSize) && value.byteSize > 0 && value.byteSize <= 15 * 1024 * 1024 && ["image/jpeg", "image/png", "image/heic"].includes(String(value.mimeType)) && typeof value.sha256 === "string" && value.sha256.length === 64 && /^[a-fA-F0-9]{64}$/.test(value.sha256) && value.policyAcknowledged === true, "Use a JPEG, PNG or HEIC up to 15 MiB with SHA-256 and explicit policy acknowledgement.");
  return { ...value, sha256: value.sha256.toLowerCase() };
}
function assertLogoPrepareScope(context, input) {
  const parsed = parseLogoPrepareInput(input);
  assertBrandAuthority(context, parsed.kind);
  if (parsed.kind === "club_logo" ? parsed.clubId !== context.clubId : parsed.teamId !== context.teamId) unavailable2();
  return brandScope(context, parsed.kind);
}
function parseBrandingCommand(value, expectedKind) {
  requireThat6(object6(value) && kind(value.kind) && (!expectedKind || expectedKind === value.kind), "Use the requested logo kind.");
  requireThat6(id4(value.id) && integer5(value.expectedSlotVersion), "Use a stable command identity and current slot version.");
  if (value.type === "logo.removed") strict(value, ["id", "type", "kind", "expectedSlotVersion"]);
  else {
    requireThat6(value.type === "logo.published", "Use an explicit publish or remove command.");
    strict(value, ["id", "type", "kind", "expectedSlotVersion", "assetId", "reviewedRevision", "confirmRightsToUse", "policyVersion"]);
    requireThat6(id4(value.assetId) && integer5(value.reviewedRevision) && value.reviewedRevision > 0 && value.confirmRightsToUse === true && id4(value.policyVersion), "Review the exact processed revision and confirm the rights policy before publishing.");
  }
  return { ...value };
}
function planBrandingCommand(context, slot, asset, input) {
  const command = parseBrandingCommand(input);
  assertBrandAuthority(context, command.kind);
  requireThat6(slot.kind === command.kind, "Choose the matching logo slot.");
  const before = reference(context, slot);
  if (slot.version !== command.expectedSlotVersion) throw new AccessError("STALE_REVISION", 409, "The logo changed. Refresh and review before replacing it.");
  let after = null;
  if (command.type === "logo.published") {
    if (!asset || asset.ownerId !== context.principal.accountId || !sameScope(context, asset) || asset.kind !== command.kind || asset.assetId !== command.assetId) unavailable2();
    requireThat6(asset.revision === command.reviewedRevision && ["processed", "published"].includes(asset.status) && asset.scannerClean === true && integer5(asset.processedAt) && integer5(asset.width) && asset.width > 0 && integer5(asset.height) && asset.height > 0, "Publish only the exact clean, processed image revision you reviewed.");
    requireThat6(command.policyVersion === (context.policyVersion ?? BRAND_POLICY_VERSION), "Review the current logo rights policy before publishing.");
    after = { assetId: asset.assetId, revision: asset.revision, ...brandScope(context, command.kind) };
  }
  const updated = { ...slot, version: slot.version + 1, assetId: after?.assetId ?? null, assetRevision: after?.revision ?? null, reviewedRevision: after?.revision ?? null, policyVersion: command.type === "logo.published" ? command.policyVersion : null, confirmedBy: context.principal.accountId, confirmedAt: context.nowMs };
  return { slot: updated, asset: command.type === "logo.published" ? { ...asset, status: "published" } : null, audit: { commandId: command.id, actorId: context.principal.accountId, action: command.type, kind: command.kind, clubId: context.clubId, teamId: command.kind === "team_logo" ? context.teamId : null, before, after, at: context.nowMs } };
}
function authorizeBrandAsset(input) {
  const { context, asset, slot, revision, mode } = input;
  validateContext(context);
  if (!sameScope(context, asset) || !integer5(revision) || revision < 1 || asset.revision !== revision) unavailable2();
  if (asset.scannerClean !== true || !["processed", "published"].includes(asset.status)) unavailable2();
  if (mode === "own") {
    assertBrandAuthority(context, asset.kind);
    if (asset.ownerId !== context.principal.accountId) unavailable2();
  } else if (mode === "published") {
    const current3 = reference(context, slot);
    if (slot.kind !== asset.kind || asset.status !== "published" || current3?.assetId !== asset.assetId || current3.revision !== revision) unavailable2();
  } else unavailable2();
  return { assetId: asset.assetId, revision: asset.revision, ...brandScope(context, asset.kind) };
}

// apps/api/src/brand-service.ts
var hash3 = (value) => createHash7("sha256").update(value).digest("hex");
var id5 = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(value);
function unavailable3() {
  throw new AccessError("NOT_FOUND", 404, "The requested branding is unavailable.");
}
function fail6(code, status2, message) {
  throw new AccessError(code, status2, message);
}
var reference2 = (row) => ({ assetId: row.asset_id, revision: row.revision, kind: row.kind, clubId: row.club_id, teamId: row.team_id });
var sameScope2 = (authority, row) => row.club_id === authority.context.clubId && row.team_id === (row.kind === "club_logo" ? null : authority.context.teamId);
var BrandMediaService = class {
  constructor(options2) {
    this.options = options2;
    this.directory = resolve2(options2.directory, "branding");
    this.now = options2.now ?? Date.now;
    for (const directory of [this.directory, join2(this.directory, "quarantine"), join2(this.directory, "derivatives")]) {
      mkdirSync3(directory, { recursive: true, mode: 448 });
      chmodSync3(directory, 448);
    }
  }
  options;
  directory;
  now;
  path(key) {
    const path = resolve2(this.directory, key);
    if (!path.startsWith(this.directory + sep2)) throw new Error("PRIVATE_BRANDING_PATH_INVALID");
    return path;
  }
  async slot(authority, kind2) {
    return await this.options.repository.slot(kind2, authority.context.clubId, kind2 === "club_logo" ? null : authority.context.teamId) ?? emptyBrandSlot(authority.context, kind2);
  }
  record(row, slot) {
    const published = slot?.assetId === row.asset_id && slot.assetRevision === row.revision && slot.reviewedRevision === row.revision;
    const status2 = row.status === "linked" ? published ? "published" : "processed" : row.status === "uploading" ? "prepared" : row.status;
    return { ...reference2(row), ownerId: row.owner_id, status: status2, byteSize: row.expected_bytes, width: row.width, height: row.height, createdAt: row.created_at, processedAt: row.processed_at, scannerClean: ["processed", "linked"].includes(row.status) && Boolean(row.scanner_engine) && row.processed_at !== null && row.width !== null && row.height !== null };
  }
  async view(authority) {
    const clubSlot = await this.slot(authority, "club_logo"), teamSlot = await this.slot(authority, "team_logo");
    const rows = await this.options.repository.own(authority.context.principal.accountId, authority.context.clubId, authority.context.teamId);
    return brandingView({ ...authority, clubSlot, teamSlot, assets: rows.map((row) => this.record(row, row.kind === "club_logo" ? clubSlot : teamSlot)) });
  }
  async get(session) {
    return this.view(await this.options.load(session));
  }
  async row(session, uploadId, token) {
    if (!id5(uploadId)) unavailable3();
    const authority = await this.options.load(session), row = await this.options.repository.upload(uploadId);
    if (!row || row.owner_id !== authority.context.principal.accountId || !sameScope2(authority, row)) unavailable3();
    assertBrandAuthority(authority.context, row.kind);
    if (token !== void 0 && (typeof token !== "string" || token.length > 256 || !timingSafeEqual2(Buffer.from(row.token_hash, "hex"), Buffer.from(hash3(token), "hex")))) unavailable3();
    return { row, authority };
  }
  async prepare(session, requestId, input) {
    if (!id5(requestId)) fail6("INVALID_REQUEST", 400, "A stable upload request identity is required.");
    const parsed = parseLogoPrepareInput(input);
    return this.options.repository.transaction(async () => {
      const authority = await this.options.load(session), scope = assertLogoPrepareScope(authority.context, parsed);
      await this.options.repository.ensureScope(authority);
      const signature2 = hash3(JSON.stringify([scope.kind, scope.clubId, scope.teamId, parsed.byteSize, parsed.mimeType, parsed.sha256, parsed.policyAcknowledged]));
      const previous = await this.options.repository.byRequest(authority.context.principal.accountId, requestId), token = randomBytes4(32).toString("base64url");
      if (previous) {
        if (previous.request_signature !== signature2 || !sameScope2(authority, previous)) fail6("IDEMPOTENCY_CONFLICT", 409, "This request identity already belongs to another logo upload.");
        if (previous.expires_at <= this.now() && ["prepared", "uploading"].includes(previous.status)) fail6("UPLOAD_EXPIRED", 410, "The upload window expired. Prepare a new upload; the private history is retained.");
        if (!await this.options.repository.rotateToken(previous.id, hash3(token))) unavailable3();
        return { kind: "prepared-logo-upload", uploadId: previous.id, asset: reference2(previous), uploadToken: token, expiresAtMs: previous.expires_at, maxBytes: MEDIA_LIMITS.maxBytes };
      }
      const row = { id: randomUUID5(), asset_id: `logo-${randomUUID5()}`, revision: 1, kind: scope.kind, club_id: scope.clubId, team_id: scope.teamId, owner_id: authority.context.principal.accountId, request_id: requestId, request_signature: signature2, status: "prepared", expected_bytes: parsed.byteSize, expected_sha: parsed.sha256, declared_mime: parsed.mimeType, token_hash: hash3(token), expires_at: this.now() + MEDIA_LIMITS.uploadWindowMs, created_at: this.now(), processed_at: null, original_key: null, display_key: null, thumbnail_key: null, width: null, height: null, scanner_engine: null, failure_code: null, attempt: null, lease_until: null };
      await this.options.repository.create(row);
      return { kind: "prepared-logo-upload", uploadId: row.id, asset: reference2(row), uploadToken: token, expiresAtMs: row.expires_at, maxBytes: MEDIA_LIMITS.maxBytes };
    });
  }
  async upload(session, uploadId, token, source2) {
    const { row } = await this.row(session, uploadId, token), duplicate = ["uploaded", "processed", "linked"].includes(row.status);
    if (!duplicate && row.expires_at <= this.now()) fail6("UPLOAD_EXPIRED", 410, "The private upload window expired.");
    const attempt2 = randomUUID5(), key = `quarantine/${row.id}-${attempt2}.upload`;
    if (!duplicate && !await this.options.repository.lease(row.id, "uploading", attempt2, this.now())) fail6("UPLOAD_BUSY", 409, "The logo is already uploading or cannot be changed.");
    try {
      const byteSize = await receivePrivateImage({ source: source2, expectedBytes: row.expected_bytes, expectedSha: row.expected_sha, ...duplicate ? {} : { temporaryPath: this.path(key + ".part"), destinationPath: this.path(key) } });
      await this.row(session, uploadId, token);
      if (!duplicate && !await this.options.repository.uploaded(row.id, attempt2, key)) fail6("UPLOAD_LEASE_CHANGED", 409, "The logo upload lease changed. No publication was performed.");
      return { uploadId, status: "uploaded", byteSize };
    } catch (error) {
      if (!duplicate) await this.options.repository.failed(row.id, attempt2, "uploading", "UPLOAD_INCOMPLETE", true);
      throw error;
    }
  }
  completion(row) {
    if (row.width === null || row.height === null) fail6("UPLOAD_NOT_READY", 409, "Finish private processing before reviewing this logo.");
    return { kind: "processed-logo-upload", uploadId: row.id, asset: reference2(row), status: "processed", width: row.width, height: row.height };
  }
  async complete(session, uploadId, token) {
    const { row } = await this.row(session, uploadId, token);
    if (["processed", "linked"].includes(row.status)) return this.completion(row);
    if (!row.original_key) fail6("UPLOAD_NOT_READY", 409, "Finish the private upload before processing.");
    const attempt2 = randomUUID5();
    if (!await this.options.repository.lease(row.id, "processing", attempt2, this.now())) fail6("UPLOAD_NOT_READY", 409, "An active processing attempt cannot be duplicated.");
    try {
      const displayKey = `derivatives/${row.asset_id}-r${row.revision}-${attempt2}-display.png`, thumbnailKey = `derivatives/${row.asset_id}-r${row.revision}-${attempt2}-thumbnail.png`;
      const processed = await processPrivateImage({ originalPath: this.path(row.original_key), displayPath: this.path(displayKey), thumbnailPath: this.path(thumbnailKey), expectedBytes: row.expected_bytes, expectedSha: row.expected_sha, declaredMime: row.declared_mime, scanner: this.options.scanner, kind: "logo" });
      const { authority } = await this.row(session, uploadId, token);
      if (!await this.options.repository.processed(row.id, attempt2, { displayKey, thumbnailKey, width: processed.width, height: processed.height, scannerEngine: processed.scannerEngine, at: authority.context.nowMs })) fail6("PROCESSING_LEASE_CHANGED", 409, "The processing lease changed. No publication was performed.");
      return this.completion((await this.row(session, uploadId, token)).row);
    } catch (error) {
      const code = error instanceof AccessError ? error.code : "MEDIA_PROCESSING_FAILED", retryable = ["SCANNER_REQUIRED", "SCANNER_UNAVAILABLE", "MEDIA_PROCESSING_FAILED", "HEIC_DECODER_REQUIRED"].includes(code);
      await this.options.repository.failed(row.id, attempt2, "processing", code, retryable);
      throw error instanceof AccessError ? error : new AccessError("MEDIA_PROCESSING_FAILED", 503, "Private logo processing is unavailable. No logo was published.");
    }
  }
  async command(session, input) {
    const command = parseBrandingCommand(input);
    return this.options.repository.transaction(async () => {
      const authority = await this.options.load(session);
      assertBrandAuthority(authority.context, command.kind);
      await this.options.repository.ensureScope(authority);
      const slot = await this.slot(authority, command.kind), row = command.type === "logo.published" ? await this.options.repository.asset(command.assetId, command.reviewedRevision) : void 0;
      const plan = planBrandingCommand(authority.context, slot, row ? this.record(row, slot) : null, command);
      if (!await this.options.repository.setSlot(plan.slot, slot.version)) fail6("STALE_REVISION", 409, "The logo changed. Refresh and review its current revision.");
      if (row) await this.options.repository.linked(row.id);
      await this.options.audit(authority.context.principal, command.type, command.type === "logo.published" ? command.assetId : command.kind, JSON.stringify(plan.audit));
      return { kind: "branding-command-receipt", commandId: command.id, revision: plan.slot.version, acceptedAt: new Date(authority.context.nowMs).toISOString(), branding: await this.view(authority) };
    });
  }
  async gateway(session, assetId, revision, variant, mode = "published") {
    if (!id5(assetId) || !Number.isSafeInteger(revision) || revision < 1 || !["display", "thumbnail"].includes(variant) || !["own", "published"].includes(mode)) unavailable3();
    const authority = await this.options.load(session), row = await this.options.repository.asset(assetId, revision);
    if (!row) unavailable3();
    let slot = await this.slot(authority, row.kind);
    authorizeBrandAsset({ context: authority.context, asset: this.record(row, slot), slot, revision, mode });
    const key = variant === "display" ? row.display_key : row.thumbnail_key;
    if (!key) unavailable3();
    let body;
    try {
      body = await readFile2(this.path(key));
    } catch {
      unavailable3();
    }
    const fresh = await this.options.load(session);
    slot = await this.slot(fresh, row.kind);
    authorizeBrandAsset({ context: fresh.context, asset: this.record(row, slot), slot, revision, mode });
    return { body, headers: { "Content-Type": "image/png", "Content-Length": String(body.length), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } };
  }
};

// apps/api/src/invitation-service.ts
import { createHash as createHash8, randomBytes as randomBytes5, randomUUID as randomUUID6 } from "node:crypto";
var unavailable4 = () => {
  throw new AccessError("INVITATION_UNAVAILABLE", 404, "The invitation is unavailable for this account and current team season.");
};
var invalid4 = () => {
  throw new AccessError("INVALID_REQUEST", 400, "Use the exact invitation fields and an explicit expiry from 1 to 48 hours.");
};
var object7 = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
var id6 = (value) => typeof value === "string" && value.length >= 1 && value.length <= 150 && !/[^A-Za-z0-9_-]/.test(value);
function invitationVerifier(token) {
  try {
    return createHash8("sha256").update(invitationTokenHashInput(token)).digest("hex");
  } catch {
    return unavailable4();
  }
}
function parseInvitationAccept(value) {
  if (!object7(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, "token")) return invalid4();
  invitationVerifier(value.token);
  return { token: value.token };
}
function parseInvitationWrite(value, defaultHours) {
  if (!object7(value) || Object.keys(value).some((key) => !["seasonId", "expiresInHours"].includes(key)) || !id6(value.seasonId)) return invalid4();
  const hours = value.expiresInHours ?? defaultHours;
  if (!Number.isInteger(hours) || Number(hours) < 1 || Number(hours) > 48) return invalid4();
  return { seasonId: value.seasonId, expiresInHours: Number(hours) };
}
var SpectatorInvitationService = class {
  constructor(options2) {
    this.options = options2;
    this.now = options2.now ?? Date.now;
  }
  options;
  now;
  operation(action, session, source2) {
    return JSON.stringify(["invitation", action, session.teamId, session.seasonId, session.role ?? "default", source2 ?? null]);
  }
  identity(session, key) {
    if (session.principal.status !== "active" || !id6(session.teamId) || !id6(session.seasonId)) unavailable4();
    if (key !== void 0 && (key.length < 8 || key.length > 150 || /[^A-Za-z0-9_-]/.test(key))) invalid4();
  }
  async prior(session, operation, key, payload) {
    const signature2 = createHash8("sha256").update(JSON.stringify(payload)).digest("hex");
    const prior = await this.options.repository.receipt(session.principal.accountId, operation, key);
    if (prior && prior.signature !== signature2) throw new AccessError("IDEMPOTENCY_CONFLICT", 409, "The invitation request identity was already used with different content.");
    return { signature: signature2, prior };
  }
  configuration() {
    let entry;
    try {
      entry = new URL(this.options.publicAppEntryUrl ?? "");
    } catch {
      throw new AccessError("INVITATION_NOT_CONFIGURED", 503, "Configure the owned application entry URL and invitation policy before issuing invitations.");
    }
    const policy = this.options.invitationPolicyVersion;
    if (entry.protocol !== "https:" && !(entry.protocol === "http:" && entry.hostname === "localhost") || entry.username || entry.password || entry.search || entry.hash || !policy || policy.length > 150 || /[\u0000-\u001f\u007f]/.test(policy)) throw new AccessError("INVITATION_NOT_CONFIGURED", 503, "Configure the owned application entry URL and invitation policy before issuing invitations.");
    return { entry, policy };
  }
  async list(session) {
    this.identity(session);
    const actor = await this.options.repository.actor(session);
    if (!["manager", "player"].includes(actor.role)) unavailable4();
    const state = await this.options.repository.state(session.teamId, session.seasonId), now = this.now();
    const invitationAllowed = await this.options.repository.invitationAllowed(session);
    return { kind: "spectator-invitations", teamId: session.teamId, seasonId: session.seasonId, revision: state.revision, invitations: state.invitations.filter((invite) => invite.teamId === session.teamId && invite.seasonId === session.seasonId && (actor.role === "manager" || invite.inviterAccountId === actor.accountId)).map((invite) => {
      const view = publicInvitation(invite, now);
      const pending = invite.acceptedBy === null && invite.acceptedAtMs === null && (invite.revokedAtMs === null || invite.credential.kind === "legacy_retired" && invite.credential.requiresReissue);
      const season = state.seasons.find((item) => item.id === session.seasonId && item.teamId === session.teamId);
      return { id: invite.id, teamId: invite.teamId, seasonId: invite.seasonId, expiresAt: new Date(invite.expiresAtMs).toISOString(), status: view.requiresReissue ? "requires_reissue" : view.state, canReissue: Boolean(invitationAllowed && pending && season && season.accessEndsAtMs > now && !state.invitations.some((other) => other.reissuedFromInvitationId === invite.id)), canRevoke: actor.role === "manager" && invite.revokedAtMs === null };
    }) };
  }
  async issue(session, key, value, sourceInvitationId) {
    this.identity(session, key);
    const input = parseInvitationWrite(value, this.options.defaultInviteExpiryHours);
    if (input.seasonId !== session.seasonId || sourceInvitationId !== void 0 && !id6(sourceInvitationId)) return invalid4();
    const { entry, policy } = this.configuration(), repo = this.options.repository;
    return repo.transaction(async () => {
      const actor = await repo.actor(session);
      if (!["manager", "player"].includes(actor.role)) unavailable4();
      const state = await repo.state(session.teamId, session.seasonId, true);
      const operation = this.operation(sourceInvitationId ? "reissue" : "issue", session, sourceInvitationId);
      const { prior, signature: signature2 } = await this.prior(session, operation, key, input);
      if (prior) return { status: 200, body: prior.response };
      if (!await repo.invitationAllowed(session, true)) throw new AccessError("TEAM_INVITATIONS_SUSPENDED", 403, "Creating or reissuing invitations is suspended in this team. Existing invitations and grants retain their separate recorded status.");
      const now = this.now(), season = state.seasons.find((item) => item.id === session.seasonId && item.teamId === session.teamId);
      if (!season || season.accessEndsAtMs <= now) return unavailable4();
      const expiresAtMs = Math.min(now + input.expiresInHours * 36e5, season.accessEndsAtMs);
      const token = randomBytes5(32).toString("base64url"), tokenHash = invitationVerifier(token), invitationId = randomUUID6();
      const base = { id: key, invitationId, tokenHash, expiresAtMs };
      const next = applyVerifiedInvitationCommand(state, actor, sourceInvitationId ? { ...base, type: "invite.reissued", sourceInvitationId } : { ...base, type: "invite.issued" }, now);
      entry.hash = new URLSearchParams({ longballInvite: "1", teamId: session.teamId, seasonId: session.seasonId, code: token }).toString();
      const receipt = { id: invitationId, shareUrl: entry.href, expiresAt: new Date(expiresAtMs).toISOString(), teamId: session.teamId, seasonId: session.seasonId };
      await repo.save(session, next, sourceInvitationId ? [sourceInvitationId, invitationId] : [invitationId], policy);
      await repo.saveReceipt(session.principal.accountId, operation, key, { signature: signature2, response: redactInviteCreated(receipt) });
      await repo.audit(session.principal, sourceInvitationId ? "invite.reissued" : "invite.issued", invitationId);
      return { status: 201, body: receipt };
    });
  }
  async resolve(principal, value) {
    if (principal.status !== "active") return unavailable4();
    const { token } = parseInvitationAccept(value), tokenHash = invitationVerifier(token);
    const found = await this.options.repository.resolve(principal, tokenHash);
    if (!found) return unavailable4();
    return { ...found, tokenHash };
  }
  async inspect(principal, value) {
    const { invitationId, teamId, seasonId, expiresAt } = await this.resolve(principal, value);
    return { invitationId, teamId, seasonId, expiresAt };
  }
  async accept(session, key, value) {
    this.identity(session, key);
    const { token } = parseInvitationAccept(value), tokenHash = invitationVerifier(token), repo = this.options.repository;
    return repo.transaction(async () => {
      const actor = await repo.actor(session, true), state = await repo.state(session.teamId, session.seasonId, true);
      const operation = this.operation("accept", session), { prior, signature: signature2 } = await this.prior(session, operation, key, { tokenHash });
      if (prior) return { status: 200, body: prior.response };
      const now = this.now(), existing = state.invitations.find((invite) => invite.credential.kind === "sha256" && invite.credential.tokenHash === tokenHash && invite.teamId === session.teamId && invite.seasonId === session.seasonId);
      if (!existing || existing.revokedAtMs !== null || existing.acceptedBy !== null && existing.acceptedBy !== actor.accountId) return unavailable4();
      let next = state;
      if (existing.acceptedBy === null) {
        if (!pendingInvitation(state, tokenHash, now, session)) return unavailable4();
        next = applyVerifiedInvitationCommand(state, actor, { id: key, type: "invite.accepted_verified", invitationId: existing.id, tokenHash }, now);
      }
      const grant = next.grants.find((item) => item.invitationId === existing.id && item.accountId === actor.accountId && item.revokedAtMs === null && item.expiresAtMs > now);
      if (!grant) return unavailable4();
      const receipt = { invitationId: existing.id, teamId: session.teamId, seasonId: session.seasonId, expiresAt: new Date(grant.expiresAtMs).toISOString() };
      if (next !== state) await repo.save(session, next, [existing.id], null);
      await repo.saveReceipt(session.principal.accountId, operation, key, { signature: signature2, response: receipt });
      if (next !== state) await repo.audit(session.principal, "invite.accepted", existing.id);
      return { status: 200, body: receipt };
    });
  }
  async revoke(session, key, invitationId) {
    this.identity(session, key);
    if (!id6(invitationId)) return invalid4();
    const repo = this.options.repository;
    return repo.transaction(async () => {
      const actor = await repo.actor(session);
      if (actor.role !== "manager") return unavailable4();
      const state = await repo.state(session.teamId, session.seasonId, true), operation = this.operation("revoke", session, invitationId);
      const { prior, signature: signature2 } = await this.prior(session, operation, key, { invitationId });
      if (prior) return { status: 200, body: prior.response };
      const invite = state.invitations.find((item) => item.id === invitationId && item.teamId === session.teamId && item.seasonId === session.seasonId);
      if (!invite) return unavailable4();
      const next = invite.revokedAtMs === null ? applyCommunityCommand(state, actor, { id: key, type: "invite.revoked", invitationId }, this.now()) : state;
      if (next !== state) await repo.save(session, next, [invitationId], null);
      const receipt = { invitationId, revoked: true };
      await repo.saveReceipt(session.principal.accountId, operation, key, { signature: signature2, response: receipt });
      if (next !== state) await repo.audit(session.principal, "invite.revoked", invitationId);
      return { status: 200, body: receipt };
    });
  }
};
function invitationChangedRows(state, ids) {
  return ids.map((id9) => {
    const invite = state.invitations.find((item) => item.id === id9);
    if (!invite) throw new Error("INVITATION_PROJECTION_MISSING");
    return invite;
  });
}
function invitationGrantProjection(state, changedIds) {
  const affected = new Set(state.grants.filter((grant) => changedIds.includes(grant.invitationId)).map((grant) => JSON.stringify([grant.accountId, grant.teamId, grant.seasonId])));
  return { ...state, grants: state.grants.filter((grant) => affected.has(JSON.stringify([grant.accountId, grant.teamId, grant.seasonId]))) };
}
function assertInvitationMirror(invite, row) {
  if (!invite || invite.credential.kind === "fictional_review") throw new AccessError("INVITATION_RECONCILIATION_REQUIRED", 409, "Retained invitation evidence differs. Preserve it for authorised review.");
  const credential = invite.credential;
  const compatible = JSON.stringify([invite.id, invite.teamId, invite.seasonId, invite.inviterAccountId, invite.createdAtMs, invite.expiresAtMs, invite.acceptedBy, invite.acceptedAtMs, invite.revokedAtMs, invite.reissuedFromInvitationId, credential.kind, credential.version]) === JSON.stringify([row.id, row.team_id, row.season_id, row.inviter_account_id, Number(row.created_at), Number(row.expires_at), row.accepted_by, row.accepted_at === null ? null : Number(row.accepted_at), row.revoked_at === null ? null : Number(row.revoked_at), row.reissued_from_invitation_id, row.credential_kind, Number(row.credential_version)]) && (credential.kind === "sha256" ? credential.tokenHash === row.token_hash : credential.fingerprint === row.legacy_fingerprint && credential.redactedAtMs === Number(row.retired_at) && credential.requiresReissue === Boolean(row.requires_reissue));
  if (!compatible) throw new AccessError("INVITATION_RECONCILIATION_REQUIRED", 409, "Retained invitation evidence differs. Preserve it for authorised review; no invitation or grant was changed.");
}

// apps/api/src/invitation-repository.ts
import { createHash as createHash9 } from "node:crypto";

// packages/application/src/invitation-redaction.ts
var LEGACY_INVITATION_FINGERPRINT_DOMAIN = "longball.spectator-invitation.legacy-retired.v1:";
var LEGACY_INVITATION_COMMAND_DOMAIN = "longball.spectator-invitation.command-retired.v1:";
var RETIRED_INVITATION_COMMAND_PREFIX = "invitation-command-retired:v1:";
function checkedDigest(digest3, input) {
  const result = digest3(input);
  if (!isInvitationTokenHash(result))
    throw new Error("The invitation retirement digest is unavailable.");
  return result;
}
function legacyInvitationFingerprintInput(id9, code) {
  return `${LEGACY_INVITATION_FINGERPRINT_DOMAIN}${id9.length}:${id9}:${code}`;
}
function redactLegacyInvitationCommand(value, digest3) {
  if (value.startsWith(RETIRED_INVITATION_COMMAND_PREFIX)) return value;
  let legacy = false;
  try {
    const parsed = JSON.parse(value);
    const command = Array.isArray(parsed) ? parsed[1] : null;
    legacy = Boolean(
      command && typeof command === "object" && ["invite.created", "invite.accepted"].includes(command.type) && Object.hasOwn(command, "reviewCode")
    );
  } catch {
    legacy = /"reviewCode"\s*:/.test(value);
  }
  return legacy ? RETIRED_INVITATION_COMMAND_PREFIX + checkedDigest(digest3, LEGACY_INVITATION_COMMAND_DOMAIN + value) : value;
}
function retireLegacyInvitationCredentials(state, atMs, digest3) {
  if (!Number.isSafeInteger(atMs) || atMs < 0)
    throw new Error("A valid invitation retirement time is required.");
  const evidence = {
    version: 1,
    atMs,
    invitationIds: [],
    commandIds: []
  };
  const next = JSON.parse(JSON.stringify(state));
  next.invitations = next.invitations.map((invite) => {
    const raw = invite;
    const hasPlaintext = Object.hasOwn(raw, "reviewCode") || raw.credential?.kind === "fictional_review";
    if (raw.credential?.kind === "sha256" && !hasPlaintext || raw.credential?.kind === "legacy_retired" && !hasPlaintext)
      return invite;
    const code = typeof raw.reviewCode === "string" ? raw.reviewCode : raw.credential?.kind === "fictional_review" ? raw.credential.code : "";
    const requiresReissue = raw.acceptedBy === null && raw.acceptedAtMs === null && raw.revokedAtMs === null;
    evidence.invitationIds.push(raw.id);
    return {
      id: raw.id,
      teamId: raw.teamId,
      seasonId: raw.seasonId,
      inviterAccountId: raw.inviterAccountId,
      createdAtMs: raw.createdAtMs,
      expiresAtMs: raw.expiresAtMs,
      acceptedBy: raw.acceptedBy,
      acceptedAtMs: raw.acceptedAtMs,
      revokedAtMs: requiresReissue ? atMs : raw.revokedAtMs,
      reissuedFromInvitationId: raw.reissuedFromInvitationId ?? null,
      credential: {
        kind: "legacy_retired",
        version: 1,
        redactedAtMs: atMs,
        fingerprint: checkedDigest(
          digest3,
          legacyInvitationFingerprintInput(raw.id, code)
        ),
        requiresReissue
      }
    };
  });
  for (const [id9, fingerprint3] of Object.entries(next.appliedCommands)) {
    const redacted = redactLegacyInvitationCommand(fingerprint3, digest3);
    if (redacted !== fingerprint3) {
      next.appliedCommands[id9] = redacted;
      evidence.commandIds.push(id9);
    }
  }
  if (!evidence.invitationIds.length && !evidence.commandIds.length)
    return { state, evidence };
  next.revision += 1;
  next.audit.push({
    id: `invitation-retirement:${next.revision}`,
    actorAccountId: null,
    action: "service.invitation_legacy_credentials_retired",
    atMs
  });
  return { state: next, evidence };
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function redactRetainedInvitationResponse(value, atMs, digest3) {
  if (!Number.isSafeInteger(atMs) || atMs < 0)
    throw new Error("A valid invitation retirement time is required.");
  if (Array.isArray(value))
    return value.map(
      (item) => redactRetainedInvitationResponse(item, atMs, digest3)
    );
  if (!record(value)) return value;
  if (typeof value.shareUrl === "string" && typeof value.id === "string" && typeof value.teamId === "string" && typeof value.seasonId === "string") {
    return {
      id: value.id,
      expiresAt: value.expiresAt,
      teamId: value.teamId,
      seasonId: value.seasonId,
      credentialAvailable: false,
      requiresReissue: true
    };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key === "invitations" && Array.isArray(item)) {
        return [
          key,
          item.filter(record).map(
            (invite) => publicInvitation(invite, atMs)
          )
        ];
      }
      if (key === "appliedCommands" && record(item)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(item).map(([id9, fingerprint3]) => [
              id9,
              typeof fingerprint3 === "string" ? redactLegacyInvitationCommand(fingerprint3, digest3) : fingerprint3
            ])
          )
        ];
      }
      return [key, redactRetainedInvitationResponse(item, atMs, digest3)];
    })
  );
}

// apps/api/src/invitation-repository.ts
var SQLITE_INVITATIONS_DDL = `CREATE TABLE IF NOT EXISTS spectator_invitations(
 id TEXT PRIMARY KEY,club_id TEXT NOT NULL,team_id TEXT NOT NULL REFERENCES teams(id),season_id TEXT NOT NULL,inviter_account_id TEXT NOT NULL REFERENCES accounts(id),
 credential_kind TEXT NOT NULL CHECK(credential_kind IN('sha256','legacy_retired')),credential_version INTEGER NOT NULL DEFAULT 1,
 token_hash TEXT UNIQUE,legacy_fingerprint TEXT,retired_at INTEGER,requires_reissue INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,accepted_by TEXT REFERENCES accounts(id),accepted_at INTEGER,revoked_at INTEGER,
 reissued_from_invitation_id TEXT REFERENCES spectator_invitations(id),policy_version TEXT,
 CHECK((credential_kind='sha256' AND token_hash IS NOT NULL AND policy_version IS NOT NULL) OR(credential_kind='legacy_retired' AND token_hash IS NULL)),
 CHECK((accepted_by IS NULL)=(accepted_at IS NULL)),CHECK(expires_at>created_at));`;
var unavailable5 = () => {
  throw new AccessError("INVITATION_UNAVAILABLE", 404, "The invitation is unavailable.");
};
var SqliteInvitationRepository = class {
  constructor(source2, runtime) {
    this.source = source2;
    this.runtime = runtime;
    source2.database.exec(SQLITE_INVITATIONS_DDL);
  }
  source;
  runtime;
  transaction(work) {
    return this.runtime.transaction(work);
  }
  actor(session, accepting = false) {
    return this.runtime.communityActor(session.principal, session.teamId, session.seasonId, session.role, accepting);
  }
  invitationAllowed(session) {
    return new SqliteTeamPrivilegeRepository(this.source, this.runtime).own(session, "invitations");
  }
  async state(teamId, seasonId) {
    const state = await this.runtime.communityState(teamId, seasonId);
    const rows = this.source.database.prepare("SELECT * FROM spectator_invitations WHERE team_id=? AND season_id=?").all(teamId, seasonId);
    for (const row of rows) assertInvitationMirror(state.invitations.find((invite) => invite.id === row.id), row);
    if (rows.length !== state.invitations.length) throw new AccessError("INVITATION_RECONCILIATION_REQUIRED", 409, "Retained invitation evidence differs. Preserve it for authorised review.");
    return state;
  }
  async initialize() {
    await this.transaction(async () => {
      const docs = this.source.database.prepare("SELECT team_id,season_id FROM documents WHERE kind='community'").all();
      const digest3 = (input) => createHash9("sha256").update(input).digest("hex");
      for (const doc of docs) {
        const state = await this.runtime.document(doc.team_id, doc.season_id, "community");
        const retired = retireLegacyInvitationCredentials(state, this.source.now(), digest3);
        if (retired.state !== state) await this.runtime.saveDocument(doc.team_id, doc.season_id, "community", retired.state);
        for (const invite of retired.state.invitations) {
          if (invite.credential.kind !== "legacy_retired") continue;
          const club = (await this.runtime.document(doc.team_id, doc.season_id, "preparation")).club.id;
          this.source.database.prepare("INSERT INTO spectator_invitations(id,club_id,team_id,season_id,inviter_account_id,credential_kind,legacy_fingerprint,retired_at,requires_reissue,created_at,expires_at,accepted_by,accepted_at,revoked_at,reissued_from_invitation_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING").run(invite.id, club, invite.teamId, invite.seasonId, invite.inviterAccountId, "legacy_retired", invite.credential.fingerprint, invite.credential.redactedAtMs, Number(invite.credential.requiresReissue), invite.createdAtMs, invite.expiresAtMs, invite.acceptedBy, invite.acceptedAtMs, invite.revokedAtMs, invite.reissuedFromInvitationId);
        }
      }
      const receipts = this.source.database.prepare("SELECT account_id,operation,key,response_json FROM idempotency").all();
      for (const row of receipts) {
        const safe = redactRetainedInvitationResponse(JSON.parse(row.response_json), this.source.now(), digest3);
        this.source.database.prepare("UPDATE idempotency SET response_json=? WHERE account_id=? AND operation=? AND key=?").run(JSON.stringify(safe), row.account_id, row.operation, row.key);
      }
    });
  }
  async save(session, state, changedIds, policyVersion) {
    const club = (await this.runtime.document(session.teamId, session.seasonId, "preparation")).club.id;
    await this.runtime.saveDocument(session.teamId, session.seasonId, "community", state);
    for (const invite of invitationChangedRows(state, changedIds)) {
      const existing = this.source.database.prepare("SELECT id FROM spectator_invitations WHERE id=?").get(invite.id);
      if (existing) this.source.database.prepare("UPDATE spectator_invitations SET accepted_by=?,accepted_at=?,revoked_at=?,requires_reissue=? WHERE id=?").run(invite.acceptedBy, invite.acceptedAtMs, invite.revokedAtMs, invite.credential.kind === "legacy_retired" ? Number(invite.credential.requiresReissue) : 0, invite.id);
      else {
        if (invite.credential.kind !== "sha256" || !policyVersion) throw new Error("INVITATION_POLICY_REQUIRED");
        this.source.database.prepare("INSERT INTO spectator_invitations(id,club_id,team_id,season_id,inviter_account_id,credential_kind,token_hash,created_at,expires_at,accepted_by,accepted_at,revoked_at,reissued_from_invitation_id,policy_version) VALUES(?,?,?,?,?,'sha256',?,?,?,?,?,?,?,?)").run(invite.id, club, invite.teamId, invite.seasonId, invite.inviterAccountId, invite.credential.tokenHash, invite.createdAtMs, invite.expiresAtMs, invite.acceptedBy, invite.acceptedAtMs, invite.revokedAtMs, invite.reissuedFromInvitationId, policyVersion);
      }
    }
    await this.runtime.synchronizeSpectatorMemberships(invitationGrantProjection(state, changedIds));
  }
  async receipt(accountId, operation, key) {
    const row = this.source.database.prepare("SELECT signature,response_json FROM idempotency WHERE account_id=? AND operation=? AND key=?").get(accountId, operation, key);
    return row ? { signature: row.signature, response: JSON.parse(row.response_json) } : null;
  }
  async saveReceipt(accountId, operation, key, receipt) {
    this.source.database.prepare("INSERT INTO idempotency(account_id,operation,key,signature,response_json) VALUES(?,?,?,?,?)").run(accountId, operation, key, receipt.signature, JSON.stringify(receipt.response));
  }
  async resolve(principal, tokenHash) {
    const row = this.source.database.prepare("SELECT id,team_id,season_id FROM spectator_invitations WHERE token_hash=?").get(tokenHash);
    if (!row) return null;
    const state = await this.state(row.team_id, row.season_id), now = this.source.now();
    const invite = state.invitations.find((item) => item.id === row.id);
    if (!invite || invite.credential.kind !== "sha256" || invite.credential.tokenHash !== tokenHash || invite.revokedAtMs !== null) return null;
    const ownAccepted = invite.acceptedBy === principal.accountId && state.grants.some((grant) => grant.invitationId === invite.id && grant.accountId === principal.accountId && grant.revokedAtMs === null && grant.expiresAtMs > now);
    if (!pendingInvitation(state, tokenHash, now) && !ownAccepted) return null;
    return { invitationId: invite.id, teamId: invite.teamId, seasonId: invite.seasonId, expiresAt: new Date(invite.expiresAtMs).toISOString() };
  }
  async audit(principal, action, objectId) {
    if (principal.status !== "active") unavailable5();
    await this.runtime.audit(principal, action, objectId, "accepted");
  }
};

// packages/application/src/push-registrations.ts
var object8 = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
var exact = (value, keys2) => Object.keys(value).every((key) => keys2.includes(key)) && keys2.every((key) => Object.hasOwn(value, key));
var opaque5 = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(value);
function parsePushRegistrationInput(value) {
  if (!object8(value) || !exact(value, [
    "deviceId",
    "platform",
    "transport",
    "token",
    "appBuild",
    "permission"
  ]) || !opaque5(value.deviceId) || value.deviceId.length > 120 || !["ios", "android"].includes(String(value.platform)) || !["apns", "fcm", "expo"].includes(String(value.transport)) || typeof value.token !== "string" || value.token.length < 20 || value.token.length > 4096 || /[\s\x00-\x1f\x7f]/u.test(value.token) || typeof value.appBuild !== "string" || value.appBuild.length > 60 || /[\x00-\x1f\x7f]/u.test(value.appBuild) || !["granted", "provisional", "denied"].includes(String(value.permission)))
    throw new Error("Use the exact enrolled-device push registration fields.");
  return {
    deviceId: value.deviceId,
    platform: value.platform,
    transport: value.transport,
    token: value.token,
    appBuild: value.appBuild,
    permission: value.permission
  };
}
function parsePushPlatformPolicies(value) {
  if (!object8(value) || Object.keys(value).some((key) => !["ios", "android"].includes(key)))
    throw new Error("Invalid push platform configuration.");
  const result = {};
  for (const platform of ["ios", "android"]) {
    const item = value[platform];
    if (item === void 0) continue;
    if (!object8(item) || Object.keys(item).some(
      (key) => !["transport", "providerConfigId", "projectId"].includes(key)
    ) || !opaque5(item.providerConfigId) || !["apns", "fcm", "expo"].includes(String(item.transport)) || item.transport === "apns" && platform !== "ios" || item.transport === "fcm" && platform !== "android" || item.transport === "expo" && (typeof item.projectId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      item.projectId
    )) || item.transport !== "expo" && item.projectId !== void 0)
      throw new Error(
        "Configure an approved processor and project for this platform."
      );
    result[platform] = {
      transport: item.transport,
      providerConfigId: item.providerConfigId,
      ...item.transport === "expo" ? { projectId: item.projectId } : {}
    };
  }
  return result;
}

// apps/api/src/push-token-crypto.ts
import {
  createCipheriv,
  createDecipheriv,
  createHash as createHash10,
  randomBytes as randomBytes6
} from "node:crypto";
import { readFileSync as readFileSync2 } from "node:fs";
var pushTokenDigest = (token) => createHash10("sha256").update("longball.push-token.v1\0").update(token).digest("hex");
function createPushTokenCipher(activeKeyId, keys2) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(activeKeyId) || !keys2.has(activeKeyId) || [...keys2.values()].some((key) => key.length !== 32))
    throw new Error("Invalid push encryption key configuration.");
  const material = new Map(
    [...keys2].map(([id9, key]) => [id9, Buffer.from(key)])
  );
  const aad = (binding2) => Buffer.from(
    JSON.stringify([
      "longball.push-token.v1",
      binding2.issuer,
      binding2.accountId,
      binding2.deviceId,
      binding2.transport,
      binding2.providerConfigId
    ])
  );
  return {
    usesActiveKey(value) {
      try {
        const record2 = JSON.parse(value);
        return record2.v === 1 && record2.keyId === activeKeyId;
      } catch {
        return false;
      }
    },
    encrypt(token, binding2) {
      const iv = randomBytes6(12), cipher = createCipheriv("aes-256-gcm", material.get(activeKeyId), iv);
      cipher.setAAD(aad(binding2));
      const ciphertext = Buffer.concat([
        cipher.update(token, "utf8"),
        cipher.final()
      ]);
      return JSON.stringify({
        v: 1,
        keyId: activeKeyId,
        iv: iv.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url")
      });
    },
    decrypt(value, binding2) {
      try {
        const record2 = JSON.parse(value);
        if (record2.v !== 1 || typeof record2.keyId !== "string" || !material.has(record2.keyId) || ![record2.iv, record2.ciphertext, record2.tag].every(
          (item) => typeof item === "string" && /^[A-Za-z0-9_-]+$/.test(item)
        ))
          throw new Error();
        const iv = Buffer.from(record2.iv, "base64url"), tag = Buffer.from(record2.tag, "base64url");
        if (iv.length !== 12 || tag.length !== 16) throw new Error();
        const decipher = createDecipheriv(
          "aes-256-gcm",
          material.get(record2.keyId),
          iv
        );
        decipher.setAAD(aad(binding2));
        decipher.setAuthTag(tag);
        return Buffer.concat([
          decipher.update(
            Buffer.from(record2.ciphertext, "base64url")
          ),
          decipher.final()
        ]).toString("utf8");
      } catch {
        throw new Error("PUSH_TOKEN_UNAVAILABLE");
      }
    }
  };
}
function pushTokenCipherFromFile(path) {
  if (!path) return void 0;
  try {
    const input = JSON.parse(readFileSync2(path, "utf8"));
    const keys2 = new Map(
      Object.entries(input.keys).map(([id9, value]) => {
        const decoded = Buffer.from(value, "base64url");
        if (decoded.length !== 32 || decoded.toString("base64url") !== value)
          throw new Error();
        return [id9, decoded];
      })
    );
    return createPushTokenCipher(input.activeKeyId, keys2);
  } catch {
    throw new Error(
      "Configure a valid mounted push encryption keyring. Key material was not logged."
    );
  }
}

// apps/api/src/push-registrations.ts
var conflict2 = () => new AccessError(
  "PUSH_REGISTRATION_CHANGED",
  409,
  "The saved push registration changed. Refresh its status before another update."
);
function pushRevision(value) {
  if (!value)
    throw new AccessError(
      "PUSH_REVISION_REQUIRED",
      428,
      "Read push status and send its quoted revision in If-Match; use zero for a new registration."
    );
  if (!/^"(?:0|[1-9]\d{0,14})"$/.test(value) || !Number.isSafeInteger(Number(value.slice(1, -1))))
    throw new AccessError(
      "INVALID_REQUEST",
      400,
      "Use the exact quoted push revision."
    );
  return Number(value.slice(1, -1));
}
function status(row) {
  return {
    deviceId: row.device_id,
    platform: row.platform,
    transport: row.transport,
    permission: row.permission,
    state: row.state,
    revision: row.revision,
    appBuild: row.app_build,
    registeredAt: row.registered_at === null ? null : new Date(row.registered_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
    lastOperationId: row.last_operation_id
  };
}
var PushRegistrationService = class {
  constructor(repository, options2, now = Date.now) {
    this.repository = repository;
    this.options = options2;
    this.now = now;
    this.platforms = parsePushPlatformPolicies(options2.pushPlatforms ?? {});
  }
  repository;
  options;
  now;
  platforms;
  get configured() {
    return Boolean(
      this.options.pushTokenCipher && Object.keys(this.platforms).length
    );
  }
  async assertEnrolled(principal, deviceId) {
    if (principal.status !== "active")
      throw new AccessError(
        "INVALID_SESSION",
        401,
        "An active signed-in account is required."
      );
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(deviceId))
      throw new AccessError(
        "INVALID_REQUEST",
        400,
        "Use the enrolled app-device identity."
      );
    const device = await this.repository.enrolled(principal, deviceId);
    if (!device)
      throw new AccessError(
        "PUSH_DEVICE_UNAVAILABLE",
        404,
        "This account's enrolled native device is unavailable."
      );
    return device;
  }
  async read(principal) {
    const rows = await this.repository.list(principal);
    if (rows.length > 1e3 || rows.some(
      (row) => row.account_id !== principal.accountId || row.issuer !== principal.issuer
    ))
      throw new Error("PUSH_ACCOUNT_SCOPE_REQUIRED");
    return {
      accountId: principal.accountId,
      registrationConfigured: this.configured,
      deliveryConfigured: this.options.pushDeliveryConfigured === true,
      platforms: this.configured ? this.platforms : {},
      devices: rows.map(status)
    };
  }
  async validateRegistration(principal, body) {
    let input;
    try {
      input = parsePushRegistrationInput(body);
    } catch {
      throw new AccessError(
        "INVALID_REQUEST",
        400,
        "Use the exact push registration fields; tokens are never authentication."
      );
    }
    const device = await this.assertEnrolled(principal, input.deviceId);
    if (device.platform !== input.platform)
      throw new AccessError(
        "PUSH_DEVICE_UNAVAILABLE",
        404,
        "This account's enrolled native device is unavailable."
      );
    const policy = this.platforms[input.platform];
    if (!this.configured || !policy)
      throw new AccessError(
        "PUSH_NOT_CONFIGURED",
        503,
        "Push registration needs an approved processor and deployment encryption key."
      );
    if (input.transport !== policy.transport)
      throw new AccessError(
        "PUSH_PROCESSOR_UNAVAILABLE",
        409,
        "This transport is not configured for this app platform."
      );
    if (input.permission === "denied")
      throw new AccessError(
        "PUSH_PERMISSION_DENIED",
        409,
        "Remove the device registration when notification permission is denied."
      );
    return { input, policy };
  }
  async register(principal, body, expectedRevision, operationId) {
    const { input, policy } = await this.validateRegistration(principal, body);
    return this.repository.transaction(async () => {
      const previous = await this.repository.current(principal, input.deviceId);
      if ((previous?.revision ?? 0) !== expectedRevision) throw conflict2();
      const digest3 = pushTokenDigest(input.token), at = this.now();
      if (previous?.state === "registered" && previous.token_digest === digest3 && previous.token_ciphertext !== null && this.options.pushTokenCipher.usesActiveKey(
        previous.token_ciphertext
      ) && previous.transport === input.transport && previous.provider_config_id === policy.providerConfigId && previous.permission === input.permission && previous.app_build === input.appBuild)
        return {
          id: input.deviceId,
          revision: previous.revision,
          serverTime: new Date(at).toISOString()
        };
      const row = {
        account_id: principal.accountId,
        issuer: principal.issuer,
        device_id: input.deviceId,
        platform: input.platform,
        transport: input.transport,
        provider_config_id: policy.providerConfigId,
        token_ciphertext: this.options.pushTokenCipher.encrypt(input.token, {
          accountId: principal.accountId,
          issuer: principal.issuer,
          deviceId: input.deviceId,
          transport: input.transport,
          providerConfigId: policy.providerConfigId
        }),
        token_digest: digest3,
        permission: input.permission,
        state: "registered",
        revision: expectedRevision + 1,
        app_build: input.appBuild,
        registered_at: previous?.registered_at ?? at,
        updated_at: at,
        revoked_at: null,
        last_operation_id: operationId
      };
      if (!await this.repository.save(principal, row, expectedRevision))
        throw conflict2();
      return {
        id: input.deviceId,
        revision: row.revision,
        serverTime: new Date(at).toISOString()
      };
    });
  }
  async revoke(principal, deviceId, expectedRevision, operationId) {
    const device = await this.assertEnrolled(principal, deviceId);
    return this.repository.transaction(async () => {
      const previous = await this.repository.current(principal, deviceId);
      if ((previous?.revision ?? 0) !== expectedRevision) throw conflict2();
      const at = this.now();
      const row = {
        account_id: principal.accountId,
        issuer: principal.issuer,
        device_id: deviceId,
        platform: device.platform,
        transport: previous?.transport ?? null,
        provider_config_id: previous?.provider_config_id ?? null,
        token_ciphertext: null,
        token_digest: null,
        permission: "denied",
        state: "revoked",
        revision: expectedRevision + 1,
        app_build: previous?.app_build ?? "",
        registered_at: previous?.registered_at ?? null,
        updated_at: at,
        revoked_at: at,
        last_operation_id: operationId
      };
      if (!await this.repository.save(principal, row, expectedRevision))
        throw conflict2();
      return {
        operationId,
        status: "completed",
        serverTime: new Date(at).toISOString()
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
function staffCommand(body, kind2, key) {
  const wrapped = Object.hasOwn(body, "command");
  if (wrapped && Object.keys(body).some((field) => field !== "command")) throw new AccessError("INVALID_REQUEST", 400, "Only the captured staff command is accepted.");
  const value = wrapped ? body.command : body;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AccessError("INVALID_REQUEST", 400, "A staff command is required.");
  const input = value;
  const fields8 = wrapped ? ["id", "type", "expectedRevision", "accountId", ...kind2 === "manager.revoked" ? ["reason", "confirmRevocation"] : []] : ["accountId", ...kind2 === "manager.revoked" ? ["reason", "confirmRevocation"] : []];
  if (Object.keys(input).some((field) => !fields8.includes(field)) || wrapped && (input.id !== key || input.type !== kind2) || typeof input.accountId !== "string" || wrapped && input.expectedRevision !== void 0 && (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0)) throw new AccessError("INVALID_REQUEST", 400, "Use an exact staff command and its matching idempotency key.");
  return { accountId: input.accountId, reason: input.reason, confirmRevocation: input.confirmRevocation, expectedRevision: input.expectedRevision, commandId: wrapped ? input.id : key };
}
function createBrandMedia(options2, store, repository) {
  return new BrandMediaService({ repository, directory: options2.mediaDirectory ?? join3(dirname2(options2.databasePath), "media"), scanner: options2.mediaScanner, now: options2.now, load: async (session) => {
    const fresh = await store.principal({ issuer: session.principal.issuer, subject: session.principal.subject, strongAuth: session.principal.strongAuth, authenticatedAt: session.principal.authenticatedAt });
    return store.brandingContext(fresh, session.teamId, session.seasonId, session.role);
  }, audit: (principal, action, objectId, outcome) => store.audit(principal, action, objectId, outcome) });
}
function createApi(options2) {
  if ((options2.activationProvider || options2.activationPolicy) && !options2.syntheticAuth) throw new Error("The fictional activation experiment requires isolated synthetic authentication.");
  const now = options2.now ?? Date.now;
  const source2 = new DevelopmentStore(options2.databasePath, now);
  if (options2.syntheticAuth) source2.seedSynthetic();
  const runtime = sqliteRuntimeStore(source2);
  const media = new DevelopmentMediaService({ directory: options2.mediaDirectory ?? join3(dirname2(options2.databasePath), "media"), database: source2.database, scanner: options2.mediaScanner, now });
  const activation = new DevelopmentActivationService({ store: source2, provider: options2.activationProvider, policy: options2.activationPolicy });
  const branding = createBrandMedia(options2, runtime.store, new SqliteBrandRepository(source2.database, runtime.store.transaction));
  const repository = new SqliteInvitationRepository(source2, runtime.store);
  const ready = runtime.serialize(() => repository.initialize());
  void ready.catch(() => void 0);
  const invitations = new SpectatorInvitationService({ ...options2, repository, now });
  const privileges = new TeamPrivilegeService(new SqliteTeamPrivilegeRepository(source2, runtime.store), now);
  const push = new PushRegistrationService(new SqlitePushRepository(source2.database, runtime.store.transaction), options2, now);
  return createRuntimeApi(options2, source2, runtime.store, media, activation, (work) => ready.then(() => runtime.serialize(work)), { branding, invitations, privileges, push });
}
function createRuntimeApi(options2, source2, store, media, activation, serialize = (work) => work(), services = {}) {
  const now = options2.now ?? Date.now;
  const privilegeService = () => {
    if (!services.privileges) throw new AccessError("TEAM_PRIVILEGES_UNAVAILABLE", 503, "Current team privileges are unavailable.");
    return services.privileges;
  };
  const verifyIdentity = options2.verifyIdentity ?? (options2.oidc ? createOidcVerifier({ ...options2.oidc, now }) : null);
  const windows = /* @__PURE__ */ new Map();
  const staticRoot = options2.staticDirectory ? realpathSync(options2.staticDirectory) : null;
  const configuredConnect = [...options2.oidc ? [options2.oidc.issuer, options2.oidc.jwksUri] : [], ...options2.browserConnectOrigins ?? []].map((value) => {
    const url = new URL(value);
    if (url.protocol !== "https:")
      throw new Error("Additional browser connect origins must use explicitly configured HTTPS.");
    return url.origin;
  });
  const connectPolicy = [...new Set(configuredConnect)].join(" ");
  const response = (reply, status2, value, requestId) => {
    reply.writeHead(status2, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Request-Id": requestId });
    reply.end(JSON.stringify(value));
  };
  const server = createServer((request, reply) => {
    void serialize(async () => {
      const rawRequestId = header(request, "x-request-id");
      const requestId = rawRequestId && /^[a-zA-Z0-9_-]{1,100}$/.test(rawRequestId) ? rawRequestId : randomUUID7();
      try {
        const origin = header(request, "origin");
        if (origin) {
          let sameOrigin = false;
          try {
            const parsed = new URL(origin);
            sameOrigin = staticRoot !== null && ["http:", "https:"].includes(parsed.protocol) && parsed.host === header(request, "host");
          } catch {
          }
          if (!sameOrigin && !(options2.allowedOrigins ?? ["http://localhost:8081", "http://localhost:4173", "http://127.0.0.1:4173"]).includes(origin))
            throw new AccessError("ORIGIN_DENIED", 403, "This origin is not configured for API access.");
          reply.setHeader("Access-Control-Allow-Origin", origin);
          reply.setHeader("Vary", "Origin");
          reply.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key, X-Controller-Token, X-Media-Upload-Token, X-Longball-Role, X-Api-Contract-Version, If-Match, X-Request-Id");
          reply.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
        }
        if (request.method === "OPTIONS") {
          reply.writeHead(204);
          reply.end();
          return;
        }
        const url = new URL(request.url ?? "/", "http://localhost");
        const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
        if (url.pathname === "/health") {
          response(reply, 200, { status: "ok", service: "longball-api", contractVersion: EVENT_CONTRACT_VERSION, backend: source2 instanceof DevelopmentStore ? "fictional-sqlite" : "postgresql", syntheticOnly: Boolean(options2.syntheticAuth) }, requestId);
          return;
        }
        if (staticRoot && parts[0] !== "v1" && ["GET", "HEAD"].includes(request.method ?? "")) {
          if (parts.some((part) => part.startsWith(".") || part.includes("/") || part.includes("\\")))
            throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
          const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".ttf": "font/ttf", ".woff": "font/woff", ".woff2": "font/woff2" };
          const path = join3(staticRoot, ...parts.length ? parts : ["index.html"]);
          let resolved;
          try {
            resolved = realpathSync(path);
          } catch {
            throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
          }
          if (!resolved.startsWith(`${staticRoot}${sep3}`) || !statSync(resolved).isFile() || !contentTypes[extname(resolved)])
            throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
          reply.writeHead(200, { "Content-Type": contentTypes[extname(resolved)], "Cache-Control": extname(resolved) === ".html" ? "no-store" : "public, max-age=300", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ${connectPolicy}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`, "X-Request-Id": requestId });
          reply.end(request.method === "HEAD" ? void 0 : readFileSync3(resolved));
          return;
        }
        if (options2.syntheticAuth && !loopback(request.socket.remoteAddress))
          throw new AccessError("SYNTHETIC_LOCAL_ONLY", 403, "Synthetic authentication is restricted to loopback clients.");
        const requireContract = () => {
          if (header(request, "x-api-contract-version") !== EVENT_CONTRACT_VERSION)
            throw new AccessError("CONTRACT_VERSION_REQUIRED", 409, `Use X-Api-Contract-Version: ${EVENT_CONTRACT_VERSION}.`);
          const key = header(request, "idempotency-key");
          if (!key || !/^[A-Za-z0-9_-]{8,150}$/.test(key))
            throw new AccessError("IDEMPOTENCY_KEY_REQUIRED", 400, "Use a stable Idempotency-Key for mutations.");
          return key;
        };
        const activationFields = (value, names) => {
          if (Object.keys(value).some((key) => !names.includes(key)) || names.some((key) => !(key in value)))
            throw new AccessError("INVALID_REQUEST", 400, "Use the documented activation request fields.");
        };
        if (request.method === "POST" && ["/v1/activation/redeem", "/v1/activation/complete", "/v1/spectator-invites/activation-info", "/v1/spectator-invites/activate"].includes(url.pathname)) {
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
          let result;
          if (url.pathname.startsWith("/v1/spectator-invites/")) {
            if (!services.spectator) throw new AccessError("ACTIVATION_NOT_CONFIGURED", 503, "Invitation activation requires a configured PostgreSQL provider boundary.");
            if (url.pathname.endsWith("/activation-info")) {
              activationFields(input, ["token"]);
              result = await services.spectator.preflight({ token: input.token });
            } else {
              activationFields(input, ["token", "deviceId", "policyVersion"]);
              result = await services.spectator.activate({ token: input.token, deviceId: input.deviceId, policyVersion: input.policyVersion, requestId: key });
            }
          } else if (url.pathname === "/v1/activation/redeem") {
            activationFields(input, ["token"]);
            result = await await activation.redeemActivation({ token: input.token, requestId: key });
          } else {
            activationFields(input, ["activationId", "token", "completionProof"]);
            if (typeof input.activationId !== "string" || typeof input.token !== "string" || typeof input.completionProof !== "string") throw new AccessError("INVALID_REQUEST", 400, "Use the original activation capability, identity and provider proof.");
            if (!activation.configured && !services.spectator?.configured) throw new AccessError("ACTIVATION_NOT_CONFIGURED", 503, "Configure a provider and explicit activation policy before completion.");
            const child = await activation.ownsActivationToken(input.token, input.activationId);
            const spectator = services.spectator ? await services.spectator.ownsActivationToken(input.token, input.activationId) : false;
            if (child === spectator) throw new AccessError("ACTIVATION_UNAVAILABLE", 410, "This activation is unavailable. No session or membership was created.");
            const completion = { activationId: input.activationId, token: input.token, completionProof: input.completionProof };
            result = child ? await activation.completeActivation(completion) : await services.spectator.completeActivation(completion);
          }
          response(reply, 200, result, requestId);
          return;
        }
        if (!options2.syntheticAuth && !verifyIdentity)
          throw new AccessError("IDENTITY_NOT_CONFIGURED", 503, "Configure the trusted OIDC issuer, audience and JWKS verifier before accepting requests.");
        const authorization = header(request, "authorization");
        if (!authorization?.startsWith("Bearer ") || authorization.length > 17e3)
          throw new AccessError("INVALID_SESSION", 401, "A valid authenticated session is required.");
        const token = authorization.slice(7);
        const identity = options2.syntheticAuth ? syntheticIdentity(token, now()) : await verifyIdentity(token);
        let principal = await store.withIdentityContext(identity, () => store.principal(identity));
        const rate = windows.get(principal.accountId);
        const count = rate && now() - rate.begins < 6e4 ? rate : { begins: now(), ordinary: 0, mutation: 0 };
        count.ordinary += 1;
        if (request.method !== "GET")
          count.mutation += 1;
        windows.set(principal.accountId, count);
        if (count.ordinary > 120 || count.mutation > 60) {
          reply.setHeader("Retry-After", "60");
          throw new AccessError("RATE_LIMIT", 429, "Please retry after the current request window.");
        }
        const role = header(request, "x-longball-role");
        const controllerToken = header(request, "x-controller-token");
        const body = request.method === "POST" ? await readJson(request) : null;
        if (request.method === "POST" && parts[1] === "spectator-invites" && ["inspect", "accept"].includes(parts[2]) && parts.length === 3) {
          const invitations = services.invitations;
          if (!invitations) throw new AccessError("INVITATION_NOT_CONFIGURED", 503, "Invitation processing is unavailable.");
          if (header(request, "x-api-contract-version") !== EVENT_CONTRACT_VERSION) throw new AccessError("CONTRACT_VERSION_REQUIRED", 409, `Use X-Api-Contract-Version: ${EVENT_CONTRACT_VERSION}.`);
          const key = parts[2] === "accept" ? requireContract() : void 0;
          const { token: token2 } = parseInvitationAccept(body);
          const tokenHash = invitationVerifier(token2);
          const resolved = await store.withActorContext(principal, { operation: "invite.resolve", requestedRole: "default", invitationTokenHash: tokenHash }, () => invitations.resolve(principal, body));
          if (parts[2] === "inspect") {
            const { invitationId, teamId, seasonId: seasonId2, expiresAt } = resolved;
            response(reply, 200, { invitationId, teamId, seasonId: seasonId2, expiresAt }, requestId);
            return;
          }
          const accepted2 = await store.withActorContext(principal, { operation: "invite.accept", requestedRole: "default", teamId: resolved.teamId, seasonId: resolved.seasonId, invitationTokenHash: tokenHash }, () => invitations.accept({ principal, teamId: resolved.teamId, seasonId: resolved.seasonId }, key, body));
          response(reply, accepted2.status, accepted2.body, requestId);
          return;
        }
        const invitationWrite = request.method === "POST" && parts[1] === "teams" && parts[3] === "spectator-invites";
        const bodySeason = invitationWrite ? body?.seasonId : void 0;
        if (invitationWrite && (typeof bodySeason !== "string" || url.searchParams.has("seasonId") && url.searchParams.get("seasonId") !== bodySeason)) throw new AccessError("INVALID_REQUEST", 400, "Use the invitation body season without a contradictory query scope.");
        const seasonId = (typeof bodySeason === "string" ? bodySeason : url.searchParams.get("seasonId")) ?? (options2.syntheticAuth ? SYNTHETIC_IDS.seasonId : "");
        if (parts[1] === "teams" && !seasonId) throw new AccessError("SEASON_REQUIRED", 400, "Choose an explicit current team-season scope.");
        const scopedOperation = (operation) => parts[1] === "teams" ? JSON.stringify([operation, parts[2], seasonId, role ?? "default"]) : operation;
        await store.withActorContext(principal, requestDatabaseScope({ method: request.method ?? "GET", parts, seasonId, role, body }), async () => {
          if (body && parts[1] === "teams" && parts[3] === "community") {
            if (body.command && typeof body.command === "object" && "type" in body.command && typeof body.command.type === "string" && body.command.type.startsWith("invite.")) throw new AccessError("CANONICAL_INVITATION_REQUIRED", 409, "Use the server-issued invitation endpoints; client credentials and JSON-only revocation are unavailable.");
            if (body.command && typeof body.command === "object" && "type" in body.command && body.command.type === "match.registered")
              throw new AccessError("POLICY_APPROVAL_REQUIRED", 503, "Connected award/sharing context requires accepted match evidence, verified finish-time anchors and independently approved policy.");
            body.command = parseCommunityCommand(body.command);
          }
          const mutate = async (operation, work, beforeReplay, signaturePayload = body) => store.transaction(async () => {
            requireContract();
            const fresh = await store.principal(identity);
            if (fresh.accountId !== principal.accountId) throw new AccessError("INVALID_SESSION", 401, "The account binding changed. Sign in again.");
            principal = fresh;
            await beforeReplay?.();
            if (url.pathname === "/v1/privacy/requests") prepareAccountPrivacyRequest({ principal, memberships: await store.memberships(), input: body, nowMs: now() });
            if (parts[1] === "matches" && parts[2])
              await store.managerMatch(principal, parts[2]);
            if (parts[1] === "teams" && parts[2]) {
              if (parts[3] === "community")
                await store.communityActor(principal, parts[2], seasonId, role, body.command?.type === "invite.accepted");
              else if (parts[3] === "preparation" && parts[4] === "own")
                assertTeamRole(principal, await store.memberships(), parts[2], seasonId, ["player"], now());
              else if (parts[3] === "configuration") {
                const club = body.command?.type === "club.updated";
                assertTeamRole(principal, await store.memberships(), parts[2], seasonId, club ? ["administrator"] : ["administrator", "manager"], now());
                assertAdultAuthority(principal, club, now());
              } else if (parts[3] === "branding") {
                const context = await store.brandingContext(principal, parts[2], seasonId, role);
                assertBrandAuthority(context.context, body.command.kind);
              } else if (parts[3] === "managers" || parts[3] === "seasons" || parts[3] === "preparation" && body.command?.type === "club.updated") {
                if (parts[3] === "managers" && role && role !== "administrator") throw new AccessError("NOT_FOUND", 404, "Choose the current administrator context to manage staff.");
                assertTeamRole(principal, await store.memberships(), parts[2], seasonId, ["administrator"], now());
                assertAdultAuthority(principal, true, now());
              } else
                assertCanManageTeam(principal, await store.memberships(), parts[2], seasonId, now());
            }
            return await store.idempotent(principal, scopedOperation(operation), header(request, "idempotency-key") ?? "", signaturePayload, work);
          });
          let result;
          if (request.method === "GET" && url.pathname === "/v1/me")
            result = { accountId: principal.accountId, identityClassification: principal.identityClassification, principal, memberships: await store.myMemberships(principal), serverTime: new Date(now()).toISOString(), syntheticOnly: Boolean(options2.syntheticAuth) };
          else if (request.method === "GET" && url.pathname === "/v1/contracts/events")
            result = events_v1_1_schema_default;
          else if (request.method === "GET" && url.pathname === "/v1/identity/devices") result = await store.recognisedDevices(principal);
          else if (request.method === "POST" && url.pathname === "/v1/identity/devices") result = await mutate(url.pathname, () => store.enrolDevice(principal, body));
          else if (parts[1] === "me" && parts[2] === "push-registrations" && services.push) {
            const push = services.push;
            if (request.method === "GET" && parts.length === 3) result = await push.read(principal);
            else if (request.method === "POST" && parts.length === 3) {
              const revision = pushRevision(header(request, "if-match")), key = requireContract();
              result = await mutate(url.pathname, async () => {
                const receipt = await push.register(principal, body, revision, key);
                await store.audit(principal, "push.register", receipt.id, "registered");
                return receipt;
              }, () => push.validateRegistration(principal, body), { body, revision });
            } else if (request.method === "DELETE" && parts.length === 4) {
              const deviceId = parts[3], revision = pushRevision(header(request, "if-match")), key = requireContract();
              const receipt = await mutate(url.pathname, async () => {
                const value = await push.revoke(principal, deviceId, revision, key);
                await store.audit(principal, "push.revoke", deviceId, "revoked");
                return value;
              }, () => push.assertEnrolled(principal, deviceId), { deviceId, revision });
              response(reply, 202, receipt, requestId);
              return;
            } else throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
          } else if (request.method === "GET" && url.pathname === "/v1/privacy/requests")
            result = await store.privacyRequests(principal);
          else if (request.method === "POST" && url.pathname === "/v1/privacy/requests")
            result = await mutate(url.pathname, () => store.privacyRequest(principal, body));
          else if (request.method === "POST" && ["/v1/accounts/link-requests", "/v1/accounts/recovery-requests"].includes(url.pathname)) {
            const key = requireContract();
            if (url.pathname === "/v1/accounts/link-requests") {
              activationFields(body, ["teamId", "seasonId", "playerId", "existingAccountId"]);
              result = await activation.requestExistingAccountLink(principal, { ...body, requestId: key });
            } else {
              activationFields(body, ["teamId", "seasonId", "accountId"]);
              result = await activation.requestRecovery(principal, { ...body, requestId: key });
            }
          } else if (parts[0] === "v1" && parts[1] === "matches" && parts[2]) {
            const matchId = parts[2];
            if (request.method === "GET" && parts.length === 3)
              result = await store.matchDto(principal, matchId, role);
            else if (request.method === "GET" && parts.length === 4 && (parts[3] === "download" || parts[3] === "offline-bundle")) {
              if (url.searchParams.getAll("deviceId").length !== 1 || Array.from(url.searchParams.keys()).some((key) => key !== "deviceId")) throw new AccessError("INVALID_REQUEST", 400, "Use one explicit deviceId for this snapshot.");
              if (parts[3] === "offline-bundle" && !controllerToken) throw new AccessError("CONTROLLER_REQUIRED", 409, "Acquire the current controller capability before downloading its offline bundle.");
              result = await store.download(principal, matchId, url.searchParams.get("deviceId") ?? "", Boolean(options2.syntheticAuth), parts[3] === "offline-bundle" ? controllerToken : void 0);
            } else if (request.method === "GET" && parts[3] === "quarantine")
              result = { items: await store.quarantine(principal, matchId) };
            else if (request.method === "GET" && parts[3] === "reconciliation") result = await store.reconciliation(principal, matchId);
            else if (request.method === "POST" && parts[3] === "reconciliation" && parts[4] === "proposals") result = await mutate(url.pathname, () => store.proposeReconciliation(principal, matchId, body));
            else if (request.method === "POST" && parts[3] === "reconciliation" && parts[4] === "apply") result = await mutate(url.pathname, () => {
              throw new AccessError("Q08_AUTHORITY_UNAPPROVED", 503, Q08_RECONCILIATION_POLICY.decisionRequired);
            });
            else if (request.method === "GET" && parts[3] === "clock" && parts[4] === "policy") {
              await store.managerMatch(principal, matchId);
              result = { status: options2.clockPolicy ? "configured_trial" : "policy_required", policy: options2.clockPolicy ?? null };
            } else if (request.method === "POST" && parts[3] === "clock" && parts[4] === "challenges" && !parts[5]) result = await mutate(url.pathname, () => store.issueClockChallenge(principal, matchId, controllerToken, body, options2.clockPolicy));
            else if (request.method === "POST" && parts[3] === "clock" && parts[4] === "challenges" && parts[5] && parts[6] === "acknowledge") result = await mutate(url.pathname, () => store.acknowledgeClockChallenge(principal, matchId, controllerToken, parts[5], body, options2.clockPolicy));
            else if (request.method === "POST" && parts[3] === "controller")
              result = await mutate(url.pathname, async () => await store.acquire(principal, matchId, String(body.deviceId ?? "")));
            else if (request.method === "POST" && parts[3] === "events")
              result = await mutate(url.pathname, async () => {
                const uploaded = await store.upload(principal, matchId, controllerToken, body.events);
                const communityContext = await store.recordFinishedContext(principal, matchId, options2.clockPolicy);
                return { ...uploaded, communityContext };
              });
            else if (request.method === "POST" && parts[3] === "handover" && !parts[4])
              result = await mutate(url.pathname, async () => await store.offerHandover(principal, matchId, controllerToken, String(body.toAccountId ?? ""), String(body.toDeviceId ?? ""), Number(body.baseRevision)));
            else if (request.method === "POST" && parts[3] === "handover" && parts[4] && parts[5] === "accept")
              result = await mutate(url.pathname, async () => await store.acceptHandover(principal, matchId, parts[4], String(body.deviceId ?? "")));
            else if (request.method === "POST" && parts[3] === "recover")
              result = await mutate(url.pathname, async () => {
                if (body.confirmUnsynchronisedRisk !== true)
                  throw new AccessError("RECOVERY_CONFIRMATION_REQUIRED", 422, "Confirm the possibility of unsynchronised old-device records before recovery.");
                const recovered = await store.recover(principal, matchId, String(body.deviceId ?? ""), String(body.reason ?? ""));
                await store.recordFinishedContext(principal, matchId, options2.clockPolicy);
                return recovered;
              });
            else
              throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
          } else if (parts[0] === "v1" && parts[1] === "teams" && parts[2]) {
            const teamId = parts[2];
            if (parts[3] === "privileges") {
              const session = { principal, teamId, seasonId, role };
              if (request.method === "GET" && parts.length === 4) result = await privilegeService().view(session);
              else if (request.method === "GET" && parts[4] === "own" && parts.length === 5) result = await privilegeService().own(session);
              else if (request.method === "POST" && parts.length === 4) {
                if (Object.keys(body).length !== 1 || !Object.hasOwn(body, "command")) throw new AccessError("INVALID_REQUEST", 400, "Use only the captured team privilege command.");
                const command = parseTeamPrivilegeCommand(body.command);
                if (command.id !== requireContract()) throw new AccessError("INVALID_REQUEST", 400, "Use the captured command identity.");
                result = await mutate(url.pathname, () => privilegeService().command(session, command));
              } else throw new AccessError("NOT_FOUND", 404, "The requested team operation is unavailable.");
            } else if (parts[3] === "spectator-invites") {
              const invitations = services.invitations;
              if (!invitations) throw new AccessError("INVITATION_NOT_CONFIGURED", 503, "Invitation processing is unavailable.");
              const session = { principal, teamId, seasonId, role };
              if (request.method === "GET" && parts.length === 4) result = await invitations.list(session);
              else if (request.method === "POST" && parts.length === 4) {
                const receipt = await invitations.issue(session, requireContract(), body);
                response(reply, receipt.status, receipt.body, requestId);
                return;
              } else if (request.method === "POST" && parts.length === 6 && parts[5] === "reissue") {
                const receipt = await invitations.issue(session, requireContract(), body, parts[4]);
                response(reply, receipt.status, receipt.body, requestId);
                return;
              } else if (request.method === "DELETE" && parts.length === 5) {
                const receipt = await invitations.revoke(session, requireContract(), parts[4]);
                response(reply, receipt.status, receipt.body, requestId);
                return;
              } else throw new AccessError("NOT_FOUND", 404, "The requested invitation is unavailable.");
            } else if (parts[3] === "branding") {
              const branding = services.branding;
              if (!branding) throw new AccessError("BRANDING_NOT_CONFIGURED", 503, "Supplied logo processing is unavailable.");
              const session = { principal, teamId, seasonId, role };
              if (request.method === "GET" && parts.length === 4) result = await branding.get(session);
              else if (request.method === "GET" && parts[4] === "assets" && parts[5] && parts[6] === "revisions" && parts[7] && parts[8] && parts.length === 9) {
                const mode = url.searchParams.get("mode") ?? "published";
                if (!["own", "published"].includes(mode) || !["display", "thumbnail"].includes(parts[8])) throw new AccessError("NOT_FOUND", 404, "The requested branding is unavailable.");
                const image = await branding.gateway(session, parts[5], Number(parts[7]), parts[8], mode);
                reply.writeHead(200, { ...image.headers, "X-Request-Id": requestId });
                reply.end(image.body);
                return;
              } else {
                if (!role || !["administrator", "manager"].includes(role)) throw new AccessError("NOT_FOUND", 404, "Choose the current logo administrator or manager context.");
                if (request.method === "PUT" && parts[4] === "uploads" && parts[5] && parts.length === 6) {
                  requireContract();
                  result = await branding.upload(session, parts[5], header(request, "x-media-upload-token") ?? "", request);
                } else if (request.method === "POST" && parts[4] === "uploads" && parts[5] && parts[6] === "complete" && parts.length === 7) {
                  requireContract();
                  if (Object.keys(body).length) throw new AccessError("INVALID_REQUEST", 400, "Logo completion accepts no reported processing evidence.");
                  result = await branding.complete(session, parts[5], header(request, "x-media-upload-token") ?? "");
                } else if (request.method === "POST" && ["club_logo", "team_logo"].includes(parts[4]) && parts[5] === "uploads" && parts[6] === "prepare" && parts.length === 7) {
                  const key = requireContract();
                  if (body.kind !== parts[4]) throw new AccessError("INVALID_BRANDING", 422, "Use the matching logo kind.");
                  result = await branding.prepare(session, key, body);
                } else if (request.method === "POST" && ["club_logo", "team_logo"].includes(parts[4]) && ["publish", "remove"].includes(parts[5]) && parts.length === 6) {
                  if (Object.keys(body).length !== 1 || !Object.hasOwn(body, "command")) throw new AccessError("INVALID_REQUEST", 400, "Use only the captured logo command.");
                  const command = parseBrandingCommand(body.command, parts[4]);
                  if (command.id !== requireContract() || command.type !== (parts[5] === "publish" ? "logo.published" : "logo.removed")) throw new AccessError("INVALID_REQUEST", 400, "Use the exact logo command and matching request identity.");
                  result = await mutate(url.pathname, () => branding.command({ ...session, principal }, command));
                } else throw new AccessError("NOT_FOUND", 404, "The requested branding is unavailable.");
              }
            } else if (request.method === "POST" && parts[3] === "activation" && parts.length === 5 && ["pending-child", "issue"].includes(parts[4])) {
              const requestId2 = requireContract();
              assertCanManageTeam(principal, await store.memberships(), teamId, seasonId, now());
              if (parts[4] === "pending-child") {
                activationFields(body, ["playerId"]);
                result = await await activation.createPendingChild(principal, { requestId: requestId2, teamId, seasonId, playerId: body.playerId });
              } else {
                activationFields(body, ["accountId"]);
                result = await await activation.issueActivation(principal, { requestId: requestId2, teamId, seasonId, accountId: body.accountId });
              }
            } else if (parts[3] === "media") {
              const actor = await store.communityActor(principal, teamId, seasonId, role);
              const privilegeSession = { principal, teamId, seasonId, role };
              if (request.method !== "GET") await privilegeService().assertAllowed(privilegeSession, "uploads");
              const community = async () => await store.communityState(teamId, seasonId);
              if (request.method === "GET" && parts[4] === "uploads" && !parts[5])
                result = { items: await media.listOwn(await community(), actor) };
              else if (request.method === "POST" && parts[4] === "uploads" && parts[5] === "prepare") {
                const key = requireContract();
                result = await store.transaction(async () => {
                  await privilegeService().assertAllowed(privilegeSession, "uploads", true);
                  return media.prepare(await community(), actor, { ...body, requestId: key });
                });
              } else if (request.method === "PUT" && parts[4] === "uploads" && parts[5]) {
                requireContract();
                result = await await media.upload(await community(), actor, parts[5], header(request, "x-media-upload-token") ?? "", request);
                await privilegeService().assertAllowed(privilegeSession, "uploads");
              } else if (request.method === "POST" && parts[4] === "uploads" && parts[5] && parts[6] === "complete") {
                const key = requireContract();
                if (Object.keys(body).length) throw new AccessError("INVALID_REQUEST", 400, "Media completion accepts no caller-reported processing evidence.");
                const processed = await await media.complete(await community(), actor, parts[5], header(request, "x-media-upload-token") ?? "");
                result = await store.idempotent(principal, scopedOperation(url.pathname), key, body, async () => {
                  const freshActor = await store.communityActor(principal, teamId, seasonId, role);
                  await privilegeService().assertAllowed(privilegeSession, "uploads", true);
                  const next = applyCommunityCommand(await community(), freshActor, processed.command, now());
                  await store.saveDocument(teamId, seasonId, "community", next);
                  await media.link(parts[5], next);
                  await store.audit(principal, "media.processed", processed.receipt.photoId, "private_review_required");
                  return processed.receipt;
                });
              } else if (request.method === "GET" && parts[4] === "photos" && parts[5] && parts[6]) {
                const mode = url.searchParams.get("mode") ?? "gallery";
                if (!["gallery", "own", "review"].includes(mode) || !["display", "thumbnail"].includes(parts[6]))
                  throw new AccessError("NOT_FOUND", 404, "The requested image is unavailable.");
                const rawRevision = url.searchParams.get("revision");
                const revision = rawRevision === null ? void 0 : Number(rawRevision);
                if (revision !== void 0 && (!Number.isSafeInteger(revision) || revision < 1))
                  throw new AccessError("NOT_FOUND", 404, "The requested image is unavailable.");
                const image = await media.gateway(await community(), actor, parts[5], parts[6], mode, revision);
                reply.writeHead(200, { ...image.headers, "X-Request-Id": requestId });
                reply.end(image.body);
                return;
              } else
                throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
            } else if (request.method === "GET" && parts[3] === "matches" && !parts[4])
              result = await store.teamMatches(principal, teamId, seasonId, role, parseMatchPageQuery(url.searchParams));
            else if (request.method === "GET" && parts[3] === "managers" && !parts[4]) result = await store.managers(principal, teamId, seasonId, role);
            else if (request.method === "POST" && parts[3] === "managers" && parts[4] === "revoke") result = await mutate(url.pathname, async () => {
              const input = staffCommand(body, "manager.revoked", header(request, "idempotency-key") ?? "");
              return { kind: "staff-command-receipt", commandId: input.commandId, ...await store.revokeManager(principal, teamId, seasonId, { accountId: input.accountId, reason: input.reason, confirmRevocation: input.confirmRevocation }, input.expectedRevision) };
            });
            else if (request.method === "POST" && parts[3] === "managers" && !parts[4])
              result = await mutate(url.pathname, async () => {
                const input = staffCommand(body, "manager.assigned", header(request, "idempotency-key") ?? "");
                return { kind: "staff-command-receipt", commandId: input.commandId, ...await store.assignManager(principal, teamId, seasonId, input.accountId, input.expectedRevision) };
              });
            else if (request.method === "GET" && parts[3] === "configuration") result = await store.configuration(principal, teamId, seasonId, role);
            else if (request.method === "POST" && parts[3] === "configuration") result = await mutate(url.pathname, () => store.configurationCommand(principal, teamId, seasonId, body.command, role));
            else if (request.method === "GET" && parts[3] === "seasons" && parts[4] === "rollover-options") result = await store.seasonOptions(principal, teamId, seasonId);
            else if (request.method === "POST" && parts[3] === "seasons") result = await mutate(url.pathname, () => store.createSeason(principal, teamId, seasonId, body.command));
            else if (request.method === "GET" && parts[3] === "preparation" && parts[4] === "own")
              result = await store.ownPreparation(principal, teamId, seasonId);
            else if (request.method === "POST" && parts[3] === "preparation" && parts[4] === "own")
              result = await mutate(url.pathname, async () => await store.ownPreparationCommand(principal, teamId, seasonId, body.command));
            else if (request.method === "GET" && parts[3] === "preparation")
              result = await store.preparation(principal, teamId, seasonId);
            else if (request.method === "POST" && parts[3] === "preparation")
              result = await mutate(url.pathname, async () => await store.preparationCommand(principal, teamId, seasonId, body.command));
            else if (request.method === "GET" && parts[3] === "community" && parts[4] === "media" && parts[5])
              result = await store.media(principal, teamId, seasonId, parts[5], url.searchParams.get("mode") ?? "gallery", role);
            else if (request.method === "GET" && parts[3] === "community")
              result = await store.community(principal, teamId, seasonId, role);
            else if (request.method === "POST" && parts[3] === "community") {
              await mutate(url.pathname, async () => {
                const command = body.command;
                if (["photo.submitted", "photo.revised", "photo.published"].includes(command.type)) await privilegeService().assertAllowed({ principal, teamId, seasonId, role }, "uploads", true);
                return store.communityCommand(principal, teamId, seasonId, command, role);
              });
              result = await store.community(principal, teamId, seasonId, role);
            } else if (request.method === "GET" && parts[3] === "records" && parts[4] === "export") {
              const expected = url.searchParams.get("expectedProjectionVersion");
              if (expected !== null && (!/^[0-9]+$/.test(expected) || !Number.isSafeInteger(Number(expected)))) throw new AccessError("INVALID_REQUEST", 400, "Use a valid projection version.");
              const exportRequest = { kind: url.searchParams.get("kind"), format: url.searchParams.get("format"), ...url.searchParams.has("matchId") ? { matchId: url.searchParams.get("matchId") } : {}, ...expected === null ? {} : { expectedProjectionVersion: Number(expected) }, ...url.searchParams.has("expectedPolicyFingerprint") ? { expectedPolicyFingerprint: url.searchParams.get("expectedPolicyFingerprint") } : {} };
              result = await store.recordsExport(principal, teamId, seasonId, exportRequest, role);
            } else if (request.method === "GET" && parts[3] === "records")
              result = await store.records(principal, teamId, seasonId, role);
            else if (request.method === "POST" && parts[3] === "records")
              result = await mutate(url.pathname, async () => await store.recordsCommand(principal, teamId, seasonId, body.command, role));
            else
              throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
          } else
            throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
          const pendingReview = typeof result === "object" && result !== null && "pendingReview" in result && result.pendingReview === true;
          response(reply, pendingReview ? 409 : 200, result, requestId);
        });
      } catch (error) {
        const domainCode = error && typeof error === "object" && "code" in error ? String(error.code) : null;
        const unavailable8 = domainCode !== null && (/^(08|53|57|58)/.test(domainCode) || ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND"].includes(domainCode));
        const status2 = error instanceof AccessError ? error.status : unavailable8 ? 503 : domainCode === "forbidden" ? 403 : domainCode === "expired" ? 410 : domainCode === "conflict" || domainCode === "closed" ? 409 : 422;
        const code = error instanceof AccessError ? error.code : unavailable8 ? "STORAGE_UNAVAILABLE" : domainCode && ["forbidden", "invalid", "conflict", "expired", "closed", "policy_needed"].includes(domainCode) ? domainCode.toUpperCase() : "COMMAND_REJECTED";
        const safeMessage = error instanceof AccessError ? error.message : unavailable8 ? "Storage is temporarily unavailable. Retain pending commands and retry the same request." : "The command could not be applied. Check the current saved state and request fields.";
        response(reply, status2, { code, message: safeMessage, requestId, retryable: status2 === 429 || status2 === 503 }, requestId);
      }
    });
  });
  server.requestTimeout = 65e3;
  server.headersTimeout = 1e4;
  return { server, store: source2, media, activation, branding: services.branding, spectator: services.spectator, close: async () => {
    await new Promise((resolve4, reject) => server.close((error) => error ? reject(error) : resolve4(void 0)));
    await media.close();
    await store.close();
  } };
}

// apps/api/src/postgres-team-privileges.ts
var PostgresTeamPrivilegeRepository = class {
  constructor(store) {
    this.store = store;
  }
  store;
  transaction(work) {
    return this.store.transaction(work);
  }
  actor(session) {
    return this.store.communityActor(
      session.principal,
      session.teamId,
      session.seasonId,
      session.role
    );
  }
  async state(session, lock = false) {
    const row = await this.store.one(
      `SELECT revision,state_json FROM team_privilege_states WHERE team_id=$1${lock ? " FOR UPDATE" : ""}`,
      [session.teamId]
    );
    if (!row)
      throw new AccessError(
        "TEAM_PRIVILEGES_UNAVAILABLE",
        503,
        "Current team privileges are unavailable."
      );
    const state = typeof row.state_json === "string" ? JSON.parse(row.state_json) : row.state_json;
    validateTeamPrivilegeState(state);
    if (state.teamId !== session.teamId || state.revision !== Number(row.revision))
      throw new AccessError(
        "TEAM_PRIVILEGES_RECONCILIATION_REQUIRED",
        409,
        "Retain the team privilege record for authorised reconciliation."
      );
    return state;
  }
  async targets(session) {
    const rows = await this.store.many(
      "SELECT DISTINCT m.account_id FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.team_id=$1 AND m.season_id=$2 AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>$3) AND a.status='active' ORDER BY m.account_id",
      [session.teamId, session.seasonId, this.store.now()]
    );
    const community = await this.store.communityState(
      session.teamId,
      session.seasonId
    );
    return rows.map((row) => ({
      accountId: String(row.account_id),
      label: community.accounts.find((account3) => account3.id === row.account_id)?.label ?? `Account ${row.account_id}`
    }));
  }
  async own(session, privilege, lock = false) {
    const row = await this.store.one(
      "SELECT longball.team_privilege_allowed($1,$2,$3,$4) AS allowed",
      [session.teamId, session.principal.accountId, privilege, lock]
    );
    return row?.allowed === true;
  }
  async save(session, state, decision) {
    const team = await this.store.one("SELECT club_id FROM teams WHERE id=$1", [
      session.teamId
    ]);
    const changed = await this.store.execute(
      "UPDATE team_privilege_states SET revision=$1,state_json=$2 WHERE team_id=$3 AND revision=$4",
      [
        state.revision,
        JSON.stringify(state),
        session.teamId,
        state.revision - 1
      ]
    );
    if (changed.changes !== 1)
      throw new AccessError(
        "TEAM_PRIVILEGE_REVISION_CONFLICT",
        409,
        "Team privileges changed. Refresh before confirming."
      );
    const command = decision.command;
    if (!team?.club_id)
      throw new AccessError(
        "TEAM_PRIVILEGES_UNAVAILABLE",
        503,
        "Current team privileges are unavailable."
      );
    await this.store.execute(
      "INSERT INTO team_privilege_decisions(team_id,club_id,revision,command_id,actor_id,target_account_id,privilege,suspended,reason_code,private_note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        session.teamId,
        team.club_id,
        state.revision,
        command.id,
        decision.actorId,
        command.targetAccountId,
        command.privilege,
        command.type === "privilege.suspended",
        command.reasonCode,
        command.privateNote
      ]
    );
    await this.store.audit(
      session.principal,
      command.type,
      session.teamId,
      "team_scoped_privilege_accepted"
    );
  }
};

// apps/api/src/postgres-server.ts
import { dirname as dirname3, join as join5 } from "node:path";

// apps/api/src/pg.ts
import { AsyncLocalStorage as AsyncLocalStorage2 } from "node:async_hooks";
import { Pool, types } from "pg";
import { readFile as readFile3 } from "node:fs/promises";
var contextKey = (context) => JSON.stringify(Object.entries(context).sort(([a], [b]) => a.localeCompare(b)));
function validateContext2(context) {
  if (!context || typeof context !== "object" || !Number.isSafeInteger(context.nowMs) || context.nowMs < 0) throw new Error("Invalid PostgreSQL application context.");
  const required2 = {
    identity: ["issuer", "subject"],
    actor: ["accountId", "issuer", "subject"],
    activation_token: ["tokenHash"],
    invitation_activation: ["tokenHash"],
    worker_claim: ["jobKind"],
    worker_job: ["jobId", "leaseToken", "clubId", "teamId", "seasonId"]
  };
  if (!Object.hasOwn(required2, context.kind) || required2[context.kind].some((name) => typeof context[name] !== "string" || !context[name] || context[name].length > 2048)) throw new Error("Invalid PostgreSQL application context.");
  if (context.kind === "actor" && (typeof context.strongAuth !== "boolean" || !Number.isSafeInteger(context.authenticatedAtMs) || context.authenticatedAtMs < 0 || context.requestedRole !== void 0 && !["administrator", "manager", "player", "spectator", "default"].includes(context.requestedRole))) throw new Error("Invalid PostgreSQL actor context.");
  if (["activation_token", "invitation_activation"].includes(context.kind) && "tokenHash" in context && (!/^[a-f0-9]{64}$/.test(context.tokenHash) || "completionVerified" in context && context.completionVerified !== void 0 && context.completionVerified !== true)) throw new Error("Invalid PostgreSQL activation context.");
  if (context.kind === "worker_claim" && !["award.finalise", "notification.dispatch"].includes(context.jobKind)) throw new Error("Invalid PostgreSQL job context.");
  if (context.kind === "worker_job" && !/^[a-f0-9]{64}$/.test(context.leaseToken)) throw new Error("Invalid PostgreSQL job capability.");
}
function isNarrowing(parent, child) {
  if (parent.kind === "identity" && child.kind === "actor") return parent.issuer === child.issuer && parent.subject === child.subject;
  if (parent.kind !== child.kind) return false;
  for (const [name, value] of Object.entries(parent)) {
    if (name === "nowMs") continue;
    if (child[name] !== value) return false;
  }
  return child.nowMs >= parent.nowMs;
}
var PgDatabase = class {
  pool;
  migrationMode;
  transactions = new AsyncLocalStorage2();
  applications = new AsyncLocalStorage2();
  get applicationContext() {
    const frame = this.applications.getStore();
    for (let ancestor = frame; ancestor; ancestor = ancestor.parent) if (!ancestor.active) throw new Error("PostgreSQL application context has ended.");
    return frame?.value;
  }
  async withContext(value, work) {
    validateContext2(value);
    const immutable = Object.freeze({ ...value });
    const parent = this.applicationContext;
    if (parent && !isNarrowing(parent, immutable)) throw new Error("PostgreSQL application context cannot widen an existing scope.");
    const key = contextKey(immutable);
    const transaction = this.transactions.getStore();
    if (transaction && !transaction.active) throw new Error("PostgreSQL transaction has ended.");
    if (transaction && transaction.applicationKey !== key) throw new Error("Narrow PostgreSQL application context before opening its SQL transaction.");
    const frame = { value: immutable, active: true, key, parent: this.applications.getStore() };
    try {
      return await this.applications.run(frame, work);
    } finally {
      frame.active = false;
    }
  }
  constructor(connectionString2, options2 = {}) {
    let url;
    try {
      url = new URL(connectionString2);
    } catch {
      throw new Error("A valid PostgreSQL connection URL is required.");
    }
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("A PostgreSQL connection URL is required.");
    this.migrationMode = options2.migrationMode ?? "apply";
    this.pool = new Pool({
      connectionString: connectionString2,
      max: options2.maximumConnections ?? 10,
      application_name: options2.applicationName ?? "longball-api",
      connectionTimeoutMillis: 1e4,
      idleTimeoutMillis: 3e4,
      options: "-c search_path=longball,pg_catalog -c statement_timeout=15000 -c lock_timeout=10000",
      types: { getTypeParser: (oid, format2) => {
        if (oid === 114 || oid === 3802) return (value) => value;
        if (oid === 20) return (value) => {
          const parsed = Number(value);
          if (!Number.isSafeInteger(parsed)) throw new Error("PostgreSQL integer exceeds the application range.");
          return parsed;
        };
        return types.getTypeParser(oid, format2);
      } }
    });
    this.pool.on("error", () => {
      console.error("LONGBALL_POSTGRES_IDLE_CONNECTION_ERROR");
    });
  }
  async query(sql, values = []) {
    const application = this.applicationContext;
    const transaction = this.transactions.getStore();
    if (transaction) {
      if (!transaction.active) throw new Error("PostgreSQL transaction has ended.");
      if (transaction.applicationKey !== (application ? contextKey(application) : null)) throw new Error("PostgreSQL transaction context changed.");
      return transaction.client.query(sql, [...values]);
    }
    if (!application) return this.pool.query(sql, [...values]);
    return this.inTransaction(() => this.query(sql, values), false);
  }
  async transaction(work) {
    return this.inTransaction(work, true);
  }
  async inTransaction(work, lockWrites) {
    const application = this.applicationContext;
    const applicationKey = application ? contextKey(application) : null;
    const existing = this.transactions.getStore();
    if (existing) {
      if (!existing.active) throw new Error("PostgreSQL transaction has ended.");
      if (existing.applicationKey !== applicationKey) throw new Error("PostgreSQL transaction context changed.");
      return work();
    }
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN");
      if (application) await client.query("SELECT set_config('longball.context',$1,true)", [JSON.stringify(application)]);
      if (lockWrites) await client.query("SELECT pg_advisory_xact_lock(hashtextextended('longball:domain-write:v1', 0))");
      const transaction = { client, applicationKey, active: true };
      let result;
      try {
        result = await this.transactions.run(transaction, work);
      } finally {
        transaction.active = false;
      }
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }
  async migrate() {
    if (this.migrationMode === "verify") {
      const versions = await this.query("SELECT version FROM longball.schema_migrations ORDER BY version");
      if (versions.rows.some((row) => row.version > 15)) throw new Error("This PostgreSQL schema is newer than the application. Preserve it and use a compatible build.");
      if (![2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].every((version) => versions.rows.some((row) => row.version === version))) throw new Error("PostgreSQL migrations are required. Run the separate migrator before starting the runtime.");
      const protectedTables = ["clubs", "teams", "team_seasons", "game_contexts", "accounts", "memberships", "matches", "documents", "devices", "controller_grants", "controller_history", "events", "streams", "conflicting_submissions", "transfers", "clock_challenges", "clock_mappings", "reconciliation_proposals", "audit", "idempotency", "privacy_requests", "privacy_pending_keys", "jobs", "brand_assets", "brand_slots", "spectator_invitations", "lb_spectator_activation_accounts", "lb_spectator_activation_attempts", "native_app_devices", "team_privilege_states", "team_privilege_decisions", "push_registrations"];
      const security = await this.query(`SELECT c.relname,c.relrowsecurity,(SELECT count(*)::integer FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid) AS policies FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='longball' AND c.relname=ANY($1::text[])`, [protectedTables]);
      if (security.rows.length !== protectedTables.length || security.rows.some((row) => !row.relrowsecurity || row.policies < 1)) throw new Error("PostgreSQL row security is missing. Run the separate migrator before starting runtime.");
      return;
    }
    const migration = await readFile3(new URL("../migrations/postgresql/002_runtime.sql", import.meta.url), "utf8");
    const clockReviewMigration = await readFile3(new URL("../migrations/postgresql/003_clock_review.sql", import.meta.url), "utf8");
    const accountRequestsMigration = await readFile3(new URL("../migrations/postgresql/004_account_requests.sql", import.meta.url), "utf8");
    const scopeSecurityMigration = await readFile3(new URL("../migrations/postgresql/005_scope_security.sql", import.meta.url), "utf8");
    const awardNotificationsMigration = await readFile3(new URL("../migrations/postgresql/006_award_notifications.sql", import.meta.url), "utf8");
    const workerBoundariesMigration = await readFile3(new URL("../migrations/postgresql/007_worker_boundaries.sql", import.meta.url), "utf8");
    const controllerRevocationMigration = await readFile3(new URL("../migrations/postgresql/008_controller_revocation.sql", import.meta.url), "utf8");
    const dispatchClockMigration = await readFile3(new URL("../migrations/postgresql/009_dispatch_database_clock.sql", import.meta.url), "utf8");
    const brandAssetsMigration = await readFile3(new URL("../migrations/postgresql/010_brand_assets.sql", import.meta.url), "utf8");
    const spectatorCapabilitiesMigration = await readFile3(new URL("../migrations/postgresql/011_spectator_capabilities.sql", import.meta.url), "utf8");
    const heicMigration = await readFile3(new URL("../migrations/postgresql/012_heic_support.sql", import.meta.url), "utf8");
    const teamPrivilegesMigration = await readFile3(new URL("../migrations/postgresql/013_team_privileges.sql", import.meta.url), "utf8");
    const pushRegistrationMigration = await readFile3(new URL("../migrations/postgresql/014_push_registrations.sql", import.meta.url), "utf8");
    const privilegeAuditClockMigration = await readFile3(new URL("../migrations/postgresql/015_team_privilege_audit_clock.sql", import.meta.url), "utf8");
    await this.transaction(async () => {
      const schema = await this.query("SELECT to_regnamespace('longball')::text AS namespace");
      if (!schema.rows[0]?.namespace) await this.query("CREATE SCHEMA longball");
      await this.query("CREATE TABLE IF NOT EXISTS longball.schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      const versions = await this.query("SELECT version FROM longball.schema_migrations ORDER BY version");
      if (versions.rows.some((row) => row.version > 15)) throw new Error("This PostgreSQL schema is newer than the application. Preserve it and use a compatible build.");
      if (!versions.rows.some((row) => row.version === 2)) {
        await this.query(migration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(2)");
      }
      if (!versions.rows.some((row) => row.version === 3)) {
        await this.query(clockReviewMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(3)");
      }
      if (!versions.rows.some((row) => row.version === 4)) {
        await this.query(accountRequestsMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(4)");
      }
      if (!versions.rows.some((row) => row.version === 5)) {
        await this.query(scopeSecurityMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(5)");
      }
      if (!versions.rows.some((row) => row.version === 6)) {
        await this.query(awardNotificationsMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(6)");
      }
      if (!versions.rows.some((row) => row.version === 7)) {
        await this.query(workerBoundariesMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(7)");
      }
      if (!versions.rows.some((row) => row.version === 8)) {
        await this.query(controllerRevocationMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(8)");
      }
      if (!versions.rows.some((row) => row.version === 9)) {
        await this.query(dispatchClockMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(9)");
      }
      if (!versions.rows.some((row) => row.version === 10)) {
        await this.query(brandAssetsMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(10)");
      }
      if (!versions.rows.some((row) => row.version === 11)) {
        await this.query(spectatorCapabilitiesMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(11)");
      }
      if (!versions.rows.some((row) => row.version === 12)) {
        await this.query(heicMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(12)");
      }
      if (!versions.rows.some((row) => row.version === 13)) {
        await this.query(teamPrivilegesMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(13)");
      }
      if (!versions.rows.some((row) => row.version === 14)) {
        await this.query(pushRegistrationMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(14)");
      }
      if (!versions.rows.some((row) => row.version === 15)) {
        await this.query(privilegeAuditClockMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(15)");
      }
    });
  }
  async close() {
    await this.pool.end();
  }
};

// apps/api/src/postgres-store.ts
import { createHash as createHash11, randomBytes as randomBytes7, randomUUID as randomUUID8 } from "node:crypto";
var EVENT_CONTRACT_VERSION2 = "longball.events/1.1";
var SYNTHETIC_IDS2 = { teamId: "synthetic-roma-u10", seasonId: "synthetic-season-2026-27", matchId: "synthetic-roma-maple-2026-10-24" };
function canonical5(value) {
  if (Array.isArray(value)) return `[${value.map(canonical5).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical5(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
var digest2 = (value) => createHash11("sha256").update(value).digest("hex");
var validId4 = (value) => typeof value === "string" && value.length > 0 && value.length <= 150 && /^[a-zA-Z0-9_-]+$/.test(value);
var validDeviceId2 = (value) => validId4(value) && value.length <= 120;
var nonnegative4 = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function bad2(message) {
  throw new AccessError("INVALID_REQUEST", 400, message);
}
function validateEnvelope2(value, matchId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) bad2("An event envelope is required.");
  const item = value;
  if (!validId4(item.eventId) || !validDeviceId2(item.deviceId) || item.matchId !== matchId || !nonnegative4(item.clientSequence) || item.clientSequence < 1 || !nonnegative4(item.controllerEpoch) || item.controllerEpoch < 1 || !nonnegative4(item.baseRevision)) bad2("Invalid event identity, scope or sequence.");
  if (!(item.previousEventId === null || validId4(item.previousEventId))) bad2("Invalid previous event identifier.");
  if (item.contractVersion !== EVENT_CONTRACT_VERSION2 || item.schemaVersion !== 1 || item.engineVersion !== ENGINE_VERSION) return item;
  const fields8 = ["contractVersion", "schemaVersion", "engineVersion", "eventId", "matchId", "deviceId", "controllerEpoch", "clientSequence", "previousEventId", "baseRevision", "effectiveHalf", "halfElapsedMs", "matchElapsedMs", "effectiveAt", "recordedAt", "timeQuality", "clockEvidence", "command"];
  if (Object.keys(item).some((key) => !fields8.includes(key))) bad2("Unknown event envelope fields are not accepted.");
  if (!nonnegative4(item.halfElapsedMs) || !nonnegative4(item.matchElapsedMs) || ![0, 1, 2].includes(item.effectiveHalf)) bad2("Invalid effective playing-time boundary.");
  if (!["anchored", "estimated", "reviewRequired"].includes(item.timeQuality) || !Number.isFinite(Date.parse(item.recordedAt)) || !(item.effectiveAt === null || Number.isFinite(Date.parse(item.effectiveAt)))) bad2("Invalid event time evidence.");
  const command = item.command;
  if (!command || typeof command !== "object" || command.id !== item.eventId || !command.sample || !Number.isFinite(command.sample.monotonicMs) || command.sample.monotonicMs < 0 || !validId4(command.sample.sessionId) || !nonnegative4(command.sample.wallTimeMs)) bad2("Invalid versioned match command.");
  if (!item.clockEvidence || item.clockEvidence.monotonicMs !== command.sample.monotonicMs || !validId4(item.clockEvidence.anchorId) || !(item.clockEvidence.continuityId === null || validId4(item.clockEvidence.continuityId))) bad2("Explicit clock evidence is required.");
  const commandTypes = ["attendance.recorded", "availability.changed", "lineup.staged", "half.started", "half.paused", "half.resumed", "half.ended", "lineup.committed", "goal.recorded", "clock.recovery_required", "clock.corrected", "event.corrected", "event.voided", "policy.changed", "match.abandoned"];
  if (!commandTypes.includes(command.type)) bad2("Unsupported match command.");
  if (command.type === "goal.recorded" && !["us", "opposition"].includes(command.beneficiary)) bad2("Invalid goal side.");
  if (command.type === "attendance.recorded" && (!validId4(command.playerId) || !["present", "absent", "excused", "not_selected", "not_recorded"].includes(command.status))) bad2("Invalid attendance.");
  if (command.type === "availability.changed" && (!validId4(command.playerId) || typeof command.available !== "boolean")) bad2("Invalid availability.");
  if ((command.type === "lineup.staged" || command.type === "lineup.committed") && (!Array.isArray(command.lineup) || command.lineup.length > 11 || command.lineup.some((item2) => !validId4(item2.playerId) || !validId4(item2.slotId) || typeof item2.position !== "string" || item2.position.length > 30))) bad2("Invalid lineup allocations.");
  return item;
}
var PostgresStore = class _PostgresStore {
  constructor(db, now = Date.now) {
    this.db = db;
    this.now = now;
  }
  db;
  now;
  static async open(connectionString2, now = Date.now, options2 = {}) {
    const db = new PgDatabase(connectionString2, options2);
    try {
      await db.migrate();
      return new _PostgresStore(db, now);
    } catch (error) {
      await db.close();
      throw error;
    }
  }
  async close() {
    await this.db.close();
  }
  async assertRuntimeRole(kind2) {
    const role = await this.one(`SELECT r.rolsuper,r.rolbypassrls,longball.runtime_purpose() AS runtime_purpose,
     EXISTS(SELECT 1 FROM pg_catalog.pg_roles privileged WHERE (privileged.rolsuper OR privileged.rolbypassrls) AND pg_has_role(current_user,privileged.oid,'MEMBER')) AS privileged_membership,
     (EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname='longball' AND pg_has_role(current_user,n.nspowner,'MEMBER')) OR
      EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='longball' AND c.relkind IN('r','p') AND pg_has_role(current_user,c.relowner,'MEMBER'))) AS owns_data
     FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
    if (!role || role.rolsuper || role.rolbypassrls || role.privileged_membership || role.owns_data) throw new Error(`The PostgreSQL ${kind2} requires a separate non-owner role without superuser, bypass-RLS or privileged-role membership.`);
    if (role.runtime_purpose !== kind2) throw new Error(`The PostgreSQL role is not assigned the ${kind2} runtime purpose.`);
  }
  transaction(work) {
    return this.db.transaction(work);
  }
  async withIdentityContext(identity, work) {
    return this.db.withContext({ kind: "identity", issuer: identity.issuer, subject: identity.subject, nowMs: this.now() }, work);
  }
  async withActorContext(principal, scope, work) {
    const context = { kind: "actor", accountId: principal.accountId, issuer: principal.issuer, subject: principal.subject, strongAuth: principal.strongAuth, authenticatedAtMs: principal.authenticatedAt, nowMs: this.now(), ...scope };
    return this.db.withContext(context, async () => {
      if (scope.matchId) {
        const match = await this.one("SELECT club_id,team_id,season_id FROM matches WHERE id=$1", [scope.matchId]);
        if (!match || typeof match.club_id !== "string" || typeof match.team_id !== "string" || typeof match.season_id !== "string") throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
        return this.db.withContext({ ...context, clubId: String(match.club_id), teamId: String(match.team_id), seasonId: String(match.season_id) }, work);
      }
      if (scope.teamId) {
        const team = await this.one("SELECT club_id FROM teams WHERE id=$1 AND scope_status='resolved'", [scope.teamId]);
        if (!team || typeof team.club_id !== "string") throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
        return this.db.withContext({ ...context, clubId: String(team.club_id) }, work);
      }
      return work();
    });
  }
  async one(sql, values = []) {
    return (await this.db.query(sql, values)).rows[0];
  }
  async many(sql, values = []) {
    return (await this.db.query(sql, values)).rows;
  }
  async execute(sql, values = []) {
    return { changes: (await this.db.query(sql, values)).rowCount ?? 0 };
  }
  async seedSynthetic() {
    await this.transaction(async () => {
      if (await this.one("SELECT id FROM teams LIMIT 1", []))
        return;
      await this.execute("INSERT INTO clubs(id,name) VALUES($1,$2),($3,$4)", ["synthetic-richmond-rovers", "Richmond Rovers \xB7 fictional", "synthetic-other-club", "Other fictional club"]);
      await this.execute("INSERT INTO teams(id,name,club_id,scope_status) VALUES($1,$2,$3,'resolved')", [SYNTHETIC_IDS2.teamId, "Roma U10 \xB7 fictional", "synthetic-richmond-rovers"]);
      await this.execute("INSERT INTO teams(id,name,club_id,scope_status) VALUES($1,$2,$3,'resolved')", ["synthetic-other-team", "Other fictional team", "synthetic-other-club"]);
      await this.execute("INSERT INTO team_seasons(club_id,team_id,season_id,label,start_year,start_date,end_date) VALUES($1,$2,$3,$4,$5,$6,$7),($8,$9,$3,$4,$5,$6,$7)", ["synthetic-richmond-rovers", SYNTHETIC_IDS2.teamId, SYNTHETIC_IDS2.seasonId, "2026/27", 2026, "2026-09-01", "2027-08-31", "synthetic-other-club", "synthetic-other-team"]);
      const add2 = async (id9, classification, adult) => await this.execute("INSERT INTO accounts(id,issuer,subject,classification,adult_verified,strong_auth_enrolled) VALUES($1,$2,$3,$4,$5,$6)", [id9, "urn:longball:synthetic", id9, classification, Number(adult), Number(adult)]);
      const membership = async (id9, role, playerId = null, teamId = SYNTHETIC_IDS2.teamId) => await this.execute("INSERT INTO memberships(account_id,team_id,season_id,role,player_id) VALUES($1,$2,$3,$4,$5)", [id9, teamId, SYNTHETIC_IDS2.seasonId, role, playerId]);
      await add2("synthetic-account-admin", "adult_individual", true);
      await membership("synthetic-account-admin", "administrator");
      for (let number = 1; number <= 5; number++) {
        const id9 = number === 1 ? "synthetic-account-manager" : `synthetic-account-manager-${number}`;
        await add2(id9, "adult_individual", true);
        if (number <= 4)
          await membership(id9, "manager");
        if (number === 1)
          await membership(id9, "administrator");
      }
      for (let number = 1; number <= 13; number++) {
        const suffix = String(number).padStart(2, "0");
        const id9 = `synthetic-account-player-${suffix}`;
        await add2(id9, "child_shared", false);
        await membership(id9, "player", `synthetic-player-${suffix}`);
      }
      await add2("synthetic-account-spectator", "adult_individual", false);
      await membership("synthetic-account-spectator", "spectator");
      await add2("synthetic-account-invitee", "adult_individual", false);
      await add2("synthetic-account-other-manager", "adult_individual", true);
      await membership("synthetic-account-other-manager", "manager", null, "synthetic-other-team");
      const config = { matchId: SYNTHETIC_IDS2.matchId, players: romaFixture.players, selectedPlayerIds: romaFixture.players.filter((player) => player.available).map((player) => player.id), pitchPlaces: 7, plannedHalfDurationMs: 15e5, fixedKeeperId: romaFixture.players[0].id };
      await this.insertMatch(config, SYNTHETIC_IDS2.teamId, SYNTHETIC_IDS2.seasonId);
      const community = createCommunityState(this.now());
      community.matches = community.matches.map((match) => ({ ...match, sharing: "manager_only" }));
      for (let number = 2; number <= 4; number++) {
        const id9 = `synthetic-account-manager-${number}`;
        community.accounts.push({ id: id9, label: `Fictional manager ${number}`, classification: "adult_individual", adultVerified: true });
        community.memberships.push({ accountId: id9, teamId: SYNTHETIC_IDS2.teamId, seasonId: SYNTHETIC_IDS2.seasonId, role: "manager", active: true });
      }
      await this.saveDocument(SYNTHETIC_IDS2.teamId, SYNTHETIC_IDS2.seasonId, "preparation", createPreparationState());
      await this.saveDocument(SYNTHETIC_IDS2.teamId, SYNTHETIC_IDS2.seasonId, "community", community);
      await this.saveDocument(SYNTHETIC_IDS2.teamId, SYNTHETIC_IDS2.seasonId, "records", createRecordsSeed());
    });
  }
  async insertMatch(config, teamId, seasonId) {
    await this.execute("INSERT INTO matches(id,team_id,season_id,config_json,state_json,sharing_policy_json) VALUES($1,$2,$3,$4,$5,$6)", [config.matchId, teamId, seasonId, JSON.stringify(config), JSON.stringify(createMatch(config)), JSON.stringify(UNAPPROVED_SHARING_POLICY)]);
  }
  async principal(identity) {
    const account3 = await this.one("SELECT * FROM accounts WHERE issuer=$1 AND subject=$2", [identity.issuer, identity.subject]);
    if (!account3 || account3.status !== "active")
      throw new AccessError("ACCOUNT_UNAVAILABLE", 403, "The account is not active for this service.");
    return { accountId: account3.id, issuer: account3.issuer, subject: account3.subject, identityClassification: account3.classification, adultVerified: Boolean(account3.adult_verified), strongAuth: identity.strongAuth, authenticatedAt: identity.authenticatedAt, status: account3.status };
  }
  async memberships() {
    const rows = await this.many("SELECT m.*,CASE WHEN m.role='spectator' THEN longball.spectator_grant_active(m.account_id,m.club_id,m.team_id,m.season_id) ELSE true END AS grant_active FROM memberships m");
    return rows.map((row) => ({ accountId: row.account_id, teamId: row.team_id, seasonId: row.season_id, role: row.role, playerId: row.player_id ?? void 0, expiresAt: row.expires_at, revokedAt: row.role === "spectator" && !row.grant_active ? row.revoked_at ?? Math.max(1, this.now()) : row.revoked_at }));
  }
  async myMemberships(principal) {
    return currentMemberships(principal, await this.memberships(), this.now());
  }
  async recognisedDevices(principal) {
    const legacy = await this.many("SELECT id,account_id FROM devices WHERE account_id=$1 ORDER BY id", [principal.accountId]);
    const native = await this.many("SELECT * FROM native_app_devices WHERE account_id=$1 AND issuer=$2 ORDER BY registered_at,device_id", [principal.accountId, principal.issuer]);
    return ownDevicesDto(principal, legacy, native, this.now());
  }
  async enrolDevice(principal, input) {
    const parsed = parseNativeDeviceInput(input);
    if (await this.one("SELECT id FROM devices WHERE id=$1 AND account_id=$2", [parsed.deviceId, principal.accountId])) throw new AccessError("DEVICE_ID_CONFLICT", 409, "Use a separate installation identity for sign-in recognition.");
    const updated = await this.one("INSERT INTO native_app_devices(device_id,account_id,issuer,platform,registered_at,last_seen_at) VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT(device_id) DO UPDATE SET platform=EXCLUDED.platform,last_seen_at=GREATEST(native_app_devices.last_seen_at,EXCLUDED.last_seen_at) WHERE native_app_devices.account_id=EXCLUDED.account_id AND native_app_devices.issuer=EXCLUDED.issuer RETURNING device_id", [parsed.deviceId, principal.accountId, principal.issuer, parsed.platform, this.now()]);
    if (!updated) throw new AccessError("DEVICE_ID_CONFLICT", 409, "This installation identity is unavailable.");
    return this.recognisedDevices(principal);
  }
  async brandingContext(principal, teamId, seasonId, role) {
    const memberships = await this.memberships(), nowMs = this.now(), selectedRole = brandSelectedRole(principal, memberships, teamId, seasonId, role, nowMs);
    const names = await this.one("SELECT * FROM longball.branding_context($1,$2)", [teamId, seasonId]);
    if (!names || typeof names.club_id !== "string" || names.team_id !== teamId) throw new AccessError("NOT_FOUND", 404, "The requested branding is unavailable.");
    return { context: { principal, memberships, selectedRole, clubId: names.club_id, teamId, authoritySeasonId: seasonId, nowMs, spectatorGrantActive: selectedRole === "spectator" }, club: { id: names.club_id, name: String(names.club_name) }, team: { id: teamId, name: String(names.team_name), ageGroup: names.age_group === null ? "" : String(names.age_group) } };
  }
  async match(matchId) {
    const row = await this.one("SELECT * FROM matches WHERE id=$1", [matchId]);
    if (!row)
      throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    return row;
  }
  async managerMatch(principal, matchId) {
    const row = await this.match(matchId);
    assertCanManageTeam(principal, await this.memberships(), row.team_id, row.season_id, this.now());
    return row;
  }
  async matchDto(principal, matchId, requestedRole) {
    const row = await this.match(matchId);
    return filterMatchForPrincipal({ principal, memberships: await this.memberships(), teamId: row.team_id, seasonId: row.season_id, state: JSON.parse(row.state_json), policy: JSON.parse(row.sharing_policy_json), lastSyncAt: row.last_sync_at, now: this.now(), requestedRole });
  }
  async download(principal, matchId, deviceId, syntheticOnly = false, controllerToken) {
    return this.transaction(async () => {
      const row = await this.managerMatch(principal, matchId);
      if (!validDeviceId2(deviceId)) bad2("A device identifier of at most 120 canonical characters is required.");
      if (controllerToken !== void 0) {
        const authority = await this.assertController(principal, matchId, controllerToken);
        if (authority.device_id !== deviceId || authority.frozen) throw new AccessError("CONTROLLER_REQUIRED", 409, "Use the current unfrozen controller device and capability.");
      }
      const stream = await this.one("SELECT sequence,previous_event_id FROM streams WHERE match_id=$1 AND device_id=$2", [matchId, deviceId]);
      const controller = await this.one("SELECT epoch,account_id,device_id,frozen FROM controller_grants WHERE match_id=$1", [matchId]);
      const events = await this.many("SELECT revision,received_at,envelope_json FROM events WHERE match_id=$1 AND disposition='accepted' ORDER BY revision LIMIT 10001", [matchId]);
      const transitions = await this.many("SELECT id,epoch,actor_id,from_device,to_device,kind,reason,created_at FROM controller_history WHERE match_id=$1 ORDER BY epoch,created_at,id LIMIT 10001", [matchId]);
      const saved = await this.one("SELECT value_json FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='records'", [row.team_id, row.season_id]);
      return buildOfflineDownload({ matchId, teamId: row.team_id, seasonId: row.season_id, deviceId, state: JSON.parse(row.state_json), checkpoint: { clientSequence: stream?.sequence ?? 0, previousEventId: stream?.previous_event_id ?? null }, controller: controller ?? null, events, transitions, publication: offlinePublication(matchId, JSON.parse(row.sharing_policy_json), saved ? JSON.parse(saved.value_json) : null), nowMs: this.now(), syntheticOnly });
    });
  }
  async audit(principal, action, objectId, outcome) {
    await this.execute("INSERT INTO audit(id,actor_id,action,object_id,outcome,created_at) VALUES($1,$2,$3,$4,$5,$6)", [randomUUID8(), principal.accountId, action, objectId, outcome, this.now()]);
  }
  async idempotent(principal, operation, key, payload, work) {
    if (!validId4(key) || key.length < 8)
      bad2("A stable Idempotency-Key is required for mutations.");
    const signature2 = digest2(canonical5(payload));
    return await this.transaction(async () => {
      const prior = await this.one("SELECT signature,response_json FROM idempotency WHERE account_id=$1 AND operation=$2 AND key=$3", [principal.accountId, operation, key]);
      if (prior) {
        if (prior.signature !== signature2)
          throw new AccessError("IDEMPOTENCY_CONFLICT", 409, "The idempotency key was already used with different content.");
        return JSON.parse(prior.response_json);
      }
      const response = await work();
      await this.execute("INSERT INTO idempotency(account_id,operation,key,signature,response_json) VALUES($1,$2,$3,$4,$5)", [principal.accountId, operation, key, signature2, JSON.stringify(response)]);
      return response;
    });
  }
  async acquire(principal, matchId, deviceId) {
    await this.managerMatch(principal, matchId);
    if (!validDeviceId2(deviceId))
      bad2("A device identifier of at most 120 canonical characters is required.");
    const prior = await this.one("SELECT * FROM controller_grants WHERE match_id=$1", [matchId]);
    if (prior)
      throw new AccessError("CONTROLLER_EXISTS", 409, "This match already has a controller. Use handover or audited recovery.");
    await this.bindDevice(principal, deviceId);
    const token = randomBytes7(32).toString("base64url");
    await this.execute("INSERT INTO controller_grants(match_id,epoch,account_id,device_id,capability_hash) VALUES($1,$2,$3,$4,$5)", [matchId, 1, principal.accountId, deviceId, digest2(token)]);
    await this.audit(principal, "controller.acquired", matchId, "accepted");
    return { epoch: 1, deviceId, controllerToken: token, checkpoint: (await this.download(principal, matchId, deviceId)).deviceCheckpoint };
  }
  async assertController(principal, matchId, token) {
    await this.managerMatch(principal, matchId);
    const grant = await this.one("SELECT * FROM controller_grants WHERE match_id=$1", [matchId]);
    if (!grant || grant.account_id !== principal.accountId || !token || digest2(token) !== grant.capability_hash)
      throw new AccessError("CONTROLLER_REQUIRED", 409, "Only the selected manager and enrolled device may write this match.");
    return grant;
  }
  async issueClockChallenge(principal, matchId, token, input, policy) {
    const grant = await this.assertController(principal, matchId, token);
    if (!policy)
      throw new AccessError("CLOCK_POLICY_REQUIRED", 503, "An explicitly configured trusted-time policy is required before establishing an anchor.");
    if (!input || Object.keys(input).some((key) => !["deviceId", "controllerEpoch", "continuityId"].includes(key)) || !validDeviceId2(input.deviceId) || !validId4(input.continuityId) || input.deviceId !== grant.device_id || input.controllerEpoch !== grant.epoch || grant.frozen)
      throw new AccessError("CLOCK_SCOPE_CONFLICT", 409, "Use the current unfrozen controller device, epoch and continuous-clock identity.");
    const challenge = issueClockChallenge({ accountId: principal.accountId, deviceId: grant.device_id, matchId, controllerEpoch: grant.epoch, continuityId: input.continuityId }, randomUUID8(), this.now(), policy);
    await this.execute("INSERT INTO clock_challenges(id,match_id,account_id,challenge_json) VALUES($1,$2,$3,$4)", [challenge.id, matchId, principal.accountId, JSON.stringify(challenge)]);
    return challenge;
  }
  async acknowledgeClockChallenge(principal, matchId, token, challengeId, sample, policy) {
    const grant = await this.assertController(principal, matchId, token);
    if (!policy)
      throw new AccessError("CLOCK_POLICY_REQUIRED", 503, "An explicitly configured trusted-time policy is required before establishing an anchor.");
    if (!sample || Object.keys(sample).some((key) => !["receivedMonotonicMs", "sentMonotonicMs"].includes(key)))
      bad2("Use the documented continuous-clock receipt and send observations.");
    const row = await this.one("SELECT challenge_json,consumed_at FROM clock_challenges WHERE id=$1 AND match_id=$2 AND account_id=$3", [challengeId, matchId, principal.accountId]);
    if (!row)
      throw new AccessError("NOT_FOUND", 404, "That challenge is unavailable.");
    const challenge = JSON.parse(row.challenge_json);
    if (row.consumed_at !== null)
      throw new AccessError("CLOCK_CHALLENGE_CONSUMED", 409, "That clock exchange was consumed. Retrying the same request key returns its receipt.");
    if (challenge.controllerEpoch !== grant.epoch || challenge.deviceId !== grant.device_id || grant.frozen)
      throw new AccessError("CLOCK_SCOPE_CONFLICT", 409, "The controller changed before the clock exchange completed.");
    let mapping;
    try {
      mapping = acknowledgeClockChallenge(challenge, sample, this.now(), policy);
    } catch {
      throw new AccessError("CLOCK_EXCHANGE_REJECTED", 422, "The clock exchange expired or its evidence exceeds the configured uncertainty bounds.");
    }
    await this.execute("UPDATE clock_challenges SET consumed_at=$1 WHERE id=$2 AND consumed_at IS NULL", [this.now(), challengeId]);
    await this.execute("INSERT INTO clock_mappings(challenge_id,match_id,mapping_json,created_at) VALUES($1,$2,$3,$4)", [challengeId, matchId, JSON.stringify(mapping), this.now()]);
    await this.audit(principal, "clock.mapping_established", matchId, policy.id);
    return mapping;
  }
  async reconciliation(principal, matchId) {
    const row = await this.managerMatch(principal, matchId);
    const state = JSON.parse(row.state_json);
    const events = await this.many("SELECT event_id,device_id,client_sequence,envelope_json,reason,received_at FROM events WHERE match_id=$1 AND disposition='quarantined' ORDER BY received_at,client_sequence", [matchId]);
    const conflicts = await this.many("SELECT id,original_json,reason,created_at FROM conflicting_submissions WHERE match_id=$1 ORDER BY created_at,id", [matchId]);
    const submissions = [...events.map((event) => {
      const original = JSON.parse(event.envelope_json);
      return { submissionId: event.event_id, matchId, eventId: event.event_id, deviceId: event.device_id, clientSequence: event.client_sequence, controllerEpoch: original.controllerEpoch ?? null, reason: event.reason, original, originalDigest: digest2(canonical5(original)), receivedAt: new Date(event.received_at).toISOString() };
    }), ...conflicts.map((conflict4) => {
      const original = JSON.parse(conflict4.original_json);
      return { submissionId: conflict4.id, matchId, eventId: typeof original.eventId === "string" ? original.eventId : null, deviceId: typeof original.deviceId === "string" ? original.deviceId : null, clientSequence: typeof original.clientSequence === "number" ? original.clientSequence : null, controllerEpoch: typeof original.controllerEpoch === "number" ? original.controllerEpoch : null, reason: conflict4.reason, original, originalDigest: digest2(canonical5(original)), receivedAt: new Date(conflict4.created_at).toISOString() };
    })];
    const proposals = (await this.many("SELECT receipt_json FROM reconciliation_proposals WHERE match_id=$1 ORDER BY created_at,id", [matchId])).map((item) => JSON.parse(item.receipt_json));
    return { matchId, acceptedRevision: state.revision, submissions, proposals, policy: Q08_RECONCILIATION_POLICY };
  }
  async proposeReconciliation(principal, matchId, input) {
    const row = await this.managerMatch(principal, matchId);
    const state = JSON.parse(row.state_json);
    if (!input || Object.keys(input).some((key) => !["proposalId", "baseRevision", "sourceSubmissionIds", "reason", "resolution", "commands"].includes(key)))
      bad2("Use only the documented immutable reconciliation proposal fields.");
    const signature2 = digest2(canonical5(input));
    const existing = await this.one("SELECT signature,receipt_json FROM reconciliation_proposals WHERE id=$1 AND match_id=$2 AND actor_id=$3", [input.proposalId, matchId, principal.accountId]);
    if (existing) {
      if (existing.signature !== signature2)
        throw new AccessError("RECONCILIATION_PROPOSAL_CONFLICT", 409, "That proposal identity already preserves different review evidence.");
      return JSON.parse(existing.receipt_json);
    }
    const snapshot = await this.reconciliation(principal, matchId);
    const preview = previewReconciliation(state, input, snapshot.submissions, { actorId: principal.accountId, recordedAtMs: this.now() });
    if (!preview.valid)
      throw new AccessError("RECONCILIATION_PREVIEW_REJECTED", 422, preview.issues.join(" ").slice(0, 1500));
    const { projectedState: discarded, ...savedPreview } = preview;
    void discarded;
    const receipt = { input, matchId, actorId: principal.accountId, createdAt: new Date(this.now()).toISOString(), sourceDigests: input.sourceSubmissionIds.map((id9) => ({ submissionId: id9, originalDigest: snapshot.submissions.find((item) => item.submissionId === id9).originalDigest })), acceptedStateDigest: digest2(canonical5(state)), preview: savedPreview, status: "prepared", appliedRevision: null };
    await this.execute("INSERT INTO reconciliation_proposals(id,match_id,actor_id,signature,receipt_json,created_at) VALUES($1,$2,$3,$4,$5,$6)", [input.proposalId, matchId, principal.accountId, signature2, JSON.stringify(receipt), this.now()]);
    await this.audit(principal, "reconciliation.proposal_prepared", matchId, "q08_authority_unapproved");
    return receipt;
  }
  async recordFinishedContext(principal, matchId, policy) {
    const row = await this.managerMatch(principal, matchId);
    const state = JSON.parse(row.state_json);
    if (state.status !== "completed")
      return { status: "not_finished" };
    await this.refreshDetailedArchive(row, state);
    const community = await this.communityState(row.team_id, row.season_id);
    const existing = community.matches.find((item) => item.id === matchId);
    const quarantine = await this.one("SELECT event_id FROM events WHERE match_id=$1 AND disposition='quarantined' LIMIT 1", [matchId]);
    const conflict4 = await this.one("SELECT id FROM conflicting_submissions WHERE match_id=$1 LIMIT 1", [matchId]);
    const unresolved = Boolean(quarantine || conflict4);
    if (existing) {
      const retainedFinishId = state.eventHistory?.filter((event) => event.type === "half.ended").at(-1)?.id;
      const retainedFinish = retainedFinishId ? await this.one("SELECT envelope_json FROM events WHERE event_id=$1 AND match_id=$2 AND disposition='accepted'", [retainedFinishId, matchId]) : void 0;
      const currentGrant = await this.one("SELECT epoch FROM controller_grants WHERE match_id=$1", [matchId]);
      const sourceEpoch = retainedFinish ? JSON.parse(retainedFinish.envelope_json).controllerEpoch : null;
      const quality = unresolved ? "conflicted" : state.recoveryRequired || sourceEpoch !== currentGrant?.epoch || finishEligibilityChanged(state, existing) ? "review_required" : existing.finishQuality;
      if (quality !== existing.finishQuality) {
        const next2 = { ...community, revision: community.revision + 1, matches: community.matches.map((match) => match.id === matchId ? { ...match, finishQuality: quality } : match), audit: [...community.audit, { id: randomUUID8(), actorAccountId: null, action: "service.finish_evidence_flagged_without_reopening", atMs: this.now() }] };
        await this.saveDocument(row.team_id, row.season_id, "community", next2);
      }
      return { status: "original_context_preserved", finishQuality: quality };
    }
    const finishId = state.eventHistory?.filter((event) => event.type === "half.ended").at(-1)?.id;
    const finishRow = finishId ? await this.one("SELECT envelope_json,actor_id FROM events WHERE event_id=$1 AND match_id=$2 AND disposition='accepted'", [finishId, matchId]) : void 0;
    const finish = finishRow ? JSON.parse(finishRow.envelope_json) : null;
    const mappingRow = finish ? await this.one("SELECT mapping_json FROM clock_mappings WHERE challenge_id=$1 AND match_id=$2", [finish.clockEvidence.anchorId, matchId]) : void 0;
    const grant = await this.one("SELECT epoch FROM controller_grants WHERE match_id=$1", [matchId]);
    const preparation = await this.document(row.team_id, row.season_id, "preparation");
    const fixture = preparation.fixtures.find((item) => item.id === matchId && item.seasonId === row.season_id);
    const playedDate = state.config.fixture?.playedDate ?? fixture?.playedDate;
    if (!playedDate)
      return { status: "accepted_fixture_date_required" };
    const scheduledAtMs = Date.parse(`${playedDate}T00:00:00Z`);
    const context = deriveFinishedMatchContext({ state, acceptedFinish: finish, acceptedFinishActorId: finishRow?.actor_id ?? null, teamId: row.team_id, seasonId: row.season_id, currentControllerEpoch: grant?.epoch ?? 0, unresolvedConflicts: unresolved, mapping: mappingRow ? JSON.parse(mappingRow.mapping_json) : null, policy: policy ?? null, serverNowMs: this.now(), scheduledAtMs, sharing: "manager_only", sharingPolicyVersion: 0 });
    const next = { ...community, revision: community.revision + 1, matches: [...community.matches, { ...context, voteCutoffAtMs: null, cutoffSource: "unresolved", finalisationDeadlineAtMs: context.actualFullTimeAtMs === null ? null : context.actualFullTimeAtMs + 36e5 }], audit: [...community.audit, { id: randomUUID8(), actorAccountId: null, action: "service.accepted_finish_registered_manager_only", atMs: this.now() }] };
    await this.saveDocument(row.team_id, row.season_id, "community", next);
    return { status: "registered_from_accepted_history", finishQuality: context.finishQuality };
  }
  async refreshDetailedArchive(row, match) {
    const saved = await this.one("SELECT value_json FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='records'", [row.team_id, row.season_id]);
    if (!saved)
      return;
    const records = JSON.parse(saved.value_json);
    const archived = records.results.find((item) => item.id === match.config.matchId && item.recordMode === "detailed_live");
    if (!archived || (archived.sourceMatchRevision ?? -1) >= match.revision)
      return;
    if (match.recoveryRequired) {
      if (archived.detailCompleteness !== "review_required") {
        const reviewed = { ...records, revision: records.revision + 1, results: records.results.map((item) => item.id === archived.id ? { ...item, detailCompleteness: "review_required", revision: item.revision + 1 } : item) };
        await this.saveDocument(row.team_id, row.season_id, "records", reviewed);
      }
      return;
    }
    const context = { matchId: archived.id, playedDate: archived.playedDate, opponent: archived.opponent, homeAway: archived.homeAway, fixtureClass: archived.fixtureClass };
    const updated = reduceRecords({ ...records, liveMatch: context }, { type: "live.archive", commandId: `accepted-archive-${digest2(canonical5([archived.id, match.revision]))}`, at: new Date(this.now()).toISOString(), actor: "manager", match, reason: "Existing detailed archive refreshed from the newer accepted canonical match revision; original source events and prior archive audit remain retained." });
    const projected = { ...updated, liveMatch: records.liveMatch };
    await this.saveDocument(row.team_id, row.season_id, "records", projected);
  }
  async upload(principal, matchId, token, values) {
    const row = await this.managerMatch(principal, matchId);
    if (!Array.isArray(values) || values.length === 0 || values.length > 100)
      bad2("Upload between one and 100 ordered events.");
    const grant = await this.one("SELECT * FROM controller_grants WHERE match_id=$1", [matchId]);
    const currentCapability = !!grant && grant.account_id === principal.accountId && !!token && digest2(token) === grant.capability_hash;
    let state = JSON.parse(row.state_json);
    const results = [];
    for (const value of values) {
      const event = validateEnvelope2(value, matchId);
      const device = await this.one("SELECT account_id FROM devices WHERE id=$1", [event.deviceId]);
      if (!device || device.account_id !== principal.accountId)
        throw new AccessError("DEVICE_BINDING_REQUIRED", 403, "This event device is not enrolled to the authenticated account.");
      const signature2 = digest2(canonical5(event));
      const previous = await this.one("SELECT * FROM events WHERE event_id=$1", [event.eventId]);
      if (previous) {
        if (previous.match_id !== matchId || previous.signature !== signature2) {
          await this.execute("INSERT INTO conflicting_submissions VALUES($1,$2,$3,$4,$5,$6)", [randomUUID8(), matchId, principal.accountId, JSON.stringify(value), "EVENT_ID_CONFLICT", this.now()]);
          results.push({ eventId: event.eventId, clientSequence: event.clientSequence, disposition: "quarantined", reason: "EVENT_ID_CONFLICT", revision: null, duplicate: false });
        } else
          results.push({ eventId: previous.event_id, clientSequence: previous.client_sequence, disposition: previous.disposition, reason: previous.reason, revision: previous.revision, duplicate: true });
        continue;
      }
      const stream = await this.one("SELECT sequence,previous_event_id FROM streams WHERE match_id=$1 AND device_id=$2", [matchId, event.deviceId]);
      if (event.clientSequence !== (stream?.sequence ?? 0) + 1 || event.previousEventId !== (stream?.previous_event_id ?? null)) {
        await this.execute("INSERT INTO conflicting_submissions VALUES($1,$2,$3,$4,$5,$6)", [randomUUID8(), matchId, principal.accountId, JSON.stringify(value), "SEQUENCE_GAP_OR_REUSE", this.now()]);
        results.push({ eventId: event.eventId, clientSequence: event.clientSequence, disposition: "quarantined", reason: "SEQUENCE_GAP_OR_REUSE", revision: null, duplicate: false });
        continue;
      }
      let reason = null;
      if (event.contractVersion !== EVENT_CONTRACT_VERSION2 || event.schemaVersion !== 1 || event.engineVersion !== ENGINE_VERSION)
        reason = "UNSUPPORTED_EVENT_VERSION";
      else if (!grant || !currentCapability || event.controllerEpoch !== grant.epoch || event.deviceId !== grant.device_id)
        reason = "STALE_CONTROLLER";
      else if (grant.frozen)
        reason = "HANDOVER_WRITES_FROZEN";
      else if (event.baseRevision !== state.revision)
        reason = "STALE_REVISION";
      if (!reason) {
        try {
          const next = reduceMatch(state, { ...event.command, actorId: principal.accountId });
          const effective = effectiveEventTime(state, next, event.command);
          if (effective.half !== event.effectiveHalf || effective.halfElapsedMs !== event.halfElapsedMs || effective.matchElapsedMs !== event.matchElapsedMs)
            throw new Error("Effective playing-time evidence differs from the command.");
          state = next;
        } catch {
          reason = "INVALID_MATCH_TRANSITION";
        }
      }
      const disposition = reason ? "quarantined" : "accepted";
      const revision = reason ? null : state.revision;
      await this.execute("INSERT INTO events(event_id,match_id,device_id,client_sequence,envelope_json,signature,disposition,reason,revision,received_at,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [event.eventId, matchId, event.deviceId, event.clientSequence, JSON.stringify(event), signature2, disposition, reason, revision, this.now(), principal.accountId]);
      await this.execute("INSERT INTO streams(match_id,device_id,sequence,previous_event_id) VALUES($1,$2,$3,$4) ON CONFLICT(match_id,device_id) DO UPDATE SET sequence=excluded.sequence,previous_event_id=excluded.previous_event_id", [matchId, event.deviceId, event.clientSequence, event.eventId]);
      results.push({ eventId: event.eventId, clientSequence: event.clientSequence, disposition, reason, revision, duplicate: false });
    }
    if (results.some((item) => item.disposition === "accepted" && !item.duplicate))
      await this.execute("UPDATE matches SET state_json=$1,last_sync_at=$2 WHERE id=$3", [JSON.stringify(state), this.now(), matchId]);
    await this.audit(principal, "events.uploaded", matchId, results.some((item) => item.disposition === "quarantined") ? "review_required" : "accepted");
    if (results.some((item) => item.disposition === "accepted" && !item.duplicate))
      await this.enqueueNotifications(row.team_id, row.season_id, "match", matchId, `accepted-revision-${state.revision}`);
    return { results, revision: state.revision, pendingReview: results.some((item) => item.disposition === "quarantined") };
  }
  async quarantine(principal, matchId) {
    await this.managerMatch(principal, matchId);
    return [...await this.many("SELECT event_id,device_id,client_sequence,envelope_json,reason,received_at FROM events WHERE match_id=$1 AND disposition='quarantined' ORDER BY received_at,client_sequence", [matchId]), ...await this.many("SELECT id,original_json,reason,created_at FROM conflicting_submissions WHERE match_id=$1 ORDER BY created_at", [matchId])];
  }
  async offerHandover(principal, matchId, token, toAccountId, toDeviceId, baseRevision) {
    const row = await this.managerMatch(principal, matchId);
    const grant = await this.assertController(principal, matchId, token);
    if (grant.frozen)
      throw new AccessError("TRANSFER_PENDING", 409, "A controller transfer is already pending.");
    const state = JSON.parse(row.state_json);
    if (state.revision !== baseRevision)
      throw new AccessError("STALE_REVISION", 409, "Synchronise the accepted checkpoint before handover.");
    if (state.status.endsWith("_running"))
      throw new AccessError("CLOCK_ANCHOR_REQUIRED", 409, "Running handover requires a verified UTC/device clock exchange. This development service supports handover while the match clock is already paused, at half-time or before kick-off; it never silently pauses play.");
    if (!validId4(toAccountId) || !validDeviceId2(toDeviceId))
      bad2("A target account and canonical device identifier of at most 120 characters are required.");
    const target = await this.one("SELECT * FROM accounts WHERE id=$1", [toAccountId]);
    if (!target)
      throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    const targetPrincipal = { accountId: target.id, issuer: target.issuer, subject: target.subject, identityClassification: target.classification, adultVerified: !!target.adult_verified, strongAuth: !!target.strong_auth_enrolled, authenticatedAt: this.now(), status: target.status };
    assertCanManageTeam(targetPrincipal, await this.memberships(), row.team_id, row.season_id, this.now());
    const id9 = randomUUID8();
    await this.execute("INSERT INTO transfers VALUES($1,$2,$3,$4,$5,$6,$7)", [id9, matchId, grant.epoch, toAccountId, toDeviceId, "pending", this.now()]);
    await this.execute("UPDATE controller_grants SET frozen=1 WHERE match_id=$1", [matchId]);
    await this.audit(principal, "controller.transfer_offered", matchId, "pending");
    return { transferId: id9, state: "pending", acceptedRevision: state.revision };
  }
  async acceptHandover(principal, matchId, transferId, deviceId) {
    await this.managerMatch(principal, matchId);
    assertAdultAuthority(principal, false, this.now());
    const transfer = await this.one("SELECT * FROM transfers WHERE id=$1 AND match_id=$2", [transferId, matchId]);
    const grant = await this.one("SELECT * FROM controller_grants WHERE match_id=$1", [matchId]);
    if (!transfer || transfer.to_account_id !== principal.accountId || transfer.to_device_id !== deviceId)
      throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    if (transfer.state !== "pending" || !grant || grant.epoch !== transfer.from_epoch || !grant.frozen)
      throw new AccessError("TRANSFER_CONFLICT", 409, "Check the authoritative transfer status before retrying.");
    await this.bindDevice(principal, deviceId);
    const capability = randomBytes7(32).toString("base64url");
    const epoch = grant.epoch + 1;
    await this.execute("UPDATE controller_grants SET epoch=$1,account_id=$2,device_id=$3,capability_hash=$4,frozen=0 WHERE match_id=$5", [epoch, principal.accountId, deviceId, digest2(capability), matchId]);
    await this.execute("UPDATE transfers SET state='accepted' WHERE id=$1", [transferId]);
    await this.execute("INSERT INTO controller_history VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [randomUUID8(), matchId, epoch, principal.accountId, grant.device_id, deviceId, "transferred", null, this.now()]);
    await this.audit(principal, "controller.transferred", matchId, "accepted");
    return { epoch, deviceId, controllerToken: capability, checkpoint: (await this.download(principal, matchId, deviceId)).deviceCheckpoint, acceptedRevision: JSON.parse((await this.match(matchId)).state_json).revision };
  }
  async recover(principal, matchId, deviceId, reason) {
    const row = await this.managerMatch(principal, matchId);
    assertAdultAuthority(principal, true, this.now());
    if (!validDeviceId2(deviceId) || typeof reason !== "string" || reason.trim().length < 5 || reason.length > 500)
      bad2("Recovery needs a target canonical device identifier of at most 120 characters and a concise audit reason.");
    await this.bindDevice(principal, deviceId);
    const old = await this.one("SELECT * FROM controller_grants WHERE match_id=$1", [matchId]);
    const capability = randomBytes7(32).toString("base64url");
    const epoch = (old?.epoch ?? 0) + 1;
    const state = JSON.parse(row.state_json);
    if (state.status.endsWith("_running")) {
      state.recoveryRequired = true;
      state.recoveryReason = "Controller recovery: reconcile the referee clock and any unsynchronised old-device events.";
      await this.execute("UPDATE matches SET state_json=$1 WHERE id=$2", [JSON.stringify(state), matchId]);
    }
    await this.execute("INSERT INTO controller_grants(match_id,epoch,account_id,device_id,capability_hash,frozen) VALUES($1,$2,$3,$4,$5,0) ON CONFLICT(match_id) DO UPDATE SET epoch=excluded.epoch,account_id=excluded.account_id,device_id=excluded.device_id,capability_hash=excluded.capability_hash,frozen=0", [matchId, epoch, principal.accountId, deviceId, digest2(capability)]);
    await this.execute("UPDATE transfers SET state='superseded' WHERE match_id=$1 AND state='pending'", [matchId]);
    await this.execute("INSERT INTO controller_history VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [randomUUID8(), matchId, epoch, principal.accountId, old?.device_id ?? null, deviceId, "recovered", reason.trim(), this.now()]);
    await this.audit(principal, "controller.recovered", matchId, "reconciliation_required");
    return { epoch, deviceId, controllerToken: capability, reconciliationRequired: true, checkpoint: (await this.download(principal, matchId, deviceId)).deviceCheckpoint };
  }
  async staffRevision(teamId, seasonId) {
    const row = await this.one("SELECT revision FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='staff'", [teamId, seasonId]);
    return row?.revision ?? 0;
  }
  async bumpStaffRevision(teamId, seasonId) {
    const revision = await this.staffRevision(teamId, seasonId) + 1;
    await this.saveDocument(teamId, seasonId, "staff", { revision });
    return revision;
  }
  async managers(principal, teamId, seasonId, requestedRole) {
    assertTeamRole(principal, await this.memberships(), teamId, seasonId, ["administrator"], this.now());
    assertAdultAuthority(principal, false, this.now());
    const accounts = await this.many("SELECT * FROM accounts WHERE id IN (SELECT account_id FROM memberships WHERE team_id=$1)", [teamId]);
    const community = await this.document(teamId, seasonId, "community");
    const evidence = accounts.map((account3) => ({ accountId: account3.id, label: community.accounts.find((item) => item.id === account3.id)?.label ?? "Verified adult account", status: account3.status, identityClassification: account3.classification, adultVerified: Boolean(account3.adult_verified), strongAuthEnrolled: Boolean(account3.strong_auth_enrolled) }));
    return managerRoster({ principal, memberships: await this.memberships(), accounts: evidence, teamId, seasonId, nowMs: this.now(), revision: await this.staffRevision(teamId, seasonId), requestedRole });
  }
  async assignManager(actor, teamId, seasonId, accountId, expectedRevision) {
    assertTeamRole(actor, await this.memberships(), teamId, seasonId, ["administrator"], this.now());
    assertAdultAuthority(actor, true, this.now());
    if (!validId4(accountId))
      bad2("A canonical account identifier is required.");
    if (expectedRevision !== void 0 && (!nonnegative4(expectedRevision) || expectedRevision !== await this.staffRevision(teamId, seasonId)))
      throw new AccessError("STALE_REVISION", 409, "Refresh the current staff assignments before changing them.");
    const account3 = await this.one("SELECT * FROM accounts WHERE id=$1", [accountId]);
    if (!account3)
      throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    const target = { accountId: account3.id, issuer: account3.issuer, subject: account3.subject, identityClassification: account3.classification, adultVerified: !!account3.adult_verified, strongAuth: !!account3.strong_auth_enrolled, authenticatedAt: this.now(), status: account3.status };
    assertCanAssignManager(actor, target, await this.memberships(), teamId, seasonId, this.now());
    const alreadyActive = (await this.memberships()).some((item) => item.accountId === accountId && item.teamId === teamId && item.seasonId === seasonId && item.role === "manager" && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > this.now()));
    if (!alreadyActive) {
      await this.execute("INSERT INTO memberships(account_id,team_id,season_id,role) VALUES($1,$2,$3,'manager') ON CONFLICT(account_id,team_id,season_id,role) DO UPDATE SET revoked_at=NULL,expires_at=NULL", [accountId, teamId, seasonId]);
      await this.bumpStaffRevision(teamId, seasonId);
      await this.audit(actor, "manager.assigned", teamId, "accepted");
    }
    return { accountId, teamId, seasonId, role: "manager", revision: await this.staffRevision(teamId, seasonId), acceptedAt: new Date(this.now()).toISOString() };
  }
  async revokeManager(actor, teamId, seasonId, input, expectedRevision) {
    assertTeamRole(actor, await this.memberships(), teamId, seasonId, ["administrator"], this.now());
    assertAdultAuthority(actor, true, this.now());
    if (!input || Object.keys(input).some((key) => !["accountId", "reason", "confirmRevocation"].includes(key)) || !validId4(input.accountId) || input.confirmRevocation !== true || typeof input.reason !== "string" || input.reason.trim().length < 5 || input.reason.length > 500)
      bad2("Confirm a scoped manager revocation and record its evidence reason.");
    if (expectedRevision !== void 0 && (!nonnegative4(expectedRevision) || expectedRevision !== await this.staffRevision(teamId, seasonId)))
      throw new AccessError("STALE_REVISION", 409, "Refresh the current staff assignments before changing them.");
    const member = await this.one("SELECT account_id,revoked_at FROM memberships WHERE account_id=$1 AND team_id=$2 AND season_id=$3 AND role='manager'", [input.accountId, teamId, seasonId]);
    if (!member)
      throw new AccessError("NOT_FOUND", 404, "That manager assignment is outside this scope.");
    if (member.revoked_at === null) {
      await this.execute("UPDATE memberships SET revoked_at=$1 WHERE account_id=$2 AND team_id=$3 AND season_id=$4 AND role='manager'", [this.now(), input.accountId, teamId, seasonId]);
      await this.execute("UPDATE controller_grants SET frozen=1 WHERE account_id=$1 AND team_id=$2 AND season_id=$3", [input.accountId, teamId, seasonId]);
      await this.bumpStaffRevision(teamId, seasonId);
      await this.audit(actor, "manager.assignment_revoked", input.accountId, input.reason.trim());
    }
    return { accountId: input.accountId, teamId, seasonId, role: "manager", revision: await this.staffRevision(teamId, seasonId), acceptedAt: new Date(this.now()).toISOString(), revoked: true, controllerFrozen: true, otherSeasonAssignmentsRetained: true, remainingActiveTeamSeasons: (await this.memberships()).filter((item) => item.accountId === input.accountId && item.teamId === teamId && item.role === "manager" && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > this.now())).map((item) => item.seasonId) };
  }
  async privacyRecords(principal) {
    const rows = await this.many("SELECT id,account_id,kind,status,team_id,season_id,affected_memberships_json,created_at FROM privacy_requests WHERE account_id=$1 ORDER BY created_at,id", [principal.accountId]);
    return rows.map((row) => ({ requestId: row.id, accountId: row.account_id, kind: row.kind, status: row.status, scope: row.kind === "leave_team" ? row.team_id && row.season_id ? { type: "team_season", teamId: row.team_id, seasonId: row.season_id } : null : { type: "all_memberships" }, affectedMemberships: row.affected_memberships_json === null ? null : JSON.parse(row.affected_memberships_json), createdAtMs: row.created_at }));
  }
  async privacyRequest(principal, input) {
    const plan = prepareAccountPrivacyRequest({ principal, memberships: await this.memberships(), input, nowMs: this.now() });
    const pending = await this.one("SELECT p.id FROM privacy_pending_keys k JOIN privacy_requests p ON p.id=k.request_id WHERE k.business_key=$1 AND p.account_id=$2 AND p.status='pending_verification_and_policy'", [plan.businessKey, principal.accountId]);
    let requestId = pending?.id;
    if (!requestId) {
      const retained = plan.scope.type === "team_season" ? await this.one("SELECT id FROM privacy_requests WHERE account_id=$1 AND kind=$2 AND team_id=$3 AND season_id=$4 AND status='pending_verification_and_policy' ORDER BY created_at,id LIMIT 1", [principal.accountId, plan.kind, plan.scope.teamId, plan.scope.seasonId]) : await this.one("SELECT id FROM privacy_requests WHERE account_id=$1 AND kind=$2 AND team_id IS NULL AND season_id IS NULL AND status='pending_verification_and_policy' ORDER BY created_at,id LIMIT 1", [principal.accountId, plan.kind]);
      requestId = retained?.id;
    }
    if (!requestId) {
      requestId = randomUUID8();
      await this.execute("INSERT INTO privacy_requests(id,account_id,kind,status,policy_version,verified_at,created_at,team_id,season_id,affected_memberships_json) VALUES($1,$2,$3,$4,NULL,NULL,$5,$6,$7,$8)", [requestId, principal.accountId, plan.kind, plan.status, this.now(), plan.scope.type === "team_season" ? plan.scope.teamId : null, plan.scope.type === "team_season" ? plan.scope.seasonId : null, JSON.stringify(plan.affectedMemberships)]);
      await this.audit(principal, "privacy.requested", requestId, "pending_verification_and_policy");
    }
    await this.execute("INSERT INTO privacy_pending_keys(business_key,request_id) VALUES($1,$2) ON CONFLICT(business_key) DO UPDATE SET request_id=excluded.request_id", [plan.businessKey, requestId]);
    return (await this.privacyRequests(principal)).items.find((item) => item.requestId === requestId);
  }
  async privacyRequests(principal) {
    return projectAccountPrivacyRequests({ principal, memberships: await this.memberships(), records: await this.privacyRecords(principal), nowMs: this.now() });
  }
  /** Explicit setup seam: an authorised operator imports verified provider-to-account mappings; no token creates authority. */
  async bindIdentity(accountId, issuer2, subject) {
    await this.execute("UPDATE accounts SET issuer=$1,subject=$2 WHERE id=$3", [issuer2, subject, accountId]);
  }
  async bindDevice(principal, deviceId) {
    const device = await this.one("SELECT account_id FROM devices WHERE id=$1", [deviceId]);
    if (device && device.account_id !== principal.accountId)
      throw new AccessError("DEVICE_ACCOUNT_CONFLICT", 409, "Enrol a separate device identity for this account.");
    await this.execute("INSERT INTO devices(id,account_id) VALUES($1,$2) ON CONFLICT(id) DO NOTHING", [deviceId, principal.accountId]);
  }
  async teamMatches(principal, teamId, seasonId, requestedRole, query = { limit: 25, cursor: null }) {
    const memberships = await this.memberships();
    const audience2 = matchPageAudience(principal, memberships, teamId, seasonId, requestedRole, this.now());
    const scope = { principal, teamId, seasonId, role: audience2.role, playerId: audience2.playerId ?? null }, afterId = matchPagePosition(scope, query);
    const rows = await this.many('SELECT id,state_json,sharing_policy_json,last_sync_at FROM matches WHERE team_id=$1 AND season_id=$2 AND ($3::text IS NULL OR id COLLATE "C" > $3::text COLLATE "C") ORDER BY id COLLATE "C" LIMIT $4', [teamId, seasonId, afterId, query.limit + 1]);
    const visible = rows.slice(0, query.limit);
    return { items: visible.map((row) => filterMatchForPrincipal({ principal, memberships, teamId, seasonId, state: JSON.parse(row.state_json), policy: JSON.parse(row.sharing_policy_json), lastSyncAt: row.last_sync_at, requestedRole, now: this.now() })), nextCursor: rows.length > query.limit ? matchPageCursor(scope, visible[visible.length - 1].id) : null, serverTime: new Date(this.now()).toISOString() };
  }
  async document(teamId, seasonId, kind2) {
    const row = await this.one("SELECT value_json FROM documents WHERE team_id=$1 AND season_id=$2 AND kind=$3", [teamId, seasonId, kind2]);
    if (!row)
      throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    return JSON.parse(row.value_json);
  }
  async saveDocument(teamId, seasonId, kind2, state) {
    await this.execute("INSERT INTO documents(team_id,season_id,kind,revision,value_json) VALUES($1,$2,$3,$4,$5) ON CONFLICT(team_id,season_id,kind) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json", [teamId, seasonId, kind2, state.revision, JSON.stringify(state)]);
  }
  async enqueueNotifications(teamId, seasonId, category, entityId, sourceId) {
    const workerJob = this.db.applicationContext?.kind === "worker_job";
    const observed = workerJob ? (await this.one("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms"))?.now_ms : this.now();
    if (typeof observed !== "number" || !Number.isSafeInteger(observed) || observed < 0) throw new Error("DATABASE_CLOCK_UNAVAILABLE");
    const recipients = /* @__PURE__ */ new Map();
    const priority = { manager: 3, player: 2, spectator: 1, administrator: 0 };
    for (const member of (await this.memberships()).filter((item) => item.teamId === teamId && item.seasonId === seasonId && ["manager", "player", "spectator"].includes(item.role) && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > observed))) {
      const current3 = recipients.get(member.accountId);
      if (!current3 || priority[member.role] > priority[current3.role])
        recipients.set(member.accountId, member);
    }
    let inserted = 0;
    for (const member of recipients.values()) {
      if (member.role === "administrator" || member.role === "player" && !member.playerId)
        continue;
      const businessKey = `notify:${digest2(canonical5([teamId, seasonId, category, entityId, sourceId, member.accountId, member.role]))}`;
      const job = createTeamNotificationJob({ id: randomUUID8(), businessKey, accountId: member.accountId, teamId, seasonId, audience: member.role, playerId: member.role === "player" ? member.playerId : null, category, entityId, dueAtMs: observed });
      if (workerJob) {
        const result = await this.one("SELECT longball.enqueue_award_notification($1,$2,$3::jsonb,$4) AS changes", [job.id, businessKey, JSON.stringify(job), job.dueAtMs]);
        inserted += Number(result?.changes ?? 0);
      } else {
        const result = await this.execute("INSERT INTO jobs(id,business_key,kind,payload_json,due_at) VALUES($1,$2,'notification.dispatch',$3,$4) ON CONFLICT(business_key) DO NOTHING", [job.id, businessKey, JSON.stringify(job), job.dueAtMs]);
        inserted += Number(result.changes);
      }
    }
    return inserted;
  }
  async preparation(principal, teamId, seasonId) {
    assertCanManageTeam(principal, await this.memberships(), teamId, seasonId, this.now());
    return await this.document(teamId, seasonId, "preparation");
  }
  async configuration(principal, teamId, seasonId, role) {
    if (role)
      assertTeamRole(principal, await this.memberships(), teamId, seasonId, role === "manager" || role === "administrator" ? [role] : [], this.now());
    const state = await this.document(teamId, seasonId, "preparation");
    return configurationServiceView({ principal, memberships: await this.memberships(), preparation: state, seasonId, nowMs: this.now() });
  }
  async configurationCommand(principal, teamId, seasonId, command, role) {
    await this.configuration(principal, teamId, seasonId, role);
    if (!command || !["club.updated", "team.updated"].includes(command.type))
      bad2("Only club or team configuration can be changed in this context.");
    if (role && command.type === "club.updated" && role !== "administrator")
      throw new AccessError("NOT_FOUND", 404, "Choose the current administrator context to administer the club.");
    const state = applyConfigurationServiceCommand({ principal, memberships: await this.memberships(), preparation: await this.document(teamId, seasonId, "preparation"), seasonId, nowMs: this.now(), command });
    await this.saveDocument(teamId, seasonId, "preparation", state);
    await this.audit(principal, command.type, teamId, "administrator_configuration_accepted");
    return await this.configuration(principal, teamId, seasonId, role);
  }
  async seasonContext(principal, teamId, seasonId) {
    const community = await this.communityState(teamId, seasonId);
    const accounts = await this.many("SELECT * FROM accounts", []);
    const catalogue = await this.many("SELECT season_id,start_year FROM team_seasons WHERE team_id=$1", [teamId]);
    if (catalogue.some((season) => season.start_year === null)) throw new AccessError("SEASON_SCOPE_REVIEW_REQUIRED", 409, "Record the existing season catalogue before creating another season.");
    const existingSeasons = catalogue.map((season) => ({ teamId, id: season.season_id, startYear: season.start_year }));
    return {
      principal,
      memberships: await this.memberships(),
      existingSeasons,
      nowMs: this.now(),
      preparation: await this.document(teamId, seasonId, "preparation"),
      records: await this.document(teamId, seasonId, "records"),
      community,
      accounts: accounts.map((account3) => ({ accountId: account3.id, label: community.accounts.find((item) => item.id === account3.id)?.label ?? "Verified account", status: account3.status, identityClassification: account3.classification, adultVerified: Boolean(account3.adult_verified), strongAuthEnrolled: Boolean(account3.strong_auth_enrolled) }))
    };
  }
  async seasonOptions(principal, teamId, seasonId) {
    return seasonRolloverOptions(await this.seasonContext(principal, teamId, seasonId));
  }
  async createSeason(principal, teamId, seasonId, command) {
    const context = await this.seasonContext(principal, teamId, seasonId);
    const plan = planSeasonRollover({ ...context, command });
    if (await this.one("SELECT kind FROM documents WHERE team_id=$1 AND season_id=$2 LIMIT 1", [teamId, plan.receipt.seasonId]))
      throw new AccessError("SEASON_EXISTS", 409, "That destination season already has saved documents.");
    const team = await this.one("SELECT club_id FROM teams WHERE id=$1 AND scope_status='resolved'", [teamId]);
    const destination = plan.preparation.seasons.find((item) => item.id === plan.receipt.seasonId);
    if (!team || !destination) throw new AccessError("NOT_FOUND", 404, "The authorised team season is unavailable.");
    await this.execute("INSERT INTO team_seasons(club_id,team_id,season_id,label,start_year,start_date,end_date) VALUES($1,$2,$3,$4,$5,$6,$7)", [team.club_id, teamId, destination.id, destination.label, destination.startYear, destination.startDate, destination.endDate]);
    for (const member of plan.memberships)
      await this.execute("INSERT INTO memberships(account_id,team_id,season_id,role,player_id,expires_at,revoked_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [member.accountId, member.teamId, member.seasonId, member.role, member.playerId ?? null, member.expiresAt ?? null, member.revokedAt ?? null]);
    await this.saveDocument(teamId, plan.receipt.seasonId, "preparation", plan.preparation);
    await this.saveDocument(teamId, plan.receipt.seasonId, "records", plan.records);
    await this.saveDocument(teamId, plan.receipt.seasonId, "community", plan.community);
    await this.audit(principal, "season.created_from_explicit_assignments", plan.receipt.seasonId, "accepted_no_spectator_renewal");
    return plan.receipt;
  }
  /** Called inside the preparation mutation transaction; current labels never rewrite saved match evidence. */
  async projectPreparationRecords(teamId, seasonId, preparation, sourceCommandId) {
    const previous = await this.document(teamId, seasonId, "records");
    const labels = new Map(previous.players.map((player) => [player.id, player]));
    for (const profile of preparation.profiles.filter((profile2) => profile2.seasonId === seasonId))
      labels.set(profile.playerId, { id: profile.playerId, label: profile.displayName });
    const players = [...labels.values()];
    const evidence = trainingAttendanceEvidence({ ...preparation, training: preparation.training.filter((session) => session.seasonId === seasonId) });
    let records = previous;
    const at = new Date(this.now()).toISOString();
    if (canonical5(players) !== canonical5(previous.players))
      records = {
        ...records,
        players,
        revision: records.revision + 1,
        audit: [...records.audit, { commandId: `preparation-roster-${sourceCommandId}`, action: "preparation.roster.projected", matchId: null, at, reason: "Current season roster labels updated from preparation; saved match snapshots preserved.", before: null, after: null }]
      };
    if (canonical5(evidence) !== canonical5(previous.trainingAttendance))
      records = reduceRecords(records, { type: "training.evidence.replace", commandId: `preparation-training-${sourceCommandId}`, at, actor: "manager", evidence });
    if (records !== previous)
      await this.saveDocument(teamId, seasonId, "records", records);
  }
  async preparationCommand(principal, teamId, seasonId, command) {
    const previous = await this.preparation(principal, teamId, seasonId);
    const types2 = ["club.updated", "team.updated", "season.rolled_over", "profile.saved", "roster.imported", "profile.archived", "formation.saved", "fixture.saved", "fixture.status_changed", "fixture.response_recorded", "fixture.selection_saved", "fixture.attendance_recorded", "fixture.prepared", "match_plan.saved", "match_plan.applied", "match_plan.cleared", "training.series_created", "training.series_updated", "training.series_cancelled", "training.saved", "training.status_changed", "training.response_recorded", "training.attendance_recorded"];
    if (!command || !types2.includes(command.type))
      bad2("Unsupported preparation command.");
    if (command.type === "season.rolled_over")
      throw new AccessError("SEASON_ASSIGNMENT_REQUIRED", 503, "A connected new season requires approved manager/player assignments and explicit spectator renewal. The local rehearsal supports rollover; this service will not save an inaccessible new season or silently copy authority.");
    if (command.type === "club.updated") {
      assertTeamRole(principal, await this.memberships(), teamId, seasonId, ["administrator"], this.now());
      assertAdultAuthority(principal, true, this.now());
    }
    const protectedFixtureIds = [];
    if (command.type === "match_plan.applied") {
      const match = await this.one("SELECT state_json FROM matches WHERE id=$1 AND team_id=$2 AND season_id=$3", [command.fixtureId, teamId, seasonId]);
      if (match) {
        const accepted2 = JSON.parse(match.state_json);
        if (accepted2.status !== "preparation" || accepted2.revision !== 0 || await this.one("SELECT match_id FROM controller_grants WHERE match_id=$1", [command.fixtureId]) || await this.one("SELECT event_id FROM events WHERE match_id=$1 LIMIT 1", [command.fixtureId])) protectedFixtureIds.push(command.fixtureId);
      }
    }
    const state = reducePreparation(previous, command, { nowMs: this.now(), protectedFixtureIds });
    if (command.type === "fixture.prepared") {
      const snapshot = state.snapshots.find((snapshot2) => snapshot2.fixtureId === command.fixtureId && snapshot2.preparedRevision === command.expectedRevision + 1);
      if (!snapshot)
        throw new AccessError("PREPARATION_SNAPSHOT_REQUIRED", 409, "The immutable prepared fixture snapshot is unavailable.");
      assertCanManageTeam(principal, await this.memberships(), teamId, snapshot.seasonId, this.now());
      const config = fixtureMatchConfig(state, snapshot);
      const existing = await this.one("SELECT * FROM matches WHERE id=$1", [config.matchId]);
      if (!existing)
        await this.insertMatch(config, teamId, snapshot.seasonId);
      else {
        if (existing.team_id !== teamId || existing.season_id !== snapshot.seasonId)
          throw new AccessError("MATCH_SCOPE_CONFLICT", 409, "That fixture identity already belongs to another match scope.");
        if (canonical5(JSON.parse(existing.config_json)) !== canonical5(config)) {
          const matchState = JSON.parse(existing.state_json);
          const claimed = await this.one("SELECT match_id FROM controller_grants WHERE match_id=$1", [config.matchId]);
          const history = await this.one("SELECT event_id FROM events WHERE match_id=$1 LIMIT 1", [config.matchId]);
          if (claimed || history || matchState.revision !== 0 || matchState.status !== "preparation")
            throw new AccessError("MATCH_HISTORY_EXISTS", 409, "This match already has a controller or recorded history. Preserve its saved snapshot and reconcile changes explicitly.");
          await this.execute("UPDATE matches SET config_json=$1,state_json=$2 WHERE id=$3", [JSON.stringify(config), JSON.stringify(createMatch(config)), config.matchId]);
        }
      }
    }
    if (command.type.startsWith("training.") || command.type.startsWith("profile.") || command.type === "roster.imported")
      await this.projectPreparationRecords(teamId, seasonId, state, command.id);
    await this.saveDocument(teamId, seasonId, "preparation", state);
    await this.audit(principal, command.type, teamId, "accepted");
    if (command.type === "fixture.saved")
      await this.enqueueNotifications(teamId, seasonId, "schedule", command.fixture.id, command.id);
    else if (command.type === "fixture.status_changed" || command.type === "fixture.selection_saved")
      await this.enqueueNotifications(teamId, seasonId, "schedule", command.fixtureId, command.id);
    else if (command.type === "training.saved")
      await this.enqueueNotifications(teamId, seasonId, "schedule", command.training.id, command.id);
    else if (command.type === "training.status_changed")
      await this.enqueueNotifications(teamId, seasonId, "schedule", command.trainingId, command.id);
    else if (command.type === "training.series_created")
      for (const occurrence of command.occurrences) await this.enqueueNotifications(teamId, seasonId, "schedule", occurrence.id, command.id);
    else if (command.type === "training.series_updated" || command.type === "training.series_cancelled")
      for (const id9 of command.occurrenceIds) await this.enqueueNotifications(teamId, seasonId, "schedule", id9, command.id);
    return state;
  }
  async ownPreparation(principal, teamId, seasonId) {
    const membership = assertTeamRole(principal, await this.memberships(), teamId, seasonId, ["player"], this.now());
    const state = await this.document(teamId, seasonId, "preparation");
    const profiles = state.profiles.filter((profile2) => profile2.playerId === membership.playerId && profile2.seasonId === seasonId && profile2.active);
    if (profiles.length !== 1)
      throw new AccessError("NOT_FOUND", 404, "The requested own-player profile is unavailable.");
    const profile = profiles[0];
    return projectOwnPlayerPreparation(state, profile, seasonId);
  }
  async ownPreparationCommand(principal, teamId, seasonId, command) {
    const membership = assertTeamRole(principal, await this.memberships(), teamId, seasonId, ["player"], this.now());
    if (!command || !validId4(command.id) || !nonnegative4(command.expectedRevision) || !["own.preferences_saved", "own.fixture_response_recorded", "own.training_response_recorded"].includes(command.type))
      bad2("A valid own-player command and source revision are required.");
    const allowed = command.type === "own.preferences_saved" ? ["id", "expectedRevision", "type", "preferences"] : command.type === "own.fixture_response_recorded" ? ["id", "expectedRevision", "type", "fixtureId", "response"] : ["id", "expectedRevision", "type", "trainingId", "response"];
    if (Object.keys(command).some((key) => !allowed.includes(key)))
      bad2("Own-player commands cannot change another profile or manager-controlled fields.");
    const state = await this.document(teamId, seasonId, "preparation");
    const profiles = state.profiles.filter((profile2) => profile2.playerId === membership.playerId && profile2.seasonId === seasonId && profile2.active);
    if (profiles.length !== 1)
      throw new AccessError("NOT_FOUND", 404, "The requested own-player profile is unavailable.");
    const profile = profiles[0];
    const base = { id: command.id, expectedRevision: command.expectedRevision };
    const bound = command.type === "own.preferences_saved" ? { ...base, type: "profile.saved", profile: { ...profile, preferences: command.preferences } } : command.type === "own.fixture_response_recorded" ? { ...base, type: "fixture.response_recorded", fixtureId: command.fixtureId, profileId: profile.id, response: command.response } : { ...base, type: "training.response_recorded", trainingId: command.trainingId, profileId: profile.id, response: command.response };
    const updated = reducePreparation(state, bound);
    if (bound.type.startsWith("training.") || bound.type.startsWith("profile."))
      await this.projectPreparationRecords(teamId, seasonId, updated, command.id);
    await this.saveDocument(teamId, seasonId, "preparation", updated);
    await this.audit(principal, command.type, teamId, "accepted");
    return await this.ownPreparation(principal, teamId, seasonId);
  }
  /** SQL account/membership records remain the authority; the serializable model is a projection. */
  async communityState(teamId, seasonId) {
    const state = await this.document(teamId, seasonId, "community");
    const accounts = await this.many("SELECT * FROM accounts WHERE status='active'", []);
    const memberships = await this.memberships();
    return {
      ...state,
      accounts: accounts.map((account3) => ({ id: account3.id, label: state.accounts.find((person) => person.id === account3.id)?.label ?? "Verified account", classification: account3.classification === "unclassified" ? "spectator" : account3.classification, adultVerified: !!account3.adult_verified })),
      memberships: memberships.filter((item) => item.role === "manager" || item.role === "player").map((item) => ({ accountId: item.accountId, teamId: item.teamId, seasonId: item.seasonId, role: item.role, playerId: item.playerId, active: item.revokedAt == null && (item.expiresAt == null || item.expiresAt > this.now()) }))
    };
  }
  async communityActor(principal, teamId, seasonId, requestedRole, invitationAcceptance = false) {
    const memberships = await this.memberships();
    if (invitationAcceptance)
      return { accountId: principal.accountId, teamId, seasonId, role: "spectator" };
    const allowed = currentMemberships(principal, memberships, this.now()).filter((item) => item.teamId === teamId && item.seasonId === seasonId && ["manager", "player", "spectator"].includes(item.role));
    const chosen = requestedRole ? allowed.find((item) => item.role === requestedRole) : allowed.find((item) => item.role === "manager") ?? allowed[0];
    if (!chosen)
      throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    if (chosen.role === "manager")
      assertAdultAuthority(principal, false, this.now());
    const actor = { accountId: principal.accountId, teamId, seasonId, role: chosen.role, playerId: chosen.playerId };
    const document = await this.one("SELECT team_id FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='community'", [teamId, seasonId]);
    if (document && !communityCanAccess(await this.communityState(teamId, seasonId), actor, this.now()))
      throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    return actor;
  }
  async community(principal, teamId, seasonId, role) {
    const actor = await this.communityActor(principal, teamId, seasonId, role);
    const state = await this.communityState(teamId, seasonId);
    return { ...getCommunityView(state, actor, this.now()), revision: state.revision };
  }
  async communityCommand(principal, teamId, seasonId, command, role) {
    if (!command || !validId4(command.id) || typeof command.type !== "string")
      bad2("A typed community command with a stable identity is required.");
    if (command.type === "concern.updated" && !["under_review", "resolved"].includes(command.status))
      bad2("Invalid concern status.");
    if (command.type === "concern.submitted" && (!["photo", "uploader"].includes(command.targetType) || !["privacy", "inappropriate", "other"].includes(command.category)))
      bad2("Invalid concern category.");
    if (command.type === "uploader.hidden" && typeof command.hidden !== "boolean")
      bad2("Choose whether to hide the uploader.");
    if (command.type === "privacy.drafted" && !["export", "delete_global_account"].includes(command.requestType))
      bad2("Invalid privacy request type.");
    if (command.type === "match.registered")
      throw new AccessError("POLICY_APPROVAL_REQUIRED", 503, "Connected award and sharing context must be derived from accepted match evidence, a verified finish-time anchor and independently approved competition policy. Caller-supplied trusted finish or sharing policy is not accepted.");
    const actor = await this.communityActor(principal, teamId, seasonId, role, command.type === "invite.accepted");
    const previous = await this.communityState(teamId, seasonId);
    const state = applyCommunityCommand(previous, actor, command, this.now());
    await this.saveDocument(teamId, seasonId, "community", state);
    if (["invite.accepted", "invite.revoked", "grant.revoked"].includes(command.type))
      await this.synchronizeSpectatorMemberships(state);
    for (const match of state.matches.filter((match2) => match2.voteCutoffAtMs !== null && match2.finishQuality === "trusted" && !state.awards.some((award) => award.matchId === match2.id))) {
      const key = `award:${teamId}:${seasonId}:${match.id}:${match.voteCutoffAtMs}`;
      await this.execute("INSERT INTO jobs(id,business_key,kind,payload_json,due_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(business_key) DO NOTHING", [randomUUID8(), key, "award.finalise", JSON.stringify({ teamId, seasonId, matchId: match.id }), match.voteCutoffAtMs]);
    }
    await this.audit(principal, command.type, teamId, "accepted");
    if (command.type === "photo.submitted" || command.type === "photo.revised" || command.type === "photo.published" || command.type === "photo.reviewed" && command.decision === "approve")
      await this.enqueueNotifications(teamId, seasonId, "photos", command.photoId, command.id);
    if (command.type === "award.finalised")
      await this.enqueueNotifications(teamId, seasonId, "awards", command.matchId, command.id);
    return { ...getCommunityView(state, actor, this.now()), revision: state.revision };
  }
  async synchronizeSpectatorMemberships(state) {
    const scopes = /* @__PURE__ */ new Map();
    for (const grant of state.grants)
      scopes.set(JSON.stringify([grant.accountId, grant.teamId, grant.seasonId]), { accountId: grant.accountId, teamId: grant.teamId, seasonId: grant.seasonId });
    for (const scope of scopes.values()) {
      const grants = state.grants.filter((grant) => grant.accountId === scope.accountId && grant.teamId === scope.teamId && grant.seasonId === scope.seasonId);
      const active2 = grants.filter((grant) => grant.revokedAtMs === null && grant.startsAtMs <= this.now() && grant.expiresAtMs > this.now());
      const expiresAt = Math.max(...(active2.length ? active2 : grants).map((grant) => grant.expiresAtMs));
      const revokedAt = active2.length ? null : Math.max(1, this.now());
      await this.execute("INSERT INTO memberships(account_id,team_id,season_id,role,expires_at,revoked_at) VALUES($1,$2,$3,'spectator',$4,$5) ON CONFLICT(account_id,team_id,season_id,role) DO UPDATE SET expires_at=excluded.expires_at,revoked_at=excluded.revoked_at", [scope.accountId, scope.teamId, scope.seasonId, expiresAt, revokedAt]);
    }
  }
  async media(principal, teamId, seasonId, photoId, mode, role) {
    const actor = await this.communityActor(principal, teamId, seasonId, role);
    const result = authorizeCommunityMedia(await this.communityState(teamId, seasonId), actor, photoId, this.now(), mode);
    if (!result.allowed)
      throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    return result;
  }
  async recordsViewer(principal, teamId, seasonId, role) {
    const actor = await this.communityActor(principal, teamId, seasonId, role);
    return { actor: actor.role, playerId: actor.playerId, teamId, seasonId };
  }
  async recordsContext(principal, teamId, seasonId, role) {
    const viewer = await this.recordsViewer(principal, teamId, seasonId, role);
    const rows = await this.many("SELECT state_json FROM matches WHERE team_id=$1 AND season_id=$2 ORDER BY id", [teamId, seasonId]);
    const community = await this.communityState(teamId, seasonId);
    const actor = await this.communityActor(principal, teamId, seasonId, viewer.actor);
    const filtered = getCommunityView(community, actor, this.now());
    return { principal, memberships: await this.memberships(), nowMs: this.now(), requestedRole: viewer.actor, state: await this.document(teamId, seasonId, "records"), acceptedMatches: rows.map((row) => ({ teamId, seasonId, match: JSON.parse(row.state_json) })), community: { accountId: principal.accountId, teamId, seasonId, audience: viewer.actor, playerId: viewer.playerId ?? null, revision: community.revision, view: { allowed: filtered.allowed, matches: filtered.matches, gallery: filtered.gallery } } };
  }
  async records(principal, teamId, seasonId, role) {
    return recordsServiceView(await this.recordsContext(principal, teamId, seasonId, role));
  }
  async recordsExport(principal, teamId, seasonId, request, role) {
    return recordsServiceExport({ ...await this.recordsContext(principal, teamId, seasonId, role), request });
  }
  async recordsCommand(principal, teamId, seasonId, command, role) {
    const state = applyRecordsServiceCommand({ ...await this.recordsContext(principal, teamId, seasonId, role), command });
    await this.saveDocument(teamId, seasonId, "records", state);
    await this.audit(principal, command.type, teamId, "accepted");
    return await this.records(principal, teamId, seasonId, "manager");
  }
};

// apps/api/src/postgres-media.ts
import { createHash as createHash12, randomBytes as randomBytes8, randomUUID as randomUUID9 } from "node:crypto";
import { chmodSync as chmodSync4, mkdirSync as mkdirSync4, readFileSync as readFileSync4 } from "node:fs";
import { open as open3, rename as rename3, unlink as unlink3 } from "node:fs/promises";
import { join as join4, resolve as resolve3, sep as sep4 } from "node:path";
import { performance as performance3 } from "node:perf_hooks";

// apps/api/src/postgres-security.ts
import { readFile as readFile4 } from "node:fs/promises";
async function install(database, name) {
  if (database.migrationMode !== "apply") throw new Error("Security migration requires the separate schema-owner migrator.");
  const sql = await readFile4(new URL(`../migrations/postgresql/005_${name}_security.sql`, import.meta.url), "utf8");
  await database.transaction(() => database.query(sql));
}
async function verify2(database, tables) {
  const result = await database.query(
    `SELECT c.relname,c.relrowsecurity,(SELECT count(*)::integer FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid) AS policies
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='longball' AND c.relname=ANY($1::text[])`,
    [tables]
  );
  if (result.rows.length !== tables.length || result.rows.some((row) => !row.relrowsecurity || row.policies < 2)) throw new Error("PostgreSQL feature row security is missing. Run the separate migrator before starting runtime.");
}
var installMediaSecurity = (database) => install(database, "media");
var installActivationSecurity = (database) => install(database, "activation");
var verifyMediaSecurity = async (database) => {
  await verify2(database, ["media_uploads"]);
  const policies = await database.query("SELECT policyname FROM pg_catalog.pg_policies WHERE schemaname='longball' AND policyname=ANY($1::text[])", [["media_team_privilege_insert", "media_team_privilege_link", "documents_player_media_insert", "documents_player_media_update"]]);
  if (policies.rows.length !== 4) throw new Error("Current media contribution row security is missing. Run the separate migrator.");
};
var verifyActivationSecurity = (database) => verify2(database, ["lb_activation_children", "lb_activation_issues", "lb_activation_tokens", "lb_activation_verification_requests"]);
async function installHeicMedia(database) {
  if (database.migrationMode !== "apply") throw new Error("Media migration requires the separate schema-owner migrator.");
  const sql = await readFile4(new URL("../migrations/postgresql/media_003_heic.sql", import.meta.url), "utf8");
  await database.transaction(() => database.query(sql));
}
async function installTeamPrivilegeMedia(database) {
  if (database.migrationMode !== "apply") throw new Error("Media migration requires the separate schema-owner migrator.");
  const sql = await readFile4(new URL("../migrations/postgresql/media_004_team_privileges.sql", import.meta.url), "utf8");
  await database.transaction(() => database.query(sql));
}

// apps/api/src/postgres-media.ts
var {
  hash: hash4,
  id: id7,
  auth: auth2,
  sameToken: sameToken2,
  bounded: bounded2
} = mediaInternals;
function fail7(code, status2, message) {
  return mediaInternals.fail(code, status2, message);
}
var PgMediaService = class _PgMediaService {
  directory;
  database;
  scanner;
  now;
  constructor(options2) {
    this.directory = resolve3(options2.directory);
    this.database = options2.database;
    this.scanner = options2.scanner;
    this.now = options2.now ?? Date.now;
    mkdirSync4(this.directory, { recursive: true, mode: 448 });
    chmodSync4(this.directory, 448);
    for (const name of ["quarantine", "derivatives"]) {
      mkdirSync4(join4(this.directory, name), { recursive: true, mode: 448 });
      chmodSync4(join4(this.directory, name), 448);
    }
  }
  static async open(options2) {
    const service = new _PgMediaService(options2);
    await service.initialize();
    return service;
  }
  async initialize() {
    if (this.database.migrationMode === "verify") {
      const versions = await this.database.query(
        "SELECT version FROM longball.media_schema_migrations ORDER BY version"
      );
      if (versions.rows.some((row) => row.version > 4)) throw new Error("Media schema is newer than this build.");
      if (![2, 3, 4].every((version) => versions.rows.some((row) => row.version === version))) throw new Error("Run the separate media migrator before starting the runtime.");
      await verifyMediaSecurity(this.database);
      return;
    }
    await this.database.transaction(async () => {
      await this.database.query(
        "CREATE TABLE IF NOT EXISTS longball.media_schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
      );
      const versions = await this.database.query(
        "SELECT version FROM longball.media_schema_migrations ORDER BY version"
      );
      if (versions.rows.some((row) => row.version > 4))
        throw new Error(
          "Media schema is newer than this build; preserve it and use a compatible version."
        );
      if (!versions.rows.some((row) => row.version === 1)) {
        await this.database.query(`CREATE TABLE longball.media_uploads(
          id text PRIMARY KEY,request_id text NOT NULL,request_signature text NOT NULL,owner_id text NOT NULL REFERENCES longball.accounts(id),team_id text NOT NULL REFERENCES longball.teams(id),season_id text NOT NULL,match_id text NOT NULL,
          photo_id text NOT NULL,source_revision integer,display_revision integer NOT NULL CHECK(display_revision>0),status text NOT NULL CHECK(status IN('prepared','uploading','uploaded','processing','processed','linked','rejected')),
          expected_bytes integer NOT NULL CHECK(expected_bytes BETWEEN 1 AND 15728640),expected_sha text NOT NULL CHECK(expected_sha ~ '^[0-9a-f]{64}$'),declared_mime text NOT NULL CHECK(declared_mime IN('image/jpeg','image/png')),
          caption text NOT NULL,token_hash text NOT NULL CHECK(token_hash ~ '^[0-9a-f]{64}$'),expires_at bigint NOT NULL,created_at bigint NOT NULL,
          original_key text,display_key text,thumbnail_key text,width integer,height integer,scanner_engine text,failure_code text,attempt text,lease_until bigint,
          UNIQUE(owner_id,request_id));
          CREATE UNIQUE INDEX media_linked_revision ON longball.media_uploads(photo_id,display_revision) WHERE status='linked';
          CREATE INDEX media_owner_scope ON longball.media_uploads(owner_id,team_id,season_id,created_at);
          INSERT INTO longball.media_schema_migrations(version) VALUES(1);`);
      }
      if (!versions.rows.some((row) => row.version === 2)) {
        await installMediaSecurity(this.database);
        await this.database.query("INSERT INTO longball.media_schema_migrations(version) VALUES(2)");
      }
      if (!versions.rows.some((row) => row.version === 3)) {
        await installHeicMedia(this.database);
        await this.database.query("INSERT INTO longball.media_schema_migrations(version) VALUES(3)");
      }
      if (!versions.rows.some((row) => row.version === 4)) {
        await installTeamPrivilegeMedia(this.database);
        await this.database.query("INSERT INTO longball.media_schema_migrations(version) VALUES(4)");
      }
    });
  }
  /** Injected connection lifecycle belongs to the API/store. */
  async close() {
  }
  async one(sql, values) {
    return (await this.database.query(sql, values)).rows[0];
  }
  async many(sql, values) {
    return (await this.database.query(sql, values)).rows;
  }
  async execute(sql, values) {
    return { changes: (await this.database.query(sql, values)).rowCount ?? 0 };
  }
  path(key) {
    const path = resolve3(this.directory, key);
    if (!path.startsWith(this.directory + sep4))
      fail7(
        "MEDIA_STORE_INVALID",
        503,
        "The private media object is unavailable."
      );
    return path;
  }
  async row(state, actor, uploadId, token) {
    auth2(state, actor, this.now(), true);
    if (!id7(uploadId))
      fail7("NOT_FOUND", 404, "The requested upload is unavailable.");
    const row = await this.one(
      "SELECT * FROM longball.media_uploads WHERE id=$1 AND owner_id=$2 AND team_id=$3 AND season_id=$4",
      [uploadId, actor.accountId, actor.teamId, actor.seasonId]
    );
    if (!row || token !== void 0 && !sameToken2(row.token_hash, token))
      fail7("NOT_FOUND", 404, "The requested upload is unavailable.");
    return row;
  }
  async prepare(state, actor, input) {
    return this.database.transaction(async () => {
      auth2(state, actor, this.now(), true);
      const allowedKeys = [
        "requestId",
        "matchId",
        "byteSize",
        "mimeType",
        "sha256",
        "caption",
        "policyAcknowledged",
        "photoId",
        "sourceRevision"
      ];
      if (!input || typeof input !== "object" || Object.keys(input).some((key) => !allowedKeys.includes(key)) || !id7(input.requestId) || !id7(input.matchId) || !Number.isSafeInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > MEDIA_LIMITS.maxBytes || !["image/jpeg", "image/png", "image/heic"].includes(input.mimeType) || typeof input.sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(input.sha256) || typeof input.caption !== "string" || input.caption.trim().length > 160 || input.policyAcknowledged !== true) {
        fail7(
          "INVALID_MEDIA_PREPARATION",
          422,
          "Use an original JPEG, PNG or supported still HEIC up to 15 MiB with a valid size, SHA-256 and policy acknowledgement."
        );
      }
      const match = state.matches.find(
        (item) => item.id === input.matchId && item.teamId === actor.teamId && item.seasonId === actor.seasonId
      );
      if (!match) fail7("NOT_FOUND", 404, "The requested match is unavailable.");
      const signature2 = hash4(
        JSON.stringify([
          input.matchId,
          input.byteSize,
          input.mimeType,
          input.sha256.toLowerCase(),
          input.caption.trim(),
          input.policyAcknowledged,
          input.photoId ?? null,
          input.sourceRevision ?? null
        ])
      );
      const existing = await this.one(
        "SELECT * FROM longball.media_uploads WHERE owner_id=$1 AND request_id=$2",
        [actor.accountId, input.requestId]
      );
      const token = randomBytes8(32).toString("base64url");
      if (existing) {
        if (existing.request_signature !== signature2 || existing.team_id !== actor.teamId || existing.season_id !== actor.seasonId)
          fail7(
            "IDEMPOTENCY_CONFLICT",
            409,
            "This upload request identity was already used for different content."
          );
        if (existing.expires_at <= this.now() && ["prepared", "uploading"].includes(existing.status))
          fail7(
            "UPLOAD_EXPIRED",
            410,
            "The upload window expired. Prepare a new upload without discarding the previous private record."
          );
        await this.execute(
          "UPDATE longball.media_uploads SET token_hash=$1 WHERE id=$2",
          [hash4(token), existing.id]
        );
        return {
          uploadId: existing.id,
          photoId: existing.photo_id,
          uploadToken: token,
          expiresAtMs: existing.expires_at,
          maxBytes: MEDIA_LIMITS.maxBytes,
          displayRevision: existing.display_revision
        };
      }
      let sourceRevision = null;
      let photoId = `media-${randomUUID9()}`;
      if (input.photoId !== void 0 || input.sourceRevision !== void 0) {
        const photo = state.photos.find(
          (item) => item.id === input.photoId && item.matchId === match.id && item.teamId === actor.teamId && item.seasonId === actor.seasonId && item.uploaderAccountId === actor.accountId && item.uploaderRole === actor.role && item.removedAtMs === null
        );
        if (!photo || !Number.isSafeInteger(input.sourceRevision) || photo.currentRevision !== input.sourceRevision)
          fail7(
            "MEDIA_REVISION_CONFLICT",
            409,
            "The photo changed. Review its current revision before replacing it."
          );
        sourceRevision = photo.currentRevision;
        photoId = photo.id;
      }
      const uploadId = randomUUID9();
      const expiresAtMs = this.now() + MEDIA_LIMITS.uploadWindowMs;
      await this.execute(
        "INSERT INTO longball.media_uploads(id,request_id,request_signature,owner_id,team_id,season_id,match_id,photo_id,source_revision,display_revision,status,expected_bytes,expected_sha,declared_mime,caption,token_hash,expires_at,created_at)\n      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'prepared',$11,$12,$13,$14,$15,$16,$17)",
        [
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
          hash4(token),
          expiresAtMs,
          this.now()
        ]
      );
      return {
        uploadId,
        photoId,
        uploadToken: token,
        expiresAtMs,
        maxBytes: MEDIA_LIMITS.maxBytes,
        displayRevision: (sourceRevision ?? 0) + 1
      };
    });
  }
  async upload(state, actor, uploadId, token, source2) {
    const row = await this.row(state, actor, uploadId, token);
    const duplicate = ["uploaded", "processed", "linked"].includes(row.status);
    if (!duplicate && row.expires_at <= this.now())
      fail7("UPLOAD_EXPIRED", 410, "The write-only upload window expired.");
    if (!duplicate && row.status !== "prepared" && !(row.status === "uploading" && (row.lease_until ?? 0) < this.now()))
      fail7(
        "UPLOAD_BUSY",
        409,
        "This upload is already running or cannot be changed."
      );
    const attempt2 = randomUUID9();
    const key = `quarantine/${row.id}-${attempt2}.upload`;
    const temporary = this.path(key + ".part");
    if (!duplicate) {
      const updated = await this.execute(
        "UPDATE longball.media_uploads SET status='uploading',attempt=$1,lease_until=$2,failure_code=NULL WHERE id=$3 AND (status='prepared' OR (status='uploading' AND lease_until<$4))",
        [attempt2, this.now() + 65e3, row.id, this.now()]
      );
      if (!updated.changes)
        fail7("UPLOAD_BUSY", 409, "This upload is already running.");
    }
    const destination = duplicate ? null : await open3(temporary, "wx", 384);
    const digest3 = createHash12("sha256");
    let received = 0;
    const began = performance3.now();
    const iterator = source2[Symbol.asyncIterator]();
    try {
      while (true) {
        const item = await bounded2(
          iterator.next(),
          MEDIA_LIMITS.uploadTimeoutMs - (performance3.now() - began),
          "UPLOAD_TIMEOUT"
        );
        if (item.done) break;
        const chunk = Buffer.from(item.value);
        received += chunk.length;
        if (received > row.expected_bytes || received > MEDIA_LIMITS.maxBytes)
          fail7(
            "UPLOAD_TOO_LARGE",
            413,
            "The image exceeds its declared upload size."
          );
        digest3.update(chunk);
        if (destination) await destination.writeFile(chunk);
      }
      if (received !== row.expected_bytes || digest3.digest("hex") !== row.expected_sha)
        fail7(
          "UPLOAD_INTEGRITY_FAILED",
          422,
          "The uploaded size or SHA-256 does not match. The private partial upload was not accepted."
        );
      if (destination) {
        await destination.sync();
        await destination.close();
        await rename3(temporary, this.path(key));
        const changed = await this.execute(
          "UPDATE longball.media_uploads SET status='uploaded',original_key=$1,lease_until=NULL,failure_code=NULL WHERE id=$2 AND attempt=$3 AND status='uploading'",
          [key, row.id, attempt2]
        );
        if (!changed.changes)
          fail7(
            "UPLOAD_LEASE_CHANGED",
            409,
            "The upload lease changed. The private branch is retained for review."
          );
      }
      return { uploadId, status: "uploaded", byteSize: received };
    } catch (error) {
      if (destination) {
        await destination.close().catch(() => void 0);
        await unlink3(temporary).catch(() => void 0);
      }
      if (!duplicate)
        await this.execute(
          "UPDATE longball.media_uploads SET status='prepared',failure_code='UPLOAD_INCOMPLETE',lease_until=NULL WHERE id=$1 AND attempt=$2 AND status='uploading'",
          [row.id, attempt2]
        );
      if (iterator.return)
        void Promise.resolve(iterator.return()).catch(() => void 0);
      throw error;
    }
  }
  completion(row) {
    const base = {
      id: `media-${row.id}-completed`,
      photoId: row.photo_id,
      art: "pitch",
      caption: row.caption,
      policyAcknowledged: true
    };
    const command = row.source_revision === null ? { ...base, type: "photo.submitted", matchId: row.match_id } : {
      ...base,
      type: "photo.revised",
      sourceRevision: row.source_revision
    };
    return {
      command,
      receipt: {
        uploadId: row.id,
        photoId: row.photo_id,
        status: "processed",
        width: row.width,
        height: row.height,
        displayRevision: row.display_revision
      }
    };
  }
  async complete(state, actor, uploadId, token) {
    const row = await this.row(state, actor, uploadId, token);
    if (row.status === "processed" || row.status === "linked")
      return this.completion(row);
    if (row.status !== "uploaded" && !(row.status === "processing" && (row.lease_until ?? 0) < this.now()))
      fail7(
        "UPLOAD_NOT_READY",
        409,
        "Finish the private upload before completion; an active processing lease cannot be duplicated."
      );
    if (!row.original_key)
      fail7("UPLOAD_NOT_READY", 409, "The private original is unavailable.");
    const attempt2 = randomUUID9();
    const leased = await this.execute(
      "UPDATE longball.media_uploads SET status='processing',attempt=$1,lease_until=$2,failure_code=NULL WHERE id=$3 AND (status='uploaded' OR (status='processing' AND lease_until<$4))",
      [attempt2, this.now() + 6e4, row.id, this.now()]
    );
    if (!leased.changes)
      fail7("UPLOAD_BUSY", 409, "This image is already processing.");
    try {
      const displayKey = `derivatives/${row.photo_id}-v${row.display_revision}-${attempt2}-display.jpg`;
      const thumbnailKey = `derivatives/${row.photo_id}-v${row.display_revision}-${attempt2}-thumbnail.jpg`;
      const decoded = await processPrivateImage({ originalPath: this.path(row.original_key), displayPath: this.path(displayKey), thumbnailPath: this.path(thumbnailKey), expectedBytes: row.expected_bytes, expectedSha: row.expected_sha, declaredMime: row.declared_mime, scanner: this.scanner });
      const saved = await this.execute(
        "UPDATE longball.media_uploads SET status='processed',display_key=$1,thumbnail_key=$2,width=$3,height=$4,scanner_engine=$5,failure_code=NULL,lease_until=NULL WHERE id=$6 AND attempt=$7 AND status='processing'",
        [
          displayKey,
          thumbnailKey,
          decoded.width,
          decoded.height,
          decoded.scannerEngine,
          row.id,
          attempt2
        ]
      );
      if (!saved.changes)
        fail7(
          "PROCESSING_LEASE_CHANGED",
          409,
          "The processing lease changed. No publication was performed."
        );
      return this.completion(await this.row(state, actor, uploadId));
    } catch (error) {
      const code = error instanceof AccessError ? error.code : "MEDIA_PROCESSING_FAILED";
      const retryable = [
        "SCANNER_REQUIRED",
        "HEIC_DECODER_REQUIRED",
        "SCANNER_UNAVAILABLE",
        "MEDIA_PROCESSING_FAILED"
      ].includes(code);
      await this.execute(
        "UPDATE longball.media_uploads SET status=$1,failure_code=$2,lease_until=NULL WHERE id=$3 AND attempt=$4 AND status='processing'",
        [retryable ? "uploaded" : "rejected", code, row.id, attempt2]
      );
      throw error instanceof AccessError ? error : new AccessError(
        "MEDIA_PROCESSING_FAILED",
        503,
        "Image processing is unavailable. No image was published."
      );
    }
  }
  async link(uploadId, state) {
    const row = await this.one(
      "SELECT * FROM longball.media_uploads WHERE id=$1",
      [uploadId]
    );
    if (!row || !["processed", "linked"].includes(row.status))
      fail7(
        "MEDIA_NOT_PROCESSED",
        409,
        "The image has not completed private processing."
      );
    if (state && !state.photos.some(
      (photo) => photo.id === row.photo_id && photo.teamId === row.team_id && photo.seasonId === row.season_id && photo.uploaderAccountId === row.owner_id && photo.revisions.some(
        (revision) => revision.version === row.display_revision
      )
    ))
      fail7(
        "MEDIA_LINK_CONFLICT",
        409,
        "The matching community revision was not committed."
      );
    const linked = await this.execute(
      "UPDATE longball.media_uploads SET status='linked' WHERE id=$1",
      [uploadId]
    );
    if (linked.changes !== 1) fail7("MEDIA_LINK_CONFLICT", 409, "The private processing authority changed. No community revision was committed.");
  }
  async gateway(state, actor, photoId, variant, mode = "gallery", revision) {
    if (!["display", "thumbnail"].includes(variant))
      fail7("NOT_FOUND", 404, "The media variant is unavailable.");
    const decision = authorizeCommunityMedia(
      state,
      actor,
      photoId,
      this.now(),
      mode,
      revision
    );
    if (!decision.allowed)
      fail7("NOT_FOUND", 404, "The requested image is unavailable.");
    const row = await this.one(
      "SELECT * FROM longball.media_uploads WHERE photo_id=$1 AND display_revision=$2 AND status='linked'",
      [photoId, decision.revision.version]
    );
    if (!row || row.team_id !== actor.teamId || row.season_id !== actor.seasonId)
      fail7("NOT_FOUND", 404, "The requested image is unavailable.");
    const key = variant === "display" ? row.display_key : row.thumbnail_key;
    if (!key) fail7("NOT_FOUND", 404, "The requested image is unavailable.");
    let body;
    try {
      body = readFileSync4(this.path(key));
    } catch {
      fail7("NOT_FOUND", 404, "The requested image is unavailable.");
    }
    return {
      body,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Length": String(body.length)
      }
    };
  }
  async listOwn(state, actor) {
    auth2(state, actor, this.now(), true);
    const rows = await this.many(
      "SELECT id,photo_id,status,expected_bytes,display_revision,width,height,failure_code,expires_at FROM longball.media_uploads WHERE owner_id=$1 AND team_id=$2 AND season_id=$3 ORDER BY created_at DESC LIMIT 100",
      [actor.accountId, actor.teamId, actor.seasonId]
    );
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

// apps/api/src/postgres-activation.ts
import { createHash as createHash13, randomBytes as randomBytes9, randomUUID as randomUUID10 } from "node:crypto";
var hash5 = (value) => createHash13("sha256").update(value).digest("hex");
var id8 = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(value);
var uuid2 = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function unavailable6() {
  throw new AccessError(
    "ACTIVATION_UNAVAILABLE",
    410,
    "This activation cannot be used. Request a new activation through the agreed household process."
  );
}
function invalid5() {
  throw new AccessError(
    "INVALID_REQUEST",
    400,
    "Use the documented activation request fields."
  );
}
function conflict3() {
  throw new AccessError(
    "REQUEST_CONFLICT",
    409,
    "The request identifier was already used for another operation."
  );
}
function fields6(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !names.includes(key)) || names.some((key) => !(key in value)))
    invalid5();
}
function fingerprint2(actor, input) {
  return hash5(
    JSON.stringify([
      actor,
      ...Object.entries(input).sort(
        ([left], [right]) => left.localeCompare(right)
      )
    ])
  );
}
function username2() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return `LB${Array.from(randomBytes9(12), (byte) => alphabet[byte & 31]).join("")}`;
}
var PostgresActivationService = class {
  async ownsActivationToken(token, activationId) {
    await this.ready;
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    return this.store.db.withContext({ kind: "activation_token", tokenHash: hash5(token), ...activationId ? { activationId } : {}, nowMs: this.store.now() }, async () => Boolean(await this.store.one("SELECT id FROM lb_activation_tokens WHERE token_hash=$1 AND ($2::text IS NULL OR id=$2)", [hash5(token), activationId ?? null])));
  }
  ready;
  async initialize() {
    await this.ready;
    return this;
  }
  configured;
  store;
  provider;
  policy;
  constructor(options2) {
    this.store = options2.store;
    this.provider = options2.provider;
    this.policy = options2.policy;
    if (options2.policy && (options2.policy.fictionalOnly !== true || !id8(options2.policy.version) || !Number.isSafeInteger(options2.policy.activationTtlMs) || options2.policy.activationTtlMs <= 0))
      throw new Error(
        "An explicit versioned fictional activation policy and positive expiry are required."
      );
    if (options2.provider) {
      const issuer2 = new URL(options2.provider.issuer);
      if (issuer2.protocol !== "https:" || issuer2.username || issuer2.password || issuer2.search || issuer2.hash || !options2.provider.credentialSetupOrigins.length)
        throw new Error(
          "Activation requires a configured HTTPS provider and credential origins."
        );
      for (const origin of options2.provider.credentialSetupOrigins) {
        const parsed = new URL(origin);
        if (parsed.protocol !== "https:" || parsed.origin !== origin)
          throw new Error(
            "Credential setup origins must be exact HTTPS origins."
          );
      }
    }
    this.configured = Boolean(options2.provider && options2.policy);
    this.ready = this.migrate();
  }
  async enabled() {
    if (!this.provider || !this.policy)
      throw new AccessError(
        "ACTIVATION_NOT_CONFIGURED",
        503,
        "Activation requires an explicitly configured provider flow and expiry policy."
      );
    return { provider: this.provider, policy: this.policy };
  }
  async migrate() {
    if (this.store.db.migrationMode === "verify") {
      const version = await this.store.one(
        "SELECT version FROM lb_activation_schema WHERE singleton=1"
      );
      if (!version || version.version !== 2)
        throw new Error(
          "Activation schema is missing or unsupported. Run the privileged migration command; preserve the database."
        );
      await verifyActivationSecurity(this.store.db);
      return;
    }
    await this.store.transaction(async () => {
      await this.store.db.query(
        "CREATE TABLE IF NOT EXISTS lb_activation_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL)"
      );
      const version = await this.store.one(
        "SELECT version FROM lb_activation_schema WHERE singleton=1",
        []
      );
      if (version && ![1, 2].includes(version.version))
        throw new Error(
          "Unsupported activation feature schema; preserve the database."
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
        "UPDATE lb_activation_schema SET version=2 WHERE singleton=1"
      );
    });
  }
  async manager(principal, teamId, seasonId) {
    const fresh = await this.store.principal({
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
      await this.store.memberships(),
      teamId,
      seasonId,
      this.store.now()
    );
  }
  async child(principal, accountId, teamId, seasonId) {
    await this.manager(principal, teamId, seasonId);
    const row = await this.store.one(
      "SELECT * FROM lb_activation_children WHERE account_id=$1 AND team_id=$2 AND season_id=$3",
      [accountId, teamId, seasonId]
    );
    if (!row)
      throw new AccessError(
        "NOT_FOUND",
        404,
        "The requested object is unavailable."
      );
    return row;
  }
  async receipt(child) {
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
  async withProvisionedAccount(accountId, work) {
    const current3 = this.store.db.applicationContext;
    return current3?.kind === "actor" ? this.store.db.withContext(
      { ...current3, provisionAccountId: accountId },
      work
    ) : work();
  }
  async createPendingChild(principal, input) {
    await this.ready;
    const { provider } = await this.enabled();
    fields6(input, ["requestId", "teamId", "seasonId", "playerId"]);
    if (![input.requestId, input.teamId, input.seasonId, input.playerId].every(id8))
      invalid5();
    const signature2 = fingerprint2(principal.accountId, input);
    const candidateAccountId = randomUUID10();
    const row = await this.withProvisionedAccount(
      candidateAccountId,
      () => this.store.transaction(async () => {
        await this.manager(principal, input.teamId, input.seasonId);
        const existing = await this.store.one(
          "SELECT * FROM lb_activation_children WHERE request_id=$1",
          [input.requestId]
        );
        if (existing) {
          if (existing.request_signature !== signature2) conflict3();
          return existing;
        }
        const profile = (await this.store.preparation(principal, input.teamId, input.seasonId)).profiles.find(
          (item) => item.playerId === input.playerId && item.seasonId === input.seasonId && item.active
        );
        if (!profile)
          throw new AccessError(
            "NOT_FOUND",
            404,
            "The requested object is unavailable."
          );
        if ((await this.store.memberships()).some(
          (item) => item.teamId === input.teamId && item.seasonId === input.seasonId && item.playerId === input.playerId && item.role === "player" && item.revokedAt == null
        ))
          throw new AccessError(
            "PLAYER_ACCOUNT_EXISTS",
            409,
            "This player already has an account assignment. Use the verified exact-account linking process."
          );
        const accountId = candidateAccountId;
        let chosen = username2();
        for (let tries = 0; await this.store.one(
          "SELECT 1 FROM lb_activation_children WHERE lower(username)=lower($1)",
          [chosen]
        ); tries++) {
          if (tries >= 10)
            throw new AccessError(
              "IDENTITY_ALLOCATION_UNAVAILABLE",
              503,
              "A unique username could not be allocated."
            );
          chosen = username2();
        }
        await this.store.execute(
          "INSERT INTO accounts(id,issuer,subject,classification,adult_verified,strong_auth_enrolled,status) VALUES($1,$2,$3,$4,0,0,$5)",
          [
            accountId,
            "urn:longball:pending-activation",
            accountId,
            "child_shared",
            "disabled"
          ]
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
            signature2,
            principal.accountId,
            this.store.now()
          ]
        );
        await this.store.execute(
          "INSERT INTO memberships(account_id,team_id,season_id,role,player_id) VALUES($1,$2,$3,'player',$4)",
          [accountId, input.teamId, input.seasonId, input.playerId]
        );
        await this.store.audit(
          principal,
          "identity.child_reserved",
          accountId,
          "pending_provider"
        );
        return await this.child(
          principal,
          accountId,
          input.teamId,
          input.seasonId
        );
      })
    );
    if (row.state !== "provisioning") return await this.receipt(row);
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
    return await this.withProvisionedAccount(
      row.account_id,
      () => this.store.transaction(async () => {
        const fresh = await this.child(
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
          return await this.receipt(fresh);
        }
        const binding2 = await this.store.one(
          "SELECT id FROM accounts WHERE issuer=$1 AND subject=$2 AND id!=$3",
          [result.issuer, result.subject, row.account_id]
        );
        if (binding2)
          throw new AccessError(
            "PROVIDER_BINDING_REJECTED",
            409,
            "The provider identity requires reconciliation."
          );
        await this.store.execute(
          "UPDATE accounts SET issuer=$1,subject=$2 WHERE id=$3 AND status='disabled'",
          [result.issuer, result.subject, row.account_id]
        );
        await this.store.execute(
          "UPDATE lb_activation_children SET provider_issuer=$1,provider_subject=$2,state='pending_activation' WHERE account_id=$3",
          [result.issuer, result.subject, row.account_id]
        );
        await this.store.audit(
          principal,
          "identity.child_provisioned",
          row.account_id,
          "pending_activation"
        );
        return await this.receipt(
          await this.child(
            principal,
            row.account_id,
            input.teamId,
            input.seasonId
          )
        );
      })
    ).catch((error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "23505") {
        throw new AccessError(
          "PROVIDER_BINDING_REJECTED",
          409,
          "The provider identity requires reconciliation."
        );
      }
      throw error;
    });
  }
  async issueActivation(principal, input) {
    await this.ready;
    const { provider, policy } = await this.enabled();
    fields6(input, ["requestId", "teamId", "seasonId", "accountId"]);
    if (![input.requestId, input.teamId, input.seasonId].every(id8) || !uuid2(input.accountId))
      invalid5();
    const signature2 = fingerprint2(principal.accountId, input);
    const preparation = await this.store.transaction(async () => {
      const child = await this.child(
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
      let issue = await this.store.one(
        "SELECT * FROM lb_activation_issues WHERE request_id=$1",
        [input.requestId]
      );
      if (issue && issue.signature !== signature2) conflict3();
      if (issue?.state === "issued")
        throw new AccessError(
          "ACTIVATION_ALREADY_ISSUED",
          409,
          "The secret was issued once and cannot be retrieved. Explicitly reissue using a new request identifier."
        );
      if (!issue) {
        const generation = child.activation_generation + 1;
        await this.store.execute(
          "UPDATE lb_activation_children SET activation_generation=$1 WHERE account_id=$2",
          [generation, child.account_id]
        );
        await this.store.execute(
          "INSERT INTO lb_activation_issues(request_id,account_id,signature,generation,state,created_at) VALUES($1,$2,$3,$4,'preparing',$5)",
          [
            input.requestId,
            child.account_id,
            signature2,
            generation,
            this.store.now()
          ]
        );
        await this.store.execute(
          "UPDATE lb_activation_tokens SET state='revoked' WHERE account_id=$1 AND state IN ('issued','redeeming')",
          [child.account_id]
        );
        issue = {
          request_id: input.requestId,
          signature: signature2,
          generation,
          state: "preparing"
        };
      }
      const obsolete = await this.store.many(
        "SELECT * FROM lb_activation_tokens WHERE account_id=$1 AND state='revoked' AND redemption_id IS NOT NULL AND cancelled_at IS NULL",
        [child.account_id]
      );
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
      await this.store.transaction(
        async () => await this.store.execute(
          "UPDATE lb_activation_tokens SET cancelled_at=$1 WHERE id=$2 AND state='revoked'",
          [this.store.now(), old.id]
        )
      );
    }
    return await this.store.transaction(async () => {
      const child = await this.child(
        principal,
        input.accountId,
        input.teamId,
        input.seasonId
      );
      const issue = await this.store.one(
        "SELECT * FROM lb_activation_issues WHERE request_id=$1",
        [input.requestId]
      );
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
      const token = randomBytes9(32).toString("base64url");
      const activationId = randomUUID10();
      const expiresAt = this.store.now() + policy.activationTtlMs;
      if (!Number.isSafeInteger(expiresAt))
        throw new AccessError(
          "ACTIVATION_POLICY_INVALID",
          503,
          "The configured expiry is outside the supported range."
        );
      await this.store.execute(
        "INSERT INTO lb_activation_tokens(id,account_id,token_hash,issue_request_id,issued_by,expires_at,created_at,policy_version,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'issued')",
        [
          activationId,
          child.account_id,
          hash5(token),
          input.requestId,
          principal.accountId,
          expiresAt,
          this.store.now(),
          policy.version
        ]
      );
      await this.store.execute(
        "UPDATE lb_activation_issues SET state='issued' WHERE request_id=$1",
        [input.requestId]
      );
      await this.store.audit(
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
    await this.ready;
    fields6(input, ["token", "requestId"]);
    if (typeof input.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.token) || !id8(input.requestId))
      unavailable6();
    return this.store.db.withContext(
      {
        kind: "activation_token",
        tokenHash: hash5(input.token),
        nowMs: this.store.now()
      },
      () => this.redeemWithCapability(input)
    );
  }
  async redeemWithCapability(input) {
    await this.ready;
    const { provider } = await this.enabled();
    fields6(input, ["token", "requestId"]);
    if (typeof input.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.token) || !id8(input.requestId))
      unavailable6();
    const reserved = await this.store.transaction(async () => {
      const token = await this.store.one(
        "SELECT * FROM lb_activation_tokens WHERE token_hash=$1",
        [hash5(input.token)]
      );
      if (!token || token.expires_at <= this.store.now() || token.state === "revoked" || token.state === "completed" || token.state === "redeeming" && token.redemption_id !== input.requestId)
        unavailable6();
      const child = await this.store.one(
        "SELECT * FROM lb_activation_children WHERE account_id=$1",
        [token.account_id]
      );
      if (child.state !== "pending_activation" || !child.provider_issuer || !child.provider_subject)
        unavailable6();
      await this.store.execute(
        "UPDATE lb_activation_tokens SET state='redeeming',redemption_id=$1 WHERE id=$2",
        [input.requestId, token.id]
      );
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
    if (setup.protocol !== "https:" || setup.username || setup.password || !provider.credentialSetupOrigins.includes(setup.origin) || result.setupUrl.includes(input.token) || !id8(result.flowId) || !Number.isSafeInteger(result.expiresAt) || result.expiresAt > reserved.token.expires_at || result.expiresAt <= this.store.now())
      throw new AccessError(
        "PROVIDER_FLOW_REJECTED",
        502,
        "The provider credential flow could not be safely opened."
      );
    return await this.store.transaction(async () => {
      const fresh = await this.store.one(
        "SELECT * FROM lb_activation_tokens WHERE id=$1",
        [reserved.token.id]
      );
      if (fresh.state !== "redeeming" || fresh.redemption_id !== input.requestId || fresh.expires_at <= this.store.now() || fresh.flow_id && fresh.flow_id !== result.flowId)
        unavailable6();
      await this.store.execute(
        "UPDATE lb_activation_tokens SET flow_id=$1,flow_expires_at=$2 WHERE id=$3",
        [result.flowId, result.expiresAt, fresh.id]
      );
      return {
        activationId: fresh.id,
        providerSetupUrl: setup.href,
        expiresAt: result.expiresAt,
        status: "provider_credential_setup_required"
      };
    });
  }
  async completeActivation(input) {
    await this.ready;
    fields6(input, ["activationId", "token", "completionProof"]);
    if (!uuid2(input.activationId) || typeof input.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.token) || typeof input.completionProof !== "string" || !input.completionProof || input.completionProof.length > 16384)
      unavailable6();
    return this.store.db.withContext(
      {
        kind: "activation_token",
        tokenHash: hash5(input.token),
        activationId: input.activationId,
        nowMs: this.store.now()
      },
      () => this.completeWithCapability(input)
    );
  }
  async completeWithCapability(input) {
    await this.ready;
    const { provider } = await this.enabled();
    fields6(input, ["activationId", "token", "completionProof"]);
    if (!uuid2(input.activationId) || typeof input.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.token) || typeof input.completionProof !== "string" || !input.completionProof || input.completionProof.length > 16384)
      unavailable6();
    const token = await this.store.one(
      "SELECT * FROM lb_activation_tokens WHERE id=$1 AND token_hash=$2",
      [input.activationId, hash5(input.token)]
    );
    if (!token || !["redeeming", "completed"].includes(token.state) || !token.flow_id || !token.flow_expires_at || token.flow_expires_at <= this.store.now())
      unavailable6();
    const child = await this.store.one(
      "SELECT * FROM lb_activation_children WHERE account_id=$1",
      [token.account_id]
    );
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
      unavailable6();
    return await this.store.db.withContext(
      {
        kind: "activation_token",
        tokenHash: hash5(input.token),
        activationId: input.activationId,
        nowMs: this.store.now(),
        completionVerified: true
      },
      async () => {
        return await this.store.transaction(async () => {
          const fresh = await this.store.one(
            "SELECT * FROM lb_activation_tokens WHERE id=$1",
            [token.id]
          );
          if (!["redeeming", "completed"].includes(fresh.state) || fresh.flow_expires_at <= this.store.now())
            unavailable6();
          const account3 = await this.store.one(
            "SELECT classification,status FROM accounts WHERE id=$1",
            [child.account_id]
          );
          if (account3.classification !== "child_shared") unavailable6();
          if (fresh.state === "completed") {
            if (account3.status !== "active") unavailable6();
            return { status: "complete", signInRequired: true };
          }
          if (account3.status !== "disabled") unavailable6();
          await this.store.execute(
            "UPDATE accounts SET status='active' WHERE id=$1 AND classification='child_shared'",
            [child.account_id]
          );
          await this.store.execute(
            "UPDATE lb_activation_children SET state='active' WHERE account_id=$1",
            [child.account_id]
          );
          await this.store.execute(
            "UPDATE lb_activation_tokens SET state='completed',completed_at=$1 WHERE id=$2",
            [this.store.now(), token.id]
          );
          await this.store.execute(
            "INSERT INTO audit(id,actor_id,action,object_id,outcome,created_at,club_id,team_id,season_id,context_operation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
            [
              randomUUID10(),
              child.account_id,
              "identity.activation_completed",
              child.account_id,
              "provider_verified_sign_in_required",
              this.store.now(),
              child.club_id,
              child.team_id,
              child.season_id,
              "activation.complete"
            ]
          );
          return { status: "complete", signInRequired: true };
        });
      }
    );
  }
  async requestExistingAccountLink(principal, input) {
    await this.ready;
    fields6(input, [
      "requestId",
      "teamId",
      "seasonId",
      "playerId",
      "existingAccountId"
    ]);
    if (!id8(input.playerId) || !uuid2(input.existingAccountId)) invalid5();
    return await this.verificationRequest(
      principal,
      "link",
      input,
      input.existingAccountId,
      input.playerId
    );
  }
  async requestRecovery(principal, input) {
    await this.ready;
    fields6(input, ["requestId", "teamId", "seasonId", "accountId"]);
    if (!uuid2(input.accountId)) invalid5();
    return await this.verificationRequest(
      principal,
      "recovery",
      input,
      input.accountId,
      null
    );
  }
  async verificationRequest(principal, kind2, input, target, playerId) {
    const { policy } = await this.enabled();
    if (![input.requestId, input.teamId, input.seasonId].every(id8)) invalid5();
    const signature2 = fingerprint2(principal.accountId, { ...input, kind: kind2 });
    return await this.store.transaction(async () => {
      await this.manager(principal, input.teamId, input.seasonId);
      if (playerId && !(await this.store.preparation(principal, input.teamId, input.seasonId)).profiles.some(
        (item) => item.playerId === playerId && item.seasonId === input.seasonId && item.active
      ))
        throw new AccessError(
          "NOT_FOUND",
          404,
          "The requested object is unavailable."
        );
      const previous = await this.store.one(
        "SELECT signature FROM lb_activation_verification_requests WHERE request_id=$1",
        [input.requestId]
      );
      if (previous && previous.signature !== signature2) conflict3();
      if (!previous) {
        await this.store.execute(
          "INSERT INTO lb_activation_verification_requests(request_id,kind,actor_id,team_id,season_id,player_id,target_account_id,signature,status,policy_version,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [
            input.requestId,
            kind2,
            principal.accountId,
            input.teamId,
            input.seasonId,
            playerId,
            target,
            signature2,
            "pending_independent_verification",
            policy.version,
            this.store.now()
          ]
        );
        await this.store.audit(
          principal,
          `identity.${kind2}_requested`,
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

// apps/api/src/postgres-brand-repository.ts
var PostgresBrandRepository = class {
  constructor(database) {
    this.database = database;
  }
  database;
  transaction(work) {
    return this.database.transaction(work);
  }
  async ensureScope(_authority) {
  }
  async one(sql, values) {
    return (await this.database.query(sql, values)).rows[0];
  }
  async byRequest(owner, request) {
    return this.one("SELECT * FROM brand_assets WHERE owner_id=$1 AND request_id=$2", [owner, request]);
  }
  async upload(id9) {
    return this.one("SELECT * FROM brand_assets WHERE id=$1", [id9]);
  }
  async asset(id9, revision) {
    return this.one("SELECT * FROM brand_assets WHERE asset_id=$1 AND revision=$2", [id9, revision]);
  }
  async own(owner, club, team) {
    return (await this.database.query("SELECT * FROM brand_assets WHERE owner_id=$1 AND club_id=$2 AND(team_id IS NULL OR team_id=$3) ORDER BY created_at DESC,id", [owner, club, team])).rows;
  }
  async create(row) {
    await this.database.query("INSERT INTO brand_assets(id,asset_id,revision,kind,club_id,team_id,owner_id,request_id,request_signature,status,expected_bytes,expected_sha,declared_mime,token_hash,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)", [row.id, row.asset_id, row.revision, row.kind, row.club_id, row.team_id, row.owner_id, row.request_id, row.request_signature, row.status, row.expected_bytes, row.expected_sha, row.declared_mime, row.token_hash, row.expires_at, row.created_at]);
  }
  async rotateToken(id9, hash6) {
    return (await this.database.query("UPDATE brand_assets SET token_hash=$1 WHERE id=$2", [hash6, id9])).rowCount === 1;
  }
  async lease(id9, stage, attempt2, now) {
    return (await this.database.query("UPDATE brand_assets SET status=$1,attempt=$2,lease_until=$3,failure_code=NULL WHERE id=$4 AND(status=$5 OR(status=$1 AND lease_until<$6))", [stage, attempt2, now + 65e3, id9, stage === "uploading" ? "prepared" : "uploaded", now])).rowCount === 1;
  }
  async uploaded(id9, attempt2, key) {
    return (await this.database.query("UPDATE brand_assets SET status='uploaded',original_key=$1,lease_until=NULL,failure_code=NULL WHERE id=$2 AND attempt=$3 AND status='uploading'", [key, id9, attempt2])).rowCount === 1;
  }
  async processed(id9, attempt2, value) {
    return (await this.database.query("UPDATE brand_assets SET status='processed',display_key=$1,thumbnail_key=$2,width=$3,height=$4,scanner_engine=$5,processed_at=$6,lease_until=NULL,failure_code=NULL WHERE id=$7 AND attempt=$8 AND status='processing'", [value.displayKey, value.thumbnailKey, value.width, value.height, value.scannerEngine, value.at, id9, attempt2])).rowCount === 1;
  }
  async failed(id9, attempt2, stage, code, retryable) {
    await this.database.query("UPDATE brand_assets SET status=$1,failure_code=$2,lease_until=NULL WHERE id=$3 AND attempt=$4 AND status=$5", [retryable ? stage === "uploading" ? "prepared" : "uploaded" : "rejected", code, id9, attempt2, stage]);
  }
  async slot(kind2, club, team) {
    const row = (await this.database.query("SELECT * FROM brand_slots WHERE kind=$1 AND club_id=$2 AND team_id IS NOT DISTINCT FROM $3", [kind2, club, team])).rows[0];
    return row ? mapBrandSlot(row) : void 0;
  }
  async setSlot(slot, expected) {
    await this.database.query("INSERT INTO brand_slots(kind,club_id,team_id,version) VALUES($1,$2,$3,0) ON CONFLICT DO NOTHING", [slot.kind, slot.clubId, slot.teamId]);
    return (await this.database.query("UPDATE brand_slots SET version=$1,asset_id=$2,asset_revision=$3,reviewed_revision=$4,policy_version=$5,confirmed_by=$6,confirmed_at=$7 WHERE kind=$8 AND club_id=$9 AND team_id IS NOT DISTINCT FROM $10 AND version=$11", [slot.version, slot.assetId, slot.assetRevision, slot.reviewedRevision, slot.policyVersion, slot.confirmedBy, slot.confirmedAt, slot.kind, slot.clubId, slot.teamId, expected])).rowCount === 1;
  }
  async linked(id9) {
    if ((await this.database.query("UPDATE brand_assets SET status='linked' WHERE id=$1 AND status IN('processed','linked')", [id9])).rowCount !== 1) throw new Error("BRAND_LINK_CONFLICT");
  }
};

// apps/api/src/spectator-activation.ts
import { createHash as createHash14, randomBytes as randomBytes10, randomUUID as randomUUID11 } from "node:crypto";
var opaque6 = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(v);
var uuid3 = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
function unavailable7() {
  throw new AccessError(
    "ACTIVATION_UNAVAILABLE",
    410,
    "This invitation cannot be activated. Ask its issuer for a current invitation or sign in with an existing account."
  );
}
function spectatorInvitationHash(token) {
  try {
    return createHash14("sha256").update(invitationTokenHashInput(token)).digest("hex");
  } catch {
    return unavailable7();
  }
}
function username3() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return `LB${Array.from(randomBytes10(12), (byte) => alphabet[byte & 31]).join("")}`;
}
var SpectatorActivationService = class {
  constructor(options2) {
    this.options = options2;
    const { provider, policy } = options2;
    if (policy && (!opaque6(policy.version) || policy.fictionalOnly !== true || !Number.isSafeInteger(policy.activationTtlMs) || policy.activationTtlMs <= 0))
      throw new Error(
        "Configure an explicit versioned fictional activation policy and positive lifetime."
      );
    if (provider) {
      const issuer2 = new URL(provider.issuer);
      if (issuer2.protocol !== "https:" || issuer2.username || issuer2.password || issuer2.hash || issuer2.search || !provider.credentialSetupOrigins.length || provider.credentialSetupOrigins.some((origin) => {
        const url = new URL(origin);
        return url.protocol !== "https:" || url.origin !== origin;
      }))
        throw new Error("Configure exact trusted HTTPS credential origins.");
    }
    this.configured = Boolean(provider && policy);
  }
  options;
  configured;
  now() {
    return (this.options.now ?? Date.now)();
  }
  enabled() {
    if (!this.options.provider || !this.options.policy)
      throw new AccessError(
        "ACTIVATION_NOT_CONFIGURED",
        503,
        "Invitation activation requires an explicitly configured provider and policy."
      );
    return { provider: this.options.provider, policy: this.options.policy };
  }
  async available(hash6) {
    const invitation = await this.options.repository.invitation(hash6);
    if (!invitation || invitation.expiresAt <= this.now() || invitation.policyVersion !== this.enabled().policy.version)
      unavailable7();
    return invitation;
  }
  async preflight(input) {
    this.enabled();
    const tokenHash = spectatorInvitationHash(input.token);
    return this.options.repository.withCapability(
      { tokenHash, nowMs: this.now() },
      async () => {
        const invitation = await this.available(tokenHash);
        return {
          invitationId: invitation.id,
          expiresAt: new Date(invitation.expiresAt).toISOString(),
          policyVersion: invitation.policyVersion
        };
      }
    );
  }
  async ownsActivationToken(token, activationId) {
    if (!this.configured || !uuid3(activationId)) return false;
    let tokenHash;
    try {
      tokenHash = spectatorInvitationHash(token);
    } catch {
      return false;
    }
    return this.options.repository.withCapability(
      { tokenHash, activationId, nowMs: this.now() },
      async () => Boolean(
        await this.options.repository.findAttempt(tokenHash, activationId)
      )
    );
  }
  async activate(input) {
    const { provider, policy } = this.enabled();
    if (!opaque6(input.deviceId) || !opaque6(input.requestId) || input.policyVersion !== policy.version)
      unavailable7();
    const tokenHash = spectatorInvitationHash(input.token), candidateId = randomUUID11();
    const signature2 = createHash14("sha256").update(JSON.stringify([input.deviceId, input.policyVersion])).digest("hex");
    let account3 = await this.options.repository.withCapability(
      { tokenHash, provisionAccountId: candidateId, nowMs: this.now() },
      async () => this.options.repository.reserveAccount({
        invitation: await this.available(tokenHash),
        tokenHash,
        accountId: candidateId,
        username: username3(),
        requestId: input.requestId,
        signature: signature2,
        nowMs: this.now()
      })
    );
    if (account3.state === "active") unavailable7();
    if (!account3.issuer || !account3.subject) {
      const provision = await this.providerCall(
        () => provider.provisionPending({
          operationId: `pending:${account3.accountId}`,
          accountId: account3.accountId,
          username: account3.username,
          classification: "unclassified",
          emailRequired: false
        })
      );
      if (provision.issuer !== provider.issuer || provision.username.toLowerCase() !== account3.username.toLowerCase() || !provision.subject || provision.pending !== true || provision.credentialConfigured !== false)
        unavailable7();
      account3 = await this.options.repository.withCapability(
        { tokenHash, provisionAccountId: account3.accountId, nowMs: this.now() },
        async () => {
          await this.available(tokenHash);
          return this.options.repository.bindProvider(
            account3.accountId,
            provision.issuer,
            provision.subject
          );
        }
      );
    }
    const attempt2 = await this.options.repository.withCapability(
      { tokenHash, nowMs: this.now() },
      async () => {
        const invitation = await this.available(tokenHash);
        return this.options.repository.reserveAttempt({
          accountId: account3.accountId,
          id: randomUUID11(),
          requestId: input.requestId,
          signature: signature2,
          deviceId: input.deviceId,
          expiresAt: Math.min(
            invitation.expiresAt,
            this.now() + policy.activationTtlMs
          ),
          nowMs: this.now()
        });
      }
    );
    const flow = await this.providerCall(
      () => provider.beginCredentialSetup({
        operationId: `activation:${attempt2.id}`,
        accountId: account3.accountId,
        issuer: account3.issuer,
        subject: account3.subject,
        username: account3.username,
        expiresAt: attempt2.expiresAt
      })
    );
    const url = new URL(flow.setupUrl);
    if (!provider.credentialSetupOrigins.includes(url.origin) || url.protocol !== "https:" || url.username || url.password || url.hash || !url.pathname.includes("/login-actions/") || flow.flowId !== attempt2.id || !Number.isSafeInteger(flow.expiresAt) || flow.expiresAt > attempt2.expiresAt || flow.expiresAt <= this.now())
      unavailable7();
    const bound = await this.options.repository.withCapability(
      { tokenHash, activationId: attempt2.id, nowMs: this.now() },
      async () => {
        await this.available(tokenHash);
        return this.options.repository.bindFlow(
          attempt2.id,
          flow.flowId,
          flow.expiresAt
        );
      }
    );
    url.hash = new URLSearchParams({
      longballActivation: attempt2.id
    }).toString();
    return {
      accountId: account3.accountId,
      username: account3.username,
      identityActionUrl: url.href,
      expiresAt: new Date(bound.expiresAt).toISOString()
    };
  }
  async completeActivation(input) {
    const { provider } = this.enabled();
    if (!uuid3(input.activationId) || typeof input.completionProof !== "string" || input.completionProof.length < 32 || input.completionProof.length > 16384)
      unavailable7();
    const tokenHash = spectatorInvitationHash(input.token);
    const source2 = await this.options.repository.withCapability(
      { tokenHash, activationId: input.activationId, nowMs: this.now() },
      async () => {
        await this.available(tokenHash);
        const found = await this.options.repository.findAttempt(
          tokenHash,
          input.activationId
        );
        if (!found || !["pending_activation", "completed"].includes(found.attempt.state) || !found.attempt.flowId || found.attempt.expiresAt <= this.now() || !found.account.issuer || !found.account.subject)
          unavailable7();
        return found;
      }
    );
    const { account: account3, attempt: attempt2 } = source2;
    const proof = await this.providerCall(
      () => provider.verifyCredentialSetup({
        operationId: `activation:${attempt2.id}`,
        flowId: attempt2.flowId,
        issuer: account3.issuer,
        subject: account3.subject,
        completionProof: input.completionProof
      })
    );
    if (proof.issuer !== account3.issuer || proof.subject !== account3.subject || proof.flowId !== attempt2.flowId || proof.credentialConfigured !== true || proof.recoveryMaterialIssued !== true || !Number.isSafeInteger(proof.completedAt) || proof.completedAt < attempt2.createdAt || proof.completedAt >= attempt2.expiresAt || proof.completedAt > this.now() + 3e4)
      unavailable7();
    await this.options.repository.withCapability(
      {
        tokenHash,
        activationId: attempt2.id,
        completionVerified: true,
        nowMs: this.now()
      },
      async () => {
        const invitation = await this.available(tokenHash);
        await this.options.repository.complete({
          tokenHash,
          invitation,
          account: account3,
          attempt: attempt2,
          nowMs: this.now()
        });
      }
    );
    return { status: "complete", signInRequired: true };
  }
  async providerCall(work) {
    try {
      return await work();
    } catch {
      throw new AccessError(
        "PROVIDER_FLOW_UNAVAILABLE",
        503,
        "Provider activation is incomplete. Retain this invitation and retry; no membership was granted."
      );
    }
  }
};

// apps/api/src/postgres-spectator-activation.ts
import { randomUUID as randomUUID12 } from "node:crypto";
function refused() {
  throw new AccessError(
    "ACTIVATION_UNAVAILABLE",
    410,
    "This invitation activation is unavailable. No membership was granted."
  );
}
function account2(row) {
  return {
    accountId: String(row.account_id),
    invitationId: String(row.invitation_id),
    username: String(row.username),
    state: row.state,
    issuer: row.provider_issuer,
    subject: row.provider_subject
  };
}
function attempt(row) {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    deviceId: String(row.device_id),
    flowId: row.flow_id,
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
    state: row.state
  };
}
var PostgresSpectatorActivationRepository = class {
  constructor(store) {
    this.store = store;
  }
  store;
  withCapability(input, work) {
    return this.store.db.withContext(
      { kind: "invitation_activation", ...input },
      work
    );
  }
  async invitation(tokenHash) {
    const row = await this.store.one("SELECT * FROM invitation_preflight($1)", [
      tokenHash
    ]);
    return row ? {
      id: String(row.id),
      clubId: String(row.club_id),
      teamId: String(row.team_id),
      seasonId: String(row.season_id),
      expiresAt: Number(row.expires_at),
      policyVersion: String(row.policy_version)
    } : null;
  }
  async reserveAccount(input) {
    return this.store.transaction(async () => {
      const invitation = await this.store.one(
        "SELECT id FROM spectator_invitations WHERE id=$1 AND token_hash=$2 FOR UPDATE",
        [input.invitation.id, input.tokenHash]
      );
      if (!invitation) refused();
      const existing = await this.store.one(
        "SELECT * FROM lb_spectator_activation_accounts WHERE invitation_id=$1",
        [input.invitation.id]
      );
      if (existing) return account2(existing);
      await this.store.execute(
        "INSERT INTO accounts(id,issuer,subject,classification,adult_verified,strong_auth_enrolled,status) VALUES($1,'urn:longball:pending-activation',$1,'unclassified',0,0,'disabled')",
        [input.accountId]
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
          input.nowMs
        ]
      );
      const row = await this.store.one(
        "SELECT * FROM lb_spectator_activation_accounts WHERE account_id=$1",
        [input.accountId]
      );
      if (!row) refused();
      return account2(row);
    });
  }
  async bindProvider(accountId, issuer2, subject) {
    return this.store.transaction(async () => {
      const row = await this.store.one(
        "SELECT * FROM lb_spectator_activation_accounts WHERE account_id=$1 FOR UPDATE",
        [accountId]
      );
      if (!row || row.state === "active") refused();
      if (row.provider_subject && (row.provider_subject !== subject || row.provider_issuer !== issuer2))
        refused();
      await this.store.execute(
        "UPDATE accounts SET issuer=$1,subject=$2 WHERE id=$3 AND classification='unclassified' AND status='disabled'",
        [issuer2, subject, accountId]
      );
      await this.store.execute(
        "UPDATE lb_spectator_activation_accounts SET provider_issuer=$1,provider_subject=$2,state='pending_activation' WHERE account_id=$3",
        [issuer2, subject, accountId]
      );
      return account2({
        ...row,
        provider_issuer: issuer2,
        provider_subject: subject,
        state: "pending_activation"
      });
    });
  }
  async reserveAttempt(input) {
    return this.store.transaction(async () => {
      const owner = await this.store.one(
        "SELECT * FROM lb_spectator_activation_accounts WHERE account_id=$1 FOR UPDATE",
        [input.accountId]
      );
      if (!owner || owner.state !== "pending_activation") refused();
      const existing = await this.store.one(
        "SELECT * FROM lb_spectator_activation_attempts WHERE account_id=$1 AND state IN('provisioning','pending_activation')",
        [input.accountId]
      );
      if (existing) {
        if (Number(existing.expires_at) <= input.nowMs || existing.device_id !== input.deviceId || existing.request_signature !== input.signature)
          refused();
        return attempt(existing);
      }
      const generation = Number(
        (await this.store.one(
          "SELECT COALESCE(MAX(generation),0)+1 AS next FROM lb_spectator_activation_attempts WHERE account_id=$1",
          [input.accountId]
        ))?.next ?? 1
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
          generation
        ]
      );
      return {
        id: input.id,
        accountId: input.accountId,
        deviceId: input.deviceId,
        flowId: null,
        expiresAt: input.expiresAt,
        createdAt: input.nowMs,
        state: "provisioning"
      };
    });
  }
  async bindFlow(attemptId, flowId, expiresAt) {
    return this.store.transaction(async () => {
      const row = await this.store.one(
        "SELECT * FROM lb_spectator_activation_attempts WHERE id=$1 FOR UPDATE",
        [attemptId]
      );
      if (!row || !["provisioning", "pending_activation"].includes(String(row.state)) || expiresAt > Number(row.expires_at) || row.flow_id && row.flow_id !== flowId)
        refused();
      await this.store.execute(
        "UPDATE lb_spectator_activation_attempts SET flow_id=$1,expires_at=$2,state='pending_activation' WHERE id=$3",
        [flowId, expiresAt, attemptId]
      );
      return attempt({
        ...row,
        flow_id: flowId,
        expires_at: expiresAt,
        state: "pending_activation"
      });
    });
  }
  async findAttempt(tokenHash, activationId) {
    const row = await this.store.one(
      "SELECT * FROM lb_spectator_activation_accounts WHERE invitation_token_hash=$1",
      [tokenHash]
    );
    if (!row) return null;
    const found = await this.store.one(
      "SELECT * FROM lb_spectator_activation_attempts WHERE account_id=$1 AND ($2::text IS NULL OR id=$2) ORDER BY generation DESC LIMIT 1",
      [row.account_id, activationId ?? null]
    );
    return found ? { account: account2(row), attempt: attempt(found) } : null;
  }
  async complete(input) {
    await this.store.transaction(async () => {
      const found = await this.findAttempt(input.tokenHash, input.attempt.id);
      if (!found || found.attempt.expiresAt <= input.nowMs || !["pending_activation", "completed"].includes(found.attempt.state))
        refused();
      const owner = await this.store.one(
        "SELECT classification,status,adult_verified,strong_auth_enrolled FROM accounts WHERE id=$1 FOR UPDATE",
        [found.account.accountId]
      );
      if (!owner || owner.classification !== "unclassified" || Number(owner.adult_verified) !== 0 || Number(owner.strong_auth_enrolled) !== 0)
        refused();
      if (found.attempt.state === "completed") {
        if (owner.status !== "active") refused();
        return;
      }
      if (owner.status !== "disabled") refused();
      await this.store.execute(
        "UPDATE accounts SET status='active' WHERE id=$1 AND classification='unclassified' AND status='disabled'",
        [found.account.accountId]
      );
      await this.store.execute(
        "UPDATE lb_spectator_activation_accounts SET state='active' WHERE account_id=$1",
        [found.account.accountId]
      );
      await this.store.execute(
        "UPDATE lb_spectator_activation_attempts SET state='completed',completed_at=$1 WHERE id=$2",
        [input.nowMs, found.attempt.id]
      );
      await this.store.execute(
        "INSERT INTO audit(id,actor_id,action,object_id,outcome,created_at,club_id,team_id,season_id,context_operation) VALUES($1,$2,'identity.spectator_activation_completed',$2,'provider_verified_sign_in_required',$3,$4,$5,$6,'spectator.activation.complete')",
        [
          randomUUID12(),
          found.account.accountId,
          input.nowMs,
          input.invitation.clubId,
          input.invitation.teamId,
          input.invitation.seasonId
        ]
      );
    });
  }
};

// apps/api/src/postgres-invitation-repository.ts
var PostgresInvitationRepository = class {
  constructor(store) {
    this.store = store;
  }
  store;
  transaction(work) {
    return this.store.transaction(work);
  }
  actor(session, accepting = false) {
    return this.store.communityActor(session.principal, session.teamId, session.seasonId, session.role, accepting);
  }
  invitationAllowed(session, lock = false) {
    return new PostgresTeamPrivilegeRepository(this.store).own(session, "invitations", lock);
  }
  async state(teamId, seasonId, lock = false) {
    if (lock) await this.store.one("SELECT team_id FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='community' FOR UPDATE", [teamId, seasonId]);
    const state = await this.store.communityState(teamId, seasonId);
    const rows = await this.store.many("SELECT * FROM spectator_invitations WHERE team_id=$1 AND season_id=$2", [teamId, seasonId]);
    for (const row of rows) assertInvitationMirror(state.invitations.find((invite) => invite.id === row.id), row);
    return state;
  }
  async save(session, state, changedIds, policyVersion) {
    await this.store.saveDocument(session.teamId, session.seasonId, "community", state);
    for (const invite of invitationChangedRows(state, changedIds)) {
      const existing = await this.store.one("SELECT id FROM spectator_invitations WHERE id=$1 FOR UPDATE", [invite.id]);
      if (existing) {
        const result = await this.store.execute("UPDATE spectator_invitations SET accepted_by=$1,accepted_at=$2,revoked_at=$3,requires_reissue=$4 WHERE id=$5", [invite.acceptedBy, invite.acceptedAtMs, invite.revokedAtMs, invite.credential.kind === "legacy_retired" && invite.credential.requiresReissue, invite.id]);
        if (result.changes !== 1) throw new Error("INVITATION_WRITE_NOT_CONFIRMED");
      } else {
        if (invite.credential.kind !== "sha256" || !policyVersion) throw new Error("INVITATION_POLICY_REQUIRED");
        const row = await this.store.one("SELECT club_id FROM teams WHERE id=$1", [session.teamId]);
        if (!row?.club_id) throw new Error("INVITATION_ANCESTRY_UNAVAILABLE");
        await this.store.execute("INSERT INTO spectator_invitations(id,club_id,team_id,season_id,inviter_account_id,credential_kind,token_hash,created_at,expires_at,accepted_by,accepted_at,revoked_at,reissued_from_invitation_id,policy_version) VALUES($1,$2,$3,$4,$5,'sha256',$6,$7,$8,$9,$10,$11,$12,$13)", [invite.id, row.club_id, invite.teamId, invite.seasonId, invite.inviterAccountId, invite.credential.tokenHash, invite.createdAtMs, invite.expiresAtMs, invite.acceptedBy, invite.acceptedAtMs, invite.revokedAtMs, invite.reissuedFromInvitationId, policyVersion]);
      }
    }
    await this.store.synchronizeSpectatorMemberships(invitationGrantProjection(state, changedIds));
  }
  async receipt(accountId, operation, key) {
    const row = await this.store.one("SELECT signature,response_json FROM idempotency WHERE account_id=$1 AND operation=$2 AND key=$3", [accountId, operation, key]);
    return row ? { signature: String(row.signature), response: JSON.parse(String(row.response_json)) } : null;
  }
  async saveReceipt(accountId, operation, key, receipt) {
    await this.store.execute("INSERT INTO idempotency(account_id,operation,key,signature,response_json) VALUES($1,$2,$3,$4,$5)", [accountId, operation, key, receipt.signature, JSON.stringify(receipt.response)]);
  }
  async resolve(_principal, tokenHash) {
    const row = await this.store.one("SELECT * FROM invitation_accept_scope($1)", [tokenHash]);
    return row ? { invitationId: String(row.id), teamId: String(row.team_id), seasonId: String(row.season_id), expiresAt: new Date(Number(row.expires_at)).toISOString() } : null;
  }
  audit(principal, action, objectId) {
    return this.store.audit(principal, action, objectId, "accepted");
  }
};

// apps/api/src/postgres-push-registrations.ts
var fields7 = [
  "account_id",
  "issuer",
  "device_id",
  "platform",
  "transport",
  "provider_config_id",
  "token_ciphertext",
  "token_digest",
  "permission",
  "state",
  "revision",
  "app_build",
  "registered_at",
  "updated_at",
  "revoked_at",
  "last_operation_id"
];
var PostgresPushRepository = class {
  constructor(database) {
    this.database = database;
  }
  database;
  transaction(work) {
    return this.database.transaction(work);
  }
  async enrolled(principal, deviceId) {
    return (await this.database.query(
      "SELECT platform FROM longball.native_app_devices WHERE device_id=$1 AND account_id=$2 AND issuer=$3",
      [deviceId, principal.accountId, principal.issuer]
    )).rows[0] ?? null;
  }
  async current(principal, deviceId) {
    return (await this.database.query(
      "SELECT * FROM longball.push_registrations WHERE account_id=$1 AND issuer=$2 AND device_id=$3 FOR UPDATE",
      [principal.accountId, principal.issuer, deviceId]
    )).rows[0] ?? null;
  }
  async list(principal) {
    return (await this.database.query(
      "SELECT * FROM longball.push_registrations WHERE account_id=$1 AND issuer=$2 ORDER BY device_id",
      [principal.accountId, principal.issuer]
    )).rows;
  }
  async save(principal, row, expectedRevision) {
    if (row.account_id !== principal.accountId || row.issuer !== principal.issuer)
      throw new Error("PUSH_ACCOUNT_SCOPE_REQUIRED");
    const values = fields7.map((field) => row[field]);
    if (expectedRevision === 0)
      return (await this.database.query(
        `INSERT INTO longball.push_registrations(${fields7.join(",")}) VALUES(${fields7.map((_, index) => `$${index + 1}`).join(",")}) ON CONFLICT(account_id,device_id) DO NOTHING`,
        values
      )).rowCount === 1;
    const updated = fields7.filter(
      (field) => !["account_id", "issuer", "device_id"].includes(field)
    );
    return (await this.database.query(
      `UPDATE longball.push_registrations SET ${updated.map((field, index) => `${field}=$${index + 1}`).join(",")} WHERE account_id=$${updated.length + 1} AND issuer=$${updated.length + 2} AND device_id=$${updated.length + 3} AND revision=$${updated.length + 4}`,
      [
        ...updated.map((field) => row[field]),
        principal.accountId,
        principal.issuer,
        row.device_id,
        expectedRevision
      ]
    )).rowCount === 1;
  }
  async deliveryTargets(accountId) {
    return (await this.database.query(
      "SELECT * FROM longball.push_targets_for_current_job($1)",
      [accountId]
    )).rows;
  }
};

// apps/api/src/postgres-server.ts
async function createPostgresApi(options2) {
  const store = await PostgresStore.open(options2.connectionString, options2.now, { migrationMode: options2.migrationMode });
  try {
    if (options2.allowOwnerTestFixture && process.env.NODE_ENV !== "test") throw new Error("Owner-credential fixtures are available only in the isolated test process.");
    const explicitOwnerFixture = options2.allowOwnerTestFixture === true && options2.syntheticAuth === true && options2.seedSynthetic !== false && (options2.migrationMode ?? "apply") === "apply";
    if (!explicitOwnerFixture) await store.assertRuntimeRole("api");
    if (options2.syntheticAuth && options2.seedSynthetic !== false) await store.seedSynthetic();
    const media = await PgMediaService.open({ directory: options2.mediaDirectory ?? join5(dirname3(options2.databasePath), "media"), database: store.db, scanner: options2.mediaScanner, now: options2.now });
    const activation = await new PostgresActivationService({ store, provider: options2.activationProvider, policy: options2.activationPolicy }).initialize();
    const port2 = store;
    const branding = createBrandMedia(options2, port2, new PostgresBrandRepository(store.db));
    const spectator = new SpectatorActivationService({ repository: new PostgresSpectatorActivationRepository(store), provider: options2.activationProvider, policy: options2.activationPolicy, now: store.now });
    const invitations = new SpectatorInvitationService({ ...options2, repository: new PostgresInvitationRepository(store), now: store.now });
    const privileges = new TeamPrivilegeService(new PostgresTeamPrivilegeRepository(store), store.now);
    const push = new PushRegistrationService(new PostgresPushRepository(store.db), options2, store.now);
    return createRuntimeApi(options2, store, port2, media, activation, void 0, { branding, spectator, invitations, privileges, push });
  } catch (error) {
    await store.close();
    throw error;
  }
}

// apps/api/src/database-config.ts
import { readFileSync as readFileSync5 } from "node:fs";
function readDatabaseUrl(env, key = "LONGBALL_DATABASE_URL") {
  const inline = env[key];
  const file = env[`${key}_FILE`];
  if (inline && file) throw new Error(`Configure exactly one of ${key} and ${key}_FILE.`);
  const value = file ? readFileSync5(file, "utf8").trim() : inline;
  if (!value) return void 0;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("A valid PostgreSQL connection URL is required.");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("A PostgreSQL connection URL is required.");
  return value;
}

// apps/api/src/push-config.ts
import { readFileSync as readFileSync6 } from "node:fs";
function readPushOptions(env) {
  const policy = env.LONGBALL_PUSH_PLATFORMS_FILE, keyring = env.LONGBALL_PUSH_KEYRING_FILE;
  if (!policy && !keyring) return {};
  if (!policy || !keyring)
    throw new Error(
      "Configure both mounted push platform policy and encryption keyring files."
    );
  let pushPlatforms;
  try {
    pushPlatforms = parsePushPlatformPolicies(
      JSON.parse(readFileSync6(policy, "utf8"))
    );
  } catch {
    throw new Error("Configure an explicit valid push platform policy file.");
  }
  return { pushPlatforms, pushTokenCipher: pushTokenCipherFromFile(keyring) };
}

// apps/api/src/main.ts
var syntheticAuth = process.env.LONGBALL_SYNTHETIC_AUTH === "1";
var host = process.env.LONGBALL_API_HOST ?? "127.0.0.1";
if (syntheticAuth && !["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("Synthetic development authentication may only bind to loopback.");
if (process.env.NODE_ENV === "production" && syntheticAuth) throw new Error("Synthetic authentication is disabled in production.");
var issuer = process.env.LONGBALL_OIDC_ISSUER;
var audience = process.env.LONGBALL_OIDC_AUDIENCE;
var jwksUri = process.env.LONGBALL_OIDC_JWKS_URI;
var connectionString = readDatabaseUrl(process.env);
if (!connectionString && !syntheticAuth) throw new Error("Configure LONGBALL_DATABASE_URL for the PostgreSQL runtime. SQLite is available only with explicit fictional authentication.");
var daemonSocket = process.env.LONGBALL_CLAMD_SOCKET;
var daemonHost = process.env.LONGBALL_CLAMD_HOST;
var mediaScanner = daemonSocket || daemonHost ? createClamAvDaemonScanner({ socketPath: daemonSocket, host: daemonHost, port: process.env.LONGBALL_CLAMD_PORT ? Number(process.env.LONGBALL_CLAMD_PORT) : void 0 }) : process.env.LONGBALL_CLAMSCAN_PATH ? createClamAvScanner(process.env.LONGBALL_CLAMSCAN_PATH) : void 0;
var clockPolicy;
if (process.env.LONGBALL_FICTIONAL_CLOCK_POLICY) {
  if (process.env.NODE_ENV === "production") throw new Error("The fictional clock policy is not production authority. Configure reviewed deployment evidence before enabling production anchors.");
  clockPolicy = JSON.parse(process.env.LONGBALL_FICTIONAL_CLOCK_POLICY);
  issueClockChallenge({ accountId: "configuration-check", deviceId: "configuration-check", matchId: "configuration-check", controllerEpoch: 1, continuityId: "configuration-check" }, "configuration-check", Date.now(), clockPolicy);
}
var options = {
  ...readPushOptions(process.env),
  databasePath: process.env.LONGBALL_API_DATABASE ?? ".local/api/longball.sqlite",
  syntheticAuth,
  oidc: issuer && audience && jwksUri ? { issuer, audience, jwksUri, mfaAcrValues: process.env.LONGBALL_OIDC_MFA_ACR?.split(",").filter(Boolean) } : void 0,
  allowedOrigins: process.env.LONGBALL_API_ORIGINS?.split(",").filter(Boolean),
  staticDirectory: process.env.LONGBALL_STATIC_DIRECTORY,
  browserConnectOrigins: process.env.LONGBALL_OIDC_CONNECT_ORIGINS?.split(",").filter(Boolean),
  mediaDirectory: process.env.LONGBALL_MEDIA_DIRECTORY,
  mediaScanner,
  clockPolicy,
  publicAppEntryUrl: process.env.LONGBALL_PUBLIC_APP_ENTRY_URL,
  invitationPolicyVersion: process.env.LONGBALL_INVITATION_POLICY_VERSION,
  defaultInviteExpiryHours: process.env.LONGBALL_DEFAULT_INVITE_EXPIRY_HOURS ? Number(process.env.LONGBALL_DEFAULT_INVITE_EXPIRY_HOURS) : void 0
};
var migrationMode = process.env.LONGBALL_DATABASE_MIGRATION_MODE ?? (syntheticAuth ? "apply" : "verify");
if (!["apply", "verify"].includes(migrationMode) || process.env.NODE_ENV === "production" && migrationMode !== "verify") throw new Error("The serving API uses verify-only schema mode in production; apply migrations with the dedicated operator command.");
var api = connectionString ? await createPostgresApi({ ...options, connectionString, seedSynthetic: false, migrationMode }) : createApi(options);
var port = Number(process.env.LONGBALL_API_PORT ?? 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Configure a valid API port.");
api.server.listen(port, host, () => {
  console.log(`LongBall API http://${host}:${port} \xB7 ${syntheticAuth ? "isolated fictional authentication" : "verified OIDC"} \xB7 ${connectionString ? "PostgreSQL runtime" : "fictional SQLite store"}`);
});
var closing = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  if (!closing) {
    closing = true;
    void api.close().then(() => process.exit(0));
  }
});
