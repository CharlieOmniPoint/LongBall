import type {
  PendingPushUpdate,
  ProtectedPushPendingStore,
} from "./push-registration-core";
export interface ProtectedStringStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
/** Small OS-protected chunks avoid platform single-value limits. Commit the manifest last. */
export function createProtectedPushPendingStore(
  store: ProtectedStringStore,
  prefix: string,
  nextId: () => string,
): ProtectedPushPendingStore {
  const manifestKey = `${prefix}.manifest`;
  const manifest = async () => {
    const text = await store.get(manifestKey);
    if (!text) return null;
    const value = JSON.parse(text) as {
      version: number;
      generation: string;
      count: number;
    };
    if (
      value.version !== 1 ||
      !/^[A-Za-z0-9_-]{8,80}$/.test(value.generation) ||
      !Number.isInteger(value.count) ||
      value.count < 1 ||
      value.count > 8
    )
      throw new Error("PUSH_PENDING_UNAVAILABLE");
    return value;
  };
  const key = (generation: string, index: number) =>
    `${prefix}.${generation}.${index}`;
  return {
    async load() {
      const saved = await manifest();
      if (!saved) return null;
      let text = "";
      for (let index = 0; index < saved.count; index++) {
        const chunk = await store.get(key(saved.generation, index));
        if (chunk === null || chunk.length > 1500)
          throw new Error("PUSH_PENDING_UNAVAILABLE");
        text += chunk;
      }
      return JSON.parse(text) as PendingPushUpdate;
    },
    async save(value) {
      if (await manifest()) throw new Error("PUSH_PENDING_ALREADY_EXISTS");
      const text = JSON.stringify(value),
        generation = nextId();
      if (text.length > 12_000 || !/^[A-Za-z0-9_-]{8,80}$/.test(generation))
        throw new Error("PUSH_PENDING_TOO_LARGE");
      const chunks = Array.from(
        { length: Math.ceil(text.length / 1500) },
        (_, index) => text.slice(index * 1500, (index + 1) * 1500),
      );
      const manifestText = JSON.stringify({
        version: 1,
        generation,
        count: chunks.length,
      });
      let chunksComplete = false;
      try {
        for (let index = 0; index < chunks.length; index++)
          await store.set(key(generation, index), chunks[index]);
        chunksComplete = true;
        await store.set(manifestKey, manifestText);
      } catch {
        // A native write may commit and then reject. Never delete the chunks of
        // an acknowledged manifest, or destroy evidence while its outcome is unknown.
        let observed: string | null;
        try {
          observed = await store.get(manifestKey);
        } catch {
          throw new Error("PUSH_PENDING_SAVE_UNCERTAIN");
        }
        if (observed === manifestText) {
          if (chunksComplete) return;
          throw new Error("PUSH_PENDING_SAVE_UNCERTAIN");
        }
        if (observed !== null) throw new Error("PUSH_PENDING_SAVE_UNCERTAIN");
        for (let index = 0; index < chunks.length; index++)
          await store.remove(key(generation, index)).catch(() => {});
        throw new Error("PUSH_PENDING_NOT_SAVED");
      }
    },
    async clear() {
      const saved = await manifest();
      if (!saved) return;
      await store.remove(manifestKey);
      for (let index = 0; index < saved.count; index++)
        await store.remove(key(saved.generation, index));
    },
  };
}
