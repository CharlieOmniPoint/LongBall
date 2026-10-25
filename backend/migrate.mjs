// packages/application/src/position-catalogue.ts
var CORE_POSITION_CODES = [
  "GK",
  "CB",
  "LB",
  "RB",
  "CM",
  "LW",
  "RW",
  "ST"
];
var labels = [
  "Goalkeeper",
  "Centre back",
  "Left back",
  "Right back",
  "Centre midfield",
  "Left wing",
  "Right wing",
  "Striker"
];
function defaultPositionCatalogue() {
  return CORE_POSITION_CODES.map((code, index) => ({
    code,
    label: labels[index],
    active: true
  }));
}
function validPositionCode(value) {
  return typeof value === "string" && /^[A-Z]{2}$/.test(value);
}
function validPositionCatalogue(value) {
  return Array.isArray(value) && value.length >= CORE_POSITION_CODES.length && value.length <= 676 && value.every(
    (item) => item && typeof item === "object" && Object.keys(item).length === 3 && validPositionCode(item.code) && typeof item.label === "string" && item.label.trim().length > 0 && item.label.length <= 60 && !/[\u0000-\u001f\u007f]/.test(item.label) && typeof item.active === "boolean"
  ) && new Set(value.map((item) => item.code)).size === value.length && CORE_POSITION_CODES.every(
    (code) => value.some((item) => item.code === code)
  ) && value.some((item) => item.code === "GK" && item.active);
}
function positionCatalogueFor(source2) {
  return (source2.positionCatalogue ?? defaultPositionCatalogue()).map(
    (position) => ({ ...position })
  );
}
function activePositionCodes(source2) {
  return positionCatalogueFor(source2).filter((item) => item.active).map((item) => item.code);
}
function saveTeamPosition(source2, position) {
  if (!position || Object.keys(position).length !== 3 || !validPositionCode(position.code) || typeof position.label !== "string" || !position.label.trim() || position.label.length > 60 || /[\u0000-\u001f\u007f]/.test(position.label) || typeof position.active !== "boolean")
    throw new Error(
      "Use a two-letter uppercase position code and a name of up to 60 characters."
    );
  if (position.code === "GK" && !position.active)
    throw new Error("Goalkeeper must remain active under the match rules.");
  const catalogue = positionCatalogueFor(source2);
  const previous = catalogue.findIndex((item) => item.code === position.code);
  const next = { ...position, label: position.label.trim() };
  if (previous < 0) catalogue.push(next);
  else catalogue[previous] = next;
  if (!validPositionCatalogue(catalogue))
    throw new Error(
      "Keep the core position catalogue and one active goalkeeper."
    );
  return catalogue;
}
function archiveTeamPosition(source2, code) {
  const position = positionCatalogueFor(source2).find(
    (item) => item.code === code
  );
  if (!position) throw new Error("Choose a saved team position.");
  return saveTeamPosition(source2, { ...position, active: false });
}
function assertActiveFormationPositions(source2, formation) {
  const active3 = new Set(activePositionCodes(source2));
  if (formation.slots.some((slot) => !active3.has(slot.position)))
    throw new Error(
      "Choose active team positions for every formation slot. Inactive positions remain in saved history."
    );
}
function allowedProfilePosition(source2, code, retained = []) {
  return validPositionCode(code) && positionCatalogueFor(source2).some(
    (item) => item.code === code && (item.active || retained.includes(code))
  );
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
    positionCatalogue: positionCatalogueFor(state),
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
      ...profile.faPlayerId !== void 0 ? { faPlayerId: profile.faPlayerId } : {},
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

// packages/application/src/uk-display.ts
var UK_TIME_ZONE = "Europe/London";
function londonDateKey(now) {
  const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: UK_TIME_ZONE }).formatToParts(new Date(now));
  const part = (kind) => parts.find((item) => item.type === kind).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

// packages/application/src/fixture-response-window.ts
function canPlayerReplyToFixture(fixture, nowMs, context = {}) {
  if (fixture.status !== "scheduled" || !Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isFinite(new Date(nowMs).getTime())) return false;
  if (context.recordedStatus != null && context.recordedStatus !== "preparation") return false;
  const date = fixture.playedDate;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith("0000-")) return false;
  const parsed = /* @__PURE__ */ new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return false;
  return date >= londonDateKey(nowMs);
}

// apps/api/src/match-pagination.ts
import { createHash } from "node:crypto";
import { Buffer as Buffer2 } from "node:buffer";

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
  const managers = memberships.filter((item) => item.teamId === teamId && item.role === "manager" && !item.administrativeInheritance && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > now));
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
  const dto2 = {
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
    dto2.ownRecord = {
      playerId: role.playerId,
      attendance: input.state.attendance[role.playerId] ?? "not_recorded",
      playingMs: ownIntervals.filter((item) => item.state === "playing").reduce((sum, item) => sum + item.endMs - item.startMs, 0),
      intervals: ownIntervals,
      completeness: input.state.recoveryRequired ? "review_required" : "recorded_to_last_sync"
    };
  }
  return dto2;
}

