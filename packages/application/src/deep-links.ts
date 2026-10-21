/** Links select a screen. They never supply a service origin, authentication or role authority. */
export interface SpectatorInvitationDestination {
  teamId: string;
  seasonId: string;
  code: string;
}
export interface ChildActivationDestination {
  teamId: string;
  seasonId: string;
  playerId: string;
}
export interface ActivationCompletionDestination {
  activationId: string;
  completionProof: string;
}
export type LongBallDestination =
  | { kind: "invitation"; invitation: SpectatorInvitationDestination }
  | { kind: "activation" }
  | {
      kind: "activation-completion";
      completion: ActivationCompletionDestination;
    };
export interface DeepLinkPolicy {
  /** Explicit owned HTTPS origins only. No hostname is inferred from an incoming link. */
  httpsOrigins?: readonly string[];
}
const identifier = /^[A-Za-z0-9_-]{1,150}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function exact(params: URLSearchParams, fields: readonly string[]): boolean {
  const keys = Array.from(params.keys());
  return (
    keys.length === fields.length &&
    fields.every((field) => params.getAll(field).length === 1)
  );
}
export function parseLongBallDestination(
  value: string,
  policy: DeepLinkPolicy = {},
): LongBallDestination | null {
  if (value.length > 4096) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search) return null;
  let route: string;
  if (url.protocol === "longball:" && !url.port) {
    route = `${url.hostname}${url.pathname}`.replace(/\/$/, "");
  } else if (
    url.protocol === "https:" &&
    policy.httpsOrigins?.includes(url.origin)
  ) {
    route = url.pathname.replace(/^\//, "").replace(/\/$/, "");
  } else return null;
  const params = new URLSearchParams(url.hash.slice(1));
  if (route === "invite" && exact(params, ["teamId", "seasonId", "code"])) {
    const teamId = params.get("teamId")!,
      seasonId = params.get("seasonId")!,
      code = params.get("code")!;
    if (
      identifier.test(teamId) &&
      identifier.test(seasonId) &&
      /^[A-Za-z0-9_-]{8,256}$/.test(code)
    )
      return { kind: "invitation", invitation: { teamId, seasonId, code } };
  }
  if (route === "activate" && !url.hash) return { kind: "activation" };
  if (
    route === "activation/callback" &&
    exact(params, ["longballActivation", "completionProof"])
  ) {
    const activationId = params.get("longballActivation")!,
      completionProof = params.get("completionProof")!;
    if (uuid.test(activationId) && /^[A-Za-z0-9_-]{43}$/.test(completionProof))
      return {
        kind: "activation-completion",
        completion: { activationId, completionProof },
      };
  }
  return null;
}

export function sameActivationCompletion(
  value: LongBallDestination | null,
  activationId: string,
): value is Extract<LongBallDestination, { kind: "activation-completion" }> {
  return (
    value?.kind === "activation-completion" &&
    value.completion.activationId === activationId
  );
}
