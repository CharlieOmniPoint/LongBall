import { describe, expect, it } from "vitest";
import {
  establishContinuousClockMapping,
  type ClockExchangePort,
} from "./clock-exchange";

function trial(
  changes: {
    unverified?: boolean;
    reboot?: boolean;
    stale?: boolean;
    wrongMatch?: boolean;
  } = {},
) {
  let sample = 10,
    serial = 0,
    phase = 0;
  const requests: { path: string; body: unknown; key: string }[] = [];
  const scope = { matchId: "match", deviceId: "phone", controllerEpoch: 2 };
  const port: ClockExchangePort = {
    observe: () => ({
      verifiedContinuous: !changes.unverified,
      sample: {
        monotonicMs: sample++ + 0.25,
        sessionId: changes.reboot && phase > 0 ? "boot-2" : "boot-1",
        wallTimeMs: 9_000_000_000_000,
      },
    }),
    assertCurrent: () => {
      if (changes.stale && phase > 0)
        throw new Error("Account/controller changed");
    },
    nextId: () => `request-${++serial}`,
    mutate: async <T>(path: string, body: unknown, key: string) => {
      requests.push({ path, body, key });
      phase++;
      return (
        phase === 1
          ? {
              id: "challenge",
              ...scope,
              matchId: changes.wrongMatch ? "other" : scope.matchId,
              continuityId: "boot-1",
              policyId: "fictional-policy",
            }
          : {
              challengeId: "challenge",
              ...scope,
              continuityId: "boot-1",
              policyId: "fictional-policy",
              establishedAtMs: 1_000,
              validUntilMs: 2_000,
              offsetMinimumMs: 900,
              offsetMaximumMs: 910,
              sampleMonotonicMs: (body as { sentMonotonicMs: number })
                .sentMonotonicMs,
            }
      ) as T;
    },
  };
  return { port, scope, requests };
}
describe("native/server continuous clock exchange client", () => {
  it("sends measured receipt/send monotonic samples without sending device wall time", async () => {
    const value = trial();
    await expect(
      establishContinuousClockMapping(value.port, value.scope),
    ).resolves.toMatchObject({ challengeId: "challenge", controllerEpoch: 2 });
    expect(value.requests).toHaveLength(2);
    expect(value.requests[1]).toMatchObject({
      path: "/v1/matches/match/clock/challenges/challenge/acknowledge",
      body: { receivedMonotonicMs: 11.25, sentMonotonicMs: 12.25 },
    });
    expect(JSON.stringify(value.requests)).not.toContain("9000000000000");
    expect(value.requests[0].key).not.toBe(value.requests[1].key);
  });
  it("refuses an unverified native clock before any request while allowing only an explicit fictional trial", async () => {
    const value = trial({ unverified: true });
    await expect(
      establishContinuousClockMapping(value.port, value.scope),
    ).rejects.toThrow("Continuous clock");
    expect(value.requests).toHaveLength(0);
    const fictional = trial({ unverified: true });
    await expect(
      establishContinuousClockMapping(fictional.port, fictional.scope, {
        permitFictionalSessionClock: true,
      }),
    ).resolves.toMatchObject({ challengeId: "challenge" });
  });
  it("discards reboots, authority changes and mismatched scope before acknowledgement", async () => {
    for (const change of [
      { reboot: true },
      { stale: true },
      { wrongMatch: true },
    ]) {
      const value = trial(change);
      await expect(
        establishContinuousClockMapping(value.port, value.scope),
      ).rejects.toThrow();
      expect(value.requests).toHaveLength(1);
    }
  });
});
