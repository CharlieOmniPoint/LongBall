import { describe, expect, it } from "vitest";
import {
  createMatch,
  ENGINE_VERSION,
  playerMinutes,
  type ClockSample,
  type MatchState,
} from "../../domain/src/index";
import {
  assertNativeLiveAccess,
  queueNativeLiveCommand,
  type NativeLiveAccess,
} from "./connected-live-editor";
import {
  attachGrant,
  createConnectedDocument,
  mergeDownload,
  WIRE_CONTRACT_VERSION,
  type ConnectedCommand,
  type ConnectedMatchDocument,
  type MatchDownload,
} from "./sync";

const at = 1_800_000_000_000;
const sample = (monotonicMs = 0): ClockSample => ({
  monotonicMs,
  sessionId: "native-boot-evidence",
  wallTimeMs: at + monotonicMs,
});
const access: NativeLiveAccess = {
  platform: "ios",
  eligible: true,
  journalEvidence: {
    mode: "encrypted-native",
    cipherVersion: "observed-test-cipher",
    backupExcluded: true,
    wrongKeyProbe: "passed",
  },
};
function fixture(): MatchState {
  const players = Array.from({ length: 7 }, (_, index) => ({
    id: `prepared-player-${index}`,
    displayName: `Fictional Roma player ${index + 1}`,
    goalkeeperChoice: index === 0 ? 1 : 0,
  }));
  return createMatch({
    matchId: "prepared-roma-fixture",
    players,
    selectedPlayerIds: players.map((player) => player.id),
    pitchPlaces: 5,
    plannedHalfDurationMs: 1_500_000,
    fixedKeeperId: players[0].id,
    initialAttendance: Object.fromEntries(
      players.map((player) => [player.id, "present" as const]),
    ),
    slots: Array.from({ length: 5 }, (_, index) => ({
      slotId: `saved-slot-${index}`,
      position: index === 0 ? "GK" : "CM",
    })),
    fixture: {
      opponent: "Fictional Maple",
      playedDate: "2026-10-24",
      kickoff: null,
      homeAway: "home",
      seasonId: "prepared-season",
      teamId: "prepared-roma",
      teamName: "Roma U10 · fictional",
      clubName: "Fictional Roma",
    },
    profileSnapshot: players.map((player, index) => ({
      playerId: player.id,
      initials: `P${index}`,
      preferences: index === 0 ? ["GK"] : ["CM"],
      eligiblePositions: index === 0 ? ["GK"] : ["CM"],
    })),
  });
}
function ready(): ConnectedMatchDocument {
  const state = fixture();
  const download: MatchDownload = {
    contractVersion: WIRE_CONTRACT_VERSION,
    schemaVersion: 1,
    engineVersion: ENGINE_VERSION,
    matchId: state.config.matchId,
    state,
    acceptedRevision: 0,
    deviceCheckpoint: { clientSequence: 0, previousEventId: null },
    controller: {
      epoch: 3,
      account_id: "verified-manager",
      device_id: "native-account-device",
      frozen: 0,
    },
    downloadedAt: new Date(at).toISOString(),
    clockAnchor: {
      serverTime: new Date(at).toISOString(),
      quality: "observation_only",
      continuousMappingEstablished: false,
    },
    syntheticOnly: true,
  };
  const granted = attachGrant(
    mergeDownload(
      createConnectedDocument(
        "native-account-device",
        state.config.matchId,
        "https://api.example.invalid",
      ),
      download,
    ),
    {
      epoch: 3,
      deviceId: "native-account-device",
      controllerToken: "test-capability-never-rendered",
      checkpoint: download.deviceCheckpoint,
    },
  );
  return mergeDownload(granted, download);
}
function lineup(state: MatchState) {
  return state.config.slots!.map((slot, index) => ({
    slotId: slot.slotId,
    position: slot.position,
    playerId: state.config.players[index].id,
  }));
}
function queue(
  document: ConnectedMatchDocument,
  command: ConnectedCommand,
  ms = 0,
) {
  return queueNativeLiveCommand(
    document,
    command,
    sample(ms),
    `native-event-${document.allocatedSequence + 1}`,
    access,
  );
}

