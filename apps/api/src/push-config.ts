import { readFileSync } from "node:fs";
import { parsePushPlatformPolicies } from "../../../packages/application/src/push-registrations";
import { pushTokenCipherFromFile } from "./push-token-crypto";
import type { PushOptions } from "./push-registrations";
/** A missing provider choice is visible as unconfigured. Never invent a processor or key. */
export function readPushOptions(
  env: Record<string, string | undefined>,
): PushOptions {
  const policy = env.LONGBALL_PUSH_PLATFORMS_FILE,
    keyring = env.LONGBALL_PUSH_KEYRING_FILE;
  if (!policy && !keyring) return {};
  if (!policy || !keyring)
    throw new Error(
      "Configure both mounted push platform policy and encryption keyring files.",
    );
  let pushPlatforms;
  try {
    pushPlatforms = parsePushPlatformPolicies(
      JSON.parse(readFileSync(policy, "utf8")),
    );
  } catch {
    throw new Error("Configure an explicit valid push platform policy file.");
  }
  return { pushPlatforms, pushTokenCipher: pushTokenCipherFromFile(keyring) };
}
