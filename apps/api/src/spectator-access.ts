import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { AccessError } from "../../../packages/application/src/access";
import {
  normalizedSpectatorUsername,
  spectatorPinProblem,
  type InviteDirectoryTeam,
  type InviteRequest,
  type InviteRequestInput,
} from "../../../packages/application/src/spectator-pin";
import type { InvitationContext } from "../../../packages/application/src/invitation-context";
import { invitationVerifier } from "./invitation-service";
import type { VerifiedIdentity } from "./oidc";

export interface SpectatorAccessPreview {
  invitationId: string;
  clubId: string;
  teamId: string;
  seasonId: string;
  expiresAt: string;
  context: InvitationContext;
}
export interface SpectatorCredential {
  accountId: string;
  salt: string;
  verifier: string;
  lockedUntil: number;
}
export interface SpectatorAccessRepository {
  preview(tokenHash: string, now: number): Promise<SpectatorAccessPreview>;
  register(input: {
    tokenHash: string;
    username: string;
    salt: string;
    verifier: string;
    accountId: string;
    requestId: string;
    now: number;
  }): Promise<{ accountId: string }>;
  credential(username: string): Promise<SpectatorCredential | null>;
  loginAttempt(username: string, success: boolean, now: number): Promise<void>;
  directory(): Promise<InviteDirectoryTeam[]>;
  connections(
    principal: import("../../../packages/application/src/access").Principal,
    teamId: string,
    seasonId: string,
    role?: string,
  ): Promise<{
    players: { id: string; label: string }[];
    followedPlayerId: string | null;
  }>;
  follow(
    principal: import("../../../packages/application/src/access").Principal,
    teamId: string,
    seasonId: string,
    role: string | undefined,
    playerId: string | null,
    requestId: string,
  ): Promise<{
    players: { id: string; label: string }[];
    followedPlayerId: string | null;
  }>;
  request(
    input: InviteRequestInput,
    now: number,
  ): Promise<{ requestId: string; status: "pending" }>;
  requests(
    principal: import("../../../packages/application/src/access").Principal,
    teamId: string,
    seasonId: string,
    role?: string,
  ): Promise<InviteRequest[]>;
  decide(
    principal: import("../../../packages/application/src/access").Principal,
    teamId: string,
    seasonId: string,
    role: string | undefined,
    requestId: string,
    status: "handled" | "declined",
  ): Promise<void>;
}
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const exact = (value: Record<string, unknown>, fields: string[]) =>
  Object.keys(value).length === fields.length &&
  fields.every((field) => Object.hasOwn(value, field));
