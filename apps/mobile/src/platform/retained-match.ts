import type { MatchState } from "@longball/domain";

/** A retained fixture must be checked before replay, bootstrap replacement or UI attachment. */
export function assertRetainedMatchFixture(
  value: unknown,
  requestedMatchId: string,
): asserts value is MatchState {
  if (
    !value ||
    typeof value !== "object" ||
    !("config" in value) ||
    !value.config ||
    typeof value.config !== "object" ||
    !("matchId" in value.config) ||
    value.config.matchId !== requestedMatchId
  ) {
    throw new Error(
      "The saved match does not belong to the requested fixture. Existing data and event history were retained; no replacement match was created.",
    );
  }
}
