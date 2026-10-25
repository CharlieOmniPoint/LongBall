import { randomUUID } from 'expo-crypto';
import { AppState } from 'react-native';
import { nativeCapabilities } from './native-capabilities';
import type { ClockReading } from './types';

let unprovedSessionId = `unverified-js-session-${randomUUID()}`;
let lastAppState = AppState.currentState;
AppState.addEventListener('change', (state) => {
  if (state === 'active' && lastAppState !== 'active') {
    // JS cannot prove sleep continuity. A native source keeps its own boot identifier.
    unprovedSessionId = `unverified-js-session-${randomUUID()}`;
  }
  lastAppState = state;
});

export function readClock(): ClockReading {
  let sample: ClockReading | null = null;
  try { sample = nativeCapabilities?.readClock() ?? null; }
  catch { /* Missing native evidence is handled as unverified time, never invented continuity. */ }
  if (sample && Number.isFinite(sample.monotonicMs) && sample.monotonicMs >= 0) {
    return {
      ...sample,
      continuityId: sample.continuityId || unprovedSessionId,
      verifiedContinuous: sample.verifiedContinuous && Boolean(sample.continuityId),
    };
  }
  return {
    monotonicMs: performance.now(), continuityId: unprovedSessionId,
    source: 'unverified JavaScript session clock', verifiedContinuous: false,
  };
}
