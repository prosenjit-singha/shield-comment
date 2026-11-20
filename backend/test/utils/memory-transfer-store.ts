import { OwnershipTransferStore } from '../../src/workspaces/ownership-transfer.store.js';

/** In-memory `OwnershipTransferStore` (Redis semantics: TTL per key, fixed-window `hit`). */
export class MemoryOwnershipTransferStore extends OwnershipTransferStore {
  readonly entries = new Map<string, { value: string; expiresAt: number }>();

  async put(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry.value;
  }

  async del(...keys: string[]): Promise<void> {
    for (const key of keys) this.entries.delete(key);
  }

  async hit(key: string, windowSeconds: number): Promise<number> {
    const current = await this.get(key);
    const count = Number(current ?? 0) + 1;
    const expiresAt =
      current === null
        ? Date.now() + windowSeconds * 1000
        : this.entries.get(key)!.expiresAt;
    this.entries.set(key, { value: String(count), expiresAt });
    return count;
  }

  /** Fakes every key with this prefix running out. */
  expire(prefix: string): void {
    for (const [key, entry] of this.entries)
      if (key.startsWith(prefix)) entry.expiresAt = 0;
  }
}
