import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { AccessError, type Principal } from '../../../packages/application/src/access';
import { canonical, DevelopmentStore } from './store';

type Excluded = 'database' | 'path' | 'now' | 'transaction' | 'idempotent' | 'document' | 'migrate' | 'backup' | 'integrity' | 'close';
type AsyncMethods<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never };
export type RuntimeStore = AsyncMethods<Omit<DevelopmentStore, Excluded>> & {
  now: () => number;
  document<T>(teamId: string, seasonId: string, kind: string): Promise<T>;
  transaction<T>(work: () => Promise<T> | T): Promise<T>;
  idempotent<T>(principal: Principal, operation: string, key: string, payload: unknown, work: () => Promise<T> | T): Promise<T>;
  close(): Promise<void>;
};

/** Fictional SQLite facade. It does not translate SQL or emulate PostgreSQL. */
export function sqliteRuntimeStore(source: DevelopmentStore): { store: RuntimeStore; serialize<T>(work: () => Promise<T>): Promise<T> } {
  const transactionContext = new AsyncLocalStorage<boolean>();
  const facade: Record<string, unknown> = { now: source.now };
  for (const name of Object.getOwnPropertyNames(DevelopmentStore.prototype)) {
    if (name === 'constructor') continue;
    const method = (source as unknown as Record<string, unknown>)[name];
    if (typeof method === 'function') facade[name] = async (...args: unknown[]) => method.apply(source, args);
  }
  const transaction = async <T>(work: () => Promise<T> | T): Promise<T> => {
    if (transactionContext.getStore()) return work();
    source.database.exec('BEGIN IMMEDIATE');
    try { const result = await transactionContext.run(true, work); source.database.exec('COMMIT'); return result; }
    catch (error) { source.database.exec('ROLLBACK'); throw error; }
  };
  facade.transaction = transaction;
  facade.idempotent = async <T>(principal: Principal, operation: string, key: string, payload: unknown, work: () => Promise<T> | T): Promise<T> => {
    if (!/^[A-Za-z0-9_-]{8,150}$/.test(key)) throw new AccessError('INVALID_REQUEST', 400, 'A stable Idempotency-Key is required for mutations.');
    const signature = createHash('sha256').update(canonical(payload)).digest('hex');
    return transaction(async () => {
      const prior = source.database.prepare('SELECT signature,response_json FROM idempotency WHERE account_id=? AND operation=? AND key=?').get(principal.accountId, operation, key) as { signature: string; response_json: string } | undefined;
      if (prior) {
        if (prior.signature !== signature) throw new AccessError('IDEMPOTENCY_CONFLICT', 409, 'The idempotency key was already used with different content.');
        return JSON.parse(prior.response_json) as T;
      }
      const result = await work();
      source.database.prepare('INSERT INTO idempotency(account_id,operation,key,signature,response_json) VALUES(?,?,?,?,?)').run(principal.accountId, operation, key, signature, JSON.stringify(result));
      return result;
    });
  };
  let tail: Promise<unknown> = Promise.resolve();
  return { store: facade as RuntimeStore,
    serialize<T>(work: () => Promise<T>): Promise<T> {
      // Keep reads away from uncommitted async SQLite work. Production uses real pool transactions.
      const result = tail.then(work); tail = result.catch(() => undefined); return result;
    },
  };
}
