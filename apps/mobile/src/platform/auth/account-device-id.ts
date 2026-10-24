import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
const pending = new Map<string, Promise<string>>();
/** Account/issuer-scoped metadata identifier. It is never an authentication or controller credential. */
export async function accountDeviceId(
  issuer: string,
  accountId: string,
): Promise<string> {
  const key = `longball.auth.app-device.${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify([issuer, accountId]))}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const work = (async () => {
    const options = {
      keychainService: "longball-connected-identity",
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    };
    const saved = await SecureStore.getItemAsync(key, options);
    if (saved) {
      if (!/^[0-9a-f-]{36}$/i.test(saved))
        throw new Error("The saved app-device identifier could not be read.");
      return saved;
    }
    const created = Crypto.randomUUID();
    await SecureStore.setItemAsync(key, created, options);
    return created;
  })();
  pending.set(key, work);
  try {
    return await work;
  } finally {
    pending.delete(key);
  }
}
