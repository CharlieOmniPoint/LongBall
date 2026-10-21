import type { ActivationCompletionDestination } from "./deep-links";
/** Same-origin routing evidence only. The original capability is deliberately excluded. */
export function parseActivationRelayMessage(
  value: unknown,
): ActivationCompletionDestination | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    Object.keys(record).some(
      (key) => !["activationId", "completionProof"].includes(key),
    ) ||
    typeof record.activationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      record.activationId,
    ) ||
    typeof record.completionProof !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(record.completionProof)
  )
    return null;
  return {
    activationId: record.activationId,
    completionProof: record.completionProof,
  };
}
export function activationRelayChannelName(entryUrl: string): string {
  const url = new URL(entryUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Use an exact app entry for activation return routing.");
  return `longball.activation-completion.v1:${url.pathname}`;
}
