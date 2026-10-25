import { fictionalReviewApiUrl } from "@longball/application/review-entry";
import {
  normalizedSpectatorUsername,
  spectatorPinProblem,
  type InviteDirectoryTeam,
  type InviteRequestInput,
} from "@longball/application/spectator-pin";
import { parseInvitationContext } from "@longball/application/invitation-context";
import {
  parseSignInRules,
  pinProblem,
  usernameProblem,
  type SignInRules,
} from "@longball/application/identity-policy";
import { WIRE_CONTRACT_VERSION } from "@longball/application/sync";
import type { DemoLoginSession } from "./demo-login";
import { verifyDemoSession } from "./demo-login";
import { randomUUID } from "./id";
const object = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === "object" && !Array.isArray(v));
export async function spectatorAccessRequest(
  apiBaseUrl: string,
  path: string,
  body?: object,
  options: {
    signal?: AbortSignal;
    accessToken?: string;
    method?: "GET" | "POST";
    fetch?: typeof fetch;
  } = {},
): Promise<unknown> {
  const base = fictionalReviewApiUrl(apiBaseUrl);
  if (!base) throw new Error("The team service is unavailable.");
  const response = await (options.fetch ?? fetch)(`${base}/v1/${path}`, {
    method: options.method ?? (body ? "POST" : "GET"),
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    signal: options.signal ?? AbortSignal.timeout(20_000),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Api-Contract-Version": WIRE_CONTRACT_VERSION,
      ...(options.accessToken
        ? { Authorization: `Bearer ${options.accessToken}` }
        : {}),
      ...(body ? { "Idempotency-Key": randomUUID() } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (
    text.length > (path === "spectator-access/directory" ? 3_000_000 : 65_536)
  )
    throw new Error("The team service returned too much information.");
  if (!response.ok) {
    if (response.status === 429)
      throw new Error("Please wait before trying again.");
    if (response.status === 401)
      throw new Error("The username or passcode was not recognised.");
    if (response.status === 409)
      throw new Error(
        "That username or request is already in use. Sign in or choose another username.",
      );
    throw new Error(
      "This invitation or request could not be confirmed. Check the link and try again.",
    );
  }
  return text ? JSON.parse(text) : null;
}
export interface SpectatorInvitePreview {
  invitationId: string;
  clubId: string;
  teamId: string;
  seasonId: string;
  expiresAt: string;
  context: ReturnType<typeof parseInvitationContext>;
}
/** Public rules contain no account directory or credential material. */
export async function loadSpectatorSignInRules(
  apiBaseUrl: string,
  signal?: AbortSignal,
  fetchRequest?: typeof fetch,
): Promise<SignInRules> {
  const value = await spectatorAccessRequest(
    apiBaseUrl,
    "sign-in-rules",
    undefined,
    { signal, fetch: fetchRequest },
  );
  if (
    !object(value) ||
    value.kind !== "sign-in-rules" ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0
  )
    throw new Error("The current sign-in rules could not be verified.");
  try {
    return parseSignInRules(value.rules);
  } catch {
    throw new Error("The current sign-in rules could not be verified.");
  }
}
export async function previewSpectatorInvite(
  apiBaseUrl: string,
  token: string,
  signal?: AbortSignal,
): Promise<SpectatorInvitePreview> {
  const value = await spectatorAccessRequest(
    apiBaseUrl,
    "spectator-access/preview",
    { token },
    { signal },
  );
  if (
    !object(value) ||
    ["invitationId", "clubId", "teamId", "seasonId", "expiresAt"].some(
      (k) => typeof value[k] !== "string",
    ) ||
    !Number.isFinite(Date.parse(String(value.expiresAt))) ||
    Date.parse(String(value.expiresAt)) <= Date.now()
  )
    throw new Error("The invitation destination could not be verified.");
  return {
    ...value,
    context: parseInvitationContext(value.context),
  } as SpectatorInvitePreview;
}
export async function signInSpectatorPin(input: {
  apiBaseUrl: string;
  username: string;
  passcode: string;
  token?: string;
  register?: boolean;
  requestId?: string;
  rules?: SignInRules;
  signal: AbortSignal;
  fetch?: typeof fetch;
}): Promise<DemoLoginSession> {
  const username = normalizedSpectatorUsername(input.username);
  if (input.register) {
    const problem = input.rules
      ? usernameProblem(username, input.rules) ||
        pinProblem(input.passcode, input.rules)
      : spectatorPinProblem(input.passcode);
    if (problem) throw new Error(problem);
    if (!input.token)
      throw new Error("Use the invitation link to create an account.");
  } else if (!/^\d{4}$/.test(input.passcode))
    throw new Error("Enter your four-digit spectator passcode.");
  const value = await spectatorAccessRequest(
    input.apiBaseUrl,
    `spectator-access/${input.register ? "register" : "login"}`,
    {
      username,
      passcode: input.passcode,
      ...(input.register
        ? { token: input.token, requestId: input.requestId ?? randomUUID() }
        : {}),
    },
    { signal: input.signal, fetch: input.fetch },
  );
  if (
    !object(value) ||
    typeof value.accountId !== "string" ||
    typeof value.accessToken !== "string" ||
    !/^spectator_[A-Za-z0-9_-]{43}$/.test(value.accessToken) ||
    typeof value.expiresAt !== "string" ||
    value.role !== "spectator"
  )
    throw new Error("Spectator sign-in could not be verified.");
  const base = fictionalReviewApiUrl(input.apiBaseUrl)!;
  const session: DemoLoginSession = {
    apiBaseUrl: base,
    accountId: value.accountId,
    accessToken: value.accessToken,
    role: "spectator",
    expiresAtMs: Date.parse(value.expiresAt),
  };
  if (
    !Number.isFinite(session.expiresAtMs) ||
    session.expiresAtMs <= Date.now() ||
    session.expiresAtMs - Date.now() > 21_600_000
  )
    throw new Error("The spectator session has ended.");
  try {
    // Existing accounts can accept an additional team invitation without changing their PIN.
    if (input.token && !input.register) {
      const inspected = await spectatorAccessRequest(
        input.apiBaseUrl,
        "spectator-invites/inspect",
        { token: input.token },
        {
          signal: input.signal,
          accessToken: session.accessToken,
          fetch: input.fetch,
        },
      );
      if (
        !object(inspected) ||
        typeof inspected.teamId !== "string" ||
        typeof inspected.seasonId !== "string" ||
        !inspected.context
      )
        throw new Error("The invitation destination could not be verified.");
      parseInvitationContext(inspected.context);
      await spectatorAccessRequest(
        input.apiBaseUrl,
        "spectator-invites/accept",
        { token: input.token },
        {
          signal: input.signal,
          accessToken: session.accessToken,
          fetch: input.fetch,
        },
      );
    }
    await verifyDemoSession(
      session,
      input.signal,
      input.fetch ?? globalThis.fetch,
    );
  } catch (error) {
    void (input.fetch ?? fetch)(`${base}/v1/spectator-access/session`, {
      method: "DELETE",
      credentials: "omit",
      redirect: "error",
      headers: { Authorization: `Bearer ${session.accessToken}` },
    }).catch(() => undefined);
    throw error;
  }
  return session;
}
export async function inviteDirectory(
  apiBaseUrl: string,
  signal?: AbortSignal,
): Promise<InviteDirectoryTeam[]> {
  const value = await spectatorAccessRequest(
    apiBaseUrl,
    "spectator-access/directory",
    undefined,
    { signal },
  );
  if (
    !Array.isArray(value) ||
    value.length > 5000 ||
    value.some(
      (row) =>
        !object(row) ||
        [
          "clubId",
          "clubName",
          "teamId",
          "teamName",
          "ageGroup",
          "seasonId",
          "seasonLabel",
        ].some((k) => typeof row[k] !== "string"),
    )
  )
    throw new Error("The club and team list could not be verified.");
  return value as InviteDirectoryTeam[];
}
export async function requestTeamInvite(
  apiBaseUrl: string,
  input: InviteRequestInput,
  signal?: AbortSignal,
) {
  await spectatorAccessRequest(apiBaseUrl, "spectator-access/requests", input, {
    signal,
  });
}
