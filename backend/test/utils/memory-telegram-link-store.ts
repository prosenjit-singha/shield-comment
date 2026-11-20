import {
  type TelegramLinkData,
  TelegramLinkStore,
  telegramLinkKey,
} from '../../src/alerts/telegram-link.js';

/** In-memory `TelegramLinkStore` (Redis semantics: TTL, single use). `expire(code)` fakes 15 min passing. */
export class MemoryTelegramLinkStore extends TelegramLinkStore {
  private readonly entries = new Map<
    string,
    { data: TelegramLinkData; expiresAt: number }
  >();
  readonly ttls: number[] = [];

  async save(
    code: string,
    data: TelegramLinkData,
    ttlSeconds: number,
  ): Promise<void> {
    this.ttls.push(ttlSeconds);
    this.entries.set(telegramLinkKey(code), {
      data: { ...data },
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async take(code: string): Promise<TelegramLinkData | null> {
    const key = telegramLinkKey(code);
    const entry = this.entries.get(key);
    this.entries.delete(key);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry.data;
  }

  expire(code: string): void {
    const entry = this.entries.get(telegramLinkKey(code));
    if (entry) entry.expiresAt = 0;
  }
}
