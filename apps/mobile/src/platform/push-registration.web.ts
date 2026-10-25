import type { ConnectedSessionSummary } from "./auth/client";
import type { createNativePushClient } from "./push-registration-core";
export async function connectedNativePushClient(
  _session: ConnectedSessionSummary,
): Promise<ReturnType<typeof createNativePushClient>> {
  throw new Error("Native push registration is unavailable in browser review.");
}
export function subscribeNativePushRotation(_listener: () => void) {
  return () => {};
}
