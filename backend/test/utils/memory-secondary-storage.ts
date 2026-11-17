import type { SecondaryStorage } from 'better-auth';

/** In-memory Better Auth `secondaryStorage` for e2e (Redis is stubbed). `keys()` lets specs peek. */
export function createMemorySecondaryStorage(): SecondaryStorage & { keys(): string[] } {
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  const read = (key: string) => {
    const entry = store.get(key);
    if (entry?.expiresAt && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    get: (key) => read(key)?.value ?? null,
    getAndDelete: (key) => {
      const value = read(key)?.value ?? null;
      store.delete(key);
      return value;
    },
    set: (key, value, ttl) => {
      store.set(key, { value, expiresAt: ttl ? Date.now() + ttl * 1000 : null });
    },
    delete: (key) => {
      store.delete(key);
    },
    increment: (key, ttl) => {
      const entry = read(key);
      const next = Number(entry?.value ?? 0) + 1;
      store.set(key, {
        value: String(next),
        expiresAt: entry ? entry.expiresAt : Date.now() + ttl * 1000,
      });
      return next;
    },
    keys: () => [...store.keys()].filter((k) => read(k) !== undefined),
  };
}
