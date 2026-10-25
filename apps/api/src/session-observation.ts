/** Deliberately excludes bearer tokens, token digests, credentials, addresses and attempted usernames. */
export interface SessionObservation {
  accountId: string;
  sessionId: string;
  provider: "demo" | "spectator_pin";
  issuedAtMs: number;
  expiresAtMs: number;
}

export interface SessionFailureObservation {
  kind: "login_failure";
  provider: SessionObservation["provider"];
  at: number;
  reason: "invalid_credentials" | "rate_limited" | "locked" | "capacity";
}

export type SessionFailureObserver = (
  event: Readonly<SessionFailureObservation>,
) => void | Promise<void>;
