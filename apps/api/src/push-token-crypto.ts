import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { readFileSync } from "node:fs";
export interface PushCipherBinding {
  accountId: string;
  issuer: string;
  deviceId: string;
  transport: string;
  providerConfigId: string;
}
export interface PushTokenCipher {
  usesActiveKey(value: string): boolean;
  encrypt(token: string, binding: PushCipherBinding): string;
  decrypt(value: string, binding: PushCipherBinding): string;
}
export const pushTokenDigest = (token: string) =>
  createHash("sha256")
    .update("longball.push-token.v1\0")
    .update(token)
    .digest("hex");
export function createPushTokenCipher(
  activeKeyId: string,
  keys: ReadonlyMap<string, Buffer>,
): PushTokenCipher {
  if (
    !/^[A-Za-z0-9_-]{1,80}$/.test(activeKeyId) ||
    !keys.has(activeKeyId) ||
    [...keys.values()].some((key) => key.length !== 32)
  )
    throw new Error("Invalid push encryption key configuration.");
  const material = new Map(
    [...keys].map(([id, key]) => [id, Buffer.from(key)]),
  );
  const aad = (binding: PushCipherBinding) =>
    Buffer.from(
      JSON.stringify([
        "longball.push-token.v1",
        binding.issuer,
        binding.accountId,
        binding.deviceId,
        binding.transport,
        binding.providerConfigId,
      ]),
    );
  return {
    usesActiveKey(value) {
      try {
        const record = JSON.parse(value);
        return record.v === 1 && record.keyId === activeKeyId;
      } catch {
        return false;
      }
    },
    encrypt(token, binding) {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", material.get(activeKeyId)!, iv);
      cipher.setAAD(aad(binding));
      const ciphertext = Buffer.concat([
        cipher.update(token, "utf8"),
        cipher.final(),
      ]);
      return JSON.stringify({
        v: 1,
        keyId: activeKeyId,
        iv: iv.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
      });
    },
    decrypt(value, binding) {
      try {
        const record = JSON.parse(value) as Record<string, unknown>;
        if (
          record.v !== 1 ||
          typeof record.keyId !== "string" ||
          !material.has(record.keyId) ||
          ![record.iv, record.ciphertext, record.tag].every(
            (item) => typeof item === "string" && /^[A-Za-z0-9_-]+$/.test(item),
          )
        )
          throw new Error();
        const iv = Buffer.from(record.iv as string, "base64url"),
          tag = Buffer.from(record.tag as string, "base64url");
        if (iv.length !== 12 || tag.length !== 16) throw new Error();
        const decipher = createDecipheriv(
          "aes-256-gcm",
          material.get(record.keyId)!,
          iv,
        );
        decipher.setAAD(aad(binding));
        decipher.setAuthTag(tag);
        return Buffer.concat([
          decipher.update(
            Buffer.from(record.ciphertext as string, "base64url"),
          ),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw new Error("PUSH_TOKEN_UNAVAILABLE");
      }
    },
  };
}
/** Only an explicitly mounted deployment keyring is read. No generated fallback key. */
export function pushTokenCipherFromFile(
  path: string | undefined,
): PushTokenCipher | undefined {
  if (!path) return undefined;
  try {
    const input = JSON.parse(readFileSync(path, "utf8")) as {
      activeKeyId: string;
      keys: Record<string, string>;
    };
    const keys = new Map(
      Object.entries(input.keys).map(([id, value]) => {
        const decoded = Buffer.from(value, "base64url");
        if (decoded.length !== 32 || decoded.toString("base64url") !== value)
          throw new Error();
        return [id, decoded] as const;
      }),
    );
    return createPushTokenCipher(input.activeKeyId, keys);
  } catch {
    throw new Error(
      "Configure a valid mounted push encryption keyring. Key material was not logged.",
    );
  }
}