describe("native connected live editor boundary", () => {
  it("requires actual native journal evidence, active authority and saved fixture snapshots before allocating a sequence", () => {
    const document = ready();
    for (const denied of [
      { ...access, platform: "web" },
      { ...access, eligible: false },
      { ...access, journalEvidence: null },
      ...[
        { mode: "synthetic-browser" },
        { cipherVersion: "" },
        { backupExcluded: false },
        { wrongKeyProbe: "not-run" },
        { wrongKeyProbe: "failed" },
      ].map((patch) => ({
        ...access,
        journalEvidence: { ...access.journalEvidence!, ...patch },
      })),
    ])
      expect(() =>
        queueNativeLiveCommand(
          document,
          {
            type: "attendance.recorded",
            playerId: "prepared-player-1",
            status: "absent",
          },
          sample(),
          "blocked-event",
          denied,
        ),
      ).toThrow();
    expect(document.allocatedSequence).toBe(0);
    expect(document.outbox).toEqual([]);
    const legacy = {
      ...document.localState!,
      config: { ...document.localState!.config, profileSnapshot: undefined },
    };
    expect(() => assertNativeLiveAccess(legacy, access)).toThrow("snapshots");
  });
  it("uses the authenticated saved roster, formation and canonical wire envelope without a fictional default scorer", () => {
    let document = ready();
    expect(() =>
      queue(document, {
        type: "attendance.recorded",
        playerId: "synthetic-player-01",
        status: "present",
      }),
    ).toThrow("saved match squad");
    document = queue(document, {
      type: "lineup.staged",
      lineup: lineup(document.localState!),
    });
    document = queue(document, { type: "half.started" });
    document = queue(
      document,
      {
        type: "goal.recorded",
        beneficiary: "opposition",
        isOwnGoal: true,
        scorerPlayerId: "prepared-player-2",
        goalType: "open_play",
        effective: { half: 1, halfElapsedMs: 10_000, matchElapsedMs: 10_000 },
      },
      20_000,
    );
    const event = document.outbox.at(-1)!.envelope;
    expect(event).toMatchObject({
      contractVersion: WIRE_CONTRACT_VERSION,
      engineVersion: ENGINE_VERSION,
      schemaVersion: 1,
      matchId: "prepared-roma-fixture",
      deviceId: "native-account-device",
      controllerEpoch: 3,
      clientSequence: 3,
      previousEventId: "native-event-2",
      baseRevision: 2,
      effectiveHalf: 1,
      halfElapsedMs: 10_000,
      matchElapsedMs: 10_000,
      timeQuality: "reviewRequired",
    });
    expect(event.command).toMatchObject({
      scorerPlayerId: "prepared-player-2",
      isOwnGoal: true,
      id: event.eventId,
      sample: sample(20_000),
    });
    expect(event.command).not.toHaveProperty("actorId");
    expect(document.localState!.score).toEqual({ for: 0, against: 1 });
    expect(() =>
      queue(document, {
        type: "goal.recorded",
        beneficiary: "us",
        actorId: "forged-manager",
      } as ConnectedCommand),
    ).toThrow("acting account");
  });
  it("retains correction and void audit in the same outbox while actual paused minutes stay unchanged", () => {
    let document = ready();
    document = queue(document, {
      type: "lineup.staged",
      lineup: lineup(document.localState!),
    });
    document = queue(document, { type: "half.started" });
    document = queue(
      document,
      {
        type: "goal.recorded",
        beneficiary: "us",
        scorerPlayerId: "prepared-player-1",
      },
      10_000,
    );
    const goalId = document.outbox.at(-1)!.envelope.eventId;
    document = queue(document, { type: "half.paused" }, 20_000);
    const minutes = playerMinutes(document.localState!, sample(20_000));
    document = queue(
      document,
      {
        type: "event.corrected",
        targetEventId: goalId,
        reason: "Fictional own-goal review",
        replacement: {
          type: "goal.recorded",
          beneficiary: "opposition",
          isOwnGoal: true,
          scorerPlayerId: "prepared-player-1",
        },
      },
      30_000,
    );
    document = queue(
      document,
      {
        type: "event.voided",
        targetEventId: goalId,
        reason: "Fictional referee disallowance",
      },
      40_000,
    );
    expect(playerMinutes(document.localState!, sample(40_000))).toEqual(
      minutes,
    );
    expect(document.localState!.score).toEqual({ for: 0, against: 0 });
    expect(document.localState!.goals![0]).toMatchObject({
      eventId: goalId,
      voided: true,
    });
    expect(
      document.outbox.map((entry) => entry.envelope.clientSequence),
    ).toEqual([1, 2, 3, 4, 5, 6]);
    expect(
      document.localState!.eventHistory!.some(
        (event) => event.id === goalId && event.type === "goal.recorded",
      ),
    ).toBe(true);
  });
  it("preserves an injury vacancy and requires an explicit replacement after return, conserving actual minutes", () => {
    let document = ready();
    document = queue(document, {
      type: "lineup.staged",
      lineup: lineup(document.localState!),
    });
    document = queue(document, { type: "half.started" });
    document = queue(
      document,
      {
        type: "availability.changed",
        playerId: "prepared-player-1",
        available: false,
        reason: "injury",
      },
      10_000,
    );
    expect(document.localState!.lineup).toHaveLength(4);
    document = queue(
      document,
      {
        type: "availability.changed",
        playerId: "prepared-player-1",
        available: true,
        reason: "return",
      },
      30_000,
    );
    expect(
      document.localState!.lineup.some(
        (player) => player.playerId === "prepared-player-1",
      ),
    ).toBe(false);
    document = queue(
      document,
      {
        type: "lineup.committed",
        lineup: lineup(document.localState!),
        sourceRevision: document.localState!.revision,
      },
      40_000,
    );
    document = queue(document, { type: "half.paused" }, 50_000);
    const minutes = playerMinutes(document.localState!, sample(50_000));
    expect(
      minutes.find((player) => player.playerId === "prepared-player-1"),
    ).toMatchObject({
      playingMs: 20_000,
      unavailableMs: 20_000,
      benchMs: 10_000,
    });
    for (const record of minutes)
      expect(record.playingMs + record.unavailableMs + record.benchMs).toBe(
        50_000,
      );
    expect(minutes.reduce((sum, player) => sum + player.playingMs, 0)).toBe(
      220_000,
    );
  });
  it("uses existing durable stream refusal rules for controller denial, recovery and retained uncertain requests", () => {
    const document = ready();
    for (const blocked of [
      { ...document, controllerConfirmed: false },
      { ...document, reconciliationRequired: true },
      {
        ...document,
        pendingRequest: {
          idempotencyKey: "retained-key",
          kind: "upload" as const,
          path: "/v1/matches/fixture/events",
          body: {},
        },
      },
    ]) {
      expect(() =>
        queue(blocked, {
          type: "attendance.recorded",
          playerId: "prepared-player-1",
          status: "absent",
        }),
      ).toThrow();
      expect(blocked.allocatedSequence).toBe(0);
    }
  });
  it("rejects a planner draft after another event changes its source revision and leaves the canonical stream intact", () => {
    let document = ready();
    document = queue(document, {
      type: "lineup.staged",
      lineup: lineup(document.localState!),
    });
    document = queue(document, { type: "half.started" });
    const reviewed = {
      sourceRevision: document.localState!.revision,
      lineup: lineup(document.localState!).map((allocation) =>
        allocation.playerId === "prepared-player-1"
          ? { ...allocation, playerId: "prepared-player-5" }
          : { ...allocation },
      ),
    };
    document = queue(
      document,
      { type: "goal.recorded", beneficiary: "opposition" },
      10_000,
    );
    const before = JSON.stringify(document);
    expect(() =>
      queue(document, { type: "lineup.committed", ...reviewed }, 20_000),
    ).toThrow("stale");
    expect(JSON.stringify(document)).toBe(before);
    expect(
      document.localState!.lineup.some(
        (allocation) => allocation.playerId === "prepared-player-5",
      ),
    ).toBe(false);
  });
  it("records a late arrival at the current active boundary, retains earlier absence and requires a separate lineup confirmation", () => {
    let document = ready();
    document = queue(document, {
      type: "attendance.recorded",
      playerId: "prepared-player-6",
      status: "absent",
    });
    document = queue(document, {
      type: "lineup.staged",
      lineup: lineup(document.localState!),
    });
    document = queue(document, { type: "half.started" });
    document = queue(
      document,
      {
        type: "attendance.recorded",
        playerId: "prepared-player-6",
        status: "present",
      },
      30_000,
    );
    const arrival = document.outbox.at(-1)!.envelope;
    expect(arrival).toMatchObject({
      effectiveHalf: 1,
      halfElapsedMs: 30_000,
      matchElapsedMs: 30_000,
    });
    expect(
      document.localState!.lineup.some(
        (allocation) => allocation.playerId === "prepared-player-6",
      ),
    ).toBe(false);
    const replacement = lineup(document.localState!).map((allocation) =>
      allocation.playerId === "prepared-player-2"
        ? { ...allocation, playerId: "prepared-player-6" }
        : allocation,
    );
    document = queue(
      document,
      {
        type: "lineup.committed",
        lineup: replacement,
        sourceRevision: document.localState!.revision,
      },
      40_000,
    );
    document = queue(document, { type: "half.paused" }, 50_000);
    const minutes = playerMinutes(document.localState!, sample(50_000));
    expect(
      minutes.find((player) => player.playerId === "prepared-player-6"),
    ).toMatchObject({
      playingMs: 10_000,
      benchMs: 10_000,
      unavailableMs: 30_000,
    });
    for (const player of minutes)
      expect(player.playingMs + player.benchMs + player.unavailableMs).toBe(
        50_000,
      );
  });
});
