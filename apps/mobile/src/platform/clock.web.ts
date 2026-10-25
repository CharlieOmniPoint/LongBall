import { browserId } from './browser-id';
import type { ClockReading } from './types';

// A reload always changes this marker. Browser sleep continuity is never advertised as proved.
let pageSession = `browser-page-${browserId()}`;
globalThis.document?.addEventListener('visibilitychange', () => {
  if (globalThis.document.visibilityState === 'visible') {
    pageSession = `browser-page-${browserId()}`;
  }
});

export function readClock(): ClockReading {
  return {
    monotonicMs: performance.now(), continuityId: pageSession,
    source: 'browser performance clock · device continuity unverified', verifiedContinuous: false,
  };
}
