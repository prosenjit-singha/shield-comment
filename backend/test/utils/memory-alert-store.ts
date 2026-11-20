import { AlertStore } from '../../src/alerts/alert.store.js';

/** In-memory `AlertStore` (Redis semantics: `SET NX EX`, fixed-window `hit`). */
export class MemoryAlertStore extends AlertStore {
  readonly entries = new Map<string, { value: number; expiresAt: number }>();

  private live(key: string) {
    const entry = this.entries.get(key);
    return entry && entry.expiresAt > Date.now() ? entry : undefined;
  }

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    if (this.live(key)) return false;
    this.entries.set(key, {
      value: 1,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    return true;
  }

  async release(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async hit(key: string, windowSeconds: number): Promise<number> {
    const entry = this.live(key) ?? {
      value: 0,
      expiresAt: Date.now() + windowSeconds * 1000,
    };
    entry.value += 1;
    this.entries.set(key, entry);
    return entry.value;
  }

  /** TTL left on a key in seconds (`null` = missing/expired). */
  ttl(key: string): number | null {
    const entry = this.live(key);
    return entry ? Math.round((entry.expiresAt - Date.now()) / 1000) : null;
  }
}
