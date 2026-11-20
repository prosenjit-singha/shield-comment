import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { eq } from 'drizzle-orm';
import {
  TokenCipherService,
  TokenDecryptionError,
} from '../crypto/token-cipher.service.js';
import type { Database } from '../db/database.js';
import { aiProviderKeys, aiProviderSettings } from '../db/schema/index.js';
import {
  type AiConfigResolver,
  type AiProvider,
  type AiProviderConfig,
  isAiProvider,
} from './ai-provider.js';
import {
  AI_ENV_SETTINGS,
  type AiEnvSettings,
  type AiSettingsSnapshot,
  aiProviderKeyContext,
  buildAiSettingsSnapshot,
  snapshotConfig,
  type StoredAiKey,
} from './ai-settings.rules.js';

/** How long a resolved config is reused (other instances see a PATCH after at most this). */
export const AI_CONFIG_CACHE_TTL_MS = 30_000;

/** Raw rows the resolver reads (one settings row at most, one key row per provider). */
export interface AiSettingsRows {
  settings:
    | {
        provider: string | null;
        model: string | null;
        textImageModel: string | null;
        textImageEnabled: boolean;
        updatedAt: Date;
        updatedById: string | null;
      }
    | undefined;
  keys: {
    provider: string;
    keyCiphertext: string;
    last4: string;
    updatedAt: Date;
  }[];
}

export interface AiSettingsState extends AiSettingsSnapshot {
  /** The settings row's `updated_at` / `updated_by_id` (`null` = no row). */
  updatedAt: Date | null;
  updatedById: string | null;
}

/**
 * `AiConfigResolver` backed by the admin settings (M5-T3, D16): per field DB → `.env` → default
 * (`ai-settings.rules.ts`). The resolved config is cached for `AI_CONFIG_CACHE_TTL_MS`;
 * `invalidate()` (called after a settings PATCH commits) drops it. An undecryptable DB key counts
 * as unset (logged once per key: provider + reason only). If the DB read fails, the last resolved
 * config (or the env-only one) is used and nothing is cached.
 */
@Injectable()
export class DbAiConfigResolver implements AiConfigResolver {
  private readonly logger = new Logger(DbAiConfigResolver.name);
  private cache: { config: AiProviderConfig | null; expiresAt: number } | null =
    null;
  private generation = 0;
  private readonly reported = new Set<string>();

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly cipher: TokenCipherService,
    @Inject(AI_ENV_SETTINGS) private readonly env: AiEnvSettings,
  ) {}

  async resolve(): Promise<AiProviderConfig | null> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return copy(this.cache.config);
    }
    const generation = this.generation;
    try {
      const config = snapshotConfig(await this.state());
      // A PATCH that committed while we were reading wins: don't cache the older read.
      if (generation === this.generation) {
        this.cache = { config, expiresAt: now + AI_CONFIG_CACHE_TTL_MS };
      }
      return copy(config);
    } catch (error) {
      const fallback = this.cache
        ? copy(this.cache.config)
        : snapshotConfig(buildAiSettingsSnapshot(EMPTY, {}, this.env));
      this.logger.warn(
        `AI settings read failed (${errorName(error)}); using the ${this.cache ? 'last resolved' : '.env'} config`,
      );
      return fallback;
    }
  }

  /** Drops the cached config (next `resolve()` reads the DB). */
  invalidate(): void {
    this.cache = null;
    this.generation += 1;
  }

  /** Fresh (uncached) settings with per-field sources; holds decrypted keys: never serialise it. */
  async state(): Promise<AiSettingsState> {
    const rows = await this.readRows();
    const settings = rows.settings;
    const dbKeys: Partial<Record<AiProvider, StoredAiKey>> = {};
    for (const row of rows.keys) {
      if (!isAiProvider(row.provider)) continue;
      dbKeys[row.provider] = this.decryptKey(row.provider, row);
    }
    const snapshot = buildAiSettingsSnapshot(
      {
        provider:
          settings && isAiProvider(settings.provider)
            ? settings.provider
            : null,
        model: settings?.model ?? null,
        textImageModel: settings?.textImageModel ?? null,
        textImageEnabled: settings?.textImageEnabled ?? false,
      },
      dbKeys,
      this.env,
    );
    return {
      ...snapshot,
      updatedAt: settings?.updatedAt ?? null,
      updatedById: settings?.updatedById ?? null,
    };
  }

  /** Reads the rows. Protected so unit tests can feed rows without a database. */
  protected async readRows(): Promise<AiSettingsRows> {
    const [settings, keys] = await Promise.all([
      this.db
        .select({
          provider: aiProviderSettings.provider,
          model: aiProviderSettings.model,
          textImageModel: aiProviderSettings.textImageModel,
          textImageEnabled: aiProviderSettings.textImageEnabled,
          updatedAt: aiProviderSettings.updatedAt,
          updatedById: aiProviderSettings.updatedById,
        })
        .from(aiProviderSettings)
        .where(eq(aiProviderSettings.id, 1)),
      this.db
        .select({
          provider: aiProviderKeys.provider,
          keyCiphertext: aiProviderKeys.keyCiphertext,
          last4: aiProviderKeys.last4,
          updatedAt: aiProviderKeys.updatedAt,
        })
        .from(aiProviderKeys),
    ]);
    return { settings: settings[0], keys };
  }

  private decryptKey(
    provider: AiProvider,
    row: AiSettingsRows['keys'][number],
  ): StoredAiKey {
    let reason: string;
    if (!this.cipher.isConfigured) {
      reason = 'cipher_not_configured';
    } else {
      try {
        const apiKey = this.cipher.decrypt(
          row.keyCiphertext,
          aiProviderKeyContext(provider),
        );
        return { apiKey, last4: row.last4, updatedAt: row.updatedAt };
      } catch (error) {
        reason =
          error instanceof TokenDecryptionError ? error.reason : 'unknown';
      }
    }
    const marker = `${provider}:${reason}:${row.updatedAt.getTime()}`;
    if (!this.reported.has(marker)) {
      this.reported.add(marker);
      this.logger.warn(
        `AI key unreadable provider=${provider} reason=${reason}; treated as unset`,
      );
    }
    return { unreadable: true, updatedAt: row.updatedAt };
  }
}

const EMPTY = {
  provider: null,
  model: null,
  textImageModel: null,
  textImageEnabled: false,
} as const;

function copy(config: AiProviderConfig | null): AiProviderConfig | null {
  return config ? { ...config } : null;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
