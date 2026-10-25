/** Server-owned clock exchange. Device wall-clock values are deliberately absent. */
export interface ClockExchangeScope {
  accountId: string;
  deviceId: string;
  matchId: string;
  controllerEpoch: number;
  continuityId: string;
}
export interface TrustedTimePolicy {
  id: string;
  serverClockUncertaintyMs: number;
  maximumRoundTripMs: number;
  maximumMappingAgeMs: number;
  maximumUncertaintyMs: number;
  maximumDriftPpm: number;
}
export interface ClockChallenge extends ClockExchangeScope {
  id: string;
  issuedAtMs: number;
  expiresAtMs: number;
  policyId: string;
}
export interface ContinuousUtcMapping extends ClockExchangeScope {
  challengeId: string;
  policyId: string;
  establishedAtMs: number;
  sampleMonotonicMs: number;
  offsetMinimumMs: number;
  offsetMaximumMs: number;
  validUntilMs: number;
}
export type TrustedInstant = {
  quality: "trusted";
  utcMs: number;
  uncertaintyMs: number;
  mappingId: string;
  policyId: string;
};
export type UntrustedInstant = { quality: "review_required"; reason: string };
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
const continuous = (value: number) =>
  Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
function checkPolicy(policy: TrustedTimePolicy): void {
  if (
    !policy.id ||
    ![
      policy.serverClockUncertaintyMs,
      policy.maximumRoundTripMs,
      policy.maximumMappingAgeMs,
      policy.maximumUncertaintyMs,
      policy.maximumDriftPpm,
    ].every(integer) ||
    !policy.maximumRoundTripMs ||
    !policy.maximumMappingAgeMs
  ) {
    throw new Error("A versioned, explicit trusted-time policy is required.");
  }
}
export function issueClockChallenge(
  scope: ClockExchangeScope,
  id: string,
  issuedAtMs: number,
  policy: TrustedTimePolicy,
): ClockChallenge {
  checkPolicy(policy);
  if (
    !id ||
    !scope.accountId ||
    !scope.deviceId ||
    !scope.matchId ||
    !scope.continuityId ||
    !integer(issuedAtMs) ||
    !integer(scope.controllerEpoch) ||
    scope.controllerEpoch === 0
  ) {
    throw new Error(
      "The clock challenge requires a current controller and continuous-clock identity.",
    );
  }
  return {
    ...scope,
    id,
    issuedAtMs,
    expiresAtMs: issuedAtMs + policy.maximumRoundTripMs,
    policyId: policy.id,
  };
}
/** Call once within the repository transaction that consumes this challenge. */
export function acknowledgeClockChallenge(
  challenge: ClockChallenge,
  sample: { receivedMonotonicMs: number; sentMonotonicMs: number },
  serverReceivedAtMs: number,
  policy: TrustedTimePolicy,
): ContinuousUtcMapping {
  checkPolicy(policy);
  const { receivedMonotonicMs, sentMonotonicMs } = sample;
  if (
    challenge.policyId !== policy.id ||
    !integer(serverReceivedAtMs) ||
    !continuous(receivedMonotonicMs) ||
    !continuous(sentMonotonicMs) ||
    sentMonotonicMs < receivedMonotonicMs ||
    serverReceivedAtMs < challenge.issuedAtMs ||
    serverReceivedAtMs > challenge.expiresAtMs ||
    sentMonotonicMs - receivedMonotonicMs >
      serverReceivedAtMs - challenge.issuedAtMs
  ) {
    throw new Error(
      "The clock exchange expired or its continuous-clock evidence is inconsistent.",
    );
  }
  const mapping: ContinuousUtcMapping = {
    accountId: challenge.accountId,
    deviceId: challenge.deviceId,
    matchId: challenge.matchId,
    controllerEpoch: challenge.controllerEpoch,
    continuityId: challenge.continuityId,
    challengeId: challenge.id,
    policyId: policy.id,
    establishedAtMs: serverReceivedAtMs,
    sampleMonotonicMs: sentMonotonicMs,
    offsetMinimumMs:
      challenge.issuedAtMs -
      receivedMonotonicMs -
      policy.serverClockUncertaintyMs,
    offsetMaximumMs:
      serverReceivedAtMs - sentMonotonicMs + policy.serverClockUncertaintyMs,
    validUntilMs: serverReceivedAtMs + policy.maximumMappingAgeMs,
  };
  if (
    (mapping.offsetMaximumMs - mapping.offsetMinimumMs) / 2 >
    policy.maximumUncertaintyMs
  )
    throw new Error(
      "The clock exchange exceeds the approved uncertainty bound.",
    );
  return mapping;
}
export function mapContinuousInstant(
  mapping: ContinuousUtcMapping,
  scope: ClockExchangeScope,
  monotonicMs: number,
  serverNowMs: number,
  policy: TrustedTimePolicy,
): TrustedInstant | UntrustedInstant {
  checkPolicy(policy);
  if (
    mapping.policyId !== policy.id ||
    (
      [
        "accountId",
        "deviceId",
        "matchId",
        "controllerEpoch",
        "continuityId",
      ] as const
    ).some((key) => scope[key] !== mapping[key])
  ) {
    return {
      quality: "review_required",
      reason:
        "The clock mapping belongs to another controller, device, match or continuity session.",
    };
  }
  if (
    !continuous(monotonicMs) ||
    !integer(serverNowMs) ||
    serverNowMs < mapping.establishedAtMs
  )
    return {
      quality: "review_required",
      reason: "The server or continuous-clock observation is invalid.",
    };
  const distance = Math.abs(monotonicMs - mapping.sampleMonotonicMs);
  if (distance > policy.maximumMappingAgeMs)
    return {
      quality: "review_required",
      reason: "The event exceeds the approved extrapolation duration.",
    };
  const minimum = monotonicMs + mapping.offsetMinimumMs;
  const maximum = monotonicMs + mapping.offsetMaximumMs;
  // Old offline events may arrive after mapping expiry. Their original instant remains usable
  // only if it lies within the original mapping lifetime; receipt never extends that lifetime.
  if (
    minimum < mapping.establishedAtMs - policy.maximumRoundTripMs ||
    maximum > mapping.validUntilMs ||
    minimum > serverNowMs
  ) {
    return {
      quality: "review_required",
      reason:
        "The event lies outside the original mapping lifetime or in the future.",
    };
  }
  const utcMs = Math.round((minimum + maximum) / 2);
  // Enclose the original interval around the returned integer instant, including
  // the displacement introduced by rounding a fractional continuous-clock sample.
  const uncertaintyMs = Math.ceil(
    Math.max(utcMs - minimum, maximum - utcMs) +
      (distance * policy.maximumDriftPpm) / 1_000_000,
  );
  if (uncertaintyMs > policy.maximumUncertaintyMs)
    return {
      quality: "review_required",
      reason: "Propagated clock uncertainty exceeds the approved bound.",
    };
  return {
    quality: "trusted",
    utcMs,
    uncertaintyMs,
    mappingId: mapping.challengeId,
    policyId: mapping.policyId,
  };
}