const opaque = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(value);
function bad(message: string): never {
  throw new AccessError("INVALID_REQUEST", 400, message);
}
function denied(): never {
  throw new AccessError(
    "INVALID_SPECTATOR_CREDENTIALS",
    401,
    "The username or passcode was not recognised.",
  );
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const derive = async (pin: string, salt: string): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    scrypt(
      pin,
      Buffer.from(salt, "base64url"),
      32,
      { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
export interface SpectatorAccessSession {
  accountId: string;
  accessToken: string;
  expiresAt: string;
  role: "spectator";
}

/** A deliberately separate identity class: PIN accounts can only receive spectator grants. */
export class SpectatorAccessService {
  private readonly sessions = new Map<
    string,
    { accountId: string; issuedAt: number; expiresAt: number }
  >();
  private readonly attempts = new Map<
    string,
    { start: number; count: number }
  >();
  private readonly dummySalt = randomBytes(16).toString("base64url");
  private readonly dummyVerifier = randomBytes(32);
  private inFlight = 0;
  private readonly requestLimit: number;
  constructor(
    readonly repository: SpectatorAccessRepository,
    private readonly now: () => number = Date.now,
    options: { isolatedDemo?: true } = {},
  ) {
    if (options.isolatedDemo && process.env.NODE_ENV === "production")
      throw new Error(
        "The review request allowance requires an isolated nonproduction demo.",
      );
    this.requestLimit = options.isolatedDemo ? 30 : 5;
  }
  private limit(remoteAddress: string, kind: "auth" | "request") {
    const now = this.now();
    for (const [key, value] of this.attempts)
      if (now - value.start >= 3_600_000) this.attempts.delete(key);
    for (const [key, value] of this.sessions)
      if (value.expiresAt <= now) this.sessions.delete(key);
    const key = digest(`${kind}:${remoteAddress}`),
      window = kind === "request" ? 3_600_000 : 60_000;
    const prior = this.attempts.get(key),
      current =
        prior && now - prior.start < window ? prior : { start: now, count: 0 };
    current.count += 1;
    if (
      (this.attempts.size >= 10_000 && !prior) ||
      current.count > (kind === "request" ? this.requestLimit : 20) ||
      this.inFlight >= 4
    )
      throw new AccessError(
        "RATE_LIMIT",
        429,
        "Please wait before trying again.",
      );
    this.attempts.set(key, current);
  }
  private session(accountId: string): SpectatorAccessSession {
    if (this.sessions.size >= 2_000)
      throw new AccessError(
        "SESSION_LIMIT",
        503,
        "Please retry sign-in shortly.",
      );
    const accessToken = `spectator_${randomBytes(32).toString("base64url")}`,
      issuedAt = this.now(),
      expiresAt = issuedAt + 21_600_000;
    this.sessions.set(digest(accessToken), { accountId, issuedAt, expiresAt });
    return {
      accountId,
      accessToken,
      expiresAt: new Date(expiresAt).toISOString(),
      role: "spectator",
    };
  }
  identity(token: string): VerifiedIdentity {
    const session = /^spectator_[A-Za-z0-9_-]{43}$/.test(token)
      ? this.sessions.get(digest(token))
      : undefined;
    if (!session || session.expiresAt <= this.now()) {
      this.sessions.delete(digest(token));
      throw new AccessError("INVALID_SESSION", 401, "Sign in again.");
    }
    return {
      issuer: "urn:longball:spectator-pin",
      subject: session.accountId,
      strongAuth: false,
      authenticatedAt: session.issuedAt,
    };
  }
  logout(token: string) {
    this.identity(token);
    this.sessions.delete(digest(token));
  }
  close() {
    this.sessions.clear();
    this.attempts.clear();
    this.dummyVerifier.fill(0);
  }
  async preview(value: unknown, remoteAddress: string) {
    this.limit(remoteAddress, "auth");
    if (!object(value) || !exact(value, ["token"]))
      bad("Use the invitation from your link.");
    return this.repository.preview(invitationVerifier(value.token), this.now());
  }
  async register(
    value: unknown,
    remoteAddress: string,
  ): Promise<SpectatorAccessSession> {
    this.limit(remoteAddress, "auth");
    if (
      !object(value) ||
      !exact(value, ["token", "username", "passcode", "requestId"]) ||
      typeof value.username !== "string" ||
      typeof value.passcode !== "string" ||
      !opaque(value.requestId)
    )
      bad(
        "Use the invitation, username, four-digit passcode and request identity only.",
      );
    let username: string;
    try {
      username = normalizedSpectatorUsername(value.username);
    } catch {
      return bad(
        "Use a username of 3–40 letters, numbers, dots, underscores or dashes.",
      );
    }
    const problem = spectatorPinProblem(value.passcode);
    if (problem) bad(problem);
    const tokenHash = invitationVerifier(value.token);
    await this.repository.preview(tokenHash, this.now());
    const salt = randomBytes(16).toString("base64url");
    this.inFlight += 1;
    let verifier: Buffer;
    try {
      verifier = await derive(value.passcode, salt);
    } finally {
      this.inFlight -= 1;
    }
    try {
      const registered = await this.repository.register({
        tokenHash,
        username,
        salt,
        verifier: verifier.toString("hex"),
        accountId: randomUUID(),
        requestId: value.requestId,
        now: this.now(),
      });
      return this.session(registered.accountId);
    } finally {
      verifier.fill(0);
    }
  }
  async login(
    value: unknown,
    remoteAddress: string,
  ): Promise<SpectatorAccessSession> {
    this.limit(remoteAddress, "auth");
    if (
      !object(value) ||
      !exact(value, ["username", "passcode"]) ||
      typeof value.username !== "string" ||
      value.username.length > 128 ||
      typeof value.passcode !== "string" ||
      !/^\d{4}$/.test(value.passcode)
    )
      denied();
    let username: string;
    try {
      username = normalizedSpectatorUsername(value.username);
    } catch {
      return denied();
    }
    const credential = await this.repository.credential(username);
    this.inFlight += 1;
    let actual: Buffer;
    try {
      actual = await derive(value.passcode, credential?.salt ?? this.dummySalt);
    } finally {
      this.inFlight -= 1;
    }
    const matches = timingSafeEqual(
      actual,
      credential ? Buffer.from(credential.verifier, "hex") : this.dummyVerifier,
    );
    actual.fill(0);
    const success = Boolean(
      credential && matches && credential.lockedUntil <= this.now(),
    );
    await this.repository.loginAttempt(username, success, this.now());
    if (!success || !credential) denied();
    return this.session(credential.accountId);
  }
  directory() {
    return this.repository.directory();
  }
  async request(value: unknown, remoteAddress: string) {
    this.limit(remoteAddress, "request");
    if (
      !object(value) ||
      !exact(value, [
        "requestId",
        "clubId",
        "teamId",
        "seasonId",
        "requestedRole",
        "name",
        "email",
      ]) ||
      !opaque(value.requestId) ||
      !opaque(value.clubId) ||
      !opaque(value.teamId) ||
      !opaque(value.seasonId) ||
      !["player", "spectator"].includes(String(value.requestedRole)) ||
      typeof value.name !== "string" ||
      value.name.trim().length < 2 ||
      value.name.length > 80 ||
      /[\u0000-\u001f\u007f]/.test(value.name) ||
      typeof value.email !== "string" ||
      value.email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)
    )
      bad(
        "Choose a club and team, Player or Spectator, your name and a valid contact email.",
      );
    return this.repository.request(
      {
        ...(value as unknown as InviteRequestInput),
        name: value.name.trim(),
        email: value.email.trim().toLowerCase(),
      },
      this.now(),
    );
  }
}
