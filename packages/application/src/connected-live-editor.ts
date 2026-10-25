import type { ClockSample, MatchState } from "../../domain/src/index";
import {
  queueConnectedCommand,
  type ConnectedCommand,
  type ConnectedMatchDocument,
} from "./sync";

/** Observed native journal capabilities, never inferred from platform or a successful compile. */
export interface NativeJournalEvidence {
  mode: string;
  cipherVersion: string | null;
  backupExcluded: boolean;
  wrongKeyProbe: string;
}
export interface NativeLiveAccess {
  platform: string;
  eligible: boolean;
  journalEvidence: NativeJournalEvidence | null;
}

export function assertNativeLiveAccess(
  match: MatchState,
  access: NativeLiveAccess,
): void {
  if (!["ios", "android"].includes(access.platform))
    throw new Error(
      "Connected browser recording is read-only. Use the native application.",
    );
  if (!access.eligible)
    throw new Error(
      "The active verified manager account does not currently authorize this controller.",
    );
  const journal = access.journalEvidence;
  if (
    !journal ||
    journal.mode !== "encrypted-native" ||
    !journal.cipherVersion?.trim() ||
    !journal.backupExcluded ||
    journal.wrongKeyProbe !== "passed"
  )
    throw new Error(
      "Check secure storage on this phone before recording. An encrypted journal and successful wrong-key check are required.",
    );
  assertSavedMatchRoster(match);
}

/** Both editors use the same saved fixture and frozen eligibility requirements. */
export function assertSavedMatchRoster(match: MatchState): void {
  const { config } = match;
  if (
    !config.fixture?.teamId ||
    !config.fixture.seasonId ||
    !config.fixture.teamName ||
    !config.slots ||
    config.slots.length !== config.pitchPlaces ||
    !config.profileSnapshot
  )
    throw new Error(
      "Download the saved service fixture, formation and immutable player snapshots before editing.",
    );
  const snapshots = config.profileSnapshot;
  if (
    new Set(snapshots.map((player) => player.playerId)).size !==
      snapshots.length ||
    config.selectedPlayerIds.some(
      (playerId) =>
        !config.players.some((player) => player.id === playerId) ||
        !snapshots.some(
          (player) =>
            player.playerId === playerId && player.eligiblePositions.length > 0,
        ),
    )
  )
    throw new Error(
      "The saved match roster or eligibility snapshots are incomplete. Reconcile the service preparation.",
    );
}

export function assertNativeLiveCommand(
  match: MatchState,
  command: ConnectedCommand,
  access: NativeLiveAccess,
): void {
  assertNativeLiveAccess(match, access);
  assertMatchCommandRoster(match, command);
}

/** Canonical identity and roster validation; this does not establish recording authority. */
export function assertMatchCommandRoster(
  match: MatchState,
  command: ConnectedCommand,
): void {
  if (
    !command ||
    typeof command !== "object" ||
    ["id", "sample", "actorId"].some((field) => field in command)
  )
    throw new Error(
      "Event identity, clock evidence and acting account belong to the canonical adapter.",
    );
  const selected = (playerId: string) => {
    if (!match.config.selectedPlayerIds.includes(playerId))
      throw new Error("Choose a player from this saved match squad.");
  };
  if (
    command.type === "attendance.recorded" ||
    command.type === "availability.changed"
  )
    selected(command.playerId);
  if (command.type === "goal.recorded" && command.scorerPlayerId)
    selected(command.scorerPlayerId);
  if (command.type === "event.corrected") {
    if (command.replacement.type === "availability.changed")
      selected(command.replacement.playerId);
    if (
      command.replacement.type === "goal.recorded" &&
      command.replacement.scorerPlayerId
    )
      selected(command.replacement.scorerPlayerId);
    if (command.replacement.type === "lineup.committed")
      for (const allocation of command.replacement.lineup)
        selected(allocation.playerId);
  }
  if (command.type === "lineup.staged" || command.type === "lineup.committed")
    for (const allocation of command.lineup) selected(allocation.playerId);
}

/** Same reducer/outbox/envelope path as all connected clock commands; no second event schema. */
export function queueNativeLiveCommand(
  document: ConnectedMatchDocument,
  command: ConnectedCommand,
  sample: ClockSample,
  eventId: string,
  access: NativeLiveAccess,
): ConnectedMatchDocument {
  if (
    !document.localState ||
    document.localState.config.matchId !== document.matchId
  )
    throw new Error("Download the matching controller fixture before editing.");
  assertNativeLiveCommand(document.localState, command, access);
  return queueConnectedCommand(document, command, sample, eventId);
}
