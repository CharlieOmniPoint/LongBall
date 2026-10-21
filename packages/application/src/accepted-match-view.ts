import type { ConnectedMatchDocument } from "./sync";

export interface AcceptedPolicySummary {
  version: number;
  minimumStintMs: number;
  batchLimit: number;
  scoreLeadThreshold: number;
  returnToNormalEnabled: boolean;
  halfBufferFraction: number;
}
/** Reads the versioned policy added by the policy increment without inventing one for older checkpoints. */
function policySummary(match: object): AcceptedPolicySummary | null {
  const policy = (
    match as {
      activePolicy?: {
        policyVersion?: number;
        payload?: Partial<
          Omit<AcceptedPolicySummary, "version" | "halfBufferFraction">
        >;
        softPreferences?: { halfBufferFraction?: number };
        applicability?: { q07?: string };
      };
    }
  ).activePolicy;
  const payload = policy?.payload,
    buffer = policy?.softPreferences?.halfBufferFraction;
  if (
    !policy ||
    !Number.isSafeInteger(policy.policyVersion) ||
    policy.policyVersion! < 1 ||
    !payload ||
    !Number.isSafeInteger(payload.minimumStintMs) ||
    payload.minimumStintMs! < 0 ||
    !Number.isSafeInteger(payload.batchLimit) ||
    payload.batchLimit! < 1 ||
    !Number.isSafeInteger(payload.scoreLeadThreshold) ||
    payload.scoreLeadThreshold! < 0 ||
    typeof payload.returnToNormalEnabled !== "boolean" ||
    typeof buffer !== "number" ||
    !Number.isFinite(buffer) ||
    buffer < 0 ||
    buffer >= 0.5 ||
    policy.applicability?.q07 !== "unapproved"
  )
    return null;
  return {
    version: policy.policyVersion!,
    minimumStintMs: payload.minimumStintMs!,
    batchLimit: payload.batchLimit!,
    scoreLeadThreshold: payload.scoreLeadThreshold!,
    returnToNormalEnabled: payload.returnToNormalEnabled,
    halfBufferFraction: buffer,
  };
}

/** A second manager sees only the authoritative checkpoint, without clock extrapolation. */
export function acceptedMatchView(
  document: ConnectedMatchDocument,
  observedAtMs: number,
) {
  const match = document.acceptedState;
  if (
    !match ||
    match.config.matchId !== document.matchId ||
    match.revision !== document.acceptedRevision ||
    document.authoritativeDownloadRequired ||
    !Number.isSafeInteger(match.halfActiveMs) ||
    match.halfActiveMs < 0 ||
    !Number.isSafeInteger(match.matchActiveMs) ||
    match.matchActiveMs < 0
  )
    return null;
  const preparation =
    match.status === "preparation" || match.status === "half_time";
  const lineup = preparation ? match.stagedLineup : match.lineup;
  const squad = match.config.players.filter((player) =>
    match.config.selectedPlayerIds.includes(player.id),
  );
  const present = squad.filter(
    (player) => match.attendance[player.id] === "present",
  );
  const downloadedAtMs =
    document.downloadedAt === null ? NaN : Date.parse(document.downloadedAt);
  return {
    match,
    lineup,
    preparation,
    bench: present.filter(
      (player) =>
        match.availability[player.id] &&
        !lineup.some((slot) => slot.playerId === player.id),
    ),
    unavailable: present.filter((player) => !match.availability[player.id]),
    notCheckedIn: squad.filter(
      (player) => match.attendance[player.id] !== "present",
    ),
    halfActiveMs: match.halfActiveMs,
    matchActiveMs: match.matchActiveMs,
    remainingMs: Math.max(
      0,
      match.config.plannedHalfDurationMs - match.halfActiveMs,
    ),
    downloadedAt: Number.isFinite(downloadedAtMs)
      ? document.downloadedAt
      : null,
    downloadAgeMs:
      Number.isFinite(downloadedAtMs) &&
      Number.isFinite(observedAtMs) &&
      observedAtMs >= downloadedAtMs
        ? observedAtMs - downloadedAtMs
        : null,
    recorder: document.controllerObservation ?? null,
    policy: policySummary(match),
  };
}
