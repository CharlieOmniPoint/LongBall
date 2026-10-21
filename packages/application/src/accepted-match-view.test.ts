import { describe, expect, it } from "vitest";
import {
  createMatch,
  ENGINE_VERSION,
  reduceMatch,
  type MatchState,
} from "../../domain/src/index";
import { acceptedMatchView } from "./accepted-match-view";
import {
  assertConnectedDocument,
  canCaptureConnectedEvents,
  createConnectedDocument,
  mergeDownload,
  queueConnectedCommand,
  WIRE_CONTRACT_VERSION,
  type MatchDownload,
} from "./sync";
const now = Date.parse("2026-10-21T12:00:00Z");
const sample = (monotonicMs = 0) => ({
  monotonicMs,
  wallTimeMs: now + monotonicMs,
  sessionId: "other-recorder-session",
});
function fixture(): MatchState {
  let match = createMatch({
    matchId: "view-match",
    players: Array.from({ length: 9 }, (_, index) => ({
      id: `player-${index}`,
      displayName: `Fictional ${index}`,
      goalkeeperChoice: index === 0 ? 1 : 0,
    })),
    selectedPlayerIds: Array.from(
      { length: 9 },
      (_, index) => `player-${index}`,
    ),
    pitchPlaces: 7,
    fixedKeeperId: "player-0",
    plannedHalfDurationMs: 1_500_000,
  });
  let id = 0;
  for (const playerId of match.config.selectedPlayerIds)
    match = reduceMatch(match, {
      id: `present-${++id}`,
      type: "attendance.recorded",
      playerId,
      status: "present",
      sample: sample(),
    });
  match = reduceMatch(match, {
    id: "stage",
    type: "lineup.staged",
    lineup: match.config.selectedPlayerIds
      .slice(0, 7)
      .map((playerId, index) => ({
        playerId,
        slotId: `slot-${index}`,
        position: index === 0 ? "GK" : "CM",
      })),
    sample: sample(),
  });
  match = reduceMatch(match, {
    id: "start",
    type: "half.started",
    sample: sample(),
  });
  return reduceMatch(match, {
    id: "goal",
    type: "goal.recorded",
    beneficiary: "us",
    scorerPlayerId: "player-1",
    sample: sample(32_000),
  });
}
function download(state = fixture()): MatchDownload {
  return {
    contractVersion: WIRE_CONTRACT_VERSION,
    schemaVersion: 1,
    engineVersion: ENGINE_VERSION,
    matchId: state.config.matchId,
    state,
    acceptedRevision: state.revision,
    deviceCheckpoint: { clientSequence: 0, previousEventId: null },
    controller: {
      epoch: 3,
      account_id: "manager-a",
      device_id: "phone-a",
      frozen: 0,
    },
    downloadedAt: new Date(now).toISOString(),
    clockAnchor: {
      serverTime: new Date(now).toISOString(),
      quality: "observation_only",
      continuousMappingEstablished: false,
    },
    syntheticOnly: true,
  };
}
describe("accepted second-manager view", () => {
  it("separates available bench, unavailable and unchecked players without inventing attendance", () => {
    const state = fixture();
    state.availability["player-7"] = false;
    state.attendance["player-8"] = "not_recorded";
    const saved = mergeDownload(
      createConnectedDocument("phone-b", "view-match", "/"),
      download(state),
    );
    const view = acceptedMatchView(saved, now)!;
    expect(view.bench).toEqual([]);
    expect(view.unavailable.map((player) => player.id)).toEqual(["player-7"]);
    expect(view.notCheckedIn.map((player) => player.id)).toEqual(["player-8"]);
  });
  it("shows only accepted versioned policy values without writing or inventing defaults for older matches", () => {
    const state = fixture();
    Object.assign(state, {
      activePolicy: {
        policyVersion: 2,
        payload: {
          minimumStintMs: 300_000,
          batchLimit: 2,
          scoreLeadThreshold: 4,
          returnToNormalEnabled: false,
        },
        softPreferences: { halfBufferFraction: 0.15 },
        applicability: { q07: "unapproved" },
      },
    });
    const saved = mergeDownload(
      createConnectedDocument("phone-b", "view-match", "/"),
      download(state),
    );
    expect(acceptedMatchView(saved, now)?.policy).toEqual({
      version: 2,
      minimumStintMs: 300_000,
      batchLimit: 2,
      scoreLeadThreshold: 4,
      returnToNormalEnabled: false,
      halfBufferFraction: 0.15,
    });
    expect(
      acceptedMatchView(
        mergeDownload(
          createConnectedDocument("phone-b", "view-match", "/"),
          download(),
        ),
        now,
      )?.policy,
    ).toBeNull();
  });
  it("never substitutes a local candidate or extrapolates the recorder clock", () => {
    const saved = mergeDownload(
      createConnectedDocument("phone-b", "view-match", "/"),
      download(),
    );
    const candidate = {
      ...saved,
      localState: {
        ...saved.acceptedState!,
        score: { for: 99, against: 99 },
        halfActiveMs: 999_000,
      },
    };
    const early = acceptedMatchView(candidate, now),
      later = acceptedMatchView(candidate, now + 600_000);
    expect(early?.match.score).toEqual({ for: 1, against: 0 });
    expect(later?.halfActiveMs).toBe(32_000);
    expect(later?.remainingMs).toBe(1_468_000);
    expect(early?.lineup).toHaveLength(7);
    expect(later?.bench.map((player) => player.id)).toEqual([
      "player-7",
      "player-8",
    ]);
    expect(later?.downloadAgeMs).toBe(600_000);
    expect(saved.controllerConfirmed).toBe(false);
    expect(canCaptureConnectedEvents(saved)).toBe(false);
    expect(() =>
      queueConnectedCommand(
        saved,
        { type: "half.paused" },
        sample(40_000),
        "forbidden-edit",
      ),
    ).toThrow(/explicit controller/);
  });
  it("stores only allowlisted recorder metadata in the same snapshot merge, never grants from it", () => {
    const received = download();
    Object.assign(received.controller!, {
      controllerToken: "must-not-copy",
      capability_hash: "must-not-copy",
    });
    const saved = mergeDownload(
      createConnectedDocument("phone-b", "view-match", "/"),
      received,
    );
    expect(saved.controllerObservation).toEqual({
      epoch: 3,
      accountId: "manager-a",
      deviceId: "phone-a",
      frozen: false,
    });
    expect(JSON.stringify(saved.controllerObservation)).not.toContain(
      "must-not-copy",
    );
    expect(saved.grant).toBeNull();
    expect(saved.controllerConfirmed).toBe(false);
    const forged = {
      ...saved,
      controllerObservation: {
        epoch: 4,
        accountId: "manager-b",
        deviceId: "phone-b",
        frozen: false,
      },
    };
    expect(canCaptureConnectedEvents(forged)).toBe(false);
    assertConnectedDocument(forged);
    expect(() =>
      assertConnectedDocument({
        ...forged,
        controllerObservation: {
          ...forged.controllerObservation,
          token: "forbidden",
        },
      } as typeof forged),
    ).toThrow(/metadata is invalid/);
  });
  it("requires a matching authoritative state and supports old caches without recorder metadata", () => {
    const saved = mergeDownload(
      createConnectedDocument("phone-b", "view-match", "/"),
      download(),
    );
    expect(
      acceptedMatchView(
        { ...saved, acceptedRevision: saved.acceptedRevision + 1 },
        now,
      ),
    ).toBeNull();
    expect(
      acceptedMatchView({ ...saved, authoritativeDownloadRequired: true }, now),
    ).toBeNull();
    const legacy = { ...saved };
    delete legacy.controllerObservation;
    assertConnectedDocument(legacy);
    expect(acceptedMatchView(legacy, now)?.recorder).toBeNull();
    const invalid = download();
    invalid.controller!.device_id = "phone-a\n";
    expect(() => mergeDownload(saved, invalid)).toThrow(/metadata is invalid/);
    expect(saved.controllerObservation?.deviceId).toBe("phone-a");
  });
});
