import { describe, expect, it } from "vitest";
import {
  acknowledgeClockChallenge,
  issueClockChallenge,
  mapContinuousInstant,
  type TrustedTimePolicy,
} from "./trusted-time";

const scope = {
  accountId: "manager",
  deviceId: "phone",
  matchId: "match",
  controllerEpoch: 1,
  continuityId: "boot-1",
};
const policy: TrustedTimePolicy = {
  id: "explicit-fictional-clock-trial-v1",
  serverClockUncertaintyMs: 10,
  maximumRoundTripMs: 2_000,
  maximumMappingAgeMs: 3_600_000,
  maximumUncertaintyMs: 1_000,
  maximumDriftPpm: 20,
};
const start = 1_790_000_000_000;
const challenge = () =>
  issueClockChallenge(scope, "opaque-server-challenge", start, policy);
const mapping = () =>
  acknowledgeClockChallenge(
    challenge(),
    { receivedMonotonicMs: 10_050, sentMonotonicMs: 10_070 },
    start + 120,
    policy,
  );

describe("server-observed continuous clock exchange", () => {
  it("encloses fractional endpoints around the rounded UTC instant", () => {
    const exactPolicy = {
      ...policy,
      serverClockUncertaintyMs: 0,
      maximumDriftPpm: 0,
      maximumUncertaintyMs: 10,
    };
    const issued = issueClockChallenge(
      scope,
      "fractional-proof",
      start,
      exactPolicy,
    );
    const mapped = acknowledgeClockChallenge(
      issued,
      { receivedMonotonicMs: 10.25, sentMonotonicMs: 10.25 },
      start,
      exactPolicy,
    );
    const result = mapContinuousInstant(
      mapped,
      scope,
      10.75,
      start + 1,
      exactPolicy,
    );
    expect(result.quality).toBe("trusted");
    if (result.quality !== "trusted") throw new Error(result.reason);
    expect(result.utcMs - result.uncertaintyMs).toBeLessThanOrEqual(
      start + 0.5,
    );
    expect(result.utcMs + result.uncertaintyMs).toBeGreaterThanOrEqual(
      start + 0.5,
    );
    expect(result.uncertaintyMs).toBe(1);
  });
  it("encloses an asymmetric round trip without using a device wall clock", () => {
    const result = mapContinuousInstant(
      mapping(),
      scope,
      10_070,
      start + 120,
      policy,
    );
    expect(result).toEqual({
      quality: "trusted",
      utcMs: start + 70,
      uncertaintyMs: 60,
      mappingId: challenge().id,
      policyId: policy.id,
    });
  });
  it("retains the original offline full-time instant and propagates drift rather than using receipt time", () => {
    const result = mapContinuousInstant(
      mapping(),
      scope,
      10_070 + 3_000_000,
      start + 8_000_000,
      policy,
    );
    expect(result).toMatchObject({
      quality: "trusted",
      utcMs: start + 3_000_070,
      uncertaintyMs: 120,
    });
  });
  it("accepts fractional native continuous-clock milliseconds", () => {
    const value = acknowledgeClockChallenge(
      challenge(),
      { receivedMonotonicMs: 10_050.25, sentMonotonicMs: 10_070.25 },
      start + 120,
      policy,
    );
    expect(
      mapContinuousInstant(value, scope, 10_070.25, start + 120, policy),
    ).toMatchObject({ quality: "trusted", utcMs: start + 70 });
  });
  it("rejects reversed clocks, expired exchanges and impossible client processing duration", () => {
    for (const [received, sent, acknowledged] of [
      [10_070, 10_050, 120],
      [10_050, 10_070, 2_001],
      [10_050, 10_500, 120],
      [10_050, 10_070, -1],
    ]) {
      expect(() =>
        acknowledgeClockChallenge(
          challenge(),
          { receivedMonotonicMs: received, sentMonotonicMs: sent },
          start + acknowledged,
          policy,
        ),
      ).toThrow();
    }
  });
  it("cannot reuse another account, device, controller epoch or reboot continuity mapping", () => {
    for (const changed of [
      { accountId: "other" },
      { deviceId: "other" },
      { matchId: "other" },
      { controllerEpoch: 2 },
      { continuityId: "boot-2" },
    ]) {
      expect(
        mapContinuousInstant(
          mapping(),
          { ...scope, ...changed },
          10_100,
          start + 200,
          policy,
        ).quality,
      ).toBe("review_required");
    }
  });
  it("does not extend an expired original mapping or trust future events", () => {
    expect(
      mapContinuousInstant(
        mapping(),
        scope,
        10_070 + 3_600_000,
        start + 8_000_000,
        policy,
      ).quality,
    ).toBe("review_required");
    expect(
      mapContinuousInstant(mapping(), scope, 12_070, start + 120, policy)
        .quality,
    ).toBe("review_required");
  });
  it("requires an explicit versioned bound and rejects excess uncertainty", () => {
    expect(() =>
      issueClockChallenge(scope, "id", start, { ...policy, id: "" }),
    ).toThrow();
    expect(() =>
      acknowledgeClockChallenge(
        challenge(),
        { receivedMonotonicMs: 10_000, sentMonotonicMs: 10_000 },
        start + 1_999,
        policy,
      ),
    ).toThrow();
    expect(
      mapContinuousInstant(mapping(), scope, 3_010_070, start + 4_000_000, {
        ...policy,
        maximumDriftPpm: 1_000,
      }).quality,
    ).toBe("review_required");
  });
});
