import {
  type MetaOAuthStateData,
  metaOAuthStateKey,
} from '../../src/meta/meta-oauth-state.js';
import { MetaOAuthStateStore } from '../../src/meta/meta-oauth-state.store.js';

/**
 * In-memory `MetaOAuthStateStore` for e2e (Redis is stubbed): same TTL + single-use semantics as the
 * Redis store, keyed by the same hashed key. `expire(state)` fakes the 10-minute TTL running out.
 */
export class MemoryMetaOAuthStateStore extends MetaOAuthStateStore {
  private readonly entries = new Map<
    string,
    { data: MetaOAuthStateData; expiresAt: number }
  >();
  /** TTL of every `save` call, for assertions. */
  readonly ttls: number[] = [];

  async save(
    state: string,
    data: MetaOAuthStateData,
    ttlSeconds: number,
  ): Promise<void> {
    const key = metaOAuthStateKey(state);
    if (this.entries.has(key))
      throw new Error('OAuth state key already exists');
    this.ttls.push(ttlSeconds);
    this.entries.set(key, {
      data: { ...data },
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async take(state: string): Promise<MetaOAuthStateData | null> {
    const key = metaOAuthStateKey(state);
    const entry = this.entries.get(key);
    this.entries.delete(key);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry.data;
  }

  expire(state: string): void {
    const entry = this.entries.get(metaOAuthStateKey(state));
    if (entry) entry.expiresAt = 0;
  }

  get size(): number {
    return this.entries.size;
  }
}
