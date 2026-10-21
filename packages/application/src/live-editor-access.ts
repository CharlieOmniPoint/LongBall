import type { MatchState } from "../../domain/src/index";
import type { ConnectedCommand } from "./sync";
import {
  assertMatchCommandRoster,
  assertNativeLiveAccess,
  assertNativeLiveCommand,
  assertSavedMatchRoster,
  type NativeJournalEvidence,
  type NativeLiveAccess,
} from "./connected-live-editor";

export type LiveEditorMode = "native" | "fictional-review";
export interface LiveEditorAccess extends NativeLiveAccess {
  mode?: LiveEditorMode;
  /** Explicit build/caller allowance, never inferred from an incoming URL or role selector. */
  allowFictionalReview?: boolean;
  journalEvidence: (NativeJournalEvidence & { deviceId?: string }) | null;
}

/** Fictional browser review has an independent, deliberately narrow entry boundary. */
export function assertLiveEditorAccess(
  match: MatchState,
  access: LiveEditorAccess,
): void {
  if (access.mode !== "fictional-review") {
    assertNativeLiveAccess(match, access);
    return;
  }
  if (
    access.allowFictionalReview !== true ||
    access.platform !== "web" ||
    !access.eligible ||
    access.journalEvidence?.mode !== "synthetic-browser" ||
    !access.journalEvidence.deviceId?.trim() ||
    !match.config.matchId.startsWith("synthetic-")
  )
    throw new Error(
      "Demo recording requires the browser review, a sample fixture, its local preview journal and the confirmed demo controller.",
    );
  assertSavedMatchRoster(match);
}

export function assertLiveEditorCommand(
  match: MatchState,
  command: ConnectedCommand,
  access: LiveEditorAccess,
): void {
  if (access.mode !== "fictional-review") {
    assertNativeLiveCommand(match, command, access);
    return;
  }
  assertLiveEditorAccess(match, access);
  assertMatchCommandRoster(match, command);
}
