import type { ClockSample } from "../../domain/src/types";

export interface ContinuousClockObservation {
  sample: ClockSample;
  verifiedContinuous: boolean;
}
export interface ClockMappingReceipt {
  challengeId: string;
  policyId: string;
  deviceId: string;
  matchId: string;
  controllerEpoch: number;
  continuityId: string;
  establishedAtMs: number;
  validUntilMs: number;
  offsetMinimumMs: number;
  offsetMaximumMs: number;
  sampleMonotonicMs: number;
}
export interface ClockExchangePort {
  mutate<T>(path: string, body: unknown, idempotencyKey: string): Promise<T>;
  observe(): ContinuousClockObservation;
  nextId(): string;
  /** Guard the originating auth/controller generation after every asynchronous step. */
  assertCurrent(): void;
}
export async function establishContinuousClockMapping(
  port: ClockExchangePort,
  scope: { matchId: string; deviceId: string; controllerEpoch: number },
  options: { permitFictionalSessionClock?: boolean } = {},
): Promise<ClockMappingReceipt> {
  const first = port.observe();
  const check = (observation: ContinuousClockObservation) => {
    port.assertCurrent();
    if (
      (!observation.verifiedContinuous &&
        !options.permitFictionalSessionClock) ||
      observation.sample.sessionId !== first.sample.sessionId ||
      !Number.isFinite(observation.sample.monotonicMs) ||
      observation.sample.monotonicMs < first.sample.monotonicMs
    )
      throw new Error(
        "Continuous clock proof changed during the exchange. Keep recording locally; the finish-time evidence needs a new exchange.",
      );
  };
  check(first);
  if (
    !scope.matchId ||
    !scope.deviceId ||
    !Number.isSafeInteger(scope.controllerEpoch) ||
    scope.controllerEpoch < 1 ||
    !first.sample.sessionId
  )
    throw new Error(
      "Select the current match controller before establishing server time.",
    );
  const path = `/v1/matches/${encodeURIComponent(scope.matchId)}/clock/challenges`;
  const challenge = await port.mutate<{
    id: string;
    matchId: string;
    deviceId: string;
    controllerEpoch: number;
    continuityId: string;
    policyId: string;
  }>(
    path,
    {
      deviceId: scope.deviceId,
      controllerEpoch: scope.controllerEpoch,
      continuityId: first.sample.sessionId,
    },
    port.nextId(),
  );
  const received = port.observe();
  check(received);
  if (
    !challenge ||
    typeof challenge.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,150}$/.test(challenge.id) ||
    challenge.matchId !== scope.matchId ||
    challenge.deviceId !== scope.deviceId ||
    challenge.controllerEpoch !== scope.controllerEpoch ||
    challenge.continuityId !== first.sample.sessionId ||
    !challenge.policyId
  )
    throw new Error(
      "The clock challenge differs from the selected controller.",
    );
  const sent = port.observe();
  check(sent);
  if (sent.sample.monotonicMs < received.sample.monotonicMs)
    throw new Error(
      "The continuous clock moved backwards during the exchange.",
    );
  const mapping = await port.mutate<ClockMappingReceipt>(
    `${path}/${encodeURIComponent(challenge.id)}/acknowledge`,
    {
      receivedMonotonicMs: received.sample.monotonicMs,
      sentMonotonicMs: sent.sample.monotonicMs,
    },
    port.nextId(),
  );
  check(port.observe());
  if (
    !mapping ||
    mapping.challengeId !== challenge.id ||
    mapping.matchId !== scope.matchId ||
    mapping.deviceId !== scope.deviceId ||
    mapping.controllerEpoch !== scope.controllerEpoch ||
    mapping.continuityId !== first.sample.sessionId ||
    mapping.policyId !== challenge.policyId ||
    ![
      mapping.establishedAtMs,
      mapping.validUntilMs,
      mapping.offsetMinimumMs,
      mapping.offsetMaximumMs,
      mapping.sampleMonotonicMs,
    ].every(Number.isFinite) ||
    mapping.validUntilMs <= mapping.establishedAtMs ||
    mapping.offsetMaximumMs < mapping.offsetMinimumMs ||
    mapping.sampleMonotonicMs !== sent.sample.monotonicMs
  ) {
    throw new Error(
      "The clock mapping response is incompatible. Local recording remains unchanged.",
    );
  }
  return mapping;
}
