import type {
  ConnectedSession,
  PinRecord,
} from "@longball/application/security";

let credential: ConnectedSession | null = null;
/** Connected browser tokens never enter localStorage, IndexedDB or the synthetic journal. */
export const credentialStorage = "memory-browser" as const;
export async function readCredential(): Promise<ConnectedSession | null> {
  return credential;
}
export async function writeCredential(value: ConnectedSession): Promise<void> {
  credential = value;
}
export async function clearCredential(): Promise<void> {
  credential = null;
}
export async function readPin(_accountId: string): Promise<PinRecord | null> {
  return null;
}
export async function writePin(_pin: PinRecord): Promise<void> {
  throw new Error(
    "Local PIN enrollment is available only in a native development build.",
  );
}
export async function clearPin(_accountId: string): Promise<void> {}