// apps/api/src/match-pagination.ts
var invalid = () => {
  throw new AccessError("INVALID_PAGE", 400, "Use the original cursor for this account, team, season and selected role, with a page limit from 1 to 100.");
};
var validId = (value) => typeof value === "string" && value.length >= 1;
function matchPageAudience(principal, memberships, teamId, seasonId, requestedRole, nowMs) {
  const available2 = currentMemberships(principal, memberships, nowMs).filter((item) => item.teamId === teamId && item.seasonId === seasonId && ["manager", "player", "spectator"].includes(item.role));
  const chosen = requestedRole ? available2.find((item) => item.role === requestedRole) : available2.find((item) => item.role === "manager") ?? available2.find((item) => item.role === "player") ?? available2[0];
  if (!chosen) throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
  if (chosen.role === "manager") assertAdultAuthority(principal, false, nowMs);
  return chosen;
}
var binding = (scope) => createHash("sha256").update(JSON.stringify(["longball.matches.id-asc.v1", scope.principal.accountId, scope.principal.issuer, scope.principal.subject, scope.teamId, scope.seasonId, scope.role, scope.playerId, ...scope.status === "active" ? ["active"] : []])).digest("base64url");
function matchPageCursor(scope, afterId) {
  if (!validId(afterId)) invalid();
  return Buffer2.from(JSON.stringify({ version: 1, binding: binding(scope), afterId })).toString("base64url");
}
function matchPagePosition(scope, query) {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) invalid();
  if (query.status !== void 0 && query.status !== "active" || query.status !== scope.status) invalid();
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
var aobject = (value, label2) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError((label2 === "object" ? "" : `"${label2}" `) + "expected object, got type=" + typeof value);
};
var aopts = (value, label2) => {
  aobject(value, label2);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw new TypeError(`"${label2}" expected plain object`);
  if (Object.hasOwn(value, "__proto__"))
    throw new TypeError(`"${label2}.__proto__" is not allowed`);
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
  const hash4 = sha256.create();
  let chunk = "";
  for (const token of canonicalTokens(payload)) {
    chunk += token;
    if (chunk.length >= 16384) {
      hash4.update(offlineUtf8(chunk));
      chunk = "";
    }
  }
  if (chunk) hash4.update(offlineUtf8(chunk));
  return Array.from(hash4.digest(), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
var only = (value, fields5) => Object.keys(value).every((key) => fields5.includes(key));
function assertOfflineSnapshot(download, scope) {
  const fail7 = () => {
    throw new Error("Offline snapshot is incomplete, inconsistent or unsupported. Existing journal retained; download a fresh verified bundle.");
  };
  if (!download || download.snapshotSchemaVersion !== OFFLINE_SNAPSHOT_SCHEMA || download.checksumSerialization !== OFFLINE_CHECKSUM_SERIALIZATION || !identifier(download.bundleId) || !identifier(download.teamId) || !identifier(download.seasonId) || scope.teamId !== void 0 && scope.teamId !== download.teamId || scope.seasonId !== void 0 && scope.seasonId !== download.seasonId || download.deviceId !== scope.deviceId || download.matchId !== scope.matchId || !iso(download.downloadedAt) || !/^[0-9a-f]{64}$/.test(download.checksumSha256 ?? "")) fail7();
  if (!only(download, ["contractVersion", "schemaVersion", "engineVersion", "bundleId", "snapshotSchemaVersion", "checksumSerialization", "checksumSha256", "matchId", "teamId", "seasonId", "deviceId", "state", "acceptedRevision", "deviceCheckpoint", "controller", "publication", "acceptedEvents", "controllerTransitions", "downloadedAt", "clockAnchor", "syntheticOnly"]) || download.controller && !only(download.controller, ["epoch", "account_id", "device_id", "frozen"])) fail7();
  if (!Array.isArray(download.acceptedEvents) || !Array.isArray(download.controllerTransitions) || download.acceptedEvents.length > MAX_OFFLINE_EVENTS || download.controllerTransitions.length > MAX_OFFLINE_EVENTS) fail7();
  const { checksumSha256, ...payload } = download;
  if (offlineChecksum(payload) !== checksumSha256) fail7();
  const state = download.state;
  if (!state?.config || state.config.matchId !== scope.matchId || !natural(state.revision) || state.revision !== download.acceptedRevision || !Array.isArray(state.config.players) || state.config.players.length > 100 || !Array.isArray(state.config.selectedPlayerIds) || state.config.selectedPlayerIds.length > 100 || new Set(state.config.players.map((player) => player.id)).size !== state.config.players.length || state.config.fixture && (state.config.fixture.teamId !== download.teamId || state.config.fixture.seasonId !== download.seasonId)) fail7();
  if (!only(state.config, ["matchId", "players", "selectedPlayerIds", "pitchPlaces", "plannedHalfDurationMs", "fixedKeeperId", "initialPolicyProposal", "initialLineupProposal", "initialAttendance", "slots", "fixture", "profileSnapshot"]) || state.config.players.some((player) => !only(player, ["id", "displayName", "goalkeeperChoice", "positionPreferences", "profileVersion", "available"])) || state.config.profileSnapshot?.some((profile) => !only(profile, ["playerId", "preferences", "eligiblePositions", "initials"]))) fail7();
  if (!download.publication || !Object.hasOwn(download.publication, "fixtureClass") || !Object.hasOwn(download.publication, "classificationVersion") || !Object.hasOwn(download.publication, "resultPolicy") || !download.publication.sharingPolicy || typeof download.publication.sharingPolicy.shareScores !== "boolean" || typeof download.publication.sharingPolicy.shareDerivedResults !== "boolean") fail7();
  if (!Array.isArray(download.acceptedEvents) || !Array.isArray(download.controllerTransitions) || download.acceptedEvents.length > MAX_OFFLINE_EVENTS || download.controllerTransitions.length > MAX_OFFLINE_EVENTS || download.acceptedEvents.length !== state.revision) fail7();
  const ids = /* @__PURE__ */ new Set();
  for (const [index, record] of download.acceptedEvents.entries()) {
    const event = record.event;
    if (record.serverSequence !== index + 1 || !iso(record.receivedAt) || !event || event.matchId !== scope.matchId || event.baseRevision !== index || !identifier(event.eventId) || !identifier(event.deviceId) || !natural(event.clientSequence) || event.clientSequence < 1 || !natural(event.controllerEpoch) || event.controllerEpoch < 1 || !event.engineVersion || event.command?.id !== event.eventId || ids.has(event.eventId)) fail7();
    ids.add(event.eventId);
  }
  if (state.eventHistory && (state.eventHistory.length !== download.acceptedEvents.length || !state.eventHistory.every((event, index) => event.id === download.acceptedEvents[index].event.eventId && equal({ ...download.acceptedEvents[index].event.command, ...event.actorId === void 0 ? {} : { actorId: event.actorId } }, event)))) fail7();
  const checkpoint = download.deviceCheckpoint;
  if (!checkpoint || !natural(checkpoint.clientSequence) || !(checkpoint.previousEventId === null || identifier(checkpoint.previousEventId)) || checkpoint.clientSequence === 0 !== (checkpoint.previousEventId === null)) fail7();
  for (const record of download.acceptedEvents) if (record.event.deviceId === scope.deviceId && record.event.clientSequence > checkpoint.clientSequence) fail7();
  for (const transition of download.controllerTransitions) if (!identifier(transition.id) || !natural(transition.epoch) || transition.epoch < 1 || !identifier(transition.actorId) || !identifier(transition.toDevice) || !(transition.fromDevice === null || identifier(transition.fromDevice)) || !iso(transition.createdAt) || typeof transition.kind !== "string" || !(transition.reason === null || typeof transition.reason === "string")) fail7();
  if (!download.clockAnchor || download.clockAnchor.serverTime !== download.downloadedAt || download.clockAnchor.quality !== "observation_only" || download.clockAnchor.continuousMappingEstablished !== false || typeof download.syntheticOnly !== "boolean") fail7();
}

// packages/domain/src/live-events.ts
function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}
function duration(value, label2) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label2} must be a nonnegative safe integer.`);
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
  const active3 = goals.filter((goal) => !goal.voided);
  const sum = (values) => ({
    for: values.filter((goal) => goal.beneficiary === "us").length,
    against: values.filter((goal) => goal.beneficiary === "opposition").length
  });
  return {
    score: sum(active3),
    halfTimeScore: state.firstHalfDurationMs === null ? state.halfTimeScore : sum(active3.filter((goal) => goal.effective.half === 1))
  };
}

// packages/domain/src/policy.ts
function fail(message) {
  throw new Error(message);
}
function keys(value, fields5, label2) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields5.includes(key)) || fields5.some((key) => !Object.hasOwn(value, key))) fail(`Use the exact versioned ${label2} fields.`);
}
function nonnegative(value, label2) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(`${label2} must be a nonnegative safe integer.`);
}
function keeperRank(config, playerId) {
  const saved2 = config.profileSnapshot?.find((profile) => profile.playerId === playerId);
  return saved2 ? saved2.preferences.indexOf("GK") + 1 : config.players.find((player) => player.id === playerId)?.goalkeeperChoice ?? 0;
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
    const saved2 = config.profileSnapshot?.find((profile) => profile.playerId === allocation.playerId);
    if (saved2 && !saved2.eligiblePositions.includes(allocation.position)) fail("A proposed role is outside the saved player eligibility.");
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
  const record = { ...details, eventId: event.id, revision: previousRevision + 1, recordedAtMs: event.sample.wallTimeMs, actorId: event.actorId ?? null };
  const activePolicy = { ...cloneValue(record), positionMode: event.resetPositionMode ? "normal" : state.activePolicy?.positionMode ?? "normal", manualResetAtSourceRevision: event.resetPositionMode ? previousRevision + 1 : null };
  return { ...state, activePolicy, policyHistory: [...state.policyHistory ?? [], record] };
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
      state.config.selectedPlayerIds.map((id5) => [
        id5,
        state.config.initialAttendance?.[id5] ?? "not_recorded"
      ])
    ),
    availability: Object.fromEntries(
      state.config.selectedPlayerIds.map((id5) => [id5, true])
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
        (id5) => actual.attendance[id5] === "present" && actual.availability[id5]
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
function integer(value, label2) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label2} must be a nonnegative safe integer.`);
}
function assertSample(sample) {
  if (!Number.isFinite(sample.monotonicMs) || sample.monotonicMs < 0 || !Number.isSafeInteger(Math.floor(sample.monotonicMs)) || !sample.sessionId) throw new Error("Clock sample is invalid.");
  integer(sample.wallTimeMs, "Wall time");
}
function isRunning(state) {
  return state.status === "first_half_running" || state.status === "second_half_running";
}
function isPaused(state) {
  return state.status === "first_half_paused" || state.status === "second_half_paused";
}
function available(state, id5) {
  return state.availability[id5] === true && state.attendance[id5] === "present";
}
function selectedPlayer(state, id5) {
  if (!state.config.selectedPlayerIds.includes(id5)) throw new Error("Player is outside this selected match squad.");
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
  if (config.selectedPlayerIds.some((id5) => !ids.includes(id5))) throw new Error("Selected players must belong to this roster.");
  if (config.initialAttendance && Object.entries(config.initialAttendance).some(([id5, status]) => !config.selectedPlayerIds.includes(id5) || !["present", "absent", "excused", "not_selected", "not_recorded"].includes(status))) throw new Error("Initial attendance must be explicit valid check-in for the selected squad.");
  if (config.slots && (config.slots.length !== config.pitchPlaces || new Set(config.slots.map((slot) => slot.slotId)).size !== config.slots.length || config.slots.filter((slot) => slot.position === "GK").length !== 1 || config.slots.some((slot) => !slot.slotId || !slot.position))) throw new Error("Saved formation needs one distinct slot per pitch place and exactly one goalkeeper.");
  if (config.profileSnapshot && (new Set(config.profileSnapshot.map((profile) => profile.playerId)).size !== config.profileSnapshot.length || config.profileSnapshot.some((profile) => !ids.includes(profile.playerId) || profile.preferences.length > 3 || new Set(profile.preferences).size !== profile.preferences.length || new Set(profile.eligiblePositions).size !== profile.eligiblePositions.length))) throw new Error("Match profile snapshots must belong to distinct roster players with distinct preferences and eligibility.");
  if (config.fixedKeeperId !== null && (!config.selectedPlayerIds.includes(config.fixedKeeperId) || ![1, 2].includes(keeperChoice(config, config.fixedKeeperId)))) throw new Error("Fixed keeper must be a selected first- or second-choice goalkeeper.");
  if (config.initialPolicyProposal !== void 0) assertMatchPolicyProposal(config.initialPolicyProposal, config);
  if (config.initialLineupProposal !== void 0) assertInitialLineupProposal(config, config.initialLineupProposal);
  return {
    config: cloneValue(config),
    status: "preparation",
    revision: 0,
    attendance: Object.fromEntries(ids.map((id5) => [id5, config.initialAttendance?.[id5] ?? "not_recorded"])),
    availability: Object.fromEntries(ids.map((id5) => [id5, config.selectedPlayerIds.includes(id5)])),
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
  integer(halfActiveMs, "Half active time");
  integer(matchActiveMs, "Match active time");
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
      availablePlayerIds: state.config.selectedPlayerIds.filter((id5) => available(state, id5)),
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
    const latest2 = accrue(previous, event.sample);
    const boundary = event.effective;
    if (!boundary || boundary.half !== previous.half || !Number.isSafeInteger(boundary.matchElapsedMs) || boundary.matchElapsedMs < previous.matchActiveMs || boundary.matchElapsedMs > latest2.matchActiveMs) throw new Error("A policy change must use its captured current continuous boundary, never earlier history or future play.");
    if (isRunning(previous)) {
      if (!previous.anchor) throw new Error("A continuous anchor is required for prospective policy changes.");
      const boundarySample = { ...event.sample, monotonicMs: Math.floor(previous.anchor.sample.monotonicMs) + boundary.matchElapsedMs - previous.anchor.matchActiveMs };
      state = accrue(previous, boundarySample);
    } else state = latest2;
  } else if (event.type === "availability.changed" && event.effective && !reviewedParticipationEntry) {
    if (previous.half === 0) throw new Error("Preparation availability has no active-time boundary.");
    const latest2 = accrue(previous, event.sample);
    const boundary = effectiveTime(latest2, event.effective);
    if (boundary.half !== previous.half || boundary.matchElapsedMs < previous.matchActiveMs) throw new Error("Historical availability crosses a recorded boundary. Preserve actual intervals and use explicit history reconciliation; no minutes were changed.");
    if (!isRunning(previous) && boundary.matchElapsedMs !== previous.matchActiveMs) throw new Error("Paused or half-time availability must use the current active-time boundary.");
    if (isRunning(previous)) {
      if (!previous.anchor) throw new Error("A continuous anchor is required for an effective availability boundary.");
      const boundarySample = { ...event.sample, monotonicMs: Math.floor(previous.anchor.sample.monotonicMs) + boundary.matchElapsedMs - previous.anchor.matchActiveMs };
      state = accrue(previous, boundarySample);
    } else state = latest2;
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
  integer(actualMs, "Actual playing time");
  const actual = BigInt(actualMs);
  return actual * target.lower.denominator >= target.lower.numerator && actual * target.upper.denominator <= target.upper.numerator;
}
function calculateTargets(intervals, allPlayerIds = []) {
  const totals = new Map(allPlayerIds.map((id5) => [id5, rational(0n)]));
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

// apps/api/src/pg.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, types } from "pg";
import { readFile } from "node:fs/promises";
var contextKey = (context) => JSON.stringify(Object.entries(context).sort(([a], [b]) => a.localeCompare(b)));
function matchWriteTeam(context) {
  if (context?.kind !== "actor" || context.operation !== "match.manage" || !["manager", "default"].includes(context.requestedRole ?? "")) return null;
  const ids = [context.clubId, context.teamId, context.seasonId, context.matchId];
  if (ids.some((id5) => typeof id5 !== "string" || !/^[A-Za-z0-9_-]{1,150}$/.test(id5))) return null;
  return JSON.stringify([context.clubId, context.teamId]);
}
function validateContext(context) {
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
  if (context.kind === "worker_claim" && !["award.finalise", "notification.dispatch", "report.export"].includes(context.jobKind)) throw new Error("Invalid PostgreSQL job context.");
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
  transactions = new AsyncLocalStorage();
  applications = new AsyncLocalStorage();
  get applicationContext() {
    const frame = this.applications.getStore();
    for (let ancestor = frame; ancestor; ancestor = ancestor.parent) if (!ancestor.active) throw new Error("PostgreSQL application context has ended.");
    return frame?.value;
  }
  async withContext(value, work) {
    validateContext(value);
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
  constructor(connectionString2, options = {}) {
    let url;
    try {
      url = new URL(connectionString2);
    } catch {
      throw new Error("A valid PostgreSQL connection URL is required.");
    }
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("A PostgreSQL connection URL is required.");
    this.migrationMode = options.migrationMode ?? "apply";
    this.pool = new Pool({
      connectionString: connectionString2,
      max: options.maximumConnections ?? 10,
      application_name: options.applicationName ?? "longball-api",
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
      if (lockWrites && existing.writeLock === "none") throw new Error("An unlocked PostgreSQL transaction cannot be upgraded to a write transaction.");
      return work();
    }
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN");
      if (application) await client.query("SELECT set_config('longball.context',$1,true)", [JSON.stringify(application)]);
      const team = lockWrites ? matchWriteTeam(application) : null;
      if (lockWrites) {
        if (team !== null) {
          await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('longball:domain-write:v1', 0))");
          await client.query("SELECT pg_advisory_xact_lock(hashtext('longball:team-write:v1'),hashtext($1))", [team]);
        } else await client.query("SELECT pg_advisory_xact_lock(hashtextextended('longball:domain-write:v1', 0))");
      }
      const transaction = { client, applicationKey, active: true, writeLock: lockWrites ? team === null ? "global" : "team" : "none" };
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
      if (versions.rows.some((row) => row.version > 28)) throw new Error("This PostgreSQL schema is newer than the application. Preserve it and use a compatible build.");
      if (![2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28].every((version2) => versions.rows.some((row) => row.version === version2))) throw new Error("PostgreSQL migrations are required. Run the separate migrator before starting the runtime.");
      const protectedTables = ["clubs", "teams", "team_seasons", "game_contexts", "accounts", "memberships", "matches", "documents", "devices", "controller_grants", "controller_history", "events", "streams", "conflicting_submissions", "transfers", "clock_challenges", "clock_mappings", "reconciliation_proposals", "audit", "idempotency", "privacy_requests", "privacy_pending_keys", "jobs", "brand_assets", "brand_slots", "spectator_invitations", "lb_spectator_activation_accounts", "lb_spectator_activation_attempts", "native_app_devices", "team_privilege_states", "team_privilege_decisions", "push_registrations", "report_exports", "match_feedback", "match_feedback_receipts", "administration_grants", "administrative_memberships", "team_documents", "opposition_reviews", "opposition_review_receipts", "spectator_pin_credentials", "invite_requests", "application_sign_in_rules", "global_usernames", "login_reporting_state", "login_access_snapshots", "login_events", "login_sessions"];
      const security = await this.query(`SELECT c.relname,c.relrowsecurity,(SELECT count(*)::integer FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid) AS policies FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='longball' AND c.relname=ANY($1::text[])`, [protectedTables]);
      if (security.rows.length !== protectedTables.length || security.rows.some((row) => !row.relrowsecurity || row.policies < 1)) throw new Error("PostgreSQL row security is missing. Run the separate migrator before starting runtime.");
      return;
    }
    const migration = await readFile(new URL("../migrations/postgresql/002_runtime.sql", import.meta.url), "utf8");
    const clockReviewMigration = await readFile(new URL("../migrations/postgresql/003_clock_review.sql", import.meta.url), "utf8");
    const accountRequestsMigration = await readFile(new URL("../migrations/postgresql/004_account_requests.sql", import.meta.url), "utf8");
    const scopeSecurityMigration = await readFile(new URL("../migrations/postgresql/005_scope_security.sql", import.meta.url), "utf8");
    const awardNotificationsMigration = await readFile(new URL("../migrations/postgresql/006_award_notifications.sql", import.meta.url), "utf8");
    const workerBoundariesMigration = await readFile(new URL("../migrations/postgresql/007_worker_boundaries.sql", import.meta.url), "utf8");
    const controllerRevocationMigration = await readFile(new URL("../migrations/postgresql/008_controller_revocation.sql", import.meta.url), "utf8");
    const dispatchClockMigration = await readFile(new URL("../migrations/postgresql/009_dispatch_database_clock.sql", import.meta.url), "utf8");
    const brandAssetsMigration = await readFile(new URL("../migrations/postgresql/010_brand_assets.sql", import.meta.url), "utf8");
    const spectatorCapabilitiesMigration = await readFile(new URL("../migrations/postgresql/011_spectator_capabilities.sql", import.meta.url), "utf8");
    const heicMigration = await readFile(new URL("../migrations/postgresql/012_heic_support.sql", import.meta.url), "utf8");
    const teamPrivilegesMigration = await readFile(new URL("../migrations/postgresql/013_team_privileges.sql", import.meta.url), "utf8");
    const pushRegistrationMigration = await readFile(new URL("../migrations/postgresql/014_push_registrations.sql", import.meta.url), "utf8");
    const privilegeAuditClockMigration = await readFile(new URL("../migrations/postgresql/015_team_privilege_audit_clock.sql", import.meta.url), "utf8");
    const reportExportsMigration = await readFile(new URL("../migrations/postgresql/016_report_exports.sql", import.meta.url), "utf8");
    const feedbackMigration = await readFile(new URL("../migrations/postgresql/017_match_feedback.sql", import.meta.url), "utf8");
    const scheduledGamesMigration = await readFile(new URL("../migrations/postgresql/018_scheduled_games.sql", import.meta.url), "utf8");
    const playerStatsMigration = await readFile(new URL("../migrations/postgresql/019_player_stats.sql", import.meta.url), "utf8");
    const teamOverviewMigration = await readFile(new URL("../migrations/postgresql/020_team_overview.sql", import.meta.url), "utf8");
    const administrationMigration = await readFile(new URL("../migrations/postgresql/021_club_administration.sql", import.meta.url), "utf8");
    const teamDocumentsMigration = await readFile(new URL("../migrations/postgresql/022_team_documents.sql", import.meta.url), "utf8");
    const oppositionReviewsMigration = await readFile(new URL("../migrations/postgresql/023_opposition_reviews.sql", import.meta.url), "utf8");
    const spectatorAccessMigration = await readFile(new URL("../migrations/postgresql/024_spectator_access.sql", import.meta.url), "utf8");
    const inheritedManagerMigration = await readFile(new URL("../migrations/postgresql/025_inherited_manager_authority.sql", import.meta.url), "utf8");
    const signInRulesMigration = await readFile(new URL("../migrations/postgresql/026_sign_in_rules.sql", import.meta.url), "utf8");
    const globalUsernamesMigration = await readFile(new URL("../migrations/postgresql/027_global_usernames.sql", import.meta.url), "utf8");
    const loginAnalyticsMigration = await readFile(new URL("../migrations/postgresql/028_login_analytics.sql", import.meta.url), "utf8");
    await this.transaction(async () => {
      const schema = await this.query("SELECT to_regnamespace('longball')::text AS namespace");
      if (!schema.rows[0]?.namespace) await this.query("CREATE SCHEMA longball");
      await this.query("CREATE TABLE IF NOT EXISTS longball.schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      const versions = await this.query("SELECT version FROM longball.schema_migrations ORDER BY version");
      if (versions.rows.some((row) => row.version > 28)) throw new Error("This PostgreSQL schema is newer than the application. Preserve it and use a compatible build.");
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
      if (!versions.rows.some((row) => row.version === 16)) {
        await this.query(reportExportsMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(16)");
      }
      if (!versions.rows.some((row) => row.version === 17)) {
        await this.query(feedbackMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(17)");
      }
      if (!versions.rows.some((row) => row.version === 18)) {
        await this.query(scheduledGamesMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(18)");
      }
      if (!versions.rows.some((row) => row.version === 19)) {
        await this.query(playerStatsMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(19)");
      }
      if (!versions.rows.some((row) => row.version === 20)) {
        await this.query(teamOverviewMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(20)");
      }
      if (!versions.rows.some((row) => row.version === 21)) {
        await this.query(administrationMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(21)");
      }
      if (!versions.rows.some((row) => row.version === 22)) {
        await this.query(teamDocumentsMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(22)");
      }
      if (!versions.rows.some((row) => row.version === 23)) {
        await this.query(oppositionReviewsMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(23)");
      }
      if (!versions.rows.some((row) => row.version === 24)) {
        await this.query(spectatorAccessMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(24)");
      }
      if (!versions.rows.some((row) => row.version === 25)) {
        await this.query(inheritedManagerMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(25)");
      }
      if (!versions.rows.some((row) => row.version === 26)) {
        await this.query(signInRulesMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(26)");
      }
      if (!versions.rows.some((row) => row.version === 27)) {
        await this.query(globalUsernamesMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(27)");
      }
      if (!versions.rows.some((row) => row.version === 28)) {
        await this.query(loginAnalyticsMigration);
        await this.query("INSERT INTO longball.schema_migrations(version) VALUES(28)");
      }
    });
  }
  async close() {
    await this.pool.end();
  }
};

// apps/api/src/postgres-store.ts
import { createHash as createHash2, randomBytes, randomUUID as randomUUID2 } from "node:crypto";

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
      displayName: "Thomas Arnold",
      available: true,
      goalkeeperChoice: 1
    },
    {
      id: "synthetic-player-02",
      displayName: "Ralph Barrett",
      available: true,
      goalkeeperChoice: 0
    },
    {
      id: "synthetic-player-03",
      displayName: "Conor Kyne",
      available: true,
      goalkeeperChoice: 0
    },
    {
      id: "synthetic-player-04",
      displayName: "Max Holland",
      available: true,
      goalkeeperChoice: 0
    },
    {
      id: "synthetic-player-05",
      displayName: "Aryan Applegard",
      available: true,
      goalkeeperChoice: 0
    },
    {
      id: "synthetic-player-06",
      displayName: "Seb Lawler",
      available: true,
      goalkeeperChoice: 0
    },
    {
      id: "synthetic-player-07",
      displayName: "Ezra Philips",
      available: true,
      goalkeeperChoice: 0
    },
    {
      id: "synthetic-player-08",
      displayName: "Archie Muir",
      available: true,
      goalkeeperChoice: 0
    }
  ],
  demo: {
    name: "Roma autumn matchdays",
    generated: true,
    description: "Roma U10 squad and matchdays for reviewing the application.",
    referenceDate: "2026-10-22"
  },
  club: {
    id: "synthetic-richmond-rovers",
    name: "Richmond Rovers"
  },
  team: {
    name: "Roma",
    ageGroup: "U10"
  },
  opponents: [
    {
      id: "demo-maple",
      name: "Maple FC",
      venue: "Maple Sports Ground \xB7 Pitch 1"
    },
    {
      id: "demo-oak",
      name: "Oak FC",
      venue: "Oak Meadow \xB7 Junior pitch"
    },
    {
      id: "demo-hill",
      name: "Hill FC",
      venue: "Hill Park \xB7 Pitch 3"
    },
    {
      id: "demo-willow",
      name: "Willow FC",
      venue: "Willow Playing Fields \xB7 Pitch 2"
    },
    {
      id: "demo-cedar",
      name: "Cedar Athletic",
      venue: "Cedar Lane Sports Ground"
    }
  ],
  fixtures: [
    {
      id: "synthetic-roma-maple-2026-10-24",
      opponent: "Maple FC",
      playedDate: "2026-10-24",
      kickoff: "10:00",
      arrival: "09:30",
      venue: "Rovers Sports Ground \xB7 Pitch 2",
      homeAway: "home",
      status: "scheduled",
      selectedCount: 8,
      selectedPlayerIds: [
        "synthetic-player-01",
        "synthetic-player-02",
        "synthetic-player-03",
        "synthetic-player-04",
        "synthetic-player-05",
        "synthetic-player-06",
        "synthetic-player-07",
        "synthetic-player-08"
      ],
      demoPhase: "scheduled",
      fixtureClass: "development"
    },
    {
      id: "synthetic-roma-oak-2026-10-31",
      opponent: "Oak FC",
      playedDate: "2026-10-31",
      kickoff: "10:30",
      arrival: "10:00",
      venue: "Oak Meadow \xB7 Junior pitch",
      homeAway: "away",
      status: "scheduled",
      selectedCount: 8,
      selectedPlayerIds: [
        "synthetic-player-01",
        "synthetic-player-02",
        "synthetic-player-03",
        "synthetic-player-04",
        "synthetic-player-05",
        "synthetic-player-06",
        "synthetic-player-07",
        "synthetic-player-08"
      ],
      demoPhase: "scheduled",
      fixtureClass: "development"
    },
    {
      id: "synthetic-history-oak",
      opponent: "Oak FC",
      playedDate: "2026-10-10",
      kickoff: "10:30",
      arrival: "10:00",
      venue: "Oak Meadow \xB7 Junior pitch",
      homeAway: "away",
      status: "scheduled",
      selectedCount: 8,
      selectedPlayerIds: [
        "synthetic-player-01",
        "synthetic-player-02",
        "synthetic-player-03",
        "synthetic-player-04",
        "synthetic-player-05",
        "synthetic-player-06",
        "synthetic-player-07",
        "synthetic-player-08"
      ],
      demoPhase: "completed",
      fixtureClass: "friendly",
      result: {
        halfTime: {
          for: 1,
          against: 1
        },
        final: {
          for: 2,
          against: 2
        },
        halfMinutes: 25
      }
    },
    {
      id: "synthetic-history-hill",
      opponent: "Hill FC",
      playedDate: "2026-10-17",
      kickoff: "09:30",
      arrival: "09:00",
      venue: "Rovers Sports Ground \xB7 Pitch 2",
      homeAway: "home",
      status: "scheduled",
      selectedCount: 8,
      selectedPlayerIds: [
        "synthetic-player-01",
        "synthetic-player-02",
        "synthetic-player-03",
        "synthetic-player-04",
        "synthetic-player-05",
        "synthetic-player-06",
        "synthetic-player-07",
        "synthetic-player-08"
      ],
      demoPhase: "completed",
      fixtureClass: "development",
      result: {
        halfTime: {
          for: 1,
          against: 1
        },
        final: {
          for: 3,
          against: 1
        },
        halfMinutes: 25
      }
    }
  ],
  training: [
    {
      id: "synthetic-training-1",
      date: "2026-10-22",
      time: "18:00",
      venue: "Rovers Sports Ground \xB7 Training area",
      status: "scheduled"
    },
    {
      id: "synthetic-training-2",
      date: "2026-10-29",
      time: "18:00",
      venue: "Rovers Sports Ground \xB7 Training area",
      status: "scheduled"
    },
    {
      id: "synthetic-training-2026-11-05",
      date: "2026-11-05",
      time: "18:00",
      venue: "Rovers Sports Ground \xB7 Training area",
      status: "scheduled"
    },
    {
      id: "synthetic-training-2026-10-01",
      date: "2026-10-01",
      time: "18:00",
      venue: "Rovers Sports Ground \xB7 Training area",
      status: "held"
    },
    {
      id: "synthetic-training-2026-10-08",
      date: "2026-10-08",
      time: "18:00",
      venue: "Rovers Sports Ground \xB7 Training area",
      status: "held"
    },
    {
      id: "synthetic-training-2026-10-15",
      date: "2026-10-15",
      time: "18:00",
      venue: "Rovers Sports Ground \xB7 Training area",
      status: "held"
    },
    {
      id: "synthetic-training-2026-09-24",
      date: "2026-09-24",
      time: "18:00",
      venue: "Rovers Sports Ground \xB7 Training area",
      status: "cancelled"
    }
  ],
  profiles: [
    {
      playerId: "synthetic-player-01",
      initials: "TA",
      shirtNumber: 1,
      foot: "right",
      preferences: [
        "GK",
        "CM",
        "CB"
      ],
      eligiblePositions: [
        "GK",
        "CB",
        "ST"
      ]
    },
    {
      playerId: "synthetic-player-02",
      initials: "RB",
      shirtNumber: 2,
      foot: "right",
      preferences: [
        "CB",
        "CM",
        "ST"
      ],
      eligiblePositions: [
        "CB",
        "LB",
        "RB",
        "CM",
        "LW",
        "RW",
        "ST"
      ]
    },
    {
      playerId: "synthetic-player-03",
      initials: "CK",
      shirtNumber: 3,
      foot: "right",
      preferences: [
        "CB",
        "CM",
        "ST"
      ],
      eligiblePositions: [
        "CB",
        "LB",
        "RB",
        "CM",
        "LW",
        "RW",
        "ST"
      ]
    },
    {
      playerId: "synthetic-player-04",
      initials: "MH",
      shirtNumber: 4,
      foot: "right",
      preferences: [
        "CM",
        "CB",
        "ST"
      ],
      eligiblePositions: [
        "CB",
        "LB",
        "RB",
        "CM",
        "LW",
        "RW",
        "ST"
      ]
    },
    {
      playerId: "synthetic-player-05",
      initials: "AA",
      shirtNumber: 5,
      foot: "right",
      preferences: [
        "CM",
        "CB",
        "ST"
      ],
      eligiblePositions: [
        "CB",
        "LB",
        "RB",
        "CM",
        "LW",
        "RW",
        "ST"
      ]
    },
    {
      playerId: "synthetic-player-06",
      initials: "SL",
      shirtNumber: 6,
      foot: "left",
      preferences: [
        "LW",
        "CM",
        "CB"
      ],
      eligiblePositions: [
        "CB",
        "LB",
        "RB",
        "CM",
        "LW",
        "RW",
        "ST"
      ]
    },
    {
      playerId: "synthetic-player-07",
      initials: "EP",
      shirtNumber: 7,
      foot: "right",
      preferences: [
        "RW",
        "CM",
        "CB"
      ],
      eligiblePositions: [
        "CB",
        "LB",
        "RB",
        "CM",
        "LW",
        "RW",
        "ST"
      ]
    },
    {
      playerId: "synthetic-player-08",
      initials: "AM",
      shirtNumber: 8,
      foot: "right",
      preferences: [
        "ST",
        "CM",
        "CB"
      ],
      eligiblePositions: [
        "CB",
        "LB",
        "RB",
        "CM",
        "LW",
        "RW",
        "ST"
      ]
    }
  ]
};

// packages/testing/src/index.ts
var romaFixture = roma_synthetic_default;
var demoAccountLabels = {
  "synthetic-account-manager": "Alex Morgan",
  "synthetic-account-manager-2": "Priya Shah",
  "synthetic-account-manager-3": "Dan Foster",
  "synthetic-account-manager-4": "Chris Lewis",
  "synthetic-account-manager-5": "Nicky Hughes",
  "synthetic-account-admin": "Sam Taylor",
  "synthetic-account-spectator": "Jamie Bennett",
  "synthetic-account-invitee": "Casey Bennett",
  "synthetic-account-other-manager": "Robin Ellis",
  ...Object.fromEntries(roma_synthetic_default.players.map((player) => [`synthetic-account-player-${player.id.slice(-2)}`, player.displayName]))
};

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
function required(value, maximum, label2) {
  assert(
    typeof value === "string" && value.trim() && value.trim().length <= maximum && !/[\u0000-\u001f\u007f]/.test(value),
    `${label2} is required and must be at most ${maximum} characters.`
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
  assertActiveFormationPositions(state, formation);
  assert(
    formation.format === fixture.format && formation.slots.length === fixture.format && formation.slots.filter((slot) => slot.position === "GK").length === 1,
    "The saved formation must match this fixture format and include one goalkeeper."
  );
  assert(
    Array.isArray(allocations) && allocations.length === fixture.format && new Set(allocations.map((row) => row.slotId)).size === fixture.format && new Set(allocations.map((row) => row.playerId)).size === fixture.format,
    "Review one distinct player for every saved place."
  );
  const selected = fixture.selectedProfileIds.map(
    (id5) => state.profiles.find(
      (profile) => profile.id === id5 && profile.seasonId === fixture.seasonId && profile.active
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
        (id5) => state.profiles.find((profile) => profile.id === id5)?.playerId
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

// packages/application/src/lineup-templates.ts
var copy2 = (value) => JSON.parse(JSON.stringify(value));
function requireThat2(value, message) {
  if (!value) throw new Error(message);
}
function id(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,150}$/.test(value);
}
function version(value) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function latest(state) {
  const rows = /* @__PURE__ */ new Map();
  for (const item of state.lineupTemplates ?? []) if (item.teamId === state.team.id && item.seasonId === state.activeSeasonId && (!rows.has(item.id) || rows.get(item.id).version < item.version)) rows.set(item.id, item);
  return [...rows.values()];
}
function latestLineupTemplates(state) {
  return latest(state).filter((item) => item.active).map(copy2);
}
function validateSetup(state, formation, selectedIds, allocations) {
  assertActiveFormationPositions(state, formation);
  requireThat2(formation.format >= 5 && formation.format <= 11 && formation.slots.length === formation.format && formation.slots.filter((slot) => slot.position === "GK").length === 1 && new Set(formation.slots.map((slot) => slot.id)).size === formation.format, "Choose a complete saved formation with one goalkeeper place.");
  requireThat2(Array.isArray(selectedIds) && selectedIds.length >= formation.format && selectedIds.length <= 100 && new Set(selectedIds).size === selectedIds.length, "Choose a distinct squad with enough players for this setup.");
  const profiles = selectedIds.map((playerId) => state.profiles.find((profile) => profile.playerId === playerId && profile.seasonId === state.activeSeasonId && profile.active));
  requireThat2(profiles.every(Boolean), "The setup contains an archived or unavailable season player. Review its squad.");
  requireThat2(Array.isArray(allocations) && allocations.length === formation.format && new Set(allocations.map((row) => row.slotId)).size === formation.format && new Set(allocations.map((row) => row.playerId)).size === formation.format, "Assign one distinct player to every formation place.");
  for (const row of allocations) {
    const slot = formation.slots.find((item) => item.id === row.slotId), profile = profiles.find((item) => item?.playerId === row.playerId);
    requireThat2(slot && slot.position === row.position && profile && profile.eligiblePositions.includes(slot.position), "Every assigned player must be in the selected squad and eligible for that saved place.");
    requireThat2(slot.position !== "GK" || profile.preferences.slice(0, 2).includes("GK"), "The goalkeeper must be eligible with goalkeeper as a first or second preference.");
  }
}
function saveLineupTemplate(state, input) {
  requireThat2(id(input.templateId) && version(input.expectedTemplateVersion), "Use a stable setup identity and reviewed version.");
  const existing = latest(state).find((item) => item.id === input.templateId);
  requireThat2((existing?.version ?? 0) === input.expectedTemplateVersion, "This setup changed. Open its latest version before saving.");
  requireThat2(existing?.active || latestLineupTemplates(state).length < 3, "This team already has three saved setups. Edit one or archive a setup before adding another.");
  requireThat2(typeof input.name === "string" && input.name.trim().length > 0 && input.name.trim().length <= 60 && !/[\u0000-\u001f\u007f]/.test(input.name), "Give this setup a name of at most 60 characters.");
  const formation = state.formations.find((item) => item.id === input.formationId);
  requireThat2(formation, "Choose a saved team formation.");
  validateSetup(state, formation, input.selectedPlayerIds, input.allocations);
  return copy2({ id: input.templateId, version: (existing?.version ?? 0) + 1, teamId: state.team.id, seasonId: state.activeSeasonId, name: input.name.trim(), active: true, formation, selectedPlayerIds: input.selectedPlayerIds, allocations: input.allocations });
}
function archiveLineupTemplate(state, input) {
  const existing = latest(state).find((item) => item.id === input.templateId && item.active);
  requireThat2(existing && version(input.expectedTemplateVersion) && existing.version === input.expectedTemplateVersion, "Open the latest saved setup before archiving it.");
  return copy2({ ...existing, version: existing.version + 1, active: false });
}
function today2(nowMs) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(nowMs));
  return `${parts.find((item) => item.type === "year").value}-${parts.find((item) => item.type === "month").value}-${parts.find((item) => item.type === "day").value}`;
}
function previewLineupTemplate(state, templateId, fixtureId, context = {}) {
  const template = latestLineupTemplates(state).find((item) => item.id === templateId), fixture = state.fixtures.find((item) => item.id === fixtureId && item.seasonId === state.activeSeasonId);
  const blockers = [], warnings = [];
  if (!template) blockers.push("This saved setup is unavailable.");
  if (!fixture || fixture.status !== "scheduled" || fixture.playedDate < today2(context.nowMs ?? Date.now())) blockers.push("Choose a scheduled current or future fixture.");
  if (context.protectedFixtureIds?.includes(fixtureId)) blockers.push("This fixture has recording or control history. Its saved setup cannot be replaced.");
  if (template && fixture) {
    if (template.formation.format !== fixture.format) blockers.push("The setup and fixture must use the same number of pitch places.");
    try {
      validateSetup(state, template.formation, template.selectedPlayerIds, template.allocations);
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : "Review the current squad and eligible positions.");
    }
    for (const playerId of template.selectedPlayerIds) {
      const profile = state.profiles.find((item) => item.playerId === playerId && item.seasonId === fixture.seasonId);
      if (profile && fixture.responses[profile.id] === "unavailable") warnings.push(`${profile.displayName} has replied Unavailable. Applying a draft does not change that reply or check anyone in.`);
    }
  }
  return { ready: blockers.length === 0, template, fixtureId, sourceRevision: state.revision, previewKey: JSON.stringify([state.team.id, state.activeSeasonId, state.revision, templateId, template?.version ?? null, fixtureId]), blockers, warnings };
}
function applyLineupTemplate(state, input, context = {}) {
  const preview = previewLineupTemplate(state, input.templateId, input.fixtureId, context);
  requireThat2(input.confirm === true && preview.ready && preview.template && preview.template.version === input.templateVersion && input.previewKey === preview.previewKey, preview.blockers.join(" ") || "This setup preview changed. Review the latest fixture and squad before applying it.");
  return copy2({ templateId: preview.template.id, templateVersion: preview.template.version, appliedRevision: state.revision + 1, formation: { ...preview.template.formation, id: `lineup-template:${preview.template.id}:${preview.template.version}`, name: preview.template.name }, selectedPlayerIds: preview.template.selectedPlayerIds, allocations: preview.template.allocations });
}
function validateFixtureLineupTemplate(state, fixture) {
  const draft = fixture.lineupTemplateDraft;
  requireThat2(draft, "No saved setup is applied to this fixture.");
  requireThat2(draft.formation.format === fixture.format, "The saved setup no longer matches this fixture format. Clear it and review another setup.");
  const selected = fixture.selectedProfileIds.map((profileId) => state.profiles.find((profile) => profile.id === profileId)?.playerId);
  requireThat2(selected.length === draft.selectedPlayerIds.length && selected.every((playerId) => playerId !== void 0 && draft.selectedPlayerIds.includes(playerId)), "The selected squad changed after applying this setup. Clear the draft and review it again.");
  validateSetup(state, draft.formation, draft.selectedPlayerIds, draft.allocations);
}

// packages/application/src/preparation.ts
var positionCodes = [...CORE_POSITION_CODES];
function requireThat3(condition, message) {
  if (!condition) throw new Error(message);
}
var clone = (value) => JSON.parse(JSON.stringify(value));
function text(value, label2, maximum = 80) {
  requireThat3(
    typeof value === "string" && value.trim().length > 0 && value.trim().length <= maximum,
    `${label2} is required and must be at most ${maximum} characters.`
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
function validTime(value) {
  return value === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
function validateFormat(format2) {
  requireThat3(
    Number.isInteger(format2) && format2 >= 5 && format2 <= 11,
    "Choose a format from five to eleven players."
  );
}
function validateHalf(duration2) {
  requireThat3(
    Number.isSafeInteger(duration2) && duration2 > 0 && duration2 % 1e3 === 0,
    "Each planned half must be a positive whole number of seconds."
  );
}
function validateLogo(logo) {
  requireThat3(
    logo === null || ["roundel", "shield", "ball"].includes(logo),
    "Choose one of the sample badges."
  );
}
function activeSeason(state, seasonId) {
  const season = state.seasons.find((item) => item.id === seasonId);
  requireThat3(season, "Season not found.");
  requireThat3(
    seasonId === state.activeSeasonId,
    "Past seasons are read-only here. Their records are retained unchanged."
  );
  return season;
}
function dateInSeason(state, seasonId, date) {
  const season = activeSeason(state, seasonId);
  requireThat3(
    validDate(date) && date >= season.startDate && date <= season.endDate,
    "Choose a valid date within the selected September-to-August season."
  );
}
function checkProfile(state, profileId, seasonId) {
  const profile = state.profiles.find(
    (item) => item.id === profileId && item.seasonId === seasonId && item.active
  );
  requireThat3(profile, "Choose an active player from this team and season.");
  return profile;
}
function validResponse(value) {
  requireThat3(
    ["available", "unavailable", "unsure", "no_reply"].includes(value),
    "Choose an availability response."
  );
}
function validAttendance(value) {
  requireThat3(
    ["present", "absent", "not_recorded"].includes(value),
    "Choose Present, Absent or Not recorded."
  );
}
function unique(ids) {
  requireThat3(
    new Set(ids).size === ids.length,
    "Each player or slot can appear only once."
  );
}
function validateTraining(state, training) {
  text(training.id, "Training identity", 150);
  dateInSeason(state, training.seasonId, training.date);
  requireThat3(
    validTime(training.time) && training.time !== null,
    "Use a 24-hour HH:MM training time."
  );
  requireThat3(
    typeof training.venue === "string" && training.venue.length <= 200,
    "Use a training venue of at most 200 characters."
  );
  requireThat3(
    training.recurrenceGroupId === null || typeof training.recurrenceGroupId === "string" && training.recurrenceGroupId.trim().length > 0 && training.recurrenceGroupId.length <= 150,
    "Use a valid training series identity."
  );
  requireThat3(
    Array.isArray(training.expectedProfileIds),
    "Choose the expected players explicitly."
  );
  unique(training.expectedProfileIds);
  training.expectedProfileIds.forEach(
    (id5) => checkProfile(state, id5, training.seasonId)
  );
}
function seasonBounds(startYear) {
  requireThat3(
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
  requireThat3(
    fixture && fixture.status === "scheduled",
    "Only a scheduled match can be prepared."
  );
  activeSeason(state, fixture.seasonId);
  if (fixture.lineupTemplateDraft && fixture.lineupTemplateDraft.formation.id === formationId)
    validateFixtureLineupTemplate(state, fixture);
  if (fixture.matchPlanDraft && fixture.matchPlanDraft.formation.id === formationId)
    validateFixtureMatchPlan(state, fixture);
  const formation = fixture.lineupTemplateDraft && fixture.lineupTemplateDraft.formation.id === formationId ? fixture.lineupTemplateDraft.formation : fixture.matchPlanDraft && fixture.matchPlanDraft.formation.id === formationId ? fixture.matchPlanDraft.formation : state.formations.find(
    (item) => item.id === (formationId ?? `formation-${fixture.format}`)
  );
  requireThat3(
    formation && formation.format === fixture.format,
    "Choose a saved formation for this match format."
  );
  assertActiveFormationPositions(state, formation);
  requireThat3(
    fixture.selectedProfileIds.length >= fixture.format,
    "Select enough players for the match format."
  );
  const profiles = fixture.selectedProfileIds.map(
    (id5) => checkProfile(state, id5, fixture.seasonId)
  );
  requireThat3(
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
    lineupTemplateDraft: _lineupDraft,
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
    ...fixture.matchPlanDraft?.formation.id === formation.id ? { matchPlanDraft: fixture.matchPlanDraft } : {},
    ...fixture.lineupTemplateDraft?.formation.id === formation.id ? { lineupTemplateDraft: fixture.lineupTemplateDraft } : {}
  });
}
function saveProfile(state, source2) {
  const profile = clone(source2);
  activeSeason(state, profile.seasonId);
  text(profile.id, "Profile identity", 150);
  text(profile.playerId, "Player identity", 150);
  const existing = state.profiles.find((item) => item.id === profile.id);
  if (existing)
    requireThat3(
      existing.playerId === profile.playerId && existing.seasonId === profile.seasonId,
      "Profile identity and season cannot be reassigned."
    );
  requireThat3(
    !state.profiles.some(
      (item) => item.id !== profile.id && item.seasonId === profile.seasonId && item.playerId === profile.playerId
    ),
    "That player already has a profile in this season."
  );
  if (profile.faPlayerId !== void 0)
    profile.faPlayerId = normaliseFaPlayerId(profile.faPlayerId);
  profile.displayName = text(profile.displayName, "Display name", 60);
  requireThat3(
    typeof profile.initials === "string" && /^[A-Za-z0-9]{1,2}$/.test(profile.initials),
    "Use one or two letters or digits for the pitch label."
  );
  profile.initials = profile.initials.toUpperCase();
  requireThat3(
    profile.shirtNumber === null || Number.isInteger(profile.shirtNumber) && profile.shirtNumber >= 1 && profile.shirtNumber <= 99,
    "Shirt number must be one to 99 or not recorded."
  );
  requireThat3(
    !state.profiles.some(
      (item) => item.id !== profile.id && item.seasonId === profile.seasonId && item.active && profile.active && profile.shirtNumber !== null && item.shirtNumber === profile.shirtNumber
    ),
    "Another active player already has that shirt number."
  );
  requireThat3(
    profile.preferences.length === 3 && new Set(profile.preferences).size === 3 && profile.preferences.every(
      (position) => allowedProfilePosition(state, position, existing?.preferences)
    ),
    "Choose three different ranked positions."
  );
  requireThat3(
    profile.eligiblePositions.length > 0 && new Set(profile.eligiblePositions).size === profile.eligiblePositions.length && profile.eligiblePositions.every(
      (position) => allowedProfilePosition(state, position, existing?.eligiblePositions)
    ),
    "Choose distinct manager-approved eligible positions."
  );
  requireThat3(
    ["left", "right", "both", "not_recorded"].includes(profile.foot),
    "Choose a preferred foot or Not recorded."
  );
  state.profiles = state.profiles.filter((item) => item.id !== profile.id);
  state.profiles.push(profile);
  return profile;
}
function validateRosterImport(state, profiles) {
  requireThat3(
    Array.isArray(profiles) && profiles.length > 0 && profiles.length <= 200,
    "Import between one and 200 new player profiles."
  );
  const candidate = clone(state);
  return Array.from(profiles).map((profile) => {
    requireThat3(
      profile && typeof profile === "object" && (Object.keys(profile).length === 10 || Object.keys(profile).length === 11 && Object.hasOwn(profile, "faPlayerId")) && Object.keys(profile).every(
        (key) => [
          "id",
          "playerId",
          "seasonId",
          "displayName",
          "initials",
          "shirtNumber",
          "faPlayerId",
          "foot",
          "preferences",
          "eligiblePositions",
          "active"
        ].includes(key)
      ),
      "Use only the documented player profile fields; accounts, contacts and dates of birth cannot be imported."
    );
    requireThat3(
      Array.isArray(profile.preferences) && Array.isArray(profile.eligiblePositions),
      "Provide ranked preferences and explicit eligible positions."
    );
    requireThat3(
      typeof profile.initials === "string" && profile.initials.length >= 1 && profile.initials.length <= 2 && !/[^A-Za-z0-9]/.test(profile.initials),
      "Use one or two letters or digits for the pitch label."
    );
    requireThat3(
      profile.active === true && profile.seasonId === state.activeSeasonId,
      "Import active players into the current season only."
    );
    for (const id5 of [profile.id, profile.playerId])
      requireThat3(
        typeof id5 === "string" && id5.length >= 1 && id5.length <= 150 && !/[^A-Za-z0-9_.:-]/.test(id5),
        "Use a valid opaque player/profile identity of at most 150 characters."
      );
    requireThat3(
      !candidate.profiles.some(
        (existing) => existing.id === profile.id || existing.playerId === profile.playerId
      ),
      "A player or profile identity already exists. Import never merges identities; edit that player separately."
    );
    return saveProfile(candidate, profile);
  });
}
function normaliseFaPlayerId(value) {
  if (value === null || value === "") return null;
  requireThat3(
    typeof value === "string" && /^[0-9]{1,20}$/.test(value.trim()),
    "Use an FA player ID of up to 20 digits, or leave it blank."
  );
  return value.trim();
}
function validateRosterProformaImport(state, profiles) {
  requireThat3(
    Array.isArray(profiles) && profiles.length > 0 && profiles.length <= 200,
    "Import between one and 200 player rows."
  );
  const ids = /* @__PURE__ */ new Set(), players = /* @__PURE__ */ new Set();
  for (const profile of profiles) {
    requireThat3(
      profile && typeof profile === "object" && !Array.isArray(profile),
      "Use a valid player profile."
    );
    requireThat3(
      Object.keys(profile).every(
        (key) => [
          "id",
          "playerId",
          "seasonId",
          "displayName",
          "initials",
          "shirtNumber",
          "faPlayerId",
          "foot",
          "preferences",
          "eligiblePositions",
          "active"
        ].includes(key)
      ),
      "Use only the documented proforma fields."
    );
    requireThat3(
      profile.active === true && profile.seasonId === state.activeSeasonId,
      "Import active players into the current season only."
    );
    requireThat3(
      !ids.has(profile.id) && !players.has(profile.playerId),
      "Each player may appear only once in a proforma."
    );
    ids.add(profile.id);
    players.add(profile.playerId);
    for (const value of [profile.id, profile.playerId])
      requireThat3(
        typeof value === "string" && /^[A-Za-z0-9_.:-]{1,150}$/.test(value),
        "Use a valid opaque player/profile identity."
      );
    const byId = state.profiles.find((item) => item.id === profile.id);
    const byPlayer = state.profiles.find(
      (item) => item.playerId === profile.playerId && item.seasonId === state.activeSeasonId
    );
    if (byId || byPlayer)
      requireThat3(
        byId && byPlayer && byId.id === byPlayer.id && byId.playerId === profile.playerId && byId.seasonId === state.activeSeasonId && byId.active,
        "An existing player must retain their downloaded profile and player identities."
      );
    else
      requireThat3(
        !state.profiles.some((item) => item.playerId === profile.playerId),
        "A new row cannot adopt a player identity from another season."
      );
    requireThat3(
      Array.isArray(profile.preferences) && Array.isArray(profile.eligiblePositions),
      "Provide preferences and eligible positions."
    );
  }
  const candidate = clone(state);
  candidate.profiles = candidate.profiles.filter((item) => !ids.has(item.id));
  return profiles.map((profile) => saveProfile(candidate, profile));
}
function reducePreparation(previous, command, context = {}) {
  requireThat3(
    command.id && typeof command.id === "string",
    "A stable command identity is required."
  );
  const signature2 = canonical3(command);
  if (previous.appliedCommands[command.id]) {
    requireThat3(
      previous.appliedCommands[command.id] === signature2,
      "This command identity already belongs to different content."
    );
    return previous;
  }
  requireThat3(
    command.expectedRevision === previous.revision,
    "Preparation changed on another screen. Reload the saved version before applying this change."
  );
  const state = clone(previous);
  const revision = state.revision + 1;
  switch (command.type) {
    case "position.saved":
      state.positionCatalogue = saveTeamPosition(state, command.position);
      break;
    case "position.archived":
      state.positionCatalogue = archiveTeamPosition(state, command.code);
      break;
    case "club.updated":
      validateLogo(command.logo);
      state.club = {
        ...state.club,
        name: text(command.name, "Club name"),
        logo: command.logo
      };
      break;
    case "team.league_updated":
      requireThat3(
        typeof command.league === "string" && command.league.trim().length <= 120 && !/[\u0000-\u001f]/.test(command.league),
        "Use a league name of at most 120 characters, or leave it blank."
      );
      state.team.league = command.league.trim();
      break;
    case "team.alerts_updated": {
      const settings = command.substitutionAlerts;
      requireThat3(
        settings && typeof settings === "object" && Object.keys(settings).length === 3 && typeof settings.enabled === "boolean" && Number.isInteger(settings.leadSeconds) && settings.leadSeconds >= 0 && settings.leadSeconds <= 300 && Number.isFinite(settings.volume) && settings.volume >= 0 && settings.volume <= 1,
        "Use substitution alert lead time from zero to 300 seconds and volume from zero to 100%."
      );
      state.substitutionAlerts = {
        enabled: settings.enabled,
        leadSeconds: settings.leadSeconds,
        volume: settings.volume
      };
      break;
    }
    case "roster.proforma_imported": {
      requireThat3(
        command.confirmChanges === true,
        "Review and confirm all new and updated player rows."
      );
      const imported = validateRosterProformaImport(state, command.profiles);
      const ids = new Set(imported.map((profile) => profile.id));
      state.profiles = [
        ...state.profiles.filter((profile) => !ids.has(profile.id)),
        ...imported
      ];
      break;
    }
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
      requireThat3(
        command.confirmSpectatorRenewal === true,
        "Confirm that spectator access must be renewed explicitly."
      );
      const old = state.seasons.find(
        (item) => item.id === state.activeSeasonId
      );
      requireThat3(
        command.startYear === old.startYear + 1,
        "Rollover creates the immediately following September-to-August season."
      );
      requireThat3(
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
      requireThat3(
        command.id.length <= 150 && !/[^A-Za-z0-9_.:-]/.test(command.id),
        "Use a valid stable roster import identity."
      );
      requireThat3(
        command.confirmNewPlayers === true,
        "Confirm that every imported row creates a new player; no accounts or access are granted."
      );
      requireThat3(
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
      requireThat3(profile, "Player profile not found.");
      activeSeason(state, profile.seasonId);
      profile.active = false;
      break;
    }
    case "formation.saved": {
      const formation = clone(command.formation);
      validateFormat(formation.format);
      formation.name = text(formation.name, "Formation name", 40);
      requireThat3(
        formation.slots.length === formation.format && formation.slots.filter((slot) => slot.position === "GK").length === 1,
        "A formation needs the chosen number of slots and exactly one goalkeeper."
      );
      unique(formation.slots.map((slot) => slot.id));
      assertActiveFormationPositions(state, formation);
      for (const slot of formation.slots) {
        requireThat3(
          slot.id.length > 0 && activePositionCodes(state).includes(slot.position),
          "Each slot needs an identity and position type."
        );
        slot.label = text(slot.label, "Slot label", 16);
        requireThat3(
          Number.isFinite(slot.x) && slot.x >= 0 && slot.x <= 1 && Number.isFinite(slot.y) && slot.y >= 0 && slot.y <= 1,
          "Formation coordinates must be between zero and one."
        );
      }
      const version2 = (state.formations.find((item) => item.id === formation.id)?.version ?? 0) + 1;
      state.formations = state.formations.filter(
        (item) => item.id !== formation.id
      );
      state.formations.push({ ...formation, version: version2 });
      break;
    }
    case "fixture.saved": {
      const fixture = clone(command.fixture);
      dateInSeason(state, fixture.seasonId, fixture.playedDate);
      validateFormat(fixture.format);
      validateHalf(fixture.plannedHalfDurationMs);
      fixture.opponent = text(fixture.opponent, "Opposition");
      requireThat3(
        validTime(fixture.kickoff) && validTime(fixture.arrival),
        "Use 24-hour HH:MM times, or leave time not recorded."
      );
      requireThat3(
        ["home", "away"].includes(fixture.homeAway),
        "Choose home or away."
      );
      const existing = state.fixtures.find((item) => item.id === fixture.id);
      if (existing)
        requireThat3(
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
        ...existing?.matchPlanDraft ? { matchPlanDraft: existing.matchPlanDraft } : {},
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
      requireThat3(fixture, "Match not found.");
      activeSeason(state, fixture.seasonId);
      requireThat3(
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
      requireThat3(fixture, "Match not found.");
      activeSeason(state, fixture.seasonId);
      requireThat3(
        fixture.status === "scheduled",
        "Only a scheduled match can collect responses, selection or attendance."
      );
      if (command.type === "fixture.selection_saved") {
        unique(command.selectedProfileIds);
        command.selectedProfileIds.forEach(
          (id5) => checkProfile(state, id5, fixture.seasonId)
        );
        fixture.selectedProfileIds = [...command.selectedProfileIds];
      } else {
        checkProfile(state, command.profileId, fixture.seasonId);
        if (command.type === "fixture.response_recorded") {
          validResponse(command.response);
          fixture.responses[command.profileId] = command.response;
        } else {
          validAttendance(command.attendance);
          requireThat3(
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
      applyTrainingSeries(
        state,
        command,
        (draft) => validateTraining(state, draft)
      );
      break;
    }
    case "lineup_template.saved":
      state.lineupTemplates = [
        ...state.lineupTemplates ?? [],
        saveLineupTemplate(state, command)
      ];
      break;
    case "lineup_template.archived":
      state.lineupTemplates = [
        ...state.lineupTemplates ?? [],
        archiveLineupTemplate(state, command)
      ];
      break;
    case "lineup_template.applied": {
      const draft = applyLineupTemplate(state, command, context);
      const fixture = state.fixtures.find(
        (item) => item.id === command.fixtureId
      );
      fixture.lineupTemplateDraft = draft;
      fixture.selectedProfileIds = draft.selectedPlayerIds.map(
        (playerId) => state.profiles.find(
          (profile) => profile.playerId === playerId && profile.seasonId === fixture.seasonId && profile.active
        ).id
      );
      delete fixture.matchPlanDraft;
      break;
    }
    case "lineup_template.cleared": {
      const fixture = state.fixtures.find(
        (item) => item.id === command.fixtureId
      );
      requireThat3(
        fixture && fixture.seasonId === state.activeSeasonId && fixture.status === "scheduled",
        "Choose a scheduled fixture in the current season."
      );
      requireThat3(
        !context.protectedFixtureIds?.includes(fixture.id),
        "A saved or recorded match keeps its prepared lineup."
      );
      delete fixture.lineupTemplateDraft;
      break;
    }
    case "match_plan.saved": {
      const {
        type: _type,
        id: _id,
        expectedRevision: _revision,
        ...input
      } = command;
      const plan = saveMatchPlan(state, input);
      state.matchPlans = [...state.matchPlans ?? [], plan];
      break;
    }
    case "match_plan.applied": {
      const {
        type: _type,
        id: _id,
        expectedRevision: _revision,
        ...input
      } = command;
      const draft = applyMatchPlan(state, input, context);
      state.fixtures.find(
        (item) => item.id === command.fixtureId
      ).matchPlanDraft = draft;
      delete state.fixtures.find((item) => item.id === command.fixtureId).lineupTemplateDraft;
      break;
    }
    case "match_plan.cleared": {
      const fixture = state.fixtures.find(
        (item) => item.id === command.fixtureId
      );
      requireThat3(
        fixture && fixture.seasonId === state.activeSeasonId,
        "Choose a fixture in the current season."
      );
      delete fixture.matchPlanDraft;
      break;
    }
    case "training.saved": {
      const training = clone(command.training);
      validateTraining(state, training);
      const existing = state.training.find((item) => item.id === training.id);
      if (existing)
        requireThat3(
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
      requireThat3(training, "Training occurrence not found.");
      activeSeason(state, training.seasonId);
      requireThat3(
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
      requireThat3(training, "Training occurrence not found.");
      activeSeason(state, training.seasonId);
      checkProfile(state, command.profileId, training.seasonId);
      requireThat3(
        training.expectedProfileIds.includes(command.profileId),
        "Only expected players belong to this attendance occurrence."
      );
      if (command.type === "training.response_recorded") {
        requireThat3(
          training.status !== "cancelled",
          "Cancelled training cannot collect availability."
        );
        validResponse(command.response);
        training.responses[command.profileId] = command.response;
      } else {
        requireThat3(
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
    sourcePreparationRevision: state.revision,
    sourceCommandId: state.audit.at(-1)?.id ?? null,
    sessionId: session.id,
    playedDate: session.date,
    eventStatus: session.status,
    expectedPlayerIds: session.expectedProfileIds.map(
      (id5) => state.profiles.find((profile) => profile.id === id5)?.playerId
    ).filter((id5) => Boolean(id5)),
    attendance: Object.fromEntries(
      Object.entries(session.attendance).flatMap(([id5, attendance]) => {
        const profile = state.profiles.find((item) => item.id === id5);
        return profile ? [[profile.playerId, attendance]] : [];
      })
    ),
    responses: Object.fromEntries(
      Object.entries(session.responses).flatMap(([id5, response]) => {
        const profile = state.profiles.find((item) => item.id === id5);
        return profile ? [[profile.playerId, response]] : [];
      })
    )
  }));
}
function createPreparationState(options = {}) {
  const seasonId = "synthetic-season-2026-27";
  const profiles = romaFixture.players.map((player) => {
    const details = romaFixture.profiles.find(
      (profile) => profile.playerId === player.id
    );
    const preferences = [...details.preferences];
    return {
      id: `${player.id}:${seasonId}`,
      playerId: player.id,
      seasonId,
      displayName: player.displayName,
      initials: details.initials,
      shirtNumber: details.shirtNumber,
      foot: details.foot,
      preferences,
      eligiblePositions: [...details.eligiblePositions],
      active: true
    };
  });
  const fixtures = romaFixture.fixtures.map(
    (item, index) => {
      const selected = options.demoScenario ? item.selectedPlayerIds.map(
        (playerId) => profiles.find((profile) => profile.playerId === playerId)
      ) : profiles.slice(0, item.selectedCount);
      const past = item.playedDate < romaFixture.demo.referenceDate;
      return {
        id: item.id,
        seasonId,
        opponent: item.opponent,
        playedDate: item.playedDate,
        kickoff: item.kickoff,
        arrival: item.arrival,
        venue: item.venue,
        homeAway: item.homeAway,
        format: 7,
        plannedHalfDurationMs: 15e5,
        status: item.status,
        selectedProfileIds: selected.map((profile) => profile.id),
        responses: Object.fromEntries(
          profiles.flatMap(
            (profile, playerIndex) => {
              if (index === 0)
                return selected.some((item2) => item2.id === profile.id) ? [[profile.id, "available"]] : [];
              if (past)
                return [
                  [
                    profile.id,
                    selected.some((item2) => item2.id === profile.id) ? "available" : "unavailable"
                  ]
                ];
              return playerIndex < 6 ? [[profile.id, "available"]] : playerIndex === 6 ? [[profile.id, "unsure"]] : playerIndex === profiles.length - 1 ? [[profile.id, "unavailable"]] : [];
            }
          )
        ),
        attendance: past ? Object.fromEntries(
          selected.map((profile) => [profile.id, "present"])
        ) : {},
        history: [
          {
            revision: 0,
            action: "created",
            playedDate: item.playedDate,
            kickoff: item.kickoff,
            status: item.status
          }
        ]
      };
    }
  );
  const training = romaFixture.training.map(
    (item, sessionIndex) => ({
      ...item,
      seasonId,
      recurrenceGroupId: "synthetic-thursday-training",
      status: item.status,
      expectedProfileIds: profiles.map((profile) => profile.id),
      responses: item.status === "held" ? Object.fromEntries(
        profiles.map((profile, index) => [
          profile.id,
          index === (sessionIndex + 3) % profiles.length ? "unavailable" : "available"
        ])
      ) : {},
      attendance: item.status === "held" ? Object.fromEntries(
        profiles.map((profile, index) => [
          profile.id,
          index === (sessionIndex + 3) % profiles.length ? "absent" : "present"
        ])
      ) : {}
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
    positionCatalogue: defaultPositionCatalogue(),
    formations: Array.from(
      { length: 7 },
      (_, index) => defaultFormation(index + 5)
    ),
    fixtures,
    training,
    snapshots: [],
    appliedCommands: {},
    audit: []
  };
}

// packages/application/src/lineup-autofill.ts
function autoFillLineup(input) {
  const fail7 = (reason) => ({ status: "infeasible", reason, unfilledSlotIds: input.slots.map((slot) => slot.slotId) });
  if (input.slots.length < 1 || input.slots.length > 11 || input.players.length > 100 || input.slots.filter((slot) => slot.position === "GK").length !== 1 || new Set(input.slots.map((slot) => slot.slotId)).size !== input.slots.length || input.slots.some((slot) => !slot.slotId || !slot.position) || new Set(input.players.map((player) => player.id)).size !== input.players.length || input.players.some((player) => !player.id)) return fail7("Review the saved places and distinct player identities before filling a lineup.");
  const players = input.players.filter((player) => player.available).slice().sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (players.length < input.slots.length) return fail7(`Only ${players.length} available players can fill ${input.slots.length} places. Record actual availability or choose a different planning squad.`);
  const count = 1 << input.slots.length;
  let states = new Array(count);
  states[0] = { cost: 0, assigned: input.slots.map(() => null), key: "" };
  for (const player of players) {
    const next = states.slice();
    for (let mask = 0; mask < count; mask++) {
      const previous = states[mask];
      if (!previous) continue;
      for (let place = 0; place < input.slots.length; place++) {
        const slot = input.slots[place], bit = 1 << place;
        if (mask & bit || !player.eligiblePositions.includes(slot.position)) continue;
        if (slot.position === "GK" && (![1, 2].includes(player.goalkeeperChoice) || !player.preferences.slice(0, 2).includes("GK") || input.fixedKeeperId && input.fixedKeeperId !== player.id)) continue;
        if (slot.position !== "GK" && input.fixedKeeperId === player.id) continue;
        const rank = player.preferences.indexOf(slot.position), cost = previous.cost + (rank >= 0 && rank <= 2 ? rank : 4);
        const assigned = previous.assigned.slice();
        assigned[place] = player.id;
        const key = JSON.stringify(assigned), existing = next[mask | bit];
        if (!existing || cost < existing.cost || cost === existing.cost && key < existing.key) next[mask | bit] = { cost, assigned, key };
      }
    }
    states = next;
  }
  const result = states[count - 1];
  if (!result) return fail7("No complete eligible lineup is available for these places. Review goalkeeper cover, approved positions and actual availability; no partial lineup was staged.");
  return { status: "complete", preferenceCost: result.cost, allocations: input.slots.map((slot, index) => ({ slotId: slot.slotId, position: slot.position, playerId: result.assigned[index] })) };
}

// packages/application/src/demo-season.ts
function createDemoCompletedMatches() {
  return romaFixture.fixtures.filter((fixture) => fixture.demoPhase === "completed").map((fixture, matchIndex) => {
    const selected = [...fixture.selectedPlayerIds];
    if (selected.length !== 8) throw new Error("The recorded Roma demo needs its eight-player squad.");
    const profiles = selected.map((playerId) => romaFixture.profiles.find((profile) => profile.playerId === playerId));
    const kickoff = Date.parse(`${fixture.playedDate}T${fixture.kickoff}:00+01:00`);
    const positions = ["GK", "CB", "CB", "CM", "LW", "RW", "ST"];
    const config = {
      matchId: fixture.id,
      players: romaFixture.players.map((player) => ({
        id: player.id,
        displayName: player.displayName,
        goalkeeperChoice: player.goalkeeperChoice,
        positionPreferences: [...romaFixture.profiles.find((profile) => profile.playerId === player.id).preferences]
      })),
      selectedPlayerIds: selected,
      pitchPlaces: 7,
      plannedHalfDurationMs: 15e5,
      fixedKeeperId: selected[0],
      fixture: {
        opponent: fixture.opponent,
        playedDate: fixture.playedDate,
        kickoff: fixture.kickoff,
        homeAway: fixture.homeAway,
        teamId: romaFixture.teamId,
        seasonId: "synthetic-season-2026-27",
        teamName: "Roma",
        clubName: romaFixture.club.name
      },
      slots: positions.map((position, index) => ({ slotId: `demo-slot-${index}`, position })),
      profileSnapshot: profiles.map((profile) => ({
        playerId: profile.playerId,
        initials: profile.initials,
        preferences: [...profile.preferences],
        eligiblePositions: [...profile.eligiblePositions]
      }))
    };
    let state = createMatch(config), sequence = 0;
    const send = (command, milliseconds) => {
      state = reduceMatch(state, {
        ...command,
        id: `${fixture.id}-demo-${++sequence}`,
        actorId: "synthetic-account-manager",
        sample: { monotonicMs: milliseconds, sessionId: `demo-history-${fixture.id}`, wallTimeMs: kickoff + milliseconds }
      });
    };
    const benchOrder = (matchIndex % 2 === 0 ? [3, 4, 1, 2, 5, 6, 7, 3] : [4, 3, 2, 1, 6, 5, 7, 4]).map((index) => selected[index]);
    const stintLineup = (stint) => {
      const filled = autoFillLineup({
        slots: config.slots,
        fixedKeeperId: config.fixedKeeperId,
        players: selected.map((playerId) => {
          const profile = profiles.find((item) => item.playerId === playerId);
          return {
            id: playerId,
            preferences: profile.preferences,
            eligiblePositions: profile.eligiblePositions,
            goalkeeperChoice: config.players.find((player) => player.id === playerId).goalkeeperChoice,
            available: playerId !== benchOrder[stint]
          };
        })
      });
      if (filled.status !== "complete") throw new Error(`The recorded Roma lineup is unavailable: ${filled.reason}`);
      return filled.allocations;
    };
    for (const playerId of selected) send({ type: "attendance.recorded", playerId, status: "present" }, 0);
    send({ type: "lineup.staged", lineup: stintLineup(0) }, 0);
    send({ type: "half.started" }, 0);
    send({ type: "lineup.committed", sourceRevision: state.revision, lineup: stintLineup(1) }, 375e3);
    send({ type: "goal.recorded", beneficiary: "us", scorerPlayerId: selected[1], goalType: "open_play" }, 8 * 6e4);
    send({ type: "lineup.committed", sourceRevision: state.revision, lineup: stintLineup(2) }, 75e4);
    send({ type: "goal.recorded", beneficiary: "opposition", scorerPlayerId: null, goalType: "open_play" }, 18 * 6e4);
    send({ type: "lineup.committed", sourceRevision: state.revision, lineup: stintLineup(3) }, 1125e3);
    send({ type: "half.ended" }, 15e5);
    send({ type: "lineup.staged", lineup: stintLineup(4) }, 18e5);
    send({ type: "half.started" }, 18e5);
    send({ type: "lineup.committed", sourceRevision: state.revision, lineup: stintLineup(5) }, 2175e3);
    send({ type: "goal.recorded", beneficiary: "us", scorerPlayerId: selected[7], goalType: "open_play" }, 222e4);
    send({ type: "lineup.committed", sourceRevision: state.revision, lineup: stintLineup(6) }, 255e4);
    send({ type: "lineup.committed", sourceRevision: state.revision, lineup: stintLineup(7) }, 2925e3);
    send({
      type: "goal.recorded",
      beneficiary: fixture.id === "synthetic-history-oak" ? "opposition" : "us",
      scorerPlayerId: fixture.id === "synthetic-history-oak" ? null : selected[7],
      goalType: "open_play"
    }, 294e4);
    send({ type: "half.ended" }, 33e5);
    return state;
  });
}

// packages/application/src/invitation-credentials.ts
var validTime2 = (value) => Number.isSafeInteger(value) && value >= 0;
function publicInvitation(invite, nowMs) {
  if (!validTime2(nowMs))
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
function validTime3(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function unique2(values) {
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
function scopedMatch(state, actor, id5) {
  const match = state.matches.find((item) => item.id === id5);
  requireRule(match && match.teamId === actor.teamId && match.seasonId === actor.seasonId, "forbidden", "That match is outside this team and season.");
  return match;
}
function scopedPhoto(state, actor, id5) {
  const photo = state.photos.find((item) => item.id === id5);
  requireRule(photo && photo.teamId === actor.teamId && photo.seasonId === actor.seasonId, "forbidden", "That photo is outside this team and season.");
  return photo;
}
function currentPhoto(photo, version2) {
  if (version2 !== void 0) requireRule(version2 === photo.currentRevision, "conflict", "This photo changed. Review its current revision before continuing.");
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
  const latest2 = /* @__PURE__ */ new Map();
  for (const ballot of state.ballots) if (ballot.matchId === matchId) {
    const previous = latest2.get(ballot.voterPlayerId);
    if (!previous || ballot.revision > previous.revision) latest2.set(ballot.voterPlayerId, ballot);
  }
  return [...latest2.values()];
}
function sealAward(state, match, nowMs) {
  requireRule(match.voteCutoffAtMs !== null && match.finalisationDeadlineAtMs !== null, "invalid", "The award timing evidence is missing.");
  const counts = /* @__PURE__ */ new Map();
  for (const ballot of latestBallots(state, match.id)) if ((ballot.receivedAtMs < match.voteCutoffAtMs || match.cutoffSource === "manager_early_close" && ballot.receivedAtMs === match.voteCutoffAtMs) && eligibleVoter(match, ballot.voterPlayerId) && ballot.voterPlayerId !== ballot.candidatePlayerId && match.playedPlayerIds.includes(ballot.candidatePlayerId)) {
    counts.set(ballot.candidatePlayerId, (counts.get(ballot.candidatePlayerId) ?? 0) + 1);
  }
  const highest = Math.max(0, ...counts.values());
  const winners = [...counts].filter(([, count]) => count === highest).map(([id5]) => id5).sort();
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
  requireRule(["pitch", "ball", "cones"].includes(art), "invalid", "Choose a demo review illustration. Arbitrary URLs and raw image uploads are not supported here.");
  requireRule(typeof caption === "string" && caption.trim().length <= 160, "invalid", "Keep the caption within 160 characters.");
}
function defaultCommunityPreferences() {
  return { schedule: true, match: true, awards: true, photos: true, quietStart: null, quietEnd: null };
}
function applyCommunityCommand(state, actor, command, nowMs) {
  requireRule(validTime3(nowMs), "invalid", "A valid receipt time is required.");
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
      requireRule(next.synthetic === true, "forbidden", "Review codes are available only in the local demo journey.");
      requireRule(actor.role !== "spectator", "forbidden", "Spectators cannot invite other spectators.");
      const season = next.seasons.find((item) => item.id === actor.seasonId && item.teamId === actor.teamId);
      requireRule(season, "invalid", "The team season is missing.");
      requireRule(validTime3(command.expiresAtMs) && nowMs < command.expiresAtMs && command.expiresAtMs <= season.accessEndsAtMs, "invalid", "Choose an invitation expiry after now and before the season ends.");
      requireRule(command.reviewCode.trim().length >= 6 && !next.invitations.some((item) => item.reviewCode === command.reviewCode || item.id === command.invitationId), "invalid", "The demo invitation identity/code must be unique.");
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
      requireRule(next.synthetic === true, "forbidden", "Review codes are available only in the local demo journey.");
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
      requireRule(validTime3(match.playedAtMs) && unique2(match.selectedPlayerIds) && unique2(match.presentPlayerIds) && unique2(match.playedPlayerIds), "invalid", "The match evidence is invalid.");
      requireRule(match.presentPlayerIds.every((id5) => match.selectedPlayerIds.includes(id5)) && match.playedPlayerIds.every((id5) => match.presentPlayerIds.includes(id5)), "invalid", "Played and present evidence must belong to the selected squad.");
      requireRule(match.selectedPlayerIds.every((id5) => next.memberships.some((member) => member.playerId === id5 && member.teamId === actor.teamId && member.seasonId === actor.seasonId)), "invalid", "Every selected player needs a membership in this team and season.");
      requireRule(match.actualFullTimeAtMs === null || validTime3(match.actualFullTimeAtMs) && match.actualFullTimeAtMs <= nowMs, "invalid", "Actual full time cannot be in the future.");
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
      requireRule(Number.isSafeInteger(command.minutesAfterFullTime) && command.minutesAfterFullTime > 0 && command.minutesAfterFullTime < 60, "invalid", "Choose an explicit demo cutoff from 1 to 59 minutes. This does not approve a production default.");
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
        requireRule(match.voteCutoffAtMs !== null, "policy_needed", "The automatic ballot cutoff is unresolved (Q15). A manager must set an explicit demo cutoff or close deliberately.");
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
      requireRule(preferences.followedPlayerId === void 0 || preferences.followedPlayerId === null || /^[A-Za-z0-9_-]{1,150}$/.test(preferences.followedPlayerId), "invalid", "Choose a current team player.");
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
function finalizeDueCommunityAwards(state, nowMs) {
  requireRule(validTime3(nowMs), "invalid", "A valid worker receipt time is required.");
  const due = state.matches.filter((match) => match.finishQuality === "trusted" && match.actualFullTimeAtMs !== null && match.voteCutoffAtMs !== null && match.cutoffSource !== "unresolved" && nowMs >= match.voteCutoffAtMs && !state.awards.some((award) => award.matchId === match.id));
  if (due.length === 0) return state;
  const next = JSON.parse(JSON.stringify(state));
  for (const source2 of due) {
    const match = next.matches.find((item) => item.id === source2.id);
    sealAward(next, match, nowMs);
    next.audit.push({
      id: `worker:award-finalise:${match.id}:${match.voteCutoffAtMs}`,
      actorAccountId: null,
      action: "award.finalised",
      atMs: nowMs,
      origin: "award_worker"
    });
  }
  next.revision += 1;
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
    invitations: allowed ? scoped(state.invitations).filter((item) => actor.role === "manager" || item.inviterAccountId === actor.accountId).map((item) => ({ ...publicInvitation(item, nowMs), reviewCode: item.credential?.kind === "fictional_review" && state.synthetic === true ? item.credential.code : void 0 })) : [],
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
        candidates: mayVote ? match.playedPlayerIds.filter((id5) => id5 !== actor.playerId).map((id5) => ({ id: id5, label: labelForPlayer(state, id5) })) : [],
        award: share && award ? { ...award, winnerLabels: award.winnerPlayerIds.map((id5) => labelForPlayer(state, id5)) } : null
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
function createCommunityState(nowMs = Date.now(), options = {}) {
  const teamId = "synthetic-roma-u10";
  const seasonId = "synthetic-season-2026-27";
  const playerIds = romaFixture.players.map((player) => player.id);
  const selectedPlayerIds = romaFixture.players.filter((player) => player.available).map((player) => player.id);
  const accounts = [
    { id: "synthetic-account-manager", label: demoAccountLabels["synthetic-account-manager"], classification: "adult_individual", adultVerified: true },
    ...romaFixture.players.map((player) => ({ id: `synthetic-account-player-${player.id.slice(-2)}`, label: player.displayName, classification: "child_shared", adultVerified: false })),
    { id: "synthetic-account-spectator", label: demoAccountLabels["synthetic-account-spectator"], classification: "spectator", adultVerified: false },
    { id: "synthetic-account-invitee", label: demoAccountLabels["synthetic-account-invitee"], classification: "spectator", adultVerified: false }
  ];
  const memberships = [
    { accountId: accounts[0].id, teamId, seasonId, role: "manager", active: true },
    ...playerIds.map((playerId) => ({ accountId: `synthetic-account-player-${playerId.slice(-2)}`, playerId, teamId, seasonId, role: "player", active: true }))
  ];
  const fullTime = Math.max(0, nowMs - 6e5);
  const match = {
    id: "synthetic-community-willow",
    teamId,
    seasonId,
    label: "Roma v Willow FC \xB7 Practice match",
    playedAtMs: Math.max(0, fullTime - 36e5),
    selectedPlayerIds: [...selectedPlayerIds],
    presentPlayerIds: [...selectedPlayerIds],
    playedPlayerIds: [...selectedPlayerIds],
    actualFullTimeAtMs: fullTime,
    finishQuality: "trusted",
    voteCutoffAtMs: null,
    cutoffSource: "unresolved",
    finalisationDeadlineAtMs: fullTime + 36e5,
    sharing: "fictional_review_only",
    policyVersion: 1
  };
  let state = {
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
      caption: "Matchday at Rovers Sports Ground \xB7 illustration",
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
      caption: "Saturday football \xB7 illustration awaiting review",
      status: "pending",
      createdAtMs: fullTime,
      reviewedAtMs: null,
      reviewerAccountId: null,
      rejectionReason: null,
      processing: "synthetic_derivative_ready"
    }]
  });
  if (options.demoScenario) {
    state.matches = createDemoCompletedMatches().map((completed) => ({
      id: completed.config.matchId,
      teamId,
      seasonId,
      label: `Roma ${completed.config.fixture.homeAway === "home" ? "v" : "at"} ${completed.config.fixture.opponent}`,
      playedAtMs: Date.parse(`${completed.config.fixture.playedDate}T${completed.config.fixture.kickoff}:00+01:00`),
      selectedPlayerIds: [...completed.config.selectedPlayerIds],
      presentPlayerIds: [...completed.config.selectedPlayerIds],
      playedPlayerIds: [...completed.config.selectedPlayerIds],
      actualFullTimeAtMs: completed.completedAtMs,
      // Explicitly generated timing evidence for this isolated demo only.
      finishQuality: "trusted",
      voteCutoffAtMs: completed.completedAtMs + 45 * 6e4,
      cutoffSource: "explicit_fictional_setting",
      finalisationDeadlineAtMs: completed.completedAtMs + 60 * 6e4,
      sharing: "fictional_review_only",
      policyVersion: 1
    })).sort((left, right) => right.playedAtMs - left.playedAtMs);
    const latest2 = state.matches[0];
    state.photos = state.photos.map((photo) => ({
      ...photo,
      matchId: latest2.id,
      revisions: photo.revisions.map((revision) => ({
        ...revision,
        createdAtMs: latest2.actualFullTimeAtMs + 5 * 6e4,
        reviewedAtMs: revision.reviewedAtMs === null ? null : latest2.actualFullTimeAtMs + 10 * 6e4
      }))
    }));
    for (const completed of [...state.matches].sort((left, right) => left.playedAtMs - right.playedAtMs)) {
      for (const playerId of completed.selectedPlayerIds) {
        const suffix = playerId.slice(-2), candidatePlayerId = playerId === completed.selectedPlayerIds[1] ? completed.selectedPlayerIds[2] : completed.selectedPlayerIds[1];
        state = applyCommunityCommand(
          state,
          { role: "player", accountId: `synthetic-account-player-${suffix}`, playerId, teamId, seasonId },
          { id: `${completed.id}-demo-vote-${suffix}`, type: "ballot.cast", matchId: completed.id, candidatePlayerId },
          completed.actualFullTimeAtMs + 10 * 6e4
        );
      }
      state = finalizeDueCommunityAwards(state, completed.voteCutoffAtMs + 6e4);
    }
  }
  return state;
}
function communityObjectShape(value, fields5) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const object5 = value;
  return Object.keys(object5).every((key) => Object.hasOwn(fields5, key)) && Object.entries(fields5).every(([key, rule]) => Object.hasOwn(object5, key) ? rule.accepts(object5[key]) : Boolean(rule.optional));
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
  quietEnd: communityNullable(communityText(5)),
  followedPlayerId: communityOptional(communityNullable(communityId))
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

// packages/application/src/records.ts
function clone2(value) {
  return JSON.parse(JSON.stringify(value));
}
function signature(value) {
  if (Array.isArray(value)) return `[${value.map(signature).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== void 0).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${signature(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function nonnegative2(value, label2) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label2} must be a nonnegative whole number.`);
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
function historicalRecord(state, id5, input, at) {
  validateInput(state, input);
  return {
    ...clone2(input),
    opponent: input.opponent.trim(),
    id: id5,
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
function createRecordsSeed(options = {}) {
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
    homeAway: index === 1 ? "away" : "home",
    fixtureClass: example.fixtureClass,
    status: "completed",
    specialOutcome: "ordinary",
    finalScore: example.score,
    halfTimeScore: null,
    goals: index === 0 ? [{ id: "synthetic-history-known-goal", beneficiary: "us", isOwnGoal: false, scorerPlayerId: romaFixture.players[1].id, goalType: null, half: null, halfElapsedMs: null }] : []
  }, "2026-10-20T12:00:00Z"));
  if (options.demoSharing) {
    state.results = createDemoCompletedMatches().map((match) => {
      const fixture = romaFixture.fixtures.find((item) => item.id === match.config.matchId);
      const record = snapshotLiveMatch({ ...state, results: [], liveMatch: {
        matchId: fixture.id,
        playedDate: fixture.playedDate,
        opponent: fixture.opponent,
        homeAway: fixture.homeAway,
        fixtureClass: fixture.fixtureClass
      } }, match, new Date(match.completedAtMs).toISOString());
      return { ...record, recordedKickoff: `${fixture.playedDate}T${fixture.kickoff}:00+01:00` };
    });
    state.initialLivePublication = { matchId: state.liveMatch.matchId, fixtureClass: state.liveMatch.fixtureClass, publication: {
      id: "demo-simulated-scores-v1",
      version: 1,
      fixtureClass: state.liveMatch.fixtureClass,
      confirmed: true,
      confirmationReference: "Generated test scenario only; no competition or real-data approval.",
      allowedRoles: ["player", "spectator"]
    } };
    state.results = state.results.map((record) => ({ ...record, publication: {
      id: "demo-simulated-scores-v1",
      version: 1,
      fixtureClass: record.fixtureClass,
      confirmed: true,
      confirmationReference: "Generated test scenario only; no competition or real-data approval.",
      allowedRoles: ["player", "spectator"]
    } }));
  }
  return state;
}
function snapshotLiveMatch(state, match, at) {
  if (match.config.matchId !== state.liveMatch.matchId) throw new Error("Set this match\u2019s recorded fixture details before reporting it.");
  const previousRecord = state.results.find((record) => record.id === match.config.matchId);
  const sameClassification = previousRecord?.fixtureClass === state.liveMatch.fixtureClass;
  const initial2 = state.initialLivePublication;
  const initialPublication = !previousRecord && initial2?.matchId === match.config.matchId && initial2.fixtureClass === state.liveMatch.fixtureClass && initial2.publication.fixtureClass === state.liveMatch.fixtureClass ? initial2.publication : null;
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
    publication: sameClassification ? clone2(previousRecord.publication) : initialPublication ? clone2(initialPublication) : managerOnlyPublication(state.liveMatch.fixtureClass),
    classificationVersion: previousRecord ? previousRecord.classificationVersion + Number(!sameClassification) : 1,
    selectedPlayerIds: [...match.config.selectedPlayerIds],
    attendance: { ...match.attendance },
    participation: started ? playerMinutes(match, sample).map((player) => {
      const saved2 = match.config.players.find((item) => item.id === player.playerId);
      const target = targets.find((item) => item.playerId === player.playerId);
      const targetMs = target ? rationalToNumber(target.target) : null;
      const priorEntry = state.results.find((record) => record.id === match.config.matchId)?.participation?.find((item) => item.playerId === player.playerId);
      const exceptionReason = priorEntry?.playedMs === player.playingMs && priorEntry.target?.targetMs === targetMs ? priorEntry.target.exceptionReason : null;
      const preferences = match.config.profileSnapshot?.find((item) => item.playerId === player.playerId)?.preferences ?? saved2?.positionPreferences ?? [];
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
        primaryWasGoalkeeper: preferences.length ? preferences[0] === "GK" : saved2?.goalkeeperChoice ? saved2.goalkeeperChoice === 1 : null
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
      if (before && ((before.sourceMatchRevision ?? -1) > command.match.revision || before.sourceMatchRevision === command.match.revision && before.fixtureClass === state.liveMatch.fixtureClass)) throw new Error("This match revision is already archived.");
      after = { ...snapshotLiveMatch(state, command.match, command.at), enteredAt: before?.enteredAt ?? command.at, revision: (before?.revision ?? 0) + 1 };
      state = { ...state, results: [...state.results.filter((record) => record.id !== after?.id), after] };
      reason = command.reason?.trim() || "Local completed match captured from recorded intervals.";
      break;
    }
    case "live.context.set": {
      if (!validDate2(command.details.playedDate) || command.details.playedDate < state.startsOn || command.details.playedDate > state.endsOn || !command.details.opponent.trim()) throw new Error("Choose valid fixture details in this season.");
      state = { ...state, liveMatch: clone2(command.details) };
      before = state.results.find((record) => record.id === command.details.matchId) ?? null;
      if (before && before.fixtureClass !== command.details.fixtureClass) {
        after = { ...before, publication: managerOnlyPublication(before.fixtureClass), revision: before.revision + 1, updatedAt: command.at };
        state = { ...state, results: state.results.map((record) => record.id === after.id ? after : record) };
      }
      if (state.initialLivePublication?.matchId === command.details.matchId && state.initialLivePublication.fixtureClass !== command.details.fixtureClass)
        delete state.initialLivePublication;
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
    case "game.evidence.replace": {
      const ids = command.evidence.map((item) => item.matchId);
      if (new Set(ids).size !== ids.length || command.evidence.some((item) => !item.matchId || !Number.isSafeInteger(item.sourcePreparationRevision) || item.sourcePreparationRevision < 0 || !item.sourceCommandId || Object.entries(item.responses).some(([playerId, response]) => !state.players.some((player) => player.id === playerId) || !["available", "unavailable", "unsure", "no_reply"].includes(response)))) throw new Error("Game preparation evidence needs distinct fixtures, known season players and a recorded source revision.");
      state = { ...state, gamePreparation: clone2(command.evidence) };
      reason = "Game responses projected separately from actual attendance and active availability.";
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
function resultOutcome(score2) {
  return score2.for > score2.against ? "W" : score2.for < score2.against ? "L" : "D";
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
  const denied2 = !inScope(state, viewer) || withheld > 0;
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
    sharing: denied2 ? "withheld_policy" : "permitted",
    suppressionReason: denied2 ? "Scores and derived totals are not shared for this competition or scope." : null,
    withheldResultCount: viewer.actor === "manager" ? withheld : null,
    rows: visible.map(publicResult),
    totals: denied2 ? null : totals,
    scorerTotals: denied2 ? null : state.players.filter((player) => scorerCounts.has(player.id)).map((player) => ({ playerId: player.id, label: player.label, knownGoals: scorerCounts.get(player.id) })),
    form: denied2 || ambiguous ? null : included.slice(-5).map((record) => ({ matchId: record.id, outcome: resultOutcome(record.finalScore) })),
    formChronologyState: ambiguous ? "same_day_order_unknown" : "known",
    unknownScoreCount: visible.filter((record) => record.status === "completed" && record.finalScore === null).length,
    excludedExceptionalMatches: visible.filter((record) => record.specialOutcome !== "ordinary" || record.status === "abandoned").length,
    dataCoverage: { totalRecordedMatches: denied2 ? null : scoped.length, knownOrdinaryResults: denied2 ? null : included.length, summaryOnlyCount: denied2 ? null : visible.filter((record) => record.recordMode === "historical_summary").length }
  };
}
function reportRecords(state, match) {
  const scoped = state.results.filter((record) => record.teamId === state.teamId && record.seasonId === state.seasonId);
  if (!match || match.config.matchId !== state.liveMatch.matchId || match.status === "preparation") return scoped;
  const current3 = snapshotLiveMatch(state, match, observedMatchTime(match) ?? latestRecordTime(state) ?? state.startsOn + "T00:00:00Z");
  return [...scoped.filter((record) => record.id !== current3.id), current3];
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
      gameRecords: selected.map((record) => {
        const preparation = state.gamePreparation?.find((item) => item.matchId === record.id);
        const actualAttendance = record.attendance?.[player.id] ?? "not_recorded";
        return {
          eventId: record.id,
          eventType: "game",
          heldDate: record.playedDate,
          eventStatus: record.status,
          selection: "selected",
          actualAttendance,
          excusedStatus: actualAttendance === "excused" ? "excused" : null,
          availabilityResponse: preparation?.responses[player.id] ?? null,
          correctionProvenance: { recordRevision: record.revision, sourceMatchRevision: record.sourceMatchRevision, updatedAt: record.updatedAt, sourcePreparationRevision: preparation?.sourcePreparationRevision ?? null, sourcePreparationCommandId: preparation?.sourceCommandId ?? null }
        };
      }),
      trainingRecords: trainingEvidence.map((item) => ({ eventId: item.sessionId, eventType: "training", heldDate: item.playedDate, eventStatus: "held", expected: true, actualAttendance: item.attendance[player.id] ?? "not_recorded", excusedStatus: item.attendance[player.id] === "excused" ? "excused" : null, availabilityResponse: item.responses?.[player.id] ?? null, correctionProvenance: { sourcePreparationRevision: item.sourcePreparationRevision ?? null, sourcePreparationCommandId: item.sourceCommandId ?? null } })),
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
  const eligible2 = viewer.actor === "manager" ? state.players.map((player) => player.id) : viewer.playerId ? [viewer.playerId] : [];
  return {
    ...base,
    actualActiveDurationMs: record.actualActiveDurationMs,
    keeperPolicy: record.keeperPolicy,
    participation: record.participation?.filter((item) => eligible2.includes(item.playerId)).map(clone2) ?? null,
    attendance: record.attendance ? Object.fromEntries(Object.entries(record.attendance).filter(([id5]) => eligible2.includes(id5))) : null
  };
}

// packages/application/src/sync.ts
function effectiveEventTime(previous, next, event) {
  if (event.type === "policy.changed") return { ...event.effective };
  let effective;
  if (event.type === "goal.recorded" || event.type === "availability.changed" || event.type === "lineup.committed") effective = event.effective;
  if (event.type === "event.corrected") effective = event.replacement.effective;
  if ((event.type === "event.corrected" || event.type === "event.voided") && !effective) {
    const goal = previous.goals?.find((record) => record.eventId === event.targetEventId || record.latestEventId === event.targetEventId);
    const availability = previous.availabilityHistory?.find((record) => record.eventId === event.targetEventId || record.latestEventId === event.targetEventId);
    effective = goal?.effective ?? availability?.effective;
    if (!effective) {
      const target = previous.audit?.find((record) => record.eventId === event.targetEventId);
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
    ...snapshot.matchPlanDraft ? { initialPolicyProposal: snapshot.matchPlanDraft.settings, initialLineupProposal: snapshot.matchPlanDraft.allocations.map((row) => ({ ...row })) } : snapshot.lineupTemplateDraft ? { initialLineupProposal: snapshot.lineupTemplateDraft.allocations.map((row) => ({ ...row })) } : {},
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
var copy3 = (value) => JSON.parse(JSON.stringify(value));
var fail2 = (message, code = "INVALID_REQUEST", status = 422) => {
  throw new AccessError(code, status, message);
};
function requireThat4(value, message) {
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
  requireThat4(Number.isSafeInteger(context.nowMs) && context.nowMs >= 0, "A trusted server time is required.");
  requireThat4(preparation.team.id === records.teamId && preparation.club.id === records.clubId, "Preparation and reports must belong to the same club and team.");
  const season = preparation.seasons.find((item) => item.id === records.seasonId);
  requireThat4(season, "The source season is unavailable.");
  requireThat4(context.community.seasons.some((item) => item.teamId === records.teamId && item.id === season.id), "The source community scope is inconsistent.");
  return season;
}
function visibleAccounts(context) {
  const season = source(context);
  const permitted = new Set(context.memberships.filter((item) => item.teamId === context.records.teamId && item.seasonId === season.id && current(item, context.nowMs)).map((item) => item.accountId));
  return context.accounts.filter((account2) => permitted.has(account2.accountId) && account2.status === "active");
}
function verifiedAdult(account2) {
  return account2.status === "active" && account2.identityClassification === "adult_individual" && account2.adultVerified && account2.strongAuthEnrolled;
}
function activeManagers(context) {
  return [...new Set(context.memberships.filter((item) => item.teamId === context.records.teamId && item.role === "manager" && !item.administrativeInheritance && current(item, context.nowMs) && context.accounts.find((account2) => account2.accountId === item.accountId)?.status !== "disabled").map((item) => item.accountId))];
}
function seasonAccessEndsAtMs(startYear) {
  const midnightUtc = Date.UTC(startYear + 1, 8, 1);
  const offset = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", timeZoneName: "shortOffset" }).formatToParts(midnightUtc).find((part) => part.type === "timeZoneName")?.value;
  const match = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(offset ?? "");
  requireThat4(match, "The season boundary timezone is unavailable.");
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
    sourceSeason: copy3(season),
    canRollover: administrator && principal.strongAuth && !existingNextSeasonId && principal.authenticatedAt <= nowMs + 3e4 && nowMs - principal.authenticatedAt <= 3e5,
    existingNextSeasonId,
    requiredAuthority: "administrator_with_recent_stronger_sign_in",
    nextSeason: { startYear: season.startYear + 1, ...seasonBounds(season.startYear + 1) },
    activeManagerAccountIds: activeManagers(context),
    managerCandidates: accounts.filter(verifiedAdult).map((account2) => ({ accountId: account2.accountId, label: account2.label, currentManager: currentRows.some((item) => item.accountId === account2.accountId && item.role === "manager"), administrator: currentRows.some((item) => item.accountId === account2.accountId && item.role === "administrator") })),
    playerCandidates: currentRows.filter((item) => item.role === "player" && item.playerId && accounts.some((account2) => account2.accountId === item.accountId)).flatMap((item) => {
      const profile = preparation.profiles.find((profile2) => profile2.seasonId === season.id && profile2.playerId === item.playerId && profile2.active);
      return profile ? [{ accountId: item.accountId, playerId: profile.playerId, label: profile.displayName }] : [];
    }),
    spectatorRenewal: "individual_explicit_invitation_only"
  };
}
function configurationServiceView(input) {
  assertTeamRole(input.principal, input.memberships, input.preparation.team.id, input.seasonId, ["administrator", "manager"], input.nowMs);
  assertAdultAuthority(input.principal, false, input.nowMs);
  const { version: version2, revision, club, team, activeSeasonId, seasons } = input.preparation;
  return copy3({ version: version2, revision, club, team, activeSeasonId, seasons });
}
function applyConfigurationServiceCommand(input) {
  const { principal, memberships, preparation, seasonId, nowMs, command } = input;
  requireThat4(command?.type === "club.updated" || command?.type === "team.updated" || command?.type === "team.league_updated" || command?.type === "team.alerts_updated", "Configuration accepts only club or team settings.");
  assertTeamRole(principal, memberships, preparation.team.id, seasonId, command.type === "club.updated" ? ["administrator"] : ["administrator", "manager"], nowMs);
  assertAdultAuthority(principal, command.type === "club.updated", nowMs);
  return reducePreparation(preparation, command);
}
function planSeasonRollover(context) {
  const old = source(context), { principal, memberships, accounts, preparation, records, community, command, nowMs } = context;
  assertTeamRole(principal, memberships, records.teamId, old.id, ["administrator"], nowMs);
  requireThat4(Number.isSafeInteger(principal.authenticatedAt) && principal.authenticatedAt >= 0, "Verified authentication time is required.");
  assertAdultAuthority(principal, true, nowMs);
  requireThat4(command?.type === "season.rolled_over" && validId2(command.id) && validId2(command.idForSeason), "Use valid command and season identifiers.");
  requireThat4(command.expectedPreparationRevision === preparation.revision, "The source preparation changed. Refresh before creating its next season.");
  requireThat4(command.startYear === old.startYear + 1 && command.startYear <= 2100 && command.startYear >= 2020, "Create the immediately following September-to-August season.");
  requireThat4(command.idForSeason !== old.id && !preparation.seasons.some((item) => item.id === command.idForSeason || item.startYear === command.startYear) && !memberships.some((item) => item.teamId === records.teamId && item.seasonId === command.idForSeason), "That destination season already exists.");
  requireThat4(!context.existingSeasons.some((item) => item.teamId === records.teamId && (item.id === command.idForSeason || item.startYear === command.startYear)), "That destination season or season year already exists.");
  requireThat4(command.confirmSpectatorRenewal === true && typeof command.copyPlayers === "boolean", "Acknowledge that spectators receive no automatic new-season access.");
  requireThat4(Array.isArray(command.managerAccountIds) && Array.isArray(command.administratorAccountIds) && Array.isArray(command.playerAssignments), "Explicit manager, administrator and player assignments are required.");
  requireThat4(command.playerAssignments.length <= 2e3 && command.playerAssignments.every((item) => item && typeof item === "object" && validId2(item.accountId) && validId2(item.playerId)), "Player assignments must be a bounded list of known identities.");
  const unique3 = (items) => items.every(validId2) && new Set(items).size === items.length;
  requireThat4(command.managerAccountIds.length >= 1 && command.managerAccountIds.length <= 4 && unique3(command.managerAccountIds), "Select one to four distinct verified adult managers.");
  requireThat4(command.administratorAccountIds.length >= 1 && unique3(command.administratorAccountIds), "Explicitly retain at least one current verified administrator.");
  const options = seasonRolloverOptions(context);
  for (const id5 of command.managerAccountIds) requireThat4(options.managerCandidates.some((account2) => account2.accountId === id5), "Each manager must be an active verified adult with stronger authentication already enrolled in this team.");
  for (const id5 of command.administratorAccountIds) requireThat4(options.managerCandidates.some((account2) => account2.accountId === id5 && account2.administrator), "Only a current verified administrator can retain administrator authority in the new season.");
  if ((/* @__PURE__ */ new Set([...activeManagers(context), ...command.managerAccountIds])).size > 4) fail2("A team can have at most four active manager accounts. Revoke departed manager authority explicitly before adding another account.", "MANAGER_LIMIT", 409);
  requireThat4(new Set(command.playerAssignments.map((item) => item.accountId)).size === command.playerAssignments.length && new Set(command.playerAssignments.map((item) => item.playerId)).size === command.playerAssignments.length, "Player assignments must retain one distinct known account for each player.");
  requireThat4(command.copyPlayers || command.playerAssignments.length === 0, "Copy the relevant player profiles before assigning their existing accounts.");
  for (const assignment of command.playerAssignments) requireThat4(validId2(assignment.accountId) && validId2(assignment.playerId) && options.playerCandidates.some((item) => item.accountId === assignment.accountId && item.playerId === assignment.playerId), "New player membership must preserve the source account/player binding. Use activation for new identity links.");
  const season = { id: command.idForSeason, startYear: command.startYear, ...seasonBounds(command.startYear), spectatorRenewalRequired: true };
  const newMemberships = [
    ...command.managerAccountIds.map((accountId) => ({ accountId, teamId: records.teamId, seasonId: season.id, role: "manager", ...context.memberships.some((m) => m.accountId === accountId && m.teamId === records.teamId && m.seasonId === old.id && m.role === "manager" && m.administrativeInheritance) ? { administrativeInheritance: true } : {} })),
    ...command.administratorAccountIds.map((accountId) => ({ accountId, teamId: records.teamId, seasonId: season.id, role: "administrator", ...context.memberships.some((m) => m.accountId === accountId && m.teamId === records.teamId && m.seasonId === old.id && m.role === "administrator" && m.administrativeInheritance) ? { administrativeInheritance: true } : {} })),
    ...command.playerAssignments.map((item) => ({ ...item, teamId: records.teamId, seasonId: season.id, role: "player" }))
  ];
  const sourceProfiles = preparation.profiles.filter((profile) => profile.seasonId === old.id && profile.active);
  requireThat4(sourceProfiles.length <= 2e3 && new Set(sourceProfiles.map((profile) => profile.playerId)).size === sourceProfiles.length, "The source roster must have one distinct active profile for each player.");
  const profiles = command.copyPlayers ? sourceProfiles.map((profile, index) => ({ ...copy3(profile), id: `profile-${season.id.slice(0, 60)}-${String(index + 1).padStart(4, "0")}`, seasonId: season.id })) : [];
  const nextPreparation = { ...copy3(preparation), revision: 0, activeSeasonId: season.id, seasons: [season], profiles, fixtures: [], training: [], snapshots: [], matchPlans: [], appliedCommands: {}, audit: [{ id: command.id, revision: 0, type: "season.created_from_explicit_assignments" }] };
  const nextRecords = {
    ...copy3(records),
    revision: 0,
    seasonId: season.id,
    seasonLabel: season.label,
    startsOn: season.startDate,
    endsOn: season.endDate,
    players: profiles.map((profile) => ({ id: profile.playerId, label: profile.displayName })),
    liveMatch: { matchId: "", playedDate: season.startDate, opponent: "", homeAway: "home", fixtureClass: "unclassified" },
    results: [],
    trainingAttendance: [],
    gamePreparation: [],
    audit: [],
    appliedCommands: {}
  };
  const assignedIds = new Set(newMemberships.map((item) => item.accountId));
  const nextCommunity = {
    ...copy3(community),
    revision: 0,
    accounts: accounts.filter((account2) => assignedIds.has(account2.accountId)).map((account2) => ({ id: account2.accountId, label: account2.label, classification: account2.identityClassification === "child_shared" ? "child_shared" : "adult_individual", adultVerified: account2.adultVerified })),
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
    hiddenUploaders: community.hiddenUploaders.filter((item) => assignedIds.has(item.accountId)).map(copy3),
    preferences: Object.fromEntries(Object.entries(community.preferences).filter(([accountId]) => assignedIds.has(accountId)).map(([id5, value]) => [id5, copy3(value)])),
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
  if (award && (award.matchId !== report.matchId || !["winners", "no_valid_votes"].includes(award.result) || !times.every((time3) => Number.isSafeInteger(time3) && time3 >= 0) || award.finalisationDeadlineAtMs < award.voteCutoffAtMs || award.deadlineMissed !== award.finalisedAtMs > award.finalisationDeadlineAtMs || !Array.isArray(award.winnerLabels) || award.winnerLabels.some((label2) => typeof label2 !== "string" || !label2.trim() || label2.length > 120) || (award.result === "no_valid_votes" ? award.winnerLabels.length !== 0 : award.winnerLabels.length === 0))) return empty("unavailable");
  const photos = new Set(source2.view.gallery.filter((photo) => photo.matchId === report.matchId && typeof photo.id === "string" && photo.id.length > 0).map((photo) => photo.id));
  return {
    communityStatus: "available",
    communityRevision: source2.revision,
    award: award ? { matchId: report.matchId, result: award.result, winnerLabels: [...award.winnerLabels], voteCutoffAtMs: award.voteCutoffAtMs, finalisationDeadlineAtMs: award.finalisationDeadlineAtMs, finalisedAtMs: award.finalisedAtMs, deadlineMissed: award.deadlineMissed } : null,
    publishedAlbum: { matchId: report.matchId, photoCount: photos.size }
  };
}

// packages/application/src/game-preparation-evidence.ts
function gamePreparationEvidence(state, seasonId, sourceCommandId) {
  const players = new Map(state.profiles.filter((profile) => profile.seasonId === seasonId).map((profile) => [profile.id, profile.playerId]));
  return state.fixtures.filter((fixture) => fixture.seasonId === seasonId).map((fixture) => ({
    matchId: fixture.id,
    responses: Object.fromEntries(Object.entries(fixture.responses).flatMap(([profileId, response]) => {
      const playerId = players.get(profileId);
      return playerId ? [[playerId, response]] : [];
    })),
    sourcePreparationRevision: state.revision,
    sourceCommandId
  }));
}

// packages/application/src/records-service.ts
var copy4 = (value) => JSON.parse(JSON.stringify(value));
function fail3(message, code = "INVALID_REQUEST", status = 422) {
  throw new AccessError(code, status, message);
}
function requireThat5(value, message) {
  if (!value) fail3(message);
}
function object(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function string(value, max = 150) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function fields(value, permitted) {
  requireThat5(Object.keys(value).every((key) => permitted.includes(key)), "The request includes unsupported fields.");
}
function integer2(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
var fixtureClasses = ["development", "friendly", "trophy", "unclassified"];
function score(value) {
  if (value === null) return null;
  requireThat5(object(value), "Provide a known score or explicitly leave it not recorded.");
  fields(value, ["for", "against"]);
  requireThat5(integer2(value.for, 999) && integer2(value.against, 999), "Scores must be nonnegative whole goals.");
  return { for: value.for, against: value.against };
}
function parseHistoricalResultInput(value) {
  requireThat5(object(value), "Historical details are required.");
  fields(value, ["playedDate", "recordedKickoff", "sameDayOrder", "opponent", "homeAway", "fixtureClass", "status", "specialOutcome", "finalScore", "halfTimeScore", "goals"]);
  requireThat5(string(value.playedDate, 10) && string(value.opponent, 120), "A played date and opposition are required.");
  requireThat5(value.recordedKickoff === null || string(value.recordedKickoff, 50), "Known kickoff needs a timestamp; use null for unknown.");
  requireThat5(value.sameDayOrder === null || integer2(value.sameDayOrder, 100), "Same-day ordering must be a whole number or unknown.");
  requireThat5(["home", "away", "neutral"].includes(value.homeAway) && fixtureClasses.includes(value.fixtureClass), "Choose a valid venue side and fixture class.");
  requireThat5(["completed", "abandoned", "cancelled", "postponed", "incomplete"].includes(value.status) && ["ordinary", "awarded", "forfeit", "shootout"].includes(value.specialOutcome), "Choose a known match status and outcome category.");
  requireThat5(Array.isArray(value.goals) && value.goals.length <= 1e3, "Known goal attribution must be a bounded list.");
  const goals = value.goals.map((item) => {
    requireThat5(object(item), "A known goal must be an object.");
    fields(item, ["id", "beneficiary", "isOwnGoal", "scorerPlayerId", "goalType", "half", "halfElapsedMs"]);
    requireThat5(string(item.id) && ["us", "opposition"].includes(item.beneficiary) && typeof item.isOwnGoal === "boolean", "Known goals require identity, beneficiary and explicit own-goal classification.");
    requireThat5(item.scorerPlayerId === null || string(item.scorerPlayerId), "Use a saved player identity or unknown scorer.");
    requireThat5(item.goalType === null || ["open_play", "free_kick", "penalty"].includes(item.goalType), "Use a known goal type or unknown.");
    requireThat5(item.half === null || item.half === 1 || item.half === 2, "Use a known half or unknown.");
    requireThat5(item.halfElapsedMs === null || integer2(item.halfElapsedMs, 864e5), "Known active goal time must be nonnegative whole milliseconds.");
    return { id: item.id, beneficiary: item.beneficiary, isOwnGoal: item.isOwnGoal, scorerPlayerId: item.scorerPlayerId, goalType: item.goalType, half: item.half, halfElapsedMs: item.halfElapsedMs };
  });
  return { playedDate: value.playedDate, recordedKickoff: value.recordedKickoff, sameDayOrder: value.sameDayOrder, opponent: value.opponent.trim(), homeAway: value.homeAway, fixtureClass: value.fixtureClass, status: value.status, specialOutcome: value.specialOutcome, finalScore: score(value.finalScore), halfTimeScore: score(value.halfTimeScore), goals };
}
function recordsServiceViewer(input) {
  const { principal, memberships, state, nowMs, requestedRole } = input;
  requireThat5(Number.isSafeInteger(nowMs) && nowMs >= 0, "Trusted server time is required.");
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
  return { matchId: match.config.matchId, playedDate: fixture.playedDate, opponent: fixture.opponent, homeAway: fixture.homeAway, fixtureClass: fixtureClass ?? state.results.find((record) => record.id === match.config.matchId)?.fixtureClass ?? "unclassified" };
}
function currentSharingState(input, viewer, derived) {
  if (viewer.actor === "manager") return input.state;
  const denied2 = new Set(input.acceptedMatches.filter((row) => {
    if (row.teamId !== input.state.teamId || row.seasonId !== input.state.seasonId || !row.sharingPolicy) return false;
    const policy = row.sharingPolicy;
    return policy.approvedBy === null || policy.approvedAt === null || !policy.shareScores || derived && !policy.shareDerivedResults;
  }).map((row) => row.match.config.matchId));
  if (!denied2.size) return input.state;
  const initial2 = input.state.initialLivePublication;
  return {
    ...input.state,
    ...initial2 && denied2.has(initial2.matchId) ? { initialLivePublication: { ...initial2, publication: { ...initial2.publication, confirmed: false, allowedRoles: [] } } } : {},
    results: input.state.results.map((record) => denied2.has(record.id) ? { ...record, publication: { ...record.publication, confirmed: false, allowedRoles: [] } } : record)
  };
}
function recordsServiceView(input) {
  const viewer = recordsServiceViewer(input), { state, nowMs } = input;
  const scoreState = currentSharingState(input, viewer, false), derivedState = currentSharingState(input, viewer, true);
  const preparation = input.preparation;
  if (preparation && (preparation.team.id !== state.teamId || !preparation.seasons.some((season) => season.id === state.seasonId))) fail3("Preparation evidence is outside this report scope.", "NOT_FOUND", 404);
  const reportState = preparation ? {
    ...state,
    gamePreparation: gamePreparationEvidence(preparation, state.seasonId, preparation.audit.at(-1)?.id ?? "initial-preparation"),
    trainingAttendance: trainingAttendanceEvidence({ ...preparation, training: preparation.training.filter((session) => session.seasonId === state.seasonId) })
  } : state;
  const activeMatch = accepted(input, state.liveMatch.matchId);
  const generatedAt = new Date(nowMs).toISOString();
  const stamp = (value) => ({ ...value, generatedAt });
  const ids = new Set(state.results.map((record) => record.id));
  for (const row of input.acceptedMatches)
    if (row.teamId === state.teamId && row.seasonId === state.seasonId && row.match.status !== "preparation") ids.add(row.match.config.matchId);
  const reports = [...ids].map((id5) => {
    const match = accepted(input, id5);
    const details = match ? contextFor(state, match, id5 === state.liveMatch.matchId ? state.liveMatch.fixtureClass : void 0) : null;
    return selectMatchReport(details ? { ...scoreState, liveMatch: details } : scoreState, id5, viewer, match);
  }).filter((item) => item !== null);
  const common = { revision: state.revision, results: stamp(selectSeasonResults(derivedState, viewer)), participation: stamp({ ...selectParticipationReport(reportState, activeMatch, viewer), ...viewer.actor === "spectator" ? {} : { sourcePreparationRevision: preparation?.revision ?? null } }), matches: reports.map((report) => stamp({ ...report, ...composeReportCommunity(report, input.principal.accountId, input.community), goals: report.goals.map((goal) => ({ ...goal, scorerLabel: goal.scorerPlayerId ? state.players.find((player) => player.id === goal.scorerPlayerId)?.label ?? null : null })) })) };
  if (viewer.actor !== "manager") return common;
  return {
    ...common,
    editableState: copy4(state),
    activeMatch: activeMatch ? copy4(activeMatch) : null,
    contexts: input.acceptedMatches.filter((row) => row.teamId === state.teamId && row.seasonId === state.seasonId).flatMap((row) => {
      const match = accepted(input, row.match.config.matchId);
      const details = contextFor(state, match, state.liveMatch.matchId === match.config.matchId ? state.liveMatch.fixtureClass : void 0);
      return details ? [{ ...details, status: match.status, sourceMatchRevision: match.revision, archivedSourceMatchRevision: state.results.find((record) => record.id === match.config.matchId)?.sourceMatchRevision ?? null }] : [];
    })
  };
}
function applyRecordsServiceCommand(input) {
  const { state, command, principal, memberships, nowMs } = input;
  assertCanManageTeam(principal, memberships, state.teamId, state.seasonId, nowMs);
  if (input.requestedRole && input.requestedRole !== "manager") fail3("The selected audience cannot edit manager records.", "NOT_FOUND", 404);
  requireThat5(command && typeof command === "object" && string(command.commandId) && /^[A-Za-z0-9_-]+$/.test(command.commandId), "A stable record command identity is required.");
  let bound;
  const base = { commandId: command.commandId, at: new Date(nowMs).toISOString(), actor: "manager" };
  switch (command.type) {
    case "historical.add":
      requireThat5(string(command.recordId), "A historical match identity is required.");
      bound = { ...base, type: command.type, recordId: command.recordId, input: parseHistoricalResultInput(command.input), acknowledgePossibleDuplicate: command.acknowledgePossibleDuplicate === true };
      break;
    case "historical.correct":
      requireThat5(string(command.recordId) && integer2(command.expectedRevision) && string(command.reason, 500), "Review the current record revision and provide a correction reason.");
      bound = { ...base, type: command.type, recordId: command.recordId, expectedRevision: command.expectedRevision, reason: command.reason.trim(), input: parseHistoricalResultInput(command.input) };
      break;
    case "live.context.set": {
      requireThat5(object(command.details) && string(command.details.matchId) && fixtureClasses.includes(command.details.fixtureClass), "Choose a prepared match and an explicit fixture class.");
      fields(command.details, ["matchId", "playedDate", "opponent", "homeAway", "fixtureClass"]);
      const match = accepted(input, command.details.matchId);
      if (!match) fail3("The prepared match is outside this team and season.", "NOT_FOUND", 404);
      const details = contextFor(state, match, command.details.fixtureClass);
      requireThat5(details && details.playedDate === command.details.playedDate && details.opponent === command.details.opponent && details.homeAway === command.details.homeAway, "Match report context must retain the accepted fixture date, opponent and home/away side.");
      bound = { ...base, type: command.type, details };
      break;
    }
    case "live.archive": {
      const matchId = "matchId" in command ? command.matchId : command.match?.config?.matchId;
      const expectedRevision = "expectedSourceMatchRevision" in command ? command.expectedSourceMatchRevision : command.match?.revision;
      requireThat5(string(matchId) && integer2(expectedRevision), "Archive the reviewed accepted match identity and source revision.");
      const match = accepted(input, matchId);
      if (!match) fail3("The accepted match is outside this team and season.", "NOT_FOUND", 404);
      if (match.revision !== expectedRevision) fail3("The accepted match changed. Refresh its report before archiving.", "STALE_REVISION", 409);
      const old = state.results.find((record) => record.id === matchId);
      if (old && old.fixtureClass !== state.liveMatch.fixtureClass) requireThat5(string(command.reason, 500), "Explain the changed fixture classification before re-archiving.");
      bound = { ...base, type: command.type, match, ...command.reason ? { reason: command.reason } : {} };
      break;
    }
    case "participation.exception.noted":
      requireThat5(string(command.recordId) && string(command.playerId) && integer2(command.expectedRevision) && string(command.reason, 500), "Review the saved participation and explain the exception.");
      bound = { ...base, type: command.type, recordId: command.recordId, playerId: command.playerId, expectedRevision: command.expectedRevision, reason: command.reason.trim() };
      break;
    case "publication.set":
      fail3("A manager request cannot approve the unresolved competition policy. Independent operator evidence is required.", "POLICY_APPROVAL_REQUIRED", 503);
      break;
    case "training.evidence.replace":
    case "game.evidence.replace":
      fail3("Attendance report evidence is projected from the authorised preparation service.", "SERVICE_OWNED_PROJECTION", 403);
      break;
    default:
      fail3("Unsupported record command.");
  }
  return reduceRecords(state, bound);
}
function policyFingerprint(state, acceptedMatches) {
  const currentPolicies = acceptedMatches.filter((row) => row.teamId === state.teamId && row.seasonId === state.seasonId && row.sharingPolicy).map((row) => [row.match.config.matchId, row.sharingPolicy]).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  const source2 = JSON.stringify([state.results.map((record) => [record.id, record.classificationVersion, record.fixtureClass, record.publication]), state.initialLivePublication ?? null, currentPolicies]);
  let hash4 = 2166136261;
  for (const character of source2) hash4 = Math.imul(hash4 ^ character.charCodeAt(0), 16777619) >>> 0;
  return `policy-v1-${hash4.toString(16).padStart(8, "0")}`;
}
function recordsServiceExport(input) {
  const viewer = recordsServiceViewer(input), view = recordsServiceView(input), { request, state, nowMs } = input;
  requireThat5(request && ["season", "match"].includes(request.kind) && ["json", "csv"].includes(request.format), "Choose a report and supported export format.");
  const fingerprint2 = policyFingerprint(state, input.acceptedMatches);
  if (request.expectedProjectionVersion !== void 0 && request.expectedProjectionVersion !== state.revision || request.expectedPolicyFingerprint !== void 0 && request.expectedPolicyFingerprint !== fingerprint2) fail3("This report or audience policy changed. Refresh before exporting.", "STALE_PROJECTION", 409);
  const matches = request.kind === "match" ? view.matches.filter((report) => report.matchId === request.matchId) : view.matches;
  if (request.kind === "match" && matches.length !== 1) fail3("That permitted match report is unavailable.", "NOT_FOUND", 404);
  const generatedAt = new Date(nowMs).toISOString();
  const preparation = input.preparation;
  const displayLabel = (value) => string(value, 150) ? value.trim() : null;
  const displayContext = preparation ? {
    clubName: displayLabel(preparation.club.name),
    teamName: displayLabel(preparation.team.name),
    ageGroup: displayLabel(preparation.team.ageGroup),
    seasonLabel: displayLabel(preparation.seasons.find((season) => season.id === state.seasonId)?.label)
  } : {};
  const document = {
    schemaVersion: 1,
    reportType: request.kind,
    teamId: state.teamId,
    seasonId: state.seasonId,
    audience: viewer.actor,
    ...displayContext,
    appliedFilters: { matchId: request.kind === "match" ? request.matchId : null, playerId: viewer.actor === "player" ? viewer.playerId : null },
    generatedAt,
    asOf: request.kind === "match" ? matches[0].asOf : view.participation.asOf,
    projectionVersion: state.revision,
    policyFingerprint: fingerprint2,
    policyVersions: state.results.filter((record) => request.kind === "season" || matches.some((report) => report.matchId === record.id)).map((record) => ({ matchId: record.id, policyId: record.publication.id, policyVersion: record.publication.version, classificationVersion: record.classificationVersion })),
    dataCoverage: { participationAccess: view.participation.access, attendancePolicy: view.participation.rows[0]?.games.policy ?? "proposed_known_records_excused_included", includesInventedHistoricalMinutes: false },
    ...request.kind === "season" ? { results: view.results, ...viewer.actor !== "spectator" ? { participation: view.participation } : {} } : {},
    matches
  };
  const csvCell = (value) => {
    let text2 = value === null || value === void 0 ? "Not recorded" : typeof value === "object" ? JSON.stringify(value) : String(value);
    if (/^[\t\r ]*[=+\-@]/.test(text2)) text2 = `'${text2}`;
    return `"${text2.replaceAll('"', '""')}"`;
  };
  const rows = [["section", "identity", "field", "value"], ["metadata", "report", "teamId", state.teamId], ["metadata", "report", "seasonId", state.seasonId], ["metadata", "report", "audience", viewer.actor], ["metadata", "report", "projectionVersion", state.revision], ["metadata", "report", "policyFingerprint", fingerprint2], ["metadata", "report", "generatedAt", generatedAt], ["metadata", "report", "asOf", document.asOf], ["metadata", "report", "attendancePolicy", document.dataCoverage.attendancePolicy]];
  if (request.kind === "season") for (const [field, value] of Object.entries(view.results)) rows.push(["results", "season", field, value]);
  if (request.kind === "season" && viewer.actor !== "spectator") for (const row of view.participation.rows) for (const [field, value] of Object.entries(row)) rows.push(["participation", row.playerId, field, value]);
  for (const report of matches) for (const [field, value] of Object.entries(report)) rows.push(["match", report.matchId, field, value]);
  const body = request.format === "json" ? JSON.stringify(document, null, 2) : "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  return { kind: "records-export", format: request.format, contentType: request.format === "json" ? "application/json" : "text/csv; charset=utf-8", fileName: `longball-${state.teamId.replace(/[^A-Za-z0-9_-]/g, "_")}-${state.seasonId.replace(/[^A-Za-z0-9_-]/g, "_")}-${request.kind}.${request.format}`, body, teamId: state.teamId, seasonId: state.seasonId, audience: viewer.actor, projectionVersion: state.revision, policyFingerprint: fingerprint2, generatedAt };
}

// apps/api/src/trusted-time.ts
var integer3 = (value) => Number.isSafeInteger(value) && value >= 0;
var continuous = (value) => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
function checkPolicy(policy) {
  if (!policy.id || ![
    policy.serverClockUncertaintyMs,
    policy.maximumRoundTripMs,
    policy.maximumMappingAgeMs,
    policy.maximumUncertaintyMs,
    policy.maximumDriftPpm
  ].every(integer3) || !policy.maximumRoundTripMs || !policy.maximumMappingAgeMs) {
    throw new Error("A versioned, explicit trusted-time policy is required.");
  }
}
function issueClockChallenge(scope, id5, issuedAtMs, policy) {
  checkPolicy(policy);
  if (!id5 || !scope.accountId || !scope.deviceId || !scope.matchId || !scope.continuityId || !integer3(issuedAtMs) || !integer3(scope.controllerEpoch) || scope.controllerEpoch === 0) {
    throw new Error(
      "The clock challenge requires a current controller and continuous-clock identity."
    );
  }
  return {
    ...scope,
    id: id5,
    issuedAtMs,
    expiresAtMs: issuedAtMs + policy.maximumRoundTripMs,
    policyId: policy.id
  };
}
function acknowledgeClockChallenge(challenge, sample, serverReceivedAtMs, policy) {
  checkPolicy(policy);
  const { receivedMonotonicMs, sentMonotonicMs } = sample;
  if (challenge.policyId !== policy.id || !integer3(serverReceivedAtMs) || !continuous(receivedMonotonicMs) || !continuous(sentMonotonicMs) || sentMonotonicMs < receivedMonotonicMs || serverReceivedAtMs < challenge.issuedAtMs || serverReceivedAtMs > challenge.expiresAtMs || sentMonotonicMs - receivedMonotonicMs > serverReceivedAtMs - challenge.issuedAtMs) {
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
  if (!continuous(monotonicMs) || !integer3(serverNowMs) || serverNowMs < mapping.establishedAtMs)
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
    const active3 = state.intervals.filter(
      (item) => item.state === "playing" && item.startMs <= boundaries[index] && item.endMs >= boundaries[index + 1]
    );
    if (active3.length > state.config.pitchPlaces || new Set(active3.map((item) => item.slotId)).size !== active3.length || new Set(active3.map((item) => item.playerId)).size !== active3.length)
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
    (id5) => !submissions.some(
      (item) => item.submissionId === id5 && item.matchId === state.config.matchId && Boolean(item.originalDigest)
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
  const present = selected.filter((id5) => state.attendance[id5] === "present");
  const played = selected.filter(
    (id5) => state.intervals.some(
      (interval) => interval.playerId === id5 && interval.state === "playing" && interval.endMs > interval.startMs
    )
  );
  return {
    selected,
    present,
    played,
    contradictory: played.some((id5) => !present.includes(id5))
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
  const instant2 = matchesAcceptedFinish && input.mapping && input.policy && finish ? mapContinuousInstant(
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
  const trusted = !input.unresolvedConflicts && !state.recoveryRequired && instant2?.quality === "trusted" && instant2.utcMs <= input.serverNowMs;
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
      (id5) => state.intervals.some(
        (interval) => interval.playerId === id5 && interval.state === "playing" && interval.endMs > interval.startMs
      )
    ),
    actualFullTimeAtMs: trusted ? instant2.utcMs : null,
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

// packages/application/src/staff.ts
var current2 = (item, nowMs) => item.revokedAt == null && (item.expiresAt == null || item.expiresAt > nowMs);
var eligible = (account2) => account2.status === "active" && account2.identityClassification === "adult_individual" && account2.adultVerified && account2.strongAuthEnrolled;
function managerRoster(input) {
  const { principal, memberships, accounts, teamId, seasonId, nowMs } = input;
  if (input.requestedRole && input.requestedRole !== "administrator") throw new AccessError("NOT_FOUND", 404, "Choose the current administrator context for staff management.");
  assertTeamRole(principal, memberships, teamId, seasonId, ["administrator"], nowMs);
  assertAdultAuthority(principal, false, nowMs);
  if (!Number.isSafeInteger(input.revision) || input.revision < 0 || !Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Use the authoritative staff revision and current service time.");
  const associated = new Set(memberships.filter((item) => item.teamId === teamId && current2(item, nowMs)).map((item) => item.accountId));
  const liveManagers = memberships.filter((item) => item.teamId === teamId && item.role === "manager" && !item.administrativeInheritance && current2(item, nowMs));
  const managers = memberships.filter((item) => item.teamId === teamId && item.seasonId === seasonId && item.role === "manager" && !item.administrativeInheritance).map((item) => {
    const account2 = accounts.find((account3) => account3.accountId === item.accountId);
    return {
      accountId: item.accountId,
      label: account2 && account2.identityClassification === "adult_individual" && account2.adultVerified ? account2.label : "Unavailable manager account",
      status: !account2 || !eligible(account2) ? "disabled" : item.revokedAt != null ? "revoked" : item.expiresAt != null && item.expiresAt <= nowMs ? "expired" : "active",
      expiresAt: item.expiresAt ?? null,
      revokedAt: item.revokedAt ?? null,
      otherActiveSeasonIds: [...new Set(liveManagers.filter((other) => other.accountId === item.accountId && other.seasonId !== seasonId).map((other) => other.seasonId))].sort()
    };
  }).sort((a, b) => a.label.localeCompare(b.label) || a.accountId.localeCompare(b.accountId));
  const candidates = accounts.filter((account2) => associated.has(account2.accountId) && eligible(account2)).map((account2) => ({ accountId: account2.accountId, label: account2.label, currentManager: liveManagers.some((item) => item.accountId === account2.accountId && item.seasonId === seasonId) })).sort((a, b) => a.label.localeCompare(b.label) || a.accountId.localeCompare(b.accountId));
  return { kind: "manager-roster", revision: input.revision, teamId, seasonId, asOf: new Date(nowMs).toISOString(), maximumManagers: 4, activeTeamManagerCount: new Set(liveManagers.map((item) => item.accountId)).size, canMutate: principal.authenticatedAt <= nowMs + 3e4 && nowMs - principal.authenticatedAt <= 3e5, managers, candidates };
}

// packages/application/src/privacy-requests.ts
var object2 = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
var opaque2 = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(value);
function requireThat6(condition, message) {
  if (!condition) throw new AccessError("INVALID_REQUEST", 400, message);
}
function fields2(value, names) {
  requireThat6(Object.keys(value).length === names.length && Object.keys(value).every((key) => names.includes(key)), "Use only the documented account request fields.");
}
function active(principal) {
  if (principal.status !== "active") throw new AccessError("ACCOUNT_UNAVAILABLE", 403, "Use an active signed-in account to review or submit its own requests.");
}
function validTime4(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function parsePrivacyRequestInput(value) {
  requireThat6(object2(value), "Choose a scoped account request.");
  if (value.kind === "leave_team") {
    fields2(value, ["kind", "teamId", "seasonId", "confirmLeave"]);
    requireThat6(opaque2(value.teamId) && opaque2(value.seasonId) && value.confirmLeave === true, "Explicitly confirm the selected team and season leave request.");
    return { kind: "leave_team", teamId: value.teamId, seasonId: value.seasonId, confirmLeave: true };
  }
  fields2(value, ["kind", "scope", "confirmAllMemberships"]);
  requireThat6((value.kind === "export" || value.kind === "delete_account") && value.scope === "all_memberships" && value.confirmAllMemberships === true, "Explicitly confirm that this global account request covers every membership.");
  return { kind: value.kind, scope: "all_memberships", confirmAllMemberships: true };
}
function parseScope(value) {
  if (value === null) return null;
  requireThat6(object2(value), "Invalid retained account request scope.");
  if (value.type === "all_memberships") {
    fields2(value, ["type"]);
    return { type: "all_memberships" };
  }
  fields2(value, ["type", "teamId", "seasonId"]);
  requireThat6(value.type === "team_season" && opaque2(value.teamId) && opaque2(value.seasonId), "Invalid retained team and season scope.");
  return { type: "team_season", teamId: value.teamId, seasonId: value.seasonId };
}
function privacyRequestBusinessKey(accountId, kind, scope) {
  requireThat6(opaque2(accountId) && ["export", "delete_account", "leave_team"].includes(kind), "A stable own-account request scope is required.");
  const checked = parseScope(scope);
  requireThat6(kind === "leave_team" ? checked.type === "team_season" : checked.type === "all_memberships", "The request kind and scope differ.");
  return JSON.stringify(checked.type === "team_season" ? [accountId, kind, checked.type, checked.teamId, checked.seasonId] : [accountId, kind, checked.type]);
}
function ownPrivacyMemberships(principal, memberships, nowMs) {
  active(principal);
  requireThat6(validTime4(nowMs), "Use the current service time.");
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
  requireThat6(object2(value), "Invalid affected membership.");
  fields2(value, ["teamId", "seasonId", "role", "playerId", "status"]);
  requireThat6(opaque2(value.teamId) && opaque2(value.seasonId) && ["administrator", "manager", "player", "spectator"].includes(value.role) && (value.playerId === null || opaque2(value.playerId)) && ["active", "expired", "revoked"].includes(value.status), "Invalid affected membership fields.");
  return { teamId: value.teamId, seasonId: value.seasonId, role: value.role, playerId: value.playerId, status: value.status };
}
function parsePrivacyRequestDto(value) {
  requireThat6(object2(value), "Invalid account request response.");
  fields2(value, ["requestId", "kind", "status", "scope", "affectedMemberships", "createdAtMs", "verificationRequired", "erased", "fulfilled", "scopeStatus", "reviewStatus", "duplicateOfRequestId"]);
  requireThat6(opaque2(value.requestId) && ["export", "delete_account", "leave_team"].includes(value.kind) && ["pending_verification_and_policy", "needs_scope"].includes(value.status) && validTime4(value.createdAtMs), "Invalid account request status or identity.");
  requireThat6(value.verificationRequired === true && value.erased === false && value.fulfilled === false && (value.duplicateOfRequestId === null || opaque2(value.duplicateOfRequestId)), "A pending request never establishes fulfilment or deletion.");
  const scope = parseScope(value.scope), kind = value.kind;
  requireThat6(scope === null || (kind === "leave_team" ? scope.type === "team_season" : scope.type === "all_memberships"), "The account request kind and scope differ.");
  requireThat6(value.scopeStatus === (scope === null ? "needs_scope" : "recorded") && value.reviewStatus === (scope === null || value.status === "needs_scope" ? "needs_scope" : value.duplicateOfRequestId === null ? "pending_verification_and_policy" : "duplicate_requires_review"), "The account request review status is inconsistent.");
  requireThat6(value.affectedMemberships === null || Array.isArray(value.affectedMemberships), "The confirmed membership snapshot is missing or invalid.");
  const affectedMemberships = value.affectedMemberships === null ? null : value.affectedMemberships.map(parseMembership);
  requireThat6(scope?.type !== "team_season" || affectedMemberships === null || affectedMemberships.every((item) => item.teamId === scope.teamId && item.seasonId === scope.seasonId), "The affected membership snapshot crosses the selected leave scope.");
  return { requestId: value.requestId, kind, status: value.status, scope, affectedMemberships, createdAtMs: value.createdAtMs, verificationRequired: true, erased: false, fulfilled: false, scopeStatus: value.scopeStatus, reviewStatus: value.reviewStatus, duplicateOfRequestId: value.duplicateOfRequestId };
}
function projectAccountPrivacyRequests(input) {
  const memberships = ownPrivacyMemberships(input.principal, input.memberships, input.nowMs), canonical5 = /* @__PURE__ */ new Map();
  const items = input.records.filter((item) => item.accountId === input.principal.accountId).sort((a, b) => a.createdAtMs - b.createdAtMs || a.requestId.localeCompare(b.requestId)).map((record) => {
    const scope = parseScope(record.scope);
    const key = scope && record.status === "pending_verification_and_policy" ? privacyRequestBusinessKey(record.accountId, record.kind, scope) : null;
    const duplicateOfRequestId = key ? canonical5.get(key) ?? null : null;
    if (key && !canonical5.has(key)) canonical5.set(key, record.requestId);
    return parsePrivacyRequestDto({
      requestId: record.requestId,
      kind: record.kind,
      status: record.status,
      scope,
      affectedMemberships: record.affectedMemberships,
      createdAtMs: record.createdAtMs,
      verificationRequired: true,
      erased: false,
      fulfilled: false,
      scopeStatus: scope === null ? "needs_scope" : "recorded",
      duplicateOfRequestId,
      reviewStatus: scope === null || record.status === "needs_scope" ? "needs_scope" : duplicateOfRequestId ? "duplicate_requires_review" : "pending_verification_and_policy"
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

// packages/application/src/account-devices.ts
var object3 = (v) => Boolean(v && typeof v === "object" && !Array.isArray(v));
var opaque3 = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(v);
var iso2 = (v) => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
function fields3(value, keys2) {
  if (Object.keys(value).length !== keys2.length || Object.keys(value).some((key) => !keys2.includes(key)))
    throw new Error("Invalid own device inventory fields.");
}
function parseAccountDevicesDto(value) {
  if (!object3(value)) throw new Error("Invalid own device inventory.");
  fields3(value, [
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
    if (!object3(item)) throw new Error("Invalid device entry.");
    fields3(item, [
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

// apps/api/src/workspace-memberships.ts
function label(value) {
  if (typeof value !== "string" || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) return void 0;
  return value.trim() || void 0;
}
function namedWorkspaceMembership(membership, names) {
  const team = label(names?.team_name), ageGroup = label(names?.age_group);
  const teamName = team && ageGroup && !team.toLocaleLowerCase("en-GB").endsWith(` ${ageGroup.toLocaleLowerCase("en-GB")}`) ? label(`${team} ${ageGroup}`) ?? team : team;
  const seasonLabel = label(names?.season_label), clubName = label(names?.club_name);
  return {
    ...membership,
    ...teamName ? { teamName } : {},
    ...seasonLabel ? { seasonLabel } : {},
    ...clubName ? { clubName } : {}
  };
}

// packages/application/src/fixture-management.ts
var opaque4 = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{8,150}$/.test(value);
var entityId = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,150}$/.test(value);
var invalid2 = (message) => {
  throw new AccessError("INVALID_REQUEST", 400, message);
};
function parseScheduledGameCommand(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid2("Use a captured scheduled-game command.");
  const item = value;
  if (Object.keys(item).some((key) => !["id", "expectedRevision", "fixtureId", "type", "reason", "confirm"].includes(key)) || !opaque4(item.id) || !entityId(item.fixtureId) || !Number.isSafeInteger(item.expectedRevision) || Number(item.expectedRevision) < 0 || !["fixture.cancelled", "fixture.deleted"].includes(String(item.type)) || item.confirm !== true || typeof item.reason !== "string" || item.reason.trim().length < 5 || item.reason.trim().length > 500) {
    return invalid2("Confirm cancellation or deletion with its current revision and a reason of 5\u2013500 characters.");
  }
  return { id: item.id, expectedRevision: Number(item.expectedRevision), fixtureId: item.fixtureId, type: item.type, reason: item.reason.trim(), confirm: true };
}
function fixtureWasDeleted(state, fixtureId) {
  return Boolean(state.fixtureManagement?.tombstones.some((item) => item.fixture.id === fixtureId));
}
function assertFixtureNotDeleted(state, fixtureId) {
  if (fixtureWasDeleted(state, fixtureId)) throw new AccessError("FIXTURE_DELETED", 409, "This schedule item was deleted. Its audit is retained; create a new fixture identity.");
}
function fixtureRecordingUnavailable(state, fixtureId) {
  const fixture = state.fixtures.find((item) => item.id === fixtureId);
  return fixtureWasDeleted(state, fixtureId) || Boolean(fixture && fixture.status !== "scheduled");
}

// packages/application/src/goalkeeper-clean-sheets.ts
function goalkeeperCleanSheetOutcomes(input) {
  const validMs = (value) => Number.isSafeInteger(value) && value >= 0;
  const keepers = [...new Set(input.intervals.filter((row) => row.state === "playing" && row.position === "GK" && row.endMs > row.startMs).map((row) => row.playerId))];
  const valid = input.completed && !input.reviewRequired && validMs(input.activeDurationMs) && input.activeDurationMs > 0 && input.recordedOppositionScore === input.oppositionGoals.length && input.intervals.every((row) => validMs(row.startMs) && validMs(row.endMs) && row.endMs >= row.startMs && row.endMs <= input.activeDurationMs) && input.oppositionGoals.every((goal) => goal.atMs !== null && validMs(goal.atMs) && goal.atMs <= input.activeDurationMs);
  if (!valid) return keepers.map((playerId) => ({ playerId, outcome: "unknown" }));
  const stints = keepers.flatMap((playerId) => {
    const rows = input.intervals.filter((row) => row.playerId === playerId && row.state === "playing" && row.position === "GK" && row.endMs > row.startMs).sort((a, b) => a.startMs - b.startMs);
    const merged = [];
    for (const row of rows) {
      const last = merged.at(-1);
      if (last && row.startMs <= last.endMs) last.endMs = Math.max(last.endMs, row.endMs);
      else merged.push({ playerId, startMs: row.startMs, endMs: row.endMs });
    }
    return merged;
  });
  const conceded = /* @__PURE__ */ new Set(), uncertain = /* @__PURE__ */ new Set();
  for (const goal of input.oppositionGoals) {
    const candidates = [...new Set(stints.filter((row) => row.startMs <= goal.atMs && row.endMs >= goal.atMs).map((row) => row.playerId))];
    if (candidates.length === 1) conceded.add(candidates[0]);
    else if (candidates.length > 1) for (const playerId of candidates) uncertain.add(playerId);
    else for (const playerId of keepers) uncertain.add(playerId);
  }
  return keepers.map((playerId) => ({ playerId, outcome: conceded.has(playerId) ? "conceded" : uncertain.has(playerId) ? "unknown" : "clean_sheet" }));
}

// packages/application/src/player-stats.ts
function denied() {
  throw new AccessError(
    "NOT_FOUND",
    404,
    "The requested player statistics are unavailable."
  );
}
var safeMs = (value) => Number.isSafeInteger(value) && value >= 0;
var instant = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
function cleanEvidence(record) {
  return {
    id: record.id,
    teamId: record.teamId,
    seasonId: record.seasonId,
    status: record.status,
    recordMode: record.recordMode,
    detailCompleteness: record.detailCompleteness,
    revision: record.revision,
    sourceMatchRevision: record.sourceMatchRevision,
    updatedAt: record.updatedAt,
    finalScore: record.finalScore ? { for: record.finalScore.for, against: record.finalScore.against } : null,
    goals: record.goals.map((goal) => ({
      id: goal.id,
      beneficiary: goal.beneficiary,
      isOwnGoal: goal.isOwnGoal,
      scorerPlayerId: goal.scorerPlayerId
    })),
    goalkeeperOutcomes: record.recordMode === "detailed_live" && record.participation?.every((row) => Array.isArray(row.intervals)) ? goalkeeperCleanSheetOutcomes({
      completed: record.status === "completed",
      reviewRequired: record.detailCompleteness !== "complete",
      activeDurationMs: record.actualActiveDurationMs ?? 0,
      intervals: record.participation.flatMap((row) => row.intervals.map((interval) => ({ ...interval, playerId: row.playerId }))),
      oppositionGoals: record.goals.filter((goal) => goal.beneficiary === "opposition").map((goal) => ({ atMs: goal.half !== null && goal.halfElapsedMs !== null ? goal.halfElapsedMs + (goal.half === 2 ? Math.max(0, ...record.participation.flatMap((row) => row.intervals.filter((interval) => interval.half === 1).map((interval) => interval.endMs))) : 0) : null })),
      recordedOppositionScore: record.finalScore?.against ?? null
    }) : record.goalkeeperOutcomes?.map((row) => ({ ...row })),
    participation: record.participation?.map((row) => ({
      playerId: row.playerId,
      playedMs: row.playedMs,
      positionMs: { ...row.positionMs }
    })) ?? null
  };
}
function playerStatsSourceFromRecords(input) {
  const { state } = input, records = /* @__PURE__ */ new Map();
  for (const record of state.results) {
    if (record.teamId !== state.teamId || record.seasonId !== state.seasonId)
      continue;
    const previous = records.get(record.id);
    if (!previous || record.revision > previous.revision)
      records.set(record.id, cleanEvidence(record));
  }
  for (const accepted2 of [...input.acceptedMatches ?? []].sort(
    (left, right) => left.match.revision - right.match.revision
  )) {
    const match = accepted2.match, id5 = match.config.matchId;
    if (accepted2.teamId !== state.teamId || accepted2.seasonId !== state.seasonId || match.status === "preparation")
      continue;
    if (match.config.fixture && (match.config.fixture.teamId !== state.teamId || match.config.fixture.seasonId !== state.seasonId))
      denied();
    const previous = records.get(id5);
    if (previous?.sourceMatchRevision != null && previous.sourceMatchRevision >= match.revision)
      continue;
    const sample = match.anchor?.sample ?? {
      monotonicMs: 0,
      sessionId: "stats-checkpoint",
      wallTimeMs: 0
    };
    const observed = match.eventHistory?.at(-1)?.sample.wallTimeMs ?? match.completedAtMs ?? match.anchor?.sample.wallTimeMs;
    records.set(id5, {
      id: id5,
      teamId: state.teamId,
      seasonId: state.seasonId,
      status: match.status === "completed" ? "completed" : match.status === "abandoned" ? "abandoned" : "incomplete",
      recordMode: "detailed_live",
      detailCompleteness: match.recoveryRequired ? "review_required" : "complete",
      revision: previous?.revision ?? 0,
      sourceMatchRevision: match.revision,
      updatedAt: typeof observed === "number" && observed > 0 && Number.isFinite(observed) ? new Date(observed).toISOString() : previous?.updatedAt ?? null,
      finalScore: { for: match.score.for, against: match.score.against },
      goals: goalRecords(match).filter((goal) => !goal.voided).map((goal) => ({
        id: goal.eventId,
        beneficiary: goal.beneficiary,
        isOwnGoal: goal.isOwnGoal,
        scorerPlayerId: goal.scorerPlayerId
      })),
      goalkeeperOutcomes: goalkeeperCleanSheetOutcomes({
        completed: match.status === "completed",
        reviewRequired: match.recoveryRequired || match.schemaVersion !== 2,
        activeDurationMs: match.matchActiveMs,
        intervals: match.intervals,
        oppositionGoals: goalRecords(match).filter((goal) => !goal.voided && goal.beneficiary === "opposition").map((goal) => ({ atMs: goal.effective.matchElapsedMs })),
        recordedOppositionScore: match.score.against
      }),
      participation: playerMinutes(match, sample).map((row) => ({
        playerId: row.playerId,
        playedMs: row.playingMs,
        positionMs: { ...row.positionMs }
      }))
    });
  }
  return {
    clubId: state.clubId,
    teamId: state.teamId,
    seasonId: state.seasonId,
    seasonLabel: state.seasonLabel,
    revision: state.revision,
    players: state.players.map((player) => ({
      id: player.id,
      label: player.label
    })),
    matches: [...records.values()],
    positions: (input.positions ?? []).map((position) => ({
      code: position.code,
      label: position.label,
      active: position.active
    })),
    formation: cleanFormation(input.formation ?? null)
  };
}
function cleanFormation(value) {
  if (!value || value.slots.some(
    (slot) => !Number.isFinite(slot.x) || !Number.isFinite(slot.y) || slot.x < 0 || slot.x > 1 || slot.y < 0 || slot.y > 1
  ))
    return null;
  return {
    id: value.id,
    label: value.label,
    slots: value.slots.map((slot) => ({
      id: slot.id,
      positionCode: slot.positionCode,
      label: slot.label,
      x: slot.x,
      y: slot.y
    }))
  };
}
function positionsFor(totals, knownPlayingMs, catalogue) {
  const codes = [
    .../* @__PURE__ */ new Set([
      ...catalogue.map((position) => position.code),
      ...Object.keys(totals)
    ])
  ];
  return codes.map((code) => ({
    code,
    label: catalogue.find((position) => position.code === code)?.label ?? code,
    playingMs: totals[code] ?? 0,
    percentage: knownPlayingMs > 0 ? (totals[code] ?? 0) / knownPlayingMs * 100 : null
  }));
}
function projectPlayerStats(source2, viewer) {
  if (!["manager", "administrator", "player"].includes(viewer.role) || viewer.teamId && viewer.teamId !== source2.teamId || viewer.seasonId && viewer.seasonId !== source2.seasonId)
    denied();
  const players = viewer.role === "player" ? source2.players.filter((player) => player.id === viewer.playerId) : source2.players;
  if (viewer.role === "player" && players.length !== 1) denied();
  const byId = /* @__PURE__ */ new Map();
  for (const record of source2.matches) {
    if (record.teamId !== source2.teamId || record.seasonId !== source2.seasonId || record.status === "cancelled" || record.status === "postponed")
      continue;
    if (record.status !== "completed" && !(record.recordMode === "detailed_live" && ["incomplete", "abandoned"].includes(record.status)))
      continue;
    const previous = byId.get(record.id);
    if (!previous || (record.sourceMatchRevision ?? -1) > (previous.sourceMatchRevision ?? -1) || record.sourceMatchRevision === previous.sourceMatchRevision && record.revision > previous.revision)
      byId.set(record.id, record);
  }
  const records = [...byId.values()], observed = records.map((record) => record.updatedAt).filter(instant).sort((left, right) => Date.parse(left) - Date.parse(right));
  const rows = players.map((player) => {
    const coverage = {
      recordedMatches: records.length,
      playingTimeKnownMatches: 0,
      playingTimeUnknownMatches: 0,
      reviewRequiredMatches: 0,
      scoringCompleteMatches: 0,
      scoringPartialMatches: 0,
      scoringUnknownMatches: 0
    };
    let knownPlayingMs2 = 0, knownAppearances = 0, knownGoals = 0, knownOwnGoals = 0, knownCleanSheets = 0, goalkeepingReviewedMatches = 0, goalkeepingUnknownMatches = 0, unknownPositionMs = 0;
    const positionMs2 = /* @__PURE__ */ Object.create(null);
    for (const record of records) {
      const goalkeeper = record.goalkeeperOutcomes?.find((row) => row.playerId === player.id);
      if (goalkeeper && goalkeeper.outcome !== "unknown") {
        goalkeepingReviewedMatches++;
        knownCleanSheets += Number(goalkeeper.outcome === "clean_sheet");
      } else if (goalkeeper || !record.participation || record.participation.some((row) => row.playerId === player.id && (row.positionMs.GK ?? 0) > 0)) goalkeepingUnknownMatches++;
      if (record.detailCompleteness === "review_required") {
        coverage.reviewRequiredMatches++;
        coverage.playingTimeUnknownMatches++;
        coverage.scoringUnknownMatches++;
        continue;
      }
      const entries = record.participation?.filter((entry2) => entry2.playerId === player.id) ?? [];
      const entry = entries.length === 1 ? entries[0] : null;
      const positions = entry ? Object.values(entry.positionMs) : [];
      if (entry && safeMs(entry.playedMs) && positions.every(safeMs) && positions.reduce((sum, ms) => sum + ms, 0) <= entry.playedMs) {
        coverage.playingTimeKnownMatches++;
        knownPlayingMs2 += entry.playedMs;
        knownAppearances += Number(entry.playedMs > 0);
        const named = Object.entries(entry.positionMs).filter(
          ([code]) => /^[A-Z]{2}$/.test(code)
        );
        unknownPositionMs += entry.playedMs - named.reduce((sum, [, ms]) => sum + ms, 0);
        for (const [code, ms] of named)
          positionMs2[code] = (positionMs2[code] ?? 0) + ms;
      } else coverage.playingTimeUnknownMatches++;
      const goals = [
        ...new Map(record.goals.map((goal) => [goal.id, goal])).values()
      ];
      const counts = record.scorerTotals?.find(
        (item) => item.playerId === player.id
      );
      knownGoals += counts && safeMs(counts.knownGoals) ? counts.knownGoals : goals.filter(
        (goal) => goal.beneficiary === "us" && !goal.isOwnGoal && goal.scorerPlayerId === player.id
      ).length;
      knownOwnGoals += counts && safeMs(counts.knownOwnGoals) ? counts.knownOwnGoals : goals.filter(
        (goal) => goal.beneficiary === "opposition" && goal.isOwnGoal && goal.scorerPlayerId === player.id
      ).length;
      const complete = record.finalScore !== null && goals.filter((goal) => goal.beneficiary === "us").length === record.finalScore.for && goals.filter((goal) => goal.beneficiary === "opposition").length === record.finalScore.against && goals.every(
        (goal) => goal.beneficiary === "us" && !goal.isOwnGoal || goal.beneficiary === "opposition" && goal.isOwnGoal ? goal.scorerPlayerId !== null : true
      );
      if (record.scoringCoverage === "complete" || !record.scoringCoverage && complete)
        coverage.scoringCompleteMatches++;
      else if (record.scoringCoverage === "partial" || !record.scoringCoverage && (record.finalScore !== null || goals.length))
        coverage.scoringPartialMatches++;
      else coverage.scoringUnknownMatches++;
    }
    return {
      playerId: player.id,
      label: player.label,
      knownPlayingMs: knownPlayingMs2,
      knownAppearances,
      knownGoals,
      knownOwnGoals,
      knownCleanSheets,
      goalkeepingReviewedMatches,
      goalkeepingUnknownMatches,
      positions: positionsFor(positionMs2, knownPlayingMs2, source2.positions),
      unknownPositionMs,
      coverage
    };
  });
  const scope = {
    clubId: source2.clubId,
    teamId: source2.teamId,
    seasonId: source2.seasonId,
    seasonLabel: source2.seasonLabel,
    projectionVersion: source2.revision,
    asOf: observed.at(-1) ?? null
  };
  if (viewer.role === "player")
    return { kind: "own-player-stats", scope, player: rows[0] };
  const knownPlayingMs = rows.reduce((sum, row) => sum + row.knownPlayingMs, 0), positionMs = /* @__PURE__ */ Object.create(null);
  for (const row of rows)
    for (const position of row.positions)
      positionMs[position.code] = (positionMs[position.code] ?? 0) + position.playingMs;
  return {
    kind: "team-player-stats",
    scope,
    players: rows,
    team: {
      knownPlayingMs,
      positions: positionsFor(positionMs, knownPlayingMs, source2.positions),
      unknownPositionMs: rows.reduce(
        (sum, row) => sum + row.unknownPositionMs,
        0
      )
    },
    formation: cleanFormation(source2.formation)
  };
}
function assertPlayerStatsDto(value, viewer) {
  const object5 = (item) => Boolean(item && typeof item === "object" && !Array.isArray(item));
  const exact2 = (item, fields5) => Object.keys(item).length === fields5.length && fields5.every((field) => Object.hasOwn(item, field));
  const text2 = (item) => typeof item === "string" && item.length > 0 && item.length <= 150 && !/[\u0000-\u001f\u007f]/.test(item);
  const number = (item) => typeof item === "number" && safeMs(item);
  const totals = (item) => {
    if (!object5(item) || !number(item.knownPlayingMs) || !number(item.unknownPositionMs) || !Array.isArray(item.positions))
      return false;
    let named = 0;
    const codes = /* @__PURE__ */ new Set();
    for (const position of item.positions) {
      if (!object5(position) || !exact2(position, ["code", "label", "playingMs", "percentage"]) || typeof position.code !== "string" || !/^[A-Z]{2}$/.test(position.code) || codes.has(position.code) || !text2(position.label) || !number(position.playingMs))
        return false;
      const expected = item.knownPlayingMs ? position.playingMs / item.knownPlayingMs * 100 : null;
      if (expected === null ? position.percentage !== null : typeof position.percentage !== "number" || !Number.isFinite(position.percentage) || Math.abs(position.percentage - expected) > 1e-6)
        return false;
      codes.add(position.code);
      named += position.playingMs;
    }
    return named + item.unknownPositionMs === item.knownPlayingMs;
  };
  const row = (item) => {
    if (!totals(item) || !exact2(item, [
      "playerId",
      "label",
      "knownPlayingMs",
      "knownAppearances",
      "knownGoals",
      "knownOwnGoals",
      "knownCleanSheets",
      "goalkeepingReviewedMatches",
      "goalkeepingUnknownMatches",
      "positions",
      "unknownPositionMs",
      "coverage"
    ]) || !text2(item.playerId) || !text2(item.label) || !number(item.knownAppearances) || !number(item.knownGoals) || !number(item.knownOwnGoals) || !number(item.knownCleanSheets) || !number(item.goalkeepingReviewedMatches) || !number(item.goalkeepingUnknownMatches) || item.knownCleanSheets > item.goalkeepingReviewedMatches || !object5(item.coverage))
      return false;
    const coverage = item.coverage;
    const fields5 = [
      "recordedMatches",
      "playingTimeKnownMatches",
      "playingTimeUnknownMatches",
      "reviewRequiredMatches",
      "scoringCompleteMatches",
      "scoringPartialMatches",
      "scoringUnknownMatches"
    ];
    return exact2(coverage, fields5) && fields5.every((field) => number(coverage[field])) && Number(coverage.playingTimeKnownMatches) + Number(coverage.playingTimeUnknownMatches) === coverage.recordedMatches && Number(coverage.scoringCompleteMatches) + Number(coverage.scoringPartialMatches) + Number(coverage.scoringUnknownMatches) === coverage.recordedMatches && Number(coverage.reviewRequiredMatches) <= Number(coverage.playingTimeUnknownMatches);
  };
  if (!object5(value) || !object5(value.scope) || !exact2(value.scope, [
    "clubId",
    "teamId",
    "seasonId",
    "seasonLabel",
    "projectionVersion",
    "asOf"
  ]) || !text2(value.scope.clubId) || value.scope.teamId !== viewer.teamId || value.scope.seasonId !== viewer.seasonId || !text2(value.scope.seasonLabel) || !number(value.scope.projectionVersion) || !(value.scope.asOf === null || typeof value.scope.asOf === "string" && instant(value.scope.asOf)))
    denied();
  if (viewer.role === "player") {
    if (value.kind !== "own-player-stats" || !exact2(value, ["kind", "scope", "player"]) || !row(value.player) || value.player.playerId !== viewer.playerId)
      denied();
    return;
  }
  if (!["manager", "administrator"].includes(viewer.role) || value.kind !== "team-player-stats" || !exact2(value, ["kind", "scope", "players", "team", "formation"]) || !Array.isArray(value.players) || !value.players.every(row) || new Set(value.players.map((player) => player.playerId)).size !== value.players.length || !totals(value.team) || !exact2(value.team, ["knownPlayingMs", "positions", "unknownPositionMs"]))
    denied();
  if (value.formation !== null && (!object5(value.formation) || !exact2(value.formation, ["id", "label", "slots"]) || !text2(value.formation.id) || !text2(value.formation.label) || !Array.isArray(value.formation.slots) || value.formation.slots.some(
    (slot) => !object5(slot) || !exact2(slot, ["id", "positionCode", "label", "x", "y"]) || !text2(slot.id) || !text2(slot.positionCode) || !text2(slot.label) || typeof slot.x !== "number" || typeof slot.y !== "number" || !Number.isFinite(slot.x) || !Number.isFinite(slot.y) || slot.x < 0 || slot.x > 1 || slot.y < 0 || slot.y > 1
  )))
    denied();
}

// packages/application/src/team-overview-service.ts
var active2 = /* @__PURE__ */ new Set(["first_half_running", "first_half_paused", "half_time", "second_half_running", "second_half_paused"]);
function assertTeamOverviewDto(value, scope) {
  const object5 = (item) => Boolean(item && typeof item === "object" && !Array.isArray(item));
  const keys2 = (item, names) => Object.keys(item).length === names.length && Object.keys(item).every((key) => names.includes(key));
  const text2 = (item, maximum = 200) => typeof item === "string" && item.length <= maximum && !/[\u0000-\u001f\u007f]/.test(item);
  const error = () => {
    throw new Error("The team overview differs from its current scope or contains unsupported private fields.");
  };
  if (!object5(value) || !keys2(value, ["kind", "teamId", "seasonId", "team", "games"]) || value.kind !== "team-overview" || value.teamId !== scope.teamId || value.seasonId !== scope.seasonId || !object5(value.team) || !keys2(value.team, ["name", "ageGroup", "clubName", "seasonLabel"]) || !Object.values(value.team).every((item) => text2(item)) || !Array.isArray(value.games)) return error();
  const ids = /* @__PURE__ */ new Set(), statuses = ["scheduled", "postponed", "cancelled", "preparation", ...active2, "completed", "abandoned"];
  for (const game of value.games) {
    if (!object5(game) || !keys2(game, ["id", "opponent", "playedDate", "kickoff", "venue", "status", "active"]) || typeof game.id !== "string" || !/^[A-Za-z0-9_.:-]{1,150}$/.test(game.id) || ids.has(game.id) || !text2(game.opponent) || typeof game.playedDate !== "string" || game.playedDate !== "" && (!/^\d{4}-\d{2}-\d{2}$/.test(game.playedDate) || !Number.isFinite(Date.parse(game.playedDate)) || new Date(game.playedDate).toISOString().slice(0, 10) !== game.playedDate) || !(game.kickoff === null || typeof game.kickoff === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(game.kickoff)) || !(game.venue === null || text2(game.venue, 1e3)) || !statuses.includes(String(game.status)) || typeof game.active !== "boolean" || game.active !== active2.has(String(game.status))) return error();
    ids.add(game.id);
  }
}

// apps/api/src/postgres-store.ts
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
  const fields5 = ["contractVersion", "schemaVersion", "engineVersion", "eventId", "matchId", "deviceId", "controllerEpoch", "clientSequence", "previousEventId", "baseRevision", "effectiveHalf", "halfElapsedMs", "matchElapsedMs", "effectiveAt", "recordedAt", "timeQuality", "clockEvidence", "command"];
  if (Object.keys(item).some((key) => !fields5.includes(key))) bad("Unknown event envelope fields are not accepted.");
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
var PostgresStore = class _PostgresStore {
  constructor(db, now = Date.now) {
    this.db = db;
    this.now = now;
  }
  db;
  now;
  static async open(connectionString2, now = Date.now, options = {}) {
    const db = new PgDatabase(connectionString2, options);
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
  async assertRuntimeRole(kind) {
    const role = await this.one(`SELECT r.rolsuper,r.rolbypassrls,longball.runtime_purpose() AS runtime_purpose,
     EXISTS(SELECT 1 FROM pg_catalog.pg_roles privileged WHERE (privileged.rolsuper OR privileged.rolbypassrls) AND pg_has_role(current_user,privileged.oid,'MEMBER')) AS privileged_membership,
     (EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname='longball' AND pg_has_role(current_user,n.nspowner,'MEMBER')) OR
      EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='longball' AND c.relkind IN('r','p') AND pg_has_role(current_user,c.relowner,'MEMBER'))) AS owns_data
     FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
    if (!role || role.rolsuper || role.rolbypassrls || role.privileged_membership || role.owns_data) throw new Error(`The PostgreSQL ${kind} requires a separate non-owner role without superuser, bypass-RLS or privileged-role membership.`);
    if (role.runtime_purpose !== kind) throw new Error(`The PostgreSQL role is not assigned the ${kind} runtime purpose.`);
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
  async seedSynthetic(options = {}) {
    await this.transaction(async () => {
      if (await this.one("SELECT id FROM teams LIMIT 1", []))
        return;
      await this.execute("INSERT INTO clubs(id,name) VALUES($1,$2),($3,$4)", ["synthetic-richmond-rovers", "Richmond Rovers", "synthetic-other-club", "Brookfield Juniors"]);
      await this.execute("INSERT INTO teams(id,name,club_id,scope_status) VALUES($1,$2,$3,'resolved')", [SYNTHETIC_IDS.teamId, "Roma U10", "synthetic-richmond-rovers"]);
      await this.execute("INSERT INTO teams(id,name,club_id,scope_status) VALUES($1,$2,$3,'resolved')", ["synthetic-other-team", "Milan U11", "synthetic-other-club"]);
      await this.execute("INSERT INTO team_seasons(club_id,team_id,season_id,label,start_year,start_date,end_date) VALUES($1,$2,$3,$4,$5,$6,$7),($8,$9,$3,$4,$5,$6,$7)", ["synthetic-richmond-rovers", SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, "2026/27", 2026, "2026-09-01", "2027-08-31", "synthetic-other-club", "synthetic-other-team"]);
      const add2 = async (id5, classification, adult) => await this.execute("INSERT INTO accounts(id,issuer,subject,classification,adult_verified,strong_auth_enrolled) VALUES($1,$2,$3,$4,$5,$6)", [id5, "urn:longball:synthetic", id5, classification, Number(adult), Number(adult)]);
      const membership = async (id5, role, playerId = null, teamId = SYNTHETIC_IDS.teamId) => await this.execute("INSERT INTO memberships(account_id,team_id,season_id,role,player_id) VALUES($1,$2,$3,$4,$5)", [id5, teamId, SYNTHETIC_IDS.seasonId, role, playerId]);
      await add2("synthetic-account-admin", "adult_individual", true);
      await membership("synthetic-account-admin", "administrator");
      for (let number = 1; number <= 5; number++) {
        const id5 = number === 1 ? "synthetic-account-manager" : `synthetic-account-manager-${number}`;
        await add2(id5, "adult_individual", true);
        if (number <= 4)
          await membership(id5, "manager");
        if (number === 1)
          await membership(id5, "administrator");
      }
      for (const player of romaFixture.players) {
        const id5 = `synthetic-account-player-${player.id.slice(-2)}`;
        await add2(id5, "child_shared", false);
        await membership(id5, "player", player.id);
      }
      await add2("synthetic-account-spectator", "adult_individual", false);
      await membership("synthetic-account-spectator", "spectator");
      await add2("synthetic-account-invitee", "adult_individual", false);
      await add2("synthetic-account-other-manager", "adult_individual", true);
      await membership("synthetic-account-other-manager", "manager", null, "synthetic-other-team");
      const preparation = createPreparationState({ demoScenario: options.demoSharing });
      const config = options.demoSharing ? fixtureMatchConfig(preparation, prepareFixtureSnapshot(preparation, SYNTHETIC_IDS.matchId)) : { matchId: SYNTHETIC_IDS.matchId, players: romaFixture.players, selectedPlayerIds: romaFixture.players.filter((player) => player.available).map((player) => player.id), pitchPlaces: 7, plannedHalfDurationMs: 15e5, fixedKeeperId: romaFixture.players[0].id, fixture: { opponent: "Maple FC", playedDate: "2026-10-24", kickoff: "10:00", homeAway: "home", teamId: SYNTHETIC_IDS.teamId, seasonId: SYNTHETIC_IDS.seasonId, teamName: "Roma", clubName: "Richmond Rovers" } };
      await this.insertMatch(config, SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId);
      const community = createCommunityState(this.now(), { demoScenario: options.demoSharing });
      if (options.demoSharing) await this.execute("UPDATE matches SET sharing_policy_json=$1 WHERE id=$2", [JSON.stringify({ version: "demo-simulated-scores-v1", approvedBy: "generated-demo-scenario-only", approvedAt: this.now(), shareScores: true, shareDerivedResults: true }), SYNTHETIC_IDS.matchId]);
      if (options.demoSharing) {
        for (const fixture of preparation.fixtures.filter((item) => item.playedDate >= romaFixture.demo.referenceDate && item.id !== SYNTHETIC_IDS.matchId)) {
          await this.insertMatch(fixtureMatchConfig(preparation, prepareFixtureSnapshot(preparation, fixture.id)), SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId);
        }
        for (const completed of createDemoCompletedMatches()) {
          await this.insertMatch(completed.config, SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId);
          await this.execute("UPDATE matches SET state_json=$1,last_sync_at=$2 WHERE id=$3", [JSON.stringify(completed), completed.completedAtMs, completed.config.matchId]);
        }
        await this.execute("UPDATE matches SET sharing_policy_json=$1 WHERE team_id=$2 AND season_id=$3", [JSON.stringify({ version: "demo-simulated-scores-v1", approvedBy: "generated-demo-scenario-only", approvedAt: this.now(), shareScores: true, shareDerivedResults: true }), SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId]);
        community.photos = [];
        community.matches = community.matches.map((match) => ({ ...match, voteCutoffAtMs: match.actualFullTimeAtMs + 45 * 6e4, cutoffSource: "explicit_fictional_setting" }));
      }
      if (!options.demoSharing) community.matches = community.matches.map((match) => ({ ...match, sharing: "manager_only" }));
      for (let number = 2; number <= 4; number++) {
        const id5 = `synthetic-account-manager-${number}`;
        community.accounts.push({ id: id5, label: demoAccountLabels[id5], classification: "adult_individual", adultVerified: true });
        community.memberships.push({ accountId: id5, teamId: SYNTHETIC_IDS.teamId, seasonId: SYNTHETIC_IDS.seasonId, role: "manager", active: true });
      }
      await this.saveDocument(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, "preparation", preparation);
      await this.saveDocument(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, "community", community);
      await this.saveDocument(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, "records", createRecordsSeed(options));
      if (options.demoSharing) {
        await add2("synthetic-account-club-admin", "adult_individual", true);
        await this.execute("INSERT INTO administration_grants(account_id,scope_key,level,club_id) VALUES('synthetic-account-admin','*','super',NULL),('synthetic-account-club-admin','synthetic-richmond-rovers','club','synthetic-richmond-rovers')");
        await this.execute("SELECT longball.sync_administrative_memberships()");
      }
      if (options.demoSharing) for (const match of community.matches) {
        const key = `award:${SYNTHETIC_IDS.teamId}:${SYNTHETIC_IDS.seasonId}:${match.id}:${match.voteCutoffAtMs}`;
        await this.execute("INSERT INTO jobs(id,business_key,kind,payload_json,due_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(business_key) DO NOTHING", [randomUUID2(), key, "award.finalise", JSON.stringify({ teamId: SYNTHETIC_IDS.teamId, seasonId: SYNTHETIC_IDS.seasonId, matchId: match.id }), match.voteCutoffAtMs]);
      }
    });
  }
  async insertMatch(config, teamId, seasonId) {
    await this.execute("INSERT INTO matches(id,team_id,season_id,config_json,state_json,sharing_policy_json) VALUES($1,$2,$3,$4,$5,$6)", [config.matchId, teamId, seasonId, JSON.stringify(config), JSON.stringify(createMatch(config)), JSON.stringify(UNAPPROVED_SHARING_POLICY)]);
  }
  async principal(identity) {
    const account2 = await this.one("SELECT * FROM accounts WHERE issuer=$1 AND subject=$2", [identity.issuer, identity.subject]);
    if (!account2 || account2.status !== "active")
      throw new AccessError("ACCOUNT_UNAVAILABLE", 403, "The account is not active for this service.");
    const authority = await this.one("SELECT longball.administration_scope($1) AS value", [account2.id]);
    const administration = authority?.value ? typeof authority.value === "string" ? JSON.parse(authority.value) : authority.value : void 0;
    return { accountId: account2.id, issuer: account2.issuer, subject: account2.subject, identityClassification: account2.classification, adultVerified: Boolean(account2.adult_verified), strongAuth: identity.strongAuth, authenticatedAt: identity.authenticatedAt, status: account2.status, ...administration ? { administration } : {} };
  }
  async memberships(accountId, scope) {
    const values = [], predicates = [];
    if (accountId !== void 0) {
      values.push(accountId);
      predicates.push(`m.account_id=$${values.length}`);
    }
    if (scope) {
      values.push(scope.teamId, scope.seasonId);
      predicates.push(`m.team_id=$${values.length - 1}`, `m.season_id=$${values.length}`);
    }
    const rows = await this.many("SELECT m.*,EXISTS(SELECT 1 FROM administrative_memberships am WHERE am.account_id=m.account_id AND am.team_id=m.team_id AND am.season_id=m.season_id AND am.role=m.role) administrative_inheritance,CASE WHEN m.role='spectator' THEN longball.spectator_grant_active(m.account_id,m.club_id,m.team_id,m.season_id) ELSE true END AS grant_active FROM memberships m" + (predicates.length ? " WHERE " + predicates.join(" AND ") : ""), values);
    return rows.map((row) => ({ accountId: row.account_id, teamId: row.team_id, seasonId: row.season_id, role: row.role, playerId: row.player_id ?? void 0, expiresAt: row.expires_at, revokedAt: row.role === "spectator" && !row.grant_active ? row.revoked_at ?? Math.max(1, this.now()) : row.revoked_at, ...row.administrative_inheritance ? { administrativeInheritance: true } : {} }));
  }
  async myMemberships(principal) {
    return currentMemberships(principal, await this.memberships(principal.accountId), this.now());
  }
  async workspaceMemberships(principal) {
    const own = await this.myMemberships(principal);
    if (!own.length) return [];
    const rows = await this.many("SELECT * FROM longball.workspace_membership_names()");
    return own.map((member) => namedWorkspaceMembership(member, rows.find((row) => row.team_id === member.teamId && row.season_id === member.seasonId)));
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
    assertCanManageTeam(principal, await this.myMemberships(principal), row.team_id, row.season_id, this.now());
    await this.assertScheduledMatchAvailable(row);
    return row;
  }
  async assertScheduledMatchAvailable(row) {
    const saved2 = await this.one("SELECT value_json FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='preparation'", [row.team_id, row.season_id]);
    if (saved2 && fixtureRecordingUnavailable(JSON.parse(saved2.value_json), row.id)) throw new AccessError("FIXTURE_UNAVAILABLE", 409, "This schedule item is cancelled, postponed or deleted. Match recording and downloads are unavailable.");
  }
  async matchDto(principal, matchId, requestedRole) {
    const row = await this.match(matchId);
    const dto2 = filterMatchForPrincipal({ principal, memberships: await this.myMemberships(principal), teamId: row.team_id, seasonId: row.season_id, state: JSON.parse(row.state_json), policy: JSON.parse(row.sharing_policy_json), lastSyncAt: row.last_sync_at, now: this.now(), requestedRole });
    await this.assertScheduledMatchAvailable(row);
    return dto2;
  }
  async download(principal, matchId, deviceId, syntheticOnly = false, controllerToken) {
    return this.transaction(async () => {
      const row = await this.managerMatch(principal, matchId);
      if (!validDeviceId(deviceId)) bad("A device identifier of at most 120 canonical characters is required.");
      if (controllerToken !== void 0) {
        const authority = await this.assertController(principal, matchId, controllerToken);
        if (authority.device_id !== deviceId || authority.frozen) throw new AccessError("CONTROLLER_REQUIRED", 409, "Use the current unfrozen controller device and capability.");
      }
      const stream = await this.one("SELECT sequence,previous_event_id FROM streams WHERE match_id=$1 AND device_id=$2", [matchId, deviceId]);
      const controller = await this.one("SELECT epoch,account_id,device_id,frozen FROM controller_grants WHERE match_id=$1", [matchId]);
      const events = await this.many("SELECT revision,received_at,envelope_json FROM events WHERE match_id=$1 AND disposition='accepted' ORDER BY revision LIMIT 10001", [matchId]);
      const transitions = await this.many("SELECT id,epoch,actor_id,from_device,to_device,kind,reason,created_at FROM controller_history WHERE match_id=$1 ORDER BY epoch,created_at,id LIMIT 10001", [matchId]);
      const saved2 = await this.one("SELECT value_json FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='records'", [row.team_id, row.season_id]);
      return buildOfflineDownload({ matchId, teamId: row.team_id, seasonId: row.season_id, deviceId, state: JSON.parse(row.state_json), checkpoint: { clientSequence: stream?.sequence ?? 0, previousEventId: stream?.previous_event_id ?? null }, controller: controller ?? null, events, transitions, publication: offlinePublication(matchId, JSON.parse(row.sharing_policy_json), saved2 ? JSON.parse(saved2.value_json) : null), nowMs: this.now(), syntheticOnly });
    });
  }
  async audit(principal, action, objectId, outcome) {
    await this.execute("INSERT INTO audit(id,actor_id,action,object_id,outcome,created_at) VALUES($1,$2,$3,$4,$5,$6)", [randomUUID2(), principal.accountId, action, objectId, outcome, this.now()]);
  }
  async idempotent(principal, operation, key, payload, work) {
    if (!validId3(key) || key.length < 8)
      bad("A stable Idempotency-Key is required for mutations.");
    const signature2 = digest(canonical4(payload));
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
    if (!validDeviceId(deviceId))
      bad("A device identifier of at most 120 canonical characters is required.");
    const prior = await this.one("SELECT * FROM controller_grants WHERE match_id=$1", [matchId]);
    if (prior)
      throw new AccessError("CONTROLLER_EXISTS", 409, "This match already has a controller. Use handover or audited recovery.");
    await this.bindDevice(principal, deviceId);
    const token = randomBytes(32).toString("base64url");
    await this.execute("INSERT INTO controller_grants(match_id,epoch,account_id,device_id,capability_hash) VALUES($1,$2,$3,$4,$5)", [matchId, 1, principal.accountId, deviceId, digest(token)]);
    await this.audit(principal, "controller.acquired", matchId, "accepted");
    return { epoch: 1, deviceId, controllerToken: token, checkpoint: (await this.download(principal, matchId, deviceId)).deviceCheckpoint };
  }
  async assertController(principal, matchId, token) {
    await this.managerMatch(principal, matchId);
    const grant = await this.one("SELECT * FROM controller_grants WHERE match_id=$1", [matchId]);
    if (!grant || grant.account_id !== principal.accountId || !token || digest(token) !== grant.capability_hash)
      throw new AccessError("CONTROLLER_REQUIRED", 409, "Only the selected manager and enrolled device may write this match.");
    return grant;
  }
  async issueClockChallenge(principal, matchId, token, input, policy) {
    const grant = await this.assertController(principal, matchId, token);
    if (!policy)
      throw new AccessError("CLOCK_POLICY_REQUIRED", 503, "An explicitly configured trusted-time policy is required before establishing an anchor.");
    if (!input || Object.keys(input).some((key) => !["deviceId", "controllerEpoch", "continuityId"].includes(key)) || !validDeviceId(input.deviceId) || !validId3(input.continuityId) || input.deviceId !== grant.device_id || input.controllerEpoch !== grant.epoch || grant.frozen)
      throw new AccessError("CLOCK_SCOPE_CONFLICT", 409, "Use the current unfrozen controller device, epoch and continuous-clock identity.");
    const challenge = issueClockChallenge({ accountId: principal.accountId, deviceId: grant.device_id, matchId, controllerEpoch: grant.epoch, continuityId: input.continuityId }, randomUUID2(), this.now(), policy);
    await this.execute("INSERT INTO clock_challenges(id,match_id,account_id,challenge_json) VALUES($1,$2,$3,$4)", [challenge.id, matchId, principal.accountId, JSON.stringify(challenge)]);
    return challenge;
  }
  async acknowledgeClockChallenge(principal, matchId, token, challengeId, sample, policy) {
    const grant = await this.assertController(principal, matchId, token);
    if (!policy)
      throw new AccessError("CLOCK_POLICY_REQUIRED", 503, "An explicitly configured trusted-time policy is required before establishing an anchor.");
    if (!sample || Object.keys(sample).some((key) => !["receivedMonotonicMs", "sentMonotonicMs"].includes(key)))
      bad("Use the documented continuous-clock receipt and send observations.");
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
      return { submissionId: event.event_id, matchId, eventId: event.event_id, deviceId: event.device_id, clientSequence: event.client_sequence, controllerEpoch: original.controllerEpoch ?? null, reason: event.reason, original, originalDigest: digest(canonical4(original)), receivedAt: new Date(event.received_at).toISOString() };
    }), ...conflicts.map((conflict2) => {
      const original = JSON.parse(conflict2.original_json);
      return { submissionId: conflict2.id, matchId, eventId: typeof original.eventId === "string" ? original.eventId : null, deviceId: typeof original.deviceId === "string" ? original.deviceId : null, clientSequence: typeof original.clientSequence === "number" ? original.clientSequence : null, controllerEpoch: typeof original.controllerEpoch === "number" ? original.controllerEpoch : null, reason: conflict2.reason, original, originalDigest: digest(canonical4(original)), receivedAt: new Date(conflict2.created_at).toISOString() };
    })];
    const proposals = (await this.many("SELECT receipt_json FROM reconciliation_proposals WHERE match_id=$1 ORDER BY created_at,id", [matchId])).map((item) => JSON.parse(item.receipt_json));
    return { matchId, acceptedRevision: state.revision, submissions, proposals, policy: Q08_RECONCILIATION_POLICY };
  }
  async proposeReconciliation(principal, matchId, input) {
    const row = await this.managerMatch(principal, matchId);
    const state = JSON.parse(row.state_json);
    if (!input || Object.keys(input).some((key) => !["proposalId", "baseRevision", "sourceSubmissionIds", "reason", "resolution", "commands"].includes(key)))
      bad("Use only the documented immutable reconciliation proposal fields.");
    const signature2 = digest(canonical4(input));
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
    const receipt = { input, matchId, actorId: principal.accountId, createdAt: new Date(this.now()).toISOString(), sourceDigests: input.sourceSubmissionIds.map((id5) => ({ submissionId: id5, originalDigest: snapshot.submissions.find((item) => item.submissionId === id5).originalDigest })), acceptedStateDigest: digest(canonical4(state)), preview: savedPreview, status: "prepared", appliedRevision: null };
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
    const conflict2 = await this.one("SELECT id FROM conflicting_submissions WHERE match_id=$1 LIMIT 1", [matchId]);
    const unresolved = Boolean(quarantine || conflict2);
    if (existing) {
      const retainedFinishId = state.eventHistory?.filter((event) => event.type === "half.ended").at(-1)?.id;
      const retainedFinish = retainedFinishId ? await this.one("SELECT envelope_json FROM events WHERE event_id=$1 AND match_id=$2 AND disposition='accepted'", [retainedFinishId, matchId]) : void 0;
      const currentGrant = await this.one("SELECT epoch FROM controller_grants WHERE match_id=$1", [matchId]);
      const sourceEpoch = retainedFinish ? JSON.parse(retainedFinish.envelope_json).controllerEpoch : null;
      const quality = unresolved ? "conflicted" : state.recoveryRequired || sourceEpoch !== currentGrant?.epoch || finishEligibilityChanged(state, existing) ? "review_required" : existing.finishQuality;
      if (quality !== existing.finishQuality) {
        const next2 = { ...community, revision: community.revision + 1, matches: community.matches.map((match) => match.id === matchId ? { ...match, finishQuality: quality } : match), audit: [...community.audit, { id: randomUUID2(), actorAccountId: null, action: "service.finish_evidence_flagged_without_reopening", atMs: this.now() }] };
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
    const next = { ...community, revision: community.revision + 1, matches: [...community.matches, { ...context, voteCutoffAtMs: null, cutoffSource: "unresolved", finalisationDeadlineAtMs: context.actualFullTimeAtMs === null ? null : context.actualFullTimeAtMs + 36e5 }], audit: [...community.audit, { id: randomUUID2(), actorAccountId: null, action: "service.accepted_finish_registered_manager_only", atMs: this.now() }] };
    await this.saveDocument(row.team_id, row.season_id, "community", next);
    return { status: "registered_from_accepted_history", finishQuality: context.finishQuality };
  }
  async refreshDetailedArchive(row, match) {
    const saved2 = await this.one("SELECT value_json FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='records'", [row.team_id, row.season_id]);
    if (!saved2)
      return;
    const records = JSON.parse(saved2.value_json);
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
    const updated = reduceRecords({ ...records, liveMatch: context }, { type: "live.archive", commandId: `accepted-archive-${digest(canonical4([archived.id, match.revision]))}`, at: new Date(this.now()).toISOString(), actor: "manager", match, reason: "Existing detailed archive refreshed from the newer accepted canonical match revision; original source events and prior archive audit remain retained." });
    const projected = { ...updated, liveMatch: records.liveMatch };
    await this.saveDocument(row.team_id, row.season_id, "records", projected);
  }
  async upload(principal, matchId, token, values) {
    const row = await this.managerMatch(principal, matchId);
    if (!Array.isArray(values) || values.length === 0 || values.length > 100)
      bad("Upload between one and 100 ordered events.");
    const grant = await this.one("SELECT * FROM controller_grants WHERE match_id=$1", [matchId]);
    const currentCapability = !!grant && grant.account_id === principal.accountId && !!token && digest(token) === grant.capability_hash;
    let state = JSON.parse(row.state_json);
    const results = [];
    for (const value of values) {
      const event = validateEnvelope(value, matchId);
      const device = await this.one("SELECT account_id FROM devices WHERE id=$1", [event.deviceId]);
      if (!device || device.account_id !== principal.accountId)
        throw new AccessError("DEVICE_BINDING_REQUIRED", 403, "This event device is not enrolled to the authenticated account.");
      const signature2 = digest(canonical4(event));
      const previous = await this.one("SELECT * FROM events WHERE event_id=$1", [event.eventId]);
      if (previous) {
        if (previous.match_id !== matchId || previous.signature !== signature2) {
          await this.execute("INSERT INTO conflicting_submissions VALUES($1,$2,$3,$4,$5,$6)", [randomUUID2(), matchId, principal.accountId, JSON.stringify(value), "EVENT_ID_CONFLICT", this.now()]);
          results.push({ eventId: event.eventId, clientSequence: event.clientSequence, disposition: "quarantined", reason: "EVENT_ID_CONFLICT", revision: null, duplicate: false });
        } else
          results.push({ eventId: previous.event_id, clientSequence: previous.client_sequence, disposition: previous.disposition, reason: previous.reason, revision: previous.revision, duplicate: true });
        continue;
      }
      const stream = await this.one("SELECT sequence,previous_event_id FROM streams WHERE match_id=$1 AND device_id=$2", [matchId, event.deviceId]);
      if (event.clientSequence !== (stream?.sequence ?? 0) + 1 || event.previousEventId !== (stream?.previous_event_id ?? null)) {
        await this.execute("INSERT INTO conflicting_submissions VALUES($1,$2,$3,$4,$5,$6)", [randomUUID2(), matchId, principal.accountId, JSON.stringify(value), "SEQUENCE_GAP_OR_REUSE", this.now()]);
        results.push({ eventId: event.eventId, clientSequence: event.clientSequence, disposition: "quarantined", reason: "SEQUENCE_GAP_OR_REUSE", revision: null, duplicate: false });
        continue;
      }
      let reason = null;
      if (event.contractVersion !== EVENT_CONTRACT_VERSION || event.schemaVersion !== 1 || event.engineVersion !== ENGINE_VERSION)
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
    if (!validId3(toAccountId) || !validDeviceId(toDeviceId))
      bad("A target account and canonical device identifier of at most 120 characters are required.");
    const target = await this.one("SELECT * FROM accounts WHERE id=$1", [toAccountId]);
    if (!target)
      throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    const targetPrincipal = { accountId: target.id, issuer: target.issuer, subject: target.subject, identityClassification: target.classification, adultVerified: !!target.adult_verified, strongAuth: !!target.strong_auth_enrolled, authenticatedAt: this.now(), status: target.status };
    assertCanManageTeam(targetPrincipal, await this.memberships(), row.team_id, row.season_id, this.now());
    const id5 = randomUUID2();
    await this.execute("INSERT INTO transfers VALUES($1,$2,$3,$4,$5,$6,$7)", [id5, matchId, grant.epoch, toAccountId, toDeviceId, "pending", this.now()]);
    await this.execute("UPDATE controller_grants SET frozen=1 WHERE match_id=$1", [matchId]);
    await this.audit(principal, "controller.transfer_offered", matchId, "pending");
    return { transferId: id5, state: "pending", acceptedRevision: state.revision };
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
    const capability = randomBytes(32).toString("base64url");
    const epoch = grant.epoch + 1;
    await this.execute("UPDATE controller_grants SET epoch=$1,account_id=$2,device_id=$3,capability_hash=$4,frozen=0 WHERE match_id=$5", [epoch, principal.accountId, deviceId, digest(capability), matchId]);
    await this.execute("UPDATE transfers SET state='accepted' WHERE id=$1", [transferId]);
    await this.execute("INSERT INTO controller_history VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [randomUUID2(), matchId, epoch, principal.accountId, grant.device_id, deviceId, "transferred", null, this.now()]);
    await this.audit(principal, "controller.transferred", matchId, "accepted");
    return { epoch, deviceId, controllerToken: capability, checkpoint: (await this.download(principal, matchId, deviceId)).deviceCheckpoint, acceptedRevision: JSON.parse((await this.match(matchId)).state_json).revision };
  }
  async recover(principal, matchId, deviceId, reason) {
    const row = await this.managerMatch(principal, matchId);
    assertAdultAuthority(principal, true, this.now());
    if (!validDeviceId(deviceId) || typeof reason !== "string" || reason.trim().length < 5 || reason.length > 500)
      bad("Recovery needs a target canonical device identifier of at most 120 characters and a concise audit reason.");
    await this.bindDevice(principal, deviceId);
    const old = await this.one("SELECT * FROM controller_grants WHERE match_id=$1", [matchId]);
    const capability = randomBytes(32).toString("base64url");
    const epoch = (old?.epoch ?? 0) + 1;
    const state = JSON.parse(row.state_json);
    if (state.status.endsWith("_running")) {
      state.recoveryRequired = true;
      state.recoveryReason = "Controller recovery: reconcile the referee clock and any unsynchronised old-device events.";
      await this.execute("UPDATE matches SET state_json=$1 WHERE id=$2", [JSON.stringify(state), matchId]);
    }
    await this.execute("INSERT INTO controller_grants(match_id,epoch,account_id,device_id,capability_hash,frozen) VALUES($1,$2,$3,$4,$5,0) ON CONFLICT(match_id) DO UPDATE SET epoch=excluded.epoch,account_id=excluded.account_id,device_id=excluded.device_id,capability_hash=excluded.capability_hash,frozen=0", [matchId, epoch, principal.accountId, deviceId, digest(capability)]);
    await this.execute("UPDATE transfers SET state='superseded' WHERE match_id=$1 AND state='pending'", [matchId]);
    await this.execute("INSERT INTO controller_history VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [randomUUID2(), matchId, epoch, principal.accountId, old?.device_id ?? null, deviceId, "recovered", reason.trim(), this.now()]);
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
    const evidence = accounts.map((account2) => ({ accountId: account2.id, label: community.accounts.find((item) => item.id === account2.id)?.label ?? "Verified adult account", status: account2.status, identityClassification: account2.classification, adultVerified: Boolean(account2.adult_verified), strongAuthEnrolled: Boolean(account2.strong_auth_enrolled) }));
    return managerRoster({ principal, memberships: await this.memberships(), accounts: evidence, teamId, seasonId, nowMs: this.now(), revision: await this.staffRevision(teamId, seasonId), requestedRole });
  }
  async assignManager(actor, teamId, seasonId, accountId, expectedRevision) {
    assertTeamRole(actor, await this.memberships(), teamId, seasonId, ["administrator"], this.now());
    assertAdultAuthority(actor, true, this.now());
    if (!validId3(accountId))
      bad("A canonical account identifier is required.");
    if (expectedRevision !== void 0 && (!nonnegative3(expectedRevision) || expectedRevision !== await this.staffRevision(teamId, seasonId)))
      throw new AccessError("STALE_REVISION", 409, "Refresh the current staff assignments before changing them.");
    const account2 = await this.one("SELECT * FROM accounts WHERE id=$1", [accountId]);
    if (!account2)
      throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    const target = { accountId: account2.id, issuer: account2.issuer, subject: account2.subject, identityClassification: account2.classification, adultVerified: !!account2.adult_verified, strongAuth: !!account2.strong_auth_enrolled, authenticatedAt: this.now(), status: account2.status };
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
    if (!input || Object.keys(input).some((key) => !["accountId", "reason", "confirmRevocation"].includes(key)) || !validId3(input.accountId) || input.confirmRevocation !== true || typeof input.reason !== "string" || input.reason.trim().length < 5 || input.reason.length > 500)
      bad("Confirm a scoped manager revocation and record its evidence reason.");
    if (expectedRevision !== void 0 && (!nonnegative3(expectedRevision) || expectedRevision !== await this.staffRevision(teamId, seasonId)))
      throw new AccessError("STALE_REVISION", 409, "Refresh the current staff assignments before changing them.");
    const member = await this.one("SELECT m.account_id,m.revoked_at,EXISTS(SELECT 1 FROM administrative_memberships am WHERE am.account_id=m.account_id AND am.team_id=m.team_id AND am.season_id=m.season_id AND am.role=m.role) AS inherited FROM memberships m WHERE m.account_id=$1 AND m.team_id=$2 AND m.season_id=$3 AND m.role='manager'", [input.accountId, teamId, seasonId]);
    if (!member || member.inherited)
      throw new AccessError("NOT_FOUND", 404, "That appointed manager assignment is unavailable.");
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
      requestId = randomUUID2();
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
  async bindIdentity(accountId, issuer, subject) {
    await this.execute("UPDATE accounts SET issuer=$1,subject=$2 WHERE id=$3", [issuer, subject, accountId]);
  }
  async bindDevice(principal, deviceId) {
    const device = await this.one("SELECT account_id FROM devices WHERE id=$1", [deviceId]);
    if (device && device.account_id !== principal.accountId)
      throw new AccessError("DEVICE_ACCOUNT_CONFLICT", 409, "Enrol a separate device identity for this account.");
    await this.execute("INSERT INTO devices(id,account_id) VALUES($1,$2) ON CONFLICT(id) DO NOTHING", [deviceId, principal.accountId]);
    const bound = await this.one("SELECT account_id FROM devices WHERE id=$1 AND account_id=$2", [deviceId, principal.accountId]);
    if (!bound) throw new AccessError("DEVICE_ACCOUNT_CONFLICT", 409, "Enrol a separate device identity for this account.");
  }
  async teamMatches(principal, teamId, seasonId, requestedRole, query = { limit: 25, cursor: null }) {
    const memberships = await this.memberships();
    const audience = matchPageAudience(principal, memberships, teamId, seasonId, requestedRole, this.now());
    const scope = { principal, teamId, seasonId, role: audience.role, playerId: audience.playerId ?? null, status: query.status }, afterId = matchPagePosition(scope, query);
    const rows = await this.many(`SELECT m.id,m.state_json,m.sharing_policy_json,m.last_sync_at FROM matches m WHERE m.team_id=$1 AND m.season_id=$2 AND ($3::text IS NULL OR m.id COLLATE "C" > $3::text COLLATE "C") AND (NOT $4::boolean OR m.state_json::jsonb ->> 'status' IN ('first_half_running','first_half_paused','half_time','second_half_running','second_half_paused'))
      AND NOT EXISTS(SELECT 1 FROM documents d WHERE d.team_id=m.team_id AND d.season_id=m.season_id AND d.kind='preparation' AND(
        EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(d.value_json->'fixtures','[]'::jsonb)) f WHERE f->>'id'=m.id AND f->>'status'<>'scheduled')
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(d.value_json#>'{fixtureManagement,tombstones}','[]'::jsonb)) t WHERE t#>>'{fixture,id}'=m.id)))
      ORDER BY m.id COLLATE "C" LIMIT $5`, [teamId, seasonId, afterId, query.status === "active", query.limit + 1]);
    const visible = rows.slice(0, query.limit);
    return { items: visible.map((row) => filterMatchForPrincipal({ principal, memberships, teamId, seasonId, state: JSON.parse(row.state_json), policy: JSON.parse(row.sharing_policy_json), lastSyncAt: row.last_sync_at, requestedRole, now: this.now() })), nextCursor: rows.length > query.limit ? matchPageCursor(scope, visible[visible.length - 1].id) : null, serverTime: new Date(this.now()).toISOString() };
  }
  async document(teamId, seasonId, kind) {
    const row = await this.one("SELECT value_json FROM documents WHERE team_id=$1 AND season_id=$2 AND kind=$3", [teamId, seasonId, kind]);
    if (!row)
      throw new AccessError("NOT_FOUND", 404, "The requested object is unavailable.");
    return JSON.parse(row.value_json);
  }
  async saveDocument(teamId, seasonId, kind, state) {
    await this.execute("INSERT INTO documents(team_id,season_id,kind,revision,value_json) VALUES($1,$2,$3,$4,$5) ON CONFLICT(team_id,season_id,kind) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json", [teamId, seasonId, kind, state.revision, JSON.stringify(state)]);
  }
  async enqueueNotifications(teamId, seasonId, category, entityId2, sourceId) {
    const workerJob = this.db.applicationContext?.kind === "worker_job";
    const observed = workerJob ? (await this.one("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms"))?.now_ms : this.now();
    if (typeof observed !== "number" || !Number.isSafeInteger(observed) || observed < 0) throw new Error("DATABASE_CLOCK_UNAVAILABLE");
    const recipients = /* @__PURE__ */ new Map();
    const priority = { manager: 3, player: 2, spectator: 1, administrator: 0 };
    for (const member of (await this.memberships(void 0, { teamId, seasonId })).filter((item) => item.teamId === teamId && item.seasonId === seasonId && ["manager", "player", "spectator"].includes(item.role) && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > observed))) {
      const current3 = recipients.get(member.accountId);
      if (!current3 || priority[member.role] > priority[current3.role])
        recipients.set(member.accountId, member);
    }
    let inserted = 0;
    const pending = [];
    for (const member of recipients.values()) {
      if (member.role === "administrator" || member.role === "player" && !member.playerId)
        continue;
      const businessKey = `notify:${digest(canonical4([teamId, seasonId, category, entityId2, sourceId, member.accountId, member.role]))}`;
      const job = createTeamNotificationJob({ id: randomUUID2(), businessKey, accountId: member.accountId, teamId, seasonId, audience: member.role, playerId: member.role === "player" ? member.playerId : null, category, entityId: entityId2, dueAtMs: observed });
      if (workerJob) {
        const result = await this.one("SELECT longball.enqueue_award_notification($1,$2,$3::jsonb,$4) AS changes", [job.id, businessKey, JSON.stringify(job), job.dueAtMs]);
        inserted += Number(result?.changes ?? 0);
      } else pending.push(job);
    }
    for (let offset = 0; offset < pending.length; offset += 100) {
      const batch = pending.slice(offset, offset + 100);
      const result = await this.execute("INSERT INTO jobs(id,business_key,kind,payload_json,due_at) SELECT incoming.value->>'id',incoming.value->>'businessKey','notification.dispatch',incoming.value,(incoming.value->>'dueAtMs')::bigint FROM jsonb_array_elements($1::jsonb) AS incoming(value) ON CONFLICT(business_key) DO NOTHING", [JSON.stringify(batch)]);
      inserted += Number(result.changes);
    }
    return inserted;
  }
  async preparation(principal, teamId, seasonId) {
    assertCanManageTeam(principal, await this.memberships(), teamId, seasonId, this.now());
    return await this.document(teamId, seasonId, "preparation");
  }
  async protectedScheduleFixtures(teamId, seasonId) {
    return (await this.many(`SELECT m.id FROM matches m WHERE m.team_id=$1 AND m.season_id=$2 AND (
      COALESCE((m.state_json->>'revision')::bigint,-1)<>0 OR m.state_json->>'status'<>'preparation'
      OR EXISTS(SELECT 1 FROM controller_grants g WHERE g.match_id=m.id) OR EXISTS(SELECT 1 FROM controller_history h WHERE h.match_id=m.id)
      OR EXISTS(SELECT 1 FROM events e WHERE e.match_id=m.id) OR EXISTS(SELECT 1 FROM conflicting_submissions c WHERE c.match_id=m.id)
      OR EXISTS(SELECT 1 FROM transfers t WHERE t.match_id=m.id))`, [teamId, seasonId])).map((row) => row.id);
  }
  scheduledGameResult(value) {
    const result = typeof value === "string" ? JSON.parse(value) : value;
    const errors = {
      STALE_REVISION: [409, "The schedule changed. Refresh it before reviewing this decision again."],
      MATCH_HISTORY_EXISTS: [409, "This game has recording authority or saved match history. Preserve its recorded snapshot."],
      FIXTURE_DELETED: [409, "This schedule item was deleted. Its audit remains retained; create a new fixture identity."],
      IDEMPOTENCY_CONFLICT: [409, "This command identity already preserves another decision."],
      ALREADY_CANCELLED: [409, "This fixture is already cancelled."],
      NOT_FOUND: [404, "The requested schedule item is unavailable."],
      INVALID_REQUEST: [400, "Use the bounded reviewed scheduled-game command."]
    };
    if (typeof result?.error === "string" && errors[result.error]) {
      const [status, message] = errors[result.error];
      throw new AccessError(result.error, status, message);
    }
    if (result?.kind !== "scheduled-game-management" || !Array.isArray(result.fixtures)) throw new Error("Invalid scheduled-game metadata projection.");
    return result;
  }
  async scheduledGames(principal, teamId, seasonId, role) {
    assertTeamRole(principal, await this.memberships(), teamId, seasonId, [role], this.now());
    assertAdultAuthority(principal, role === "administrator", this.now());
    const row = await this.one("SELECT longball.scheduled_games($1,$2) AS value", [teamId, seasonId]);
    return this.scheduledGameResult(row?.value);
  }
  async teamOverview(principal, teamId, seasonId, role) {
    if (!role || !["manager", "administrator", "player", "spectator"].includes(role)) throw new AccessError("NOT_FOUND", 404, "Choose the current team overview context.");
    assertTeamRole(principal, await this.memberships(), teamId, seasonId, [role], this.now());
    const row = await this.one("SELECT longball.team_overview_source($1,$2) AS value", [teamId, seasonId]);
    const dto2 = typeof row?.value === "string" ? JSON.parse(row.value) : row?.value;
    assertTeamOverviewDto(dto2, { teamId, seasonId });
    return dto2;
  }
  async scheduledGameCommand(principal, teamId, seasonId, input, role) {
    assertTeamRole(principal, await this.memberships(), teamId, seasonId, [role], this.now());
    assertAdultAuthority(principal, role === "administrator", this.now());
    const command = parseScheduledGameCommand(input);
    return this.transaction(async () => {
      const row = await this.one("SELECT longball.manage_scheduled_game($1,$2,$3::jsonb) AS value", [teamId, seasonId, JSON.stringify(command)]);
      return this.scheduledGameResult(row?.value);
    });
  }
  async configuration(principal, teamId, seasonId, role) {
    if (role)
      assertTeamRole(principal, await this.memberships(), teamId, seasonId, role === "manager" || role === "administrator" ? [role] : [], this.now());
    const state = await this.document(teamId, seasonId, "preparation");
    return configurationServiceView({ principal, memberships: await this.memberships(), preparation: state, seasonId, nowMs: this.now() });
  }
  async configurationCommand(principal, teamId, seasonId, command, role) {
    await this.configuration(principal, teamId, seasonId, role);
    if (!command || !["club.updated", "team.updated", "team.league_updated", "team.alerts_updated"].includes(command.type))
      bad("Only club or team configuration can be changed in this context.");
    if (role && command.type === "club.updated" && role !== "administrator")
      throw new AccessError("NOT_FOUND", 404, "Choose the current administrator context to administer the club.");
    const state = applyConfigurationServiceCommand({ principal, memberships: await this.memberships(), preparation: await this.document(teamId, seasonId, "preparation"), seasonId, nowMs: this.now(), command });
    await this.saveDocument(teamId, seasonId, "preparation", state);
    if (command.type === "club.updated") await this.execute("SELECT longball.sync_club_configuration($1,$2)", [teamId, seasonId]);
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
      accounts: accounts.map((account2) => ({ accountId: account2.id, label: community.accounts.find((item) => item.id === account2.id)?.label ?? "Verified account", status: account2.status, identityClassification: account2.classification, adultVerified: Boolean(account2.adult_verified), strongAuthEnrolled: Boolean(account2.strong_auth_enrolled) }))
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
    for (const member of plan.memberships.filter((item) => !item.administrativeInheritance))
      await this.execute("INSERT INTO memberships(account_id,team_id,season_id,role,player_id,expires_at,revoked_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [member.accountId, member.teamId, member.seasonId, member.role, member.playerId ?? null, member.expiresAt ?? null, member.revokedAt ?? null]);
    await this.saveDocument(teamId, plan.receipt.seasonId, "preparation", plan.preparation);
    await this.saveDocument(teamId, plan.receipt.seasonId, "records", plan.records);
    await this.saveDocument(teamId, plan.receipt.seasonId, "community", plan.community);
    await this.execute("SELECT longball.inherit_administration_for_season($1,$2)", [teamId, plan.receipt.seasonId]);
    await this.audit(principal, "season.created_from_explicit_assignments", plan.receipt.seasonId, "accepted_no_spectator_renewal");
    return plan.receipt;
  }
  /** Called inside the preparation mutation transaction; current labels never rewrite saved match evidence. */
  async projectPreparationRecords(teamId, seasonId, preparation, sourceCommandId) {
    const previous = await this.document(teamId, seasonId, "records");
    const labels2 = new Map(previous.players.map((player) => [player.id, player]));
    for (const profile of preparation.profiles.filter((profile2) => profile2.seasonId === seasonId))
      labels2.set(profile.playerId, { id: profile.playerId, label: profile.displayName });
    const players = [...labels2.values()];
    const evidence = trainingAttendanceEvidence({ ...preparation, training: preparation.training.filter((session) => session.seasonId === seasonId) });
    let records = previous;
    const at = new Date(this.now()).toISOString();
    if (canonical4(players) !== canonical4(previous.players))
      records = {
        ...records,
        players,
        revision: records.revision + 1,
        audit: [...records.audit, { commandId: `preparation-roster-${sourceCommandId}`, action: "preparation.roster.projected", matchId: null, at, reason: "Current season roster labels updated from preparation; saved match snapshots preserved.", before: null, after: null }]
      };
    if (canonical4(evidence) !== canonical4(previous.trainingAttendance))
      records = reduceRecords(records, { type: "training.evidence.replace", commandId: `preparation-training-${sourceCommandId}`, at, actor: "manager", evidence });
    const gameEvidence = gamePreparationEvidence(preparation, seasonId, sourceCommandId);
    if (canonical4(gameEvidence.map(({ matchId, responses }) => ({ matchId, responses }))) !== canonical4((previous.gamePreparation ?? []).map(({ matchId, responses }) => ({ matchId, responses }))))
      records = reduceRecords(records, { type: "game.evidence.replace", commandId: `preparation-games-${sourceCommandId}`, at, actor: "manager", evidence: gameEvidence });
    if (records !== previous)
      await this.saveDocument(teamId, seasonId, "records", records);
  }
  async preparationCommand(principal, teamId, seasonId, command) {
    const previous = await this.preparation(principal, teamId, seasonId);
    const types2 = ["club.updated", "team.updated", "season.rolled_over", "profile.saved", "roster.imported", "roster.proforma_imported", "team.league_updated", "team.alerts_updated", "profile.archived", "formation.saved", "position.saved", "position.archived", "lineup_template.saved", "lineup_template.archived", "lineup_template.applied", "lineup_template.cleared", "fixture.saved", "fixture.status_changed", "fixture.response_recorded", "fixture.selection_saved", "fixture.attendance_recorded", "fixture.prepared", "match_plan.saved", "match_plan.applied", "match_plan.cleared", "training.series_created", "training.series_updated", "training.series_cancelled", "training.saved", "training.status_changed", "training.response_recorded", "training.attendance_recorded"];
    if (!command || !types2.includes(command.type))
      bad("Unsupported preparation command.");
    if (command.type === "season.rolled_over")
      throw new AccessError("SEASON_ASSIGNMENT_REQUIRED", 503, "A connected new season requires approved manager/player assignments and explicit spectator renewal. The local rehearsal supports rollover; this service will not save an inaccessible new season or silently copy authority.");
    if (command.type === "club.updated") {
      assertTeamRole(principal, await this.memberships(), teamId, seasonId, ["administrator"], this.now());
      assertAdultAuthority(principal, true, this.now());
    }
    if (command.type === "fixture.saved") assertFixtureNotDeleted(previous, command.fixture.id);
    else if ("fixtureId" in command && typeof command.fixtureId === "string") assertFixtureNotDeleted(previous, command.fixtureId);
    const protectedFixtureIds = [];
    if (["match_plan.applied", "match_plan.cleared", "lineup_template.applied", "lineup_template.cleared", "fixture.status_changed"].includes(command.type) && "fixtureId" in command && typeof command.fixtureId === "string") {
      if ((await this.protectedScheduleFixtures(teamId, seasonId)).includes(command.fixtureId)) protectedFixtureIds.push(command.fixtureId);
      if (protectedFixtureIds.length && ["fixture.status_changed", "match_plan.cleared"].includes(command.type)) throw new AccessError("MATCH_HISTORY_EXISTS", 409, "This game has recording authority or saved match history. Preserve its schedule and recorded snapshot.");
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
        if (canonical4(JSON.parse(existing.config_json)) !== canonical4(config)) {
          const matchState = JSON.parse(existing.state_json);
          const claimed = await this.one("SELECT match_id FROM controller_grants WHERE match_id=$1", [config.matchId]);
          const history = await this.one("SELECT event_id FROM events WHERE match_id=$1 LIMIT 1", [config.matchId]);
          if (claimed || history || matchState.revision !== 0 || matchState.status !== "preparation")
            throw new AccessError("MATCH_HISTORY_EXISTS", 409, "This match already has a controller or recorded history. Preserve its saved snapshot and reconcile changes explicitly.");
          await this.execute("UPDATE matches SET config_json=$1,state_json=$2 WHERE id=$3", [JSON.stringify(config), JSON.stringify(createMatch(config)), config.matchId]);
        }
      }
    }
    if (command.type.startsWith("training.") || command.type.startsWith("profile.") || command.type.startsWith("fixture.") || command.type === "roster.imported" || command.type === "roster.proforma_imported")
      await this.projectPreparationRecords(teamId, seasonId, state, command.id);
    await this.saveDocument(teamId, seasonId, "preparation", state);
    if (command.type === "club.updated") await this.execute("SELECT longball.sync_club_configuration($1,$2)", [teamId, seasonId]);
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
      for (const id5 of command.occurrenceIds) await this.enqueueNotifications(teamId, seasonId, "schedule", id5, command.id);
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
    if (!command || !validId3(command.id) || !nonnegative3(command.expectedRevision) || !["own.preferences_saved", "own.fa_id_saved", "own.fixture_response_recorded", "own.training_response_recorded"].includes(command.type))
      bad("A valid own-player command and source revision are required.");
    const allowed = command.type === "own.preferences_saved" ? ["id", "expectedRevision", "type", "preferences"] : command.type === "own.fa_id_saved" ? ["id", "expectedRevision", "type", "faPlayerId"] : command.type === "own.fixture_response_recorded" ? ["id", "expectedRevision", "type", "fixtureId", "response"] : ["id", "expectedRevision", "type", "trainingId", "response"];
    if (Object.keys(command).some((key) => !allowed.includes(key)))
      bad("Own-player commands cannot change another profile or manager-controlled fields.");
    const state = await this.document(teamId, seasonId, "preparation");
    const profiles = state.profiles.filter((profile2) => profile2.playerId === membership.playerId && profile2.seasonId === seasonId && profile2.active);
    if (profiles.length !== 1)
      throw new AccessError("NOT_FOUND", 404, "The requested own-player profile is unavailable.");
    const profile = profiles[0];
    if (command.type === "own.fixture_response_recorded" && !state.appliedCommands[command.id]) {
      const fixture = state.fixtures.find((item) => item.id === command.fixtureId && item.seasonId === seasonId);
      if (fixture) {
        const canonical5 = await this.one("SELECT state_json->>'status' AS status FROM matches WHERE id=$1 AND team_id=$2 AND season_id=$3", [fixture.id, teamId, seasonId]);
        const records = await this.document(teamId, seasonId, "records");
        const historical = records.results.find((item) => item.id === fixture.id && item.teamId === teamId && item.seasonId === seasonId && ["completed", "abandoned"].includes(item.status));
        const recordedStatus = canonical5 && canonical5.status !== "preparation" ? String(canonical5.status ?? "unknown") : historical?.status ?? canonical5?.status;
        if (!canPlayerReplyToFixture(fixture, this.now(), { recordedStatus })) throw new AccessError("COMMAND_REJECTED", 422, "Availability replies are closed for this game. Recorded replies and attendance are preserved.");
      }
    }
    const base = { id: command.id, expectedRevision: command.expectedRevision };
    const bound = command.type === "own.preferences_saved" ? { ...base, type: "profile.saved", profile: { ...profile, preferences: command.preferences } } : command.type === "own.fa_id_saved" ? { ...base, type: "profile.saved", profile: { ...profile, faPlayerId: command.faPlayerId } } : command.type === "own.fixture_response_recorded" ? { ...base, type: "fixture.response_recorded", fixtureId: command.fixtureId, profileId: profile.id, response: command.response } : { ...base, type: "training.response_recorded", trainingId: command.trainingId, profileId: profile.id, response: command.response };
    const updated = reducePreparation(state, bound);
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
      accounts: accounts.map((account2) => ({ id: account2.id, label: state.accounts.find((person) => person.id === account2.id)?.label ?? "Verified account", classification: account2.classification === "unclassified" ? "spectator" : account2.classification, adultVerified: !!account2.adult_verified })),
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
    if (!command || !validId3(command.id) || typeof command.type !== "string")
      bad("A typed community command with a stable identity is required.");
    if (command.type === "concern.updated" && !["under_review", "resolved"].includes(command.status))
      bad("Invalid concern status.");
    if (command.type === "concern.submitted" && (!["photo", "uploader"].includes(command.targetType) || !["privacy", "inappropriate", "other"].includes(command.category)))
      bad("Invalid concern category.");
    if (command.type === "uploader.hidden" && typeof command.hidden !== "boolean")
      bad("Choose whether to hide the uploader.");
    if (command.type === "privacy.drafted" && !["export", "delete_global_account"].includes(command.requestType))
      bad("Invalid privacy request type.");
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
      await this.execute("INSERT INTO jobs(id,business_key,kind,payload_json,due_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(business_key) DO NOTHING", [randomUUID2(), key, "award.finalise", JSON.stringify({ teamId, seasonId, matchId: match.id }), match.voteCutoffAtMs]);
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
      const active3 = grants.filter((grant) => grant.revokedAtMs === null && grant.startsAtMs <= this.now() && grant.expiresAtMs > this.now());
      const expiresAt = Math.max(...(active3.length ? active3 : grants).map((grant) => grant.expiresAtMs));
      const revokedAt = active3.length ? null : Math.max(1, this.now());
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
    const rows = await this.many("SELECT state_json,sharing_policy_json FROM matches WHERE team_id=$1 AND season_id=$2 ORDER BY id", [teamId, seasonId]);
    const community = await this.communityState(teamId, seasonId);
    const actor = await this.communityActor(principal, teamId, seasonId, viewer.actor);
    const filtered = getCommunityView(community, actor, this.now());
    return { principal, memberships: await this.memberships(), nowMs: this.now(), requestedRole: viewer.actor, state: await this.document(teamId, seasonId, "records"), preparation: await this.document(teamId, seasonId, "preparation"), acceptedMatches: rows.map((row) => ({ teamId, seasonId, match: JSON.parse(row.state_json), sharingPolicy: JSON.parse(row.sharing_policy_json) })), community: { accountId: principal.accountId, teamId, seasonId, audience: viewer.actor, playerId: viewer.playerId ?? null, revision: community.revision, view: { allowed: filtered.allowed, matches: filtered.matches, gallery: filtered.gallery } } };
  }
  async records(principal, teamId, seasonId, role) {
    return recordsServiceView(await this.recordsContext(principal, teamId, seasonId, role));
  }
  async playerStats(principal, teamId, seasonId, role) {
    if (!role || !["manager", "administrator", "player"].includes(role)) throw new AccessError("NOT_FOUND", 404, "Choose the current staff or own-player statistics context.");
    const memberships = currentMemberships(principal, await this.memberships(), this.now()).filter((member) => member.teamId === teamId && member.seasonId === seasonId);
    assertTeamRole(principal, memberships, teamId, seasonId, [role], this.now());
    if (role !== "player") assertAdultAuthority(principal, role === "administrator", this.now());
    const bindings = memberships.filter((member) => member.role === "player").map((member) => member.playerId);
    if (role === "player" && (new Set(bindings).size !== 1 || !bindings[0])) throw new AccessError("NOT_FOUND", 404, "The current own-player statistics binding is unavailable.");
    let source2;
    if (role === "administrator") {
      const row = await this.one("SELECT longball.admin_player_stats_source($1,$2) AS value", [teamId, seasonId]);
      source2 = typeof row?.value === "string" ? JSON.parse(row.value) : row?.value;
      if (!source2 || source2.teamId !== teamId || source2.seasonId !== seasonId) throw new AccessError("NOT_FOUND", 404, "The requested staff statistics are unavailable.");
      if (!source2.positions.length) source2 = { ...source2, positions: defaultPositionCatalogue() };
    } else {
      const preparation = await this.document(teamId, seasonId, "preparation");
      const rows = await this.many("SELECT state_json,sharing_policy_json FROM matches WHERE team_id=$1 AND season_id=$2 ORDER BY id", [teamId, seasonId]);
      const formation = preparation.formations.find((item) => item.format === preparation.team.defaultPitchPlaces);
      source2 = playerStatsSourceFromRecords({ state: await this.document(teamId, seasonId, "records"), acceptedMatches: rows.map((row) => ({ teamId, seasonId, match: JSON.parse(row.state_json), sharingPolicy: JSON.parse(row.sharing_policy_json) })), positions: positionCatalogueFor(preparation), formation: formation ? { id: formation.id, label: formation.name, slots: formation.slots.map((slot) => ({ id: slot.id, positionCode: slot.position, label: slot.label, x: slot.x, y: slot.y })) } : null });
    }
    const viewer = { role, teamId, seasonId, ...role === "player" ? { playerId: bindings[0] } : {} };
    const dto2 = projectPlayerStats(source2, viewer);
    assertPlayerStatsDto(dto2, viewer);
    return dto2;
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
import { createHash as createHash5, randomBytes as randomBytes3, randomUUID as randomUUID4 } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { open as open2, rename as rename2, unlink as unlink2 } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

// apps/api/src/media.ts
import { createHash as createHash4, randomBytes as randomBytes2, randomUUID as randomUUID3, timingSafeEqual } from "node:crypto";
import { execFile as execFile2, spawn } from "node:child_process";
import { promisify as promisify2 } from "node:util";
import { DatabaseSync } from "node:sqlite";

// apps/api/src/image-bytes.ts
import { createHash as createHash3 } from "node:crypto";
import { access, open, readFile as readFile2, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
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
function fail4(code, status, message) {
  throw new AccessError(code, status, message);
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
    const kind = bytes.toString("ascii", offset + 4, offset + 8);
    if (kind === "acTL") fail4("ANIMATED_IMAGE_UNSUPPORTED", 415, "Animated images are not supported.");
    offset += length + 12;
    if (kind === "IEND") break;
  }
}
async function processPrivateImage(input) {
  const original = await readFile2(input.originalPath);
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
function fail5(code, status, message) {
  throw new AccessError(code, status, message);
}
function auth(state, actor, now, upload = false) {
  if (!communityCanAccess(state, actor, now) || upload && actor.role === "spectator") fail5("NOT_FOUND", 404, "The requested media operation is unavailable.");
}
function sameToken(expectedHash, token) {
  return typeof token === "string" && token.length <= 256 && timingSafeEqual(Buffer.from(expectedHash, "hex"), Buffer.from(hash(token), "hex"));
}
var mediaInternals = { executeFile: executeFile2, hash, id: id2, fail: fail5, auth, sameToken, bounded, actualMime, rejectAnimatedPng };

// apps/api/src/postgres-security.ts
import { readFile as readFile3 } from "node:fs/promises";
async function install(database, name) {
  if (database.migrationMode !== "apply") throw new Error("Security migration requires the separate schema-owner migrator.");
  const sql = await readFile3(new URL(`../migrations/postgresql/005_${name}_security.sql`, import.meta.url), "utf8");
  await database.transaction(() => database.query(sql));
}
async function verify(database, tables) {
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
  await verify(database, ["media_uploads"]);
  const policies = await database.query("SELECT policyname FROM pg_catalog.pg_policies WHERE schemaname='longball' AND policyname=ANY($1::text[])", [["media_team_privilege_insert", "media_team_privilege_link", "documents_player_media_insert", "documents_player_media_update"]]);
  if (policies.rows.length !== 4) throw new Error("Current media contribution row security is missing. Run the separate migrator.");
};
var verifyActivationSecurity = (database) => verify(database, ["lb_activation_children", "lb_activation_issues", "lb_activation_tokens", "lb_activation_verification_requests"]);
async function installHeicMedia(database) {
  if (database.migrationMode !== "apply") throw new Error("Media migration requires the separate schema-owner migrator.");
  const sql = await readFile3(new URL("../migrations/postgresql/media_003_heic.sql", import.meta.url), "utf8");
  await database.transaction(() => database.query(sql));
}
async function installTeamPrivilegeMedia(database) {
  if (database.migrationMode !== "apply") throw new Error("Media migration requires the separate schema-owner migrator.");
  const sql = await readFile3(new URL("../migrations/postgresql/media_004_team_privileges.sql", import.meta.url), "utf8");
  await database.transaction(() => database.query(sql));
}

// apps/api/src/postgres-media.ts
var {
  hash: hash2,
  id: id3,
  auth: auth2,
  sameToken: sameToken2,
  bounded: bounded2
} = mediaInternals;
function fail6(code, status, message) {
  return mediaInternals.fail(code, status, message);
}
var PgMediaService = class _PgMediaService {
  directory;
  database;
  scanner;
  now;
  constructor(options) {
    this.directory = resolve(options.directory);
    this.database = options.database;
    this.scanner = options.scanner;
    this.now = options.now ?? Date.now;
    mkdirSync(this.directory, { recursive: true, mode: 448 });
    chmodSync(this.directory, 448);
    for (const name of ["quarantine", "derivatives"]) {
      mkdirSync(join(this.directory, name), { recursive: true, mode: 448 });
      chmodSync(join(this.directory, name), 448);
    }
  }
  static async open(options) {
    const service = new _PgMediaService(options);
    await service.initialize();
    return service;
  }
  async initialize() {
    if (this.database.migrationMode === "verify") {
      const versions = await this.database.query(
        "SELECT version FROM longball.media_schema_migrations ORDER BY version"
      );
      if (versions.rows.some((row) => row.version > 4)) throw new Error("Media schema is newer than this build.");
      if (![2, 3, 4].every((version2) => versions.rows.some((row) => row.version === version2))) throw new Error("Run the separate media migrator before starting the runtime.");
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
    const path = resolve(this.directory, key);
    if (!path.startsWith(this.directory + sep))
      fail6(
        "MEDIA_STORE_INVALID",
        503,
        "The private media object is unavailable."
      );
    return path;
  }
  async row(state, actor, uploadId, token) {
    auth2(state, actor, this.now(), true);
    if (!id3(uploadId))
      fail6("NOT_FOUND", 404, "The requested upload is unavailable.");
    const row = await this.one(
      "SELECT * FROM longball.media_uploads WHERE id=$1 AND owner_id=$2 AND team_id=$3 AND season_id=$4",
      [uploadId, actor.accountId, actor.teamId, actor.seasonId]
    );
    if (!row || token !== void 0 && !sameToken2(row.token_hash, token))
      fail6("NOT_FOUND", 404, "The requested upload is unavailable.");
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
      if (!input || typeof input !== "object" || Object.keys(input).some((key) => !allowedKeys.includes(key)) || !id3(input.requestId) || !id3(input.matchId) || !Number.isSafeInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > MEDIA_LIMITS.maxBytes || !["image/jpeg", "image/png", "image/heic"].includes(input.mimeType) || typeof input.sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(input.sha256) || typeof input.caption !== "string" || input.caption.trim().length > 160 || input.policyAcknowledged !== true) {
        fail6(
          "INVALID_MEDIA_PREPARATION",
          422,
          "Use an original JPEG, PNG or supported still HEIC up to 15 MiB with a valid size, SHA-256 and policy acknowledgement."
        );
      }
      const match = state.matches.find(
        (item) => item.id === input.matchId && item.teamId === actor.teamId && item.seasonId === actor.seasonId
      );
      if (!match) fail6("NOT_FOUND", 404, "The requested match is unavailable.");
      const signature2 = hash2(
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
      const token = randomBytes3(32).toString("base64url");
      if (existing) {
        if (existing.request_signature !== signature2 || existing.team_id !== actor.teamId || existing.season_id !== actor.seasonId)
          fail6(
            "IDEMPOTENCY_CONFLICT",
            409,
            "This upload request identity was already used for different content."
          );
        if (existing.expires_at <= this.now() && ["prepared", "uploading"].includes(existing.status))
          fail6(
            "UPLOAD_EXPIRED",
            410,
            "The upload window expired. Prepare a new upload without discarding the previous private record."
          );
        await this.execute(
          "UPDATE longball.media_uploads SET token_hash=$1 WHERE id=$2",
          [hash2(token), existing.id]
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
      let photoId = `media-${randomUUID4()}`;
      if (input.photoId !== void 0 || input.sourceRevision !== void 0) {
        const photo = state.photos.find(
          (item) => item.id === input.photoId && item.matchId === match.id && item.teamId === actor.teamId && item.seasonId === actor.seasonId && item.uploaderAccountId === actor.accountId && item.uploaderRole === actor.role && item.removedAtMs === null
        );
        if (!photo || !Number.isSafeInteger(input.sourceRevision) || photo.currentRevision !== input.sourceRevision)
          fail6(
            "MEDIA_REVISION_CONFLICT",
            409,
            "The photo changed. Review its current revision before replacing it."
          );
        sourceRevision = photo.currentRevision;
        photoId = photo.id;
      }
      const uploadId = randomUUID4();
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
          hash2(token),
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
      fail6("UPLOAD_EXPIRED", 410, "The write-only upload window expired.");
    if (!duplicate && row.status !== "prepared" && !(row.status === "uploading" && (row.lease_until ?? 0) < this.now()))
      fail6(
        "UPLOAD_BUSY",
        409,
        "This upload is already running or cannot be changed."
      );
    const attempt = randomUUID4();
    const key = `quarantine/${row.id}-${attempt}.upload`;
    const temporary = this.path(key + ".part");
    if (!duplicate) {
      const updated = await this.execute(
        "UPDATE longball.media_uploads SET status='uploading',attempt=$1,lease_until=$2,failure_code=NULL WHERE id=$3 AND (status='prepared' OR (status='uploading' AND lease_until<$4))",
        [attempt, this.now() + 65e3, row.id, this.now()]
      );
      if (!updated.changes)
        fail6("UPLOAD_BUSY", 409, "This upload is already running.");
    }
    const destination = duplicate ? null : await open2(temporary, "wx", 384);
    const digest2 = createHash5("sha256");
    let received = 0;
    const began = performance.now();
    const iterator = source2[Symbol.asyncIterator]();
    try {
      while (true) {
        const item = await bounded2(
          iterator.next(),
          MEDIA_LIMITS.uploadTimeoutMs - (performance.now() - began),
          "UPLOAD_TIMEOUT"
        );
        if (item.done) break;
        const chunk = Buffer.from(item.value);
        received += chunk.length;
        if (received > row.expected_bytes || received > MEDIA_LIMITS.maxBytes)
          fail6(
            "UPLOAD_TOO_LARGE",
            413,
            "The image exceeds its declared upload size."
          );
        digest2.update(chunk);
        if (destination) await destination.writeFile(chunk);
      }
      if (received !== row.expected_bytes || digest2.digest("hex") !== row.expected_sha)
        fail6(
          "UPLOAD_INTEGRITY_FAILED",
          422,
          "The uploaded size or SHA-256 does not match. The private partial upload was not accepted."
        );
      if (destination) {
        await destination.sync();
        await destination.close();
        await rename2(temporary, this.path(key));
        const changed = await this.execute(
          "UPDATE longball.media_uploads SET status='uploaded',original_key=$1,lease_until=NULL,failure_code=NULL WHERE id=$2 AND attempt=$3 AND status='uploading'",
          [key, row.id, attempt]
        );
        if (!changed.changes)
          fail6(
            "UPLOAD_LEASE_CHANGED",
            409,
            "The upload lease changed. The private branch is retained for review."
          );
      }
      return { uploadId, status: "uploaded", byteSize: received };
    } catch (error) {
      if (destination) {
        await destination.close().catch(() => void 0);
        await unlink2(temporary).catch(() => void 0);
      }
      if (!duplicate)
        await this.execute(
          "UPDATE longball.media_uploads SET status='prepared',failure_code='UPLOAD_INCOMPLETE',lease_until=NULL WHERE id=$1 AND attempt=$2 AND status='uploading'",
          [row.id, attempt]
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
      fail6(
        "UPLOAD_NOT_READY",
        409,
        "Finish the private upload before completion; an active processing lease cannot be duplicated."
      );
    if (!row.original_key)
      fail6("UPLOAD_NOT_READY", 409, "The private original is unavailable.");
    const attempt = randomUUID4();
    const leased = await this.execute(
      "UPDATE longball.media_uploads SET status='processing',attempt=$1,lease_until=$2,failure_code=NULL WHERE id=$3 AND (status='uploaded' OR (status='processing' AND lease_until<$4))",
      [attempt, this.now() + 6e4, row.id, this.now()]
    );
    if (!leased.changes)
      fail6("UPLOAD_BUSY", 409, "This image is already processing.");
    try {
      const displayKey = `derivatives/${row.photo_id}-v${row.display_revision}-${attempt}-display.jpg`;
      const thumbnailKey = `derivatives/${row.photo_id}-v${row.display_revision}-${attempt}-thumbnail.jpg`;
      const decoded = await processPrivateImage({ originalPath: this.path(row.original_key), displayPath: this.path(displayKey), thumbnailPath: this.path(thumbnailKey), expectedBytes: row.expected_bytes, expectedSha: row.expected_sha, declaredMime: row.declared_mime, scanner: this.scanner });
      const saved2 = await this.execute(
        "UPDATE longball.media_uploads SET status='processed',display_key=$1,thumbnail_key=$2,width=$3,height=$4,scanner_engine=$5,failure_code=NULL,lease_until=NULL WHERE id=$6 AND attempt=$7 AND status='processing'",
        [
          displayKey,
          thumbnailKey,
          decoded.width,
          decoded.height,
          decoded.scannerEngine,
          row.id,
          attempt
        ]
      );
      if (!saved2.changes)
        fail6(
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
        [retryable ? "uploaded" : "rejected", code, row.id, attempt]
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
      fail6(
        "MEDIA_NOT_PROCESSED",
        409,
        "The image has not completed private processing."
      );
    if (state && !state.photos.some(
      (photo) => photo.id === row.photo_id && photo.teamId === row.team_id && photo.seasonId === row.season_id && photo.uploaderAccountId === row.owner_id && photo.revisions.some(
        (revision) => revision.version === row.display_revision
      )
    ))
      fail6(
        "MEDIA_LINK_CONFLICT",
        409,
        "The matching community revision was not committed."
      );
    const linked = await this.execute(
      "UPDATE longball.media_uploads SET status='linked' WHERE id=$1",
      [uploadId]
    );
    if (linked.changes !== 1) fail6("MEDIA_LINK_CONFLICT", 409, "The private processing authority changed. No community revision was committed.");
  }
  async gateway(state, actor, photoId, variant, mode = "gallery", revision) {
    if (!["display", "thumbnail"].includes(variant))
      fail6("NOT_FOUND", 404, "The media variant is unavailable.");
    const decision = authorizeCommunityMedia(
      state,
      actor,
      photoId,
      this.now(),
      mode,
      revision
    );
    if (!decision.allowed)
      fail6("NOT_FOUND", 404, "The requested image is unavailable.");
    const row = await this.one(
      "SELECT * FROM longball.media_uploads WHERE photo_id=$1 AND display_revision=$2 AND status='linked'",
      [photoId, decision.revision.version]
    );
    if (!row || row.team_id !== actor.teamId || row.season_id !== actor.seasonId)
      fail6("NOT_FOUND", 404, "The requested image is unavailable.");
    const key = variant === "display" ? row.display_key : row.thumbnail_key;
    if (!key) fail6("NOT_FOUND", 404, "The requested image is unavailable.");
    let body;
    try {
      body = readFileSync(this.path(key));
    } catch {
      fail6("NOT_FOUND", 404, "The requested image is unavailable.");
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
import { createHash as createHash6, randomBytes as randomBytes4, randomUUID as randomUUID5 } from "node:crypto";

// packages/application/src/identity-policy.ts
var DEFAULT_SIGN_IN_RULES = {
  username: { minLength: 3, maxLength: 40, allowNumbers: true, allowSeparators: true },
  password: { minLength: 12, requireUppercase: true, requireLowercase: true, requireNumber: true, requireSymbol: true, disallowUsername: true },
  spectatorPin: { blockSimpleCodes: true }
};
var object4 = (value) => !!value && typeof value === "object" && !Array.isArray(value);
function exact(value, fields5) {
  return object4(value) && Object.keys(value).length === fields5.length && fields5.every((key) => Object.hasOwn(value, key));
}
function bad2() {
  throw new AccessError("INVALID_SIGN_IN_RULES", 400, "Use the documented sign-in rules and supported lengths.");
}
function parseSignInRules(value) {
  if (!exact(value, ["username", "password", "spectatorPin"]) || !exact(value.username, ["minLength", "maxLength", "allowNumbers", "allowSeparators"]) || !exact(value.password, ["minLength", "requireUppercase", "requireLowercase", "requireNumber", "requireSymbol", "disallowUsername"]) || !exact(value.spectatorPin, ["blockSimpleCodes"])) bad2();
  const u = value.username, p = value.password, pin = value.spectatorPin;
  if (!Number.isInteger(u.minLength) || Number(u.minLength) < 3 || Number(u.minLength) > 32 || !Number.isInteger(u.maxLength) || Number(u.maxLength) < Math.max(8, Number(u.minLength)) || Number(u.maxLength) > 40 || !Number.isInteger(p.minLength) || Number(p.minLength) < 8 || Number(p.minLength) > 64 || typeof u.allowNumbers !== "boolean" || typeof u.allowSeparators !== "boolean" || [p.requireUppercase, p.requireLowercase, p.requireNumber, p.requireSymbol, p.disallowUsername, pin.blockSimpleCodes].some((v) => typeof v !== "boolean")) bad2();
  return { username: { minLength: Number(u.minLength), maxLength: Number(u.maxLength), allowNumbers: u.allowNumbers, allowSeparators: u.allowSeparators }, password: { minLength: Number(p.minLength), requireUppercase: p.requireUppercase, requireLowercase: p.requireLowercase, requireNumber: p.requireNumber, requireSymbol: p.requireSymbol, disallowUsername: p.disallowUsername }, spectatorPin: { blockSimpleCodes: pin.blockSimpleCodes } };
}
function usernameProblem(value, rules = DEFAULT_SIGN_IN_RULES) {
  const username = value.trim();
  if (username.length < rules.username.minLength || username.length > rules.username.maxLength) return `Use a username of ${rules.username.minLength}\u2013${rules.username.maxLength} characters.`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(username)) return "Use letters, numbers, dots, underscores or dashes, starting with a letter or number.";
  if (!rules.username.allowNumbers && /\d/.test(username)) return "Use a username without numbers.";
  if (!rules.username.allowSeparators && /[._-]/.test(username)) return "Use a username without dots, underscores or dashes.";
  return null;
}
var letters = (value) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]/g, "");
function suggestInitialUsername(teamName, fullName, existingUsernames = [], rules = DEFAULT_SIGN_IN_RULES) {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const component = (value) => {
    const text2 = letters(value);
    return rules.username.allowNumbers ? text2 : text2.replace(/\d/g, "");
  };
  const team = component(teamName.replace(/\s+U(?:[5-9]|1\d|2[01])\b.*$/i, "")) || "Team";
  const first = component(parts[0] ?? "Player") || "Player";
  const initial2 = parts.length > 1 ? component(parts.at(-1)).slice(0, 1).toUpperCase() : "";
  let base = `${team}${rules.username.allowSeparators ? "." : ""}${first}${initial2}`;
  if (!rules.username.allowNumbers) base = base.replace(/\d/g, "");
  base = base.padEnd(rules.username.minLength, "x").slice(0, rules.username.maxLength);
  const used = new Set(existingUsernames.map((v) => v.trim().toLowerCase()));
  for (let n = 1; n <= 1e4; n++) {
    let suffix = n === 1 ? "" : String(n);
    if (!rules.username.allowNumbers && suffix) {
      suffix = "";
      let index = n - 1;
      do {
        suffix = String.fromCharCode(97 + index % 26) + suffix;
        index = Math.floor(index / 26) - 1;
      } while (index >= 0);
    }
    const candidate = `${base.slice(0, rules.username.maxLength - suffix.length)}${suffix}`;
    if (!used.has(candidate.toLowerCase()) && !usernameProblem(candidate, rules)) return candidate;
  }
  throw new Error("Choose another username; this name has too many duplicates.");
}

// apps/api/src/sign-in-rules.ts
var pg = (source2) => "db" in source2;
var ddl = `CREATE TABLE IF NOT EXISTS application_sign_in_rules(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL,rules_json TEXT NOT NULL,provider_revision INTEGER);`;
async function saved(source2) {
  let row;
  if (pg(source2)) {
    const result = await source2.one(source2.db.migrationMode === "apply" ? "SELECT jsonb_build_object('revision',revision,'rules_json',rules_json,'provider_revision',provider_revision) AS value FROM application_sign_in_rules WHERE singleton=1" : "SELECT longball.sign_in_rules_read() AS value");
    if (!result?.value) throw new AccessError("SIGN_IN_RULES_UNAVAILABLE", 503, "Sign-in rules are unavailable. Try again shortly.");
    row = typeof result.value === "string" ? JSON.parse(result.value) : result.value;
  } else {
    source2.database.exec(ddl);
    source2.database.prepare("INSERT INTO application_sign_in_rules(singleton,revision,rules_json) VALUES(1,0,?) ON CONFLICT DO NOTHING").run(JSON.stringify(DEFAULT_SIGN_IN_RULES));
    row = source2.database.prepare("SELECT revision,rules_json,provider_revision FROM application_sign_in_rules WHERE singleton=1").get();
  }
  return { revision: Number(row.revision), rules: parseSignInRules(typeof row.rules_json === "string" ? JSON.parse(row.rules_json) : row.rules_json), providerRevision: row.provider_revision === null ? null : Number(row.provider_revision) };
}
function dto(value, providerConfigured = false) {
  const status = !providerConfigured ? "not_configured" : value.providerRevision === value.revision ? "applied" : "pending";
  return { kind: "sign-in-rules", revision: value.revision, rules: value.rules, provider: { status, detail: status === "applied" ? "Rules apply to newly chosen provider credentials and new usernames. Existing sign-ins stay valid." : status === "not_configured" ? "Demo sign-ins keep their existing credentials. New spectator usernames and passcodes use these rules; the password provider is not connected." : "The password provider has not yet confirmed this rule revision. Save the rules to apply them before enabling new provider accounts." } };
}
async function ensureProviderSignInRules(source2, provider) {
  const current3 = await saved(source2);
  if (!provider) return dto(current3);
  const adapter = provider;
  if (!adapter.applySignInRules) throw new AccessError("SIGN_IN_RULES_PROVIDER_UNAVAILABLE", 503, "The identity provider cannot enforce the current sign-in rules.");
  try {
    const confirmation = await adapter.applySignInRules({ revision: current3.revision, rules: current3.rules });
    if (confirmation.revision !== current3.revision || confirmation.enforced !== true) throw new Error("unconfirmed");
    if (pg(source2) && source2.db.migrationMode === "apply") {
      const result = await source2.one("UPDATE application_sign_in_rules SET provider_revision=$1 WHERE singleton=1 AND revision=$1 RETURNING true AS confirmed", [current3.revision]);
      if (result?.confirmed !== true) throw new Error("changed");
    } else if (pg(source2)) {
      const result = await source2.one("SELECT longball.sign_in_rules_provider_confirm($1) AS confirmed", [current3.revision]);
      if (result?.confirmed !== true) throw new Error("changed");
    } else {
      const result = source2.database.prepare("UPDATE application_sign_in_rules SET provider_revision=? WHERE singleton=1 AND revision=?").run(current3.revision, current3.revision);
      if (!result.changes) throw new Error("changed");
    }
    return dto({ ...current3, providerRevision: current3.revision }, true);
  } catch {
    throw new AccessError("SIGN_IN_RULES_PROVIDER_UNAVAILABLE", 503, "The identity provider did not confirm the current sign-in rules. Retry before creating credentials.");
  }
}

// apps/api/src/username-registry.ts
function isUsernameCollision(error) {
  if (!error || typeof error !== "object") return false;
  const value = error;
  return value.code === "23505" && value.constraint === "global_username" || value.code === "ERR_SQLITE_ERROR" && /GLOBAL_USERNAME_CONFLICT/.test(value.message ?? "");
}
function usernameAllocationUnavailable() {
  throw new AccessError(
    "IDENTITY_ALLOCATION_UNAVAILABLE",
    503,
    "A unique username could not be allocated. Try a different name."
  );
}
async function installPostgresChildUsernameRegistry(source2) {
  if (source2.db.migrationMode !== "apply") return;
  await source2.execute("SELECT install_child_username_registry()");
}

// apps/api/src/postgres-activation.ts
var hash3 = (value) => createHash6("sha256").update(value).digest("hex");
var id4 = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(value);
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
function fields4(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !names.includes(key)) || names.some((key) => !(key in value)))
    invalid3();
}
function fingerprint(actor, input) {
  return hash3(
    JSON.stringify([
      actor,
      ...Object.entries(input).sort(
        ([left], [right]) => left.localeCompare(right)
      )
    ])
  );
}
var PostgresActivationService = class {
  async ownsActivationToken(token, activationId) {
    await this.ready;
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    return this.store.db.withContext({ kind: "activation_token", tokenHash: hash3(token), ...activationId ? { activationId } : {}, nowMs: this.store.now() }, async () => Boolean(await this.store.one("SELECT id FROM lb_activation_tokens WHERE token_hash=$1 AND ($2::text IS NULL OR id=$2)", [hash3(token), activationId ?? null])));
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
  constructor(options) {
    this.store = options.store;
    this.provider = options.provider;
    this.policy = options.policy;
    if (options.policy && (options.policy.fictionalOnly !== true || !id4(options.policy.version) || !Number.isSafeInteger(options.policy.activationTtlMs) || options.policy.activationTtlMs <= 0))
      throw new Error(
        "An explicit versioned test activation policy and positive expiry are required."
      );
    if (options.provider) {
      const issuer = new URL(options.provider.issuer);
      if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash || !options.provider.credentialSetupOrigins.length)
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
      const version2 = await this.store.one(
        "SELECT version FROM lb_activation_schema WHERE singleton=1"
      );
      if (!version2 || version2.version !== 2)
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
      const version2 = await this.store.one(
        "SELECT version FROM lb_activation_schema WHERE singleton=1",
        []
      );
      if (version2 && ![1, 2].includes(version2.version))
        throw new Error(
          "Unsupported activation feature schema; preserve the database."
        );
      if (version2?.version === 2) {
        await verifyActivationSecurity(this.store.db);
        await installPostgresChildUsernameRegistry(this.store);
        return;
      }
      if (!version2)
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
      await installPostgresChildUsernameRegistry(this.store);
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
    fields4(input, ["requestId", "teamId", "seasonId", "playerId"]);
    if (![input.requestId, input.teamId, input.seasonId, input.playerId].every(id4))
      invalid3();
    const signature2 = fingerprint(principal.accountId, input);
    const signInRules = await ensureProviderSignInRules(this.store, provider);
    const candidateAccountId = randomUUID5();
    const row = await this.withProvisionedAccount(
      candidateAccountId,
      () => this.store.transaction(async () => {
        await this.manager(principal, input.teamId, input.seasonId);
        const existing = await this.store.one(
          "SELECT * FROM lb_activation_children WHERE request_id=$1",
          [input.requestId]
        );
        if (existing) {
          if (existing.request_signature !== signature2) conflict();
          return existing;
        }
        const preparation = await this.store.preparation(principal, input.teamId, input.seasonId);
        const profile = preparation.profiles.find(
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
        const collisions = [];
        while (true) {
          const chosen = suggestInitialUsername(preparation.team.name, profile.displayName, collisions, signInRules.rules);
          await this.store.execute("SAVEPOINT username_candidate");
          try {
            await this.store.execute(
              "INSERT INTO lb_activation_children(account_id,username,team_id,season_id,player_id,request_id,request_signature,state,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'provisioning',$8,$9)",
              [accountId, chosen, input.teamId, input.seasonId, input.playerId, input.requestId, signature2, principal.accountId, this.store.now()]
            );
            await this.store.execute("RELEASE SAVEPOINT username_candidate");
            break;
          } catch (error) {
            await this.store.execute("ROLLBACK TO SAVEPOINT username_candidate");
            await this.store.execute("RELEASE SAVEPOINT username_candidate");
            if (!isUsernameCollision(error)) throw error;
            collisions.push(chosen);
            if (collisions.length >= 100) usernameAllocationUnavailable();
          }
        }
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
    fields4(input, ["requestId", "teamId", "seasonId", "accountId"]);
    if (![input.requestId, input.teamId, input.seasonId].every(id4) || !uuid(input.accountId))
      invalid3();
    const signature2 = fingerprint(principal.accountId, input);
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
      if (issue && issue.signature !== signature2) conflict();
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
      const token = randomBytes4(32).toString("base64url");
      const activationId = randomUUID5();
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
          hash3(token),
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
    fields4(input, ["token", "requestId"]);
    if (typeof input.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.token) || !id4(input.requestId))
      unavailable();
    return this.store.db.withContext(
      {
        kind: "activation_token",
        tokenHash: hash3(input.token),
        nowMs: this.store.now()
      },
      () => this.redeemWithCapability(input)
    );
  }
  async redeemWithCapability(input) {
    await this.ready;
    const { provider } = await this.enabled();
    fields4(input, ["token", "requestId"]);
    if (typeof input.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.token) || !id4(input.requestId))
      unavailable();
    const reserved = await this.store.transaction(async () => {
      const token = await this.store.one(
        "SELECT * FROM lb_activation_tokens WHERE token_hash=$1",
        [hash3(input.token)]
      );
      if (!token || token.expires_at <= this.store.now() || token.state === "revoked" || token.state === "completed" || token.state === "redeeming" && token.redemption_id !== input.requestId)
        unavailable();
      const child = await this.store.one(
        "SELECT * FROM lb_activation_children WHERE account_id=$1",
        [token.account_id]
      );
      if (child.state !== "pending_activation" || !child.provider_issuer || !child.provider_subject)
        unavailable();
      await this.store.execute(
        "UPDATE lb_activation_tokens SET state='redeeming',redemption_id=$1 WHERE id=$2",
        [input.requestId, token.id]
      );
      return { token, child };
    });
    await ensureProviderSignInRules(this.store, provider);
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
    if (setup.protocol !== "https:" || setup.username || setup.password || !provider.credentialSetupOrigins.includes(setup.origin) || result.setupUrl.includes(input.token) || !id4(result.flowId) || !Number.isSafeInteger(result.expiresAt) || result.expiresAt > reserved.token.expires_at || result.expiresAt <= this.store.now())
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
        unavailable();
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
    fields4(input, ["activationId", "token", "completionProof"]);
    if (!uuid(input.activationId) || typeof input.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.token) || typeof input.completionProof !== "string" || !input.completionProof || input.completionProof.length > 16384)
      unavailable();
    return this.store.db.withContext(
      {
        kind: "activation_token",
        tokenHash: hash3(input.token),
        activationId: input.activationId,
        nowMs: this.store.now()
      },
      () => this.completeWithCapability(input)
    );
  }
  async completeWithCapability(input) {
    await this.ready;
    const { provider } = await this.enabled();
    fields4(input, ["activationId", "token", "completionProof"]);
    if (!uuid(input.activationId) || typeof input.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.token) || typeof input.completionProof !== "string" || !input.completionProof || input.completionProof.length > 16384)
      unavailable();
    const token = await this.store.one(
      "SELECT * FROM lb_activation_tokens WHERE id=$1 AND token_hash=$2",
      [input.activationId, hash3(input.token)]
    );
    if (!token || !["redeeming", "completed"].includes(token.state) || !token.flow_id || !token.flow_expires_at || token.flow_expires_at <= this.store.now())
      unavailable();
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
      unavailable();
    return await this.store.db.withContext(
      {
        kind: "activation_token",
        tokenHash: hash3(input.token),
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
            unavailable();
          const account2 = await this.store.one(
            "SELECT classification,status FROM accounts WHERE id=$1",
            [child.account_id]
          );
          if (account2.classification !== "child_shared") unavailable();
          if (fresh.state === "completed") {
            if (account2.status !== "active") unavailable();
            return { status: "complete", signInRequired: true };
          }
          if (account2.status !== "disabled") unavailable();
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
              randomUUID5(),
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
    fields4(input, [
      "requestId",
      "teamId",
      "seasonId",
      "playerId",
      "existingAccountId"
    ]);
    if (!id4(input.playerId) || !uuid(input.existingAccountId)) invalid3();
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
    fields4(input, ["requestId", "teamId", "seasonId", "accountId"]);
    if (!uuid(input.accountId)) invalid3();
    return await this.verificationRequest(
      principal,
      "recovery",
      input,
      input.accountId,
      null
    );
  }
  async verificationRequest(principal, kind, input, target, playerId) {
    const { policy } = await this.enabled();
    if (![input.requestId, input.teamId, input.seasonId].every(id4)) invalid3();
    const signature2 = fingerprint(principal.accountId, { ...input, kind });
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
      if (previous && previous.signature !== signature2) conflict();
      if (!previous) {
        await this.store.execute(
          "INSERT INTO lb_activation_verification_requests(request_id,kind,actor_id,team_id,season_id,player_id,target_account_id,signature,status,policy_version,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [
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
          ]
        );
        await this.store.audit(
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

// apps/api/src/database-config.ts
import { readFileSync as readFileSync2 } from "node:fs";
function readDatabaseUrl(env, key = "LONGBALL_DATABASE_URL") {
  const inline = env[key];
  const file = env[`${key}_FILE`];
  if (inline && file) throw new Error(`Configure exactly one of ${key} and ${key}_FILE.`);
  const value = file ? readFileSync2(file, "utf8").trim() : inline;
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

// apps/api/src/runtime-grants.ts
async function applyRuntimeGrants(database, roles = { apiRole: "longball_api", workerRole: "longball_worker" }) {
  const identifier3 = (name) => {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error("Invalid runtime database role name.");
    return `"${name}"`;
  };
  const api = identifier3(roles.apiRole), worker = identifier3(roles.workerRole);
  await database.transaction(async () => {
    await database.query("INSERT INTO longball.runtime_roles(role_name,purpose) VALUES($1,'api'),($2,'worker') ON CONFLICT(role_name) DO UPDATE SET purpose=EXCLUDED.purpose", [roles.apiRole, roles.workerRole]);
    await database.query("REVOKE ALL ON SCHEMA longball FROM PUBLIC");
    await database.query(`GRANT USAGE ON SCHEMA longball TO ${api},${worker}`);
    await database.query(`REVOKE ALL ON ALL TABLES IN SCHEMA longball FROM ${api},${worker}`);
    await database.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA longball FROM PUBLIC,${api},${worker}`);
    const apiTables = ["clubs", "teams", "team_seasons", "game_contexts", "accounts", "memberships", "matches", "documents", "devices", "controller_grants", "controller_history", "events", "streams", "conflicting_submissions", "transfers", "clock_challenges", "clock_mappings", "reconciliation_proposals", "audit", "idempotency", "privacy_requests", "privacy_pending_keys", "jobs", "media_uploads", "lb_activation_children", "lb_activation_issues", "lb_activation_tokens", "lb_activation_verification_requests", "brand_assets", "brand_slots", "spectator_invitations", "lb_spectator_activation_accounts", "lb_spectator_activation_attempts", "native_app_devices", "team_privilege_states", "team_privilege_decisions", "push_registrations", "report_exports", "match_feedback", "team_documents", "opposition_reviews"];
    await database.query(`GRANT SELECT,INSERT,UPDATE ON ${apiTables.map((table) => `longball.${table}`).join(",")} TO ${api}`);
    await database.query(`GRANT SELECT,INSERT ON longball.match_feedback_receipts TO ${api}`);
    await database.query(`GRANT SELECT ON longball.administrative_memberships TO ${api},${worker}`);
    await database.query(`GRANT SELECT,INSERT ON longball.opposition_review_receipts TO ${api}`);
    await database.query(`GRANT SELECT,UPDATE ON longball.invite_requests TO ${api}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.sign_in_rules_read(),longball.sign_in_rules_provider_confirm(bigint),longball.sign_in_rules_lock(),longball.sign_in_rules_save(bigint,jsonb,bigint),longball.claim_configured_demo_username(text,text) TO ${api}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.login_reporting_initialize(bigint),longball.login_activity_write(jsonb),longball.login_analytics_snapshot(bigint,bigint,bigint,bigint),longball.login_analytics_enabled_accounts(text,text,text) TO ${api}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.team_document_staff(text,text),longball.opposition_completed_games(text,text),longball.spectator_pin_preview(text,bigint),longball.spectator_pin_register(text,text,text,text,text,text,bigint),longball.spectator_pin_credential(text),longball.spectator_pin_login_attempt(text,boolean,bigint),longball.spectator_invite_directory(),longball.spectator_connection_catalog(text,text),longball.spectator_invite_request(text,text,text,text,text,text,text,bigint) TO ${api}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.feedback_player(text,text,text,text,text),longball.feedback_reader(text,text,text,text,text) TO ${api}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.scheduled_games(text,text),longball.manage_scheduled_game(text,text,jsonb),longball.admin_player_stats_source(text,text),longball.team_overview_source(text,text) TO ${api}`);
    await database.query(`GRANT SELECT ON longball.schema_migrations,longball.media_schema_migrations,longball.lb_activation_schema TO ${api},${worker}`);
    await database.query(`REVOKE UPDATE ON longball.events,longball.audit,longball.controller_history,longball.reconciliation_proposals,longball.clock_mappings,longball.team_privilege_decisions FROM ${api}`);
    await database.query(`GRANT SELECT ON longball.clubs,longball.teams,longball.team_seasons,longball.game_contexts,longball.accounts,longball.memberships,longball.matches TO ${worker}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.administration_scope(text) TO ${worker}`);
    await database.query(`GRANT SELECT,INSERT,UPDATE ON longball.jobs,longball.documents TO ${worker}`);
    await database.query(`GRANT SELECT,UPDATE ON longball.report_exports TO ${worker}`);
    const helpers = ["runtime_purpose()", "context_json()", "context_now()", "actor_valid()", "context_matches(text,text,text)", "actor_role(text,text,text)", "actor_admin(text,text,text)", "actor_manager(text,text,text)", "inherited_admin_manager(text,text,text)", "invite_capability(text,text,text)", "worker_job_valid(text,text,text)", "worker_kind()", "worker_account(text,text,text,text)", "spectator_grant_active(text,text,text,text)", "activation_account(text,boolean)", "spectator_activation_account(text,boolean)", "invitation_live(text,text)", "account_visible(text)", "document_write(text,text,text,text)", "worker_match(text,text,text,text)", "report_export_actor(text,text,text,text,text,text)", "report_export_worker(text,text,text,text,text)"];
    await database.query(`GRANT EXECUTE ON FUNCTION ${helpers.map((name) => `longball.${name}`).join(",")} TO ${api},${worker}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.media_completion_write(text,text,text,text) TO ${api},${worker}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.media_gallery_allowed(text,integer,text,text,text,text,text) TO ${api}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.branding_member(text,text),longball.branding_authority(text,text,text),longball.branding_context(text,text) TO ${api}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.team_privilege_manager(text,text),longball.team_privilege_target(text,text,text),longball.team_privilege_allowed(text,text,text,boolean) TO ${api}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.invitation_live(text,text),longball.invitation_preflight(text),longball.invitation_accept_scope(text),longball.spectator_activation_account(text,boolean) TO ${api}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.invitation_preview_context(text) TO ${api}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.workspace_membership_names() TO ${api}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.inherited_admin_manager(text,text,text),longball.sync_club_configuration(text,text),longball.inherit_administration_for_season(text,text),longball.administration_scope(text),longball.administration_directory(),longball.administration_command(jsonb,text,jsonb),longball.club_report(text) TO ${api}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.report_export_source(text,text) TO ${api}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.report_export_current(text) TO ${api},${worker}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.purge_report_exports() TO ${worker}`);
    await database.query(`GRANT EXECUTE ON FUNCTION longball.claim_due_job(text,bigint,text),longball.enqueue_award_notification(text,text,jsonb,bigint),longball.push_targets_for_current_job(text) TO ${worker}`);
  });
}

// apps/api/src/migrate.ts
var connectionString = readDatabaseUrl(process.env, "LONGBALL_MIGRATION_DATABASE_URL");
if (!connectionString) throw new Error("Configure the dedicated LONGBALL_MIGRATION_DATABASE_URL or mounted URL secret.");
if (process.env.LONGBALL_DATABASE_URL || process.env.LONGBALL_DATABASE_URL_FILE) throw new Error("The migrator must not receive runtime database credentials.");
var store = await PostgresStore.open(connectionString, Date.now, { migrationMode: "apply" });
try {
  await PgMediaService.open({ directory: process.env.LONGBALL_MEDIA_DIRECTORY ?? "/data/media", database: store.db });
  await new PostgresActivationService({ store }).initialize();
  await applyRuntimeGrants(store.db);
  console.log("LongBall PostgreSQL schema and restricted runtime grants are ready. No production policy approvals were created.");
} finally {
  await store.close();
}
